// Shared jotai store and small helpers for the shell.
// The app renders without a <Provider>, so every useAtom() in the shell and in
// panels talks to this same default store, and module code (pty event routing,
// shortcuts, persistence) can read and write atoms with store.get / store.set.
import { getDefaultStore } from "jotai";
import { pushToastAtom } from "../lib/overlay";
import { files, type Paths } from "../lib/ipc";

export const store = getDefaultStore();

export function toastError(e: unknown, prefix?: string) {
  const msg = e instanceof Error ? e.message : String(e);
  store.set(pushToastAtom, { kind: "error", text: prefix ? `${prefix}: ${msg}` : msg });
}

export function toastInfo(text: string) {
  store.set(pushToastAtom, { kind: "info", text });
}

let pathsPromise: Promise<Paths> | null = null;
/** Cached claude_paths() result. */
export function getPaths(): Promise<Paths> {
  if (!pathsPromise) {
    pathsPromise = files.paths().catch((e) => {
      pathsPromise = null;
      throw e;
    });
  }
  return pathsPromise;
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return (i >= 0 ? trimmed.slice(i + 1) : trimmed) || "/";
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Debounce helper for persistence writes. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...a);
    }, ms);
  };
}
