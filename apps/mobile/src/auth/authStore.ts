import { NativeModules } from 'react-native';
import { create } from 'zustand';
import { GOOGLE_IOS_CLIENT_ID } from '../config/authConfig';
import { getDb } from '../data/db';
import { getKv, setKv } from '../data/repository';

/**
 * Auth session state (spec p. 5: Apple / Google / local trial account).
 * Identity tokens are exchanged at API bootstrap; what persists locally is the
 * non-secret session descriptor (provider + subject + display fields), in
 * SQLite kv. Failures are typed — auth.canceled / auth.not_configured /
 * auth.failed — and rendered honestly, never swallowed.
 */

export type AuthProvider = 'apple' | 'google' | 'guest';

export interface AuthSession {
  provider: AuthProvider;
  subject: string;
  displayName: string | null;
  email: string | null;
}

export interface AuthError {
  code: 'auth.canceled' | 'auth.not_configured' | 'auth.failed';
  message: string;
}

interface NativePickleAuth {
  signInWithApple(): Promise<{
    user: string;
    identityToken?: string;
    email?: string;
    givenName?: string;
    familyName?: string;
  }>;
}

interface AuthState {
  hydrated: boolean;
  session: AuthSession | null;
  busy: boolean;
  error: AuthError | null;
  hydrate: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  continueAsGuest: () => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

const KV_KEY = 'auth.session';

function toAuthError(error: unknown): AuthError {
  const err = error as { code?: string; message?: string };
  if (err?.code === 'auth.canceled' || err?.code === 'auth.not_configured') {
    return { code: err.code, message: err.message ?? '' };
  }
  return { code: 'auth.failed', message: err?.message ?? 'Sign-in failed.' };
}

async function persist(session: AuthSession | null): Promise<void> {
  try {
    await setKv(getDb(), KV_KEY, JSON.stringify(session));
  } catch {
    // No local DB (e.g. fresh simulator wipe mid-session): session stays in
    // memory for this run; next launch simply asks again.
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  hydrated: false,
  session: null,
  busy: false,
  error: null,

  hydrate: async () => {
    try {
      const raw = await getKv(getDb(), KV_KEY);
      const parsed = raw ? (JSON.parse(raw) as AuthSession | null) : null;
      set({ session: parsed, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  signInWithApple: async () => {
    if (get().busy) return;
    set({ busy: true, error: null });
    const native = (NativeModules as { PickleAuth?: NativePickleAuth })
      .PickleAuth;
    if (!native?.signInWithApple) {
      set({
        busy: false,
        error: {
          code: 'auth.not_configured',
          message: 'Native Apple sign-in module is missing from this build.',
        },
      });
      return;
    }
    try {
      const result = await native.signInWithApple();
      const name =
        [result.givenName, result.familyName].filter(Boolean).join(' ') || null;
      const session: AuthSession = {
        provider: 'apple',
        subject: result.user,
        displayName: name,
        email: result.email ?? null,
      };
      await persist(session);
      set({ session, busy: false });
    } catch (error) {
      set({ busy: false, error: toAuthError(error) });
    }
  },

  signInWithGoogle: async () => {
    if (get().busy) return;
    set({ busy: true, error: null });
    if (!GOOGLE_IOS_CLIENT_ID) {
      set({
        busy: false,
        error: {
          code: 'auth.not_configured',
          message:
            'Google Sign-In needs an iOS OAuth client id (src/config/authConfig.ts). Not faking it.',
        },
      });
      return;
    }
    try {
      const { GoogleSignin } =
        await import('@react-native-google-signin/google-signin');
      GoogleSignin.configure({ iosClientId: GOOGLE_IOS_CLIENT_ID });
      await GoogleSignin.hasPlayServices({
        showPlayServicesUpdateDialog: false,
      });
      const response = await GoogleSignin.signIn();
      if (response.type !== 'success') {
        set({
          busy: false,
          error: { code: 'auth.canceled', message: 'Sign-in canceled.' },
        });
        return;
      }
      const user = response.data.user;
      const session: AuthSession = {
        provider: 'google',
        subject: user.id,
        displayName: user.name ?? null,
        email: user.email ?? null,
      };
      await persist(session);
      set({ session, busy: false });
    } catch (error) {
      set({ busy: false, error: toAuthError(error) });
    }
  },

  continueAsGuest: async () => {
    const session: AuthSession = {
      provider: 'guest',
      subject: `guest-${Date.now()}`,
      displayName: null,
      email: null,
    };
    await persist(session);
    set({ session, error: null });
  },

  signOut: async () => {
    await persist(null);
    set({ session: null, error: null });
  },

  clearError: () => set({ error: null }),
}));
