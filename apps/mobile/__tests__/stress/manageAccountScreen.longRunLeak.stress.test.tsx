/**
 * STRESS HARNESS — `scr-manageaccountscreen`, lens `long-run-leak`.
 *
 * Mounts the REAL `ManageAccountScreen` inside the REAL React Navigation
 * container + native-stack navigator, with the real zustand auth/api-session
 * stores, real deletion client (`src/account/deletion.ts`) and real design
 * components. Only native surfaces are replaced: SQLite (`getDb` throws, as
 * every other suite does), react-native-safe-area-context (the library's own
 * jest mock), `fetch` (scripted per seed) and `Linking.openURL` (the RN jest
 * preset's mock returns `undefined`; the real one returns a Promise).
 *
 * Every iteration is a SEEDED random walk over the screen (mulberry32):
 * enter directly or via a pushed route, open the deletion dialog, answer /
 * skip the survey, type, focus the comment field, request, tick the
 * countdown, confirm, hit every server outcome (ok / 401 / 400 / 429 / 5xx /
 * network throw / invalid JSON / never-resolving + 15s abort), cancel from
 * every phase, pop the route, unmount mid-request, and resolve requests AFTER
 * unmount (stale continuation). The walk is a pure function of the seed and
 * the rendered tree, so `STRESS_REPLAY=<seed>` replays one iteration exactly.
 *
 * Per iteration the harness asserts the unit returned to baseline:
 *   - jest fake-timer count is 0 after unmount + a 300ms flush (RN's own
 *     LayoutAnimation completion race is 237ms, the scroll-into-view timer
 *     80ms), i.e. the countdown interval and the fetch abort timer were
 *     cleared; STRESS_DEBUG_TIMERS=1 attributes any survivor to its caller;
 *   - every RN emitter subscription opened during the iteration was removed
 *     (AppState, Keyboard, Dimensions, AccessibilityInfo, Linking,
 *     BackHandler, DeviceEventEmitter);
 *   - no console.error was emitted (React act/key/unmounted-update warnings
 *     and unhandled navigation actions surface here).
 * Every `STRESS_SAMPLE_EVERY` (50) iterations, after `gc()`:
 *   - heapUsed / external / arrayBuffers, Node active handles and resources;
 *   - how many of the WeakRef'd screen/dialog fibers from ALL previous
 *     iterations are still reachable (a retained fiber = a leaked setState /
 *     useSyncExternalStore subscription / listener closure);
 *   - native Animated nodes still registered (createAnimatedNode without a
 *     matching dropAnimatedNode, read off the RN preset's mock);
 *   - render + walk wall time (process.hrtime, never faked) for drift.
 * Campaign-level assertions: linear heap slope ≤ 5% of baseline per 100
 * iterations, no retained fibers from earlier windows, native Animated
 * growth ≤ the known per-scene framework residue, and last-window median
 * render time ≤ 2× first-window median.
 *
 * Suite default is a fast smoke (STRESS_ITER=12). The real campaign:
 *   cd apps/mobile && STRESS_ITER=500 STRESS_OUT=/tmp/stress-ma \
 *     NODE_OPTIONS=--expose-gc npx jest --ci --runInBand \
 *     __tests__/stress/manageAccountScreen.longRunLeak.stress.test.tsx
 * Replay one seed:  STRESS_REPLAY=20260904203 ... (same command)
 * Knobs: STRESS_SEED (base seed, default 20260904000), STRESS_SAMPLE_EVERY,
 * STRESS_OUT (directory; writes campaign.json + seeds.json + heap.csv),
 * STRESS_DEBUG_TIMERS=1 / STRESS_DEBUG_ANIMATED=1 (creation stacks of
 * surviving timers / Animated nodes), STRESS_KEEP_MOCK_CALLS=1.
 *
 * Known failing class (campaign 2026-09-04, 22/500 seeds, deterministic,
 * minimized in manageAccountScreen.staleRequestTimer.stress.test.tsx): a
 * deletion request that resolves OK after the screen unmounted still starts
 * the 1s countdown interval (ManageAccountScreen.tsx beginRequest), because
 * `presentationRef` is only bumped when `visible` flips, not on unmount.
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccessibilityInfo,
  AppState,
  BackHandler,
  DeviceEventEmitter,
  Dimensions,
  Keyboard,
  Linking,
  NativeModules,
  Pressable,
  Text,
  TextInput,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { NavigationContainer } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('sqlite unavailable in the stress harness');
  },
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';

// ─── Knobs ───────────────────────────────────────────────────────────────────

const ITERATIONS = Number(process.env.STRESS_ITER ?? 12);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260904000);
const SAMPLE_EVERY = Number(process.env.STRESS_SAMPLE_EVERY ?? 50);
const REPLAY = (process.env.STRESS_REPLAY ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
const OUT_DIR = process.env.STRESS_OUT ?? null;
const WARMUP = 3;
/** jest.fn() mocks record every call's arguments forever; the RN preset's
 * NativeAnimatedModule mock alone retains ~1.4 MB per iteration of node
 * configs and getValue callbacks (measured: 97 MB → 811 MB over 500
 * iterations, flat with clearing). That is mock bookkeeping, not the unit, so
 * recorded calls are cleared after every iteration unless
 * STRESS_KEEP_MOCK_CALLS=1 (useful to reproduce the artifact). */
const KEEP_MOCK_CALLS = process.env.STRESS_KEEP_MOCK_CALLS === '1';
const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
const RENDER_DRIFT_LIMIT = 2;
/** Native Animated nodes that every native-stack scene leaves behind after
 * unmount, none of them owned by ManageAccountScreen: react-native-screens
 * `Screen` (closing/progress/goingForward → onTransitionProgress
 * Animated.event) and @react-navigation/native-stack `NativeStackView`
 * (rawAnimatedHeaderHeight → onHeaderHeightChange Animated.event).
 * `AnimatedEvent.__detach` removes the event but never drops the value nodes
 * it made native. Measured: exactly 4 per scene, 0 extra from the dialog,
 * survey, request or countdown paths. Anything above this is the unit's. */
