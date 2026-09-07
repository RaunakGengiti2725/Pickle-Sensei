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
 * Every operation fails soft: a build without the native module, or a
 * Keychain error, degrades to "nothing persisted" — the user stays signed in
 * for this run and is asked again next launch — never to a crash.
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
  generation?: number;
}

export type PersistedSessionRead =
  | { status: 'available'; session: PersistedSession }
  | { status: 'empty' | 'unavailable' | 'invalid' | 'unsupported' };

const CANONICAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type KeychainModule = typeof import('react-native-keychain');

let vaultMutations: Promise<unknown> = Promise.resolve();

function serializeVaultMutation<T>(operation: () => Promise<T>): Promise<T> {
  const next = vaultMutations.then(operation);
  vaultMutations = next.catch(() => {});
  return next;
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
    const generation = record['generation'];
    if (
      (generation !== undefined &&
        (typeof generation !== 'number' ||
          !Number.isSafeInteger(generation) ||
          generation < 0)) ||
      record['version'] !== 1 ||
      (provider !== 'apple' && provider !== 'google') ||
      typeof canonicalAppUserId !== 'string' ||
      !CANONICAL_ID_PATTERN.test(canonicalAppUserId.trim()) ||
      typeof refreshToken !== 'string' ||
      !refreshToken.trim()
    ) {
      return null;
    }
    return {
      version: 1,
      ...(generation === undefined ? {} : { generation }),
      provider,
      canonicalAppUserId: canonicalAppUserId.trim().toLowerCase(),
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

/** Returns whether the session is now durably stored. */
export async function savePersistedSession(
  session: PersistedSession,
): Promise<boolean> {
  return serializeVaultMutation(async () => {
    const keychain = loadKeychain();
    if (!keychain) return false;
    const password = JSON.stringify(session);
    let acknowledged: boolean;
    try {
      const result = await keychain.setGenericPassword(
        SESSION_VAULT_ACCOUNT,
        password,
        {
          service: SESSION_VAULT_SERVICE,
          accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        },
      );
      acknowledged = result !== false;
    } catch {
      acknowledged = false;
    }
    if (acknowledged) return true;
    try {
      const stored = await keychain.getGenericPassword({
        service: SESSION_VAULT_SERVICE,
      });
      return stored !== false && stored.password === password;
    } catch {
      return false;
    }
  });
}

/** Null when nothing is stored, the item is unreadable, or it is malformed —
 * a malformed item is discarded rather than trusted. */
export async function loadPersistedSession(): Promise<PersistedSession | null> {
  return serializeVaultMutation(async () => {
    const result = await readPersistedSession();
    if (result.status === 'invalid') await resetPersistedSession();
    return result.status === 'available' ? result.session : null;
  });
}

export async function readPersistedSession(): Promise<PersistedSessionRead> {
  const keychain = loadKeychain();
  if (!keychain) return { status: 'unavailable' };
  let stored: Awaited<ReturnType<KeychainModule['getGenericPassword']>>;
  try {
    stored = await keychain.getGenericPassword({
      service: SESSION_VAULT_SERVICE,
    });
  } catch {
    return { status: 'unavailable' };
  }
  if (!stored) return { status: 'empty' };
  try {
    const value: unknown = JSON.parse(stored.password);
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>)['version'] === 'number' &&
      (value as Record<string, unknown>)['version'] !== 1
    ) {
      return { status: 'unsupported' };
    }
  } catch {
    return { status: 'invalid' };
  }
  const session = parsePersistedSession(stored.password);
  return session ? { status: 'available', session } : { status: 'invalid' };
}

export async function clearPersistedSession(): Promise<boolean> {
  return serializeVaultMutation(resetPersistedSession);
}

async function resetPersistedSession(): Promise<boolean> {
  const keychain = loadKeychain();
  if (!keychain) return false;
  try {
    const reset = await keychain.resetGenericPassword({
      service: SESSION_VAULT_SERVICE,
    });
    return reset || (await readPersistedSession()).status === 'empty';
  } catch {
    // Nothing else to do: a stale item is harmless until the next sign-in
    // overwrites it, and the server-side session is revoked independently.
    return false;
  }
}
