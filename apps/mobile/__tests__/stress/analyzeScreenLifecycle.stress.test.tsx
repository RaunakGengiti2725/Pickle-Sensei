/**
 * STRESS — unit `scr-analyzescreen`, lens `lifecycle`.
 *
 * AnalyzeScreen is rendered through the REAL `RootNavigator` (real
 * NavigationContainer, native stack, tabs, HomeScreen → Analyze route gate),
 * the real zustand stores (auth / app / access / api-session), the real
 * repository over a real SQLite database (`node:sqlite`, in memory) and the
 * real `runCaptureAnalysis` pipeline. Only the native seams are faked:
 * `NativeModules.PickleVideoCapture` (camera), `AppState`, op-sqlite's driver
 * (replaced by node:sqlite), safe-area/svg/gradient/webview view primitives,
 * the Google sign-in SDK, and `fetch`.
 *
 * Each iteration draws ONE seeded lifecycle schedule (mulberry32 → replayable
 * from its seed alone), drives it against a fresh world, and checks the
 * invariants below. Iteration count: `STRESS_ITER` (default 12; the campaign
 * runs ≥ 100). Replay one seed with `STRESS_SEED=<n>`. Set `STRESS_OUT=<file>`
 * to write the seed → outcome JSON table.
 *
 *   npx jest --ci --detectOpenHandles __tests__/stress/analyzeScreenLifecycle
 *   STRESS_ITER=120 STRESS_OUT=/tmp/lifecycle.json npx jest --ci \
 *     --detectOpenHandles __tests__/stress/analyzeScreenLifecycle
 *
 * Invariants (checked after every schedule):
 *   I1  no leaked camera-event listeners once the screen is gone
 *   I2  no leaked timers / AppState listeners once the session is torn down
 *   I3  a capture pending at unmount is cancelled through the native seam
 *   I4  no Result navigation after the screen was abandoned
 *   I5  no local rows written under an owner other than the one whose run
 *       produced them (no state from a previous user)
 *   I6  re-hydration after kill/relaunch is idempotent (same state, no
 *       duplicate rows)
 *   I7  every request issued after a token rotation carries the rotated bearer
 *   I8  the screen is usable again after the interruption (no stuck state)
 *
 * Linux cannot prove AVFoundation/Vision/Keychain behaviour: the native module
 * is a typed fake, so anything about the real camera or the device Keychain
 * stays UNKNOWN here.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  AppState,
  DeviceEventEmitter,
  NativeModules,
  Text,
} from 'react-native';
import { writeFileSync } from 'fs';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CameraEvent, CapturedClip } from '../../src/camera/capture';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../../src/billing/types';
import type { Profile } from '../../src/state/appStore';

declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };

// ─── node:sqlite in place of the op-sqlite native driver ────────────────────

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};
const sqlite = { db: null as DatabaseSync | null, opens: 0 };

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const db = sqlite.db;
    if (!db) throw new Error('stress: no sqlite database for this world');
    sqlite.opens += 1;
    return {
      executeSync: (sql: string) => ({ rows: db.prepare(sql).all() }),
      execute: async (sql: string, params: unknown[] = []) => ({
        rows: db.prepare(sql).all(...(params as (string | number | null)[])),
      }),
      close: () => {},
    };
  },
}));

// ─── View-primitive native modules ──────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const actual = jest.requireActual('react-native-safe-area-context');
  const metrics = {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 47, right: 0, bottom: 34, left: 0 },
  };
  const SafeAreaProvider = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(
      actual.SafeAreaFrameContext.Provider,
      { value: metrics.frame },
      React.createElement(
        actual.SafeAreaInsetsContext.Provider,
        { value: metrics.insets },
        children,
      ),
    );
  const SafeAreaView = ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
  }) => React.createElement(View, props, children);
  return {
    ...actual,
    initialWindowMetrics: metrics,
    SafeAreaProvider,
    SafeAreaView,
    useSafeAreaInsets: () => metrics.insets,
    useSafeAreaFrame: () => metrics.frame,
  };
});
jest.mock('react-native-svg', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
    G: Mock,
    Text: Mock,
  };
});
jest.mock('react-native-linear-gradient', () => {
  const ReactActual = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(View, null, props.children);
  return { __esModule: true, default: Mock };
});
jest.mock('react-native-webview', () => {
  const ReactActual = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const WebView = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(View, null, props.children);
  return { __esModule: true, default: WebView, WebView };
});
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn(), signOut: jest.fn() },
}));

// ─── Timer / AppState leak tracking (installed before any app module) ───────

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const liveTimers = new Map<unknown, string>();
let trackingTimers = false;
(globalThis as { setTimeout: unknown }).setTimeout = ((
  fn: (...args: unknown[]) => void,
  ms?: number,
  ...rest: unknown[]
) => {
  const track = trackingTimers;
  const stack = track ? (new Error().stack ?? '') : '';
  const handle: unknown = realSetTimeout(
    (...args: unknown[]) => {
      liveTimers.delete(handle);
      fn(...args);
    },
    ms,
    ...rest,
  );
  if (track) liveTimers.set(handle, `${ms ?? 0}ms ${stack.split('\n')[2]}`);
  return handle;
}) as typeof setTimeout;
(globalThis as { clearTimeout: unknown }).clearTimeout = ((handle: unknown) => {
  liveTimers.delete(handle);
  realClearTimeout(handle as ReturnType<typeof setTimeout>);
}) as typeof clearTimeout;

type AppStateListener = (state: string) => void;
const appStateListeners = new Set<AppStateListener>();
(AppState.addEventListener as jest.Mock).mockImplementation(
  (_type: string, listener: AppStateListener) => {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  },
);
(AppState as { currentState: string }).currentState = 'active';

// ─── Native camera module (typed fake behind the real capture.ts seam) ──────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}
function deferred<T>(): Deferred<T> {
  const d: Partial<Deferred<T>> = { settled: false };
  d.promise = new Promise<T>((resolve, reject) => {
    d.resolve = value => {
      d.settled = true;
      resolve(value);
    };
    d.reject = error => {
      d.settled = true;
      reject(error);
    };
  });
  return d as Deferred<T>;
}

const camera = {
  pending: null as Deferred<CapturedClip> | null,
  captures: 0,
  cancels: 0,
  /** Whether a native cancel rejects the pending capture (the real module
   * does); a schedule may flip it to model a clip that finalized first. */
  cancelRejectsPending: true,
  sidecars: new Map<string, string>(),
};
/** Reads the live pending capture (the native module mutates it between
 * awaits, so callers must not rely on control-flow narrowing of the field). */
