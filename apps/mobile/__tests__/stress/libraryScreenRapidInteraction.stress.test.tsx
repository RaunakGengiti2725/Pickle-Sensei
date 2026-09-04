/**
 * STRESS — LibraryScreen · rapid / concurrent interaction.
 *
 * The REAL `RootNavigator` (NavigationContainer → native stack → bottom tabs
 * with the app's PremiumTabBar) is rendered with the REAL LibraryScreen, the
 * REAL training / auth / access Zustand stores, the REAL local repository
 * (`listShots`, `listPendingCaptures`) and the REAL `createTrainingApi`. Only
 * three planes are faked, all of them native/network boundaries:
 *
 *   - the SQLite driver behind `getDb()` (seeded latency + failure);
 *   - `fetch` handed to `createTrainingApi` (seeded latency + failure,
 *     server-side saved-drill state that DELETE really mutates);
 *   - `Linking` (seeded `canOpenURL` outcome + latency);
 *
 * plus the sibling screens the navigator registers (Home, Result, Analyze,
 * DrillLibrary, …) which are replaced by tiny marker screens so the harness
 * can observe route mounts/unmounts and go back from them. Native-only
 * modules (safe-area, linear-gradient, notifications) are mocked as in the
 * repo's other navigator tests.
 *
 * A seeded generator scripts bursts of double/triple taps, taps on two
 * controls in the same tick, taps while reads/fetches are still in flight,
 * back-navigation during async work and bottom-tab / stack navigation spam.
 * Every iteration is replayable from its seed alone: all randomness (dataset,
 * latencies, failures, tap script) derives from it and time is fake.
 *
 * Invariants checked per iteration (violations → BROKEN seed):
 *   I1  no console.error / console.warn (act() warnings, unhandled navigation
 *       actions, key warnings, state-update-after-unmount, …)
 *   I2  no unhandled promise rejection
 *   I3  a tap burst on one control pushes at most ONE route (depth +1) and
 *       the root stack never holds the same route twice IN A ROW — navigation
 *       spam yields one push per intent. Distinct controls hit inside one
 *       transition window may legitimately stack distinct routes (even
 *       A>B>A); that is recorded (`distinctStackedPushes`), not a violation
 *   I4  repository reads: `listShots` and `listPendingCaptures` are always
 *       issued as a pair, and the number of pairs equals (Library focus
 *       gains + effective "Try again" taps) — one read per intent
 *   I5  reads UI is consistent with the newest issued read once settled:
 *       success → row count / pending count match that read's dataset;
 *       failure → error card; never the loading state (no orphan spinner)
 *   I6  saved tab once settled: no "Loading saved drills…" spinner,
 *       `mutation === 'idle'`, savedStatus ∈ {ready,error,unconfigured},
 *       rendered cards == store's verified drills == server-side saved set
 *   I7  every unsave intent produced exactly one DELETE regardless of how
 *       many taps landed (a server-refused DELETE may be retried by a later
 *       tap — one more, never two in flight at once)
 *   I8  at most one BrandNotice dialog visible at any time, and never more
 *       than the two Modals the tree owns (coach menu + notice host)
 *   I9  the segmented control reflects the LAST tap of a tab burst
 *   I10 no console noise after unmount + 5s of fake time (leaked async)
 *
 * Touch reachability model: a control is tappable only when the screen that
 * owns it is on top of the root stack, OR for TRANSITION_MS (350ms of fake
 * time — the length of a native stack transition) after a push started, so
 * "tap during transition" reaches the screen underneath while later taps on
 * a covered screen are dropped as the responder system would drop them.
 * While a Modal (coach menu, BrandNotice) is up only its own controls are
 * tappable. A burst on an index-addressed control (row, saved-drill card)
 * stays bound to the control the first press hit even if the list re-flows.
 *
 * Also recorded (informational, never asserted): Linking.openURL calls per
 * "Watch form" tap burst, distinct-route stacking — see the campaign JSON.
 *
 * Findings the campaign reproduced are minimized into the "minimized repros"
 * describe block at the bottom (each pins the observed behaviour and names
 * the expected one) and listed in KNOWN_FINDINGS; a campaign seed whose only
 * violations match a known finding is still written as BROKEN in the JSON
 * but does not fail the batch — anything else does.
 *
 * Campaign controls (env):
 *   STRESS_ITER  number of seeds to run (default 24 — fast enough for CI)
 *   STRESS_SEED  first seed (default 1); seeds are SEED..SEED+ITER-1
 *   STRESS_SEEDS comma-separated explicit seed list (overrides the range)
 *   STRESS_OUT   path to write the JSON seed → outcome table
 *   STRESS_BATCH seeds per jest test (default 6; bounds the 30s test timeout)
 *
 * Replay one failing seed:
 *   STRESS_SEEDS=1234 npx jest --ci __tests__/stress/libraryScreenRapidInteraction
 */
import React, { useEffect } from 'react';
import { FlatList, Linking, Modal, Pressable, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  NavigationContainerRef,
  NavigationState,
  ParamListBase,
} from '@react-navigation/native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SHOT_TYPES } from '@pickle/shared-types';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { BrandNoticeHost } from '../../src/design/BrandNotice';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useAccessStore } from '../../src/state/accessStore';
import {
  configureTrainingStore,
  clearTrainingStoreConfiguration,
  useTrainingStore,
} from '../../src/training/store';
import { createTrainingApi } from '../../src/training/api';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { LocalDb } from '../../src/data/db';
import {
  READS_LOAD_ERROR_TITLE,
  LibraryScreen,
} from '../../src/screens/LibraryScreen';

// ───────────────────────── native / network boundary mocks ──────────────────

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

jest.mock('react-native-linear-gradient', () => {
  const RN = require('react-native');
  return { __esModule: true, default: RN.View, LinearGradient: RN.View };
});

jest.mock('../../src/notifications/service', () => ({
  subscribeToNotificationPresses: () => () => {},
}));

// The SQLite driver is the only thing faked on the data plane; the real
// repository issues real SQL against it.
jest.mock('../../src/data/db', () => ({
  getDb: () => mockWorld.current!.db,
}));

// Sibling screens → observable marker screens. Factories run at import time,
// so they only reference `mockMarkerScreen` lazily (at render time).
type MarkerProps = { onBack?: () => void; onClose?: () => void };
jest.mock('../../src/screens/HomeScreen', () => ({
  HomeScreen: (p: MarkerProps) => mockMarkerScreen('Home', p),
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: (p: MarkerProps) => mockMarkerScreen('Performance', p),
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: (p: MarkerProps) => mockMarkerScreen('Settings', p),
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: (p: MarkerProps) => mockMarkerScreen('Analyze', p),
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: (p: MarkerProps) => mockMarkerScreen('DrillLibrary', p),
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: (p: MarkerProps) => mockMarkerScreen('Result', p),
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: (p: MarkerProps) => mockMarkerScreen('ResultDetails', p),
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: (p: MarkerProps) => mockMarkerScreen('FormReview', p),
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: (p: MarkerProps) =>
    mockMarkerScreen('StreakCalendar', p),
}));
jest.mock('../../src/screens/PaywallScreen', () => ({
  PaywallScreen: (p: MarkerProps) => mockMarkerScreen('Paywall', p),
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: (p: MarkerProps) => mockMarkerScreen('ConnectAccount', p),
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: (p: MarkerProps) => mockMarkerScreen('ManageAccount', p),
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: (p: MarkerProps) =>
    mockMarkerScreen('ConsentSettings', p),
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: (p: MarkerProps) =>
    mockMarkerScreen('NotificationSettings', p),
}));

// Spy (not stub) on NavigationContainer so the harness can read the root
// state and observe every committed state change of the REAL container.
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  // React 19: `ref` reaches function components as a plain prop.
  const Spied = (props: unknown) =>
    mockNav.spied(actual.NavigationContainer, props as SpiedContainerProps);
  return { ...actual, NavigationContainer: Spied };
});

type ContainerHandle = NavigationContainerRef<ParamListBase> | null;
interface SpiedContainerProps {
  ref?: React.Ref<ContainerHandle>;
  onReady?: () => void;
  onStateChange?: (state: NavigationState | undefined) => void;
}

