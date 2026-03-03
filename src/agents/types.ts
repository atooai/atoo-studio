import { EventEmitter } from 'events';

// ═══════════════════════════════════════════════════════
// Abstract Message Types
// ═══════════════════════════════════════════════════════

export interface AbstractMessageBase {
  id: string;
  sessionId: string;
  timestamp: number;
}

export interface UserMessage extends AbstractMessageBase {
  type: 'user_message';
  text: string;
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

export interface Question extends AbstractMessageBase {
  type: 'question';
  requestId: string;
  questions: any[];
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
  | FileChange;

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
  sendMessage(text: string): void;
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
// Agent Factory
// ═══════════════════════════════════════════════════════

export interface AgentFactory {
  agentType: string;
  create(sessionId: string): Agent;
}

// ═══════════════════════════════════════════════════════
// Agent WS Command Types (client → server)
// ═══════════════════════════════════════════════════════

export type AgentCommand =
  | { action: 'send_message'; text: string }
  | { action: 'approve'; requestId: string; updatedInput?: any }
  | { action: 'deny'; requestId: string }
  | { action: 'answer_question'; requestId: string; answers: Record<string, string> }
  | { action: 'set_mode'; mode: string }
  | { action: 'set_model'; model: string }
  | { action: 'refresh_context' }
  | { action: 'send_key'; key: string };
