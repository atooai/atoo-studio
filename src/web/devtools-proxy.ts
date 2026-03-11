import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Duplex } from 'stream';
import { previewManager } from '../services/preview-manager.js';

/** Make an HTTP GET request — via TCP port or unix socket */
function httpGet(instance: { cdpPort?: number; cdpSocketPath?: string }, urlPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts = instance.cdpPort
      ? { host: 'localhost', port: instance.cdpPort, path: urlPath }
      : { socketPath: instance.cdpSocketPath!, path: urlPath };
    const req = http.get(opts, (resp) => {
      const chunks: Buffer[] = [];
      resp.on('data', (c: Buffer) => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** Build WS URL to Chrome CDP — via TCP or unix socket */
function buildCdpWsUrl(instance: { cdpPort?: number; cdpSocketPath?: string }, cdpPath: string): string {
  if (instance.cdpPort) {
    return `ws://localhost:${instance.cdpPort}/${cdpPath}`;
  }
  // ws+unix:// for connecting via unix socket
  return `ws+unix://${instance.cdpSocketPath}:/${cdpPath}`;
}

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
    if (!instance.cdpPort && !instance.cdpSocketPath) {
      return res.status(400).json({ error: 'DevTools not available for this instance' });
    }

    try {
      const targetsJson = await httpGet(instance, '/json');
      const targets = JSON.parse(targetsJson);
      const pageTarget = targets.find((t: any) => t.type === 'page');
      if (!pageTarget) {
        return res.status(404).json({ error: 'No page target found' });
      }

      const versionJson = await httpGet(instance, '/json/version');
      const version = JSON.parse(versionJson);

      const host = req.get('host')!;
      const wsPath = `ws/devtools/${encodeURIComponent(projectId)}/${encodeURIComponent(tabId)}/devtools/page/${pageTarget.id}`;
      const devtoolsFrontend = `/apps/${encodeURIComponent(projectId)}/${encodeURIComponent(tabId)}/devtools/inspector.html?${req.protocol === 'https' ? 'wss' : 'ws'}=${host}/${wsPath}`;

      console.log(`[devtools-proxy] Target: ${pageTarget.id} (${pageTarget.url})`);
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
    if (!instance.cdpPort && !instance.cdpSocketPath) {
      return res.status(400).json({ error: 'DevTools not available for this instance' });
    }

    const devtoolsPath = (req.params as any)[0] || '';
    const queryString = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
    const targetPath = `/devtools/${devtoolsPath}${queryString}`;

    try {
      const opts = instance.cdpPort
        ? { host: 'localhost', port: instance.cdpPort, path: targetPath }
        : { socketPath: instance.cdpSocketPath!, path: targetPath };

      const proxyReq = http.get(opts, (proxyRes) => {
        res.status(proxyRes.statusCode || 200);
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
  if (!instance || (!instance.cdpPort && !instance.cdpSocketPath)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const targetWsUrl = buildCdpWsUrl(instance, cdpPath);
  console.log(`[devtools-proxy] WS upgrade: ${cdpPath} → ${targetWsUrl}`);

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const targetWs = new WebSocket(targetWsUrl);

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
