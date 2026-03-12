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
  `Search or fetch messages from session history (chat logs) of the current project. Results use abstract session:message addressing — no file paths are exposed.

Two modes:

SEARCH MODE (provide "query"):
  Regex search across sessions. Returns matches as session:message references.
  Example result: "2:15 [assistant] the database schema uses..."
  → session 2, message 15

RANGE MODE (provide "session" or "target_session_uuid" + "from" + "to"):
  Fetch full messages by range. Use after search to get context around a match.
  Prefer target_session_uuid (stable) over session number (can shift between calls).
  Example: target_session_uuid="a1b2c3d4-...", from=12, to=18

Typical workflow:
  1. Search → results include a Sessions header mapping session numbers to UUIDs
  2. Fetch range using the UUID → get full context around the match
  Done in 2 calls.

Session numbering:
- CurrentSessionChain: sessions are 1-indexed from oldest ancestor. Numbering is stable.
- FullProjectSearch: sessions are numbered in sort order (1 = first in sort). Use UUIDs for stable references.

Search types:
- "FullProjectSearch" (default): searches ALL sessions for the project
- "CurrentSessionChain": searches only previous sessions in the current chain (excludes current session)

IMPORTANT: Prefer to delegate to a subagent if your client supports it, so the main context is not polluted with large results.`,
  {
    type: z.enum(['FullProjectSearch', 'CurrentSessionChain']).default('FullProjectSearch')
      .describe('Search scope: FullProjectSearch (all sessions) or CurrentSessionChain (only sessions in the current chain)'),
    query: z.union([z.string(), z.array(z.string())]).optional()
      .describe('Search mode: query or array of queries (regex supported, falls back to text if invalid) — e.g. "port 3000", ["database schema", "migration"]'),
    max_results_per_query: z.number().int().min(1).max(200).default(50)
      .describe('Search mode: maximum results per query (default: 50)'),
    sort: z.enum(['newest_first', 'oldest_first']).default('newest_first')
      .describe('Sort order: newest_first (default) or oldest_first'),
    session: z.number().int().min(1).optional()
      .describe('Range mode: session/chainlink number to fetch from (1-indexed)'),
    target_session_uuid: z.string().optional()
      .describe('Range mode: UUID of the session to fetch from (alternative to session number — stable across calls)'),
    from: z.number().int().min(1).optional()
      .describe('Range mode: start message number (inclusive, 1-indexed)'),
    to: z.number().int().min(1).optional()
      .describe('Range mode: end message number (inclusive, 1-indexed)'),
  },
  async ({ type, query, max_results_per_query, sort, session, target_session_uuid, from, to }) => {
    try {
      const sessionUuid = process.env.ATOO_CURRENT_SESSION_UUID || undefined;

      // Determine mode: range if (session or target_session_uuid)+from+to provided, search if query provided
      const isRangeMode = (session != null || target_session_uuid != null) && from != null && to != null;
      const isSearchMode = query != null;

      if (!isRangeMode && !isSearchMode) {
        return { content: [{ type: 'text' as const, text: 'Either "query" (search mode) or "session"/"target_session_uuid"+"from"+"to" (range mode) is required.' }] };
      }

      if (isRangeMode) {
        // Range mode: fetch full messages
        const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/fetch-history-range`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type,
            session_uuid: sessionUuid,
            sort,
            session,
            target_session_uuid,
            from,
            to,
            cwd: process.cwd(),
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Unknown error' }));
          return { content: [{ type: 'text' as const, text: `Range fetch failed: ${(err as any).error}` }] };
        }
        const data = await res.json() as {
          session: number;
          uuid: string | null;
          messages: Array<{ message: number; text: string }>;
          totalMessages: number;
        };
        if (!data.messages.length) {
          return { content: [{ type: 'text' as const, text: `No messages found for session ${session ?? target_session_uuid} range ${from}-${to}.` }] };
        }
        const lines = data.messages.map(m => `${data.session}:${m.message} ${m.text}`);
        let output = '';
        if (data.uuid) {
          output += `Session ${data.session} [${data.uuid}]\n\n`;
        }
        output += lines.join('\n\n');
        output += `\n\n(${data.messages.length} message(s) from session ${data.session}, ${data.totalMessages} total messages in session)`;
        return { content: [{ type: 'text' as const, text: output }] };

      } else {
        // Search mode
        const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/search-history`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            max_results_per_query,
            type,
            session_uuid: sessionUuid,
            sort,
            cwd: process.cwd(),
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Unknown error' }));
          return { content: [{ type: 'text' as const, text: `Search failed: ${(err as any).error}` }] };
        }
        const data = await res.json() as {
          results: Array<{ session: number; message: number; text: string }>;
          totalMatches: number;
          sessionsSearched: number;
          sessions: Array<{ number: number; uuid: string }>;
        };
        if (!data.results.length) {
          const queryStr = Array.isArray(query) ? query.join('", "') : query;
          return { content: [{ type: 'text' as const, text: `No matches found for "${queryStr}" across ${data.sessionsSearched} session(s) (scope: ${type}).` }] };
        }

        // Build session header for UUID mapping (deduplicated)
        let output = '';
        if (data.sessions?.length) {
          output += 'Sessions:\n';
          for (const s of data.sessions) {
            output += `  ${s.number}: ${s.uuid}\n`;
          }
          output += '\n';
        }

        const lines = data.results.map(r => `${r.session}:${r.message} ${r.text}`);
        output += lines.join('\n');
        if (data.totalMatches > data.results.length) {
          output += `\n\n(Showing ${data.results.length} of ${data.totalMatches} total matches across ${data.sessionsSearched} session(s))`;
        } else {
          output += `\n\n(${data.results.length} match(es) across ${data.sessionsSearched} session(s))`;
        }
        return { content: [{ type: 'text' as const, text: output }] };
      }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }] };
    }
  },
);

