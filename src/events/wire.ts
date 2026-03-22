/**
 * WireMessage — slim projection of SessionEvent for frontend display.
 * Replaces the AbstractMessage hierarchy and mapIngressEvent().
 */
import { v4 as uuidv4 } from 'uuid';
import type {
  SessionEvent,
  AssistantEvent,
  UserEvent,
  ControlRequestEvent,
  ResultEvent,
  SystemEvent,
} from './types.js';

// ═══════════════════════════════════════════════════════
// WireMessage types
// ═══════════════════════════════════════════════════════

export interface WireBase {
  id: string;
  sessionId: string;
  timestamp: number;
  rawEventUuid?: string;
  _sidechain?: boolean;
  _parentToolUseId?: string;
  _agentId?: string;
}

export interface WireUserMessage extends WireBase {
  type: 'user_message';
  text: string;
  attachments?: WireAttachment[];
}

export interface WireAssistantMessage extends WireBase {
  type: 'assistant_message';
  text: string;
  isPartial?: boolean;
  rawJson?: string;
}

export interface WireThinking extends WireBase {
  type: 'thinking';
  text: string;
}

export interface WireToolUse extends WireBase {
  type: 'tool_result';
  requestId: string;
  toolName: string;
  input?: any;
  output: string;
  isError: boolean;
  isPending?: boolean;
}

export interface WireToolRequest extends WireBase {
  type: 'tool_request';
  requestId: string;
  toolName: string;
  input: any;
  description?: string;
  responded: boolean;
  response?: 'approved' | 'denied';
}

export interface WireQuestion extends WireBase {
  type: 'question';
  requestId: string;
  questions: WireQuestionItem[];
  responded: boolean;
}

export interface WireQuestionItem {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  allowFreeInput?: boolean;
  multiSelect?: boolean;
}

export interface WirePlanApproval extends WireBase {
  type: 'plan_approval';
  requestId: string;
  plan: string;
  responded: boolean;
  response?: 'approved' | 'denied';
}

export interface WireStatusUpdate extends WireBase {
  type: 'status_update';
  status: 'initializing' | 'idle' | 'active' | 'waiting' | 'error' | 'exited';
  mode?: string;
  model?: string;
}

export interface WireContextUsage extends WireBase {
  type: 'context_usage';
  model: string;
  usedTokens: number;
  totalTokens: number;
  percent: number;
  freePercent: number;
}

export interface WireSystemMessage extends WireBase {
  type: 'system_message';
  text: string;
  subtype?: string;
}

export interface WireResult extends WireBase {
  type: 'result';
  subtype?: string;
  summary?: string;
}

export interface WireAttachment {
  media_type: string;
  data: string;
  name?: string;
  text?: string;
}

export type WireMessage =
  | WireUserMessage
  | WireAssistantMessage
  | WireThinking
  | WireToolUse
  | WireToolRequest
  | WireQuestion
  | WirePlanApproval
  | WireStatusUpdate
  | WireContextUsage
  | WireSystemMessage
  | WireResult;

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function hasAnsi(text: string): boolean {
  return /\x1b\[/.test(text);
}

function getEventText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: any) => b.text || b.content || '').join('');
  }
  return '';
}

// ═══════════════════════════════════════════════════════
// toWireMessages — SessionEvent → WireMessage[]
// ═══════════════════════════════════════════════════════

/**
 * Convert a SessionEvent to zero or more WireMessages for frontend display.
 * This replaces mapIngressEvent() from claude-message-mapper.ts.
 *
 * @param uiSessionId - The UI-facing session ID (agent session ID)
 * @param event - Raw SessionEvent
 * @param pendingToolUses - Map tracking tool_use blocks for correlation
 * @returns Array of WireMessages (may be empty for filtered events)
 */
