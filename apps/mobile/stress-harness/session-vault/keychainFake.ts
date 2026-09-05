/**
 * Fault-injecting stand-in for `react-native-keychain`, used by the seeded
 * randomized sessionVault campaign.
 *
 * The real module is a thin bridge over the iOS Keychain: every call can
 * succeed, fail with an OSStatus error, or report "nothing there" (`false`).
 * This fake reproduces exactly those three outcomes per operation, keyed by a
 * mutable mode the campaign flips between steps, and records an operation log
 * so the driver can assert WHICH item was touched — not just the end state.
 *
 * Nothing here is random: the driver picks every mode from its seeded PRNG.
 */

export type KeychainOpMode = 'ok' | 'throws' | 'returns-false';

export interface KeychainItem {
  username: string;
  password: string;
  accessible?: string | undefined;
}

export interface KeychainOp {
  op: 'set' | 'get' | 'reset';
  service: string | undefined;
  outcome: 'ok' | 'throws' | 'returns-false' | 'miss';
}

const DEFAULT_SERVICE = '__default__';

export const ACCESSIBLE = {
  WHEN_UNLOCKED: 'AccessibleWhenUnlocked',
  AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
  ALWAYS: 'AccessibleAlways',
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'AccessibleWhenPasscodeSetThisDeviceOnly',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
    'AccessibleAfterFirstUnlockThisDeviceOnly',
} as const;

class KeychainFake {
  readonly store = new Map<string, KeychainItem>();
  readonly log: KeychainOp[] = [];
  setMode: KeychainOpMode = 'ok';
  getMode: KeychainOpMode = 'ok';
  resetMode: KeychainOpMode = 'ok';
  /** Harness self-test only: makes reset report success without deleting,
   * so the driver/minimizer can be proven to catch a real divergence. */
  sabotageReset = false;

  reset(): void {
    this.store.clear();
    this.log.length = 0;
    this.setMode = 'ok';
    this.getMode = 'ok';
    this.resetMode = 'ok';
  }

  snapshot(): Record<string, KeychainItem> {
    const out: Record<string, KeychainItem> = {};
    for (const [service, item] of [...this.store.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      out[service] = { ...item };
    }
    return out;
  }
}

export const keychainFake = new KeychainFake();

export async function setGenericPassword(
  username: string,
  password: string,
  options: { service?: string; accessible?: string } = {},
): Promise<false | { service: string; storage: string }> {
  const service = options.service ?? DEFAULT_SERVICE;
  if (keychainFake.setMode === 'throws') {
    keychainFake.log.push({
      op: 'set',
      service: options.service,
      outcome: 'throws',
    });
    throw new Error('errSecNotAvailable (simulated setGenericPassword)');
  }
  if (keychainFake.setMode === 'returns-false') {
    keychainFake.log.push({
      op: 'set',
      service: options.service,
      outcome: 'returns-false',
    });
    return false;
  }
  keychainFake.store.set(service, {
    username,
    password,
    accessible: options.accessible,
  });
  keychainFake.log.push({ op: 'set', service: options.service, outcome: 'ok' });
  return { service, storage: 'KeychainStressFake' };
}

export async function getGenericPassword(
  options: { service?: string } = {},
): Promise<
  | false
  | { service: string; storage: string; username: string; password: string }
> {
  const service = options.service ?? DEFAULT_SERVICE;
  if (keychainFake.getMode === 'throws') {
    keychainFake.log.push({
      op: 'get',
      service: options.service,
      outcome: 'throws',
    });
    throw new Error(
      'errSecInteractionNotAllowed (simulated getGenericPassword)',
    );
  }
  if (keychainFake.getMode === 'returns-false') {
    keychainFake.log.push({
      op: 'get',
      service: options.service,
      outcome: 'returns-false',
    });
    return false;
  }
  const item = keychainFake.store.get(service);
  if (!item) {
    keychainFake.log.push({
      op: 'get',
      service: options.service,
      outcome: 'miss',
    });
    return false;
  }
  keychainFake.log.push({ op: 'get', service: options.service, outcome: 'ok' });
  return {
    service,
    storage: 'KeychainStressFake',
    username: item.username,
    password: item.password,
  };
}

export async function resetGenericPassword(
  options: { service?: string } = {},
): Promise<boolean> {
  const service = options.service ?? DEFAULT_SERVICE;
  if (keychainFake.resetMode === 'throws') {
    keychainFake.log.push({
      op: 'reset',
      service: options.service,
      outcome: 'throws',
    });
    throw new Error('errSecItemNotFound (simulated resetGenericPassword)');
  }
  if (keychainFake.resetMode === 'returns-false') {
    keychainFake.log.push({
      op: 'reset',
      service: options.service,
      outcome: 'returns-false',
    });
    return false;
  }
  const existed = keychainFake.sabotageReset
    ? keychainFake.store.has(service)
    : keychainFake.store.delete(service);
  keychainFake.log.push({
    op: 'reset',
    service: options.service,
    outcome: existed ? 'ok' : 'miss',
  });
  return existed;
}
