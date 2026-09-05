import React from 'react';
import { AccessibilityInfo, Linking, StatusBar, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  NavigationContainer,
  StackActions,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as v8 from 'node:v8';

/**
 * LONG-RUN LEAK stress harness for ConsentSettingsScreen.
 *
 * The screen is mounted inside the REAL `NavigationContainer` + native stack
 * + `SafeAreaProvider` (the same providers RootNavigator uses) with the real
 * consent / auth / api-session stores and hooks. Only native modules (the
 * app's SQLite handle, safe-area insets) and `globalThis.fetch` are mocked.
 *
 * Every iteration is one seeded scenario: an auth state, a scripted consent
 * server, and 0–4 user actions (toggle, double tap, retry, connect account,
 * account switch mid-flight, request timeout, back). The screen is entered
 * and left the way the app does it — pushed/popped on a long-lived container
 * ("push_pop") or by mounting/unmounting a whole container ("remount").
 *
 * After EVERY iteration the harness asserts that the store matches an oracle
 * mirror of the consent contract and that zustand subscriptions, fake
 * timers, in-flight fetches, Linking listeners, the StatusBar props stack and
 * mounted roots are back at their baseline. Every `STRESS_CHECKPOINT`
 * iterations it forces a GC (`node --expose-gc`) and records heap, RSS,
 * `process.getActiveResourcesInfo()`, listener counts and render timings.
 *
 * Env:
 *   STRESS_ITER        iterations to run (default 100; the campaign is ≥500)
 *   STRESS_SEED        master seed (default 20260904)
 *   STRESS_CHECKPOINT  heap/handle checkpoint interval (default 50)
 *   STRESS_OUT         write the JSON result table (seed → outcome) here
 *   STRESS_REPLAY      replay ONE iteration seed STRESS_ITER times
 *   STRESS_MODE        force 'push_pop' | 'remount' (default: seeded mix)
 *   STRESS_UNIT        'control' swaps in a trivial screen (null-unit control)
 *   STRESS_HEAPSNAP    comma-separated checkpoint iterations at which to write
 *                      a V8 heap snapshot next to STRESS_OUT (diagnostics)
 *
 * Campaign:
 *   STRESS_ITER=600 STRESS_OUT=/tmp/consent-leak.json node --expose-gc \
 *     node_modules/jest/bin/jest.js --ci --runInBand \
 *     __tests__/stress/consentSettingsScreen.longRunLeak
 * Replay one seed 10×:
 *   STRESS_REPLAY=<seed> STRESS_ITER=10 node --expose-gc ... (same pattern)
 */

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
type MockAnyStore = {
  subscribe: (listener: (...args: unknown[]) => void) => () => void;
};
type MockCreateStore = (init: unknown) => MockAnyStore;
// Count live store subscriptions. zustand's react entry requires
// 'zustand/vanilla' by bare specifier, so wrapping createStore here covers
// every `create()` store in the app (consent, auth, api session, ...).
jest.mock('zustand/vanilla', () => {
  const actual =
    jest.requireActual<typeof import('zustand/vanilla')>('zustand/vanilla');
  const counters = { active: 0, total: 0 };
  const wrap = (api: MockAnyStore): MockAnyStore => {
    const subscribe = api.subscribe;
    api.subscribe = listener => {
      counters.active += 1;
      counters.total += 1;
      const unsubscribe = subscribe(listener);
      let done = false;
      return () => {
        if (!done) {
          done = true;
          counters.active -= 1;
        }
        unsubscribe();
      };
    };
    return api;
  };
  const createStore = (init?: unknown) => {
    if (init === undefined) return createStore;
    return wrap((actual.createStore as unknown as MockCreateStore)(init));
  };
  return { ...actual, createStore, __subscriptionCounters: counters };
});

import { ConsentSettingsScreen } from '../../src/screens/ConsentSettingsScreen';
import {
  useConsentStore,
  type ConsentAvailability,
} from '../../src/state/consentStore';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import type { RootStackParams } from '../../src/navigation/params';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ITERATIONS = Math.max(1, Number(process.env['STRESS_ITER'] ?? 100));
const MASTER_SEED = Number(process.env['STRESS_SEED'] ?? 20260904) >>> 0;
const CHECKPOINT_EVERY = Math.max(
  1,
  Number(process.env['STRESS_CHECKPOINT'] ?? 50),
);
const OUT_PATH = process.env['STRESS_OUT'];
const REPLAY_SEED = process.env['STRESS_REPLAY']
  ? Number(process.env['STRESS_REPLAY']) >>> 0
  : null;
const FORCED_MODE = process.env['STRESS_MODE'];
const HEAP_SNAPSHOT_AT = new Set(
  (process.env['STRESS_HEAPSNAP'] ?? '').split(',').filter(Boolean).map(Number),
);
/** Lens thresholds. */
const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
const WARMUP_CHECKPOINTS = 2;
const MIN_CHECKPOINTS_FOR_SLOPE = 5;
const MIN_ITERATIONS_FOR_DRIFT = 300;

const API_BASE = 'https://consent.stress.invalid/functions/v1/api';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const UNAVAILABLE_COPY = 'Consent settings are temporarily unavailable.';
const INVALID_COPY = 'The consent server returned an invalid response.';
const SIGNED_OUT_COPY =
  'Sign in to change this. Nothing is shared while signed out.';
const LOADING_COPY = 'Checking your current choice…';
const CONSENT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) + per-iteration seed derivation
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
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
  let h = (master ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function pickWeighted<T>(rng: () => number, table: Array<[T, number]>): T {
  const total = table.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [value, weight] of table) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return table[table.length - 1]![0];
}

// ---------------------------------------------------------------------------
// Scenario model
// ---------------------------------------------------------------------------

