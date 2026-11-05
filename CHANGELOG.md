# Changelog

All notable changes to Kansei are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no
releases yet; everything so far is on `main` as 0.1.x.

## [Unreleased]

### Added

- **MCP health** (2026-11-04). Every MCP server (user, the active project's,
  plugin servers) is probed with a real `initialize` handshake: stdio servers
  are started, sent one JSON-RPC line and stopped again (8 s at most, SIGTERM
  then SIGKILL, always reaped), http servers get the same request through
  curl (401 or 403 means reachable, needs sign-in). The MCPs panel shows a dot
  per server with the latency and server name in its title, failed and timed
  out rows unfold to the stderr tail, and each row has a Check button next to
  a Check all in the header. The MCPs nav icon gets a red dot while a fresh
  check failed. Runs 5 s after startup unless Settings, This app, "Check MCP
  servers at startup" is off; results are kept in `mcp-health.json`.

- **Project accents** (2026-11-04). Every workspace project gets a stable
  colour from the terminal palette: a 3 px left edge on each tab, the line
  under the tab rail in the active tab's colour, the unfocused right pane's
  top line in its own colour, and a chip with the active tab's project name
  next to the brand in the sidebar header. Projects tree rows show it as a
  dot and the Edit sheet picks it (Auto, from a hash of the path, or one of
  six names; saved in workspaces.json). The Calendar's activity dots use the
  same colours (unchanged for every path left on Auto). Settings, Appearance,
  "Project accents" turns the tinting off.

- **Split terminal** (2026-11-04). Two tabs side by side: Ctrl+Shift+\\, a
  tab's right click menu ("Open on the right"), dragging a tab onto the right
  half of the terminal area, or "Split with <tab>" in the palette. The left
  pane is the active tab and activating the right tab swaps them; the divider
  drags from 30 to 70 % and resets on double click; closing the right tab
  unsplits. tabs.json keeps the split. A focused right pane counts as seen
  for the tab status.

- **Usage** (2026-11-04). The Calendar shows how many tokens Claude used:
  a 14-day strip of tokens in per day under the grid, and a Usage block for
  the picked day (today by default) with tokens in and out, the cache hit
  share, the turn count, the top five projects with share bars and the turns
  per model. The Today strip appends today's total. The numbers come from an
  incremental index of the transcripts (subagents included, streamed copies
  of a message counted once) under `~/.local/share/kansei/usage/`, refreshed
  with the Calendar's activity every five minutes or from the block's
  Refresh button. Tokens only, no prices.
- **Session search** (2026-11-04). The Sessions search box searches the
  transcripts themselves from three characters on: every word must occur in
  a message, "quoted phrases" match literally, and each session shows its
  latest matching message with the match highlighted, the project, when it
  was said and the hit count; Enter or a click resumes it. The text comes
  from an index of user and assistant text (no thinking, tool calls or
  attachments) under `~/.local/share/kansei/search/`, refreshed incrementally
  when it is older than a minute or from its Refresh button. The command
  palette lists up to five transcript hits when a query leaves fewer than
  five commands.
- **Command palette** (2026-11-04). Ctrl+Shift+P opens a fuzzy palette over
  the terminal: switch to a tab, open a new, shell, closed, restarted or
  renamed one, open any panel or toggle the sidebar, open a project (or open
  it with its related projects), resume one of the 40 most recent sessions,
  start, review or finish board tasks, refresh the board, and switch the
  theme, visual effects or the Claude Code theme. Prefix matches rank first,
  then word starts; the empty palette lists the last eight commands you ran
  (kept in `prefs.json` as `paletteRecent`). Ctrl+K stays with the shell.
- **Release pipeline** (2026-11-04). Pushing a `vX.Y.Z` tag builds an
  AppImage, a deb, an rpm and an Arch package and publishes them as a GitHub
  release, after checking the tag against the version in
  `tauri.conf.json`, `Cargo.toml` and `package.json`. A manual run, or a pull
  request that touches the pipeline, is a dry run that attaches the same
  files to the workflow run. README gains "Releases" and "Cutting a release".
- **Tab status and context gauge** (2026-11-04). Each Claude tab shows
  whether its session is busy, waiting for you (a permission prompt, a
  question, or a finished turn you have not looked at yet) or idle, and a
  thin bar with how full its context window is. A tab you are not looking at
  that starts waiting raises a desktop notification. Settings, This app,
  Terminal gains "Context window" and "Notify when a hidden tab needs you";
  the Sessions panel's LIVE badge shows the status too.
