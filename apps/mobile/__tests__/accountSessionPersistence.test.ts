import * as Keychain from 'react-native-keychain';
import {
  SESSION_VAULT_SERVICE,
  clearPersistedSession,
  clearSessionForLogout,
  loadPersistedSession,
  loadSessionVault,
  savePersistedSession,
  SessionVaultUnavailableError,
  type PersistedSession,
} from '../src/account/sessionVault';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

const first: PersistedSession = {
  version: 1,
  provider: 'apple',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  refreshToken: 'refresh-first',
  email: null,
  displayName: null,
};
const second: PersistedSession = {
  ...first,
  canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
  refreshToken: 'refresh-second',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

beforeEach(() => {
  __keychainStore.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('account Keychain persistence ordering and faults', () => {
  it('keeps a credential-free logout tombstone distinguishable from an empty vault', async () => {
    await savePersistedSession(first);
    jest.spyOn(Keychain, 'resetGenericPassword').mockResolvedValue(false);
    await expect(
      clearSessionForLogout(false, Promise.resolve(false)),
    ).resolves.toEqual({ cleared: false, vaultMarked: true });
    await expect(
      loadPersistedSession({ requireAvailable: true }),
    ).resolves.toBeNull();
    await expect(loadSessionVault({ requireAvailable: true })).resolves.toEqual(
      {
        version: 1,
        signedOut: true,
        guest: false,
      },
    );
    expect(JSON.stringify([...__keychainStore.values()])).not.toMatch(
      /refresh-first|11111111|apple/,
    );
  });

  it('keeps a delayed logout fallback in the same FIFO slot ahead of a successor save', async () => {
    await savePersistedSession(first);
    jest.spyOn(Keychain, 'resetGenericPassword').mockResolvedValue(false);
    const marker = deferred<boolean>();
    const clearing = clearSessionForLogout(false, marker.promise);
    await settle();
    const successor = savePersistedSession(second);
    await settle();
    expect(__keychainStore.get(SESSION_VAULT_SERVICE)?.password).toBe(
      JSON.stringify(first),
    );
    marker.resolve(false);
    await expect(clearing).resolves.toEqual({
      cleared: false,
      vaultMarked: true,
    });
    await expect(successor).resolves.toBe(true);
    await expect(loadSessionVault()).resolves.toEqual(second);
  });

  it('serializes native writes so a late older write cannot replace the newer owner', async () => {
    const gate = deferred<void>();
    const nativeSet = Keychain.setGenericPassword;
    const set = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockImplementationOnce(async (...args) => {
        await gate.promise;
        return nativeSet(...args);
      });

    const older = savePersistedSession(first);
    await settle();
    const newer = savePersistedSession(second);
    await settle();
    const callsWhileBlocked = set.mock.calls.length;
    gate.resolve();
    await Promise.all([older, newer]);

    expect(await loadPersistedSession()).toEqual(second);
    expect(callsWhileBlocked).toBe(1);
  });

  it('serializes a clear behind an in-flight save instead of resurrecting the cleared account', async () => {
    const gate = deferred<void>();
    const nativeSet = Keychain.setGenericPassword;
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockImplementationOnce(async (...args) => {
        await gate.promise;
        return nativeSet(...args);
      });
    const writing = savePersistedSession(first);
    await settle();
    const clearing = clearPersistedSession();
    await settle();
    gate.resolve();
    await Promise.all([writing, clearing]);

    expect(await loadPersistedSession()).toBeNull();
  });

  it('does not let cleanup of an older malformed read clear a newer saved account', async () => {
    const gate = deferred<void>();
    jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockImplementationOnce(async () => {
        await gate.promise;
        return {
          service: SESSION_VAULT_SERVICE,
          storage: Keychain.STORAGE_TYPE?.AES_GCM_NO_AUTH ?? 'KeychainMock',
          username: 'session',
          password: '{"version":1}',
        } as Awaited<ReturnType<typeof Keychain.getGenericPassword>>;
      });
    const reading = loadPersistedSession();
    await settle();
    const writing = savePersistedSession(second);
    await settle();
    gate.resolve();
    await Promise.all([reading, writing]);

    expect(await loadPersistedSession()).toEqual(second);
  });

  it('retries rejected and false native writes before acknowledging durability', async () => {
    const set = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValueOnce(new Error('Keychain temporarily unavailable'))
      .mockResolvedValueOnce(false);

    await expect(savePersistedSession(first)).resolves.toBe(true);
    expect(set).toHaveBeenCalledTimes(3);
    expect(set).toHaveBeenLastCalledWith('session', JSON.stringify(first), {
      service: SESSION_VAULT_SERVICE,
      accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    expect(await loadPersistedSession()).toEqual(first);
  });

  it('retries a temporary read failure rather than reporting an empty vault', async () => {
    await savePersistedSession(first);
    const get = jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValueOnce(new Error('Keychain locked briefly'));

    await expect(loadPersistedSession()).resolves.toEqual(first);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('retries temporary clear failures and verifies a false reset actually removed the item', async () => {
    await savePersistedSession(first);
    const reset = jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValueOnce(new Error('Keychain busy'))
      .mockResolvedValueOnce(false);

    await clearPersistedSession();

    expect(await loadPersistedSession()).toBeNull();
    expect(reset).toHaveBeenCalledTimes(3);
  });

  it('skips a queued write from the previous generation even when its owner becomes current again', async () => {
    let generation = 1;
    const originalGeneration = generation;
    const gate = deferred<void>();
    const nativeSet = Keychain.setGenericPassword;
    const set = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockImplementationOnce(async (...args) => {
        await gate.promise;
        return nativeSet(...args);
      });
    const blocked = savePersistedSession(first);
    await settle();
    const stale = savePersistedSession(
      { ...first, refreshToken: 'refresh-stale' },
      () => generation === originalGeneration,
    );
    const clearing = clearPersistedSession();
    generation += 2;
    const latest = savePersistedSession(
      { ...first, refreshToken: 'refresh-latest' },
      () => generation === 3,
    );
    gate.resolve();
    const [, staleSaved] = await Promise.all([
      blocked,
      stale,
      clearing,
      latest,
    ]);

    expect(staleSaved).toBe(false);
    expect(set).toHaveBeenCalledTimes(2);
    expect(await loadPersistedSession()).toMatchObject({
      refreshToken: 'refresh-latest',
    });
  });

  it('does not retry a failed native write after its generation is invalidated', async () => {
    let current = true;
    const gate = deferred<false>();
    const set = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockImplementationOnce(() => gate.promise);
    const writing = savePersistedSession(first, () => current);
    await settle();
    current = false;
    const clearing = clearPersistedSession();
    gate.resolve(false);

    await expect(writing).resolves.toBe(false);
    await clearing;
    expect(set).toHaveBeenCalledTimes(1);
    expect(await loadPersistedSession()).toBeNull();
  });

  it('distinguishes exhausted read failures from an empty vault without discarding the item', async () => {
    await savePersistedSession(first);
    const get = jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValue(new Error('Keychain unavailable'));

    await expect(
      loadPersistedSession({ requireAvailable: true }),
    ).rejects.toBeInstanceOf(SessionVaultUnavailableError);
    expect(get).toHaveBeenCalledTimes(3);
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
  });

  it('allows the next operation after a write exhausts its retry budget', async () => {
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValueOnce(new Error('Keychain busy'))
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('Keychain busy'));

    await expect(savePersistedSession(first)).resolves.toBe(false);
    await expect(savePersistedSession(second)).resolves.toBe(true);
    await expect(loadPersistedSession()).resolves.toEqual(second);
  });

  it('bounds repeated write failures and reports that nothing was durably saved', async () => {
    const set = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValue(new Error('Keychain unavailable'));

    await expect(savePersistedSession(first)).resolves.toBe(false);
    expect(set).toHaveBeenCalledTimes(3);
    expect(__keychainStore.size).toBe(0);
  });

  it('reports a clear that is still unsuccessful after bounded attempts', async () => {
    await savePersistedSession(first);
    const reset = jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockResolvedValue(false);

    await expect(clearPersistedSession()).resolves.toBe(false);
    expect(reset).toHaveBeenCalledTimes(3);
    expect(await loadPersistedSession()).toEqual(first);
  });
});
