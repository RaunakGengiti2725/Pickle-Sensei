/**
 * Lifecycle-interruption stress campaign for ConsentSettingsScreen.
 *
 * The REAL screen is rendered inside the REAL React Navigation container and
 * native-stack navigator (pushed over a Settings stand-in that mirrors the
 * production SettingsScreen's consent row), with the REAL consent, auth and
 * api-session stores. Only two things are replaced: native modules (SQLite,
 * safe-area) and `globalThis.fetch`, which is a scripted consent server whose
 * responses are delivered in whatever order the schedule picks.
 *
 * Each iteration draws a schedule from a seeded RNG (mulberry32) — open /
 * back / toggle / double-tap / try-again, out-of-order and failed response
 * delivery, network drops, token rotation, bearer revocation, sign-out,
 * sign-in, account switch, background / foreground, server-side consent
 * revocation, and kill + relaunch — and checks the store, the rendered tree
 * and the timer/listener ledgers after every step. Every iteration is
 * replayable from its seed:
 *
 *   STRESS_SEED=<n>        replay exactly one seed
 *   STRESS_ITER=<n>        number of seeds (default 120)
 *   STRESS_STEPS=<n>       max steps per schedule (default 24)
 *   STRESS_OUT=<file.json> write the seed → outcome table
 *
 * Invariants (each violation is recorded with seed, step and detail):
 *   value          ready ⇒ the shown value is the newest response the signed-
 *                  in account received while signed in (no older response,
 *                  no other account's response, no value without a response)
 *   signed_out     no api session ⇒ signed_out / off / not busy
 *   never_signed_out_while_signed_in
 *   loading_has_request
 *   busy_has_request
 *   busy_leak      the signed-in account has nothing in flight ⇒ not busy
 *   error_source   an error is only shown for a failure this account had
 *   render         switch checked/disabled and state copy match the store
 *   quiescent      nothing in flight ⇒ not busy, not loading
 *   timers         one 15 s request timer per in-flight request, none after
 *   listeners      every AppState subscription the tree added was removed
 *   double_tap     a second tap while busy issues no second request
 */
import React, { useEffect } from 'react';
import { AppState, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as fs from 'node:fs';
import * as path from 'node:path';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ConsentSettingsScreen } from '../../src/screens/ConsentSettingsScreen';
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
import type { RootStackParams } from '../../src/navigation/params';

// ─── Seeded RNG ──────────────────────────────────────────────────────────────

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
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
  weighted<T>(items: readonly { weight: number; value: T }[]): T {
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    let roll = this.next() * total;
    for (const item of items) {
      roll -= item.weight;
      if (roll < 0) return item.value;
    }
    return (items[items.length - 1] as { value: T }).value;
  }
}

// ─── Accounts ────────────────────────────────────────────────────────────────

type Acct = 'A' | 'B';
const ACCOUNTS: Record<Acct, { id: string; name: string; email: string }> = {
  A: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Alex Chen',
    email: 'alex@example.com',
  },
  B: {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Bao Tran',
    email: 'bao@example.com',
  },
};
const API_BASE_URL = 'https://api.example.test';

function authSessionFor(acct: Acct): AuthSession {
  return {
    provider: 'google',
    subject: ACCOUNTS[acct].id,
    canonicalAppUserId: ACCOUNTS[acct].id,
    localOnly: false,
    displayName: ACCOUNTS[acct].name,
    email: ACCOUNTS[acct].email,
  };
}

// ─── Scripted consent server (the fetch replacement) ─────────────────────────

type RequestKind = 'status' | 'grant' | 'withdraw';

interface ScriptedRequest {
  /** Issue sequence number — the server processed requests in this order. */
  id: number;
  acct: Acct;
  kind: RequestKind;
  bearer: string;
  /** Decided when the request reached the server. */
  httpStatus: number;
  payload: unknown;
  settled: boolean;
  /** How the response was delivered, once settled. */
  delivery: 'ok' | 'fail' | 'drop' | 'abort' | null;
  /** Whether `acct` was the signed-in account when the response landed. */
  currentAtSettle: boolean | null;
  resolve: (response: Response) => void;
  reject: (reason: unknown) => void;
}

interface ServerModel {
  active: Record<Acct, boolean>;
  validBearers: Set<string>;
  bearerSeq: number;
}

