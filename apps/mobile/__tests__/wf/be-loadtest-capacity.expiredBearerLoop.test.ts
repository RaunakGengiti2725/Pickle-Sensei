/**
 * Load-capacity pin (be-loadtest-capacity): a device whose bearer has expired
 * must not hammer the backend with the dead token.
 *
 * The sync runtime binds the provider ID token once per sign-in
 * (syncRuntime.configureSyncRuntime → createTransport({ token })); the edge
 * function answers an expired token with 401 and pays one Supabase Auth
 * exchange per such request (see tools/loadtest/wf-expired-token-loop.js).
 * The outbox classifies 401 as transient (isPermanentSyncFailure) so the row
 * keeps its attempt budget for the next sign-in, the transport reports the
 * rejected bearer to the auth layer (which tears the session down), and the
 * timer backs off exponentially after every failed drain instead of firing a
 * fixed 30 s cadence. This suite pins that cost model.
 */
import { AppState } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { drainOutbox, isPermanentSyncFailure } from '../../src/data/sync';
import { ApiError } from '../../src/data/api';
import {
  SYNC_RETRY_BASE_MS,
  clearSyncRuntime,
  configureSyncRuntime,
} from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  type ApiSession,
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

import { getDb } from '../../src/data/db';

const RETRY_INTERVAL_MS = SYNC_RETRY_BASE_MS;

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
const session: ApiSession = {
  canonicalAppUserId: '33333333-3333-4333-8333-333333333333',
  apiBaseUrl: 'https://api.test',
  bearerToken: EXPIRED_BEARER,
  provider: 'apple',
};

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
    setApiUnauthorizedListener(null);
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    delete (globalThis as { fetch?: unknown }).fetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('401 is transient: the row never consumes an attempt, so it stays syncable for the next sign-in', async () => {
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

  it('the timer backs off exponentially after each 401 and reports the dead bearer to the auth layer', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
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

    const unauthorized = jest.fn();
    establishApiSession(session);
    setApiUnauthorizedListener(unauthorized);

    configureSyncRuntime(session);
    // Immediate drain on configure: one request, and the 401 is reported so
    // the auth store can end or re-establish the session.
    await jest.advanceTimersByTimeAsync(0);
    expect(bearersSeen).toHaveLength(1);
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(unauthorized).toHaveBeenCalledWith(session);

    // Even if nothing tears the runtime down, six minutes of an expired
    // session in the foreground costs 2 more requests (at 60 s and 180 s),
    // not 12: the failed drains double the delay (60, 120, 240 … capped).
    const seenAtTick: number[] = [];
    for (let tick = 1; tick <= 12; tick++) {
      await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
      seenAtTick.push(bearersSeen.length);
    }
    expect(seenAtTick).toEqual([1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3]);
    expect(new Set(bearersSeen)).toEqual(new Set([`Bearer ${EXPIRED_BEARER}`]));
    expect(outbox[0]!.attempts).toBe(0);
  });
});
