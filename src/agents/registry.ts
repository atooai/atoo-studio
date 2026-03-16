import type WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type { Agent, AgentFactory, AgentSessionInfo, AgentInitOptions, AgentDescriptor, HistoricalSession, LinkedIssueInfo } from './types.js';
import type { SessionEvent } from '../events/types.js';
import type { WireMessage } from '../events/wire.js';
import { store } from '../state/store.js';
import { db } from '../state/db.js';
import { buildChainSession } from './lib/chain-builder.js';
import { fsSessionScanner } from './lib/claude/fs-sessions.js';

interface BrowserState {
  linkedIssue?: LinkedIssueInfo;
  viewMode?: string;
  showVerbose?: boolean;
  title?: string;
  metaName?: string;
  metaDescription?: string;
  tags?: string[];
}

interface AgentEntry {
  agent: Agent;
  agentType: string;
  browserClients: Set<WebSocket>;
  contextInProgress: boolean;
  browserState: BrowserState;
}

class AgentRegistry {
  private factories = new Map<string, AgentFactory>();
  private agents = new Map<string, AgentEntry>();

  registerFactory(factory: AgentFactory): void {
    this.factories.set(factory.agentType, factory);
    console.log(`[agent-registry] Registered factory: ${factory.agentType}`);
  }

  async createAgent(agentType: string, sessionId: string, options: AgentInitOptions): Promise<Agent> {
    const factory = this.factories.get(agentType);
    if (!factory) {
      throw new Error(`Unknown agent type: ${agentType}`);
    }

    const agent = factory.create(sessionId);
    const entry: AgentEntry = {
      agent,
      agentType,
      browserClients: new Set(),
      contextInProgress: false,
      browserState: {},
    };

    this.agents.set(sessionId, entry);

    // Wire up event forwarding
    agent.on('message', (msg: WireMessage) => {
      this.broadcastToClients(sessionId, msg);
    });

    // Forward agent status to the global store for WebSocket broadcasting.
    // Each agent adapter owns its activity status (open/active/attention).
    agent.on('status', (status: string) => {
      if (status === 'exited') return; // handled by destroyAgent
      store.setAgentStatus(sessionId, status as any);
    });

    agent.on('context_in_progress', (inProgress: boolean) => {
      const e = this.agents.get(sessionId);
      if (e) e.contextInProgress = inProgress;
      this.broadcastRawToClients(sessionId, { type: 'context_in_progress', inProgress });
    });

    agent.on('exit', () => {
      console.log(`[agent-registry] Agent exited: ${sessionId}`);
    });

    agent.on('error', (err: Error) => {
      console.error(`[agent-registry] Agent error for ${sessionId}:`, err.message);
    });

    // Initialize the agent
    await agent.initialize(options);

    console.log(`[agent-registry] Agent created: ${sessionId} (type: ${agentType})`);
    return agent;
  }

