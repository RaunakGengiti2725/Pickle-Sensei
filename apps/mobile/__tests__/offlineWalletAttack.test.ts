import { NativeModules } from 'react-native';

import {
  OfflineWalletError,
  type OfflineWalletSnapshot,
  clearOfflineWallet,
  loadOfflineWallet,
  replaceOfflineWallet,
  toOfflineWalletError,
} from '../src/native/offlineWallet';

/**
 * Adversarial matrix for the W05-01 JS bridge (candidate 6cdd3ab9). The
 * `JSON.parse` parity corpus is byte-for-byte the list in
 * native/vision-core/Tests/OfflineWalletAttackTests.swift
 * (`OfflineWalletAttackJsonCorpus`) — a verdict that differs between the two
 * files is a receipt one side stores that the other cannot read.
 *
 * Tests named `break: …` are EXPECTED TO FAIL on the candidate; every other
 * test passed and is an attack that did not break anything.
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

function storedSnapshot(
  overrides: Partial<OfflineWalletSnapshot> = {},
): OfflineWalletSnapshot {
  return {
    ownerId: OWNER,
    revision: 3,
    grants: [{ grantId: 'grant-1', compactJws: 'a.b.c' }],
    receipts: [{ receiptId: 'receipt-1', kind: 'result', payloadJson: '{}' }],
    ...overrides,
  };
}

async function expectFailure(
  promise: Promise<unknown>,
  failure: OfflineWalletError['failure'],
  context = '',
): Promise<OfflineWalletError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${failure} ${context}`);
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OfflineWalletError);
  expect([(error as OfflineWalletError).failure, context]).toEqual([
    failure,
    context,
  ]);
  return error as OfflineWalletError;
}

/** Same order, same texts, same verdicts as the Swift corpus. */
const JSON_CORPUS: ReadonlyArray<readonly [string, boolean]> = [
  ['{}', true],
  [' {} ', true],
  ['\t\n\r {}', true],
  ['{ }', true],
  ['{"a":1}', true],
  ['{"a":1}\n', true],
  ['{"":1}', true],
  ['{"a":1,"a":2}', true],
  ['{"__proto__":1}', true],
  ['{"a":-0}', true],
  ['{"a":1e5}', true],
  ['{"a":1E+5}', true],
  ['{"a":-1.5e-3}', true],
  ['{"a":1.0}', true],
  ['{"a":1e999}', true],
  ['{"a":true,"b":false,"c":null}', true],
  ['{"a":[]}', true],
  ['{"a":{}}', true],
  ['{"a":[1,{"b":null}]}', true],
  ['{"a":"\\u00e9"}', true],
  ['{"a":"\\ud800"}', true],
  ['{"a":"\\ud83d\\ude00"}', true],
  ['{"a":"😀"}', true],
  ['{"a":"\\/"}', true],
  ['{"a":"\\b\\f\\n\\r\\t\\"\\\\"}', true],
  ['{"a":"\\u0000"}', true],
  ['{"a":"\u007F"}', true],
  ['{"a":"\u2028\u2029"}', true],
  ['\uFEFF{}', false],
  ['{"a":1,}', false],
  ['[1]', false],
  ['[]', false],
  ['null', false],
  ['"text"', false],
  ['1', false],
  ['', false],
  [' ', false],
  ['{', false],
  ['}', false],
  ['{"a":01}', false],
  ['{"a":1.}', false],
  ['{"a":.5}', false],
  ['{"a":-}', false],
  ['{"a":+1}', false],
  ['{"a":0x10}', false],
  ['{"a":1e}', false],
  ['{"a":NaN}', false],
  ['{"a":Infinity}', false],
  ['{"a":tru}', false],
  ['{"a":True}', false],
  ['{"a":nul}', false],
  ['{a:1}', false],
  ["{'a':1}", false],
  ['{"a":\'1\'}', false],
  ['{"a":1}//c', false],
  ['{"a":1}/*c*/', false],
  ['{"a":1} {}', false],
  ['{"a":1}\u0000', false],
  ['\u00A0{}', false],
  ['{"a":[1,]}', false],
  ['{"a":[,1]}', false],
  ['{"a" 1}', false],
  ['{"a":1 "b":2}', false],
  ['{"a":"\\u12"}', false],
  ['{"a":"\\uGGGG"}', false],
  ['{"a":"\\x41"}', false],
  ['{"a":"\\\'"}', false],
  ['{"a":"x', false],
  ['{"a":"tab\there"}', false],
  ['{"a":"new\nline"}', false],
  ['{"a":"nul\u0000byte"}', false],
  ['{"a":[}', false],
  ['{"a":}', false],
  ['{,}', false],
  ['{"a"}', false],
  ['{"a":1,,"b":2}', false],
  ['{"a":1]', false],
  ['{"a":[1}}', false],
];

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

