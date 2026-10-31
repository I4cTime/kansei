// Pure helpers for the Sessions panel: labels, filtering, grouping, formatting,
// plus the atom other panels use to open Sessions filtered to one project.
import { atom } from "jotai";
import type { Session } from "../../lib/ipc";
import { basename } from "../shared/paths";

export { absoluteTime, formatSize, plural, relativeTime } from "../shared/format";

/**
 * Hand-off from other panels: set it to a project path (a Session.project
 * value) and switch the sidebar to Sessions; the panel applies it as its
 * project filter and clears it.
 */
export const sessionsProjectFilterAtom = atom<string | null>(null);

/** Select value for sessions whose project is unknown. */
export const NO_PROJECT = "\u0000none";

export function projectKey(project: string | null): string {
  return project ?? NO_PROJECT;
}

/** Short label for a project path: basename, "~" for home, a placeholder for null. */
export function projectLabel(project: string | null, home?: string): string {
  if (!project) return "(unknown project)";
  const p = project.replace(/\/+$/, "") || "/";
  if (home && p === home.replace(/\/+$/, "")) return "~";
  return basename(p) || "/";
}

export type ProjectOption = { key: string; project: string | null; label: string; count: number };

/** One option per project, sorted by label; duplicate basenames get their parent dir appended. */
export function projectOptions(list: Session[], home?: string): ProjectOption[] {
  const byKey = new Map<string, ProjectOption>();
  for (const s of list) {
    const key = projectKey(s.project);
    const o = byKey.get(key);
    if (o) o.count++;
    else byKey.set(key, { key, project: s.project, label: projectLabel(s.project, home), count: 1 });
  }
  const opts = [...byKey.values()];
  const seen = new Map<string, number>();
  for (const o of opts) seen.set(o.label, (seen.get(o.label) ?? 0) + 1);
  for (const o of opts) {
    if (o.project && (seen.get(o.label) ?? 0) > 1) {
      const parent = basename(o.project.replace(/\/+$/, "").replace(/\/[^/]*$/, ""));
      if (parent) o.label = `${o.label} - ${parent}`;
    }
  }
  return opts.sort((a, b) => {
    if (a.project === null) return 1;
    if (b.project === null) return -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

/** Case-insensitive match on title, id, project path and live name; all words must match. */
export function filterSessions(list: Session[], query: string, project: string): Session[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((s) => {
    if (project && projectKey(s.project) !== project) return false;
    if (words.length === 0) return true;
    const hay = [s.title, s.id, s.project ?? "", s.live?.name ?? ""].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export type SessionGroup = { key: string; project: string | null; sessions: Session[] };

/** Group by project, keeping the input order (lastTs desc) for groups and rows. */
export function groupByProject(list: Session[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const s of list) {
    const key = projectKey(s.project);
    let g = groups.get(key);
    if (!g) {
      g = { key, project: s.project, sessions: [] };
      groups.set(key, g);
    }
    g.sessions.push(s);
  }
  return [...groups.values()];
}
