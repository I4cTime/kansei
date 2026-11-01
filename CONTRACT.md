# Tsukue contract (v1)

Tsukue ("desk") is a personal Claude Code cockpit for Omarchy/Hyprland, built with
Tauri 2 + React 19 + Tailwind v4 + xterm.js. Working name, may change.

## Layout

```
+-------------+----------------------------------------------------+
| SIDEBAR     | [ q-ring ] [ aibou ] [ niwa ] [+]        <- tab rail|
| (Claude     |----------------------------------------------------|
|  items)     |                                                    |
|  Today strip|                xterm terminal                      |
|  Projects   |                                                    |
|  Board      |                (one per tab, pty runs `claude`     |
|  Calendar   |                 in the tab's folder)               |
|  Sessions   |                                                    |
|  Memory     |                                                    |
|  Rules      |                                                    |
|  MCPs       |                                                    |
|  Agents     |                                                    |
|  Skills     |                                                    |
|  Workflows  |                                                    |
|  Hooks      |                                                    |
|  Settings   |                                                    |
+-------------+----------------------------------------------------+
```

- Sidebar: left, resizable (default 300 px, min 220, collapsible to a 44 px icon
  rail). Top = section nav (icon + label). Below = the active section's panel.
- Tab rail: horizontal, above the terminal. One tab per pty. `+` opens a folder
  picker (tauri-plugin-dialog) and spawns a new tab there. Middle click or the
  x closes (kills the pty). Double click renames.
- Terminal: fills the rest. All tabs stay mounted (display:none when inactive)
  so their scrollback survives. Fit addon on resize.
- Editor sheet: editing an item (memory file, agent, skill, workflow, settings
  JSON) opens a large sheet over the terminal area via the overlay host
  (`src/lib/overlay.ts`). Esc closes, Ctrl+S saves. Terminals keep running
  underneath.

## Keyboard (handled at window level, xterm must not swallow them)

- Ctrl+Shift+T new tab, Ctrl+Shift+W close tab
- Ctrl+PageUp / Ctrl+PageDown previous / next tab
- Ctrl+Shift+B toggle sidebar collapse
- Ctrl+Shift+1..9 and 0 jump to the first ten sidebar sections in nav order (Projects, Board, Calendar, Sessions, Memory, Rules, MCPs, Agents, Skills, Workflows; 0 is Workflows)
- Ctrl+Shift+H opens Hooks, Ctrl+Shift+, (comma) opens Settings (`PANEL_KEYS` in `src/app/shortcuts.ts`; the nav tooltips come from `panelShortcut`)
- Esc closes the editor sheet, Ctrl+S saves inside it

## Rust commands (all `#[tauri::command]`, args are camelCase JSON objects)

Errors are returned as `Err(String)`; the front end shows them in a toast.

### PTY (`src-tauri/src/pty.rs`)

| command | args | returns |
|---|---|---|
| `pty_spawn` | `{ cwd: string, command: string, args: string[], cols: number, rows: number }` | `{ id: string, pid: number \| null }` |
| `pty_write` | `{ id, data: string }` | `null` |
| `pty_resize` | `{ id, cols, rows }` | `null` |
| `pty_kill` | `{ id }` | `null` |
| `pty_list` | `{}` | `{ id, cwd, command, alive: boolean, pid: number \| null }[]` |

Events emitted on the main window:

- `pty:data` payload `{ id: string, data: string }` where `data` is **base64 of raw
  bytes** (the front end decodes to Uint8Array and hands it to `term.write`, so
  xterm does the UTF-8 decoding across chunk boundaries).
- `pty:exit` payload `{ id: string, code: number | null }`.

Spawn details: portable-pty native system, size cols x rows, cwd as given, env
inherits the process env plus `TERM=xterm-256color`, `COLORTERM=truecolor`,
`TSUKUE=1`. A reader thread per pty forwards output; chunks are coalesced for
up to ~4 ms before emitting to keep event volume sane. `pty_kill` sends the
child a kill and drops the pair. Dropping the app kills every child.

### Files inside the allowlist (`src-tauri/src/files.rs`)

Allowed roots: `~/.claude/` (recursive), the file `~/.claude.json`, and the app
data dir (`~/.local/share/tsukue/`). Anything else -> `Err("path not allowed")`.
Paths are canonicalised after resolving the parent for not-yet-existing files.

| command | args | returns |
|---|---|---|
| `claude_paths` | `{}` | `Paths` (see ipc.ts) |
| `fs_read_text` | `{ path }` | `string` |
| `fs_write_text` | `{ path, content }` | `null` (creates parent dirs, atomic write via temp + rename) |
| `fs_delete` | `{ path }` | `null` (files only) |
| `fs_list` | `{ path }` | `Entry[]` sorted dirs first then name |
| `fs_exists` | `{ path }` | `boolean` |
| `fs_mkdir` | `{ path }` | `null` |
| `file_executable` | `{ path }` | `boolean`: absolute path to a regular file (symlinks followed) with an execute bit. Stat only, no allowlist (`projects.rs`). |

### Memory (`src-tauri/src/memory.rs`)

| command | args | returns |
|---|---|---|
| `memory_projects` | `{}` | `MemoryProject[]` |

`~/.claude/projects/<encoded>/memory/` where `<encoded>` is the project path with
every `/` replaced by `-` (so `-home-i4ctime-Develop-sites-i4c-sites`). Decoding is
ambiguous because names contain hyphens; resolve greedily against the
filesystem: walk the segments, at each step prefer the longest join of
remaining segments that exists as a directory. Return `guessedPath` (string or
null when nothing resolves) and `encoded`. Unit test the decoder with a temp
dir tree.

### MCP servers (`src-tauri/src/mcp.rs`)

Reads and read-modify-writes `~/.claude.json` with `serde_json::Value`, touching
only `mcpServers` and `projects.<path>.mcpServers`, preserving everything else
and key order (enable serde_json `preserve_order`). Before the first write of
a run copy the file to `~/.claude.json.tsukue-bak`.

