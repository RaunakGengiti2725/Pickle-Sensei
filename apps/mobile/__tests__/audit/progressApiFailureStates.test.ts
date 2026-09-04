/**
 * Execution-audit harness (mobile-home-progress-library, pass 2).
 *
 * Failure/empty/stale/missing-data states of `fetchCanonicalProgress` that
 * the shipped suites leave uncovered (api.ts: non-OK status, non-JSON body,
 * non-record trend rows, non-string checkpoint, malformed streak). Every
 * branch must reject with ProgressApiError and never resolve a partial
 * object; the abort timer must be cleared on every exit path.
 */
import type { ApiSession } from '../../src/account/apiSession';
import {
  fetchCanonicalProgress,
  ProgressApiError,
  type ProgressFetch,
} from '../../src/progress/api';

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'real-token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'google',
};

const validStreak = {
  currentDays: 2,
  longestDays: 5,
  practicedToday: true,
  lastPracticeDate: '2026-09-03',
};

function respond(body: string, status = 200): ProgressFetch {
  return async () =>
    new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

describe('audit: canonical progress failure states', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('a 500 with a JSON error body rejects with the unavailable copy (never parsed as progress)', async () => {
    await expect(
      fetchCanonicalProgress(
        session,
        respond(JSON.stringify({ error: 'boom' }), 500),
      ),
    ).rejects.toMatchObject({
      name: 'ProgressApiError',
      message: 'Account progress is temporarily unavailable.',
    });
  });

  it('a 401 with an empty body rejects with the unavailable copy', async () => {
    await expect(
      fetchCanonicalProgress(session, respond('', 401)),
    ).rejects.toBeInstanceOf(ProgressApiError);
  });

  it('a 200 with a non-JSON body rejects as an invalid response', async () => {
    await expect(
      fetchCanonicalProgress(session, respond('<html>proxy</html>', 200)),
    ).rejects.toThrow('The progress server returned an invalid response.');
  });

  it('a 200 with an empty body rejects as an invalid response', async () => {
    await expect(
      fetchCanonicalProgress(session, respond('', 200)),
    ).rejects.toThrow('The progress server returned an invalid response.');
  });

  it('an empty-but-well-formed payload resolves with empty collections (honest empty state)', async () => {
    const progress = await fetchCanonicalProgress(
      session,
      respond(
        JSON.stringify({
          series: [],
          improving: [],
          needsAttention: [],
          streak: {
            currentDays: 0,
            longestDays: 0,
            practicedToday: false,
            lastPracticeDate: null,
          },
        }),
      ),
    );
    expect(progress.series).toEqual([]);
    expect(progress.improving).toEqual([]);
    expect(progress.needsAttention).toEqual([]);
    expect(progress.streak.lastPracticeDate).toBeNull();
  });

  it.each([
    ['trend row is not a record', { improving: [3] }],
    [
      'trend checkpoint is not a string',
      { improving: [{ checkpoint: 1, delta: 0.2 }] },
    ],
    [
      'trend value is non-finite',
      { needsAttention: [{ checkpoint: 'x', delta: 'NaN' }] },
    ],
    [
      'streak practicedToday is not boolean',
      { streak: { ...validStreak, practicedToday: 'yes' } },
    ],
    [
      'streak lastPracticeDate is a number',
      { streak: { ...validStreak, lastPracticeDate: 20260903 } },
    ],
    [
      'series point missing day',
      {
        series: [
          {
            shotType: 'dink',
            avgScore: 6,
            shotCount: 1,
            scoringModelVersion: 'v1',
          },
        ],
      },
    ],
    ['series is an object', { series: {} }],
    ['streak missing', { streak: undefined }],
  ])('rejects when %s', async (_label, overrides) => {
    const payload = {
      series: [],
      improving: [],
      needsAttention: [],
      streak: validStreak,
      ...overrides,
    };
    await expect(
      fetchCanonicalProgress(session, respond(JSON.stringify(payload))),
    ).rejects.toBeInstanceOf(ProgressApiError);
  });

  // REPRO (audit finding, api.ts finiteNumber): `Number(null|''|true|[])`
  // is finite, so missing/boolean/empty metrics are COERCED to 0 or 1 and
  // the response resolves instead of rejecting. The live view
  // (`progress_daily`) never emits null avg_score, so this is latent.
  it('REPRO: a null avg_score / shot_count in a series row is coerced to 0 instead of rejected', async () => {
    const progress = await fetchCanonicalProgress(
      session,
      respond(
        JSON.stringify({
          series: [
            {
              day: '2026-09-03',
              shot_type: 'dink',
              scoring_model_version: 'v1',
              shot_count: null,
              avg_score: null,
              best_score: '',
            },
          ],
          improving: [{ checkpoint: 'x', delta: true }],
          needsAttention: [{ checkpoint: 'y', avg: [] }],
          streak: { ...validStreak, currentDays: null, longestDays: true },
        }),
      ),
    );
    expect(progress.series[0]).toMatchObject({
      shotCount: 0,
      avgScore: 0,
      bestScore: 0,
    });
    expect(progress.improving[0]?.delta).toBe(1);
    expect(progress.needsAttention[0]?.avg).toBe(0);
    expect(progress.streak.currentDays).toBe(0);
    expect(progress.streak.longestDays).toBe(1);
  });

  it('clears the deadline timer on the success path (no pending timers leak)', async () => {
    jest.useFakeTimers();
    await fetchCanonicalProgress(
      session,
      respond(
        JSON.stringify({
          series: [],
          improving: [],
          needsAttention: [],
          streak: validStreak,
        }),
      ),
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the deadline timer on the network-failure path', async () => {
    jest.useFakeTimers();
    const fetchFn: ProgressFetch = async () => {
      throw new TypeError('Network request failed');
    };
    await expect(fetchCanonicalProgress(session, fetchFn)).rejects.toThrow(
      'Account progress is temporarily unavailable.',
    );
    expect(jest.getTimerCount()).toBe(0);
  });
});
