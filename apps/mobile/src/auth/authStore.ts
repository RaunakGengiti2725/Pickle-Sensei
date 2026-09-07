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
import { getAccountBootstrapEnvironment } from '../account/deviceContext';
import type { AccountDeletionContext } from '../account/deletion';
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
  readPersistedSession,
  savePersistedSession,
  type PersistedSession,
} from '../account/sessionVault';
import {
  GOOGLE_IOS_CLIENT_ID,
  GOOGLE_WEB_CLIENT_ID,
} from '../config/authConfig';
import { getRuntimePublicConfig } from '../config/runtimeConfig';
import { getDb, type LocalDb } from '../data/db';
import { getKv, purgeOwnerData, setKv } from '../data/repository';
import {
  DataOwnerChangedError,
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  captureDataOwnerContext,
  getActiveDataOwner,
  isDataOwnerContextCurrent,
  setActiveDataOwner,
  type DataOwnerContext,
} from '../data/accountScope';
import { clearSyncRuntime, configureSyncRuntime } from '../data/syncRuntime';
import { createBillingAccessDependencies } from '../billing';
import {
  startBillingLifecycle,
  stopBillingLifecycle,
} from '../billing/lifecycle';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  discardPendingFulfilmentForOwner,
} from '../state/accessStore';
import {
  configureConsentStore,
  resetConsentStore,
} from '../state/consentStore';
import { createTrainingApi } from '../training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
} from '../training/store';
import {
  SESSION_RESTORE_KV_KEY,
  parseSessionRestoreRecord,
  permitsPersistedSession,
  returningSessionState,
  type AuthRestoreState,
  type ReturningSessionReason,
  type SessionRestoreRecord,
  type SyncedProvider,
} from './sessionMigration';

export type { AuthRestoreState } from './sessionMigration';

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
    | 'auth.session_expired'
    | 'auth.storage_unavailable';
  message: string;
}

/**
 * The on-device SQLite store could not be opened, migrated or read during
 * hydrate(). Local data (shots, kv) is unreachable for this launch; the
 * credential itself is unaffected — it lives in the Keychain. Restoring it
 * still requires a readable suppression/replacement gate; an unknown gate is
 * held for retry, never interpreted as a sign-out or an absent marker.
 */
export interface LocalDataError {
  code: 'local_data.unavailable';
  message: string;
}

export const LOCAL_DATA_UNAVAILABLE_MESSAGE =
  'Your saved data on this phone could not be opened. Your stored sign-in has not been removed; restart the app to try again.';

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

