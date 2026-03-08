export type AgentMode = 'terminal' | 'chat' | 'terminal+chat' | 'terminal+chatRO';

export interface AgentDescriptor {
  agentType: string;
  name: string;
  mode: AgentMode;
  iconUrl: string;
}

export interface Environment {
  id: string;
  name: string;
  project_count?: number;
}

export interface Session {
  id: string;
  title: string;
  status: 'running' | 'waiting' | 'idle' | 'ended';
  startedAt: string;
  messages: ChatMessage[];
  lastMessage: string;
  viewMode: 'chat' | 'tui';
  agentType?: string;
  agentMode?: AgentMode;
  permissionMode: string | null;
  model: string | null;
  cwd?: string;
  showVerbose?: boolean;
  _agentInfo?: any;
  _capabilities?: any;
  _pendingControl?: any;
  _filteredMessages?: FilteredMessage[];
  contextUsage?: ContextUsage;
  contextInProgress?: boolean;
  activeSessionIdx?: number;
}

export interface ContextUsage {
  model: string;
  usedTokens: number;
  totalTokens: number;
  percent: number;
  freePercent: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'thinking' | 'tool' | 'control_request';
  content: any;
  _eventUuid?: string;
  _rawEvent?: any;
  _toolUseId?: string;
  _toolName?: string;
  _toolInput?: any;
  _toolOutput?: string;
  _isError?: boolean;
  _pending?: boolean;
  _requestId?: string;
  _responded?: boolean;
  _response?: string;
  _attachments?: Attachment[];
  _sidechain?: boolean;
  _parentToolUseId?: string;
  _agentId?: string;
}

export interface FilteredMessage extends ChatMessage {
  _idx: number;
  _collapsed: boolean;
  toolCount?: number;
  intermediateCount?: number;
}

export interface Attachment {
  media_type?: string;
  data?: string;
  name?: string;
  kind?: string;
  text?: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  data: string | null;
  text: string | null;
  kind: string | null;
}

export interface GitChange {
  file: string;
  status: string;
  staged?: boolean;
  indexStatus?: string;
  workTreeStatus?: string;
  oldPath?: string;
}

export interface GitCommit {
  hash: string;
  fullHash?: string;
  msg: string;
  fullMessage?: string;
  author: string;
  date: string;
  merge?: boolean;
  refs?: GitRef[];
  files?: GitFile[];
}

export interface GitRef {
  type: 'head' | 'branch' | 'tag' | 'remote';
  label: string;
}

export interface GitFile {
  path: string;
  status: string;
  oldPath?: string;
  additions?: number;
  deletions?: number;
}

export interface GitLog {
  branches: string[];
  currentBranch: string;
  commits: GitCommit[];
  remotes: GitRemote[];
}

export interface GitRemote {
  name: string;
  url: string;
  type?: string;
}

export interface Stash {
  id: string;
  name: string;
}

export interface FileNode {
  name: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

export interface TerminalInfo {
  id: string;
  name: string;
  shellId?: string;
  sessionId?: string;
}

export interface HistoricalSession {
  id: string;
  agentType?: string;
  title: string;
  lastModified: string;
  eventCount: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  pe_id?: string;
  isGit?: boolean;
  ssh_connection_id?: string;
  remote_path?: string;
  parent_project_id?: string | null;
  sessions: Session[];
  files: FileNode[];
  gitChanges: GitChange[];
  gitLog: GitLog;
  terminals: TerminalInfo[];
  stashes: Stash[];
  historicalSessions?: HistoricalSession[];
  activeSessionIdx: number;
  activeTerminalIdx: number;
  _filesLoaded?: boolean;
  _gitLoaded?: boolean;
  _sessionsLoaded?: boolean;
  _terminalsLoaded?: boolean;
}

export interface EditorFile {
  path: string;
  fullPath: string;
  content: string;
  originalContent: string;
  isModified: boolean;
  lang: string;
  viewMode: 'source' | 'diff' | 'rendered' | 'hex';
  _gitStatus?: string;
  isBinary?: boolean;
  fileSize?: number;
}

export interface SerialRequest {
  requestId: string;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: 'none' | 'even' | 'odd';
  description?: string;
  controlSignalsSupported?: boolean;
  status: 'pending' | 'connecting' | 'connected' | 'error';
  error?: string;
}

export interface ReportedService {
  name: string;
  description: string;
  port: number;
  protocol: string;
  host?: string;
  cwd?: string;
  projectName?: string;
  reportedAt: number;
}

export interface PreviewTab {
  id: string;
  label: string;
  // Streaming mode (new)
  targetPort?: number;
  headerHost?: string;
  protocol?: 'http' | 'https';
  quality?: number;
  // Legacy iframe mode (backward compat)
  url?: string;
}
