/**
 * Claude Code Terminal+ChatRO–specific spawn logic.
 * Plain `claude` PTY — no MITM, no /remote-control, but with MCP and system prompt.
 */
import os from 'os';
import { spawnProcess } from '../../spawner.js';
import { ensureWorkspaceTrust } from '../lib/claude/workspace-trust.js';
import { getMcpConfigPath, MCP_SYSTEM_PROMPT, CHAIN_SYSTEM_PROMPT } from '../../mcp/config.js';

export function spawnTerminalCliProcess(options: {
  skipPermissions?: boolean;
  cwd?: string;
  resumeSessionUuid?: string;
  isChainContinuation?: boolean;
}): string {
  const cwd = options.cwd || process.env.HOME || os.homedir();
  ensureWorkspaceTrust(cwd);

  const systemPrompt = options.isChainContinuation
    ? MCP_SYSTEM_PROMPT + CHAIN_SYSTEM_PROMPT
    : MCP_SYSTEM_PROMPT;
  const mcpConfigPath = getMcpConfigPath(options.resumeSessionUuid);

  const args: string[] = [];
  if (options.skipPermissions) args.push('--dangerously-skip-permissions');
  args.push('--append-system-prompt', systemPrompt, '--mcp-config', mcpConfigPath);
  if (options.resumeSessionUuid) args.push('--resume', options.resumeSessionUuid);

  const env = { ...process.env };
  delete env.CLAUDECODE;

  const { envId } = spawnProcess({
    command: 'claude',
    args,
    cwd,
    env,
    logPrefix: 'claude-terminal-chatro',
  });

  return envId;
}
