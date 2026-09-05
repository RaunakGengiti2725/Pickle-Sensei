/**
 * Minimal, seed-free reproduction of the one gap the concurrency campaign
 * surfaced in `src/progress/api.ts` (`unbounded_body_read` in
 * progressHistoryConcurrency.stress.test.ts, e.g. STRESS_ONLY=25).
 *
 * `fetchCanonicalProgress` bounds the HEADER phase with a 15 s abort timer,
 * clears that timer in `finally`, and then awaits `response.json()` with no
 * bound. With a fetch that resolves once headers arrive (the WHATWG streaming
 * model: browsers, Node 18+, undici) a body that never completes therefore
 * hangs the call forever; ProgressScreen awaits it inside `Promise.all`, so
 * `loaded` would never flip.
 *
 * React Native 0.87's `fetch` is whatwg-fetch 3.6 over XMLHttpRequest, which
 * resolves only in `xhr.onload` — after the FULL body — so on the shipping
 * path the header deadline covers the body too and the gap is not reachable.
 * These tests characterise the module boundary as it is today; the second
 * one is expected to start failing the moment the body read gets a bound
 * (that is the point: flip it to a `resolves`/`rejects` pin then).
 */
import {
  fetchCanonicalProgress,
  ProgressApiError,
  PROGRESS_REQUEST_TIMEOUT_MS,
  type ProgressFetch,
} from '../../src/progress/api';
import type { ApiSession } from '../../src/account/apiSession';

const session: ApiSession = {
  apiBaseUrl: 'https://api.stress.test',
  bearerToken: 'bearer-characterization',
  canonicalAppUserId: '2f3c9d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  provider: 'apple',
};

function headersThenStalledBody(headerLatencyMs: number): ProgressFetch {
  return (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        init?.signal?.removeEventListener('abort', onAbort);
        resolve({
          ok: true,
          status: 200,
          json: () => new Promise<never>(() => undefined),
        } as unknown as Response);
      }, headerLatencyMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      };
      init?.signal?.addEventListener('abort', onAbort);
    });
}

describe('fetchCanonicalProgress deadline coverage (characterisation)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('HELD: headers that never arrive are aborted at the 15 s deadline', async () => {
    const pending = fetchCanonicalProgress(
      session,
      headersThenStalledBody(PROGRESS_REQUEST_TIMEOUT_MS + 60_000),
    );
    let settled: 'resolved' | 'rejected' | null = null;
    let error: unknown = null;
    void pending.then(
      () => (settled = 'resolved'),
      e => {
        settled = 'rejected';
        error = e;
      },
    );
    await jest.advanceTimersByTimeAsync(PROGRESS_REQUEST_TIMEOUT_MS - 1);
    expect(settled).toBeNull();
    await jest.advanceTimersByTimeAsync(2);
    expect(settled).toBe('rejected');
    expect(error).toBeInstanceOf(ProgressApiError);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('KNOWN GAP: headers at 1 ms then a body that never completes is never bounded', async () => {
    const pending = fetchCanonicalProgress(session, headersThenStalledBody(1));
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await jest.advanceTimersByTimeAsync(1);
    // Deadline timer already cleared; nothing is left that could settle it.
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(PROGRESS_REQUEST_TIMEOUT_MS * 10);
    expect(settled).toBe(false);
  });
});