interface AuthState {
  hydrated: boolean;
  session: AuthSession | null;
  busy: boolean;
  error: AuthError | null;
  restoreState: AuthRestoreState;
  acknowledgeReturningSession: () => Promise<void>;
  retrySessionPersistence: () => Promise<void>;
  /** SQLite failed during the most recent hydrate(); null when local data opened. */
  localDataError: LocalDataError | null;
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
  completeAccountDeletion: (
    context?: AccountDeletionContext,
  ) => Promise<AccountDeletionCleanup | void>;
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

async function persistLocalGuest(enabled: boolean): Promise<boolean> {
  try {
    await setKv(getDb(), LOCAL_MODE_KV_KEY, enabled ? LOCAL_GUEST_VALUE : '');
    return true;
  } catch {
    // Guest mode remains in memory for this run. Synced identity material is
    // never sent to this fallback and is never persisted here.
    return false;
  }
}

/** Best-effort, like persistLocalGuest: clearing writes '' rather than
 * deleting so the same INSERT OR REPLACE path covers both states. */
async function persistLastProvider(
  provider: 'google' | null,
): Promise<boolean> {
  try {
    await setKv(
      getDb(),
      LAST_PROVIDER_KV_KEY,
      provider === 'google' ? LAST_PROVIDER_GOOGLE_VALUE : '',
    );
    return true;
  } catch {
    // Worst case the next launch simply asks for an explicit sign-in. No
    // identity material is at stake — this key only names a provider.
    return false;
  }
}

async function persistRestoreRecord(
  record: SessionRestoreRecord,
): Promise<boolean> {
  try {
    await setKv(getDb(), SESSION_RESTORE_KV_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

let authRevision = 0;
let sessionPersistence: Promise<unknown> = Promise.resolve();
let restorePersistence: Promise<unknown> = Promise.resolve();
let persistenceGeneration = 0;
let pendingSuppression: {
  record: SessionRestoreRecord;
  deletedOwner: string | undefined;
  generation: number | null;
} | null = null;
const sessionGenerations = new WeakMap<AuthSession, number>();
const unpreparedSessions = new WeakSet<AuthSession>();
const sessionPersistenceJobs = new WeakMap<
  ApiSession,
  {
    session: AuthSession;
    current: () => boolean;
    wait: Promise<void>;
  }
>();
const deletionGenerations = new WeakMap<
  AccountDeletionContext,
  number | null
>();
const STORAGE_WAIT_MS = 8_000;

function serializeSessionPersistence<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const next = sessionPersistence.then(operation);
  sessionPersistence = next.catch(() => {});
  return next;
}

function serializeRestorePersistence<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const next = restorePersistence.then(operation);
  restorePersistence = next.catch(() => {});
  return next;
}

function storageError(message: string): AuthError {
  return { code: 'auth.storage_unavailable', message };
}

async function waitForStorage<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Device storage is still busy.')),
          STORAGE_WAIT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function scrubLegacyIdentity(): Promise<boolean> {
  try {
    if (await getKv(getDb(), LEGACY_SESSION_KV_KEY)) {
      await setKv(getDb(), LEGACY_SESSION_KV_KEY, '');
    }
    return true;
  } catch {
    return false;
  }
}

function runtimeIsSignedOut(): boolean {
  return (
    getActiveDataOwner() === SIGNED_OUT_DATA_OWNER &&
    useAuthStore.getState().session === null &&
    getApiSession() === null
  );
}

async function clearSignedOutVault(
  deletedOwner?: string,
  record: SessionRestoreRecord = {
    version: 1,
    status: 'signed_out',
    reason: 'user_sign_out',
  },
  revision = authRevision,
  expectedGeneration: number | null = record.generation ?? null,
): Promise<boolean> {
  const marker: SessionRestoreRecord =
    expectedGeneration === null
      ? record
      : { ...record, generation: expectedGeneration };
  const suppression = {
    record: marker,
    deletedOwner,
    generation: expectedGeneration,
  };
  pendingSuppression = suppression;
  let markerDurable = false;
  let vaultCleared = false;
  let legacyRestoreDisarmed = false;
  const state = useAuthStore.getState().restoreState;
  const current = () =>
    runtimeIsSignedOut() && useAuthStore.getState().restoreState === state;
  const warning = storageError(
    'This device could not save the sign-out. Try signing out again before closing the app.',
  );
  const saveMarker = () =>
    serializeRestorePersistence(async () => {
      if (deletedOwner) {
        if (revision !== authRevision || !current()) return false;
        try {
          const previous = parseSessionRestoreRecord(
            await getKv(getDb(), SESSION_RESTORE_KV_KEY),
          );
          if (
            expectedGeneration === null ||
            (previous?.generation ?? 0) > expectedGeneration
          )
            return false;
        } catch {
          return false;
        }
      }
      const saved = await persistRestoreRecord(marker);
      markerDurable = saved;
      if (saved && pendingSuppression === suppression)
        pendingSuppression = null;
      if (saved) await scrubLegacyIdentity();
      const guestCleared = await persistLocalGuest(false);
      const providerCleared = await persistLastProvider(null);
      legacyRestoreDisarmed = guestCleared && providerCleared;
      return saved;
    });
  const saved = deletedOwner ? null : saveMarker();
  const cleanup = serializeSessionPersistence(async () => {
    const persisted = await readPersistedSession();
    if (persisted.status === 'available') {
      if (
        (expectedGeneration === null
          ? persisted.session.generation !== undefined
          : (persisted.session.generation ?? 0) > expectedGeneration) ||
        (deletedOwner &&
          (persisted.session.canonicalAppUserId !== deletedOwner ||
            (persisted.session.generation ?? 0) !== expectedGeneration))
      )
        return false;
    } else if (persisted.status !== 'empty' && deletedOwner) {
      return false;
    }
    const markerSaved = deletedOwner ? await saveMarker() : false;
    if (deletedOwner && !markerSaved) return false;
    vaultCleared = await clearPersistedSession();
    return vaultCleared || markerSaved;
  });
  const protectedSession = () =>
    markerDurable || (vaultCleared && legacyRestoreDisarmed);
  const operation = Promise.all([
    saved ?? Promise.resolve(false),
    cleanup,
  ]).then(() => {
    const protectedResult = protectedSession();
    if (protectedResult && pendingSuppression === suppression)
      pendingSuppression = null;
    if (current()) {
      if (!protectedResult) useAuthStore.setState({ error: warning });
      else if (useAuthStore.getState().error === warning)
        useAuthStore.setState({ error: null });
    }
    return protectedResult;
  });
  try {
    return await waitForStorage(operation);
  } catch {
    if (!protectedSession() && current())
      useAuthStore.setState({ error: warning });
    return protectedSession();
  }
}

async function requireReturningSession(
  reason: ReturningSessionReason,
  provider: SyncedProvider | null,
  revision: number,
  previous: SessionRestoreRecord | null = null,
): Promise<void> {
  const restoreState = returningSessionState(reason, provider, previous);
  const record: SessionRestoreRecord = {
    version: 1,
    ...restoreState,
    ...(previous?.generation === undefined
      ? {}
      : {
          generation:
            previous.status === 'replacing'
              ? previous.generation - 1
              : previous.generation,
        }),
  };
  let saved = false;
  try {
    saved = await waitForStorage(
      serializeRestorePersistence(async () => {
        if (revision !== authRevision || !runtimeIsSignedOut()) return false;
        const persisted = await persistRestoreRecord(record);
        if (persisted) await scrubLegacyIdentity();
        return persisted;
      }),
    );
  } catch {
    saved = false;
  }
  if (revision !== authRevision || !runtimeIsSignedOut()) return;
  useAuthStore.setState({
    session: null,
    hydrated: true,
    restoreState,
    ...(saved
      ? {}
      : {
          error: storageError(
            'This device could not save the returning sign-in notice. Try again before closing the app.',
          ),
        }),
  });
}

export function captureAccountDeletionContext(
  session: AuthSession | null = useAuthStore.getState().session,
): AccountDeletionContext {
  const context = captureDataOwnerContext();
  if (
    !session ||
    session.localOnly ||
    session.provider === 'guest' ||
    !session.canonicalAppUserId ||
    useAuthStore.getState().session !== session ||
    canonicalDataOwner(session.canonicalAppUserId) !== context.ownerKey
  ) {
    throw new DataOwnerChangedError();
  }
  const deletion = Object.freeze({ ...context, provider: session.provider });
  deletionGenerations.set(deletion, sessionGenerations.get(session) ?? null);
  return deletion;
}

function clearSyncedRuntime(): void {
  stopBillingLifecycle();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  clearAccessStoreConfiguration();
  clearTrainingStoreConfiguration();
  resetConsentStore();
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
  configureConsentStore(captureDataOwnerContext());
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
  startBillingLifecycle(canonicalAppUserId);
}

/** The Keychain record for a synced session — only when the server minted a
 * refresh token (a legacy provider-token session has nothing durable). */
async function persistSession(
  session: AuthSession,
  apiSession: ApiSession,
  context: DataOwnerContext = captureDataOwnerContext(),
  replacingCredential = false,
): Promise<void> {
  const { refreshToken, bearerToken } = apiSession;
  const { canonicalAppUserId } = session;
  if (!canonicalAppUserId || (!refreshToken && !replacingCredential)) return;
  let generation = sessionGenerations.get(session);
  const current = () =>
    isDataOwnerContextCurrent(context) &&
    useAuthStore.getState().session === session &&
    session.canonicalAppUserId === canonicalAppUserId &&
    getApiSession() === apiSession &&
    apiSession.canonicalAppUserId === canonicalAppUserId &&
    apiSession.provider === session.provider &&
    apiSession.refreshToken === refreshToken &&
    apiSession.bearerToken === bearerToken &&
    sessionGenerations.get(session) === generation;
  if (!current()) return;
  const pending = sessionPersistenceJobs.get(apiSession);
  if (pending?.session === session && pending.current()) return pending.wait;
  const priorError = useAuthStore.getState().error;
  const warning = storageError(
    'This device could not save your sign-in. Keep the app open and try again before closing it.',
  );
  const settleWarning = (saved: boolean) => {
    if (!current()) return;
    const error = useAuthStore.getState().error;
    if (
      error !== null &&
      error !== warning &&
      (error !== priorError || error.code !== 'auth.storage_unavailable')
    )
      return;
    if (saved) {
      if (error?.code === 'auth.storage_unavailable')
        useAuthStore.setState({ error: null });
    } else if (error !== warning) {
      useAuthStore.setState({ error: warning });
    }
  };
  const previousSuppression = pendingSuppression;
  const operation = serializeSessionPersistence(async () => {
    if (!current()) return false;
    const replacing = replacingCredential || generation === undefined;
    let prepared = false;
    if (replacing || unpreparedSessions.has(session)) {
      await restorePersistence;
      if (!current()) return false;
      const previous = parseSessionRestoreRecord(
        await getKv(getDb(), SESSION_RESTORE_KV_KEY),
      );
      const persisted = await readPersistedSession();
      if (!current()) return false;
      if (persisted.status === 'unavailable') return false;
      if (replacing) {
        const nextGeneration =
          Math.max(
            persistenceGeneration,
            previous?.generation ?? 0,
            persisted.status === 'available'
              ? (persisted.session.generation ?? 0)
              : 0,
          ) + 1;
        if (!Number.isSafeInteger(nextGeneration)) return false;
        generation = nextGeneration;
        persistenceGeneration = generation;
        sessionGenerations.set(session, generation);
        unpreparedSessions.add(session);
      }
      if (generation === undefined) return false;
      const marker: SessionRestoreRecord = refreshToken
        ? {
            version: 1,
            status: 'replacing',
            provider: apiSession.provider,
            generation,
          }
        : {
            version: 1,
            ...returningSessionState(
              'legacy_credentials_missing',
              apiSession.provider,
            ),
            generation: generation - 1,
          };
      prepared = await serializeRestorePersistence(async () => {
        if (!current()) return false;
        const saved = await persistRestoreRecord(marker);
        if (saved && pendingSuppression === previousSuppression)
          pendingSuppression = null;
        if (saved) await scrubLegacyIdentity();
        return saved;
      });
      if (!current()) return false;
      if (!prepared && !permitsPersistedSession(previous, generation)) {
        if (replacingCredential) await clearPersistedSession();
        return false;
      }
      unpreparedSessions.delete(session);
      if (!refreshToken) {
        const cleared = await clearPersistedSession();
        return prepared || cleared;
      }
    }
    if (!refreshToken || generation === undefined || !current()) return false;
    const saved = await savePersistedSession({
      version: 1,
      generation,
      provider: apiSession.provider,
      canonicalAppUserId,
      refreshToken,
      email: session.email,
      displayName: session.displayName,
    });
    if (saved && replacing && pendingSuppression === previousSuppression)
      pendingSuppression = null;
    if (!saved && replacingCredential && !prepared)
      await clearPersistedSession();
    if (saved && current()) {
      void serializeRestorePersistence(async () => {
        if (!current()) return;
        await persistRestoreRecord({
          version: 1,
          status: 'active',
          provider: apiSession.provider,
          generation,
        });
      });
    }
    return saved;
  })
    .catch(() => false)
    .then(saved => {
      settleWarning(saved);
      return saved;
    });
  const wait = waitForStorage(operation).then(
    () => {},
    () => settleWarning(false),
  );
  const job = { session, current, wait };
  sessionPersistenceJobs.set(apiSession, job);
  const release = () => {
    if (sessionPersistenceJobs.get(apiSession) === job)
      sessionPersistenceJobs.delete(apiSession);
  };
  void operation.then(release, release);
  return wait;
}

/**
 * The session died server-side (refresh token revoked or rotated away, or
 * the account is gone): the only implicit sign-out in the app. Everything
 * local is cleared, including the Google silent-restore flag — an explicit
 * sign-in is required to come back.
 */
async function dropRevokedSession(context: DataOwnerContext): Promise<void> {
  if (!isDataOwnerContextCurrent(context)) return;
  const revision = ++authRevision;
  const session = useAuthStore.getState().session;
  const provider = session?.provider;
  const generation = session ? (sessionGenerations.get(session) ?? null) : null;
  const restoreState = returningSessionState(
    'revoked',
    provider === 'apple' || provider === 'google' ? provider : null,
  );
  clearSyncedRuntime();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    session: null,
    hydrated: true,
    error: null,
    busy: false,
    restoreState,
  });
  await clearSignedOutVault(
    undefined,
    { version: 1, ...restoreState },
    revision,
    generation,
  );
}

