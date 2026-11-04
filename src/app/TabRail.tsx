import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Plus, X } from "lucide-react";
import { activateTab, activeKeyAtom, closeTab, newTabWithPicker, renameTab, tabsAtom, type Tab } from "./tabs";
import { activityAtom, dotFor, gaugeFor, isExtended, tabActivity, type DotLook } from "./activity";
import { prefsAtom } from "./prefs";
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
  const act = tabActivity(tab, useAtomValue(activityAtom));
  const contextWindow = useAtomValue(prefsAtom).contextWindow;
  const dot = dotFor(tab, act);
  const gauge = gaugeFor(act, contextWindow, act ? isExtended(act.sessionId) : false);

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
      {active && <span data-tab-indicator className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}
      {dot && <span data-tab-dot={dot.look} className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(dot.look, active)}`} title={dot.title} />}
      <div className="flex min-w-0 flex-1 flex-col">
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
            className="h-5 w-full min-w-0 rounded-sm border border-accent bg-bg-raised px-1 text-[12.5px] text-fg outline-none"
          />
        ) : (
          <span className={`min-w-0 truncate ${dead ? "opacity-70" : ""}`}>{tab.title}</span>
        )}
        {gauge && !editing && (
          <div data-tab-gauge className="mt-[3px] h-[2px] w-full overflow-hidden rounded-full bg-border" title={gauge.title}>
            <div className={`h-full ${GAUGE_TONE[gauge.tone]}`} style={{ width: `${(gauge.fraction * 100).toFixed(1)}%` }} />
          </div>
        )}
      </div>
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

const GAUGE_TONE = { ok: "bg-ok", warn: "bg-warn", danger: "bg-danger" } as const;

/** Busy = accent, filled; waiting = warn with a 1 px ring; idle = muted; dead = danger; spawning = warn hollow. */
function dotClass(look: DotLook, active: boolean): string {
  switch (look) {
    case "busy":
      return "bg-accent";
    case "waiting":
      return `bg-warn ring-1 ring-warn ring-offset-1 ${active ? "ring-offset-bg" : "ring-offset-bg-sunken"}`;
    case "idle":
      return "bg-fg-muted";
    case "dead":
      return "bg-danger";
    case "spawning":
      return "border border-warn";
  }
}