function pendingCapture(): Deferred<CapturedClip> | null {
  return camera.pending;
}
const nativeCamera = {
  capture: jest.fn(() => {
    camera.captures += 1;
    const d = deferred<CapturedClip>();
    camera.pending = d;
    return d.promise;
  }),
  importVideo: jest.fn(() =>
    Promise.reject(new Error('library import is out of scope here')),
  ),
  cancel: jest.fn(() => {
    camera.cancels += 1;
    const pending = camera.pending;
    if (pending && !pending.settled && camera.cancelRejectsPending) {
      pending.reject({ code: 'camera.cancelled', message: 'User cancelled' });
      camera.pending = null;
    }
  }),
  readTextFile: jest.fn(async (uri: string) => {
    const text = camera.sidecars.get(uri);
    if (text === undefined) throw new Error(`stress: no sidecar for ${uri}`);
    return text;
  }),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};
(NativeModules as Record<string, unknown>).PickleVideoCapture = nativeCamera;

async function emitCamera(event: CameraEvent): Promise<void> {
  await act(async () => {
    DeviceEventEmitter.emit('PickleCameraEvent', event);
  });
}
async function appState(state: 'background' | 'active'): Promise<void> {
  (AppState as { currentState: string }).currentState = state;
  await act(async () => {
    for (const listener of [...appStateListeners]) listener(state);
  });
}
const stamp = () => ({ emittedAtIso: '2026-08-29T18:00:00.000Z' });

// App modules are loaded AFTER the native camera fake exists: capture.ts reads
// NativeModules.PickleVideoCapture once at module evaluation.
const { RootNavigator } =
  require('../../src/navigation/RootNavigator') as typeof import('../../src/navigation/RootNavigator');
const { useAuthStore } =
  require('../../src/auth/authStore') as typeof import('../../src/auth/authStore');
const { useAppStore } =
  require('../../src/state/appStore') as typeof import('../../src/state/appStore');
const { useAccessStore, configureAccessStore, clearAccessStoreConfiguration } =
  require('../../src/state/accessStore') as typeof import('../../src/state/accessStore');
const {
  setActiveDataOwner,
  getActiveDataOwner,
  canonicalDataOwner,
  profileKeyForOwner,
  SIGNED_OUT_DATA_OWNER,
} =
  require('../../src/data/accountScope') as typeof import('../../src/data/accountScope');
const { establishApiSession, clearApiSession, getApiSession } =
  require('../../src/account/apiSession') as typeof import('../../src/account/apiSession');
const { configureSyncRuntime, clearSyncRuntime } =
  require('../../src/data/syncRuntime') as typeof import('../../src/data/syncRuntime');
const { configureTrainingStore, clearTrainingStoreConfiguration } =
  require('../../src/training/store') as typeof import('../../src/training/store');
const { createTrainingApi } =
  require('../../src/training/api') as typeof import('../../src/training/api');
const { bearerTokenFor } =
  require('../../src/account/apiSession') as typeof import('../../src/account/apiSession');
const { getDb } =
  require('../../src/data/db') as typeof import('../../src/data/db');
const { setKv, listPendingCaptures, listShots } =
  require('../../src/data/repository') as typeof import('../../src/data/repository');

// ─── Seeded schedule ────────────────────────────────────────────────────────

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

const INTERRUPTIONS = [
  'none',
  'background_foreground_mid_capture',
  'background_foreground_mid_analysis',
  'close_mid_capture',
  'native_cancel_mid_capture',
  'close_mid_analysis',
  'token_rotation_mid_analysis',
  'account_switch_mid_analysis',
  'account_switch_mid_capture',
  'permission_revoke_later',
  'kill_relaunch_mid_capture',
  'kill_relaunch_after_result',
] as const;
type Interruption = (typeof INTERRUPTIONS)[number];

