/**
 * STRESS · scr-formreviewscreen · lens "randomized-seeded".
 *
 * Seeded randomized long-run over the FormReviewScreen's public interaction
 * surface, rendered inside a REAL React Navigation container + native-stack
 * navigator (the same `FormReview` registration shape RootNavigator uses),
 * reading from the REAL local data layer (production `getDb()` migrations,
 * `data/repository`, `components/strokeResultData`, `review/poseSidecar`)
 * over a real SQLite engine (node:sqlite behind the op-sqlite native module
 * mock). Only native modules are mocked: op-sqlite, the capture-artifact
 * reader, react-native-svg, react-native-safe-area-context. Sibling routes
 * (`Result`, `Analyze`) are lightweight stand-ins so `goBack()` / re-analyze
 * are real navigation actions with observable state.
 *
 * Every sequence is replayable from its seed (`STRESS_SEED=<n>`); the campaign
 * size is `STRESS_ITER` (default small so the suite stays fast). Results are
 * written as a JSON table (seed → outcome) to `STRESS_OUT` when set.
 *
 * Invariants model-checked after EVERY action (sources: code comments in
 * src/review/FormReviewPlayer.tsx, formReviewGeometry.ts, formReviewModel.ts,
 * poseSidecar.ts, FormReviewScreen.tsx and the App Store copy rules):
 *   I1  playhead ∈ [0, durationMs] and the clock text shows it (2 decimals).
 *   I2  paused ⇒ the JS clock never moves the playhead.
 *   I3  playing without auto-pause ⇒ playhead advances by k·TICK·rate ticks,
 *       never crosses durationMs, and reaching it stops playback exactly at
 *       durationMs with no active stop.
 *   I4  auto-pause fires on the EARLIEST unvisited stop whose atMs was
 *       crossed by a tick (prev < atMs ≤ now), freezes the playhead exactly
 *       at atMs, shows that stop, and never fires twice for one stop in a
 *       pass; a jump re-arms every stop strictly after the new position.
 *   I5  prev/next jump to the neighbouring stop, pause, and show it; the
 *       chips are disabled exactly at the ends.
 *   I6  speed cycles 1× → ½× → ¼× → 1×; AUTO switch flips its checked state.
 *   I7  the stop card counter "STOP i OF N" names stops[i-1] (or the card
 *       reads "No checkpoint at this moment" for an empty position).
 *   I8  the shown pose frame is a RECORDED frame within 120 ms of the
 *       playhead (never interpolated) or none.
 *   I9  honest partial-evidence copy: clip-missing / sidecar-missing captions
 *       appear exactly when the stored evidence is missing; the on-device
 *       disclosure is always present; missing analysis renders the
 *       unavailable state with no player.
 *   I10 no forbidden App Store copy anywhere in the rendered text.
 *   I11 re-analyze arms exactly one TryAgain handoff (same declared stroke,
 *       auto flag and set) and lands on `Analyze`; back pops to `Result`,
 *       unmounts the screen and leaves no live timers behind.
 *   I12 no console.error / console.warn during a sequence.
 *   Determinism: same seed twice → byte-identical trace.
 */
import React from 'react';
import { NativeModules, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
  type NavigationState,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import {
  SHOT_TYPES,
  type CheckpointKey,
  type CheckpointScore,
  type FaultDirection,
  type PhaseKey,
  type PhaseSpan,
  type ScoreBand,
  type ShotAnalysis,
  type ShotTypeSlug,
} from '@pickle/shared-types';
import type { RootStackParams } from '../../src/navigation/params';
import type { ReviewStop } from '../../src/review/formReviewModel';

// ─── Native module mocks (the only mocks in this file) ──────────────────────

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
  run(...params: (string | number | null)[]): unknown;
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
const mockNodeSqlite = jest.requireActual<{
  DatabaseSync: new (location: string) => DatabaseSync;
}>('node:sqlite');

const mockSqlite: { db: DatabaseSync | null } = { db: null };

function sqliteParams(params: unknown[]): (string | number | null)[] {
  return params.map(value => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return JSON.stringify(value);
  });
}

function mockRunSql(sql: string, params: unknown[] = []) {
  const db = mockSqlite.db;
  if (!db) throw new Error('no sqlite database open');
  const statement = db.prepare(sql);
  const returnsRows = /^\s*(SELECT|PRAGMA|WITH)/i.test(sql);
  if (returnsRows) {
    return { rows: statement.all(...sqliteParams(params)) };
  }
  statement.run(...sqliteParams(params));
  return { rows: [] as Record<string, unknown>[] };
}

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    mockSqlite.db = new mockNodeSqlite.DatabaseSync(':memory:');
    return {
      executeSync: (sql: string, params: unknown[] = []) =>
        mockRunSql(sql, params),
      execute: async (sql: string, params: unknown[] = []) =>
        mockRunSql(sql, params),
      close: () => {
        mockSqlite.db?.close();
        mockSqlite.db = null;
      },
    };
  },
}));

jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: unknown }>(
      'react-native-safe-area-context/jest/mock',
    ).default,
);

jest.mock('react-native-svg', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, props.children);
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

/** The private capture-artifact filesystem the native bridge would read. */
const artifactFiles = new Map<string, string>();
(
  NativeModules as {
    PickleVideoCapture?: { readTextFile(uri: string): Promise<string> };
  }
).PickleVideoCapture = {
  readTextFile: async (uri: string) => {
    const body = artifactFiles.get(uri);
    if (body === undefined) throw new Error(`ENOENT ${uri}`);
    return body;
  },
};

// @react-native/jest-preset installs `performance.now = jest.fn(Date.now)`.
// The React scheduler and the fake clock call it ~10^5 times per sequence and
// a jest.fn retains every call record, so a long campaign would exhaust the
// heap (measured: ~7 MB retained per sequence). Same semantics, unrecorded.
if (jest.isMockFunction(performance.now)) {
  performance.now = () => Date.now();
}

// The screen (and its data layer, which captures NativeModules at load time)
// is loaded AFTER the native bridge above exists.
const { FormReviewScreen } = jest.requireActual<
  typeof import('../../src/screens/FormReviewScreen')
>('../../src/screens/FormReviewScreen');
const { FormReviewOverlay } = jest.requireActual<
  typeof import('../../src/review/FormReviewOverlay')
>('../../src/review/FormReviewOverlay');
const { getDb } =
  jest.requireActual<typeof import('../../src/data/db')>('../../src/data/db');
const { setActiveDataOwner, GUEST_DATA_OWNER } = jest.requireActual<
  typeof import('../../src/data/accountScope')