type Mode = 'push_pop' | 'remount';
type Auth = 'signed_out' | 'guest' | 'synced';
type UserId = 'A' | 'B';
/** Terminal server behaviour for one request. */
type Outcome =
  'ok_off' | 'ok_on' | 'ok' | 'network' | 'http_503' | 'http_401' | 'invalid';
/** Scripted response: settled immediately or held until resolved/aborted. */
type Scripted = { outcome: Outcome; pending: boolean };

type Action =
  | { kind: 'toggle'; server: Scripted }
  | { kind: 'double_tap'; server: Scripted }
  | { kind: 'retry'; server: Scripted }
  | { kind: 'connect' }
  | { kind: 'session_switch'; to: 'signed_out' | 'A' | 'B'; server: Scripted }
  | { kind: 'resolve_pending' }
  | { kind: 'timeout' }
  | { kind: 'idle'; ms: number }
  | { kind: 'back' };

interface Scenario {
  seed: number;
  mode: Mode;
  auth: Auth;
  status: Scripted;
  actions: Action[];
}

function scriptedStatus(rng: () => number, pendingWeight: number): Scripted {
  const pending = rng() < pendingWeight;
  const outcome = pickWeighted<Outcome>(rng, [
    ['ok_off', 34],
    ['ok_on', 26],
    ['network', 12],
    ['http_503', 10],
    ['http_401', 6],
    ['invalid', 12],
  ]);
  return { outcome, pending };
}

function scriptedMutation(rng: () => number): Scripted {
  const pending = rng() < 0.25;
  const outcome = pickWeighted<Outcome>(rng, [
    ['ok', 62],
    ['network', 12],
    ['http_503', 12],
    ['http_401', 6],
    ['invalid', 8],
  ]);
  return { outcome, pending };
}

function generateScenario(seed: number): Scenario {
  const rng = mulberry32(seed);
  const mode: Mode =
    FORCED_MODE === 'push_pop' || FORCED_MODE === 'remount'
      ? FORCED_MODE
      : rng() < 0.5
        ? 'push_pop'
        : 'remount';
  const auth = pickWeighted<Auth>(rng, [
    ['signed_out', 22],
    ['guest', 14],
    ['synced', 64],
  ]);
  const status = scriptedStatus(rng, 0.3);
  const count = pickWeighted(rng, [
    [0, 12],
    [1, 26],
    [2, 28],
    [3, 22],
    [4, 12],
  ]);
  const actions: Action[] = [];
  for (let i = 0; i < count; i += 1) {
    const kind = pickWeighted<Action['kind']>(rng, [
      ['toggle', 26],
      ['double_tap', 8],
      ['retry', 10],
      ['connect', 8],
      ['session_switch', 12],
      ['resolve_pending', 14],
      ['timeout', 5],
      ['idle', 9],
      ['back', 8],
    ]);
    switch (kind) {
      case 'toggle':
      case 'double_tap':
        actions.push({ kind, server: scriptedMutation(rng) });
        break;
      case 'retry':
        actions.push({ kind, server: scriptedStatus(rng, 0.3) });
        break;
      case 'session_switch':
        actions.push({
          kind,
          to: pickWeighted(rng, [
            ['signed_out', 4],
            ['A', 3],
            ['B', 5],
          ]),
          server: scriptedStatus(rng, 0.35),
        });
        break;
      case 'idle':
        actions.push({ kind, ms: Math.floor(rng() * 3000) });
        break;
      default:
        actions.push({ kind });
    }
    if (kind === 'back') break;
  }
  return { seed, mode, auth, status, actions };
}

// ---------------------------------------------------------------------------
// Oracle: an independent mirror of the consent contract
// ---------------------------------------------------------------------------

interface ExpectedState {
  availability: ConsentAvailability;
  active: boolean;
  busy: boolean;
  error: string | null;
}

type PendingRequest =
  | { kind: 'status'; user: UserId; outcome: Outcome }
  | { kind: 'mutation'; user: UserId; granted: boolean; outcome: Outcome };

class Oracle {
  state: ExpectedState = {
    availability: 'loading',
    active: false,
    busy: false,
    error: null,
  };
  currentUser: UserId | null = null;
  pending: PendingRequest[] = [];

  private errorFor(outcome: Outcome): string {
    return outcome === 'invalid' ? INVALID_COPY : UNAVAILABLE_COPY;
  }

  /** `hydrate()` — on mount and whenever the auth session changes. */
  hydrate(server: Scripted): 'fetch' | 'none' {
    if (!this.currentUser) {
      this.state = {
        availability: 'signed_out',
        active: false,
        busy: false,
        error: null,
      };
      return 'none';
    }
    this.state = { ...this.state, availability: 'loading', error: null };
    const request: PendingRequest = {
      kind: 'status',
      user: this.currentUser,
      outcome: server.outcome,
    };
    if (server.pending) {
      this.pending.push(request);
    } else {
      this.settle(request);
    }
    return 'fetch';
  }

  /** The user tapped the switch (only reachable when ready and not busy). */
  toggle(server: Scripted): void {
    const granted = !this.state.active;
    this.state = { ...this.state, busy: true, error: null };
    const request: PendingRequest = {
      kind: 'mutation',
      user: this.currentUser!,
      granted,
      outcome: server.outcome,
    };
    if (server.pending) {
      this.pending.push(request);
    } else {
      this.settle(request);
    }
  }

