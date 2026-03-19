import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const WEB_PORT = process.env.ATOO_WEB_PORT || '3010';
const WEB_PROTO = process.env.ATOO_WEB_PROTO || 'https';
const MCP_TOKEN = process.env.ATOO_MCP_TOKEN || '';

/** Build headers for MCP API requests, including the auth token. */
function mcpHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (MCP_TOKEN) headers['Authorization'] = `Bearer ${MCP_TOKEN}`;
  return headers;
}

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
        headers: mcpHeaders(),
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
        headers: mcpHeaders(),
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
        headers: mcpHeaders(),
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
          headers: mcpHeaders(),
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
          headers: mcpHeaders(),
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
        headers: mcpHeaders(),
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

server.tool(
  'open_file',
  `Open a file in the user's browser editor. The user will be prompted to confirm before the file is opened. Use this when you want the user to see or review a specific file. The tool blocks until the user responds (approve or reject). Provide the full absolute path to the file.`,
  {
    file_path: z.string().describe('Absolute path to the file to open (e.g. "/home/user/project/src/main.ts")'),
  },
  async ({ file_path }) => {
    try {
      const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/open-file`, {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify({ file_path }),
      });
      const data = await res.json() as any;
      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Failed to open file: ${data.error}` }] };
      }
      if (data.action === 'rejected') {
        return { content: [{ type: 'text' as const, text: `User rejected opening the file: ${file_path}` }] };
      }
      return { content: [{ type: 'text' as const, text: `File opened in the user's browser: ${file_path}` }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed to open file: ${err.message}` }] };
    }
  },
);

server.tool(
  'get_session_metadata',
  `Get metadata for the current session chain. Returns the merged metadata across all sessions in the chain: name (most recent), description (most recent), and tags (deduplicated from all chain sessions). Call this before set_session_metadata to see what's already set.`,
  {},
  async () => {
    try {
      const sessionUuid = process.env.ATOO_CURRENT_SESSION_UUID || undefined;
      if (!sessionUuid) {
        return { content: [{ type: 'text' as const, text: 'No session UUID available.' }] };
      }
      const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/get-metadata`, {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify({ session_uuid: sessionUuid, cwd: process.cwd() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        return { content: [{ type: 'text' as const, text: `Failed: ${(err as any).error}` }] };
      }
      const data = await res.json() as { name?: string; description?: string; tags: string[] };
      const parts: string[] = [];
      if (data.name) parts.push(`Name: ${data.name}`);
      if (data.description) parts.push(`Description: ${data.description}`);
      if (data.tags.length) parts.push(`Tags: ${data.tags.join(', ')}`);
      if (!parts.length) return { content: [{ type: 'text' as const, text: 'No metadata set on this session chain.' }] };
      return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }] };
    }
  },
);

server.tool(
  'set_session_metadata',
  `Set metadata on the current session. Any provided property overwrites the existing value in the database. Omitted properties are left unchanged.

Properties:
- name: Short session name (displayed as tab title and session card title). Keep it concise.
- description: Markdown description of what this session is working on. Viewable via a button in the toolbar.
- tags: Array of short tags (max 5 words each, shorter is better). Displayed as badges in the toolbar.

IMPORTANT: Always call get_session_metadata first to check existing metadata before setting, to avoid overwriting or duplicating.

Good tags: "auth refactor", "fix login bug", "API endpoints"
Bad tags: "working on implementing the new authentication system" (too long)`,
  {
    name: z.string().optional().describe('Session name — displayed as tab title and session card title'),
    description: z.string().optional().describe('Session description in markdown — viewable via toolbar button'),
    tags: z.preprocess(
      (val) => {
        if (typeof val === 'string') {
          try { return JSON.parse(val); } catch { return [val]; }
        }
        return val;
      },
      z.array(z.string()),
    ).optional().describe('Array of tags (max 5 words each) — displayed as badges in toolbar'),
  },
  async ({ name, description, tags }) => {
    try {
      const sessionUuid = process.env.ATOO_CURRENT_SESSION_UUID || undefined;
      if (!sessionUuid) {
        return { content: [{ type: 'text' as const, text: 'No session UUID available.' }] };
      }
      const body: any = { session_uuid: sessionUuid, cwd: process.cwd() };
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (tags !== undefined) body.tags = tags;
      const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/set-metadata`, {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        return { content: [{ type: 'text' as const, text: `Failed: ${(err as any).error}` }] };
      }
      const data = await res.json() as { name?: string; description?: string; tags: string[] };
      const parts: string[] = ['Metadata updated.'];
      if (data.name) parts.push(`Name: ${data.name}`);
      if (data.description) parts.push(`Description set (${data.description.length} chars)`);
      if (data.tags.length) parts.push(`Tags: ${data.tags.join(', ')}`);
      return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }] };
    }
  },
);

