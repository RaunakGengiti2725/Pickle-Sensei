import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type {
  CameraEvent,
  CameraReadinessState,
  CapturedClip,
} from '../src/camera/capture';

/**
 * PRACTICE-SET LIFECYCLE ON AN ABANDONED RUN (mobile-analyze-capture::A2).
 *
 * A scored analysis is saved with its practice set's sessionId. The set's
 * bookkeeping — the `practice_set` local_session row, the session.create
 * outbox entry the server needs BEFORE it will accept the shot, and the kv
 * activity stamp — must therefore land whenever a score lands, whether or
 * not AnalyzeScreen is still mounted when runCaptureAnalysis resolves.
 * Otherwise the shot.sync row references a session the server never learns
 * about and retries forever (sync treats session_not_found as transient).
 *
 * The permit reservation is held pending so the screen can be unmounted
 * while runCaptureAnalysis is genuinely in flight; the fake LocalDb honours
 * transactions so the durable rows can be asserted over after the run.
 */

// ─── Navigation / environment seams ─────────────────────────────────────────

const mockNavigation = {
  replace: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  popToTop: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: 'camera' } }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});
jest.mock('../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

jest.mock('../src/analysis/practiceSet', () => {
  const actual = jest.requireActual<
    typeof import('../src/analysis/practiceSet')
  >('../src/analysis/practiceSet');
  return {
    ...actual,
    commitPracticeSet: jest.fn(actual.commitPracticeSet),
  };
});

// ─── Native camera seam ─────────────────────────────────────────────────────

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();
let mockCaptureImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('capture mock not configured'));
let mockReadArtifact: (uri: string) => Promise<string> = () =>
  Promise.reject(new Error('readCaptureArtifact mock not configured'));

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: () => mockCaptureImpl(),
    importStrokeVideo: () =>
      Promise.reject(new Error('library import is out of scope here')),
    cancelCameraOperation: jest.fn(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import { commitPracticeSet } from '../src/analysis/practiceSet';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';

const owner = '22222222-2222-4222-8222-222222222222';

// ─── Fake LocalDb with durable state and transactions ───────────────────────

interface ShotRow {
  id: string;
  sessionId: string | null;
}
interface OutboxRow {
  kind: string;
  payload: Record<string, unknown>;
}
interface Ledger {
  db: LocalDb;
  sessions: string[];
  shots: ShotRow[];
  outbox: OutboxRow[];
  kv: Map<string, string>;
  sql: string[];
}

let activeDb: Ledger;
function mockCurrentDb(): LocalDb {
  return activeDb.db;
}

function ledgerDb(): Ledger {
  const sessions: string[] = [];
  const shots: ShotRow[] = [];
  const outbox: OutboxRow[] = [];
  const kv = new Map<string, string>();
  const sql: string[] = [];
  let staged: (() => void)[] | null = null;
  const write = (apply: () => void) => {
    if (staged) staged.push(apply);
    else apply();
  };
  const db: LocalDb = {
    async execute(statement: string, params: unknown[] = []) {
      sql.push(statement);
      if (statement === 'BEGIN IMMEDIATE') {
        if (staged) throw new Error('ledgerDb: nested transaction');
        staged = [];
        return { rows: [] };
      }
      if (statement === 'COMMIT') {
        const pending = staged ?? [];
        staged = null;
        for (const apply of pending) apply();
        return { rows: [] };
      }
      if (statement === 'ROLLBACK') {
        staged = null;
        return { rows: [] };
      }
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = kv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        const key = String(params[0]);
        const value = String(params[1]);
        write(() => kv.set(key, value));
        return { rows: [] };
      }
      if (statement.includes('INSERT OR REPLACE INTO local_session')) {
        const id = String(params[1]);
        write(() => sessions.push(id));
        return { rows: [] };
      }
      if (statement.includes('INSERT OR REPLACE INTO local_shot')) {
        const row: ShotRow = {
          id: String(params[1]),
          sessionId: params[2] === null ? null : String(params[2]),
        };
        write(() => shots.push(row));
        return { rows: [] };
      }
      if (statement.includes('INSERT INTO outbox')) {
        const kind = /'([a-z.]+)'/.exec(statement)?.[1] ?? 'unknown';
        const payload = JSON.parse(String(params[1])) as Record<
          string,
          unknown
        >;
        write(() => outbox.push({ kind, payload }));
        return { rows: [] };
      }
      // Capture rows, analysis records and status updates are recorded in
      // `sql` only — this suite asserts over sessions, shots and the outbox.
      return { rows: [] };
    },
    close() {},
  };
  return { db, sessions, shots, outbox, kv, sql };
}

// ─── Permit server whose reservation can be held pending ────────────────────

