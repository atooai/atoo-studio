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
  contextUsages = new Map<string, { model: string; usedTokens: number; totalTokens: number; percent: number; freePercent: number }>(); // sessionId → token usage

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

  setContextUsage(sessionId: string, usage: { model: string; usedTokens: number; totalTokens: number; percent: number; freePercent: number }): void {
    this.contextUsages.set(sessionId, usage);
    const msg = { type: 'context_usage', session_id: sessionId, ...usage };
    const data = JSON.stringify(msg);
    for (const ws of this.statusClients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  forwardToIngress(sessionId: string, message: any): void {
    const ws = this.ingressClients.get(sessionId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message) + '\n'); // NDJSON
    }
  }

  /**
   * Fork a session at a given event UUID.
   * Copies events up to (inclusive) the specified event, handling tool_use boundary integrity.
   * Generates a forked session ID that encodes parent lineage.
   */
  forkSession(parentId: string, afterEventUuid: string): Session {
    const parent = this.sessions.get(parentId);
    if (!parent) throw new Error(`Parent session not found: ${parentId}`);

    // Find the fork-point event index
    const forkIdx = parent.events.findIndex((e) => e.uuid === afterEventUuid);
    if (forkIdx === -1) throw new Error(`Event UUID not found: ${afterEventUuid}`);

    // Copy events up to fork point (inclusive)
    let events = parent.events.slice(0, forkIdx + 1);

    // Event boundary integrity: if the last event is an assistant message with tool_use blocks,
    // include the corresponding tool_result user events and any child events
    const lastEvent = events[events.length - 1];
    if (lastEvent?.type === 'assistant' && Array.isArray(lastEvent.message?.content)) {
      const toolUseIds = lastEvent.message.content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => b.id);

      if (toolUseIds.length > 0) {
        // Scan remaining parent events for tool_results and child events
        for (let i = forkIdx + 1; i < parent.events.length; i++) {
          const ev = parent.events[i];
          // Include child events (sub-agent)
          if (ev.parent_tool_use_id && toolUseIds.includes(ev.parent_tool_use_id)) {
            events.push(ev);
            continue;
          }
          // Include user events containing tool_result for our tool_use ids
          if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
            const hasMatchingResult = ev.message.content.some(
              (item: any) => item.type === 'tool_result' && toolUseIds.includes(item.tool_use_id)
            );
            if (hasMatchingResult) {
              events.push(ev);
              continue;
            }
          }
        }
      }
    }

    // Generate forked session ID using parent-ID-linking scheme
    // Extract last 16 hex chars from parent UUID portion
    const parentUuidPart = parentId.replace('sess_', '');
    const parentHex = parentUuidPart.replace(/-/g, '');
    const last16 = parentHex.slice(-16);

    // Build new UUID: first 16 hex = parent's last 16, rest is random
    const randomPart = crypto.randomBytes(16).toString('hex');
    const newHex = last16 + randomPart.slice(16);
    // Format as UUID: 8-4-4-4-12
    const newUuid = [
      newHex.slice(0, 8),
      newHex.slice(8, 12),
      newHex.slice(12, 16),
      newHex.slice(16, 20),
      newHex.slice(20, 32),
    ].join('-');
    const forkedId = `sess_${newUuid}`;

    const session: Session = {
      id: forkedId,
      title: `Fork of ${parent.title}`,
      environmentId: parent.environmentId,
      status: 'active',
      events: events.map((e) => ({ ...e })), // shallow copy each event
      createdAt: new Date(),
      source: 'fork',
      permissionMode: parent.permissionMode,
      parentSessionId: parentId,
      forkAfterEventUuid: afterEventUuid,
    };

    this.sessions.set(forkedId, session);
    console.log(`[store] Forked session ${forkedId} from ${parentId} at event ${afterEventUuid}`);
    return session;
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
