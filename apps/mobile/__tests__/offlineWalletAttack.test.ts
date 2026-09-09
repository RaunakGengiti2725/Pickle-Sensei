import { NativeModules } from 'react-native';

import {
  OFFLINE_WALLET_LIMITS,
  OfflineWalletError,
  type OfflineWalletContents,
  type OfflineWalletSnapshot,
  clearOfflineWallet,
  discardCorruptOfflineWallet,
  loadOfflineWallet,
  replaceOfflineWallet,
  toOfflineWalletError,
} from '../src/native/offlineWallet';

/**
 * Adversarial matrix for the W05-01 JS bridge (candidate 2376305d): malformed
 * native return values, hostile caller input, boundary revisions and the JSON
 * grammar the native scanner must agree with. Native is a mock — everything
 * here is the JS side's own contract.
 */

const OWNER = '0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b';

const mockLoadWallet = jest.fn<Promise<unknown>, [string]>();
const mockReplaceWallet = jest.fn<
  Promise<unknown>,
  [string, number, unknown]
>();
const mockClearWallet = jest.fn<Promise<unknown>, [string, number]>();
const mockDiscardCorruptWallet = jest.fn<Promise<unknown>, [string]>();

type NativeSlot = { PickleOfflineWallet?: unknown };

const baseSnapshot: OfflineWalletSnapshot = {
  ownerId: OWNER,
  revision: 3,
  grants: [{ grantId: 'grant-1', compactJws: 'a.b.c' }],
  receipts: [{ receiptId: 'receipt-1', kind: 'result', payloadJson: '{}' }],
};

async function failureOf(
  promise: Promise<unknown>,
): Promise<OfflineWalletError['failure'] | 'RESOLVED' | 'UNTYPED'> {
  return promise.then(
    () => 'RESOLVED' as const,
    (caught: unknown) =>
      caught instanceof OfflineWalletError
        ? caught.failure
        : ('UNTYPED' as const),
  );
}

beforeEach(() => {
  mockLoadWallet.mockReset();
  mockReplaceWallet.mockReset();
  mockClearWallet.mockReset();
  mockDiscardCorruptWallet.mockReset();
  (NativeModules as NativeSlot).PickleOfflineWallet = {
    loadWallet: mockLoadWallet,
    replaceWallet: mockReplaceWallet,
    clearWallet: mockClearWallet,
    discardCorruptWallet: mockDiscardCorruptWallet,
  };
});

afterAll(() => {
  delete (NativeModules as NativeSlot).PickleOfflineWallet;
});

/**
 * Same corpus as `native/vision-core/Tests/OfflineWalletAttackTests.swift`
 * (`jsonCorpus`): the expected verdict is what this runtime's `JSON.parse`
 * produces, so both sides are pinned to one grammar.
 */
const JSON_CORPUS: Array<[string, boolean]> = [
  ['{}', true],
  [' {} ', true],
  ['\u{9}{\u{A}}\u{D}', true],
  ['{"a":1}', true],
  ['{"a":01}', false],
  ['{"a":1.}', false],
  ['{"a":.5}', false],
  ['{"a":-0}', true],
  ['{"a":-}', false],
  ['{"a":1e5}', true],
  ['{"a":1E+5}', true],
  ['{"a":1e}', false],
  ['{"a":+1}', false],
  ['{"a":1e400}', true],
  ['{"a":-0.0e-0}', true],
  ['{"a":"\\u0000"}', true],
  ['{"a":"\\uD800"}', true],
  ['{"a":"\\ud800\\udc00"}', true],
  ['{"a":"\\uZZZZ"}', false],
  ['{"a":"\\u12"}', false],
  ['{"a":"\\x41"}', false],
  ['{"a":"\\/"}', true],
  ['{"a":"\\a"}', false],
  ['{"a":"\\\'"}', false],
  ['{"a":"\u{9}"}', false],
  ['{"a":"\u{7F}"}', true],
  ['{"a":"\u{E9}"}', true],
  ['{"a":"\u{2028}\u{2029}"}', true],
  ['{"a":[]}', true],
  ['{"a":[1,]}', false],
  ['{"a":[,1]}', false],
  ['{"a":[1 2]}', false],
  ['{"a":{}}', true],
  ['{"a":{"b":}}', false],
  ['{"a":1,}', false],
  ['{,"a":1}', false],
  ['{"a" 1}', false],
  ['{a:1}', false],
  ['{"a":1}{}', false],
  ['{"a":1} 1', false],
  ['{"a":true}', true],
  ['{"a":True}', false],
  ['{"a":nul}', false],
  ['{"a":null}', true],
  ['{"a":NaN}', false],
  ['{"a":Infinity}', false],
  ['{"a":undefined}', false],
  ['{"":1}', true],
  ['{"a":1,"a":2}', true],
  ['{"__proto__":1}', true],
  ['[]', false],
  ['null', false],
  ['1', false],
  ['"x"', false],
  ['', false],
  [' ', false],
  ['\u{FEFF}{}', false],
  ['{}\u{0}', false],
  ['{"a":"\u{0}"}', false],
  ['{"a":"\\"}', false],
  ['{"a":"\\', false],
  ['{"a":"', false],
  ['{"a":"\\u00"}', false],
  ['{"a":"\\uABCD"}', true],
  ['{"a":"\\uabcd"}', true],
  ['{"a":[[[[[[[[[[]]]]]]]]]]}', true],
  ['{"a":[[[]]}', false],
  ['{"a":[[]]]}', false],
  ['{"a":1 , "b" : [ 2 , 3 ] }', true],
  ['{"a":"}"}', true],
  ['{"a":"\\\\"}', true],
  ['{"a": -12.5e-3}', true],
  ['{"a":00}', false],
  ['{"a":0}', true],
  ['{"a":1.0}', true],
  ['\u{A0}{}', false],
  ['\u{2028}{}', false],
  ['{}\u{B}', false],
  ['{"a":1}//c', false],
  ['{"a":1}/*c*/', false],
  ['{"a":\'b\'}', false],
];