const FRAMEWORK_NATIVE_ANIMATED_NODES_PER_SCENE = 4;
/** Longest legitimate one-shot timer the unit leaves behind on unmount: RN's
 * own LayoutAnimation.configureNext completion race (duration 220ms + 17ms)
 * and the 80ms scroll-into-view; anything still pending after this is a
 * leak (the countdown interval, an un-cleared fetch abort timer). */
const POST_UNMOUNT_FLUSH_MS = 300;

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

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
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const API_BASE = 'https://stress.invalid/functions/v1/api';
const OWNER = '22222222-2222-4222-8222-222222222222';

type SessionKind = 'google' | 'apple' | 'guest';

function sessionFor(kind: SessionKind): AuthSession {
  if (kind === 'guest') {
    return {
      provider: 'guest',
      subject: 'local-only',
      canonicalAppUserId: null,
      localOnly: true,
      displayName: null,
      email: null,
    };
  }
  return {
    provider: kind,
    subject: `${kind}-subject`,
    canonicalAppUserId: OWNER,
    localOnly: false,
    displayName: kind === 'google' ? 'Alex Chen' : 'Sam Rivera',
    email: kind === 'google' ? 'alex@example.com' : null,
  };
}

// ─── Scripted network: every call parks until the walk decides its fate ──────

type ServerOutcome =
  | 'ok'
  | 'http401'
  | 'http400'
  | 'http429'
  | 'http503'
  | 'invalid_json'
  | 'invalid_shape'
  | 'network_throw';
const SERVER_OUTCOMES: readonly ServerOutcome[] = [
  'ok',
  'ok',
  'ok',
  'http401',
  'http400',
  'http429',
  'http503',
  'invalid_json',
  'invalid_shape',
  'network_throw',
];
const APPLE_REVOCATIONS = [
  'revoked',
  'not_applicable',
  'manual_action_required',
  'legacy-unknown',
] as const;

interface ParkedRequest {
  id: number;
  url: string;
  settle: (outcome: ServerOutcome, revocation: string) => void;
  settled: boolean;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

class ScriptedNetwork {
  parked: ParkedRequest[] = [];
  calls = 0;
  private nextId = 1;
  readonly fetch = (input: unknown, init?: RequestInit): Promise<Response> => {
    this.calls += 1;
    const url = String(input);
    const id = this.nextId++;
    return new Promise<Response>((resolve, reject) => {
      const entry: ParkedRequest = {
        id,
        url,
        settled: false,
        settle: (outcome, revocation) => {
          if (entry.settled) return;
          entry.settled = true;
          init?.signal?.removeEventListener('abort', onAbort);
          if (outcome === 'network_throw') {
            reject(new TypeError('Network request failed'));
            return;
          }
          if (outcome === 'http401') {
            resolve(jsonResponse(401, { error: { message: 'expired' } }));
            return;
          }
          if (outcome === 'http400') {
            resolve(
              jsonResponse(400, {
                error: { message: 'No deletion request is open.' },
              }),
            );
            return;
          }
          if (outcome === 'http429') {
            resolve(jsonResponse(429, { error: { message: 'Slow down.' } }));
            return;
          }
          if (outcome === 'http503') {
            resolve(jsonResponse(503, 'not-an-object'));
            return;
          }
          if (outcome === 'invalid_json') {
            resolve({
              ok: true,
              status: 200,
              json: () => Promise.reject(new SyntaxError('not json')),
            } as unknown as Response);
            return;
          }
          const isRequest = url.endsWith('/v1/me/delete-request');
          if (outcome === 'invalid_shape') {
            resolve(
              jsonResponse(
                200,
                isRequest ? { challenge: 42 } : { deleted: 'yes' },
              ),
            );
            return;
          }
          resolve(
            jsonResponse(
              200,
              isRequest
                ? {
                    challenge: `challenge-${id}`,
                    expiresAt: '2026-09-04T00:10:00.000Z',
                  }
                : { deleted: true, appleAuthorizationRevocation: revocation },
            ),
          );
        },
      };
      const onAbort = () => {
        if (entry.settled) return;
        entry.settled = true;
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      };
      init?.signal?.addEventListener('abort', onAbort);
      this.parked.push(entry);
    });
  };
  pending(): ParkedRequest[] {
    return this.parked.filter(p => !p.settled);
  }
}

// ─── Ledgers: RN emitter subscriptions ───────────────────────────────────────

type Emitter = { addEventListener?: unknown; addListener?: unknown };

const EMITTERS: ReadonlyArray<
  [string, Emitter, 'addEventListener' | 'addListener']
> = [
  ['AppState', AppState as unknown as Emitter, 'addEventListener'],
  ['Keyboard', Keyboard as unknown as Emitter, 'addListener'],
  ['Dimensions', Dimensions as unknown as Emitter, 'addEventListener'],
  [
    'AccessibilityInfo',
    AccessibilityInfo as unknown as Emitter,
    'addEventListener',
  ],
  ['Linking', Linking as unknown as Emitter, 'addEventListener'],
  ['BackHandler', BackHandler as unknown as Emitter, 'addEventListener'],
  [
    'DeviceEventEmitter',
    DeviceEventEmitter as unknown as Emitter,
    'addListener',
  ],
];

class ListenerLedger {
  readonly live = new Map<string, number>();
  readonly opened = new Map<string, number>();
  private restore: Array<() => void> = [];
  install() {
    for (const [name, emitter, method] of EMITTERS) {
      const target = emitter as Record<string, unknown>;
      const original = target[method];
      if (typeof original !== 'function') continue;
      this.live.set(name, 0);
      this.opened.set(name, 0);
      const { live, opened } = this;
      target[method] = function wrapped(this: unknown, ...args: unknown[]) {
        const sub = (original as (...a: unknown[]) => unknown).apply(
          this,
          args,
        );
        live.set(name, (live.get(name) ?? 0) + 1);
        opened.set(name, (opened.get(name) ?? 0) + 1);
        let removed = false;
        const release = () => {
          if (removed) return;
          removed = true;
          live.set(name, (live.get(name) ?? 0) - 1);
        };
        if (sub && typeof sub === 'object') {
          const s = sub as { remove?: () => void };
          const originalRemove = s.remove;
          s.remove = function remove(this: unknown) {
            release();
            return typeof originalRemove === 'function'
              ? originalRemove.call(this)
              : undefined;
          };
          return s;
        }
        if (typeof sub === 'function') {
          return (...a: unknown[]) => {
            release();
            return (sub as (...x: unknown[]) => unknown)(...a);
          };
        }
        return sub;
      };
      this.restore.push(() => {
        target[method] = original;
      });
    }
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.live);
  }
  uninstall() {
    this.restore.forEach(r => r());
    this.restore = [];
  }
}