>('../../src/data/accountScope');
const { saveAnalysis, savePendingCapture } = jest.requireActual<
  typeof import('../../src/data/repository')
>('../../src/data/repository');
const { buildFormReviewScript } = jest.requireActual<
  typeof import('../../src/review/formReviewModel')
>('../../src/review/formReviewModel');
const { clearTryAgainHandoff, peekTryAgainHandoff } = jest.requireActual<
  typeof import('../../src/screens/tryAgainHandoff')
>('../../src/screens/tryAgainHandoff');
const { sha256Hex } = jest.requireActual<typeof import('@pickle/swing-domain')>(
  '@pickle/swing-domain',
);

// ─── Seeded RNG (mulberry32, replayable from one 32-bit seed) ───────────────

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ─── Scenario generation (what is stored on the device) ─────────────────────

const PHASE_ORDER: readonly PhaseKey[] = [
  'ready',
  'prepare',
  'accelerate',
  'contact',
  'follow_through',
  'recover',
];
const CHECKPOINT_KEYS: readonly CheckpointKey[] = [
  'ready_position',
  'athletic_base',
  'preparation',
  'paddle_set',
  'swing_length',
  'sequencing',
  'paddle_path',
  'contact_position',
  'face_wrist_stability',
  'follow_through',
  'recovery',
];
const DIRECTIONS: readonly FaultDirection[] = [
  'none',
  'narrow',
  'low',
  'late',
  'unstable',
  'short',
];

type EvidenceVariant =
  | 'full'
  | 'clip_missing'
  | 'capture_row_missing'
  | 'sidecar_absent'
  | 'sidecar_hash_mismatch'
  | 'sidecar_corrupt'
  | 'analysis_missing';

interface Scenario {
  variant: EvidenceVariant;
  analysis: ShotAnalysis;
  clipDurationMs: number;
  declaredStroke: ShotTypeSlug | null;
  requestedPhase: string | undefined;
  frameStepMs: number;
  sidecarUri: string;
}

function band(score: number | null): ScoreBand {
  if (score === null) return 'unscored';
  if (score >= 75) return 'green';
  if (score >= 60) return 'yellow';
  return 'red';
}

function generateScenario(rng: Rng, seed: number): Scenario {
  const variant = rng.pick<EvidenceVariant>([
    'full',
    'full',
    'full',
    'full',
    'clip_missing',
    'capture_row_missing',
    'sidecar_absent',
    'sidecar_hash_mismatch',
    'sidecar_corrupt',
    'analysis_missing',
  ]);
  const shotType = rng.pick(SHOT_TYPES);
  const endMs = rng.int(1200, 5200);
  const contactMs = rng.int(Math.floor(endMs * 0.4), Math.floor(endMs * 0.7));
  // Phase spans partition [0, endMs] around contact; each phase is kept
  // with 85% probability so scripts with 1–6 stops (and none) all occur.
  const cuts = [
    0,
    Math.floor(contactMs * 0.35),
    Math.floor(contactMs * 0.7),
    contactMs - rng.int(10, 40),
    contactMs + rng.int(10, 40),
    contactMs + Math.floor((endMs - contactMs) * 0.5),
    endMs,
  ];
  const phases: PhaseSpan[] = [];
  const dropAll = rng.chance(0.06);
  PHASE_ORDER.forEach((key, index) => {
    const startMs = cuts[index]!;
    const phaseEnd = cuts[index + 1]!;
    if (dropAll || phaseEnd <= startMs || rng.chance(0.15)) return;
    phases.push({
      key,
      startMs,
      endMs: phaseEnd,
      representativeMs:
        key === 'contact' ? contactMs : rng.int(startMs, phaseEnd),
      confidence: 0.8,
    });
  });
  const checkpoints: CheckpointScore[] = CHECKPOINT_KEYS.map(key => {
    const score = rng.chance(0.12) ? null : rng.int(20, 98);
    return {
      key,
      score,
      confidence: 0.8,
      band: band(score),
      direction: score !== null && score < 75 ? rng.pick(DIRECTIONS) : 'none',
      severity: score === null ? 0 : (100 - score) / 100,
      applicable: !rng.chance(0.1),
    };
  });
  const scored = checkpoints.filter(cp => cp.score !== null && cp.applicable);
  const worst = scored.reduce<CheckpointScore | null>(
    (acc, cp) => (acc === null || cp.score! < acc.score! ? cp : acc),
    null,
  );
  const analysis: ShotAnalysis = {
    id: `analysis-${seed}`,
    sessionId: rng.chance(0.3) ? null : `set-${seed % 7}`,
    shotType,
    cameraView: 'side',
    handedness: rng.chance(0.5) ? 'right' : 'left',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs, endMs },
    phases,
    measurements: [],
    checkpoints,
    overallScore: 7.1,
    analysisConfidence: 0.84,
    resultKind: 'scored',
    guidance: null,
    priorityFix: worst
      ? {
          checkpoint: worst.key,
          reasonKey: 'lowest_score',
          severity: worst.severity,
          confidence: 0.8,
        }
      : null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: `${shotType}@1`,
    },
    source: 'real',
  };
  const requestedPhase = rng.chance(0.55)
    ? undefined
    : rng.chance(0.8)
      ? rng.pick(PHASE_ORDER)
      : rng.pick(['contact_position', '', 'CONTACT', 'nope']);
  return {
    variant,
    analysis,
    clipDurationMs: endMs + rng.int(0, 900),
    declaredStroke: rng.chance(0.3) ? null : shotType,
    requestedPhase,
    frameStepMs: rng.pick([33, 40, 50, 100]),
    sidecarUri: `file:///private/captures/clip-${seed}.pose.json`,
  };
}

/** Wire-format sidecar document (the native capture layer's output). */
function sidecarDocument(scenario: Scenario): string {
  const frames = [];
  const end = scenario.analysis.timestamps.endMs;
  let index = 0;
  for (let t = 0; t <= end; t += scenario.frameStepMs) {
    const sweep = t / Math.max(1, end);
    const wristX = 0.3 + 0.4 * sweep;
    frames.push({
      i: index++,
      t,
      c: 0.9,
      l: [
        ['head', 0.5, 0.18],
        ['left_shoulder', 0.45, 0.3],
        ['right_shoulder', 0.55, 0.3],
        ['left_elbow', 0.4, 0.42],
        ['right_elbow', 0.62, 0.42],
        ['left_wrist', 0.38, 0.52],
        ['right_wrist', wristX, 0.5],
        ['left_hip', 0.46, 0.55],
        ['right_hip', 0.54, 0.55],
        ['left_knee', 0.46, 0.72],
        ['right_knee', 0.54, 0.72],
        ['left_ankle', 0.45, 0.9],
        ['right_ankle', 0.55, 0.9],
      ].map(([n, x, y]) => ({ n, x, y, v: 0.95 })),
    });
  }
  return JSON.stringify({
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
    video: { w: 1080, h: 1920, fps: 1000 / scenario.frameStepMs },
    frames,
  });
}

