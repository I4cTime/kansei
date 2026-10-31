// Pin / hide actions for the Projects panel. They persist through savePrefs and
// are also exposed to the dev driver (t.projects).
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
