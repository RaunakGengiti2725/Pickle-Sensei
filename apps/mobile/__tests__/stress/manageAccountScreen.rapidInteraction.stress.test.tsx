/**
 * Rapid/concurrent-interaction stress campaign for ManageAccountScreen.
 *
 * The screen is rendered the way the app renders it — inside the real
 * NavigationContainer + native-stack navigator (a Settings stand-in route is
 * the previous screen, exactly like `navigation.navigate('ManageAccount')`
 * from SettingsScreen), the real zustand auth/api-session stores, the real
 * `account/deletion` client, SafeAreaProvider, react-query and the
 * BrandNoticeHost from App.tsx. Only native modules (safe-area-context via
 * its official jest mock, sqlite, keychain via __mocks__) and `fetch` are
 * stubbed.
 *
 * A seeded generator scripts bursts of double/triple taps (sequential — each
 * tap sees the re-rendered tree, as separate touch events do on device — and
 * same-tick, where every tap in the burst lands in one React batch), taps
 * during page/entrance transitions, simultaneous controls, backdrop/hardware
 * dismissal and navigation away while a request is in flight, navigation
 * spam, survey typing, and fetch settlement in every outcome the client
 * understands (200, 400, 401, 429, 500, network failure, malformed JSON,
 * `deleted:false`, 15 s abort).
 *
 * Invariants asserted after every burst and at teardown:
 *   - one side effect per intent: one POST /v1/me/delete-request per
 *     enabled "Continue to delete" intent, one POST /v1/me/delete-confirm per
 *     enabled "Permanently delete" intent, one route change per Back intent,
 *     ManageAccount pushed at most once by navigation spam;
 *   - never more than one visible Modal, never a second deletion dialog;
 *   - no orphan loading state: once no fetch is pending the tree shows no
 *     "Requesting…"/"Deleting…" and no busy controls;
 *   - no console.error/console.warn (act() warnings, unhandled navigation
 *     actions, key warnings…) and no unhandled promise rejection;
 *   - no orphan interval after the tree unmounts (the armed countdown);
 *   - after a confirmed deletion: exactly one completeAccountDeletion(),
 *     the session is gone and the dialog is closed.
 *
 * Every iteration is replayable from its seed:
 *   STRESS_ITER=300 STRESS_OUT=/tmp/ma-stress.json npx jest --ci __tests__/stress/manageAccountScreen.rapidInteraction
 *   STRESS_SEEDS=4711,4720 npx jest --ci __tests__/stress/manageAccountScreen.rapidInteraction
 * Defaults keep the suite fast (STRESS_ITER=24, ~4 s). STRESS_SAME_TICK=0 drops
 * the same-tick burst mode (which models two touch-ups in one JS batch —
 * stronger than what a single-touch device delivers); violations seen only in
 * that mode are reported as `synthetic` and do not fail unless STRESS_STRICT=1.
 * STRESS_DEBUG=1 attaches stacks to captured console calls.
 *
 * Rendering uses react-test-renderer (the suite's existing convention;
 * @testing-library/react-native is not a dependency of apps/mobile), driving
 * the same Pressable `onPress`/`disabled` props a touch would.
 */
import React from 'react';
import { Linking, Modal, Pressable, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  NavigationContainer,
  StackActions,
  createNavigationContainerRef,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

// The library's own jest mock: real contexts (react-navigation's
// SafeAreaProviderCompat reads them), no native RNCSafeAreaProvider.
jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { BrandNoticeHost } from '../../src/design/BrandNotice';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  useApiSessionStore,
  type ApiSession,
} from '../../src/account/apiSession';
import type { RootStackParams } from '../../src/navigation/params';

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

// ---------------------------------------------------------------------------
// Campaign configuration (env-driven, small default so the suite stays fast)
// ---------------------------------------------------------------------------

