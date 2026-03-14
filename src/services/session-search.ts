import fs from 'fs';
import path from 'path';
import os from 'os';
import { agentRegistry } from '../agents/registry.js';
import { walkChain } from '../agents/lib/session-id-utils.js';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// --- Types ---

interface ParsedMessage {
  role: string;
  text: string;
}

interface SearchMatch {
  session: number;     // 1-indexed session/chainlink number
  message: number;     // 1-indexed message number within session
  text: string;        // formatted: [role] snippet
}

interface SessionInfo {
  number: number;
  uuid: string;
}

interface SearchResult {
  results: SearchMatch[];
  totalMatches: number;
  sessionsSearched: number;
  sessions: SessionInfo[];  // deduplicated list of sessions that had matches
}

interface RangeMessage {
  message: number;
  text: string;        // formatted: [role] full text
}

interface RangeResult {
  session: number;
  uuid: string | null;
  messages: RangeMessage[];
  totalMessages: number;
}

export type SearchType = 'FullProjectSearch' | 'CurrentSessionChain';
export type SortOrder = 'newest_first' | 'oldest_first';

export interface SearchOptions {
  type?: SearchType;
  sessionUuid?: string;
  sort?: SortOrder;
}

export interface RangeOptions {
  type?: SearchType;
  sessionUuid?: string;
  sort?: SortOrder;
  session?: number;          // session/chainlink number (1-indexed)
  targetSessionUuid?: string; // UUID of the session to fetch from (alternative to session number)
  from: number;              // start message number (inclusive)
  to: number;                // end message number (inclusive)
}

// --- Helpers ---

function extractUuidFromPath(filePath: string): string | null {
  const basename = path.basename(filePath, '.jsonl');
  const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  return uuidMatch ? uuidMatch[1] : null;
}

/**
 * Filter session files to only those in the current session chain.
 * Returns files in chain order: oldest ancestor first (index 0 = chainlink 1).
 */
function filterChainFiles(allFiles: string[], sessionUuid: string): string[] {
  const uuidToFile = new Map<string, string>();
  const allUuids: string[] = [];
  for (const f of allFiles) {
    const uuid = extractUuidFromPath(f);
    if (uuid) {
      uuidToFile.set(uuid, f);
      allUuids.push(uuid);
    }
  }

  const chainUuids = walkChain(sessionUuid, allUuids);

  // Return files in chain order (oldest first), excluding current session
  const chainFiles: string[] = [];
  for (const uuid of chainUuids) {
    if (uuid === sessionUuid) continue;
    const file = uuidToFile.get(uuid);
    if (file) chainFiles.push(file);
  }
  return chainFiles;
}

function buildRegex(query: string): RegExp {
  try {
    return new RegExp(query, 'i');
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

/**
 * Parse a JSONL line into a structured message with role and full text.
 * Returns null for non-message events (file-history-snapshot, empty, unparseable).
 */
function parseJsonlMessage(jsonLine: string): ParsedMessage | null {
  if (!jsonLine.trim()) return null;

  try {
    const event = JSON.parse(jsonLine);
    if (event.type === 'file-history-snapshot') return null;

    // Detect Codex JSONL format: {type: "event_msg"|"response_item", payload: {...}}
    if (event.payload && (event.type === 'event_msg' || event.type === 'response_item')) {
      return parseCodexJsonlMessage(event);
    }

    const role = event.message?.role || event.type || 'unknown';
    let text = '';

    if (event.message?.content) {
      const content = event.message.content;
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'tool_use' && block.input) {
            const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
            parts.push(`[tool:${block.name}] ${inputStr}`);
          } else if (block.type === 'tool_result' && block.content) {
            if (typeof block.content === 'string') {
              parts.push(block.content);
            } else if (Array.isArray(block.content)) {
              for (const sub of block.content) {
                if (sub.type === 'text' && sub.text) parts.push(sub.text);
              }
            }
          }
        }
        text = parts.join(' ');
      }
    }

    if (!text) return null;
    return { role, text };
  } catch {
    return null;
  }
}

/**
 * Parse a Codex JSONL message (event_msg or response_item wrapper format).
 */
function parseCodexJsonlMessage(event: { type: string; payload: any }): ParsedMessage | null {
  const p = event.payload;
  if (event.type === 'event_msg') {
    switch (p.type) {
      case 'user_message':
        return p.message ? { role: 'user', text: p.message } : null;
      case 'agent_message':
        return p.message ? { role: 'assistant', text: p.message } : null;
      case 'task_complete':
        return p.last_agent_message ? { role: 'assistant', text: p.last_agent_message } : null;
      default:
        return null;
    }
  } else if (event.type === 'response_item') {
    switch (p.type) {
      case 'function_call': {
        const name = p.name || 'unknown';
        const args = p.arguments || '';
        return { role: 'assistant', text: `[tool:${name}] ${args}` };
      }
      case 'function_call_output':
        return p.output ? { role: 'user', text: p.output } : null;
      default:
        return null;
    }
  }
  return null;
}

/**
 * Get ordered session files with assigned session numbers.
 *
 * For CurrentSessionChain: files are in chain order (oldest = session 1).
 * Chain numbering is always oldest-first regardless of sort order.
 *
 * For FullProjectSearch: files are sorted by mtime according to sort order.
 * Session 1 = first in sort order (newest if newest_first, oldest if oldest_first).
 */
