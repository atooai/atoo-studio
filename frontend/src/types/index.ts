export interface Environment {
  id: string;
  machine_name: string;
  directory: string;
  branch: string | null;
  registered_at: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: string;
  environment_id: string;
  directory: string | null;
  agent_status: 'idle' | 'active' | 'waiting';
  created_at: string;
  event_count: number;
  parent_session_id: string | null;
  fork_after_event_uuid: string | null;
  change_count?: number;
  fs_uuid?: string | null;
}

export interface FsSessionMeta {
  uuid: string;
  dirHash: string;
  directory: string;
  title: string;
  lastModified: string;
  fileSize: number;
  eventCount: number;
  jsonlPath: string;
}

export type ChangeOperation = 'create' | 'modify' | 'delete' | 'rename';

export interface FileChange {
  change_id: string;
  session_id: string;
  timestamp: number;
  pid: number;
  operation: ChangeOperation;
  path: string;
  old_path: string | null;
  before_hash: string | null;
  after_hash: string | null;
  file_size: number;
  is_binary: boolean;
}

export interface DiffData {
  operation: ChangeOperation;
  path: string;
  old_path: string | null;
  before: string | null;   // base64
  after: string | null;    // base64
  is_binary: boolean;
  file_size: number;
  before_hash: string | null;
  after_hash: string | null;
  timestamp: number;
}

export interface SessionEvent {
  uuid?: string;
  type: string;
  session_id?: string;
  message?: { role: string; content: any };
  request?: { subtype: string; [key: string]: any };
  response?: any;
  [key: string]: any;
}

export interface ProxyStatus {
  environments: number;
  sessions: number;
  active_ingress: number;
  active_subscribers: number;
}
