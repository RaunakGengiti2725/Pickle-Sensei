/**
 * LIFECYCLE stress harness for the FormReview screen (unit
 * `scr-formreviewscreen`, lens `lifecycle`).
 *
 * The screen is mounted the way the app mounts it: the REAL
 * `@react-navigation/native` container, the REAL native-stack navigator with
 * the FormReview route registered exactly as RootNavigator registers it, the
 * REAL `react-native-safe-area-context` provider, the production
 * `getDb()`/repository/`loadStrokeResultEvidence`/`loadReviewPoseSequence`
 * path, the production `tryAgainHandoff` and `apiSession` stores. Only the
 * native boundaries are replaced:
 *
 *  - `@op-engineering/op-sqlite` → a real SQLite database (`node:sqlite`) that
 *    PERSISTS across kill/relaunch inside one iteration, with every async
 *    `execute` routed through the seeded gate below;
 *  - `NativeModules.PickleVideoCapture.readTextFile` → an in-memory capture
 *    directory (files can be revoked later), also routed through the gate;
 *  - `AppState` (already a jest mock) → listener bookkeeping + emit.
 *
 * Every async boundary call becomes a PENDING op the schedule releases (or
 * fails) in a seeded order, interleaved with lifecycle events: background /
 * foreground (with suspended wall-clock jumps), unmount mid-request (pop),
 * kill + relaunch (fresh navigation tree, `getDb()` reopened over the same
 * persisted store), cancel mid-flight (route param change), token rotation,
 * account switch (sign-out → different owner → relaunch), permission
 * revoke-later (sidecar / clip artifact disappears after the row was read),
 * plus real transport presses on the player. Everything is derived from one
 * seed, so any row of the JSON table replays with `STRESS_SEED=<seed>`.
 *
 * Neither production code nor existing tests are modified by this file.
 */
import React, { useEffect } from 'react';
import { AppState, NativeModules, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
  type NavigationContainerRef,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import type { CapturedClip } from '../../src/camera/capture';
import { color } from '../../src/design/tokens';
import { getDb } from '../../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { saveAnalysis, savePendingCapture } from '../../src/data/repository';
import type { RootStackParams } from '../../src/navigation/params';
import { FormReviewScreen } from '../../src/screens/FormReviewScreen';
import { FormReviewPlayer } from '../../src/review/FormReviewPlayer';
import {
  clearTryAgainHandoff,
  consumeTryAgainHandoff,
  peekTryAgainHandoff,
  type TryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
} from '../../src/account/apiSession';

// apps/mobile types only `jest` (no @types/node); declare the exact Node
// surface this harness drives (same convention as dbMigrationMalformedOutbox).
declare const require: (id: string) => unknown;

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};

// ─── Seeded RNG (mulberry32) ────────────────────────────────────────────────

export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  weighted<T extends string>(weights: Record<T, number>): T {
    const entries = Object.entries(weights) as [T, number][];
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll < 0) return key;
    }
    return entries[entries.length - 1]![0];
  }
}

// ─── The seeded gate every native async boundary passes through ────────────

export type OpKind =
  | 'sql.shot' // getAnalysis (local_shot by id)
  | 'sql.record' // loadAnalysisRecordById
  | 'sql.capture' // getPendingCapture
  | 'sql.shots' // listShots (session attempts)
  | 'sql.other'
  | 'artifact'; // readTextFile (pose sidecar)

export interface PendingOp {
  id: number;
  kind: OpKind;
  label: string;
  epoch: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface OpRecord {
  id: number;
  kind: OpKind;
  epoch: number;
  outcome: 'ok' | 'failed' | 'artifact_missing';
}

function classifySql(sql: string): OpKind {
  const text = sql.replace(/\s+/g, ' ');
  if (/FROM local_shot WHERE owner_key = \? AND id = \?/.test(text)) {
    return 'sql.shot';
  }
  if (/FROM local_analysis_record/.test(text)) return 'sql.record';
  if (/FROM local_capture WHERE owner_key = \? AND id = \?/.test(text)) {
    return 'sql.capture';
  }
  if (/FROM local_shot/.test(text)) return 'sql.shots';
  return 'sql.other';
}

/**
 * One simulated phone. `disk` and `files` survive kill/relaunch; the gate
 * holds every in-flight native call until the schedule releases it.
 */
export class FakeDevice {
  disk: DatabaseSync = new DatabaseSync(':memory:');
  files = new Map<string, string>();
  /** 'immediate' resolves boundary calls on the next microtask; 'gated' parks them. */
  mode: 'immediate' | 'gated' = 'immediate';
  pending: PendingOp[] = [];
  log: OpRecord[] = [];
  /** Load epoch of the screen instance being mounted / re-parameterised. */
  epoch = 0;
  /**
   * Load epochs follow the promise chain, not wall time. While the schedule
   * releases a parked op, `trigger` holds that op's epoch, so every boundary
   * call the continuation issues (even from a screen that has since been
   * unmounted, while a newer load is in flight) is booked against the same
   * chain. Otherwise a stale load's late capture read would be attributed to
   * the current screen and the oracle would drift.
   */
  trigger: number | null = null;
  private nextId = 1;
  opens = 0;
  closes = 0;
  /** Keychain stand-in: the owner a relaunch re-hydrates as. */
  vaultOwner: string = SIGNED_OUT_DATA_OWNER;
  appStateListeners = new Map<number, (state: string) => void>();
  appStateSubscriptions = 0;
  appStateRemovals = 0;
  appState: 'active' | 'background' | 'inactive' = 'active';
  analyzeMounts: {
    params: RootStackParams['Analyze'];
    handoff: TryAgainHandoff | null;
  }[] = [];

