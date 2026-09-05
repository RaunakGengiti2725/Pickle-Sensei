/**
 * A scored analysis is saved (inside runCaptureAnalysis → saveAnalysis) with
 * the practice-set plan's sessionId BEFORE the screen learns the outcome. The
 * set commit (local_session row + session.create outbox entry + kv activity
 * stamp) therefore has to happen whenever a score exists — whether or not
 * the AnalyzeScreen is still mounted when the run settles. Otherwise the
 * shot's shot.sync row references a session the server never receives:
 * `shot.session_not_found` is a TRANSIENT rejection (sync.ts), so the row
 * retries forever and the rating never reaches the server.
 *
 * Real SQLite (node:sqlite, Node 22) behind the production getDb(); the
 * analysis seam persists the scored shot exactly like production does.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../src/data/db';

// apps/mobile types only `jest` (no @types/node) so app code cannot lean on
// Node APIs; this test declares the exact node:sqlite surface it drives.
declare const require: (id: string) => unknown;

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};

const mockSqlite: { real: DatabaseSync | null } = { real: null };

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const db = mockSqlite.real;
    if (!db) throw new Error('test did not open a database');
    return {
      executeSync: (sql: string) => ({ rows: db.prepare(sql).all() }),
      execute: async (sql: string, params: unknown[] = []) => ({
        rows: db.prepare(sql).all(...(params as (string | number | null)[])),
      }),
      close: () => db.close(),
    };
  },
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/analysis/practiceSet', () => {
  const actual = jest.requireActual('../src/analysis/practiceSet');
  return {
    ...actual,
    commitPracticeSet: jest.fn(actual.commitPracticeSet),
  };
});
jest.mock('../src/data/syncRuntime', () => ({
  triggerOutboxSync: jest.fn(),
}));

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(),
    importedPoseExtractionAvailable: jest.fn(() => true),
    extractImportedPoseSequence: jest.fn(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
  };
});
jest.mock('../src/camera/TargetSelector', () => ({
  TargetSelector: () => null,
}));
const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: 'camera' } }),
}));
type ChildrenOnly = { children?: unknown };
type PassThrough = (props: ChildrenOnly) => unknown;
function mockViewPassThrough(): PassThrough {
  const React = require('react') as {
    createElement: (type: unknown, props: null, children?: unknown) => unknown;
  };
  const { View } = require('react-native') as { View: unknown };
  return props => React.createElement(View, null, props.children);
}
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: mockViewPassThrough(),
}));
jest.mock('react-native-svg', () => {
  const Mock = mockViewPassThrough();
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Ellipse: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import { captureStrokeVideo, type CameraEvent } from '../src/camera/capture';
import {
  runCaptureAnalysis,
  type CaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import { getDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../src/billing/types';
import {
  commitPracticeSet,
  practiceSetKeyForOwner,
  resumeOrStartPracticeSet,
  type PracticeSetPlan,
} from '../src/analysis/practiceSet';
import { saveAnalysis, saveLocalOnlyAnalysis } from '../src/data/repository';
import { triggerOutboxSync } from '../src/data/syncRuntime';
import {
  drainOutbox,
  SESSION_NOT_FOUND_REJECTION,
  type SyncTransport,
} from '../src/data/sync';

const actualPracticeSet = jest.requireActual(
  '../src/analysis/practiceSet',
) as typeof import('../src/analysis/practiceSet');

const owner = '55555555-5555-4555-8555-555555555555';
const permitId = '66666666-6666-4666-8666-666666666666';
const analysisId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function scoredAnalysis(
  sessionId: string | null,
  resultKind: ShotAnalysis['resultKind'] = 'scored',
): ShotAnalysis {
  return {
    id: analysisId,
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-04T12:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: resultKind === 'scored' ? 7.8 : null,
    analysisConfidence: resultKind === 'scored' ? 0.91 : 0.31,
    resultKind,
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'validated-bundle-1',
      poseModelVersion: 'pose-1',
      paddleModelVersion: 'paddle-1',
      strokeDetectorVersion: 'stroke-1',
      phaseModelVersion: 'phase-1',
      scoringModelVersion: 'score-1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

function guidedClip() {
  return {
    uri: 'file:///captures/guided.mov',
    durationMs: 4200,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-04T12:00:00.000Z',
    captureMode: 'automatic_pose_trigger' as const,
    recognition: {
      status: 'unknown' as const,
      reason: 'validated_classifier_unavailable' as const,
    },
    trigger: {
      startMs: 2000,
      endMs: 2700,
      peakMotionMs: 2400,
      confidence: 0.86,
      source: 'temporal_pose_motion' as const,
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' as const },
    captureEvidence: {
      schemaVersion: 1 as const,
      window: 'detected_motion' as const,
      poseSource: 'apple_vision_body_pose' as const,
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second' as const,
      analysisInputFrameCount: 120,
      poseFrameCount: 120,
      poseMissingFrameCount: 0,
      trackedDurationMs: 4200,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: 120,
      jointMotion: [
        {
          joint: 'right_wrist' as const,
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable' as const,
      reason: 'calibrated_ball_tracker_unavailable' as const,
    },
    preRollMs: 2000,
    postRollMs: 1500,
    poseSequence: {
      schemaVersion: 1 as const,
      format: 'pickle.pose-sequence.v1' as const,
      uri: 'file:///captures/guided.pose.json',
      frameCount: 120,
      sha256: 'cd'.repeat(32),
      coordinateSystem: 'normalized_image_top_left' as const,
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

function freeAccess(): CanonicalAccessState {
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used: 0,
      reserved: 0,
      remaining: 2,
      availableToReserve: 2,
    },
    canStartRating: true,
    paywallRequired: false,
  };
}

function backend(): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => {
        throw new Error('plans are not part of this test');
      }),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess()),
      syncBilling: jest.fn(),
    },
  };
}

function pressByLabel(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  act(() => node.props.onPress());
}

function pressButton(renderer: ReactTestRenderer, label: string) {
  const candidates = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.findAll(t => t.type === Text && String(t.props.children) === label)
        .length > 0,
  );
  const node = candidates[candidates.length - 1];
  if (!node) throw new Error(`No button labeled ${label}`);
  act(() => node.props.onPress());
}

async function flush() {
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  await act(async () => {});
}

interface InFlightAnalysisOptions {
  /** `scored` persists via saveAnalysis (permit + shot.sync outbox row, like
   * production); `low_confidence` persists local-only (no outbox row) and
   * resolves as an abstention. */
  outcome?: 'scored' | 'low_confidence';
  /** Runs inside the analysis seam right after the shot was persisted and
   * BEFORE the outcome resolves — i.e. before the screen can commit. */
  afterSave?: (db: LocalDb) => Promise<void>;
}

