import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import https from 'https';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import { store } from '../state/store.js';
import { v4 as uuidv4 } from 'uuid';
import * as pty from 'node-pty';
import { getProcessPid, getPty, getEnvIdForSession, getScrollback, killCliProcess } from '../spawner.js';
import { fsMonitor } from '../fs-monitor.js';
import { changesRouter } from '../handlers/changes.js';
import { projectsRouter } from '../handlers/projects.js';
import { environmentsRouter, setBroadcastSettingsChange } from '../handlers/environments.js';
import { sshRouter } from '../handlers/ssh.js';
import { githubRouter } from '../handlers/github.js';
import { authRouter } from '../handlers/auth.js';
import { usersRouter } from '../handlers/users.js';
import { isAgentWsUpgrade, handleAgentWsUpgrade } from '../ws/agent-ws.js';
import { agentRegistry } from '../agents/registry.js';
import { createPortProxy, portProxyMiddleware, isPortProxyUpgrade, handlePortProxyUpgrade } from './port-proxy.js';
import { isPreviewWsUpgrade, handlePreviewWsUpgrade } from './preview-ws.js';
import { previewManager } from '../services/preview-manager.js';
import { devtoolsProxyMiddleware, isDevtoolsWsUpgrade, handleDevtoolsWsUpgrade } from './devtools-proxy.js';
import forge from 'node-forge';
import { CA_CERT_PATH, CA_KEY_PATH, PROJECT_ROOT } from '../config.js';
import { serialManager } from '../serial/manager.js';
import { searchSessionHistory, fetchSessionRange } from '../services/session-search.js';
import { resolveChainHead, toRawHex, walkChain } from '../agents/lib/session-id-utils.js';
import { db } from '../state/db.js';
import { containersRouter, getContainerRuntimes } from '../handlers/containers.js';
import { databasesRouter, handleMcpConnectDatabase } from '../handlers/databases.js';
import { isDatabaseWsUpgrade, handleDatabaseWsUpgrade } from '../database/query-stream.js';

import { requireAuth, authenticateWsUpgrade, isAuthEnabled } from '../auth/middleware.js';
import { validateMcpToken } from '../mcp/config.js';

// Standalone shell terminals (not tied to Claude sessions)
const shellTerminals = new Map<string, { pty: pty.IPty; cwd: string; projectPath: string }>();

// Broadcast registries for multi-browser terminal/shell connections
// Each entry keeps a scrollback buffer so late-joining browsers get existing output
const MAX_SCROLLBACK = 200_000; // characters
interface TermBroadcast {
  clients: Set<WebSocket>;
  handler: { dispose(): void } | null;
  scrollback: string;
}
const terminalClients = new Map<string, TermBroadcast>();
const shellClients = new Map<string, TermBroadcast>();

