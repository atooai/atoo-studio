#!/usr/bin/env bash
# Restart atoo-studio: kill current process, rebuild, and restart.
# Safe to run from an atoo-studio terminal — detaches from the parent.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="/tmp/atoo-studio-restart.log"

# Detach: if we're still attached to atoo-studio, re-exec under nohup/setsid
if [ -z "$_ATOO_RESTART_DETACHED" ]; then
  export _ATOO_RESTART_DETACHED=1
  echo "Detaching and restarting in background. Follow progress: tail -f $LOG"
  nohup setsid bash "$0" "$@" > "$LOG" 2>&1 &
  disown
  exit 0
fi

echo "=== atoo-studio restart — $(date) ==="

# 1. Find and kill running atoo-studio node processes
echo "Killing atoo-studio processes..."
# Match the main server process (tsx src/index.ts) and vite build
pkill -f "tsx.*src/index.ts" 2>/dev/null && echo "  Killed tsx server" || echo "  No tsx server found"
pkill -f "vite build --watch" 2>/dev/null && echo "  Killed vite watcher" || echo "  No vite watcher found"
# Also kill any `npm run dev` shell wrappers
pkill -f "npm run dev.*atoo-studio" 2>/dev/null || true

# Give processes time to exit
sleep 2

# Verify they're gone
if pgrep -f "tsx.*src/index.ts" > /dev/null 2>&1; then
  echo "  Force-killing remaining processes..."
  pkill -9 -f "tsx.*src/index.ts" 2>/dev/null || true
  pkill -9 -f "vite build --watch" 2>/dev/null || true
  sleep 1
fi

# 2. Rebuild
echo "Building backend..."
cd "$SCRIPT_DIR"
npm run build:backend

echo "Building frontend..."
npm run build:frontend

# 3. Restart
echo "Starting atoo-studio..."
cd "$SCRIPT_DIR"
nohup npm run dev > /tmp/atoo-studio-dev.log 2>&1 &
DEV_PID=$!
echo "Started (PID $DEV_PID). Dev log: /tmp/atoo-studio-dev.log"

echo "=== Restart complete — $(date) ==="
