// Command palette entry points (CONTRACT.md "Command palette"): open, close and
// toggle it in the overlay host, the real actions behind the commands, and
// running one (palette closed first, then the command, then prefs.paletteRecent).
import { createElement } from "react";
import { overlayAtom, type Overlay } from "../../lib/overlay";
import { PANELS } from "../../panels";
import { snapshotAtom, boardConfigAtom } from "../../panels/board/model";
import { refreshBoard, setItemField } from "../../panels/board/actions";
import { openWithSheet } from "../../panels/projects/openWith";
import { pickItems } from "../../panels/projects/workspace";
import { registryAtom, treeAtom } from "../../panels/projects/workspaceStore";
import { sessionsListAtom, projectLabel } from "../../panels/sessions/model";
import { CLAUDE, prefsAtom, savePrefs, setPrefs } from "../prefs";
import { store, toastError } from "../store";
import { activateTab, activeKeyAtom, closeTab, newTabWithPicker, openTab, requestRename, restartTab, SHELL_COMMAND, tabsAtom } from "../tabs";
import { PRESETS } from "../theme/presets";
import { buildCommands, type Command, type PaletteActions, type PaletteInput } from "./commands";
import { pushRecent } from "./fuzzy";
import { Palette } from "./Palette";

let current: Overlay | null = null;
/** Home folder, filled in by the palette (getPaths is async). */
let homeDir: string | undefined;

export function setPaletteHome(home: string | undefined) {
  homeDir = home;
}

export function isPaletteOpen(): boolean {
  return current !== null && store.get(overlayAtom) === current;
}

/** Show the palette. Refuses (false, with a toast) while another overlay is open. */
export function openPalette(): boolean {
  if (isPaletteOpen()) return true;
  if (store.get(overlayAtom)) {
    toastError("Close the open sheet first");
    return false;
  }
  current = { node: createElement(Palette, { key: `palette-${Date.now()}` }) };
  store.set(overlayAtom, current);
  return true;
}

export function closePalette() {
  if (isPaletteOpen()) store.set(overlayAtom, null);
  current = null;
}

/** Ctrl+Shift+P: open, or close when it is the open overlay. */
export function togglePalette() {
  if (isPaletteOpen()) closePalette();
  else openPalette();
}

export const actions: PaletteActions = {
  activateTab,
  newTab: () => newTabWithPicker(),
  newShellTab: (cwd) => void openTab({ cwd, command: SHELL_COMMAND.command, args: [...SHELL_COMMAND.args] }),
  closeTab,
  restartTab,
  renameTab: requestRename,
  openPanel: (id) => setPrefs({ sidebarSection: id, sidebarCollapsed: false }),
  toggleSidebar: () => setPrefs({ sidebarCollapsed: !store.get(prefsAtom).sidebarCollapsed }),
  openProject: (path, name) => void openTab({ cwd: path, command: CLAUDE, title: name }),
  openProjectWith: (ref, related) =>
    void openWithSheet({ path: ref.node.path, label: ref.node.name, items: pickItems(store.get(treeAtom) ?? [], homeDir), exclude: [ref.node.path], related, home: homeDir }),
  resumeSession: (s) => {
    if (s.live) return;
    const cwd = s.project ?? homeDir;
    if (!cwd) return;
    openTab({ cwd, command: CLAUDE, args: ["--resume", s.id], title: `${projectLabel(cwd, homeDir)} (resumed)` });
  },
  setBoardStatus: (item, status) => setItemField(item.itemId, "status", status),
  refreshBoard: () => refreshBoard(true),
  setTheme: (theme) => savePrefs({ theme }),
  toggleEffects: () => savePrefs({ effects: !store.get(prefsAtom).effects }),
  toggleClaudeTheme: () => savePrefs({ claudeTheme: !store.get(prefsAtom).claudeTheme }),
};

/** The palette's input from the store; `sessions` is the palette's own fetch when the Sessions panel has none. */
export function liveInput(sessions: PaletteInput["sessions"] = null): PaletteInput {
  const prefs = store.get(prefsAtom);
  return {
    tabs: store.get(tabsAtom),
    activeKey: store.get(activeKeyAtom),
    home: homeDir,
    panels: PANELS.map((p) => ({ id: p.id, label: p.label })),
    tree: store.get(treeAtom) ?? [],
    registry: store.get(registryAtom),
    sessions: store.get(sessionsListAtom) ?? sessions,
    now: Date.now(),
    boardConnected: !!store.get(boardConfigAtom),
    snapshot: store.get(snapshotAtom),
    theme: { theme: prefs.theme, effects: prefs.effects, claudeTheme: prefs.claudeTheme },
    presets: PRESETS,
  };
}

/** Every command right now (dev driver: t.palette.buildCommands()). */
export function commandsNow(sessions: PaletteInput["sessions"] = null): Command[] {
  return buildCommands(liveInput(sessions), actions);
}

/** Close the palette, run `c` (errors toast), and remember it in prefs.paletteRecent. */
export function runCommand(c: Command) {
  if (c.disabled) return;
  closePalette();
  // Transcript hits are search results, not commands to come back to.
  if (c.group !== "Transcripts") setPrefs({ paletteRecent: pushRecent(store.get(prefsAtom).paletteRecent, c.id) });
  try {
    const r = c.run();
    if (r instanceof Promise) r.catch((e) => toastError(e, c.title));
  } catch (e) {
    toastError(e, c.title);
  }
}
