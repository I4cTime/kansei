#!/usr/bin/env bash
# Start Kansei in dev mode detached, log to /tmp/kansei-dev.log. `run-dev.sh stop` only stops it.
# Stops only the dev instance this script started before (its process group,
# recorded in a pidfile) plus whatever holds the Vite port. Never kills by name:
# the packaged Kansei binary is also called `kansei`.
cd "$(dirname "$0")"
PIDFILE=/tmp/kansei-dev.pid
if [ -f "$PIDFILE" ]; then
  pgid=$(cat "$PIDFILE" 2>/dev/null)
  if [[ "$pgid" =~ ^[0-9]+$ ]] && kill -0 -- "-$pgid" 2>/dev/null; then
    kill -- "-$pgid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 -- "-$pgid" 2>/dev/null || break
      sleep 0.3
    done
    kill -KILL -- "-$pgid" 2>/dev/null
  fi
  rm -f "$PIDFILE"
fi
if [ "${1:-}" = "stop" ]; then
  fuser -k 1420/tcp >/dev/null 2>&1
  echo "stopped"
  exit 0
fi
fuser -k 1420/tcp >/dev/null 2>&1
sleep 1
# NVIDIA explicit sync breaks WebKitGTK's DMA-BUF renderer ("Missing acquire timeline"); disabling it keeps the GPU path.
# (the binary sets __NV_DISABLE_EXPLICIT_SYNC itself when an NVIDIA driver is present)
export KANSEI_DRIVER=/tmp/kansei-driver.sock
rm -f "$KANSEI_DRIVER"
# setsid makes pnpm the leader of a new process group, so its pid is the group id.
setsid nohup pnpm tauri dev > /tmp/kansei-dev.log 2>&1 &
echo $! > "$PIDFILE"
echo "started (pgid $(cat "$PIDFILE")), log /tmp/kansei-dev.log"
