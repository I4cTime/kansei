// App preferences, persisted to <appData>/prefs.json.
//
// Shape (Prefs):
//   newTabCommand:    "claude" | "shell"   what a new tab runs ("shell" = /bin/bash -l)
//   claudeCommand:    string               executable a "claude" tab runs; "" = ~/.local/bin/claude
//                                          when it is executable, else claude from PATH (see claudeCommand)
//   fontSize:         number               terminal font size in px (8..32)
//   fontFamily:       string               terminal font family (CSS font-family list)
//   theme:            "system" | "dark" | "light" | "omarchy" | "preset:<id>"
//                                          built-ins set data-theme on <html>; "omarchy" follows the
//                                          live Omarchy theme, "preset:<id>" a bundled preset (an
//                                          unknown id falls back to "system"); see src/app/theme/apply.ts
//   effects:          boolean              apply a preset's visual effects (glow, scanlines, square)
//   claudeTheme:      boolean              keep Claude Code on the same palette (~/.claude/themes/kansei.json
//                                          and theme "custom:kansei" in ~/.claude/settings.json)
//   claudeThemeRestore: string | null      settings.json `theme` before Kansei set custom:kansei, restored
//                                          when the user returns to a built-in source
//   sidebarWidth:     number               expanded sidebar width in px (220..520)
//   sidebarCollapsed: boolean              true = 44 px icon rail
//   sidebarSection:   string | null        id of the active sidebar panel
//   pinnedProjects:   string[]             folders pinned in the Projects panel (absolute paths)
//   hiddenProjects:   string[]             folders hidden from the Projects panel's default views
//   workspaceRoots:   string[]             folders the Projects tree scans (default [~/Develop] when it exists)
//   collapsedPaths:   string[]             tree roots and groups the user collapsed (default: expanded)
//   expandedPaths:    string[]             tree projects whose subprojects the user expanded (default: collapsed)
//   board:            BoardConfig | null   the connected GitHub Project (owner, projectNumber, hubRepo and
//                                          the resolved projectId, url, title); null = not configured.
//                                          Set by Connect (board_configure), read by Rust per board call
//   contextWindow:    number               context window in tokens the tab gauge measures against
//                                          (50000..2000000, default 200000); a session that ever goes past
//                                          200000 tokens uses 1000000 instead (see src/app/activity.ts)
//   notifyWaiting:    boolean              desktop notification when a tab that is hidden (or the window
//                                          unfocused) starts waiting: a permission prompt, a question, or
//                                          a finished turn (default true)
//   paletteRecent:    string[]             command palette ids run last, newest first (at most 8; the
//                                          empty query lists them first, see src/app/palette)
//   projectAccents:   boolean              tint each tab, the terminal column and the sidebar header with
//                                          the active tab's project colour (default true; the Calendar dots
//                                          keep their colours regardless, see src/app/accents.ts)
//   mcpHealthAtStartup: boolean            probe every MCP server (user, plugin and the active project's)
//                                          with an initialize handshake 5 s after startup; results in
//                                          <appData>/mcp-health.json (default true, see src/panels/mcps/health.ts)
//   memoryView:       "list" | "graph"     the Memory panel's view: the per-project list, or the node graph of
//                                          the [[links]] between every memory note (default "list"; anything
//                                          else reads as "list", see src/panels/memory/graph.ts)
//
// Usage from a panel:
//   const prefs = useAtomValue(prefsAtom);
//   await savePrefs({ fontSize: 14 });   // merges, updates the atom, writes now
// Writing prefsAtom directly (useSetAtom(prefsAtom)) also works; the shell
// persists every change after a short debounce. Terminals pick up font and theme
// changes live.
import { atom } from "jotai";
import { files, projects, type BoardConfig } from "../lib/ipc";
import { debounce, getPaths, joinPath, store, toastError } from "./store";
import { findPreset } from "./theme/presets";

export type NewTabCommand = "claude" | "shell";
export type BuiltinTheme = "system" | "dark" | "light";
export type ThemePref = BuiltinTheme | "omarchy" | `preset:${string}`;

