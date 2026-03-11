import { EventEmitter } from 'events';
import fs from 'fs';
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
import { mapCodexJsonlLine } from '../lib/codex/jsonl-mapper.js';
import { codexSessionScanner } from '../lib/codex/fs-sessions.js';
import { forkEventsToResumable } from '../lib/claude/jsonl-writer.js';
import { getPty, killCliProcess, registerActivitySession } from '../../spawner.js';
import { spawnCodexCliProcess } from './spawner.js';
import { CodexJsonlWatcher } from './jsonl-watcher.js';
import { generateNotifyToken, registerNotifyToken, removeNotifyToken } from '../lib/codex/notify.js';

/**
 * Terminal + Chat Read-Only agent for Codex CLI.
 * Spawns a plain `codex` PTY and uses the notify callback to discover
 * the session thread-id, then tails the JSONL file for chat content.
 */
export class CodexTerminalChatROAgent extends EventEmitter implements Agent {
  readonly sessionId: string;
  envId: string | null = null;
  private status: AgentStatus = 'initializing';
  private cwd: string | null = null;
  private createdAt = Date.now();
  private destroyed = false;

  private jsonlWatcher: CodexJsonlWatcher | null = null;
  private wireMessages: WireMessage[] = [];
  private events: SessionEvent[] = [];
  private pendingToolUses = new Map<string, { name: string; input: any }>();
  private cliSessionId: string | null = null;
  private resumeSessionUuid: string | null = null;
  private notifyToken: string | null = null;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }

  async initialize(options: AgentInitOptions): Promise<void> {
    this.cwd = options.cwd || os.homedir();

    try {
      // Generate notify token for this session
      this.notifyToken = generateNotifyToken();
      const threadIdPromise = registerNotifyToken(this.notifyToken, this.sessionId, this.cwd);

      if (options.resumeSessionUuid) {
        this.resumeSessionUuid = options.resumeSessionUuid;
        this.cliSessionId = options.resumeSessionUuid;

        // Read historical events directly from the known file
        this.loadHistoricalFile(options.resumeSessionUuid);

        // Start tailing for new content appended during the resumed session
        this.startTailing(options.resumeSessionUuid);
      }

      // Spawn the terminal PTY
      this.envId = spawnCodexCliProcess({
        skipPermissions: options.skipPermissions,
        cwd: this.cwd,
        resumeSessionUuid: options.resumeSessionUuid,
        notifyToken: this.notifyToken,
        isChainContinuation: options.isChainContinuation,
      });

      // Register envId → sessionId mapping for activity tracking
      registerActivitySession(this.envId, this.sessionId);

      // For new sessions: wait for first notify callback to discover thread-id,
      // then start tailing. For resume: thread-id already known, this is a no-op.
      if (!options.resumeSessionUuid) {
        threadIdPromise.then((threadId) => {
          if (this.destroyed) return;
          this.cliSessionId = threadId;
          console.log(`[codex-terminal-chatro] Got thread-id via notify: ${threadId}`);
          this.startTailing(threadId);
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

    if (this.jsonlWatcher) {
      this.jsonlWatcher.stop();
      this.jsonlWatcher = null;
    }

    if (this.notifyToken) {
      removeNotifyToken(this.notifyToken);
      this.notifyToken = null;
    }

    if (this.envId) {
      killCliProcess(this.envId);
    }

    this.setStatus('exited');
    this.emit('exit');
  }

  /**
   * Called when the user views this session tab — clears attention.
   */
  markViewed(): void {
    if (this.status === 'waiting') {
      this.setStatus('idle');
    }
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
      agentType: 'codex-terminal-chatro',
      agentMode: 'terminal+chatRO',
      status: this.status,
      mode: 'default',
      cwd: this.cwd || undefined,
      capabilities: this.getCapabilities(),
      createdAt: this.createdAt,
    };
  }

  forkToResumable(afterEventUuid: string, fromEventUuid?: string, targetDir?: string): string | null {
    const dir = targetDir || this.cwd || os.homedir();
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

  /**
   * Start tailing the JSONL file for a known session UUID.
   * For resume: tails from the end of historical content (new appended content only).
   * For new sessions: tails from offset 0 (reads everything).
   */
  private startTailing(uuid: string): void {
    if (this.jsonlWatcher) return; // already tailing

    this.jsonlWatcher = new CodexJsonlWatcher();

    this.jsonlWatcher.on('event', (event: SessionEvent) => {
      this.handleEvent(event);
    });

    this.jsonlWatcher.on('error', (err: Error) => {
      console.error(`[codex-terminal-chatro] JSONL watcher error:`, err.message);
    });

    // For resume: skip bytes already loaded by loadHistoricalFile
    const filePath = codexSessionScanner.findSessionFile(uuid);
    if (filePath && this.resumeSessionUuid) {
      try {
        const stat = fs.statSync(filePath);
        this.jsonlWatcher.setInitialOffset(stat.size);
      } catch {}
    }

    this.jsonlWatcher.startTailingUuid(uuid);
  }

  /**
   * Read the known session file by UUID and populate events/wireMessages.
   * Synchronous — no watcher, no discovery, just a direct file read.
   */
  private loadHistoricalFile(uuid: string): void {
    const filePath = codexSessionScanner.findSessionFile(uuid);
    if (!filePath) {
      console.warn(`[codex-terminal-chatro] Session file not found for ${uuid}`);
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const events = mapCodexJsonlLine(parsed);
          for (const event of events) {
            this.events.push(event);
            const wireMsgs = toWireMessages(this.sessionId, event, this.pendingToolUses);
            for (const msg of wireMsgs) {
              this.wireMessages.push(msg);
            }
          }
        } catch { /* skip unparseable lines */ }
      }
      console.log(`[codex-terminal-chatro] Loaded ${this.wireMessages.length} historical messages from ${uuid}`);
    } catch (err: any) {
      console.warn(`[codex-terminal-chatro] Failed to read session file for ${uuid}:`, err.message);
    }
  }

  private handleEvent(event: SessionEvent): void {
    this.events.push(event);

    const mapped = toWireMessages(this.sessionId, event, this.pendingToolUses);

    for (const msg of mapped) {
      this.wireMessages.push(msg);
      this.emit('message', msg);
    }

    // New content from watcher means codex is working
    if (this.status !== 'active') {
      this.setStatus('active');
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