interface Schedule {
  seed: number;
  interruption: Interruption;
  /** Camera events replayed before the interruption lands. */
  preEvents: CameraEvent[];
  /** Native clip finalizes before the cancel reaches the module. */
  clipRacesCancel: boolean;
  /** For rotation/switch: act before (true) or after the permit reserve
   * response is released (false). */
  actBeforeReserveResolves: boolean;
  /** Extra settle time (ms) injected between steps. */
  jitterMs: number;
  /** After the interruption, run one more full attempt on the same screen. */
  secondAttempt: boolean;
}

const EVENT_POOL: CameraEvent[] = [
  { ...stamp(), type: 'permission', state: 'requesting' },
  { ...stamp(), type: 'permission', state: 'granted' },
  { ...stamp(), type: 'session', state: 'configured' },
  { ...stamp(), type: 'session', state: 'starting' },
  { ...stamp(), type: 'session', state: 'composing' },
  { ...stamp(), type: 'session', state: 'observing' },
  { ...stamp(), type: 'session', state: 'armed' },
  {
    ...stamp(),
    type: 'session',
    state: 'recording_started',
    reason: 'shutter',
  },
  { ...stamp(), type: 'processing', state: 'preparing_clip' },
];

function scheduleFor(seed: number): Schedule {
  const rng = mulberry32(seed);
  function pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(rng() * items.length)];
    if (item === undefined) throw new Error('stress: pick from empty pool');
    return item;
  }
  const preCount = Math.floor(rng() * 5);
  const preEvents: CameraEvent[] = [];
  for (let i = 0; i < preCount; i += 1) preEvents.push(pick(EVENT_POOL));
  return {
    seed,
    interruption: pick(INTERRUPTIONS),
    preEvents,
    clipRacesCancel: rng() < 0.3,
    actBeforeReserveResolves: rng() < 0.5,
    jitterMs: Math.floor(rng() * 25),
    secondAttempt: rng() < 0.5,
  };
}

// ─── Accounts / world ───────────────────────────────────────────────────────

const OWNER_A = '44444444-4444-4444-8444-444444444444';
const OWNER_B = '55555555-5555-4555-8555-555555555555';
const API = 'https://api.stress.test';

const PROFILE: Profile = {
  skillLevel: 'intermediate',
  handedness: 'right',
  goal: 'consistency',
  biggestProblem: 'x',
  focusCheckpoint: 'contact_position',
} as Profile;

function access(): CanonicalAccessState {
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used: 0,
      reserved: 0,
      remaining: 2,
      availableToReserve: 2,
    },
    canStartRating: true,
    paywallRequired: false,
  };
}

interface RecordedRequest {
  url: string;
  method: string;
  bearer: string | null;
  /** Bearer that was current when the request was issued. */
  currentBearer: string | null;
  owner: string;
}

interface World {
  requests: RecordedRequest[];
  reserveGate: Deferred<void> | null;
  reserveHold: boolean;
  accessReads: number;
  tokens: Map<string, number>;
  sessionKeys: Set<string>;
}
let world!: World;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let permitSeq = 0;
function installFetch(): void {
  (globalThis as { fetch: unknown }).fetch = jest.fn(
    async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers.authorization ?? headers.Authorization ?? null;
      const bearer = auth ? auth.replace(/^Bearer\s+/i, '') : null;
      world.requests.push({
        url,
        method: init?.method ?? 'GET',
        bearer,
        currentBearer: getApiSession()?.bearerToken ?? null,
        owner: getActiveDataOwner(),
      });
      if (url.endsWith('/v1/analysis-permits')) {
        if (world.reserveHold) {
          world.reserveGate = world.reserveGate ?? deferred<void>();
          await world.reserveGate.promise;
        }
        permitSeq += 1;
        return jsonResponse(200, {
          permit: {
            id: `permit-${permitSeq}`,
            accessSource: 'free',
            status: 'reserved',
            expiresAt: '2026-08-29T20:00:00.000Z',
          },
        });
      }
      if (url.includes('/v1/analysis-permits/') && url.endsWith('/finalize')) {
        return jsonResponse(200, { ok: true });
      }
      if (url.endsWith('/v1/shots:sync')) {
        const body = JSON.parse(String(init?.body)) as {
          shots: Array<{ id: string }>;
        };
        return jsonResponse(200, {
          acceptedIds: body.shots.map(s => s.id),
          rejected: [],
        });
      }
      if (url.endsWith('/v1/auth/logout')) return jsonResponse(200, {});
      return jsonResponse(404, {
        error: { code: 'not_found', message: `stress: ${url}` },
      });
    },
  );
}

function accessDeps(): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => {
        throw new Error('store offline in this harness');
      }),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: {
      getAccess: jest.fn(async () => {
        world.accessReads += 1;
        return access();
      }),
      syncBilling: jest.fn(),
    },
  } as unknown as BillingAccessDependencies;
}

/** Mirrors authStore.installApiSession (private) + the persisted-profile
 * hydrate App.tsx performs: owner scope, bearer store, long-lived clients
 * resolving the bearer per request, sync runtime, real appStore.hydrate(),
 * real accessStore.initialize(). */
