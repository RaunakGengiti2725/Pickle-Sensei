/**
 * Two-step account deletion: the client for /v1/me/delete-request +
 * /v1/me/delete-confirm (step-2 must present step-1's challenge), and the
 * post-confirmation local purge that removes every owner-scoped row.
 *
 * Failure honesty: a step-1 failure always says NOTHING was deleted (the
 * request only mints a challenge). A step-2 failure says so ONLY when the
 * server answered that it did not act (4xx other than 401); a timeout, a
 * network drop, a 5xx or a 401 leave the outcome open (`mayHaveDeleted`) —
 * the server may have deleted the account and fenced the bearer before the
 * answer was lost. A 401 on either step is reported to the auth layer like
 * every other API client's, so the session layer can settle it.
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
    ).rejects.toMatchObject({ retryable: true, mayHaveDeleted: false });

    const down = jest.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      confirmAccountDeletion(session, 'challenge', down),
    ).rejects.toBeInstanceOf(AccountDeletionError);
  });

  it('step 1 network drop: nothing was deleted; step 2 network drop: the outcome is open and the copy says so', async () => {
    const down = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const requestError = (await requestAccountDeletion(
      session,
      null,
      down,
    ).catch((e: unknown) => e)) as AccountDeletionError;
    expect(requestError).toMatchObject({
      code: 'deletion.unavailable',
      retryable: true,
      mayHaveDeleted: false,
    });
    expect(requestError.message).toContain('Nothing was deleted');

    const confirmError = (await confirmAccountDeletion(
      session,
      'challenge',
      down,
    ).catch((e: unknown) => e)) as AccountDeletionError;
    expect(confirmError).toMatchObject({
      code: 'deletion.unavailable',
      retryable: true,
      mayHaveDeleted: true,
    });
    expect(confirmError.message).not.toContain('Nothing was deleted');
    expect(confirmError.message).toMatch(/not yet known|whether your account/);
  });

  it('step 2 refused by the server (403) is known not to have deleted; a 5xx is not', async () => {
    const refused = jest.fn(async () =>
      jsonResponse(403, { error: { message: 'Challenge expired.' } }),
    );
    await expect(
      confirmAccountDeletion(session, 'challenge', refused),
    ).rejects.toMatchObject({ retryable: false, mayHaveDeleted: false });

    const crashed = jest.fn(async () =>
      jsonResponse(500, { error: { message: 'Internal error.' } }),
    );
    await expect(
      confirmAccountDeletion(session, 'challenge', crashed),
    ).rejects.toMatchObject({ retryable: true, mayHaveDeleted: true });
  });
});

describe('account deletion 401 → auth layer', () => {
  const listener = jest.fn();
  const liveSession: ApiSession = {
    ...session,
    bearerToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
  };

  beforeEach(() => {
    listener.mockReset();
    establishApiSession(liveSession);
    setApiUnauthorizedListener(listener);
  });

  afterEach(() => {
    setApiUnauthorizedListener(null);
    clearApiSession();
  });

  const unauthorized = () =>
    jest.fn(async () =>
      jsonResponse(401, { error: { message: 'Sign in again.' } }),
    );

  it('step 1: reports the rejected bearer BEFORE throwing; nothing was deleted', async () => {
    const fetchFn = unauthorized();
    const order: string[] = [];
    listener.mockImplementation(() => order.push('reported'));
    await requestAccountDeletion(liveSession, null, fetchFn).catch(
      (e: unknown) => {
        order.push('thrown');
        expect(e).toMatchObject({
          code: 'deletion.session_expired',
          retryable: false,
          mayHaveDeleted: false,
        });
      },
    );
    expect(order).toEqual(['reported', 'thrown']);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ bearerToken: 'access-token-1' }),
    );
  });

  it('step 2: reports the rejected bearer BEFORE throwing; the outcome is open and the challenge may be retried once the session settles', async () => {
    const fetchFn = unauthorized();
    const order: string[] = [];
    listener.mockImplementation(() => order.push('reported'));
    const error = (await confirmAccountDeletion(
      liveSession,
      'challenge',
      fetchFn,
    ).catch((e: unknown) => {
      order.push('thrown');
      return e;
    })) as AccountDeletionError;
    expect(order).toEqual(['reported', 'thrown']);
    expect(error).toMatchObject({
      code: 'deletion.session_expired',
      retryable: true,
      mayHaveDeleted: true,
    });
    expect(error.message).not.toContain('Nothing was deleted');
  });

  it('a 401 for a bearer that is no longer current is not reported (late answer for a rotated token)', async () => {
    establishApiSession({ ...liveSession, bearerToken: 'access-token-2' });
    await expect(
      confirmAccountDeletion(liveSession, 'challenge', unauthorized()),
    ).rejects.toMatchObject({ code: 'deletion.session_expired' });
    expect(listener).not.toHaveBeenCalled();
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