function statusPayload(server: ServerModel, acct: Acct, seq: number) {
  const active = server.active[acct];
  return {
    subjectPseudonym: `pseudo-${acct}`,
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
        lastActionAt: `2026-09-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
      },
    ],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function acctForBearer(bearer: string): Acct {
  const acct = bearer.split('-')[1];
  if (acct !== 'A' && acct !== 'B') {
    throw new Error(`Request carried an unknown bearer: ${bearer}`);
  }
  return acct;
}

// ─── World ───────────────────────────────────────────────────────────────────

interface Violation {
  step: number;
  action: string;
  invariant: string;
  detail: string;
}

interface AppStateSubscription {
  handler: (state: string) => void;
  removed: boolean;
}

class World {
  readonly server: ServerModel = {
    active: { A: false, B: false },
    validBearers: new Set(),
    bearerSeq: 0,
  };
  readonly requests: ScriptedRequest[] = [];
  readonly pending: ScriptedRequest[] = [];
  seq = 0;
  current: Acct | null = null;
  /** Requests with id < this belong to a previous process (kill + relaunch). */
  processBoundary = 0;
  /** A request for the signed-in account failed while it was signed in. */
  errorEligible = false;
  stack: string[] = ['Settings'];
  renderer: TestRenderer.ReactTestRenderer | null = null;
  readonly subscriptions: AppStateSubscription[] = [];
  outstandingRequestTimers = new Set<ReturnType<typeof setTimeout>>();
  readonly violations: Violation[] = [];
  step = 0;
  action = 'init';

  fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = (headers['Authorization'] ?? '').replace('Bearer ', '');
    const acct = acctForBearer(bearer);
    const route = input.replace(API_BASE_URL, '');
    let kind: RequestKind;
    if (method === 'GET' && route === '/v1/me/consent/status') {
      kind = 'status';
    } else if (method === 'POST' && route === '/v1/me/consent/grant') {
      kind = 'grant';
    } else if (method === 'POST' && route === '/v1/me/consent/withdraw') {
      kind = 'withdraw';
    } else {
      throw new Error(`Unexpected consent request ${method} ${route}`);
    }
    if (kind !== 'status') {
      const body = JSON.parse(String(init?.body)) as { scope?: unknown };
      if (body.scope !== 'model_training') {
        throw new Error(`Unexpected consent scope ${String(body.scope)}`);
      }
    }
    this.seq += 1;
    const id = this.seq;
    let httpStatus = 200;
    let payload: unknown;
    if (!this.server.validBearers.has(bearer)) {
      httpStatus = 401;
      payload = { error: 'unauthorized' };
    } else {
      if (kind === 'grant') this.server.active[acct] = true;
      if (kind === 'withdraw') this.server.active[acct] = false;
      payload = statusPayload(this.server, acct, id);
    }
    return new Promise<Response>((resolve, reject) => {
      const request: ScriptedRequest = {
        id,
        acct,
        kind,
        bearer,
        httpStatus,
        payload,
        settled: false,
        delivery: null,
        currentAtSettle: null,
        resolve,
        reject,
      };
      init?.signal?.addEventListener('abort', () => {
        this.settle(request, 'abort');
      });
      this.requests.push(request);
      this.pending.push(request);
    });
  };

  settle(request: ScriptedRequest, delivery: 'ok' | 'fail' | 'drop' | 'abort') {
    if (request.settled) return;
    request.settled = true;
    request.delivery = delivery;
    request.currentAtSettle = this.current === request.acct;
    const index = this.pending.indexOf(request);
    if (index !== -1) this.pending.splice(index, 1);
    switch (delivery) {
      case 'ok':
        request.resolve(jsonResponse(request.httpStatus, request.payload));
        break;
      case 'fail':
        request.resolve(jsonResponse(500, { error: 'internal' }));
        break;
      case 'drop':
        request.reject(new TypeError('Network request failed'));
        break;
      case 'abort':
        request.reject(abortError());
        break;
    }
    if (
      request.currentAtSettle &&
      (delivery !== 'ok' || request.httpStatus !== 200)
    ) {
      this.errorEligible = true;
    }
  }

  issueBearer(acct: Acct): string {
    this.server.bearerSeq += 1;
    const bearer = `bearer-${acct}-${this.server.bearerSeq}`;
    this.server.validBearers.add(bearer);
    return bearer;
  }

  /** The value the signed-in account should be looking at when `ready`. */
  expectedValue(acct: Acct): { id: number; active: boolean } | null {
    let best: ScriptedRequest | null = null;
    for (const request of this.requests) {
      if (
        request.acct === acct &&
        request.settled &&
        request.delivery === 'ok' &&
        request.httpStatus === 200 &&
        request.currentAtSettle &&
        request.id >= this.processBoundary &&
        (!best || request.id > best.id)
      ) {
        best = request;
      }
    }
    if (!best) return null;
    const payload = best.payload as {
      scopes: { scope: string; active: boolean }[];
    };
    const training = payload.scopes.find(s => s.scope === 'model_training');
    return { id: best.id, active: training?.active ?? false };
  }

  violate(invariant: string, detail: string) {
    this.violations.push({
      step: this.step,
      action: this.action,
      invariant,
      detail,
    });
  }
}

// ─── Navigator (real) with a Settings stand-in at the root ───────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

/**
 * Stand-in for the production SettingsScreen's consent row: same store reads,
 * same re-hydrate-on-session effect (SettingsScreen.tsx), so the store is
 * hydrated by two mounted consumers at once exactly as in the shipped stack.
 */
function SettingsStandIn() {
  const session = useAuthStore(s => s.session);
  const availability = useConsentStore(s => s.availability);
  const active = useConsentStore(s => s.modelTrainingActive);
  const hydrate = useConsentStore(s => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate, session]);
  const value =
    availability !== 'ready'
      ? 'Manage'
      : active
        ? 'Training: contributing'
        : 'Training: off';
  return (
    <View>
      <Text testID="settings-consent-row">{value}</Text>
    </View>
  );
}

function ConnectAccountStandIn() {
  return (
    <View>
      <Text>[ConnectAccount]</Text>
    </View>
  );
}

function Harness() {
  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator initialRouteName="Tabs">
        <Stack.Screen name="Tabs" component={SettingsStandIn} />
        <Stack.Screen
          name="ConsentSettings"
          component={ConsentSettingsScreen}
          options={{ title: 'Data & Consent' }}
        />
        <Stack.Screen name="ConnectAccount" component={ConnectAccountStandIn} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// ─── Tree queries ────────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' | ');
}

function switchPressable(renderer: Renderer) {
  const nodes = renderer.root.findAll(
    node =>
      node.props.accessibilityRole === 'switch' &&
      typeof node.props.onPress === 'function',
  );
  return nodes[0] ?? null;
}

function buttonLabeled(renderer: Renderer, label: string) {
  const nodes = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button',
  );
  return nodes[0] ?? null;
}

function consentScreenMounted(renderer: Renderer): boolean {
  return renderer.root.findAllByType(ConsentSettingsScreen).length > 0;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

type Action =
  | { kind: 'open' }
  | { kind: 'back' }
  | { kind: 'toggle' }
  | { kind: 'double_tap' }
  | { kind: 'try_again' }
  | { kind: 'connect_account' }
  | { kind: 'deliver'; pick: number }
  | { kind: 'deliver_fail'; pick: number }
  | { kind: 'deliver_drop'; pick: number }
  | { kind: 'rotate_token' }
  | { kind: 'revoke_bearer' }
  | { kind: 'server_revoke_consent'; acct: Acct }
  | { kind: 'sign_out' }
  | { kind: 'sign_in'; acct: Acct }
  | { kind: 'switch_account' }
  | { kind: 'background' }
  | { kind: 'foreground' }
  | { kind: 'kill_relaunch' }
  | { kind: 'rehydrate_twice' };

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'deliver':
    case 'deliver_fail':
    case 'deliver_drop':
      return `${action.kind}#${action.pick}`;
    case 'sign_in':
    case 'server_revoke_consent':
      return `${action.kind}:${action.acct}`;
    default:
      return action.kind;
  }
}

