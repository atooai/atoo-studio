import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const WEB_PORT = process.env.CCPROXY_WEB_PORT || '3001';

const PROTOCOLS = [
  'http', 'https', 'ws', 'wss', 'tcp', 'grpc', 'smtp', 'imap', 'ftp', 'other',
] as const;

const server = new McpServer({
  name: 'ccproxy',
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
    })).min(1).describe('Array of services that were just started'),
  },
  async ({ services }) => {
    try {
      const res = await fetch(`http://localhost:${WEB_PORT}/api/mcp/report-services`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ services, cwd: process.cwd() }),
      });
      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Warning: failed to report services (HTTP ${res.status})` }] };
      }
      return { content: [{ type: 'text' as const, text: `Reported ${services.length} service(s) to ccproxy UI.` }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Warning: could not reach ccproxy (${err.message}). Services may not appear in UI.` }] };
    }
  },
);

const transport = new StdioServerTransport();
server.connect(transport);
