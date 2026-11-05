// Pure helpers for workspaces (CONTRACT.md "Workspaces"): the registry kept in
// <appData>/workspaces.json, an index over the workspace_scan trees, the
// generated <root>/PROJECTS.md and tree filtering for the Projects panel.
import type { WorkspaceNode } from "../../lib/ipc";
import { basename, tildify } from "../shared/paths";
import { isAccentName, type AccentName } from "../../app/accents";

export type ProjectStatus = "idea" | "active" | "live" | "parked" | "archived";
export const STATUSES: ProjectStatus[] = ["idea", "active", "live", "parked", "archived"];

/** `accent`: the project's colour (CONTRACT.md "Project accents"); null = automatic (a hash of the path). */
export type RegistryEntry = { description: string; status: ProjectStatus | null; related: string[]; accent: AccentName | null };
/** { "<root>": { "<absolute project path>": entry } } */
export type Registry = Record<string, Record<string, RegistryEntry>>;

export const EMPTY_ENTRY: RegistryEntry = { description: "", status: null, related: [], accent: null };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const trimSlash = (p: string) => p.trim().replace(/\/+$/, "") || (p.trim().startsWith("/") ? "/" : "");

function sanitizeEntry(v: unknown): RegistryEntry {
  const r = isObj(v) ? v : {};
  const related: string[] = [];
  if (Array.isArray(r.related)) {
    for (const x of r.related) {
      if (typeof x !== "string") continue;
      const p = trimSlash(x);
      if (p.startsWith("/") && !related.includes(p)) related.push(p);
    }
  }
  return {
    description: typeof r.description === "string" ? r.description.trim() : "",
    status: STATUSES.includes(r.status as ProjectStatus) ? (r.status as ProjectStatus) : null,
    related,
    accent: isAccentName(r.accent) ? r.accent : null,
  };
}

/** Coerce unknown JSON into a Registry: absolute keys only, entries normalised. */
export function sanitizeRegistry(raw: unknown): Registry {
  const out: Registry = {};
  if (!isObj(raw)) return out;
  for (const [root, projects] of Object.entries(raw)) {
    const r = trimSlash(root);
    if (!r.startsWith("/")) continue;
    const entries: Record<string, RegistryEntry> = {};
    if (isObj(projects)) {
      for (const [path, e] of Object.entries(projects)) {
        const p = trimSlash(path);
        if (p.startsWith("/")) entries[p] = sanitizeEntry(e);
      }
    }
    out[r] = entries;
  }
  return out;
}

export function isEmptyEntry(e: RegistryEntry): boolean {
  return !e.description && !e.status && e.related.length === 0 && !e.accent;
}

export function entryOf(reg: Registry, root: string, path: string): RegistryEntry {
  return reg[root]?.[path] ?? EMPTY_ENTRY;
}

/** Registry with `patch` merged into one entry; an entry left empty is removed. */
export function withEntry(reg: Registry, root: string, path: string, patch: Partial<RegistryEntry>): Registry {
  const next = sanitizeEntry({ ...entryOf(reg, root, path), ...patch });
  const projects = { ...(reg[root] ?? {}) };
  if (isEmptyEntry(next)) delete projects[path];
  else projects[path] = next;
  return { ...reg, [root]: projects };
}

// ---------------------------------------------------------------------------
// Tree index

export type TreeRef = {
  node: WorkspaceNode;
  /** The workspace root's path. */
  root: string;
  /** Path relative to the root. */
  rel: string;
  /** Depth-1 group under the root (products, sites, ...); "" for a project directly under the root. */
  group: string;
  /** The project above a subproject, else null. */
  parent: WorkspaceNode | null;
};

export function relPath(root: string, path: string): string {
  const r = root.replace(/\/+$/, "");
  return path === r ? "." : path.startsWith(r + "/") ? path.slice(r.length + 1) : path;
}

/** Projects of a group, wrappers flattened, in tree order. */
export function groupProjects(group: WorkspaceNode): WorkspaceNode[] {
  return group.children.flatMap((c) => (c.kind === "group" ? c.children.filter((x) => x.kind === "project") : c.kind === "project" ? [c] : []));
}

/**
 * A root's children split into projects directly under it (a depth-1 folder
 * that is a repo, like a marketing repo) and its groups, each in tree order.
 */
export function rootParts(root: WorkspaceNode): { top: WorkspaceNode[]; groups: WorkspaceNode[] } {
  return { top: root.children.filter((c) => c.kind === "project"), groups: root.children.filter((c) => c.kind === "group") };
}

/** Root-level projects (group "") then each group's projects, with the group name. */
function rootSections(root: WorkspaceNode): { group: string; projects: WorkspaceNode[] }[] {
  const { top, groups } = rootParts(root);
  return [{ group: "", projects: top }, ...groups.map((g) => ({ group: g.name, projects: groupProjects(g) }))];
}

/** Every project and subproject by path. */
export function indexTree(tree: WorkspaceNode[]): Map<string, TreeRef> {
  const out = new Map<string, TreeRef>();
  for (const root of tree) {
    for (const { group, projects } of rootSections(root)) {
      for (const p of projects) {
        out.set(p.path, { node: p, root: root.path, rel: relPath(root.path, p.path), group, parent: null });
        for (const sub of p.children) {
          if (sub.kind === "subproject") out.set(sub.path, { node: sub, root: root.path, rel: relPath(root.path, sub.path), group, parent: p });
        }
      }
    }
  }
  return out;
}

