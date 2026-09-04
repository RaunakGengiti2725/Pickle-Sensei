/**
 * STRESS · scr-resultscreen · lens `rapid-interaction`.
 *
 * ResultScreen rendered inside the REAL React Navigation container + native
 * stack, with the REAL local repository (getDb → node:sqlite behind the
 * op-sqlite native seam), the REAL training / consistency zustand stores and
 * the REAL training API client. Only native modules (op-sqlite, safe-area,
 * svg) and `fetch` are mocked.
 *
 * A seeded generator scripts interaction bursts — double / triple taps,
 * taps mid StepReveal transition, two controls in the same tick, back or
 * close while a request is in flight, navigation spam through the container
 * ref — and after every burst settles the harness asserts:
 *   · one request per accepted save intent, never two mutations in flight
 *   · one catalog request per DrillsPage mount
 *   · one navigation per intent (no duplicate Analyze / DrillLibrary /
 *     FormReview routes, at most one Result route, a Try-again handoff armed
 *     iff Analyze was reached)
 *   · no orphan loading state (no "Opening your result…" once the row is
 *     readable, no SAVING pill, store mutation idle, zero in-flight requests)
 *   · no duplicate modal / dialog / error card, exactly one guide page shown
 *   · no act() warnings, no unhandled promise rejections
 *   · the saved-toggle UI agrees with the server ledger
 *   · under seeded save failures (503) exactly one error card, and none
 *     without a failed request behind it.
 *
 * Driver: react-test-renderer + jest fake timers (the repo's screen-test
 * convention; @testing-library/react-native is not a dependency here).
 *
 * Every iteration is replayable from its seed:
 *   STRESS_SEED=<n>    replay exactly that seed
 *   STRESS_ITER=<n>    campaign size (default 12 → 36 bursts; keep it fast)
 *   STRESS_SEED_BASE   first seed of a campaign (default 1)
 *   STRESS_OUT=<file>  write the seed → outcome JSON table
 *
 *   cd apps/mobile && STRESS_ITER=120 STRESS_OUT=artifacts/stress/result-rapid.json \
 *     npx jest --ci --silent __tests__/stress/ResultScreen.rapidInteraction
 */
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

