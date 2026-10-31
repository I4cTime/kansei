# Tsukue

Personal Claude Code cockpit: left sidebar of Claude items (memory, MCPs, agents,
skills, workflows, hooks, settings), a top rail of terminal tabs, one terminal
filling the rest. Tauri 2 + React 19 + Tailwind v4 + xterm.js + CodeMirror 6.

- Read `CONTRACT.md` first: it is the design of record (layout, commands, events,
  module ownership, persistence, tokens).
- Checks: `pnpm tsc --noEmit`, `pnpm build`, `cd src-tauri && cargo build && cargo test`.
- Run: `pnpm tauri dev`. The webview caches modules; restart instead of Ctrl+R.
- No em dashes in any copy. Plain hyphens.
