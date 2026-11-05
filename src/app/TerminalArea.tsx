import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useAtomValue } from "jotai";
import { Columns2, RotateCcw, SquareTerminal, X } from "lucide-react";
import { activeKeyAtom, closeTab, newTabWithPicker, restartTab, tabsAtom, tabsRestoredAtom, type Tab } from "./tabs";
import { attachTerminal, fitTerminal, focusTerminal, scheduleFit } from "./terminals";
import { DEFAULT_RATIO, draggedTabAtom, effectiveRight, focusedPaneAtom, setRatio, splitAtom, splitWith, type Pane } from "./split";
import { store } from "./store";
import { Button } from "./ui";

/** Divider width in px; each pane gives up half of it. */
const DIVIDER = 6;

export function TerminalArea() {
  const tabs = useAtomValue(tabsAtom);
  const activeKey = useAtomValue(activeKeyAtom);
  const restored = useAtomValue(tabsRestoredAtom);
  const split = useAtomValue(splitAtom);
  const focusedPane = useAtomValue(focusedPaneAtom);
  const dragged = useAtomValue(draggedTabAtom);
  const area = useRef<HTMLDivElement>(null);
  /** While a rail tab is dragged over the area: "area", or "right" over the right half (the drop zone). */
  const [dropZone, setDropZone] = useState<null | "area" | "right">(null);

  const right = effectiveRight(split, tabs.map((t) => t.key), activeKey);
  const ratio = right ? split.ratio : null;

  // The right pane went away while it had focus: back to the left terminal.
  useEffect(() => {
    if (right || store.get(focusedPaneAtom) !== "right") return;
    store.set(focusedPaneAtom, "left");
    if (activeKey) focusTerminal(activeKey);
  }, [right, activeKey]);

  useEffect(() => {
    if (!dragged) setDropZone(null);
  }, [dragged]);

  return (
    <div
      ref={area}
      data-terminal-area
      data-split={right ? "" : undefined}
      className="relative min-h-0 flex-1 bg-bg"
      onDragOver={(e) => {
        if (!store.get(draggedTabAtom) || !area.current) return;
        const r = area.current.getBoundingClientRect();
        const over = e.clientX >= r.left + r.width / 2;
        if (over) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
        setDropZone(over ? "right" : "area");
      }}
      onDragLeave={(e) => {
        if (!area.current?.contains(e.relatedTarget as Node | null)) setDropZone(null);
      }}
      onDrop={(e) => {
        const key = store.get(draggedTabAtom);
        setDropZone(null);
        store.set(draggedTabAtom, null);
        if (!key) return;
        e.preventDefault();
        splitWith(key);
      }}
    >
      {tabs.map((t) => {
        const pane: Pane | null = t.key === activeKey ? "left" : t.key === right ? "right" : null;
        return <TerminalView key={t.key} tab={t} pane={pane} ratio={ratio} focused={ratio !== null && pane === focusedPane} />;
      })}
      {ratio !== null && <Divider ratio={ratio} area={area} />}
      {dropZone && (
        <div
          data-split-drop
          className={`pointer-events-none absolute inset-y-0 right-0 z-20 flex w-1/2 items-center justify-center gap-2 border-2 border-dashed text-xs ${
            dropZone === "right" ? "border-accent bg-accent/15 text-fg" : "border-border bg-bg-raised/40 text-fg-muted"
          }`}
        >
          <Columns2 size={14} strokeWidth={1.75} />
          Open on the right
        </div>
      )}
      {restored && tabs.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-fg-muted">
          <SquareTerminal size={28} strokeWidth={1.5} />
          <div className="text-[13px]">No open tabs</div>
          <Button variant="primary" size="sm" onClick={() => void newTabWithPicker()}>
            Open a folder
          </Button>
          <div className="text-xs">Ctrl+Shift+T</div>
        </div>
      )}
    </div>
  );
}

/** The split's divider: drag to resize (setRatio on every move), double click resets to 0.5. */
function Divider({ ratio, area }: { ratio: number; area: RefObject<HTMLDivElement | null> }) {
  const resize = (clientX: number) => {
    const r = area.current?.getBoundingClientRect();
    if (r && r.width > 0) setRatio((clientX - r.left) / r.width);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the split"
      title="Drag to resize, double click to reset"
      data-split-divider
      className="group absolute inset-y-0 z-10 flex cursor-col-resize justify-center bg-bg"
      style={{ left: `calc(${ratio * 100}% - ${DIVIDER / 2}px)`, width: DIVIDER }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) resize(e.clientX);
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onDoubleClick={() => setRatio(DEFAULT_RATIO)}
    >
      <div className="h-full w-px bg-border group-hover:bg-accent" />
    </div>
  );
}

/** Where a terminal sits: unsplit exactly as before (the whole area), split in its pane. */
function paneStyle(pane: Pane | null, ratio: number | null, focused: boolean): CSSProperties {
  if (!pane) return { display: "none" };
  if (ratio === null) return { display: "block" };
  const at = `${ratio * 100}%`;
  const half = `${DIVIDER / 2}px`;
  const box: CSSProperties =
    pane === "left" ? { display: "block", right: "auto", width: `calc(${at} - ${half})` } : { display: "block", left: `calc(${at} + ${half})` };
  return { ...box, borderTop: `2px solid ${focused ? "var(--accent)" : "transparent"}` };
}

function TerminalView({ tab, pane, ratio, focused }: { tab: Tab; pane: Pane | null; ratio: number | null; focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = tab.key;
  const active = pane === "left";

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    attachTerminal(key, el);
    const ro = new ResizeObserver(() => scheduleFit(key));
    ro.observe(el);
    return () => ro.disconnect();
  }, [key]);

  useEffect(() => {
    if (!active) return;
    const f = requestAnimationFrame(() => {
      fitTerminal(key);
      focusTerminal(key);
    });
    return () => cancelAnimationFrame(f);
  }, [active, key]);

  const dead = tab.status === "dead";
  // While split, the pane that last got a mouse down or keyboard focus gets the accent border.
  const notePane = () => {
    if (ratio !== null && pane && store.get(focusedPaneAtom) !== pane) store.set(focusedPaneAtom, pane);
  };

  return (
    <div
      className="absolute inset-0"
      data-pane={ratio !== null && pane ? pane : undefined}
      style={paneStyle(pane, ratio, focused)}
      onMouseDownCapture={notePane}
      onFocusCapture={notePane}
    >
      <div ref={ref} className="absolute inset-0 py-1 pl-2 pr-0" onMouseDown={() => focusTerminal(key)} />
      {dead && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-3 border-t border-border bg-bg-raised/95 px-3 py-1.5 text-xs">
          <span className={tab.error ? "text-danger" : "text-fg-muted"}>
            {tab.error
              ? `Could not start ${tab.command}: ${tab.error}`
              : `Exited${tab.exitCode != null ? ` (code ${tab.exitCode})` : ""}`}
          </span>
          <div className="flex-1" />
          <Button variant="primary" size="sm" onClick={() => restartTab(key)}>
            <RotateCcw size={12} strokeWidth={2} />
            Restart
          </Button>
          <Button size="sm" onClick={() => closeTab(key)}>
            <X size={12} strokeWidth={2} />
            Close
          </Button>
        </div>
      )}
    </div>
  );
}
