// Calendar model (CONTRACT.md "Board and Calendar"): local dates as
// "YYYY-MM-DD" strings, week and month grids (Monday first), the day's plan
// (an override wins over the weekly rhythm), the tasks of a day and the
// per-day activity from history.jsonl. Pure helpers plus the atoms the shell
// reads (Sidebar Today strip, Projects today chip).
import { atom } from "jotai";
import type { ActivityDay, BoardItem, DayPlan, Schedule, WeekdayKey } from "../../lib/ipc";

export type Ymd = string;

export const WEEKDAY_KEYS: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_MS = 86_400_000;

const pad = (n: number) => String(n).padStart(2, "0");

export function isYmd(s: unknown): s is Ymd {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Days since 1970-01-01 (calendar maths in UTC, so DST never shifts a day). */
function toDays(ymd: Ymd): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDays(days: number): Ymd {
  const t = new Date(days * DAY_MS);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** The local calendar date of `now`. */
export function todayYmd(now: Date = new Date()): Ymd {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(ymd: Ymd, n: number): Ymd {
  return fromDays(toDays(ymd) + n);
}

export function daysBetween(a: Ymd, b: Ymd): number {
  return toDays(b) - toDays(a);
}

/** 0 = Monday .. 6 = Sunday. */
export function weekdayIndex(ymd: Ymd): number {
  return (((toDays(ymd) + 3) % 7) + 7) % 7;
}

export function weekdayKey(ymd: Ymd): WeekdayKey {
  return WEEKDAY_KEYS[weekdayIndex(ymd)];
}

export function startOfWeek(ymd: Ymd): Ymd {
  return addDays(ymd, -weekdayIndex(ymd));
}

/** Monday to Sunday of the week containing `ymd`. */
export function weekGrid(ymd: Ymd): Ymd[] {
  const mon = startOfWeek(ymd);
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
}

export type YearMonth = { year: number; month: number }; // month 1..12

export function monthOf(ymd: Ymd): YearMonth {
  const [year, month] = ymd.split("-").map(Number);
  return { year, month };
}

export function addMonths({ year, month }: YearMonth, n: number): YearMonth {
  const i = year * 12 + (month - 1) + n;
  return { year: Math.floor(i / 12), month: (((i % 12) + 12) % 12) + 1 };
}

/** Whole weeks (Monday first) covering the month: 4 to 6 rows of 7 dates. */
export function monthGrid({ year, month }: YearMonth): Ymd[][] {
  const first = `${year}-${pad(month)}-01`;
  const next = addMonths({ year, month }, 1);
  const last = addDays(`${next.year}-${pad(next.month)}-01`, -1);
  const rows: Ymd[][] = [];
  for (let start = startOfWeek(first); toDays(start) <= toDays(last); start = addDays(start, 7)) rows.push(weekGrid(start));
  return rows;
}

export function inMonth(ymd: Ymd, ym: YearMonth): boolean {
  const m = monthOf(ymd);
  return m.year === ym.year && m.month === ym.month;
}

export function monthLabel({ year, month }: YearMonth): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** "Mon 3 Nov". */
export function shortDayLabel(ymd: Ymd): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${WEEKDAY_SHORT[weekdayIndex(ymd)]} ${d} ${MONTH_NAMES[m - 1].slice(0, 3)}`;
}

/** "26 Oct to 1 Nov 2026". */
export function weekLabel(ymd: Ymd): string {
  const days = weekGrid(ymd);
  const f = (s: Ymd) => {
    const [, m, d] = s.split("-").map(Number);
    return `${d} ${MONTH_NAMES[m - 1].slice(0, 3)}`;
  };
  return `${f(days[0])} to ${f(days[6])} ${days[6].slice(0, 4)}`;
}

// ---------------------------------------------------------------------------
// Schedule

const EMPTY_PLAN: DayPlan = { area: null, note: "" };

export function emptySchedule(): Schedule {
  return { rhythm: { mon: EMPTY_PLAN, tue: EMPTY_PLAN, wed: EMPTY_PLAN, thu: EMPTY_PLAN, fri: EMPTY_PLAN, sat: EMPTY_PLAN, sun: EMPTY_PLAN }, overrides: {} };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function cleanPlan(v: unknown): DayPlan {
  const r = isObj(v) ? v : {};
  const area = typeof r.area === "string" && r.area.trim() ? r.area.trim() : null;
  const note = typeof r.note === "string" ? r.note.replace(/\s+/g, " ").trim() : "";
  return { area, note };
}

/** Coerce unknown JSON into a Schedule (the backend already sanitises; this guards the UI). */
export function sanitizeSchedule(raw: unknown): Schedule {
  const r = isObj(raw) ? raw : {};
  const rhythm = isObj(r.rhythm) ? r.rhythm : {};
  const out = emptySchedule();
  for (const k of WEEKDAY_KEYS) out.rhythm[k] = cleanPlan(rhythm[k]);
  if (isObj(r.overrides)) for (const [k, v] of Object.entries(r.overrides)) if (isYmd(k)) out.overrides[k] = cleanPlan(v);
  return out;
}

export type Plan = DayPlan & { source: "override" | "rhythm" };

/** The plan for a day: the override when there is one, else the weekly rhythm. */
export function dayPlan(schedule: Schedule | null, ymd: Ymd): Plan {
  if (!schedule) return { ...EMPTY_PLAN, source: "rhythm" };
  const o = schedule.overrides[ymd];
  if (o) return { area: o.area, note: o.note, source: "override" };
  return { area: schedule.rhythm[weekdayKey(ymd)]?.area ?? null, note: "", source: "rhythm" };
}

/** Today's plan (same precedence: override over rhythm). */
export const todayPlan = (schedule: Schedule | null, today: Ymd) => dayPlan(schedule, today);

/**
 * The schedule with `plan` as the override for `ymd`. An override that says
 * what the rhythm says (same area, no note) is removed instead; `null` removes it.
 */
export function withOverride(schedule: Schedule, ymd: Ymd, plan: DayPlan | null): Schedule {
  const overrides = { ...schedule.overrides };
  const p = plan ? cleanPlan(plan) : null;
  const rhythm = schedule.rhythm[weekdayKey(ymd)];
  if (!p || (p.note === "" && p.area === (rhythm?.area ?? null))) delete overrides[ymd];
  else overrides[ymd] = p;
  return { ...schedule, overrides };
}

export function withRhythm(schedule: Schedule, rhythm: Record<WeekdayKey, DayPlan>): Schedule {
  const r = { ...schedule.rhythm };
  for (const k of WEEKDAY_KEYS) r[k] = cleanPlan(rhythm[k]);
  return { ...schedule, rhythm: r };
}

// ---------------------------------------------------------------------------
// Tasks per day

const LANE_ORDER = ["Backlog", "Ready", "In progress", "In review", "Done"];
const laneRank = (i: BoardItem) => {
  const r = i.status ? LANE_ORDER.indexOf(i.status) : -1;
  return r < 0 ? (i.state === "closed" ? 4 : 0) : r;
};

export function byLaneThenTitle(a: BoardItem, b: BoardItem): number {
  return laneRank(a) - laneRank(b) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.number - b.number;
}

/** Items scheduled on `ymd`, by lane then title. */
export function dayTasks(items: BoardItem[], ymd: Ymd): BoardItem[] {
  return items.filter((i) => i.scheduled === ymd).sort(byLaneThenTitle);
}

/** Open tasks not in Done, for "Schedule a task" (by lane then title). */
export function schedulableTasks(items: BoardItem[]): BoardItem[] {
  return items.filter((i) => i.kind !== "Epic" && i.state === "open" && i.status !== "Done").sort(byLaneThenTitle);
}

/** Open tasks in Ready or In progress without a date (the Unscheduled tray). */
export function unscheduledTasks(items: BoardItem[]): BoardItem[] {
  return items.filter((i) => i.kind !== "Epic" && i.state === "open" && !i.scheduled && (i.status === "Ready" || i.status === "In progress")).sort(byLaneThenTitle);
}

// ---------------------------------------------------------------------------
// Activity

export type DayActivity = { project: string; count: number }[];

/** Per date, the projects with prompts that day, most prompts first. Later days in `days` win on duplicates. */
export function mergeActivity(days: ActivityDay[]): Map<Ymd, DayActivity> {
  const out = new Map<Ymd, DayActivity>();
  for (const d of days) {
    const list = Object.entries(d.projects)
      .filter(([, n]) => n > 0)
      .map(([project, count]) => ({ project, count }))
      .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project));
    out.set(d.date, list);
  }
  return out;
}

/** A stable colour for a project's activity dot, from the terminal palette tokens. */
const DOT_COLOURS = ["var(--t-blue)", "var(--t-magenta)", "var(--t-cyan)", "var(--t-green)", "var(--t-yellow)", "var(--t-red)"];
export function projectColour(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) | 0;
  return DOT_COLOURS[Math.abs(h) % DOT_COLOURS.length];
}

// ---------------------------------------------------------------------------
// Atoms

/** schedule.json; null until read. */
export const scheduleAtom = atom<Schedule | null>(null);
/** The local date, updated by the shell's clock (rolls over at midnight). */
export const todayAtom = atom<Ymd>(todayYmd());
