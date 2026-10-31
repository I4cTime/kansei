// xterm theme derived from the CSS tokens in src/index.css.
import { atom } from "jotai";
import type { ITheme } from "@xterm/xterm";

/** Bumped whenever the effective theme may have changed (pref or OS scheme). */
export const themeTickAtom = atom(0);

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = style.getPropertyValue(name).trim();
  return v || fallback;
}

/** "#rrggbb" + alpha 0..1 -> "#rrggbbaa"; other formats are returned unchanged. */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${m[1]}${a}`;
}

export function readTerminalTheme(): ITheme {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => cssVar(s, n, f);
  const bg = v("--bg", "#0f1115");
  const fg = v("--fg", "#e6e8ee");
  const accent = v("--accent", "#7aa2f7");
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: withAlpha(accent, 0.3),
    selectionInactiveBackground: withAlpha(accent, 0.15),
    scrollbarSliderBackground: withAlpha(v("--fg-muted", "#8b91a3"), 0.25),
    scrollbarSliderHoverBackground: withAlpha(v("--fg-muted", "#8b91a3"), 0.4),
    scrollbarSliderActiveBackground: withAlpha(v("--fg-muted", "#8b91a3"), 0.55),
    black: v("--t-black", "#15161e"),
    red: v("--t-red", "#f7768e"),
    green: v("--t-green", "#9ece6a"),
    yellow: v("--t-yellow", "#e0af68"),
    blue: v("--t-blue", "#7aa2f7"),
    magenta: v("--t-magenta", "#bb9af7"),
    cyan: v("--t-cyan", "#7dcfff"),
    white: v("--t-white", "#a9b1d6"),
    brightBlack: v("--t-bblack", "#414868"),
    brightRed: v("--t-bred", "#f7768e"),
    brightGreen: v("--t-bgreen", "#9ece6a"),
    brightYellow: v("--t-byellow", "#e0af68"),
    brightBlue: v("--t-bblue", "#7aa2f7"),
    brightMagenta: v("--t-bmagenta", "#bb9af7"),
    brightCyan: v("--t-bcyan", "#7dcfff"),
    brightWhite: v("--t-bwhite", "#c0caf5"),
  };
}
