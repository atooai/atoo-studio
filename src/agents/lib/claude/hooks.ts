/**
 * Claude Code hooks integration.
 * Uses --settings CLI flag to inject hooks per-process, avoiding any
 * modification to the user's global ~/.claude/settings.json.
 *
 * Each spawn receives a unique CCPROXY_HOOK_TOKEN env var. The hook
 * callback script sends this token alongside the hook payload so
 * ccproxy can map callbacks to the correct agent session.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { WEB_PORT } from '../../../config.js';
import { store } from '../../../state/store.js';

// ═══════════════════════════════════════════════════════
// Hook token registry
// ═══════════════════════════════════════════════════════

interface HookEntry {
  agentSessionId: string;
  cwd: string;
  cliSessionUuid: string | null;
  resolveSessionId: ((uuid: string) => void) | null;
}

const hookTokens = new Map<string, HookEntry>();

export function generateHookToken(): string {
  return `hook_${uuidv4()}`;
}

/**
 * Register a hook token for an agent session.
 * Returns a promise that resolves to the CLI session UUID when SessionStart fires.
 */
export function registerHookToken(token: string, agentSessionId: string, cwd: string): Promise<string> {
  return new Promise<string>((resolve) => {
    hookTokens.set(token, {
      agentSessionId,
      cwd,
      cliSessionUuid: null,
      resolveSessionId: resolve,
    });
  });
}

/**
 * Called by the HTTP endpoint when a hook callback arrives.
 */
export function handleHookCallback(token: string, payload: any): void {
  const entry = hookTokens.get(token);
  if (!entry) {
    console.warn(`[claude-hooks] Unknown hook token: ${token}`);
    return;
  }

  const eventName = payload.hook_event_name;

  switch (eventName) {
    case 'SessionStart': {
      const uuid = payload.session_id;
      if (uuid) {
        entry.cliSessionUuid = uuid;
        if (entry.resolveSessionId) {
          entry.resolveSessionId(uuid);
          entry.resolveSessionId = null;
        }
        console.log(`[claude-hooks] SessionStart for ${entry.agentSessionId}: CLI session ${uuid}`);
      }
      break;
    }

    case 'UserPromptSubmit':
      store.setAgentStatus(entry.agentSessionId, 'active');
      break;

    case 'Stop':
    case 'SubagentStop':
      store.setAgentStatus(entry.agentSessionId, 'idle');
      break;

    case 'Notification':
      // Notifications during a session typically mean permission prompts
      store.setAgentStatus(entry.agentSessionId, 'waiting');
      break;

    default:
      break;
  }
}

export function removeHookToken(token: string): void {
  hookTokens.delete(token);
}

// ═══════════════════════════════════════════════════════
// Per-process hooks via --settings flag
// ═══════════════════════════════════════════════════════

const CCPROXY_DIR = path.join(os.homedir(), '.ccproxy');
const HOOK_SCRIPT_PATH = path.join(CCPROXY_DIR, 'hook-callback.sh');
let hookScriptReady = false;

/**
 * One-time setup: ensure the hook callback shell script exists.
 * Called once before the first agent spawn.
 */
export function setupHooks(): void {
  if (hookScriptReady) return;

  try {
    fs.mkdirSync(CCPROXY_DIR, { recursive: true });
  } catch {}

  const script = `#!/bin/bash
payload=$(cat)
printf '{"token":"%s","payload":%s}' "$CCPROXY_HOOK_TOKEN" "$payload" | \\
  curl -s --max-time 5 -k -X POST "https://localhost:\${CCPROXY_WEB_PORT:-${WEB_PORT}}/api/hooks/callback" \\
    -H 'Content-Type: application/json' -d @- || true
`;

  try {
    let existing = '';
    try { existing = fs.readFileSync(HOOK_SCRIPT_PATH, 'utf-8'); } catch {}
    if (existing !== script) {
      fs.writeFileSync(HOOK_SCRIPT_PATH, script, { mode: 0o755 });
    }
    hookScriptReady = true;
    console.log(`[claude-hooks] Hook callback script ready at ${HOOK_SCRIPT_PATH}`);
  } catch (err: any) {
    console.warn(`[claude-hooks] Failed to write hook script:`, err.message);
  }
}

/**
 * Get the --settings CLI args to inject hooks into a specific claude process.
 * Returns args array: ['--settings', '<json>']
 */
export function getHooksSettingsArgs(): string[] {
  setupHooks();

  const cmd = `bash ${HOOK_SCRIPT_PATH}`;

  const hookDef = () => [{
    hooks: [{
      type: 'command',
      command: cmd,
      timeout: 10,
    }],
  }];

  const settings = {
    hooks: {
      SessionStart: hookDef(),
      UserPromptSubmit: hookDef(),
      Stop: hookDef(),
      SubagentStop: hookDef(),
      Notification: hookDef(),
    },
  };

  return ['--settings', JSON.stringify(settings)];
}