// ───────────────────────────── seeded RNG ───────────────────────────────────

/** mulberry32 — tiny, well distributed, replayable from a 32-bit seed. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, maxInclusive: number) =>
      min + Math.floor(next() * (maxInclusive - min + 1)),
    chance: (p: number) => next() < p,
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)]!;
    },
    weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
      const total = items.reduce((sum, [, w]) => sum + w, 0);
      let roll = next() * total;
      for (const [item, w] of items) {
        roll -= w;
        if (roll < 0) return item;
      }
      return items[items.length - 1]![0];
    },
  };
}
type Rng = ReturnType<typeof makeRng>;

// ───────────────────────────── world (per seed) ─────────────────────────────

interface Profile {
  account: 'synced' | 'guest';
  /** synced accounts: premium (Analyze opens) or free-tier exhausted (Analyze
   * is replaced by Paywall by useRatingRouteGate). */
  access: 'premium' | 'paywalled';
  shots: number;
  pending: number;
  dbLatency: 'instant' | 'fast' | 'slow' | 'mixed';
  dbFailRate: number;
  netLatency: 'instant' | 'fast' | 'slow' | 'mixed';
  netFailRate: number;
  detailFailRate: number;
  savedDrills: number;
  hasPlan: boolean;
  linkingOpens: boolean;
}

interface ReadCall {
  id: number;
  table: 'local_shot' | 'local_capture';
  issuedAt: number;
  latency: number;
  fail: boolean;
  shotCount: number;
  pendingCount: number;
}

interface FetchCall {
  id: number;
  method: string;
  path: string;
  issuedAt: number;
  latency: number;
  status: number;
}

interface World {
  seed: number;
  rng: Rng;
  profile: Profile;
  db: LocalDb;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  inflight: number;
  reads: ReadCall[];
  fetches: FetchCall[];
  server: { saved: string[]; hasPlan: boolean };
  linkingCalls: { canOpen: number; open: number };
  markerMounts: string[];
  markerUnmounts: string[];
}

const mockWorld: { current: World | null } = { current: null };

const TRANSITION_MS = 350;

const mockNav: {
  handle: ContainerHandle;
  states: NavigationState[];
  lastPushAt: number;
  onState: (state: NavigationState | undefined) => void;
  spied: (
    Container: React.ComponentType<SpiedContainerProps>,
    props: SpiedContainerProps,
  ) => React.ReactElement;
} = {
  handle: null,
  states: [],
  lastPushAt: -Infinity,
  onState(state) {
    if (!state) return;
    const previous = mockNav.states[mockNav.states.length - 1];
    if (previous && state.routes.length > previous.routes.length) {
      mockNav.lastPushAt = Date.now();
    }
    mockNav.states.push(state);
  },
  spied(Container, props) {
    const { ref, onReady, onStateChange, ...rest } = props;
    return (
      <Container
        {...rest}
        ref={(handle: ContainerHandle) => {
          mockNav.handle = handle;
          if (typeof ref === 'function') ref(handle);
          else if (ref) {
            (ref as React.MutableRefObject<ContainerHandle>).current = handle;
          }
        }}
        onReady={() => {
          mockNav.onState(rootState());
          onReady?.();
        }}
        onStateChange={state => {
          mockNav.onState(state);
          onStateChange?.(state);
        }}
      />
    );
  },
};

function mockMarkerScreen(name: string, props: MarkerProps) {
  const navigation = useNavigation();
  const route = useRoute();
  useEffect(() => {
    mockWorld.current?.markerMounts.push(`${name}:${route.key}`);
    return () => {
      mockWorld.current?.markerUnmounts.push(`${name}:${route.key}`);
    };
  }, [name, route.key]);
  const leave = () => {
    if (props.onBack) props.onBack();
    else if (props.onClose) props.onClose();
    else if (navigation.canGoBack()) navigation.goBack();
  };
  return (
    <View>
      <Text>{`marker:${name}`}</Text>
      <Pressable accessibilityLabel={`Leave ${name}`} onPress={leave}>
        <Text>Leave</Text>
      </Pressable>
    </View>
  );
}

const SYNCED_SESSION: AuthSession = {
  provider: 'apple',
  subject: '11111111-2222-4333-8444-555555555555',
  canonicalAppUserId: '11111111-2222-4333-8444-555555555555',
  localOnly: false,
  displayName: 'Stress Tester',
  email: null,
};

const GUEST_SESSION: AuthSession = {
  provider: 'guest',
  subject: 'device-guest',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
};

const DRILL_SLUGS = [
  'dink-target-ladder',
  'third-shot-drop-lane',
  'reset-block-wall',
] as const;

function uuidFor(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `a0000000-0000-4000-8000-${hex}`;
}

function latencyFor(rng: Rng, mode: Profile['dbLatency']): number {
  switch (mode) {
    case 'instant':
      return 0;
    case 'fast':
      return rng.int(1, 40);
    case 'slow':
      return rng.int(120, 600);
    case 'mixed':
      return rng.weighted<number>([
        [0, 1],
        [rng.int(1, 40), 2],
        [rng.int(41, 200), 2],
        [rng.int(201, 700), 1],
      ]);
  }
}

function drillPayload(slug: string, saved: boolean) {
  const index = DRILL_SLUGS.indexOf(slug as (typeof DRILL_SLUGS)[number]);
  return {
    id: uuidFor(100 + index),
    slug,
    title: `Drill ${index + 1} ${slug}`,
    description: 'Reviewed drill description.',
    coach_name: 'Pickle Sensei Training Library',
    equipment: ['paddle'],
    difficulty_min: null,
    difficulty_max: null,
    saved,
  };
}

function planPayload(rng: Rng, saved: string[]) {
  const slug = DRILL_SLUGS[0];
  return {
    id: uuidFor(500),
    status: 'active',
    algorithmVersion: 'v1',
    sourceShotId: uuidFor(600),
    shotType: rng.pick(SHOT_TYPES),
    priorityCheckpoint: 'contact_position',
    priorityDirection: 'too_late',
    baselineScore: 6.1,
    baselineCheckpointScore: 52,
    reassessmentShotId: null,
    scoreDelta: null,
    createdAt: '2026-08-30T10:00:00.000Z',
    completedAt: null,
    items: [
      {
        id: uuidFor(700),
        position: 1,
        kind: 'targeted',
        drill: {
          slug,
          title: `Drill 1 ${slug}`,
          description: 'Reviewed drill description.',
          coachName: 'Pickle Sensei Training Library',
          equipment: [],
          saved: saved.includes(slug),
        },
        cueText: null,
        targetSets: 3,
        targetRepetitionsPerSet: 10,
        targetDurationSeconds: null,
        restSeconds: null,
        completion: null,
      },
    ],
  };
}

