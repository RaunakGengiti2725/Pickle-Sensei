import { NativeModules } from 'react-native';

import {
  OfflineWalletError,
  type OfflineWalletSnapshot,
  loadOfflineWallet,
  replaceOfflineWallet,
} from '../src/native/offlineWallet';

/**
 * Adversarial matrix for the W05-01 JS bridge (candidate 10af6490). Each test
 * is one attack at a boundary of `src/native/offlineWallet.ts`; a failing test
 * is a reproduced break, a passing one is an attack the wrapper withstood.
 * The native module is a mock so the wrapper's own pre-validation and
 * read-back rules are what is under test.
 */

const OWNER = '0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b';

const mockLoadWallet = jest.fn<Promise<unknown>, [unknown]>();
const mockReplaceWallet = jest.fn<
  Promise<unknown>,
  [unknown, unknown, unknown]
>();
const mockClearWallet = jest.fn<Promise<unknown>, [unknown, unknown]>();
const mockDiscardCorruptWallet = jest.fn<Promise<unknown>, [unknown]>();

type NativeSlot = { PickleOfflineWallet?: unknown };

function installNative() {
  (NativeModules as NativeSlot).PickleOfflineWallet = {
    loadWallet: mockLoadWallet,
    replaceWallet: mockReplaceWallet,
    clearWallet: mockClearWallet,
    discardCorruptWallet: mockDiscardCorruptWallet,
  };
}

function snapshotFor(revision: number): OfflineWalletSnapshot {
  return { ownerId: OWNER, revision, grants: [], receipts: [] };
}

async function settle(
  promise: Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  return promise.then(
    value => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/**
 * Shared with native/vision-core/Tests/OfflineWalletAttackTests.swift
 * (`OfflineWalletAttackCorpus.jsonParity`): the second column is the
 * JSON.parse verdict the native strict scanner must reproduce.
 */
const JSON_PARITY: ReadonlyArray<readonly [string, boolean]> = [
  ['{}', true],
  ['{"a":1}', true],
  [' \t\n\r{"a":1}\r\n\t ', true],
  ['{"a":0e0}', true],
  ['{"a":-0.0e-0}', true],
  ['{"a":1E+0}', true],
  ['{"a":1e007}', true],
  ['{"a":1e400}', true],
  ['{"a":123456789012345678901234567890}', true],
  ['{"a":"\\u0000"}', true],
  ['{"a":"\\uD83D\\uDE00"}', true],
  ['{"a":"\\ud800"}', true],
  ['{"a":"\\/\\b\\f\\n\\r\\t\\"\\\\"}', true],
  ['{"a":"\u007f"}', true],
  ['{"a":"\u2028\u2029"}', true],
  ['{"a\u200b":1}', true],
  ['{"":{"":{"":{}}}}', true],
  ['{"a":[{"b":[{"c":{}}]}]}', true],
  ['{"a":1,"a":2}', true],
  ['{"__proto__":1}', true],
  ['{"a":"\\"}"}', true],
  ['{"a":[]}', true],
  ['{"a":null,"b":true,"c":false}', true],
  ['', false],
  [' ', false],
  ['{', false],
  ['{"a":1', false],
  ['{"a":"', false],
  ['{"a":"\\"}', false],
  ['[{}]', false],
  ['"str"', false],
  ['1', false],
  ['null', false],
  ['{"a":1}}', false],
  ['{{"a":1}}', false],
  ['{"a":1}\u0000', false],
  ['{"a":1}\u2028', false],
  ['\ufeff{"a":1}', false],
  ['\u00a0{"a":1}', false],
  ['\u000b{"a":1}', false],
  ['\u000c{"a":1}', false],
  ['{"a":"\t"}', false],
  ['{"a":"\n"}', false],
  ['{"a":"\u0001"}', false],
  ['{"a":.5}', false],
  ['{"a":5.}', false],
  ['{"a":05}', false],
  ['{"a":+5}', false],
  ['{"a":-}', false],
  ['{"a":-01}', false],
  ['{"a":1.5e}', false],
  ['{"a":1e-}', false],
  ['{"a":1e5.5}', false],
  ['{"a":0x10}', false],
  ['{"a":Infinity}', false],
  ['{"a":NaN}', false],
  ['{"a":nul}', false],
  ['{"a":NULL}', false],
  ['{"a":truE}', false],
  ['{"a":nulls}', false],
  ['{"a":"\\\'"}', false],
  ['{"a":"\\U0041"}', false],
  ['{"a":"\\u004"}', false],
  ['{"a":"\\uZZZZ"}', false],
  ['{"a":"\\a"}', false],
  ["{'a':1}", false],
  ['{"a":1,}', false],
  ['{,}', false],
  ['{"a"}', false],
  ['{"a":}', false],
  ['{"a" 1}', false],
  ['{"a":1 "b":2}', false],
  ['{"a":[1,2,]}', false],
  ['{"a":[,1]}', false],
  ['{"a":[1 2]}', false],
  ['{"a":{"b":1,}}', false],
  ['{"a":{,"b":1}}', false],
  ['{"a":[1}', false],
  ['{"a":{1]}', false],
  ['{]', false],
  ['{"a":1}/**/', false],
  ['{"a":1}//', false],
  ['{"a":"x"}garbage', false],
];

/** `encodeURIComponent` throws URIError on a lone surrogate (ECMA-262 §19.2.6.5). */
function isWellFormedUtf16(text: string): boolean {
  try {
    encodeURIComponent(text);
    return true;
  } catch {
    return false;
  }
}

function jsonParseAcceptsObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    );
  } catch {
    return false;
  }
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

