// Dev-only UI driver hook. src-tauri/src/driver.rs evals
// window.__kanseiDriverRun(id, code) for each line sent to the KANSEI_DRIVER
// socket; the code runs as an async function body with `t` bound to the
// helpers below and the JSON result is handed back through driver_result.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pty, files, memory, mcp, projects as projectsIpc, sessions as sessionsIpc, project as projectIpc, workspace as workspaceIpc, board as boardIpc, schedule as scheduleIpc } from "../lib/ipc";
import { projectAtom, refreshProject } from "./project";
import * as terminals from "./terminals";
import * as tabs from "./tabs";
import { store } from "./store";
import { claudeCommandAtom, prefsAtom, refreshClaudeCommand, savePrefs, setPrefs, spawnCommand } from "./prefs";
import { overlayAtom, toastsAtom } from "../lib/overlay";
import { dismissOverlay } from "./keyboard";
import { activeThemeAtom, applyNow, omarchyAtom } from "./theme/apply";
import * as projectActions from "../panels/projects/actions";
import { sessionsProjectFilterAtom } from "../panels/sessions/model";
import * as workspaces from "../panels/projects/workspaceStore";
import * as workspaceModel from "../panels/projects/workspace";
import * as boardModel from "../panels/board/model";
import * as boardActions from "../panels/board/actions";
import * as calendarModel from "../panels/calendar/model";
import * as calendarActions from "../panels/calendar/actions";

declare global {
  interface Window {
    __kansei?: Record<string, unknown>;
    __kanseiDriverRun?: (id: number, code: string) => Promise<void>;
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
    /** Resolved Claude command (atom), its refresh, and the tab command -> executable mapping used at spawn. */
    claude: { claudeCommandAtom, refreshClaudeCommand, spawnCommand },
    overlayAtom,
    toastsAtom,
    dismissOverlay,
    invoke,
    listen,
    ipc: { pty, files, memory, mcp, projects: projectsIpc, sessions: sessionsIpc, project: projectIpc, workspace: workspaceIpc, board: boardIpc, schedule: scheduleIpc },
    /** Board atoms and pure helpers (snapshotAtom, ghStatusAtom, laneGroups, areaProject...) and its actions (refreshBoard, setItemField: writes to GitHub). */
    board: { ...boardModel, ...boardActions },
    /** Calendar atoms and helpers (scheduleAtom, todayAtom, weekGrid, monthGrid, dayPlan...) and loadSchedule / saveSchedule. */
    calendar: { ...calendarModel, ...calendarActions },
    project: { projectAtom, refreshProject },
    /** Theme: what is applied (source, name, palette, effects), the live Omarchy theme, and a forced re-apply. */
    theme: { activeThemeAtom, applyNow, omarchyAtom },
    /** Projects panel pin / hide helpers (addProjectWithPicker opens a native dialog). */
    projects: projectActions,
    sessionsProjectFilterAtom,
    /** Workspace trees and registry (treeAtom, registryAtom, scanWorkspaces, saveEntry, saveRelated) and the pure helpers. */
    workspaces,
    workspaceModel,
    terminals,
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
  window.__kansei = helpers;
  window.__kanseiDriverRun = async (id, code) => {
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
