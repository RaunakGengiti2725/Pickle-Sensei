import * as fs from 'fs';
import * as path from 'path';
import {
  CHECKPOINTS,
  FAULT_DIRECTIONS,
  PHASES,
  SHOT_TYPES,
  type CheckpointScore,
  type PhaseSpan,
  type ScoreBand,
  type ShotAnalysis,
} from '@pickle/shared-types';
import {
  REVIEW_JOINTS,
  buildFormReviewScript,
  dominantSide,
  fixList,
  jointHeatAt,
  poseFrameAt,
  strengthList,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseSequence,
  type ReviewStop,
} from '../../src/review/formReviewModel';
import {
  containRect,
  currentStop,
  heatTint,
  nextAutoPause,
} from '../../src/review/formReviewGeometry';
import {
  drillFocusFromAnalysis,
  pickRecommendedDrills,
} from '../../src/review/recommendedDrillsModel';

/**
 * STRESS / concurrency — the pure review selectors (`formReviewModel`,
 * `formReviewGeometry`, `recommendedDrillsModel`).
 *
 * Several actors run seeded selector sequences in one Promise.all burst over
 * the SAME analysis + pose sequence objects while a mutator actor rewrites
 * those objects between event-loop hops (two actors on one row, rotation /
 * re-render mid-flight). Inputs are fuzzed — duplicate and unknown
 * checkpoints, NaN / ±Infinity / out-of-range scores, reversed and unknown
 * phases, sparse landmarks, a null sequence — because the "selectors have no
 * hidden state" claim is only worth something across the whole input space.
 *
 * Per call: the selector is evaluated twice back to back (idempotent), the
 * inputs are deep-compared before/after (no input mutation), and the result
 * is re-derived serially after the burst from a snapshot taken at call time
 * (no cross-actor contamination, no dependence on interleaving). Two player
 * actors sharing one `visited` set walk the same stops (native + JS clock
 * ticks): every stop fires at most once and only on a tick that crosses it.
 *
 *   STRESS_SEED=<seed> STRESS_ITER=1 npx jest --ci __tests__/stress/reviewModelsConcurrency.pureModels
 */

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

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

