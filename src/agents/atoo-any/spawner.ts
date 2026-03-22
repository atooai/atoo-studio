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
  /** The parent atoo-any session UUID — used for MCP session identity */
  parentSessionUuid: string;
  /** Model ID from agent selector (e.g. 'opus-4.6', 'gpt-5.4') */
  model?: string;
  /** Reasoning effort level (e.g. 'low', 'medium', 'high') */
  reasoning?: string;
}

// Map frontend model IDs to CLI model names
const CLAUDE_MODEL_MAP: Record<string, string> = {
  'opus-4.6': 'claude-opus-4-6',
  'sonnet-4.6': 'claude-sonnet-4-6',
  'sonnet-4.5': 'claude-sonnet-4-5-20241022',
  'haiku-4.5': 'claude-haiku-4-5-20251001',
};

const CODEX_MODEL_MAP: Record<string, string> = {
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.4-mini': 'gpt-5.4-mini',
  'gpt-5.3-codex': 'codex-5.3',
  'gpt-5.3-codex-spark': 'codex-spark-5.3',
};

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

  const mcpConfigPath = getMcpConfigPath(options.parentSessionUuid);
  const args = [
    '-p', options.message,
    '--resume', options.resumeUuid,
    '--dangerously-skip-permissions',
    '--append-system-prompt', MCP_SYSTEM_PROMPT,
    '--mcp-config', mcpConfigPath,
  ];

  // Add model and effort if specified
  if (options.model) {
    const cliModel = CLAUDE_MODEL_MAP[options.model] || options.model;
    args.push('--model', cliModel);
  }
  if (options.reasoning) {
    args.push('--effort', options.reasoning);
  }

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
    ATOO_CURRENT_SESSION_UUID: options.parentSessionUuid,
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

  // Add model and reasoning effort if specified
  if (options.model) {
    const cliModel = CODEX_MODEL_MAP[options.model] || options.model;
    args.push('-m', cliModel);
  }
  if (options.reasoning) {
    args.push('-c', `model_reasoning_effort="${options.reasoning}"`);
  }

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
