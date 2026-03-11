/**
 * Reconstruct Claude Code JSONL from SessionEvent[] for fork/resume.
 *
 * This is the critical cross-agent bridge: it builds proper Claude JSONL
 * events from the canonical SessionEvent type. Events from ANY agent
 * (Claude, future Codex/Gemini) can be reconstructed into Claude's format,
 * enabling cross-agent session resumability.
 *
 * Claude Code JSONL format (what `claude --resume <uuid>` expects):
 *   {"type":"user","uuid":"...","sessionId":"...","parentUuid":"...","message":{"role":"user","content":"..."}}
 *   {"type":"assistant","uuid":"...","sessionId":"...","parentUuid":"...","message":{"role":"assistant","content":[...],"model":"...","stop_reason":"..."}}
 *   {"type":"system","uuid":"...","sessionId":"...","subtype":"init","model":"...","permissionMode":"..."}
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { buildLinkedUuid } from '../session-id-utils.js';
import type {
  SessionEvent,
  UserEvent,
  AssistantEvent,
  SystemEvent,
  ResultEvent,
  ControlRequestEvent,
  ControlResponseEvent,
} from '../../../events/types.js';

/**
 * Convert an absolute directory path to the Claude project dir hash format.
 * Replaces '/' with '-', e.g. /home/furti/myproject -> -home-furti-myproject
 */
