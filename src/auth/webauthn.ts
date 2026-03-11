import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { v4 as uuidv4 } from 'uuid';
import { db, type User, type Passkey } from '../state/db.js';

const RP_NAME = 'Atoo Studio';

// In-memory challenge store (short-lived, keyed by usedId)
const challenges = new Map<string, { challenge: string; expires: number }>();

function storeChallenge(userId: string, challenge: string): void {
  challenges.set(userId, { challenge, expires: Date.now() + 5 * 60 * 1000 });
}

function getChallenge(userId: string): string | null {
  const entry = challenges.get(userId);
  if (!entry || entry.expires < Date.now()) {
    challenges.delete(userId);
    return null;
  }
  challenges.delete(userId);
  return entry.challenge;
}

export async function getRegistrationOptions(user: User, rpID: string) {
  const existingPasskeys = db.listPasskeys(user.id);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.username,
    userDisplayName: user.display_name,
    attestationType: 'none',
    excludeCredentials: existingPasskeys.map((pk) => ({
      id: pk.credential_id,
      transports: pk.transports ? JSON.parse(pk.transports) as AuthenticatorTransportFuture[] : undefined,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  storeChallenge(user.id, options.challenge);
  return options;
}

export async function verifyAndSaveRegistration(
  user: User,
  rpID: string,
  origin: string,
  response: any,
  deviceName?: string,
): Promise<boolean> {
  const expectedChallenge = getChallenge(user.id);
  if (!expectedChallenge) return false;

  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch {
    return false;
  }

  if (!verification.verified || !verification.registrationInfo) return false;

  const { credential } = verification.registrationInfo;

  db.createPasskey({
    id: uuidv4(),
    user_id: user.id,
    credential_id: credential.id,
    public_key: Buffer.from(credential.publicKey).toString('base64'),
    counter: credential.counter,
    transports: response.response?.transports ? JSON.stringify(response.response.transports) : null,
    device_name: deviceName || null,
  });

  return true;
}

export async function getAuthOptions(userId: string, rpID: string) {
  const passkeys = db.listPasskeys(userId);

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: passkeys.map((pk) => ({
      id: pk.credential_id,
      transports: pk.transports ? JSON.parse(pk.transports) as AuthenticatorTransportFuture[] : undefined,
    })),
    userVerification: 'preferred',
  });

  storeChallenge(userId, options.challenge);
  return options;
}

export async function verifyAuth(
  userId: string,
  rpID: string,
  origin: string,
  response: any,
): Promise<boolean> {
  const expectedChallenge = getChallenge(userId);
  if (!expectedChallenge) return false;

  // Find the credential being used
  const credentialId = response.id;
  const passkey = db.findPasskeyByCredentialId(credentialId);
  if (!passkey || passkey.user_id !== userId) return false;

  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.credential_id,
        publicKey: Buffer.from(passkey.public_key, 'base64'),
        counter: passkey.counter,
        transports: passkey.transports ? JSON.parse(passkey.transports) as AuthenticatorTransportFuture[] : undefined,
      },
    });
  } catch {
    return false;
  }

  if (!verification.verified) return false;

  // Update counter
  db.updatePasskeyCounter(passkey.id, verification.authenticationInfo.newCounter);
  return true;
}

export function getUsersWithPasskeys(): string[] {
  return db.getUserIdsWithPasskeys();
}
