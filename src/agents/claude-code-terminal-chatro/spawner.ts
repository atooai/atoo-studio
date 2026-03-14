/**
 * Claude Code Terminal+ChatRO–specific spawn logic.
 * Plain `claude` PTY with MCP, system prompt, and LD_PRELOAD for file tracking.
 */
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { spawnProcess } from '../../spawner.js';
import { ensureWorkspaceTrust } from '../lib/claude/workspace-trust.js';
import { getMcpConfigPath, MCP_SYSTEM_PROMPT, CHAIN_SYSTEM_PROMPT } from '../../mcp/config.js';
import { addPreloadEnv } from '../lib/fs-tracking.js';

export function spawnTerminalCliProcess(options: {
  skipPermissions?: boolean;
  cwd?: string;
  resumeSessionUuid?: string;
  isChainContinuation?: boolean;
}): { envId: string; preloadSessionId: string } {
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

  const preloadSessionId = uuidv4();
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE;
  addPreloadEnv(env, preloadSessionId);

  const { envId } = spawnProcess({
    command: 'claude',
    args,
    cwd,
    env,
    preloadSessionId,
    logPrefix: 'claude-terminal-chatro',
  });

  return { envId, preloadSessionId };
}
