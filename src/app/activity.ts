// Tab status and context gauge (CONTRACT.md "Tab status and context gauge").
//
// The backend emits `tabs:activity` with what each tab's Claude session is
// doing (busy / waiting / idle from ~/.claude/sessions and `claude agents`)
// and its context size. This module adds the idle-after-busy rule: a session
// that goes from busy to idle shows as waiting ("turn finished") until its tab
// gets keyboard input or is the active tab while the window has focus. It also
// raises a desktop notification when a hidden tab starts waiting.
//
// Keyed by the tab's pty child pid (Tab.pid). Imports no tabs.ts or
// terminals.ts, which both call in here.
import { atom } from "jotai";
import { activity, pty, type TabActivity } from "../lib/ipc";
import { prefsAtom } from "./prefs";
import { store } from "./store";
import { activeKeyAtom, getTab, tabsAtom, updateTab, type Tab } from "./tabState";

export type { TabActivity } from "../lib/ipc";

/** What the gauge measures against once a session proved the extended window. */
export const EXTENDED_WINDOW = 1_000_000;
/** Tokens past which a session must be running with the extended window. */
export const STANDARD_WINDOW = 200_000;
export const TURN_FINISHED = "turn finished";

/** Per pid, after the idle-after-busy rule. */
export const activityAtom = atom<Record<number, TabActivity>>({});

// ---------------------------------------------------------------------------
// pure rules

export type Track = { sessionId: string; raw: TabActivity["status"]; unseen: boolean };

/**
 * Advance the per-pid tracks with a new backend list. A session going from
 * busy (or waiting) to idle becomes unseen unless `seenNow(pid)`; busy or
 * waiting again clears it; a new session id on the pid starts fresh. Pids
 * missing from `raw` are dropped.
 */
export function stepTracks(tracks: Map<number, Track>, raw: TabActivity[], seenNow: (pid: number) => boolean): void {
  const live = new Set<number>();
  for (const a of raw) {
    live.add(a.pid);
    const prev = tracks.get(a.pid);
    if (!prev || prev.sessionId !== a.sessionId) {
      tracks.set(a.pid, { sessionId: a.sessionId, raw: a.status, unseen: false });
      continue;
    }
    if (a.status !== "idle") prev.unseen = false;
    else if (prev.raw !== "idle") prev.unseen = !seenNow(a.pid);
    prev.raw = a.status;
  }
  for (const pid of [...tracks.keys()]) if (!live.has(pid)) tracks.delete(pid);
}

/** The backend list with unseen idle sessions shown as waiting ("turn finished"). */
export function derive(raw: TabActivity[], tracks: Map<number, Track>): Record<number, TabActivity> {
  const out: Record<number, TabActivity> = {};
  for (const a of raw) {
    const unseen = a.status === "idle" && tracks.get(a.pid)?.unseen === true;
    out[a.pid] = unseen ? { ...a, status: "waiting", waitingFor: TURN_FINISHED } : a;
  }
  return out;
}

/** Pids that just turned waiting while hidden (not the active tab, or the window unfocused). */
export function newlyWaiting(
  prev: Record<number, TabActivity>,
  next: Record<number, TabActivity>,
  hidden: (pid: number) => boolean,
): number[] {
  return Object.values(next)
    .filter((a) => a.status === "waiting" && prev[a.pid]?.status !== "waiting" && hidden(a.pid))
    .map((a) => a.pid);
}

