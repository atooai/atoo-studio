import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'http';
import { SESSION_COOKIE_NAME } from './session.js';
import { getSessionUser } from './session.js';
import { db, type User } from '../state/db.js';

// Extend Express Request with user
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/** Middleware: require a valid auth session. Attaches req.user. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Setup mode: if no users exist, return 503
  if (db.getUserCount() === 0) {
    res.status(503).json({ error: 'Setup required', setupRequired: true });
    return;
  }

  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  if (!sessionId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const user = getSessionUser(sessionId);
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  req.user = user;
  next();
}

/** Middleware: require admin role. Must be used after requireAuth. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  });
}

/** Parse session from WebSocket upgrade request headers. Returns user or null. */
export function authenticateWsUpgrade(req: IncomingMessage): User | null {
  // If no users exist (setup mode), allow all WebSocket connections
  if (db.getUserCount() === 0) return null;

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const sessionId = parseCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  if (!sessionId) return null;

  return getSessionUser(sessionId);
}

/** Check if auth is required (users exist). */
export function isAuthEnabled(): boolean {
  return db.getUserCount() > 0;
}

function parseCookieValue(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
