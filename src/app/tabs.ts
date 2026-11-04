// Tab store API (atoms re-exported from tabState.ts) and persistence to
// <appData>/tabs.json: { version: 1, active: number, tabs: { title, cwd, command, args }[] }.
// Claude tabs keep command "claude" there (never the resolved path), so a later
// prefs.claudeCommand change applies to restored tabs too.
import { open } from "@tauri-apps/plugin-dialog";
import { files, pty } from "../lib/ipc";
import { markTabSeen } from "./activity";
import { CLAUDE, prefsAtom } from "./prefs";
import { basename, debounce, getPaths, joinPath, store, toastError, uuid } from "./store";
import { activeKeyAtom, getTab, renameRequestAtom, tabsAtom, tabsRestoredAtom, updateTab, type Tab } from "./tabState";
import { disposeTerminal, restartTerminal } from "./terminals";

export { CLAUDE } from "./prefs";
export { activeKeyAtom, activeTabAtom, renameRequestAtom, tabsAtom, tabsRestoredAtom, getTab, type Tab, type TabStatus } from "./tabState";

export type TabSpec = { cwd: string; command?: string; args?: string[]; title?: string };

let homeDir: string | null = null;

function titleFor(cwd: string): string {
  if (homeDir && cwd.replace(/\/+$/, "") === homeDir.replace(/\/+$/, "")) return "~";
  return basename(cwd);
}

/** What a "shell" tab runs (prefs.newTabCommand = "shell", or a panel's Shell action). */
export const SHELL_COMMAND = { command: "/bin/bash", args: ["-l"] } as const;

/**
 * Command for a new tab from prefs.newTabCommand. A Claude tab stores the
 * logical CLAUDE command; the pty spawn maps it through claudeCommandAtom.
 */
export function newTabCommand(): { command: string; args: string[] } {
  return store.get(prefsAtom).newTabCommand === "shell"
    ? { command: SHELL_COMMAND.command, args: [...SHELL_COMMAND.args] }
    : { command: CLAUDE, args: [] };
}

function makeTab(spec: TabSpec): Tab {
  const cmd = spec.command ? { command: spec.command, args: spec.args ?? [] } : newTabCommand();
  return {
    id: null,
    key: uuid(),
    title: spec.title?.trim() || titleFor(spec.cwd),
    cwd: spec.cwd,
    command: cmd.command,
    args: cmd.args,
    status: "spawning",
    exitCode: null,
    error: null,
    pid: null,
  };
}

/**
 * Open a tab programmatically (no folder picker). The pty spawns once the
 * terminal has mounted and measured itself. Returns the tab key.
 */
export function openTab(spec: TabSpec, activate = true): string {
  const tab = makeTab(spec);
  store.set(tabsAtom, (tabs) => [...tabs, tab]);
  if (activate || !store.get(activeKeyAtom)) store.set(activeKeyAtom, tab.key);
  return tab.key;
}

let picking = false;
/** Folder picker, then a new tab there running prefs.newTabCommand. */
export async function newTabWithPicker(): Promise<void> {
  if (picking) return;
  picking = true;
  try {
    const paths = await getPaths();
    const picked = await open({ directory: true, multiple: false, defaultPath: paths.home, title: "Open folder in new tab" });
    if (!picked || Array.isArray(picked)) return;
    openTab({ cwd: picked });
  } catch (e) {
    toastError(e, "Could not open a new tab");
  } finally {
    picking = false;
  }
}

/** Kill the pty, dispose the terminal and remove the tab. */
export function closeTab(key: string) {
  const tabs = store.get(tabsAtom);
  const idx = tabs.findIndex((t) => t.key === key);
  if (idx < 0) return;
  const tab = tabs[idx];
  if (tab.id) pty.kill(tab.id).catch(() => {});
  const rest = tabs.filter((t) => t.key !== key);
  if (store.get(activeKeyAtom) === key) {
    const next = rest[idx] ?? rest[idx - 1] ?? null;
    store.set(activeKeyAtom, next ? next.key : null);
  }
  store.set(tabsAtom, rest);
  disposeTerminal(key);
}

export function closeActiveTab() {
  const key = store.get(activeKeyAtom);
  if (key) closeTab(key);
}