  settle(request: PendingRequest): void {
    const stale = request.user !== this.currentUser;
    if (stale) {
      this.state = this.currentUser
        ? { ...this.state, busy: false }
        : {
            availability: 'signed_out',
            active: false,
            busy: false,
            error: null,
          };
      return;
    }
    if (request.kind === 'status') {
      switch (request.outcome) {
        case 'ok_off':
        case 'ok':
          this.state = { ...this.state, availability: 'ready', active: false };
          break;
        case 'ok_on':
          this.state = { ...this.state, availability: 'ready', active: true };
          break;
        default:
          this.state = {
            ...this.state,
            availability: 'unavailable',
            active: false,
            error: this.errorFor(request.outcome),
          };
      }
      return;
    }
    switch (request.outcome) {
      case 'ok':
      case 'ok_off':
      case 'ok_on':
        this.state = {
          ...this.state,
          busy: false,
          availability: 'ready',
          active:
            request.outcome === 'ok'
              ? request.granted
              : request.outcome === 'ok_on',
        };
        break;
      default:
        this.state = {
          ...this.state,
          busy: false,
          error: this.errorFor(request.outcome),
        };
    }
  }

  /** All held requests settle in FIFO order. */
  settleAllPending(): void {
    for (const request of this.pending.splice(0)) this.settle(request);
  }

  /** The 15s request timeout aborts every held request → network failure. */
  abortAllPending(): void {
    for (const request of this.pending.splice(0)) {
      this.settle({ ...request, outcome: 'network' });
    }
  }
}

// ---------------------------------------------------------------------------
// Scripted fetch
// ---------------------------------------------------------------------------

interface Held {
  url: string;
  method: string;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  outcome: Outcome;
  settled: boolean;
}

const held: Held[] = [];
let fetchQueue: Scripted[] = [];
let fetchLog: Array<{ url: string; method: string; auth: string | undefined }> =
  [];
let unexpectedFetches: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function statusPayload(active: boolean) {
  return {
    subjectPseudonym: 'pseudo-stress',
    scopes: [
      {
        scope: 'model_training',
        active,
        consentVersion: active ? 'model-training-v1' : null,
        lastAction: active ? 'granted' : null,
        lastActionAt: active ? '2026-09-01T00:00:00.000Z' : null,
      },
    ],
  };
}

function settleHeld(request: Held, outcome: Outcome): void {
  if (request.settled) return;
  request.settled = true;
  const index = held.indexOf(request);
  if (index !== -1) held.splice(index, 1);
  switch (outcome) {
    case 'ok':
      request.resolve(
        jsonResponse(statusPayload(request.url.endsWith('/consent/grant'))),
      );
      break;
    case 'ok_off':
      request.resolve(jsonResponse(statusPayload(false)));
      break;
    case 'ok_on':
      request.resolve(jsonResponse(statusPayload(true)));
      break;
    case 'http_503':
      request.resolve(jsonResponse({ error: 'unavailable' }, 503));
      break;
    case 'http_401':
      request.resolve(jsonResponse({ error: 'unauthorized' }, 401));
      break;
    case 'invalid':
      request.resolve(jsonResponse({ scopes: [{ scope: 'model_training' }] }));
      break;
    case 'network':
      request.reject(new Error('network down'));
      break;
  }
}

function installFetch(): void {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const script = fetchQueue.shift();
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchLog.push({ url, method, auth: headers['Authorization'] });
    if (!script) {
      unexpectedFetches.push(`${method} ${url}`);
      return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
    }
    return new Promise<Response>((resolve, reject) => {
      const request: Held = {
        url,
        method,
        resolve,
        reject,
        outcome: script.outcome,
        settled: false,
      };
      held.push(request);
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        if (!request.settled) {
          request.settled = true;
          const index = held.indexOf(request);
          if (index !== -1) held.splice(index, 1);
          reject(error);
        }
      });
      if (!script.pending) settleHeld(request, script.outcome);
    });
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function syncedSession(user: UserId): AuthSession {
  const id = user === 'A' ? USER_A : USER_B;
  return {
    provider: 'google',
    subject: id,
    canonicalAppUserId: id,
    localOnly: false,
    displayName: user === 'A' ? 'Alex Chen' : 'Bea Ortiz',
    email: user === 'A' ? 'alex@example.com' : 'bea@example.com',
  };
}

const guestSession: AuthSession = {
  provider: 'guest',
  subject: 'local-only',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
};

function applySession(target: 'signed_out' | 'guest' | UserId): void {
  if (target === 'signed_out') {
    clearApiSession();
    useAuthStore.setState({ session: null });
    return;
  }
  if (target === 'guest') {
    clearApiSession();
    useAuthStore.setState({ session: guestSession });
    return;
  }
  const session = syncedSession(target);
  establishApiSession({
    apiBaseUrl: API_BASE,
    bearerToken: `bearer-${target}`,
    canonicalAppUserId: session.canonicalAppUserId!,
    provider: 'google',
  });
  useAuthStore.setState({ session });
}

function resetConsentStore(): void {
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
}

// ---------------------------------------------------------------------------
// Navigator under test (the real container + native stack)
// ---------------------------------------------------------------------------

const Stack = createNativeStackNavigator<RootStackParams>();
type NavRef = ReturnType<typeof createNavigationContainerRef<RootStackParams>>;

function SettingsStub() {
  return <Text>settings-stub</Text>;
}
/**
 * Null-unit control (STRESS_UNIT=control): the same container/stack with a
 * trivial screen in the ConsentSettings slot. Heap growth that shows up here
 * too belongs to the navigator/test-renderer environment, not the screen.
 */
function ControlScreen() {
  return <Text>control-screen</Text>;
}
const CONTROL_UNIT = process.env['STRESS_UNIT'] === 'control';
const UnitUnderTest = CONTROL_UNIT ? ControlScreen : ConsentSettingsScreen;
function ConnectAccountStub() {
  return <Text>connect-account-stub</Text>;
}

