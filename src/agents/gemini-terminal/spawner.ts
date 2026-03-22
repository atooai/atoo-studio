/**
 * Gemini CLI Terminal–specific spawn logic.
 * Spawns `gemini` PTY with per-instance isolation (GEMINI_CLI_HOME),
 * MCP config, system prompt, and LD_PRELOAD for file tracking.
 */
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { spawnProcess } from '../../spawner.js';
import { buildGeminiInstance } from '../lib/gemini/settings-builder.js';
import { addPreloadEnv } from '../lib/fs-tracking.js';

export function spawnGeminiCliProcess(options: {
  skipPermissions?: boolean;
  cwd?: string;
  resumeSessionUuid?: string;
  isChainContinuation?: boolean;
}): { envId: string; preloadSessionId: string; cleanupInstance: () => void } {
  const cwd = options.cwd || process.env.HOME || os.homedir();

  // Build isolated Gemini instance with MCP + system prompt
  const instance = buildGeminiInstance({
    sessionUuid: options.resumeSessionUuid || uuidv4(),
    isChainContinuation: options.isChainContinuation,
  });

  const args: string[] = [];
  if (options.skipPermissions) args.push('--yolo');
  if (options.resumeSessionUuid) args.push('--resume', options.resumeSessionUuid);

  const preloadSessionId = uuidv4();
  const env: Record<string, string | undefined> = { ...process.env };
  env.GEMINI_CLI_HOME = instance.geminiHome;
  addPreloadEnv(env, preloadSessionId);

  const { envId } = spawnProcess({
    command: 'gemini',
    args,
    cwd,
    env,
    preloadSessionId,
    logPrefix: 'gemini-terminal',
  });

  return { envId, preloadSessionId, cleanupInstance: instance.cleanup };
}