describe('offline wallet bridge attacks', () => {
  it('attack 1: the JSON parity corpus verdicts are what JSON.parse says, and the wrapper enforces them before native', async () => {
    expect(JSON_PARITY.length).toBe(83);
    for (const [text, accepted] of JSON_PARITY) {
      expect([text, jsonParseAcceptsObject(text)]).toEqual([text, accepted]);

      mockReplaceWallet.mockReset();
      mockReplaceWallet.mockResolvedValueOnce(snapshotFor(1));
      const outcome = await settle(
        replaceOfflineWallet(OWNER, 0, {
          grants: [],
          receipts: [{ receiptId: 'r-1', kind: 'result', payloadJson: text }],
        }),
      );
      if (accepted) {
        expect([text, outcome.ok]).toEqual([text, true]);
        expect(mockReplaceWallet).toHaveBeenCalledTimes(1);
      } else {
        expect([text, outcome.ok]).toEqual([text, false]);
        expect(mockReplaceWallet).not.toHaveBeenCalled();
        const error = (outcome as { error: unknown }).error;
        expect(error).toBeInstanceOf(OfflineWalletError);
        expect((error as OfflineWalletError).failure).toBe('invalid_receipt');
      }
    }
  });

  it('attack 2: expectedRevision boundary doubles reach native bit-for-bit so its safe-integer check sees them', async () => {
    const values = [
      0,
      -0,
      -1,
      0.5,
      1.0000000000000002,
      2 ** 53 - 1,
      2 ** 53,
      2 ** 53 + 2,
      2 ** 64,
      1e308,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
    ];
    for (const value of values) {
      mockReplaceWallet.mockReset();
      mockReplaceWallet.mockResolvedValueOnce(snapshotFor(1));
      await replaceOfflineWallet(OWNER, value, { grants: [], receipts: [] });
      expect(mockReplaceWallet).toHaveBeenCalledTimes(1);
      const forwarded = mockReplaceWallet.mock.calls[0]?.[1];
      expect(Object.is(forwarded, value)).toBe(true);
    }
  });

  it('attack 3: a non-string ownerId is rejected with a typed error before native is called', async () => {
    const owners: unknown[] = [undefined, null, 42, { id: OWNER }, [OWNER]];
    for (const owner of owners) {
      mockLoadWallet.mockReset();
      mockLoadWallet.mockResolvedValueOnce(null);
      const outcome = await settle(loadOfflineWallet(owner as string));
      expect([owner, outcome.ok]).toEqual([owner, false]);
      expect([owner, mockLoadWallet.mock.calls.length]).toEqual([owner, 0]);
      const error = (outcome as { error: unknown }).error;
      expect(error).toBeInstanceOf(OfflineWalletError);
      expect((error as OfflineWalletError).failure).toBe('invalid_owner');
    }
  });

  it('attack 4: a receipt payload that is not well-formed UTF-16 cannot cross the NSString bridge intact and is refused before native', async () => {
    // JSON.parse accepts a lone surrogate inside a string literal, but the
    // Swift side receives it as U+FFFD, so what native stores is not what
    // JS wrote (and the payload's own signature no longer covers it).
    const loneSurrogate = '{"sig":"\ud800"}';
    expect(isWellFormedUtf16(loneSurrogate)).toBe(false);
    expect(isWellFormedUtf16('{"sig":"\ud83d\ude00"}')).toBe(true);
    expect(jsonParseAcceptsObject(loneSurrogate)).toBe(true);

    mockReplaceWallet.mockResolvedValueOnce(snapshotFor(1));
    const outcome = await settle(
      replaceOfflineWallet(OWNER, 0, {
        grants: [],
        receipts: [
          { receiptId: 'r-1', kind: 'result', payloadJson: loneSurrogate },
        ],
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(mockReplaceWallet).not.toHaveBeenCalled();
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(OfflineWalletError);
    expect((error as OfflineWalletError).failure).toBe('invalid_receipt');
  });

  it('attack 5: a replace snapshot whose revision did not advance past expectedRevision is a bridge contract breach', async () => {
    for (const stale of [1, 2, 3]) {
      mockReplaceWallet.mockReset();
      mockReplaceWallet.mockResolvedValueOnce(snapshotFor(stale));
      const outcome = await settle(
        replaceOfflineWallet(OWNER, 3, { grants: [], receipts: [] }),
      );
      expect([stale, outcome.ok]).toEqual([stale, false]);
      const error = (outcome as { error: unknown }).error;
      expect(error).toBeInstanceOf(OfflineWalletError);
      expect((error as OfflineWalletError).failure).toBe('bridge_contract');
    }
    mockReplaceWallet.mockResolvedValueOnce(snapshotFor(4));
    await expect(
      replaceOfflineWallet(OWNER, 3, { grants: [], receipts: [] }),
    ).resolves.toEqual(snapshotFor(4));
  });

  it('attack 6: a snapshot for the requested owner but with a revision above the safe-integer range is refused', async () => {
    for (const revision of [
      2 ** 53,
      2 ** 64,
      Number.POSITIVE_INFINITY,
      -1,
      0,
      1.5,
    ]) {
      mockLoadWallet.mockReset();
      mockLoadWallet.mockResolvedValueOnce(snapshotFor(revision));
      const outcome = await settle(loadOfflineWallet(OWNER));
      expect([revision, outcome.ok]).toEqual([revision, false]);
      const error = (outcome as { error: unknown }).error;
      expect(error).toBeInstanceOf(OfflineWalletError);
      expect((error as OfflineWalletError).failure).toBe('bridge_contract');
    }
  });
});