server.tool(
  'github_issue_pr_changed',
  `MANDATORY: You MUST call this tool EVERY TIME you make ANY change to a GitHub issue or pull request. This includes: commenting, editing title/body/description, changing state (open/close/merge), adding/removing labels, adding/removing assignees, changing milestone, requesting reviewers, or any other modification via the gh CLI or GitHub API. Call this immediately after the change is made. No exceptions — failure to report changes means the UI won't update.`,
  {
    repository: z.string().describe('Repository in owner/repo format (e.g. "octocat/hello-world")'),
    type: z.enum(['issue', 'pr']).describe('Whether the changed item is an issue or pull request'),
    number: z.number().int().min(1).describe('The issue or pull request number'),
  },
  async ({ repository, type, number }) => {
    try {
      const sessionUuid = process.env.ATOO_CURRENT_SESSION_UUID || undefined;
      const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/github-changed`, {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify({ repository, type, number, sessionUuid }),
      });
      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Warning: failed to notify UI of GitHub change (HTTP ${res.status})` }] };
      }
      return { content: [{ type: 'text' as const, text: `Notified atoo-studio UI that ${type} #${number} in ${repository} was changed.` }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Warning: could not reach atoo-studio (${err.message}). UI may not reflect the change.` }] };
    }
  },
);

server.tool(
  'track_project_changes',
  `MANDATORY: You MUST use this tool to help the user keep track of what was accomplished. This is NON-NEGOTIABLE.

The user often runs multiple agents in parallel on the same project. When they are done, they need to know what was actually done across all sessions so they can review and test everything. This tool provides that overview.

Each entry has:
- short_description: max 10 words — headline shown on the collapsed card
- long_description: max 50 words — details shown when expanded, what to review/test
- tags: array of short labels (max 3 words each, max 10 tags) — shown as badges
- approx_files_affected: number

If your work needs more than 50 words to describe, split it into multiple entries.

Write from the user's perspective — NOT file-level noise like "modified src/foo.ts".
Good: "Fixed login redirect loop" + long: "Test login with expired tokens, check redirect after password reset"
Good: "Added dark mode toggle" + tags: ["settings page", "UI"] + long: "Review UI in both themes, check contrast on all panels"
Bad: "Modified 3 files" or "Made changes"

Modes:
- "get": List all existing entries for the project. Call this first to see context.
- "set": Create or update an entry. If id is provided, updates that entry; if omitted, creates a new one.
- "delete": Delete a specific entry by id.`,
  {
    mode: z.enum(['get', 'set', 'delete']).describe('Operation mode'),
    id: z.string().optional().describe('ID of existing entry to update or delete. Leave empty to create new.'),
    short_description: z.string().optional().describe('Headline, max 10 words (required for "set" mode)'),
    long_description: z.string().optional().describe('Details on what to review/test, max 50 words'),
    tags: z.array(z.string()).optional().describe('Short labels (max 3 words each, max 10 tags)'),
    approx_files_affected: z.number().int().min(0).optional().describe('Approximate number of files affected (required for "set" mode)'),
  },
  async ({ mode, id, short_description, long_description, tags, approx_files_affected }) => {
    try {
      const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/track-changes`, {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify({
          mode,
          id,
          short_description,
          long_description,
          tags,
          approx_files_affected,
          session_uuid: process.env.ATOO_CURRENT_SESSION_UUID || undefined,
          cwd: process.cwd(),
        }),
      });
      const data = await res.json() as any;
      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Failed: ${data.error}` }] };
      }

      if (mode === 'get') {
        if (!data.changes || data.changes.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No change entries tracked yet for this project.' }] };
        }
        const lines = data.changes.map((c: any) => {
          const t = c.tags_json ? JSON.parse(c.tags_json) : [];
          const tagStr = t.length ? ` [${t.join(', ')}]` : '';
          return `[${c.id}] ${c.short_description}${tagStr} (~${c.approx_files_affected} files) — ${c.created_at}`;
        });
        return { content: [{ type: 'text' as const, text: `Project changes:\n${lines.join('\n')}` }] };
      } else if (mode === 'set') {
        const c = data.change;
        return { content: [{ type: 'text' as const, text: `Change ${id ? 'updated' : 'created'}: [${c.id}] ${c.short_description} (~${c.approx_files_affected} files)` }] };
      } else {
        return { content: [{ type: 'text' as const, text: data.message || 'Change deleted.' }] };
      }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }] };
    }
  },
);

const DB_TYPES = [
  'postgresql', 'mysql', 'mariadb', 'sqlite', 'redis', 'mongodb',
  'elasticsearch', 'opensearch', 'clickhouse', 'cockroachdb',
  'cassandra', 'scylladb', 'neo4j', 'influxdb', 'memcached',
] as const;

server.tool(
  'connect_database',
  `Connect to a database and run queries, inspect schemas, or list tables. Supports PostgreSQL, MySQL/MariaDB, SQLite, Redis, MongoDB, and more. The agent figures out connection parameters from project files (docker-compose.yml, .env, config files) and passes them here. Atoo Studio manages the connection lifecycle.

Actions:
- "connect": Establish a new connection. Returns connection_id for reuse.
- "disconnect": Close a connection.
- "query": Run a SQL query (or Redis command, MongoDB find, etc.)
- "tables": List all tables/collections.
- "describe": Show structure of a specific table/collection.
- "schema": Get full database schema (all tables + columns).`,
  {
    action: z.enum(['connect', 'disconnect', 'query', 'schema', 'tables', 'describe'])
      .describe('Action to perform'),
    db_type: z.enum(DB_TYPES).optional()
      .describe('Database type (required for "connect")'),
    connection: z.object({
      host: z.string().optional(),
      port: z.number().int().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      database: z.string().optional(),
      filename: z.string().optional().describe('For SQLite — path to database file'),
      connection_string: z.string().optional().describe('Full connection URI'),
      ssh_connection_id: z.string().optional().describe('Tunnel through an existing Atoo Studio SSH connection (pass the SSH connection ID)'),
      ssh_remote_host: z.string().optional().describe('Remote host to connect to through SSH tunnel (default: 127.0.0.1)'),
      ssh_remote_port: z.number().int().optional().describe('Remote port to tunnel (defaults to DB default port)'),
    }).optional().describe('Connection parameters (for "connect" action)'),
    query: z.string().optional().describe('SQL query, Redis command, or MongoDB query'),
    table: z.string().optional().describe('Table/collection name (for "describe" action)'),
    connection_id: z.string().optional().describe('Reuse an existing connection by ID'),
    options: z.object({
      limit: z.number().int().default(100).optional(),
      timeout_ms: z.number().int().default(30000).optional().describe('Query timeout in milliseconds (default: 30000)'),
      readonly: z.boolean().default(true).optional(),
    }).optional(),
  },
  async ({ action, db_type, connection, query, table, connection_id, options }) => {
    try {
      const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/connect-database`, {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify({ action, db_type, connection, query, table, connection_id, options }),
      });
      const data = await res.json() as any;
      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Database error: ${data.error}` }] };
      }

      // Format output
      let text = '';
      if (data.connection_id) text += `Connection ID: ${data.connection_id}\n`;
      if (data.message) text += `${data.message}\n`;
      if (data.tables && Array.isArray(data.tables)) {
        text += `\nTables (${data.tables.length}):\n`;
        for (const t of data.tables) {
          text += `  ${t.name}${t.row_count != null ? ` (${t.row_count} rows)` : ''}${t.type ? ` [${t.type}]` : ''}\n`;
        }
      }
      if (data.columns && data.rows) {
        text += `\nColumns: ${data.columns.join(', ')}\n`;
        text += `Rows: ${data.row_count}${data.truncated ? ' (truncated)' : ''}\n`;
        text += `Time: ${data.execution_time_ms}ms\n\n`;
        // Format as table
        const maxRows = Math.min(data.rows.length, 50);
        for (let i = 0; i < maxRows; i++) {
          const row = data.rows[i];
          text += data.columns.map((c: string) => `${c}: ${JSON.stringify(row[c])}`).join(' | ') + '\n';
        }
        if (data.rows.length > 50) text += `... and ${data.rows.length - 50} more rows\n`;
      }
      if (data.schemas) {
        for (const s of data.schemas) {
          text += `\n## ${s.table}\n`;
          for (const col of s.columns) {
            text += `  ${col.name} ${col.type}${col.nullable ? ' NULL' : ' NOT NULL'}${col.primary_key ? ' PK' : ''}${col.default_value ? ` DEFAULT ${col.default_value}` : ''}\n`;
          }
        }
      }

      return { content: [{ type: 'text' as const, text: text.trim() || JSON.stringify(data, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Database error: ${err.message}` }] };
    }
  },
);

server.tool(
  'ask_user',
  [
    'Ask the user structured questions via a wizard UI in their browser.',
    'Supports single choice, multiple choice, and form questions.',
    'The user sees a step-by-step wizard and can answer at their own pace (no timeout).',
    'Use this for ALL user-facing questions — never use built-in question tools like AskUserQuestion or request_user_input.',
    'Each question needs a unique `id` used as the key in the response.',
    'For single_choice/multiple_choice, provide `options`. For form, provide `fields` with HTML input types.',
    'Use `show_if` to conditionally show questions based on earlier answers.',
    'The user can override any choice with free text or flag questions for further discussion.',
  ].join(' '),
  {
    questions: z.array(z.object({
      id: z.string().describe('Unique ID for this question, used as key in answers'),
      display_text: z.string().describe('Question title shown to user'),
      description: z.string().optional().describe('Explanation/context shown below the question'),
      type: z.enum(['single_choice', 'multiple_choice', 'form']).describe('Question type'),
      options: z.array(z.object({
        value: z.string().describe('Value returned when selected'),
        display_text: z.string().describe('Label shown to user'),
        description: z.string().optional().describe('Extra detail shown below the option'),
      })).optional().describe('Choices for single_choice/multiple_choice questions'),
      fields: z.array(z.object({
        name: z.string().describe('Field name, used as key in the form answer'),
        display_text: z.string().describe('Label shown to user'),
        input_type: z.string().describe('HTML input type: text, number, email, url, date, color, range, select, textarea, checkbox, password, tel, time, datetime-local'),
        placeholder: z.string().optional().describe('Placeholder text'),
        info_text: z.string().optional().describe('Help text shown below the field'),
        default_value: z.string().optional().describe('Pre-filled default value'),
        options: z.array(z.object({
          value: z.string(),
          label: z.string(),
        })).optional().describe('Options for select input_type'),
        required: z.boolean().optional().describe('Whether this field is required'),
      })).optional().describe('Fields for form questions'),
      show_if: z.object({
        question_id: z.string().describe('ID of the question to check'),
        value: z.union([z.string(), z.array(z.string())]).describe('Show if answer matches this value (or any of these values)'),
      }).optional().describe('Conditionally show this question based on a previous answer'),
    })).min(1).describe('Array of questions to present in the wizard'),
  },
  async ({ questions }) => {
    const sessionUuid = process.env.ATOO_CURRENT_SESSION_UUID;
    if (!sessionUuid) {
      return { content: [{ type: 'text' as const, text: 'Error: No session UUID available. Cannot ask user questions outside of a session.' }] };
    }
    try {
      const res = await fetch(`${WEB_PROTO}://localhost:${WEB_PORT}/api/mcp/ask-user`, {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify({ session_uuid: sessionUuid, questions }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        return { content: [{ type: 'text' as const, text: `Error: ${(err as any).error || res.statusText}` }] };
      }
      const result = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: Could not reach atoo-studio (${err.message})` }] };
    }
  },
);

const transport = new StdioServerTransport();
server.connect(transport);
