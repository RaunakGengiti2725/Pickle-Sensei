import React from 'react';
import { StatusBar, Text, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { AsyncLocalStorage, createHook } from 'async_hooks';
import fs from 'fs';
import path from 'path';
import v8 from 'v8';
import vm from 'vm';
import { CHECKPOINTS } from '@pickle/shared-types';
import type { PermissionState } from '../../src/notifications/service';

/**
 * LONG-RUN LEAK stress campaign for OnboardingScreen.
 *
 * Mounts the REAL screen inside the providers App.tsx uses (SafeAreaProvider +
 * QueryClientProvider) with the REAL zustand stores behind it (appStore,
 * notificationStore, authStore, apiSession) — only the native SQLite module,
 * the OS notification scheduler, the safe-area native view and `fetch` are
 * replaced. Every iteration is a seeded, replayable walk through the
 * questionnaire (random answers, back-steps, re-selections, the in-account
 * "Leave setup" dialog, the sign-out path, write failures + retry, an
 * in-flight save torn down by unmount, and every ending), then the tree is
 * unmounted and the lifecycle invariants are checked:
 *
 *  - StatusBar stack (jest.setup.js mock) is back to its pre-mount length
 *  - no Timeout/Immediate created inside the walk is still pending (tracked
 *    through async_hooks + AsyncLocalStorage so the unit's timers are told
 *    apart from Jest's own — the reporter's 100 ms status debounce and the
 *    test-timeout timer live in the same process and are NOT the screen's)
 *  - the fetch mock has no dangling in-flight request
 *  - the store state matches what the walk should have persisted
 *  - no console.error (React act/key/prop warnings count as failures)
 *
 * Every STRESS_HEAP_EVERY iterations the heap is forced through two full GCs
 * and sampled (heapUsed/heapTotal/external/arrayBuffers), the active-handle
 * histogram is recorded, and every renderer/root created more than one
 * window ago is checked through a WeakRef — a retained React root is the
 * signature of a leaked subscription/listener/timer closure.
 *
 * Findings thresholds (coordinator lens `long-run-leak`): a least-squares
 * heapUsed slope > 5% per 100 iterations over the post-warm-up checkpoints,
 * a mount-time drift > 50% between the first and last windows, or any
 * retained renderer/handle/stack-entry after unmount.
 *
 * Env:
 *   STRESS_ITER        iterations (default 60 — fast enough for the suite)
 *   STRESS_SEED        master seed (default 20260904)
 *   STRESS_HEAP_EVERY  checkpoint interval (default 50)
 *   STRESS_REPLAY      comma-separated per-iteration seeds to replay only
 *   STRESS_OUT         path of the JSON evidence table to write
 *   STRESS_KEEP_INFRA_MOCKS=1  do NOT clear the jest.fn call ledgers of the
 *                      test-infrastructure mocks between iterations (see
 *                      below) — reproduces the harness artifact on purpose
 *   STRESS_SNAPSHOT_AT comma-separated iteration numbers at which to write a V8
 *                      .heapsnapshot next to STRESS_OUT (for retainer diffs)
 *
 * Harness artifact, deliberately isolated: jest.fn records every call (args
 * array + result object + invocation counter) forever, and this jest config
 * does not set `clearMocks`. Two infrastructure mocks are hit on every render:
 * @react-native/jest-preset installs `global.performance.now = jest.fn(Date.now)`
 * (React's scheduler calls it ~27k times per walk) and jest.setup.js mocks the
 * StatusBar statics `pushStackEntry`/`replaceStackEntry`/`popStackEntry`
 * (`replaceStackEntry` fires once per re-render of the screen). Their
 * `mock.calls` grow without bound and dominate heapUsed — that is test
 * infrastructure, not the screen. The harness records the per-iteration call
 * counts as evidence (`perfNowCalls`, `statusBarMockCalls`) and then clears
 * every jest.fn ledger (`jest.clearAllMocks()` — the preset's Keyboard /
 * AccessibilityInfo / NativeAnimated mocks retain ~3 KB per walk as well) after
 * each iteration so the heap slope measures the unit under test.
 *
 * Campaign: cd apps/mobile && STRESS_ITER=600 STRESS_OUT=/tmp/onb-leak.json \
 *   node --expose-gc node_modules/jest/bin/jest.js --ci --runInBand \
 *   __tests__/stress/onboardingScreen.longRunLeak.stress.test.tsx
 */

// The library's own jest mock: real SafeAreaProvider context wiring (frame +
// insets providers) with the native view replaced, so useReliableSafeAreaInsets
// reads through the genuine context path.
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

const mockKv = new Map<string, string>();
const mockDbControl: {
  writeError: Error | null;
  failWritesAfter: number | null;
  writes: number;
  reads: number;
  writeGate: Promise<void> | null;
} = {
  writeError: null,
  failWritesAfter: null,
  writes: 0,
  reads: 0,
  writeGate: null,
};

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        mockDbControl.reads += 1;
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockDbControl.writeGate) await mockDbControl.writeGate;
        mockDbControl.writes += 1;
        if (
          mockDbControl.writeError &&
          (mockDbControl.failWritesAfter === null ||
            mockDbControl.writes > mockDbControl.failWritesAfter)
        ) {
          throw mockDbControl.writeError;
        }
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (statement.startsWith('DELETE FROM kv')) {
        mockKv.delete(String(params[0]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

const mockScheduler = {
  permission: 'undetermined' as PermissionState,
  requestResult: 'granted' as PermissionState,
  requestError: null as Error | null,
  requestCalls: 0,
  cancelAllCalls: 0,
  appliedPlans: 0,
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  },
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    if (this.requestError) throw this.requestError;
    this.permission = this.requestResult;
    return this.requestResult;
  },
  async applyPlan(): Promise<void> {
    this.appliedPlans += 1;
  },
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
  },
  async openSystemSettings(): Promise<void> {},
};
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  focusForGoal,
  useAppStore,
} from '../../src/state/appStore';
import { useAuthStore } from '../../src/auth/authStore';
import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';
import { OnboardingScreen } from '../../src/screens/OnboardingScreen';
import {
  BrandDialog,
  type BrandDialogAction,
} from '../../src/design/components';

