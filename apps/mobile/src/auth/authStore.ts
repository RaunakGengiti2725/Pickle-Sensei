import { NativeModules, Platform } from 'react-native';
import { create } from 'zustand';
import {
  AccountBootstrapError,
  bootstrapCanonicalAccount,
  normalizeApiBaseUrl,
} from '../account/bootstrap';
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../account/apiSession';
import {
  clearUnconfirmedAccountDeletion,
  unconfirmedAccountDeletionFor,
} from '../account/deletion';
import { getAccountBootstrapEnvironment } from '../account/deviceContext';
import {
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
} from '../account/sessionKeeper';
import {
  revokeApiSession,
  type RefreshedTokens,
} from '../account/sessionLifecycle';
import {
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
  type PersistedSession,
} from '../account/sessionVault';
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
 * UUID—not an Apple user identifier or Google subject. Bearer material lives
 * in the in-memory ApiSession store; the only durable credential is the
 * refresh token in the device Keychain (sessionVault.ts), which is what lets a
 * relaunch come back signed in. Nothing about a synced account is ever
 * persisted in SQLite.
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
    authorizationCode?: string;
    email?: string;
    givenName?: string;
    familyName?: string;
  }>;
}

/**
 * The server's verdict on an account whose delete-confirm was answered 401
 * after an earlier confirm may have gone through:
 *   deleted    — the refresh token was refused too, so the account is gone;
 *                `completeAccountDeletion` has already run.
 *   signed_in  — the refresh token rotated: only the bearer had expired, the
 *                account (and its local data) is intact.
 *   signed_out — the session ended for another reason meanwhile (explicit
 *                sign-out, or a legacy session with nothing to rotate).
 *   unknown    — the server could not be reached in time; nothing changed.
 */
export type UnconfirmedDeletionVerdict =
  'deleted' | 'signed_in' | 'signed_out' | 'unknown';

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

/** How long `settleUnconfirmedDeletion` waits for the keeper's verdict
 * before answering `unknown` (the keeper's own timeout is 15s). */
const SETTLE_DELETION_DEADLINE_MS = 20_000;

let verdictWaiters: Array<(verdict: UnconfirmedDeletionVerdict) => void> = [];
let verdictInFlight: Promise<UnconfirmedDeletionVerdict> | null = null;
/** The last keeper verdict for the CURRENT sign-in; reset when a new API
 * session is installed so a stale answer can never speak for a later one. */
let lastKeeperVerdict: UnconfirmedDeletionVerdict | null = null;

/** A promise for the keeper's next outcome. Shared: a 401 that arrives while
 * a rotation is already in flight joins it instead of forcing another. */
function awaitKeeperVerdict(): Promise<UnconfirmedDeletionVerdict> {
  if (!verdictInFlight) {
    verdictInFlight = new Promise(resolve => {
      verdictWaiters.push(resolve);
    });
  }
  return verdictInFlight;
}

/** Detaches the current waiters so they can be resolved AFTER the work the
 * verdict describes (the local end of the account) has finished. */
function takeKeeperVerdictWaiters(): (
  verdict: UnconfirmedDeletionVerdict,
) => void {
  const waiters = verdictWaiters;
  verdictWaiters = [];
  verdictInFlight = null;
  return verdict => {
    lastKeeperVerdict = verdict;
    for (const resolve of waiters) resolve(verdict);
  };
}

function settleKeeperVerdict(verdict: UnconfirmedDeletionVerdict): void {
  takeKeeperVerdictWaiters()(verdict);
}

function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void promise.then(value => {
      clearTimeout(timer);
      resolve(value);
    });
  });
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
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  clearAccessStoreConfiguration();
  clearTrainingStoreConfiguration();
  clearUnconfirmedAccountDeletion();
  // Anyone still waiting on the keeper: it will not answer any more.
  if (verdictInFlight) {
    const waiters = verdictWaiters;
    verdictWaiters = [];
    verdictInFlight = null;
    for (const resolve of waiters) resolve('signed_out');
  }
}

