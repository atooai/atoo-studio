/**
 * Map Gemini CLI session JSON messages → SessionEvent[].
 *
 * Gemini session files are single JSON objects with a `messages` array.
 * Each message has a `type` field: "user", "gemini", "error", "info".
 *
 * Gemini messages with tool calls embed them inline in `toolCalls[]`,
 * unlike Claude/Codex which use separate JSONL lines.
 */
import { v4 as uuidv4 } from 'uuid';
import type { SessionEvent } from '../../../events/types.js';

// ═══════════════════════════════════════════════════════
// Gemini session JSON types
// ═══════════════════════════════════════════════════════

export interface GeminiSessionJson {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: GeminiMessage[];
  kind: string;
  summary?: string;
}

export interface GeminiMessage {
  id: string;
  timestamp: string;
  type: 'user' | 'gemini' | 'error' | 'info';
  content: string | Array<{ text: string }>;
  thoughts?: Array<{ subject: string; description: string; timestamp: string }>;
  tokens?: {
    input: number;
    output: number;
    cached: number;
    thoughts: number;
    tool: number;
    total: number;
  };
  model?: string;
  toolCalls?: GeminiToolCall[];
}

export interface GeminiToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  result: Array<{
    functionResponse: {
      id: string;
      name: string;
      response: { output: string };
    };
  }>;
  status: string;
  timestamp?: string;
  resultDisplay?: any;
  displayName?: string;
  description?: string;
  renderOutputAsMarkdown?: boolean;
}

// ═══════════════════════════════════════════════════════
// Mapper
// ═══════════════════════════════════════════════════════

/**
 * Convert a single Gemini message into zero or more SessionEvents.
 */
export function mapGeminiMessage(msg: GeminiMessage): SessionEvent[] {
  switch (msg.type) {
    case 'user':
      return mapUserMessage(msg);
    case 'gemini':
      return mapGeminiResponse(msg);
    case 'error':
      return mapErrorMessage(msg);
    case 'info':
      // Info messages (update notifications, etc.) are not conversational
      return [];
    default:
      return [];
  }
}

// ───────────────────────────────────────────────────────
// user → UserEvent
// ───────────────────────────────────────────────────────

function mapUserMessage(msg: GeminiMessage): SessionEvent[] {
  const text = Array.isArray(msg.content)
    ? msg.content.map(c => c.text).join('\n')
    : String(msg.content);

  return [{
    type: 'user' as const,
    uuid: msg.id || uuidv4(),
    timestamp: msg.timestamp,
    message: {
      role: 'user' as const,
      content: text,
    },
  }];
}

// ───────────────────────────────────────────────────────
// gemini → AssistantEvent (+ ThinkingBlock + ToolUse/ToolResult)
// ───────────────────────────────────────────────────────

function mapGeminiResponse(msg: GeminiMessage): SessionEvent[] {
  const events: SessionEvent[] = [];
  const content: any[] = [];

  // Add thinking blocks from thoughts array
  if (msg.thoughts && msg.thoughts.length > 0) {
    const thinkingText = msg.thoughts
      .map(t => `**${t.subject}**: ${t.description}`)
      .join('\n\n');
    content.push({
      type: 'thinking' as const,
      thinking: thinkingText,
    });
  }

  // Add text content
  const textContent = typeof msg.content === 'string' ? msg.content : '';
  if (textContent) {
    content.push({
      type: 'text' as const,
      text: textContent,
    });
  }

  // Build usage info from tokens
  const usage = msg.tokens ? {
    input_tokens: msg.tokens.input,
    output_tokens: msg.tokens.output,
    cache_read_input_tokens: msg.tokens.cached,
  } : undefined;

  // If there are tool calls, add each as a tool_use block in the assistant message
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      content.push({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.args,
      });
    }
  }

  // Emit the assistant event with all content blocks
  if (content.length > 0) {
    events.push({
      type: 'assistant' as const,
      uuid: msg.id || uuidv4(),
      timestamp: msg.timestamp,
      message: {
        role: 'assistant' as const,
        model: msg.model,
        usage,
        content,
      },
    });
  }

  // Emit tool result events (as user events with tool_result blocks)
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      const output = tc.result?.[0]?.functionResponse?.response?.output || '';
      events.push({
        type: 'user' as const,
        uuid: uuidv4(),
        timestamp: tc.timestamp || msg.timestamp,
        message: {
          role: 'user' as const,
          content: [{
            type: 'tool_result' as const,
            tool_use_id: tc.id,
            content: output,
          }],
        },
      });
    }
  }

  return events;
}

// ───────────────────────────────────────────────────────
// error → SystemEvent
// ───────────────────────────────────────────────────────

function mapErrorMessage(msg: GeminiMessage): SessionEvent[] {
  return [{
    type: 'system' as const,
    uuid: msg.id || uuidv4(),
    timestamp: msg.timestamp,
    subtype: 'error',
    content: String(msg.content),
  }];
}
