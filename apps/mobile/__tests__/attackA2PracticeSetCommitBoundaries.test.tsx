/**
 * Adversarial neighbourhood of the mobile-analyze-capture::A2 fix (488db490):
 * AnalyzeScreen.scoreCapture now commits the practice set on the analysis
 * promise itself, so the commit runs after the screen was left. This suite
 * drives that deferred commit through the boundaries the fix did not test —
 * overlapping runs, non-scored outcomes, a resumed set, and the account
 * boundary (the player signs out / another account signs in while the
 * analysis is still in flight).
 *
 * [HELD] tests pin behaviour the fix keeps correct. [BROKEN] tests FAIL on
 * 488db490 and document a real defect the deferred commit introduces: the
 * plan's kv activity stamp is written for the PLANNING owner while the
 * session row + shot are written for the owner ACTIVE at commit time, so an
 * account switch mid-run leaves owner A with a live set whose session row
 * exists only under owner B — A's next scored shot joins that phantom set
 * and is permanently unsyncable (`shot.session_not_found` is transient in
 * sync.ts, so it retries forever). At f702f0f8 the abandoned run committed
 * nothing, so A's next run started a fresh set with its own row.
 *
 * Real SQLite (node:sqlite, Node 22) behind the production getDb(); the
 * analysis seam persists the scored shot exactly like production does.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../src/data/db';

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
} from '../src/analysis/practiceSet';
import { saveAnalysis } from '../src/data/repository';
import {
  drainOutbox,
  SESSION_NOT_FOUND_REJECTION,
  type SyncTransport,
} from '../src/data/sync';
import { triggerOutboxSync } from '../src/data/syncRuntime';

const ownerA = '55555555-5555-4555-8555-555555555555';
const ownerB = '77777777-7777-4777-8777-777777777777';
const permitId = '66666666-6666-4666-8666-666666666666';

function scoredAnalysis(
  analysisId: string,
  sessionId: string | null,
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
    overallScore: 7.8,
    analysisConfidence: 0.91,
    resultKind: 'scored',
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

/** Each run records a distinct clip (local_capture.uri is unique per owner). */
function guidedClip(index: number) {
  return {
    uri: `file:///captures/guided-${index}.mov`,
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
      uri: `file:///captures/guided-${index}.pose.json`,
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

type Resolution =
  | { kind: 'scored'; analysisId: string }
  | { kind: 'abstained' }
  | { kind: 'throw'; error: Error };

interface InFlightRun {
  request: () => RunCaptureAnalysisRequest;
  /** Resolves the run: a scored resolution first persists the shot with the
   * request's sessionId (like runCaptureAnalysis → saveAnalysis). */
  settle: (resolution: Resolution) => Promise<void>;
}

/** Every runCaptureAnalysis call becomes one independently-settled run, so
 * two overlapping runs can be resolved in either order. */
function inFlightAnalyses(): { run: (index: number) => InFlightRun } {
  const runs: Array<{
    request: RunCaptureAnalysisRequest;
    release: (resolution: Resolution) => void;
  }> = [];
  (runCaptureAnalysis as jest.Mock).mockImplementation(
    async (req: RunCaptureAnalysisRequest): Promise<CaptureAnalysisOutcome> => {
      const resolution = await new Promise<Resolution>(release => {
        runs.push({ request: req, release });
      });
      if (resolution.kind === 'throw') throw resolution.error;
      if (resolution.kind === 'abstained') {
        return {
          kind: 'low_confidence',
          analysisId: `low-confidence-${runs.length}`,
          record: {} as Extract<
            CaptureAnalysisOutcome,
            { kind: 'low_confidence' }
          >['record'],
          guidance: null,
        };
      }
      await saveAnalysis(
        req.db,
        scoredAnalysis(resolution.analysisId, req.sessionId ?? null),
        permitId,
      );
      return {
        kind: 'scored',
        analysisId: resolution.analysisId,
        record: {} as Extract<
          CaptureAnalysisOutcome,
          { kind: 'scored' }
        >['record'],
        freeLimitReached: false,
      };
    },
  );
  return {
    run: index => ({
      request: () => {
        const entry = runs[index];
        if (!entry) throw new Error(`runCaptureAnalysis call ${index} missing`);
        return entry.request;
      },
      settle: async resolution => {
        const entry = runs[index];
        if (!entry) throw new Error(`runCaptureAnalysis call ${index} missing`);
        await act(async () => {
          entry.release(resolution);
        });
        await flush();
        await flush();
      },
    }),
  };
}

async function startCameraRun(
  expectedCalls: number,
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  pressByLabel(renderer, 'Forehand Drive');
  (captureStrokeVideo as jest.Mock).mockResolvedValue(
    guidedClip(expectedCalls),
  );
  pressButton(renderer, 'Open automatic camera');
  await flush();
  await flush();
  expect(runCaptureAnalysis).toHaveBeenCalledTimes(expectedCalls);
  return renderer;
}

function signIn(owner: string) {
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: `token-${owner.slice(0, 8)}`,
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess() });
}

