import http from 'http';
import httpProxy from 'http-proxy';
import type { Request, Response, NextFunction } from 'express';
import type { Duplex } from 'stream';
import { WEB_PORT } from '../config.js';
import { sshManager } from '../services/ssh-manager.js';

interface ProxyTarget {
  port: number;
  path: string;
  connectionId?: string;
}

const SUBDOMAIN_RE = /^(\d+)\.port\.on\./;
const PATH_PREFIX_RE = /^\/at\/port\/(\d+)(\/.*)?$/;
const REMOTE_PATH_PREFIX_RE = /^\/at\/remote\/([^/]+)\/port\/(\d+)(\/.*)?$/;
const REMOTE_SUBDOMAIN_RE = /^(\d+)\.remote\.([^.]+)\.on\./;

export function extractPortProxyTarget(req: http.IncomingMessage): ProxyTarget | null {
  const host = req.headers.host || '';
  const hostWithoutPort = host.replace(/:\d+$/, '');

  // Subdomain format: {portnr}.port.on.{domain}
  const subdomainMatch = hostWithoutPort.match(SUBDOMAIN_RE);
  if (subdomainMatch) {
    const port = parseInt(subdomainMatch[1], 10);
    if (port > 0 && port <= 65535 && port !== WEB_PORT) {
      return { port, path: req.url || '/' };
    }
  }

  // Path format: /at/port/{portnr}[/rest]
  const url = req.url || '/';
  const pathMatch = url.match(PATH_PREFIX_RE);
  if (pathMatch) {
    const port = parseInt(pathMatch[1], 10);
    if (port > 0 && port <= 65535 && port !== WEB_PORT) {
      return { port, path: pathMatch[2] || '/' };
    }
  }

  // Remote path format: /at/remote/{connId}/port/{portnr}[/rest]
  const remotePathMatch = url.match(REMOTE_PATH_PREFIX_RE);
  if (remotePathMatch) {
    const connectionId = remotePathMatch[1];
    const port = parseInt(remotePathMatch[2], 10);
    if (port > 0 && port <= 65535) {
      return { port, path: remotePathMatch[3] || '/', connectionId };
    }
  }

  // Remote subdomain format: {port}.remote.{connId}.on.{domain}
  const remoteSubMatch = hostWithoutPort.match(REMOTE_SUBDOMAIN_RE);
  if (remoteSubMatch) {
    const port = parseInt(remoteSubMatch[1], 10);
    const connectionId = remoteSubMatch[2];
    if (port > 0 && port <= 65535) {
      return { port, path: req.url || '/', connectionId };
    }
  }

  return null;
}

export function createPortProxy(): httpProxy {
  const proxy = httpProxy.createProxyServer({
    ws: true,
    xfwd: true,
    changeOrigin: true,
  });

  proxy.on('error', (err: Error, req: http.IncomingMessage, res: http.ServerResponse | Duplex) => {
    const target = extractPortProxyTarget(req);
    const port = target?.port || 'unknown';
    console.error(`[port-proxy] Error proxying to localhost:${port}:`, err.message);
    if (res && 'writeHead' in res && !(res as http.ServerResponse).headersSent) {
      (res as http.ServerResponse).writeHead(502, { 'Content-Type': 'text/plain' });
      (res as http.ServerResponse).end(`Port proxy error: could not connect to localhost:${port}`);
    }
  });

  return proxy;
}

export function portProxyMiddleware(proxy: httpProxy) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const target = extractPortProxyTarget(req);
    if (!target) {
      next();
      return;
    }
    req.url = target.path;

    if (target.connectionId) {
      // Remote proxy via SSH tunnel
      try {
        const localPort = await sshManager.getOrCreateForwardTunnel(target.connectionId, target.port);
        console.log(`[port-proxy] HTTP ${req.method} -> SSH:${target.connectionId}:${target.port} (via local:${localPort})${target.path}`);
        proxy.web(req, res, { target: `http://127.0.0.1:${localPort}` });
      } catch (err: any) {
        console.error(`[port-proxy] SSH tunnel error:`, err.message);
        res.status(502).send(`SSH tunnel error: ${err.message}`);
      }
    } else {
      console.log(`[port-proxy] HTTP ${req.method} -> localhost:${target.port}${target.path}`);
      proxy.web(req, res, { target: `http://127.0.0.1:${target.port}` });
    }
  };
}

export function isPortProxyUpgrade(req: http.IncomingMessage): boolean {
  return extractPortProxyTarget(req) !== null;
}

export async function handlePortProxyUpgrade(
  proxy: httpProxy,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const target = extractPortProxyTarget(req);
  if (!target) {
    socket.destroy();
    return;
  }
  req.url = target.path;

  let localPort = target.port;
  if (target.connectionId) {
    try {
      localPort = await sshManager.getOrCreateForwardTunnel(target.connectionId, target.port);
      console.log(`[port-proxy] WS upgrade -> SSH:${target.connectionId}:${target.port} (via local:${localPort})${target.path}`);
    } catch (err: any) {
      console.error(`[port-proxy] SSH tunnel error for WS upgrade:`, err.message);
      socket.destroy();
      return;
    }
  } else {
    console.log(`[port-proxy] WS upgrade -> localhost:${target.port}${target.path}`);
  }

  proxy.ws(req, socket, head, {
    target: `http://127.0.0.1:${localPort}`,
  }, (err) => {
    if (err) {
      console.error(`[port-proxy] WS upgrade error to localhost:${localPort}:`, err.message);
      socket.destroy();
    }
  });
}
