/**
 * AtooAnyAgent — meta-agent that orchestrates Claude Code and Codex CLI simultaneously.
 * Chat-only mode. Sends user messages to one or both CLIs, merges their streaming
 * responses into a unified session with dispatch-based grouping.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type {
  Agent,
  AgentInitOptions,
  AgentSessionInfo,
  AgentStatus,
  AgentCapabilities,
  Attachment,
} from '../types.js';
import type { SessionEvent, UserEvent } from '../../events/types.js';
import type { WireMessage } from '../../events/wire.js';
import { toWireMessages } from '../../events/wire.js';
import { writeForkedClaudeJsonl } from '../lib/claude/jsonl-writer.js';
import { writeForkedCodexJsonl } from '../lib/codex/jsonl-writer.js';
import { killCliProcess, getPty } from '../../spawner.js';
import { spawnClaudeOneShot, spawnCodexOneShot } from './spawner.js';
import {
  ensureSessionsDir,
  getSessionFilePath,
  appendEvent,
  appendBranchOperation,
  readAllEvents,
  stripMeta,
  type AtooEventMeta,
  type AtooBranchOperation,
} from './session-store.js';

import { mapCodexJsonlLine } from '../lib/codex/jsonl-mapper.js';

const DEBOUNCE_MS = 50;

interface DispatchInfo {
  dispatchId: string;
  agentFamily: 'claude' | 'codex';
  parentUserUuid: string;
  envId: string;
  tempSessionUuid: string;
  tempSessionFile: string;
  watcher: SimpleFileWatcher;
  initialByteOffset: number;
  done: boolean;
}

/**
 * Simple file watcher for Codex session files.
 * Tails a JSONL file from a given byte offset, emits parsed events.
 */
class SimpleFileWatcher extends EventEmitter {
  private filePath: string;
  private lastReadOffset: number;
  private lineBuffer = '';
  private fileWatcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string, initialOffset: number) {
    super();
    this.filePath = filePath;
    this.lastReadOffset = initialOffset;
  }

  start(): void {
    // Wait for file to exist, then start tailing
    const tryWatch = () => {
      if (this.stopped) return;
      if (!fs.existsSync(this.filePath)) {
        this.pollTimer = setTimeout(tryWatch, 200);
        return;
      }
      // Read any content that appeared since our offset
      this.readFromOffset();
      try {
        this.fileWatcher = fs.watch(this.filePath, (eventType) => {
          if (this.stopped || eventType !== 'change') return;
          if (this.debounceTimer) return;
          this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.readFromOffset();
          }, DEBOUNCE_MS);
        });
      } catch (err: any) {
        console.error(`[atoo-any-watcher] Cannot watch ${this.filePath}:`, err.message);
      }
    };
    tryWatch();
  }

  /** Do a final read to capture any remaining events. */
  finalRead(): void {
    this.readFromOffset();
  }

  stop(): void {
    this.stopped = true;
    if (this.fileWatcher) { this.fileWatcher.close(); this.fileWatcher = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  private readFromOffset(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch { return; }

    if (stat.size <= this.lastReadOffset) return;

    try {
      const fd = fs.openSync(this.filePath, 'r');
      const buf = Buffer.alloc(stat.size - this.lastReadOffset);
      fs.readSync(fd, buf, 0, buf.length, this.lastReadOffset);
      fs.closeSync(fd);
      this.lastReadOffset = stat.size;

      const chunk = this.lineBuffer + buf.toString('utf-8');
      const lines = chunk.split('\n');
      this.lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.emit('event', JSON.parse(line));
        } catch {}
      }
    } catch (err: any) {
      console.error('[atoo-any-watcher] Read error:', err.message);
    }
  }
}

export class AtooAnyAgent extends EventEmitter implements Agent {
  readonly sessionId: string;
  private status: AgentStatus = 'open';
  private cwd: string = '';
  private createdAt = Date.now();
  private destroyed = false;

