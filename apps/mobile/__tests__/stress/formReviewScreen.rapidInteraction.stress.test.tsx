/**
 * STRESS · FormReviewScreen · rapid / concurrent interaction.
 *
 * The screen is mounted the way the app mounts it: inside SafeAreaProvider +
 * QueryClientProvider + a REAL `NavigationContainer` / native-stack navigator
 * (Result → FormReview → Analyze), reading REAL evidence written through the
 * production repository into a real SQLite database (node:sqlite behind the
 * op-sqlite seam), through the production `loadStrokeResultEvidence` and the
 * hash-verifying `loadReviewPoseSequence`. Only the native boundaries are
 * mocked: the SQLite driver, the capture-artifact file read, safe-area and
 * svg host views. Store queries and sidecar reads run with seeded latency so
 * every burst can land while a load is still in flight.
 *
 * Each seed generates (test-support/stress/formReviewRapidInteraction.ts) a
 * world, a deep-link phase, a latency profile and 4–14 interaction bursts —
 * same-frame double/triple taps, fast sequential taps, two-finger combos,
 * timeline scrubs, system back, spam navigation (reopen / open twice), fake
 * time — and after EVERY burst checks:
 *
 *   • at most one FormReview route, one Analyze route, one mounted player
 *   • the loading surface is shown only while a store read is in flight
 *   • the Analyze route mounts exactly once per "Re-analyze" intent and each
 *     mount consumes a handoff carrying the original declaration
 *   • FormReview is popped at most once per leave intent, never spuriously
 *   • the surface matches the route's analysisId (ready worlds show the
 *     player, the missing world shows "Review unavailable")
 *
 * and at the end of the iteration: no orphan loading state, playback settled
 * (no orphan interval), no leaked timers after unmount, no console.error /
 * console.warn (act() warnings and everything else), and no unhandled
 * rejection (jest fails the seed's test on one).
 *
 * One console.error is recorded but NOT a violation: React Navigation's
 * dev-only "The action 'GO_BACK' was not handled by any navigator", which a
 * same-batch double/triple press of Close / Back / Try again produces
 * (FormReviewScreen.tsx dispatches one `navigation.goBack()` per press). The
 * navigation outcome is still a single pop; the message is dev-build LogBox
 * noise, so it is counted per seed (`devUnhandledActions`) and surfaced in
 * the summary instead of failing the seed.
 *
 *   default              STRESS_ITER=24 seeds (fast enough for the suite)
 *   campaign             STRESS_ITER=300 npx jest --ci __tests__/stress/formReviewScreen.rapidInteraction.stress.test.tsx
 *   replay one seed      STRESS_ONLY=<seed> npx jest …
 *   results table        STRESS_OUT=<dir> (default apps/mobile/artifacts/stress)
 */
jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: unknown }>(
      'react-native-safe-area-context/jest/mock',
    ).default,
);
jest.mock('react-native-svg', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
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

// ─── Native seams (the ONLY mocks below the screen) ──────────────────────────

// apps/mobile types only `jest` (no @types/node); declare the exact Node
// surface this harness drives, like dbMigrationMalformedOutbox.test.ts does.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };

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
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

/** Seeded I/O latency shared by the SQLite seam and the artifact read. Every
 * pending read is counted so the harness knows when "loading" is honest. */
const mockIo = {
  rng: null as null | { int(min: number, max: number): number },
  maxMs: 0,
  inFlight: 0,
  async delay(): Promise<void> {
    const ms = this.rng && this.maxMs > 0 ? this.rng.int(0, this.maxMs) : 0;
    this.inFlight += 1;
    try {
      if (ms > 0) await new Promise<void>(resolve => setTimeout(resolve, ms));
      else await Promise.resolve();
    } finally {
      this.inFlight -= 1;
    }
  },
};

const mockSqlite = { real: null as DatabaseSync | null };
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const run = (sql: string, params: unknown[]) => {
      const db = mockSqlite.real;
      if (!db) throw new Error('stress harness did not open a database');
      return {
        rows: db.prepare(sql).all(...(params as (string | number | null)[])),
      };
    };
    return {
      executeSync: (sql: string, params: unknown[] = []) => run(sql, params),
      execute: async (sql: string, params: unknown[] = []) => {
        await mockIo.delay();
        return run(sql, params);
      },
      close: () => mockSqlite.real?.close(),
    };
  },
}));

/** Sidecar bytes by uri; a uri that is absent rejects like a missing file. */
const mockArtifacts = new Map<string, string>();
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual<object>('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: async (uri: string) => {
      await mockIo.delay();
      const text = mockArtifacts.get(uri);
      if (text === undefined) throw new Error(`no artifact at ${uri}`);
      return text;
    },
  };
});