/**
 * Applies rotated tokens for the signed-in account: updates the live
 * ApiSession (or installs the first one of this run when the launch refresh
 * only landed later), then re-persists the rotated refresh token. Ignored if
 * the account is no longer the signed-in one.
 */
function adoptRotatedTokens(
  session: AuthSession,
  context: DataOwnerContext,
  apiBaseUrl: string,
  tokens: RefreshedTokens,
): void {
  const canonicalAppUserId = session.canonicalAppUserId;
  if (
    !isDataOwnerContextCurrent(context) ||
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
  void persistSession(session, next, context);
}

type RestoreOutcome = 'online' | 'offline' | 'revoked';

function localDataUnavailable(): LocalDataError {
  return {
    code: 'local_data.unavailable',
    message: LOCAL_DATA_UNAVAILABLE_MESSAGE,
  };
}

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
  const context = captureDataOwnerContext();
  startSessionKeeper({
    apiBaseUrl: apiSession.apiBaseUrl,
    refreshToken: apiSession.refreshToken,
    bearerExpiresAtMs: apiSession.bearerExpiresAtMs ?? null,
    onRotated: tokens => {
      if (!isDataOwnerContextCurrent(context)) return;
      adoptRotatedTokens(session, context, apiSession.apiBaseUrl, tokens);
      useAuthStore.setState({
        restoreState: { status: 'restored', connectivity: 'online' },
      });
      onOutcome?.('online');
    },
    onRevoked: async () => {
      if (!isDataOwnerContextCurrent(context)) return;
      await dropRevokedSession(context);
      onOutcome?.('revoked');
    },
    onDeferred: () => {
      if (isDataOwnerContextCurrent(context)) onOutcome?.('offline');
    },
  });
}