function heldPermitServer() {
  let releaseReservation!: () => void;
  const reservationHeld = new Promise<void>(resolve => {
    releaseReservation = resolve;
  });
  let reservationRequested!: () => void;
  const reservationRequestedPromise = new Promise<void>(resolve => {
    reservationRequested = resolve;
  });
  const finalized: unknown[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      reservationRequested();
      await reservationHeld;
      return jsonResponse({
        permit: {
          id: 'permit-1',
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-29T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) {
      finalized.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return {
    fetchMock,
    finalized,
    reservationRequested: reservationRequestedPromise,
    releaseReservation: () => releaseReservation(),
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

// ─── Recorded-clip fixture ──────────────────────────────────────────────────

function guidedClip(id: string): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: `file:///captures/${id}.mov`,
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-08-29T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 2000,
    postRollMs: 1500,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///captures/${id}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

// ─── Render / driving helpers ────────────────────────────────────────────────

async function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  return renderer;
}

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
  });
}

async function waitFor(condition: () => boolean, what: string) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await act(async () => {
      await new Promise(resolve => setTimeout(() => resolve(undefined), 15));
    });
  }
}

function pressByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  act(() => node.props.onPress());
}

function pressButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
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

function emit(event: CameraEvent) {
  act(() => {
    for (const listener of mockCameraListeners) listener(event);
  });
}

const eventBase = () => ({ emittedAtIso: '2026-08-29T18:00:00.000Z' });

function readinessEvent(
  state: CameraReadinessState,
  jointCoverage: number,
): CameraEvent {
  return {
    ...eventBase(),
    type: 'readiness',
    state,
    poseConfidence: 0.9,
    jointCoverage,
    stableForMs: 300,
    missingJoints: [],
    source: 'apple_vision_body_pose',
    modelVersion: 'apple-vision-bodypose-1',
  };
}

function strokeDetectedEvent(): CameraEvent {
  return {
    ...eventBase(),
    type: 'stroke_detected',
    startTimestampMs: 2000,
    endTimestampMs: 2700,
    peakMotionTimestampMs: 2400,
    confidence: 0.86,
    detectionModelVersion: 'temporal-stroke-heuristic-2',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
  };
}

function deferredCapture() {
  let resolveFn!: (clip: CapturedClip) => void;
  mockCaptureImpl = () =>
    new Promise<CapturedClip>(resolve => {
      resolveFn = resolve;
    });
  return {
    resolve: (clip: CapturedClip) => act(() => resolveFn(clip)),
  };
}

const commitPracticeSetMock = commitPracticeSet as jest.MockedFunction<
  typeof commitPracticeSet
>;

beforeEach(() => {
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  activeDb = ledgerDb();
  mockCameraListeners.clear();
  mockNavigation.replace.mockClear();
  commitPracticeSetMock.mockClear();
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

describe('practice set commit survives an unmount during in-flight scoring', () => {
  it('unmounting AnalyzeScreen while runCaptureAnalysis is in flight still commits the practice set for the scored outcome', async () => {
    const server = heldPermitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    const { clip, sidecarJson } = guidedClip('abandoned-run');
    mockReadArtifact = async () => sidecarJson;
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(readinessEvent('ready', 0.93));
    emit(strokeDetectedEvent());
    capture.resolve(clip);

    // runCaptureAnalysis is now in flight, parked on the permit reservation.
    await act(async () => {
      await server.reservationRequested;
    });
    expect(activeDb.shots).toHaveLength(0);

    // The player leaves the screen (background / navigation) mid-run …
    await act(async () => renderer.unmount());
    // … and the reservation then resolves, so the run scores and saves.
    server.releaseReservation();
    await waitFor(
      () => activeDb.outbox.some(row => row.kind === 'shot.sync'),
      'the scored shot to reach the outbox',
    );
    // Let the post-save bookkeeping settle.
    await flush();
    await flush();

    // 1. The practice set was committed even though the screen was gone.
    expect(commitPracticeSetMock).toHaveBeenCalledTimes(1);

    // 2. session.create is queued for the shot's sessionId AHEAD of shot.sync.
    const [shot] = activeDb.shots;
    expect(shot).toBeDefined();
    expect(shot!.sessionId).toEqual(expect.any(String));
    const sessionCreateIndex = activeDb.outbox.findIndex(
      row => row.kind === 'session.create' && row.payload['id'] === shot!.sessionId,
    );
    const shotSyncIndex = activeDb.outbox.findIndex(
      row => row.kind === 'shot.sync' && row.payload['id'] === shot!.id,
    );
    expect(sessionCreateIndex).toBeGreaterThanOrEqual(0);
    expect(shotSyncIndex).toBeGreaterThan(sessionCreateIndex);

    // 3. No scored shot references a sessionId without a local_session row.
    for (const row of activeDb.shots) {
      if (row.sessionId !== null) {
        expect(activeDb.sessions).toContain(row.sessionId);
      }
    }
    // The kv activity stamp names the set the shot belongs to.
    const stamp = activeDb.kv.get(`practice.set:${owner}`);
    expect(stamp).toBeDefined();
    expect(JSON.parse(stamp!).sessionId).toBe(shot!.sessionId);

    // A scored run is consumed by shot.sync — never explicitly finalized.
    expect(server.finalized).toHaveLength(0);
    // The unmounted screen never navigated.
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });
});
