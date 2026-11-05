// Typed wrappers over Tauri invoke/listen. Shared contract, see CONTRACT.md.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Paths = {
  home: string;
  claudeDir: string;
  claudeJson: string;
  settings: string;
  settingsLocal: string;
  agentsDir: string;
  skillsDir: string;
  workflowsDir: string;
  projectsDir: string;
  appData: string;
};

export type Entry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedMs: number;
};

export type MemoryProject = {
  encoded: string;
  dir: string; // .../projects/<encoded>/memory
  guessedPath: string | null;
  fileCount: number;
  hasIndex: boolean; // MEMORY.md present
};

/** "project" = projects.<path>.mcpServers in ~/.claude.json; "projectFile" = <root>/.mcp.json. */
export type McpScope = "user" | "project" | "projectFile";
export type McpServer = {
  scope: McpScope;
  project?: string;
  name: string;
  config: Record<string, unknown>;
};

/** mcp_extras result (CONTRACT.md "MCPs"): read-only servers Claude Code also loads. */
export type McpPluginServer = {
  plugin: string;
  marketplace: string | null;
  version: string | null;
  scope: string | null;
  projectPath: string | null;
  /** enabledPlugins["<plugin>@<marketplace>"] in ~/.claude/settings.json; null when not set. */
  enabled: boolean | null;
  name: string;
  config: Record<string, unknown>;
  /** The plugin's .mcp.json (always under ~/.claude/plugins). */
  file: string;
  needsAuth: boolean;
};
export type McpConnector = { name: string; needsAuth: boolean };
export type McpBuiltin = { name: string; note: string };
export type McpExtras = { plugins: McpPluginServer[]; connectors: McpConnector[]; builtins: McpBuiltin[] };

/** project_root result (CONTRACT.md "Project scope"). `root` is canonical. */
export type ProjectInfo = {
  root: string;
  exists: {
    agents: boolean;
    skills: boolean;
    rules: boolean;
    settings: boolean;
    settingsLocal: boolean;
    mcpJson: boolean;
    claudeMd: boolean;
    claudeLocalMd: boolean;
  };
};

/** pid is the pty child's pid (null if the platform did not report one). */
export type PtyInfo = { id: string; cwd: string; command: string; alive: boolean; pid?: number | null };

/** One Claude Code session (CONTRACT.md "Sessions"). Timestamps are epoch ms. */
export type Session = {
  id: string;
  /** Real project path from history, the live cwd, or decoded from the transcript dir. */
  project: string | null;
  /** First prompt (trimmed to 120 chars) or "(no prompt recorded)". */
  title: string;
  firstTs: number | null;
  lastTs: number;
  prompts: number;
  transcriptPath: string | null;
  transcriptBytes: number;
  live: { pid: number; status: string | null; name: string | null; cwd: string | null } | null;
};

/** projects_info result (CONTRACT.md "Projects"): stat-only facts about one folder. */
export type ProjectsInfo = {
  path: string;
  /** Symlinks resolved; null when the folder does not exist. */
  canonical: string | null;
  /** True when the path is a directory. */
  exists: boolean;
  /** worktree: `.git` is a file starting with `gitdir:` (a git worktree). */
  flags: { claudeMd: boolean; claudeDir: boolean; mcpJson: boolean; git: boolean; worktree: boolean };
};

/** workspace_scan node (CONTRACT.md "Workspaces"). Paths are absolute, joined from the root as given. */
export type WorkspaceKind = "root" | "group" | "project" | "subproject";
export type WorkspaceNode = {
  path: string;
  name: string;
  kind: WorkspaceKind;
  flags: ProjectsInfo["flags"];
  children: WorkspaceNode[];
};

