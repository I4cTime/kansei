// Theme application: turns prefs.theme (+ effects, claudeTheme) and the live
// Omarchy theme into what <html> carries, and keeps Claude Code in step.
//
// startTheme() is called once from boot() right after loadPrefs(). It
//   - applies now, then again whenever prefs.theme / effects / claudeTheme change
//   - fetches the Omarchy theme and follows the "theme:omarchy" event (omarchyAtom),
//     re-applying while the source is "omarchy"
//   - bumps themeTickAtom on OS colour-scheme changes (the "system" source)
//
// Sources:
//   system | dark | light   inline tokens and data-fx-* removed; data-theme set
//                           (removed for system), the CSS in src/index.css decides
//   omarchy                 parsePalette(live colors.toml); missing or unusable ->
//                           built-in dark tokens and one toast per activation
//   preset:<id>             the preset's palette and, with prefs.effects, its effects
// Palette sources set every paletteToTokens() token inline on <html>, color-scheme
// and data-theme from the palette mode, then bump themeTickAtom so terminals retint.
//
// Claude Code theme (prefs.claudeTheme, palette sources only): writes
// ~/.claude/themes/kansei.json when the rendered JSON changed and sets
// `theme: "custom:kansei"` in ~/.claude/settings.json, remembering the previous
// value in prefs.claudeThemeRestore. A built-in source (or turning the pref off)
// puts the previous value back while settings.json still says custom:kansei.
//
// activeThemeAtom: { source, name, palette, effects } for the Settings swatches.
import { atom } from "jotai";
import { files, theme as themeIpc, type OmarchyTheme } from "../../lib/ipc";
import { prefsAtom, savePrefs, type Prefs } from "../prefs";
import { getPaths, joinPath, store, toastError, toastInfo } from "../store";
import { themeTickAtom } from "../terminalTheme";
import { claudeThemeFromPalette, paletteToTokens, parsePalette, prettyName, TOKEN_NAMES, type Palette } from "./palette";
import { findPreset, type Effects } from "./presets";

export type ThemeSource = "system" | "dark" | "light" | "omarchy" | "preset";
export type ActiveTheme = { source: ThemeSource; name: string; palette: Palette | null; effects: Effects };

export const activeThemeAtom = atom<ActiveTheme>({ source: "system", name: "Match system", palette: null, effects: {} });

/** The live Omarchy theme: undefined until first read, null when not found. */
export const omarchyAtom = atom<OmarchyTheme | null | undefined>(undefined);

export const CLAUDE_THEME_SETTING = "custom:kansei";
const FX = ["glow", "scanlines", "square"] as const;
const BUILTIN_NAMES = { system: "Match system", dark: "Dark", light: "Light" } as const;

const bumpTheme = () => store.set(themeTickAtom, (n) => n + 1);

function sourceOf(pref: Prefs["theme"]): ThemeSource {
  return pref.startsWith("preset:") ? "preset" : (pref as ThemeSource);
}

// ---------------------------------------------------------------------------
// <html>

function clearInline(root: HTMLElement) {
  for (const name of TOKEN_NAMES) root.style.removeProperty(name);
  root.style.removeProperty("color-scheme");
}

function setEffects(root: HTMLElement, fx: Effects) {
  for (const k of FX) {
    if (fx[k]) root.setAttribute(`data-fx-${k}`, "");
    else root.removeAttribute(`data-fx-${k}`);
  }
}

function applyBuiltin(root: HTMLElement, dataTheme: "dark" | "light" | null) {
  clearInline(root);
  setEffects(root, {});
  if (dataTheme) root.setAttribute("data-theme", dataTheme);
  else root.removeAttribute("data-theme");
}

function applyPalette(root: HTMLElement, p: Palette, fx: Effects) {
  for (const [name, value] of Object.entries(paletteToTokens(p))) root.style.setProperty(name, value);
  root.style.setProperty("color-scheme", p.mode);
  root.setAttribute("data-theme", p.mode);
  setEffects(root, fx);
}

// ---------------------------------------------------------------------------
// Claude Code theme sync (serialised; every step reads the files fresh)

