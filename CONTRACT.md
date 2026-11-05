# Kansei contract (v1)

Kansei (管制, "control", as in a control tower) is a personal Claude Code cockpit for
Omarchy/Hyprland, built with Tauri 2 + React 19 + Tailwind v4 + xterm.js. Called
Tsukue ("desk") until 2026-11-03; the binary, package, data dir and env vars changed
name with it, and the app moves `~/.local/share/tsukue` to `kansei` on first start.

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
- Ctrl+Shift+P opens the command palette (see "Command palette")
- Ctrl+Shift+\ toggles the split terminal (see "Split terminal")
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
`KANSEI=1`. A reader thread per pty forwards output; chunks are coalesced for
up to ~4 ms before emitting to keep event volume sane. `pty_kill` sends the
child a kill and drops the pair. Dropping the app kills every child.

### Files inside the allowlist (`src-tauri/src/files.rs`)

Allowed roots: `~/.claude/` (recursive), the file `~/.claude.json`, and the app
data dir (`~/.local/share/kansei/`). Anything else -> `Err("path not allowed")`.
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
a run copy the file to `~/.claude.json.kansei-bak`.

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

## Persistence (app data dir, `~/.local/share/kansei/`)

- `tabs.json`: `{ version: 1, active: number, tabs: { title, cwd, command, args }[], split: { right: number | null, ratio } }`
  (`split.right` is an index into `tabs`, see "Split terminal"; files without
  `split` restore unsplit) saved on every change, restored at launch (each restored tab re-spawns its
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
- `search/`: the transcript text index, `<sessionId>.txt` record files and
  `index.json` (see "Session search"). A cache: deleting it only costs a rebuild.
- `usage/`: the token usage index, `<sessionId>.json` per-day and per-model
  buckets and `index.json` (see "Usage"). A cache like `search/`.

## Visual language

Dark by default, light via `prefers-color-scheme` or the `theme` pref
(`data-theme="light|dark"` on `<html>`). Tokens live in `src/index.css`; the
terminal theme is derived from them in `src/app/terminalTheme.ts`. Palette
themes (follow Omarchy, bundled presets) override the same tokens inline, see
"Themes". No em dashes
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
  `~/.claude.json.kansei-bak` backup.
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
  `KANSEI_NVIDIA_ENV=keep`; the startup log line records both): `__NV_DISABLE_EXPLICIT_SYNC=1`
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
  lines to `<appData>/kansei.log` (rotated to `.1` past 1 MB): startup env, pty
  spawn/exit/spawn failure, exit. Debug builds register `debug_block_main(ms)`,
  which sleeps on the main thread to test it.
