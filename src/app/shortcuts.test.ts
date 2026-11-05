import { describe, expect, it } from "vitest";
import { matchShortcut, panelShortcut } from "./shortcuts";

const key = (code: string, mods: Partial<KeyboardEvent> = { ctrlKey: true, shiftKey: true }) =>
  ({ code, key: "", altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe("shortcuts", () => {
  it("maps digits to the first ten panels and letters to Hooks and Settings", () => {
    expect(matchShortcut(key("Digit1"))).toEqual({ type: "section", index: 0 });
    expect(matchShortcut(key("Digit0"))).toEqual({ type: "section", index: 9 });
    expect(matchShortcut(key("KeyH"))).toEqual({ type: "panel", id: "hooks" });
    expect(matchShortcut(key("Comma"))).toEqual({ type: "panel", id: "settings" });
    expect(matchShortcut(key("KeyH", { ctrlKey: true }))).toBeNull();
  });

  it("maps Ctrl+Shift+P to the palette and leaves Ctrl+K to the terminal", () => {
    expect(matchShortcut(key("KeyP"))).toEqual({ type: "palette" });
    expect(matchShortcut(key("KeyP", { ctrlKey: true }))).toBeNull();
    expect(matchShortcut(key("KeyK", { ctrlKey: true, key: "k" }))).toBeNull();
    expect(matchShortcut(key("KeyK"))).toBeNull();
  });

  it("labels the nav hints", () => {
    expect(panelShortcut("board", 1)).toBe("Ctrl+Shift+2");
    expect(panelShortcut("workflows", 9)).toBe("Ctrl+Shift+0");
    expect(panelShortcut("hooks", 10)).toBe("Ctrl+Shift+H");
    expect(panelShortcut("settings", 11)).toBe("Ctrl+Shift+,");
    expect(panelShortcut("other", 12)).toBeNull();
  });
});
