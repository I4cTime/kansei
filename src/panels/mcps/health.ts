// MCP health (CONTRACT.md "MCP health").
//
// The backend probes each server with a real initialize handshake (stdio: the
// command, http: curl) and emits `mcp:health` per result; this module keeps
// them in healthAtom by key, seeds it from <appData>/mcp-health.json at boot
// and runs checkAll() 5 s after boot when prefs.mcpHealthAtStartup is on.
//
// Keys are "<scope>|<project or ''>|<name>": McpServer scopes as they are,
// plugin servers as scope "plugin" with project "<plugin>@<marketplace>", and
// claude.ai connectors as scope "connector" (always skipped: Kansei has no
// transport for them).
import { atom } from "jotai";
import {
  mcp,
  mcpHealth,
  type McpConnector,
  type McpExtras,
  type McpHealth,
  type McpHealthTarget,
  type McpPluginServer,
  type McpServer,
} from "../../lib/ipc";
import { prefsAtom } from "../../app/prefs";
import { projectAtom } from "../../app/project";
import { store, toastError } from "../../app/store";

export type { McpHealth, McpHealthTarget } from "../../lib/ipc";

/** Results older than this show as stale (muted dot) and do not count as failed. */
export const STALE_MS = 24 * 60 * 60 * 1000;
/** The startup check runs this long after boot. */
export const STARTUP_DELAY_MS = 5000;

// ---------------------------------------------------------------------------
// pure helpers

export function healthKey(s: { scope: string; project?: string | null; name: string }): string {
  return `${s.scope}|${s.project ?? ""}|${s.name}`;
}

export function pluginTarget(p: McpPluginServer): McpHealthTarget {
  return { scope: "plugin", project: p.marketplace ? `${p.plugin}@${p.marketplace}` : p.plugin, name: p.name, config: p.config };
}

export function connectorTarget(c: McpConnector): McpHealthTarget {
  return { scope: "connector", name: c.name, config: {} };
}

/**
 * What checkAll probes: user servers, the active project's servers (its
 * ~/.claude.json entry and its .mcp.json), plugin servers and connectors.
 */
export function checkTargets(list: McpServer[], extras: McpExtras | null, root: string | null): McpHealthTarget[] {
  const servers = list.filter((s) => s.scope === "user" || (root !== null && (s.scope === "projectFile" || (s.scope === "project" && s.project === root))));
  return [...servers, ...(extras?.plugins ?? []).map(pluginTarget), ...(extras?.connectors ?? []).map(connectorTarget)];
}

/** Scopes whose lists are global, so a key missing from a full check means the server is gone. */
const GLOBAL_SCOPES = new Set(["user", "plugin", "connector"]);

/** Drop results for user, plugin and connector servers that are no longer configured. */
export function pruneGone(map: Record<string, McpHealth>, targets: McpHealthTarget[]): Record<string, McpHealth> {
  const live = new Set(targets.map(healthKey));
  const out: Record<string, McpHealth> = {};
  for (const [k, h] of Object.entries(map)) if (live.has(k) || !GLOBAL_SCOPES.has(k.split("|", 1)[0])) out[k] = h;
  return out;
}

/** Newer results win; an older one (a cached read racing an event) never replaces a newer one. */
export function mergeResults(map: Record<string, McpHealth>, list: McpHealth[]): Record<string, McpHealth> {
  const out = { ...map };
  for (const h of list) if (!out[h.key] || out[h.key].checkedAt <= h.checkedAt) out[h.key] = h;
  return out;
}

export function isStale(h: McpHealth, now: number): boolean {
  return now - h.checkedAt > STALE_MS;
}

export function isFailed(h: McpHealth | undefined): boolean {
  return h?.status === "failed" || h?.status === "timeout";
}

/** Fresh failed and timeout results (the sidebar's danger dot). */
export function failedCount(map: Record<string, McpHealth>, now: number): number {
  return Object.values(map).filter((h) => isFailed(h) && !isStale(h, now)).length;
}

