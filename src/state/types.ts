import type { SessionEvent } from '../events/types.js';

export type { SessionEvent } from '../events/types.js';

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
