import { open, type DB } from '@op-engineering/op-sqlite';
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  buildMotion3DAnalysis,
  type Motion3DAnalysis,
  type Motion3DAnalysisRecord,
} from '@pickle/analysis-pipeline';
import {
  MOTION_3D_MAX_JSON_BYTES,
  sha256Hex,
  type Motion3DArtifact,
} from '@pickle/swing-domain';
import {
  captureDataOwnerScope,
  GUEST_DATA_OWNER,
  isDataOwnerScopeCurrent,
  requireWritableDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
  subscribeDataOwnerChanges,
} from '../src/data/accountScope';
import { getDb, type LocalDb } from '../src/data/db';
import {
  getLatestMotion3DAnalysisId,
  listMotion3DHistory,
  loadMotion3DAnalysis,
  Motion3DRepositoryError,
  saveMotion3DAnalysis,
} from '../src/data/motion3dRepository';
import { purgeOwnerData, savePendingCapture } from '../src/data/repository';
import { drainOutbox, type SyncTransport } from '../src/data/sync';

jest.mock('@op-engineering/op-sqlite', () => ({ open: jest.fn() }));

const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const capturedAtIso = '2026-09-05T11:00:00.000Z';
const syncShotId = 'accepted-legacy-shot';
type QueryResult = { rows: Record<string, unknown>[] };
interface SqliteDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = jest.requireActual<{
  DatabaseSync: new (path: string) => SqliteDatabase;
}>('node:sqlite');
const mockExecute = jest.fn<Promise<QueryResult>, [string, unknown[]?]>();

function softwareArtifact(): Motion3DArtifact {
  return {
    schemaVersion: 1,
    format: 'pickle.motion-3d.v1',
    role: 'reconstructed_estimate',
    coordinateSystem: 'vision_root_relative',
    axes: 'right_handed_y_up',
    units: 'vision_estimated_meters',
    imageCoordinates: 'normalized_image_top_left',
    uncertainty: 'uncalibrated',
    temporalProcessing: 'none',
    source: {
      captureId: 'software-capture',
      videoSha256: 'a'.repeat(64),
      videoByteLength: 1234,
      width: 1080,
      height: 1920,
      durationMs: 1000,
      nominalFrameRate: 30,
      preferredTransform: [1, 0, 0, 1, 0, 0],
      orientationPolicy: 'preferred_track_transform_applied',
      mirroring: 'as_encoded',
    },
    estimator: {
      providerId: 'pose.apple-vision-3d',
      revision: 1,
      osVersion: 'software-test-only',
      modelAsset: 'os_managed',
      modelAssetSha256: null,
      configurationVersion: 'apple-vision-3d-raw-1',
      maxSampleRate: 30,
    },
    frames: [
      {
        frameIndex: 0,
        timestampMs: 0,
        ptsValue: 0,
        ptsTimescale: 30,
        segmentId: 0,
        status: 'estimated',
        observationConfidence: 1,
        height: { meters: 1.8, source: 'reference' },
        cameraOriginMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1],
        joints: [
          {
            name: 'root',
            x: 0,
            y: 0,
            z: 0,
            imageX: 0.5,
            imageY: 0.5,
            confidence: null,
            visibility2D: null,
          },
        ],
      },
    ],
  };
}

