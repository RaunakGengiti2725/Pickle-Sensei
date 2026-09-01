import { NativeModules, Platform } from 'react-native';
import { create } from 'zustand';
import {
  AccountBootstrapError,
  bootstrapCanonicalAccount,
} from '../account/bootstrap';
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../account/apiSession';
import { getAccountBootstrapEnvironment } from '../account/deviceContext';
import {
  GOOGLE_IOS_CLIENT_ID,
  GOOGLE_WEB_CLIENT_ID,
} from '../config/authConfig';
import { getRuntimePublicConfig } from '../config/runtimeConfig';
import { getDb } from '../data/db';
import { getKv, purgeOwnerData, setKv } from '../data/repository';
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
  code:
    | 'auth.canceled'
    | 'auth.not_configured'
    | 'auth.failed'
    | 'auth.session_expired';
  message: string;
}

/** Outcome of the on-device cleanup that follows a server-confirmed
 * deletion. `failed` means the account is gone server-side but some of its
 * rows are still on this phone — the surface that started the deletion must
 * tell the user. */
export interface AccountDeletionCleanup {
  localPurge: 'complete' | 'failed' | 'not_needed';
}

const LOCAL_PURGE_ATTEMPTS = 3;

export const SESSION_EXPIRED_MESSAGE =
  'Your sign-in expired. Sign in again to keep syncing — everything on this phone is still here.';

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
  /** Result of the most recent completeAccountDeletion(); null until one ran. */
  deletionCleanup: AccountDeletionCleanup | null;
  hydrate: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  continueAsGuest: () => Promise<void>;
  signOut: () => Promise<void>;
  /** After the SERVER confirms deletion: purge this account's local data,
   * disconnect the provider SDK, and land signed out. Never call before the
   * backend has acknowledged the deletion. */
  completeAccountDeletion: () => Promise<void>;
  clearError: () => void;
}

const LEGACY_SESSION_KV_KEY = 'auth.session';
const LOCAL_MODE_KV_KEY = 'auth.local-mode';
const LOCAL_GUEST_VALUE = JSON.stringify({ version: 1, mode: 'guest' });
/**
 * Which synced provider signed in last, so the next launch can attempt a
 * silent restore. Stores ONLY the provider name — never tokens or subjects
 * (those live in the in-memory ApiSession and are re-earned every launch).
 * Google is the only value ever written: Apple's AuthenticationServices does
 * not issue identity tokens silently on the client, so Apple users always
 * sign in explicitly and no Apple flag is persisted.
 */
const LAST_PROVIDER_KV_KEY = 'auth.last-provider';
const LAST_PROVIDER_GOOGLE_VALUE = JSON.stringify({
  version: 1,
  provider: 'google',
});

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

/** Best-effort, like persistLocalGuest: clearing writes '' rather than
 * deleting so the same INSERT OR REPLACE path covers both states. */