async function establishSyncedAccount(
  input: {
    provider: 'apple' | 'google';
    identityToken: string | null | undefined;
    appleAuthorizationCode?: string | null;
    displayName: string | null;
    providerEmail: string | null;
  },
  revision = authRevision,
): Promise<AuthSession> {
  const config = getRuntimePublicConfig();
  const result = await bootstrapCanonicalAccount({
    apiBaseUrl: config.apiBaseUrl,
    bearerToken: input.identityToken,
    provider: input.provider,
    appleAuthorizationCode: input.appleAuthorizationCode,
    environment: getAccountBootstrapEnvironment(config),
  });
  if (revision !== authRevision) throw new DataOwnerChangedError();
  clearSyncedRuntime();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  installApiSession(result.apiSession);
  const session: AuthSession = {
    provider: input.provider,
    subject: result.account.id,
    canonicalAppUserId: result.account.id,
    localOnly: false,
    displayName: input.displayName,
    email: result.account.email ?? input.providerEmail,
  };
  useAuthStore.setState({ session });
  await persistSession(
    session,
    result.apiSession,
    captureDataOwnerContext(),
    true,
  );
  if (revision !== authRevision) throw new DataOwnerChangedError();
  await waitForStorage(
    serializeRestorePersistence(() => persistLocalGuest(false)),
  ).catch(() => {});
  if (revision !== authRevision) throw new DataOwnerChangedError();
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
  sessionGenerations.set(session, persisted.generation ?? 0);
  persistenceGeneration = Math.max(
    persistenceGeneration,
    persisted.generation ?? 0,
  );
  setActiveDataOwner(canonicalDataOwner(persisted.canonicalAppUserId));
  configureConsentStore(captureDataOwnerContext());
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
  revision = authRevision,
): Promise<AuthSession | null> {
  const { GoogleSignin } = await loadGoogleSignin();
  if (revision !== authRevision) throw new DataOwnerChangedError();
  GoogleSignin.configure({
    webClientId,
    ...(GOOGLE_IOS_CLIENT_ID ? { iosClientId: GOOGLE_IOS_CLIENT_ID } : {}),
  });
  if (!GoogleSignin.hasPreviousSignIn()) {
    return null;
  }
  const response = await GoogleSignin.signInSilently();
  if (revision !== authRevision) throw new DataOwnerChangedError();
  if (response.type !== 'success') {
    // 'noSavedCredentialFound' is definitive: the SDK holds no credential to
    // restore, so stop retrying on future launches until the next sign-in.
    await waitForStorage(
      serializeRestorePersistence(async () => {
        if (revision !== authRevision) return;
        const previous = parseSessionRestoreRecord(
          await getKv(getDb(), SESSION_RESTORE_KV_KEY),
        );
        if (revision !== authRevision) return;
        const saved = await persistRestoreRecord({
          version: 1,
          ...returningSessionState(
            'legacy_credentials_missing',
            'google',
            previous,
          ),
          ...(previous?.generation === undefined
            ? {}
            : { generation: previous.generation }),
        });
        if (saved) await persistLastProvider(null);
      }),
    ).catch(() => {});
    return null;
  }
  const idToken = response.data.idToken;
  if (!idToken) {
    // Signed in on the SDK side but no verifiable token for our backend.
    // Treat as transient and keep the flag for the next launch.
    return null;
  }
  return establishSyncedAccount(
    {
      provider: 'google',
      identityToken: idToken,
      displayName: response.data.user.name ?? null,
      providerEmail: response.data.user.email ?? null,
    },
    revision,
  );
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
    refreshSessionNow();
    return;
  }
  const revision = ++authRevision;
  clearSyncedRuntime();
  void (async () => {
    if (expired.provider === 'google' && GOOGLE_WEB_CLIENT_ID) {
      try {
        const session = await restoreGoogleSessionSilently(
          GOOGLE_WEB_CLIENT_ID,
          revision,
        );
        if (revision !== authRevision) return;
        if (session) {
          useAuthStore.setState({
            session,
            error: null,
            restoreState: { status: 'restored', connectivity: 'online' },
          });
          return;
        }
      } catch {
        // Fall through to the explicit re-sign-in below.
      }
      if (revision !== authRevision) return;
      clearSyncedRuntime();
    }
    if (revision !== authRevision) return;
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const restoreState = returningSessionState(
      'credentials_missing',
      expired.provider,
    );
    useAuthStore.setState({
      session: null,
      busy: false,
      restoreState,
      error: { code: 'auth.session_expired', message: SESSION_EXPIRED_MESSAGE },
    });
    await clearSignedOutVault(
      undefined,
      { version: 1, ...restoreState },
      revision,
      sessionGenerations.get(current) ?? null,
    );
  })();
}

