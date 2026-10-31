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
//
// Usage from a panel:
//   const prefs = useAtomValue(prefsAtom);
//   await savePrefs({ fontSize: 14 });   // merges, updates the atom, writes now
// Writing prefsAtom directly (useSetAtom(prefsAtom)) also works; the shell
// persists every change after a short debounce. Terminals pick up font and theme
// changes live.
import { atom } from "jotai";
import { files } from "../lib/ipc";
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
};

export const prefsAtom = atom<Prefs>(DEFAULT_PREFS);
/** True once prefs.json has been read (or found missing). */
export const prefsLoadedAtom = atom(false);

export function clampSidebar(w: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));
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

let loadStarted = false;
export async function loadPrefs(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const path = await prefsPath();
    if (await files.exists(path)) {
      const text = await files.readText(path);
      store.set(prefsAtom, sanitizePrefs(JSON.parse(text)));
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
