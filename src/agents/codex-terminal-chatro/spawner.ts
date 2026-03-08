/**
 * Codex Terminal+ChatRO spawn logic.
 * Spawns a plain `codex` PTY or `codex resume <uuid>`.
 */
import os from 'os';
import { spawnProcess } from '../../spawner.js';
import { WEB_PORT } from '../../config.js';
import { setupCodexNotify } from '../lib/codex/notify.js';

export function spawnCodexCliProcess(options: {
  skipPermissions?: boolean;
  cwd?: string;
  resumeSessionUuid?: string;
  notifyToken?: string;
}): string {
  const cwd = options.cwd || process.env.HOME || os.homedir();

  let command: string;
  let args: string[];

  const baseArgs: string[] = [];
  if (options.skipPermissions) baseArgs.push('--full-auto');

  if (options.resumeSessionUuid) {
    // codex resume <session_id> [flags]
    command = 'codex';
    args = ['resume', options.resumeSessionUuid, ...baseArgs];
  } else {
    command = 'codex';
    args = [...baseArgs];
  }

  // Ensure notify script + config are ready
  setupCodexNotify();

  const env = { ...process.env };

  // Inject notify callback env vars (like Claude's hook token)
  if (options.notifyToken) {
    env.CCPROXY_HOOK_TOKEN = options.notifyToken;
    env.CCPROXY_WEB_PORT = String(WEB_PORT);
  }

  const { envId } = spawnProcess({
    command,
    args,
    cwd,
    env,
    logPrefix: 'codex-terminal-chatro',
  });

  return envId;
}