describe('offline wallet bridge — adversarial matrix', () => {
  it('JSON.parse parity: the shared corpus gets exactly the native verdicts', async () => {
    expect(JSON_CORPUS).toHaveLength(78);
    for (const [text, accepted] of JSON_CORPUS) {
      mockReplaceWallet.mockReset();
      mockReplaceWallet.mockResolvedValueOnce(
        storedSnapshot({
          revision: 4,
          grants: [],
          receipts: [{ receiptId: 'r', kind: 'result', payloadJson: text }],
        }),
      );
      const attempt = replaceOfflineWallet(OWNER, 3, {
        grants: [],
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: text }],
      });
      if (accepted) {
        const written = await attempt;
        expect([
          JSON.stringify(text),
          written.receipts[0]?.payloadJson,
        ]).toEqual([JSON.stringify(text), text]);
        expect(mockReplaceWallet).toHaveBeenCalledTimes(1);
      } else {
        await expectFailure(attempt, 'invalid_receipt', JSON.stringify(text));
        expect(mockReplaceWallet).not.toHaveBeenCalled();
      }
    }
  });

  it('a payload the native side could not have sealed is a contract breach on read', async () => {
    for (const [text, accepted] of JSON_CORPUS) {
      if (accepted) continue;
      mockLoadWallet.mockReset();
      mockLoadWallet.mockResolvedValueOnce(
        storedSnapshot({
          receipts: [{ receiptId: 'r', kind: 'result', payloadJson: text }],
        }),
      );
      await expectFailure(
        loadOfflineWallet(OWNER),
        'bridge_contract',
        JSON.stringify(text),
      );
    }
  });

  it('JSON.stringify never hands the wallet a raw unpaired surrogate; the escaped form is accepted on both sides', async () => {
    const serialized = JSON.stringify({ a: '\uD800', b: '\uDC00x', c: '😀' });
    expect(serialized).toBe('{"a":"\\ud800","b":"\\udc00x","c":"😀"}');
    expect(/[\uD800-\uDFFF]/u.test(serialized)).toBe(false);
    mockReplaceWallet.mockResolvedValueOnce(
      storedSnapshot({
        revision: 4,
        grants: [],
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: serialized }],
      }),
    );
    const written = await replaceOfflineWallet(OWNER, 3, {
      grants: [],
      receipts: [{ receiptId: 'r', kind: 'result', payloadJson: serialized }],
    });
    expect(written.receipts[0]?.payloadJson).toBe(serialized);
  });

  it('a non-integer, negative, NaN or unsafe expectedRevision is never coerced: it reaches native verbatim and the typed invalid_revision rejection surfaces', async () => {
    const bad = [
      Number.NaN,
      -1,
      -0.5,
      0.5,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      2 ** 53,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
    ];
    for (const revision of bad) {
      mockReplaceWallet.mockReset();
      mockClearWallet.mockReset();
      mockReplaceWallet.mockRejectedValueOnce(
        nativeRejection('wallet.invalid_revision', 'bad revision'),
      );
      mockClearWallet.mockRejectedValueOnce(
        nativeRejection('wallet.invalid_revision', 'bad revision'),
      );
      await expectFailure(
        replaceOfflineWallet(OWNER, revision, { grants: [], receipts: [] }),
        'invalid_revision',
        `replace ${String(revision)}`,
      );
      await expectFailure(
        clearOfflineWallet(OWNER, revision),
        'invalid_revision',
        `clear ${String(revision)}`,
      );
      // No Math.trunc / `| 0` / Number() laundering: a NaN must not become
      // revision 0 (a first-write claim) on the way to native.
      expect(mockReplaceWallet.mock.calls[0]?.[1]).toBe(revision);
      expect(mockClearWallet.mock.calls[0]?.[1]).toBe(revision);
    }
  });

  it('safe-integer revisions at both edges pass through unchanged', async () => {
    for (const revision of [0, 1, Number.MAX_SAFE_INTEGER - 1]) {
      mockReplaceWallet.mockReset();
      mockReplaceWallet.mockResolvedValueOnce(
        storedSnapshot({ revision: revision + 1 }),
      );
      const written = await replaceOfflineWallet(OWNER, revision, {
        grants: [],
        receipts: [],
      });
      expect(written.revision).toBe(revision + 1);
      expect(mockReplaceWallet).toHaveBeenCalledWith(OWNER, revision, {
        grants: [],
        receipts: [],
      });
    }
    mockClearWallet.mockResolvedValueOnce(null);
    await clearOfflineWallet(OWNER, Number.MAX_SAFE_INTEGER);
    expect(mockClearWallet).toHaveBeenCalledWith(
      OWNER,
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('a non-canonical owner is forwarded verbatim and the native invalid_owner rejection stays typed', async () => {
    const bad = [
      '',
      ' ',
      OWNER.toUpperCase(),
      `${OWNER} `,
      OWNER.replace('-', '_'),
      'wallet.v1.x',
      '../fence.v1.x',
      OWNER.slice(0, 35),
      `${OWNER}0`,
    ];
    for (const ownerId of bad) {
      mockLoadWallet.mockReset();
      mockLoadWallet.mockRejectedValueOnce(
        nativeRejection(
          'wallet.invalid_owner',
          'ownerId must be a canonical UUID',
        ),
      );
      const error = await expectFailure(
        loadOfflineWallet(ownerId),
        'invalid_owner',
        JSON.stringify(ownerId),
      );
      expect(error.status).toBeNull();
      expect(mockLoadWallet).toHaveBeenCalledWith(ownerId);
    }
  });

  it('snapshot revision edges: 0, -0, fractions, 2^53, strings and bigints are contract breaches; MAX_SAFE_INTEGER is not', async () => {
    const rejected: unknown[] = [
      0,
      -0,
      -1,
      1.5,
      2 ** 53,
      Number.MAX_SAFE_INTEGER + 2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '3',
      BigInt(3),
      null,
      undefined,
      true,
    ];
    for (const revision of rejected) {
      mockLoadWallet.mockReset();
      mockLoadWallet.mockResolvedValueOnce({ ...storedSnapshot(), revision });
      await expectFailure(
        loadOfflineWallet(OWNER),
        'bridge_contract',
        `revision ${String(revision)}`,
      );
    }
    mockLoadWallet.mockResolvedValueOnce(
      storedSnapshot({ revision: Number.MAX_SAFE_INTEGER }),
    );
    expect((await loadOfflineWallet(OWNER))?.revision).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('snapshot contents that the native core would refuse are contract breaches, never data', async () => {
    const receipt = (id: string) => ({
      receiptId: id,
      kind: 'result' as const,
      payloadJson: '{}',
    });
    const malformed: Array<[string, Partial<Record<string, unknown>>]> = [
      [
        '65 receipts',
        { receipts: Array.from({ length: 65 }, (_, i) => receipt(`r${i}`)) },
      ],
      [
        '9 grants',
        {
          grants: Array.from({ length: 9 }, (_, i) => ({
            grantId: `g${i}`,
            compactJws: 'a.b.c',
          })),
        },
      ],
      [
        'duplicate grantId',
        {
          grants: [
            { grantId: 'g', compactJws: 'a.b.c' },
            { grantId: 'g', compactJws: 'd.e.f' },
          ],
        },
      ],
      ['duplicate receiptId', { receipts: [receipt('r'), receipt('r')] }],
      ['empty grantId', { grants: [{ grantId: '', compactJws: 'a.b.c' }] }],
      ['empty compactJws', { grants: [{ grantId: 'g', compactJws: '' }] }],
      ['empty receiptId', { receipts: [receipt('')] }],
      ['unknown kind', { receipts: [{ ...receipt('r'), kind: 'refund' }] }],
      [
        'array payloadJson',
        { receipts: [{ ...receipt('r'), payloadJson: '[]' }] },
      ],
      [
        'BOM payloadJson',
        { receipts: [{ ...receipt('r'), payloadJson: '\uFEFF{}' }] },
      ],
      [
        'grants object',
        { grants: { length: 1, 0: { grantId: 'g', compactJws: 'a.b.c' } } },
      ],
      ['receipts null', { receipts: null }],
      ['grant null', { grants: [null] }],
      ['other owner', { ownerId: OTHER_OWNER }],
      [
        'array snapshot',
        undefined as unknown as Partial<Record<string, unknown>>,
      ],
    ];
    for (const [name, override] of malformed) {
      mockLoadWallet.mockReset();
      mockLoadWallet.mockResolvedValueOnce(
        override === undefined
          ? [storedSnapshot()]
          : { ...storedSnapshot(), ...override },
      );
      await expectFailure(loadOfflineWallet(OWNER), 'bridge_contract', name);
    }
  });

  it('double submit: two replaces with the same expectedRevision resolve independently and out of order', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    mockReplaceWallet
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveFirst = resolve;
          }),
      )
      .mockRejectedValueOnce(
        nativeRejection(
          'wallet.revision_conflict',
          'stored revision 4 != expected 3',
        ),
      );
    const first = replaceOfflineWallet(OWNER, 3, {
      grants: [],
      receipts: [{ receiptId: 'r-1', kind: 'result', payloadJson: '{"n":1}' }],
    });
    const second = replaceOfflineWallet(OWNER, 3, {
      grants: [],
      receipts: [{ receiptId: 'r-2', kind: 'result', payloadJson: '{"n":2}' }],
    });
    const conflict = await expectFailure(second, 'revision_conflict');
    expect(conflict.message).toBe('stored revision 4 != expected 3');
    expect(resolveFirst).toBeDefined();
    resolveFirst?.(
      storedSnapshot({
        revision: 4,
        grants: [],
        receipts: [
          { receiptId: 'r-1', kind: 'result', payloadJson: '{"n":1}' },
        ],
      }),
    );
    const written = await first;
    expect(written.revision).toBe(4);
    expect(written.receipts.map(r => r.receiptId)).toEqual(['r-1']);
    expect(mockReplaceWallet.mock.calls.map(call => call[1])).toEqual([3, 3]);
  });

  it('interleaved account switch: a load for owner A that resolves with owner B is refused, and vice versa', async () => {
    mockLoadWallet
      .mockResolvedValueOnce(storedSnapshot({ ownerId: OTHER_OWNER }))
      .mockResolvedValueOnce(storedSnapshot({ ownerId: OWNER }));
    const [a, b] = await Promise.allSettled([
      loadOfflineWallet(OWNER),
      loadOfflineWallet(OTHER_OWNER),
    ]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    for (const settled of [a, b]) {
      if (settled.status !== 'rejected') continue;
      expect(settled.reason).toBeInstanceOf(OfflineWalletError);
      expect((settled.reason as OfflineWalletError).failure).toBe(
        'bridge_contract',
      );
    }
  });

  it('contents are forwarded as plain own-data copies: getter-backed fields never reach native as live accessors', async () => {
    let jwsReads = 0;
    let payloadReads = 0;
    const grant = {
      grantId: 'g',
      get compactJws() {
        jwsReads += 1;
        return 'a.b.c';
      },
    };
    const receipt = {
      receiptId: 'r',
      kind: 'result' as const,
      get payloadJson() {
        payloadReads += 1;
        return '{"ok":true}';
      },
    };
    mockReplaceWallet.mockResolvedValueOnce(
      storedSnapshot({
        revision: 4,
        grants: [{ grantId: 'g', compactJws: 'a.b.c' }],
        receipts: [
          { receiptId: 'r', kind: 'result', payloadJson: '{"ok":true}' },
        ],
      }),
    );
    await replaceOfflineWallet(OWNER, 3, {
      grants: [grant],
      receipts: [receipt],
    });
    const forwarded = mockReplaceWallet.mock.calls[0]?.[2] as {
      grants: Array<{ grantId: string; compactJws: string }>;
      receipts: Array<{ receiptId: string; kind: string; payloadJson: string }>;
    };
    expect(forwarded.grants).toEqual([{ grantId: 'g', compactJws: 'a.b.c' }]);
    expect(forwarded.receipts).toEqual([
      { receiptId: 'r', kind: 'result', payloadJson: '{"ok":true}' },
    ]);
    expect(
      Object.getOwnPropertyDescriptor(forwarded.grants[0], 'compactJws')?.get,
    ).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(forwarded.receipts[0], 'payloadJson')
        ?.get,
    ).toBeUndefined();
    expect(jwsReads).toBeGreaterThan(0);
    expect(payloadReads).toBeGreaterThan(0);
  });

  it('error mapping edges: prefix-only, wrong-case, superset and non-object rejections are contract breaches with a safe message', () => {
    const contract = [
      nativeRejection('wallet.', 'x'),
      nativeRejection('WALLET.TAMPERED', 'x'),
      nativeRejection('wallet.tamperedx', 'x'),
      nativeRejection('wallet.Tampered', 'x'),
      nativeRejection(' wallet.tampered', 'x'),
      nativeRejection('wallet.not_configured', 'x'),
      nativeRejection('wallet.bridge_contract', 'x'),
      Object.assign(new Error('x'), { code: 42 }),
      'wallet.tampered',
      null,
      undefined,
      42,
    ];
    for (const error of contract) {
      const mapped = toOfflineWalletError(error);
      expect([mapped.failure, error]).toEqual(['bridge_contract', error]);
      expect(mapped.message.length).toBeGreaterThan(0);
    }
    const emptyMessage = toOfflineWalletError({
      code: 'wallet.tampered',
      message: '',
    });
    expect([emptyMessage.failure, emptyMessage.message.length > 0]).toEqual([
      'tampered',
      true,
    ]);
    for (const status of [
      -25300.5,
      Number.NaN,
      '-25300',
      Number.POSITIVE_INFINITY,
      null,
      undefined,
    ]) {
      const mapped = toOfflineWalletError(
        nativeRejection('wallet.storage_failure', 'x', { status }),
      );
      expect([mapped.failure, mapped.status]).toEqual([
        'storage_failure',
        null,
      ]);
    }
    expect(
      toOfflineWalletError(
        nativeRejection('wallet.storage_denied', 'x', { status: -34018 }),
      ).status,
    ).toBe(-34018);
  });
});
