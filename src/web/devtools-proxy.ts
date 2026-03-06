import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Duplex } from 'stream';
import { previewManager } from '../services/preview-manager.js';

// HTTP proxy middleware for Chrome DevTools frontend
export function devtoolsProxyMiddleware(): express.Router {
  const router = express.Router();

  // Get DevTools URL for a preview instance (returns the correct page target URL)
  router.get('/apps/:projectId/:tabId/devtools-url', async (req, res) => {
    const { projectId, tabId } = req.params;
    const instance = previewManager.get(projectId, tabId);
    if (!instance) {
      return res.status(404).json({ error: 'Preview instance not found' });
    }

    try {
      // Fetch the target list from Chrome to find the page target ID
      const targetsJson = await new Promise<string>((resolve, reject) => {
        http.get(`http://localhost:${instance.cdpPort}/json`, (resp) => {
          const chunks: Buffer[] = [];
          resp.on('data', (c: Buffer) => chunks.push(c));
          resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        }).on('error', reject);
      });

      const targets = JSON.parse(targetsJson);
      const pageTarget = targets.find((t: any) => t.type === 'page');
      if (!pageTarget) {
        return res.status(404).json({ error: 'No page target found' });
      }

      // Also fetch the browser version info which has the browser WS endpoint
      const versionJson = await new Promise<string>((resolve, reject) => {
        http.get(`http://localhost:${instance.cdpPort}/json/version`, (resp) => {
          const chunks: Buffer[] = [];
          resp.on('data', (c: Buffer) => chunks.push(c));
          resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        }).on('error', reject);
      });
      const version = JSON.parse(versionJson);

      // Build the devtools frontend URL
      // DevTools ws= param format: host:port/path (no protocol)
      const host = req.get('host')!;
      const wsPath = `ws/devtools/${encodeURIComponent(projectId)}/${encodeURIComponent(tabId)}/devtools/page/${pageTarget.id}`;
      const devtoolsFrontend = `/apps/${encodeURIComponent(projectId)}/${encodeURIComponent(tabId)}/devtools/inspector.html?${req.protocol === 'https' ? 'wss' : 'ws'}=${host}/${wsPath}`;

      console.log(`[devtools-proxy] Target: ${pageTarget.id} (${pageTarget.url})`);
      console.log(`[devtools-proxy] Chrome WS: ${pageTarget.webSocketDebuggerUrl}`);
      console.log(`[devtools-proxy] Frontend URL: ${devtoolsFrontend}`);

      res.json({
        url: devtoolsFrontend,
        targetId: pageTarget.id,
        targetUrl: pageTarget.url,
        wsProxy: wsPath,
        browserWs: version.webSocketDebuggerUrl,
      });
    } catch (err: any) {
      res.status(502).json({ error: `Failed to get targets: ${err.message}` });
    }
  });

  // Proxy DevTools frontend files: /apps/:projectId/:tabId/devtools/*
  router.get('/apps/:projectId/:tabId/devtools/*', async (req, res) => {
    const { projectId, tabId } = req.params;
    const instance = previewManager.get(projectId, tabId);
    if (!instance) {
      return res.status(404).json({ error: 'Preview instance not found' });
    }

    const devtoolsPath = (req.params as any)[0] || '';
    const queryString = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
    const targetUrl = `http://localhost:${instance.cdpPort}/devtools/${devtoolsPath}${queryString}`;

    try {
      const proxyReq = http.get(targetUrl, (proxyRes) => {
        res.status(proxyRes.statusCode || 200);
        // Forward headers
        for (const [key, val] of Object.entries(proxyRes.headers)) {
          if (key !== 'transfer-encoding' && val) {
            res.set(key, val as string);
          }
        }
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        res.status(502).json({ error: `DevTools proxy error: ${err.message}` });
      });
    } catch (err: any) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

// WebSocket proxy for DevTools
export function isDevtoolsWsUpgrade(url: string): boolean {
  return url.startsWith('/ws/devtools/');
}

export function handleDevtoolsWsUpgrade(
  wss: WebSocketServer,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
) {
  const url = req.url || '';
  const match = url.match(/^\/ws\/devtools\/([^/?]+)\/([^/?]+)\/(.*)/);
  if (!match) {
    socket.destroy();
    return;
  }

  const projectId = decodeURIComponent(match[1]);
  const tabId = decodeURIComponent(match[2]);
  const cdpPath = match[3];

  const instance = previewManager.get(projectId, tabId);
  if (!instance) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const targetWsUrl = `ws://localhost:${instance.cdpPort}/${cdpPath}`;
  console.log(`[devtools-proxy] WS upgrade: ${cdpPath} → ${targetWsUrl}`);

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const targetWs = new WebSocket(targetWsUrl);

    // Buffer messages from client until target is connected
    const bufferedMessages: (Buffer | string)[] = [];
    let targetReady = false;

    clientWs.on('message', (data, isBinary) => {
      if (targetReady) {
        if (targetWs.readyState === 1) {
          targetWs.send(data, { binary: isBinary });
        }
      } else {
        bufferedMessages.push(isBinary ? Buffer.from(data as Buffer) : data.toString());
      }
    });

    targetWs.on('open', () => {
      console.log(`[devtools-proxy] WS connected to Chrome CDP (${cdpPath})`);
      targetReady = true;

      // Flush buffered messages
      for (const msg of bufferedMessages) {
        if (targetWs.readyState === 1) {
          targetWs.send(msg);
        }
      }
      bufferedMessages.length = 0;

      targetWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === 1) {
          clientWs.send(data, { binary: isBinary });
        }
      });
    });

    targetWs.on('error', (err) => {
      console.error(`[devtools-proxy] Target WS error:`, err.message);
      clientWs.close(1011, 'Target connection error');
    });

    targetWs.on('close', (code, reason) => {
      console.log(`[devtools-proxy] Target WS closed: ${code} ${reason}`);
      if (clientWs.readyState <= 1) clientWs.close(code || 1000, reason?.toString() || '');
    });

    clientWs.on('close', (code, reason) => {
      console.log(`[devtools-proxy] Client WS closed: ${code}`);
      if (targetWs.readyState <= 1) targetWs.close();
    });

    clientWs.on('error', (err) => {
      console.error(`[devtools-proxy] Client WS error:`, err.message);
      if (targetWs.readyState <= 1) targetWs.close();
    });
  });
}
