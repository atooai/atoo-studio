export type AgentMode = 'terminal' | 'chat' | 'terminal+chat' | 'terminal+chatRO';

export interface AgentDescriptor {
  agentType: string;
  agentFamily: string;
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
  status: 'active' | 'attention' | 'open' | 'ended';
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
  metaName?: string;
  metaDescription?: string;
  tags?: string[];
  contextUsage?: ContextUsage;
  contextInProgress?: boolean;
  _runningDispatches?: string[];
  activeSessionIdx?: number;
  cliSessionId?: string;
  linkedIssue?: LinkedIssue;
  pendingAskUser?: {
    requestId: string;
    questions: import('./components/AskUser/types').AskUserQuestion[];
  } | null;
  // Atoo-any branching state
  forks?: AtooFork[];
  extractions?: AtooExtraction[];
}

export interface ContextUsage {
  model: string;
  usedTokens: number;
  totalTokens: number;
  percent: number;
  freePercent: number;
}

export type MessageStatus = 'visible' | 'removed' | 'compacted';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'thinking' | 'tool' | 'control_request';
  content: any;
  _eventUuid?: string;
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
  _agentSelectorConfig?: any[];
  _rawJson?: string;
  _sidechain?: boolean;
  _parentToolUseId?: string;
  _agentId?: string;
  // Branch-aware fields (atoo-any)
  _msgStatus?: MessageStatus;
  _branchId?: string;
  _compactedSummary?: string;
  _compactedBy?: string;
  _contextDrift?: boolean;
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

export interface ChatDraft {
  text: string;
  selectedAgents?: string[];
}

// ─── Atoo-any branching types ───

export interface AtooBranch {
  id: string;
  label: string;
  messages: ChatMessage[];
  isOriginal: boolean;
}

export interface AtooFork {
  id: string;
  forkPointIndex: number;
  branches: AtooBranch[];
  activeBranchIndex: number;
}

export interface AtooExtraction {
  id: string;
  label: string;
  sourceConversation: string;
  sourceRange: [number, number];
  extractedMessages: ChatMessage[];
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
  agentFamily?: string;
  title: string;
  lastModified: string;
  eventCount: number;
  metaName?: string;
  tags?: string[];
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

// ─── GitHub types ───

export interface GitHubStatus {
  available: boolean;
  owner: string;
  repo: string;
  canWrite: boolean;
  unavailableReason?: string;
}

export interface GitHubLabel {
  name: string;
  color: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  labels: GitHubLabel[];
  createdAt: string;
  updatedAt: string;
  comments: { totalCount: number };
  url: string;
  assignees: { login: string }[];
  milestone?: { title: string } | null;
}

export interface GitHubPull {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  labels: GitHubLabel[];
  createdAt: string;
  updatedAt: string;
  comments: { totalCount: number };
  url: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string;
  additions: number;
  deletions: number;
  assignees: { login: string }[];
}

export interface GitHubComment {
  author: { login: string };
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubIssueDetail extends GitHubIssue {
  body: string;
  comments_list: GitHubComment[];
}

export interface GitHubPullDetail extends GitHubPull {
  body: string;
  comments_list: GitHubComment[];
}

export interface LinkedIssue {
  type: 'issue' | 'pr';
  number: number;
  title: string;
  url: string;
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

// ─── Niri layout types ───

export type NiriPanelType =
  | 'file-tree' | 'git-history' | 'editor'
  | 'agent-tui' | 'agent-chat' | 'terminal'
  | 'preview' | 'sessions-list' | 'issues' | 'pulls' | 'changes';

export interface NiriWindow {
  id: string;
  type: NiriPanelType;
  params?: Record<string, string>;
  heightFraction?: number;
}

export type NiriWidthMode = '1/3' | '1/2' | '2/3' | 'full' | 'custom';

export interface NiriColumn {
  id: string;
  windows: NiriWindow[];
  widthMode: NiriWidthMode;
  customWidthPx?: number;
}

export interface NiriLayoutState {
  columns: NiriColumn[];
  focusedColumnIdx: number;
  focusedWindowIdx: number;
  overviewMode: boolean;
  toolbarPosition: 'left' | 'right' | 'top' | 'bottom';
}
