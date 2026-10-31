#!/usr/bin/env bash
# Start Tsukue in dev mode detached, log to /tmp/tsukue-dev.log.
# Kills a previous instance and its Vite server first.
cd "$(dirname "$0")"
pkill -x tsukue 2>/dev/null
fuser -k 1420/tcp >/dev/null 2>&1
sleep 1
# NVIDIA explicit sync breaks WebKitGTK's DMA-BUF renderer ("Missing acquire timeline"); disabling it keeps the GPU path.
# (the binary sets __NV_DISABLE_EXPLICIT_SYNC itself when an NVIDIA driver is present)
export TSUKUE_DRIVER=/tmp/tsukue-driver.sock
rm -f "$TSUKUE_DRIVER"
setsid nohup pnpm tauri dev > /tmp/tsukue-dev.log 2>&1 &
echo "started, log /tmp/tsukue-dev.log"
