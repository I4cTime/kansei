# Tsukue contract (v1)

Tsukue ("desk") is a personal Claude Code cockpit for Omarchy/Hyprland, built with
Tauri 2 + React 19 + Tailwind v4 + xterm.js. Working name, may change.

## Layout

```
+-------------+----------------------------------------------------+
| SIDEBAR     | [ q-ring ] [ aibou ] [ niwa ] [+]        <- tab rail|
| (Claude     |----------------------------------------------------|
|  items)     |                                                    |
|  Memory     |                xterm terminal                      |
|  MCPs       |                (one per tab, pty runs `claude`     |
|  Agents     |                 in the tab's folder)               |
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
- Ctrl+Shift+1..7 jump to sidebar section
- Esc closes the editor sheet, Ctrl+S saves inside it

## Rust commands (all `#[tauri::command]`, args are camelCase JSON objects)

Errors are returned as `Err(String)`; the front end shows them in a toast.

### PTY (`src-tauri/src/pty.rs`)

| command | args | returns |
|---|---|---|
| `pty_spawn` | `{ cwd: string, command: string, args: string[], cols: number, rows: number }` | `{ id: string }` |
| `pty_write` | `{ id, data: string }` | `null` |
| `pty_resize` | `{ id, cols, rows }` | `null` |
| `pty_kill` | `{ id }` | `null` |
| `pty_list` | `{}` | `{ id, cwd, command, alive: boolean }[]` |

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
- `prefs.json`: `{ newTabCommand: "claude" | "shell", fontSize: number, fontFamily: string, theme: "system" | "dark" | "light" }`.

## Visual language

Dark by default, light via `prefers-color-scheme` or the `theme` pref
(`data-theme="light|dark"` on `<html>`). Tokens live in `src/index.css`; the
terminal theme is derived from them in `src/app/terminalTheme.ts`. No em dashes
anywhere in copy. Font: system UI for chrome, `JetBrainsMono Nerd Font, monospace`
for the terminal (Omarchy ships it).
