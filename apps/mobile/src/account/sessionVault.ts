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
 * No operation throws: a build without the native module, or a Keychain
 * error, is reported through the return value so the caller can decide
 * (retry later, surface it, refuse to trust a record) — never a crash. A
 * failing write or delete is retried a few times right here, because the
 * common Keychain failures (`errSecInteractionNotAllowed` around an unlock,
 * a transient `errSecIO`) clear within moments.
 */

export const SESSION_VAULT_SERVICE = 'com.picklesensei.auth.session';
const SESSION_VAULT_ACCOUNT = 'session';

/** Pauses before the 2nd, 3rd… attempt of a failing Keychain write/delete. */
const RETRY_DELAYS_MS = [100, 400];

/**
 * What an explicit sign-out leaves in the Keychain when the item cannot be
 * deleted: a record `parsePersistedSession` rejects (no provider, no token),
 * so a later launch finds nothing restorable instead of the signed-out
 * account. Overwriting is a different Keychain operation from deleting and
 * frequently succeeds when the delete did not.
 */
const SIGNED_OUT_TOMBSTONE = JSON.stringify({
  version: 1,
  state: 'signed-out',
});

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Runs a Keychain mutation (resolving whether it took effect; a throw counts
 * as "no") until it succeeds or the retry budget is spent. */
async function withRetries(
  operation: () => Promise<boolean>,
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (await operation()) return true;
    } catch {
      // Retried below while the budget lasts.
    }
    const delayMs = RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) return false;
    await sleep(delayMs);
  }
}

/** react-native-keychain resolves `false` (rather than throwing) for some
 * refused writes; both count as not stored. */
function writeItem(
  keychain: KeychainModule,
  payload: string,
): Promise<boolean> {
  return withRetries(async () => {
    const result = await keychain.setGenericPassword(
      SESSION_VAULT_ACCOUNT,
      payload,
      {
        service: SESSION_VAULT_SERVICE,
        accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      },
    );
    return result !== false;
  });
}

/** Returns whether the session is now durably stored. `false` means the
 * Keychain refused every attempt: the caller must not treat the sign-in as
 * durable and should try again later (a stale item, if any, is untouched). */
export async function savePersistedSession(
  session: PersistedSession,
): Promise<boolean> {
  const keychain = loadKeychain();
  if (!keychain) return false;
  return writeItem(keychain, JSON.stringify(session));
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

/**
 * Ends the durable session. Returns whether the Keychain is guaranteed to
 * hold no restorable record afterwards: the item was deleted, or — when the
 * delete kept failing — overwritten with `SIGNED_OUT_TOMBSTONE`. `false`
 * means the item is still there exactly as it was; the caller must make sure
 * the next launch does not trust it.
 */
export async function clearPersistedSession(): Promise<boolean> {
  const keychain = loadKeychain();
  if (!keychain) return true;
  // resetGenericPassword resolves false when there was nothing to delete,
  // which is still "no record left".
  const deleted = await withRetries(async () => {
    await keychain.resetGenericPassword({ service: SESSION_VAULT_SERVICE });
    return true;
  });
  if (deleted) return true;
  return writeItem(keychain, SIGNED_OUT_TOMBSTONE);
}
