/**
 * Codex CLI notification integration.
 *
 * Uses codex's `notify` config to receive agent-turn-complete callbacks.
 * Each spawn receives a unique ATOO_HOOK_TOKEN env var. The notify
 * callback script sends this token alongside the payload so Atoo Studio
 * can map callbacks to the correct agent session.
 *
 * Unlike Claude hooks (stdin-based, multiple event types), Codex notify
 * passes payload as CLI arg $1 and only fires `agent-turn-complete`.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { WEB_PORT } from '../../../config.js';
import { store } from '../../../state/store.js';

// ═══════════════════════════════════════════════════════
// Notify token registry
// ═══════════════════════════════════════════════════════

interface NotifyEntry {
  agentSessionId: string;
  cwd: string;
  threadId: string | null;
  resolveThreadId: ((threadId: string) => void) | null;
}

const notifyTokens = new Map<string, NotifyEntry>();

export function generateNotifyToken(): string {
  return `codex_${uuidv4()}`;
}

/**
 * Register a notify token for a codex agent session.
 * Returns a promise that resolves to the thread-id on first agent-turn-complete.
 */
export function registerNotifyToken(token: string, agentSessionId: string, cwd: string): Promise<string> {
  return new Promise<string>((resolve) => {
    notifyTokens.set(token, {
      agentSessionId,
      cwd,
      threadId: null,
      resolveThreadId: resolve,
    });
  });
}

/**
 * Called by the HTTP endpoint when a codex notify callback arrives.
 */
export function handleCodexNotifyCallback(token: string, payload: any): void {
  const entry = notifyTokens.get(token);
  if (!entry) {
    console.warn(`[codex-notify] Unknown notify token: ${token}`);
    return;
  }

  if (payload.type === 'agent-turn-complete') {
    const threadId = payload['thread-id'];

    // First callback: resolve thread-id for session discovery
    if (threadId && !entry.threadId) {
      entry.threadId = threadId;
      if (entry.resolveThreadId) {
        entry.resolveThreadId(threadId);
        entry.resolveThreadId = null;
      }
      console.log(`[codex-notify] Discovered thread-id for ${entry.agentSessionId}: ${threadId}`);
    }

    // Turn complete → needs attention (amber badge)
    store.setAgentStatus(entry.agentSessionId, 'waiting');
  }
}

export function removeNotifyToken(token: string): void {
  notifyTokens.delete(token);
}

// ═══════════════════════════════════════════════════════
// Notify callback script + codex config setup
// ═══════════════════════════════════════════════════════

const ATOO_DIR = path.join(os.homedir(), '.atoo-studio');
const NOTIFY_SCRIPT_PATH = path.join(ATOO_DIR, 'codex-notify-callback.sh');
let notifyScriptReady = false;

/**
 * One-time setup: ensure the notify callback shell script exists
 * and codex config.toml has the notify entry.
 */
export function setupCodexNotify(): void {
  if (notifyScriptReady) return;

  try { fs.mkdirSync(ATOO_DIR, { recursive: true }); } catch {}

  // Codex passes payload as $1 (CLI arg), not stdin.
  // When ATOO_HOOK_TOKEN is unset (standalone codex), exit silently.
  const script = `#!/bin/bash
[ -z "$ATOO_HOOK_TOKEN" ] && exit 0
printf '{"token":"%s","payload":%s}' "$ATOO_HOOK_TOKEN" "$1" | \\
  curl -s --max-time 5 -k -X POST "https://localhost:\${ATOO_WEB_PORT:-${WEB_PORT}}/api/codex/notify-callback" \\
    -H 'Content-Type: application/json' -d @-
`;

  try {
    let existing = '';
    try { existing = fs.readFileSync(NOTIFY_SCRIPT_PATH, 'utf-8'); } catch {}
    if (existing !== script) {
      fs.writeFileSync(NOTIFY_SCRIPT_PATH, script, { mode: 0o755 });
    }
    notifyScriptReady = true;
    console.log(`[codex-notify] Notify callback script ready at ${NOTIFY_SCRIPT_PATH}`);
  } catch (err: any) {
    console.warn(`[codex-notify] Failed to write notify script:`, err.message);
  }

  // Ensure codex config.toml has our notify command
  ensureCodexNotifyConfig();
}

function ensureCodexNotifyConfig(): void {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');

  try {
    let content = '';
    try { content = fs.readFileSync(configPath, 'utf-8'); } catch {}

    if (content.includes(NOTIFY_SCRIPT_PATH)) return; // already configured

    // Remove any existing notify line(s) and add ours
    const lines = content.split('\n');
    const filtered = lines.filter(l => !l.trim().startsWith('notify'));

    // Insert after the first line (typically model = "...")
    const firstSectionIdx = filtered.findIndex(l => l.trim().startsWith('['));
    const insertIdx = firstSectionIdx > 0 ? firstSectionIdx : filtered.length;
    filtered.splice(insertIdx, 0, `notify = ["${NOTIFY_SCRIPT_PATH}"]`);

    fs.writeFileSync(configPath, filtered.join('\n'));
    console.log(`[codex-notify] Added notify config to ${configPath}`);
  } catch (err: any) {
    console.warn(`[codex-notify] Failed to update codex config:`, err.message);
  }
}

export function getNotifyScriptPath(): string {
  return NOTIFY_SCRIPT_PATH;
}