// Pending session-switch requests (MCP tool blocks until user responds)
interface PendingSessionSwitch {
  resolve: (result: { action: 'rejected' | 'open' | 'open_and_close' }) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingSessionSwitches = new Map<string, PendingSessionSwitch>();

// Pending open-file requests (MCP tool blocks until user responds)
interface PendingOpenFile {
  resolve: (result: { action: 'approved' | 'rejected' }) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingOpenFiles = new Map<string, PendingOpenFile>();

// Pending ask-user requests (MCP tool blocks until user responds — no timeout)
interface PendingAskUser {
  resolve: (result: { status: 'answered' | 'cancelled'; answers?: Record<string, any> }) => void;
  sessionId: string; // agent session ID, for cleanup on agent exit
}
const pendingAskUsers = new Map<string, PendingAskUser>();

/** Clean up any pending ask-user requests for a given agent session ID. */
export function cleanupPendingAskUsers(sessionId: string): void {
  for (const [requestId, pending] of pendingAskUsers) {
    if (pending.sessionId === sessionId) {
      pending.resolve({ status: 'cancelled' });
      pendingAskUsers.delete(requestId);
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createWebServer(tlsOptions?: { key: string; cert: string }): https.Server | http.Server {
  const app = express();

  // Clean up pending ask-user requests when agents are destroyed
  agentRegistry.onDestroy((sessionId) => cleanupPendingAskUsers(sessionId));

  // Port-proxy: intercept before body parsing so proxied requests stream through
  const portProxy = createPortProxy();
  app.use(portProxyMiddleware(portProxy));

  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());

  // Auth routes (public — handles its own auth checks internally)
  app.use(authRouter);
  app.use(usersRouter);

  // Serve CA certificate for trust installation (PEM for Linux/macOS, DER .crt for Windows)
  app.get('/ca.pem', (_req, res) => {
    try {
      const caPem = fs.readFileSync(CA_CERT_PATH, 'utf-8');
      res.setHeader('Content-Type', 'application/x-pem-file');
      res.setHeader('Content-Disposition', 'attachment; filename="atoo-studio-ca.pem"');
      res.send(caPem);
    } catch (err: any) {
      res.status(500).json({ error: 'CA certificate not found' });
    }
  });
  app.get('/ca.crt', (_req, res) => {
    try {
      const caPem = fs.readFileSync(CA_CERT_PATH, 'utf-8');
      res.setHeader('Content-Type', 'application/x-x509-ca-cert');
      res.setHeader('Content-Disposition', 'attachment; filename="atoo-studio-ca.crt"');
      res.send(caPem);
    } catch (err: any) {
      res.status(500).json({ error: 'CA certificate not found' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // MCP middleware — localhost check + per-session token
  // ═══════════════════════════════════════════════════════
  app.use('/api/mcp', (req, res, next) => {
    // Localhost check
    const addr = req.socket.remoteAddress;
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
      res.status(403).json({ error: 'MCP callbacks are localhost-only' });
      return;
    }
    // Token check
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token || !validateMcpToken(token)) {
      res.status(401).json({ error: 'Invalid or missing MCP token' });
      return;
    }
    next();
  });

  // MCP callback: notify that a GitHub issue/PR was changed
  app.post('/api/mcp/github-changed', (req, res) => {
    const { repository, type, number, sessionUuid } = req.body;
    if (!repository || typeof repository !== 'string') {
      return res.status(400).json({ error: 'repository is required' });
    }
    if (type !== 'issue' && type !== 'pr') {
      return res.status(400).json({ error: 'type must be "issue" or "pr"' });
    }
    if (!number || typeof number !== 'number') {
      return res.status(400).json({ error: 'number is required' });
    }
    console.log(`[mcp] github-changed: ${type} #${number} in ${repository}${sessionUuid ? ` (session ${sessionUuid})` : ''}`);
    const msg = JSON.stringify({ type: 'github_issue_pr_changed', repository, itemType: type, number, ...(sessionUuid ? { sessionUuid } : {}) });
    for (const ws of store.statusClients) {
      if (ws.readyState === 1) ws.send(msg);
    }
    res.json({ success: true });
  });

  // MCP callback: report started TCP services
  app.post('/api/mcp/report-services', (req, res) => {
    const { services, cwd } = req.body;
    if (!Array.isArray(services) || !services.length) {
      return res.status(400).json({ error: 'services array is required' });
    }
    console.log(`[mcp] report-services: ${services.length} service(s) from ${cwd}`);
    const msg = JSON.stringify({ type: 'service_started', services, cwd });
    for (const ws of store.statusClients) {
      if (ws.readyState === 1) ws.send(msg);
    }
    res.json({ success: true });
  });

  // MCP callback: generate a certificate signed by the proxy CA and write to disk
  app.post('/api/mcp/generate-cert', (req, res) => {
    const { hostnames, output_dir } = req.body;
    if (!Array.isArray(hostnames) || !hostnames.length) {
      return res.status(400).json({ error: 'hostnames array is required' });
    }
    if (!output_dir || typeof output_dir !== 'string') {
      return res.status(400).json({ error: 'output_dir is required' });
    }
    try {
      const caCertPem = fs.readFileSync(CA_CERT_PATH, 'utf-8');
      const caKeyPem = fs.readFileSync(CA_KEY_PATH, 'utf-8');
      const caCert = forge.pki.certificateFromPem(caCertPem);
      const caKey = forge.pki.privateKeyFromPem(caKeyPem);

      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = Date.now().toString(16);
      cert.validity.notBefore = new Date();
      cert.validity.notAfter = new Date();
      cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);
      cert.setSubject([{ name: 'commonName', value: hostnames[0] }]);
      cert.setIssuer(caCert.subject.attributes);
      cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'subjectAltName', altNames: hostnames.map((h: string) => ({ type: 2, value: h })) },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
      ]);
      cert.sign(caKey, forge.md.sha256.create());

      fs.mkdirSync(output_dir, { recursive: true });
      const certPath = path.join(output_dir, 'cert.pem');
      const keyPath = path.join(output_dir, 'key.pem');
      const caPath = path.join(output_dir, 'ca.pem');
      fs.writeFileSync(certPath, forge.pki.certificateToPem(cert));
      fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey));
      fs.writeFileSync(caPath, caCertPem);

      console.log(`[mcp] Generated certificate for ${hostnames.join(', ')} → ${output_dir}`);
      res.json({ cert_path: certPath, key_path: keyPath, ca_path: caPath });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // MCP callback: request serial device passthrough
  app.post('/api/mcp/request-serial', async (req, res) => {
    const { baudRate = 115200, dataBits = 8, stopBits = 1, parity = 'none', description } = req.body;
    const requestId = uuidv4();

    try {
      const { devicePath, controlSignalsSupported, readyPromise } = await serialManager.createRequest(requestId, {
        baudRate, dataBits, stopBits, parity, description,
      });

      // Broadcast to all browsers so they can show the serial connect modal
      const msg = JSON.stringify({
        type: 'serial_request', requestId, baudRate, dataBits, stopBits, parity, description, controlSignalsSupported,
      });
      for (const ws of store.statusClients) {
        if (ws.readyState === 1) ws.send(msg);
      }

      // Wait for browser to connect (30s timeout)
      const timeout = setTimeout(() => {
        serialManager.rejectRequest(requestId, new Error('No browser connected within 30s'));
      }, 30000);

      const result = await readyPromise;
      clearTimeout(timeout);

      res.json({ success: true, ptyPath: result.devicePath, requestId, controlSignalsSupported: result.controlSignalsSupported });
    } catch (err: any) {
      serialManager.closeRequest(requestId);
      res.status(500).json({ error: err.message });
    }
  });

  // Reject a serial request (user closed modal without connecting)
  // MCP callback: suggest switching to another session
  app.post('/api/mcp/suggest-session-switch', async (req, res) => {
    const { session_uuid, refined_prompt, cwd, source_session_id } = req.body;
    if (!session_uuid || !refined_prompt) {
      return res.status(400).json({ error: 'session_uuid and refined_prompt are required' });
    }

    const requestId = uuidv4();

    // Resolve chain head: find most recent session in the chain
    let targetUuid = session_uuid;
    try {
      const allFiles = await agentRegistry.getSessionFilesForProject(cwd || process.cwd());
      const allUuids = allFiles.map(f => {
        const basename = path.basename(f, '.jsonl');
        const m = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
        return m ? m[1] : '';
      }).filter(Boolean);
      targetUuid = resolveChainHead(session_uuid, allUuids);
    } catch (err) {
      console.warn('[mcp] Failed to resolve chain head, using provided UUID:', err);
    }

    // Broadcast to all browsers
    const msg = JSON.stringify({
      type: 'session_switch_request',
      requestId,
      targetSessionUuid: targetUuid,
      originalSessionUuid: session_uuid,
      refinedPrompt: refined_prompt,
      sourceSessionId: source_session_id || null,
    });
    for (const ws of store.statusClients) {
      if (ws.readyState === 1) ws.send(msg);
    }

    // Block until user responds (60s timeout)
    try {
      const result = await new Promise<{ action: 'rejected' | 'open' | 'open_and_close' }>((resolve) => {
        const timeout = setTimeout(() => {
          pendingSessionSwitches.delete(requestId);
          resolve({ action: 'rejected' });
        }, 60000);
        pendingSessionSwitches.set(requestId, { resolve, timeout });
      });
      res.json({ action: result.action, targetSessionUuid: targetUuid });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // MCP callback: open a file in the user's browser (with confirmation)
  app.post('/api/mcp/open-file', async (req, res) => {
    const { file_path } = req.body;
    if (!file_path || typeof file_path !== 'string') {
      return res.status(400).json({ error: 'file_path is required' });
    }

    const requestId = uuidv4();

    // Broadcast to all browsers
    const msg = JSON.stringify({ type: 'open_file_request', requestId, filePath: file_path });
    for (const ws of store.statusClients) {
      if (ws.readyState === 1) ws.send(msg);
    }

    // Block until user responds (30s timeout)
    try {
      const result = await new Promise<{ action: 'approved' | 'rejected' }>((resolve) => {
        const timeout = setTimeout(() => {
          pendingOpenFiles.delete(requestId);
          resolve({ action: 'rejected' });
        }, 30000);
        pendingOpenFiles.set(requestId, { resolve, timeout });
      });
      res.json({ action: result.action });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // MCP callback: ask the user structured questions via wizard UI (blocks until user responds — no timeout)
  app.post('/api/mcp/ask-user', async (req, res) => {
    const { session_uuid, questions } = req.body;
    if (!session_uuid || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'session_uuid and questions (non-empty array) are required' });
    }

    // Resolve CLI UUID to agent session ID
    let agentSessionId: string | null = null;
    for (const info of agentRegistry.listAgents()) {
      const agent = agentRegistry.getAgent(info.sessionId);
      if (agent) {
        const cliId = agent.getCliSessionId?.();
        if (cliId === session_uuid) {
          agentSessionId = info.sessionId;
          break;
        }
      }
    }
    if (!agentSessionId) {
      return res.status(404).json({ error: 'No active agent session found for this session UUID' });
    }

    // Check if there's already a pending ask-user for this session
    for (const pending of pendingAskUsers.values()) {
      if (pending.sessionId === agentSessionId) {
        return res.status(409).json({ error: 'Another ask_user request is already pending for this session' });
      }
    }

    const requestId = uuidv4();

    // Broadcast to all browsers
    const msg = JSON.stringify({
      type: 'ask_user_request',
      requestId,
      sessionId: agentSessionId,
      questions,
    });
    for (const ws of store.statusClients) {
      if (ws.readyState === 1) ws.send(msg);
    }

    // Block until user responds (no timeout)
    try {
      const result = await new Promise<{ status: 'answered' | 'cancelled'; answers?: Record<string, any> }>((resolve) => {
        pendingAskUsers.set(requestId, { resolve, sessionId: agentSessionId! });
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Helper: resolve chain UUIDs from a session UUID and project cwd
  async function resolveChainUuids(sessionUuid: string, cwd: string): Promise<string[]> {
    const allFiles = await agentRegistry.getSessionFilesForProject(cwd);
    const allUuids = allFiles.map(f => {
      const basename = path.basename(f, '.jsonl');
      const m = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      return m ? m[1] : '';
    }).filter(Boolean);
    return walkChain(sessionUuid, allUuids);
  }

  // Helper: resolve a session_uuid that might be an agent_xxx ID to its CLI UUID
  function resolveToCliUuid(sessionUuid: string): string {
    // If it's an agent session ID, look up its CLI UUID
    const agent = agentRegistry.getAgent(sessionUuid);
    if (agent) {
      const cliId = agent.getCliSessionId?.();
      if (cliId) return cliId;
    }
    return sessionUuid;
  }

  // Helper: find active agent session IDs whose CLI UUID is in the given set
  function findAgentSessionIds(chainUuids: string[]): string[] {
    const uuidSet = new Set(chainUuids);
    const agentIds: string[] = [];
    for (const info of agentRegistry.listAgents()) {
      const agent = agentRegistry.getAgent(info.sessionId);
      if (agent) {
        const cliId = agent.getCliSessionId?.();
        if (cliId && uuidSet.has(cliId)) {
          agentIds.push(info.sessionId);
        }
      }
    }
    return agentIds;
  }

  // Helper: merge metadata across a chain (name/description from latest, tags deduplicated)
  function mergeChainMetadata(chainUuids: string[]): { name?: string; description?: string; tags: string[] } {
    const allMeta = db.getMetadataForSessions(chainUuids);
    const allTags = new Set<string>();
    let name: string | undefined;
    let description: string | undefined;
    // Walk from newest to oldest for name/description (first found wins)
    for (let i = chainUuids.length - 1; i >= 0; i--) {
      const meta = allMeta[chainUuids[i]];
      if (!meta) continue;
      if (!name && meta.name) name = meta.name;
      if (!description && meta.description) description = meta.description;
      for (const t of meta.tags) allTags.add(t);
    }
    return { name, description, tags: Array.from(allTags) };
  }

  // MCP callback: get metadata for a session chain
  app.post('/api/mcp/get-metadata', async (req, res) => {
    const { session_uuid, cwd } = req.body;
    if (!session_uuid) {
      return res.status(400).json({ error: 'session_uuid is required' });
    }
    try {
      const cliUuid = resolveToCliUuid(session_uuid);
      const chainUuids = await resolveChainUuids(cliUuid, cwd || process.cwd());
      const agentIds = findAgentSessionIds(chainUuids);
      const merged = mergeChainMetadata(chainUuids);
      res.json({ ...merged, chainSessionIds: [...chainUuids, ...agentIds] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // MCP callback: set metadata on a session
  app.post('/api/mcp/set-metadata', async (req, res) => {
    const { session_uuid, name, description, tags, cwd } = req.body;
    if (!session_uuid) {
      return res.status(400).json({ error: 'session_uuid is required' });
    }
    if (name === undefined && description === undefined && tags === undefined) {
      return res.status(400).json({ error: 'At least one of name, description, or tags is required' });
    }
    try {
      db.setSessionMetadata(session_uuid, { name, description, tags });
      // Also update session.json for atoo-any sessions (self-contained metadata)
      try {
        const { readSession, writeSession, getSessionDir } = await import('../agents/atoo-any/session-store.js');
        const sessionDir = getSessionDir(cwd || process.cwd(), session_uuid);
        const session = readSession(sessionDir);
        if (name !== undefined) session.metadata.name = name;
        if (description !== undefined) session.metadata.description = description;
        if (tags !== undefined) session.metadata.tags = tags;
        writeSession(sessionDir, session);
      } catch {} // Not an atoo-any session, ignore
      const chainUuids = await resolveChainUuids(session_uuid, cwd || process.cwd());
      const agentIds = findAgentSessionIds(chainUuids);
      const merged = mergeChainMetadata(chainUuids);
      // Broadcast to all browsers — include both CLI UUIDs and agent_xxx IDs
      const msg = JSON.stringify({
        type: 'session_metadata_updated',
        sessionUuids: [...chainUuids, ...agentIds],
        ...merged,
      });
      for (const ws of store.statusClients) {
        if (ws.readyState === 1) ws.send(msg);
      }
      res.json({ success: true, ...merged });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // MCP callback: search session history files for the current project
  app.post('/api/mcp/search-history', async (req, res) => {
    const { query, max_results, max_results_per_query, cwd, type, session_uuid, sort } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }
    if (!cwd || typeof cwd !== 'string') {
      return res.status(400).json({ error: 'cwd is required' });
    }
    try {
      // Support both old (max_results) and new (max_results_per_query) parameter names
      const limit = max_results_per_query ?? max_results ?? 50;
      const results = await searchSessionHistory(query, cwd, limit, {
        type: type || 'FullProjectSearch',
        sessionUuid: session_uuid,
        sort: sort || 'newest_first',
      });
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // MCP callback: fetch full messages from a session by range
  app.post('/api/mcp/fetch-history-range', async (req, res) => {
    const { cwd, type, session_uuid, sort, session, target_session_uuid, from, to } = req.body;
    if (!cwd || typeof cwd !== 'string') {
      return res.status(400).json({ error: 'cwd is required' });
    }
    if (session == null && !target_session_uuid) {
      return res.status(400).json({ error: 'session or target_session_uuid is required' });
    }
    if (from == null || to == null) {
      return res.status(400).json({ error: 'from and to are required' });
    }
    try {
      const result = await fetchSessionRange(cwd, {
        type: type || 'FullProjectSearch',
        sessionUuid: session_uuid,
        sort: sort || 'newest_first',
        session,
        targetSessionUuid: target_session_uuid,
        from,
        to,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // MCP callback: database connect/query/schema (must be before auth wall)
  app.post('/api/mcp/connect-database', handleMcpConnectDatabase);

  // MCP callback: track project changes ("what has been done")
  app.post('/api/mcp/track-changes', async (req, res) => {
    const { mode, id, short_description, long_description, tags, approx_files_affected, session_uuid, cwd } = req.body;
    if (!mode) return res.status(400).json({ error: 'mode is required' });

    // Resolve project from cwd
    const projectPath = cwd || process.cwd();
    const project = db.findProjectByPath(projectPath);
    if (!project) return res.status(404).json({ error: `No project found for path: ${projectPath}` });

    try {
      if (mode === 'get') {
        const changes = db.listProjectChanges(project.id);
        return res.json({ changes });
      } else if (mode === 'set') {
        if (!short_description) return res.status(400).json({ error: 'short_description is required for set mode' });
        if (approx_files_affected === undefined) return res.status(400).json({ error: 'approx_files_affected is required for set mode' });

        let change;
        if (id) {
          // Update existing
          const existing = db.getProjectChange(id);
          if (!existing) return res.status(404).json({ error: 'Change entry not found' });
          db.updateProjectChange(id, short_description, long_description || '', tags || [], approx_files_affected);
          change = db.getProjectChange(id);
        } else {
          // Create new
          change = db.createProjectChange(project.id, short_description, long_description || '', tags || [], approx_files_affected, session_uuid || null);
        }

        // Broadcast to UI
        const msg = JSON.stringify({ type: 'project_changes_updated', projectId: project.id });
        for (const ws of store.statusClients) {
          if (ws.readyState === 1) ws.send(msg);
        }

        return res.json({ change });
      } else if (mode === 'delete') {
        if (!id) return res.status(400).json({ error: 'id is required for delete mode' });
        const deleted = db.deleteProjectChange(id);
        if (!deleted) return res.status(404).json({ error: 'Change entry not found' });

        // Broadcast to UI
        const msg = JSON.stringify({ type: 'project_changes_updated', projectId: project.id });
        for (const ws of store.statusClients) {
          if (ws.readyState === 1) ws.send(msg);
        }

        return res.json({ message: 'Change deleted' });
      } else {
        return res.status(400).json({ error: `Unknown mode: ${mode}` });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════
  // Auth middleware — protects all routes below this point
  // Routes above (CA certs, auth, MCP callbacks) are exempt
  // ═══════════════════════════════════════════════════════
  app.use('/api', requireAuth);

  // List CLI environments (runtime) — no longer applicable without MITM proxy
  // ── Terminal file attachment ──────────────────────────────────────────
  // Receives a file (base64) from the browser, writes it to a temp dir,
  // returns the path so the frontend can inject it into the PTY.
  const ATTACHMENT_BASE = path.join(os.tmpdir(), 'atoo');
  app.post('/api/terminal/attachment', requireAuth, (req, res) => {
    try {
      const { filename, data } = req.body as { filename: string; data: string };
      if (!filename || !data) {
        res.status(400).json({ error: 'filename and data (base64) are required' });
        return;
      }
      // Sanitize filename: strip path separators, limit length
      const safeName = path.basename(filename).slice(0, 200) || 'attachment';
      const dirId = `attachment_${uuidv4()}`;
      const dir = path.join(ATTACHMENT_BASE, dirId);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, safeName);
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
      res.json({ path: filePath });
    } catch (err: any) {
      console.error('[attachment] Failed to write:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Cleanup old attachments on startup (older than 1 hour)
  try {
    if (fs.existsSync(ATTACHMENT_BASE)) {
      const cutoff = Date.now() - 3600_000;
      for (const entry of fs.readdirSync(ATTACHMENT_BASE)) {
        const full = path.join(ATTACHMENT_BASE, entry);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
        } catch {}
      }
    }
  } catch {}

  app.get('/api/cli-environments', (_req, res) => {
    res.json([]);
  });

  // Browse directories for folder picker
  app.get('/api/browse', (req, res) => {
    const dir = (req.query.path as string) || os.homedir();
    try {
      const resolved = path.resolve(dir);
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          path: path.join(resolved, e.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ current: resolved, parent: path.dirname(resolved), dirs });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/browse/mkdir', (req, res) => {
    const { path: dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: 'path is required' });
    try {
      const resolved = path.resolve(dirPath);
      fs.mkdirSync(resolved, { recursive: true });
      res.json({ success: true, path: resolved });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Extract text from office documents (docx, xlsx, pptx)
  app.post('/api/extract-text', async (req, res) => {
    const { data, name } = req.body;
    if (!data || !name) return res.status(400).json({ error: 'data and name are required' });

    const ext = name.split('.').pop()?.toLowerCase();
    const buf = Buffer.from(data, 'base64');

    try {
      let text = '';
      if (ext === 'docx') {
        const mammoth = await import('mammoth');
        const result = await mammoth.default.extractRawText({ buffer: buf });
        text = result.value;
      } else if (ext === 'xlsx' || ext === 'xls') {
        const ExcelJS = await import('exceljs');
        const workbook = new ExcelJS.default.Workbook();
        await workbook.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
        const sheets: string[] = [];
        workbook.eachSheet((sheet) => {
          const rows: string[] = [];
          sheet.eachRow((row) => {
            const values = (row.values as any[]).slice(1); // ExcelJS row.values is 1-indexed
            rows.push(values.map(v => v ?? '').join(','));
          });
          sheets.push(`--- Sheet: ${sheet.name} ---\n${rows.join('\n')}`);
        });
        text = sheets.join('\n\n');
      } else if (ext === 'pptx') {
        // pptx is a zip of XML slides — extract text from slide XML files
        const { Readable } = await import('stream');
        const unzipper = await import('unzipper');
        const slides: { num: number; text: string }[] = [];
        const stream = Readable.from(buf);
        const directory = await (stream.pipe(unzipper.default.Parse()) as any);
        for await (const entry of directory) {
          const entryPath: string = entry.path;
          if (entryPath.match(/^ppt\/slides\/slide\d+\.xml$/)) {
            const xml: string = (await entry.buffer()).toString('utf-8');
            // Extract text from <a:t> tags
            const texts: string[] = [];
            const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
            let m;
            while ((m = re.exec(xml)) !== null) texts.push(m[1]);
            const slideNum = parseInt(entryPath.match(/slide(\d+)/)?.[1] || '0');
            if (texts.length) slides.push({ num: slideNum, text: texts.join(' ') });
          } else {
            entry.autodrain();
          }
        }
        slides.sort((a, b) => a.num - b.num);
        text = slides.map(s => `--- Slide ${s.num} ---\n${s.text}`).join('\n\n');
      } else {
        return res.status(400).json({ error: `Unsupported file type: .${ext}` });
      }

      res.json({ text });
    } catch (err: any) {
      console.error(`[web] extract-text error for ${name}:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Broadcast dismiss_modal to all connected browsers so they close stale popups
  function broadcastDismissModal(requestId: string) {
    const msg = JSON.stringify({ type: 'dismiss_modal', requestId });
    for (const ws of store.statusClients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  // Frontend callbacks for MCP-initiated user prompts (serial, session switch, open file)
  app.post('/api/reject-serial', (req, res) => {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId required' });
    serialManager.rejectRequest(requestId, new Error('User rejected the serial device request'));
    serialManager.closeRequest(requestId);
    broadcastDismissModal(requestId);
    res.json({ success: true });
  });

  app.post('/api/respond-session-switch', (req, res) => {
    const { requestId, action } = req.body;
    if (!requestId || !action) {
      return res.status(400).json({ error: 'requestId and action are required' });
    }
    const pending = pendingSessionSwitches.get(requestId);
    if (!pending) {
      return res.status(404).json({ error: 'No pending request with this ID' });
    }
    clearTimeout(pending.timeout);
    pendingSessionSwitches.delete(requestId);
    pending.resolve({ action });
    broadcastDismissModal(requestId);
    res.json({ success: true });
  });

  app.post('/api/respond-open-file', (req, res) => {
    const { requestId, action } = req.body;
    if (!requestId || !action) {
      return res.status(400).json({ error: 'requestId and action are required' });
    }
    const pending = pendingOpenFiles.get(requestId);
    if (!pending) {
      return res.status(404).json({ error: 'No pending request with this ID' });
    }
    clearTimeout(pending.timeout);
    pendingOpenFiles.delete(requestId);
    pending.resolve({ action });
    broadcastDismissModal(requestId);
    res.json({ success: true });
  });

  app.post('/api/respond-ask-user', (req, res) => {
    const { requestId, answers, cancelled } = req.body;
    if (!requestId) {
      return res.status(400).json({ error: 'requestId is required' });
    }
    const pending = pendingAskUsers.get(requestId);
    if (!pending) {
      return res.status(404).json({ error: 'No pending ask-user request with this ID' });
    }
    pendingAskUsers.delete(requestId);
    if (cancelled) {
      pending.resolve({ status: 'cancelled' });
    } else {
      pending.resolve({ status: 'answered', answers: answers || {} });
    }
    broadcastDismissModal(requestId);
    res.json({ success: true });
  });

  // Mount changes API routes
  app.use(changesRouter);

  // Project changes ("what has been done") — REST API for frontend
  app.get('/api/projects/:id/changes', (req, res) => {
    const changes = db.listProjectChanges(req.params.id);
    res.json({ changes });
  });

  app.delete('/api/projects/:id/changes/:changeId', (req, res) => {
    const deleted = db.deleteProjectChange(req.params.changeId);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  });

  app.delete('/api/projects/:id/changes', (req, res) => {
    const count = db.deleteAllProjectChanges(req.params.id);
    res.json({ deleted: count });
  });

  // Mount project/file/git API routes
  app.use(projectsRouter);

  // Mount environment API routes
  app.use(environmentsRouter);

  // Mount SSH API routes
  app.use(sshRouter);

  // Mount GitHub integration API routes
  app.use(githubRouter);

  // Mount container management API routes
  app.use(containersRouter);

  // Mount database explorer API routes
  app.use(databasesRouter);

  // Mount DevTools proxy
  app.use(devtoolsProxyMiddleware());

  // Preview: upload files for file chooser interception
  app.post('/api/preview/:projectId/:tabId/upload', (req, res) => {
    const { projectId, tabId } = req.params;
    const { files, backendNodeId } = req.body;
    // files = [{ name: string, data: string (base64) }]
    if (!Array.isArray(files) || !backendNodeId) {
      return res.status(400).json({ error: 'files array and backendNodeId required' });
    }
    const instance = previewManager.get(decodeURIComponent(projectId), decodeURIComponent(tabId));
    if (!instance) return res.status(404).json({ error: 'Preview instance not found' });

    const tmpDir = path.join(os.tmpdir(), 'atoo-studio-uploads', `${projectId}_${tabId}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const filePaths: string[] = [];
    for (const f of files) {
      const filePath = path.join(tmpDir, f.name);
      fs.writeFileSync(filePath, Buffer.from(f.data, 'base64'));
      filePaths.push(filePath);
    }

    previewManager.handleFileChooserResponse(
      decodeURIComponent(projectId), decodeURIComponent(tabId),
      backendNodeId, filePaths,
    ).then(() => res.json({ success: true }))
     .catch((err: any) => res.status(500).json({ error: err.message }));
  });

  // Preview: download intercepted file
  app.get('/api/preview/:projectId/:tabId/download/:guid', (req, res) => {
    const { projectId, tabId, guid } = req.params;
    const filePath = previewManager.getDownloadPath(
      decodeURIComponent(projectId), decodeURIComponent(tabId), guid,
    );
    if (!filePath) return res.status(404).json({ error: 'Download not found' });
    res.download(filePath);
  });

  // List running shell terminals
  app.get('/api/terminals', (_req, res) => {
    const terminals = [];
    for (const [id, entry] of shellTerminals) {
      terminals.push({ id, cwd: entry.cwd, projectPath: entry.projectPath, pid: entry.pty.pid });
    }
    res.json(terminals);
  });

  // Spawn a standalone shell terminal
  app.post('/api/terminals', (req, res) => {
    const { cwd } = req.body || {};
    const shell = process.env.SHELL || '/bin/bash';
    const termCwd = cwd || os.homedir();
    const id = uuidv4();

    try {
      const term = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: termCwd,
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      });
      shellTerminals.set(id, { pty: term, cwd: termCwd, projectPath: termCwd });

      // Broadcast terminal_created to all status clients (cross-browser sync)
      const createdMsg = JSON.stringify({ type: 'terminal_created', terminal: { id, cwd: termCwd, projectPath: termCwd, pid: term.pid } });
      for (const ws of store.statusClients) {
        if (ws.readyState === 1) ws.send(createdMsg);
      }

      term.onExit(() => {
        shellTerminals.delete(id);
        // Broadcast terminal_exited to all status clients
        const exitMsg = JSON.stringify({ type: 'terminal_exited', terminal: { id } });
        for (const ws of store.statusClients) {
          if (ws.readyState === 1) ws.send(exitMsg);
        }
      });

      console.log(`[shell] Spawned standalone terminal ${id} (PID ${term.pid}) in ${termCwd}`);
      res.json({ id, pid: term.pid });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Kill a shell terminal
  app.delete('/api/terminals/:id', (req, res) => {
    const entry = shellTerminals.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Terminal not found' });
    entry.pty.kill();
    res.json({ success: true });
  });

  // Server LAN IP for nip.io reverse proxy URLs
  app.get('/api/server-ip', (req, res) => {
    // If the client connected via IP already, return that
    const host = req.hostname;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      return res.json({ ip: host });
    }
    // Otherwise find first non-internal IPv4 address
    const nets = os.networkInterfaces();
    for (const ifaces of Object.values(nets)) {
      for (const iface of ifaces || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return res.json({ ip: iface.address });
        }
      }
    }
    res.json({ ip: '127.0.0.1' });
  });

  // Status
  app.get('/api/status', (_req, res) => {
    res.json({
      sessions: store.sessions.size,
    });
  });

  // Dependencies check
  app.get('/api/dependencies', (_req, res) => {
    function getVersion(cmd: string): string | null {
      try {
        return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
      } catch {
        return null;
      }
    }

    function hasCommand(cmd: string): boolean {
      try {
        execSync(`which ${cmd}`, { stdio: 'ignore', timeout: 3000 });
        return true;
      } catch {
        return false;
      }
    }

    const platform = process.platform;
    const deps: { name: string; description: string; installed: boolean; version: string | null; required: boolean; category: string }[] = [];

    // Required
    deps.push({
      name: 'git',
      description: 'Version control, worktrees, file tracking',
      installed: hasCommand('git'),
      version: getVersion('git --version'),
      required: true,
      category: 'Core',
    });

    // Agent CLIs
    deps.push({
      name: 'claude',
      description: 'Claude Code agent',
      installed: hasCommand('claude'),
      version: getVersion('claude --version'),
      required: false,
      category: 'Agents',
    });
    deps.push({
      name: 'codex',
      description: 'Codex agent',
      installed: hasCommand('codex'),
      version: getVersion('codex --version'),
      required: false,
      category: 'Agents',
    });

    // Integrations
    deps.push({
      name: 'gh',
      description: 'GitHub integration (issues, PRs)',
      installed: hasCommand('gh'),
      version: getVersion('gh --version'),
      required: false,
      category: 'Integrations',
    });

    // Container runtimes
    deps.push({
      name: 'docker',
      description: 'Docker container management',
      installed: hasCommand('docker'),
      version: getVersion('docker --version'),
      required: false,
      category: 'Containers',
    });
    deps.push({
      name: 'podman',
      description: 'Podman container management',
      installed: hasCommand('podman'),
      version: getVersion('podman --version'),
      required: false,
      category: 'Containers',
    });
    deps.push({
      name: 'lxc',
      description: 'LXC container management',
      installed: hasCommand('lxc'),
      version: getVersion('lxc --version'),
      required: false,
      category: 'Containers',
    });

    // Media
    deps.push({
      name: 'ffmpeg',
      description: 'Screen recording',
      installed: hasCommand('ffmpeg'),
      version: getVersion('ffmpeg -version'),
      required: false,
      category: 'Media',
    });

    // Linux-specific
    if (platform === 'linux') {
      let chromeLibs = false;
      try {
        execSync('ldconfig -p | grep -q libatk-1.0', { stdio: 'ignore', timeout: 3000 });
        chromeLibs = true;
      } catch {}

      deps.push({
        name: 'Chrome libs',
        description: 'Browser preview (Puppeteer dependencies)',
        installed: chromeLibs,
        version: null,
        required: false,
        category: 'Preview',
      });

      const cusebin = path.join(process.env.HOME || '', '.atoo-studio', 'bin', 'cuse_serial');
      const cuseReady = fs.existsSync('/dev/cuse') && fs.existsSync(cusebin);
      deps.push({
        name: 'CUSE',
        description: 'Serial control signals (DTR/RTS)',
        installed: cuseReady,
        version: null,
        required: false,
        category: 'Serial',
      });
    }

    res.json({ platform, deps });
  });

  // ═══════════════════════════════════════════════════════
  // Update check & self-update
  // ═══════════════════════════════════════════════════════

  // Cache the update check so we don't hammer the registry
  let updateCache: { currentVersion: string; latestVersion: string; updateAvailable: boolean; checkedAt: number } | null = null;
  const UPDATE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

  app.get('/api/check-update', async (_req, res) => {
    try {
      // Return cached result if fresh
      if (updateCache && Date.now() - updateCache.checkedAt < UPDATE_CACHE_TTL) {
        return res.json(updateCache);
      }

      const pkgPath = path.join(PROJECT_ROOT, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const currentVersion: string = pkg.version;

      // Fetch latest version from npm registry
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch('https://registry.npmjs.org/atoo-studio/latest', { signal: controller.signal });
      clearTimeout(timeout);

      if (!resp.ok) throw new Error(`npm registry returned ${resp.status}`);
      const data = await resp.json() as { version: string };
      const latestVersion = data.version;

      // Simple semver comparison: split into parts and compare numerically
      const parseSemver = (v: string) => v.replace(/^v/, '').split('.').map(Number);
      const cur = parseSemver(currentVersion);
      const lat = parseSemver(latestVersion);
      const updateAvailable = lat[0] > cur[0]
        || (lat[0] === cur[0] && lat[1] > cur[1])
        || (lat[0] === cur[0] && lat[1] === cur[1] && lat[2] > cur[2]);

      updateCache = { currentVersion, latestVersion, updateAvailable, checkedAt: Date.now() };
      res.json(updateCache);
    } catch (err: any) {
      // Still return current version even if registry check fails
      try {
        const pkgPath = path.join(PROJECT_ROOT, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        res.json({ currentVersion: pkg.version, latestVersion: null, updateAvailable: false, error: err.message });
      } catch {
        res.status(500).json({ error: 'Failed to check for updates' });
      }
    }
  });

  app.post('/api/update', async (_req, res) => {
    try {
      // Determine how atoo-studio was installed
      const binPath = process.argv[1] || '';
      const isGlobal = binPath.includes('/node_modules/.global') || binPath.includes('/lib/node_modules/');
      const npmCmd = isGlobal ? 'npm install -g atoo-studio@latest' : 'npx atoo-studio@latest';

      // Run the update
      const { exec } = await import('child_process');
      const child = exec('npm install -g atoo-studio@latest', { timeout: 120000 });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: string) => { stdout += d; });
      child.stderr?.on('data', (d: string) => { stderr += d; });

      child.on('close', (code) => {
        // Invalidate cache
        updateCache = null;
        if (code === 0) {
          res.json({ success: true, output: stdout.trim(), restartRequired: true });
        } else {
          res.status(500).json({ success: false, error: stderr.trim() || `Exit code ${code}` });
        }
      });

      child.on('error', (err) => {
        res.status(500).json({ success: false, error: err.message });
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });


  // ═══════════════════════════════════════════════════════
  // Agent Session Endpoints (abstract layer)
  // ═══════════════════════════════════════════════════════

  // Create a new agent session
  app.post('/api/agent-sessions', async (req, res) => {
    const { agentType, cwd, skipPermissions, message, linkedIssue,
            resumeSessionUuid, forkParentSessionId, forkAfterEventUuid, forkFromEventUuid } = req.body;

    const type = agentType || 'claude-code-terminal-chatro';
    const sessionId = `agent_${uuidv4()}`;

    try {
      // Resolve fork: delegate to the parent agent to produce a resumable JSONL
      let resolvedResumeUuid = resumeSessionUuid;

      if (forkParentSessionId && forkAfterEventUuid) {
        const parentAgent = agentRegistry.getAgent(forkParentSessionId);
        if (!parentAgent) {
          return res.status(404).json({ error: `Parent agent not found: ${forkParentSessionId}` });
        }

        const resumeUuid = parentAgent.forkToResumable(
          forkAfterEventUuid,
          forkFromEventUuid,
          cwd || parentAgent.getInfo().cwd,
        );

        if (resumeUuid) {
          // Fork always writes Claude JSONL — convert if target is a different family
          const parentAgentType = parentAgent.getInfo().agentType;
          resolvedResumeUuid = await agentRegistry.convertForkForAgent(
            resumeUuid, parentAgentType, type, cwd || parentAgent.getInfo().cwd || '.',
          );
        } else {
          return res.status(400).json({ error: 'Agent does not support forking or fork point not found' });
        }
      }

      const agent = await agentRegistry.createAgent(type, sessionId, {
        cwd: cwd || undefined,
        skipPermissions: !!skipPermissions,
        resumeSessionUuid: resolvedResumeUuid,
        initialMessage: message || undefined,
      });

      if (linkedIssue) {
        agentRegistry.setBrowserState(sessionId, { linkedIssue });
      }

      const info = agent.getInfo();
      if (linkedIssue) info.linkedIssue = linkedIssue;
      res.json(info);
    } catch (err: any) {
      console.error(`[web] Failed to create agent session:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // List agent sessions
  app.get('/api/agent-sessions', (_req, res) => {
    res.json(agentRegistry.listAgents());
  });

  // Update browser-side state for a session (cached in memory, not DB)
  app.patch('/api/agent-sessions/:id/browser-state', (req, res) => {
    const { id } = req.params;
    const state = req.body;
    agentRegistry.setBrowserState(id, state);
    res.json({ ok: true });
  });

  // Available agent types (for agent picker UI)
  app.get('/api/available-agents', (_req, res) => {
    res.json(agentRegistry.getAvailableAgents());
  });

  // Historical sessions from all agent implementations
  // Optional ?cwd= param to filter by project path (includes worktree-related paths)
  app.get('/api/historical-sessions', async (req, res) => {
    try {
      const cwd = req.query.cwd as string | undefined;
      const sessions = await agentRegistry.getHistoricalSessions(cwd);
      // Enrich with metadata from DB
      if (sessions.length) {
        const allMeta = db.getMetadataForSessions(sessions.map(s => s.id));
        for (const s of sessions) {
          const meta = allMeta[s.id];
          if (meta?.name) s.metaName = meta.name;
          if (meta?.tags?.length) s.tags = meta.tags;
        }
      }
      res.json(sessions);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve blob files from atoo-any sessions
  app.get('/api/sessions/:uuid/blobs/:hash', (req, res) => {
    const { uuid, hash } = req.params;
    const cwd = (req.query.cwd as string) || process.cwd();
    try {
      const { getBlobPath, getSessionDir } = require('../agents/atoo-any/session-store.js');
      const sessionDir = getSessionDir(cwd, uuid);
      const blobPath = getBlobPath(sessionDir, hash);
      if (!require('fs').existsSync(blobPath)) {
        return res.status(404).json({ error: 'Blob not found' });
      }
      res.sendFile(blobPath);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create a chain continuation from an existing session.
  // Accepts either:
  //   - agentSessionId: an active agent session (agent_xxx) — reads events from live agent memory
  //   - sessionUuid: a historical JSONL session UUID — reads events from disk
  app.post('/api/agent-sessions/chain', async (req, res) => {
    const { agentSessionId, sessionUuid, cwd, skipPermissions, agentType } = req.body;

    try {
      let newAgent;

      if (agentSessionId) {
        // Active agent: try reading events from memory first, fall back to disk
        const activeAgent = agentRegistry.getAgent(agentSessionId);
        if (!activeAgent) {
          return res.status(404).json({ error: `Active agent not found: ${agentSessionId}` });
        }

        const events = activeAgent.getEvents();
        const cliUuid = activeAgent.getCliSessionId?.();
        const parentId = cliUuid || agentSessionId;
        console.log(`[web] Chain request for ${agentSessionId}: events=${events.length}, cliUuid=${cliUuid || 'null'}, agentType=${activeAgent.getInfo().agentType}`);

        if (events.length > 0) {
          // In-memory events available — build chain directly
          newAgent = await agentRegistry.chainFromEvents(events, parentId, {
            cwd: cwd || undefined,
            skipPermissions: !!skipPermissions,
            agentType: agentType || undefined,
          });
        } else if (cliUuid) {
          // No in-memory events (e.g. terminal-only adapter) — read from JSONL on disk
          newAgent = await agentRegistry.chainAgent(cliUuid, {
            cwd: cwd || undefined,
            skipPermissions: !!skipPermissions,
            agentType: agentType || undefined,
          });
        } else {
          return res.status(400).json({
            error: 'Could not determine CLI session UUID. The session hook may not have fired — try sending a message first, then chain again.',
          });
        }

        // Destroy the old active agent — the chain link replaces it
        agentRegistry.destroyAgent(agentSessionId).catch(err => {
          console.warn(`[web] Failed to destroy old agent after chain:`, err.message);
        });
      } else if (sessionUuid) {
        // Historical session: read events from disk via factory
        newAgent = await agentRegistry.chainAgent(sessionUuid, {
          cwd: cwd || undefined,
          skipPermissions: !!skipPermissions,
          agentType: agentType || undefined,
        });
      } else {
        return res.status(400).json({ error: 'agentSessionId or sessionUuid is required' });
      }

      res.json(newAgent.getInfo());
    } catch (err: any) {
      console.error(`[web] Failed to create chain session:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Resume a historical session — optionally with a specific agent type
  app.post('/api/agent-sessions/resume', async (req, res) => {
    const { sessionUuid, cwd, skipPermissions, agentType } = req.body;
    if (!sessionUuid) {
      return res.status(400).json({ error: 'sessionUuid is required' });
    }

    try {
      const agent = await agentRegistry.resumeAgent(sessionUuid, {
        cwd: cwd || undefined,
        skipPermissions: !!skipPermissions,
        agentType: agentType || undefined,
      });
      res.json(agent.getInfo());
    } catch (err: any) {
      console.error(`[web] Failed to resume session:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Destroy an agent session
  app.delete('/api/agent-sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    try {
      await agentRegistry.destroyAgent(sessionId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve frontend static files (production)
  const projectRoot = PROJECT_ROOT;
  const frontendDist = path.join(projectRoot, 'frontend', 'dist');
  app.use(express.static(frontendDist));
  app.get('{*path}', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
      if (err) {
        res.status(200).send(`
          <html>
            <body style="font-family:monospace;padding:2em;background:#1a1a2e;color:#e0e0e0">
              <h1>Atoo Studio</h1>
              <p>Frontend not built yet. Run <code>cd frontend && npm run build</code></p>
              <p>Or use the API directly:</p>
              <ul>
                <li>GET <a href="/api/status">/api/status</a></li>
                <li>GET <a href="/api/cli-environments">/api/cli-environments</a></li>
                <li>GET <a href="/api/agent-sessions">/api/agent-sessions</a></li>
              </ul>
            </body>
          </html>
        `);
      }
    });
  });

  const server = tlsOptions
    ? https.createServer(tlsOptions, app)
    : http.createServer(app);

  // Broadcast file change events to session subscribers
  fsMonitor.onChangeEvent((change) => {
    const event = {
      type: 'file_change',
      change: {
        change_id: change.changeId,
        session_id: change.sessionId,
        timestamp: change.timestamp,
        pid: change.pid,
        operation: change.operation,
        path: change.path,
        old_path: change.oldPath || null,
        before_hash: change.beforeHash,
        after_hash: change.afterHash,
        file_size: change.fileSize,
        is_binary: change.isBinary,
      },
    };
    // Legacy: store.broadcastToSubscribers(change.sessionId, event);
  });

  // Settings WS clients for real-time sync across browser tabs
  const settingsClients = new Set<WebSocket>();
  setBroadcastSettingsChange((scope, key, settings, excludeWs) => {
    const msg = JSON.stringify({ type: 'settings_change', scope, key, settings });
    for (const ws of settingsClients) {
      if (ws !== excludeWs && ws.readyState === 1) {
        ws.send(msg);
      }
    }
  });

  // WebSocket for frontend live updates
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    // Port proxy WebSocket upgrades — check first
    if (isPortProxyUpgrade(req)) {
      handlePortProxyUpgrade(portProxy, req, socket, head);
      return;
    }

    // Authenticate WebSocket upgrades when auth is enabled
    if (isAuthEnabled()) {
      const user = authenticateWsUpgrade(req);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      (req as any).user = user;
    }

    const url = req.url || '';

    // /ws/agent/:sessionId — abstract agent WebSocket (new)
    if (isAgentWsUpgrade(url)) {
      handleAgentWsUpgrade(wss, req, socket, head);
      return;
    }

    // /ws/preview/:projectId/:tabId — remote browser streaming
    if (isPreviewWsUpgrade(url)) {
      handlePreviewWsUpgrade(wss, req, socket, head);
      return;
    }

    // /ws/devtools/:projectId/:tabId/* — DevTools WebSocket proxy
    if (isDevtoolsWsUpgrade(url)) {
      handleDevtoolsWsUpgrade(wss, req, socket, head);
      return;
    }

    if (url.startsWith('/ws/status')) {
      // Global agent status stream for sidebar
      wss.handleUpgrade(req, socket, head, (ws) => {
        store.statusClients.add(ws);
        // Send current statuses
        for (const [sid, status] of store.agentStatuses.entries()) {
          ws.send(JSON.stringify({ type: 'agent_status', status, session_id: sid }));
        }
        // Send current context usage
        for (const [sid, usage] of store.contextUsages.entries()) {
          ws.send(JSON.stringify({ type: 'context_usage', session_id: sid, ...usage }));
        }
        // Send current context-in-progress state
        for (const sid of store.contextInProgressSessions) {
          ws.send(JSON.stringify({ type: 'context_in_progress', session_id: sid, inProgress: true }));
        }
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'session_focus' && msg.session_id) {
              agentRegistry.setSessionFocused(msg.session_id);
            } else if (msg.type === 'session_blur' && msg.session_id) {
              agentRegistry.setSessionBlurred(msg.session_id);
            }
          } catch {}
        });
        ws.on('close', () => store.statusClients.delete(ws));
      });
    } else if (url.startsWith('/ws/settings')) {
      // Settings sync across browser tabs
      wss.handleUpgrade(req, socket, head, (ws) => {
        settingsClients.add(ws);
        ws.on('close', () => settingsClients.delete(ws));
      });
    } else {
      // /ws/terminal/:sessionId — pty I/O for browser terminal
      const termMatch = url.match(/^\/ws\/terminal\/([^/?]+)/);
      if (termMatch) {
        const sessionId = termMatch[1];
        // Resolve agent session IDs to the underlying CLI envId
        let envId = getEnvIdForSession(sessionId);
        if (!envId) {
          // Try agent registry — agent sessions use agent_* IDs
          const agent = agentRegistry.getAgent(sessionId);
          if (agent) {
            envId = (agent as any).envId;
          }
        }
        if (!envId) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }
        const ptyProcess = getPty(envId);
        if (!ptyProcess) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          console.log(`[ws:terminal] Browser connected for session ${sessionId}`);

          // Keep-alive pings to prevent idle timeouts
          const pingInterval = setInterval(() => {
            if (ws.readyState === 1) ws.ping();
          }, 30000);

          // Get or create broadcast entry for this session's terminal
          if (!terminalClients.has(sessionId)) {
            // Seed scrollback from spawner's buffer (captures PTY output since spawn)
            const spawnerBuf = envId ? getScrollback(envId) : '';
            terminalClients.set(sessionId, { clients: new Set(), handler: null, scrollback: spawnerBuf });
          }
          const entry = terminalClients.get(sessionId)!;
          entry.clients.add(ws);

          // Replay scrollback buffer to this late-joining client
          if (entry.scrollback) {
            ws.send(JSON.stringify({ type: 'output', data: entry.scrollback }));
          }

          // Register single shared onData handler if first client.
          // PTY output is coalesced into ~16ms frames to avoid flicker:
          // TUI apps (ink, etc.) redraw by emitting clear + new content as
          // separate write() calls.  Without buffering, each chunk becomes
          // its own WebSocket message and xterm may render an intermediate
          // "cleared" frame, causing visible scroll-up-then-down flicker.
          if (!entry.handler) {
            let pendingData = '';
            let flushTimer: ReturnType<typeof setTimeout> | null = null;
            const flushToClients = () => {
              flushTimer = null;
              if (!pendingData) return;
              const msg = JSON.stringify({ type: 'output', data: pendingData });
              pendingData = '';
              for (const client of entry.clients) {
                if (client.readyState === 1) {
                  client.send(msg);
                }
              }
            };
            entry.handler = ptyProcess.onData((data: string) => {
              // Append to scrollback buffer (ring-trim if too large)
              entry.scrollback += data;
              if (entry.scrollback.length > MAX_SCROLLBACK) {
                entry.scrollback = entry.scrollback.slice(-MAX_SCROLLBACK);
              }
              pendingData += data;
              if (!flushTimer) {
                flushTimer = setTimeout(flushToClients, 16);
              }
            });
          }

          // Receive input/resize from browser
          ws.on('message', (raw) => {
            try {
              const msg = JSON.parse(raw.toString());
              if (msg.type === 'input' && typeof msg.data === 'string') {
                ptyProcess.write(msg.data);
              } else if (msg.type === 'resize' && msg.rows) {
                // Keep cols fixed at 120 for agent PTYs — only resize rows.
                // This ensures consistent output formatting regardless of
                // browser window size.
                ptyProcess.resize(120, msg.rows);
              }
            } catch {}
          });

          ws.on('close', () => {
            console.log(`[ws:terminal] Browser disconnected for session ${sessionId}`);
            clearInterval(pingInterval);
            entry.clients.delete(ws);
            // Keep handler alive so scrollback continues accumulating even with no browsers
          });
        });
      } else {
        // /ws/serial/:requestId — serial device passthrough
        const serialMatch = url.match(/^\/ws\/serial\/([^/?]+)/);
        if (serialMatch) {
          const requestId = serialMatch[1];
          const serialReq = serialManager.getRequest(requestId);
          if (!serialReq || serialReq.status !== 'pending') {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
          }

          wss.handleUpgrade(req, socket, head, (ws) => {
            console.log(`[ws:serial] Browser connected for request ${requestId}`);

            // Link browser WS and start data piping
            serialManager.connectBrowser(requestId, ws);

            // Browser → PTY: binary = serial data, text = control messages
            ws.on('message', (data, isBinary) => {
              if (isBinary) {
                serialManager.handleBrowserData(requestId, Buffer.from(data as ArrayBuffer));
              } else {
                try {
                  const msg = JSON.parse(data.toString());
                  serialManager.handleBrowserControl(requestId, msg);
                } catch {}
              }
            });

            ws.on('close', () => {
              console.log(`[ws:serial] Browser disconnected for request ${requestId}`);
              serialManager.closeRequest(requestId);
            });
          });
          return;
        }

        // /ws/shell/:id — standalone shell terminal
        const shellMatch = url.match(/^\/ws\/shell\/([^/?]+)/);
        if (shellMatch) {
          const shellId = shellMatch[1];
          const shellEntry = shellTerminals.get(shellId);
          if (!shellEntry) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
          }

          wss.handleUpgrade(req, socket, head, (ws) => {
            console.log(`[ws:shell] Browser connected for shell ${shellId}`);
            const ptyProcess = shellEntry.pty;

            // Keep-alive pings to prevent idle timeouts
            const pingInterval = setInterval(() => {
              if (ws.readyState === 1) ws.ping();
            }, 30000);

            // Get or create broadcast entry for this shell
            if (!shellClients.has(shellId)) {
              shellClients.set(shellId, { clients: new Set(), handler: null, scrollback: '' });
            }
            const entry = shellClients.get(shellId)!;
            entry.clients.add(ws);

            // Replay scrollback buffer to this late-joining client
            if (entry.scrollback) {
              ws.send(JSON.stringify({ type: 'output', data: entry.scrollback }));
            }

            // Register single shared onData handler if first client
            // (coalesced into ~16ms frames — same anti-flicker logic as terminal handler)
            if (!entry.handler) {
              let pendingData = '';
              let flushTimer: ReturnType<typeof setTimeout> | null = null;
              const flushToClients = () => {
                flushTimer = null;
                if (!pendingData) return;
                const msg = JSON.stringify({ type: 'output', data: pendingData });
                pendingData = '';
                for (const client of entry.clients) {
                  if (client.readyState === 1) {
                    client.send(msg);
                  }
                }
              };
              entry.handler = ptyProcess.onData((data: string) => {
                entry.scrollback += data;
                if (entry.scrollback.length > MAX_SCROLLBACK) {
                  entry.scrollback = entry.scrollback.slice(-MAX_SCROLLBACK);
                }
                pendingData += data;
                if (!flushTimer) {
                  flushTimer = setTimeout(flushToClients, 16);
                }
              });
            }

            ws.on('message', (raw) => {
              try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'input' && typeof msg.data === 'string') {
                  ptyProcess.write(msg.data);
                } else if (msg.type === 'resize' && msg.cols && msg.rows) {
                  ptyProcess.resize(msg.cols, msg.rows);
                }
              } catch {}
            });

            ws.on('close', () => {
              console.log(`[ws:shell] Browser disconnected for shell ${shellId}`);
              clearInterval(pingInterval);
              entry.clients.delete(ws);
              // Keep handler alive so scrollback continues accumulating even with no browsers
            });
          });
        }

        // /ws/database-query/:connectionId — stream query results
        if (isDatabaseWsUpgrade(url)) {
          handleDatabaseWsUpgrade(wss, req, socket, head);
          return;
        }

        // /ws/container-logs/:runtime/:containerId — stream container logs
        const logsMatch = url.match(/^\/ws\/container-logs\/([^/?]+)\/([^/?]+)/);
        if (logsMatch) {
          const [, runtime, containerId] = logsMatch;
          const runtimes = getContainerRuntimes();
          const validRuntimes = ['docker', 'podman', 'lxc'];
          if (!validRuntimes.includes(runtime) || !(runtimes as any)[runtime]?.accessible) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
          }
          const idRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/;
          if (!idRegex.test(containerId) || containerId.length > 256) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
          }

          wss.handleUpgrade(req, socket, head, (ws) => {
            console.log(`[ws:container-logs] Streaming logs for ${runtime}/${containerId}`);
            const pingInterval = setInterval(() => {
              if (ws.readyState === 1) ws.ping();
            }, 30000);
            let cmd: string;
            let args: string[];
            if (runtime === 'lxc') {
              cmd = 'lxc';
              args = ['exec', containerId, '--', 'journalctl', '-f'];
            } else {
              cmd = runtime;
              args = ['logs', '-f', '--tail', '200', containerId];
            }

            const logPty = pty.spawn(cmd, args, {
              name: 'xterm-256color',
              cols: 200,
              rows: 50,
            });

            const handler = logPty.onData((data: string) => {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'output', data }));
              }
            });

            logPty.onExit(() => {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'exit' }));
                ws.close();
              }
            });

            ws.on('close', () => {
              console.log(`[ws:container-logs] Disconnected for ${runtime}/${containerId}`);
              clearInterval(pingInterval);
              handler.dispose();
              logPty.kill();
            });
          });
          return;
        }

        // /ws/container-shell/:runtime/:containerId — interactive shell
        const shellContainerMatch = url.match(/^\/ws\/container-shell\/([^/?]+)\/([^/?]+)/);
        if (shellContainerMatch) {
          const [, runtime, containerId] = shellContainerMatch;
          const runtimes = getContainerRuntimes();
          const validRuntimes = ['docker', 'podman', 'lxc'];
          if (!validRuntimes.includes(runtime) || !(runtimes as any)[runtime]?.accessible) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
          }
          const idRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/;
          if (!idRegex.test(containerId) || containerId.length > 256) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
          }

          wss.handleUpgrade(req, socket, head, (ws) => {
            console.log(`[ws:container-shell] Shell into ${runtime}/${containerId}`);
            const pingInterval = setInterval(() => {
              if (ws.readyState === 1) ws.ping();
            }, 30000);
            let cmd: string;
            let args: string[];
            if (runtime === 'lxc') {
              cmd = 'lxc';
              args = ['exec', containerId, '--', '/bin/sh'];
            } else {
              cmd = runtime;
              args = ['exec', '-it', containerId, '/bin/sh'];
            }

            const shellPty = pty.spawn(cmd, args, {
              name: 'xterm-256color',
              cols: 80,
              rows: 24,
            });

            const handler = shellPty.onData((data: string) => {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'output', data }));
              }
            });

            shellPty.onExit(() => {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'exit' }));
                ws.close();
              }
            });

            ws.on('message', (raw) => {
              try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'input' && typeof msg.data === 'string') {
                  shellPty.write(msg.data);
                } else if (msg.type === 'resize' && msg.cols && msg.rows) {
                  shellPty.resize(msg.cols, msg.rows);
                }
              } catch {}
            });

            ws.on('close', () => {
              console.log(`[ws:container-shell] Disconnected for ${runtime}/${containerId}`);
              clearInterval(pingInterval);
              handler.dispose();
              shellPty.kill();
            });
          });
          return;
        }

        if (!logsMatch && !shellContainerMatch && !shellMatch) {
          socket.destroy();
        }
      }
    }
  });

  return server;
}
