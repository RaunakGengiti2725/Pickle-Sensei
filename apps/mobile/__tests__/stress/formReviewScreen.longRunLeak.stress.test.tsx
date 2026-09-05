/**
 * STRESS · LONG-RUN LEAK — FormReviewScreen mounted in the REAL navigator.
 *
 * The full Form Review route is mounted and torn down hundreds of times in
 * ONE process: the real `NavigationContainer` + `createNativeStackNavigator`
 * (the app's own stack, the `FormReview` screen registered exactly as
 * RootNavigator does), the real `SafeAreaProvider` / `QueryClientProvider`
 * layering App.tsx uses, the production `getDb()` + `LOCAL_MIGRATIONS`
 * running against a REAL SQLite database (node:sqlite standing in for the
 * op-sqlite native binding), the production repository writers seeding the
 * rows, the real `loadStrokeResultEvidence` / `loadReviewPoseSequence`
 * (SHA-256 verified sidecar via the native `readTextFile` bridge), the real
 * player, overlay, arrow pulse and try-again handoff. Only native modules
 * are replaced (op-sqlite, the capture bridge, safe-area insets, SVG, the
 * clip player host view is jest's generic host component).
 *
 * Every iteration is planned from its seed (`planIteration`): which stored
 * stroke opens, the phase deep-link, 0–8 interactions (stops, play, speed,
 * AUTO, layout, scrub, native progress/error events, clock ticks) and how
 * the screen leaves (unmount, the real Back CTA → navigator pop, or
 * Re-analyze → handoff armed + push). After every iteration the fake-timer
 * count must be back to zero (JS replay clock, arrow pulse, spinner loop,
 * navigator timers all released). Every 50 iterations the heap is forced
 * through GC and sampled with the active-resource histogram and the number
 * of unmounted renderer roots still reachable (WeakRef).
 *
 * Scale:   STRESS_ITER=<n>   iterations (default 40 — fast enough for the suite)
 *          the ≥500 campaign needs `node --expose-gc` (NODE_OPTIONS=--expose-gc)
 * Replay:  STRESS_SEED=<seed>  runs exactly that one seed (plus STRESS_REPEAT=<k>)
 * Output:  STRESS_OUT=<dir>  raw JSON (default artifacts/stress)
 *
 * Findings (campaign mode, ≥200 iterations): heap slope > 5 % per 100
 * iterations after warm-up, any live renderer root after GC, any timer left
 * after unmount, a render-time drift > 50 % between the first and last
 * fifth, or any iteration that throws. Every failing seed is reported with
 * its plan and the exact replay command.
 */
import type { LocalDb } from '../../src/data/db';

// Node built-ins for the raw artifacts and the real SQLite file. The mobile
// tsconfig excludes node typings (see matrix/networkAuthMatrix.test.ts), so
// the shims stay local to this file.
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
    arrayBuffers: number;
  };
  getActiveResourcesInfo?: () => string[];
  hrtime: { bigint(): bigint };
};
declare const global: { gc?: () => void };
declare class WeakRef<T extends object> {
  constructor(target: T);
  deref(): T | undefined;
}

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

// ─── Native modules only ────────────────────────────────────────────────────

// op-sqlite (native binding) → a real in-memory SQLite through node:sqlite.
// The production getDb() runs every LOCAL_MIGRATION and the account-scoped
// schema upgrade against it, exactly as on device.
const mockSqliteState: { db: DatabaseSync | null; statements: number } = {
  db: null,
  statements: 0,
};
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const { DatabaseSync: RealDatabaseSync } = jest.requireActual(
      'node:sqlite',
    ) as { DatabaseSync: new (location: string) => DatabaseSync };
    const real = new RealDatabaseSync(':memory:');
    mockSqliteState.db = real;
    return {
      executeSync: (sql: string) => {
        mockSqliteState.statements += 1;
        return { rows: real.prepare(sql).all() };
      },
      execute: async (sql: string, params: unknown[] = []) => {
        mockSqliteState.statements += 1;
        return {
          rows: real
            .prepare(sql)
            .all(...(params as (string | number | null)[])),
        };
      },
      close: () => real.close(),
    };
  },
}));

