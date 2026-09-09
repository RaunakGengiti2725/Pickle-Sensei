/**
 * INT-sync-outbox-persistence adversary — the real transport (createTransport
 * over a faulted fetch) feeding the real drainOutbox on a real SQLite outbox.
 *
 * Attacks: 429/5xx/401/408 mid-flush, network loss, an intermediary's 4xx
 * page, a slow backend that answers AFTER the deadline, and acknowledgements
 * whose shape lies about what was saved.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import { API_REQUEST_TIMEOUT_MS, createTransport } from '../../src/data/api';
import { drainOutbox, OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import { getShotOutboxStatus } from '../../src/data/repository';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  createSqliteTestDb,
  closeSqliteTestDatabases,
} from '../../testSupport/sqlite';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const savedFetch = globalThis.fetch;

function analysis(
  n: number,
  sessionId: string | null = null,
): ShotAnalysis & { analysisPermitId: string } {
  return {
    id: id(n),
    analysisPermitId: id(n + 10000),
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-07T12:00:01.000Z',
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    source: 'real',
    versionVector: {
      appVersion: '1.0',
      modelBundleVersion: 'test-native-1',
      poseModelVersion: 'test-pose-1',
      paddleModelVersion: 'test-paddle-1',
      strokeDetectorVersion: 'test-stroke-1',
      phaseModelVersion: 'test-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
  };
}

function fixture() {
  const store = createSqliteTestDb();
  const push = (kind: string, payload: unknown, owner = OWNER) => {
    store.native
      .prepare('INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)')
      .run(owner, kind, JSON.stringify(payload));
  };
  const rows = (owner = OWNER) =>
    store.native
      .prepare('SELECT * FROM outbox WHERE owner_key = ? ORDER BY id')
      .all(owner);
  const transport = createTransport({
    baseUrl: 'https://invalid.test',
    token: 'test-token',
  });
  return { store, push, rows, transport };
}

function httpResponse(
  status: number,
  body: unknown,
  statusText = 'Error',
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    redirected: false,
    type: 'basic',
    url: '',
    headers: new Map<string, string>(),
    json: async () => {
      if (typeof body === 'string') throw new SyntaxError('not json');
      return body;
    },
  } as unknown as Response;
}

function coded(status: number, code: string): Response {
  return httpResponse(status, { error: { code, message: `${code} message` } });
}

beforeEach(() => setActiveDataOwner(OWNER));
afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = savedFetch;
  closeSqliteTestDatabases();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('ADV-5 whole-request failures mid-flush through the real transport', () => {
  const transient: Array<[string, () => Promise<Response>]> = [
    ['429 rate limit', async () => coded(429, 'rate_limit.exceeded')],
    ['500 internal', async () => coded(500, 'internal')],
    ['502 gateway', async () => httpResponse(502, '<html>bad gateway</html>')],
    ['503 unavailable', async () => coded(503, 'service.unavailable')],
    ['401 expired bearer', async () => coded(401, 'auth.required')],
    ['408 server-side timeout', async () => coded(408, 'network.timeout')],
    [
      'network loss',
      async () => {
        throw new TypeError('Network request failed');
      },
    ],
    [
      'captive portal 403 page',
      async () => httpResponse(403, '<html>portal</html>'),
    ],
    [
      'gateway 404 without envelope',
      async () => httpResponse(404, { message: 'no route' }),
    ],
    [
      '204 empty body',
      async () => httpResponse(204, 'no content', 'No Content'),
    ],
    [
      '302 redirect',
      async () =>
        httpResponse(302, { acceptedIds: [id(100), id(101)], rejected: [] }),
    ],
  ];

  it.each(transient)(
    '%s keeps every row queued with zero attempts and no receipt, across the whole retry budget',
    async (_name, answer) => {
      const { store, push, rows, transport } = fixture();
      push('shot.sync', analysis(100));
      push('shot.sync', analysis(101));
      globalThis.fetch = jest.fn(answer);
      for (let n = 0; n < OUTBOX_MAX_ATTEMPTS + 1; n++) {
        const result = await drainOutbox(store.db, transport);
        expect(result.synced).toBe(0);
        expect(result.remaining).toBe(2);
      }
      expect(rows()).toHaveLength(2);
      expect(rows().every(row => row.attempts === 0)).toBe(true);
      expect(rows().every(row => row.repair_reason === null)).toBe(true);
      expect(store.count('sync_receipt', OWNER)).toBe(0);
      expect(await getShotOutboxStatus(store.db, id(100))).toMatchObject({
        state: 'queued',
        attempts: 0,
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(OUTBOX_MAX_ATTEMPTS + 1);
    },
  );

  const verdicts: Array<[string, number, string]> = [
    ['400 coded validation', 400, 'validation.shots_sync'],
    ['403 coded forbidden', 403, 'access.forbidden'],
    ['409 coded conflict', 409, 'shot.conflict'],
    ['413 coded too large', 413, 'request.too_large'],
    ['422 coded unprocessable', 422, 'validation.failed'],
  ];

  it.each(verdicts)(
    '%s burns exactly one attempt per drain, never deletes, and stops at the budget',
    async (_name, status, code) => {
      const { store, push, rows, transport } = fixture();
      push('shot.sync', analysis(100));
      push('shot.sync', analysis(101));
      globalThis.fetch = jest.fn(async () => coded(status, code));
      for (let n = 1; n <= OUTBOX_MAX_ATTEMPTS + 2; n++) {
        await drainOutbox(store.db, transport);
        const expected = Math.min(n, OUTBOX_MAX_ATTEMPTS);
        expect(rows().map(row => row.attempts)).toEqual([expected, expected]);
      }
      expect(globalThis.fetch).toHaveBeenCalledTimes(OUTBOX_MAX_ATTEMPTS);
      expect(rows()).toHaveLength(2);
      expect(store.count('sync_receipt', OWNER)).toBe(0);
      expect(await getShotOutboxStatus(store.db, id(100))).toMatchObject({
        state: 'exhausted',
        attempts: OUTBOX_MAX_ATTEMPTS,
      });
    },
  );
});

describe('ADV-6 slow backend: the answer arrives AFTER the client deadline', () => {
  it('a late 200 acceptance can never write a receipt or delete a row', async () => {
    jest.useFakeTimers();
    const { store, push, rows, transport } = fixture();
    push('shot.sync', analysis(100));
    let answerLate!: () => void;
    globalThis.fetch = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          answerLate = () =>
            resolve(
              httpResponse(200, { acceptedIds: [id(100)], rejected: [] }, 'OK'),
            );
        }),
    );
    const drain = drainOutbox(store.db, transport);
    // Let the request start (the batch selection is async), then run past
    // the 20s deadline.
    for (let spins = 0; spins < 1000 && !answerLate; spins++)
      await Promise.resolve();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(API_REQUEST_TIMEOUT_MS + 1);
    const result = await drain;
    expect(result.synced).toBe(0);
    expect(result.remaining).toBe(1);
    expect(rows()[0]?.attempts).toBe(0);
    expect(String(rows()[0]?.last_error)).toContain('took too long');
    // The server's answer lands well after the deadline.
    answerLate();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.count('sync_receipt', OWNER)).toBe(0);
    expect(rows()).toHaveLength(1);
    jest.useRealTimers();
    // A later drain with a healthy backend completes the save exactly once.
    globalThis.fetch = jest.fn(async () =>
      httpResponse(200, { acceptedIds: [id(100)], rejected: [] }, 'OK'),
    );
    await drainOutbox(store.db, transport);
    expect(store.count('sync_receipt', OWNER)).toBe(1);
    expect(rows()).toEqual([]);
  });
});

describe('ADV-7 acknowledgements that lie about what was saved', () => {
  const lying: Array<[string, () => unknown]> = [
    [
      'accepted count matches but names another owner\u2019s shot',
      () => ({
        acceptedIds: [id(100), id(200)],
        rejected: [],
      }),
    ],
    [
      'accepted twice, one row missing',
      () => ({
        acceptedIds: [id(100), id(100)],
        rejected: [],
      }),
    ],
    [
      'accepted AND rejected for the same shot',
      () => ({
        acceptedIds: [id(100), id(101)],
        rejected: [{ id: id(101), code: 'shot.write_failed', message: 'x' }],
      }),
    ],
    [
      'only a subset acknowledged',
      () => ({
        acceptedIds: [id(100)],
        rejected: [],
      }),
    ],
    [
      'acknowledges a shot already receipted in an earlier drain',
      () => ({
        acceptedIds: [id(100), id(101), id(300)],
        rejected: [],
      }),
    ],
    ['acceptedIds is a string', () => ({ acceptedIds: id(100), rejected: [] })],
    ['empty object', () => ({})],
    [
      'rejected entry without code',
      () => ({
        acceptedIds: [id(100)],
        rejected: [{ id: id(101), message: 'no code' }],
      }),
    ],
    [
      'rejected code is not a string',
      () => ({
        acceptedIds: [id(100)],
        rejected: [{ id: id(101), code: 500 }],
      }),
    ],
    [
      'rejected id is a number',
      () => ({
        acceptedIds: [id(100)],
        rejected: [{ id: 101, code: 'shot.invalid' }],
      }),
    ],
  ];

  it.each(lying)(
    '%s: nothing is receipted, deleted or exhausted; the other owner is untouched',
    async (_name, body) => {
      const { store, push, rows, transport } = fixture();
      push('shot.sync', analysis(100));
      push('shot.sync', analysis(101));
      push('shot.sync', analysis(200), OTHER_OWNER);
      store.native
        .prepare(
          "INSERT INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)",
        )
        .run(OWNER, id(300));
      globalThis.fetch = jest.fn(async () => httpResponse(200, body(), 'OK'));
      for (let n = 0; n < OUTBOX_MAX_ATTEMPTS + 1; n++)
        await drainOutbox(store.db, transport);
      expect(rows()).toHaveLength(2);
      expect(rows().every(row => row.attempts === 0)).toBe(true);
      expect(rows().every(row => row.repair_reason === null)).toBe(true);
      expect(
        store.native
          .prepare('SELECT entity_id FROM sync_receipt WHERE owner_key = ?')
          .all(OWNER)
          .map(row => row.entity_id),
      ).toEqual([id(300)]);
      expect(rows(OTHER_OWNER)).toHaveLength(1);
      expect(store.count('sync_receipt', OTHER_OWNER)).toBe(0);
      expect(globalThis.fetch).toHaveBeenCalledTimes(OUTBOX_MAX_ATTEMPTS + 1);
    },
  );

  it('a per-item transient rejection code never burns the retry budget while a permanent one does', async () => {
    const { store, push, rows, transport } = fixture();
    push('shot.sync', analysis(100));
    push('shot.sync', analysis(101));
    globalThis.fetch = jest.fn(async () =>
      httpResponse(
        200,
        {
          acceptedIds: [],
          rejected: [
            { id: id(100), code: 'shot.write_failed', message: 'db busy' },
            {
              id: id(101),
              code: 'access.permit_not_reserved',
              message: 'no permit',
            },
          ],
        },
        'OK',
      ),
    );
    for (let n = 0; n < OUTBOX_MAX_ATTEMPTS + 2; n++)
      await drainOutbox(store.db, transport);
    expect(
      rows().map(row => [
        String(JSON.parse(String(row.payload)).id),
        row.attempts,
      ]),
    ).toEqual([
      [id(100), 0],
      [id(101), OUTBOX_MAX_ATTEMPTS],
    ]);
    expect(store.count('sync_receipt', OWNER)).toBe(0);
    expect(await getShotOutboxStatus(store.db, id(100))).toMatchObject({
      state: 'queued',
    });
    const exhausted = await getShotOutboxStatus(store.db, id(101));
    expect(exhausted.state).toBe('exhausted');
    expect(
      exhausted.state === 'exhausted' ? exhausted.lastError : null,
    ).toContain('access.permit_not_reserved');
  });
});
