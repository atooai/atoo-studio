import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { WEB_PORT } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(os.homedir(), '.ccproxy');
const CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config.json');

let cachedPath: string | null = null;

export const MCP_SYSTEM_PROMPT = [
  'You have a "ccproxy" MCP server available with tools for interacting with the development UI.',
  'IMPORTANT: Whenever you start ANY service, server, or process that listens on a TCP port',
  '(dev servers, databases, API servers, preview servers, etc.), you MUST immediately discover',
  'and call the mcp__ccproxy__report_tcp_services tool to report it. Search your deferred tools',
  'for "ccproxy" or "report_tcp" to find it. Never skip this step.',
].join(' ');

export function getMcpConfigPath(): string {
  if (cachedPath) return cachedPath;

  const serverScript = path.resolve(__dirname, '..', 'mcp', 'server.js');

  const config = {
    mcpServers: {
      ccproxy: {
        command: 'node',
        args: [serverScript],
        env: {
          CCPROXY_WEB_PORT: String(WEB_PORT),
          CCPROXY_WEB_PROTO: 'https',
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        },
      },
    },
  };

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`[mcp] Wrote MCP config to ${CONFIG_PATH}`);

  cachedPath = CONFIG_PATH;
  return CONFIG_PATH;
}
