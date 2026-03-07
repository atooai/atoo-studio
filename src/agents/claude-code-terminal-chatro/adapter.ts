import { EventEmitter } from 'events';
import os from 'os';
import type {
  Agent,
  AgentInitOptions,
  AgentSessionInfo,
  AgentStatus,
  AgentCapabilities,
  AbstractMessage,
  Attachment,
} from '../types.js';
import { getPty, killCliProcess } from '../../spawner.js';
import { spawnTerminalCliProcess } from '../claude-code-terminal/spawner.js';
import { mapIngressEvent } from '../claude-code/message-mapper.js';
import { JsonlWatcher, type SubagentMetadata } from './jsonl-watcher.js';

/**
 * Terminal + Chat Read-Only agent.
 * Spawns a plain `claude` PTY (like the terminal agent) but also watches
 * the CLI's JSONL session file to stream messages into a read-only Chat UI.
 */
export class ClaudeCodeTerminalChatROAgent extends EventEmitter implements Agent {
  readonly sessionId: string;
  envId: string | null = null;
  private status: AgentStatus = 'initializing';
  private mode = 'default';
  private cwd: string | null = null;
  private createdAt = Date.now();
  private destroyed = false;

  private jsonlWatcher: JsonlWatcher | null = null;
  private messages: AbstractMessage[] = [];
  private pendingToolUses = new Map<string, { name: string; input: any }>();
  private sidechainSessions = new Map<string, string>(); // sessionId → parentToolUseId

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
      // Create watcher and snapshot existing files BEFORE spawning the PTY
      // to avoid a race where the CLI creates its JSONL file before we record
      // what was already there.
      this.jsonlWatcher = new JsonlWatcher({
        cwd: this.cwd,
        resumeUuid: options.resumeSessionUuid,
      });
      this.jsonlWatcher.snapshot();

      this.jsonlWatcher.on('event', (event: any, metadata?: SubagentMetadata) => {
        this.handleJsonlEvent(event, metadata);
      });

      this.jsonlWatcher.on('error', (err: Error) => {
        console.error(`[terminal-chatro] JSONL watcher error:`, err.message);
      });

      // Now spawn the terminal PTY
      this.envId = spawnTerminalCliProcess({
        skipPermissions: options.skipPermissions,
        cwd: this.cwd,
        resumeSessionUuid: options.resumeSessionUuid,
      });

      // Start watching for the new file (async discovery, doesn't block)
      this.jsonlWatcher.start().catch((err: Error) => {
        console.error(`[terminal-chatro] JSONL watcher start error:`, err.message);
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

    if (this.jsonlWatcher) {
      this.jsonlWatcher.stop();
      this.jsonlWatcher = null;
    }

    if (this.envId) {
      killCliProcess(this.envId);
    }

    this.setStatus('exited');
    this.emit('exit');
  }

  // Terminal-only interaction: these are no-ops
  sendMessage(_text: string, _attachments?: Attachment[]): void {}
  approve(_requestId: string, _updatedInput?: any): void {}
  deny(_requestId: string): void {}
  answerQuestion(_requestId: string, _answers: Record<string, string>): void {}
  setMode(_mode: string): void {}
  setModel(_model: string): void {}
  refreshContext(): void {}

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
      agentType: 'claude-code-terminal-chatro',
      agentMode: 'terminal+chatRO',
      status: this.status,
      mode: this.mode,
      cwd: this.cwd || undefined,
      capabilities: this.getCapabilities(),
      createdAt: this.createdAt,
    };
  }

  getMessages(): AbstractMessage[] {
    return this.messages;
  }

  private handleJsonlEvent(event: any, metadata?: SubagentMetadata): void {
    // Skip file-history-snapshot events
    if (event.type === 'file-history-snapshot') return;

    // Skip progress events from the main file when we're tailing the subagent's own file
    // (progress events are condensed duplicates of the full subagent transcript)
    if (!metadata && event.type === 'progress' && event.data?.agentId) {
      if (this.jsonlWatcher && this.jsonlWatcher.tailedAgentIds.has(event.data.agentId)) {
        return;
      }
    }

    // Track sidechain sessions (from main file events)
    if (!metadata && event.isSidechain && event.parentUuid) {
      if (event.sessionId) {
        this.sidechainSessions.set(event.sessionId, event.parentUuid);
      }
    }

    // Determine sidechain parentToolUseId:
    // 1. From subagent metadata (subagent file tailing)
    // 2. From event's own isSidechain + parentUuid fields
    // 3. From tracked sidechain sessions
    const parentToolUseId = metadata
      ? metadata.parentToolUseID
      : (event.isSidechain && event.parentUuid)
        ? event.parentUuid
        : (event.sessionId && this.sidechainSessions.has(event.sessionId))
          ? this.sidechainSessions.get(event.sessionId)
          : undefined;

    const isSidechain = !!metadata || !!parentToolUseId;
    const agentId = metadata?.agentId;

    // Map JSONL event to AbstractMessages using the existing mapper
    const mapped = mapIngressEvent(this.sessionId, event, this.pendingToolUses);

    for (const msg of mapped) {
      // Tag sidechain messages
      if (isSidechain && parentToolUseId) {
        (msg as any)._sidechain = true;
        (msg as any)._parentToolUseId = parentToolUseId;
      }
      if (agentId) {
        (msg as any)._agentId = agentId;
      }

      this.messages.push(msg);
      this.emit('message', msg);
    }
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