async function signIn(userId: string, token: string): Promise<void> {
  const owner = canonicalDataOwner(userId);
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: API,
    bearerToken: token,
    canonicalAppUserId: userId,
    provider: 'apple',
    refreshToken: `refresh-${userId}`,
    bearerExpiresAtMs: null,
  });
  configureAccessStore(accessDeps());
  configureTrainingStore(
    createTrainingApi({
      baseUrl: API,
      get token() {
        return bearerTokenFor(userId);
      },
    }),
  );
  configureSyncRuntime(getApiSession()!);
  useAuthStore.setState({
    hydrated: true,
    busy: false,
    error: null,
    session: {
      provider: 'apple',
      subject: `sub-${userId}`,
      canonicalAppUserId: userId,
      localOnly: false,
      displayName: null,
      email: null,
    },
  });
  await setKv(getDb(), profileKeyForOwner(owner), JSON.stringify(PROFILE));
  await useAppStore.getState().hydrate();
  await useAccessStore.getState().initialize();
}

function rotateToken(userId: string, token: string): void {
  const current = getApiSession();
  if (!current || current.canonicalAppUserId !== userId) {
    throw new Error('stress: rotation for a session that is not current');
  }
  establishApiSession({ ...current, bearerToken: token });
}

/** Full runtime teardown the way sign-out / process exit would leave it. */
function teardownRuntime(): void {
  clearSyncRuntime();
  clearApiSession();
  clearAccessStoreConfiguration();
  clearTrainingStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({ session: null, hydrated: false });
  useAppStore.setState({ hydrated: false, ownerKey: null, profile: null });
}

// ─── Host: the App.tsx Gate contract (RootNavigator remounts per owner) ────

function Host(): React.JSX.Element {
  const session = useAuthStore(s => s.session);
  const hydrated = useAppStore(s => s.hydrated);
  const ownerKey = useAppStore(s => s.ownerKey);
  const profile = useAppStore(s => s.profile);
  const owner = session?.canonicalAppUserId
    ? canonicalDataOwner(session.canonicalAppUserId)
    : SIGNED_OUT_DATA_OWNER;
  const ready = session !== null && hydrated && ownerKey === owner && profile;
  return ready ? (
    <RootNavigator key={owner} />
  ) : (
    <Text testID="stress-gate">gate:{owner}</Text>
  );
}

// ─── Render helpers ─────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;
type Node = TestRenderer.ReactTestInstance;

function nodeText(node: Node): string {
  return React.Children.toArray(node.props.children)
    .map(c => (typeof c === 'string' || typeof c === 'number' ? String(c) : ''))
    .join('');
}
function texts(renderer: Renderer): string[] {
  return renderer.root.findAll(n => n.type === Text).map(nodeText);
}
function hasText(renderer: Renderer, re: RegExp): boolean {
  return texts(renderer).some(t => re.test(t));
}
function hasTestId(renderer: Renderer, id: string): boolean {
  return renderer.root.findAll(n => n.props.testID === id).length > 0;
}
function pressables(renderer: Renderer): Node[] {
  return renderer.root.findAll(n => typeof n.props.onPress === 'function');
}
function findByLabel(renderer: Renderer, label: string): Node | null {
  const nodes = pressables(renderer).filter(
    n =>
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.startsWith(label),
  );
  return nodes[nodes.length - 1] ?? null;
}
function findByText(renderer: Renderer, label: string): Node | null {
  const nodes = pressables(renderer).filter(
    n =>
      (typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel === label) ||
      n.findAll(t => t.type === Text && nodeText(t) === label).length > 0,
  );
  return nodes[nodes.length - 1] ?? null;
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise(resolve => realSetTimeout(resolve, ms));
  });
}
async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await settle(10);
  }
}
async function press(node: Node | null, what: string): Promise<void> {
  if (!node) throw new Error(`stress: control not found: ${what}`);
  await act(async () => {
    node.props.onPress();
  });
  await settle();
}

// ─── Clip fixture (real pose sequence + real sidecar) ───────────────────────

function guidedClip(id: string): CapturedClip {
  const { sequence, window } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  const uri = `file:///captures/${id}.pose.json`;
  camera.sidecars.set(uri, sidecarJson);
  return {
    uri: `file:///captures/${id}.mov`,
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-08-29T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 500,
    postRollMs: 300,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

// ─── DB inspection (raw, owner-grouped) ─────────────────────────────────────

function rowsByOwner(table: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of sqlite
    .db!.prepare(
      `SELECT owner_key AS o, COUNT(*) AS c FROM ${table} GROUP BY owner_key`,
    )
    .all()) {
    out[String(row.o)] = Number(row.c);
  }
  return out;
}
function ownerSnapshot(): Record<string, Record<string, number>> {
  return {
    local_shot: rowsByOwner('local_shot'),
    local_capture: rowsByOwner('local_capture'),
    local_analysis_record: rowsByOwner('local_analysis_record'),
    outbox: rowsByOwner('outbox'),
  };
}

// ─── One iteration ──────────────────────────────────────────────────────────

interface Outcome {
  seed: number;
  interruption: Interruption;
  schedule: Omit<Schedule, 'seed' | 'interruption' | 'preEvents'> & {
    preEvents: number;
  };
  status: 'HELD' | 'BROKEN';
  violations: string[];
  requests: number;
  /** `METHOD /path bearer=<token> owner=<active owner at issue>` per request. */
  requestLog: string[];
  durationMs: number;
  owners: Record<string, Record<string, number>>;
}

const IS_ANALYZE_READY = /Open automatic camera/;
const RESULT_TEST_ID = 'result-guide';
const STROKE_LABEL = 'Forehand Drive';

async function mountHost(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<Host />);
  });
  await settle();
  return renderer;
}

