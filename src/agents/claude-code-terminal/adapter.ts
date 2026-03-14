import { EventEmitter } from 'events';
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
import { getProcessPid, getPty, killCliProcess, registerActivitySession } from '../../spawner.js';
import { spawnTerminalCliProcess } from './spawner.js';
import { initFileTracking } from '../lib/fs-tracking.js';

import { precreateClaudeSession } from '../lib/session-precreate.js';

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

    // Determine session UUID: use provided resume UUID, or pre-create a new one
    const resumeUuid = options.resumeSessionUuid || precreateClaudeSession(this.cwd, options.initialMessage);
    this.cliSessionId = resumeUuid;

    try {
      const { envId, preloadSessionId } = spawnTerminalCliProcess({
        skipPermissions: options.skipPermissions,
        cwd: this.cwd,
        resumeSessionUuid: resumeUuid,
        isChainContinuation: options.isChainContinuation,
      });
      this.envId = envId;

      // Register envId → sessionId mapping for activity tracking
      registerActivitySession(this.envId, this.sessionId);

      // Start file change detection (levels 1+2: LD_PRELOAD + inotify)
      const pid = getProcessPid(this.envId);
      if (pid) {
        initFileTracking({
          sessionId: this.cliSessionId!,
          cwd: this.cwd,
          pid,
          preloadSessionId,
        });
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

    if (this.envId) {
      killCliProcess(this.envId);
    }

    this.setStatus('exited');
    this.emit('exit');
  }

  // Terminal-only: type message directly into the PTY
  sendMessage(text: string, _attachments?: Attachment[]): void {
    if (!text || !this.envId) return;
    const pty = getPty(this.envId);
    if (!pty) return;
    // Delay to let the CLI TUI initialize and show its prompt
    setTimeout(() => {
      const p = getPty(this.envId!);
      if (p) p.write(text + '\n');
    }, 2000);
  }
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
      hasFileTracking: true,
      availableModes: [],
      availableModels: [],
    };
  }

  private setStatus(status: AgentStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }
}
