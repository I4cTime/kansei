import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, sanitizeBoard, sanitizePrefs } from "./prefs";

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

describe("sanitizePrefs board", () => {
  const board = { owner: "acme", projectNumber: 7, hubRepo: "acme/hub", projectId: "PVT_x", url: "https://github.com/users/acme/projects/7", title: "Plans" };

  it("defaults to not configured", () => {
    expect(DEFAULT_PREFS.board).toBeNull();
    expect(sanitizePrefs({}).board).toBeNull();
    expect(sanitizePrefs({ board: null }).board).toBeNull();
  });

  it("keeps a complete config, trimmed", () => {
    expect(sanitizePrefs({ board }).board).toEqual(board);
    expect(sanitizeBoard({ ...board, owner: " acme ", hubRepo: "acme/hub " })).toEqual(board);
    expect(sanitizeBoard({ ...board, hubRepo: "my.org/some_repo-2" })?.hubRepo).toBe("my.org/some_repo-2");
  });

  it("drops the whole object when a field is missing or wrong", () => {
    const bad: Record<string, unknown>[] = [
      { owner: "" },
      { owner: "   " },
      { owner: 5 },
      { projectNumber: 0 },
      { projectNumber: -1 },
      { projectNumber: 1.5 },
      { projectNumber: "7" },
      { hubRepo: "hub" },
      { hubRepo: "acme/hub/x" },
      { hubRepo: "acme/h b" },
      { projectId: "" },
      { url: null },
      { title: undefined },
    ];
    for (const patch of bad) expect(sanitizePrefs({ board: { ...board, ...patch } }).board, JSON.stringify(patch)).toBeNull();
    expect(sanitizePrefs({ board: "acme/7" }).board).toBeNull();
  });
});

describe("sanitizePrefs tab status keys", () => {
  it("defaults to a 200k window with notifications on", () => {
    expect([DEFAULT_PREFS.contextWindow, DEFAULT_PREFS.notifyWaiting]).toEqual([200_000, true]);
  });

  it("clamps the window to 50k..2M and type-checks notifyWaiting", () => {
    expect(sanitizePrefs({ contextWindow: 1000 }).contextWindow).toBe(50_000);
    expect(sanitizePrefs({ contextWindow: 5_000_000 }).contextWindow).toBe(2_000_000);
    expect(sanitizePrefs({ contextWindow: 500_000.4 }).contextWindow).toBe(500_000);
    expect(sanitizePrefs({ contextWindow: "1M" }).contextWindow).toBe(200_000);
    expect(sanitizePrefs({ notifyWaiting: false }).notifyWaiting).toBe(false);
    expect(sanitizePrefs({ notifyWaiting: "no" }).notifyWaiting).toBe(true);
  });
});
