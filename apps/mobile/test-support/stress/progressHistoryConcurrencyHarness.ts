/**
 * CONCURRENCY stress harness for unit `mod-progress-api-history`:
 *   src/progress/api.ts                (fetchCanonicalProgress)
 *   src/progress/practiceHistory.ts    (aggregate/buildPracticeHistory)
 *   src/progress/practiceSetProgress.ts (summarize/latestPracticeSet)
 *
 * Every iteration is one seeded Promise.all burst against the REAL module
 * surfaces. Only `fetch`, the clock (jest modern fake timers) and the local
 * row store (a Map keyed by row id, standing in for the SQLite primary key
 * the repository reads through) are replaced. The seeded scheduler decides:
 *
 *  - which ops run (progress fetch / practice history / practice set), how
 *    they launch (synchronous burst, chained off another op's settlement =
 *    call-during-call, or from a timer), and which callers abandon their
 *    promise (cancel-during-call);
 *  - per fetch: header latency (some past PROGRESS_REQUEST_TIMEOUT_MS), a
 *    lost request, the body class (valid / empty / 401 / 5xx / malformed /
 *    null / wrong shape / bad row / stalled body), body latency;
 *  - session events while requests are in flight: bearer rotation, sign-out,
 *    re-sign-in as the same or the other actor (two actors on the same
 *    endpoint), wall-clock skew (jest.setSystemTime jumps);
 *  - row writes by two actors into the shared store between and during ops:
 *    fresh rows, rewrites of the SAME id (last writer wins), future-dated
 *    rows, invalid rows.
 *
 * Invariants judged per iteration (every failure names the seed):
 *   bounded            every launched op settles inside the fake-time budget
 *   deadline           latency ≥ timeout ⇒ ProgressApiError + signal aborted;
 *                      latency < timeout ⇒ signal never aborted
 *   typed_error        every rejection is a ProgressApiError (never raw)
 *   isolation          a resolved fetch holds exactly the body ITS server sent
 *   header_at_call     Authorization is the bearer of the session passed at
 *                      call time — rotation/sign-out mid-flight never leaks in
 *   one_fetch          exactly one fetch per op (no client retries)
 *   store_untouched    api.ts never writes the apiSession store; the session
 *                      object it was handed is not mutated
 *   no_timer_leak      no live timers once every op settled
 *   pure_*             history / practice-set: same input ⇒ deep-equal output,
 *                      order-independent, input rows never mutated
 *   oracle_*           history / practice-set fields equal an independent
 *                      re-derivation from the store snapshot at call time
 *                      (no lost update, duplicate ids collapse to one row)
 *   skew_monotone      moving asOf forward never removes lifetime evidence
 *
 * Replay one seed:
 *   STRESS_ONLY=<seed> npx jest --ci __tests__/stress/progressHistoryConcurrency.stress.test.ts
 */
import type { CapturedClip, CaptureEvidenceV1 } from '../../src/camera/capture';
import type {
  PendingCapture,
  RealAnalysisFact,
} from '../../src/data/repository';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  subscribeToApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import {
  fetchCanonicalProgress,
  PROGRESS_REQUEST_TIMEOUT_MS,
  ProgressApiError,
  type CanonicalProgress,
  type ProgressFetch,
} from '../../src/progress/api';
import {
  aggregatePracticeHistory,
  buildPracticeHistory,
  PRACTICE_HISTORY_RANGES,
  type PracticeHistory,
  type PracticeHistoryRangeKey,
} from '../../src/progress/practiceHistory';
import {
  latestPracticeSet,
  PRACTICE_SET_TREND_THRESHOLD_TENTHS,
  summarizePracticeSet,
  type PracticeSetSummary,
} from '../../src/progress/practiceSetProgress';

declare const process: {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};

export const API_BASE = 'https://api.stress.test';
export const ACTOR_A_ID = '2f3c9d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
export const ACTOR_B_ID = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
/** Fake wall clock at iteration start (jest.setSystemTime). */
export const EPOCH_ISO = '2026-09-05T12:00:00.000Z';
export const EPOCH_MS = Date.parse(EPOCH_ISO);
/** Fake-time budget per iteration; chained ops can stack several deadlines. */
export const MAX_FAKE_MS = 240_000;
export const FAKE_STEP_MS = 500;
export const MAX_TIMER_STEPS = MAX_FAKE_MS / FAKE_STEP_MS;

const DAY_MS = 86_400_000;
const TIME_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Asia/Kolkata',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
  'Europe/London',
] as const;
const STROKES = ['forehand_drive', 'dink', 'third_shot_drop', 'serve'] as const;
const SCORING_VERSIONS = ['sm-v1', 'sm-v2'] as const;
const CONFIG_VERSIONS = ['cfg-1', 'cfg-2'] as const;
const CHECKPOINTS = [
  'ready_position',
  'preparation',
  'contact_position',
  'follow_through',
] as const;
const SESSION_POOL = ['set-1', 'set-2', 'set-3'] as const;

/** Real wall clock, captured before jest fakes `Date`. */
const REAL_NOW: () => number = Date.now.bind(Date);

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

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
  int(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
    );
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
  weighted<T extends string>(table: Readonly<Record<T, number>>): T {
    const entries = Object.entries(table) as Array<[T, number]>;
    const total = entries.reduce((n, [, w]) => n + w, 0);
    let roll = this.next() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll < 0) return key;
    }
    return entries[entries.length - 1]![0];
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }
}

// ─── Scenario model ──────────────────────────────────────────────────────────

export type Actor = 'A' | 'B';

export type BodyClass =
  | 'ok'
  | 'ok_empty'
  | 'http_401'
  | 'http_500'
  | 'malformed_json'
  | 'null_body'
  | 'wrong_shape'
  | 'bad_series_row'
  | 'bad_streak'
  | 'body_never';

export interface FetchPlan {
  /** Fake ms until headers arrive (never exactly the timeout: the fake timer
   * queue would then decide the race by insertion order, not by the SUT). */
  headerLatencyMs: number;
  /** Network drops the request after `headerLatencyMs` (TypeError). */
  lost: boolean;
  body: BodyClass;
  /** Fake ms between headers and the body promise settling. */
  bodyLatencyMs: number;
}

export type Launch =
  | { mode: 'burst' }
  | { mode: 'timer'; atMs: number }
  | { mode: 'chained'; parent: number };

export type OpKind = 'fetch' | 'history' | 'practiceSet';

export interface OpPlan {
  index: number;
  kind: OpKind;
  launch: Launch;
  abandon: boolean;
  /** fetch only */
  fetch?: FetchPlan;
  /** history / practiceSet only */
  timeZone?: string;
  range?: PracticeHistoryRangeKey;
  maxAgeMs?: number;
  skewProbeMs?: number;
}

export type SessionEvent =
  | { at: number; type: 'rotate'; actor: Actor }
  | { at: number; type: 'logout' }
  | { at: number; type: 'login'; actor: Actor }
  | { at: number; type: 'skew'; deltaMs: number }
  | { at: number; type: 'writeFact'; actor: Actor; write: FactWrite }
  | { at: number; type: 'writeCapture'; actor: Actor; write: CaptureWrite };

