// Terminal registry and pty routing.
//
// xterm instances live here, outside React, keyed by tab key, so StrictMode
// remounts and re-renders never lose scrollback. One global pty:data / pty:exit
// subscription routes chunks by pty id to the right terminal. Chunks that
// arrive before pty_spawn resolves (the reader thread can win that race) are
// buffered per id and flushed once the id is registered.
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { b64ToBytes, pty } from "../lib/ipc";
import { noteTabInput } from "./activity";
import { overlayAtom } from "../lib/overlay";
import { prefsAtom, spawnCommand } from "./prefs";
import { matchShortcut } from "./shortcuts";
import { store, toastError } from "./store";
import { getTab, tabsAtom, updateTab } from "./tabState";
import { readTerminalTheme, themeTickAtom } from "./terminalTheme";

type Dims = { cols: number; rows: number };

type Entry = {
  key: string;
  term: Terminal;
  fit: FitAddon;
  /** Element xterm is opened into; moved between containers if needed. */
  host: HTMLDivElement;
  opened: boolean;
  /** Latest container from TerminalView. */
  container: HTMLElement | null;
  /** Offscreen box used to measure a terminal opened while hidden. */
  staging: HTMLDivElement | null;
  lastSent: Dims | null;
  fitFrame: number | null;
};

const entries = new Map<string, Entry>();
const idToKey = new Map<string, string>();
type Pending = { chunks: Uint8Array[]; exited: boolean; code: number | null; at: number };
const pending = new Map<string, Pending>();
const spawning = new Set<string>();

/** Last good fitted size; used when a terminal is hidden at spawn time. */
let lastGood: Dims = { cols: 100, rows: 30 };

// ---------------------------------------------------------------------------
// pty event routing

let routing: Promise<void> | null = null;

export function startPtyRouting(): Promise<void> {
  if (routing) return routing;
  routing = (async () => {
    await pty.onData(({ id, data }) => {
      const bytes = b64ToBytes(data);
      const key = idToKey.get(id);
      if (key) {
        entries.get(key)?.term.write(bytes);
        return;
      }
      pendingFor(id).chunks.push(bytes);
    });
    await pty.onExit(({ id, code }) => {
      const key = idToKey.get(id);
      if (key) {
        handleExit(key, id, code);
        return;
      }
      const p = pendingFor(id);
      p.exited = true;
      p.code = code;
    });
    // Live font and theme updates for every terminal.
    store.sub(prefsAtom, applyPrefsToAll);
    store.sub(themeTickAtom, applyThemeToAll);
  })().catch((e) => {
    routing = null;
    throw e;
  });
  return routing;
}

function pendingFor(id: string): Pending {
  const now = Date.now();
  // Drop stale buffers (ids we never registered, e.g. killed during spawn).
  for (const [k, p] of pending) if (now - p.at > 15000) pending.delete(k);
  let p = pending.get(id);
  if (!p) {
    p = { chunks: [], exited: false, code: null, at: now };
    pending.set(id, p);
  }
  return p;
}

function handleExit(key: string, id: string, code: number | null) {
  idToKey.delete(id);
  const tab = getTab(key);
  if (!tab || tab.id !== id) return;
  updateTab(key, { id: null, status: "dead", exitCode: code, pid: null });
}

// ---------------------------------------------------------------------------
// terminal lifecycle

