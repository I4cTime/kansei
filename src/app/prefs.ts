// App preferences, persisted to <appData>/prefs.json.
//
// Shape (Prefs):
//   newTabCommand:    "claude" | "shell"   what a new tab runs ("shell" = /bin/bash -l)
//   fontSize:         number               terminal font size in px (8..32)
//   fontFamily:       string               terminal font family (CSS font-family list)
//   theme:            "system" | "dark" | "light"   sets data-theme on <html>
//   sidebarWidth:     number               expanded sidebar width in px (220..520)
//   sidebarCollapsed: boolean              true = 44 px icon rail
//   sidebarSection:   string | null        id of the active sidebar panel
//   pinnedProjects:   string[]             folders pinned in the Projects panel (absolute paths)
//   hiddenProjects:   string[]             folders hidden from the Projects panel's default views
//   workspaceRoots:   string[]             folders the Projects tree scans (default [~/Develop] when it exists)
//   collapsedPaths:   string[]             tree roots and groups the user collapsed (default: expanded)
//   expandedPaths:    string[]             tree projects whose subprojects the user expanded (default: collapsed)
//
// Usage from a panel:
//   const prefs = useAtomValue(prefsAtom);
//   await savePrefs({ fontSize: 14 });   // merges, updates the atom, writes now
// Writing prefsAtom directly (useSetAtom(prefsAtom)) also works; the shell
// persists every change after a short debounce. Terminals pick up font and theme
// changes live.
import { atom } from "jotai";
import { files, projects } from "../lib/ipc";
import { debounce, getPaths, joinPath, store, toastError } from "./store";

export type NewTabCommand = "claude" | "shell";
export type ThemePref = "system" | "dark" | "light";

export type Prefs = {
  newTabCommand: NewTabCommand;
  fontSize: number;
  fontFamily: string;
  theme: ThemePref;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  sidebarSection: string | null;
  pinnedProjects: string[];
  hiddenProjects: string[];
  workspaceRoots: string[];
  collapsedPaths: string[];
  expandedPaths: string[];
};

export const SIDEBAR_DEFAULT = 300;
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 520;
export const SIDEBAR_RAIL = 44;

export const DEFAULT_PREFS: Prefs = {
  newTabCommand: "claude",
  fontSize: 13,
  fontFamily: "JetBrainsMono Nerd Font, monospace",
  theme: "system",
  sidebarWidth: SIDEBAR_DEFAULT,
  sidebarCollapsed: false,
  sidebarSection: null,
  pinnedProjects: [],
  hiddenProjects: [],
  workspaceRoots: [],
  collapsedPaths: [],
  expandedPaths: [],
};

export const prefsAtom = atom<Prefs>(DEFAULT_PREFS);
/** True once prefs.json has been read (or found missing). */
export const prefsLoadedAtom = atom(false);

export function clampSidebar(w: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));
}

/** Strings only, trimmed, empty and duplicate entries dropped, order kept. */
function stringList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out: string[] = [];
  for (const x of v) if (typeof x === "string" && x.trim() && !out.includes(x.trim())) out.push(x.trim());
  return out;
}

/** Like stringList, for absolute folders: relative entries dropped, trailing slashes trimmed. */
function folderList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const p = x.trim().replace(/\/+$/, "") || (x.trim().startsWith("/") ? "/" : "");
    if (p.startsWith("/") && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Coerce unknown JSON into a valid Prefs, falling back to defaults per field. */
export function sanitizePrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PREFS;
  return {
    newTabCommand: r.newTabCommand === "shell" ? "shell" : r.newTabCommand === "claude" ? "claude" : d.newTabCommand,
    fontSize:
      typeof r.fontSize === "number" && Number.isFinite(r.fontSize)
        ? Math.min(32, Math.max(8, r.fontSize))
        : d.fontSize,
    fontFamily: typeof r.fontFamily === "string" && r.fontFamily.trim() ? r.fontFamily : d.fontFamily,
    theme: r.theme === "dark" || r.theme === "light" || r.theme === "system" ? r.theme : d.theme,
    sidebarWidth: typeof r.sidebarWidth === "number" ? clampSidebar(r.sidebarWidth) : d.sidebarWidth,
    sidebarCollapsed: typeof r.sidebarCollapsed === "boolean" ? r.sidebarCollapsed : d.sidebarCollapsed,
    sidebarSection: typeof r.sidebarSection === "string" ? r.sidebarSection : d.sidebarSection,
    pinnedProjects: stringList(r.pinnedProjects, d.pinnedProjects),
    hiddenProjects: stringList(r.hiddenProjects, d.hiddenProjects),
    workspaceRoots: folderList(r.workspaceRoots, d.workspaceRoots),
    collapsedPaths: stringList(r.collapsedPaths, d.collapsedPaths),
    expandedPaths: stringList(r.expandedPaths, d.expandedPaths),
  };
}

async function prefsPath(): Promise<string> {
  return joinPath((await getPaths()).appData, "prefs.json");
}

async function writePrefs(p: Prefs): Promise<void> {
  await files.writeText(await prefsPath(), JSON.stringify(p, null, 2) + "\n");
}

/** Merge a patch into prefs, update the atom and write prefs.json immediately. */
export async function savePrefs(patch: Partial<Prefs> = {}): Promise<void> {
  const next = sanitizePrefs({ ...store.get(prefsAtom), ...patch });
  store.set(prefsAtom, next);
  await writePrefs(next);
}

/** Update prefs in memory; the debounced subscriber persists it. */
export function setPrefs(patch: Partial<Prefs>) {
  store.set(prefsAtom, { ...store.get(prefsAtom), ...patch });
}

/** [<home>/Develop] when it is a folder, else []. */
async function defaultWorkspaceRoots(): Promise<string[]> {
  try {
    const dev = joinPath((await getPaths()).home, "Develop");
    const [info] = await projects.info([dev]);
    return info?.exists ? [dev] : [];
  } catch {
    return [];
  }
}

let loadStarted = false;
export async function loadPrefs(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const path = await prefsPath();
    let raw: Record<string, unknown> = {};
    if (await files.exists(path)) {
      const v: unknown = JSON.parse(await files.readText(path));
      if (v && typeof v === "object") raw = v as Record<string, unknown>;
      store.set(prefsAtom, sanitizePrefs(raw));
    }
    // No workspaceRoots key yet: default to ~/Develop when that folder exists.
    if (!Array.isArray(raw.workspaceRoots)) {
      const roots = await defaultWorkspaceRoots();
      store.set(prefsAtom, { ...store.get(prefsAtom), workspaceRoots: roots });
    }
  } catch (e) {
    toastError(e, "Could not read prefs.json");
  } finally {
    store.set(prefsLoadedAtom, true);
    const persist = debounce((p: Prefs) => {
      writePrefs(p).catch((e) => toastError(e, "Could not save prefs.json"));
    }, 400);
    store.sub(prefsAtom, () => persist(store.get(prefsAtom)));
  }
}