function softwareAnalysis(
  metadata: Partial<
    Pick<
      Motion3DAnalysisRecord,
      'id' | 'captureId' | 'createdAtIso' | 'capturedAtIso' | 'declaredStroke'
    >
  > = {},
): Motion3DAnalysis {
  const artifact = softwareArtifact();
  artifact.source.captureId = metadata.captureId ?? artifact.source.captureId;
  const artifactJson = `\n${JSON.stringify(artifact, null, 2)}\n`;
  const result = buildMotion3DAnalysis({
    id: 'software-analysis',
    captureId: artifact.source.captureId,
    createdAtIso: '2026-09-05T12:00:00.000Z',
    capturedAtIso,
    declaredStroke: null,
    handedness: 'left',
    ...metadata,
    artifactJson,
    artifactSha256: sha256Hex(artifactJson),
  });
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function switchAwayAndBack(): void {
  setActiveDataOwner(ownerB);
  setActiveDataOwner(ownerA);
}

describe('data owner generation snapshots', () => {
  beforeEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('keeps normalized same-owner assignments current without notifying again', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeDataOwnerChanges(listener);
    try {
      setActiveDataOwner(ownerA);
      const scope = captureDataOwnerScope();
      setActiveDataOwner(ownerA.toUpperCase());
      setActiveDataOwner(ownerA);
      expect(captureDataOwnerScope()).toEqual(scope);
      expect(isDataOwnerScopeCurrent(scope)).toBe(true);
      expect(Object.isFrozen(scope)).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('invalidates a real A-to-B-to-A transition and notifies each generation', () => {
    setActiveDataOwner(ownerA);
    const scope = captureDataOwnerScope();
    const observed: ReturnType<typeof captureDataOwnerScope>[] = [];
    const unsubscribe = subscribeDataOwnerChanges(() => {
      observed.push(captureDataOwnerScope());
    });
    try {
      switchAwayAndBack();
      expect(isDataOwnerScopeCurrent(scope)).toBe(false);
      expect(observed).toEqual([
        { owner: ownerB, generation: scope.generation + 1 },
        { owner: ownerA, generation: scope.generation + 2 },
      ]);
      unsubscribe();
      setActiveDataOwner(GUEST_DATA_OWNER);
      expect(observed).toHaveLength(2);
      expect(requireWritableDataOwner()).toBe(GUEST_DATA_OWNER);
    } finally {
      unsubscribe();
    }
  });

  it('does not change generation for invalid owners and rejects signed-out writes', () => {
    const scope = captureDataOwnerScope();
    expect(() => setActiveDataOwner('not-an-owner')).toThrow(
      'Invalid local data owner',
    );
    expect(captureDataOwnerScope()).toEqual(scope);
    expect(() => requireWritableDataOwner()).toThrow(
      'Sign in or continue locally',
    );
  });
});

describe('software-only Motion3D persistence in SQLite', () => {
  let sqlite: SqliteDatabase;
  let db: LocalDb;

  function query(sql: string, params: unknown[] = []): QueryResult {
    return { rows: sqlite.prepare(sql).all(...params) };
  }

  async function seedCapture(analysis = softwareAnalysis()): Promise<void> {
    const source = analysis.artifact.source;
    await savePendingCapture(
      db,
      analysis.record.captureId,
      'unrecognized',
      {
        uri: `file:///software-fixtures/${analysis.record.captureId}.mov`,
        durationMs: source.durationMs,
        fps: source.nominalFrameRate,
        width: source.width,
        height: source.height,
        capturedAtIso: analysis.record.capturedAtIso,
        captureMode: 'imported_video',
        recognition: {
          status: 'unknown',
          reason: 'validated_classifier_unavailable',
        },
        ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
      },
      analysis.record.declaredStroke,
    );
  }

  function storedRow(owner = ownerA, id = 'software-analysis') {
    return sqlite
      .prepare(
        'SELECT * FROM local_motion_analysis WHERE owner_key = ? AND id = ?',
      )
      .get(owner, id);
  }

  function status(owner = ownerA): unknown {
    return sqlite
      .prepare(
        'SELECT status FROM local_capture WHERE owner_key = ? AND id = ?',
      )
      .get(owner, 'software-capture')?.['status'];
  }

  function seedLegacy(owner = ownerA): void {
    sqlite
      .prepare(
        `INSERT INTO local_shot
      (owner_key, id, shot_type, captured_at, confidence, result_kind, source, payload)
      VALUES (?, 'software-analysis', 'forehand_drive', ?, 0.9, 'scored', 'real', ?)`,
      )
      .run(owner, capturedAtIso, '{"legacy":"rating must not change"}');
    sqlite
      .prepare(
        `INSERT INTO local_analysis_record
      (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
      VALUES (?, 'software-analysis', 'software-capture', ?, 'legacy', 'legacy', ?)`,
      )
      .run(owner, capturedAtIso, '{"legacy":"record must not change"}');
    sqlite
      .prepare(
        "INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)",
      )
      .run(owner, '{"legacy":"outbox must not change"}');
  }

  function seedSyncShot(owner = ownerA): SyncTransport {
    const shot: ShotAnalysis & { analysisPermitId: string } = {
      id: syncShotId,
      analysisPermitId: 'software-permit',
      sessionId: null,
      shotType: 'forehand_drive',
      cameraView: 'side',
      handedness: 'left',
      capturedAtIso,
      timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
      phases: [],
      measurements: [],
      checkpoints: [],
      overallScore: 7.8,
      analysisConfidence: 0.9,
      resultKind: 'scored',
      guidance: null,
      priorityFix: null,
      source: 'real',
      versionVector: {
        appVersion: 'software-test',
        modelBundleVersion: 'software-test',
        poseModelVersion: 'software-test',
        paddleModelVersion: 'software-test',
        strokeDetectorVersion: 'software-test',
        phaseModelVersion: 'software-test',
        scoringModelVersion: 'software-test',
        shotConfigVersion: 'software-test',
      },
    };
    sqlite
      .prepare(
        "INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)",
      )
      .run(owner, JSON.stringify(shot));
    return {
      syncShots: jest.fn(async () => ({
        acceptedIds: [syncShotId],
        rejected: [],
      })),
      createSession: jest.fn(async () => {}),
      finalizeSession: jest.fn(async () => {}),
    };
  }

  beforeEach(() => {
    setActiveDataOwner(ownerA);
    sqlite = new DatabaseSync(':memory:');
    mockExecute.mockReset();
    mockExecute.mockImplementation(async (sql, params) => query(sql, params));
    jest.mocked(open).mockReturnValue({
      executeSync: query,
      execute: mockExecute,
      close: () => sqlite.close(),
    } as unknown as DB);
    db = getDb();
  });

  afterEach(() => {
    db.close();
    jest.restoreAllMocks();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  it('migrates an owner-keyed table with byte bounds and history/capture indexes', () => {
    const columns = query('PRAGMA table_info(local_motion_analysis)').rows;
    expect(
      columns.filter(row => Number(row['pk']) > 0).map(row => row['name']),
    ).toEqual(['owner_key', 'id']);
    expect(
      query('PRAGMA index_list(local_motion_analysis)').rows.map(
        row => row['name'],
      ),
    ).toEqual(
      expect.arrayContaining([
        'idx_local_motion_analysis_capture',
        'idx_local_motion_analysis_history',
      ]),
    );
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO local_motion_analysis
      (owner_key, id, capture_id, created_at, captured_at, record_json, artifact_json)
      VALUES (?, 'too-large', 'software-capture', ?, ?, '{}', ?)`,
        )
        .run(
          ownerA,
          capturedAtIso,
          capturedAtIso,
          'a'.repeat(MOTION_3D_MAX_JSON_BYTES + 1),
        ),
    ).toThrow(/CHECK constraint/);
  });

  it('stores exact JSON bytes atomically and reloads without a development flag', async () => {
    const analysis = softwareAnalysis({ declaredStroke: 'forehand_drive' });
    await seedCapture(analysis);
    mockExecute.mockClear();
    await saveMotion3DAnalysis(db, analysis, captureDataOwnerScope());
    expect(storedRow()).toMatchObject({
      owner_key: ownerA,
      record_json: JSON.stringify(analysis.record),
      artifact_json: analysis.artifactJson,
    });
    expect(status()).toBe('analyzed');
    expect(
      mockExecute.mock.calls.map(([sql]) =>
        sql.trim().split(/\s+/).slice(0, 3).join(' '),
      ),
    ).toEqual([
      'BEGIN IMMEDIATE',
      'SELECT owner_key, id,',
      'INSERT INTO local_motion_analysis',
      'UPDATE local_capture SET',
      'COMMIT',
    ]);
    jest.replaceProperty(
      globalThis as typeof globalThis & { __DEV__: boolean },
      '__DEV__',
      false,
    );
    await expect(
      loadMotion3DAnalysis(getDb(), analysis.record.id),
    ).resolves.toEqual(analysis);
    await expect(
      getLatestMotion3DAnalysisId(db, analysis.record.captureId),
    ).resolves.toBe(analysis.record.id);
    await expect(listMotion3DHistory(db)).resolves.toEqual([
      {
        id: analysis.record.id,
        captureId: analysis.record.captureId,
        capturedAtIso,
        declaredStroke: 'forehand_drive',
      },
    ]);
  });

  it('supports a legacy LocalDb mock without withExclusive', async () => {
    const analysis = softwareAnalysis();
    await seedCapture(analysis);
    const oldFacade: LocalDb = { execute: db.execute, close() {} };
    await saveMotion3DAnalysis(oldFacade, analysis, captureDataOwnerScope());
    await expect(
      loadMotion3DAnalysis(oldFacade, analysis.record.id),
    ).resolves.toEqual(analysis);
  });

  it('rejects duplicate IDs without replacing bytes or changing capture status', async () => {
    const analysis = softwareAnalysis();
    await seedCapture(analysis);
    await saveMotion3DAnalysis(db, analysis, captureDataOwnerScope());
    const original = storedRow();
    sqlite.prepare("UPDATE local_capture SET status = 'awaiting_model'").run();
    await expect(
      saveMotion3DAnalysis(
        db,
        softwareAnalysis({
          createdAtIso: '2026-09-05T13:00:00.000Z',
        }),
        captureDataOwnerScope(),
      ),
    ).rejects.toMatchObject({ code: 'motion_3d.storage_failed' });
    expect(storedRow()).toEqual(original);
    expect(status()).toBe('awaiting_model');
    expect(mockExecute.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('appends reanalyses while keeping each saved declaration immutable', async () => {
    const original = softwareAnalysis();
    await seedCapture(original);
    await saveMotion3DAnalysis(db, original, captureDataOwnerScope());
    sqlite
      .prepare('UPDATE local_capture SET declared_stroke = ?')
      .run('backhand_drive');
    const next = softwareAnalysis({
      id: 'newer-analysis',
      createdAtIso: '2026-09-05T13:00:00.000Z',
      declaredStroke: 'backhand_drive',
    });
    await saveMotion3DAnalysis(db, next, captureDataOwnerScope());
    await expect(loadMotion3DAnalysis(db, original.record.id)).resolves.toEqual(
      original,
    );
    await expect(
      getLatestMotion3DAnalysisId(db, original.record.captureId),
    ).resolves.toBe(next.record.id);
    expect(query('SELECT id FROM local_motion_analysis').rows).toHaveLength(2);
  });

  it('isolates identical analysis and capture IDs across accounts and the guest bucket', async () => {
    const analysis = softwareAnalysis();
    for (const owner of [ownerA, ownerB, GUEST_DATA_OWNER]) {
      setActiveDataOwner(owner);
      await seedCapture(analysis);
      await saveMotion3DAnalysis(db, analysis, captureDataOwnerScope());
    }
    expect(
      query('SELECT owner_key FROM local_motion_analysis').rows,
    ).toHaveLength(3);
    for (const owner of [ownerA, ownerB, GUEST_DATA_OWNER]) {
      setActiveDataOwner(owner);
      await expect(
        loadMotion3DAnalysis(db, analysis.record.id),
      ).resolves.toEqual(analysis);
      expect(mockExecute.mock.calls.at(-1)?.[1]).toEqual([
        owner,
        analysis.record.id,
      ]);
    }
  });

  it('requires an existing capture in the same owner transaction', async () => {
    const analysis = softwareAnalysis();
    setActiveDataOwner(ownerB);
    await seedCapture(analysis);
    setActiveDataOwner(ownerA);
    await expect(
      saveMotion3DAnalysis(db, analysis, captureDataOwnerScope()),
    ).rejects.toMatchObject({ code: 'motion_3d.capture_missing' });
    expect(query('SELECT id FROM local_motion_analysis').rows).toEqual([]);
    expect(status(ownerB)).toBe('awaiting_model');
    expect(mockExecute.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it.each([
    ['captured_at', '2026-09-04T11:00:00.000Z'],
    ['declared_stroke', 'backhand_drive'],
  ])('rejects changed capture identity metadata: %s', async (column, value) => {
    const analysis = softwareAnalysis();
    await seedCapture(analysis);
    sqlite.prepare(`UPDATE local_capture SET ${column} = ?`).run(value);
    await expect(
      saveMotion3DAnalysis(db, analysis, captureDataOwnerScope()),
    ).rejects.toMatchObject({ code: 'motion_3d.capture_mismatch' });
    expect(storedRow()).toBeUndefined();
    expect(status()).toBe('awaiting_model');
  });

  it('rejects signed-out writes and returns no signed-out history or analysis', async () => {
    const analysis = softwareAnalysis();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await expect(
      saveMotion3DAnalysis(db, analysis, captureDataOwnerScope()),
    ).rejects.toMatchObject({ code: 'motion_3d.signed_out' });
    await expect(
      loadMotion3DAnalysis(db, analysis.record.id),
    ).resolves.toBeNull();
    await expect(
      getLatestMotion3DAnalysisId(db, analysis.record.captureId),
    ).resolves.toBeNull();
    await expect(listMotion3DHistory(db)).resolves.toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('rejects an already stale generation even after returning to the same account', async () => {
    const scope = captureDataOwnerScope();
    switchAwayAndBack();
    await expect(
      saveMotion3DAnalysis(db, softwareAnalysis(), scope),
    ).rejects.toMatchObject({ code: 'motion_3d.owner_changed' });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('rechecks the generation after waiting for another facade to release the queue', async () => {
    const analysis = softwareAnalysis();
    await seedCapture(analysis);
    mockExecute.mockClear();
    const entered = deferred();
    const release = deferred();
    const blocker = getDb().withExclusive!(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const pending = saveMotion3DAnalysis(db, analysis, captureDataOwnerScope());
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'motion_3d.owner_changed',
    });
    switchAwayAndBack();
    release.resolve();
    await blocker;
    await rejected;
    expect(mockExecute).not.toHaveBeenCalled();
    expect(status()).toBe('awaiting_model');
  });

  it.each(['same', 'different'])(
    'serializes sync acknowledgement and Motion3D writes through %s facades',
    async facade => {
      const analysis = softwareAnalysis();
      await seedCapture(analysis);
      const transport = seedSyncShot();
      seedSyncShot(ownerB);
      const motionDb = facade === 'same' ? db : getDb();
      const observerDb = getDb();
      const entered = deferred();
      const release = deferred();
      let firstBegin = true;
      mockExecute.mockClear();
      mockExecute.mockImplementation(async (sql, params) => {
        const result = query(sql, params);
        if (sql === 'BEGIN IMMEDIATE' && firstBegin) {
          firstBegin = false;
          entered.resolve();
          await release.promise;
        }
        return result;
      });
      const acknowledgement = drainOutbox(db, transport);
      await entered.promise;
      const motion = saveMotion3DAnalysis(
        motionDb,
        analysis,
        captureDataOwnerScope(),
      );
      const receipt = observerDb.execute(
        'SELECT entity_id FROM sync_receipt WHERE owner_key = ?',
        [ownerA],
      );
      const completed = Promise.allSettled([acknowledgement, motion, receipt]);
      release.resolve();
      const results = await completed;
      expect(
        results.map(result =>
          result.status === 'rejected'
            ? String(
                result.reason instanceof Motion3DRepositoryError
                  ? result.reason.cause
                  : result.reason,
              )
            : result.status,
        ),
      ).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
      expect(results).toEqual([
        {
          status: 'fulfilled',
          value: { synced: 1, failed: 0, remaining: 0 },
        },
        { status: 'fulfilled', value: undefined },
        {
          status: 'fulfilled',
          value: { rows: [{ entity_id: syncShotId }] },
        },
      ]);
      expect(storedRow()).toBeDefined();
      expect(status()).toBe('analyzed');
      expect(query('SELECT owner_key FROM outbox').rows).toEqual([
        { owner_key: ownerB },
      ]);
      expect(transport.syncShots).toHaveBeenCalledWith([
        expect.objectContaining({ id: syncShotId }),
      ]);
      const statements = mockExecute.mock.calls.map(([sql]) => sql);
      expect(
        statements.slice(
          statements.indexOf('BEGIN IMMEDIATE'),
          statements.lastIndexOf('COMMIT') + 1,
        ),
      ).toEqual([
        'BEGIN IMMEDIATE',
        expect.stringContaining('INSERT OR REPLACE INTO sync_receipt'),
        expect.stringContaining('DELETE FROM outbox'),
        'COMMIT',
        'BEGIN IMMEDIATE',
        expect.stringContaining('SELECT owner_key, id, captured_at'),
        expect.stringContaining('INSERT INTO local_motion_analysis'),
        expect.stringContaining('UPDATE local_capture SET status'),
        'COMMIT',
      ]);
    },
  );

  it.each([
    'INSERT OR REPLACE INTO sync_receipt',
    'DELETE FROM outbox',
    'COMMIT',
  ])(
    'rolls back a failed sync acknowledgement at %s before another facade writes Motion3D',
    async failedStatement => {
      const analysis = softwareAnalysis();
      await seedCapture(analysis);
      const transport = seedSyncShot();
      seedSyncShot(ownerB);
      const payload = query('SELECT payload FROM outbox WHERE owner_key = ?', [
        ownerA,
      ]).rows[0]?.['payload'];
      const entered = deferred();
      const release = deferred();
      const failure = new Error(
        `software acknowledgement failure: ${failedStatement}`,
      );
      let firstBegin = true;
      let injected = false;
      mockExecute.mockClear();
      mockExecute.mockImplementation(async (sql, params) => {
        if (!injected && sql.startsWith(failedStatement)) {
          injected = true;
          throw failure;
        }
        const result = query(sql, params);
        if (sql === 'BEGIN IMMEDIATE' && firstBegin) {
          firstBegin = false;
          entered.resolve();
          await release.promise;
        }
        return result;
      });
      const acknowledgement = drainOutbox(getDb(), transport);
      await entered.promise;
      const motion = saveMotion3DAnalysis(
        getDb(),
        analysis,
        captureDataOwnerScope(),
      );
      const completed = Promise.allSettled([acknowledgement, motion]);
      release.resolve();
      expect(await completed).toEqual([
        {
          status: 'fulfilled',
          value: { synced: 0, failed: 1, remaining: 1 },
        },
        { status: 'fulfilled', value: undefined },
      ]);
      expect(injected).toBe(true);
      expect(query('SELECT entity_id FROM sync_receipt').rows).toEqual([]);
      expect(
        query(
          'SELECT payload, attempts, last_error FROM outbox WHERE owner_key = ?',
          [ownerA],
        ).rows,
      ).toEqual([
        {
          payload,
          attempts: 0,
          last_error: String(failure),
        },
      ]);
      expect(
        query('SELECT attempts, last_error FROM outbox WHERE owner_key = ?', [
          ownerB,
        ]).rows,
      ).toEqual([{ attempts: 0, last_error: null }]);
      expect(storedRow()).toBeDefined();
      expect(status()).toBe('analyzed');
      const statements = mockExecute.mock.calls.map(([sql]) => sql);
      const nextBegin = statements.indexOf(
        'BEGIN IMMEDIATE',
        statements.indexOf('BEGIN IMMEDIATE') + 1,
      );
      expect(statements.indexOf('ROLLBACK')).toBeGreaterThan(-1);
      expect(statements.indexOf('ROLLBACK')).toBeLessThan(nextBegin);
      await expect(getDb().execute('SELECT 1')).resolves.toEqual({
        rows: [{ 1: 1 }],
      });
    },
  );

  it('leaves the database queue free while the sync transport response is pending', async () => {
    const analysis = softwareAnalysis();
    await seedCapture(analysis);
    const transport = seedSyncShot();
    const entered = deferred();
    const release = deferred();
    const exclusive = jest.spyOn(db as Required<LocalDb>, 'withExclusive');
    transport.syncShots = jest.fn(async () => {
      entered.resolve();
      await release.promise;
      return { acceptedIds: [syncShotId], rejected: [] };
    });
    const acknowledgement = drainOutbox(db, transport);
    await entered.promise;
    try {
      expect(exclusive).not.toHaveBeenCalled();
      await saveMotion3DAnalysis(getDb(), analysis, captureDataOwnerScope());
      expect(storedRow()).toBeDefined();
      expect(query('SELECT entity_id FROM sync_receipt').rows).toEqual([]);
    } finally {
      release.resolve();
      await acknowledgement;
    }
    await expect(acknowledgement).resolves.toEqual({
      synced: 1,
      failed: 0,
      remaining: 0,
    });
    expect(exclusive).toHaveBeenCalledTimes(1);
  });

  it('keeps sync acknowledgement compatible with a LocalDb lacking withExclusive', async () => {
    const transport = seedSyncShot();
    const legacyDb: LocalDb = { execute: db.execute, close() {} };
    await expect(drainOutbox(legacyDb, transport)).resolves.toEqual({
      synced: 1,
      failed: 0,
      remaining: 0,
    });
    expect(query('SELECT owner_key, entity_id FROM sync_receipt').rows).toEqual(
      [{ owner_key: ownerA, entity_id: syncShotId }],
    );
    expect(query('SELECT id FROM outbox').rows).toEqual([]);
  });

  it.each([
    'BEGIN IMMEDIATE',
    'SELECT owner_key',
    'INSERT INTO local_motion_analysis',
    'UPDATE local_capture',
  ])('rolls back a real owner ABA after awaiting %s', async statement => {
    const analysis = softwareAnalysis();
    await seedCapture(analysis);
    mockExecute.mockImplementation(async (sql, params) => {
      const result = query(sql, params);
      if (sql.startsWith(statement)) switchAwayAndBack();
      return result;
    });
    await expect(
      saveMotion3DAnalysis(db, analysis, captureDataOwnerScope()),
    ).rejects.toMatchObject({ code: 'motion_3d.owner_changed' });
    expect(storedRow()).toBeUndefined();
    expect(status()).toBe('awaiting_model');
    expect(mockExecute.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(mockExecute.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(
      false,
    );
  });

  it('permits redundant same-owner notifications while saving', async () => {
    const analysis = softwareAnalysis();
    await seedCapture(analysis);
    mockExecute.mockImplementation(async (sql, params) => {
      const result = query(sql, params);
      setActiveDataOwner(ownerA.toUpperCase());
      return result;
    });
    await expect(
      saveMotion3DAnalysis(db, analysis, captureDataOwnerScope()),
    ).resolves.toBeUndefined();
    expect(status()).toBe('analyzed');
  });

  it.each(['load', 'latest', 'history'])(
    'discards %s results across an owner ABA',
    async reader => {
      const analysis = softwareAnalysis();
      await seedCapture(analysis);
      await saveMotion3DAnalysis(db, analysis, captureDataOwnerScope());
      mockExecute.mockImplementation(async (sql, params) => {
        const result = query(sql, params);
        if (sql.includes('FROM local_motion_analysis')) switchAwayAndBack();
        return result;
      });
      const result =
        reader === 'load'
          ? await loadMotion3DAnalysis(db, analysis.record.id)
          : reader === 'latest'
            ? await getLatestMotion3DAnalysisId(db, analysis.record.captureId)
            : await listMotion3DHistory(db);
      expect(result).toEqual(reader === 'history' ? [] : null);
    },
  );

  it.each(['UPDATE local_capture', 'COMMIT'])(
    'rolls back both writes if %s fails',
    async statement => {
      const analysis = softwareAnalysis();
      await seedCapture(analysis);
      const failure = new Error('software-injected storage failure');
      mockExecute.mockImplementation(async (sql, params) => {
        if (sql.startsWith(statement)) throw failure;
        return query(sql, params);
      });
      await expect(
        saveMotion3DAnalysis(db, analysis, captureDataOwnerScope()),
      ).rejects.toMatchObject({
        code: 'motion_3d.storage_failed',
        cause: failure,
      });
      expect(storedRow()).toBeUndefined();
      expect(status()).toBe('awaiting_model');
      expect(mockExecute.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
      await expect(db.execute('SELECT 1')).resolves.toEqual({
        rows: [{ 1: 1 }],
      });
    },
  );

  it('preserves the original failed commit when rollback also fails', async () => {
    const analysis = softwareAnalysis();
    await seedCapture(analysis);
    const commitFailure = new Error('software-injected commit failure');
    mockExecute.mockImplementation(async (sql, params) => {
      if (sql === 'COMMIT') throw commitFailure;
      if (sql === 'ROLLBACK')
        throw new Error('software-injected rollback failure');
      return query(sql, params);
    });
    await expect(
      saveMotion3DAnalysis(db, analysis, captureDataOwnerScope()),
    ).rejects.toMatchObject({
      code: 'motion_3d.storage_failed',
      cause: commitFailure,
    });
    sqlite.exec('ROLLBACK');
    expect(storedRow()).toBeUndefined();
    expect(status()).toBe('awaiting_model');
  });

  it.each([
    'digest',
    'artifact object',
    'capture ID',
    'oversized JSON',
    'unknown record version',
  ])('rejects invalid %s before writing', async corruption => {
    const analysis = JSON.parse(
      JSON.stringify(softwareAnalysis()),
    ) as Motion3DAnalysis;
    await seedCapture(analysis);
    mockExecute.mockClear();
    if (corruption === 'digest')
      analysis.record.artifactSha256 = 'b'.repeat(64);
    if (corruption === 'artifact object')
      analysis.artifact.source.videoSha256 = 'b'.repeat(64);
    if (corruption === 'capture ID')
      analysis.record.captureId = 'different-capture';
    if (corruption === 'oversized JSON')
      analysis.artifactJson = ' '.repeat(MOTION_3D_MAX_JSON_BYTES + 1);
    if (corruption === 'unknown record version')
      Object.assign(analysis.record, { schemaVersion: 2 });
    await expect(
      saveMotion3DAnalysis(db, analysis, captureDataOwnerScope()),
    ).rejects.toMatchObject({ code: 'motion_3d.invalid_analysis' });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(storedRow()).toBeUndefined();
    expect(status()).toBe('awaiting_model');
  });

  it.each([
    { schemaVersion: 2 },
    { geometryVersion: 'unknown-version' },
    { policyVersion: 'future-policy' },
    { id: 'different-analysis' },
    { captureId: 'different-capture' },
    { artifactSha256: 'b'.repeat(64) },
    { sourceVideoSha256: 'b'.repeat(64) },
    { capturedAtIso: '2026-09-04T11:00:00.000Z' },
    { declaredStroke: 'backhand_drive' },
    { createdAtIso: '2026-09-05T13:00:00.000Z' },
    { summary: {} },
    { overallScore: 9.9 },
  ])(
    'returns null for corrupt or unsupported saved record %j',
    async change => {
      const analysis = softwareAnalysis();
      await seedCapture(analysis);
      await saveMotion3DAnalysis(db, analysis, captureDataOwnerScope());
      sqlite
        .prepare('UPDATE local_motion_analysis SET record_json = ?')
        .run(JSON.stringify({ ...analysis.record, ...change }));
      await expect(
        loadMotion3DAnalysis(db, analysis.record.id),
      ).resolves.toBeNull();
      await expect(
        getLatestMotion3DAnalysisId(db, analysis.record.captureId),
      ).resolves.toBeNull();
    },
  );

  it.each([
    'hash corruption',
    'unknown version',
    'missing JSON',
    'malformed record',
  ])(
    'returns null for %s instead of inventing or repairing an artifact',
    async corruption => {
      const analysis = softwareAnalysis();
      await seedCapture(analysis);
      await saveMotion3DAnalysis(db, analysis, captureDataOwnerScope());
      if (corruption === 'hash corruption') {
        sqlite
          .prepare('UPDATE local_motion_analysis SET artifact_json = ?')
          .run(
            analysis.artifactJson.replace(
              'software-test-only',
              'tampered-software-test',
            ),
          );
      } else if (corruption === 'unknown version') {
        const artifactJson = JSON.stringify({
          ...analysis.artifact,
          schemaVersion: 2,
        });
        sqlite
          .prepare(
            'UPDATE local_motion_analysis SET artifact_json = ?, record_json = ?',
          )
          .run(
            artifactJson,
            JSON.stringify({
              ...analysis.record,
              artifactSha256: sha256Hex(artifactJson),
            }),
          );
      } else {
        sqlite
          .prepare(
            `UPDATE local_motion_analysis SET ${corruption === 'missing JSON' ? 'artifact_json' : 'record_json'} = ?`,
          )
          .run(corruption === 'missing JSON' ? '' : '{not-json');
      }
      await expect(
        loadMotion3DAnalysis(db, analysis.record.id),
      ).resolves.toBeNull();
    },
  );

  it('does not fall back to an older analysis when the latest record is corrupt', async () => {
    const original = softwareAnalysis();
    await seedCapture(original);
    await saveMotion3DAnalysis(db, original, captureDataOwnerScope());
    const next = softwareAnalysis({
      id: 'newer-analysis',
      createdAtIso: '2026-09-05T13:00:00.000Z',
    });
    await saveMotion3DAnalysis(db, next, captureDataOwnerScope());
    sqlite
      .prepare(
        'UPDATE local_motion_analysis SET artifact_json = ? WHERE id = ?',
      )
      .run('{}', next.record.id);
    await expect(
      getLatestMotion3DAnalysisId(db, next.record.captureId),
    ).resolves.toBeNull();
    await expect(loadMotion3DAnalysis(db, original.record.id)).resolves.toEqual(
      original,
    );
  });

  it('returns null for orphaned captures and never consults legacy rows', async () => {
    const analysis = softwareAnalysis();
    seedLegacy();
    await expect(
      loadMotion3DAnalysis(db, analysis.record.id),
    ).resolves.toBeNull();
    await seedCapture(analysis);
    await saveMotion3DAnalysis(db, analysis, captureDataOwnerScope());
    sqlite.prepare('DELETE FROM local_capture').run();
    mockExecute.mockClear();
    await expect(
      loadMotion3DAnalysis(db, analysis.record.id),
    ).resolves.toBeNull();
    await expect(
      getLatestMotion3DAnalysisId(db, analysis.record.captureId),
    ).resolves.toBeNull();
    await expect(listMotion3DHistory(db)).resolves.toEqual([]);
    expect(
      mockExecute.mock.calls.every(
        ([sql]) => !/local_shot|local_analysis_record/.test(sql),
      ),
    ).toBe(true);
  });

  it('bounds history to metadata, orders deterministically, and never hydrates fifty artifacts', async () => {
    await seedCapture();
    for (let i = 0; i < 55; i += 1) {
      await saveMotion3DAnalysis(
        db,
        softwareAnalysis({ id: `analysis-${String(i).padStart(2, '0')}` }),
        captureDataOwnerScope(),
      );
    }
    mockExecute.mockClear();
    const history = await listMotion3DHistory(db);
    expect(history).toHaveLength(50);
    expect(history[0]).toEqual({
      id: 'analysis-54',
      captureId: 'software-capture',
      capturedAtIso,
      declaredStroke: null,
    });
    expect(history.at(-1)?.id).toBe('analysis-05');
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).not.toMatch(/artifact_json|record_json|SELECT\s+\*/i);
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual([ownerA, 50]);
    expect(await listMotion3DHistory(db, 2)).toHaveLength(2);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 501])(
    'rejects invalid history limit %s without querying',
    async limit => {
      await expect(listMotion3DHistory(db, limit)).rejects.toMatchObject({
        code: 'motion_3d.invalid_limit',
      });
      expect(mockExecute).not.toHaveBeenCalled();
    },
  );

  it('skips malformed metadata instead of coercing it into a stroke or identity', async () => {
    const analysis = softwareAnalysis();
    await seedCapture(analysis);
    await saveMotion3DAnalysis(db, analysis, captureDataOwnerScope());
    sqlite
      .prepare(
        "UPDATE local_motion_analysis SET declared_stroke = 'invented_stroke'",
      )
      .run();
    await expect(listMotion3DHistory(db)).resolves.toEqual([]);
  });

  it('surfaces database read failures as stable typed errors rather than legacy fallback', async () => {
    mockExecute.mockRejectedValue(new Error('software-injected disk error'));
    await expect(
      loadMotion3DAnalysis(db, 'software-analysis'),
    ).rejects.toBeInstanceOf(Motion3DRepositoryError);
    await expect(
      getLatestMotion3DAnalysisId(db, 'software-capture'),
    ).rejects.toMatchObject({ code: 'motion_3d.storage_failed' });
    await expect(listMotion3DHistory(db)).rejects.toMatchObject({
      code: 'motion_3d.storage_failed',
    });
  });

  it('never writes or replaces a rating, legacy record, or outbox row', async () => {
    const analysis = softwareAnalysis();
    await seedCapture(analysis);
    seedLegacy();
    const tables = [
      'local_shot',
      'local_analysis_record',
      'outbox',
      'local_session',
      'sync_receipt',
    ];
    const before = tables.map(table => query(`SELECT * FROM ${table}`).rows);
    mockExecute.mockClear();
    await saveMotion3DAnalysis(db, analysis, captureDataOwnerScope());
    await loadMotion3DAnalysis(db, analysis.record.id);
    await listMotion3DHistory(db);
    expect(tables.map(table => query(`SELECT * FROM ${table}`).rows)).toEqual(
      before,
    );
    expect(
      mockExecute.mock.calls.every(
        ([sql]) =>
          !/local_shot|local_analysis_record|outbox|local_session|sync_receipt/.test(
            sql,
          ),
      ),
    ).toBe(true);
    expect(analysis.record).not.toHaveProperty('overallScore');
  });

  it('purges the new table with all account data while preserving another owner', async () => {
    const analysis = softwareAnalysis();
    for (const owner of [ownerA, ownerB]) {
      setActiveDataOwner(owner);
      await seedCapture(analysis);
      await saveMotion3DAnalysis(db, analysis, captureDataOwnerScope());
      seedLegacy(owner);
    }
    await purgeOwnerData(getDb(), ownerA);
    expect(storedRow(ownerA)).toBeUndefined();
    expect(status(ownerA)).toBeUndefined();
    expect(storedRow(ownerB)).toBeDefined();
    expect(status(ownerB)).toBe('analyzed');
    expect(query('SELECT owner_key FROM outbox').rows).toEqual([
      { owner_key: ownerB },
    ]);
    expect(mockExecute.mock.calls).toContainEqual([
      'DELETE FROM local_motion_analysis WHERE owner_key = ?',
      [ownerA],
    ]);
    await expect(loadMotion3DAnalysis(db, analysis.record.id)).resolves.toEqual(
      analysis,
    );
  });
});