export type Prefs = {
  newTabCommand: NewTabCommand;
  claudeCommand: string;
  fontSize: number;
  fontFamily: string;
  theme: ThemePref;
  effects: boolean;
  claudeTheme: boolean;
  claudeThemeRestore: string | null;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  sidebarSection: string | null;
  pinnedProjects: string[];
  hiddenProjects: string[];
  workspaceRoots: string[];
  collapsedPaths: string[];
  expandedPaths: string[];
  board: BoardConfig | null;
  contextWindow: number;
  notifyWaiting: boolean;
  paletteRecent: string[];
  projectAccents: boolean;
  mcpHealthAtStartup: boolean;
  memoryView: MemoryView;
};

export type MemoryView = "list" | "graph";

export const CONTEXT_WINDOW_MIN = 50_000;
export const CONTEXT_WINDOW_MAX = 2_000_000;

export const SIDEBAR_DEFAULT = 300;
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 520;
export const SIDEBAR_RAIL = 44;
/** Most ids prefs.paletteRecent keeps. */
export const PALETTE_RECENT_MAX = 8;

export const DEFAULT_PREFS: Prefs = {
  newTabCommand: "claude",
  claudeCommand: "",
  fontSize: 13,
  fontFamily: "JetBrainsMono Nerd Font, monospace",
  theme: "system",
  effects: true,
  claudeTheme: true,
  claudeThemeRestore: null,
  sidebarWidth: SIDEBAR_DEFAULT,
  sidebarCollapsed: false,
  sidebarSection: null,
  pinnedProjects: [],
  hiddenProjects: [],
  workspaceRoots: [],
  collapsedPaths: [],
  expandedPaths: [],
  board: null,
  contextWindow: 200_000,
  notifyWaiting: true,
  paletteRecent: [],
  projectAccents: true,
  mcpHealthAtStartup: true,
  memoryView: "list",
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

/** A known theme source; "preset:<id>" only when <id> is a bundled preset. */
function sanitizeTheme(v: unknown, fallback: ThemePref): ThemePref {
  if (v === "system" || v === "dark" || v === "light" || v === "omarchy") return v;
  if (typeof v === "string" && v.startsWith("preset:") && findPreset(v.slice(7))) return v as ThemePref;
  return fallback;
}

const HUB_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** A complete board config: every string non-empty, a positive integer project number, hubRepo as owner/name. */
export function sanitizeBoard(v: unknown): BoardConfig | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
  const owner = str(r.owner);
  const hubRepo = str(r.hubRepo);
  const projectId = str(r.projectId);
  const url = str(r.url);
  const title = str(r.title);
  const n = r.projectNumber;
  if (!owner || !hubRepo || !projectId || !url || !title) return null;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return null;
  if (!HUB_REPO_RE.test(hubRepo)) return null;
  return { owner, projectNumber: n, hubRepo, projectId, url, title };
}

