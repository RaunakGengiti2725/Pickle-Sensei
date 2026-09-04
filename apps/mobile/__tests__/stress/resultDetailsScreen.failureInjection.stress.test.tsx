/**
 * STRESS · failure-injection · ResultDetailsScreen (unit scr-resultdetailsscreen)
 *
 * The full "Full breakdown" route is rendered inside a REAL React Navigation
 * container + native stack (the app's RootStackParams route names), with the
 * real evidence loader, repository, pose-sidecar verifier, api-session store,
 * training store + training API client and consistency store. Only the native
 * boundaries are replaced by controllable fakes:
 *   - `@op-engineering/op-sqlite`  (SQLite)             → seam-routed fake
 *   - `NativeModules.PickleVideoCapture.readTextFile`   → sidecar reader fake
 *   - `globalThis.fetch`           (training API)       → endpoint-routed fake
 *   - `Linking.canOpenURL/openURL`                      → per-scenario stub
 *   - react-native-keychain / react-native-purchases / PickleAudioCoach (TTS) /
 *     the rest of PickleVideoCapture (camera, Vision, permissions) → recording
 *     tripwires: the route must never touch them; any access is reported.
 *
 * Every catalog fault is injected at least once (deterministic sweep, seed =
 * catalog index) and then STRESS_ITER seeded random combinations of 1–3 faults
 * run on top (default 12). Each iteration is replayable from its seed:
 *   STRESS_SEED=<n> npx jest --ci __tests__/stress/resultDetailsScreen.failureInjection
 * STRESS_REPORT=<path.json> writes the seed → outcome table.
 *
 * Invariants asserted per iteration (after settling and advancing fake timers
 * 60 s): no crash (an error boundary catching = crash), no spinner still
 * visible, a visible back / retry control, the back control really pops the
 * stack, no fake success (a faulted dependency never presents as verified), no
 * writes to persisted state, no unhandled rejection, no tripwire access.
 * Silent degradations (a fault fired but the rendered text equals the
 * fault-free control render) are recorded per iteration as `silent`.
 */

const mockSqlite = {
  openThrows: false,
  migrateThrows: false,
  openCount: 0,
  execute: null as
    null | ((sql: string, params: unknown[]) => Promise<{ rows: unknown }>),
  writes: [] as string[],
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    mockSqlite.openCount += 1;
    if (mockSqlite.openThrows) throw new Error('SQLITE_CANTOPEN');
    return {
      executeSync: (sql: string) => {
        if (mockSqlite.migrateThrows) throw new Error('SQLITE_CORRUPT');
        if (sql.startsWith('PRAGMA table_info')) {
          return {
            rows: [
              { name: 'owner_key', pk: 1 },
              { name: 'id', pk: 2 },
              { name: 'payload', pk: 0 },
              { name: 'declared_stroke', pk: 0 },
              { name: 'target_seed', pk: 0 },
              { name: 'training_consent', pk: 0 },
            ],
          };
        }
        return { rows: [] };
      },
      execute: (sql: string, params: unknown[]) => {
        if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
          mockSqlite.writes.push(sql.trim().slice(0, 60));
          return Promise.resolve({ rows: [] });
        }
        if (!mockSqlite.execute) return Promise.resolve({ rows: [] });
        return mockSqlite.execute(sql, params);
      },
      close: () => {},
    };
  },
}));

const mockNative = {
  readTextFile: null as null | ((uri: string) => Promise<string>),
  readTextFileAbsent: false,
  tripped: [] as string[],
};

function mockRecordingProxy(name: string): unknown {
  const target = function () {} as unknown as Record<string, unknown>;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === '__esModule') return false;
      if (prop === 'then' || prop === 'default') return undefined;
      mockNative.tripped.push(`${name}.${String(prop)}`);
      return mockRecordingProxy(`${name}.${String(prop)}`);
    },
    apply() {
      mockNative.tripped.push(`${name}()`);
      return undefined;
    },
  });
}

jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  const camera: Record<string, unknown> = {};
  Object.defineProperty(camera, 'readTextFile', {
    enumerable: true,
    get: () => {
      if (mockNative.readTextFileAbsent) return undefined;
      return (uri: string) => {
        if (!mockNative.readTextFile) {
          return Promise.reject(new Error('readTextFile unconfigured'));
        }
        return mockNative.readTextFile(uri);
      };
    },
  });
  for (const method of [
    'capture',
    'cancel',
    'requestCameraPermission',
    'checkCameraPermission',
    'extractPose',
    'analyzeClip',
    'addListener',
    'removeListeners',
  ]) {
    Object.defineProperty(camera, method, {
      enumerable: true,
      get: () => {
        mockNative.tripped.push(`PickleVideoCapture.${method}`);
        return () => undefined;
      },
    });
  }
  RN.NativeModules.PickleVideoCapture = camera;
  RN.NativeModules.PickleAudioCoach = mockRecordingProxy('PickleAudioCoach');
  return RN;
});
jest.mock('react-native-keychain', () =>
  mockRecordingProxy('react-native-keychain'),
);
jest.mock('react-native-purchases', () =>
  mockRecordingProxy('react-native-purchases'),
);
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import { Linking, Text, View } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  CommonActions,
  NavigationContainer,
  createNavigationContainerRef,
  type NavigationState,
  type PartialState,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';
import type { RootStackParams } from '../../src/navigation/params';
import {
  clearApiSession,
  bearerTokenFor,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import { createTrainingApi } from '../../src/training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import { clearTryAgainHandoff } from '../../src/screens/tryAgainHandoff';
import type { CapturedClip } from '../../src/camera/capture';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';

// ─── Seeded RNG (mulberry32) ────────────────────────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)]!;
    },
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const OWNER = '11111111-1111-4111-8111-111111111111';
const ANALYSIS_ID = 'aaaaaaaa-1111-4111-8111-000000000001';
const PREVIOUS_ID = 'aaaaaaaa-1111-4111-8111-000000000000';
const CAPTURE_ID = 'capture-1';
const API_BASE = 'https://api.stress.test';
const PROD_API_HOST = 'ucqnaiwqwjtgvlduiuib.supabase.co';

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
  };
}

