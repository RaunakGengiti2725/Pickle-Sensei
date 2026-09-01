/**
 * Load-capacity pin (be-loadtest-capacity): a device whose bearer has expired
 * keeps re-sending its outbox on the fixed 30 s timer.
 *
 * The sync runtime binds the provider ID token once per sign-in
 * (syncRuntime.configureSyncRuntime → createTransport({ token })) and nothing
 * refreshes it; the edge function answers an expired token with 401 and, on
 * its side, pays one Supabase Auth exchange per such request (see
 * tools/loadtest/wf-expired-token-loop.js). The outbox classifies 401 as
 * transient (isPermanentSyncFailure) so the row never burns an attempt, and
 * RETRY_INTERVAL_MS fires regardless of the last outcome. This suite pins that
 * cost model: N timer ticks ⇒ N identical POST /v1/shots:sync calls with the
 * same dead bearer, attempts stay at 0, and no Retry-After / backoff is
 * consulted.
 */
import { AppState } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { drainOutbox, isPermanentSyncFailure } from '../../src/data/sync';
import { ApiError } from '../../src/data/api';
import {
  clearSyncRuntime,
  configureSyncRuntime,
} from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

import { getDb } from '../../src/data/db';

const RETRY_INTERVAL_MS = 30_000;

function fakeDb(owner: string) {
  const outbox = [
    {
      id: 1,
      owner_key: owner,
      kind: 'shot.sync',
      payload: JSON.stringify({
        id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        analysisPermitId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        sessionId: null,
        shotType: 'dink',
        cameraView: 'side',
        capturedAt: '2026-09-01T12:00:00.000Z',
        timestamps: { startMs: 0, contactMs: 400, endMs: 900 },
        overallScore: 6.5,
        confidence: 0.9,
        resultKind: 'scored',
        source: 'real',
        phases: [],
        checkpoints: [],
        versionVector: {},
      }),
      attempts: 0,
      last_error: null as string | null,
    },
  ];
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      if (sql === 'BEGIN IMMEDIATE' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT id, kind, payload')) {
        return {
          rows: outbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                r.attempts < Number(params[1]),
            )
            .map(r => ({ ...r })),
        };
      }
      if (sql.startsWith('UPDATE outbox')) {
        const row = outbox.find(r => r.id === params[2]);
        if (row) {
          if (sql.includes('attempts = attempts + 1')) row.attempts += 1;
          row.last_error = String(params[0]);
        }
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM outbox')) {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT count(*)')) {
        return { rows: [{ n: outbox.length }] };
      }
      throw new Error(`fakeDb: unhandled sql ${sql}`);
    },
    close() {},
  };
  return { db, outbox };
}

const EXPIRED_BEARER = 'expired-apple-identity-token';
const session = {
  canonicalAppUserId: '33333333-3333-4333-8333-333333333333',
  apiBaseUrl: 'https://api.test',
  bearerToken: EXPIRED_BEARER,
} as Parameters<typeof configureSyncRuntime>[0];

function unauthorizedResponse(): Response {
  return {
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    headers: new Map(),
    json: async () => ({
      error: {
        code: 'unauthorized',
        message: 'The identity token could not be verified.',
      },
    }),
  } as unknown as Response;
}

describe('be-loadtest-capacity — expired bearer retry loop', () => {
  const owner = canonicalDataOwner(session.canonicalAppUserId);

  afterEach(() => {
    clearSyncRuntime();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    delete (globalThis as { fetch?: unknown }).fetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('401 is transient: the row never consumes an attempt, so it is retried forever', async () => {
    const { db, outbox } = fakeDb(owner);
    setActiveDataOwner(owner);
    const unauthorized = new ApiError(
      401,
      'unauthorized',
      'The identity token could not be verified.',
    );
    expect(isPermanentSyncFailure(unauthorized)).toBe(false);
    let calls = 0;
    const transport = {
      syncShots: async () => {
        calls += 1;
        throw unauthorized;
      },
      createSession: async () => {},
      finalizeSession: async () => {},
    };
    for (let i = 0; i < 12; i++) {
      const result = await drainOutbox(db, transport);
      expect(result).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    }
    expect(calls).toBe(12);
    expect(outbox[0]!.attempts).toBe(0);
    expect(outbox[0]!.last_error).toContain('could not be verified');
  });

  it('the 30 s timer re-sends the same expired bearer every tick with no backoff', async () => {
    jest.useFakeTimers();
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(
        () =>
          ({ remove: () => {} }) as ReturnType<
            typeof AppState.addEventListener
          >,
      );
    const { db, outbox } = fakeDb(owner);
    (getDb as jest.Mock).mockReturnValue(db);
    setActiveDataOwner(owner);
    const bearersSeen: string[] = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(
      (_url: string, init: { headers: Record<string, string> }) => {
        bearersSeen.push(init.headers.authorization ?? '<none>');
        return Promise.resolve(unauthorizedResponse());
      },
    );

    configureSyncRuntime(session);
    // Immediate drain on configure.
    await jest.advanceTimersByTimeAsync(0);
    expect(bearersSeen).toHaveLength(1);

    // Twelve timer ticks ≈ six minutes of an expired session in the
    // foreground: twelve more uncacheable auth exchanges server-side.
    for (let tick = 1; tick <= 12; tick++) {
      await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
      expect(bearersSeen).toHaveLength(1 + tick);
    }
    expect(new Set(bearersSeen)).toEqual(new Set([`Bearer ${EXPIRED_BEARER}`]));
    expect(outbox[0]!.attempts).toBe(0);
  });
});
