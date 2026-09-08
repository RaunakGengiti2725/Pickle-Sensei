/**
 * ADVERSARY (performance-bounds): the durable outbox under a long outage.
 *
 * A player who rates for weeks with no connectivity accumulates hundreds of
 * `shot.sync` rows. Probed against the REAL sync transport (fetch mocked at
 * the network edge) and a real SQLite outbox:
 *  1. one drain pass over a 600-row backlog must stay bounded — one shot
 *     batch (≤ 50 rows) and one network request, and a transient failure
 *     must not consume the permanent attempt budget of any row;
 *  2. the error text the drain persists per row comes from the server's
 *     `error.message` verbatim. Per-item rejection messages are capped at
 *     2000 chars by the transport (api.ts `item.message.length > 2000`), so
 *     the same bound is asserted for the top-level error a 5xx (or a proxy
 *     in front of the function) can return — otherwise every failed drain
 *     rewrites `batch × message` bytes into the outbox until the outage ends.
 */
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { createTransport } from '../../src/data/api';
import { drainOutbox, OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
} from '../../testSupport/sqlite';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

const owner = '66666666-6666-4666-8666-666666666666';
const BACKLOG_ROWS = 600;
const BATCH_LIMIT = 50;
/** Same bound api.ts applies to per-item rejection messages. */
const MAX_PERSISTED_ERROR_CHARS = 2_000;

function shotPayload(index: number): string {
  const suffix = String(index).padStart(12, '0');
  return JSON.stringify({
    id: `aaaaaaaa-bbbb-4ccc-8ddd-${suffix}`,
    analysisPermitId: `bbbbbbbb-bbbb-4ccc-8ddd-${suffix}`,
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.1,
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
  });
}

async function seedBacklog(db: LocalDb, rows: number): Promise<void> {
  for (let index = 0; index < rows; index += 1) {
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
      [owner, shotPayload(index)],
    );
  }
}