const scoredAnalysis: ShotAnalysis = {
  id: ANALYSIS_ID,
  sessionId: 'set-1',
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-09-01T10:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
  phases: [
    phase('ready', 0, 900),
    phase('prepare', 900, 1500),
    phase('accelerate', 1500, 1900),
    phase('contact', 1880, 1920, 1900),
    phase('follow_through', 1920, 2400),
    phase('recover', 2400, 3200),
  ],
  measurements: [],
  checkpoints: [
    checkpoint('ready_position', 85, 'green', 'none'),
    checkpoint('athletic_base', 72, 'yellow', 'narrow'),
    checkpoint('preparation', 88, 'green', 'none'),
    checkpoint('paddle_set', 90, 'green', 'none'),
    checkpoint('swing_length', null, 'unscored', 'none'),
    checkpoint('sequencing', 82, 'green', 'none'),
    checkpoint('paddle_path', 61, 'red', 'low'),
    checkpoint('contact_position', 48, 'red', 'late'),
    checkpoint('face_wrist_stability', 30, 'red', 'unstable', {
      applicable: false,
    }),
    checkpoint('follow_through', 80, 'green', 'short'),
    checkpoint('recovery', 92, 'green', 'none'),
  ],
  overallScore: 7.1,
  analysisConfidence: 0.84,
  resultKind: 'scored',
  guidance: null,
  priorityFix: {
    checkpoint: 'contact_position',
    reasonKey: 'lowest_score',
    severity: 0.52,
    confidence: 0.8,
  },
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'on-device-fusion-1',
    poseModelVersion: 'apple-vision-bodypose-1',
    paddleModelVersion: 'none',
    strokeDetectorVersion: 'temporal-stroke-heuristic-2',
    phaseModelVersion: 'phase-geometry-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};

const declaredRecord: StrokeResultEvidenceRecord = {
  id: ANALYSIS_ID,
  captureId: CAPTURE_ID,
  strokeIntent: {
    declaredStroke: 'forehand_drive',
    predictedStroke: null,
    resolutionBasis: 'declared',
    resolvedProfileId: 'FOREHAND_DRIVE',
    resolvedProfileVersion: 'technique-profile-v1',
    disagreement: null,
  },
  result: null,
  uncertainty: {
    analysisConfidence: 0.84,
    presentation: 'normal',
    limitingFactors: [
      'paddle_track_unavailable',
      'ball_track_unavailable',
      'court_geometry_unavailable',
    ],
  },
};

const swing = generateSwingSequence();
const SIDECAR_JSON = serializePoseSequence(swing.sequence);
const SIDECAR_URI = 'file:///captures/clip.pose.json';

const captureClip: CapturedClip = {
  uri: 'file:///private/captures/real.mov',
  durationMs: 3900,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-09-01T10:00:00.000Z',
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger: {
    startMs: 1800,
    endMs: 2450,
    peakMotionMs: 2220,
    confidence: 0.84,
    source: 'temporal_pose_motion',
    modelVersion: 'temporal-stroke-heuristic-2',
  },
  captureEvidence: {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'mediapipe_pose_landmarker',
    poseModelVersion: 'mediapipe-pose-landmarker-full-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    analysisInputFrameCount: 8,
    poseFrameCount: 7,
    poseMissingFrameCount: 1,
    trackedDurationMs: 600,
    meanCanonicalJointVisibility: 0.86,
    meanJointCoverage: 0.93,
    minimumJointCoverage: 0.83,
    fullBodyVisibleFrameCount: 5,
    jointMotion: [
      {
        joint: 'left_wrist',
        sampleCount: 6,
        meanNormalizedPerSecond: 1.2,
        peakNormalizedPerSecond: 2.1,
      },
    ],
  },
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 1800,
  postRollMs: 1450,
  poseSequence: {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: SIDECAR_URI,
    frameCount: swing.sequence.frames.length,
    sha256: sha256Hex(SIDECAR_JSON),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
  },
};

function captureRow(payload: string | null = JSON.stringify(captureClip)) {
  return {
    id: CAPTURE_ID,
    uri: captureClip.uri,
    shot_type: 'forehand_drive',
    declared_stroke: 'forehand_drive',
    captured_at: captureClip.capturedAtIso,
    duration_ms: captureClip.durationMs,
    fps: captureClip.fps,
    width: captureClip.width,
    height: captureClip.height,
    payload,
  };
}

function shotListRows() {
  return [
    {
      id: ANALYSIS_ID,
      session_id: 'set-1',
      shot_type: 'forehand_drive',
      captured_at: '2026-09-01T10:00:00.000Z',
      overall_score: 7.1,
      confidence: 0.84,
      result_kind: 'scored',
      source: 'real',
      favorite: 0,
    },
    {
      id: PREVIOUS_ID,
      session_id: 'set-1',
      shot_type: 'forehand_drive',
      captured_at: '2026-09-01T09:55:00.000Z',
      overall_score: 6.4,
      confidence: 0.8,
      result_kind: 'scored',
      source: 'real',
      favorite: 0,
    },
  ];
}

const DRILL_SLUG = 'contact-shadow';

function planPayload(kind: 'thisRead' | 'otherActive' | 'completedByThisRead') {
  return {
    id: '78a7815a-176a-4487-a736-66eb2cc04455',
    status: kind === 'completedByThisRead' ? 'completed' : 'active',
    algorithmVersion: 'reviewed-plan-v1',
    sourceShotId:
      kind === 'otherActive'
        ? 'b8aece05-d9dc-49eb-af98-54fe0b6e8db7'
        : ANALYSIS_ID,
    shotType: 'forehand_drive',
    priorityCheckpoint: 'contact_position',
    priorityDirection: 'late',
    baselineScore: 7.4,
    baselineCheckpointScore: 58,
    reassessmentShotId: kind === 'completedByThisRead' ? ANALYSIS_ID : null,
    scoreDelta: kind === 'completedByThisRead' ? 0.6 : null,
    createdAt: '2026-08-27T18:00:00.000Z',
    completedAt:
      kind === 'completedByThisRead' ? '2026-09-01T10:00:00.000Z' : null,
    items: [
      {
        id: 'd32bb05c-d72c-42dd-8075-3af93a63e700',
        position: 1,
        kind: 'targeted',
        drill: {
          slug: DRILL_SLUG,
          title: 'Contact Shadow Reps',
          description: 'A coach-reviewed contact prescription.',
          coachName: 'Coach Rivera',
          equipment: ['paddle'],
          saved: false,
        },
        cueText: 'Meet the ball comfortably in front.',
        targetSets: 3,
        targetRepetitionsPerSet: 8,
        targetDurationSeconds: null,
        restSeconds: 20,
        completion: null,
      },
      {
        id: '391b4bf2-c9d6-45bb-b471-250651e4e226',
        position: 4,
        kind: 'reassessment',
        drill: null,
        cueText: null,
        targetSets: null,
        targetRepetitionsPerSet: null,
        targetDurationSeconds: null,
        restSeconds: null,
        completion: null,
      },
    ],
  };
}

function drillDetailPayload() {
  return {
    drill: {
      id: '80184be3-3e97-4eaf-8d8e-55fa214fe6de',
      slug: DRILL_SLUG,
      title: 'Contact Shadow Reps',
      description: 'A coach-reviewed contact prescription.',
      coach_name: 'Coach Rivera',
      equipment: ['paddle'],
      difficulty_min: '2.5',
      difficulty_max: '4.5',
      saved: false,
    },
    mappings: [
      {
        checkpoint: 'contact_position',
        shot_type: 'forehand_drive',
        plan_role: 'targeted',
        fault_directions: ['late'],
        cue_text: 'Meet the ball comfortably in front.',
        target_sets: 3,
        target_repetitions_per_set: 8,
        target_duration_seconds: null,
        rest_seconds: 20,
      },
    ],
    instructionalMedia: [
      {
        id: '4ecbd9d8-c2d6-4663-8561-3dbf81961a64',
        kind: 'embed',
        provider: 'youtube',
        videoId: 'abcDEF12345',
        embedUrl: 'https://www.youtube-nocookie.com/embed/abcDEF12345',
        sourceUrl: 'https://www.youtube.com/watch?v=abcDEF12345',
        creatorName: 'Coach Rivera',
        licenseName: 'Published with permission',
        licenseUrl: null,
        attribution: 'Coach Rivera instructional video',
      },
    ],
  };
}

function completionPayload() {
  return {
    completion: {
      id: '0b8f0d8e-6b2f-4f9a-9d3f-6a5f4e3d2c1b',
      planItemId: 'd32bb05c-d72c-42dd-8075-3af93a63e700',
      drillSlug: DRILL_SLUG,
      completedAt: '2026-09-01T11:00:00.000Z',
      sets: 3,
      repetitionsPerSet: 8,
      durationSeconds: null,
    },
  };
}

// ─── Scenario model ─────────────────────────────────────────────────────────

type SqlSeam =
  'shot.get' | 'shot.list' | 'record' | 'capture' | 'receipt' | 'outbox';
type FetchSeam = 'plan' | 'drill' | 'create' | 'completion';

type Evidence = 'scored' | 'recordOnly' | 'shotOnly' | 'missing';
type Sync = 'receipt' | 'queued' | 'rejected' | 'exhausted' | 'absent';
type Session = 'signedIn' | 'signedOut';
type PlanServer = 'none' | 'thisRead' | 'otherActive' | 'completedByThisRead';

interface Profile {
  evidence: Evidence;
  sync: Sync;
  session: Session;
  planServer: PlanServer;
}

type Interaction =
  | 'none'
  | 'buildPlan'
  | 'completeItem'
  | 'watchMedia'
  | 'doubleBack'
  | 'setParamsMidLoad'
  | 'popMidLoad'
  | 'trainingRetry';

interface Fault {
  id: string;
  dep:
    | 'sqlite'
    | 'fs'
    | 'vision'
    | 'fetch'
    | 'session'
    | 'clock'
    | 'nav'
    | 'linking';
  /** Forced profile fields so the fault is actually on the path. */
  requires?: Partial<Profile>;
  interaction?: Interaction;
  /** Seams a user-visible message is expected for when the fault fires. */
  userVisibleSeam?: boolean;
  /** Ends in a state where the fault is a legitimate "no data" success. */
  legitimateSuccess?: boolean;
}

type SqlMode =
  | 'reject'
  | 'throw'
  | 'never'
  | 'slow5s'
  | 'slow30s'
  | 'malformed'
  | 'partial'
  | 'wrongtypes'
  | 'empty'
  | 'nullrows'
  | 'jitter';

type FetchMode =
  | 'reject'
  | 'throw'
  | 'never'
  | 'slow5s'
  | 'slow45s'
  | 'http500'
  | 'http429'
  | 'http401'
  | 'http404'
  | 'html'
  | 'http204'
  | 'malformedJson'
  | 'partial'
  | 'wrongtypes'
  | 'nullPlan'
  | 'jsonNever'
  | 'jsonSlow';

type FsMode =
  | 'reject'
  | 'throw'
  | 'never'
  | 'slow5s'
  | 'malformedJson'
  | 'truncated'
  | 'hashMismatch'
  | 'wrongSchema'
  | 'empty'
  | 'absent'
  | 'nonString'
  | 'nanLandmarks'
  | 'zeroFrames'
  | 'outOfOrder';

const SQL_SEAMS: SqlSeam[] = [
  'shot.get',
  'shot.list',
  'record',
  'capture',
  'receipt',
  'outbox',
];
const SQL_MODES: SqlMode[] = [
  'reject',
  'throw',
  'never',
  'slow5s',
  'slow30s',
  'malformed',
  'partial',
  'wrongtypes',
  'empty',
  'nullrows',
];
const FETCH_MODES: FetchMode[] = [
  'reject',
  'throw',
  'never',
  'slow5s',
  'slow45s',
  'http500',
  'http429',
  'http401',
  'http404',
  'html',
  'http204',
  'malformedJson',
  'partial',
  'wrongtypes',
  'nullPlan',
  'jsonNever',
  'jsonSlow',
];
const FS_MODES: FsMode[] = [
  'reject',
  'throw',
  'never',
  'slow5s',
  'malformedJson',
  'truncated',
  'hashMismatch',
  'wrongSchema',
  'empty',
  'absent',
  'nonString',
  'nanLandmarks',
  'zeroFrames',
  'outOfOrder',
];

function buildCatalog(): Fault[] {
  const faults: Fault[] = [];
  faults.push({
    id: 'sqlite.open.throw',
    dep: 'sqlite',
    userVisibleSeam: true,
  });
  faults.push({
    id: 'sqlite.migrate.throw',
    dep: 'sqlite',
    userVisibleSeam: true,
  });
  const timingOnly = (mode: string) =>
    /^(slow5s|slow30s|slow45s|jitter|jsonSlow)$/.test(mode);
  const corruptRow = (mode: string) =>
    /^(malformed|partial|wrongtypes)$/.test(mode);
  for (const seam of SQL_SEAMS) {
    for (const mode of SQL_MODES) {
      // A receipt is `SELECT 1` and the attempt list is only chips: a corrupt
      // row shape is not a meaningful fault there beyond wrong column types.
      if (
        (seam === 'receipt' || seam === 'shot.list') &&
        (mode === 'malformed' || mode === 'partial')
      )
        continue;
      // `SELECT 1 … LIMIT 1`: any row IS a receipt, so column types cannot be wrong.
      if (seam === 'receipt' && mode === 'wrongtypes') continue;
      const requires: Partial<Profile> =
        seam === 'receipt'
          ? {
              evidence: 'scored',
              sync: 'receipt',
              session: 'signedIn',
              planServer: 'none',
            }
          : seam === 'outbox'
            ? {
                evidence: 'scored',
                sync: 'queued',
                session: 'signedIn',
                planServer: 'none',
              }
            : { evidence: 'scored' };
      // Seams with an explicit error surface: the analysis row (Result missing /
      // record-only), the sync receipt and outbox ("could not verify"). The
      // record, capture, attempts and sidecar degrade by design (no replay
      // card / no chips) and are recorded as observations, not violations.
      const explicitSurface =
        seam === 'shot.get' ||
        seam === 'receipt' ||
        (seam === 'outbox' && !corruptRow(mode));
      faults.push({
        id: `sqlite.${seam}.${mode}`,
        dep: 'sqlite',
        requires,
        userVisibleSeam: explicitSurface,
        legitimateSuccess:
          mode === 'empty' || mode === 'nullrows' || timingOnly(mode),
      });
    }
  }
  faults.push({
    id: 'sqlite.all.reject',
    dep: 'sqlite',
    requires: { evidence: 'scored' },
    userVisibleSeam: true,
  });
  faults.push({
    id: 'sqlite.all.never',
    dep: 'sqlite',
    requires: { evidence: 'scored' },
    userVisibleSeam: true,
  });
  faults.push({
    id: 'sqlite.all.slow5s',
    dep: 'sqlite',
    requires: { evidence: 'scored' },
    legitimateSuccess: true,
  });
  faults.push({
    id: 'sqlite.all.jitter',
    dep: 'sqlite',
    requires: { evidence: 'scored' },
    legitimateSuccess: true,
  });
  for (const mode of FS_MODES) {
    faults.push({
      id: `fs.sidecar.${mode}`,
      dep:
        mode === 'nanLandmarks' ||
        mode === 'zeroFrames' ||
        mode === 'outOfOrder' ||
        mode === 'wrongSchema'
          ? 'vision'
          : 'fs',
      requires: { evidence: 'scored' },
      legitimateSuccess: timingOnly(mode),
    });
  }
  for (const mode of FETCH_MODES) {
    faults.push({
      id: `fetch.plan.${mode}`,
      dep: 'fetch',
      requires: { session: 'signedIn', evidence: 'scored' },
      userVisibleSeam: true,
      legitimateSuccess: mode === 'nullPlan' || timingOnly(mode),
    });
  }
  for (const mode of [
    'reject',
    'never',
    'slow5s',
    'http404',
    'http500',
    'malformedJson',
    'partial',
    'jsonNever',
  ] as FetchMode[]) {
    faults.push({
      id: `fetch.drill.${mode}`,
      dep: 'fetch',
      requires: {
        session: 'signedIn',
        evidence: 'scored',
        planServer: 'thisRead',
      },
      legitimateSuccess: timingOnly(mode),
    });
  }
  for (const mode of [
    'reject',
    'throw',
    'never',
    'slow5s',
    'http500',
    'http429',
    'http401',
    'malformedJson',
    'partial',
    'http204',
    'jsonNever',
  ] as FetchMode[]) {
    faults.push({
      id: `fetch.create.${mode}`,
      dep: 'fetch',
      requires: {
        session: 'signedIn',
        evidence: 'scored',
        sync: 'receipt',
        planServer: 'none',
      },
      interaction: 'buildPlan',
      userVisibleSeam: true,
      legitimateSuccess: timingOnly(mode),
    });
  }
  for (const mode of [
    'reject',
    'never',
    'http500',
    'malformedJson',
    'partial',
  ] as FetchMode[]) {
    faults.push({
      id: `fetch.completion.${mode}`,
      dep: 'fetch',
      requires: {
        session: 'signedIn',
        evidence: 'scored',
        sync: 'receipt',
        planServer: 'thisRead',
      },
      interaction: 'completeItem',
      userVisibleSeam: true,
    });
  }
  faults.push({
    id: 'fetch.all.reject',
    dep: 'fetch',
    requires: { session: 'signedIn', evidence: 'scored' },
    userVisibleSeam: true,
  });
  faults.push({
    id: 'fetch.all.never',
    dep: 'fetch',
    requires: { session: 'signedIn', evidence: 'scored' },
    userVisibleSeam: true,
  });
  faults.push({
    id: 'fetch.plan.retryAfterFailure',
    dep: 'fetch',
    requires: { session: 'signedIn', evidence: 'scored' },
    interaction: 'trainingRetry',
    userVisibleSeam: true,
    legitimateSuccess: true,
  });
  faults.push({
    id: 'session.absent',
    dep: 'session',
    requires: { evidence: 'scored' },
    userVisibleSeam: true,
    legitimateSuccess: true,
  });
  faults.push({
    id: 'session.tokenNullMidFlight',
    dep: 'session',
    requires: { session: 'signedIn', evidence: 'scored' },
    userVisibleSeam: true,
  });
  faults.push({
    id: 'session.otherAccount',
    dep: 'session',
    requires: { session: 'signedIn', evidence: 'scored' },
    userVisibleSeam: true,
  });
  faults.push({
    id: 'session.rotatedMidFlight',
    dep: 'session',
    requires: { session: 'signedIn', evidence: 'scored' },
    legitimateSuccess: true,
  });
  faults.push({
    id: 'session.clearedMidFlight',
    dep: 'session',
    requires: { session: 'signedIn', evidence: 'scored' },
    userVisibleSeam: true,
  });
  faults.push({
    id: 'clock.nowFarFuture',
    dep: 'clock',
    requires: { evidence: 'scored' },
    legitimateSuccess: true,
  });
  faults.push({
    id: 'clock.nowFarPast',
    dep: 'clock',
    requires: { evidence: 'scored' },
    legitimateSuccess: true,
  });
  faults.push({
    id: 'clock.capturedAtInvalid',
    dep: 'clock',
    requires: { evidence: 'scored' },
  });
  faults.push({
    id: 'clock.planCreatedAtInvalid',
    dep: 'clock',
    requires: {
      session: 'signedIn',
      evidence: 'scored',
      planServer: 'thisRead',
    },
    userVisibleSeam: true,
  });
  faults.push({
    id: 'clock.attemptCapturedAtInvalid',
    dep: 'clock',
    requires: { evidence: 'scored' },
  });
  faults.push({ id: 'nav.paramsMissing', dep: 'nav', userVisibleSeam: true });
  faults.push({ id: 'nav.analysisIdEmpty', dep: 'nav', userVisibleSeam: true });
  faults.push({
    id: 'nav.analysisIdNumber',
    dep: 'nav',
    userVisibleSeam: true,
  });
  faults.push({ id: 'nav.analysisIdHuge', dep: 'nav', userVisibleSeam: true });
  faults.push({
    id: 'nav.analysisIdSqlText',
    dep: 'nav',
    userVisibleSeam: true,
  });
  faults.push({
    id: 'nav.noPreviousRoute',
    dep: 'nav',
    requires: { evidence: 'missing' },
  });
  faults.push({
    id: 'nav.doubleBack',
    dep: 'nav',
    requires: { evidence: 'scored' },
    interaction: 'doubleBack',
  });
  faults.push({
    id: 'nav.setParamsMidLoad',
    dep: 'nav',
    requires: { evidence: 'scored' },
    interaction: 'setParamsMidLoad',
  });
  faults.push({
    id: 'nav.popMidLoad',
    dep: 'nav',
    requires: { evidence: 'scored' },
    interaction: 'popMidLoad',
  });
  for (const mode of [
    'canOpenFalse',
    'canOpenReject',
    'openReject',
    'never',
    'throw',
  ]) {
    faults.push({
      id: `linking.${mode}`,
      dep: 'linking',
      requires: {
        session: 'signedIn',
        evidence: 'scored',
        sync: 'receipt',
        planServer: 'thisRead',
      },
      interaction: 'watchMedia',
      userVisibleSeam: true,
    });
  }
  return faults;
}

const CATALOG = buildCatalog();

interface Scenario {
  seed: number;
  kind: 'sweep' | 'combo' | 'control';
  profile: Profile;
  faults: Fault[];
  interaction: Interaction;
}

const EVIDENCE: Evidence[] = ['scored', 'recordOnly', 'shotOnly', 'missing'];
const SYNCS: Sync[] = ['receipt', 'queued', 'rejected', 'exhausted', 'absent'];
const SESSIONS: Session[] = ['signedIn', 'signedOut'];
const PLANS: PlanServer[] = [
  'none',
  'thisRead',
  'otherActive',
  'completedByThisRead',
];

function scenarioFor(seed: number, kind: 'sweep' | 'combo'): Scenario {
  const r = rng(seed);
  const faults: Fault[] = [];
  if (kind === 'sweep') {
    faults.push(CATALOG[seed % CATALOG.length]!);
  } else {
    const wanted = 1 + r.int(3);
    for (let i = 0; i < wanted; i += 1) {
      const fault = r.pick(CATALOG);
      if (faults.some(f => f.id === fault.id)) continue;
      // One interaction and one navigation-params fault per iteration.
      if (fault.interaction && faults.some(f => f.interaction)) continue;
      if (fault.dep === 'nav' && faults.some(f => f.dep === 'nav')) continue;
      faults.push(fault);
    }
  }
  const profile: Profile = {
    evidence: r.pick(EVIDENCE),
    sync: r.pick(SYNCS),
    session: r.pick(SESSIONS),
    planServer: r.pick(PLANS),
  };
  for (const fault of faults) Object.assign(profile, fault.requires);
  const interaction = faults.find(f => f.interaction)?.interaction ?? 'none';
  return { seed, kind, profile, faults, interaction };
}

// ─── Fault controller ───────────────────────────────────────────────────────

const timer = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => {});

