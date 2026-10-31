// Pure helpers for the Sessions panel: labels, filtering, grouping, formatting.
import type { Session } from "../../lib/ipc";
import { basename } from "../shared/paths";

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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "12 Oct", "12 Oct 2025". */
export function relativeTime(ts: number, now: number): string {
  if (!ts) return "unknown";
  const diff = now - ts;
  const min = 60_000;
  const hour = 60 * min;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)} min ago`;
  const today = startOfDay(now);
  // Today, or late last night: hours. Earlier yesterday: "yesterday".
  if (ts >= today || diff < 12 * hour) return `${Math.floor(diff / hour)} h ago`;
  if (ts >= startOfDay(today - 1)) return "yesterday";
  const d = new Date(ts);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** Full local date and time for tooltips. */
export function absoluteTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "512 B", "3.4 KB", "120 KB", "2.1 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}
