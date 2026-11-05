// Calendar panel (CONTRACT.md "Board and Calendar", "Usage"): week (default)
// or month view of the plan layer (weekly rhythm + per-day overrides in
// schedule.json), the board tasks scheduled on each day, the Claude prompts
// per project that day, and the tokens used: a 14-day strip under the grid
// and the selected day's Usage block. Tasks drag onto a day to get its date.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useAtomValue } from "jotai";
import { ChevronLeft, ChevronRight, RefreshCw, Repeat } from "lucide-react";
import { schedule as scheduleIpc, type BoardItem, type UsageDay } from "../../lib/ipc";
import { Badge, Button, IconButton, cx } from "../ui";
import { EmptyState, Panel, SectionHeader } from "../shared/list";
import { openSheet } from "../shared/Sheet";
import { usePaths, useToast } from "../shared/hooks";
import { basename } from "../shared/paths";
import { plural } from "../shared/format";
import { AsOf, BoardNotice, useNow } from "../board/BoardPanel";
import { refreshBoard, setItemField } from "../board/actions";
import { areaOptions, boardConfigAtom, boardLoadingAtom, itemChip, projectNames, snapshotAtom } from "../board/model";
import { NoBoardLine } from "../board/BoardConnect";
import { treeAtom } from "../projects/workspaceStore";
import { StatusDot } from "../board/StatusDot";
import {
  WEEKDAY_SHORT,
  addDays,
  addMonths,
  dayPlan,
  dayTasks,
  inMonth,
  mergeActivity,
  monthGrid,
  monthLabel,
  monthOf,
  projectColour,
  scheduleAtom,
  shortDayLabel,
  todayAtom,
  unscheduledTasks,
  weekGrid,
  weekLabel,
  WEEKDAY_NAMES,
  weekdayIndex,
  type DayActivity,
  type Ymd,
} from "./model";
import { DaySheet, RhythmSheet } from "./sheets";
import {
  USAGE_REFRESH_MS,
  USAGE_STRIP_DAYS,
  USAGE_TOP_PROJECTS,
  formatTokens,
  inputTokens,
  loadUsage,
  modelTurns,
  stripDays,
  topProjects,
  usageDaysAtom,
  usageLine,
  usageLoadingAtom,
  usageRange,
} from "./usage";

type View = "week" | "month";
const MAX_CELL_TASKS = 4;
/** Activity and usage reload together on this interval. */
const ACTIVITY_REFRESH_MS = USAGE_REFRESH_MS;
const DRAG_SLOP = 4;

type Drag = { item: BoardItem; pointerId: number; x0: number; y0: number; x: number; y: number; active: boolean; over: Ymd | null };

/**
 * Pointer-event drag of a task onto a `[data-day]` cell (same technique as the
 * sidebar resize handle: pointer capture on the row, hit test on move).
 */
function useTaskDrag(onDrop: (item: BoardItem, day: Ymd) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const ref = useRef<Drag | null>(null);
  /** True right after a drag ends, so the click it causes does not open a sheet. */
  const justDragged = useRef(false);

  const end = (e: ReactPointerEvent<HTMLElement>, drop: boolean) => {
    const d = ref.current;
    ref.current = null;
    setDrag(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d?.active) return;
    justDragged.current = true;
    window.setTimeout(() => (justDragged.current = false), 0);
    if (drop && d.over && d.over !== d.item.scheduled) onDrop(d.item, d.over);
  };

  const handlers = (item: BoardItem) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Not an active pointer (synthetic events); the drag still works without capture.
      }
      ref.current = { item, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false, over: null };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = ref.current;
      if (!d || d.pointerId !== e.pointerId) return;
      if (!d.active && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_SLOP) return;
      const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-day]");
      const next = { ...d, x: e.clientX, y: e.clientY, active: true, over: cell?.dataset.day ?? null };
      ref.current = next;
      setDrag(next);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => end(e, true),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => end(e, false),
  });

  return { drag, handlers, justDragged };
}

function projectLabel(path: string, home?: string): string {
  if (home && path.replace(/\/+$/, "") === home.replace(/\/+$/, "")) return "~";
  return basename(path) || path;
}

function ActivityStrip({ list, home, compact }: { list: DayActivity | undefined; home?: string; compact?: boolean }) {
  if (!list || list.length === 0) return null;
  const tip = list.map((a) => `${projectLabel(a.project, home)}: ${plural(a.count, "prompt")}`).join("\n");
  const shown = compact ? list.slice(0, 4) : list;
  return (
    <div className={cx("flex flex-wrap items-center", compact ? "gap-px" : "mt-1 gap-1")} title={tip} data-activity="">
      {shown.map((a) => (
        <span key={a.project} className={cx("inline-block rounded-full", compact ? "h-1 w-1" : "h-1.5 w-1.5")} style={{ background: projectColour(a.project) }} />
      ))}
      {!compact && <span className="text-[10px] text-fg-muted tabular-nums">{list.reduce((n, a) => n + a.count, 0)}</span>}
    </div>
  );
}

