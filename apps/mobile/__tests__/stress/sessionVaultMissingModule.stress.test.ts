/**
 * STRESS — sessionVault with NO native Keychain module linked (a build that
 * skipped `pod install`, or a platform without the module): every API must
 * fail soft, under a burst as well as one call at a time, with no throw and
 * no unhandled rejection. Lives in its own file because the module-missing
 * condition is a per-registry `jest.mock` factory that throws.
 */
import {
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
} from '../../src/account/sessionVault';

jest.mock('react-native-keychain', () => {
  throw new Error("Cannot find module 'react-native-keychain'");
});

const SESSION = {
  version: 1 as const,
  provider: 'apple' as const,
  canonicalAppUserId: 'user-a-0001',
  refreshToken: 'rt-A-v1',
  email: null,
  displayName: null,
};

describe('sessionVault without the native module', () => {
  it('save → false, load → null, clear resolves', async () => {
    await expect(savePersistedSession(SESSION)).resolves.toBe(false);
    await expect(loadPersistedSession()).resolves.toBeNull();
    await expect(clearPersistedSession()).resolves.toBeUndefined();
  });

  it('a 300-call mixed burst settles with no throw and no unhandled rejection', async () => {
    let unhandled = 0;
    const onUnhandled = (): void => {
      unhandled += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const calls: Promise<unknown>[] = [];
      for (let i = 0; i < 100; i += 1) {
        calls.push(savePersistedSession(SESSION));
        calls.push(loadPersistedSession());
        calls.push(clearPersistedSession());
      }
      const settled = await Promise.allSettled(calls);
      expect(settled.every(result => result.status === 'fulfilled')).toBe(true);
      const values = settled.map(result =>
        result.status === 'fulfilled' ? result.value : 'rejected',
      );
      expect(values.filter(v => v === false)).toHaveLength(100);
      expect(values.filter(v => v === null)).toHaveLength(100);
      expect(values.filter(v => v === undefined)).toHaveLength(100);
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
