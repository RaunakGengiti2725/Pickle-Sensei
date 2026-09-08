/**
 * INT-networking-recovery adversarial probe — 429 + Retry-After.
 *
 * The edge answers every budget overrun with `429` + `Retry-After: <s>`
 * (rateLimit.ts rateLimitResponse) and the auth gateway relays upstream
 * `Retry-After` on 503. This probe drives the REAL sync runtime
 * (`configureSyncRuntime` → `createTransport` → `fetch`) against a server
 * that says "come back in 120 s" and checks whether the client honours it:
 *
 *   - the timer-driven retry must not fire before the advertised window;
 *   - a foreground event inside the window must not re-send;
 *   - the row's attempt budget must not be consumed (control — pinned
 *     elsewhere too, kept here so the same run shows both halves);
 *   - a 429 on permit reservation is one typed failure (control).
 *
 * Runs on Linux/Jest with an in-memory LocalDb; no device, no production.
 */
import { AppState } from 'react-native';
import { getDb } from '../../src/data/db';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  clearSyncRuntime,
  configureSyncRuntime,
} from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import { ApiError, createAnalysisPermitClient } from '../../src/data/api';
import {
  createFakeLocalDb,
  type FakeLocalDb,
} from '../../testing/xcBehavioral/fakeLocalDb';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

const USER_A = '11111111-1111-4111-8111-111111111111';
const RETRY_AFTER_SECONDS = 120;

const sessionA: ApiSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'bearer-a',
  canonicalAppUserId: USER_A,
  provider: 'apple',
};

function shotPayload(id: string) {
  return {
    id,
    sessionId: null,
    shotType: 'drive',
    stroke: 'drive',
    handedness: 'right',
    cameraView: 'side',
    createdAt: '2026-08-30T10:00:00.000Z',
    modelVersion: 'm1',
    pipelineVersion: 'p1',
    versionVector: { model: 'm1', pipeline: 'p1' },
    overallScore: 70,
    checkpoints: [],
    provenance: {
      appVersion: 't',
      modelVersion: 'm1',
      pipelineVersion: 'p1',
      captureMode: 'automatic_pose_trigger',
      captureRecordedAt: '2026-08-30T10:00:00.000Z',
      poseSource: 'apple_vision_body_pose',
    },
    analysisPermitId: `permit-${id}`,
  };
}

function rateLimited(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'rate_limited',
        message: 'Too many requests. Please slow down and try again shortly.',
      },
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(RETRY_AFTER_SECONDS),
        'ratelimit-limit': '240',
        'ratelimit-remaining': '0',
      },
    },
  );
}

async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function advance(ms: number) {
  jest.advanceTimersByTime(ms);
  await flush();
}

describe('ADV networking-recovery: 429 Retry-After is honoured by the sync runtime', () => {
  const originalFetch = globalThis.fetch;
  let fake: FakeLocalDb;
  let syncCalls: number;
  let appStateHandlers: Array<(state: string) => void>;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    fake = createFakeLocalDb();
    syncCalls = 0;
    appStateHandlers = [];
    (getDb as jest.Mock).mockReturnValue(fake.db);
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/shots:sync')) syncCalls += 1;
      return rateLimited();
    }) as unknown as typeof fetch;
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, handler) => {
        appStateHandlers.push(handler as (state: string) => void);
        return { remove: () => {} } as ReturnType<
          typeof AppState.addEventListener
        >;
      });
    establishApiSession(sessionA);
    setActiveDataOwner(canonicalDataOwner(USER_A));
  });

  afterEach(() => {
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    globalThis.fetch = originalFetch;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const ownerA = canonicalDataOwner(USER_A);
  /** Largest retry the runtime can schedule after ONE failed drain
   * (consecutiveFailures = 1 → 2 × base, + 20 % jitter). */
  const maxFirstBackoffMs = Math.round(
    SYNC_RETRY_BASE_MS * 2 * (1 + SYNC_RETRY_JITTER_RATIO),
  );

  it('control: a 429 does not consume the attempt budget and the row stays durable', async () => {
    fake.push('shot.sync', shotPayload('shot-429'), ownerA);
    configureSyncRuntime(sessionA);
    await flush();
    expect(syncCalls).toBe(1);
    expect(fake.outbox).toHaveLength(1);
    expect(fake.outbox[0]!.attempts).toBe(0);
    expect(fake.outbox[0]!.last_error).toContain('Too many requests');
    expect(fake.receipts).toHaveLength(0);
  });

  it('timer retry: no re-send before the advertised Retry-After window elapses', async () => {
    fake.push('shot.sync', shotPayload('shot-429'), ownerA);
    configureSyncRuntime(sessionA);
    await flush();
    expect(syncCalls).toBe(1);
    // Well inside the 120 s the server asked for, but past the runtime's own
    // widest post-failure backoff (60 s + 20 % jitter = 72 s).
    expect(maxFirstBackoffMs + 1_000).toBeLessThan(RETRY_AFTER_SECONDS * 1_000);
    await advance(maxFirstBackoffMs + 1_000);
    expect(syncCalls).toBe(1);
    // …and the retry does arrive once the window is over (bounded, not dead).
    await advance(RETRY_AFTER_SECONDS * 1_000);
    expect(syncCalls).toBeGreaterThanOrEqual(2);
  });

  it('foreground inside the Retry-After window does not re-send the rate-limited batch', async () => {
    fake.push('shot.sync', shotPayload('shot-429'), ownerA);
    configureSyncRuntime(sessionA);
    await flush();
    expect(syncCalls).toBe(1);
    await advance(5_000);
    for (const handler of appStateHandlers) handler('active');
    await flush();
    expect(syncCalls).toBe(1);
  });

  // `ApiError` is {status, code, message} — it does not carry Retry-After, so
  // the analyze flow can only relay the server sentence. This pins that a
  // 429 on reserve is a single typed failure (one request, no client-side
  // retry storm, no crash); the missing retry timing is an observation for
  // the report, not a contract break.
  it('control: permit reservation 429 → one request, typed ApiError(429, rate_limited) with the server message', async () => {
    const permits = createAnalysisPermitClient({
      baseUrl: sessionA.apiBaseUrl,
      token: sessionA.bearerToken,
    });
    let caught: unknown = null;
    try {
      await permits.reserve('idem-429');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      status: 429,
      code: 'rate_limited',
      message: 'Too many requests. Please slow down and try again shortly.',
    });
    expect(syncCalls).toBe(0);
    expect((globalThis.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });
});