describe('offline wallet bridge — adversarial', () => {
  it('attack J1: the JSON corpus verdicts are exactly JSON.parse-object verdicts', () => {
    for (const [text, expected] of JSON_CORPUS) {
      let parsedAsObject: boolean;
      try {
        const parsed: unknown = JSON.parse(text);
        parsedAsObject =
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed);
      } catch {
        parsedAsObject = false;
      }
      expect({ text, parsedAsObject }).toEqual({
        text,
        parsedAsObject: expected,
      });
    }
  });

  it('attack J1b: the write preflight and the read-back rule agree with the corpus', async () => {
    for (const [text, expected] of JSON_CORPUS) {
      const contents: OfflineWalletContents = {
        grants: [],
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: text }],
      };
      if (expected) {
        mockReplaceWallet.mockResolvedValueOnce({
          ...baseSnapshot,
          grants: [],
          receipts: contents.receipts,
        });
      }
      const write = await failureOf(replaceOfflineWallet(OWNER, 3, contents));
      expect({ text, write }).toEqual({
        text,
        write: expected ? 'RESOLVED' : 'invalid_receipt',
      });
      mockLoadWallet.mockResolvedValueOnce({
        ...baseSnapshot,
        grants: [],
        receipts: contents.receipts,
      });
      const read = await failureOf(loadOfflineWallet(OWNER));
      expect({ text, read }).toEqual({
        text,
        read: expected ? 'RESOLVED' : 'bridge_contract',
      });
    }
    expect(mockReplaceWallet).toHaveBeenCalledTimes(
      JSON_CORPUS.filter(([, ok]) => ok).length,
    );
  });

  it('attack J2: hostile contents never reach native and never escape untyped', async () => {
    const hostile: unknown[] = [
      null,
      undefined,
      0,
      1,
      '',
      'grants',
      true,
      Symbol('contents'),
      () => ({ grants: [], receipts: [] }),
      [],
      [{ grants: [], receipts: [] }],
      new Map(),
      new Date(0),
      { grants: null, receipts: [] },
      { grants: [], receipts: null },
      { grants: {}, receipts: [] },
      { grants: 'a.b.c', receipts: [] },
      { grants: new Set(), receipts: [] },
      { grants: [null], receipts: [] },
      { grants: [undefined], receipts: [] },
      { grants: ['a.b.c'], receipts: [] },
      { grants: [[]], receipts: [] },
      { grants: [{ grantId: 1, compactJws: 'a.b.c' }], receipts: [] },
      { grants: [{ grantId: 'g', compactJws: ['a.b.c'] }], receipts: [] },
      { grants: [{ grantId: 'g' }], receipts: [] },
      { grants: [], receipts: [null] },
      { grants: [], receipts: [{ receiptId: 'r', kind: 'result' }] },
      {
        grants: [],
        receipts: [{ receiptId: 'r', kind: 'Result', payloadJson: '{}' }],
      },
      {
        grants: [],
        receipts: [{ receiptId: 'r', kind: ['result'], payloadJson: '{}' }],
      },
      {
        grants: [],
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: {} }],
      },
      {
        grants: [],
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: null }],
      },
      {
        grants: [],
        receipts: [
          { receiptId: 'r', kind: 'result', payloadJson: '{}' },
          { receiptId: 'r', kind: 'unused_ticket_return', payloadJson: '{}' },
        ],
      },
      {
        grants: [
          { grantId: 'g', compactJws: 'a.b.c' },
          { grantId: 'g', compactJws: 'x.y.z' },
        ],
        receipts: [],
      },
      {
        grants: Array.from(
          { length: OFFLINE_WALLET_LIMITS.maxGrants + 1 },
          () => null,
        ),
        receipts: [],
      },
      { grants: new Array(OFFLINE_WALLET_LIMITS.maxGrants + 1), receipts: [] },
      {
        grants: [],
        receipts: new Array(OFFLINE_WALLET_LIMITS.maxReceipts + 1),
      },
    ];
    for (const contents of hostile) {
      const outcome = await failureOf(
        replaceOfflineWallet(OWNER, 1, contents as OfflineWalletContents),
      );
      expect({ contents, outcome }).not.toEqual({
        contents,
        outcome: 'UNTYPED',
      });
      expect({ contents, outcome }).not.toEqual({
        contents,
        outcome: 'RESOLVED',
      });
      expect([
        'invalid_grant',
        'invalid_receipt',
        'capacity_exceeded',
      ]).toContain(outcome);
    }
    expect(mockReplaceWallet).not.toHaveBeenCalled();
  });

  it('attack J2b: recorded — sparse arrays and inherited fields pass the preflight and reach native', async () => {
    // A hole is skipped by Array.prototype.map, so the validated payload still
    // carries the hole; native's typed parse (not JS) is what refuses it.
    const sparse: unknown[] = [];
    sparse[1] = { grantId: 'g', compactJws: 'a.b.c' };
    mockReplaceWallet.mockResolvedValueOnce({ ...baseSnapshot, receipts: [] });
    await replaceOfflineWallet(OWNER, 3, {
      grants: sparse as OfflineWalletContents['grants'],
      receipts: [],
    });
    const forwarded = mockReplaceWallet.mock.calls[0]?.[2] as {
      grants: unknown[];
    };
    expect(forwarded.grants.length).toBe(2);
    expect(0 in forwarded.grants).toBe(false);

    const inherited = Object.create({
      grants: [{ grantId: 'g', compactJws: 'a.b.c' }],
      receipts: [],
    }) as OfflineWalletContents;
    mockReplaceWallet.mockResolvedValueOnce({ ...baseSnapshot, receipts: [] });
    await replaceOfflineWallet(OWNER, 3, inherited);
    expect(mockReplaceWallet).toHaveBeenCalledTimes(2);
  });

  it('attack J3: expectedRevision is forwarded unvalidated — native is the only revision gate', async () => {
    for (const revision of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      0.5,
      2 ** 53,
      -0,
    ]) {
      mockReplaceWallet.mockRejectedValueOnce(
        Object.assign(new Error('revision'), {
          code: 'wallet.invalid_revision',
        }),
      );
      expect(
        await failureOf(
          replaceOfflineWallet(OWNER, revision, { grants: [], receipts: [] }),
        ),
      ).toBe('invalid_revision');
      expect(mockReplaceWallet).toHaveBeenLastCalledWith(OWNER, revision, {
        grants: [],
        receipts: [],
      });
      mockClearWallet.mockRejectedValueOnce(
        Object.assign(new Error('revision'), {
          code: 'wallet.invalid_revision',
        }),
      );
      expect(await failureOf(clearOfflineWallet(OWNER, revision))).toBe(
        'invalid_revision',
      );
    }
  });

  it('attack J4: malformed native snapshots are always bridge_contract, never a wallet', async () => {
    const malformed: unknown[] = [
      0,
      1,
      '',
      'snapshot',
      true,
      [],
      [baseSnapshot],
      { ...baseSnapshot, ownerId: OWNER.toUpperCase() },
      { ...baseSnapshot, ownerId: `${OWNER} ` },
      { ...baseSnapshot, ownerId: undefined },
      { ...baseSnapshot, revision: 0 },
      { ...baseSnapshot, revision: -0 },
      { ...baseSnapshot, revision: -1 },
      { ...baseSnapshot, revision: 1.5 },
      { ...baseSnapshot, revision: 2 ** 53 },
      { ...baseSnapshot, revision: Number.NaN },
      { ...baseSnapshot, revision: Number.POSITIVE_INFINITY },
      { ...baseSnapshot, revision: '3' },
      { ...baseSnapshot, revision: 3n },
      { ...baseSnapshot, revision: undefined },
      { ...baseSnapshot, grants: undefined },
      { ...baseSnapshot, receipts: undefined },
      { ...baseSnapshot, grants: {} },
      { ...baseSnapshot, grants: [null] },
      { ...baseSnapshot, grants: [{ grantId: 'g' }] },
      { ...baseSnapshot, receipts: [{ receiptId: 'r', kind: 'result' }] },
      {
        ...baseSnapshot,
        receipts: [{ receiptId: 'r', kind: 'other', payloadJson: '{}' }],
      },
      {
        ...baseSnapshot,
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: '[]' }],
      },
      {
        ...baseSnapshot,
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: 'null' }],
      },
      {
        ...baseSnapshot,
        receipts: [{ receiptId: 'r', kind: 'result', payloadJson: '{}x' }],
      },
      {
        ...baseSnapshot,
        receipts: [
          { receiptId: 'r', kind: 'result', payloadJson: '{}' },
          { receiptId: 'r', kind: 'result', payloadJson: '{}' },
        ],
      },
      {
        ...baseSnapshot,
        grants: Array.from({ length: 9 }, (_, i) => ({
          grantId: `g${i}`,
          compactJws: 'a.b.c',
        })),
      },
    ];
    for (const value of malformed) {
      mockLoadWallet.mockResolvedValueOnce(value);
      const load = await failureOf(loadOfflineWallet(OWNER));
      expect({ value, load }).toEqual({ value, load: 'bridge_contract' });
      mockReplaceWallet.mockResolvedValueOnce(value);
      const replace = await failureOf(
        replaceOfflineWallet(OWNER, 3, { grants: [], receipts: [] }),
      );
      expect({ value, replace }).toEqual({ value, replace: 'bridge_contract' });
    }
    // Extra keys are dropped, whitespace-only payload rejected, at-limit accepted.
    mockLoadWallet.mockResolvedValueOnce({ ...baseSnapshot, extra: 1 });
    expect(await loadOfflineWallet(OWNER)).toEqual(baseSnapshot);
    mockLoadWallet.mockResolvedValueOnce({
      ...baseSnapshot,
      receipts: [{ receiptId: 'r', kind: 'result', payloadJson: ' ' }],
    });
    expect(await failureOf(loadOfflineWallet(OWNER))).toBe('bridge_contract');
    mockLoadWallet.mockResolvedValueOnce({
      ...baseSnapshot,
      revision: Number.MAX_SAFE_INTEGER,
    });
    expect((await loadOfflineWallet(OWNER))?.revision).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('attack J5: every hostile rejection shape maps to a typed error with a stable code', () => {
    const cases: Array<
      [unknown, OfflineWalletError['failure'], number | null]
    > = [
      [undefined, 'bridge_contract', null],
      [null, 'bridge_contract', null],
      ['wallet.tampered', 'bridge_contract', null],
      [42, 'bridge_contract', null],
      [new Error('plain'), 'bridge_contract', null],
      [{ code: 'wallet.' }, 'bridge_contract', null],
      [{ code: 'wallet.TAMPERED' }, 'bridge_contract', null],
      [{ code: 'wallet.tampered ' }, 'bridge_contract', null],
      [{ code: ' wallet.tampered' }, 'bridge_contract', null],
      [{ code: 'wallet.not_configured' }, 'bridge_contract', null],
      [{ code: 'wallet.bridge_contract' }, 'bridge_contract', null],
      [{ code: 'wallet.tampered.extra' }, 'bridge_contract', null],
      [{ code: ['wallet.tampered'] }, 'bridge_contract', null],
      [
        { code: 'wallet.tampered', userInfo: { status: 1.5 } },
        'tampered',
        null,
      ],
      [
        { code: 'wallet.tampered', userInfo: { status: '-25300' } },
        'tampered',
        null,
      ],
      [
        { code: 'wallet.tampered', userInfo: { status: Number.NaN } },
        'tampered',
        null,
      ],
      [
        { code: 'wallet.tampered', userInfo: { status: -25300 } },
        'tampered',
        -25300,
      ],
      [{ code: 'wallet.tampered', userInfo: null }, 'tampered', null],
      [{ code: 'wallet.tampered', userInfo: 'status' }, 'tampered', null],
      [
        { code: 'wallet.storage_failure', message: '' },
        'storage_failure',
        null,
      ],
      [{ code: 'wallet.storage_failure', message: 7 }, 'storage_failure', null],
      [Object.create({ code: 'wallet.tampered' }), 'tampered', null],
    ];
    for (const [thrown, failure, status] of cases) {
      const mapped = toOfflineWalletError(thrown);
      expect({
        thrown,
        failure: mapped.failure,
        status: mapped.status,
      }).toEqual({
        thrown,
        failure,
        status,
      });
      expect(mapped.code).toBe(`wallet.${failure}`);
      expect(mapped.message.length).toBeGreaterThan(0);
      expect(mapped).toBeInstanceOf(Error);
    }
    const passthrough = new OfflineWalletError('revision_conflict', 'x', 7);
    expect(toOfflineWalletError(passthrough)).toBe(passthrough);
  });

  it('attack J6: discard outcomes that are not unreadable-state failures are a contract breach', async () => {
    for (const value of [
      undefined,
      null,
      '',
      'TAMPERED',
      'tampered ',
      'wallet.tampered',
      'not_corrupt',
      'revision_conflict',
      'storage_failure',
      'invalid_owner',
      ['tampered'],
      { failure: 'tampered' },
      0,
    ]) {
      mockDiscardCorruptWallet.mockResolvedValueOnce(value);
      expect(await failureOf(discardCorruptOfflineWallet(OWNER))).toBe(
        'bridge_contract',
      );
    }
    for (const value of [
      'tampered',
      'integrity_key_missing',
      'unsupported_version',
    ]) {
      mockDiscardCorruptWallet.mockResolvedValueOnce(value);
      expect(await discardCorruptOfflineWallet(OWNER)).toBe(value);
    }
  });

  it('attack J7: a native rejection that lies about being a snapshot cannot resolve a wallet', async () => {
    // Native resolves the *rejection object* instead of rejecting.
    mockLoadWallet.mockResolvedValueOnce(
      Object.assign(new Error('tampered'), { code: 'wallet.tampered' }),
    );
    expect(await failureOf(loadOfflineWallet(OWNER))).toBe('bridge_contract');
    // Native rejects with a snapshot-shaped object.
    mockLoadWallet.mockRejectedValueOnce(baseSnapshot);
    expect(await failureOf(loadOfflineWallet(OWNER))).toBe('bridge_contract');
    // Native returns another owner's wallet for an interleaved account switch.
    const other = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    mockLoadWallet.mockResolvedValueOnce({ ...baseSnapshot, ownerId: other });
    expect(await failureOf(loadOfflineWallet(OWNER))).toBe('bridge_contract');
    mockReplaceWallet.mockResolvedValueOnce({
      ...baseSnapshot,
      ownerId: other,
    });
    expect(
      await failureOf(
        replaceOfflineWallet(OWNER, 3, { grants: [], receipts: [] }),
      ),
    ).toBe('bridge_contract');
    // Concurrent double submit: both calls are forwarded independently with
    // the caller's own expected revision — JS adds no coalescing.
    mockReplaceWallet
      .mockResolvedValueOnce({ ...baseSnapshot, revision: 4 })
      .mockRejectedValueOnce(
        Object.assign(new Error('stale'), { code: 'wallet.revision_conflict' }),
      );
    const [first, second] = await Promise.all([
      replaceOfflineWallet(OWNER, 3, { grants: [], receipts: [] }),
      failureOf(replaceOfflineWallet(OWNER, 3, { grants: [], receipts: [] })),
    ]);
    expect(first.revision).toBe(4);
    expect(second).toBe('revision_conflict');
  });

  it('attack J8: recorded — lone surrogates in payloadJson pass the JS preflight verbatim', async () => {
    // JSON.parse accepts a raw lone surrogate inside a string literal, so the
    // preflight forwards it; whether the iOS bridge delivers those code units
    // to native unchanged is not observable here.
    const text = `{"a":"${'\uD800'}"}`;
    mockReplaceWallet.mockResolvedValueOnce({
      ...baseSnapshot,
      grants: [],
      receipts: [{ receiptId: 'r', kind: 'result', payloadJson: text }],
    });
    await replaceOfflineWallet(OWNER, 3, {
      grants: [],
      receipts: [{ receiptId: 'r', kind: 'result', payloadJson: text }],
    });
    const forwarded = mockReplaceWallet.mock.calls[0]?.[2] as {
      receipts: Array<{ payloadJson: string }>;
    };
    expect(forwarded.receipts[0]?.payloadJson).toBe(text);
    // The text is not well-formed UTF-16: the surrogate has no pair.
    expect(text.charCodeAt(6)).toBe(0xd800);
    expect(text.codePointAt(6)).toBe(0xd800);
  });
});
