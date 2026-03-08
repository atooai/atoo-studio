/**
 * Map Codex CLI JSONL lines → SessionEvent[].
 *
 * Codex JSONL uses a wrapper format with top-level `type` + `payload`:
 *   session_meta   → SystemEvent (init)
 *   event_msg      → UserEvent / AssistantEvent / ResultEvent
 *   response_item  → AssistantEvent (function_call) / UserEvent (function_call_output)
 *   turn_context   → skipped
 */
import { v4 as uuidv4 } from 'uuid';
import type { SessionEvent } from '../../../events/types.js';

// ═══════════════════════════════════════════════════════
// Codex JSONL line types
// ═══════════════════════════════════════════════════════

interface CodexLine {
  timestamp?: string;
  type: string;
  payload: any;
}

// ═══════════════════════════════════════════════════════
// Mapper
// ═══════════════════════════════════════════════════════

/**
 * Convert a single parsed Codex JSONL line into zero or more SessionEvents.
 */
export function mapCodexJsonlLine(line: CodexLine): SessionEvent[] {
  const ts = line.timestamp;

  switch (line.type) {
    case 'session_meta':
      return mapSessionMeta(line.payload, ts);
    case 'event_msg':
      return mapEventMsg(line.payload, ts);
    case 'response_item':
      return mapResponseItem(line.payload, ts);
    // turn_context — per-turn metadata, skip
    default:
      return [];
  }
}

// ───────────────────────────────────────────────────────
// session_meta → SystemEvent (init)
// ───────────────────────────────────────────────────────

function mapSessionMeta(payload: any, ts?: string): SessionEvent[] {
  const model = payload.model_provider === 'openai'
    ? 'gpt-5.4'
    : (payload.model_provider || 'unknown');

  return [{
    type: 'system' as const,
    uuid: uuidv4(),
    subtype: 'init',
    model,
    timestamp: ts,
    cwd: payload.cwd,
  }];
}

// ───────────────────────────────────────────────────────
// event_msg → various events
// ───────────────────────────────────────────────────────

function mapEventMsg(payload: any, ts?: string): SessionEvent[] {
  switch (payload.type) {
    case 'user_message':
      return [{
        type: 'user' as const,
        uuid: uuidv4(),
        timestamp: ts,
        message: {
          role: 'user' as const,
          content: payload.message || '',
        },
      }];

    case 'agent_message':
      return [{
        type: 'assistant' as const,
        uuid: uuidv4(),
        timestamp: ts,
        message: {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: payload.message || '' }],
        },
      }];

    case 'task_complete':
      return [{
        type: 'result' as const,
        uuid: uuidv4(),
        timestamp: ts,
        subtype: 'task_complete',
        result: payload.last_agent_message,
      }];

    // task_started, token_count — skip
    default:
      return [];
  }
}

// ───────────────────────────────────────────────────────
// response_item → tool use / tool result
// ───────────────────────────────────────────────────────

function mapResponseItem(payload: any, ts?: string): SessionEvent[] {
  switch (payload.type) {
    case 'function_call':
      return mapFunctionCall(payload, ts);

    case 'function_call_output':
      return mapFunctionCallOutput(payload, ts);

    // Skip: message (duplicates event_msg), reasoning (encrypted), web_search_call
    default:
      return [];
  }
}

function mapFunctionCall(payload: any, ts?: string): SessionEvent[] {
  const callId = payload.call_id || uuidv4();
  const name = payload.name || 'unknown';
  let input: Record<string, any> = {};
  try {
    input = JSON.parse(payload.arguments || '{}');
  } catch {
    input = { raw: payload.arguments };
  }

  // Map request_user_input to ControlRequestEvent (question UI)
  if (name === 'request_user_input') {
    return [{
      type: 'control_request' as const,
      uuid: uuidv4(),
      timestamp: ts,
      request_id: callId,
      request: {
        subtype: 'tool_use',
        tool_use: { name: 'AskUserQuestion', input },
      },
    }];
  }

  // Regular tool call → AssistantEvent with tool_use block
  return [{
    type: 'assistant' as const,
    uuid: uuidv4(),
    timestamp: ts,
    message: {
      role: 'assistant' as const,
      content: [{
        type: 'tool_use' as const,
        id: callId,
        name,
        input,
      }],
    },
  }];
}

function mapFunctionCallOutput(payload: any, ts?: string): SessionEvent[] {
  const callId = payload.call_id || '';
  const output = payload.output || '';

  return [{
    type: 'user' as const,
    uuid: uuidv4(),
    timestamp: ts,
    message: {
      role: 'user' as const,
      content: [{
        type: 'tool_result' as const,
        tool_use_id: callId,
        content: output,
      }],
    },
  }];
}
