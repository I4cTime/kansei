import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { RotateCcw, SquareTerminal, X } from "lucide-react";
import { activeKeyAtom, closeTab, newTabWithPicker, restartTab, tabsAtom, tabsRestoredAtom, type Tab } from "./tabs";
import { attachTerminal, fitTerminal, focusTerminal, scheduleFit } from "./terminals";
import { Button } from "./ui";

export function TerminalArea() {
  const tabs = useAtomValue(tabsAtom);
  const activeKey = useAtomValue(activeKeyAtom);
  const restored = useAtomValue(tabsRestoredAtom);

  return (
    <div data-terminal-area className="relative min-h-0 flex-1 bg-bg">
      {tabs.map((t) => (
        <TerminalView key={t.key} tab={t} active={t.key === activeKey} />
      ))}
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

function TerminalView({ tab, active }: { tab: Tab; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = tab.key;

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

  return (
    <div className="absolute inset-0" style={{ display: active ? "block" : "none" }}>
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
