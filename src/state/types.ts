import type { ServerResponse } from 'http';

export interface Environment {
  id: string;
  secret: string;
  machineName: string;
  directory: string;
  branch: string | null;
  gitRepoUrl: string | null;
  registeredAt: Date;
}

export interface Session {
  id: string;
  title: string;
  environmentId: string;
  status: 'active' | 'archived';
  events: SessionEvent[];
  createdAt: Date;
  source: string;
  permissionMode?: string;
  parentSessionId?: string;
  forkAfterEventUuid?: string;
}

export interface SessionEvent {
  uuid: string;
  session_id: string;
  type: string;
  parent_tool_use_id?: string | null;
  message?: { role: string; content: any };
  [key: string]: any;
}

export interface WorkItem {
  id: string;
  environmentId: string;
  sessionId: string;
  status: 'pending' | 'active' | 'completed';
  secret: string; // base64url-encoded JSON
}

export interface PendingPoll {
  environmentId: string;
  resolve: (work: WorkResponse | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface WorkResponse {
  id: string;
  data: { type: string; id: string };
  secret: string;
}