  getAgent(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId)?.agent;
  }

  async destroyAgent(sessionId: string): Promise<void> {
    const entry = this.agents.get(sessionId);
    if (!entry) return;

    // Remove all event listeners BEFORE destroying to prevent
    // late status broadcasts from reviving the session in the UI
    entry.agent.removeAllListeners();

    // Close all browser WS connections
    for (const ws of entry.browserClients) {
      try { ws.close(); } catch {}
    }
    entry.browserClients.clear();

    await entry.agent.destroy();
    this.agents.delete(sessionId);

    // Clean up status from the global store and broadcast removal
    store.removeAgentStatus(sessionId);

    console.log(`[agent-registry] Agent destroyed: ${sessionId}`);
  }

  setSessionFocused(sessionId: string): void {
    this.agents.get(sessionId)?.agent.onFocused();
  }

  setSessionBlurred(sessionId: string): void {
    this.agents.get(sessionId)?.agent.onBlurred();
  }

  setBrowserState(sessionId: string, state: Partial<BrowserState>): void {
    const entry = this.agents.get(sessionId);
    if (entry) Object.assign(entry.browserState, state);
  }

  getBrowserState(sessionId: string): BrowserState | undefined {
    return this.agents.get(sessionId)?.browserState;
  }

  listAgents(): (AgentSessionInfo & { browserState?: BrowserState })[] {
    const infos: (AgentSessionInfo & { browserState?: BrowserState })[] = [];
    for (const entry of this.agents.values()) {
      const info = entry.agent.getInfo();
      if (entry.browserState.linkedIssue) info.linkedIssue = entry.browserState.linkedIssue;
      infos.push({ ...info, browserState: entry.browserState });
    }
    return infos;
  }

  addBrowserClient(sessionId: string, ws: WebSocket): void {
    const entry = this.agents.get(sessionId);
    if (!entry) return;
    entry.browserClients.add(ws);
    // Send current context_in_progress state so late-joining browsers get it
    if (entry.contextInProgress) {
      ws.send(JSON.stringify({ type: 'context_in_progress', inProgress: true }));
    }
  }

  removeBrowserClient(sessionId: string, ws: WebSocket): void {
    const entry = this.agents.get(sessionId);
    if (!entry) return;
    entry.browserClients.delete(ws);
  }

  getAvailableAgents(): AgentDescriptor[] {
    const descriptors: AgentDescriptor[] = [];
    for (const factory of this.factories.values()) {
      descriptors.push(factory.getDescriptor());
    }
    return descriptors;
  }

  async getHistoricalSessions(cwd?: string): Promise<HistoricalSession[]> {
    const allSessions: HistoricalSession[] = [];
    for (const factory of this.factories.values()) {
      const sessions = await factory.getHistoricalSessions();
      allSessions.push(...sessions);
    }
    // Deduplicate by session ID — when same UUID exists across factories, keep the most recent
    const bestById = new Map<string, HistoricalSession>();
    for (const s of allSessions) {
      const existing = bestById.get(s.id);
      if (!existing || new Date(s.lastModified).getTime() > new Date(existing.lastModified).getTime()) {
        bestById.set(s.id, s);
      }
    }
    let unique = Array.from(bestById.values());
    // Filter by project path (includes main project + all worktree paths)
    if (cwd) {
      const relatedPaths = new Set(db.getAllRelatedProjectPaths(cwd));
      unique = unique.filter(s => relatedPaths.has(s.directory));
    }
    // Sort by date descending (most recent first)
    unique.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
    return unique;
  }

  /**
   * Collect all session JSONL file paths for a project directory,
   * deduplicated across all registered agent factories.
   * Resolves related paths (main project + all worktrees, current and historical)
   * so that searching from any worktree or the main project returns the full history.
   */
  async getSessionFilesForProject(cwd: string): Promise<string[]> {
    // Resolve all related project paths (main + worktrees, current and historical)
    const relatedPaths = db.getAllRelatedProjectPaths(cwd);

    const seen = new Set<string>();
    const allFiles: string[] = [];
    for (const factory of this.factories.values()) {
      const files = await factory.getSessionFilesForProject(relatedPaths);
      for (const f of files) {
        if (!seen.has(f)) {
          seen.add(f);
          allFiles.push(f);
        }
      }
    }
    return allFiles;
  }

  async resumeAgent(sessionUuid: string, options: { cwd?: string; skipPermissions?: boolean; agentType?: string } = {}): Promise<Agent> {
    // Find the factory that owns this session
    let sourceFactory: AgentFactory | null = null;
    for (const factory of this.factories.values()) {
      if (await factory.ownsSession(sessionUuid)) {
        sourceFactory = factory;
        break;
      }
    }
    if (!sourceFactory) {
      throw new Error(`No agent implementation recognizes session ${sessionUuid}`);
    }

    // Determine target factory (requested agentType or same as source)
    const targetAgentType = options.agentType || sourceFactory.agentType;
    const targetFactory = this.factories.get(targetAgentType);
    if (!targetFactory) {
      throw new Error(`Unknown agent type: ${targetAgentType}`);
    }

    let resumeUuid = sessionUuid;
    let isChainContinuation = false;

    // Cross-family resume: create a chain link instead of reusing the same UUID.
    // This keeps each session file unambiguously one agent family and preserves
    // the parent→child link via the session ID schema.
    if (sourceFactory.agentFamily !== targetFactory.agentFamily) {
      const events = await sourceFactory.readSessionEvents(sessionUuid);
      if (!events.length) {
        throw new Error(`No events found in session ${sessionUuid} for cross-family conversion`);
      }
      const cwd = options.cwd || '.';
      const { buildLinkedUuid } = await import('./lib/session-id-utils.js');
      const chainUuid = buildLinkedUuid(sessionUuid, 'chain');
      targetFactory.writeSessionForResume(events, chainUuid, cwd);
      resumeUuid = chainUuid;
      isChainContinuation = true;
    }

    const sessionId = `agent_${uuidv4()}`;
    return this.createAgent(targetFactory.agentType, sessionId, {
      cwd: options.cwd,
      skipPermissions: options.skipPermissions,
      resumeSessionUuid: resumeUuid,
      isChainContinuation,
    });
  }

  /**
   * Create a new chain link from an existing session.
   * Carries forward user messages + last N events, generates a chain-linked UUID.
   * The new session can search previous chain links via CurrentSessionChain.
   */
  async chainAgent(sessionUuid: string, options: { cwd?: string; skipPermissions?: boolean; agentType?: string } = {}): Promise<Agent> {
    // Find the factory that owns the source session.
    // Invalidate caches first since we may be chaining from a still-running session
    // whose JSONL has grown since the last scan.
    fsSessionScanner.invalidate();
    let sourceFactory: AgentFactory | null = null;
    for (const factory of this.factories.values()) {
      if (await factory.ownsSession(sessionUuid)) {
        sourceFactory = factory;
        break;
      }
    }
    if (!sourceFactory) {
      throw new Error(`No agent implementation recognizes session ${sessionUuid}`);
    }

    // Read events from the source session (file is up-to-date since CLIs write incrementally)
    const events = await sourceFactory.readSessionEvents(sessionUuid);
    if (!events.length) {
      throw new Error(`No events found in session ${sessionUuid} for chain creation`);
    }

    // Determine target factory
    const targetAgentType = options.agentType || sourceFactory.agentType;
    const targetFactory = this.factories.get(targetAgentType);
    if (!targetFactory) {
      throw new Error(`Unknown agent type: ${targetAgentType}`);
    }

    const cwd = options.cwd || '.';

    // Build chain events + UUID (does not write to disk)
    const chain = buildChainSession(events, sessionUuid);
    if (!chain) {
      throw new Error(`Session has no conversation content to chain — try sending a message first`);
    }

    // Write in the target agent's native format
    targetFactory.writeSessionForResume(chain.events, chain.uuid, cwd);

    const sessionId = `agent_${uuidv4()}`;
    return this.createAgent(targetFactory.agentType, sessionId, {
      cwd: options.cwd,
      skipPermissions: options.skipPermissions,
      resumeSessionUuid: chain.uuid,
      isChainContinuation: true,
    });
  }

  /**
   * Create a chain link from in-memory events (for active agents).
   * Bypasses the FS scanner — events come directly from the live agent.
   */
  async chainFromEvents(
    events: SessionEvent[],
    parentSessionId: string,
    options: { cwd?: string; skipPermissions?: boolean; agentType?: string } = {},
  ): Promise<Agent> {
    if (!events.length) {
      throw new Error('No events provided for chain creation');
    }

    // Determine target factory
    const targetAgentType = options.agentType || 'claude-code-terminal-chatro';
    const targetFactory = this.factories.get(targetAgentType);
    if (!targetFactory) {
      throw new Error(`Unknown agent type: ${targetAgentType}`);
    }

    const cwd = options.cwd || '.';

    // Build chain events + UUID (does not write to disk)
    const chain = buildChainSession(events, parentSessionId);
    if (!chain) {
      throw new Error('Session has no conversation content to chain — try sending a message first');
    }

    // Write in the target agent's native format
    targetFactory.writeSessionForResume(chain.events, chain.uuid, cwd);

    const sessionId = `agent_${uuidv4()}`;
    return this.createAgent(targetFactory.agentType, sessionId, {
      cwd: options.cwd,
      skipPermissions: options.skipPermissions,
      resumeSessionUuid: chain.uuid,
      isChainContinuation: true,
    });
  }

  /**
   * Convert a fork JSONL (always written in Claude format by forkToResumable)
   * to the target agent's native format if cross-family.
   * Returns the UUID to use for resume (same UUID, but file now in target format).
   */
  async convertForkForAgent(forkUuid: string, sourceAgentType: string, targetAgentType: string, cwd: string): Promise<string> {
    const sourceFactory = this.factories.get(sourceAgentType);
    const targetFactory = this.factories.get(targetAgentType);
    if (!sourceFactory || !targetFactory) return forkUuid;
    if (sourceFactory.agentFamily === targetFactory.agentFamily) return forkUuid;

    // Fork was written as Claude JSONL — read via a Claude factory
    const claudeFactory = [...this.factories.values()].find(f => f.agentFamily === 'claude');
    if (!claudeFactory) return forkUuid;

    const events = await claudeFactory.readSessionEvents(forkUuid);
    if (!events.length) return forkUuid;

    targetFactory.writeSessionForResume(events, forkUuid, cwd);
    return forkUuid;
  }

  private broadcastToClients(sessionId: string, message: WireMessage): void {
    const entry = this.agents.get(sessionId);
    if (!entry) return;
    const data = JSON.stringify(message);
    for (const ws of entry.browserClients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  }

  private broadcastRawToClients(sessionId: string, message: Record<string, any>): void {
    const entry = this.agents.get(sessionId);
    if (!entry) return;
    const data = JSON.stringify(message);
    for (const ws of entry.browserClients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  }
}

export const agentRegistry = new AgentRegistry();
