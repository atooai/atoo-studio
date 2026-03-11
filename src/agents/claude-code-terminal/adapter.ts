import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type {
  Agent,
  AgentInitOptions,
  AgentSessionInfo,
  AgentStatus,
  AgentCapabilities,
  Attachment,
} from '../types.js';
import type { SessionEvent } from '../../events/types.js';
import type { WireMessage } from '../../events/wire.js';
import { getPty, killCliProcess, registerActivitySession } from '../../spawner.js';
import { spawnTerminalCliProcess } from './spawner.js';
import { generateHookToken, registerHookToken, removeHookToken } from '../lib/claude/hooks.js';

/**
 * Terminal-only Claude Code agent.
 * Spawns a plain `claude` PTY — no MITM proxy, no MCP, no /remote-control,
 * no message parsing, no /context workflow. The user interacts purely via the
 * terminal xterm view.
 */
export class ClaudeCodeTerminalAgent extends EventEmitter implements Agent {
  readonly sessionId: string;
  envId: string | null = null;
  private status: AgentStatus = 'initializing';
  private mode = 'default';
  private cwd: string | null = null;
  private createdAt = Date.now();
  private destroyed = false;
  private hookToken: string | null = null;
  private cliSessionId: string | null = null;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }

  async initialize(options: AgentInitOptions): Promise<void> {
    this.cwd = options.cwd || os.homedir();

    if (options.skipPermissions) {
      this.mode = 'bypassPermissions';
    }

    try {
      this.hookToken = generateHookToken();
      const sessionUuidPromise = registerHookToken(this.hookToken, this.sessionId, this.cwd);

      // Snapshot existing JSONL files before spawn (for fallback detection)
      const projectDirHash = this.cwd.replace(/\//g, '-');
      const projectDir = path.join(os.homedir(), '.claude', 'projects', projectDirHash);
      const preExisting = new Set<string>();
      try {
        if (fs.existsSync(projectDir)) {
          for (const f of fs.readdirSync(projectDir)) {
            if (f.endsWith('.jsonl')) preExisting.add(f);
          }
        }
      } catch {}

      this.envId = spawnTerminalCliProcess({
        skipPermissions: options.skipPermissions,
        cwd: this.cwd,
        resumeSessionUuid: options.resumeSessionUuid,
        hookToken: this.hookToken,
        isChainContinuation: options.isChainContinuation,
      });

      // Register envId → sessionId mapping for activity tracking
      registerActivitySession(this.envId, this.sessionId);

      // Await hook-based session discovery (same pattern as terminal-chatro)
      const HOOK_TIMEOUT = 8000;
      try {
        this.cliSessionId = await Promise.race([
          sessionUuidPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('hook timeout')), HOOK_TIMEOUT)
          ),
        ]);
        console.log(`[claude-terminal] Hook-based session discovery: ${this.cliSessionId}`);
      } catch {
        // Fallback: detect new JSONL file created after spawn
        console.warn(`[claude-terminal] Hook timed out, falling back to filesystem detection`);
        this.cliSessionId = this.detectNewSession(projectDir, preExisting);
        if (this.cliSessionId) {
          console.log(`[claude-terminal] Filesystem-based session discovery: ${this.cliSessionId}`);
        } else {
          console.warn(`[claude-terminal] Could not discover CLI session for agent ${this.sessionId}`);
        }
      }

      this.setStatus('idle');
      this.emit('ready');
    } catch (err: any) {
      this.setStatus('error');
      this.emit('error', err);
      throw err;
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.hookToken) {
      removeHookToken(this.hookToken);
      this.hookToken = null;
    }

    if (this.envId) {
      killCliProcess(this.envId);
    }

    this.setStatus('exited');
    this.emit('exit');
  }

  // Terminal-only: messages are not parsed from the PTY stream.
  sendMessage(_text: string, _attachments?: Attachment[]): void {}
  approve(_requestId: string, _updatedInput?: any): void {}
  deny(_requestId: string): void {}
  answerQuestion(_requestId: string, _answers: Record<string, string>): void {}
  setMode(_mode: string): void {}
  setModel(_model: string): void {}
  refreshContext(): void {}
  markViewed(): void {}

  sendKey(key: string): void {
    if (!this.envId) return;
    const pty = getPty(this.envId);
    if (!pty) return;

    const KEY_MAP: Record<string, string> = {
      escape: '\x1b',
    };
    const sequence = KEY_MAP[key];
    if (sequence) {
      pty.write(sequence);
    }
  }

  getInfo(): AgentSessionInfo {
    return {
      sessionId: this.sessionId,
      agentType: 'claude-code-terminal',
      agentMode: 'terminal',
      status: this.status,
      mode: this.mode,
      cwd: this.cwd || undefined,
      capabilities: this.getCapabilities(),
      createdAt: this.createdAt,
      cliSessionId: this.cliSessionId || undefined,
    };
  }

  forkToResumable(_afterEventUuid: string, _fromEventUuid?: string, _targetDir?: string): string | null {
    return null;
  }

  getMessages(): WireMessage[] {
    return [];
  }

  getEvents(): SessionEvent[] {
    return [];
  }

  getCliSessionId(): string | null {
    return this.cliSessionId;
  }

  getWireMessages(): WireMessage[] {
    return [];
  }

  private getCapabilities(): AgentCapabilities {
    return {
      canChangeMode: false,
      canChangeModel: false,
      hasContextUsage: false,
      canFork: false,
      canResume: true,
      hasTerminal: true,
      hasFileTracking: false,
      availableModes: [],
      availableModels: [],
    };
  }

  /**
   * Detect a new JSONL session file by comparing current directory listing
   * against the pre-spawn snapshot. Returns the UUID or null.
   */
  private detectNewSession(projectDir: string, preExisting: Set<string>): string | null {
    try {
      if (!fs.existsSync(projectDir)) return null;
      const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      const newFiles = files.filter(f => !preExisting.has(f));
      if (newFiles.length === 0) return null;

      // Pick the most recently modified new file
      let best: { name: string; mtime: number } | null = null;
      for (const f of newFiles) {
        try {
          const stat = fs.statSync(path.join(projectDir, f));
          if (!best || stat.mtimeMs > best.mtime) {
            best = { name: f, mtime: stat.mtimeMs };
          }
        } catch {}
      }
      return best ? best.name.replace('.jsonl', '') : null;
    } catch {
      return null;
    }
  }

  private setStatus(status: AgentStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }
}
