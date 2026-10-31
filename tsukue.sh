#!/usr/bin/env bash
# Launch the release build of Tsukue. WebKitGTK needs the DMA-BUF renderer off
# on this NVIDIA + Hyprland machine. Build with: pnpm tauri build --no-bundle
export WEBKIT_DISABLE_DMABUF_RENDERER=1
exec "$(dirname "$(readlink -f "$0")")/src-tauri/target/release/tsukue" "$@"