// ─── Native Animated node ledger ─────────────────────────────────────────────
// The RN jest preset mocks NativeAnimatedModule with jest.fn()s; the real
// module keeps every created node in NativeAnimatedNodesManager until
// `dropAnimatedNode`, so a node created by a mount and never dropped after
// unmount is a native-side leak. Read from `mock.calls` once per iteration,
// before the calls are cleared.

interface NativeAnimatedMock {
  createAnimatedNode: jest.Mock;
  dropAnimatedNode: jest.Mock;
  connectAnimatedNodeToView: jest.Mock;
  disconnectAnimatedNodeFromView: jest.Mock;
  startAnimatingNode: jest.Mock;
}

class NativeAnimatedLedger {
  readonly live = new Map<number, string>();
  /** tag → creation stack, only when STRESS_DEBUG_ANIMATED=1 */
  readonly origins = new Map<number, string>();
  created = 0;
  dropped = 0;
  connectedToView = 0;
  disconnectedFromView = 0;
  animationsStarted = 0;
  private readonly mock: NativeAnimatedMock | null;
  constructor() {
    const mod = (NativeModules as Record<string, unknown>).NativeAnimatedModule;
    this.mock =
      mod && jest.isMockFunction((mod as NativeAnimatedMock).createAnimatedNode)
        ? (mod as NativeAnimatedMock)
        : null;
    if (this.mock && process.env.STRESS_DEBUG_ANIMATED === '1') {
      this.mock.createAnimatedNode.mockImplementation(
        (tag: number, config: unknown) => {
          this.origins.set(
            tag,
            JSON.stringify(config) +
              ' <- ' +
              (new Error().stack ?? '')
                .split('\n')
                .slice(2)
                .filter(
                  l =>
                    !/NativeAnimatedHelper|node_modules\/jest|processTicksAndRejections/.test(
                      l,
                    ),
                )
                .slice(0, 14)
                .map(l => l.trim())
                .join(' <- '),
          );
        },
      );
    }
  }
  originHistogram(): Array<[string, number]> {
    const out = new Map<string, number>();
    for (const tag of this.live.keys()) {
      const o = this.origins.get(tag) ?? '(no origin recorded)';
      out.set(o, (out.get(o) ?? 0) + 1);
    }
    return [...out.entries()].sort((a, b) => b[1] - a[1]);
  }
  get available(): boolean {
    return this.mock !== null;
  }
  /** Fold the calls recorded since the last drain into the ledger. */
  drain() {
    if (!this.mock) return;
    for (const [tag, config] of this.mock.createAnimatedNode.mock
      .calls as Array<[number, { type?: string }]>) {
      this.created += 1;
      this.live.set(tag, config?.type ?? 'unknown');
    }
    for (const [tag] of this.mock.dropAnimatedNode.mock.calls as Array<
      [number]
    >) {
      this.dropped += 1;
      this.live.delete(tag);
      this.origins.delete(tag);
    }
    this.connectedToView +=
      this.mock.connectAnimatedNodeToView.mock.calls.length;
    this.disconnectedFromView +=
      this.mock.disconnectAnimatedNodeFromView.mock.calls.length;
    this.animationsStarted += this.mock.startAnimatingNode.mock.calls.length;
    this.mock.createAnimatedNode.mockClear();
    this.mock.dropAnimatedNode.mockClear();
    this.mock.connectAnimatedNodeToView.mockClear();
    this.mock.disconnectAnimatedNodeFromView.mockClear();
    this.mock.startAnimatingNode.mockClear();
  }
  histogram(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const type of this.live.values()) out[type] = (out[type] ?? 0) + 1;
    return out;
  }
}

// ─── Timer provenance (STRESS_DEBUG_TIMERS=1): who scheduled what is pending ─