function Harness(props: { startOnConsent: boolean; navRef: NavRef }) {
  return (
    <SafeAreaProvider>
      <NavigationContainer
        ref={props.navRef}
        initialState={
          props.startOnConsent
            ? {
                routes: [{ name: 'Tabs' }, { name: 'ConsentSettings' }],
              }
            : undefined
        }
      >
        <Stack.Navigator initialRouteName="Tabs">
          <Stack.Screen name="Tabs" component={SettingsStub} />
          <Stack.Screen
            name="ConsentSettings"
            component={UnitUnderTest}
            options={{ title: 'Data & Consent' }}
          />
          <Stack.Screen name="ConnectAccount" component={ConnectAccountStub} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

type Instance = TestRenderer.ReactTestInstance;

function isPressable(node: Instance): boolean {
  if (typeof node.type === 'string') return false;
  const component = node.type as { displayName?: string; name?: string };
  return (component.displayName ?? component.name) === 'Pressable';
}

function routeNames(nav: NavRef): string[] {
  if (!nav.isReady()) return [];
  return (nav.getRootState()?.routes ?? []).map(route => route.name);
}

function screenInstances(renderer: TestRenderer.ReactTestRenderer): Instance[] {
  return renderer.root.findAllByType(UnitUnderTest);
}

function screenText(screen: Instance): string {
  return screen
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' | ');
}

function pressableByLabel(screen: Instance, label: string): Instance | null {
  const matches = screen.findAll(
    node =>
      isPressable(node) &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  return matches[0] ?? null;
}

function switchNode(screen: Instance): Instance {
  const matches = screen.findAll(
    node => isPressable(node) && node.props.accessibilityRole === 'switch',
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one switch, found ${matches.length}`);
  }
  return matches[0]!;
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

const subscriptionCounters = (
  require('zustand/vanilla') as {
    __subscriptionCounters: { active: number; total: number };
  }
).__subscriptionCounters;

let linkingListeners = 0;
let a11yListenerAdds = 0;
let a11yListenersActive = 0;
let consoleErrors: string[] = [];
let consoleWarns: string[] = [];

// Plain function replacements, NOT jest.spyOn: a jest mock records every
// call's arguments (`mock.calls`), and the listener callbacks passed here
// close over the navigation container — recording them would pin every
// unmounted container in memory and fake a heap leak.
type Restorer = () => void;
const restorers: Restorer[] = [];

function replaceMethod<T extends object, K extends keyof T>(
  target: T,
  key: K,
  replacement: T[K],
): void {
  const original = target[key];
  target[key] = replacement;
  restorers.push(() => {
    target[key] = original;
  });
}

function installListenerSpies(): void {
  replaceMethod(Linking, 'addEventListener', (() => {
    linkingListeners += 1;
    return {
      remove: () => {
        linkingListeners -= 1;
      },
    };
  }) as typeof Linking.addEventListener);
  replaceMethod(AccessibilityInfo, 'addEventListener', (() => {
    a11yListenerAdds += 1;
    a11yListenersActive += 1;
    return {
      remove: () => {
        a11yListenersActive -= 1;
      },
    };
  }) as typeof AccessibilityInfo.addEventListener);
  replaceMethod(console, 'error', (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  });
  replaceMethod(console, 'warn', (...args: unknown[]) => {
    consoleWarns.push(args.map(String).join(' '));
  });
}

function restoreListenerSpies(): void {
  for (const restore of restorers.splice(0).reverse()) restore();
}

/** Real monotonic clock for harness timings (independent of fake timers). */
function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * @react-native/jest-preset installs `performance.now = jest.fn(Date.now)`.
 * React's scheduler calls it ~1k times per mount and a jest.fn records every
 * call + result forever, which reads as an unbounded heap slope of the test
 * ENVIRONMENT (~180 KB/mount for an empty screen) and costs CPU. Swap in a
 * non-recording clock so the heap measurement is about the unit under test.
 */
function neutralizeRecordingClock(): void {
  const perf = globalThis.performance as unknown as {
    now: (() => number) & { _isMockFunction?: boolean };
  };
  if (perf.now._isMockFunction) {
    replaceMethod(perf, 'now', () => Date.now());
  }
}

function statusBarStackDepth(): number {
  return (StatusBar as unknown as { _propsStack: unknown[] })._propsStack
    .length;
}

function activeResources(): Record<string, number> {
  const info = (
    process as unknown as { getActiveResourcesInfo?: () => string[] }
  ).getActiveResourcesInfo;
  if (!info) return {};
  const counts: Record<string, number> = {};
  for (const name of info.call(process)) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

function forceGc(): boolean {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) return false;
  gc();
  gc();
  return true;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

interface Baseline {
  subscriptions: number;
  timers: number;
  linking: number;
  a11yActive: number;
  statusBarDepth: number;
}

interface IterationRecord {
  index: number;
  seed: number;
  mode: Mode;
  auth: Auth;
  status: string;
  actions: string[];
  applied: string[];
  outcome: 'HELD' | 'BROKEN';
  failures: string[];
  mountMs: number;
  totalMs: number;
  fetches: number;
  subscriptionsPeak: number;
}

interface Checkpoint {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  rss: number;
  gcForced: boolean;
  activeResources: Record<string, number>;
  fakeTimers: number;
  storeSubscriptions: number;
  linkingListeners: number;
  a11yListenerAdds: number;
  a11yListenersActive: number;
  statusBarDepth: number;
  heldFetches: number;
  mountMsMedianWindow: number;
}

const iterations: IterationRecord[] = [];
const checkpoints: Checkpoint[] = [];
const renderedTrees: Record<string, unknown> = {};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Least-squares slope of `ys` over `xs`. */
function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

// ---------------------------------------------------------------------------
// One iteration
// ---------------------------------------------------------------------------

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function advance(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

class IterationFailure extends Error {}

function expectState(
  screen: Instance | null,
  oracle: Oracle,
  where: string,
): void {
  if (CONTROL_UNIT) return;
  const store = useConsentStore.getState();
  const actual: ExpectedState = {
    availability: store.availability,
    active: store.modelTrainingActive,
    busy: store.busy,
    error: store.error,
  };
  const expected = oracle.state;
  if (
    actual.availability !== expected.availability ||
    actual.active !== expected.active ||
    actual.busy !== expected.busy ||
    actual.error !== expected.error
  ) {
    throw new IterationFailure(
      `${where}: store ${JSON.stringify(actual)} != oracle ${JSON.stringify(expected)}`,
    );
  }
  if (!screen) return;
  const text = screenText(screen);
  const sw = switchNode(screen);
  const shouldDisable = expected.busy || expected.availability !== 'ready';
  if (Boolean(sw.props.disabled) !== shouldDisable) {
    throw new IterationFailure(
      `${where}: switch disabled=${String(sw.props.disabled)} expected ${String(shouldDisable)}`,
    );
  }
  const checked = Boolean(sw.props.accessibilityState?.checked);
  if (checked !== expected.active) {
    throw new IterationFailure(
      `${where}: switch checked=${String(checked)} expected ${String(expected.active)}`,
    );
  }
  const has = (copy: string) => text.includes(copy);
  const signedOut = expected.availability === 'signed_out';
  const loading = expected.availability === 'loading';
  const unavailable = expected.availability === 'unavailable';
  const errorShown =
    expected.error !== null &&
    (unavailable || expected.availability === 'ready');
  const rules: Array<[boolean, string]> = [
    [signedOut, SIGNED_OUT_COPY],
    [signedOut, 'Connect account'],
    [loading, LOADING_COPY],
    [unavailable, 'Try again'],
    [unavailable && expected.error === null, UNAVAILABLE_COPY],
    [errorShown, expected.error ?? ''],
  ];
  for (const [visible, copy] of rules) {
    if (copy === '') continue;
    if (visible && !has(copy)) {
      throw new IterationFailure(
        `${where}: missing copy "${copy}" in [${text}]`,
      );
    }
  }
  const forbidden: Array<[boolean, string]> = [
    [!signedOut, SIGNED_OUT_COPY],
    [!signedOut, 'Connect account'],
    [!loading, LOADING_COPY],
    [!unavailable, 'Try again'],
    [!errorShown && !unavailable, UNAVAILABLE_COPY],
    [!errorShown, INVALID_COPY],
  ];
  for (const [hidden, copy] of forbidden) {
    if (hidden && has(copy)) {
      throw new IterationFailure(
        `${where}: unexpected copy "${copy}" in [${text}]`,
      );
    }
  }
  if (!has('Data & consent') || !has('Two separate choices.')) {
    throw new IterationFailure(`${where}: header/body copy missing`);
  }
}

interface MountedHarness {
  renderer: TestRenderer.ReactTestRenderer;
  nav: NavRef;
  ownsRenderer: boolean;
}

interface SharedContainer {
  renderer: TestRenderer.ReactTestRenderer | null;
  nav: NavRef;
}

async function runIteration(
  index: number,
  scenario: Scenario,
  shared: SharedContainer,
  baseline: Baseline,
): Promise<IterationRecord> {
  const started = nowMs();
  const record: IterationRecord = {
    index,
    seed: scenario.seed,
    mode: scenario.mode,
    auth: scenario.auth,
    status: `${scenario.status.outcome}${scenario.status.pending ? '+pending' : ''}`,
    actions: scenario.actions.map(a => JSON.stringify(a)),
    applied: [],
    outcome: 'HELD',
    failures: [],
    mountMs: 0,
    totalMs: 0,
    fetches: 0,
    subscriptionsPeak: 0,
  };
  const oracle = new Oracle();
  fetchQueue = [];
  fetchLog = [];
  unexpectedFetches = [];
  consoleErrors = [];
  consoleWarns = [];

  // Fresh, replayable starting state.
  act(() => {
    resetConsentStore();
    if (scenario.auth === 'synced') {
      applySession('A');
    } else {
      applySession(scenario.auth);
    }
  });
  oracle.currentUser = scenario.auth === 'synced' ? 'A' : null;
  if (oracle.currentUser) fetchQueue.push(scenario.status);
  oracle.hydrate(scenario.status);

  let mounted: MountedHarness;
  let popped = false;
  const mountStart = nowMs();
  if (scenario.mode === 'push_pop') {
    if (!shared.renderer) {
      await act(async () => {
        shared.renderer = TestRenderer.create(
          <Harness startOnConsent={false} navRef={shared.nav} />,
        );
      });
      await flush();
    }
    await act(async () => {
      shared.nav.navigate('ConsentSettings');
    });
    mounted = {
      renderer: shared.renderer!,
      nav: shared.nav,
      ownsRenderer: false,
    };
  } else {
    const nav = createNavigationContainerRef<RootStackParams>();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Harness startOnConsent navRef={nav} />);
    });
    mounted = { renderer, nav, ownsRenderer: true };
  }
  await flush();
  record.mountMs = nowMs() - mountStart;
  record.subscriptionsPeak = subscriptionCounters.active;

  const currentScreen = (): Instance | null => {
    const instances = screenInstances(mounted.renderer);
    if (instances.length > 1) {
      throw new IterationFailure(
        `${instances.length} ConsentSettingsScreen instances mounted`,
      );
    }
    return instances[0] ?? null;
  };

  try {
    const screen0 = currentScreen();
    if (!screen0) {
      throw new IterationFailure(
        `screen did not mount (routes: ${routeNames(mounted.nav).join(' > ')}, ready=${String(mounted.nav.isReady())})`,
      );
    }
    if (!renderedTrees[`${scenario.auth}:${record.status}`]) {
      renderedTrees[`${scenario.auth}:${record.status}`] = screen0
        .findAllByType(Text)
        .map(node => node.props.children)
        .flat()
        .filter((c): c is string => typeof c === 'string');
    }
    if (CONTROL_UNIT) {
      // Lifecycle only: the control screen has no store, copy or network.
      oracle.currentUser = null;
      fetchQueue = [];
      scenario.actions = [];
    }
    expectState(screen0, oracle, 'after mount');
    if (oracle.currentUser) {
      if (fetchLog.length !== 1 || fetchLog[0]!.method !== 'GET') {
        throw new IterationFailure(
          `expected one GET status on mount, saw ${JSON.stringify(fetchLog)}`,
        );
      }
      if (fetchLog[0]!.auth !== 'Bearer bearer-A') {
        throw new IterationFailure(`wrong bearer ${String(fetchLog[0]!.auth)}`);
      }
    } else if (fetchLog.length !== 0) {
      throw new IterationFailure(
        `signed-out mount performed network I/O: ${JSON.stringify(fetchLog)}`,
      );
    }

    for (const action of scenario.actions) {
      const screen = currentScreen();
      if (!screen)
        throw new IterationFailure(`screen gone before ${action.kind}`);
      const label = `after ${action.kind}`;
      switch (action.kind) {
        case 'toggle':
        case 'double_tap': {
          const sw = switchNode(screen);
          if (sw.props.disabled) {
            record.applied.push(`${action.kind}:noop(disabled)`);
            break;
          }
          const before = fetchLog.length;
          const granted = !oracle.state.active;
          fetchQueue.push(action.server);
          oracle.toggle(action.server);
          await act(async () => {
            sw.props.onPress();
            if (action.kind === 'double_tap') sw.props.onPress();
          });
          await flush();
          const posts = fetchLog.slice(before);
          if (posts.length !== 1 || posts[0]!.method !== 'POST') {
            throw new IterationFailure(
              `${label}: expected exactly one POST, saw ${JSON.stringify(posts)}`,
            );
          }
          const wantedPath = granted ? '/consent/grant' : '/consent/withdraw';
          if (!posts[0]!.url.endsWith(wantedPath)) {
            throw new IterationFailure(
              `${label}: wrong mutation path ${posts[0]!.url}`,
            );
          }
          record.applied.push(action.kind);
          expectState(currentScreen(), oracle, label);
          break;
        }
        case 'retry': {
          const button = pressableByLabel(screen, 'Try again');
          if (!button) {
            record.applied.push('retry:noop(not unavailable)');
            break;
          }
          fetchQueue.push(action.server);
          oracle.hydrate(action.server);
          await act(async () => {
            button.props.onPress();
          });
          await flush();
          record.applied.push('retry');
          expectState(currentScreen(), oracle, label);
          break;
        }
        case 'connect': {
          const button = pressableByLabel(screen, 'Connect account');
          if (!button) {
            record.applied.push('connect:noop(not signed out)');
            break;
          }
          await act(async () => {
            button.props.onPress();
          });
          await flush();
          const tree = mounted.renderer.root
            .findAllByType(Text)
            .map(node => node.props.children)
            .flat()
            .filter((c): c is string => typeof c === 'string');
          if (!tree.includes('connect-account-stub')) {
            throw new IterationFailure(`${label}: ConnectAccount not shown`);
          }
          if (screenInstances(mounted.renderer).length !== 1) {
            throw new IterationFailure(
              `${label}: consent screen left the stack`,
            );
          }
          await act(async () => {
            mounted.nav.goBack();
          });
          await flush();
          record.applied.push('connect');
          expectState(currentScreen(), oracle, `${label} (returned)`);
          break;
        }
        case 'session_switch': {
          const target = action.to;
          const nextUser: UserId | null =
            target === 'signed_out' ? null : target;
          if (nextUser === oracle.currentUser) {
            record.applied.push('session_switch:noop(same session)');
            break;
          }
          oracle.currentUser = nextUser;
          if (nextUser) fetchQueue.push(action.server);
          act(() => {
            applySession(target);
          });
          oracle.hydrate(action.server);
          await flush();
          record.applied.push(`session_switch:${target}`);
          expectState(currentScreen(), oracle, label);
          break;
        }
        case 'resolve_pending': {
          if (held.length === 0) {
            record.applied.push('resolve_pending:noop');
            break;
          }
          await act(async () => {
            for (const request of held.slice())
              settleHeld(request, request.outcome);
          });
          oracle.settleAllPending();
          await flush();
          record.applied.push('resolve_pending');
          expectState(currentScreen(), oracle, label);
          break;
        }
        case 'timeout': {
          if (held.length === 0) {
            record.applied.push('timeout:noop');
            break;
          }
          advance(CONSENT_TIMEOUT_MS + 1);
          oracle.abortAllPending();
          await flush();
          if (held.length !== 0) {
            throw new IterationFailure(
              `${label}: ${held.length} requests survived abort`,
            );
          }
          record.applied.push('timeout');
          expectState(currentScreen(), oracle, label);
          break;
        }
        case 'idle': {
          advance(action.ms);
          record.applied.push(`idle:${action.ms}`);
          expectState(currentScreen(), oracle, label);
          break;
        }
        case 'back': {
          const back = pressableByLabel(screen, 'Back');
          if (!back) throw new IterationFailure('no Back control');
          await act(async () => {
            back.props.onPress();
          });
          await flush();
          if (currentScreen() !== null) {
            throw new IterationFailure(
              `${label}: screen still mounted after Back`,
            );
          }
          popped = true;
          record.applied.push('back');
          break;
        }
      }
      if (popped) break;
    }

    // Leave the screen the way the app does.
    if (!popped) {
      if (mounted.ownsRenderer) {
        await act(async () => {
          mounted.renderer.unmount();
        });
      } else {
        await act(async () => {
          mounted.nav.dispatch(StackActions.popToTop());
        });
        await flush();
        if (currentScreen() !== null) {
          throw new IterationFailure(
            'screen still mounted after leaving to Tabs',
          );
        }
      }
    } else if (mounted.ownsRenderer) {
      await act(async () => {
        mounted.renderer.unmount();
      });
    }

    // Requests still in flight land AFTER the screen is gone.
    if (held.length > 0) {
      await act(async () => {
        for (const request of held.slice())
          settleHeld(request, request.outcome);
      });
      oracle.settleAllPending();
      await flush();
    }
    expectState(null, oracle, 'after unmount + late responses');

    // Give every animation / deferred callback a chance to finish, then the
    // process must be back at baseline.
    advance(30_000);
    await flush();

    if (unexpectedFetches.length) {
      throw new IterationFailure(
        `unexpected fetches: ${unexpectedFetches.join(', ')}`,
      );
    }
    if (held.length !== 0) {
      throw new IterationFailure(`${held.length} fetches still held`);
    }
    if (subscriptionCounters.active !== baseline.subscriptions) {
      throw new IterationFailure(
        `store subscriptions ${subscriptionCounters.active} != baseline ${baseline.subscriptions}`,
      );
    }
    if (jest.getTimerCount() !== baseline.timers) {
      throw new IterationFailure(
        `fake timers ${jest.getTimerCount()} != baseline ${baseline.timers}`,
      );
    }
    // The push_pop container stays mounted for the whole campaign, so its
    // listener is the floor for every mode.
    if (linkingListeners !== linkingListenersWhileShared) {
      throw new IterationFailure(
        `Linking listeners ${linkingListeners} != ${linkingListenersWhileShared}`,
      );
    }
    if (a11yListenerAdds > 1) {
      throw new IterationFailure(
        `AccessibilityInfo listeners added ${a11yListenerAdds} times (singleton expected)`,
      );
    }
    if (statusBarStackDepth() !== baseline.statusBarDepth) {
      throw new IterationFailure(
        `StatusBar stack depth ${statusBarStackDepth()} != baseline ${baseline.statusBarDepth}`,
      );
    }
    if (consoleErrors.length) {
      throw new IterationFailure(
        `console.error: ${consoleErrors.join(' || ')}`,
      );
    }
    if (consoleWarns.length) {
      throw new IterationFailure(`console.warn: ${consoleWarns.join(' || ')}`);
    }
  } catch (error) {
    record.outcome = 'BROKEN';
    record.failures.push(
      error instanceof Error ? error.message : String(error),
    );
    // Best-effort teardown so later iterations start clean.
    try {
      if (mounted.ownsRenderer) {
        if (mounted.renderer.toJSON() !== null) {
          await act(async () => {
            mounted.renderer.unmount();
          });
        }
      } else if (mounted.nav.isReady()) {
        await act(async () => {
          mounted.nav.dispatch(StackActions.popToTop());
        });
      }
      for (const request of held.slice()) settleHeld(request, request.outcome);
      await flush();
      advance(30_000);
    } catch (teardownError) {
      record.failures.push(
        `teardown: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`,
      );
    }
  }
  record.fetches = fetchLog.length;
  record.totalMs = nowMs() - started;
  return record;
}

/** Linking listeners held by the long-lived push_pop container. */
let linkingListenersWhileShared = 0;

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

function takeCheckpoint(iteration: number, window: number[]): Checkpoint {
  // The RN jest preset's mocks (View.prototype.measure/setNativeProps, ...)
  // are shared jest.fn()s that record `this` for every call, pinning every
  // host View — and through it every unmounted tree — in `mock.contexts`.
  // Drop the recorded mock state (implementations stay) so the heap
  // figure below measures the unit, not Jest's call log.
  jest.clearAllMocks();
  const gcForced = forceGc();
  const mem = process.memoryUsage();
  const checkpoint: Checkpoint = {
    iteration,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    rss: mem.rss,
    gcForced,
    activeResources: activeResources(),
    fakeTimers: jest.getTimerCount(),
    storeSubscriptions: subscriptionCounters.active,
    linkingListeners,
    a11yListenerAdds,
    a11yListenersActive,
    statusBarDepth: statusBarStackDepth(),
    heldFetches: held.length,
    mountMsMedianWindow: median(window),
  };
  checkpoints.push(checkpoint);
  if (HEAP_SNAPSHOT_AT.has(iteration) && OUT_PATH) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    v8.writeHeapSnapshot(
      `${OUT_PATH.replace(/\.json$/, '')}.iter${iteration}.heapsnapshot`,
    );
  }
  return checkpoint;
}

function analyse() {
  const fit = checkpoints.slice(WARMUP_CHECKPOINTS);
  const xs = fit.map(c => c.iteration / 100);
  const ys = fit.map(c => c.heapUsed);
  const heapSlopePer100 = slope(xs, ys);
  const heapBase = fit[0]?.heapUsed ?? 0;
  const heapSlopePctPer100 = heapBase ? (heapSlopePer100 / heapBase) * 100 : 0;
  let monotone = fit.length >= 2;
  for (let i = 1; i < fit.length; i += 1) {
    if (fit[i]!.heapUsed <= fit[i - 1]!.heapUsed) monotone = false;
  }
  const heapGrowthPct = heapBase
    ? ((fit[fit.length - 1]!.heapUsed - heapBase) / heapBase) * 100
    : 0;
  const held_ = iterations.filter(r => r.outcome === 'HELD');
  const windowSize = Math.max(10, Math.floor(held_.length / 5));
  const firstWindow = held_.slice(0, windowSize).map(r => r.mountMs);
  const lastWindow = held_.slice(-windowSize).map(r => r.mountMs);
  const mountFirstMedian = median(firstWindow);
  const mountLastMedian = median(lastWindow);
  const mountSlopePerIter = slope(
    held_.map(r => r.index),
    held_.map(r => r.mountMs),
  );
  return {
    checkpointsUsedForSlope: fit.length,
    heapBase,
    heapSlopeBytesPer100: heapSlopePer100,
    heapSlopePctPer100,
    heapMonotone: monotone,
    heapGrowthPctOverFit: heapGrowthPct,
    mountMsFirstWindowMedian: mountFirstMedian,
    mountMsLastWindowMedian: mountLastMedian,
    mountMsSlopePerIteration: mountSlopePerIter,
    windowSize,
  };
}

describe('ConsentSettingsScreen — long-run leak campaign', () => {
  beforeAll(() => {
    neutralizeRecordingClock();
    jest.useFakeTimers({
      doNotFake: [
        'performance',
        'hrtime',
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
      ],
    });
    installFetch();
    installListenerSpies();
  });

  afterAll(() => {
    restoreListenerSpies();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it(
    `mounts/unmounts the screen ${ITERATIONS}× (seed ${MASTER_SEED}) with heap, handles, timers, listeners and render time back at baseline`,
    async () => {
      const shared: SharedContainer = {
        renderer: null,
        nav: createNavigationContainerRef<RootStackParams>(),
      };
      act(() => {
        resetConsentStore();
        applySession('signed_out');
      });
      const baseline: Baseline = {
        subscriptions: subscriptionCounters.active,
        timers: jest.getTimerCount(),
        linking: linkingListeners,
        a11yActive: a11yListenersActive,
        statusBarDepth: statusBarStackDepth(),
      };
      // The push_pop container lives for the whole campaign; its own listeners
      // and timers are part of the baseline for that mode.
      await act(async () => {
        shared.renderer = TestRenderer.create(
          <Harness startOnConsent={false} navRef={shared.nav} />,
        );
      });
      await flush();
      advance(30_000);
      linkingListenersWhileShared = linkingListeners;
      const sharedTimers = jest.getTimerCount();
      const sharedSubscriptions = subscriptionCounters.active;
      baseline.timers = sharedTimers;
      baseline.subscriptions = sharedSubscriptions;

      takeCheckpoint(0, []);
      let window: number[] = [];
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = REPLAY_SEED ?? iterationSeed(MASTER_SEED, i);
        const scenario = generateScenario(seed);
        const record = await runIteration(i, scenario, shared, baseline);
        iterations.push(record);
        window.push(record.mountMs);
        if ((i + 1) % CHECKPOINT_EVERY === 0 || i + 1 === ITERATIONS) {
          takeCheckpoint(i + 1, window);
          window = [];
        }
      }

      await act(async () => {
        shared.renderer?.unmount();
      });
      advance(30_000);
      const finalState = {
        storeSubscriptions: subscriptionCounters.active,
        fakeTimers: jest.getTimerCount(),
        linkingListeners,
        a11yListenerAdds,
        a11yListenersActive,
        statusBarDepth: statusBarStackDepth(),
        activeResources: activeResources(),
      };

      const analysis = analyse();
      const broken = iterations.filter(r => r.outcome === 'BROKEN');
      const report = {
        harness: 'consentSettingsScreen.longRunLeak',
        masterSeed: MASTER_SEED,
        replaySeed: REPLAY_SEED,
        iterationsRequested: ITERATIONS,
        iterationsExecuted: iterations.length,
        checkpointEvery: CHECKPOINT_EVERY,
        gcExposed: typeof (globalThis as { gc?: unknown }).gc === 'function',
        node: process.version,
        baseline: {
          ...baseline,
          sharedContainerLinkingListeners: linkingListenersWhileShared,
        },
        finalState,
        thresholds: {
          heapSlopeLimitPctPer100: HEAP_SLOPE_LIMIT_PCT_PER_100,
          warmupCheckpoints: WARMUP_CHECKPOINTS,
        },
        analysis,
        broken: broken.map(r => ({
          seed: r.seed,
          index: r.index,
          failures: r.failures,
        })),
        checkpoints,
        iterations,
        renderedTrees,
      };
      if (OUT_PATH) {
        fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
        fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
      }

      // Every iteration must be HELD (its own message lists the failing seeds).
      expect(
        broken.map(
          r => `seed ${r.seed} (#${r.index}): ${r.failures.join('; ')}`,
        ),
      ).toEqual([]);
      expect(iterations).toHaveLength(ITERATIONS);

      // Process-wide resources back at baseline once everything is gone.
      expect(finalState.storeSubscriptions).toBe(0);
      expect(finalState.fakeTimers).toBe(0);
      expect(finalState.linkingListeners).toBe(0);
      expect(finalState.statusBarDepth).toBe(0);
      expect(finalState.a11yListenerAdds).toBeLessThanOrEqual(1);

      // Heap slope (only meaningful with enough post-warmup checkpoints).
      if (analysis.checkpointsUsedForSlope >= MIN_CHECKPOINTS_FOR_SLOPE) {
        expect(report.gcExposed).toBe(true);
        expect(analysis.heapSlopePctPer100).toBeLessThanOrEqual(
          HEAP_SLOPE_LIMIT_PCT_PER_100,
        );
      }
      // Render-time drift: the last window may not be more than 2× (and
      // 10ms) slower than the first.
      if (iterations.length >= MIN_ITERATIONS_FOR_DRIFT) {
        expect(analysis.mountMsLastWindowMedian).toBeLessThanOrEqual(
          Math.max(
            analysis.mountMsFirstWindowMedian * 2,
            analysis.mountMsFirstWindowMedian + 10,
          ),
        );
      }
    },
    // 600 iterations of a full navigator mount take a few minutes on CI.
    Math.max(60_000, ITERATIONS * 2_000),
  );
});
