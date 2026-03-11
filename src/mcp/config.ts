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
  'When you need to recall previous decisions, implementation reasoning, discussed approaches,',
  'or any context from past sessions for this project, use mcp__atoo-studio__search_session_history.',
  'It searches across ALL session history files (including subagent sessions) for the current project.',
  'Results are ordered by most recent session first.',
  'IMPORTANT: Prefer delegating search_session_history calls to a subagent when possible, so the',
  'main conversation context is not polluted with potentially large search results.',
  '\n## When stuck or unsure\n',
  'Do not rely on documentation, comments, or README files as a source of truth — they are likely outdated.',
  'Instead, use mcp__atoo-studio__search_session_history to find past discussions about the topic.',
  'Session history contains the actual reasoning behind decisions, failed approaches, and tradeoffs',
  'that led to the current code.\n',
  'Search history before:\n',
  '- Making architectural decisions that might contradict past choices\n',
  '- Refactoring code whose purpose isn\'t clear from reading it\n',
  '- Debugging issues that seem like they were solved before\n',
  '- Choosing between multiple implementation approaches',
].join(' ');

export function getMcpConfigPath(): string {
  if (cachedPath) return cachedPath;

  const def = getMcpServerDef();
  const config = {
    mcpServers: {
      'atoo-studio': {
        command: def.command,
        args: def.args,
        env: def.env,
      },
    },
  };

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`[mcp] Wrote MCP config to ${CONFIG_PATH} (${IS_DEV ? 'dev' : 'production'} mode)`);

  cachedPath = CONFIG_PATH;
  return CONFIG_PATH;
}
