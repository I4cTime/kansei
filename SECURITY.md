# Security Policy

## Supported Versions

Kansei has no releases yet; only the current `main` is supported.

| Version | Supported |
|---------|-----------|
| 0.1.x (`main`) | Yes |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please report them privately using one of the following methods:

### 1. GitHub Private Vulnerability Reporting (preferred)

**[Report a vulnerability](https://github.com/I4cTime/kansei/security/advisories/new)**

### 2. Email

Send details to the maintainer directly. You can find contact information on
the [@I4cTime GitHub profile](https://github.com/I4cTime).

## What to Include

- **Description** of the vulnerability and its potential impact.
- **Steps to reproduce** or a proof of concept.
- **Commit** you tested (`git rev-parse --short HEAD`, or the package version
  shown by `pacman -Q kansei`).
- **Environment**: distro, desktop or compositor, GPU driver, Claude Code
  version (`claude --version`), and whether it was a release or a debug
  build.
- **Suggested fix**, if you have one.

## Response Timeline

| Stage | Timeframe |
|-------|-----------|
| Acknowledgement | Within 48 hours |
| Initial assessment | Within 7 days |
| Fix or mitigation | Varies by severity |
| Public disclosure | After a fix is on `main` |

## What Kansei touches

Kansei is a local desktop app with no server and no network listener of its
own. It reads and writes your Claude Code configuration in place:

- files under `~/.claude` (memory, rules, agents, skills, workflows,
  settings, themes, history and transcripts) and `~/.claude.json` (MCP
  servers; a one-time `~/.claude.json.kansei-bak` backup is kept),
- a project's `.claude/`, `.mcp.json` and `CLAUDE.md` files for the folder
  of the active tab,
- `PROJECTS.md`, `SCHEDULE.md` and `CLAUDE.md` in your workspace roots,
- its own data in `~/.local/share/kansei/`.

Every file command goes through an allowlist (see `CONTRACT.md`, "Files
inside the allowlist" and "Backend behaviour notes"). Paths must be absolute,
`..` is refused, and **`~/.claude/.credentials.json` is always refused** for
read, write and delete, also through a symlink. The Board panel runs the
`gh` CLI with `GITHUB_TOKEN` removed from its environment, and terminal tabs
run `claude` or a shell as you.

## Scope

In scope:

- **File access** - any way to read, write or delete outside the allowlist,
  to reach `~/.claude/.credentials.json`, or to escape through symlinks or
  path tricks.
- **Tauri IPC surface** - a command reachable from the webview that does more
  than `CONTRACT.md` says, or a webview content-injection path (rendered
  Markdown, MCP names, issue titles, transcripts) that leads to script
  execution under the app's CSP.
- **Subprocess execution** - argument or command injection into `gh`,
  `claude`, `omarchy theme set`, `eu-stack` or the pty spawn.
- **Secrets** - MCP `env` values or tokens leaking to logs, to disk outside
  the files they came from, or to other processes. (Known: MCP `env` values
  reach the webview, masked in the UI behind an eye toggle.)
- **The dev driver socket** (`KANSEI_DRIVER`) being active in a release
  build. It is meant to be inert there.

## Out of Scope

- Vulnerabilities in Claude Code, `gh`, Omarchy, WebKitGTK or other upstream
  dependencies (report those to the respective project).
- What a `claude` session or an MCP server you run in a tab does; Kansei
  starts them with your own permissions.
- Debug builds with `KANSEI_DRIVER` set: that socket runs JavaScript in the
  webview by design, for local UI checks.
- Issues requiring physical access to an already-unlocked machine.
- Social engineering attacks.

## Recognition

We're happy to credit security researchers in the CHANGELOG unless you prefer
to remain anonymous. Let us know your preference when reporting.