  reset(): void {
    try {
      this.disk.close();
    } catch {
      // already closed
    }
    this.disk = new DatabaseSync(':memory:');
    this.files.clear();
    this.mode = 'immediate';
    for (const op of [...this.pending]) op.reject(new Error('device reset'));
    this.pending = [];
    this.log = [];
    this.epoch = 0;
    this.trigger = null;
    this.opens = 0;
    this.closes = 0;
    this.vaultOwner = SIGNED_OUT_DATA_OWNER;
    this.appStateListeners.clear();
    this.appStateSubscriptions = 0;
    this.appStateRemovals = 0;
    this.appState = 'active';
    this.analyzeMounts = [];
  }

  gate(kind: OpKind, label: string): Promise<void> {
    const id = this.nextId++;
    const epoch = this.trigger ?? this.epoch;
    if (this.mode === 'immediate') {
      this.log.push({ id, kind, epoch, outcome: 'ok' });
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const op: PendingOp = {
        id,
        kind,
        label,
        epoch,
        resolve: () => {
          this.pending = this.pending.filter(entry => entry !== op);
          this.log.push({ id, kind, epoch, outcome: 'ok' });
          resolve();
        },
        reject: error => {
          this.pending = this.pending.filter(entry => entry !== op);
          this.log.push({ id, kind, epoch, outcome: 'failed' });
          reject(error);
        },
      };
      this.pending.push(op);
    });
  }

  /** Marks the most recent 'ok' log entry for `id` as a missing artifact. */
  markArtifactMissing(id: number): void {
    const entry = this.log.find(record => record.id === id);
    if (entry) entry.outcome = 'artifact_missing';
  }

  /** The op-sqlite surface `getDb()` opens. */
  openSqlite() {
    this.opens += 1;
    const disk = this.disk;
    return {
      executeSync: (sql: string) => ({ rows: disk.prepare(sql).all() }),
      execute: async (sql: string, params: unknown[] = []) => {
        await this.gate(classifySql(sql), sql.slice(0, 40));
        return {
          rows: disk
            .prepare(sql)
            .all(...(params as (string | number | null)[])),
        };
      },
      close: () => {
        this.closes += 1;
      },
    };
  }

  /** The PickleVideoCapture.readTextFile native method. */
  async readTextFile(uri: string): Promise<string> {
    const id = this.nextId;
    await this.gate('artifact', uri);
    const text = this.files.get(uri);
    if (text === undefined) {
      this.markArtifactMissing(id);
      throw new Error(`ENOENT: ${uri}`);
    }
    return text;
  }

  emitAppState(state: 'active' | 'background' | 'inactive'): void {
    this.appState = state;
    for (const listener of this.appStateListeners.values()) listener(state);
  }
}

export const device = new FakeDevice();

/**
 * AppState listener bookkeeping on the preset's AppState mock. (The capture
 * bridge — `NativeModules.PickleVideoCapture.readTextFile` — must already be
 * installed by the test file's `react-native` mock factory, because
 * camera/capture.ts reads it at module-evaluation time.)
 */
export function installNativeBoundaries(): void {
  const bridge = (
    NativeModules as {
      PickleVideoCapture?: { readTextFile?: unknown };
    }
  ).PickleVideoCapture;
  if (typeof bridge?.readTextFile !== 'function') {
    throw new Error(
      'PickleVideoCapture.readTextFile bridge missing: install it in the react-native mock factory',
    );
  }
  (AppState.addEventListener as jest.Mock).mockImplementation(
    (_event: string, handler: (state: string) => void) => {
      const id = device.appStateSubscriptions++;
      device.appStateListeners.set(id, handler);
      return {
        remove: () => {
          if (device.appStateListeners.delete(id)) device.appStateRemovals++;
        },
      };
    },
  );
}