interface Fired {
  seam: string;
  mode: string;
}

class Controller {
  fired: Fired[] = [];
  fetchCalls: string[] = [];
  sql: Partial<Record<SqlSeam | 'all', SqlMode>> = {};
  fetch: Partial<Record<FetchSeam | 'all', FetchMode>> = {};
  fs: FsMode | null = null;
  linking: string | null = null;
  clock: string | null = null;
  session: string | null = null;
  planCreatedAtInvalid = false;
  attemptCapturedAtInvalid = false;
  capturedAtInvalid = false;
  profile!: Profile;
  requestIndex = 0;
  seedRng = rng(1);

  install(scenario: Scenario) {
    this.profile = scenario.profile;
    this.seedRng = rng(scenario.seed ^ 0x9e3779b9);
    for (const fault of scenario.faults) {
      const [dep, seam, mode] = fault.id.split('.') as [string, string, string];
      // Structural faults are in force from the first render by construction.
      if (
        dep === 'nav' ||
        dep === 'clock' ||
        seam === 'open' ||
        seam === 'migrate' ||
        fault.id === 'session.absent' ||
        fault.id === 'fs.sidecar.absent'
      ) {
        this.fire(`${dep}.${seam}`, mode ?? 'installed');
      }
      if (dep === 'sqlite') {
        if (seam === 'open') mockSqlite.openThrows = true;
        else if (seam === 'migrate') mockSqlite.migrateThrows = true;
        else if (seam === 'shot') {
          // ids are `sqlite.shot.get.<mode>` / `sqlite.shot.list.<mode>`
          const [, , sub, m] = fault.id.split('.') as [
            string,
            string,
            string,
            string,
          ];
          this.sql[`shot.${sub}` as SqlSeam] = m as SqlMode;
        } else this.sql[seam as SqlSeam | 'all'] = mode as SqlMode;
      } else if (dep === 'fs') this.fs = mode as FsMode;
      else if (dep === 'fetch')
        this.fetch[seam as FetchSeam | 'all'] = mode as FetchMode;
      else if (dep === 'session') this.session = seam;
      else if (dep === 'clock') {
        if (seam === 'capturedAtInvalid') this.capturedAtInvalid = true;
        else if (seam === 'planCreatedAtInvalid')
          this.planCreatedAtInvalid = true;
        else if (seam === 'attemptCapturedAtInvalid')
          this.attemptCapturedAtInvalid = true;
        else this.clock = seam;
      } else if (dep === 'linking') this.linking = seam;
    }
  }