type Renderer = TestRenderer.ReactTestRenderer;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ITERATIONS = Math.max(1, Number(process.env.STRESS_ITER ?? 60) || 60);
const MASTER_SEED = Number(process.env.STRESS_SEED ?? 20260904) || 20260904;
const HEAP_EVERY = Math.max(
  1,
  Number(process.env.STRESS_HEAP_EVERY ?? 50) || 50,
);
const REPLAY_SEEDS = (process.env.STRESS_REPLAY ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
const OUT_PATH = process.env.STRESS_OUT ?? '';
const SNAPSHOT_AT = new Set(
  (process.env.STRESS_SNAPSHOT_AT ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0),
);

function writeHeapSnapshot(iteration: number) {
  if (!SNAPSHOT_AT.has(iteration)) return;
  const dir = OUT_PATH ? path.dirname(OUT_PATH) : process.cwd();
  fs.mkdirSync(dir, { recursive: true });
  v8.writeHeapSnapshot(
    path.join(dir, `onboarding-leak-iter${iteration}.heapsnapshot`),
  );
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) + per-iteration seed derivation
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iterationSeed(master: number, index: number): number {
  // splitmix-style scramble so consecutive iterations do not share prefixes.
  let z = (master + index * 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
}

// ---------------------------------------------------------------------------
// Screen vocabulary (labels are the product's accessibility labels)
// ---------------------------------------------------------------------------

type QuestionStep = {
  key: string;
  title: string;
  options: readonly (readonly [label: string, value: string])[];
};

const QUESTION_STEPS: readonly QuestionStep[] = [
  {
    key: 'gender',
    title: 'How do you identify?',
    options: [
      ['Female', 'female'],
      ['Male', 'male'],
      ['Non-binary', 'nonbinary'],
      ['Prefer not to say', 'prefer_not_to_say'],
    ],
  },
  {
    key: 'level',
    title: 'Where is your game today?',
    options: [
      ['Brand new', 'Beginner'],
      ['2.5', '2.5'],
      ['3.0', '3.0'],
      ['3.5', '3.5'],
      ['4.0', '4.0'],
      ['4.5', '4.5'],
      ['5.0+', '5.0+'],
    ],
  },
  {
    key: 'handedness',
    title: 'Which side is home?',
    options: [
      ['Right-handed', 'right'],
      ['Left-handed', 'left'],
    ],
  },
  {
    key: 'goal',
    title: 'What do you want to own?',
    options: [
      ['Dinks', 'dinks'],
      ['Drives', 'drives'],
      ['Third-shot drops', 'drops'],
      ['Serve', 'serve'],
      ['Volleys', 'volleys'],
      ['Footwork', 'footwork'],
      ['All-around', 'all-around'],
    ],
  },
  {
    key: 'problem',
    title: 'What breaks down most?',
    options: [
      ['Consistency', 'consistency'],
      ['Control', 'control'],
      ['Power', 'power'],
      ['Contact', 'contact'],
      ['Footwork', 'footwork'],
      ['Placement', 'placement'],
      ['Not sure', 'not sure'],
    ],
  },
];

const NAME_POOL = [
  'Dana',
  ' Dana ',
  'Zoë',
  'José María',
  '李雷',
  'Ava-Grace',
  "O'Neil",
  '🥒 Pickle',
  'A',
  'Bartholomew-Alexander Fitzgerald III',
  'x'.repeat(40),
  '  Léa\t',
];

const SERVER_CHECKPOINTS = [
  'paddle_set',
  'contact_position',
  'swing_length',
  'follow_through',
] as const satisfies readonly (typeof CHECKPOINTS)[number][];

type Mode = 'preauth' | 'account-guest' | 'account-canonical';
type Ending =
  | 'enable'
  | 'not_now'
  | 'abandon'
  | 'inflight'
  | 'write_error_retry'
  | 'signout';

type Scenario = {
  seed: number;
  mode: Mode;
  name: string;
  typeCharByChar: boolean;
  submitViaKeyboard: boolean;
  answers: Record<string, string>;
  reselects: number;
  backSteps: number;
  leaveDialog: 'none' | 'keep' | 'dismiss' | 'signout';
  ending: Ending;
  abandonAtStep: number;
  permission: PermissionState | 'error';
  serverCheckpoint: (typeof SERVER_CHECKPOINTS)[number];
  serverFails: boolean;
};

function planScenario(seed: number): Scenario {
  const rng = new Rng(seed);
  const mode = rng.pick<Mode>([
    'preauth',
    'preauth',
    'account-guest',
    'account-guest',
    'account-canonical',
  ]);
  const answers: Record<string, string> = {};
  for (const step of QUESTION_STEPS) {
    answers[step.key] = rng.pick(step.options)[1];
  }
  const endings: Ending[] =
    mode === 'preauth'
      ? [
          'enable',
          'enable',
          'not_now',
          'not_now',
          'abandon',
          'inflight',
          'write_error_retry',
        ]
      : [
          'enable',
          'enable',
          'not_now',
          'not_now',
          'abandon',
          'inflight',
          'write_error_retry',
          'signout',
        ];
  const ending = rng.pick(endings);
  const leaveRoll = rng.float();
  const leaveDialog: Scenario['leaveDialog'] =
    mode === 'preauth'
      ? 'none'
      : ending === 'signout'
        ? 'signout'
        : leaveRoll < 0.6
          ? 'none'
          : leaveRoll < 0.85
            ? 'keep'
            : 'dismiss';
  return {
    seed,
    mode,
    name: rng.pick(NAME_POOL),
    typeCharByChar: rng.chance(0.25),
    submitViaKeyboard: rng.chance(0.3),
    answers,
    reselects: rng.int(3),
    backSteps: rng.int(3),
    leaveDialog,
    ending,
    abandonAtStep: rng.int(8),
    permission: rng.pick<PermissionState | 'error'>([
      'granted',
      'granted',
      'denied',
      'error',
    ]),
    serverCheckpoint: rng.pick(SERVER_CHECKPOINTS),
    serverFails: rng.chance(0.2),
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers (mirrors App.tsx: SafeAreaProvider > QueryClientProvider)
// ---------------------------------------------------------------------------

const queryClient = new QueryClient();

function mountScreen(props: React.ComponentProps<typeof OnboardingScreen>) {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <OnboardingScreen {...props} />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  return renderer;
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join('');
}

function isAncestor(
  ancestor: TestRenderer.ReactTestInstance,
  node: TestRenderer.ReactTestInstance,
): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function pressables(renderer: Renderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  return matches.filter(
    node => !matches.some(other => other !== node && isAncestor(node, other)),
  );
}

class WalkError extends Error {}

function findPressable(renderer: Renderer, label: string) {
  const nodes = pressables(renderer, label);
  if (nodes.length === 0) throw new WalkError(`no pressable "${label}"`);
  return nodes[0]!;
}

function press(renderer: Renderer, label: string) {
  const node = findPressable(renderer, label);
  if (node.props.disabled) throw new WalkError(`"${label}" is disabled`);
  act(() => {
    node.props.onPress();
  });
}

async function pressAsync(renderer: Renderer, label: string) {
  const node = findPressable(renderer, label);
  if (node.props.disabled) throw new WalkError(`"${label}" is disabled`);
  await act(async () => {
    node.props.onPress();
  });
}

function expectText(renderer: Renderer, needle: string) {
  const text = allText(renderer);
  if (!text.includes(needle)) {
    throw new WalkError(`expected screen text to contain "${needle}"`);
  }
}

function progressNow(renderer: Renderer): number {
  return renderer.root.findByProps({ accessibilityRole: 'progressbar' }).props
    .accessibilityValue.now;
}

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

function resolveGc(): () => void {
  const direct = (globalThis as { gc?: () => void }).gc;
  if (typeof direct === 'function') return direct;
  v8.setFlagsFromString('--expose_gc');
  const fromVm = vm.runInNewContext('gc') as (() => void) | undefined;
  if (typeof fromVm !== 'function') {
    throw new Error('unable to expose gc (run node --expose-gc)');
  }
  return fromVm;
}

function handleHistogram(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) {
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

function timerHandles(): number {
  const h = handleHistogram();
  return (h['Timeout'] ?? 0) + (h['Immediate'] ?? 0);
}

type PendingTimer = {
  iteration: number;
  type: 'Timeout' | 'Immediate';
  ms: number | null;
  repeat: boolean;
  callback: string;
};

type TimerResource = {
  _idleTimeout?: number;
  _repeat?: number | null;
  _onTimeout?: unknown;
  _onImmediate?: unknown;
};

const unitScope = new AsyncLocalStorage<{ iteration: number }>();
const pendingUnitTimers = new Map<number, PendingTimer>();

createHook({
  init(asyncId, type, _triggerAsyncId, resource) {
    if (type !== 'Timeout' && type !== 'Immediate') return;
    const scope = unitScope.getStore();
    if (!scope) return;
    const timer = resource as TimerResource;
    const callback = type === 'Timeout' ? timer._onTimeout : timer._onImmediate;
    pendingUnitTimers.set(asyncId, {
      iteration: scope.iteration,
      type,
      ms: type === 'Timeout' ? (timer._idleTimeout ?? null) : null,
      repeat: timer._repeat != null,
      callback: String(callback).replace(/\s+/g, ' ').slice(0, 200),
    });
  },
  destroy(asyncId) {
    pendingUnitTimers.delete(asyncId);
  },
}).enable();

// async_hooks `destroy` callbacks are delivered in a batch from a native
// immediate, not synchronously when a timer fires or is cleared. Give the
// event loop two check phases so the ledger reflects what is really pending;
// the yields themselves run outside the unit scope so they are not tracked.
async function settleTimerLedger() {
  for (let i = 0; i < 2; i += 1) {
    await unitScope.exit(
      () => new Promise<void>(resolve => setImmediate(resolve)),
    );
  }
}

function describePendingUnitTimers(): string {
  return [...pendingUnitTimers.values()]
    .map(
      t =>
        `#${t.iteration} ${t.type}(${t.ms ?? ''}${t.repeat ? ',repeat' : ''}) ${t.callback}`,
    )
    .join(' || ');
}

function statusBarStackLength(): number {
  return (StatusBar as unknown as { _propsStack: unknown[] })._propsStack
    .length;
}

function leastSquaresSlope(points: Array<[number, number]>): number {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) * (x - mx);
  }
  return den === 0 ? 0 : num / den;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Fetch mock (only the canonical PUT /v1/me/onboarding path is reachable)
// ---------------------------------------------------------------------------

const fetchControl = {
  calls: 0,
  inflight: 0,
  fail: false,
  checkpoint: 'paddle_set' as string,
  lastBody: null as unknown,
};

function installFetch() {
  const fetchMock = async (_url: string, init?: RequestInit) => {
    fetchControl.calls += 1;
    fetchControl.inflight += 1;
    try {
      await Promise.resolve();
      fetchControl.lastBody = init?.body ? JSON.parse(String(init.body)) : null;
      if (fetchControl.fail) {
        return new Response(
          JSON.stringify({ error: { message: 'Simulated server outage.' } }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ recommendedCheckpoint: fetchControl.checkpoint }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    } finally {
      fetchControl.inflight -= 1;
    }
  };
  (globalThis as { fetch: unknown }).fetch = fetchMock;
}

// ---------------------------------------------------------------------------
// One iteration
// ---------------------------------------------------------------------------

type IterationRecord = {
  index: number;
  seed: number;
  mode: Mode;
  ending: Ending;
  leaveDialog: Scenario['leaveDialog'];
  permission: Scenario['permission'];
  outcome: 'HELD' | 'BROKEN';
  reason: string | null;
  mountMs: number;
  totalMs: number;
  presses: number;
  kvWrites: number;
  fetchCalls: number;
  perfNowCalls: number;
  statusBarMockCalls: number;
  unitTimersPending: number;
};

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

const KEEP_INFRA_MOCKS = process.env.STRESS_KEEP_INFRA_MOCKS === '1';

function drainMockLedger(fn: unknown): number {
  if (!jest.isMockFunction(fn)) return -1;
  const calls = fn.mock.calls.length;
  if (!KEEP_INFRA_MOCKS) fn.mockClear();
  return calls;
}

function drainPerfNowMock(): number {
  return drainMockLedger(performance.now);
}

const STATUS_BAR_MOCKED_STATICS = [
  'pushStackEntry',
  'replaceStackEntry',
  'popStackEntry',
] as const;

function drainStatusBarMocks(): number {
  const statics = StatusBar as unknown as Record<
    (typeof STATUS_BAR_MOCKED_STATICS)[number],
    unknown
  >;
  return STATUS_BAR_MOCKED_STATICS.reduce(
    (sum, key) => sum + Math.max(0, drainMockLedger(statics[key])),
    0,
  );
}

const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';

function resetWorld() {
  mockKv.clear();
  mockDbControl.writeError = null;
  mockDbControl.failWritesAfter = null;
  mockDbControl.writes = 0;
  mockDbControl.reads = 0;
  mockDbControl.writeGate = null;
  mockScheduler.permission = 'undetermined';
  mockScheduler.requestResult = 'granted';
  mockScheduler.requestError = null;
  mockScheduler.requestCalls = 0;
  mockScheduler.cancelAllCalls = 0;
  mockScheduler.appliedPlans = 0;
  fetchControl.calls = 0;
  fetchControl.fail = false;
  fetchControl.lastBody = null;
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAppStore.setState({
    hydrated: true,
    ownerKey: SIGNED_OUT_DATA_OWNER,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    permission: 'unknown',
    prefs: { ...useNotificationStore.getInitialState().prefs },
    persistFailed: false,
    scheduleFailed: false,
  });
  useAuthStore.setState({ session: null, busy: false, error: null });
}

function expectedProfile(s: Scenario) {
  const goal = s.answers['goal']!;
  return {
    firstName: s.name.trim() || undefined,
    gender: s.answers['gender'],
    skillLevel: s.answers['level'],
    handedness: s.answers['handedness'],
    goal,
    biggestProblem: s.answers['problem'],
    focusCheckpoint: focusForGoal(goal),
  };
}

function sameProfile(actual: unknown, expected: Record<string, unknown>) {
  if (!actual || typeof actual !== 'object') return false;
  const a = actual as Record<string, unknown>;
  return Object.keys(expected).every(k => a[k] === expected[k]);
}

async function runIteration(
  index: number,
  scenario: Scenario,
  renderers: WeakRef<object>[],
  consoleErrors: string[],
): Promise<IterationRecord> {
  const s = scenario;
  const startedAt = nowMs();
  resetWorld();
  const statusBarBaseline = statusBarStackLength();

  if (s.mode === 'account-guest') setActiveDataOwner(GUEST_DATA_OWNER);
  if (s.mode === 'account-canonical') {
    setActiveDataOwner(canonicalDataOwner(CANONICAL_ID));
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'stress-bearer',
      canonicalAppUserId: CANONICAL_ID,
      provider: 'apple',
    });
    fetchControl.checkpoint = s.serverCheckpoint;
  }
  if (s.permission === 'error') {
    mockScheduler.requestError = new Error('simulated OS permission failure');
  } else {
    mockScheduler.requestResult = s.permission;
  }

  const onFinished = jest.fn();
  const onBack = jest.fn();
  const props =
    s.mode === 'preauth'
      ? { mode: 'preauth' as const, onFinished, onBack }
      : { mode: 'account' as const };

  const mountStart = nowMs();
  const renderer = mountScreen(props);
  const mountMs = nowMs() - mountStart;
  renderers.push(new WeakRef(renderer));
  let presses = 0;
  let unmounted = false;

  const doPress = (label: string) => {
    press(renderer, label);
    presses += 1;
  };
  const rng = new Rng(s.seed ^ 0x5bd1e995);
  const visited = new Set<string>();
  let backBudget = s.backSteps;

  try {
    // ---- step 1: name ----------------------------------------------------
    expectText(renderer, 'What should we call you?');
    if (progressNow(renderer) !== 1) throw new WalkError('progress != 1');
    if (findPressable(renderer, 'Continue').props.disabled !== true) {
      throw new WalkError('Continue enabled before a name was typed');
    }
    const input = () => renderer.root.findByType(TextInput);
    if (s.typeCharByChar) {
      let typed = '';
      for (const ch of s.name) {
        typed += ch;
        const value = typed;
        act(() => input().props.onChangeText(value));
      }
    } else {
      act(() => input().props.onChangeText(s.name));
    }
    // "Leave setup" (in-account sign-out) exists only on step one; later
    // steps swap it for Back.
    if (s.mode !== 'preauth' && s.leaveDialog !== 'none') {
      await driveLeaveDialog(renderer, s);
      presses += 1;
      if (s.leaveDialog === 'signout') {
        return finish('HELD', null);
      }
    }
    if (s.ending === 'abandon' && s.abandonAtStep === 0)
      return finish('HELD', null);
    if (s.submitViaKeyboard) {
      act(() => input().props.onSubmitEditing());
    } else {
      doPress('Continue');
    }

    // ---- steps 2..6: questions --------------------------------------------
    let stepNo = 1;
    while (stepNo <= QUESTION_STEPS.length) {
      const q = QUESTION_STEPS[stepNo - 1]!;
      expectText(renderer, q.title);
      if (progressNow(renderer) !== stepNo + 1) {
        throw new WalkError(
          `progress ${progressNow(renderer)} != ${stepNo + 1}`,
        );
      }
      if (findPressable(renderer, 'Continue').props.disabled !== true) {
        // A re-visited step keeps its answer (Continue enabled) — only a
        // first visit must be locked.
        if (!visited.has(q.key)) {
          throw new WalkError(`Continue enabled on unanswered ${q.key}`);
        }
      }
      for (let r = 0; r < s.reselects; r += 1) {
        doPress(rng.pick(q.options)[0]);
      }
      const chosenLabel = q.options.find(o => o[1] === s.answers[q.key])![0];
      doPress(chosenLabel);
      const chosenNode = findPressable(renderer, chosenLabel);
      if (chosenNode.props.accessibilityState?.selected !== true) {
        throw new WalkError(`${chosenLabel} not marked selected`);
      }
      visited.add(q.key);
      if (s.mode !== 'preauth' && pressables(renderer, 'Leave setup').length) {
        throw new WalkError('Leave setup rendered past step one');
      }
      if (s.ending === 'abandon' && s.abandonAtStep === stepNo) {
        return finish('HELD', null);
      }
      if (backBudget > 0 && stepNo > 1 && rng.chance(0.5)) {
        backBudget -= 1;
        doPress('Back');
        stepNo -= 1;
        // Re-confirm the previous answer is still selected, then continue.
        const prev = QUESTION_STEPS[stepNo - 1]!;
        expectText(renderer, prev.title);
        const prevLabel = prev.options.find(
          o => o[1] === s.answers[prev.key],
        )![0];
        if (
          findPressable(renderer, prevLabel).props.accessibilityState
            ?.selected !== true
        ) {
          throw new WalkError(`answer for ${prev.key} lost after Back`);
        }
        doPress('Continue');
        stepNo += 1;
        continue;
      }
      doPress('Continue');
      stepNo += 1;
    }

    // ---- step 7: reveal -------------------------------------------------
    expectText(renderer, 'YOUR STARTING PLAN');
    if (progressNow(renderer) !== 7)
      throw new WalkError('reveal progress != 7');
    if (s.ending === 'abandon' && s.abandonAtStep === 6)
      return finish('HELD', null);
    if (backBudget > 0 && rng.chance(0.5)) {
      doPress('Back');
      expectText(renderer, QUESTION_STEPS[4]!.title);
      doPress('Continue');
      expectText(renderer, 'YOUR STARTING PLAN');
    }
    doPress('Continue');

    // ---- step 8: notifications ------------------------------------------
    expectText(renderer, 'Stay match-ready.');
    if (progressNow(renderer) !== 8) throw new WalkError('notif progress != 8');
    if (s.ending === 'abandon') return finish('HELD', null);

    const choiceLabel =
      s.ending === 'not_now' ? 'Not now' : 'Turn on reminders';
    const expectEnabled = s.ending !== 'not_now' && s.permission === 'granted';
    const profile = expectedProfile(s);

    if (s.ending === 'inflight') {
      let release!: () => void;
      mockDbControl.writeGate = new Promise<void>(resolve => {
        release = resolve;
      });
      await pressAsync(renderer, choiceLabel);
      presses += 1;
      // Both buttons are locked while the save is in flight, then the
      // screen is torn down before the write resolves.
      if (!findPressable(renderer, 'Not now').props.disabled) {
        throw new WalkError('Not now enabled while save in flight');
      }
      expectText(renderer, 'Finishing setup…');
      act(() => renderer.unmount());
      unmounted = true;
      release();
      await flush();
      await flush();
      if (useAppStore.getState().onboardingBusy) {
        throw new WalkError('onboardingBusy stuck after in-flight unmount');
      }
      return finish('HELD', null);
    }

    if (s.ending === 'write_error_retry') {
      mockDbControl.writeError = new Error('disk full (simulated)');
      // Let the notification stash (pre-auth) or prefs write go through and
      // fail only the profile write.
      mockDbControl.failWritesAfter = s.mode === 'preauth' ? 1 : 0;
      if (s.mode === 'account-canonical') fetchControl.fail = s.serverFails;
      await pressAsync(renderer, choiceLabel);
      presses += 1;
      await flush();
      expectText(
        renderer,
        s.mode === 'account-canonical' && s.serverFails
          ? 'Simulated server outage.'
          : 'disk full (simulated)',
      );
      if (onFinished.mock.calls.length !== 0) {
        throw new WalkError('onFinished fired despite failed stash');
      }
      if (findPressable(renderer, choiceLabel).props.disabled) {
        throw new WalkError('finish button stayed disabled after failure');
      }
      // Retry with the fault cleared.
      mockDbControl.writeError = null;
      mockDbControl.failWritesAfter = null;
      fetchControl.fail = false;
      await pressAsync(renderer, choiceLabel);
      presses += 1;
      await flush();
      if (allText(renderer).includes('disk full (simulated)')) {
        throw new WalkError('error copy persisted after successful retry');
      }
    } else {
      await pressAsync(renderer, choiceLabel);
      presses += 1;
      await flush();
    }

    // The OS permission prompt is asked at most once per screen visit.
    const expectedRequests = s.ending === 'not_now' ? 0 : 1;
    if (mockScheduler.requestCalls !== expectedRequests) {
      throw new WalkError(
        `permission requested ${mockScheduler.requestCalls}x, expected ${expectedRequests}`,
      );
    }

    if (s.mode === 'preauth') {
      if (onFinished.mock.calls.length !== 1) {
        throw new WalkError(
          `onFinished called ${onFinished.mock.calls.length}x`,
        );
      }
      const rawProfile = mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
      const stash = rawProfile
        ? (JSON.parse(rawProfile) as { profile: unknown })
        : null;
      if (!stash || !sameProfile(stash.profile, profile)) {
        throw new WalkError('pre-auth profile stash mismatch');
      }
      const rawNotif = mockKv.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY);
      const notif = rawNotif
        ? (JSON.parse(rawNotif) as { enabled: boolean })
        : null;
      if (!notif || notif.enabled !== expectEnabled) {
        throw new WalkError(
          `notification stash enabled=${notif?.enabled} expected ${expectEnabled}`,
        );
      }
    } else {
      const state = useAppStore.getState();
      if (state.onboardingBusy) throw new WalkError('onboardingBusy stuck');
      if (state.onboardingError) {
        throw new WalkError(`onboardingError: ${state.onboardingError}`);
      }
      const expected =
        s.mode === 'account-canonical'
          ? { ...profile, focusCheckpoint: s.serverCheckpoint }
          : profile;
      if (!sameProfile(state.profile, expected)) {
        throw new WalkError('account profile mismatch');
      }
      if (s.mode === 'account-canonical') {
        if (fetchControl.calls < 1)
          throw new WalkError('canonical save never hit fetch');
        const body = fetchControl.lastBody as Record<string, unknown> | null;
        if (!body || body['goal'] !== profile.goal) {
          throw new WalkError('canonical PUT body mismatch');
        }
      }
      const prefs = useNotificationStore.getState().prefs;
      if (prefs.enabled !== expectEnabled || prefs.promptDismissed !== true) {
        throw new WalkError(
          `prefs enabled=${prefs.enabled} dismissed=${prefs.promptDismissed}`,
        );
      }
    }
    return finish('HELD', null);
  } catch (error) {
    return finish(
      'BROKEN',
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
  }

  async function finish(
    outcome: 'HELD' | 'BROKEN',
    why: string | null,
  ): Promise<IterationRecord> {
    let finalReason = why;
    if (!unmounted) {
      act(() => renderer.unmount());
      unmounted = true;
    }
    await flush();
    await settleTimerLedger();
    if (statusBarStackLength() !== statusBarBaseline) {
      finalReason ??= `StatusBar stack ${statusBarStackLength()} != ${statusBarBaseline}`;
    }
    if (fetchControl.inflight !== 0) {
      finalReason ??= `fetch inflight ${fetchControl.inflight} after unmount`;
    }
    if (pendingUnitTimers.size !== 0) {
      finalReason ??= `${pendingUnitTimers.size} timer(s) still pending after unmount: ${describePendingUnitTimers()}`;
    }
    if (consoleErrors.length) {
      finalReason ??= `console.error: ${consoleErrors[0]!.slice(0, 200)}`;
    }
    const record: IterationRecord = {
      index,
      seed: s.seed,
      mode: s.mode,
      ending: s.ending,
      leaveDialog: s.leaveDialog,
      permission: s.permission,
      outcome: finalReason ? 'BROKEN' : outcome,
      reason: finalReason,
      mountMs: Number(mountMs.toFixed(3)),
      totalMs: Number((nowMs() - startedAt).toFixed(3)),
      presses,
      kvWrites: mockDbControl.writes,
      fetchCalls: fetchControl.calls,
      perfNowCalls: drainPerfNowMock(),
      statusBarMockCalls: drainStatusBarMocks(),
      unitTimersPending: pendingUnitTimers.size,
    };
    // Every other jest.fn() in the RN jest preset (Keyboard, AccessibilityInfo,
    // NativeAnimated, ...) records args/results per call too; without this
    // the campaign measures Jest's mock ledgers, not the screen.
    if (!KEEP_INFRA_MOCKS) jest.clearAllMocks();
    return record;
  }
}

async function driveLeaveDialog(renderer: Renderer, s: Scenario) {
  press(renderer, 'Leave setup');
  const dialog = renderer.root.findByType(BrandDialog);
  if (dialog.props.visible !== true)
    throw new WalkError('leave dialog not visible');
  if (dialog.props.title !== 'Leave setup?')
    throw new WalkError('leave dialog title');
  const actions = dialog.props.actions as readonly BrandDialogAction[];
  if (s.leaveDialog === 'keep') {
    const keep = actions.find(a => a.label === 'Keep setting up');
    if (!keep) throw new WalkError('no Keep setting up action');
    act(() => keep.onPress());
  } else if (s.leaveDialog === 'dismiss') {
    act(() => dialog.props.onDismiss());
  } else {
    const signOut = actions.find(a => a.label === 'Sign out');
    if (!signOut) throw new WalkError('no Sign out action');
    await act(async () => {
      signOut.onPress();
    });
    await flush();
    if (getActiveDataOwner() !== SIGNED_OUT_DATA_OWNER) {
      throw new WalkError('sign-out did not clear the active data owner');
    }
    if (useAuthStore.getState().session !== null) {
      throw new WalkError('sign-out left a session');
    }
  }
  if (renderer.root.findByType(BrandDialog).props.visible !== false) {
    throw new WalkError('leave dialog still visible');
  }
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

type Checkpoint = {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  rss: number;
  handles: Record<string, number>;
  timerHandles: number;
  unitTimersPending: number;
  statusBarStack: number;
  aliveOldRenderers: number;
  trackedRenderers: number;
  medianMountMsWindow: number;
  medianTotalMsWindow: number;
};

describe('stress: OnboardingScreen long-run leak (real stores + providers)', () => {
  const originalError = console.error;
  const consoleErrors: string[] = [];
  const gc = resolveGc();

  beforeAll(() => {
    installFetch();
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(a => String(a)).join(' '));
    };
  });
  afterAll(() => {
    console.error = originalError;
    queryClient.clear();
  });

  const timeoutMs = Math.max(60_000, ITERATIONS * 600);

  it(
    `mounts/unmounts ${REPLAY_SEEDS.length || ITERATIONS} seeded walks, heap sampled every ${HEAP_EVERY}`,
    async () => {
      const seeds =
        REPLAY_SEEDS.length > 0
          ? REPLAY_SEEDS
          : Array.from({ length: ITERATIONS }, (_, i) =>
              iterationSeed(MASTER_SEED, i),
            );

      const renderers: WeakRef<object>[] = [];
      const records: IterationRecord[] = [];
      const checkpoints: Checkpoint[] = [];

      // Warm module caches/JIT with one throwaway walk so the baseline handle
      // count reflects the steady state, not first-import work.
      resetWorld();
      gc();
      gc();
      await flush();
      const baselineTimers = timerHandles();
      const baselineStatusBar = statusBarStackLength();
      const baselineHeap = process.memoryUsage().heapUsed;

      for (let i = 0; i < seeds.length; i += 1) {
        consoleErrors.length = 0;
        const scenario = planScenario(seeds[i]!);
        const record = await unitScope.run({ iteration: i }, () =>
          runIteration(i, scenario, renderers, consoleErrors),
        );
        records.push(record);

        if ((i + 1) % HEAP_EVERY === 0 || i === seeds.length - 1) {
          await flush();
          gc();
          gc();
          await flush();
          gc();
          await settleTimerLedger();
          const mem = process.memoryUsage();
          writeHeapSnapshot(i + 1);
          const windowRecords = records.slice(-HEAP_EVERY);
          const oldRefs = renderers.slice(
            0,
            Math.max(0, renderers.length - HEAP_EVERY),
          );
          checkpoints.push({
            iteration: i + 1,
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            external: mem.external,
            arrayBuffers: mem.arrayBuffers,
            rss: mem.rss,
            handles: handleHistogram(),
            timerHandles: timerHandles(),
            unitTimersPending: pendingUnitTimers.size,
            statusBarStack: statusBarStackLength(),
            aliveOldRenderers: oldRefs.filter(r => r.deref() !== undefined)
              .length,
            trackedRenderers: renderers.length,
            medianMountMsWindow: Number(
              median(windowRecords.map(r => r.mountMs)).toFixed(3),
            ),
            medianTotalMsWindow: Number(
              median(windowRecords.map(r => r.totalMs)).toFixed(3),
            ),
          });
        }
      }

      // ---- analysis --------------------------------------------------------
      const warm = checkpoints.length >= 4 ? checkpoints.slice(1) : checkpoints;
      const slopePerIter = leastSquaresSlope(
        warm.map(c => [c.iteration, c.heapUsed]),
      );
      const meanHeap =
        warm.reduce((s, c) => s + c.heapUsed, 0) / Math.max(1, warm.length);
      const slopePctPer100 = meanHeap
        ? (slopePerIter * 100 * 100) / meanHeap
        : 0;
      let monotoneRises = 0;
      for (let k = 1; k < warm.length; k += 1) {
        if (warm[k]!.heapUsed > warm[k - 1]!.heapUsed) monotoneRises += 1;
      }
      const firstWindow = checkpoints[Math.min(1, checkpoints.length - 1)];
      const lastWindow = checkpoints[checkpoints.length - 1];
      const mountDriftRatio =
        firstWindow && lastWindow && firstWindow.medianMountMsWindow > 0
          ? lastWindow.medianMountMsWindow / firstWindow.medianMountMsWindow
          : 1;
      const totalDriftRatio =
        firstWindow && lastWindow && firstWindow.medianTotalMsWindow > 0
          ? lastWindow.medianTotalMsWindow / firstWindow.medianTotalMsWindow
          : 1;
      const failures = records.filter(r => r.outcome === 'BROKEN');
      const final = checkpoints[checkpoints.length - 1]!;

      const byMode: Record<string, number> = {};
      const byEnding: Record<string, number> = {};
      for (const r of records) {
        byMode[r.mode] = (byMode[r.mode] ?? 0) + 1;
        byEnding[r.ending] = (byEnding[r.ending] ?? 0) + 1;
      }

      const summary = {
        unit: 'scr-onboardingscreen',
        lens: 'long-run-leak',
        masterSeed: MASTER_SEED,
        iterationsRequested: seeds.length,
        iterationsExecuted: records.length,
        heapEvery: HEAP_EVERY,
        node: process.version,
        gcExposed: typeof (globalThis as { gc?: unknown }).gc === 'function',
        infraMocksCleared: !KEEP_INFRA_MOCKS,
        perfNowCallsPerIterMedian: median(records.map(r => r.perfNowCalls)),
        statusBarMockCallsPerIterMedian: median(
          records.map(r => r.statusBarMockCalls),
        ),
        baseline: {
          heapUsed: baselineHeap,
          timerHandles: baselineTimers,
          statusBarStack: baselineStatusBar,
        },
        final: {
          heapUsed: final.heapUsed,
          timerHandles: final.timerHandles,
          unitTimersPending: final.unitTimersPending,
          statusBarStack: final.statusBarStack,
          aliveOldRenderers: final.aliveOldRenderers,
        },
        heapSlopePctPer100Iters: Number(slopePctPer100.toFixed(3)),
        heapSlopeBytesPerIter: Number(slopePerIter.toFixed(1)),
        monotoneRisesBetweenCheckpoints: `${monotoneRises}/${Math.max(0, warm.length - 1)}`,
        mountMsDriftRatioLastVsFirst: Number(mountDriftRatio.toFixed(3)),
        totalMsDriftRatioLastVsFirst: Number(totalDriftRatio.toFixed(3)),
        medianMountMsAll: Number(
          median(records.map(r => r.mountMs)).toFixed(3),
        ),
        medianTotalMsAll: Number(
          median(records.map(r => r.totalMs)).toFixed(3),
        ),
        totalPresses: records.reduce((s, r) => s + r.presses, 0),
        byMode,
        byEnding,
        failures: failures.length,
        failedSeeds: failures.map(f => ({ seed: f.seed, reason: f.reason })),
      };

      if (OUT_PATH) {
        fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
        fs.writeFileSync(
          OUT_PATH,
          JSON.stringify(
            { summary, checkpoints, iterations: records },
            null,
            2,
          ),
        );
      }
      process.stdout.write(
        `\n[stress:onboarding-leak] ${JSON.stringify(summary)}\n`,
      );

      // ---- assertions -----------------------------------------------------
      expect(failures.map(f => ({ seed: f.seed, reason: f.reason }))).toEqual(
        [],
      );
      expect(final.statusBarStack).toBe(baselineStatusBar);
      // Process-level handle counts are recorded as evidence only: Jest's own
      // reporter debounce timer shares this process. The unit's timers are
      // asserted through the async_hooks ledger, per iteration and here.
      expect(describePendingUnitTimers()).toBe('');
      expect(checkpoints.filter(c => c.unitTimersPending !== 0)).toEqual([]);
      // React keeps at most the most recent root reachable through its
      // internal scheduler; anything older than one full window must be gone.
      expect(final.aliveOldRenderers).toBeLessThanOrEqual(1);
      if (checkpoints.length >= 4) {
        expect(slopePctPer100).toBeLessThanOrEqual(5);
        expect(mountDriftRatio).toBeLessThanOrEqual(1.5);
      }
    },
    timeoutMs,
  );
});
