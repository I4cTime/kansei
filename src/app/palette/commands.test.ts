import { describe, expect, it, vi } from "vitest";
import type { BoardItem, BoardSnapshot, SearchHit, Session, WorkspaceNode } from "../../lib/ipc";
import type { Tab } from "../tabState";
import { boardCommands, buildCommands, panelCommands, projectCommands, sessionCommands, tabCommands, themeCommands, transcriptCommands, type PaletteActions, type PaletteInput } from "./commands";
import { GROUP_ORDER, pushRecent, rank } from "./fuzzy";

const act = (): PaletteActions => ({
  activateTab: vi.fn(),
  newTab: vi.fn(),
  newShellTab: vi.fn(),
  closeTab: vi.fn(),
  restartTab: vi.fn(),
  renameTab: vi.fn(),
  splitWith: vi.fn(),
  unsplit: vi.fn(),
  openPanel: vi.fn(),
  toggleSidebar: vi.fn(),
  openProject: vi.fn(),
  openProjectWith: vi.fn(),
  resumeSession: vi.fn(),
  setBoardStatus: vi.fn(),
  refreshBoard: vi.fn(),
  setTheme: vi.fn(),
  toggleEffects: vi.fn(),
  toggleClaudeTheme: vi.fn(),
});

const HOME = "/home/me";
const tab = (key: string, title: string, cwd: string, status: Tab["status"] = "alive"): Tab => ({
  id: status === "alive" ? `pty-${key}` : null,
  key,
  title,
  cwd,
  command: "claude",
  args: [],
  status,
  exitCode: null,
  error: null,
  pid: null,
});

describe("tabCommands", () => {
  const tabs = [tab("a", "q-ring", "/home/me/Develop/products/q-ring"), tab("b", "kansei", "/home/me/Develop/lab/kansei"), tab("c", "~", HOME)];

  it("lists Switch to per tab with the active one last, then the tab actions", () => {
    const list = tabCommands(tabs, "b", HOME, act());
    expect(list.map((c) => c.id)).toEqual(["tab:a", "tab:c", "tab:b", "tab:new", "tab:new-shell", "tab:close", "tab:restart", "tab:rename", "split:a", "split:c"]);
    expect(list[0]).toMatchObject({ group: "Tabs", title: "Switch to q-ring", hint: "~/Develop/products/q-ring" });
    expect(list[1].hint).toBe("~");
    expect(list.find((c) => c.id === "tab:new-shell")!.hint).toBe("~/Develop/lab/kansei");
  });

  it("acts on the active tab; Restart only for a dead one", () => {
    const a = act();
    const list = tabCommands(tabs, "b", HOME, a);
    const byId = (id: string) => list.find((c) => c.id === id)!;
    expect(byId("tab:restart").disabled).toBe("Still running");
    expect(byId("tab:close").disabled).toBeUndefined();
    void byId("tab:a").run();
    void byId("tab:close").run();
    void byId("tab:rename").run();
    void byId("tab:new-shell").run();
    expect(a.activateTab).toHaveBeenCalledWith("a");
    expect(a.closeTab).toHaveBeenCalledWith("b");
    expect(a.renameTab).toHaveBeenCalledWith("b");
    expect(a.newShellTab).toHaveBeenCalledWith("/home/me/Develop/lab/kansei");
    const dead = tabCommands([tab("d", "dead", "/x", "dead")], "d", HOME, a);
    expect(dead.find((c) => c.id === "tab:restart")!.disabled).toBeUndefined();
  });

  it("offers Split with per other tab and Close the right pane while split", () => {
    const a = act();
    const list = tabCommands(tabs, "b", HOME, a, "c");
    const split = list.filter((c) => c.id.startsWith("split:"));
    expect(split.map((c) => [c.id, c.title, c.disabled ?? null])).toEqual([
      ["split:a", "Split with q-ring", null],
      ["split:c", "Split with ~", "Already on the right"],
      ["split:close", "Close the right pane", null],
    ]);
    expect(split[0].hint).toBe("~/Develop/products/q-ring");
    void split[0].run();
    void split[2].run();
    expect(a.splitWith).toHaveBeenCalledWith("a");
    expect(a.unsplit).toHaveBeenCalled();
    expect(tabCommands(tabs, "b", HOME, a).some((c) => c.id === "split:close")).toBe(false);
  });

  it("disables the active-tab actions without tabs", () => {
    const list = tabCommands([], null, HOME, act());
    expect(list.map((c) => [c.id, c.disabled ?? null])).toEqual([
      ["tab:new", null],
      ["tab:new-shell", null],
      ["tab:close", "No tab open"],
      ["tab:restart", "No tab open"],
      ["tab:rename", "No tab open"],
    ]);
  });
});

