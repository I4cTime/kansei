// Dev-only UI driver hook. src-tauri/src/driver.rs evals
// window.__tsukueDriverRun(id, code) for each line sent to the TSUKUE_DRIVER
// socket; the code runs as an async function body with `t` bound to the
// helpers below and the JSON result is handed back through driver_result.
import { invoke } from "@tauri-apps/api/core";
import * as tabs from "./tabs";
import { store } from "./store";
import { prefsAtom, savePrefs, setPrefs } from "./prefs";
import { overlayAtom, toastsAtom } from "../lib/overlay";
import { dismissOverlay } from "./keyboard";

declare global {
  interface Window {
    __tsukue?: Record<string, unknown>;
    __tsukueDriverRun?: (id: number, code: string) => Promise<void>;
  }
}

export function installDriver() {
  if (!import.meta.env.DEV) return;
  const helpers = {
    tabs,
    store,
    prefsAtom,
    savePrefs,
    setPrefs,
    overlayAtom,
    toastsAtom,
    dismissOverlay,
    invoke,
    /** querySelector that throws a readable error when nothing matches. */
    q(sel: string): HTMLElement {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) throw new Error(`no element for ${sel}`);
      return el;
    },
    /** First element whose trimmed text equals or contains `text`. */
    byText(text: string, sel = "button, a, [role=button], [role=tab], label, span, div"): HTMLElement {
      const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
      const exact = els.find((e) => e.textContent?.trim() === text);
      const found = exact ?? els.find((e) => e.textContent?.includes(text) && e.children.length === 0);
      if (!found) throw new Error(`no element with text ${JSON.stringify(text)}`);
      return found;
    },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    text: (sel = "#root") => document.querySelector(sel)?.textContent ?? null,
    toasts: () => store.get(toastsAtom).map((t) => `${t.kind}: ${t.text}`),
  };
  window.__tsukue = helpers;
  window.__tsukueDriverRun = async (id, code) => {
    let result: unknown;
    try {
      const fn = new Function("t", `return (async () => { ${code} })();`) as (t: typeof helpers) => Promise<unknown>;
      result = await fn(helpers);
    } catch (e) {
      result = { __error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
    let json: string;
    try {
      json = JSON.stringify(result ?? null) ?? "null";
    } catch {
      json = JSON.stringify(String(result));
    }
    await invoke("driver_result", { id, result: json });
  };
}
