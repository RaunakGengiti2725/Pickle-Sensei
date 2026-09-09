/**
 * INT-sync-outbox-persistence adversary — corrupt persisted state.
 *
 * Corrupt rows must never become fabricated empty history, a fabricated
 * receipt, a silent delete, or a poisoned neighbour. They also must not be
 * reported as something they are not.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  type SyncTransport,
} from '../../src/data/sync';
import {
  getAnalysis,
  getShotOutboxStatus,
  listShots,
  retryShotSync,
} from '../../src/data/repository';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  createSqliteTestDb,
  closeSqliteTestDatabases,
} from '../../testSupport/sqlite';

const OWNER = '11111111-1111-4111-8111-111111111111';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session = {
  id: id(1),
  mode: 'practice_set',
  shotType: 'forehand_drive',
  focusCheckpoint: 'contact_position',
  startedAt: '2026-09-07T12:00:00.000Z',
};

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
    capturedAtIso: `2026-09-07T12:00:${String(n % 60).padStart(2, '0')}.000Z`,
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

function ids(shots: unknown[]): string[] {
  return shots.map(shot => {
    if (
      !shot ||
      typeof shot !== 'object' ||
      !('id' in shot) ||
      typeof shot.id !== 'string'
    )
      throw new Error('Production sync emitted an invalid shot identifier');
    return shot.id;
  });
}

function fixture() {
  const store = createSqliteTestDb();
  const push = (kind: string, payload: unknown, owner = OWNER) => {
    store.native
      .prepare('INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)')
      .run(owner, kind, JSON.stringify(payload));
  };
  const pushRaw = (kind: string, payload: string, owner = OWNER) => {
    store.native
      .prepare('INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)')
      .run(owner, kind, payload);
  };
  const rows = (owner = OWNER) =>
    store.native
      .prepare('SELECT * FROM outbox WHERE owner_key = ? ORDER BY id')
      .all(owner);
  const seedShot = (shot: ShotAnalysis, payload = JSON.stringify(shot)) => {
    store.native
      .prepare(
        `INSERT INTO local_shot
         (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        OWNER,
        shot.id,
        shot.sessionId,
        shot.shotType,
        shot.capturedAtIso,
        shot.overallScore,
        shot.analysisConfidence,
        shot.resultKind,
        shot.source,
        payload,
      );
  };
  const seedSession = () => {
    store.native
      .prepare(
        'INSERT INTO local_session (owner_key,id,mode,shot_type,focus_checkpoint,started_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        OWNER,
        session.id,
        session.mode,
        session.shotType,
        session.focusCheckpoint,
        session.startedAt,
      );
  };
  const transport: SyncTransport = {
    syncShots: jest.fn(async shots => ({
      acceptedIds: ids(shots),
      rejected: [],
    })),
    createSession: jest.fn(async () => {}),
    finalizeSession: jest.fn(async () => {}),
  };
  const sentBatches = () =>
    jest
      .mocked(transport.syncShots)
      .mock.calls.map(call => ids(call[0] as unknown[]));
  return {
    store,
    push,
    pushRaw,
    rows,
    seedShot,
    seedSession,
    transport,
    sentBatches,
  };
}

beforeEach(() => setActiveDataOwner(OWNER));
afterEach(() => {
  closeSqliteTestDatabases();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('ADV-8 corrupt neighbours in the same durable batch', () => {
  const corruptPayloads: Array<[string, string]> = [
    ['truncated JSON', '{"id":"' + id(500) + '","analysisPermitId":'],
    ['JSON array', JSON.stringify([analysis(501)])],
    ['JSON string literal', JSON.stringify('shot')],
    ['numeric id', JSON.stringify({ ...analysis(502), id: 502 })],
    [
      'permit missing',
      JSON.stringify({ ...analysis(503), analysisPermitId: undefined }),
    ],
    [
      'permit blank',
      JSON.stringify({ ...analysis(504), analysisPermitId: '   ' }),
    ],
    ['id too long', JSON.stringify({ ...analysis(505), id: 'x'.repeat(129) })],
    ['empty object', '{}'],
  ];

  it('never delete, never fabricate a receipt, and never delay the valid read next to them', async () => {
    const { store, pushRaw, push, rows, seedShot, transport, sentBatches } =
      fixture();
    for (const [, payload] of corruptPayloads) pushRaw('shot.sync', payload);
    push('shot.sync', analysis(100));
    seedShot(analysis(100));
    seedShot(analysis(503));
    const before = rows().length;
    for (let n = 0; n < OUTBOX_MAX_ATTEMPTS + 1; n++)
      await drainOutbox(store.db, transport);
    expect(sentBatches()).toEqual([[id(100)]]);
    expect(store.count('sync_receipt', OWNER)).toBe(1);
    expect(
      store.native
        .prepare('SELECT entity_id FROM sync_receipt WHERE owner_key = ?')
        .all(OWNER)
        .map(row => row.entity_id),
    ).toEqual([id(100)]);
    // Every corrupt row is still there, with its original bytes.
    expect(rows()).toHaveLength(before - 1);
    expect(rows().map(row => row.payload)).toEqual(
      corruptPayloads.map(([, payload]) => payload),
    );
    expect(rows().every(row => row.attempts === OUTBOX_MAX_ATTEMPTS)).toBe(
      true,
    );
    // History is not emptied by the corrupt queue rows.
    expect((await listShots(store.db)).map(row => row.id).sort()).toEqual(
      [id(100), id(503)].sort(),
    );
  });
});

describe('ADV-9 a saved read the CLIENT refuses to send (legacy row without a permit)', () => {
  it('is not attributed to a server refusal and keeps a repair path', async () => {
    const { store, pushRaw, rows, seedShot, transport } = fixture();
    seedShot(analysis(100));
    pushRaw(
      'shot.sync',
      JSON.stringify({ ...analysis(100), analysisPermitId: undefined }),
    );
    for (let n = 0; n < OUTBOX_MAX_ATTEMPTS + 1; n++)
      await drainOutbox(store.db, transport);
    // The server never saw this read.
    expect(transport.syncShots).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    const status = await getShotOutboxStatus(store.db, id(100));
    // A row that was never sent cannot be "refused by the server N times"
    // (ResultScreen copy for `exhausted`), and the user must keep a way to
    // retry saving it: retryShotSync only resets rows in a repair state.
    expect(status.state).not.toBe('exhausted');
    expect(rows()[0]?.repair_reason).not.toBeNull();
    expect(
      await retryShotSync(store.db, id(100), captureDataOwnerContext()),
    ).toBe(true);
  });
});

describe('ADV-10 corrupt parent session row in front of a valid child', () => {
  it('reconstructs the parent from the original owner and syncs the child without deleting the corrupt row', async () => {
    const { store, pushRaw, push, rows, seedSession, transport, sentBatches } =
      fixture();
    seedSession();
    pushRaw('session.create', '{"id":"' + session.id + '","startedAt":');
    push('shot.sync', analysis(100, session.id));
    transport.syncShots = jest
      .fn()
      .mockResolvedValueOnce({
        acceptedIds: [],
        rejected: [
          { id: id(100), code: 'shot.session_not_found', message: 'missing' },
        ],
      })
      .mockImplementation(async shots => ({
        acceptedIds: ids(shots as unknown[]),
        rejected: [],
      }));
    await drainOutbox(store.db, transport);
    expect(transport.createSession).not.toHaveBeenCalled();
    expect(rows().filter(row => row.kind === 'session.create')).toHaveLength(2);
    expect(rows().find(row => row.kind === 'shot.sync')?.attempts).toBe(0);
    await drainOutbox(store.db, transport);
    expect(transport.createSession).toHaveBeenCalledTimes(1);
    expect(transport.createSession).toHaveBeenCalledWith({
      id: session.id,
      startedAt: session.startedAt,
    });
    expect(sentBatches()).toEqual([[id(100)], [id(100)]]);
    expect(store.count('sync_receipt', OWNER)).toBe(1);
    // Only the corrupt parent remains; it was never deleted or rewritten.
    expect(rows().map(row => [row.kind, row.payload])).toEqual([
      ['session.create', '{"id":"' + session.id + '","startedAt":'],
    ]);
  });
});

describe('ADV-11 conflicting duplicate identities after an explicit retry', () => {
  it('are held again, never resolved by queue order, and never reach the server', async () => {
    const { store, push, rows, transport } = fixture();
    push('shot.sync', analysis(100));
    push('shot.sync', { ...analysis(100), overallScore: 3.1 });
    await drainOutbox(store.db, transport);
    expect(await getShotOutboxStatus(store.db, id(100))).toMatchObject({
      state: 'needs_repair',
    });
    expect(
      await retryShotSync(store.db, id(100), captureDataOwnerContext()),
    ).toBe(true);
    expect(rows().every(row => row.repair_reason === null)).toBe(true);
    await drainOutbox(store.db, transport);
    expect(transport.syncShots).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(2);
    expect(
      rows().every(row => row.repair_reason === 'shot.conflicting_saved_id'),
    ).toBe(true);
    expect(rows().every(row => row.attempts === 0)).toBe(true);
    expect(store.count('sync_receipt', OWNER)).toBe(0);
  });

  it('a corrupt twin of a valid saved row holds both instead of silently trusting the parseable one', async () => {
    const { store, push, pushRaw, rows, transport } = fixture();
    push('shot.sync', analysis(100));
    pushRaw(
      'shot.sync',
      JSON.stringify({ ...analysis(100), analysisPermitId: undefined }),
    );
    for (let n = 0; n < OUTBOX_MAX_ATTEMPTS + 1; n++)
      await drainOutbox(store.db, transport);
    expect(transport.syncShots).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(2);
    // The parseable twin is held; the corrupt twin is never sent or deleted.
    expect(rows().map(row => row.repair_reason)).toEqual([
      'shot.conflicting_saved_id',
      null,
    ]);
    expect(rows()[1]?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(store.count('sync_receipt', OWNER)).toBe(0);
    expect(await getShotOutboxStatus(store.db, id(100))).toMatchObject({
      state: 'exhausted',
    });
  });
});

describe('ADV-12 corrupt saved result payload', () => {
  it('stays listed in history and never reads back as a fabricated missing result', async () => {
    const { store, seedShot } = fixture();
    seedShot(analysis(100), '{"id":"' + id(100) + '","truncated');
    seedShot(analysis(101));
    expect((await listShots(store.db)).map(row => row.id).sort()).toEqual(
      [id(100), id(101)].sort(),
    );
    await expect(getAnalysis(store.db, id(100))).rejects.toThrow();
    expect(await getAnalysis(store.db, id(101))).toMatchObject({ id: id(101) });
  });
});