  fire(seam: string, mode: string) {
    this.fired.push({ seam, mode });
  }

  // ── SQLite ──
  private rowsFor(seam: SqlSeam): Record<string, unknown>[] {
    const { evidence, sync } = this.profile;
    const analysis = this.capturedAtInvalid
      ? { ...scoredAnalysis, capturedAtIso: 'not-a-date' }
      : scoredAnalysis;
    switch (seam) {
      case 'shot.get':
        return evidence === 'scored' || evidence === 'shotOnly'
          ? [{ payload: JSON.stringify(analysis) }]
          : [];
      case 'shot.list': {
        if (evidence === 'missing' || evidence === 'recordOnly') return [];
        const rows = shotListRows();
        if (this.attemptCapturedAtInvalid)
          rows[1]!.captured_at = 'garbage-date';
        return rows;
      }
      case 'record':
        return evidence === 'scored' || evidence === 'recordOnly'
          ? [{ record: JSON.stringify(declaredRecord) }]
          : [];
      case 'capture':
        return evidence === 'scored' || evidence === 'recordOnly'
          ? [captureRow()]
          : [];
      case 'receipt':
        return sync === 'receipt' ? [{ '1': 1 }] : [];
      case 'outbox':
        return sync === 'queued'
          ? [{ attempts: 0, last_error: null }]
          : sync === 'rejected'
            ? [{ attempts: 2, last_error: 'shot.invalid_pose_evidence' }]
            : sync === 'exhausted'
              ? [{ attempts: 8, last_error: 'shot.rejected' }]
              : [];
    }
  }

  private corruptRows(seam: SqlSeam, mode: SqlMode): unknown {
    const rows = this.rowsFor(seam);
    switch (mode) {
      case 'empty':
        return [];
      case 'nullrows':
        return null;
      case 'malformed':
        if (seam === 'shot.get')
          return [{ payload: '{"id":"' + ANALYSIS_ID + '", "checkpoints": [' }];
        if (seam === 'record') return [{ record: 'not json at all' }];
        if (seam === 'capture') return [captureRow('{oops')];
        if (seam === 'outbox') return [{ attempts: 'many', last_error: 42 }];
        return rows;
      case 'partial':
        if (seam === 'shot.get') {
          return [
            {
              payload: JSON.stringify({
                id: ANALYSIS_ID,
                sessionId: 'set-1',
                shotType: 'forehand_drive',
                resultKind: 'scored',
                overallScore: 7.1,
                source: 'real',
                capturedAtIso: scoredAnalysis.capturedAtIso,
              }),
            },
          ];
        }
        if (seam === 'record')
          return [{ record: JSON.stringify({ id: ANALYSIS_ID }) }];
        if (seam === 'capture') {
          const { payload, uri, ...rest } = captureRow();
          void payload;
          return [
            {
              ...rest,
              uri,
              payload: JSON.stringify({
                ...captureClip,
                poseSequence: { uri: SIDECAR_URI },
              }),
            },
          ];
        }
        if (seam === 'outbox') return [{}];
        return rows;
      case 'wrongtypes':
        if (seam === 'shot.get') {
          return [
            {
              payload: JSON.stringify({
                ...scoredAnalysis,
                overallScore: 'seven',
                checkpoints: 'none',
                phases: null,
                timestamps: { startMs: 'a', contactMs: null, endMs: undefined },
              }),
            },
          ];
        }
        if (seam === 'record')
          return [
            {
              record: JSON.stringify({
                ...declaredRecord,
                captureId: 12,
                uncertainty: 'high',
              }),
            },
          ];
        if (seam === 'capture')
          return [
            {
              ...captureRow(),
              duration_ms: 'abc',
              width: null,
              height: 'tall',
              fps: undefined,
            },
          ];
        if (seam === 'receipt') return [{ '1': 'yes' }];
        if (seam === 'shot.list')
          return [
            {
              id: null,
              session_id: 'set-1',
              captured_at: 12,
              overall_score: 'x',
              confidence: null,
            },
          ];
        if (seam === 'outbox') return [{ attempts: -1, last_error: '' }];
        return rows;
      default:
        return rows;
    }
  }

