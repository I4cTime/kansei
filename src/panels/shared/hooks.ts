import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { files, type Paths } from "../../lib/ipc";
import { pushToastAtom } from "../../lib/overlay";

export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function useToast() {
  const push = useSetAtom(pushToastAtom);
  return useMemo(
    () => ({
      info: (text: string) => push({ kind: "info", text }),
      error: (e: unknown, context?: string) => push({ kind: "error", text: (context ? context + ": " : "") + errText(e) }),
    }),
    [push],
  );
}

let pathsPromise: Promise<Paths> | null = null;
export function getPaths(): Promise<Paths> {
  if (!pathsPromise) {
    pathsPromise = files.paths().catch((e) => {
      pathsPromise = null;
      throw e;
    });
  }
  return pathsPromise;
}

export function usePaths(): Paths | null {
  const [p, setP] = useState<Paths | null>(null);
  const toast = useToast();
  useEffect(() => {
    let live = true;
    getPaths().then(
      (x) => live && setP(x),
      (e) => toast.error(e, "Could not resolve Claude paths"),
    );
    return () => {
      live = false;
    };
  }, [toast]);
  return p;
}

/** Load async data on mount (and when deps change), toast errors, expose reload. */
export function useLoad<T>(fn: (() => Promise<T>) | null, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    const f = fnRef.current;
    if (!f) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const v = await f();
      if (my === seq.current) setData(v);
    } catch (e) {
      if (my === seq.current) toast.error(e);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!fnRef.current) {
      setData(null);
      return;
    }
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, fn === null, ...deps]);

  return { data, loading, reload, setData };
}

/** Read a JSON object file; missing file -> {}. Throws on invalid JSON. */
export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  if (!(await files.exists(path))) return {};
  const text = await files.readText(path);
  if (!text.trim()) return {};
  const v: unknown = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${path} is not a JSON object`);
  return v as Record<string, unknown>;
}

export function writeJson(path: string, value: unknown): Promise<null> {
  return files.writeText(path, JSON.stringify(value, null, 2) + "\n");
}
