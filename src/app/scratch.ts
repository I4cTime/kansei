// Prompt scratchpad (CONTRACT.md "Prompt scratchpad"): pure rules, tested in
// scratch.test.ts. The live atoms and actions are in scratchState.ts, the
// drawer in Scratchpad.tsx.
//
// Type imports only (plus the pure accents.ts), so prefs.ts can use the height
// constants and the tests need no Tauri or xterm.
import type { WorkspaceNode } from "../lib/ipc";
import { tabProject } from "./accents";
import type { Tab } from "./tabState";

/** Drawer height in px: at least this, at most SCRATCH_MAX_SHARE of the terminal column. */
export const SCRATCH_MIN = 120;
export const SCRATCH_DEFAULT = 220;
export const SCRATCH_MAX_SHARE = 0.6;
/** prefs.json keeps at most this; the column share is applied when drawing. */
export const SCRATCH_PREF_MAX = 4000;
/** The draft is written this long after the last edit. */
export const SAVE_DELAY = 400;
/** Clearing a draft longer than this asks first. */
export const CLEAR_CONFIRM_CHARS = 200;

export type SendMode = "submit" | "paste";

const trimSlash = (p: string) => p.trim().replace(/\/+$/, "") || (p.trim().startsWith("/") ? "/" : "");

/**
 * The draft key of a project path, encoded like Claude Code's project dirs
 * (`~/.claude/projects/<encoded>`, see memory.rs): every character that is not
 * an ASCII letter or digit becomes `-`, so `/home/me/Develop/my.app` is
 * `-home-me-Develop-my-app`.
 */
export function encodeKey(path: string): string {
  return trimSlash(path).replace(/[^A-Za-z0-9]/gu, "-");
}

/** `<appData>/scratch/<key>.md`. */
export function draftPath(appData: string, key: string): string {
  return `${appData.replace(/\/+$/, "")}/scratch/${key}.md`;
}

/** The project a tab's draft belongs to: its workspace project (tabProject), else its cwd. */
export function draftProject(cwd: string, tree: WorkspaceNode[] | null): string {
  return tabProject(cwd, tree)?.path ?? trimSlash(cwd);
}

/**
 * The @reference text for `path`: relative to `project` when inside it ("." for
 * the project itself), else the path as given.
 */
export function refFor(path: string, project: string | null): string {
  const p = trimSlash(path);
  if (!project) return p;
  const root = trimSlash(project);
  if (!root) return p;
  if (p === root) return ".";
  const prefix = root === "/" ? "/" : `${root}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** `@<ref>` per path, one per line. Empty paths are skipped. */
export function refsText(paths: string[], project: string | null): string {
  return paths
    .filter((p) => p.trim())
    .map((p) => `@${refFor(p, project)}`)
    .join("\n");
}

/**
 * The text to insert at `pos` in `doc` so a reference does not run into the
 * words around it: a space before when the previous character is not
 * whitespace, a space after when the next one is not. `cursor` is the offset
 * after the inserted references (before the trailing space).
 */
export function spliceRefs(doc: string, pos: number, refs: string): { insert: string; cursor: number } {
  const before = pos > 0 && !/\s/.test(doc[pos - 1]) ? " " : "";
  const after = pos < doc.length && !/\s/.test(doc[pos]) ? " " : "";
  return { insert: `${before}${refs}${after}`, cursor: pos + before.length + refs.length };
}

/** Absolute paths from a text/plain drop (one per line), or null when it is other text. */
export function droppedPaths(text: string): string[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0 || !lines.every((l) => l.startsWith("/"))) return null;
  return lines;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * What goes to the pty: the text without its trailing newline, in bracketed
 * paste so a multi-line prompt does not submit line by line, then `\r` for
 * "submit". Paste markers inside the text are dropped, so it cannot end the
 * paste early.
 */
export function frameDraft(text: string, mode: SendMode): string {
  const body = text.replace(/\r?\n$/, "").split(PASTE_START).join("").split(PASTE_END).join("");
  return `${PASTE_START}${body}${PASTE_END}${mode === "submit" ? "\r" : ""}`;
}

/** The drawer height for a wanted height and the terminal column's height (0 = not measured yet). */
export function clampScratchHeight(h: number, column: number): number {
  const want = Number.isFinite(h) ? h : SCRATCH_DEFAULT;
  const max = column > 0 ? Math.max(SCRATCH_MIN, Math.floor(column * SCRATCH_MAX_SHARE)) : SCRATCH_PREF_MAX;
  return Math.round(Math.min(max, Math.max(SCRATCH_MIN, want)));
}

/** Why the active tab cannot receive a draft, or null when it can (alive with a pty). */
export function sendBlocker(tab: Pick<Tab, "status" | "id"> | null | undefined): string | null {
  if (!tab) return "No tab open";
  if (tab.status === "spawning") return "The tab is still starting";
  if (tab.status === "dead") return "The tab has exited";
  if (!tab.id) return "The tab is not running";
  return null;
}

export type Saver = {
  /** Write `text` for `key` SAVE_DELAY ms from now, replacing a pending write for the same key; another key's pending write goes out first. */
  schedule: (key: string, text: string) => void;
  /** Write the pending draft now. */
  flush: () => Promise<void>;
  /** True while a write is waiting for its timer. */
  pending: () => boolean;
};

/** The draft save debounce around `write(key, text)`. */
export function createSaver(write: (key: string, text: string) => void | Promise<void>, delay = SAVE_DELAY): Saver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let next: { key: string; text: string } | null = null;
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const job = next;
    next = null;
    if (job) await write(job.key, job.text);
  };
  return {
    schedule(key, text) {
      if (next && next.key !== key) void flush();
      next = { key, text };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), delay);
    },
    flush,
    pending: () => next !== null,
  };
}
