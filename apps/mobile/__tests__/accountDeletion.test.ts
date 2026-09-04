/**
 * Two-step account deletion: the client for /v1/me/delete-request +
 * /v1/me/delete-confirm (step-2 must present step-1's challenge; failures
 * always say NOTHING was deleted unless the server confirmed), and the
 * post-confirmation local purge that removes every owner-scoped row.
 */
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../src/account/apiSession';
import {
  ACCOUNT_DELETION_DETAILS_MAX,
  ACCOUNT_DELETION_REASONS,
  ACCOUNT_DELETION_WANTED,
  AccountDeletionError,
  confirmAccountDeletion,
  requestAccountDeletion,
} from '../src/account/deletion';
import type { LocalDb } from '../src/data/db';
import { purgeOwnerData } from '../src/data/repository';

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test/functions/v1/api',
  bearerToken: 'provider-token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'google',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('account deletion client', () => {
  it('step 1 mints a challenge from delete-request (skipped survey → no body)', async () => {
    const fetchFn = jest.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe(
        'https://api.example.test/functions/v1/api/v1/me/delete-request',
      );
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer provider-token',
      );
      // A skipped survey keeps the pre-survey wire shape: no body at all.
      expect(init?.body).toBeUndefined();
      return jsonResponse(200, {
        challenge: '33333333-3333-4333-8333-333333333333',
        expiresAt: '2026-08-30T21:15:00.000Z',
      });
    });

    await expect(
      requestAccountDeletion(session, null, fetchFn),
    ).resolves.toEqual({
      challenge: '33333333-3333-4333-8333-333333333333',
      expiresAt: '2026-08-30T21:15:00.000Z',
    });
  });

  it('step 1 carries the two-question exit survey verbatim under body.survey', async () => {
    const fetchFn = jest.fn(async (_input: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        survey: {
          reason: 'scores_inaccurate',
          wanted: 'accuracy',
          details: 'Backhand reads kept calling my drive a dink.',
          platform: 'ios',
          appVersion: '1.0',
        },
      });
      return jsonResponse(200, {
        challenge: '33333333-3333-4333-8333-333333333333',
        expiresAt: '2026-08-30T21:15:00.000Z',
      });
    });

    await requestAccountDeletion(
      session,
      {
        reason: 'scores_inaccurate',
        wanted: 'accuracy',
        details: 'Backhand reads kept calling my drive a dink.',
        platform: 'ios',
        appVersion: '1.0',
      },
      fetchFn,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('pins the survey vocabularies the server accepts (index.ts DELETION_SURVEY_*)', () => {
    expect([...ACCOUNT_DELETION_REASONS]).toEqual([
      'not_using',
      'not_helpful',
      'scores_inaccurate',
      'technical_issues',
      'too_expensive',
      'privacy',
      'other',
    ]);
    expect([...ACCOUNT_DELETION_WANTED]).toEqual([
      'accuracy',
      'price',
      'content',
      'stability',
      'switched',
      'nothing',
    ]);
    expect(ACCOUNT_DELETION_DETAILS_MAX).toBe(500);
  });

  it('step 1 refuses without a signed-in session', async () => {
    await expect(requestAccountDeletion(null)).rejects.toMatchObject({
      code: 'deletion.not_configured',
      retryable: false,
    });
  });

  it('step 2 sends the challenge and requires deleted:true', async () => {
    const fetchFn = jest.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe(
        'https://api.example.test/functions/v1/api/v1/me/delete-confirm',
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        challenge: '33333333-3333-4333-8333-333333333333',
      });
      return jsonResponse(200, {
        deleted: true,
        appleAuthorizationRevocation: 'revoked',
      });
    });

    await expect(
      confirmAccountDeletion(
        session,
        '33333333-3333-4333-8333-333333333333',
        fetchFn,
      ),
    ).resolves.toEqual({ appleAuthorizationRevocation: 'revoked' });
  });

  it('step 2 surfaces a stale/foreign challenge as non-retryable', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(403, {
        error: {
          code: 'account.deletion_challenge_expired',
          message: 'The deletion request expired. Start again from Settings.',
        },
      }),
    );

    await expect(
      confirmAccountDeletion(session, 'wrong-challenge', fetchFn),
    ).rejects.toMatchObject({
      code: 'deletion.rejected',
      retryable: false,
      message: expect.stringContaining('expired'),
    });
  });

  it('maps rate limiting and server failures to retryable errors', async () => {
    const limited = jest.fn(async () =>
      jsonResponse(429, { error: { message: 'Too many requests.' } }),
    );
    await expect(
      requestAccountDeletion(session, null, limited),
    ).rejects.toMatchObject({ retryable: true });

    const down = jest.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      confirmAccountDeletion(session, 'challenge', down),
    ).rejects.toBeInstanceOf(AccountDeletionError);
  });
});