class TimerProvenance {
  readonly live = new Map<unknown, string>();
  private restore: Array<() => void> = [];
  install() {
    const g = globalThis as unknown as Record<string, unknown>;
    for (const name of ['setTimeout', 'setInterval']) {
      const original = g[name] as (...a: unknown[]) => unknown;
      const clearName =
        name === 'setTimeout' ? 'clearTimeout' : 'clearInterval';
      const originalClear = g[clearName] as (id: unknown) => unknown;
      const live = this.live;
      g[name] = (fn: (...a: unknown[]) => unknown, ...rest: unknown[]) => {
        const stack = (new Error().stack ?? '')
          .split('\n')
          .slice(2, 9)
          .map(l => l.trim())
          .join(' <- ');
        const handle: { id: unknown } = { id: undefined };
        const wrapped = (...a: unknown[]) => {
          if (name === 'setTimeout') live.delete(handle.id);
          return fn(...a);
        };
        handle.id = original(wrapped, ...rest);
        live.set(handle.id, `${name}(${String(rest[0])}) ${stack}`);
        return handle.id;
      };
      g[clearName] = (id: unknown) => {
        live.delete(id);
        return originalClear(id);
      };
      this.restore.push(() => {
        g[name] = original;
        g[clearName] = originalClear;
      });
    }
  }
  pendingDescriptions(): string[] {
    return [...this.live.values()];
  }
  uninstall() {
    this.restore.forEach(r => r());
    this.restore = [];
  }
}

const DEBUG_TIMERS = process.env.STRESS_DEBUG_TIMERS === '1';

// ─── Test-renderer helpers ───────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;
type Fiber = { alternate: Fiber | null };
type FiberCarrier = { _fiber?: Fiber };

function pressables(renderer: Renderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function' &&
      node.props.disabled !== true,
  );
}

function buttons(renderer: Renderer, label: string) {
  return renderer.root
    .findAllByType(Button)
    .filter(
      node =>
        String(node.props.label).startsWith(label) &&
        node.props.disabled !== true,
    );
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' | ');
}

function radios(renderer: Renderer) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityRole === 'radio' &&
      typeof node.props.onPress === 'function' &&
      typeof node.props.accessibilityLabel === 'string',
  );
}

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

function fiberOf(node: TestRenderer.ReactTestInstance): Fiber | null {
  return (node as unknown as FiberCarrier)._fiber ?? null;
}

// ─── Navigator under test ────────────────────────────────────────────────────

type StressStackParams = {
  Launcher: undefined;
  ManageAccount: undefined;
};
const Stack = createNativeStackNavigator<StressStackParams>();

function Launcher(
  props: NativeStackScreenProps<StressStackParams, 'Launcher'>,
) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open manage account"
      onPress={() => props.navigation.navigate('ManageAccount')}
    >
      <Text>launcher</Text>
    </Pressable>
  );
}

// ─── One iteration ───────────────────────────────────────────────────────────

type Phase =
  | 'closed'
  | 'why'
  | 'kept'
  | 'review'
  | 'requesting'
  | 'armed'
  | 'armed0'
  | 'deleting'
  | 'popped'
  | 'deleted';

interface IterationResult {
  seed: number;
  session: SessionKind;
  entry: 'direct' | 'navigate';
  steps: string[];
  finalPhase: Phase;
  fetchCalls: number;
  settledAfterUnmount: number;
  timersBeforeFlush: number;
  timersAfterFlush: number;
  listenerDelta: Record<string, number>;
  nativeAnimatedLiveAfter: number;
  consoleErrors: string[];
  renderMs: number;
  walkMs: number;
  totalMs: number;
  outcome: 'HELD' | 'BROKEN';
  failure: string | null;
}

interface Sample {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  rss: number;
  activeHandles: number;
  activeResources: Record<string, number>;
  fakeTimers: number;
  listeners: Record<string, number>;
  retainedFibers: number;
  trackedFibers: number;
  nativeAnimatedLive: number;
  nativeAnimatedLiveByType: Record<string, number>;
  medianRenderMsWindow: number;
  medianWalkMsWindow: number;
}

interface Harness {
  ledger: ListenerLedger;
  timers: TimerProvenance | null;
  nativeAnimated: NativeAnimatedLedger;
  baselineListeners: Record<string, number>;
  fiberRefs: Array<{ iteration: number; ref: WeakRef<Fiber> }>;
  consoleErrors: string[];
}

function hrtimeMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function currentPhase(renderer: Renderer, popped: boolean): Phase {
  if (popped) return 'popped';
  const text = allText(renderer);
  if (!text.includes('Manage account')) return 'popped';
  if (text.includes("What's making you leave?")) return 'why';
  if (text.includes('What would have kept you?')) return 'kept';
  if (text.includes('Requesting…')) return 'requesting';
  if (text.includes('Deleting…')) return 'deleting';
  if (text.includes('Permanently delete (')) return 'armed';
  if (text.includes('Permanently delete')) return 'armed0';
  if (text.includes('Delete your account?')) return 'review';
  if (text.includes('LOCAL') && !text.includes('Delete account')) {
    return useAuthStore.getState().session === null ? 'deleted' : 'closed';
  }
  return 'closed';
}

