/**
 * Reconstruct Gemini CLI session JSON from SessionEvent[] for fork/resume.
 *
 * Gemini sessions are single JSON files at:
 *   ~/.gemini/tmp/{projectId}/chats/session-{date}-{shortId}.json
 *
 * Each file contains:
 *   { sessionId, projectHash, startTime, lastUpdated, messages: [...], kind: "main" }
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type {
  SessionEvent,
  UserEvent,
  AssistantEvent,
  SystemEvent,
} from '../../../events/types.js';
import type { GeminiMessage, GeminiToolCall } from './json-mapper.js';

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const GEMINI_TMP_DIR = path.join(GEMINI_DIR, 'tmp');
const PROJECTS_JSON = path.join(GEMINI_DIR, 'projects.json');

// ═══════════════════════════════════════════════════════
// SessionEvent → Gemini message reconstruction
// ═══════════════════════════════════════════════════════

function reconstructUserMessage(event: UserEvent): GeminiMessage | null {
  const content = event.message.content;

  // Skip tool result events (these are embedded in gemini messages' toolCalls)
  if (Array.isArray(content) && content.some((b: any) => b.type === 'tool_result')) {
    return null;
  }

  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('\n');
  }
  if (!text) return null;

  return {
    id: event.uuid || uuidv4(),
    timestamp: event.timestamp || new Date().toISOString(),
    type: 'user',
    content: [{ text }],
  };
}

function reconstructGeminiMessage(event: AssistantEvent, toolResults: Map<string, string>): GeminiMessage {
  const content = event.message.content;
  const ts = event.timestamp || new Date().toISOString();

  let textContent = '';
  const thoughts: Array<{ subject: string; description: string; timestamp: string }> = [];
  const toolCalls: GeminiToolCall[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        textContent += (textContent ? '\n' : '') + block.text;
      } else if (block.type === 'thinking' && 'thinking' in block) {
        thoughts.push({
          subject: 'Thinking',
          description: (block as any).thinking,
          timestamp: ts,
        });
      } else if (block.type === 'tool_use' && 'id' in block && 'name' in block) {
        const toolId = (block as any).id;
        const resultOutput = toolResults.get(toolId) || '';
        toolCalls.push({
          id: toolId,
          name: (block as any).name,
          args: (block as any).input || {},
          result: [{
            functionResponse: {
              id: toolId,
              name: (block as any).name,
              response: { output: resultOutput },
            },
          }],
          status: 'success',
          timestamp: ts,
        });
      }
    }
  } else if (typeof content === 'string') {
    textContent = content;
  }

  const msg: GeminiMessage = {
    id: event.uuid || uuidv4(),
    timestamp: ts,
    type: 'gemini',
    content: textContent,
  };

  if (thoughts.length > 0) msg.thoughts = thoughts;
  if (toolCalls.length > 0) msg.toolCalls = toolCalls;

  // Add token usage if available
  const usage = (event.message as any).usage;
  if (usage) {
    msg.tokens = {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cached: usage.cache_read_input_tokens || 0,
      thoughts: 0,
      tool: 0,
      total: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    };
  }

  // Add model if available
  const model = (event.message as any).model;
  if (model) msg.model = model;

  return msg;
}

// ═══════════════════════════════════════════════════════
// Project hash computation
// ═══════════════════════════════════════════════════════

/**
 * Compute the project hash the same way Gemini CLI does (SHA-256 of resolved path).
 */
function computeProjectHash(directory: string): string {
  const resolved = path.resolve(directory);
  return crypto.createHash('sha256').update(resolved).digest('hex');
}

/**
 * Look up or register a project identifier in ~/.gemini/projects.json.
 */
function getOrCreateProjectId(directory: string): string {
  const resolved = path.resolve(directory);
  let projects: Record<string, string> = {};

  try {
    const content = fs.readFileSync(PROJECTS_JSON, 'utf-8');
    const data = JSON.parse(content);
    projects = data.projects || {};
  } catch {}

  // Check if already registered
  if (projects[resolved]) {
    return projects[resolved];
  }

  // Create a new project ID from the directory basename
  const projectId = path.basename(resolved);
  projects[resolved] = projectId;

  try {
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify({ projects }, null, 4));
  } catch (err: any) {
    console.warn('[gemini-json-writer] Failed to update projects.json:', err.message);
  }

  return projectId;
}

// ═══════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════

/**
 * Write SessionEvent[] as a Gemini session JSON file for `gemini --resume`.
 *
 * @returns The full path to the written JSON file
 */
export function writeForkedGeminiJson(
  events: SessionEvent[],
  targetUuid: string,
  directory: string,
): string {
  const projectId = getOrCreateProjectId(directory);
  const projectHash = computeProjectHash(directory);
  const chatsDir = path.join(GEMINI_TMP_DIR, projectId, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });

  // Build filename: session-{date}-{shortId}.json
  const now = new Date();
  const datePart = now.toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, '')
    .replace('T', 'T');
  const shortId = targetUuid.slice(0, 8);
  const filename = `session-${datePart}-${shortId}.json`;
  const jsonPath = path.join(chatsDir, filename);

  // Build tool result lookup: toolUseId → output text
  const toolResults = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'user') continue;
    const ue = event as UserEvent;
    const content = ue.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_result' && 'tool_use_id' in block) {
        const output = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((b: any) => b.text || '').join('')
            : JSON.stringify(block.content || '');
        toolResults.set((block as any).tool_use_id, output);
      }
    }
  }

  // Convert events to Gemini messages
  const messages: GeminiMessage[] = [];
  let startTime = now.toISOString();

  for (const event of events) {
    switch (event.type) {
      case 'user': {
        const msg = reconstructUserMessage(event as UserEvent);
        if (msg) {
          messages.push(msg);
          if (messages.length === 1) startTime = msg.timestamp;
        }
        break;
      }
      case 'assistant': {
        const msg = reconstructGeminiMessage(event as AssistantEvent, toolResults);
        messages.push(msg);
        break;
      }
      case 'system':
        // Skip system events (no direct equivalent in Gemini sessions)
        break;
      default:
        break;
    }
  }

  // Gemini's --resume skips sessions without user/assistant messages
  // (hasUserOrAssistantMessage check). For first-turn dispatches with no history,
  // insert a minimal placeholder exchange so the session is discoverable.
  if (!messages.some(m => m.type === 'user' || m.type === 'gemini')) {
    messages.push({
      id: uuidv4(),
      timestamp: now.toISOString(),
      type: 'user',
      content: [{ text: '(session initialized by atoo-studio)' }],
    });
    messages.push({
      id: uuidv4(),
      timestamp: now.toISOString(),
      type: 'gemini',
      content: 'Ready.',
    });
  }

  const session = {
    sessionId: targetUuid,
    projectHash,
    startTime,
    lastUpdated: now.toISOString(),
    messages,
    kind: 'main',
  };

  fs.writeFileSync(jsonPath, JSON.stringify(session, null, 2));
  console.log(`[gemini-json-writer] Wrote ${messages.length} messages to ${jsonPath}`);
  return jsonPath;
}
