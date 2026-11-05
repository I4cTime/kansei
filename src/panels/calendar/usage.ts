// Usage (CONTRACT.md "Usage", Front end): tokens per day, project and model
// from the usage index. Loads refresh the index first, are debounced (the
// Calendar asks together with its activity load: same range, same interval)
// and merge into one map shared by the Calendar and the Today strip. Pure
// helpers for sums, the cache hit share and k/M formatting.
import { atom } from "jotai";
import { usage, type IndexStatus, type UsageBucket, type UsageDay } from "../../lib/ipc";
import { store } from "../../app/store";
import { addDays, type Ymd } from "./model";

/** Days in the Calendar's usage strip. */
export const USAGE_STRIP_DAYS = 14;
/** Project rows in a day's Usage block. */
export const USAGE_TOP_PROJECTS = 5;
/** Loads asked for within this window collapse into the last one. */
export const USAGE_DEBOUNCE_MS = 250;
/** The Calendar's activity and usage interval; also how old today's usage may get. */
export const USAGE_REFRESH_MS = 5 * 60_000;

export const EMPTY_BUCKET: UsageBucket = { turns: 0, input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };

/** Loaded days by date, merged across loads. A day without turns is absent. */
export const usageDaysAtom = atom<Map<Ymd, UsageDay>>(new Map());
/** The last usage_refresh result and when it finished (epoch ms); null before the first this run. */
export const usageStatusAtom = atom<{ status: IndexStatus; at: number } | null>(null);
/** True while a load (refresh plus read) runs. */
export const usageLoadingAtom = atom(false);

// ---------------------------------------------------------------------------
// Pure helpers

export function sumBuckets(list: UsageBucket[]): UsageBucket {
  const out = { ...EMPTY_BUCKET };
  for (const b of list) {
    out.turns += b.turns;
    out.input += b.input;
    out.cacheCreate += b.cacheCreate;
    out.cacheRead += b.cacheRead;
    out.output += b.output;
  }
  return out;
}

/** Tokens sent to the model: fresh input plus cache writes plus cache reads. */
export function inputTokens(b: UsageBucket): number {
  return b.input + b.cacheCreate + b.cacheRead;
}

/** Cache hit share, cacheRead / (input + cacheCreate + cacheRead), as a whole percentage; null without input. */
export function cacheShare(b: UsageBucket): number | null {
  const all = inputTokens(b);
  return all > 0 ? Math.round((b.cacheRead / all) * 100) : null;
}

/** "940", "1.2k", "86k", "1.2M", "86M", "1.2B". */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (let i = 0; i < units.length; i++) {
    const [size, unit] = units[i];
    if (v < size) continue;
    const x = v / size;
    // One decimal under 10, whole numbers above; a rounded 1000 becomes 1 of the next unit.
    const text = x < 10 ? (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, "") : String(Math.round(x));
    if (Number(text) >= 1000 && i > 0) return `1${units[i - 1][1]}`;
    return `${text}${unit}`;
  }
  return String(v);
}

/** "1.2M in · 86k out · 94 % cache · 41 turns". */
export function usageLine(b: UsageBucket): string {
  const share = cacheShare(b);
  return [`${formatTokens(inputTokens(b))} in`, `${formatTokens(b.output)} out`, ...(share === null ? [] : [`${share} % cache`]), `${b.turns} ${b.turns === 1 ? "turn" : "turns"}`].join(" · ");
}

export type ProjectUsage = { project: string; usage: UsageBucket };

/** The day's projects with the most tokens in, at most `n`. */
export function topProjects(day: UsageDay | undefined, n: number): ProjectUsage[] {
  if (!day) return [];
  return Object.entries(day.projects)
    .map(([project, usage]) => ({ project, usage }))
    .filter((p) => p.usage.turns > 0)
    .sort((a, b) => inputTokens(b.usage) - inputTokens(a.usage) || a.project.localeCompare(b.project))
    .slice(0, Math.max(0, n));
}

