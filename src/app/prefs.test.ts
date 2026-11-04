import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, sanitizePrefs } from "./prefs";

describe("sanitizePrefs theme keys", () => {
  it("defaults the new keys", () => {
    const p = sanitizePrefs({});
    expect(p.theme).toBe("system");
    expect(p.effects).toBe(true);
    expect(p.claudeTheme).toBe(true);
    expect(p.claudeThemeRestore).toBeNull();
    expect(p).toEqual(DEFAULT_PREFS);
  });

  it("keeps known theme sources and bundled presets only", () => {
    for (const t of ["system", "dark", "light", "omarchy", "preset:night-city", "preset:outrun"]) expect(sanitizePrefs({ theme: t }).theme).toBe(t);
    for (const t of ["preset:nope", "preset:", "solarized", 3, null]) expect(sanitizePrefs({ theme: t }).theme).toBe("system");
  });

  it("type-checks effects, claudeTheme and claudeThemeRestore", () => {
    const p = sanitizePrefs({ effects: false, claudeTheme: false, claudeThemeRestore: "dark-ansi" });
    expect([p.effects, p.claudeTheme, p.claudeThemeRestore]).toEqual([false, false, "dark-ansi"]);
    const q = sanitizePrefs({ effects: "no", claudeTheme: 0, claudeThemeRestore: 5 });
    expect([q.effects, q.claudeTheme, q.claudeThemeRestore]).toEqual([true, true, null]);
  });
});
