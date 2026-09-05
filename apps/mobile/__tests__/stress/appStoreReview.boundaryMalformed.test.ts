import { NativeModules } from 'react-native';
import {
  ResultTable,
  brokenSummary,
  campaignPlan,
  invariant,
  malformedReviewState,
  prototypeFingerprint,
  runCaseAsync,
  safeString,
  weirdString,
  weirdValue,
  type Rng,
} from '../../test-support/stress/reviewMalformed';

/**
 * STRESS · boundary/malformed input · appStoreReview.
 *
 * Contract: persisted prompt state is unvalidated device kv; any malformed
 * record normalizes to the empty state (never a throw); the report path
 * never rejects, never prompts without a successful write, never prompts
 * once reviewed, never writes when the read failed; Settings' rate action
 * always resolves to one of three outcomes. The kv is an in-memory fake
 * that can be poisoned per iteration; StoreKit is a per-iteration stub.
 */

const mockKvTable = new Map<string, string>();
let mockKvReadMode: 'ok' | 'throw' | 'nonString' = 'ok';
let mockKvWriteMode: 'ok' | 'throw' = 'ok';
let mockKvWrites = 0;
let mockKvNonString: unknown = undefined;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockKvReadMode === 'throw') throw new Error('kv read unavailable');
        if (mockKvReadMode === 'nonString') {
          return { rows: [{ value: mockKvNonString }] };
        }
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockKvWriteMode === 'throw')
          throw new Error('kv write unavailable');
        mockKvWrites += 1;
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
  type ReviewPromptState,
} from '../../src/review/appStoreReview';

const table = new ResultTable('appStoreReview');
const plan = campaignPlan(60);