import React, { useEffect } from 'react';
import { Text, View } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createNavigationContainerRef,
  NavigationContainer,
  useRoute,
  type NavigationState,
  type RouteProp,
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
import type {
  CapturedClip,
  PoseSequenceSidecarRef,
} from '../../src/camera/capture';
import { setActiveDataOwner } from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import { saveAnalysis, savePendingCapture } from '../../src/data/repository';
import { color } from '../../src/design/tokens';
import type { RootStackParams } from '../../src/navigation/params';
import { FormReviewScreen } from '../../src/screens/FormReviewScreen';
import {
  clearTryAgainHandoff,
  consumeTryAgainHandoff,
  peekTryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import {
  describeStep,
  generateScenario,
  latencySeed,
  Rng,
  WORLD_ANALYSIS_ID,
  WORLDS,
  worldForAnalysisId,
  worldIsReady,
  type IterationResult,
  type Scenario,
  type Step,
  type StepRecord,
  type Target,
  type World,
} from '../../test-support/stress/formReviewRapidInteraction';

// ─── Campaign knobs ──────────────────────────────────────────────────────────

const ITERATIONS = Number(process.env.STRESS_ITER ?? 24);
const ONLY = process.env.STRESS_ONLY ?? null;
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');

function seeds(): number[] {
  if (ONLY !== null) {
    const seed = Number(ONLY);
    if (!Number.isInteger(seed) || seed < 1) {
      throw new Error(
        `STRESS_ONLY must be a positive integer seed, got ${ONLY}`,
      );
    }
    return [seed];
  }
  if (!Number.isInteger(ITERATIONS) || ITERATIONS < 1) {
    throw new Error(
      `STRESS_ITER must be a positive integer, got ${ITERATIONS}`,
    );
  }
  return Array.from({ length: ITERATIONS }, (_, i) => i + 1);
}

// ─── Fixtures: one scored forehand drive per world, written the real way ─────

const OWNER = '22222222-2222-4222-8222-222222222222';
const CLIP_DURATION_MS = 3400;

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

function analysisFor(id: string): ShotAnalysis {
  return {
    id,
    sessionId: null,
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
}

function clipFor(
  uri: string,
  poseSequence?: PoseSequenceSidecarRef,
): CapturedClip {
  return {
    uri,
    durationMs: CLIP_DURATION_MS,
    fps: 59.94,
    width: 1080,
    height: 1920,
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
    ...(poseSequence ? { poseSequence } : {}),
  };
}

function sidecarRef(
  uri: string,
  json: string,
  frameCount: number,
  sha256 = sha256Hex(json),
): PoseSequenceSidecarRef {
  return {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri,
    frameCount,
    sha256,
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
  };
}

/** The stored analysis record in the shape the screen reads
 * (`StrokeResultEvidenceRecord`: every envelope field optional). */
function recordJson(id: string, captureId: string): string {
  return JSON.stringify({
    id,
    captureId,
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
      limitingFactors: [],
    },
  });
}

async function seedWorlds(): Promise<void> {
  setActiveDataOwner(OWNER);
  const db = getDb();
  const { sequence } = generateSwingSequence();
  const json = serializePoseSequence(sequence);
  const frames = sequence.frames.length;

  const worlds: Record<
    Exclude<World, 'missing'>,
    { capture: boolean; sidecar?: PoseSequenceSidecarRef; bytes?: string }
  > = {
    'ready-full': {
      capture: true,
      sidecar: sidecarRef('file:///stress/full.pose.json', json, frames),
      bytes: json,
    },
    'ready-bad-sidecar': {
      capture: true,
      sidecar: sidecarRef(
        'file:///stress/bad.pose.json',
        json,
        frames,
        'ab'.repeat(32),
      ),
      bytes: json,
    },
    'ready-read-fails': {
      capture: true,
      sidecar: sidecarRef('file:///stress/gone.pose.json', json, frames),
      // no bytes registered → the read rejects
    },
    'ready-record-only': { capture: false },
  };

  for (const world of WORLDS) {
    if (world === 'missing') continue;
    const id = WORLD_ANALYSIS_ID[world];
    const captureId = `${id}-capture`;
    const spec = worlds[world];
    await saveAnalysis(db, analysisFor(id), `permit-${id}`);
    if (spec.capture) {
      await savePendingCapture(
        db,
        captureId,
        'forehand_drive',
        clipFor(`file:///stress/${world}.mov`, spec.sidecar),
        'forehand_drive',
      );
    }
    if (spec.sidecar && spec.bytes !== undefined) {
      mockArtifacts.set(spec.sidecar.uri, spec.bytes);
    }
    await db.execute(
      `INSERT INTO local_analysis_record
        (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        OWNER,
        id,
        captureId,
        '2026-09-01T10:00:01.000Z',
        'on-device-fusion-1',
        'sm-v1',
        recordJson(id, captureId),
      ],
    );
  }
}

// ─── The app shell around the screen ─────────────────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const navRef = createNavigationContainerRef<RootStackParams>();

/** What the Analyze route observes (production AnalyzeRoute consumes the
 * handoff on mount; this host does exactly that and records it). */
const probe = {
  analyzeMounts: 0,
  handoffs: [] as (string | null)[],
  analyzeSources: [] as (string | null)[],
  formReviewPops: 0,
  hadFormReview: false,
};

function ResultHost() {
  return (
    <View testID="stress-result-host">
      <Text>Result</Text>
    </View>
  );
}

function AnalyzeHost() {
  const route = useRoute<RouteProp<RootStackParams, 'Analyze'>>();
  useEffect(() => {
    probe.analyzeMounts += 1;
    probe.handoffs.push(consumeTryAgainHandoff()?.declaredStroke ?? null);
    probe.analyzeSources.push(route.params?.source ?? null);
  }, [route.params?.source]);
  return (
    <View testID="stress-analyze-host">
      <Text>Analyze</Text>
    </View>
  );
}

function onNavigationState(state: NavigationState | undefined) {
  const has = state?.routes.some(route => route.name === 'FormReview') ?? false;
  if (probe.hadFormReview && !has) probe.formReviewPops += 1;
  probe.hadFormReview = has;
}

function Shell(props: { client: QueryClient }) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={props.client}>
        <NavigationContainer ref={navRef} onStateChange={onNavigationState}>
          <Stack.Navigator
            initialRouteName="Result"
            screenOptions={{
              headerShown: false,
              animation: 'fade_from_bottom',
              contentStyle: { backgroundColor: color.surface },
            }}
          >
            <Stack.Screen
              name="Result"
              component={ResultHost}
              initialParams={{ analysisId: WORLD_ANALYSIS_ID['ready-full'] }}
              options={{
                title: 'Result',
                contentStyle: { backgroundColor: color.surfaceDark },
              }}
            />
            <Stack.Screen
              name="FormReview"
              component={FormReviewScreen}
              options={{
                title: 'Form review',
                contentStyle: { backgroundColor: color.surfaceDark },
              }}
            />
            <Stack.Screen
              name="Analyze"
              component={AnalyzeHost}
              options={{ title: 'Analyze Shot' }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

// ─── Tree queries ────────────────────────────────────────────────────────────

type Renderer = ReactTestRenderer;

interface PressableNode {
  props: {
    testID?: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
  };
}

function pressables(renderer: Renderer): PressableNode[] {
  return renderer.root.findAll(
    node => typeof node.props.onPress === 'function',
  ) as PressableNode[];
}

const TARGET_QUERY: Record<
  Target,
  { testID?: string; label?: string; labels?: string[] }
> = {
  stage: { testID: 'form-review-stage' },
  play: { labels: ['Play replay', 'Pause replay'], testID: 'form-review-play' },
  next: { testID: 'form-review-next-stop' },
  prev: { testID: 'form-review-prev-stop' },
  speed: { testID: 'form-review-speed' },
  autopause: { testID: 'form-review-autopause' },
  reanalyze: { testID: 'form-review-reanalyze' },
  back: { testID: 'form-review-back' },
  close: { label: 'Close' },
  retry: { label: 'Try again' },
};

/** The first composite pressable for a target — undefined when the control
 * is not on screen. */
function findTarget(
  renderer: Renderer,
  target: Target,
): PressableNode | undefined {
  const query = TARGET_QUERY[target];
  return pressables(renderer).find(node => {
    if (query.testID !== undefined && node.props.testID === query.testID) {
      return true;
    }
    if (query.label !== undefined) {
      return node.props.accessibilityLabel === query.label;
    }
    return false;
  });
}

function countHost(renderer: Renderer, testID: string): number {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  ).length;
}

function hasText(renderer: Renderer, needle: string): boolean {
  return renderer.root
    .findAllByType(Text)
    .some(node =>
      String(
        Array.isArray(node.props.children)
          ? node.props.children.join('')
          : (node.props.children ?? ''),
      ).includes(needle),
    );
}

function playLabel(renderer: Renderer): string | null {
  return findTarget(renderer, 'play')?.props.accessibilityLabel ?? null;
}

function routeNames(): string[] {
  if (!navRef.isReady()) return [];
  const state: NavigationState | undefined = navRef.getRootState();
  return state?.routes.map(route => route.name) ?? [];
}

function focusedRoute(): { name: string; analysisId: string | null } | null {
  if (!navRef.isReady()) return null;
  const route = navRef.getCurrentRoute();
  if (!route) return null;
  const params = (route.params ?? {}) as { analysisId?: string };
  return { name: route.name, analysisId: params.analysisId ?? null };
}

// ─── Act helpers ─────────────────────────────────────────────────────────────

/** Async act + enough microtask hops for a chained store read to reach its
 * next timer (so `mockIo.inFlight` is truthful when the batch returns). */
async function batch(run: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await run();
    for (let i = 0; i < 16; i++) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  if (ms <= 0) {
    await batch(() => undefined);
    return;
  }
  // Step in slices so timers scheduled by resolved reads fire in order.
  let remaining = ms;
  while (remaining > 0) {
    const slice = Math.min(remaining, 50);
    await batch(() => {
      jest.advanceTimersByTime(slice);
    });
    remaining -= slice;
  }
}

function layoutAll(renderer: Renderer): void {
  const stage = renderer.root.findAll(
    node =>
      node.props.testID === 'form-review-stage' &&
      typeof node.props.onLayout === 'function',
  )[0];
  stage?.props.onLayout({
    nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 640 } },
  });
  const track = renderer.root.findAll(
    node =>
      node.props.testID === 'form-review-timeline' &&
      typeof node.props.onLayout === 'function',
  )[0];
  track?.props.onLayout({
    nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 24 } },
  });
  const label = renderer.root.findAll(
    node =>
      node.props.testID === 'form-review-arrow-label' &&
      typeof node.props.onLayout === 'function',
  )[0];
  label?.props.onLayout({
    nativeEvent: { layout: { x: 0, y: 0, width: 120, height: 28 } },
  });
}

function timelineNode(renderer: Renderer) {
  return renderer.root.findAll(
    node =>
      node.props.testID === 'form-review-timeline' &&
      typeof node.props.onResponderGrant === 'function',
  )[0];
}

// ─── One iteration ───────────────────────────────────────────────────────────

const LEAVE_TARGETS: readonly Target[] = ['back', 'close', 'retry'];

interface Live {
  renderer: Renderer;
  violations: string[];
  reanalyzeIntents: number;
  leaveIntents: number;
  /** Batches after which FormReview's replay was still running while the
   * Analyze route was focused above it (observation, not a violation). */
  playbackWhileUnfocused: number;
}

function snapshot(live: Live): string {
  const focused = focusedRoute();
  const players = countHost(live.renderer, 'form-review-player');
  const loading = countHost(live.renderer, 'stroke-result-analyzing');
  return `routes=${routeNames().join('>')} focus=${focused?.name ?? '-'} players=${players} loading=${loading} io=${mockIo.inFlight} play=${playLabel(live.renderer) ?? '-'}`;
}

/** Invariants that must hold after every committed batch. */
function checkAfterBatch(live: Live, label: string): void {
  const routes = routeNames();
  const formReviews = routes.filter(name => name === 'FormReview').length;
  const analyzes = routes.filter(name => name === 'Analyze').length;
  const players = countHost(live.renderer, 'form-review-player');
  const loading = countHost(live.renderer, 'stroke-result-analyzing');
  const v = live.violations;
  if (formReviews > 1)
    v.push(`${label}: ${formReviews} FormReview routes on the stack`);
  if (analyzes > 1) v.push(`${label}: ${analyzes} Analyze routes on the stack`);
  if (players > 1) v.push(`${label}: ${players} players mounted`);
  if (loading > 1) v.push(`${label}: ${loading} loading surfaces mounted`);
  if (formReviews === 0 && (players > 0 || loading > 0)) {
    v.push(
      `${label}: FormReview left the stack but its surface is still mounted`,
    );
  }
  if (loading > 0 && mockIo.inFlight === 0) {
    v.push(
      `${label}: loading surface with no store read in flight (orphan loading)`,
    );
  }
  if (loading > 0 && players > 0) {
    v.push(`${label}: loading surface and player mounted together`);
  }
  if (probe.analyzeMounts > live.reanalyzeIntents) {
    v.push(
      `${label}: Analyze mounted ${probe.analyzeMounts}× for ${live.reanalyzeIntents} re-analyze intent(s)`,
    );
  }
  if (probe.formReviewPops > live.leaveIntents) {
    v.push(
      `${label}: FormReview popped ${probe.formReviewPops}× for ${live.leaveIntents} leave intent(s)`,
    );
  }
  if (
    focusedRoute()?.name === 'Analyze' &&
    players > 0 &&
    playLabel(live.renderer) === 'Pause replay'
  ) {
    live.playbackWhileUnfocused += 1;
  }
}

/** Invariants that must hold once fake time has fully drained. */
function checkSettled(live: Live): void {
  const v = live.violations;
  const focused = focusedRoute();
  const players = countHost(live.renderer, 'form-review-player');
  const loading = countHost(live.renderer, 'stroke-result-analyzing');
  if (loading > 0)
    v.push('settled: loading surface still mounted (orphan loading)');
  if (mockIo.inFlight !== 0)
    v.push(`settled: ${mockIo.inFlight} store read(s) still in flight`);
  if (focused?.name === 'FormReview') {
    const world = focused.analysisId
      ? worldForAnalysisId(focused.analysisId)
      : null;
    if (!world) {
      v.push(
        `settled: FormReview focused on unknown analysisId ${focused.analysisId}`,
      );
    } else if (worldIsReady(world)) {
      if (players !== 1)
        v.push(`settled: ${world} focused but ${players} player(s) mounted`);
      if (hasText(live.renderer, 'Review unavailable')) {
        v.push(`settled: ${world} focused but "Review unavailable" shown`);
      }
      const expectCaption =
        world === 'ready-full'
          ? null
          : world === 'ready-record-only'
            ? 'No clip file or recorded pose is stored'
            : 'No verified pose sequence is stored';
      if (expectCaption && !hasText(live.renderer, expectCaption)) {
        v.push(`settled: ${world} focused without its honest stage caption`);
      }
      if (
        world === 'ready-full' &&
        (hasText(live.renderer, 'No verified pose sequence') ||
          hasText(live.renderer, 'No clip file'))
      ) {
        v.push(
          'settled: ready-full focused but a degraded-evidence caption is shown',
        );
      }
      const play = playLabel(live.renderer);
      if (play !== 'Play replay') {
        v.push(
          `settled: playback did not come to rest (play control reads "${play}")`,
        );
      }
    } else {
      if (players !== 0)
        v.push(`settled: missing world focused but a player is mounted`);
      if (!hasText(live.renderer, 'Review unavailable')) {
        v.push('settled: missing world focused without "Review unavailable"');
      }
    }
  } else if (
    !routeNames().includes('FormReview') &&
    (players > 0 || loading > 0)
  ) {
    v.push(
      `settled: FormReview left the stack (${focused?.name ?? '-'} focused) but its surface is mounted`,
    );
  } else if (players > 0 && playLabel(live.renderer) !== 'Play replay') {
    // FormReview sits under the Analyze route (native-stack keeps it mounted)
    v.push(
      `settled: unfocused FormReview playback did not come to rest (play control reads "${playLabel(live.renderer)}")`,
    );
  }
  if (probe.analyzeMounts !== live.reanalyzeIntents) {
    v.push(
      `settled: Analyze mounted ${probe.analyzeMounts}× for ${live.reanalyzeIntents} re-analyze intent(s)`,
    );
  }
  probe.handoffs.forEach((stroke, index) => {
    if (stroke !== 'forehand_drive') {
      v.push(
        `settled: Analyze mount #${index + 1} consumed handoff declaredStroke=${stroke}`,
      );
    }
  });
  probe.analyzeSources.forEach((source, index) => {
    if (source !== 'camera') {
      v.push(
        `settled: Analyze mount #${index + 1} opened with source=${source}`,
      );
    }
  });
  if (probe.analyzeMounts === 0 && peekTryAgainHandoff() !== null) {
    v.push('settled: a try-again handoff is armed but Analyze never opened');
  }
  if (probe.formReviewPops > live.leaveIntents) {
    v.push(
      `settled: FormReview popped ${probe.formReviewPops}× for ${live.leaveIntents} leave intent(s)`,
    );
  }
}

