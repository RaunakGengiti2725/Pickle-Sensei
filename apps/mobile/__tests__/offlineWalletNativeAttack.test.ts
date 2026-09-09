import { NativeModules, Platform } from 'react-native';

import {
  OFFLINE_WALLET_LIMITS,
  OfflineWalletError,
  type OfflineWalletContents,
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

// Adversarial matrix for W05-01 (attack branch devin/pp/w05-01/attack-bbb8b36a,
// candidate bbb8b36a): the JS bridge is driven with hostile native responses,
// boundary revisions, malformed contents and a partial/absent module. A failing
// case is a confirmed break of the candidate; the candidate's own tests are
// untouched.

const OWNER = '0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b';
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

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

function nativeRejection(code: unknown, message: string, userInfo?: unknown) {
  return Object.assign(new Error(message), { code, userInfo });
}

const healthy: OfflineWalletSnapshot = {
  ownerId: OWNER,
  revision: 1,
  grants: [{ grantId: 'grant-1', compactJws: 'a.b.c' }],
  receipts: [{ receiptId: 'receipt-1', kind: 'result', payloadJson: '{}' }],
};

const emptyContents: OfflineWalletContents = { grants: [], receipts: [] };

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

describe('offline wallet bridge — adversarial', () => {
  it('attack: snapshot revision at every boundary — only safe positive integers pass', async () => {
    mockLoadWallet.mockResolvedValueOnce({ ...healthy, revision: MAX_SAFE });
    expect((await loadOfflineWallet(OWNER))?.revision).toBe(MAX_SAFE);

    const hostile: unknown[] = [
      0,
      -0,
      -1,
      1.5,
      MAX_SAFE + 1,
      MAX_SAFE + 2,
      2 ** 63,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '1',
      1n,
      null,
      undefined,
      true,
      [1],
      { valueOf: () => 1 },
    ];
    for (const revision of hostile) {
      mockLoadWallet.mockResolvedValueOnce({ ...healthy, revision });
      await expectFailure(loadOfflineWallet(OWNER), 'bridge_contract');
      mockReplaceWallet.mockResolvedValueOnce({ ...healthy, revision });
      await expectFailure(
        replaceOfflineWallet(OWNER, 1, emptyContents),
        'bridge_contract',
      );
    }
  });

  it('attack: a snapshot for another owner or an owner alias is refused, including case variants', async () => {
    for (const ownerId of [
      OWNER.toUpperCase(),
      `${OWNER} `,
      ` ${OWNER}`,
      OWNER.slice(0, -1),
      '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      '',
      null,
      undefined,
      42,
    ]) {
      mockLoadWallet.mockResolvedValueOnce({ ...healthy, ownerId });
      await expectFailure(loadOfflineWallet(OWNER), 'bridge_contract');
      mockReplaceWallet.mockResolvedValueOnce({ ...healthy, ownerId });
      await expectFailure(
        replaceOfflineWallet(OWNER, 0, emptyContents),
        'bridge_contract',
      );
    }
  });

  it('attack: malformed snapshot bodies — every non-object, wrong-shaped or over-limit field is bridge_contract', async () => {
    const bodies: unknown[] = [
      [],
      [healthy],
      'null',
      JSON.stringify(healthy),
      0,
      1,
      true,
      () => healthy,
      Symbol('snapshot'),
      { ...healthy, grants: undefined },
      { ...healthy, grants: {} },
      { ...healthy, grants: 'none' },
      { ...healthy, receipts: null },
      { ...healthy, grants: [null] },
      { ...healthy, grants: [['grant-1', 'a.b.c']] },
      { ...healthy, grants: [{ grantId: 'grant-1' }] },
      { ...healthy, grants: [{ grantId: '', compactJws: 'a.b.c' }] },
      { ...healthy, grants: [{ grantId: 1, compactJws: 'a.b.c' }] },
      { ...healthy, grants: [{ grantId: 'grant-1', compactJws: '' }] },
      { ...healthy, grants: [{ grantId: 'grant-1', compactJws: 7 }] },
      {
        ...healthy,
        grants: [
          { grantId: 'dup', compactJws: 'a.b.c' },
          { grantId: 'dup', compactJws: 'd.e.f' },
        ],
      },
      {
        ...healthy,
        grants: Array.from(
          { length: OFFLINE_WALLET_LIMITS.maxGrants + 1 },
          (_, i) => ({ grantId: `g${i}`, compactJws: 'a.b.c' }),
        ),
      },
      {
        ...healthy,
        receipts: [{ receiptId: 'r', kind: 'refund', payloadJson: '{}' }],
      },
      {
        ...healthy,
        receipts: [{ receiptId: 'r', kind: 'Result', payloadJson: '{}' }],
      },
      { ...healthy, receipts: [{ receiptId: 'r', kind: 'result' }] },
      {
        ...healthy,
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: '[]' }],
      },
      {
        ...healthy,
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: 'null' }],
      },
      {
        ...healthy,
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: '"{}"' }],
      },
      {
        ...healthy,
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: '{}{}' }],
      },
      {
        ...healthy,
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: '' }],
      },
      {
        ...healthy,
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: {} }],
      },
      {
        ...healthy,
        receipts: [
          { receiptId: 'dup', kind: 'result', payloadJson: '{}' },
          { receiptId: 'dup', kind: 'unused_ticket_return', payloadJson: '{}' },
        ],
      },
      {
        ...healthy,
        receipts: Array.from(
          { length: OFFLINE_WALLET_LIMITS.maxReceipts + 1 },
          (_, i) => ({ receiptId: `r${i}`, kind: 'result', payloadJson: '{}' }),
        ),
      },
    ];
    for (const body of bodies) {
      mockLoadWallet.mockResolvedValueOnce(body);
      await expectFailure(loadOfflineWallet(OWNER), 'bridge_contract');
      mockReplaceWallet.mockResolvedValueOnce(body);
      await expectFailure(
        replaceOfflineWallet(OWNER, 0, emptyContents),
        'bridge_contract',
      );
    }

    // replace resolving "no wallet" is a contract violation, not an empty result.
    for (const body of [null, undefined]) {
      mockReplaceWallet.mockResolvedValueOnce(body);
      await expectFailure(
        replaceOfflineWallet(OWNER, 0, emptyContents),
        'bridge_contract',
      );
    }
    // load resolving undefined is "no wallet" like null.
    mockLoadWallet.mockResolvedValueOnce(undefined);
    expect(await loadOfflineWallet(OWNER)).toBeNull();

    // A snapshot at the exact limits, with extra unknown fields, passes and is normalised.
    const maximal = {
      ...healthy,
      extra: 'ignored',
      grants: Array.from(
        { length: OFFLINE_WALLET_LIMITS.maxGrants },
        (_, i) => ({
          grantId: `g${i}`,
          compactJws: 'a.b.c',
          extra: 'dropped',
        }),
      ),
      receipts: Array.from(
        { length: OFFLINE_WALLET_LIMITS.maxReceipts },
        (_, i) => ({
          receiptId: `r${i}`,
          kind: i % 2 ? 'result' : 'unused_ticket_return',
          payloadJson: `{"i":${i}}`,
          extra: 'dropped',
        }),
      ),
    };
    mockLoadWallet.mockResolvedValueOnce(maximal);
    const loaded = await loadOfflineWallet(OWNER);
    expect(loaded?.grants).toHaveLength(OFFLINE_WALLET_LIMITS.maxGrants);
    expect(loaded?.receipts).toHaveLength(OFFLINE_WALLET_LIMITS.maxReceipts);
    expect(Object.keys(loaded ?? {}).sort()).toEqual([
      'grants',
      'ownerId',
      'receipts',
      'revision',
    ]);
    expect(Object.keys(loaded?.grants[0] ?? {}).sort()).toEqual([
      'compactJws',
      'grantId',
    ]);
    expect(Object.keys(loaded?.receipts[0] ?? {}).sort()).toEqual([
      'kind',
      'payloadJson',
      'receiptId',
    ]);
  });

  it('attack: hostile native rejections — unknown, near-miss, wrongly typed or missing codes never become a known failure', async () => {
    const hostile: Array<[unknown, string, unknown]> = [
      ['wallet.', 'empty suffix', undefined],
      ['wallet.not_a_failure', 'unknown suffix', undefined],
      ['Wallet.tampered', 'case variant', undefined],
      ['wallet.Tampered', 'case variant', undefined],
      ['wallet.tampered ', 'trailing space', undefined],
      [' wallet.tampered', 'leading space', undefined],
      ['wallet.tampered.extra', 'extra segment', undefined],
      ['wallet_tampered', 'wrong separator', undefined],
      ['tampered', 'missing prefix', undefined],
      ['wallet.not_configured', 'js-only failure claimed by native', undefined],
      [
        'wallet.bridge_contract',
        'js-only failure claimed by native',
        undefined,
      ],
      ['E_UNKNOWN', 'react-native default', undefined],
      [42, 'numeric code', undefined],
      [null, 'null code', undefined],
      [undefined, 'no code', undefined],
      [['wallet.tampered'], 'array code', undefined],
      [{ toString: () => 'wallet.tampered' }, 'object code', undefined],
    ];
    for (const [code, message, userInfo] of hostile) {
      mockLoadWallet.mockRejectedValueOnce(
        nativeRejection(code, message, userInfo),
      );
      const error = await expectFailure(
        loadOfflineWallet(OWNER),
        'bridge_contract',
      );
      expect(isOfflineWalletUnreadable(error.failure)).toBe(false);
      expect(isOfflineWalletRetryable(error.failure)).toBe(false);
    }

    // Non-Error rejections without a usable code.
    for (const rejection of [
      'wallet.tampered',
      42,
      null,
      undefined,
      new Error('no code at all'),
    ]) {
      mockLoadWallet.mockRejectedValueOnce(rejection);
      await expectFailure(loadOfflineWallet(OWNER), 'bridge_contract');
    }
    // A plain object carrying a valid code is still a valid native rejection.
    mockLoadWallet.mockRejectedValueOnce({
      code: 'wallet.tampered',
      message: 'plain object with a valid code',
    });
    await expectFailure(loadOfflineWallet(OWNER), 'tampered');
  });

  it('attack: OSStatus smuggled through userInfo is only kept when it is an integer', async () => {
    const statuses: Array<[unknown, number | null]> = [
      [-25300, -25300],
      [0, 0],
      [1.5, null],
      ['-25300', null],
      [Number.NaN, null],
      [Number.POSITIVE_INFINITY, null],
      [null, null],
      [undefined, null],
      [[-25300], null],
      [MAX_SAFE + 1, MAX_SAFE + 1],
    ];
    for (const [status, expected] of statuses) {
      mockLoadWallet.mockRejectedValueOnce(
        nativeRejection('wallet.storage_failure', 'status probe', { status }),
      );
      const error = await expectFailure(
        loadOfflineWallet(OWNER),
        'storage_failure',
      );
      expect(error.status).toBe(expected);
    }
    for (const userInfo of [null, 'status', 7, [], { status: {} }]) {
      mockLoadWallet.mockRejectedValueOnce(
        nativeRejection('wallet.storage_failure', 'userInfo probe', userInfo),
      );
      const error = await expectFailure(
        loadOfflineWallet(OWNER),
        'storage_failure',
      );
      expect(error.status).toBeNull();
    }
  });

  it('attack: replace preflight blocks every malformed content before native is reached, and forwards exactly the limits', async () => {
    const badGrants: unknown[] = [
      [{ grantId: '', compactJws: 'a.b.c' }],
      [{ grantId: 'g', compactJws: '' }],
      [{ grantId: 'g' }],
      [{ compactJws: 'a.b.c' }],
      [{ grantId: 1, compactJws: 'a.b.c' }],
      [{ grantId: 'g', compactJws: null }],
      [null],
      ['g'],
      [
        { grantId: 'dup', compactJws: 'a.b.c' },
        { grantId: 'dup', compactJws: 'a.b.c' },
      ],
    ];
    for (const grants of badGrants) {
      await expectFailure(
        replaceOfflineWallet(OWNER, 0, {
          grants,
          receipts: [],
        } as unknown as OfflineWalletContents),
        'invalid_grant',
      );
    }
    const badReceipts: unknown[] = [
      [{ receiptId: '', kind: 'result', payloadJson: '{}' }],
      [{ receiptId: 'r', kind: 'refund', payloadJson: '{}' }],
      [{ receiptId: 'r', kind: 'RESULT', payloadJson: '{}' }],
      [{ receiptId: 'r', kind: 'result', payloadJson: '' }],
      [{ receiptId: 'r', kind: 'result', payloadJson: '[]' }],
      [{ receiptId: 'r', kind: 'result', payloadJson: 'null' }],
      [{ receiptId: 'r', kind: 'result', payloadJson: '1' }],
      [{ receiptId: 'r', kind: 'result', payloadJson: '"x"' }],
      [{ receiptId: 'r', kind: 'result', payloadJson: '{}garbage' }],
      [{ receiptId: 'r', kind: 'result', payloadJson: '\uFEFF{}' }],
      [{ receiptId: 'r', kind: 'result', payloadJson: '{"a":1,}' }],
      [{ receiptId: 'r', kind: 'result', payloadJson: "{'a':1}" }],
      [{ receiptId: 'r', kind: 'result', payloadJson: {} }],
      [{ receiptId: 'r', kind: 'result' }],
      [null],
      [
        { receiptId: 'dup', kind: 'result', payloadJson: '{}' },
        { receiptId: 'dup', kind: 'unused_ticket_return', payloadJson: '{}' },
      ],
    ];
    for (const receipts of badReceipts) {
      await expectFailure(
        replaceOfflineWallet(OWNER, 0, {
          grants: [],
          receipts,
        } as unknown as OfflineWalletContents),
        'invalid_receipt',
      );
    }
    await expectFailure(
      replaceOfflineWallet(OWNER, 0, {
        grants: Array.from(
          { length: OFFLINE_WALLET_LIMITS.maxGrants + 1 },
          (_, i) => ({ grantId: `g${i}`, compactJws: 'a.b.c' }),
        ),
        receipts: [],
      }),
      'capacity_exceeded',
    );
    await expectFailure(
      replaceOfflineWallet(OWNER, 0, {
        grants: [],
        receipts: Array.from(
          { length: OFFLINE_WALLET_LIMITS.maxReceipts + 1 },
          (_, i) => ({ receiptId: `r${i}`, kind: 'result', payloadJson: '{}' }),
        ),
      }),
      'capacity_exceeded',
    );
    // Preflight promises a typed invalid_grant / invalid_receipt /
    // capacity_exceeded for anything it refuses — never an untyped throw.
    for (const contents of [[], 'contents', 1, null, undefined]) {
      await expectFailure(
        replaceOfflineWallet(
          OWNER,
          0,
          contents as unknown as OfflineWalletContents,
        ),
        'invalid_grant',
      );
    }
    expect(mockReplaceWallet).not.toHaveBeenCalled();

    const atLimit: OfflineWalletContents = {
      grants: Array.from(
        { length: OFFLINE_WALLET_LIMITS.maxGrants },
        (_, i) => ({
          grantId: `g${i}`,
          compactJws: 'a.b.c',
        }),
      ),
      receipts: Array.from(
        { length: OFFLINE_WALLET_LIMITS.maxReceipts },
        (_, i) => ({ receiptId: `r${i}`, kind: 'result', payloadJson: '{}' }),
      ),
    };
    mockReplaceWallet.mockResolvedValueOnce({
      ...healthy,
      ...atLimit,
      revision: 2,
    });
    expect((await replaceOfflineWallet(OWNER, 1, atLimit)).revision).toBe(2);
    expect(mockReplaceWallet).toHaveBeenCalledTimes(1);
    expect(mockReplaceWallet.mock.calls[0]?.[2]).toEqual(atLimit);
  });

  it('attack: hostile expectedRevision values are forwarded untouched and the native verdict surfaces typed', async () => {
    for (const revision of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_SAFE + 1,
      2 ** 63,
    ]) {
      mockReplaceWallet.mockRejectedValueOnce(
        nativeRejection(
          'wallet.invalid_revision',
          'revision must be a non-negative safe integer',
        ),
      );
      await expectFailure(
        replaceOfflineWallet(OWNER, revision, emptyContents),
        'invalid_revision',
      );
      expect(mockReplaceWallet).toHaveBeenLastCalledWith(
        OWNER,
        revision,
        emptyContents,
      );
      mockClearWallet.mockRejectedValueOnce(
        nativeRejection(
          'wallet.invalid_revision',
          'revision must be a non-negative safe integer',
        ),
      );
      await expectFailure(
        clearOfflineWallet(OWNER, revision),
        'invalid_revision',
      );
      expect(mockClearWallet).toHaveBeenLastCalledWith(OWNER, revision);
    }
  });

  it('attack: double submit — two in-flight replaces at the same revision both surface their own native verdict', async () => {
    let releaseFirst: (value: unknown) => void = () => undefined;
    mockReplaceWallet.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseFirst = resolve;
        }),
    );
    mockReplaceWallet.mockRejectedValueOnce(
      nativeRejection(
        'wallet.revision_conflict',
        'stored revision 2 != expected 1',
      ),
    );
    const first = replaceOfflineWallet(OWNER, 1, emptyContents);
    const second = replaceOfflineWallet(OWNER, 1, emptyContents);
    const secondError = await expectFailure(second, 'revision_conflict');
    expect(isOfflineWalletUnreadable(secondError.failure)).toBe(false);
    expect(isOfflineWalletRetryable(secondError.failure)).toBe(false);
    releaseFirst({ ...healthy, revision: 2 });
    expect((await first).revision).toBe(2);
    expect(mockReplaceWallet).toHaveBeenCalledTimes(2);
  });

  it('attack: discard only accepts the three unreadable outcomes — every other resolved value is bridge_contract', async () => {
    for (const outcome of [
      'not_corrupt',
      'revision_conflict',
      'storage_failure',
      'invalid_owner',
      'TAMPERED',
      'wallet.tampered',
      'tampered ',
      '',
      42,
      null,
      undefined,
      true,
      ['tampered'],
      { failure: 'tampered' },
    ]) {
      mockDiscardCorruptWallet.mockResolvedValueOnce(outcome);
      await expectFailure(
        discardCorruptOfflineWallet(OWNER),
        'bridge_contract',
      );
    }
    for (const outcome of [
      'tampered',
      'integrity_key_missing',
      'unsupported_version',
    ] as const) {
      mockDiscardCorruptWallet.mockResolvedValueOnce(outcome);
      expect(await discardCorruptOfflineWallet(OWNER)).toBe(outcome);
    }
    mockDiscardCorruptWallet.mockRejectedValueOnce(
      nativeRejection('wallet.not_corrupt', 'wallet verifies; use clear'),
    );
    const notCorrupt = await expectFailure(
      discardCorruptOfflineWallet(OWNER),
      'not_corrupt',
    );
    expect(isOfflineWalletUnreadable(notCorrupt.failure)).toBe(false);
    expect(isOfflineWalletRetryable(notCorrupt.failure)).toBe(false);
  });

  it('attack: a partially linked module (any method missing or non-callable) is not_configured and nothing is invoked', async () => {
    for (const method of [
      'loadWallet',
      'replaceWallet',
      'clearWallet',
      'discardCorruptWallet',
    ]) {
      for (const replacement of [undefined, null, 'fn', {}]) {
        installNative({ [method]: replacement });
        expect(offlineWalletAvailable()).toBe(false);
        await expectFailure(loadOfflineWallet(OWNER), 'not_configured');
        await expectFailure(
          replaceOfflineWallet(OWNER, 0, emptyContents),
          'not_configured',
        );
        await expectFailure(clearOfflineWallet(OWNER, 1), 'not_configured');
        await expectFailure(
          discardCorruptOfflineWallet(OWNER),
          'not_configured',
        );
      }
    }
    for (const module of [null, 'module', 42, []]) {
      (NativeModules as NativeSlot).PickleOfflineWallet = module;
      expect(offlineWalletAvailable()).toBe(false);
      await expectFailure(loadOfflineWallet(OWNER), 'not_configured');
    }
    expect(mockLoadWallet).not.toHaveBeenCalled();
    expect(mockReplaceWallet).not.toHaveBeenCalled();
    expect(mockClearWallet).not.toHaveBeenCalled();
    expect(mockDiscardCorruptWallet).not.toHaveBeenCalled();
  });

  it('attack: on a non-iOS platform the wallet is not_configured even when a module object is present', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
    Object.defineProperty(Platform, 'OS', {
      value: 'android',
      configurable: true,
    });
    try {
      expect(offlineWalletAvailable()).toBe(false);
      await expectFailure(loadOfflineWallet(OWNER), 'not_configured');
      await expectFailure(
        replaceOfflineWallet(OWNER, 0, emptyContents),
        'not_configured',
      );
      expect(mockLoadWallet).not.toHaveBeenCalled();
      expect(mockReplaceWallet).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(Platform, 'OS', descriptor);
    }
  });

  it('attack: toOfflineWalletError is idempotent and never leaks a foreign error through as a known failure', () => {
    const typed = new OfflineWalletError('tampered', 'seal mismatch', -25293);
    expect(toOfflineWalletError(typed)).toBe(typed);
    expect(typed.code).toBe('wallet.tampered');
    expect(typed.status).toBe(-25293);
    expect(typed).toBeInstanceOf(Error);

    const foreign: Array<[unknown, OfflineWalletError['failure']]> = [
      [new TypeError('boom'), 'bridge_contract'],
      [
        Object.assign(new Error('x'), { failure: 'tampered' }),
        'bridge_contract',
      ],
      [
        Object.assign(new Error('x'), {
          code: 'tampered',
          failure: 'tampered',
        }),
        'bridge_contract',
      ],
      [Object.assign(new Error('x'), { code: 'wallet.tampered' }), 'tampered'],
      [{ code: 'wallet.tampered', message: 'duck' }, 'tampered'],
    ];
    for (const [error, failure] of foreign) {
      const mapped = toOfflineWalletError(error);
      expect(mapped).toBeInstanceOf(OfflineWalletError);
      expect(mapped.failure).toBe(failure);
      expect(mapped.code).toBe(`wallet.${failure}`);
      expect(isOfflineWalletUnreadable(mapped.failure)).toBe(
        failure === 'tampered',
      );
    }
  });
});
