/**
 * STRESS · failure-injection · `scr-resultscreen`
 *
 * ResultScreen rendered inside the REAL React Navigation container + native
 * stack, with the REAL training / consistency / api-session zustand stores
 * and the REAL repository + strokeResultData read paths. Only native seams
 * are replaced: the op-sqlite handle behind `getDb()` (a scripted in-memory
 * SQLite double), `NativeModules.PickleVideoCapture` (camera/Vision sidecar
 * reader), `Linking`, `AccessibilityInfo`, `fetch`, react-native-screens /
 * safe-area-context / svg host components.
 *
 * Every scenario is a seeded fault (or, above the catalog, a seeded
 * combination of faults) injected into one dependency and replayed
 * deterministically from its seed. Invariants asserted per scenario:
 *   I1 no crash / no uncaught error / no unhandled rejection
 *   I2 no infinite spinner after 60s of fake time (a spinner that survives
 *      the deadline is recorded and asserted against per fault class)
 *   I3 a visible, WORKING back/close control (pressing it pops to `Tabs`)
 *   I4 no fake success (no score digits when the analysis is unavailable, no
 *      "saved" state when the save request failed, no "Synced" when the
 *      receipt read failed)
 *   I5 no silent failure (the failure surfaces as copy or an honest state)
 *   I6 no corrupted persisted state (the double records every write: no
 *      write to any table but `kv`, and every `kv` write parses as JSON)
 *
 * Replay:  STRESS_SEED=<seed> npx jest --ci __tests__/stress/resultScreen.failureInjection
 * Scale:   STRESS_ITER=<n> adds n seeded compound scenarios (default 12)
 * Flake:   STRESS_SEED=<seed> STRESS_REPEAT=10 replays one seed ten times
 * Table:   STRESS_RESULTS_PATH=/abs/path.json writes the seed → outcome table
 */
import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { writeFileSync } from 'fs';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { CheckpointScore, ShotAnalysis } from '@pickle/shared-types';
import type { RootStackParams } from '../../src/navigation/params';
import { ResultScreen } from '../../src/screens/ResultScreen';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import { createTrainingApi } from '../../src/training/api';
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { useConsistencyStore } from '../../src/consistency/store';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

// ─── Fault registry (read lazily by the hoisted native mocks) ───────────────

type DbStatement =
  | 'shot.payload'
  | 'shot.list'
  | 'record'
  | 'capture'
  | 'receipt'
  | 'outbox'
  | 'kv'
  | 'write'
  | 'other';

type DbFaultMode =
  | 'reject'
  | 'throw'
  | 'hang'
  | 'slow'
  | 'malformed'
  | 'partial'
  | 'empty'
  | 'garbage';

type FetchFaultMode =
  | 'reject'
  | 'hang'
  | 'slow'
  | 'http401'
  | 'http429'
  | 'http500'
  | 'http500-garbage'
  | 'malformed-json'
  | 'partial'
  | 'wrong-shape'
  | 'http204';

type NativeFaultMode = 'reject' | 'throw' | 'hang' | 'slow' | 'malformed';

interface DbCall {
  statement: DbStatement;
  sql: string;
  params: unknown[];
}

interface Registry {
  seed: number;
  rng: () => number;
  execute: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
  db: {
    faults: Partial<Record<DbStatement, DbFaultMode>>;
    openThrows: boolean;
    calls: DbCall[];
    writes: DbCall[];
    shotPayload: string | null;
    captureRow: Record<string, unknown> | null;
    outboxRow: Record<string, unknown> | null;
    receiptRows: number;
    /** Abstained (low-confidence) result: the guide collapses to the inline
     * evidence sheet (one honest page) instead of the four-step guide. */
    abstained: boolean;
  };
  fetch: {
    faults: Partial<Record<FetchRoute, FetchFaultMode>>;
    calls: { method: string; url: string }[];
  };
  camera: { fault: NativeFaultMode | null; calls: number };
  /** Native promises the product consumed without attaching a rejection handler. */
  unhandledNativeRejections: string[];
}

type FetchRoute = 'plan' | 'catalog' | 'save';

declare global {
  var __stressResultScreen: Registry | undefined;
}

function registry(): Registry {
  const current = globalThis.__stressResultScreen;
  if (!current) throw new Error('stress registry not initialised');
  return current;
}

// ─── Native seams (the ONLY mocked modules) ─────────────────────────────────

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Rect: Mock,
    Path: Mock,
    G: Mock,
    Line: Mock,
    Polyline: Mock,
    Polygon: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
    Text: Mock,
    RadialGradient: Mock,
    Ellipse: Mock,
    Mask: Mock,
    ClipPath: Mock,
    TSpan: Mock,
    Use: Mock,
    Symbol: Mock,
    Image: Mock,
    Pattern: Mock,
  };
});
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  RN.NativeModules.PickleVideoCapture = {
    readTextFile: (uri: string) => {
      const reg = globalThis.__stressResultScreen;
      if (!reg) return Promise.reject(new Error('registry missing'));
      reg.camera.calls += 1;
      switch (reg.camera.fault) {
        case 'throw':
          throw new Error(`camera.readTextFile threw [seed ${reg.seed}]`);
        case 'reject':
          return Promise.reject(
            new Error(`camera.readTextFile rejected [seed ${reg.seed}]`),
          );
        case 'hang':
          return new Promise<string>(() => {});
        case 'slow':
          return new Promise<string>(resolve =>
            setTimeout(() => resolve('{"not":"a pose sequence"}'), 20_000),
          );
        case 'malformed':
          return Promise.resolve('\u0000garbage-not-json');
        case null:
          return Promise.resolve(`{"uri":${JSON.stringify(uri)}}`);
      }
    },
  };
  return RN;
});
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    const reg = globalThis.__stressResultScreen;
    if (!reg) throw new Error('registry missing');
    if (reg.db.openThrows) {
      throw new Error(`SQLite could not be opened [seed ${reg.seed}]`);
    }
    return { execute: reg.execute, close: () => {} };
  },
}));

