/**
 * Fix round 9 — reviewer follow-ups on round-8 candidate A, pinned:
 *
 *  F1  `setKv` and `enqueueEvaluationTrial` (trialCapture) take the
 *      connection lease: issued while another caller holds it, their write
 *      lands only after the holder's last statement, and `leaseWaiters()`
 *      sees them wait (pending 1, peak 1) — bounded to 1 s.
 *  F2  The paused-shot copy is ONE composed sentence sequence: the server's
 *      last response, a single space, the explanation — no missing
 *      separator, no doubled punctuation.
 *  F3  The true constants, stated and measured: per read of a set the
 *      accept + `shot.session_not_found` pathology costs at most
 *      1 + SESSION_CREATE_REARM_BOUND creates and 1 + SESSION_CREATE_REARM_BOUND
 *      syncs; over its LIFETIME a shot is offered at most
 *      SHOT_LIFETIME_REFUSAL_BOUND = OUTBOX_MAX_ATTEMPTS + SESSION_CREATE_REARM_BOUND
 *      times, however many later reads (20 here) join its set.
 *  F4  `leaseWaiters()` instrumentation: `pending` is the live queue length,
 *      `peak` the most callers that ever waited at once; with N concurrent
 *      callers the peak is at most N - 1 and `resetConnectionWaiterPeak`
 *      starts it over.
 *
 * Real `node:sqlite`, real modules.
 */
import type { EvaluationTrialRecord } from '@pickle/shared-types';
import type { LocalDb } from '../../../src/data/db';
import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { getDb } from '../../../src/data/db';
import {
  getKv,
  getShotOutboxStatus,
  saveAnalysis,
  setKv,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_CREATE_REARM_BOUND,
  SESSION_NOT_FOUND_REJECTION,
  SESSION_PAUSED_EXPLANATION,
  SESSION_PAUSED_VERDICT,
  SHOT_LIFETIME_REFUSAL_BOUND,
  drainOutbox,
  type SyncTransport,
} from '../../../src/data/sync';
import {
  connectionLease,
  connectionWaiters,
  leaseWaiters,
  resetConnectionWaiterPeak,
} from '../../../src/data/transaction';
import { enqueueEvaluationTrial } from '../../../src/evaluation/trialCapture';
import {
  CANONICAL_USER,
  PERMIT_ID,
  acceptAllTransport,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const SET_A = 'f9f9f9f9-0000-4000-8000-000000000001';
const LATER_READS = 20;

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

function trialRecord(trialId: string): EvaluationTrialRecord {
  return {
    schemaVersion: 'evaluation-trial-v1',
    trialId,
    captureId: 'capture-f9',
    analysisId: null,
    capturedAtIso: '2026-08-26T18:00:00.000Z',
    recordedAtIso: '2026-08-26T18:00:01.000Z',
    outcomeKind: 'unavailable',
    outcomeReason: 'engine_unavailable',
    envelopeOverall: null,
    latencyMs: null,
    appVersion: '0.1.0',
    engineVersion: null,
    modelBundleVersion: null,
    declaredStroke: null,
    claims: {
      targetLock: { status: 'not_measured' },
      eventSelection: { status: 'not_measured', startMs: null, endMs: null },
      strokeLabel: { status: 'not_measured', label: null, confidence: null },
      contactMarker: {
        status: 'not_measured',
        estimatedContactMs: null,
        ballConfirmed: false,
        paddleConfirmed: false,
      },
      phaseRender: {
        status: 'not_measured',
        contactMs: null,
        followThroughEndMs: null,
      },
      resultScore: {
        status: 'abstained',
        overallScore: null,
        analysisConfidence: null,
        presentation: 'abstain',
      },
    },
    limitingFactors: [],
    userFlags: [],
    dims: {
      userPseudonym: null,
      sessionId: null,
      courtId: null,
      deviceModel: null,
      devicePlatform: 'ios',
      osVersion: null,
    },
    consent: {
      scope: 'evaluation_telemetry',
      consentVersion: 'v1',
    },
  };
}

interface Counting extends SyncTransport {
  creates: string[];
  offers: string[][];
}

/** Every session.create accepted, every shot answered `shot.session_not_found`. */
function acceptSetDisownShots(): Counting {
  const creates: string[] = [];
  const offers: string[][] = [];
  return {
    creates,
    offers,
    async createSession(session) {
      creates.push(String((session as { id: unknown }).id));
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const ids = shots.map(s => String((s as { id: unknown }).id));
      offers.push(ids);
      return {
        acceptedIds: [],
        rejected: ids.map(id => ({
          id,
          code: SESSION_NOT_FOUND_REJECTION,
          message: 'Session not found for this shot.',
        })),
      };
    },
  };
}

const offersTo = (t: Counting, id: string) =>
  t.offers.filter(page => page.includes(id)).length;

async function bounded<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ kind: 'done'; value: T } | { kind: 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    work.then(value => ({ kind: 'done' as const, value })),
    new Promise<{ kind: 'timeout' }>(resolve => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
    }),
  ]);
  clearTimeout(timer);
  return result;
}

