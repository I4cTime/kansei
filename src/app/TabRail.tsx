import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Plus, X } from "lucide-react";
import { activateTab, activeKeyAtom, closeTab, newTabWithPicker, renameTab, tabsAtom, type Tab } from "./tabs";
import { IconButton } from "./ui";

export function TabRail() {
  const tabs = useAtomValue(tabsAtom);
  const activeKey = useAtomValue(activeKeyAtom);
  const scroller = useRef<HTMLDivElement>(null);

  // Keep the active tab in view.
  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-tab-key="${activeKey}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, tabs.length]);

  return (
    <div className="flex h-[34px] shrink-0 items-stretch border-b border-border bg-bg-sunken">
      <div
        ref={scroller}
        role="tablist"
        className="tab-scroll flex min-w-0 items-stretch overflow-x-auto overflow-y-hidden"
        style={{ scrollbarWidth: "none" }}
        onWheel={(e) => {
          if (e.deltaY !== 0 && scroller.current) scroller.current.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((t) => (
          <TabItem key={t.key} tab={t} active={t.key === activeKey} />
        ))}
      </div>
      <div className="flex shrink-0 items-center px-1">
        <IconButton icon={Plus} label="New tab (Ctrl+Shift+T)" size="sm" onClick={() => void newTabWithPicker()} />
      </div>
      <div className="flex-1" />
    </div>
  );
}

function TabItem({ tab, active }: { tab: Tab; active: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.title);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const commit = () => {
    renameTab(tab.key, draft);
    setEditing(false);
  };

  const dead = tab.status === "dead";

  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-key={tab.key}
      title={`${tab.cwd}\n${[tab.command, ...tab.args].join(" ")}`}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
      }}
      onMouseUp={(e) => {
        if (e.button === 1) closeTab(tab.key);
      }}
      onClick={() => activateTab(tab.key)}
      onDoubleClick={() => {
        setDraft(tab.title);
        setEditing(true);
      }}
      className={`group relative flex min-w-[96px] max-w-[220px] shrink-0 cursor-default items-center gap-1.5 border-r border-border pl-3 pr-1 text-[12.5px] ${
        active ? "bg-bg text-fg" : "bg-bg-sunken text-fg-muted hover:bg-bg-hover hover:text-fg"
      }`}
    >
      {active && <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}
      {dead && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" title="Exited" />}
      {tab.status === "spawning" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="Starting" />}
      {editing ? (
        <input
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          className="h-5 min-w-0 flex-1 rounded-sm border border-accent bg-bg-raised px-1 text-[12.5px] text-fg outline-none"
        />
      ) : (
        <span className={`min-w-0 flex-1 truncate ${dead ? "opacity-70" : ""}`}>{tab.title}</span>
      )}
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        title="Close tab (Ctrl+Shift+W)"
        onClick={(e) => {
          e.stopPropagation();
          closeTab(tab.key);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:bg-bg-hover hover:text-fg ${
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}
