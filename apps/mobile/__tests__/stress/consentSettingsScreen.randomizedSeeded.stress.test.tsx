import React, { useEffect } from 'react';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Pressable, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * STRESS — `scr-consentsettingsscreen`, lens `randomized-seeded`.
 *
 * ConsentSettingsScreen is rendered as a real route inside the REAL
 * `NavigationContainer` + `createNativeStackNavigator` the app uses, on top
 * of the REAL consent store, api-session store, auth store and consentApi
 * HTTP client. Only native modules (safe-area, sqlite db) and `fetch` are
 * mocked. A seeded generator drives legal / near-legal action sequences
 * (length 5–60) over the unit's public surface — user taps, navigation,
 * sign-in / sign-out / account switch / bearer rotation, server responses in
 * arbitrary order (ok, 500, network error, malformed JSON, 15s timeout) and
 * out-of-band server changes — and model-checks the invariants below after
 * every step.
 *
 * Invariants (from consentStore.ts / ConsentSettingsScreen.tsx comments and
 * the existing tests):
 *   I1  No dark-pattern default: the toggle reads ON only when the server
 *       ledger of the CURRENTLY signed-in account was last seen active
 *       (another account's value must never be shown, not even while the
 *       new account's status is loading).
 *   I2  Server ledger is the only truth: after every settlement the store
 *       equals the reference model (no optimistic state kept on failure,
 *       stale responses of a previous account are never applied).
 *   I3  Signed out ⇒ toggle disabled + OFF, "Sign in to change this…" copy
 *       and "Connect account" visible; no consent request ever goes out
 *       without the bearer of the session current at issue time.
 *   I4  Failures are surfaced: every failed change shows the error copy and
 *       leaves the toggle where the ledger says it is.
 *   I5  Loading ⇒ "Checking your current choice…" + disabled toggle.
 *   I6  Unavailable ⇒ error copy + "Try again" + disabled toggle.
 *   I7  Toggle disabled while busy; at most one POST in flight at a time.
 *   I8  Request payloads: bearer of the current session, X-Client-Version,
 *       grant body {scope, consentVersion, source, device, captureMode},
 *       withdraw body {scope, source, device}.
 *   I9  Navigation: header Back pops the route (screen unmounts);
 *       "Connect account" pushes ConnectAccount; the route auto-dismisses on
 *       sign-in (mirrors RootNavigator.ConnectAccountRoute); re-opening the
 *       screen re-hydrates.
 *   I10 Exactly one switch while mounted, header title "Data & consent",
 *       App Store copy rules (no Android / Google Play / guest mode /
 *       accuracy-% wording) hold on every rendered frame.
 *   I11 No console.error / console.warn / unhandled rejection at any step.
 *   I12 Determinism: same seed twice ⇒ byte-identical trace.
 *
 * Campaign controls:
 *   STRESS_ITER               sequences to run (default 40; campaign 2000)
 *   STRESS_SEED               base seed (default 20260904)
 *   STRESS_DETERMINISM_EVERY  replay every Nth seed twice (default 10)
 *   STRESS_OUT                JSON table path (default: os.tmpdir())
 *   STRESS_REPLAY_ACTIONS     comma-separated action list to replay under
 *                             STRESS_SEED (minimized counter-examples)
 *
 * Replay one seed: STRESS_ITER=1 STRESS_SEED=<seed> npx jest --ci <this file>
 */

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);

import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ConsentSettingsScreen } from '../../src/screens/ConsentSettingsScreen';
import type { RootStackParams } from '../../src/navigation/params';
import { BrandToggle } from '../../src/design/components';
import { useConsentStore } from '../../src/state/consentStore';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  CONSENT_REQUEST_TIMEOUT_MS,
  MODEL_TRAINING_CONSENT_VERSION,
} from '../../src/account/consentApi';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';

// ---------------------------------------------------------------------------
// Campaign parameters
// ---------------------------------------------------------------------------

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? '40'));
const BASE_SEED = Number(process.env.STRESS_SEED ?? '20260904') >>> 0;
const DETERMINISM_EVERY = Math.max(
  1,
  Number(process.env.STRESS_DETERMINISM_EVERY ?? '10'),
);
const OUT_PATH =
  process.env.STRESS_OUT ??
  path.join(os.tmpdir(), `consent-settings-stress-${BASE_SEED}-${ITER}.json`);
const REPLAY_ACTIONS = process.env.STRESS_REPLAY_ACTIONS
  ? (process.env.STRESS_REPLAY_ACTIONS.split(',') as Action[])
  : null;
const CHUNK = 50;
const MIN_LEN = 5;
const MAX_LEN = 60;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32)
// ---------------------------------------------------------------------------

class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    const total = items.reduce((acc, [, w]) => acc + w, 0);
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r < 0) return item;
    }
    return items[items.length - 1]![0];
  }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

