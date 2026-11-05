// Split terminal (CONTRACT.md "Split terminal"): two tabs side by side.
//
// The left pane always shows the active tab (activeKeyAtom); the right pane
// shows `splitAtom.right`. The two are never the same tab: activating the right
// tab swaps it into the left (swapIntoLeft). The pure helpers take keys and the
// split value so split.test.ts feeds fixtures; the live commands at the bottom
// read and write the store. Imports only tabState and store (tabs.ts and
// activity.ts call in here).
import { atom } from "jotai";
import { store, toastInfo } from "./store";
import { activeKeyAtom, tabsAtom } from "./tabState";

/** right = tab key on the right pane, ratio = the left pane's width share (MIN_RATIO..MAX_RATIO). */
export type Split = { right: string | null; ratio: number };
export type Pane = "left" | "right";

export const MIN_RATIO = 0.3;
export const MAX_RATIO = 0.7;
export const DEFAULT_RATIO = 0.5;
export const NO_SPLIT: Split = { right: null, ratio: DEFAULT_RATIO };

export const splitAtom = atom<Split>(NO_SPLIT);
/** The pane that last received a mouse down or keyboard focus; "left" while unsplit. */
export const focusedPaneAtom = atom<Pane>("left");
/** The tab being dragged from the rail (HTML5 drag), for the terminal area's drop zone. */
export const draggedTabAtom = atom<string | null>(null);

// ---------------------------------------------------------------------------
// pure rules

export function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return DEFAULT_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

/** The right pane's tab when it is valid: an existing tab that is not the active one. */
export function effectiveRight(split: Split, keys: string[], active: string | null): string | null {
  const r = split.right;
  return r !== null && r !== active && keys.includes(r) ? r : null;
}

/**
 * Activating `next` while `prev` is active. The right tab swaps into the left
 * and the previous active tab moves to the right; any other tab replaces the
 * left pane only.
 */
export function swapIntoLeft(split: Split, prev: string | null, next: string | null): Split {
  if (split.right === null || next !== split.right) return split;
  return { ...split, right: prev !== null && prev !== next ? prev : null };
}

/** Closing `key` closes the right pane when it is the right tab. */
export function afterClose(split: Split, key: string): Split {
  return split.right === key ? { ...split, right: null } : split;
}

/**
 * The tab to activate when the active tab at `idx` closes (`rest` = the keys
 * left after it). As without a split (the tab now at idx, else the one before)
 * but skipping the right tab, which keeps its pane; when only the right tab is
 * left it becomes the active tab and the split ends.
 */
export function nextActiveAfterClose(rest: string[], idx: number, split: Split): { active: string | null; split: Split } {
  const right = split.right;
  const others = rest.filter((k) => k !== right);
  const before = rest.slice(0, idx).filter((k) => k !== right).length;
  const next = others[before] ?? others[before - 1] ?? null;
  if (next) return { active: next, split };
  const fallback = right !== null && rest.includes(right) ? right : (rest[idx] ?? rest[idx - 1] ?? null);
  return { active: fallback, split: { ...split, right: null } };
}

/** The tab after `active` in rail order (wrapping), or null with fewer than two tabs. */
export function nextInOrder(keys: string[], active: string | null): string | null {
  if (keys.length < 2) return null;
  const i = active ? keys.indexOf(active) : -1;
  if (i < 0) return keys.find((k) => k !== active) ?? null;
  return keys[(i + 1) % keys.length];
}

/**
 * Put `key` on the right pane. For the active tab, another tab takes the left:
 * the current right tab (a swap) or the next one in rail order.
 */
export function splitWithState(keys: string[], active: string | null, split: Split, key: string): { active: string | null; split: Split } {
  if (!keys.includes(key)) return { active, split };
  if (active === null) return { active: key, split };
  if (key !== active) return { active, split: { ...split, right: key } };
  const other = effectiveRight(split, keys, active) ?? nextInOrder(keys, active);
  if (!other) return { active, split };
  return { active: other, split: { ...split, right: key } };
}

/** Unsplit when split, else split with the next tab in rail order. */
export function toggleState(keys: string[], active: string | null, split: Split): Split {
  if (effectiveRight(split, keys, active)) return { ...split, right: null };
  const next = nextInOrder(keys, active);
  return next ? { ...split, right: next } : split;
}

// ---------------------------------------------------------------------------
// tabs.json: `split: { right: <index into tabs> | null, ratio }`

export type SplitFile = { right: number | null; ratio: number };

export function splitToFile(split: Split, keys: string[], active: string | null): SplitFile {
  const right = effectiveRight(split, keys, active);
  return { right: right ? keys.indexOf(right) : null, ratio: clampRatio(split.ratio) };
}

/** Out of range, not an integer, or equal to the active index = no split. A missing ratio is 0.5. */
export function splitFromFile(raw: unknown, keys: string[], activeIndex: number): Split {
  const o = raw && typeof raw === "object" ? (raw as Partial<Record<keyof SplitFile, unknown>>) : {};
  const ratio = typeof o.ratio === "number" ? clampRatio(o.ratio) : DEFAULT_RATIO;
  const i = o.right;
  const ok = typeof i === "number" && Number.isInteger(i) && i >= 0 && i < keys.length && i !== activeIndex;
  return { right: ok ? keys[i] : null, ratio };
}

// ---------------------------------------------------------------------------
// live commands

function keysNow(): string[] {
  return store.get(tabsAtom).map((t) => t.key);
}

/**
 * Make `next` the active tab, applying swapIntoLeft. Every activation in
 * tabs.ts goes through here.
 */
export function setActiveKey(next: string | null) {
  const prev = store.get(activeKeyAtom);
  const split = swapIntoLeft(store.get(splitAtom), prev, next);
  store.set(activeKeyAtom, next);
  setSplit(split);
}

function setSplit(next: Split) {
  if (next.right === null) store.set(focusedPaneAtom, "left");
  const cur = store.get(splitAtom);
  if (cur.right !== next.right || cur.ratio !== next.ratio) store.set(splitAtom, next);
}

/** Show `key` on the right pane (see splitWithState). */
export function splitWith(key: string) {
  const active = store.get(activeKeyAtom);
  const r = splitWithState(keysNow(), active, store.get(splitAtom), key);
  if (r.active !== active) store.set(activeKeyAtom, r.active);
  setSplit(r.split);
}

export function unsplit() {
  setSplit({ ...store.get(splitAtom), right: null });
}

/** Ctrl+Shift+\: unsplit, or split with the next tab in rail order. */
export function toggleSplit() {
  const keys = keysNow();
  const active = store.get(activeKeyAtom);
  const split = store.get(splitAtom);
  if (!effectiveRight(split, keys, active) && !nextInOrder(keys, active)) {
    toastInfo("Open a second tab to split");
    return;
  }
  setSplit(toggleState(keys, active, split));
}

/** The left pane's width share, clamped to MIN_RATIO..MAX_RATIO. */
export function setRatio(r: number) {
  setSplit({ ...store.get(splitAtom), ratio: clampRatio(r) });
}

/** The right pane's tab right now, or null while unsplit. */
export function rightKey(): string | null {
  return effectiveRight(store.get(splitAtom), keysNow(), store.get(activeKeyAtom));
}
