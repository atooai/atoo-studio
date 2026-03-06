import * as pty from 'node-pty';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { PROXY_PORT, CA_CERT_PATH } from './config.js';
import { store } from './state/store.js';
import { writeSessionJsonl } from './session-writer.js';
import { sshManager } from './services/ssh-manager.js';
import { getMcpConfigPath, MCP_SYSTEM_PROMPT } from './mcp/config.js';
import type { Session } from './state/types.js';
import type { ClientChannel } from 'ssh2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PRELOAD_SO_PATH = path.join(__dirname, '..', 'preload', 'ccproxy-preload.so');
const PRELOAD_SOCKET_PATH = path.join(os.homedir(), '.ccproxy', 'preload.sock');

// Common terminal interface — abstracts local PTY and SSH channel
export interface ITerminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(handler: (data: string) => void): { dispose(): void };
  onExit(handler: (exit: { exitCode: number }) => void): { dispose(): void };
  pid?: number;
}

class SshTerminalAdapter implements ITerminal {
  pid = undefined;
  constructor(private channel: ClientChannel) {}
  write(data: string) { this.channel.write(data); }
  resize(cols: number, rows: number) { this.channel.setWindow(rows, cols, rows * 16, cols * 8); }
  kill() { this.channel.close(); }
  onData(handler: (data: string) => void) {
    const cb = (data: Buffer) => handler(data.toString());
    this.channel.on('data', cb);
    return { dispose: () => { this.channel.off('data', cb); } };
  }
  onExit(handler: (exit: { exitCode: number }) => void) {
    const cb = (code: number | null) => handler({ exitCode: code ?? 1 });
    this.channel.on('exit', cb);
    return { dispose: () => {} };
  }
}

interface SpawnedProcess {
  pty: ITerminal;
  envId: string;
  pid: number;
  preloadSessionId?: string;
}

const spawnedProcesses = new Map<string, SpawnedProcess>();

// Per-envId scrollback buffer — captures PTY output from spawn so browsers
// connecting later (or after reload) can see prior output.
const MAX_SPAWNER_SCROLLBACK = 200_000;
const spawnerScrollback = new Map<string, string>();

