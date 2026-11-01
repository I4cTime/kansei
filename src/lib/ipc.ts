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

/** Decode a base64 pty chunk to bytes for term.write(). */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