/** A LocalDb view that records every statement in issue order. */
function logging(db: LocalDb, log: string[]): LocalDb {
  return {
    execute(sql, params) {
      log.push(sql);
      return db.execute(sql, params);
    },
    close() {
      db.close();
    },
  };
}

describe('fix round 9 — reviewer follow-ups (real SQLite)', () => {
  let db: LocalDb;
  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await db.execute(`DELETE FROM outbox`);
    await db.execute(`DELETE FROM local_shot`);
    await db.execute(`DELETE FROM local_session`);
    await db.execute(`DELETE FROM sync_receipt`);
    await db.execute(`DELETE FROM kv`);
    resetConnectionWaiterPeak();
  });
  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('F1 — setKv and enqueueEvaluationTrial wait for the lease holder: their writes land after the holder’s last statement, leaseWaiters() sees them, and nothing hangs (1 s bound)', async () => {
    const log: string[] = [];
    const seen = logging(db, log);
    const lease = connectionLease(seen);
    const waitersWhileHeld: Array<{ pending: number; peak: number }> = [];
    let issued: Promise<void> | null = null;
    const holder = lease.hold(async () => {
      for (let i = 0; i < 6; i += 1) {
        await seen.execute(`SELECT ${i} AS holder_step`);
        if (i === 1) {
          // Two standalone writers arrive while the holder is mid-group.
          issued = Promise.all([
            setKv(seen, 'f9.kv', 'written'),
            enqueueEvaluationTrial(seen, trialRecord('f9-trial')),
          ]).then(() => undefined);
        }
        waitersWhileHeld.push(leaseWaiters());
      }
    });
    const outcome = await bounded(
      holder.then(() => issued ?? Promise.resolve()),
      1_000,
    );
    expect(outcome).toEqual({ kind: 'done', value: undefined });
    expect(leaseWaiters()).toEqual({ pending: 0, peak: 2 });
    expect(connectionWaiters()).toBe(0);
    // While the holder still had statements to issue, both writers waited.
    expect(waitersWhileHeld.slice(2, 6)).toEqual(
      Array.from({ length: 4 }, () => ({ pending: 2, peak: 2 })),
    );
    // Ordering: every holder statement precedes both writes.
    const lastHolderStep = log.lastIndexOf('SELECT 5 AS holder_step');
    const kvWrite = log.findIndex(sql =>
      sql.startsWith('INSERT OR REPLACE INTO kv'),
    );
    const trialWrite = log.findIndex(
      sql =>
        sql.startsWith('INSERT INTO outbox') &&
        sql.includes(`'evaluation.trial'`),
    );
    expect(kvWrite).toBeGreaterThan(lastHolderStep);
    expect(trialWrite).toBeGreaterThan(lastHolderStep);
    expect(await getKv(db, 'f9.kv')).toBe('written');
    const { rows } = await db.execute(
      `SELECT kind, json_extract(payload, '$.trialId') AS trial FROM outbox WHERE owner_key = ?`,
      [OWNER],
    );
    expect(rows).toEqual([{ kind: 'evaluation.trial', trial: 'f9-trial' }]);
  });

  it('F2 — the paused-shot verdict is a composed sentence: marker, the server’s last response, one space, the explanation; no doubled spaces or punctuation', async () => {
    const t = acceptSetDisownShots();
    const id = shotId(0xf200);
    await saveAnalysis(db, realAnalysis({ id, sessionId: SET_A }), PERMIT_ID, {
      session: setInput(SET_A),
    });
    for (let d = 0; d < 10; d += 1) await drainOutbox(db, t);
    const status = await getShotOutboxStatus(db, id);
    expect(status.state).toBe('paused');
    if (status.state !== 'paused') return;
    expect(status.lastError).toBe(
      `${SESSION_PAUSED_VERDICT}: ${SESSION_NOT_FOUND_REJECTION}: Session not found for this shot. ${SESSION_PAUSED_EXPLANATION}`,
    );
    expect(status.lastError).not.toMatch(/ {2}|\.\.|\.;|;\./);
    expect(SESSION_PAUSED_EXPLANATION).toMatch(/^[A-Z].*\.$/);
    expect(SESSION_PAUSED_EXPLANATION).toContain(
      `${SESSION_CREATE_REARM_BOUND} times`,
    );
  });

  it('F3 — stated constants hold under measurement: ≤ 1 + SESSION_CREATE_REARM_BOUND creates and syncs per read; the first shot’s lifetime offers stop at SHOT_LIFETIME_REFUSAL_BOUND across 20 later reads', async () => {
    expect({
      OUTBOX_MAX_ATTEMPTS,
      SESSION_CREATE_REARM_BOUND,
      SHOT_LIFETIME_REFUSAL_BOUND,
    }).toEqual({
      OUTBOX_MAX_ATTEMPTS: 8,
      SESSION_CREATE_REARM_BOUND: 2,
      SHOT_LIFETIME_REFUSAL_BOUND: 10,
    });
    const t = acceptSetDisownShots();
    const first = shotId(0xf300);
    await saveAnalysis(
      db,
      realAnalysis({ id: first, sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    const perRead: Array<{ creates: number; syncs: number }> = [];
    const firstOffersAfterRead: number[] = [];
    for (let read = 0; read <= LATER_READS; read += 1) {
      if (read > 0) {
        await saveAnalysis(
          db,
          realAnalysis({ id: shotId(0xf300 + read), sessionId: SET_A }),
          PERMIT_ID,
          { session: setInput(SET_A) },
        );
      }
      const c = t.creates.length;
      const s = t.offers.length;
      for (let d = 0; d < 8; d += 1) await drainOutbox(db, t);
      perRead.push({
        creates: t.creates.length - c,
        syncs: t.offers.length - s,
      });
      firstOffersAfterRead.push(offersTo(t, first));
    }
    const perReadBound = 1 + SESSION_CREATE_REARM_BOUND;
    expect(
      perRead.every(r => r.creates <= perReadBound && r.syncs <= perReadBound),
    ).toBe(true);
    expect(perRead[0]).toEqual({ creates: perReadBound, syncs: perReadBound });
    // The first shot's lifetime: offered up to the bound, then never again —
    // the trace is monotone and flat from the read that reached the cap on.
    const lifetime = firstOffersAfterRead[LATER_READS]!;
    expect(lifetime).toBe(SHOT_LIFETIME_REFUSAL_BOUND);
    const capIndex = firstOffersAfterRead.indexOf(SHOT_LIFETIME_REFUSAL_BOUND);
    expect(capIndex).toBeGreaterThan(0);
    expect(new Set(firstOffersAfterRead.slice(capIndex)).size).toBe(1);
    // Every shot of the set is within its own lifetime bound, and every
    // offer of the first shot is a counted refusal.
    const { rows } = await db.execute(
      `SELECT json_extract(payload, '$.id') AS id, refusals, attempts FROM outbox
       WHERE owner_key = ? AND kind = 'shot.sync' ORDER BY id`,
      [OWNER],
    );
    expect(rows).toHaveLength(LATER_READS + 1);
    for (const row of rows) {
      const offers = offersTo(t, String(row['id']));
      expect(offers).toBeLessThanOrEqual(SHOT_LIFETIME_REFUSAL_BOUND);
      expect(Number(row['refusals'])).toBe(offers);
    }
    expect(await getShotOutboxStatus(db, first)).toMatchObject({
      state: 'exhausted',
      attempts: SHOT_LIFETIME_REFUSAL_BOUND,
    });
    // Lifetime creates for the set: the first read's full budget plus at
    // most SESSION_CREATE_REARM_BOUND per later read.
    expect(t.creates.length).toBeLessThanOrEqual(
      perReadBound + LATER_READS * SESSION_CREATE_REARM_BOUND,
    );
  }, 60_000);

  it('F4 — leaseWaiters(): pending is the live queue, peak the most that ever waited (≤ concurrent callers − 1), reset starts the peak over; concurrent saves and drains all complete', async () => {
    expect(leaseWaiters()).toEqual({ pending: 0, peak: 0 });
    const t = acceptAllTransport();
    const callers = 10;
    const work = Array.from({ length: callers }, (_, i) =>
      i % 3 === 2
        ? drainOutbox(db, t).then(() => undefined)
        : saveAnalysis(db, realAnalysis({ id: shotId(0xf400 + i) }), PERMIT_ID),
    );
    const during = leaseWaiters();
    expect(during.pending).toBeGreaterThan(0);
    expect(during.pending).toBeLessThanOrEqual(callers - 1);
    const outcome = await bounded(Promise.all(work), 5_000);
    expect(outcome.kind).toBe('done');
    const after = leaseWaiters();
    expect(after.pending).toBe(0);
    expect(after.peak).toBeGreaterThanOrEqual(during.pending);
    expect(after.peak).toBeLessThanOrEqual(callers - 1);
    resetConnectionWaiterPeak();
    expect(leaseWaiters()).toEqual({ pending: 0, peak: 0 });
    // Every save is durable and a final drain delivers what the concurrent
    // drains did not.
    await drainOutbox(db, t);
    const { rows } = await db.execute(
      `SELECT count(*) AS n FROM sync_receipt WHERE owner_key = ? AND kind = 'shot.sync'`,
      [OWNER],
    );
    expect(rows).toEqual([{ n: 7 }]);
  });
});