let lastClaudeJson: string | null = null;
let claudeQueue: Promise<void> = Promise.resolve();

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  if (!(await files.exists(path))) return {};
  const text = await files.readText(path);
  if (!text.trim()) return {};
  const v: unknown = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${path} is not a JSON object`);
  return v as Record<string, unknown>;
}

const writeJson = (path: string, value: unknown) => files.writeText(path, JSON.stringify(value, null, 2) + "\n");

/** Point Claude Code at kansei.json rendered from `p`. */
async function claudeOn(p: Palette) {
  const paths = await getPaths();
  const themePath = joinPath(joinPath(paths.claudeDir, "themes"), "kansei.json");
  const json = JSON.stringify(claudeThemeFromPalette(p), null, 2) + "\n";
  if (lastClaudeJson === null) {
    try {
      if (await files.exists(themePath)) lastClaudeJson = await files.readText(themePath);
    } catch {
      // Unreadable: write it below.
    }
  }
  if (json !== lastClaudeJson) {
    await files.writeText(themePath, json);
    lastClaudeJson = json;
  }
  const s = await readJsonObject(paths.settings);
  if (s.theme === CLAUDE_THEME_SETTING) return;
  const prev = typeof s.theme === "string" ? s.theme : null;
  await writeJson(paths.settings, { ...s, theme: CLAUDE_THEME_SETTING });
  await savePrefs({ claudeThemeRestore: prev });
}

/** Undo claudeOn: restore the remembered theme while settings.json still says custom:kansei. */
async function claudeOff() {
  const paths = await getPaths();
  const s = await readJsonObject(paths.settings);
  if (s.theme === CLAUDE_THEME_SETTING) {
    const restore = store.get(prefsAtom).claudeThemeRestore;
    const next: Record<string, unknown> = { ...s };
    if (restore) next.theme = restore;
    else delete next.theme;
    await writeJson(paths.settings, next);
  }
  if (store.get(prefsAtom).claudeThemeRestore !== null) await savePrefs({ claudeThemeRestore: null });
}

function syncClaude(action: "on" | "off" | "keep", p: Palette | null) {
  if (action === "keep") return;
  claudeQueue = claudeQueue
    .then(() => (action === "on" && p ? claudeOn(p) : claudeOff()))
    .catch((e) => toastError(e, "Could not sync the Claude Code theme"));
}

// ---------------------------------------------------------------------------
// apply

let applySeq = 0;
let lastSource: ThemeSource | null = null;
let omarchyWarned = false;

/** Apply the current prefs (and Omarchy theme) to <html> now. Resolves with what was applied. */
export async function applyNow(): Promise<ActiveTheme> {
  const seq = ++applySeq;
  const prefs = store.get(prefsAtom);
  const source = sourceOf(prefs.theme);
  const activated = source !== lastSource;
  lastSource = source;
  if (activated) omarchyWarned = false;
  const root = document.documentElement;

  let active: ActiveTheme;
  let claude: "on" | "off" | "keep" = "off";

  if (source === "system" || source === "dark" || source === "light") {
    applyBuiltin(root, source === "system" ? null : source);
    active = { source, name: BUILTIN_NAMES[source], palette: null, effects: {} };
  } else if (source === "omarchy") {
    let live = store.get(omarchyAtom);
    if (activated || live === undefined) {
      try {
        live = await themeIpc.omarchy();
      } catch (e) {
        live = null;
        if (!omarchyWarned) toastError(e, "Could not read the Omarchy theme");
        omarchyWarned = true;
      }
      if (seq !== applySeq) return store.get(activeThemeAtom);
      store.set(omarchyAtom, live);
    }
    const palette = live ? parsePalette(live.palette) : null;
    if (palette && live) {
      applyPalette(root, palette, {});
      active = { source, name: prettyName(live.name), palette, effects: {} };
      claude = prefs.claudeTheme ? "on" : "off";
    } else {
      applyBuiltin(root, "dark");
      active = { source, name: live ? prettyName(live.name) : "Omarchy theme not found", palette: null, effects: {} };
      if (!omarchyWarned) toastInfo(live ? `Omarchy theme ${prettyName(live.name)} has no usable palette` : "Omarchy theme not found");
      omarchyWarned = true;
      claude = "keep";
    }
  } else {
    const preset = findPreset(prefs.theme.slice("preset:".length));
    if (preset) {
      const fx = prefs.effects ? (preset.effects ?? {}) : {};
      applyPalette(root, preset.palette, fx);
      active = { source, name: preset.name, palette: preset.palette, effects: fx };
      claude = prefs.claudeTheme ? "on" : "off";
    } else {
      applyBuiltin(root, null);
      active = { source: "system", name: BUILTIN_NAMES.system, palette: null, effects: {} };
    }
  }

  store.set(activeThemeAtom, active);
  bumpTheme();
  syncClaude(claude, active.palette);
  return active;
}

let started = false;

/** Start following prefs, the Omarchy theme and the OS colour scheme. Idempotent. */
export function startTheme() {
  if (started) return;
  started = true;

  let last = keyOf(store.get(prefsAtom));
  store.sub(prefsAtom, () => {
    const next = keyOf(store.get(prefsAtom));
    if (next === last) return;
    last = next;
    void applyNow();
  });

  themeIpc
    .onOmarchy((t) => {
      store.set(omarchyAtom, t);
      if (sourceOf(store.get(prefsAtom).theme) === "omarchy") void applyNow();
    })
    .catch((e) => toastError(e, "Could not watch the Omarchy theme"));

  const mq = window.matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener("change", bumpTheme);

  void applyNow().then(() => {
    // Know the Omarchy name for the Settings select even when another source is active.
    if (store.get(omarchyAtom) === undefined) {
      themeIpc
        .omarchy()
        .then((t) => store.get(omarchyAtom) === undefined && store.set(omarchyAtom, t))
        .catch(() => store.get(omarchyAtom) === undefined && store.set(omarchyAtom, null));
    }
  });
}

function keyOf(p: Prefs): string {
  return `${p.theme}|${p.effects}|${p.claudeTheme}`;
}