describe("panelCommands", () => {
  it("opens each panel with its shortcut as the hint, then Toggle sidebar", () => {
    const a = act();
    const panels = ["projects", "board", "calendar", "sessions", "memory", "rules", "mcps", "agents", "skills", "workflows", "hooks", "settings"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
    const list = panelCommands(panels, a);
    expect(list).toHaveLength(13);
    expect(list[0]).toMatchObject({ id: "panel:projects", title: "Open Projects", hint: "Ctrl+Shift+1" });
    expect(list[9].hint).toBe("Ctrl+Shift+0");
    expect(list[10]).toMatchObject({ id: "panel:hooks", hint: "Ctrl+Shift+H" });
    expect(list[11]).toMatchObject({ id: "panel:settings", title: "Open Settings", hint: "Ctrl+Shift+," });
    expect(list[12]).toMatchObject({ id: "sidebar:toggle", title: "Toggle sidebar" });
    void list[11].run();
    void list[12].run();
    expect(a.openPanel).toHaveBeenCalledWith("settings");
    expect(a.toggleSidebar).toHaveBeenCalled();
  });
});

const FLAGS = { claudeMd: false, claudeDir: false, mcpJson: false, git: true, worktree: false };
const node = (path: string, kind: WorkspaceNode["kind"], children: WorkspaceNode[] = []): WorkspaceNode => ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind, flags: FLAGS, children });
const tree: WorkspaceNode[] = [
  node("/d", "root", [
    node("/d/marketing", "project"),
    node("/d/products", "group", [node("/d/products/aibou", "project"), node("/d/products/niwa", "project")]),
    node("/d/sites", "group", [node("/d/sites/i4c-sites", "project", [node("/d/sites/i4c-sites/apps/niwa", "subproject")])]),
  ]),
];
const registry = { "/d": { "/d/products/niwa": { description: "plants", status: null, related: ["/d/products/aibou"] } } };

describe("projectCommands", () => {
  it("opens every project and subproject (not roots or groups), hint relative to the root", () => {
    const list = projectCommands(tree, registry, act());
    expect(list.map((c) => c.id)).toEqual([
      "project:/d/marketing",
      "project:/d/products/aibou",
      "project:/d/products/niwa",
      "project-related:/d/products/niwa",
      "project:/d/sites/i4c-sites",
      "project:/d/sites/i4c-sites/apps/niwa",
    ]);
    expect(list[2]).toMatchObject({ group: "Projects", title: "Open niwa", hint: "products/niwa" });
    expect(list[3]).toMatchObject({ title: "Open niwa with related", hint: "products/niwa" });
    expect(list[5].hint).toBe("sites/i4c-sites/apps/niwa");
  });

  it("runs claude in the folder, or the Open with sheet with the related projects", () => {
    const a = act();
    const list = projectCommands(tree, registry, a);
    void list[1].run();
    expect(a.openProject).toHaveBeenCalledWith("/d/products/aibou", "aibou");
    void list[3].run();
    expect(a.openProjectWith).toHaveBeenCalledWith(expect.objectContaining({ root: "/d", rel: "products/niwa" }), ["/d/products/aibou"]);
  });
});

const NOW = new Date(2026, 10, 3, 12, 0).getTime();
const session = (id: string, minutesAgo: number, live = false, project: string | null = "/home/me/Develop/products/aibou"): Session => ({
  id,
  project,
  title: `prompt ${id}`,
  firstTs: null,
  lastTs: NOW - minutesAgo * 60_000,
  prompts: 1,
  transcriptPath: null,
  transcriptBytes: 0,
  live: live ? { pid: 1, status: "busy", name: null, cwd: null } : null,
});

