// Session search (CONTRACT.md "Session search", Front end): the transcript
// index status shared by the Sessions panel, the palette and the dev driver,
// the refresh that keeps it fresh, and pure helpers for snippets and queries.
import { atom } from "jotai";
import { search, type IndexStatus, type SearchHit } from "../../lib/ipc";
import { store } from "../../app/store";

/** Queries from this many characters on also search the transcripts. */
export const MIN_QUERY = 3;
/** Debounce before a transcript query runs. */
export const QUERY_DEBOUNCE_MS = 250;
/** An index older than this is refreshed before the next query. */
export const INDEX_MAX_AGE_MS = 60_000;

export const MARK_START = "\u0001";
export const MARK_END = "\u0002";

/** The last refresh's result and when it finished (epoch ms); null before the first this run. */
export const indexStatusAtom = atom<{ status: IndexStatus; at: number } | null>(null);
/** True while a refresh runs. */
export const indexingAtom = atom(false);

let pending: Promise<IndexStatus> | null = null;

/** Refresh the index now (a refresh already running is shared, not doubled). */
export function refreshIndex(): Promise<IndexStatus> {
  if (pending) return pending;
  store.set(indexingAtom, true);
  pending = search
    .refresh()
    .then((status) => {
      store.set(indexStatusAtom, { status, at: Date.now() });
      return status;
    })
    .finally(() => {
      pending = null;
      store.set(indexingAtom, false);
    });
  return pending;
}

/** True when the index has not been refreshed this run or is older than INDEX_MAX_AGE_MS. */
export function indexIsStale(state: { at: number } | null, now: number): boolean {
  return !state || now - state.at > INDEX_MAX_AGE_MS;
}

/** Start a refresh when the index is stale; resolves at once otherwise. Errors reject. */
export function ensureFreshIndex(now = Date.now()): Promise<IndexStatus | null> {
  if (pending) return pending;
  return indexIsStale(store.get(indexStatusAtom), now) ? refreshIndex() : Promise.resolve(null);
}

/** Whether a query is long enough to search the transcripts. */
export function wantsTranscripts(query: string): boolean {
  return query.trim().length >= MIN_QUERY;
}

export type SnippetPart = { text: string; mark: boolean };

/** Split a snippet at its match marks; an unclosed mark runs to the end. */
export function snippetParts(snippet: string): SnippetPart[] {
  const out: SnippetPart[] = [];
  let mark = false;
  let buf = "";
  const flush = () => {
    if (buf) out.push({ text: buf, mark });
    buf = "";
  };
  for (const ch of snippet) {
    if (ch === MARK_START || ch === MARK_END) {
      flush();
      mark = ch === MARK_START;
    } else buf += ch;
  }
  flush();
  return out;
}

/** The snippet without marks, whitespace collapsed, cut to `max` characters (with "..." when cut). */
export function snippetText(snippet: string, max = Infinity): string {
  const plain = snippet.replace(/[\u0001\u0002]/g, "").replace(/\s+/g, " ").trim();
  const chars = [...plain];
  return chars.length > max ? `${chars.slice(0, max).join("").trimEnd()}...` : plain;
}

/** Hits limited to one project key (empty = all). */
export function filterHits(hits: SearchHit[], projectKey: (p: string | null) => string, project: string): SearchHit[] {
  return project ? hits.filter((h) => projectKey(h.project) === project) : hits;
}