export interface FactWrite {
  id: string;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: 'scored' | 'low_confidence';
  scoringModelVersion: string;
  shotConfigVersion: string;
  sessionId: string | null;
  priorityCheckpoint: string | null;
  checkpointScores: Record<string, number>;
}

export type CaptureWriteShape =
  | 'automatic'
  | 'imported_measured'
  | 'imported_unmeasured'
  | 'legacy'
  | 'corrupt_no_clip'
  | 'metadata_mismatch'
  | 'no_zone_timestamp';

export interface CaptureWrite {
  id: string;
  capturedAtIso: string;
  shape: CaptureWriteShape;
  poseFrameCount: number;
  poseMissingFrameCount: number;
  trackedDurationMs: number;
  meanJointCoverage: number;
  minimumJointCoverage: number;
  meanCanonicalJointVisibility: number;
  fullBodyVisibleFrameCount: number;
}

export interface Scenario {
  seed: number;
  ops: OpPlan[];
  /** Applied synchronously between burst launches (index = launch slot). */
  burstWrites: Array<{ slot: number; event: SessionEvent }>;
  events: SessionEvent[];
  initialFacts: FactWrite[];
  initialCaptures: CaptureWrite[];
  initialActor: Actor;
}

// ─── Scenario generation ─────────────────────────────────────────────────────

function isoAround(rng: Rng, spreadDays: number, futureChance: number): string {
  const sign = rng.chance(futureChance) ? 1 : -1;
  const offset = rng.int(0, spreadDays * DAY_MS);
  return new Date(EPOCH_MS + sign * offset).toISOString();
}

function genFactWrite(rng: Rng, actor: Actor, seq: number): FactWrite {
  const shared = rng.chance(0.3);
  const id = shared ? `fact-shared-${rng.int(0, 5)}` : `fact-${actor}-${seq}`;
  const scored = rng.chance(0.8);
  const tenths = rng.int(0, 100);
  const checkpointScores: Record<string, number> = {};
  for (const key of CHECKPOINTS) {
    if (rng.chance(0.7)) checkpointScores[key] = rng.int(0, 100);
  }
  const capturedAt = rng.chance(0.04)
    ? 'not-a-timestamp'
    : rng.chance(0.5)
      ? new Date(EPOCH_MS - rng.int(0, 6 * 3_600_000)).toISOString()
      : isoAround(rng, 10, 0.15);
  return {
    id,
    shotType: rng.chance(0.7) ? STROKES[0] : rng.pick(STROKES),
    capturedAt,
    overallScore: scored ? (rng.chance(0.03) ? Number.NaN : tenths / 10) : null,
    resultKind: scored ? 'scored' : 'low_confidence',
    scoringModelVersion: rng.chance(0.8)
      ? SCORING_VERSIONS[0]
      : rng.pick(SCORING_VERSIONS),
    shotConfigVersion: rng.chance(0.85)
      ? CONFIG_VERSIONS[0]
      : rng.pick(CONFIG_VERSIONS),
    sessionId: rng.chance(0.85) ? rng.pick(SESSION_POOL) : null,
    priorityCheckpoint: rng.chance(0.6) ? rng.pick(CHECKPOINTS) : null,
    checkpointScores,
  };
}

function genCaptureWrite(rng: Rng, actor: Actor, seq: number): CaptureWrite {
  const shared = rng.chance(0.3);
  const id = shared ? `cap-shared-${rng.int(0, 5)}` : `cap-${actor}-${seq}`;
  const shape = rng.weighted<CaptureWriteShape>({
    automatic: 50,
    imported_measured: 14,
    imported_unmeasured: 8,
    legacy: 6,
    corrupt_no_clip: 6,
    metadata_mismatch: 8,
    no_zone_timestamp: 8,
  });
  const capturedAtIso =
    shape === 'no_zone_timestamp'
      ? new Date(EPOCH_MS - rng.int(0, 5 * DAY_MS)).toISOString().slice(0, 19)
      : isoAround(rng, 40, 0.1);
  const poseFrameCount = rng.int(1, 40);
  return {
    id,
    capturedAtIso,
    shape,
    poseFrameCount,
    poseMissingFrameCount: rng.int(0, 10),
    trackedDurationMs: rng.int(100, 2_000),
    meanJointCoverage: rng.int(30, 100) / 100,
    minimumJointCoverage: rng.int(0, 30) / 100,
    meanCanonicalJointVisibility: rng.int(30, 100) / 100,
    fullBodyVisibleFrameCount: rng.int(0, poseFrameCount),
  };
}

function genFetchPlan(rng: Rng): FetchPlan {
  const slow = rng.chance(0.2);
  const headerLatencyMs = slow
    ? rng.int(PROGRESS_REQUEST_TIMEOUT_MS + 1, PROGRESS_REQUEST_TIMEOUT_MS * 2)
    : rng.int(1, PROGRESS_REQUEST_TIMEOUT_MS - 1);
  return {
    headerLatencyMs,
    lost: rng.chance(0.1),
    body: rng.weighted<BodyClass>({
      ok: 45,
      ok_empty: 10,
      http_401: 8,
      http_500: 8,
      malformed_json: 6,
      null_body: 5,
      wrong_shape: 6,
      bad_series_row: 5,
      bad_streak: 4,
      body_never: 3,
    }),
    bodyLatencyMs: rng.chance(0.3) ? rng.int(1, 20_000) : rng.int(0, 200),
  };
}

