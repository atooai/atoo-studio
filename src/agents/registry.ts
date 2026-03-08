import type WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type { Agent, AgentFactory, AgentSessionInfo, AgentInitOptions, AbstractMessage, AgentStatus, AgentDescriptor, HistoricalSession } from './types.js';
import { store } from '../state/store.js';
import { vccDb } from '../state/db.js';

interface AgentEntry {
  agent: Agent;
  agentType: string;
  browserClients: Set<WebSocket>;
  contextInProgress: boolean;
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
    };

    this.agents.set(sessionId, entry);

    // Wire up event forwarding
    agent.on('message', (msg: AbstractMessage) => {
      this.broadcastToClients(sessionId, msg);
    });

    agent.on('status', (status: AgentStatus) => {
      // Broadcast status to global status clients (sidebar)
      const storeStatus = status === 'active' ? 'active' : status === 'waiting' ? 'waiting' : 'idle';
      store.setAgentStatus(sessionId, storeStatus as any);
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

    // Close all browser WS connections
    for (const ws of entry.browserClients) {
      try { ws.close(); } catch {}
    }
    entry.browserClients.clear();

    await entry.agent.destroy();
    this.agents.delete(sessionId);
    console.log(`[agent-registry] Agent destroyed: ${sessionId}`);
  }

  listAgents(): AgentSessionInfo[] {
    const infos: AgentSessionInfo[] = [];
    for (const entry of this.agents.values()) {
      infos.push(entry.agent.getInfo());
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
    // Deduplicate by session ID (multiple factories may share the same scanner)
    const seen = new Set<string>();
    let unique = allSessions.filter(s => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
    // Filter by project path (includes main project + all worktree paths)
    if (cwd) {
      const relatedPaths = new Set(vccDb.getAllRelatedProjectPaths(cwd));
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
    const relatedPaths = vccDb.getAllRelatedProjectPaths(cwd);

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

  async resumeAgent(sessionUuid: string, options: { cwd?: string; skipPermissions?: boolean } = {}): Promise<Agent> {
    // Find the factory that owns this session
    let owningFactory: AgentFactory | null = null;
    for (const factory of this.factories.values()) {
      if (await factory.ownsSession(sessionUuid)) {
        owningFactory = factory;
        break;
      }
    }
    if (!owningFactory) {
      throw new Error(`No agent implementation recognizes session ${sessionUuid}`);
    }

    const sessionId = `agent_${uuidv4()}`;
    return this.createAgent(owningFactory.agentType, sessionId, {
      ...options,
      resumeSessionUuid: sessionUuid,
    });
  }

  private broadcastToClients(sessionId: string, message: AbstractMessage): void {
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