function makeProfile(rng: Rng): Profile {
  return {
    account: rng.weighted<Profile['account']>([
      ['synced', 5],
      ['guest', 1],
    ]),
    access: rng.weighted<Profile['access']>([
      ['premium', 3],
      ['paywalled', 1],
    ]),
    shots: rng.weighted<number>([
      [0, 2],
      [rng.int(1, 4), 4],
      [rng.int(5, 30), 2],
    ]),
    pending: rng.weighted<number>([
      [0, 3],
      [rng.int(1, 3), 2],
    ]),
    dbLatency: rng.pick(['instant', 'fast', 'slow', 'mixed'] as const),
    dbFailRate: rng.weighted<number>([
      [0, 4],
      [0.2, 2],
      [0.6, 1],
    ]),
    netLatency: rng.pick(['instant', 'fast', 'slow', 'mixed'] as const),
    netFailRate: rng.weighted<number>([
      [0, 4],
      [0.15, 2],
      [0.5, 1],
    ]),
    detailFailRate: rng.weighted<number>([
      [0, 4],
      [0.3, 1],
    ]),
    savedDrills: rng.int(0, DRILL_SLUGS.length),
    hasPlan: rng.chance(0.5),
    linkingOpens: rng.chance(0.7),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeWorld(seed: number, overrides: Partial<Profile> = {}): World {
  const rng = makeRng(seed);
  const profile = { ...makeProfile(rng), ...overrides };
  const world: World = {
    seed,
    rng,
    profile,
    db: null as unknown as LocalDb,
    fetch: null as unknown as World['fetch'],
    inflight: 0,
    reads: [],
    fetches: [],
    server: {
      saved: DRILL_SLUGS.slice(0, profile.savedDrills),
      hasPlan: profile.hasPlan,
    },
    linkingCalls: { canOpen: 0, open: 0 },
    markerMounts: [],
    markerUnmounts: [],
  };

  // Each read gets its own dataset snapshot so a stale read that lands late
  // is detectable: the row count encodes which read produced the UI.
  let readId = 0;
  world.db = {
    execute: async (sql: string) => {
      const table = sql.includes('FROM local_shot')
        ? 'local_shot'
        : sql.includes('FROM local_capture')
          ? 'local_capture'
          : null;
      if (!table) throw new Error(`stress db: unexpected SQL ${sql}`);
      const id = ++readId;
      const call: ReadCall = {
        id,
        table,
        issuedAt: Date.now(),
        latency: latencyFor(rng, profile.dbLatency),
        fail: rng.chance(profile.dbFailRate),
        shotCount:
          profile.shots === 0 ? 0 : Math.max(1, profile.shots + rng.int(-1, 1)),
        pendingCount: profile.pending,
      };
      world.reads.push(call);
      world.inflight += 1;
      try {
        if (call.latency > 0) await wait(call.latency);
        if (call.fail) throw new Error('stress db: simulated read failure');
        if (table === 'local_shot') {
          return {
            rows: Array.from({ length: call.shotCount }, (_, i) => ({
              id: uuidFor(1000 * id + i),
              session_id: null,
              shot_type: SHOT_TYPES[(id + i) % SHOT_TYPES.length],
              captured_at: new Date(
                1_756_000_000_000 - i * 60_000,
              ).toISOString(),
              overall_score: i % 3 === 0 ? null : 5 + (i % 5),
              confidence: 0.8,
              result_kind: i % 3 === 0 ? 'abstained' : 'scored',
              source: 'real',
              favorite: 0,
            })),
          };
        }
        return {
          rows: Array.from({ length: call.pendingCount }, (_, i) => ({
            id: uuidFor(2000 * id + i),
            uri: `file:///stress/${id}-${i}.mov`,
            shot_type: SHOT_TYPES[i % SHOT_TYPES.length],
            declared_stroke: SHOT_TYPES[i % SHOT_TYPES.length],
            captured_at: new Date(1_756_000_000_000 - i * 30_000).toISOString(),
            duration_ms: 4000,
            fps: 60,
            width: 1080,
            height: 1920,
            payload: null,
          })),
        };
      } finally {
        world.inflight -= 1;
      }
    },
    close: () => {},
  };

  let fetchId = 0;
  world.fetch = async (input: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    const url = new URL(input);
    const path = url.pathname;
    const id = ++fetchId;
    const isDetail = method === 'GET' && path.startsWith('/v1/catalog/drills/');
    const failRate = isDetail ? profile.detailFailRate : profile.netFailRate;
    const status = rng.chance(failRate) ? 503 : 200;
    const call: FetchCall = {
      id,
      method,
      path,
      issuedAt: Date.now(),
      latency: latencyFor(rng, profile.netLatency),
      status,
    };
    world.fetches.push(call);
    world.inflight += 1;
    try {
      if (call.latency > 0) await wait(call.latency);
      // Server-side state is read/mutated when the request "arrives".
      let body: unknown;
      if (status !== 200) {
        body = {
          error: {
            code: 'training.request_failed',
            message: 'Simulated outage.',
          },
        };
      } else if (method === 'GET' && path === '/v1/me/saved-drills') {
        body = {
          items: world.server.saved.map(slug => ({
            ...drillPayload(slug, true),
            saved_at: '2026-08-30T10:00:00.000Z',
          })),
        };
      } else if (isDetail) {
        const slug = decodeURIComponent(
          path.slice('/v1/catalog/drills/'.length),
        );
        body = {
          drill: drillPayload(slug, world.server.saved.includes(slug)),
          mappings: [],
          instructionalMedia: [
            {
              id: uuidFor(300 + DRILL_SLUGS.indexOf(slug as never)),
              kind: 'embed',
              provider: 'youtube',
              videoId: `vid${DRILL_SLUGS.indexOf(slug as never)}`,
              embedUrl: `https://www.youtube-nocookie.com/embed/vid${DRILL_SLUGS.indexOf(slug as never)}`,
              sourceUrl: `https://www.youtube.com/watch?v=vid${DRILL_SLUGS.indexOf(slug as never)}`,
              creatorName: 'Third Shot Sports',
              licenseName: 'YouTube Terms of Service',
              licenseUrl: 'https://www.youtube.com/t/terms',
              attribution: 'Video by Third Shot Sports on YouTube',
            },
          ],
        };
      } else if (method === 'GET' && path === '/v1/training-plans/current') {
        body = {
          plan: world.server.hasPlan
            ? planPayload(rng, world.server.saved)
            : null,
        };
      } else if (
        method === 'DELETE' &&
        path.startsWith('/v1/me/saved-drills/')
      ) {
        const slug = decodeURIComponent(
          path.slice('/v1/me/saved-drills/'.length),
        );
        world.server.saved = world.server.saved.filter(s => s !== slug);
        return {
          status: 204,
          ok: true,
          json: async () => null,
        } as unknown as Response;
      } else {
        throw new Error(`stress fetch: unexpected ${method} ${path}`);
      }
      return {
        status,
        ok: status === 200,
        json: async () => body,
      } as unknown as Response;
    } finally {
      world.inflight -= 1;
    }
  };
  return world;
}

// ───────────────────────────── tree helpers ─────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function pressables(renderer: Renderer): Instance[] {
  return renderer.root.findAll(
    n =>
      n.props !== null &&
      typeof n.props.onPress === 'function' &&
      (typeof n.props.accessibilityLabel === 'string' ||
        n.props.accessibilityRole === 'tab'),
  );
}

function byLabel(renderer: Renderer, label: string): Instance | null {
  return (
    pressables(renderer).find(n => n.props.accessibilityLabel === label) ?? null
  );
}

function byLabelPrefix(renderer: Renderer, prefix: string): Instance[] {
  const seen = new Set<string>();
  return pressables(renderer).filter(n => {
    const label = n.props.accessibilityLabel;
    if (typeof label !== 'string' || !label.startsWith(prefix)) return false;
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

/** LibraryScreen's segmented control: role=tab with a child Text label. */
function segmentTab(renderer: Renderer, label: 'Reads' | 'Saved drills') {
  return (
    renderer.root
      .findAll(
        n =>
          n.props.accessibilityRole === 'tab' &&
          typeof n.props.onPress === 'function' &&
          n.props.accessibilityLabel === undefined,
      )
      .find(n => n.findAll(c => c.props.children === label).length > 0) ?? null
  );
}

function texts(renderer: Renderer): string[] {
  return renderer.root.findAllByType(Text).map(t => {
    const c = t.props.children;
    return Array.isArray(c) ? c.join('') : String(c);
  });
}

function hasText(renderer: Renderer, needle: string): boolean {
  return texts(renderer).some(t => t.includes(needle));
}

function visibleModals(renderer: Renderer): number {
  return renderer.root
    .findAllByType(Modal)
    .filter(m => m.props.visible !== false).length;
}

function libraryFocused(state: NavigationState | undefined): boolean {
  if (!state || state.index !== 0) return false;
  const tabs = state.routes[0]?.state as NavigationState | undefined;
  if (!tabs) return false;
  return tabs.routes[tabs.index]?.name === 'Library';
}

function describeState(state: NavigationState): string {
  const tabs = state.routes[0]?.state as NavigationState | undefined;
  const tab = tabs ? tabs.routes[tabs.index]?.name : '?';
  return `${state.routes.map(r => r.name).join('>')}[${tab}]`;
}

/** Commits in which the focused tab changed AND the root stack grew — two
 * navigations batched into one React commit. */
function batchedTabPushes(states: NavigationState[]): number {
  let n = 0;
  for (let i = 1; i < states.length; i += 1) {
    const prev = states[i - 1]!;
    const next = states[i]!;
    const prevTabs = prev.routes[0]?.state as NavigationState | undefined;
    const nextTabs = next.routes[0]?.state as NavigationState | undefined;
    const tabChanged =
      prevTabs &&
      nextTabs &&
      prevTabs.routes[prevTabs.index]?.key !==
        nextTabs.routes[nextTabs.index]?.key;
    if (tabChanged && next.routes.length > prev.routes.length) n += 1;
  }
  return n;
}

function focusGains(states: NavigationState[]): number {
  let gains = 0;
  let focused = false;
  for (const state of states) {
    const now = libraryFocused(state);
    if (now && !focused) gains += 1;
    focused = now;
  }
  return gains;
}

// ───────────────────────────── script model ─────────────────────────────────

type StepKind =
  | 'openLibraryTab'
  | 'segment'
  | 'row'
  | 'emptyCta'
  | 'explore'
  | 'plan'
  | 'unsave'
  | 'watch'
  | 'retryReads'
  | 'retrySaved'
  | 'dismissError'
  | 'dismissNotice'
  | 'connect'
  | 'leave'
  | 'bottomTab'
  | 'coach'
  | 'simul'
  | 'advance';

interface Step {
  kind: StepKind;
  times: number;
  gapMs: number;
  arg?: string | number;
}

interface StepLog extends Step {
  landed: number;
  ignored: number;
  note?: string;
}

interface IterationRecord {
  seed: number;
  profile: Profile;
  steps: StepLog[];
  bursts: number;
  taps: number;
  counts: {
    readPairs: number;
    focusGains: number;
    retryReadsLanded: number;
    getSaved: number;
    getDetail: number;
    getPlan: number;
    deletes: number;
    unsaveIntents: number;
    watchTaps: number;
    openUrl: number;
    canOpenUrl: number;
    pushes: number;
    distinctStackedPushes: number;
    batchedTabPush: number;
    markerMounts: number;
    maxStackDepth: number;
  };
  navTrail: string[];
  violations: string[];
  /** violations matching an already-minimized finding (see KNOWN_FINDINGS) */
  knownViolations: string[];
  consoleErrors: string[];
  consoleWarns: string[];
  unhandledRejections: string[];
  outcome: 'HELD' | 'BROKEN';
  durationMs: number;
}

const STEP_MENU: ReadonlyArray<readonly [StepKind, number]> = [
  ['segment', 8],
  ['row', 8],
  ['emptyCta', 3],
  ['explore', 5],
  ['plan', 4],
  ['unsave', 6],
  ['watch', 4],
  ['retryReads', 5],
  ['retrySaved', 3],
  ['dismissError', 2],
  ['dismissNotice', 3],
  ['connect', 2],
  ['leave', 8],
  ['bottomTab', 6],
  ['coach', 3],
  ['simul', 6],
  ['advance', 7],
];

const COACH_ACTIONS = [
  'Auto Analyze',
  'Import Video',
  'Drill Library',
  'Close coach actions',
] as const;

const RESULT_ROW = /^Open .+ result$/;

function resultRows(renderer: Renderer): Instance[] {
  return pressables(renderer).filter(n =>
    RESULT_ROW.test(String(n.props.accessibilityLabel)),
  );
}

function rootState(): NavigationState | undefined {
  return mockNav.handle?.getRootState();
}

function resetNav() {
  mockNav.states = [];
  mockNav.handle = null;
  mockNav.lastPushAt = -Infinity;
}

function topRouteName(): string | null {
  const state = rootState();
  if (!state) return null;
  const top = state.routes[state.routes.length - 1];
  return top && top.name !== 'Tabs' ? top.name : null;
}

function leaveTop(renderer: Renderer): Instance | null {
  const top = topRouteName();
  return top ? byLabel(renderer, `Leave ${top}`) : null;
}

/** Tabs (Library screen + tab bar) receive touches only while on top or
 * during the transition that is covering them. */
function tabsReachable(): boolean {
  return (
    topRouteName() === null || Date.now() - mockNav.lastPushAt < TRANSITION_MS
  );
}

/** Host (native) dialog cards currently on screen — BrandDialog marks its
 * card `accessibilityViewIsModal`; counting host nodes only avoids double
 * counting the composite <View> and its RCTView. */
function visibleDialogs(renderer: Renderer): number {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' && n.props.accessibilityViewIsModal === true,
  ).length;
}

/** Pressables inside visible Modals. While any Modal is up, only these can
 * receive touches (the Modal covers everything underneath). */
function modalControls(renderer: Renderer): Set<Instance> | null {
  const modals = renderer.root
    .findAllByType(Modal)
    .filter(m => m.props.visible !== false);
  if (modals.length === 0) return null;
  const set = new Set<Instance>();
  for (const modal of modals) {
    for (const n of modal.findAll(
      n =>
        n.props !== null &&
        typeof n.props.onPress === 'function' &&
        typeof n.props.accessibilityLabel === 'string',
    )) {
      set.add(n);
    }
  }
  return set;
}

function reachable(node: Instance, renderer: Renderer): boolean {
  const inModal = modalControls(renderer);
  if (inModal) return inModal.has(node);
  const label = String(node.props.accessibilityLabel ?? '');
  if (label.startsWith('Leave ')) return label === `Leave ${topRouteName()}`;
  return tabsReachable();
}

function generateScript(rng: Rng): Step[] {
  const steps: Step[] = [];
  // The user always starts on Home and reaches Library through the tab bar,
  // sometimes with a stutter (double tap) — and sometimes before the initial
  // loads of the app have settled (advance 0).
  steps.push({
    kind: 'openLibraryTab',
    times: rng.weighted([
      [1, 3],
      [2, 1],
      [3, 1],
    ]),
    gapMs: rng.int(0, 16),
  });
  const length = rng.int(4, 14);
  for (let i = 0; i < length; i += 1) {
    const kind = rng.weighted(STEP_MENU);
    const times = rng.weighted([
      [1, 3],
      [2, 3],
      [3, 2],
    ]);
    const gapMs = rng.weighted([
      [0, 3],
      [rng.int(1, 16), 3],
      [rng.int(17, 120), 2],
    ]);
    let arg: string | number | undefined;
    if (kind === 'segment') arg = rng.pick(['Reads', 'Saved drills']);
    if (kind === 'bottomTab')
      arg = rng.pick(['Home', 'Library', 'Progress', 'Settings', 'Library']);
    if (kind === 'advance')
      arg = rng.weighted([
        [rng.int(0, 30), 3],
        [rng.int(31, 200), 2],
        [rng.int(201, 900), 1],
      ]);
    if (kind === 'row' || kind === 'unsave' || kind === 'watch')
      arg = rng.int(0, 4);
    if (kind === 'coach') arg = rng.int(0, COACH_ACTIONS.length - 1);
    if (kind === 'simul') arg = rng.int(0, 999);
    steps.push({ kind, times, gapMs, arg });
  }
  return steps;
}

// ───────────────────────────── one iteration ────────────────────────────────

async function tick(ms: number) {
  await act(async () => {
    if (ms > 0) await jest.advanceTimersByTimeAsync(ms);
    else await Promise.resolve();
  });
}

/** Drain fake time until nothing is in flight (bounded). */
async function settle(world: World, maxMs = 12_000) {
  let elapsed = 0;
  let quiet = 0;
  while (elapsed < maxMs) {
    await tick(50);
    elapsed += 50;
    if (world.inflight === 0 && jest.getTimerCount() === 0) quiet += 1;
    else quiet = 0;
    if (quiet >= 2) return;
  }
}

/** Real stores, configured the way authStore does for the given account. */
function configureStores(profile: Profile, world: World) {
  if (profile.account === 'synced') {
    setActiveDataOwner(SYNCED_SESSION.subject);
    useAuthStore.setState({
      hydrated: true,
      session: SYNCED_SESSION,
      busy: false,
      error: null,
    });
    configureTrainingStore(
      createTrainingApi({
        baseUrl: 'https://stress.invalid',
        token: 'stress-bearer',
        fetchFn: world.fetch,
      }),
    );
  } else {
    setActiveDataOwner(GUEST_DATA_OWNER);
    useAuthStore.setState({
      hydrated: true,
      session: GUEST_SESSION,
      busy: false,
      error: null,
    });
    clearTrainingStoreConfiguration();
  }
  const premium = profile.access === 'premium';
  useAccessStore.setState({
    status: 'ready',
    canonicalAccess: premium
      ? {
          premium: true,
          entitlements: ['pickle_sensei_pro'],
          freeRatings: {
            limit: 2,
            used: 0,
            reserved: 0,
            remaining: 2,
            availableToReserve: 2,
          },
          canStartRating: true,
          paywallRequired: false,
        }
      : {
          premium: false,
          entitlements: [],
          freeRatings: {
            limit: 2,
            used: 2,
            reserved: 0,
            remaining: 0,
            availableToReserve: 0,
          },
          canStartRating: false,
          paywallRequired: true,
        },
  });
}

async function runIteration(
  seed: number,
  sink: { errors: string[]; warns: string[]; rejections: string[] },
): Promise<IterationRecord> {
  const started = performance.now();
  const world = makeWorld(seed);
  mockWorld.current = world;
  resetNav();
  const { profile, rng } = world;
  configureStores(profile, world);

  const linkingCan = jest
    .spyOn(Linking, 'canOpenURL')
    .mockImplementation(async () => {
      world.linkingCalls.canOpen += 1;
      await wait(rng.int(0, 60));
      return profile.linkingOpens;
    });
  const linkingOpen = jest
    .spyOn(Linking, 'openURL')
    .mockImplementation(async () => {
      world.linkingCalls.open += 1;
      await wait(rng.int(0, 30));
    });

  const record: IterationRecord = {
    seed,
    profile,
    steps: [],
    bursts: 0,
    taps: 0,
    counts: {
      readPairs: 0,
      focusGains: 0,
      retryReadsLanded: 0,
      getSaved: 0,
      getDetail: 0,
      getPlan: 0,
      deletes: 0,
      unsaveIntents: 0,
      watchTaps: 0,
      openUrl: 0,
      canOpenUrl: 0,
      pushes: 0,
      distinctStackedPushes: 0,
      batchedTabPush: 0,
      markerMounts: 0,
      maxStackDepth: 0,
    },
    navTrail: [],
    violations: [],
    knownViolations: [],
    consoleErrors: [],
    consoleWarns: [],
    unhandledRejections: [],
    outcome: 'HELD',
    durationMs: 0,
  };
  const violate = (message: string) => {
    if (!record.violations.includes(message)) record.violations.push(message);
  };

  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <View style={{ flex: 1 }}>
        <RootNavigator />
        <BrandNoticeHost />
      </View>,
    );
  });
  if (rng.chance(0.5)) await settle(world);
  else await tick(rng.int(0, 40));

  // Per-burst invariants — checked after every committed burst.
  const checkStructural = (where: string) => {
    const state = rootState();
    if (state) {
      record.counts.maxStackDepth = Math.max(
        record.counts.maxStackDepth,
        state.routes.length,
      );
      // The same route directly on top of itself is what a double tap
      // produces (React Navigation 7 `navigate` pushes unless the target is
      // the current route). A>B>A from three distinct intents is legal.
      const names = state.routes.map(r => r.name);
      for (let i = 1; i < names.length; i += 1) {
        if (names[i] === names[i - 1]) {
          violate(
            `I3 duplicate route ${names[i]} after ${where}: ${names.join('>')}`,
          );
        }
      }
    }
    const modals = visibleModals(renderer);
    if (modals > 2) violate(`I8 ${modals} modals visible after ${where}`);
    const dialogs = visibleDialogs(renderer);
    if (dialogs > 1) violate(`I8 ${dialogs} dialogs visible after ${where}`);
  };

  const press = async (node: Instance | null, log: StepLog) => {
    if (!node) {
      log.ignored += 1;
      return false;
    }
    if (node.props.disabled === true) {
      log.ignored += 1;
      log.note = 'disabled';
      return false;
    }
    await act(async () => {
      node.props.onPress();
    });
    log.landed += 1;
    record.taps += 1;
    return true;
  };

  const resolve = (step: Step): (() => Instance | null) => {
    switch (step.kind) {
      case 'openLibraryTab':
        return () => byLabel(renderer, 'Library');
      case 'bottomTab':
        return () => byLabel(renderer, String(step.arg));
      case 'segment':
        return () => segmentTab(renderer, step.arg as 'Reads' | 'Saved drills');
      case 'row':
        return () => {
          const rows = resultRows(renderer);
          return rows.length ? rows[Number(step.arg) % rows.length]! : null;
        };
      case 'coach':
        return () =>
          byLabel(renderer, COACH_ACTIONS[Number(step.arg)]!) ??
          byLabel(renderer, 'Open coach actions');
      case 'emptyCta':
        return () => byLabel(renderer, 'Analyze your first stroke');
      case 'explore':
        return () => byLabel(renderer, 'Explore the Drill Library');
      case 'plan':
        return () => byLabel(renderer, 'Open your current personalized plan');
      case 'unsave':
        return () => {
          const nodes = byLabelPrefix(renderer, 'Remove ');
          return nodes.length ? nodes[Number(step.arg) % nodes.length]! : null;
        };
      case 'watch':
        return () => {
          const nodes = byLabelPrefix(
            renderer,
            'Watch reviewed instruction for ',
          );
          return nodes.length ? nodes[Number(step.arg) % nodes.length]! : null;
        };
      case 'retryReads':
        return () =>
          hasText(renderer, READS_LOAD_ERROR_TITLE)
            ? byLabel(renderer, 'Try again')
            : null;
      case 'retrySaved':
        return () =>
          hasText(renderer, READS_LOAD_ERROR_TITLE)
            ? null
            : byLabel(renderer, 'Try again');
      case 'dismissError':
        return () =>
          pressables(renderer).find(
            n => n.props.accessibilityHint === 'Dismisses this message',
          ) ?? null;
      case 'dismissNotice':
        return () =>
          byLabel(renderer, 'Got it') ?? byLabel(renderer, 'Close dialog');
      case 'connect':
        return () => byLabel(renderer, 'Connect account');
      case 'leave':
        return () => leaveTop(renderer);
      default:
        return () => null;
    }
  };

  const resolveReachable = (step: Step): (() => Instance | null) => {
    const find = resolve(step);
    return () => {
      const node = find();
      return node && reachable(node, renderer) ? node : null;
    };
  };

  const script = generateScript(rng);
  for (const step of script) {
    const log: StepLog = { ...step, landed: 0, ignored: 0 };
    record.steps.push(log);
    record.bursts += 1;

    if (step.kind === 'advance') {
      await tick(Number(step.arg));
      checkStructural(`advance ${step.arg}`);
      continue;
    }

    if (step.kind === 'simul') {
      // Two DIFFERENT controls pressed in the same JS tick (multi-touch).
      const candidates = pressables(renderer).filter(
        n => n.props.disabled !== true && reachable(n, renderer),
      );
      if (candidates.length >= 2) {
        const a = candidates[Number(step.arg) % candidates.length]!;
        const rest = candidates.filter(n => n !== a);
        const b = rest[(Number(step.arg) * 7 + 3) % rest.length]!;
        log.note = `${a.props.accessibilityLabel ?? 'tab'} + ${b.props.accessibilityLabel ?? 'tab'}`;
        const unsaveTaps = [a, b].filter(n =>
          String(n.props.accessibilityLabel ?? '').startsWith('Remove '),
        ).length;
        const watchTaps = [a, b].filter(n =>
          String(n.props.accessibilityLabel ?? '').startsWith('Watch '),
        ).length;
        const retryReads = hasText(renderer, READS_LOAD_ERROR_TITLE)
          ? [a, b].filter(n => n.props.accessibilityLabel === 'Try again')
              .length
          : 0;
        const deletesBefore = world.fetches.filter(
          f => f.method === 'DELETE',
        ).length;
        const depthBeforeSimul = rootState()?.routes.length ?? 1;
        await act(async () => {
          a.props.onPress();
          b.props.onPress();
        });
        log.landed = 2;
        record.taps += 2;
        const depthAfterSimul = rootState()?.routes.length ?? 1;
        if (depthAfterSimul - depthBeforeSimul > 1) {
          record.counts.distinctStackedPushes += 1;
          log.note = `${log.note} → stacked ${routeNames().join('>')}`;
        }
        record.counts.retryReadsLanded += retryReads;
        record.counts.watchTaps += watchTaps;
        if (unsaveTaps > 0) {
          record.counts.unsaveIntents += 1;
          const deletes =
            world.fetches.filter(f => f.method === 'DELETE').length -
            deletesBefore;
          if (deletes !== 1)
            violate(`I7 simultaneous unsave taps produced ${deletes} DELETEs`);
        }
      } else {
        log.ignored = 1;
      }
      checkStructural('simul');
      continue;
    }

    // A tap burst: `times` presses of the same intent, re-resolving the
    // target before each press exactly as the responder system would (a
    // control that vanished or got disabled after the first press simply
    // receives nothing).
    // Index-addressed controls (rows, cards) are bound to the control the
    // FIRST press hit: a finger does not follow a list that re-flows.
    const findAny = resolveReachable(step);
    let boundLabel: string | null = null;
    const find = () => {
      if (boundLabel === null) {
        const node = findAny();
        if (node && typeof node.props.accessibilityLabel === 'string') {
          boundLabel = node.props.accessibilityLabel;
        }
        return node;
      }
      const node = byLabel(renderer, boundLabel);
      return node && reachable(node, renderer) ? node : null;
    };
    const deletesBefore = world.fetches.filter(
      f => f.method === 'DELETE',
    ).length;
    const mountsBefore = world.markerMounts.length;
    // Pushes attributable to the taps themselves (a deferred coach-menu
    // action may push Analyze between two taps of the burst — not ours).
    let tapPushes = 0;
    let firstTapDepthBefore = 0;
    let firstTapDelta = 0;
    for (let i = 0; i < step.times; i += 1) {
      const node = find();
      const depthBeforeTap = rootState()?.routes.length ?? 1;
      const landed = await press(node, log);
      if (landed) {
        const delta = (rootState()?.routes.length ?? 1) - depthBeforeTap;
        tapPushes += Math.max(0, delta);
        if (log.landed === 1) {
          firstTapDepthBefore = depthBeforeTap;
          firstTapDelta = delta;
        }
      }
      if (landed && step.kind === 'retryReads')
        record.counts.retryReadsLanded += 1;
      if (landed && step.kind === 'watch') record.counts.watchTaps += 1;
      if (i < step.times - 1 && step.gapMs > 0) await tick(step.gapMs);
    }
    if (step.kind === 'unsave' && log.landed > 0) {
      record.counts.unsaveIntents += 1;
      // A DELETE the server refused re-enables the card; the next landed tap
      // is a legitimate retry (a new intent), never a duplicate.
      const burstDeletes = world.fetches
        .filter(f => f.method === 'DELETE')
        .slice(deletesBefore);
      const failed = burstDeletes.filter(f => f.status !== 200).length;
      if (burstDeletes.length < 1 || burstDeletes.length > 1 + failed)
        violate(
          `I7 unsave burst (${step.times} taps, ${log.landed} landed) produced ${burstDeletes.length} DELETEs (${failed} refused)`,
        );
    }
    if (
      log.landed > 0 &&
      (step.kind === 'row' ||
        step.kind === 'explore' ||
        step.kind === 'plan' ||
        step.kind === 'emptyCta' ||
        step.kind === 'connect')
    ) {
      record.counts.pushes += 1;
      const mounts = world.markerMounts.length - mountsBefore;
      // From Tabs the first tap pushes exactly one route; a tap during a
      // transition may be absorbed by the existing route (params update) or
      // stack one distinct route — but the burst never pushes more than one.
      if (tapPushes > 1 || (firstTapDepthBefore === 1 && firstTapDelta !== 1)) {
        violate(
          `I3 ${step.kind} burst (${step.times} taps, ${log.landed} landed) pushed ${tapPushes} routes, mounted ${mounts} screens: ${routeNames().join('>')}`,
        );
      }
    }
    if (step.kind === 'segment' && log.landed > 0) {
      const tab = segmentTab(renderer, step.arg as 'Reads' | 'Saved drills');
      if (tab && tab.props.accessibilityState?.selected !== true) {
        violate(
          `I9 segmented control does not show last tapped tab ${step.arg}`,
        );
      }
    }
    checkStructural(`${step.kind}×${step.times}`);
  }

  // ── Return to Library and settle, then check end-state consistency ──
  for (let guard = 0; guard < 4; guard += 1) {
    await settle(world);
    const leave = leaveTop(renderer);
    if (!leave) break;
    await act(async () => {
      leave.props.onPress();
    });
  }
  const closeCoach = byLabel(renderer, 'Close coach actions');
  if (closeCoach) {
    await act(async () => {
      closeCoach.props.onPress();
    });
  }
  const libTab = byLabel(renderer, 'Library');
  if (libTab) {
    await act(async () => {
      libTab.props.onPress();
    });
  }
  await settle(world);
  if (world.inflight !== 0)
    violate(`settle left ${world.inflight} requests in flight`);
  if (!libraryFocused(rootState())) {
    violate(
      `could not return to Library: ${JSON.stringify(rootState()?.routes.map(r => r.name))}`,
    );
  }

  // I4 — one read pair per focus gain / retry intent.
  const shotReads = world.reads.filter(r => r.table === 'local_shot');
  const captureReads = world.reads.filter(r => r.table === 'local_capture');
  record.counts.readPairs = shotReads.length;
  record.counts.focusGains = focusGains(mockNav.states);
  record.counts.batchedTabPush = batchedTabPushes(mockNav.states);
  record.navTrail = mockNav.states.map(describeState);
  if (shotReads.length !== captureReads.length) {
    violate(
      `I4 unpaired reads: ${shotReads.length} shot reads vs ${captureReads.length} capture reads`,
    );
  }
  const expectedReads =
    record.counts.focusGains + record.counts.retryReadsLanded;
  if (shotReads.length !== expectedReads) {
    violate(
      `I4 ${shotReads.length} read pairs for ${record.counts.focusGains} focus gains + ${record.counts.retryReadsLanded} retries`,
    );
  }

  // I5 — reads tab reflects the newest issued read.
  const readsTab = segmentTab(renderer, 'Reads');
  if (readsTab && readsTab.props.accessibilityState?.selected !== true) {
    await act(async () => {
      readsTab.props.onPress();
    });
  }
  const newestShots = shotReads[shotReads.length - 1];
  const newestCaptures = captureReads[captureReads.length - 1];
  if (newestShots && newestCaptures) {
    const loading = hasText(renderer, 'Opening your library…');
    const errored = hasText(renderer, READS_LOAD_ERROR_TITLE);
    const list = renderer.root.findAllByType(FlatList)[0];
    const rows = Array.isArray(list?.props.data)
      ? list.props.data.length
      : resultRows(renderer).length;
    if (loading)
      violate(
        'I5 reads tab still shows the loading state after settle (orphan loading)',
      );
    const shouldFail = newestShots.fail || newestCaptures.fail;
    if (shouldFail && !errored)
      violate('I5 newest read failed but no error card is shown');
    if (!shouldFail && errored)
      violate('I5 newest read succeeded but the error card is shown');
    if (!shouldFail && !errored && !loading) {
      if (
        newestShots.shotCount === 0 &&
        !hasText(renderer, 'Analyze your first stroke') &&
        !byLabel(renderer, 'Analyze your first stroke')
      ) {
        violate('I5 newest read was empty but the empty state is missing');
      }
      if (newestShots.shotCount > 0 && rows !== newestShots.shotCount) {
        violate(
          `I5 ${rows} rows rendered but newest read returned ${newestShots.shotCount}`,
        );
      }
      if (
        newestCaptures.pendingCount > 0 &&
        !hasText(renderer, 'NOT SCORED') &&
        newestShots.shotCount > 0
      ) {
        violate('I5 pending clips from the newest read are not rendered');
      }
    }
  } else if (
    shotReads.length === 0 &&
    !hasText(renderer, 'Opening your library…')
  ) {
    violate('I5 no read was ever issued yet the loading state is gone');
  }

  // I6 — saved tab is settled and matches the server.
  const savedTab = segmentTab(renderer, 'Saved drills');
  if (savedTab) {
    await act(async () => {
      savedTab.props.onPress();
    });
    const store = useTrainingStore.getState();
    if (hasText(renderer, 'Loading saved drills…'))
      violate(
        'I6 saved tab shows the loading state after settle (orphan loading)',
      );
    if (store.mutation !== 'idle')
      violate(`I6 mutation stuck at ${store.mutation}`);
    if (store.savedStatus === 'loading' || store.savedStatus === 'idle')
      violate(`I6 savedStatus ${store.savedStatus} after settle`);
    if (profile.account === 'guest' && store.savedStatus !== 'unconfigured')
      violate(`I6 guest savedStatus ${store.savedStatus}`);
    const cards = byLabelPrefix(renderer, 'Remove ');
    if (store.savedStatus === 'ready') {
      const verified = store.savedDrills.filter(
        d => store.drillDetails[d.slug] !== undefined,
      );
      if (cards.length !== verified.length)
        violate(
          `I6 ${cards.length} cards for ${verified.length} verified saved drills`,
        );
      const storeSlugs = [...store.savedDrills.map(d => d.slug)].sort();
      const serverSlugs = [...world.server.saved].sort();
      // The last GET that reached the server decides; if it was issued before
      // a DELETE landed and answered later, the client shows a resurrected
      // drill — exactly the stale-write hazard this lens hunts.
      if (JSON.stringify(storeSlugs) !== JSON.stringify(serverSlugs)) {
        violate(
          `I6 store saved ${JSON.stringify(storeSlugs)} ≠ server ${JSON.stringify(serverSlugs)}`,
        );
      }
      for (const card of cards) {
        if (card.props.disabled === true)
          violate('I6 unsave button left disabled after settle');
      }
    }
  }

  // Request tallies.
  record.counts.getSaved = world.fetches.filter(
    f => f.method === 'GET' && f.path === '/v1/me/saved-drills',
  ).length;
  record.counts.getDetail = world.fetches.filter(
    f => f.method === 'GET' && f.path.startsWith('/v1/catalog/drills/'),
  ).length;
  record.counts.getPlan = world.fetches.filter(
    f => f.method === 'GET' && f.path === '/v1/training-plans/current',
  ).length;
  record.counts.deletes = world.fetches.filter(
    f => f.method === 'DELETE',
  ).length;
  record.counts.openUrl = world.linkingCalls.open;
  record.counts.canOpenUrl = world.linkingCalls.canOpen;
  record.counts.markerMounts = world.markerMounts.length;
  const deletes = world.fetches.filter(f => f.method === 'DELETE');
  const refused = deletes.filter(f => f.status !== 200).length;
  if (
    deletes.length < record.counts.unsaveIntents ||
    deletes.length > record.counts.unsaveIntents + refused
  ) {
    violate(
      `I7 ${deletes.length} DELETEs (${refused} refused) for ${record.counts.unsaveIntents} unsave intents`,
    );
  }
  for (let i = 1; i < deletes.length; i += 1) {
    const prev = deletes[i - 1]!;
    if (deletes[i]!.issuedAt < prev.issuedAt + prev.latency) {
      violate(
        `I7 DELETE #${deletes[i]!.id} issued while DELETE #${prev.id} was still in flight`,
      );
    }
  }
  if (profile.account === 'guest' && world.fetches.length > 0) {
    violate(`guest account issued ${world.fetches.length} network requests`);
  }
  checkStructural('end');

  // I10 — unmount and let any leaked async settle.
  await act(async () => {
    renderer.unmount();
  });
  await settle(world, 5_000);
  // Flush a real macrotask so Node reports unhandled rejections.
  await new Promise<void>(resolveNow => setImmediate(resolveNow));

  linkingCan.mockRestore();
  linkingOpen.mockRestore();

  record.consoleErrors = sink.errors.splice(0);
  record.consoleWarns = sink.warns.splice(0);
  record.unhandledRejections = sink.rejections.splice(0);
  if (record.consoleErrors.length)
    violate(
      `I1 console.error ×${record.consoleErrors.length}: ${record.consoleErrors[0]!.slice(0, 200)}`,
    );
  if (record.consoleWarns.length)
    violate(
      `I1 console.warn ×${record.consoleWarns.length}: ${record.consoleWarns[0]!.slice(0, 200)}`,
    );
  if (record.unhandledRejections.length)
    violate(
      `I2 unhandled rejection ×${record.unhandledRejections.length}: ${record.unhandledRejections[0]!.slice(0, 200)}`,
    );

  record.knownViolations = record.violations.filter(v =>
    KNOWN_FINDINGS.some(f => f.matches(v, record)),
  );
  record.outcome = record.violations.length ? 'BROKEN' : 'HELD';
  record.durationMs = Math.round(performance.now() - started);
  mockWorld.current = null;
  return record;
}