afterAll(() => {
  table.flush();
  delete (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview;
});

type NativeMode =
  'missing' | 'true' | 'false' | 'throws' | 'nonBoolean' | 'noMethod';

function installNative(mode: NativeMode, rng: Rng): { calls: number } {
  const counter = { calls: 0 };
  const holder = NativeModules as { PickleStoreReview?: unknown };
  if (mode === 'missing') {
    delete holder.PickleStoreReview;
    return counter;
  }
  if (mode === 'noMethod') {
    holder.PickleStoreReview = {};
    return counter;
  }
  holder.PickleStoreReview = {
    requestReview: async () => {
      counter.calls += 1;
      if (mode === 'throws') throw new Error('StoreKit refused');
      if (mode === 'nonBoolean') return weirdValue(rng);
      return mode === 'true';
    },
  };
  return counter;
}

function checkState(state: ReviewPromptState, where: string): void {
  invariant(state.version === 1, `${where}.version 1`);
  invariant(
    Number.isInteger(state.scoredAnalyses) && state.scoredAnalyses >= 0,
    `${where}.scoredAnalyses non-negative integer (got ${String(state.scoredAnalyses)})`,
  );
  invariant(
    Number.isInteger(state.promptedCount) && state.promptedCount >= 0,
    `${where}.promptedCount non-negative integer (got ${String(state.promptedCount)})`,
  );
  invariant(
    state.lastPromptedAtIso === null ||
      (typeof state.lastPromptedAtIso === 'string' &&
        state.lastPromptedAtIso.length > 0),
    `${where}.lastPromptedAtIso null or non-empty string`,
  );
  invariant(
    state.reviewedAtIso === null ||
      (typeof state.reviewedAtIso === 'string' &&
        state.reviewedAtIso.length > 0),
    `${where}.reviewedAtIso null or non-empty string`,
  );
  invariant(
    Object.keys(state).length === 5,
    `${where} carries exactly the five contract keys (got ${safeString(Object.keys(state))})`,
  );
}

describe('appStoreReview · boundary/malformed campaigns', () => {
  const fingerprint = prototypeFingerprint();

  it('parseReviewPromptState normalizes any raw kv text without throwing', async () => {
    for (let i = 0; i < plan.iterations; i += 1) {
      await runCaseAsync(
        table,
        'parseState',
        plan.seedAt(i),
        async (rng, log) => {
          const raw = rng.chance(0.15)
            ? weirdString(rng)
            : malformedReviewState(rng, log);
          log.push(`raw.len=${raw.length}`);
          const state = parseReviewPromptState(raw);
          checkState(state, 'parsed');
          invariant(
            typeof shouldRequestReview(state) === 'boolean',
            'shouldRequestReview boolean',
          );
          invariant(
            shouldRequestReview(state) === (state.reviewedAtIso === null),
            'shouldRequestReview mirrors reviewedAtIso',
          );
          const again = parseReviewPromptState(JSON.stringify(state));
          invariant(
            JSON.stringify(again) === JSON.stringify(state),
            'normalized state is a fixed point of parse∘stringify',
          );
          invariant(
            prototypeFingerprint() === fingerprint,
            'no prototype pollution',
          );
        },
      );
    }
    expect(brokenSummary(table)).toBe(`0 broken of ${table.records.length}`);
  });

  it('reportScoredAnalysisForReview never rejects, writes before prompting, never prompts on a failed write', async () => {
    const before = table.records.length;
    for (let i = 0; i < plan.iterations; i += 1) {
      await runCaseAsync(
        table,
        'reportScored',
        plan.seedAt(i, 0x5e5e),
        async (rng, log) => {
          mockKvTable.clear();
          mockKvWrites = 0;
          const seeded = rng.chance(0.8);
          if (seeded)
            mockKvTable.set(
              REVIEW_PROMPT_KV_KEY,
              malformedReviewState(rng, log),
            );
          mockKvReadMode = rng.pick(['ok', 'ok', 'ok', 'throw', 'nonString']);
          mockKvNonString = weirdValue(rng);
          mockKvWriteMode = rng.pick(['ok', 'ok', 'ok', 'throw']);
          const nativeMode = rng.pick<NativeMode>([
            'true',
            'true',
            'false',
            'throws',
            'nonBoolean',
            'missing',
            'noMethod',
          ]);
          log.push(
            `read=${mockKvReadMode}`,
            `write=${mockKvWriteMode}`,
            `native=${nativeMode}`,
          );
          const native = installNative(nativeMode, rng);
          const priorRaw = mockKvTable.get(REVIEW_PROMPT_KV_KEY) ?? null;
          // Mirrors repository.getKv: a truthy row value is String()-coerced
          // (which may itself throw), a falsy one reads as absent.
          const prior: ReviewPromptState | null = (() => {
            if (mockKvReadMode === 'throw') return null;
            if (mockKvReadMode === 'ok')
              return parseReviewPromptState(priorRaw);
            try {
              return parseReviewPromptState(
                mockKvNonString ? String(mockKvNonString) : null,
              );
            } catch {
              return null;
            }
          })();

          const concurrent = rng.int(1, 3);
          log.push(`concurrent=${concurrent}`);
          const runs: Promise<void>[] = [];
          for (let c = 0; c < concurrent; c += 1) {
            runs.push(reportScoredAnalysisForReview({ delayMs: 0 }));
          }
          const settled = await Promise.allSettled(runs);
          invariant(
            settled.every(s => s.status === 'fulfilled'),
            `report never rejects (got ${safeString(settled.map(s => s.status))})`,
          );

          const nativeAvailable =
            nativeMode !== 'missing' && nativeMode !== 'noMethod';
          if (!nativeAvailable) {
            invariant(mockKvWrites === 0, 'no StoreKit → no write');
            invariant(native.calls === 0, 'no StoreKit → no prompt');
          } else if (mockKvReadMode === 'throw' || prior === null) {
            invariant(mockKvWrites === 0, 'unreadable state → no write');
            invariant(native.calls === 0, 'unreadable state → no prompt');
          } else if (!shouldRequestReview(prior)) {
            invariant(mockKvWrites === 0, 'already reviewed → no write');
            invariant(native.calls === 0, 'already reviewed → no prompt');
          } else if (mockKvWriteMode === 'throw') {
            invariant(native.calls === 0, 'failed write → no prompt');
          } else {
            invariant(
              mockKvWrites === concurrent,
              `one write per report (got ${mockKvWrites} for ${concurrent})`,
            );
            invariant(
              native.calls === concurrent,
              `one prompt per report (got ${native.calls} for ${concurrent})`,
            );
            const after = parseReviewPromptState(
              mockKvTable.get(REVIEW_PROMPT_KV_KEY) ?? null,
            );
            checkState(after, 'persisted');
            // A pinned (nonString) read hands every queued report the same
            // prior, so the persisted counters advance by one, not by N.
            const delta = mockKvReadMode === 'ok' ? concurrent : 1;
            invariant(
              after.scoredAnalyses === prior.scoredAnalyses + delta ||
                prior.scoredAnalyses > Number.MAX_SAFE_INTEGER,
              `scoredAnalyses advanced by ${delta} (${prior.scoredAnalyses} → ${after.scoredAnalyses})`,
            );
            invariant(
              after.promptedCount === prior.promptedCount + delta ||
                prior.promptedCount > Number.MAX_SAFE_INTEGER,
              `promptedCount advanced by ${delta}`,
            );
            invariant(
              after.reviewedAtIso === null,
              'reviewedAtIso untouched by a report',
            );
            invariant(
              after.lastPromptedAtIso !== null &&
                !Number.isNaN(Date.parse(after.lastPromptedAtIso)),
              'lastPromptedAtIso is a parsable timestamp',
            );
          }
          invariant(
            prototypeFingerprint() === fingerprint,
            'no prototype pollution',
          );
        },
      );
    }
    expect(brokenSummary(table.since(before))).toBe(
      `0 broken of ${table.records.length - before}`,
    );
  });

  it('rateAppFromSettings / markStoreReviewCompleted always resolve to a contract outcome', async () => {
    const before = table.records.length;
    for (let i = 0; i < plan.iterations; i += 1) {
      await runCaseAsync(
        table,
        'rateFromSettings',
        plan.seedAt(i, 0x2a2a),
        async (rng, log) => {
          mockKvTable.clear();
          mockKvWrites = 0;
          if (rng.chance(0.7))
            mockKvTable.set(
              REVIEW_PROMPT_KV_KEY,
              malformedReviewState(rng, log),
            );
          mockKvReadMode = rng.pick(['ok', 'ok', 'throw']);
          mockKvWriteMode = rng.pick(['ok', 'ok', 'throw']);
          const nativeMode = rng.pick<NativeMode>([
            'true',
            'false',
            'throws',
            'missing',
          ]);
          const native = installNative(nativeMode, rng);
          const urlRoll = rng.int(0, 4);
          const url =
            urlRoll === 0
              ? null
              : urlRoll === 1
                ? ''
                : urlRoll === 2
                  ? weirdString(rng)
                  : 'https://apps.apple.com/app/id6806918402?action=write-review';
          const openMode = rng.pick(['ok', 'throw', 'nonPromise']);
          log.push(
            `read=${mockKvReadMode}`,
            `write=${mockKvWriteMode}`,
            `native=${nativeMode}`,
            `url=${url === null ? 'null' : `len${url.length}`}`,
            `open=${openMode}`,
          );
          const opened: string[] = [];
          const outcome = await rateAppFromSettings({
            writeReviewUrl: url,
            openUrl: target => {
              opened.push(target);
              if (openMode === 'throw')
                return Promise.reject(new Error('no store'));
              if (openMode === 'nonPromise')
                return undefined as unknown as Promise<unknown>;
              return Promise.resolve(true);
            },
          });
          invariant(
            outcome === 'store_page' ||
              outcome === 'native_prompt' ||
              outcome === 'unavailable',
            `outcome in contract (got ${safeString(outcome)})`,
          );
          if (url) {
            invariant(
              opened.length === 1 && opened[0] === url,
              'deep link opened exactly once, verbatim',
            );
            if (openMode !== 'throw') {
              invariant(
                outcome === 'store_page',
                'successful deep link → store_page',
              );
              const stored = parseReviewPromptState(
                mockKvTable.get(REVIEW_PROMPT_KV_KEY) ?? null,
              );
              if (mockKvReadMode === 'ok' && mockKvWriteMode === 'ok') {
                invariant(
                  stored.reviewedAtIso !== null,
                  'reviewed marked durably',
                );
              }
            } else {
              invariant(
                outcome !== 'store_page',
                'failed deep link never reports store_page',
              );
            }
          } else {
            invariant(opened.length === 0, 'no url → nothing opened');
            invariant(
              outcome ===
                (nativeMode === 'true' ? 'native_prompt' : 'unavailable'),
              `fallback outcome for native=${nativeMode} (got ${outcome})`,
            );
            invariant(mockKvWrites === 0, 'native fallback never writes');
          }
          invariant(native.calls <= 1, 'at most one StoreKit ask');
          await markStoreReviewCompleted();
          await markStoreReviewCompleted();
          if (mockKvReadMode === 'ok' && mockKvWriteMode === 'ok') {
            const stored = parseReviewPromptState(
              mockKvTable.get(REVIEW_PROMPT_KV_KEY) ?? null,
            );
            invariant(
              stored.reviewedAtIso !== null,
              'markStoreReviewCompleted persists',
            );
            invariant(
              shouldRequestReview(stored) === false,
              'reviewed → no more asks',
            );
          }
          invariant(
            prototypeFingerprint() === fingerprint,
            'no prototype pollution',
          );
        },
      );
    }
    expect(brokenSummary(table.since(before))).toBe(
      `0 broken of ${table.records.length - before}`,
    );
  });
});

describe('appStoreReview · pinned boundary probes', () => {
  it.each([
    '{"__proto__":{"polluted":true}}',
    '{"constructor":{"prototype":{"polluted":true}}}',
    '{"scoredAnalyses":-0,"promptedCount":-1}',
    '{"scoredAnalyses":1e309,"promptedCount":"7"}',
    '{"scoredAnalyses":NaN}',
    '{"version":2,"scoredAnalyses":3}',
    '{"reviewedAtIso":""}',
    `{"reviewedAtIso":"${'x'.repeat(70_000)}"}`,
    '{"reviewedAtIso":"\\u0000"}',
    '\uFEFF{"scoredAnalyses":1}',
  ])('parseReviewPromptState(%s) normalizes without polluting', raw => {
    const state = parseReviewPromptState(raw);
    expect(state.version).toBe(1);
    expect(
      Number.isInteger(state.scoredAnalyses) && state.scoredAnalyses >= 0,
    ).toBe(true);
    expect(
      Number.isInteger(state.promptedCount) && state.promptedCount >= 0,
    ).toBe(true);
    expect(
      (Object.prototype as { polluted?: unknown }).polluted,
    ).toBeUndefined();
  });

  it('a non-empty non-timestamp reviewedAtIso is accepted verbatim and silences prompting (documented lenient contract)', () => {
    for (const raw of [
      '{"reviewedAtIso":"nope"}',
      '{"reviewedAtIso":"\\u0000"}',
    ]) {
      const state = parseReviewPromptState(raw);
      expect(state.reviewedAtIso).not.toBeNull();
      expect(shouldRequestReview(state)).toBe(false);
    }
  });
});