/**
 * Makes an API session the live one: data owner, bearer store, and the
 * long-lived clients (billing, training, sync). Those clients resolve the
 * bearer through `bearerTokenFor` on every request, so a later rotation only
 * has to update the ApiSession store — they are configured exactly once per
 * sign-in and never reset by a token refresh.
 */
function installApiSession(apiSession: ApiSession): void {
  const config = getRuntimePublicConfig();
  const canonicalAppUserId = apiSession.canonicalAppUserId;
  setActiveDataOwner(canonicalDataOwner(canonicalAppUserId));
  establishApiSession(apiSession);
  configureAccessStore(
    createBillingAccessDependencies({
      revenueCatPublicSdkKey: config.revenueCatPublicSdkKey,
      canonicalAppUserId,
      apiBaseUrl: apiSession.apiBaseUrl,
      get apiToken() {
        return bearerTokenFor(canonicalAppUserId);
      },
    }),
  );
  configureTrainingStore(
    createTrainingApi({
      baseUrl: apiSession.apiBaseUrl,
      get token() {
        return bearerTokenFor(canonicalAppUserId);
      },
    }),
  );
  configureSyncRuntime(apiSession);
  setApiUnauthorizedListener(handleApiUnauthorized);
  lastKeeperVerdict = null;
}

/** The Keychain record for a synced session — only when the server minted a
 * refresh token (a legacy provider-token session has nothing durable). */
async function persistSession(
  session: AuthSession,
  apiSession: ApiSession,
): Promise<void> {
  if (!apiSession.refreshToken || !session.canonicalAppUserId) return;
  await savePersistedSession({
    version: 1,
    provider: apiSession.provider,
    canonicalAppUserId: session.canonicalAppUserId,
    refreshToken: apiSession.refreshToken,
    email: session.email,
    displayName: session.displayName,
  });
}

/**
 * The session died server-side (refresh token revoked or rotated away, or
 * the account is gone): the only implicit sign-out in the app. Everything
 * local is cleared, including the Google silent-restore flag — an explicit
 * sign-in is required to come back.
 */
async function dropRevokedSession(): Promise<void> {
  clearSyncedRuntime();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({ session: null, error: null, busy: false });
  await clearPersistedSession();
  await persistLocalGuest(false);
  await persistLastProvider(null);
}

/**
 * Applies rotated tokens for the signed-in account: updates the live
 * ApiSession (or installs the first one of this run when the launch refresh
 * only landed later), then re-persists the rotated refresh token. Ignored if
 * the account is no longer the signed-in one.
 */
function adoptRotatedTokens(
  session: AuthSession,
  apiBaseUrl: string,
  tokens: RefreshedTokens,
): void {
  const canonicalAppUserId = session.canonicalAppUserId;
  if (
    !canonicalAppUserId ||
    session.provider === 'guest' ||
    useAuthStore.getState().session?.canonicalAppUserId !== canonicalAppUserId
  ) {
    return;
  }
  const next: ApiSession = {
    apiBaseUrl,
    bearerToken: tokens.bearerToken,
    canonicalAppUserId,
    provider: session.provider,
    refreshToken: tokens.refreshToken,
    bearerExpiresAtMs: tokens.bearerExpiresAtMs,
  };
  if (getApiSession()?.canonicalAppUserId === canonicalAppUserId) {
    establishApiSession(next);
  } else {
    installApiSession(next);
  }
  void persistSession(session, next);
}

type RestoreOutcome = 'online' | 'offline' | 'revoked';