async function getOrderedSessionFiles(
  cwd: string,
  options: SearchOptions,
): Promise<Array<{ number: number; path: string; uuid: string | null }>> {
  const { type = 'FullProjectSearch', sessionUuid, sort = 'newest_first' } = options;

  let jsonlFiles = await agentRegistry.getSessionFilesForProject(cwd);
  if (!jsonlFiles.length) return [];

  if (type === 'CurrentSessionChain' && sessionUuid) {
    // Chain files come back in chain order (oldest first) — this order is stable
    jsonlFiles = filterChainFiles(jsonlFiles, sessionUuid);
  } else {
    // Sort by mtime for full project search
    const filesWithMtime = jsonlFiles.map(f => {
      try {
        return { path: f, mtime: fs.statSync(f).mtimeMs };
      } catch {
        return { path: f, mtime: 0 };
      }
    });
    filesWithMtime.sort((a, b) =>
      sort === 'newest_first' ? b.mtime - a.mtime : a.mtime - b.mtime,
    );
    jsonlFiles = filesWithMtime.map(f => f.path);
  }

  return jsonlFiles.map((f, i) => ({ number: i + 1, path: f, uuid: extractUuidFromPath(f) }));
}

/**
 * Parse all messages from a JSONL file, assigning 1-indexed message numbers.
 */
function parseFileMessages(filePath: string): Array<{ msgNum: number; parsed: ParsedMessage }> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const messages: Array<{ msgNum: number; parsed: ParsedMessage }> = [];
  let msgNum = 0;

  for (const line of lines) {
    const parsed = parseJsonlMessage(line);
    if (parsed) {
      msgNum++;
      messages.push({ msgNum, parsed });
    }
  }

  return messages;
}

// --- Search ---

/**
 * Search through session history returning results as session:message references.
 *
 * Results use abstract addressing (no file paths):
 *   session N = the Nth session (chainlink for chain mode, sort-order index for full search)
 *   message M = the Mth conversational message within that session
 */
export async function searchSessionHistory(
  queries: string | string[],
  cwd: string,
  maxResultsPerQuery: number = 50,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const sessionFiles = await getOrderedSessionFiles(cwd, options);
  if (!sessionFiles.length) {
    return { results: [], totalMatches: 0, sessionsSearched: 0, sessions: [] };
  }

  const { sort = 'newest_first', type } = options;
  const queryList = Array.isArray(queries) ? queries : [queries];

  // For chain mode, session numbering is always oldest-first.
  // For search iteration with newest_first, reverse the iteration order
  // but keep the session numbers stable.
  const isChainMode = type === 'CurrentSessionChain';
  const iterFiles = (isChainMode && sort === 'newest_first')
    ? [...sessionFiles].reverse()
    : sessionFiles;

  const allMatches: SearchMatch[] = [];
  const seenKeys = new Set<string>();
  let totalMatches = 0;

  for (const query of queryList) {
    const regex = buildRegex(query);
    let queryMatches = 0;

    for (const sf of iterFiles) {
      try {
        const messages = parseFileMessages(sf.path);

        // For newest_first, search messages in reverse order within each session
        const searchOrder = sort === 'newest_first' ? [...messages].reverse() : messages;

        for (const { msgNum, parsed } of searchOrder) {
          if (!regex.test(parsed.text)) continue;

          totalMatches++;
          const dedupKey = `${sf.number}:${msgNum}`;
          if (seenKeys.has(dedupKey)) continue;
          seenKeys.add(dedupKey);

          // Build snippet around match
          const match = regex.exec(parsed.text);
          let snippet: string;
          if (match) {
            const matchStart = match.index;
            const contextStart = Math.max(0, matchStart - 80);
            const contextEnd = Math.min(parsed.text.length, matchStart + match[0].length + 80);
            snippet = (contextStart > 0 ? '...' : '') +
              parsed.text.substring(contextStart, contextEnd) +
              (contextEnd < parsed.text.length ? '...' : '');
          } else {
            snippet = parsed.text.substring(0, 300);
          }

          if (snippet.length > 300) {
            snippet = snippet.substring(0, 300) + '...';
          }

          allMatches.push({
            session: sf.number,
            message: msgNum,
            text: `[${parsed.role}] ${snippet}`,
          });
          queryMatches++;

          if (queryMatches >= maxResultsPerQuery) break;
        }

        if (queryMatches >= maxResultsPerQuery) break;
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Build deduplicated list of sessions that had matches
  const matchedSessionNumbers = new Set(allMatches.map(m => m.session));
  const sessions: SessionInfo[] = sessionFiles
    .filter(sf => matchedSessionNumbers.has(sf.number) && sf.uuid)
    .map(sf => ({ number: sf.number, uuid: sf.uuid! }));

  return { results: allMatches, totalMatches, sessionsSearched: sessionFiles.length, sessions };
}

// --- Range ---

/**
 * Fetch full messages from a specific session by session:from-to range.
 *
 * Returns complete message content (not truncated) for the requested range.
 */
export async function fetchSessionRange(
  cwd: string,
  options: RangeOptions,
): Promise<RangeResult> {
  const sessionFiles = await getOrderedSessionFiles(cwd, {
    type: options.type,
    sessionUuid: options.sessionUuid,
    sort: options.sort,
  });

  // Look up by UUID first, fall back to session number
  const sf = options.targetSessionUuid
    ? sessionFiles.find(f => f.uuid === options.targetSessionUuid)
    : sessionFiles.find(f => f.number === options.session);
  if (!sf) {
    return { session: options.session ?? 0, uuid: options.targetSessionUuid ?? null, messages: [], totalMessages: 0 };
  }

  const allMessages = parseFileMessages(sf.path);

  const rangeMessages: RangeMessage[] = [];
  for (const { msgNum, parsed } of allMessages) {
    if (msgNum < options.from) continue;
    if (msgNum > options.to) break;
    rangeMessages.push({
      message: msgNum,
      text: `[${parsed.role}] ${parsed.text}`,
    });
  }

  return {
    session: sf.number,
    uuid: sf.uuid,
    messages: rangeMessages,
    totalMessages: allMessages.length,
  };
}
