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
import { getPty, killCliProcess } from '../../spawner.js';
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
      registerHookToken(this.hookToken, this.sessionId, this.cwd).then(uuid => {
        this.cliSessionId = uuid;
      });

      this.envId = spawnTerminalCliProcess({
        skipPermissions: options.skipPermissions,
        cwd: this.cwd,
        resumeSessionUuid: options.resumeSessionUuid,
        hookToken: this.hookToken,
        isChainContinuation: options.isChainContinuation,
      });

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

  private setStatus(status: AgentStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }
}