interface StoredScenario {
  clipStored: boolean;
  sequenceStored: boolean;
  frameTimestamps: number[];
}

/** Writes the scenario into the REAL local store exactly as the app would. */
async function storeScenario(scenario: Scenario): Promise<StoredScenario> {
  const db = getDb();
  artifactFiles.clear();
  const { analysis, variant } = scenario;
  if (variant === 'analysis_missing') {
    return { clipStored: false, sequenceStored: false, frameTimestamps: [] };
  }
  const captureId = `capture-${analysis.id}`;
  await saveAnalysis(db, analysis, `permit-${analysis.id}`);
  await db.execute(
    `INSERT INTO local_analysis_record
      (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      GUEST_DATA_OWNER,
      analysis.id,
      captureId,
      analysis.capturedAtIso,
      'on-device-fusion-1',
      'sm-v1',
      JSON.stringify({
        id: analysis.id,
        captureId,
        createdAtIso: analysis.capturedAtIso,
        strokeIntent: {
          declaredStroke: scenario.declaredStroke,
          predictedStroke: null,
          resolutionBasis:
            scenario.declaredStroke === null ? 'predicted' : 'declared',
          resolvedProfileId: analysis.shotType.toUpperCase(),
          resolvedProfileVersion: 'technique-profile-v1',
          disagreement: null,
        },
        result: analysis,
        uncertainty: {
          analysisConfidence: 0.84,
          presentation: 'normal',
          limitingFactors: [],
        },
      }),
    ],
  );
  if (variant === 'capture_row_missing') {
    return { clipStored: false, sequenceStored: false, frameTimestamps: [] };
  }
  const document = sidecarDocument(scenario);
  const frameTimestamps = (
    JSON.parse(document) as { frames: { t: number }[] }
  ).frames.map(frame => frame.t);
  const withSidecar = variant !== 'sidecar_absent';
  const sidecarRef = {
    schemaVersion: 1 as const,
    format: 'pickle.pose-sequence.v1' as const,
    uri: scenario.sidecarUri,
    frameCount: frameTimestamps.length,
    sha256: sha256Hex(document),
    coordinateSystem: 'normalized_image_top_left' as const,
    poseModelVersion: 'apple-vision-bodypose-1',
  };
  const clip = {
    captureMode: 'imported_video' as const,
    uri: `file:///private/captures/clip-${analysis.id}.mov`,
    durationMs: scenario.clipDurationMs,
    fps: 30,
    width: 1080,
    height: 1920,
    capturedAtIso: analysis.capturedAtIso,
    recognition: {
      status: 'recognized' as const,
      shotType: 'drive_forehand' as const,
      confidence: 0.9,
      modelVersion: 'stroke-recognizer-1',
    },
    ballSpeed: {
      status: 'unavailable' as const,
      reason: 'analysis_not_run' as const,
    },
    posterUri: `file:///private/captures/clip-${analysis.id}.poster.jpg`,
    ...(withSidecar ? { poseSequence: sidecarRef } : {}),
  };
  await savePendingCapture(db, captureId, analysis.shotType, clip);
  if (variant === 'clip_missing') {
    // A zero-length capture row: strokeResultData yields no clip, and the
    // row's payload no longer matches its metadata so the repository refuses
    // to trust the sidecar ref either (clip AND pose absent, honestly).
    await db.execute(
      `UPDATE local_capture SET duration_ms = 0 WHERE owner_key = ? AND id = ?`,
      [GUEST_DATA_OWNER, captureId],
    );
  }
  if (variant === 'sidecar_hash_mismatch') {
    artifactFiles.set(scenario.sidecarUri, `${document} `);
  } else if (variant === 'sidecar_corrupt') {
    artifactFiles.set(scenario.sidecarUri, document.slice(0, -7));
  } else if (withSidecar) {
    artifactFiles.set(scenario.sidecarUri, document);
  }
  const sequenceStored =
    withSidecar &&
    variant !== 'clip_missing' &&
    variant !== 'sidecar_hash_mismatch' &&
    variant !== 'sidecar_corrupt';
  return {
    clipStored: variant !== 'clip_missing',
    sequenceStored,
    frameTimestamps: sequenceStored ? frameTimestamps : [],
  };
}

// ─── Real navigator around the real screen ──────────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function ResultStandIn() {
  return <Text>[Result]</Text>;
}
function AnalyzeStandIn() {
  return <Text>[Analyze]</Text>;
}

function Harness(props: { analysisId: string; phase: string | undefined }) {
  return (
    <NavigationContainer
      ref={navigationRef}
      initialState={{
        index: 1,
        routes: [
          { name: 'Result', params: { analysisId: props.analysisId } },
          {
            name: 'FormReview',
            params: {
              analysisId: props.analysisId,
              ...(props.phase !== undefined ? { phase: props.phase } : {}),
            },
          },
        ],
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Result" component={ResultStandIn} />
        <Stack.Screen name="FormReview" component={FormReviewScreen} />
        <Stack.Screen name="Analyze" component={AnalyzeStandIn} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

function currentRouteName(): string {
  const state = navigationRef.getRootState() as NavigationState | undefined;
  return state ? (state.routes[state.index]?.name ?? '?') : '?';
}

// ─── Tree probes ────────────────────────────────────────────────────────────

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

function pressable(renderer: ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === testID &&
      typeof candidate.props.onPress === 'function',
  );
  return node ?? null;
}

function pressableByLabel(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      typeof candidate.props.onPress === 'function' &&
      (candidate.props.accessibilityLabel === label ||
        candidate.props.label === label),
  );
  return node ?? null;
}

function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function timelineNode(renderer: ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === 'form-review-timeline' &&
      typeof candidate.props.onResponderGrant === 'function',
  );
  return node ?? null;
}

function stageNode(renderer: ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === 'form-review-stage' &&
      typeof candidate.props.onLayout === 'function',
  );
  return node ?? null;
}

// ─── Observable snapshot of the mounted screen ──────────────────────────────

interface Snapshot {
  route: string;
  mounted: boolean;
  clock: string;
  playing: boolean | null;
  speed: string | null;
  autoPause: boolean | null;
  stopIndex: number | null;
  stopCount: number | null;
  prevDisabled: boolean | null;
  nextDisabled: boolean | null;
  frameTs: number | null;
  frameShown: boolean;
  text: string;
}

