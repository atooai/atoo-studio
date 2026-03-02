import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { store } from '../state/store.js';
import { v4 as uuidv4 } from 'uuid';
import { spawnCliProcess, spawnForkedCliProcess, spawnResumeCliProcess, buildContextSummary, getProcessPid, getPreloadSessionId, getPty, getEnvIdForSession } from '../spawner.js';
import { fsMonitor } from '../fs-monitor.js';
import { changesRouter } from '../handlers/changes.js';
import { fsSessionScanner } from '../fs-sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createWebServer(): http.Server {
  const app = express();
  app.use(express.json());

  // API routes for the React frontend

  // List environments
  app.get('/api/environments', (_req, res) => {
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
    const { message, skip_permissions, cwd } = req.body;

    try {
      // Track existing sessions so we can detect the new one from the CLI
      const existingSessionIds = new Set(store.sessions.keys());

      // Spawn a new headless claude /remote-control process
      console.log(`[web] Spawning headless CLI (skip_permissions=${!!skip_permissions}, cwd=${cwd || '~'})...`);
      const envId = await spawnCliProcess({ skipPermissions: !!skip_permissions, cwd: cwd || undefined });
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

    const event = {
      uuid: uuidv4(),
      session_id: session.id,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: req.body.message },
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

  // Filesystem sessions — scan ~/.claude/projects for JSONL session files
  app.get('/api/fs-sessions', async (_req, res) => {
    try {
      const sessions = await fsSessionScanner.scan();
      res.json(sessions);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resume a filesystem session — spawn CLI with --resume, wait for it to connect
  app.post('/api/fs-sessions/:uuid/resume', async (req, res) => {
    const { uuid } = req.params;
    const { skip_permissions } = req.body || {};

    // Check if already running as an active session
    for (const s of store.sessions.values()) {
      if (s.fsUuid === uuid) {
        return res.json({ id: s.id, fs_uuid: uuid });
      }
    }

    try {
      let sessionMeta = fsSessionScanner.getByUuid(uuid);
      if (!sessionMeta) {
        await fsSessionScanner.scan();
        sessionMeta = fsSessionScanner.getByUuid(uuid);
        if (!sessionMeta) {
          return res.status(404).json({ error: 'Session not found in filesystem' });
        }
      }

      // Track existing sessions to detect the CLI's new one
      const existingSessionIds = new Set(store.sessions.keys());

      // Spawn CLI with --resume
      console.log(`[web] Resuming fs session ${uuid} from ${sessionMeta.directory}...`);
      const envId = await spawnResumeCliProcess({
        uuid,
        directory: sessionMeta.directory,
        skipPermissions: !!skip_permissions,
      });
      console.log(`[web] Resume CLI registered as ${envId}`);

      // Wait for CLI to create its own session
      const cliSessionId = await new Promise<string>((resolve, reject) => {
        let elapsed = 0;
        const timer = setInterval(() => {
          elapsed += 500;
          for (const id of Array.from(store.sessions.keys())) {
            if (!existingSessionIds.has(id)) {
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
            reject(new Error('Timeout waiting for resume CLI to create session'));
          }
        }, 500);
      });

      console.log(`[web] Resume CLI created session ${cliSessionId}`);

      // Tag session with fs UUID and title
      const cliSession = store.sessions.get(cliSessionId)!;
      cliSession.title = sessionMeta.title;
      cliSession.fsUuid = uuid;

      // Set up lightweight filesystem monitoring via LD_PRELOAD session mapping
      const preloadSid = getPreloadSessionId(envId);
      if (preloadSid) {
        fsMonitor.registerSessionMapping(preloadSid, cliSessionId);
      }

      res.json({ id: cliSessionId, fs_uuid: uuid });
    } catch (err: any) {
      console.error(`[web] Failed to resume fs session:`, err.message);
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

  // Mount changes API routes
  app.use(changesRouter);

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

  // Serve frontend static files (production)
  const frontendDist = path.join(__dirname, '..', '..', '..', 'frontend', 'dist');
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
                <li>GET <a href="/api/environments">/api/environments</a></li>
                <li>GET <a href="/api/sessions">/api/sessions</a></li>
              </ul>
            </body>
          </html>
        `);
      }
    });
  });

  const server = http.createServer(app);

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

  // WebSocket for frontend live updates
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';

    // /ws/sessions/:id — live event stream for frontend
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
        ws.on('close', () => store.statusClients.delete(ws));
      });
    } else {
      // /ws/terminal/:sessionId — pty I/O for browser terminal
      const termMatch = url.match(/^\/ws\/terminal\/([^/?]+)/);
      if (termMatch) {
        const sessionId = termMatch[1];
        const envId = getEnvIdForSession(sessionId);
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

          // Send pty output to browser
          const dataHandler = ptyProcess.onData((data: string) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'output', data }));
            }
          });

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
            dataHandler.dispose();
          });
        });
      } else {
        socket.destroy();
      }
    }
  });

  return server;
}