server.tool(
  'suggest_continue_in_other_session',
  `Suggest to the user that they should continue their current task in an existing session that already has relevant context.

Use this BEFORE planning or implementing when you discover (via search_session_history) that another session has already worked on the same feature, file, or bug. The user will see a popup with three options:
- Reject: Stay in the current session (you should proceed normally)
- Open: Switch to the target session (your current session stays open)
- Open & Close Current: Switch to the target session and close this one

The tool blocks until the user responds. If rejected, continue working in the current session.

IMPORTANT: Always search session history first to find the relevant session UUID before calling this tool.`,
  {
    session_uuid: z.string()
      .describe('UUID of the session that has relevant context. The tool automatically resolves the chain head (most recent session in the chain).'),
    refined_prompt: z.string()
      .describe('A refined version of the user\'s request, ready to be sent in the target session. Should be clear and self-contained.'),
  },
  async ({ session_uuid, refined_prompt }) => {
    try {
      const sourceSessionId = process.env.ATOO_CURRENT_SESSION_UUID || undefined;
      const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/suggest-session-switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_uuid,
          refined_prompt,
          cwd: process.cwd(),
          source_session_id: sourceSessionId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        return { content: [{ type: 'text' as const, text: `Session switch suggestion failed: ${(err as any).error}` }] };
      }
      const data = await res.json() as { action: string; targetSessionUuid: string };

      if (data.action === 'rejected') {
        return { content: [{ type: 'text' as const, text: 'User rejected the suggestion. Continue working in the current session.' }] };
      } else if (data.action === 'open') {
        return { content: [{ type: 'text' as const, text: `User accepted. They are switching to session ${data.targetSessionUuid}. The refined prompt has been placed in that session's input. You can stop working on this task — the user will continue in the other session.` }] };
      } else if (data.action === 'open_and_close') {
        return { content: [{ type: 'text' as const, text: `User accepted and chose to close this session. They are switching to session ${data.targetSessionUuid}. Stop all work immediately.` }] };
      }
      return { content: [{ type: 'text' as const, text: `Unknown action: ${data.action}` }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }] };
    }
  },
);

const transport = new StdioServerTransport();
server.connect(transport);