| command | args | returns |
|---|---|---|
| `mcp_list` | `{}` | `McpServer[]` |
| `mcp_upsert` | `{ scope: "user" \| "project", project?: string, name, config: object }` | `null` |
| `mcp_remove` | `{ scope, project?, name }` | `null` |
| `mcp_extras` | `{}` | `{ plugins: PluginServer[], connectors: Connector[], builtins: Builtin[] }` (read only) |

`mcp_extras` lists what Claude Code loads besides the editable `mcpServers`
blocks, the way its own `/mcp` screen does. It never writes.
- `plugins`: `~/.claude/plugins/installed_plugins.json`
  (`{ version, plugins: { "<name>@<marketplace>": [ { scope, installPath, version, projectPath?, ... } ] } }`),
  then per install the first of `<installPath>/.mcp.json`,
  `<installPath>/.claude-plugin/plugin.json` or `<installPath>/mcp.json`
  (`{ mcpServers: { name: config } }`),
  in file order (`preserve_order`). `PluginServer { plugin, marketplace, version,
  scope, projectPath, enabled, name, config, file, needsAuth }`: `enabled` is
  `enabledPlugins["<name>@<marketplace>"]` in `~/.claude/settings.json` (null
  when unset), `file` the `.mcp.json` path, `needsAuth` when `mcpNeedsAuthNoticed`
  in `~/.claude.json` lists `plugin:<plugin>:<name>`. Installs without a
  `.mcp.json` are skipped, and so is any install whose `.mcp.json` is not inside
  `~/.claude/plugins` both as written (absolute, no `..`) and with symlinks
  resolved: reads never leave `~/.claude/plugins`. A repeated installPath is read once.
- `connectors`: `claudeAiMcpEverConnected` in `~/.claude.json` (an array of
  names such as `"claude.ai Claude Docs"`; objects contribute their `name`),
  deduplicated, `Connector { name, needsAuth }` (`needsAuth` from `mcpNeedsAuthNoticed`).
- `builtins`: `{ name: "claude-in-chrome", note: "Chrome extension, built into Claude Code" }`
  when `~/.claude.json` has `claudeInChromeDefaultEnabled: true`.
- Missing or malformed files give empty lists, not errors.