function classify(sql: string): DbStatement {
  if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) return 'write';
  if (/FROM\s+local_analysis_record/i.test(sql)) return 'record';
  if (/FROM\s+local_capture/i.test(sql)) return 'capture';
  if (/FROM\s+sync_receipt/i.test(sql)) return 'receipt';
  if (/FROM\s+outbox/i.test(sql)) return 'outbox';
  if (/FROM\s+kv/i.test(sql)) return 'kv';
  if (/SELECT\s+payload\s+FROM\s+local_shot/i.test(sql)) return 'shot.payload';
  if (/FROM\s+local_shot/i.test(sql)) return 'shot.list';
  return 'other';
}

const ANALYSIS_ID = 'a1';
const CAPTURE_ID = 'c1';

/** Keyed reads honour their `id = ?` parameter exactly like SQLite would. */
function keyMatches(statement: DbStatement, params: unknown[]): boolean {
  switch (statement) {
    case 'shot.payload':
    case 'record':
      return params.includes(ANALYSIS_ID);
    case 'capture':
      return params.includes(CAPTURE_ID);
    default:
      return true;
  }
}

function healthyRows(
  reg: Registry,
  statement: DbStatement,
  params: unknown[],
): Record<string, unknown>[] {
  if (!keyMatches(statement, params)) return [];
  switch (statement) {
    case 'shot.payload':
      return reg.db.shotPayload === null
        ? []
        : [{ payload: reg.db.shotPayload }];
    case 'shot.list':
      return reg.db.shotPayload === null
        ? []
        : [
            {
              id: 'a1',
              session_id: 's1',
              shot_type: 'forehand_drive',
              captured_at: '2026-09-01T10:00:00.000Z',
              overall_score: reg.db.abstained ? null : 7.4,
              confidence: reg.db.abstained ? 0.2 : 0.82,
              result_kind: reg.db.abstained ? 'low_confidence' : 'scored',
              source: 'real',
              favorite: 0,
              payload: reg.db.shotPayload,
            },
            {
              id: 'a0',
              session_id: 's1',
              shot_type: 'forehand_drive',
              captured_at: '2026-08-31T10:00:00.000Z',
              overall_score: 6.1,
              confidence: 0.8,
              result_kind: 'scored',
              source: 'real',
              favorite: 0,
              payload: reg.db.shotPayload,
            },
          ];
    case 'record':
      return [{ record: JSON.stringify(recordFixture(reg.db.abstained)) }];
    case 'capture':
      return reg.db.captureRow ? [reg.db.captureRow] : [];
    case 'receipt':
      return Array.from({ length: reg.db.receiptRows }, () => ({ 1: 1 }));
    case 'outbox':
      return reg.db.outboxRow ? [reg.db.outboxRow] : [];
    case 'kv':
    case 'write':
    case 'other':
      return [];
  }
}

function faultedRows(
  statement: DbStatement,
  mode: 'malformed' | 'partial' | 'garbage',
): Record<string, unknown>[] {
  switch (statement) {
    case 'shot.payload':
    case 'shot.list':
      return [
        {
          id: 'a1',
          session_id: mode === 'garbage' ? 42 : 's1',
          shot_type: mode === 'garbage' ? null : 'forehand_drive',
          captured_at:
            mode === 'garbage' ? 'yesterday' : '2026-09-01T10:00:00.000Z',
          overall_score: mode === 'garbage' ? 'seven' : 7.4,
          confidence: mode === 'garbage' ? 'high' : 0.82,
          result_kind: 'scored',
          source: 'real',
          favorite: 0,
          payload:
            mode === 'malformed'
              ? '{"id":"a1","resultKind":"scored",'
              : mode === 'partial'
                ? JSON.stringify({
                    id: 'a1',
                    resultKind: 'scored',
                    overallScore: 7.4,
                    source: 'real',
                  })
                : JSON.stringify({
                    id: 'a1',
                    sessionId: 42,
                    shotType: null,
                    capturedAtIso: 'yesterday',
                    timestamps: 'soon',
                    phases: 'none',
                    measurements: null,
                    checkpoints: [null, {}, { key: 7, score: 'nine' }],
                    overallScore: 'seven',
                    analysisConfidence: 'high',
                    resultKind: 'scored',
                    guidance: 3,
                    priorityFix: { checkpoint: 7 },
                    versionVector: null,
                    source: 'real',
                  }),
        },
      ];
    case 'record':
      return [
        {
          record:
            mode === 'malformed'
              ? '{"id":"a1",'
              : mode === 'partial'
                ? JSON.stringify({ id: 'a1' })
                : JSON.stringify({
                    id: 42,
                    captureId: 7,
                    strokeIntent: 'declared',
                    result: 'scored',
                    uncertainty: [],
                  }),
        },
      ];
    case 'capture':
      return [
        {
          id: 'c1',
          uri:
            mode === 'garbage' ? null : 'file:///private/var/mobile/clip.mov',
          shot_type: 'forehand_drive',
          declared_stroke: 'forehand_drive',
          captured_at:
            mode === 'garbage' ? 'yesterday' : '2026-09-01T09:59:00.000Z',
          duration_ms:
            mode === 'garbage' ? 'long' : mode === 'partial' ? null : 2700,
          fps: mode === 'garbage' ? -1 : 59.94,
          width: mode === 'garbage' ? 'wide' : 720,
          height: mode === 'partial' ? undefined : 1280,
          payload:
            mode === 'malformed'
              ? '{"captureMode":'
              : mode === 'partial'
                ? '{}'
                : 12,
        },
      ];
    case 'receipt':
      return mode === 'garbage' ? [{ bogus: undefined }] : [{}];
    case 'outbox':
      return [
        {
          attempts:
            mode === 'garbage' ? 'many' : mode === 'partial' ? undefined : NaN,
          last_error:
            mode === 'garbage'
              ? { nested: true }
              : mode === 'partial'
                ? undefined
                : 7,
        },
      ];
    case 'kv':
      return [
        {
          value:
            mode === 'malformed'
              ? '{"days":'
              : mode === 'partial'
                ? '{}'
                : JSON.stringify({ days: 'many', last: 42, streak: null }),
        },
      ];
    case 'write':
    case 'other':
      return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Stand-in for `LocalDb.execute` (an `async` wrapper around the native
 * driver, `data/db.ts`). `throw` = the driver throws synchronously inside the
 * wrapper (surfaces as an immediately-rejected promise); `reject` = the driver
 * fails asynchronously a tick later.
 */
async function executeScripted(
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[] }> {
  const reg = registry();
  const statement = classify(sql);
  const call = { statement, sql, params };
  reg.db.calls.push(call);
  if (statement === 'write') reg.db.writes.push(call);
  const mode = reg.db.faults[statement];
  switch (mode) {
    case undefined:
      return { rows: healthyRows(reg, statement, params) };
    case 'throw':
      throw new Error(`sqlite ${statement} threw [seed ${reg.seed}]`);
    case 'reject':
      await Promise.resolve();
      throw new Error(`sqlite ${statement} rejected [seed ${reg.seed}]`);
    case 'hang':
      return new Promise(() => {});
    case 'slow':
      await sleep(5_000 + Math.floor(reg.rng() * 40_000));
      return { rows: healthyRows(reg, statement, params) };
    case 'empty':
      return { rows: [] };
    case 'malformed':
    case 'partial':
    case 'garbage':
      return { rows: faultedRows(statement, mode) };
  }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function checkpoint(
  key: CheckpointScore['key'],
  score: number,
  band: CheckpointScore['band'],
  direction: CheckpointScore['direction'],
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: (100 - score) / 100,
    applicable: true,
  };
}

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'a1',
    sessionId: 's1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 2000, contactMs: null, endMs: 2700 },
    phases: [],
    measurements: [],
    checkpoints: [
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('contact_position', 48, 'red', 'late'),
    ],
    overallScore: 7.4,
    analysisConfidence: 0.82,
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
      phaseModelVersion: 'phase-heuristic-1',
      scoringModelVersion: 'scoring-1',
      shotConfigVersion: 'config-1',
    },
    source: 'real',
    ...overrides,
  };
}