// ───────────────────────── known (minimized) findings ───────────────────────
//
// Each entry is a failure the campaign reproduced, minimized into its own
// pinned repro below. The campaign still records the seed as BROKEN in the
// JSON table, but only violations that match NONE of these fail the batch —
// so the suite stays red for anything new, and the pinned repro goes red the
// day the underlying behaviour is fixed (then delete both).
const KNOWN_FINDINGS: ReadonlyArray<{
  id: string;
  matches: (violation: string, record: IterationRecord) => boolean;
}> = [
  {
    // Double tap on a control that navigates to Analyze while
    // useRatingRouteGate replaces Analyze (→ ConnectAccount / Paywall):
    // `navigate('Analyze')` cannot find the (replaced) route and pushes again.
    id: 'F1 replaced Analyze gate stacks duplicate ConnectAccount/Paywall',
    matches: v => /^I3 .*(ConnectAccount|Paywall)/.test(v),
  },
  {
    // A tab switch and a stack push committed in ONE React batch: the tab
    // navigator is not focused when it moves off Library, so Library never
    // receives `blur`; useFocusEffect keeps `isFocused=true` and ignores the
    // next `focus` → no read on return.
    id: 'F2 batched tab-switch+push swallows Library focus refresh',
    matches: (v, record) =>
      /^I4 \d+ read pairs for \d+ focus gains/.test(v) &&
      record.counts.batchedTabPush > 0,
  },
];

