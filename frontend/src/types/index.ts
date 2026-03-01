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