export function toWireMessages(
  uiSessionId: string,
  event: SessionEvent,
  pendingToolUses: Map<string, { name: string; input: any }>,
): WireMessage[] {
  const messages: WireMessage[] = [];
  const now = Date.now();

  if (event.type === 'assistant') {
    const msg = (event as AssistantEvent).message;
    // Skip synthetic messages
    if (msg.model === '<synthetic>') return messages;
    // Serialize raw event once for RAW mode display
    let rawJson: string | undefined;
    try { rawJson = JSON.stringify(event); } catch {}
    let rawAttached = false;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'thinking' && 'thinking' in block) {
          messages.push({
            id: uuidv4(),
            sessionId: uiSessionId,
            timestamp: now,
            type: 'thinking',
            text: block.thinking,
          });
        } else if (block.type === 'text') {
          if (hasAnsi(block.text)) continue;
          const wireMsg: WireAssistantMessage = {
            id: uuidv4(),
            sessionId: uiSessionId,
            timestamp: now,
            type: 'assistant_message',
            text: block.text,
          };
          if (!rawAttached && rawJson) { wireMsg.rawJson = rawJson; rawAttached = true; }
          messages.push(wireMsg);
        } else if (block.type === 'tool_use' && 'id' in block && 'name' in block) {
          pendingToolUses.set(block.id, {
            name: block.name,
            input: block.input || {},
          });
          messages.push({
            id: block.id,
            sessionId: uiSessionId,
            timestamp: now,
            type: 'tool_result',
            requestId: block.id,
            toolName: block.name,
            input: block.input || {},
            output: '',
            isError: false,
            isPending: true,
          });
        }
      }
    } else if (typeof msg.content === 'string') {
      if (!hasAnsi(msg.content)) {
        const wireMsg: WireAssistantMessage = {
          id: uuidv4(),
          sessionId: uiSessionId,
          timestamp: now,
          type: 'assistant_message',
          text: msg.content,
        };
        if (rawJson) wireMsg.rawJson = rawJson;
        messages.push(wireMsg);
      }
    }
  } else if (event.type === 'control_request') {
    const cr = event as ControlRequestEvent;
    if (cr.request?.subtype === 'initialize') return messages;

    const toolUse = cr.request?.tool_use;
    const toolName = toolUse?.name || cr.request?.tool_name || '';
    const toolInput = toolUse?.input || cr.request?.input || {};
    const controlRequestId = cr.request_id || cr.uuid || uuidv4();

    if (toolName === 'AskUserQuestion') {
      const rawQuestions = (toolInput as any).questions || [];
      const typedQuestions: WireQuestionItem[] = rawQuestions.map((q: any) => ({
        question: q.question || '',
        header: q.header,
        options: Array.isArray(q.options)
          ? q.options.map((o: any) => ({ label: o.label || '', description: o.description }))
          : [],
        allowFreeInput: true,
        multiSelect: !!q.multiSelect,
      }));
      messages.push({
        id: cr.uuid || controlRequestId,
        sessionId: uiSessionId,
        timestamp: now,
        type: 'question',
        requestId: controlRequestId,
        questions: typedQuestions,
        responded: false,
      });
    } else if (toolName === 'ExitPlanMode') {
      messages.push({
        id: cr.uuid || controlRequestId,
        sessionId: uiSessionId,
        timestamp: now,
        type: 'plan_approval',
        requestId: controlRequestId,
        plan: (toolInput as any).plan || '',
        responded: false,
      });
    } else {
      const name = toolName || cr.request?.subtype || 'unknown';
      const input = Object.keys(toolInput).length > 0 ? toolInput : (cr.request || {});

      let description: string | undefined;
      if (name === 'Bash' && (input as any).command) {
        description = (input as any).command.substring(0, 200);
      } else if ((name === 'Edit' || name === 'Write') && (input as any).file_path) {
        description = (input as any).file_path;
      } else if (name === 'Read' && (input as any).file_path) {
        description = (input as any).file_path;
      }

      messages.push({
        id: controlRequestId,
        sessionId: uiSessionId,
        timestamp: now,
        type: 'tool_request',
        requestId: controlRequestId,
        toolName: name,
        input,
        description,
        responded: false,
      });
    }
  } else if (event.type === 'user') {
    const ue = event as UserEvent;
    if (ue.isSynthetic) return messages;

    const content = ue.message.content;

    // Handle tool_result blocks
    if (Array.isArray(content)) {
      const allToolResults = content.every((b: any) => b.type === 'tool_result');
      if (allToolResults) {
        for (const block of content) {
          if (block.type === 'tool_result' && 'tool_use_id' in block) {
            const toolUse = pendingToolUses.get(block.tool_use_id);
            const toolName = toolUse?.name || 'unknown';
            const output = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((b: any) => b.text || '').join('')
                : JSON.stringify(block.content || '');

            messages.push({
              id: uuidv4(),
              sessionId: uiSessionId,
              timestamp: now,
              type: 'tool_result',
              requestId: block.tool_use_id,
              toolName,
              input: toolUse?.input,
              output: output.substring(0, 5000),
              isError: !!block.is_error,
            });

            pendingToolUses.delete(block.tool_use_id);
          }
        }
        return messages;
      }
    }

    // Regular user message
    const text = getEventText(content);
    if (text.startsWith('/') || hasAnsi(text)) return messages;
    if (/<command-name>|<local-command-caveat>|<command-message>/.test(text)) return messages;

    const displayContent = typeof content === 'string' ? content : text;
    if (displayContent) {
      messages.push({
        id: event.uuid || uuidv4(),
        sessionId: uiSessionId,
        timestamp: now,
        type: 'user_message',
        text: displayContent,
      });
    }
  } else if (event.type === 'result') {
    const re = event as ResultEvent;
    messages.push({
      id: re.uuid || uuidv4(),
      sessionId: uiSessionId,
      timestamp: now,
      type: 'result',
      subtype: re.subtype,
      summary: re.result,
    });
  } else if (event.type === 'system' && (event as SystemEvent).subtype === 'init') {
    const se = event as SystemEvent;
    messages.push({
      id: se.uuid || uuidv4(),
      sessionId: uiSessionId,
      timestamp: now,
      type: 'status_update',
      status: 'idle',
      model: se.model,
      mode: se.permissionMode,
    });
  } else if (event.type === 'system' && (event as SystemEvent).subtype === 'status') {
    const se = event as SystemEvent;
    if (se.permissionMode) {
      messages.push({
        id: se.uuid || uuidv4(),
        sessionId: uiSessionId,
        timestamp: now,
        type: 'status_update',
        status: 'idle',
        mode: se.permissionMode,
      });
    }
  }
  // Skip: progress, file-history-snapshot, last-prompt, queue-operation, control_response

  // Tag all produced messages with the source event UUID
  const eventUuid = event.uuid;
  if (eventUuid) {
    for (const msg of messages) {
      msg.rawEventUuid = eventUuid;
    }
  }

  return messages;
}

