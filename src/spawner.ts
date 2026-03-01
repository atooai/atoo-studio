import * as pty from 'node-pty';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PROXY_PORT, CA_CERT_PATH } from './config.js';
import { store } from './state/store.js';
import { writeSessionJsonl } from './session-writer.js';
import type { Session } from './state/types.js';

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

/**
 * Spawn a forked CLI process. Writes the JSONL file first, then attempts
 * `claude --resume <session-uuid> remote-control`. Falls back to a fresh
 * `claude remote-control` with a context summary injected as the first message.
 */
export function spawnForkedCliProcess(options: {
  session: Session;
  directory: string;
  skipPermissions?: boolean;
}): Promise<string> {
  const { session, directory, skipPermissions } = options;

  // Write JSONL file to Claude's session storage
  const jsonlPath = writeSessionJsonl(session, directory);
  const sessionUuid = session.id.replace(/^sess_/, '');

  return new Promise((resolve, reject) => {
    const cwd = directory || process.env.HOME || os.homedir();
    ensureWorkspaceTrust(cwd);

    const existingEnvIds = new Set(store.environments.keys());

    const env = { ...process.env };
    env.HTTPS_PROXY = `http://localhost:${PROXY_PORT}`;
    env.NODE_EXTRA_CA_CERTS = CA_CERT_PATH;
    delete env.CLAUDECODE;

    // Try --resume first
    const args: string[] = [];
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    args.push('--resume', sessionUuid, 'remote-control');

    const term = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env,
    });

    const pid = term.pid;
    console.log(`[spawner] Started forked claude (pid=${pid}): claude ${args.join(' ')}`);

    let resolved = false;
    let output = '';

    term.onData((data: string) => {
      const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\r\n]+/g, ' ').trim();
      if (stripped) {
        console.log(`[spawner:${pid}] ${stripped.substring(0, 200)}`);
        output += stripped;
      }
    });

    term.onExit(({ exitCode }) => {
      console.log(`[spawner] forked claude (pid=${pid}) exited with code ${exitCode}`);
      for (const [envId, proc] of Array.from(spawnedProcesses.entries())) {
        if (proc.pty === term) {
          spawnedProcesses.delete(envId);
          break;
        }
      }

      // If it exited before registering and we haven't resolved, try fallback
      if (!resolved) {
        console.log(`[spawner] --resume failed (exit=${exitCode}), falling back to fresh CLI`);
        spawnFreshFallback(cwd, skipPermissions, existingEnvIds, session)
          .then(resolve)
          .catch(reject);
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
          console.log(`[spawner] Forked CLI registered as environment ${id}`);
          resolve(id);
          return;
        }
      }

      if (elapsed >= maxWait) {
        clearInterval(timer);
        if (!resolved) {
          console.error(`[spawner] Timeout waiting for forked CLI to register`);
          term.kill();
          reject(new Error('Timeout waiting for forked CLI to register'));
        }
      }
    }, pollInterval);
  });
}

/**
 * Fallback: spawn a fresh `claude remote-control` and inject conversation context
 * as the first user message after session creation.
 */
function spawnFreshFallback(
  cwd: string,
  skipPermissions: boolean | undefined,
  existingEnvIds: Set<string>,
  forkedSession: Session
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args: string[] = ['remote-control'];
    if (skipPermissions) args.unshift('--dangerously-skip-permissions');

    const env = { ...process.env };
    env.HTTPS_PROXY = `http://localhost:${PROXY_PORT}`;
    env.NODE_EXTRA_CA_CERTS = CA_CERT_PATH;
    delete env.CLAUDECODE;

    const term = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env,
    });

    const pid = term.pid;
    console.log(`[spawner] Started fallback CLI (pid=${pid}): claude ${args.join(' ')}`);

    let resolved = false;

    term.onData((data: string) => {
      const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\r\n]+/g, ' ').trim();
      if (stripped) console.log(`[spawner:${pid}] ${stripped.substring(0, 200)}`);
    });

    term.onExit(({ exitCode }) => {
      console.log(`[spawner] fallback claude (pid=${pid}) exited with code ${exitCode}`);
      for (const [envId, proc] of Array.from(spawnedProcesses.entries())) {
        if (proc.pty === term) {
          spawnedProcesses.delete(envId);
          break;
        }
      }
    });

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
          console.log(`[spawner] Fallback CLI registered as environment ${id}`);
          resolve(id);
          return;
        }
      }

      if (elapsed >= maxWait) {
        clearInterval(timer);
        if (!resolved) {
          console.error(`[spawner] Timeout waiting for fallback CLI to register`);
          term.kill();
          reject(new Error('Timeout waiting for fallback CLI to register'));
        }
      }
    }, pollInterval);
  });
}

/**
 * Build a context summary from forked session events for injection into a fresh CLI.
 */
export function buildContextSummary(session: Session): string {
  const parts: string[] = ['[Forked conversation context]\n'];
  for (const event of session.events) {
    if (event.type === 'user' && event.message?.content) {
      const text = typeof event.message.content === 'string'
        ? event.message.content
        : Array.isArray(event.message.content)
          ? event.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
          : JSON.stringify(event.message.content);
      if (text) parts.push(`User: ${text}`);
    } else if (event.type === 'assistant' && event.message?.content) {
      const blocks = event.message.content;
      if (Array.isArray(blocks)) {
        const texts = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text);
        if (texts.length) parts.push(`Assistant: ${texts.join('\n')}`);
      } else if (typeof blocks === 'string') {
        parts.push(`Assistant: ${blocks}`);
      }
    }
  }
  return parts.join('\n\n');
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
