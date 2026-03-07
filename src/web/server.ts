import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import https from 'https';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { store } from '../state/store.js';
import { v4 as uuidv4 } from 'uuid';
import * as pty from 'node-pty';
import { getProcessPid, getPreloadSessionId, getPty, getEnvIdForSession, getScrollback, killCliProcess } from '../spawner.js';
import { spawnCliProcess, spawnForkedCliProcess, spawnRemoteCliProcess } from '../agents/claude-code/spawner.js';
import { vccDb } from '../state/db.js';
import { fsMonitor } from '../fs-monitor.js';
import { changesRouter } from '../handlers/changes.js';
import { projectsRouter } from '../handlers/projects.js';
import { environmentsRouter, setBroadcastSettingsChange } from '../handlers/environments.js';
import { sshRouter } from '../handlers/ssh.js';
import { isAgentWsUpgrade, handleAgentWsUpgrade } from '../ws/agent-ws.js';
import { agentRegistry } from '../agents/registry.js';
import { createPortProxy, portProxyMiddleware, isPortProxyUpgrade, handlePortProxyUpgrade } from './port-proxy.js';
import { isPreviewWsUpgrade, handlePreviewWsUpgrade } from './preview-ws.js';
import { devtoolsProxyMiddleware, isDevtoolsWsUpgrade, handleDevtoolsWsUpgrade } from './devtools-proxy.js';
import { sendContextAndRewind } from '../agents/claude-code/pty-actions.js';
import forge from 'node-forge';
import { CA_CERT_PATH, CA_KEY_PATH, PROJECT_ROOT } from '../config.js';
import { serialManager } from '../serial/manager.js';

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createWebServer(tlsOptions?: { key: string; cert: string }): https.Server | http.Server {
  const app = express();

  // Port-proxy: intercept before body parsing so proxied requests stream through
  const portProxy = createPortProxy();
  app.use(portProxyMiddleware(portProxy));

  app.use(express.json({ limit: '50mb' }));

  // API routes for the React frontend

  // List CLI environments (runtime)
  app.get('/api/cli-environments', (_req, res) => {
    const envs = Array.from(store.environments.values()).map((e) => ({
      id: e.id,
      machine_name: e.machineName,
      directory: e.directory,
      branch: e.branch,
      registered_at: e.registeredAt.toISOString(),
    }));
    res.json(envs);
  });

  // List sessions
  app.get('/api/sessions', (_req, res) => {
    const sessions = Array.from(store.sessions.values()).map((s) => {
      const env = store.environments.get(s.environmentId);
      const initEvent = s.events.find((e: any) => e.type === 'system' && e.subtype === 'init');
      const ctxUsage = store.contextUsages.get(s.id);
      return {
        id: s.id,
        title: s.title,
        status: s.status,
        environment_id: s.environmentId,
        directory: env?.directory || null,
        agent_status: store.getAgentStatus(s.id),
        created_at: s.createdAt.toISOString(),
        event_count: s.events.length,
        parent_session_id: s.parentSessionId || null,
        fork_after_event_uuid: s.forkAfterEventUuid || null,
        change_count: fsMonitor.getChangeCount(s.id),
        fs_uuid: s.fsUuid || null,
        model: initEvent?.model || ctxUsage?.model || null,
        permission_mode: initEvent?.permissionMode || s.permissionMode || null,
      };
    });
    res.json(sessions);
  });

  // Get session details
  app.get('/api/sessions/:id', (req, res) => {
    const session = store.sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    res.json({
      id: session.id,
      title: session.title,
      status: session.status,
      environment_id: session.environmentId,
      created_at: session.createdAt.toISOString(),
      events: session.events,
      parent_session_id: session.parentSessionId || null,
      fork_after_event_uuid: session.forkAfterEventUuid || null,
    });
  });

  // Create session from frontend — spawns a headless CLI process
  // The CLI itself creates the session via /remote-control, so we just
  // spawn it, wait for the CLI's session to appear, and send the message there.
  app.post('/api/sessions', async (req, res) => {
    const { message, skip_permissions, cwd, ssh_connection_id } = req.body;

    try {
      // Track existing sessions so we can detect the new one from the CLI
      const existingSessionIds = new Set(store.sessions.keys());

      // Determine if this is a remote project by checking ssh_connection_id or looking up the project
      let sshConnId = ssh_connection_id;
      if (!sshConnId && cwd) {
        // Check if any project with this path has an SSH connection
        const allProjects = vccDb.listAllProjects();
        const matchingProject = allProjects.find(p => p.ssh_connection_id && (p.path === cwd || p.remote_path === cwd));
        if (matchingProject) sshConnId = matchingProject.ssh_connection_id;
      }

      let envId: string;
      if (sshConnId) {
        // Remote spawn via SSH
        console.log(`[web] Spawning remote CLI via SSH ${sshConnId} (cwd=${cwd || '~'})...`);
        envId = await spawnRemoteCliProcess({
          sshConnectionId: sshConnId,
          skipPermissions: !!skip_permissions,
          cwd: cwd || '/home',
        });
      } else {
        // Local spawn
        console.log(`[web] Spawning headless CLI (skip_permissions=${!!skip_permissions}, cwd=${cwd || '~'})...`);
        envId = await spawnCliProcess({ skipPermissions: !!skip_permissions, cwd: cwd || undefined });
      }
      console.log(`[web] CLI registered as ${envId}`);

      // Wait for the CLI to create its own session (polls every 500ms, up to 15s)
      const sessionId = await new Promise<string>((resolve, reject) => {
        let elapsed = 0;
        const timer = setInterval(() => {
          elapsed += 500;
          for (const id of Array.from(store.sessions.keys())) {
            if (!existingSessionIds.has(id)) {
              const session = store.sessions.get(id);
              if (session && session.environmentId === envId) {
                clearInterval(timer);
                resolve(id);
                return;
              }
            }
          }
          if (elapsed >= 15000) {
            clearInterval(timer);
            reject(new Error('Timeout waiting for CLI to create session'));
          }
        }, 500);
      });

      console.log(`[web] CLI created session ${sessionId}`);

      // Set initial permission mode based on how the session was spawned
      const newSession = store.sessions.get(sessionId);
      if (newSession) {
        newSession.permissionMode = skip_permissions ? 'bypassPermissions' : 'default';
      }

      // Start filesystem monitoring for this session
      const cliPid = getProcessPid(envId);
      const preloadSid = getPreloadSessionId(envId);
      console.log(`[web] CLI PID for env ${envId}: ${cliPid ?? 'NOT FOUND'}`);
      if (cliPid) {
        const cliCwd = cwd || os.homedir();
        fsMonitor.watchPid(sessionId, cliPid, cliCwd);
        if (preloadSid) {
          fsMonitor.registerSessionMapping(preloadSid, sessionId);
        }
      } else {
        console.warn(`[web] No PID found for env ${envId}, filesystem monitoring disabled`);
      }

      // Wait for the CLI's ingress WebSocket to connect before sending the message
      if (message) {
        await new Promise<void>((resolve, reject) => {
          let elapsed = 0;
          const check = setInterval(() => {
            elapsed += 200;
            const ws = store.ingressClients.get(sessionId);
            if (ws && ws.readyState === 1) {
              clearInterval(check);
              resolve();
              return;
            }
            if (elapsed >= 15000) {
              clearInterval(check);
              reject(new Error('Timeout waiting for CLI ingress WebSocket'));
            }
          }, 200);
        });

        console.log(`[web] Ingress WS ready, sending initial message to ${sessionId}`);
        const event = {
          uuid: uuidv4(),
          session_id: sessionId,
          type: 'user',
          parent_tool_use_id: null,
          message: { role: 'user', content: message },
        };
        store.addEvent(sessionId, event);
        store.forwardToIngress(sessionId, event);
        store.broadcastToSubscribers(sessionId, event);
        store.setAgentStatus(sessionId, 'active');
      }

      const session = store.sessions.get(sessionId)!;
      res.json({
        id: session.id,
        title: session.title || message?.substring(0, 50) || 'New Session',
        status: session.status,
        permission_mode: session.permissionMode || null,
      });
    } catch (err: any) {
      console.error(`[web] Failed to create session:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Send message to existing session
  app.post('/api/sessions/:id/message', (req, res) => {
    const session = store.sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });

    // Build content: plain string for text-only, content blocks array for attachments
    let content: any = req.body.message;
    if (req.body.attachments?.length) {
      content = [
        ...req.body.attachments.map((a: any) => ({
          type: 'image',
          source: { type: 'base64', media_type: a.media_type, data: a.data },
        })),
        { type: 'text', text: req.body.message },
      ];
    }

    const event = {
      uuid: req.body.uuid || uuidv4(),
      session_id: session.id,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content },
    };

    store.addEvent(session.id, event);
    store.forwardToIngress(session.id, event);
    store.broadcastToSubscribers(session.id, event);
    store.setAgentStatus(session.id, 'active');

    res.json({ success: true });
  });

  // Send control response (tool approval)
  app.post('/api/sessions/:id/control-response', (req, res) => {
    const session = store.sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });

    const controlResponse = {
      type: 'control_response',
      response: req.body,
      session_id: session.id,
    };

    store.forwardToIngress(session.id, controlResponse);
    res.json({ success: true });
  });

  // Change permission mode via PTY Shift+Tab cycling
  // The REPL bridge doesn't support set_permission_mode control requests.
  const MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

  app.post('/api/sessions/:id/set-mode', (req, res) => {
    const session = store.sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });

    const targetMode = req.body.mode;
    if (!targetMode || !MODE_CYCLE.includes(targetMode)) {
      return res.status(400).json({ error: `Invalid mode` });
    }

    const envId = getEnvIdForSession(session.id);
    if (!envId) return res.status(400).json({ error: 'No environment for session' });
    const ptyInst = getPty(envId);
    if (!ptyInst) return res.status(400).json({ error: 'No PTY for session' });

    // Use server-tracked mode (authoritative), not frontend's guess
    const currentMode = session.permissionMode || 'default';
    const currentIdx = MODE_CYCLE.indexOf(currentMode);
    const targetIdx = MODE_CYCLE.indexOf(targetMode);
    let presses = (targetIdx - currentIdx + MODE_CYCLE.length) % MODE_CYCLE.length;
    if (presses === 0) return res.json({ success: true, mode: targetMode });

    // Update stored mode
    session.permissionMode = targetMode;

    console.log(`[web] Cycling permission mode: ${currentMode} → ${targetMode} (${presses} Shift+Tab presses)`);

    let sent = 0;
    const sendNext = () => {
      if (sent >= presses) return;
      ptyInst.write('\x1b[Z');
      sent++;
      if (sent < presses) setTimeout(sendNext, 200);
    };
    sendNext();

    res.json({ success: true, mode: targetMode });
  });

  // Send a key to the CLI PTY (accepts both sess_xxx and agent_xxx IDs)
  const ALLOWED_KEYS: Record<string, string> = { escape: '\x1b' };

  app.post('/api/sessions/:id/send-key', (req, res) => {
    const key = req.body.key;
    const sequence = key && ALLOWED_KEYS[key];
    if (!sequence) return res.status(400).json({ error: 'Invalid key' });

    // Try direct session lookup first
    let envId = getEnvIdForSession(req.params.id);

    // Fall back to agent registry (agent_xxx → underlying envId)
    if (!envId) {
      const agent = agentRegistry.getAgent(req.params.id);
      if (agent) {
        envId = (agent as any).envId;
      }
    }

    if (!envId) return res.status(404).json({ error: 'No environment for session' });
    const ptyInst = getPty(envId);
    if (!ptyInst) return res.status(400).json({ error: 'No PTY for session' });

    ptyInst.write(sequence);
    res.json({ success: true });
  });

  // Stop a session — kills the CLI process
  app.delete('/api/sessions/:id', (req, res) => {
    const sessionId = req.params.id;
    let envId = getEnvIdForSession(sessionId);
    if (!envId) {
      const agent = agentRegistry.getAgent(sessionId);
      if (agent) envId = (agent as any).envId;
    }
    if (envId) {
      killCliProcess(envId);
    }
    store.sessions.delete(sessionId);
    res.json({ success: true });
  });

  // Trigger /context + /rewind for token usage update
  app.post('/api/sessions/:id/refresh-context', (req, res) => {
    const session = store.sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });

    const envId = getEnvIdForSession(session.id);
    if (!envId) return res.status(400).json({ error: 'No environment for session' });
    const ptyInst = getPty(envId);
    if (!ptyInst) return res.status(400).json({ error: 'No PTY for session' });

    sendContextAndRewind(ptyInst, session.id, 500, (inProgress) => {
      store.setContextInProgress(session.id, inProgress);
    }).catch(err => {
      console.error(`[server] /context sequence error:`, err);
      store.setContextInProgress(session.id, false);
    });

    res.json({ success: true });
  });

  // Fork a session at a given event
  app.post('/api/sessions/:id/fork', async (req, res) => {
    const { afterEventUuid, message } = req.body;
    if (!afterEventUuid) {
      return res.status(400).json({ error: 'afterEventUuid is required' });
    }

    const parentSession = store.sessions.get(req.params.id);
    if (!parentSession) return res.status(404).json({ error: 'Session not found' });

    try {
      // 1. Create forked session in store (copies events, generates linked ID)
      const forkedSession = store.forkSession(req.params.id, afterEventUuid);

      // Determine directory from parent's environment
      const parentEnv = store.environments.get(parentSession.environmentId);
      const directory = parentEnv?.directory || process.env.HOME || os.homedir();

      // 2. Track existing sessions/envs so we can detect the new CLI's session
      const existingSessionIds = new Set(store.sessions.keys());

      // 3. Spawn CLI process (fork mode)
      console.log(`[web] Spawning forked CLI for ${forkedSession.id}...`);
      const envId = await spawnForkedCliProcess({
        session: forkedSession,
        directory,
        skipPermissions: parentSession.permissionMode === 'dangerously-skip-permissions',
      });
      console.log(`[web] Forked CLI registered as ${envId}`);

      // 4. Wait for CLI to create its own session
      const cliSessionId = await new Promise<string>((resolve, reject) => {
        let elapsed = 0;
        const timer = setInterval(() => {
          elapsed += 500;
          for (const id of Array.from(store.sessions.keys())) {
            if (!existingSessionIds.has(id) && id !== forkedSession.id) {
              const sess = store.sessions.get(id);
              if (sess && sess.environmentId === envId) {
                clearInterval(timer);
                resolve(id);
                return;
              }
            }
          }
          if (elapsed >= 15000) {
            clearInterval(timer);
            reject(new Error('Timeout waiting for forked CLI to create session'));
          }
        }, 500);
      });

      console.log(`[web] Forked CLI created session ${cliSessionId}`);

      // Start filesystem monitoring for forked session
      const forkedPid = getProcessPid(envId);
      const forkedPreloadSid = getPreloadSessionId(envId);
      if (forkedPid) {
        fsMonitor.watchPid(cliSessionId, forkedPid, directory);
        if (forkedPreloadSid) {
          fsMonitor.registerSessionMapping(forkedPreloadSid, cliSessionId);
        }
      }

      // 5. Link: update our forked session's environmentId
      forkedSession.environmentId = envId;

      // 6. Wait for ingress WS and optionally send initial message
      if (message) {
        await new Promise<void>((resolve, reject) => {
          let elapsed = 0;
          const check = setInterval(() => {
            elapsed += 200;
            const ws = store.ingressClients.get(cliSessionId);
            if (ws && ws.readyState === 1) {
              clearInterval(check);
              resolve();
              return;
            }
            if (elapsed >= 15000) {
              clearInterval(check);
              reject(new Error('Timeout waiting for forked CLI ingress WebSocket'));
            }
          }, 200);
        });

        console.log(`[web] Forked ingress WS ready, sending message to ${cliSessionId}`);
        const event = {
          uuid: uuidv4(),
          session_id: cliSessionId,
          type: 'user',
          parent_tool_use_id: null,
          message: { role: 'user', content: message },
        };
        store.addEvent(cliSessionId, event);
        store.forwardToIngress(cliSessionId, event);
        store.broadcastToSubscribers(cliSessionId, event);
        store.setAgentStatus(cliSessionId, 'active');
      }

      res.json({
        id: forkedSession.id,
        title: forkedSession.title,
        status: forkedSession.status,
        parent_session_id: forkedSession.parentSessionId,
        fork_after_event_uuid: forkedSession.forkAfterEventUuid,
        cli_session_id: cliSessionId,
      });
    } catch (err: any) {
      console.error(`[web] Failed to fork session:`, err.message);
      res.status(500).json({ error: err.message });
    }
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
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(buf, { type: 'buffer' });
        const sheets: string[] = [];
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const csv = XLSX.utils.sheet_to_csv(sheet);
          sheets.push(`--- Sheet: ${sheetName} ---\n${csv}`);
        }
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

  // Mount changes API routes
  app.use(changesRouter);

  // Mount project/file/git API routes
  app.use(projectsRouter);

  // Mount environment API routes
  app.use(environmentsRouter);

  // Mount SSH API routes
  app.use(sshRouter);

  // Mount DevTools proxy
  app.use(devtoolsProxyMiddleware());

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

  // Proxy status
  app.get('/api/status', (_req, res) => {
    res.json({
      environments: store.environments.size,
      sessions: store.sessions.size,
      active_ingress: store.ingressClients.size,
      active_subscribers: Array.from(store.subscribeClients.values()).reduce(
        (sum, set) => sum + set.size,
        0
      ),
    });
  });

  // ═══════════════════════════════════════════════════════
  // Agent Session Endpoints (abstract layer)
  // ═══════════════════════════════════════════════════════

  // Create a new agent session
  app.post('/api/agent-sessions', async (req, res) => {
    const { agentType, cwd, skipPermissions, message,
            resumeSessionUuid, forkParentSessionId, forkAfterEventUuid } = req.body;

    const type = agentType || 'claude-code';
    const sessionId = `agent_${uuidv4()}`;

    try {
      const agent = await agentRegistry.createAgent(type, sessionId, {
        cwd: cwd || undefined,
        skipPermissions: !!skipPermissions,
        resumeSessionUuid,
        forkParentSessionId,
        forkAfterEventUuid,
      });

      // Send initial message if provided
      if (message) {
        agent.sendMessage(message);
      }

      const info = agent.getInfo();
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

  // Available agent types (for agent picker UI)
  app.get('/api/available-agents', (_req, res) => {
    res.json(agentRegistry.getAvailableAgents());
  });

  // Historical sessions from all agent implementations
  app.get('/api/historical-sessions', async (_req, res) => {
    try {
      const sessions = await agentRegistry.getHistoricalSessions();
      res.json(sessions);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resume a historical session — resolves agent type automatically
  app.post('/api/agent-sessions/resume', async (req, res) => {
    const { sessionUuid, cwd, skipPermissions } = req.body;
    if (!sessionUuid) {
      return res.status(400).json({ error: 'sessionUuid is required' });
    }

    try {
      const agent = await agentRegistry.resumeAgent(sessionUuid, {
        cwd: cwd || undefined,
        skipPermissions: !!skipPermissions,
      });
      res.json(agent.getInfo());
    } catch (err: any) {
      console.error(`[web] Failed to resume session:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Serve frontend static files (production)
  const projectRoot = PROJECT_ROOT;
  const frontendDist = path.join(projectRoot, 'frontend', 'dist');
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
      if (err) {
        res.status(200).send(`
          <html>
            <body style="font-family:monospace;padding:2em;background:#1a1a2e;color:#e0e0e0">
              <h1>CCProxy</h1>
              <p>Frontend not built yet. Run <code>cd frontend && npm run build</code></p>
              <p>Or use the API directly:</p>
              <ul>
                <li>GET <a href="/api/status">/api/status</a></li>
                <li>GET <a href="/api/cli-environments">/api/cli-environments</a></li>
                <li>GET <a href="/api/sessions">/api/sessions</a></li>
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
    store.broadcastToSubscribers(change.sessionId, event);
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

    // /ws/sessions/:id — live event stream for frontend (legacy)
    const match = url.match(/^\/ws\/sessions\/([^/?]+)/);
    if (match) {
      const sessionId = match[1];
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Register as a subscriber
        if (!store.subscribeClients.has(sessionId)) {
          store.subscribeClients.set(sessionId, new Set());
        }
        store.subscribeClients.get(sessionId)!.add(ws);

        // Replay existing events
        const session = store.sessions.get(sessionId);
        if (session) {
          for (const event of session.events) {
            ws.send(JSON.stringify(event));
          }
        }

        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'control_response' || msg.type === 'control_request') {
              store.forwardToIngress(sessionId, msg);
            }
          } catch {}
        });

        ws.on('close', () => {
          store.subscribeClients.get(sessionId)?.delete(ws);
        });
      });
    } else if (url.startsWith('/ws/status')) {
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

          // Register single shared onData handler if first client
          if (!entry.handler) {
            entry.handler = ptyProcess.onData((data: string) => {
              // Append to scrollback buffer (ring-trim if too large)
              entry.scrollback += data;
              if (entry.scrollback.length > MAX_SCROLLBACK) {
                entry.scrollback = entry.scrollback.slice(-MAX_SCROLLBACK);
              }
              const msg = JSON.stringify({ type: 'output', data });
              for (const client of entry.clients) {
                if (client.readyState === 1) {
                  client.send(msg);
                }
              }
            });
          }

          // Receive input/resize from browser
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
            console.log(`[ws:terminal] Browser disconnected for session ${sessionId}`);
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
            if (!entry.handler) {
              entry.handler = ptyProcess.onData((data: string) => {
                entry.scrollback += data;
                if (entry.scrollback.length > MAX_SCROLLBACK) {
                  entry.scrollback = entry.scrollback.slice(-MAX_SCROLLBACK);
                }
                const msg = JSON.stringify({ type: 'output', data });
                for (const client of entry.clients) {
                  if (client.readyState === 1) {
                    client.send(msg);
                  }
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
              entry.clients.delete(ws);
              // Keep handler alive so scrollback continues accumulating even with no browsers
            });
          });
        } else {
          socket.destroy();
        }
      }
    }
  });

  return server;
}
