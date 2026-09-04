import { NativeModules } from 'react-native';

/**
 * Adversarial pass 3 — App Store review reporting under slow, interleaved and
 * failing KV writes.
 *
 * The kv table is a controllable fake: every write is held until the test
 * releases it, so two concurrent `reportScoredAnalysisForReview` calls can be
 * interleaved deliberately. What must hold, whatever the timing:
 *   - the durable record is written BEFORE StoreKit is asked (crash safety);
 *   - a second report never reads state from before the first one's write;
 *   - a failed write suppresses ITS prompt only;
 *   - a completed review observed mid-queue stops every later ask.
 *
 * Note on the policy under test (appStoreReview.ts header): EVERY scored
 * analysis asks StoreKit until the user has reviewed, iOS throttles the
 * sheet. Two scored analyses therefore mean two asks; the invariant is
 * serialization + write-before-prompt, not a one-ask ceiling.
 */

type Deferred = { resolve: () => void; reject: (error: Error) => void };

const mockKvTable = new Map<string, string>();
const mockLog: string[] = [];
const mockPendingWrites: Array<{ key: string; value: string } & Deferred> = [];
let mockHoldWrites = true;
let mockReadDelayMs = 0;

jest.mock('../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockReadDelayMs > 0) {
          await new Promise<void>(resolve =>
            setTimeout(() => resolve(), mockReadDelayMs),
          );
        }
        const value = mockKvTable.get(String(params[0]));
        mockLog.push(`read:${value === undefined ? 'empty' : value}`);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        const key = String(params[0]);
        const value = String(params[1]);
        mockLog.push(`write:start:${value}`);
        if (!mockHoldWrites) {
          mockKvTable.set(key, value);
          mockLog.push(`write:done:${value}`);
          return { rows: [] };
        }
        await new Promise<void>((resolve, reject) => {
          mockPendingWrites.push({
            key,
            value,
            resolve: () => {
              mockKvTable.set(key, value);
              mockLog.push(`write:done:${value}`);
              resolve();
            },
            reject: error => {
              mockLog.push(`write:failed:${value}`);
              reject(error);
            },
          });
        });
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
} from '../src/review/appStoreReview';

const mockRequestReview = jest.fn(() => {
  mockLog.push('prompt');
  return Promise.resolve(true);
});

function stored() {
  return parseReviewPromptState(mockKvTable.get(REVIEW_PROMPT_KV_KEY) ?? null);
}

/** Drains microtasks AND the macrotask queue (the module's delay() uses
 * setTimeout, which a setImmediate-only flush can overtake). */
async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 1));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function releaseNextWrite() {
  const next = mockPendingWrites.shift();
  if (!next) throw new Error('no pending kv write to release');
  next.resolve();
  await flush();
}

async function failNextWrite() {
  const next = mockPendingWrites.shift();
  if (!next) throw new Error('no pending kv write to fail');
  next.reject(new Error('disk full'));
  await flush();
}

function prompts(): number {
  return mockLog.filter(entry => entry === 'prompt').length;
}

/** Index in the log of the n-th prompt (0-based); -1 when absent. */
function promptIndex(n: number): number {
  let seen = -1;
  for (let i = 0; i < mockLog.length; i += 1) {
    if (mockLog[i] === 'prompt') {
      seen += 1;
      if (seen === n) return i;
    }
  }
  return -1;
}