function keepSessionAlive(
  session: AuthSession,
  apiSession: Pick<
    ApiSession,
    'apiBaseUrl' | 'refreshToken' | 'bearerExpiresAtMs'
  >,
  onOutcome?: (outcome: RestoreOutcome) => void,
): void {
  if (!apiSession.refreshToken) {
    stopSessionKeeper();
    return;
  }
  startSessionKeeper({
    apiBaseUrl: apiSession.apiBaseUrl,
    refreshToken: apiSession.refreshToken,
    bearerExpiresAtMs: apiSession.bearerExpiresAtMs ?? null,
    onRotated: tokens => {
      adoptRotatedTokens(session, apiSession.apiBaseUrl, tokens);
      settleKeeperVerdict('signed_in');
      onOutcome?.('online');
    },
    onRevoked: async () => {
      const settle = takeKeeperVerdictWaiters();
      // The server refused the refresh token. If this device sent a
      // delete-confirm for this account that was never answered
      // definitively, that refusal IS the answer: the account is gone, and
      // the end-of-account cleanup (purge, Keychain, provider disconnect)
      // must run — not the plain revoked-session sign-out.
      const unconfirmed = session.canonicalAppUserId
        ? unconfirmedAccountDeletionFor(session.canonicalAppUserId)
        : null;
      if (unconfirmed) {
        await useAuthStore.getState().completeAccountDeletion();
      } else {
        await dropRevokedSession();
      }
      settle(unconfirmed ? 'deleted' : 'signed_out');
      onOutcome?.('revoked');
    },
    onDeferred: () => {
      settleKeeperVerdict('unknown');
      onOutcome?.('offline');
    },
  });
}

async function establishSyncedAccount(input: {
  provider: 'apple' | 'google';
  identityToken: string | null | undefined;
  appleAuthorizationCode?: string | null;
  displayName: string | null;
  providerEmail: string | null;
}): Promise<AuthSession> {
  const config = getRuntimePublicConfig();
  const result = await bootstrapCanonicalAccount({
    apiBaseUrl: config.apiBaseUrl,
    bearerToken: input.identityToken,
    provider: input.provider,
    appleAuthorizationCode: input.appleAuthorizationCode,
    environment: getAccountBootstrapEnvironment(config),
  });
  installApiSession(result.apiSession);
  await persistLocalGuest(false);
  const session: AuthSession = {
    provider: input.provider,
    subject: result.account.id,
    canonicalAppUserId: result.account.id,
    localOnly: false,
    displayName: input.displayName,
    email: result.account.email ?? input.providerEmail,
  };
  await persistSession(session, result.apiSession);
  keepSessionAlive(session, result.apiSession);
  return session;
}

function sessionFromPersisted(persisted: PersistedSession): AuthSession {
  return {
    provider: persisted.provider,
    subject: persisted.canonicalAppUserId,
    canonicalAppUserId: persisted.canonicalAppUserId,
    localOnly: false,
    displayName: persisted.displayName,
    email: persisted.email,
  };
}

/** How long a launch waits for the restore refresh before showing the app
 * signed in with local data while the refresh keeps going in the background
 * (the keeper adopts the tokens when they land). */
const LAUNCH_REFRESH_WAIT_MS = 8_000;

/**
 * Brings a persisted session back: the user is signed in from the Keychain
 * record alone, and the refresh token is exchanged for a live bearer. Only an
 * explicit refusal from the server ('revoked') ends the session; offline or
 * flaky launches stay signed in and keep retrying.
 */