/** Board lanes (the Status field), in order. */
export type BoardStatus = "Backlog" | "Ready" | "In progress" | "In review" | "Done";
export type BoardKind = "Epic" | "Task";
/** One item of the connected GitHub Project (CONTRACT.md "Board and Calendar"). Dates are YYYY-MM-DD. */
export type BoardItem = {
  itemId: string;
  number: number;
  /** "owner/name" */
  repo: string;
  title: string;
  url: string;
  state: "open" | "closed";
  closedAt: string | null;
  isPr: boolean;
  status: BoardStatus | null;
  kind: BoardKind | null;
  area: string | null;
  scheduled: string | null;
  started: string | null;
  target: string | null;
  order: number | null;
  doneWhen: string | null;
  outcome: string | null;
  /** The epic, for tasks. */
  parent: { repo: string; number: number } | null;
  subIssues: { total: number; completed: number };
};
/** fetchedAt is ISO UTC ("" when never fetched); areas are the Area field's options in board order. */
export type BoardSnapshot = { fetchedAt: string; items: BoardItem[]; error: string | null; areas: string[] };
export type BoardField = "status" | "kind" | "area" | "scheduled" | "order" | "started" | "target" | "doneWhen" | "outcome";
/** The connected GitHub Project (prefs.json `board`, CONTRACT.md "Board configuration"). */
export type BoardConfig = {
  /** GitHub user or organisation login. */
  owner: string;
  /** The N in github.com/users/<owner>/projects/N. */
  projectNumber: number;
  /** "owner/name": where epics are created (Kind = Epic). */
  hubRepo: string;
  /** Resolved node id, PVT_... */
  projectId: string;
  /** Resolved project URL. */
  url: string;
  /** Resolved project title. */
  title: string;
};
/** board_configure: the resolved config and what the project lacks of the conventions. */
export type BoardSetup = {
  config: BoardConfig;
  /** Required fields the project lacks (or has with another type). */
  missingFields: string[];
  /** Field -> required option names it lacks. */
  missingOptions: Record<string, string[]>;
};
export type GhStatus = { available: boolean; login: string | null; scopes: string[]; error: string | null };
export type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type DayPlan = { area: string | null; note: string };
export type Schedule = {
  rhythm: Record<WeekdayKey, DayPlan>;
  /** "YYYY-MM-DD" -> plan; an override wins over the rhythm. */
  overrides: Record<string, DayPlan>;
};
/** Prompt counts per project path for one local day. */
export type ActivityDay = { date: string; projects: Record<string, number> };

export const pty = {
  spawn: (a: { cwd: string; command: string; args: string[]; cols: number; rows: number }) =>
    invoke<{ id: string; pid?: number | null }>("pty_spawn", a),
  write: (id: string, data: string) => invoke<null>("pty_write", { id, data }),
  resize: (id: string, cols: number, rows: number) => invoke<null>("pty_resize", { id, cols, rows }),
  kill: (id: string) => invoke<null>("pty_kill", { id }),
  list: () => invoke<PtyInfo[]>("pty_list"),
  onData: (cb: (e: { id: string; data: string }) => void): Promise<UnlistenFn> =>
    listen<{ id: string; data: string }>("pty:data", (ev) => cb(ev.payload)),
  onExit: (cb: (e: { id: string; code: number | null }) => void): Promise<UnlistenFn> =>
    listen<{ id: string; code: number | null }>("pty:exit", (ev) => cb(ev.payload)),
};

export const files = {
  paths: () => invoke<Paths>("claude_paths"),
  readText: (path: string) => invoke<string>("fs_read_text", { path }),
  writeText: (path: string, content: string) => invoke<null>("fs_write_text", { path, content }),
  remove: (path: string) => invoke<null>("fs_delete", { path }),
  list: (path: string) => invoke<Entry[]>("fs_list", { path }),
  exists: (path: string) => invoke<boolean>("fs_exists", { path }),
  mkdir: (path: string) => invoke<null>("fs_mkdir", { path }),
  /** Absolute path to a regular file (symlinks followed) with an execute bit. Stat only, no allowlist. */
  executable: (path: string) => invoke<boolean>("file_executable", { path }),
};

export const memory = {
  projects: () => invoke<MemoryProject[]>("memory_projects"),
};

export const sessions = {
  list: () => invoke<Session[]>("sessions_list"),
};

/** search_index_refresh and usage_refresh result (CONTRACT.md "Session search", "Usage"). `bytes` is the index size on disk. */
export type IndexStatus = { files: number; indexed: number; skipped: number; bytes: number; tookMs: number; sessions: number };

/** One session's latest matching record. The snippet marks matches with \u0001 ... \u0002. */
export type SearchHit = {
  sessionId: string;
  project: string | null;
  title: string;
  ts: number;
  role: "user" | "assistant";
  snippet: string;
  hits: number;
  transcriptPath: string;
};

