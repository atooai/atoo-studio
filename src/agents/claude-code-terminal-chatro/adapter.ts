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
import { toWireMessages } from '../../events/wire.js';
import { forkEventsToResumable } from '../lib/claude/jsonl-writer.js';
import { getPty, killCliProcess } from '../../spawner.js';
import { spawnTerminalCliProcess } from './spawner.js';
import { JsonlWatcher, type SubagentMetadata } from './jsonl-watcher.js';
import { fsSessionScanner } from '../lib/claude/fs-sessions.js';
import {
  generateHookToken,
  registerHookToken,
  removeHookToken,
} from '../lib/claude/hooks.js';

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
  private wireMessages: WireMessage[] = [];
  private events: SessionEvent[] = []; // canonical event store
  private pendingToolUses = new Map<string, { name: string; input: any }>();
  private sidechainSessions = new Map<string, string>(); // sessionId → parentToolUseId
  private hookToken: string | null = null;
  private cliSessionId: string | null = null; // CLI's own session UUID (JSONL filename)
  private resumeSessionUuid: string | null = null; // Original session UUID for parent linking
  private preloadedUuids = new Set<string>(); // UUIDs from pre-loaded historical events

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
      // Pre-load historical messages for resume (before spawning CLI)
      if (options.resumeSessionUuid) {
        this.resumeSessionUuid = options.resumeSessionUuid;
        await this.loadHistoricalMessages(options.resumeSessionUuid);
      }

      // Create JSONL watcher (don't start yet — hooks may give us the exact file)
      this.jsonlWatcher = new JsonlWatcher({
        cwd: this.cwd,
        resumeUuid: options.resumeSessionUuid,
      });

      this.jsonlWatcher.on('event', (event: any, metadata?: SubagentMetadata) => {
        this.handleJsonlEvent(event, metadata);
      });

      this.jsonlWatcher.on('error', (err: Error) => {
        console.error(`[terminal-chatro] JSONL watcher error:`, err.message);
      });

      // Set up hooks for reliable session discovery and status tracking
      this.hookToken = generateHookToken();
      const sessionUuidPromise = registerHookToken(this.hookToken, this.sessionId, this.cwd);

      // Snapshot existing JSONL files as fallback (before spawn)
      this.jsonlWatcher.snapshot();

      // Spawn the terminal PTY with hook token
      this.envId = spawnTerminalCliProcess({
        skipPermissions: options.skipPermissions,
        cwd: this.cwd,
        resumeSessionUuid: options.resumeSessionUuid,
        hookToken: this.hookToken,
      });

      // Race: hook-based discovery vs timeout fallback
      const HOOK_TIMEOUT = 8000;
      try {
        const cliUuid = await Promise.race([
          sessionUuidPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('hook timeout')), HOOK_TIMEOUT)
          ),
        ]);
        // Hook worked — start tailing the exact file
        console.log(`[terminal-chatro] Hook-based session discovery: ${cliUuid}`);
        this.cliSessionId = cliUuid;
        this.jsonlWatcher.startTailingKnownUuid(cliUuid);
      } catch {
        // Hooks not supported or timed out — fall back to directory watching
        console.warn(`[terminal-chatro] Hook-based discovery failed, falling back to JSONL directory watching`);
        this.jsonlWatcher.start().catch((err: Error) => {
          console.error(`[terminal-chatro] JSONL watcher start error:`, err.message);
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

    if (this.hookToken) {
      removeHookToken(this.hookToken);
      this.hookToken = null;
    }

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
      agentType: 'claude-code-terminal-chatro',
      agentMode: 'terminal+chatRO',
      status: this.status,
      mode: this.mode,
      cwd: this.cwd || undefined,
      capabilities: this.getCapabilities(),
      createdAt: this.createdAt,
    };
  }

  forkToResumable(afterEventUuid: string, fromEventUuid?: string, targetDir?: string): string | null {
    const dir = targetDir || this.cwd || os.homedir();
    // Prefer the original resume UUID for parent linking — the CLI creates a new
    // session UUID on --resume, but forks should link to the session the user sees.
    const parentId = this.resumeSessionUuid || this.cliSessionId || this.sessionId;
    return forkEventsToResumable(this.events, afterEventUuid, dir, parentId, fromEventUuid);
  }

  getMessages(): WireMessage[] {
    return this.wireMessages;
  }

  getEvents(): SessionEvent[] {
    return this.events;
  }

  getWireMessages(): WireMessage[] {
    const wireToolUses = new Map<string, { name: string; input: any }>();
    const result: WireMessage[] = [];
    for (const event of this.events) {
      result.push(...toWireMessages(this.sessionId, event, wireToolUses));
    }
    return result;
  }

  private async loadHistoricalMessages(uuid: string): Promise<void> {
    try {
      if (!fsSessionScanner.getByUuid(uuid)) {
        fsSessionScanner.invalidate();
        await fsSessionScanner.scan();
      }

      const historicalEvents = await fsSessionScanner.readEvents(uuid);
      this.events.push(...(historicalEvents as SessionEvent[]));

      // Track UUIDs so the JSONL watcher skips already-loaded events
      for (const event of historicalEvents) {
        if (event.uuid) this.preloadedUuids.add(event.uuid);
      }

      // Replay events through toWireMessages for correlation
      const historyToolUses = new Map<string, { name: string; input: any }>();
      for (const event of historicalEvents) {
        const wireMsgs = toWireMessages(this.sessionId, event as SessionEvent, historyToolUses);
        for (const msg of wireMsgs) {
          if ((event as any).timestamp) msg.timestamp = (event as any).timestamp;

          if (msg.type === 'tool_result' && !msg.isPending) {
            const pendingIdx = this.wireMessages.findIndex(
              m => m.type === 'tool_result' && (m as any).isPending && (m as any).requestId === msg.requestId
            );
            if (pendingIdx >= 0) {
              this.wireMessages[pendingIdx] = msg;
              continue;
            }
          }

          this.wireMessages.push(msg);
        }
      }

      // Sync pendingToolUses with the history replay state
      for (const [id, info] of historyToolUses) {
        this.pendingToolUses.set(id, info);
      }

      console.log(`[terminal-chatro] Loaded ${this.wireMessages.length} historical messages for resume of ${uuid}`);
    } catch (err: any) {
      console.warn(`[terminal-chatro] Failed to load historical messages for ${uuid}:`, err.message);
    }
  }

  private handleJsonlEvent(event: any, metadata?: SubagentMetadata): void {
    // Skip file-history-snapshot events
    if (event.type === 'file-history-snapshot') return;

    // Skip events already loaded from historical pre-load
    if (event.uuid && this.preloadedUuids.has(event.uuid)) return;

    // Skip progress events from the main file when we're tailing the subagent's own file
    // (progress events are condensed duplicates of the full subagent transcript)
    if (!metadata && event.type === 'progress' && event.data?.agentId) {
      if (this.jsonlWatcher && this.jsonlWatcher.tailedAgentIds.has(event.data.agentId)) {
        return;
      }
    }

    // Store the raw event as a SessionEvent
    this.events.push(event as SessionEvent);

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

    // Map JSONL event to WireMessages
    const mapped = toWireMessages(this.sessionId, event as SessionEvent, this.pendingToolUses);

    for (const msg of mapped) {
      // Tag sidechain messages
      if (isSidechain && parentToolUseId) {
        msg._sidechain = true;
        msg._parentToolUseId = parentToolUseId;
      }
      if (agentId) {
        msg._agentId = agentId;
      }

      this.wireMessages.push(msg);
      this.emit('message', msg);
    }
  }

  private getCapabilities(): AgentCapabilities {
    return {
      canChangeMode: false,
      canChangeModel: false,
      hasContextUsage: false,
      canFork: true,
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
