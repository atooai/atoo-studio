# ⚠️ Filesystem monitoring is DISABLED

**Disabled:** 2026-06-10 — at the user's request (not currently used; may be re-enabled later).

## What's off

All filesystem change-tracking is switched off via a single master flag:

```ts
// src/fs-monitor.ts
export const FS_MONITOR_DISABLED = true;
```

While `true`, three things are skipped (each guarded by an early `return`, nothing removed):

| What | Where | Effect when disabled |
|------|-------|----------------------|
| Preload Unix-socket server | `FsMonitor.connect()` — `src/fs-monitor.ts` | `~/.atoo-studio/preload.sock` is not created/listened on |
| Recursive `fs.watch` (inotify) + initial dir snapshot | `FsMonitor.watchPid()` — `src/fs-monitor.ts` | no inotify watches are registered for agent working dirs |
| `LD_PRELOAD` injection into spawned agents | `addPreloadEnv()` — `src/agents/lib/fs-tracking.ts` | agents run without `atoo-studio-preload.so` |

The read-only changes API (`src/handlers/changes.ts`, the `/changes` endpoints) still works — it just reports no tracked changes (`available: false`).

## Why

The recursive `fs.watch({ recursive: true })` accumulated **~241,000 inotify watches** across all agent working directories (the per-event exclusion filter does not stop directories from being *watched*, only from being *processed*). Combined with a synchronous per-event handler that does `readFileSync` + full-file SHA-256 on the main thread, a burst of file activity (long test runs, Docker builds) saturated the single Node main thread, froze the event loop, and **wedged every agent's terminal** (even `true` would hang). See also the 44 GB unpruned object store at `~/.atoo-studio/objects`.

## How to re-enable

1. Set `FS_MONITOR_DISABLED = false` in `src/fs-monitor.ts`.
2. The dev server (`tsx --watch`) reloads automatically; otherwise `bash restart.sh`.
3. **Before re-enabling for real**, consider fixing the root causes first:
   - swap recursive `fs.watch` for a watcher with ignore globs (chokidar / `@parcel/watcher`) so `node_modules`, `.git`, Docker dirs, etc. are never watched;
   - move file hashing off the main thread (worker pool) and add a max-file-size cap;
   - bound the in-memory `changes` / `preloadReportedPaths` maps and prune `~/.atoo-studio/objects`.

## Grep anchor

Search the codebase for `FS_MONITOR_DISABLED` to find the flag and every guard.
