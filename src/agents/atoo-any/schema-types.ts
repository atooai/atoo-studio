/**
 * Normalized session schema types for atoo-any.
 *
 * Replaces the flat JSONL approach with:
 * - session.json (tree structure + metadata)
 * - prompts/{uuid}.jsonl (append-only event streams)
 * - blobs/{contenthash} (deduplicated attachments)
 *
 * See docs/docs/reference/atoo-any-session-schema.md for the full spec.
 */

// ═══════════════════════════════════════════════════════
// Session (top-level session.json)
// ═══════════════════════════════════════════════════════

export interface Session {
  version: number;
  uuid: string;
  directory: string;
  createdAt: string;
  updatedAt: string;

  metadata: SessionMetadata;
  prompts: Record<string, Prompt>;
  tree: TreeNode[];
  fileChanges: Record<string, FileChanges>;
  clientState: Record<string, ClientState>;
}

// ═══════════════════════════════════════════════════════
// Session Metadata
// ═══════════════════════════════════════════════════════

export interface SessionMetadata {
  title: string;
  name?: string;
  description?: string;
  tags: string[];
}

// ═══════════════════════════════════════════════════════
// Prompt (entry in the flat prompts index)
// ═══════════════════════════════════════════════════════

export interface Prompt {
  uuid: string;
  startedAt: string;
  endedAt?: string;
  title?: string;
  tags?: string[];
  description?: string;
  agents: AgentRun[];
  attachments?: Attachment[];
  compaction?: {
    replaces: string[];
  };
  git?: {
    branch?: string;
    commit?: string;
    worktree?: string;
  };
}

// ═══════════════════════════════════════════════════════
// Agent Run
// ═══════════════════════════════════════════════════════

export interface AgentRun {
  uuid: string;
  startedAt: string;
  endedAt?: string;
  harness: string;
  model: string;
  effort?: string;
  attachments?: Attachment[];
  tokens?: TokenUsage;
}

export interface TokenUsage {
  input: number;
  inputCached: number;
  output: number;
  costCents: number;
}

// ═══════════════════════════════════════════════════════
// Attachment
// ═══════════════════════════════════════════════════════

export interface Attachment {
  uuid: string;
  filename: string;
  mime: string;
}

// ═══════════════════════════════════════════════════════
// Tree Node (pure structure, recursive)
// ═══════════════════════════════════════════════════════

export interface TreeNode {
  uuid: string;
  agents?: number[];
  hidden?: boolean;
  children?: TreeNode[];
}

// ═══════════════════════════════════════════════════════
// File Changes (3-layer detection)
// ═══════════════════════════════════════════════════════

export interface FileChanges {
  gitDiff?: string[];
  fsWatcher?: string[];
  byAgentLDPreload?: Record<number, string[]>;
}

// ═══════════════════════════════════════════════════════
// Client State
// ═══════════════════════════════════════════════════════

export interface ClientState {
  lastSeen: string;
  activePath: number[];
}

// ═══════════════════════════════════════════════════════
// Prompt JSONL Events (written to prompts/{uuid}.jsonl)
// ═══════════════════════════════════════════════════════

export interface PromptMessage {
  type: 'prompt';
  message: string;
  timestamp: string;
  blobs?: string[];
}

export interface RunStart {
  type: 'run_start';
  runId: string;
}

export interface RunMessage {
  type: 'run_msg';
  runId: string;
  role: 'assistant' | 'tool_result';
  content: PromptContentBlock;
}

export interface RunEnd {
  type: 'run_end';
  runId: string;
}

export type PromptEvent = PromptMessage | RunStart | RunMessage | RunEnd;

// ═══════════════════════════════════════════════════════
// Content Blocks (used in RunMessage)
// ═══════════════════════════════════════════════════════

export type PromptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, any>; caller?: string }
  | { type: 'tool_result'; tool_use_id: string; content: string | ToolResultContentItem[]; is_error?: boolean }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } };

export interface ToolResultContentItem {
  type: 'text' | 'image';
  text?: string;
  source?: { type: 'base64'; media_type: string; data: string };
}

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

/** Create a new empty session */
export function createSession(uuid: string, directory: string): Session {
  const now = new Date().toISOString();
  return {
    version: 1,
    uuid,
    directory,
    createdAt: now,
    updatedAt: now,
    metadata: { title: 'New Session', tags: [] },
    prompts: {},
    tree: [],
    fileChanges: {},
    clientState: {},
  };
}

/** Create a new prompt */
export function createPrompt(uuid: string, agents: AgentRun[], attachments?: Attachment[], git?: Prompt['git']): Prompt {
  return {
    uuid,
    startedAt: new Date().toISOString(),
    agents,
    ...(attachments?.length ? { attachments } : {}),
    ...(git ? { git } : {}),
  };
}

/** Create a new agent run */
export function createAgentRun(uuid: string, harness: string, model: string, effort?: string): AgentRun {
  return {
    uuid,
    startedAt: new Date().toISOString(),
    harness,
    model,
    ...(effort ? { effort } : {}),
  };
}

/** Create a compaction prompt */
export function createCompactionPrompt(uuid: string, replaces: string[], agent: AgentRun): Prompt {
  return {
    uuid,
    startedAt: new Date().toISOString(),
    agents: [agent],
    compaction: { replaces },
  };
}
