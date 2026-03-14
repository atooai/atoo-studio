import * as pty from 'node-pty';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { sshManager } from './services/ssh-manager.js';
import { store } from './state/store.js';
import type { ClientChannel } from 'ssh2';

// ═══════════════════════════════════════════════════════
// Common terminal interface — abstracts local PTY and SSH channel
// ═══════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════
// Spawned process tracking
// ═══════════════════════════════════════════════════════

interface SpawnedProcess {
  pty: ITerminal;
  envId: string;
  pid: number;
  preloadSessionId?: string;
}

const spawnedProcesses = new Map<string, SpawnedProcess>();

const MAX_SPAWNER_SCROLLBACK = 200_000;
const spawnerScrollback = new Map<string, string>();

// ═══════════════════════════════════════════════════════
// Activity tracking — buffer-based status detection
// ═══════════════════════════════════════════════════════

export type ActivityStatus = 'open' | 'active' | 'attention';

interface ActivityState {
  attentionAcknowledged: boolean;
  currentStatus: ActivityStatus;
  // Burst tracking: swallow short PTY activity (e.g. resize re-renders)
  // - Set 'active' instantly for good UX
  // - But only transition to 'attention' if the burst was sustained (>= BURST_PROMOTE_MS)
  // - Short bursts (< BURST_PROMOTE_MS) revert to the pre-burst status instead
  burstStartTime: number | null;   // when the current burst began
  burstPromoted: boolean;          // true once burst exceeded BURST_PROMOTE_MS
  burstIdleTimer: ReturnType<typeof setTimeout> | null;  // fires after BURST_IDLE_MS of silence
  preBurstStatus: ActivityStatus;  // status to revert to if burst is short
}

const activityStates = new Map<string, ActivityState>();

const BURST_IDLE_MS = 1000;      // 1s of PTY silence = burst ended
const BURST_PROMOTE_MS = 3000;   // 3s of sustained output = real work (not a re-render)

// Explicit envId → sessionId mapping for agent-registry sessions
// (store.sessions may use different IDs than the agent registry)
const envToSessionIds = new Map<string, Set<string>>();

/**
 * Register an agent session ID for an envId so activity status
 * changes are broadcast under the correct session ID.
 */
export function registerActivitySession(envId: string, sessionId: string): void {
  if (!envToSessionIds.has(envId)) {
    envToSessionIds.set(envId, new Set());
  }
  envToSessionIds.get(envId)!.add(sessionId);
}

export function unregisterActivitySession(envId: string, sessionId: string): void {
  const set = envToSessionIds.get(envId);
  if (set) {
    set.delete(sessionId);
    if (set.size === 0) envToSessionIds.delete(envId);
  }
}

function broadcastActivityStatus(envId: string, status: ActivityStatus): void {
  const broadcasted = new Set<string>();

  // First: explicit registrations (agent-registry sessions)
  const registered = envToSessionIds.get(envId);
  if (registered) {
    for (const sessionId of registered) {
      store.setAgentStatus(sessionId, status);
      broadcasted.add(sessionId);
    }
  }

  // Fallback: store.sessions (ingress-based sessions)
  for (const [sessionId, session] of store.sessions.entries()) {
    if (session.environmentId === envId && !broadcasted.has(sessionId)) {
      store.setAgentStatus(sessionId, status);
    }
  }
}

function setStatus(envId: string, state: ActivityState, status: ActivityStatus): void {
  if (status !== state.currentStatus) {
    state.currentStatus = status;
    broadcastActivityStatus(envId, status);
  }
}

/**
 * Called when PTY produces visible output.
 *
 * Burst filter algorithm:
 * 1. Set 'active' instantly (good UX — user sees agent is working)
 * 2. Start/extend a burst window; reset the 1s idle timer on each data chunk
 * 3. If output sustains for >= 3s, "promote" the burst — it's real work
 * 4. When PTY goes idle for 1s (burst ends):
 *    - If promoted AND not acknowledged: → 'attention' (real work, user hasn't seen)
 *    - If promoted AND acknowledged: → 'open' (user already viewed)
 *    - If NOT promoted: revert to pre-burst status, or 'open' if user acknowledged
 *
 * NOTE: attentionAcknowledged is NOT reset here. User keystrokes echo through
 * the PTY and would constantly fight the frontend's session_viewed command.
 * It's only reset when a promoted burst ends and generates real 'attention'.
 */
