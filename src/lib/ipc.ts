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

export type McpScope = "user" | "project";
export type McpServer = {
  scope: McpScope;
  project?: string;
  name: string;
  config: Record<string, unknown>;
};

export type PtyInfo = { id: string; cwd: string; command: string; alive: boolean };

export const pty = {
  spawn: (a: { cwd: string; command: string; args: string[]; cols: number; rows: number }) =>
    invoke<{ id: string }>("pty_spawn", a),
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
};

export const memory = {
  projects: () => invoke<MemoryProject[]>("memory_projects"),
};

export const mcp = {
  list: () => invoke<McpServer[]>("mcp_list"),
  upsert: (s: McpServer) => invoke<null>("mcp_upsert", s),
  remove: (s: { scope: McpScope; project?: string; name: string }) => invoke<null>("mcp_remove", s),
};

/** Decode a base64 pty chunk to bytes for term.write(). */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