function int(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

async function hop(rng: () => number): Promise<void> {
  const r = rng();
  if (r < 0.3) return;
  if (r < 0.9) {
    const n = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i += 1) await Promise.resolve();
    return;
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

/** JSON that keeps NaN / ±Infinity / undefined distinguishable. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) return `#${String(v)}`;
    if (v === undefined) return '#undefined';
    if (v instanceof Set) return { '#set': [...v].sort() };
    return v;
  });
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(deepClone) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepClone(v);
    }
    return out as T;
  }
  return value;
}

// ------------------------------------------------------------------ fuzzers

const WEIRD_NUMBERS = [NaN, Infinity, -Infinity, -5, 105, 0, 100, 1e12];
const BANDS: readonly ScoreBand[] = ['green', 'yellow', 'red', 'unscored'];

function fuzzScore(rng: () => number): number | null {
  const r = rng();
  if (r < 0.12) return null;
  if (r < 0.22) return pick(rng, WEIRD_NUMBERS);
  return Math.round(rng() * 100);
}

function fuzzCheckpoint(rng: () => number): CheckpointScore {
  const key = rng() < 0.08 ? 'not_a_checkpoint' : pick(rng, CHECKPOINTS);
  const score = fuzzScore(rng);
  return {
    key,
    score,
    confidence: rng(),
    band: pick(rng, BANDS),
    direction: rng() < 0.05 ? 'sideways' : pick(rng, FAULT_DIRECTIONS),
    severity: rng() < 0.1 ? NaN : rng(),
    applicable: rng() < 0.15 ? false : true,
  } as unknown as CheckpointScore;
}

function fuzzPhase(rng: () => number, cursor: { t: number }): PhaseSpan {
  const key = rng() < 0.08 ? 'warmup' : pick(rng, PHASES);
  const len = int(rng, 0, 900);
  const startMs = rng() < 0.05 ? NaN : cursor.t;
  const endMs = rng() < 0.05 ? cursor.t - len : cursor.t + len;
  cursor.t += len;
  return {
    key,
    startMs,
    endMs,
    representativeMs: rng() < 0.1 ? Infinity : startMs + len * rng(),
    confidence: rng(),
  } as unknown as PhaseSpan;
}

function fuzzAnalysis(rng: () => number): ShotAnalysis {
  const checkpoints: CheckpointScore[] = [];
  for (let i = int(rng, 0, 16); i > 0; i -= 1)
    checkpoints.push(fuzzCheckpoint(rng));
  const cursor = { t: int(rng, 0, 400) };
  const phases: PhaseSpan[] = [];
  for (let i = int(rng, 0, 9); i > 0; i -= 1)
    phases.push(fuzzPhase(rng, cursor));
  const endMs = Math.max(cursor.t, 1);
  const priority =
    rng() < 0.3 || checkpoints.length === 0 ? null : pick(rng, checkpoints).key;
  return {
    id: `a-${Math.floor(rng() * 1e9)}`,
    sessionId: null,
    shotType: pick(rng, SHOT_TYPES),
    cameraView: 'side',
    handedness: pick(rng, ['right', 'left', 'ambidextrous'] as const),
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: {
      startMs: 0,
      contactMs: rng() < 0.1 ? NaN : Math.floor(endMs * rng()),
      endMs,
    },
    phases,
    measurements: [],
    checkpoints,
    overallScore: rng() < 0.2 ? null : Math.round(rng() * 100) / 10,
    analysisConfidence: rng(),
    resultKind: 'scored',
    guidance: null,
    priorityFix:
      priority === null
        ? null
        : {
            checkpoint: priority,
            reasonKey: 'lowest_score',
            severity: rng(),
            confidence: rng(),
          },
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'stress',
      poseModelVersion: 'stress',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'stress',
      phaseModelVersion: 'stress',
      scoringModelVersion: 'stress',
      shotConfigVersion: 'stress@1',
    },
    source: 'real',
  } as ShotAnalysis;
}

function fuzzFrame(rng: () => number, timestampMs: number): ReviewPoseFrame {
  const landmarks = REVIEW_JOINTS.filter(() => rng() < 0.8).map(name => ({
    name,
    x: rng() < 0.05 ? pick(rng, WEIRD_NUMBERS) : rng(),
    y: rng() < 0.05 ? pick(rng, WEIRD_NUMBERS) : rng(),
    visibility: rng(),
  }));
  if (rng() < 0.05) {
    // Unknown joint names arrive from other pose model versions.
    landmarks.push({
      name: 'tail' as ReviewJoint,
      x: 0.5,
      y: 0.5,
      visibility: 1,
    });
  }
  return { timestampMs, confidence: rng(), landmarks };
}

function fuzzSequence(
  rng: () => number,
  endMs: number,
): ReviewPoseSequence | null {
  if (rng() < 0.15) return null;
  const frames: ReviewPoseFrame[] = [];
  let t = 0;
  while (t <= endMs && frames.length < 80) {
    frames.push(fuzzFrame(rng, t));
    t += rng() < 0.15 ? int(rng, 130, 600) : int(rng, 16, 50);
  }
  const video =
    rng() < 0.1
      ? undefined
      : rng() < 0.5
        ? {
            w: int(rng, 0, 1920),
            h: int(rng, 0, 1920),
            fps: pick(rng, [30, 60, NaN]),
          }
        : { width: 1080, height: 1920, fps: 30 };
  return video ? { frames, video } : { frames };
}

const CATALOG = [
  { slug: 'd-forehand-1', families: ['forehand'] },
  { slug: 'd-forehand-2', families: ['forehand', 'global'] },
  { slug: 'd-dink-1', families: ['dink'] },
  { slug: 'd-serve-1', families: ['serve'] },
  { slug: 'd-global-1', families: ['global'] },
  { slug: 'd-global-2', families: ['global'] },
  { slug: 'd-volley-1', families: ['volley', 'net'] },
];

// ---------------------------------------------------------------- selectors

interface Inputs {
  analysis: ShotAnalysis;
  sequence: ReviewPoseSequence | null;
}

type SelectorId =
  | 'script'
  | 'fixList'
  | 'strengthList'
  | 'jointHeatAt'
  | 'currentStop'
  | 'nextAutoPause'
  | 'drillFocus'
  | 'pickDrills'
  | 'containRect'
  | 'heatTint'
  | 'poseFrameAt'
  | 'dominantSide';

const SELECTORS: readonly SelectorId[] = [
  'script',
  'script',
  'fixList',
  'strengthList',
  'jointHeatAt',
  'currentStop',
  'nextAutoPause',
  'drillFocus',
  'pickDrills',
  'containRect',
  'heatTint',
  'poseFrameAt',
  'dominantSide',
];

function evaluate(id: SelectorId, inputs: Inputs, args: number[]): unknown {
  const [a0 = 0, a1 = 0, a2 = 0] = args;
  switch (id) {
    case 'script':
      return buildFormReviewScript(inputs.analysis, inputs.sequence);
    case 'fixList':
      return fixList(inputs.analysis, a0);
    case 'strengthList':
      return strengthList(inputs.analysis, a0);
    case 'jointHeatAt':
      return jointHeatAt(
        buildFormReviewScript(inputs.analysis, inputs.sequence),
        a0,
      );
    case 'currentStop':
      return currentStop(
        buildFormReviewScript(inputs.analysis, inputs.sequence).stops,
        a0,
      );
    case 'nextAutoPause': {
      const stops = buildFormReviewScript(
        inputs.analysis,
        inputs.sequence,
      ).stops;
      const visited = new Set(
        stops.filter((_s, i) => i % 2 === Math.floor(a2) % 2).map(s => s.id),
      );
      return nextAutoPause(stops, a0, a1, visited);
    }
    case 'drillFocus':
      return drillFocusFromAnalysis(inputs.analysis);
    case 'pickDrills': {
      const focus = drillFocusFromAnalysis(inputs.analysis);
      return focus ? pickRecommendedDrills(CATALOG, focus, a0) : null;
    }
    case 'containRect':
      return containRect(
        { width: a0, height: a1 },
        { width: a2, height: a0 || 1 },
      );
    case 'heatTint':
      return heatTint(a0 / 1000);
    case 'poseFrameAt':
      return poseFrameAt(inputs.sequence, a0);
    case 'dominantSide':
      return dominantSide(
        inputs.sequence,
        { startMs: Math.min(a0, a1), endMs: Math.max(a0, a1) },
        inputs.analysis.handedness,
      );
  }
}

/** Structural contract checks that must hold for any input (no duplicates). */
function contractViolations(
  id: SelectorId,
  result: unknown,
  inputs: Inputs,
): string[] {
  const out: string[] = [];
  if (id === 'script') {
    const script = result as ReturnType<typeof buildFormReviewScript>;
    const ids = new Set<string>();
    for (const stop of script.stops) {
      if (ids.has(stop.id)) out.push(`duplicate stop id ${stop.id}`);
      ids.add(stop.id);
      const keys = new Set<string>();
      for (const cp of stop.checkpoints) {
        if (keys.has(cp.key))
          out.push(`duplicate checkpoint ${cp.key} in ${stop.id}`);
        keys.add(cp.key);
        if (!Number.isFinite(cp.score))
          out.push(`non-finite score in ${stop.id}`);
      }
      // atMs is the recorded representative moment, not clamped to the span.
      if (!Number.isFinite(stop.atMs) || !(stop.startMs <= stop.endMs)) {
        out.push(`stop ${stop.id} has a non-finite atMs or reversed span`);
      }
    }
    for (const [joint, heat] of Object.entries(script.jointHeat)) {
      if (!(typeof heat === 'number' && heat >= 0 && heat <= 1))
        out.push(`heat ${joint}=${heat}`);
    }
  }
  if (id === 'fixList' || id === 'strengthList') {
    const items = result as Array<{ key: string; band: string }>;
    const keys = new Set(items.map(i => i.key));
    if (keys.size !== items.length) out.push('duplicate keys in list');
    for (const item of items) {
      if (id === 'fixList' && item.band !== 'red' && item.band !== 'yellow') {
        out.push(`fixList item ${item.key} band ${item.band}`);
      }
      if (id === 'strengthList' && item.band !== 'green') {
        out.push(`strengthList item ${item.key} band ${item.band}`);
      }
    }
  }
  if (id === 'pickDrills' && Array.isArray(result)) {
    const slugs = new Set((result as Array<{ slug: string }>).map(d => d.slug));
    if (slugs.size !== result.length) out.push('duplicate drills recommended');
  }
  if (id === 'poseFrameAt' && result !== null) {
    const frame = result as ReviewPoseFrame;
    if (!inputs.sequence?.frames.includes(frame))
      out.push('poseFrameAt invented a frame');
  }
  return out;
}

// ------------------------------------------------------------------ scenario

interface CallRecord {
  actor: number;
  id: SelectorId;
  args: number[];
  snapshot: Inputs;
  result: string;
}

interface Iteration {
  seed: number;
  actors: number;
  calls: number;
  mutations: number;
  wallMs: number;
  outcome: 'HELD' | 'BROKEN';
  violations: string[];
  stopsSeen: number;
  autoPauses: number;
}

const WALL_BOUND_MS = 4_000;

function mutate(rng: () => number, inputs: Inputs): void {
  const a = inputs.analysis;
  switch (int(rng, 0, 6)) {
    case 0:
      a.checkpoints.reverse();
      break;
    case 1: {
      const cp =
        a.checkpoints[int(rng, 0, Math.max(0, a.checkpoints.length - 1))];
      if (cp) (cp as { score: number | null }).score = fuzzScore(rng);
      break;
    }
    case 2: {
      const cp =
        a.checkpoints[int(rng, 0, Math.max(0, a.checkpoints.length - 1))];
      if (cp) (cp as { applicable: boolean }).applicable = !cp.applicable;
      break;
    }
    case 3:
      (a as { handedness: ShotAnalysis['handedness'] }).handedness =
        a.handedness === 'left' ? 'right' : 'left';
      break;
    case 4:
      a.checkpoints.push(fuzzCheckpoint(rng));
      break;
    case 5:
      if (inputs.sequence && inputs.sequence.frames.length > 0) {
        (inputs.sequence as { frames: ReviewPoseFrame[] }).frames.splice(
          int(rng, 0, inputs.sequence.frames.length - 1),
          1,
        );
      }
      break;
    default:
      (a as { priorityFix: ShotAnalysis['priorityFix'] }).priorityFix = null;
  }
}

async function runIteration(seed: number): Promise<Iteration> {
  const rng = mulberry32(seed);
  const violations: string[] = [];
  const shared: Inputs = { analysis: fuzzAnalysis(rng), sequence: null };
  shared.sequence = fuzzSequence(rng, shared.analysis.timestamps.endMs);
  const endMs = shared.analysis.timestamps.endMs;

  const actorCount = int(rng, 2, 6);
  const records: CallRecord[] = [];
  let mutations = 0;
  let stopsSeen = 0;
  let autoPauses = 0;

  const started = Date.now();

  const selectorActor = async (actor: number, actorRng: () => number) => {
    const steps = int(actorRng, 2, 8);
    for (let s = 0; s < steps; s += 1) {
      await hop(actorRng);
      const id = pick(actorRng, SELECTORS);
      const args = [
        int(actorRng, -100, endMs + 200),
        int(actorRng, -100, endMs + 200),
        int(actorRng, 0, 6),
      ];
      const snapshot = deepClone(shared);
      const before = stable(shared);
      const first = evaluate(id, shared, args);
      const second = evaluate(id, shared, args);
      const after = stable(shared);
      const result = stable(first);
      if (result !== stable(second)) {
        violations.push(`actor ${actor} step ${s}: ${id} not idempotent`);
      }
      if (before !== after) {
        violations.push(`actor ${actor} step ${s}: ${id} mutated its input`);
      }
      for (const v of contractViolations(id, first, shared)) {
        violations.push(`actor ${actor} step ${s}: ${id} ${v}`);
      }
      records.push({ actor, id, args, snapshot, result });
    }
  };

  const mutatorActor = async (actorRng: () => number) => {
    const steps = int(actorRng, 1, 6);
    for (let s = 0; s < steps; s += 1) {
      await hop(actorRng);
      mutate(actorRng, shared);
      mutations += 1;
    }
  };

  // Two player clocks over ONE visited set (native progress + JS fallback).
  const visited = new Set<string>();
  const fired: string[] = [];
  const playerActor = async (
    actorRng: () => number,
    stops: readonly ReviewStop[],
  ) => {
    let prev = -1;
    while (prev < endMs) {
      await hop(actorRng);
      const now = Math.min(endMs, prev + int(actorRng, 1, 400));
      const stop = nextAutoPause(stops, prev, now, visited);
      if (stop) {
        if (visited.has(stop.id))
          violations.push(`player fired visited stop ${stop.id}`);
        if (!(stop.atMs > prev && stop.atMs <= now)) {
          violations.push(`player fired ${stop.id} outside (${prev}, ${now}]`);
        }
        visited.add(stop.id);
        fired.push(stop.id);
        autoPauses += 1;
        // Pause lands the playhead on the stop; the next tick resumes there.
        prev = stop.atMs;
      } else {
        prev = now;
      }
    }
  };

  const frozen: Inputs = deepClone(shared);
  const playerStops = buildFormReviewScript(
    frozen.analysis,
    frozen.sequence,
  ).stops;
  stopsSeen = playerStops.length;

  const tasks: Promise<void>[] = [];
  for (let a = 0; a < actorCount; a += 1) {
    tasks.push(selectorActor(a, mulberry32(seed ^ (0x1000 * (a + 1)))));
  }
  tasks.push(mutatorActor(mulberry32(seed ^ 0x9e3779b9)));
  tasks.push(playerActor(mulberry32(seed ^ 0x51ed270b), playerStops));
  tasks.push(playerActor(mulberry32(seed ^ 0x2545f491), playerStops));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), WALL_BOUND_MS);
  });
  const settled = await Promise.race([Promise.all(tasks), timeout]);
  clearTimeout(timer);
  const wallMs = Date.now() - started;
  if (settled === 'timeout') {
    violations.push(`deadlock: burst did not settle within ${WALL_BOUND_MS}ms`);
    await Promise.all(tasks);
  }

  // Every stop fires at most once across both player clocks.
  if (new Set(fired).size !== fired.length)
    violations.push('a stop auto-paused twice');

  // Serial oracle: replay each call from its snapshot, in isolation.
  for (const record of records) {
    const replay = stable(evaluate(record.id, record.snapshot, record.args));
    if (replay !== record.result) {
      violations.push(
        `actor ${record.actor}: ${record.id}(${record.args.join(',')}) differs from serial replay`,
      );
    }
  }

  return {
    seed,
    actors: actorCount,
    calls: records.length,
    mutations,
    wallMs,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    stopsSeen,
    autoPauses,
  };
}

