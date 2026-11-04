import { describe, expect, it } from "vitest";
import { claudeThemeFromPalette, contrast, isHex, mix, PALETTE_KEYS, paletteToTokens, parsePalette, prettyName, TOKEN_NAMES, type Palette } from "./palette";

const MIN = {
  accent: "#3cf07c",
  background: "#0b1a10",
  foreground: "#9cf5b3",
  red: "#ff5c4d",
  yellow: "#ffd23f",
  green: "#3cf07c",
  cyan: "#5fe3c9",
  blue: "#6ab0ff",
  magenta: "#d48cff",
};

describe("mix", () => {
  it("mixes pct of b into a, rounded", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 100)).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 50)).toBe("#808080");
    expect(mix("#ff0000", "#0000ff", 25)).toBe("#bf0040");
  });
  it("matches Omarchy's claude.json for the fallout theme", () => {
    expect(mix("#3cf07c", "#9cf5b3", 35)).toBe("#5ef28f");
    expect(mix("#9cf5b3", "#0b1a10", 40)).toBe("#629d72");
  });
});

describe("isHex", () => {
  it("accepts #rrggbb only", () => {
    expect(isHex("#a1B2c3")).toBe(true);
    expect(isHex("#abc")).toBe(false);
    expect(isHex("rgba(3cf07cee)")).toBe(false);
    expect(isHex(undefined)).toBe(false);
  });
});

describe("parsePalette", () => {
  it("derives every optional key from the minimal set", () => {
    const p = parsePalette(MIN)!;
    expect(p).not.toBeNull();
    expect(p.mode).toBe("dark");
    for (const k of PALETTE_KEYS) expect(isHex(p[k]), k).toBe(true);
    expect(p.orange).toBe(mix(MIN.red, MIN.yellow, 50));
    expect(p.brown).toBe(mix(p.orange, MIN.background, 45));
    expect(p.selection).toBe(mix(MIN.background, MIN.accent, 25));
    expect(p.muted).toBe(mix(MIN.background, MIN.foreground, 30));
    expect(p.dark_background).toBe(mix(MIN.background, "#000000", 6));
    expect(p.darker_background).toBe(mix(MIN.background, "#000000", 12));
    expect(p.lighter_background).toBe(mix(MIN.background, MIN.foreground, 8));
    expect(p.dark_foreground).toBe(mix(MIN.foreground, MIN.background, 35));
    expect(p.light_foreground).toBe(mix(MIN.foreground, MIN.background, 15));
    expect(p.bright_foreground).toBe(MIN.foreground);
    expect(p.bright_red).toBe(mix(MIN.red, MIN.foreground, 25));
    expect(p.bright_magenta).toBe(mix(MIN.magenta, MIN.foreground, 25));
  });

  it("keeps given values, lowercases them, reads mode and ignores other keys", () => {
    const p = parsePalette({ ...MIN, mode: "light", orange: "#FFB000", muted: "#2f6a40", hyprland_active_border: "rgba(3cf07cee) 45deg" })!;
    expect(p.mode).toBe("light");
    expect(p.orange).toBe("#ffb000");
    expect(p.muted).toBe("#2f6a40");
    expect(p.brown).toBe(mix("#ffb000", MIN.background, 45));
    expect(Object.keys(p)).not.toContain("hyprland_active_border");
  });

  it("derives an optional key that is not a hex colour", () => {
    expect(parsePalette({ ...MIN, selection: "blue" })!.selection).toBe(mix(MIN.background, MIN.accent, 25));
  });

  it("rejects a palette missing accent, background, foreground or a base colour", () => {
    for (const k of Object.keys(MIN)) {
      const raw: Record<string, string> = { ...MIN };
      delete raw[k];
      expect(parsePalette(raw), k).toBeNull();
    }
    expect(parsePalette({ ...MIN, accent: "#12345" })).toBeNull();
  });
});

