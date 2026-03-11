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
import { findMostRecentCodexSession } from '../session-precreate.js';

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

function reconstructUserMessage(event: UserEvent): object[] {
  const content = event.message.content;
  const ts = event.timestamp || new Date().toISOString();

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
          timestamp: ts,
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output,
          },
        });
      }
    }
    if (results.length > 0) return results;
  }

  // Plain text user message — handle both string and array-of-text-blocks formats
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // Extract text from text blocks (e.g. [{ type: 'text', text: '...' }])
    text = content
      .filter((b: any) => b.type === 'text' || b.type === 'input_text')
      .map((b: any) => b.text || '')
      .join('\n');
  }
  if (!text) return [];

  return [
    // response_item with role:"user" — this is what Codex uses to rebuild context
    {
      timestamp: ts,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    },
    // event_msg for UI display
    {
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: text,
        images: [],
        local_images: [],
        text_elements: [],
      },
    },
  ];
}

function reconstructAssistantMessage(event: AssistantEvent): object[] {
  const lines: object[] = [];
  const content = event.message.content;
  const ts = event.timestamp || new Date().toISOString();

  // Collect text blocks for the response_item with role:"assistant"
  const outputTextBlocks: object[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        outputTextBlocks.push({ type: 'output_text', text: block.text });
        // event_msg for UI display
        lines.push({
          timestamp: ts,
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: block.text,
            phase: 'final_answer',
          },
        });
      } else if (block.type === 'tool_use' && 'id' in block && 'name' in block) {
        lines.push({
          timestamp: ts,
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
    outputTextBlocks.push({ type: 'output_text', text: content });
    lines.push({
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: content,
        phase: 'final_answer',
      },
    });
  }

  // response_item with role:"assistant" — this is what Codex uses to rebuild context
  if (outputTextBlocks.length > 0) {
    lines.push({
      timestamp: ts,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: outputTextBlocks,
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

function reconstructTurnContext(turnId: string, cwd: string, model: string): object {
  return {
    timestamp: new Date().toISOString(),
    type: 'turn_context',
    payload: {
      turn_id: turnId,
      cwd,
      current_date: new Date().toISOString().split('T')[0],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      approval_policy: 'on-request',
      sandbox_policy: {
        type: 'workspace-write',
        writable_roots: [],
        network_access: false,
        exclude_tmpdir_env_var: false,
        exclude_slash_tmp: false,
      },
      model,
      personality: 'pragmatic',
      collaboration_mode: { mode: 'default', settings: {} },
      realtime_active: false,
      summary: 'none',
      user_instructions: '',
      truncation_policy: { mode: 'tokens', limit: 10000 },
    },
  };
}

function reconstructTaskStarted(turnId: string, ts: string): object {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'task_started',
      turn_id: turnId,
      model_context_window: 258400,
      collaboration_mode_kind: 'default',
    },
  };
}

function reconstructTaskComplete(turnId: string, ts: string, lastMessage: string): object {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: lastMessage,
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
      return reconstructUserMessage(event as UserEvent);
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
 * Group events into turns (user message + following assistant/result events).
 * Each turn gets wrapped with task_started, turn_context, task_complete.
 */
function groupIntoTurns(events: SessionEvent[]): { system: SessionEvent[]; turns: SessionEvent[][] } {
  const system: SessionEvent[] = [];
  const turns: SessionEvent[][] = [];
  let currentTurn: SessionEvent[] = [];

  for (const event of events) {
    if (event.type === 'system') {
      system.push(event);
      continue;
    }
    // Skip non-conversation events (progress, last-prompt, etc.)
    if (!['user', 'assistant', 'result', 'control_request'].includes(event.type)) {
      continue;
    }
    if (event.type === 'user') {
      // Tool results belong to the current turn, not a new one
      const ue = event as UserEvent;
      const content = ue.message.content;
      const isToolResult = Array.isArray(content) && content.some((b: any) => b.type === 'tool_result');
      if (!isToolResult && currentTurn.length > 0) {
        turns.push(currentTurn);
        currentTurn = [];
      }
    }
    currentTurn.push(event);
  }
  if (currentTurn.length > 0) turns.push(currentTurn);

  return { system, turns };
}

/**
 * Extract the last assistant text message from a turn for task_complete.
 */
function getLastAssistantText(turn: SessionEvent[]): string {
  for (let i = turn.length - 1; i >= 0; i--) {
    if (turn[i].type === 'assistant') {
      const ae = turn[i] as AssistantEvent;
      const content = ae.message.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const textBlock = [...content].reverse().find((b: any) => b.type === 'text');
        if (textBlock && 'text' in textBlock) return (textBlock as any).text;
      }
    }
  }
  return '';
}

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
  const model = 'gpt-5.4';

  const lines: string[] = [];

  // Ensure there's a session_meta + developer prompt at the start.
  // Codex CLI requires the developer prompt (permissions, sandbox config) to resume.
  // Clone the header (session_meta + developer prompt) from the most recent real session.
  const hasInit = events.some(e => e.type === 'system' && (e as SystemEvent).subtype === 'init');
  if (!hasInit) {
    const donorFile = findMostRecentCodexSession();
    if (donorFile) {
      try {
        const donorContent = fs.readFileSync(donorFile, 'utf-8');
        const donorLines = donorContent.split('\n').filter(l => l.trim());
        const headerLines = donorLines.slice(0, 2); // session_meta + developer prompt

        // Extract donor UUID to replace with ours
        const donorMeta = JSON.parse(headerLines[0]);
        const donorUuid = donorMeta?.payload?.id;

        for (const line of headerLines) {
          const replaced = donorUuid ? line.replace(new RegExp(donorUuid, 'g'), targetUuid) : line;
          lines.push(replaced);
        }
      } catch {
        // Fallback to minimal session_meta if donor read fails
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
    } else {
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
  }

  const { system, turns } = groupIntoTurns(events);

  // Emit system events (session_meta from init)
  for (const event of system) {
    const codexLines = toCodexJsonlLines(event, targetUuid, cwd);
    for (const line of codexLines) {
      lines.push(JSON.stringify(line));
    }
  }

  // Emit each turn with proper Codex structure
  for (const turn of turns) {
    const turnId = uuidv4();
    const turnTs = turn[0]?.timestamp || new Date().toISOString();

    // task_started
    lines.push(JSON.stringify(reconstructTaskStarted(turnId, turnTs)));

    // turn_context
    lines.push(JSON.stringify(reconstructTurnContext(turnId, cwd, model)));

    // Turn events (response_items + event_msgs)
    for (const event of turn) {
      const codexLines = toCodexJsonlLines(event, targetUuid, cwd);
      for (const line of codexLines) {
        lines.push(JSON.stringify(line));
      }
    }

    // task_complete
    const lastMsg = getLastAssistantText(turn);
    const lastTs = turn[turn.length - 1]?.timestamp || new Date().toISOString();
    lines.push(JSON.stringify(reconstructTaskComplete(turnId, lastTs, lastMsg)));
  }

  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  console.log(`[codex-jsonl-writer] Reconstructed ${lines.length} lines to ${jsonlPath}`);
  return jsonlPath;
}
