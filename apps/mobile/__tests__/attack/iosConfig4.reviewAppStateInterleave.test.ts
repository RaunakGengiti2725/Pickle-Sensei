import { AppState, NativeModules } from 'react-native';

/**
 * Attack pass mobile-ios-config-4 / scenario S9: the App Store rating ask is
 * pending (state written, 1.2 s delay running) when the app goes
 * background → active. The native `requestReview` must be handed to StoreKit
 * exactly once for that scored analysis — a foreground transition must not
 * replay it, and the interleavings around it (Settings' Rate row finishing
 * the review mid-flight, a rejecting/slow native module, a burst of reports)
 * must never produce an extra ask or an unhandled rejection.
 */

const mockKvTable = new Map<string, string>();
let mockKvBroken = false;

jest.mock('../../src/data/db', () => ({
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
  REVIEW_PROMPT_DELAY_MS,
  REVIEW_PROMPT_KV_KEY,
  markStoreReviewCompleted,
  parseReviewPromptState,
  rateAppFromSettings,
  reportScoredAnalysisForReview,
} from '../../src/review/appStoreReview';

type AppStateHandler = (state: string) => void;

const mockRequestReview = jest.fn(() => Promise.resolve(true));
const appStateHandlers: AppStateHandler[] = [];
let addListenerSpy: jest.SpyInstance;

function storedState() {
  return parseReviewPromptState(mockKvTable.get(REVIEW_PROMPT_KV_KEY) ?? null);
}

/** Drive every registered AppState listener through a background/active cycle. */
function cycleAppState(times = 1) {
  for (let i = 0; i < times; i += 1) {
    for (const state of ['inactive', 'background', 'active']) {
      for (const handler of appStateHandlers) handler(state);
    }
  }
}

/** Let queued microtasks settle without advancing fake timers. */
async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
  mockKvTable.clear();
  mockKvBroken = false;
  appStateHandlers.length = 0;
  mockRequestReview.mockReset();
  mockRequestReview.mockImplementation(() => Promise.resolve(true));
  (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview = {
    requestReview: mockRequestReview,
  };
  addListenerSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      appStateHandlers.push(handler as AppStateHandler);
      return { remove: () => {} } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
});

afterEach(async () => {
  // Drain anything the module still has queued so no test leaks into the next.
  await jest.runOnlyPendingTimersAsync();
  jest.useRealTimers();
  addListenerSpy.mockRestore();
});

afterAll(() => {
  delete (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview;
});

describe('S9 — background → active while the review ask is pending', () => {
  it('hands the ask to StoreKit exactly once despite foreground transitions during the delay', async () => {
    const pending = reportScoredAnalysisForReview();
    await flushMicrotasks();
    // State is durably written BEFORE the prompt; the delay timer is armed.
    expect(storedState().promptedCount).toBe(1);
    expect(mockRequestReview).not.toHaveBeenCalled();

    // Background → active, several times, mid-delay.
    cycleAppState(5);
    await flushMicrotasks();
    expect(mockRequestReview).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(REVIEW_PROMPT_DELAY_MS);
    await pending;
    expect(mockRequestReview).toHaveBeenCalledTimes(1);

    // More transitions after the ask, plus a generous time skip: still one.
    cycleAppState(5);
    await jest.advanceTimersByTimeAsync(REVIEW_PROMPT_DELAY_MS * 10);
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    expect(storedState().promptedCount).toBe(1);
    expect(storedState().scoredAnalyses).toBe(1);
  });

  it('registers no AppState listener of its own (nothing to re-fire on foreground)', async () => {
    const pending = reportScoredAnalysisForReview();
    await jest.advanceTimersByTimeAsync(REVIEW_PROMPT_DELAY_MS);
    await pending;
    expect(appStateHandlers).toHaveLength(0);
  });

  it('a reviewed-mid-flight session (Settings Rate row during the delay) does not double-ask afterwards', async () => {
    const pending = reportScoredAnalysisForReview();
    await flushMicrotasks();
    expect(storedState().promptedCount).toBe(1);

    // User taps Settings → Rate while the sheet request is still delayed.
    const openUrl = jest.fn(() => Promise.resolve(true));
    const rate = rateAppFromSettings({
      writeReviewUrl:
        'https://apps.apple.com/app/id6806918402?action=write-review',
      openUrl,
    });
    cycleAppState(2);
    await jest.advanceTimersByTimeAsync(REVIEW_PROMPT_DELAY_MS);
    await pending;
    await expect(rate).resolves.toBe('store_page');
    expect(openUrl).toHaveBeenCalledTimes(1);

    // The in-flight ask was already committed (state written first) — it
    // goes out once. Every later analysis is silent for good.
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    expect(storedState().reviewedAtIso).not.toBeNull();
    for (let i = 0; i < 5; i += 1) {
      const next = reportScoredAnalysisForReview();
      cycleAppState();
      await jest.advanceTimersByTimeAsync(REVIEW_PROMPT_DELAY_MS);
      await next;
    }
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    expect(storedState().promptedCount).toBe(1);
  });

  it('a burst of concurrent reports is serialized: one ask per scored analysis, no extra from foregrounding', async () => {
    const burst = Array.from({ length: 7 }, () =>
      reportScoredAnalysisForReview({ delayMs: 50 }),
    );
    cycleAppState(3);
    await jest.advanceTimersByTimeAsync(50 * 7 + 10);
    cycleAppState(3);
    await jest.advanceTimersByTimeAsync(50 * 7 + 10);
    await Promise.all(burst);
    // Policy: EVERY scored analysis asks (iOS throttles the sheet) — exactly
    // 7 asks, never 8+ from the transitions, and the record agrees.
    expect(mockRequestReview).toHaveBeenCalledTimes(7);
    expect(storedState().promptedCount).toBe(7);
    expect(storedState().scoredAnalyses).toBe(7);
  });

  it('a rejecting native module during a foreground cycle never surfaces and does not retry', async () => {
    mockRequestReview.mockImplementation(() =>
      Promise.reject(new Error('StoreKit unavailable')),
    );
    const pending = reportScoredAnalysisForReview();
    await flushMicrotasks();
    cycleAppState();
    await jest.advanceTimersByTimeAsync(REVIEW_PROMPT_DELAY_MS);
    await expect(pending).resolves.toBeUndefined();
    cycleAppState(3);
    await jest.advanceTimersByTimeAsync(REVIEW_PROMPT_DELAY_MS * 3);
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
  });

  it('kv failure mid-session: a broken store after the first ask blocks further asks instead of replaying', async () => {
    const first = reportScoredAnalysisForReview({ delayMs: 0 });
    await jest.advanceTimersByTimeAsync(1);
    await first;
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    mockKvBroken = true;
    const second = reportScoredAnalysisForReview({ delayMs: 0 });
    cycleAppState();
    await jest.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toBeUndefined();
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    mockKvBroken = false;
    // Completion still lands once storage recovers.
    await markStoreReviewCompleted();
    expect(storedState().reviewedAtIso).not.toBeNull();
  });

  it('a native module that never resolves stalls the serialized queue (documented behaviour)', async () => {
    let releaseHang!: (value: boolean) => void;
    mockRequestReview.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          releaseHang = resolve;
        }),
    );
    const hanging = reportScoredAnalysisForReview({ delayMs: 0 });
    await jest.advanceTimersByTimeAsync(1);
    expect(mockRequestReview).toHaveBeenCalledTimes(1);

    // A later completion (Settings Rate row) queues behind the hung ask …
    let completed = false;
    const completion = markStoreReviewCompleted().then(() => {
      completed = true;
    });
    cycleAppState(3);
    await jest.advanceTimersByTimeAsync(REVIEW_PROMPT_DELAY_MS * 10);
    expect(completed).toBe(false);
    expect(storedState().reviewedAtIso).toBeNull();

    // … and proceeds the moment the native promise settles. The Swift
    // module always resolves (PickleStoreReview.swift resolve(true/false)),
    // so this is a queue-shape observation, not a reproduced hang.
    releaseHang(true);
    await hanging;
    await completion;
    expect(completed).toBe(true);
    expect(storedState().reviewedAtIso).not.toBeNull();
  });
});