/** The day's models by turns, most first. */
export function modelTurns(day: UsageDay | undefined): { model: string; turns: number }[] {
  if (!day) return [];
  return Object.entries(day.models)
    .map(([model, b]) => ({ model, turns: b.turns }))
    .filter((m) => m.turns > 0)
    .sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model));
}

/**
 * The strip's days for a visible range: USAGE_STRIP_DAYS days ending today
 * when the range reaches today, else ending on the range's last day.
 */
export function stripDays(from: Ymd, to: Ymd, today: Ymd): Ymd[] {
  const end = from <= today && today <= to ? today : to;
  return Array.from({ length: USAGE_STRIP_DAYS }, (_, i) => addDays(end, i - USAGE_STRIP_DAYS + 1));
}

/** The range to load for a visible range: the range itself plus its strip. */
export function usageRange(from: Ymd, to: Ymd, today: Ymd): { from: Ymd; to: Ymd } {
  const strip = stripDays(from, to, today);
  return { from: strip[0] < from ? strip[0] : from, to };
}

/** `prev` with the days of `from`..`to` replaced by `days` (days outside the range are kept). */
export function mergeUsage(prev: Map<Ymd, UsageDay>, from: Ymd, to: Ymd, days: UsageDay[]): Map<Ymd, UsageDay> {
  const out = new Map<Ymd, UsageDay>();
  for (const [d, u] of prev) if (d < from || d > to) out.set(d, u);
  for (const d of days) if (d.total.turns > 0) out.set(d.date, d);
  return out;
}

// ---------------------------------------------------------------------------
// Loading

export type UsageLoad = { status: IndexStatus; days: UsageDay[] };
type Waiter = { resolve: (r: UsageLoad) => void; reject: (e: unknown) => void };

let timer: ReturnType<typeof setTimeout> | null = null;
let queued: { from: Ymd; to: Ymd } | null = null;
let waiters: Waiter[] = [];
let chain: Promise<unknown> = Promise.resolve();
let lastLoad: { from: Ymd; to: Ymd; at: number } | null = null;

async function run(from: Ymd, to: Ymd): Promise<UsageLoad> {
  store.set(usageLoadingAtom, true);
  try {
    const status = await usage.refresh();
    store.set(usageStatusAtom, { status, at: Date.now() });
    const days = await usage.days(from, to);
    store.set(usageDaysAtom, mergeUsage(store.get(usageDaysAtom), from, to, days));
    lastLoad = { from, to, at: Date.now() };
    return { status, days };
  } finally {
    store.set(usageLoadingAtom, false);
  }
}

function flush() {
  timer = null;
  const req = queued;
  const ws = waiters;
  queued = null;
  waiters = [];
  if (!req) return;
  // One load at a time: a load asked for while one runs waits for it.
  const p = chain.then(() => run(req.from, req.to));
  chain = p.catch(() => {});
  p.then(
    (r) => ws.forEach((w) => w.resolve(r)),
    (e) => ws.forEach((w) => w.reject(e)),
  );
}

/**
 * Refresh the usage index, then read `from`..`to` into usageDaysAtom. Calls
 * within `debounceMs` collapse into the last one, and every caller gets its
 * result. Rejects when the refresh or the read fails.
 */
export function loadUsage(from: Ymd, to: Ymd, debounceMs = USAGE_DEBOUNCE_MS): Promise<UsageLoad> {
  return new Promise<UsageLoad>((resolve, reject) => {
    queued = { from, to };
    waiters.push({ resolve, reject });
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, debounceMs));
  });
}

/** True when no load covering `day` finished in the last `maxAgeMs`. */
export function usageIsStale(day: Ymd, now = Date.now(), maxAgeMs = USAGE_REFRESH_MS): boolean {
  return !lastLoad || day < lastLoad.from || day > lastLoad.to || now - lastLoad.at > maxAgeMs;
}
