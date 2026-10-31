// The active tab's project (CONTRACT.md "Project scope"): the nearest ancestor
// of the tab's cwd with .claude/, .mcp.json, CLAUDE.md or .git. Refreshed
// whenever the active tab's cwd changes; null when there is no tab.
import { atom } from "jotai";
import { project, type ProjectInfo } from "../lib/ipc";
import { store } from "./store";
import { activeTabAtom } from "./tabState";

export const projectAtom = atom<ProjectInfo | null>(null);

let seq = 0;
let lastCwd: string | null = null;

/** Re-resolve the project for the active tab (also refreshes `exists`). */
export async function refreshProject(): Promise<ProjectInfo | null> {
  const cwd = store.get(activeTabAtom)?.cwd ?? null;
  lastCwd = cwd;
  const my = ++seq;
  if (!cwd) {
    store.set(projectAtom, null);
    return null;
  }
  try {
    const info = await project.root(cwd);
    if (my === seq) store.set(projectAtom, info);
    return info;
  } catch {
    // cwd vanished or is not a directory: no project.
    if (my === seq) store.set(projectAtom, null);
    return null;
  }
}

const unsub = store.sub(activeTabAtom, () => {
  const cwd = store.get(activeTabAtom)?.cwd ?? null;
  if (cwd !== lastCwd) void refreshProject();
});
void refreshProject();

if (import.meta.hot) import.meta.hot.dispose(() => unsub());
