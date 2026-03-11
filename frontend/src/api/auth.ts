import { api } from './index';

export interface AuthUser {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'basic';
}

export interface AuthStatus {
  setupRequired: boolean;
  userCount: number;
}

export interface MeResponse {
  user: AuthUser;
  hasTOTP: boolean;
  passkeyCount: number;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return api('GET', '/api/auth/status');
}

export async function getMe(): Promise<MeResponse> {
  return api('GET', '/api/auth/me');
}

export async function setupAdmin(username: string, display_name: string, password: string): Promise<{ user: AuthUser }> {
  return api('POST', '/api/auth/setup', { username, display_name, password });
}

export async function login(username: string, password: string): Promise<{ user?: AuthUser; totpRequired?: boolean; pendingSessionId?: string }> {
  return api('POST', '/api/auth/login', { username, password });
}

export async function loginTotp(pendingSessionId: string, token: string): Promise<{ user: AuthUser }> {
  return api('POST', '/api/auth/login/totp', { pendingSessionId, token });
}

export async function loginPasskeyOptions(username: string): Promise<{ options: any; userId: string }> {
  return api('POST', '/api/auth/login/passkey/options', { username });
}

export async function loginPasskey(userId: string, response: any): Promise<{ user: AuthUser }> {
  return api('POST', '/api/auth/login/passkey', { userId, response });
}

export async function logout(): Promise<void> {
  return api('POST', '/api/auth/logout');
}

// User management (admin)
export async function listUsers(): Promise<any[]> {
  return api('GET', '/api/users');
}

export async function createUser(data: { username: string; display_name: string; role: string; password: string }): Promise<any> {
  return api('POST', '/api/users', data);
}

export async function updateUser(id: string, data: { display_name?: string; role?: string }): Promise<void> {
  return api('PUT', `/api/users/${id}`, data);
}

export async function deleteUser(id: string): Promise<void> {
  return api('DELETE', `/api/users/${id}`);
}

export async function resetUserPassword(id: string, password: string): Promise<void> {
  return api('POST', `/api/users/${id}/reset-password`, { password });
}

export async function resetUserTotp(id: string): Promise<void> {
  return api('POST', `/api/users/${id}/reset-totp`);
}

export async function resetUserPasskeys(id: string): Promise<void> {
  return api('POST', `/api/users/${id}/reset-passkeys`);
}

// Self-service
export async function changePassword(current_password: string, new_password: string): Promise<void> {
  return api('PUT', '/api/users/me/password', { current_password, new_password });
}

export async function setupTotp(): Promise<{ otpauthUri: string; qrDataUrl: string }> {
  return api('POST', '/api/users/me/totp/setup');
}

export async function verifyTotp(token: string): Promise<void> {
  return api('POST', '/api/users/me/totp/verify', { token });
}

export async function removeTotp(): Promise<void> {
  return api('DELETE', '/api/users/me/totp');
}

export async function getPasskeyRegisterOptions(): Promise<any> {
  return api('POST', '/api/users/me/passkey/register-options');
}

export async function registerPasskey(response: any, device_name?: string): Promise<void> {
  return api('POST', '/api/users/me/passkey/register', { response, device_name });
}

export async function listMyPasskeys(): Promise<any[]> {
  return api('GET', '/api/users/me/passkeys');
}

export async function deleteMyPasskey(id: string): Promise<void> {
  return api('DELETE', `/api/users/me/passkeys/${id}`);
}

// Environment sharing
export async function listEnvironmentShares(envId: string): Promise<any[]> {
  return api('GET', `/api/environments/${envId}/shares`);
}

export async function shareEnvironment(envId: string, userId: string): Promise<void> {
  return api('POST', `/api/environments/${envId}/shares`, { user_id: userId });
}

export async function unshareEnvironment(envId: string, userId: string): Promise<void> {
  return api('DELETE', `/api/environments/${envId}/shares/${userId}`);
}
