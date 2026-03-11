import { v4 as uuidv4 } from 'uuid';
import { vccDb, type User } from '../state/db.js';
import type { Request, Response } from 'express';

export const SESSION_COOKIE_NAME = 'ccproxy_sid';
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

export function createSession(userId: string, req: Request): string {
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
  const ip = req.ip || req.socket.remoteAddress || '';
  const ua = req.headers['user-agent'] || '';
  vccDb.createAuthSession(sessionId, userId, expiresAt, ip, ua);
  return sessionId;
}

export function getSessionUser(sessionId: string): User | null {
  return vccDb.getAuthSessionUser(sessionId);
}

export function destroySession(sessionId: string): void {
  vccDb.deleteAuthSession(sessionId);
}

export function destroyAllUserSessions(userId: string): void {
  vccDb.deleteAllUserAuthSessions(userId);
}

export function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}
