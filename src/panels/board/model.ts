// Board model (CONTRACT.md "Board and Calendar", "Board configuration"): the
// connected project (from prefs), the cached snapshot atom, lanes, filtering,
// epic grouping and the mapping from an Area (or a repo name) to a workspace
// project. Pure helpers apart from the atoms.
import { atom } from "jotai";
import type { BoardItem, BoardSetup, BoardSnapshot, BoardStatus, GhStatus, WorkspaceNode } from "../../lib/ipc";
import { prefsAtom } from "../../app/prefs";
import { basename } from "../shared/paths";
import { indexTree, type Registry } from "../projects/workspace";
import { byLaneThenTitle } from "../calendar/model";

export const LANES: BoardStatus[] = ["Backlog", "Ready", "In progress", "In review", "Done"];
/** Done shows only this many, newest closedAt first. */
export const DONE_LIMIT = 10;
/** README "Board": the fields and options a project needs. */
export const BOARD_HELP_URL = "https://github.com/I4cTime/kansei#board";

/** The connected GitHub Project (prefs.board); null = not configured. */
export const boardConfigAtom = atom((get) => get(prefsAtom).board);

/** The last snapshot (cached or fetched); null before board.json was read. */
export const snapshotAtom = atom<BoardSnapshot | null>(null);
export const ghStatusAtom = atom<GhStatus | null>(null);
export const boardLoadingAtom = atom(false);
/** Lanes the user collapsed or expanded this run (Done starts collapsed). */
export const laneOpenAtom = atom<Partial<Record<BoardStatus, boolean>>>({});

export type KindFilter = "tasks" | "epics" | "all";

export const isEpic = (i: BoardItem) => i.kind === "Epic";
export const itemKey = (repo: string, number: number) => `${repo}#${number}`;
export const repoShort = (repo: string) => repo.slice(repo.indexOf("/") + 1);

/** The lane an item shows in: its Status, else Done when closed, else Backlog. */
export function laneOf(i: BoardItem): BoardStatus {
  if (i.status && LANES.includes(i.status)) return i.status;
  return i.state === "closed" ? "Done" : "Backlog";
}

/**
 * Area options to offer: the board's, else `fallback` (the workspace project
 * names, before the first fetch or without a board), plus any extra names in use.
 */
export function areaOptions(snapshot: BoardSnapshot | null, extra: (string | null)[] = [], fallback: string[] = []): string[] {
  const base = snapshot?.areas.length ? snapshot.areas : fallback;
  const out = [...base];
  for (const a of extra) if (a && !out.includes(a)) out.push(a);
  return out;
}

export const queryWords = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/** Title, repo, area and number ("12" or "#12") all count for the search. */
export function matches(i: BoardItem, words: string[]): boolean {
  if (words.length === 0) return true;
  const hay = [i.title, i.repo, i.area ?? "", `#${i.number}`, String(i.number)].join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function filterItems(items: BoardItem[], filter: KindFilter, query: string): BoardItem[] {
  const words = queryWords(query);
  return items.filter((i) => (filter === "all" || (filter === "epics") === isEpic(i)) && matches(i, words));
}

/** Items of one lane in display order: Ready by Order, Done newest first (capped), others by title. */
export function laneItems(items: BoardItem[], lane: BoardStatus, limitDone = true): BoardItem[] {
  const list = items.filter((i) => laneOf(i) === lane);
  if (lane === "Done") {
    list.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "") || byLaneThenTitle(a, b));
    return limitDone ? list.slice(0, DONE_LIMIT) : list;
  }
  if (lane === "Ready") {
    return list.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || byLaneThenTitle(a, b));
  }
  return list.sort(byLaneThenTitle);
}

export type LaneGroup = {
  key: string;
  /** Epic title for a task group, "No epic" for tasks without one on the board, null for epics themselves. */
  title: string | null;
  epic: BoardItem | null;
  items: BoardItem[];
};

/**
 * One lane's items grouped: epics first (ungrouped), then tasks under their
 * epic's title (epics in title order), then "No epic" for tasks whose epic is
 * not on the board or that have none. Order inside a group is kept.
 */
