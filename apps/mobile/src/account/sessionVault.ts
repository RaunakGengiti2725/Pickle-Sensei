/**
 * Durable home of the signed-in session: the device Keychain (iOS) /
 * Keystore-backed storage (Android) via react-native-keychain.
 *
 * What lives here is exactly what a relaunch needs to come back signed in
 * without the user doing anything: the refresh token plus the UI-safe account
 * descriptor. The ACCESS token is deliberately NOT stored (it is re-minted by
 * `/v1/auth/refresh` at launch), and nothing here ever goes to SQLite,
 * AsyncStorage or logs. The item is `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: it
 * is readable once the phone has been unlocked since boot (so a background
 * relaunch can refresh) and never leaves this device through backups or
 * Keychain sync.
 *
 * No operation crashes the app, but Keychain FAULTS are not folded into the
 * "nothing stored" outcome: a write that fails after a retry reports false so
 * the caller can tell the user the sign-in will not survive a relaunch, and a
 * read that fails after a retry throws `SessionVaultReadError` so a launch
 * can keep the record and surface the problem instead of settling signed-out
 * as if the user had never signed in. Only a build without the native module
 * degrades to "nothing persisted".
 */

export const SESSION_VAULT_SERVICE = 'com.picklesensei.auth.session';
const SESSION_VAULT_ACCOUNT = 'session';

export interface PersistedSession {
  version: 1;
  provider: 'apple' | 'google';
  canonicalAppUserId: string;
  refreshToken: string;
  email: string | null;
  displayName: string | null;
}

type KeychainModule = typeof import('react-native-keychain');

/** Transient Keychain faults (e.g. errSecInteractionNotAllowed before the
 * first unlock, errSecIO) get exactly one immediate retry. */
const KEYCHAIN_ATTEMPTS = 2;

/** The Keychain item could not be READ — distinct from "no item stored".
 * The record is left in place for the next launch to retry. */
export class SessionVaultReadError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error && cause.message
        ? `Keychain read failed: ${cause.message}`
        : 'Keychain read failed.',
    );
    this.name = 'SessionVaultReadError';
  }
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < KEYCHAIN_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Loaded lazily like the Google SDK: launches never pay the import cost
 * before they need it, and a build missing the native module fails only
 * inside these guarded paths. jest's CommonJS transform cannot execute a
 * literal dynamic import(), hence require. */
function loadKeychain(): KeychainModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-keychain') as KeychainModule;
  } catch {
    return null;
  }
}

function parsePersistedSession(raw: string): PersistedSession | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const provider = record['provider'];
    const canonicalAppUserId = record['canonicalAppUserId'];
    const refreshToken = record['refreshToken'];
    if (
      record['version'] !== 1 ||
      (provider !== 'apple' && provider !== 'google') ||
      typeof canonicalAppUserId !== 'string' ||
      !canonicalAppUserId ||
      typeof refreshToken !== 'string' ||
      !refreshToken
    ) {
      return null;
    }
    return {
      version: 1,
      provider,
      canonicalAppUserId,
      refreshToken,
      email: typeof record['email'] === 'string' ? record['email'] : null,
      displayName:
        typeof record['displayName'] === 'string'
          ? record['displayName']
          : null,
    };
  } catch {
    return null;
  }
}

/** Returns whether the session is now durably stored. False means the
 * caller must not report a durable sign-in. */
export async function savePersistedSession(
  session: PersistedSession,
): Promise<boolean> {
  const keychain = loadKeychain();
  if (!keychain) return false;
  try {
    const result = await withRetry(() =>
      keychain.setGenericPassword(
        SESSION_VAULT_ACCOUNT,
        JSON.stringify(session),
        {
          service: SESSION_VAULT_SERVICE,
          accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        },
      ),
    );
    return result !== false;
  } catch {
    return false;
  }
}

/** Null when nothing is stored or the item is malformed — a malformed item
 * is discarded rather than trusted. Throws `SessionVaultReadError` when the
 * Keychain itself could not be read; the item is kept. */
export async function loadPersistedSession(): Promise<PersistedSession | null> {
  const keychain = loadKeychain();
  if (!keychain) return null;
  let stored: Awaited<ReturnType<KeychainModule['getGenericPassword']>>;
  try {
    stored = await withRetry(() =>
      keychain.getGenericPassword({ service: SESSION_VAULT_SERVICE }),
    );
  } catch (error) {
    throw new SessionVaultReadError(error);
  }
  if (!stored) return null;
  const session = parsePersistedSession(stored.password);
  if (!session) await clearPersistedSession();
  return session;
}

export async function clearPersistedSession(): Promise<void> {
  const keychain = loadKeychain();
  if (!keychain) return;
  try {
    await keychain.resetGenericPassword({ service: SESSION_VAULT_SERVICE });
  } catch {
    // Nothing else to do: a stale item is harmless until the next sign-in
    // overwrites it, and the server-side session is revoked independently.
  }
}