  async execute(sql: string, params: unknown[]): Promise<{ rows: unknown }> {
    const seam: SqlSeam | null = /FROM local_shot/.test(sql)
      ? /SELECT payload/.test(sql)
        ? 'shot.get'
        : 'shot.list'
      : /FROM local_analysis_record/.test(sql)
        ? 'record'
        : /FROM local_capture/.test(sql)
          ? 'capture'
          : /FROM sync_receipt/.test(sql)
            ? 'receipt'
            : /FROM outbox/.test(sql)
              ? 'outbox'
              : null;
    if (!seam) return { rows: [] };
    // Honour the id predicate like SQLite would: an unknown analysis / capture id has no rows.
    const keyed = seam === 'capture' ? CAPTURE_ID : ANALYSIS_ID;
    if (seam !== 'shot.list' && !params.includes(keyed)) {
      this.fire(`sqlite.${seam}`, 'noRowForParam');
      return { rows: [] };
    }
    const mode = this.sql[seam] ?? this.sql.all;
    if (!mode) return { rows: this.rowsFor(seam) };
    this.fire(`sqlite.${seam}`, mode);
    switch (mode) {
      case 'reject':
        throw new Error(`SQLITE_IOERR on ${seam}`);
      case 'throw':
        throw new TypeError(`native bridge threw on ${seam}`);
      case 'never':
        return never();
      case 'slow5s':
        await timer(5_000);
        return { rows: this.rowsFor(seam) };
      case 'slow30s':
        await timer(30_000);
        return { rows: this.rowsFor(seam) };
      case 'jitter':
        await timer(this.seedRng.int(3_000));
        return { rows: this.rowsFor(seam) };
      default:
        return { rows: this.corruptRows(seam, mode) };
    }
  }

  // ── Filesystem / Vision sidecar ──
  async readTextFile(): Promise<string> {
    const mode = this.fs;
    if (!mode) return SIDECAR_JSON;
    this.fire('fs.sidecar', mode);
    switch (mode) {
      case 'reject':
        throw new Error('ENOENT');
      case 'throw':
        throw new TypeError('native read threw synchronously');
      case 'never':
        return never();
      case 'slow5s':
        await timer(5_000);
        return SIDECAR_JSON;
      case 'malformedJson':
        return '{"schemaVersion":1,"frames":[';
      case 'truncated':
        return SIDECAR_JSON.slice(0, Math.floor(SIDECAR_JSON.length / 2));
      case 'hashMismatch':
        return SIDECAR_JSON.replace('"frames"', '"frames" ');
      case 'wrongSchema':
        return JSON.stringify({
          ...JSON.parse(SIDECAR_JSON),
          schemaVersion: 99,
        });
      case 'empty':
        return '';
      case 'absent':
        return SIDECAR_JSON; // unreachable: readTextFile is undefined
      case 'nonString':
        return { not: 'a string' } as unknown as string;
      case 'nanLandmarks': {
        const doc = JSON.parse(SIDECAR_JSON) as {
          frames: { landmarks: { x: number; y: number }[] }[];
        };
        for (const frame of doc.frames)
          for (const lm of frame.landmarks) lm.x = Number.NaN;
        return JSON.stringify(doc);
      }
      case 'zeroFrames': {
        const doc = JSON.parse(SIDECAR_JSON) as { frames: unknown[] };
        doc.frames = [];
        return JSON.stringify(doc);
      }
      case 'outOfOrder': {
        const doc = JSON.parse(SIDECAR_JSON) as { frames: unknown[] };
        doc.frames.reverse();
        return JSON.stringify(doc);
      }
    }
  }

  // ── fetch ──
  private response(
    status: number,
    payload: unknown,
    jsonMode: 'ok' | 'reject' | 'never' | 'slow' = 'ok',
  ): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => {
        if (jsonMode === 'reject')
          throw new SyntaxError('Unexpected token < in JSON');
        if (jsonMode === 'never') return never();
        if (jsonMode === 'slow') await timer(5_000);
        return payload;
      },
    } as unknown as Response;
  }

  private okPayloadFor(seam: FetchSeam): unknown {
    switch (seam) {
      case 'plan': {
        const plan =
          this.profile.planServer === 'none'
            ? null
            : planPayload(this.profile.planServer);
        if (plan && this.planCreatedAtInvalid) plan.createdAt = 'yesterday-ish';
        return { plan };
      }
      case 'drill':
        return drillDetailPayload();
      case 'create':
        return { plan: planPayload('thisRead') };
      case 'completion':
        return completionPayload();
    }
  }

  async fetchImpl(input: string, init?: RequestInit): Promise<Response> {
    const url = new URL(input);
    if (url.host === PROD_API_HOST) {
      this.fire('fetch.production', 'TRIPWIRE');
      throw new Error('production API must never be reached from a test');
    }
    const method = init?.method ?? 'GET';
    const seam: FetchSeam | null = url.pathname.endsWith(
      '/v1/training-plans/current',
    )
      ? 'plan'
      : url.pathname.includes('/v1/catalog/drills/')
        ? 'drill'
        : url.pathname.endsWith('/v1/training-plans') && method === 'POST'
          ? 'create'
          : url.pathname.endsWith('/v1/drill-completions')
            ? 'completion'
            : null;
    this.fetchCalls.push(`${method} ${url.pathname}`);
    this.requestIndex += 1;
    if (this.session === 'clearedMidFlight') {
      // The user signs out while this request is in flight (authStore.signOut
      // clears the api session AND the training configuration).
      this.fire('session', this.session);
      clearApiSession();
      clearTrainingStoreConfiguration();
    } else if (this.session === 'rotatedMidFlight') {
      this.fire('session', this.session);
      establishApiSession({
        apiBaseUrl: API_BASE,
        bearerToken: `rotated-${this.requestIndex}`,
        canonicalAppUserId: OWNER,
        provider: 'apple',
      });
    }
    if (!seam)
      return this.response(404, {
        error: { code: 'not_found', message: 'no route' },
      });
    let mode = this.fetch[seam] ?? this.fetch.all;
    if (
      seam === 'plan' &&
      this.fetch.plan === undefined &&
      this.fetch.all === undefined &&
      this.retryOnce > 0
    ) {
      mode = 'reject';
      this.retryOnce -= 1;
      this.fire('fetch.plan', 'rejectOnceThenRetry');
    }
    if (!mode) return this.response(200, this.okPayloadFor(seam));
    this.fire(`fetch.${seam}`, mode);
    switch (mode) {
      case 'reject':
        throw new TypeError('Network request failed');
      case 'throw':
        throw new Error('fetch threw synchronously');
      case 'never':
        return never();
      case 'slow5s':
        await timer(5_000);
        return this.response(200, this.okPayloadFor(seam));
      case 'slow45s':
        await timer(45_000);
        return this.response(200, this.okPayloadFor(seam));
      case 'http500':
        return this.response(500, {
          error: { code: 'internal', message: 'boom' },
        });
      case 'http429':
        return this.response(429, {
          error: { code: 'rate_limited', message: 'slow down' },
        });
      case 'http401':
        return this.response(401, {
          error: { code: 'unauthorized', message: 'expired' },
        });
      case 'http404':
        return this.response(404, {
          error: { code: 'not_found', message: 'gone' },
        });
      case 'html':
        return this.response(502, '<html>bad gateway</html>', 'reject');
      case 'http204':
        return this.response(204, null);
      case 'malformedJson':
        return this.response(200, null, 'reject');
      case 'jsonNever':
        return this.response(200, null, 'never');
      case 'jsonSlow':
        return this.response(200, this.okPayloadFor(seam), 'slow');
      case 'nullPlan':
        return this.response(200, { plan: null });
      case 'partial':
        if (seam === 'plan' || seam === 'create') {
          const plan = planPayload('thisRead') as Record<string, unknown>;
          delete plan['items'];
          delete plan['status'];
          return this.response(200, { plan });
        }
        if (seam === 'drill')
          return this.response(200, { drill: { slug: DRILL_SLUG } });
        return this.response(200, { completion: { id: 'x' } });
      case 'wrongtypes': {
        const plan = planPayload('thisRead') as Record<string, unknown>;
        plan['baselineScore'] = 'seven';
        plan['items'] = 'three drills';
        return this.response(200, { plan });
      }
    }
  }

  retryOnce = 0;
}

