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
import { writeForkedClaudeJsonl } from './claude/jsonl-writer.js';

const TAIL_EVENT_COUNT = 10;

/**
 * Extract the events to carry forward into a chain link:
 * - All user messages (to preserve the full conversation intent)
 * - Last N events of any type (to preserve recent context)
 * Deduplicated — if a user message is already in the last N, it's not doubled.
 */
function extractChainEvents(events: SessionEvent[]): SessionEvent[] {
  if (events.length === 0) return [];

  // Collect all user message events
  const userEvents: SessionEvent[] = events.filter(e => e.type === 'user');

  // Collect last N events
  const tailEvents = events.slice(-TAIL_EVENT_COUNT);

  // Merge: user events first, then tail events, deduplicated by uuid
  const seen = new Set<string>();
  const result: SessionEvent[] = [];

  for (const e of userEvents) {
    const key = e.uuid || JSON.stringify(e);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(e);
    }
  }

  for (const e of tailEvents) {
    const key = e.uuid || JSON.stringify(e);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(e);
    }
  }

  // Re-sort by original order to maintain conversation flow
  const indexMap = new Map<string, number>();
  events.forEach((e, i) => {
    const key = e.uuid || JSON.stringify(e);
    if (!indexMap.has(key)) indexMap.set(key, i);
  });

  result.sort((a, b) => {
    const aKey = a.uuid || JSON.stringify(a);
    const bKey = b.uuid || JSON.stringify(b);
    return (indexMap.get(aKey) ?? 0) - (indexMap.get(bKey) ?? 0);
  });

  // Inject chain context header into the first event
  if (result.length > 0) {
    const header = '[This is a chain continuation session. The messages below are carried forward from the previous session in this chain. For full context from earlier in the conversation, use the search_session_history tool with type "CurrentSessionChain".]';
    const first = result[0];
    if (first.type === 'user' && first.message) {
      const msg = first.message;
      const content = typeof msg.content === 'string'
        ? `${header}\n\n${msg.content}`
        : Array.isArray(msg.content)
          ? [{ type: 'text' as const, text: header }, ...msg.content]
          : msg.content;
      result[0] = { ...first, message: { ...msg, content } };
    }
  }

  return result;
}

/**
 * Build a chain link session from a source session's events.
 *
 * @param sourceEvents - Events from the source session
 * @param parentSessionId - The source session's ID (for parent-linking)
 * @param directory - The project working directory
 * @returns The new chain-linked session UUID, or null if source has no events
 */
export function buildChainSession(
  sourceEvents: SessionEvent[],
  parentSessionId: string,
  directory: string,
): string | null {
  if (sourceEvents.length === 0) return null;

  const chainEvents = extractChainEvents(sourceEvents);
  if (chainEvents.length === 0) return null;

  const chainUuid = buildLinkedUuid(parentSessionId, 'chain');
  writeForkedClaudeJsonl(chainEvents, chainUuid, directory);

  return chainUuid;
}
