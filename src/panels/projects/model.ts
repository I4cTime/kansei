// Pure helpers and the data merge for the Projects panel (CONTRACT.md "Projects").
import type { MemoryProject, ProjectsInfo, Session } from "../../lib/ipc";
import { basename, dirname, tildify } from "../shared/paths";
import { projectLabel } from "../sessions/model";

export type ProjectFlags = ProjectsInfo["flags"];

export type ProjectRow = {
  /** Canonical folder when it exists (so symlinked spellings merge), else the path as recorded. */
  path: string;
  /** Every recorded spelling that maps to this row; unpin and unhide clear all of them. */
  aliases: string[];
  label: string;
  pinned: boolean;
  hidden: boolean;
  exists: boolean;
  flags: ProjectFlags;
  sessions: number;
  /** Sessions with a running Claude process. */
  live: number;
  /** Newest session activity (epoch ms), 0 when there are no sessions. */
  lastTs: number;
  /** Memory files, MEMORY.md not counted. */
  memory: number;
  /** Newest session that can be resumed: has a transcript and is not running. */
  lastSessionId: string | null;
  lastSessionTitle: string | null;
  /** The Session.project value with the most sessions, for the Sessions panel filter. */
  sessionsKey: string | null;
};

export type ProjectFilter = "recent" | "pinned" | "all";

export const NO_FLAGS: ProjectFlags = { claudeMd: false, claudeDir: false, mcpJson: false, git: false };

/** Trim and drop trailing slashes ("/" stays "/"). */
export function normPath(p: string): string {
  const s = p.trim().replace(/\/+$/, "");
  return s || (p.trim().startsWith("/") ? "/" : "");
}

const isAbs = (p: string) => p.startsWith("/");

/** Every absolute folder the sources mention, normalised and deduplicated (the projects_info input). */
export function collectPaths(list: Session[], mem: MemoryProject[], pinned: string[], hidden: string[]): string[] {
  const out = new Set<string>();
  const add = (p: string | null | undefined) => {
    if (!p) return;
    const n = normPath(p);
    if (isAbs(n)) out.add(n);
  };
  for (const s of list) add(s.project);
  for (const m of mem) add(m.guessedPath);
  for (const p of pinned) add(p);
  for (const p of hidden) add(p);
  return [...out];
}

type Acc = {
  aliases: Set<string>;
  sessions: number;
  live: number;
  lastTs: number;
  memory: number;
  resume: Session | null;
  keyCounts: Map<string, number>;
};

/**
 * Union the sources by canonical folder:
 * - sessions: every non-null `project` counts one session; live = sessions with `live`;
 *   lastTs = max lastTs; lastSessionId = newest session with a transcript that is not live;
 * - memory projects with a resolved `guessedPath` add their file count (minus MEMORY.md);
 * - pinned and hidden prefs add folders of their own; pinned wins over hidden.
 * `info` maps a normalised path to its projects_info result; a path without one yet
 * is assumed to exist (it is fetched right after) and keys on itself.
 */
export function mergeProjects(input: {
  sessions: Session[];
  memory: MemoryProject[];
  pinned: string[];
  hidden: string[];
  info: Map<string, ProjectsInfo>;
  home?: string;
}): ProjectRow[] {
  const { info } = input;
  const acc = new Map<string, Acc>();
  const keyOf = (p: string) => {
    const c = info.get(p)?.canonical;
    return c ? normPath(c) : p;
  };
  const get = (raw: string | null | undefined): Acc | null => {
    if (!raw) return null;
    const p = normPath(raw);
    if (!isAbs(p)) return null;
    const key = keyOf(p);
    let a = acc.get(key);
    if (!a) {
      a = { aliases: new Set(), sessions: 0, live: 0, lastTs: 0, memory: 0, resume: null, keyCounts: new Map() };
      acc.set(key, a);
    }
    a.aliases.add(p);
    return a;
  };

  for (const s of input.sessions) {
    const a = get(s.project);
    if (!a || !s.project) continue;
    a.sessions++;
    if (s.live) a.live++;
    a.lastTs = Math.max(a.lastTs, s.lastTs);
    if (s.transcriptPath && !s.live && (!a.resume || s.lastTs > a.resume.lastTs)) a.resume = s;
    a.keyCounts.set(s.project, (a.keyCounts.get(s.project) ?? 0) + 1);
  }
  for (const m of input.memory) {
    const a = get(m.guessedPath);
    if (a) a.memory += Math.max(0, m.fileCount - (m.hasIndex ? 1 : 0));
  }
  const pinned = new Set<string>();
  const hidden = new Set<string>();
  for (const p of input.pinned) if (get(p)) pinned.add(normPath(p));
  for (const p of input.hidden) if (get(p)) hidden.add(normPath(p));

  const rows: ProjectRow[] = [];
  for (const [key, a] of acc) {
    const aliases = [...a.aliases];
    const facts = [key, ...aliases].map((p) => info.get(p)).find((i) => i !== undefined);
    const isPinned = aliases.some((p) => pinned.has(p)) || pinned.has(key);
    let sessionsKey: string | null = null;
    let best = 0;
    // Most sessions wins; on a tie prefer the spelling that is the row's own path.
    for (const [k, n] of a.keyCounts) if (n > best || (n === best && k === key)) [sessionsKey, best] = [k, n];
    rows.push({
      path: key,
      aliases,
      label: "",
      pinned: isPinned,
      hidden: !isPinned && (aliases.some((p) => hidden.has(p)) || hidden.has(key)),
      exists: facts ? facts.exists : true,
      flags: facts?.flags ?? NO_FLAGS,
      sessions: a.sessions,
      live: a.live,
      lastTs: a.lastTs,
      memory: a.memory,
      lastSessionId: a.resume?.id ?? null,
      lastSessionTitle: a.resume?.title ?? null,
      sessionsKey,
    });
  }
  labelRows(rows, input.home);
  return rows.sort(compareRows);
}

