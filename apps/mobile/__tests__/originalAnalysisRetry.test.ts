import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import {
  assertOriginalAnalysisSnapshot,
  type OriginalAnalysisSnapshot,
} from '../src/analysis/originalAnalysisSnapshot';
import {
  OriginalAnalysisExecution,
  loadSavedOriginalAnalysis,
  originalAnalysisOperations as operations,
  type SavedOriginalAnalysisEntry,
  type SavedOriginalAnalysisLoad,
  type SavedOriginalAnalysisReference,
} from '../src/analysis/originalAnalysisOperations';
import {
  analysisAttemptJournal,
  recoverAnalysisJournals,
  runJournal,
  type RunJournalPermitPort,
} from '../src/analysis/runJournal';
import { loadSavedTechniqueConfirmation } from '../src/analysis/savedTechniqueConfirmation';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
  subscribeToApiSession,
} from '../src/account/apiSession';
import {
  extractImportedPoseSequence,
  readCaptureArtifact,
  verifyCapturedClipCurrentBytes,
  type CapturedClip,
} from '../src/camera/capture';
import * as captureRunner from '../src/analysis/runCaptureAnalysis';
import * as pipeline from '@pickle/analysis-pipeline';
import * as providerModule from '../src/vision/providers';
import { createTransport } from '../src/data/api';
import { drainOutbox } from '../src/data/sync';
import { purgeOwnerData } from '../src/data/repository';
import type { LocalDb } from '../src/data/db';
import { forDataOwner } from '../src/data/transactions';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../testSupport/sqlite';

jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { ...actual, analyzeCapture: jest.fn(actual.analyzeCapture) };
});
jest.mock('../src/camera/capture', () => ({
  ...jest.requireActual('../src/camera/capture'),
  verifyCapturedClipCurrentBytes: jest.fn(),
  readCaptureArtifact: jest.fn(),
  extractImportedPoseSequence: jest.fn(),
}));
const originalFetch = globalThis.fetch;
const verifyBytes = jest.mocked(verifyCapturedClipCurrentBytes);
const OWNER = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://api.example.test/functions/v1/api';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const LOGICAL = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const leases: OriginalAnalysisExecution[] = [];
// Deliberately malformed data is constructed only in negative parser tests.
interface CorruptibleSnapshot {
  [key: string | symbol]: unknown;
  appVersion: string;
  apiOrigin: string;
  clip: {
    uri: string;
    durationMs: number;
    recognition: Record<string, unknown>;
    nativeMediaIdentity: Record<string, unknown>;
  };
  practiceSet: Record<string, unknown>;
  targetSeed: { point: { x: number; y: number; [key: string]: unknown } };
  modelPolicy: { 11: unknown[] & { token?: string } };
}
function signIn(origin = ORIGIN) {
  setActiveDataOwner(OWNER);
  establishApiSession({
    canonicalAppUserId: OWNER,
    apiBaseUrl: origin,
    bearerToken: 'not-persisted-test-bearer',
    provider: 'apple',
  });
}
function execution() {
  const value = new OriginalAnalysisExecution(
    captureDataOwnerContext(),
    ORIGIN,
  );
  leases.push(value);
  return value;
}
function fixture() {
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///private/captures/original.mov',
    captureMode: 'imported_video',
    capturedAtIso: '2026-09-06T12:00:00.000Z',
    durationMs: window.endMs,
    width: 1080,
    height: 1080,
    fps: 60,
    byteSize: 25,
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    nativeMediaIdentity: {
      schemaVersion: 1,
      format: 'pickle.native-media-identity.v1',
      receiptId: '66666666-6666-4666-8666-666666666666',
      operationId: '77777777-7777-4777-8777-777777777777',
      origin: 'import_copy',
      algorithm: 'sha256',
      videoFileName: 'original.mov',
      byteSize: 25,
      sha256: sha256Hex('synthetic test movie bytes'),
    },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///private/captures/original.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecar),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  const snapshot: OriginalAnalysisSnapshot = {
    version: 'original-analysis-v1',
    ownerKey: OWNER,
    apiOrigin: ORIGIN,
    captureId: CAPTURE,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'left',
    cameraView: 'rear_oblique',
    focusCheckpoint: 'contact_point',
    targetSeed: {
      point: { x: 0.4, y: 0.6 },
      selectedAtIso: '2026-09-06T12:01:00.000Z',
    },
    sessionId: SESSION,
    practiceSet: {
      owner: OWNER,
      sessionId: SESSION,
      resumed: false,
      shotType: 'forehand_drive',
      startedAtIso: '2026-09-06T12:00:00.000Z',
      nowIso: '2026-09-06T12:00:00.000Z',
    },
    appVersion: '0.1.0',
    modelPolicy: [
      'fusion-test-1',
      'taxonomy-test-1',
      'bundle-test-1',
      ['phase-test-1', 'real'],
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      [],
    ],
    captureEnvelope: null,
  };
  return { clip, sidecar, snapshot };
}
async function setup(options: { noPose?: boolean; noIdentity?: boolean } = {}) {
  const store = createSqliteTestDb();
  const data = fixture();
  if (options.noPose) delete data.clip.poseSequence;
  if (options.noIdentity) delete data.clip.nativeMediaIdentity;
  seedSqliteCapture(store.db, OWNER, CAPTURE, data.clip);
  await store.db.execute(
    'UPDATE local_capture SET declared_stroke = ?, target_seed = ? WHERE owner_key = ? AND id = ?',
    [
      'forehand_drive',
      JSON.stringify(data.snapshot.targetSeed),
      OWNER,
      CAPTURE,
    ],
  );
  const owner = execution();
  let operation = await operations.prepare(
    store.db,
    owner,
    data.snapshot,
    LOGICAL,
  );
  if (!options.noPose)
    operation = await operations.sealObservation(store.db, owner, LOGICAL, {
      clip: data.clip,
      sidecarJson: data.sidecar,
      captureEnvelope: null,
    });
  const definition = {
    settingsHash: operation.settingsHash,
    modelPolicyHash: operation.modelPolicyHash!,
  };
  return { ...data, store, owner, operation, definition };
}
function service(): RunJournalPermitPort & {
  reserve: jest.Mock;
  release: jest.Mock;
} {
  const permits = new Map<string, { id: string; status: string }>();
  return {
    ownerKey: OWNER,
    apiOrigin: ORIGIN,
    reserve: jest.fn(async (key: string) => {
      let permit = permits.get(key);
      if (!permit) {
        permit = {
          id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(permits.size + 1).padStart(12, '0')}`,
          status: 'reserved',
        };
        permits.set(key, permit);
      }
      return { permit: { ...permit } };
    }),
    release: jest.fn(async (id: string) => {
      const permit = [...permits.values()].find(value => value.id === id);
      if (!permit)
        throw Object.assign(new Error('Missing permit'), {
          status: 404,
          code: 'access.permit_not_found',
        });
      permit.status = 'released';
    }),
  };
}
async function admitted() {
  const input = await setup();
  const admitted = await operations.admit(
    input.store.db,
    input.owner,
    LOGICAL,
    input.definition,
  );
  expect(admitted.kind).toBe('created');
  if (admitted.kind !== 'created') throw new Error(JSON.stringify(admitted));
  const permits = service();
  const reserved = await permits.reserve(admitted.attempt.run.reservationKey);
  await analysisAttemptJournal.reserved(
    input.store.db,
    admitted.attempt.run,
    reserved.permit.id,
  );
  return { ...input, attempt: admitted.attempt, permits };
}
async function releaseFailed(input: Awaited<ReturnType<typeof admitted>>) {
  await operations.requestRelease(
    input.store.db,
    input.attempt.run,
    'failed',
    'inference_technical',
  );
  await analysisAttemptJournal.recover(
    input.store.db,
    input.owner.scope,
    input.permits,
  );
}
function retry(input: Awaited<ReturnType<typeof admitted>>) {
  return operations.admit(input.store.db, input.owner, LOGICAL, {
    ...input.definition,
    predecessorAttemptId: input.attempt.run.operationId,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}

// Actual mobile migrations, transaction adapter and SQLite constraints.
beforeEach(() => {
  signIn();
  verifyBytes.mockReset();
  jest
    .mocked(pipeline.analyzeCapture)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof pipeline>('@pickle/analysis-pipeline')
        .analyzeCapture,
    );
  jest.mocked(readCaptureArtifact).mockReset();
  jest.mocked(extractImportedPoseSequence).mockReset();
  verifyBytes.mockImplementation(async clip => ({
    status: 'verified-current-bytes',
    comparedExpectation: (clip as CapturedClip).nativeMediaIdentity!,
  }));
});
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

it('migrates separate original-operation and execution-attempt tables', async () => {
  const { db } = createSqliteTestDb();
  const { rows } = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  expect(rows.map(row => row.name)).toEqual(
    expect.arrayContaining([
      'analysis_run_journal',
      'analysis_logical_operations',
      'analysis_execution_attempts',
    ]),
  );
});

it('binds execution analysis ids to a stable logical parent through a foreign key', async () => {
  const { db } = createSqliteTestDb();
  const { rows } = await db.execute(
    'PRAGMA foreign_key_list(analysis_execution_attempts)',
  );
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        table: 'analysis_logical_operations',
        from: 'analysis_id',
        to: 'analysis_id',
      }),
    ]),
  );
  expect((await db.execute('PRAGMA foreign_keys')).rows[0]?.foreign_keys).toBe(
    1,
  );
});

it('installs append-only identity, one-successor and one-winner controls without replacing legacy DDL', async () => {
  const { db } = createSqliteTestDb();
  const { rows } = await db.execute('SELECT name FROM sqlite_master');
  expect(rows.map(row => row.name)).toEqual(
    expect.arrayContaining([
      'analysis_run_journal_monotonic',
      'analysis_logical_operations_immutable',
      'analysis_execution_attempts_monotonic',
      'idx_analysis_attempt_one_successor',
      'idx_analysis_attempt_one_commit',
    ]),
  );
});

describe('strict immutable original settings', () => {
  it.each([
    [
      'top-level bearer',
      (value: CorruptibleSnapshot) => {
        value.accessToken = 'private';
      },
    ],
    [
      'nested credential',
      (value: CorruptibleSnapshot) => {
        value.clip.recognition.token = 'private';
      },
    ],
    [
      'practice credential',
      (value: CorruptibleSnapshot) => {
        value.practiceSet.refreshToken = 'private';
      },
    ],
    [
      'selection credential',
      (value: CorruptibleSnapshot) => {
        value.targetSeed.point.authorization = 'private';
      },
    ],
    [
      'provided unknown identity',
      (value: CorruptibleSnapshot) => {
        value.clip.nativeMediaIdentity.jwt = 'private';
      },
    ],
    [
      'oversized setting',
      (value: CorruptibleSnapshot) => {
        value.appVersion = 'v'.repeat(5000);
      },
    ],
    [
      'oversized movie',
      (value: CorruptibleSnapshot) => {
        value.clip.durationMs = 60001;
      },
    ],
    [
      'invalid float',
      (value: CorruptibleSnapshot) => {
        value.targetSeed.point.x = NaN;
      },
    ],
    [
      'wrong practice owner',
      (value: CorruptibleSnapshot) => {
        value.practiceSet.owner = LOGICAL;
      },
    ],
    [
      'wrong session',
      (value: CorruptibleSnapshot) => {
        value.sessionId = LOGICAL;
      },
    ],
    [
      'credential origin',
      (value: CorruptibleSnapshot) => {
        value.apiOrigin = 'https://user:password@example.test';
      },
    ],
    [
      'query-bearing origin',
      (value: CorruptibleSnapshot) => {
        value.apiOrigin += '?token=private';
      },
    ],
    [
      'query-bearing movie',
      (value: CorruptibleSnapshot) => {
        value.clip.uri += '?token=private';
      },
    ],
    [
      'unknown policy field',
      (value: CorruptibleSnapshot) => {
        value.modelPolicy[11].token = 'private';
      },
    ],
    [
      'sparse policy field',
      (value: CorruptibleSnapshot) => {
        value.modelPolicy[11] = new Array(1);
        value.modelPolicy[11].token = 'private';
      },
    ],
    [
      'version token',
      (value: CorruptibleSnapshot) => {
        value.appVersion = 'Bearer private';
      },
    ],
    [
      'accessor',
      (value: CorruptibleSnapshot) => {
        Object.defineProperty(value, 'appVersion', {
          get() {
            throw new Error('Never execute getters');
          },
          enumerable: true,
        });
      },
    ],
    [
      'symbol',
      (value: CorruptibleSnapshot) => {
        value[Symbol('token')] = 'private';
      },
    ],
    [
      'custom prototype',
      (value: CorruptibleSnapshot) => {
        Object.setPrototypeOf(value.targetSeed, { token: 'private' });
      },
    ],
  ])('rejects %s without silently dropping or persisting it', (_, corrupt) => {
    const { snapshot } = fixture();
    corrupt(snapshot as unknown as CorruptibleSnapshot);
    expect(() => assertOriginalAnalysisSnapshot(snapshot)).toThrow();
  });

  it('durably preserves target, intent, practice, settings and app/model policy before extraction can fail', async () => {
    const input = await setup({ noPose: true });
    const row = input.store.native
      .prepare('SELECT * FROM analysis_logical_operations')
      .get()!;
    const saved = JSON.parse(String(row.original_settings));
    expect(saved).toEqual(input.snapshot);
    expect(row.observation_seal).toBeNull();
    expect(row.execution_hash).toBeNull();
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(0);
    expect(String(row.original_settings)).not.toContain(
      'not-persisted-test-bearer',
    );
    expect(Object.isFrozen(input.operation.snapshot.practiceSet)).toBe(true);
    await expect(
      input.store.db.execute(
        'UPDATE analysis_logical_operations SET original_settings = ? WHERE operation_id = ?',
        ['{}', LOGICAL],
      ),
    ).rejects.toThrow();
    expect(verifyBytes).not.toHaveBeenCalled();
  });

  it('never upgrades absent original video identity from current metadata', async () => {
    const input = await setup({ noIdentity: true });
    const result = await operations.admit(
      input.store.db,
      input.owner,
      LOGICAL,
      input.definition,
    );
    expect(result).toMatchObject({
      kind: 'held',
      reason: 'original_unverifiable',
    });
    expect(verifyBytes).not.toHaveBeenCalled();
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(0);
  });

  it('seals actual observations once, rejecting modified bytes or a changed selection', async () => {
    const input = await setup();
    await expect(
      operations.sealObservation(input.store.db, input.owner, LOGICAL, {
        clip: input.clip,
        sidecarJson: `${input.sidecar} `,
        captureEnvelope: null,
      }),
    ).rejects.toThrow();
    await input.store.db.execute(
      'UPDATE local_capture SET target_seed = ? WHERE id = ?',
      [
        JSON.stringify({
          ...input.snapshot.targetSeed,
          point: { x: 0.9, y: 0.2 },
        }),
        CAPTURE,
      ],
    );
    expect(
      await operations.admit(
        input.store.db,
        input.owner,
        LOGICAL,
        input.definition,
      ),
    ).toMatchObject({ kind: 'held', reason: 'target_changed' });
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(0);
  });

  it("does not reconstruct a legacy journal row from today's profile", async () => {
    const input = await setup();
    await input.store.db.execute('DELETE FROM analysis_logical_operations');
    await runJournal.begin(input.store.db, {
      ...input.owner.scope,
      operationId: LOGICAL,
      ownerGeneration: input.owner.ownerContext.generation,
      analysisId: SESSION,
      captureId: CAPTURE,
      requestHash: sha256Hex('legacy definition'),
      reservationKey: '88888888-8888-4888-8888-888888888888',
    });
    await expect(
      operations.prepare(input.store.db, input.owner, input.snapshot, LOGICAL),
    ).rejects.toMatchObject({ reason: 'legacy_unverifiable' });
    expect(input.store.count('analysis_logical_operations', OWNER)).toBe(0);
    expect(input.store.count('analysis_run_journal', OWNER)).toBe(1);
  });
});

describe('atomic successor admission', () => {
  it.each([
    'legacy',
    'mismatch',
    'unavailable',
    'cancelled',
    'invalid',
  ] as const)(
    'holds %s current-byte comparisons without a permit attempt',
    async status => {
      const input = await setup();
      verifyBytes.mockResolvedValue({ status });
      expect(
        await operations.admit(
          input.store.db,
          input.owner,
          LOGICAL,
          input.definition,
        ),
      ).toMatchObject({ kind: 'held', reason: 'original_bytes_unverified' });
      expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(0);
    },
  );

  it('does not accept a success boolean with a different supplied byte expectation', async () => {
    const input = await setup();
    verifyBytes.mockResolvedValue({
      status: 'verified-current-bytes',
      comparedExpectation: {
        ...input.clip.nativeMediaIdentity!,
        sha256: sha256Hex('different bytes'),
      },
    });
    expect(
      (
        await operations.admit(
          input.store.db,
          input.owner,
          LOGICAL,
          input.definition,
        )
      ).kind,
    ).toBe('held');
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(0);
  });

  it('coalesces concurrent byte-bound admissions rather than treating native busy as a different retry', async () => {
    const input = await setup();
    const started = deferred<void>();
    const finishRead =
      deferred<Awaited<ReturnType<typeof verifyCapturedClipCurrentBytes>>>();
    verifyBytes
      .mockImplementationOnce(async () => {
        started.resolve();
        return finishRead.promise;
      })
      .mockResolvedValue({ status: 'unavailable' });
    const first = operations.admit(
      input.store.db,
      input.owner,
      LOGICAL,
      input.definition,
    );
    await started.promise;
    const second = operations.admit(
      input.store.db,
      input.owner,
      LOGICAL,
      input.definition,
    );
    finishRead.resolve({
      status: 'verified-current-bytes',
      comparedExpectation: input.clip.nativeMediaIdentity!,
    });
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.kind)).toEqual(['created', 'existing']);
    expect(verifyBytes).toHaveBeenCalledTimes(1);
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(1);
  });

  it('admits one initial attempt under concurrent taps', async () => {
    const input = await setup();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        operations.admit(
          input.store.db,
          input.owner,
          LOGICAL,
          input.definition,
        ),
      ),
    );
    expect(results.map(result => result.kind).sort()).toEqual([
      'created',
      'existing',
      'existing',
      'existing',
      'existing',
    ]);
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(1);
    const ids = results.map(result =>
      result.kind === 'created' || result.kind === 'existing'
        ? result.attempt.run.operationId
        : null,
    );
    expect(new Set(ids).size).toBe(1);
  });

  it('appends exactly one successor after acknowledged failed release, retaining the stable result id and immutable predecessor', async () => {
    const input = await admitted();
    await releaseFailed(input);
    const before = input.store.native
      .prepare(
        'SELECT * FROM analysis_execution_attempts WHERE operation_id = ?',
      )
      .get(input.attempt.run.operationId);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => retry(input)),
    );
    expect(results.map(result => result.kind).sort()).toEqual([
      'created',
      'existing',
      'existing',
      'existing',
      'existing',
    ]);
    const created = results.find(result => result.kind === 'created');
    if (created?.kind !== 'created') throw new Error('No successor');
    expect(created.attempt.ordinal).toBe(2);
    expect(created.attempt.predecessorOperationId).toBe(
      input.attempt.run.operationId,
    );
    expect(created.attempt.run.analysisId).toBe(input.operation.analysisId);
    expect(created.attempt.run.operationId).not.toBe(
      input.attempt.run.operationId,
    );
    expect(created.attempt.run.reservationKey).not.toBe(
      input.attempt.run.reservationKey,
    );
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(2);
    expect(
      input.store.native
        .prepare(
          'SELECT * FROM analysis_execution_attempts WHERE operation_id = ?',
        )
        .get(input.attempt.run.operationId),
    ).toEqual(before);
    expect((await retry(input)).kind).toBe('existing');
    await expect(
      input.store.db.execute(
        "UPDATE analysis_execution_attempts SET state = 'reserve_pending' WHERE operation_id = ?",
        [input.attempt.run.operationId],
      ),
    ).rejects.toThrow();
    await expect(
      input.store.db.execute(
        'UPDATE analysis_execution_attempts SET reservation_key = ? WHERE operation_id = ?',
        [SESSION, input.attempt.run.operationId],
      ),
    ).rejects.toThrow();
  });

  it.each([
    'active',
    'reserved',
    'release_pending',
    'unclassified',
    'low_confidence',
    'cancelled',
  ] as const)(
    'holds %s predecessors instead of inventing release permission',
    async state => {
      const input = await admitted();
      let stop: (() => void) | undefined;
      if (state === 'active')
        stop = runJournal.startExecution(input.attempt.run);
      if (state === 'release_pending')
        await operations.requestRelease(
          input.store.db,
          input.attempt.run,
          'failed',
          'inference_technical',
        );
      if (
        state === 'unclassified' ||
        state === 'low_confidence' ||
        state === 'cancelled'
      ) {
        await operations.requestRelease(
          input.store.db,
          input.attempt.run,
          state === 'unclassified' ? 'failed' : state,
        );
        await analysisAttemptJournal.recover(
          input.store.db,
          input.owner.scope,
          input.permits,
        );
      }
      try {
        expect((await retry(input)).kind).toBe('held');
        expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(1);
      } finally {
        stop?.();
      }
    },
  );

  it.each([404, 409, 422])(
    'terminal HTTP %s is not a positive release acknowledgement',
    async status => {
      const input = await admitted();
      await operations.requestRelease(
        input.store.db,
        input.attempt.run,
        'failed',
        'inference_technical',
      );
      input.permits.release.mockRejectedValue(
        Object.assign(new Error('Rejected'), {
          status,
          code:
            status === 404
              ? 'access.permit_not_found'
              : 'access.permit_already_finalized',
        }),
      );
      await analysisAttemptJournal.recover(
        input.store.db,
        input.owner.scope,
        input.permits,
      );
      expect(
        (await analysisAttemptJournal.read(input.store.db, input.attempt.run))
          ?.state,
      ).toBe('terminal');
      expect((await retry(input)).kind).toBe('held');
      expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(1);
    },
  );

  it('lost release acknowledgement holds until the SAME permit acknowledges, then admits once', async () => {
    const input = await admitted();
    await operations.requestRelease(
      input.store.db,
      input.attempt.run,
      'failed',
      'inference_technical',
    );
    const actual = input.permits.release.getMockImplementation()!;
    input.permits.release.mockImplementationOnce(async (...args) => {
      await actual(...args);
      throw new TypeError('Lost release acknowledgement');
    });
    await analysisAttemptJournal.recover(
      input.store.db,
      input.owner.scope,
      input.permits,
    );
    expect((await retry(input)).kind).toBe('held');
    expect(
      (await analysisAttemptJournal.read(input.store.db, input.attempt.run))
        ?.state,
    ).toBe('release_pending');
    await analysisAttemptJournal.recover(
      input.store.db,
      input.owner.scope,
      input.permits,
    );
    expect((await retry(input)).kind).toBe('created');
    const permitId = (await analysisAttemptJournal.read(
      input.store.db,
      input.attempt.run,
    ))!.permitId;
    expect(input.permits.release.mock.calls.map(call => call[0])).toEqual([
      permitId,
      permitId,
    ]);
    expect(input.permits.reserve).toHaveBeenCalledTimes(1);
  });

  it('unknown DB reads and missing predecessor rows never authorize a successor', async () => {
    const input = await admitted();
    await releaseFailed(input);
    input.store.failStatementOnce('SELECT * FROM analysis_logical_operations');
    expect(await retry(input)).toMatchObject({
      kind: 'held',
      reason: 'unknown_admission',
    });
    expect(
      (
        await operations.admit(input.store.db, input.owner, LOGICAL, {
          ...input.definition,
          predecessorAttemptId: SESSION,
        })
      ).kind,
    ).toBe('held');
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(1);
  });

  it.each(['settingsHash', 'modelPolicyHash'] as const)(
    "changed %s rejects a fresh successor without consulting today's profile",
    async field => {
      const input = await admitted();
      await releaseFailed(input);
      verifyBytes.mockClear();
      expect(
        await operations.admit(input.store.db, input.owner, LOGICAL, {
          ...input.definition,
          [field]: sha256Hex('changed'),
          predecessorAttemptId: input.attempt.run.operationId,
        }),
      ).toMatchObject({ kind: 'held', reason: 'definition_changed' });
      expect(verifyBytes).not.toHaveBeenCalled();
    },
  );

  it.each(['owner_ABA', 'service_ABA', 'origin_change'] as const)(
    'invalidates %s across byte verification and admits no execution',
    async change => {
      const input = await admitted();
      await releaseFailed(input);
      const gate =
        deferred<Awaited<ReturnType<typeof verifyCapturedClipCurrentBytes>>>();
      const started = deferred<void>();
      verifyBytes.mockImplementation(async () => {
        started.resolve();
        return gate.promise;
      });
      const pending = retry(input);
      await started.promise;
      if (change === 'owner_ABA') {
        setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
        signIn();
      } else {
        signIn('https://other.example.test');
        if (change === 'service_ABA') signIn();
      }
      gate.resolve({
        status: 'verified-current-bytes',
        comparedExpectation: input.clip.nativeMediaIdentity!,
      });
      expect((await pending).kind).toBe('held');
      expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(1);
    },
  );

  it('revalidates the execution generation inside the admission transaction', async () => {
    const input = await setup();
    input.store.observeStatements(call => {
      if (call.sql.includes('INSERT INTO analysis_execution_attempts')) {
        setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
        signIn();
      }
    });
    expect(
      (
        await operations.admit(
          input.store.db,
          input.owner,
          LOGICAL,
          input.definition,
        )
      ).kind,
    ).toBe('held');
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(0);
  });

  it('preserves an honest unknown admission when SQLite commit acknowledgement is lost', async () => {
    const input = await setup();
    input.store.failCommitOnce(
      'after',
      'INSERT INTO analysis_execution_attempts',
    );
    expect(
      (
        await operations.admit(
          input.store.db,
          input.owner,
          LOGICAL,
          input.definition,
        )
      ).kind,
    ).toBe('held');
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(1);
    expect(
      (
        await operations.admit(
          input.store.db,
          input.owner,
          LOGICAL,
          input.definition,
        )
      ).kind,
    ).toBe('existing');
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(1);
  });

  it('cannot mark a new attempt committed without its actual record, shot and outbox', async () => {
    const input = await admitted();
    await expect(
      analysisAttemptJournal.commit(
        input.store.db,
        input.attempt.run,
        input.operation.analysisId,
      ),
    ).rejects.toThrow();
    expect(
      (await analysisAttemptJournal.read(input.store.db, input.attempt.run))
        ?.state,
    ).toBe('reserved');
  });

  it('cannot bypass original immutability using SQLite INSERT OR REPLACE', async () => {
    const input = await setup({ noPose: true });
    await expect(
      input.store.db.execute(
        'INSERT OR REPLACE INTO analysis_logical_operations SELECT * FROM analysis_logical_operations WHERE operation_id = ?',
        [LOGICAL],
      ),
    ).rejects.toThrow();
  });

  it.each(['before', 'after'] as const)(
    'reads actual release proof after %s-release-bookkeeping commit acknowledgement loss',
    async when => {
      const input = await admitted();
      await operations.requestRelease(
        input.store.db,
        input.attempt.run,
        'failed',
        'inference_technical',
      );
      input.store.failCommitOnce(when, "SET state = 'released'");
      expect(
        await analysisAttemptJournal.recover(
          input.store.db,
          input.owner.scope,
          input.permits,
        ),
      ).toEqual([{ operationId: input.attempt.run.operationId, kind: 'held' }]);
      if (when === 'before') {
        expect((await retry(input)).kind).toBe('held');
        await analysisAttemptJournal.recover(
          input.store.db,
          input.owner.scope,
          input.permits,
        );
      }
      expect((await retry(input)).kind).toBe('created');
      expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(2);
    },
  );

  it('reopens with a fresh generation, but refuses a stale attempt callback after its successor', async () => {
    const input = await admitted();
    await releaseFailed(input);
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    signIn();
    const fresh = execution();
    const result = await operations.admit(input.store.db, fresh, LOGICAL, {
      ...input.definition,
      predecessorAttemptId: input.attempt.run.operationId,
    });
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('Expected successor');
    expect(result.attempt.run.ownerGeneration).toBe(
      fresh.ownerContext.generation,
    );
    expect(result.attempt.run.ownerGeneration).not.toBe(
      input.attempt.run.ownerGeneration,
    );
    await expect(
      operations.assertCurrentAttempt(
        input.store.db,
        fresh,
        LOGICAL,
        input.attempt.run,
      ),
    ).rejects.toMatchObject({ reason: 'stale_attempt' });
    await operations.requestRelease(
      input.store.db,
      input.attempt.run,
      'cancelled',
    );
    expect(
      (await analysisAttemptJournal.read(input.store.db, result.attempt.run))
        ?.state,
    ).toBe('reserve_pending');
  });

  it('startup recovery covers both versions, excludes their active execution, and reports independent unknown reads', async () => {
    const input = await admitted();
    const legacyCapture = '99999999-9999-4999-8999-999999999999';
    seedSqliteCapture(input.store.db, OWNER, legacyCapture, {
      ...input.clip,
      uri: 'file:///private/captures/legacy.mov',
      nativeMediaIdentity: undefined,
    });
    const legacy = {
      ...input.attempt.run,
      operationId: SESSION,
      captureId: legacyCapture,
      analysisId: legacyCapture,
      reservationKey: LOGICAL,
    };
    await runJournal.begin(input.store.db, legacy);
    const stop = analysisAttemptJournal.startExecution(input.attempt.run);
    try {
      const recovery = await recoverAnalysisJournals(
        input.store.db,
        input.owner.scope,
        input.permits,
      );
      expect(recovery).toMatchObject({
        unknownStorage: false,
        items: [{ operationId: SESSION, kind: 'released' }],
      });
      expect(
        (await analysisAttemptJournal.read(input.store.db, input.attempt.run))
          ?.state,
      ).toBe('reserved');
    } finally {
      stop();
    }
    input.store.failStatementOnce('FROM analysis_run_journal');
    const recovery = await recoverAnalysisJournals(
      input.store.db,
      input.owner.scope,
      input.permits,
    );
    expect(recovery).toMatchObject({
      unknownStorage: true,
      items: [{ operationId: input.attempt.run.operationId, kind: 'released' }],
    });
    expect((await retry(input)).kind).toBe('held'); // crash recovery's cancelled outcome is not technical-retry proof
  });

  it('confirmed account purge removes both versions without violating their foreign keys', async () => {
    const input = await admitted();
    await releaseFailed(input);
    await retry(input);
    await purgeOwnerData(input.store.db, OWNER);
    for (const table of [
      'analysis_execution_attempts',
      'analysis_logical_operations',
      'analysis_run_journal',
      'local_capture',
    ])
      expect(input.store.count(table, OWNER)).toBe(0);
    expect(
      (await input.store.db.execute('PRAGMA foreign_key_check')).rows,
    ).toEqual([]);
  });
});

async function runnerSetup(noPose = false, auto = false) {
  const store = createSqliteTestDb();
  const { snapshot, clip, sidecar } = fixture();
  const pose = clip.poseSequence!;
  if (noPose) delete clip.poseSequence;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  await store.db.execute(
    'UPDATE local_capture SET declared_stroke = ?, target_seed = ? WHERE id = ?',
    [
      auto ? null : 'forehand_drive',
      JSON.stringify(snapshot.targetSeed),
      CAPTURE,
    ],
  );
  jest.mocked(readCaptureArtifact).mockResolvedValue(sidecar);
  jest.mocked(extractImportedPoseSequence).mockResolvedValue({
    poseSequence: pose,
    framesWithPose: pose.frameCount,
    framesTotal: pose.frameCount,
  });
  const owner = execution();
  const request: captureRunner.RunCaptureAnalysisRequest = {
    db: store.db,
    ownerContext: owner.ownerContext,
    captureId: CAPTURE,
    clip,
    declaredStroke: auto ? null : 'forehand_drive',
    declaredCanonical: auto ? null : 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    appVersion: '0.1.0',
    apiConfig: { baseUrl: ORIGIN, token: 'never-save-this-token' },
    sessionId: SESSION,
    practiceSet: snapshot.practiceSet,
    targetSeed: snapshot.targetSeed,
  };
  const operation = await captureRunner.prepareOriginalCaptureAnalysis(
    request,
    owner,
    LOGICAL,
  );
  const reservations = new Map<
    string,
    { id: string; outcome: string | null }
  >();
  const charges = new Set<string>();
  let loseReserve = false;
  const fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}'));
      const ok = (value: unknown) =>
        ({ ok: true, status: 200, json: async () => value }) as Response;
      if (url.endsWith('/v1/analysis-permits')) {
        expect(
          store.native
            .prepare(
              'SELECT state FROM analysis_execution_attempts WHERE reservation_key = ? UNION ALL SELECT state FROM analysis_run_journal WHERE reservation_key = ?',
            )
            .get(body.idempotencyKey, body.idempotencyKey)?.state,
        ).toMatch(/reserve_pending|release_pending/);
        let permit = reservations.get(body.idempotencyKey);
        if (!permit) {
          permit = {
            id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(reservations.size + 1).padStart(12, '0')}`,
            outcome: null,
          };
          reservations.set(body.idempotencyKey, permit);
        }
        if (loseReserve) {
          loseReserve = false;
          throw new TypeError('Lost reserve acknowledgement');
        }
        return ok({
          permit: {
            id: permit.id,
            status: permit.outcome ? 'finalized' : 'reserved',
            accessSource: 'free',
            expiresAt: '2026-09-07T00:00:00.000Z',
          },
        });
      }
      if (url.endsWith('/finalize')) {
        const permit = [...reservations.values()].find(value =>
          url.includes(value.id),
        );
        expect(permit).toBeDefined();
        expect([null, body.outcome]).toContain(permit?.outcome);
        if (permit) permit.outcome = body.outcome;
        return ok({ permit });
      }
      if (url.endsWith('/v1/sessions')) return ok({});
      if (url.endsWith('/v1/shots:sync')) {
        for (const shot of body.shots) {
          const permit = [...reservations.values()].find(
            value => value.id === shot.analysisPermitId,
          );
          expect([null, 'scored']).toContain(permit?.outcome);
          if (permit) permit.outcome = 'scored';
          charges.add(shot.id);
        }
        return ok({
          acceptedIds: body.shots.map((shot: { id: string }) => shot.id),
          rejected: [],
        });
      }
      throw new Error(`Unexpected test HTTP ${url}`);
    },
  );
  globalThis.fetch = fetch;
  const run = (predecessorAttemptId?: string) =>
    captureRunner.runOriginalCaptureAnalysis({
      db: store.db,
      execution: owner,
      operationId: LOGICAL,
      predecessorAttemptId,
    });
  return {
    store,
    owner,
    request,
    operation,
    fetch,
    reservations,
    charges,
    run,
    loseNextReserve() {
      loseReserve = true;
    },
  };
}

