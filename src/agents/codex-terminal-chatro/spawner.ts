/**
 * Codex Terminal+ChatRO spawn logic.
 * Spawns a plain `codex` PTY or `codex resume <uuid>`.
 */
import os from 'os';
import { spawnProcess } from '../../spawner.js';
import { WEB_PORT } from '../../config.js';
import { setupCodexNotify } from '../lib/codex/notify.js';
import { getMcpServerDef, MCP_SYSTEM_PROMPT, CHAIN_SYSTEM_PROMPT } from '../../mcp/config.js';

export function spawnCodexCliProcess(options: {
  skipPermissions?: boolean;
  cwd?: string;
  resumeSessionUuid?: string;
  notifyToken?: string;
  isChainContinuation?: boolean;
}): string {
  const cwd = options.cwd || process.env.HOME || os.homedir();

  let command: string;
  let args: string[];

  const baseArgs: string[] = [];
  if (options.skipPermissions) baseArgs.push('--full-auto');

  // Inject MCP server config via -c flags (per-process, doesn't affect other codex instances)
  const mcp = getMcpServerDef();
  baseArgs.push('-c', `mcp_servers.atoo-studio.command="${mcp.command}"`);
  baseArgs.push('-c', `mcp_servers.atoo-studio.args=${JSON.stringify(mcp.args)}`);
  for (const [key, value] of Object.entries(mcp.env)) {
    baseArgs.push('-c', `mcp_servers.atoo-studio.env.${key}="${value}"`);
  }

  // Inject system prompt with MCP tool usage instructions
  const systemPrompt = options.isChainContinuation
    ? MCP_SYSTEM_PROMPT + CHAIN_SYSTEM_PROMPT
    : MCP_SYSTEM_PROMPT;
  baseArgs.push('-c', `developer_instructions=${JSON.stringify(systemPrompt)}`);

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
    env.ATOO_HOOK_TOKEN = options.notifyToken;
    env.ATOO_WEB_PORT = String(WEB_PORT);
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