function abstainedAnalysisFixture(): ShotAnalysis {
  return analysisFixture({
    resultKind: 'low_confidence',
    overallScore: null,
    analysisConfidence: 0.2,
    priorityFix: null,
    checkpoints: [],
  });
}

function recordFixture(abstained = false) {
  return {
    id: 'a1',
    captureId: 'c1',
    strokeIntent: {
      declaredStroke: 'forehand_drive',
      predictedStroke: null,
      resolutionBasis: 'declared',
      resolvedProfileId: 'FOREHAND_DRIVE',
      resolvedProfileVersion: 'technique-profile-v1',
      disagreement: null,
    },
    result: abstained ? abstainedAnalysisFixture() : analysisFixture(),
  };
}

const CLIP_BASE = {
  uri: 'file:///private/var/mobile/clip.mov',
  durationMs: 2700,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-09-01T09:59:00.000Z',
};

/** A capture row whose validated clip carries a pose sidecar ref: the guide
 * then reads the sidecar through the camera native module. */
function captureRowWithSidecar(): Record<string, unknown> {
  const clip = {
    ...CLIP_BASE,
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///private/var/mobile/clip.pose.json',
      frameCount: 120,
      sha256: 'a'.repeat(64),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return {
    id: 'c1',
    uri: CLIP_BASE.uri,
    shot_type: 'forehand_drive',
    declared_stroke: 'forehand_drive',
    captured_at: CLIP_BASE.capturedAtIso,
    duration_ms: CLIP_BASE.durationMs,
    fps: CLIP_BASE.fps,
    width: CLIP_BASE.width,
    height: CLIP_BASE.height,
    payload: JSON.stringify(clip),
  };
}

const PLAN_ID = '11111111-1111-4111-8111-111111111111';
const SHOT_UUID = '22222222-2222-4222-8222-222222222222';
const DRILL_UUID = '33333333-3333-4333-8333-333333333333';

function healthyPlanPayload() {
  return {
    plan: {
      id: PLAN_ID,
      status: 'active',
      algorithmVersion: 'plan-v1',
      sourceShotId: SHOT_UUID,
      shotType: 'forehand_drive',
      priorityCheckpoint: 'contact_position',
      priorityDirection: 'late',
      baselineScore: 7.4,
      baselineCheckpointScore: 48,
      reassessmentShotId: null,
      scoreDelta: null,
      createdAt: '2026-08-30T10:00:00.000Z',
      completedAt: null,
      items: [],
    },
  };
}

function healthyCatalogPayload() {
  return {
    items: [
      {
        id: DRILL_UUID,
        slug: 'contact-point-ladder',
        title: 'Contact point ladder',
        description: 'Meet the ball in front of the hip.',
        coach_name: 'Reviewed coach',
        equipment: ['paddle'],
        difficulty_min: null,
        difficulty_max: null,
        families: ['drive', 'global'],
        validation_state: 'UNVALIDATED',
        saved: false,
      },
    ],
  };
}

// ─── fetch double ───────────────────────────────────────────────────────────

function routeOf(url: string, method: string): FetchRoute | null {
  if (url.includes('/v1/training-plans/current')) return 'plan';
  if (url.includes('/v1/catalog/drills')) return 'catalog';
  if (url.includes('/v1/me/saved-drills') && method !== 'GET') return 'save';
  return null;
}

function jsonResponse(status: number, body: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

const scriptedFetch: typeof fetch = async (input, init) => {
  const reg = registry();
  const url = typeof input === 'string' ? input : String(input);
  const method = init?.method ?? 'GET';
  reg.fetch.calls.push({ method, url });
  const route = routeOf(url, method);
  const mode = route ? reg.fetch.faults[route] : undefined;
  const healthy = () => {
    switch (route) {
      case 'plan':
        return jsonResponse(200, JSON.stringify(healthyPlanPayload()));
      case 'catalog':
        return jsonResponse(200, JSON.stringify(healthyCatalogPayload()));
      case 'save':
        return jsonResponse(
          200,
          JSON.stringify({
            slug: decodeURIComponent(url.split('/').pop() ?? ''),
            saved: method === 'PUT',
          }),
        );
      case null:
        return jsonResponse(404, '{"error":{"code":"not_found"}}');
    }
  };
  switch (mode) {
    case undefined:
      return healthy();
    case 'reject':
      throw new TypeError(`Network request failed [seed ${reg.seed}]`);
    case 'hang':
      return new Promise<Response>(() => {});
    case 'slow':
      await sleep(5_000 + Math.floor(reg.rng() * 40_000));
      return healthy();
    case 'http401':
      return jsonResponse(401, '{"error":{"code":"unauthorized"}}');
    case 'http429':
      return jsonResponse(
        429,
        '{"error":{"code":"rate_limited","message":"Slow down"}}',
      );
    case 'http500':
      return jsonResponse(500, '{"error":{"code":"internal"}}');
    case 'http500-garbage':
      return jsonResponse(500, '<html>Bad gateway</html>');
    case 'malformed-json':
      return jsonResponse(200, '{"plan":{"id":');
    case 'partial':
      return jsonResponse(
        200,
        route === 'plan'
          ? JSON.stringify({ plan: { id: PLAN_ID, status: 'active' } })
          : route === 'catalog'
            ? JSON.stringify({ items: [{ slug: 'x', saved: false }] })
            : JSON.stringify({ slug: 'other-slug' }),
      );
    case 'wrong-shape':
      return jsonResponse(200, JSON.stringify([1, 2, 3]));
    case 'http204':
      return jsonResponse(204, '');
  }
};

// ─── Seeded RNG ─────────────────────────────────────────────────────────────

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

// ─── Fault catalog ──────────────────────────────────────────────────────────

type Dependency =
  | 'sqlite'
  | 'fetch'
  | 'camera-vision'
  | 'accessibility'
  | 'navigation'
  | 'clock';

type Phase = 'mount' | 'sync' | 'problem' | 'drills' | 'save';
const PHASE_ORDER: Phase[] = ['mount', 'sync', 'problem', 'drills', 'save'];

/**
 * What a fault takes away from `loadStrokeResultEvidence`:
 *  - 'payload'  the local_shot analysis (record.result still stands in)
 *  - 'record'   the analysis record (the payload still stands in)
 *  - 'evidence' the whole load (never resolves / cannot start / wrong key)
 * The analysis is only UNAVAILABLE when both stand-ins are gone or the load
 * itself is lost; a corrupt-but-present row loses nothing and must simply
 * not crash the screen.
 */
type Loss = 'payload' | 'record' | 'evidence' | null;

interface Fault {
  id: string;
  dependency: Dependency;
  mode: string;
  /** The user journey the fault must be observed on. */
  phase: Phase;
  loses: Loss;
  apply(reg: Registry): void;
}

const dbFault = (
  statement: DbStatement,
  mode: DbFaultMode,
  extra: Partial<Pick<Fault, 'phase' | 'loses'>> = {},
): Fault => ({
  id: `sqlite.${statement}.${mode}`,
  dependency: 'sqlite',
  mode,
  phase: extra.phase ?? 'mount',
  loses: extra.loses ?? null,
  apply: reg => {
    reg.db.faults[statement] = mode;
  },
});

/** `Promise.all` / awaited reads in the evidence loader never settle. */
const AWAITED_BY_EVIDENCE: DbStatement[] = [
  'shot.payload',
  'record',
  'capture',
  'shot.list',
];

function dbLoss(statement: DbStatement, mode: DbFaultMode): Loss {
  if (mode === 'hang') {
    return AWAITED_BY_EVIDENCE.includes(statement) ? 'evidence' : null;
  }
  if (statement === 'shot.payload') {
    return ['reject', 'throw', 'malformed', 'empty'].includes(mode)
      ? 'payload'
      : null;
  }
  if (statement === 'record') {
    return ['reject', 'throw', 'malformed', 'empty', 'partial'].includes(mode)
      ? 'record'
      : null;
  }
  return null;
}

const fetchFault = (
  route: FetchRoute,
  mode: FetchFaultMode,
  phase: Phase,
): Fault => ({
  id: `fetch.${route}.${mode}`,
  dependency: 'fetch',
  mode,
  phase,
  loses: null,
  apply: reg => {
    reg.fetch.faults[route] = mode;
  },
});

// The guide never links to the training-plan section for a scored read
// (product decision 2026-09-02) and the abstained page shows "A score is
// required." regardless of plan status, so the plan request fired on mount
// has no visible surface here: its outcome is asserted on the real training
// store instead (no fake `ready` plan from a failed or malformed response).
const abstainedFault: Fault = {
  id: 'sqlite.record.low-confidence',
  dependency: 'sqlite',
  mode: 'partial',
  phase: 'mount',
  loses: null,
  apply: reg => {
    reg.db.abstained = true;
    reg.db.shotPayload = JSON.stringify(abstainedAnalysisFixture());
  },
};

const cameraFault = (mode: NativeFaultMode): Fault => ({
  id: `camera-vision.readTextFile.${mode}`,
  dependency: 'camera-vision',
  mode,
  phase: 'problem',
  loses: null,
  apply: reg => {
    reg.camera.fault = mode;
  },
});

const sqliteFaults = (
  statement: DbStatement,
  modes: DbFaultMode[],
  phase: Phase = 'mount',
): Fault[] =>
  modes.map(mode =>
    dbFault(statement, mode, { phase, loses: dbLoss(statement, mode) }),
  );

const CATALOG: Fault[] = [
  // SQLite — a persisted low-confidence (abstained) read: ONE honest page
  abstainedFault,
  // SQLite — the analysis payload row
  ...sqliteFaults('shot.payload', [
    'reject',
    'throw',
    'hang',
    'slow',
    'malformed',
    'partial',
    'empty',
    'garbage',
  ]),
  // SQLite — the analysis record row
  ...sqliteFaults('record', [
    'reject',
    'throw',
    'hang',
    'slow',
    'malformed',
    'partial',
    'garbage',
  ]),
  // SQLite — the capture row (clip / review evidence)
  ...sqliteFaults('capture', [
    'reject',
    'throw',
    'hang',
    'slow',
    'malformed',
    'partial',
    'garbage',
  ]),
  // SQLite — the session attempt list + practice set + consistency history
  ...sqliteFaults('shot.list', ['reject', 'throw', 'hang', 'slow', 'garbage']),
  // SQLite — sync receipt
  ...sqliteFaults(
    'receipt',
    ['reject', 'throw', 'hang', 'slow', 'garbage'],
    'sync',
  ),
  // SQLite — outbox status
  ...sqliteFaults(
    'outbox',
    ['reject', 'throw', 'hang', 'slow', 'partial', 'garbage'],
    'sync',
  ),
  // SQLite — consistency kv
  ...sqliteFaults('kv', [
    'reject',
    'throw',
    'hang',
    'malformed',
    'partial',
    'garbage',
  ]),
  // SQLite — writes refused / hanging (consistency snapshot)
  ...sqliteFaults('write', ['reject', 'hang']),
  // SQLite — the handle itself cannot be opened
  {
    id: 'sqlite.open.throw',
    dependency: 'sqlite',
    mode: 'throw',
    phase: 'mount',
    loses: 'evidence',
    apply: reg => {
      reg.db.openThrows = true;
    },
  },
  // fetch — current plan (loaded on mount by the real training store)
  ...(
    [
      'reject',
      'hang',
      'slow',
      'http401',
      'http429',
      'http500',
      'http500-garbage',
      'malformed-json',
      'partial',
      'wrong-shape',
      'http204',
    ] as FetchFaultMode[]
  ).map(mode => fetchFault('plan', mode, 'mount')),
  // fetch — drill catalog (RecommendedDrills on the DRILLS page)
  ...(
    [
      'reject',
      'hang',
      'slow',
      'http401',
      'http429',
      'http500',
      'http500-garbage',
      'malformed-json',
      'partial',
      'wrong-shape',
      'http204',
    ] as FetchFaultMode[]
  ).map(mode => fetchFault('catalog', mode, 'drills')),
  // fetch — save drill (PUT on the DRILLS page)
  ...(
    [
      'reject',
      'hang',
      'slow',
      'http401',
      'http429',
      'http500',
      'malformed-json',
      'partial',
      'http204',
    ] as FetchFaultMode[]
  ).map(mode => fetchFault('save', mode, 'save')),
  // camera / Vision — the pose sidecar read behind the replay page
  ...(
    ['reject', 'throw', 'hang', 'slow', 'malformed'] as NativeFaultMode[]
  ).map(cameraFault),
  // navigation — malformed route params
  {
    id: 'navigation.params.missing-analysisId',
    dependency: 'navigation',
    mode: 'malformed',
    phase: 'mount',
    loses: 'evidence',
    apply: () => {
      routeParamsOverride = {};
    },
  },
  {
    id: 'navigation.params.wrong-type',
    dependency: 'navigation',
    mode: 'malformed',
    phase: 'mount',
    loses: 'evidence',
    apply: () => {
      routeParamsOverride = { analysisId: 42 };
    },
  },
  {
    id: 'navigation.params.unknown-id',
    dependency: 'navigation',
    mode: 'partial',
    phase: 'mount',
    loses: 'evidence',
    apply: () => {
      routeParamsOverride = { analysisId: 'does-not-exist' };
    },
  },
  // clock — malformed / skewed timestamps
  {
    id: 'clock.capturedAtIso.malformed',
    dependency: 'clock',
    mode: 'malformed',
    phase: 'mount',
    loses: null,
    apply: reg => {
      reg.db.shotPayload = JSON.stringify(
        analysisFixture({ capturedAtIso: 'not-a-date' }),
      );
    },
  },
  {
    id: 'clock.capturedAtIso.future',
    dependency: 'clock',
    mode: 'skew',
    phase: 'mount',
    loses: null,
    apply: reg => {
      reg.db.shotPayload = JSON.stringify(
        analysisFixture({ capturedAtIso: '2099-01-01T00:00:00.000Z' }),
      );
    },
  },
  {
    id: 'clock.system.rewound-years',
    dependency: 'clock',
    mode: 'skew',
    phase: 'mount',
    loses: null,
    apply: () => {
      jest.setSystemTime(new Date('2001-01-01T00:00:00.000Z'));
    },
  },
];

/**
 * The reduce-motion observer (`design/components.tsx startReducedMotionObserver`)
 * is started ONCE per module registry, so the native query can only be
 * faulted on the very first mount of this file. It is therefore run as its
 * own first scenario rather than as a catalog row, and the spy call proves
 * the seam was actually reached.
 */
const REDUCE_MOTION_FAULT: Fault = {
  id: 'accessibility.isReduceMotionEnabled.reject',
  dependency: 'accessibility',
  mode: 'reject',
  phase: 'mount',
  loses: null,
  apply: reg => {
    const error = new Error('reduce motion query failed');
    // A thenable that rejects, but also records whether the consumer
    // attached a rejection handler — Jest's own unhandled-rejection
    // detection fails the test independently of this record.
    const rejecting = {
      then(
        onFulfilled?: ((value: boolean) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ) {
        if (typeof onRejected !== 'function') {
          reg.unhandledNativeRejections.push(
            'AccessibilityInfo.isReduceMotionEnabled(): consumer attached no rejection handler',
          );
        }
        return Promise.reject(error).then(onFulfilled, onRejected);
      },
    };
    jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockReturnValue(rejecting as unknown as Promise<boolean>);
  },
};

let routeParamsOverride: Record<string, unknown> | null = null;

// ─── Render helpers ─────────────────────────────────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const stub = (label: string) => () => <Text>{`[${label}]`}</Text>;
const TabsStub = stub('Tabs');
const AnalyzeStub = stub('Analyze');
const FormReviewStub = stub('FormReview');
const DrillLibraryStub = stub('DrillLibrary');
const ResultDetailsStub = stub('ResultDetails');

function renderResultRoute(): TestRenderer.ReactTestRenderer {
  const params = routeParamsOverride ?? { analysisId: 'a1' };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <NavigationContainer
        initialState={{
          index: 1,
          routes: [{ name: 'Tabs' }, { name: 'Result', params }],
        }}
      >
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Tabs" component={TabsStub} />
          <Stack.Screen name="Result" component={ResultScreen} />
          <Stack.Screen name="Analyze" component={AnalyzeStub} />
          <Stack.Screen name="FormReview" component={FormReviewStub} />
          <Stack.Screen name="DrillLibrary" component={DrillLibraryStub} />
          <Stack.Screen name="ResultDetails" component={ResultDetailsStub} />
        </Stack.Navigator>
      </NavigationContainer>,
    );
  });
  return renderer;
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  const parts: string[] = [];
  const visit = (node: TestRenderer.ReactTestRendererJSON | string | null) => {
    if (node === null) return;
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    (node.children ?? []).forEach(child => visit(child));
  };
  const json = renderer.toJSON();
  if (Array.isArray(json)) json.forEach(visit);
  else visit(json);
  return parts.join(' | ');
}

