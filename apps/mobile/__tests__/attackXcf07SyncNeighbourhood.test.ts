/**
 * ADVERSARIAL probes around the XCF-07 fix (4476417d) run against the REAL
 * sync.ts / repository.ts / practiceSet.ts over real SQLite (node:sqlite,
 * production schema). Each probe is a variant of the original repro —
 * ordering, concurrency, mid-flight detach, unicode payloads, the 8-attempt
 * and 50-row boundaries, a repaired session the server then rejects for good.
 *
 * Skipped (never passing) when node:sqlite is unavailable — run with
 * NODE_OPTIONS=--experimental-sqlite.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import { ApiError } from '../src/data/api';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  detachShotFromSession,
  finishSession,
  getShotOutboxStatus,
  saveAnalysis,
  saveSession,
} from '../src/data/repository';
import {
  drainOutbox,
  OUTBOX_DRAIN_WINDOW,
  OUTBOX_MAX_ATTEMPTS,
  type SyncTransport,
} from '../src/data/sync';
import {
  commitPracticeSetForAnalysis,
  PRACTICE_SET_COMMIT_ATTEMPTS,
  planPracticeSet,
} from '../src/analysis/practiceSet';
import { createSqliteDb, isSqliteAvailable } from '../harness/outbox/sqliteDb';
import type { HarnessDb } from '../harness/outbox/durableStore';

const owner = '33333333-3333-4333-8333-333333333333';
const sqliteIt = isSqliteAvailable() ? it : it.skip;

function analysis(id: string, sessionId: string | null): ShotAnalysis {
  return {
    id,
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-04T12:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1200, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.5,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '1.0.0',
      modelBundleVersion: 'attack-1',
      poseModelVersion: 'attack-pose-1',
      paddleModelVersion: 'attack-paddle-1',
      strokeDetectorVersion: 'attack-stroke-1',
      phaseModelVersion: 'attack-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  } as unknown as ShotAnalysis;
}

/** A faithful stand-in for the edge function's session/shot semantics. */
class FakeServer implements SyncTransport {
  sessions = new Set<string>();
  shots = new Map<string, number>();
  createdPayloads: Array<Record<string, unknown>> = [];
  requests = { sessions: 0, finalizes: 0, shotBatches: 0 };
  rejectCreate: ((session: Record<string, unknown>) => ApiError | null) | null =
    null;
  beforeShotResponse: (() => Promise<void>) | null = null;

  async createSession(session: unknown): Promise<void> {
    this.requests.sessions += 1;
    const body = session as Record<string, unknown>;
    const rejection = this.rejectCreate?.(body) ?? null;
    if (rejection) throw rejection;
    this.createdPayloads.push(body);
    this.sessions.add(String(body['id']));
  }
  async finalizeSession(id: string): Promise<void> {
    this.requests.finalizes += 1;
    if (!this.sessions.has(id)) {
      throw new ApiError(404, 'session.not_found', 'Session not found.');
    }
  }
  async syncShots(shots: unknown[]) {
    this.requests.shotBatches += 1;
    if (this.beforeShotResponse) await this.beforeShotResponse();
    const acceptedIds: string[] = [];
    const rejected: Array<{ id: string; code: string; message: string }> = [];
    for (const raw of shots) {
      const shot = raw as Record<string, unknown>;
      const id = String(shot['id']);
      const sessionId = shot['sessionId'];
      if (sessionId !== null && sessionId !== undefined) {
        if (!this.sessions.has(String(sessionId))) {
          rejected.push({
            id,
            code: 'shot.session_not_found',
            message: 'Session not found or not yours.',
          });
          continue;
        }
      }
      this.shots.set(id, (this.shots.get(id) ?? 0) + 1);
      acceptedIds.push(id);
    }
    return { acceptedIds, rejected };
  }
}

async function drainUntilEmpty(
  harness: HarnessDb,
  server: FakeServer,
  maxDrains: number,
): Promise<number> {
  for (let i = 1; i <= maxDrains; i++) {
    const result = await drainOutbox(harness.db, server);
    if (result.remaining === 0) return i;
  }
  return Number.POSITIVE_INFINITY;
}

let harness: HarnessDb;
let server: FakeServer;

beforeEach(() => {
  setActiveDataOwner(owner);
  harness = createSqliteDb();
  server = new FakeServer();
});

