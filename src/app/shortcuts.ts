// Shell shortcut matching (pure). Installed at window level in keyboard.ts and
// also excluded from xterm via attachCustomKeyEventHandler in terminals.ts.
export type ShortcutAction =
  | { type: "newTab" }
  | { type: "closeTab" }
  | { type: "prevTab" }
  | { type: "nextTab" }
  | { type: "toggleSidebar" }
  | { type: "section"; index: number }
  | { type: "panel"; id: string }
  | { type: "palette" }
  | { type: "toggleSplit" }
  | { type: "toggleScratch" };

/**
 * Panels past the tenth have their own letter (Ctrl+Shift+1..9,0 cover the
 * first ten in nav order): Hooks is Ctrl+Shift+H, Settings Ctrl+Shift+,.
 */
export const PANEL_KEYS: Record<string, { code: string; label: string }> = {
  hooks: { code: "KeyH", label: "Ctrl+Shift+H" },
  settings: { code: "Comma", label: "Ctrl+Shift+," },
};

/** The shortcut shown for the panel at nav position `index` with id `id`, or null. */
export function panelShortcut(id: string, index: number): string | null {
  if (PANEL_KEYS[id]) return PANEL_KEYS[id].label;
  if (index < 9) return `Ctrl+Shift+${index + 1}`;
  if (index === 9) return "Ctrl+Shift+0";
  return null;
}

export function matchShortcut(e: KeyboardEvent): ShortcutAction | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  if (!e.shiftKey) {
    if (e.key === "PageUp") return { type: "prevTab" };
    if (e.key === "PageDown") return { type: "nextTab" };
    return null;
  }
  switch (e.code) {
    case "KeyT":
      return { type: "newTab" };
    case "KeyW":
      return { type: "closeTab" };
    case "KeyB":
      return { type: "toggleSidebar" };
    case "KeyP":
      return { type: "palette" };
    case "Backslash":
      return { type: "toggleSplit" };
    case "Space":
      return { type: "toggleScratch" };
  }
  for (const [id, k] of Object.entries(PANEL_KEYS)) if (e.code === k.code) return { type: "panel", id };
  // Digit1..9 are sections 1..9, Digit0 is section 10.
  const m = /^Digit([0-9])$/.exec(e.code);
  if (m) return { type: "section", index: m[1] === "0" ? 9 : Number(m[1]) - 1 };
  return null;
}