function press(node: PressableNode | undefined): boolean {
  if (!node || node.props.disabled === true || !node.props.onPress)
    return false;
  node.props.onPress();
  return true;
}

/** A press only counts as an intent when the control is on the focused
 * FormReview (a user cannot tap a screen underneath the Analyze route). */
function formReviewFocused(): boolean {
  return focusedRoute()?.name === 'FormReview';
}

/** FormReview is opened from Result (ResultScreen.tsx / ResultDetailsScreen
 * `navigation.navigate('FormReview', …)`) or re-targeted while already open;
 * the Analyze route has no entry to it. */
function canOpenFormReview(): boolean {
  const name = focusedRoute()?.name;
  return name === 'Result' || name === 'FormReview';
}

// ─── Timer census ────────────────────────────────────────────────────────────

type TimerFn = (...args: unknown[]) => unknown;
type TimerGlobals = Record<
  'setTimeout' | 'setInterval' | 'clearTimeout' | 'clearInterval',
  TimerFn
>;

/** Attributes every timer the screen, the navigator and the harness create
 * during an iteration to its call site, so an interval or timeout that
 * outlives the unmount is named — React's own scheduler task and the RN
 * jest preset's internal timers hold captured references and are not
 * counted (they are the constant background the bare navigator leaves). */