/** Coerce unknown JSON into a valid Prefs, falling back to defaults per field. */
export function sanitizePrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PREFS;
  return {
    newTabCommand: r.newTabCommand === "shell" ? "shell" : r.newTabCommand === "claude" ? "claude" : d.newTabCommand,
    claudeCommand: typeof r.claudeCommand === "string" ? r.claudeCommand.trim() : d.claudeCommand,
    fontSize:
      typeof r.fontSize === "number" && Number.isFinite(r.fontSize)
        ? Math.min(32, Math.max(8, r.fontSize))
        : d.fontSize,
    fontFamily: typeof r.fontFamily === "string" && r.fontFamily.trim() ? r.fontFamily : d.fontFamily,
    theme: sanitizeTheme(r.theme, d.theme),
    effects: typeof r.effects === "boolean" ? r.effects : d.effects,
    claudeTheme: typeof r.claudeTheme === "boolean" ? r.claudeTheme : d.claudeTheme,
    claudeThemeRestore: typeof r.claudeThemeRestore === "string" ? r.claudeThemeRestore : d.claudeThemeRestore,
    sidebarWidth: typeof r.sidebarWidth === "number" ? clampSidebar(r.sidebarWidth) : d.sidebarWidth,
    sidebarCollapsed: typeof r.sidebarCollapsed === "boolean" ? r.sidebarCollapsed : d.sidebarCollapsed,
    sidebarSection: typeof r.sidebarSection === "string" ? r.sidebarSection : d.sidebarSection,
    pinnedProjects: stringList(r.pinnedProjects, d.pinnedProjects),
    hiddenProjects: stringList(r.hiddenProjects, d.hiddenProjects),
    workspaceRoots: folderList(r.workspaceRoots, d.workspaceRoots),
    collapsedPaths: stringList(r.collapsedPaths, d.collapsedPaths),
    expandedPaths: stringList(r.expandedPaths, d.expandedPaths),
    board: sanitizeBoard(r.board),
    contextWindow:
      typeof r.contextWindow === "number" && Number.isFinite(r.contextWindow)
        ? Math.round(Math.min(CONTEXT_WINDOW_MAX, Math.max(CONTEXT_WINDOW_MIN, r.contextWindow)))
        : d.contextWindow,
    notifyWaiting: typeof r.notifyWaiting === "boolean" ? r.notifyWaiting : d.notifyWaiting,
    paletteRecent: stringList(r.paletteRecent, d.paletteRecent).slice(0, PALETTE_RECENT_MAX),
    projectAccents: typeof r.projectAccents === "boolean" ? r.projectAccents : d.projectAccents,
    mcpHealthAtStartup: typeof r.mcpHealthAtStartup === "boolean" ? r.mcpHealthAtStartup : d.mcpHealthAtStartup,
    memoryView: r.memoryView === "graph" ? "graph" : r.memoryView === "list" ? "list" : d.memoryView,
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

// ---------------------------------------------------------------------------
// Claude command
//
// Tabs store the logical command "claude" (tabs.json too); terminals.ts maps it
// through claudeCommandAtom at spawn time, so a pref change also applies to
// restored and restarted tabs.

/** The logical command a Claude tab stores; resolved at spawn time. */
export const CLAUDE = "claude";

export type ClaudeSource = "pref" | "local" | "path";
export type ClaudeResolved = {
  /** What a "claude" tab actually runs. */
  command: string;
  source: ClaudeSource;
  /** <home>/.local/bin/claude when it is an executable file, else null. */
  local: string | null;
};

/** Resolved Claude command; refreshed at startup and whenever prefs.claudeCommand changes. */
export const claudeCommandAtom = atom<ClaudeResolved>({ command: CLAUDE, source: "path", local: null });

/** Pure resolution: the pref (leading ~ expanded) when set, else `local`, else "claude" from PATH. */
export function claudeCommand(prefs: Pick<Prefs, "claudeCommand">, local: string | null, home?: string): ClaudeResolved {
  const pref = prefs.claudeCommand.trim();
  if (pref) {
    const command = home && pref === "~" ? home : home && pref.startsWith("~/") ? joinPath(home, pref.slice(2)) : pref;
    return { command, source: "pref", local };
  }
  return local ? { command: local, source: "local", local } : { command: CLAUDE, source: "path", local };
}

let claudeCheck: Promise<void> | null = null;
let claudeSeq = 0;

/** Re-check <home>/.local/bin/claude and update claudeCommandAtom. */
export function refreshClaudeCommand(): Promise<void> {
  const seq = ++claudeSeq;
  const run = (async () => {
    let local: string | null = null;
    let home: string | undefined;
    try {
      home = (await getPaths()).home;
      const candidate = joinPath(home, ".local/bin/claude");
      if (await files.executable(candidate)) local = candidate;
    } catch {
      // Treat as not found: claude from PATH.
    }
    if (seq === claudeSeq) store.set(claudeCommandAtom, claudeCommand(store.get(prefsAtom), local, home));
  })();
  claudeCheck = run;
  return run;
}

/** The executable for a tab command: "claude" maps through claudeCommandAtom, anything else is kept. */
export async function spawnCommand(command: string): Promise<string> {
  if (command !== CLAUDE) return command;
  await (claudeCheck ?? refreshClaudeCommand());
  return store.get(claudeCommandAtom).command;
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
    void refreshClaudeCommand();
    let lastClaude = store.get(prefsAtom).claudeCommand;
    store.sub(prefsAtom, () => {
      const next = store.get(prefsAtom).claudeCommand;
      if (next === lastClaude) return;
      lastClaude = next;
      void refreshClaudeCommand();
    });
    const persist = debounce((p: Prefs) => {
      writePrefs(p).catch((e) => toastError(e, "Could not save prefs.json"));
    }, 400);
    store.sub(prefsAtom, () => persist(store.get(prefsAtom)));
  }
}