export function laneGroups(items: BoardItem[], allItems: BoardItem[]): LaneGroup[] {
  const epics = new Map(allItems.filter(isEpic).map((e) => [itemKey(e.repo, e.number), e]));
  const out: LaneGroup[] = [];
  const own = items.filter(isEpic);
  if (own.length > 0) out.push({ key: "epics", title: null, epic: null, items: own });
  const byEpic = new Map<string, LaneGroup>();
  const loose: BoardItem[] = [];
  for (const i of items) {
    if (isEpic(i)) continue;
    const e = i.parent ? epics.get(itemKey(i.parent.repo, i.parent.number)) : undefined;
    if (!e) {
      loose.push(i);
      continue;
    }
    const k = itemKey(e.repo, e.number);
    const g = byEpic.get(k) ?? { key: k, title: e.title, epic: e, items: [] };
    g.items.push(i);
    byEpic.set(k, g);
  }
  out.push(...[...byEpic.values()].sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "", undefined, { sensitivity: "base" })));
  if (loose.length > 0) out.push({ key: "none", title: "No epic", epic: null, items: loose });
  return out;
}

/** Scheduled in the past and not Done. */
export function isOverdue(i: BoardItem, today: string): boolean {
  return !!i.scheduled && i.scheduled < today && laneOf(i) !== "Done";
}

export const epicProgress = (i: BoardItem) => `${i.subIssues.completed}/${i.subIssues.total}`;

/** The repo short name, or the area for items in the hub repo (epics). */
export function itemChip(i: BoardItem, hubRepo: string | null): string | null {
  return i.repo === hubRepo ? i.area : repoShort(i.repo);
}

/** The names of the workspace projects (not groups or subprojects), sorted, for area pickers. */
export function projectNames(tree: WorkspaceNode[]): string[] {
  const names = new Set<string>();
  for (const r of indexTree(tree).values()) if (r.node.kind === "project") names.add(r.node.name);
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

const FIELD_EFFECT: Record<string, string> = {
  Status: "lanes do not work",
  Kind: "epics and tasks cannot be told apart",
  Area: "epics have no project",
  Scheduled: "tasks cannot be scheduled",
  Order: "ordering is disabled",
};

/** One toast line for what a connected project lacks, or null when it has everything. */
export function setupWarning(setup: Pick<BoardSetup, "missingFields" | "missingOptions">): string | null {
  const fields = setup.missingFields.map((f) => `The project has no ${f} field; ${FIELD_EFFECT[f] ?? "the panels need it"}.`);
  const options = Object.entries(setup.missingOptions)
    .filter(([, o]) => o.length > 0)
    .map(([f, o]) => `${f} lacks the option${o.length === 1 ? "" : "s"} ${o.join(", ")}.`);
  const all = [...fields, ...options];
  return all.length > 0 ? all.join(" ") : null;
}

/**
 * The workspace project for an Area (or a repo short name): the project whose
 * basename equals the name case-insensitively (projects before subprojects,
 * then shallower paths), else a registry entry with that name, else null.
 */
export function areaProject(name: string | null | undefined, tree: WorkspaceNode[], registry: Registry): string | null {
  const want = name?.trim().toLowerCase();
  if (!want) return null;
  const hits = [...indexTree(tree).values()]
    .filter((r) => r.node.name.toLowerCase() === want)
    .sort((a, b) => Number(a.node.kind === "subproject") - Number(b.node.kind === "subproject") || a.node.path.split("/").length - b.node.path.split("/").length);
  if (hits.length > 0) return hits[0].node.path;
  for (const entries of Object.values(registry)) {
    for (const path of Object.keys(entries)) if (basename(path).toLowerCase() === want) return path;
  }
  return null;
}

/** The workspace project an item belongs to: its Area first, then its repo name (not for the hub repo). */
export function itemProject(i: BoardItem, tree: WorkspaceNode[], registry: Registry, hubRepo: string | null): string | null {
  return areaProject(i.area, tree, registry) ?? (i.repo === hubRepo ? null : areaProject(repoShort(i.repo), tree, registry));
}

/** The snapshot with one item replaced (or added). */
export function withItem(snap: BoardSnapshot | null, item: BoardItem): BoardSnapshot {
  const base = snap ?? { fetchedAt: "", items: [], error: null, areas: [] };
  const found = base.items.some((i) => i.itemId === item.itemId);
  return { ...base, items: found ? base.items.map((i) => (i.itemId === item.itemId ? item : i)) : [...base.items, item] };
}

/** An item with one field changed locally (the optimistic half of a write). */
export function patchItem(i: BoardItem, field: string, value: string | number | null): BoardItem {
  switch (field) {
    case "status":
      return { ...i, status: (value as BoardStatus | null) ?? null };
    case "kind":
      return { ...i, kind: (value as BoardItem["kind"]) ?? null };
    case "order":
      return { ...i, order: typeof value === "number" ? value : value === null ? null : Number(value) };
    case "area":
    case "scheduled":
    case "started":
    case "target":
    case "doneWhen":
    case "outcome":
      return { ...i, [field]: value === null || value === "" ? null : String(value) };
    default:
      return i;
  }
}
