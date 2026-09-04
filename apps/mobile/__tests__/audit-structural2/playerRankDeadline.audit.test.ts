/**
 * Structural audit #2 (pass 1) — request deadlines on the two optional
 * account reads Home/Progress issue. `/v1/progress` aborts after
 * PROGRESS_REQUEST_TIMEOUT_MS (15 s). This asks whether `/v1/rank` has the
 * same protection: with a fetch that never settles, does fetchPlayerRank
 * reject within 20 s, or hang for the life of the process?
 */
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({ appVersion: '1.0.0-audit' }),
}));

import { fetchCanonicalProgress } from '../../src/progress/api';
import { fetchPlayerRank } from '../../src/progress/playerRank';

const session = {
  apiBaseUrl: 'https://example.invalid',
  bearerToken: 'audit-token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
} as unknown as Parameters<typeof fetchPlayerRank>[0];

function blackHoleFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as unknown as typeof fetch;
}

describe('audit: optional account reads have a bounded deadline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('/v1/progress rejects within 20 s on a black-holed network (control)', async () => {
    let settled: 'pending' | 'rejected' | 'resolved' = 'pending';
    const promise = fetchCanonicalProgress(session, blackHoleFetch()).then(
      () => {
        settled = 'resolved';
      },
      () => {
        settled = 'rejected';
      },
    );
    await jest.advanceTimersByTimeAsync(20_000);
    await promise.catch(() => undefined);
    expect(settled).toBe('rejected');
  });

  it('/v1/rank rejects within 20 s on a black-holed network', async () => {
    let settled: 'pending' | 'rejected' | 'resolved' = 'pending';
    void fetchPlayerRank(session, blackHoleFetch()).then(
      () => {
        settled = 'resolved';
      },
      () => {
        settled = 'rejected';
      },
    );
    await jest.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe('rejected');
  });
});