// Captured before any test can install fake timers: a macrotask hop drains
// every microtask chain the stores run after a response lands.
const realSetTimeout = globalThis.setTimeout;

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => realSetTimeout(resolve, 0));
  });
}

const INITIAL_CONSENT_STATE = {
  availability: 'loading' as const,
  modelTrainingActive: false,
  lastActionAt: null,
  busy: false,
  error: null,
};

class Runner {
  readonly world = new World();
  readonly executed: string[] = [];
  private readonly realFetch = globalThis.fetch;
  private readonly realSetTimeout = globalThis.setTimeout;
  private readonly realClearTimeout = globalThis.clearTimeout;
  private readonly appStateMock =
    AppState.addEventListener as unknown as jest.Mock;
  private readonly previousAppStateImpl =
    this.appStateMock.getMockImplementation();

  async setUp() {
    const { world } = this;
    globalThis.fetch = world.fetch as typeof globalThis.fetch;
    // Ledger of the consent client's own request timers, keyed by delay so
    // React / navigation timers stay out of the count.
    const patchedSetTimeout = ((
      handler: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === CONSENT_REQUEST_TIMEOUT_MS) {
        const id: ReturnType<typeof setTimeout> = this.realSetTimeout(() => {
          world.outstandingRequestTimers.delete(id);
          handler(...args);
        }, delay);
        world.outstandingRequestTimers.add(id);
        return id;
      }
      return this.realSetTimeout(handler, delay, ...args);
    }) as unknown as typeof setTimeout;
    globalThis.setTimeout = patchedSetTimeout;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      world.outstandingRequestTimers.delete(id);
      this.realClearTimeout(id);
    }) as unknown as typeof clearTimeout;
    this.appStateMock.mockImplementation(
      (type: string, handler: (state: string) => void) => {
        const subscription: AppStateSubscription = { handler, removed: false };
        if (type === 'change') world.subscriptions.push(subscription);
        return {
          remove: () => {
            subscription.removed = true;
          },
        };
      },
    );
    useConsentStore.setState(INITIAL_CONSENT_STATE);
    clearApiSession();
    useAuthStore.setState({ session: null });
    await this.mountTree();
  }

  async tearDown() {
    const { world } = this;
    // Whatever is still in flight lands now (the network always answers or
    // times out); then the tree goes away like a closed app.
    while (world.pending.length > 0) {
      world.settle(world.pending[0] as ScriptedRequest, 'ok');
      await flush();
    }
    await this.unmountTree();
    if (world.outstandingRequestTimers.size !== 0) {
      world.violate(
        'timers',
        `${world.outstandingRequestTimers.size} consent request timer(s) still armed after teardown`,
      );
    }
    const leaked = world.subscriptions.filter(s => !s.removed).length;
    if (leaked !== 0) {
      world.violate(
        'listeners',
        `${leaked} AppState subscription(s) not removed after unmount`,
      );
    }
    clearApiSession();
    useAuthStore.setState({ session: null });
    useConsentStore.setState(INITIAL_CONSENT_STATE);
    globalThis.fetch = this.realFetch;
    globalThis.setTimeout = this.realSetTimeout;
    globalThis.clearTimeout = this.realClearTimeout;
    this.appStateMock.mockImplementation(this.previousAppStateImpl);
  }

  private async mountTree() {
    await act(async () => {
      this.world.renderer = TestRenderer.create(<Harness />);
    });
    this.world.stack = ['Settings'];
    await flush();
  }

  private async unmountTree() {
    const { renderer } = this.world;
    if (!renderer) return;
    await act(async () => {
      renderer.unmount();
    });
    this.world.renderer = null;
    this.world.stack = [];
  }

  private renderer(): Renderer {
    const { renderer } = this.world;
    if (!renderer) throw new Error('tree is not mounted');
    return renderer;
  }

  private signIn(acct: Acct) {
    const { world } = this;
    const session: ApiSession = {
      apiBaseUrl: API_BASE_URL,
      bearerToken: world.issueBearer(acct),
      canonicalAppUserId: ACCOUNTS[acct].id,
      provider: 'google',
    };
    establishApiSession(session);
    useAuthStore.setState({ session: authSessionFor(acct) });
    world.current = acct;
    world.errorEligible = false;
  }

  private signOut() {
    clearApiSession();
    useAuthStore.setState({ session: null });
    this.world.current = null;
    this.world.errorEligible = false;
  }

  /** Whether the action can run in the current world; skipped otherwise. */
  applicable(action: Action): boolean {
    const { world } = this;
    const renderer = world.renderer;
    const top = world.stack[world.stack.length - 1];
    const consentOpen = world.stack.includes('ConsentSettings');
    switch (action.kind) {
      case 'open':
        return renderer !== null && !consentOpen;
      case 'back':
        return renderer !== null && world.stack.length > 1;
      case 'toggle': {
        if (!renderer || top !== 'ConsentSettings') return false;
        const node = switchPressable(renderer);
        return node !== null && !node.props.disabled;
      }
      case 'double_tap': {
        if (!renderer || top !== 'ConsentSettings') return false;
        const node = switchPressable(renderer);
        return node !== null && !node.props.disabled;
      }
      case 'try_again':
        return (
          renderer !== null &&
          top === 'ConsentSettings' &&
          buttonLabeled(renderer, 'Try again') !== null
        );
      case 'connect_account':
        return (
          renderer !== null &&
          top === 'ConsentSettings' &&
          buttonLabeled(renderer, 'Connect account') !== null
        );
      case 'deliver':
      case 'deliver_fail':
      case 'deliver_drop':
        return world.pending.length > 0;
      case 'rotate_token':
      case 'revoke_bearer':
      case 'sign_out':
      case 'switch_account':
        return world.current !== null;
      case 'sign_in':
        return world.current === null;
      case 'server_revoke_consent':
        return world.server.active[action.acct];
      case 'background':
      case 'foreground':
      case 'kill_relaunch':
      case 'rehydrate_twice':
        return true;
    }
  }

  async perform(action: Action) {
    const { world } = this;
    switch (action.kind) {
      case 'open':
        await act(async () => {
          navigationRef.navigate('ConsentSettings');
        });
        world.stack.push('ConsentSettings');
        break;
      case 'back':
        await act(async () => {
          navigationRef.goBack();
        });
        world.stack.pop();
        break;
      case 'toggle': {
        const node = switchPressable(this.renderer());
        if (!node) throw new Error('toggle: no switch');
        await act(async () => {
          node.props.onPress();
        });
        break;
      }
      case 'double_tap': {
        // Two taps land before the disabled re-render: the second reaches the
        // store's setModelTrainingConsent while the first is in flight.
        const toggle = this.renderer().root.findByType(BrandToggle);
        const before = world.requests.length;
        await act(async () => {
          toggle.props.onValueChange(!toggle.props.value);
          toggle.props.onValueChange(!toggle.props.value);
        });
        const issued = world.requests.length - before;
        if (issued !== 1) {
          world.violate(
            'double_tap',
            `two rapid taps on an enabled switch issued ${issued} request(s), expected exactly 1`,
          );
        }
        break;
      }
      case 'try_again': {
        const node = buttonLabeled(this.renderer(), 'Try again');
        if (!node) throw new Error('try_again: no button');
        await act(async () => {
          node.props.onPress();
        });
        break;
      }
      case 'connect_account': {
        const node = buttonLabeled(this.renderer(), 'Connect account');
        if (!node) throw new Error('connect_account: no button');
        await act(async () => {
          node.props.onPress();
        });
        world.stack.push('ConnectAccount');
        break;
      }
      case 'deliver':
      case 'deliver_fail':
      case 'deliver_drop': {
        const request = world.pending[
          action.pick % world.pending.length
        ] as ScriptedRequest;
        const delivery =
          action.kind === 'deliver'
            ? 'ok'
            : action.kind === 'deliver_fail'
              ? 'fail'
              : 'drop';
        await act(async () => {
          world.settle(request, delivery);
        });
        break;
      }
      case 'rotate_token': {
        const live = getApiSession();
        if (!live || !world.current) throw new Error('rotate: no session');
        await act(async () => {
          establishApiSession({
            ...live,
            bearerToken: world.issueBearer(world.current as Acct),
          });
        });
        break;
      }
      case 'revoke_bearer': {
        const live = getApiSession();
        if (!live) throw new Error('revoke: no session');
        world.server.validBearers.delete(live.bearerToken);
        break;
      }
      case 'server_revoke_consent':
        world.server.active[action.acct] = false;
        break;
      case 'sign_out':
        await act(async () => {
          this.signOut();
        });
        break;
      case 'sign_in':
        await act(async () => {
          this.signIn(action.acct);
        });
        break;
      case 'switch_account': {
        const next: Acct = world.current === 'A' ? 'B' : 'A';
        await act(async () => {
          this.signOut();
        });
        await flush();
        await act(async () => {
          this.signIn(next);
        });
        break;
      }
      case 'background':
      case 'foreground': {
        const state = action.kind === 'background' ? 'background' : 'active';
        await act(async () => {
          for (const subscription of world.subscriptions) {
            if (!subscription.removed) subscription.handler(state);
          }
        });
        break;
      }
      case 'kill_relaunch': {
        // The process dies: its tree goes, and every response still on the
        // wire is lost to it (delivered as aborted to the dying store, which
        // is then discarded). The relaunch restores the Keychain session with
        // a freshly rotated bearer and starts from an empty consent store.
        await this.unmountTree();
        while (world.pending.length > 0) {
          world.settle(world.pending[0] as ScriptedRequest, 'abort');
          await flush();
        }
        useConsentStore.setState(INITIAL_CONSENT_STATE);
        world.processBoundary = world.seq + 1;
        world.errorEligible = false;
        const live = getApiSession();
        if (live && world.current) {
          establishApiSession({
            ...live,
            bearerToken: world.issueBearer(world.current),
          });
        }
        await this.mountTree();
        break;
      }
      case 'rehydrate_twice':
        // Two consumers (or a StrictMode-style double effect) re-hydrate in
        // the same tick.
        await act(async () => {
          void useConsentStore.getState().hydrate();
          void useConsentStore.getState().hydrate();
        });
        break;
    }
    await flush();
  }

  checkInvariants() {
    const { world } = this;
    const state = useConsentStore.getState();
    const renderer = world.renderer;
    const current = world.current;
    const pendingForCurrent = current
      ? world.pending.filter(r => r.acct === current)
      : [];
    const pendingMutations = world.pending.filter(r => r.kind !== 'status');

    if (current === null) {
      if (
        state.availability !== 'signed_out' ||
        state.modelTrainingActive ||
        state.busy
      ) {
        world.violate(
          'signed_out',
          `no api session but store is ${state.availability}/active=${state.modelTrainingActive}/busy=${state.busy}`,
        );
      }
    } else {
      if (state.availability === 'signed_out') {
        world.violate(
          'never_signed_out_while_signed_in',
          `${current} is signed in but the store shows signed_out`,
        );
      }
      if (state.availability === 'ready') {
        const expected = world.expectedValue(current);
        if (!expected) {
          world.violate(
            'value',
            `ready for ${current} with active=${state.modelTrainingActive} but ${current} has received no response since signing in`,
          );
        } else if (expected.active !== state.modelTrainingActive) {
          world.violate(
            'value',
            `${current} shows active=${state.modelTrainingActive} but its newest applied response (#${expected.id}) says ${expected.active}`,
          );
        }
      }
      if (
        state.availability === 'loading' &&
        !pendingForCurrent.some(r => r.kind === 'status')
      ) {
        world.violate(
          'loading_has_request',
          `${current} is loading with no status request in flight`,
        );
      }
      if (state.busy && pendingMutations.length === 0) {
        world.violate('busy_has_request', 'busy with no mutation in flight');
      }
      if (
        state.busy &&
        state.availability === 'ready' &&
        pendingForCurrent.length === 0
      ) {
        world.violate(
          'busy_leak',
          `${current} has nothing in flight but the toggle is busy (in flight: ${pendingMutations
            .map(r => `${r.acct}#${r.id}`)
            .join(',')})`,
        );
      }
      if (state.error !== null && !world.errorEligible) {
        world.violate(
          'error_source',
          `${current} sees "${state.error}" without any failed request of its own`,
        );
      }
    }

    if (world.pending.length === 0) {
      if (state.busy || state.availability === 'loading') {
        world.violate(
          'quiescent',
          `nothing in flight but store is ${state.availability}/busy=${state.busy}`,
        );
      }
    }

    if (world.outstandingRequestTimers.size !== world.pending.length) {
      world.violate(
        'timers',
        `${world.outstandingRequestTimers.size} request timer(s) armed for ${world.pending.length} in-flight request(s)`,
      );
    }

    if (renderer && consentScreenMounted(renderer)) {
      const text = allText(renderer);
      const node = switchPressable(renderer);
      if (!node) {
        world.violate('render', 'consent screen mounted without its switch');
      } else {
        const checked = Boolean(node.props.accessibilityState?.checked);
        const disabled = Boolean(node.props.disabled);
        const expectedDisabled = state.busy || state.availability !== 'ready';
        if (checked !== state.modelTrainingActive) {
          world.violate(
            'render',
            `switch checked=${checked} but store active=${state.modelTrainingActive}`,
          );
        }
        if (disabled !== expectedDisabled) {
          world.violate(
            'render',
            `switch disabled=${disabled} but store busy=${state.busy}/${state.availability}`,
          );
        }
      }
      const expectCopy = (present: boolean, marker: string, why: string) => {
        if (text.includes(marker) !== present) {
          world.violate(
            'render',
            `"${marker}" ${present ? 'missing' : 'shown'} while ${why}`,
          );
        }
      };
      expectCopy(
        state.availability === 'signed_out',
        'Sign in to change this.',
        state.availability,
      );
      expectCopy(
        state.availability === 'loading',
        'Checking your current choice',
        state.availability,
      );
      expectCopy(
        state.availability === 'unavailable',
        'Try again',
        state.availability,
      );
      if (state.error !== null && state.availability === 'ready') {
        expectCopy(true, state.error, 'error is set');
      }
      if (state.error === null && state.availability === 'ready') {
        expectCopy(false, 'could not be saved', 'no error is set');
      }
    }
    if (renderer) {
      const rowText = renderer.root
        .findAll(
          n => n.type === Text && n.props.testID === 'settings-consent-row',
        )
        .map(n => String(n.props.children))
        .join('');
      const expectedRow =
        state.availability !== 'ready'
          ? 'Manage'
          : state.modelTrainingActive
            ? 'Training: contributing'
            : 'Training: off';
      if (rowText !== expectedRow) {
        world.violate(
          'render',
          `settings row shows "${rowText}" but store expects "${expectedRow}"`,
        );
      }
    }
  }

  draw(rng: Rng): Action {
    const candidates: { weight: number; value: Action }[] = [
      { weight: 3, value: { kind: 'open' } },
      { weight: 1.5, value: { kind: 'back' } },
      { weight: 5, value: { kind: 'toggle' } },
      { weight: 1.5, value: { kind: 'double_tap' } },
      { weight: 1.5, value: { kind: 'try_again' } },
      { weight: 0.5, value: { kind: 'connect_account' } },
      { weight: 5, value: { kind: 'deliver', pick: rng.int(8) } },
      { weight: 1, value: { kind: 'deliver_fail', pick: rng.int(8) } },
      { weight: 0.7, value: { kind: 'deliver_drop', pick: rng.int(8) } },
      { weight: 1, value: { kind: 'rotate_token' } },
      { weight: 0.5, value: { kind: 'revoke_bearer' } },
      {
        weight: 0.7,
        value: { kind: 'server_revoke_consent', acct: rng.pick(['A', 'B']) },
      },
      { weight: 1, value: { kind: 'sign_out' } },
      { weight: 2, value: { kind: 'sign_in', acct: rng.pick(['A', 'B']) } },
      { weight: 1, value: { kind: 'switch_account' } },
      { weight: 0.4, value: { kind: 'background' } },
      { weight: 0.4, value: { kind: 'foreground' } },
      { weight: 0.7, value: { kind: 'kill_relaunch' } },
      { weight: 0.7, value: { kind: 'rehydrate_twice' } },
    ];
    const applicable = candidates.filter(c => this.applicable(c.value));
    return rng.weighted(applicable);
  }

  async run(schedule: Action[] | { rng: Rng; steps: number }) {
    await this.setUp();
    try {
      this.world.step = 0;
      this.world.action = 'mount';
      this.checkInvariants();
      if (Array.isArray(schedule)) {
        for (const action of schedule) {
          if (!this.applicable(action)) continue;
          await this.execute(action);
        }
      } else {
        for (let i = 0; i < schedule.steps; i += 1) {
          await this.execute(this.draw(schedule.rng));
        }
      }
      this.world.action = 'drain';
      while (this.world.pending.length > 0) {
        const request = this.world.pending[0] as ScriptedRequest;
        await act(async () => {
          this.world.settle(request, 'ok');
        });
        await flush();
        this.world.step += 1;
        this.checkInvariants();
      }
    } finally {
      await this.tearDown();
    }
  }

  private async execute(action: Action) {
    this.world.step += 1;
    this.world.action = describeAction(action);
    this.executed.push(this.world.action);
    await this.perform(action);
    this.checkInvariants();
  }
}

// ─── Schedule (de)serialisation for replays ──────────────────────────────────

function parseAction(text: string): Action {
  const [kind, arg] = text.split(/[#:]/) as [string, string | undefined];
  switch (kind) {
    case 'deliver':
    case 'deliver_fail':
    case 'deliver_drop':
      return { kind, pick: Number(arg ?? 0) };
    case 'sign_in':
    case 'server_revoke_consent':
      return { kind, acct: arg === 'B' ? 'B' : 'A' };
    case 'open':
    case 'back':
    case 'toggle':
    case 'double_tap':
    case 'try_again':
    case 'connect_account':
    case 'rotate_token':
    case 'revoke_bearer':
    case 'sign_out':
    case 'switch_account':
    case 'background':
    case 'foreground':
    case 'kill_relaunch':
    case 'rehydrate_twice':
      return { kind };
    default:
      throw new Error(`Unknown action ${text}`);
  }
}

async function replay(schedule: string[]) {
  const runner = new Runner();
  await runner.run(schedule.map(parseAction));
  return runner;
}

/** Greedy one-step-at-a-time removal keeping the failure's invariant set. */
async function minimize(schedule: string[], invariants: Set<string>) {
  let current = schedule;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < current.length; i += 1) {
      const candidate = current.filter((_, index) => index !== i);
      const runner = await replay(candidate);
      const hit = runner.world.violations.some(v =>
        invariants.has(v.invariant),
      );
      if (hit) {
        current = candidate;
        changed = true;
        break;
      }
    }
  }
  return current;
}

// ─── Campaign ────────────────────────────────────────────────────────────────

interface IterationResult {
  seed: number;
  steps: number;
  schedule: string[];
  outcome: 'held' | 'broken';
  violations: Violation[];
  minimized?: string[];
}

const ITERATIONS = Number(process.env.STRESS_ITER ?? 120);
const MAX_STEPS = Number(process.env.STRESS_STEPS ?? 24);
const ONLY_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const OUT_FILE = process.env.STRESS_OUT ?? null;
/** Broken seeds whose schedules are minimized (greedy replay; slow). */
const MINIMIZE_SEEDS = Number(process.env.STRESS_MINIMIZE ?? 1);

const results: IterationResult[] = [];

afterAll(() => {
  if (!OUT_FILE) return;
  const broken = results.filter(r => r.outcome === 'broken');
  const table = {
    unit: 'scr-consentsettingsscreen',
    lens: 'lifecycle',
    iterations: results.length,
    stepsExecuted: results.reduce((sum, r) => sum + r.steps, 0),
    held: results.length - broken.length,
    broken: broken.length,
    brokenSeeds: broken.map(r => r.seed),
    results,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(table, null, 2));
});

describe('ConsentSettingsScreen lifecycle stress (seeded)', () => {
  const seeds =
    ONLY_SEED !== null
      ? [ONLY_SEED]
      : Array.from({ length: ITERATIONS }, (_, i) => i + 1);

  it(`holds its lifecycle invariants across ${seeds.length} seeded interruption schedules`, async () => {
    for (const seed of seeds) {
      const rng = new Rng(seed);
      const steps = 6 + rng.int(Math.max(1, MAX_STEPS - 5));
      const runner = new Runner();
      await runner.run({ rng, steps });
      const violations = runner.world.violations;
      results.push({
        seed,
        steps: runner.executed.length,
        schedule: runner.executed,
        outcome: violations.length === 0 ? 'held' : 'broken',
        violations,
      });
    }
    const broken = results.filter(r => r.outcome === 'broken');
    for (const result of broken.slice(0, MINIMIZE_SEEDS)) {
      result.minimized = await minimize(
        result.schedule,
        new Set(result.violations.map(v => v.invariant)),
      );
    }
    const report = broken
      .map(
        r =>
          `seed ${r.seed}: ${r.violations
            .map(
              v => `[step ${v.step} ${v.action}] ${v.invariant}: ${v.detail}`,
            )
            .join('; ')}\n  schedule: ${(r.minimized ?? r.schedule).join(' ')}`,
      )
      .join('\n');
    expect(report).toBe('');
  }, 600_000);
});

describe('ConsentSettingsScreen lifecycle: minimized replays', () => {
  // Minimized from campaign seeds 58, 73 and 82 (STRESS_ITER=120): two
  // status requests are in flight for the same account (the Settings row and
  // the consent screen each hydrate on mount — SettingsScreen.tsx and
  // ConsentSettingsScreen.tsx both run `hydrate()` on [hydrate, session]); the
  // newer one lands, the user grants consent and the grant is confirmed, then
  // the OLDER status response lands last and puts the toggle back to off while
  // the server ledger says granted.
  it('a slow first status response landing after a confirmed grant does not revert the toggle', async () => {
    const runner = await replay([
      'sign_in:A',
      'open',
      'deliver#1',
      'toggle',
      'deliver#1',
    ]);
    expect(runner.world.server.active.A).toBe(true);
    expect(runner.world.violations).toEqual([]);
  });
});

describe('ConsentSettingsScreen lifecycle: request timeout after unmount', () => {
  it('aborts a request that outlives CONSENT_REQUEST_TIMEOUT_MS after the screen is gone and leaves no timer', async () => {
    jest.useFakeTimers();
    const runner = new Runner();
    try {
      await runner.setUp();
      await act(async () => {
        establishApiSession({
          apiBaseUrl: API_BASE_URL,
          bearerToken: runner.world.issueBearer('A'),
          canonicalAppUserId: ACCOUNTS.A.id,
          provider: 'google',
        });
        useAuthStore.setState({ session: authSessionFor('A') });
        runner.world.current = 'A';
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(runner.world.pending.length).toBeGreaterThan(0);
      await act(async () => {
        navigationRef.navigate('ConsentSettings');
      });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        navigationRef.goBack();
      });
      await act(async () => {
        await Promise.resolve();
      });
      const inFlight = runner.world.pending.length;
      expect(runner.world.outstandingRequestTimers.size).toBe(inFlight);
      await act(async () => {
        jest.advanceTimersByTime(CONSENT_REQUEST_TIMEOUT_MS + 1);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(runner.world.pending).toHaveLength(0);
      expect(runner.world.requests.every(r => r.delivery === 'abort')).toBe(
        true,
      );
      expect(runner.world.outstandingRequestTimers.size).toBe(0);
      const state = useConsentStore.getState();
      expect(state.busy).toBe(false);
      expect(state.availability).toBe('unavailable');
    } finally {
      await runner.tearDown();
      jest.useRealTimers();
    }
  });
});
