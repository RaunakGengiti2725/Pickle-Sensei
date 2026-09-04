/**
 * Unit contract of `src/account/sessionVault.ts` against the in-memory
 * react-native-keychain mock: what is stored (and never stored), how a
 * malformed record is handled, and — the XC-RS-07 pin — that Keychain FAULTS
 * are distinguishable from "nothing stored": a failing read throws
 * `SessionVaultReadError` and leaves the record intact, a failing write is
 * reported as `false` after exactly one retry.
 */
import * as Keychain from 'react-native-keychain';
import {
  SESSION_VAULT_SERVICE,
  SessionVaultReadError,
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
  type PersistedSession,
} from '../src/account/sessionVault';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<
    string,
    { username: string; password: string; accessible?: string }
  >;
};

const session: PersistedSession = {
  version: 1,
  provider: 'apple',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  refreshToken: 'refresh-token',
  email: 'alex@example.com',
  displayName: 'Alex Chen',
};

const keychainFault = () => new Error('errSecInteractionNotAllowed');

beforeEach(() => {
  __keychainStore.clear();
  jest.restoreAllMocks();
});

describe('sessionVault round trip', () => {
  it('stores exactly the refresh token + UI-safe descriptor under the device-only accessibility class', async () => {
    await expect(savePersistedSession(session)).resolves.toBe(true);
    const stored = __keychainStore.get(SESSION_VAULT_SERVICE);
    expect(stored).toBeDefined();
    expect(stored!.accessible).toBe(
      Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    );
    expect(JSON.parse(stored!.password)).toEqual(session);
    expect(stored!.password).not.toContain('accessToken');
    await expect(loadPersistedSession()).resolves.toEqual(session);
  });

  it('reports null when nothing is stored', async () => {
    await expect(loadPersistedSession()).resolves.toBeNull();
  });

  it('clears a malformed record and reports null (a corrupt item is not a fault)', async () => {
    __keychainStore.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: '{"version":1,"provider":"apple"}',
    });
    await expect(loadPersistedSession()).resolves.toBeNull();
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
  });

  it('clearPersistedSession removes the record', async () => {
    await savePersistedSession(session);
    await clearPersistedSession();
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
    await expect(loadPersistedSession()).resolves.toBeNull();
  });
});

describe('sessionVault Keychain faults (XC-RS-07)', () => {
  it('a read that keeps failing throws SessionVaultReadError and leaves the record in place', async () => {
    await savePersistedSession(session);
    const read = jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValue(keychainFault());
    await expect(loadPersistedSession()).rejects.toBeInstanceOf(
      SessionVaultReadError,
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
  });

  it('a read that fails once is retried and returns the record', async () => {
    await savePersistedSession(session);
    const mockRead = Keychain.getGenericPassword;
    const read = jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValueOnce(keychainFault())
      .mockImplementation(mockRead);
    await expect(loadPersistedSession()).resolves.toEqual(session);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a write that keeps failing reports false and stores nothing', async () => {
    const write = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValue(keychainFault());
    await expect(savePersistedSession(session)).resolves.toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
  });

  it('a write that fails once is retried and persists', async () => {
    const mockWrite = Keychain.setGenericPassword;
    const write = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValueOnce(keychainFault())
      .mockImplementation(mockWrite);
    await expect(savePersistedSession(session)).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
  });
});