const LOADING_CAPTIONS = [
  'Opening your result…',
  'Preparing your replay…',
  'Checking reviewed training…',
  'Checking sync evidence…',
  'Finding drills for this stroke…',
  'Verifying…',
] as const;

/** Every loading affordance still on screen: native activity indicators,
 * the brand "analyzing" spinner and the product's loading captions. */
function loadingIndicators(
  renderer: TestRenderer.ReactTestRenderer,
  visibleText: string,
): string[] {
  const found: string[] = [];
  const native = renderer.root.findAll(
    node => String(node.type) === 'ActivityIndicator',
  ).length;
  if (native > 0) found.push(`ActivityIndicator×${native}`);
  const analyzing = renderer.root.findAll(
    node =>
      (node.props as { testID?: string }).testID === 'stroke-result-analyzing',
  ).length;
  if (analyzing > 0) found.push(`stroke-result-analyzing×${analyzing}`);
  for (const caption of LOADING_CAPTIONS) {
    if (visibleText.includes(caption)) found.push(caption);
  }
  return found;
}

interface PressableMatch {
  node: TestRenderer.ReactTestInstance;
  label: string;
}

function labelOf(
  node: TestRenderer.ReactTestInstance,
  labels: readonly string[],
): string | null {
  const props = node.props as {
    onPress?: () => void;
    accessibilityLabel?: string;
  };
  if (typeof props.onPress !== 'function') return null;
  if (props.accessibilityLabel && labels.includes(props.accessibilityLabel)) {
    return props.accessibilityLabel;
  }
  return (
    labels.find(
      label =>
        node.findAll(
          child =>
            child.type === Text &&
            React.Children.toArray(
              (child.props as { children?: React.ReactNode }).children,
            ).join('') === label,
        ).length > 0,
    ) ?? null
  );
}