/** The one thing every sign-out path does to local data: the active owner
 * becomes the signed-out bucket and the API session is dropped. */
function signOut() {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
}

async function outboxRows(db: LocalDb, owner: string) {
  const { rows } = await db.execute(
    `SELECT id, kind, payload, attempts FROM outbox
      WHERE owner_key = ? ORDER BY id ASC`,
    [owner],
  );
  return rows.map(row => ({
    id: Number(row['id']),
    kind: String(row['kind']),
    attempts: Number(row['attempts']),
    payload: JSON.parse(String(row['payload'])) as Record<string, unknown>,
  }));
}

async function sessionRows(db: LocalDb, owner: string) {
  const { rows } = await db.execute(
    `SELECT id, mode FROM local_session WHERE owner_key = ? ORDER BY id ASC`,
    [owner],
  );
  return rows.map(row => ({
    id: String(row['id']),
    mode: String(row['mode']),
  }));
}

async function storedSet(db: LocalDb, owner: string) {
  const value = (
    await db.execute(`SELECT value FROM kv WHERE key = ?`, [
      practiceSetKeyForOwner(owner),
    ])
  ).rows[0]?.['value'];
  return value === undefined
    ? null
    : (JSON.parse(String(value)) as Record<string, unknown>);
}

/** Scored shots whose session_id names no local_session row of the same
 * owner — must always be empty. */
async function orphanedScoredShots(db: LocalDb, owner: string) {
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
  clearAccessStoreConfiguration();
  configureAccessStore(backend());
  signIn(ownerA);
});

afterEach(() => {
  getDb().close();
  mockSqlite.real = null;
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.useRealTimers();
});

