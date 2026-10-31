#!/usr/bin/env bash
# Start Tsukue in dev mode detached, log to /tmp/tsukue-dev.log.
# Kills a previous instance and its Vite server first.
cd "$(dirname "$0")"
pkill -f 'target/debug/tsukue$' 2>/dev/null
fuser -k 1420/tcp >/dev/null 2>&1
sleep 1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export TSUKUE_DRIVER=/tmp/tsukue-driver.sock
rm -f "$TSUKUE_DRIVER"
setsid nohup pnpm tauri dev > /tmp/tsukue-dev.log 2>&1 &
echo "started, log /tmp/tsukue-dev.log"
