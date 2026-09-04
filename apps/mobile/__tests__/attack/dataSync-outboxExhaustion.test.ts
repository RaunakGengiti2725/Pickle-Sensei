/**
 * ADVERSARIAL TESTER #2 (pass 3) — outbox attempt budget under whole-batch
 * transport failures, against a REAL SQLite (scripts/attack/realSqliteBridge).
 *
 *  S1  syncShots throws ApiError(413,'payload.too_large') for a 50-row batch:
 *      do all 50 valid rows reach attempts=8 after 8 drains and get reported
 *      exhausted?
 *  S2  syncShots throws an Error whose toString() contains the bearer: does
 *      recordRowFailure persist it verbatim into outbox.last_error (and does
 *      getShotOutboxStatus hand it to the Result screen)?
 *  S8  (own) captive-portal style whole-request 403 / 404 with an HTML body
 *      through the REAL createTransport(): is that classified permanent too?
 *
 * Seeded randomness: SEED below drives shot ids / scores (recorded in the
 * artifact).
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
import { ApiError, createTransport } from '../../src/data/api';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  type SyncTransport,
} from '../../src/data/sync';
import { getShotOutboxStatus } from '../../src/data/repository';
import { deriveUploadQueueStatus } from '../../src/data/offlineCapabilities';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const SEED = 0x5eed2026;
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function uuidFrom(random: () => number): string {
  const hex = () => Math.floor(random() * 16).toString(16);
  const seg = (n: number) => Array.from({ length: n }, hex).join('');
  return `${seg(8)}-${seg(4)}-4${seg(3)}-8${seg(3)}-${seg(12)}`;
}

function analysisFixture(random: () => number, index: number): ShotAnalysis {
  return {
    id: uuidFrom(random),
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: new Date(Date.UTC(2026, 8, 1, 10, 0, index)).toISOString(),
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: Math.round(random() * 100) / 10,
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
}

let bridge: RealSqlite;
let db: ReturnType<typeof getDb>;

beforeAll(() => {
  bridge = new RealSqlite('outbox');
  mockOpenImpl = () => bridge;
  setActiveDataOwner(GUEST_DATA_OWNER);
  db = getDb();
});
afterAll(() => {
  db.close();
  bridge.dispose();
});
beforeEach(() => {
  bridge.executeSync('DELETE FROM outbox');
  bridge.executeSync('DELETE FROM sync_receipt');
});

async function queueShots(count: number, random: () => number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const analysis = analysisFixture(random, i);
    ids.push(analysis.id);
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
      [
        GUEST_DATA_OWNER,
        JSON.stringify({ ...analysis, analysisPermitId: uuidFrom(random) }),
      ],
    );
  }
  return ids;
}

function attemptsHistogram(): Record<string, number> {
  const rows = bridge.executeSync(
    `SELECT attempts, count(*) AS n FROM outbox GROUP BY attempts ORDER BY attempts`,
  ).rows;
  return Object.fromEntries(
    rows.map(r => [String(r['attempts']), Number(r['n'])]),
  );
}

function outboxStatusRows() {
  return bridge
    .executeSync(`SELECT kind, attempts, last_error FROM outbox`)
    .rows.map(r => ({
      kind: String(r['kind']),
      attempts: Number(r['attempts']),
      lastError: (r['last_error'] as string | null) ?? null,
    }));
}

const neverTransport: Pick<SyncTransport, 'createSession' | 'finalizeSession'> =
  {
    async createSession() {
      throw new Error('not expected');
    },
    async finalizeSession() {
      throw new Error('not expected');
    },
  };

describe('S1 — whole-batch ApiError(413 payload.too_large) on 50 valid rows', () => {
  test('eight drains exhaust every one of the 50 rows; drain 9 no longer sees them', async () => {
    const random = mulberry32(SEED);
    const ids = await queueShots(50, random);
    let calls = 0;
    let lastBatchSize = 0;
    const transport: SyncTransport = {
      ...neverTransport,
      async syncShots(shots) {
        calls += 1;
        lastBatchSize = shots.length;
        throw new ApiError(
          413,
          'payload.too_large',
          'Request body exceeds 5000000 bytes.',
        );
      },
    };

    const perDrain: Array<{
      drain: number;
      result: Awaited<ReturnType<typeof drainOutbox>>;
      batchSize: number;
      attempts: Record<string, number>;
    }> = [];
    for (let drain = 1; drain <= OUTBOX_MAX_ATTEMPTS + 1; drain += 1) {
      const result = await drainOutbox(db, transport);
      perDrain.push({
        drain,
        result,
        batchSize: lastBatchSize,
        attempts: attemptsHistogram(),
      });
      lastBatchSize = 0;
    }

    const statuses = await Promise.all(
      ids.map(id => getShotOutboxStatus(db, id)),
    );
    const queue = deriveUploadQueueStatus(outboxStatusRows());
    const artifact = writeAttackArtifact('s1-413-batch-exhaustion.json', {
      seed: SEED,
      syncShotsCalls: calls,
      perDrain,
      shotStatuses: statuses.map(s => s.state),
      sampleStatus: statuses[0],
      uploadQueueStatus: queue,
    });
    expect(attackArtifactExists(artifact)).toBe(true);

    // Each of the first 8 drains sends the full 50-row batch and burns one
    // attempt on EVERY row (no split, no per-row isolation).
    for (const d of perDrain.slice(0, OUTBOX_MAX_ATTEMPTS)) {
      expect(d.batchSize).toBe(50);
      expect(d.result).toEqual({ synced: 0, failed: 50, remaining: 50 });
      expect(d.attempts).toEqual({ [String(d.drain)]: 50 });
    }
    // Drain 9: the query excludes attempts >= 8, so nothing is even tried.
    expect(calls).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(perDrain[OUTBOX_MAX_ATTEMPTS]?.result).toEqual({
      synced: 0,
      failed: 0,
      remaining: 50,
    });
    // Reported exhausted everywhere the UI reads from.
    expect(statuses.every(s => s.state === 'exhausted')).toBe(true);
    // ApiError does not set `name`, so String(error) reads "Error: <message>"
    // — the status/code are NOT persisted, only the message.
    expect(statuses[0]).toEqual({
      state: 'exhausted',
      attempts: 8,
      lastError: 'Error: Request body exceeds 5000000 bytes.',
    });
    expect(queue).toEqual({
      state: 'needs_attention',
      pending: 0,
      exhausted: 50,
    });
  });

  test('interleaving: a row queued mid-outage keeps its own attempts and syncs after the heal; the 49 exhausted rows never do', async () => {
    const random = mulberry32(SEED + 1);
    await queueShots(49, random);
    let mode: 'fail' | 'accept' = 'fail';
    const transport: SyncTransport = {
      ...neverTransport,
      async syncShots(shots) {
        if (mode === 'fail') {
          throw new ApiError(413, 'payload.too_large', 'too large');
        }
        return {
          acceptedIds: (shots as Array<{ id: string }>).map(s => s.id),
          rejected: [],
        };
      },
    };
    for (let drain = 1; drain <= 4; drain += 1) {
      await drainOutbox(db, transport);
    }
    // A new rating lands mid-outage (the app calls triggerOutboxSync()).
    const [lateId] = await queueShots(1, random);
    for (let drain = 5; drain <= 8; drain += 1) {
      await drainOutbox(db, transport);
    }
    const late = await getShotOutboxStatus(db, lateId!);
    const beforeHeal = attemptsHistogram();
    // The network heals — only the late row is ever sent again.
    mode = 'accept';
    const healed = await drainOutbox(db, transport);
    writeAttackArtifact('s1b-interleaved-late-row.json', {
      seed: SEED + 1,
      attemptsBeforeHeal: beforeHeal,
      lateRowBeforeHeal: late,
      healedDrain: healed,
      attemptsAfterHeal: attemptsHistogram(),
    });
    // The late row got only 4 permanent failures and stays retryable...
    expect(beforeHeal).toEqual({ '4': 1, '8': 49 });
    expect(late).toMatchObject({ state: 'rejected', attempts: 4 });
    // ...and the 49 older rows (attempts=8) are invisible to the healed drain
    // even though the server would now accept them.
    expect(healed).toEqual({ synced: 1, failed: 0, remaining: 49 });
    expect(attemptsHistogram()).toEqual({ '8': 49 });
  });
});

describe('S2 — bearer inside a thrown Error → outbox.last_error', () => {
  test('recordRowFailure stores String(error) verbatim, including the bearer; getShotOutboxStatus hands it to the UI', async () => {
    const random = mulberry32(SEED + 2);
    const [id] = await queueShots(1, random);
    // Synthetic secret; the assertion redacts it in the artifact.
    const bearer = `attack-bearer-${uuidFrom(random)}`;
    const transport: SyncTransport = {
      ...neverTransport,
      async syncShots() {
        throw new Error(
          `Network request failed for POST /v1/shots:sync with Authorization: Bearer ${bearer}`,
        );
      },
    };
    const result = await drainOutbox(db, transport);
    const raw = bridge.executeSync(`SELECT attempts, last_error FROM outbox`)
      .rows[0];
    const status = await getShotOutboxStatus(db, id!);
    const leaked =
      typeof raw?.['last_error'] === 'string' &&
      raw['last_error'].includes(bearer);

    writeAttackArtifact('s2-bearer-in-last-error.json', {
      seed: SEED + 2,
      drainResult: result,
      attempts: raw?.['attempts'],
      lastErrorRedacted: String(raw?.['last_error']).replace(
        bearer,
        '<redacted-bearer>',
      ),
      bearerPersistedVerbatim: leaked,
      statusStateForResultScreen: status.state,
      statusLastErrorContainsBearer:
        status.state !== 'absent' && String(status.lastError).includes(bearer),
    });

    // ATTACK RESULT: the plain Error is transient (attempts stay 0) but its
    // full text — bearer included — is written to disk and surfaced to the
    // Result screen's "(last response: …)" copy via getShotOutboxStatus.
    expect(result).toEqual({ synced: 0, failed: 1, remaining: 1 });
    expect(raw?.['attempts']).toBe(0);
    expect(leaked).toBe(true);
    expect(raw?.['last_error']).toBe(
      `Error: Network request failed for POST /v1/shots:sync with Authorization: Bearer ${bearer}`,
    );
    expect(status).toMatchObject({ state: 'queued', attempts: 0 });
    expect(status.state !== 'absent' && status.lastError).toContain(bearer);
  });
});

describe('S8 (own) — captive-portal / gateway whole-request 4xx through the real transport', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test.each([
    [403, 'Forbidden'],
    [404, 'Not Found'],
    [451, 'Unavailable For Legal Reasons'],
  ])(
    'HTTP %i with an HTML body burns an attempt on every queued row',
    async (status, statusText) => {
      const random = mulberry32(SEED + status);
      await queueShots(5, random);
      const fetchMock = jest.fn(async () => {
        return {
          ok: false,
          status,
          statusText,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON at position 0');
          },
        } as unknown as Response;
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const transport = createTransport({
        baseUrl: 'https://captive.example',
        token: 'attack-token',
      });
      const result = await drainOutbox(db, transport);
      const rows = outboxStatusRows();
      writeAttackArtifact(`s8-captive-${status}.json`, {
        seed: SEED + status,
        result,
        rows,
        queue: deriveUploadQueueStatus(rows),
      });
      // ATTACK RESULT: a network-position response (not a contract verdict)
      // is treated as permanent — every row lost one of its 8 attempts.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ synced: 0, failed: 5, remaining: 5 });
      expect(rows.every(r => r.attempts === 1)).toBe(true);
      expect(rows[0]?.lastError).toBe(`Error: ${statusText}`);
    },
  );
});