function projectDirHash(directory: string): string {
  return directory.replace(/\//g, '-');
}

// ═══════════════════════════════════════════════════════
// SessionEvent → Claude JSONL event reconstruction
// ═══════════════════════════════════════════════════════

interface ClaudeJsonlEvent {
  type: string;
  uuid: string;
  sessionId: string;
  parentUuid: string | null;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  [key: string]: any;
}

/**
 * Build common envelope fields for a Claude JSONL event.
 */
function buildEnvelope(
  event: SessionEvent,
  sessionId: string,
  uuid: string,
  parentUuid: string | null,
): ClaudeJsonlEvent {
  const env: ClaudeJsonlEvent = {
    type: event.type,
    uuid,
    sessionId,
    parentUuid,
  };
  if (event.timestamp) env.timestamp = event.timestamp;
  if (event.cwd) env.cwd = event.cwd;
  if (event.gitBranch) env.gitBranch = event.gitBranch;
  if (event.version) env.version = event.version;
  if (event.slug) env.slug = event.slug;
  if (event.userType) env.userType = event.userType;
  if (event.isSidechain) env.isSidechain = event.isSidechain;
  if (event.isSynthetic) env.isSynthetic = event.isSynthetic;
  if (event.agentId) env.agentId = event.agentId;
  if (event.parent_tool_use_id !== undefined) env.parent_tool_use_id = event.parent_tool_use_id;
  return env;
}

/**
 * Reconstruct a UserEvent as a Claude JSONL event.
 */
function reconstructUser(event: UserEvent, sessionId: string, uuid: string, parentUuid: string | null): ClaudeJsonlEvent {
  const out = buildEnvelope(event, sessionId, uuid, parentUuid);
  out.message = {
    role: 'user',
    content: event.message.content,
  };
  if (event.toolUseResult) out.toolUseResult = event.toolUseResult;
  return out;
}

/**
 * Reconstruct an AssistantEvent as a Claude JSONL event.
 */
function reconstructAssistant(event: AssistantEvent, sessionId: string, uuid: string, parentUuid: string | null): ClaudeJsonlEvent {
  const out = buildEnvelope(event, sessionId, uuid, parentUuid);
  out.message = {
    role: 'assistant',
    content: event.message.content,
  };
  if (event.message.model) out.message.model = event.message.model;
  if (event.message.stop_reason !== undefined) out.message.stop_reason = event.message.stop_reason;
  if (event.message.usage) out.message.usage = event.message.usage;
  return out;
}

/**
 * Reconstruct a SystemEvent as a Claude JSONL event.
 */
function reconstructSystem(event: SystemEvent, sessionId: string, uuid: string, parentUuid: string | null): ClaudeJsonlEvent {
  const out = buildEnvelope(event, sessionId, uuid, parentUuid);
  if (event.subtype) out.subtype = event.subtype;
  if (event.model) out.model = event.model;
  if (event.permissionMode) out.permissionMode = event.permissionMode;
  if (event.durationMs !== undefined) out.durationMs = event.durationMs;
  if (event.content) out.content = event.content;
  if (event.hookCount !== undefined) out.hookCount = event.hookCount;
  if (event.hookInfos) out.hookInfos = event.hookInfos;
  if (event.hookErrors) out.hookErrors = event.hookErrors;
  if (event.hasOutput !== undefined) out.hasOutput = event.hasOutput;
  if (event.preventedContinuation !== undefined) out.preventedContinuation = event.preventedContinuation;
  if (event.url) out.url = event.url;
  if (event.compactMetadata) out.compactMetadata = event.compactMetadata;
  if (event.message) out.message = event.message;
  return out;
}

/**
 * Reconstruct a ResultEvent as a Claude JSONL event.
 */
function reconstructResult(event: ResultEvent, sessionId: string, uuid: string, parentUuid: string | null): ClaudeJsonlEvent {
  const out = buildEnvelope(event, sessionId, uuid, parentUuid);
  if (event.subtype) out.subtype = event.subtype;
  if (event.result) out.result = event.result;
  if (event.message) out.message = event.message;
  return out;
}

/**
 * Reconstruct a ControlRequestEvent as a Claude JSONL event.
 */
function reconstructControlRequest(event: ControlRequestEvent, sessionId: string, uuid: string, parentUuid: string | null): ClaudeJsonlEvent {
  const out = buildEnvelope(event, sessionId, uuid, parentUuid);
  if (event.request_id) out.request_id = event.request_id;
  if (event.request) out.request = event.request;
  return out;
}

/**
 * Reconstruct a ControlResponseEvent as a Claude JSONL event.
 */
function reconstructControlResponse(event: ControlResponseEvent, sessionId: string, uuid: string, parentUuid: string | null): ClaudeJsonlEvent {
  const out = buildEnvelope(event, sessionId, uuid, parentUuid);
  if (event.response) out.response = event.response;
  return out;
}

/**
 * Reconstruct a single SessionEvent as a Claude JSONL event object.
 * Maps from the canonical SessionEvent type to Claude's expected format.
 *
 * Events that don't map to conversational messages (progress, file-history-snapshot,
 * last-prompt, queue-operation) are skipped — Claude --resume doesn't need them.
 */
function toClaudeJsonlEvent(
  event: SessionEvent,
  sessionId: string,
  uuid: string,
  parentUuid: string | null,
): ClaudeJsonlEvent | null {
  switch (event.type) {
    case 'user':
      return reconstructUser(event, sessionId, uuid, parentUuid);
    case 'assistant':
      return reconstructAssistant(event, sessionId, uuid, parentUuid);
    case 'system':
      return reconstructSystem(event, sessionId, uuid, parentUuid);
    case 'result':
      return reconstructResult(event, sessionId, uuid, parentUuid);
    case 'control_request':
      return reconstructControlRequest(event, sessionId, uuid, parentUuid);
    case 'control_response':
      return reconstructControlResponse(event, sessionId, uuid, parentUuid);
    // Skip non-conversational events — not needed for resume
    case 'progress':
    case 'file-history-snapshot':
    case 'last-prompt':
    case 'queue-operation':
      return null;
  }
}

// ═══════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════

/**
 * Reconstruct SessionEvent[] as a Claude Code JSONL file for `claude --resume`.
 * Path: ~/.claude/projects/<project-dir-hash>/<targetUuid>.jsonl
 *
 * Each SessionEvent is reconstructed into Claude's native JSONL format
 * from its typed fields — not passed through as raw JSON. This enables
 * cross-agent forking: events from any agent type can be written as
 * valid Claude JSONL.
 *
 * @param events - Array of SessionEvents to write
 * @param targetUuid - The UUID for the new session file (no "sess_" prefix)
 * @param directory - The project working directory (for path hashing)
 * @returns The full path to the written JSONL file
 */
export function writeForkedClaudeJsonl(
  events: SessionEvent[],
  targetUuid: string,
  directory: string,
): string {
  const dirHash = projectDirHash(path.resolve(directory));
  const projectDir = path.join(os.homedir(), '.claude', 'projects', dirHash);
  const jsonlPath = path.join(projectDir, `${targetUuid}.jsonl`);

  // Ensure directory exists
  fs.mkdirSync(projectDir, { recursive: true });

  // Build UUID remap: old UUID -> new UUID (preserves parentUuid chain)
  const uuidMap = new Map<string, string>();
  for (const event of events) {
    if (event.uuid) {
      uuidMap.set(event.uuid, uuidv4());
    }
  }

  const lines: string[] = [];
  let lastUuid: string | null = null;

  for (const event of events) {
    const newUuid = (event.uuid && uuidMap.get(event.uuid)) || uuidv4();
    const newParentUuid = event.parentUuid ? (uuidMap.get(event.parentUuid) || null) : lastUuid;

    const jsonlEvent = toClaudeJsonlEvent(event, targetUuid, newUuid, newParentUuid);
    if (jsonlEvent) {
      lines.push(JSON.stringify(jsonlEvent));
      lastUuid = newUuid;
    }
  }

  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  console.log(`[claude-jsonl-writer] Reconstructed ${lines.length} events to ${jsonlPath}`);
  return jsonlPath;
}

/**
 * Fork a slice of SessionEvents into a resumable JSONL file.
 * Handles event slicing, range-fork synthetic init, UUID generation, and writing.
 *
 * @returns The resume UUID, or null if the fork point wasn't found.
 */
/**
 * Fork a slice of SessionEvents into a resumable JSONL file.
 * Handles event slicing, range-fork synthetic init, UUID generation, and writing.
 *
 * The returned UUID is parent-linked: its first 16 hex chars are the last 16 hex chars
 * of the parent session ID, enabling tree-view reconstruction in session history.
 *
 * @returns The resume UUID, or null if the fork point wasn't found.
 */
export function forkEventsToResumable(
  events: SessionEvent[],
  afterEventUuid: string,
  directory: string,
  parentSessionId: string,
  fromEventUuid?: string,
): string | null {
  if (events.length === 0) return null;

  const forkIdx = events.findIndex((e) => e.uuid === afterEventUuid);
  if (forkIdx === -1) return null;

  let startIdx = 0;
  if (fromEventUuid) {
    startIdx = events.findIndex((e) => e.uuid === fromEventUuid);
    if (startIdx === -1 || startIdx > forkIdx) return null;

    // Ensure the range starts with a user message so we can embed the context
    // header into it. Claude Code's --resume branches from the first user
    // message, so a separate synthetic init would make imported events a dead
    // branch. Walk backward to find the preceding user message if needed.
    if (events[startIdx].type !== 'user') {
      for (let i = startIdx - 1; i >= 0; i--) {
        if (events[i].type === 'user') {
          startIdx = i;
          break;
        }
      }
    }
  }

  let sliced = events.slice(startIdx, forkIdx + 1);

  // Event boundary integrity: if the last event is an assistant message with tool_use blocks,
  // include the corresponding tool_result user events and any child events
  const lastEvent = sliced[sliced.length - 1];
  if (lastEvent?.type === 'assistant' && Array.isArray(lastEvent.message?.content)) {
    const toolUseIds = lastEvent.message.content
      .filter((b: any) => b.type === 'tool_use')
      .map((b: any) => b.id);

    if (toolUseIds.length > 0) {
      for (let i = forkIdx + 1; i < events.length; i++) {
        const ev = events[i];
        if (ev.parent_tool_use_id && toolUseIds.includes(ev.parent_tool_use_id)) {
          sliced.push(ev);
          continue;
        }
        if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
          const hasMatchingResult = ev.message.content.some(
            (item: any) => item.type === 'tool_result' && toolUseIds.includes(item.tool_use_id)
          );
          if (hasMatchingResult) {
            sliced.push(ev);
            continue;
          }
        }
      }
    }
  }

  // For range forks, inject a context header into the first event's content
  // so the model knows this is imported context. We do NOT prepend a separate
  // synthetic user message because Claude Code's --resume creates a new branch
  // from the first user message, which would make the imported events a dead
  // sibling branch that's never included in context.
  if (fromEventUuid && sliced.length > 0) {
    const header = '[This session continues from a selected range of a previous conversation. The messages below are the selected context. Continue from where this conversation left off.]';
    const first = sliced[0];
    if (first.type === 'user' && first.message) {
      // Embed the context header into the first user message. We do NOT
      // prepend a separate synthetic user message because Claude Code's
      // --resume creates a new branch from the first user message, which
      // would make the imported events a dead sibling branch.
      const msg = first.message;
      const content = typeof msg.content === 'string'
        ? `${header}\n\n${msg.content}`
        : Array.isArray(msg.content)
          ? [{ type: 'text' as const, text: header }, ...msg.content]
          : msg.content;
      sliced[0] = { ...first, message: { ...msg, content } };
    }
  }

  const targetUuid = buildLinkedUuid(parentSessionId, 'fork');
  writeForkedClaudeJsonl(sliced, targetUuid, directory);
  return targetUuid;
}