async function outboxStats(db: LocalDb): Promise<{
  rows: number;
  maxAttempts: number;
  touched: number;
  maxErrorChars: number;
  totalErrorChars: number;
}> {
  const { rows } = await db.execute(
    `SELECT count(*) AS rows, max(attempts) AS max_attempts,
            sum(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS touched,
            coalesce(max(length(last_error)), 0) AS max_error_chars,
            coalesce(sum(length(last_error)), 0) AS total_error_chars
     FROM outbox WHERE owner_key = ?`,
    [owner],
  );
  const row = rows[0]!;
  return {
    rows: Number(row['rows']),
    maxAttempts: Number(row['max_attempts']),
    touched: Number(row['touched']),
    maxErrorChars: Number(row['max_error_chars']),
    totalErrorChars: Number(row['total_error_chars']),
  };
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 503 ? 'Service Unavailable' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

describe('ADV perf: outbox backlog under network loss', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    closeSqliteTestDatabases();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('one drain over 600 queued shots while offline touches one batch, makes one request and consumes no attempt budget', async () => {
    const { db } = createSqliteTestDb();
    await seedBacklog(db, BACKLOG_ROWS);
    const fetchMock = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const transport = createTransport({
      baseUrl: 'https://api.test',
      token: 'token-1',
    });

    const start = performance.now();
    const result = await drainOutbox(db, transport);
    const ms = performance.now() - start;
    const stats = await outboxStats(db);
    console.warn(
      `[adv] offline drain over ${BACKLOG_ROWS} rows: ${ms.toFixed(0)} ms, ${fetchMock.mock.calls.length} request(s), ${stats.touched} rows touched`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      synced: 0,
      failed: BATCH_LIMIT,
      remaining: BACKLOG_ROWS,
    });
    expect(stats.rows).toBe(BACKLOG_ROWS);
    expect(stats.touched).toBe(BATCH_LIMIT);
    // Offline is transient: nothing moves toward OUTBOX_MAX_ATTEMPTS.
    expect(stats.maxAttempts).toBe(0);
    expect(OUTBOX_MAX_ATTEMPTS).toBe(8);
  });

  it('a 5xx whose error.message is 1 MiB is not persisted verbatim into every row of the batch', async () => {
    const { db } = createSqliteTestDb();
    await seedBacklog(db, BATCH_LIMIT);
    const hugeMessage = 'x'.repeat(1_048_576);
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
      response(503, {
        error: { code: 'server.unavailable', message: hugeMessage },
      }),
    );
    const transport = createTransport({
      baseUrl: 'https://api.test',
      token: 'token-1',
    });

    const result = await drainOutbox(db, transport);
    const stats = await outboxStats(db);
    console.warn(
      `[adv] 503 with 1 MiB message: max last_error ${stats.maxErrorChars} chars, total ${stats.totalErrorChars} chars across ${stats.touched} rows`,
    );
    expect(result.failed).toBe(BATCH_LIMIT);
    // 5xx is transient — the rows stay retryable…
    expect(stats.maxAttempts).toBe(0);
    // …and what is recorded about the failure must be bounded.
    expect(stats.maxErrorChars).toBeLessThanOrEqual(MAX_PERSISTED_ERROR_CHARS);
  });

  function acknowledgingFetch(
    respond: (ids: string[]) => Response,
  ): jest.Mock<Promise<Response>, [string, RequestInit]> {
    return jest.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        shots: Array<{ id: string }>;
      };
      return respond(body.shots.map(shot => shot.id));
    });
  }

  async function drainRepeatedly(
    db: LocalDb,
    passes: number,
  ): Promise<number[]> {
    const transport = createTransport({
      baseUrl: 'https://api.test',
      token: 'token-1',
    });
    const remaining: number[] = [];
    for (let pass = 0; pass < passes; pass += 1) {
      remaining.push((await drainOutbox(db, transport)).remaining);
    }
    return remaining;
  }

  it('repeated drains against a permanent per-item rejection stop at OUTBOX_MAX_ATTEMPTS, then cost no request and keep the rows', async () => {
    const { db } = createSqliteTestDb();
    await seedBacklog(db, BATCH_LIMIT);
    const fetchMock = acknowledgingFetch(ids =>
      response(200, {
        acceptedIds: [],
        rejected: ids.map(id => ({
          id,
          code: 'shot.invalid_payload',
          message: 'Rejected by contract.',
        })),
      }),
    );
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const drains = OUTBOX_MAX_ATTEMPTS + 4;
    const remaining = await drainRepeatedly(db, drains);
    const stats = await outboxStats(db);
    console.warn(
      `[adv] ${drains} drains, permanent rejection: ${fetchMock.mock.calls.length} request(s), max attempts ${stats.maxAttempts}, remaining per pass ${remaining.join(',')}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(OUTBOX_MAX_ATTEMPTS);
    expect(stats.maxAttempts).toBe(OUTBOX_MAX_ATTEMPTS);
    // Exhausted rows are parked (evidence kept), never deleted.
    expect(stats.rows).toBe(BATCH_LIMIT);
    expect(remaining.every(count => count === BATCH_LIMIT)).toBe(true);
    expect(stats.maxErrorChars).toBeLessThanOrEqual(MAX_PERSISTED_ERROR_CHARS);
  });

  it('repeated drains against a 200 that acknowledges nothing stay transient: one request per drain, no attempt burned, bounded error text', async () => {
    const { db } = createSqliteTestDb();
    await seedBacklog(db, BATCH_LIMIT);
    const fetchMock = acknowledgingFetch(() =>
      response(200, { acceptedIds: [], rejected: [] }),
    );
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const drains = OUTBOX_MAX_ATTEMPTS + 4;
    const remaining = await drainRepeatedly(db, drains);
    const stats = await outboxStats(db);
    console.warn(
      `[adv] ${drains} drains, unacknowledged 200: ${fetchMock.mock.calls.length} request(s), max attempts ${stats.maxAttempts}, max last_error ${stats.maxErrorChars} chars`,
    );
    // A verdict set that does not cover every id is a protocol error the
    // transport treats as transient (evidence is never dropped for a server
    // bug) — so the cost must stay one request per drain, never more.
    expect(fetchMock).toHaveBeenCalledTimes(drains);
    expect(stats.maxAttempts).toBe(0);
    expect(stats.rows).toBe(BATCH_LIMIT);
    expect(remaining.every(count => count === BATCH_LIMIT)).toBe(true);
    expect(stats.maxErrorChars).toBeLessThanOrEqual(MAX_PERSISTED_ERROR_CHARS);
  });
});
