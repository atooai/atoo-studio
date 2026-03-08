import type { SessionEvent } from '../events/types.js';

export type { SessionEvent } from '../events/types.js';

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
  fsUuid?: string;
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
