import { NativeModules } from 'react-native';

import {
  OFFLINE_WALLET_NATIVE_FAILURES,
  OfflineWalletError,
  type OfflineWalletGrant,
  type OfflineWalletSnapshot,
  clearOfflineWallet,
  discardCorruptOfflineWallet,
  isOfflineWalletRetryable,
  isOfflineWalletUnreadable,
  loadOfflineWallet,
  offlineWalletAvailable,
  replaceOfflineWallet,
  toOfflineWalletError,
} from '../src/native/offlineWallet';

const OWNER = '0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b';

const mockLoadWallet = jest.fn<Promise<unknown>, [string]>();
const mockReplaceWallet = jest.fn<
  Promise<unknown>,
  [string, number, unknown]
>();
const mockClearWallet = jest.fn<Promise<unknown>, [string, number]>();
const mockDiscardCorruptWallet = jest.fn<Promise<unknown>, [string]>();

type NativeSlot = { PickleOfflineWallet?: unknown };

function installNative() {
  (NativeModules as NativeSlot).PickleOfflineWallet = {
    loadWallet: mockLoadWallet,
    replaceWallet: mockReplaceWallet,
    clearWallet: mockClearWallet,
    discardCorruptWallet: mockDiscardCorruptWallet,
  };
}

function nativeRejection(code: string, message: string, userInfo?: object) {
  return Object.assign(new Error(message), { code, userInfo });
}

const snapshot: OfflineWalletSnapshot = {
  ownerId: OWNER,
  revision: 3,
  grants: [{ grantId: 'grant-1', compactJws: 'a.b.c' }],
  receipts: [
    { receiptId: 'receipt-1', kind: 'result', payloadJson: '{}' },
    {
      receiptId: 'receipt-2',
      kind: 'unused_ticket_return',
      payloadJson: '{"x":1}',
    },
  ],
};

