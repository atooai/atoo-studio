import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';
import { encrypt, decrypt } from './crypto-key.js';
import { db } from '../state/db.js';

const ISSUER = 'Atoo Studio';

export async function generateTotpSecret(username: string): Promise<{
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}> {
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: ISSUER,
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });

  const otpauthUri = totp.toString();
  const qrDataUrl = await QRCode.toDataURL(otpauthUri);

  return {
    secret: secret.base32,
    otpauthUri,
    qrDataUrl,
  };
}

export function verifyTotpToken(secret: string, token: string): boolean {
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });

  // Allow 1 period of drift
  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}

export function saveTotpSecret(userId: string, secret: string): void {
  const encrypted = encrypt(secret);
  db.saveTotpSecret(userId, encrypted);
}

export function getTotpSecret(userId: string): string | null {
  const row = db.getTotpSecret(userId);
  if (!row || !row.verified) return null;
  return decrypt(row.secret_encrypted);
}

export function getUnverifiedTotpSecret(userId: string): string | null {
  const row = db.getTotpSecret(userId);
  if (!row) return null;
  return decrypt(row.secret_encrypted);
}

export function markTotpVerified(userId: string): void {
  db.markTotpVerified(userId);
}

export function removeTotpSecret(userId: string): void {
  db.deleteTotpSecret(userId);
}

export function hasTotpEnabled(userId: string): boolean {
  const row = db.getTotpSecret(userId);
  return !!row && !!row.verified;
}