class TimerCensus {
  private readonly live = new Map<unknown, string>();
  private readonly saved: TimerGlobals;
  private readonly globals = globalThis as unknown as TimerGlobals;

  constructor() {
    this.saved = {
      setTimeout: this.globals.setTimeout,
      setInterval: this.globals.setInterval,
      clearTimeout: this.globals.clearTimeout,
      clearInterval: this.globals.clearInterval,
    };
    const wrapCreate = (name: 'setTimeout' | 'setInterval') => {
      const original = this.saved[name];
      this.globals[name] = (...args: unknown[]) => {
        const [callback, ...rest] = args;
        const handle: { id: unknown } = { id: undefined };
        const fire = (...callArgs: unknown[]) => {
          if (name === 'setTimeout') this.live.delete(handle.id);
          if (typeof callback === 'function') callback(...callArgs);
        };
        const id = original(fire, ...rest);
        handle.id = id;
        this.live.set(
          id,
          `${name} ${TimerCensus.site(new Error().stack ?? '')}`,
        );
        return id;
      };
    };
    const wrapClear = (name: 'clearTimeout' | 'clearInterval') => {
      const original = this.saved[name];
      this.globals[name] = (...args: unknown[]) => {
        this.live.delete(args[0]);
        return original(...args);
      };
    };
    wrapCreate('setTimeout');
    wrapCreate('setInterval');
    wrapClear('clearTimeout');
    wrapClear('clearInterval');
  }

