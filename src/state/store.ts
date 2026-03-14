import type {
  Session,
  SessionEvent,
} from './types.js';
import type WebSocket from 'ws';

export type AgentStatus = 'open' | 'active' | 'attention';

class Store {
  sessions = new Map<string, Session>();
  agentStatuses = new Map<string, AgentStatus>(); // sessionId → status
  contextUsages = new Map<string, { model: string; usedTokens: number; totalTokens: number; percent: number; freePercent: number }>(); // sessionId → token usage
  contextInProgressSessions = new Set<string>(); // sessions currently running /context flow

  // WebSocket connections
  statusClients = new Set<WebSocket>(); // global status listeners

  // Event listeners for agent layer
  private eventListeners = new Map<string, Set<(event: any) => void>>();

  /**
   * Subscribe to ingress events for a session. Returns an unsubscribe function.
   */
  addEventListener(sessionId: string, cb: (event: any) => void): () => void {
    if (!this.eventListeners.has(sessionId)) {
      this.eventListeners.set(sessionId, new Set());
    }
    this.eventListeners.get(sessionId)!.add(cb);
    return () => {
      this.eventListeners.get(sessionId)?.delete(cb);
      if (this.eventListeners.get(sessionId)?.size === 0) {
        this.eventListeners.delete(sessionId);
      }
    };
  }

  /** Notify event listeners for a session. */
  notifyEventListeners(sessionId: string, event: any): void {
    const listeners = this.eventListeners.get(sessionId);
    if (!listeners) return;
    for (const cb of listeners) {
      try { cb(event); } catch (err) {
        console.error(`[store] Event listener error for ${sessionId}:`, err);
      }
    }
  }

  addEvent(sessionId: string, event: SessionEvent): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    // Deduplicate by UUID
    if (event.uuid && session.events.some((e) => e.uuid === event.uuid)) {
      return false;
    }
    session.events.push(event);
    // Notify event listeners (agent layer)
    this.notifyEventListeners(sessionId, event);
    return true;
  }

  setAgentStatus(sessionId: string, status: AgentStatus): void {
    const prev = this.agentStatuses.get(sessionId);
    if (prev === status) return;
    this.agentStatuses.set(sessionId, status);
    const msg = { type: 'agent_status', status, session_id: sessionId };
    // Broadcast to global status listeners (sidebar)
    const data = JSON.stringify(msg);
    for (const ws of this.statusClients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  removeAgentStatus(sessionId: string): void {
    this.agentStatuses.delete(sessionId);
    this.contextInProgressSessions.delete(sessionId);
    this.contextUsages.delete(sessionId);
    // Broadcast 'exited' so frontends remove the session from active state
    const msg = { type: 'agent_status', status: 'exited', session_id: sessionId };
    const data = JSON.stringify(msg);
    for (const ws of this.statusClients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  getAgentStatus(sessionId: string): AgentStatus {
    return this.agentStatuses.get(sessionId) || 'open';
  }

  setContextInProgress(sessionId: string, inProgress: boolean): void {
    if (inProgress) {
      this.contextInProgressSessions.add(sessionId);
    } else {
      this.contextInProgressSessions.delete(sessionId);
    }
    const listeners = this.eventListeners.get(sessionId);
    console.log(`[store] setContextInProgress(${sessionId}, ${inProgress}) — eventListeners=${listeners?.size ?? 0}, statusClients=${this.statusClients.size}`);
    const msg = { type: 'context_in_progress', session_id: sessionId, inProgress };
    // Notify agent event listeners so the adapter can re-emit with agent session ID
    this.notifyEventListeners(sessionId, msg);
    const data = JSON.stringify(msg);
    for (const ws of this.statusClients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  setContextUsage(sessionId: string, usage: { model: string; usedTokens: number; totalTokens: number; percent: number; freePercent: number }): void {
    this.contextUsages.set(sessionId, usage);
    const msg = { type: 'context_usage', session_id: sessionId, ...usage };
    const data = JSON.stringify(msg);
    for (const ws of this.statusClients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

}

export const store = new Store();