// ───────────────────────────── campaign ─────────────────────────────────────

const ITER = Number(process.env.STRESS_ITER ?? 24);
const SEED0 = Number(process.env.STRESS_SEED ?? 1);
const BATCH = Math.max(1, Number(process.env.STRESS_BATCH ?? 6));
const SEEDS: number[] = process.env.STRESS_SEEDS
  ? process.env.STRESS_SEEDS.split(',')
      .map(s => Number(s.trim()))
      .filter(Number.isFinite)
  : Array.from({ length: ITER }, (_, i) => SEED0 + i);
const BATCHES: number[][] = [];
for (let i = 0; i < SEEDS.length; i += BATCH)
  BATCHES.push(SEEDS.slice(i, i + BATCH));

const records: IterationRecord[] = [];
const sink = {
  errors: [] as string[],
  warns: [] as string[],
  rejections: [] as string[],
};
const format = (args: unknown[]) =>
  args
    .map(a =>
      a instanceof Error
        ? `${a.name}: ${a.message}`
        : typeof a === 'string'
          ? a
          : JSON.stringify(a),
    )
    .join(' ');
const onRejection = (reason: unknown) => {
  sink.rejections.push(
    reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : String(reason),
  );
};

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    sink.errors.push(format(args));
  });
  jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    sink.warns.push(format(args));
  });
  process.on('unhandledRejection', onRejection);
});