  /** First stack frame inside app source, the navigator or the harness. */
  private static site(stack: string): string {
    const frame = stack
      .split('\n')
      .map(line => line.trim())
      .find(
        line =>
          line.includes('/src/') ||
          line.includes('@react-navigation') ||
          line.includes('react-native-screens') ||
          line.includes('__tests__/stress'),
      );
    return (frame ?? 'unattributed')
      .replace(/^at /, '')
      .replace(/.*apps\/mobile\//, '');
  }

  /** Live timers created through the wrapped globals. */
  outstanding(): string[] {
    return [...this.live.values()];
  }

  restore(): void {
    this.globals.setTimeout = this.saved.setTimeout;
    this.globals.setInterval = this.saved.setInterval;
    this.globals.clearTimeout = this.saved.clearTimeout;
    this.globals.clearInterval = this.saved.clearInterval;
  }
}

async function runStep(
  live: Live,
  step: Step,
  index: number,
): Promise<StepRecord> {
  const label = `step${index + 1}(${describeStep(step)})`;
  let landed = 0;
  const { renderer } = live;
  const noteIntent = (target: Target, count: number) => {
    if (count === 0) return;
    if (target === 'reanalyze') live.reanalyzeIntents += 1;
    if (LEAVE_TARGETS.includes(target)) live.leaveIntents += 1;
  };
  switch (step.kind) {
    case 'tap': {
      if (formReviewFocused()) {
        await batch(() => {
          for (let i = 0; i < step.count; i++) {
            if (press(findTarget(renderer, step.target))) landed += 1;
          }
        });
        noteIntent(step.target, landed);
      }
      break;
    }
    case 'tap-sequential': {
      if (formReviewFocused()) {
        await batch(() => {
          if (press(findTarget(renderer, step.target))) landed += 1;
        });
        noteIntent(step.target, landed);
        checkAfterBatch(live, `${label}#1`);
        if (formReviewFocused()) {
          let second = 0;
          await batch(() => {
            if (press(findTarget(renderer, step.target))) second += 1;
          });
          landed += second;
          noteIntent(step.target, second);
        }
      }
      break;
    }
    case 'combo': {
      if (formReviewFocused()) {
        const hits: Target[] = [];
        await batch(() => {
          for (const target of step.targets) {
            if (press(findTarget(renderer, target))) hits.push(target);
          }
        });
        landed = hits.length;
        for (const target of hits) noteIntent(target, 1);
      }
      break;
    }
    case 'scrub': {
      if (formReviewFocused()) {
        const track = timelineNode(renderer);
        if (track) {
          await batch(() => {
            const event = { nativeEvent: { locationX: step.ratio * 300 } };
            track.props.onResponderGrant(event);
            track.props.onResponderMove(event);
            if (step.release) track.props.onResponderRelease(event);
          });
          landed = 1;
        }
      }
      break;
    }
    case 'layout':
      await batch(() => layoutAll(renderer));
      break;
    case 'advance':
      await advance(step.ms);
      break;
    case 'sys-back': {
      if (navRef.isReady() && navRef.canGoBack()) {
        const leavingFormReview = formReviewFocused();
        await batch(() => {
          navRef.goBack();
        });
        landed = 1;
        if (leavingFormReview) live.leaveIntents += 1;
      }
      break;
    }
    case 'reopen': {
      if (canOpenFormReview()) {
        await batch(() => {
          navRef.navigate('FormReview', {
            analysisId: WORLD_ANALYSIS_ID[step.world],
            ...(step.phase ? { phase: step.phase } : {}),
          });
        });
        landed = 1;
      }
      break;
    }
    case 'open-twice': {
      if (canOpenFormReview()) {
        await batch(() => {
          navRef.navigate('FormReview', {
            analysisId: WORLD_ANALYSIS_ID[step.world],
          });
          navRef.navigate('FormReview', {
            analysisId: WORLD_ANALYSIS_ID[step.world],
          });
        });
        landed = 2;
      }
      break;
    }
    case 'flush':
      await batch(() => undefined);
      break;
  }
  checkAfterBatch(live, label);
  return { step: describeStep(step), landed, after: snapshot(live) };
}

/** Longest a load can take: 5 sequential reads × max latency, plus the
 * slowest playback (¼× over the clip) so playback provably comes to rest. */
function settleBudgetMs(scenario: Scenario): number {
  return 5 * scenario.latencyMaxMs + CLIP_DURATION_MS * 4 + 500;
}

async function runIteration(scenario: Scenario): Promise<IterationResult> {
  const started = Date.now();
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' ').split('\n')[0] ?? '');
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleWarnings.push(args.map(String).join(' ').split('\n')[0] ?? '');
    });

  const census = new TimerCensus();
  mockIo.rng = new Rng(latencySeed(scenario.seed));
  mockIo.maxMs = scenario.latencyMaxMs;
  mockIo.inFlight = 0;
  probe.analyzeMounts = 0;
  probe.handoffs = [];
  probe.analyzeSources = [];
  probe.formReviewPops = 0;
  probe.hadFormReview = false;
  clearTryAgainHandoff();

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const steps: StepRecord[] = [];
  let renderer!: Renderer;
  let outcome: IterationResult['outcome'] = 'held';
  let error: string | undefined;
  let finalRoutes: string[] = [];
  const live: Live = {
    renderer: undefined as unknown as Renderer,
    violations: [],
    reanalyzeIntents: 0,
    leaveIntents: 0,
    playbackWhileUnfocused: 0,
  };
  try {
    await batch(() => {
      renderer = TestRenderer.create(<Shell client={client} />);
    });
    live.renderer = renderer;
    await batch(() => {
      navRef.navigate('FormReview', {
        analysisId: WORLD_ANALYSIS_ID[scenario.world],
        ...(scenario.phase ? { phase: scenario.phase } : {}),
      });
    });
    checkAfterBatch(live, 'open');
    steps.push({
      step: `open:${scenario.world}${scenario.phase ? ':' + scenario.phase : ''}`,
      landed: 1,
      after: snapshot(live),
    });
    await advance(scenario.openGapMs);
    checkAfterBatch(live, 'open-gap');

    for (let i = 0; i < scenario.steps.length; i++) {
      steps.push(await runStep(live, scenario.steps[i]!, i));
      const gapMs = scenario.gaps[i] ?? 0;
      await advance(gapMs);
      checkAfterBatch(live, `gap${i + 1}(${gapMs}ms)`);
    }

    await advance(settleBudgetMs(scenario));
    await batch(() => undefined);
    checkSettled(live);
    finalRoutes = routeNames();
    steps.push({ step: 'settle', landed: 0, after: snapshot(live) });

    await batch(() => {
      renderer.unmount();
    });
    // A fired one-shot that was never cleared is not a leak; an interval or
    // a re-arming timeout is. Fire what is pending once, then look.
    await batch(() => {
      jest.runOnlyPendingTimers();
    });
    const leaked = census.outstanding();
    if (leaked.length > 0) {
      live.violations.push(
        `unmount: ${leaked.length} timer(s) still alive after unmount: ${leaked.join('; ')}`,
      );
    }
    if (mockIo.inFlight !== 0) {
      live.violations.push(
        `unmount: ${mockIo.inFlight} store read(s) still in flight`,
      );
    }
  } catch (caught) {
    outcome = 'crashed';
    error =
      caught instanceof Error
        ? `${caught.name}: ${caught.message}`
        : String(caught);
    try {
      await batch(() => renderer?.unmount());
    } catch {
      // the renderer is already gone; the crash above is what matters
    }
  } finally {
    census.restore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    client.clear();
    jest.clearAllTimers();
  }

  const violations = [...live.violations];
  let devUnhandledActions = 0;
  for (const line of consoleErrors) {
    if (
      line.includes("The action 'GO_BACK' was not handled by any navigator")
    ) {
      devUnhandledActions += 1;
    } else {
      violations.push(`console.error: ${line}`);
    }
  }
  for (const line of consoleWarnings) violations.push(`console.warn: ${line}`);
  if (outcome === 'held' && violations.length > 0) outcome = 'broken';

  return {
    seed: scenario.seed,
    world: scenario.world,
    phase: scenario.phase ?? null,
    latencyMaxMs: scenario.latencyMaxMs,
    outcome,
    violations,
    consoleErrors,
    consoleWarnings,
    reanalyzeIntents: live.reanalyzeIntents,
    analyzeMounts: probe.analyzeMounts,
    handoffsConsumed: [...probe.handoffs],
    leaveIntents: live.leaveIntents,
    formReviewPops: probe.formReviewPops,
    playbackWhileUnfocused: live.playbackWhileUnfocused,
    devUnhandledActions,
    finalRoutes,
    steps,
    elapsedMs: Date.now() - started,
    ...(error !== undefined ? { error } : {}),
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const results: IterationResult[] = [];

beforeAll(async () => {
  mockSqlite.real = new DatabaseSync(':memory:');
  await seedWorlds();
});

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

afterAll(() => {
  getDb().close();
  mockSqlite.real = null;
  if (results.length === 0) return;
  mkdirSync(OUT_DIR, { recursive: true });
  const held = results.filter(r => r.outcome === 'held').length;
  const broken = results.filter(r => r.outcome === 'broken');
  const crashed = results.filter(r => r.outcome === 'crashed');
  const summary = {
    unit: 'scr-formreviewscreen',
    lens: 'rapid-interaction',
    iterations: results.length,
    stepsExecuted: results.reduce((sum, r) => sum + r.steps.length, 0),
    held,
    broken: broken.map(r => r.seed),
    crashed: crashed.map(r => r.seed),
    seedsWithDevUnhandledGoBack: results
      .filter(r => r.devUnhandledActions > 0)
      .map(r => r.seed),
    seedsWithPlaybackWhileUnfocused: results
      .filter(r => r.playbackWhileUnfocused > 0)
      .map(r => r.seed),
    reanalyzeIntents: results.reduce((sum, r) => sum + r.reanalyzeIntents, 0),
    analyzeMounts: results.reduce((sum, r) => sum + r.analyzeMounts, 0),
    leaveIntents: results.reduce((sum, r) => sum + r.leaveIntents, 0),
    formReviewPops: results.reduce((sum, r) => sum + r.formReviewPops, 0),
    pressesLanded: results.reduce(
      (sum, r) => sum + r.steps.reduce((acc, s) => acc + s.landed, 0),
      0,
    ),
    violationKinds: Object.entries(
      results
        .flatMap(r => r.violations)
        .reduce<Record<string, number>>((acc, line) => {
          const kind = line.replace(/^[^:]*: /, '').replace(/\d+/g, 'N');
          acc[kind] = (acc[kind] ?? 0) + 1;
          return acc;
        }, {}),
    ).sort((a, b) => b[1] - a[1]),
    replay:
      'STRESS_ONLY=<seed> npx jest --ci __tests__/stress/formReviewScreen.rapidInteraction.stress.test.tsx',
  };
  writeFileSync(
    join(OUT_DIR, 'formReviewScreen.rapidInteraction.summary.json'),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, 'formReviewScreen.rapidInteraction.results.json'),
    JSON.stringify(results, null, 2),
  );
});