export function generateScenario(seed: number): Scenario {
  const rng = new Rng(seed);
  const opCount = rng.int(6, 22);
  const ops: OpPlan[] = [];
  for (let index = 0; index < opCount; index += 1) {
    const kind = rng.weighted<OpKind>({
      fetch: 50,
      history: 25,
      practiceSet: 25,
    });
    const launchMode = rng.weighted<Launch['mode']>({
      burst: 55,
      timer: 25,
      chained: index === 0 ? 0 : 20,
    });
    const launch: Launch =
      launchMode === 'burst'
        ? { mode: 'burst' }
        : launchMode === 'timer'
          ? { mode: 'timer', atMs: rng.int(1, 30_000) }
          : { mode: 'chained', parent: rng.int(0, index - 1) };
    const op: OpPlan = {
      index,
      kind,
      launch,
      abandon: rng.chance(0.15),
    };
    if (kind === 'fetch') {
      op.fetch = genFetchPlan(rng);
      // Duplicate call: repeat the previous fetch plan verbatim sometimes.
      const previous = ops[index - 1];
      if (previous?.fetch && rng.chance(0.25)) {
        op.fetch = { ...previous.fetch };
      }
    } else {
      op.timeZone = rng.pick(TIME_ZONES);
      op.range = rng.pick(PRACTICE_HISTORY_RANGES).key;
      op.maxAgeMs = rng.pick([3_600_000, 24 * 3_600_000, 7 * DAY_MS]);
      op.skewProbeMs = rng.int(-2 * DAY_MS, 2 * DAY_MS);
    }
    ops.push(op);
  }

  const initialFacts: FactWrite[] = [];
  const factCount = rng.int(0, 12);
  for (let i = 0; i < factCount; i += 1) {
    initialFacts.push(genFactWrite(rng, rng.pick(['A', 'B']), 1000 + i));
  }
  const initialCaptures: CaptureWrite[] = [];
  const captureCount = rng.int(0, 14);
  for (let i = 0; i < captureCount; i += 1) {
    initialCaptures.push(genCaptureWrite(rng, rng.pick(['A', 'B']), 1000 + i));
  }

  const genEvent = (at: number, seq: number): SessionEvent => {
    const type = rng.weighted<SessionEvent['type']>({
      rotate: 18,
      logout: 10,
      login: 12,
      skew: 15,
      writeFact: 22,
      writeCapture: 23,
    });
    const actor: Actor = rng.pick(['A', 'B']);
    switch (type) {
      case 'rotate':
        return { at, type, actor };
      case 'logout':
        return { at, type };
      case 'login':
        return { at, type, actor };
      case 'skew':
        return {
          at,
          type,
          deltaMs: rng.pick([
            -2 * DAY_MS,
            -3_600_000,
            -30_000,
            30_000,
            3_600_000,
            2 * DAY_MS,
            30 * DAY_MS,
          ]),
        };
      case 'writeFact':
        return { at, type, actor, write: genFactWrite(rng, actor, seq) };
      case 'writeCapture':
        return { at, type, actor, write: genCaptureWrite(rng, actor, seq) };
      default:
        throw new Error(`unreachable event type ${String(type)}`);
    }
  };

  const burstWrites: Scenario['burstWrites'] = [];
  const burstSlots = ops.filter(op => op.launch.mode === 'burst').length;
  const burstWriteCount = rng.int(0, Math.min(4, burstSlots));
  for (let i = 0; i < burstWriteCount; i += 1) {
    burstWrites.push({
      slot: rng.int(0, burstSlots),
      event: genEvent(0, 2000 + i),
    });
  }

  const events: SessionEvent[] = [];
  const eventCount = rng.int(2, 12);
  for (let i = 0; i < eventCount; i += 1) {
    events.push(genEvent(rng.int(1, 40_000), 3000 + i));
  }
  events.sort((left, right) => left.at - right.at);

  return {
    seed,
    ops,
    burstWrites,
    events,
    initialFacts,
    initialCaptures,
    initialActor: rng.pick(['A', 'B']),
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function toFact(write: FactWrite): RealAnalysisFact {
  return {
    id: write.id,
    shotType: write.shotType,
    capturedAt: write.capturedAt,
    overallScore: write.overallScore,
    confidence: 0.9,
    resultKind: write.resultKind,
    scoringModelVersion: write.scoringModelVersion,
    shotConfigVersion: write.shotConfigVersion,
    sessionId: write.sessionId,
    priorityCheckpoint: write.priorityCheckpoint,
    checkpointScores: { ...write.checkpointScores },
  };
}

type AutomaticClip = Extract<
  CapturedClip,
  { captureMode: 'automatic_pose_trigger' }
>;
type ImportedClip = Extract<CapturedClip, { captureMode: 'imported_video' }>;

function toCapture(write: CaptureWrite): PendingCapture {
  const uri = `file:///captures/${write.id}.mov`;
  const base = {
    id: write.id,
    shotType: 'unrecognized',
    declaredStroke: null,
    uri,
    capturedAtIso: write.capturedAtIso,
    durationMs: 3_000,
    fps: 60,
    width: 1_080,
    height: 1_920,
  } as const;
  if (write.shape === 'corrupt_no_clip') {
    return { ...base, clip: null, evidenceStatus: 'corrupt' };
  }
  if (
    write.shape === 'imported_measured' ||
    write.shape === 'imported_unmeasured'
  ) {
    const clip: ImportedClip = {
      uri,
      capturedAtIso: write.capturedAtIso,
      durationMs: base.durationMs,
      fps: base.fps,
      width: base.width,
      height: base.height,
      captureMode: 'imported_video',
      recognition: { status: 'unknown', reason: 'analysis_not_run' },
      ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
      ...(write.shape === 'imported_measured'
        ? {
            poseSequence: {
              schemaVersion: 1 as const,
              format: 'pickle.pose-sequence.v1' as const,
              uri: `file:///captures/${write.id}.pose.json`,
              frameCount: 96,
              sha256: 'b'.repeat(64),
              coordinateSystem: 'normalized_image_top_left' as const,
              poseModelVersion: 'apple-vision-bodypose-1',
            },
          }
        : {}),
    };
    return { ...base, clip, evidenceStatus: 'valid' };
  }
  const evidence: CaptureEvidenceV1 = {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    analysisInputFrameCount: write.poseFrameCount + write.poseMissingFrameCount,
    poseFrameCount: write.poseFrameCount,
    poseMissingFrameCount: write.poseMissingFrameCount,
    trackedDurationMs: write.trackedDurationMs,
    meanCanonicalJointVisibility: write.meanCanonicalJointVisibility,
    meanJointCoverage: write.meanJointCoverage,
    minimumJointCoverage: write.minimumJointCoverage,
    fullBodyVisibleFrameCount: write.fullBodyVisibleFrameCount,
    jointMotion: [
      {
        joint: 'right_wrist',
        sampleCount: 2,
        meanNormalizedPerSecond: 0.8,
        peakNormalizedPerSecond: 1.2,
      },
    ],
  };
  const clip: AutomaticClip = {
    uri,
    capturedAtIso: write.capturedAtIso,
    durationMs: write.shape === 'metadata_mismatch' ? 2_999 : base.durationMs,
    fps: base.fps,
    width: base.width,
    height: base.height,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 1_000,
      endMs: 1_800,
      peakMotionMs: 1_500,
      confidence: 0.82,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: evidence,
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 1_000,
    postRollMs: 1_200,
  };
  return {
    ...base,
    clip,
    evidenceStatus: write.shape === 'legacy' ? 'legacy' : 'valid',
  };
}

function sessionFor(actor: Actor, generation: number): ApiSession {
  return {
    apiBaseUrl: API_BASE,
    bearerToken: `tok-${actor}-${generation}`,
    canonicalAppUserId: actor === 'A' ? ACTOR_A_ID : ACTOR_B_ID,
    provider: actor === 'A' ? 'apple' : 'google',
  };
}

// ─── Fake server ─────────────────────────────────────────────────────────────

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

function serverPayload(opIndex: number, body: BodyClass): unknown {
  const okSeries = [
    {
      day: '2026-09-04',
      shot_type: `op-${opIndex}`,
      scoring_model_version: 'sm-v1',
      shot_count: opIndex + 1,
      avg_score: 700 + opIndex,
      best_score: '830',
    },
  ];
  const streak = {
    currentDays: 2,
    longestDays: 5,
    practicedToday: true,
    lastPracticeDate: '2026-09-04',
  };
  switch (body) {
    case 'ok':
    case 'http_401':
    case 'http_500':
    case 'body_never':
      return {
        series: okSeries,
        improving: [{ checkpoint: 'preparation', delta: opIndex }],
        needsAttention: [{ checkpoint: 'contact_position', avg: 61.5 }],
        streak,
      };
    case 'ok_empty':
      return {
        series: [],
        improving: [],
        needsAttention: [],
        streak: {
          currentDays: 0,
          longestDays: 0,
          practicedToday: false,
          lastPracticeDate: null,
        },
      };
    case 'null_body':
      return null;
    case 'wrong_shape':
      return { series: 'nope', improving: [], needsAttention: [], streak };
    case 'bad_series_row':
      return {
        series: [{ ...okSeries[0], day: 42 }],
        improving: [],
        needsAttention: [],
        streak,
      };
    case 'bad_streak':
      return {
        series: okSeries,
        improving: [],
        needsAttention: [],
        streak: { ...streak, practicedToday: 'yes' },
      };
    case 'malformed_json':
      return undefined;
  }
}

function expectedProgress(opIndex: number): CanonicalProgress {
  return {
    series: [
      {
        day: '2026-09-04',
        shotType: `op-${opIndex}`,
        scoringModelVersion: 'sm-v1',
        shotCount: opIndex + 1,
        avgScore: (700 + opIndex) / 10,
        bestScore: 83,
      },
    ],
    improving: [{ checkpoint: 'preparation', delta: opIndex }],
    needsAttention: [{ checkpoint: 'contact_position', avg: 61.5 }],
    streak: {
      currentDays: 2,
      longestDays: 5,
      practicedToday: true,
      lastPracticeDate: '2026-09-04',
    },
  };
}

const EMPTY_PROGRESS: CanonicalProgress = {
  series: [],
  improving: [],
  needsAttention: [],
  streak: {
    currentDays: 0,
    longestDays: 0,
    practicedToday: false,
    lastPracticeDate: null,
  },
};

function abortError(): Error {
  return Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

interface FetchRecord {
  url: string;
  init: RequestInit | undefined;
  signal: AbortSignal | null | undefined;
}

function makeFetch(
  opIndex: number,
  plan: FetchPlan,
  records: FetchRecord[],
): ProgressFetch {
  return (url, init) => {
    records.push({ url, init, signal: init?.signal });
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = (): void => {
        clearTimeout(headerTimer);
        reject(abortError());
      };
      const headerTimer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        if (plan.lost) {
          reject(new TypeError('Network request failed'));
          return;
        }
        const status =
          plan.body === 'http_401' ? 401 : plan.body === 'http_500' ? 500 : 200;
        const response: FakeResponse = {
          ok: status >= 200 && status < 300,
          status,
          json: () =>
            new Promise<unknown>((resolveBody, rejectBody) => {
              if (plan.body === 'body_never') return;
              setTimeout(() => {
                if (plan.body === 'malformed_json') {
                  rejectBody(new SyntaxError('Unexpected token < in JSON'));
                } else {
                  resolveBody(serverPayload(opIndex, plan.body));
                }
              }, plan.bodyLatencyMs);
            }),
        };
        resolve(response as unknown as Response);
      }, plan.headerLatencyMs);
      signal?.addEventListener('abort', onAbort);
    });
  };
}