const ITERATIONS = Math.max(1, Number(process.env.STRESS_ITER ?? 24) || 24);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 4711) || 4711;
const EXPLICIT_SEEDS = (process.env.STRESS_SEEDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(s => s.length > 0)
  .map(Number)
  .filter(n => Number.isFinite(n));
const OUT_PATH = process.env.STRESS_OUT ?? null;
const SAME_TICK_ENABLED = process.env.STRESS_SAME_TICK !== '0';
/** STRESS_DEBUG=1 appends the JS stack to every captured console call. */
const DEBUG = process.env.STRESS_DEBUG === '1';
/**
 * Same-tick bursts model two touch-ups inside ONE JS batch. A single-touch
 * device re-renders between discrete touch events, so violations seen only in
 * that mode are recorded as `synthetic` (reported, not failing) unless
 * STRESS_STRICT=1.
 */
const STRICT = process.env.STRESS_STRICT === '1';

const SEEDS =
  EXPLICIT_SEEDS.length > 0
    ? EXPLICIT_SEEDS
    : Array.from({ length: ITERATIONS }, (_, i) => BASE_SEED + i);

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — every iteration derives purely from its seed.
// ---------------------------------------------------------------------------

class Rng {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0;
  }
  next(): number {
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  weighted<T>(entries: ReadonlyArray<readonly [number, T]>): T {
    const total = entries.reduce((sum, [w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [w, value] of entries) {
      roll -= w;
      if (roll < 0) return value;
    }
    const last = entries[entries.length - 1];
    if (!last) throw new Error('weighted pick from empty list');
    return last[1];
  }
}

// ---------------------------------------------------------------------------
// fetch stub — the only network boundary. Requests stay pending until the
// script settles them (or the client's own 15 s AbortController fires).
// ---------------------------------------------------------------------------

type FetchOutcome =
  | 'ok'
  | 'http400'
  | 'http401'
  | 'http429'
  | 'http500'
  | 'network'
  | 'badJson'
  | 'notDeleted';

const FETCH_OUTCOMES: readonly FetchOutcome[] = [
  'ok',
  'ok',
  'ok',
  'http400',
  'http401',
  'http429',
  'http500',
  'network',
  'badJson',
  'notDeleted',
];

interface PendingFetch {
  seq: number;
  path: string;
  body: unknown;
  settled: boolean;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

interface FetchRecord {
  seq: number;
  path: string;
  body: unknown;
  outcome: FetchOutcome | 'aborted' | 'pending';
}

class FetchStub {
  readonly records: FetchRecord[] = [];
  readonly pending: PendingFetch[] = [];
  private seq = 0;

  readonly fetch = (input: string, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const seq = ++this.seq;
      const url = new URL(input);
      const body =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const record: FetchRecord = {
        seq,
        path: url.pathname,
        body,
        outcome: 'pending',
      };
      this.records.push(record);
      const entry: PendingFetch = {
        seq,
        path: url.pathname,
        body,
        settled: false,
        resolve,
        reject,
      };
      this.pending.push(entry);
      init?.signal?.addEventListener('abort', () => {
        if (entry.settled) return;
        entry.settled = true;
        record.outcome = 'aborted';
        this.remove(entry);
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

  private remove(entry: PendingFetch) {
    const index = this.pending.indexOf(entry);
    if (index >= 0) this.pending.splice(index, 1);
  }

  count(path: string): number {
    return this.records.filter(r => r.path === path).length;
  }

  settle(
    entry: PendingFetch,
    outcome: FetchOutcome,
    revocation: 'not_applicable' | 'manual_action_required' | 'revoked',
  ) {
    if (entry.settled) return;
    entry.settled = true;
    this.remove(entry);
    const record = this.records.find(r => r.seq === entry.seq);
    if (record) record.outcome = outcome;
    const respond = (status: number, payload: unknown, badJson = false) => {
      const response = {
        ok: status >= 200 && status < 300,
        status,
        json: () =>
          badJson
            ? Promise.reject(new SyntaxError('Unexpected token'))
            : Promise.resolve(payload),
      } as unknown as Response;
      entry.resolve(response);
    };
    switch (outcome) {
      case 'ok':
        if (entry.path === '/v1/me/delete-request') {
          respond(200, {
            challenge: `challenge-${entry.seq}`,
            expiresAt: '2026-09-05T01:00:00.000Z',
          });
        } else {
          respond(200, {
            deleted: true,
            appleAuthorizationRevocation: revocation,
          });
        }
        return;
      case 'notDeleted':
        if (entry.path === '/v1/me/delete-request') {
          respond(200, { challenge: 42, expiresAt: null });
        } else {
          respond(200, { deleted: false });
        }
        return;
      case 'badJson':
        respond(200, null, true);
        return;
      case 'http400':
        respond(400, { error: { message: 'Bad request from stub' } });
        return;
      case 'http401':
        respond(401, { error: { message: 'expired' } });
        return;
      case 'http429':
        respond(429, { error: { message: 'slow down' } });
        return;
      case 'http500':
        respond(500, 'not json');
        return;
      case 'network':
        entry.reject(new TypeError('Network request failed'));
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Tree under test — the app's provider shell around the real navigator.
// ---------------------------------------------------------------------------

const Stack = createNativeStackNavigator<RootStackParams>();
const navRef = createNavigationContainerRef<RootStackParams>();

function SettingsStandIn({
  navigation,
}: NativeStackScreenProps<RootStackParams, 'Tabs'>) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Manage account"
      onPress={() => navigation.navigate('ManageAccount')}
    >
      <Text>Settings</Text>
    </Pressable>
  );
}

function Harness({ queryClient }: { queryClient: QueryClient }) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <NavigationContainer ref={navRef}>
          <Stack.Navigator
            screenOptions={{
              headerShown: false,
              animation: 'fade_from_bottom',
            }}
          >
            <Stack.Screen name="Tabs" component={SettingsStandIn} />
            <Stack.Screen
              name="ManageAccount"
              component={ManageAccountScreen}
              options={{ title: 'Manage Account' }}
            />
          </Stack.Navigator>
        </NavigationContainer>
        <BrandNoticeHost />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const CANONICAL_ID = '11111111-1111-4111-8111-111111111111';

const syncedSession: AuthSession = {
  provider: 'google',
  subject: CANONICAL_ID,
  canonicalAppUserId: CANONICAL_ID,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

const apiSession: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'bearer-token',
  canonicalAppUserId: CANONICAL_ID,
  provider: 'google',
};

// ---------------------------------------------------------------------------
// Tree queries
// ---------------------------------------------------------------------------

function isComposite(node: Instance): boolean {
  return typeof node.type !== 'string';
}

/** Deepest composite node carrying this accessibilityLabel and an onPress —
 * i.e. the RN Pressable whose `disabled` decides whether a touch fires. */
function findPressable(root: Instance, label: string): Instance | null {
  const matches = root.findAll(
    n =>
      isComposite(n) &&
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  return matches[matches.length - 1] ?? null;
}

function pressableLabels(root: Instance): string[] {
  const labels = new Set<string>();
  for (const n of root.findAll(
    n =>
      isComposite(n) &&
      typeof n.props.accessibilityLabel === 'string' &&
      typeof n.props.onPress === 'function',
  )) {
    labels.add(n.props.accessibilityLabel as string);
  }
  return [...labels];
}

function textContent(node: Instance): string {
  return node
    .findAll(n => n.type === Text)
    .map(t =>
      React.Children.toArray(t.props.children)
        .filter(c => typeof c === 'string' || typeof c === 'number')
        .join(''),
    )
    .join('\n');
}

function hasText(root: Instance, needle: string): boolean {
  return textContent(root).includes(needle);
}

function visibleModals(root: Instance): Instance[] {
  return root.findAllByType(Modal).filter(m => m.props.visible !== false);
}

/** The deletion dialog is the modal carrying the scrim pressable (present on
 * every page, with or without an onPress while busy). */
function deletionDialogs(root: Instance): Instance[] {
  return visibleModals(root).filter(
    m =>
      m.findAll(
        n =>
          isComposite(n) &&
          n.props.accessibilityLabel === 'Cancel account deletion',
      ).length > 0,
  );
}

function onManageAccount(root: Instance): boolean {
  return findPressable(root, 'Delete account') !== null;
}

function busyVisible(root: Instance): boolean {
  return hasText(root, 'Requesting…') || hasText(root, 'Deleting…');
}

function routeNames(): string[] {
  if (!navRef.isReady()) return [];
  const state = navRef.getRootState();
  return state ? state.routes.map(r => r.name) : [];
}

// ---------------------------------------------------------------------------
// Burst vocabulary
// ---------------------------------------------------------------------------

type TapMode = 'seq' | 'tick';

type Burst =
  | { kind: 'tap'; label: string; taps: number; mode: TapMode }
  | { kind: 'hardwareBack'; taps: number }
  | { kind: 'type'; text: string }
  | { kind: 'navAway'; via: 'goBack' | 'navigateTabs'; taps: number }
  | { kind: 'navOpen'; taps: number; mode: TapMode }
  | { kind: 'settle'; outcome: FetchOutcome; which: 'oldest' | 'newest' }
  | { kind: 'advance'; ms: number };

const FLOW_LABELS = [
  'Skip the survey',
  'Next',
  'Continue',
  'Skip this question',
  'Continue to delete',
  'Permanently delete',
];

const ADVANCE_MS = [16, 120, 250, 999, 1000, 1001, 4999, 5000, 5001, 16_000];

const TYPED_TEXTS = [
  '',
  ' ',
  'ok',
  'Great app, moving on. ',
  'x'.repeat(499),
  'y'.repeat(500),
  'z'.repeat(600),
  '🙂 emoji and "quotes" <tags> \n newline',
];

function describeBurst(b: Burst): string {
  switch (b.kind) {
    case 'tap':
      return `tap(${JSON.stringify(b.label)} x${b.taps} ${b.mode})`;
    case 'hardwareBack':
      return `hardwareBack x${b.taps}`;
    case 'type':
      return `type(len=${b.text.length})`;
    case 'navAway':
      return `navAway(${b.via} x${b.taps})`;
    case 'navOpen':
      return `navOpen(x${b.taps} ${b.mode})`;
    case 'settle':
      return `settle(${b.which}:${b.outcome})`;
    case 'advance':
      return `advance(${b.ms}ms)`;
  }
}

function pickMode(rng: Rng): TapMode {
  return SAME_TICK_ENABLED && rng.chance(0.3) ? 'tick' : 'seq';
}

function pickTaps(rng: Rng): number {
  return rng.weighted([
    [4, 1],
    [4, 2],
    [2, 3],
  ] as const);
}

function nextBurst(rng: Rng, root: Instance, pendingFetches: number): Burst {
  const labels = pressableLabels(root);
  const onScreen = onManageAccount(root) || labels.includes('Back');
  const dialogOpen = deletionDialogs(root).length > 0;
  const hasInput = root.findAllByType(TextInput).length > 0;
  const flowHere = FLOW_LABELS.filter(l => {
    const label = labels.find(
      x => x === l || (l === 'Permanently delete' && x.startsWith(l)),
    );
    return label !== undefined;
  }).map(l => labels.find(x => x === l || x.startsWith(l)) ?? l);

  const options: Array<readonly [number, () => Burst]> = [];

  if (!onScreen) {
    options.push([
      10,
      () => ({ kind: 'navOpen', taps: pickTaps(rng), mode: pickMode(rng) }),
    ]);
    options.push([2, () => ({ kind: 'advance', ms: rng.pick(ADVANCE_MS) })]);
  } else if (!dialogOpen) {
    options.push([
      10,
      () => ({
        kind: 'tap',
        label: 'Delete account',
        taps: pickTaps(rng),
        mode: pickMode(rng),
      }),
    ]);
    options.push([
      3,
      () => ({
        kind: 'tap',
        label: 'Back',
        taps: pickTaps(rng),
        mode: pickMode(rng),
      }),
    ]);
    options.push([
      1,
      () => ({
        kind: 'navAway',
        via: rng.chance(0.75) ? 'goBack' : 'navigateTabs',
        taps: pickTaps(rng),
      }),
    ]);
    options.push([2, () => ({ kind: 'advance', ms: rng.pick(ADVANCE_MS) })]);
  } else {
    const counting = labels.some(l => l.startsWith('Permanently delete ('));
    if (counting) {
      // Armed and counting down: let the arm delay elapse often enough that
      // the confirm path (and its own rapid taps) gets real coverage.
      options.push([
        10,
        () => ({ kind: 'advance', ms: rng.pick([4999, 5000, 5001]) }),
      ]);
    }
    if (flowHere.length > 0) {
      options.push([
        16,
        () => ({
          kind: 'tap',
          label: rng.pick(flowHere),
          taps: pickTaps(rng),
          mode: pickMode(rng),
        }),
      ]);
    }
    const others = labels.filter(l => l !== 'Delete account');
    if (others.length > 0) {
      options.push([
        4,
        () => ({
          kind: 'tap',
          label: rng.pick(others),
          taps: pickTaps(rng),
          mode: pickMode(rng),
        }),
      ]);
    }
    options.push([2, () => ({ kind: 'hardwareBack', taps: pickTaps(rng) })]);
    if (hasInput) {
      options.push([2, () => ({ kind: 'type', text: rng.pick(TYPED_TEXTS) })]);
    }
    options.push([
      1,
      () => ({
        kind: 'navAway',
        via: rng.chance(0.75) ? 'goBack' : 'navigateTabs',
        taps: pickTaps(rng),
      }),
    ]);
    options.push([3, () => ({ kind: 'advance', ms: rng.pick(ADVANCE_MS) })]);
  }
  if (pendingFetches > 0) {
    options.push([
      12,
      () => ({
        kind: 'settle',
        outcome: rng.pick(FETCH_OUTCOMES),
        which: rng.chance(0.7) ? 'oldest' : 'newest',
      }),
    ]);
  }
  return rng.weighted(options)();
}

// ---------------------------------------------------------------------------
// Iteration runner
// ---------------------------------------------------------------------------

interface Violation {
  burst: number;
  rule: string;
  detail: string;
  /** true when the burst that produced it was a same-tick multi-tap. */
  sameTick: boolean;
}

interface IterationRow {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  bursts: string[];
  /** Violations from realistic (sequential) interaction — these fail. */
  violations: Violation[];
  /** Violations seen only under same-tick bursts — informational. */
  synthetic: Violation[];
  stats: {
    deleteRequests: number;
    deleteConfirms: number;
    completeAccountDeletionCalls: number;
    routeChanges: number;
    timersLeft: number;
    intervalsLeft: number;
    fetchOutcomes: string[];
  };
}

const rows: IterationRow[] = [];

const consoleCalls: string[] = [];
const unhandled: string[] = [];
const activeIntervals = new Set<unknown>();
let openUrlSpy: jest.SpyInstance;

function onUnhandled(reason: unknown) {
  unhandled.push(
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

async function runIteration(seed: number): Promise<IterationRow> {
  const rng = new Rng(seed);
  const fetchStub = new FetchStub();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub.fetch as typeof fetch;
  const queryClient = new QueryClient();

  const realComplete = useAuthStore.getState().completeAccountDeletion;
  const completeSpy = jest.fn(() => realComplete());
  useApiSessionStore.setState({ session: apiSession });
  useAuthStore.setState({
    hydrated: true,
    session: syncedSession,
    busy: false,
    error: null,
    deletionCleanup: null,
    completeAccountDeletion: completeSpy,
  });

  const violations: Violation[] = [];
  const bursts: string[] = [];
  let routeChanges = 0;
  const record = (
    burst: number,
    rule: string,
    detail: string,
    sameTick = false,
  ) => violations.push({ burst, rule, detail, sameTick });

  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<Harness queryClient={queryClient} />);
  });
  const unsubscribe = navRef.addListener('state', () => {
    routeChanges += 1;
  });
  try {
    return await driveIteration();
  } finally {
    // Whatever happened (including a thrown handler), leave nothing mounted
    // or patched for the next seed.
    unsubscribe();
    await act(async () => {
      renderer.unmount();
    });
    queryClient.clear();
    globalThis.fetch = originalFetch;
  }

  async function driveIteration(): Promise<IterationRow> {
    await flush();
    // Enter the screen the way Settings does.
    await act(async () => {
      findPressable(renderer.root, 'Manage account')?.props.onPress();
    });
    await flush();
    if (!onManageAccount(renderer.root)) {
      record(-1, 'setup', 'ManageAccount did not render after navigate');
    }

    const totalBursts = 6 + rng.int(19);
    const revocationFor = () =>
      rng.pick([
        'not_applicable',
        'manual_action_required',
        'revoked',
      ] as const);

    for (let i = 0; i < totalBursts; i += 1) {
      const root = renderer.root;
      const burst = nextBurst(rng, root, fetchStub.pending.length);
      bursts.push(describeBurst(burst));
      const sameTick =
        (burst.kind === 'tap' || burst.kind === 'navOpen') &&
        burst.mode === 'tick' &&
        burst.taps > 1;
      const requestsBefore = fetchStub.count('/v1/me/delete-request');
      const confirmsBefore = fetchStub.count('/v1/me/delete-confirm');
      const openUrlBefore = openUrlSpy.mock.calls.length;
      const routesBefore = routeNames();
      const consoleBefore = consoleCalls.length;

      switch (burst.kind) {
        case 'tap': {
          const first = findPressable(root, burst.label);
          const enabledBefore = first !== null && !first.props.disabled;
          if (burst.mode === 'tick') {
            await act(async () => {
              for (let t = 0; t < burst.taps; t += 1) {
                if (first && !first.props.disabled) first.props.onPress();
              }
            });
          } else {
            for (let t = 0; t < burst.taps; t += 1) {
              const node = findPressable(renderer.root, burst.label);
              await act(async () => {
                if (node && !node.props.disabled) node.props.onPress();
              });
            }
          }
          await flush();
          const expected = enabledBefore ? 1 : 0;
          if (burst.label === 'Continue to delete') {
            const delta =
              fetchStub.count('/v1/me/delete-request') - requestsBefore;
            if (delta !== expected) {
              record(
                i,
                'one-request-per-intent',
                `delete-request fetches +${delta}, expected +${expected}`,
                sameTick,
              );
            }
          } else if (burst.label.startsWith('Permanently delete')) {
            const delta =
              fetchStub.count('/v1/me/delete-confirm') - confirmsBefore;
            if (delta !== expected) {
              record(
                i,
                'one-confirm-per-intent',
                `delete-confirm fetches +${delta}, expected +${expected}`,
                sameTick,
              );
            }
          } else if (burst.label === 'Back') {
            const after = routeNames();
            const expectedLen = enabledBefore
              ? Math.max(1, routesBefore.length - 1)
              : routesBefore.length;
            if (after.length !== expectedLen) {
              record(
                i,
                'one-navigation-per-intent',
                `routes ${routesBefore.join('>')} -> ${after.join('>')}`,
                sameTick,
              );
            }
          } else if (burst.label.startsWith('Manage subscription')) {
            const delta = openUrlSpy.mock.calls.length - openUrlBefore;
            if (delta !== expected) {
              record(
                i,
                'one-openurl-per-intent',
                `Linking.openURL +${delta}, expected +${expected}`,
                sameTick,
              );
            }
          } else if (burst.label === 'Delete account') {
            if (enabledBefore && deletionDialogs(renderer.root).length !== 1) {
              record(
                i,
                'dialog-opens-once',
                `${deletionDialogs(renderer.root).length} deletion dialogs after tapping the link`,
                sameTick,
              );
            }
          }
          break;
        }
        case 'hardwareBack': {
          for (let t = 0; t < burst.taps; t += 1) {
            const modal = visibleModals(renderer.root)[0];
            const busyBefore = busyVisible(renderer.root);
            await act(async () => {
              modal?.props.onRequestClose?.();
            });
            if (busyBefore && deletionDialogs(renderer.root).length === 0) {
              record(
                i,
                'no-dismiss-while-busy',
                'hardware back dismissed a busy deletion dialog',
              );
            }
          }
          await flush();
          break;
        }
        case 'type': {
          const input = renderer.root.findAllByType(TextInput)[0];
          await act(async () => {
            input?.props.onChangeText?.(burst.text);
          });
          break;
        }
        case 'navAway': {
          await act(async () => {
            for (let t = 0; t < burst.taps; t += 1) {
              if (!navRef.isReady()) continue;
              if (burst.via === 'goBack') {
                if (navRef.canGoBack()) navRef.goBack();
              } else {
                navRef.navigate('Tabs');
              }
            }
          });
          await flush();
          const after = routeNames();
          if (after.length !== 1 || after[0] !== 'Tabs') {
            record(
              i,
              'nav-away-lands-on-tabs',
              `${burst.via}: routes ${after.join('>')}`,
            );
            // Repair the stack so the remaining bursts still exercise the
            // screen from a known state (the violation is already recorded).
            await act(async () => {
              navRef.dispatch(StackActions.popToTop());
            });
            await flush();
          }
          if (
            onManageAccount(renderer.root) ||
            visibleModals(renderer.root).length > 0
          ) {
            record(
              i,
              'screen-unmounts-on-nav-away',
              'ManageAccount (or a modal) still rendered after leaving the route',
            );
          }
          break;
        }
        case 'navOpen': {
          const first = findPressable(root, 'Manage account');
          if (burst.mode === 'tick') {
            await act(async () => {
              for (let t = 0; t < burst.taps; t += 1) first?.props.onPress();
            });
          } else {
            for (let t = 0; t < burst.taps; t += 1) {
              const node = findPressable(renderer.root, 'Manage account');
              await act(async () => {
                node?.props.onPress();
              });
            }
          }
          await flush();
          const after = routeNames();
          const manageCount = after.filter(r => r === 'ManageAccount').length;
          if (manageCount !== 1) {
            record(
              i,
              'navigate-pushes-once',
              `routes ${after.join('>')} after ${burst.taps} navigate taps`,
              sameTick,
            );
          }
          break;
        }
        case 'settle': {
          const entry =
            burst.which === 'oldest'
              ? fetchStub.pending[0]
              : fetchStub.pending[fetchStub.pending.length - 1];
          await act(async () => {
            if (entry) fetchStub.settle(entry, burst.outcome, revocationFor());
          });
          await flush();
          break;
        }
        case 'advance': {
          await act(async () => {
            jest.advanceTimersByTime(burst.ms);
          });
          await flush();
          break;
        }
      }

      // Invariants after every burst.
      const modalsNow = visibleModals(renderer.root).length;
      if (modalsNow > 1) {
        record(i, 'single-modal', `${modalsNow} visible modals`, sameTick);
      }
      if (deletionDialogs(renderer.root).length > 1) {
        record(
          i,
          'single-deletion-dialog',
          'duplicate deletion dialog',
          sameTick,
        );
      }
      if (fetchStub.pending.length === 0 && busyVisible(renderer.root)) {
        record(
          i,
          'no-orphan-loading',
          'Requesting…/Deleting… shown with no fetch in flight',
          sameTick,
        );
      }
      if (
        !onManageAccount(renderer.root) &&
        deletionDialogs(renderer.root).length > 0
      ) {
        record(
          i,
          'dialog-needs-screen',
          'deletion dialog visible without its screen',
        );
      }
      if (consoleCalls.length > consoleBefore) {
        record(
          i,
          'no-console-warnings',
          consoleCalls.slice(consoleBefore).join(' | ').slice(0, 600),
          sameTick,
        );
      }
    }

    // Drain: settle whatever is still pending, let the countdown and the
    // 15 s abort timers run, then check the resting state.
    const drainStart = bursts.length;
    while (fetchStub.pending.length > 0) {
      const entry = fetchStub.pending[0];
      const outcome = rng.pick(FETCH_OUTCOMES);
      bursts.push(`drain:settle(${outcome})`);
      await act(async () => {
        if (entry) fetchStub.settle(entry, outcome, revocationFor());
      });
      await flush();
    }
    await act(async () => {
      jest.advanceTimersByTime(20_000);
    });
    await flush();
    if (fetchStub.pending.length > 0) {
      // A tap in the drain window could not start a request; anything still
      // pending here would be a request nothing can settle.
      record(
        drainStart,
        'drain',
        `${fetchStub.pending.length} fetches still pending`,
      );
    }
    if (busyVisible(renderer.root)) {
      record(drainStart, 'no-orphan-loading', 'busy label at rest');
    }
    const okConfirms = fetchStub.records.filter(
      r => r.path === '/v1/me/delete-confirm' && r.outcome === 'ok',
    ).length;
    if (okConfirms > 0) {
      if (completeSpy.mock.calls.length !== okConfirms) {
        record(
          drainStart,
          'one-purge-per-deletion',
          `completeAccountDeletion called ${completeSpy.mock.calls.length}x for ${okConfirms} confirmed deletion(s)`,
        );
      }
      if (useAuthStore.getState().session !== null) {
        record(
          drainStart,
          'session-cleared',
          'session survived a confirmed deletion',
        );
      }
      if (deletionDialogs(renderer.root).length > 0) {
        record(drainStart, 'dialog-closes-after-deletion', 'dialog still open');
      }
    } else if (completeSpy.mock.calls.length !== 0) {
      record(
        drainStart,
        'no-purge-without-deletion',
        `completeAccountDeletion called ${completeSpy.mock.calls.length}x without a confirmed deletion`,
      );
    }
    if (visibleModals(renderer.root).length > 1) {
      record(drainStart, 'single-modal', 'more than one modal at rest');
    }

    unsubscribe();
    await act(async () => {
      renderer.unmount();
    });
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await flush();
    const intervalsLeft = activeIntervals.size;
    if (intervalsLeft > 0) {
      // Two same-tick requests can each arm a countdown (the second overwrites
      // timerRef); an orphan in such a row is not attributable to realistic
      // interaction, so it inherits the same-tick classification.
      const doubledBySameTick = violations.some(
        v =>
          v.sameTick &&
          (v.rule === 'one-request-per-intent' ||
            v.rule === 'one-confirm-per-intent'),
      );
      record(
        drainStart,
        'no-orphan-interval',
        `${intervalsLeft} interval(s) still scheduled after unmount`,
        doubledBySameTick,
      );
      for (const id of activeIntervals)
        clearInterval(id as ReturnType<typeof setInterval>);
      activeIntervals.clear();
    }
    const timersLeft = jest.getTimerCount();
    if (unhandled.length > 0) {
      record(
        drainStart,
        'no-unhandled-rejection',
        unhandled.join(' | ').slice(0, 600),
      );
      unhandled.length = 0;
    }
    if (consoleCalls.length > 0) {
      // Anything logged during drain/teardown that a per-burst check missed.
      const seen = violations
        .filter(v => v.rule === 'no-console-warnings')
        .map(v => v.detail);
      const extra = consoleCalls.filter(
        c => !seen.some(s => s.includes(c.slice(0, 80))),
      );
      if (extra.length > 0) {
        record(
          drainStart,
          'no-console-warnings',
          extra.join(' | ').slice(0, 600),
        );
      }
      consoleCalls.length = 0;
    }
    const realistic = violations.filter(v => STRICT || !v.sameTick);
    const synthetic = violations.filter(v => !STRICT && v.sameTick);
    return {
      seed,
      outcome: realistic.length === 0 ? 'HELD' : 'BROKEN',
      bursts,
      violations: realistic,
      synthetic,
      stats: {
        deleteRequests: fetchStub.count('/v1/me/delete-request'),
        deleteConfirms: fetchStub.count('/v1/me/delete-confirm'),
        completeAccountDeletionCalls: completeSpy.mock.calls.length,
        routeChanges,
        timersLeft,
        intervalsLeft,
        fetchOutcomes: fetchStub.records.map(
          r => `${r.path.split('/').pop()}:${r.outcome}`,
        ),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ManageAccountScreen rapid-interaction stress (seeded)', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let setIntervalSpy: jest.SpyInstance;
  let clearIntervalSpy: jest.SpyInstance;

  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandled);
    jest.useFakeTimers();
    // Settle the design system's one-time AccessibilityInfo reduce-motion
    // probe inside act() so it never lands mid-iteration.
    const queryClient = new QueryClient();
    let warm!: Renderer;
    await act(async () => {
      warm = TestRenderer.create(<Harness queryClient={queryClient} />);
    });
    await flush();
    await act(async () => {
      warm.unmount();
    });
    queryClient.clear();
    jest.useRealTimers();
  });

  afterAll(() => {
    process.off('unhandledRejection', onUnhandled);
    if (OUT_PATH) {
      const held = rows.filter(r => r.outcome === 'HELD').length;
      const report = {
        unit: 'scr-manageaccountscreen',
        lens: 'rapid-interaction',
        generatedAt: new Date().toISOString(),
        config: {
          iterations: rows.length,
          baseSeed: BASE_SEED,
          explicitSeeds: EXPLICIT_SEEDS,
          sameTickEnabled: SAME_TICK_ENABLED,
          strict: STRICT,
        },
        totals: {
          iterations: rows.length,
          bursts: rows.reduce((n, r) => n + r.bursts.length, 0),
          held,
          broken: rows.length - held,
          withSyntheticOnly: rows.filter(
            r => r.violations.length === 0 && r.synthetic.length > 0,
          ).length,
          violationsByRule: rows
            .flatMap(r => r.violations)
            .reduce<Record<string, number>>((acc, v) => {
              acc[v.rule] = (acc[v.rule] ?? 0) + 1;
              return acc;
            }, {}),
          syntheticByRule: rows
            .flatMap(r => r.synthetic)
            .reduce<Record<string, number>>((acc, v) => {
              acc[v.rule] = (acc[v.rule] ?? 0) + 1;
              return acc;
            }, {}),
          brokenSeeds: rows
            .filter(r => r.outcome === 'BROKEN')
            .map(r => r.seed),
        },
        rows,
      };
      fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
      fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
    }
  });

  beforeEach(() => {
    jest.useFakeTimers();
    // Native module boundary: the App Store subscription link opens outside
    // the app; only the call count matters here.
    openUrlSpy = jest
      .spyOn(Linking, 'openURL')
      .mockImplementation(() => Promise.resolve());
    consoleCalls.length = 0;
    unhandled.length = 0;
    activeIntervals.clear();
    const capture = (level: string, args: unknown[]) => {
      const text = `${level}: ${args.map(String).join(' ')}`;
      consoleCalls.push(DEBUG ? `${text}\n${new Error().stack ?? ''}` : text);
    };
    errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args) => capture('error', args));
    warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation((...args) => capture('warn', args));
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    setIntervalSpy = jest.spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: Parameters<typeof setInterval>[0],
      timeout?: number,
      ...args: unknown[]
    ) => {
      const id = realSetInterval(handler, timeout, ...args);
      activeIntervals.add(id);
      return id;
    }) as typeof setInterval);
    clearIntervalSpy = jest
      .spyOn(globalThis, 'clearInterval')
      .mockImplementation(((id: unknown) => {
        activeIntervals.delete(id);
        realClearInterval(id as ReturnType<typeof setInterval>);
      }) as typeof clearInterval);
  });

  afterEach(() => {
    openUrlSpy.mockRestore();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  it.each(SEEDS)(
    'seed %d holds every rapid-interaction invariant',
    async seed => {
      const row = await runIteration(seed);
      rows.push(row);
      if (row.outcome !== 'HELD') {
        throw new Error(
          `seed ${seed} BROKEN\n` +
            row.violations
              .map(
                v =>
                  `  [burst ${v.burst}] ${v.rule}${v.sameTick ? ' (same-tick)' : ''}: ${v.detail}`,
              )
              .join('\n') +
            `\nbursts:\n  ${row.bursts.join('\n  ')}`,
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // Minimized, deterministic replays of the campaign's failure classes.
  // Each one is the shortest burst sequence that reproduces a violation
  // (campaign seeds 4811 / 4714 / 4927 with BASE_SEED 4711, STRESS_ITER=300).
  // -------------------------------------------------------------------------

  async function mountOnManageAccount() {
    const queryClient = new QueryClient();
    useApiSessionStore.setState({ session: apiSession });
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      deletionCleanup: null,
    });
    let renderer!: Renderer;
    await act(async () => {
      renderer = TestRenderer.create(<Harness queryClient={queryClient} />);
    });
    await flush();
    await act(async () => {
      findPressable(renderer.root, 'Manage account')?.props.onPress();
    });
    await flush();
    expect(onManageAccount(renderer.root)).toBe(true);
    return {
      renderer,
      async unmount() {
        await act(async () => {
          renderer.unmount();
        });
        queryClient.clear();
      },
    };
  }

  async function tap(renderer: Renderer, label: string) {
    const node = findPressable(renderer.root, label);
    expect(node).not.toBeNull();
    expect(node?.props.disabled).not.toBe(true);
    await act(async () => {
      node?.props.onPress();
    });
    await flush();
  }

  it('minimized: navigate("Tabs") from ManageAccount lands on a single Tabs route (seed 4811, burst 3)', async () => {
    const { unmount } = await mountOnManageAccount();
    try {
      expect(routeNames()).toEqual(['Tabs', 'ManageAccount']);
      await act(async () => {
        // The notification-press routing in RootNavigator issues exactly this.
        navRef.navigate('Tabs');
      });
      await flush();
      expect(routeNames()).toEqual(['Tabs']);
    } finally {
      await unmount();
    }
  });

  it('minimized: leaving the screen mid-request clears the countdown interval (seed 4714, bursts 15-21)', async () => {
    const fetchStub = new FetchStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub.fetch as typeof fetch;
    const { renderer, unmount } = await mountOnManageAccount();
    try {
      await tap(renderer, 'Delete account');
      await tap(renderer, 'Skip the survey');
      await tap(renderer, 'Continue to delete');
      expect(fetchStub.pending).toHaveLength(1);
      expect(busyVisible(renderer.root)).toBe(true);
      await act(async () => {
        navRef.goBack();
      });
      await flush();
      expect(onManageAccount(renderer.root)).toBe(false);
      const pending = fetchStub.pending[0];
      expect(pending).toBeDefined();
      if (pending) {
        await act(async () => {
          fetchStub.settle(pending, 'ok', 'not_applicable');
        });
      }
      await flush();
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      await flush();
      expect([...activeIntervals]).toHaveLength(0);
    } finally {
      await unmount();
      globalThis.fetch = originalFetch;
    }
  });

  it('minimized: a triple tap on the subscription link opens the store once (seed 4927, burst 2)', async () => {
    const { renderer, unmount } = await mountOnManageAccount();
    try {
      await tap(renderer, 'Delete account');
      await tap(renderer, 'Skip the survey');
      const label = pressableLabels(renderer.root).find(l =>
        l.startsWith('Manage subscription'),
      );
      expect(label).toBeDefined();
      if (!label) return;
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          findPressable(renderer.root, label)?.props.onPress();
        });
      }
      await flush();
      expect(openUrlSpy).toHaveBeenCalledTimes(1);
    } finally {
      await unmount();
    }
  });
});
