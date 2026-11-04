// Palette themes: the shape of an Omarchy colors.toml, and the pure helpers that
// turn one into Kansei's CSS tokens and a Claude Code theme file. No DOM here.
//
// Palette: `mode` plus 26 colours, every one "#rrggbb" lowercase.
//   accent, selection, muted
//   background, dark_background, darker_background, lighter_background
//   foreground, dark_foreground, light_foreground, bright_foreground
//   red yellow orange green cyan blue magenta brown        (the eight base colours)
//   bright_red bright_yellow bright_green bright_cyan bright_blue bright_magenta
//
// parsePalette(raw) takes the raw colors.toml strings: accent, background,
// foreground and the six base colours (red yellow green cyan blue magenta) are
// required, everything else is derived when missing or not a hex colour (see
// CONTRACT.md "Themes"). mix(a, b, pct) is the one helper every derivation uses.
// paletteToTokens(p) matches Omarchy's Alacritty template, so a terminal in Kansei
// looks like the user's Alacritty for the same theme. claudeThemeFromPalette(p)
// matches Omarchy's claude.json.tpl.

export type Mode = "dark" | "light";

export type Palette = {
  mode: Mode;
  accent: string;
  selection: string;
  muted: string;
  background: string;
  dark_background: string;
  darker_background: string;
  lighter_background: string;
  foreground: string;
  dark_foreground: string;
  light_foreground: string;
  bright_foreground: string;
  red: string;
  yellow: string;
  orange: string;
  green: string;
  cyan: string;
  blue: string;
  magenta: string;
  brown: string;
  bright_red: string;
  bright_yellow: string;
  bright_green: string;
  bright_cyan: string;
  bright_blue: string;
  bright_magenta: string;
};

/** Every colour key of a Palette (all but `mode`), in colors.toml order. */
export const PALETTE_KEYS = [
  "accent",
  "selection",
  "muted",
  "background",
  "dark_background",
  "darker_background",
  "lighter_background",
  "foreground",
  "dark_foreground",
  "light_foreground",
  "bright_foreground",
  "red",
  "yellow",
  "orange",
  "green",
  "cyan",
  "blue",
  "magenta",
  "brown",
  "bright_red",
  "bright_yellow",
  "bright_green",
  "bright_cyan",
  "bright_blue",
  "bright_magenta",
] as const satisfies readonly Exclude<keyof Palette, "mode">[];

export type ColorKey = (typeof PALETTE_KEYS)[number];

/** The eight base colours, in swatch order. */
export const BASE_COLORS = ["red", "yellow", "orange", "green", "cyan", "blue", "magenta", "brown"] as const satisfies readonly ColorKey[];

const REQUIRED = ["accent", "background", "foreground", "red", "yellow", "green", "cyan", "blue", "magenta"] as const;
const BRIGHT = ["red", "yellow", "green", "cyan", "blue", "magenta"] as const;

const HEX = /^#[0-9a-f]{6}$/i;

export function isHex(v: unknown): v is string {
  return typeof v === "string" && HEX.test(v);
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((c) => Math.min(255, Math.max(0, c)).toString(16).padStart(2, "0")).join("");
}

/** Mix two "#rrggbb" colours in sRGB: `pct` (0..100) of `b` into `a`, channels rounded. */
export function mix(a: string, b: string, pct: number): string {
  const x = rgb(a);
  const y = rgb(b);
  const t = pct / 100;
  return hex([0, 1, 2].map((i) => Math.round(x[i] + (y[i] - x[i]) * t)) as [number, number, number]);
}

/** Raw colors.toml strings -> a complete Palette, or null when a required colour is missing. */
export function parsePalette(raw: Record<string, string>): Palette | null {
  const get = (k: string): string | undefined => (isHex(raw[k]) ? raw[k].toLowerCase() : undefined);
  for (const k of REQUIRED) if (!get(k)) return null;
  const req = (k: (typeof REQUIRED)[number]) => get(k) as string;

  const background = req("background");
  const foreground = req("foreground");
  const accent = req("accent");
  const red = req("red");
  const yellow = req("yellow");
  const orange = get("orange") ?? mix(red, yellow, 50);

  const p: Palette = {
    mode: raw.mode === "light" ? "light" : "dark",
    accent,
    selection: get("selection") ?? mix(background, accent, 25),
    muted: get("muted") ?? mix(background, foreground, 30),
    background,
    dark_background: get("dark_background") ?? mix(background, "#000000", 6),
    darker_background: get("darker_background") ?? mix(background, "#000000", 12),
    lighter_background: get("lighter_background") ?? mix(background, foreground, 8),
    foreground,
    dark_foreground: get("dark_foreground") ?? mix(foreground, background, 35),
    light_foreground: get("light_foreground") ?? mix(foreground, background, 15),
    bright_foreground: get("bright_foreground") ?? foreground,
    red,
    yellow,
    orange,
    green: req("green"),
    cyan: req("cyan"),
    blue: req("blue"),
    magenta: req("magenta"),
    brown: get("brown") ?? mix(orange, background, 45),
    bright_red: "",
    bright_yellow: "",
    bright_green: "",
    bright_cyan: "",
    bright_blue: "",
    bright_magenta: "",
  };
  for (const c of BRIGHT) p[`bright_${c}`] = get(`bright_${c}`) ?? mix(p[c], foreground, 25);
  return p;
}

