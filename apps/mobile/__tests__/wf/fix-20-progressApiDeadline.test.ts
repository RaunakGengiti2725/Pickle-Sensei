import type { ApiSession } from '../../src/account/apiSession';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import {
  fetchCanonicalProgress,
  PROGRESS_REQUEST_TIMEOUT_MS,
  ProgressApiError,
  type ProgressFetch,
} from '../../src/progress/api';

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'real-token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'google',
};

const okPayload = JSON.stringify({
  series: [],
  improving: [],
  needsAttention: [],
  streak: {
    currentDays: 0,
    longestDays: 0,
    practicedToday: false,
    lastPracticeDate: null,
  },
});

describe('fix-20: canonical progress request deadline + client version', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends the shipped app version as X-Client-Version, never a stale literal', async () => {
    let headers: RequestInit['headers'];
    const fetchFn: ProgressFetch = async (_url, init) => {
      headers = init?.headers;
      return new Response(okPayload, { status: 200 });
    };

    await fetchCanonicalProgress(session, fetchFn);

    const appVersion = getRuntimePublicConfig().appVersion;
    expect(appVersion).not.toBe('0.1.0');
    expect(headers).toMatchObject({ 'X-Client-Version': appVersion });
  });

  it('hands the fetch an abort signal bound to the deadline', async () => {
    let signal: AbortSignal | null | undefined;
    const fetchFn: ProgressFetch = async (_url, init) => {
      signal = init?.signal;
      return new Response(okPayload, { status: 200 });
    };

    await fetchCanonicalProgress(session, fetchFn);

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it('rejects a hung request with the unavailable copy instead of pending forever', async () => {
    jest.useFakeTimers();
    const fetchFn: ProgressFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      });

    const pending = fetchCanonicalProgress(session, fetchFn);
    const settled = jest.fn();
    void pending.then(settled, settled);

    jest.advanceTimersByTime(PROGRESS_REQUEST_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await expect(pending).rejects.toBeInstanceOf(ProgressApiError);
    await expect(pending).rejects.toThrow(
      'Account progress is temporarily unavailable.',
    );
  });

  it('clears the deadline once the response arrives', async () => {
    jest.useFakeTimers();
    const fetchFn: ProgressFetch = async () =>
      new Response(okPayload, { status: 200 });

    await fetchCanonicalProgress(session, fetchFn);

    expect(jest.getTimerCount()).toBe(0);
  });
});
