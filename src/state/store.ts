import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type {
  Environment,
  Session,
  SessionEvent,
  WorkItem,
  PendingPoll,
  WorkResponse,
} from './types.js';
import type WebSocket from 'ws';

export type AgentStatus = 'open' | 'active' | 'attention';

class Store {
  environments = new Map<string, Environment>();
  sessions = new Map<string, Session>();
  workItems = new Map<string, WorkItem>();
  pendingPolls = new Map<string, PendingPoll>();
  agentStatuses = new Map<string, AgentStatus>(); // sessionId → status
  contextUsages = new Map<string, { model: string; usedTokens: number; totalTokens: number; percent: number; freePercent: number }>(); // sessionId → token usage
  contextInProgressSessions = new Set<string>(); // sessions currently running /context flow
  pendingIngressResponses = new Map<string, any[]>(); // sessionId → queued control_responses for HTTP delivery

  // WebSocket connections
  ingressClients = new Map<string, WebSocket>(); // sessionId → CLI WS
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

  registerEnvironment(body: {
    machine_name: string;
    directory: string;
    branch?: string;
    git_repo_url?: string;
  }): Environment {
    const id = `env_${uuidv4()}`;
    const secret = `es_${crypto.randomBytes(32).toString('hex')}`;
    const env: Environment = {
      id,
      secret,
      machineName: body.machine_name,
      directory: body.directory,
      branch: body.branch ?? null,
      gitRepoUrl: body.git_repo_url ?? null,
      registeredAt: new Date(),
    };
    this.environments.set(id, env);
    console.log(`[store] Environment registered: ${id} (${body.machine_name}:${body.directory})`);
    return env;
  }

  deregisterEnvironment(id: string): boolean {
    const deleted = this.environments.delete(id);
    if (deleted) console.log(`[store] Environment deregistered: ${id}`);
    return deleted;
  }

  findEnvironmentBySecret(secret: string): Environment | undefined {
    for (const env of this.environments.values()) {
      if (env.secret === secret) return env;
    }
    return undefined;
  }

  createSession(body: {
    title?: string;
    events?: any[];
    session_context?: any;
    environment_id: string;
    source?: string;
    permission_mode?: string;
    fs_uuid?: string;
  }): Session {
    const id = `sess_${uuidv4()}`;
    const session: Session = {
      id,
      title: body.title || 'Untitled',
      environmentId: body.environment_id,
      status: 'active',
      events: body.events?.map((e) => e.data ?? e) ?? [],
      createdAt: new Date(),
      source: body.source || 'remote-control',
      permissionMode: body.permission_mode,
      fsUuid: body.fs_uuid,
    };
    this.sessions.set(id, session);
    console.log(`[store] Session created: ${id} for env ${body.environment_id}`);

    // Broadcast to all status listeners so other browsers discover the new session
    const env = this.environments.get(body.environment_id);
    console.log(`[store] Broadcasting session_created to ${this.statusClients.size} status clients (dir: ${env?.directory || 'null'})`);
    const msg = JSON.stringify({
      type: 'session_created',
      session: {
        id,
        title: session.title,
        status: session.status,
        environment_id: body.environment_id,
        directory: env?.directory || null,
        created_at: session.createdAt.toISOString(),
      },
    });
    for (const ws of this.statusClients) {
      if (ws.readyState === 1) ws.send(msg);
    }

    return session;
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

  createWorkItem(sessionId: string, environmentId: string): WorkItem {
    const workId = `work_${uuidv4()}`;
    const ingressToken = this.generateIngressToken(sessionId);
    const secretPayload = {
      version: 1,
      session_ingress_token: ingressToken,
      api_base_url: 'https://api.anthropic.com',
    };
    const secret = Buffer.from(JSON.stringify(secretPayload)).toString('base64url');
    const work: WorkItem = {
      id: workId,
      environmentId,
      sessionId,
      status: 'pending',
      secret,
    };
    this.workItems.set(workId, work);
    console.log(`[store] Work item created: ${workId} for session ${sessionId}`);
    return work;
  }

  getWorkResponse(work: WorkItem): WorkResponse {
    return {
      id: work.id,
      data: { type: 'session', id: work.sessionId },
      secret: work.secret,
    };
  }

  resolvePendingPoll(environmentId: string, response: WorkResponse): boolean {
    const poll = this.pendingPolls.get(environmentId);
    if (poll) {
      clearTimeout(poll.timer);
      this.pendingPolls.delete(environmentId);
      poll.resolve(response);
      return true;
    }
    return false;
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

  forwardToIngress(sessionId: string, message: any): void {
    // Send via WS
    const ws = this.ingressClients.get(sessionId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message) + '\n');
    }
    // Also queue for HTTP delivery (CLI's HybridTransport may read responses from POST replies)
    if (!this.pendingIngressResponses.has(sessionId)) {
      this.pendingIngressResponses.set(sessionId, []);
    }
    this.pendingIngressResponses.get(sessionId)!.push(message);
  }

  /** Drain pending responses queued for a session (used by HTTP POST handler). */
  drainPendingIngressResponses(sessionId: string): any[] {
    const pending = this.pendingIngressResponses.get(sessionId);
    if (!pending || pending.length === 0) return [];
    this.pendingIngressResponses.delete(sessionId);
    return pending;
  }

  private generateIngressToken(sessionId: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: sessionId,
        exp: Math.floor(Date.now() / 1000) + 86400,
        iat: Math.floor(Date.now() / 1000),
      })
    ).toString('base64url');
    const signature = crypto
      .createHmac('sha256', 'atoo-studio-local-secret')
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `sk-ant-si-${header}.${payload}.${signature}`;
  }
}

export const store = new Store();
