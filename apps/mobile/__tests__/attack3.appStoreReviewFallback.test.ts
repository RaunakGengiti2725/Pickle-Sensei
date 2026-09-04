/**
 * ADVERSARIAL PASS 3 — Settings "Rate Pickle Sensei" when EVERY exit is shut.
 *
 * S3: PickleStoreReview.requestReview rejects AND Linking.canOpenURL is false
 *     (openURL rejects) → rateAppFromSettings resolves 'unavailable' and the
 *     durable review record is NOT flipped to reviewed / prompted.
 * Extras: synchronous native throw, garbage (non-boolean) native return,
 *     Android build, broken kv on the happy path, and a store-page open that
 *     rejects only AFTER the record would have been written.
 */
import { Linking, NativeModules, Platform } from 'react-native';

const mockKvTable = new Map<string, string>();
let mockKvBroken = false;
const mockKvWrites: string[] = [];

jest.mock('../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (mockKvBroken) throw new Error('kv unavailable');
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvWrites.push(String(params[0]));
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

const mockWriteReviewUrl = jest.fn<string | null, []>(
  () => 'https://apps.apple.com/app/id6806918402?action=write-review',
);
jest.mock('../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    appStoreWriteReviewUrl: mockWriteReviewUrl(),
  }),
}));

import {
  REVIEW_PROMPT_KV_KEY,
  parseReviewPromptState,
  rateAppFromSettings,
  reportScoredAnalysisForReview,
  requestNativeReviewPrompt,
} from '../src/review/appStoreReview';

const mockRequestReview = jest.fn<Promise<boolean>, []>();

function storedState() {
  return parseReviewPromptState(mockKvTable.get(REVIEW_PROMPT_KV_KEY) ?? null);
}