describe('original-only runner and atomic final product', () => {
  it('keeps original settings before extraction failure and resumes that saved file without another capture', async () => {
    const input = await runnerSetup(true);
    jest
      .mocked(extractImportedPoseSequence)
      .mockRejectedValueOnce(
        new Error('Native decoder temporarily unavailable'),
      );
    expect((await input.run()).kind).toBe('unavailable');
    const saved = await operations.read(input.store.db, input.owner, LOGICAL);
    expect(saved?.snapshot.clip.poseSequence).toBeUndefined();
    expect(saved?.snapshot.practiceSet?.sessionId).toBe(SESSION);
    expect(saved?.observation).toBeNull();
    expect(input.fetch).not.toHaveBeenCalled();
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(0);
    const result = await input.run();
    expect(result).toMatchObject({
      kind: 'scored',
      analysisId: input.operation.analysisId,
    });
    expect(
      jest
        .mocked(extractImportedPoseSequence)
        .mock.calls.map(call => call[0].uri),
    ).toEqual([input.request.clip.uri, input.request.clip.uri]);
    expect(
      (await operations.read(input.store.db, input.owner, LOGICAL))?.snapshot
        .clip.poseSequence,
    ).toBeUndefined();
  });

  it.each(['explicit', 'startup'] as const)(
    'keeps %s recovery from cancelling an admitted attempt while its sidecar read is pending',
    async recovery => {
      const input = await runnerSetup();
      const { sidecar } = fixture();
      const entered = deferred<void>();
      const resumeRead = deferred<string>();
      jest
        .mocked(readCaptureArtifact)
        .mockResolvedValueOnce(sidecar)
        .mockImplementationOnce(() => {
          entered.resolve();
          return resumeRead.promise;
        });
      const pending = input.run();
      await entered.promise;
      const port = service();
      let duringState: string | undefined;
      let requestsDuringRead = -1;
      try {
        if (recovery === 'explicit') {
          await captureRunner.reconcileOriginalCaptureAnalysis({
            db: input.store.db,
            execution: input.owner,
            operationId: LOGICAL,
          });
        } else {
          await recoverAnalysisJournals(
            input.store.db,
            input.owner.scope,
            port,
          );
        }
        const current = await operations.read(
          input.store.db,
          input.owner,
          LOGICAL,
        );
        duringState = (
          await operations.readAttempt(
            input.store.db,
            current!,
            current!.currentAttemptId!,
          )
        ).run.state;
        requestsDuringRead =
          input.fetch.mock.calls.length +
          port.reserve.mock.calls.length +
          port.release.mock.calls.length;
      } finally {
        resumeRead.resolve(sidecar);
      }
      const result = await pending;
      expect(requestsDuringRead).toBe(0);
      expect(duringState).toBe('reserve_pending');
      expect(result).toMatchObject({
        kind: 'scored',
        analysisId: input.operation.analysisId,
      });
      expect(input.reservations.size).toBe(1);
      expect(input.store.count('local_analysis_record', OWNER)).toBe(1);
    },
  );

  it('releases a post-admission artifact read failure as retryable technical failure', async () => {
    const input = await runnerSetup();
    const { sidecar } = fixture();
    jest
      .mocked(readCaptureArtifact)
      .mockResolvedValueOnce(sidecar)
      .mockRejectedValueOnce(new Error('Temporary sidecar read failure'));
    expect((await input.run()).kind).toBe('unavailable');
    const operation = await operations.read(
      input.store.db,
      input.owner,
      LOGICAL,
    );
    const failed = await operations.readAttempt(
      input.store.db,
      operation!,
      operation!.currentAttemptId!,
    );
    expect(failed.run).toMatchObject({
      state: 'released',
      releaseOutcome: 'failed',
    });
    expect(failed.technicalFailure).toBe('inference_technical');
    expect(pipeline.analyzeCapture).not.toHaveBeenCalled();
    expect(await input.run(failed.run.operationId)).toMatchObject({
      kind: 'scored',
      analysisId: input.operation.analysisId,
    });
    expect(input.store.count('local_analysis_record', OWNER)).toBe(1);
  });

  it('commits record, practice, shot, outbox, winner and stable parent pointer in ONE SQLite transaction', async () => {
    const input = await runnerSetup();
    const result = await input.run();
    expect(result).toMatchObject({
      kind: 'scored',
      analysisId: input.operation.analysisId,
    });
    const marker = input.store.calls.find(call =>
      call.sql.includes("SET state = 'committed'"),
    );
    const atomic = input.store.calls
      .filter(call => call.transaction === marker?.transaction)
      .map(call => call.sql)
      .join('\n');
    for (const table of [
      'local_analysis_record',
      'local_capture',
      'local_session',
      'local_shot',
      'outbox',
      'analysis_execution_attempts',
      'analysis_logical_operations',
    ])
      expect(atomic).toContain(table);
    expect(input.store.count('analysis_run_journal', OWNER)).toBe(0);
    expect(input.store.count('outbox', OWNER)).toBe(2);
    const operation = await operations.read(
      input.store.db,
      input.owner,
      LOGICAL,
    );
    expect(operation).toMatchObject({
      finalRecordId: input.operation.analysisId,
      completionKind: 'scored',
      winningAttemptId: operation?.currentAttemptId,
    });
    expect(
      await operations.loadCompletion(input.store.db, input.owner, LOGICAL),
    ).toMatchObject({ record: { id: input.operation.analysisId } });
  });

  it('lost reserve acknowledgement reconciles its original key, then one successor scores and charges once', async () => {
    const input = await runnerSetup();
    const infer = jest.mocked(pipeline.analyzeCapture);
    input.loseNextReserve();
    expect((await input.run()).kind).toBe('unavailable');
    const failed = await operations.read(input.store.db, input.owner, LOGICAL);
    expect(failed?.currentAttemptId).toBeTruthy();
    const predecessor = failed!.currentAttemptId!;
    expect((await input.run(predecessor)).kind).toBe('unavailable');
    expect(input.reservations.size).toBe(1);
    // Startup/explicit reconciliation must use the existing reservation, not
    // a caller's boolean saying the lost hold probably expired.
    await captureRunner.reconcileOriginalCaptureAnalysis({
      db: input.store.db,
      execution: input.owner,
      operationId: LOGICAL,
    });
    expect(await input.run(predecessor)).toMatchObject({
      kind: 'scored',
      analysisId: input.operation.analysisId,
    });
    expect(input.reservations.size).toBe(2);
    expect(infer).toHaveBeenCalledTimes(1);
    const transport = createTransport({
      baseUrl: ORIGIN,
      token: 'current-test-token',
    });
    await drainOutbox(input.store.db, transport);
    await drainOutbox(input.store.db, transport);
    expect([...input.charges]).toEqual([input.operation.analysisId]);
    verifyBytes.mockRejectedValue(new Error('Media no longer available'));
    jest
      .mocked(readCaptureArtifact)
      .mockRejectedValue(new Error('Sidecar gone'));
    jest.spyOn(providerModule, 'createFusionProviders').mockReturnValue({
      kind: 'unavailable',
      reason: 'Current model missing',
    });
    expect(await input.run(predecessor)).toMatchObject({
      kind: 'scored',
      analysisId: input.operation.analysisId,
      replayed: true,
    });
    expect(infer).toHaveBeenCalledTimes(1);
    expect(input.reservations.size).toBe(2);
  });

  it('keeps new AUTO confirmations on the existing saved-specific path, not generic technical retry', async () => {
    const input = await runnerSetup(false, true);
    const first = await input.run();
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation')
      throw new Error('Expected an exact-technique confirmation');
    const operation = await operations.read(
      input.store.db,
      input.owner,
      LOGICAL,
    );
    expect(await input.run(operation!.currentAttemptId!)).toMatchObject({
      kind: 'needs_technique_confirmation',
      replayed: true,
    });
    const loaded = await loadSavedTechniqueConfirmation({
      db: input.store.db,
      ownerContext: input.owner.ownerContext,
      captureId: CAPTURE,
      apiOrigin: ORIGIN,
    });
    expect(loaded.kind).toBe('ready');
    expect(input.reservations.size).toBe(1);
    const confirmed = await captureRunner.runCaptureAnalysis({
      ...input.request,
      declaredStroke: 'forehand_drive',
      declaredCanonical: 'FOREHAND_DRIVE',
      techniqueConfirmation: {
        analysisId: first.analysisId,
        intent: {
          version: 'technique-intent-v1',
          legacySlug: 'forehand_drive',
          canonical: 'FOREHAND_DRIVE',
          source: 'tap',
          confidence: 1,
        },
        confirmedAtIso: new Date().toISOString(),
      },
    });
    expect(confirmed.kind).toBe('scored');
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(1);
    expect(input.store.count('analysis_run_journal', OWNER)).toBe(1);
  });

  it('does not refund or infer again when final commit acknowledgement AND a result read are lost', async () => {
    const input = await runnerSetup();
    input.store.failCommitOnce('after');
    input.store.observeStatements(call => {
      if (call.sql.includes('SET final_record_id ='))
        input.store.failStatementOnce('FROM local_analysis_record r');
    });
    expect((await input.run()).kind).toBe('unavailable');
    expect(
      [...input.reservations.values()].map(permit => permit.outcome),
    ).toEqual([null]);
    expect(input.store.count('local_analysis_record', OWNER)).toBe(1);
    expect(input.store.count('outbox', OWNER)).toBe(2);
    input.store.observeStatements(null);
    expect(await input.run()).toMatchObject({ kind: 'scored', replayed: true });
    expect(pipeline.analyzeCapture).toHaveBeenCalledTimes(1);
  });

  it.each(['model', 'profile', 'service_ABA', 'owner_ABA'] as const)(
    'keeps original intent and fences %s changes before final publication',
    async change => {
      const input = await runnerSetup();
      if (change === 'model') {
        jest.spyOn(providerModule, 'createFusionProviders').mockReturnValue({
          kind: 'unavailable',
          reason: 'Model policy changed',
        });
        expect((await input.run()).kind).toBe('unavailable');
        expect(input.fetch).not.toHaveBeenCalled();
        expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(0);
        return;
      }
      if (change === 'profile') {
        await input.store.db.execute(
          'INSERT INTO kv (key, value) VALUES (?, ?)',
          [
            `profile:${OWNER}`,
            JSON.stringify({
              handedness: 'left',
              cameraView: 'rear_oblique',
              focusCheckpoint: 'different',
            }),
          ],
        );
        const result = await input.run();
        expect(result.kind).toBe('scored');
        if (result.kind !== 'scored')
          throw new Error('Expected original settings');
        expect(result.record.inputSelection).toMatchObject({
          handedness: 'right',
          cameraView: 'side',
          focusCheckpoint: null,
        });
        return;
      }
      const actual = jest.requireActual<typeof pipeline>(
        '@pickle/analysis-pipeline',
      ).analyzeCapture;
      jest
        .mocked(pipeline.analyzeCapture)
        .mockImplementationOnce(async (...args) => {
          const result = await actual(...args);
          if (change === 'service_ABA') {
            signIn('https://other.example.test');
            signIn();
          } else {
            setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
            signIn();
          }
          return result;
        });
      expect((await input.run()).kind).toBe('unavailable');
      expect(input.store.count('local_analysis_record', OWNER)).toBe(0);
      expect(input.store.count('outbox', OWNER)).toBe(0);
    },
  );

  it.each(['before', 'after'] as const)(
    'handles a %s-commit SQLite crash without duplicate product or refunding a committed score',
    async when => {
      const input = await runnerSetup();
      input.store.failCommitOnce(when);
      const first = await input.run();
      const operation = await operations.read(
        input.store.db,
        input.owner,
        LOGICAL,
      );
      if (when === 'before') {
        expect(first.kind).toBe('unavailable');
        expect(operation?.finalRecordId).toBeNull();
        expect(input.store.count('local_shot', OWNER)).toBe(0);
        expect(input.store.count('local_session', OWNER)).toBe(0);
        expect(input.store.count('outbox', OWNER)).toBe(0);
        expect(await input.run(operation!.currentAttemptId!)).toMatchObject({
          kind: 'scored',
          analysisId: input.operation.analysisId,
        });
      } else {
        expect(first).toMatchObject({
          kind: 'scored',
          analysisId: input.operation.analysisId,
        });
        expect(
          [...input.reservations.values()].map(permit => permit.outcome),
        ).toEqual([null]);
        expect(await input.run(operation!.currentAttemptId!)).toMatchObject({
          kind: 'scored',
          replayed: true,
        });
      }
      expect(input.store.count('local_analysis_record', OWNER)).toBe(1);
      expect(input.store.count('local_shot', OWNER)).toBe(1);
      expect(input.store.count('outbox', OWNER)).toBe(2);
    },
  );
});