describe('deferred practice-set commit — outcomes that must NOT commit', () => {
  it('[HELD] an abandoned run that ends LOW-CONFIDENCE commits nothing (no session row, no outbox row, no kv stamp) and does not kick a sync', async () => {
    const flights = inFlightAnalyses();
    const renderer = await startCameraRun(1);
    await act(async () => renderer.unmount());
    await flush();
    await flights.run(0).settle({ kind: 'abstained' });

    expect(commitPracticeSet).not.toHaveBeenCalled();
    expect(triggerOutboxSync).not.toHaveBeenCalled();
    const db = getDb();
    expect(await sessionRows(db, ownerA)).toEqual([]);
    expect(await outboxRows(db, ownerA)).toEqual([]);
    expect(await storedSet(db, ownerA)).toBeNull();
  });

  it('[HELD] an abandoned run whose analysis THROWS commits nothing and surfaces no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const flights = inFlightAnalyses();
      const renderer = await startCameraRun(1);
      await act(async () => renderer.unmount());
      await flush();
      await flights
        .run(0)
        .settle({ kind: 'throw', error: new Error('pose pipeline died') });
      await flush();

      expect(commitPracticeSet).not.toHaveBeenCalled();
      expect(triggerOutboxSync).not.toHaveBeenCalled();
      const db = getDb();
      expect(await sessionRows(db, ownerA)).toEqual([]);
      expect(await storedSet(db, ownerA)).toBeNull();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('deferred practice-set commit — overlapping and resumed runs', () => {
  it('[HELD] two overlapping runs (leave mid-run, come back, record again) settling in REVERSE order both commit; no orphan; one drain syncs all four rows', async () => {
    const flights = inFlightAnalyses();
    const first = await startCameraRun(1);
    const firstSession = flights.run(0).request().sessionId;
    await act(async () => first.unmount());
    await flush();

    const second = await startCameraRun(2);
    const secondSession = flights.run(1).request().sessionId;
    expect(typeof firstSession).toBe('string');
    expect(typeof secondSession).toBe('string');
    // Nothing was committed yet, so the second plan cannot resume the first.
    expect(secondSession).not.toBe(firstSession);

    await flights.run(1).settle({ kind: 'scored', analysisId: 'a2-run-2' });
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'a2-run-2',
    });
    await flights.run(0).settle({ kind: 'scored', analysisId: 'a2-run-1' });
    await act(async () => second.unmount());

    expect(commitPracticeSet).toHaveBeenCalledTimes(2);
    const db = getDb();
    expect(await orphanedScoredShots(db, ownerA)).toEqual([]);
    expect((await sessionRows(db, ownerA)).map(row => row.id).sort()).toEqual(
      [firstSession, secondSession].sort(),
    );
    const { transport, calls } = serverLikeTransport();
    await expect(drainOutbox(db, transport)).resolves.toEqual({
      synced: 4,
      failed: 0,
      remaining: 0,
    });
    // Both sessions reach the server before either shot.
    expect(calls.slice(0, 2).sort()).toEqual(
      [
        `session.create:${firstSession}`,
        `session.create:${secondSession}`,
      ].sort(),
    );
    expect(calls.slice(2).sort()).toEqual([
      'shot.sync:a2-run-1',
      'shot.sync:a2-run-2',
    ]);
  });

  it('[HELD] an abandoned run that RESUMES the live set writes no second session row, refreshes the kv stamp, and the outbox still drains clean', async () => {
    const flights = inFlightAnalyses();
    const first = await startCameraRun(1);
    const firstSession = flights.run(0).request().sessionId;
    await flights.run(0).settle({ kind: 'scored', analysisId: 'a2-first' });
    await act(async () => first.unmount());
    await flush();
    const db = getDb();
    expect(await sessionRows(db, ownerA)).toHaveLength(1);
    const before = await storedSet(db, ownerA);
    expect(before?.['sessionId']).toBe(firstSession);

    // Time passes but the set is still live; the next run joins it.
    const later = new Date(Date.now() + 5 * 60_000);
    jest.setSystemTime(later);
    const second = await startCameraRun(2);
    const plan = flights.run(1).request();
    expect(plan.sessionId).toBe(firstSession);
    await act(async () => second.unmount());
    await flush();
    await flights.run(1).settle({ kind: 'scored', analysisId: 'a2-second' });

    expect(commitPracticeSet).toHaveBeenCalledTimes(2);
    expect((commitPracticeSet as jest.Mock).mock.calls[1]?.[1]).toMatchObject({
      sessionId: firstSession,
      resumed: true,
    });
    expect(await sessionRows(db, ownerA)).toHaveLength(1);
    const after = await storedSet(db, ownerA);
    expect(after?.['sessionId']).toBe(firstSession);
    expect(after?.['lastActivityAtIso']).toBe(later.toISOString());
    expect(await orphanedScoredShots(db, ownerA)).toEqual([]);
    const rows = await outboxRows(db, ownerA);
    expect(rows.map(row => row.kind).sort()).toEqual([
      'session.create',
      'shot.sync',
      'shot.sync',
    ]);
    const { transport } = serverLikeTransport();
    await expect(drainOutbox(db, transport)).resolves.toEqual({
      synced: 3,
      failed: 0,
      remaining: 0,
    });
  });
});

/**
 * Account boundary: owner A starts a run, signs out during "Measuring your
 * swing…" (the app gate unmounts the screen), owner B signs in on the same
 * device, and only then does A's analysis settle as scored.
 *
 * Pre-existing at f702f0f8 (NOT asserted here): runCaptureAnalysis saves the
 * shot under the owner active at save time, i.e. under B. NEW with the
 * deferred commit: commitPracticeSet(plan) then writes the local_session row
 * + session.create outbox row for the ACTIVE owner (B, via
 * requireWritableDataOwner) but the kv activity stamp for plan.owner (A).
 */
async function ownerSwitchMidRun(): Promise<{
  db: LocalDb;
  sessionId: string;
}> {
  const flights = inFlightAnalyses();
  const renderer = await startCameraRun(1);
  const sessionId = flights.run(0).request().sessionId;
  if (typeof sessionId !== 'string') throw new Error('plan gave no sessionId');
  expect(flights.run(0).request().apiConfig.token).toBe(
    `token-${ownerA.slice(0, 8)}`,
  );

  signOut();
  await act(async () => renderer.unmount());
  await flush();
  signIn(ownerB);

  await flights.run(0).settle({ kind: 'scored', analysisId: 'a2-owner-a' });
  return { db: getDb(), sessionId };
}

describe('deferred practice-set commit — account boundary (sign out / other account signs in mid-run)', () => {
  it('[BROKEN] owner A is left with a LIVE practice-set stamp whose session row exists only under owner B', async () => {
    const { db, sessionId } = await ownerSwitchMidRun();

    const stampA = await storedSet(db, ownerA);
    const sessionsA = await sessionRows(db, ownerA);
    const sessionsB = await sessionRows(db, ownerB);
    // Whatever the commit decided, A's live set must name a session A holds
    // a row for (or A must have no live set at all), and A's plan must not
    // be filed under B. Observed on 488db490: stampA.sessionId === sessionId,
    // sessionsA === [], sessionsB === [sessionId].
    expect({
      stampANamesSessionAOwns:
        stampA === null ||
        sessionsA.some(row => row.id === stampA['sessionId']),
      sessionFiledUnderB: sessionsB.some(row => row.id === sessionId),
      stampASessionId: stampA?.['sessionId'] ?? null,
      sessionsA: sessionsA.map(row => row.id),
      sessionsB: sessionsB.map(row => row.id),
    }).toMatchObject({
      stampANamesSessionAOwns: true,
      sessionFiledUnderB: false,
    });
  });

  it("[BROKEN] A's NEXT scored run (signed back in within the idle window) joins the phantom set → orphaned scored shot that the server rejects forever (attempts never increment)", async () => {
    const { db, sessionId: phantom } = await ownerSwitchMidRun();

    signOut();
    signIn(ownerA);
    const flights = inFlightAnalyses();
    const renderer = await startCameraRun(2);
    const plan = flights.run(0).request();
    // Observed on 488db490: A's plan resumes the phantom set (resumed:true),
    // so the commit writes only the kv stamp and never a session row for A.
    await flights.run(0).settle({ kind: 'scored', analysisId: 'a2-owner-a-2' });
    await act(async () => renderer.unmount());
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'a2-owner-a-2',
    });

    // Expected: A's scored shot references a session A has a row for and the
    // outbox drains clean. Observed: plan.sessionId === phantom, A has no
    // local_session row, drain leaves the shot.sync row behind with
    // attempts=0 (transient) — permanently unsyncable.
    const { transport } = serverLikeTransport();
    const firstDrain = await drainOutbox(db, transport);
    const secondDrain = await drainOutbox(db, transport);
    const leftover = (await outboxRows(db, ownerA)).map(row => ({
      kind: row.kind,
      attempts: row.attempts,
    }));
    expect({
      planResumedPhantom: plan.sessionId === phantom,
      orphanedScoredShots: (await orphanedScoredShots(db, ownerA)).length,
      sessionRowsForA: (await sessionRows(db, ownerA)).length,
      firstDrain,
      secondDrain,
      leftover,
    }).toEqual({
      planResumedPhantom: false,
      orphanedScoredShots: 0,
      sessionRowsForA: 1,
      firstDrain: { synced: 2, failed: 0, remaining: 0 },
      secondDrain: { synced: 0, failed: 0, remaining: 0 },
      leftover: [],
    });
  });

  it('[HELD] control: the same sign-out with NO other account signing in leaves owner A with no phantom set', async () => {
    const flights = inFlightAnalyses();
    const renderer = await startCameraRun(1);
    signOut();
    await act(async () => renderer.unmount());
    await flush();
    // Signed out: saveAnalysis itself refuses (requireWritableDataOwner), so
    // the run throws and nothing is bookkept for anyone.
    await flights
      .run(0)
      .settle({ kind: 'scored', analysisId: 'a2-signed-out' });
    expect(commitPracticeSet).not.toHaveBeenCalled();
    signIn(ownerA);
    const db = getDb();
    expect(await storedSet(db, ownerA)).toBeNull();
    expect(await sessionRows(db, ownerA)).toEqual([]);
    expect(await orphanedScoredShots(db, ownerA)).toEqual([]);
  });
});
