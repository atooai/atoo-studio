/**
 * CLI spawning helpers for atoo-any agent.
 * Spawns Claude, Codex, and Gemini in one-shot non-interactive mode with
 * MCP tools and system prompt extensions (matching terminal agents).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnProcess, type ITerminal } from '../../spawner.js';
import { ensureWorkspaceTrust } from '../lib/claude/workspace-trust.js';
import { getMcpConfigPath, getMcpServerDef, MCP_SYSTEM_PROMPT, registerMcpToken } from '../../mcp/config.js';
import { buildGeminiInstance, GEMINI_MODEL_MAP } from '../lib/gemini/settings-builder.js';
import { addPreloadEnv } from '../lib/fs-tracking.js';

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
  /** LD_PRELOAD tracking session ID for file change detection */
  preloadSessionId?: string;
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

export interface SpawnResult {
  envId: string;
  term: ITerminal;
  pid: number;
}

export interface GeminiSpawnResult extends SpawnResult {
  cleanupInstance: () => void;
  sessionFilePath: string;
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
  if (options.preloadSessionId) addPreloadEnv(env, options.preloadSessionId);

  const { envId, term, pid } = spawnProcess({
    command: 'claude',
    args,
    cwd: options.cwd,
    env,
    logPrefix: 'atoo-any-claude',
  });

  return { envId, term, pid };
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
  if (options.preloadSessionId) addPreloadEnv(env, options.preloadSessionId);

  const { envId, term, pid } = spawnProcess({
    command: 'codex',
    args,
    cwd: options.cwd,
    env,
    logPrefix: 'atoo-any-codex',
  });

  return { envId, term, pid };
}

/**
 * Spawn Gemini CLI in non-interactive mode (-p) with --resume.
 * Uses GEMINI_CLI_HOME per-instance isolation for MCP and system prompt.
 * Returns the session file path for the JSON watcher.
 */
export function spawnGeminiOneShot(options: OneShotOptions): GeminiSpawnResult {
  // Build isolated instance with MCP, system prompt, and optional reasoning config
  const instance = buildGeminiInstance({
    sessionUuid: options.resumeUuid,
    parentSessionUuid: options.parentSessionUuid,
    model: options.model,
    reasoningLevel: options.reasoning,
  });

  const args = [
    '-p', options.message,
    '--resume', options.resumeUuid,
    '--yolo',
  ];

  // Use the model arg from instance builder (may be custom alias for reasoning)
  if (instance.modelArg) {
    args.push('--model', instance.modelArg);
  }

  const env: Record<string, string | undefined> = { ...process.env };
  env.GEMINI_CLI_HOME = instance.geminiHome;
  if (options.preloadSessionId) addPreloadEnv(env, options.preloadSessionId);

  const { envId, term, pid } = spawnProcess({
    command: 'gemini',
    args,
    cwd: options.cwd,
    env,
    logPrefix: 'atoo-any-gemini',
  });

  // Determine the session file path for the JSON watcher.
  // Gemini writes to ~/.gemini/tmp/{projectId}/chats/session-*-{shortId}.json
  // Since we set GEMINI_CLI_HOME, tmp/ is symlinked to real ~/.gemini/tmp/
  // The session file will contain the resumeUuid as sessionId.
  // We need to find it by scanning for the shortId in the filename.
  const shortId = options.resumeUuid.slice(0, 8);
  let sessionFilePath = '';

  // The file was just written by writeForkedGeminiJson, so it should exist
  const geminiTmpBase = path.join(os.homedir(), '.gemini', 'tmp');
  try {
    const projectDirs = fs.readdirSync(geminiTmpBase, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const chatsDir = path.join(geminiTmpBase, dir.name, 'chats');
      if (!fs.existsSync(chatsDir)) continue;
      const files = fs.readdirSync(chatsDir);
      const match = files.find(f => f.includes(shortId) && f.endsWith('.json'));
      if (match) {
        sessionFilePath = path.join(chatsDir, match);
        break;
      }
    }
  } catch {}

  return { envId, term, pid, cleanupInstance: instance.cleanup, sessionFilePath };
}
