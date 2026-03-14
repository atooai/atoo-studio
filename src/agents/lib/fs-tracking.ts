/**
 * Shared file-tracking utilities for all agent types.
 *
 * Level 1: LD_PRELOAD — intercepts syscalls for precise before-snapshots
 * Level 2: inotify — kernel-level fs.watch (started via fsMonitor.watchPid)
 * Level 3: Tool-result fallback — detects Write/Edit/NotebookEdit from JSONL events
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fsMonitor } from '../../fs-monitor.js';
import type { SessionEvent } from '../../events/types.js';

const PRELOAD_SO_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..', '..', '..', 'preload', 'atoo-studio-preload.so'
);
const PRELOAD_SOCKET_PATH = path.join(os.homedir(), '.atoo-studio', 'preload.sock');

/**
 * Add LD_PRELOAD environment variables to an env record.
 * Only adds them if the preload .so exists on disk.
 */
export function addPreloadEnv(env: Record<string, string | undefined>, preloadSessionId: string): void {
  if (fs.existsSync(PRELOAD_SO_PATH)) {
    env.LD_PRELOAD = PRELOAD_SO_PATH;
    env.ATOO_SESSION_ID = preloadSessionId;
    env.ATOO_SOCKET_PATH = PRELOAD_SOCKET_PATH;
    env.UV_USE_IO_URING = '0';
  }
}

/**
 * Initialize all three levels of file change detection for an agent session.
 *
 * Call this after spawning the CLI process and obtaining the envId/pid.
 */
export function initFileTracking(opts: {
  sessionId: string;
  cwd: string;
  pid: number;
  preloadSessionId?: string;
}): void {
  // Level 2: inotify
  fsMonitor.watchPid(opts.sessionId, opts.pid, opts.cwd);

  // Level 1: Register preload session mapping (if preload was enabled)
  if (opts.preloadSessionId) {
    fsMonitor.registerSessionMapping(opts.preloadSessionId, opts.sessionId);
  }
}

// ═══════════════════════════════════════════════════════
// Level 3: Tool-result fallback — detect file changes from JSONL events
// ═══════════════════════════════════════════════════════

/**
 * Tracks pending tool_use blocks and detects completed file-modifying tools.
 * Create one instance per agent session and call `processEvent()` for each
 * SessionEvent received from the JSONL watcher.
 */
export class ToolResultFileTracker {
  private pendingToolUses = new Map<string, { name: string; input: any }>();
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Process a SessionEvent. Indexes tool_use blocks from assistant messages
   * and detects tool_result blocks from user messages, notifying fsMonitor
   * for Write/Edit/NotebookEdit completions.
   */
  processEvent(event: SessionEvent): void {
    if (event.type === 'assistant') {
      this.indexToolUses(event);
    } else if (event.type === 'user') {
      this.matchToolResults(event);
    } else if (event.type === 'result') {
      // Clean up stale pending tool uses at end of turn
      this.pendingToolUses.clear();
    }
  }

  private indexToolUses(event: any): void {
    const content = event.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        this.pendingToolUses.set(block.id, {
          name: block.name,
          input: block.input || {},
        });
      }
    }
  }

  private matchToolResults(event: any): void {
    const content = event.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const toolUse = this.pendingToolUses.get(block.tool_use_id);
        if (toolUse && !block.is_error) {
          this.notifyIfFileChange(toolUse);
          this.pendingToolUses.delete(block.tool_use_id);
        }
      }
    }
  }

  private notifyIfFileChange(toolUse: { name: string; input: any }): void {
    const { name, input } = toolUse;

    if (name === 'Write' && input.file_path) {
      fsMonitor.notifyToolChange(this.sessionId, input.file_path, 'Write');
    } else if (name === 'Edit' && input.file_path) {
      fsMonitor.notifyToolChange(this.sessionId, input.file_path, 'Edit');
    } else if (name === 'NotebookEdit' && input.notebook_path) {
      fsMonitor.notifyToolChange(this.sessionId, input.notebook_path, 'Edit');
    }
  }
}
