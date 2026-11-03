import { describe, expect, it } from "vitest";
import type { BoardItem, WorkspaceNode } from "../../lib/ipc";
import { areaProject, filterItems, isOverdue, itemProject, laneGroups, laneItems, laneOf, patchItem, withItem } from "./model";

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
    node("/d/products", "group", [
      node("/d/products/aibou", "project"),
      node("/d/products/cryo", "group", [node("/d/products/cryo", "project")]),
      node("/d/products/ring", "group", [node("/d/products/q-ring", "project")]),
    ]),
    node("/d/sites", "group", [node("/d/sites/i4c-sites", "project", [node("/d/sites/i4c-sites/apps/cryo", "subproject"), node("/d/sites/i4c-sites/apps/Tanko", "subproject")])]),
    node("/d/lab", "group", [node("/d/lab/Tsukue", "project")]),
  ]),
];

describe("areaProject", () => {
  it("matches the basename case-insensitively, projects before subprojects", () => {
    expect(areaProject("aibou", tree, {})).toBe("/d/products/aibou");
    expect(areaProject("tsukue", tree, {})).toBe("/d/lab/Tsukue");
    expect(areaProject("Q-Ring", tree, {})).toBe("/d/products/q-ring");
    expect(areaProject("cryo", tree, {})).toBe("/d/products/cryo");
    expect(areaProject("tanko", tree, {})).toBe("/d/sites/i4c-sites/apps/Tanko");
  });

  it("falls back to a registry entry, then null", () => {
    const registry = { "/d": { "/d/products/mcp-lookout": { description: "x", status: null, related: [] }, "/d/games/deathbell": { description: "", status: "parked" as const, related: [] } } };
    expect(areaProject("deathbell", tree, registry)).toBe("/d/games/deathbell");
    expect(areaProject("sites", tree, registry)).toBeNull();
    expect(areaProject("lookout", tree, registry)).toBeNull();
    expect(areaProject(null, tree, registry)).toBeNull();
    expect(areaProject("  ", tree, registry)).toBeNull();
  });
});

const item = (over: Partial<BoardItem>): BoardItem => ({
  itemId: "I",
  number: 1,
  repo: "I4cTime/aibou",
  title: "t",
  url: "",
  state: "open",
  closedAt: null,
  isPr: false,
  status: "Ready",
  kind: "Task",
  area: null,
  scheduled: null,
  started: null,
  target: null,
  order: null,
  doneWhen: null,
  outcome: null,
  parent: null,
  subIssues: { total: 0, completed: 0 },
  ...over,
});

describe("board helpers", () => {
  const epic = item({ itemId: "E", number: 20, repo: "I4cTime/focus", title: "Aibou app", kind: "Epic", area: "aibou", status: "In progress" });
  const t1 = item({ itemId: "T1", number: 12, title: "Refund test", parent: { repo: "I4cTime/focus", number: 20 }, order: 2 });
  const t2 = item({ itemId: "T2", number: 13, title: "Landing", parent: { repo: "I4cTime/focus", number: 20 }, order: 1 });
  const t3 = item({ itemId: "T3", number: 5, repo: "I4cTime/niwa", title: "Lost epic", parent: { repo: "I4cTime/focus", number: 99 } });
  const done = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => item({ itemId: `D${n}`, number: 100 + n, status: "Done", state: "closed", closedAt: `2026-10-${String(n + 10).padStart(2, "0")}T00:00:00Z` }));
  const all = [epic, t1, t2, t3, ...done];

  it("groups tasks under their epic, the rest under No epic", () => {
    const ready = laneItems(all, "Ready");
    expect(ready.map((i) => i.itemId)).toEqual(["T2", "T1", "T3"]);
    const groups = laneGroups(ready, all);
    expect(groups.map((g) => g.title)).toEqual(["Aibou app", "No epic"]);
    expect(groups[0].items.map((i) => i.itemId)).toEqual(["T2", "T1"]);
    expect(laneGroups(laneItems(all, "In progress"), all)[0]).toMatchObject({ key: "epics", title: null });
  });

  it("caps Done at the ten newest", () => {
    const d = laneItems(all, "Done");
    expect(d).toHaveLength(10);
    expect(d[0].itemId).toBe("D12");
    expect(laneItems(all, "Done", false)).toHaveLength(12);
  });

  it("filters by kind and search", () => {
    expect(filterItems(all, "epics", "").map((i) => i.itemId)).toEqual(["E"]);
    expect(filterItems(all, "tasks", "niwa").map((i) => i.itemId)).toEqual(["T3"]);
    expect(filterItems(all, "all", "#12").map((i) => i.itemId)).toEqual(["T1"]);
    expect(filterItems(all, "all", "aibou app").map((i) => i.itemId)).toEqual(["E"]);
  });

  it("knows lanes, overdue dates and item projects", () => {
    expect(laneOf(item({ status: null }))).toBe("Backlog");
    expect(laneOf(item({ status: null, state: "closed" }))).toBe("Done");
    expect(isOverdue(item({ scheduled: "2026-10-31" }), "2026-11-01")).toBe(true);
    expect(isOverdue(item({ scheduled: "2026-10-31", status: "Done" }), "2026-11-01")).toBe(false);
    expect(isOverdue(item({ scheduled: "2026-11-01" }), "2026-11-01")).toBe(false);
    expect(itemProject(epic, tree, {})).toBe("/d/products/aibou");
    expect(itemProject(t3, tree, {})).toBeNull();
    expect(itemProject(item({ repo: "I4cTime/q-ring" }), tree, {})).toBe("/d/products/q-ring");
  });

  it("patches and replaces items for optimistic writes", () => {
    expect(patchItem(t1, "status", "Done").status).toBe("Done");
    expect(patchItem(t1, "scheduled", "2026-11-03").scheduled).toBe("2026-11-03");
    expect(patchItem(t1, "scheduled", null).scheduled).toBeNull();
    expect(patchItem(t1, "order", 4).order).toBe(4);
    const snap = withItem({ fetchedAt: "", items: [t1], error: null, areas: [] }, { ...t1, title: "new" });
    expect(snap.items.map((i) => i.title)).toEqual(["new"]);
    expect(withItem(null, t2).items).toEqual([t2]);
  });
});
