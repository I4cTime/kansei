import { describe, expect, it } from "vitest";
import type { McpExtras, McpHealth, McpServer } from "../../lib/ipc";
import { sanitizePrefs } from "../../app/prefs";
import {
  STALE_MS,
  agoText,
  checkTargets,
  connectorTarget,
  detailOf,
  dotTitle,
  dotTone,
  failedCount,
  healthKey,
  mergeResults,
  pluginTarget,
  pruneGone,
} from "./health";

const NOW = 1_800_000_000_000;

function h(key: string, status: McpHealth["status"], over: Partial<McpHealth> = {}): McpHealth {
  return { key, status, detail: null, ms: 12, serverInfo: null, checkedAt: NOW - 1000, ...over };
}

const plugin = {
  plugin: "qring",
  marketplace: "q-ring",
  version: "0.16.0",
  scope: "user",
  projectPath: null,
  enabled: true,
  name: "q-ring",
  config: { type: "stdio", command: "qring-mcp" },
  file: "/home/me/.claude/plugins/cache/q-ring/.mcp.json",
  needsAuth: false,
};

describe("keys and targets", () => {
  it("formats keys like the backend", () => {
    expect(healthKey({ scope: "user", name: "godot" })).toBe("user||godot");
    expect(healthKey({ scope: "project", project: "/home/me/x", name: "db" })).toBe("project|/home/me/x|db");
    expect(healthKey(pluginTarget(plugin))).toBe("plugin|qring@q-ring|q-ring");
    expect(healthKey(pluginTarget({ ...plugin, marketplace: null }))).toBe("plugin|qring|q-ring");
    expect(healthKey(connectorTarget({ name: "claude.ai Claude Docs", needsAuth: false }))).toBe("connector||claude.ai Claude Docs");
  });

  it("checks user servers, the active project's, plugins and connectors", () => {
    const list: McpServer[] = [
      { scope: "user", name: "a", config: {} },
      { scope: "project", project: "/p/one", name: "b", config: {} },
      { scope: "project", project: "/p/two", name: "c", config: {} },
      { scope: "projectFile", project: "/p/one", name: "d", config: {} },
    ];
    const extras: McpExtras = { plugins: [plugin], connectors: [{ name: "claude.ai X", needsAuth: false }], builtins: [] };
    expect(checkTargets(list, extras, "/p/one").map(healthKey)).toEqual([
      "user||a",
      "project|/p/one|b",
      "projectFile|/p/one|d",
      "plugin|qring@q-ring|q-ring",
      "connector||claude.ai X",
    ]);
    expect(checkTargets(list, null, null).map(healthKey)).toEqual(["user||a"]);
  });

  it("prunes gone user, plugin and connector results but keeps other projects'", () => {
    const map = {
      "user||a": h("user||a", "ok"),
      "user||gone": h("user||gone", "failed"),
      "plugin|p@m|gone": h("plugin|p@m|gone", "failed"),
      "project|/p/two|c": h("project|/p/two|c", "failed"),
    };
    expect(Object.keys(pruneGone(map, [{ scope: "user", name: "a", config: {} }]))).toEqual(["user||a", "project|/p/two|c"]);
  });

  it("never lets an older result replace a newer one", () => {
    const newer = h("user||a", "ok", { checkedAt: NOW });
    const older = h("user||a", "failed", { checkedAt: NOW - 5000 });
    expect(mergeResults({ "user||a": newer }, [older])["user||a"]).toBe(newer);
    expect(mergeResults({ "user||a": older }, [newer])["user||a"]).toBe(newer);
  });
});

describe("dots", () => {
  it("maps status to tone, stale and unknown to muted", () => {
    expect(dotTone(h("k", "ok"), NOW)).toBe("ok");
    expect(dotTone(h("k", "auth"), NOW)).toBe("warn");
    expect(dotTone(h("k", "failed"), NOW)).toBe("danger");
    expect(dotTone(h("k", "timeout"), NOW)).toBe("danger");
    expect(dotTone(h("k", "skipped"), NOW)).toBe("muted");
    expect(dotTone(undefined, NOW)).toBe("muted");
    expect(dotTone(h("k", "failed", { checkedAt: NOW - STALE_MS - 1 }), NOW)).toBe("muted");
  });

  it("titles carry status, latency, serverInfo and when", () => {
    expect(dotTitle(h("k", "ok", { ms: 412, serverInfo: { name: "q-ring", version: "0.16.0" } }), NOW)).toBe("Started, 412 ms, q-ring 0.16.0\nChecked just now");
    expect(dotTitle(h("k", "auth", { detail: "HTTP 401: reachable, needs sign-in" }), NOW)).toBe(
      "Reachable, needs sign-in, 12 ms\nHTTP 401: reachable, needs sign-in\nChecked just now",
    );
    expect(dotTitle(h("k", "skipped", { ms: null, detail: "curl not found" }), NOW)).toBe("Skipped\ncurl not found\nChecked just now");
    expect(dotTitle(h("k", "timeout", { checkedAt: NOW - 2 * STALE_MS }), NOW)).toBe("Timed out, 12 ms\nChecked 2 d ago (stale: older than 24 h)");
    expect(dotTitle(undefined, NOW)).toBe("Not checked yet");
  });

  it("ago text", () => {
    expect(agoText(30_000)).toBe("just now");
    expect(agoText(12 * 60_000)).toBe("12 min ago");
    expect(agoText(3 * 3_600_000)).toBe("3 h ago");
    expect(agoText(50 * 3_600_000)).toBe("2 d ago");
  });

  it("detail only for failed and timeout", () => {
    expect(detailOf(h("k", "failed", { detail: "boom" }))).toBe("boom");
    expect(detailOf(h("k", "timeout", { detail: "slow" }))).toBe("slow");
    expect(detailOf(h("k", "auth", { detail: "HTTP 401" }))).toBeNull();
    expect(detailOf(h("k", "failed"))).toBeNull();
    expect(detailOf(undefined)).toBeNull();
  });

  it("counts fresh failures only", () => {
    const map = {
      a: h("a", "failed"),
      b: h("b", "timeout"),
      c: h("c", "auth"),
      d: h("d", "failed", { checkedAt: NOW - STALE_MS - 1 }),
    };
    expect(failedCount(map, NOW)).toBe(2);
    expect(failedCount({}, NOW)).toBe(0);
  });
});

describe("prefs.mcpHealthAtStartup", () => {
  it("defaults on and keeps booleans only", () => {
    expect(sanitizePrefs({}).mcpHealthAtStartup).toBe(true);
    expect(sanitizePrefs({ mcpHealthAtStartup: false }).mcpHealthAtStartup).toBe(false);
    expect(sanitizePrefs({ mcpHealthAtStartup: "no" }).mcpHealthAtStartup).toBe(true);
  });
});