/** The analysis seam behaves like production: the shot is saved (with the
 * request's sessionId) inside the run, then the outcome resolves only when
 * the test releases it. */
function inFlightAnalysis(options: InFlightAnalysisOptions = {}): {
  request: () => RunCaptureAnalysisRequest;
  settle: () => Promise<void>;
} {
  const outcomeKind = options.outcome ?? 'scored';
  let request: RunCaptureAnalysisRequest | null = null;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  (runCaptureAnalysis as jest.Mock).mockImplementation(
    async (req: RunCaptureAnalysisRequest): Promise<CaptureAnalysisOutcome> => {
      request = req;
      await gate;
      if (outcomeKind === 'low_confidence') {
        await saveLocalOnlyAnalysis(
          req.db,
          scoredAnalysis(req.sessionId ?? null, 'low_confidence'),
        );
        await options.afterSave?.(req.db);
        return {
          kind: 'low_confidence',
          analysisId,
          record: {} as Extract<
            CaptureAnalysisOutcome,
            { kind: 'low_confidence' }
          >['record'],
          guidance: null,
        };
      }
      await saveAnalysis(
        req.db,
        scoredAnalysis(req.sessionId ?? null),
        permitId,
      );
      await options.afterSave?.(req.db);
      return {
        kind: 'scored',
        analysisId,
        record: {} as Extract<
          CaptureAnalysisOutcome,
          { kind: 'scored' }
        >['record'],
        freeLimitReached: false,
      };
    },
  );
  return {
    request: () => {
      if (!request) throw new Error('runCaptureAnalysis was not called');
      return request;
    },
    settle: async () => {
      await act(async () => {
        release();
      });
      await flush();
      await flush();
    },
  };
}