/**
 * Display names for related projects: the basename, with the relative path in
 * parentheses when another project in the trees has the same basename.
 * `from` is the root the name is shown in (paths in other roots are shown with ~).
 */
export function relatedName(path: string, index: Map<string, TreeRef>, from: string | null, home?: string): string {
  const name = basename(path);
  let same = 0;
  for (const ref of index.values()) if (ref.node.name === name) same++;
  if (same <= 1 && index.has(path)) return name;
  const ref = index.get(path);
  const where = ref && from && ref.root === from ? ref.rel : tildify(path, home);
  return `${name} (${where})`;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function mdLine(node: WorkspaceNode, depth: number, rootPath: string, entries: Record<string, RegistryEntry>, index: Map<string, TreeRef>, home?: string): string {
  const e = entries[node.path] ?? EMPTY_ENTRY;
  let t = `${"  ".repeat(depth)}- ${node.name} - \`${relPath(rootPath, node.path)}\``;
  if (node.flags.worktree) t += " - git worktree";
  if (e.status) t += ` - ${e.status}`;
  const desc = oneLine(e.description);
  if (desc) t += ` - ${desc}`;
  if (e.related.length > 0) {
    const names = e.related.map((p) => relatedName(p, index, rootPath, home)).join(", ");
    t += desc ? `${/[.!?]$/.test(desc) ? "" : "."} Related: ${names}` : ` - Related: ${names}`;
  }
  return t;
}

export const PROJECTS_MD_NOTE =
  "Generated by Kansei from the folder tree and the descriptions kept in its Projects panel. Edit descriptions there; this file is overwritten.";

/**
 * <root>/PROJECTS.md for one workspace root. `index` covers every root (for
 * related names). `hidden(path)` drops a project with its subprojects, or a
 * single subproject (hidden in the Projects panel).
 */
export function renderProjectsMd(root: WorkspaceNode, reg: Registry, index: Map<string, TreeRef>, home?: string, hidden: (path: string) => boolean = () => false): string {
  const entries = reg[root.path] ?? {};
  const lines = [`# Projects in ${tildify(root.path, home)}`, PROJECTS_MD_NOTE];
  // Root-level projects come first as one block without a heading, then one ## per group.
  for (const { group, projects } of rootSections(root)) {
    const items: string[] = [];
    for (const p of projects) {
      if (hidden(p.path)) continue;
      items.push(mdLine(p, 0, root.path, entries, index, home));
      for (const sub of p.children) if (sub.kind === "subproject" && !hidden(sub.path)) items.push(mdLine(sub, 1, root.path, entries, index, home));
    }
    if (items.length > 0) lines.push("", ...(group ? [`## ${group}`] : []), ...items);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Tree filtering for the panel

/** Number of projects in a node (wrappers counted through, subprojects not; a root-level project counts like any other). */
export function countProjects(n: WorkspaceNode): number {
  if (n.kind === "project") return 1;
  if (n.kind === "subproject") return 0;
  return n.children.reduce((s, c) => s + countProjects(c), 0);
}

/**
 * Prune the trees for display. `visible(path)` drops a project or subproject
 * (hidden rows) at any depth, root-level projects included; with `matches`
 * (a search), a project stays when it or one of
 * its subprojects matches, and only matching subprojects stay. Groups without
 * projects left are dropped while searching; without a search they stay.
 */
export function filterTree(tree: WorkspaceNode[], visible: (path: string) => boolean, matches: ((n: WorkspaceNode) => boolean) | null): WorkspaceNode[] {
  const prune = (n: WorkspaceNode): WorkspaceNode | null => {
    if (n.kind === "subproject") return visible(n.path) && (!matches || matches(n)) ? n : null;
    if (n.kind === "project") {
      if (!visible(n.path)) return null;
      const kids = n.children.map(prune).filter((c): c is WorkspaceNode => c !== null);
      if (matches && !matches(n) && kids.length === 0) return null;
      return { ...n, children: kids };
    }
    const kids = n.children.map(prune).filter((c): c is WorkspaceNode => c !== null);
    if (matches && n.kind === "group" && countProjects({ ...n, children: kids }) === 0) return null;
    return { ...n, children: kids };
  };
  return tree.map(prune).filter((n): n is WorkspaceNode => n !== null);
}

/** Flat list of pickable projects for the Related and Open with sheets, in tree order. */
export type PickItem = { path: string; name: string; rel: string; heading: string; depth: 0 | 1 };

/**
 * Headings are group names, prefixed with the root's folder name when there are
 * several roots; projects directly under a root are headed by the root's name.
 */
export function pickItems(tree: WorkspaceNode[], home?: string): PickItem[] {
  const out: PickItem[] = [];
  for (const root of tree) {
    const rootLabel = basename(root.path) || tildify(root.path, home);
    for (const { group, projects } of rootSections(root)) {
      const heading = !group ? rootLabel : tree.length > 1 ? `${rootLabel}/${group}` : group;
      for (const p of projects) {
        out.push({ path: p.path, name: p.name, rel: relPath(root.path, p.path), heading, depth: 0 });
        for (const sub of p.children) if (sub.kind === "subproject") out.push({ path: sub.path, name: sub.name, rel: relPath(root.path, sub.path), heading, depth: 1 });
      }
    }
  }
  return out;
}
