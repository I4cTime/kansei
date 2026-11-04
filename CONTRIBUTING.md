# Contributing to Kansei

Kansei is a personal tool that is public so others can use it, learn from it
or fork it. Fixes and generic improvements are welcome; read the scope note
below before starting on anything larger.

## Setup

See [README.md, Install](README.md#install) for requirements and
[Run](README.md#run) for the dev loop (`pnpm tauri dev` or `./run-dev.sh`).
Don't duplicate those steps here - if they go stale, fix them there.

- **pnpm only.** Do not commit a `package-lock.json` or `yarn.lock`.
- Linux only. You need the Tauri Linux system packages even for
  `cargo test`, because the crate depends on `tauri`.

## CONTRACT.md is law

[`CONTRACT.md`](CONTRACT.md) is the design of record: layout, keyboard, every
Rust command with its arguments and errors, events, module ownership,
persistence, visual tokens, and one section per feature. Spec first, then
code: change the contract, then make the code match, and keep the two in
agreement in the same commit. If you find code that has drifted from the
contract, fix both together; never leave them disagreeing.

## Before opening a PR

All of these must pass (CI runs the same):

```sh
pnpm typecheck
pnpm test
pnpm build
cd src-tauri
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
```

- New Rust behaviour needs a test next to it. Tests must not talk to GitHub
  or touch your real `~/.claude` (the existing ones use temp dirs and a fake
  `gh` runner).
- User-facing changes get a line in `CHANGELOG.md` under `[Unreleased]`.
- No em dashes anywhere (UI strings, docs, commit messages): plain hyphens.

## Scope

This is the author's daily driver, so some parts encode one person's
workflow on purpose: the Board's conventions (the Status, Kind, Area,
Scheduled and Order fields of the connected GitHub Project), the keyboard
map, the `~/Develop` default and the panel order. **PRs that change those
should start as an issue**, so we can agree on the shape first.

Generic Claude Code tooling (the panels that edit `~/.claude`, the terminal
tabs, themes) is open for improvements as long as it keeps editing the real
files in place and keeps the safety rules in CONTRACT.md (the path allowlist,
`~/.claude/.credentials.json` always refused).

## Commit messages

Plain sentence subjects that say what changed, not Conventional Commits.
Match the existing history (`git log --oneline`), for example:

```
Rules panel: user and project .claude/rules with path globs
Legacy data dir: migrate only at startup, merge newer files when both dirs exist
```

An area prefix (`Board:`, `files:`, `PKGBUILD:`) is fine when it helps. One
logical change per commit; the contract change goes in the same commit as
the code it describes.