function findPressable(
  renderer: TestRenderer.ReactTestRenderer,
  labels: readonly string[],
): PressableMatch | null {
  for (const node of renderer.root.findAll(
    candidate =>
      typeof (candidate.props as { onPress?: unknown }).onPress === 'function',
  )) {
    const label = labelOf(node, labels);
    if (label !== null) return { node, label };
  }
  return null;
}

function press(node: TestRenderer.ReactTestInstance): void {
  act(() => {
    (node.props as { onPress: () => void }).onPress();
  });
}

const BACK_LABELS = ['Close', 'Go back', 'Done', 'Back'] as const;
const RETRY_LABELS = ['Try again', 'Retry', 'Go back', 'Dismiss'] as const;

// ─── Scenario execution ─────────────────────────────────────────────────────

interface Outcome {
  seed: number;
  faults: string[];
  phase: Phase;
  analysisUnavailable: boolean;
  crashed: string | null;
  crashStack: string[];
  unhandledRejections: string[];
  neverResolves: boolean;
  loadingAt60s: string[];
  backControl: string | null;
  backNavigated: boolean;
  retryControl: string | null;
  fakeSuccess: string | null;
  silentFailure: string | null;
  persistedWrites: number;
  corruptedWrites: string[];
  dbCalls: number;
  fetchCalls: number;
  cameraCalls: number;
  visibleText: string;
  verdict: 'HELD' | 'BROKEN';
  violations: string[];
}