export const useAuthStore = create<AuthState>((set, get) => ({
  hydrated: false,
  session: null,
  busy: false,
  error: null,
  localDataError: null,
  deletionCleanup: null,
  restoreState: { status: 'restoring' },

  hydrate: async () => {
    if (get().busy) return;
    const revision = ++authRevision;
    const previous = get();
    set({
      hydrated: false,
      error: null,
      localDataError: null,
      restoreState: { status: 'restoring' },
    });
    try {
      await waitForStorage(
        Promise.all([sessionPersistence, restorePersistence]),
      );
      if (revision !== authRevision) return;
      const suppression = pendingSuppression;
      if (suppression) {
        clearSyncedRuntime();
        setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
        set({ session: null });
        await clearSignedOutVault(
          suppression.deletedOwner,
          suppression.record,
          revision,
          suppression.generation,
        );
        if (revision !== authRevision) return;
        const record = suppression.record;
        set({
          hydrated: true,
          session: null,
          restoreState:
            record.status === 'signed_out'
              ? { status: 'signed_out', reason: record.reason }
              : record.status === 'reauth_required'
                ? returningSessionState(record.reason, record.provider, record)
                : {
                    status: 'unavailable',
                    reason: 'local_storage_unavailable',
                  },
        });
        return;
      }
      // Read the durable credential first, without consulting a provider SDK.
      // SQLite data failures do not revoke it. The restore marker is a separate
      // safety gate: unreadable is not absent, and cannot resurrect a suppressed
      // or replaced credential. Leave an already-live session intact on failure.
      const persisted = await waitForStorage(readPersistedSession()).catch(
        () => ({ status: 'unavailable' as const }),
      );
      if (revision !== authRevision) return;
      const db: LocalDb = getDb();
      let restoreRecord = parseSessionRestoreRecord(
        await waitForStorage(getKv(db, SESSION_RESTORE_KV_KEY)),
      );
      if (revision !== authRevision) return;
      persistenceGeneration = Math.max(
        persistenceGeneration,
        restoreRecord?.generation ?? 0,
        persisted.status === 'available'
          ? (persisted.session.generation ?? 0)
          : 0,
      );
      clearSyncedRuntime();
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      set({ session: null });
      let legacy: string | null = null;
      let raw: string | null = null;
      try {
        // Earlier builds wrote provider subjects to SQLite. Blank that legacy
        // value during migration instead of hydrating it into a trusted session.
        legacy = await waitForStorage(getKv(db, LEGACY_SESSION_KV_KEY));
        if (revision !== authRevision) return;
        if (legacy) {
          if (!restoreRecord) {
            const hint: SessionRestoreRecord = {
              version: 1,
              ...returningSessionState('legacy_credentials_missing', null),
            };
            const saved = await waitForStorage(
              serializeRestorePersistence(async () => {
                if (revision !== authRevision) return false;
                return persistRestoreRecord(hint);
              }),
            );
            if (revision !== authRevision) return;
            if (!saved)
              throw new Error('The returning sign-in hint could not be saved.');
            restoreRecord = hint;
          }
          const scrubbed = await waitForStorage(
            serializeRestorePersistence(scrubLegacyIdentity),
          );
          if (revision !== authRevision) return;
          if (!scrubbed)
            set({
              localDataError: localDataUnavailable(),
              error: storageError(
                'This device could not remove old sign-in details. Try again.',
              ),
            });
        }
      } catch {
        if (revision !== authRevision) return;
        set({ localDataError: localDataUnavailable() });
      }
      try {
        const localMode = await waitForStorage(
          db.execute('SELECT value FROM kv WHERE key = ?', [LOCAL_MODE_KV_KEY]),
        );
        if (revision !== authRevision) return;
        raw =
          typeof localMode.rows[0]?.['value'] === 'string'
            ? localMode.rows[0]['value']
            : null;
      } catch {
        if (revision !== authRevision) return;
        set({ localDataError: localDataUnavailable() });
      }
      if (raw === LOCAL_GUEST_VALUE && !restoreRecord) {
        setActiveDataOwner(GUEST_DATA_OWNER);
        set({
          session: localGuestSession(),
          hydrated: true,
          restoreState: { status: 'guest' },
        });
        return;
      }
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      if (
        persisted.status === 'available' &&
        permitsPersistedSession(restoreRecord, persisted.session.generation)
      ) {
        const outcome = await restorePersistedSession(persisted.session);
        if (revision !== authRevision) return;
        if (outcome !== 'revoked') {
          set({
            hydrated: true,
            restoreState: { status: 'restored', connectivity: outcome },
          });
        }
        return;
      }
      if (restoreRecord?.status === 'signed_out') {
        set({
          hydrated: true,
          restoreState: { status: 'signed_out', reason: restoreRecord.reason },
        });
        await clearSignedOutVault(
          undefined,
          restoreRecord,
          revision,
          restoreRecord.generation ?? null,
        );
        return;
      }
      if (
        restoreRecord?.status === 'reauth_required' &&
        restoreRecord.reason !== 'legacy_credentials_missing'
      ) {
        set({
          hydrated: true,
          restoreState: returningSessionState(
            restoreRecord.reason,
            restoreRecord.provider,
            restoreRecord,
          ),
        });
        await clearSignedOutVault(
          undefined,
          restoreRecord,
          revision,
          restoreRecord.generation ?? null,
        );
        return;
      }
      if (restoreRecord?.status === 'guest') {
        setActiveDataOwner(GUEST_DATA_OWNER);
        set({
          session: localGuestSession(),
          hydrated: true,
          restoreState: { status: 'guest' },
        });
        return;
      }
      if (persisted.status !== 'empty' && persisted.status !== 'available') {
        set({
          hydrated: true,
          restoreState: {
            status: 'unavailable',
            reason: `vault_${persisted.status}`,
          },
        });
        return;
      }
      if (
        restoreRecord?.status === 'active' ||
        restoreRecord?.status === 'replacing'
      ) {
        await requireReturningSession(
          'credentials_missing',
          restoreRecord.provider,
          revision,
          restoreRecord,
        );
        return;
      }
      // Legacy fallback for devices that signed in before sessions were
      // persisted: silent restore is Google-only (see
      // restoreGoogleSessionSilently for why Apple cannot have one) and only
      // worth attempting when the web client id needed for a
      // backend-verifiable token is configured. A success bootstraps a new
      // session, which IS persisted — so this path runs at most once.
      let lastProvider: string | null = null;
      try {
        lastProvider = await waitForStorage(getKv(db, LAST_PROVIDER_KV_KEY));
      } catch {
        if (revision !== authRevision) return;
        set({ localDataError: localDataUnavailable() });
      }
      if (revision !== authRevision) return;
      if (lastProvider === LAST_PROVIDER_GOOGLE_VALUE && GOOGLE_WEB_CLIENT_ID) {
        try {
          const session = await restoreGoogleSessionSilently(
            GOOGLE_WEB_CLIENT_ID,
            revision,
          );
          if (revision !== authRevision) return;
          if (session) {
            set({
              session,
              hydrated: true,
              restoreState: { status: 'restored', connectivity: 'online' },
            });
            return;
          }
        } catch (error) {
          // Opportunistic restore only: offline bootstrap or SDK failures
          // land signed-out with no surfaced error. The last-provider flag is
          // kept so the next launch retries silently.
          if (revision !== authRevision) return;
          clearSyncedRuntime();
          setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
          if (error instanceof AccountBootstrapError && !error.retryable) {
            await requireReturningSession(
              'legacy_credentials_missing',
              'google',
              revision,
              restoreRecord,
            );
            return;
          }
          set({
            session: null,
            hydrated: true,
            restoreState: {
              status: 'unavailable',
              reason: 'legacy_restore_unavailable',
            },
          });
          return;
        }
      }
      let returning =
        Boolean(legacy) ||
        raw === '' ||
        lastProvider === LAST_PROVIDER_GOOGLE_VALUE ||
        restoreRecord?.status === 'reauth_required';
      if (!returning) {
        const profiles = await waitForStorage(
          db.execute(
            "SELECT 1 AS present FROM kv WHERE key GLOB 'profile:????????-????-????-????-????????????' AND value <> '' LIMIT 1",
          ),
        );
        if (revision !== authRevision) return;
        returning = profiles.rows.length > 0;
      }
      if (returning) {
        await requireReturningSession(
          'legacy_credentials_missing',
          lastProvider === LAST_PROVIDER_GOOGLE_VALUE
            ? 'google'
            : restoreRecord?.status === 'reauth_required'
              ? restoreRecord.provider
              : null,
          revision,
          restoreRecord,
        );
        return;
      }
      set({
        session: null,
        hydrated: true,
        restoreState: get().localDataError
          ? { status: 'unavailable', reason: 'local_storage_unavailable' }
          : { status: 'signed_out', reason: 'new_install' },
      });
    } catch {
      if (revision !== authRevision) return;
      const session = get().session;
      set({
        hydrated: true,
        localDataError: localDataUnavailable(),
        restoreState: session
          ? session.localOnly
            ? { status: 'guest' }
            : previous.session === session &&
                previous.restoreState.status === 'restored'
              ? previous.restoreState
              : { status: 'restored', connectivity: 'offline' }
          : { status: 'unavailable', reason: 'local_storage_unavailable' },
        error: storageError(
          'This device could not read or save sign-in state. Try again.',
        ),
      });
    }
  },

  retrySessionPersistence: async () => {
    const session = get().session;
    const apiSession = getApiSession();
    if (
      !session ||
      session.localOnly ||
      session.provider === 'guest' ||
      !session.canonicalAppUserId ||
      !apiSession?.refreshToken?.trim() ||
      apiSession.canonicalAppUserId !== session.canonicalAppUserId ||
      apiSession.provider !== session.provider
    )
      return;
    let context: DataOwnerContext;
    try {
      context = captureDataOwnerContext();
      if (context.ownerKey !== canonicalDataOwner(session.canonicalAppUserId))
        return;
    } catch {
      return;
    }
    await persistSession(session, apiSession, context);
  },

  acknowledgeReturningSession: async () => {
    const current = get().restoreState;
    if (current.status !== 'reauth_required' || !current.noticePending) return;
    const ownsNotice = () =>
      get().restoreState === current && runtimeIsSignedOut();
    const restoreState = { ...current, noticePending: false };
    const warning = storageError(
      'This device could not save your acknowledgement. Try again.',
    );
    const suppression = pendingSuppression;
    const pendingRecord = suppression?.record;
    const pendingNotice =
      pendingRecord?.status === 'reauth_required' &&
      pendingRecord.reason === current.reason &&
      pendingRecord.provider === current.provider
        ? pendingRecord
        : null;
    const operation = serializeRestorePersistence(async () => {
      if (!ownsNotice()) return;
      const previous = parseSessionRestoreRecord(
        await getKv(getDb(), SESSION_RESTORE_KV_KEY),
      );
      if (!ownsNotice()) return;
      if (previous && previous.status !== 'reauth_required' && !pendingNotice) {
        set({ error: warning });
        return;
      }
      const saved = await persistRestoreRecord({
        ...(pendingNotice ?? previous),
        version: 1,
        ...restoreState,
      });
      if (saved && pendingNotice && pendingSuppression === suppression)
        pendingSuppression = null;
      if (!ownsNotice()) return;
      if (!saved) {
        set({ error: warning });
        return;
      }
      set({
        restoreState,
        ...(get().error?.code === 'auth.storage_unavailable'
          ? { error: null }
          : {}),
      });
    }).catch(() => {
      if (ownsNotice()) set({ error: warning });
    });
    try {
      await waitForStorage(operation);
    } catch {
      if (ownsNotice()) set({ error: warning });
    }
  },

  signInWithApple: async () => {
    if (get().busy) return;
    const revision = ++authRevision;
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
      if (revision !== authRevision) return;
      const name =
        [result.givenName, result.familyName].filter(Boolean).join(' ') || null;
      const session = await establishSyncedAccount(
        {
          provider: 'apple',
          identityToken: result.identityToken,
          appleAuthorizationCode: result.authorizationCode,
          displayName: name,
          providerEmail: result.email ?? null,
        },
        revision,
      );
      if (revision !== authRevision) return;
      // A stale Google flag (e.g. after a failed silent restore) must never
      // resurrect the previous Google account over this Apple session on the
      // next launch. Apple itself gets no silent-restore flag — its identity
      // tokens are only issued interactively.
      await waitForStorage(
        serializeRestorePersistence(async () => {
          if (revision !== authRevision) return false;
          return persistLastProvider(null);
        }),
      ).catch(() => false);
      if (revision !== authRevision) return;
      set({
        session,
        busy: false,
        hydrated: true,
        restoreState: { status: 'restored', connectivity: 'online' },
      });
    } catch (error) {
      if (revision !== authRevision) return;
      set({ busy: false, error: toAuthError(error) });
    }
  },

  signInWithGoogle: async () => {
    if (get().busy) return;
    const revision = ++authRevision;
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
      if (revision !== authRevision) return;
      GoogleSignin.configure({
        webClientId: GOOGLE_WEB_CLIENT_ID,
        ...(GOOGLE_IOS_CLIENT_ID ? { iosClientId: GOOGLE_IOS_CLIENT_ID } : {}),
      });
      await GoogleSignin.hasPlayServices({
        showPlayServicesUpdateDialog: false,
      });
      if (revision !== authRevision) return;
      const response = await GoogleSignin.signIn();
      if (revision !== authRevision) return;
      if (response.type !== 'success') {
        set({
          busy: false,
          error: { code: 'auth.canceled', message: 'Sign-in canceled.' },
        });
        return;
      }
      const user = response.data.user;
      const session = await establishSyncedAccount(
        {
          provider: 'google',
          identityToken: response.data.idToken,
          displayName: user.name ?? null,
          providerEmail: user.email ?? null,
        },
        revision,
      );
      if (revision !== authRevision) return;
      // Only after the canonical account is established: the next launch may
      // now silently restore this Google session (provider name only — the
      // token itself is never persisted).
      await waitForStorage(
        serializeRestorePersistence(async () => {
          if (revision !== authRevision) return false;
          return persistLastProvider('google');
        }),
      ).catch(() => false);
      if (revision !== authRevision) return;
      set({
        session,
        busy: false,
        hydrated: true,
        restoreState: { status: 'restored', connectivity: 'online' },
      });
    } catch (error) {
      if (revision !== authRevision) return;
      set({ busy: false, error: toAuthError(error) });
    }
  },

  continueAsGuest: async () => {
    ++authRevision;
    const previous = get().session;
    const generation = previous ? sessionGenerations.get(previous) : undefined;
    clearSyncedRuntime();
    const session = localGuestSession();
    setActiveDataOwner(GUEST_DATA_OWNER);
    const context = captureDataOwnerContext();
    const current = () =>
      isDataOwnerContextCurrent(context) && get().session === session;
    const warning = storageError(
      'This device could not save local mode. Try again before closing the app.',
    );
    set({
      session,
      hydrated: true,
      busy: false,
      error: null,
      restoreState: { status: 'guest' },
    });
    let durable = false;
    const previousSuppression = pendingSuppression;
    const operation = serializeRestorePersistence(async () => {
      if (!current()) return;
      const saved = await persistRestoreRecord({
        version: 1,
        status: 'guest',
        generation,
      });
      durable = saved;
      if (saved && pendingSuppression === previousSuppression)
        pendingSuppression = null;
      await persistLocalGuest(true);
      if (saved) await scrubLegacyIdentity();
      if (current()) {
        if (!saved) set({ error: warning });
        else if (get().error === warning) set({ error: null });
      }
    });
    try {
      await waitForStorage(operation);
    } catch {
      if (!durable && current()) set({ error: warning });
    }
  },

  signOut: async () => {
    const revision = ++authRevision;
    const session = get().session;
    const provider = session?.provider;
    const generation = session
      ? (sessionGenerations.get(session) ?? null)
      : null;
    const apiSession = getApiSession();
    clearSyncedRuntime();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    set({
      session: null,
      hydrated: true,
      error: null,
      busy: true,
      restoreState: { status: 'signed_out', reason: 'user_sign_out' },
    });
    // The persisted session goes first: whatever else fails below, the next
    // launch must not restore an account the user just signed out of.
    await clearSignedOutVault(undefined, undefined, revision, generation);
    if (revision !== authRevision) return;
    // Explicit sign-out always disarms the silent restore on the next launch.
    // Kill this device's session server-side too (best effort — offline, the
    // refresh token still dies at its natural rotation/expiry).
    const revoked = apiSession?.refreshToken
      ? revokeApiSession(apiSession)
      : Promise.resolve();
    if (provider === 'google') {
      try {
        const { GoogleSignin } = await loadGoogleSignin();
        if (revision !== authRevision || !runtimeIsSignedOut()) return;
        await GoogleSignin.signOut();
      } catch {
        // Local API and billing material is already gone. Provider SDK cleanup
        // can safely be retried on the next interactive sign-in.
      }
    }
    if (revision === authRevision && runtimeIsSignedOut()) set({ busy: false });
    await revoked;
  },

  completeAccountDeletion: async explicitContext => {
    const session = get().session;
    const context = explicitContext ?? null;
    const provider = context?.provider ?? session?.provider;
    const deletedOwner = context
      ? canonicalDataOwner(context.ownerKey)
      : session?.canonicalAppUserId
        ? canonicalDataOwner(session.canonicalAppUserId)
        : null;
    const ownsDeletedRuntime = Boolean(
      deletedOwner &&
      session?.canonicalAppUserId &&
      canonicalDataOwner(session.canonicalAppUserId) === deletedOwner &&
      (!context || isDataOwnerContextCurrent(context)),
    );
    let canClearRuntime = Boolean(
      !explicitContext || (context && isDataOwnerContextCurrent(context)),
    );
    if (
      !canClearRuntime &&
      context &&
      runtimeIsSignedOut() &&
      get().hydrated &&
      !get().busy
    ) {
      const startingRevision = authRevision;
      const generation = deletionGenerations.get(context) ?? 0;
      try {
        const persisted = await waitForStorage(
          serializeSessionPersistence(readPersistedSession),
        );
        const previous = parseSessionRestoreRecord(
          await waitForStorage(getKv(getDb(), SESSION_RESTORE_KV_KEY)),
        );
        canClearRuntime =
          startingRevision === authRevision &&
          runtimeIsSignedOut() &&
          !get().busy &&
          (previous?.generation ?? 0) <= generation &&
          (persisted.status === 'empty' ||
            (persisted.status === 'available' &&
              persisted.session.canonicalAppUserId === deletedOwner &&
              (persisted.session.generation ?? 0) === generation));
      } catch {
        canClearRuntime = false;
      }
    }
    const revision = canClearRuntime ? ++authRevision : null;
    const canFinishCleanup = () =>
      revision !== null && revision === authRevision && runtimeIsSignedOut();
    if (canClearRuntime) {
      clearSyncedRuntime();
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      set({
        session: null,
        hydrated: true,
        error: null,
        busy: true,
        deletionCleanup: null,
        restoreState: { status: 'signed_out', reason: 'account_deleted' },
      });
    }
    // The account (and every server-side session) is already gone; the
    // Keychain record must go with it or the next launch would try — and
    // fail — to refresh a deleted account.
    let clearedCredentials = false;
    if (canFinishCleanup()) {
      clearedCredentials = await clearSignedOutVault(
        ownsDeletedRuntime ? undefined : (deletedOwner ?? undefined),
        { version: 1, status: 'signed_out', reason: 'account_deleted' },
        revision ?? authRevision,
        ownsDeletedRuntime && session
          ? (sessionGenerations.get(session) ?? null)
          : context
            ? (deletionGenerations.get(context) ?? 0)
            : null,
      );
      if (clearedCredentials && canFinishCleanup()) {
        set({
          restoreState: { status: 'signed_out', reason: 'account_deleted' },
        });
      }
    }
    let localPurge: AccountDeletionCleanup['localPurge'] = 'not_needed';
    if (deletedOwner) {
      discardPendingFulfilmentForOwner(deletedOwner);
      localPurge = 'failed';
      for (let attempt = 0; attempt < LOCAL_PURGE_ATTEMPTS; attempt += 1) {
        try {
          await waitForStorage(purgeOwnerData(getDb(), deletedOwner));
          localPurge = 'complete';
          break;
        } catch {
          // Retried below; the caller is told if every attempt fails.
        }
      }
    }
    if (provider === 'google' && clearedCredentials && canFinishCleanup()) {
      try {
        const { GoogleSignin } = await loadGoogleSignin();
        // Full disconnect: the account no longer exists, so the SDK must not
        // silently restore it on the next launch.
        if (canFinishCleanup()) await GoogleSignin.revokeAccess();
        if (canFinishCleanup()) await GoogleSignin.signOut();
      } catch {
        // Best effort; the silent-restore flag is already cleared above.
      }
    }
    const cleanup = { localPurge };
    if (canFinishCleanup()) set({ deletionCleanup: cleanup, busy: false });
    return explicitContext ? cleanup : undefined;
  },

  clearError: () => set({ error: null }),
}));