// The capture bridge (PickleVideoCapture native module): only the private
// artifact reader the sidecar loader needs. Files are keyed by URI so a
// missing or tampered sidecar is a real read outcome, not a stubbed loader.
const mockArtifactFiles = new Map<string, string>();
const mockArtifactReads: string[] = [];
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native') as {
    NativeModules: Record<string, unknown>;
    UIManager: { getViewManagerConfig: (name: string) => unknown };
  };
  // The clip player is a native view (PickleClipPlayerView). Advertise it so
  // FormReviewPlayer mounts the real ClipPlayer host and its progress /
  // load / end / error callbacks are live (the preset renders the host as
  // an inert component of that name), instead of the poster-still fallback.
  const viewManagerConfig = RN.UIManager.getViewManagerConfig;
  RN.UIManager.getViewManagerConfig = (name: string) =>
    name === 'PickleClipPlayerView'
      ? { Commands: {} }
      : viewManagerConfig.call(RN.UIManager, name);
  RN.NativeModules['PickleVideoCapture'] = {
    readTextFile: async (uri: string) => {
      mockArtifactReads.push(uri);
      const body = mockArtifactFiles.get(uri);
      if (body === undefined) throw new Error(`ENOENT ${uri}`);
      return body;
    },
    addListener: () => {},
    removeListeners: () => {},
  };
  return RN;
});

// Safe-area insets come from a native view manager; the package's own jest
// mock keeps the real context/provider API with fixed metrics.
jest.mock(
  'react-native-safe-area-context',
  () =>
    (
      jest.requireActual('react-native-safe-area-context/jest/mock') as {
        default: unknown;
      }
    ).default,
);

// SVG primitives are native views; inert host views keep the overlay tree.
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

