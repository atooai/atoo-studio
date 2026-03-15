import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { WEB_PORT, PROJECT_ROOT } from '../config.js';

const CONFIG_DIR = path.join(os.homedir(), '.atoo-studio');
const CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config.json');

// Detect dev mode: when running via tsx, __filename is in src/; when compiled, it's in dist/src/
const __mcp_config_dir = path.dirname(fileURLToPath(import.meta.url));
const IS_DEV = !__mcp_config_dir.includes('/dist/src');

let cachedPath: string | null = null;

// ═══════════════════════════════════════════════════════
// Per-session MCP token registry
// ═══════════════════════════════════════════════════════

const mcpTokens = new Set<string>();

/** Register an MCP token as valid. */
export function registerMcpToken(token: string): void {
  mcpTokens.add(token);
}

/** Remove an MCP token (called on session cleanup). */
export function removeMcpToken(token: string): void {
  mcpTokens.delete(token);
}

/** Check if an MCP token is valid. */
export function validateMcpToken(token: string): boolean {
  return mcpTokens.has(token);
}

/** Returns the command, args, and env needed to launch the MCP server process. */
export function getMcpServerDef(): { command: string; args: string[]; env: Record<string, string> } {
  const command = IS_DEV ? 'tsx' : 'node';
  const serverScript = IS_DEV
    ? path.join(PROJECT_ROOT, 'src', 'mcp', 'server.ts')
    : path.join(PROJECT_ROOT, 'dist', 'src', 'mcp', 'server.js');

  return {
    command,
    args: [serverScript],
    env: {
      ATOO_WEB_PORT: String(WEB_PORT),
      ATOO_WEB_PROTO: 'https',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
  };
}

export const MCP_SYSTEM_PROMPT = [
  'You have a "atoo-studio" MCP server available with tools for interacting with the development UI.',
  'IMPORTANT: Whenever you start ANY service, server, or process that listens on a TCP port',
  '(dev servers, databases, API servers, preview servers, etc.), you MUST immediately discover',
  'and call the mcp__atoo-studio__report_tcp_services tool to report it. Search your deferred tools',
  'for "atoo-studio" or "report_tcp" to find it. Never skip this step.',
  'When you need to start an HTTPS server, use mcp__atoo-studio__generate_certificate to generate',
  'TLS cert files signed by the proxy CA. Specify the output directory and hostnames — the tool',
  'writes cert.pem, key.pem, and ca.pem there. The preview browser trusts this CA.',
  'When you need to interact with a serial device (ESP32, Arduino, etc.) connected to the user\'s',
  'machine, use mcp__atoo-studio__request_serial_device to get a virtual serial port path. The user',
  'will be prompted to connect the device in their browser. Once connected, use the returned path',
  'with any serial tool (screen, minicom, esptool.py, idf.py monitor, etc.).',
  'IMPORTANT: Whenever you make ANY change to a GitHub issue or pull request (commenting,',
  'editing title/body, changing state, adding labels, etc.), you MUST call',
  'mcp__atoo-studio__github_issue_pr_changed with the repository, type (issue/pr), and number.',
  'This ensures the UI stays in sync with your changes. Never skip this step.',
  'When you need to recall previous decisions, implementation reasoning, discussed approaches,',
  'or any context from past sessions for this project, use mcp__atoo-studio__search_session_history.',
  'It searches across ALL session history files (including subagent sessions) for the current project.',
  'You can search with type "FullProjectSearch" (default, all sessions) or "CurrentSessionChain"',
  '(only sessions in the current chain — use this when you need context from earlier in the',
  'current conversation that was continued across session boundaries).',
  'You can provide multiple queries as an array, and control sort order (newest_first or oldest_first).',
  'Results are ordered by most recent session first by default.',
  'IMPORTANT: Prefer delegating search_session_history calls to a subagent when possible, so the',
  'main conversation context is not polluted with potentially large search results.',

  '\n## MANDATORY: Track project changes\n',
  'IMPORTANT: You MUST use mcp__atoo-studio__track_project_changes to help the user keep track of',
  'what was accomplished. This is NON-NEGOTIABLE. The user often runs multiple agents in parallel',
  'on the same project. When they are done, they need to know what was actually done across all',
  'sessions so they can review and test everything.',
  'At the START of your session, call the tool with mode "get" to see what other sessions have logged.',
  'After completing a meaningful task (bug fix, feature, refactor), call with mode "set" to log',
  'a concise summary of what you accomplished and what the user should review or test.',
  'Write from the user\'s perspective — NOT file-level noise like "modified src/foo.ts".',
  'Good: short_description: "Fixed login redirect loop" + long_description: "Test login with expired tokens".',
  'Good: short_description: "Added dark mode toggle" + tags: ["settings page", "UI"].',
  'Bad: "Modified 3 files" or "Made changes".',
  'To update an existing entry, pass its id. To create a new entry, omit the id.',
  'IMPORTANT: There is NO "description" parameter. Use short_description and long_description instead.',

  '\n## MANDATORY: Set session metadata\n',
  'IMPORTANT: Whenever you start working on a feature, bug fix, or any distinct task, you MUST',
  'set session metadata using mcp__atoo-studio__set_session_metadata. First call',
  'mcp__atoo-studio__get_session_metadata to see what is already set, then update as needed.',
  'Set a short session name (used as tab title), tags (displayed as badges), and optionally a',
  'markdown description. Keep tags short (max 5 words). Examples: "auth refactor", "fix login bug".',
  'Update metadata whenever the focus shifts to a new task.',

  '\n## MANDATORY: Search before any feature or bug fix\n',
  'IMPORTANT: Before starting ANY feature implementation or bug fix, you MUST search session history',
  'using mcp__atoo-studio__search_session_history with type "FullProjectSearch" to check if another',
  'session has already worked on the same feature, files, or area. Do NOT skip this step.',
  'If a relevant session is found, use mcp__atoo-studio__suggest_continue_in_other_session to suggest',
  'the user switches to that session instead. Provide the session UUID and a refined prompt.',
  'The tool blocks until the user responds. If they reject, continue working in the current session.',
  'Strong signals that prior work exists: untracked files, uncommitted changes, or existing code',
  'that already addresses the requested feature.',

  '\n## When stuck or unsure\n',
  'When you encounter an obstacle or something is unclear:\n',
  '1. First, search the current session chain using mcp__atoo-studio__search_session_history with',
  'type "CurrentSessionChain" — the answer may already exist earlier in this conversation\'s history.\n',
  '2. If questions remain unresolved, escalate to a "FullProjectSearch" to find relevant context',
  'from any session in the project.\n\n',
  'Do not rely on documentation, comments, or README files as a source of truth — they are likely outdated.',
  'Session history contains the actual reasoning behind decisions, failed approaches, and tradeoffs',
  'that led to the current code.\n',
  'Search history before:\n',
  '- Making architectural decisions that might contradict past choices\n',
  '- Refactoring code whose purpose isn\'t clear from reading it\n',
  '- Debugging issues that seem like they were solved before\n',
  '- Choosing between multiple implementation approaches',
].join(' ');

/**
 * Additional system prompt appended for chain continuation sessions.
 * Tells the LLM that this is a continuation and how to search previous chain links.
 */
export const CHAIN_SYSTEM_PROMPT = [
  '\n\n## Session Chain Continuation\n',
  'This session is a chain continuation of a previous session. The conversation context',
  'from earlier session(s) has been partially carried forward (all user messages + recent events).',
  'If you need more context about what was discussed or decided earlier, use',
  'mcp__atoo-studio__search_session_history with type "CurrentSessionChain" to search through',
  'all previous sessions in this chain. The results are ordered by most recent first by default.',
  'If you think there might be more relevant information that was cut off, search again with',
  'different queries or increase max_results_per_query.',
].join(' ');

/**
 * Get or create an MCP config file.
 * When sessionUuid is provided, creates a per-session config that includes
 * ATOO_CURRENT_SESSION_UUID in the env — enabling chain-scoped search.
 */
export function getMcpConfigPath(sessionUuid?: string): string {
  // No session UUID — use the shared (cached) config
  if (!sessionUuid) {
    if (cachedPath) return cachedPath;

    const token = crypto.randomUUID();
    registerMcpToken(token);

    const def = getMcpServerDef();
    const config = {
      mcpServers: {
        'atoo-studio': {
          command: def.command,
          args: def.args,
          env: { ...def.env, ATOO_MCP_TOKEN: token },
        },
      },
    };

    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(`[mcp] Wrote MCP config to ${CONFIG_PATH} (${IS_DEV ? 'dev' : 'production'} mode)`);

    cachedPath = CONFIG_PATH;
    return CONFIG_PATH;
  }

  // Per-session config with session UUID and unique MCP token
  const sessionConfigPath = path.join(CONFIG_DIR, `mcp-config-${sessionUuid}.json`);
  const token = crypto.randomUUID();
  registerMcpToken(token);

  const def = getMcpServerDef();
  const config = {
    mcpServers: {
      'atoo-studio': {
        command: def.command,
        args: def.args,
        env: {
          ...def.env,
          ATOO_CURRENT_SESSION_UUID: sessionUuid,
          ATOO_MCP_TOKEN: token,
        },
      },
    },
  };

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(sessionConfigPath, JSON.stringify(config, null, 2));
  console.log(`[mcp] Wrote per-session MCP config to ${sessionConfigPath}`);

  return sessionConfigPath;
}

/**
 * Clean up a per-session MCP config file.
 */
export function cleanupMcpConfig(sessionUuid: string): void {
  const sessionConfigPath = path.join(CONFIG_DIR, `mcp-config-${sessionUuid}.json`);
  try {
    // Remove the MCP token from the registry before deleting the config file
    const content = fs.readFileSync(sessionConfigPath, 'utf-8');
    const config = JSON.parse(content);
    const token = config?.mcpServers?.['atoo-studio']?.env?.ATOO_MCP_TOKEN;
    if (token) removeMcpToken(token);
  } catch {
    // File may not exist or be unparseable
  }
  try {
    fs.unlinkSync(sessionConfigPath);
  } catch {}
}

/**
 * Clean up stale per-session MCP config files older than maxAgeMs.
 */
export function cleanupStaleMcpConfigs(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
  try {
    const files = fs.readdirSync(CONFIG_DIR);
    const now = Date.now();
    for (const file of files) {
      if (!file.startsWith('mcp-config-') || !file.endsWith('.json')) continue;
      if (file === 'mcp-config.json') continue; // Skip shared config
      const filePath = path.join(CONFIG_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          console.log(`[mcp] Cleaned up stale config: ${file}`);
        }
      } catch {}
    }
  } catch {}
}