async function startCameraRun(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  pressByLabel(renderer, 'Forehand Drive');
  (captureStrokeVideo as jest.Mock).mockResolvedValue(guidedClip());
  pressButton(renderer, 'Open automatic camera');
  await flush();
  await flush();
  expect(runCaptureAnalysis).toHaveBeenCalledTimes(1);
  return renderer;
}

async function outboxRows(db: LocalDb) {
  const { rows } = await db.execute(
    `SELECT id, kind, payload FROM outbox WHERE owner_key = ? ORDER BY id ASC`,
    [owner],
  );
  return rows.map(row => ({
    id: Number(row['id']),
    kind: String(row['kind']),
    payload: JSON.parse(String(row['payload'])) as Record<string, unknown>,
  }));
}

/** Scored shots whose session_id names no local_session row of the same
 * owner — must always be empty. */
async function orphanedScoredShots(db: LocalDb) {
  const { rows } = await db.execute(
    `SELECT s.id AS shot_id, s.session_id AS session_id
       FROM local_shot s
       LEFT JOIN local_session ls
         ON ls.owner_key = s.owner_key AND ls.id = s.session_id
      WHERE s.owner_key = ?
        AND s.result_kind = 'scored'
        AND s.session_id IS NOT NULL
        AND ls.id IS NULL`,
    [owner],
  );
  return rows;
}

/** A transport that mirrors the server contract: a shot whose sessionId was
 * never created is rejected with `shot.session_not_found`. */
function serverLikeTransport() {
  const knownSessions = new Set<string>();
  const calls: string[] = [];
  const transport: SyncTransport = {
    async createSession(session) {
      const id = String((session as { id: unknown }).id);
      knownSessions.add(id);
      calls.push(`session.create:${id}`);
    },
    async finalizeSession(id) {
      calls.push(`session.finalize:${id}`);
    },
    async syncShots(shots) {
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      for (const shot of shots as Array<{ id: string; sessionId: unknown }>) {
        calls.push(`shot.sync:${shot.id}`);
        if (
          typeof shot.sessionId === 'string' &&
          !knownSessions.has(shot.sessionId)
        ) {
          rejected.push({
            id: shot.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'session not found',
          });
        } else {
          acceptedIds.push(shot.id);
        }
      }
      return { acceptedIds, rejected };
    },
  };
  return { transport, calls };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockCameraListeners.clear();
  mockSqlite.real = new DatabaseSync(':memory:');
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-practice-set',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  clearAccessStoreConfiguration();
  configureAccessStore(backend());
  useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess() });
});

afterEach(() => {
  getDb().close();
  mockSqlite.real = null;
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.useRealTimers();
});

/** Drives one zero-touch camera run, unmounts the screen while the analysis
 * is in flight (player taps X / navigates away during "Measuring your
 * swing…"), then lets the run settle as scored. */
async function abandonedScoredRun(): Promise<{
  db: LocalDb;
  sessionId: string;
}> {
  const analysis = inFlightAnalysis();
  const renderer = await startCameraRun();
  const { sessionId } = analysis.request();
  if (typeof sessionId !== 'string') {
    throw new Error('the plan did not hand a sessionId to the analysis');
  }
  expect(commitPracticeSet).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
  await flush();
  await analysis.settle();
  // The unmounted screen never routes.
  expect(mockNavigation.replace).not.toHaveBeenCalled();
  return { db: getDb(), sessionId };
}

