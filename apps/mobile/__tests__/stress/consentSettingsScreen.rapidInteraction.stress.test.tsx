/**
 * STRESS SUITE — ConsentSettingsScreen, lens `rapid-interaction`.
 *
 * The REAL screen is mounted inside the REAL `NavigationContainer` + native
 * stack (`@react-navigation/native-stack`), with the REAL consent, auth and
 * API-session stores. Only native modules (safe-area context via the
 * library's own jest mock, the SQLite handle) and `globalThis.fetch` are
 * replaced. Presses travel through RN's Pressability responder handlers on
 * the rendered host views (grant → release), so `disabled` gating, the
 * store's `busy` guard and React Navigation's routing all run for real.
 *
 * A seeded generator scripts interaction bursts — double / triple taps
 * (sequential and same-tick), simultaneous controls, back / navigation spam
 * while a request is in flight, sign-out / account-switch mid-request,
 * request timeouts, out-of-order responses — and after every step asserts:
 *   - one POST per accepted toggle intent, one GET per hydrate intent, each
 *     with the right verb, path, body and bearer;
 *   - no orphan loading / busy state (loading ⇒ a GET is in flight, busy ⇒ a
 *     POST is in flight; nothing pending once every response landed);
 *   - the rendered controls mirror the store (disabled/checked/copy), never
 *     duplicated, and the navigation stack never holds a duplicate route;
 *   - no console.error / console.warn (act() warnings included), no
 *     unhandled promise rejections, no unhandled navigation actions from a
 *     realistic (sequential) press;
 *   - after settling, the switch shows the server's ledger truth.
 *
 * Replay: `STRESS_SEED=<n> npx jest --ci __tests__/stress/consentSettingsScreen.rapidInteraction`
 * Campaign: `STRESS_ITER=400 STRESS_OUT=/tmp/consent-stress.json npx jest --ci __tests__/stress/consentSettingsScreen.rapidInteraction`
 * Default is a small, fast sample (STRESS_ITER=24) so the suite lives in CI.
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

// The library's own jest mock keeps the real contexts React Navigation's
// SafeAreaProviderCompat reads; SafeAreaView becomes a plain View.
jest.mock('react-native-safe-area-context', () => {
  const mock = jest.requireActual<{ default: Record<string, unknown> }>(
    'react-native-safe-area-context/jest/mock',
  ).default;
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { ...mock, SafeAreaView: View };
});

import {
  NavigationContainer,
  createNavigationContainerRef,
  type NavigationState,
  type PartialState,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ConsentSettingsScreen } from '../../src/screens/ConsentSettingsScreen';
import type { RootStackParams } from '../../src/navigation/params';
import { useConsentStore } from '../../src/state/consentStore';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import { CONSENT_REQUEST_TIMEOUT_MS } from '../../src/account/consentApi';

// ---------------------------------------------------------------------------
// Campaign knobs
// ---------------------------------------------------------------------------

const ITER = Number(process.env.STRESS_ITER ?? 24);
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? 1000);
const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const OUT = process.env.STRESS_OUT;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — every iteration is a pure function of its seed.
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

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ---------------------------------------------------------------------------
// Accounts + server model. The ledger truth lives per account and a response
// is computed when it is RESOLVED (server order), not when it was issued.
// ---------------------------------------------------------------------------

const API_BASE = 'https://api.example.test';

function account(id: string, name: string) {
  const api: ApiSession = {
    apiBaseUrl: API_BASE,
    bearerToken: `bearer-${id}`,
    canonicalAppUserId: id,
    provider: 'google',
  };
  const auth: AuthSession = {
    provider: 'google',
    subject: id,
    canonicalAppUserId: id,
    localOnly: false,
    displayName: name,
    email: `${name.toLowerCase()}@example.com`,
  };
  return { api, auth };
}

const ACCOUNT_A = account('11111111-1111-4111-8111-111111111111', 'Alex');
const ACCOUNT_B = account('22222222-2222-4222-8222-222222222222', 'Bea');
const BEARER_TO_ACCOUNT = new Map<string, string>([
  [ACCOUNT_A.api.bearerToken, ACCOUNT_A.api.canonicalAppUserId],
  [ACCOUNT_B.api.bearerToken, ACCOUNT_B.api.canonicalAppUserId],
]);

type Outcome = 'ok' | 'http500' | 'http409' | 'invalidBody' | 'network';
const OUTCOMES: readonly Outcome[] = [
  'ok',
  'ok',
  'ok',
  'ok',
  'http500',
  'http409',
  'invalidBody',
  'network',
];

interface Request {
  id: number;
  method: string;
  path: string;
  account: string | null;
  body: unknown;
  settled: boolean;
  aborted: boolean;
  outcome: Outcome | 'timeout' | null;
  resolve: (response: Response) => void;
  reject: (reason: unknown) => void;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

class Server {
  readonly requests: Request[] = [];
  readonly truth = new Map<string, boolean>();
  readonly lastActionAt = new Map<string, string | null>();

  install(): () => void {
    const previous = globalThis.fetch;
    globalThis.fetch = ((input: string, init?: RequestInit) =>
      this.accept(input, init)) as typeof fetch;
    return () => {
      globalThis.fetch = previous;
    };
  }

  pending(): Request[] {
    return this.requests.filter(r => !r.settled);
  }

  private accept(url: string, init?: RequestInit): Promise<Response> {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = (headers.Authorization ?? '').replace(/^Bearer /, '');
    const request: Request = {
      id: this.requests.length,
      method: init?.method ?? 'GET',
      path: url.startsWith(API_BASE) ? url.slice(API_BASE.length) : url,
      account: BEARER_TO_ACCOUNT.get(bearer) ?? null,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      settled: false,
      aborted: false,
      outcome: null,
      resolve: () => undefined,
      reject: () => undefined,
    };
    const promise = new Promise<Response>((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
    });
    init?.signal?.addEventListener('abort', () => {
      if (request.settled) return;
      request.settled = true;
      request.aborted = true;
      request.outcome = 'timeout';
      request.reject(
        Object.assign(new Error('Aborted'), { name: 'AbortError' }),
      );
    });
    this.requests.push(request);
    return promise;
  }

  private status(accountId: string) {
    const active = this.truth.get(accountId) ?? false;
    return {
      subjectPseudonym: `pseudo-${accountId.slice(0, 8)}`,
      scopes: [
        {
          scope: 'model_training',
          active,
          consentVersion: active ? 'model-training-v1' : null,
          lastAction: active
            ? 'granted'
            : this.lastActionAt.get(accountId)
              ? 'withdrawn'
              : null,
          lastActionAt: this.lastActionAt.get(accountId) ?? null,
        },
      ],
    };
  }

  /** Settles a request now. `ok` applies the mutation to the ledger first. */
  settle(request: Request, outcome: Outcome): void {
    if (request.settled) return;
    request.settled = true;
    request.outcome = outcome;
    const accountId = request.account;
    switch (outcome) {
      case 'ok': {
        if (accountId === null) {
          request.resolve(jsonResponse({ error: 'unauthorized' }, 401));
          return;
        }
        if (request.path === '/v1/me/consent/grant') {
          this.truth.set(accountId, true);
          this.lastActionAt.set(accountId, '2026-09-04T00:00:00.000Z');
        } else if (request.path === '/v1/me/consent/withdraw') {
          this.truth.set(accountId, false);
          this.lastActionAt.set(accountId, '2026-09-04T00:00:01.000Z');
        }
        request.resolve(jsonResponse(this.status(accountId)));
        return;
      }
      case 'http500':
        request.resolve(jsonResponse({ error: 'boom' }, 500));
        return;
      case 'http409':
        request.resolve(jsonResponse({ error: 'conflict' }, 409));
        return;
      case 'invalidBody':
        request.resolve(jsonResponse({ scopes: 'nope' }));
        return;
      case 'network':
        request.reject(new TypeError('Network request failed'));
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Real navigator around the real screen
// ---------------------------------------------------------------------------

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function TabsStub() {
  return <Text>Home</Text>;
}
function ConnectAccountStub() {
  return <Text>Connect account screen</Text>;
}

const INITIAL_STATE: PartialState<NavigationState<RootStackParams>> = {
  routes: [{ name: 'Tabs' }, { name: 'ConsentSettings' }],
};

function Harness(props: { onUnhandledAction: (type: string) => void }) {
  return (
    <NavigationContainer
      ref={navigationRef}
      initialState={INITIAL_STATE}
      onUnhandledAction={action => props.onUnhandledAction(action.type)}
    >
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Tabs" component={TabsStub} />
        <Stack.Screen
          name="ConsentSettings"
          component={ConsentSettingsScreen}
        />
        <Stack.Screen name="ConnectAccount" component={ConnectAccountStub} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

function routeNames(): string[] {
  if (!navigationRef.isReady()) return [];
  const state = navigationRef.getRootState();
  return state ? state.routes.map(r => r.name) : [];
}

// ---------------------------------------------------------------------------
// Rendered-tree probes
// ---------------------------------------------------------------------------

const LABEL = {
  back: 'Back',
  toggle: 'Use my feedback to improve scoring',
  connect: 'Connect account',
  retry: 'Try again',
} as const;
type Control = keyof typeof LABEL;

function isHostPressable(node: ReactTestInstance): boolean {
  return (
    String(node.type) === 'View' &&
    typeof node.props.onStartShouldSetResponder === 'function' &&
    typeof node.props.accessibilityLabel === 'string'
  );
}

function hosts(renderer: TestRenderer.ReactTestRenderer, control: Control) {
  return renderer.root.findAll(
    n => isHostPressable(n) && n.props.accessibilityLabel === LABEL[control],
  );
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(n => n.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' | ');
}

let touchSeq = 1;
function pressEvent(target: ReactTestInstance) {
  const touch = {
    identifier: touchSeq++,
    pageX: 40,
    pageY: 40,
    locationX: 8,
    locationY: 8,
    timestamp: Date.now(),
    target: 1,
    force: 0,
  };
  // Pressability measures the responder's host view on grant; the test
  // renderer has no layout, so the hit rect stays unknown (as on first paint).
  const hostHandle = { measure: () => undefined, node: target };
  return {
    nativeEvent: { ...touch, touches: [touch], changedTouches: [touch] },
    currentTarget: hostHandle,
    target: hostHandle,
    timeStamp: touch.timestamp,
    persist: () => undefined,
    stopPropagation: () => undefined,
    preventDefault: () => undefined,
  };
}

/**
 * A finger tap through Pressability: responder negotiation, grant, release.
 * Returns whether the press was accepted by the responder system (a
 * `disabled` Pressable refuses to become responder, like on device).
 */
function tap(host: ReactTestInstance): boolean {
  if (host.props.onStartShouldSetResponder() !== true) return false;
  const event = pressEvent(host);
  host.props.onResponderGrant(event);
  host.props.onResponderRelease(event);
  return true;
}

// ---------------------------------------------------------------------------
// Script model
// ---------------------------------------------------------------------------

type Step =
  | {
      kind: 'press';
      control: Control;
      times: number;
      mode: 'sequential' | 'sameTick';
    }
  | { kind: 'simultaneous'; controls: Control[] }
  | { kind: 'resolve'; which: 'oldest' | 'newest' | 'random'; outcome: Outcome }
  | { kind: 'tick'; ms: number }
  | { kind: 'navigateToConsent' }
  | { kind: 'signOut' }
  | { kind: 'switchAccount' }
  | { kind: 'signIn' };

interface Start {
  session: 'A' | 'B' | 'none';
  truthA: boolean;
  truthB: boolean;
  /** Land the first status response before the burst starts (screen ready). */
  preHydrated: boolean;
}

function generate(rng: Rng): { start: Start; steps: Step[] } {
  const start: Start = {
    session: rng.pick(['A', 'A', 'A', 'B', 'none'] as const),
    truthA: rng.chance(0.5),
    truthB: rng.chance(0.5),
    preHydrated: rng.chance(0.6),
  };
  const length = 4 + rng.int(9);
  const steps: Step[] = [];
  for (let i = 0; i < length; i++) {
    const roll = rng.int(100);
    if (roll < 38) {
      steps.push({
        kind: 'press',
        control: rng.pick([
          'toggle',
          'toggle',
          'toggle',
          'toggle',
          'back',
          'connect',
          'retry',
        ] as const),
        times: rng.pick([1, 2, 2, 3, 5] as const),
        mode: rng.chance(0.7) ? 'sequential' : 'sameTick',
      });
    } else if (roll < 44) {
      const pool: Control[] = ['toggle', 'back', 'connect', 'retry'];
      const n = 2 + rng.int(2);
      const controls: Control[] = [];
      for (let k = 0; k < n; k++) controls.push(rng.pick(pool));
      steps.push({ kind: 'simultaneous', controls });
    } else if (roll < 72) {
      steps.push({
        kind: 'resolve',
        which: rng.pick(['oldest', 'oldest', 'newest', 'random'] as const),
        outcome: rng.pick(OUTCOMES),
      });
    } else if (roll < 82) {
      steps.push({
        kind: 'tick',
        ms: rng.pick([
          0,
          16,
          50,
          120,
          400,
          1000,
          CONSENT_REQUEST_TIMEOUT_MS + 1,
        ] as const),
      });
    } else if (roll < 90) {
      steps.push({ kind: 'navigateToConsent' });
    } else if (roll < 94) {
      steps.push({ kind: 'signOut' });
    } else if (roll < 97) {
      steps.push({ kind: 'switchAccount' });
    } else {
      steps.push({ kind: 'signIn' });
    }
  }
  return { start, steps };
}

// ---------------------------------------------------------------------------
// Signal capture
// ---------------------------------------------------------------------------

const consoleErrors: string[] = [];
const consoleWarns: string[] = [];
const unhandledRejections: string[] = [];
let unhandledNav: string[] = [];

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
const onUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(describeError(reason));
};

// ---------------------------------------------------------------------------
// Iteration runner
// ---------------------------------------------------------------------------

interface Row {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  steps: number;
  presses: number;
  acceptedPresses: number;
  postsExpected: number;
  postsActual: number;
  getsExpected: number;
  getsActual: number;
  navChanges: number;
  unmodeledNavPresses: number;
  unhandledNavSequential: number;
  unhandledNavSameTick: number;
  dupGetSameTick: number;
  staleLoadingWhileUnmounted: boolean;
  consoleErrors: number;
  consoleWarns: number;
  unhandledRejections: number;
  timeouts: number;
  script: string;
  failures: string[];
}

const rows: Row[] = [];

function summarizeStep(step: Step): string {
  switch (step.kind) {
    case 'press':
      return `${step.control}x${step.times}${step.mode === 'sameTick' ? '!' : ''}`;
    case 'simultaneous':
      return `[${step.controls.join('+')}]`;
    case 'resolve':
      return `res(${step.which},${step.outcome})`;
    case 'tick':
      return `t+${step.ms}`;
    default:
      return step.kind;
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function resetStores(): void {
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
  clearApiSession();
  useAuthStore.setState({ session: null });
}

function applySession(which: 'A' | 'B' | 'none'): void {
  if (which === 'none') {
    clearApiSession();
    useAuthStore.setState({ session: null });
    return;
  }
  const acct = which === 'A' ? ACCOUNT_A : ACCOUNT_B;
  establishApiSession(acct.api);
  useAuthStore.setState({ session: acct.auth });
}

async function runIteration(seed: number): Promise<Row> {
  const rng = new Rng(seed);
  const { start, steps } = generate(rng);
  const failures: string[] = [];
  const fail = (message: string) => {
    if (failures.length < 12) failures.push(message);
  };

  consoleErrors.length = 0;
  consoleWarns.length = 0;
  unhandledRejections.length = 0;
  unhandledNav = [];

  const server = new Server();
  server.truth.set(ACCOUNT_A.api.canonicalAppUserId, start.truthA);
  server.truth.set(ACCOUNT_B.api.canonicalAppUserId, start.truthB);
  const uninstall = server.install();

  resetStores();
  applySession(start.session);

  // Model of expectations, updated as the script runs.
  let expectedRoutes = ['Tabs', 'ConsentSettings'];
  let postsExpected = 0;
  let getsExpected = 0;
  let presses = 0;
  let acceptedPresses = 0;
  let navChanges = 0;
  let unhandledNavSequential = 0;
  let unhandledNavSameTick = 0;
  let dupGetSameTick = 0;
  let unmodeledNavPresses = 0;
  let navPressesThisStep = 0;
  let navUnmodeledThisStep = false;
  let sameTickMode = false;
  const postIntents: Array<{ grant: boolean; account: string }> = [];

  const mountedConsent = () => expectedRoutes.includes('ConsentSettings');
  const focusedConsent = () =>
    expectedRoutes[expectedRoutes.length - 1] === 'ConsentSettings';
  const hydrateIntent = () => {
    if (getApiSession()) getsExpected += 1;
  };

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Harness
        onUnhandledAction={type => {
          unhandledNav.push(type);
          if (sameTickMode) unhandledNavSameTick += 1;
          else unhandledNavSequential += 1;
        }}
      />,
    );
  });
  const unsubscribe = navigationRef.addListener('state', () => {
    navChanges += 1;
  });
  hydrateIntent(); // initial mount of the screen
  await flush();
  if (start.preHydrated && server.pending().length === 1) {
    await act(async () => {
      server.settle(server.pending()[0] as Request, 'ok');
    });
    await flush();
  }

  const checkInvariants = (where: string) => {
    const state = useConsentStore.getState();
    const routes = routeNames();
    if (new Set(routes).size !== routes.length) {
      fail(`${where}: duplicate route in stack ${routes.join('>')}`);
    }
    if (navUnmodeledThisStep) {
      // A press on a screen that is not focused (behind a push, or the 2nd+
      // press of a same-tick burst) follows React Navigation's own routing;
      // we bound its effect and re-sync the model instead of predicting it.
      if (
        Math.abs(routes.length - expectedRoutes.length) > navPressesThisStep
      ) {
        fail(
          `${where}: ${navPressesThisStep} nav press(es) moved the stack ${expectedRoutes.join('>')} → ${routes.join('>')}`,
        );
      }
      expectedRoutes = routes;
    } else if (routes.join('>') !== expectedRoutes.join('>')) {
      fail(
        `${where}: stack ${routes.join('>')} ≠ model ${expectedRoutes.join('>')}`,
      );
    }
    navUnmodeledThisStep = false;
    navPressesThisStep = 0;
    const pending = server.pending();
    const pendingGet = pending.filter(r => r.method === 'GET');
    const pendingPost = pending.filter(r => r.method === 'POST');
    if (state.busy && pendingPost.length === 0) {
      fail(`${where}: orphan busy (busy=true, no POST in flight)`);
    }
    if (!routes.includes('ConsentSettings')) return;
    if (state.availability === 'loading' && pendingGet.length === 0) {
      fail(`${where}: orphan loading (availability=loading, no GET in flight)`);
    }
    const backs = hosts(renderer, 'back');
    const toggles = hosts(renderer, 'toggle');
    const connects = hosts(renderer, 'connect');
    const retries = hosts(renderer, 'retry');
    if (backs.length !== 1) fail(`${where}: ${backs.length} Back controls`);
    if (toggles.length !== 1) fail(`${where}: ${toggles.length} toggles`);
    const toggle = toggles[0];
    if (toggle) {
      const a11y = toggle.props.accessibilityState ?? {};
      const shouldDisable = state.busy || state.availability !== 'ready';
      if (a11y.disabled !== shouldDisable) {
        fail(
          `${where}: toggle disabled=${String(a11y.disabled)} but store says ${String(shouldDisable)}`,
        );
      }
      if (a11y.checked !== state.modelTrainingActive) {
        fail(
          `${where}: toggle checked=${String(a11y.checked)} ≠ store ${String(state.modelTrainingActive)}`,
        );
      }
    }
    const text = allText(renderer);
    const loadingShown = text.includes('Checking your current choice…');
    if (loadingShown !== (state.availability === 'loading')) {
      fail(
        `${where}: loading copy shown=${String(loadingShown)} vs availability=${state.availability}`,
      );
    }
    if (connects.length !== (state.availability === 'signed_out' ? 1 : 0)) {
      fail(
        `${where}: ${connects.length} Connect-account buttons in ${state.availability}`,
      );
    }
    if (retries.length !== (state.availability === 'unavailable' ? 1 : 0)) {
      fail(
        `${where}: ${retries.length} Try-again buttons in ${state.availability}`,
      );
    }
    if (state.error && !text.includes(state.error)) {
      fail(`${where}: store error not rendered: ${state.error}`);
    }
  };

  const pressOnce = (control: Control, where: string) => {
    const host = hosts(renderer, control)[0];
    presses += 1;
    if (!host) return; // control not on screen: a tap lands on nothing
    const state = useConsentStore.getState();
    const session = getApiSession();
    const accepted = tap(host);
    if (!accepted) return;
    acceptedPresses += 1;
    switch (control) {
      case 'toggle': {
        if (session && !state.busy) {
          postsExpected += 1;
          postIntents.push({
            grant: !state.modelTrainingActive,
            account: session.canonicalAppUserId,
          });
        }
        break;
      }
      case 'back': {
        navPressesThisStep += 1;
        if (!sameTickMode && focusedConsent()) {
          expectedRoutes = expectedRoutes.slice(0, -1);
        } else {
          navUnmodeledThisStep = true;
          unmodeledNavPresses += 1;
        }
        break;
      }
      case 'connect': {
        navPressesThisStep += 1;
        if (!sameTickMode && focusedConsent()) {
          expectedRoutes = [...expectedRoutes, 'ConnectAccount'];
        } else {
          navUnmodeledThisStep = true;
          unmodeledNavPresses += 1;
        }
        break;
      }
      case 'retry': {
        hydrateIntent();
        if (sameTickMode && state.availability === 'loading')
          dupGetSameTick += 1;
        break;
      }
    }
    void where;
  };

  let stepIndex = 0;
  for (const step of steps) {
    const where = `step ${stepIndex} ${summarizeStep(step)}`;
    stepIndex += 1;
    switch (step.kind) {
      case 'press': {
        if (step.mode === 'sequential') {
          for (let i = 0; i < step.times; i++) {
            await act(async () => {
              pressOnce(step.control, where);
            });
            await flush();
          }
        } else {
          sameTickMode = true;
          await act(async () => {
            for (let i = 0; i < step.times; i++) pressOnce(step.control, where);
          });
          sameTickMode = false;
          await flush();
        }
        break;
      }
      case 'simultaneous': {
        sameTickMode = true;
        await act(async () => {
          for (const control of step.controls) pressOnce(control, where);
        });
        sameTickMode = false;
        await flush();
        break;
      }
      case 'resolve': {
        const pending = server.pending();
        if (pending.length === 0) break;
        const target =
          step.which === 'oldest'
            ? pending[0]
            : step.which === 'newest'
              ? pending[pending.length - 1]
              : pending[rng.int(pending.length)];
        await act(async () => {
          server.settle(target as Request, step.outcome);
        });
        await flush();
        break;
      }
      case 'tick': {
        await act(async () => {
          jest.advanceTimersByTime(step.ms);
        });
        await flush();
        break;
      }
      case 'navigateToConsent': {
        // The app reaches this screen from Settings (Tabs), i.e. only while it
        // is not already on the stack; React Navigation 7's `navigate` would
        // otherwise push a second instance, which no app code does.
        if (mountedConsent()) break;
        await act(async () => {
          navigationRef.navigate('ConsentSettings');
        });
        expectedRoutes = [...expectedRoutes, 'ConsentSettings'];
        hydrateIntent();
        await flush();
        break;
      }
      case 'signOut':
      case 'switchAccount':
      case 'signIn': {
        const current = getApiSession()?.canonicalAppUserId;
        const next: 'A' | 'B' | 'none' =
          step.kind === 'signOut'
            ? 'none'
            : step.kind === 'signIn'
              ? current === undefined
                ? 'A'
                : current === ACCOUNT_A.api.canonicalAppUserId
                  ? 'A'
                  : 'B'
              : current === ACCOUNT_A.api.canonicalAppUserId
                ? 'B'
                : 'A';
        const before = useAuthStore.getState().session;
        await act(async () => {
          applySession(next);
        });
        const after = useAuthStore.getState().session;
        if (before !== after && mountedConsent()) hydrateIntent();
        await flush();
        break;
      }
    }
    checkInvariants(where);
  }

  // Settle: every response lands (random order/outcome), every timer fires.
  let guard = 0;
  while (server.pending().length > 0 && guard < 20) {
    guard += 1;
    const pending = server.pending();
    const target = pending[rng.int(pending.length)] as Request;
    await act(async () => {
      server.settle(target, rng.pick(OUTCOMES));
    });
    await flush();
  }
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  await flush();
  checkInvariants('settled');

  const final = useConsentStore.getState();
  const session = getApiSession();
  // A status answer for an account that was switched away from while the
  // screen was NOT mounted leaves `loading` in the store; every consumer
  // (this screen, SettingsScreen) re-hydrates on mount / session change, so
  // it is recorded, not failed. While mounted it is an orphan and fails above.
  const staleLoadingWhileUnmounted =
    final.availability === 'loading' && !mountedConsent() && !final.busy;
  if ((final.availability === 'loading' && mountedConsent()) || final.busy) {
    fail(
      `settled: state still loading/busy (${final.availability}, busy=${String(final.busy)})`,
    );
  }
  if (server.pending().length > 0) {
    fail(`settled: ${server.pending().length} requests never settled`);
  }
  if (session && mountedConsent() && final.availability === 'ready') {
    const truth = server.truth.get(session.canonicalAppUserId) ?? false;
    if (final.modelTrainingActive !== truth) {
      fail(
        `settled: switch shows ${String(final.modelTrainingActive)} but ledger truth is ${String(truth)}`,
      );
    }
  }
  if (!session && mountedConsent() && final.availability !== 'signed_out') {
    fail(`settled: signed out but availability=${final.availability}`);
  }

  // Request accounting.
  const posts = server.requests.filter(r => r.method === 'POST');
  const gets = server.requests.filter(r => r.method === 'GET');
  if (posts.length !== postsExpected) {
    fail(
      `POST count ${posts.length} ≠ accepted toggle intents ${postsExpected}`,
    );
  }
  posts.forEach((post, i) => {
    const intent = postIntents[i];
    if (!intent) return;
    const expectedPath = intent.grant
      ? '/v1/me/consent/grant'
      : '/v1/me/consent/withdraw';
    if (post.path !== expectedPath)
      fail(`POST #${i} path ${post.path} ≠ ${expectedPath}`);
    if (post.account !== intent.account)
      fail(
        `POST #${i} bearer belongs to ${String(post.account)}, intent was ${intent.account}`,
      );
    const body = post.body as Record<string, unknown> | undefined;
    if (
      body?.scope !== 'model_training' ||
      body?.source !== 'mobile_settings'
    ) {
      fail(`POST #${i} body ${JSON.stringify(body)}`);
    }
  });
  if (gets.length !== getsExpected) {
    fail(`GET count ${gets.length} ≠ hydrate intents ${getsExpected}`);
  }
  gets.forEach((get, i) => {
    if (get.path !== '/v1/me/consent/status')
      fail(`GET #${i} path ${get.path}`);
    if (get.account === null) fail(`GET #${i} carried an unknown bearer`);
  });
  if (unhandledNavSequential > 0) {
    fail(
      `${unhandledNavSequential} unhandled navigation action(s) from sequential presses`,
    );
  }
  if (consoleErrors.length > 0) fail(`console.error: ${consoleErrors[0]}`);
  if (consoleWarns.length > 0) fail(`console.warn: ${consoleWarns[0]}`);
  if (unhandledRejections.length > 0)
    fail(`unhandled rejection: ${unhandledRejections[0]}`);

  unsubscribe();
  await act(async () => {
    renderer.unmount();
  });
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  uninstall();

  return {
    seed,
    outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
    steps: steps.length,
    presses,
    acceptedPresses,
    postsExpected,
    postsActual: posts.length,
    getsExpected,
    getsActual: gets.length,
    navChanges,
    unmodeledNavPresses,
    unhandledNavSequential,
    unhandledNavSameTick,
    dupGetSameTick,
    staleLoadingWhileUnmounted,
    consoleErrors: consoleErrors.length,
    consoleWarns: consoleWarns.length,
    unhandledRejections: unhandledRejections.length,
    timeouts: server.requests.filter(r => r.outcome === 'timeout').length,
    script: `${start.session}${start.preHydrated ? '(ready)' : ''}/A=${String(start.truthA)}/B=${String(start.truthB)}: ${steps.map(summarizeStep).join(' ')}`,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

beforeAll(() => {
  jest.useFakeTimers();
  process.on('unhandledRejection', onUnhandledRejection);
  errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
  warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleWarns.push(args.map(String).join(' '));
    });
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandledRejection);
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  jest.useRealTimers();
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const held = rows.filter(r => r.outcome === 'HELD').length;
    fs.writeFileSync(
      OUT,
      JSON.stringify(
        {
          unit: 'scr-consentsettingsscreen',
          lens: 'rapid-interaction',
          iterations: rows.length,
          held,
          broken: rows.length - held,
          totals: {
            presses: rows.reduce((n, r) => n + r.presses, 0),
            acceptedPresses: rows.reduce((n, r) => n + r.acceptedPresses, 0),
            posts: rows.reduce((n, r) => n + r.postsActual, 0),
            gets: rows.reduce((n, r) => n + r.getsActual, 0),
            navChanges: rows.reduce((n, r) => n + r.navChanges, 0),
            timeouts: rows.reduce((n, r) => n + r.timeouts, 0),
            unhandledNavSameTick: rows.reduce(
              (n, r) => n + r.unhandledNavSameTick,
              0,
            ),
            unmodeledNavPresses: rows.reduce(
              (n, r) => n + r.unmodeledNavPresses,
              0,
            ),
            dupGetSameTick: rows.reduce((n, r) => n + r.dupGetSameTick, 0),
            staleLoadingWhileUnmounted: rows.filter(
              r => r.staleLoadingWhileUnmounted,
            ).length,
          },
          rows,
        },
        null,
        2,
      ),
    );
  }
});

