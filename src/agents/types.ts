import { EventEmitter } from 'events';

// ═══════════════════════════════════════════════════════
// Abstract Message Types
// ═══════════════════════════════════════════════════════

export interface AbstractMessageBase {
  id: string;
  sessionId: string;
  timestamp: number;
  rawEvent?: any;
}

export interface UserMessage extends AbstractMessageBase {
  type: 'user_message';
  text: string;
  attachments?: Attachment[];
}

export interface AssistantMessage extends AbstractMessageBase {
  type: 'assistant_message';
  text: string;
  isPartial?: boolean;
}

export interface ToolRequest extends AbstractMessageBase {
  type: 'tool_request';
  requestId: string;
  toolName: string;
  input: any;
  description?: string;
  responded: boolean;
  response?: 'approved' | 'denied';
}

export interface ToolResult extends AbstractMessageBase {
  type: 'tool_result';
  requestId: string;
  toolName: string;
  output: string;
  isError: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  options: QuestionOption[];
  allowFreeInput?: boolean;
  multiSelect?: boolean;
}

export interface Question extends AbstractMessageBase {
  type: 'question';
  requestId: string;
  questions: QuestionItem[];
  responded: boolean;
}

export interface StatusUpdate extends AbstractMessageBase {
  type: 'status_update';
  status: AgentStatus;
  mode?: string;
  model?: string;
}

export interface ContextUsage extends AbstractMessageBase {
  type: 'context_usage';
  model: string;
  usedTokens: number;
  totalTokens: number;
  percent: number;
  freePercent: number;
}

export interface SystemMessage extends AbstractMessageBase {
  type: 'system_message';
  text: string;
  subtype?: string;
}

export interface ResultMessage extends AbstractMessageBase {
  type: 'result';
  subtype?: string;
  summary?: string;
}

export interface FileChange extends AbstractMessageBase {
  type: 'file_change';
  operation: string;
  path: string;
  oldPath?: string;
}

export interface PlanApproval extends AbstractMessageBase {
  type: 'plan_approval';
  requestId: string;
  plan: string;
  responded: boolean;
  response?: 'approved' | 'denied';
}

export type AbstractMessage =
  | UserMessage
  | AssistantMessage
  | ToolRequest
  | ToolResult
  | Question
  | StatusUpdate
  | ContextUsage
  | SystemMessage
  | ResultMessage
  | FileChange
  | PlanApproval;

// ═══════════════════════════════════════════════════════
// Agent Status
// ═══════════════════════════════════════════════════════

export type AgentStatus = 'initializing' | 'idle' | 'active' | 'waiting' | 'error' | 'exited';

// ═══════════════════════════════════════════════════════
// Agent Capabilities
// ═══════════════════════════════════════════════════════

export interface AgentCapabilities {
  canChangeMode: boolean;
  canChangeModel: boolean;
  hasContextUsage: boolean;
  canFork: boolean;
  canResume: boolean;
  hasTerminal: boolean;
  hasFileTracking: boolean;
  availableModes: string[];
  availableModels: string[];
}

// ═══════════════════════════════════════════════════════
// Agent Session Info (returned by getInfo)
// ═══════════════════════════════════════════════════════

export interface AgentSessionInfo {
  sessionId: string;
  agentType: string;
  status: AgentStatus;
  mode?: string;
  model?: string;
  cwd?: string;
  capabilities: AgentCapabilities;
  createdAt: number;
}

// ═══════════════════════════════════════════════════════
// Agent Init Options
// ═══════════════════════════════════════════════════════

export interface AgentInitOptions {
  cwd?: string;
  skipPermissions?: boolean;
  resumeSessionUuid?: string;
  forkFromEvents?: any[];
  forkParentSessionId?: string;
  forkAfterEventUuid?: string;
}

// ═══════════════════════════════════════════════════════
// Agent Interface
// ═══════════════════════════════════════════════════════

export interface Agent extends EventEmitter {
  // Events: 'message' (AbstractMessage), 'status' (AgentStatus), 'ready', 'error', 'exit'

  // Lifecycle
  initialize(options: AgentInitOptions): Promise<void>;
  destroy(): Promise<void>;

  // Messaging
  sendMessage(text: string, attachments?: Attachment[]): void;
  approve(requestId: string, updatedInput?: any): void;
  deny(requestId: string): void;
  answerQuestion(requestId: string, answers: Record<string, string>): void;

  // Actions
  setMode(mode: string): void;
  setModel(model: string): void;
  refreshContext(): void;
  sendKey(key: string): void;

  // State
  getInfo(): AgentSessionInfo;
  getMessages(): AbstractMessage[];
}

// ═══════════════════════════════════════════════════════
// Historical Session (returned by AgentFactory)
// ═══════════════════════════════════════════════════════

export interface HistoricalSession {
  id: string;            // Unique identifier (e.g., UUID from JSONL filename)
  agentType: string;     // Which agent implementation owns this
  title: string;
  directory: string;     // Working directory the session ran in
  lastModified: string;  // ISO timestamp
  eventCount: number;    // Approximate number of events
}

// ═══════════════════════════════════════════════════════
// Agent Factory
// ═══════════════════════════════════════════════════════

export interface AgentFactory {
  agentType: string;
  create(sessionId: string): Agent;
  getHistoricalSessions(): Promise<HistoricalSession[]>;
  ownsSession(uuid: string): Promise<boolean>;
}

// ═══════════════════════════════════════════════════════
// Attachment
// ═══════════════════════════════════════════════════════

export interface Attachment {
  media_type: string;
  data: string;      // base64
  name?: string;
}

// ═══════════════════════════════════════════════════════
// Agent WS Command Types (client → server)
// ═══════════════════════════════════════════════════════

export type AgentCommand =
  | { action: 'send_message'; text: string; attachments?: Attachment[] }
  | { action: 'approve'; requestId: string; updatedInput?: any }
  | { action: 'deny'; requestId: string }
  | { action: 'answer_question'; requestId: string; answers: Record<string, string> }
  | { action: 'set_mode'; mode: string }
  | { action: 'set_model'; model: string }
  | { action: 'refresh_context' }
  | { action: 'send_key'; key: string };
