/**
 * AtooAnyAgent v2 — meta-agent using the normalized session schema.
 *
 * Chat-only mode. Sends user messages to one or more CLIs, merges their streaming
 * responses into a tree-based session with per-prompt JSONL files.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type {
  Agent,
  AgentInitOptions,
  AgentSessionInfo,
  AgentStatus,
  AgentCapabilities,
  Attachment as AgentAttachment,
} from '../types.js';
import type { SessionEvent } from '../../events/types.js';
import type { WireMessage } from '../../events/wire.js';
import { toWireMessages } from '../../events/wire.js';
import { writeForkedClaudeJsonl } from '../lib/claude/jsonl-writer.js';
import { writeForkedCodexJsonl } from '../lib/codex/jsonl-writer.js';
import { writeForkedGeminiJson } from '../lib/gemini/json-writer.js';
import { killCliProcess, getPty } from '../../spawner.js';
import { spawnClaudeOneShot, spawnCodexOneShot, spawnGeminiOneShot } from './spawner.js';
import { mapCodexJsonlLine } from '../lib/codex/jsonl-mapper.js';
import { mapGeminiMessage, type GeminiMessage } from '../lib/gemini/json-mapper.js';
import { GeminiJsonWatcher } from '../lib/gemini/json-watcher.js';
import { initFileTracking, ToolResultFileTracker } from '../lib/fs-tracking.js';
import { fsMonitor } from '../../fs-monitor.js';
import type {
  Session,
  Prompt,
  AgentRun,
  TreeNode,
  PromptEvent,
  Attachment,
  ClientState,
} from './schema-types.js';
import {
  createSession,
  createPrompt,
  createAgentRun,
  createCompactionPrompt,
} from './schema-types.js';
import {
  ensureSessionDir,
  getSessionDir,
  readSession,
  readSessionSafe,
  writeSession,
  enqueueSessionWrite,
  appendPromptEvent,
  readPromptEvents,
  writeBlob,
  writeBlobBase64,
  walkActivePath,
  findMostRecentPath,
  appendToActivePath,
  forkAtNode,
  compactInTree,
  hideInTree,
  extractAsRoot,
} from './session-store.js';

const DEBOUNCE_MS = 50;

type AgentFamily = 'claude' | 'codex' | 'gemini';

const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
};

interface DispatchInfo {
  dispatchId: string;
  agentFamily: AgentFamily;
  agentKey: string;
  runId: string; // AgentRun UUID for prompt JSONL
  parentUserUuid: string;
  promptUuid: string;
  envId: string;
  pid: number;
  tempSessionUuid: string;
  tempSessionFile: string;
  watcher: SimpleFileWatcher | GeminiJsonWatcher;
  initialByteOffset: number;
  done: boolean;
  cleanupInstance?: () => void;
  fileTracker: ToolResultFileTracker;
}

/**
 * Simple file watcher for JSONL session files (Claude/Codex).
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
    const tryWatch = () => {
      if (this.stopped) return;
      if (!fs.existsSync(this.filePath)) {
        this.pollTimer = setTimeout(tryWatch, 200);
        return;
      }
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

// ═══════════════════════════════════════════════════════
// AtooAnyAgent v2
// ═══════════════════════════════════════════════════════

export class AtooAnyAgent extends EventEmitter implements Agent {
  readonly sessionId: string;
  private status: AgentStatus = 'open';
  private cwd: string = '';
  private createdAt = Date.now();
  private destroyed = false;

  // New schema state
  private sessionDir: string = '';
  private session: Session | null = null;
  private clientId: string = '';
  private currentPromptUuid: string | null = null;

  // Wire messages cache (for getMessages/getWireMessages)
  private wireMessages: WireMessage[] = [];
  private pendingToolUses = new Map<string, { name: string; input: any }>();

  // Active dispatches
  private activeDispatches = new Map<string, DispatchInfo>();
  private userIsViewing = true;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
    this.clientId = uuidv4();
  }

  // ─── Accessors ─────────────────────────────────────────

  getSessionData(): Session | null {
    return this.session;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getClientId(): string {
    return this.clientId;
  }

  getActivePath(): number[] {
    return this.session?.clientState[this.clientId]?.activePath ?? [];
  }

  // ─── Lifecycle ─────────────────────────────────────────

  async initialize(options: AgentInitOptions): Promise<void> {
    this.cwd = options.cwd || os.homedir();

    const sessionUuid = options.resumeSessionUuid || uuidv4();
    this.sessionDir = getSessionDir(this.cwd, sessionUuid);

    if (options.resumeSessionUuid) {
      // Resume existing session
      const existing = readSessionSafe(this.sessionDir);
      if (existing) {
        this.session = existing;
        // Register client and find most recent path
        this.registerClient();
        await this.rebuildWireMessages();
      } else {
        // Session not found, create new
        const { session } = this.initNewSession(sessionUuid);
        this.session = session;
        this.registerClient();
      }
    } else {
      // New session
      const { session } = this.initNewSession(sessionUuid);
      this.session = session;
      this.registerClient();
    }

    this.emit('ready');
  }

  private initNewSession(uuid: string): { session: Session; sessionDir: string } {
    const sessionDir = ensureSessionDir(this.cwd, uuid);
    this.sessionDir = sessionDir;
    const session = createSession(uuid, this.cwd);
    writeSession(sessionDir, session);
    return { session, sessionDir };
  }

  private registerClient(): void {
    if (!this.session) return;
    const activePath = findMostRecentPath(this.session.tree, this.session.prompts);
    this.session.clientState[this.clientId] = {
      lastSeen: new Date().toISOString(),
      activePath,
    };
    writeSession(this.sessionDir, this.session);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const dispatch of this.activeDispatches.values()) {
      try {
        dispatch.watcher.stop();
        killCliProcess(dispatch.envId);
        if (dispatch.agentFamily !== 'gemini' && fs.existsSync(dispatch.tempSessionFile)) {
          fs.unlinkSync(dispatch.tempSessionFile);
        }
        if (dispatch.cleanupInstance) dispatch.cleanupInstance();
      } catch {}
    }
    this.activeDispatches.clear();

    this.setStatus('exited');
    this.emit('exit');
  }

  // ─── Kill agents ───────────────────────────────────────

  killAgent(agentFamily: string): void {
    for (const [, dispatch] of this.activeDispatches) {
      if ((dispatch.agentKey === agentFamily || dispatch.agentFamily === agentFamily) && !dispatch.done) {
        try {
          dispatch.watcher.stop();
          killCliProcess(dispatch.envId);
        } catch {}
        dispatch.done = true;
      }
    }
    if ([...this.activeDispatches.values()].every(d => d.done)) {
      this.setStatus(this.userIsViewing ? 'open' : 'attention');
    }
  }

  killAllAgents(): void {
    for (const dispatch of this.activeDispatches.values()) {
      if (!dispatch.done) {
        try {
          dispatch.watcher.stop();
          killCliProcess(dispatch.envId);
        } catch {}
        dispatch.done = true;
      }
    }
    this.setStatus(this.userIsViewing ? 'open' : 'attention');
  }

  // ─── Send Message ──────────────────────────────────────

  sendMessage(text: string, attachments?: AgentAttachment[], meta?: Record<string, any>): void {
    if (!text || this.destroyed || !this.session) return;

    const agents: string[] = meta?.agents || ['claude', 'codex'];
    const promptUuid = uuidv4();
    this.currentPromptUuid = promptUuid;

    // Store attachments as blobs
    const storedAttachments: Attachment[] = [];
    if (attachments?.length) {
      for (const att of attachments) {
        if (!att.data && !att.text) continue;
        const blobUuid = uuidv4();
        if (att.text) {
          writeBlob(this.sessionDir, Buffer.from(att.text, 'utf-8'));
        } else if (att.data) {
          writeBlobBase64(this.sessionDir, att.data);
        }
        storedAttachments.push({
          uuid: blobUuid,
          filename: att.name || `attachment-${storedAttachments.length + 1}`,
          mime: att.media_type,
        });
      }
    }

    // Build dispatch list
    const supportedAgents: AgentFamily[] = ['claude', 'codex', 'gemini'];
    interface DispatchEntry {
      family: AgentFamily;
      dispatchKey: string;
      modelConfig?: { model?: string; reasoning?: string };
    }
    const dispatches: DispatchEntry[] = [];

    if (meta?.agentSelectorConfig) {
      const familyCounts: Record<string, number> = {};
      for (const entry of meta.agentSelectorConfig) {
        if (entry.enabled && supportedAgents.includes(entry.provider as AgentFamily)) {
          familyCounts[entry.provider] = (familyCounts[entry.provider] || 0) + 1;
        }
      }
      for (const entry of meta.agentSelectorConfig) {
        if (!entry.enabled || !supportedAgents.includes(entry.provider as AgentFamily)) continue;
        const family = entry.provider as AgentFamily;
        const modelId = entry.model?.id;
        const dispatchKey = familyCounts[family] > 1 && modelId
          ? `${family}:${modelId}`
          : family;
        dispatches.push({
          family,
          dispatchKey,
          modelConfig: {
            model: modelId,
            reasoning: entry.model?.reasoning?.level || undefined,
          },
        });
      }
    }
    if (dispatches.length === 0) {
      for (const a of agents) {
        if (supportedAgents.includes(a as AgentFamily)) {
          dispatches.push({ family: a as AgentFamily, dispatchKey: a });
        }
      }
    }

    // Create agent runs
    const agentRuns: AgentRun[] = dispatches.map(d =>
      createAgentRun(uuidv4(), d.family, d.modelConfig?.model || d.family, d.modelConfig?.reasoning)
    );

    // Get git info
    let git: Prompt['git'] | undefined;
    try {
      const branch = fs.readFileSync(path.join(this.cwd, '.git', 'HEAD'), 'utf-8').trim();
      const branchName = branch.startsWith('ref: refs/heads/') ? branch.slice(16) : branch;
      git = { branch: branchName };
    } catch {}

    // Create prompt
    const prompt = createPrompt(promptUuid, agentRuns, storedAttachments.length > 0 ? storedAttachments : undefined, git);

    // Write prompt JSONL with the user message
    const promptMsg: PromptEvent = {
      type: 'prompt',
      message: text,
      timestamp: new Date().toISOString(),
      ...(storedAttachments.length > 0 ? { blobs: storedAttachments.map(a => a.uuid) } : {}),
    };
    appendPromptEvent(this.sessionDir, promptUuid, promptMsg);

    // Update session.json: add prompt to index, append to tree
    const activePath = this.getActivePath();
    const agentIndices = agentRuns.map((_, i) => i);
    this.session.prompts[promptUuid] = prompt;
    appendToActivePath(this.session, activePath, promptUuid, agentIndices);
    writeSession(this.sessionDir, this.session);

    // Emit user message to UI
    const userWireMsg: WireMessage = {
      id: promptUuid,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      type: 'user_message',
      text,
      ...(storedAttachments.length > 0 ? {
        attachments: attachments?.map(a => ({
          media_type: a.media_type,
          data: a.data || '',
          name: a.name,
          text: a.text,
        }))
      } : {}),
    } as any;
    if (meta?.agentSelectorConfig) (userWireMsg as any).agentSelectorConfig = meta.agentSelectorConfig;
    this.wireMessages.push(userWireMsg);
    this.emit('message', userWireMsg);

    // Write attachment temp files for agent dispatch
    const attachmentPaths = this.writeAttachmentTempFiles(promptUuid, attachments);

    // Dispatch to agents
    const multiAgent = dispatches.length > 1;
    const MULTI_AGENT_CONTEXT = '[IMPORTANT CONTEXT: This message was sent to multiple agents simultaneously. All agents are working on this in parallel on the same codebase. Be aware of potential file conflicts. If the user addresses a specific agent with @claude, @codex, or @gemini, only the addressed agent should act on that part. Coordinate by making atomic, self-contained changes.]';

    for (let i = 0; i < dispatches.length; i++) {
      const dispatch = dispatches[i];
      let dispatchMessage = multiAgent ? `${MULTI_AGENT_CONTEXT}\n\n${text}` : text;
      if (attachmentPaths.length > 0) {
        const pathList = attachmentPaths.map(p => `"${p}"`).join(';');
        dispatchMessage = `You MUST read the following user attachments: ${pathList}\nThe actual user prompt follows from the next line.\n${dispatchMessage}`;
      }

      // Write run_start to prompt JSONL
      const runStartEvent: PromptEvent = {
        type: 'run_start',
        runId: agentRuns[i].uuid,
      };
      appendPromptEvent(this.sessionDir, promptUuid, runStartEvent);

      this.dispatchToAgent(dispatch.family, dispatchMessage, promptUuid, agentRuns[i].uuid, dispatch.modelConfig, dispatch.dispatchKey);
    }
  }

  // ─── Branch Operations ─────────────────────────────────

  forkConversation(afterPromptUuid: string): void {
    if (!this.session) return;

    const activePath = this.getActivePath();
    const newChildIndex = forkAtNode(this.session, activePath, afterPromptUuid);

    // Update client to point to the new branch
    const newPath = [...activePath];
    // Find fork depth
    const nodes = walkActivePath(this.session.tree, activePath);
    let forkDepth = 1;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].uuid === afterPromptUuid) break;
      if (nodes[i].children && nodes[i].children!.length > 1) forkDepth++;
    }
    while (newPath.length <= forkDepth) newPath.push(0);
    newPath[forkDepth] = newChildIndex;

    this.session.clientState[this.clientId].activePath = newPath;
    writeSession(this.sessionDir, this.session);

    this.emitTreeUpdate();
  }

  switchBranch(activePath: number[]): void {
    if (!this.session) return;
    this.session.clientState[this.clientId].activePath = activePath;
    this.session.clientState[this.clientId].lastSeen = new Date().toISOString();
    writeSession(this.sessionDir, this.session);
    this.emitTreeUpdate();
  }

  compactMessages(promptUuids: string[], compactedBy: string): void {
    if (!this.session) return;

    // Create compaction prompt
    const compactUuid = uuidv4();
    const compactRun = createAgentRun(uuidv4(), compactedBy, 'haiku', 'low');
    const compactPrompt = createCompactionPrompt(compactUuid, promptUuids, compactRun);

    // TODO: Actually call the agent to generate a summary. For now, placeholder.
    const summary = `[Compacted ${promptUuids.length} prompts by ${compactedBy}]`;
    compactPrompt.title = `Compacted: ${promptUuids.length} prompts`;

    // Write compaction prompt JSONL
    const promptMsg: PromptEvent = {
      type: 'prompt',
      message: `[Compacted] ${promptUuids.length} turns compacted`,
      timestamp: new Date().toISOString(),
    };
    appendPromptEvent(this.sessionDir, compactUuid, promptMsg);

    const runStart: PromptEvent = { type: 'run_start', runId: compactRun.uuid };
    appendPromptEvent(this.sessionDir, compactUuid, runStart);

    const runMsg: PromptEvent = {
      type: 'run_msg',
      runId: compactRun.uuid,
      role: 'assistant',
      content: { type: 'text', text: summary },
    };
    appendPromptEvent(this.sessionDir, compactUuid, runMsg);

    const runEnd: PromptEvent = { type: 'run_end', runId: compactRun.uuid };
    appendPromptEvent(this.sessionDir, compactUuid, runEnd);

    // Update session
    this.session.prompts[compactUuid] = compactPrompt;
    const activePath = this.getActivePath();
    const newPath = compactInTree(this.session, activePath, compactUuid, promptUuids);
    this.session.clientState[this.clientId].activePath = newPath;
    writeSession(this.sessionDir, this.session);

    this.emitTreeUpdate();
  }

  removeMessages(promptUuids: string[]): void {
    if (!this.session) return;
    // Hide = create new branch with prompts marked hidden
    let currentPath = this.getActivePath();
    for (const uuid of promptUuids) {
      currentPath = hideInTree(this.session, currentPath, uuid);
    }
    this.session.clientState[this.clientId].activePath = currentPath;
    writeSession(this.sessionDir, this.session);
    this.emitTreeUpdate();
  }

  restoreMessage(_promptUuid: string): void {
    // Restore = switch back to the parent branch that has the non-hidden version
    // This is just a branch switch in the new model
    this.emitTreeUpdate();
  }

  extractRange(startIndex: number, endIndex: number, label?: string): void {
    if (!this.session) return;

    const nodes = walkActivePath(this.session.tree, this.getActivePath());
    const promptUuids = nodes.slice(startIndex, endIndex + 1).map(n => n.uuid);

    extractAsRoot(this.session, promptUuids, label);
    writeSession(this.sessionDir, this.session);
    this.emitTreeUpdate();
  }

  extractPrompts(promptUuids: string[], label?: string): void {
    if (!this.session) return;
    extractAsRoot(this.session, promptUuids, label);
    writeSession(this.sessionDir, this.session);
    this.emitTreeUpdate();
  }

  forkToResumable(_afterEventUuid: string, _fromEventUuid?: string, _targetDir?: string): string | null {
    return null;
  }

  // ─── State getters ─────────────────────────────────────

  approve(_requestId: string, _updatedInput?: any): void {}
  deny(_requestId: string): void {}
  answerQuestion(_requestId: string, _answers: Record<string, string>): void {}
  setMode(_mode: string): void {}
  setModel(_model: string): void {}
  refreshContext(): void {}
  sendKey(_key: string): void {}

  onFocused(): void {
    this.userIsViewing = true;
    if (this.status === 'attention') this.setStatus('open');
  }
  onBlurred(): void { this.userIsViewing = false; }

  getInfo(): AgentSessionInfo {
    return {
      sessionId: this.sessionId,
      agentType: 'atoo-any',
      agentMode: 'chat',
      status: this.status,
      cwd: this.cwd || undefined,
      capabilities: this.getCapabilities(),
      createdAt: this.createdAt,
      cliSessionId: this.session?.uuid || undefined,
    };
  }

  getMessages(): WireMessage[] {
    return this.wireMessages;
  }

  getEvents(): SessionEvent[] {
    // Flatten tree to SessionEvents for backward compatibility
    return this.buildFlatSessionEvents();
  }

  getWireMessages(): WireMessage[] {
    return this.wireMessages;
  }

  getCliSessionId(): string | null {
    return this.session?.uuid || null;
  }

  getRunningDispatches(): string[] {
    return [...this.activeDispatches.values()]
      .filter(d => !d.done)
      .map(d => d.dispatchId);
  }

  // ─── Private: Dispatch ─────────────────────────────────

  private dispatchToAgent(
    family: AgentFamily,
    message: string,
    promptUuid: string,
    runId: string,
    modelConfig?: { model?: string; reasoning?: string },
    dispatchKey?: string,
  ): void {
    const effectiveKey = dispatchKey || family;
    const dispatchId = `${promptUuid}:${effectiveKey}`;
    const tempUuid = uuidv4();

    // Build conversation history for the CLI
    const cleanEvents = this.buildConversationHistory(family);
    this.injectHistoryAttachments(cleanEvents);

    let tempFilePath: string;
    try {
      if (family === 'claude') {
        tempFilePath = writeForkedClaudeJsonl(cleanEvents, tempUuid, this.cwd);
      } else if (family === 'codex') {
        tempFilePath = writeForkedCodexJsonl(cleanEvents, tempUuid, this.cwd);
      } else {
        tempFilePath = writeForkedGeminiJson(cleanEvents, tempUuid, this.cwd);
      }
    } catch (err: any) {
      console.error(`[atoo-any] Failed to write temp ${family} session:`, err.message);
      return;
    }

    let initialByteOffset = 0;
    let initialMessageCount = 0;
    try {
      if (family === 'gemini') {
        const content = fs.readFileSync(tempFilePath, 'utf-8');
        const session = JSON.parse(content);
        initialMessageCount = session.messages?.length || 0;
      } else {
        initialByteOffset = fs.statSync(tempFilePath).size;
      }
    } catch {}

    // Spawn CLI process
    const preloadSessionId = uuidv4();
    let envId: string;
    let pid: number;
    let cleanupInstance: (() => void) | undefined;

    try {
      if (family === 'claude') {
        ({ envId, pid } = spawnClaudeOneShot({ cwd: this.cwd, resumeUuid: tempUuid, message, parentSessionUuid: this.session!.uuid, model: modelConfig?.model, reasoning: modelConfig?.reasoning, preloadSessionId }));
      } else if (family === 'codex') {
        ({ envId, pid } = spawnCodexOneShot({ cwd: this.cwd, resumeUuid: tempUuid, message, parentSessionUuid: this.session!.uuid, model: modelConfig?.model, reasoning: modelConfig?.reasoning, preloadSessionId }));
      } else {
        const result = spawnGeminiOneShot({ cwd: this.cwd, resumeUuid: tempUuid, message, parentSessionUuid: this.session!.uuid, model: modelConfig?.model, reasoning: modelConfig?.reasoning, preloadSessionId });
        envId = result.envId;
        pid = result.pid;
        cleanupInstance = result.cleanupInstance;
        if (result.sessionFilePath) tempFilePath = result.sessionFilePath;
      }
    } catch (err: any) {
      console.error(`[atoo-any] Failed to spawn ${family}:`, err.message);
      try { fs.unlinkSync(tempFilePath); } catch {}
      return;
    }

    // File change tracking
    initFileTracking({ sessionId: dispatchId, cwd: this.cwd, pid: pid!, preloadSessionId });
    const fileTracker = new ToolResultFileTracker(dispatchId);

    // Set up watcher
    let watcher: SimpleFileWatcher | GeminiJsonWatcher;
    if (family === 'gemini') {
      watcher = new GeminiJsonWatcher(tempFilePath, initialMessageCount);
    } else {
      watcher = new SimpleFileWatcher(tempFilePath, initialByteOffset);
    }

    const dispatch: DispatchInfo = {
      dispatchId,
      agentFamily: family,
      agentKey: effectiveKey,
      runId,
      parentUserUuid: promptUuid,
      promptUuid,
      envId,
      pid: pid!,
      tempSessionUuid: tempUuid,
      tempSessionFile: tempFilePath,
      watcher,
      initialByteOffset,
      done: false,
      cleanupInstance,
      fileTracker,
    };

    this.activeDispatches.set(dispatchId, dispatch);
    this.setStatus('active');

    this.emit('message', {
      type: 'dispatch_started',
      sessionId: this.sessionId,
      dispatchId: dispatch.dispatchId,
      agentFamily: dispatch.agentFamily,
    });

    // Handle incoming events
    if (family === 'gemini') {
      (watcher as GeminiJsonWatcher).on('message', (geminiMsg: GeminiMessage) => {
        this.handleGeminiDispatchMessage(dispatch, geminiMsg);
      });
    } else {
      watcher.on('event', (rawEvent: any) => {
        this.handleDispatchEvent(dispatch, rawEvent);
      });
    }

    // Handle process exit
    const pty = getPty(envId);
    if (!pty) {
      console.warn(`[atoo-any] No PTY for ${family} dispatch ${dispatchId} (envId=${envId}) — exit handler won't fire`);
    }
    if (pty) {
      pty.onExit(({ exitCode }) => {
        console.log(`[atoo-any] ${family} process exited (code=${exitCode}) for dispatch ${dispatchId}`);
        let lastFileSize = 0;
        let lastMsgCount = 0;

        const finalize = (retriesLeft: number) => {
          watcher.finalRead();

          let fileStabilized = true;
          try {
            if (dispatch.agentFamily === 'gemini') {
              const content = fs.readFileSync(tempFilePath, 'utf-8');
              const session = JSON.parse(content);
              const currentMsgCount = session.messages?.length || 0;
              fileStabilized = currentMsgCount === lastMsgCount;
              lastMsgCount = currentMsgCount;
            } else {
              const currentSize = fs.statSync(tempFilePath).size;
              fileStabilized = currentSize === lastFileSize;
              lastFileSize = currentSize;
            }
          } catch {}

          if (!fileStabilized && retriesLeft > 0) {
            setTimeout(() => finalize(retriesLeft - 1), 300);
            return;
          }
          if (!fileStabilized) watcher.finalRead();

          // Check if agent produced any output
          const promptEvents = readPromptEvents(this.sessionDir, promptUuid);
          const hasOutput = promptEvents.some(e =>
            e.type === 'run_msg' && (e as any).runId === dispatch.runId
          );

          if (exitCode !== 0 && !hasOutput) {
            this.emitAgentError(dispatch, exitCode);
          }

          // Update agent run endedAt
          this.updateAgentRunEnd(promptUuid, runId);

          // Write run_end
          const runEnd: PromptEvent = { type: 'run_end', runId };
          appendPromptEvent(this.sessionDir, promptUuid, runEnd);

          watcher.stop();
          dispatch.done = true;
          fsMonitor.unwatchPid(dispatch.dispatchId);

          const fileChanges = fsMonitor.getChangesInRange(dispatch.dispatchId);

          this.emit('message', {
            type: 'dispatch_done',
            sessionId: this.sessionId,
            dispatchId: dispatch.dispatchId,
            agentFamily: dispatch.agentFamily,
            exitCode,
            fileChangeCount: fileChanges.length,
          });

          if (dispatch.agentFamily !== 'gemini') {
            try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
          }
          if (dispatch.cleanupInstance) dispatch.cleanupInstance();

          if ([...this.activeDispatches.values()].every(d => d.done)) {
            // Update prompt endedAt
            this.updatePromptEnd(promptUuid);
            this.setStatus('open');
          }
        };

        const initialDelay = family === 'gemini' ? 500 : 200;
        setTimeout(() => finalize(8), initialDelay);
      });
    } else {
      // No PTY — poll for process exit via kill(0) as fallback
      const pollExit = () => {
        try { process.kill(pid!, 0); } catch {
          // Process is gone
          console.log(`[atoo-any] ${family} process gone (no PTY) for dispatch ${dispatchId}`);
          watcher.finalRead();
          const runEnd: PromptEvent = { type: 'run_end', runId };
          appendPromptEvent(this.sessionDir, promptUuid, runEnd);
          this.updateAgentRunEnd(promptUuid, runId);
          watcher.stop();
          dispatch.done = true;
          fsMonitor.unwatchPid(dispatch.dispatchId);
          if (dispatch.agentFamily !== 'gemini') {
            try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
          }
          if (dispatch.cleanupInstance) dispatch.cleanupInstance();
          if ([...this.activeDispatches.values()].every(d => d.done)) {
            this.updatePromptEnd(promptUuid);
            this.setStatus('open');
          }
          this.emit('message', { type: 'dispatch_done', sessionId: this.sessionId, dispatchId: dispatch.dispatchId, agentFamily: dispatch.agentFamily, exitCode: -1, fileChangeCount: 0 });
          return;
        }
        setTimeout(pollExit, 1000);
      };
      setTimeout(pollExit, 2000);
    }

    watcher.start();
  }

  private handleDispatchEvent(dispatch: DispatchInfo, rawEvent: any): void {
    if (this.destroyed) return;

    // Skip non-conversational events
    if (['file-history-snapshot', 'last-prompt', 'queue-operation', 'progress', 'user'].includes(rawEvent.type)) return;
    if (rawEvent.type === 'session_meta') return;
    if (rawEvent.type === 'turn_context') return;
    if (rawEvent.type === 'event_msg' && rawEvent.payload?.type === 'user_message') return;
    if (rawEvent.type === 'event_msg' && rawEvent.payload?.type === 'task_started') return;
    if (rawEvent.type === 'event_msg' && rawEvent.payload?.type === 'token_count') return;

    // Map Codex events
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

    for (const event of sessionEvents) {
      dispatch.fileTracker.processEvent(event);

      // Write to prompt JSONL
      const content = this.sessionEventToContent(event);
      if (content) {
        const runMsg: PromptEvent = {
          type: 'run_msg',
          runId: dispatch.runId,
          role: event.type === 'user' ? 'tool_result' : 'assistant',
          content,
        };
        appendPromptEvent(this.sessionDir, dispatch.promptUuid, runMsg);
      }

      // Convert to wire messages and emit
      const wireMsgs = toWireMessages(this.sessionId, event, this.pendingToolUses);
      for (const msg of wireMsgs) {
        msg._parentToolUseId = dispatch.dispatchId;
        msg._agentId = dispatch.agentKey;
        this.wireMessages.push(msg);
        this.emit('message', msg);
      }
    }
  }

  private handleGeminiDispatchMessage(dispatch: DispatchInfo, geminiMsg: GeminiMessage): void {
    if (this.destroyed) return;
    if (geminiMsg.type === 'user' || geminiMsg.type === 'info') return;

    let sessionEvents: SessionEvent[];
    try {
      sessionEvents = mapGeminiMessage(geminiMsg);
    } catch {
      return;
    }

    for (const event of sessionEvents) {
      dispatch.fileTracker.processEvent(event);

      const content = this.sessionEventToContent(event);
      if (content) {
        const runMsg: PromptEvent = {
          type: 'run_msg',
          runId: dispatch.runId,
          role: event.type === 'user' ? 'tool_result' : 'assistant',
          content,
        };
        appendPromptEvent(this.sessionDir, dispatch.promptUuid, runMsg);
      }

      const wireMsgs = toWireMessages(this.sessionId, event, this.pendingToolUses);
      for (const msg of wireMsgs) {
        msg._parentToolUseId = dispatch.dispatchId;
        msg._agentId = dispatch.agentKey;
        this.wireMessages.push(msg);
        this.emit('message', msg);
      }
    }
  }

  // ─── Private: Helpers ──────────────────────────────────

  private sessionEventToContent(event: SessionEvent): any {
    if (event.type === 'assistant') {
      const msg = (event as any).message;
      if (Array.isArray(msg?.content)) {
        // Return the first meaningful block
        for (const block of msg.content) {
          if (block.type === 'text' || block.type === 'thinking' || block.type === 'tool_use') {
            return block;
          }
        }
      } else if (typeof msg?.content === 'string') {
        return { type: 'text', text: msg.content };
      }
    } else if (event.type === 'user') {
      const msg = (event as any).message;
      if (Array.isArray(msg?.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') return block;
        }
      }
    } else if (event.type === 'control_request') {
      const cr = event as any;
      const toolUse = cr.request?.tool_use;
      if (toolUse) {
        return { type: 'tool_use', id: toolUse.id || cr.uuid, name: toolUse.name, input: toolUse.input || {} };
      }
    }
    return null;
  }

  private emitAgentError(dispatch: DispatchInfo, exitCode: number): void {
    const errorContent = { type: 'text' as const, text: `**Agent error**: ${dispatch.agentFamily} exited with code ${exitCode}. The agent may have encountered an internal error, rate limit, or invalid session.` };

    const runMsg: PromptEvent = {
      type: 'run_msg',
      runId: dispatch.runId,
      role: 'assistant',
      content: errorContent,
    };
    appendPromptEvent(this.sessionDir, dispatch.promptUuid, runMsg);

    // Also emit as wire message
    const wireMsg: WireMessage = {
      id: uuidv4(),
      sessionId: this.sessionId,
      timestamp: Date.now(),
      type: 'assistant_message',
      text: errorContent.text,
      _parentToolUseId: dispatch.dispatchId,
      _agentId: dispatch.agentKey,
    } as any;
    this.wireMessages.push(wireMsg);
    this.emit('message', wireMsg);
  }

  private updateAgentRunEnd(promptUuid: string, runId: string): void {
    if (!this.session) return;
    const prompt = this.session.prompts[promptUuid];
    const run = prompt?.agents.find(a => a.uuid === runId);
    if (run) {
      run.endedAt = new Date().toISOString();
      writeSession(this.sessionDir, this.session);
    }
  }

  private updatePromptEnd(promptUuid: string): void {
    if (!this.session) return;
    const prompt = this.session.prompts[promptUuid];
    if (prompt) {
      prompt.endedAt = new Date().toISOString();
      writeSession(this.sessionDir, this.session);
    }
  }

  private emitTreeUpdate(): void {
    this.emit('message', {
      type: 'tree_update',
      sessionId: this.sessionId,
      tree: this.session?.tree || [],
      activePath: this.getActivePath(),
      prompts: this.session?.prompts || {},
    });
  }

  /**
   * Rebuild wire messages from the session tree (for session resume).
   */
  private async rebuildWireMessages(): Promise<void> {
    if (!this.session) return;

    const activePath = this.getActivePath();
    const nodes = walkActivePath(this.session.tree, activePath);

    for (const node of nodes) {
      if (node.hidden) continue;

      const prompt = this.session.prompts[node.uuid];
      if (!prompt) continue;

      const events = readPromptEvents(this.sessionDir, node.uuid);

      // Emit user message
      const promptEvent = events.find(e => e.type === 'prompt');
      if (promptEvent && promptEvent.type === 'prompt') {
        const userMsg: WireMessage = {
          id: node.uuid,
          sessionId: this.sessionId,
          timestamp: Date.now(),
          type: 'user_message',
          text: promptEvent.message,
        } as any;
        this.wireMessages.push(userMsg);
      }

      // Emit agent messages
      for (const event of events) {
        if (event.type !== 'run_msg') continue;
        const runMsg = event as any;
        const agentRun = prompt.agents.find(a => a.uuid === runMsg.runId);
        const agentKey = agentRun?.harness || 'unknown';

        if (runMsg.content?.type === 'text') {
          const wireMsg: WireMessage = {
            id: uuidv4(),
            sessionId: this.sessionId,
            timestamp: Date.now(),
            type: 'assistant_message',
            text: runMsg.content.text,
            _parentToolUseId: `${node.uuid}:${agentKey}`,
            _agentId: agentKey,
          } as any;
          this.wireMessages.push(wireMsg);
        } else if (runMsg.content?.type === 'thinking') {
          this.wireMessages.push({
            id: uuidv4(),
            sessionId: this.sessionId,
            timestamp: Date.now(),
            type: 'thinking',
            text: runMsg.content.thinking,
            _parentToolUseId: `${node.uuid}:${agentKey}`,
            _agentId: agentKey,
          } as any);
        } else if (runMsg.content?.type === 'tool_use') {
          this.pendingToolUses.set(runMsg.content.id, {
            name: runMsg.content.name,
            input: runMsg.content.input || {},
          });
          this.wireMessages.push({
            id: runMsg.content.id,
            sessionId: this.sessionId,
            timestamp: Date.now(),
            type: 'tool_result',
            requestId: runMsg.content.id,
            toolName: runMsg.content.name,
            input: runMsg.content.input || {},
            output: '',
            isError: false,
            isPending: true,
            _parentToolUseId: `${node.uuid}:${agentKey}`,
            _agentId: agentKey,
          } as any);
        } else if (runMsg.content?.type === 'tool_result') {
          const toolUse = this.pendingToolUses.get(runMsg.content.tool_use_id);
          this.wireMessages.push({
            id: uuidv4(),
            sessionId: this.sessionId,
            timestamp: Date.now(),
            type: 'tool_result',
            requestId: runMsg.content.tool_use_id,
            toolName: toolUse?.name || 'unknown',
            input: toolUse?.input,
            output: typeof runMsg.content.content === 'string'
              ? runMsg.content.content.substring(0, 5000)
              : '',
            isError: !!runMsg.content.is_error,
            _parentToolUseId: `${node.uuid}:${agentKey}`,
            _agentId: agentKey,
          } as any);
          this.pendingToolUses.delete(runMsg.content.tool_use_id);
        }
      }
    }

    console.log(`[atoo-any-v2] Rebuilt ${this.wireMessages.length} wire messages for ${this.session.uuid}`);
  }

  /**
   * Build conversation history as flat SessionEvents for CLI consumption.
   * Walks the active path and converts prompt events back to SessionEvents.
   */
  private buildConversationHistory(preferFamily: AgentFamily): SessionEvent[] {
    if (!this.session) return [];

    const activePath = this.getActivePath();
    const nodes = walkActivePath(this.session.tree, activePath);
    const result: SessionEvent[] = [];

    for (const node of nodes) {
      if (node.hidden) continue;
      // Skip the current prompt (last one, being dispatched right now)
      if (node.uuid === this.currentPromptUuid) continue;

      const prompt = this.session.prompts[node.uuid];
      if (!prompt) continue;

      const events = readPromptEvents(this.sessionDir, node.uuid);
      const promptEvent = events.find(e => e.type === 'prompt');
      if (!promptEvent || promptEvent.type !== 'prompt') continue;

      // User message
      const userEvent: SessionEvent = {
        type: 'user',
        uuid: node.uuid,
        timestamp: prompt.startedAt,
        message: { role: 'user', content: promptEvent.message },
      };
      result.push(userEvent);

      // Agent responses: preferred family first, then others
      const preferred: SessionEvent[] = [];
      const others: SessionEvent[] = [];
      const otherTexts: string[] = [];

      for (const event of events) {
        if (event.type !== 'run_msg') continue;
        const rm = event as any;
        const run = prompt.agents.find(a => a.uuid === rm.runId);
        const family = (run?.harness || '').replace('-code', '').replace('-cli', '') as AgentFamily;

        if (rm.role === 'assistant' && rm.content?.type === 'text') {
          const assistantEvent: SessionEvent = {
            type: 'assistant',
            uuid: uuidv4(),
            timestamp: prompt.startedAt,
            message: { role: 'assistant', content: [rm.content] },
          };
          if (family === preferFamily) {
            preferred.push(assistantEvent);
          } else {
            others.push(assistantEvent);
            const label = AGENT_LABELS[family] || family;
            otherTexts.push(`${label}: ${rm.content.text}`);
          }
        } else if (rm.role === 'assistant' && rm.content?.type === 'tool_use') {
          const assistantEvent: SessionEvent = {
            type: 'assistant',
            uuid: uuidv4(),
            timestamp: prompt.startedAt,
            message: { role: 'assistant', content: [rm.content] },
          };
          if (family === preferFamily) preferred.push(assistantEvent);
        } else if (rm.role === 'tool_result' && rm.content?.type === 'tool_result') {
          const toolResultEvent: SessionEvent = {
            type: 'user',
            uuid: uuidv4(),
            timestamp: prompt.startedAt,
            isSynthetic: true,
            message: { role: 'user', content: [rm.content] },
          };
          if (family === preferFamily) preferred.push(toolResultEvent);
        }
      }

      // Inject other agents' responses as context in the user message
      if (otherTexts.length > 0) {
        const contextBlock = `\n\n[Other agents responded to this message:]\n${otherTexts.join('\n\n')}`;
        (userEvent as any).message.content += contextBlock;
      }

      result.push(...preferred);
    }

    return result;
  }

  /**
   * Build flat SessionEvents from the tree (for backward compat).
   */
  private buildFlatSessionEvents(): SessionEvent[] {
    if (!this.session) return [];
    const activePath = this.getActivePath();
    const nodes = walkActivePath(this.session.tree, activePath);
    const result: SessionEvent[] = [];

    for (const node of nodes) {
      const events = readPromptEvents(this.sessionDir, node.uuid);
      for (const event of events) {
        if (event.type === 'prompt') {
          result.push({
            type: 'user',
            uuid: node.uuid,
            timestamp: event.timestamp,
            message: { role: 'user', content: event.message },
          });
        }
      }
    }
    return result;
  }

  private injectHistoryAttachments(events: SessionEvent[]): void {
    // TODO: Implement blob-based attachment injection for dispatch
  }

  private writeAttachmentTempFiles(promptUuid: string, attachments?: AgentAttachment[]): string[] {
    if (!attachments || attachments.length === 0) return [];

    const tmpDir = path.join(os.tmpdir(), 'atoo-any-attachments', this.session!.uuid, promptUuid);
    fs.mkdirSync(tmpDir, { recursive: true });

    const paths: string[] = [];
    for (const att of attachments) {
      const filename = att.name || `attachment-${paths.length + 1}`;
      const filePath = path.join(tmpDir, filename);

      if (att.text) {
        fs.writeFileSync(filePath, att.text, 'utf-8');
      } else if (att.data) {
        const base64 = att.data.includes(',') ? att.data.split(',')[1] : att.data;
        fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      }
      paths.push(filePath);
    }
    return paths;
  }

  private getCapabilities(): AgentCapabilities {
    return {
      canChangeMode: false,
      canChangeModel: false,
      hasContextUsage: false,
      canFork: true,
      canResume: true,
      hasTerminal: false,
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
