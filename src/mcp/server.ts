import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const WEB_PORT = process.env.ATOO_WEB_PORT || '3010';
const WEB_PROTO = process.env.ATOO_WEB_PROTO || 'https';

const PROTOCOLS = [
  'http', 'https', 'ws', 'wss', 'tcp', 'grpc', 'smtp', 'imap', 'ftp', 'other',
] as const;

const server = new McpServer({
  name: 'atoo-studio',
  version: '1.0.0',
});

server.tool(
  'report_tcp_services',
  `MANDATORY: You MUST call this tool EVERY TIME you start ANY service, server, or process that listens on a TCP port. This includes dev servers, databases, API servers, preview servers, build watchers with a dev server, etc. Call this immediately after starting the service. No exceptions — failure to report started services breaks the user's workflow.`,
  {
    services: z.array(z.object({
      name: z.string().describe('Short name of the service (e.g. "vite-dev-server", "express-api", "postgres")'),
      description: z.string().describe('Brief description of what this service does'),
      port: z.number().int().min(1).max(65535).describe('TCP port the service is listening on'),
      protocol: z.enum(PROTOCOLS).describe('Communication protocol used by the service'),
      host: z.string().optional().describe('Custom hostname for the Host header in the preview browser (e.g. "myapp.local"). If set, the preview will send this as the Host header to the service.'),
    })).min(1).describe('Array of services that were just started'),
  },
  async ({ services }) => {
    try {
      const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/report-services`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ services, cwd: process.cwd() }),
      });
      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Warning: failed to report services (HTTP ${res.status})` }] };
      }
      return { content: [{ type: 'text' as const, text: `Reported ${services.length} service(s) to atoo-studio UI.` }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Warning: could not reach atoo-studio (${err.message}). Services may not appear in UI.` }] };
    }
  },
);

server.tool(
  'generate_certificate',
  `Generate TLS certificate files signed by the atoo-studio CA. Use this when you need to start an HTTPS server — the generated cert will be trusted by the preview browser. Writes cert.pem, key.pem, and ca.pem to the specified directory.`,
  {
    hostnames: z.array(z.string()).min(1).describe('Hostnames/domains for the certificate SAN (e.g. ["localhost", "myapp.local"])'),
    output_dir: z.string().describe('Absolute path to the directory where cert.pem, key.pem, and ca.pem will be written'),
  },
  async ({ hostnames, output_dir }) => {
    try {
      const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/generate-cert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostnames, output_dir }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        return { content: [{ type: 'text' as const, text: `Failed to generate certificate: ${err.error}` }] };
      }
      const data = await res.json() as { cert_path: string; key_path: string; ca_path: string };
      return {
        content: [
          { type: 'text' as const, text: `Certificate generated for: ${hostnames.join(', ')}\n\nFiles written:\n  cert: ${data.cert_path}\n  key:  ${data.key_path}\n  ca:   ${data.ca_path}` },
        ],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed to generate certificate: ${err.message}` }] };
    }
  },
);

server.tool(
  'request_serial_device',
  `Request access to a serial device (ESP32, Arduino, etc.) connected to the user's local machine via USB. The user will be prompted in their browser to select and connect a serial port. Returns the path to a virtual serial device (PTY) that you can use with any serial tool (screen, minicom, esptool.py, idf.py monitor, etc.). The tool blocks until the user connects a device or a 30-second timeout expires.`,
  {
    baudRate: z.number().int().min(300).max(3000000).default(115200).describe('Baud rate (default: 115200)'),
    dataBits: z.number().int().min(7).max(8).default(8).describe('Data bits: 7 or 8 (default: 8)'),
    stopBits: z.number().int().min(1).max(2).default(1).describe('Stop bits: 1 or 2 (default: 1)'),
    parity: z.enum(['none', 'even', 'odd']).default('none').describe('Parity: none, even, or odd (default: none)'),
    description: z.string().optional().describe('Description shown to the user (e.g. "ESP32 for firmware flashing")'),
  },
  async ({ baudRate, dataBits, stopBits, parity, description }) => {
    try {
      const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/request-serial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baudRate, dataBits, stopBits, parity, description }),
      });
      const data = await res.json() as any;
      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Serial device request failed: ${data.error}` }] };
      }
      const signalNote = data.controlSignalsSupported
        ? `\n\nDTR/RTS control signals are fully supported and automatically forwarded to the physical device.`
        : `\n\nNote: Control signals (DTR/RTS) are NOT available (PTY fallback mode). Auto-reset will not work. To flash, hold the BOOT button on the device during reset. To enable control signals, run setup-cuse.sh as root.`;
      return {
        content: [{
          type: 'text' as const,
          text: `Serial device connected and ready.\n\nVirtual serial port: ${data.ptyPath}\nBaud rate: ${baudRate}\n\nUse this path as your serial port, e.g.:\n  screen ${data.ptyPath} ${baudRate}\n  esptool.py --port ${data.ptyPath} flash_id\n  idf.py -p ${data.ptyPath} monitor${signalNote}`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Serial device request failed: ${err.message}` }] };
    }
  },
);

server.tool(
  'search_session_history',
  `Search through ALL session history files (chat logs) of the current project across all agent types (Claude Code, subagents, etc.). Use this to find previous decisions, implementation notes, reasoning, discussed approaches, or any other information from past and current sessions. Returns matching lines with file paths and line numbers, deduplicated across agent types. IMPORTANT: When using this tool, prefer to delegate the search to a subagent if your client supports it, so the main conversation context is not polluted with potentially large search results.`,
  {
    query: z.string().describe('Search query (regex supported) to find in session history — e.g. "port 3000", "database schema", "decided to use", etc.'),
    max_results: z.number().int().min(1).max(200).default(50).describe('Maximum number of matching lines to return (default: 50)'),
  },
  async ({ query, max_results }) => {
    try {
      const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/search-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, max_results, cwd: process.cwd() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        return { content: [{ type: 'text' as const, text: `Search failed: ${(err as any).error}` }] };
      }
      const data = await res.json() as { results: Array<{ file: string; line: number; text: string }>; totalMatches: number; filesSearched: number };
      if (!data.results.length) {
        return { content: [{ type: 'text' as const, text: `No matches found for "${query}" across ${data.filesSearched} session file(s).` }] };
      }
      const lines = data.results.map(r => `${r.file}:${r.line}: ${r.text}`);
      let output = lines.join('\n');
      if (data.totalMatches > data.results.length) {
        output += `\n\n(Showing ${data.results.length} of ${data.totalMatches} total matches across ${data.filesSearched} files)`;
      } else {
        output += `\n\n(${data.results.length} match(es) across ${data.filesSearched} file(s))`;
      }
      return { content: [{ type: 'text' as const, text: output }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Search failed: ${err.message}` }] };
    }
  },
);

const transport = new StdioServerTransport();
server.connect(transport);