describe('AnalyzeScreen practice set — scored run whose screen was left mid-analysis', () => {
  it('A1: commitPracticeSet is still called for the scored outcome after the unmount', async () => {
    const { db, sessionId } = await abandonedScoredRun();

    expect(commitPracticeSet).toHaveBeenCalledTimes(1);
    expect((commitPracticeSet as jest.Mock).mock.calls[0]?.[1]).toMatchObject({
      sessionId,
      resumed: false,
    });
    const { rows: sessions } = await db.execute(
      `SELECT id, mode FROM local_session WHERE owner_key = ? AND id = ?`,
      [owner, sessionId],
    );
    expect(sessions).toEqual([{ id: sessionId, mode: 'practice_set' }]);
    const stored = (
      await db.execute(`SELECT value FROM kv WHERE key = ?`, [
        practiceSetKeyForOwner(owner),
      ])
    ).rows[0]?.['value'];
    expect(stored).toBeDefined();
    expect(JSON.parse(String(stored)).sessionId).toBe(sessionId);
  });

  it("A2: the outbox holds a session.create row for the shot's sessionId and sync drains it ahead of the shot.sync row", async () => {
    const { db, sessionId } = await abandonedScoredRun();

    const rows = await outboxRows(db);
    expect(rows.map(row => row.kind).sort()).toEqual([
      'session.create',
      'shot.sync',
    ]);
    const sessionCreate = rows.find(row => row.kind === 'session.create');
    const shotSync = rows.find(row => row.kind === 'shot.sync');
    expect(sessionCreate?.payload['id']).toBe(sessionId);
    expect(shotSync?.payload['sessionId']).toBe(sessionId);

    // Drain against a server-like transport: the session reaches the server
    // first, so the shot is accepted on the first pass and nothing is left
    // behind to retry.
    const { transport, calls } = serverLikeTransport();
    await expect(drainOutbox(db, transport)).resolves.toEqual({
      synced: 2,
      failed: 0,
      remaining: 0,
    });
    expect(calls).toEqual([
      `session.create:${sessionId}`,
      `shot.sync:${analysisId}`,
    ]);
  });

  it('A3: no scored shot exists locally with a sessionId that has no local_session row', async () => {
    const { db } = await abandonedScoredRun();

    const { rows: scored } = await db.execute(
      `SELECT id, session_id FROM local_shot
        WHERE owner_key = ? AND result_kind = 'scored'`,
      [owner],
    );
    expect(scored).toHaveLength(1);
    expect(await orphanedScoredShots(db)).toEqual([]);
  });

  it('control: the same run with the screen still mounted commits the set and routes to Result', async () => {
    const analysis = inFlightAnalysis();
    await startCameraRun();
    const { sessionId } = analysis.request();
    await analysis.settle();

    expect(commitPracticeSet).toHaveBeenCalledTimes(1);
    const db = getDb();
    expect(await orphanedScoredShots(db)).toEqual([]);
    const rows = await outboxRows(db);
    expect(rows.map(row => row.kind).sort()).toEqual([
      'session.create',
      'shot.sync',
    ]);
    expect(rows.find(row => row.kind === 'session.create')?.payload['id']).toBe(
      sessionId,
    );
    const { transport } = serverLikeTransport();
    await expect(drainOutbox(db, transport)).resolves.toEqual({
      synced: 2,
      failed: 0,
      remaining: 0,
    });
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId,
    });
  });
});

async function kvStamp(db: LocalDb): Promise<Record<string, unknown> | null> {
  const stored = (
    await db.execute(`SELECT value FROM kv WHERE key = ?`, [
      practiceSetKeyForOwner(owner),
    ])
  ).rows[0]?.['value'];
  return stored === undefined
    ? null
    : (JSON.parse(String(stored)) as Record<string, unknown>);
}