async function runIteration(
  seed: number,
  harness: Harness,
  network: ScriptedNetwork,
): Promise<IterationResult> {
  const rng = new Rng(seed);
  const session: SessionKind = rng.pick([
    'google',
    'google',
    'apple',
    'apple',
    'guest',
  ]);
  const entry: 'direct' | 'navigate' = rng.chance(0.5) ? 'direct' : 'navigate';
  const steps: string[] = [];
  const iterationStart = process.hrtime.bigint();
  const errorsBefore = harness.consoleErrors.length;

  useAuthStore.setState({
    hydrated: true,
    session: sessionFor(session),
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  if (session !== 'guest') {
    establishApiSession({
      apiBaseUrl: API_BASE,
      bearerToken: 'stress-bearer',
      canonicalAppUserId: OWNER,
      provider: session,
    });
  } else {
    clearApiSession();
  }
  (Linking.openURL as jest.Mock).mockImplementation(() =>
    rng.chance(0.7) ? Promise.resolve() : Promise.reject(new Error('no store')),
  );

  // Mount (measured): container + stack + screen, plus the push when the
  // walk enters through the launcher route.
  const renderStart = process.hrtime.bigint();
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <NavigationContainer>
        <Stack.Navigator
          initialRouteName={entry === 'direct' ? 'ManageAccount' : 'Launcher'}
        >
          <Stack.Screen name="Launcher" component={Launcher} />
          <Stack.Screen name="ManageAccount" component={ManageAccountScreen} />
        </Stack.Navigator>
      </NavigationContainer>,
    );
  });
  if (entry === 'navigate') {
    const open = pressables(renderer, 'Open manage account')[0];
    if (!open) throw new Error('launcher button missing');
    await act(async () => {
      open.props.onPress();
    });
    await flush();
  }
  const renderMs = hrtimeMs(renderStart);
  steps.push(`mount:${entry}:${session}`);

  const screenNode = renderer.root.findAllByType(ManageAccountScreen)[0];
  if (!screenNode) throw new Error('ManageAccountScreen not mounted');
  const screenFiber = fiberOf(screenNode);
  if (screenFiber) {
    harness.fiberRefs.push({ iteration: seed, ref: new WeakRef(screenFiber) });
  }
  let dialogTracked = false;

  const walkStart = process.hrtime.bigint();
  let popped = false;
  let unmounted = false;
  const maxSteps = 4 + rng.int(20);
  let failure: string | null = null;
  const fetchCallsBefore = network.calls;

  const settleOne = async () => {
    const pending = network.pending();
    const target = rng.chance(0.8) ? pending[0] : pending[pending.length - 1];
    if (!target) return;
    const outcome = rng.pick(SERVER_OUTCOMES);
    const revocation = rng.pick(APPLE_REVOCATIONS);
    steps.push(`settle:${outcome}${outcome === 'ok' ? `/${revocation}` : ''}`);
    await act(async () => {
      target.settle(outcome, revocation);
      await new Promise<void>(resolve => setImmediate(resolve));
    });
    await flush();
  };

  type Action = { label: string; weight: number; run: () => Promise<void> };

  try {
    for (let step = 0; step < maxSteps && !unmounted; step += 1) {
      const phase = currentPhase(renderer, popped);
      const actions: Action[] = [];
      const add = (label: string, weight: number, run: () => Promise<void>) =>
        actions.push({ label, weight, run });
      const press = (
        label: string,
        weight: number,
        node: TestRenderer.ReactTestInstance | undefined,
      ) => {
        if (!node) return;
        add(label, weight, async () => {
          await act(async () => {
            node.props.onPress();
          });
          await flush();
        });
      };
      const popRoute = (label: string, weight: number) => {
        if (entry !== 'navigate' || popped) return;
        add(label, weight, async () => {
          // The screen header may sit under the modal; drive it directly, as
          // the OS back gesture would pop the route.
          await act(async () => {
            renderer.root
              .findAllByType(ManageAccountScreen)[0]
              ?.findAllByProps({ accessibilityLabel: 'Back' })
              .find(n => typeof n.props.onPress === 'function')
              ?.props.onPress();
          });
          await flush();
          popped = true;
        });
      };
      const inDialog =
        phase !== 'closed' && phase !== 'popped' && phase !== 'deleted';

      if (phase === 'popped' || phase === 'deleted') {
        add('unmount', 1, async () => {});
      }
      if (phase === 'closed') {
        const del = pressables(renderer, 'Delete account')[0];
        press('open-dialog', 12, del);
        popRoute('pop-route', del ? 2 : 3);
        add('unmount', del ? 1 : 3, async () => {});
      }
      if (phase === 'why' || phase === 'kept') {
        const rows = radios(renderer);
        const row = rows[rng.int(Math.max(rows.length, 1))];
        press(`radio:${String(row?.props.accessibilityLabel)}`, 5, row);
        press('Skip the survey', 3, pressables(renderer, 'Skip the survey')[0]);
        press(
          'Skip this question',
          3,
          pressables(renderer, 'Skip this question')[0],
        );
        press('button:Next', 8, buttons(renderer, 'Next')[0]);
        press('button:Continue', 8, buttons(renderer, 'Continue')[0]);
        press(
          'back-question',
          2,
          pressables(renderer, 'Back to the previous question')[0],
        );
        if (phase === 'kept') {
          const input = renderer.root.findAllByType(TextInput)[0];
          if (input) {
            add('type', 5, async () => {
              const len = rng.int(560);
              const chars = 'ab cde\nfgh ij klmn opq rst uvw xyz ÅÖ 🙂 ';
              let text = '';
              for (let i = 0; i < len; i += 1) text += rng.pick([...chars]);
              steps.push(`type:len=${text.length}`);
              await act(async () => {
                input.props.onChangeText(text);
              });
              await flush();
            });
            add('focus', 3, async () => {
              await act(async () => {
                input.props.onFocus();
              });
              await advance(rng.chance(0.5) ? 100 : 10);
            });
          }
        }
      }
      if (inDialog && phase !== 'requesting' && phase !== 'deleting') {
        for (const label of [
          'Close and keep my account',
          'Close account deletion confirmation',
          'Cancel account deletion',
        ]) {
          press(`cancel:${label}`, 1, pressables(renderer, label)[0]);
        }
        press(
          'button:Keep my account',
          1,
          buttons(renderer, 'Keep my account')[0],
        );
        popRoute('pop-route-in-dialog', 1);
      }
      if (phase === 'review') {
        press(
          'button:Continue to delete',
          10,
          buttons(renderer, 'Continue to delete')[0],
        );
        press(
          'manage-subscription',
          1,
          pressables(renderer, 'Manage subscription in the App Store')[0],
        );
      }
      if (phase === 'armed') {
        add('tick-1s', 4, async () => advance(1000));
        add('tick-5s', 6, async () => advance(5000));
      }
      if (phase === 'armed0') {
        press(
          'button:Permanently delete',
          8,
          buttons(renderer, 'Permanently delete')[0],
        );
      }
      if (phase === 'requesting' || phase === 'deleting') {
        add('settle', 10, settleOne);
        add('abort-15s', 2, async () => advance(15_000));
        popRoute('pop-route-while-busy', 2);
        add('unmount-while-busy', 2, async () => {});
      }
      if (inDialog) {
        add('unmount-in-dialog', 1, async () => {});
      }
      if (!dialogTracked && inDialog) {
        const scrim = renderer.root.findAll(
          node => node.props.accessibilityLabel === 'Cancel account deletion',
        )[0];
        const f = scrim ? fiberOf(scrim) : null;
        if (f) {
          harness.fiberRefs.push({ iteration: seed, ref: new WeakRef(f) });
          dialogTracked = true;
        }
      }

      if (actions.length === 0) {
        failure = `no actions available in phase ${phase}: ${allText(renderer).slice(0, 200)}`;
        break;
      }
      const total = actions.reduce((sum, a) => sum + a.weight, 0);
      let roll = rng.float() * total;
      let chosen = actions[actions.length - 1]!;
      for (const action of actions) {
        roll -= action.weight;
        if (roll < 0) {
          chosen = action;
          break;
        }
      }
      if (chosen.label.startsWith('unmount')) {
        steps.push(`${chosen.label}@${phase}`);
        unmounted = true;
        break;
      }
      if (chosen.label !== 'settle' && chosen.label !== 'type') {
        steps.push(`${chosen.label}@${phase}`);
      }
      await chosen.run();
    }
  } catch (e) {
    failure = `walk threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
  }
  const finalPhase = currentPhase(renderer, popped);
  const walkMs = hrtimeMs(walkStart);

  // Unmount the WHOLE tree (container + navigator + screen), then let any
  // parked request settle AFTER unmount — a stale continuation must be inert.
  await act(async () => {
    renderer.unmount();
  });
  await flush();
  const timersBeforeFlush = jest.getTimerCount();
  let settledAfterUnmount = 0;
  for (const req of network.pending()) {
    settledAfterUnmount += 1;
    const outcome = rng.pick(SERVER_OUTCOMES);
    steps.push(`settle-after-unmount:${outcome}`);
    await act(async () => {
      req.settle(outcome, rng.pick(APPLE_REVOCATIONS));
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }
  await advance(POST_UNMOUNT_FLUSH_MS);
  await flush();
  const timersAfterFlush = jest.getTimerCount();
  const pendingTimerOrigins = harness.timers?.pendingDescriptions() ?? [];
  if (timersAfterFlush !== 0) {
    // Drain so a leaked timer from one seed cannot poison the next.
    jest.clearAllTimers();
    harness.timers?.live.clear();
  }
  const listenerDelta: Record<string, number> = {};
  for (const [name, live] of Object.entries(harness.ledger.snapshot())) {
    const delta = live - (harness.baselineListeners[name] ?? 0);
    if (delta !== 0) listenerDelta[name] = delta;
  }
  const consoleErrors = harness.consoleErrors.slice(errorsBefore);
  harness.nativeAnimated.drain();
  const nativeAnimatedLiveAfter = harness.nativeAnimated.live.size;
  clearApiSession();
  useAuthStore.setState({ session: null, deletionCleanup: null });

  if (!failure && timersAfterFlush !== 0) {
    failure = `${timersAfterFlush} fake timer(s) still pending ${POST_UNMOUNT_FLUSH_MS}ms after unmount (final phase ${finalPhase})${
      pendingTimerOrigins.length > 0
        ? `\n  ${pendingTimerOrigins.join('\n  ')}`
        : ''
    }`;
  }
  if (!failure && Object.keys(listenerDelta).length > 0) {
    failure = `emitter subscriptions not released: ${JSON.stringify(listenerDelta)}`;
  }
  if (!failure && consoleErrors.length > 0) {
    failure = `console.error during iteration: ${consoleErrors[0]?.slice(0, 300)}`;
  }

  return {
    seed,
    session,
    entry,
    steps,
    finalPhase,
    fetchCalls: network.calls - fetchCallsBefore,
    settledAfterUnmount,
    timersBeforeFlush,
    timersAfterFlush,
    listenerDelta,
    nativeAnimatedLiveAfter,
    consoleErrors,
    renderMs,
    walkMs,
    totalMs: hrtimeMs(iterationStart),
    outcome: failure ? 'BROKEN' : 'HELD',
    failure,
  };
}

// ─── Sampling ────────────────────────────────────────────────────────────────

async function collectGarbage() {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) return false;
  // WeakRef targets are kept alive until the end of the job that observed
  // them; give finalization a full turn between two collections.
  gc();
  await new Promise<void>(resolve => setImmediate(resolve));
  gc();
  await new Promise<void>(resolve => setImmediate(resolve));
  return true;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

async function sample(
  iteration: number,
  harness: Harness,
  window: IterationResult[],
): Promise<Sample> {
  await collectGarbage();
  const mem = process.memoryUsage();
  const resources: Record<string, number> = {};
  for (const r of process.getActiveResourcesInfo()) {
    resources[r] = (resources[r] ?? 0) + 1;
  }
  const handles = (
    process as unknown as { _getActiveHandles: () => unknown[] }
  )._getActiveHandles().length;
  // Fibers from iterations before this window must be gone; the ones from
  // the current window may still be referenced by the WeakRef KeepDuringJob
  // set, so only older ones count.
  const cutoff = window[0]?.seed ?? Number.POSITIVE_INFINITY;
  let retained = 0;
  let tracked = 0;
  for (const entry of harness.fiberRefs) {
    if (entry.iteration >= cutoff) continue;
    tracked += 1;
    if (entry.ref.deref() !== undefined) retained += 1;
  }
  return {
    iteration,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    rss: mem.rss,
    activeHandles: handles,
    activeResources: resources,
    fakeTimers: jest.getTimerCount(),
    listeners: harness.ledger.snapshot(),
    retainedFibers: retained,
    trackedFibers: tracked,
    nativeAnimatedLive: harness.nativeAnimated.live.size,
    nativeAnimatedLiveByType: harness.nativeAnimated.histogram(),
    medianRenderMsWindow: median(window.map(w => w.renderMs)),
    medianWalkMsWindow: median(window.map(w => w.walkMs)),
  };
}

/** Least-squares slope of heapUsed over iteration, as % of the baseline heap
 * per 100 iterations. */
function heapSlopePctPer100(samples: Sample[], baselineHeap: number): number {
  if (samples.length < 2) return 0;
  const n = samples.length;
  const meanX = samples.reduce((s, p) => s + p.iteration, 0) / n;
  const meanY = samples.reduce((s, p) => s + p.heapUsed, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of samples) {
    num += (p.iteration - meanX) * (p.heapUsed - meanY);
    den += (p.iteration - meanX) ** 2;
  }
  const slopePerIteration = den === 0 ? 0 : num / den;
  return (slopePerIteration * 100 * 100) / baselineHeap;
}

function isMonotoneIncreasing(samples: Sample[]): boolean {
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i]!.heapUsed <= samples[i - 1]!.heapUsed) return false;
  }
  return samples.length >= 3;
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const realConsoleError = console.error;

describe('ManageAccountScreen long-run leak campaign (real navigator + stores)', () => {
  const harness: Harness = {
    ledger: new ListenerLedger(),
    timers: null,
    nativeAnimated: new NativeAnimatedLedger(),
    baselineListeners: {},
    fiberRefs: [],
    consoleErrors: [],
  };
  let network: ScriptedNetwork;

  beforeAll(() => {
    jest.useFakeTimers({
      doNotFake: [
        'setImmediate',
        'nextTick',
        'queueMicrotask',
        'hrtime',
        'performance',
      ],
    });
    if (DEBUG_TIMERS) {
      harness.timers = new TimerProvenance();
      harness.timers.install();
    }
    network = new ScriptedNetwork();
    globalThis.fetch = network.fetch as unknown as typeof fetch;
    console.error = (...args: unknown[]) => {
      harness.consoleErrors.push(
        args
          .map(a => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
          .join(' '),
      );
    };
    harness.ledger.install();
  });

  afterAll(() => {
    harness.ledger.uninstall();
    harness.timers?.uninstall();
    console.error = realConsoleError;
    globalThis.fetch = realFetch;
    jest.useRealTimers();
  });

  test(
    `${REPLAY.length > 0 ? `replay ${REPLAY.join(',')}` : `${ITERATIONS} seeded iterations`}: heap slope ≤ ${HEAP_SLOPE_LIMIT_PCT_PER_100}%/100, timers/listeners/fibers return to baseline`,
    async () => {
      const gcAvailable =
        typeof (globalThis as { gc?: unknown }).gc === 'function';
      const seeds =
        REPLAY.length > 0
          ? REPLAY
          : Array.from({ length: ITERATIONS }, (_, i) => BASE_SEED + i);

      // Warm-up: module caches, lazy requires, once-only observers
      // (reduceMotionChanged) are paid here and excluded from the ledger
      // baseline and from every count reported.
      const warmup: IterationResult[] = [];
      for (let i = 0; i < WARMUP; i += 1) {
        warmup.push(await runIteration(BASE_SEED - 1 - i, harness, network));
        if (!KEEP_MOCK_CALLS) jest.clearAllMocks();
      }
      harness.baselineListeners = harness.ledger.snapshot();
      const nativeAnimatedLiveAtBaseline = harness.nativeAnimated.live.size;
      harness.nativeAnimated.created = 0;
      harness.nativeAnimated.dropped = 0;
      harness.nativeAnimated.connectedToView = 0;
      harness.nativeAnimated.disconnectedFromView = 0;
      harness.nativeAnimated.animationsStarted = 0;
      harness.fiberRefs = [];
      const baseline = await sample(0, harness, warmup);

      const results: IterationResult[] = [];
      const samples: Sample[] = [baseline];
      let window: IterationResult[] = [];
      for (let i = 0; i < seeds.length; i += 1) {
        const result = await runIteration(seeds[i]!, harness, network);
        if (!KEEP_MOCK_CALLS) jest.clearAllMocks();
        results.push(result);
        window.push(result);
        if ((i + 1) % SAMPLE_EVERY === 0 || i === seeds.length - 1) {
          samples.push(await sample(i + 1, harness, window));
          window = [];
        }
      }

      if (process.env.STRESS_DEBUG_ANIMATED === '1') {
        for (const [origin, n] of harness.nativeAnimated.originHistogram()) {
          console.log(
            `ANIMATED_LEAK x${n}\n  ${origin.split(' <- ').join('\n  ')}`,
          );
        }
      }
      const broken = results.filter(r => r.outcome === 'BROKEN');
      const held = results.length - broken.length;
      const scenesMounted = results.reduce(
        (n, r) => n + (r.entry === 'navigate' ? 2 : 1),
        0,
      );
      const nativeAnimatedGrowth =
        harness.nativeAnimated.live.size - nativeAnimatedLiveAtBaseline;
      const slope = heapSlopePctPer100(samples, baseline.heapUsed);
      const monotone = isMonotoneIncreasing(samples);
      const retainedMax = Math.max(...samples.map(s => s.retainedFibers));
      const firstWindow = results.slice(0, SAMPLE_EVERY).map(r => r.renderMs);
      const lastWindow = results.slice(-SAMPLE_EVERY).map(r => r.renderMs);
      const drift =
        median(firstWindow) > 0 ? median(lastWindow) / median(firstWindow) : 1;
      const finalHandles = samples[samples.length - 1]!.activeHandles;
      const phaseHistogram: Record<string, number> = {};
      for (const r of results) {
        const key = r.steps[r.steps.length - 1]?.split(':')[0] ?? 'none';
        phaseHistogram[key] = (phaseHistogram[key] ?? 0) + 1;
      }

      const campaign = {
        unit: 'scr-manageaccountscreen',
        lens: 'long-run-leak',
        node: process.version,
        gcExposed: gcAvailable,
        baseSeed: BASE_SEED,
        replay: REPLAY,
        warmupIterations: WARMUP,
        iterationsExecuted: results.length,
        held,
        broken: broken.length,
        brokenSeeds: broken.map(b => ({ seed: b.seed, failure: b.failure })),
        heap: {
          baselineHeapUsed: baseline.heapUsed,
          finalHeapUsed: samples[samples.length - 1]!.heapUsed,
          slopePctPer100Iterations: slope,
          monotoneIncreasing: monotone,
          limitPctPer100: HEAP_SLOPE_LIMIT_PCT_PER_100,
        },
        handles: {
          baseline: baseline.activeHandles,
          final: finalHandles,
          baselineResources: baseline.activeResources,
          finalResources: samples[samples.length - 1]!.activeResources,
        },
        retainedFibersMax: retainedMax,
        nativeAnimated: {
          scenesMounted,
          frameworkNodesPerScene: FRAMEWORK_NATIVE_ANIMATED_NODES_PER_SCENE,
          growth: nativeAnimatedGrowth,
          mockAvailable: harness.nativeAnimated.available,
          created: harness.nativeAnimated.created,
          dropped: harness.nativeAnimated.dropped,
          connectedToView: harness.nativeAnimated.connectedToView,
          disconnectedFromView: harness.nativeAnimated.disconnectedFromView,
          animationsStarted: harness.nativeAnimated.animationsStarted,
          liveAtBaseline: nativeAnimatedLiveAtBaseline,
          liveAfterCampaign: harness.nativeAnimated.live.size,
          liveByType: harness.nativeAnimated.histogram(),
        },
        mockCallsCleared: !KEEP_MOCK_CALLS,
        renderMs: {
          firstWindowMedian: median(firstWindow),
          lastWindowMedian: median(lastWindow),
          driftRatio: drift,
          overallMedian: median(results.map(r => r.renderMs)),
          overallP95: [...results.map(r => r.renderMs)].sort((a, b) => a - b)[
            Math.floor(results.length * 0.95)
          ],
        },
        walkMs: {
          firstWindowMedian: median(
            results.slice(0, SAMPLE_EVERY).map(r => r.walkMs),
          ),
          lastWindowMedian: median(
            results.slice(-SAMPLE_EVERY).map(r => r.walkMs),
          ),
        },
        timers: {
          iterationsWithPendingBeforeFlush: results.filter(
            r => r.timersBeforeFlush > 0,
          ).length,
          iterationsWithPendingAfterFlush: results.filter(
            r => r.timersAfterFlush > 0,
          ).length,
        },
        settledAfterUnmount: results.reduce(
          (s, r) => s + r.settledAfterUnmount,
          0,
        ),
        totalFetchCalls: network.calls,
        lastActionHistogram: phaseHistogram,
        samples,
      };

      if (OUT_DIR) {
        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(
          join(OUT_DIR, 'campaign.json'),
          JSON.stringify(campaign, null, 2),
        );
        writeFileSync(
          join(OUT_DIR, 'seeds.json'),
          JSON.stringify(results, null, 2),
        );
        writeFileSync(
          join(OUT_DIR, 'heap.csv'),
          [
            'iteration,heapUsed,heapTotal,external,arrayBuffers,rss,activeHandles,fakeTimers,retainedFibers,trackedFibers,nativeAnimatedLive,medianRenderMs,medianWalkMs',
            ...samples.map(s =>
              [
                s.iteration,
                s.heapUsed,
                s.heapTotal,
                s.external,
                s.arrayBuffers,
                s.rss,
                s.activeHandles,
                s.fakeTimers,
                s.retainedFibers,
                s.trackedFibers,
                s.nativeAnimatedLive,
                s.medianRenderMsWindow.toFixed(2),
                s.medianWalkMsWindow.toFixed(2),
              ].join(','),
            ),
          ].join('\n'),
        );
      }

      // Per-seed failures first: they carry the seed to replay.
      expect(
        broken.map(
          b => `seed ${b.seed} [${b.steps.join(' > ')}]: ${b.failure}`,
        ),
      ).toEqual([]);
      expect(results).toHaveLength(seeds.length);
      // Every gc'd sample: fibers from earlier windows must have been freed.
      expect(retainedMax).toBe(0);
      // Timers/handles back to baseline at the end of the campaign.
      expect(samples[samples.length - 1]!.fakeTimers).toBe(0);
      expect(finalHandles).toBeLessThanOrEqual(baseline.activeHandles + 2);
      // Native Animated registry: nothing beyond the known per-scene framework
      // nodes may survive an unmount.
      if (harness.nativeAnimated.available) {
        expect(nativeAnimatedGrowth).toBeLessThanOrEqual(
          FRAMEWORK_NATIVE_ANIMATED_NODES_PER_SCENE * scenesMounted,
        );
      }
      if (gcAvailable && results.length >= 2 * SAMPLE_EVERY) {
        expect(slope).toBeLessThanOrEqual(HEAP_SLOPE_LIMIT_PCT_PER_100);
        expect(drift).toBeLessThanOrEqual(RENDER_DRIFT_LIMIT);
      }
    },
    Math.max(60_000, ITERATIONS * 4_000),
  );
});