async function restorePersistedSession(
  persisted: PersistedSession,
): Promise<RestoreOutcome> {
  const session = sessionFromPersisted(persisted);
  setActiveDataOwner(canonicalDataOwner(persisted.canonicalAppUserId));
  // Signed in from the record alone (hydrated flips later, in hydrate()); the
  // keeper's first rotation needs this to be the current account to adopt.
  useAuthStore.setState({ session });
  let apiBaseUrl: string;
  try {
    apiBaseUrl = normalizeApiBaseUrl(getRuntimePublicConfig().apiBaseUrl);
  } catch {
    // No usable API in this build: signed in with local data, nothing to
    // refresh against.
    return 'offline';
  }
  return new Promise<RestoreOutcome>(resolve => {
    const deadline = setTimeout(
      () => resolve('offline'),
      LAUNCH_REFRESH_WAIT_MS,
    );
    keepSessionAlive(
      session,
      {
        apiBaseUrl,
        refreshToken: persisted.refreshToken,
        bearerExpiresAtMs: null,
      },
      outcome => {
        clearTimeout(deadline);
        resolve(outcome);
      },
    );
  });
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
 * An API route rejected the CURRENT bearer (apiSession.ts already ignores
 * late 401s for a token that was rotated or cleared since). With a refresh
 * token this is the keeper's job: rotate right now, and let its `onRevoked`
 * — the ONE implicit sign-out — end the session only if the server refuses
 * the refresh token too; the durable sign-in is never dropped for a 401 on
 * its own. A legacy provider-token session (an older server returned no
 * session, so there is nothing to rotate and the ID token dies after about
 * an hour) stops every retry loop immediately, tries a silent Google
 * refresh, and otherwise lands signed out with an honest reason so the user
 * is never left tapping controls that fail against a dead token.
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
  if (expired.refreshToken) {
    // Register interest before forcing the rotation so a verdict that lands
    // before anyone asks (settleUnconfirmedDeletion) is not lost.
    void awaitKeeperVerdict();
    refreshSessionNow();
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
    await clearPersistedSession();
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
      // The durable session: whoever signed in on this device last stays
      // signed in across relaunches, backgrounding and reboots, for any
      // provider, until they sign out or the server refuses the refresh
      // token. No provider SDK is consulted for this.
      const persisted = await loadPersistedSession();
      if (persisted) {
        const outcome = await restorePersistedSession(persisted);
        if (outcome !== 'revoked') {
          set({ hydrated: true });
          return;
        }
      }
      // Legacy fallback for devices that signed in before sessions were
      // persisted: silent restore is Google-only (see
      // restoreGoogleSessionSilently for why Apple cannot have one) and only
      // worth attempting when the web client id needed for a
      // backend-verifiable token is configured. A success bootstraps a new
      // session, which IS persisted — so this path runs at most once.
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
      clearSyncedRuntime();
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
        appleAuthorizationCode: result.authorizationCode,
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
    const apiSession = getApiSession();
    clearSyncedRuntime();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    set({ session: null, error: null, busy: false });
    // The persisted session goes first: whatever else fails below, the next
    // launch must not restore an account the user just signed out of.
    await clearPersistedSession();
    await persistLocalGuest(false);
    // Explicit sign-out always disarms the silent restore on the next launch.
    await persistLastProvider(null);
    // Kill this device's session server-side too (best effort — offline, the
    // refresh token still dies at its natural rotation/expiry).
    if (apiSession?.refreshToken) await revokeApiSession(apiSession);
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
    // The account (and every server-side session) is already gone; the
    // Keychain record must go with it or the next launch would try — and
    // fail — to refresh a deleted account.
    await clearPersistedSession();
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

/**
 * Delete-confirm was answered 401 while a confirm for this account is still
 * unconfirmed (deletion.ts ledger): let the server settle whether the
 * account still exists by forcing a refresh-token rotation through the
 * session keeper, and resolve with its verdict. Never guesses: a 401 alone
 * deletes nothing locally, and the refusal of the refresh token is what
 * turns into `completeAccountDeletion` (in the keeper's `onRevoked`).
 * A module function rather than a store action on purpose: it is not an
 * interactive sign-in affordance (the store deliberately exposes none).
 */
export async function settleUnconfirmedDeletion(): Promise<UnconfirmedDeletionVerdict> {
  const current = useAuthStore.getState().session;
  if (!current) return lastKeeperVerdict ?? 'signed_out';
  const apiSession = getApiSession();
  if (
    current.localOnly ||
    !apiSession?.refreshToken ||
    apiSession.canonicalAppUserId !== current.canonicalAppUserId
  ) {
    return 'unknown';
  }
  const verdict = awaitKeeperVerdict();
  refreshSessionNow();
  return withDeadline(verdict, SETTLE_DELETION_DEADLINE_MS, 'unknown');
}