describe("sessionCommands", () => {
  it("lists the 40 most recent, newest first, live ones disabled", () => {
    const a = act();
    const list = [session("old", 300), session("live", 2, true), ...Array.from({ length: 45 }, (_, i) => session(`s${i}`, 10 + i))];
    const cmds = sessionCommands(list, NOW, HOME, a);
    expect(cmds).toHaveLength(40);
    expect(cmds[0]).toMatchObject({ id: "session:live", group: "Sessions", title: "Resume prompt live", hint: "aibou - 2 min ago", disabled: "Already running" });
    expect(cmds[1]).toMatchObject({ id: "session:s0", hint: "aibou - 10 min ago" });
    expect(cmds[1].disabled).toBeUndefined();
    expect(cmds.some((c) => c.id === "session:old")).toBe(false);
    void cmds[1].run();
    expect(a.resumeSession).toHaveBeenCalledWith(list[2]);
    expect(sessionCommands([session("h", 1, false, HOME)], NOW, HOME, a)[0].hint).toBe("~ - 1 min ago");
  });

  it("is empty before the sessions are loaded", () => {
    expect(sessionCommands(null, NOW, HOME, act())).toEqual([]);
  });
});

describe("transcriptCommands", () => {
  const hit = (sessionId: string, snippet = "the \u0001hidden workspace\u0002 idea"): SearchHit => ({
    sessionId,
    project: "/p",
    title: `title ${sessionId}`,
    ts: NOW,
    role: "user",
    snippet,
    hits: 2,
    transcriptPath: `/t/${sessionId}.jsonl`,
  });

  it("resumes the hit's session, at most 5, live ones disabled, hint = snippet start", () => {
    const a = act();
    const list = [session("live", 2, true), session("known", 5)];
    const hits = [hit("known"), hit("live"), hit("unknown", "x".repeat(80)), hit("d"), hit("e"), hit("f")];
    const cmds = transcriptCommands(hits, list, a);
    expect(cmds.map((c) => c.id)).toEqual(["transcript:known", "transcript:live", "transcript:unknown", "transcript:d", "transcript:e"]);
    expect(cmds[0]).toMatchObject({ group: "Transcripts", title: "Resume title known", hint: "the hidden workspace idea" });
    expect(cmds[0].disabled).toBeUndefined();
    expect(cmds[1].disabled).toBe("Already running");
    expect(cmds[2].hint).toBe(`${"x".repeat(60)}...`);
    void cmds[0].run();
    expect(a.resumeSession).toHaveBeenCalledWith(list[1]);
    void cmds[2].run();
    expect(a.resumeSession).toHaveBeenLastCalledWith(expect.objectContaining({ id: "unknown", project: "/p", live: null, transcriptPath: "/t/unknown.jsonl" }));
    expect(transcriptCommands([hit("z")], null, a)[0].disabled).toBeUndefined();
  });
});

const item = (n: number, status: BoardItem["status"], kind: BoardItem["kind"] = "Task", state: BoardItem["state"] = "open"): BoardItem => ({
  itemId: `PVTI_${n}`,
  number: n,
  repo: "I4cTime/aibou",
  title: `task ${n}`,
  url: "",
  state,
  closedAt: null,
  isPr: false,
  status,
  kind,
  area: "aibou",
  scheduled: null,
  started: null,
  target: null,
  order: null,
  doneWhen: null,
  outcome: null,
  parent: null,
  subIssues: { total: 0, completed: 0 },
});
const snapshot: BoardSnapshot = {
  fetchedAt: "2026-11-03T10:00:00Z",
  error: null,
  areas: [],
  items: [item(1, "Backlog"), item(2, "Ready"), item(3, "In progress"), item(4, "In review"), item(5, "Done", "Task", "closed"), item(6, "Ready", "Epic"), item(7, null, "Task", "closed")],
};