describe('read-only cold saved original analysis loading', () => {
  type Store = ReturnType<typeof createSqliteTestDb>;
  type LoadRequest = Parameters<typeof loadSavedOriginalAnalysis>[0];
  const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
  const OTHER_ORIGIN = 'https://other.example.test';
  const reads = [
    'SELECT * FROM analysis_logical_operations',
    'SELECT owner_key, id, status FROM local_capture',
    'SELECT operation_id FROM analysis_execution_attempts',
    'SELECT * FROM local_capture',
    'SELECT * FROM analysis_execution_attempts',
    'SELECT attempt_ordinal',
    'SELECT 1 AS found FROM local_analysis_record',
    'SELECT id FROM local_analysis_record',
  ] as const;

  function load(store: Store, overrides: Partial<LoadRequest> = {}) {
    return loadSavedOriginalAnalysis({
      db: store.db,
      ownerContext: captureDataOwnerContext(),
      captureId: CAPTURE,
      apiOrigin: ORIGIN,
      ...overrides,
    });
  }

  function localReopen() {
    for (const lease of leases.splice(0)) lease.dispose();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(OWNER);
  }

  // This fixture is real SQLite, but is in-memory only. Drop every original
  // execution/snapshot/runner reference; this proves fresh caller reconstruction,
  // NOT durable file reopening, a process restart, or OS-kill/native survival.
  async function coldPrepared(noPose = true): Promise<Store> {
    const { store } = await setup({ noPose });
    localReopen();
    return store;
  }

  function readOnlyProbe(store: Store) {
    const changes = () =>
      store.native.prepare('SELECT total_changes() AS n').get()!.n;
    const before = changes();
    store.calls.length = 0;
    verifyBytes.mockClear();
    jest.mocked(readCaptureArtifact).mockClear();
    jest.mocked(extractImportedPoseSequence).mockClear();
    jest.mocked(pipeline.analyzeCapture).mockClear();
    const providers = jest.spyOn(providerModule, 'createFusionProviders');
    const fetch = jest.fn(async () => {
      throw new Error('The saved-original loader must not use HTTP');
    });
    globalThis.fetch = fetch;
    return () => {
      expect(changes()).toBe(before);
      expect(
        store.calls.every(call =>
          /^(SELECT\b|BEGIN IMMEDIATE$|COMMIT$|ROLLBACK$)/i.test(
            call.sql.trim(),
          ),
        ),
      ).toBe(true);
      expect(verifyBytes).not.toHaveBeenCalled();
      expect(readCaptureArtifact).not.toHaveBeenCalled();
      expect(extractImportedPoseSequence).not.toHaveBeenCalled();
      expect(pipeline.analyzeCapture).not.toHaveBeenCalled();
      expect(providers).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    };
  }

  function deferRead(db: LocalDb, includes: string) {
    const entered = deferred<void>();
    const resume = deferred<void>();
    let paused = false;
    const wrap = (connection: LocalDb): LocalDb => ({
      ...connection,
      async execute(sql, params) {
        const result = await connection.execute(sql, params);
        if (!paused && sql.includes(includes)) {
          paused = true;
          entered.resolve();
          await resume.promise;
        }
        return result;
      },
      transaction: connection.transaction
        ? operation => connection.transaction!(tx => operation(wrap(tx)))
        : undefined,
    });
    return { db: wrap(db), entered: entered.promise, resume: resume.resolve };
  }

  it('loads a frozen inspection address from SQLite without a retained execution, API session, or current profile', async () => {
    const store = await coldPrepared();
    await store.db.execute('INSERT INTO kv (key, value) VALUES (?, ?)', [
      `profile:${OWNER}`,
      JSON.stringify({ handedness: 'right', cameraView: 'side' }),
    ]);
    const ownerContext = { ...captureDataOwnerContext() };
    const check = readOnlyProbe(store);
    const result: SavedOriginalAnalysisLoad = await load(store, {
      ownerContext,
      apiOrigin: 'https://API.example.test:443/functions/v1/api///',
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error(JSON.stringify(result));
    const saved: SavedOriginalAnalysisEntry = result.saved;
    const reference: SavedOriginalAnalysisReference = saved.reference;
    expect(reference).toEqual({
      operationId: LOGICAL,
      captureId: CAPTURE,
      ownerContext,
      apiOrigin: ORIGIN,
    });
    expect(reference.ownerContext).not.toBe(ownerContext);
    expect(Object.isFrozen(reference)).toBe(true);
    expect(Object.isFrozen(reference.ownerContext)).toBe(true);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.clip)).toBe(true);
    expect(saved.clip).toEqual(
      JSON.parse(
        String(
          store.native.prepare('SELECT payload FROM local_capture').get()!
            .payload,
        ),
      ),
    );
    expect(saved.clip.poseSequence).toBeUndefined();
    expect(store.calls.some(call => /\bkv\b/.test(call.sql))).toBe(false);
    expect(() => new OriginalAnalysisExecution(ownerContext, ORIGIN)).toThrow();
    check();
  });

  it.each([
    'sealed',
    'reserve_pending',
    'reserved',
    'release_pending',
    'released',
    'terminal',
    'active',
    'successor',
  ] as const)(
    'opens %s for inspection without recovery or retry permission',
    async state => {
      const input = await setup();
      let stop: (() => void) | undefined;
      if (state !== 'sealed') {
        const admission = await operations.admit(
          input.store.db,
          input.owner,
          LOGICAL,
          input.definition,
        );
        if (admission.kind !== 'created')
          throw new Error(JSON.stringify(admission));
        const run = admission.attempt.run;
        if (state === 'active') stop = runJournal.startExecution(run);
        if (!['reserve_pending', 'active'].includes(state)) {
          const port = service();
          const reserved = await port.reserve(run.reservationKey);
          await analysisAttemptJournal.reserved(
            input.store.db,
            run,
            reserved.permit.id,
          );
          if (
            ['release_pending', 'released', 'terminal', 'successor'].includes(
              state,
            )
          ) {
            await operations.requestRelease(
              input.store.db,
              run,
              'failed',
              'inference_technical',
            );
            if (state !== 'release_pending') {
              if (state === 'terminal')
                port.release.mockRejectedValue(
                  Object.assign(new Error('Rejected'), {
                    status: 404,
                    code: 'access.permit_not_found',
                  }),
                );
              await analysisAttemptJournal.recover(
                input.store.db,
                input.owner.scope,
                port,
              );
            }
            if (state === 'successor')
              expect(
                (
                  await operations.admit(input.store.db, input.owner, LOGICAL, {
                    ...input.definition,
                    predecessorAttemptId: run.operationId,
                  })
                ).kind,
              ).toBe('created');
          }
        }
      }
      localReopen();
      const check = readOnlyProbe(input.store);
      try {
        expect(await load(input.store)).toMatchObject({
          kind: 'ready',
          saved: { reference: { operationId: LOGICAL } },
        });
        check();
      } finally {
        stop?.();
      }
    },
  );

  it('never caches an inspection as current-byte or successor authorization', async () => {
    const input = await admitted();
    await releaseFailed(input);
    localReopen();
    const check = readOnlyProbe(input.store);
    const loaded = await load(input.store);
    expect(loaded.kind).toBe('ready');
    check();
    if (loaded.kind !== 'ready') throw new Error(JSON.stringify(loaded));
    signIn();
    verifyBytes.mockResolvedValue({ status: 'mismatch' });
    expect(
      await operations.admit(
        input.store.db,
        execution(),
        loaded.saved.reference.operationId,
        {
          ...input.definition,
          predecessorAttemptId: input.attempt.run.operationId,
        },
      ),
    ).toMatchObject({ kind: 'held', reason: 'original_bytes_unverified' });
    expect(verifyBytes).toHaveBeenCalledTimes(1);
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(1);
  });

  it.each(['scored', 'confirmation', 'confirmed_continuation'] as const)(
    'delegates %s to the existing latest-result/confirmation loader only',
    async kind => {
      const input = await runnerSetup(false, kind !== 'scored');
      const first = await input.run();
      if (kind !== 'scored')
        expect(first.kind).toBe('needs_technique_confirmation');
      if (kind === 'confirmed_continuation') {
        if (first.kind !== 'needs_technique_confirmation')
          throw new Error('Expected confirmation');
        expect(
          (
            await captureRunner.runCaptureAnalysis({
              ...input.request,
              declaredStroke: 'forehand_drive',
              declaredCanonical: 'FOREHAND_DRIVE',
              techniqueConfirmation: {
                analysisId: first.analysisId,
                intent: {
                  version: 'technique-intent-v1',
                  legacySlug: 'forehand_drive',
                  canonical: 'FOREHAND_DRIVE',
                  source: 'tap',
                  confidence: 1,
                },
                confirmedAtIso: new Date().toISOString(),
              },
            })
          ).kind,
        ).toBe('scored');
        // The continuation's current declaration need not equal the AUTO
        // parent's immutable declaration; result validation owns that lineage.
        await input.store.db.execute(
          'UPDATE local_capture SET declared_stroke = ? WHERE owner_key = ? AND id = ?',
          ['forehand_drive', OWNER, CAPTURE],
        );
        expect(
          input.store.native
            .prepare('SELECT declared_stroke FROM local_capture')
            .get()!.declared_stroke,
        ).toBe('forehand_drive');
      }
      localReopen();
      const check = readOnlyProbe(input.store);
      expect(await load(input.store)).toEqual({ kind: 'load_result' });
      check();
      // Delegation, not this read-only address lookup, owns latest record and
      // continuation validation (and any needed sidecar read for confirmation).
      const delegated = await loadSavedTechniqueConfirmation({
        db: input.store.db,
        ownerContext: captureDataOwnerContext(),
        captureId: CAPTURE,
        apiOrigin: ORIGIN,
      });
      expect(delegated.kind).toBe(
        kind === 'confirmation' ? 'ready' : 'already_completed',
      );
    },
  );

  it('does not claim a corrupt completed result is verified', async () => {
    const input = await runnerSetup();
    expect((await input.run()).kind).toBe('scored');
    await input.store.db.execute(
      "UPDATE local_analysis_record SET record = '{}' WHERE owner_key = ?",
      [OWNER],
    );
    localReopen();
    const check = readOnlyProbe(input.store);
    expect(await load(input.store)).toEqual({ kind: 'load_result' });
    check();
    expect(
      await loadSavedTechniqueConfirmation({
        db: input.store.db,
        ownerContext: captureDataOwnerContext(),
        captureId: CAPTURE,
        apiOrigin: ORIGIN,
      }),
    ).toMatchObject({ kind: 'unavailable', reason: 'corrupt' });
  });

  it.each(
    reads.flatMap(read =>
      ['owner_ABA', 'service_ABA', 'session_clear_ABA'].map(change => [
        read,
        change,
      ]),
    ),
  )(
    'fences %s across %s before publishing a saved address',
    async (read, change) => {
      const { store } = await admitted();
      localReopen();
      if (change === 'session_clear_ABA') signIn();
      const check = readOnlyProbe(store);
      const gate = deferRead(store.db, read);
      const pending = load(store, { db: gate.db });
      await gate.entered;
      if (change === 'owner_ABA') {
        setActiveDataOwner(OTHER_OWNER);
        setActiveDataOwner(OWNER);
      } else if (change === 'session_clear_ABA') {
        clearApiSession();
        signIn();
      } else {
        signIn(OTHER_ORIGIN);
        signIn();
      }
      gate.resume();
      expect(await pending).toEqual({
        kind: 'unavailable',
        reason: change === 'owner_ABA' ? 'account_changed' : 'origin_mismatch',
      });
      check();
    },
  );

  it('latches a reentrant service A-B-A notification instead of just sampling the latest session', async () => {
    const store = await coldPrepared();
    signIn();
    // Earlier subscribers may restore A while notifying the B transition.
    // The loader must still inspect the B notification it receives afterward.
    const stop = subscribeToApiSession(session => {
      if (session?.apiBaseUrl === OTHER_ORIGIN) signIn();
    });
    const check = readOnlyProbe(store);
    const gate = deferRead(store.db, reads[0]);
    try {
      const pending = load(store, { db: gate.db });
      await gate.entered;
      signIn(OTHER_ORIGIN);
      gate.resume();
      expect(await pending).toEqual({
        kind: 'unavailable',
        reason: 'origin_mismatch',
      });
      check();
    } finally {
      gate.resume();
      stop();
    }
  });

  it.each(['restore', 'rotation'] as const)(
    'allows matching session %s during local reads',
    async change => {
      const store = await coldPrepared();
      if (change === 'rotation') signIn();
      const check = readOnlyProbe(store);
      const gate = deferRead(store.db, reads[0]);
      const pending = load(store, { db: gate.db });
      await gate.entered;
      establishApiSession({
        canonicalAppUserId: OWNER,
        apiBaseUrl: `${ORIGIN}/`,
        provider: 'apple',
        bearerToken: 'rotated-not-persisted',
      });
      gate.resume();
      expect((await pending).kind).toBe('ready');
      check();
    },
  );

  it('captures the caller address and owner before deferred SQLite work', async () => {
    const store = await coldPrepared();
    const check = readOnlyProbe(store);
    const gate = deferRead(store.db, reads[0]);
    const ownerContext = { ...captureDataOwnerContext() };
    const expected = { ...ownerContext };
    const request = {
      db: gate.db,
      ownerContext,
      captureId: CAPTURE,
      apiOrigin: ORIGIN,
    };
    const pending = loadSavedOriginalAnalysis(request);
    await gate.entered;
    ownerContext.ownerKey = OTHER_OWNER;
    ownerContext.generation += 1;
    request.captureId = SESSION;
    request.apiOrigin = OTHER_ORIGIN;
    gate.resume();
    expect(await pending).toMatchObject({
      kind: 'ready',
      saved: {
        reference: {
          operationId: LOGICAL,
          captureId: CAPTURE,
          ownerContext: expected,
          apiOrigin: ORIGIN,
        },
      },
    });
    check();
  });

  it.each(['before', 'during', 'assertCurrent', 'after_transaction'] as const)(
    'does not publish after navigation is cancelled %s',
    async when => {
      const store = await coldPrepared();
      const controller = new AbortController();
      let current = true;
      if (when === 'before') controller.abort();
      const check = readOnlyProbe(store);
      const gate = deferRead(store.db, reads[0]);
      if (when === 'after_transaction')
        store.observeStatements(call => {
          if (call.sql === 'COMMIT') controller.abort();
        });
      const pending = load(store, {
        db: gate.db,
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) throw new Error('Route superseded');
        },
      });
      if (when !== 'before') {
        await gate.entered;
        if (when === 'during') controller.abort();
        if (when === 'assertCurrent') current = false;
        gate.resume();
      }
      expect(await pending).toEqual({
        kind: 'unavailable',
        reason: 'cancelled',
      });
      if (when === 'before') expect(store.calls).toEqual([]);
      check();
    },
  );

  it.each([...reads, 'BEGIN IMMEDIATE', 'COMMIT'])(
    'fails closed on SQLite error at %s',
    async read => {
      const { store } = await admitted();
      localReopen();
      const check = readOnlyProbe(store);
      store.failStatementOnce(read, new Error('Database unavailable'));
      expect(await load(store)).toEqual({
        kind: 'unavailable',
        reason: 'corrupt',
      });
      check();
    },
  );

  it.each([
    'missing',
    'capture_only',
    'legacy_journal',
    'legacy_identity',
  ] as const)('does not invent an original for %s records', async state => {
    const { store } = await setup({
      noPose: true,
      noIdentity: state === 'legacy_identity',
    });
    if (state !== 'legacy_identity') {
      await store.db.execute('DELETE FROM analysis_logical_operations');
      if (state === 'missing')
        await store.db.execute('DELETE FROM local_capture');
      if (state === 'legacy_journal')
        await runJournal.begin(store.db, {
          ownerKey: OWNER,
          apiOrigin: ORIGIN,
          ownerGeneration: captureDataOwnerContext().generation,
          operationId: LOGICAL,
          analysisId: SESSION,
          captureId: CAPTURE,
          requestHash: sha256Hex('unverifiable legacy definition'),
          reservationKey: SESSION,
        });
    }
    localReopen();
    const check = readOnlyProbe(store);
    expect(await load(store)).toEqual({
      kind: 'unavailable',
      reason: state === 'missing' ? 'missing' : 'legacy',
    });
    check();
  });

  it.each([
    'invalid_capture',
    'foreign_capture',
    'stale_owner',
    'other_owner',
    'other_origin',
    'foreign_session',
  ] as const)('fails closed for %s without publishing a clip', async change => {
    const store = await coldPrepared();
    const ownerContext = captureDataOwnerContext();
    const overrides: Partial<LoadRequest> = { ownerContext };
    if (change === 'invalid_capture') overrides.captureId = 'not-an-id';
    if (change === 'foreign_capture') overrides.captureId = SESSION;
    if (change === 'stale_owner' || change === 'other_owner') {
      setActiveDataOwner(OTHER_OWNER);
      if (change === 'other_owner')
        overrides.ownerContext = captureDataOwnerContext();
    }
    if (change === 'other_origin') overrides.apiOrigin = OTHER_ORIGIN;
    if (change === 'foreign_session')
      establishApiSession({
        canonicalAppUserId: OTHER_OWNER,
        apiBaseUrl: ORIGIN,
        bearerToken: 'not-an-owner-authorization',
        provider: 'apple',
      });
    const check = readOnlyProbe(store);
    const result = await load(store, overrides);
    expect(result.kind).toBe('unavailable');
    expect(result).not.toHaveProperty('saved');
    expect(result).not.toHaveProperty('clip');
    check();
  });

  it('does not pick the first row of an ambiguous logical lookup', async () => {
    const store = await coldPrepared();
    const check = readOnlyProbe(store);
    // The schema has UNIQUE(owner_key,capture_id). Exercise a corrupt/ambiguous
    // adapter response using two actual SQLite SELECTs, not invented proof rows.
    const db: LocalDb = {
      ...store.db,
      transaction: operation =>
        store.db.transaction!(tx =>
          operation({
            ...tx,
            execute(sql, params) {
              return sql.startsWith(reads[0])
                ? tx.execute(`${sql} UNION ALL ${sql}`, [
                    ...params!,
                    ...params!,
                  ])
                : tx.execute(sql, params);
            },
          }),
        ),
    };
    expect(await load(store, { db })).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    check();
  });

  it.each([
    [
      "UPDATE analysis_logical_operations SET original_settings = '{'",
      'corrupt',
    ],
    [
      "UPDATE analysis_logical_operations SET original_settings = json_set(original_settings, '$.accessToken', 'private')",
      'corrupt',
    ],
    [
      "UPDATE analysis_logical_operations SET settings_hash = printf('%064d', 0)",
      'corrupt',
    ],
    [
      "UPDATE analysis_logical_operations SET model_policy_hash = printf('%064d', 0)",
      'corrupt',
    ],
    [
      "UPDATE analysis_logical_operations SET original_settings = json_set(original_settings, '$.ownerKey', '22222222-2222-4222-8222-222222222222')",
      'corrupt',
    ],
    [
      "UPDATE analysis_logical_operations SET api_origin = 'https://foreign.example.test'",
      'corrupt',
    ],
    [
      "UPDATE analysis_logical_operations SET observation_seal = '{}'",
      'corrupt',
    ],
    [
      "UPDATE analysis_logical_operations SET execution_hash = printf('%064d', 0)",
      'corrupt',
    ],
    [
      'UPDATE analysis_logical_operations SET observation_seal = NULL, execution_hash = NULL',
      'corrupt',
    ],
    [
      'UPDATE analysis_logical_operations SET current_attempt_id = NULL',
      'corrupt',
    ],
    [
      'UPDATE analysis_logical_operations SET final_record_id = analysis_id',
      'corrupt',
    ],
    ["UPDATE local_capture SET payload = '{'", 'corrupt'],
    [
      "UPDATE local_capture SET payload = json_set(payload, '$.nativeMediaIdentity.sha256', printf('%064d', 0))",
      'evidence_changed',
    ],
    [
      "UPDATE local_capture SET payload = json_set(payload, '$.poseSequence.sha256', printf('%064d', 0))",
      'evidence_changed',
    ],
    [
      "UPDATE local_capture SET declared_stroke = 'backhand_drive'",
      'evidence_changed',
    ],
    ['UPDATE local_capture SET width = 720', 'evidence_changed'],
    ["UPDATE local_capture SET target_seed = '{}'", 'evidence_changed'],
    ["UPDATE local_capture SET status = 'analyzed'", 'corrupt'],
    [
      "UPDATE local_capture SET owner_key = '22222222-2222-4222-8222-222222222222'",
      'missing',
    ],
    [
      "UPDATE local_capture SET id = '55555555-5555-4555-8555-555555555555'",
      'missing',
    ],
    [
      "UPDATE analysis_execution_attempts SET capture_id = '55555555-5555-4555-8555-555555555555'",
      'corrupt',
    ],
    [
      "UPDATE analysis_execution_attempts SET owner_key = '22222222-2222-4222-8222-222222222222'",
      'corrupt',
    ],
    [
      "UPDATE analysis_execution_attempts SET api_origin = 'https://foreign.example.test'",
      'corrupt',
    ],
    [
      "UPDATE analysis_execution_attempts SET request_hash = printf('%064d', 0)",
      'corrupt',
    ],
    [
      "UPDATE analysis_execution_attempts SET technical_failure = 'unknown'",
      'corrupt',
    ],
    ['UPDATE analysis_execution_attempts SET attempt_ordinal = 0', 'corrupt'],
    ['UPDATE analysis_execution_attempts SET attempt_count = -1', 'corrupt'],
    ["UPDATE analysis_execution_attempts SET state = 'not_a_state'", 'corrupt'],
    [
      'UPDATE analysis_execution_attempts SET result_id = analysis_id',
      'corrupt',
    ],
    ['DELETE FROM analysis_execution_attempts', 'corrupt'],
  ])(
    'rejects corrupt/evidence-changed SQLite rows: %s',
    async (sql, reason) => {
      const { store } = await admitted();
      // Deliberately bypass fixture constraints solely to model damaged storage.
      // No shipping schema or monetary transitions are changed by these tests.
      store.native.exec(`PRAGMA foreign_keys = OFF;
      PRAGMA ignore_check_constraints = ON;
      DROP TRIGGER analysis_logical_operations_immutable;
      DROP TRIGGER analysis_execution_attempts_monotonic;`);
      await store.db.execute(sql);
      localReopen();
      const check = readOnlyProbe(store);
      expect(await load(store)).toEqual({ kind: 'unavailable', reason });
      check();
    },
  );

  it.each([
    'local_analysis_record',
    'local_shot',
    'outbox',
    'sync_receipt',
  ] as const)(
    'does not reopen an unfinished original with unexpected %s product',
    async table => {
      const input = await setup();
      if (table === 'local_analysis_record')
        await input.store.db.execute(
          "INSERT INTO local_analysis_record (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record) VALUES (?, ?, ?, '2026-09-06T12:00:00.000Z', 'test', 'test', '{}')",
          [OWNER, input.operation.analysisId, CAPTURE],
        );
      if (table === 'local_shot')
        await input.store.db.execute(
          "INSERT INTO local_shot (owner_key, id, shot_type, captured_at, confidence, result_kind, source, payload) VALUES (?, ?, 'forehand_drive', '2026-09-06T12:00:00.000Z', 1, 'scored', 'real', '{}')",
          [OWNER, input.operation.analysisId],
        );
      if (table === 'outbox')
        await input.store.db.execute(
          "INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)",
          [OWNER, JSON.stringify({ id: input.operation.analysisId })],
        );
      if (table === 'sync_receipt')
        await input.store.db.execute(
          "INSERT INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)",
          [OWNER, input.operation.analysisId],
        );
      localReopen();
      const check = readOnlyProbe(input.store);
      expect(await load(input.store)).toEqual({
        kind: 'unavailable',
        reason: 'corrupt',
      });
      check();
    },
  );

  it.each(['foreign_record_capture', 'legacy_collision'] as const)(
    'holds a mixed-history %s instead of publishing an inspection address',
    async conflict => {
      const input = await setup();
      if (conflict === 'foreign_record_capture')
        await input.store.db.execute(
          "INSERT INTO local_analysis_record (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record) VALUES (?, ?, ?, '2026-09-06T12:00:00.000Z', 'test', 'test', '{}')",
          [OWNER, input.operation.analysisId, SESSION],
        );
      else
        await input.store.db.execute(
          `INSERT INTO analysis_run_journal
          (owner_key, operation_id, owner_generation, capture_id, analysis_id, request_hash, api_origin, reservation_key, state, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserve_pending', 0, 0)`,
          [
            OWNER,
            SESSION,
            captureDataOwnerContext().generation,
            CAPTURE,
            SESSION,
            sha256Hex('legacy'),
            ORIGIN,
            SESSION,
          ],
        );
      localReopen();
      const check = readOnlyProbe(input.store);
      expect(await load(input.store)).toEqual({
        kind: 'unavailable',
        reason: 'corrupt',
      });
      check();
    },
  );

  it('checks the sealed observation even when the prepared snapshot had no pose', async () => {
    const input = await setup({ noPose: true });
    const { clip, sidecar } = fixture();
    await input.store.db.execute(
      'UPDATE local_capture SET payload = ? WHERE owner_key = ?',
      [JSON.stringify(clip), OWNER],
    );
    await operations.sealObservation(input.store.db, input.owner, LOGICAL, {
      clip,
      sidecarJson: sidecar,
      captureEnvelope: null,
    });
    await input.store.db.execute(
      "UPDATE local_capture SET payload = json_set(payload, '$.poseSequence.sha256', ?)",
      [sha256Hex('different sidecar')],
    );
    localReopen();
    const check = readOnlyProbe(input.store);
    expect(await load(input.store)).toEqual({
      kind: 'unavailable',
      reason: 'evidence_changed',
    });
    check();
  });

  it('retains current relocated addresses without blessing replacement media', async () => {
    const { store } = await setup();
    const clip = fixture().clip;
    clip.uri = 'file:///private/new-container/captures/original.mov';
    clip.poseSequence = {
      ...clip.poseSequence!,
      uri: 'file:///private/new-container/captures/original.pose.json',
    };
    clip.posterUri = 'file:///private/new-container/captures/poster.jpg';
    await store.db.execute(
      'UPDATE local_capture SET uri = ?, payload = ? WHERE owner_key = ?',
      [clip.uri, JSON.stringify(clip), OWNER],
    );
    localReopen();
    const check = readOnlyProbe(store);
    expect(await load(store)).toMatchObject({ kind: 'ready', saved: { clip } });
    check();
  });

  it.each([
    'missing_predecessor',
    'self_predecessor',
    'stale_parent_pointer',
  ] as const)(
    'fails closed on %s after an actual successor admission',
    async change => {
      const input = await admitted();
      await releaseFailed(input);
      const successor = await retry(input);
      if (successor.kind !== 'created')
        throw new Error(JSON.stringify(successor));
      input.store.native.exec(`PRAGMA foreign_keys = OFF;
        PRAGMA ignore_check_constraints = ON;
        DROP TRIGGER analysis_logical_operations_immutable;
        DROP TRIGGER analysis_execution_attempts_monotonic;`);
      if (change === 'missing_predecessor')
        await input.store.db.execute(
          'DELETE FROM analysis_execution_attempts WHERE operation_id = ?',
          [input.attempt.run.operationId],
        );
      if (change === 'self_predecessor')
        await input.store.db.execute(
          'UPDATE analysis_execution_attempts SET predecessor_operation_id = operation_id WHERE operation_id = ?',
          [successor.attempt.run.operationId],
        );
      if (change === 'stale_parent_pointer')
        await input.store.db.execute(
          'UPDATE analysis_logical_operations SET current_attempt_id = ?',
          [input.attempt.run.operationId],
        );
      localReopen();
      const check = readOnlyProbe(input.store);
      expect(await load(input.store)).toEqual({
        kind: 'unavailable',
        reason: 'corrupt',
      });
      check();
    },
  );

  it.each(['owner_ABA', 'service_ABA'] as const)(
    'fences %s after the read transaction finishes too',
    async change => {
      const store = await coldPrepared();
      const check = readOnlyProbe(store);
      store.observeStatements(call => {
        if (call.sql !== 'COMMIT') return;
        if (change === 'owner_ABA') {
          setActiveDataOwner(OTHER_OWNER);
          setActiveDataOwner(OWNER);
        } else {
          signIn(OTHER_ORIGIN);
          signIn();
        }
      });
      expect(await load(store)).toEqual({
        kind: 'unavailable',
        reason: change === 'owner_ABA' ? 'account_changed' : 'origin_mismatch',
      });
      check();
    },
  );

  it('rejects a scoped execution database rather than silently borrowing another owner', async () => {
    const store = await coldPrepared();
    const check = readOnlyProbe(store);
    expect(
      await load(store, {
        db: forDataOwner(store.db, captureDataOwnerContext()),
      }),
    ).toMatchObject({ kind: 'unavailable' });
    expect(store.calls).toEqual([]);
    check();
  });
});