// ─── Independent oracles ─────────────────────────────────────────────────────

function hasExplicitZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
}

function dayIn(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string): string =>
    parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function ordinalOf(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
}

interface HistoryOracle {
  eligibleCount: number;
  cameraCount: number;
  importedCount: number;
  excludedCount: number;
  activeDays: string[];
  currentCount: number;
  currentDays: number;
  longestDays: number;
  currentStreak: number;
  practicedToday: boolean;
  lastPracticeDay: string | null;
  trackedDurationMs: number;
}

function oracleHistory(
  rows: readonly PendingCapture[],
  asOfIso: string,
  timeZone: string,
  rangeDays: number,
): HistoryOracle {
  const asOfMs = Date.parse(asOfIso);
  const asOfOrdinal = ordinalOf(dayIn(asOfMs, timeZone));
  const startOrdinal = asOfOrdinal - rangeDays + 1;
  const active = new Set<string>();
  let eligibleCount = 0;
  let cameraCount = 0;
  let importedCount = 0;
  let currentCount = 0;
  let trackedDurationMs = 0;
  const currentActive = new Set<string>();
  for (const row of rows) {
    const clip = row.clip;
    if (row.evidenceStatus !== 'valid' || !clip) continue;
    if (
      clip.uri !== row.uri ||
      clip.capturedAtIso !== row.capturedAtIso ||
      clip.durationMs !== row.durationMs ||
      clip.fps !== row.fps ||
      clip.width !== row.width ||
      clip.height !== row.height
    ) {
      continue;
    }
    const measured =
      clip.captureMode === 'automatic_pose_trigger' ||
      clip.poseSequence !== undefined;
    if (!measured) continue;
    if (!hasExplicitZone(row.capturedAtIso)) continue;
    const ms = Date.parse(row.capturedAtIso);
    if (!Number.isFinite(ms) || ms > asOfMs) continue;
    eligibleCount += 1;
    const day = dayIn(ms, timeZone);
    active.add(day);
    if (clip.captureMode === 'automatic_pose_trigger') {
      cameraCount += 1;
      const ordinal = ordinalOf(day);
      if (ordinal >= startOrdinal && ordinal <= asOfOrdinal) {
        trackedDurationMs += clip.captureEvidence.trackedDurationMs;
      }
    } else {
      importedCount += 1;
    }
    const ordinal = ordinalOf(day);
    if (ordinal >= startOrdinal && ordinal <= asOfOrdinal) {
      currentCount += 1;
      currentActive.add(day);
    }
  }
  const ordinals = [...active].map(ordinalOf).sort((a, b) => a - b);
  let longestDays = ordinals.length > 0 ? 1 : 0;
  let run = 1;
  for (let i = 1; i < ordinals.length; i += 1) {
    run = ordinals[i] === ordinals[i - 1]! + 1 ? run + 1 : 1;
    longestDays = Math.max(longestDays, run);
  }
  const latest = ordinals[ordinals.length - 1];
  let currentStreak = 0;
  if (latest !== undefined && latest >= asOfOrdinal - 1) {
    currentStreak = 1;
    for (let i = ordinals.length - 2; i >= 0; i -= 1) {
      if (ordinals[i] !== latest - currentStreak) break;
      currentStreak += 1;
    }
  }
  return {
    eligibleCount,
    cameraCount,
    importedCount,
    excludedCount: rows.length - eligibleCount,
    activeDays: [...active].sort(),
    currentCount,
    currentDays: currentActive.size,
    longestDays,
    currentStreak,
    practicedToday: latest === asOfOrdinal,
    lastPracticeDay:
      latest === undefined
        ? null
        : new Date(latest * DAY_MS).toISOString().slice(0, 10),
    trackedDurationMs,
  };
}

interface SetOracle {
  attemptIds: string[];
  deltaTenths: number;
  trend: PracticeSetSummary['trend'];
  excludedCount: number;
  bestId: string;
  shotType: string;
}

