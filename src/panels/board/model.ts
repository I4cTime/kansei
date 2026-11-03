// Board model (CONTRACT.md "Board and Calendar"): the cached snapshot atom,
// lanes, filtering, epic grouping and the mapping from an Area (or a repo
// name) to a workspace project. Pure helpers apart from the atoms.
import { atom } from "jotai";
import type { BoardItem, BoardSnapshot, BoardStatus, GhStatus, WorkspaceNode } from "../../lib/ipc";
import { basename } from "../shared/paths";
import { indexTree, type Registry } from "../projects/workspace";
import { byLaneThenTitle } from "../calendar/model";

export const LANES: BoardStatus[] = ["Backlog", "Ready", "In progress", "In review", "Done"];
export const HUB_REPO = "I4cTime/focus";
export const BOARD_URL = "https://github.com/users/I4cTime/projects/3";
/** Done shows only this many, newest closedAt first. */
export const DONE_LIMIT = 10;
/** The Area options on 2026-11-01, for when the board has not been fetched yet. */
export const FALLBACK_AREAS = [
  "q-ring", "tanko", "groundrules", "lookout", "cryo", "mineui", "protonshift", "sites", "atelier", "deathbell",
  "desktop", "infra", "marketing", "aibou", "niwa", "shiori", "kansei", "synthesist", "blazedtravel", "job-hunt",
];

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

/** Area options to offer: the board's, else the fallback list, plus any extra names in use. */
export function areaOptions(snapshot: BoardSnapshot | null, extra: (string | null)[] = []): string[] {
  const base = snapshot?.areas.length ? snapshot.areas : FALLBACK_AREAS;
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
export function itemChip(i: BoardItem): string | null {
  return i.repo === HUB_REPO ? i.area : repoShort(i.repo);
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

/** The workspace project an item belongs to: its Area first, then its repo name. */
export function itemProject(i: BoardItem, tree: WorkspaceNode[], registry: Registry): string | null {
  return areaProject(i.area, tree, registry) ?? (i.repo === HUB_REPO ? null : areaProject(repoShort(i.repo), tree, registry));
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