/** Sessions' labels: basename, "~" for home; duplicate basenames get their parent dir appended. */
export function labelRows(rows: ProjectRow[], home?: string): void {
  for (const r of rows) r.label = projectLabel(r.path, home);
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.label, (seen.get(r.label) ?? 0) + 1);
  for (const r of rows) {
    if ((seen.get(r.label) ?? 0) > 1 && r.label !== "~") {
      const parent = basename(dirname(r.path));
      if (parent) r.label = `${r.label} - ${parent}`;
    }
  }
}

/** Existing folders first, then pinned, then newest activity, then label. */
export function compareRows(a: ProjectRow, b: ProjectRow): number {
  if (a.exists !== b.exists) return a.exists ? -1 : 1;
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.lastTs - a.lastTs || a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
}

/** Rows for a filter and query (case-insensitive, all words must match label or path). */
export function filterRows(rows: ProjectRow[], query: string, filter: ProjectFilter, home?: string): ProjectRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (filter === "pinned" && !r.pinned) return false;
    if (filter === "recent" && r.hidden) return false;
    if (words.length === 0) return true;
    const hay = [r.label, r.path, tildify(r.path, home), ...r.aliases].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export type RowGroup = { key: "pinned" | "recent" | "hidden"; title: string; rows: ProjectRow[] };

/** Pinned, then the rest, then hidden (only present under "all"). Empty groups are dropped. */
export function groupRows(rows: ProjectRow[]): RowGroup[] {
  const groups: RowGroup[] = [
    { key: "pinned", title: "Pinned", rows: rows.filter((r) => r.pinned) },
    { key: "recent", title: "Recent", rows: rows.filter((r) => !r.pinned && !r.hidden) },
    { key: "hidden", title: "Hidden", rows: rows.filter((r) => r.hidden) },
  ];
  return groups.filter((g) => g.rows.length > 0);
}

/** Prefs after pinning `path`: added to pinned (once), removed from hidden. */
export function withPinned(prefs: { pinnedProjects: string[]; hiddenProjects: string[] }, path: string) {
  const p = normPath(path);
  return {
    pinnedProjects: [...prefs.pinnedProjects.filter((x) => normPath(x) !== p), p],
    hiddenProjects: prefs.hiddenProjects.filter((x) => normPath(x) !== p),
  };
}

/** Prefs after unpinning every spelling in `paths`. */
export function withoutPinned(prefs: { pinnedProjects: string[] }, paths: string[]) {
  const drop = new Set(paths.map(normPath));
  return { pinnedProjects: prefs.pinnedProjects.filter((x) => !drop.has(normPath(x))) };
}

/** Prefs after hiding `path` (and unpinning all of its spellings). */
export function withHidden(prefs: { pinnedProjects: string[]; hiddenProjects: string[] }, path: string, aliases: string[] = []) {
  const p = normPath(path);
  const drop = new Set([p, ...aliases.map(normPath)]);
  return {
    pinnedProjects: prefs.pinnedProjects.filter((x) => !drop.has(normPath(x))),
    hiddenProjects: [...prefs.hiddenProjects.filter((x) => normPath(x) !== p), p],
  };
}

/** Prefs after unhiding every spelling in `paths`. */
export function withoutHidden(prefs: { hiddenProjects: string[] }, paths: string[]) {
  const drop = new Set(paths.map(normPath));
  return { hiddenProjects: prefs.hiddenProjects.filter((x) => !drop.has(normPath(x))) };
}
