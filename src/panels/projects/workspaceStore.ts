// Workspace state (CONTRACT.md "Workspaces"): the scanned trees, the registry
// in <appData>/workspaces.json, and the files generated from them in each root
// (PROJECTS.md, and CLAUDE.md on a root's first registry write). Started once
// from the shell's boot; the Projects panel rescans on its refresh.
import { atom } from "jotai";
import { files, projects, workspace, type WorkspaceNode } from "../../lib/ipc";
import { prefsAtom, prefsLoadedAtom } from "../../app/prefs";
import { getPaths, joinPath, store, toastError, toastInfo } from "../../app/store";
import { tildify } from "../shared/paths";
import { indexTree, renderProjectsMd, sanitizeRegistry, withEntry, type Registry, type RegistryEntry, type TreeRef } from "./workspace";

/** Trees from the last scan, one per existing workspace root; null before the first scan. */
export const treeAtom = atom<WorkspaceNode[] | null>(null);
export const registryAtom = atom<Registry>({});

/** False when workspaces.json could not be parsed: nothing is written over it. */
let registryWritable = true;
let registryLoaded: Promise<void> | null = null;

async function registryPath(): Promise<string> {
  return joinPath((await getPaths()).appData, "workspaces.json");
}

export function loadRegistry(): Promise<void> {
  if (!registryLoaded) {
    registryLoaded = (async () => {
      try {
        const path = await registryPath();
        if (await files.exists(path)) store.set(registryAtom, sanitizeRegistry(JSON.parse(await files.readText(path))));
      } catch (e) {
        registryWritable = false;
        toastError(e, "Could not read workspaces.json (descriptions are read-only until it is fixed)");
      }
    })();
  }
  return registryLoaded;
}

async function writeRegistry(reg: Registry): Promise<void> {
  if (!registryWritable) throw new Error("workspaces.json could not be read, fix it first");
  store.set(registryAtom, reg);
  await files.writeText(await registryPath(), JSON.stringify(reg, null, 2) + "\n");
}

// One workspace operation at a time (scan, registry writes, file sync).
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** Last PROJECTS.md text known to be on disk, per root. */
const written = new Map<string, string>();

const norm = (p: string) => p.trim().replace(/\/+$/, "") || "/";

/**
 * Projects hidden in the Projects panel, matched by path or canonical path
 * (so a hidden alias spelling counts). Pinned wins over hidden, as in the panel.
 */
async function hiddenMatcher(tree: WorkspaceNode[]): Promise<(path: string) => boolean> {
  const prefs = store.get(prefsAtom);
  const hiddenRaw = prefs.hiddenProjects.map(norm).filter((p) => p.startsWith("/"));
  if (hiddenRaw.length === 0) return () => false;
  const pinnedRaw = prefs.pinnedProjects.map(norm).filter((p) => p.startsWith("/"));
  const treePaths = [...indexTree(tree).keys()];
  const all = [...new Set([...hiddenRaw, ...pinnedRaw, ...treePaths])];
  const canon = new Map<string, string>();
  for (let i = 0; i < all.length; i += 500) {
    for (const x of await projects.info(all.slice(i, i + 500))) canon.set(x.path, x.canonical ? norm(x.canonical) : x.path);
  }
  const key = (p: string) => canon.get(p) ?? p;
  const hidden = new Set(hiddenRaw.flatMap((p) => [p, key(p)]));
  const pinned = new Set(pinnedRaw.flatMap((p) => [p, key(p)]));
  return (p) => (hidden.has(p) || hidden.has(key(p))) && !pinned.has(p) && !pinned.has(key(p));
}

/** Rewrite each root's PROJECTS.md when the rendered text differs from the file. */
async function syncProjectsMd(tree: WorkspaceNode[], reg: Registry): Promise<void> {
  const home = (await getPaths()).home;
  const index = indexTree(tree);
  const hidden = await hiddenMatcher(tree);
  for (const root of tree) {
    const text = renderProjectsMd(root, reg, index, home, hidden);
    if (written.get(root.path) === text) continue;
    const path = joinPath(root.path, "PROJECTS.md");
    const current = (await files.exists(path)) ? await files.readText(path) : null;
    if (current !== text) await files.writeText(path, text);
    written.set(root.path, text);
  }
}

