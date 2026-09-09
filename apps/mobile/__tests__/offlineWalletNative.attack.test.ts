import { NativeModules } from 'react-native';

import {
  OfflineWalletError,
  clearOfflineWallet,
  discardCorruptOfflineWallet,
  loadOfflineWallet,
  offlineWalletAvailable,
  replaceOfflineWallet,
  toOfflineWalletError,
} from '../src/native/offlineWallet';

/**
 * Adversarial matrix for the JS side of the W05-01 offline wallet bridge
 * (candidate 64f7353e). Each test asserts the behaviour the wrapper SHOULD
 * have when the native side misbehaves or the caller supplies boundary
 * values; a failing test is a confirmed break. The candidate's own tests are
 * untouched.
 */

const OWNER = '0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b';
const OTHER_OWNER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const mockLoadWallet = jest.fn<Promise<unknown>, [string]>();
const mockReplaceWallet = jest.fn<
  Promise<unknown>,
  [string, number, unknown]
>();
const mockClearWallet = jest.fn<Promise<unknown>, [string, number]>();
const mockDiscardCorruptWallet = jest.fn<Promise<unknown>, [string]>();

type NativeSlot = { PickleOfflineWallet?: unknown };

function installNative(overrides: Record<string, unknown> = {}) {
  (NativeModules as NativeSlot).PickleOfflineWallet = {
    loadWallet: mockLoadWallet,
    replaceWallet: mockReplaceWallet,
    clearWallet: mockClearWallet,
    discardCorruptWallet: mockDiscardCorruptWallet,
    ...overrides,
  };
}

function nativeRejection(code: string, message: string, userInfo?: object) {
  return Object.assign(new Error(message), { code, userInfo });
}