let controller = new Controller();

// ─── Navigator under test ───────────────────────────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function Stub({ name }: { name: string }) {
  return <View testID={`stub-${name}`} />;
}
const TabsStub = () => <Stub name="Tabs" />;
const AnalyzeStub = () => <Stub name="Analyze" />;
const ResultStub = () => <Stub name="Result" />;
const FormReviewStub = () => <Stub name="FormReview" />;
const DrillLibraryStub = () => <Stub name="DrillLibrary" />;

class HarnessBoundary extends React.Component<
  { children: React.ReactNode; onError: (error: unknown) => void },
  { caught: boolean }
> {
  state = { caught: false };
  static getDerivedStateFromError() {
    return { caught: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    // Mirrors App.tsx RootErrorBoundary's contract (INFERRED from App.tsx:70):
    // a caught render/effect throw replaces the WHOLE navigator with a retry.
    return this.state.caught ? (
      <Text>HARNESS_BOUNDARY_CAUGHT</Text>
    ) : (
      this.props.children
    );
  }
}

function initialStateFor(
  params: unknown,
  single: boolean,
): PartialState<NavigationState> {
  // Deliberately loose: the fault catalog feeds null / number / missing params.
  const details = {
    name: 'ResultDetails',
    ...(params === undefined ? {} : { params }),
  } as PartialState<NavigationState>['routes'][number];
  return single
    ? { index: 0, routes: [details] }
    : {
        index: 2,
        routes: [
          { name: 'Tabs' },
          { name: 'Result', params: { analysisId: ANALYSIS_ID } },
          details,
        ],
      };
}

function Harness(props: {
  params: unknown;
  single: boolean;
  onError: (e: unknown) => void;
}) {
  return (
    <HarnessBoundary onError={props.onError}>
      <NavigationContainer
        ref={navigationRef}
        initialState={initialStateFor(props.params, props.single)}
      >
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Tabs" component={TabsStub} />
          <Stack.Screen name="Analyze" component={AnalyzeStub} />
          <Stack.Screen name="Result" component={ResultStub} />
          <Stack.Screen name="ResultDetails" component={ResultDetailsScreen} />
          <Stack.Screen name="FormReview" component={FormReviewStub} />
          <Stack.Screen name="DrillLibrary" component={DrillLibraryStub} />
        </Stack.Navigator>
      </NavigationContainer>
    </HarnessBoundary>
  );
}

// ─── Render inspection ──────────────────────────────────────────────────────

function textOf(renderer: ReactTestRenderer): string[] {
  const out: string[] = [];
  for (const node of renderer.root.findAllByType(Text)) {
    const own = React.Children.toArray(node.props.children)
      .filter(child => typeof child === 'string' || typeof child === 'number')
      .join('');
    if (own.trim()) out.push(own.trim());
  }
  return out;
}

function spinners(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.endsWith('Keep Pickle Sensei open.'),
    )
    .filter(node => typeof node.type === 'string')
    .map(node =>
      String(node.props.accessibilityLabel)
        .replace(' Keep Pickle Sensei open.', '')
        .replace('. Keep Pickle Sensei open.', ''),
    );
}

interface Pressable {
  label: string;
  disabled: boolean;
  press: () => unknown;
}