async function outboxAttempts(db: LocalDb) {
  const { rows } = await db.execute(
    `SELECT kind, attempts, last_error FROM outbox WHERE owner_key = ? ORDER BY id ASC`,
    [owner],
  );
  return rows.map(row => ({
    kind: String(row['kind']),
    attempts: Number(row['attempts']),
    lastError: row['last_error'] === null ? null : String(row['last_error']),
  }));
}

describe('AnalyzeScreen practice set — adversarial boundaries around the unmount-time commit', () => {
  it('B1: an abandoned run that ABSTAINS (low_confidence) commits nothing — no local_session row, no outbox row, no kv stamp, no drain kick', async () => {
    const analysis = inFlightAnalysis({ outcome: 'low_confidence' });
    const renderer = await startCameraRun();
    const { sessionId } = analysis.request();
    expect(typeof sessionId).toBe('string');
    await act(async () => renderer.unmount());
    await flush();
    await analysis.settle();

    const db = getDb();
    expect(commitPracticeSet).not.toHaveBeenCalled();
    expect(triggerOutboxSync).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    const { rows: sessions } = await db.execute(
      `SELECT id FROM local_session WHERE owner_key = ?`,
      [owner],
    );
    expect(sessions).toEqual([]);
    expect(await outboxRows(db)).toEqual([]);
    expect(await kvStamp(db)).toBeNull();
    // The abstention is kept for local display only and is never a scored
    // orphan.
    const { rows: shots } = await db.execute(
      `SELECT result_kind FROM local_shot WHERE owner_key = ?`,
      [owner],
    );
    expect(shots).toEqual([{ result_kind: 'low_confidence' }]);
    expect(await orphanedScoredShots(db)).toEqual([]);
  });

  it('B2: an abandoned scored run that RESUMES a live set is idempotent — one session row, one session.create row, kv activity refreshed, drain converges', async () => {
    const db = getDb();
    const seededAtIso = new Date(Date.now() - 5 * 60_000).toISOString();
    const seeded = await resumeOrStartPracticeSet(db, {
      shotType: 'forehand_drive',
      nowIso: seededAtIso,
    });
    if (seeded.sessionId === null) throw new Error('seed did not start a set');
    expect(await kvStamp(db)).toMatchObject({
      sessionId: seeded.sessionId,
      lastActivityAtIso: seededAtIso,
    });
    (commitPracticeSet as jest.Mock).mockClear();

    const { sessionId } = await abandonedScoredRun();
    expect(sessionId).toBe(seeded.sessionId);

    expect(commitPracticeSet).toHaveBeenCalledTimes(1);
    expect((commitPracticeSet as jest.Mock).mock.calls[0]?.[1]).toMatchObject({
      sessionId,
      resumed: true,
    });
    const { rows: sessions } = await db.execute(
      `SELECT id FROM local_session WHERE owner_key = ?`,
      [owner],
    );
    expect(sessions).toEqual([{ id: sessionId }]);
    const rows = await outboxRows(db);
    expect(rows.map(row => row.kind)).toEqual(['session.create', 'shot.sync']);
    expect(rows[0]?.payload['id']).toBe(sessionId);
    expect(rows[1]?.payload['sessionId']).toBe(sessionId);
    const stamp = await kvStamp(db);
    expect(stamp).toMatchObject({ sessionId });
    expect(String(stamp?.['lastActivityAtIso']) > seededAtIso).toBe(true);
    expect(await orphanedScoredShots(db)).toEqual([]);
    const { transport, calls } = serverLikeTransport();
    await expect(drainOutbox(db, transport)).resolves.toEqual({
      synced: 2,
      failed: 0,
      remaining: 0,
    });
    expect(calls).toEqual([
      `session.create:${sessionId}`,
      `shot.sync:${analysisId}`,
    ]);
  });

  it('B3: unmounting while the set commit itself is pending still lands the commit, kicks the drain once and never routes', async () => {
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>(resolve => {
      releaseCommit = resolve;
    });
    (commitPracticeSet as jest.Mock).mockImplementationOnce(
      async (db: LocalDb, plan: PracticeSetPlan) => {
        await commitGate;
        return actualPracticeSet.commitPracticeSet(db, plan);
      },
    );
    const analysis = inFlightAnalysis();
    const renderer = await startCameraRun();
    const { sessionId } = analysis.request();
    await analysis.settle();
    // The outcome resolved; the run is parked inside commitPracticeSet.
    expect(commitPracticeSet).toHaveBeenCalledTimes(1);
    expect(triggerOutboxSync).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    const db = getDb();
    expect(await orphanedScoredShots(db)).toHaveLength(1);

    await act(async () => renderer.unmount());
    await flush();
    await act(async () => {
      releaseCommit();
    });
    await flush();
    await flush();

    expect(triggerOutboxSync).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(await orphanedScoredShots(db)).toEqual([]);
    expect(await kvStamp(db)).toMatchObject({ sessionId });
    const { transport, calls } = serverLikeTransport();
    await expect(drainOutbox(db, transport)).resolves.toEqual({
      synced: 2,
      failed: 0,
      remaining: 0,
    });
    expect(calls).toEqual([
      `session.create:${sessionId}`,
      `shot.sync:${analysisId}`,
    ]);
  });

  it('B4: a drain racing the save (shot.sync queued, session.create not yet) is transient with its attempt budget intact, and the drain after the commit syncs both', async () => {
    const { transport, calls } = serverLikeTransport();
    let earlyDrain: Awaited<ReturnType<typeof drainOutbox>> | null = null;
    const analysis = inFlightAnalysis({
      afterSave: async db => {
        earlyDrain = await drainOutbox(db, transport);
      },
    });
    const renderer = await startCameraRun();
    const { sessionId } = analysis.request();
    await act(async () => renderer.unmount());
    await flush();
    await analysis.settle();

    // Before the commit the shot alone reached the server and was refused
    // as shot.session_not_found: transient, so no attempt was consumed.
    expect(earlyDrain).toEqual({ synced: 0, failed: 1, remaining: 1 });
    expect(calls).toEqual([`shot.sync:${analysisId}`]);
    const db = getDb();
    expect(await outboxAttempts(db)).toEqual([
      {
        kind: 'shot.sync',
        attempts: 0,
        lastError: expect.stringContaining(SESSION_NOT_FOUND_REJECTION),
      },
      { kind: 'session.create', attempts: 0, lastError: null },
    ]);
    // The commit happened despite the unmount, so the next drain converges:
    // session first (sync.ts ordering), then the retried shot.
    await expect(drainOutbox(db, transport)).resolves.toEqual({
      synced: 2,
      failed: 0,
      remaining: 0,
    });
    expect(calls).toEqual([
      `shot.sync:${analysisId}`,
      `session.create:${sessionId}`,
      `shot.sync:${analysisId}`,
    ]);
    expect(await outboxAttempts(db)).toEqual([]);
    expect(await orphanedScoredShots(db)).toEqual([]);
  });

  it('B5: a commitPracticeSet failure never turns a scored run into an error — the mounted screen still kicks the drain and routes to Result', async () => {
    (commitPracticeSet as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('kv write failed');
    });
    const analysis = inFlightAnalysis();
    await startCameraRun();
    await analysis.settle();

    expect(commitPracticeSet).toHaveBeenCalledTimes(1);
    expect(triggerOutboxSync).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId,
    });
    const db = getDb();
    // The scored shot itself is durable regardless of the set bookkeeping.
    const { rows: scored } = await db.execute(
      `SELECT id FROM local_shot WHERE owner_key = ? AND result_kind = 'scored'`,
      [owner],
    );
    expect(scored).toEqual([{ id: analysisId }]);
  });
});