function oracleSummarize(
  rows: readonly RealAnalysisFact[],
  sessionId: string,
): SetOracle | null {
  const scored = rows
    .filter(
      row =>
        row.sessionId === sessionId &&
        row.resultKind === 'scored' &&
        typeof row.overallScore === 'number' &&
        Number.isFinite(row.overallScore) &&
        Number.isFinite(Date.parse(row.capturedAt)),
    )
    .map(row => ({ row, ms: Date.parse(row.capturedAt) }))
    .sort(
      (a, b) =>
        a.ms - b.ms || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
    );
  const newest = scored[scored.length - 1];
  if (!newest) return null;
  const sameStroke = scored.filter(e => e.row.shotType === newest.row.shotType);
  const comparable = sameStroke.filter(
    e =>
      e.row.scoringModelVersion === newest.row.scoringModelVersion &&
      e.row.shotConfigVersion === newest.row.shotConfigVersion,
  );
  if (comparable.length < 2) return null;
  const tenths = (score: number): number => Math.round(score * 10);
  const first = comparable[0]!;
  const latest = comparable[comparable.length - 1]!;
  let best = first;
  for (const e of comparable) {
    if (tenths(e.row.overallScore!) >= tenths(best.row.overallScore!)) best = e;
  }
  const deltaTenths =
    tenths(latest.row.overallScore!) - tenths(first.row.overallScore!);
  return {
    attemptIds: comparable.map(e => e.row.id),
    deltaTenths,
    trend:
      deltaTenths >= PRACTICE_SET_TREND_THRESHOLD_TENTHS
        ? 'improved'
        : deltaTenths <= -PRACTICE_SET_TREND_THRESHOLD_TENTHS
          ? 'slipped'
          : 'held',
    excludedCount: sameStroke.length - comparable.length,
    bestId: best.row.id,
    shotType: newest.row.shotType,
  };
}

function oracleLatestSession(
  rows: readonly RealAnalysisFact[],
  asOfIso: string,
  maxAgeMs: number,
): string | null {
  const asOfMs = Date.parse(asOfIso);
  const visible = rows.filter(row => {
    const ms = Date.parse(row.capturedAt);
    return Number.isFinite(ms) && ms <= asOfMs;
  });
  const latestBySession = new Map<string, number>();
  for (const row of visible) {
    if (
      row.sessionId === null ||
      row.resultKind !== 'scored' ||
      typeof row.overallScore !== 'number' ||
      !Number.isFinite(row.overallScore)
    ) {
      continue;
    }
    const ms = Date.parse(row.capturedAt);
    const previous = latestBySession.get(row.sessionId);
    if (previous === undefined || ms > previous) {
      latestBySession.set(row.sessionId, ms);
    }
  }
  const candidates = [...latestBySession.entries()]
    .filter(([, ms]) => asOfMs - ms <= maxAgeMs)
    .sort(([a, aMs], [b, bMs]) => bMs - aMs || (a < b ? -1 : a > b ? 1 : 0));
  for (const [sessionId] of candidates) {
    if (oracleSummarize(visible, sessionId)) return sessionId;
  }
  return null;
}

// ─── Iteration runner ────────────────────────────────────────────────────────

export interface Failure {
  invariant: string;
  op: string;
  detail: string;
}

export interface IterationResult {
  seed: number;
  failures: Failure[];
  stats: {
    ops: number;
    launched: number;
    settled: number;
    notLaunched: number;
    fetchOps: number;
    historyOps: number;
    practiceSetOps: number;
    abandoned: number;
    chained: number;
    duplicates: number;
    events: number;
    burstWrites: number;
    timerSteps: number;
    fakeMs: number;
    realMs: number;
    finalFactRows: number;
    finalCaptureRows: number;
    bodyClasses: Record<string, number>;
    pastDeadlineFetches: number;
    lostFetches: number;
    signedOutSkips: number;
    sessionEvents: number;
    skewEvents: number;
    rowWrites: number;
  };
  replay: string;
}

interface OpState {
  plan: OpPlan;
  launched: boolean;
  launchedAtFakeMs: number | null;
  settled: boolean;
  settledAtFakeMs: number | null;
  outcome: 'resolved' | 'rejected' | 'skipped_signed_out' | null;
  value: unknown;
  error: unknown;
  sessionAtCall: ApiSession | null;
  sessionSnapshot: string | null;
  fetchRecords: FetchRecord[];
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const record = inner as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = record[key];
          return acc;
        }, {});
    }
    if (typeof inner === 'number' && Number.isNaN(inner)) return 'NaN';
    return inner;
  });
}