async function settle(
  promise: Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  return promise.then(
    value => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function expectFailure(
  promise: Promise<unknown>,
  failure: OfflineWalletError['failure'],
): Promise<OfflineWalletError> {
  const outcome = await settle(promise);
  if (outcome.ok) {
    throw new Error(
      `expected ${failure}, resolved with ${JSON.stringify(outcome.value)}`,
    );
  }
  expect(outcome.error).toBeInstanceOf(OfflineWalletError);
  expect((outcome.error as OfflineWalletError).failure).toBe(failure);
  return outcome.error as OfflineWalletError;
}

beforeEach(() => {
  mockLoadWallet.mockReset();
  mockReplaceWallet.mockReset();
  mockClearWallet.mockReset();
  mockDiscardCorruptWallet.mockReset();
  installNative();
});

afterAll(() => {
  delete (NativeModules as NativeSlot).PickleOfflineWallet;
});

describe('offline wallet bridge — adversarial', () => {
  // Attack J1: cross-owner snapshot from native (account switch / native bug).
  it('J1 refuses a snapshot whose ownerId is not the requested owner', async () => {
    mockLoadWallet.mockResolvedValueOnce({
      ownerId: OTHER_OWNER,
      revision: 1,
      grants: [{ grantId: 'g', compactJws: 'a.b.c' }],
      receipts: [],
    });
    await expectFailure(loadOfflineWallet(OWNER), 'bridge_contract');

    mockReplaceWallet.mockResolvedValueOnce({
      ownerId: OWNER.toUpperCase(),
      revision: 2,
      grants: [],
      receipts: [],
    });
    await expectFailure(
      replaceOfflineWallet(OWNER, 1, { grants: [], receipts: [] }),
      'bridge_contract',
    );
  });

  // Attack J2: snapshots that violate the wallet's own shape rules.
  it('J2 refuses snapshots that break the native shape invariants', async () => {
    const cases: Array<[string, unknown]> = [
      [
        'duplicate grant ids',
        {
          ownerId: OWNER,
          revision: 1,
          grants: [
            { grantId: 'dup', compactJws: 'a.b.c' },
            { grantId: 'dup', compactJws: 'a.b.c' },
          ],
          receipts: [],
        },
      ],
      [
        'empty identifiers',
        {
          ownerId: OWNER,
          revision: 1,
          grants: [{ grantId: '', compactJws: '' }],
          receipts: [{ receiptId: '', kind: 'result', payloadJson: '' }],
        },
      ],
      [
        'grant capacity exceeded',
        {
          ownerId: OWNER,
          revision: 1,
          grants: Array.from({ length: 9 }, (_, i) => ({
            grantId: `g${i}`,
            compactJws: 'a.b.c',
          })),
          receipts: [],
        },
      ],
      [
        'receipt payload is not a JSON object',
        {
          ownerId: OWNER,
          revision: 1,
          grants: [],
          receipts: [{ receiptId: 'r', kind: 'result', payloadJson: '[1,2]' }],
        },
      ],
    ];
    for (const [label, value] of cases) {
      mockLoadWallet.mockResolvedValueOnce(value);
      const outcome = await settle(loadOfflineWallet(OWNER));
      expect(outcome.ok ? `accepted: ${label}` : 'refused').toBe('refused');
      if (!outcome.ok) {
        expect((outcome.error as OfflineWalletError).failure).toBe(
          'bridge_contract',
        );
      }
    }
  });

  // Attack J3: boundary revisions from the caller (NaN, negative, fractional,
  // infinities, 2^53) — must never reach native as a silent no-op and must
  // surface as the typed invalid_revision failure.
  it('J3 boundary revisions become invalid_revision, with native mirroring the core', async () => {
    const bad = [
      Number.NaN,
      -1,
      -0.5,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
      Number.MAX_VALUE,
    ];
    for (const revision of bad) {
      mockReplaceWallet.mockRejectedValueOnce(
        nativeRejection('wallet.invalid_revision', 'revision', {
          failure: 'invalid_revision',
        }),
      );
      const error = await expectFailure(
        replaceOfflineWallet(OWNER, revision, { grants: [], receipts: [] }),
        'invalid_revision',
      );
      expect(error.status).toBeNull();

      mockClearWallet.mockRejectedValueOnce(
        nativeRejection('wallet.invalid_revision', 'revision', {
          failure: 'invalid_revision',
        }),
      );
      await expectFailure(
        clearOfflineWallet(OWNER, revision),
        'invalid_revision',
      );
    }
    // The values that crossed the bridge are exactly what the caller passed
    // (no silent coercion such as NaN -> 0 or Infinity -> MAX_SAFE_INTEGER).
    expect(mockReplaceWallet.mock.calls.map(call => call[1])).toEqual(bad);
    expect(mockClearWallet.mock.calls.map(call => call[1])).toEqual(bad);
  });

  // Attack J4: hostile rejection shapes from the native side.
  it('J4 maps hostile rejection shapes without throwing or leaking', () => {
    const cases: unknown[] = [
      null,
      undefined,
      'string rejection',
      42,
      { code: 'wallet.' },
      { code: 'wallet.tampered.extra' },
      { code: 'WALLET.TAMPERED' },
      { code: 'wallet.tampered', message: '' },
      { code: 'wallet.tampered', userInfo: { status: '-25308' } },
      { code: 'wallet.tampered', userInfo: { status: 1.5 } },
      { code: 'wallet.tampered', userInfo: 'not an object' },
      Object.assign(new Error('boom'), { code: ['wallet.tampered'] }),
    ];
    for (const value of cases) {
      const error = toOfflineWalletError(value);
      expect(error).toBeInstanceOf(OfflineWalletError);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.status === null || Number.isInteger(error.status)).toBe(
        true,
      );
    }
    expect(toOfflineWalletError({ code: 'wallet.' }).failure).toBe(
      'bridge_contract',
    );
    expect(
      toOfflineWalletError({ code: 'wallet.tampered.extra' }).failure,
    ).toBe('bridge_contract');
    expect(toOfflineWalletError({ code: 'WALLET.TAMPERED' }).failure).toBe(
      'bridge_contract',
    );
    expect(
      toOfflineWalletError({
        code: 'wallet.tampered',
        userInfo: { status: '-25308' },
      }).status,
    ).toBeNull();
    expect(
      toOfflineWalletError({
        code: 'wallet.tampered',
        userInfo: { status: 1.5 },
      }).status,
    ).toBeNull();
    expect(
      toOfflineWalletError({
        code: 'wallet.tampered',
        userInfo: { status: -25308 },
      }).status,
    ).toBe(-25308);
    // An error that already is an OfflineWalletError is returned as-is.
    const typed = new OfflineWalletError('tampered', 'x', -1);
    expect(toOfflineWalletError(typed)).toBe(typed);
  });

  // Attack J5: partially wired native module (a method missing or not callable).
  it('J5 treats a partially wired native module as not_configured everywhere', async () => {
    const methods = [
      'loadWallet',
      'replaceWallet',
      'clearWallet',
      'discardCorruptWallet',
    ] as const;
    for (const method of methods) {
      for (const bad of [undefined, null, 'fn', {}, 1]) {
        installNative({ [method]: bad });
        expect(offlineWalletAvailable()).toBe(false);
        await expectFailure(loadOfflineWallet(OWNER), 'not_configured');
        await expectFailure(
          replaceOfflineWallet(OWNER, 0, { grants: [], receipts: [] }),
          'not_configured',
        );
        await expectFailure(clearOfflineWallet(OWNER, 0), 'not_configured');
        await expectFailure(
          discardCorruptOfflineWallet(OWNER),
          'not_configured',
        );
      }
    }
    expect(mockLoadWallet).not.toHaveBeenCalled();
    expect(mockReplaceWallet).not.toHaveBeenCalled();
    expect(mockClearWallet).not.toHaveBeenCalled();
    expect(mockDiscardCorruptWallet).not.toHaveBeenCalled();
  });

  // Attack J6: discard outcomes the JS side must not trust blindly.
  it('J6 refuses discard outcomes that are not corruption failures', async () => {
    for (const outcome of [
      'not_corrupt',
      'invalid_owner',
      'storage_failure',
      'not_configured',
      'bridge_contract',
      'wallet.tampered',
      '',
      null,
      undefined,
      1,
      { failure: 'tampered' },
    ]) {
      mockDiscardCorruptWallet.mockResolvedValueOnce(outcome);
      const result = await settle(discardCorruptOfflineWallet(OWNER));
      expect(result.ok ? `accepted ${String(outcome)}` : 'refused').toBe(
        'refused',
      );
      if (!result.ok) {
        expect((result.error as OfflineWalletError).failure).toBe(
          'bridge_contract',
        );
      }
    }
    for (const outcome of [
      'tampered',
      'integrity_key_missing',
      'unsupported_version',
    ]) {
      mockDiscardCorruptWallet.mockResolvedValueOnce(outcome);
      expect(await discardCorruptOfflineWallet(OWNER)).toBe(outcome);
    }
  });

  // Attack J7: non-null non-object resolutions (native contract breach) and
  // resolutions carrying revision 0 or negative — must never become a snapshot.
  it('J7 refuses non-object and zero/negative-revision resolutions', async () => {
    for (const value of ['', 'snapshot', 0, 1, true, [], [snapshotLike()]]) {
      mockLoadWallet.mockResolvedValueOnce(value);
      await expectFailure(loadOfflineWallet(OWNER), 'bridge_contract');
    }
    for (const revision of [0, -1, 0.5, Number.NaN, 2 ** 53, '3']) {
      mockReplaceWallet.mockResolvedValueOnce({
        ...snapshotLike(),
        revision,
      });
      await expectFailure(
        replaceOfflineWallet(OWNER, 0, { grants: [], receipts: [] }),
        'bridge_contract',
      );
    }
    // A missing native resolution for replace (undefined) is a breach too:
    // the caller must never believe a write happened without its revision.
    mockReplaceWallet.mockResolvedValueOnce(undefined);
    await expectFailure(
      replaceOfflineWallet(OWNER, 0, { grants: [], receipts: [] }),
      'bridge_contract',
    );
  });

  // Attack J8: the wrapper must not mutate or reorder caller data on the way
  // to native, and must forward the owner untouched (no trimming/lowercasing
  // that could alias two accounts).
  it('J8 forwards owner and contents verbatim', async () => {
    const hostileOwner = ` ${OWNER.toUpperCase()} `;
    mockReplaceWallet.mockResolvedValueOnce({
      ...snapshotLike(),
      ownerId: hostileOwner,
    });
    await settle(
      replaceOfflineWallet(hostileOwner, 0, {
        grants: [{ grantId: 'g2', compactJws: 'x.y.z' }],
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: '{"a":1}' }],
      }),
    );
    expect(mockReplaceWallet).toHaveBeenLastCalledWith(hostileOwner, 0, {
      grants: [{ grantId: 'g2', compactJws: 'x.y.z' }],
      receipts: [{ receiptId: 'r', kind: 'result', payloadJson: '{"a":1}' }],
    });
  });
});

function snapshotLike() {
  return {
    ownerId: OWNER,
    revision: 1,
    grants: [{ grantId: 'g', compactJws: 'a.b.c' }],
    receipts: [{ receiptId: 'r', kind: 'result', payloadJson: '{}' }],
  };
}
