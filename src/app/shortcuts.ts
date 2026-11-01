// Shell shortcut matching (pure). Installed at window level in keyboard.ts and
// also excluded from xterm via attachCustomKeyEventHandler in terminals.ts.
export type ShortcutAction =
  | { type: "newTab" }
  | { type: "closeTab" }
  | { type: "prevTab" }
  | { type: "nextTab" }
  | { type: "toggleSidebar" }
  | { type: "section"; index: number };

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
  }
  // Digit1..9 are sections 1..9, Digit0 is section 10.
  const m = /^Digit([0-9])$/.exec(e.code);
  if (m) return { type: "section", index: m[1] === "0" ? 9 : Number(m[1]) - 1 };
  return null;
}
