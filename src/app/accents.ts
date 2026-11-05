// Project accents (CONTRACT.md "Project accents"): a stable colour per
// workspace project, from the terminal palette tokens. The tab rail, the
// terminal column, the sidebar header chip, the Projects tree and the
// Calendar's activity dots all colour a project through accentFor.
//
// Pure helpers only (type imports), so workspace.ts can sanitise the registry's
// `accent` field with ACCENT_NAMES; the live atoms are in accentState.ts.
import type { WorkspaceNode } from "../lib/ipc";
import type { Registry } from "../panels/projects/workspace";

export type AccentName = "red" | "yellow" | "green" | "cyan" | "blue" | "magenta";
export const ACCENT_NAMES: AccentName[] = ["red", "yellow", "green", "cyan", "blue", "magenta"];

/**
 * The order the hash indexes into. It is the order of the Calendar's dot
 * colours before accents existed, so a path keeps the dot colour it had.
 */
const HASH_ORDER: AccentName[] = ["blue", "magenta", "cyan", "green", "yellow", "red"];

export function isAccentName(v: unknown): v is AccentName {
  return typeof v === "string" && (ACCENT_NAMES as string[]).includes(v);
}

const trimSlash = (p: string) => p.trim().replace(/\/+$/, "") || (p.trim().startsWith("/") ? "/" : "");

/** The automatic accent: a string hash of the path onto the six names. */
export function hashAccent(path: string): AccentName {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) | 0;
  return HASH_ORDER[Math.abs(h) % HASH_ORDER.length];
}

/**
 * The registry entry's accent for `path` (under any root) when set, else the
 * hash of the path as given (the Calendar's dots hash it unchanged).
 */
export function accentFor(path: string, registry: Registry): AccentName {
  const key = trimSlash(path);
  for (const entries of Object.values(registry)) {
    const a = entries[key]?.accent;
    if (a) return a;
  }
  return hashAccent(path);
}

/** The CSS colour of an accent: the terminal palette token. */
export function accentVar(name: AccentName): string {
  return `var(--t-${name})`;
}

/**
 * The deepest project or subproject in the trees whose path is `cwd` or a
 * parent of it; null when there is none (a cwd under no root, or a root or
 * group folder itself).
 */
export function tabProject(cwd: string, tree: WorkspaceNode[] | null): { path: string; name: string } | null {
  const c = trimSlash(cwd);
  if (!c || !tree) return null;
  let best: WorkspaceNode | null = null;
  const visit = (n: WorkspaceNode) => {
    const p = trimSlash(n.path);
    const inside = c === p || c.startsWith(p === "/" ? "/" : p + "/");
    if ((n.kind === "project" || n.kind === "subproject") && inside && (!best || p.length > trimSlash(best.path).length)) best = n;
    // Only folders on the way to the cwd can hold a deeper match.
    if (inside) n.children.forEach(visit);
  };
  tree.forEach(visit);
  const found = best as WorkspaceNode | null;
  return found ? { path: trimSlash(found.path), name: found.name } : null;
}

/** A tab's project (or its cwd when under no project), with the accent and the name to show. */
export type TabAccent = { path: string; name: string; accent: AccentName };

export function tabAccent(cwd: string, tree: WorkspaceNode[] | null, registry: Registry): TabAccent {
  const proj = tabProject(cwd, tree);
  const path = proj?.path ?? trimSlash(cwd);
  const name = proj?.name ?? (path.slice(path.lastIndexOf("/") + 1) || path);
  return { path, name, accent: accentFor(path, registry) };
}

/** The header chip's label: at most 18 characters, cut with an ellipsis. */
export const CHIP_MAX = 18;
export function chipName(name: string): string {
  return name.length <= CHIP_MAX ? name : `${name.slice(0, CHIP_MAX - 3)}...`;
}