// ─── Fixtures: two owners, real rows written through the repository ────────

export const OWNER_A = '11111111-1111-4111-8111-111111111111';
export const OWNER_B = '22222222-2222-4222-8222-222222222222';

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
  };
}

export function analysisFor(
  id: string,
  ownerTag: string,
  shotType: ShotAnalysis['shotType'],
): ShotAnalysis {
  return {
    id,
    sessionId: `set-${ownerTag}`,
    shotType,
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: [
      phase('ready', 0, 900),
      phase('prepare', 900, 1500),
      phase('accelerate', 1500, 1900),
      phase('contact', 1880, 1920, 1900),
      phase('follow_through', 1920, 2400),
      phase('recover', 2400, 3200),
    ],
    measurements: [],
    checkpoints: [
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('athletic_base', 72, 'yellow', 'narrow'),
      checkpoint('preparation', 88, 'green', 'none'),
      checkpoint('paddle_set', 90, 'green', 'none'),
      checkpoint('swing_length', null, 'unscored', 'none'),
      checkpoint('sequencing', 82, 'green', 'none'),
      checkpoint('paddle_path', 61, 'red', 'low'),
      checkpoint('contact_position', 48, 'red', 'late'),
      checkpoint('face_wrist_stability', 30, 'red', 'unstable', {
        applicable: false,
      }),
      checkpoint('follow_through', 80, 'green', 'short'),
      checkpoint('recovery', 92, 'green', 'none'),
    ],
    overallScore: 7.1,
    analysisConfidence: 0.84,
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
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: `${shotType}@1`,
    },
    source: 'real',
  };
}

export type SidecarVariant = 'valid' | 'corrupt' | 'absent';

export interface SeededStroke {
  owner: string;
  ownerTag: string;
  analysisId: string;
  captureId: string;
  shotType: ShotAnalysis['shotType'];
  hasCapture: boolean;
  clipUri: string;
  sidecarUri: string;
  sidecar: SidecarVariant;
  frameCount: number;
}

