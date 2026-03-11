/**
 * Chain builder: creates a new chain-linked session from a source session.
 *
 * Instead of compacting context (which loses information), a chain link:
 * 1. Carries forward the last N log entries + all user messages from the source
 * 2. Tells the LLM to use search_session_history(CurrentSessionChain) for deeper context
 * 3. Links to the source via the session ID schema ({parent-last16}c{random15})
 */
import type { SessionEvent } from '../../events/types.js';
import { buildLinkedUuid } from './session-id-utils.js';

const MAX_PAIRS = 10;

/**
 * Extract text from an assistant event's content, stripping tool_use blocks and thinking.
 * Returns only the final text response, or null if there's no text.
 */
function extractAssistantText(event: SessionEvent): string | null {
  const content = (event as any).message?.content;
  if (typeof content === 'string') return content || null;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text || '');
    const joined = texts.join('\n').trim();
    return joined || null;
  }
  return null;
}

/**
 * Extract the last N user messages + their final assistant text responses.
 * No tool calls, no tool results, no thinking, no intermediate events —
 * just the clean conversation thread.
 */
function extractChainEvents(events: SessionEvent[]): SessionEvent[] {
  if (events.length === 0) return [];

  // Walk through events and pair each real user text message with the
  // last assistant text response before the next user message.
  // Also count hidden events (tool calls, tool results, thinking, etc.)
  // between each user message so we can inform the LLM.
  const pairs: { user: SessionEvent; assistant: SessionEvent | null; hiddenCount: number }[] = [];
  let lastUserIdx = -1;
  let hiddenCount = 0;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];

    // Real user text message (not tool_result)
    if (e.type === 'user') {
      const content = (e as any).message?.content;
      const isToolResult = Array.isArray(content) && content.some((b: any) => b.type === 'tool_result');
      if (isToolResult) {
        hiddenCount++;
        continue;
      }

      // Attribute accumulated hidden events to the previous pair
      if (lastUserIdx >= 0) {
        pairs[lastUserIdx].hiddenCount = hiddenCount;
      }
      hiddenCount = 0;

      pairs.push({ user: e, assistant: null, hiddenCount: 0 });
      lastUserIdx = pairs.length - 1;
    } else if (e.type === 'assistant' && lastUserIdx >= 0) {
      const text = extractAssistantText(e);
      if (text) {
        // Build a clean assistant event with text-only content
        pairs[lastUserIdx].assistant = {
          ...e,
          message: {
            ...(e as any).message,
            content: [{ type: 'text' as const, text }],
          },
        } as SessionEvent;
      }
      // Count assistant events with only tool_use (no text) as hidden
      if (!text) hiddenCount++;
    } else {
      // All other event types (progress, system, result, etc.) are hidden
      hiddenCount++;
    }
  }
  // Attribute final hidden count to last pair
  if (lastUserIdx >= 0) {
    pairs[lastUserIdx].hiddenCount = hiddenCount;
  }

  if (pairs.length === 0) return [];

  // Take the last N pairs
  const selected = pairs.slice(-MAX_PAIRS);

  // Flatten to event list: user, assistant, user, assistant, ...
  // Prepend hidden count to assistant responses
  const result: SessionEvent[] = [];
  for (const pair of selected) {
    result.push(pair.user);
    if (pair.assistant && pair.hiddenCount > 0) {
      const a = pair.assistant as any;
      const text = a.message.content[0].text;
      result.push({
        ...a,
        message: {
          ...a.message,
          content: [{ type: 'text' as const, text: `[${pair.hiddenCount} intermediate tool calls/results hidden]\n\n${text}` }],
        },
      } as SessionEvent);
    } else if (pair.assistant) {
      result.push(pair.assistant);
    }
  }

  // Inject chain context header into the first user message
  if (result.length > 0) {
    const header = '[This is a chain continuation session. The messages below are carried forward from the previous session in this chain. For full context from earlier in the conversation, use the search_session_history tool with type "CurrentSessionChain".]';
    const first = result[0] as any;
    const msg = first.message;
    const content = typeof msg.content === 'string'
      ? `${header}\n\n${msg.content}`
      : Array.isArray(msg.content)
        ? [{ type: 'text' as const, text: header }, ...msg.content]
        : msg.content;
    result[0] = { ...first, message: { ...msg, content } } as SessionEvent;
  }

  return result;
}

/**
 * Build chain link events and UUID from a source session's events.
 * Does NOT write to disk — the caller decides which format to write (Claude/Codex).
 *
 * @param sourceEvents - Events from the source session
 * @param parentSessionId - The source session's ID (for parent-linking)
 * @returns { uuid, events } or null if source has no conversation content
 */
export function buildChainSession(
  sourceEvents: SessionEvent[],
  parentSessionId: string,
): { uuid: string; events: SessionEvent[] } | null {
  if (sourceEvents.length === 0) return null;

  const chainEvents = extractChainEvents(sourceEvents);
  if (chainEvents.length === 0) return null;

  // Verify there are actual conversational events (user/assistant) that will
  // survive JSONL reconstruction. Non-conversational events (progress, etc.)
  // are filtered out by the writers, which would produce an empty file.
  const CONVERSATIONAL_TYPES = new Set(['user', 'assistant', 'system', 'result', 'control_request', 'control_response']);
  const hasConversation = chainEvents.some(e => CONVERSATIONAL_TYPES.has(e.type));
  if (!hasConversation) return null;

  const chainUuid = buildLinkedUuid(parentSessionId, 'chain');
  return { uuid: chainUuid, events: chainEvents };
}
