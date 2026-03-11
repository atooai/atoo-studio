import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const STORE_DIR = path.join(os.homedir(), '.ccproxy');
const AUTH_KEY_PATH = path.join(STORE_DIR, 'auth.key');

let cachedKey: Buffer | null = null;

/** Get or generate the server-side encryption key for TOTP secrets. */
export function getAuthKey(): Buffer {
  if (cachedKey) return cachedKey;

  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }

  if (fs.existsSync(AUTH_KEY_PATH)) {
    cachedKey = Buffer.from(fs.readFileSync(AUTH_KEY_PATH, 'utf-8').trim(), 'hex');
  } else {
    cachedKey = crypto.randomBytes(32);
    fs.writeFileSync(AUTH_KEY_PATH, cachedKey.toString('hex'), { mode: 0o600 });
    console.log('[auth] Generated new auth encryption key');
  }

  return cachedKey;
}

/** Encrypt plaintext using AES-256-GCM with the server auth key. */
export function encrypt(plaintext: string): string {
  const key = getAuthKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** Decrypt ciphertext encrypted with encrypt(). */
export function decrypt(ciphertext: string): string {
  const key = getAuthKey();
  const [ivHex, tagHex, dataHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