async function expectFailure(
  promise: Promise<unknown>,
  failure: OfflineWalletError['failure'],
): Promise<OfflineWalletError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${failure}`);
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OfflineWalletError);
  expect((error as OfflineWalletError).failure).toBe(failure);
  expect((error as OfflineWalletError).code).toBe(`wallet.${failure}`);
  return error as OfflineWalletError;
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

describe('offline wallet native bridge', () => {
  it('reports availability from the linked native module', () => {
    expect(offlineWalletAvailable()).toBe(true);
    delete (NativeModules as NativeSlot).PickleOfflineWallet;
    expect(offlineWalletAvailable()).toBe(false);
  });

  it('rejects with not_configured when the module is missing, without calling anything', async () => {
    delete (NativeModules as NativeSlot).PickleOfflineWallet;
    await expectFailure(loadOfflineWallet(OWNER), 'not_configured');
    await expectFailure(
      replaceOfflineWallet(OWNER, 0, { grants: [], receipts: [] }),
      'not_configured',
    );
    await expectFailure(clearOfflineWallet(OWNER, 1), 'not_configured');
    await expectFailure(discardCorruptOfflineWallet(OWNER), 'not_configured');
    expect(mockLoadWallet).not.toHaveBeenCalled();
  });

  it('returns null for an absent wallet and a typed snapshot for a stored one', async () => {
    mockLoadWallet.mockResolvedValueOnce(null);
    expect(await loadOfflineWallet(OWNER)).toBeNull();
    expect(mockLoadWallet).toHaveBeenCalledWith(OWNER);

    mockLoadWallet.mockResolvedValueOnce(snapshot);
    const loaded = await loadOfflineWallet(OWNER);
    expect(loaded).toEqual(snapshot);
    expect(loaded?.receipts[1]?.kind).toBe('unused_ticket_return');
  });

  it('passes exactly the grant/receipt fields to replace and returns the new snapshot', async () => {
    mockReplaceWallet.mockResolvedValueOnce({ ...snapshot, revision: 4 });
    const grantWithExtraField: OfflineWalletGrant & { extra: string } = {
      grantId: 'grant-1',
      compactJws: 'a.b.c',
      extra: 'dropped',
    };
    const result = await replaceOfflineWallet(OWNER, 3, {
      grants: [grantWithExtraField],
      receipts: snapshot.receipts,
    });
    expect(result.revision).toBe(4);
    expect(mockReplaceWallet).toHaveBeenCalledWith(OWNER, 3, {
      grants: [{ grantId: 'grant-1', compactJws: 'a.b.c' }],
      receipts: snapshot.receipts,
    });
  });

  it('maps every native wallet.* rejection onto a typed OfflineWalletError with its OSStatus', async () => {
    for (const failure of OFFLINE_WALLET_NATIVE_FAILURES) {
      mockLoadWallet.mockRejectedValueOnce(
        nativeRejection(`wallet.${failure}`, `detail ${failure}`, {
          failure,
          status: -25308,
        }),
      );
      const error = await expectFailure(loadOfflineWallet(OWNER), failure);
      expect(error.message).toBe(`detail ${failure}`);
      expect(error.status).toBe(-25308);
    }
  });

  it('treats unknown rejection codes and malformed snapshots as a bridge contract breach', async () => {
    mockLoadWallet.mockRejectedValueOnce(
      nativeRejection('wallet.refunded', 'made up'),
    );
    await expectFailure(loadOfflineWallet(OWNER), 'bridge_contract');

    mockLoadWallet.mockRejectedValueOnce(new Error('plain failure'));
    const plain = await expectFailure(
      loadOfflineWallet(OWNER),
      'bridge_contract',
    );
    expect(plain.message).toBe('plain failure');
    expect(plain.status).toBeNull();

    for (const malformed of [
      'string',
      { ...snapshot, revision: 0 },
      { ...snapshot, revision: 1.5 },
      { ...snapshot, ownerId: 7 },
      { ...snapshot, grants: [{ grantId: 'g' }] },
      {
        ...snapshot,
        receipts: [{ receiptId: 'r', kind: 'refund', payloadJson: '{}' }],
      },
    ]) {
      mockLoadWallet.mockResolvedValueOnce(malformed);
      await expectFailure(loadOfflineWallet(OWNER), 'bridge_contract');
    }
  });

  it('clears with the expected revision and reports the discarded failure', async () => {
    mockClearWallet.mockResolvedValueOnce(null);
    await expect(clearOfflineWallet(OWNER, 2)).resolves.toBeUndefined();
    expect(mockClearWallet).toHaveBeenCalledWith(OWNER, 2);

    mockClearWallet.mockRejectedValueOnce(
      nativeRejection('wallet.revision_conflict', 'stale'),
    );
    await expectFailure(clearOfflineWallet(OWNER, 1), 'revision_conflict');

    mockDiscardCorruptWallet.mockResolvedValueOnce('tampered');
    expect(await discardCorruptOfflineWallet(OWNER)).toBe('tampered');

    mockDiscardCorruptWallet.mockResolvedValueOnce('something_else');
    await expectFailure(discardCorruptOfflineWallet(OWNER), 'bridge_contract');

    mockDiscardCorruptWallet.mockRejectedValueOnce(
      nativeRejection('wallet.not_corrupt', 'verifies'),
    );
    await expectFailure(discardCorruptOfflineWallet(OWNER), 'not_corrupt');
  });

  it('refuses a snapshot for any owner other than the one requested', async () => {
    const otherOwner = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    for (const ownerId of [otherOwner, OWNER.toUpperCase(), ` ${OWNER}`]) {
      mockLoadWallet.mockResolvedValueOnce({ ...snapshot, ownerId });
      const error = await expectFailure(
        loadOfflineWallet(OWNER),
        'bridge_contract',
      );
      expect(error.message).toContain('ownerId mismatch');
      mockReplaceWallet.mockResolvedValueOnce({ ...snapshot, ownerId });
      await expectFailure(
        replaceOfflineWallet(OWNER, 3, { grants: [], receipts: [] }),
        'bridge_contract',
      );
    }
    mockLoadWallet.mockResolvedValueOnce(snapshot);
    expect((await loadOfflineWallet(OWNER))?.ownerId).toBe(OWNER);
  });

  it('refuses snapshots that break the native shape and capacity rules', async () => {
    const grant = (grantId: string) => ({ grantId, compactJws: 'a.b.c' });
    const receipt = (receiptId: string, payloadJson = '{}') => ({
      receiptId,
      kind: 'result',
      payloadJson,
    });
    const cases: Array<[string, unknown]> = [
      [
        'duplicate grantId',
        { ...snapshot, grants: [grant('dup'), grant('dup')] },
      ],
      [
        'duplicate receiptId',
        { ...snapshot, receipts: [receipt('dup'), receipt('dup')] },
      ],
      ['empty grant field', { ...snapshot, grants: [grant('')] }],
      [
        'empty grant field',
        { ...snapshot, grants: [{ grantId: 'g', compactJws: '' }] },
      ],
      ['empty receiptId', { ...snapshot, receipts: [receipt('')] }],
      [
        'grant count',
        {
          ...snapshot,
          grants: Array.from({ length: 9 }, (_, i) => grant(`g${i}`)),
        },
      ],
      [
        'receipt count',
        {
          ...snapshot,
          receipts: Array.from({ length: 65 }, (_, i) => receipt(`r${i}`)),
        },
      ],
      [
        'receipt payloadJson is not a JSON object',
        { ...snapshot, receipts: [receipt('r', '[1,2]')] },
      ],
      [
        'receipt payloadJson is not a JSON object',
        { ...snapshot, receipts: [receipt('r', '"text"')] },
      ],
      [
        'receipt payloadJson is not a JSON object',
        { ...snapshot, receipts: [receipt('r', 'null')] },
      ],
      [
        'receipt payloadJson is not a JSON object',
        { ...snapshot, receipts: [receipt('r', '{not json')] },
      ],
      [
        'receipt payloadJson is not a JSON object',
        { ...snapshot, receipts: [receipt('r', '')] },
      ],
    ];
    for (const [detail, malformed] of cases) {
      mockLoadWallet.mockResolvedValueOnce(malformed);
      const error = await expectFailure(
        loadOfflineWallet(OWNER),
        'bridge_contract',
      );
      expect(error.message).toContain(detail);
    }

    const atLimit = {
      ...snapshot,
      grants: Array.from({ length: 8 }, (_, i) => grant(`g${i}`)),
      receipts: Array.from({ length: 64 }, (_, i) => receipt(`r${i}`)),
    };
    mockLoadWallet.mockResolvedValueOnce(atLimit);
    expect(await loadOfflineWallet(OWNER)).toEqual(atLimit);
  });

  it('only accepts unreadable-state failures as a discard outcome', async () => {
    for (const outcome of OFFLINE_WALLET_NATIVE_FAILURES) {
      mockDiscardCorruptWallet.mockResolvedValueOnce(outcome);
      if (isOfflineWalletUnreadable(outcome)) {
        expect(await discardCorruptOfflineWallet(OWNER)).toBe(outcome);
      } else {
        await expectFailure(
          discardCorruptOfflineWallet(OWNER),
          'bridge_contract',
        );
      }
    }
    for (const outcome of ['', null, undefined, 1, { failure: 'tampered' }]) {
      mockDiscardCorruptWallet.mockResolvedValueOnce(outcome);
      await expectFailure(
        discardCorruptOfflineWallet(OWNER),
        'bridge_contract',
      );
    }
  });

  it('classifies unreadable and retryable failures', () => {
    expect(isOfflineWalletUnreadable('tampered')).toBe(true);
    expect(isOfflineWalletUnreadable('integrity_key_missing')).toBe(true);
    expect(isOfflineWalletUnreadable('unsupported_version')).toBe(true);
    expect(isOfflineWalletUnreadable('revision_conflict')).toBe(false);
    expect(isOfflineWalletRetryable('storage_unavailable')).toBe(true);
    expect(isOfflineWalletRetryable('storage_denied')).toBe(false);
    expect(
      toOfflineWalletError(new OfflineWalletError('tampered', 'x')).failure,
    ).toBe('tampered');
  });
});