afterEach(() => {
  harness.close();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('ATTACK XCF-07 neighbourhood (real sync.ts over node:sqlite)', () => {
  sqliteIt(
    'A) drain racing the commit: a drain between saveAnalysis and commitPracticeSetForAnalysis converges once the set commits',
    async () => {
      const plan = await planPracticeSet(harness.db, {
        shotType: 'forehand_drive',
        nowIso: '2026-09-04T12:00:00.000Z',
        preferredSessionId: null,
      });
      if (!plan) throw new Error('plan expected');
      await saveAnalysis(
        harness.db,
        analysis('shot-a', plan.sessionId),
        'permit-a',
      );

      // The scheduled/foreground drain fires BEFORE the commit: no
      // session.create row and no local_session yet → candidate charges the
      // shot (baseline treated it as transient). Record it; it must not be
      // enough to strand the shot.
      const racing = await drainOutbox(harness.db, server);
      expect(racing).toEqual({ synced: 0, failed: 1, remaining: 1 });
      const afterRace = await getShotOutboxStatus(harness.db, 'shot-a');
      expect(afterRace).toMatchObject({ state: 'rejected', attempts: 1 });

      const outcome = await commitPracticeSetForAnalysis(
        harness.db,
        plan,
        'shot-a',
        '2026-09-04T12:00:01.000Z',
      );
      expect(outcome.kind).toBe('committed');
      expect(await drainUntilEmpty(harness, server, 3)).toBeLessThanOrEqual(2);
      expect(server.shots.get('shot-a')).toBe(1);
      expect(server.sessions.has(plan.sessionId)).toBe(true);
      expect(harness.snapshot().outbox).toHaveLength(0);
    },
  );

  sqliteIt(
    'B) two concurrent drains over an orphan shot with a local_session row repair once each, converge, and never duplicate the shot server-side',
    async () => {
      const sessionId = 'aaaaaaaa-0000-4000-8000-00000000000b';
      await saveSession(harness.db, {
        id: sessionId,
        mode: 'practice_set',
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: '2026-09-04T12:00:00.000Z',
      });
      // Emulate the rolled-back/lost session.create row (the XCF-07 orphan).
      await harness.db.execute(
        `DELETE FROM outbox WHERE kind = 'session.create'`,
      );
      await saveAnalysis(
        harness.db,
        analysis('shot-b1', sessionId),
        'permit-b1',
      );
      await saveAnalysis(
        harness.db,
        analysis('shot-b2', sessionId),
        'permit-b2',
      );

      const [first, second] = await Promise.all([
        drainOutbox(harness.db, server),
        drainOutbox(harness.db, server),
      ]);
      expect(first.synced + second.synced).toBe(0);
      const repairs = harness
        .snapshot()
        .outbox.filter(r => r.kind === 'session.create');
      // Both drains may repair (the candidate has no cross-drain guard) —
      // duplicates are tolerated because the server upsert is idempotent.
      // The repair pass charges each shot once per drain by design
      // (resolveSessionNotFound doc), so two drains may cost two attempts.
      expect(repairs.length).toBeGreaterThanOrEqual(1);
      expect(repairs.length).toBeLessThanOrEqual(2);
      for (const shotId of ['shot-b1', 'shot-b2']) {
        const status = await getShotOutboxStatus(harness.db, shotId);
        expect(status.state).toBe('rejected');
        expect(
          status.state === 'rejected' && status.attempts,
        ).toBeLessThanOrEqual(2);
      }

      expect(await drainUntilEmpty(harness, server, 4)).toBeLessThanOrEqual(3);
      expect(server.shots.get('shot-b1')).toBe(1);
      expect(server.shots.get('shot-b2')).toBe(1);
      expect(harness.snapshot().outbox).toHaveLength(0);
    },
  );

  sqliteIt(
    'C) finalize queued ahead of the repair: server drops a finalized-locally session; the finalize row is charged but the shot converges',
    async () => {
      const sessionId = 'aaaaaaaa-0000-4000-8000-00000000000c';
      await saveSession(harness.db, {
        id: sessionId,
        mode: 'practice_set',
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: '2026-09-04T12:00:00.000Z',
      });
      expect(await drainUntilEmpty(harness, server, 1)).toBe(1);
      await finishSession(harness.db, sessionId, { shots: 1 });
      server.sessions.clear(); // stale/expired session on the server
      await saveAnalysis(harness.db, analysis('shot-c', sessionId), 'permit-c');

      const drains = await drainUntilEmpty(
        harness,
        server,
        OUTBOX_MAX_ATTEMPTS,
      );
      expect(drains).toBeLessThan(OUTBOX_MAX_ATTEMPTS);
      expect(server.shots.get('shot-c')).toBe(1);
      expect(server.sessions.has(sessionId)).toBe(true);
      expect(harness.snapshot().outbox).toHaveLength(0);
    },
  );

  sqliteIt(
    'D) detachShotFromSession while the shot batch is in flight: the stale in-flight payload is rejected once, the detached row is accepted next',
    async () => {
      const sessionId = 'aaaaaaaa-0000-4000-8000-00000000000d';
      await saveAnalysis(harness.db, analysis('shot-d', sessionId), 'permit-d');
      server.beforeShotResponse = async () => {
        server.beforeShotResponse = null;
        await detachShotFromSession(harness.db, 'shot-d');
      };
      const inFlight = await drainOutbox(harness.db, server);
      expect(inFlight).toEqual({ synced: 0, failed: 1, remaining: 1 });
      const row = harness.snapshot().outbox[0];
      expect(row?.payload).toContain('"sessionId":null');
      const status = await getShotOutboxStatus(harness.db, 'shot-d');
      expect(status).toMatchObject({ state: 'rejected', attempts: 1 });

      expect(await drainUntilEmpty(harness, server, 1)).toBe(1);
      expect(server.shots.get('shot-d')).toBe(1);
      expect(harness.snapshot().shots[0]?.session_id).toBeNull();
    },
  );

  sqliteIt(
    'E) repaired session.create carries the exact unicode payload saveSession would have enqueued',
    async () => {
      const sessionId = 'aaaaaaaa-0000-4000-8000-00000000000e';
      const session = {
        id: sessionId,
        mode: 'practice_set',
        shotType: 'ドライブ🏓 \u202Ereverse "quoted" \\ back',
        focusCheckpoint: 'contact_point — ‘smart’ quotes ✓',
        startedAt: '2026-09-04T12:00:00.000Z',
      };
      await saveSession(harness.db, session);
      const [original] = harness
        .snapshot()
        .outbox.filter(r => r.kind === 'session.create');
      if (!original) throw new Error('session.create expected');
      await harness.db.execute(`DELETE FROM outbox WHERE id = ?`, [
        original.id,
      ]);
      await saveAnalysis(harness.db, analysis('shot-e', sessionId), 'permit-e');

      await drainOutbox(harness.db, server);
      const [repaired] = harness
        .snapshot()
        .outbox.filter(r => r.kind === 'session.create');
      if (!repaired) throw new Error('repair expected');
      expect(JSON.parse(repaired.payload)).toEqual(
        JSON.parse(original.payload),
      );

      expect(await drainUntilEmpty(harness, server, 2)).toBeLessThanOrEqual(2);
      expect(server.createdPayloads[0]).toEqual(JSON.parse(original.payload));
      expect(server.shots.get('shot-e')).toBe(1);
    },
  );

  sqliteIt(
    'F) 8-attempt boundary: a shot whose session exists nowhere is exhausted after exactly OUTBOX_MAX_ATTEMPTS drains, stops being sent, and is reported exhausted',
    async () => {
      await saveAnalysis(
        harness.db,
        analysis('shot-f', 'aaaaaaaa-0000-4000-8000-00000000000f'),
        'permit-f',
      );
      for (let i = 1; i <= OUTBOX_MAX_ATTEMPTS; i++) {
        const result = await drainOutbox(harness.db, server);
        expect(result.failed).toBe(1);
        expect(await getShotOutboxStatus(harness.db, 'shot-f')).toMatchObject({
          state: i < OUTBOX_MAX_ATTEMPTS ? 'rejected' : 'exhausted',
          attempts: i,
          lastError: 'shot.session_not_found: Session not found or not yours.',
        });
      }
      const batchesBefore = server.requests.shotBatches;
      const idle = await drainOutbox(harness.db, server);
      // the exhausted row stays as durable evidence (remaining counts it, as
      // on 4d812e1a) but is never sent again
      expect(idle).toEqual({ synced: 0, failed: 0, remaining: 1 });
      expect(server.requests.shotBatches).toBe(batchesBefore);
      expect(
        harness.snapshot().outbox.filter(r => r.kind === 'session.create'),
      ).toHaveLength(0);
    },
  );

  sqliteIt(
    'G) repaired session the server rejects permanently: the repair row is exhausted, then the shots are exhausted; requests stay bounded',
    async () => {
      const sessionId = 'aaaaaaaa-0000-4000-8000-000000000010';
      await saveSession(harness.db, {
        id: sessionId,
        mode: 'practice_set',
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: '2026-09-04T12:00:00.000Z',
      });
      await harness.db.execute(
        `DELETE FROM outbox WHERE kind = 'session.create'`,
      );
      await saveAnalysis(harness.db, analysis('shot-g', sessionId), 'permit-g');
      server.rejectCreate = () =>
        new ApiError(
          409,
          'session.id_conflict',
          'Session id belongs to another user.',
        );

      let drains = 0;
      for (; drains < 40; drains++) {
        const result = await drainOutbox(harness.db, server);
        if (result.failed === 0) break;
      }
      // 1 repair pass + 8 create attempts (shots charged alongside) + idle
      expect(drains).toBeLessThanOrEqual(2 * OUTBOX_MAX_ATTEMPTS + 2);
      const rows = harness.snapshot().outbox;
      expect(rows.filter(r => r.kind === 'session.create').length).toBe(1);
      expect(rows.every(r => r.attempts === OUTBOX_MAX_ATTEMPTS)).toBe(true);
      expect(await getShotOutboxStatus(harness.db, 'shot-g')).toMatchObject({
        state: 'exhausted',
        attempts: OUTBOX_MAX_ATTEMPTS,
      });
      // exactly one repair; no second repair after the first is exhausted
      expect(server.requests.sessions).toBe(OUTBOX_MAX_ATTEMPTS);
    },
  );

  sqliteIt(
    'H) 50-row boundary: 51 orphan shots of one repaired session all land within a handful of drains',
    async () => {
      const sessionId = 'aaaaaaaa-0000-4000-8000-000000000011';
      await saveSession(harness.db, {
        id: sessionId,
        mode: 'practice_set',
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: '2026-09-04T12:00:00.000Z',
      });
      await harness.db.execute(
        `DELETE FROM outbox WHERE kind = 'session.create'`,
      );
      const count = OUTBOX_DRAIN_WINDOW + 1;
      for (let i = 0; i < count; i++) {
        await saveAnalysis(
          harness.db,
          analysis(`shot-h-${i}`, sessionId),
          `permit-h-${i}`,
        );
      }
      const drains = await drainUntilEmpty(harness, server, 5);
      expect(drains).toBeLessThanOrEqual(4);
      expect(server.shots.size).toBe(count);
      expect([...server.shots.values()].every(n => n === 1)).toBe(true);
    },
  );

  sqliteIt(
    'I) commitPracticeSetForAnalysis retry budget is exactly PRACTICE_SET_COMMIT_ATTEMPTS per write and the detached shot still syncs',
    async () => {
      let sessionInserts = 0;
      const flaky = {
        execute: async (sql: string, params?: unknown[]) => {
          if (/INSERT OR REPLACE INTO local_session/i.test(sql)) {
            sessionInserts += 1;
            throw new Error('disk I/O error');
          }
          return harness.db.execute(sql, params);
        },
        close: () => harness.db.close(),
      };
      const plan = await planPracticeSet(flaky, {
        shotType: 'forehand_drive',
        nowIso: '2026-09-04T12:00:00.000Z',
        preferredSessionId: null,
      });
      if (!plan) throw new Error('plan expected');
      await saveAnalysis(
        harness.db,
        analysis('shot-i', plan.sessionId),
        'permit-i',
      );
      const outcome = await commitPracticeSetForAnalysis(flaky, plan, 'shot-i');
      expect(outcome.kind).toBe('detached');
      expect(sessionInserts).toBe(PRACTICE_SET_COMMIT_ATTEMPTS);
      expect(
        harness.snapshot().outbox.some(r => r.kind === 'session.create'),
      ).toBe(false);
      expect(await drainUntilEmpty(harness, server, 1)).toBe(1);
      expect(server.shots.get('shot-i')).toBe(1);
      expect(harness.snapshot().shots[0]?.session_id).toBeNull();
    },
  );
});
