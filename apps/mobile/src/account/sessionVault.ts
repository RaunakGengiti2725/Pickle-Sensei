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
 * for this run — never to a crash. `savePersistedSession` reports whether the
 * write took, so the caller (authStore) can keep the record and try again
 * later rather than let a one-off Keychain error cost the durable sign-in.
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
): Promise<boolean> {
  const keychain = loadKeychain();
  if (!keychain) return false;
  try {
    const result = await keychain.setGenericPassword(
      SESSION_VAULT_ACCOUNT,
      JSON.stringify(session),
      {
        service: SESSION_VAULT_SERVICE,
        accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      },
    );
    return result !== false;
  } catch {
    return false;
  }
}

/** Null when nothing is stored, the item is unreadable, or it is malformed —
 * a malformed item is discarded rather than trusted. */
export async function loadPersistedSession(): Promise<PersistedSession | null> {
  const keychain = loadKeychain();
  if (!keychain) return null;
  try {
    const stored = await keychain.getGenericPassword({
      service: SESSION_VAULT_SERVICE,
    });
    if (!stored) return null;
    const session = parsePersistedSession(stored.password);
    if (!session) await clearPersistedSession();
    return session;
  } catch {
    return null;
  }
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
