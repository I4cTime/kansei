# Tsukue

A personal Claude Code cockpit for Omarchy. One window: a left sidebar that
edits everything Claude Code reads (memory, rules, MCP servers, agents, skills,
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

On a machine with the NVIDIA driver the binary sets two driver variables for
itself before GTK starts (main.rs), unless they are already set:
`__NV_DISABLE_EXPLICIT_SYNC=1`, because NVIDIA explicit sync makes WebKitGTK's
DMA-BUF renderer die with "Missing acquire timeline" (the software fallback
`WEBKIT_DISABLE_DMABUF_RENDERER=1` works too but types with visible lag), and
`__GL_SYNC_TO_VBLANK=0`, because otherwise a repaint while the window sits on a
hidden Hyprland workspace blocks the main thread in eglSwapBuffers until the
workspace is shown again ("Application Not Responding"). `run-dev.sh` sets
`TSUKUE_DRIVER=/tmp/tsukue-driver.sock`, a debug-only socket that runs
JavaScript inside the webview for UI checks:

```sh
./drive.py 'return t.store.get(t.tabs.tabsAtom).map(x => x.title)'
./drive.py --shot /tmp/tsukue.png
```

`run-dev.sh` records the dev process group in `/tmp/tsukue-dev.pid` and on the
next run stops only that group (plus whatever holds the Vite port 1420), never
processes by name, so an installed `tsukue` keeps running. `drive.py --shot`
prefers the dev window (`target/debug/tsukue`) when both are open.

`TSUKUE_DATA_DIR=/some/dir` runs an instance with its own tabs.json and
prefs.json (useful for trying the release binary while a dev instance runs).

## Projects and workspaces

The Projects panel shows every workspace root (default `~/Develop`, edit the list
in Settings, This app, Projects) as a tree: projects directly under the root
(a top-level folder that is a repo itself, like `marketing`), groups, projects (also inside
wrapper folders like `products/mine/mineui`) and monorepo apps and packages as
subprojects. Each can be opened as its own Claude project, opened with related
projects (`claude --add-dir ...`), described (Edit) and linked (Related...).

Descriptions, status and relations live in `<appData>/workspaces.json`. From
them Tsukue keeps `<root>/PROJECTS.md` up to date (it is overwritten; edit in
the panel) and, the first time it sees a root, creates `<root>/CLAUDE.md`
importing `@PROJECTS.md` (or appends the import once to an existing one), so
every Claude session under the root knows the sibling projects. Related...
also writes `permissions.additionalDirectories` in the project's
`.claude/settings.json`, keeping entries added by hand.

Git worktrees (a `.git` file pointing elsewhere) show a "worktree" chip, are
marked "git worktree" in PROJECTS.md and do not list their monorepo apps.
Projects you hide in the panel (and their subprojects) are left out of
PROJECTS.md; unhide them to bring them back.

Prefs (`prefs.json`) for this: `workspaceRoots`, `collapsedPaths` (collapsed
roots and groups), `expandedPaths` (projects with their subprojects shown).

## Packaging

An Arch Linux package builds from the committed state of this checkout (not
uncommitted edits), so commit first:

```sh
cd packaging/arch && makepkg -si
```

That installs `/usr/bin/tsukue`, a desktop entry and hicolor icons. Node and
pnpm from mise are not pacman packages, so `makepkg -si` would try to install
the repo `nodejs` and `pnpm`; to build with the mise ones instead, use
`makepkg -f --nodeps` and then `sudo pacman -U tsukue-*.pkg.tar.zst`.

## Diagnosing a hang

A watchdog thread pings the GTK main thread every 500 ms. If no answer comes
back for more than 3 s it writes `stall start ...` to the log and captures every
thread's stack once with `eu-stack` (elfutils), then `stall end, lasted ... ms`
when the main thread answers again. At most 5 captures per run.

- Log: `<appData>/tsukue.log` (`~/.local/share/tsukue/tsukue.log`, or under
  `TSUKUE_DATA_DIR`), rotated to `tsukue.log.1` past 1 MB. It also records
  startup (version, pid, `__NV_DISABLE_EXPLICIT_SYNC`, `GDK_BACKEND`), pty
  spawns and exits, and app exit. Times are UTC (no offset is written).
- Stacks: `<appData>/stalls/<unix ts>.txt`. Rust names are mangled;
  `c++filt < ~/.local/share/tsukue/stalls/<ts>.txt` demangles them.

The package keeps the symbol table (`options=('!strip')` plus
`CARGO_PROFILE_RELEASE_STRIP=false` in the PKGBUILD) so Rust frames are
named; that makes `/usr/bin/tsukue` about 11 MB instead of 7 MB.

If the app is stuck and the watchdog did not fire (no new file in `stalls/`),
choose Wait in the "Application Not Responding" dialog and, in a terminal:

```sh
sudo eu-stack -p $(pgrep -x tsukue)
# more detail if needed:
sudo gdb -p <pid> -batch -ex "thread apply all bt"
```

Debug builds also have a `debug_block_main` command to force a stall:
`./drive.py 't.invoke("debug_block_main", {ms: 5000}); return 1'`.

## Checks

```sh
pnpm tsc --noEmit && pnpm build
cd src-tauri && cargo build && cargo test && cargo clippy --all-targets
```

## Keyboard

Ctrl+Shift+T new tab, Ctrl+Shift+W close, Ctrl+PageUp/PageDown switch,
Ctrl+Shift+B toggle sidebar, Ctrl+Shift+1..9 and 0 jump to sections 1..10
(0 is Settings), Esc closes the editor sheet and the Projects sheets (Edit,
Related, Open with), Ctrl+S saves in the editor, Ctrl+Enter saves the Edit
sheet, Ctrl+Shift+C / V copy and paste in the terminal.