// ------------------------------------------------------------------ campaign

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 24) || 24);
const SEED0 = Number(process.env.STRESS_SEED ?? 1) || 1;
const OUT_DIR = process.env.STRESS_OUT_DIR;

describe('pure review selectors under seeded concurrent bursts', () => {
  it(
    `stay idempotent, input-preserving and interleaving-independent over ${ITER} bursts from seed ${SEED0}`,
    async () => {
      const table: Iteration[] = [];
      for (let i = 0; i < ITER; i += 1) {
        table.push(await runIteration(SEED0 + i));
      }
      if (OUT_DIR) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(
            OUT_DIR,
            `pureModels.concurrency.seed${SEED0}.n${ITER}.json`,
          ),
          JSON.stringify(
            {
              suite: 'reviewModelsConcurrency.pureModels',
              seed0: SEED0,
              iterations: table.length,
              selectorCalls: table.reduce((n, it) => n + it.calls, 0),
              mutations: table.reduce((n, it) => n + it.mutations, 0),
              autoPauses: table.reduce((n, it) => n + it.autoPauses, 0),
              broken: table
                .filter(it => it.outcome === 'BROKEN')
                .map(it => it.seed),
              table,
            },
            null,
            2,
          ),
        );
      }
      const broken = table.filter(it => it.outcome === 'BROKEN');
      expect(
        broken.map(it => ({ seed: it.seed, violations: it.violations })),
      ).toEqual([]);
      expect(table).toHaveLength(ITER);
      expect(table.some(it => it.stopsSeen > 0 && it.autoPauses > 0)).toBe(
        true,
      );
      for (const it of table) expect(it.wallMs).toBeLessThan(WALL_BOUND_MS);
    },
    Math.max(30_000, ITER * WALL_BOUND_MS),
  );
});