/** Keyboard input versus what xterm answers on its own (reports, focus events). */
export function isTerminalReport(data: string): boolean {
  return (
    /^\x1b\[\d+;\d+R$/.test(data) || // cursor position
    /^\x1b\[[?>=]?[\d;]*c$/.test(data) || // device attributes
    /^\x1b\[[IO]$/.test(data) || // focus in / out
    /^\x1b\[\??[\d;]*\$y$/.test(data) || // mode report
    /^\x1b\[[\d;]*t$/.test(data) || // window reports
    /^\x1b\][\s\S]*(\x07|\x1b\\)$/.test(data) || // OSC replies (colours)
    /^\x1bP[\s\S]*\x1b\\$/.test(data) // DCS replies
  );
}

/** "123k", "1M", "1.5M", or the number itself below 1000. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = Math.round(n / 1000);
  if (k < 1000) return `${k}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

export type Gauge = {
  tokens: number;
  window: number;
  /** True when the window is the extended one because the session went past 200k. */
  extended: boolean;
  /** 0..1, clamped. */
  fraction: number;
  percent: number;
  tone: "ok" | "warn" | "danger";
  title: string;
};

/** The gauge for an activity, or null while it has no context yet. */
export function gaugeFor(a: TabActivity | null | undefined, prefWindow: number, extended: boolean): Gauge | null {
  if (!a?.context) return null;
  const { tokens, model } = a.context;
  const window = extended ? Math.max(prefWindow, EXTENDED_WINDOW) : prefWindow;
  const percent = Math.round((tokens / window) * 100);
  const tone = percent < 70 ? "ok" : percent <= 90 ? "warn" : "danger";
  const head = `${formatTokens(tokens)} of ${formatTokens(window)} tokens (${percent} %)${model ? `, ${model}` : ""}`;
  const note = extended
    ? `Window ${formatTokens(window)}: this session went past ${formatTokens(STANDARD_WINDOW)}`
    : `Window ${formatTokens(window)} from Settings`;
  return { tokens, window, extended, fraction: Math.min(1, tokens / window), percent, tone, title: `${head}\n${note}` };
}

export type DotLook = "busy" | "waiting" | "idle" | "dead" | "spawning";

/** The tab rail dot: process state first, then the Claude session's. None for a running tab without a session. */
export function dotFor(tab: Pick<Tab, "status">, a: TabActivity | null | undefined): { look: DotLook; title: string } | null {
  if (tab.status === "dead") return { look: "dead", title: "Exited" };
  if (tab.status === "spawning") return { look: "spawning", title: "Starting" };
  if (!a) return null;
  if (a.status === "busy") return { look: "busy", title: "Busy" };
  if (a.status === "waiting") return { look: "waiting", title: a.waitingFor ? `Waiting: ${a.waitingFor}` : "Waiting" };
  return { look: "idle", title: "Idle" };
}

// ---------------------------------------------------------------------------
// live state

const tracks = new Map<number, Track>();
let raw: TabActivity[] = [];
/** Session ids whose tokens ever went past STANDARD_WINDOW. */
const extendedSessions = new Set<string>();

/** The activity of a tab, from the current atom value unless one is given. */
export function tabActivity(tab: Pick<Tab, "pid"> | null | undefined, map = store.get(activityAtom)): TabActivity | null {
  return tab?.pid != null ? (map[tab.pid] ?? null) : null;
}

/** True once this session went past 200k tokens (the gauge then uses the extended window). */
export function isExtended(sessionId: string): boolean {
  return extendedSessions.has(sessionId);
}

function tabByPid(pid: number): Tab | undefined {
  return store.get(tabsAtom).find((t) => t.pid === pid);
}

/** The pid's tab is the active tab and the window has focus. */
function inView(pid: number): boolean {
  const tab = tabByPid(pid);
  return !!tab && tab.key === store.get(activeKeyAtom) && document.hasFocus();
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function publish() {
  const prev = store.get(activityAtom);
  const next = derive(raw, tracks);
  store.set(activityAtom, next);
  if (!store.get(prefsAtom).notifyWaiting) return;
  for (const pid of newlyWaiting(prev, next, (p) => !inView(p))) {
    const tab = tabByPid(pid);
    if (!tab) continue;
    const reason = next[pid].waitingFor;
    activity.notify({ title: tab.title, body: reason ? capitalize(reason) : "Waiting for you" }).catch(() => {});
  }
}

function onList(list: TabActivity[]) {
  raw = list;
  for (const a of list) if (a.context && a.context.tokens > STANDARD_WINDOW) extendedSessions.add(a.sessionId);
  stepTracks(tracks, list, inView);
  publish();
}

/** The tab was seen: an unseen finished turn becomes plain idle. */
export function markTabSeen(key: string) {
  const pid = getTab(key)?.pid;
  const t = pid != null ? tracks.get(pid) : undefined;
  if (!t?.unseen) return;
  t.unseen = false;
  publish();
}

/** Keyboard input from terminals.ts; terminal reports do not count. */
export function noteTabInput(key: string, data: string) {
  if (!isTerminalReport(data)) markTabSeen(key);
}

let started: Promise<void> | null = null;
/** Subscribe to tabs:activity; fill Tab.pid from pty_list for tabs that lack it. */
export function startActivity(): Promise<void> {
  if (started) return started;
  started = (async () => {
    await activity.onChange(onList);
    const seeActive = () => {
      const key = store.get(activeKeyAtom);
      if (key && document.hasFocus()) markTabSeen(key);
    };
    store.sub(activeKeyAtom, seeActive);
    window.addEventListener("focus", seeActive);
    try {
      const ptys = await pty.list();
      for (const t of store.get(tabsAtom)) {
        const p = t.id && t.pid == null ? ptys.find((x) => x.id === t.id && x.alive) : undefined;
        if (p && typeof p.pid === "number") updateTab(t.key, { pid: p.pid });
      }
    } catch {
      // Spawns set the pid anyway.
    }
  })().catch((e) => {
    started = null;
    throw e;
  });
  return started;
}