/** CSS tokens of src/index.css for a palette (CONTRACT.md "Themes", token table). */
export function paletteToTokens(p: Palette): Record<string, string> {
  return {
    "--bg": p.background,
    "--bg-raised": p.lighter_background,
    "--bg-sunken": p.dark_background,
    "--bg-hover": mix(p.lighter_background, p.foreground, 8),
    "--fg": p.foreground,
    "--fg-muted": p.dark_foreground,
    "--border": p.muted,
    "--accent": p.accent,
    "--accent-fg": p.darker_background,
    "--danger": p.red,
    "--ok": p.green,
    "--warn": p.yellow,
    "--t-black": p.background,
    "--t-red": p.red,
    "--t-green": p.green,
    "--t-yellow": p.yellow,
    "--t-blue": p.blue,
    "--t-magenta": p.magenta,
    "--t-cyan": p.cyan,
    "--t-white": p.foreground,
    "--t-bblack": p.muted,
    "--t-bred": p.bright_red,
    "--t-bgreen": p.bright_green,
    "--t-byellow": p.bright_yellow,
    "--t-bblue": p.bright_blue,
    "--t-bmagenta": p.bright_magenta,
    "--t-bcyan": p.bright_cyan,
    "--t-bwhite": p.bright_foreground,
    "--t-cursor": p.bright_foreground,
    "--t-selection": p.selection,
  };
}

/** Names of every token paletteToTokens sets (for clearing them again). */
export const TOKEN_NAMES: readonly string[] = Object.keys(
  paletteToTokens(Object.fromEntries(PALETTE_KEYS.map((k) => [k, "#000000"])) as unknown as Palette),
);

export type ClaudeTheme = { name: string; base: Mode; overrides: Record<string, string> };

/** A Claude Code custom theme with the keys and mixes of Omarchy's claude.json.tpl. */
export function claudeThemeFromPalette(p: Palette): ClaudeTheme {
  const { accent, foreground: fg, background: bg } = p;
  return {
    name: "Kansei",
    base: p.mode,
    overrides: {
      claude: accent,
      claudeShimmer: mix(accent, fg, 35),
      text: fg,
      inverseText: bg,
      inactive: mix(fg, bg, 40),
      inactiveShimmer: mix(fg, bg, 25),
      subtle: p.muted,
      suggestion: p.cyan,
      permission: p.blue,
      permissionShimmer: mix(p.blue, fg, 35),
      remember: p.yellow,
      success: p.green,
      error: p.red,
      warning: p.yellow,
      warningShimmer: mix(p.yellow, fg, 35),
      merged: p.magenta,
      promptBorder: accent,
      promptBorderShimmer: mix(accent, fg, 35),
      planMode: p.cyan,
      autoAccept: p.yellow,
      bashBorder: p.bright_yellow,
      ide: p.bright_cyan,
      diffAdded: mix(bg, p.green, 15),
      diffRemoved: mix(bg, p.red, 15),
      diffAddedDimmed: mix(bg, p.green, 8),
      diffRemovedDimmed: mix(bg, p.red, 8),
      diffAddedWord: mix(bg, p.green, 32),
      diffRemovedWord: mix(bg, p.red, 32),
      userMessageBackground: mix(bg, fg, 6),
      userMessageBackgroundHover: mix(bg, fg, 10),
      bashMessageBackgroundColor: mix(bg, fg, 6),
      memoryBackgroundColor: mix(bg, fg, 6),
      selectionBg: p.selection,
      rate_limit_fill: accent,
      rate_limit_empty: mix(bg, fg, 20),
      briefLabelYou: p.yellow,
      briefLabelClaude: accent,
    },
  };
}

function luminance(hexColor: string): number {
  const [r, g, b] = rgb(hexColor).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two "#rrggbb" colours, 1..21. */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Display name for an Omarchy theme slug: "tokyo-night" -> "Tokyo Night", "NERV" stays "NERV". */
export function prettyName(slug: string): string {
  return slug
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}