/**
 * Try to parse /context output for token usage info.
 * Returns a WireContextUsage message if found, null otherwise.
 */
export function tryParseContextUsageWire(sessionId: string, event: SessionEvent): WireContextUsage | null {
  if (event.type !== 'user' && event.type !== 'system') return null;

  let text = '';
  const content = (event as any).message?.content;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.map((b: any) => b.text || (typeof b.content === 'string' ? b.content : '') || '').join('');
  }
  if (!text || !hasAnsi(text)) return null;

  const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const tokenMatch = clean.match(/([\w.-]+)\s*[·•]\s*([\d.]+)k?\/([\d.]+)k?\s*tokens?\s*\((\d+)%\)/);
  if (!tokenMatch) return null;

  const model = tokenMatch[1];
  const usedTokens = Math.round(parseFloat(tokenMatch[2]) * 1000);
  const totalTokens = Math.round(parseFloat(tokenMatch[3]) * 1000);
  const usedPercent = parseInt(tokenMatch[4], 10);

  const freeMatch = clean.match(/Free\s+space:\s*([\d.]+)k?\s*\(([\d.]+)%\)/);
  const freePercent = freeMatch ? parseFloat(freeMatch[2]) : (100 - usedPercent);

  return {
    id: uuidv4(),
    sessionId,
    timestamp: Date.now(),
    type: 'context_usage',
    model,
    usedTokens,
    totalTokens,
    percent: usedPercent,
    freePercent,
  };
}