export function getScrollback(envId: string): string {
  return spawnerScrollback.get(envId) || '';
}

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
    // Pass /remote-control as a prompt arg — Claude interprets it as a slash command
    const args: string[] = [];
    if (options.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }
    args.push('--append-system-prompt', MCP_SYSTEM_PROMPT, '--mcp-config', getMcpConfigPath(), '--', '/remote-control');

    const cwd = options.cwd || process.env.HOME || os.homedir();

    // Pre-trust the workspace so remote-control doesn't fail
    ensureWorkspaceTrust(cwd);

    // Track existing environments so we can detect the new one
    const existingEnvIds = new Set(store.environments.keys());

    // Generate a tracking UUID for preload session mapping
    const preloadSessionId = uuidv4();

    const env = { ...process.env };
    env.HTTPS_PROXY = `http://localhost:${PROXY_PORT}`;
    env.NODE_EXTRA_CA_CERTS = CA_CERT_PATH;
    delete env.CLAUDECODE; // Prevent "nested session" detection

    // LD_PRELOAD filesystem monitoring
    if (fs.existsSync(PRELOAD_SO_PATH)) {
      env.LD_PRELOAD = PRELOAD_SO_PATH;
      env.CCPROXY_SESSION_ID = preloadSessionId;
      env.CCPROXY_SOCKET_PATH = PRELOAD_SOCKET_PATH;
      env.UV_USE_IO_URING = '0'; // Force libc open() so LD_PRELOAD can intercept
    }

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
    let resolvedEnvId: string | null = null;
    let earlyBuffer = '';

    term.onData((data: string) => {
      // Accumulate scrollback for browser terminal replay
      if (resolvedEnvId) {
        let buf = spawnerScrollback.get(resolvedEnvId) || '';
        buf += data;
        if (buf.length > MAX_SPAWNER_SCROLLBACK) buf = buf.slice(-MAX_SPAWNER_SCROLLBACK);
        spawnerScrollback.set(resolvedEnvId, buf);
      } else {
        earlyBuffer += data;
        if (earlyBuffer.length > MAX_SPAWNER_SCROLLBACK) earlyBuffer = earlyBuffer.slice(-MAX_SPAWNER_SCROLLBACK);
      }
      const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\r\n]+/g, ' ').trim();
      if (stripped) console.log(`[spawner:${pid}] ${stripped.substring(0, 200)}`);
    });

    term.onExit(({ exitCode }) => {
      console.log(`[spawner] claude (pid=${pid}) exited with code ${exitCode}`);
      for (const [envId, proc] of Array.from(spawnedProcesses.entries())) {
        if (proc.pty === term) {
          spawnedProcesses.delete(envId);
          spawnerScrollback.delete(envId);
          break;
        }
      }
    });

    // Poll for new environment registration
    const maxWait = 60000;
    const pollInterval = 500;
    let elapsed = 0;

    const timer = setInterval(() => {
      elapsed += pollInterval;

      for (const id of Array.from(store.environments.keys())) {
        if (!existingEnvIds.has(id)) {
          clearInterval(timer);
          resolved = true;
          resolvedEnvId = id;
          // Flush early buffer into scrollback map
          spawnerScrollback.set(id, earlyBuffer);
          earlyBuffer = '';
          spawnedProcesses.set(id, { pty: term, envId: id, pid, preloadSessionId });
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

    // Generate a tracking UUID for preload session mapping
    const preloadSessionId = uuidv4();

    const env = { ...process.env };
    env.HTTPS_PROXY = `http://localhost:${PROXY_PORT}`;
    env.NODE_EXTRA_CA_CERTS = CA_CERT_PATH;
    delete env.CLAUDECODE;

    // LD_PRELOAD filesystem monitoring
    if (fs.existsSync(PRELOAD_SO_PATH)) {
      env.LD_PRELOAD = PRELOAD_SO_PATH;
      env.CCPROXY_SESSION_ID = preloadSessionId;
      env.CCPROXY_SOCKET_PATH = PRELOAD_SOCKET_PATH;
      env.UV_USE_IO_URING = '0'; // Force libc open() so LD_PRELOAD can intercept
    }

    // Try --resume first, pass /remote-control as prompt arg
    const args: string[] = [];
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    args.push('--append-system-prompt', MCP_SYSTEM_PROMPT, '--mcp-config', getMcpConfigPath(), '--resume', sessionUuid, '--', '/remote-control');

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
    let resolvedEnvId: string | null = null;
    let earlyBuffer = '';
    let output = '';

    term.onData((data: string) => {
      // Accumulate scrollback for browser terminal replay
      if (resolvedEnvId) {
        let buf = spawnerScrollback.get(resolvedEnvId) || '';
        buf += data;
        if (buf.length > MAX_SPAWNER_SCROLLBACK) buf = buf.slice(-MAX_SPAWNER_SCROLLBACK);
        spawnerScrollback.set(resolvedEnvId, buf);
      } else {
        earlyBuffer += data;
        if (earlyBuffer.length > MAX_SPAWNER_SCROLLBACK) earlyBuffer = earlyBuffer.slice(-MAX_SPAWNER_SCROLLBACK);
      }
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
          spawnerScrollback.delete(envId);
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
          resolvedEnvId = id;
          spawnerScrollback.set(id, earlyBuffer);
          earlyBuffer = '';
          spawnedProcesses.set(id, { pty: term, envId: id, pid, preloadSessionId });
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
 * Fallback: spawn a fresh `claude` and inject conversation context
 * as the first user message after session creation.
 */
function spawnFreshFallback(
  cwd: string,
  skipPermissions: boolean | undefined,
  existingEnvIds: Set<string>,
  forkedSession: Session
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Pass /remote-control as prompt arg
    const args: string[] = [];
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    args.push('--append-system-prompt', MCP_SYSTEM_PROMPT, '--mcp-config', getMcpConfigPath(), '--', '/remote-control');

    // Generate a tracking UUID for preload session mapping
    const preloadSessionId = uuidv4();

    const env = { ...process.env };
    env.HTTPS_PROXY = `http://localhost:${PROXY_PORT}`;
    env.NODE_EXTRA_CA_CERTS = CA_CERT_PATH;
    delete env.CLAUDECODE;

    // LD_PRELOAD filesystem monitoring
    if (fs.existsSync(PRELOAD_SO_PATH)) {
      env.LD_PRELOAD = PRELOAD_SO_PATH;
      env.CCPROXY_SESSION_ID = preloadSessionId;
      env.CCPROXY_SOCKET_PATH = PRELOAD_SOCKET_PATH;
      env.UV_USE_IO_URING = '0'; // Force libc open() so LD_PRELOAD can intercept
    }

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
    let resolvedEnvId: string | null = null;
    let earlyBuffer = '';

    term.onData((data: string) => {
      if (resolvedEnvId) {
        let buf = spawnerScrollback.get(resolvedEnvId) || '';
        buf += data;
        if (buf.length > MAX_SPAWNER_SCROLLBACK) buf = buf.slice(-MAX_SPAWNER_SCROLLBACK);
        spawnerScrollback.set(resolvedEnvId, buf);
      } else {
        earlyBuffer += data;
        if (earlyBuffer.length > MAX_SPAWNER_SCROLLBACK) earlyBuffer = earlyBuffer.slice(-MAX_SPAWNER_SCROLLBACK);
      }
      const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\r\n]+/g, ' ').trim();
      if (stripped) console.log(`[spawner:${pid}] ${stripped.substring(0, 200)}`);
    });

    term.onExit(({ exitCode }) => {
      console.log(`[spawner] fallback claude (pid=${pid}) exited with code ${exitCode}`);
      for (const [envId, proc] of Array.from(spawnedProcesses.entries())) {
        if (proc.pty === term) {
          spawnedProcesses.delete(envId);
          spawnerScrollback.delete(envId);
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
          resolvedEnvId = id;
          spawnerScrollback.set(id, earlyBuffer);
          earlyBuffer = '';
          spawnedProcesses.set(id, { pty: term, envId: id, pid, preloadSessionId });
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
 * Spawn a CLI process to resume an existing session from its filesystem UUID.
 * The JSONL file already exists on disk — no need to write it.
 */
export function spawnResumeCliProcess(options: {
  uuid: string;          // Session UUID (JSONL filename)
  directory: string;     // cwd for the CLI process
  skipPermissions?: boolean;
}): Promise<string> {
  const { uuid, directory, skipPermissions } = options;

  return new Promise((resolve, reject) => {
    const cwd = directory || process.env.HOME || os.homedir();
    ensureWorkspaceTrust(cwd);

    const existingEnvIds = new Set(store.environments.keys());

    const preloadSessionId = uuidv4();

    const env = { ...process.env };
    env.HTTPS_PROXY = `http://localhost:${PROXY_PORT}`;
    env.NODE_EXTRA_CA_CERTS = CA_CERT_PATH;
    delete env.CLAUDECODE;

    if (fs.existsSync(PRELOAD_SO_PATH)) {
      env.LD_PRELOAD = PRELOAD_SO_PATH;
      env.CCPROXY_SESSION_ID = preloadSessionId;
      env.CCPROXY_SOCKET_PATH = PRELOAD_SOCKET_PATH;
      env.UV_USE_IO_URING = '0';
    }

    // Pass /remote-control as prompt arg after --resume
    const args: string[] = [];
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    args.push('--append-system-prompt', MCP_SYSTEM_PROMPT, '--mcp-config', getMcpConfigPath(), '--resume', uuid, '--', '/remote-control');

    const term = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env,
    });

    const pid = term.pid;
    console.log(`[spawner] Started resume claude (pid=${pid}): claude ${args.join(' ')}`);

    let resolved = false;
    let resolvedEnvId: string | null = null;
    let earlyBuffer = '';

    term.onData((data: string) => {
      if (resolvedEnvId) {
        let buf = spawnerScrollback.get(resolvedEnvId) || '';
        buf += data;
        if (buf.length > MAX_SPAWNER_SCROLLBACK) buf = buf.slice(-MAX_SPAWNER_SCROLLBACK);
        spawnerScrollback.set(resolvedEnvId, buf);
      } else {
        earlyBuffer += data;
        if (earlyBuffer.length > MAX_SPAWNER_SCROLLBACK) earlyBuffer = earlyBuffer.slice(-MAX_SPAWNER_SCROLLBACK);
      }
      const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\r\n]+/g, ' ').trim();
      if (stripped) console.log(`[spawner:${pid}] ${stripped.substring(0, 200)}`);
    });

    term.onExit(({ exitCode }) => {
      console.log(`[spawner] resume claude (pid=${pid}) exited with code ${exitCode}`);
      for (const [envId, proc] of Array.from(spawnedProcesses.entries())) {
        if (proc.pty === term) {
          spawnedProcesses.delete(envId);
          spawnerScrollback.delete(envId);
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
          resolvedEnvId = id;
          spawnerScrollback.set(id, earlyBuffer);
          earlyBuffer = '';
          spawnedProcesses.set(id, { pty: term, envId: id, pid, preloadSessionId });
          console.log(`[spawner] Resume CLI registered as environment ${id}`);
          resolve(id);
          return;
        }
      }

      if (elapsed >= maxWait) {
        clearInterval(timer);
        if (!resolved) {
          console.error(`[spawner] Timeout waiting for resume CLI to register`);
          term.kill();
          reject(new Error('Timeout waiting for resume CLI to register'));
        }
      }
    }, pollInterval);
  });
}

/**
 * Spawn a CLI process on a remote machine via SSH.
 */
export function spawnRemoteCliProcess(options: {
  sshConnectionId: string;
  skipPermissions?: boolean;
  cwd: string;
}): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const { sshConnectionId, skipPermissions, cwd } = options;

    if (!sshManager.isConnected(sshConnectionId)) {
      return reject(new Error('SSH connection not active'));
    }

    const existingEnvIds = new Set(store.environments.keys());

    // Build command for remote execution
    const args: string[] = [];
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    args.push('/remote-control');

    const cmd = `HTTPS_PROXY=http://localhost:${PROXY_PORT} NODE_EXTRA_CA_CERTS=~/.ccproxy/ca.pem claude ${args.join(' ')}`;

    try {
      const channel = await sshManager.execPty(sshConnectionId, cmd, {
        cwd,
        rows: 30,
        cols: 120,
      });

      const term = new SshTerminalAdapter(channel);
      console.log(`[spawner] Started remote claude via SSH: ${cmd}`);

      let resolved = false;
      let resolvedEnvId: string | null = null;
      let earlyBuffer = '';

      term.onData((data: string) => {
        if (resolvedEnvId) {
          let buf = spawnerScrollback.get(resolvedEnvId) || '';
          buf += data;
          if (buf.length > MAX_SPAWNER_SCROLLBACK) buf = buf.slice(-MAX_SPAWNER_SCROLLBACK);
          spawnerScrollback.set(resolvedEnvId, buf);
        } else {
          earlyBuffer += data;
          if (earlyBuffer.length > MAX_SPAWNER_SCROLLBACK) earlyBuffer = earlyBuffer.slice(-MAX_SPAWNER_SCROLLBACK);
        }
        const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\r\n]+/g, ' ').trim();
        if (stripped) console.log(`[spawner:ssh] ${stripped.substring(0, 200)}`);
      });

      term.onExit(({ exitCode }) => {
        console.log(`[spawner] Remote claude exited with code ${exitCode}`);
        for (const [envId, proc] of Array.from(spawnedProcesses.entries())) {
          if (proc.pty === term) {
            spawnedProcesses.delete(envId);
            spawnerScrollback.delete(envId);
            break;
          }
        }
      });

      // Poll for new environment registration
      const maxWait = 60000;
      const pollInterval = 500;
      let elapsed = 0;

      const timer = setInterval(() => {
        elapsed += pollInterval;

        for (const id of Array.from(store.environments.keys())) {
          if (!existingEnvIds.has(id)) {
            clearInterval(timer);
            resolved = true;
            resolvedEnvId = id;
            spawnerScrollback.set(id, earlyBuffer);
            earlyBuffer = '';
            spawnedProcesses.set(id, { pty: term, envId: id, pid: 0 });
            console.log(`[spawner] Remote CLI registered as environment ${id}`);
            resolve(id);
            return;
          }
        }

        if (elapsed >= maxWait) {
          clearInterval(timer);
          if (!resolved) {
            console.error(`[spawner] Timeout waiting for remote CLI to register`);
            term.kill();
            reject(new Error('Timeout waiting for remote CLI to register'));
          }
        }
      }, pollInterval);
    } catch (err: any) {
      reject(err);
    }
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

export function getProcessPid(envId: string): number | undefined {
  return spawnedProcesses.get(envId)?.pid;
}

export function getPreloadSessionId(envId: string): string | undefined {
  return spawnedProcesses.get(envId)?.preloadSessionId;
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

export function getPty(envId: string): ITerminal | undefined {
  return spawnedProcesses.get(envId)?.pty;
}

export function getEnvIdForSession(sessionId: string): string | undefined {
  const session = store.sessions.get(sessionId);
  if (!session) return undefined;
  // Verify the environment still has a spawned process
  if (spawnedProcesses.has(session.environmentId)) {
    return session.environmentId;
  }
  return undefined;
}