function snapshot(renderer: ReactTestRenderer): Snapshot {
  const text = allText(renderer);
  const screen = hostByTestId(renderer, 'form-review-screen');
  const play = pressable(renderer, 'form-review-play');
  const speed = pressable(renderer, 'form-review-speed');
  const auto = pressable(renderer, 'form-review-autopause');
  const prev = pressable(renderer, 'form-review-prev-stop');
  const next = pressable(renderer, 'form-review-next-stop');
  const clockMatch = /(\d+\.\d\d)s/.exec(text);
  const counter = /STOP (\d+) OF (\d+)/.exec(text);
  const overlays = renderer.root.findAllByType(FormReviewOverlay);
  const overlay = overlays[0];
  const frame = overlay
    ? (overlay.props as { frame: { timestampMs: number } | null }).frame
    : null;
  return {
    route: currentRouteName(),
    mounted: screen.length > 0,
    clock: clockMatch?.[1] ?? '',
    playing: play
      ? String(play.props.accessibilityLabel) === 'Pause replay'
      : null,
    speed: speed
      ? ((renderer.root.findAll(
          node =>
            node.type === Text &&
            typeof node.props.children === 'string' &&
            /^[1½¼]×$/.test(node.props.children),
        )[0]?.props.children as string | undefined) ?? null)
      : null,
    autoPause: auto
      ? Boolean(
          (auto.props.accessibilityState as { checked?: boolean }).checked,
        )
      : null,
    stopIndex: counter ? Number(counter[1]) : null,
    stopCount: counter ? Number(counter[2]) : null,
    prevDisabled: prev ? Boolean(prev.props.disabled) : null,
    nextDisabled: next ? Boolean(next.props.disabled) : null,
    frameTs: frame ? frame.timestampMs : null,
    frameShown: overlays.length > 0,
    text,
  };
}

// ─── Reference model (from the documented player contract) ──────────────────

const TICK_MS = 1000 / 30;
const FAKE_TICK_PERIOD_MS = Math.trunc(TICK_MS);
const END_TOLERANCE_MS = 30;
const EXTENT_PAD_MS = 250;
const POSE_FRAME_TOLERANCE_MS = 120;
const SPEEDS = [1, 0.5, 0.25];
const SPEED_LABELS = ['1×', '½×', '¼×'];

/** Model-side event counters: proof of which behaviours a run exercised. */
interface Coverage {
  ticks: number;
  autoPauses: number;
  finishes: number;
  restarts: number;
  jumps: number;
  scrubs: number;
  pausedTicks: number;
}

function emptyCoverage(): Coverage {
  return {
    ticks: 0,
    autoPauses: 0,
    finishes: 0,
    restarts: 0,
    jumps: 0,
    scrubs: 0,
    pausedTicks: 0,
  };
}

interface Model {
  durationMs: number;
  playhead: number;
  playing: boolean;
  speedIndex: number;
  autoPause: boolean;
  activeStopId: string | null;
  visited: Set<string>;
  scrubbing: boolean;
  trackWidth: number;
  coverage: Coverage;
}

function modelCurrentStop(stops: readonly ReviewStop[], t: number) {
  let containing: ReviewStop | null = null;
  for (const stop of stops) {
    if (t < stop.startMs || t > stop.endMs) continue;
    if (
      containing === null ||
      Math.abs(stop.atMs - t) < Math.abs(containing.atMs - t)
    ) {
      containing = stop;
    }
  }
  if (containing) return containing;
  let passed: ReviewStop | null = null;
  for (const stop of stops) {
    if (stop.atMs <= t && (passed === null || stop.atMs >= passed.atMs)) {
      passed = stop;
    }
  }
  return passed ?? stops[0] ?? null;
}

function modelShownStop(model: Model, stops: readonly ReviewStop[]) {
  const active =
    model.activeStopId !== null
      ? stops.find(stop => stop.id === model.activeStopId)
      : undefined;
  return active ?? modelCurrentStop(stops, model.playhead);
}

/** Earliest unvisited stop with prev < atMs ≤ now (the auto-pause rule). */
function modelNextAutoPause(
  stops: readonly ReviewStop[],
  prev: number,
  now: number,
  visited: ReadonlySet<string>,
) {
  let next: ReviewStop | null = null;
  for (const stop of stops) {
    if (visited.has(stop.id)) continue;
    if (!(stop.atMs > prev && stop.atMs <= now)) continue;
    if (next === null || stop.atMs < next.atMs) next = stop;
  }
  return next;
}

function formatClock(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(2);
}

function modelJump(
  model: Model,
  stops: readonly ReviewStop[],
  ms: number,
  id: string | null,
) {
  model.coverage.jumps += 1;
  model.playing = false;
  model.visited = new Set(stops.filter(s => s.atMs <= ms).map(s => s.id));
  model.playhead = ms;
  model.activeStopId = id;
}

function modelTogglePlay(model: Model) {
  if (model.playing) {
    model.playing = false;
    return;
  }
  if (model.playhead >= model.durationMs - END_TOLERANCE_MS) {
    model.coverage.restarts += 1;
    model.visited.clear();
    model.playhead = 0;
  }
  model.activeStopId = null;
  model.playing = true;
}

/** One JS-clock tick; returns false once playback has stopped. */
function modelTick(model: Model, stops: readonly ReviewStop[]): boolean {
  if (!model.playing) {
    model.coverage.pausedTicks += 1;
    return false;
  }
  model.coverage.ticks += 1;
  const rate = SPEEDS[model.speedIndex]!;
  const next = model.playhead + TICK_MS * rate;
  const prev = model.playhead;
  if (next >= model.durationMs) {
    model.playhead = model.durationMs;
    if (model.autoPause && !model.scrubbing) {
      const stop = modelNextAutoPause(
        stops,
        prev,
        model.durationMs,
        model.visited,
      );
      if (stop) {
        model.visited.add(stop.id);
        model.playhead = stop.atMs;
        model.activeStopId = stop.id;
      }
    }
    // finish(): stop, clear visited, playhead = duration, no active stop.
    model.coverage.finishes += 1;
    model.playing = false;
    model.visited.clear();
    model.playhead = model.durationMs;
    model.activeStopId = null;
    return false;
  }
  model.playhead = next;
  if (model.autoPause && !model.scrubbing) {
    const stop = modelNextAutoPause(stops, prev, next, model.visited);
    if (stop) {
      model.coverage.autoPauses += 1;
      model.visited.add(stop.id);
      model.playing = false;
      model.playhead = stop.atMs;
      model.activeStopId = stop.id;
      return false;
    }
  }
  return true;
}

