# Tsukue

A personal Claude Code cockpit for Omarchy. One window: a left sidebar that
edits everything Claude Code reads (memory, MCP servers, agents, skills,
workflows, hooks, settings), a top rail of terminal tabs, and a terminal
filling the rest, each tab running `claude` in a folder of your choice.

Tauri 2 + React 19 + Tailwind v4 + xterm.js + CodeMirror 6. Rust pty via
portable-pty. Design of record: `CONTRACT.md`.

## Run

```sh
pnpm install
./run-dev.sh          # detached dev build, log in /tmp/tsukue-dev.log
pnpm tauri build      # release bundle (deb, rpm, AppImage)
```

`run-dev.sh` sets `__NV_DISABLE_EXPLICIT_SYNC=1`, because NVIDIA explicit sync
makes WebKitGTK's DMA-BUF renderer die with "Missing acquire timeline" on this
Hyprland machine (the software fallback `WEBKIT_DISABLE_DMABUF_RENDERER=1` works
too but types with visible lag), and `TSUKUE_DRIVER=/tmp/tsukue-driver.sock`,
a debug-only socket that runs JavaScript inside the webview for UI checks:

```sh
./drive.py 'return t.store.get(t.tabs.tabsAtom).map(x => x.title)'
./drive.py --shot /tmp/tsukue.png
```

`TSUKUE_DATA_DIR=/some/dir` runs an instance with its own tabs.json and
prefs.json (useful for trying the release binary while a dev instance runs).

## Checks

```sh
pnpm tsc --noEmit && pnpm build
cd src-tauri && cargo build && cargo test && cargo clippy --all-targets
```

## Keyboard

Ctrl+Shift+T new tab, Ctrl+Shift+W close, Ctrl+PageUp/PageDown switch,
Ctrl+Shift+B toggle sidebar, Ctrl+Shift+1..8 jump to a section, Esc closes
the editor sheet, Ctrl+S saves in it, Ctrl+Shift+C / V copy and paste in the
terminal.
