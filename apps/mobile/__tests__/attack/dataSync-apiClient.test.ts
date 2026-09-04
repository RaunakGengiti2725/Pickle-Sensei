/**
 * ADVERSARIAL TESTER #2 (pass 3) — api.ts request() body-read hazards.
 *
 *  S6  fetch resolves headers immediately but response.json() never settles:
 *      does request() settle within API_REQUEST_TIMEOUT_MS (20 s)? The abort
 *      timer is cleared in the `finally` right after fetch() resolves
 *      (api.ts request()), so the body read is unbounded at the logic level.
 *      NOTE (INFERRED, not run here): React Native 0.87.1 installs the
 *      `whatwg-fetch` 3.6.20 polyfill (react-native/Libraries/Network/fetch.js),
 *      whose fetch() only resolves in xhr.onload — i.e. after the WHOLE body
 *      is buffered — so on-device the 20 s timer does cover the body and
 *      `.json()` can never hang. This test pins the logic-level gap for any
 *      streaming fetch implementation.
 *  S7  200 with a non-JSON body (captive portal) through the real
 *      createTransport().syncShots → drainOutbox against a REAL SQLite: is the
 *      resulting TypeError classified transient and do attempts stay 0?
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  attackArtifactExists,
  RealSqlite,
  writeAttackArtifact,
} from '../../scripts/attack/realSqliteBridge';

let mockOpenImpl: () => unknown = () => {
  throw new Error('bridge not ready');
};
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => mockOpenImpl(),
}));

import { getDb } from '../../src/data/db';
import {
  API_REQUEST_TIMEOUT_MS,
  ApiError,
  createTransport,
} from '../../src/data/api';
import { drainOutbox } from '../../src/data/sync';
import { getShotOutboxStatus } from '../../src/data/repository';
import { deriveUploadQueueStatus } from '../../src/data/offlineCapabilities';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
});

const analysis: ShotAnalysis = {
  id: '11111111-2222-4333-8444-555555555555',
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-09-01T10:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 6.2,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'test-native-1',
    poseModelVersion: 'test-pose-1',
    paddleModelVersion: 'test-paddle-1',
    strokeDetectorVersion: 'test-stroke-1',
    phaseModelVersion: 'test-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};
const PERMIT = 'aaaaaaaa-2222-4333-8444-555555555555';

describe('S6 — headers arrive, response.json() never settles', () => {
  test('request() does NOT settle within 20 s (nor within 10 min): the abort timer is cleared before the body read', async () => {
    jest.useFakeTimers();
    let signalAbortedAtTimeout: boolean | null = null;
    let capturedSignal: AbortSignal | null = null;
    globalThis.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      capturedSignal = init?.signal ?? null;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => new Promise<never>(() => {}),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const transport = createTransport({
      baseUrl: 'https://stalled.example',
      token: 'attack-token',
    });
    let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
    const call = transport.syncShots([]).then(
      () => {
        settled = 'resolved';
      },
      () => {
        settled = 'rejected';
      },
    );
    // Let fetch() resolve and the finally{} run.
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS + 1);
    signalAbortedAtTimeout = capturedSignal
      ? (capturedSignal as AbortSignal).aborted
      : null;
    const at20s = settled;
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    const at10min = settled;
    const pendingTimers = jest.getTimerCount();

    const artifact = writeAttackArtifact('s6-unbounded-body-read.json', {
      apiRequestTimeoutMs: API_REQUEST_TIMEOUT_MS,
      settledAt20s: at20s,
      settledAt10min: at10min,
      abortSignalFiredAt20s: signalAbortedAtTimeout,
      pendingTimersAfter: pendingTimers,
      runtimeNote:
        'INFERRED: RN 0.87.1 whatwg-fetch 3.6.20 resolves fetch() only in xhr.onload (full body buffered), so this path is not reachable on-device; the gap applies to any streaming fetch.',
    });
    expect(attackArtifactExists(artifact)).toBe(true);

    // ATTACK RESULT (logic level): unbounded — the timer was cleared, the
    // signal never fires, and the caller's await never settles.
    expect(at20s).toBe('pending');
    expect(at10min).toBe('pending');
    expect(signalAbortedAtTimeout).toBe(false);
    expect(pendingTimers).toBe(0);
    void call;
  });

  test('control: a fetch() that never resolves DOES settle as ApiError 408 at exactly 20 s', async () => {
    jest.useFakeTimers();
    globalThis.fetch = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
          );
        }),
    ) as unknown as typeof fetch;
    const transport = createTransport({
      baseUrl: 'https://stalled.example',
      token: 'attack-token',
    });
    const outcome = transport.syncShots([]).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS - 1);
    let early: unknown = 'pending';
    void outcome.then(v => {
      early = v;
    });
    await Promise.resolve();
    expect(early).toBe('pending');
    await jest.advanceTimersByTimeAsync(2);
    const error = await outcome;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 408, code: 'network.timeout' });
  });
});

describe('S7 — 200 + non-JSON body (captive portal) through the real transport', () => {
  let bridge: RealSqlite;
  let db: ReturnType<typeof getDb>;
  beforeAll(() => {
    bridge = new RealSqlite('captive');
    mockOpenImpl = () => bridge;
    setActiveDataOwner(GUEST_DATA_OWNER);
    db = getDb();
  });
  afterAll(() => {
    db.close();
    bridge.dispose();
  });
  beforeEach(async () => {
    bridge.executeSync('DELETE FROM outbox');
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
      [
        GUEST_DATA_OWNER,
        JSON.stringify({ ...analysis, analysisPermitId: PERMIT }),
      ],
    );
  });

  test('syncShots resolves null, drainOutbox throws TypeError → transient, attempts 0, row retried on the next drain', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    const transport = createTransport({
      baseUrl: 'https://captive.example',
      token: 'attack-token',
    });
    const direct = await transport.syncShots([]);
    const first = await drainOutbox(db, transport);
    const afterFirst = await getShotOutboxStatus(db, analysis.id);
    const rawFirst = bridge.executeSync(
      `SELECT attempts, last_error FROM outbox`,
    ).rows[0];
    const second = await drainOutbox(db, transport);
    const rawSecond = bridge.executeSync(
      `SELECT attempts, last_error FROM outbox`,
    ).rows[0];
    const queue = deriveUploadQueueStatus([
      {
        kind: 'shot.sync',
        attempts: Number(rawSecond?.['attempts']),
        lastError: (rawSecond?.['last_error'] as string | null) ?? null,
      },
    ]);
    const artifact = writeAttackArtifact('s7-captive-portal-200.json', {
      transportReturned: direct,
      firstDrain: first,
      statusAfterFirst: afterFirst,
      rowAfterFirst: rawFirst,
      secondDrain: second,
      rowAfterSecond: rawSecond,
      uploadQueueStatus: queue,
      fetchCalls: (fetchMock as jest.Mock).mock.calls.length,
    });
    expect(attackArtifactExists(artifact)).toBe(true);

    // request() swallows the parse failure and returns null as the typed
    // response; drainOutbox dereferences it.
    expect(direct).toBeNull();
    expect(first).toEqual({ synced: 0, failed: 1, remaining: 1 });
    expect(rawFirst?.['attempts']).toBe(0);
    expect(String(rawFirst?.['last_error'])).toMatch(/^TypeError: /);
    expect(String(rawFirst?.['last_error'])).toContain('acceptedIds');
    expect(afterFirst).toMatchObject({ state: 'queued', attempts: 0 });
    // HELD: still transient on repeat; the row is never exhausted by a portal.
    expect(second).toEqual({ synced: 0, failed: 1, remaining: 1 });
    expect(rawSecond?.['attempts']).toBe(0);
    expect(queue).toEqual({ state: 'queued', pending: 1 });
    expect((fetchMock as jest.Mock).mock.calls).toHaveLength(3);
  });

  test('200 with a VALID-JSON but wrong-shaped body (portal returning {"status":"ok"}) behaves the same', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok' }),
    })) as unknown as typeof fetch;
    const transport = createTransport({
      baseUrl: 'https://captive.example',
      token: 'attack-token',
    });
    const result = await drainOutbox(db, transport);
    const raw = bridge.executeSync(`SELECT attempts, last_error FROM outbox`)
      .rows[0];
    writeAttackArtifact('s7b-captive-portal-json-shape.json', { result, raw });
    expect(result).toEqual({ synced: 0, failed: 1, remaining: 1 });
    expect(raw?.['attempts']).toBe(0);
    expect(String(raw?.['last_error'])).toMatch(/^TypeError: /);
  });
});