export function renameTab(key: string, title: string) {
  const tab = getTab(key);
  if (!tab) return;
  updateTab(key, { title: title.trim() || titleFor(tab.cwd) });
}

/** Put the tab's rail item into edit mode, as a double click does; Enter or blur commits through renameTab. */
export function requestRename(key: string) {
  if (!getTab(key)) return;
  activateTab(key);
  store.set(renameRequestAtom, key);
}

export function activateTab(key: string) {
  if (!getTab(key)) return;
  store.set(activeKeyAtom, key);
  if (document.hasFocus()) markTabSeen(key);
}

/** Move the active tab by delta, wrapping around. */
export function cycleTab(delta: number) {
  const tabs = store.get(tabsAtom);
  if (tabs.length === 0) return;
  const idx = Math.max(
    0,
    tabs.findIndex((t) => t.key === store.get(activeKeyAtom)),
  );
  const next = tabs[(idx + delta + tabs.length) % tabs.length];
  store.set(activeKeyAtom, next.key);
}

/** Re-spawn a dead tab in the same cwd, keeping its scrollback. */
export function restartTab(key: string) {
  restartTerminal(key);
}

// ---------------------------------------------------------------------------
// persistence

type TabsFile = { version: 1; active: number; tabs: { title: string; cwd: string; command: string; args: string[] }[] };

function serialize(): string {
  const tabs = store.get(tabsAtom);
  const active = Math.max(
    0,
    tabs.findIndex((t) => t.key === store.get(activeKeyAtom)),
  );
  const file: TabsFile = {
    version: 1,
    active,
    tabs: tabs.map((t) => ({ title: t.title, cwd: t.cwd, command: t.command, args: t.args })),
  };
  return JSON.stringify(file, null, 2) + "\n";
}

function parseTabsFile(text: string): TabsFile | null {
  const raw = JSON.parse(text) as Partial<TabsFile>;
  if (!raw || !Array.isArray(raw.tabs)) return null;
  const tabs = raw.tabs
    .filter((t) => t && typeof t.cwd === "string" && typeof t.command === "string")
    .map((t) => ({
      title: typeof t.title === "string" ? t.title : "",
      cwd: t.cwd,
      command: t.command,
      args: Array.isArray(t.args) ? t.args.filter((a): a is string => typeof a === "string") : [],
    }));
  return { version: 1, active: typeof raw.active === "number" ? raw.active : 0, tabs };
}

let restoreStarted = false;
/** Restore tabs.json (or open one claude tab in ~ on first launch), then persist every change. */
export async function restoreTabs(): Promise<void> {
  if (restoreStarted) return;
  restoreStarted = true;
  let path: string | null = null;
  try {
    const paths = await getPaths();
    homeDir = paths.home;
    path = joinPath(paths.appData, "tabs.json");
    let file: TabsFile | null = null;
    if (await files.exists(path)) {
      try {
        file = parseTabsFile(await files.readText(path));
      } catch (e) {
        toastError(e, "Could not read tabs.json");
      }
    }
    if (!file) file = { version: 1, active: 0, tabs: [{ title: "", cwd: paths.home, command: CLAUDE, args: [] }] };
    const tabs = file.tabs.map((t) => makeTab({ cwd: t.cwd, command: t.command, args: t.args, title: t.title }));
    store.set(tabsAtom, tabs);
    const active = tabs[Math.min(Math.max(0, file.active), tabs.length - 1)];
    store.set(activeKeyAtom, active ? active.key : null);
  } catch (e) {
    toastError(e, "Could not restore tabs");
  } finally {
    store.set(tabsRestoredAtom, true);
  }
  if (!path) return;
  const target = path;
  let lastWritten = serialize();
  const persist = debounce(() => {
    const text = serialize();
    if (text === lastWritten) return;
    lastWritten = text;
    files.writeText(target, text).catch((e) => toastError(e, "Could not save tabs.json"));
  }, 300);
  store.sub(tabsAtom, persist);
  store.sub(activeKeyAtom, persist);
  // First launch: write the default tab so the file exists.
  files.exists(target).then((ok) => {
    if (!ok) files.writeText(target, lastWritten).catch(() => {});
  });
}