function installNative(requestReview: unknown) {
  (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview = {
    requestReview,
  };
}

let openUrlSpy: jest.SpyInstance;
let canOpenUrlSpy: jest.SpyInstance;
const originalPlatform = Platform.OS;

beforeEach(() => {
  mockKvTable.clear();
  mockKvWrites.length = 0;
  mockKvBroken = false;
  mockRequestReview.mockReset();
  mockWriteReviewUrl.mockReset();
  mockWriteReviewUrl.mockReturnValue(
    'https://apps.apple.com/app/id6806918402?action=write-review',
  );
  installNative(mockRequestReview);
  openUrlSpy = jest.spyOn(Linking, 'openURL');
  canOpenUrlSpy = jest.spyOn(Linking, 'canOpenURL');
});

afterEach(() => {
  openUrlSpy.mockRestore();
  canOpenUrlSpy.mockRestore();
  Object.defineProperty(Platform, 'OS', {
    value: originalPlatform,
    configurable: true,
  });
});

afterAll(() => {
  delete (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview;
});

describe('S3 — requestReview rejects and the store page cannot be opened', () => {
  it('default deps: canOpenURL=false, openURL rejects, StoreKit rejects → unavailable, nothing marked reviewed', async () => {
    canOpenUrlSpy.mockResolvedValue(false);
    openUrlSpy.mockRejectedValue(new Error('No app can open this URL'));
    mockRequestReview.mockRejectedValue(new Error('SKStoreReviewController'));

    const outcome = await rateAppFromSettings();

    expect(outcome).toBe('unavailable');
    expect(openUrlSpy).toHaveBeenCalledTimes(1);
    expect(openUrlSpy).toHaveBeenCalledWith(
      'https://apps.apple.com/app/id6806918402?action=write-review',
    );
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    // The record must be untouched: no reviewedAtIso, no prompt counted,
    // not even a kv write.
    expect(storedState().reviewedAtIso).toBeNull();
    expect(storedState().promptedCount).toBe(0);
    expect(mockKvTable.has(REVIEW_PROMPT_KV_KEY)).toBe(false);
    expect(mockKvWrites).toEqual([]);
    // … and the per-analysis asks are still live afterwards.
    mockRequestReview.mockResolvedValue(true);
    await reportScoredAnalysisForReview({ delayMs: 0 });
    expect(mockRequestReview).toHaveBeenCalledTimes(2);
    expect(storedState().promptedCount).toBe(1);
  });

  it('no app id configured (writeReviewUrl=null) + StoreKit rejects → unavailable without touching Linking', async () => {
    mockWriteReviewUrl.mockReturnValue(null);
    mockRequestReview.mockRejectedValue(new Error('unavailable'));
    canOpenUrlSpy.mockResolvedValue(false);
    openUrlSpy.mockRejectedValue(new Error('must not be called'));

    await expect(rateAppFromSettings()).resolves.toBe('unavailable');
    expect(openUrlSpy).not.toHaveBeenCalled();
    expect(canOpenUrlSpy).not.toHaveBeenCalled();
    expect(mockKvWrites).toEqual([]);
  });

  it('the injected openUrl rejecting + explicit null url + StoreKit rejecting → unavailable', async () => {
    mockRequestReview.mockRejectedValue(new Error('unavailable'));
    const openUrl = jest.fn(() => Promise.reject(new Error('nope')));
    await expect(
      rateAppFromSettings({
        writeReviewUrl: 'https://apps.apple.com/app/id1?action=write-review',
        openUrl,
      }),
    ).resolves.toBe('unavailable');
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(storedState().reviewedAtIso).toBeNull();
    expect(mockKvWrites).toEqual([]);
  });

  it('a SYNCHRONOUS native throw (bridge misconfiguration) is swallowed, never propagates', async () => {
    installNative(() => {
      throw new TypeError('requestReview is not a function');
    });
    openUrlSpy.mockRejectedValue(new Error('offline'));
    await expect(rateAppFromSettings()).resolves.toBe('unavailable');
    await expect(requestNativeReviewPrompt()).resolves.toBe(false);
    expect(mockKvWrites).toEqual([]);
  });

  it.each([undefined, null, 0, '', NaN])(
    'a garbage native return (%p) reads as no-sheet → unavailable',
    async garbage => {
      installNative(() => Promise.resolve(garbage));
      openUrlSpy.mockRejectedValue(new Error('offline'));
      await expect(rateAppFromSettings()).resolves.toBe('unavailable');
      expect(storedState().reviewedAtIso).toBeNull();
    },
  );

  it('a truthy non-boolean native return ("yes", 1, {}) is reported as native_prompt (Boolean coercion) — still never marks reviewed', async () => {
    for (const truthy of ['yes', 1, {}]) {
      installNative(() => Promise.resolve(truthy));
      openUrlSpy.mockRejectedValue(new Error('offline'));
      await expect(rateAppFromSettings()).resolves.toBe('native_prompt');
      expect(storedState().reviewedAtIso).toBeNull();
    }
    expect(mockKvWrites).toEqual([]);
  });

  it('Android build: no StoreKit → the sheet path is never consulted, outcome unavailable', async () => {
    Object.defineProperty(Platform, 'OS', {
      value: 'android',
      configurable: true,
    });
    openUrlSpy.mockRejectedValue(new Error('offline'));
    mockRequestReview.mockResolvedValue(true);
    await expect(rateAppFromSettings()).resolves.toBe('unavailable');
    expect(mockRequestReview).not.toHaveBeenCalled();
  });

  it('native module present but without requestReview → unavailable', async () => {
    installNative(undefined);
    openUrlSpy.mockRejectedValue(new Error('offline'));
    await expect(rateAppFromSettings()).resolves.toBe('unavailable');
  });

  it('store page opens but kv is broken: store_page is still reported, record stays un-reviewed (best effort), no throw', async () => {
    mockKvBroken = true;
    openUrlSpy.mockResolvedValue(true);
    mockRequestReview.mockResolvedValue(true);
    await expect(rateAppFromSettings()).resolves.toBe('store_page');
    expect(mockRequestReview).not.toHaveBeenCalled();
    expect(mockKvTable.has(REVIEW_PROMPT_KV_KEY)).toBe(false);
  });

  it('20 rapid Settings taps while everything is shut → 20× unavailable, zero kv writes, no queue wedge', async () => {
    openUrlSpy.mockRejectedValue(new Error('offline'));
    mockRequestReview.mockRejectedValue(new Error('unavailable'));
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => rateAppFromSettings()),
    );
    expect(outcomes).toEqual(Array.from({ length: 20 }, () => 'unavailable'));
    expect(mockKvWrites).toEqual([]);
    // The serialized review queue is not wedged by the failures.
    mockRequestReview.mockResolvedValue(true);
    await expect(
      reportScoredAnalysisForReview({ delayMs: 0 }),
    ).resolves.toBeUndefined();
    expect(storedState().promptedCount).toBe(1);
  });

  it('a store-page open that succeeds and THEN a rejected StoreKit sheet never runs (short-circuit on success)', async () => {
    openUrlSpy.mockResolvedValue(true);
    mockRequestReview.mockRejectedValue(new Error('must not run'));
    await expect(rateAppFromSettings()).resolves.toBe('store_page');
    expect(mockRequestReview).not.toHaveBeenCalled();
    expect(storedState().reviewedAtIso).not.toBeNull();
  });
});