declare const require: (id: string) => unknown;
declare const process: {
  env: Record<string, string | undefined>;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

// ─── Native seams ───────────────────────────────────────────────────────────

/** Latency knobs the generator turns per iteration (fake-timer ms). */
const mockLatency = { dbMs: 0, fetchMs: 0 };
const { DatabaseSync: MockDatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};

jest.mock('@op-engineering/op-sqlite', () => ({
  // `open` runs lazily from getDb(), after this module's bindings exist.
  open: () => {
    const real = new MockDatabaseSync(':memory:');
    const run = (sql: string, params: unknown[] = []) => ({
      rows: real.prepare(sql).all(...(params as (string | number | null)[])),
    });
    return {
      executeSync: (sql: string) => run(sql),
      execute: (sql: string, params: unknown[] = []) =>
        mockLatency.dbMs > 0
          ? new Promise(resolve =>
              setTimeout(() => resolve(run(sql, params)), mockLatency.dbMs),
            )
          : Promise.resolve(run(sql, params)),
      close: () => real.close(),
    };
  },
}));
jest.mock(
  'react-native-safe-area-context',
  () =>
    (
      jest.requireActual('react-native-safe-area-context/jest/mock') as {
        default: unknown;
      }
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
import TestRenderer, { act } from 'react-test-renderer';
import {
  NavigationContainer,
  StackActions,
  createNavigationContainerRef,
  type NavigationState,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { CheckpointScore, ShotAnalysis } from '@pickle/shared-types';
import { ResultScreen } from '../../src/screens/ResultScreen';
import type { RootStackParams } from '../../src/navigation/params';
import { getDb } from '../../src/data/db';
import { saveAnalysis } from '../../src/data/repository';
import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { createTrainingApi } from '../../src/training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import {
  clearTryAgainHandoff,
  peekTryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';

const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { dirname } = require('path') as { dirname: (path: string) => string };

// ─── Campaign knobs ─────────────────────────────────────────────────────────

const REPLAY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const ITERATIONS =
  REPLAY_SEED !== null ? 1 : Number(process.env.STRESS_ITER ?? 12);
const SEED_BASE =
  REPLAY_SEED !== null
    ? REPLAY_SEED
    : Number(process.env.STRESS_SEED_BASE ?? 1);
const OUT_FILE = process.env.STRESS_OUT ?? null;
const BURSTS_PER_ITERATION = 3;

jest.setTimeout(Math.max(30_000, ITERATIONS * 4_000));

// ─── Seeded RNG (mulberry32) ────────────────────────────────────────────────

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[this.int(items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ─── Fixtures: two comparable scored attempts in one session ────────────────

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = 'stress-session-1';
const A1 = 'stress-a1';
const A2 = 'stress-a2';
const API_BASE = 'https://stress.invalid';

function checkpoint(
  key: CheckpointScore['key'],
  score: number,
  band: CheckpointScore['band'],
  direction: CheckpointScore['direction'],
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: (100 - score) / 100,
    applicable: true,
  };
}

function analysisFixture(
  id: string,
  capturedAtIso: string,
  overallScore: number,
): ShotAnalysis {
  return {
    id,
    sessionId: SESSION_ID,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso,
    timestamps: { startMs: 2000, contactMs: null, endMs: 2700 },
    phases: [],
    measurements: [],
    checkpoints: [
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('contact_position', 48, 'red', 'late'),
    ],
    overallScore,
    analysisConfidence: 0.82,
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
      phaseModelVersion: 'phase-heuristic-1',
      scoringModelVersion: 'scoring-1',
      shotConfigVersion: 'config-1',
    },
    source: 'real',
  };
}

const CATALOG = [
  {
    id: '22222222-2222-4222-8222-222222222221',
    slug: 'drive-shadow-swings',
    title: 'Drive shadow swings',
    families: ['drive'],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    slug: 'drive-contact-ladder',
    title: 'Contact-point ladder',
    families: ['drive'],
  },
  {
    id: '22222222-2222-4222-8222-222222222223',
    slug: 'global-split-step',
    title: 'Split-step reset',
    families: ['global'],
  },
] as const;

// ─── Fetch double: records every request, tracks in-flight per intent ───────

interface RequestLog {
  method: string;
  path: string;
  at: number;
}

const server = {
  saved: new Set<string>(),
  log: [] as RequestLog[],
  inFlight: 0,
  mutationInFlight: 0,
  maxMutationInFlight: 0,
  /** When set, every save/unsave answers 503 (seeded per iteration). */
  failSaves: false,
  failedMutations: 0,
  clock: 0,
  reset() {
    this.saved.clear();
    this.log = [];
    this.inFlight = 0;
    this.mutationInFlight = 0;
    this.maxMutationInFlight = 0;
    this.failSaves = false;
    this.failedMutations = 0;
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

function route(method: string, path: string): Response {
  const saved = (slug: string) => server.saved.has(slug);
  const detailMatch = /^\/v1\/catalog\/drills\/([^/?]+)$/.exec(path);
  if (method === 'GET' && detailMatch) {
    const slug = decodeURIComponent(detailMatch[1]!);
    const drill = CATALOG.find(entry => entry.slug === slug);
    if (!drill) {
      return jsonResponse(404, {
        error: { code: 'not_found', message: 'Unknown drill.' },
      });
    }
    return jsonResponse(200, {
      drill: {
        id: drill.id,
        slug: drill.slug,
        title: drill.title,
        description: `${drill.title} — repeat the cue until the contact point holds.`,
        coach_name: 'Catalog coach',
        equipment: ['paddle'],
        difficulty_min: null,
        difficulty_max: null,
        saved: saved(drill.slug),
      },
      mappings: [],
      instructionalMedia: [],
    });
  }
  if (method === 'GET' && isCatalogList(path)) {
    return jsonResponse(200, {
      items: CATALOG.map(drill => ({
        id: drill.id,
        slug: drill.slug,
        title: drill.title,
        description: `${drill.title} — repeat the cue until the contact point holds.`,
        coach_name: 'Catalog coach',
        equipment: ['paddle', 'balls'],
        difficulty_min: null,
        difficulty_max: null,
        families: [...drill.families],
        validation_state: 'UNVALIDATED',
        saved: saved(drill.slug),
      })),
    });
  }
  if (method === 'GET' && path === '/v1/me/saved-drills') {
    return jsonResponse(200, {
      items: CATALOG.filter(drill => saved(drill.slug)).map(drill => ({
        id: drill.id,
        slug: drill.slug,
        title: drill.title,
        description: `${drill.title} — repeat the cue until the contact point holds.`,
        coach_name: 'Catalog coach',
        equipment: ['paddle'],
        difficulty_min: null,
        difficulty_max: null,
        saved_at: '2026-09-01T10:00:00.000Z',
      })),
    });
  }
  const savedMatch = /^\/v1\/me\/saved-drills\/([^/?]+)$/.exec(path);
  if (
    savedMatch &&
    server.failSaves &&
    (method === 'PUT' || method === 'DELETE')
  ) {
    server.failedMutations += 1;
    return jsonResponse(503, {
      error: { code: 'training.unavailable', message: 'Saving is offline.' },
    });
  }
  if (savedMatch && method === 'PUT') {
    const slug = decodeURIComponent(savedMatch[1]!);
    server.saved.add(slug);
    return jsonResponse(200, { slug, saved: true });
  }
  if (savedMatch && method === 'DELETE') {
    server.saved.delete(decodeURIComponent(savedMatch[1]!));
    return jsonResponse(204, null);
  }
  if (method === 'GET' && path === '/v1/training-plans/current') {
    return jsonResponse(200, { plan: null });
  }
  return jsonResponse(404, {
    error: {
      code: 'not_found',
      message: 'No such route in the stress double.',
    },
  });
}

function isCatalogList(path: string): boolean {
  return /^\/v1\/catalog\/drills(\?|$)/.test(path);
}

function isMutation(method: string, path: string): boolean {
  return (
    (method === 'PUT' || method === 'DELETE') &&
    path.startsWith('/v1/me/saved-drills/')
  );
}

const fetchDouble = jest.fn(
  (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    const path = url.startsWith(API_BASE) ? url.slice(API_BASE.length) : url;
    server.log.push({ method, path, at: server.clock });
    server.inFlight += 1;
    const mutation = isMutation(method, path);
    if (mutation) {
      server.mutationInFlight += 1;
      server.maxMutationInFlight = Math.max(
        server.maxMutationInFlight,
        server.mutationInFlight,
      );
    }
    const finish = () => {
      server.inFlight -= 1;
      if (mutation) server.mutationInFlight -= 1;
      return route(method, path);
    };
    return mockLatency.fetchMs > 0
      ? new Promise(resolve =>
          setTimeout(() => resolve(finish()), mockLatency.fetchMs),
        )
      : Promise.resolve().then(finish);
  },
);

// ─── The real navigator around the real screen ──────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const navRef = createNavigationContainerRef<RootStackParams>();

function TabsStub() {
  return <Text testID="stub-tabs">Tabs</Text>;
}
function AnalyzeStub() {
  return <Text testID="stub-analyze">Analyze</Text>;
}
function FormReviewStub() {
  return <Text testID="stub-form-review">FormReview</Text>;
}
function DrillLibraryStub() {
  return <Text testID="stub-drill-library">DrillLibrary</Text>;
}
function ResultDetailsStub() {
  return <Text testID="stub-result-details">ResultDetails</Text>;
}

let stateChanges = 0;

function Harness(props: { analysisId: string }) {
  return (
    <NavigationContainer
      ref={navRef}
      initialState={{
        index: 1,
        routes: [
          { name: 'Tabs' },
          { name: 'Result', params: { analysisId: props.analysisId } },
        ],
      }}
      onStateChange={() => {
        stateChanges += 1;
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Tabs" component={TabsStub} />
        <Stack.Screen name="Result" component={ResultScreen} />
        <Stack.Screen name="Analyze" component={AnalyzeStub} />
        <Stack.Screen name="FormReview" component={FormReviewStub} />
        <Stack.Screen name="DrillLibrary" component={DrillLibraryStub} />
        <Stack.Screen name="ResultDetails" component={ResultDetailsStub} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// ─── Tree probes ────────────────────────────────────────────────────────────

type Renderer = ReactTestRenderer;

function pressables(renderer: Renderer): ReactTestInstance[] {
  return renderer.root.findAll(node => {
    if (typeof node.type === 'string') return false;
    const type = node.type as { displayName?: string; name?: string };
    return (
      (type.displayName ?? type.name) === 'Pressable' &&
      typeof node.props.onPress === 'function'
    );
  });
}

function pressableByTestID(
  renderer: Renderer,
  testID: string,
): ReactTestInstance | null {
  return (
    pressables(renderer).find(node => node.props.testID === testID) ?? null
  );
}

function hostByTestID(renderer: Renderer, testID: string): ReactTestInstance[] {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function textOf(node: ReactTestInstance): string {
  const children = node.props.children;
  return Array.isArray(children) ? children.join('') : String(children ?? '');
}

function hasText(renderer: Renderer, needle: string): boolean {
  return renderer.root
    .findAllByType(Text)
    .some(node => textOf(node).includes(needle));
}

function routeNames(): string[] {
  const state: NavigationState | undefined = navRef.isReady()
    ? navRef.getRootState()
    : undefined;
  return state?.routes.map(route => route.name) ?? [];
}

function focusedRoute(): { name: string; analysisId: string | null } | null {
  if (!navRef.isReady()) return null;
  const state: NavigationState | undefined = navRef.getRootState();
  if (!state) return null;
  const route = state.routes[state.index];
  if (!route) return null;
  const params = route.params as { analysisId?: string } | undefined;
  return { name: route.name, analysisId: params?.analysisId ?? null };
}

// ─── Console + rejection capture ────────────────────────────────────────────

const consoleErrors: string[] = [];
const unhandled: string[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason instanceof Error ? reason.message : String(reason));
};

function formatConsole(args: unknown[]): string {
  return args
    .map(arg => (arg instanceof Error ? arg.message : String(arg)))
    .join(' ');
}

// ─── Time ───────────────────────────────────────────────────────────────────

async function tick(ms: number) {
  await act(async () => {
    if (ms > 0) {
      jest.advanceTimersByTime(ms);
      server.clock += ms;
    }
    await Promise.resolve();
  });
}

/** Drain every queued timer/animation/promise the screen can still have. */
async function settle() {
  for (let round = 0; round < 8; round += 1) {
    await tick(400);
    await tick(0);
  }
}

// ─── Interaction model ──────────────────────────────────────────────────────

type ControlId =
  | 'result-guide-close'
  | 'result-guide-next'
  | 'result-guide-back'
  | 'result-guide-done'
  | 'result-guide-try-again'
  | 'recommended-drills-open-library'
  | 'recommended-drills-retry'
  | `recommended-drill-${string}-save`
  | `practice-set-attempt-${string}`;

type BurstKind =
  | 'double-tap'
  | 'triple-tap'
  | 'tap-during-transition'
  | 'simultaneous-controls'
  | 'back-during-async'
  | 'spam-navigation';

interface TapRecord {
  control: string;
  gapMs: number;
  fired: boolean;
  reason?: string;
}

interface BurstRecord {
  kind: BurstKind;
  taps: TapRecord[];
  navActions: string[];
  routesAfter: string[];
  focusedAfter: string | null;
  requestsDuring: RequestLog[];
  stepAfter: string | null;
  violations: string[];
}

interface IterationRecord {
  seed: number;
  latency: { dbMs: number; fetchMs: number };
  bursts: BurstRecord[];
  routesFinal: string[];
  requestsTotal: number;
  stateChanges: number;
  navWarnings: number;
  consoleErrors: string[];
  unhandledRejections: string[];
  violations: string[];
  outcome: 'HELD' | 'BROKEN';
  failSaves: boolean;
  failedMutations: number;
  /** Fake-timer milliseconds the iteration advanced (not wall time). */
  fakeClockAdvancedMs: number;
  openingRace: string | null;
  sawAnalyzingOnMount: boolean;
}

const GUIDE_STEPS = [
  'result-guide-step-score',
  'result-guide-step-problem',
  'result-guide-step-drills',
  'result-guide-step-next',
] as const;
const STEP_COUNT = GUIDE_STEPS.length;

/** Model of the screen the generator believes it is driving. */
class ScreenModel {
  stepIndex = 0;
  /** Analysis id of the Result route the model thinks is mounted. */
  analysisId: string;
  /** Set when a navigation-away intent fired in the current burst; later taps
   * in the same burst hit the outgoing screen. */
  leaving = false;
  /** Set when the Result route itself is being removed (pop / replace); a
   * push (Analyze, DrillLibrary) keeps it mounted underneath, so guide taps
   * that land in the same tick still page the background screen. */
  unmounting = false;
  drillsMounts = 0;
  acceptedMutations = 0;
  navIntents = new Set<string>();
  navTargetTaps = new Map<string, number>();

  constructor(analysisId: string) {
    this.analysisId = analysisId;
  }

  beginBurst() {
    this.leaving = false;
    this.unmounting = false;
    this.navIntents.clear();
    this.navTargetTaps.clear();
  }

  private noteNav(target: string) {
    this.navIntents.add(target);
    this.navTargetTaps.set(target, (this.navTargetTaps.get(target) ?? 0) + 1);
  }

  /** A fired tap on `control` while the Result route is mounted. */
  tapped(control: string, saveInFlight: boolean, mutationIdle: boolean) {
    if (control === 'result-guide-next') {
      if (this.unmounting) return;
      const before = this.stepIndex;
      this.stepIndex = Math.min(STEP_COUNT - 1, this.stepIndex + 1);
      if (this.stepIndex === 2 && before !== 2) this.drillsMounts += 1;
      return;
    }
    if (control === 'result-guide-back') {
      if (this.unmounting) return;
      const before = this.stepIndex;
      this.stepIndex = Math.max(0, this.stepIndex - 1);
      if (this.stepIndex === 2 && before !== 2) this.drillsMounts += 1;
      return;
    }
    if (control === 'result-guide-close' || control === 'result-guide-done') {
      this.leaving = true;
      this.unmounting = true;
      this.noteNav('popToTop');
      return;
    }
    if (control === 'result-guide-try-again') {
      this.leaving = true;
      this.noteNav('Analyze');
      return;
    }
    if (control === 'recommended-drills-open-library') {
      this.leaving = true;
      this.noteNav('DrillLibrary');
      return;
    }
    if (control === 'recommended-drills-retry') {
      if (!this.unmounting) this.drillsMounts += 1;
      return;
    }
    if (control.startsWith('practice-set-attempt-')) {
      const target = control.slice('practice-set-attempt-'.length);
      if (target === this.analysisId || this.leaving) return;
      this.leaving = true;
      this.unmounting = true;
      this.analysisId = target;
      this.stepIndex = 0;
      this.noteNav(`Result:${target}`);
      return;
    }
    if (control.startsWith('recommended-drill-') && control.endsWith('-save')) {
      // The store accepts a save intent only while no mutation is pending.
      if (!saveInFlight && mutationIdle) this.acceptedMutations += 1;
      return;
    }
  }
}

// ─── Burst execution ────────────────────────────────────────────────────────

const NAV_SPAM_ACTIONS = [
  'navigate:Result:a1',
  'navigate:Result:a2',
  'replace:Result:a1',
  'replace:Result:a2',
  'goBack',
  'popToTop',
  'navigate:Analyze',
  'navigate:DrillLibrary',
] as const;

function dispatchSpam(action: string, model: ScreenModel) {
  if (!navRef.isReady()) return;
  const focused = focusedRoute();
  if (action === 'goBack') {
    if (navRef.canGoBack()) {
      navRef.goBack();
      if (focused?.name === 'Result') {
        model.leaving = true;
        model.unmounting = true;
      }
    }
    return;
  }
  if (action === 'popToTop') {
    if (routeNames().length > 1) navRef.dispatch(StackActions.popToTop());
    model.leaving = true;
    model.unmounting = true;
    return;
  }
  const [verb, name, which] = action.split(':');
  const analysisId = which === 'a1' ? A1 : A2;
  if (verb === 'replace') {
    if (focused?.name !== 'Result') return;
    navRef.dispatch(StackActions.replace('Result', { analysisId }));
    if (analysisId !== model.analysisId) {
      model.analysisId = analysisId;
      model.stepIndex = 0;
    }
    model.leaving = true;
    model.unmounting = true;
    return;
  }
  if (name === 'Result') {
    navRef.navigate('Result', { analysisId });
    if (analysisId !== model.analysisId) {
      model.analysisId = analysisId;
      model.stepIndex = 0;
    }
    model.leaving = true;
    model.unmounting = true;
    return;
  }
  if (name === 'Analyze') {
    navRef.navigate('Analyze', { source: 'camera' });
    model.leaving = true;
    return;
  }
  if (name === 'DrillLibrary') {
    navRef.navigate('DrillLibrary');
    model.leaving = true;
  }
}

function availableControls(renderer: Renderer): ControlId[] {
  const ids = new Set(
    pressables(renderer)
      .map(node => node.props.testID as string | undefined)
      .filter((id): id is string => typeof id === 'string'),
  );
  const wanted: ControlId[] = [];
  for (const id of ids) {
    if (
      id === 'result-guide-close' ||
      id === 'result-guide-next' ||
      id === 'result-guide-back' ||
      id === 'result-guide-done' ||
      id === 'result-guide-try-again' ||
      id === 'recommended-drills-open-library' ||
      id === 'recommended-drills-retry' ||
      (id.startsWith('recommended-drill-') && id.endsWith('-save')) ||
      id.startsWith('practice-set-attempt-')
    ) {
      wanted.push(id as ControlId);
    }
  }
  return wanted.sort();
}

function fireTap(
  renderer: Renderer,
  control: string,
  model: ScreenModel,
  gapMs: number,
): TapRecord {
  const node = pressableByTestID(renderer, control);
  if (!node) return { control, gapMs, fired: false, reason: 'absent' };
  if (node.props.disabled === true) {
    return { control, gapMs, fired: false, reason: 'disabled' };
  }
  const saveInFlight = server.mutationInFlight > 0;
  const mutationIdle = useTrainingStore.getState().mutation === 'idle';
  (node.props.onPress as () => void)();
  model.tapped(control, saveInFlight, mutationIdle);
  return { control, gapMs, fired: true };
}

function currentStep(renderer: Renderer): string | null {
  const present = GUIDE_STEPS.filter(
    id => hostByTestID(renderer, id).length > 0,
  );
  return present.length === 1
    ? present[0]!
    : present.length === 0
      ? null
      : 'multiple';
}

function checkInvariants(
  renderer: Renderer,
  model: ScreenModel,
  requestsBefore: number,
  kind: BurstKind,
): string[] {
  const violations: string[] = [];
  const routes = routeNames();
  const focused = focusedRoute();

  // One navigation per intent.
  for (const name of [
    'Analyze',
    'DrillLibrary',
    'FormReview',
    'ResultDetails',
  ]) {
    const count = routes.filter(route => route === name).length;
    if (count > 1) violations.push(`duplicate-route:${name}x${count}`);
  }
  const resultCount = routes.filter(route => route === 'Result').length;
  if (resultCount > 1)
    violations.push(`duplicate-route:Result x${resultCount}`);
  const analyzeReached = routes.includes('Analyze');
  const armed = peekTryAgainHandoff() !== null;
  if (analyzeReached && model.navIntents.has('Analyze') && !armed) {
    violations.push('try-again-navigated-without-handoff');
  }
  if (kind !== 'spam-navigation') {
    const pushedAbove = routes.slice(routes.indexOf('Result') + 1);
    if (resultCount === 1 && pushedAbove.length > model.navIntents.size) {
      violations.push(
        `more-pushes-than-intents:${pushedAbove.join(',')}>${[...model.navIntents].join(',')}`,
      );
    }
  }

  // No orphan loading state.
  const training = useTrainingStore.getState();
  if (training.mutation !== 'idle') {
    violations.push(`orphan-mutation:${training.mutation}`);
  }
  if (server.inFlight !== 0)
    violations.push(`orphan-request:${server.inFlight}`);
  if (hasText(renderer, 'SAVING')) violations.push('orphan-saving-pill');
  if (focused?.name === 'Result') {
    if (hasText(renderer, 'Opening your result…')) {
      violations.push('orphan-analyzing-state');
    }
    if (hostByTestID(renderer, 'result-guide').length !== 1) {
      violations.push(
        `guide-count:${hostByTestID(renderer, 'result-guide').length}`,
      );
    }
    const step = currentStep(renderer);
    if (step === null) violations.push('no-guide-page');
    if (step === 'multiple') violations.push('duplicate-guide-page');
    if (
      step !== null &&
      step !== 'multiple' &&
      !model.leaving &&
      focused.analysisId === model.analysisId &&
      step !== GUIDE_STEPS[model.stepIndex]
    ) {
      violations.push(`step-mismatch:model=${model.stepIndex},screen=${step}`);
    }
    if (focused.analysisId !== null && hasText(renderer, 'Result missing')) {
      violations.push('result-missing-for-readable-row');
    }
  } else if (hostByTestID(renderer, 'result-guide').length > 1) {
    violations.push('guide-count-off-focus');
  }

  // No duplicate modal / error card.
  for (const id of ['training-plan-dialog', 'training-mutation-error']) {
    const count = hostByTestID(renderer, id).length;
    if (count > 1) violations.push(`duplicate-modal:${id}x${count}`);
  }
  // One error surface per failed intent: the card is on screen exactly when
  // the store holds an error, never without a failed save behind it.
  const step = currentStep(renderer);
  const errorCards = hostByTestID(renderer, 'training-mutation-error').length;
  if (training.mutationError !== null && !server.failSaves) {
    violations.push(
      `mutation-error-without-failure:${training.mutationError.code}`,
    );
  }
  if (step === 'result-guide-step-drills') {
    if (errorCards !== (training.mutationError === null ? 0 : 1)) {
      violations.push(
        `mutation-error-cards:${errorCards},storeError=${training.mutationError?.code ?? 'null'}`,
      );
    }
  } else if (errorCards > 0) {
    violations.push('mutation-error-off-drills-page');
  }

  // Exactly one request per intent.
  if (server.maxMutationInFlight > 1) {
    violations.push(`concurrent-mutations:${server.maxMutationInFlight}`);
  }
  const mutations = server.log.filter(entry =>
    isMutation(entry.method, entry.path),
  );
  if (mutations.length !== model.acceptedMutations) {
    violations.push(
      `mutation-requests:${mutations.length}!=accepted:${model.acceptedMutations}`,
    );
  }
  // Taps batched into one tick may skip the drills page entirely (no mount,
  // no request) — that is correct; MORE catalog reads than page visits is not.
  const catalogGets = server.log.filter(
    entry => entry.method === 'GET' && isCatalogList(entry.path),
  ).length;
  if (catalogGets > model.drillsMounts) {
    violations.push(
      `catalog-requests:${catalogGets}>drills-mounts:${model.drillsMounts}`,
    );
  }
  if (step === 'result-guide-step-drills') {
    const loaded =
      CATALOG.some(
        drill =>
          pressableByTestID(
            renderer,
            `recommended-drill-${drill.slug}-save`,
          ) !== null,
      ) || pressableByTestID(renderer, 'recommended-drills-retry') !== null;
    if (!loaded) violations.push('orphan-drills-loading');
  }
  void requestsBefore;

  // Saved-toggle UI agrees with the server ledger.
  for (const drill of CATALOG) {
    const toggle = pressableByTestID(
      renderer,
      `recommended-drill-${drill.slug}-save`,
    );
    if (!toggle) continue;
    const selected = toggle.props.accessibilityState?.selected === true;
    if (selected !== server.saved.has(drill.slug)) {
      violations.push(
        `saved-ui-mismatch:${drill.slug}:ui=${selected},server=${server.saved.has(drill.slug)}`,
      );
    }
  }
  return violations;
}

async function runBurst(
  renderer: Renderer,
  rng: Rng,
  model: ScreenModel,
  kind: BurstKind,
): Promise<BurstRecord> {
  const taps: TapRecord[] = [];
  const navActions: string[] = [];
  // Walk to a seeded page first so every guide page (score, problem, drills
  // with its save toggles, next with Done / Try again) takes bursts.
  if (focusedRoute()?.name === 'Result' && kind !== 'spam-navigation') {
    model.beginBurst();
    const target = rng.int(STEP_COUNT);
    for (let step = model.stepIndex; step < target; step += 1) {
      if (!availableControls(renderer).includes('result-guide-next')) break;
      act(() => {
        fireTap(renderer, 'result-guide-next', model, 0);
      });
      await tick(300);
    }
    await settle();
  }
  const requestsBefore = server.log.length;
  model.beginBurst();
  const controls = availableControls(renderer);
  const focusedBefore = focusedRoute();
  const onResult = focusedBefore?.name === 'Result' && controls.length > 0;

  const tapNow = (control: string, gapMs = 0) => {
    taps.push(fireTap(renderer, control, model, gapMs));
  };

  if (kind === 'spam-navigation' || !onResult) {
    const count = 2 + rng.int(4);
    for (let i = 0; i < count; i += 1) {
      const action = rng.pick(NAV_SPAM_ACTIONS);
      navActions.push(action);
      act(() => {
        dispatchSpam(action, model);
      });
      if (rng.chance(0.5)) await tick(rng.pick([0, 1, 5, 16, 50]));
    }
    // A spam burst always ends back on a Result route so the next burst has
    // controls to hit — the stack must be a single Result over Tabs.
    act(() => {
      if (routeNames().length > 1) navRef.dispatch(StackActions.popToTop());
      navRef.navigate('Result', { analysisId: rng.pick([A1, A2]) });
    });
    const focused = focusedRoute();
    model.analysisId = focused?.analysisId ?? model.analysisId;
    model.stepIndex = 0;
    model.leaving = true;
    model.unmounting = true;
  } else if (kind === 'double-tap' || kind === 'triple-tap') {
    const control = rng.pick(controls);
    const count = kind === 'double-tap' ? 2 : 3;
    act(() => {
      for (let i = 0; i < count; i += 1) tapNow(control);
    });
  } else if (kind === 'tap-during-transition') {
    const first = rng.pick(controls);
    act(() => tapNow(first));
    const gap = rng.pick([1, 16, 60, 120, 200, 239]);
    await tick(gap);
    const after = availableControls(renderer);
    if (after.length > 0) {
      const second = rng.pick(after);
      act(() => tapNow(second, gap));
    }
  } else if (kind === 'simultaneous-controls') {
    const first = rng.pick(controls);
    const others = controls.filter(control => control !== first);
    const second = others.length > 0 ? rng.pick(others) : first;
    act(() => {
      tapNow(first);
      tapNow(second);
    });
  } else {
    // back-during-async: start an async intent, then leave before it lands.
    const saveControls = controls.filter(
      control =>
        control.startsWith('recommended-drill-') && control.endsWith('-save'),
    );
    const asyncControl =
      saveControls.length > 0 ? rng.pick(saveControls) : rng.pick(controls);
    act(() => tapNow(asyncControl));
    await tick(rng.pick([0, 1, 5]));
    const exit = rng.pick([
      'goBack',
      'popToTop',
      'close-button',
      'next-then-back',
    ]);
    navActions.push(exit);
    act(() => {
      if (exit === 'close-button') {
        const stillThere = availableControls(renderer);
        if (stillThere.includes('result-guide-close'))
          tapNow('result-guide-close');
        else dispatchSpam('goBack', model);
      } else if (exit === 'next-then-back') {
        const stillThere = availableControls(renderer);
        if (stillThere.includes('result-guide-next'))
          tapNow('result-guide-next');
        if (availableControls(renderer).includes('result-guide-back')) {
          tapNow('result-guide-back');
        }
      } else {
        dispatchSpam(exit, model);
      }
    });
  }

  await settle();
  const violations = checkInvariants(renderer, model, requestsBefore, kind);
  return {
    kind,
    taps,
    navActions,
    routesAfter: routeNames(),
    focusedAfter: focusedRoute()?.name ?? null,
    requestsDuring: server.log.slice(requestsBefore),
    stepAfter: currentStep(renderer),
    violations,
  };
}

const BURST_KINDS: readonly BurstKind[] = [
  'double-tap',
  'triple-tap',
  'tap-during-transition',
  'simultaneous-controls',
  'back-during-async',
  'spam-navigation',
];

async function runIteration(seed: number): Promise<IterationRecord> {
  const startedAt = Date.now();
  const rng = new Rng(seed);
  mockLatency.dbMs = rng.pick([0, 0, 5, 40]);
  mockLatency.fetchMs = rng.pick([0, 10, 60, 200]);
  server.reset();
  server.failSaves = rng.chance(0.25);
  consoleErrors.length = 0;
  unhandled.length = 0;
  stateChanges = 0;
  clearTryAgainHandoff();
  useTrainingStore.getState().reset();

  const startId = rng.pick([A1, A2]);
  const model = new ScreenModel(startId);
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(<Harness analysisId={startId} />);
  });

  const bursts: BurstRecord[] = [];
  const violations: string[] = [];
  const sawAnalyzingOnMount = hasText(renderer, 'Opening your result…');
  let openingRace: string | null = null;

  // Opening race: leave while the evidence read is still in flight.
  if (rng.chance(0.25)) {
    const exit = rng.pick(['goBack', 'close-button']);
    openingRace = exit;
    act(() => {
      if (exit === 'close-button') {
        const close = pressableByTestID(renderer, 'result-guide-close');
        if (close) (close.props.onPress as () => void)();
        else dispatchSpam('goBack', model);
      } else {
        dispatchSpam('goBack', model);
      }
    });
    await settle();
    const routes = routeNames();
    if (routes.length !== 1 || routes[0] !== 'Tabs') {
      violations.push(`back-during-load:routes=${routes.join(',')}`);
    }
    if (hasText(renderer, 'Opening your result…')) {
      violations.push('back-during-load:orphan-analyzing');
    }
    act(() => {
      navRef.navigate('Result', { analysisId: startId });
    });
    model.analysisId = startId;
    model.stepIndex = 0;
  }
  await settle();
  if (hasText(renderer, 'Opening your result…')) {
    violations.push('initial:orphan-analyzing');
  }
  if (currentStep(renderer) !== 'result-guide-step-score') {
    violations.push(`initial:step=${currentStep(renderer)}`);
  }
  model.drillsMounts = 0;

  for (let b = 0; b < BURSTS_PER_ITERATION; b += 1) {
    const kind = rng.pick(BURST_KINDS);
    const burst = await runBurst(renderer, rng, model, kind);
    bursts.push(burst);
    violations.push(...burst.violations.map(v => `burst${b}:${kind}:${v}`));
    // If we navigated off the Result route, come back so the next burst has a
    // screen to hit (a fresh Result mounts at page one).
    if (focusedRoute()?.name !== 'Result') {
      act(() => {
        if (routeNames().length > 1) navRef.dispatch(StackActions.popToTop());
        navRef.navigate('Result', { analysisId: model.analysisId });
      });
      model.stepIndex = 0;
      await settle();
    }
    model.leaving = false;
    model.unmounting = false;
    // Requests are accounted per burst.
    server.log = [];
    model.acceptedMutations = 0;
    model.drillsMounts = 0;
    server.maxMutationInFlight = 0;
  }

  const routesFinal = routeNames();
  act(() => {
    renderer.unmount();
  });
  await settle();

  const actWarnings = consoleErrors.filter(
    message =>
      message.includes('not wrapped in act') ||
      message.includes('act(...)') ||
      message.includes('Cannot update a component') ||
      message.includes('unmounted component'),
  );
  violations.push(
    ...actWarnings.map(message => `act-warning:${message.slice(0, 160)}`),
  );
  violations.push(
    ...unhandled.map(message => `unhandled-rejection:${message.slice(0, 160)}`),
  );
  // React Navigation's dev-only "action not handled" notice fires when a
  // second tap re-dispatches a pop the first tap already performed; it is
  // recorded (see the JSON table) but is not a broken invariant.
  const navWarnings = consoleErrors.filter(message =>
    message.includes('was not handled by any navigator'),
  );
  const otherErrors = consoleErrors.filter(
    message => !actWarnings.includes(message) && !navWarnings.includes(message),
  );
  violations.push(
    ...otherErrors.map(
      message => `console-error:${message.replace(/\s+/g, ' ').slice(0, 120)}`,
    ),
  );

  return {
    seed,
    latency: { ...mockLatency },
    bursts,
    routesFinal,
    requestsTotal: bursts.reduce(
      (sum, burst) => sum + burst.requestsDuring.length,
      0,
    ),
    stateChanges,
    navWarnings: navWarnings.length,
    consoleErrors: [...consoleErrors],
    unhandledRejections: [...unhandled],
    violations,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    failSaves: server.failSaves,
    failedMutations: server.failedMutations,
    fakeClockAdvancedMs: Date.now() - startedAt,
    openingRace,
    sawAnalyzingOnMount,
  };
}

// ─── Suite ──────────────────────────────────────────────────────────────────

let errorSpy: jest.SpyInstance;

beforeAll(async () => {
  setActiveDataOwner(canonicalDataOwner(OWNER_ID));
  establishApiSession({
    apiBaseUrl: API_BASE,
    bearerToken: 'stress-bearer',
    canonicalAppUserId: OWNER_ID,
    provider: 'apple',
  });
  configureTrainingStore(
    createTrainingApi({
      baseUrl: API_BASE,
      get token() {
        return bearerTokenFor(OWNER_ID);
      },
    }),
  );
  globalThis.fetch = fetchDouble as unknown as typeof fetch;
  const db = getDb();
  await saveAnalysis(
    db,
    analysisFixture(A2, '2026-09-01T10:00:00.000Z', 6.8),
    'permit-stress-2',
  );
  await saveAnalysis(
    db,
    analysisFixture(A1, '2026-09-01T10:05:00.000Z', 7.4),
    'permit-stress-1',
  );
});

afterAll(() => {
  clearTrainingStoreConfiguration();
  clearApiSession();
  getDb().close();
});

beforeEach(() => {
  jest.useFakeTimers();
  errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(formatConsole(args));
    });
  process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  errorSpy.mockRestore();
  jest.useRealTimers();
});

describe('ResultScreen · rapid-interaction stress (real navigator, real stores)', () => {
  it(`holds every interaction invariant across ${ITERATIONS} seeded iteration(s) × ${BURSTS_PER_ITERATION} bursts`, async () => {
    const results: IterationRecord[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = SEED_BASE + i;
      results.push(await runIteration(seed));
    }
    const failing = results.filter(result => result.outcome === 'BROKEN');
    const table = {
      unit: 'scr-resultscreen',
      lens: 'rapid-interaction',
      iterations: results.length,
      burstsExecuted: results.reduce((sum, r) => sum + r.bursts.length, 0),
      tapsFired: results.reduce(
        (sum, r) =>
          sum +
          r.bursts.reduce(
            (inner, burst) =>
              inner + burst.taps.filter(tap => tap.fired).length,
            0,
          ),
        0,
      ),
      seedsFailed: failing.map(result => result.seed),
      navWarningsTotal: results.reduce((sum, r) => sum + r.navWarnings, 0),
      seedsWithNavWarnings: results
        .filter(result => result.navWarnings > 0)
        .map(result => result.seed),
      byKind: BURST_KINDS.map(kind => ({
        kind,
        bursts: results.reduce(
          (sum, r) =>
            sum + r.bursts.filter(burst => burst.kind === kind).length,
          0,
        ),
        violations: results.reduce(
          (sum, r) =>
            sum +
            r.bursts
              .filter(burst => burst.kind === kind)
              .reduce((inner, burst) => inner + burst.violations.length, 0),
          0,
        ),
      })),
      results,
    };
    if (OUT_FILE) {
      mkdirSync(dirname(OUT_FILE), { recursive: true });
      writeFileSync(OUT_FILE, JSON.stringify(table, null, 2));
    }
    expect(
      failing.map(result => ({
        seed: result.seed,
        violations: result.violations,
      })),
    ).toEqual([]);
    expect(table.burstsExecuted).toBe(ITERATIONS * BURSTS_PER_ITERATION);
  });
});