type User = 'A' | 'B';
const USER_IDS: Record<User, string> = {
  A: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  B: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const API_BASE = 'https://api.stress.test';

function authSessionFor(user: User): AuthSession {
  return {
    provider: user === 'A' ? 'apple' : 'google',
    subject: `subject-${user}`,
    canonicalAppUserId: USER_IDS[user],
    localOnly: false,
    displayName: null,
    email: null,
  };
}

const GUEST_SESSION: AuthSession = {
  provider: 'guest',
  subject: 'local-only',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
};

// ---------------------------------------------------------------------------
// Fake consent server (fetch double). Every request stays pending until the
// generator settles it, so response ORDER is part of the explored space.
// ---------------------------------------------------------------------------

type SettleKind = 'ok' | 'http_500' | 'network' | 'invalid';
type RequestState = 'pending' | SettleKind | 'aborted';

interface ServerRequest {
  id: number;
  method: string;
  path: string;
  bearer: string | null;
  user: User | null;
  clientVersion: string | null;
  body: unknown;
  state: RequestState;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
}

function statusPayload(active: boolean) {
  return {
    subjectPseudonym: 'pseudo',
    scopes: [
      {
        scope: 'video_analysis',
        active: true,
        consentVersion: null,
        lastAction: null,
        lastActionAt: null,
      },
      {
        scope: 'model_training',
        active,
        consentVersion: active ? MODEL_TRAINING_CONSENT_VERSION : null,
        lastAction: active ? 'granted' : 'withdrawn',
        lastActionAt: active ? '2026-09-01T00:00:00.000Z' : null,
      },
    ],
  };
}

function jsonResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

class FakeServer {
  truth: Record<User, boolean> = { A: false, B: false };
  bearers = new Map<string, User>();
  requests: ServerRequest[] = [];
  private nextId = 1;

  issueBearer(user: User, n: number): string {
    const token = `bearer-${user}-${n}`;
    this.bearers.set(token, user);
    return token;
  }

  pending(): ServerRequest[] {
    return this.requests.filter(r => r.state === 'pending');
  }

  fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers['Authorization'] ?? null;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const url = new URL(input);
    return new Promise<Response>((resolve, reject) => {
      const req: ServerRequest = {
        id: this.nextId++,
        method: init?.method ?? 'GET',
        path: url.pathname,
        bearer,
        user: bearer ? (this.bearers.get(bearer) ?? null) : null,
        clientVersion: headers['X-Client-Version'] ?? null,
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        state: 'pending',
        resolve,
        reject,
      };
      this.requests.push(req);
      init?.signal?.addEventListener('abort', () => {
        if (req.state !== 'pending') return;
        req.state = 'aborted';
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  settle(req: ServerRequest, kind: SettleKind): void {
    if (req.state !== 'pending') return;
    req.state = kind;
    const user = req.user;
    // Server-side effect of a POST: applied on ok and on a malformed
    // reply (the write happened, the answer was garbled); not applied when
    // the server errored or the network dropped the request.
    if (
      user &&
      req.method === 'POST' &&
      (kind === 'ok' || kind === 'invalid')
    ) {
      if (req.path.endsWith('/grant')) this.truth[user] = true;
      if (req.path.endsWith('/withdraw')) this.truth[user] = false;
    }
    switch (kind) {
      case 'ok':
        if (!user) {
          req.resolve(jsonResponse(false, 401, { error: 'unauthorized' }));
          return;
        }
        req.resolve(jsonResponse(true, 200, statusPayload(this.truth[user])));
        return;
      case 'http_500':
        req.resolve(jsonResponse(false, 500, { error: 'internal' }));
        return;
      case 'invalid':
        req.resolve(jsonResponse(true, 200, { scopes: 'not-an-array' }));
        return;
      case 'network':
        req.reject(new TypeError('Network request failed'));
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Reference model of the documented contract
// ---------------------------------------------------------------------------

type Availability = 'loading' | 'ready' | 'signed_out' | 'unavailable';
type Route = 'Tabs' | 'ConsentSettings' | 'ConnectAccount';

interface ModelRequest {
  id: number;
  kind: 'GET' | 'POST';
  /** Account whose session was captured when the request was issued. */
  user: User;
  granted?: boolean;
}

interface Model {
  availability: Availability;
  active: boolean;
  busy: boolean;
  error: string | null;
  /** Account whose ledger the visible `active` was last taken from. */
  appliedFor: User | null;
  apiUser: User | null;
  apiBearer: string | null;
  auth: 'none' | 'guest' | User;
  stack: Route[];
  requests: ModelRequest[];
  nextRequestId: number;
}

const UNAVAILABLE_COPY = 'Consent settings are temporarily unavailable.';
const INVALID_COPY = 'The consent server returned an invalid response.';
const SIGNED_OUT_TOGGLE_COPY =
  'Sign in to change this setting. Nothing was changed.';

function signedOutModel(m: Model): void {
  m.availability = 'signed_out';
  m.active = false;
  m.busy = false;
  m.error = null;
  m.appliedFor = null;
}

function staleModel(m: Model): void {
  if (m.apiUser) m.busy = false;
  else signedOutModel(m);
}

function modelHydrate(m: Model): void {
  if (!m.apiUser) {
    signedOutModel(m);
    return;
  }
  m.availability = 'loading';
  m.error = null;
  m.requests.push({ id: m.nextRequestId++, kind: 'GET', user: m.apiUser });
}

function modelSetConsent(m: Model, granted: boolean): void {
  if (!m.apiUser) {
    signedOutModel(m);
    m.error = SIGNED_OUT_TOGGLE_COPY;
    return;
  }
  if (m.busy) return;
  m.busy = true;
  m.error = null;
  m.requests.push({
    id: m.nextRequestId++,
    kind: 'POST',
    user: m.apiUser,
    granted,
  });
}

function modelSettle(
  m: Model,
  req: ServerRequest,
  kind: SettleKind | 'aborted',
  server: FakeServer,
): void {
  const idx = m.requests.findIndex(r => r.id === req.id);
  if (idx < 0) throw new Error(`model has no request #${req.id}`);
  const [mr] = m.requests.splice(idx, 1);
  const current = mr!.user === m.apiUser;
  if (!current) {
    staleModel(m);
    return;
  }
  const okPayloadActive = req.user ? server.truth[req.user] : null;
  const ok = kind === 'ok' && okPayloadActive !== null;
  const message = kind === 'invalid' ? INVALID_COPY : UNAVAILABLE_COPY;
  if (mr!.kind === 'GET') {
    if (ok) {
      m.availability = 'ready';
      m.active = okPayloadActive;
      m.appliedFor = mr!.user;
    } else {
      m.availability = 'unavailable';
      m.active = false;
      m.appliedFor = null;
      m.error = message;
    }
    return;
  }
  m.busy = false;
  if (ok) {
    m.availability = 'ready';
    m.active = okPayloadActive;
    m.appliedFor = mr!.user;
  } else {
    m.error = message;
  }
}

// ---------------------------------------------------------------------------
// Navigator host: real container + real native stack. `Tabs` stands in for
// the tab navigator the screen is pushed from; `ConnectAccount` mirrors
// RootNavigator.ConnectAccountRoute's auto-dismiss on a non-guest provider.
// ---------------------------------------------------------------------------

const Stack = createNativeStackNavigator<RootStackParams>();
const navRef = createNavigationContainerRef<RootStackParams>();

function TabsStub() {
  return <Text>[Tabs]</Text>;
}

function ConnectAccountStub({
  navigation,
}: {
  navigation: { goBack: () => void };
}) {
  const provider = useAuthStore(state => state.session?.provider);
  useEffect(() => {
    if (provider && provider !== 'guest') navigation.goBack();
  }, [navigation, provider]);
  return (
    <>
      <Text>[ConnectAccount]</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to consent settings"
        onPress={() => navigation.goBack()}
      >
        <Text>Back</Text>
      </Pressable>
    </>
  );
}

function Host() {
  return (
    <NavigationContainer ref={navRef}>
      <Stack.Navigator
        initialRouteName="Tabs"
        screenOptions={{ headerShown: false, animation: 'none' }}
      >
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

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

type Renderer = TestRenderer.ReactTestRenderer;

function currentRoutes(): string[] {
  if (!navRef.isReady()) return [];
  const state = navRef.getRootState();
  return state ? state.routes.map(r => r.name) : [];
}

function allText(renderer: Renderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string');
}

/** Innermost composite pressables (own onPress + role). */
function pressables(renderer: Renderer) {
  return renderer.root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      typeof node.props.accessibilityRole === 'string' &&
      typeof node.type !== 'string',
  );
}

function labeled(renderer: Renderer, label: string) {
  const nodes = pressables(renderer).filter(
    n => n.props.accessibilityLabel === label,
  );
  // PressableScale wraps Pressable; both carry the props. Take the innermost.
  return nodes.length ? nodes[nodes.length - 1]! : null;
}

/** RN Pressable semantics: a disabled control swallows the tap. */
function press(node: ReturnType<typeof labeled>): boolean {
  if (!node) return false;
  if (node.props.disabled) return false;
  node.props.onPress();
  return true;
}

function switchNode(renderer: Renderer) {
  const nodes = renderer.root.findAll(
    n =>
      n.props.accessibilityRole === 'switch' &&
      typeof n.props.onPress === 'function' &&
      typeof n.type !== 'string',
  );
  return nodes.length ? nodes[nodes.length - 1]! : null;
}

const FORBIDDEN_COPY = [
  /android/i,
  /google play/i,
  /guest mode/i,
  /live court/i,
  /dupr/i,
  /\d+\s?%/,
  /swingvision|pb vision|selkirk|joola/i,
];

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const ACTIONS = [
  'tap_toggle',
  'force_toggle',
  'tap_back',
  'tap_connect',
  'tap_try_again',
  'reopen',
  'sign_in_A',
  'sign_in_B',
  'sign_out',
  'continue_as_guest',
  'rotate_bearer',
  'server_flip_A',
  'server_flip_B',
  'respond_oldest_ok',
  'respond_oldest_500',
  'respond_oldest_network',
  'respond_oldest_invalid',
  'respond_newest_ok',
  'respond_newest_network',
  'advance_timeout',
  'flush',
] as const;
type Action = (typeof ACTIONS)[number];

interface StepRecord {
  i: number;
  action: Action;
  applied: boolean;
  store: {
    availability: Availability;
    active: boolean;
    busy: boolean;
    error: string | null;
  };
  ui: {
    stack: string[];
    mounted: boolean;
    checked: boolean | null;
    disabled: boolean | null;
    marks: string;
  };
  pending: number[];
}

interface SequenceResult {
  seed: number;
  length: number;
  initialTruth: Record<User, boolean>;
  actions: Action[];
  appliedSteps: number;
  requests: number;
  outcome: 'HELD' | 'BROKEN';
  failure?: { step: number; invariant: string; detail: string };
  traceHash: string;
  trace?: StepRecord[];
}

function hash(s: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0');
}

class InvariantViolation extends Error {
  constructor(
    public invariant: string,
    detail: string,
  ) {
    super(`${invariant}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// One sequence
// ---------------------------------------------------------------------------

interface RunOptions {
  seed: number;
  /** Replay a fixed action list (minimizer) instead of generating one. */
  actions?: Action[];
  initialTruth?: Record<User, boolean>;
  keepTrace: boolean;
}

const consoleFailures: string[] = [];
const rejections: string[] = [];

async function settleMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    jest.advanceTimersByTime(20);
    for (let i = 0; i < 12; i++) await Promise.resolve();
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

function checkInvariants(
  renderer: Renderer,
  m: Model,
  server: FakeServer,
  ui: StepRecord['ui'],
): void {
  const s = useConsentStore.getState();
  // I2 — store mirrors the reference model.
  const storeView = {
    availability: s.availability,
    active: s.modelTrainingActive,
    busy: s.busy,
    error: s.error,
  };
  const modelView = {
    availability: m.availability,
    active: m.active,
    busy: m.busy,
    error: m.error,
  };
  if (JSON.stringify(storeView) !== JSON.stringify(modelView)) {
    throw new InvariantViolation(
      'I2 store≠model',
      `store=${JSON.stringify(storeView)} model=${JSON.stringify(modelView)}`,
    );
  }
  // Model self-check: the requests the model expects in flight are exactly
  // the ones the fake server holds (method, account and order included).
  const pendingView = server
    .pending()
    .map(r => `${r.id}:${r.method}:${r.user}`)
    .join(' ');
  const modelPendingView = m.requests
    .map(r => `${r.id}:${r.kind}:${r.user}`)
    .join(' ');
  if (pendingView !== modelPendingView) {
    throw new InvariantViolation(
      'I2 in-flight requests≠model',
      `server=[${pendingView}] model=[${modelPendingView}]`,
    );
  }
  // I3/I7/I8 — request log.
  const pendingPosts = server.pending().filter(r => r.method === 'POST');
  if (pendingPosts.length > 1) {
    throw new InvariantViolation(
      'I7 >1 POST in flight',
      pendingPosts.map(r => `#${r.id}`).join(','),
    );
  }
  const expectedVersion = getRuntimePublicConfig().appVersion;
  for (const r of server.requests) {
    if (!r.bearer || !r.user) {
      throw new InvariantViolation(
        'I3 request without a known bearer',
        `#${r.id} ${r.method} ${r.path} bearer=${r.bearer}`,
      );
    }
    if (r.clientVersion !== expectedVersion) {
      throw new InvariantViolation(
        'I8 X-Client-Version',
        `#${r.id} got ${r.clientVersion}`,
      );
    }
    if (r.method === 'POST') {
      const body = r.body as Record<string, unknown> | undefined;
      const grant = r.path.endsWith('/grant');
      const withdraw = r.path.endsWith('/withdraw');
      if (!grant && !withdraw) {
        throw new InvariantViolation('I8 unknown POST path', r.path);
      }
      const okBody =
        body !== undefined &&
        body['scope'] === 'model_training' &&
        body['source'] === 'mobile_settings' &&
        typeof body['device'] === 'string' &&
        (!grant ||
          (body['consentVersion'] === MODEL_TRAINING_CONSENT_VERSION &&
            body['captureMode'] === 'all_captures'));
      if (!okBody) {
        throw new InvariantViolation(
          'I8 POST body',
          `#${r.id} ${r.path} ${JSON.stringify(body)}`,
        );
      }
    } else if (r.path !== '/v1/me/consent/status') {
      throw new InvariantViolation('I8 unknown GET path', r.path);
    }
  }
  // I9 — navigator state vs model.
  const routes = currentRoutes();
  if (JSON.stringify(routes) !== JSON.stringify(m.stack)) {
    throw new InvariantViolation(
      'I9 route stack',
      `navigator=${routes.join('>')} model=${m.stack.join('>')}`,
    );
  }
  const shouldMount = m.stack.includes('ConsentSettings');
  const toggles = renderer.root.findAllByType(BrandToggle);
  if (shouldMount !== toggles.length > 0) {
    throw new InvariantViolation(
      'I9 mount state',
      `expected mounted=${shouldMount} toggles=${toggles.length}`,
    );
  }
  const texts = allText(renderer);
  // I10 — copy rules on every frame.
  for (const t of texts) {
    for (const re of FORBIDDEN_COPY) {
      if (re.test(t)) {
        throw new InvariantViolation('I10 forbidden copy', `${re} in "${t}"`);
      }
    }
  }
  if (!shouldMount) {
    ui.mounted = false;
    ui.checked = null;
    ui.disabled = null;
    ui.marks = '';
    return;
  }
  if (toggles.length !== 1) {
    throw new InvariantViolation('I10 switch count', String(toggles.length));
  }
  if (!texts.includes('Data & consent')) {
    throw new InvariantViolation('I10 header title', texts.join(' | '));
  }
  const sw = switchNode(renderer);
  if (!sw) throw new InvariantViolation('I10 switch node', 'missing');
  const checked = Boolean(sw.props.accessibilityState?.checked);
  const disabled = Boolean(sw.props.accessibilityState?.disabled);
  ui.mounted = true;
  ui.checked = checked;
  ui.disabled = disabled;
  if (checked !== s.modelTrainingActive) {
    throw new InvariantViolation(
      'I2 rendered toggle≠store',
      `checked=${checked} store=${s.modelTrainingActive}`,
    );
  }
  // I1 — the rendered toggle reads ON only with a proven-active ledger for
  // the account that is signed in right now. (Carrying the SAME account's
  // last value through a refresh hydrate is allowed.)
  if (checked && (m.appliedFor === null || m.appliedFor !== m.apiUser)) {
    throw new InvariantViolation(
      'I1 toggle ON without current-account proof',
      `availability=${s.availability} appliedFor=${m.appliedFor} apiUser=${m.apiUser}`,
    );
  }
  const expectDisabled = s.busy || s.availability !== 'ready';
  if (disabled !== expectDisabled) {
    throw new InvariantViolation(
      'I5/I6/I7 toggle disabled',
      `disabled=${disabled} busy=${s.busy} availability=${s.availability}`,
    );
  }
  if (Boolean(sw.props.disabled) !== expectDisabled) {
    throw new InvariantViolation(
      'I7 pressable disabled prop',
      `disabled=${String(sw.props.disabled)}`,
    );
  }
  const has = (copy: string) => texts.includes(copy);
  const signedOutCopy = has(
    'Sign in to change this. Nothing is shared while signed out.',
  );
  const loadingCopy = has('Checking your current choice…');
  const connect = labeled(renderer, 'Connect account') !== null;
  const tryAgain = labeled(renderer, 'Try again') !== null;
  const errorShown = s.error !== null && has(s.error);
  const unavailableFallback = has(UNAVAILABLE_COPY);
  ui.marks = [
    signedOutCopy ? 'signedOut' : '',
    loadingCopy ? 'loading' : '',
    connect ? 'connect' : '',
    tryAgain ? 'tryAgain' : '',
    errorShown ? 'error' : '',
  ]
    .filter(Boolean)
    .join('+');
  switch (s.availability) {
    case 'signed_out':
      if (!signedOutCopy || !connect || checked) {
        throw new InvariantViolation(
          'I3 signed-out frame',
          `copy=${signedOutCopy} connect=${connect} checked=${checked}`,
        );
      }
      break;
    case 'loading':
      if (!loadingCopy) throw new InvariantViolation('I5 loading copy', '');
      break;
    case 'unavailable':
      if (
        !(errorShown || (s.error === null && unavailableFallback)) ||
        !tryAgain
      ) {
        throw new InvariantViolation(
          'I6 unavailable frame',
          `error=${s.error} shown=${errorShown} tryAgain=${tryAgain}`,
        );
      }
      break;
    case 'ready':
      if (s.error !== null && !errorShown) {
        throw new InvariantViolation('I4 error not surfaced', s.error);
      }
      break;
  }
  if (s.availability !== 'signed_out' && (signedOutCopy || connect)) {
    throw new InvariantViolation('I3 signed-out copy leaked', s.availability);
  }
  if (s.availability !== 'loading' && loadingCopy) {
    throw new InvariantViolation('I5 loading copy leaked', s.availability);
  }
  if (s.availability !== 'unavailable' && tryAgain) {
    throw new InvariantViolation('I6 Try again leaked', s.availability);
  }
}

function applicable(a: Action, m: Model, server: FakeServer): boolean {
  const top = m.stack[m.stack.length - 1];
  const onConsent = top === 'ConsentSettings';
  const pending = server.pending();
  switch (a) {
    case 'tap_toggle':
    case 'force_toggle':
      return onConsent;
    case 'tap_back':
      return top !== 'Tabs';
    case 'tap_connect':
      return onConsent && m.availability === 'signed_out';
    case 'tap_try_again':
      return onConsent && m.availability === 'unavailable';
    case 'reopen':
      return !m.stack.includes('ConsentSettings');
    case 'sign_in_A':
    case 'sign_in_B':
      return true;
    case 'sign_out':
      return m.auth !== 'none';
    case 'continue_as_guest':
      return m.auth !== 'guest';
    case 'rotate_bearer':
      return m.apiUser !== null;
    case 'server_flip_A':
    case 'server_flip_B':
      return true;
    case 'respond_oldest_ok':
    case 'respond_oldest_500':
    case 'respond_oldest_network':
    case 'respond_oldest_invalid':
      return pending.length > 0;
    case 'respond_newest_ok':
    case 'respond_newest_network':
      return pending.length > 1;
    case 'advance_timeout':
      return pending.length > 0;
    case 'flush':
      return true;
  }
}

const WEIGHTS: Record<Action, number> = {
  tap_toggle: 14,
  force_toggle: 3,
  tap_back: 3,
  tap_connect: 4,
  tap_try_again: 6,
  reopen: 10,
  sign_in_A: 5,
  sign_in_B: 4,
  sign_out: 3,
  continue_as_guest: 2,
  rotate_bearer: 2,
  server_flip_A: 2,
  server_flip_B: 1,
  respond_oldest_ok: 16,
  respond_oldest_500: 4,
  respond_oldest_network: 4,
  respond_oldest_invalid: 3,
  respond_newest_ok: 4,
  respond_newest_network: 2,
  advance_timeout: 2,
  flush: 3,
};

function applyAuthSignIn(
  m: Model,
  server: FakeServer,
  user: User,
  bearerSeq: { n: number },
): void {
  // Production order (authStore.installApiSession → set({session})): the
  // api session is live BEFORE the auth session changes, so the screen's
  // hydrate effect sees a bearer.
  const token = server.issueBearer(user, bearerSeq.n++);
  const api: ApiSession = {
    apiBaseUrl: API_BASE,
    bearerToken: token,
    canonicalAppUserId: USER_IDS[user],
    provider: user === 'A' ? 'apple' : 'google',
  };
  establishApiSession(api);
  m.apiUser = user;
  m.apiBearer = token;
  useAuthStore.setState({ session: authSessionFor(user) });
  m.auth = user;
  // Effects run inside act(): ConsentSettings (if mounted) re-hydrates;
  // ConnectAccount (if on top) auto-dismisses.
  if (m.stack.includes('ConsentSettings')) modelHydrate(m);
  if (m.stack[m.stack.length - 1] === 'ConnectAccount') m.stack.pop();
}

function applySignOut(m: Model, session: AuthSession | null): void {
  clearApiSession();
  m.apiUser = null;
  m.apiBearer = null;
  useAuthStore.setState({ session });
  m.auth = session ? 'guest' : 'none';
  if (m.stack.includes('ConsentSettings')) signedOutModel(m);
}

async function runSequence(opts: RunOptions): Promise<SequenceResult> {
  const rng = new Rng(opts.seed);
  const server = new FakeServer();
  const initialTruth = opts.initialTruth ?? {
    A: rng.bool(0.4),
    B: rng.bool(0.4),
  };
  server.truth = { ...initialTruth };
  const length = opts.actions ? opts.actions.length : rng.int(MIN_LEN, MAX_LEN);
  const bearerSeq = { n: 1 };
  globalThis.fetch = server.fetch as typeof fetch;
  consoleFailures.length = 0;
  rejections.length = 0;
  resetStores();

  const m: Model = {
    availability: 'loading',
    active: false,
    busy: false,
    error: null,
    appliedFor: null,
    apiUser: null,
    apiBearer: null,
    auth: 'none',
    stack: ['Tabs'],
    requests: [],
    nextRequestId: 1,
  };

  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<Host />);
  });
  // Entry path the app uses: Settings → ConsentSettings.
  await act(async () => {
    navRef.navigate('ConsentSettings');
  });
  m.stack.push('ConsentSettings');
  modelHydrate(m);
  await settleMicrotasks();

  const trace: StepRecord[] = [];
  const actions: Action[] = [];
  let appliedSteps = 0;
  let failure: SequenceResult['failure'];

  const record = (i: number, action: Action, applied: boolean) => {
    const s = useConsentStore.getState();
    const ui: StepRecord['ui'] = {
      stack: currentRoutes(),
      mounted: false,
      checked: null,
      disabled: null,
      marks: '',
    };
    const rec: StepRecord = {
      i,
      action,
      applied,
      store: {
        availability: s.availability,
        active: s.modelTrainingActive,
        busy: s.busy,
        error: s.error,
      },
      ui,
      pending: server.pending().map(r => r.id),
    };
    trace.push(rec);
    return ui;
  };

  try {
    // Step 0: the freshly opened screen.
    checkInvariants(renderer, m, server, record(0, 'flush', true));
    for (let i = 1; i <= length; i++) {
      let action: Action;
      if (opts.actions) {
        action = opts.actions[i - 1]!;
      } else {
        const options = ACTIONS.filter(a => applicable(a, m, server)).map(
          a => [a, WEIGHTS[a]] as const,
        );
        action = rng.weighted(options);
      }
      actions.push(action);
      const applied = applicable(action, m, server);
      if (applied) {
        appliedSteps++;
        await act(async () => {
          switch (action) {
            case 'tap_toggle': {
              const sw = switchNode(renderer);
              const value = Boolean(sw?.props.accessibilityState?.checked);
              if (press(sw)) modelSetConsent(m, !value);
              break;
            }
            case 'force_toggle': {
              // Near-legal: the tap lands even though the control reads
              // disabled (double-tap before the re-render). Exercises the
              // store's own busy / signed-out guards.
              const sw = switchNode(renderer);
              const value = Boolean(sw?.props.accessibilityState?.checked);
              sw?.props.onPress();
              modelSetConsent(m, !value);
              break;
            }
            case 'tap_back': {
              const top = m.stack[m.stack.length - 1];
              const node = labeled(
                renderer,
                top === 'ConnectAccount' ? 'Back to consent settings' : 'Back',
              );
              if (press(node)) m.stack.pop();
              break;
            }
            case 'tap_connect':
              if (press(labeled(renderer, 'Connect account'))) {
                m.stack.push('ConnectAccount');
              }
              break;
            case 'tap_try_again':
              if (press(labeled(renderer, 'Try again'))) {
                modelHydrate(m);
              }
              break;
            case 'reopen':
              navRef.navigate('ConsentSettings');
              m.stack.push('ConsentSettings');
              modelHydrate(m);
              break;
            case 'sign_in_A':
              applyAuthSignIn(m, server, 'A', bearerSeq);
              break;
            case 'sign_in_B':
              applyAuthSignIn(m, server, 'B', bearerSeq);
              break;
            case 'sign_out':
              applySignOut(m, null);
              break;
            case 'continue_as_guest':
              applySignOut(m, GUEST_SESSION);
              break;
            case 'rotate_bearer': {
              // sessionKeeper rotation: same account, new bearer, the auth
              // session object is untouched (no re-hydrate).
              const current = getApiSession();
              if (current && m.apiUser) {
                const token = server.issueBearer(m.apiUser, bearerSeq.n++);
                establishApiSession({ ...current, bearerToken: token });
                m.apiBearer = token;
              }
              break;
            }
            case 'server_flip_A':
              server.truth.A = !server.truth.A;
              break;
            case 'server_flip_B':
              server.truth.B = !server.truth.B;
              break;
            case 'respond_oldest_ok':
            case 'respond_oldest_500':
            case 'respond_oldest_network':
            case 'respond_oldest_invalid':
            case 'respond_newest_ok':
            case 'respond_newest_network': {
              const pending = server.pending();
              const req = action.startsWith('respond_oldest')
                ? pending[0]!
                : pending[pending.length - 1]!;
              const kind: SettleKind = action.endsWith('_ok')
                ? 'ok'
                : action.endsWith('_500')
                  ? 'http_500'
                  : action.endsWith('_network')
                    ? 'network'
                    : 'invalid';
              // Model first: the ok payload reads server truth AFTER the
              // POST applied, exactly like the fake server.
              server.settle(req, kind);
              modelSettle(m, req, kind, server);
              break;
            }
            case 'advance_timeout': {
              const pending = server.pending();
              jest.advanceTimersByTime(CONSENT_REQUEST_TIMEOUT_MS + 1);
              for (const req of pending) {
                if (req.state !== 'aborted') {
                  throw new InvariantViolation(
                    'I8 timeout abort',
                    `#${req.id} state=${req.state}`,
                  );
                }
                modelSettle(m, req, 'aborted', server);
              }
              break;
            }
            case 'flush':
              break;
          }
        });
      }
      await settleMicrotasks();
      const ui = record(i, action, applied);
      if (consoleFailures.length || rejections.length) {
        throw new InvariantViolation(
          'I11 console/rejection',
          [...consoleFailures, ...rejections].join(' || '),
        );
      }
      checkInvariants(renderer, m, server, ui);
    }
  } catch (error) {
    const step = trace.length - 1;
    failure = {
      step,
      invariant:
        error instanceof InvariantViolation ? error.invariant : 'exception',
      detail: error instanceof Error ? `${error.message}` : String(error),
    };
  } finally {
    act(() => renderer.unmount());
    jest.clearAllTimers();
    // Drop recorded mock.calls/results of the RN preset's native mocks;
    // they grow without bound across thousands of sequences.
    jest.clearAllMocks();
    resetStores();
  }

  const traceJson = JSON.stringify(trace);
  const result: SequenceResult = {
    seed: opts.seed,
    length,
    initialTruth,
    actions,
    appliedSteps,
    requests: server.requests.length,
    outcome: failure ? 'BROKEN' : 'HELD',
    traceHash: hash(traceJson),
  };
  if (failure) result.failure = failure;
  if (opts.keepTrace || failure) result.trace = trace;
  return result;
}

// ---------------------------------------------------------------------------
// Minimizer: greedy 1-action deletion to a fixed point, then chunk deletion.
// Failure identity = same invariant name.
// ---------------------------------------------------------------------------

async function minimize(
  failing: SequenceResult,
): Promise<{ actions: Action[]; runs: number }> {
  // Actions after the failing step cannot matter.
  let actions = failing.actions.slice(0, failing.failure!.step);
  const invariant = failing.failure!.invariant;
  let runs = 0;
  const stillFails = async (candidate: Action[]) => {
    runs++;
    const r = await runSequence({
      seed: failing.seed,
      actions: candidate,
      initialTruth: failing.initialTruth,
      keepTrace: false,
    });
    return r.failure?.invariant === invariant;
  };
  let changed = true;
  while (changed && actions.length > 1) {
    changed = false;
    for (
      let chunk = Math.max(1, Math.floor(actions.length / 2));
      chunk >= 1;
      chunk = Math.floor(chunk / 2)
    ) {
      for (let i = 0; i + chunk <= actions.length;) {
        const candidate = [...actions.slice(0, i), ...actions.slice(i + chunk)];
        if (candidate.length && (await stillFails(candidate))) {
          actions = candidate;
          changed = true;
        } else {
          i++;
        }
      }
    }
  }
  return { actions, runs };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const results: SequenceResult[] = [];
const determinism: Array<{
  seed: number;
  identical: boolean;
  hashA: string;
  hashB: string;
}> = [];
const heap: Array<{ afterSequences: number; heapUsedMb: number }> = [];
const minimized: Array<{
  seed: number;
  invariant: string;
  original: number;
  minimizedLength: number;
  actions: Action[];
  minimizerRuns: number;
  rerun10: { failures: number; rate: string };
}> = [];

let realFetch: typeof fetch;
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
const onRejection = (reason: unknown) => {
  rejections.push(reason instanceof Error ? reason.message : String(reason));
};

beforeAll(() => {
  jest.useFakeTimers();
  realFetch = globalThis.fetch;
  errorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleFailures.push(`console.error: ${args.map(String).join(' ')}`);
  });
  warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args) => {
    consoleFailures.push(`console.warn: ${args.map(String).join(' ')}`);
  });
  process.on('unhandledRejection', onRejection);
});

afterAll(() => {
  process.off('unhandledRejection', onRejection);
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  globalThis.fetch = realFetch;
  jest.useRealTimers();
  const table = {
    unit: 'scr-consentsettingsscreen',
    lens: 'randomized-seeded',
    baseSeed: BASE_SEED,
    iterations: ITER,
    node: process.version,
    executed: results.length,
    appliedSteps: results.reduce((a, r) => a + r.appliedSteps, 0),
    requests: results.reduce((a, r) => a + r.requests, 0),
    held: results.filter(r => r.outcome === 'HELD').length,
    broken: results.filter(r => r.outcome === 'BROKEN').length,
    lengthHistogram: results.reduce<Record<string, number>>((acc, r) => {
      const bucket = `${Math.floor(r.length / 10) * 10}-${Math.floor(r.length / 10) * 10 + 9}`;
      acc[bucket] = (acc[bucket] ?? 0) + 1;
      return acc;
    }, {}),
    actionHistogram: results.reduce<Record<string, number>>((acc, r) => {
      for (const a of r.actions) acc[a] = (acc[a] ?? 0) + 1;
      return acc;
    }, {}),
    heap,
    determinism,
    minimized,
    results: results.map(r => ({
      seed: r.seed,
      length: r.length,
      appliedSteps: r.appliedSteps,
      requests: r.requests,
      initialTruth: r.initialTruth,
      outcome: r.outcome,
      traceHash: r.traceHash,
      actions: r.actions.join(','),
      ...(r.failure ? { failure: r.failure, trace: r.trace } : {}),
    })),
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(table, null, 1));
});

describe(`ConsentSettingsScreen seeded randomized long-run (ITER=${ITER}, seed=${BASE_SEED})`, () => {
  const chunks: Array<[number, number]> = [];
  for (let start = 0; start < ITER; start += CHUNK) {
    chunks.push([start, Math.min(ITER, start + CHUNK)]);
  }

  for (const [start, end] of chunks) {
    test(`sequences ${start}..${end - 1} hold every invariant`, async () => {
      const broken: string[] = [];
      for (let k = start; k < end; k++) {
        const seed = (BASE_SEED + k) >>> 0;
        const r = await runSequence({
          seed,
          keepTrace: REPLAY_ACTIONS !== null,
          ...(REPLAY_ACTIONS ? { actions: REPLAY_ACTIONS } : {}),
        });
        results.push(r);
        if (r.failure) {
          broken.push(
            `seed=${seed} step=${r.failure.step} ${r.failure.invariant} — ${r.failure.detail}`,
          );
        }
      }
      heap.push({
        afterSequences: results.length,
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1e6),
      });
      expect(broken).toEqual([]);
    }, 600_000);
  }

  test('I12 determinism: same seed twice → identical trace', async () => {
    const seeds = results
      .filter((_, i) => i % DETERMINISM_EVERY === 0)
      .map(r => r.seed);
    for (const r of results) {
      if (r.failure && !seeds.includes(r.seed)) seeds.push(r.seed);
    }
    for (const seed of seeds) {
      const a = await runSequence({ seed, keepTrace: true });
      const b = await runSequence({ seed, keepTrace: true });
      const identical =
        JSON.stringify(a.trace) === JSON.stringify(b.trace) &&
        a.actions.join() === b.actions.join();
      determinism.push({
        seed,
        identical,
        hashA: a.traceHash,
        hashB: b.traceHash,
      });
    }
    expect(determinism.length).toBeGreaterThan(0);
    expect(determinism.filter(d => !d.identical)).toEqual([]);
  }, 1_800_000);

  test('every failing seed is minimized and re-run 10×', async () => {
    for (const r of results.filter(x => x.failure)) {
      const min = await minimize(r);
      let failures = 0;
      for (let i = 0; i < 10; i++) {
        const again = await runSequence({ seed: r.seed, keepTrace: false });
        if (again.failure?.invariant === r.failure!.invariant) failures++;
      }
      minimized.push({
        seed: r.seed,
        invariant: r.failure!.invariant,
        original: r.actions.length,
        minimizedLength: min.actions.length,
        actions: min.actions,
        minimizerRuns: min.runs,
        rerun10: { failures, rate: `${failures}/10` },
      });
    }
    expect(minimized).toEqual([]);
  }, 7_200_000);
});