afterAll(() => {
  process.off('unhandledRejection', onRejection);
  (console.error as jest.Mock).mockRestore();
  (console.warn as jest.Mock).mockRestore();
  jest.useRealTimers();
  const out = process.env.STRESS_OUT;
  const broken = records.filter(r => r.outcome === 'BROKEN');
  const table = {
    unit: 'scr-libraryscreen',
    lens: 'rapid-interaction',
    seeds: SEEDS,
    executed: records.length,
    held: records.length - broken.length,
    broken: broken.map(r => r.seed),
    brokenOnlyKnownFindings: broken
      .filter(r => r.violations.every(v => r.knownViolations.includes(v)))
      .map(r => r.seed),
    knownFindings: KNOWN_FINDINGS.map(f => f.id),
    totals: {
      bursts: records.reduce((n, r) => n + r.bursts, 0),
      taps: records.reduce((n, r) => n + r.taps, 0),
      readPairs: records.reduce((n, r) => n + r.counts.readPairs, 0),
      fetches: records.reduce(
        (n, r) =>
          n +
          r.counts.getSaved +
          r.counts.getDetail +
          r.counts.getPlan +
          r.counts.deletes,
        0,
      ),
      pushes: records.reduce((n, r) => n + r.counts.pushes, 0),
      unsaveIntents: records.reduce((n, r) => n + r.counts.unsaveIntents, 0),
      watchTaps: records.reduce((n, r) => n + r.counts.watchTaps, 0),
      openUrl: records.reduce((n, r) => n + r.counts.openUrl, 0),
    },
    results: Object.fromEntries(records.map(r => [String(r.seed), r])),
  };
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(table, null, 2));
  }
  process.stdout.write(
    `\n[stress scr-libraryscreen rapid-interaction] executed=${table.executed} held=${table.held} broken=${JSON.stringify(table.broken)} bursts=${table.totals.bursts} taps=${table.totals.taps}${out ? ` → ${out}` : ''}\n`,
  );
});

