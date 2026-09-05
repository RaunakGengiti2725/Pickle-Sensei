/**
 * Self-check for `test-support/stress/progressHistoryConcurrencyHarness.ts`:
 * proves the campaign's verdicts carry information by planting faults in the
 * modules under test (via jest.mock wrappers around the real implementations)
 * and asserting the harness names the violated invariant. A harness that
 * cannot see a planted fault would make every `held` verdict meaningless.
 *
 * Faults are switched per test through the `mockFault` flag so one module
 * registry serves all cases; with the flag off the wrappers are transparent.
 */
import {
  runIteration,
  type IterationResult,
} from '../../test-support/stress/progressHistoryConcurrencyHarness';

type Fault =
  | 'none'
  | 'set_delta_off_by_one'
  | 'history_drops_a_capture'
  | 'history_mutates_input'
  | 'api_no_deadline'
  | 'api_retries_once'
  | 'api_raw_rejection'
  | 'api_writes_store';

let mockFault: Fault = 'none';

jest.mock('../../src/progress/practiceSetProgress', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/practiceSetProgress')
  >('../../src/progress/practiceSetProgress');
  return {
    ...actual,
    summarizePracticeSet: (
      ...args: Parameters<typeof actual.summarizePracticeSet>
    ) => {
      const summary = actual.summarizePracticeSet(...args);
      if (mockFault === 'set_delta_off_by_one' && summary) {
        return { ...summary, deltaTenths: summary.deltaTenths + 1 };
      }
      return summary;
    },
  };
});

jest.mock('../../src/progress/practiceHistory', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/practiceHistory')
  >('../../src/progress/practiceHistory');
  return {
    ...actual,
    buildPracticeHistory: (
      ...args: Parameters<typeof actual.buildPracticeHistory>
    ) => {
      const [captures, options] = args;
      if (mockFault === 'history_drops_a_capture' && captures.length > 0) {
        return actual.buildPracticeHistory(captures.slice(1), options);
      }
      if (mockFault === 'history_mutates_input' && captures.length > 0) {
        const first = captures[0] as { capturedAtIso: string };
        first.capturedAtIso = `${first.capturedAtIso}`.replace('T', 'T0');
      }
      return actual.buildPracticeHistory(captures, options);
    },
  };
});

jest.mock('../../src/progress/api', () => {
  const actual = jest.requireActual<typeof import('../../src/progress/api')>(
    '../../src/progress/api',
  );
  const session = jest.requireActual<
    typeof import('../../src/account/apiSession')
  >('../../src/account/apiSession');
  const fetchCanonicalProgress: typeof actual.fetchCanonicalProgress = async (
    apiSession,
    fetchFn = globalThis.fetch,
  ) => {
    switch (mockFault) {
      case 'api_no_deadline': {
        // The real body of api.ts without the abort timer.
        const controller = new AbortController();
        const response = await fetchFn(`${apiSession.apiBaseUrl}/v1/progress`, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiSession.bearerToken}`,
            'X-Client-Version': jest
              .requireActual<typeof import('../../src/config/runtimeConfig')>(
                '../../src/config/runtimeConfig',
              )
              .getRuntimePublicConfig().appVersion,
          },
        }).catch(() => {
          throw new actual.ProgressApiError('unavailable');
        });
        const payload = (await response.json().catch(() => null)) as unknown;
        if (!response.ok) throw new actual.ProgressApiError('unavailable');
        // parseProgress is private; reuse the real function for the shape.
        return actual.fetchCanonicalProgress(
          apiSession,
          async () =>
            ({
              ok: true,
              status: 200,
              json: async () => payload,
            }) as unknown as Response,
        );
      }
      case 'api_retries_once':
        try {
          return await actual.fetchCanonicalProgress(apiSession, fetchFn);
        } catch {
          return await actual.fetchCanonicalProgress(apiSession, fetchFn);
        }
      case 'api_raw_rejection':
        return actual.fetchCanonicalProgress(apiSession, fetchFn).catch(() => {
          throw new TypeError('raw');
        });
      case 'api_writes_store':
        session.clearApiSession();
        return actual.fetchCanonicalProgress(apiSession, fetchFn);
      default:
        return actual.fetchCanonicalProgress(apiSession, fetchFn);
    }
  };
  return { ...actual, fetchCanonicalProgress };
});

const SEEDS = Array.from({ length: 12 }, (_, i) => 101 + i);

async function campaign(fault: Fault): Promise<IterationResult[]> {
  mockFault = fault;
  const results: IterationResult[] = [];
  for (const seed of SEEDS) results.push(await runIteration(seed));
  mockFault = 'none';
  return results;
}

function invariantsHit(results: IterationResult[]): Set<string> {
  return new Set(results.flatMap(r => r.failures.map(f => f.invariant)));
}

describe('progressHistoryConcurrency harness self-check', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is transparent with no fault planted (only the known body-read gap)', async () => {
    const hit = invariantsHit(await campaign('none'));
    hit.delete('unbounded_body_read');
    expect([...hit]).toEqual([]);
  });

  it('catches a practice-set delta that drifts by one tenth', async () => {
    expect(invariantsHit(await campaign('set_delta_off_by_one'))).toContain(
      'oracle_practice_set',
    );
  });

  it('catches a practice history that silently drops a capture', async () => {
    expect(invariantsHit(await campaign('history_drops_a_capture'))).toContain(
      'oracle_history',
    );
  });

  it('catches a practice history that mutates its input rows', async () => {
    expect(invariantsHit(await campaign('history_mutates_input'))).toContain(
      'pure_no_mutation',
    );
  });

  it('catches a progress fetch that forgets its deadline', async () => {
    const hit = invariantsHit(await campaign('api_no_deadline'));
    expect(hit.has('deadline') || hit.has('bounded')).toBe(true);
  });

  it('catches a progress fetch that retries (double spend)', async () => {
    expect(invariantsHit(await campaign('api_retries_once'))).toContain(
      'one_fetch',
    );
  });

  it('catches a progress fetch that leaks a raw rejection', async () => {
    expect(invariantsHit(await campaign('api_raw_rejection'))).toContain(
      'typed_error',
    );
  });

  it('catches a progress fetch that writes the session store', async () => {
    expect(invariantsHit(await campaign('api_writes_store'))).toContain(
      'store_untouched',
    );
  });
});
