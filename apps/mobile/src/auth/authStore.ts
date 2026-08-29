import { NativeModules, Platform } from 'react-native';
import { create } from 'zustand';
import {
  AccountBootstrapError,
  bootstrapCanonicalAccount,
} from '../account/bootstrap';
import { clearApiSession, establishApiSession } from '../account/apiSession';
import { getAccountBootstrapEnvironment } from '../account/deviceContext';
import {
  GOOGLE_IOS_CLIENT_ID,
  GOOGLE_WEB_CLIENT_ID,
} from '../config/authConfig';
import { getRuntimePublicConfig } from '../config/runtimeConfig';
import { getDb } from '../data/db';
import { getKv, setKv } from '../data/repository';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../data/accountScope';
import { clearSyncRuntime, configureSyncRuntime } from '../data/syncRuntime';
import { createBillingAccessDependencies } from '../billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
} from '../state/accessStore';
import { createTrainingApi } from '../training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
} from '../training/store';

/**
 * A UI-safe account descriptor. For synced accounts `subject` is retained only
 * for compatibility with existing display code and is the canonical backend
 * UUID—not an Apple user identifier or Google subject. Provider tokens live in
 * the in-memory ApiSession store and are never persisted in SQLite.
 */
export type AuthProvider = 'apple' | 'google' | 'guest';

export interface AuthSession {
  provider: AuthProvider;
  subject: string;
  canonicalAppUserId: string | null;
  localOnly: boolean;
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

const LEGACY_SESSION_KV_KEY = 'auth.session';
const LOCAL_MODE_KV_KEY = 'auth.local-mode';
const LOCAL_GUEST_VALUE = JSON.stringify({ version: 1, mode: 'guest' });

function localGuestSession(): AuthSession {
  return {
    provider: 'guest',
    subject: 'local-only',
    canonicalAppUserId: null,
    localOnly: true,
    displayName: null,
    email: null,
  };
}

function toAuthError(error: unknown): AuthError {
  if (error instanceof AccountBootstrapError) {
    return {
      code:
        error.code === 'account.not_configured'
          ? 'auth.not_configured'
          : 'auth.failed',
      message: error.message,
    };
  }
  const err = error as { code?: string; message?: string };
  if (err?.code === 'auth.canceled' || err?.code === 'auth.not_configured') {
    return { code: err.code, message: err.message ?? '' };
  }
  return { code: 'auth.failed', message: err?.message ?? 'Sign-in failed.' };
}

async function persistLocalGuest(enabled: boolean): Promise<void> {
  try {
    await setKv(getDb(), LOCAL_MODE_KV_KEY, enabled ? LOCAL_GUEST_VALUE : '');
  } catch {
    // Guest mode remains in memory for this run. Synced identity material is
    // never sent to this fallback and is never persisted here.
  }
}

function clearSyncedRuntime(): void {
  clearSyncRuntime();
  clearApiSession();
  clearAccessStoreConfiguration();
  clearTrainingStoreConfiguration();
}

async function establishSyncedAccount(input: {
  provider: 'apple' | 'google';
  identityToken: string | null | undefined;
  displayName: string | null;
  providerEmail: string | null;
}): Promise<AuthSession> {
  const config = getRuntimePublicConfig();
  const result = await bootstrapCanonicalAccount({
    apiBaseUrl: config.apiBaseUrl,
    bearerToken: input.identityToken,
    provider: input.provider,
    environment: getAccountBootstrapEnvironment(config),
  });
  setActiveDataOwner(canonicalDataOwner(result.account.id));
  establishApiSession(result.apiSession);
  configureAccessStore(
    createBillingAccessDependencies({
      revenueCatPublicSdkKey: config.revenueCatPublicSdkKey,
      canonicalAppUserId: result.apiSession.canonicalAppUserId,
      apiBaseUrl: result.apiSession.apiBaseUrl,
      apiToken: result.apiSession.bearerToken,
    }),
  );
  configureTrainingStore(
    createTrainingApi({
      baseUrl: result.apiSession.apiBaseUrl,
      token: result.apiSession.bearerToken,
    }),
  );
  configureSyncRuntime(result.apiSession);
  await persistLocalGuest(false);
  return {
    provider: input.provider,
    subject: result.account.id,
    canonicalAppUserId: result.account.id,
    localOnly: false,
    displayName: input.displayName,
    email: result.account.email ?? input.providerEmail,
  };
}

export const useAuthStore = create<AuthState>((set, get) => ({
  hydrated: false,
  session: null,
  busy: false,
  error: null,

  hydrate: async () => {
    clearSyncedRuntime();
    try {
      const db = getDb();
      // Earlier builds wrote provider subjects to SQLite. Blank that legacy
      // value during migration instead of hydrating it into a trusted session.
      if (await getKv(db, LEGACY_SESSION_KV_KEY)) {
        await setKv(db, LEGACY_SESSION_KV_KEY, '');
      }
      const raw = await getKv(db, LOCAL_MODE_KV_KEY);
      const localGuest = raw === LOCAL_GUEST_VALUE;
      setActiveDataOwner(localGuest ? GUEST_DATA_OWNER : SIGNED_OUT_DATA_OWNER);
      set({
        session: localGuest ? localGuestSession() : null,
        hydrated: true,
      });
    } catch {
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
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
      clearSyncedRuntime();
      const session = await establishSyncedAccount({
        provider: 'apple',
        identityToken: result.identityToken,
        displayName: name,
        providerEmail: result.email ?? null,
      });
      set({ session, busy: false });
    } catch (error) {
      clearSyncedRuntime();
      set({ busy: false, error: toAuthError(error) });
    }
  },

  signInWithGoogle: async () => {
    if (get().busy) return;
    set({ busy: true, error: null });
    if (
      !GOOGLE_WEB_CLIENT_ID ||
      (Platform.OS === 'ios' && !GOOGLE_IOS_CLIENT_ID)
    ) {
      set({
        busy: false,
        error: {
          code: 'auth.not_configured',
          message:
            'Google Sign-In needs its public native and web OAuth client IDs. The web client ID is required for a backend-verifiable token.',
        },
      });
      return;
    }
    try {
      const { GoogleSignin } =
        await import('@react-native-google-signin/google-signin');
      GoogleSignin.configure({
        webClientId: GOOGLE_WEB_CLIENT_ID,
        ...(GOOGLE_IOS_CLIENT_ID ? { iosClientId: GOOGLE_IOS_CLIENT_ID } : {}),
      });
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
      clearSyncedRuntime();
      const session = await establishSyncedAccount({
        provider: 'google',
        identityToken: response.data.idToken,
        displayName: user.name ?? null,
        providerEmail: user.email ?? null,
      });
      set({ session, busy: false });
    } catch (error) {
      clearSyncedRuntime();
      set({ busy: false, error: toAuthError(error) });
    }
  },

  continueAsGuest: async () => {
    clearSyncedRuntime();
    const session = localGuestSession();
    await persistLocalGuest(true);
    setActiveDataOwner(GUEST_DATA_OWNER);
    set({ session, error: null });
  },

  signOut: async () => {
    const provider = get().session?.provider;
    clearSyncedRuntime();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    set({ session: null, error: null, busy: false });
    await persistLocalGuest(false);
    if (provider === 'google') {
      try {
        const { GoogleSignin } =
          await import('@react-native-google-signin/google-signin');
        await GoogleSignin.signOut();
      } catch {
        // Local API and billing material is already gone. Provider SDK cleanup
        // can safely be retried on the next interactive sign-in.
      }
    }
  },

  clearError: () => set({ error: null }),
}));