Panel (`src/panels/mcps/McpPanel.tsx`): below the editable groups (in both the
User and Project scope views) three collapsible, read-only groups with their
own counts: "Plugins" (row = server name, transport badge, chip
`<plugin> <version>` (hex versions cut to 7 characters), the config's `note`
as subtitle or else the url host / command line, chips "disabled" and "needs
auth" when they apply, an Open file action that shows the `.mcp.json` in the
editor sheet read-only), "claude.ai connectors" (subtitle "Managed at
claude.ai, not editable here"; "None recorded" when the list is empty) and
"Built-in". The count next to each editable group's header still counts only
editable servers. The editor sheet gained `readOnly` (no Save, Ctrl+S ignored).
The files allowlist needed no change: `~/.claude/**` was already readable.

## Front-end module ownership

- `src/lib/ipc.ts` - typed wrappers over invoke/listen. **Shared, already written.**
- `src/lib/overlay.ts` - overlay atom + host. **Shared, already written.**
- `src/panels/types.ts` - `PanelDef`. **Shared, already written.**
- `src/index.css` - design tokens. **Shared, already written.** Add to it, do not
  rename tokens.
- `src/app/**` - shell: layout, sidebar frame + nav, tab rail, terminal, tab
  store, persistence, shortcuts, toasts. (Agent B)
- `src/panels/**` - the seven panels and the editor sheet. Export
  `PANELS: PanelDef[]` from `src/panels/index.ts`. (Agent C)
- `src-tauri/**` - Rust. (Agent A)

## Persistence (app data dir, `~/.local/share/tsukue/`)

- `tabs.json`: `{ version: 1, active: number, tabs: { title, cwd, command, args }[] }`
  saved on every change, restored at launch (each restored tab re-spawns its
  pty). Dead tabs (pty exited) show a "restart" affordance in the terminal area.
  A Claude tab stores `command: "claude"` (the logical command, never the
  resolved path); `spawnTab` maps it through the resolved Claude command at
  every spawn and restart, so a pref change applies to restored tabs too.
- `prefs.json`: `{ newTabCommand: "claude" | "shell", claudeCommand: string, fontSize: number, fontFamily: string, theme: "system" | "dark" | "light",
  sidebarWidth, sidebarCollapsed, sidebarSection, pinnedProjects: string[], hiddenProjects: string[],
  workspaceRoots: string[], collapsedPaths: string[], expandedPaths: string[] }` (see `src/app/prefs.ts`).
- `claudeCommand` (default `""`, trimmed): the executable a Claude tab runs.
  `claudeCommand(prefs, local, home)` in `src/app/prefs.ts` returns the pref
  when non-empty (a leading `~/` expanded), else `<home>/.local/bin/claude`
  when `file_executable` says it is executable (the user's launcher, which
  loads MCP credentials from q-ring before running claude), else `claude` from
  PATH. The result is cached in `claudeCommandAtom` (`{ command, source:
  "pref" | "local" | "path", local }`), resolved after prefs load and again
  whenever `claudeCommand` changes; `spawnCommand(tab.command)` waits for the
  first resolution. Every Claude spawn (new tab, restored tabs, Sessions
  Resume, Projects Open, Resume last, Open with) passes the logical `CLAUDE`
  command and goes through it; other commands (the shell) are passed through.
  Settings, This app, Tabs: a "Claude command" field under "New tab runs",
  placeholder = the resolved default (`~/.local/bin/claude (found)` or
  `claude (PATH)`), saved through `savePrefs` on blur or Enter. Dev driver:
  `t.claude.{claudeCommandAtom, refreshClaudeCommand, spawnCommand}`.
- `workspaces.json`: the workspace registry (see "Workspaces").

## Visual language

Dark by default, light via `prefers-color-scheme` or the `theme` pref
(`data-theme="light|dark"` on `<html>`). Tokens live in `src/index.css`; the
terminal theme is derived from them in `src/app/terminalTheme.ts`. No em dashes
anywhere in copy. Font: system UI for chrome, `JetBrainsMono Nerd Font, monospace`
for the terminal (Omarchy ships it).

## Backend behaviour notes (as implemented, 2026-10-31)

- `~/.claude/.credentials.json` is always refused (read, write, delete, also via symlink).
- Reads, lists and exists under `~/.claude/` follow symlinks out of the tree (Omarchy
  links some skills into /usr/share/omarchy). Writes, mkdir and delete must still
  canonicalise inside the allowlist. Delete removes a link itself, not its target.
- Paths must be absolute (`~` is expanded); any `..` component is refused.
  `fs_delete` refuses directories and `~/.claude.json`. `fs_read_text` refuses
  files over 32 MiB or non-UTF-8 content.
- Error strings: `path not allowed: <path>`, `pty not found: <id>`,
  `pty has exited: <id>`, `cwd does not exist or is not a directory: ...`,
  `could not start <cmd>: ...`, `MCP server not found: <name>`,
  `project scope needs a project path`, `server config must be a JSON object`.
- `mcp_upsert` with project scope creates `projects.<path>` when missing. Key
  order is preserved (serde_json preserve_order + float_roundtrip, verified
  byte-identical against the live file).
- `fs_write_text` to `~/.claude.json` shares the MCP lock and the one-time
  `~/.claude.json.tsukue-bak` backup.
- `memory_projects` lists only `projects/*` with a `memory/` dir; the decoder
  treats every non-alphanumeric character as `-` (Claude Code's encoding) and
  backtracks; `guessedPath` is null unless the whole path resolves.
- PTY: output can arrive before `pty_spawn` returns, so the front end keeps one
  global listener and buffers unknown ids. `pty:exit` also fires after
  `pty_kill`. A signal-killed child reports code 1. `pty_kill` sends SIGHUP then
  SIGKILL after 3 s. Env drops `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` so a
  tab's `claude` does not think it is nested; AppImage library variables are
  stripped.
- NVIDIA driver variables (`src-tauri/src/main.rs`, before GTK starts, forced
  whenever /proc/driver/nvidia exists, overriding the session's values unless
  `TSUKUE_NVIDIA_ENV=keep`; the startup log line records both): `__NV_DISABLE_EXPLICIT_SYNC=1`
  (explicit sync kills WebKitGTK's DMA-BUF renderer, Gdk Error 71) and
  `__GL_SYNC_TO_VBLANK=0` (swap interval 1 makes eglSwapBuffers wait for a
  frame callback that a window on a hidden Hyprland workspace never gets, which
  blocked the main thread for the whole time the workspace was hidden).
- Watchdog (`src-tauri/src/watchdog.rs`): a thread posts a ping to the main
  thread every 500 ms (`run_on_main_thread`, one in flight at most). No pong for
  over 3 s logs `stall start after <ms> ms without pong` and runs
  `eu-stack -p <own pid>` once (10 s timeout, `PR_SET_PTRACER_ANY` only while it
  runs, at most 5 per process) into `<appData>/stalls/<unix ts>.txt`; the next
  pong logs `stall end, lasted <ms> ms`. `watchdog::note` appends UTC-stamped
  lines to `<appData>/tsukue.log` (rotated to `.1` past 1 MB): startup env, pty
  spawn/exit/spawn failure, exit. Debug builds register `debug_block_main(ms)`,
  which sleeps on the main thread to test it.
- Known gaps: CSP is still null; MCP `env` values reach the webview (masked in
  the UI behind an eye toggle); a running `claude` can rewrite `~/.claude.json`
  over an MCP edit, so restart sessions after editing MCPs.

## Sessions (added 2026-10-31)

Sidebar section "Sessions", fourth in the nav since Board and Calendar arrived (Ctrl+Shift+4; it was first until Projects arrived).

Sources, all read-only:
- `~/.claude/history.jsonl`: one JSON line per prompt `{ display, timestamp (ms), project (real path), sessionId }`.
  Grouped by sessionId it gives the title (first `display`, trimmed to 120 chars),
  first/last timestamp, prompt count and the project path.
- `~/.claude/sessions/<pid>.json`: live sessions `{ pid, sessionId, cwd, startedAt, status, name, kind, version }`.
  A session is live only if the pid is still running (check `/proc/<pid>`).
- `~/.claude/projects/<encoded>/<sessionId>.jsonl`: the transcript; its presence
  makes the session resumable; size and mtime come from the file.

Rust command `sessions_list` `{}` -> `Session[]`:
```
{ id, project: string | null, title: string, firstTs: number | null, lastTs: number,
  prompts: number, transcriptPath: string | null, transcriptBytes: number,
  live: { pid, status, name, cwd } | null }
```
Union of history sessions and transcript files (transcript-only sessions get the
title "(no prompt recorded)" and the project decoded from the encoded dir via the
memory decoder). Sorted by lastTs desc. Sessions with neither a transcript nor a
live process are dropped.

`pty_spawn` also returns `pid` (the child's pid) and `pty_list` includes it, so
the panel can mark a live session as "open in tab <title>" by matching pids
(the live pid is `claude` itself, which is the pty child when the tab command is
`claude`).

Panel: search box, project filter (all / one project, labels = basename, grouped
by project when "all"), rows = title, relative time, prompt count, size, LIVE
badge when running (plus "in tab X" when it is one of ours). Actions: Resume
(opens a tab in `project` running `claude --resume <id>`; disabled while live),
Delete transcript (inline confirm, `fs_delete` of the jsonl; refused while live).
Tabs opened by Resume are titled "<basename> (resumed)".

## Project scope (added 2026-10-31)

Claude Code also reads per-project files. Tsukue surfaces them for the **active
tab's cwd** ("the project"), walking up from cwd to the nearest ancestor that
contains `.claude/`, `.mcp.json`, `CLAUDE.md` or `.git` (fall back to cwd).

Project files: `<p>/.claude/agents/*.md`, `<p>/.claude/skills/*/SKILL.md`, `<p>/.claude/rules/**/*.md`,
`<p>/.claude/settings.json`, `<p>/.claude/settings.local.json`, `<p>/.mcp.json`
(`{ "mcpServers": { name: config } }`), `<p>/CLAUDE.md`, `<p>/CLAUDE.local.md`.

Rust:
- Allowlist extension: a path is allowed when it is under the cwd of a pty that
  is alive (or was spawned this run) AND its relative part is `.claude/**`,
  `.mcp.json`, `CLAUDE.md` or `CLAUDE.local.md`. Same symlink/`..` rules as
  `~/.claude`. Walk-up roots count as well: `project_root { cwd }` returns the
  resolved root and the allowlist accepts that root for the same relative set.
- `project_root` `{ cwd }` -> `{ root: string, exists: { agents, skills, rules, settings, settingsLocal, mcpJson, claudeMd, claudeLocalMd }: boolean map }`; `rules` = `<root>/.claude/rules` is a directory.
- `mcp_*` gain scope `"projectFile"` with `project` = root: reads/writes
  `<root>/.mcp.json` (create with `{ "mcpServers": {} }` when missing, atomic,
  key order preserved). `mcp_list` only includes the projectFile scope when the
  front end passes `{ project }`.

Front end:
- A `projectAtom` derived from the active tab (`activeTabAtom`): `{ root, exists }`
  refreshed when the active tab changes; null when there is no tab.
- Rules, Agents, Skills, MCPs, Hooks and Settings panels get a scope switch at the top:
  `User | Project` (Project label = basename of root, disabled with a tooltip
  when no tab). Project scope lists the project files, "New ..." creates under
  `<root>/.claude/...`, Settings-Project shows CLAUDE.md / CLAUDE.local.md /
  settings.json / settings.local.json open buttons (create on first save).
  Hooks-Project edits `<root>/.claude/settings.json` hooks.
- Memory panel: the project selector defaults to the entry whose guessedPath
  equals the active tab's root (falling back to home), and follows tab changes
  until the user picks manually.

## Rules (added 2026-10-31)

Sidebar section "Rules", sixth in the nav (Ctrl+Shift+6). Claude Code rules are
Markdown files under `~/.claude/rules/` (User scope) and `<root>/.claude/rules/`
(Project scope), subfolders and symlinked files allowed. Optional frontmatter
`paths:` (a YAML list of globs, or one string, split on commas outside braces)
limits a rule to matching files; a rule without `paths` always loads. No new Rust
command: the panel walks the folder with `fs_list` (dot entries skipped, depth
limit 8, unlistable subfolders skipped) and reads each `*.md` with `fs_read_text`
(`src/panels/rules/model.ts`).

Row: name = path relative to the rules dir without `.md` (`frontend/react`),
summary = first non-empty, non-heading body line (100 chars), chips = one per
glob (3 shown, then "+N") or "always" when there are none; "no frontmatter"
(muted) when a leading `---` block never closes (treated as no paths),
"unreadable" when the read fails. Search matches name, summary and globs.
Actions: open in the editor sheet, delete (inline confirm), New rule (name is
slugified per segment, a slash makes a subfolder) writes a template with a
`paths` example and opens it. Same scope switch as Agents.

## Projects (added 2026-10-31)

Sidebar section "Projects", first in the nav (Ctrl+Shift+1; Board and Calendar
follow, then Sessions on 4; see the Keyboard section for the full map). A project is a folder a Claude Code
session ran in, plus folders the user adds.

Sources, unioned by canonical folder (symlinked spellings of one folder merge
into one row; a row remembers every spelling as `aliases`):
- `sessions_list`: every distinct non-null `project`. Gives the session count,
  live count (sessions with `live`), last activity (max `lastTs`) and "Resume
  last" (the newest session that has a transcript and is not running).
- `memory_projects`: entries with a resolved `guessedPath` add their memory
  file count (`fileCount`, minus MEMORY.md). Unresolved ones are left out.
- prefs `pinnedProjects`: folders pinned from the list or added with the folder
  picker (Add folder). They show even without sessions or memory.
- prefs `hiddenProjects`: folders hidden from the Pinned and Recent views.
  Pinning removes a folder from hidden and hiding unpins it; if prefs.json
  lists a folder in both, pinned wins.

Both prefs are arrays of absolute paths (trimmed, deduplicated, non-strings
dropped by `sanitizePrefs`), written through `savePrefs`.

Rust command `projects_info` `{ paths: string[] }` -> `ProjectsInfo[]`
(`src-tauri/src/projects.rs`):
```
{ path, canonical: string | null, exists: boolean /* is a directory */,
  flags: { claudeMd, claudeDir, mcpJson, git, worktree }: boolean }
```
Stat-only (apart from the first 7 bytes of a `.git` file for `worktree`, see
"Workspaces"), so it needs no allowlist and never registers a
project root. Relative paths are skipped, duplicates dropped, at most 500 paths
per call (the panel chunks). `claudeMd` = `CLAUDE.md` is a file, `claudeDir` =
`.claude/` is a directory (not counted for home, whose `.claude` is the user
config), `mcpJson` = `.mcp.json` is a file, `git` = `.git` exists (file or dir).

Panel:
- Same loading as Sessions: manual load with the spinner, silent refresh every
  15 s while the document is visible, toast only on a new failure. Folders
  pinned between loads get their facts fetched right away.
- Search box (all words, case-insensitive, over label and path) and a filter:
  Pinned, Recent (default: pinned group first, then the rest by last activity;
  hidden rows left out) and All (adds a Hidden group, rows dimmed with Unhide).
  Missing folders sort last in each group. Add folder opens the folder picker
  and pins the choice. (Superseded by the view select in "Workspaces": Tree,
  Recent, All; the Pinned filter became the Pinned section.)
- Row: label (Sessions' rule: basename, `~` for home, parent appended when
  basenames collide), pin icon, LIVE badge when a session is running, path with
  `~`, relative last activity, badges "N sessions", "N memory" (when > 0) and
  chips CLAUDE.md / .claude / mcp. Missing folders get "(missing folder)" and
  their Open, Shell and Resume actions are disabled. The row whose path equals
  the active tab's project root shows "in tab <title>" in the ok colour.
- Actions (on hover or focus): Open (new tab running prefs.newTabCommand),
  Shell (`/bin/bash -l`), Resume last (`claude --resume <id>`, tab titled
  "<label> (resumed)"), Sessions (sets `sessionsProjectFilterAtom` in
  `src/panels/sessions/model.ts` and switches the sidebar to Sessions, which
  applies it as its project filter and clears it), Pin / Unpin, Hide / Unhide.
- Dev driver: `t.projects.{pinProject, unpinProject, hideProject, unhideProject}`
  and `t.sessionsProjectFilterAtom`.

## Workspaces (added 2026-10-31)

Projects live in groups under workspace roots (`~/Develop/{products,sites,lab,...}`),
some one level deeper in a wrapper folder (`products/mine/mineui`), some as apps
of a monorepo (`sites/i4c-sites/apps/sparkle`). The Projects panel shows this as
a tree, every node opens as its own Claude project, and each root gets a
generated `PROJECTS.md` that a root `CLAUDE.md` imports, so every session under
the root knows the other projects.

### Prefs

- `workspaceRoots: string[]`: absolute folders (trimmed, trailing slashes
  dropped, relative entries and duplicates dropped). When prefs.json has no
  `workspaceRoots` key, it defaults at load to `[<home>/Develop]` if that is a
  folder, else `[]`; an explicit `[]` stays empty.
- `collapsedPaths: string[]`: roots and groups the user collapsed (default expanded).
- `expandedPaths: string[]`: projects whose subprojects the user expanded
  (default collapsed). Two lists because the defaults differ by kind.
- Settings, This app, "Projects": the list of roots with Remove, and Add root
  (folder picker). Changing the list rescans right away.

### Rust (`src-tauri/src/workspace.rs`)

| command | args | returns |
|---|---|---|
| `workspace_scan` | `{ roots: string[] }` | `WorkspaceNode[]` (one per existing root) |
| `workspace_claude_md` | `{ root }` | `"created" \| "amended" \| "unchanged"` |
| `project_additional_dirs` | `{ project, dirs: string[], managed: string[] }` | `string[]` (the resulting array) |

`WorkspaceNode { path, name, kind: "root" | "group" | "project" | "subproject", flags: ProjectFlags, children }`
(`flags` as in `projects_info`, which also gained `worktree`). Paths are joined
from the root as given (not canonicalised).

`flags.worktree` (here and in `projects_info`): `.git` is a regular file whose
content starts with `gitdir:` (a git worktree). Reading its first 7 bytes is
the only file read; everything else is stat only.

Scan rules:
- Markers that make a folder a project: `.git` (dir or file), `CLAUDE.md` (file),
  `.claude/` (dir; never for home).
- Depth 1 under a root: a directory with markers is a `project` (through the
  same project rule, so monorepo and worktree rules apply; e.g. `marketing`,
  a repo of its own); every other directory is a `group`. Files are ignored.
- Depth 2: a directory with markers is a `project`. One without markers whose
  direct subdirectories include marker folders is a wrapper `group` of those
  (as `project`s); its other subdirectories are ignored. One with neither is a
  plain `project` (`lab/feature-specs`, `marketing/aibou`).
- A worktree stays a `project` but gets no subprojects (it repeats its main
  checkout's apps, e.g. `sites/i4c-sites-asteria`).
- Monorepos: a project with `pnpm-workspace.yaml`, `apps/` or `packages/` lists
  each `apps/*` and `packages/*` directory with `package.json`, `CLAUDE.md` or
  `.claude/` as a `subproject` (one level; apps and packages sorted together).
  Inner repos of a project that are not under apps/packages are not listed.
- Hidden directories, `node_modules`, `target`, `dist`, `build` and `out` are
  skipped (`vendor` is not). Symlinked directories are never followed (the
  root itself may be a link). Children sort by name, case-insensitive. The whole
  result stops at 3000 nodes (pre-order). Roots: absolute, `..` refused,
  trailing slash dropped, missing and duplicate roots skipped.
- Every root, project and subproject is registered as a project root in the
  files allowlist (groups are not), and roots are remembered for
  `workspace_claude_md`, which refuses anything else.

Allowlist: the project relative set is now `.claude/**`, `.mcp.json`,
`CLAUDE.md`, `CLAUDE.local.md` and `PROJECTS.md` (read/write, top level only).

`workspace_claude_md`: when `<root>/CLAUDE.md` is missing, create
```
# <basename of root> workspace

Every project under this folder is listed in @PROJECTS.md with its path, a one-line description, its status and the projects it is related to. Read it before assuming a sibling project does not exist.
```
plus a blank line and `Current focus: @FOCUS.md` when `<root>/FOCUS.md` exists.
When it exists without the text `@PROJECTS.md`, append a blank line and the
paragraph. Nothing else in an existing file is touched.

`project_additional_dirs`: read-modify-write of `<project>/.claude/settings.json`
through the allowlist (atomic, `preserve_order`, the file's trailing newline
kept, same lock as `.mcp.json`). Every `dirs` entry ends up in
`permissions.additionalDirectories` (appended when new); entries in `managed`
but not in `dirs` are removed; every other entry, key and key order stays.
Paths compare with trailing slashes trimmed; `dirs` must be absolute. A missing
file is created (`{ "permissions": { "additionalDirectories": [...] } }`) only
when there is something to add; nothing is written when nothing changes. A
non-object `permissions` or non-array `additionalDirectories` is an error and
the file is left alone.

### Registry (front end, `src/panels/projects/workspaceStore.ts` + `workspace.ts`)

- `<appData>/workspaces.json`:
  `{ "<root>": { "<absolute project path>": { "description": string, "status": "idea"|"active"|"live"|"parked"|"archived"|null, "related": string[] } } }`,
  read and written with `fs_read_text` / `fs_write_text`. Entries that become
  empty are removed. If the file cannot be parsed, nothing is written over it
  (edits fail with an error until it is fixed).
- A root's first registry write is adding its key (`{}`) the first time it is
  scanned; right after it, `workspace_claude_md` runs once for that root and a
  toast says when CLAUDE.md was created or amended. Later scans never touch
  CLAUDE.md again (so a removed import line stays removed).
- `<root>/PROJECTS.md` is rendered after every scan and every registry change
  and written when the text differs from the file (last written text cached per
  root; the file is read once per run). Format:
  ```
  # Projects in ~/Develop
  Generated by Tsukue from the folder tree and the descriptions kept in its Projects panel. Edit descriptions there; this file is overwritten.

  ## products
  - aibou - `products/aibou` - live - Pet care app (Next + Capacitor). Related: niwa, i4c-sites
  - mineui - `products/mine/mineui`
  ...

  ## sites
  - i4c-sites - `sites/i4c-sites`
    - sparkle - `sites/i4c-sites/apps/sparkle`
  ```
  A worktree's line gets ` - git worktree` right after the path (before status
  and description). Projects hidden in the Projects panel (prefs
  `hiddenProjects`, matched by path or canonical path, so an alias spelling
  counts; pinned wins over hidden as in the panel) are left out together with
  all their subprojects, and a hidden subproject is left out on its own; their
  registry entries stay in workspaces.json. Hiding, unhiding, pinning and
  unpinning re-render and write only when the text changed, like an edit.
  Projects directly under the root come first, as one block right after the
  intro paragraph (blank line before it, no heading, same line format).
  One `##` per group that has projects (blank line before each), wrapper
  projects listed in their group in tree order, subprojects indented two spaces
  under their project. Status and description parts are omitted when empty;
  descriptions are collapsed to one line. "Related:" lists basenames, with the
  path in parentheses when another project in the trees has the same basename
  (relative to this root, `~`-style for other roots); it follows the
  description after a full stop, or is its own ` - Related: ...` part when there
  is no description.
- Scans run at boot (after prefs load), when `workspaceRoots` changes, and on
  every Projects panel load (manual and the 15 s refresh). Operations are
  serialised.

### Panel

1. Search box, view select (Tree default, Recent, All) and Add folder. Search
   applies to every view; it also matches descriptions, status and the
   relative path.
2. Pinned section (when any).
3. Tree (Tree view): per root a sticky header (`~/Develop`, project count,
   collapse), then projects directly under the root as rows, then groups as collapsible headers with a count, wrapper groups nested
   one level deeper, projects as rows (name, path relative to the root,
   description line, status chip, flag chips, sessions / memory / LIVE badges,
   related chips), subprojects indented under their project behind a toggle
   (`+N` when closed), a "worktree" chip for git worktrees. While searching everything matching is expanded, a
   project shows when it or a subproject matches and only matching subprojects
   show. Hidden rows (and their subprojects) are not in the tree.
4. Home section: the home folder row labelled "home" (path `~`), after the trees.
5. Recent: the flat list of folders from sessions, memory, pinned (by last
   activity). All: every row, tree projects included, plus the Hidden group.

Tree projects and home are row sources in `mergeProjects` (`tree` input) but
rows only from the tree are not `known`, so they stay out of Recent. Session
and memory counts merge by canonical folder as before.

Row actions (hover or focus): Open, Shell, Open with..., Resume last, Sessions,
Related..., Edit, Pin / Unpin, Hide / Unhide. Related and Edit are disabled for
folders outside every workspace root.

- Edit: sheet with a description textarea (Ctrl+Enter saves) and a status
  select; saving updates the registry and PROJECTS.md.
- Related...: sheet listing every project and subproject of the trees except
  this one (search, checkboxes, current relations checked). Save calls
  `project_additional_dirs` with `managed` = every workspace project path plus
  the previous relations, then saves `related` (in tree order) in the registry.
- Open with...: the same picker with the related projects pre-checked; Open
  starts a tab in the project running `claude` with `--add-dir <path>` per
  checked project as separate argv entries (whatever prefs.newTabCommand says),
  titled with the project name. `TabSpec` already carried `args`, so it did not
  change.

Sheets render through the overlay host (`src/panels/shared/Sheet.tsx`,
`openSheet`); opening one while another overlay is open is refused with a toast
so an editor with unsaved changes is never replaced.

Dev driver: `t.workspaces` (`treeAtom`, `registryAtom`, `scanWorkspaces`,
`saveEntry`, `saveRelated`, `workspacePaths`), `t.workspaceModel` (pure helpers),
`t.ipc.workspace`, and `t.projects.{addWorkspaceRoot, removeWorkspaceRoot}`.

## Board and Calendar (added 2026-11-01)

The focus system moved from Now/Next/Later to project / epic / task. The source
of truth is the GitHub Project **"I4C"** (user `I4cTime`, number 3, node id
`PVT_kwHOAW7RTs4BfzfL`, https://github.com/users/I4cTime/projects/3). Tsukue
is a view and a light editor of that board plus the owner of the calendar
layer (`SCHEDULE.md`). Nothing about the board is stored in Tsukue except a
cache.

Model:
- **Epic** = a goal. An issue in the private hub repo `I4cTime/focus`
  (`Kind: Epic`); `Area` names the project it belongs to.
- **Task** = a unit of work. An issue in the repo where the code lives, a
  sub-issue of its epic (`Kind: Task`). The board's sub-issue workflow adds it.
- **Lanes** (`Status`): `Backlog`, `Ready`, `In progress`, `In review`, `Done`.
  Built-in workflows: item added -> Backlog; PR linked to an issue -> In
  progress; PR merged / item closed -> Done; Status Done -> issue closed.
- **Scheduled** (date) is the calendar: the day a task is meant to happen.

Field ids (resolve fresh with `gh project field-list 3 --owner @me --format json`
when a write fails; these are the values on 2026-11-01):

| field | id | options |
|---|---|---|
| Status | `PVTSSF_lAHOAW7RTs4BfzfLzhaDvNA` | Backlog `f75ad846`, Ready `7b601cd6`, In progress `47fc9ee4`, In review `46f9a2af`, Done `98236657` |
| Kind | `PVTSSF_lAHOAW7RTs4BfzfLzhoIXaw` | Epic `b600f446`, Task `2292daba` |
| Area | `PVTSSF_lAHOAW7RTs4BfzfLzhhPn2s` | one option per project (q-ring, tanko, groundrules, lookout, cryo, mineui, protonshift, sites, atelier, deathbell, desktop, infra, marketing, aibou, niwa, shiori, tsukue, synthesist, blazedtravel, job-hunt) |
| Scheduled | `PVTF_lAHOAW7RTs4BfzfLzhoIXaI` | date |
| Order | `PVTF_lAHOAW7RTs4BfzfLzhhPn3o` | number (rank inside Ready) |
| Started / Target | `PVTF_lAHOAW7RTs4BfzfLzhhPn3s` / `...zhhPn3w` | date |
| Done when / Outcome | `PVTF_lAHOAW7RTs4BfzfLzhhPn30` / `...zhhPn34` | text |

### Access

All GitHub traffic goes through the `gh` CLI (keyring auth carries the
`project` scope). Every `gh` child is spawned with `GITHUB_TOKEN` **removed
from its environment**: the token a Claude session exports is read-only and
would make writes fail. `gh_status` -> `{ available, login, scopes, error }`
from `gh auth status` (parse the text; `available` is false when `gh` is
missing or not logged in). Panels render the cached board with an "as of"
stamp and a notice when `gh` is unavailable.

### Rust (`src-tauri/src/board.rs`)

| command | args | returns |
|---|---|---|
| `gh_status` | | see above |
| `board_fetch` | `{ force?: bool }` | `BoardSnapshot` (one GraphQL query through `gh api graphql`, paginated at 100, mapped and written to `<appData>/board.json`; without `force` a snapshot younger than 60 s is returned as is) |
| `board_cached` | | the last `BoardSnapshot` from disk or `null` |
| `board_set_field` | `{ itemId, field, value }` | updated `BoardItem`; `field` one of `status kind area scheduled order started target doneWhen outcome`; single-select values are option **names** resolved to ids (field list cached per run, refetched on a miss); `value: null` clears |
| `board_create_task` | `{ repo, title, body, epic: { repo, number } \| null, scheduled: string \| null }` | the new `BoardItem`: `gh issue create`, then `addSubIssue` (GraphQL, node ids looked up) when `epic` is given, `gh project item-add` (idempotent), Kind = Task, Scheduled when given |
| `board_create_epic` | `{ title, body, area: string \| null, doneWhen: string \| null }` | the new `BoardItem` in `I4cTime/focus` with Kind = Epic |
| `schedule_read` | | `Schedule` (`<appData>/schedule.json`, defaults when missing) |
| `schedule_write` | `{ schedule }` | writes atomically, then renders `SCHEDULE.md` |
| `schedule_render` | | renders `SCHEDULE.md` from the cached board + schedule; returns the path |
| `activity_days` | `{ from, to }` (`YYYY-MM-DD`, inclusive, local time) | `ActivityDay[]`: per day the prompt count per project path from `~/.claude/history.jsonl` (the `project` field is the cwd; group by the workspace project that contains it when one does, else the cwd itself) |

```ts
type BoardItem = {
  itemId: string; number: number; repo: string;        // "I4cTime/aibou"
  title: string; url: string; state: "open" | "closed"; closedAt: string | null;
  isPr: boolean;
  status: "Backlog" | "Ready" | "In progress" | "In review" | "Done" | null;
  kind: "Epic" | "Task" | null; area: string | null;
  scheduled: string | null; started: string | null; target: string | null;
  order: number | null; doneWhen: string | null; outcome: string | null;
  parent: { repo: string; number: number } | null;     // the epic, for tasks
  subIssues: { total: number; completed: number };
};
type BoardSnapshot = { fetchedAt: string; items: BoardItem[]; error: string | null };
type DayPlan = { area: string | null; note: string };
type Schedule = {
  rhythm: Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", DayPlan>;
  overrides: Record<string, DayPlan>;                   // "YYYY-MM-DD"
};
type ActivityDay = { date: string; projects: Record<string, number> };
```

Epics are matched to tasks by `parent`; a task whose epic is not on the board
still lists under "No epic".

### SCHEDULE.md (calendar layer, owned by Tsukue)

Written to the first workspace root (`~/Develop/SCHEDULE.md`) after every
schedule write, every successful board fetch and at startup. The root
`CLAUDE.md` gets a `Schedule: @SCHEDULE.md` paragraph appended the same way
`PROJECTS.md` is imported (only when it does not already mention
`@SCHEDULE.md`). Content, in this order:

1. Title and a one-line note that the file is generated (Tsukue, Calendar panel), with the board URL.
2. **Today**: date, the day's area (override wins over rhythm), the override
   note when there is one, then the tasks scheduled today as
   `- <repo>#<n> <title> (<status>; epic <hub>#<n> <title>)`.
3. **This week** (Monday to Sunday): one subsection per day in the same shape,
   days without anything get a single `nothing scheduled` line.
4. **Coming up**: dated tasks after this week, next 30 days, grouped by date.
5. **Weekly rhythm**: a table weekday / area / note.
6. **Unscheduled**: open tasks in Ready or In progress without a date (so a
   session can propose one).

No em dashes anywhere in the file. Dates are `YYYY-MM-DD` plus the weekday name.

### Front end

- Two new panels in `src/panels/index.ts`: `board` ("Board", icon
  `KanbanSquare`) second and `calendar` ("Calendar", icon `CalendarDays`) third,
  so the nav is Projects, Board, Calendar, Sessions, Memory, Rules, MCPs,
  Agents, Skills, Workflows, Hooks, Settings. `Ctrl+Shift+1..9,0` cover the
  first ten in nav order; Hooks and Settings get `Ctrl+Shift+H` and
  `Ctrl+Shift+,` (update the Keyboard section and README).
- `src/panels/board/`: `model.ts` (snapshot atom, lanes, epic grouping,
  `areaProject(area)` = the workspace project whose basename equals the area
  name case-insensitively, else a registry entry with that name, else null),
  `BoardPanel.tsx`, `sheets.tsx` (New task, New epic, Move/Schedule).
  Layout is vertical (the sidebar is narrow): one collapsible section per lane
  in order, Done collapsed by default and limited to the last 10 by `closedAt`.
  Filter chips `Tasks | Epics | All` (default Tasks) and a search box (title,
  repo, area, number). Inside a lane, tasks group under their epic's title.
  Row: title; chips `<repo short name>` or area, `#n`, the scheduled date (red
  when past and not Done), epic progress `3/7` for epics. Row actions: move to
  lane (menu of the four other lanes), schedule (date input, clear), open on
  GitHub (`shell.open`), open project (when `areaProject` or the repo maps to
  a workspace project: open a tab there). Header: refresh (force), as-of
  stamp, New task, New epic. Writes are optimistic and roll back with a toast
  on failure.
- `src/panels/calendar/`: `model.ts` (week/month grids, today's plan,
  `dayTasks(date)`, activity merge), `CalendarPanel.tsx`, `sheets.tsx` (Day,
  Rhythm). Week view default, Month view toggle; prev / Today / next. A day
  cell shows: weekday + date, the area (override wins, muted when from the
  rhythm), the override note (one line), scheduled tasks (status dot + title,
  max 4 then "+N"), and an activity strip: one dot per project with prompts
  that day, tooltip with counts. Clicking a day opens the Day sheet: area
  picker (the Area options, plus "none"), note, the day's tasks with
  unschedule, and "Schedule a task" (picker over open tasks not Done, sorted
  by lane then title). A task row can also be dragged onto a day cell to set
  its date (pointer events, same as the sidebar resize handle). Rhythm sheet:
  seven rows of area + note. Every change goes through `schedule_write`.
- Sidebar: a one-line **Today** strip above the nav (hidden when the sidebar is
  collapsed): `Today · <area or "no plan"> · <n> task(s)`; click opens Calendar.
  Projects panel: the project that matches today's area gets a `today` chip
  and sorts first inside its group.
- Prefs: none new. State lives in `<appData>/board.json` and
  `<appData>/schedule.json`.

### Tests

- Rust: GraphQL response -> `BoardItem` mapping on a fixture; option-name
  resolution; `SCHEDULE.md` rendering on a fixed date; `activity_days`
  bucketing in local time; the `gh` runner is a function the tests replace, so
  no test calls GitHub.
- Front end: week/month grid maths across month and year boundaries; today's
  plan precedence (override > rhythm); `areaProject` matching.
- Driver: open Board and Calendar with the cached snapshot in a scratch
  `TSUKUE_DATA_DIR`, screenshot both.

### As implemented (2026-11-01)

- `BoardSnapshot` also carries `areas: string[]`, the Area field's options in
  board order, read in the same GraphQL query as the items (the first page
  also fills the per-run field cache). The Day, Rhythm and New epic sheets
  offer them (a fixed copy of the 2026-11-01 list until the first fetch).
- Draft issues and items whose content is not visible are skipped (a
  `BoardItem` needs a repo and a number). A merged PR is `state: "closed"`.
  An item without a Status shows in Backlog when open and Done when closed.
- `board_fetch` failures do not throw: the result is the cached snapshot (or
  an empty one with `fetchedAt: ""`) with `error` set, and board.json is kept.
  Concurrent fetches are serialised, so a second caller finds the fresh cache.
- `board_set_field` takes `value: string | number | null`; an empty string
  clears too. Field and option names match case-insensitively. When a write
  with cached ids fails, the field list is fetched again and the write retried
  once if the ids moved. Issue creation passes values as `--title=<t>` so a
  title starting with `-` is not read as a flag. A failure after the issue
  exists says `created <url>, but <step> failed: ...`.
- gh is looked up on PATH, then `~/.local/bin/gh`, mise shims, /usr/local/bin,
  /usr/bin; children also get `GH_PROMPT_DISABLED=1` and are killed after 60 s.
- `schedule_write` returns the schedule as saved (areas trimmed, notes on one
  line, non-date override keys dropped). An override with `area: null` is a
  deliberate "no area" day; the Day sheet removes an override that repeats the
  rhythm (same area, no note) instead of saving it.
- SCHEDULE.md is also rendered after `board_set_field` and the create commands,
  and the front end asks for a render when the local date changes. The first
  workspace root is read from `<appData>/prefs.json` (`workspaceRoots`, same
  default as the front end: `~/Develop` when the key is missing); the file is
  only written when its text changes. The `Schedule: @SCHEDULE.md` paragraph
  is appended once per root, remembered in `<appData>/schedule-imports.json`
  (a removed line stays removed); a root without CLAUDE.md is skipped and
  retried later. Titles and notes have em and en dashes replaced by `-`.
- `activity_days` returns every day of the range (`projects: {}` when none),
  at most 400 days. Projects come from the last `workspace_scan` (a fresh scan
  of the prefs roots when there was none); the deepest project containing the
  cwd wins, matching either its scanned or its canonical path.
- Calendar extras: an "Unscheduled" list under the grid (Ready and In
  progress tasks without a date) whose rows drag onto days, a "Use weekly
  rhythm" button in the Day sheet, and the Board's "as of" stamp and gh notice.
  Month cells show tasks as lane-coloured dots (title in the tooltip).
- Dev driver: `t.board` (model atoms and helpers plus `refreshBoard`,
  `setItemField`, `createTask`, `createEpic`; these write to GitHub),
  `t.calendar` (model plus `loadSchedule`, `saveSchedule`), `t.ipc.board`,
  `t.ipc.schedule`. Replacing `t.ipc.board.setField` stubs board writes for UI
  checks.
- Front-end tests run with vitest (`pnpm test`): `src/panels/calendar/model.test.ts`,
  `src/panels/board/model.test.ts`, `src/app/shortcuts.test.ts`.