describe("paletteToTokens", () => {
  const p = parsePalette({ ...MIN, bright_foreground: "#c8ffd8", selection: "#1c4a2a" })!;
  const t = paletteToTokens(p);
  it("follows the contract table", () => {
    expect(t["--bg"]).toBe(p.background);
    expect(t["--bg-raised"]).toBe(p.lighter_background);
    expect(t["--bg-sunken"]).toBe(p.dark_background);
    expect(t["--bg-hover"]).toBe(mix(p.lighter_background, p.foreground, 8));
    expect(t["--fg"]).toBe(p.foreground);
    expect(t["--fg-muted"]).toBe(p.dark_foreground);
    expect(t["--border"]).toBe(p.muted);
    expect(t["--accent"]).toBe(p.accent);
    expect(t["--accent-fg"]).toBe(p.darker_background);
    expect([t["--danger"], t["--ok"], t["--warn"]]).toEqual([p.red, p.green, p.yellow]);
    expect(t["--t-black"]).toBe(p.background);
    expect([t["--t-red"], t["--t-green"], t["--t-yellow"], t["--t-blue"], t["--t-magenta"], t["--t-cyan"]]).toEqual([p.red, p.green, p.yellow, p.blue, p.magenta, p.cyan]);
    expect(t["--t-white"]).toBe(p.foreground);
    expect(t["--t-bblack"]).toBe(p.muted);
    expect([t["--t-bred"], t["--t-bgreen"], t["--t-byellow"], t["--t-bblue"], t["--t-bmagenta"], t["--t-bcyan"]]).toEqual([
      p.bright_red,
      p.bright_green,
      p.bright_yellow,
      p.bright_blue,
      p.bright_magenta,
      p.bright_cyan,
    ]);
    expect(t["--t-bwhite"]).toBe("#c8ffd8");
    expect(t["--t-cursor"]).toBe("#c8ffd8");
    expect(t["--t-selection"]).toBe("#1c4a2a");
  });
  it("sets exactly TOKEN_NAMES, all hex", () => {
    expect(Object.keys(t).sort()).toEqual([...TOKEN_NAMES].sort());
    expect(TOKEN_NAMES).toHaveLength(30);
    for (const v of Object.values(t)) expect(isHex(v)).toBe(true);
  });
});

describe("claudeThemeFromPalette", () => {
  const p = parsePalette({ ...MIN, muted: "#2f6a40", selection: "#1c4a2a", bright_yellow: "#ffe27a", bright_cyan: "#9ff0df" }) as Palette;
  const c = claudeThemeFromPalette(p);
  it("has the keys of Omarchy's claude.json.tpl", () => {
    expect(c.base).toBe("dark");
    expect(Object.keys(c.overrides).sort()).toEqual(
      [
        "claude", "claudeShimmer", "text", "inverseText", "inactive", "inactiveShimmer", "subtle", "suggestion", "permission",
        "permissionShimmer", "remember", "success", "error", "warning", "warningShimmer", "merged", "promptBorder",
        "promptBorderShimmer", "planMode", "autoAccept", "bashBorder", "ide", "diffAdded", "diffRemoved", "diffAddedDimmed",
        "diffRemovedDimmed", "diffAddedWord", "diffRemovedWord", "userMessageBackground", "userMessageBackgroundHover",
        "bashMessageBackgroundColor", "memoryBackgroundColor", "selectionBg", "rate_limit_fill", "rate_limit_empty",
        "briefLabelYou", "briefLabelClaude",
      ].sort(),
    );
  });
  it("matches Omarchy's rendering for the fallout theme", () => {
    const o = c.overrides;
    expect(o.claude).toBe("#3cf07c");
    expect(o.claudeShimmer).toBe("#5ef28f");
    expect(o.inactive).toBe("#629d72");
    expect(o.inactiveShimmer).toBe("#78be8a");
    expect(o.subtle).toBe("#2f6a40");
    expect(o.permissionShimmer).toBe("#7cc8e4");
    expect(o.warningShimmer).toBe("#dcde68");
    expect(o.bashBorder).toBe("#ffe27a");
    expect(o.ide).toBe("#9ff0df");
    expect(o.diffAdded).toBe(mix(p.background, p.green, 15));
    expect(o.diffRemovedWord).toBe(mix(p.background, p.red, 32));
    expect(o.userMessageBackgroundHover).toBe(mix(p.background, p.foreground, 10));
    expect(o.selectionBg).toBe("#1c4a2a");
    expect(o.rate_limit_empty).toBe(mix(p.background, p.foreground, 20));
  });
  it("uses the palette mode as base", () => {
    expect(claudeThemeFromPalette({ ...p, mode: "light" }).base).toBe("light");
  });
});

describe("contrast", () => {
  it("returns WCAG 2 ratios", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBe(1);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });
});

describe("prettyName", () => {
  it("title-cases Omarchy slugs and keeps acronyms", () => {
    expect(prettyName("fallout")).toBe("Fallout");
    expect(prettyName("tokyo-night")).toBe("Tokyo Night");
    expect(prettyName("catppuccin_latte")).toBe("Catppuccin Latte");
    expect(prettyName("NERV")).toBe("NERV");
    expect(prettyName("  rose-pine  ")).toBe("Rose Pine");
  });
});