describe('LibraryScreen · rapid/concurrent interaction stress (real navigator + stores)', () => {
  test('harness renders the real LibraryScreen', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const world = makeWorld(0);
    mockWorld.current = world;
    setActiveDataOwner(SYNCED_SESSION.subject);
    useAuthStore.setState({
      hydrated: true,
      session: SYNCED_SESSION,
      busy: false,
      error: null,
    });
    configureTrainingStore(
      createTrainingApi({
        baseUrl: 'https://stress.invalid',
        token: 'stress-bearer',
        fetchFn: world.fetch,
      }),
    );
    let renderer!: Renderer;
    await act(async () => {
      renderer = TestRenderer.create(<RootNavigator />);
    });
    await act(async () => {
      byLabel(renderer, 'Library')!.props.onPress();
    });
    await settle(world);
    expect(renderer.root.findAllByType(LibraryScreen)).toHaveLength(1);
    expect(
      hasText(
        renderer,
        'Your measured reads and the reviewed work you chose to keep.',
      ),
    ).toBe(true);
    expect(world.reads.length).toBe(2);
    await act(async () => {
      renderer.unmount();
    });
    expect(sink.errors).toEqual([]);
    expect(sink.warns).toEqual([]);
    mockWorld.current = null;
  });

  test.each(BATCHES.map((batch, i) => [i, batch] as const))(
    'seed batch %i holds every invariant (%j)',
    async (_index, batch) => {
      jest.useFakeTimers({
        doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
      });
      const broken: string[] = [];
      for (const seed of batch) {
        sink.errors.length = 0;
        sink.warns.length = 0;
        sink.rejections.length = 0;
        const record = await runIteration(seed, sink);
        records.push(record);
        const unknown = record.violations.filter(
          v => !record.knownViolations.includes(v),
        );
        if (unknown.length) {
          broken.push(`seed ${seed}: ${unknown.join(' | ')}`);
        }
      }
      expect(broken).toEqual([]);
    },
  );
});

