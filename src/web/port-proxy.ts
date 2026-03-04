import http from 'http';
import httpProxy from 'http-proxy';
import type { Request, Response, NextFunction } from 'express';
import type { Duplex } from 'stream';
import { WEB_PORT } from '../config.js';

interface ProxyTarget {
  port: number;
  path: string;
}

const SUBDOMAIN_RE = /^(\d+)\.port\.on\./;
const PATH_PREFIX_RE = /^\/at\/port\/(\d+)(\/.*)?$/;

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
  return (req: Request, res: Response, next: NextFunction): void => {
    const target = extractPortProxyTarget(req);
    if (!target) {
      next();
      return;
    }
    req.url = target.path;
    console.log(`[port-proxy] HTTP ${req.method} -> localhost:${target.port}${target.path}`);
    proxy.web(req, res, { target: `http://127.0.0.1:${target.port}` });
  };
}

export function isPortProxyUpgrade(req: http.IncomingMessage): boolean {
  return extractPortProxyTarget(req) !== null;
}

export function handlePortProxyUpgrade(
  proxy: httpProxy,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const target = extractPortProxyTarget(req);
  if (!target) {
    socket.destroy();
    return;
  }
  req.url = target.path;
  console.log(`[port-proxy] WS upgrade -> localhost:${target.port}${target.path}`);
  proxy.ws(req, socket, head, {
    target: `http://127.0.0.1:${target.port}`,
  }, (err) => {
    if (err) {
      console.error(`[port-proxy] WS upgrade error to localhost:${target.port}:`, err.message);
      socket.destroy();
    }
  });
}
