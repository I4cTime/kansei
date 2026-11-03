import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useAtomValue } from "jotai";
import { CalendarDays, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { PANELS } from "../panels";
import { snapshotAtom } from "../panels/board/model";
import { dayTasks, scheduleAtom, todayAtom, todayPlan } from "../panels/calendar/model";
import { SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_RAIL, clampSidebar, prefsAtom, setPrefs } from "./prefs";
import { panelShortcut } from "./shortcuts";
import { IconButton } from "./ui";

/** One line above the nav: today's area and how many tasks are scheduled. Opens Calendar. */
function TodayStrip() {
  const today = useAtomValue(todayAtom);
  const schedule = useAtomValue(scheduleAtom);
  const snap = useAtomValue(snapshotAtom);
  const plan = todayPlan(schedule, today);
  const n = dayTasks(snap?.items ?? [], today).length;
  const text = `Today · ${plan.area ?? "no plan"} · ${n} ${n === 1 ? "task" : "tasks"}`;
  return (
    <button
      type="button"
      onClick={() => setPrefs({ sidebarSection: "calendar", sidebarCollapsed: false })}
      title={`${today}${plan.note ? `: ${plan.note}` : ""}. Open the Calendar`}
      data-today-strip=""
      className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 border-b border-border px-3 text-left text-[12px] text-fg-muted hover:bg-bg-hover hover:text-fg"
    >
      <CalendarDays size={13} strokeWidth={1.75} className={plan.area ? "shrink-0 text-accent" : "shrink-0"} />
      <span className="min-w-0 truncate">{text}</span>
    </button>
  );
}

export function Sidebar() {
  const prefs = useAtomValue(prefsAtom);
  const collapsed = prefs.sidebarCollapsed;
  const active = PANELS.find((p) => p.id === prefs.sidebarSection) ?? PANELS[0];
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; w: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: collapsed ? SIDEBAR_RAIL : prefs.sidebarWidth };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const raw = d.w + (e.clientX - d.x);
    if (raw < SIDEBAR_MIN - 90) {
      if (!collapsed) setPrefs({ sidebarCollapsed: true });
    } else {
      setPrefs({ sidebarCollapsed: false, sidebarWidth: clampSidebar(raw) });
    }
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const width = collapsed ? SIDEBAR_RAIL : prefs.sidebarWidth;

  return (
    <aside
      style={{ width }}
      className={`relative flex h-full shrink-0 flex-col border-r border-border bg-bg-raised ${dragging ? "select-none" : ""}`}
    >
      <div
        className={`flex h-[34px] shrink-0 items-center border-b border-border ${collapsed ? "justify-center" : "justify-between pl-3 pr-1"}`}
      >
        {!collapsed && <span className="text-xs font-semibold tracking-wide text-fg-muted">kansei</span>}
        <IconButton
          icon={collapsed ? PanelLeftOpen : PanelLeftClose}
          label={collapsed ? "Expand sidebar (Ctrl+Shift+B)" : "Collapse sidebar (Ctrl+Shift+B)"}
          size="sm"
          onClick={() => setPrefs({ sidebarCollapsed: !collapsed })}
        />
      </div>

      {!collapsed && <TodayStrip />}

      {PANELS.length > 0 && (
        <nav className={`flex shrink-0 flex-col gap-px py-1.5 ${collapsed ? "items-center" : "px-1.5"} ${collapsed ? "" : "border-b border-border"}`}>
          {PANELS.map((p, i) => {
            const isActive = p.id === active?.id;
            const Icon = p.icon;
            const keys = panelShortcut(p.id, i);
            const hint = keys ? ` (${keys})` : "";
            return (
              <button
                key={p.id}
                type="button"
                title={collapsed ? `${p.label}${hint}` : (keys ?? undefined)}
                aria-label={p.label}
                aria-current={isActive ? "page" : undefined}
                onClick={() => setPrefs({ sidebarSection: p.id, sidebarCollapsed: false })}
                className={`relative flex items-center rounded-ui text-[13px] transition-colors ${
                  collapsed ? "h-8 w-8 justify-center" : "h-7 gap-2 px-2"
                } ${isActive ? "bg-accent/15 text-accent" : "text-fg-muted hover:bg-bg-hover hover:text-fg"}`}
              >
                {isActive && !collapsed && <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-accent" />}
                <Icon size={16} strokeWidth={1.75} className="shrink-0" />
                {!collapsed && <span className="truncate">{p.label}</span>}
              </button>
            );
          })}
        </nav>
      )}

      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {active ? (
            <active.Component />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-fg-muted">
              No panels yet.
            </div>
          )}
        </div>
      )}

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        title="Drag to resize, double click to reset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setPrefs({ sidebarCollapsed: false, sidebarWidth: SIDEBAR_DEFAULT })}
        className={`absolute inset-y-0 -right-[3px] z-10 w-[6px] cursor-col-resize transition-colors ${
          dragging ? "bg-accent/40" : "hover:bg-accent/25"
        }`}
      />
    </aside>
  );
}