function markActivityData(envId: string): void {
  let state = activityStates.get(envId);
  if (!state) {
    state = {
      attentionAcknowledged: false,
      currentStatus: 'open',
      burstStartTime: null,
      burstPromoted: false,
      burstIdleTimer: null,
      preBurstStatus: 'open',
    };
    activityStates.set(envId, state);
  }

  const now = Date.now();

  // New burst: record pre-burst status and start time
  if (state.burstStartTime === null) {
    state.preBurstStatus = state.currentStatus;
    state.burstStartTime = now;
    state.burstPromoted = false;
  }

  // Check if burst should be promoted (sustained output >= BURST_PROMOTE_MS)
  if (!state.burstPromoted && (now - state.burstStartTime) >= BURST_PROMOTE_MS) {
    state.burstPromoted = true;
  }

  // Set active instantly (don't touch attentionAcknowledged — see NOTE above)
  setStatus(envId, state, 'active');

  // Reset the idle timer — burst continues as long as data keeps flowing
  if (state.burstIdleTimer) clearTimeout(state.burstIdleTimer);
  state.burstIdleTimer = setTimeout(() => onBurstIdle(envId), BURST_IDLE_MS);
}

/**
 * Called when PTY has been silent for BURST_IDLE_MS — the burst is over.
 */
function onBurstIdle(envId: string): void {
  const state = activityStates.get(envId);
  if (!state) return;

  const wasPromoted = state.burstPromoted;

  // Clear burst tracking
  state.burstStartTime = null;
  state.burstPromoted = false;
  state.burstIdleTimer = null;

  if (wasPromoted) {
    if (state.attentionAcknowledged) {
      // User already viewed during this burst — go to 'open'
      setStatus(envId, state, 'open');
    } else {
      // Real work finished, user hasn't seen it — 'attention'
      setStatus(envId, state, 'attention');
    }
  } else {
    // Short burst (re-render, keystroke echo) — revert, but respect acknowledgement
    if (state.attentionAcknowledged) {
      setStatus(envId, state, 'open');
    } else {
      setStatus(envId, state, state.preBurstStatus);
    }
  }
}

export function markActivityViewed(envId: string): void {
  const state = activityStates.get(envId);
  if (!state) return;
  state.attentionAcknowledged = true;
  // Always clear to 'open' immediately — the user has seen it.
  // If there's an active burst, the acknowledgement flag ensures
  // onBurstIdle won't re-trigger 'attention'.
  if (state.currentStatus === 'attention') {
    setStatus(envId, state, 'open');
  }
}

function removeActivityState(envId: string): void {
  const state = activityStates.get(envId);
  if (state?.burstIdleTimer) clearTimeout(state.burstIdleTimer);
  activityStates.delete(envId);
  envToSessionIds.delete(envId);
}

// ═══════════════════════════════════════════════════════
// Generic PTY spawn
// ═══════════════════════════════════════════════════════

export interface SpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  envId?: string;         // Caller can provide; otherwise auto-generated
  preloadSessionId?: string;
  logPrefix?: string;     // For log lines, e.g. "claude" or "gemini"
}

/**
 * Generic PTY spawn. Returns an envId immediately.
 * Scrollback and process tracking are managed automatically.
 */
export function spawnProcess(options: SpawnOptions): { envId: string; term: ITerminal; pid: number } {
  const cwd = options.cwd || process.env.HOME || os.homedir();
  const envId = options.envId || `proc_${uuidv4()}`;
  const logPrefix = options.logPrefix || options.command;

  const term = pty.spawn(options.command, options.args || [], {
    name: 'xterm-256color',
    cols: options.cols || 120,
    rows: options.rows || 30,
    cwd,
    env: (options.env || { ...process.env }) as Record<string, string>,
  });

  const pid = term.pid;
  console.log(`[spawner] Started ${logPrefix} (pid=${pid}, envId=${envId}): ${options.command} ${(options.args || []).join(' ')}`);

  spawnedProcesses.set(envId, { pty: term, envId, pid, preloadSessionId: options.preloadSessionId });
  spawnerScrollback.set(envId, '');

  term.onData((data: string) => {
    let buf = spawnerScrollback.get(envId) || '';
    buf += data;
    if (buf.length > MAX_SPAWNER_SCROLLBACK) buf = buf.slice(-MAX_SPAWNER_SCROLLBACK);
    spawnerScrollback.set(envId, buf);
    // Only count as activity if there's visible content (not just cursor blink / ANSI codes)
    const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\r\n]+/g, ' ').trim();
    if (stripped) {
      markActivityData(envId);
      console.log(`[spawner:${pid}] ${stripped.substring(0, 200)}`);
    }
  });

  term.onExit(({ exitCode }) => {
    console.log(`[spawner] ${logPrefix} (pid=${pid}) exited with code ${exitCode}`);
    spawnedProcesses.delete(envId);
    spawnerScrollback.delete(envId);
    removeActivityState(envId);
  });

  return { envId, term, pid };
}