// ─── Actions ────────────────────────────────────────────────────────────────

type Action =
  | { kind: 'play' }
  | { kind: 'stage' }
  | { kind: 'prev' }
  | { kind: 'next' }
  | { kind: 'speed' }
  | { kind: 'autopause' }
  | { kind: 'layout_stage'; width: number; height: number }
  | { kind: 'layout_timeline'; width: number }
  | { kind: 'scrub_grant'; x: number }
  | { kind: 'scrub_move'; x: number }
  | { kind: 'scrub_release' }
  | { kind: 'tick'; ticks: number }
  | { kind: 'reanalyze' }
  | { kind: 'back' };

function generateAction(rng: Rng, terminal: boolean): Action {
  if (terminal)
    return rng.chance(0.5) ? { kind: 'reanalyze' } : { kind: 'back' };
  const roll = rng.next();
  if (roll < 0.14) return { kind: 'play' };
  if (roll < 0.2) return { kind: 'stage' };
  if (roll < 0.29) return { kind: 'prev' };
  if (roll < 0.4) return { kind: 'next' };
  if (roll < 0.47) return { kind: 'speed' };
  if (roll < 0.54) return { kind: 'autopause' };
  if (roll < 0.58) {
    return {
      kind: 'layout_stage',
      width: rng.pick([0, 320, 360, 390, 430]),
      height: rng.pick([0, 300, 420, 560]),
    };
  }
  if (roll < 0.62) {
    return { kind: 'layout_timeline', width: rng.pick([0, 0, 200, 280, 320]) };
  }
  if (roll < 0.69) return { kind: 'scrub_grant', x: rng.int(-20, 340) };
  if (roll < 0.74) return { kind: 'scrub_move', x: rng.int(-20, 340) };
  if (roll < 0.79) return { kind: 'scrub_release' };
  return { kind: 'tick', ticks: rng.pick([1, 1, 2, 3, 5, 8, 13, 30, 60, 120]) };
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'layout_stage':
      return `layout_stage(${action.width}x${action.height})`;
    case 'layout_timeline':
      return `layout_timeline(${action.width})`;
    case 'scrub_grant':
    case 'scrub_move':
      return `${action.kind}(${action.x})`;
    case 'tick':
      return `tick(${action.ticks})`;
    default:
      return action.kind;
  }
}

// ─── Copy rules (App Store dossier) ─────────────────────────────────────────

const FORBIDDEN_COPY =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?% accura|best-in-class|world.class|#1|as good as a coach|replaces? (a|your) coach/i;

// ─── Sequence runner ────────────────────────────────────────────────────────

interface StepRecord {
  action: string;
  snapshot: string;
}

interface Outcome {
  seed: number;
  variant: EvidenceVariant;
  stops: number;
  length: number;
  coverage: Coverage;
  status: 'HELD' | 'BROKEN';
  failure: string | null;
  failingStep: number | null;
  trace: StepRecord[];
}

class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    detail: string,
  ) {
    super(`${invariant}: ${detail}`);
  }
}

function check(invariant: string, condition: boolean, detail: () => string) {
  if (!condition) throw new InvariantViolation(invariant, detail());
}

const mounted: ReactTestRenderer[] = [];

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function unmountAll() {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
}