beforeEach(() => {
  mockKvTable.clear();
  mockLog.length = 0;
  mockPendingWrites.length = 0;
  mockHoldWrites = true;
  mockReadDelayMs = 0;
  mockRequestReview.mockClear();
  (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview = {
    requestReview: mockRequestReview,
  };
});

afterEach(async () => {
  // The module keeps ONE queue: a write left pending here would wedge every
  // later test, so drain whatever an assertion failure left behind.
  while (mockPendingWrites.length > 0) await releaseNextWrite();
  await flush();
});

afterAll(() => {
  delete (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview;
});

describe('attack — two concurrent reports with slow KV writes', () => {
  it('serializes: the second report cannot read until the first write landed, and each prompt follows its own durable write', async () => {
    const first = reportScoredAnalysisForReview({ delayMs: 0 });
    const second = reportScoredAnalysisForReview({ delayMs: 0 });
    await flush();

    // Only the FIRST report has progressed: one read, one held write.
    expect(mockLog).toEqual([
      'read:empty',
      `write:start:${JSON.stringify({
        version: 1,
        scoredAnalyses: 1,
        promptedCount: 1,
        lastPromptedAtIso: stampOf(mockLog[1]!),
        reviewedAtIso: null,
      })}`,
    ]);
    expect(mockPendingWrites).toHaveLength(1);
    expect(prompts()).toBe(0);
    // The second report has NOT read the (still-empty) table.
    expect(mockLog.filter(entry => entry.startsWith('read:'))).toHaveLength(1);

    await releaseNextWrite();
    await first;
    await flush();
    // First prompt happened only AFTER its write was durable...
    expect(prompts()).toBe(1);
    expect(mockLog.indexOf('write:done:' + writtenValue(0))).toBeLessThan(
      promptIndex(0),
    );
    expect(stored().promptedCount).toBe(1);
    // ...and the second report then read the UPDATED record (count 1), never
    // the pre-write empty one.
    const reads = mockLog.filter(entry => entry.startsWith('read:'));
    expect(reads).toHaveLength(2);
    expect(
      parseReviewPromptState(reads[1]!.slice('read:'.length)),
    ).toMatchObject({ scoredAnalyses: 1, promptedCount: 1 });
    expect(mockPendingWrites).toHaveLength(1);
    // Exactly one prompt so far: the second is gated on its own write.
    expect(prompts()).toBe(1);

    await releaseNextWrite();
    await second;
    // Policy: every scored analysis asks → two asks for two analyses, each
    // after its own write, counters monotonic with no lost update.
    expect(prompts()).toBe(2);
    expect(mockLog.indexOf('write:done:' + writtenValue(1))).toBeLessThan(
      promptIndex(1),
    );
    expect(stored()).toMatchObject({ scoredAnalyses: 2, promptedCount: 2 });
    expect(mockRequestReview).toHaveBeenCalledTimes(2);
  });

  it('a slow write that FAILS suppresses only its own prompt; the next report starts from the unchanged record', async () => {
    const first = reportScoredAnalysisForReview({ delayMs: 0 });
    const second = reportScoredAnalysisForReview({ delayMs: 0 });
    await flush();
    await failNextWrite();
    await first;
    await flush();
    expect(prompts()).toBe(0);
    expect(mockKvTable.has(REVIEW_PROMPT_KV_KEY)).toBe(false);

    // Second report reads the empty record and writes count 1.
    expect(mockPendingWrites).toHaveLength(1);
    expect(mockPendingWrites[0]!.value).toContain('"promptedCount":1');
    await releaseNextWrite();
    await second;
    expect(prompts()).toBe(1);
    expect(stored()).toMatchObject({ scoredAnalyses: 1, promptedCount: 1 });
  });

  it('a slow READ does not let a burst of reports interleave either (ten rapid repeats → ten ordered asks, count 10)', async () => {
    mockHoldWrites = false;
    mockReadDelayMs = 5;
    const burst = Array.from({ length: 10 }, () =>
      reportScoredAnalysisForReview({ delayMs: 0 }),
    );
    await Promise.all(burst);
    expect(prompts()).toBe(10);
    expect(stored()).toMatchObject({ scoredAnalyses: 10, promptedCount: 10 });
    // Strictly alternating read → write → prompt, never two reads in a row.
    const pattern = mockLog.map(entry => entry.split(':')[0]).join(',');
    expect(pattern).toBe(
      Array.from({ length: 10 }, () => 'read,write,write,prompt').join(','),
    );
  });

  it('a review completed while a report is still waiting on its write stops every LATER ask but not the in-flight one', async () => {
    const inFlight = reportScoredAnalysisForReview({ delayMs: 0 });
    await flush();
    const marked = markStoreReviewCompleted();
    const later = reportScoredAnalysisForReview({ delayMs: 0 });
    await flush();

    // Queue order: in-flight report → mark completed → later report.
    expect(mockPendingWrites).toHaveLength(1);
    await releaseNextWrite(); // in-flight report's counter write
    await inFlight;
    await flush();
    expect(prompts()).toBe(1);
    expect(mockPendingWrites).toHaveLength(1);
    expect(mockPendingWrites[0]!.value).toContain('"reviewedAtIso":"');
    await releaseNextWrite(); // markStoreReviewCompleted's write
    await marked;
    expect(stored().reviewedAtIso).not.toBeNull();
    await later;
    expect(prompts()).toBe(1);
    expect(mockPendingWrites).toHaveLength(0);
    expect(stored()).toMatchObject({ scoredAnalyses: 1, promptedCount: 1 });
  });

  it('Settings "Rate" enqueues its completion mark only AFTER the store page opened, so a report racing that tap still asks once more', async () => {
    // Characterisation of ordering: rateAppFromSettings awaits openUrl
    // before markStoreReviewCompleted joins the queue, so a report fired in
    // the same tick lands ahead of the mark. Not a policy break — that
    // analysis was scored before the review was observed — but it is the
    // exact interleaving where a sheet can follow a store-page trip.
    let openResolve: () => void = () => {};
    const settings = rateAppFromSettings({
      writeReviewUrl:
        'https://apps.apple.com/app/id6806918402?action=write-review',
      openUrl: () =>
        new Promise<void>(resolve => {
          openResolve = resolve;
        }),
    });
    const racing = reportScoredAnalysisForReview({ delayMs: 0 });
    await flush();
    expect(mockPendingWrites).toHaveLength(1); // racing report's counter
    openResolve();
    await flush();
    await releaseNextWrite();
    await racing;
    await flush();
    expect(prompts()).toBe(1);
    expect(mockPendingWrites).toHaveLength(1); // the completion mark
    await releaseNextWrite();
    await expect(settings).resolves.toBe('store_page');
    expect(stored()).toMatchObject({ scoredAnalyses: 1, promptedCount: 1 });
    expect(stored().reviewedAtIso).not.toBeNull();
    // From here on nothing asks again.
    mockHoldWrites = false;
    await reportScoredAnalysisForReview({ delayMs: 0 });
    expect(prompts()).toBe(1);
  });

  it('a corrupt stored record is treated as fresh state, not as "reviewed"', async () => {
    mockHoldWrites = false;
    mockKvTable.set(
      REVIEW_PROMPT_KV_KEY,
      JSON.stringify({
        version: 1,
        scoredAnalyses: 'lots',
        promptedCount: -7,
        lastPromptedAtIso: 12345,
        reviewedAtIso: 0,
      }),
    );
    await reportScoredAnalysisForReview({ delayMs: 0 });
    expect(prompts()).toBe(1);
    expect(stored()).toMatchObject({
      scoredAnalyses: 1,
      promptedCount: 1,
      reviewedAtIso: null,
    });
  });

  it('a reviewedAtIso that is any non-empty string — even garbage or unicode — ends the asks (durable stop is sticky)', async () => {
    mockHoldWrites = false;
    for (const marker of ['not-a-date', '✅', ' ']) {
      mockLog.length = 0;
      mockKvTable.set(
        REVIEW_PROMPT_KV_KEY,
        JSON.stringify({ version: 1, reviewedAtIso: marker }),
      );
      await reportScoredAnalysisForReview({ delayMs: 0 });
      expect(prompts()).toBe(0);
    }
  });
});

describe('attack — StoreKit that never answers', () => {
  it('a hung native requestReview blocks the shared queue: the Settings rating row can no longer mark the review complete', async () => {
    mockHoldWrites = false;
    mockRequestReview.mockImplementation(() => {
      mockLog.push('prompt');
      return new Promise<boolean>(() => {}); // never settles
    });
    const hung = reportScoredAnalysisForReview({ delayMs: 0 });
    await flush();
    expect(prompts()).toBe(1);

    let marked = false;
    const mark = markStoreReviewCompleted().then(() => {
      marked = true;
    });
    await flush(50);
    // Characterisation: markStoreReviewCompleted is queued behind the hung
    // prompt and never persists reviewedAtIso while the native promise is
    // outstanding. See findings — INFERRED impact depends on the native
    // module always settling its promise.
    expect(marked).toBe(false);
    expect(stored().reviewedAtIso).toBeNull();

    // Do not leak the hung promises into other suites.
    void hung;
    void mark;
  });
});

// ─── helpers over the log ───────────────────────────────────────────────────

function writtenValue(n: number): string {
  const starts = mockLog.filter(entry => entry.startsWith('write:start:'));
  return starts[n]!.slice('write:start:'.length);
}

function stampOf(writeStartEntry: string): string {
  const parsed = JSON.parse(writeStartEntry.slice('write:start:'.length)) as {
    lastPromptedAtIso: string;
  };
  return parsed.lastPromptedAtIso;
}
