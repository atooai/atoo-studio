import { Router } from 'express';
import { z } from 'zod';
import { db } from '../state/db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { destroyAllUserSessions } from '../auth/session.js';
import { generateTotpSecret, verifyTotpToken, saveTotpSecret, markTotpVerified, removeTotpSecret, getUnverifiedTotpSecret, hasTotpEnabled } from '../auth/totp.js';
import { getRegistrationOptions, verifyAndSaveRegistration } from '../auth/webauthn.js';

export const usersRouter = Router();

// ═══════════════════════════════════════════════════
// ADMIN: User management
// ═══════════════════════════════════════════════════

// GET /api/users — list all users (admin only)
usersRouter.get('/api/users', requireAdmin, (_req, res) => {
  const users = db.listUsers();
  const usersWithMfa = users.map(u => ({
    ...u,
    hasTOTP: hasTotpEnabled(u.id),
    passkeyCount: db.listPasskeys(u.id).length,
  }));
  res.json(usersWithMfa);
});

// POST /api/users — create user (admin only)
const createUserSchema = z.object({
  username: z.string().min(1).max(64),
  display_name: z.string().min(1).max(128),
  role: z.enum(['admin', 'basic']),
  password: z.string().min(8).max(256),
});

usersRouter.post('/api/users', requireAdmin, async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }

  const { username, display_name, role, password } = parsed.data;

  if (db.getUserByUsername(username)) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const passwordHash = await hashPassword(password);
  const user = db.createUser(username, display_name, role, passwordHash);

  res.json({ id: user.id, username: user.username, display_name: user.display_name, role: user.role });
});

// PUT /api/users/:id — update user (admin only)
const updateUserSchema = z.object({
  display_name: z.string().min(1).max(128).optional(),
  role: z.enum(['admin', 'basic']).optional(),
});

usersRouter.put('/api/users/:id', requireAdmin, (req, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const user = db.getUser(req.params.id as string);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  db.updateUser(req.params.id as string, parsed.data);
  res.json({ ok: true });
});

// DELETE /api/users/:id — delete user (admin only, cannot delete self)
usersRouter.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (req.params.id as string === req.user!.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }

  const user = db.getUser(req.params.id as string);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  destroyAllUserSessions(req.params.id as string);
  db.deleteUser(req.params.id as string);
  res.json({ ok: true });
});

// POST /api/users/:id/reset-password — admin resets password
const resetPasswordSchema = z.object({
  password: z.string().min(8).max(256),
});

usersRouter.post('/api/users/:id/reset-password', requireAdmin, async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const user = db.getUser(req.params.id as string);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const hash = await hashPassword(parsed.data.password);
  db.updateUserPassword(req.params.id as string, hash);
  destroyAllUserSessions(req.params.id as string);
  res.json({ ok: true });
});

// POST /api/users/:id/reset-totp — admin removes TOTP
usersRouter.post('/api/users/:id/reset-totp', requireAdmin, (req, res) => {
  removeTotpSecret(req.params.id as string);
  res.json({ ok: true });
});

// POST /api/users/:id/reset-passkeys — admin removes all passkeys
usersRouter.post('/api/users/:id/reset-passkeys', requireAdmin, (req, res) => {
  db.deleteAllUserPasskeys(req.params.id as string);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════
// SELF: Profile & security
// ═══════════════════════════════════════════════════

// PUT /api/users/me/password — change own password
const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(256),
});

usersRouter.put('/api/users/me/password', requireAuth, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const { current_password, new_password } = parsed.data;
  const user = db.getUser(req.user!.id)!;

  const valid = await verifyPassword(current_password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = await hashPassword(new_password);
  db.updateUserPassword(user.id, hash);
  res.json({ ok: true });
});

// POST /api/users/me/totp/setup — generate TOTP secret + QR
usersRouter.post('/api/users/me/totp/setup', requireAuth, async (req, res) => {
  const user = req.user!;
  const result = await generateTotpSecret(user.username);
  saveTotpSecret(user.id, result.secret);
  res.json({ otpauthUri: result.otpauthUri, qrDataUrl: result.qrDataUrl });
});

// POST /api/users/me/totp/verify — activate TOTP with verification code
const totpVerifySchema = z.object({
  token: z.string().length(6),
});

usersRouter.post('/api/users/me/totp/verify', requireAuth, (req, res) => {
  const parsed = totpVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const secret = getUnverifiedTotpSecret(req.user!.id);
  if (!secret) {
    return res.status(400).json({ error: 'No TOTP setup in progress' });
  }

  if (!verifyTotpToken(secret, parsed.data.token)) {
    return res.status(400).json({ error: 'Invalid TOTP code' });
  }

  markTotpVerified(req.user!.id);
  res.json({ ok: true });
});

// DELETE /api/users/me/totp — remove own TOTP
usersRouter.delete('/api/users/me/totp', requireAuth, (req, res) => {
  removeTotpSecret(req.user!.id);
  res.json({ ok: true });
});

// POST /api/users/me/passkey/register-options — get WebAuthn registration options
usersRouter.post('/api/users/me/passkey/register-options', requireAuth, async (req, res) => {
  const rpID = req.hostname;
  const options = await getRegistrationOptions(req.user!, rpID);
  res.json(options);
});

// POST /api/users/me/passkey/register — complete passkey registration
const passkeyRegisterSchema = z.object({
  response: z.any(),
  device_name: z.string().max(128).optional(),
});

usersRouter.post('/api/users/me/passkey/register', requireAuth, async (req, res) => {
  const parsed = passkeyRegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const rpID = req.hostname;
  const origin = `${req.protocol}://${req.headers.host}`;

  const verified = await verifyAndSaveRegistration(req.user!, rpID, origin, parsed.data.response, parsed.data.device_name);
  if (!verified) {
    return res.status(400).json({ error: 'Passkey registration failed' });
  }

  res.json({ ok: true });
});

// GET /api/users/me/passkeys — list own passkeys
usersRouter.get('/api/users/me/passkeys', requireAuth, (req, res) => {
  const passkeys = db.listPasskeys(req.user!.id);
  res.json(passkeys.map(pk => ({
    id: pk.id,
    device_name: pk.device_name,
    created_at: pk.created_at,
  })));
});

// DELETE /api/users/me/passkeys/:id — remove a passkey
usersRouter.delete('/api/users/me/passkeys/:id', requireAuth, (req, res) => {
  const deleted = db.deletePasskey(req.params.id as string, req.user!.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Passkey not found' });
  }
  res.json({ ok: true });
});