/** Roots seen for the first time get a registry key, then their CLAUDE.md is created or amended. */
async function adoptNewRoots(tree: WorkspaceNode[]): Promise<void> {
  if (!registryWritable) return;
  const reg = store.get(registryAtom);
  const fresh = tree.filter((r) => !(r.path in reg));
  if (fresh.length === 0) return;
  const next: Registry = { ...reg };
  for (const r of fresh) next[r.path] = {};
  await writeRegistry(next);
  const home = (await getPaths()).home;
  for (const r of fresh) {
    const outcome = await workspace.claudeMd(r.path);
    const where = tildify(joinPath(r.path, "CLAUDE.md"), home);
    if (outcome === "created") toastInfo(`Created ${where} (imports PROJECTS.md)`);
    else if (outcome === "amended") toastInfo(`Added the PROJECTS.md import to ${where}`);
  }
}

/** Scan prefs.workspaceRoots, keep PROJECTS.md current and adopt new roots. Throws on failure. */
export function scanWorkspaces(): Promise<WorkspaceNode[]> {
  return serial(async () => {
    await loadRegistry();
    const tree = await workspace.scan(store.get(prefsAtom).workspaceRoots);
    store.set(treeAtom, tree);
    await syncProjectsMd(tree, store.get(registryAtom));
    await adoptNewRoots(tree);
    return tree;
  });
}

/** Merge `patch` into a project's registry entry and regenerate PROJECTS.md. */
export function saveEntry(root: string, path: string, patch: Partial<RegistryEntry>): Promise<void> {
  return serial(async () => {
    await loadRegistry();
    const next = withEntry(store.get(registryAtom), root, path, patch);
    await writeRegistry(next);
    const tree = store.get(treeAtom);
    if (tree) await syncProjectsMd(tree, next);
  });
}

/** Every project and subproject path in the trees (the entries Related may add or remove). */
export function workspacePaths(): string[] {
  return [...indexTree(store.get(treeAtom) ?? []).keys()];
}

/**
 * Save a project's related projects: permissions.additionalDirectories in its
 * .claude/settings.json first (workspace entries only, hand-added ones stay),
 * then the registry and PROJECTS.md.
 */
export async function saveRelated(ref: TreeRef, related: string[]): Promise<void> {
  const reg = store.get(registryAtom);
  const before = reg[ref.root]?.[ref.node.path]?.related ?? [];
  const managed = [...new Set([...workspacePaths(), ...before])].filter((p) => p !== ref.node.path);
  const dirs = related.filter((p) => p !== ref.node.path);
  await workspace.additionalDirs(ref.node.path, dirs, managed);
  await saveEntry(ref.root, ref.node.path, { related: dirs });
}

let started = false;
/** Load the registry, scan once prefs are in, and rescan whenever workspaceRoots changes. */
export function startWorkspaces(): void {
  if (started) return;
  started = true;
  let lastRoots: string | null = null;
  const maybeScan = () => {
    if (!store.get(prefsLoadedAtom)) return;
    const roots = store.get(prefsAtom).workspaceRoots.join("\n");
    if (roots === lastRoots) return;
    lastRoots = roots;
    scanWorkspaces().catch((e) => toastError(e, "Could not scan workspace roots"));
  };
  // Hiding or unhiding (pinning wins over hidden) regenerates PROJECTS.md like an edit.
  let lastVisibility: string | null = null;
  const maybeResync = () => {
    if (!store.get(prefsLoadedAtom)) return;
    const p = store.get(prefsAtom);
    const key = JSON.stringify([p.hiddenProjects, p.pinnedProjects]);
    if (key === lastVisibility) return;
    const first = lastVisibility === null;
    lastVisibility = key;
    if (first) return; // the first scan renders with the current lists
    serial(async () => {
      const tree = store.get(treeAtom);
      if (tree) await syncProjectsMd(tree, store.get(registryAtom));
    }).catch((e) => toastError(e, "Could not update PROJECTS.md"));
  };
  store.sub(prefsAtom, maybeScan);
  store.sub(prefsLoadedAtom, maybeScan);
  store.sub(prefsAtom, maybeResync);
  store.sub(prefsLoadedAtom, maybeResync);
  maybeScan();
  maybeResync();
}