describe('FormReviewScreen · worlds are what they claim (oracle sanity)', () => {
  it.each(WORLDS)('%s renders its honest surface', async world => {
    const result = await runIteration({
      seed: 0,
      world,
      phase: undefined,
      latencyMaxMs: 0,
      openGapMs: 0,
      steps: [{ kind: 'layout' }, { kind: 'advance', ms: 100 }],
      gaps: [0, 0],
    });
    expect(result.violations).toEqual([]);
    expect(result.outcome).toBe('held');
  });
});

/**
 * Minimized from campaign seed 177 (STRESS_ONLY=177). "Analyze again" and
 * Back/Close pressed in the SAME batch: FormReviewScreen arms the try-again
 * handoff and dispatches `navigate('Analyze')`, then `goBack()` lands in the
 * same reducer pass and removes the just-pushed Analyze route before it ever
 * mounts. The user stays on Form Review with nothing visibly happening, while
 * the armed handoff (declaration + practice set) stays live for
 * TRY_AGAIN_HANDOFF_TTL_MS and is consumed by the NEXT `source: 'camera'`
 * Analyze open — Home's CTA or the tab bar — seeding an unrelated capture.
 * Pinned with `test.failing` so the suite stays green until the screen
 * guards the second press; flip to `it` when it is fixed.
 */
