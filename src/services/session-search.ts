import fs from 'fs';
import path from 'path';
import os from 'os';
import { agentRegistry } from '../agents/registry.js';

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

/**
 * Search through all session history JSONL files for a given project directory.
 * Uses the agent registry to discover files from all registered agent types,
 * ensuring new agent implementations are automatically included.
 * Returns deduplicated matches with file paths and line numbers.
 */
export async function searchSessionHistory(query: string, cwd: string, maxResults: number = 50): Promise<SearchResult> {
  // Collect session files from all registered agent factories (deduplicated by registry)
  const jsonlFiles = await agentRegistry.getSessionFilesForProject(cwd);
  if (!jsonlFiles.length) {
    return { results: [], totalMatches: 0, filesSearched: 0 };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(query, 'i');
  } catch {
    // Fall back to literal string search if regex is invalid
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const allMatches: SearchMatch[] = [];
  const seenLines = new Set<string>(); // Dedup key: "filepath:linenum"
  let totalMatches = 0;

  for (const filePath of jsonlFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      // Use a shorter display path relative to the projects dir
      const displayPath = path.relative(CLAUDE_PROJECTS_DIR, filePath);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;

        // Search the raw line for the query
        if (!regex.test(line)) continue;

        totalMatches++;
        const dedupKey = `${filePath}:${i + 1}`;
        if (seenLines.has(dedupKey)) continue;
        seenLines.add(dedupKey);

        // Extract readable text from the JSONL event
        let text = extractReadableText(line, regex);
        if (!text) continue;

        // Truncate long matches
        if (text.length > 300) {
          text = text.substring(0, 300) + '...';
        }

        allMatches.push({
          file: displayPath,
          line: i + 1,
          text,
        });

        if (allMatches.length >= maxResults) {
          return { results: allMatches, totalMatches, filesSearched: jsonlFiles.length };
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return { results: allMatches, totalMatches, filesSearched: jsonlFiles.length };
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