import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import { FormReviewScreen } from '../../src/screens/FormReviewScreen';
import type { RootStackParams } from '../../src/navigation/params';
import { color } from '../../src/design/tokens';
import { getDb } from '../../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { saveAnalysis, savePendingCapture } from '../../src/data/repository';
import {
  clearTryAgainHandoff,
  peekTryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import {
  ANALYSIS_ID,
  CAPTURE_ID,
  SIDECAR_URI,
  heapSlope,
  makeAnalysis,
  makeClip,
  makeRecord,
  makeSidecarRef,
  planIteration,
  timeDrift,
  type Action,
  type HeapSample,
  type IterationPlan,
} from '../../test-support/stress/formReviewLeakHarness';

const { mkdirSync, writeFileSync } = jest.requireActual<{
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
}>('fs');
const { join } = jest.requireActual<{
  join: (...parts: string[]) => string;
}>('path');
const { setImmediate: realSetImmediate } = jest.requireActual<{
  setImmediate: (callback: () => void) => unknown;
}>('timers');

// ─── Scale knobs ────────────────────────────────────────────────────────────

const ITERATIONS = Number(process.env.STRESS_ITER ?? 40);
const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const REPEAT = Number(process.env.STRESS_REPEAT ?? 1);
const SAMPLE_EVERY = 50;
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');
/** The leak assertions need a real campaign; a 40-iteration smoke run only
 * checks per-iteration invariants (timers, handoff, no throw). */
const CAMPAIGN = ITERATIONS >= 200 && ONLY_SEED === null;
const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
const DRIFT_LIMIT = 0.5;
/** Seeds are dense integers so `STRESS_SEED=<n>` replays iteration n. */
const SEED_BASE = 1000;
/** @react-native/jest-preset NativeAnimatedModule.startAnimatingNode ends
 * every native-driven animation after one 16 ms fake frame. */
const NATIVE_ANIMATION_MOCK_FRAME_MS = 20;

// ─── Real providers / navigator (the app's own layering) ────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const queryClient = new QueryClient();

/** Where the real Back CTA pops to and where Re-analyze pushes. These two
 * routes are test-owned placeholders: the Result and Analyze screens are
 * not the unit under stress and need the camera / result native surfaces. */
function ResultPlaceholder() {
  return <Text testID="stress-result-route">[Result]</Text>;
}
function AnalyzePlaceholder() {
  return <Text testID="stress-analyze-route">[Analyze]</Text>;
}

function Harness(props: { analysisId: string; phase: string | undefined }) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <NavigationContainer
          theme={DefaultTheme}
          initialState={{
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
            <Stack.Screen name="Result" component={ResultPlaceholder} />
            <Stack.Screen
              name="FormReview"
              component={FormReviewScreen}
              options={{
                title: 'Form review',
                contentStyle: { backgroundColor: color.surfaceDark },
              }}
            />
            <Stack.Screen name="Analyze" component={AnalyzePlaceholder} />
          </Stack.Navigator>
        </NavigationContainer>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

// ─── Seeding through the production writers ─────────────────────────────────

async function seedStore(db: LocalDb) {
  setActiveDataOwner(GUEST_DATA_OWNER);
  const { sequence } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  const goodHash = sha256Hex(sidecarJson);
  const frameCount = sequence.frames.length;

  // clip_sidecar: everything present and byte-identical.
  mockArtifactFiles.set(SIDECAR_URI.clip_sidecar, sidecarJson);
  await saveAnalysis(
    db,
    makeAnalysis(ANALYSIS_ID.clip_sidecar),
    'permit-stress-a',
  );
  await savePendingCapture(
    db,
    CAPTURE_ID.clip_sidecar,
    'forehand_drive',
    makeClip(
      'file:///private/captures/fr-stress-a.mov',
      makeSidecarRef(SIDECAR_URI.clip_sidecar, goodHash, frameCount),
    ),
    'forehand_drive',
  );
  await insertRecord(
    db,
    makeRecord(
      ANALYSIS_ID.clip_sidecar,
      CAPTURE_ID.clip_sidecar,
      makeAnalysis(ANALYSIS_ID.clip_sidecar),
    ),
  );

  // record_only: no local_shot row; the record carries the result.
  mockArtifactFiles.set(SIDECAR_URI.record_only, sidecarJson);
  await savePendingCapture(
    db,
    CAPTURE_ID.record_only,
    'forehand_drive',
    makeClip(
      'file:///private/captures/fr-stress-b.mov',
      makeSidecarRef(SIDECAR_URI.record_only, goodHash, frameCount),
    ),
    'forehand_drive',
  );
  await insertRecord(
    db,
    makeRecord(
      ANALYSIS_ID.record_only,
      CAPTURE_ID.record_only,
      makeAnalysis(ANALYSIS_ID.record_only),
    ),
  );

  // no_capture: the capture row is gone (clip file deleted with it).
  await saveAnalysis(
    db,
    makeAnalysis(ANALYSIS_ID.no_capture),
    'permit-stress-c',
  );
  await insertRecord(
    db,
    makeRecord(ANALYSIS_ID.no_capture, CAPTURE_ID.no_capture, null),
  );

  // bad_sidecar: file present but its hash no longer matches the ref.
  mockArtifactFiles.set(SIDECAR_URI.bad_sidecar, `${sidecarJson} `);
  await saveAnalysis(
    db,
    makeAnalysis(ANALYSIS_ID.bad_sidecar),
    'permit-stress-d',
  );
  await savePendingCapture(
    db,
    CAPTURE_ID.bad_sidecar,
    'forehand_drive',
    makeClip(
      'file:///private/captures/fr-stress-c.mov',
      makeSidecarRef(SIDECAR_URI.bad_sidecar, goodHash, frameCount),
    ),
    'forehand_drive',
  );
  await insertRecord(
    db,
    makeRecord(ANALYSIS_ID.bad_sidecar, CAPTURE_ID.bad_sidecar, null),
  );
}

/** Same columns `saveAnalysisRecord` writes; the evidence reader only needs
 * the envelope fields, so the row carries the review-relevant subset rather
 * than a fabricated full engine record. */
async function insertRecord(
  db: LocalDb,
  record: ReturnType<typeof makeRecord>,
) {
  await db.execute(
    `INSERT INTO local_analysis_record
      (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      GUEST_DATA_OWNER,
      record.id,
      record.captureId,
      record.createdAtIso,
      record.engineVersion,
      record.result?.versionVector.scoringModelVersion ?? 'abstained',
      JSON.stringify(record),
    ],
  );
}

// ─── One iteration ──────────────────────────────────────────────────────────

interface IterationResult {
  seed: number;
  plan: IterationPlan;
  outcome: 'ok' | 'failed';
  state: 'ready' | 'missing' | 'loading' | 'gone';
  clipHost: boolean;
  skeleton: boolean;
  mountMs: number;
  actionsMs: number;
  unmountMs: number;
  totalMs: number;
  /** Fake timers right after unmount, before the preset's native-animation
   * completion callbacks (16 ms one-shots) are allowed to fire. */
  pendingTimersRaw: number;
  /** Fake timers once those completions have run: must be 0. */
  pendingTimersAfter: number;
  handoffArmed: boolean;
  error?: string;
}

const liveRoots: { seed: number; ref: WeakRef<ReactTestRenderer> }[] = [];

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

async function settle() {
  // Let the evidence + sidecar promise chains (several awaits deep) settle
  // and any state update they schedule commit.
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function pressable(renderer: ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === testID &&
      typeof candidate.props.onPress === 'function',
  );
  return node ?? null;
}

function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

async function press(renderer: ReactTestRenderer, testID: string) {
  const node = pressable(renderer, testID);
  if (!node) return false;
  await act(async () => {
    node.props.onPress();
  });
  return true;
}

async function applyAction(renderer: ReactTestRenderer, action: Action) {
  switch (action.kind) {
    case 'next':
      await press(renderer, 'form-review-next-stop');
      return;
    case 'prev':
      await press(renderer, 'form-review-prev-stop');
      return;
    case 'play':
      await press(renderer, 'form-review-play');
      return;
    case 'speed':
      await press(renderer, 'form-review-speed');
      return;
    case 'autopause':
      await press(renderer, 'form-review-autopause');
      return;
    case 'layout': {
      const [stage] = renderer.root.findAll(
        node =>
          node.props.testID === 'form-review-stage' &&
          typeof node.props.onLayout === 'function',
      );
      if (!stage) return;
      await act(async () => {
        stage.props.onLayout({
          nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 420 } },
        });
      });
      return;
    }
    case 'seek': {
      const [track] = renderer.root.findAll(
        node =>
          node.props.testID === 'form-review-timeline' &&
          typeof node.props.onResponderGrant === 'function',
      );
      if (!track) return;
      await act(async () => {
        track.props.onLayout({
          nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 24 } },
        });
      });
      await act(async () => {
        track.props.onResponderGrant({
          nativeEvent: { locationX: action.ratio * 300 },
        });
        track.props.onResponderRelease();
      });
      return;
    }
    case 'progress': {
      const [player] = renderer.root.findAll(
        node => typeof node.props.onClipProgress === 'function',
      );
      if (!player) return;
      await act(async () => {
        player.props.onClipProgress({
          nativeEvent: { positionMs: action.positionMs },
        });
      });
      return;
    }
    case 'clip_error': {
      const [player] = renderer.root.findAll(
        node => typeof node.props.onClipError === 'function',
      );
      if (!player) return;
      await act(async () => {
        player.props.onClipError({ nativeEvent: { message: 'unreadable' } });
      });
      return;
    }
    case 'tick':
      await act(async () => {
        jest.advanceTimersByTime(action.ms);
      });
      return;
  }
}

/**
 * Mount in a frame of its own. React DEV stamps every element with a
 * `_debugStack` Error; V8 keeps the closures of the captured frames alive
 * through it, and with them any variable those closures share a context
 * with. Creating the root here (and nulling the slot before returning) keeps
 * the renderer out of every context a captured frame can reach, so a root
 * that is still reachable afterwards is retained by the code under test.
 */
function mountHarness(plan: IterationPlan): ReactTestRenderer {
  let created: ReactTestRenderer | null = null;
  act(() => {
    created = TestRenderer.create(
      <Harness analysisId={plan.analysisId} phase={plan.phase} />,
    );
  });
  const out = created;
  created = null;
  if (!out) throw new Error('renderer did not mount');
  return out;
}

function unmountHarness(renderer: ReactTestRenderer) {
  act(() => {
    renderer.unmount();
  });
}

async function runIteration(plan: IterationPlan): Promise<IterationResult> {
  const started = nowMs();
  let renderer: ReactTestRenderer | null = null;
  let mountMs = 0;
  let actionsMs = 0;
  let unmountMs = 0;
  let state: IterationResult['state'] = 'loading';
  let clipHost = false;
  let skeleton = false;
  let handoffArmed = false;
  let error: string | undefined;
  clearTryAgainHandoff();
  try {
    renderer = mountHarness(plan);
    const mounted: ReactTestRenderer = renderer;
    await settle();
    mountMs = nowMs() - started;

    const ready = hostByTestId(mounted, 'form-review-screen').length > 0;
    const missing = mounted.root
      .findAllByType(Text)
      .some(node => node.props.children === 'Review unavailable');
    state = ready ? 'ready' : missing ? 'missing' : 'loading';
    if (plan.variant === 'missing' && state !== 'missing') {
      throw new Error(`expected the missing state, rendered ${state}`);
    }
    if (plan.variant !== 'missing' && state !== 'ready') {
      throw new Error(`expected the ready state, rendered ${state}`);
    }
    clipHost =
      mounted.root.findAll(
        node => typeof node.props.onClipProgress === 'function',
      ).length > 0;
    skeleton = hostByTestId(mounted, 'form-review-overlay').length > 0;

    const actionsStarted = nowMs();
    for (const action of plan.actions) {
      await applyAction(mounted, action);
    }
    actionsMs = nowMs() - actionsStarted;

    const unmountStarted = nowMs();
    if (plan.exit === 'back') {
      // The real Back CTA (ready) or the error state's retry (missing) both
      // call navigation.goBack(): the navigator pops FormReview.
      const pressed = ready
        ? await press(mounted, 'form-review-back')
        : await pressRetry(mounted);
      if (!pressed) throw new Error('back affordance not found');
      await settle();
      if (hostByTestId(mounted, 'form-review-screen').length > 0) {
        throw new Error('FormReview still mounted after goBack');
      }
      if (hostByTestId(mounted, 'stress-result-route').length === 0) {
        throw new Error('navigator did not land on Result after goBack');
      }
      state = 'gone';
    } else if (plan.exit === 'reanalyze') {
      if (!(await press(mounted, 'form-review-reanalyze'))) {
        throw new Error('re-analyze CTA not found');
      }
      await settle();
      handoffArmed = peekTryAgainHandoff() !== null;
      if (!handoffArmed) throw new Error('try-again handoff not armed');
      if (hostByTestId(mounted, 'stress-analyze-route').length === 0) {
        throw new Error('navigator did not push Analyze');
      }
    }
    unmountHarness(mounted);
    unmountMs = nowMs() - unmountStarted;
    liveRoots.push({ seed: plan.seed, ref: new WeakRef(mounted) });
    renderer = null;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    if (renderer) unmountHarness(renderer);
  }
  // jest.fn records every call's arguments and `this` forever
  // (`mock.calls` / `mock.contexts`); the preset's native mocks would pin
  // each iteration's tree through those records. Fold the one count the
  // suite asserts on, then drop the records.
  accessibilityListenerAdds += accessibilitySpy?.mock.calls.length ?? 0;
  jest.clearAllMocks();
  // Consumed by AnalyzeScreen on device; here the iteration owns it.
  clearTryAgainHandoff();
  // The preset's NativeAnimatedModule mock completes every native-driven
  // timing with a 16 ms setTimeout → endCallback. A stopped animation
  // ignores that callback; a loop that was NOT stopped re-arms a new one.
  // Flushing one frame separates the two: anything left is a leak.
  const pendingTimersRaw = jest.getTimerCount();
  await act(async () => {
    jest.advanceTimersByTime(NATIVE_ANIMATION_MOCK_FRAME_MS);
  });
  await settle();
  const pendingTimersAfter = jest.getTimerCount();
  if (error === undefined && pendingTimersAfter !== 0) {
    error = `${pendingTimersAfter} timer(s) still scheduled after unmount`;
  }
  return {
    seed: plan.seed,
    plan,
    outcome: error === undefined ? 'ok' : 'failed',
    state,
    clipHost,
    skeleton,
    mountMs,
    actionsMs,
    unmountMs,
    totalMs: nowMs() - started,
    pendingTimersRaw,
    pendingTimersAfter,
    handoffArmed,
    ...(error !== undefined ? { error } : {}),
  };
}

async function pressRetry(renderer: ReactTestRenderer) {
  // ErrorState's retry button is the only pressable of the missing state.
  const [node] = renderer.root.findAll(
    candidate => typeof candidate.props.onPress === 'function',
  );
  if (!node) return false;
  await act(async () => {
    node.props.onPress();
  });
  return true;
}

async function sample(
  iteration: number,
  pendingTimers: number,
): Promise<HeapSample> {
  // `new WeakRef(target)` and `deref()` pin the target on V8's
  // KeepDuringJob list until the current macrotask ends; every iteration so
  // far ran on microtasks only, so end the job before judging reachability.
  await new Promise<void>(resolve => {
    realSetImmediate(resolve);
  });
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
  }
  const usage = process.memoryUsage();
  const histogram: Record<string, number> = {};
  if (typeof process.getActiveResourcesInfo === 'function') {
    for (const kind of process.getActiveResourcesInfo()) {
      histogram[kind] = (histogram[kind] ?? 0) + 1;
    }
  }
  const liveRendererSeeds: number[] = [];
  for (const root of liveRoots) {
    if (root.ref.deref() !== undefined) liveRendererSeeds.push(root.seed);
  }
  return {
    iteration,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    activeResources: histogram,
    liveRenderers: liveRendererSeeds.length,
    liveRendererSeeds,
    pendingTimers,
  };
}

function replayCommand(seed: number): string {
  return `cd apps/mobile && STRESS_SEED=${seed} STRESS_REPEAT=10 npx jest --ci --runInBand __tests__/stress/formReviewScreen.longRunLeak.stress.test.tsx`;
}

// ─── Suite ──────────────────────────────────────────────────────────────────

const results: IterationResult[] = [];
const samples: HeapSample[] = [];
let accessibilityListenerAdds = 0;
let runStartedAt = '';
// Call-through spy (the preset already mocks AccessibilityInfo; a wrapping
// implementation would recurse into itself).
let accessibilitySpy: jest.SpyInstance | null = null;

beforeAll(async () => {
  runStartedAt = new Date().toISOString();
  accessibilitySpy = jest.spyOn(AccessibilityInfo, 'addEventListener');
  await seedStore(getDb());
});

afterAll(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  getDb().close();
  const slope = heapSlope(samples);
  const drift = timeDrift(results.map(result => result.totalMs));
  const failed = results.filter(result => result.outcome === 'failed');
  const summary = {
    unit: 'scr-formreviewscreen',
    lens: 'long-run-leak',
    startedAt: runStartedAt,
    finishedAt: new Date().toISOString(),
    iterationsRequested: ONLY_SEED === null ? ITERATIONS : REPEAT,
    iterationsExecuted: results.length,
    campaign: CAMPAIGN,
    gcExposed: typeof global.gc === 'function',
    sampleEvery: SAMPLE_EVERY,
    sqliteStatements: mockSqliteState.statements,
    artifactReads: mockArtifactReads.length,
    accessibilityListenerAdds,
    variants: Object.fromEntries(
      Object.keys(ANALYSIS_ID).map(variant => [
        variant,
        results.filter(result => result.plan.variant === variant).length,
      ]),
    ),
    exits: Object.fromEntries(
      (['unmount', 'back', 'reanalyze'] as const).map(exit => [
        exit,
        results.filter(result => result.plan.exit === exit).length,
      ]),
    ),
    clipHostIterations: results.filter(result => result.clipHost).length,
    skeletonIterations: results.filter(result => result.skeleton).length,
    failedSeeds: failed.map(result => ({
      seed: result.seed,
      error: result.error,
      replay: replayCommand(result.seed),
    })),
    heapSlope: slope,
    timeDrift: drift,
    limits: {
      heapSlopePctPer100: HEAP_SLOPE_LIMIT_PCT_PER_100,
      driftRatio: DRIFT_LIMIT,
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = runStartedAt.replace(/[:.]/g, '-');
  const tag = ONLY_SEED === null ? `${ITERATIONS}` : `seed-${ONLY_SEED}`;
  writeFileSync(
    join(OUT_DIR, `formreview-long-run-leak-${tag}-${stamp}.json`),
    JSON.stringify({ summary, samples, results }, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `formreview-long-run-leak-${tag}-latest.json`),
    JSON.stringify({ summary, samples, results }, null, 2),
  );
});

beforeEach(() => {
  // Fake macro-timers for every iteration: the replay clock, the arrow pulse
  // and the spinner loop must never outlive the screen. Microtasks stay real
  // — Animated detaches its props nodes from a `queueMicrotask` on unmount
  // (createAnimatedPropsHook.useAnimatedPropsLifecycle); faking it would
  // park every detach in the fake clock and manufacture a leak.
  // hrtime stays real so mount/action/unmount durations are wall-clock.
  jest.useFakeTimers({
    doNotFake: ['queueMicrotask', 'nextTick', 'hrtime', 'performance'],
  });
  setActiveDataOwner(GUEST_DATA_OWNER);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('FormReviewScreen · long-run leak (real navigator + real SQLite)', () => {
  jest.setTimeout(30 * 60 * 1000);

  const seeds =
    ONLY_SEED === null
      ? Array.from({ length: ITERATIONS }, (_, i) => SEED_BASE + i)
      : Array.from({ length: REPEAT }, () => ONLY_SEED);

  it(`mounts/unmounts ${seeds.length} seeded iterations; timers and handoff return to baseline each time`, async () => {
    if (CAMPAIGN && typeof global.gc !== 'function') {
      throw new Error(
        'campaign mode needs a forced GC: run with NODE_OPTIONS=--expose-gc',
      );
    }
    samples.push(await sample(0, jest.getTimerCount()));
    for (let i = 0; i < seeds.length; i += 1) {
      const seed = seeds[i];
      if (seed === undefined) continue;
      const result = await runIteration(planIteration(seed));
      results.push(result);
      const iteration = i + 1;
      if (iteration % SAMPLE_EVERY === 0 || iteration === seeds.length) {
        samples.push(await sample(iteration, result.pendingTimersAfter));
      }
    }
    const failed = results.filter(result => result.outcome === 'failed');
    expect(
      failed.map(result => ({
        seed: result.seed,
        error: result.error,
        plan: result.plan,
        replay: replayCommand(result.seed),
      })),
    ).toEqual([]);
    expect(results).toHaveLength(seeds.length);
    // Every non-missing iteration rendered the replay; every missing one the
    // honest empty state (asserted per iteration; this pins the mix).
    expect(results.filter(result => result.state === 'loading')).toEqual([]);
  });

  it('the reduce-motion observer subscribes once for the whole process', () => {
    // useReducedMotion keeps one AccessibilityInfo subscription per process
    // and a per-component listener set; N mounts must not add N native
    // subscriptions.
    expect(results.length).toBeGreaterThan(0);
    expect(accessibilityListenerAdds).toBeLessThanOrEqual(1);
  });

  it('no unmounted renderer root survives a forced GC', () => {
    const last = samples[samples.length - 1];
    expect(last).toBeDefined();
    if (typeof global.gc !== 'function') {
      // Without --expose-gc the WeakRefs cannot be forced clear; the
      // campaign run (which requires gc) is the one that proves this.
      expect(last?.liveRenderers).toBeLessThanOrEqual(results.length);
      return;
    }
    expect(last?.liveRenderers).toBe(0);
  });

  it('heap slope after warm-up stays under 5 % per 100 iterations and render time does not drift', () => {
    if (!CAMPAIGN) {
      // Smoke scale: record only; the slope over <4 samples is noise.
      expect(samples.length).toBeGreaterThan(0);
      return;
    }
    const slope = heapSlope(samples);
    expect(slope).not.toBeNull();
    if (!slope) return;
    expect({
      pctPer100: slope.pctPer100,
      monotoneFraction: slope.monotoneFraction,
      firstMB: slope.first / 1048576,
      lastMB: slope.last / 1048576,
      withinLimit: slope.pctPer100 <= HEAP_SLOPE_LIMIT_PCT_PER_100,
    }).toMatchObject({ withinLimit: true });
    const drift = timeDrift(results.map(result => result.totalMs));
    expect(drift).not.toBeNull();
    if (!drift) return;
    expect({
      headMeanMs: drift.headMeanMs,
      tailMeanMs: drift.tailMeanMs,
      driftRatio: drift.driftRatio,
      withinLimit: drift.driftRatio <= DRIFT_LIMIT,
    }).toMatchObject({ withinLimit: true });
    // Open handles: the sampled histogram must not grow across the campaign
    // (timers/sockets/handles opened per mount would accumulate here).
    const first = samples[1];
    const last = samples[samples.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (!first || !last) return;
    const totalOf = (histogram: Record<string, number>) =>
      Object.values(histogram).reduce((a, b) => a + b, 0);
    expect(totalOf(last.activeResources)).toBeLessThanOrEqual(
      totalOf(first.activeResources) + 2,
    );
  });
});
