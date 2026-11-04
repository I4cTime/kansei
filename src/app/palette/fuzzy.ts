// Fuzzy matching for the command palette (CONTRACT.md "Command palette",
// Matching and order). Pure; fuzzy.test.ts covers it.
//
// score(query, text): a case-insensitive subsequence match. 100 when `text`
// starts with `query`; otherwise the best placement of the query's characters,
// each worth +3 at a word start, +2 right after the previous matched
// character, +1 elsewhere, minus the gap count (characters skipped between two
// matched characters). null when a query character is missing.
import type { Command, CommandGroup } from "./commands";
import { PALETTE_RECENT_MAX } from "../prefs";

export const PREFIX_SCORE = 100;
/** Most rows a non-empty query shows. */
export const MAX_ROWS = 40;
/** Recent commands the empty query shows first (and prefs.paletteRecent keeps). */
export const RECENT_MAX = PALETTE_RECENT_MAX;
/** Rows per group for the empty query, except Tabs and Panels which are complete. */
export const EMPTY_GROUP_ROWS = 6;

export const GROUP_ORDER: CommandGroup[] = ["Tabs", "Panels", "Projects", "Sessions", "Board", "Themes"];

const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);

/** Position i starts a word: the first character, after a non-alphanumeric, or a lower-to-upper case change. */
function wordStarts(text: string): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const prev = i > 0 ? text[i - 1] : "";
    out.push(i === 0 || (isWordChar(c) && !isWordChar(prev)) || (isWordChar(prev) && c !== c.toLowerCase() && prev === prev.toLowerCase() && /\p{L}/u.test(prev)));
  }
  return out;
}

export function score(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return PREFIX_SCORE;
  const n = t.length;
  const m = q.length;
  if (m > n) return null;
  const ws = wordStarts(text);
  const NONE = -Infinity;
  // prev[j]: best score with the previous query character matched at j.
  let prev = new Array<number>(n).fill(NONE);
  for (let j = 0; j < n; j++) if (t[j] === q[0]) prev[j] = ws[j] ? 3 : 1;
  for (let i = 1; i < m; i++) {
    const cur = new Array<number>(n).fill(NONE);
    // best of prev[k] + k over k < j - 1 (a gap of j - k - 1 characters).
    let farBest = NONE;
    for (let j = 1; j < n; j++) {
      if (j >= 2 && prev[j - 2] !== NONE) farBest = Math.max(farBest, prev[j - 2] + (j - 2));
      if (t[j] !== q[i]) continue;
      let best = NONE;
      if (prev[j - 1] !== NONE) best = prev[j - 1] + (ws[j] ? 3 : 2);
      if (farBest !== NONE) best = Math.max(best, farBest - (j - 1) + (ws[j] ? 3 : 1));
      cur[j] = best;
    }
    prev = cur;
  }
  let out = NONE;
  for (const v of prev) out = Math.max(out, v);
  return out === NONE ? null : out;
}

/** Best score over the title and each keyword, or null when none matches. */
export function commandScore(query: string, c: Pick<Command, "title" | "keywords">): number | null {
  let best: number | null = null;
  for (const text of [c.title, ...(c.keywords ?? [])]) {
    const s = score(query, text);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

const groupIndex = (g: CommandGroup) => GROUP_ORDER.indexOf(g);

/**
 * The rows to show. A query: matches by score desc, then group order, then
 * title, at most MAX_ROWS. The empty query: the recent ids that still exist
 * (newest first, at most RECENT_MAX), then each group in order, Tabs and
 * Panels complete and the others cut to EMPTY_GROUP_ROWS, recent ones not
 * repeated.
 */
export function rank(commands: Command[], query: string, recent: string[] = []): Command[] {
  if (!query.trim()) {
    const byId = new Map(commands.map((c) => [c.id, c]));
    const first: Command[] = [];
    for (const id of recent) {
      const c = byId.get(id);
      if (c && !first.includes(c)) first.push(c);
      if (first.length >= RECENT_MAX) break;
    }
    const shown = new Set(first.map((c) => c.id));
    const rest: Command[] = [];
    for (const g of GROUP_ORDER) {
      const list = commands.filter((c) => c.group === g && !shown.has(c.id));
      rest.push(...(g === "Tabs" || g === "Panels" ? list : list.slice(0, EMPTY_GROUP_ROWS)));
    }
    return [...first, ...rest];
  }
  const scored: { c: Command; s: number }[] = [];
  for (const c of commands) {
    const s = commandScore(query, c);
    if (s !== null) scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s || groupIndex(a.c.group) - groupIndex(b.c.group) || a.c.title.localeCompare(b.c.title));
  return scored.slice(0, MAX_ROWS).map((x) => x.c);
}

/** `recent` with `id` moved to the front, capped at RECENT_MAX. */
export function pushRecent(recent: string[], id: string): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, RECENT_MAX);
}
