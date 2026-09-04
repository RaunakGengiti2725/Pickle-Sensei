/**
 * ATTACK S2 — 50 `evaluation.trial` rows ahead of one `shot.sync` row with a
 * transport that has no `uploadEvaluationTrials`.
 *
 * sync.ts:19-27 promises such a transport "leaves 'evaluation.trial' rows
 * queued (no attempts burned) rather than dropping evidence". Because the
 * window is `LIMIT 50` by id BEFORE kinds are separated (sync.ts:139-143),
 * 50 untouched trial rows fill the window on every drain and the shot at
 * position 51 is never selected. Worse, the drain reports failed = 0, so the
 * runtime believes it is healthy while a scored rating never syncs.
 *
 * Real production schema on node:sqlite; trial rows are written through the
 * real enqueueEvaluationTrial, the shot through saveAnalysis.
 */
import type { LocalDb } from '../../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import {
  getShotOutboxStatus,
  saveAnalysis,
} from '../../../src/data/repository';
import { drainOutbox, type SyncTransport } from '../../../src/data/sync';
import { enqueueEvaluationTrial } from '../../../src/evaluation/trialCapture';
import type { EvaluationTrialRecord } from '@pickle/shared-types';
import {
  OWNER_A,
  PERMIT_ID,
  SHOT_ID,
  realAnalysis,
} from '../../../testing/attack/mobileDataSyncFixtures';
import {
  loadRealGetDb,
  outboxRows,
  uuidAt,
} from '../../../testing/attack/mobileDataSync4Harness';
import { createOpSqliteModuleMock } from '../../../testing/attack/nodeSqliteOpAdapter';

const mockOpSqlite = createOpSqliteModuleMock();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockOpSqlite.open(options),
}));

const DRAINS = 10;

function trialAt(n: number): EvaluationTrialRecord {
  return {
    trialId: uuidAt(0x7a1, n),
    analysisId: uuidAt(0x7a2, n),
    captureId: uuidAt(0x7a3, n),
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    recordedAtIso: '2026-08-27T18:00:01.000Z',
    outcomeKind: 'recorded',
    outcomeReason: null,
    envelopeOverall: null,
    latencyMs: 1200,
    appVersion: '0.1.0',
    engineVersion: 'engine-1',
    modelBundleVersion: 'on-device-fusion-1',
    declaredStroke: null,
    claims: [],
    limitingFactors: [],
    userFlags: [],
    dims: { width: 720, height: 1280 },
    consent: { scope: 'evaluation_telemetry', consentVersion: 1 },
  } as unknown as EvaluationTrialRecord;
}

describe('ATTACK S2 — evaluation.trial rows starve a later shot.sync [real sqlite]', () => {
  let db: LocalDb;

  beforeEach(() => {
    db = loadRealGetDb()();
    setActiveDataOwner(OWNER_A);
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    db.close();
  });

  it('with no uploadEvaluationTrials the shot at position 51 is never sent, yet every drain reports failed = 0', async () => {
    for (let n = 0; n < 50; n++) await enqueueEvaluationTrial(db, trialAt(n));
    await saveAnalysis(db, realAnalysis, PERMIT_ID);

    const rows = await outboxRows(db);
    expect(rows).toHaveLength(51);
    expect(rows.slice(0, 50).every(r => r.kind === 'evaluation.trial')).toBe(
      true,
    );
    expect(rows[50]).toMatchObject({ kind: 'shot.sync', entity: SHOT_ID });

    const syncShots = jest.fn(async (shots: unknown[]) => ({
      acceptedIds: (shots as Array<{ id: string }>).map(s => s.id),
      rejected: [] as Array<{ id: string; code: string; message: string }>,
    }));
    const transport: SyncTransport = {
      syncShots,
      createSession: async () => {},
      finalizeSession: async () => {},
      // deliberately no uploadEvaluationTrials
    };

    const results: Array<{
      synced: number;
      failed: number;
      remaining: number;
    }> = [];
    for (let i = 0; i < DRAINS; i++)
      results.push(await drainOutbox(db, transport));

    expect(syncShots).not.toHaveBeenCalled();
    expect(results).toEqual(
      Array(DRAINS).fill({ synced: 0, failed: 0, remaining: 51 }),
    );
    // No attempt, no error recorded anywhere: nothing signals the stall.
    const after = await outboxRows(db);
    expect(after.every(r => r.attempts === 0 && r.last_error === null)).toBe(
      true,
    );
    expect(await getShotOutboxStatus(db, SHOT_ID)).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
  });

  it('the same 50 trial rows do NOT block the shot once the transport can upload trials (control: window order is the only cause)', async () => {
    for (let n = 0; n < 50; n++) await enqueueEvaluationTrial(db, trialAt(n));
    await saveAnalysis(db, realAnalysis, PERMIT_ID);

    const syncShots = jest.fn(async (shots: unknown[]) => ({
      acceptedIds: (shots as Array<{ id: string }>).map(s => s.id),
      rejected: [] as Array<{ id: string; code: string; message: string }>,
    }));
    const transport: SyncTransport = {
      syncShots,
      createSession: async () => {},
      finalizeSession: async () => {},
      uploadEvaluationTrials: async trials => ({
        acceptedTrialIds: (trials as Array<{ trialId: string }>).map(
          t => t.trialId,
        ),
        rejected: [],
      }),
    };

    const first = await drainOutbox(db, transport);
    expect(first).toEqual({ synced: 50, failed: 0, remaining: 1 });
    expect(syncShots).not.toHaveBeenCalled();
    const second = await drainOutbox(db, transport);
    expect(second).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(syncShots).toHaveBeenCalledTimes(1);
  });

  it('50 trial rows the server keeps rejecting transiently (evaluation.trial_write_failed) starve the shot the same way with the production-shaped transport', async () => {
    for (let n = 0; n < 50; n++) await enqueueEvaluationTrial(db, trialAt(n));
    await saveAnalysis(db, realAnalysis, PERMIT_ID);

    const syncShots = jest.fn(async (shots: unknown[]) => ({
      acceptedIds: (shots as Array<{ id: string }>).map(s => s.id),
      rejected: [] as Array<{ id: string; code: string; message: string }>,
    }));
    const transport: SyncTransport = {
      syncShots,
      createSession: async () => {},
      finalizeSession: async () => {},
      uploadEvaluationTrials: async trials => ({
        acceptedTrialIds: [],
        rejected: (trials as Array<{ trialId: string }>).map(t => ({
          trialId: t.trialId,
          code: 'evaluation.trial_write_failed',
          message: 'retry later',
        })),
      }),
    };

    for (let i = 0; i < DRAINS; i++) {
      const result = await drainOutbox(db, transport);
      expect(result).toEqual({ synced: 0, failed: 50, remaining: 51 });
    }
    expect(syncShots).not.toHaveBeenCalled();
    const after = await outboxRows(db);
    expect(
      after
        .filter(r => r.kind === 'evaluation.trial')
        .every(r => r.attempts === 0),
    ).toBe(true);
  });
});