describe('FormReviewScreen · minimized repro (seed 177)', () => {
  const READY_MS = 250;

  it('control: Analyze again then Back in separate batches opens Analyze once', async () => {
    const result = await runIteration({
      seed: 177,
      world: 'ready-full',
      phase: undefined,
      latencyMaxMs: 0,
      openGapMs: READY_MS,
      steps: [
        { kind: 'tap', target: 'reanalyze', count: 1 },
        { kind: 'tap', target: 'back', count: 1 },
      ],
      gaps: [0, 0],
    });
    expect(result.violations).toEqual([]);
    expect(result.analyzeMounts).toBe(1);
    expect(result.handoffsConsumed).toEqual(['forehand_drive']);
  });

  it.failing.each([['back'], ['close']] as const)(
    'same-batch Analyze again + %s opens Analyze exactly once',
    async leave => {
      const result = await runIteration({
        seed: 177,
        world: 'ready-full',
        phase: undefined,
        latencyMaxMs: 0,
        openGapMs: READY_MS,
        steps: [{ kind: 'combo', targets: ['reanalyze', leave] }],
        gaps: [0],
      });
      expect(result.violations).toEqual([]);
      expect(result.analyzeMounts).toBe(1);
    },
  );

  it('same-batch Analyze again + Back: what actually happens', async () => {
    const result = await runIteration({
      seed: 177,
      world: 'ready-full',
      phase: undefined,
      latencyMaxMs: 0,
      openGapMs: READY_MS,
      steps: [{ kind: 'combo', targets: ['reanalyze', 'back'] }],
      gaps: [0],
    });
    expect(result.reanalyzeIntents).toBe(1);
    expect(result.leaveIntents).toBe(1);
    expect(result.analyzeMounts).toBe(0);
    expect(result.formReviewPops).toBe(0);
    expect(result.finalRoutes).toEqual(['Result', 'FormReview']);
    expect(result.violations).toEqual([
      'settled: Analyze mounted 0× for 1 re-analyze intent(s)',
      'settled: a try-again handoff is armed but Analyze never opened',
    ]);
  });
});

describe('FormReviewScreen · rapid-interaction campaign', () => {
  it.each(seeds())(
    'seed %i holds every rapid-interaction invariant',
    async seed => {
      const scenario = generateScenario(seed);
      const result = await runIteration(scenario);
      results.push(result);
      if (result.outcome !== 'held') {
        throw new Error(
          `seed ${seed} ${result.outcome} (${scenario.world}, latency≤${scenario.latencyMaxMs}ms)\n` +
            `steps: ${result.steps.map(s => s.step).join(' → ')}\n` +
            `violations:\n  ${result.violations.join('\n  ')}` +
            (result.error ? `\nerror: ${result.error}` : ''),
        );
      }
    },
  );
});
