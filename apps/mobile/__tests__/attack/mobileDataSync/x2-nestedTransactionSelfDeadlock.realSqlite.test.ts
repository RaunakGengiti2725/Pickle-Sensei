/// <reference types="node" />
/**
 * ATTACK on the MDS-2 fix (7427f9f0): `withLocalTransaction` is re-entrant
 * ONLY for the scoped `tx` handle it passes to the operation
 * (`transactionScopes.add(tx)`), yet every repository writer takes the
 * caller's `db`. A repository call composed inside an outer transaction with
 * the outer `db` (the natural way to make commitPracticeSet's
 * saveAnalysis + saveSession atomic) re-enters `acquireTransactionSlot()`
 * while the slot is held by its own caller — and waits for itself. Nothing
 * throws: the outer transaction never commits, `BEGIN IMMEDIATE` is left
 * open on the one shared connection, and every later `saveAnalysis` /
 * drain receipt queues behind the dead slot forever.
 *
 * On 4d812e1a the same composition failed loudly instead ("cannot start a
 * transaction within a transaction"), so the hazard is new to the fix.
 *
 * Run: cd apps/mobile && NODE_OPTIONS=--experimental-sqlite npx jest \
 *   __tests__/attack/mobileDataSync/x2-nestedTransactionSelfDeadlock.realSqlite.test.ts --ci
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import type { LocalDb } from '../../../src/data/db';
import { saveAnalysis, saveSession } from '../../../src/data/repository';
import { withLocalTransaction } from '../../../src/data/sync';
import {
  openRealSqlite,
  type RealSqliteHandle,
} from '../../../adjudication-support/realSqlite';

const mockState: { handle: RealSqliteHandle | null } = { handle: null };

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockState.handle) throw new Error('harness: no handle');
    return mockState.handle;
  },
}));

function launch(): LocalDb {
  mockState.handle = openRealSqlite();
  let db: LocalDb | null = null;
  jest.isolateModules(() => {
    db = jest
      .requireActual<typeof import('../../../src/data/db')>(
        '../../../src/data/db',
      )
      .getDb();
  });
  if (!db) throw new Error('db module did not load');
  return db;
}

const OWNER = canonicalDataOwner('11111111-1111-4111-8111-111111111111');
const PERMIT = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION = 'dddddddd-0000-4000-8000-000000000001';

function analysis(id: string, sessionId: string | null): ShotAnalysis {
  return {
    id,
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-26T18:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
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
    source: 'real',
  };
}

/** Resolves to 'settled' when `promise` settles first, 'hung' otherwise. */
async function outcome(
  promise: Promise<unknown>,
  ms: number,
): Promise<'settled' | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const hung = new Promise<'hung'>(resolve => {
    timer = setTimeout(() => resolve('hung'), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      hung,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('ATTACK X2: a repository write composed inside withLocalTransaction(db) deadlocks the shared connection (real SQLite)', () => {
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    db = launch();
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    try {
      mockState.handle?.close();
    } catch {
      // a hung transaction may still hold the handle
    }
    mockState.handle = null;
  });

  it('an atomic practice-set commit (saveAnalysis + saveSession on the outer db) must commit or fail loudly, never hang', async () => {
    const atomicCommit = withLocalTransaction(db, async () => {
      await saveAnalysis(db, analysis('a'.repeat(8), SESSION), PERMIT);
      await saveSession(db, {
        id: SESSION,
        mode: 'practice_set',
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: '2026-08-26T18:00:00.000Z',
      });
    });
    const result = await outcome(atomicCommit, 2_000);

    // A later, completely independent save must not be held hostage either.
    const laterSave = saveAnalysis(db, analysis('b'.repeat(8), null), PERMIT);
    const laterResult = await outcome(laterSave, 2_000);

    const statements = mockState.handle?.log ?? [];
    expect({
      atomicCommit: result,
      laterSave: laterResult,
      openTransaction:
        statements.filter(sql => sql === 'BEGIN IMMEDIATE').length -
        statements.filter(sql => sql === 'COMMIT' || sql === 'ROLLBACK').length,
    }).toEqual({
      atomicCommit: 'settled',
      laterSave: 'settled',
      openTransaction: 0,
    });
  });
});
