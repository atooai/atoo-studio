import * as pty from 'node-pty';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PROXY_PORT, CA_CERT_PATH } from './config.js';
import { store } from './state/store.js';

interface SpawnedProcess {
  pty: pty.IPty;
  envId: string;
}

const spawnedProcesses = new Map<string, SpawnedProcess>();

/**
 * Pre-trust a workspace directory in ~/.claude.json so that
 * `claude remote-control` doesn't fail with "Workspace not trusted".
 */
function ensureWorkspaceTrust(directory: string): void {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let config: any = {};
    if (fs.existsSync(claudeJsonPath)) {
      config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    }
    if (!config.projects) {
      config.projects = {};
    }
    const absDir = path.resolve(directory);
    if (!config.projects[absDir]) {
      config.projects[absDir] = {};
    }
    if (!config.projects[absDir].hasTrustDialogAccepted) {
      config.projects[absDir].hasTrustDialogAccepted = true;
      fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
      console.log(`[spawner] Pre-trusted workspace: ${absDir}`);
    }
  } catch (err: any) {
    console.warn(`[spawner] Failed to pre-trust workspace: ${err.message}`);
  }
}

export function spawnCliProcess(options: {
  skipPermissions?: boolean;
  cwd?: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const args: string[] = ['remote-control'];
    if (options.skipPermissions) {
      args.unshift('--dangerously-skip-permissions');
    }

    const cwd = options.cwd || process.env.HOME || os.homedir();

    // Pre-trust the workspace so remote-control doesn't fail
    ensureWorkspaceTrust(cwd);

    // Track existing environments so we can detect the new one
    const existingEnvIds = new Set(store.environments.keys());

    const env = { ...process.env };
    env.HTTPS_PROXY = `http://localhost:${PROXY_PORT}`;
    env.NODE_EXTRA_CA_CERTS = CA_CERT_PATH;
    delete env.CLAUDECODE; // Prevent "nested session" detection

    const term = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env,
    });

    const pid = term.pid;
    console.log(`[spawner] Started claude (pid=${pid}): claude ${args.join(' ')}`);

    let resolved = false;

    term.onData((data: string) => {
      const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\r\n]+/g, ' ').trim();
      if (stripped) console.log(`[spawner:${pid}] ${stripped.substring(0, 200)}`);
    });

    term.onExit(({ exitCode }) => {
      console.log(`[spawner] claude (pid=${pid}) exited with code ${exitCode}`);
      for (const [envId, proc] of Array.from(spawnedProcesses.entries())) {
        if (proc.pty === term) {
          spawnedProcesses.delete(envId);
          break;
        }
      }
    });

    // Poll for new environment registration
    const maxWait = 30000;
    const pollInterval = 500;
    let elapsed = 0;

    const timer = setInterval(() => {
      elapsed += pollInterval;

      for (const id of Array.from(store.environments.keys())) {
        if (!existingEnvIds.has(id)) {
          clearInterval(timer);
          resolved = true;
          spawnedProcesses.set(id, { pty: term, envId: id });
          console.log(`[spawner] CLI registered as environment ${id}`);
          resolve(id);
          return;
        }
      }

      if (elapsed >= maxWait) {
        clearInterval(timer);
        if (!resolved) {
          console.error(`[spawner] Timeout waiting for CLI to register`);
          term.kill();
          reject(new Error('Timeout waiting for CLI to register'));
        }
      }
    }, pollInterval);
  });
}

export function killCliProcess(envId: string): boolean {
  const proc = spawnedProcesses.get(envId);
  if (proc) {
    proc.pty.kill();
    spawnedProcesses.delete(envId);
    console.log(`[spawner] Killed CLI for environment ${envId}`);
    return true;
  }
  return false;
}

export function killAllCliProcesses(): void {
  for (const [id, proc] of Array.from(spawnedProcesses.entries())) {
    console.log(`[spawner] Killing CLI for environment ${id}`);
    proc.pty.kill();
  }
  spawnedProcesses.clear();
}