export const search = {
  /** Bring the transcript text index (app data dir) up to date; incremental after the first run. */
  refresh: () => invoke<IndexStatus>("search_index_refresh"),
  /** Words AND-ed, "quoted phrases" literal, case-insensitive; one hit per session, latest first (limit default 50). */
  query: (a: { query: string; limit?: number }) => invoke<SearchHit[]>("search_sessions", a),
};

/** Tokens of a set of assistant turns (CONTRACT.md "Usage"). */
export type UsageBucket = { turns: number; input: number; cacheCreate: number; cacheRead: number; output: number };

/** One local day with at least one turn. */
export type UsageDay = {
  date: string;
  total: UsageBucket;
  /** Project path ("" when unknown) as sessions_list resolves it. */
  projects: Record<string, UsageBucket>;
  models: Record<string, UsageBucket>;
};

export const usage = {
  /** Bring the usage index (app data dir) up to date; incremental after the first run. */
  refresh: () => invoke<IndexStatus>("usage_refresh"),
  /** Inclusive local-date range, at most 400 days; only days with turns, ascending. */
  days: (from: string, to: string) => invoke<UsageDay[]>("usage_days", { from, to }),
};

export const projects = {
  /** Stat each absolute path (max 500 per call; relative paths are skipped). Registers nothing. */
  info: (paths: string[]) => invoke<ProjectsInfo[]>("projects_info", { paths }),
};

export const workspace = {
  /** Scan workspace roots into trees; registers every root, project and subproject as a project root. */
  scan: (roots: string[]) => invoke<WorkspaceNode[]>("workspace_scan", { roots }),
  /** Create <root>/CLAUDE.md importing @PROJECTS.md, or append the import once. Scanned roots only. */
  claudeMd: (root: string) => invoke<"created" | "amended" | "unchanged">("workspace_claude_md", { root }),
  /**
   * Set the workspace entries of permissions.additionalDirectories in <project>/.claude/settings.json:
   * `dirs` present, `managed` entries not in `dirs` removed, everything else kept. Returns the array.
   */
  additionalDirs: (project: string, dirs: string[], managed: string[]) =>
    invoke<string[]>("project_additional_dirs", { project, dirs, managed }),
};

export const project = {
  /** Walk up from cwd to the project root; also opens that root in the files allowlist. */
  root: (cwd: string) => invoke<ProjectInfo>("project_root", { cwd }),
};

export const mcp = {
  /** With `project` (a root from project.root) the list also has that root's .mcp.json servers. */
  list: (project?: string) => invoke<McpServer[]>("mcp_list", project ? { project } : {}),
  upsert: (s: McpServer) => invoke<null>("mcp_upsert", s),
  remove: (s: { scope: McpScope; project?: string; name: string }) => invoke<null>("mcp_remove", s),
  /** Plugin servers, claude.ai connectors and built-ins. Read only. */
  extras: () => invoke<McpExtras>("mcp_extras"),
};

/** One probe result (CONTRACT.md "MCP health"). */
export type McpHealthStatus = "ok" | "auth" | "failed" | "timeout" | "skipped";
export type McpHealth = {
  /** "<scope>|<project or ''>|<name>". */
  key: string;
  status: McpHealthStatus;
  /** stderr tail (last 2 KB), HTTP status, spawn error, or why it was skipped. */
  detail: string | null;
  /** Handshake latency; null when nothing ran. */
  ms: number | null;
  /** From the initialize result (stdio servers). */
  serverInfo: { name: string; version: string | null } | null;
  /** Epoch ms. */
  checkedAt: number;
};
/**
 * What to probe: an McpServer, a plugin server (scope "plugin", project "<plugin>@<marketplace>") or a claude.ai
 * connector (scope "connector", always skipped).
 */
export type McpHealthTarget = { scope: string; project?: string; name: string; config: Record<string, unknown> };

export const mcpHealth = {
  /** Probes three at a time (8 s timeout each); every result also fires mcp:health. Merged into mcp-health.json. */
  check: (servers: McpHealthTarget[]) => invoke<McpHealth[]>("mcp_health_check", { servers }),
  /** <appData>/mcp-health.json, every key ever checked. */
  cached: () => invoke<McpHealth[]>("mcp_health_cached"),
  onResult: (cb: (h: McpHealth) => void): Promise<UnlistenFn> => listen<McpHealth>("mcp:health", (ev) => cb(ev.payload)),
};