- Known gaps: CSP set in tauri.conf.json (2026-10-31); MCP `env` values reach the webview (masked in
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

Claude Code also reads per-project files. Kansei surfaces them for the **active
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
some one level deeper in a wrapper folder (`products/mineui`), some as apps
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
  `{ "<root>": { "<absolute project path>": { "description": string, "status": "idea"|"active"|"live"|"parked"|"archived"|null, "related": string[], "accent": "red"|"yellow"|"green"|"cyan"|"blue"|"magenta"|null } } }`
  (`accent` added 2026-11-04, see "Project accents"; null or missing = automatic, an unknown name reads as null),
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
  Generated by Kansei from the folder tree and the descriptions kept in its Projects panel. Edit descriptions there; this file is overwritten.

  ## products
  - aibou - `products/aibou` - live - Pet care app (Next + Capacitor). Related: niwa, i4c-sites
  - mineui - `products/mineui`
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

- Edit: sheet with a description textarea (Ctrl+Enter saves), a status
  select and an Accent row (see "Project accents"); saving updates the
  registry and PROJECTS.md.
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
`PVT_kwHOAW7RTs4BfzfL`, https://github.com/users/I4cTime/projects/3). Kansei
is a view and a light editor of that board plus the owner of the calendar
layer (`SCHEDULE.md`). Nothing about the board is stored in Kansei except a
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
| Area | `PVTSSF_lAHOAW7RTs4BfzfLzhhPn2s` | one option per project (q-ring, tanko, groundrules, lookout, cryo, mineui, protonshift, sites, atelier, deathbell, desktop, infra, marketing, aibou, niwa, shiori, kansei, synthesist, blazedtravel, job-hunt) |
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

### SCHEDULE.md (calendar layer, owned by Kansei)

Written to the first workspace root (`~/Develop/SCHEDULE.md`) after every
schedule write, every successful board fetch and at startup. The root
`CLAUDE.md` gets a `Schedule: @SCHEDULE.md` paragraph appended the same way
`PROJECTS.md` is imported (only when it does not already mention
`@SCHEDULE.md`). Content, in this order:

1. Title and a one-line note that the file is generated (Kansei, Calendar panel), with the board URL.
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
  `KANSEI_DATA_DIR`, screenshot both.

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

## Themes (added 2026-11-03)

A theme is a palette in the shape of an Omarchy `colors.toml`. It can come from
three sources: the built-in CSS (system, dark, light), the live Omarchy theme, or
a bundled preset. Palette themes set the tokens of `src/index.css` inline on
`<html>`, so the chrome and every open terminal retint live through
`themeTickAtom`; the built-in sources clear those inline values and behave as
before.

### Palette

```ts
// src/app/theme/palette.ts
export type Mode = "dark" | "light";
export type Palette = {
  mode: Mode;
  accent: string; selection: string; muted: string;
  background: string; dark_background: string; darker_background: string; lighter_background: string;
  foreground: string; dark_foreground: string; light_foreground: string; bright_foreground: string;
  red: string; yellow: string; orange: string; green: string; cyan: string; blue: string; magenta: string; brown: string;
  bright_red: string; bright_yellow: string; bright_green: string; bright_cyan: string; bright_blue: string; bright_magenta: string;
};
```

Every colour is `#rrggbb`. `parsePalette(raw: Record<string, string>): Palette | null`
accepts an Omarchy palette with the optional keys (`orange`, `brown`, the four
`bright_*`, `dark_background`, `darker_background`, `lighter_background`,
`dark_foreground`, `light_foreground`, `bright_foreground`, `selection`, `muted`)
missing and derives them: brights from the base colour mixed 25% towards the
foreground, backgrounds mixed 6%/12% towards black or 8% towards the foreground,
foregrounds mixed towards the background, `selection` = `mix(background, accent, 25%)`,
`muted` = `mix(background, foreground, 30%)`, `orange` = `mix(red, yellow, 50%)`,
`brown` = `mix(orange, background, 45%)`. `mode` defaults to `"dark"`. A palette
without `accent`, `background`, `foreground` or any of the six base colours is
rejected (null).

`paletteToTokens(p: Palette): Record<string, string>` maps the palette onto the
CSS tokens exactly as Omarchy's own Alacritty template does, so a terminal in
Kansei matches the user's Alacritty for the same theme:

| Token | Source |
| --- | --- |
| `--bg` | `background` |
| `--bg-raised` | `lighter_background` |
| `--bg-sunken` | `dark_background` |
| `--bg-hover` | `mix(lighter_background, foreground, 8%)` |
| `--fg` | `foreground` |
| `--fg-muted` | `dark_foreground` |
| `--border` | `muted` |
| `--accent` | `accent` |
| `--accent-fg` | `darker_background` |
| `--danger` / `--ok` / `--warn` | `red` / `green` / `yellow` |
| `--t-black` | `background` |
| `--t-red` .. `--t-magenta` | the base colours |
| `--t-cyan` | `cyan` |
| `--t-white` | `foreground` |
| `--t-bblack` | `muted` |
| `--t-bred` .. `--t-bmagenta` | the `bright_*` colours |
| `--t-bwhite` | `bright_foreground` |
| `--t-cursor` | `bright_foreground` |
| `--t-selection` | `selection` |

`mix(a, b, pct)` mixes two `#rrggbb` colours in sRGB (pct of `b`), rounded to
integers, and is the single helper every derivation uses.

### Prefs

`theme` stays a string: `"system" | "dark" | "light" | "omarchy" | "preset:<id>"`.
`sanitizePrefs` keeps `preset:<id>` only when `<id>` is a bundled preset,
otherwise falls back to `"system"`. New keys:

- `effects: boolean` (default `true`): apply a preset's effects (below).
- `claudeTheme: boolean` (default `true`): keep Claude Code in the tabs on the
  same palette (see "Claude Code theme").
- `claudeThemeRestore: string | null` (default `null`): the `theme` value
  `~/.claude/settings.json` had before Kansei set `custom:kansei`, restored when
  the user returns to a built-in source.

### Sources

- **system / dark / light**: unchanged behaviour; the inline tokens and effect
  attributes are removed from `<html>`.
- **omarchy**: the Rust command `theme_omarchy` returns the live theme or null:

  ```ts
  type OmarchyTheme = { name: string; palette: Record<string, string> }; // raw colors.toml strings
  theme.omarchy(): Promise<OmarchyTheme | null>
  theme.onOmarchy(cb: (t: OmarchyTheme | null) => void): Promise<UnlistenFn>   // event "theme:omarchy"
  ```

  `~/.local/state/omarchy/current/theme.name` is the name, `current/theme/colors.toml`
  the palette. `src-tauri/src/theme.rs` parses the flat TOML by hand (`key = "value"`
  lines, `#` comments, quoted strings only; other value types ignored) and a
  background thread stats both files every 2 s, emitting `theme:omarchy` whenever
  either mtime changes or the files appear or vanish. `omarchy theme set` swaps the
  directory atomically (`mv next-theme theme`), so a read never sees a half file.
  When Omarchy is not installed or the files are missing, the front end falls back
  to the built-in dark tokens and shows one toast ("Omarchy theme not found").
  No `theme-set` hook is installed; polling two stats is enough.

- **preset:<id>**: `src/app/theme/presets.ts` exports `PRESETS: Preset[]`:

  ```ts
  type Effects = { glow?: boolean; scanlines?: boolean; square?: boolean };
  type Preset = { id: string; name: string; tagline: string; palette: Palette; effects?: Effects };
  ```

  Seven ship: `night-city` (cyberpunk: hot pink accent, cyan and acid green on
  near-black violet; glow + scanlines), `grid` (Tron: cyan on black, square
  corners; glow + square), `phosphor` (Matrix green monochrome; scanlines),
  `replicant` (Blade Runner amber CRT; glow + scanlines), `mother` (Alien,
  Nostromo green-blue monochrome; square), `nerv` (Evangelion: orange accent,
  purple grounds, acid green ok; glow), `outrun` (synthwave: magenta accent,
  violet grounds, cyan; glow). All seven palettes are complete (no derivation)
  and the test `presets.test.ts` asserts, for every preset: all keys present and
  valid hex, WCAG contrast `foreground` on `background` of at least 7, `accent`
  on `background` at least 3, `dark_foreground` on `background` at least 3, and
  unique ids. Exact values live in the module; the contract fixes the names and
  moods.

### Effects

Static CSS only, no animation, nothing that touches the terminal canvas's
compositing (this machine's WebKitGTK + NVIDIA history). `src/app/theme/apply.ts`
sets `data-fx-glow`, `data-fx-scanlines`, `data-fx-square` on `<html>` when the
active preset asks for them and `prefs.effects` is on; `src/index.css` implements
them:

- glow: a soft `box-shadow` in the accent colour on the active tab indicator and
  the focused input ring, plus a `text-shadow` on the sidebar brand label.
- scanlines: a `pointer-events: none` `::after` overlay on the terminal area
  with a 3 px `repeating-linear-gradient`, 4% opacity, never on the sidebar.
- square: `--radius: 0`.

### Claude Code theme

Claude Code's TUI takes its accents from its own theme file, not from the
terminal palette, so a Kansei palette theme would otherwise leave the TUI on
Claude's default colours. When `prefs.claudeTheme` is on and the source is
omarchy or a preset, `apply.ts` renders `claudeThemeFromPalette(p)` (the same
keys and mixes as Omarchy's `claude.json.tpl`: `claude` = accent, `text` =
foreground, `inverseText` = background, `inactive` = `mix(foreground, background, 40%)`,
`subtle` = muted, `suggestion`/`planMode` = cyan, `permission` = blue,
`remember`/`warning`/`autoAccept` = yellow, `success` = green, `error` = red,
`merged` = magenta, `promptBorder` = accent, `bashBorder` = bright_yellow, `ide`
= bright_cyan, the `diff*` mixes 15/8/32% of green or red into the background,
the message backgrounds 6/10% of foreground into the background, `selectionBg` =
selection, `rate_limit_fill` = accent, `rate_limit_empty` = `mix(background, foreground, 20%)`,
`briefLabelYou` = yellow, `briefLabelClaude` = accent, the `*Shimmer` keys 35%
mixes with the foreground, `base` = mode) to `~/.claude/themes/kansei.json`
through `files.writeText`, and sets `theme: "custom:kansei"` in
`~/.claude/settings.json` (read, merge, write; other keys untouched). The
previous `theme` value is kept in `prefs.claudeThemeRestore` unless it already
was `custom:kansei`. Switching to a built-in source restores it when
settings.json still says `custom:kansei`, then clears the pref. Claude Code
watches `~/.claude/themes` and hot-reloads. The write happens at most once per
distinct rendered JSON (compare before writing). An instance only undoes what it
set: with `claudeTheme` off and no `claudeThemeRestore` of its own, it leaves
`settings.json` alone, so a dev build beside the packaged app cannot take down the
theme the packaged app installed (seen 2026-11-03).

### Export to Omarchy

A preset can become a desktop theme. Rust command:

```ts
theme.exportOmarchy(a: { slug: string; name: string; palette: Palette; apply: boolean }): Promise<string>  // the theme dir
```

Writes `~/.config/omarchy/themes/<slug>/colors.toml` (a `# <name>, exported from
Kansei <date>` comment, `mode`, then every palette key as `key = "#rrggbb"`, plus
`hyprland_active_border = "rgba(<accent>ee) rgba(<cyan>ee) 45deg"` and
`hyprland_inactive_border = "rgba(<muted>aa)"`), creates `backgrounds/` and, when
it is empty, copies the file `~/.local/state/omarchy/current/background` points
to into it, so the theme is complete. The slug is `kansei-<preset id>` and is
validated (`[a-z0-9-]+`). With `apply`, runs `omarchy theme set <slug>`
detached after writing. Returns the directory. Overwrites an earlier export of
the same slug (the user's own themes under `~/.config/omarchy/themes` are
unrestricted).

### Settings panel

The Appearance section becomes:

- Theme select: Match system, Dark, Light, Follow Omarchy (with the live theme
  name when known, "Omarchy theme not found" otherwise), then an "Presets"
  optgroup with the seven names.
- Under the select, a swatch strip for the active palette (background, raised,
  accent, foreground, then the eight base colours as 10 px squares) so the
  choice can be read without looking away from the panel.
- When a preset is active: its tagline, a "Visual effects" checkbox
  (`prefs.effects`), and two buttons "Export as Omarchy theme" and "Export and
  apply" that call `theme.exportOmarchy`, toasting the directory and, for a plain
  export, the `omarchy theme set kansei-<id>` command.
- "Theme Claude Code too" checkbox (`prefs.claudeTheme`), shown for omarchy and
  presets, with the hint that it writes `~/.claude/themes/kansei.json` and the
  `theme` setting.

### Module ownership

- `src-tauri/src/theme.rs`: `theme_omarchy`, `theme_export_omarchy`, the watcher
  (`theme::start(app)` from the setup hook), the flat TOML parser (`parse_flat_toml`)
  and `render_colors_toml`, all unit-tested on temp dirs.
- `src/app/theme/palette.ts`: types, `mix`, `parsePalette`, `paletteToTokens`,
  `claudeThemeFromPalette`, `contrast`. Pure, tested in `palette.test.ts`.
- `src/app/theme/presets.ts`: the seven presets, tested in `presets.test.ts`.
- `src/app/theme/apply.ts`: `startTheme()` called from `boot()` in `App.tsx`
  (replaces the `data-theme` effect there): subscribes to `prefsAtom` and the
  Omarchy event, applies tokens and effects, bumps `themeTickAtom`, syncs the
  Claude theme. `activeThemeAtom: { source, name, palette: Palette | null, effects: Effects }`
  for the Settings swatches. Dev driver: `t.theme.{activeThemeAtom, applyNow}`.
- `src/lib/ipc.ts`: `theme` namespace as above.

## Board configuration (added 2026-11-03)

The Board and Calendar panels work against any GitHub Project v2 the user
owns, not only the author's. Nothing about the project is compiled in: the
constants `OWNER`, `PROJECT_NUMBER`, `PROJECT_ID`, `HUB_REPO` and `BOARD_URL`
in `src-tauri/src/board.rs` and `HUB_REPO`, `BOARD_URL` in
`src/panels/board/model.ts` are removed.

### Prefs

```ts
board: {
  owner: string;          // GitHub user or organisation login
  projectNumber: number;  // the N in github.com/users/<owner>/projects/N
  hubRepo: string;        // "owner/name": where epics are created (Kind = Epic)
  projectId: string;      // resolved node id, PVT_...
  url: string;            // resolved project URL
  title: string;          // resolved project title
} | null                  // default null = not configured
```

`sanitizePrefs` keeps the object only when every field is a non-empty string
(`projectNumber` a positive integer) and `hubRepo` matches `^[\w.-]+/[\w.-]+$`;
otherwise `null`. The front end owns prefs.json; Rust reads the `board` key
per call like it reads `workspaceRoots`.

### Rust

- `BoardConfig { owner, project_number, hub_repo, project_id, url, title }`,
  `read_config(dir: &Path) -> Option<BoardConfig>` from `<appData>/prefs.json`.
- New command `board_configure { owner, projectNumber, hubRepo } -> BoardSetup`:

  ```ts
  type BoardSetup = {
    config: BoardConfig;                       // camelCase, same shape as the pref
    missingFields: string[];                   // required fields the project lacks
    missingOptions: Record<string, string[]>;  // field -> option names it lacks
  };
  ```

  It resolves the project through `gh api graphql`
  (`user(login: $o) { projectV2(number: $n) { id title url } }`, and when that
  returns null, `organization(login: $o)` the same way), then fetches the field
  list with the resolved id and checks the conventions the panels rely on:
  Status (single select; options Backlog, Ready, In progress, In review, Done),
  Kind (single select; Epic, Task), Area (single select, any options),
  Scheduled (date), Order (number). Started, Target, Done when and Outcome are
  optional and reported nowhere. A project that cannot be resolved is an `Err`
  with the gh message; missing fields are not an error, the front end shows
  them as a warning and still saves. The per-run field cache is cleared.
- Every board command reads the config first. `board_fetch` and `board_cached`
  without one return `{ fetchedAt: "", items: [], error: "Board not configured" }`;
  `board_set_field`, `board_create_task`, `board_create_epic` return
  `Err("Board not configured")`. `schedule_render` and the startup render still
  write `SCHEDULE.md` from the rhythm and overrides alone, with no task lines
  and no "Board:" link in the header line when there is no config.
- `board_create_epic` creates in `config.hub_repo`; `SCHEDULE.md`'s header uses
  `config.url`; the task lookups that used `OWNER`/`PROJECT_NUMBER` use the
  config. Tests build a `BoardConfig` fixture; no test depends on the author's
  ids.

### Front end

- `boardConfigAtom` (derived from `prefsAtom.board`) in `src/panels/board/model.ts`.
  Helpers that compared against `HUB_REPO` take `hubRepo: string | null` as a
  parameter (`areaOrRepo`, `itemProject`, the repo list in the task sheet, the
  epic sheet subtitle).
- `configureBoard(a: { owner; projectNumber; hubRepo })` in `actions.ts`: calls
  `board.configure`, saves the returned config into prefs, clears the snapshot,
  refreshes the board, returns the `BoardSetup` so the caller can toast missing
  fields ("The project has no Order field; ordering is disabled" style, one
  toast listing them all).
- Unconfigured state: BoardPanel shows a setup card instead of lanes: three
  inputs (owner, project number, hub repo), a Connect button, and one sentence
  on the required fields with a link to README "Board". CalendarPanel keeps
  working (rhythm, notes, activity dots) and shows one line "No board
  connected" where the scheduled tasks would be, linking to the Board panel.
  The sidebar Today strip drops the task count when there is no config. The
  10-minute auto refresh and the boot fetch are skipped without a config.
- Settings, This app: a Board section with the same three fields prefilled
  from the config, the resolved title as a link to `url`, Connect (or
  Reconnect) and Disconnect (sets `board: null`, clears the snapshot).
- Dev driver: `t.board.configureBoard`, `t.board.boardConfigAtom`.
- `src/lib/ipc.ts`: `board.configure(a) -> BoardSetup`, `BoardConfig` type.

### Docs

README: the Status bullet about the author's board becomes "connect your own
GitHub Project in Settings or the Board panel", and the Board section lists the
required fields and options above. CHANGELOG under Unreleased.

### As implemented (2026-11-03)

- `board_configure` validates before any gh call (owner: letters, digits,
  `-`, `_`, `.`; project number from 1; hub repo owner/name) and, besides
  clearing the field cache, removes `<appData>/board.json`: it may hold the
  previous project's items, which a failed first fetch would otherwise show.
  A field with the required name but another type counts as missing. When
  both lookups fail the error is their GitHub messages joined with `; `.
- The fixed copy of the 2026-11-01 Area options is gone (it was the author's
  list). Before the first fetch, and without a board, the Area pickers (Day,
  Rhythm, New epic) offer the names of the workspace projects instead.
- `refreshBoard` is a no-op without a config. The Calendar's "No board
  connected" line sits where the Unscheduled tray would be; the Day sheet
  shows the same line instead of its tasks and "Schedule a task". Both link
  to the Board panel. The Board panel, Calendar and Today strip ignore a
  cached snapshot while there is no config.
- SCHEDULE.md's header reads "from the <title> board and the weekly rhythm
  ... Board: <url>" with a config and "from the weekly rhythm ..." without.
- The form is `src/panels/board/BoardConnect.tsx`, shared by the setup card
  and Settings; its README link is the repository's README, "Board".
  Connecting toasts "Connected to <title>", then the `setupWarning` line
  ("The project has no Order field; ordering is disabled. Status lacks the
  option In review.") when something is missing.

## Tab status and context gauge (added 2026-11-04)

Every tab whose pty runs Claude Code shows what that session is doing and how
full its context window is, and a hidden tab that starts waiting for the user
raises a desktop notification. Task kansei#7.

### States

```ts
type TabActivity = {
  pid: number;                 // the tab's pty child pid (Tab.pid)
  sessionId: string;
  status: "busy" | "waiting" | "idle";
  /** Why it waits, when known: "permission prompt", "input needed", "sandbox request",
   *  "worker request", "dialog open", or "turn finished" for the idle-after-busy rule. */
  waitingFor: string | null;
  statusUpdatedAt: number;     // epoch ms
  context: { tokens: number; model: string | null } | null;   // null until the first assistant turn
};
```

Sources, in order of precedence:

1. `~/.claude/sessions/<pid>.json` (internal format, read already by
   `sessions.rs`): `status` is `busy` or `idle`, with `statusUpdatedAt`
   (Claude Code 2.1.305 also writes `waiting` with `waitingFor` there, taken
   as is). The
   session pid is a descendant of the tab's pty child (the launcher execs
   `claude`, which forks workers), so the match walks `/proc/<pid>/stat` parents
   from the session pid upwards, at most 12 levels, until it reaches a tab pid.
   Polled every second: one `read_dir` plus one `metadata` per file, parsed only
   when the mtime changed.
2. `claude agents --json --all` (the supported interface, see
   code.claude.com/docs/en/agent-view): `status` adds `waiting` and
   `waitingFor`. It costs a Node start, so it runs only while at least one
   matched session is `busy` and then every 4 s, with a 3 s timeout, `claude`
   from PATH (the `~/.local/bin/claude` launcher only when PATH has none: it
   fetches credentials on every start, which this call does not need). A `waiting` entry overrides the file's `busy` for that session. Any
   failure is logged once per minute through `watchdog::note` and ignored.
3. The idle-after-busy rule, front end: a session that goes from `busy` to
   `idle` becomes `waiting` with `waitingFor: "turn finished"` until the tab
   receives keyboard input or becomes the active tab while the window has
   focus; then it is `idle`. A tab that was never busy in this process is
   `idle`.

Context: the transcript is `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`;
when the encoded dir guess misses, the file is found by name under
`~/.claude/projects/*/` once and cached per session. On each poll where the
transcript's size changed, the last 64 KB are read (growing to 256 KB and
1 MB when they hold no usage line, stopping once the window reaches back past
the previous size: one attachment or tool-result line can exceed 64 KB) and
the last non-sidechain, non-`<synthetic>` line with
`"type":"assistant"` and a `message.usage` gives
`tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
(the statusline's documented `used_percentage` basis; output tokens excluded)
and `model = message.model`. No usage line in the tail: keep the previous value.

Window size is not recorded anywhere, so the front end uses
`prefs.contextWindow` (default 200000) and switches to 1000000 for a session
whose tokens ever exceed 200000 (proof of the extended window); the gauge
tooltip says which. The gauge is hidden while `context` is null.

### Rust (`src-tauri/src/activity.rs`)

- `activity::start(app)` from the setup hook: the 1 s poll thread above. It
  emits `tabs:activity` with `TabActivity[]` (camelCase) only when the array
  changed (status, waitingFor, tokens or membership). The set of tab pids comes
  from `pty::PtyState` (all live ptys with a pid; no front-end registration).
- `claude agents --json --all` parsing: `sessionId`, `pid`, `status`,
  `waitingFor` from each entry; `pid` matched the same way. Pure parse fn,
  tested on a fixture with interactive and background entries.
- `notify { title, body }` command: runs `omarchy-notification-send -u normal
  <title> <body>` when that binary exists, else `notify-send <title> <body>`,
  argv only, detached and reaped; `Ok(false)` when neither exists.
- Tests: parent-walk matching on a fake `/proc` layout (a `proc_root` parameter),
  usage extraction from a transcript tail (last assistant line wins, non-usage
  lines ignored, truncated first line tolerated), change detection, and the
  agents JSON parse.

### Front end

- `Tab.pid: number | null` set from `pty_spawn` and `pty_list`.
- `src/app/activity.ts`: `activityAtom: Record<number /* pid */, TabActivity>`
  fed by `tabs:activity`, the idle-after-busy rule and the "seen" transitions
  (input from `terminals.ts`, activation from `activateTab` while
  `document.hasFocus()`). `tabActivity(tab)` selector. Notification: on a
  transition into `waiting` for a tab that is not active, or when the window is
  not focused, call `notify` with the tab title and the reason, when
  `prefs.notifyWaiting` is on. At most one notification per tab per transition.
- Tab rail: the status dot replaces the current dead and spawning dots as one
  element with four looks: busy = accent, filled; waiting = warn with a 1 px
  ring; idle = fg-muted; dead = danger; spawning = warn hollow. Title attribute
  carries the state and `waitingFor`. Below the title a 2 px context bar, width =
  tokens / window, colour ok below 70 %, warn to 90 %, danger above; tooltip
  "123k of 200k tokens (61 %), <model>". No animation (hidden workspaces get no
  frames on this machine).
- Settings, This app, Terminal: "Context window" number input (prefs.contextWindow,
  50k to 2M) and a "Notify when a hidden tab needs you" switch (prefs.notifyWaiting,
  default on).
- Sessions panel: the LIVE badge shows the status word too.
- Dev driver: `t.activity.{activityAtom, tabActivity}`.
- `src/lib/ipc.ts`: `activity.onChange(cb)`, `activity.notify(a)`, `TabActivity`.

### Docs

README: a "Tab status" paragraph under Run (or a short new section before
Themes) and CHANGELOG under Unreleased. Prefs doc comment in prefs.ts.

## Release pipeline (added 2026-11-04)

Task kansei#8. A `v*` tag produces a GitHub release with Linux artifacts; a
manual run produces the same artifacts without a release, so the workflow can
be verified without tagging.

### Workflow `.github/workflows/release.yml`

Triggers: `push.tags: ["v*"]`, `workflow_dispatch` (input `dry_run`,
boolean, default true: build and attach the files to the run as artifacts, no
release), and `pull_request` filtered to `paths: [.github/workflows/release.yml, packaging/**, src-tauri/tauri.conf.json]`, always a dry run, so a change to the pipeline proves itself on its own PR. Actions pinned to the same SHAs as `ci.yml`.

Jobs:

1. `check-version`: the tag `vX.Y.Z` must equal `version` in
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`;
   fails with a message naming the mismatch. Skipped on a dry run.
2. `create-release` (tag runs only): a draft release named `Kansei vX.Y.Z` with
   generated notes, as in MineUI's workflow, output `release_id`.
3. `bundles` (ubuntu-latest): pnpm, Rust stable, the Tauri Linux deps
   (`libwebkit2gtk-4.1-dev build-essential libssl-dev librsvg2-dev libxdo-dev
   libayatana-appindicator3-dev patchelf`), then `tauri-apps/tauri-action`
   with `releaseId` on a tag (uploads the `.deb`, `.rpm` and `.AppImage`), or
   `pnpm tauri build` plus `actions/upload-artifact` on a dry run.
4. `arch` (container `archlinux:latest`): `pacman -Syu --noconfirm base-devel
   git nodejs pnpm rust webkit2gtk-4.1 gtk3 libsoup3` (and whatever the
   PKGBUILD lists), a non-root `builder` user (makepkg refuses root), then in
   `packaging/arch`: `KANSEI_SOURCE=file://$GITHUB_WORKSPACE makepkg -f` and
   `--nodeps` is not used (deps are installed). `git config --global
   --add safe.directory '*'` first. The `.pkg.tar.zst` is uploaded to the
   release with `gh release upload` (tag) or as an artifact (dry run).
   `pkgver()` already derives the version from `git describe --tags`, so the
   checkout needs `fetch-depth: 0`.
5. `publish` (tag runs, needs the two builds): flips the draft to published.
   Pre-release when the tag contains a hyphen (`v0.2.0-rc1`).

`permissions: contents: write` only on the jobs that upload.

### Repo conventions

- Version lives in `src-tauri/tauri.conf.json`, mirrored in `Cargo.toml` and
  `package.json`; bump all three in one commit "Version X.Y.Z" through a PR,
  then tag the merge commit `vX.Y.Z` (annotated) and push the tag. The
  CHANGELOG moves `[Unreleased]` to `[X.Y.Z] - date` in the same PR.
- The PKGBUILD stays the local-build file; the release job only runs it.

### Docs

README: a "Releases" paragraph under Install (AppImage, deb, rpm and the Arch
package on the Releases page; the AppImage needs `chmod +x`), and a "Cutting a
release" paragraph under Development. CHANGELOG under Unreleased.

### As implemented

- Dry run means `github.event_name != 'push'`: a pushed `v*` tag is the only
  release run. The `workflow_dispatch` input `dry_run` exists as specified,
  but a manual run is always a dry run whatever it is set to (there is no
  tag to release); a release is re-cut by pushing the tag again.
- Pins: checkout, pnpm, setup-node, rust-toolchain and rust-cache use the
  `ci.yml` SHAs. `ci.yml` has no github-script, tauri-action or
  upload-artifact, so github-script (v9.0.0) and tauri-action (v1) use
  MineUI's release pins, and upload-artifact is pinned to v7.0.2.
- `bundles` installs the `ci.yml` apt list plus `patchelf` and `file` for the
  AppImage. Dry runs upload three artifacts: `kansei-appimage`, `kansei-deb`,
  `kansei-rpm`.
- `arch` installs the PKGBUILD's depends and makedepends (`rust` provides
  `cargo`) plus `base-devel git sudo`, and `github-cli` for `gh release
  upload`. pacman runs before checkout, because `actions/checkout` without
  git in the container fetches a tarball with no `.git`.
  `safe.directory '*'` is set with `--system` (not `--global`) so it covers
  both root and the `builder` user. The PR or tag checkout is a detached
  HEAD, which makepkg's mirror clone of `file://$GITHUB_WORKSPACE` cannot
  follow, so the job runs `git checkout -B release-build` first. makepkg runs
  as `sudo -u builder -H` with `--noconfirm`. The dry-run artifact is
  `kansei-arch`.
- `bundles` and `arch` need `create-release` and run when it succeeded or
  was skipped (dry run). Concurrency cancels in-progress PR runs only.

## Command palette (added 2026-11-04)

Ctrl+Shift+P opens a fuzzy command palette over the terminal column through the
overlay host (Esc and a backdrop click close it as for any overlay; the same
shortcut toggles it). Ctrl+K stays with the shell. Task kansei#9.

### Commands

```ts
type Command = {
  id: string;                       // stable: "tab:<key>", "panel:<id>", "project:<path>", ...
  group: "Tabs" | "Panels" | "Projects" | "Sessions" | "Board" | "Themes";
  title: string;                    // what is matched and shown
  hint?: string;                    // muted, right of the title: path, time, lane
  keywords?: string[];              // extra match terms, not shown
  disabled?: string;                // shown greyed with this reason, not runnable
  run: () => void | Promise<void>;
};
```

Builders in `src/app/palette/commands.ts`, one pure function per group taking
the atoms' values as arguments (so tests feed fixtures):

- Tabs: "Switch to <title>" per tab (hint: cwd tildified; the active tab is
  listed last), then New tab, New shell tab, Close tab, Restart tab, Rename tab
  (rename puts the rail item into edit mode via the existing `renameTab` flow).
- Panels: "Open <label>" per `PANELS` entry (hint: its shortcut from
  `panelShortcut`), Toggle sidebar.
- Projects: every project and subproject in `treeAtom` (not roots or groups):
  "Open <name>" runs `claude` in that folder in a new tab (hint: path relative to
  its root); "Open <name> with related" when the registry lists related paths
  (uses the existing Open with... action).
- Sessions: the 40 most recent from `sessions.list()` (fetched when the palette
  opens if the Sessions panel has not loaded them; cached for the open palette):
  "Resume <title>" (hint: project basename and relative time); `disabled:
  "Already running"` when live.
- Board (only with a board connected and a snapshot): for tasks in Ready,
  "Start <title>" (Status -> In progress); for tasks In progress, "Review
  <title>" (-> In review) and "Finish <title>" (-> Done); for In review,
  "Finish <title>". Hint: repo#number. Plus "Refresh board".
- Themes: "Theme: <name>" for Match system, Dark, Light, Follow Omarchy and
  every preset (the active one gets `hint: "active"`), "Toggle visual effects",
  "Toggle Claude Code theme".

### Matching and order

`src/app/palette/fuzzy.ts`: `score(query, text): number | null` is a
case-insensitive subsequence match over `title` then each keyword, taking the
best. Score = 100 for an exact prefix, otherwise per matched character: +3 at a
word start, +2 adjacent to the previous match, +1 elsewhere, minus the length of each gap (a
run of skipped characters) capped at 2;
null when a query character is missing. Results sort by score desc, then group
order (Tabs, Panels, Projects, Sessions, Board, Themes), then title. At most 40
rows. The empty query lists recent commands first (ids in `prefs.paletteRecent`,
newest first, at most 8, saved when a command runs), then the groups in order
with Tabs and Panels complete and the other groups cut to 6 each.

### UI

`src/app/palette/Palette.tsx`: a 560 px wide sheet, top aligned 10 % down, max
height 60 %. One text input (autofocus, placeholder "Type a command"), the
result list with the group label on the right in muted text and the hint after
the title, the selected row highlighted with the accent. Up/Down move, Enter
runs the selected row and closes, click runs, Esc closes. Disabled rows are
skipped by the keys and show their reason. `openPalette()` / `closePalette()`
in `src/app/palette/index.ts` set the overlay; the shortcut action `palette`
(Ctrl+Shift+P, code KeyP) is added to `src/app/shortcuts.ts` and `keyboard.ts`.
Dev driver: `t.palette.{openPalette, closePalette, buildCommands, score}`.

### Tests

`fuzzy.test.ts`: prefix beats scattered, word starts beat mid-word, missing
character is null, ordering of a known set. `commands.test.ts`: each builder
against fixtures (tabs, panels, a small tree with a related entry, sessions
with one live, a board snapshot with items in each lane, theme prefs), ids
stable, disabled reasons, recent ordering and the 8-item cap.

### Docs

README Keyboard section and a "Command palette" line under Panels or Run;
CONTRACT "Keyboard" gets the shortcut; CHANGELOG under Unreleased; prefs.ts doc
comment for `paletteRecent`.

### As implemented (2026-11-04)

- A gap is a run of skipped characters between two matched characters and
  costs its length capped at 2 (changed 2026-11-04 from the uncapped length,
  which let long session titles outscore short commands). The best placement is found by a small DP, so a later word start
  can beat an earlier mid-word hit. Word starts include camelCase humps.
- The 40-row cap applies to a typed query; the empty query lists recent (at
  most 8), Tabs and Panels complete and the other groups at 6 each, uncapped,
  and a recent command is not repeated in its group.
- Keywords: tabs carry their title, panels their label, projects their name
  and relative path, sessions their project label, board tasks their title and
  `owner/repo#n`, themes their name; so typing the start of a name is a prefix
  match (100) even after "Open " or "Theme: ".
- Tabs: New tab is the folder picker (Ctrl+Shift+T); New shell tab opens a
  login shell in the active tab's folder (home without one). Close, Restart
  and Rename act on the active tab and are disabled ("No tab open"); Restart
  only for a dead tab ("Still running"). Rename sets `renameRequestAtom`
  (`requestRename` in `src/app/tabs.ts`) and the rail item enters the same
  edit mode as a double click.
- Projects: Open runs `claude` (not `newTabCommand`) titled with the project
  name; Open with related calls `openWithSheet` (`src/panels/projects/openWith.tsx`,
  shared with the panel's Open with...).
- Sessions: the Sessions panel publishes its list in `sessionsListAtom`
  (`src/panels/sessions/model.ts`) while mounted and clears it on unmount; the
  palette uses it, else fetches `sessions.list()` once per open.
- Board hints use the short repo (`aibou#4`); lane moves call
  `setItemField(itemId, "status", ...)`; Refresh board forces a fetch.
- Themes: the toggles hint "on" / "off"; theme changes go through `savePrefs`.
- Ctrl+Shift+P while another overlay is open toasts "Close the open sheet
  first" (as `openSheet`). Closing without running a command (Esc, backdrop)
  focuses the active terminal again.
- Dev driver: `t.palette.buildCommands()` returns the live commands (no
  arguments), plus `rank(commands, query, recent)`.

## Session search (added 2026-11-04)

Full text search across every transcript, with jump to resume. Task kansei#10.
The corpus is large (4.8 GB over 477 files on the author's machine, 129 of them
over 5 MB) and most of it is noise for search (thinking blocks, tool payloads,
`api-request-blob`, `attachment` lines), so the search runs over an extracted
text index, not the raw files.

### Index (`src-tauri/src/search.rs`)

- Location: `<appData>/search/<sessionId>.txt`, one record per line:
  `<ts ms>\t<role u|a>\t<text>` with tabs and newlines in the text replaced by
  spaces and the text cut at 4000 characters. Plus `<appData>/search/index.json`:
  `{ version: 1, files: { "<transcript path>": { size, mtimeMs, sessionId, project } } }`.
- What is extracted, per transcript line: `type == "user"` with
  `message.content` a string, or its `text` parts; `type == "assistant"` with
  the `text` parts of `message.content` only (no `thinking`, no `tool_use`).
  Lines of any other type are skipped without parsing beyond the type prefix
  (check the raw line starts with `{"type":"user"` or `{"type":"assistant"`
  before `serde_json`). `isMeta` or `isSidechain` lines are skipped. Subagent
  transcripts in subdirectories are indexed too and attributed to the session
  dir they live under.
- `search_index_refresh() -> IndexStatus { files, indexed, skipped, bytes, tookMs }`:
  walks `~/.claude/projects/*/` (and one level of subdirs) for `*.jsonl`,
  re-extracts a file when its size or mtime differs from index.json, removes
  index entries whose transcript is gone, writes index.json atomically. Runs on
  a blocking thread; the first run over the author's corpus must stay under a
  minute (measure and report). Started automatically when the Sessions panel
  search field receives a query longer than 2 characters and the index is
  older than 60 s, and by the Refresh button.
- `search_sessions(query, limit) -> SearchHit[]`:

  ```ts
  type SearchHit = {
    sessionId: string; project: string | null; title: string;   // title from sessions_list data
    ts: number; role: "user" | "assistant";
    snippet: string;            // 160 chars around the first match, match marked with \u0001 and \u0002
    hits: number;               // matches in this session
    transcriptPath: string;
  };
  ```

  Case-insensitive substring search over the record text; terms separated by
  spaces must all occur in the record (AND); a term in double quotes is matched
  literally with its spaces. Files are scanned on `std::thread::available_parallelism`
  threads. One hit per session (the latest matching record), sessions ordered
  by latest hit; `limit` default 50. Returns within 300 ms on the author's index.
- Tests: extraction from fixture lines (user string, user parts, assistant
  text vs thinking vs tool_use, attachment skipped, isSidechain skipped),
  incremental refresh (unchanged file untouched, grown file re-extracted,
  deleted file dropped), snippet marking, AND and quoted terms, ordering.

### Front end

- Sessions panel: the existing search box searches titles as today for one or
  two characters; from three characters on it also queries `search_sessions`
  (debounced 250 ms) and shows a "Transcripts" section under the title matches:
  one row per session with the title, project label, relative time of the hit,
  the snippet with the match highlighted in the accent colour, and the hit
  count. Enter or click on a row resumes that session into a tab (same action
  as Resume; "Already running, open in tab X" when live). A small status line
  shows "Index: N sessions, as of <relative time>" with a Refresh button, and
  "Indexing..." while a refresh runs.
- Command palette: when the query has three characters or more and the palette
  shows fewer than 5 rows, a last group "Transcripts" with up to 5
  `search_sessions` hits ("Resume <title>", hint = snippet start) appears after
  the others (debounced, cancelled when the query changes).
- `src/lib/ipc.ts`: `search.refresh()`, `search.query(a)`, `SearchHit`, `IndexStatus`.
- Dev driver: `t.search.{query, refresh}`.

### Docs

README Sessions/Panels line, CHANGELOG under Unreleased.

### As implemented (2026-11-04)

- Prefix check: in real transcripts only the noise lines start with
  `{"type":"`; user, assistant, attachment and system lines start with
  `{"parentUuid":` and an assistant line's `type` comes after its `message`.
  So a line starting with `{"type":"` that is not user or assistant is
  dropped unparsed, and every other line goes through a serde field visitor
  that aborts as soon as the line cannot yield text (another `type`,
  `isMeta`, a sidechain line, a `message` without `text` parts, which also
  skips the large `toolUseResult` after it). Whitespace runs are collapsed to
  one space, not just tabs and newlines replaced.
- Subagent transcripts live at `<project>/<sessionId>/subagents/agent-*.jsonl`
  (two levels down), so `<project>/<uuid>/` is walked two levels deep, and
  only when `<project>/<uuid>.jsonl` exists (a deleted session's subagent
  files drop out of the index). Every line of a subagent transcript has
  `isSidechain: true`, so the sidechain skip applies to main transcripts
  only; `isMeta` lines are skipped everywhere.
- A session's records (main and subagent transcripts) share
  `<sessionId>.txt`, sorted by time, so a change to any of its transcripts
  re-extracts all of them. Records without a timestamp take the previous
  record's. The index dir is 0700, its files 0600; stray `.txt` files of
  sessions no longer indexed are removed. One refresh runs at a time.
- `IndexStatus` also carries `sessions` (record files) and `bytes` is the
  index size on disk; `indexed` counts transcripts read by this run. The
  panel keeps the last status and its time in `indexStatusAtom`
  (`src/panels/sessions/search.ts`), so "as of" and the 60 s age are per app
  run (the first 3+ character query after a start refreshes).
- Snippet: every term match inside the 160 characters is marked, not only
  the first; the window is centred on the first match. A hit's title and
  project come from `sessions_list` data, falling back to "(no prompt
  recorded)" and the decoded project dir; `transcriptPath` is the main
  transcript.
- The panel filters hits by its project filter. Enter or a click on a hit
  of a running session toasts "Already running, open in tab X" and switches
  to that tab when it is ours. No spinner on the index Refresh button (no CSS
  animation); the line reads "Indexing..." instead.
- Palette: transcript rows are not ranked (appended after the ranked rows),
  disabled "Already running" for live sessions, hint = the snippet start
  (60 characters) without marks, and running one does not enter
  `paletteRecent`.
- Measured on the author's corpus (478 transcripts, 4.8 GB): first refresh
  1.3 s in a release build (7.2 s debug), index 4.4 MB; an incremental
  refresh 0.1 s; queries 2 ms in the release build, about 30 ms through IPC
  in the debug app (sessions_list data included).

## Usage (added 2026-11-04)

Tokens per day, project and model from the transcripts, shown in the Calendar
beside the activity dots. Tokens only, no prices. Task kansei#11.

### Index (`src-tauri/src/usage.rs`)

- Same walk and change detection as the search index (share the transcript
  walker and the `{ size, mtimeMs }` manifest logic with `search.rs`; one
  helper module, no duplicated walking code). Location `<appData>/usage/`:
  `index.json` manifest plus `<sessionId>.json` holding that session's turns
  aggregated per local day and model:

  ```ts
  type UsageBucket = { turns: number; input: number; cacheCreate: number; cacheRead: number; output: number };
  // <sessionId>.json
  { project: string | null; days: Record<Ymd, Record<model, UsageBucket>> }
  ```

- Extraction: `type == "assistant"` lines with `message.usage`; one turn per
  `message.id` (streamed duplicates of the same id: the last line wins, so
  collect per id while reading, then aggregate). `input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`;
  missing fields count 0. Day = local date of `timestamp` (reuse the local date
  helpers in board.rs). Subagent transcripts count towards their parent session.
  Lines without `message.model` go under model `"unknown"`.
- `usage_refresh() -> IndexStatus` (same shape as the search one) and
  `usage_days(from, to) -> UsageDay[]`:

  ```ts
  type UsageDay = {
    date: Ymd;
    total: UsageBucket;
    projects: Record<string, UsageBucket>;   // project path (or "" when unknown)
    models: Record<string, UsageBucket>;
  };
  ```

  Only days with at least one turn are returned, ascending. The project is the
  session's project as `sessions_list` resolves it.
- Derived, front end: context share `cacheRead / (input + cacheCreate + cacheRead)`
  as a percentage ("cache hit share"), and `k`/`M` formatting (1.2M, 86k).
- Tests: extraction and id dedupe from fixture lines, day bucketing across a
  local midnight, aggregation per project and model, manifest skip of an
  unchanged file.

### Front end

- `src/panels/calendar/usage.ts`: `usageDaysAtom`, `loadUsage(from, to)`
  (debounced with the activity load: same range, refreshed together and on the
  same interval), pure helpers `sumBuckets`, `cacheShare`, `formatTokens`,
  `topProjects(day, n)`. Tested.
- Calendar panel: under the selected day's plan a "Usage" block: one line
  "1.2M in · 86k out · 94 % cache · 41 turns", then up to five project rows
  (basename, tokens in, share bar as a thin accent bar scaled to the day's max)
  and a "models" line (model names with their turn counts). The visible week or
  month gets a 14-day strip of bars (total input per day, scaled to the range
  max, today marked) next to the activity dots, with a title per bar. Nothing
  renders for a day with no usage. A Refresh action in the block header runs
  `usage_refresh` and reloads.
- Today strip: appends the day's input total ("· 1.2M tok") when it is above 0.
- Dev driver: `t.usage.{usageDaysAtom, loadUsage, formatTokens}`.
- `src/lib/ipc.ts`: `usage.refresh()`, `usage.days(from, to)`, the types above.

### Docs

README Calendar section (a Usage paragraph), CHANGELOG under Unreleased, the
Persistence list in CONTRACT gets `<appData>/usage/`.

### As implemented (2026-11-04)

- `src-tauri/src/transcripts.rs` holds what both indexes share: discovery
  (`discover`, the two-level subagent walk), `parse_iso_ms`, a streaming
  `for_each_line`, the `index.json` manifest, `IndexStatus`, `par_map` and
  `refresh_index(kind, ...)`, which runs the change detection, the parallel
  per-session rebuild, the atomic manifest write and the stray-file sweep;
  each index supplies only how a session's file is built (`IndexKind`: version,
  extension, name, its own refresh lock). Search behaviour is unchanged.
  Symlinked transcripts are not followed (as before for search), so a forked
  session whose `subagents/` links into another session's counts each turn
  once, under the session that owns the file.
- A turn is the last line of its `message.id` across all of a session's
  transcripts; lines without an id are each a turn. A turn without a
  timestamp takes the previous line's; one before any timestamp is dropped.
  Turns of model `<synthetic>` (Claude Code's placeholder messages, all
  zeros, no API call) are not counted. The same session id under two project
  dirs (a renamed project) is one session. Lines starting with `{"type":"`
  that are not assistant lines are dropped unparsed; otherwise a field
  visitor stops at a non-assistant `type` or a `message` without `usage`.
- The session's project is resolved at refresh time from `sessions_list`
  data (falling back to the decoded project dir) and stored in its file, so it
  changes when the session's transcripts do. Days are local days at refresh
  time (`board::local_day_of_ms`). `usage_days` takes at most 400 days
  (`MAX_ACTIVITY_DAYS`, same rule as `activity_days`) and reads every session
  file (about 160 KB in all on the author's machine).
- "Tokens in" everywhere in the UI (the day line, project rows and their
  bars, the strip, the Today strip) is `input + cacheCreate + cacheRead`,
  so the cache share is a share of it. `formatTokens` uses one decimal under
  10 and whole numbers above ("1.2k", "86k", "1.2M", "86M", "1.2B").
- `loadUsage(from, to, debounceMs = 250)` runs `usage_refresh` then
  `usage_days`, one load at a time; calls inside the debounce collapse into
  the last and all callers get its `{ status, days }`. Results merge into
  `usageDaysAtom` (a `Map` by date; the loaded range is replaced, other days
  kept), so the Today strip keeps today while the Calendar shows another
  month. The Calendar loads `usageRange(from, to, today)`: its visible range
  widened to the strip's first day. `usageStatusAtom` keeps the last
  `IndexStatus`.
- The 14-day strip ends today when the visible range contains today, else on
  the range's last day; it sits under the grid and is hidden when its 14 days
  have no usage. Clicking a bar picks that day. The "selected day" is the last
  day opened (a click on a cell, which still opens the Day sheet) or picked on
  the strip, else today; the Today button resets it. The Usage block sits
  under the strip, above Unscheduled, titled `Usage · today` or
  `Usage · <Mon 3 Nov>`; its Refresh button runs an undebounced load (no
  spinner). Usage errors toast once ("Could not read Claude usage") and never
  block the activity dots.
- The Today strip has its own source: three seconds after boot, then on the
  Calendar's one-minute clock, today's usage is loaded when no load covering
  today finished in the last five minutes (`usageIsStale`), so it stays
  current with the Calendar closed.
- Dev driver: `t.usage.{usageDaysAtom, usageStatusAtom, loadUsage, formatTokens}`.
- Measured on the author's corpus (479 transcripts, 4.8 GB, 63 sessions with
  turns): first refresh 0.87 s in a release build, 2.4 s in a debug test
  build and 1.6 s in the debug app (warm page cache); index 164 KB; an
  incremental refresh 1 to 75 ms; `usage_days` over 14 days 3 ms.

## Split terminal (added 2026-11-04)

Two tabs side by side: watch one agent while prompting another. Task kansei#12.

### Model (`src/app/split.ts`, pure helpers tested in `split.test.ts`)

```ts
type Split = { right: string | null; ratio: number };   // right = tab key on the right pane, ratio = left width share 0.3..0.7
export const splitAtom = atom<Split>({ right: null, ratio: 0.5 });
```

- The left pane always shows the active tab (`activeKeyAtom`), as the whole area
  does today. The right pane shows `split.right` when set; the two are never the
  same tab: activating the right tab makes it the active (left) tab and the
  previous active tab moves to the right (`swapIntoLeft`), so the user sees the
  same two terminals with focus on the one they picked. Activating a third tab
  replaces the left pane only.
- Closing or losing the right tab (`closeTab`, pty death does not unsplit)
  clears `right`. Closing the left tab activates another as today and keeps the
  right pane.
- Persistence: tabs.json gains `split: { right: <index into tabs> | null, ratio }`
  written with the tabs and restored with them (index, because keys are new
  after a restart; out of range or equal to the active index = no split).
- Commands: `splitWith(key)`, `unsplit()`, `toggleSplit()` (split with the next
  tab in rail order when unsplit, else unsplit), `setRatio(r)` clamped.

### UI

- `TerminalArea`: when `right` is set, two pane containers in a row with a 6 px
  divider (`cursor: col-resize`, pointer events, `setRatio` while dragging,
  double click resets 0.5). Each `TerminalView` mounts into the pane that shows
  it; `attachTerminal` already moves a terminal's host between containers, and
  the per-container `ResizeObserver` fits it. Tabs in neither pane stay
  `display: none`. A thin accent top border on the focused pane (the one that
  last received a mouse down or keyboard focus); clicking a pane focuses its
  terminal and, for the right pane, does not change the active tab.
- Tab rail: the right pane's tab shows a small Columns icon (lucide
  `Columns2`) before its title; right click on any tab opens a small menu with
  "Open on the right" (or "Close the right pane" when it is the right tab),
  "Rename", "Close". Dragging a tab (HTML5 drag from the rail item) over the
  terminal area shows a right-half drop zone; dropping there splits with it.
- Keyboard: Ctrl+Shift+\ toggles the split (shortcut action `toggleSplit`,
  code Backslash). Ctrl+PageUp/PageDown keep cycling the active (left) tab.
- Palette: "Split with <tab>" per tab except the active one, "Close the right
  pane" when split.
- Dev driver: `t.split.{splitAtom, splitWith, unsplit, toggleSplit, setRatio}`.

### Tests

`split.test.ts`: swapIntoLeft, replace-left on a third tab, unsplit on closing
the right tab, keep on closing the left, ratio clamp, tabs.json round trip of
the index form (restore with a missing or equal index yields no split).

### Docs

README Run section (a Split paragraph) and Keyboard; CONTRACT "Keyboard" and
"Persistence" lines; CHANGELOG under Unreleased.

### As implemented (2026-11-04)

- Panes: no separate pane containers. Every `TerminalView` stays where it is
  (one absolutely positioned box per tab, as unsplit) and the split only
  changes its inline box: the left pane `left: 0; width: calc(ratio - 3px)`,
  the right `left: calc(ratio + 3px); right: 0`, the divider between them,
  everything else `display: none`. Same result as two containers, but a swap
  or a split never remounts a view or moves an xterm host (no WebGL canvas
  re-parenting), and the per-view `ResizeObserver` refits on every ratio
  change. Unsplit, the view's style is exactly `{ display: block }` as before.
- Activation: every change of the active tab in `tabs.ts` (`activateTab`,
  `openTab`, `cycleTab`) goes through `setActiveKey` in `split.ts`, which
  applies `swapIntoLeft`. `closeTab` on the active tab picks the next tab with
  `nextActiveAfterClose` (as before, but skipping the right tab; when only the
  right tab is left it becomes active and the split ends). `effectiveRight`
  (an existing tab that is not active) is what the UI, the palette and
  tabs.json use, so a stale `right` never shows.
- `splitWith(activeKey)` ("Open on the right" on the active tab) moves the
  active tab to the right and activates the current right tab or else the next
  tab in rail order; with one tab it does nothing (the menu item is disabled).
  `toggleSplit()` with one tab toasts "Open a second tab to split".
- Focus: `focusedPaneAtom` ("left" | "right") is set by a capture-phase mouse
  down or focus inside a pane; the focused pane gets a 2 px accent top border
  (the other a transparent one, so both panes keep the same height). Activity
  (`activity.ts`) treats the right tab as in view while its pane has focus and
  the window has focus, and focusing it marks it seen. When the right pane
  closes while focused, focus returns to the active terminal.
- Divider: pointer down attaches window `pointermove` / `pointerup` listeners
  (pointer capture is tried too), each move calls `setRatio`; drawn as a 1 px
  line (accent on hover) in a 6 px hit area.
- Drag: the rail item is `draggable` (not while renaming) and sets
  `draggedTabAtom`; the terminal area shows the half-width drop zone while a
  rail tab is over it (highlighted and accepting over the right half only).
  On Linux wry's file-drop handler only claims drops with file URIs, so these
  in-page drags reach the webview.
- Rename from the context menu sets `renameRequestAtom` without activating the
  tab (the palette's Rename tab still activates first).
- `fitTerminal` now returns early when the xterm host has no size: WebKitGTK's
  FitAddon proposed 11x5 inside a `display: none` container, which resized
  every hidden tab's pty to 11x5 (pre-existing; more visible with the split
  hiding and showing panes).
- Dev driver: also `t.split.rightKey()` and `t.split.focusedPaneAtom`.

## Project accents (added 2026-11-04)

A stable colour per workspace project that tints the tab, the terminal column
and the sidebar header, so the window always says which repo the active tab is
in. Task kansei#13.

### Model (`src/app/accents.ts`, tested in `accents.test.ts`)

```ts
type AccentName = "red" | "yellow" | "green" | "cyan" | "blue" | "magenta";
export const ACCENT_NAMES: AccentName[];                 // in that order
export function accentFor(path: string, registry: Registry): AccentName;   // override or hash
export function accentVar(name: AccentName): string;    // "var(--t-<name>)"
export function tabProject(cwd: string, tree: WorkspaceNode[] | null): { path: string; name: string } | null;
```

- `accentFor`: the registry entry's `accent` when set, else the hash the
  Calendar uses today (move `projectColour` from `src/panels/calendar/model.ts`
  here and make the Calendar call `accentFor`, so dots, tabs and header agree).
  The hash maps onto `ACCENT_NAMES`, so existing dot colours do not change.
- `tabProject`: the deepest project or subproject in the workspace tree whose
  path is the cwd or a parent of it; null when the cwd is under no root (then
  the tab is tinted by `accentFor(cwd)` and shows the cwd basename).
- Registry: `RegistryEntry` gains `accent: AccentName | null` (default null =
  automatic), read and written with workspaces.json like the other fields.
- Pref `projectAccents: boolean` (default true) turns the tinting off; the
  Calendar dots keep their colours regardless.

### UI

- Tab rail: every tab gets a 3 px inner left edge in its project colour (a
  `box-shadow: inset 3px 0 0 <colour>`, no layout change). The active tab's
  indicator bar stays the theme accent.
- Terminal column: a 2 px top border on the terminal area in the active tab's
  colour (the tab rail's bottom border takes the colour; no extra height).
  With a split, the right pane's top focus border uses that pane's project
  colour when the pane is not focused and the theme accent when it is.
- Sidebar header: right of the brand label, a chip with a 7 px dot in the
  colour and the active tab's project name (basename, max 18 characters with
  an ellipsis, title = full path). Hidden when the sidebar is collapsed or
  there is no active tab.
- Projects panel: tree rows show a 6 px dot in their colour before the name;
  the Edit sheet gets an "Accent" row: Auto plus the six names, each with a
  swatch, saved through `saveEntry`.
- Dev driver: `t.accents.{accentFor, tabProject, ACCENT_NAMES}`.
- Settings, This app, Appearance: "Project accents" switch (`prefs.projectAccents`).

### Tests

`accents.test.ts`: hash stability and distribution over the six names,
override wins, `tabProject` deepest match (project vs subproject, trailing
slash, a cwd outside every root), Calendar colours unchanged for a fixed path
set (snapshot of three known paths).

### Docs

README Run or Panels (one paragraph), CHANGELOG under Unreleased, prefs.ts
doc comment, CONTRACT Workspaces registry shape gets `accent`.

### As implemented (2026-11-04)

- Modules: `accents.ts` is pure (type imports only, so `workspace.ts` can
  sanitise `accent` with it); it also exports `hashAccent`, `isAccentName`,
  `tabAccent(cwd, tree, registry)` (project path, name, accent) and
  `chipName`. The live atoms are in `src/app/accentState.ts`: `accentOfAtom`
  (cwd -> `TabAccent` from `treeAtom` and `registryAtom`), `accentsOnAtom`
  (the pref) and `activeAccentAtom` (the active tab's, null with no active
  tab or the pref off). The old `projectColour` is gone; the Calendar calls
  `accentVar(accentFor(path, registry))`, so an Accent set in the Edit sheet
  colours its dots too, and the hash runs on the path exactly as given (the
  registry lookup ignores a trailing slash).
- Terminal column: the tab rail lost its 1 px bottom border and is 32 px
  high; the terminal area always has a 2 px top border, so rail plus line
  stay 34 px and meet the sidebar header's bottom border. The line is the
  active tab's accent, or `var(--border)` with no tab or the pref off, so
  turning accents on or off never moves anything.
- Pref off: no tab edges, the neutral line, no header chip, no Projects tree
  dots, an unfocused right pane's top border transparent as before. The Edit
  sheet's Accent row and the Calendar dots stay.
- Projects dots: on every row backed by a workspace tree project (Tree,
  Pinned, Recent and All views alike).
- Chip: names longer than 18 characters are cut to 15 plus "..." (the
  ellipsis style used elsewhere in the app).
- Edit sheet: the Accent row is a radio group of seven buttons; Auto's
  swatch shows the hashed colour (dimmed).
- Dev driver: `t.accents` also has `accentVar`, `tabAccent`, `accentOfAtom`
  and `activeAccentAtom`.

## MCP health (added 2026-11-04)

Each configured MCP server is probed with a real `initialize` handshake, so the
MCPs panel shows which ones start and which fail, with the failure text. Task
kansei#14 (it would have caught the q-ring hang, focus#26, earlier).

### Rust (`src-tauri/src/mcp_health.rs`)

```ts
type McpHealthStatus = "ok" | "auth" | "failed" | "timeout" | "skipped";
type McpHealth = {
  key: string;                 // "<scope>|<project or ''>|<name>"
  status: McpHealthStatus;
  detail: string | null;       // stderr tail (last 2 KB, trimmed), HTTP status line, spawn error, or why skipped
  ms: number | null;           // handshake latency
  serverInfo: { name: string; version: string | null } | null;   // from the initialize result
  checkedAt: number;           // epoch ms
};
```

- `mcp_health_check { servers: McpServer[] } -> McpHealth[]`: probes with a
  concurrency of 3 and emits `mcp:health` with each `McpHealth` as it finishes,
  so the panel updates progressively; returns the full list at the end and
  writes `<appData>/mcp-health.json` (`{ results: Record<key, McpHealth> }`,
  merged with earlier keys). `mcp_health_cached() -> McpHealth[]` reads it.
- stdio servers (`command`, `args`, `env`, `cwd` when present): spawn argv-only
  with the configured env merged over the current environment (never logged),
  stdin piped, write one JSON-RPC line
  `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"kansei","version":"<app version>"}}}`
  and read stdout line by line until a line parses as JSON with `"id":1`
  (result -> `ok` with `serverInfo`, error -> `failed` with the error message),
  8 s timeout -> `timeout`; the child is killed and reaped in every case
  (SIGTERM, then SIGKILL after 1 s). The spawn itself failing (missing binary)
  -> `failed` with the OS error. stderr is drained on its own thread into a
  2 KB ring and becomes `detail` for failed and timeout.
- http servers (`url`, optional `headers`): `curl` argv-only with
  `-s -o /dev/null -w %{http_code} -m 8 -X POST -H Content-Type: application/json -H Accept: application/json, text/event-stream --data <the same initialize body>`
  plus configured headers. 2xx -> `ok` (no serverInfo), 401 or 403 -> `auth`
  ("reachable, needs sign-in"), other codes -> `failed` with the code, exit 28
  -> `timeout`, other curl failures -> `failed` with curl's stderr. `curl`
  missing -> `skipped`.
- Unknown transport -> `skipped` with the reason. Servers whose `command` is
  empty -> `skipped`.
- Tests: the stdio probe against a tiny fake server written to a temp file
  (a shell script that echoes a valid initialize result; one that writes to
  stderr and exits 1; one that sleeps past the timeout, asserting the child is
  gone afterwards), the key format, the cache merge, and the http status
  mapping as a pure function.

### Front end

- `src/panels/mcps/health.ts`: `healthAtom: Record<key, McpHealth>`, fed by
  `mcp_health_cached()` at boot and the `mcp:health` events; `checkServers(servers)`,
  `checkAll()` (user servers plus plugin servers plus the active project's
  servers), `healthKey(server)`; `failedCount` selector.
- Startup: `prefs.mcpHealthAtStartup` (default true) runs `checkAll()` 5 s after
  boot. Results older than 24 h are shown as stale (muted dot, title says
  when).
- MCPs panel: a 7 px dot before each server name (ok = `--ok`, auth = `--warn`,
  failed and timeout = `--danger`, skipped or unknown = `--fg-muted`), title =
  status, latency and `serverInfo`; for failed and timeout an expandable line
  under the row with the detail in monospace (max 6 lines, scroll). A "Check"
  icon button per row and a "Check all" header action; rows show "checking" while
  in flight. Plugin and connector lists get the dot too (connectors are
  skipped: no transport Kansei can probe).
- Sidebar nav: the MCPs icon gets a small `--danger` dot when `failedCount > 0`.
- Settings, This app: "Check MCP servers at startup" switch.
- Dev driver: `t.mcpHealth.{healthAtom, checkAll, checkServers}`.
- `src/lib/ipc.ts`: `mcpHealth.check(servers)`, `mcpHealth.cached()`, `mcpHealth.onResult(cb)`.

### Docs

README MCPs line under Panels, CHANGELOG under Unreleased, Persistence list
gets `<appData>/mcp-health.json`, prefs.ts doc comment.
