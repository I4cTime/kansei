// Dev-only UI driver hook. src-tauri/src/driver.rs evals
// window.__kanseiDriverRun(id, code) for each line sent to the KANSEI_DRIVER
// socket; the code runs as an async function body with `t` bound to the
// helpers below and the JSON result is handed back through driver_result.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { activity as activityIpc, pty, files, memory, mcp, projects as projectsIpc, sessions as sessionsIpc, project as projectIpc, workspace as workspaceIpc, board as boardIpc, schedule as scheduleIpc } from "../lib/ipc";
import { projectAtom, refreshProject } from "./project";
import * as terminals from "./terminals";
import * as tabs from "./tabs";
import { store } from "./store";
import { activityAtom, tabActivity } from "./activity";
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
import { closePalette, commandsNow, openPalette } from "./palette";
import { focusedPaneAtom, rightKey, setRatio, splitAtom, splitWith, toggleSplit, unsplit } from "./split";
import { rank, score } from "./palette/fuzzy";
import { search as searchIpc } from "../lib/ipc";
import { indexStatusAtom, indexingAtom, refreshIndex } from "../panels/sessions/search";
import { formatTokens, loadUsage, usageDaysAtom, usageStatusAtom } from "../panels/calendar/usage";
import { ACCENT_NAMES, accentFor, accentVar, tabAccent, tabProject } from "./accents";
import { accentOfAtom, activeAccentAtom } from "./accentState";
import { checkAll as mcpCheckAll, checkServers as mcpCheckServers, checkingAtom as mcpCheckingAtom, failedCountAtom as mcpFailedCountAtom, healthAtom as mcpHealthAtom } from "../panels/mcps/health";
import { mcpHealth as mcpHealthIpc } from "../lib/ipc";
import { graphAtom as memoryGraphAtom, graphLoadingAtom as memoryGraphLoadingAtom, reload as memoryGraphReload } from "../panels/memory/graphState";
import { activeProject as scratchActiveProject, clearDraft as scratchClearDraft, closeScratch, flushDraft as scratchFlush, insertRefs as scratchInsertRefs, openScratch, pickDraft as scratchPickDraft, requestClear as scratchRequestClear, scratchKeyAtom, scratchOpenAtom, scratchTextAtom, sendDraft as scratchSendDraft, setText as scratchSetText, toggleScratch } from "./scratchState";
import { clampScratchHeight, draftPath as scratchDraftPath, encodeKey as scratchEncodeKey, frameDraft as scratchFrameDraft, refFor as scratchRefFor } from "./scratch";
import { scratch as scratchIpc } from "../lib/ipc";
import { graphHash as memoryGraphHash, layout as memoryGraphLayout, layoutCached as memoryGraphLayoutCached } from "../panels/memory/graph";

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
    ipc: { activity: activityIpc, pty, files, memory, mcp, mcpHealth: mcpHealthIpc, projects: projectsIpc, sessions: sessionsIpc, project: projectIpc, workspace: workspaceIpc, board: boardIpc, schedule: scheduleIpc },
    /**
     * Board atoms and pure helpers (boardConfigAtom, snapshotAtom, ghStatusAtom, laneGroups, areaProject...) and its
     * actions (configureBoard, disconnectBoard, refreshBoard, setItemField: writes to GitHub).
     */
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
    /**
     * Command palette: open / close it, every command right now (buildCommands(), live store; run() not
     * serializable), the fuzzy score and the ranking (rank(commands, query, recent)).
     */
    palette: { openPalette, closePalette, buildCommands: commandsNow, score, rank },
    /**
     * Session search: query({ query, limit }) -> SearchHit[]; refresh() runs search_index_refresh through the
     * panel's shared state (IndexStatus); the status and indexing atoms.
     */
    search: { query: searchIpc.query, refresh: refreshIndex, indexStatusAtom, indexingAtom },
    /**
     * Usage: loadUsage(from, to) runs usage_refresh then usage_days and resolves to { status, days }
     * (debounced 250 ms); usageDaysAtom (Map by date), usageStatusAtom, formatTokens.
     */
    usage: { usageDaysAtom, usageStatusAtom, loadUsage, formatTokens },
    /**
     * Split terminal: splitAtom ({ right: tab key | null, ratio }), splitWith(key), unsplit(), toggleSplit(),
     * setRatio(r) (clamped 0.3..0.7), rightKey() (the valid right tab or null), focusedPaneAtom.
     */
    split: { splitAtom, splitWith, unsplit, toggleSplit, setRatio, rightKey, focusedPaneAtom },
    /**
     * Project accents: accentFor(path, registry), tabProject(cwd, tree), ACCENT_NAMES, plus accentVar(name),
     * tabAccent(cwd, tree, registry), accentOfAtom (cwd -> accent from the live tree and registry) and
     * activeAccentAtom (the active tab's, null with the pref off).
     */
    accents: { accentFor, tabProject, ACCENT_NAMES, accentVar, tabAccent, accentOfAtom, activeAccentAtom },
    /** Tab status and context: activityAtom (per pty pid, after the idle-after-busy rule) and tabActivity(tab). */
    activity: { activityAtom, tabActivity },
    /**
     * MCP health: healthAtom (key -> McpHealth), checkAll() (user, plugin, connector and the active project's servers),
     * checkServers(targets), checkingAtom (keys in flight), failedCountAtom (fresh failed and timeout results).
     */
    mcpHealth: { healthAtom: mcpHealthAtom, checkAll: mcpCheckAll, checkServers: mcpCheckServers, checkingAtom: mcpCheckingAtom, failedCountAtom: mcpFailedCountAtom },
    /**
     * Memory graph: graphAtom (the last memory_graph result, null until loaded), layout(graph, seed, iterations?)
     * (pure, 0..1 positions per node id), reload() (memory_graph again), plus layoutCached(graph) ({ hash, positions,
     * ms }: what the panel draws, cached by graphHash) and loadingAtom.
     */
    memoryGraph: { graphAtom: memoryGraphAtom, layout: memoryGraphLayout, reload: memoryGraphReload, layoutCached: memoryGraphLayoutCached, graphHash: memoryGraphHash, loadingAtom: memoryGraphLoadingAtom },
    /**
     * Prompt scratchpad: openAtom (prefs.scratchOpen), textAtom, keyAtom ({ key, project, explicit } | null),
     * sendDraft("submit" | "paste") (false with a toast when the tab cannot receive), setText(text) (saved after
     * 400 ms), toggle(); also open(), close(), flush() (write the pending draft now), clear(), requestClear(),
     * insertRefs(paths, pos?), pickDraft(key, project), activeProject(), list() (scratch_list), and the pure
     * encodeKey, draftPath, refFor, frameDraft, clampHeight(h, column).
     */
    scratch: {
      openAtom: scratchOpenAtom,
      textAtom: scratchTextAtom,
      keyAtom: scratchKeyAtom,
      sendDraft: scratchSendDraft,
      setText: scratchSetText,
      toggle: toggleScratch,
      open: openScratch,
      close: closeScratch,
      flush: scratchFlush,
      clear: scratchClearDraft,
      requestClear: scratchRequestClear,
      insertRefs: scratchInsertRefs,
      pickDraft: scratchPickDraft,
      activeProject: scratchActiveProject,
      list: scratchIpc.list,
      encodeKey: scratchEncodeKey,
      draftPath: scratchDraftPath,
      refFor: scratchRefFor,
      frameDraft: scratchFrameDraft,
      clampHeight: clampScratchHeight,
    },
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
