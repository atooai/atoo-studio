import { v4 as uuidv4 } from 'uuid';
import type {
  AbstractMessage,
  UserMessage,
  AssistantMessage,
  ToolRequest,
  ToolResult,
  Question,
  QuestionItem,
  PlanApproval,
  StatusUpdate,
  SystemMessage,
  ResultMessage,
  ContextUsage,
  ThinkingMessage,
} from '../types.js';

/**
 * Check if text contains ANSI escape codes.
 */
function hasAnsi(text: string): boolean {
  return /\x1b\[/.test(text);
}

/**
 * Extract text from event content (string or array of content blocks).
 */
function getEventText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: any) => b.text || b.content || '').join('');
  }
  return '';
}

/**
 * Try to parse /context output for token usage info.
 * Returns a ContextUsage message if found, null otherwise.
 */
export function tryParseContextUsageMsg(sessionId: string, msg: any): ContextUsage | null {
  let text = '';
  const content = msg.message?.content;
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

/**
 * Pure function: maps a raw Claude ingress event to zero or more AbstractMessages.
 *
 * @param sessionId - The UI-facing session ID
 * @param rawEvent - Raw event from Claude CLI ingress
 * @param pendingToolUses - Map tracking tool_use blocks for correlation
 * @returns Array of AbstractMessages (may be empty for filtered events)
 */
export function mapIngressEvent(
  sessionId: string,
  rawEvent: any,
  pendingToolUses: Map<string, { name: string; input: any }>,
): AbstractMessage[] {
  const messages: AbstractMessage[] = [];
  const now = Date.now();

  if (rawEvent.type === 'assistant' && rawEvent.message) {
    const msg = rawEvent.message;
    // Skip synthetic messages (model === '<synthetic>')
    if (msg.model === '<synthetic>') return messages;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'thinking' && block.thinking) {
          messages.push({
            id: uuidv4(),
            sessionId,
            timestamp: now,
            type: 'thinking',
            text: block.thinking,
          } as ThinkingMessage);
        } else if (block.type === 'text') {
          if (hasAnsi(block.text)) continue;
          messages.push({
            id: uuidv4(),
            sessionId,
            timestamp: now,
            type: 'assistant_message',
            text: block.text,
          } as AssistantMessage);
        } else if (block.type === 'tool_use' && block.id && block.name) {
          // Index for later correlation — the tool_request comes when control_request arrives
          pendingToolUses.set(block.id, {
            name: block.name,
            input: block.input || {},
          });
          // Emit a pending tool_result so the frontend shows it immediately
          messages.push({
            id: block.id,
            sessionId,
            timestamp: now,
            type: 'tool_result',
            requestId: block.id,
            toolName: block.name,
            input: block.input || {},
            output: '',
            isError: false,
            isPending: true,
          } as ToolResult);
        }
      }
    } else if (typeof msg.content === 'string') {
      if (!hasAnsi(msg.content)) {
        messages.push({
          id: uuidv4(),
          sessionId,
          timestamp: now,
          type: 'assistant_message',
          text: msg.content,
        } as AssistantMessage);
      }
    }
  } else if (rawEvent.type === 'control_request') {
    // Skip initialize requests
    if (rawEvent.request?.subtype === 'initialize') {
      return messages;
    }

    // Extract tool info — handle both formats:
    // 1. tool_use subtype: request.tool_use = { name, input }
    // 2. can_use_tool subtype: request.tool_name, request.input (flat)
    const toolUse = rawEvent.request?.tool_use;
    const toolName = toolUse?.name || rawEvent.request?.tool_name || '';
    const toolInput = toolUse?.input || rawEvent.request?.input || {};

    // Use request_id for control request/response correlation (protocol field)
    const controlRequestId = rawEvent.request_id || rawEvent.uuid || uuidv4();

    if (toolName === 'AskUserQuestion') {
      const rawQuestions = toolInput.questions || [];
      const typedQuestions: QuestionItem[] = rawQuestions.map((q: any) => ({
        question: q.question || '',
        header: q.header,
        options: Array.isArray(q.options) ? q.options.map((o: any) => ({
          label: o.label || '',
          description: o.description,
        })) : [],
        allowFreeInput: true,
        multiSelect: !!q.multiSelect,
      }));
      messages.push({
        id: rawEvent.uuid || controlRequestId,
        sessionId,
        timestamp: now,
        type: 'question',
        requestId: controlRequestId,
        questions: typedQuestions,
        responded: false,
      } as Question);
    } else if (toolName === 'ExitPlanMode') {
      messages.push({
        id: rawEvent.uuid || controlRequestId,
        sessionId,
        timestamp: now,
        type: 'plan_approval',
        requestId: controlRequestId,
        plan: toolInput.plan || '',
        responded: false,
      } as PlanApproval);
    } else {
      // Regular tool request
      const requestId = controlRequestId;
      const name = toolName || rawEvent.request?.subtype || 'unknown';
      const input = Object.keys(toolInput).length > 0 ? toolInput : (rawEvent.request || {});

      // Build description from tool input
      let description: string | undefined;
      if (name === 'Bash' && input.command) {
        description = input.command.substring(0, 200);
      } else if ((name === 'Edit' || name === 'Write') && input.file_path) {
        description = input.file_path;
      } else if (name === 'Read' && input.file_path) {
        description = input.file_path;
      }

      messages.push({
        id: requestId,
        sessionId,
        timestamp: now,
        type: 'tool_request',
        requestId,
        toolName: name,
        input,
        description,
        responded: false,
      } as ToolRequest);
    }
  } else if (rawEvent.type === 'user' && rawEvent.message) {
    if (rawEvent.isSynthetic) return messages;

    const content = rawEvent.message.content;

    // Handle tool_result blocks
    if (Array.isArray(content)) {
      // Check if all blocks are tool_result
      const allToolResults = content.every((b: any) => b.type === 'tool_result');
      if (allToolResults) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const toolUse = pendingToolUses.get(block.tool_use_id);
            const toolName = toolUse?.name || 'unknown';
            const output = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((b: any) => b.text || '').join('')
                : JSON.stringify(block.content || '');

            messages.push({
              id: uuidv4(),
              sessionId,
              timestamp: now,
              type: 'tool_result',
              requestId: block.tool_use_id,
              toolName,
              input: toolUse?.input,
              output: output.substring(0, 5000),
              isError: !!block.is_error,
            } as ToolResult);

            pendingToolUses.delete(block.tool_use_id);
          }
        }
        return messages;
      }
    }

    // Regular user message
    const text = getEventText(content);
    // Skip slash commands, CLI XML-tagged commands, and ANSI output
    if (text.startsWith('/') || hasAnsi(text)) return messages;
    if (/<command-name>|<local-command-caveat>|<command-message>/.test(text)) return messages;

    const displayContent = typeof content === 'string' ? content : text;
    if (displayContent) {
      messages.push({
        id: rawEvent.uuid || uuidv4(),
        sessionId,
        timestamp: now,
        type: 'user_message',
        text: displayContent,
      } as UserMessage);
    }
  } else if (rawEvent.type === 'result') {
    messages.push({
      id: rawEvent.uuid || uuidv4(),
      sessionId,
      timestamp: now,
      type: 'result',
      subtype: rawEvent.subtype,
      summary: rawEvent.result,
    } as ResultMessage);
  } else if (rawEvent.type === 'system' && rawEvent.subtype === 'init') {
    messages.push({
      id: rawEvent.uuid || uuidv4(),
      sessionId,
      timestamp: now,
      type: 'status_update',
      status: 'idle',
      model: rawEvent.model,
      mode: rawEvent.permissionMode,
    } as StatusUpdate);
  } else if (rawEvent.type === 'system' && rawEvent.subtype === 'status') {
    if (rawEvent.permissionMode) {
      messages.push({
        id: rawEvent.uuid || uuidv4(),
        sessionId,
        timestamp: now,
        type: 'status_update',
        status: 'idle',
        mode: rawEvent.permissionMode,
      } as StatusUpdate);
    }
  }
  // Skip: stream_event, rate_limit_event, prompt_suggestion, ANSI-only messages

  // Attach raw event to all produced messages
  for (const msg of messages) {
    msg.rawEvent = rawEvent;
  }

  return messages;
}