async function openAnalyze(renderer: Renderer): Promise<void> {
  await waitFor(
    () => findByLabel(renderer, 'Stroke Analysis') !== null,
    'Home analyze entry',
  );
  await press(findByLabel(renderer, 'Stroke Analysis'), 'Stroke Analysis');
  await waitFor(
    () => hasText(renderer, IS_ANALYZE_READY),
    'AnalyzeScreen ready',
  );
}

async function startCapture(
  renderer: Renderer,
  schedule: Schedule,
): Promise<void> {
  const stroke = findByLabel(renderer, STROKE_LABEL);
  if (stroke) await press(stroke, STROKE_LABEL);
  await press(
    findByText(renderer, 'Open automatic camera'),
    'Open automatic camera',
  );
  await waitFor(() => camera.pending !== null, 'native capture request');
  for (const event of schedule.preEvents) {
    await emitCamera(event);
    await settle(schedule.jitterMs);
  }
}

async function finishCapture(id: string): Promise<void> {
  const clip = guidedClip(id);
  await emitCamera({ ...stamp(), type: 'processing', state: 'preparing_clip' });
  const pending = camera.pending;
  if (!pending || pending.settled)
    throw new Error('stress: no capture to finish');
  camera.pending = null;
  await act(async () => pending.resolve(clip));
  await settle();
}

async function releaseReserve(): Promise<void> {
  await waitFor(() => world.reserveGate !== null, 'permit reserve request');
  const gate = world.reserveGate!;
  world.reserveGate = null;
  world.reserveHold = false;
  await act(async () => gate.resolve());
  await settle();
}

/** Process death drops the socket: the in-flight reserve never gets a reply. */
async function dropInflightReserve(): Promise<void> {
  const gate = world.reserveGate;
  if (!gate) return;
  world.reserveGate = null;
  world.reserveHold = false;
  await act(async () => gate.reject(new TypeError('Network request failed')));
  await settle(20);
}

function reserveRequests(from = 0): RecordedRequest[] {
  return world.requests
    .slice(from)
    .filter(r => r.method === 'POST' && r.url.endsWith('/v1/analysis-permits'));
}

async function waitForResult(renderer: Renderer): Promise<void> {
  await waitFor(() => hasTestId(renderer, RESULT_TEST_ID), 'Result screen');
}

async function drainOutboxSync(): Promise<void> {
  // The sync runtime triggers on foreground; drive it through AppState.
  await appState('active');
  await settle(20);
}

function requestsAfter(index: number, path: string): RecordedRequest[] {
  return world.requests.slice(index).filter(r => r.url.includes(path));
}