async function runSequence(seed: number, length: number): Promise<Outcome> {
  const rng = new Rng(seed);
  const scenario = generateScenario(rng, seed);
  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
  const trace: StepRecord[] = [];
  const base: Omit<Outcome, 'status' | 'failure' | 'failingStep' | 'trace'> = {
    seed,
    variant: scenario.variant,
    stops: 0,
    length,
    coverage: emptyCoverage(),
  };
  let step = 0;
  try {
    clearTryAgainHandoff();
    const stored = await storeScenario(scenario);
    // Reference script from the pure model over what the store really holds:
    // the sidecar sequence when it verified, none otherwise.
    const sequence = stored.sequenceStored
      ? {
          frames: stored.frameTimestamps.map(t => ({
            timestampMs: t,
            confidence: 0.9,
            landmarks: [],
          })),
          video: { width: 1080, height: 1920, fps: 30 },
        }
      : null;
    const script =
      scenario.variant === 'analysis_missing'
        ? null
        : buildFormReviewScript(scenario.analysis, sequence);
    const stops: readonly ReviewStop[] = script?.stops ?? [];
    base.stops = stops.length;

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <Harness
          analysisId={scenario.analysis.id}
          phase={scenario.requestedPhase}
        />,
      );
    });
    mounted.push(renderer);
    await settle();

    let snap = snapshot(renderer);
    trace.push({ action: 'mount', snapshot: JSON.stringify(snap) });
    check(
      'I10-copy',
      !FORBIDDEN_COPY.test(snap.text),
      () => `forbidden copy in: ${snap.text}`,
    );

    if (scenario.variant === 'analysis_missing') {
      // No scored analysis: the screen renders the "Review unavailable"
      // ErrorState (no player, no re-analyze CTA); its single button pops.
      check(
        'I11-route',
        snap.route === 'FormReview' && !snap.mounted,
        () =>
          `expected the unavailable state, got ${snap.route} mounted=${snap.mounted}`,
      );
      check(
        'I9-missing',
        snap.text.includes('Review unavailable') &&
          pressable(renderer, 'form-review-play') === null &&
          pressable(renderer, 'form-review-reanalyze') === null,
        () => `unavailable state not rendered: ${snap.text}`,
      );
      const action: Action = { kind: 'back' };
      const node = pressableByLabel(renderer, 'Try again');
      check('I0-cta', node !== null, () => 'ErrorState retry button missing');
      await act(async () => {
        node!.props.onPress();
      });
      await settle();
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      snap = snapshot(renderer);
      trace.push({ action: 'retry', snapshot: JSON.stringify(snap) });
      checkNavigation(action, snap, scenario, consoleErrors);
      return {
        ...base,
        status: 'HELD',
        failure: null,
        failingStep: null,
        trace,
      };
    }

    check(
      'I11-route',
      snap.route === 'FormReview' && snap.mounted,
      () => `expected FormReview mounted, got ${snap.route}`,
    );
    check(
      'I9-disclosure',
      snap.text.includes(
        'Replay, pose and scoring stay on this device — the clip is never uploaded.',
      ),
      () => 'on-device disclosure missing',
    );

    // Initial stop: the requested phase when the script has a stop there
    // (deep link), otherwise the replay opens at 0 with no frozen stop.
    const initialStop =
      scenario.requestedPhase !== undefined
        ? (stops.find(stop => stop.phase === scenario.requestedPhase) ?? null)
        : null;
    const durationMs = stored.clipStored
      ? scenario.clipDurationMs
      : measuredExtent(scenario.analysis, stops, stored.frameTimestamps);
    const model: Model = {
      durationMs,
      playhead: initialStop?.atMs ?? 0,
      playing: false,
      speedIndex: 0,
      autoPause: true,
      activeStopId: initialStop?.id ?? null,
      visited: new Set(
        initialStop
          ? stops.filter(s => s.atMs <= initialStop.atMs).map(s => s.id)
          : [],
      ),
      scrubbing: false,
      trackWidth: 0,
      coverage: base.coverage,
    };
    // Evidence captions (I9).
    const clipMissingCopy = stored.sequenceStored
      ? 'The clip file is gone from this device; the measured pose is shown instead.'
      : 'No clip file or recorded pose is stored for this stroke on this device.';
    const sidecarMissingCopy =
      'No verified pose sequence is stored for this clip, so the replay shows the video without an exoskeleton.';
    const expectCaption = !stored.clipStored
      ? clipMissingCopy
      : !stored.sequenceStored
        ? sidecarMissingCopy
        : null;
    const assertModel = (label: string) => {
      snap = snapshot(renderer);
      check('I12-console', consoleErrors.length === 0, () =>
        consoleErrors.join('\n'),
      );
      check('I10-copy', !FORBIDDEN_COPY.test(snap.text), () => snap.text);
      check(
        'I9-caption',
        expectCaption === null
          ? !snap.text.includes('is gone from this device') &&
              !snap.text.includes('No clip file') &&
              !snap.text.includes('No verified pose sequence')
          : snap.text.includes(expectCaption),
        () => `caption mismatch after ${label}: ${snap.text}`,
      );
      check(
        'I1-clock',
        model.playhead >= 0 &&
          model.playhead <= model.durationMs &&
          snap.clock === formatClock(model.playhead),
        () =>
          `clock ${snap.clock} ≠ model ${formatClock(model.playhead)} after ${label}; requested=${scenario.requestedPhase} stops=${JSON.stringify(stops.map(s => [s.phase, s.atMs]))} text=${snap.text}`,
      );
      check(
        'I2/I3/I4-playing',
        snap.playing === model.playing,
        () => `playing ${snap.playing} ≠ model ${model.playing} after ${label}`,
      );
      check(
        'I6-speed',
        snap.speed === SPEED_LABELS[model.speedIndex],
        () =>
          `speed ${snap.speed} ≠ ${SPEED_LABELS[model.speedIndex]} after ${label}`,
      );
      check(
        'I6-autopause',
        snap.autoPause === model.autoPause,
        () => `auto ${snap.autoPause} ≠ ${model.autoPause} after ${label}`,
      );
      const shown = modelShownStop(model, stops);
      if (shown) {
        const index = stops.indexOf(shown);
        check(
          'I7-counter',
          snap.stopIndex === index + 1 && snap.stopCount === stops.length,
          () =>
            `counter ${snap.stopIndex}/${snap.stopCount} ≠ ${index + 1}/${stops.length} after ${label}`,
        );
        check(
          'I7-title',
          snap.text.includes(shown.title.toUpperCase()),
          () => `stop title ${shown.title} not shown after ${label}`,
        );
        check(
          'I5-chips',
          snap.prevDisabled === (index === 0) &&
            snap.nextDisabled === (index === stops.length - 1),
          () =>
            `chips prev=${snap.prevDisabled} next=${snap.nextDisabled} at index ${index} after ${label}`,
        );
      } else {
        check(
          'I7-empty',
          snap.stopIndex === null &&
            snap.prevDisabled === true &&
            snap.nextDisabled === true,
          () => `empty script shows a stop after ${label}: ${snap.text}`,
        );
      }
      // I8: recorded frame nearest the playhead within tolerance, never
      // an invented timestamp.
      if (stored.sequenceStored) {
        const nearest = nearestFrame(stored.frameTimestamps, model.playhead);
        check(
          'I8-frame',
          snap.frameTs === nearest,
          () =>
            `frame ${snap.frameTs} ≠ nearest recorded ${nearest} at ${model.playhead} after ${label}`,
        );
      } else {
        check(
          'I8-frame',
          snap.frameTs === null,
          () => `frame shown without a verified sequence after ${label}`,
        );
      }
    };
    assertModel('mount');

    for (step = 1; step <= length; step++) {
      const terminal = step === length;
      const action = generateAction(rng, terminal);
      if (action.kind === 'reanalyze' || action.kind === 'back') {
        await performNavigation(renderer, action, scenario);
        snap = snapshot(renderer);
        trace.push({ action: action.kind, snapshot: JSON.stringify(snap) });
        checkNavigation(action, snap, scenario, consoleErrors);
        break;
      }
      await performAction(renderer, action, model, stops);
      trace.push({
        action: describeAction(action),
        snapshot: JSON.stringify(snapshot(renderer)),
      });
      assertModel(describeAction(action));
    }
    return { ...base, status: 'HELD', failure: null, failingStep: null, trace };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.STRESS_DEBUG)
      console.log(error instanceof Error ? error.stack : error);
    return {
      ...base,
      status: 'BROKEN',
      failure: message,
      failingStep: step,
      trace,
    };
  } finally {
    await unmountAll();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }
}

function nearestFrame(timestamps: readonly number[], t: number): number | null {
  let best: number | null = null;
  for (const ts of timestamps) {
    if (best === null || Math.abs(ts - t) < Math.abs(best - t)) best = ts;
  }
  if (best === null || Math.abs(best - t) > POSE_FRAME_TOLERANCE_MS)
    return null;
  return best;
}

function measuredExtent(
  analysis: ShotAnalysis,
  stops: readonly ReviewStop[],
  frameTimestamps: readonly number[],
): number {
  let end = analysis.timestamps.endMs;
  for (const phase of analysis.phases) end = Math.max(end, phase.endMs);
  for (const stop of stops) end = Math.max(end, stop.endMs);
  const last = frameTimestamps[frameTimestamps.length - 1];
  if (last !== undefined) end = Math.max(end, last);
  return Math.max(1000, end + EXTENT_PAD_MS);
}