/**
 * Spawn a remote process via SSH. Returns the same tracked structure.
 */
export async function spawnRemoteProcess(options: {
  sshConnectionId: string;
  command: string;
  cwd: string;
  cols?: number;
  rows?: number;
  envId?: string;
  logPrefix?: string;
}): Promise<{ envId: string; term: ITerminal }> {
  const envId = options.envId || `remote_${uuidv4()}`;
  const logPrefix = options.logPrefix || 'remote';

  if (!sshManager.isConnected(options.sshConnectionId)) {
    throw new Error('SSH connection not active');
  }

  const channel = await sshManager.execPty(options.sshConnectionId, options.command, {
    cwd: options.cwd,
    rows: options.rows || 30,
    cols: options.cols || 120,
  });

  const term = new SshTerminalAdapter(channel);
  console.log(`[spawner] Started ${logPrefix} via SSH (envId=${envId}): ${options.command}`);

  spawnedProcesses.set(envId, { pty: term, envId, pid: 0 });
  spawnerScrollback.set(envId, '');

  term.onData((data: string) => {
    let buf = spawnerScrollback.get(envId) || '';
    buf += data;
    if (buf.length > MAX_SPAWNER_SCROLLBACK) buf = buf.slice(-MAX_SPAWNER_SCROLLBACK);
    spawnerScrollback.set(envId, buf);
    const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\r\n]+/g, ' ').trim();
    if (stripped) {
      markActivityData(envId);
      console.log(`[spawner:ssh] ${stripped.substring(0, 200)}`);
    }
  });

  term.onExit(({ exitCode }) => {
    console.log(`[spawner] ${logPrefix} via SSH exited with code ${exitCode}`);
    spawnedProcesses.delete(envId);
    spawnerScrollback.delete(envId);
    removeActivityState(envId);
  });

  return { envId, term };
}

// ═══════════════════════════════════════════════════════
// Process registry queries
// ═══════════════════════════════════════════════════════

export function getScrollback(envId: string): string {
  return spawnerScrollback.get(envId) || '';
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
    spawnerScrollback.delete(envId);
    removeActivityState(envId);
    console.log(`[spawner] Killed process for ${envId}`);
    return true;
  }
  return false;
}

export function killAllCliProcesses(): void {
  for (const [id, proc] of Array.from(spawnedProcesses.entries())) {
    console.log(`[spawner] Killing process for ${id}`);
    proc.pty.kill();
  }
  spawnedProcesses.clear();
  spawnerScrollback.clear();
  activityStates.clear();
  envToSessionIds.clear();
}

export function getPty(envId: string): ITerminal | undefined {
  return spawnedProcesses.get(envId)?.pty;
}

/**
 * Re-register a process under a different envId (e.g. when the CLI
 * registers with the MITM proxy and we learn the real environment ID).
 */
export function reassignEnvId(oldEnvId: string, newEnvId: string): void {
  const proc = spawnedProcesses.get(oldEnvId);
  if (!proc) return;
  const scrollback = spawnerScrollback.get(oldEnvId) || '';
  const activity = activityStates.get(oldEnvId);
  const sessionIds = envToSessionIds.get(oldEnvId);

  spawnedProcesses.delete(oldEnvId);
  spawnerScrollback.delete(oldEnvId);
  activityStates.delete(oldEnvId);
  envToSessionIds.delete(oldEnvId);

  proc.envId = newEnvId;
  spawnedProcesses.set(newEnvId, proc);
  spawnerScrollback.set(newEnvId, scrollback);
  if (activity) activityStates.set(newEnvId, activity);
  if (sessionIds) envToSessionIds.set(newEnvId, sessionIds);
}

export function getEnvIdForSession(sessionId: string): string | undefined {
  const session = store.sessions.get(sessionId);
  if (!session) return undefined;
  if (spawnedProcesses.has(session.environmentId)) {
    return session.environmentId;
  }
  return undefined;
}
