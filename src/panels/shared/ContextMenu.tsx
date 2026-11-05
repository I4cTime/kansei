// A small right-click menu at the pointer, in the style of the tab rail's tab
// menu (src/app/TabRail.tsx): closes on a click outside, Esc, window blur or
// resize, and after running an item.
import { useEffect } from "react";

export type MenuItem = { label: string; run: () => void; disabled?: boolean };

export function ContextMenu({ x, y, items, onClose, label }: { x: number; y: number; items: MenuItem[]; onClose: () => void; label?: string }) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest("[data-context-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      data-context-menu=""
      role="menu"
      aria-label={label}
      className="fixed z-50 flex min-w-[10rem] flex-col rounded-ui border border-border bg-bg-raised py-1 shadow-lg shadow-black/30"
      style={{ left: Math.min(x, window.innerWidth - 176), top: Math.min(y, window.innerHeight - 8 - 26 * items.length) }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.run();
          }}
          className="cursor-pointer px-3 py-1 text-left text-xs text-fg hover:bg-bg-hover disabled:pointer-events-none disabled:opacity-50"
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
