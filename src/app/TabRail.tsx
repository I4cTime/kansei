import { useCallback, useEffect, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { Columns2, Pencil, Plus, X } from "lucide-react";
import { activateTab, activeKeyAtom, closeTab, newTabWithPicker, renameRequestAtom, renameTab, tabsAtom, type Tab } from "./tabs";
import { activityAtom, dotFor, gaugeFor, isExtended, tabActivity, type DotLook } from "./activity";
import { prefsAtom } from "./prefs";
import { draggedTabAtom, effectiveRight, splitAtom, splitWith, unsplit } from "./split";
import { accentVar } from "./accents";
import { accentOfAtom, accentsOnAtom } from "./accentState";
import { scratchOpenAtom, toggleScratch } from "./scratchState";
import { store } from "./store";
import { IconButton } from "./ui";

type Menu = { key: string; x: number; y: number };

export function TabRail() {
  const tabs = useAtomValue(tabsAtom);
  const activeKey = useAtomValue(activeKeyAtom);
  const split = useAtomValue(splitAtom);
  const right = effectiveRight(split, tabs.map((t) => t.key), activeKey);
  const scroller = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const scratchOpen = useAtomValue(scratchOpenAtom);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Keep the active tab in view.
  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-tab-key="${activeKey}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, tabs.length]);

  // 32 px plus the terminal area's 2 px top border (the rail's bottom edge, in the
  // active tab's accent) line up with the sidebar header's 34 px.
  return (
    <div data-tab-rail className="flex h-[32px] shrink-0 items-stretch bg-bg-sunken">
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
          <TabItem key={t.key} tab={t} active={t.key === activeKey} right={t.key === right} onMenu={setMenu} />
        ))}
      </div>
      <div className="flex shrink-0 items-center px-1">
        <IconButton icon={Plus} label="New tab (Ctrl+Shift+T)" size="sm" onClick={() => void newTabWithPicker()} />
        <IconButton
          icon={Pencil}
          label={`${scratchOpen ? "Close" : "Open"} the scratchpad (Ctrl+Shift+Space)`}
          size="sm"
          aria-pressed={scratchOpen}
          data-scratch-toggle
          className={scratchOpen ? "text-accent hover:text-accent" : ""}
          onClick={toggleScratch}
        />
      </div>
      <div className="flex-1" />
      {menu && <TabMenu menu={menu} isRight={menu.key === right} canSplit={tabs.length > 1} onClose={closeMenu} />}
    </div>
  );
}

/** Right click on a tab: Open on the right (or Close the right pane), Rename, Close. */
function TabMenu({ menu, isRight, canSplit, onClose }: { menu: Menu; isRight: boolean; canSplit: boolean; onClose: () => void }) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest("[data-tab-menu]")) onClose();
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

  const item = (label: string, run: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onClose();
        run();
      }}
      className="cursor-pointer px-3 py-1 text-left text-xs text-fg hover:bg-bg-hover disabled:pointer-events-none disabled:opacity-50"
    >
      {label}
    </button>
  );

  return (
    <div
      data-tab-menu=""
      role="menu"
      className="fixed z-50 flex min-w-[10rem] flex-col rounded-ui border border-border bg-bg-raised py-1 shadow-lg shadow-black/30"
      style={{ left: Math.min(menu.x, window.innerWidth - 176), top: menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {isRight ? item("Close the right pane", unsplit) : item("Open on the right", () => splitWith(menu.key), !canSplit)}
      {item("Rename", () => store.set(renameRequestAtom, menu.key))}
      {item("Close", () => closeTab(menu.key))}
    </div>
  );
}

function TabItem({ tab, active, right, onMenu }: { tab: Tab; active: boolean; right: boolean; onMenu: (m: Menu) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.title);
  const input = useRef<HTMLInputElement>(null);
  const [renameRequest, setRenameRequest] = useAtom(renameRequestAtom);

  // Rename asked for from elsewhere (the palette's Rename tab): same as a double click.
  useEffect(() => {
    if (renameRequest !== tab.key) return;
    setRenameRequest(null);
    setDraft(tab.title);
    setEditing(true);
  }, [renameRequest, tab.key, tab.title, setRenameRequest]);

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
  // Project accent: a 3 px inner left edge (box-shadow, so no layout change).
  const accent = useAtomValue(accentOfAtom)(tab.cwd);
  const accentsOn = useAtomValue(accentsOnAtom);

  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-key={tab.key}
      data-tab-accent={accentsOn ? accent.accent : undefined}
      style={accentsOn ? { boxShadow: `inset 3px 0 0 ${accentVar(accent.accent)}` } : undefined}
      title={`${tab.cwd}\n${[tab.command, ...tab.args].join(" ")}`}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
      }}
      onMouseUp={(e) => {
        if (e.button === 1) closeTab(tab.key);
      }}
      onClick={() => activateTab(tab.key)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ key: tab.key, x: e.clientX, y: e.clientY });
      }}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", tab.title);
        store.set(draggedTabAtom, tab.key);
      }}
      onDragEnd={() => store.set(draggedTabAtom, null)}
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
      {right && <Columns2 data-tab-right size={12} strokeWidth={2} className="shrink-0 text-accent" aria-label="On the right pane" />}
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
