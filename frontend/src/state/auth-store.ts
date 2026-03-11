import { create } from 'zustand';
import { startAuthentication } from '@simplewebauthn/browser';
import type { AuthUser } from '../api/auth';
import * as authApi from '../api/auth';

interface AuthState {
  user: AuthUser | null;
  setupRequired: boolean;
  loading: boolean;
  totpRequired: boolean;
  pendingSessionId: string | null;
  hasTOTP: boolean;
  passkeyCount: number;
  error: string | null;

  checkAuth: () => Promise<void>;
  login: (username: string, password: string) => Promise<boolean>;
  verifyTotp: (code: string) => Promise<boolean>;
  loginWithPasskey: (username: string) => Promise<boolean>;
  logout: () => Promise<void>;
  setup: (username: string, displayName: string, password: string) => Promise<boolean>;
  setUser: (user: AuthUser | null) => void;
  clearError: () => void;
  refreshMe: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  setupRequired: false,
  loading: true,
  totpRequired: false,
  pendingSessionId: null,
  hasTOTP: false,
  passkeyCount: 0,
  error: null,

  checkAuth: async () => {
    set({ loading: true, error: null });
    try {
      const status = await authApi.getAuthStatus();
      if (status.setupRequired) {
        set({ setupRequired: true, loading: false, user: null });
        return;
      }
      // Try to get current user from session cookie
      try {
        const me = await authApi.getMe();
        set({
          user: me.user,
          hasTOTP: me.hasTOTP,
          passkeyCount: me.passkeyCount,
          setupRequired: false,
          loading: false,
        });
      } catch {
        set({ user: null, setupRequired: false, loading: false });
      }
    } catch {
      set({ loading: false });
    }
  },

  login: async (username: string, password: string) => {
    set({ error: null });
    try {
      const result = await authApi.login(username, password);
      if (result.totpRequired) {
        set({ totpRequired: true, pendingSessionId: result.pendingSessionId || null });
        return true;
      }
      if (result.user) {
        set({ user: result.user, totpRequired: false, pendingSessionId: null });
        // Fetch full me info
        get().refreshMe();
        return true;
      }
      return false;
    } catch (err: any) {
      set({ error: err.message || 'Login failed' });
      return false;
    }
  },

  verifyTotp: async (code: string) => {
    set({ error: null });
    const { pendingSessionId } = get();
    if (!pendingSessionId) {
      set({ error: 'No pending session' });
      return false;
    }
    try {
      const result = await authApi.loginTotp(pendingSessionId, code);
      set({ user: result.user, totpRequired: false, pendingSessionId: null });
      get().refreshMe();
      return true;
    } catch (err: any) {
      set({ error: err.message || 'Invalid TOTP code' });
      return false;
    }
  },

  loginWithPasskey: async (username: string) => {
    set({ error: null });
    try {
      const { options, userId } = await authApi.loginPasskeyOptions(username);
      const credential = await startAuthentication({ optionsJSON: options });
      const result = await authApi.loginPasskey(userId, credential);
      set({ user: result.user, totpRequired: false, pendingSessionId: null });
      get().refreshMe();
      return true;
    } catch (err: any) {
      set({ error: err.message || 'Passkey login failed' });
      return false;
    }
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {}
    set({ user: null, totpRequired: false, pendingSessionId: null, hasTOTP: false, passkeyCount: 0 });
  },

  setup: async (username: string, displayName: string, password: string) => {
    set({ error: null });
    try {
      const result = await authApi.setupAdmin(username, displayName, password);
      set({ user: result.user, setupRequired: false });
      get().refreshMe();
      return true;
    } catch (err: any) {
      set({ error: err.message || 'Setup failed' });
      return false;
    }
  },

  setUser: (user) => set({ user }),
  clearError: () => set({ error: null }),

  refreshMe: async () => {
    try {
      const me = await authApi.getMe();
      set({ hasTOTP: me.hasTOTP, passkeyCount: me.passkeyCount });
    } catch {}
  },
}));