export const board = {
  /** `gh auth status` (gh runs without GITHUB_TOKEN). */
  ghStatus: () => invoke<GhStatus>("gh_status"),
  /**
   * Fetch and cache the board; without force a snapshot younger than 60 s comes back as is. Errors are in `error`
   * ("Board not configured" without a config, with no items).
   */
  fetch: (force = false) => invoke<BoardSnapshot>("board_fetch", { force }),
  /** board.json, or the "Board not configured" snapshot without a config. */
  cached: () => invoke<BoardSnapshot | null>("board_cached"),
  /** Single-select values are option names; null clears. Writes to GitHub. */
  setField: (itemId: string, field: BoardField, value: string | number | null) => invoke<BoardItem>("board_set_field", { itemId, field, value }),
  /** gh issue create, sub-issue of `epic`, added to the board as a Task. Writes to GitHub. */
  createTask: (a: { repo: string; title: string; body: string; epic: { repo: string; number: number } | null; scheduled: string | null }) =>
    invoke<BoardItem>("board_create_task", a),
  /** An epic in the configured hub repo. Writes to GitHub. */
  createEpic: (a: { title: string; body: string; area: string | null; doneWhen: string | null }) => invoke<BoardItem>("board_create_epic", a),
  /**
   * Resolve a user's or organisation's Project v2 and check its fields. Saves
   * nothing: the caller puts `config` into prefs. Rejects when the project
   * cannot be resolved.
   */
  configure: (a: { owner: string; projectNumber: number; hubRepo: string }) => invoke<BoardSetup>("board_configure", a),
};

export const schedule = {
  read: () => invoke<Schedule>("schedule_read"),
  /** Writes schedule.json, then SCHEDULE.md; returns the schedule as saved. */
  write: (s: Schedule) => invoke<Schedule>("schedule_write", { schedule: s }),
  /** Renders SCHEDULE.md into the first workspace root; returns its path. */
  render: () => invoke<string>("schedule_render"),
  /** Inclusive local-date range, at most 400 days. */
  activity: (from: string, to: string) => invoke<ActivityDay[]>("activity_days", { from, to }),
};

/** Raw `colors.toml` strings of the live Omarchy theme. */
export type OmarchyTheme = { name: string; palette: Record<string, string> };

export const theme = {
  /** The live Omarchy theme, null when Omarchy or its files are missing. */
  omarchy: () => invoke<OmarchyTheme | null>("theme_omarchy"),
  /** Fires when theme.name or colors.toml changes, appears or vanishes (polled every 2 s). */
  onOmarchy: (cb: (t: OmarchyTheme | null) => void): Promise<UnlistenFn> =>
    listen<OmarchyTheme | null>("theme:omarchy", (ev) => cb(ev.payload)),
  /** Writes ~/.config/omarchy/themes/<slug>/; with apply runs `omarchy theme set <slug>` detached. Returns the theme dir. */
  exportOmarchy: (a: { slug: string; name: string; palette: Record<string, string>; apply: boolean }) =>
    invoke<string>("theme_export_omarchy", a),
};

/** What a tab's Claude session is doing (CONTRACT.md "Tab status and context gauge"). */
export type TabActivity = {
  /** The tab's pty child pid (Tab.pid). */
  pid: number;
  sessionId: string;
  status: "busy" | "waiting" | "idle";
  /**
   * Why it waits, when known: "permission prompt", "input needed", "sandbox request", "worker request",
   * "dialog open", or "turn finished" for the idle-after-busy rule.
   */
  waitingFor: string | null;
  /** Epoch ms. */
  statusUpdatedAt: number;
  /** null until the first assistant turn. tokens = input + cache creation + cache read. */
  context: { tokens: number; model: string | null } | null;
};

export const activity = {
  /** Fires with every matched tab whenever status, waitingFor, tokens or membership changed (polled every second). */
  onChange: (cb: (list: TabActivity[]) => void): Promise<UnlistenFn> =>
    listen<TabActivity[]>("tabs:activity", (ev) => cb(ev.payload)),
  /** Desktop notification (omarchy-notification-send, else notify-send); false when neither exists. */
  notify: (a: { title: string; body: string }) => invoke<boolean>("notify", a),
};

/** Decode a base64 pty chunk to bytes for term.write(). */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