async function runSchedule(schedule: Schedule): Promise<Outcome> {
  const started = Date.now();
  const violations: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) violations.push(message);
  };

  permitSeq = 0;
  sqlite.db = new DatabaseSync(':memory:');
  world = {
    requests: [],
    reserveGate: null,
    reserveHold: schedule.interruption !== 'none',
    accessReads: 0,
    tokens: new Map(),
    sessionKeys: new Set(),
  };
  camera.pending = null;
  camera.captures = 0;
  camera.cancels = 0;
  camera.cancelRejectsPending = !schedule.clipRacesCancel;
  camera.sidecars.clear();
  nativeCamera.capture.mockClear();
  nativeCamera.cancel.mockClear();
  installFetch();
  liveTimers.clear();
  trackingTimers = true;

  let renderer: Renderer | null = null;
  const unmount = async () => {
    if (!renderer) return;
    const r = renderer;
    renderer = null;
    await act(async () => r.unmount());
    await settle();
  };

  try {
    await signIn(OWNER_A, 'tok-a1');
    renderer = await mountHost();
    await openAnalyze(renderer);
    await startCapture(renderer, schedule);
    const ownerA = canonicalDataOwner(OWNER_A);
    const ownerB = canonicalDataOwner(OWNER_B);

    switch (schedule.interruption) {
      case 'none': {
        await finishCapture(`${schedule.seed}-1`);
        await waitForResult(renderer);
        await drainOutboxSync();
        break;
      }
      case 'background_foreground_mid_capture': {
        await appState('background');
        await emitCamera({ ...stamp(), type: 'session', state: 'interrupted' });
        await settle(schedule.jitterMs);
        await appState('active');
        await emitCamera({
          ...stamp(),
          type: 'session',
          state: 'interruption_ended',
        });
        await settle();
        check(
          camera.cancels === 0,
          'I8 backgrounding must not cancel the capture',
        );
        await finishCapture(`${schedule.seed}-1`);
        await releaseReserve();
        await waitForResult(renderer);
        break;
      }
      case 'background_foreground_mid_analysis': {
        await finishCapture(`${schedule.seed}-1`);
        await waitFor(() => world.reserveGate !== null, 'reserve in flight');
        await appState('background');
        await settle(schedule.jitterMs);
        await appState('active');
        await settle();
        await releaseReserve();
        await waitForResult(renderer);
        const shotsA = (await listShots(getDb())).length;
        check(
          shotsA === 1,
          `I5 expected 1 shot for A after result, got ${shotsA}`,
        );
        break;
      }
      case 'close_mid_capture': {
        await press(findByLabel(renderer, 'Close'), 'Close (working)');
        check(
          camera.cancels >= 1,
          'I3 closing mid-capture must cancel the native capture',
        );
        if (schedule.clipRacesCancel) {
          // The clip finalized before the cancel reached the module.
          await finishCapture(`${schedule.seed}-1`);
        }
        await settle(50);
        check(
          !hasText(renderer, /Auto Analyze|Opening camera/),
          'I8 working surface must be gone after Close',
        );
        check(
          !hasTestId(renderer, RESULT_TEST_ID),
          'I4 no Result after abandon',
        );
        const reserves = reserveRequests().length;
        check(
          reserves === 0,
          `I4 abandoned screen must not reserve a permit (got ${reserves})`,
        );
        check(
          pendingCapture()?.settled ?? true,
          'I3 capture left pending after Close',
        );
        break;
      }
      case 'native_cancel_mid_capture': {
        const pending = camera.pending!;
        camera.pending = null;
        await act(async () =>
          pending.reject({
            code: 'camera.cancelled',
            message: 'User cancelled',
          }),
        );
        await settle();
        check(
          hasText(renderer, IS_ANALYZE_READY),
          'I8 user-cancel must return to ready',
        );
        if (schedule.secondAttempt) {
          await startCapture(renderer, { ...schedule, preEvents: [] });
          await finishCapture(`${schedule.seed}-2`);
          await releaseReserve();
          await waitForResult(renderer);
        }
        break;
      }
      case 'close_mid_analysis': {
        await finishCapture(`${schedule.seed}-1`);
        await waitFor(() => world.reserveGate !== null, 'reserve in flight');
        const readsBefore = world.accessReads;
        await press(findByLabel(renderer, 'Close'), 'Close (analyzing)');
        await settle(schedule.jitterMs);
        await releaseReserve();
        await settle(100);
        check(
          !hasTestId(renderer, RESULT_TEST_ID),
          'I4 Result must not appear after Close',
        );
        check(
          hasText(renderer, /Stroke Analysis/) &&
            !hasText(renderer, /Reading player movement|Measuring/),
          'I8 must be back on Home with no analyzing surface',
        );
        await waitFor(
          () => world.accessReads > readsBefore,
          'access refresh after run settles',
          5000,
        ).catch(e =>
          check(false, `ledger refresh after unmount: ${(e as Error).message}`),
        );
        break;
      }
      case 'token_rotation_mid_analysis': {
        await finishCapture(`${schedule.seed}-1`);
        await waitFor(() => world.reserveGate !== null, 'reserve in flight');
        const mark = world.requests.length;
        let rotatedAt: number;
        if (schedule.actBeforeReserveResolves) {
          rotatedAt = world.requests.length;
          rotateToken(OWNER_A, 'tok-a2');
          await releaseReserve();
        } else {
          await releaseReserve();
          rotatedAt = world.requests.length;
          rotateToken(OWNER_A, 'tok-a2');
        }
        await waitForResult(renderer);
        await drainOutboxSync();
        const late = world.requests.slice(mark);
        for (const r of late) {
          check(
            r.bearer === r.currentBearer,
            `I7 ${r.method} ${r.url} sent bearer ${r.bearer} while current was ${r.currentBearer}`,
          );
        }
        const syncs = requestsAfter(mark, '/v1/shots:sync');
        check(
          syncs.length >= 1,
          'I7 scored shot must reach the sync transport',
        );
        const afterRotation = world.requests.slice(rotatedAt);
        check(
          afterRotation.every(r => r.bearer === 'tok-a2'),
          `I7 request issued after rotation carried a stale bearer: ${JSON.stringify(
            afterRotation
              .filter(r => r.bearer !== 'tok-a2')
              .map(r => `${r.method} ${r.url.replace(API, '')} ${r.bearer}`),
          )}`,
        );
        break;
      }
      case 'account_switch_mid_analysis': {
        await finishCapture(`${schedule.seed}-1`);
        await waitFor(() => world.reserveGate !== null, 'reserve in flight');
        const before = ownerSnapshot();
        await act(async () => {
          await useAuthStore.getState().signOut();
        });
        await settle();
        check(
          hasTestId(renderer, 'stress-gate'),
          'I8 sign-out must tear the navigator down (gate)',
        );
        if (!schedule.actBeforeReserveResolves) {
          await releaseReserve();
          await settle(50);
        }
        await act(async () => {
          await signIn(OWNER_B, 'tok-b1');
        });
        await settle();
        await waitFor(
          () => findByLabel(renderer!, 'Stroke Analysis') !== null,
          'Home for account B',
        );
        if (schedule.actBeforeReserveResolves) {
          await releaseReserve();
        }
        await settle(150);
        await drainOutboxSync();
        const after = ownerSnapshot();
        for (const table of Object.keys(after)) {
          const bRows = after[table]?.[ownerB] ?? 0;
          check(
            bRows === 0,
            `I5 ${table} has ${bRows} row(s) under B written by A's run`,
          );
        }
        const bPending = (await listPendingCaptures(getDb())).length;
        const bShots = (await listShots(getDb())).length;
        check(
          bPending === 0 && bShots === 0,
          `I5 B sees ${bPending} captures / ${bShots} shots`,
        );
        check(
          !world.requests.some(
            r => r.url.includes('/v1/shots:sync') && r.bearer === 'tok-b1',
          ),
          "I5 A's shot must not sync under B's bearer",
        );
        check(
          !hasTestId(renderer, RESULT_TEST_ID),
          'I4 no Result for B from A run',
        );
        void before;
        break;
      }
      case 'account_switch_mid_capture': {
        await act(async () => {
          await useAuthStore.getState().signOut();
        });
        await settle();
        check(
          camera.cancels >= 1,
          'I3 unmount by sign-out must cancel the capture',
        );
        if (schedule.clipRacesCancel) {
          const pending = pendingCapture();
          if (pending && !pending.settled) {
            camera.pending = null;
            await act(async () =>
              pending.resolve(guidedClip(`${schedule.seed}-1`)),
            );
            await settle(50);
          }
        }
        await act(async () => {
          await signIn(OWNER_B, 'tok-b1');
        });
        await settle(50);
        const after = ownerSnapshot();
        for (const table of Object.keys(after)) {
          const bRows = after[table]?.[ownerB] ?? 0;
          check(
            bRows === 0,
            `I5 ${table} has ${bRows} row(s) under B from A's capture`,
          );
        }
        const reserves = reserveRequests().length;
        check(
          reserves === 0,
          `I4 no permit may be reserved after sign-out (got ${reserves})`,
        );
        break;
      }
      case 'permission_revoke_later': {
        await emitCamera({ ...stamp(), type: 'permission', state: 'granted' });
        await settle(schedule.jitterMs);
        await emitCamera({ ...stamp(), type: 'permission', state: 'denied' });
        const pending = camera.pending!;
        camera.pending = null;
        await act(async () =>
          pending.reject(new Error('Camera access was revoked in Settings.')),
        );
        await settle();
        check(
          hasText(renderer, /Nothing was rated\./),
          'I8 revoked permission must show the error surface',
        );
        check(
          hasText(renderer, /Camera access was revoked/),
          'I8 error copy must be the native message',
        );
        // Permission granted again later → Try again must work.
        await press(findByText(renderer, 'Try again'), 'Try again');
        await waitFor(() => camera.pending !== null, 'retry capture');
        await emitCamera({ ...stamp(), type: 'permission', state: 'granted' });
        await finishCapture(`${schedule.seed}-2`);
        await releaseReserve();
        await waitForResult(renderer);
        break;
      }
      case 'kill_relaunch_mid_capture': {
        if (schedule.clipRacesCancel) {
          await finishCapture(`${schedule.seed}-1`);
          await waitFor(() => world.reserveGate !== null, 'reserve in flight');
        }
        // Process death: the tree, the DB handle and every in-memory store go.
        await unmount();
        check(
          camera.pending === null || camera.cancels >= 1,
          'I3 pending capture must be cancelled on unmount',
        );
        teardownRuntime();
        getDb().close();
        appStateListeners.clear();
        await dropInflightReserve();
        const persistedBefore = ownerSnapshot();
        // Relaunch: hydrate twice, both must agree.
        await signIn(OWNER_A, 'tok-a1');
        const first = { app: useAppStore.getState(), rows: ownerSnapshot() };
        await useAppStore.getState().hydrate();
        await useAccessStore.getState().initialize();
        const second = { app: useAppStore.getState(), rows: ownerSnapshot() };
        check(
          JSON.stringify(first.rows) === JSON.stringify(second.rows) &&
            JSON.stringify(persistedBefore) === JSON.stringify(first.rows),
          `I6 re-hydrate changed rows: ${JSON.stringify(persistedBefore)} → ${JSON.stringify(second.rows)}`,
        );
        check(
          first.app.ownerKey === second.app.ownerKey &&
            first.app.hydrated &&
            second.app.hydrated &&
            JSON.stringify(first.app.profile) ===
              JSON.stringify(second.app.profile),
          'I6 re-hydrate produced a different app state',
        );
        renderer = await mountHost();
        await openAnalyze(renderer);
        if (schedule.clipRacesCancel) {
          const pendingA = (await listPendingCaptures(getDb())).length;
          check(
            pendingA === 1,
            `I6 saved capture must survive relaunch (got ${pendingA})`,
          );
          const reserves = reserveRequests().length;
          // The dead run's reserve was in flight; whatever happened to it, the
          // relaunched screen must not have a second one without a new run.
          check(
            reserves <= 1,
            `I4 relaunch must not spawn a reserve (got ${reserves})`,
          );
        }
        if (schedule.secondAttempt) {
          world.reserveHold = false;
          await startCapture(renderer, { ...schedule, preEvents: [] });
          await finishCapture(`${schedule.seed}-2`);
          await waitForResult(renderer);
        }
        break;
      }
      case 'kill_relaunch_after_result': {
        await finishCapture(`${schedule.seed}-1`);
        await releaseReserve();
        await waitForResult(renderer);
        await drainOutboxSync();
        const persisted = ownerSnapshot();
        await unmount();
        teardownRuntime();
        getDb().close();
        appStateListeners.clear();
        await signIn(OWNER_A, 'tok-a1');
        await useAppStore.getState().hydrate();
        await useAccessStore.getState().initialize();
        const again = ownerSnapshot();
        check(
          JSON.stringify(persisted) === JSON.stringify(again),
          `I6 relaunch changed persisted rows ${JSON.stringify(persisted)} → ${JSON.stringify(again)}`,
        );
        const shots = (await listShots(getDb())).length;
        check(
          shots === 1,
          `I6 exactly one shot must persist across relaunch (got ${shots})`,
        );
        renderer = await mountHost();
        await openAnalyze(renderer);
        check(
          hasText(renderer, IS_ANALYZE_READY),
          'I8 Analyze usable after relaunch',
        );
        break;
      }
      default: {
        const never: never = schedule.interruption;
        throw new Error(`unhandled interruption ${String(never)}`);
      }
    }

    // Owner isolation holds for every schedule: nothing may ever be written
    // under the signed-out owner, and B only exists in the switch schedules.
    const snap = ownerSnapshot();
    for (const table of Object.keys(snap)) {
      const so = snap[table]?.[SIGNED_OUT_DATA_OWNER] ?? 0;
      check(
        so === 0,
        `I5 ${table} has ${so} row(s) under the signed-out owner`,
      );
      if (!schedule.interruption.startsWith('account_switch')) {
        const b = snap[table]?.[ownerB] ?? 0;
        check(b === 0, `I5 ${table} has ${b} row(s) under B without a switch`);
      }
    }
    void ownerA;
  } catch (error) {
    violations.push(
      `EXCEPTION ${error instanceof Error ? error.message : String(error)} | screen=${JSON.stringify(renderer ? texts(renderer).slice(-16) : null)} | requests=${JSON.stringify(world.requests.map(r => `${r.method} ${r.url.replace(API, '')}`))}`,
    );
  }

  // Teardown + leak invariants.
  try {
    await unmount();
    await settle(20);
    const cameraListeners =
      DeviceEventEmitter.listenerCount('PickleCameraEvent');
    if (cameraListeners !== 0) {
      violations.push(
        `I1 ${cameraListeners} camera listener(s) leaked after unmount`,
      );
    }
    const leftover = pendingCapture();
    if (leftover && !leftover.settled) {
      violations.push(
        'I3 native capture still pending after teardown without cancel',
      );
    }
    teardownRuntime();
    await dropInflightReserve();
    await settle(20);
    trackingTimers = false;
    if (liveTimers.size > 0) {
      violations.push(
        `I2 ${liveTimers.size} timer(s) leaked: ${[...liveTimers.values()].join(' | ')}`,
      );
      for (const handle of liveTimers.keys()) {
        realClearTimeout(handle as ReturnType<typeof setTimeout>);
      }
      liveTimers.clear();
    }
    if (appStateListeners.size > 0) {
      violations.push(
        `I2 ${appStateListeners.size} AppState listener(s) leaked`,
      );
      appStateListeners.clear();
    }
    try {
      getDb().close();
    } catch {
      // handle already closed by the schedule
    }
  } catch (error) {
    violations.push(
      `TEARDOWN ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const owners = ownerSnapshot();
  sqlite.db?.close();
  sqlite.db = null;
  const { seed, interruption, preEvents, ...rest } = schedule;
  return {
    seed,
    interruption,
    schedule: { ...rest, preEvents: preEvents.length },
    status: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    requests: world.requests.length,
    requestLog: world.requests.map(
      r =>
        `${r.method} ${r.url.replace(API, '')} bearer=${r.bearer} owner=${r.owner}`,
    ),
    durationMs: Date.now() - started,
    owners,
  };
}

// ─── Campaign ───────────────────────────────────────────────────────────────

const ITER = Number(process.env.STRESS_ITER ?? '12');
const BASE_SEED = Number(process.env.STRESS_BASE_SEED ?? '1');
const ONLY_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const OUT = process.env.STRESS_OUT;

const seeds: number[] =
  ONLY_SEED !== null
    ? [ONLY_SEED]
    : Array.from({ length: ITER }, (_, i) => BASE_SEED + i);

describe('AnalyzeScreen lifecycle stress (real RootNavigator + stores + SQLite)', () => {
  const outcomes: Outcome[] = [];

  afterAll(() => {
    if (OUT) {
      writeFileSync(
        OUT,
        JSON.stringify(
          {
            unit: 'scr-analyzescreen',
            lens: 'lifecycle',
            iterations: outcomes.length,
            held: outcomes.filter(o => o.status === 'HELD').length,
            broken: outcomes.filter(o => o.status === 'BROKEN').length,
            byInterruption: INTERRUPTIONS.map(kind => ({
              kind,
              runs: outcomes.filter(o => o.interruption === kind).length,
              broken: outcomes.filter(
                o => o.interruption === kind && o.status === 'BROKEN',
              ).length,
            })),
            outcomes,
          },
          null,
          2,
        ),
      );
    }
  });

  test.each(seeds)(
    'seed %i holds every lifecycle invariant',
    async seed => {
      const schedule = scheduleFor(seed);
      const outcome = await runSchedule(schedule);
      outcomes.push(outcome);
      if (outcome.status === 'BROKEN') {
        throw new Error(
          `seed ${seed} (${schedule.interruption}) BROKEN:\n  ${outcome.violations.join('\n  ')}`,
        );
      }
    },
    60000,
  );
});
