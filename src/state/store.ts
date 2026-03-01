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

export type AgentStatus = 'idle' | 'active' | 'waiting';

class Store {
  environments = new Map<string, Environment>();
  sessions = new Map<string, Session>();
  workItems = new Map<string, WorkItem>();
  pendingPolls = new Map<string, PendingPoll>();
  agentStatuses = new Map<string, AgentStatus>(); // sessionId → status

  // WebSocket connections
  subscribeClients = new Map<string, Set<WebSocket>>(); // sessionId → browser WSs
  ingressClients = new Map<string, WebSocket>(); // sessionId → CLI WS
  statusClients = new Set<WebSocket>(); // global status listeners

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
    };
    this.sessions.set(id, session);
    console.log(`[store] Session created: ${id} for env ${body.environment_id}`);
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

  broadcastToSubscribers(sessionId: string, message: any): void {
    const clients = this.subscribeClients.get(sessionId);
    if (!clients) return;
    const data = JSON.stringify(message);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  }

  setAgentStatus(sessionId: string, status: AgentStatus): void {
    const prev = this.agentStatuses.get(sessionId);
    if (prev === status) return;
    this.agentStatuses.set(sessionId, status);
    const msg = { type: 'agent_status', status, session_id: sessionId };
    this.broadcastToSubscribers(sessionId, msg);
    // Broadcast to global status listeners (sidebar)
    const data = JSON.stringify(msg);
    for (const ws of this.statusClients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  getAgentStatus(sessionId: string): AgentStatus {
    return this.agentStatuses.get(sessionId) || 'idle';
  }

  forwardToIngress(sessionId: string, message: any): void {
    const ws = this.ingressClients.get(sessionId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message) + '\n'); // NDJSON
    }
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
      .createHmac('sha256', 'ccproxy-local-secret')
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `sk-ant-si-${header}.${payload}.${signature}`;
  }
}

export const store = new Store();
