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
const STORAGE_ATTEMPTS = 3;
let operations: Promise<unknown> = Promise.resolve();

export class SessionVaultUnavailableError extends Error {
  constructor() {
    super('Secure sign-in storage is temporarily unavailable.');
    this.name = 'SessionVaultUnavailableError';
  }
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = operations.then(operation, operation);
  operations = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export interface PersistedSession {
  version: 1;
  provider: 'apple' | 'google';
  canonicalAppUserId: string;
  refreshToken: string;
  email: string | null;
  displayName: string | null;
}

export interface PersistedLogoutIntent {
  version: 1;
  signedOut: true;
  guest: boolean;
}

type KeychainModule = typeof import('react-native-keychain');

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

/** Returns whether the session is now durably stored. */
export async function savePersistedSession(
  session: PersistedSession,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  return serialize(async () => {
    const keychain = loadKeychain();
    return keychain ? writeSessionRecord(keychain, session, isCurrent) : false;
  });
}

async function writeSessionRecord(
  keychain: KeychainModule,
  session: PersistedSession | PersistedLogoutIntent,
  isCurrent: () => boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < STORAGE_ATTEMPTS; attempt += 1) {
    if (!isCurrent()) return false;
    try {
      const result = await keychain.setGenericPassword(
        SESSION_VAULT_ACCOUNT,
        JSON.stringify(session),
        {
          service: SESSION_VAULT_SERVICE,
          accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        },
      );
      if (result !== false) return isCurrent();
    } catch {
      continue;
    }
  }
  return false;
}

/** Null when nothing is stored, the item is unreadable, or it is malformed —
 * a malformed item is discarded rather than trusted. */
export async function loadPersistedSession(
  options: { requireAvailable?: boolean } = {},
): Promise<PersistedSession | null> {
  const record = await loadSessionVault(options);
  return record && !('signedOut' in record) ? record : null;
}

export async function loadSessionVault(
  options: { requireAvailable?: boolean } = {},
): Promise<PersistedSession | PersistedLogoutIntent | null> {
  return serialize(async () => {
    const keychain = loadKeychain();
    if (keychain) {
      for (let attempt = 0; attempt < STORAGE_ATTEMPTS; attempt += 1) {
        try {
          const stored = await keychain.getGenericPassword({
            service: SESSION_VAULT_SERVICE,
          });
          if (!stored) return null;
          for (const guest of [false, true]) {
            const intent: PersistedLogoutIntent = {
              version: 1,
              signedOut: true,
              guest,
            };
            if (stored.password === JSON.stringify(intent)) return intent;
          }
          const session = parsePersistedSession(stored.password);
          if (!session && !(await resetPersistedSession(keychain))) break;
          return session;
        } catch {
          continue;
        }
      }
    }
    if (options.requireAvailable) throw new SessionVaultUnavailableError();
    return null;
  });
}

export async function clearPersistedSession(): Promise<boolean> {
  return serialize(async () => {
    const keychain = loadKeychain();
    return keychain ? resetPersistedSession(keychain) : false;
  });
}

export async function clearSessionForLogout(
  guest: boolean,
  logoutMarked: Promise<boolean>,
): Promise<{ cleared: boolean; vaultMarked: boolean }> {
  return serialize(async () => {
    const keychain = loadKeychain();
    if (!keychain) return { cleared: false, vaultMarked: false };
    const cleared = await resetPersistedSession(keychain);
    const vaultMarked =
      !(await logoutMarked.catch(() => false)) &&
      (await writeSessionRecord(
        keychain,
        { version: 1, signedOut: true, guest },
        () => true,
      ));
    return { cleared, vaultMarked };
  });
}

async function resetPersistedSession(
  keychain: KeychainModule,
): Promise<boolean> {
  for (let attempt = 0; attempt < STORAGE_ATTEMPTS; attempt += 1) {
    try {
      const result = await keychain.resetGenericPassword({
        service: SESSION_VAULT_SERVICE,
      });
      if (
        result !== false ||
        !(await keychain.getGenericPassword({ service: SESSION_VAULT_SERVICE }))
      ) {
        return true;
      }
    } catch {
      // Nothing else to do: a stale item is harmless until the next sign-in
      // overwrites it, and the server-side session is revoked independently.
    }
  }
  return false;
}
