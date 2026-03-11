import fs from 'fs';
import path from 'path';
import os from 'os';
import { agentRegistry } from '../agents/registry.js';
import { toRawHex, walkChain } from '../agents/lib/session-id-utils.js';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

interface SearchResult {
  results: SearchMatch[];
  totalMatches: number;
  filesSearched: number;
}

export type SearchType = 'FullProjectSearch' | 'CurrentSessionChain';
export type SortOrder = 'newest_first' | 'oldest_first';

export interface SearchOptions {
  type?: SearchType;
  sessionUuid?: string;
  sort?: SortOrder;
}

/**
 * Extract UUID from a JSONL file path.
 * Handles both Claude format (projects/<hash>/<uuid>.jsonl)
 * and Codex format (sessions/YYYY/MM/DD/rollout-timestamp-<uuid>.jsonl).
 */
function extractUuidFromPath(filePath: string): string | null {
  const basename = path.basename(filePath, '.jsonl');
  // Claude: UUID is the entire filename
  const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  return uuidMatch ? uuidMatch[1] : null;
}

/**
 * Filter session files to only those in the current session chain.
 */
function filterChainFiles(allFiles: string[], sessionUuid: string): string[] {
  // Collect all UUIDs from file paths
  const uuidToFile = new Map<string, string>();
  const allUuids: string[] = [];
  for (const f of allFiles) {
    const uuid = extractUuidFromPath(f);
    if (uuid) {
      uuidToFile.set(uuid, f);
      allUuids.push(uuid);
    }
  }

  // Walk the chain from the current session
  const chainUuids = walkChain(sessionUuid, allUuids);

  // Return files matching chain UUIDs (exclude current session)
  const chainFiles: string[] = [];
  for (const uuid of chainUuids) {
    if (uuid === sessionUuid) continue; // Don't search current session
    const file = uuidToFile.get(uuid);
    if (file) chainFiles.push(file);
  }
  return chainFiles;
}

/**
 * Build a regex from a query string, falling back to literal if invalid.
 */
function buildRegex(query: string): RegExp {
  try {
    return new RegExp(query, 'i');
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

/**
 * Search through session history JSONL files.
 *
 * Supports:
 * - Single query string or array of queries (regex with text fallback)
 * - FullProjectSearch (all sessions) or CurrentSessionChain (chain-scoped)
 * - Sort order: newest_first or oldest_first
 *
 * Backward compatible: single string query with no options uses old behavior.
 */
export async function searchSessionHistory(
  queries: string | string[],
  cwd: string,
  maxResultsPerQuery: number = 50,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const { type = 'FullProjectSearch', sessionUuid, sort = 'newest_first' } = options;

  // Collect session files
  let jsonlFiles = await agentRegistry.getSessionFilesForProject(cwd);
  if (!jsonlFiles.length) {
    return { results: [], totalMatches: 0, filesSearched: 0 };
  }

  // Filter to chain scope if requested
  if (type === 'CurrentSessionChain' && sessionUuid) {
    jsonlFiles = filterChainFiles(jsonlFiles, sessionUuid);
    if (!jsonlFiles.length) {
      return { results: [], totalMatches: 0, filesSearched: 0 };
    }
  }

  // Sort files by mtime
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
  const sortedFiles = filesWithMtime.map(f => f.path);

  // Normalize queries to array
  const queryList = Array.isArray(queries) ? queries : [queries];

  const allMatches: SearchMatch[] = [];
  const seenLines = new Set<string>();
  let totalMatches = 0;

  for (const query of queryList) {
    const regex = buildRegex(query);
    let queryMatches = 0;

    for (const filePath of sortedFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const displayPath = path.relative(CLAUDE_PROJECTS_DIR, filePath);

        // For oldest_first sort, iterate lines in order; for newest_first, reverse
        const indices = sort === 'oldest_first'
          ? Array.from({ length: lines.length }, (_, i) => i)
          : Array.from({ length: lines.length }, (_, i) => lines.length - 1 - i);

        for (const i of indices) {
          const line = lines[i];
          if (!line.trim()) continue;
          if (!regex.test(line)) continue;

          totalMatches++;
          const dedupKey = `${filePath}:${i + 1}`;
          if (seenLines.has(dedupKey)) continue;
          seenLines.add(dedupKey);

          let text = extractReadableText(line, regex);
          if (!text) continue;

          if (text.length > 300) {
            text = text.substring(0, 300) + '...';
          }

          allMatches.push({ file: displayPath, line: i + 1, text });
          queryMatches++;

          if (queryMatches >= maxResultsPerQuery) break;
        }

        if (queryMatches >= maxResultsPerQuery) break;
      } catch {
        // Skip unreadable files
      }
    }
  }

  return { results: allMatches, totalMatches, filesSearched: sortedFiles.length };
}

/**
 * Extract human-readable text from a JSONL line, highlighting the matching portion.
 * Tries to pull out the actual message content rather than raw JSON.
 */
function extractReadableText(jsonLine: string, regex: RegExp): string {
  try {
    const event = JSON.parse(jsonLine);

    // Skip file-history-snapshot events — they're just metadata
    if (event.type === 'file-history-snapshot') return '';

    const role = event.message?.role || event.type || 'unknown';
    let text = '';

    // Extract text content from message
    if (event.message?.content) {
      const content = event.message.content;
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        // Combine text blocks, tool_use inputs, and tool_result content
        const parts: string[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'tool_use' && block.input) {
            // Include tool name and input for searchability
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

    if (!text) return '';

    // Only return if the extracted text itself matches (not just some JSON noise)
    if (!regex.test(text)) return '';

    // Find the matching region and return context around it
    const match = regex.exec(text);
    if (!match) return `[${role}] ${text.substring(0, 300)}`;

    const matchStart = match.index;
    const contextStart = Math.max(0, matchStart - 80);
    const contextEnd = Math.min(text.length, matchStart + match[0].length + 80);
    const snippet = (contextStart > 0 ? '...' : '') +
      text.substring(contextStart, contextEnd) +
      (contextEnd < text.length ? '...' : '');

    return `[${role}] ${snippet}`;
  } catch {
    // If JSON parsing fails, search the raw line
    if (regex.test(jsonLine)) {
      return jsonLine.substring(0, 300);
    }
    return '';
  }
}