const outcomes: Outcome[] = [];

function freshRegistry(seed: number): Registry {
  return {
    seed,
    rng: mulberry32(seed),
    execute: executeScripted,
    db: {
      faults: {},
      openThrows: false,
      calls: [],
      writes: [],
      shotPayload: JSON.stringify(analysisFixture()),
      captureRow: captureRowWithSidecar(),
      outboxRow: null,
      receiptRows: 1,
      abstained: false,
    },
    fetch: { faults: {}, calls: [] },
    camera: { fault: null, calls: 0 },
    unhandledNativeRejections: [],
  };
}

function installEnvironment(seed: number): Registry {
  const reg = freshRegistry(seed);
  globalThis.__stressResultScreen = reg;
  routeParamsOverride = null;
  jest.setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
  globalThis.fetch = scriptedFetch;
  const canonicalAppUserId = 'user-stress';
  establishApiSession({
    apiBaseUrl: 'https://stress.invalid',
    bearerToken: `bearer-${seed}`,
    canonicalAppUserId,
    provider: 'apple',
  });
  configureTrainingStore(
    createTrainingApi({
      baseUrl: 'https://stress.invalid',
      get token() {
        return bearerTokenFor(canonicalAppUserId);
      },
    }),
  );
  setActiveDataOwner('44444444-4444-4444-8444-444444444444');
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
  return reg;
}

function teardownEnvironment(): void {
  clearTrainingStoreConfiguration();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.restoreAllMocks();
  globalThis.__stressResultScreen = undefined;
  routeParamsOverride = null;
}

