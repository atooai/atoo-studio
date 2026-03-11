import { Router } from 'express';
import { z } from 'zod';
import { db } from '../state/db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, setSessionCookie, clearSessionCookie, destroySession, SESSION_COOKIE_NAME } from '../auth/session.js';
import { getSessionUser } from '../auth/session.js';
import { hasTotpEnabled, getTotpSecret, verifyTotpToken } from '../auth/totp.js';
import { getAuthOptions, verifyAuth } from '../auth/webauthn.js';
import { requireAuth } from '../auth/middleware.js';

export const authRouter = Router();

// GET /api/auth/status — public, returns setup state
authRouter.get('/api/auth/status', (_req, res) => {
  const userCount = db.getUserCount();
  res.json({ setupRequired: userCount === 0, userCount });
});

// POST /api/auth/setup — create initial admin (only when no users exist)
const setupSchema = z.object({
  username: z.string().min(1).max(64),
  display_name: z.string().min(1).max(128),
  password: z.string().min(8).max(256),
});

authRouter.post('/api/auth/setup', async (req, res) => {
  if (db.getUserCount() > 0) {
    return res.status(400).json({ error: 'Setup already completed' });
  }

  const parsed = setupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }

  const { username, display_name, password } = parsed.data;
  const passwordHash = await hashPassword(password);
  const user = db.createUser(username, display_name, 'admin', passwordHash);

  // Assign all existing unowned environments to this admin
  db.assignUnownedEnvironments(user.id);

  const sessionId = createSession(user.id, req);
  setSessionCookie(res, sessionId);

  res.json({
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
  });
});

// POST /api/auth/login — password login
const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

authRouter.post('/api/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const { username, password } = parsed.data;
  const user = db.getUserByUsername(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Check if TOTP is enabled — require second factor
  if (hasTotpEnabled(user.id)) {
    // Create a short-lived pending session to track the TOTP step
    const pendingSessionId = createSession(user.id, req);
    return res.json({
      totpRequired: true,
      pendingSessionId,
    });
  }

  const sessionId = createSession(user.id, req);
  setSessionCookie(res, sessionId);

  res.json({
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
  });
});

// POST /api/auth/login/totp — verify TOTP after password
const totpLoginSchema = z.object({
  pendingSessionId: z.string().min(1),
  token: z.string().length(6),
});

authRouter.post('/api/auth/login/totp', (req, res) => {
  const parsed = totpLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const { pendingSessionId, token } = parsed.data;
  const user = getSessionUser(pendingSessionId);
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired pending session' });
  }

  const secret = getTotpSecret(user.id);
  if (!secret) {
    return res.status(400).json({ error: 'TOTP not configured' });
  }

  if (!verifyTotpToken(secret, token)) {
    return res.status(401).json({ error: 'Invalid TOTP code' });
  }

  // TOTP verified — promote to full session (reuse the pending session)
  setSessionCookie(res, pendingSessionId);

  res.json({
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
  });
});

// POST /api/auth/login/passkey/options — get passkey authentication options
const passkeyOptionsSchema = z.object({
  username: z.string().min(1),
});

authRouter.post('/api/auth/login/passkey/options', async (req, res) => {
  const parsed = passkeyOptionsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const user = db.getUserByUsername(parsed.data.username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const passkeys = db.listPasskeys(user.id);
  if (passkeys.length === 0) {
    return res.status(400).json({ error: 'No passkeys registered' });
  }

  const rpID = req.hostname;
  const options = await getAuthOptions(user.id, rpID);
  res.json({ options, userId: user.id });
});

// POST /api/auth/login/passkey — verify passkey authentication
const passkeyLoginSchema = z.object({
  userId: z.string().min(1),
  response: z.any(),
});

authRouter.post('/api/auth/login/passkey', async (req, res) => {
  const parsed = passkeyLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const { userId, response } = parsed.data;
  const user = db.getUser(userId);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const rpID = req.hostname;
  const origin = `${req.protocol}://${req.headers.host}`;

  const verified = await verifyAuth(userId, rpID, origin, response);
  if (!verified) {
    return res.status(401).json({ error: 'Passkey verification failed' });
  }

  const sessionId = createSession(user.id, req);
  setSessionCookie(res, sessionId);

  res.json({
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
  });
});

// POST /api/auth/logout — destroy session
authRouter.post('/api/auth/logout', (req, res) => {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  if (sessionId) {
    destroySession(sessionId);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me — get current user info
authRouter.get('/api/auth/me', requireAuth, (req, res) => {
  const user = req.user!;
  const hasTOTP = hasTotpEnabled(user.id);
  const passkeys = db.listPasskeys(user.id);
  res.json({
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
    hasTOTP,
    passkeyCount: passkeys.length,
  });
});
