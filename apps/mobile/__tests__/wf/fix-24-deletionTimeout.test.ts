/**
 * Account deletion requests carry a client-side deadline: a fetch that never
 * settles is aborted and surfaced as a retryable, typed "temporarily offline"
 * failure so the Manage Account sheet can never stay pinned in
 * requesting/deleting.
 */
import type { ApiSession } from '../../src/account/apiSession';
import {
  AccountDeletionError,
  confirmAccountDeletion,
  requestAccountDeletion,
} from '../../src/account/deletion';

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test/functions/v1/api',
  bearerToken: 'provider-token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'google',
};

function hangingFetch() {
  return jest.fn((_input: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
      );
    });
  });
}

describe('account deletion request deadline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes an abort signal to every deletion request', async () => {
    const fetchFn = jest.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(
      confirmAccountDeletion(session, 'challenge', fetchFn),
    ).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('step 1 aborts a hung delete-request after 15s with retryable offline copy', async () => {
    const fetchFn = hangingFetch();
    const pending = requestAccountDeletion(session, fetchFn);
    const settled = pending.then(
      () => 'resolved',
      (error: unknown) => error,
    );

    await jest.advanceTimersByTimeAsync(14_999);
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    const error = await settled;
    expect(error).toBeInstanceOf(AccountDeletionError);
    expect(error).toMatchObject({
      code: 'deletion.unavailable',
      retryable: true,
      message:
        'Account deletion is temporarily offline. Nothing was deleted — please try again.',
    });
  });

  it('step 2 aborts a hung delete-confirm after 15s with retryable offline copy', async () => {
    const fetchFn = hangingFetch();
    const settled = confirmAccountDeletion(session, 'challenge', fetchFn).then(
      () => 'resolved',
      (error: unknown) => error,
    );

    await jest.advanceTimersByTimeAsync(15_000);

    const error = await settled;
    expect(error).toBeInstanceOf(AccountDeletionError);
    expect(error).toMatchObject({
      code: 'deletion.unavailable',
      retryable: true,
    });
    expect(jest.getTimerCount()).toBe(0);
  });
});
