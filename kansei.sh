#!/usr/bin/env bash
# Launch the release build of Kansei. WebKitGTK needs the DMA-BUF renderer off
# on this NVIDIA + Hyprland machine. Build with: pnpm tauri build --no-bundle
# NVIDIA explicit sync breaks WebKitGTK's DMA-BUF renderer ("Missing acquire timeline"); disabling it keeps the GPU path.
# (the binary sets __NV_DISABLE_EXPLICIT_SYNC itself when an NVIDIA driver is present)
exec "$(dirname "$(readlink -f "$0")")/src-tauri/target/release/kansei" "$@"