export async function runIteration(seed: number): Promise<IterationResult> {
  const scenario = generateScenario(seed);
  const rng = new Rng(seed ^ 0x9e3779b9);
  const failures: Failure[] = [];
  const fail = (invariant: string, op: string, detail: string): void => {
    failures.push({ invariant, op, detail });
  };
  const realStart = REAL_NOW();

  jest.useFakeTimers({ now: EPOCH_MS });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  const factStore = new Map<string, RealAnalysisFact>();
  const captureStore = new Map<string, PendingCapture>();
  for (const write of scenario.initialFacts)
    factStore.set(write.id, toFact(write));
  for (const write of scenario.initialCaptures) {
    captureStore.set(write.id, toCapture(write));
  }

  const generation: Record<Actor, number> = { A: 0, B: 0 };
  clearApiSession();
  establishApiSession(sessionFor(scenario.initialActor, 0));
  let expectedStoreWrites = 0;
  let observedStoreWrites = 0;
  const unsubscribe = subscribeToApiSession(() => {
    observedStoreWrites += 1;
  });
  let executedEvents = 0;

  const applyEvent = (event: SessionEvent): void => {
    executedEvents += 1;
    switch (event.type) {
      case 'rotate': {
        const current = getApiSession();
        generation[event.actor] += 1;
        if (
          current &&
          current.canonicalAppUserId ===
            sessionFor(event.actor, 0).canonicalAppUserId
        ) {
          establishApiSession(sessionFor(event.actor, generation[event.actor]));
          expectedStoreWrites += 1;
        }
        return;
      }
      case 'logout':
        // zustand notifies on every setState, including null → null.
        expectedStoreWrites += 1;
        clearApiSession();
        return;
      case 'login':
        generation[event.actor] += 1;
        establishApiSession(sessionFor(event.actor, generation[event.actor]));
        expectedStoreWrites += 1;
        return;
      case 'skew':
        jest.setSystemTime(Date.now() + event.deltaMs);
        return;
      case 'writeFact':
        factStore.set(event.write.id, toFact(event.write));
        return;
      case 'writeCapture':
        captureStore.set(event.write.id, toCapture(event.write));
        return;
    }
  };

  const states: OpState[] = scenario.ops.map(plan => ({
    plan,
    launched: false,
    launchedAtFakeMs: null,
    settled: false,
    settledAtFakeMs: null,
    outcome: null,
    value: null,
    error: null,
    sessionAtCall: null,
    sessionSnapshot: null,
    fetchRecords: [],
  }));
  const fakeNow = (): number => Date.now();
  let fakeElapsed = 0;
  const children = new Map<number, OpState[]>();
  for (const state of states) {
    if (state.plan.launch.mode === 'chained') {
      const list = children.get(state.plan.launch.parent) ?? [];
      list.push(state);
      children.set(state.plan.launch.parent, list);
    }
  }

  const runHistoryOp = (state: OpState): void => {
    const plan = state.plan;
    const label = `op${plan.index}:history`;
    const rows = [...captureStore.values()];
    const before = stableJson(rows);
    const asOfIso = new Date(fakeNow()).toISOString();
    const timeZone = plan.timeZone!;
    const range = plan.range!;
    const rangeDays = PRACTICE_HISTORY_RANGES.find(r => r.key === range)!.days;
    let first: ReturnType<typeof buildPracticeHistory>;
    let full: PracticeHistory;
    try {
      first = buildPracticeHistory(rows, { asOfIso, timeZone, range });
      full = aggregatePracticeHistory(rows, { asOfIso, timeZone, rangeDays });
    } catch (error) {
      fail('typed_error', label, `threw on valid input: ${String(error)}`);
      return;
    }
    const second = buildPracticeHistory(rows, { asOfIso, timeZone, range });
    if (stableJson(first) !== stableJson(second)) {
      fail('pure_idempotent', label, 'two calls on the same rows differ');
    }
    const shuffled = buildPracticeHistory(rng.shuffle(rows), {
      asOfIso,
      timeZone,
      range,
    });
    if (stableJson(first) !== stableJson(shuffled)) {
      fail('pure_order_independent', label, 'shuffled rows change the result');
    }
    if (stableJson(rows) !== before) {
      fail('pure_no_mutation', label, 'input rows were mutated');
    }
    const oracle = oracleHistory(rows, asOfIso, timeZone, rangeDays);
    const checks: Array<[string, unknown, unknown]> = [
      [
        'lifetime.eligibleCaptureCount',
        full.lifetime.eligibleCaptureCount,
        oracle.eligibleCount,
      ],
      [
        'lifetime.cameraCaptureCount',
        full.lifetime.cameraCaptureCount,
        oracle.cameraCount,
      ],
      [
        'lifetime.importedCaptureCount',
        full.lifetime.importedCaptureCount,
        oracle.importedCount,
      ],
      [
        'excludedCaptureCount',
        first.excludedCaptureCount,
        oracle.excludedCount,
      ],
      [
        'lifetime.activeDayCount',
        full.lifetime.activeDayCount,
        oracle.activeDays.length,
      ],
      ['captureCount(current)', first.captureCount, oracle.currentCount],
      ['activeDays(current)', first.activeDays, oracle.currentDays],
      [
        'trackedDurationMs(current)',
        first.trackedDurationMs,
        oracle.trackedDurationMs,
      ],
      ['longestStreak', first.longestStreak, oracle.longestDays],
      ['currentStreak', first.currentStreak, oracle.currentStreak],
      [
        'streak.practicedToday',
        full.streak.practicedToday,
        oracle.practicedToday,
      ],
      [
        'streak.lastPracticeDay',
        full.streak.lastPracticeDay,
        oracle.lastPracticeDay,
      ],
      ['sourceCaptureCount', full.sourceCaptureCount, rows.length],
      ['buckets.length', first.buckets.length, rangeDays],
      [
        'buckets sum == captureCount',
        first.buckets.reduce((n, b) => n + b.count, 0),
        first.captureCount,
      ],
    ];
    for (const [field, actual, expected] of checks) {
      if (stableJson(actual) !== stableJson(expected)) {
        fail(
          'oracle_history',
          label,
          `${field}: got ${stableJson(actual)} expected ${stableJson(expected)} (asOf=${asOfIso} tz=${timeZone} range=${range})`,
        );
      }
    }
    for (let i = 1; i < first.buckets.length; i += 1) {
      if (
        ordinalOf(first.buckets[i]!.key) !==
        ordinalOf(first.buckets[i - 1]!.key) + 1
      ) {
        fail('oracle_history', label, `buckets not consecutive at ${i}`);
        break;
      }
    }
    if (first.currentStreak > first.longestStreak) {
      fail('oracle_history', label, 'currentStreak > longestStreak');
    }
    // Clock skew probe: the same rows read at a shifted asOf.
    const probeIso = new Date(fakeNow() + plan.skewProbeMs!).toISOString();
    const probe = aggregatePracticeHistory(rows, {
      asOfIso: probeIso,
      timeZone,
      rangeDays,
    });
    const later = plan.skewProbeMs! >= 0 ? probe : full;
    const earlier = plan.skewProbeMs! >= 0 ? full : probe;
    if (
      later.lifetime.eligibleCaptureCount <
      earlier.lifetime.eligibleCaptureCount
    ) {
      fail(
        'skew_monotone',
        label,
        `lifetime evidence shrank moving asOf forward (${earlier.lifetime.eligibleCaptureCount} → ${later.lifetime.eligibleCaptureCount}, skew=${plan.skewProbeMs}ms)`,
      );
    }
    if (stableJson(rows) !== before) {
      fail('pure_no_mutation', label, 'input rows were mutated by the probe');
    }
  };

  const runPracticeSetOp = (state: OpState): void => {
    const plan = state.plan;
    const label = `op${plan.index}:practiceSet`;
    const rows = [...factStore.values()];
    const before = stableJson(rows);
    const asOfIso = new Date(fakeNow()).toISOString();
    const maxAgeMs = plan.maxAgeMs!;
    let latest: PracticeSetSummary | null;
    try {
      latest = latestPracticeSet(rows, { asOfIso, maxAgeMs });
    } catch (error) {
      fail('typed_error', label, `latestPracticeSet threw: ${String(error)}`);
      return;
    }
    const again = latestPracticeSet(rows, { asOfIso, maxAgeMs });
    if (stableJson(latest) !== stableJson(again)) {
      fail('pure_idempotent', label, 'two latestPracticeSet calls differ');
    }
    const shuffled = latestPracticeSet(rng.shuffle(rows), {
      asOfIso,
      maxAgeMs,
    });
    if (stableJson(latest) !== stableJson(shuffled)) {
      fail(
        'pure_order_independent',
        label,
        'shuffled rows change latestPracticeSet',
      );
    }
    const expectedSession = oracleLatestSession(rows, asOfIso, maxAgeMs);
    if ((latest?.sessionId ?? null) !== expectedSession) {
      fail(
        'oracle_practice_set',
        label,
        `latestPracticeSet chose ${latest?.sessionId ?? null}, oracle ${expectedSession} (asOf=${asOfIso} maxAge=${maxAgeMs})`,
      );
    }
    for (const sessionId of SESSION_POOL) {
      const summary = summarizePracticeSet(rows, sessionId);
      const oracle = oracleSummarize(rows, sessionId);
      const summaryShuffled = summarizePracticeSet(
        rng.shuffle(rows),
        sessionId,
      );
      if (stableJson(summary) !== stableJson(summaryShuffled)) {
        fail(
          'pure_order_independent',
          label,
          `summarize(${sessionId}) order-dependent`,
        );
      }
      if ((summary === null) !== (oracle === null)) {
        fail(
          'oracle_practice_set',
          label,
          `summarize(${sessionId}) null-ness ${summary === null} vs oracle ${oracle === null}`,
        );
        continue;
      }
      if (!summary || !oracle) continue;
      const checks: Array<[string, unknown, unknown]> = [
        ['attempt ids', summary.attempts.map(a => a.id), oracle.attemptIds],
        ['deltaTenths', summary.deltaTenths, oracle.deltaTenths],
        ['trend', summary.trend, oracle.trend],
        ['excludedCount', summary.excludedCount, oracle.excludedCount],
        ['best.id', summary.best.id, oracle.bestId],
        ['shotType', summary.shotType, oracle.shotType],
        ['first.id', summary.first.id, oracle.attemptIds[0]],
        [
          'latest.id',
          summary.latest.id,
          oracle.attemptIds[oracle.attemptIds.length - 1],
        ],
        ['startedAt', summary.startedAt, summary.first.capturedAt],
        ['endedAt', summary.endedAt, summary.latest.capturedAt],
      ];
      for (const [field, actual, expected] of checks) {
        if (stableJson(actual) !== stableJson(expected)) {
          fail(
            'oracle_practice_set',
            label,
            `summarize(${sessionId}).${field}: got ${stableJson(actual)} expected ${stableJson(expected)}`,
          );
        }
      }
      if (!Number.isInteger(summary.deltaTenths)) {
        fail(
          'oracle_practice_set',
          label,
          `deltaTenths not an integer: ${summary.deltaTenths}`,
        );
      }
      const ids = new Set(summary.attempts.map(a => a.id));
      if (ids.size !== summary.attempts.length) {
        fail(
          'no_duplicate_rows',
          label,
          `summarize(${sessionId}) repeats an attempt id`,
        );
      }
    }
    if (stableJson(rows) !== before) {
      fail('pure_no_mutation', label, 'input rows were mutated');
    }
  };

  /** Launches an op and returns the harness-tracked settlement (never
   * rejects). Abandoning callers simply do not await it. */
  const launch = (state: OpState): Promise<void> => {
    if (state.launched) return Promise.resolve();
    state.launched = true;
    state.launchedAtFakeMs = fakeElapsed;
    const plan = state.plan;

    const finish = (): void => {
      state.settled = true;
      state.settledAtFakeMs = fakeElapsed;
      for (const child of children.get(plan.index) ?? []) launch(child);
    };

    let promise: Promise<unknown>;
    if (plan.kind === 'fetch') {
      // Callers (ProgressScreen / HomeScreen) read the store at call time and
      // skip the request when signed out.
      const session = getApiSession();
      if (!session) {
        state.outcome = 'skipped_signed_out';
        promise = Promise.resolve(null);
      } else {
        state.sessionAtCall = session;
        state.sessionSnapshot = stableJson(session);
        const fetchFn = makeFetch(plan.index, plan.fetch!, state.fetchRecords);
        promise = fetchCanonicalProgress(session, fetchFn);
      }
    } else {
      // Pure ops still cross an await so they interleave with writers.
      promise = Promise.resolve().then(() => {
        if (plan.kind === 'history') runHistoryOp(state);
        else runPracticeSetOp(state);
        return null;
      });
    }

    return promise.then(
      value => {
        if (state.outcome === null) state.outcome = 'resolved';
        state.value = value;
        finish();
      },
      error => {
        state.outcome = 'rejected';
        state.error = error;
        finish();
      },
    );
  };

  // Timer-launched ops and scheduled events.
  for (const state of states) {
    if (state.plan.launch.mode === 'timer') {
      setTimeout(() => launch(state), state.plan.launch.atMs);
    }
  }
  for (const event of scenario.events) {
    setTimeout(() => applyEvent(event), event.at);
  }

  // Synchronous burst with interleaved writes.
  const burstStates = states.filter(s => s.plan.launch.mode === 'burst');
  const burstWritesBySlot = new Map<number, SessionEvent[]>();
  for (const { slot, event } of scenario.burstWrites) {
    const list = burstWritesBySlot.get(slot) ?? [];
    list.push(event);
    burstWritesBySlot.set(slot, list);
  }
  // Cancel-during-call: abandoning callers drop their handle (they are not
  // part of the Promise.all); the harness still observes their settlement.
  const awaited: Array<Promise<void>> = [];
  burstStates.forEach((state, slot) => {
    for (const event of burstWritesBySlot.get(slot) ?? []) applyEvent(event);
    const tracked = launch(state);
    if (!state.plan.abandon) awaited.push(tracked);
  });
  for (const event of burstWritesBySlot.get(burstStates.length) ?? []) {
    applyEvent(event);
  }
  let burstSettled = false;
  void Promise.all(awaited).then(() => {
    burstSettled = true;
  });

  // Drive fake time until every launched op settled or the budget is spent.
  let steps = 0;
  const allDone = (): boolean =>
    states.every(s => !s.launched || s.settled) &&
    states.every(s => s.launched || s.plan.launch.mode === 'chained') &&
    executedEvents >= scenario.events.length + scenario.burstWrites.length;
  await Promise.resolve();
  while (!allDone() && steps < MAX_TIMER_STEPS) {
    await jest.advanceTimersByTimeAsync(FAKE_STEP_MS);
    fakeElapsed += FAKE_STEP_MS;
    steps += 1;
    // Nothing scheduled and nothing settling: the remaining ops are stalled
    // for good, and more fake time cannot change that.
    if (jest.getTimerCount() === 0 && !allDone()) {
      await jest.advanceTimersByTimeAsync(0);
      if (jest.getTimerCount() === 0) break;
    }
  }
  await jest.advanceTimersByTimeAsync(0);
  const stalledOps = states.filter(s => s.launched && !s.settled).length;
  if (stalledOps === 0 && awaited.length > 0 && !burstSettled) {
    fail('bounded', 'iteration', 'Promise.all burst never settled');
  }

  // ─── Judge ────────────────────────────────────────────────────────────────
  let notLaunched = 0;
  let settledCount = 0;
  let launchedCount = 0;
  const bodyClasses: Record<string, number> = {};
  let pastDeadlineFetches = 0;
  let lostFetches = 0;
  let signedOutSkips = 0;
  for (const state of states) {
    const plan = state.plan;
    const label = `op${plan.index}:${plan.kind}`;
    if (!state.launched) {
      notLaunched += 1;
      continue;
    }
    launchedCount += 1;
    if (state.settled) settledCount += 1;

    if (plan.kind !== 'fetch') {
      if (!state.settled) fail('bounded', label, 'pure op never settled');
      else if (state.outcome === 'rejected') {
        fail('typed_error', label, `pure op rejected: ${String(state.error)}`);
      }
      continue;
    }

    const fetchPlan = plan.fetch!;
    bodyClasses[fetchPlan.body] = (bodyClasses[fetchPlan.body] ?? 0) + 1;
    if (fetchPlan.headerLatencyMs > PROGRESS_REQUEST_TIMEOUT_MS) {
      pastDeadlineFetches += 1;
    }
    if (fetchPlan.lost) lostFetches += 1;
    if (state.outcome === 'skipped_signed_out') {
      signedOutSkips += 1;
      if (state.fetchRecords.length !== 0) {
        fail('one_fetch', label, 'fetched while signed out');
      }
      continue;
    }
    const session = state.sessionAtCall!;
    if (stableJson(session) !== state.sessionSnapshot) {
      fail(
        'store_untouched',
        label,
        'session object handed to api.ts was mutated',
      );
    }
    if (state.fetchRecords.length !== 1) {
      fail(
        'one_fetch',
        label,
        `fetch called ${state.fetchRecords.length} times`,
      );
      continue;
    }
    const record = state.fetchRecords[0]!;
    const headers = (record.init?.headers ?? {}) as Record<string, string>;
    if (record.url !== `${API_BASE}/v1/progress`) {
      fail('header_at_call', label, `url ${record.url}`);
    }
    if (record.init?.method !== 'GET') {
      fail('header_at_call', label, `method ${String(record.init?.method)}`);
    }
    if (headers['Authorization'] !== `Bearer ${session.bearerToken}`) {
      fail(
        'header_at_call',
        label,
        `Authorization ${headers['Authorization']} ≠ Bearer ${session.bearerToken}`,
      );
    }
    if (headers['X-Client-Version'] !== getRuntimePublicConfig().appVersion) {
      fail(
        'header_at_call',
        label,
        `X-Client-Version ${headers['X-Client-Version']}`,
      );
    }
    if (headers['Accept'] !== 'application/json') {
      fail('header_at_call', label, `Accept ${headers['Accept']}`);
    }
    if (!record.signal) {
      fail('deadline', label, 'no abort signal handed to fetch');
      continue;
    }

    const pastDeadline =
      fetchPlan.headerLatencyMs > PROGRESS_REQUEST_TIMEOUT_MS;
    if (!state.settled) {
      if (!pastDeadline && !fetchPlan.lost && fetchPlan.body === 'body_never') {
        fail(
          'unbounded_body_read',
          label,
          `headers at ${fetchPlan.headerLatencyMs}ms then a body that never arrives: fetchCanonicalProgress still pending after ${fakeElapsed}ms fake time (deadline timer already cleared)`,
        );
      } else {
        fail('bounded', label, `never settled (plan ${stableJson(fetchPlan)})`);
      }
      continue;
    }
    if (pastDeadline) {
      if (
        state.outcome !== 'rejected' ||
        !(state.error instanceof ProgressApiError)
      ) {
        fail(
          'deadline',
          label,
          `past-deadline request did not reject with ProgressApiError (${state.outcome})`,
        );
      }
      if (!record.signal.aborted) {
        fail('deadline', label, 'past-deadline request was not aborted');
      }
      const settledAt = state.settledAtFakeMs! - state.launchedAtFakeMs!;
      if (settledAt > PROGRESS_REQUEST_TIMEOUT_MS + FAKE_STEP_MS) {
        fail(
          'deadline',
          label,
          `settled ${settledAt}ms after launch (> timeout)`,
        );
      }
      continue;
    }
    if (record.signal.aborted) {
      fail(
        'deadline',
        label,
        `aborted although headers arrived at ${fetchPlan.headerLatencyMs}ms`,
      );
    }
    if (fetchPlan.lost) {
      if (
        state.outcome !== 'rejected' ||
        !(state.error instanceof ProgressApiError)
      ) {
        fail(
          'typed_error',
          label,
          `lost request outcome ${state.outcome}: ${String(state.error)}`,
        );
      }
      continue;
    }
    switch (fetchPlan.body) {
      case 'ok':
      case 'ok_empty': {
        if (state.outcome !== 'resolved') {
          fail(
            'isolation',
            label,
            `valid body rejected: ${String(state.error)}`,
          );
          break;
        }
        const expected =
          fetchPlan.body === 'ok'
            ? expectedProgress(plan.index)
            : EMPTY_PROGRESS;
        if (stableJson(state.value) !== stableJson(expected)) {
          fail(
            'isolation',
            label,
            `resolved with another op's body: ${stableJson(state.value)}`,
          );
        }
        break;
      }
      case 'body_never':
        fail('bounded', label, 'body_never settled?!');
        break;
      default:
        if (state.outcome !== 'rejected') {
          fail(
            'typed_error',
            label,
            `${fetchPlan.body} resolved: ${stableJson(state.value)}`,
          );
        } else if (!(state.error instanceof ProgressApiError)) {
          fail(
            'typed_error',
            label,
            `${fetchPlan.body} rejected with ${String(state.error)}`,
          );
        }
    }
  }

  if (observedStoreWrites !== expectedStoreWrites) {
    fail(
      'store_untouched',
      'iteration',
      `apiSession store written ${observedStoreWrites} times, events account for ${expectedStoreWrites}`,
    );
  }
  const liveTimers = jest.getTimerCount();
  if (liveTimers !== 0) {
    fail(
      'no_timer_leak',
      'iteration',
      `${liveTimers} live timers after settlement`,
    );
  }
  if (unhandled.length > 0) {
    fail(
      'typed_error',
      'iteration',
      `${unhandled.length} unhandled rejections`,
    );
  }
  const realMs = REAL_NOW() - realStart;
  const allEvents = [
    ...scenario.events,
    ...scenario.burstWrites.map(w => w.event),
  ];

  unsubscribe();
  clearApiSession();
  process.off('unhandledRejection', onUnhandled);
  jest.useRealTimers();

  return {
    seed,
    failures,
    stats: {
      ops: states.length,
      launched: launchedCount,
      settled: settledCount,
      notLaunched,
      fetchOps: scenario.ops.filter(o => o.kind === 'fetch').length,
      historyOps: scenario.ops.filter(o => o.kind === 'history').length,
      practiceSetOps: scenario.ops.filter(o => o.kind === 'practiceSet').length,
      abandoned: scenario.ops.filter(o => o.abandon).length,
      chained: scenario.ops.filter(o => o.launch.mode === 'chained').length,
      duplicates: scenario.ops.filter(
        (o, i) =>
          o.fetch &&
          i > 0 &&
          scenario.ops[i - 1]!.fetch &&
          stableJson(o.fetch) === stableJson(scenario.ops[i - 1]!.fetch),
      ).length,
      events: scenario.events.length,
      burstWrites: scenario.burstWrites.length,
      timerSteps: steps,
      fakeMs: fakeElapsed,
      realMs,
      finalFactRows: factStore.size,
      finalCaptureRows: captureStore.size,
      bodyClasses,
      pastDeadlineFetches,
      lostFetches,
      signedOutSkips,
      sessionEvents: allEvents.filter(
        e => e.type === 'rotate' || e.type === 'logout' || e.type === 'login',
      ).length,
      skewEvents: allEvents.filter(e => e.type === 'skew').length,
      rowWrites: allEvents.filter(
        e => e.type === 'writeFact' || e.type === 'writeCapture',
      ).length,
    },
    replay: `STRESS_ONLY=${seed} npx jest --ci __tests__/stress/progressHistoryConcurrency.stress.test.ts`,
  };
}