describe("boardCommands", () => {
  it("offers the lane moves for tasks and Refresh board", async () => {
    const a = act();
    const list = boardCommands(true, snapshot, a);
    expect(list.map((c) => [c.id, c.title, c.hint ?? null])).toEqual([
      ["board:start:PVTI_2", "Start task 2", "aibou#2"],
      ["board:review:PVTI_3", "Review task 3", "aibou#3"],
      ["board:finish:PVTI_3", "Finish task 3", "aibou#3"],
      ["board:finish:PVTI_4", "Finish task 4", "aibou#4"],
      ["board:refresh", "Refresh board", null],
    ]);
    await list[0].run();
    await list[2].run();
    await list[4].run();
    expect(a.setBoardStatus).toHaveBeenNthCalledWith(1, snapshot.items[1], "In progress");
    expect(a.setBoardStatus).toHaveBeenNthCalledWith(2, snapshot.items[2], "Done");
    expect(a.refreshBoard).toHaveBeenCalled();
  });

  it("is empty without a connected board or a snapshot", () => {
    expect(boardCommands(false, snapshot, act())).toEqual([]);
    expect(boardCommands(true, null, act())).toEqual([]);
  });
});

describe("themeCommands", () => {
  const presets = [
    { id: "night-city", name: "Night City" },
    { id: "grid", name: "The Grid" },
  ];

  it("lists the sources and presets with the active one hinted, then the toggles", () => {
    const a = act();
    const list = themeCommands({ theme: "preset:grid", effects: true, claudeTheme: false }, presets, a);
    expect(list.map((c) => [c.id, c.title, c.hint ?? null])).toEqual([
      ["theme:system", "Theme: Match system", null],
      ["theme:dark", "Theme: Dark", null],
      ["theme:light", "Theme: Light", null],
      ["theme:omarchy", "Theme: Follow Omarchy", null],
      ["theme:preset:night-city", "Theme: Night City", null],
      ["theme:preset:grid", "Theme: The Grid", "active"],
      ["theme:effects", "Toggle visual effects", "on"],
      ["theme:claude", "Toggle Claude Code theme", "off"],
    ]);
    void list[4].run();
    void list[6].run();
    void list[7].run();
    expect(a.setTheme).toHaveBeenCalledWith("preset:night-city");
    expect(a.toggleEffects).toHaveBeenCalled();
    expect(a.toggleClaudeTheme).toHaveBeenCalled();
    expect(themeCommands({ theme: "system", effects: false, claudeTheme: true }, presets, a)[0].hint).toBe("active");
  });
});

describe("buildCommands", () => {
  const input: PaletteInput = {
    tabs: [tab("a", "q-ring", "/home/me/q-ring")],
    activeKey: "a",
    home: HOME,
    panels: [
      { id: "projects", label: "Projects" },
      { id: "settings", label: "Settings" },
    ],
    tree,
    registry,
    sessions: [session("s1", 5)],
    now: NOW,
    boardConnected: true,
    snapshot,
    theme: { theme: "dark", effects: true, claudeTheme: false },
    presets: [{ id: "grid", name: "The Grid" }],
  };

  it("keeps the groups in order with unique, stable ids", () => {
    const one = buildCommands(input, act());
    const two = buildCommands({ ...input, now: NOW + 60_000 }, act());
    const groups = [...new Set(one.map((c) => c.group))];
    expect(groups).toEqual(GROUP_ORDER);
    expect(new Set(one.map((c) => c.id)).size).toBe(one.length);
    expect(two.map((c) => c.id)).toEqual(one.map((c) => c.id));
  });

  it("puts recent commands first for the empty query and ranks a typed one", () => {
    const list = buildCommands(input, act());
    let recent: string[] = [];
    for (const id of ["panel:settings", "theme:dark", "project:/d/products/niwa", "panel:settings"]) recent = pushRecent(recent, id);
    expect(rank(list, "", recent).slice(0, 3).map((c) => c.id)).toEqual(["panel:settings", "project:/d/products/niwa", "theme:dark"]);
    expect(rank(list, "sett")[0].id).toBe("panel:settings");
    // All three are keyword prefixes (100) in Projects, so the title decides; equal titles keep tree order.
    expect(rank(list, "niwa").slice(0, 3).map((c) => c.id)).toEqual(["project:/d/products/niwa", "project:/d/sites/i4c-sites/apps/niwa", "project-related:/d/products/niwa"]);
  });
});