const seeds =
  ONLY_SEED !== null
    ? [ONLY_SEED]
    : Array.from({ length: ITER }, (_, i) => SEED_BASE + i);

describe('ConsentSettingsScreen — rapid/concurrent interaction (seeded)', () => {
  for (const seed of seeds) {
    it(`seed ${seed} holds every rapid-interaction invariant`, async () => {
      const row = await runIteration(seed);
      rows.push(row);
      expect({
        seed: row.seed,
        script: row.script,
        failures: row.failures,
      }).toEqual({
        seed: row.seed,
        script: row.script,
        failures: [],
      });
    });
  }
});

describe('ConsentSettingsScreen — directed rapid-interaction scenarios', () => {
  let server: Server;
  let uninstall: () => void;
  let renderer: TestRenderer.ReactTestRenderer;

  async function mount() {
    await act(async () => {
      renderer = TestRenderer.create(
        <Harness onUnhandledAction={type => unhandledNav.push(type)} />,
      );
    });
    await flush();
  }

  beforeEach(async () => {
    consoleErrors.length = 0;
    consoleWarns.length = 0;
    unhandledRejections.length = 0;
    unhandledNav = [];
    server = new Server();
    uninstall = server.install();
    resetStores();
    applySession('A');
  });

  afterEach(async () => {
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
    uninstall();
    expect(consoleErrors).toEqual([]);
    expect(consoleWarns).toEqual([]);
    expect(unhandledRejections).toEqual([]);
  });

  async function ready(active = false) {
    server.truth.set(ACCOUNT_A.api.canonicalAppUserId, active);
    await mount();
    const [get] = server.pending();
    await act(async () => {
      server.settle(get as Request, 'ok');
    });
    await flush();
    expect(useConsentStore.getState().availability).toBe('ready');
  }

  it('five sequential taps on the switch while the first grant is in flight send ONE grant', async () => {
    await ready(false);
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        const host = hosts(renderer, 'toggle')[0] as ReactTestInstance;
        tap(host);
      });
      await flush();
    }
    const posts = server.requests.filter(r => r.method === 'POST');
    expect(posts.map(p => p.path)).toEqual(['/v1/me/consent/grant']);
    expect(
      hosts(renderer, 'toggle')[0]?.props.accessibilityState.disabled,
    ).toBe(true);
    await act(async () => {
      server.settle(posts[0] as Request, 'ok');
    });
    await flush();
    expect(
      hosts(renderer, 'toggle')[0]?.props.accessibilityState,
    ).toMatchObject({
      checked: true,
      disabled: false,
    });
  });

  it('a same-tick triple tap (multi-touch) still yields exactly one request', async () => {
    await ready(true);
    await act(async () => {
      const host = hosts(renderer, 'toggle')[0] as ReactTestInstance;
      tap(host);
      tap(host);
      tap(host);
    });
    await flush();
    const posts = server.requests.filter(r => r.method === 'POST');
    expect(posts.map(p => p.path)).toEqual(['/v1/me/consent/withdraw']);
  });

  it('Back during an in-flight grant leaves the screen, and the late response neither warns nor corrupts a re-entry', async () => {
    await ready(false);
    await act(async () => {
      tap(hosts(renderer, 'toggle')[0] as ReactTestInstance);
    });
    await flush();
    await act(async () => {
      tap(hosts(renderer, 'back')[0] as ReactTestInstance);
    });
    await flush();
    expect(routeNames()).toEqual(['Tabs']);
    expect(hosts(renderer, 'toggle')).toHaveLength(0);

    const [post] = server.requests.filter(r => r.method === 'POST');
    await act(async () => {
      server.settle(post as Request, 'ok');
    });
    await flush();
    expect(useConsentStore.getState()).toMatchObject({
      busy: false,
      modelTrainingActive: true,
    });

    await act(async () => {
      navigationRef.navigate('ConsentSettings');
    });
    await flush();
    expect(routeNames()).toEqual(['Tabs', 'ConsentSettings']);
    const gets = server.requests.filter(r => r.method === 'GET');
    expect(gets).toHaveLength(2);
    await act(async () => {
      server.settle(gets[1] as Request, 'ok');
    });
    await flush();
    expect(
      hosts(renderer, 'toggle')[0]?.props.accessibilityState,
    ).toMatchObject({
      checked: true,
      disabled: false,
    });
  });

  it('double-tapping Connect account pushes ConnectAccount exactly once', async () => {
    applySession('none');
    await mount();
    expect(useConsentStore.getState().availability).toBe('signed_out');
    await act(async () => {
      tap(hosts(renderer, 'connect')[0] as ReactTestInstance);
    });
    await flush();
    await act(async () => {
      const host = hosts(renderer, 'connect')[0];
      if (host) tap(host);
    });
    await flush();
    expect(routeNames()).toEqual(['Tabs', 'ConsentSettings', 'ConnectAccount']);
    expect(server.requests).toHaveLength(0);
    expect(unhandledNav).toEqual([]);
  });

  it('a request that hits the 15s timeout releases busy and shows the failure copy', async () => {
    await ready(false);
    await act(async () => {
      tap(hosts(renderer, 'toggle')[0] as ReactTestInstance);
    });
    await flush();
    expect(useConsentStore.getState().busy).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(CONSENT_REQUEST_TIMEOUT_MS + 1);
    });
    await flush();
    const [post] = server.requests.filter(r => r.method === 'POST');
    expect(post?.outcome).toBe('timeout');
    expect(useConsentStore.getState()).toMatchObject({
      busy: false,
      modelTrainingActive: false,
      error: 'Consent settings are temporarily unavailable.',
    });
    expect(
      hosts(renderer, 'toggle')[0]?.props.accessibilityState.disabled,
    ).toBe(false);
    expect(allText(renderer)).toContain(
      'Consent settings are temporarily unavailable.',
    );
  });

  it('spamming Try again sequentially while unavailable issues one GET per visible button press', async () => {
    await mount();
    const [get] = server.pending();
    await act(async () => {
      server.settle(get as Request, 'http500');
    });
    await flush();
    expect(useConsentStore.getState().availability).toBe('unavailable');
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        const host = hosts(renderer, 'retry')[0];
        if (host) tap(host);
      });
      await flush();
    }
    // Only the first press finds a button: the screen swaps to the loading
    // copy on the very next render and the rest land on nothing.
    expect(server.requests.filter(r => r.method === 'GET')).toHaveLength(2);
    expect(hosts(renderer, 'retry')).toHaveLength(0);
    expect(allText(renderer)).toContain('Checking your current choice…');
  });

  it('switching accounts while a grant is in flight never lets the old answer land on the new account', async () => {
    await ready(false);
    await act(async () => {
      tap(hosts(renderer, 'toggle')[0] as ReactTestInstance);
    });
    await flush();
    server.truth.set(ACCOUNT_B.api.canonicalAppUserId, false);
    await act(async () => {
      applySession('B');
    });
    await flush();
    const posts = server.requests.filter(r => r.method === 'POST');
    const gets = server.requests.filter(r => r.method === 'GET');
    expect(gets).toHaveLength(2);
    expect(gets[1]?.account).toBe(ACCOUNT_B.api.canonicalAppUserId);
    await act(async () => {
      server.settle(gets[1] as Request, 'ok');
    });
    await flush();
    await act(async () => {
      server.settle(posts[0] as Request, 'ok');
    });
    await flush();
    expect(server.truth.get(ACCOUNT_A.api.canonicalAppUserId)).toBe(true);
    expect(useConsentStore.getState()).toMatchObject({
      availability: 'ready',
      busy: false,
      modelTrainingActive: false,
    });
    expect(
      hosts(renderer, 'toggle')[0]?.props.accessibilityState,
    ).toMatchObject({
      checked: false,
      disabled: false,
    });
  });
});