async function performAction(
  renderer: ReactTestRenderer,
  action: Action,
  model: Model,
  stops: readonly ReviewStop[],
) {
  const press = async (testID: string) => {
    const node = pressable(renderer, testID);
    check('I0-control', node !== null, () => `control ${testID} missing`);
    if (node!.props.disabled) return false;
    await act(async () => {
      node!.props.onPress();
    });
    return true;
  };
  switch (action.kind) {
    case 'play':
      if (await press('form-review-play')) modelTogglePlay(model);
      return;
    case 'stage':
      if (await press('form-review-stage')) modelTogglePlay(model);
      return;
    case 'prev': {
      const shown = modelShownStop(model, stops);
      const index = shown ? stops.indexOf(shown) : -1;
      const target = index > 0 ? stops[index - 1] : undefined;
      const pressed = await press('form-review-prev-stop');
      check(
        'I5-prev-enabled',
        pressed === (target !== undefined),
        () => `prev enabled=${pressed} target=${target?.id}`,
      );
      if (pressed && target) modelJump(model, stops, target.atMs, target.id);
      return;
    }
    case 'next': {
      const shown = modelShownStop(model, stops);
      const index = shown ? stops.indexOf(shown) : -1;
      const target =
        index >= 0 && index < stops.length - 1 ? stops[index + 1] : undefined;
      const pressed = await press('form-review-next-stop');
      check(
        'I5-next-enabled',
        pressed === (target !== undefined),
        () => `next enabled=${pressed} target=${target?.id}`,
      );
      if (pressed && target) modelJump(model, stops, target.atMs, target.id);
      return;
    }
    case 'speed':
      if (await press('form-review-speed')) {
        model.speedIndex = (model.speedIndex + 1) % SPEEDS.length;
      }
      return;
    case 'autopause':
      if (await press('form-review-autopause'))
        model.autoPause = !model.autoPause;
      return;
    case 'layout_stage': {
      const stage = stageNode(renderer);
      check('I0-stage', stage !== null, () => 'stage missing');
      await act(async () => {
        stage!.props.onLayout({
          nativeEvent: {
            layout: { x: 0, y: 0, width: action.width, height: action.height },
          },
        });
      });
      return;
    }
    case 'layout_timeline': {
      const track = timelineNode(renderer);
      check('I0-timeline', track !== null, () => 'timeline missing');
      await act(async () => {
        track!.props.onLayout({
          nativeEvent: {
            layout: { x: 0, y: 0, width: action.width, height: 24 },
          },
        });
      });
      model.trackWidth = action.width;
      return;
    }
    case 'scrub_grant':
    case 'scrub_move': {
      const track = timelineNode(renderer);
      check('I0-timeline', track !== null, () => 'timeline missing');
      const handler =
        action.kind === 'scrub_grant'
          ? track!.props.onResponderGrant
          : track!.props.onResponderMove;
      await act(async () => {
        handler({ nativeEvent: { locationX: action.x } });
      });
      if (model.trackWidth > 0 && model.durationMs > 0) {
        model.coverage.scrubs += 1;
        model.scrubbing = true;
        const ratio = Math.min(1, Math.max(0, action.x / model.trackWidth));
        modelJump(model, stops, ratio * model.durationMs, null);
      }
      return;
    }
    case 'scrub_release': {
      const track = timelineNode(renderer);
      check('I0-timeline', track !== null, () => 'timeline missing');
      await act(async () => {
        track!.props.onResponderRelease();
      });
      model.scrubbing = false;
      return;
    }
    case 'tick': {
      // One interval period per tick. The player schedules the JS clock with
      // setInterval(TICK_MS) and the fake clock truncates the delay to whole
      // milliseconds, so one period is trunc(TICK_MS) of fake time.
      for (let i = 0; i < action.ticks; i++) {
        await act(async () => {
          jest.advanceTimersByTime(FAKE_TICK_PERIOD_MS);
        });
        if (!modelTick(model, stops)) break;
      }
      // Ticks fired while paused must be no-ops (I2): advance a few more.
      if (!model.playing) {
        await act(async () => {
          jest.advanceTimersByTime(FAKE_TICK_PERIOD_MS * 3);
        });
      }
      return;
    }
    default:
      throw new Error(`unhandled action ${(action as Action).kind}`);
  }
}

async function performNavigation(
  renderer: ReactTestRenderer,
  action: Action,
  scenario: Scenario,
) {
  const testID =
    action.kind === 'reanalyze' ? 'form-review-reanalyze' : 'form-review-back';
  const node = pressable(renderer, testID);
  check('I0-cta', node !== null, () => `CTA ${testID} missing`);
  void scenario;
  await act(async () => {
    node!.props.onPress();
  });
  await settle();
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
}

/**
 * Scheduled timers (timeouts, intervals, immediates, animation frames) still
 * registered on the fake clock. Pending microtask jobs (nextTick /
 * queueMicrotask, which the fake clock also counts) are not timers a screen
 * can leak, so they are excluded.
 */
function liveTimers(): string[] {
  const clock = (
    setTimeout as unknown as {
      clock?: {
        timers?: Record<
          string,
          { type: string; delay: number; func: { toString(): string } }
        >;
      };
    }
  ).clock;
  const timers = clock?.timers;
  if (!timers) {
    return jest.getTimerCount() === 0 ? [] : [`${jest.getTimerCount()} timers`];
  }
  return Object.values(timers).map(
    t => `${t.type}(${t.delay}) ${t.func.toString().slice(0, 160)}`,
  );
}

function checkNavigation(
  action: Action,
  snap: Snapshot,
  scenario: Scenario,
  consoleErrors: string[],
) {
  check('I12-console', consoleErrors.length === 0, () =>
    consoleErrors.join('\n'),
  );
  if (action.kind === 'reanalyze') {
    const handoff = peekTryAgainHandoff();
    check('I11-route', snap.route === 'Analyze', () => `route ${snap.route}`);
    if (scenario.variant === 'analysis_missing') {
      check(
        'I11-handoff',
        handoff === null,
        () => 'handoff armed without an analysis',
      );
      return;
    }
    check(
      'I11-handoff',
      handoff !== null &&
        handoff.source === 'camera' &&
        handoff.declaredStroke === scenario.declaredStroke &&
        handoff.auto === (scenario.declaredStroke === null) &&
        handoff.sessionId === scenario.analysis.sessionId,
      () =>
        `handoff ${JSON.stringify(handoff)} for declared ${scenario.declaredStroke}`,
    );
  } else {
    check(
      'I11-back',
      snap.route === 'Result' && !snap.mounted,
      () => `route ${snap.route} mounted=${snap.mounted}`,
    );
    check(
      'I11-timers',
      liveTimers().length === 0,
      () =>
        `live timers after the screen was popped: ${liveTimers().join(' | ')}`,
    );
    check(
      'I11-handoff',
      peekTryAgainHandoff() === null,
      () => 'handoff armed by back',
    );
  }
}

