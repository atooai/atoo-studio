/**
 * Reconstruct Codex CLI JSONL from SessionEvent[] for fork/resume.
 *
 * Codex JSONL format:
 *   {"timestamp":"...","type":"session_meta","payload":{...}}
 *   {"timestamp":"...","type":"event_msg","payload":{"type":"user_message","message":"..."}}
 *   {"timestamp":"...","type":"event_msg","payload":{"type":"agent_message","message":"...","phase":"final_answer"}}
 *   {"timestamp":"...","type":"response_item","payload":{"type":"function_call","name":"...","arguments":"...","call_id":"..."}}
 *   {"timestamp":"...","type":"response_item","payload":{"type":"function_call_output","call_id":"...","output":"..."}}
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type {
  SessionEvent,
  UserEvent,
  AssistantEvent,
  SystemEvent,
  ResultEvent,
  ControlRequestEvent,
} from '../../../events/types.js';

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

/**
 * Build the Codex session directory path for the current date.
 * ~/.codex/sessions/YYYY/MM/DD/
 */
function getDateDir(): string {
  const now = new Date();
  const y = now.getFullYear().toString();
  const m = (now.getMonth() + 1).toString().padStart(2, '0');
  const d = now.getDate().toString().padStart(2, '0');
  return path.join(CODEX_SESSIONS_DIR, y, m, d);
}

/**
 * Build the Codex JSONL filename.
 * rollout-YYYY-MM-DDTHH-MM-SS-{uuid}.jsonl
 */
function buildFilename(uuid: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  return `rollout-${ts}-${uuid}.jsonl`;
}

// ═══════════════════════════════════════════════════════
// SessionEvent → Codex JSONL line reconstruction
// ═══════════════════════════════════════════════════════

function reconstructSessionMeta(event: SystemEvent, sessionUuid: string, cwd: string): object {
  return {
    timestamp: event.timestamp || new Date().toISOString(),
    type: 'session_meta',
    payload: {
      id: sessionUuid,
      timestamp: event.timestamp || new Date().toISOString(),
      cwd,
      originator: 'codex_cli_rs',
      cli_version: '0.111.0',
      source: 'cli',
      model_provider: 'openai',
    },
  };
}

function reconstructUserMessage(event: UserEvent): object | null {
  const content = event.message.content;

  // Tool result events — map to function_call_output
  if (Array.isArray(content)) {
    const results: object[] = [];
    for (const block of content) {
      if (block.type === 'tool_result' && 'tool_use_id' in block) {
        const output = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((b: any) => b.text || '').join('')
            : JSON.stringify(block.content || '');
        results.push({
          timestamp: event.timestamp || new Date().toISOString(),
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output,
          },
        });
      }
    }
    if (results.length > 0) return results as any;
  }

  // Plain text user message
  const text = typeof content === 'string' ? content : '';
  if (!text) return null;

  return {
    timestamp: event.timestamp || new Date().toISOString(),
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: text,
      images: [],
      local_images: [],
      text_elements: [],
    },
  };
}

function reconstructAssistantMessage(event: AssistantEvent): object[] {
  const lines: object[] = [];
  const content = event.message.content;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        lines.push({
          timestamp: event.timestamp || new Date().toISOString(),
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: block.text,
            phase: 'final_answer',
          },
        });
      } else if (block.type === 'tool_use' && 'id' in block && 'name' in block) {
        lines.push({
          timestamp: event.timestamp || new Date().toISOString(),
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
            call_id: block.id,
          },
        });
      }
    }
  } else if (typeof content === 'string') {
    lines.push({
      timestamp: event.timestamp || new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: content,
        phase: 'final_answer',
      },
    });
  }

  return lines;
}

function reconstructResult(event: ResultEvent): object {
  return {
    timestamp: event.timestamp || new Date().toISOString(),
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: uuidv4(),
      last_agent_message: event.result || '',
    },
  };
}

function reconstructControlRequest(event: ControlRequestEvent): object | null {
  const toolUse = event.request?.tool_use;
  if (!toolUse) return null;

  // Map AskUserQuestion back to request_user_input
  const name = toolUse.name === 'AskUserQuestion' ? 'request_user_input' : toolUse.name;

  return {
    timestamp: event.timestamp || new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'function_call',
      name,
      arguments: JSON.stringify(toolUse.input || {}),
      call_id: event.request_id || uuidv4(),
    },
  };
}

/**
 * Convert SessionEvent to zero or more Codex JSONL line objects.
 */
function toCodexJsonlLines(event: SessionEvent, sessionUuid: string, cwd: string): object[] {
  switch (event.type) {
    case 'system': {
      const se = event as SystemEvent;
      if (se.subtype === 'init') {
        return [reconstructSessionMeta(se, sessionUuid, cwd)];
      }
      return [];
    }
    case 'user': {
      const result = reconstructUserMessage(event as UserEvent);
      if (!result) return [];
      return Array.isArray(result) ? result : [result];
    }
    case 'assistant':
      return reconstructAssistantMessage(event as AssistantEvent);
    case 'result':
      return [reconstructResult(event as ResultEvent)];
    case 'control_request': {
      const cr = reconstructControlRequest(event as ControlRequestEvent);
      return cr ? [cr] : [];
    }
    default:
      return [];
  }
}

// ═══════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════

/**
 * Write SessionEvent[] as a Codex JSONL file for `codex resume`.
 * Path: ~/.codex/sessions/YYYY/MM/DD/rollout-{timestamp}-{uuid}.jsonl
 *
 * @returns The full path to the written JSONL file
 */
export function writeForkedCodexJsonl(
  events: SessionEvent[],
  targetUuid: string,
  directory: string,
): string {
  const dateDir = getDateDir();
  fs.mkdirSync(dateDir, { recursive: true });

  const filename = buildFilename(targetUuid);
  const jsonlPath = path.join(dateDir, filename);
  const cwd = directory || process.cwd();

  const lines: string[] = [];

  // Ensure there's a session_meta at the start
  const hasInit = events.some(e => e.type === 'system' && (e as SystemEvent).subtype === 'init');
  if (!hasInit) {
    lines.push(JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'session_meta',
      payload: {
        id: targetUuid,
        timestamp: new Date().toISOString(),
        cwd,
        originator: 'codex_cli_rs',
        cli_version: '0.111.0',
        source: 'cli',
        model_provider: 'openai',
      },
    }));
  }

  for (const event of events) {
    const codexLines = toCodexJsonlLines(event, targetUuid, cwd);
    for (const line of codexLines) {
      lines.push(JSON.stringify(line));
    }
  }

  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  console.log(`[codex-jsonl-writer] Reconstructed ${lines.length} lines to ${jsonlPath}`);
  return jsonlPath;
}