function captureClip(
  stroke: SeededStroke,
  sidecarJson: string,
  frameCount: number,
  durationMs: number,
): CapturedClip {
  const base = {
    uri: stroke.clipUri,
    durationMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    posterUri: `${stroke.clipUri}.poster.jpg`,
    recognition: {
      status: 'unknown' as const,
      reason: 'validated_classifier_unavailable',
    },
    ballSpeed: {
      status: 'unavailable' as const,
      reason: 'analysis_not_run' as const,
    },
  };
  if (stroke.sidecar === 'absent') {
    return { ...base, captureMode: 'imported_video' };
  }
  return {
    ...base,
    captureMode: 'imported_video',
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: stroke.sidecarUri,
      frameCount,
      sha256:
        stroke.sidecar === 'corrupt' ? 'ab'.repeat(32) : sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

/** Writes one owner's stroke through the production repository + a record row. */
export async function seedStroke(stroke: SeededStroke): Promise<void> {
  setActiveDataOwner(stroke.owner);
  const db = getDb();
  await saveAnalysis(
    db,
    analysisFor(stroke.analysisId, stroke.ownerTag, stroke.shotType),
    `permit-${stroke.ownerTag}`,
  );
  const record = {
    id: stroke.analysisId,
    captureId: stroke.captureId,
    createdAtIso: '2026-09-01T10:00:01.000Z',
    strokeIntent: {
      declaredStroke: stroke.shotType,
      predictedStroke: null,
      resolutionBasis: 'declared',
      resolvedProfileId: stroke.shotType.toUpperCase(),
      resolvedProfileVersion: 'technique-profile-v1',
      disagreement: null,
    },
    result: null,
    uncertainty: {
      analysisConfidence: 0.84,
      presentation: 'normal',
      limitingFactors: [],
    },
  };
  await db.execute(
    `INSERT INTO local_analysis_record
      (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      stroke.owner,
      record.id,
      record.captureId,
      record.createdAtIso,
      'engine-1',
      'sm-v1',
      JSON.stringify(record),
    ],
  );
  if (stroke.hasCapture) {
    const { sequence, window } = generateSwingSequence({ handed: 'right' });
    const json = serializePoseSequence(sequence);
    device.files.set(stroke.clipUri, 'clip-bytes');
    if (stroke.sidecar !== 'absent') device.files.set(stroke.sidecarUri, json);
    await savePendingCapture(
      db,
      stroke.captureId,
      stroke.shotType,
      captureClip(stroke, json, sequence.frames.length, window.endMs),
      stroke.shotType,
    );
    stroke.frameCount = sequence.frames.length;
  }
}

// ─── The real navigation tree ───────────────────────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();

function ResultProbe() {
  return <Text testID="probe-result">[Result]</Text>;
}

/** Stand-in for the Analyze route: consumes the handoff exactly on mount. */
function AnalyzeProbe({
  route,
}: NativeStackScreenProps<RootStackParams, 'Analyze'>) {
  useEffect(() => {
    device.analyzeMounts.push({
      params: route.params,
      handoff: consumeTryAgainHandoff(),
    });
  }, [route.params]);
  return <Text testID="probe-analyze">[Analyze]</Text>;
}

export interface Tree {
  renderer: ReactTestRenderer;
  nav: NavigationContainerRef<RootStackParams>;
}

export async function mountTree(analysisId: string): Promise<Tree> {
  const nav = createNavigationContainerRef<RootStackParams>();
  device.epoch += 1;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <NavigationContainer
          ref={nav}
          initialState={{
            index: 1,
            routes: [
              { name: 'Result', params: { analysisId } },
              { name: 'FormReview', params: { analysisId } },
            ],
          }}
        >
          <Stack.Navigator
            screenOptions={{
              headerShown: false,
              animation: 'fade_from_bottom',
              contentStyle: { backgroundColor: color.surface },
            }}
          >
            <Stack.Screen name="Result" component={ResultProbe} />
            <Stack.Screen name="Analyze" component={AnalyzeProbe} />
            <Stack.Screen
              name="FormReview"
              component={FormReviewScreen}
              options={{
                title: 'Form review',
                contentStyle: { backgroundColor: color.surfaceDark },
              }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>,
    );
  });
  await flush();
  return { renderer, nav };
}

export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

export async function unmountTree(tree: Tree): Promise<void> {
  await act(async () => {
    tree.renderer.unmount();
  });
}

// ─── Reading the rendered state ─────────────────────────────────────────────

export type VisibleState =
  | { kind: 'absent' }
  | { kind: 'loading' }
  | { kind: 'missing' }
  | {
      kind: 'ready';
      analysisId: string;
      sessionId: string | null;
      clipUri: string | null;
      sequenceFrames: number | null;
    }
  | { kind: 'ambiguous'; texts: string[] };

export function textsOf(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string => typeof child === 'string');
}

export function visibleState(renderer: ReactTestRenderer): VisibleState {
  const players = renderer.root.findAllByType(FormReviewPlayer);
  const texts = textsOf(renderer);
  const loading = texts.includes('Preparing your form review…');
  const missing = texts.includes('Review unavailable');
  const signals = [players.length > 0, loading, missing].filter(Boolean);
  if (signals.length > 1) return { kind: 'ambiguous', texts };
  if (players.length === 1) {
    const props = players[0]!.props as React.ComponentProps<
      typeof FormReviewPlayer
    >;
    return {
      kind: 'ready',
      analysisId: props.analysis.id,
      sessionId: props.analysis.sessionId,
      clipUri: props.clip?.uri ?? null,
      sequenceFrames: props.sequence?.frames.length ?? null,
    };
  }
  if (loading) return { kind: 'loading' };
  if (missing) return { kind: 'missing' };
  return { kind: 'absent' };
}

export function pressable(renderer: ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === testID &&
      typeof candidate.props.onPress === 'function',
  );
  return node ?? null;
}

export function routeNames(nav: NavigationContainerRef<RootStackParams>) {
  const state = nav.isReady() ? nav.getRootState() : null;
  return state ? state.routes.map(route => route.name) : [];
}

export function focusedRoute(nav: NavigationContainerRef<RootStackParams>) {
  return nav.isReady() ? (nav.getCurrentRoute() ?? null) : null;
}

/**
 * Serialized render tree with React Navigation's per-mount random route keys
 * (`<route>-<nanoid>`) canonicalized, so two independent launches over the
 * same persisted state can be compared byte-for-byte.
 */
export function canonicalTree(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON()).replace(
    /"(Result|FormReview|Analyze)-[A-Za-z0-9_-]{21}"/g,
    '"$1-#"',
  );
}

// ─── Timer ledger: who owns every live timer ────────────────────────────────

export interface LiveTimer {
  id: number;
  kind: 'timeout' | 'interval';
  ms: number;
  owner: 'app' | 'framework';
  site: string;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Wraps the (fake) timer globals so every scheduled timer is attributed to
 * the first non-node_modules frame that scheduled it. `app` timers come from
 * apps/mobile/src; everything else (react-navigation, react-native-screens,
 * Animated, the React scheduler) is `framework`. Install AFTER
 * `jest.useFakeTimers()`.
 */
export class TimerLedger {
  live = new Map<TimerHandle, LiveTimer>();
  private nextId = 1;
  private originals: {
    setTimeout: typeof setTimeout;
    setInterval: typeof setInterval;
    clearTimeout: typeof clearTimeout;
    clearInterval: typeof clearInterval;
  } | null = null;

  install(): void {
    if (this.originals) return;
    const g = globalThis as typeof globalThis;
    const originals = {
      setTimeout: g.setTimeout,
      setInterval: g.setInterval,
      clearTimeout: g.clearTimeout,
      clearInterval: g.clearInterval,
    };
    this.originals = originals;
    const attribute = (): { owner: 'app' | 'framework'; site: string } => {
      const frames = (new Error().stack ?? '').split('\n').slice(2);
      const appFrame = frames.find(
        line => /apps\/mobile\/src\//.test(line) && !/node_modules/.test(line),
      );
      if (appFrame) {
        return {
          owner: 'app',
          site: appFrame.trim().replace(/.*apps\/mobile\//, ''),
        };
      }
      const first = frames.find(line => /node_modules/.test(line));
      return {
        owner: 'framework',
        site: (first ?? '?').trim().replace(/.*node_modules\//, ''),
      };
    };
    g.setTimeout = ((
      handler: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const id = this.nextId++;
      const { owner, site } = attribute();
      const handle = originals.setTimeout(
        (...inner: unknown[]) => {
          this.live.delete(handle);
          handler(...inner);
        },
        ms,
        ...args,
      );
      this.live.set(handle, {
        id,
        kind: 'timeout',
        ms: ms ?? 0,
        owner,
        site,
      });
      return handle;
    }) as typeof setTimeout;
    g.setInterval = ((
      handler: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const id = this.nextId++;
      const { owner, site } = attribute();
      const handle = originals.setInterval(handler, ms, ...args);
      this.live.set(handle, {
        id,
        kind: 'interval',
        ms: ms ?? 0,
        owner,
        site,
      });
      return handle;
    }) as typeof setInterval;
    g.clearTimeout = ((handle: TimerHandle) => {
      this.live.delete(handle);
      originals.clearTimeout(handle);
    }) as typeof clearTimeout;
    g.clearInterval = ((handle: TimerHandle) => {
      this.live.delete(handle);
      originals.clearInterval(handle);
    }) as typeof clearInterval;
  }

  uninstall(): void {
    if (!this.originals) return;
    const g = globalThis as typeof globalThis;
    g.setTimeout = this.originals.setTimeout;
    g.setInterval = this.originals.setInterval;
    g.clearTimeout = this.originals.clearTimeout;
    g.clearInterval = this.originals.clearInterval;
    this.originals = null;
    this.live.clear();
  }

  appTimers(): LiveTimer[] {
    return [...this.live.values()].filter(timer => timer.owner === 'app');
  }

  frameworkTimers(): LiveTimer[] {
    return [...this.live.values()].filter(timer => timer.owner === 'framework');
  }
}

export const timers = new TimerLedger();

// ─── Process-death model ────────────────────────────────────────────────────

/**
 * What dies with the JS process: the `getDb()` handle (reopened over the
 * persisted store on the next call → LOCAL_MIGRATIONS re-run), the single-shot
 * try-again handoff, the in-memory API session. What survives: SQLite rows,
 * capture files, the Keychain owner (`device.vaultOwner`).
 */
export function killProcess(): void {
  getDb().close();
  clearTryAgainHandoff();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
}

export function relaunchSession(bearer: string): void {
  setActiveDataOwner(device.vaultOwner);
  if (
    device.vaultOwner !== SIGNED_OUT_DATA_OWNER &&
    device.vaultOwner !== GUEST_DATA_OWNER
  ) {
    establishApiSession({
      apiBaseUrl: 'https://example.invalid',
      bearerToken: bearer,
      canonicalAppUserId: device.vaultOwner,
      provider: 'apple',
      refreshToken: `refresh-${bearer}`,
      bearerExpiresAtMs: Date.now() + 3_600_000,
    });
  }
}

export function rotateBearer(bearer: string): boolean {
  const current = getApiSession();
  if (!current) return false;
  establishApiSession({
    ...current,
    bearerToken: bearer,
    refreshToken: `refresh-${bearer}`,
    bearerExpiresAtMs: Date.now() + 3_600_000,
  });
  return true;
}

export { peekTryAgainHandoff };
