/**
 * CLI spawning helpers for atoo-any agent.
 * Spawns Claude and Codex in one-shot non-interactive mode with
 * MCP tools and system prompt extensions (matching terminal agents).
 */
import crypto from 'crypto';
import { spawnProcess, type ITerminal } from '../../spawner.js';
import { ensureWorkspaceTrust } from '../lib/claude/workspace-trust.js';
import { getMcpConfigPath, getMcpServerDef, MCP_SYSTEM_PROMPT, registerMcpToken } from '../../mcp/config.js';

interface OneShotOptions {
  cwd: string;
  resumeUuid: string;
  message: string;
}

interface SpawnResult {
  envId: string;
  term: ITerminal;
}

/**
 * Spawn Claude Code in print mode (-p) with --resume.
 * Non-interactive: sends the message, processes it, and exits.
 * Includes MCP config and system prompt like terminal agents.
 */
export function spawnClaudeOneShot(options: OneShotOptions): SpawnResult {
  ensureWorkspaceTrust(options.cwd);

  const mcpConfigPath = getMcpConfigPath(options.resumeUuid);
  const args = [
    '-p', options.message,
    '--resume', options.resumeUuid,
    '--dangerously-skip-permissions',
    '--append-system-prompt', MCP_SYSTEM_PROMPT,
    '--mcp-config', mcpConfigPath,
  ];

  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE; // Prevent nested Claude detection

  const { envId, term } = spawnProcess({
    command: 'claude',
    args,
    cwd: options.cwd,
    env,
    logPrefix: 'atoo-any-claude',
  });

  return { envId, term };
}

/**
 * Spawn Codex in exec resume mode.
 * Non-interactive: resumes the session with a prompt, processes it, and exits.
 * Includes MCP config and system prompt like terminal agents.
 */
export function spawnCodexOneShot(options: OneShotOptions): SpawnResult {
  // Inject MCP server config via -c flags
  const mcpToken = crypto.randomUUID();
  registerMcpToken(mcpToken);
  const mcp = getMcpServerDef();
  const mcpEnv: Record<string, string> = {
    ...mcp.env,
    ATOO_MCP_TOKEN: mcpToken,
    ATOO_CURRENT_SESSION_UUID: options.resumeUuid,
  };

  const mcpArgs: string[] = [];
  mcpArgs.push('-c', `mcp_servers.atoo-studio.command="${mcp.command}"`);
  mcpArgs.push('-c', `mcp_servers.atoo-studio.args=${JSON.stringify(mcp.args)}`);
  for (const [key, value] of Object.entries(mcpEnv)) {
    mcpArgs.push('-c', `mcp_servers.atoo-studio.env.${key}="${value}"`);
  }
  mcpArgs.push('-c', `developer_instructions=${JSON.stringify(MCP_SYSTEM_PROMPT)}`);

  const args = [
    'exec', 'resume',
    options.resumeUuid,
    options.message,
    '--full-auto',
    ...mcpArgs,
  ];

  const env: Record<string, string | undefined> = { ...process.env };

  const { envId, term } = spawnProcess({
    command: 'codex',
    args,
    cwd: options.cwd,
    env,
    logPrefix: 'atoo-any-codex',
  });

  return { envId, term };
}
