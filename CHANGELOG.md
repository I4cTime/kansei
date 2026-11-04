# Changelog

All notable changes to Kansei are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no
releases yet; everything so far is on `main` as 0.1.x.

## [Unreleased]

### Added

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

- No more main-thread hang while the window sits on a hidden Hyprland
  workspace on NVIDIA (`__GL_SYNC_TO_VBLANK=0`, 2026-10-31; kept when a
  gaming profile in `environment.d` sets it back, 2026-11-01).
- Terminal spawn and fit no longer depend on `requestAnimationFrame` firing,
  so tabs opened on a hidden Wayland surface start correctly (2026-10-31).
- pty commands run off the main thread (2026-10-31).
- Raw MCP secrets are masked in the MCPs panel (2026-10-31).