// ───────────────────── minimized repros of the findings ─────────────────────

async function mountWorld(seed: number, overrides: Partial<Profile>) {
  const world = makeWorld(seed, overrides);
  mockWorld.current = world;
  resetNav();
  configureStores(world.profile, world);
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <View style={{ flex: 1 }}>
        <RootNavigator />
        <BrandNoticeHost />
      </View>,
    );
  });
  await act(async () => {
    byLabel(renderer, 'Library')!.props.onPress();
  });
  await settle(world);
  return { world, renderer };
}

async function tap(renderer: Renderer, label: string) {
  const node = byLabel(renderer, label);
  if (!node) throw new Error(`no control labelled ${JSON.stringify(label)}`);
  await act(async () => {
    node.props.onPress();
  });
}

const routeNames = () => rootState()?.routes.map(r => r.name) ?? [];

async function unmountWorld(world: World, renderer: Renderer) {
  await act(async () => {
    renderer.unmount();
  });
  await settle(world, 5_000);
  mockWorld.current = null;
}

describe('LibraryScreen · minimized repros (each pins a reproduced finding; flips when fixed)', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
  });

  test('control: double tap on a result row pushes exactly one Result', async () => {
    const { world, renderer } = await mountWorld(1001, {
      account: 'synced',
      access: 'premium',
      shots: 3,
      dbFailRate: 0,
    });
    const row = resultRows(renderer)[0]!;
    await act(async () => {
      row.props.onPress();
    });
    await tick(10);
    await act(async () => {
      row.props.onPress();
    });
    expect(routeNames()).toEqual(['Tabs', 'Result']);
    await unmountWorld(world, renderer);
  });

  // EXPECTED once fixed: ['Tabs', 'ConnectAccount'] after both taps.
  test('F1 guest: double tap "Analyze your first stroke" stacks two ConnectAccount screens', async () => {
    const { world, renderer } = await mountWorld(1002, {
      account: 'guest',
      shots: 0,
      pending: 0,
      dbFailRate: 0,
    });
    await tap(renderer, 'Analyze your first stroke');
    expect(routeNames()).toEqual(['Tabs', 'ConnectAccount']); // useRatingRouteGate replaced Analyze
    await tick(10);
    await tap(renderer, 'Analyze your first stroke'); // second tap during the transition
    expect(routeNames()).toEqual(['Tabs', 'ConnectAccount', 'ConnectAccount']);
    await unmountWorld(world, renderer);
  });

  // EXPECTED once fixed: ['Tabs', 'Paywall'] after both taps.
  test('F1 free tier exhausted: double tap "Analyze your first stroke" stacks two Paywall screens', async () => {
    const { world, renderer } = await mountWorld(1003, {
      account: 'synced',
      access: 'paywalled',
      shots: 0,
      pending: 0,
      dbFailRate: 0,
    });
    await tap(renderer, 'Analyze your first stroke');
    expect(routeNames()).toEqual(['Tabs', 'Paywall']);
    await tick(10);
    await tap(renderer, 'Analyze your first stroke');
    expect(routeNames()).toEqual(['Tabs', 'Paywall', 'Paywall']);
    await unmountWorld(world, renderer);
  });

  test('control: tab switch THEN push (separate commits) → Library re-reads on return', async () => {
    const { world, renderer } = await mountWorld(1004, {
      account: 'synced',
      access: 'premium',
      shots: 2,
      dbFailRate: 0,
    });
    const readsBefore = world.reads.length;
    const row = resultRows(renderer)[0]!;
    await tap(renderer, 'Settings');
    await act(async () => {
      row.props.onPress(); // Library is still mounted under the tab navigator
    });
    expect(routeNames()).toEqual(['Tabs', 'Result']);
    await settle(world);
    await tap(renderer, 'Leave Result');
    await tap(renderer, 'Library');
    await settle(world);
    expect(world.reads.length - readsBefore).toBe(2); // one shot read + one capture read
    await unmountWorld(world, renderer);
  });

  // EXPECTED once fixed: 2 new reads (one pair) after returning to Library.
  test('F2 tab switch + push in ONE commit → Library does not re-read on return', async () => {
    const { world, renderer } = await mountWorld(1005, {
      account: 'synced',
      access: 'premium',
      shots: 2,
      dbFailRate: 0,
    });
    const readsBefore = world.reads.length;
    const settings = byLabel(renderer, 'Settings');
    const row = resultRows(renderer)[0];
    expect(settings).not.toBeNull();
    expect(row).toBeDefined();
    await act(async () => {
      settings!.props.onPress();
      row!.props.onPress();
    });
    await settle(world);
    expect(routeNames()).toEqual(['Tabs', 'Result']);
    expect(batchedTabPushes(mockNav.states)).toBe(1);
    await tap(renderer, 'Leave Result');
    await tap(renderer, 'Library');
    await settle(world);
    expect(libraryFocused(rootState())).toBe(true);
    expect(world.reads.length - readsBefore).toBe(0);
    await unmountWorld(world, renderer);
  });
});