export type DotTone = "ok" | "warn" | "danger" | "muted";

export function dotTone(h: McpHealth | undefined, now: number): DotTone {
  if (!h || isStale(h, now)) return "muted";
  if (h.status === "ok") return "ok";
  if (h.status === "auth") return "warn";
  if (isFailed(h)) return "danger";
  return "muted";
}

const STATUS_WORD: Record<McpHealth["status"], string> = {
  ok: "Started",
  auth: "Reachable, needs sign-in",
  failed: "Failed",
  timeout: "Timed out",
  skipped: "Skipped",
};

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
export function agoText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** The dot's title: status, latency and serverInfo, then when it was checked. */
export function dotTitle(h: McpHealth | undefined, now: number): string {
  if (!h) return "Not checked yet";
  const head = [STATUS_WORD[h.status], h.ms !== null ? `${h.ms} ms` : null, h.serverInfo ? [h.serverInfo.name, h.serverInfo.version].filter(Boolean).join(" ") : null]
    .filter(Boolean)
    .join(", ");
  const why = h.status === "skipped" || h.status === "auth" ? h.detail : null;
  const when = `Checked ${agoText(now - h.checkedAt)}${isStale(h, now) ? " (stale: older than 24 h)" : ""}`;
  return [head, why, when].filter(Boolean).join("\n");
}

/** Failed and timeout results with text to show under the row. */
export function detailOf(h: McpHealth | undefined): string | null {
  return isFailed(h) && h?.detail ? h.detail : null;
}

// ---------------------------------------------------------------------------
// live state

export const healthAtom = atom<Record<string, McpHealth>>({});
/** Keys with a probe in flight. */
export const checkingAtom = atom<Record<string, true>>({});
export const failedCountAtom = atom((get) => failedCount(get(healthAtom), Date.now()));

function put(list: McpHealth[]) {
  store.set(healthAtom, mergeResults(store.get(healthAtom), list));
}

function setChecking(keys: string[], on: boolean) {
  const next = { ...store.get(checkingAtom) };
  for (const k of keys) {
    if (on) next[k] = true;
    else delete next[k];
  }
  store.set(checkingAtom, next);
}

/** Probe these servers (those already in flight are left out). Resolves to the new results. */
export async function checkServers(servers: McpHealthTarget[]): Promise<McpHealth[]> {
  const busy = store.get(checkingAtom);
  const todo = servers.filter((s, i) => !busy[healthKey(s)] && servers.findIndex((x) => healthKey(x) === healthKey(s)) === i);
  if (todo.length === 0) return [];
  const keys = todo.map(healthKey);
  setChecking(keys, true);
  try {
    const out = await mcpHealth.check(todo);
    put(out);
    return out;
  } catch (e) {
    toastError(e, "MCP health check failed");
    return [];
  } finally {
    setChecking(keys, false);
  }
}

/** User servers, plugin servers, connectors and the active project's servers. */
export async function checkAll(): Promise<McpHealth[]> {
  const root = store.get(projectAtom)?.root ?? null;
  let list: McpServer[];
  let extras: McpExtras | null;
  try {
    [list, extras] = await Promise.all([mcp.list(root ?? undefined), mcp.extras().catch(() => null)]);
  } catch (e) {
    toastError(e, "Could not list MCP servers");
    return [];
  }
  const targets = checkTargets(list, extras, root);
  store.set(healthAtom, pruneGone(store.get(healthAtom), targets));
  return checkServers(targets);
}

let started = false;

/** Listen for results, load the cache, and schedule the startup check. */
export async function startMcpHealth(): Promise<void> {
  if (started) return;
  started = true;
  await mcpHealth.onResult((h) => put([h]));
  try {
    put(await mcpHealth.cached());
  } catch {
    // No cache yet, or unreadable: the next check writes a new one.
  }
  if (store.get(prefsAtom).mcpHealthAtStartup) setTimeout(() => void checkAll(), STARTUP_DELAY_MS);
}
