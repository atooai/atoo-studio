/**
 * SessionEvent — canonical superset type for all agent message formats.
 *
 * Discriminated union on `type`. Every raw JSONL event from any agent
 * (Claude Code, future Codex/Gemini) maps 1:1 to a SessionEvent variant.
 *
 * See docs/session-event-schema.md for how this type was derived.
 */

// ═══════════════════════════════════════════════════════
// Content Block types (inside message.content arrays)
// ═══════════════════════════════════════════════════════

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
  caller?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ToolResultContentBlock[];
  is_error?: boolean;
}

export type ToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource };

export interface ImageBlock {
  type: 'image';
  source: ImageSource;
}

export interface DocumentBlock {
  type: 'document';
  source: { type: 'base64'; media_type: string; data: string };
}

export interface ImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

export type AssistantContentBlock = TextBlock | ThinkingBlock | ToolUseBlock;
export type UserContentBlock = TextBlock | ToolResultBlock | ImageBlock | DocumentBlock;
export type ContentBlock = AssistantContentBlock | UserContentBlock;

// ═══════════════════════════════════════════════════════
// Envelope — common fields on conversational events
// ═══════════════════════════════════════════════════════

export interface SessionEventEnvelope {
  uuid: string;
  sessionId?: string;
  session_id?: string; // legacy format
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  slug?: string;
  userType?: string;
  isSidechain?: boolean;
  isSynthetic?: boolean;
  agentId?: string;
  parent_tool_use_id?: string | null;
}

// ═══════════════════════════════════════════════════════
// Event variants
// ═══════════════════════════════════════════════════════

export interface UserEvent extends SessionEventEnvelope {
  type: 'user';
  message: {
    role: 'user';
    content: string | UserContentBlock[];
  };
  toolUseResult?: ToolUseResult;
}

export interface ToolUseResult {
  type?: string;
  content?: string;
  filePath?: string;
  file?: {
    content: string;
    filePath: string;
    numLines?: number;
    startLine?: number;
    totalLines?: number;
  };
  originalFile?: string;
  structuredPatch?: any;
  prompt?: string;
  status?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  usage?: Record<string, any>;
}

export interface AssistantEvent extends SessionEventEnvelope {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: string | AssistantContentBlock[];
    model?: string;
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

export interface SystemEvent extends SessionEventEnvelope {
  type: 'system';
  subtype?: string;
  // init subtype
  model?: string;
  permissionMode?: string;
  // turn_duration subtype
  durationMs?: number;
  // local_command subtype
  content?: string;
  // stop_hook_summary subtype
  hookCount?: number;
  hookInfos?: any[];
  hookErrors?: any[];
  hasOutput?: boolean;
  preventedContinuation?: boolean;
  // bridge_status subtype
  url?: string;
  // compact_boundary subtype
  compactMetadata?: {
    preTokens?: number;
    trigger?: string;
  };
  // generic message content for system events
  message?: {
    role: string;
    content: any;
  };
}

export interface ProgressEvent extends SessionEventEnvelope {
  type: 'progress';
  data?: {
    agentId?: string;
    content?: string;
    type?: string;
    [key: string]: any;
  };
  message?: {
    role: string;
    content: any;
  };
}

export interface ControlRequestEvent extends SessionEventEnvelope {
  type: 'control_request';
  request_id?: string;
  request?: {
    subtype?: string;
    tool_use?: { name: string; input: Record<string, any> };
    tool_name?: string;
    input?: Record<string, any>;
    model?: string;
    [key: string]: any;
  };
}

export interface ControlResponseEvent extends SessionEventEnvelope {
  type: 'control_response';
  response?: {
    subtype?: string;
    request_id?: string;
    response?: {
      behavior?: string;
      message?: string;
      updatedInput?: any;
      updatedPermissions?: any[];
    };
  };
}

export interface ResultEvent extends SessionEventEnvelope {
  type: 'result';
  subtype?: string;
  result?: string;
  message?: {
    role: string;
    content: any;
  };
}

export interface FileHistorySnapshotEvent extends SessionEventEnvelope {
  type: 'file-history-snapshot';
  filePath?: string;
  content?: string;
  [key: string]: any;
}

export interface LastPromptEvent extends SessionEventEnvelope {
  type: 'last-prompt';
  prompt?: string;
  [key: string]: any;
}

export interface QueueOperationEvent extends SessionEventEnvelope {
  type: 'queue-operation';
  operation?: string;
  [key: string]: any;
}

// ═══════════════════════════════════════════════════════
// Union type
// ═══════════════════════════════════════════════════════

export type SessionEvent =
  | UserEvent
  | AssistantEvent
  | SystemEvent
  | ProgressEvent
  | ControlRequestEvent
  | ControlResponseEvent
  | ResultEvent
  | FileHistorySnapshotEvent
  | LastPromptEvent
  | QueueOperationEvent;

// ═══════════════════════════════════════════════════════
// Type guards
// ═══════════════════════════════════════════════════════

export function isUserEvent(e: SessionEvent): e is UserEvent { return e.type === 'user'; }
export function isAssistantEvent(e: SessionEvent): e is AssistantEvent { return e.type === 'assistant'; }
export function isSystemEvent(e: SessionEvent): e is SystemEvent { return e.type === 'system'; }
export function isProgressEvent(e: SessionEvent): e is ProgressEvent { return e.type === 'progress'; }
export function isControlRequestEvent(e: SessionEvent): e is ControlRequestEvent { return e.type === 'control_request'; }
export function isControlResponseEvent(e: SessionEvent): e is ControlResponseEvent { return e.type === 'control_response'; }
export function isResultEvent(e: SessionEvent): e is ResultEvent { return e.type === 'result'; }

/** Get the session ID from either camelCase or snake_case field. */
export function getSessionId(e: SessionEvent): string {
  return (e as any).sessionId || (e as any).session_id || '';
}