/**
 * Tokens in per day for USAGE_STRIP_DAYS days, bars scaled to the strip's
 * busiest day, today in the accent colour. Nothing without usage.
 */
function UsageStrip({ days, usage, today, selected, onPick }: { days: Ymd[]; usage: Map<Ymd, UsageDay>; today: Ymd; selected: Ymd; onPick: (d: Ymd) => void }) {
  const bars = days.map((d) => {
    const u = usage.get(d);
    return { d, u, v: u ? inputTokens(u.total) : 0 };
  });
  const max = Math.max(0, ...bars.map((b) => b.v));
  if (max === 0) return null;
  return (
    <div className="px-3 pt-2" data-usage-strip="">
      <div className="flex items-baseline justify-between text-[10px] text-fg-muted">
        <span>Tokens in, {USAGE_STRIP_DAYS} days</span>
        <span className="tabular-nums">max {formatTokens(max)}</span>
      </div>
      <div className="mt-0.5 flex h-7 items-end gap-px">
        {bars.map(({ d, u, v }) => (
          <button
            key={d}
            type="button"
            onClick={() => onPick(d)}
            data-usage-bar={d}
            title={`${shortDayLabel(d)}${d === today ? " (today)" : ""}: ${u ? usageLine(u.total) : "no usage"}`}
            aria-label={`${shortDayLabel(d)}: ${u ? usageLine(u.total) : "no usage"}`}
            className={cx("flex h-full min-w-0 flex-1 cursor-pointer items-end rounded-[2px] hover:bg-bg-hover", d === selected && "bg-bg-hover")}
          >
            <span className={cx("block w-full rounded-t-[1px]", d === today ? "bg-accent" : "bg-fg-muted/45")} style={{ height: v > 0 ? `${Math.max(6, (v / max) * 100)}%` : "0" }} />
          </button>
        ))}
      </div>
      <div className="flex gap-px pt-px" aria-hidden>
        {bars.map(({ d }) => (
          <span key={d} className="flex flex-1 justify-center">
            {d === today && <span className="h-1 w-1 rounded-full bg-accent" />}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The selected day's tokens: totals, the top projects with share bars, the models. Nothing without usage. */
function UsageBlock({ date, today, day, home, loading, onRefresh }: { date: Ymd; today: Ymd; day: UsageDay | undefined; home?: string; loading: boolean; onRefresh: () => void }) {
  if (!day || day.total.turns === 0) return null;
  const projects = topProjects(day, USAGE_TOP_PROJECTS);
  const max = projects.length > 0 ? inputTokens(projects[0].usage) : 0;
  const models = modelTurns(day);
  const modelsText = models.map((m) => `${m.model} ${m.turns}`).join(", ");
  return (
    <div data-usage-day={date}>
      <SectionHeader
        title={`Usage · ${date === today ? "today" : shortDayLabel(date)}`}
        actions={<IconButton icon={RefreshCw} title={loading ? "Refreshing usage..." : "Refresh usage"} onClick={onRefresh} disabled={loading} />}
      />
      <div className="px-3 text-xs text-fg tabular-nums" data-usage-line="">
        {usageLine(day.total)}
      </div>
      <div className="flex flex-col gap-1 px-3 pt-1.5">
        {projects.map((p) => {
          const n = inputTokens(p.usage);
          return (
            <div key={p.project} className="min-w-0" title={`${p.project || "Unknown project"}: ${usageLine(p.usage)}`} data-usage-project={p.project}>
              <div className="flex min-w-0 items-baseline gap-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate text-fg">{p.project ? projectLabel(p.project, home) : "unknown"}</span>
                <span className="shrink-0 text-fg-muted tabular-nums">{formatTokens(n)} in</span>
              </div>
              <div className="mt-0.5 h-0.5 w-full rounded-full bg-border/60">
                <div className="h-full rounded-full bg-accent" style={{ width: `${max > 0 ? Math.max(2, (n / max) * 100) : 0}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      {models.length > 0 && (
        <div className="truncate px-3 pt-1.5 text-[11px] text-fg-muted" title={`Turns per model: ${modelsText}`} data-usage-models="">
          models: {modelsText}
        </div>
      )}
    </div>
  );
}

export function CalendarPanel() {
  const toast = useToast();
  const config = useAtomValue(boardConfigAtom);
  // Without a connected project the plan layer works alone: no board tasks.
  const boardSnap = useAtomValue(snapshotAtom);
  const snap = config ? boardSnap : null;
  const tree = useAtomValue(treeAtom);
  const schedule = useAtomValue(scheduleAtom);
  const today = useAtomValue(todayAtom);
  const loading = useAtomValue(boardLoadingAtom);
  const home = usePaths()?.home;
  const now = useNow();
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState<Ymd>(today);
  const [activity, setActivity] = useState<Map<Ymd, DayActivity>>(new Map());
  const failing = useRef(false);
  const usageFailing = useRef(false);
  const usage = useAtomValue(usageDaysAtom);
  const usageLoading = useAtomValue(usageLoadingAtom);
  /** The day whose Usage block shows: the last day opened or picked, else today. */
  const [picked, setPicked] = useState<Ymd | null>(null);
  const selected = picked ?? today;

  const items = useMemo(() => snap?.items ?? [], [snap]);
  const areas = useMemo(
    () =>
      areaOptions(
        snap,
        [...Object.values(schedule?.rhythm ?? {}), ...Object.values(schedule?.overrides ?? {})].map((p) => p.area),
        projectNames(tree ?? []),
      ),
    [snap, schedule, tree],
  );
  const month = monthOf(anchor);
  const weeks = useMemo(() => (view === "week" ? [weekGrid(anchor)] : monthGrid(monthOf(anchor))), [view, anchor]);
  const from = weeks[0][0];
  const to = weeks[weeks.length - 1][6];

  const strip = useMemo(() => stripDays(from, to, today), [from, to, today]);

  const loadUsageNow = useCallback(
    (silent: boolean, debounceMs?: number) => {
      const r = usageRange(from, to, today);
      loadUsage(r.from, r.to, debounceMs).then(
        () => (usageFailing.current = false),
        (e) => {
          if (!silent || !usageFailing.current) toast.error(e, "Could not read Claude usage");
          usageFailing.current = true;
        },
      );
    },
    [from, to, today, toast],
  );

  /** Activity and usage for the visible range (usage also covers the strip), loaded together. */
  const loadActivity = useCallback(
    (silent: boolean) => {
      scheduleIpc.activity(from, to).then(
        (days) => {
          failing.current = false;
          setActivity(mergeActivity(days));
        },
        (e) => {
          if (!silent || !failing.current) toast.error(e, "Could not read Claude activity");
          failing.current = true;
        },
      );
      loadUsageNow(silent);
    },
    [from, to, toast, loadUsageNow],
  );
  useEffect(() => {
    loadActivity(false);
    const t = window.setInterval(() => !document.hidden && loadActivity(true), ACTIVITY_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [loadActivity]);

  const { drag, handlers, justDragged } = useTaskDrag((item, day) => void setItemField(item.itemId, "scheduled", day));

  const openDay = (ymd: Ymd) => {
    if (justDragged.current) return;
    setPicked(ymd === today ? null : ymd);
    openSheet((close) => <DaySheet date={ymd} title={`${WEEKDAY_NAMES[weekdayIndex(ymd)]} ${ymd}`} areas={areas} close={close} />);
  };
  const openRhythm = () => openSheet((close) => <RhythmSheet areas={areas} close={close} />);
  const step = (n: number) =>
    setAnchor((a) => {
      if (view === "week") return addDays(a, 7 * n);
      const m = addMonths(monthOf(a), n);
      return `${m.year}-${String(m.month).padStart(2, "0")}-01`;
    });

  const loose = useMemo(() => unscheduledTasks(items), [items]);
  const label = view === "week" ? weekLabel(anchor) : monthLabel(month);
  const showsToday = weeks.some((w) => w.includes(today)) && (view === "week" || inMonth(today, month));

  return (
    <Panel
      title="Calendar"
      loading={loading}
      onRefresh={() => {
        void refreshBoard(true);
        loadActivity(false);
      }}
      actions={
        <>
          {config && <AsOf fetchedAt={snap?.fetchedAt} now={now} />}
          <IconButton icon={Repeat} title="Weekly rhythm" onClick={openRhythm} />
        </>
      }
    >
      <BoardNotice />
      <div className="flex items-center gap-1 px-3 pt-2">
        <div className="flex overflow-hidden rounded-ui border border-border" role="group" aria-label="View">
          {(["week", "month"] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cx("cursor-pointer px-2 py-0.5 text-[11px] font-medium capitalize", view === v ? "bg-accent/15 text-accent" : "text-fg-muted hover:text-fg")}
            >
              {v}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <IconButton icon={ChevronLeft} title={view === "week" ? "Previous week" : "Previous month"} onClick={() => step(-1)} />
        <Button
          variant="ghost"
          onClick={() => {
            setAnchor(today);
            setPicked(null);
          }}
          disabled={showsToday && picked === null}
          className="px-1.5"
        >
          Today
        </Button>
        <IconButton icon={ChevronRight} title={view === "week" ? "Next week" : "Next month"} onClick={() => step(1)} />
      </div>
      <div className="px-3 pt-1 text-xs font-medium text-fg" data-cal-label="">
        {label}
      </div>

      {view === "week" ? (
        <div className="flex flex-col gap-1 px-2 pt-1.5">
          {weeks[0].map((d) => (
            <WeekCell
              key={d}
              date={d}
              today={today}
              plan={dayPlan(schedule, d)}
              tasks={dayTasks(items, d)}
              activity={activity.get(d)}
              home={home}
              over={drag?.over === d}
              dragging={drag?.item.itemId ?? null}
              onOpen={() => openDay(d)}
              dragHandlers={handlers}
            />
          ))}
        </div>
      ) : (
        <div className="px-2 pt-1.5">
          <div className="grid grid-cols-7 gap-px pb-0.5">
            {WEEKDAY_SHORT.map((w) => (
              <span key={w} className="text-center text-[10px] font-medium text-fg-muted">
                {w.slice(0, 2)}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px">
            {weeks.flat().map((d) => (
              <MonthCell
                key={d}
                date={d}
                today={today}
                faded={!inMonth(d, month)}
                plan={dayPlan(schedule, d)}
                tasks={dayTasks(items, d)}
                activity={activity.get(d)}
                home={home}
                over={drag?.over === d}
                onOpen={() => openDay(d)}
                dragHandlers={handlers}
              />
            ))}
          </div>
        </div>
      )}

      <UsageStrip days={strip} usage={usage} today={today} selected={selected} onPick={(d) => setPicked(d === today ? null : d)} />
      <UsageBlock date={selected} today={today} day={usage.get(selected)} home={home} loading={usageLoading} onRefresh={() => loadUsageNow(false, 0)} />

      {!config ? (
        <NoBoardLine className="px-3 pt-2" />
      ) : (
        <>
          <SectionHeader title="Unscheduled" count={loose.length} />
          {loose.length === 0 ? (
            <EmptyState title="Nothing waiting for a date">Open tasks in Ready or In progress without a Scheduled date show here.</EmptyState>
          ) : (
            <>
              <p className="px-3 pb-1 text-[11px] text-fg-muted">Drag a task onto a day to schedule it.</p>
              {loose.map((t) => (
                <div
                  key={t.itemId}
                  {...handlers(t)}
                  data-drag-task={t.itemId}
                  className={cx("flex min-w-0 cursor-grab items-center gap-1.5 px-3 py-1 select-none hover:bg-bg-hover", drag?.item.itemId === t.itemId && "opacity-50")}
                  title={`${t.repo}#${t.number} ${t.title}`}
                >
                  <StatusDot item={t} />
                  <span className="min-w-0 flex-1 truncate text-xs text-fg">{t.title}</span>
                  {itemChip(t, config.hubRepo) && <Badge>{itemChip(t, config.hubRepo)}</Badge>}
                </div>
              ))}
            </>
          )}
        </>
      )}
      <div className="h-3" />

      {drag?.active && (
        <div className="pointer-events-none fixed z-50 max-w-[16rem] truncate rounded-ui border border-accent bg-bg-raised px-2 py-1 text-xs text-fg shadow-lg" style={{ left: drag.x + 10, top: drag.y + 10 }}>
          {drag.over ? `${drag.item.title} to ${shortDayLabel(drag.over)}` : drag.item.title}
        </div>
      )}
    </Panel>
  );
}

type DragHandlers = ReturnType<typeof useTaskDrag>["handlers"];
type Plan = ReturnType<typeof dayPlan>;

function AreaLabel({ plan, compact }: { plan: Plan; compact?: boolean }) {
  if (!plan.area) return compact ? null : <span className="text-[11px] text-fg-muted/60">no plan</span>;
  const fromRhythm = plan.source === "rhythm";
  return (
    <span
      className={cx("min-w-0 truncate", compact ? "text-[9px] leading-3" : "text-[11px]", fromRhythm ? "text-fg-muted" : "font-medium text-accent")}
      title={fromRhythm ? `${plan.area} (weekly rhythm)` : `${plan.area} (this day)`}
    >
      {plan.area}
    </span>
  );
}

function WeekCell({
  date,
  today,
  plan,
  tasks,
  activity,
  home,
  over,
  dragging,
  onOpen,
  dragHandlers,
}: {
  date: Ymd;
  today: Ymd;
  plan: Plan;
  tasks: BoardItem[];
  activity: DayActivity | undefined;
  home?: string;
  over: boolean;
  dragging: string | null;
  onOpen: () => void;
  dragHandlers: DragHandlers;
}) {
  const isToday = date === today;
  const past = date < today;
  const extra = tasks.length - MAX_CELL_TASKS;
  return (
    <div
      data-day={date}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cx(
        "cursor-pointer rounded-ui border px-2 py-1.5 transition-colors hover:bg-bg-hover",
        isToday ? "border-accent/70 bg-accent/5" : "border-border",
        over && "ring-2 ring-accent",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={cx("shrink-0 text-xs tabular-nums", isToday ? "font-semibold text-accent" : past ? "text-fg-muted" : "text-fg")}>{shortDayLabel(date)}</span>
        {isToday && <Badge tone="accent">today</Badge>}
        <span className="flex-1" />
        <AreaLabel plan={plan} />
      </div>
      {plan.source === "override" && plan.note && (
        <div className="truncate text-[11px] text-fg-muted" title={plan.note}>
          {plan.note}
        </div>
      )}
      {tasks.slice(0, MAX_CELL_TASKS).map((t) => (
        <div
          key={t.itemId}
          {...dragHandlers(t)}
          data-drag-task={t.itemId}
          className={cx("mt-0.5 flex min-w-0 cursor-grab items-center gap-1.5 select-none", dragging === t.itemId && "opacity-50")}
          title={`${t.repo}#${t.number} ${t.title} (${t.status ?? "no status"}). Drag to another day.`}
        >
          <StatusDot item={t} />
          <span className={cx("min-w-0 truncate text-xs", t.state === "closed" ? "text-fg-muted line-through" : "text-fg")}>{t.title}</span>
        </div>
      ))}
      {extra > 0 && <div className="mt-0.5 text-[11px] text-fg-muted">+{extra} more</div>}
      <ActivityStrip list={activity} home={home} />
    </div>
  );
}

function MonthCell({
  date,
  today,
  faded,
  plan,
  tasks,
  activity,
  home,
  over,
  onOpen,
  dragHandlers,
}: {
  date: Ymd;
  today: Ymd;
  faded: boolean;
  plan: Plan;
  tasks: BoardItem[];
  activity: DayActivity | undefined;
  home?: string;
  over: boolean;
  onOpen: () => void;
  dragHandlers: DragHandlers;
}) {
  const isToday = date === today;
  const day = Number(date.slice(8));
  const extra = tasks.length - MAX_CELL_TASKS;
  const tip = [
    `${WEEKDAY_NAMES[weekdayIndex(date)]} ${date}`,
    plan.area ? `Area: ${plan.area}${plan.source === "rhythm" ? " (weekly rhythm)" : ""}` : "No plan",
    ...(plan.source === "override" && plan.note ? [plan.note] : []),
    ...tasks.map((t) => `${t.status ?? "no status"}: ${t.title}`),
  ].join("\n");
  return (
    <div
      data-day={date}
      role="button"
      tabIndex={0}
      title={tip}
      onClick={onOpen}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cx(
        "flex min-h-[3.4rem] min-w-0 cursor-pointer flex-col gap-px overflow-hidden rounded-[4px] border p-0.5 hover:bg-bg-hover",
        isToday ? "border-accent/70 bg-accent/5" : "border-border",
        faded && "opacity-45",
        over && "ring-2 ring-accent",
      )}
    >
      <span className={cx("text-[10px] leading-3 tabular-nums", isToday ? "font-semibold text-accent" : "text-fg")}>{day}</span>
      <AreaLabel plan={plan} compact />
      {tasks.length > 0 && (
        <div className="flex flex-wrap items-center gap-px">
          {tasks.slice(0, MAX_CELL_TASKS).map((t) => (
            <span key={t.itemId} {...dragHandlers(t)} data-drag-task={t.itemId} className="cursor-grab p-px" title={`${t.title} (drag to another day)`}>
              <StatusDot item={t} className="h-1.5 w-1.5" />
            </span>
          ))}
          {extra > 0 && <span className="text-[9px] leading-3 text-fg-muted">+{extra}</span>}
        </div>
      )}
      <span className="flex-1" />
      <ActivityStrip list={activity} home={home} compact />
    </div>
  );
}