function ensureEntry(key: string): Entry {
  let e = entries.get(key);
  if (e) return e;
  const prefs = store.get(prefsAtom);
  const term = new Terminal({
    fontFamily: prefs.fontFamily,
    fontSize: prefs.fontSize,
    theme: readTerminalTheme(),
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(
    new WebLinksAddon((_ev, uri) => {
      openUrl(uri).catch(() => window.open(uri, "_blank"));
    }),
  );
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  e = { key, term, fit, host, opened: false, container: null, staging: null, lastSent: null, fitFrame: null };
  entries.set(key, e);

  term.attachCustomKeyEventHandler((ev) => {
    if (matchShortcut(ev)) return false;
    if (store.get(overlayAtom)) return false;
    if (ev.type === "keydown" && ev.ctrlKey && ev.shiftKey && !ev.altKey) {
      if (ev.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
        ev.preventDefault();
        return false;
      }
      if (ev.code === "KeyV") {
        navigator.clipboard
          ?.readText()
          .then((text) => text && term.paste(text))
          .catch(() => {});
        ev.preventDefault();
        return false;
      }
    }
    return true;
  });

  const send = (data: string) => {
    const tab = getTab(key);
    if (tab?.id && tab.status === "alive") {
      pty.write(tab.id, data).catch(() => {});
      noteTabInput(key, data);
    }
  };
  term.onData(send);
  term.onBinary(send);
  return e;
}

/**
 * Mount the tab's terminal into a container. Safe to call repeatedly.
 *
 * xterm measures its cell size on open, which yields zero inside a
 * display:none container (inactive restored tabs). In that case the terminal
 * opens in an offscreen staging box sized like the visible terminal area, is
 * fitted and spawned there, and only then moves into its container.
 */
/** requestAnimationFrame that still fires when the window gets no frame
 * callbacks (Wayland surfaces on another workspace never paint). */
function nextFrame(cb: () => void): number {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cb();
  };
  const id = requestAnimationFrame(run);
  setTimeout(run, 120);
  return id;
}

export function getEntry(key: string) {
  return entries.get(key);
}

export function attachTerminal(key: string, container: HTMLElement) {
  const e = ensureEntry(key);
  e.container = container;
  if (e.opened) {
    if (!e.staging && e.host.parentElement !== container) container.appendChild(e.host);
    return;
  }
  if (e.staging) return; // open already in progress

  const hidden = container.clientWidth === 0 || container.clientHeight === 0;
  if (hidden) {
    const area = container.parentElement?.parentElement;
    const cs = getComputedStyle(container);
    const px = (v: string) => parseFloat(v) || 0;
    const w = (area?.clientWidth ?? 0) - px(cs.paddingLeft) - px(cs.paddingRight);
    const h = (area?.clientHeight ?? 0) - px(cs.paddingTop) - px(cs.paddingBottom);
    if (w > 0 && h > 0) {
      const staging = document.createElement("div");
      Object.assign(staging.style, {
        position: "fixed",
        left: "-100000px",
        top: "0",
        width: `${w}px`,
        height: `${h}px`,
        visibility: "hidden",
        pointerEvents: "none",
      });
      document.body.appendChild(staging);
      staging.appendChild(e.host);
      e.staging = staging;
    }
  }
  if (!e.staging) container.appendChild(e.host);

  e.term.open(e.host);
  e.opened = true;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    e.term.loadAddon(webgl);
  } catch {
    // WebKitGTK may refuse WebGL2; the DOM renderer is fine.
  }

  // Measure first, then spawn with the fitted size.
  const start = () =>
    nextFrame(() => {
      if (!entries.has(key)) return;
      fitTerminal(key);
      if (e.staging) {
        e.container?.appendChild(e.host);
        e.staging.remove();
        e.staging = null;
      }
      const tab = getTab(key);
      if (tab && tab.status === "spawning" && !tab.id) void spawnTab(key);
    });
  if (document.fonts?.ready) document.fonts.ready.then(start, start);
  else start();
}

export function disposeTerminal(key: string) {
  const e = entries.get(key);
  if (!e) return;
  if (e.fitFrame != null) cancelAnimationFrame(e.fitFrame);
  e.term.dispose();
  e.host.remove();
  e.staging?.remove();
  entries.delete(key);
  for (const [id, k] of idToKey) if (k === key) idToKey.delete(id);
}

function validDims(d: { cols: number; rows: number } | undefined): d is Dims {
  return !!d && Number.isFinite(d.cols) && Number.isFinite(d.rows) && d.cols > 2 && d.rows > 1;
}

/** Fit to the container (no-op while hidden) and push the size to the pty. */
export function fitTerminal(key: string): Dims | null {
  const e = entries.get(key);
  if (!e || !e.opened) return null;
  // WebKitGTK proposes a tiny size (11x5) inside a display:none container
  // instead of none, which would shrink a hidden tab's pty; measure the host.
  if (!e.host.isConnected || e.host.clientWidth === 0 || e.host.clientHeight === 0) return null;
  const proposed = e.fit.proposeDimensions();
  if (!validDims(proposed)) return null;
  e.fit.fit();
  const dims = { cols: e.term.cols, rows: e.term.rows };
  lastGood = dims;
  const tab = getTab(key);
  if (tab?.id && (!e.lastSent || e.lastSent.cols !== dims.cols || e.lastSent.rows !== dims.rows)) {
    e.lastSent = dims;
    pty.resize(tab.id, dims.cols, dims.rows).catch(() => {});
  }
  return dims;
}

