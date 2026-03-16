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
import { getProcessPid, getPty, killCliProcess } from '../../spawner.js';
import { spawnTerminalCliProcess } from './spawner.js';
import { JsonlWatcher, type SubagentMetadata } from './jsonl-watcher.js';
import { fsSessionScanner } from '../lib/claude/fs-sessions.js';
import { initFileTracking, ToolResultFileTracker } from '../lib/fs-tracking.js';
import { PtyActivityTracker } from '../lib/pty-activity-tracker.js';

import { precreateClaudeSession } from '../lib/session-precreate.js';

/**
 * Terminal + Chat Read-Only agent.
 * Spawns a plain `claude` PTY (like the terminal agent) but also watches
 * the CLI's JSONL session file to stream messages into a read-only Chat UI.
 */
export class ClaudeCodeTerminalChatROAgent extends EventEmitter implements Agent {
  readonly sessionId: string;
  envId: string | null = null;
  private status: AgentStatus = 'open';
  private mode = 'default';
  private activityTracker: PtyActivityTracker | null = null;
  private cwd: string | null = null;
  private createdAt = Date.now();
  private destroyed = false;

  private jsonlWatcher: JsonlWatcher | null = null;
  private toolTracker: ToolResultFileTracker | null = null;
  private wireMessages: WireMessage[] = [];
  private events: SessionEvent[] = []; // canonical event store
  private pendingToolUses = new Map<string, { name: string; input: any }>();
  private sidechainSessions = new Map<string, string>(); // sessionId → parentToolUseId
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

    // Determine session UUID: use provided resume UUID, or pre-create a new one
    const resumeUuid = options.resumeSessionUuid || precreateClaudeSession(this.cwd, options.initialMessage);
    this.cliSessionId = resumeUuid;

    try {
      // Pre-load historical messages for resume (before spawning CLI)
      if (options.resumeSessionUuid) {
        this.resumeSessionUuid = options.resumeSessionUuid;
        await this.loadHistoricalMessages(options.resumeSessionUuid);
      }

      // Create JSONL watcher and start tailing the known file immediately
      this.jsonlWatcher = new JsonlWatcher({
        cwd: this.cwd,
        resumeUuid: resumeUuid,
      });

      this.jsonlWatcher.on('event', (event: any, metadata?: SubagentMetadata) => {
        this.handleJsonlEvent(event, metadata);
      });

      this.jsonlWatcher.on('error', (err: Error) => {
        console.error(`[terminal-chatro] JSONL watcher error:`, err.message);
      });

      // Spawn the terminal PTY — always with --resume since we pre-created the file
      const { envId, preloadSessionId } = spawnTerminalCliProcess({
        skipPermissions: options.skipPermissions,
        cwd: this.cwd,
        resumeSessionUuid: resumeUuid,
        isChainContinuation: options.isChainContinuation,
      });
      this.envId = envId;

      // Set up PTY activity tracking (burst detection → status events)
      this.activityTracker = new PtyActivityTracker((status) => {
        this.setStatus(status);
      });
      const pty = getPty(this.envId);
      if (pty) {
        pty.onData((data: string) => this.activityTracker?.onPtyData(data));
      }

      // Start file change detection (all 3 levels)
      const pid = getProcessPid(this.envId);
      if (pid) {
        initFileTracking({
          sessionId: this.cliSessionId!,
          cwd: this.cwd,
          pid,
          preloadSessionId,
        });
      }
      this.toolTracker = new ToolResultFileTracker(this.cliSessionId!);

      // Start tailing the known JSONL file — UUID is known, no discovery needed
      this.jsonlWatcher.startTailingKnownUuid(resumeUuid);

      this.emit('ready');
    } catch (err: any) {
      this.emit('error', err);
      throw err;
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.activityTracker) {
      this.activityTracker.dispose();
      this.activityTracker = null;
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

  // Terminal-only: type message directly into the PTY
  sendMessage(text: string, _attachments?: Attachment[]): void {
    if (!text || !this.envId) return;
    const pty = getPty(this.envId);
    if (!pty) return;
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

  onFocused(): void { this.activityTracker?.onFocused(); }
  onBlurred(): void { this.activityTracker?.onBlurred(); }

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
      cliSessionId: this.cliSessionId || undefined,
    };
  }

  forkToResumable(afterEventUuid: string, fromEventUuid?: string, targetDir?: string): string | null {
    const dir = targetDir || this.cwd || os.homedir();
    // Prefer the original resume UUID for parent linking — the CLI creates a new
    // session UUID on --resume, but forks should link to the session the user sees.
    const parentId = this.resumeSessionUuid || this.cliSessionId || this.sessionId;
    return forkEventsToResumable(this.events, afterEventUuid, dir, parentId, fromEventUuid);
  }

  getCliSessionId(): string | null {
    return this.cliSessionId;
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

    // Level 3: detect file-modifying tool results
    this.toolTracker?.processEvent(event as SessionEvent);

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
