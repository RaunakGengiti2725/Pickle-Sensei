/**
 * Jest auto-mock for react-native-keychain: an in-memory Keychain keyed by
 * service, so tests can seed a persisted session, assert exactly what the
 * app stores (and never stores), and reset between cases via
 * `__keychainStore.clear()`. Nothing native is touched.
 */

export const ACCESSIBLE = {
  WHEN_UNLOCKED: 'AccessibleWhenUnlocked',
  AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
  ALWAYS: 'AccessibleAlways',
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'AccessibleWhenPasscodeSetThisDeviceOnly',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
    'AccessibleAfterFirstUnlockThisDeviceOnly',
} as const;

interface StoredItem {
  username: string;
  password: string;
  accessible?: string;
}

const DEFAULT_SERVICE = '__default__';

export const __keychainStore = new Map<string, StoredItem>();

export async function setGenericPassword(
  username: string,
  password: string,
  options: { service?: string; accessible?: string } = {},
): Promise<{ service: string; storage: string }> {
  const service = options.service ?? DEFAULT_SERVICE;
  __keychainStore.set(service, {
    username,
    password,
    accessible: options.accessible,
  });
  return { service, storage: 'KeychainMock' };
}

export async function getGenericPassword(
  options: { service?: string } = {},
): Promise<
  | false
  | { service: string; storage: string; username: string; password: string }
> {
  const service = options.service ?? DEFAULT_SERVICE;
  const item = __keychainStore.get(service);
  if (!item) return false;
  return {
    service,
    storage: 'KeychainMock',
    username: item.username,
    password: item.password,
  };
}

export async function resetGenericPassword(
  options: { service?: string } = {},
): Promise<boolean> {
  return __keychainStore.delete(options.service ?? DEFAULT_SERVICE);
}