/** rAF-throttled fit, for ResizeObserver callbacks. */
export function scheduleFit(key: string) {
  const e = entries.get(key);
  if (!e || e.fitFrame != null) return;
  e.fitFrame = nextFrame(() => {
    e.fitFrame = null;
    fitTerminal(key);
  });
}

/**
 * Write `data` to a tab's pty as if typed (the path keyboard input takes).
 * False, and nothing written, unless the tab is alive with a pty.
 */
export function writeToTab(key: string, data: string): boolean {
  const tab = getTab(key);
  if (!tab?.id || tab.status !== "alive") return false;
  pty.write(tab.id, data).catch((e) => toastError(e, "Could not write to the terminal"));
  noteTabInput(key, data);
  return true;
}

export function focusTerminal(key: string) {
  if (store.get(overlayAtom)) return;
  entries.get(key)?.term.focus();
}

/** Spawn the pty for a tab in status "spawning". Idempotent while in flight. */
export async function spawnTab(key: string): Promise<void> {
  if (spawning.has(key)) return;
  const tab = getTab(key);
  const e = entries.get(key);
  if (!tab || !e || tab.status !== "spawning" || tab.id) return;
  spawning.add(key);
  let command = tab.command;
  try {
    await startPtyRouting();
    command = await spawnCommand(tab.command);
    let dims = fitTerminal(key);
    if (!dims) {
      dims = lastGood;
      e.term.resize(dims.cols, dims.rows);
    }
    const { id, pid } = await pty.spawn({ cwd: tab.cwd, command, args: tab.args, cols: dims.cols, rows: dims.rows });
    if (!getTab(key) || !entries.has(key)) {
      // Closed while spawning.
      pending.delete(id);
      pty.kill(id).catch(() => {});
      return;
    }
    idToKey.set(id, key);
    e.lastSent = dims;
    updateTab(key, { id, status: "alive", exitCode: null, error: null, pid: pid ?? null });
    const p = pending.get(id);
    if (p) {
      pending.delete(id);
      for (const c of p.chunks) e.term.write(c);
      if (p.exited) handleExit(key, id, p.code);
    }
    // The size may have changed while the spawn was in flight.
    fitTerminal(key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateTab(key, { id: null, status: "dead", exitCode: null, error: msg, pid: null });
    toastError(err, `Could not start ${command}`);
  } finally {
    spawning.delete(key);
  }
}

/** Re-spawn a dead tab in the same cwd, keeping the scrollback. */
export function restartTerminal(key: string) {
  const tab = getTab(key);
  if (!tab || tab.status !== "dead") return;
  const e = entries.get(key);
  updateTab(key, { status: "spawning", id: null, exitCode: null, error: null, pid: null });
  if (e) {
    e.term.write("\r\n\x1b[2m[restarting]\x1b[0m\r\n");
    e.lastSent = null;
    if (e.opened) void spawnTab(key);
  }
}

// ---------------------------------------------------------------------------
// live prefs / theme

let lastFont = { family: "", size: 0 };
function applyPrefsToAll() {
  const p = store.get(prefsAtom);
  if (p.fontFamily === lastFont.family && p.fontSize === lastFont.size) return;
  lastFont = { family: p.fontFamily, size: p.fontSize };
  for (const e of entries.values()) {
    e.term.options.fontFamily = p.fontFamily;
    e.term.options.fontSize = p.fontSize;
  }
  refitVisible();
}

function applyThemeToAll() {
  const theme = readTerminalTheme();
  for (const e of entries.values()) e.term.options.theme = theme;
}

function refitVisible() {
  // Hidden terminals fail proposeDimensions and refit when activated.
  for (const t of store.get(tabsAtom)) scheduleFit(t.key);
}