function pressables(renderer: ReactTestRenderer): Pressable[] {
  const seen = new Set<string>();
  const out: Pressable[] = [];
  const nodes = renderer.root.findAll(
    node =>
      typeof node.props.onPress === 'function' && typeof node.type !== 'string',
  );
  for (const node of nodes) {
    const label: string =
      (typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel) ||
      (typeof node.props.label === 'string' && node.props.label) ||
      node
        .findAllByType(Text)
        .flatMap(t => React.Children.toArray(t.props.children))
        .filter(c => typeof c === 'string')
        .join(' ')
        .trim();
    if (!label) continue;
    const key = `${label}|${Boolean(node.props.disabled)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label,
      disabled: Boolean(node.props.disabled),
      press: () => node.props.onPress(),
    });
  }
  return out;
}

const RECOVERY_LABELS = [
  /^Back$/,
  /^Go back$/,
  /^Try again$/,
  /^Retry$/,
  /^Capture a new read$/,
  /^Done$/,
  /^Try again/,
];

// ─── Iteration driver ───────────────────────────────────────────────────────

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function advance(ms: number, step = 5_000) {
  let left = ms;
  while (left > 0) {
    const chunk = Math.min(step, left);
    await act(async () => {
      jest.advanceTimersByTime(chunk);
    });
    await settle(3);
    left -= chunk;
  }
}

interface Outcome {
  seed: number;
  kind: Scenario['kind'];
  faults: string[];
  profile: Profile;
  interaction: Interaction;
  fired: string[];
  verdict: 'HELD' | 'BROKEN';
  violations: string[];
  silent: boolean;
  crash: string | null;
  spinnersAfter60s: string[];
  recoveryControls: string[];
  backPopped: boolean | null;
  dbWrites: number;
  fetchCalls: string[];
  tripwires: string[];
  consoleErrors: string[];
  unhandled: string[];
  planStatus: string;
  mutation: string;
  textSample: string[];
  durationMs: number;
}

const mounted: ReactTestRenderer[] = [];
const unhandled: string[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(
    reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : String(reason),
  );
};

function resetWorld(scenario: Scenario) {
  controller = new Controller();
  controller.install(scenario);
  mockSqlite.execute = (sql, params) => controller.execute(sql, params);
  mockSqlite.writes = [];
  mockSqlite.openThrows = false;
  mockSqlite.migrateThrows = false;
  // Drop the cached handle so open/migration faults hit a fresh open.
  try {
    getDb().close();
  } catch {
    // no handle to close
  }
  mockSqlite.openThrows = scenario.faults.some(
    f => f.id === 'sqlite.open.throw',
  );
  mockSqlite.migrateThrows = scenario.faults.some(
    f => f.id === 'sqlite.migrate.throw',
  );
  mockNative.readTextFile = () => controller.readTextFile();
  mockNative.readTextFileAbsent = scenario.faults.some(
    f => f.id === 'fs.sidecar.absent',
  );
  mockNative.tripped = [];
  globalThis.fetch = ((input: string, init?: RequestInit) =>
    controller.fetchImpl(input, init)) as typeof fetch;
  clearTryAgainHandoff();
  clearTrainingStoreConfiguration();
  clearApiSession();
  setActiveDataOwner(OWNER);
  if (
    scenario.profile.session === 'signedIn' &&
    controller.session !== 'absent'
  ) {
    const canonical =
      controller.session === 'otherAccount' ? 'someone-else' : OWNER;
    establishApiSession({
      apiBaseUrl: API_BASE,
      bearerToken: 'stress-bearer-not-a-secret',
      canonicalAppUserId: OWNER,
      provider: 'apple',
    });
    // Exactly how src/auth/authStore.ts:228 wires the store (bearer resolved per request).
    configureTrainingStore(
      createTrainingApi({
        baseUrl: API_BASE,
        get token() {
          return bearerTokenFor(canonical);
        },
      }),
    );
    if (controller.session === 'otherAccount')
      controller.fire('session', 'otherAccount');
    if (controller.session === 'tokenNullMidFlight') {
      // Signed out between store configuration and the first request.
      controller.fire('session', 'tokenNullMidFlight');
      clearApiSession();
    }
  }
  if (scenario.faults.some(f => f.id === 'fetch.plan.retryAfterFailure'))
    controller.retryOnce = 1;
  const linkMode = controller.linking;
  (Linking.canOpenURL as jest.Mock).mockReset();
  (Linking.openURL as jest.Mock).mockReset();
  (Linking.canOpenURL as jest.Mock).mockImplementation(async () => {
    if (!linkMode) return true;
    controller.fire('linking.canOpenURL', linkMode);
    if (linkMode === 'canOpenFalse') return false;
    if (linkMode === 'canOpenReject') throw new Error('canOpenURL failed');
    if (linkMode === 'never') return never();
    if (linkMode === 'throw') throw new TypeError('Linking bridge threw');
    return true;
  });
  (Linking.openURL as jest.Mock).mockImplementation(async () => {
    if (linkMode === 'openReject') {
      controller.fire('linking.openURL', linkMode);
      throw new Error('openURL failed');
    }
    return undefined;
  });
  jest.setSystemTime(
    controller.clock === 'nowFarFuture'
      ? new Date('2099-01-01T00:00:00.000Z')
      : controller.clock === 'nowFarPast'
        ? new Date('1970-01-02T00:00:00.000Z')
        : new Date('2026-09-01T12:00:00.000Z'),
  );
}

function paramsFor(scenario: Scenario): unknown {
  const ids = scenario.faults.map(f => f.id);
  if (ids.includes('nav.paramsMissing')) return undefined;
  if (ids.includes('nav.analysisIdEmpty')) return { analysisId: '' };
  if (ids.includes('nav.analysisIdNumber')) return { analysisId: 42 };
  if (ids.includes('nav.analysisIdHuge'))
    return { analysisId: 'x'.repeat(20_000) };
  if (ids.includes('nav.analysisIdSqlText'))
    return { analysisId: "' OR 1=1; DROP TABLE local_shot; --" };
  return { analysisId: ANALYSIS_ID };
}

async function press(
  renderer: ReactTestRenderer,
  matcher: RegExp,
): Promise<boolean> {
  const target = pressables(renderer).find(
    p => matcher.test(p.label) && !p.disabled,
  );
  if (!target) return false;
  await act(async () => {
    await target.press();
  });
  await settle();
  return true;
}

async function runScenario(
  scenario: Scenario,
  control?: Outcome,
): Promise<Outcome> {
  const started = Date.now();
  resetWorld(scenario);
  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => (a instanceof Error ? a.message : String(a)))
          .join(' ')
          .slice(0, 400),
      );
    });
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  unhandled.length = 0;
  let crash: string | null = null;
  const single = scenario.faults.some(f => f.id === 'nav.noPreviousRoute');
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <Harness
          params={paramsFor(scenario)}
          single={single}
          onError={error => {
            crash =
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error);
          }}
        />,
      );
    });
    mounted.push(renderer);
    await settle();

    // Mid-load navigation interactions happen while the evidence is pending.
    if (
      scenario.interaction === 'setParamsMidLoad' ||
      scenario.interaction === 'popMidLoad'
    ) {
      controller.sql['shot.get'] = controller.sql['shot.get'] ?? 'slow5s';
      const route = navigationRef.getCurrentRoute();
      if (route && scenario.interaction === 'setParamsMidLoad') {
        await act(async () => {
          navigationRef.dispatch({
            ...CommonActions.setParams({ analysisId: PREVIOUS_ID }),
            source: route.key,
          });
        });
      } else if (scenario.interaction === 'popMidLoad') {
        await act(async () => {
          navigationRef.dispatch(CommonActions.goBack());
        });
      }
      await settle();
    }

    await advance(60_000);

    if (!crash) {
      if (scenario.interaction === 'buildPlan') {
        await press(renderer, /^Build reviewed plan$/);
        await advance(60_000);
      } else if (scenario.interaction === 'completeItem') {
        if (await press(renderer, /^Confirm completion of /)) {
          await press(renderer, /^I completed it$/);
          await advance(60_000);
        }
      } else if (scenario.interaction === 'watchMedia') {
        await press(renderer, /^Watch reviewed instruction for /);
        await advance(60_000);
      } else if (scenario.interaction === 'trainingRetry') {
        await press(renderer, /^Try again$/);
        await advance(60_000);
      }
    }
  } catch (error) {
    crash =
      crash ??
      (error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error));
  }

  const texts = crash || !renderer ? [] : textOf(renderer);
  const spins = crash || !renderer ? [] : spinners(renderer);
  const controls =
    crash || !renderer
      ? []
      : pressables(renderer)
          .filter(
            p => !p.disabled && RECOVERY_LABELS.some(rx => rx.test(p.label)),
          )
          .map(p => p.label);
  const training = useTrainingStore.getState();
  const poppedMidLoad = scenario.interaction === 'popMidLoad';
  const navIndex = navigationRef.isReady()
    ? (navigationRef.getRootState()?.index ?? -1)
    : -1;

  // Back control must really pop the stack (unless there is nothing beneath).
  let backPopped: boolean | null = null;
  if (!crash && renderer && !poppedMidLoad) {
    const before = navIndex;
    const pressed =
      (await press(renderer, /^Back$/)) || (await press(renderer, /^Go back$/));
    if (pressed) {
      if (scenario.interaction === 'doubleBack')
        await press(renderer, /^Back$/);
      const after = navigationRef.isReady()
        ? (navigationRef.getRootState()?.index ?? -1)
        : -1;
      backPopped = single ? after === before : after < before;
    }
  }

  errorSpy.mockRestore();
  warnSpy.mockRestore();

  const violations: string[] = [];
  if (crash) violations.push(`crash: ${crash}`);
  if (spins.length > 0)
    violations.push(`spinner_after_60s: ${spins.join(' | ')}`);
  if (!crash && !poppedMidLoad && controls.length === 0)
    violations.push('no_recovery_control');
  if (poppedMidLoad && navIndex !== 1)
    violations.push(`pop_mid_load_left_index_${navIndex}`);
  if (backPopped === false) violations.push('back_control_did_not_pop');
  if (!crash && training.mutation !== 'idle')
    violations.push(`mutation_stuck_after_60s: ${training.mutation}`);
  if (mockSqlite.writes.length > 0)
    violations.push(`persisted_write: ${mockSqlite.writes.join(' ; ')}`);
  if (unhandled.length > 0)
    violations.push(`unhandled_rejection: ${unhandled.join(' | ')}`);
  const realErrors = consoleErrors.filter(
    e =>
      !/not wrapped in act|Warning: |useNativeDriver/.test(e) &&
      // A lone route has nothing beneath it: React Navigation's dev-only
      // "GO_BACK was not handled" is the expected report for that scenario.
      !(single && /GO_BACK/.test(e)),
  );
  if (realErrors.length > 0)
    violations.push(`console_error: ${realErrors.join(' | ')}`);
  const tripwires = mockNative.tripped.filter(
    t => !/\.(__|Symbol\(|\$\$typeof|prototype|constructor)/.test(t),
  );
  if (tripwires.length > 0)
    violations.push(
      `unexpected_native_access: ${[...new Set(tripwires)].join(', ')}`,
    );

  // Fake success: a faulted dependency must never present as verified.
  const firedSeams = new Set(controller.fired.map(f => f.seam));
  const planFaultNonSuccess = controller.fired.some(
    f =>
      f.seam === 'fetch.plan' &&
      f.mode !== 'nullPlan' &&
      f.mode !== 'slow5s' &&
      f.mode !== 'slow45s' &&
      f.mode !== 'jsonSlow',
  );
  if (
    planFaultNonSuccess &&
    training.planStatus === 'ready' &&
    training.currentPlan !== null &&
    !scenario.faults.some(f => f.id === 'fetch.plan.retryAfterFailure')
  ) {
    violations.push(
      'fake_success: plan marked ready despite faulted plan fetch',
    );
  }
  const receiptFaultNonSuccess = controller.fired.some(
    f =>
      f.seam === 'sqlite.receipt' &&
      !['slow5s', 'slow30s', 'jitter'].includes(f.mode),
  );
  if (
    receiptFaultNonSuccess &&
    texts.some(
      t => t === 'Build reviewed plan' || t === 'Turn this read into a plan',
    )
  ) {
    violations.push(
      'fake_success: plan CTA shown although the sync receipt read faulted',
    );
  }
  const shotFaultNonSuccess = controller.fired.some(
    f =>
      f.seam === 'sqlite.shot.get' &&
      ['reject', 'throw', 'malformed', 'empty', 'nullrows'].includes(f.mode),
  );
  if (shotFaultNonSuccess && texts.includes('7.1')) {
    violations.push(
      'fake_success: score rendered although the analysis row read faulted',
    );
  }
  const createFaultNonSuccess = controller.fired.some(
    f => f.seam === 'fetch.create' && f.mode !== 'slow5s',
  );
  if (
    createFaultNonSuccess &&
    training.currentPlan !== null &&
    scenario.interaction === 'buildPlan'
  ) {
    violations.push('fake_success: plan stored although plan creation faulted');
  }

  // Silent: fault fired at a user-visible seam, render text identical to control.
  const userVisibleFired =
    scenario.faults.some(f => f.userVisibleSeam && !f.legitimateSuccess) &&
    firedSeams.size > 0;
  const silent = Boolean(
    control &&
    userVisibleFired &&
    !crash &&
    JSON.stringify(texts) === JSON.stringify(control.textSample),
  );
  if (silent)
    violations.push(
      'silent_failure: rendered text identical to fault-free control',
    );

  return {
    seed: scenario.seed,
    kind: scenario.kind,
    faults: scenario.faults.map(f => f.id),
    profile: scenario.profile,
    interaction: scenario.interaction,
    fired: [...new Set(controller.fired.map(f => `${f.seam}:${f.mode}`))],
    verdict: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    silent,
    crash,
    spinnersAfter60s: spins,
    recoveryControls: controls,
    backPopped,
    dbWrites: mockSqlite.writes.length,
    fetchCalls: controller.fetchCalls,
    tripwires: [...new Set(tripwires)],
    consoleErrors: realErrors,
    unhandled: [...unhandled],
    planStatus: training.planStatus,
    mutation: training.mutation,
    textSample: texts,
    durationMs: Date.now() - started,
  };
}

async function controlFor(scenario: Scenario): Promise<Outcome> {
  const control: Scenario = {
    ...scenario,
    faults: [],
    interaction: 'none',
    kind: 'control',
  };
  return runScenario(control);
}

// ─── Suite ──────────────────────────────────────────────────────────────────

jest.useFakeTimers();

declare const process: {
  env: Record<string, string | undefined>;
  on(event: 'unhandledRejection', handler: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', handler: (reason: unknown) => void): void;
};

const STRESS_ITER = Number(process.env['STRESS_ITER'] ?? 12);
const STRESS_SEED = process.env['STRESS_SEED']
  ? Number(process.env['STRESS_SEED'])
  : null;
const STRESS_REPORT = process.env['STRESS_REPORT'] ?? null;

const outcomes: Outcome[] = [];

beforeAll(() => {
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.clearAllTimers();
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  clearTrainingStoreConfiguration();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  if (STRESS_REPORT) {
    const fs = require('fs') as {
      mkdirSync(dir: string, options: { recursive: boolean }): void;
      writeFileSync(file: string, data: string): void;
    };
    const path = require('path') as { dirname(file: string): string };
    fs.mkdirSync(path.dirname(STRESS_REPORT), { recursive: true });
    fs.writeFileSync(
      STRESS_REPORT,
      JSON.stringify(
        {
          unit: 'scr-resultdetailsscreen',
          lens: 'failure-injection',
          catalogSize: CATALOG.length,
          executed: outcomes.length,
          held: outcomes.filter(o => o.verdict === 'HELD').length,
          broken: outcomes.filter(o => o.verdict === 'BROKEN').length,
          outcomes,
        },
        null,
        2,
      ),
    );
  }
});

const HELD_EXPECTATION =
  'every injected fault leaves a recoverable, honest screen';

/**
 * Reproduced defects (see the stress report for this unit). Each pin names the
 * fault ids that trigger it and the violation it produces. A pinned fault's
 * violation is EXPECTED: the sweep asserts it still reproduces (so the pin
 * must be deleted once the defect is fixed) and combos ignore only the
 * violations a present pinned fault explains. STRESS_STRICT=1 disables the
 * pins and reports every violation as a failure.
 */
const KNOWN_BROKEN: { id: string; faults: RegExp; violation: RegExp }[] = [
  {
    // ResultScreen.tsx:219/277 call getDb() synchronously inside an effect: an
    // open/migration throw escapes the hook and unmounts the whole navigator.
    id: 'F1 getDb() throw is uncaught (root error boundary replaces the navigator)',
    faults: /^sqlite\.(open|migrate)\.throw$/,
    violation: /SQLITE_(CANTOPEN|CORRUPT)/,
  },
  {
    // repository.ts getAnalysis: `JSON.parse(payload) as ShotAnalysis` — a
    // partial / wrong-typed persisted row crashes ResultBreakdownSheet.
    id: 'F2 persisted analysis payload is not validated before render',
    faults: /^sqlite\.shot\.get\.(partial|wrongtypes)$/,
    violation: /checkpoints|reading 'filter'/,
  },
  {
    // strokeResultData.ts awaits every local read with no deadline: one hung
    // read = "Opening your result…" forever (Back stays available).
    id: 'F3 evidence loader has no deadline (infinite Opening your result…)',
    faults: /^sqlite\.(shot\.get|shot\.list|record|capture|all)\.never$/,
    violation: /^spinner_after_60s: Opening your result/,
  },
  {
    id: 'F4 sync-state reads have no deadline (infinite Checking sync evidence…)',
    faults: /^sqlite\.(receipt|outbox)\.never$/,
    violation: /^spinner_after_60s: Checking sync evidence/,
  },
  {
    // training/api.ts request(): no AbortController / timeout around fetchFn
    // or response.json(); the store stays 'loading' / mutation stays busy.
    id: 'F5 training API requests have no timeout (infinite Checking reviewed training… / busy mutation)',
    faults: /^fetch\.(plan|drill|all|create|completion)\.(never|jsonNever)$/,
    violation:
      /^spinner_after_60s: Checking reviewed training|^mutation_stuck_after_60s|^silent_failure/,
  },
  {
    // ResultDetailsScreen.tsx: `route.params.analysisId` with no params.
    id: 'F6 ResultDetails without params crashes instead of showing Result missing',
    faults: /^nav\.paramsMissing$/,
    violation: /reading 'analysisId'/,
  },
  {
    // ResultScreen.tsx openMedia awaits Linking.canOpenURL with no deadline.
    id: 'F7 Watch form tap is silent when Linking.canOpenURL never resolves',
    faults: /^linking\.never$/,
    violation: /^silent_failure/,
  },
  {
    // training/store.ts: a sign-out (configuration reset) while the plan
    // request is in flight leaves planStatus 'idle', which the section renders
    // as a spinner. Only visible if the screen survives sign-out.
    id: 'F8 training section spins forever after a mid-flight sign-out',
    faults: /^session\.clearedMidFlight$/,
    violation: /^spinner_after_60s: Checking reviewed training/,
  },
];

const STRESS_STRICT = process.env['STRESS_STRICT'] === '1';

function pinsFor(faultIds: string[]) {
  return STRESS_STRICT
    ? []
    : KNOWN_BROKEN.filter(pin => faultIds.some(id => pin.faults.test(id)));
}

function unexplained(outcome: Outcome) {
  const pins = pinsFor(outcome.faults);
  return outcome.violations.filter(
    v => !pins.some(pin => pin.violation.test(v)),
  );
}

describe('ResultDetailsScreen · failure injection (real navigator + stores)', () => {
  it(`catalog holds ≥60 distinct injected faults (${CATALOG.length})`, () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(60);
    expect(new Set(CATALOG.map(f => f.id)).size).toBe(CATALOG.length);
  });

  if (STRESS_SEED !== null) {
    it(`replays seed ${STRESS_SEED}`, async () => {
      const scenario = scenarioFor(
        STRESS_SEED,
        STRESS_SEED < CATALOG.length ? 'sweep' : 'combo',
      );
      const control = await controlFor(scenario);
      const outcome = await runScenario(scenario, control);
      outcomes.push(outcome);
      console.log(JSON.stringify(outcome, null, 2));
      expect(unexplained(outcome)).toEqual([]);
    });
    return;
  }

  describe('sweep: every catalog fault once (seed = catalog index)', () => {
    CATALOG.forEach((fault, index) => {
      const pins = pinsFor([fault.id]);
      const title =
        pins.length > 0
          ? `[seed ${index}] ${fault.id} — KNOWN BROKEN: ${pins.map(p => p.id).join('; ')}`
          : `[seed ${index}] ${fault.id} — ${HELD_EXPECTATION}`;
      it(title, async () => {
        const scenario = scenarioFor(index, 'sweep');
        const control = fault.userVisibleSeam
          ? await controlFor(scenario)
          : undefined;
        const outcome = await runScenario(scenario, control);
        outcomes.push(outcome);
        // An injected fault that never fired was not injected.
        expect(outcome.fired.length).toBeGreaterThan(0);
        expect(unexplained(outcome)).toEqual([]);
        // A pinned defect that no longer reproduces means the pin must go.
        if (pins.length > 0)
          expect(outcome.violations.length).toBeGreaterThan(0);
      });
    });
  });

  describe(`combos: STRESS_ITER=${STRESS_ITER} seeded 1–3 simultaneous faults`, () => {
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const seed = 1_000 + i;
      it(`[seed ${seed}] — ${HELD_EXPECTATION}`, async () => {
        const scenario = scenarioFor(seed, 'combo');
        const control = await controlFor(scenario);
        const outcome = await runScenario(scenario, control);
        outcomes.push(outcome);
        expect(unexplained(outcome)).toEqual([]);
      });
    }
  });
});
