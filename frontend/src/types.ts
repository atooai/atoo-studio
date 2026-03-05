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
  permissionMode: string | null;
  model: string | null;
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
  sessions: Session[];
  files: FileNode[];
  gitChanges: GitChange[];
  gitLog: GitLog;
  terminals: TerminalInfo[];
  stashes: Stash[];
  historicalSessions?: HistoricalSession[];
  activeSessionIdx: number;
  activeTerminalIdx: number;
  worktreePath?: string | null;
  worktreeParentBranch?: string | null;
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
  viewMode: 'source' | 'diff' | 'rendered';
  _gitStatus?: string;
}

export interface PreviewTab {
  id: string;
  url: string;
  label: string;
}
