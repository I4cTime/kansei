import { describe, expect, it } from "vitest";
import type { WorkspaceNode } from "../lib/ipc";
import { EMPTY_ENTRY, sanitizeRegistry, withEntry, type Registry } from "../panels/projects/workspace";
import { ACCENT_NAMES, accentFor, accentVar, chipName, hashAccent, tabAccent, tabProject, type AccentName } from "./accents";

const FLAGS = { claudeMd: false, claudeDir: false, mcpJson: false, git: true, worktree: false };
const node = (path: string, kind: WorkspaceNode["kind"], children: WorkspaceNode[] = []): WorkspaceNode => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  kind,
  flags: FLAGS,
  children,
});

const tree: WorkspaceNode[] = [
  node("/d", "root", [
    node("/d/marketing", "project"),
    node("/d/products", "group", [
      node("/d/products/aibou", "project"),
      node("/d/products/ring", "group", [node("/d/products/ring/q-ring", "project")]),
    ]),
    node("/d/sites", "group", [node("/d/sites/i4c-sites", "project", [node("/d/sites/i4c-sites/apps/sparkle", "subproject")])]),
  ]),
  node("/w", "root", [node("/w/lab", "group", [node("/w/lab/kansei", "project")])]),
];

const reg = (entries: Record<string, AccentName | null>): Registry => ({
  "/d": Object.fromEntries(Object.entries(entries).map(([p, accent]) => [p, { ...EMPTY_ENTRY, accent }])),
});

// Calendar activity dots before project accents (the old projectColour hash in
// src/panels/calendar/model.ts), snapshotted before it moved here.
const KNOWN: [string, string][] = [
  ["/home/i4ctime/Develop/lab/kansei", "var(--t-blue)"],
  ["/home/i4ctime/Develop/products/aibou", "var(--t-cyan)"],
  ["/home/i4ctime/Develop/products/q-ring", "var(--t-yellow)"],
];

describe("Calendar dot colours", () => {
  it("stay the same for known paths", () => {
    for (const [path, colour] of KNOWN) expect(accentVar(accentFor(path, {}))).toBe(colour);
  });
});

describe("hashAccent", () => {
  it("is stable", () => {
    expect(hashAccent("/d/products/aibou")).toBe(hashAccent("/d/products/aibou"));
    expect(accentFor("/d/products/aibou", {})).toBe(hashAccent("/d/products/aibou"));
  });

  it("spreads paths over all six names", () => {
    const counts = new Map<AccentName, number>();
    for (let i = 0; i < 600; i++) {
      const a = hashAccent(`/home/u/Develop/group${i % 7}/project-${i}`);
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([...ACCENT_NAMES].sort());
    for (const n of counts.values()) expect(n).toBeGreaterThan(50);
  });
});

describe("accentFor", () => {
  it("the registry override wins, under any root", () => {
    const auto = hashAccent("/d/products/aibou");
    const other = ACCENT_NAMES.find((a) => a !== auto)!;
    expect(accentFor("/d/products/aibou", reg({ "/d/products/aibou": other }))).toBe(other);
    expect(accentFor("/d/products/aibou/", reg({ "/d/products/aibou": other }))).toBe(other);
    expect(accentFor("/d/products/aibou", reg({ "/d/products/aibou": null }))).toBe(auto);
    expect(accentFor("/d/products/aibou", reg({ "/d/products/niwa": other }))).toBe(auto);
  });

  it("names the terminal palette token", () => {
    expect(accentVar("magenta")).toBe("var(--t-magenta)");
  });
});

describe("tabProject", () => {
  it("finds the deepest project or subproject", () => {
    expect(tabProject("/d/products/aibou", tree)).toEqual({ path: "/d/products/aibou", name: "aibou" });
    expect(tabProject("/d/products/aibou/src/app", tree)).toEqual({ path: "/d/products/aibou", name: "aibou" });
    expect(tabProject("/d/sites/i4c-sites/apps/sparkle/src", tree)).toEqual({ path: "/d/sites/i4c-sites/apps/sparkle", name: "sparkle" });
    expect(tabProject("/d/sites/i4c-sites/packages/ui", tree)).toEqual({ path: "/d/sites/i4c-sites", name: "i4c-sites" });
    expect(tabProject("/d/products/ring/q-ring", tree)).toEqual({ path: "/d/products/ring/q-ring", name: "q-ring" });
    expect(tabProject("/d/marketing/aibou", tree)).toEqual({ path: "/d/marketing", name: "marketing" });
    expect(tabProject("/w/lab/kansei/src-tauri", tree)).toEqual({ path: "/w/lab/kansei", name: "kansei" });
  });

  it("ignores a trailing slash and does not match a name prefix", () => {
    expect(tabProject("/d/products/aibou/", tree)).toEqual({ path: "/d/products/aibou", name: "aibou" });
    expect(tabProject("/d/products/aibou-old", tree)).toBeNull();
  });

  it("is null outside every project", () => {
    expect(tabProject("/home/u", tree)).toBeNull();
    expect(tabProject("/d", tree)).toBeNull();
    expect(tabProject("/d/products", tree)).toBeNull();
    expect(tabProject("/d/products/aibou", null)).toBeNull();
    expect(tabProject("", tree)).toBeNull();
  });
});

describe("tabAccent", () => {
  it("uses the project, else the cwd and its basename", () => {
    expect(tabAccent("/d/products/aibou/src", tree, {})).toEqual({ path: "/d/products/aibou", name: "aibou", accent: hashAccent("/d/products/aibou") });
    expect(tabAccent("/tmp/scratch/", tree, {})).toEqual({ path: "/tmp/scratch", name: "scratch", accent: hashAccent("/tmp/scratch") });
    expect(tabAccent("/d/products/aibou", tree, reg({ "/d/products/aibou": "green" })).accent).toBe("green");
  });
});

describe("chipName", () => {
  it("keeps 18 characters, cutting longer names with an ellipsis", () => {
    expect(chipName("kansei")).toBe("kansei");
    expect(chipName("a".repeat(18))).toBe("a".repeat(18));
    expect(chipName("mineui_server_utils")).toBe("mineui_server_u...");
    expect(chipName("mineui_server_utils")).toHaveLength(18);
  });
});

describe("registry accent", () => {
  it("is read from workspaces.json, unknown names dropped", () => {
    const r = sanitizeRegistry({ "/d": { "/d/a": { accent: "cyan" }, "/d/b": { accent: "orange", description: "x" }, "/d/c": {} } });
    expect(r["/d"]["/d/a"].accent).toBe("cyan");
    expect(r["/d"]["/d/b"].accent).toBeNull();
    expect(r["/d"]["/d/c"].accent).toBeNull();
  });

  it("keeps an entry with only an accent, and drops it when set back to auto", () => {
    const set = withEntry({ "/d": {} }, "/d", "/d/a", { accent: "red" });
    expect(set["/d"]["/d/a"]).toEqual({ ...EMPTY_ENTRY, accent: "red" });
    expect(withEntry(set, "/d", "/d/a", { accent: null })["/d"]).toEqual({});
  });
});
