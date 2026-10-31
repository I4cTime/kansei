// Pin / hide actions for the Projects panel and the workspace roots list in
// Settings. They persist through savePrefs and are also exposed to the dev
// driver (t.projects).
import { open } from "@tauri-apps/plugin-dialog";
import { prefsAtom, savePrefs } from "../../app/prefs";
import { store } from "../../app/store";
import { getPaths } from "../shared/hooks";
import { normPath, withHidden, withPinned, withoutHidden, withoutPinned } from "./model";

export function pinProject(path: string): Promise<void> {
  return savePrefs(withPinned(store.get(prefsAtom), path));
}

/** `paths` = the row's path plus its aliases. */
export function unpinProject(paths: string[]): Promise<void> {
  return savePrefs(withoutPinned(store.get(prefsAtom), paths));
}

export function hideProject(path: string, aliases: string[] = []): Promise<void> {
  return savePrefs(withHidden(store.get(prefsAtom), path, aliases));
}

export function unhideProject(paths: string[]): Promise<void> {
  return savePrefs(withoutHidden(store.get(prefsAtom), paths));
}

/** Add a workspace root (absolute folder) to prefs, once. */
export function addWorkspaceRoot(path: string): Promise<void> {
  const p = normPath(path);
  const roots = store.get(prefsAtom).workspaceRoots;
  return roots.includes(p) ? Promise.resolve() : savePrefs({ workspaceRoots: [...roots, p] });
}

export function removeWorkspaceRoot(path: string): Promise<void> {
  const p = normPath(path);
  return savePrefs({ workspaceRoots: store.get(prefsAtom).workspaceRoots.filter((r) => normPath(r) !== p) });
}

let picking = false;
/** Folder picker, then pin the folder. Resolves to the pinned path, or null when cancelled. */
export async function addProjectWithPicker(): Promise<string | null> {
  if (picking) return null;
  picking = true;
  try {
    const paths = await getPaths();
    const picked = await open({ directory: true, multiple: false, defaultPath: paths.home, title: "Add a project folder" });
    if (!picked || Array.isArray(picked)) return null;
    await pinProject(picked);
    return normPath(picked);
  } finally {
    picking = false;
  }
}

/** Folder picker, then add the folder as a workspace root. Resolves to the path, or null when cancelled. */
export async function addWorkspaceRootWithPicker(): Promise<string | null> {
  if (picking) return null;
  picking = true;
  try {
    const paths = await getPaths();
    const picked = await open({ directory: true, multiple: false, defaultPath: paths.home, title: "Add a workspace root" });
    if (!picked || Array.isArray(picked)) return null;
    await addWorkspaceRoot(picked);
    return normPath(picked);
  } finally {
    picking = false;
  }
}
