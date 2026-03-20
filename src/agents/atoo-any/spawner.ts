/**
 * CLI spawning helpers for atoo-any agent.
 * Spawns Claude and Codex in one-shot non-interactive mode.
 */
import { spawnProcess, type ITerminal } from '../../spawner.js';

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
 */
export function spawnClaudeOneShot(options: OneShotOptions): SpawnResult {
  const args = [
    '-p', options.message,
    '--resume', options.resumeUuid,
    '--dangerously-skip-permissions',
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
 */
export function spawnCodexOneShot(options: OneShotOptions): SpawnResult {
  const args = [
    'exec', 'resume',
    options.resumeUuid,
    options.message,
    '--full-auto',
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