async function persistLastProvider(provider: 'google' | null): Promise<void> {
  try {
    await setKv(
      getDb(),
      LAST_PROVIDER_KV_KEY,
      provider === 'google' ? LAST_PROVIDER_GOOGLE_VALUE : '',
    );
  } catch {
    // Worst case the next launch simply asks for an explicit sign-in. No
    // identity material is at stake — this key only names a provider.
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
  setApiUnauthorizedListener(handleApiUnauthorized);
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

type GoogleSigninModule =
  typeof import('@react-native-google-signin/google-signin');

/**
 * Loads the Google Sign-In SDK dynamically at call time, so launches that
 * never touch Google auth pay no import cost and builds missing the native
 * module only fail inside these guarded call paths. Metro compiles `import()`
 * and a lazy `require()` to the same in-bundle module access; the `require`
 * form is used because jest's CommonJS transform cannot execute a literal
 * dynamic `import()`.
 */
async function loadGoogleSignin(): Promise<GoogleSigninModule> {
  // jest's CommonJS transform cannot execute a literal dynamic import().
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@react-native-google-signin/google-signin') as GoogleSigninModule;
}

/**
 * Silent Google session restore for hydrate(). Returns the synced session on
 * success, or null when no silent session is available right now. Clears the
 * last-provider flag only when the Google SDK definitively reports that no
 * saved credential exists; every transient failure (offline account
 * bootstrap, SDK errors) throws instead, and the caller lands signed-out
 * while KEEPING the flag so the next launch can retry.
 *
 * Apple has deliberately no equivalent: AuthenticationServices only issues an
 * identity token through its interactive credential UI, so there is no
 * client-side silent Apple token to restore. Apple users re-enter through the
 * explicit sign-in flow.
 */
async function restoreGoogleSessionSilently(
  webClientId: string,
): Promise<AuthSession | null> {
  const { GoogleSignin } = await loadGoogleSignin();
  GoogleSignin.configure({
    webClientId,
    ...(GOOGLE_IOS_CLIENT_ID ? { iosClientId: GOOGLE_IOS_CLIENT_ID } : {}),
  });
  if (!GoogleSignin.hasPreviousSignIn()) {
    return null;
  }
  const response = await GoogleSignin.signInSilently();
  if (response.type !== 'success') {
    // 'noSavedCredentialFound' is definitive: the SDK holds no credential to
    // restore, so stop retrying on future launches until the next sign-in.
    await persistLastProvider(null);
    return null;
  }
  const idToken = response.data.idToken;
  if (!idToken) {
    // Signed in on the SDK side but no verifiable token for our backend.
    // Treat as transient and keep the flag for the next launch.
    return null;
  }
  clearSyncedRuntime();
  return establishSyncedAccount({
    provider: 'google',
    identityToken: idToken,
    displayName: response.data.user.name ?? null,
    providerEmail: response.data.user.email ?? null,
  });
}

/**
 * The backend rejected the current bearer (provider ID tokens expire after
 * about an hour). Stop every retry loop immediately, then try a silent Google
 * refresh; when that is impossible, land signed out with an honest reason so
 * the user is never left tapping controls that fail against a dead token.
 */
function handleApiUnauthorized(expired: ApiSession): void {
  const state = useAuthStore.getState();
  const current = state.session;
  if (
    state.busy ||
    !current ||
    current.localOnly ||
    current.canonicalAppUserId !== expired.canonicalAppUserId
  ) {
    return;
  }
  clearSyncedRuntime();
  void (async () => {
    if (expired.provider === 'google' && GOOGLE_WEB_CLIENT_ID) {
      try {
        const session =
          await restoreGoogleSessionSilently(GOOGLE_WEB_CLIENT_ID);
        if (session) {
          useAuthStore.setState({ session, error: null });
          return;
        }
      } catch {
        // Fall through to the explicit re-sign-in below.
      }
      clearSyncedRuntime();
    }
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    useAuthStore.setState({
      session: null,
      busy: false,
      error: { code: 'auth.session_expired', message: SESSION_EXPIRED_MESSAGE },
    });
    await persistLocalGuest(false);
  })();
}

export const useAuthStore = create<AuthState>((set, get) => ({
  hydrated: false,
  session: null,
  busy: false,
  error: null,
  deletionCleanup: null,

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
      if (raw === LOCAL_GUEST_VALUE) {
        setActiveDataOwner(GUEST_DATA_OWNER);
        set({ session: localGuestSession(), hydrated: true });
        return;
      }
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      // Silent restore is Google-only (see restoreGoogleSessionSilently for
      // why Apple cannot have one) and only worth attempting when the web
      // client id needed for a backend-verifiable token is configured.
      const lastProvider = await getKv(db, LAST_PROVIDER_KV_KEY);
      if (lastProvider === LAST_PROVIDER_GOOGLE_VALUE && GOOGLE_WEB_CLIENT_ID) {
        try {
          const session =
            await restoreGoogleSessionSilently(GOOGLE_WEB_CLIENT_ID);
          if (session) {
            set({ session, hydrated: true });
            return;
          }
        } catch {
          // Opportunistic restore only: offline bootstrap or SDK failures
          // land signed-out with no surfaced error. The last-provider flag is
          // kept so the next launch retries silently.
          clearSyncedRuntime();
          setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
        }
      }
      set({ session: null, hydrated: true });
    } catch {
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      set({ session: null, hydrated: true });
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
      // A stale Google flag (e.g. after a failed silent restore) must never
      // resurrect the previous Google account over this Apple session on the
      // next launch. Apple itself gets no silent-restore flag — its identity
      // tokens are only issued interactively.
      await persistLastProvider(null);
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
      const { GoogleSignin } = await loadGoogleSignin();
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
      // Only after the canonical account is established: the next launch may
      // now silently restore this Google session (provider name only — the
      // token itself is never persisted).
      await persistLastProvider('google');
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
    // Explicit sign-out always disarms the silent restore on the next launch.
    await persistLastProvider(null);
    if (provider === 'google') {
      try {
        const { GoogleSignin } = await loadGoogleSignin();
        await GoogleSignin.signOut();
      } catch {
        // Local API and billing material is already gone. Provider SDK cleanup
        // can safely be retried on the next interactive sign-in.
      }
    }
  },

  completeAccountDeletion: async () => {
    const session = get().session;
    const provider = session?.provider;
    const deletedOwner = session?.canonicalAppUserId
      ? canonicalDataOwner(session.canonicalAppUserId)
      : null;
    clearSyncedRuntime();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    set({ session: null, error: null, busy: false, deletionCleanup: null });
    await persistLocalGuest(false);
    await persistLastProvider(null);
    let localPurge: AccountDeletionCleanup['localPurge'] = 'not_needed';
    if (deletedOwner) {
      localPurge = 'failed';
      for (let attempt = 0; attempt < LOCAL_PURGE_ATTEMPTS; attempt += 1) {
        try {
          await purgeOwnerData(getDb(), deletedOwner);
          localPurge = 'complete';
          break;
        } catch {
          // Retried below; the caller is told if every attempt fails.
        }
      }
    }
    set({ deletionCleanup: { localPurge } });
    if (provider === 'google') {
      try {
        const { GoogleSignin } = await loadGoogleSignin();
        // Full disconnect: the account no longer exists, so the SDK must not
        // silently restore it on the next launch.
        await GoogleSignin.revokeAccess();
        await GoogleSignin.signOut();
      } catch {
        // Best effort; the silent-restore flag is already cleared above.
      }
    }
  },

  clearError: () => set({ error: null }),
}));
