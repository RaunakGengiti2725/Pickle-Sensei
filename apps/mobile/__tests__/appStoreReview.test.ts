import { NativeModules } from 'react-native';

/**
 * App Store rating policy: every scored analysis asks StoreKit for the
 * rating sheet — starting with the very first one — until the user has been
 * taken through the review flow, after which the asks stop for good. The
 * durable record is device-level kv (survives sign-out); iOS itself
 * throttles how many sheets ever appear.
 */

const mockKvTable = new Map<string, string>();
let mockKvBroken = false;

jest.mock('../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (mockKvBroken) throw new Error('kv unavailable');
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import {
  REVIEW_PROMPT_KV_KEY,
  markStoreReviewCompleted,
  parseReviewPromptState,
  rateAppFromSettings,
  reportScoredAnalysisForReview,
  shouldRequestReview,
} from '../src/review/appStoreReview';

const mockRequestReview = jest.fn(() => Promise.resolve(true));

function storedState() {
  return parseReviewPromptState(mockKvTable.get(REVIEW_PROMPT_KV_KEY) ?? null);
}

beforeEach(() => {
  mockKvTable.clear();
  mockKvBroken = false;
  mockRequestReview.mockClear();
  mockRequestReview.mockResolvedValue(true);
  (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview = {
    requestReview: mockRequestReview,
  };
});

afterAll(() => {
  delete (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview;
});

describe('parseReviewPromptState', () => {
  it('treats missing and malformed records as a fresh state', () => {
    for (const raw of [null, '', 'not-json', '[]', '{"version":9}']) {
      const state = parseReviewPromptState(raw);
      expect(state.scoredAnalyses).toBe(0);
      expect(state.promptedCount).toBe(0);
      expect(state.reviewedAtIso).toBeNull();
      expect(shouldRequestReview(state)).toBe(true);
    }
  });

  it('round-trips a stored record and stops prompting once reviewed', () => {
    const state = parseReviewPromptState(
      JSON.stringify({
        version: 1,
        scoredAnalyses: 4,
        promptedCount: 4,
        lastPromptedAtIso: '2026-08-30T00:00:00.000Z',
        reviewedAtIso: '2026-08-30T01:00:00.000Z',
      }),
    );
    expect(state.scoredAnalyses).toBe(4);
    expect(shouldRequestReview(state)).toBe(false);
  });
});

describe('reportScoredAnalysisForReview', () => {
  it('asks StoreKit on the very first scored analysis and records it first', async () => {
    await reportScoredAnalysisForReview({ delayMs: 0 });
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    const state = storedState();
    expect(state.scoredAnalyses).toBe(1);
    expect(state.promptedCount).toBe(1);
    expect(state.lastPromptedAtIso).not.toBeNull();
    expect(state.reviewedAtIso).toBeNull();
  });

  it('keeps asking on every subsequent scored analysis until reviewed', async () => {
    await reportScoredAnalysisForReview({ delayMs: 0 });
    await reportScoredAnalysisForReview({ delayMs: 0 });
    await reportScoredAnalysisForReview({ delayMs: 0 });
    expect(mockRequestReview).toHaveBeenCalledTimes(3);
    expect(storedState().promptedCount).toBe(3);
  });

  it('never asks again after the review flow completed — durably', async () => {
    await reportScoredAnalysisForReview({ delayMs: 0 });
    await markStoreReviewCompleted();
    mockRequestReview.mockClear();

    await reportScoredAnalysisForReview({ delayMs: 0 });
    await reportScoredAnalysisForReview({ delayMs: 0 });
    expect(mockRequestReview).not.toHaveBeenCalled();
    // The record itself pins the stop: counters freeze once reviewed.
    expect(storedState().promptedCount).toBe(1);
    expect(storedState().reviewedAtIso).not.toBeNull();
  });

  it('skips the prompt when the durable record is unreachable', async () => {
    mockKvBroken = true;
    await expect(
      reportScoredAnalysisForReview({ delayMs: 0 }),
    ).resolves.toBeUndefined();
    expect(mockRequestReview).not.toHaveBeenCalled();
  });

  it('is a silent no-op when StoreKit is unavailable (Android, missing pod)', async () => {
    delete (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview;
    await expect(
      reportScoredAnalysisForReview({ delayMs: 0 }),
    ).resolves.toBeUndefined();
    // promptedCount records real asks only — nothing was asked here.
    expect(storedState().promptedCount).toBe(0);
  });
});

describe('rateAppFromSettings', () => {
  it('deep-links to the write-review page and permanently ends the asks', async () => {
    const openUrl = jest.fn(() => Promise.resolve(true));
    const outcome = await rateAppFromSettings({
      writeReviewUrl: 'https://apps.apple.com/app/id123?action=write-review',
      openUrl,
    });
    expect(outcome).toBe('store_page');
    expect(openUrl).toHaveBeenCalledWith(
      'https://apps.apple.com/app/id123?action=write-review',
    );
    await reportScoredAnalysisForReview({ delayMs: 0 });
    expect(mockRequestReview).not.toHaveBeenCalled();
  });

  it('falls back to the in-app sheet before the app id exists — and keeps asking later', async () => {
    const outcome = await rateAppFromSettings({ writeReviewUrl: null });
    expect(outcome).toBe('native_prompt');
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    // The OS sheet gives no "user rated" signal, so the per-analysis asks
    // continue (iOS suppresses real sheets once the user actually rated).
    await reportScoredAnalysisForReview({ delayMs: 0 });
    expect(mockRequestReview).toHaveBeenCalledTimes(2);
  });

  it('falls back to the sheet when the store page cannot be opened', async () => {
    const openUrl = jest.fn(() => Promise.reject(new Error('not installed')));
    const outcome = await rateAppFromSettings({
      writeReviewUrl: 'https://apps.apple.com/app/id123?action=write-review',
      openUrl,
    });
    expect(outcome).toBe('native_prompt');
    expect(storedState().reviewedAtIso).toBeNull();
  });

  it('reports unavailable when neither the page nor the sheet exists', async () => {
    delete (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview;
    const outcome = await rateAppFromSettings({ writeReviewUrl: null });
    expect(outcome).toBe('unavailable');
  });
});