/**
 * delete-confirm is the one request whose failure is AMBIGUOUS: the server
 * commits the delete before it answers, so a timeout / dropped connection
 * may hide a deletion that already happened. Once that account is gone its
 * bearer is dead and every later call — including a retry on the SAME
 * challenge — answers 401. The client keeps a per-challenge ledger of
 * confirms that went out unanswered and reads that 401 as "already
 * deleted", instead of telling the user to sign in to an account that no
 * longer exists.
 */
describe('ambiguous delete-confirm outcomes', () => {
  const appleSession: ApiSession = {
    apiBaseUrl: 'https://api.example.test/functions/v1/api',
    bearerToken: 'access-token-apple',
    canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
    provider: 'apple',
  };
  const unauthorizedListener = jest.fn();

  function abortingFetch(): jest.Mock<
    Promise<Response>,
    [string, RequestInit?]
  > {
    return jest.fn(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
  }

  async function timeOut<T>(pending: Promise<T>): Promise<unknown> {
    const settled = pending.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(15_000);
    return settled;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    unauthorizedListener.mockReset();
    establishApiSession(appleSession);
    setApiUnauthorizedListener(unauthorizedListener);
  });

  afterEach(() => {
    setApiUnauthorizedListener(null);
    clearApiSession();
    jest.useRealTimers();
  });

  it('step 2: a 401 reports the rejected bearer to the auth store exactly once', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(401, {
        error: { message: 'The session is no longer valid.' },
      }),
    );
    await expect(
      confirmAccountDeletion(appleSession, 'challenge-plain-401', fetchFn),
    ).rejects.toMatchObject({
      code: 'deletion.session_expired',
      retryable: false,
      message:
        'Your sign-in has expired. Sign in again, then delete your account.',
    });
    expect(unauthorizedListener).toHaveBeenCalledTimes(1);
    expect(unauthorizedListener).toHaveBeenCalledWith(appleSession);
  });

  it('step 2: a 401 for a bearer that already rotated away is not reported (stale token)', async () => {
    establishApiSession({
      ...appleSession,
      bearerToken: 'access-token-rotated',
    });
    const fetchFn = jest.fn(async () =>
      jsonResponse(401, {
        error: { message: 'The session is no longer valid.' },
      }),
    );
    await expect(
      confirmAccountDeletion(appleSession, 'challenge-stale-401', fetchFn),
    ).rejects.toMatchObject({ code: 'deletion.session_expired' });
    expect(unauthorizedListener).not.toHaveBeenCalled();
  });

  it('step 2: a timed-out confirm is retryable and never claims nothing was deleted', async () => {
    const fetchFn = abortingFetch();
    const error = (await timeOut(
      confirmAccountDeletion(appleSession, 'challenge-timeout', fetchFn),
    )) as AccountDeletionError;
    expect(error).toBeInstanceOf(AccountDeletionError);
    expect(error).toMatchObject({
      code: 'deletion.unavailable',
      retryable: true,
    });
    expect(error.message).not.toMatch(/Nothing was deleted/);
    expect(error.message).toMatch(/could not confirm/i);
    expect(unauthorizedListener).not.toHaveBeenCalled();
  });

  it('step 1: a timed-out delete-request still says nothing was deleted (no challenge was confirmed)', async () => {
    const fetchFn = abortingFetch();
    const error = (await timeOut(
      requestAccountDeletion(appleSession, null, fetchFn),
    )) as AccountDeletionError;
    expect(error).toMatchObject({
      code: 'deletion.unavailable',
      retryable: true,
      message:
        'Account deletion is temporarily offline. Nothing was deleted — please try again.',
    });
  });

  it('step 2: 401 on the SAME challenge after an unanswered confirm resolves as deleted (Apple revocation unconfirmed)', async () => {
    const challenge = 'challenge-lost-then-401';
    await timeOut(
      confirmAccountDeletion(appleSession, challenge, abortingFetch()),
    );
    const retry = jest.fn(async () =>
      jsonResponse(401, {
        error: { message: 'The session is no longer valid.' },
      }),
    );
    await expect(
      confirmAccountDeletion(appleSession, challenge, retry),
    ).resolves.toEqual({ appleAuthorizationRevocation: 'unconfirmed' });
    // The caller runs completeAccountDeletion (purge + Keychain clear); the
    // generic expired-session path is not raced against it.
    expect(unauthorizedListener).not.toHaveBeenCalled();

    // The ledger entry is consumed: a THIRD 401 on that challenge is a plain
    // expired session again.
    await expect(
      confirmAccountDeletion(appleSession, challenge, retry),
    ).rejects.toMatchObject({ code: 'deletion.session_expired' });
    expect(unauthorizedListener).toHaveBeenCalledTimes(1);
  });

  it('step 2: inferred deletion for a Google account has no Apple revocation to report', async () => {
    const googleSession: ApiSession = {
      ...appleSession,
      canonicalAppUserId: '33333333-3333-4333-8333-333333333333',
      provider: 'google',
    };
    const challenge = 'challenge-google-lost';
    await timeOut(
      confirmAccountDeletion(googleSession, challenge, abortingFetch()),
    );
    const retry = jest.fn(async () =>
      jsonResponse(401, {
        error: { message: 'The session is no longer valid.' },
      }),
    );
    await expect(
      confirmAccountDeletion(googleSession, challenge, retry),
    ).resolves.toEqual({ appleAuthorizationRevocation: 'not_applicable' });
  });

  it('step 2: a dropped connection (not only a timeout) counts as an unanswered confirm', async () => {
    const challenge = 'challenge-network-then-401';
    const dropped = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(
      confirmAccountDeletion(appleSession, challenge, dropped),
    ).rejects.toMatchObject({ code: 'deletion.unavailable', retryable: true });
    const retry = jest.fn(async () =>
      jsonResponse(401, {
        error: { message: 'The session is no longer valid.' },
      }),
    );
    await expect(
      confirmAccountDeletion(appleSession, challenge, retry),
    ).resolves.toEqual({ appleAuthorizationRevocation: 'unconfirmed' });
  });

  it('step 2: an unanswered confirm on ANOTHER challenge does not excuse a 401', async () => {
    await timeOut(
      confirmAccountDeletion(appleSession, 'challenge-A', abortingFetch()),
    );
    const retry = jest.fn(async () =>
      jsonResponse(401, {
        error: { message: 'The session is no longer valid.' },
      }),
    );
    await expect(
      confirmAccountDeletion(appleSession, 'challenge-B', retry),
    ).rejects.toMatchObject({ code: 'deletion.session_expired' });
    expect(unauthorizedListener).toHaveBeenCalledTimes(1);
  });

  it('step 2: an unanswered confirm followed by a definitive answer forgets the ambiguity', async () => {
    const challenge = 'challenge-lost-then-answered';
    await timeOut(
      confirmAccountDeletion(appleSession, challenge, abortingFetch()),
    );
    // The server never saw the first attempt; the retry lands normally.
    const ok = jest.fn(async () =>
      jsonResponse(200, {
        deleted: true,
        appleAuthorizationRevocation: 'revoked',
      }),
    );
    await expect(
      confirmAccountDeletion(appleSession, challenge, ok),
    ).resolves.toEqual({ appleAuthorizationRevocation: 'revoked' });

    // Same for a stale-challenge refusal: it is definitive, so a 401 that
    // comes later is an ordinary expired session.
    const other = 'challenge-lost-then-expired';
    await timeOut(confirmAccountDeletion(appleSession, other, abortingFetch()));
    const stale = jest.fn(async () =>
      jsonResponse(403, {
        error: {
          code: 'account.deletion_challenge_expired',
          message: 'The deletion request expired. Start again from Settings.',
        },
      }),
    );
    await expect(
      confirmAccountDeletion(appleSession, other, stale),
    ).rejects.toMatchObject({ code: 'deletion.rejected' });
    const unauthorized = jest.fn(async () =>
      jsonResponse(401, {
        error: { message: 'The session is no longer valid.' },
      }),
    );
    await expect(
      confirmAccountDeletion(appleSession, other, unauthorized),
    ).rejects.toMatchObject({ code: 'deletion.session_expired' });
  });
});

