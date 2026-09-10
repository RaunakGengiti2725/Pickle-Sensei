/**
 * The stable per-installation key id the offline grant protocol binds every
 * device registration and grant to.
 *
 * It is generated once, the first time the app needs it, and lives ONLY in
 * the device Keychain under its own THIS_DEVICE_ONLY service — the same
 * pattern as the session vault (`src/account/sessionVault.ts`) and the
 * trusted-time anchor: readable once the phone has been unlocked since boot,
 * never leaving the device through backups or Keychain sync, never written
 * to SQLite kv, AsyncStorage or logs. Reinstalling the app therefore yields
 * a new installation; a relaunch never does.
 *
 * Every read fails soft to `null` — a build without the native module, a
 * Keychain error, a hung store, or a malformed item — and a `null` means
 * "no identity right now", so nothing is registered or requested under a
 * made-up id. A malformed item is left in place rather than replaced: the
 * server may hold grants bound to whatever it was, and only a human can
 * decide that an installation starts over.
 */
import * as Keychain from 'react-native-keychain';
import { makeUuid } from '../util/uuid';

export const INSTALLATION_KEY_KEYCHAIN_SERVICE =
  'com.picklesensei.offline.installation-key';
export const INSTALLATION_KEY_KEYCHAIN_ACCOUNT = 'installation-key';
/** The Edge API's `installationKeyId` grammar. */
export const INSTALLATION_KEY_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A Keychain call that has not answered by then is treated as unavailable
 * so a stuck store cannot block the sync pass that asked. */
export const INSTALLATION_KEY_KEYCHAIN_TIMEOUT_MS = 2_000;

export type InstallationKeyKeychain = Pick<
  typeof Keychain,
  'ACCESSIBLE' | 'getGenericPassword' | 'setGenericPassword'
>;

export interface InstallationKey {
  /** The installation's key id, or null when the Keychain cannot provide
   * one right now. Every read goes to the Keychain (the identity is what it
   * holds, nothing cached beside it); concurrent callers share one read and
   * therefore one generation. */
  read(): Promise<string | null>;
}

export interface InstallationKeyDependencies {
  readonly keychain?: InstallationKeyKeychain;
  readonly generate?: () => string;
}

class KeychainTimeoutError extends Error {
  constructor() {
    super('installation-key keychain timeout');
  }
}

function bounded<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new KeychainTimeoutError()),
      INSTALLATION_KEY_KEYCHAIN_TIMEOUT_MS,
    );
    operation.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function isInstallationKeyId(value: unknown): value is string {
  return typeof value === 'string' && INSTALLATION_KEY_ID_PATTERN.test(value);
}

function generateInstallationKeyId(): string {
  return `ios-${makeUuid()}`;
}

export function createInstallationKey(
  dependencies: InstallationKeyDependencies = {},
): InstallationKey {
  const keychain = dependencies.keychain ?? Keychain;
  const generate = dependencies.generate ?? generateInstallationKeyId;
  let inFlight: Promise<string | null> | null = null;

  async function load(): Promise<string | null> {
    const stored = await bounded(
      keychain.getGenericPassword({
        service: INSTALLATION_KEY_KEYCHAIN_SERVICE,
      }),
    );
    if (stored !== false) {
      return isInstallationKeyId(stored.password) ? stored.password : null;
    }
    const generated = generate();
    if (!isInstallationKeyId(generated)) return null;
    const written = await bounded(
      keychain.setGenericPassword(
        INSTALLATION_KEY_KEYCHAIN_ACCOUNT,
        generated,
        {
          service: INSTALLATION_KEY_KEYCHAIN_SERVICE,
          accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        },
      ),
    );
    if (written === false) return null;
    // Only what the Keychain holds is the identity: a concurrent writer may
    // have won, and its id is the one the server will see next launch.
    const confirmed = await bounded(
      keychain.getGenericPassword({
        service: INSTALLATION_KEY_KEYCHAIN_SERVICE,
      }),
    );
    if (confirmed === false || !isInstallationKeyId(confirmed.password)) {
      return null;
    }
    return confirmed.password;
  }

  return {
    read() {
      if (inFlight) return inFlight;
      const attempt = load()
        .catch((): null => null)
        .finally(() => {
          if (inFlight === attempt) inFlight = null;
        });
      inFlight = attempt;
      return attempt;
    },
  };
}

export const installationKey: InstallationKey = createInstallationKey();
