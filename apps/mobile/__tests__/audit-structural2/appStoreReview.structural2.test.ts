import { NativeModules } from 'react-native';

/**
 * Structural audit #2 (mobile-results-review) — review-prompt queue probes.
 *
 * `appStoreReview.ts` serialises every state mutation through one module
 * promise chain. These probes drive the chain CONCURRENTLY (several scored
 * analyses reported in the same tick, a Settings "rate" landing while a
 * report is still in its delay, a rejected kv write mid-chain) and assert
 * the persisted record never loses an increment or prompts after review.
 */

const mockKvTable = new Map<string, string>();
let mockKvBroken = false;
let mockWriteCount = 0;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (mockKvBroken) throw new Error('kv unavailable');
      if (sql.startsWith('SELECT value FROM kv')) {
        // Simulate a real async read: yield to the microtask queue twice so
        // two concurrent callers really interleave.
        await Promise.resolve();
        await Promise.resolve();
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockWriteCount += 1;
        await Promise.resolve();
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
  reportScoredAnalysisForReview,
} from '../../src/review/appStoreReview';

const mockRequestReview = jest.fn(() => Promise.resolve(true));

function storedState() {
  return parseReviewPromptState(mockKvTable.get(REVIEW_PROMPT_KV_KEY) ?? null);
}

beforeEach(() => {
  mockKvTable.clear();
  mockKvBroken = false;
  mockWriteCount = 0;
  mockRequestReview.mockClear();
  mockRequestReview.mockResolvedValue(true);
  (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview = {
    requestReview: mockRequestReview,
  };
});

afterAll(() => {
  delete (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview;
});

describe('review queue under concurrency', () => {
  it('three scored analyses reported in the same tick persist THREE increments (no lost update)', async () => {
    await Promise.all([
      reportScoredAnalysisForReview({ delayMs: 0 }),
      reportScoredAnalysisForReview({ delayMs: 0 }),
      reportScoredAnalysisForReview({ delayMs: 0 }),
    ]);
    expect(storedState()).toMatchObject({
      scoredAnalyses: 3,
      promptedCount: 3,
    });
    expect(mockRequestReview).toHaveBeenCalledTimes(3);
    expect(mockWriteCount).toBe(3);
  });

  it('a Settings rating that lands while a report is still queued ends the asks for every LATER report', async () => {
    const first = reportScoredAnalysisForReview({ delayMs: 0 });
    // Settings marks completion only AFTER the store page opened; model that
    // ordering explicitly: the mark is enqueued while `first` is in flight.
    const rated = markStoreReviewCompleted();
    const second = reportScoredAnalysisForReview({ delayMs: 0 });
    await Promise.all([first, rated, second]);
    const state = storedState();
    expect(state.reviewedAtIso).not.toBeNull();
    // Only the report queued BEFORE the rating prompted.
    expect(state.promptedCount).toBe(1);
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
  });

  it('a kv outage during one report does not poison the chain for the next report', async () => {
    mockKvBroken = true;
    await reportScoredAnalysisForReview({ delayMs: 0 });
    expect(mockRequestReview).not.toHaveBeenCalled();
    mockKvBroken = false;
    await reportScoredAnalysisForReview({ delayMs: 0 });
    expect(storedState()).toMatchObject({
      scoredAnalyses: 1,
      promptedCount: 1,
    });
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
  });

  it('markStoreReviewCompleted is idempotent under concurrent calls (one reviewedAt, one write)', async () => {
    await Promise.all([
      markStoreReviewCompleted(),
      markStoreReviewCompleted(),
      markStoreReviewCompleted(),
    ]);
    expect(storedState().reviewedAtIso).not.toBeNull();
    expect(mockWriteCount).toBe(1);
  });

  it('a native sheet that REJECTS never propagates out of the queue', async () => {
    mockRequestReview.mockRejectedValue(new Error('StoreKit refused'));
    await expect(
      reportScoredAnalysisForReview({ delayMs: 0 }),
    ).resolves.toBeUndefined();
    await expect(markStoreReviewCompleted()).resolves.toBeUndefined();
    expect(storedState()).toMatchObject({ scoredAnalyses: 1 });
  });
});
