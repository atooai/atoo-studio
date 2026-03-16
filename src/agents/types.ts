import { EventEmitter } from 'events';
import type { SessionEvent } from '../events/types.js';
import type { WireMessage } from '../events/wire.js';

// ═══════════════════════════════════════════════════════
// Agent Status
// ═══════════════════════════════════════════════════════

export type AgentStatus = 'open' | 'active' | 'attention' | 'exited';

// ═══════════════════════════════════════════════════════
// Agent UI Mode
// ═══════════════════════════════════════════════════════

export type AgentMode = 'terminal' | 'chat' | 'terminal+chat' | 'terminal+chatRO';

// ═══════════════════════════════════════════════════════
// Agent Descriptor (metadata exposed by factories)
// ═══════════════════════════════════════════════════════

export interface AgentDescriptor {
  agentType: string;
  agentFamily: string;
  name: string;
  mode: AgentMode;
  iconUrl: string;
}

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

export interface LinkedIssueInfo {
  type: 'issue' | 'pr';
  number: number;
  title: string;
  url: string;
}

export interface AgentSessionInfo {
  sessionId: string;
  agentType: string;
  agentMode: AgentMode;
  status: AgentStatus;
  mode?: string;
  model?: string;
  cwd?: string;
  capabilities: AgentCapabilities;
  createdAt: number;
  /** The CLI's own session UUID (for chain link detection in the sidebar) */
  cliSessionId?: string;
  /** Linked GitHub issue or PR */
  linkedIssue?: LinkedIssueInfo;
}

// ═══════════════════════════════════════════════════════
// Agent Init Options
// ═══════════════════════════════════════════════════════

export interface AgentInitOptions {
  cwd?: string;
  skipPermissions?: boolean;
  resumeSessionUuid?: string;
  /** When true, this is a chain continuation session — append chain system prompt */
  isChainContinuation?: boolean;
  /** Optional message to append to the initial greeting in the pre-created session */
  initialMessage?: string;
}

// ═══════════════════════════════════════════════════════
// Agent Interface
// ═══════════════════════════════════════════════════════

export interface Agent extends EventEmitter {
  // Events: 'message' (WireMessage), 'status' (AgentStatus), 'ready', 'error', 'exit'

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

  // Activity status (focus/blur tracking for attention management)
  onFocused(): void;
  onBlurred(): void;

  // Forking
  /**
   * Fork this agent's events into a resumable session file.
   * Returns the resume UUID, or null if forking isn't supported.
   */
  forkToResumable(afterEventUuid: string, fromEventUuid?: string, targetDir?: string): string | null;

  // State
  getInfo(): AgentSessionInfo;
  getMessages(): WireMessage[];
  getEvents(): SessionEvent[];
  getWireMessages(): WireMessage[];
  getCliSessionId?(): string | null;
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
  metaName?: string;     // Session metadata name (from DB)
  tags?: string[];       // Session metadata tags (from DB)
}

// ═══════════════════════════════════════════════════════
// Agent Factory
// ═══════════════════════════════════════════════════════

export interface AgentFactory {
  agentType: string;
  /** Agent family identifier — factories in the same family can resume each other's sessions directly */
  agentFamily: string;
  create(sessionId: string): Agent;
  getDescriptor(): AgentDescriptor;
  getHistoricalSessions(): Promise<HistoricalSession[]>;
  ownsSession(uuid: string): Promise<boolean>;
  /** Return all session JSONL file paths (including subagent files) for the given project directories */
  getSessionFilesForProject(cwds: string[]): Promise<string[]>;
  /** Read a session's events (for cross-family conversion) */
  readSessionEvents(uuid: string): Promise<SessionEvent[]>;
  /** Write events in this family's native format for resuming. Returns the JSONL path. */
  writeSessionForResume(events: SessionEvent[], targetUuid: string, directory: string): string;
}

// ═══════════════════════════════════════════════════════
// Attachment
// ═══════════════════════════════════════════════════════

export interface Attachment {
  media_type: string;
  data: string;      // base64 (image/pdf) or empty string (text-based)
  name?: string;
  text?: string;     // plain text content (for text-based files)
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
