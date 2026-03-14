/**
 * Codex Terminal+ChatRO spawn logic.
 * Spawns a plain `codex` PTY or `codex resume <uuid>`.
 */
import crypto from 'crypto';
import os from 'os';
import { spawnProcess } from '../../spawner.js';
import { getMcpServerDef, MCP_SYSTEM_PROMPT, CHAIN_SYSTEM_PROMPT, registerMcpToken } from '../../mcp/config.js';

export function spawnCodexCliProcess(options: {
  skipPermissions?: boolean;
  cwd?: string;
  resumeSessionUuid?: string;
  isChainContinuation?: boolean;
}): string {
  const cwd = options.cwd || process.env.HOME || os.homedir();

  let command: string;
  let args: string[];

  const baseArgs: string[] = [];
  if (options.skipPermissions) baseArgs.push('--full-auto');

  // Inject MCP server config via -c flags (per-process, doesn't affect other codex instances)
  const mcpToken = crypto.randomUUID();
  registerMcpToken(mcpToken);
  const mcp = getMcpServerDef();
  const mcpEnv: Record<string, string> = { ...mcp.env, ATOO_MCP_TOKEN: mcpToken };
  if (options.resumeSessionUuid) {
    mcpEnv.ATOO_CURRENT_SESSION_UUID = options.resumeSessionUuid;
  }
  baseArgs.push('-c', `mcp_servers.atoo-studio.command="${mcp.command}"`);
  baseArgs.push('-c', `mcp_servers.atoo-studio.args=${JSON.stringify(mcp.args)}`);
  for (const [key, value] of Object.entries(mcpEnv)) {
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

  const env = { ...process.env };

  const { envId } = spawnProcess({
    command,
    args,
    cwd,
    env,
    logPrefix: 'codex-terminal-chatro',
  });

  return envId;
}