// ─── Campaign ───────────────────────────────────────────────────────────────

const ITERATIONS = Math.max(1, Number(process.env.STRESS_ITER ?? '24') || 24);
const SEED_BASE =
  Number(process.env.STRESS_SEED_BASE ?? '20260904') || 20260904;
const REPLAY_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const OUT_PATH = process.env.STRESS_OUT ?? null;
/** Every Nth seed is replayed a second time and its trace compared. */
const DETERMINISM_EVERY = Math.max(
  1,
  Number(process.env.STRESS_DETERMINISM_EVERY ?? '25') || 25,
);
const FLAKY_RERUNS = 10;

function sequenceLength(seed: number): number {
  return 5 + new Rng(seed ^ 0x9e3779b9).int(0, 55);
}

async function runIsolated(seed: number, length: number): Promise<Outcome> {
  const outcome = await runSequence(seed, length);
  getDb().close();
  return outcome;
}

/**
 * A sequence is a deterministic function of (seed, length): shorter lengths
 * replay the same action prefix. Minimization is therefore the smallest
 * length that still breaks the same invariant.
 */
async function minimize(broken: Outcome): Promise<Outcome> {
  const invariant = broken.failure?.split(':')[0] ?? '';
  let best = broken;
  let lo = 1;
  let hi = Math.max(1, (broken.failingStep ?? broken.length) - 1);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const attempt = await runIsolated(broken.seed, mid);
    if (attempt.status === 'BROKEN' && attempt.failure?.startsWith(invariant)) {
      best = attempt;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return best;
}

function sumCoverage(outcomes: readonly Outcome[]): Coverage {
  const total = emptyCoverage();
  for (const o of outcomes) {
    for (const key of Object.keys(total) as (keyof Coverage)[]) {
      total[key] += o.coverage[key];
    }
  }
  return total;
}

beforeEach(() => {
  jest.useFakeTimers();
  setActiveDataOwner(GUEST_DATA_OWNER);
});

afterEach(async () => {
  await unmountAll();
  getDb().close();
  jest.useRealTimers();
});

describe('FormReviewScreen · randomized-seeded stress', () => {
  it(
    REPLAY_SEED !== null
      ? `replays seed ${REPLAY_SEED}`
      : `holds every invariant across ${ITERATIONS} seeded sequences`,
    async () => {
      const seeds =
        REPLAY_SEED !== null
          ? [REPLAY_SEED]
          : Array.from({ length: ITERATIONS }, (_, i) => SEED_BASE + i);
      const outcomes: Outcome[] = [];
      const determinismMismatches: number[] = [];
      const heapSamples: { iteration: number; heapUsedMb: number }[] = [];
      let determinismChecked = 0;
      for (const [i, seed] of seeds.entries()) {
        const outcome = await runIsolated(seed, sequenceLength(seed));
        outcomes.push(outcome);
        if (i % 50 === 0 || i === seeds.length - 1) {
          (globalThis as { gc?: () => void }).gc?.();
          heapSamples.push({
            iteration: i + 1,
            heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1e6),
          });
        }
        if (i % DETERMINISM_EVERY === 0 || outcome.status === 'BROKEN') {
          determinismChecked += 1;
          const replay = await runIsolated(seed, sequenceLength(seed));
          if (
            JSON.stringify(replay.trace) !== JSON.stringify(outcome.trace) ||
            replay.status !== outcome.status
          ) {
            determinismMismatches.push(seed);
          }
        }
      }
      const broken = outcomes.filter(o => o.status === 'BROKEN');
      // Every failure: minimize to the shortest breaking prefix and re-run
      // the original 10× to separate deterministic breaks from flakes.
      const failures = [];
      for (const b of broken) {
        const minimized = await minimize(b);
        let reruns = 0;
        for (let r = 0; r < FLAKY_RERUNS; r++) {
          const again = await runIsolated(b.seed, b.length);
          if (again.status === 'BROKEN') reruns += 1;
        }
        failures.push({
          seed: b.seed,
          variant: b.variant,
          length: b.length,
          failingStep: b.failingStep,
          failure: b.failure,
          rerunFailures: `${reruns}/${FLAKY_RERUNS}`,
          minimizedLength: minimized.length,
          minimizedActions: minimized.trace.map(t => t.action),
          minimizedFailure: minimized.failure,
          trace: b.trace,
        });
      }
      if (OUT_PATH) {
        const fs = jest.requireActual<{
          writeFileSync(path: string, body: string): void;
        }>('fs');
        fs.writeFileSync(
          OUT_PATH,
          JSON.stringify(
            {
              unit: 'scr-formreviewscreen',
              lens: 'randomized-seeded',
              seedBase: seeds[0],
              iterations: outcomes.length,
              actions: outcomes.reduce((n, o) => n + o.trace.length - 1, 0),
              coverage: sumCoverage(outcomes),
              variants: outcomes.reduce<Record<string, number>>((acc, o) => {
                acc[o.variant] = (acc[o.variant] ?? 0) + 1;
                return acc;
              }, {}),
              determinism: {
                checked: determinismChecked,
                mismatches: determinismMismatches,
              },
              heapSamples,
              broken: broken.map(o => o.seed),
              table: outcomes.map(o => ({
                seed: o.seed,
                variant: o.variant,
                stops: o.stops,
                length: o.length,
                executed: o.trace.length - 1,
                coverage: o.coverage,
                status: o.status,
                failure: o.failure,
                failingStep: o.failingStep,
              })),
              failures,
            },
            null,
            2,
          ),
        );
      }
      expect(determinismMismatches).toEqual([]);
      expect(
        failures.map(
          f =>
            `seed ${f.seed} step ${f.failingStep} (min ${f.minimizedLength}, reruns ${f.rerunFailures}): ${f.failure}`,
        ),
      ).toEqual([]);
    },
    // Each sequence renders a real navigator + screen; the campaign size
    // scales the budget so a large STRESS_ITER cannot time out spuriously.
    30_000 + ITERATIONS * 6_000,
  );

  it('is deterministic: the same seed twice yields an identical trace', async () => {
    const seed = REPLAY_SEED ?? SEED_BASE + 1;
    const first = await runIsolated(seed, sequenceLength(seed));
    const second = await runIsolated(seed, sequenceLength(seed));
    expect(second.trace).toEqual(first.trace);
    expect(second.status).toBe(first.status);
    expect(first.trace.length).toBeGreaterThan(1);
  });
});