- **Board configuration** (2026-11-03). The Board and Calendar work with any
  GitHub Project (v2) you own, as a user or through an organisation: connect
  it from the Board panel's setup card or Settings, This app, Board (owner,
  project number, hub repo for epics; Reconnect and Disconnect there).
  Connecting checks the Status, Kind, Area, Scheduled and Order fields and
  says in one toast what the project lacks. Nothing about the author's board
  is compiled in any more. Without a connected project the Calendar keeps its
  rhythm, notes and activity, and `SCHEDULE.md` is written without tasks.
- **Public repo files** (2026-11-03): README rewritten for a public audience,
  CONTRIBUTING, SECURITY, this changelog, CI for the frontend and Rust checks,
  Dependabot, issue and pull request templates. AGPL-3.0-only licence.
- **Themes** (2026-11-03). Settings, Appearance gains Follow Omarchy (the
  live desktop theme, re-applied the moment `omarchy theme set` swaps it,
  chrome and every open terminal together) and seven sci-fi presets: Night
  City, The Grid, Phosphor, Replicant, Mother, NERV and Outrun, some with
  glow, scanline and square-corner effects behind a Visual effects switch.
  "Theme Claude Code too" renders `~/.claude/themes/kansei.json` from the same
  palette so Claude Code in the tabs matches. A preset can be exported as an
  Omarchy theme, and applied to the whole desktop.
- **Board and Calendar panels** (2026-11-01). The Board shows a GitHub
  Project of epics and tasks by lane, with lane moves, dates, new tasks and
  epics, all through the `gh` CLI with a local cache. The Calendar plans days
  with a weekly rhythm, per-day notes and the board's scheduled tasks, shows
  which projects had Claude prompts each day, and writes `SCHEDULE.md` into
  the workspace root so every Claude session knows the plan. A Today strip
  in the sidebar and a `today` chip in Projects.
- Letter shortcuts for Hooks (Ctrl+Shift+H) and Settings (Ctrl+Shift+,)
  (2026-11-01).
- **Projects, Workspaces, Rules and Sessions** (2026-10-31). Projects shows
  every project under the workspace roots as a tree (groups, wrapper folders,
  monorepo apps and packages, git worktrees), opens one as a Claude tab or
  with related projects (`--add-dir`), and keeps `PROJECTS.md` and a
  `CLAUDE.md` import up to date. Rules edits user and project `.claude/rules`
  with path globs. Sessions indexes history, live sessions and transcripts
  and resumes one into a tab.
- Project scope (2026-10-31): Rules, Agents, Skills, MCPs, Hooks and Settings
  switch between the user files and the active tab's project files.
- MCPs panel lists, read only, the servers from installed plugins, claude.ai
  connectors and the built-in Chrome server (2026-10-31).
- "Claude command" preference, defaulting to `~/.local/bin/claude` when that
  launcher exists (2026-10-31).
- Main-thread watchdog with a stack capture (`eu-stack`) on stalls, and a log
  in the app data dir (2026-10-31).
- Arch Linux PKGBUILD and desktop entry; `KANSEI_DATA_DIR` for separate test
  instances (2026-10-31).
- A content security policy for release and dev builds (2026-10-31).
- **Initial cockpit** (2026-10-31): Tauri 2 + React shell with a resizable
  sidebar, a rail of terminal tabs (Rust pty, xterm.js, all tabs kept alive),
  a CodeMirror editor sheet, and the Memory, MCPs, Agents, Skills, Workflows,
  Hooks and Settings panels editing the real files under `~/.claude` and
  `~/.claude.json` through a path allowlist that always refuses
  `~/.claude/.credentials.json`. A debug-only driver socket for UI checks.

### Changed

- **Renamed from Tsukue to Kansei** (2026-11-03). The binary, package, data
  dir and environment variables changed name with it. The app moves
  `~/.local/share/tsukue` to `~/.local/share/kansei` at startup, merging newer
  files when both exist, and the Arch package replaces `tsukue`.
- The NVIDIA workarounds (`__NV_DISABLE_EXPLICIT_SYNC=1`,
  `__GL_SYNC_TO_VBLANK=0`) are set inside the binary and override the
  session's values; `KANSEI_NVIDIA_ENV=keep` opts out (2026-11-01).

### Fixed

- A hidden tab's terminal (and its pty) no longer shrinks to 11x5 when it is
  hidden: WebKitGTK measured the display:none container as a small box
  instead of nothing, so the fit now skips a host with no size (2026-11-04).
- No more main-thread hang while the window sits on a hidden Hyprland
  workspace on NVIDIA (`__GL_SYNC_TO_VBLANK=0`, 2026-10-31; kept when a
  gaming profile in `environment.d` sets it back, 2026-11-01).
- Terminal spawn and fit no longer depend on `requestAnimationFrame` firing,
  so tabs opened on a hidden Wayland surface start correctly (2026-10-31).
- pty commands run off the main thread (2026-10-31).
- Raw MCP secrets are masked in the MCPs panel (2026-10-31).