async function runScenario(seed: number, faults: Fault[]): Promise<Outcome> {
  const reg = installEnvironment(seed);
  faults.forEach(fault => fault.apply(reg));
  const phase = faults.reduce<Phase>(
    (deepest, fault) =>
      PHASE_ORDER.indexOf(fault.phase) > PHASE_ORDER.indexOf(deepest)
        ? fault.phase
        : deepest,
    'mount',
  );
  const losses = new Set(faults.map(f => f.loses));
  const analysisUnavailable =
    losses.has('evidence') || (losses.has('payload') && losses.has('record'));

  const rejections: string[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on('unhandledRejection', onRejection);
  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });

  let renderer: TestRenderer.ReactTestRenderer | null = null;
  let crashed: string | null = null;
  let crashStack: string[] = [];
  const violations: string[] = [];
  let backControl: string | null = null;
  let backNavigated = false;
  let retryControl: string | null = null;
  let fakeSuccess: string | null = null;
  let silentFailure: string | null = null;
  let loadingAt60s: string[] = [];
  let visibleText = '';

  try {
    renderer = renderResultRoute();
    await settle(60_000);

    // Walk the guide to the page where the fault must be observed: score →
    // problem → drills, via the footer's real "next" control each time.
    const pagesForward =
      PHASE_ORDER.indexOf(phase) >= PHASE_ORDER.indexOf('drills')
        ? 2
        : phase === 'problem'
          ? 1
          : 0;
    if (!analysisUnavailable) {
      for (let i = 0; i < pagesForward; i += 1) {
        const next = renderer.root.findAll(
          node =>
            (node.props as { testID?: string }).testID ===
              'result-guide-next' &&
            typeof (node.props as { onPress?: unknown }).onPress === 'function',
        )[0];
        if (!next) break;
        press(next);
        await settle(60_000);
      }
    }
    const catalogRequested = () =>
      reg.fetch.calls.some(call => call.url.includes('/v1/catalog/drills'));
    const saveRequested = () =>
      reg.fetch.calls.some(call => call.url.includes('/v1/me/saved-drills'));
    const catalogHealthy =
      reg.fetch.faults.catalog === undefined ||
      reg.fetch.faults.catalog === 'slow';

    if (!analysisUnavailable && phase === 'save') {
      const save = renderer.root.findAll(node => {
        const label = (node.props as { accessibilityLabel?: string })
          .accessibilityLabel;
        return (
          typeof label === 'string' &&
          label.startsWith('Save ') &&
          typeof (node.props as { onPress?: unknown }).onPress === 'function'
        );
      })[0];
      if (save) {
        press(save);
        await settle(60_000);
      } else if (catalogRequested() && catalogHealthy) {
        violations.push(
          'save phase: catalog loaded but no Save toggle was rendered',
        );
      }
    }

    visibleText = textOf(renderer);
    loadingAt60s = loadingIndicators(renderer, visibleText);

    // I4 no fake success
    if (analysisUnavailable && /out of 10|Score \d/.test(visibleText)) {
      fakeSuccess = 'score rendered while the analysis was unavailable';
    }
    if (
      saveRequested() &&
      reg.fetch.faults.save !== undefined &&
      reg.fetch.faults.save !== 'slow' &&
      renderer.root.findAll(
        node =>
          (node.props as { accessibilityState?: { selected?: boolean } })
            .accessibilityState?.selected === true,
      ).length > 0
    ) {
      fakeSuccess = 'drill shown as saved after the save request failed';
    }
    if (
      reg.db.faults.receipt !== undefined &&
      reg.db.faults.receipt !== 'slow' &&
      /Synced|server-accepted/i.test(visibleText)
    ) {
      fakeSuccess = 'sync shown as accepted after the receipt read failed';
    }
    const planFault = reg.fetch.faults.plan;
    const planRequested = reg.fetch.calls.some(
      call => routeOf(call.url, call.method) === 'plan',
    );
    if (planFault !== undefined && planFault !== 'slow' && planRequested) {
      const training = useTrainingStore.getState();
      if (training.planStatus === 'ready' || training.currentPlan !== null) {
        fakeSuccess = `training store reports plan ${training.planStatus} after a ${planFault} plan response`;
      } else if (
        planFault !== 'hang' &&
        (training.planStatus === 'loading' || training.planError === null)
      ) {
        silentFailure = `plan ${planFault} left the training store ${training.planStatus} with no error state`;
      }
    }
    if (fakeSuccess) violations.push(`I4 fake success: ${fakeSuccess}`);

    // I5 no silent failure — a fault on the user-visible read paths must
    // surface as honest copy or an honest state (missing / error / retry).
    if (
      analysisUnavailable &&
      !/Result missing|Opening your result/.test(visibleText)
    ) {
      silentFailure =
        'analysis unavailable but neither missing nor loading state shown';
    }
    if (
      catalogRequested() &&
      reg.fetch.faults.catalog !== undefined &&
      reg.fetch.faults.catalog !== 'slow' &&
      reg.fetch.faults.catalog !== 'hang' &&
      !/Retry|Browse library|could not|offline|expired|unavailable/i.test(
        visibleText,
      )
    ) {
      silentFailure = 'catalog request failed without visible error or retry';
    }
    if (
      saveRequested() &&
      reg.fetch.faults.save !== undefined &&
      reg.fetch.faults.save !== 'slow' &&
      reg.fetch.faults.save !== 'hang' &&
      !/Training not changed/.test(visibleText)
    ) {
      silentFailure =
        'save request failed without the "Training not changed" card';
    }
    if (silentFailure) violations.push(`I5 silent failure: ${silentFailure}`);

    // I2 no infinite spinner: 60s of fake time have elapsed since the last
    // interaction, so any loading affordance still on screen is indefinite.
    if (loadingAt60s.length > 0) {
      violations.push(
        `I2 loading state still visible after 60s: ${loadingAt60s.join(', ')}`,
      );
    }

    // I3 a visible, working back control
    retryControl = findPressable(renderer, RETRY_LABELS)?.label ?? null;
    const back = findPressable(renderer, BACK_LABELS);
    if (!back) {
      violations.push('I3 no visible back/close control');
    } else {
      backControl = back.label;
      press(back.node);
      await settle(1_000);
      backNavigated = /\[Tabs\]/.test(textOf(renderer));
      if (!backNavigated) {
        violations.push(`I3 back control "${backControl}" did not pop to Tabs`);
      }
    }
  } catch (error) {
    crashed = error instanceof Error ? error.message : String(error);
    crashStack =
      error instanceof Error && error.stack
        ? error.stack
            .split('\n')
            .slice(1, 9)
            .map(line => line.trim())
        : [];
    violations.push(`I1 crash: ${crashed}`);
  } finally {
    if (renderer) {
      try {
        act(() => renderer?.unmount());
      } catch (error) {
        violations.push(
          `I1 unmount threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    errorSpy.mockRestore();
    process.off('unhandledRejection', onRejection);
  }

  const reactErrors = consoleErrors.filter(
    line =>
      /The above error occurred|Uncaught|Cannot read|is not a function|not iterable/.test(
        line,
      ) && !/act\(\.\.\.\)/.test(line),
  );
  const firstReactError = reactErrors[0];
  if (firstReactError !== undefined && !crashed) {
    violations.push(`I1 console error: ${firstReactError.slice(0, 200)}`);
  }
  rejections.push(...reg.unhandledNativeRejections);
  if (rejections.length > 0) {
    violations.push(`I1 unhandled rejection: ${rejections[0]}`);
  }

  // I6 persisted state
  const corruptedWrites: string[] = [];
  reg.db.writes.forEach(write => {
    if (!/INTO\s+kv|UPDATE\s+kv/i.test(write.sql)) {
      corruptedWrites.push(`write outside kv: ${write.sql.slice(0, 60)}`);
      return;
    }
    const value = write.params.find(
      param => typeof param === 'string' && /^[[{]/.test(param),
    );
    if (typeof value !== 'string') return;
    try {
      JSON.parse(value);
    } catch {
      corruptedWrites.push(`kv write is not JSON: ${value.slice(0, 60)}`);
    }
  });
  if (corruptedWrites.length > 0) {
    violations.push(`I6 corrupted persisted state: ${corruptedWrites[0]}`);
  }

  teardownEnvironment();

  const outcome: Outcome = {
    seed,
    faults: faults.map(f => f.id),
    phase,
    analysisUnavailable,
    crashed,
    crashStack,
    unhandledRejections: rejections,
    neverResolves: faults.some(f => f.mode === 'hang'),
    loadingAt60s,
    backControl,
    backNavigated,
    retryControl,
    fakeSuccess,
    silentFailure,
    persistedWrites: reg.db.writes.length,
    corruptedWrites,
    dbCalls: reg.db.calls.length,
    fetchCalls: reg.fetch.calls.length,
    cameraCalls: reg.camera.calls,
    visibleText: visibleText.slice(0, 2000),
    verdict: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
  };
  outcomes.push(outcome);
  return outcome;
}

// ─── Campaign ───────────────────────────────────────────────────────────────

const STRESS_ITER = Number(process.env['STRESS_ITER'] ?? 12);
const STRESS_SEED = process.env['STRESS_SEED'];
const STRESS_REPEAT = Number(process.env['STRESS_REPEAT'] ?? 1);
const CAMPAIGN_SEED = 0x5ca1ab1e;

/** Catalog scenario seeds are `CAMPAIGN_SEED + index`; compound scenario
 * seeds are drawn from the campaign RNG so `STRESS_SEED=<n>` replays any
 * row of the table exactly. */
function faultsForSeed(seed: number): Fault[] {
  const index = seed - CAMPAIGN_SEED;
  const catalogEntry = CATALOG[index];
  if (catalogEntry !== undefined) return [catalogEntry];
  const rng = mulberry32(seed);
  const count = 2 + Math.floor(rng() * 2);
  const picked = new Map<Dependency | string, Fault>();
  while (picked.size < count) {
    const fault = CATALOG[Math.floor(rng() * CATALOG.length)];
    if (fault === undefined) continue;
    // One fault per dependency seam so the combination is well-defined.
    const key = fault.id.split('.').slice(0, 2).join('.');
    if (!picked.has(key)) picked.set(key, fault);
  }
  return [...picked.values()];
}

function compoundSeeds(): number[] {
  const rng = mulberry32(CAMPAIGN_SEED ^ 0xdeadbeef);
  const seeds: number[] = [];
  while (seeds.length < STRESS_ITER) {
    const seed = Math.floor(rng() * 0xffffffff);
    if (seed - CAMPAIGN_SEED >= 0 && seed - CAMPAIGN_SEED < CATALOG.length)
      continue;
    seeds.push(seed);
  }
  return seeds;
}

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  jest.useRealTimers();
  const path = process.env['STRESS_RESULTS_PATH'];
  if (path) {
    writeFileSync(
      path,
      JSON.stringify(
        {
          unit: 'scr-resultscreen',
          lens: 'failure-injection',
          catalogSize: CATALOG.length,
          stressIter: STRESS_ITER,
          executed: outcomes.length,
          held: outcomes.filter(o => o.verdict === 'HELD').length,
          broken: outcomes.filter(o => o.verdict === 'BROKEN').length,
          outcomes,
        },
        null,
        2,
      ),
    );
  }
});

describe('ResultScreen · failure injection (real navigator + stores)', () => {
  it('catalog covers every reachable dependency with >= 60 faults', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(60);
    expect(new Set(CATALOG.map(f => f.id)).size).toBe(CATALOG.length);
    expect(new Set(CATALOG.map(f => f.dependency))).toEqual(
      new Set<Dependency>([
        'sqlite',
        'fetch',
        'camera-vision',
        'navigation',
        'clock',
      ]),
    );
  });

  it('first mount: the native reduce-motion query rejecting is not a crash', async () => {
    const outcome = await runScenario(CAMPAIGN_SEED - 2, [REDUCE_MOTION_FAULT]);
    expect(AccessibilityInfo.isReduceMotionEnabled).toHaveBeenCalled();
    expect(outcome.violations).toEqual([]);
  });

  it('control: the healthy scored guide renders with no fault injected', async () => {
    const outcome = await runScenario(CAMPAIGN_SEED - 1, []);
    expect(outcome.visibleText).toMatch(/out of 10|SCORE/);
    expect(outcome.loadingAt60s).toEqual([]);
    expect(outcome.violations).toEqual([]);
  });

  if (STRESS_SEED !== undefined) {
    const seed = Number(STRESS_SEED);
    describe.each(
      Array.from({ length: Math.max(1, STRESS_REPEAT) }, (_, i) => [i + 1]),
    )('replay %d', () => {
      it(`seed ${seed}: recoverable, no fake success, no corrupted state`, async () => {
        const outcome = await runScenario(seed, faultsForSeed(seed));
        expect(outcome.violations).toEqual([]);
      });
    });
  } else {
    describe.each(
      CATALOG.map((fault, index) => [fault.id, CAMPAIGN_SEED + index]),
    )('fault %s', (_id, seed) => {
      it(`seed ${seed}: recoverable, no fake success, no corrupted state`, async () => {
        const outcome = await runScenario(seed, faultsForSeed(seed));
        expect(outcome.violations).toEqual([]);
      });
    });

    describe.each(compoundSeeds().map(seed => [seed]))(
      'compound seed %d',
      seed => {
        it('holds every invariant under combined faults', async () => {
          const outcome = await runScenario(seed, faultsForSeed(seed));
          expect(outcome.violations).toEqual([]);
        });
      },
    );
  }
});