  private sessionUuid: string = '';
  private sessionFilePath: string = '';
  private events: SessionEvent[] = [];
  private wireMessages: WireMessage[] = [];
  private pendingToolUses = new Map<string, { name: string; input: any }>();
  private activeDispatches = new Map<string, DispatchInfo>();

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }

  async initialize(options: AgentInitOptions): Promise<void> {
    this.cwd = options.cwd || os.homedir();
    this.sessionUuid = uuidv4();

    ensureSessionsDir(this.cwd);
    this.sessionFilePath = getSessionFilePath(this.cwd, this.sessionUuid);

    // If resuming, load historical events
    if (options.resumeSessionUuid) {
      this.sessionUuid = options.resumeSessionUuid;
      this.sessionFilePath = getSessionFilePath(this.cwd, this.sessionUuid);
      await this.loadHistoricalEvents();
    }

    this.emit('ready');
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    // Kill all active processes and clean up temp files
    for (const dispatch of this.activeDispatches.values()) {
      try {
        dispatch.watcher.stop();
        killCliProcess(dispatch.envId);
        if (fs.existsSync(dispatch.tempSessionFile)) {
          fs.unlinkSync(dispatch.tempSessionFile);
        }
      } catch {}
    }
    this.activeDispatches.clear();

    this.setStatus('exited');
    this.emit('exit');
  }

  sendMessage(text: string, attachments?: Attachment[], meta?: Record<string, any>): void {
    if (!text || this.destroyed) return;

    const agents: string[] = meta?.agents || ['claude', 'codex'];

    // Create user event
    const userUuid = uuidv4();
    const userEvent: UserEvent = {
      type: 'user',
      uuid: userUuid,
      sessionId: this.sessionUuid,
      parentUuid: null,
      timestamp: new Date().toISOString(),
      cwd: this.cwd,
      message: { role: 'user', content: text },
    };

    // Store and persist
    this.events.push(userEvent);
    appendEvent(this.sessionFilePath, userEvent);

    // Emit user message to UI
    const userWireMsgs = toWireMessages(this.sessionId, userEvent, this.pendingToolUses);
    for (const msg of userWireMsgs) {
      this.wireMessages.push(msg);
      this.emit('message', msg);
    }

    // Dispatch to each selected agent
    const multiAgent = agents.filter(a => a === 'claude' || a === 'codex').length > 1;
    const MULTI_AGENT_CONTEXT = '[IMPORTANT CONTEXT: This message was sent to multiple agents simultaneously. All agents are working on this in parallel on the same codebase. Be aware of potential file conflicts. If the user addresses a specific agent with @claude or @codex, only the addressed agent should act on that part. Coordinate by making atomic, self-contained changes.]';
    for (const agentFamily of agents) {
      if (agentFamily === 'claude' || agentFamily === 'codex') {
        const dispatchMessage = multiAgent ? `${MULTI_AGENT_CONTEXT}\n\n${text}` : text;
        this.dispatchToAgent(agentFamily, dispatchMessage, userUuid);
      }
    }
  }

  approve(_requestId: string, _updatedInput?: any): void {}
  deny(_requestId: string): void {}
  answerQuestion(_requestId: string, _answers: Record<string, string>): void {}
  setMode(_mode: string): void {}
  setModel(_model: string): void {}
  refreshContext(): void {}
  sendKey(_key: string): void {}
  onFocused(): void {}
  onBlurred(): void {}

  forkToResumable(_afterEventUuid: string, _fromEventUuid?: string, _targetDir?: string): string | null {
    return null; // Forking not supported for atoo-any (use in-session branches instead)
  }

  // ─── Branch Operations ────────────────────────────────

  removeMessages(eventUuids: string[]): void {
    const op: AtooBranchOperation = {
      type: 'branch_operation',
      uuid: uuidv4(),
      timestamp: new Date().toISOString(),
      operation: 'remove',
      targetEventUuids: eventUuids,
    };
    appendBranchOperation(this.sessionFilePath, op);
    // Emit status update to frontend
    this.emit('message', { type: 'branch_update', sessionId: this.sessionId, operation: 'remove', eventUuids });
  }

  restoreMessage(eventUuid: string): void {
    const op: AtooBranchOperation = {
      type: 'branch_operation',
      uuid: uuidv4(),
      timestamp: new Date().toISOString(),
      operation: 'restore',
      targetEventUuids: [eventUuid],
    };
    appendBranchOperation(this.sessionFilePath, op);
    this.emit('message', { type: 'branch_update', sessionId: this.sessionId, operation: 'restore', eventUuids: [eventUuid] });
  }

  compactMessages(eventUuids: string[], compactedBy: string): void {
    // TODO: Actually call the agent to generate a summary. For now, placeholder.
    const summary = `[Compacted ${eventUuids.length} events by ${compactedBy}]`;
    const op: AtooBranchOperation = {
      type: 'branch_operation',
      uuid: uuidv4(),
      timestamp: new Date().toISOString(),
      operation: 'compact',
      targetEventUuids: eventUuids,
      compactedBy,
      compactedSummary: summary,
    };
    appendBranchOperation(this.sessionFilePath, op);
    this.emit('message', { type: 'branch_update', sessionId: this.sessionId, operation: 'compact', eventUuids, compactedBy, compactedSummary: summary });
  }

  forkConversation(afterIndex: number): void {
    const op: AtooBranchOperation = {
      type: 'branch_operation',
      uuid: uuidv4(),
      timestamp: new Date().toISOString(),
      operation: 'fork',
      forkPointEventUuid: this.events[afterIndex]?.uuid,
      branchId: uuidv4(),
      branchLabel: `Branch ${Date.now()}`,
    };
    appendBranchOperation(this.sessionFilePath, op);
    this.emit('message', { type: 'branch_update', sessionId: this.sessionId, operation: 'fork', forkPointEventUuid: op.forkPointEventUuid, branchId: op.branchId, branchLabel: op.branchLabel });
  }

  extractRange(startIndex: number, endIndex: number, label?: string): void {
    const startUuid = this.events[startIndex]?.uuid;
    const endUuid = this.events[endIndex]?.uuid;
    const op: AtooBranchOperation = {
      type: 'branch_operation',
      uuid: uuidv4(),
      timestamp: new Date().toISOString(),
      operation: 'extract',
      extractionId: uuidv4(),
      extractionLabel: label || `Extract ${Date.now()}`,
      sourceRange: [startUuid, endUuid],
    };
    appendBranchOperation(this.sessionFilePath, op);
    this.emit('message', { type: 'branch_update', sessionId: this.sessionId, operation: 'extract', extractionId: op.extractionId, extractionLabel: op.extractionLabel, sourceRange: op.sourceRange });
  }

  getInfo(): AgentSessionInfo {
    return {
      sessionId: this.sessionId,
      agentType: 'atoo-any',
      agentMode: 'chat',
      status: this.status,
      cwd: this.cwd || undefined,
      capabilities: this.getCapabilities(),
      createdAt: this.createdAt,
      cliSessionId: this.sessionUuid || undefined,
    };
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

  getCliSessionId(): string | null {
    return this.sessionUuid;
  }

  // ─── Private ───────────────────────────────────────────

  private async loadHistoricalEvents(): Promise<void> {
    try {
      const atooEvents = readAllEvents(this.sessionFilePath);
      for (const event of atooEvents) {
        this.events.push(event as SessionEvent);
      }

      // Rebuild wireMessages with dispatch grouping
      const historyToolUses = new Map<string, { name: string; input: any }>();
      for (const event of atooEvents) {
        const wireMsgs = toWireMessages(this.sessionId, event as SessionEvent, historyToolUses);
        for (const msg of wireMsgs) {
          // Restore dispatch grouping from metadata
          if (event._dispatchId) {
            msg._parentToolUseId = event._dispatchId;
          }
          if (event._source) {
            msg._agentId = event._source;
          }
          this.wireMessages.push(msg);
        }
      }

      // Sync pendingToolUses
      for (const [id, info] of historyToolUses) {
        this.pendingToolUses.set(id, info);
      }

      console.log(`[atoo-any] Loaded ${this.wireMessages.length} historical messages for ${this.sessionUuid}`);
    } catch (err: any) {
      console.warn(`[atoo-any] Failed to load history for ${this.sessionUuid}:`, err.message);
    }
  }

  private dispatchToAgent(family: 'claude' | 'codex', message: string, parentUserUuid: string): void {
    const dispatchId = `${parentUserUuid}:${family}`;
    const tempUuid = uuidv4();

    // Build clean conversation history as SessionEvents for the CLI's session file.
    const cleanEvents = this.buildConversationHistory(family);

    let tempFilePath: string;
    try {
      if (family === 'claude') {
        tempFilePath = writeForkedClaudeJsonl(cleanEvents, tempUuid, this.cwd);
      } else {
        tempFilePath = writeForkedCodexJsonl(cleanEvents, tempUuid, this.cwd);
      }
    } catch (err: any) {
      console.error(`[atoo-any] Failed to write temp ${family} session:`, err.message);
      return;
    }
    // Record initial byte offset to skip pre-written content
    let initialByteOffset = 0;
    try {
      const stat = fs.statSync(tempFilePath);
      initialByteOffset = stat.size;
    } catch {}

    // Spawn the CLI process
    let envId: string;
    try {
      if (family === 'claude') {
        ({ envId } = spawnClaudeOneShot({ cwd: this.cwd, resumeUuid: tempUuid, message, parentSessionUuid: this.sessionUuid }));
      } else {
        ({ envId } = spawnCodexOneShot({ cwd: this.cwd, resumeUuid: tempUuid, message, parentSessionUuid: this.sessionUuid }));
      }
    } catch (err: any) {
      console.error(`[atoo-any] Failed to spawn ${family}:`, err.message);
      try { fs.unlinkSync(tempFilePath); } catch {}
      return;
    }

    // Set up file watcher on the temp session file
    const watcher = new SimpleFileWatcher(tempFilePath, initialByteOffset);

    const dispatch: DispatchInfo = {
      dispatchId,
      agentFamily: family,
      parentUserUuid,
      envId,
      tempSessionUuid: tempUuid,
      tempSessionFile: tempFilePath,
      watcher,
      initialByteOffset,
      done: false,
    };

    this.activeDispatches.set(dispatchId, dispatch);
    this.setStatus('active');

    // Handle incoming events from the watcher
    watcher.on('event', (rawEvent: any) => {
      this.handleDispatchEvent(dispatch, rawEvent);
    });

    // Handle process exit — delay to allow filesystem flush before final read
    const pty = getPty(envId);
    if (pty) {
      pty.onExit(({ exitCode }) => {
        console.log(`[atoo-any] ${family} process exited (code=${exitCode}) for dispatch ${dispatchId}`);

        // Delay final read to allow filesystem to flush buffered writes.
        // The CLI may have written events that haven't been fsynced yet.
        const finalize = (retriesLeft: number) => {
          watcher.finalRead();

          // If we still have no dispatch events and the file has content beyond
          // our initial offset, retry after a short delay
          const hasEvents = this.events.some(
            (e: any) => e._dispatchId === dispatchId && e.type === 'assistant',
          );
          if (!hasEvents && retriesLeft > 0) {
            try {
              const stat = fs.statSync(tempFilePath);
              if (stat.size > dispatch.initialByteOffset) {
                // File has new content we haven't processed — retry
                setTimeout(() => finalize(retriesLeft - 1), 100);
                return;
              }
            } catch {}
          }

          watcher.stop();
          dispatch.done = true;

          // Clean up temp session file
          try {
            if (fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath);
            }
          } catch {}

          // Check if all dispatches are done
          const allDone = [...this.activeDispatches.values()].every(d => d.done);
          if (allDone) {
            this.setStatus('open');
          }
        };

        // Initial delay of 150ms before first final read attempt, then up to 3 retries
        setTimeout(() => finalize(3), 150);
      });
    }

    // Start the watcher
    watcher.start();
  }

  private handleDispatchEvent(dispatch: DispatchInfo, rawEvent: any): void {
    if (this.destroyed) return;

    // Skip non-conversational events
    if (rawEvent.type === 'file-history-snapshot') return;
    if (rawEvent.type === 'last-prompt') return;
    if (rawEvent.type === 'queue-operation') return;
    if (rawEvent.type === 'progress') return;

    // Skip user events — we already have the user message in our atoo session.
    // The CLI rewrites it into its own session, but we don't want duplicates.
    if (rawEvent.type === 'user') return;

    // For Codex format: skip session_meta, user_message event_msg, turn_context, task_started
    if (rawEvent.type === 'session_meta') return;
    if (rawEvent.type === 'turn_context') return;
    if (rawEvent.type === 'event_msg' && rawEvent.payload?.type === 'user_message') return;
    if (rawEvent.type === 'event_msg' && rawEvent.payload?.type === 'task_started') return;
    if (rawEvent.type === 'event_msg' && rawEvent.payload?.type === 'token_count') return;

    // For Codex events, we need to map them to SessionEvents
    // The SimpleFileWatcher gives us raw JSONL lines — for Codex these are in Codex format
    let sessionEvents: SessionEvent[];
    if (dispatch.agentFamily === 'codex') {
      try {
        sessionEvents = mapCodexJsonlLine(rawEvent);
      } catch {
        sessionEvents = [rawEvent as SessionEvent];
      }
    } else {
      sessionEvents = [rawEvent as SessionEvent];
    }

    const meta: AtooEventMeta = {
      _source: dispatch.agentFamily,
      _parentUserUuid: dispatch.parentUserUuid,
      _dispatchId: dispatch.dispatchId,
    };

    for (const event of sessionEvents) {
      // Tag in-memory event with dispatch metadata for history reconstruction
      (event as any)._source = meta._source;
      (event as any)._dispatchId = meta._dispatchId;
      (event as any)._parentUserUuid = meta._parentUserUuid;

      // Store in our events array and persist
      this.events.push(event);
      appendEvent(this.sessionFilePath, event, meta);

      // Convert to wire messages
      const wireMsgs = toWireMessages(this.sessionId, event, this.pendingToolUses);
      for (const msg of wireMsgs) {
        // Tag with dispatch info for UI grouping
        msg._parentToolUseId = dispatch.dispatchId;
        msg._agentId = dispatch.agentFamily;

        this.wireMessages.push(msg);
        this.emit('message', msg);
      }
    }
  }

  /**
   * Build conversation history for a dispatch by filtering real events.
   * Includes user messages + the preferred family's dispatch events first,
   * then the other family's events so both agents see the full picture
   * (e.g. ask_user results, tool calls). The session writers handle UUID
   * remapping automatically, so broken parentUuid chains are fixed.
   */
  private buildConversationHistory(preferFamily: 'claude' | 'codex'): SessionEvent[] {
    const allEvents = this.events.slice(0, -1); // exclude current user message
    if (allEvents.length === 0) return [];

    const otherFamily = preferFamily === 'claude' ? 'codex' : 'claude';
    const result: SessionEvent[] = [];

    // Walk through events: include user messages and both families' responses
    // (preferred first, then other) so each agent sees the full conversation.
    for (let i = 0; i < allEvents.length; i++) {
      const ev = allEvents[i] as any;

      if (ev.type === 'user' && !ev._dispatchId) {
        result.push(ev);

        // Collect dispatch events for this turn, grouped by family
        const preferred: SessionEvent[] = [];
        const other: SessionEvent[] = [];
        for (let j = i + 1; j < allEvents.length; j++) {
          const de = allEvents[j] as any;
          if (de.type === 'user' && !de._dispatchId) break;
          if (!de._dispatchId) continue;
          if (de._source === preferFamily) preferred.push(de);
          else if (de._source === otherFamily) other.push(de);
        }

        // Include preferred family first, then other family
        result.push(...preferred, ...other);
      }
    }

    return stripMeta(result);
  }

  private getCapabilities(): AgentCapabilities {
    return {
      canChangeMode: false,
      canChangeModel: false,
      hasContextUsage: false,
      canFork: false,
      canResume: true,
      hasTerminal: false,
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