describe('post-deletion local purge', () => {
  it('removes every owner-scoped table row and the cached profile, transactionally', async () => {
    const owner = '11111111-1111-4111-8111-111111111111';
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db: LocalDb = {
      async execute(sql, params = []) {
        calls.push({ sql, params });
        return { rows: [] };
      },
      close() {},
    };

    await purgeOwnerData(db, owner);

    const sqls = calls.map(call => call.sql);
    expect(sqls[0]).toBe('BEGIN IMMEDIATE');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    for (const table of [
      'local_shot',
      'local_session',
      'local_capture',
      'local_analysis_record',
      'outbox',
      'sync_receipt',
    ]) {
      expect(sqls).toContainEqual(
        expect.stringContaining(`DELETE FROM ${table} WHERE owner_key = ?`),
      );
    }
    // Every owner-scoped kv namespace is purged (pinned so a store added
    // later cannot silently escape deletion).
    const kvParams = calls
      .filter(call => call.sql.includes('FROM kv'))
      .map(call => call.params[0]);
    expect(kvParams).toEqual([
      `profile:${owner}`,
      `rank.celebrated:${owner}`,
      `notifications:${owner}`,
      `consistency:${owner}`,
      `practice.set:${owner}`,
    ]);
    // Every owner-scoped delete is bound to the deleted owner.
    for (const call of calls.slice(1, -1)) {
      if (call.sql.includes('FROM kv')) {
        expect(String(call.params[0])).toMatch(new RegExp(`:${owner}$`));
      } else {
        expect(call.params[0]).toBe(owner);
      }
    }
  });
});
