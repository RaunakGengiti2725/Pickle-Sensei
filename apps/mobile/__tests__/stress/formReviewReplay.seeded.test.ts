import {
  CHECKPOINTS,
  FAULT_DIRECTIONS,
  PHASES,
  SHOT_TYPES,
  type CheckpointKey,
  type CheckpointScore,
  type FaultDirection,
  type PhaseKey,
  type PhaseSpan,
  type ScoreBand,
  type ShotAnalysis,
} from '@pickle/shared-types';
import { generateSwingSequence } from '@pickle/evaluation';
import {
  CHECKPOINT_PHASE,
  POSE_FRAME_TOLERANCE_MS,
  REVIEW_JOINTS,
  buildFormReviewScript,
  checkpointJoints,
  dominantSide,
  facingSign,
  fixList,
  jointHeatAt,
  poseFrameAt,
  reviewVideoSize,
  strengthList,
  type FormReviewScript,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseSequence,
  type ReviewStop,
  type ReviewStopCheckpoint,
} from '../../src/review/formReviewModel';
import {
  REVIEW_SPEEDS,
  TORSO_UNIT_FALLBACK,
  arrowVector,
  containRect,
  currentStop,
  faultTint,
  heatRampColor,
  heatTint,
  nextAutoPause,
  speedLabel,
  stagePoint,
  torsoUnit,
  type Point,
} from '../../src/review/formReviewGeometry';
import { SHOT_FAMILY } from '../../src/library/libraryFocus';
import {
  drillFocusFromAnalysis,
  pickRecommendedDrills,
} from '../../src/review/recommendedDrillsModel';
import {
  Rng,
  drawLength,
  forbiddenCopyIn,
  invariant,
  runCampaign,
  stableJson,
  type SequenceRun,
  type StepTrace,
} from '../../test-support/stress/reviewSeeded';

/**
 * SEEDED RANDOMIZED LONG-RUN — review/formReviewModel + formReviewGeometry +
 * recommendedDrillsModel.
 *
 * One sequence = one seeded (legal or near-legal) ShotAnalysis + recorded pose
 * sequence, then 5..60 replay actions the FormReviewPlayer can perform on the
 * script it builds: progress ticks (auto-pause crossing), seeks/jumps,
 * restart/finish, speed changes, list reads and drill picks. After EVERY step
 * the invariants documented in the modules' honesty contracts are checked
 * against independent reference computations built from the raw analysis.
 *
 * Replay any seed: STRESS_SEED=<seed> STRESS_ITER=1 npx jest --ci <this file>.
 *
 * STRESS_STRICT=1 additionally holds a stop's headline/cue/arrow to its
 * band-faults even when a fixture carries band/score-INCONSISTENT checkpoints
 * (band ≠ bandFor(score), or a score outside 0..100 — records the scoring
 * engine never emits). The model ranks by score and highlights by band, so
 * such records make the arrow point at a joint the stop does not warm
 * (e.g. STRESS_STRICT=1 STRESS_SEED=24470 STRESS_ITER=1). By default those
 * stops are tallied (`bandInconsistentStops`) and the rest of the contract
 * is still checked.
 */

jest.setTimeout(20 * 60 * 1000);

const STRICT = process.env.STRESS_STRICT === '1';

const BANDS: readonly ScoreBand[] = ['green', 'yellow', 'red', 'unscored'];
const FAMILIES = [
  'dink',
  'volley',
  'drive',
  'serve',
  'return',
  'drop_reset',
  'global',
];

type Loose = Record<string, unknown>;

function bandFor(score: number): ScoreBand {
  if (score >= 80) return 'green';
  if (score >= 65) return 'yellow';
  return 'red';
}

function isFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// ─── Generators ─────────────────────────────────────────────────────────────

interface Fixture {
  analysis: ShotAnalysis;
  sequence: ReviewPoseSequence | null;
  durationMs: number;
  /** Whether every part of the fixture is legal engine output. */
  legal: boolean;
}

interface Flags {
  /** Whether near-legal perturbations may be applied to this fixture. */
  hostile: boolean;
  /** False once any perturbation was applied. */
  legal: boolean;
}

function genCheckpoint(
  rng: Rng,
  key: CheckpointKey,
  flags: Flags,
): CheckpointScore {
  let score: number | null = rng.chance(0.12)
    ? null
    : rng.chance(0.5)
      ? rng.int(0, 100)
      : Math.round(rng.float(0, 100) * 1000) / 1000;
  let band: ScoreBand = score === null ? 'unscored' : bandFor(score);
  let direction: FaultDirection =
    band === 'green' || band === 'unscored'
      ? 'none'
      : rng.pick(FAULT_DIRECTIONS);
  let applicable = score !== null || rng.chance(0.5);
  const cp: Loose = {};
  const twist = flags.hostile ? rng.int(0, 3) : -1;
  if (twist === 0 && rng.chance(0.3)) {
    // Near-legal: inconsistent band/score pairs, stray directions.
    flags.legal = false;
    band = rng.pick(BANDS);
    direction = rng.pick(FAULT_DIRECTIONS);
  }
  if (twist === 1 && rng.chance(0.3)) {
    flags.legal = false;
    score = rng.pick([Number.NaN, Number.POSITIVE_INFINITY, -5, 120]);
  }
  if (twist === 2 && rng.chance(0.3)) {
    flags.legal = false;
    applicable = false;
  }
  if (twist === 3 && rng.chance(0.3)) {
    flags.legal = false;
    cp.severity = rng.pick([Number.NaN, -1, 7, 'x']);
  } else {
    cp.severity = score === null ? 0 : (100 - score) / 100;
  }
  return {
    key,
    score,
    confidence: rng.float(0.3, 1),
    band,
    direction,
    applicable,
    ...cp,
  } as CheckpointScore;
}

function genFixture(seed: number): Fixture {
  const rng = new Rng(seed ^ 0x9e3779b9);
  const flags: Flags = { hostile: rng.chance(0.5), legal: true };
  const hostile = (probability: number) =>
    flags.hostile && rng.chance(probability);
  const handed = rng.pick(['right', 'left'] as const);
  const fps = rng.pick([24, 30, 60]);
  const durations = {
    readyMs: rng.int(150, 600),
    backswingMs: rng.int(150, 600),
    accelerateMs: rng.int(100, 400),
    followMs: rng.int(100, 500),
    recoverMs: rng.int(150, 700),
  };
  const generated = generateSwingSequence({ handed, fps, ...durations });
  const durationMs = generated.window.endMs;
  const contactMs = generated.window.peakMs;

  // Pose sequence: recorded frames with realistic dropout / low visibility,
  // or none at all (clip without a sidecar).
  let sequence: ReviewPoseSequence | null = null;
  if (!rng.chance(0.15)) {
    const dropout = rng.chance(0.4) ? rng.float(0, 0.5) : 0;
    const dimVisibility = rng.chance(0.3) ? rng.float(0, 0.4) : 0;
    const frames: ReviewPoseFrame[] = [];
    for (const frame of generated.sequence.frames) {
      if (dropout > 0 && rng.chance(dropout)) continue;
      frames.push({
        timestampMs: frame.timestampMs,
        confidence: frame.confidence,
        landmarks: frame.landmarks.map(mark => ({
          name: mark.name,
          x: mark.x,
          y: mark.y,
          visibility:
            dimVisibility > 0 && rng.chance(dimVisibility)
              ? rng.float(0, 0.29)
              : mark.visibility,
        })),
      });
    }
    sequence = rng.chance(0.5)
      ? { frames, video: generated.sequence.video }
      : rng.chance(0.5)
        ? { frames, video: { w: 1080, h: 1920, fps } }
        : { frames };
  }

  // Phases from the synthetic truth (contiguous, contact = wrist-speed peak).
  const bounds: Array<[PhaseKey, number, number]> = [];
  let cursor = 0;
  const phaseLengths: Array<[PhaseKey, number]> = [
    ['ready', durations.readyMs],
    ['prepare', durations.backswingMs],
    ['accelerate', durations.accelerateMs],
    ['contact', 0],
    ['follow_through', durations.followMs],
    ['recover', durations.recoverMs],
  ];
  for (const [key, length] of phaseLengths) {
    if (key === 'contact') {
      const half = rng.int(0, 60);
      bounds.push(['contact', contactMs - half, contactMs + half]);
      continue;
    }
    bounds.push([key, cursor, cursor + length]);
    cursor += length;
  }
  let phases: PhaseSpan[] = [];
  if (!rng.chance(0.1)) {
    for (const [key, startMs, endMs] of bounds) {
      if (!rng.chance(0.85)) continue;
      const representativeMs =
        key === 'contact'
          ? contactMs
          : startMs + (endMs - startMs) * rng.float(0.2, 0.8);
      phases.push({
        key,
        startMs,
        endMs,
        representativeMs: Math.round(representativeMs),
        confidence: rng.float(0.4, 1),
      });
    }
  }
  if (hostile(0.3) && phases.length > 0) {
    flags.legal = false;
    const victim = rng.pick(phases);
    const mode = rng.int(0, 4);
    if (mode === 0)
      phases.push({ ...victim }); // duplicate phase
    else if (mode === 1)
      phases.push({ ...victim, key: 'warmup' as PhaseKey }); // unknown key
    else if (mode === 2)
      phases = phases.map(phase =>
        phase === victim ? { ...phase, startMs: Number.NaN } : phase,
      );
    else if (mode === 3)
      phases = phases.map(phase =>
        phase === victim
          ? { ...phase, representativeMs: Number.POSITIVE_INFINITY }
          : phase,
      );
    else
      phases = phases.map(phase =>
        phase === victim
          ? { ...phase, endMs: phase.startMs - rng.int(1, 300) }
          : phase,
      );
  }
  if (hostile(0.15) && phases.length >= 2) {
    // Near-legal: two phases share a checkpoint moment.
    flags.legal = false;
    const [a, b] = rng.shuffle(phases);
    if (a && b) b.representativeMs = a.representativeMs;
  }

  let checkpoints: CheckpointScore[] = [];
  for (const key of CHECKPOINTS) {
    if (rng.chance(0.8)) checkpoints.push(genCheckpoint(rng, key, flags));
  }
  if (hostile(0.25) && checkpoints.length > 0) {
    flags.legal = false;
    const dup = rng.pick(checkpoints);
    checkpoints.push({ ...dup, score: rng.int(0, 100) });
  }
  if (hostile(0.15)) {
    flags.legal = false;
    checkpoints.push({
      ...genCheckpoint(rng, 'recovery', flags),
      key: 'footwork_rhythm' as CheckpointKey,
    });
  }
  checkpoints = rng.shuffle(checkpoints);

  const handedness = rng.chance(0.7)
    ? handed
    : rng.pick(['right', 'left', 'ambidextrous'] as const);

  let timestamps: ShotAnalysis['timestamps'] = {
    startMs: 0,
    contactMs,
    endMs: durationMs,
  };
  if (hostile(0.2)) {
    flags.legal = false;
    timestamps = rng.pick([
      { startMs: 0, contactMs: Number.NaN, endMs: durationMs },
      { startMs: durationMs, contactMs, endMs: 0 },
      undefined as unknown as ShotAnalysis['timestamps'],
      {
        startMs: 0,
        contactMs: undefined,
        endMs: undefined,
      } as unknown as ShotAnalysis['timestamps'],
    ]);
  }

  const unknownShot = hostile(0.12);
  if (unknownShot) flags.legal = false;
  const shotType = unknownShot
    ? ('lob' as ShotAnalysis['shotType'])
    : rng.pick(SHOT_TYPES);

  const priorityFix = rng.chance(0.35)
    ? null
    : {
        checkpoint: rng.chance(0.85)
          ? (rng.pick(CHECKPOINTS) as CheckpointKey)
          : ('footwork_rhythm' as CheckpointKey),
        reasonKey: 'lowest_score',
        severity: rng.float(0, 1),
        confidence: rng.float(0, 1),
      };

  const analysis = {
    id: `analysis-${seed}`,
    sessionId: null,
    shotType,
    cameraView: 'side',
    handedness,
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps,
    phases,
    measurements: [],
    checkpoints,
    overallScore: rng.chance(0.9) ? Math.round(rng.float(0, 100)) / 10 : null,
    analysisConfidence: rng.float(0, 1),
    resultKind: 'scored',
    guidance: null,
    priorityFix,
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
  } as unknown as ShotAnalysis;

  return { analysis, sequence, durationMs, legal: flags.legal };
}

// ─── Reference model (independent of the module under test) ─────────────────

interface RefCheckpoint {
  key: CheckpointKey;
  score: number;
  band: ScoreBand;
  direction: FaultDirection;
}

interface RefPhase {
  key: PhaseKey;
  startMs: number;
  endMs: number;
  atMs: number;
}

function refParticipating(analysis: ShotAnalysis): RefCheckpoint[] {
  const seen = new Set<string>();
  const out: RefCheckpoint[] = [];
  const raw: unknown[] = Array.isArray(analysis.checkpoints)
    ? analysis.checkpoints
    : [];
  for (const entry of raw) {
    const cp = entry as Partial<CheckpointScore> | null;
    if (!cp || typeof cp.key !== 'string') continue;
    if (!(CHECKPOINTS as readonly string[]).includes(cp.key)) continue;
    if (seen.has(cp.key)) continue;
    if (cp.applicable === false || !isFinite(cp.score)) continue;
    seen.add(cp.key);
    out.push({
      key: cp.key as CheckpointKey,
      score: cp.score,
      band: cp.band as ScoreBand,
      direction: cp.direction as FaultDirection,
    });
  }
  return out.sort(
    (a, b) => CHECKPOINTS.indexOf(a.key) - CHECKPOINTS.indexOf(b.key),
  );
}

function refPhases(analysis: ShotAnalysis): RefPhase[] {
  const seen = new Set<string>();
  const out: RefPhase[] = [];
  const raw: unknown[] = Array.isArray(analysis.phases) ? analysis.phases : [];
  for (const entry of raw) {
    const phase = entry as Partial<PhaseSpan> | null;
    if (!phase || typeof phase.key !== 'string') continue;
    if (!(PHASES as readonly string[]).includes(phase.key)) continue;
    if (seen.has(phase.key)) continue;
    if (!isFinite(phase.startMs) || !isFinite(phase.endMs)) continue;
    seen.add(phase.key);
    const startMs = phase.startMs;
    const endMs = Math.max(startMs, phase.endMs);
    out.push({
      key: phase.key as PhaseKey,
      startMs,
      endMs,
      atMs: isFinite(phase.representativeMs)
        ? phase.representativeMs
        : startMs + (endMs - startMs) / 2,
    });
  }
  return out;
}

function refFallback(analysis: ShotAnalysis): RefPhase {
  const ts = analysis.timestamps as
    Partial<ShotAnalysis['timestamps']> | undefined;
  const rawStart = ts?.startMs;
  const rawEnd = ts?.endMs;
  const rawContact = ts?.contactMs;
  const startMs = isFinite(rawStart) ? rawStart : 0;
  const endMs = Math.max(startMs, isFinite(rawEnd) ? rawEnd : startMs);
  return {
    key: 'contact',
    startMs,
    endMs,
    atMs: isFinite(rawContact) ? rawContact : startMs + (endMs - startMs) / 2,
  };
}

function isFault(cp: { band: ScoreBand }): boolean {
  return cp.band === 'red' || cp.band === 'yellow';
}

function refVerdict(cps: readonly { band: ScoreBand }[]): string {
  if (cps.some(cp => cp.band === 'red')) return 'fix';
  if (cps.some(cp => cp.band === 'yellow')) return 'watch';
  return 'strong';
}

function refFixKeys(
  analysis: ShotAnalysis,
  participating: RefCheckpoint[],
  limit: number,
): CheckpointKey[] {
  const priority = analysis.priorityFix?.checkpoint ?? null;
  const faults = participating.filter(isFault);
  const sorted = [...faults].sort((a, b) => {
    if (a.key === priority) return -1;
    if (b.key === priority) return 1;
    return (
      a.score - b.score ||
      CHECKPOINTS.indexOf(a.key) - CHECKPOINTS.indexOf(b.key)
    );
  });
  return sorted.slice(0, Math.max(0, limit)).map(cp => cp.key);
}

function refStrengthKeys(
  participating: RefCheckpoint[],
  limit: number,
): CheckpointKey[] {
  return participating
    .filter(cp => cp.band === 'green')
    .sort(
      (a, b) =>
        b.score - a.score ||
        CHECKPOINTS.indexOf(a.key) - CHECKPOINTS.indexOf(b.key),
    )
    .slice(0, Math.max(0, limit))
    .map(cp => cp.key);
}

/** Wrist path length inside the stroke window with the model's visibility floor. */
function refPathLength(
  sequence: ReviewPoseSequence | null,
  joint: ReviewJoint,
  startMs: number,
  endMs: number,
): number | null {
  if (!sequence) return null;
  let previous: Point | null = null;
  let samples = 0;
  let total = 0;
  for (const frame of sequence.frames) {
    if (frame.timestampMs < startMs || frame.timestampMs > endMs) continue;
    const mark = frame.landmarks.find(entry => entry.name === joint);
    if (!mark || !isFinite(mark.x) || !isFinite(mark.y)) continue;
    if (!(mark.visibility >= 0.3)) continue;
    samples += 1;
    if (previous) total += Math.hypot(mark.x - previous.x, mark.y - previous.y);
    previous = { x: mark.x, y: mark.y };
  }
  return samples >= 2 ? total : null;
}

function refDominant(fixture: Fixture): 'left' | 'right' {
  const ts = fixture.analysis.timestamps as
    Partial<ShotAnalysis['timestamps']> | undefined;
  const rawStart = ts?.startMs;
  const rawEnd = ts?.endMs;
  const startMs = isFinite(rawStart) ? rawStart : Number.NEGATIVE_INFINITY;
  const endMs = isFinite(rawEnd) ? rawEnd : Number.POSITIVE_INFINITY;
  const left = refPathLength(fixture.sequence, 'left_wrist', startMs, endMs);
  const right = refPathLength(fixture.sequence, 'right_wrist', startMs, endMs);
  if (left === null && right === null) {
    return fixture.analysis.handedness === 'left' ? 'left' : 'right';
  }
  return (right ?? 0) >= (left ?? 0) ? 'right' : 'left';
}

/** Nearest recorded frame within tolerance; ties → the earlier frame. */
function refFrameAt(
  sequence: ReviewPoseSequence | null,
  tMs: number,
): ReviewPoseFrame | null {
  if (!sequence || sequence.frames.length === 0 || !Number.isFinite(tMs)) {
    return null;
  }
  let best: ReviewPoseFrame | null = null;
  for (const frame of sequence.frames) {
    if (
      best === null ||
      Math.abs(frame.timestampMs - tMs) < Math.abs(best.timestampMs - tMs)
    ) {
      best = frame;
    }
  }
  if (!best || Math.abs(best.timestampMs - tMs) > POSE_FRAME_TOLERANCE_MS) {
    return null;
  }
  return best;
}

function refCurrentStop(
  stops: readonly ReviewStop[],
  tMs: number,
): ReviewStop | null {
  if (stops.length === 0) return null;
  const t = Number.isFinite(tMs) ? tMs : 0;
  const containing = stops.filter(stop => t >= stop.startMs && t <= stop.endMs);
  if (containing.length > 0) {
    let best = containing[0] as ReviewStop;
    for (const stop of containing) {
      if (Math.abs(stop.atMs - t) < Math.abs(best.atMs - t)) best = stop;
    }
    return best;
  }
  const passed = stops.filter(stop => stop.atMs <= t);
  if (passed.length > 0) {
    let best = passed[0] as ReviewStop;
    for (const stop of passed) if (stop.atMs >= best.atMs) best = stop;
    return best;
  }
  return stops[0] ?? null;
}

function refNextAutoPause(
  stops: readonly ReviewStop[],
  previousMs: number,
  nowMs: number,
  visited: ReadonlySet<string>,
): ReviewStop | null {
  if (!Number.isFinite(previousMs) || !Number.isFinite(nowMs)) return null;
  const crossed = stops.filter(
    stop =>
      !visited.has(stop.id) && stop.atMs > previousMs && stop.atMs <= nowMs,
  );
  let best: ReviewStop | null = null;
  for (const stop of crossed)
    if (best === null || stop.atMs < best.atMs) best = stop;
  return best;
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every(item => set.has(item));
}

const RGB_RE = /^rgb\((\d+),(\d+),(\d+)\)$/;
const RGBA_RE = /^rgba\((\d+),(\d+),(\d+),(\d+(?:\.\d+)?)\)$/;

// ─── Script-level invariants (checked at build and after every rebuild) ─────

function checkScript(
  script: FormReviewScript,
  fixture: Fixture,
  step: number,
  tally: (key: string) => void = () => undefined,
): void {
  const { analysis } = fixture;
  const participating = refParticipating(analysis);
  const phases = refPhases(analysis);
  const dominant = refDominant(fixture);
  const say = (message: string) => () =>
    `${message} (seed fixture legal=${fixture.legal})`;

  invariant(
    script.dominant === dominant,
    'dominant-side',
    step,
    say(`dominant ${script.dominant} ≠ reference ${dominant}`),
  );
  invariant(
    script.facing === 1 || script.facing === -1,
    'facing-sign',
    step,
    say(`facing ${String(script.facing)}`),
  );
  if (fixture.sequence === null || !phases.some(p => p.key === 'accelerate')) {
    invariant(
      script.facing === 1,
      'facing-fallback',
      step,
      say(`facing fell to ${script.facing} without a measurable wrist path`),
    );
  }
  invariant(
    script.shotType === analysis.shotType,
    'shot-type',
    step,
    say('script shotType differs from the analysis'),
  );

  // Stops.
  const ids = script.stops.map(stop => stop.id);
  invariant(
    new Set(ids).size === ids.length,
    'stop-ids-unique',
    step,
    say(`duplicate stop ids ${ids.join(',')}`),
  );
  for (let index = 1; index < script.stops.length; index += 1) {
    const prev = script.stops[index - 1] as ReviewStop;
    const next = script.stops[index] as ReviewStop;
    invariant(
      prev.atMs < next.atMs ||
        (prev.atMs === next.atMs &&
          PHASES.indexOf(prev.phase) <= PHASES.indexOf(next.phase)),
      'stops-ordered',
      step,
      say(`stops out of order at ${index}: ${prev.atMs} then ${next.atMs}`),
    );
  }
  let expectedSpans: RefPhase[];
  if (phases.length === 0) {
    expectedSpans = [refFallback(analysis)];
  } else {
    expectedSpans = phases.filter(
      phase =>
        phase.key === 'contact' ||
        participating.some(cp => CHECKPOINT_PHASE[cp.key] === phase.key),
    );
  }
  invariant(
    sameSet(
      script.stops.map(stop => stop.phase),
      expectedSpans.map(span => span.key),
    ),
    'stop-phases',
    step,
    say(
      `stop phases ${script.stops.map(s => s.phase).join(',')} ≠ measured ${expectedSpans
        .map(s => s.key)
        .join(',')}`,
    ),
  );
  for (const stop of script.stops) {
    const span = expectedSpans.find(
      entry => entry.key === stop.phase,
    ) as RefPhase;
    invariant(
      stop.startMs === span.startMs &&
        stop.endMs === span.endMs &&
        stop.atMs === span.atMs,
      'stop-span',
      step,
      say(
        `stop ${stop.id} span ${stop.startMs}/${stop.atMs}/${stop.endMs} ≠ measured ${span.startMs}/${span.atMs}/${span.endMs}`,
      ),
    );
    invariant(
      Number.isFinite(stop.atMs) &&
        Number.isFinite(stop.startMs) &&
        Number.isFinite(stop.endMs),
      'stop-finite',
      step,
      say(`non-finite stop bounds on ${stop.id}`),
    );
    invariant(
      stop.startMs <= stop.endMs,
      'stop-bounds',
      step,
      say(`stop ${stop.id} startMs > endMs`),
    );
    const owned =
      phases.length === 0
        ? participating
        : participating.filter(cp => CHECKPOINT_PHASE[cp.key] === stop.phase);
    invariant(
      sameSet(
        stop.checkpoints.map(cp => cp.key),
        owned.map(cp => cp.key),
      ),
      'stop-checkpoints',
      step,
      say(
        `stop ${stop.id} carries ${stop.checkpoints.map(cp => cp.key).join(',')} ≠ ${owned
          .map(cp => cp.key)
          .join(',')}`,
      ),
    );
    for (let index = 1; index < stop.checkpoints.length; index += 1) {
      const a = stop.checkpoints[index - 1] as ReviewStopCheckpoint;
      const b = stop.checkpoints[index] as ReviewStopCheckpoint;
      invariant(
        a.score <= b.score,
        'stop-worst-first',
        step,
        say(
          `stop ${stop.id} checkpoints not worst-first: ${a.score} before ${b.score}`,
        ),
      );
    }
    for (const cp of stop.checkpoints) {
      const source = owned.find(entry => entry.key === cp.key) as RefCheckpoint;
      invariant(
        cp.score === source.score &&
          cp.band === source.band &&
          cp.direction === source.direction,
        'stop-checkpoint-values',
        step,
        say(`stop ${stop.id} altered ${cp.key}'s measured values`),
      );
      invariant(
        cp.severity >= 0 && cp.severity <= 1,
        'severity-clamped',
        step,
        say(`severity ${cp.severity} on ${cp.key}`),
      );
      invariant(
        cp.name.length > 0,
        'checkpoint-name',
        step,
        say(`empty name for ${cp.key}`),
      );
    }
    invariant(
      stop.verdict === refVerdict(stop.checkpoints),
      'verdict',
      step,
      say(
        `stop ${stop.id} verdict ${stop.verdict} ≠ ${refVerdict(stop.checkpoints)}`,
      ),
    );
    invariant(
      stop.title.length > 0 && stop.headline.length > 0 && stop.cue.length > 0,
      'copy-present',
      step,
      say(`empty title/headline/cue on ${stop.id}`),
    );
    invariant(
      stop.cue.length <= 160,
      'cue-length',
      step,
      say(`cue ${stop.cue.length} chars on ${stop.id}`),
    );
    for (const text of [
      stop.title,
      stop.headline,
      stop.cue,
      stop.arrow?.label ?? '',
    ]) {
      const hit = forbiddenCopyIn(text);
      invariant(
        hit === null,
        'copy-forbidden',
        step,
        say(`"${text}" contains ${hit}`),
      );
    }
    const worst = stop.checkpoints[0];
    if (!worst) {
      invariant(
        stop.phase === 'contact' &&
          !stop.headline.includes('scored') &&
          stop.arrow === null &&
          stop.verdict === 'strong',
        'contact-only-stop',
        step,
        say(`unscored stop ${stop.id} claims something: ${stop.headline}`),
      );
      invariant(
        sameSet(stop.focusJoints, [
          `${dominant}_wrist` as ReviewJoint,
          'left_hip',
          'right_hip',
        ]),
        'contact-only-joints',
        step,
        say(`unscored contact stop joints ${stop.focusJoints.join(',')}`),
      );
    } else {
      invariant(
        stop.headline.startsWith(
          `${worst.name} scored ${Math.round(worst.score)} — `,
        ),
        'headline-measured',
        step,
        say(
          `headline "${stop.headline}" is not the worst checkpoint's measured line`,
        ),
      );
      const faults = stop.checkpoints.filter(isFault);
      const bandConsistent = stop.checkpoints.every(
        cp => cp.score >= 0 && cp.score <= 100 && cp.band === bandFor(cp.score),
      );
      if (!bandConsistent) tally('bandInconsistentStops');
      // The headline, cue and arrow of a stop with measured faults must come
      // from one of those faults (worst by score ⇔ worst by band when the
      // record is consistent).
      if (STRICT || bandConsistent) {
        invariant(
          faults.length === 0 || isFault(worst),
          'headline-traces-fault',
          step,
          say(
            `stop ${stop.id} headlines ${worst.key} (${worst.band}, score ${worst.score}) although its faults are ${faults.map(cp => cp.key).join(',')}`,
          ),
        );
      }
      const focusSource = faults.length > 0 ? faults : [worst];
      const expectedJoints = new Set<ReviewJoint>();
      for (const cp of focusSource) {
        for (const joint of checkpointJoints(cp.key, dominant))
          expectedJoints.add(joint);
      }
      invariant(
        sameSet(stop.focusJoints, [...expectedJoints]) &&
          new Set(stop.focusJoints).size === stop.focusJoints.length,
        'focus-joints',
        step,
        say(
          `stop ${stop.id} focus ${stop.focusJoints.join(',')} ≠ ${[...expectedJoints].join(',')}`,
        ),
      );
      if (stop.verdict === 'strong' || worst.direction === 'none') {
        invariant(
          stop.arrow === null,
          'arrow-only-for-faults',
          step,
          say(
            `arrow drawn on a ${stop.verdict} stop with direction ${worst.direction}`,
          ),
        );
      }
      if (stop.arrow) {
        invariant(
          checkpointJoints(worst.key, dominant).includes(stop.arrow.joint) &&
            stop.arrow.label.length > 0,
          'arrow-anchored',
          step,
          say(
            `arrow on ${stop.arrow.joint} is not a joint ${worst.key} was measured from`,
          ),
        );
        if (STRICT || bandConsistent) {
          invariant(
            stop.focusJoints.includes(stop.arrow.joint),
            'arrow-on-warm-joint',
            step,
            say(
              `arrow on ${stop.arrow.joint} but the stop warms ${stop.focusJoints.join(',')}`,
            ),
          );
        }
        invariant(
          stop.arrow.joint.startsWith(dominant) || stop.arrow.joint === 'head',
          'arrow-dominant-side',
          step,
          say(
            `arrow joint ${stop.arrow.joint} is not on the dominant ${dominant} side`,
          ),
        );
      }
    }
    for (const joint of stop.focusJoints) {
      invariant(
        (REVIEW_JOINTS as readonly string[]).includes(joint),
        'joint-vocabulary',
        step,
        say(`unknown joint ${joint}`),
      );
    }
  }
  if (phases.some(p => p.key === 'contact') || phases.length === 0) {
    invariant(
      script.stops.some(stop => stop.phase === 'contact'),
      'contact-stop-always',
      step,
      say('no contact stop although contact was measured (or nothing was)'),
    );
  }

  // Static heat.
  const expectedHeat = new Map<ReviewJoint, number>();
  for (const cp of participating) {
    if (!isFault(cp)) continue;
    const heat = clamp01(1 - cp.score / 100);
    for (const joint of checkpointJoints(cp.key, dominant)) {
      expectedHeat.set(joint, Math.max(expectedHeat.get(joint) ?? 0, heat));
    }
  }
  const heatKeys = Object.keys(script.jointHeat) as ReviewJoint[];
  invariant(
    sameSet(heatKeys, [...expectedHeat.keys()]),
    'heat-joints',
    step,
    say(
      `heat joints ${heatKeys.join(',')} ≠ fault joints ${[...expectedHeat.keys()].join(',')}`,
    ),
  );
  for (const joint of heatKeys) {
    const value = script.jointHeat[joint] as number;
    invariant(
      value >= 0 &&
        value <= 1 &&
        Math.abs(value - (expectedHeat.get(joint) ?? -1)) < 1e-9,
      'heat-value',
      step,
      say(`heat ${joint}=${value} ≠ ${expectedHeat.get(joint)}`),
    );
  }

  // Strongest / weakest.
  if (participating.length === 0) {
    invariant(
      script.strongest === null && script.weakest === null,
      'extremes-null',
      step,
      say('strongest/weakest present without a participating checkpoint'),
    );
  } else {
    const max = Math.max(...participating.map(cp => cp.score));
    const min = Math.min(...participating.map(cp => cp.score));
    invariant(
      script.strongest !== null &&
        script.strongest.score === max &&
        participating.some(cp => cp.key === script.strongest?.key),
      'strongest',
      step,
      say(
        `strongest ${script.strongest?.key}=${script.strongest?.score} ≠ max ${max}`,
      ),
    );
    invariant(
      script.weakest !== null &&
        script.weakest.score === min &&
        participating.some(cp => cp.key === script.weakest?.key),
      'weakest',
      step,
      say(
        `weakest ${script.weakest?.key}=${script.weakest?.score} ≠ min ${min}`,
      ),
    );
  }
  const serialized = stableJson(script);
  invariant(
    !serialized.includes('__nonfinite'),
    'script-finite',
    step,
    say('non-finite number inside the script'),
  );
}

// ─── Step-level checks ──────────────────────────────────────────────────────

function checkHeatAt(
  script: FormReviewScript,
  tMs: number,
  step: number,
  atStop: ReviewStop | null,
): Record<string, number> {
  const heat = jointHeatAt(script, tMs);
  const entries = Object.entries(heat) as Array<[ReviewJoint, number]>;
  for (const [joint, value] of entries) {
    invariant(
      (REVIEW_JOINTS as readonly string[]).includes(joint),
      'heat-at-joints',
      step,
      () => `jointHeatAt produced unknown joint ${joint}`,
    );
    invariant(
      Number.isFinite(value) && value >= 0 && value <= 1,
      'heat-at-range',
      step,
      () => `jointHeatAt ${joint}=${value} outside 0..1 at t=${tMs}`,
    );
  }
  for (const joint of REVIEW_JOINTS) {
    const base = script.jointHeat[joint];
    if (isFinite(base)) {
      invariant(
        (heat[joint] ?? -1) >= 0.35 * clamp01(base) - 1e-9,
        'heat-floor',
        step,
        () =>
          `jointHeatAt ${joint}=${heat[joint]} below the 0.35 floor of ${base} at t=${tMs}`,
      );
    } else {
      const pulsed = script.stops.some(
        stop => stop.verdict !== 'strong' && stop.focusJoints.includes(joint),
      );
      invariant(
        pulsed || heat[joint] === undefined,
        'heat-only-faults',
        step,
        () => `jointHeatAt warmed ${joint} which no fault owns at t=${tMs}`,
      );
    }
  }
  if (atStop && atStop.verdict !== 'strong' && Number.isFinite(tMs)) {
    for (const joint of atStop.focusJoints) {
      const owner =
        atStop.checkpoints.find(cp =>
          checkpointJoints(cp.key, script.dominant).includes(joint),
        ) ?? atStop.checkpoints[0];
      if (!owner) continue;
      const expected = clamp01(1 - owner.score / 100);
      invariant(
        (heat[joint] ?? -1) >= expected - 1e-9,
        'heat-peak-at-stop',
        step,
        () =>
          `at stop ${atStop.id} joint ${joint} heat ${heat[joint]} < ${expected}`,
      );
    }
  }
  return heat;
}

function checkTint(heat: number, step: number): void {
  const ramp = heatRampColor(heat);
  for (const channel of ramp) {
    invariant(
      channel >= 0 && channel <= 255,
      'ramp-range',
      step,
      () => `heatRampColor(${heat}) channel ${channel}`,
    );
  }
  const tint = heatTint(heat);
  if (clamp01(heat) === 0) {
    invariant(tint === '#F8FAF5', 'tint-cold', step, () => `cold tint ${tint}`);
  } else {
    const match = RGB_RE.exec(tint);
    invariant(
      match !== null,
      'tint-format',
      step,
      () => `heatTint(${heat}) = ${tint}`,
    );
    for (const channel of (match as RegExpExecArray).slice(1, 4)) {
      invariant(
        Number(channel) <= 255,
        'tint-range',
        step,
        () => `heatTint(${heat}) = ${tint}`,
      );
    }
  }
  const fault = faultTint(heat);
  const faultMatch = RGBA_RE.exec(fault);
  invariant(
    faultMatch !== null,
    'fault-tint-format',
    step,
    () => `faultTint(${heat}) = ${fault}`,
  );
  const alpha = Number((faultMatch as RegExpExecArray)[4]);
  invariant(
    alpha >= 0.18 - 1e-9 && alpha <= 0.48 + 1e-9,
    'fault-tint-alpha',
    step,
    () => `faultTint(${heat}) alpha ${alpha}`,
  );
  for (const channel of (faultMatch as RegExpExecArray).slice(1, 4)) {
    invariant(
      Number(channel) <= 255,
      'fault-tint-range',
      step,
      () => `faultTint(${heat}) = ${fault}`,
    );
  }
}

function checkGeometry(
  rng: Rng,
  fixture: Fixture,
  frame: ReviewPoseFrame | null,
  step: number,
): Record<string, unknown> {
  const degenerate = rng.chance(0.1);
  const stage = degenerate
    ? {
        width: rng.pick([0, -10, Number.NaN, 300]),
        height: rng.pick([0, Number.POSITIVE_INFINITY, 400]),
      }
    : { width: rng.int(200, 1400), height: rng.int(200, 1400) };
  const known = reviewVideoSize(fixture.sequence);
  const video =
    known && rng.chance(0.7)
      ? { width: known.width, height: known.height }
      : degenerate
        ? {
            width: rng.pick([0, Number.NaN, 1080]),
            height: rng.pick([0, -1, 1920]),
          }
        : { width: rng.int(240, 4000), height: rng.int(240, 4000) };
  const rect = containRect(stage, video);
  const stageWidth = isFinite(stage.width) && stage.width > 0 ? stage.width : 0;
  const stageHeight =
    isFinite(stage.height) && stage.height > 0 ? stage.height : 0;
  invariant(
    Number.isFinite(rect.x) &&
      Number.isFinite(rect.y) &&
      Number.isFinite(rect.width) &&
      Number.isFinite(rect.height),
    'rect-finite',
    step,
    () =>
      `containRect produced ${stableJson(rect)} for ${stableJson({ stage, video })}`,
  );
  invariant(
    rect.x >= -1e-6 &&
      rect.y >= -1e-6 &&
      rect.x + rect.width <= stageWidth + 1e-6 &&
      rect.y + rect.height <= stageHeight + 1e-6,
    'rect-inside-stage',
    step,
    () => `rect ${stableJson(rect)} escapes stage ${stableJson(stage)}`,
  );
  const videoOk =
    isFinite(video.width) &&
    video.width > 0 &&
    isFinite(video.height) &&
    video.height > 0;
  if (stageWidth > 0 && stageHeight > 0 && videoOk) {
    invariant(
      Math.abs(rect.width / rect.height - video.width / video.height) < 1e-6 ||
        rect.width === 0,
      'rect-aspect',
      step,
      () =>
        `rect ${stableJson(rect)} does not keep aspect of ${stableJson(video)}`,
    );
    invariant(
      Math.abs(rect.x * 2 + rect.width - stageWidth) < 1e-6 &&
        Math.abs(rect.y * 2 + rect.height - stageHeight) < 1e-6,
      'rect-centered',
      step,
      () => `rect ${stableJson(rect)} is not centered in ${stableJson(stage)}`,
    );
    invariant(
      Math.abs(rect.width - stageWidth) < 1e-6 ||
        Math.abs(rect.height - stageHeight) < 1e-6,
      'rect-touches-stage',
      step,
      () => `rect ${stableJson(rect)} touches neither stage edge`,
    );
  } else {
    invariant(
      rect.x === 0 &&
        rect.y === 0 &&
        rect.width === stageWidth &&
        rect.height === stageHeight,
      'rect-degenerate-full',
      step,
      () =>
        `degenerate ${stableJson({ stage, video })} gave ${stableJson(rect)} not the full stage`,
    );
  }

  const points: Partial<Record<string, Point>> = {};
  if (frame) {
    for (const mark of frame.landmarks) {
      const point = stagePoint(rect, mark);
      if (mark.x >= 0 && mark.x <= 1 && mark.y >= 0 && mark.y <= 1) {
        invariant(
          point.x >= rect.x - 1e-6 &&
            point.x <= rect.x + rect.width + 1e-6 &&
            point.y >= rect.y - 1e-6 &&
            point.y <= rect.y + rect.height + 1e-6,
          'stage-point-inside',
          step,
          () =>
            `landmark ${mark.name} projected to ${stableJson(point)} outside ${stableJson(rect)}`,
        );
      }
      points[mark.name] = point;
    }
  }
  if (rng.chance(0.2))
    delete points[
      rng.pick(['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'])
    ];
  const unit = torsoUnit(points);
  const torsoComplete =
    points.left_shoulder &&
    points.right_shoulder &&
    points.left_hip &&
    points.right_hip;
  if (torsoComplete) {
    invariant(
      unit >= 9 && unit <= 30,
      'torso-unit-clamped',
      step,
      () => `torsoUnit ${unit}`,
    );
  } else {
    invariant(
      unit === TORSO_UNIT_FALLBACK,
      'torso-unit-fallback',
      step,
      () => `torsoUnit ${unit} without a torso`,
    );
  }
  return { stage, video, rect, unit };
}

function checkArrow(
  stop: ReviewStop | null,
  script: FormReviewScript,
  rng: Rng,
  step: number,
): string | null {
  if (!stop?.arrow) return null;
  const joint = { x: rng.float(-50, 500), y: rng.float(-50, 500) };
  const centerX = rng.float(-50, 500);
  const vector = arrowVector(
    stop.arrow.direction,
    script.facing,
    joint,
    centerX,
  );
  if (stop.arrow.direction === 'steadier') {
    invariant(
      vector === null,
      'arrow-steadier-ring',
      step,
      () => `steadier drew ${stableJson(vector)}`,
    );
    return 'ring';
  }
  invariant(
    vector !== null,
    'arrow-vector-present',
    step,
    () => `${stop.arrow?.direction} drew nothing`,
  );
  const { dx, dy } = vector as { dx: number; dy: number };
  invariant(
    Math.abs(dx) + Math.abs(dy) === 1 && (dx === 0 || dy === 0),
    'arrow-unit',
    step,
    () =>
      `${stop.arrow?.direction} vector ${dx},${dy} is not a unit axis vector`,
  );
  if (stop.arrow.direction === 'forward') {
    invariant(
      dx === script.facing,
      'arrow-forward-facing',
      step,
      () => `forward dx ${dx} facing ${script.facing}`,
    );
  }
  if (stop.arrow.direction === 'back') {
    invariant(
      dx === -script.facing,
      'arrow-back-facing',
      step,
      () => `back dx ${dx} facing ${script.facing}`,
    );
  }
  if (stop.arrow.direction === 'up')
    invariant(dy === -1, 'arrow-up', step, () => `up dy ${dy}`);
  if (stop.arrow.direction === 'down')
    invariant(dy === 1, 'arrow-down', step, () => `down dy ${dy}`);
  if (stop.arrow.direction === 'wider') {
    invariant(
      dx === (joint.x - centerX < 0 ? -1 : 1),
      'arrow-wider',
      step,
      () => `wider dx ${dx}`,
    );
  }
  if (stop.arrow.direction === 'narrower') {
    invariant(
      dx === (joint.x - centerX < 0 ? 1 : -1),
      'arrow-narrower',
      step,
      () => `narrower dx ${dx}`,
    );
  }
  return `${dx},${dy}`;
}

function checkLists(
  fixture: Fixture,
  rng: Rng,
  step: number,
): Record<string, unknown> {
  const { analysis } = fixture;
  const participating = refParticipating(analysis);
  const limit = rng.int(-1, 6);
  const fixes = fixList(analysis, limit);
  const expectedFixKeys = refFixKeys(analysis, participating, limit);
  invariant(
    stableJson(fixes.map(fix => fix.key)) === stableJson(expectedFixKeys),
    'fix-list-order',
    step,
    () =>
      `fixList(${limit}) ${fixes.map(f => f.key).join(',')} ≠ ${expectedFixKeys.join(',')}`,
  );
  const priority = analysis.priorityFix?.checkpoint ?? null;
  for (const fix of fixes) {
    invariant(
      isFault(fix),
      'fix-list-faults-only',
      step,
      () => `fixList carries ${fix.band} ${fix.key}`,
    );
    invariant(
      fix.isPriority === (fix.key === priority),
      'fix-list-priority-flag',
      step,
      () => `isPriority on ${fix.key} vs priority ${priority}`,
    );
    invariant(
      fix.phase === CHECKPOINT_PHASE[fix.key],
      'fix-list-phase',
      step,
      () => `phase for ${fix.key}`,
    );
    invariant(
      fix.cue.length > 0 &&
        fix.headline.startsWith(
          `${fix.name} scored ${Math.round(fix.score)} — `,
        ),
      'fix-list-copy',
      step,
      () => `fix copy for ${fix.key}: ${fix.headline}`,
    );
    const hit = forbiddenCopyIn(`${fix.headline} ${fix.cue}`);
    invariant(
      hit === null,
      'copy-forbidden',
      step,
      () => `fix copy contains ${hit}`,
    );
  }
  const strengths = strengthList(analysis, limit);
  const expectedStrengthKeys = refStrengthKeys(participating, limit);
  invariant(
    stableJson(strengths.map(cp => cp.key)) ===
      stableJson(expectedStrengthKeys),
    'strength-list-order',
    step,
    () =>
      `strengthList(${limit}) ${strengths.map(s => s.key).join(',')} ≠ ${expectedStrengthKeys.join(',')}`,
  );
  for (const cp of strengths) {
    invariant(
      cp.band === 'green',
      'strength-list-green-only',
      step,
      () => `strength ${cp.key} band ${cp.band}`,
    );
  }

  // Drill focus from THIS analysis only.
  const focus = drillFocusFromAnalysis(analysis);
  const topFix = refFixKeys(analysis, participating, 1)[0] ?? null;
  let expectedKey: string | null = topFix;
  let expectedScore: number | null =
    topFix === null
      ? null
      : (participating.find(cp => cp.key === topFix)?.score ?? null);
  if (expectedKey === null && priority !== null) {
    const raw: unknown[] = Array.isArray(analysis.checkpoints)
      ? analysis.checkpoints
      : [];
    const named = raw.find(entry => {
      const cp = entry as Partial<CheckpointScore> | null;
      return (
        cp !== null &&
        cp?.key === priority &&
        cp.applicable !== false &&
        isFinite(cp.score)
      );
    }) as CheckpointScore | undefined;
    if (named && isFinite(named.score)) {
      expectedKey = named.key;
      expectedScore = named.score;
    }
  }
  if (expectedKey === null) {
    invariant(
      focus === null,
      'drill-focus-null',
      step,
      () => `focus ${stableJson(focus)} without a scored fault`,
    );
  } else {
    invariant(
      focus !== null &&
        focus.checkpoint === expectedKey &&
        focus.averageScore === Math.round(expectedScore as number) &&
        focus.sampleCount === 1 &&
        focus.shotType === analysis.shotType &&
        focus.family === (SHOT_FAMILY[analysis.shotType] ?? 'global'),
      'drill-focus',
      step,
      () => `focus ${stableJson(focus)} ≠ ${expectedKey}@${expectedScore}`,
    );
  }

  // Drill picks against an independent family-first/global-fill model.
  let picked: string[] = [];
  if (focus) {
    const drillCount = rng.int(0, 14);
    const drills: Array<{ slug: string; families: string[] }> = [];
    for (let index = 0; index < drillCount; index += 1) {
      drills.push({
        slug: `drill-${index}`,
        families: rng.subset(FAMILIES, 0.3),
      });
    }
    const pickLimit = rng.int(-1, 6);
    const out = pickRecommendedDrills(drills, focus, pickLimit);
    const primary = drills.filter(d => d.families.includes(focus.family));
    const fill =
      focus.family === 'global'
        ? []
        : drills.filter(
            d =>
              !d.families.includes(focus.family) &&
              d.families.includes('global'),
          );
    const expected = [...primary, ...fill]
      .slice(0, Math.max(0, pickLimit))
      .map(d => d.slug);
    picked = out.map(d => d.slug);
    invariant(
      stableJson(picked) === stableJson(expected),
      'drill-pick-order',
      step,
      () =>
        `pickRecommendedDrills(${pickLimit}) ${picked.join(',')} ≠ ${expected.join(',')}`,
    );
    invariant(
      new Set(picked).size === picked.length,
      'drill-pick-unique',
      step,
      () => `duplicate drills ${picked.join(',')}`,
    );
    for (const drill of out) {
      invariant(
        drill.families.includes(focus.family) ||
          drill.families.includes('global'),
        'drill-pick-relevance',
        step,
        () => `${drill.slug} matches neither ${focus.family} nor global`,
      );
    }
  }
  return {
    limit,
    fixes: fixes.map(f => f.key),
    strengths: strengths.map(s => s.key),
    focus: focus?.checkpoint ?? null,
    picked,
  };
}

// ─── One sequence ───────────────────────────────────────────────────────────

type Action =
  | 'tick'
  | 'seek'
  | 'jumpToStop'
  | 'restart'
  | 'finish'
  | 'speed'
  | 'lists'
  | 'nonfinite'
  | 'rebuild';

const ACTION_WEIGHTS: Array<[Action, number]> = [
  ['tick', 34],
  ['seek', 16],
  ['jumpToStop', 8],
  ['restart', 6],
  ['finish', 4],
  ['speed', 6],
  ['lists', 12],
  ['nonfinite', 6],
  ['rebuild', 8],
];

function drawAction(rng: Rng): Action {
  const total = ACTION_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng.float(0, total);
  for (const [action, weight] of ACTION_WEIGHTS) {
    roll -= weight;
    if (roll < 0) return action;
  }
  return 'tick';
}

function runSequence(seed: number, stepLimit?: number): SequenceRun {
  const rng = new Rng(seed);
  const length = drawLength(rng);
  const steps = Math.min(length, stepLimit ?? length);
  const fixture = genFixture(seed);
  const analysisBefore = stableJson(fixture.analysis);
  const sequenceBefore = stableJson(fixture.sequence);
  const tallies: Record<string, number> = {
    legalFixtures: fixture.legal ? 1 : 0,
    nearLegalFixtures: fixture.legal ? 0 : 1,
  };
  const tally = (key: string) => {
    tallies[key] = (tallies[key] ?? 0) + 1;
  };

  const script = buildFormReviewScript(fixture.analysis, fixture.sequence);
  checkScript(script, fixture, 0, tally);
  const scriptJson = stableJson(script);
  const stops = script.stops;
  const duration = Math.max(
    fixture.durationMs,
    ...stops.map(stop => stop.endMs),
  );
  const trace: StepTrace[] = [];

  // Player state model (FormReviewPlayer semantics: pause at stop.atMs,
  // jump re-arms every stop ahead of the new position).
  let playhead = 0;
  let passStart = 0;
  let visited = new Set<string>();
  let fired: string[] = [];
  let playing = true;
  const distinctAt =
    new Set(stops.map(stop => stop.atMs)).size === stops.length;

  const endOfPass = (step: number) => {
    // Every stop strictly inside (passStart, duration] fired exactly once in
    // ascending order — only claimable when checkpoint moments are distinct.
    const expected = stops
      .filter(stop => stop.atMs > passStart && stop.atMs <= duration)
      .sort((a, b) => a.atMs - b.atMs)
      .map(stop => stop.id);
    if (!distinctAt) {
      tally('passesWithSharedAtMs');
      const firedSet = new Set(fired);
      if (expected.some(id => !firedSet.has(id))) {
        tally('sharedAtMsStopNeverFired');
      }
      return;
    }
    invariant(
      stableJson(fired) === stableJson(expected),
      'pass-fires-every-stop-once',
      step,
      () =>
        `pass from ${passStart} fired ${fired.join(',')} ≠ ${expected.join(',')}`,
    );
    tally('completePasses');
  };

  for (let step = 1; step <= steps; step += 1) {
    const action = drawAction(rng);
    const entry: StepTrace = { step, action };
    switch (action) {
      case 'tick': {
        if (!playing) {
          // Resume: the player continues from the paused frame.
          playing = true;
        }
        const previous = playhead;
        let now = Math.min(duration, previous + rng.float(1, 400));
        if (rng.chance(0.05)) now = previous; // zero-length tick
        const stop = nextAutoPause(stops, previous, now, visited);
        const expected = refNextAutoPause(stops, previous, now, visited);
        invariant(
          (stop === null && expected === null) || stop?.id === expected?.id,
          'auto-pause-crossing',
          step,
          () =>
            `nextAutoPause(${previous}→${now}) gave ${stop?.id ?? 'null'} ≠ ${expected?.id ?? 'null'}`,
        );
        if (stop) {
          invariant(
            !visited.has(stop.id),
            'auto-pause-never-repeats',
            step,
            () => `${stop.id} fired twice`,
          );
          invariant(
            stop.atMs > previous && stop.atMs <= now,
            'auto-pause-window',
            step,
            () => `${stop.id} at ${stop.atMs} outside (${previous}, ${now}]`,
          );
          visited.add(stop.id);
          fired.push(stop.id);
          playhead = stop.atMs;
          playing = false;
          tally('autoPauses');
          entry.pausedAt = stop.id;
          checkHeatAt(script, playhead, step, stop);
        } else {
          playhead = now;
          entry.now = now;
          if (now >= duration && stops.length > 0) {
            endOfPass(step);
            // finish(): visited cleared, playhead at the end.
            visited = new Set();
            fired = [];
            passStart = duration;
            playing = false;
            entry.finished = true;
          }
        }
        const current = currentStop(stops, playhead);
        const expectedCurrent = refCurrentStop(stops, playhead);
        invariant(
          current?.id === expectedCurrent?.id,
          'current-stop',
          step,
          () =>
            `currentStop(${playhead}) ${current?.id ?? 'null'} ≠ ${expectedCurrent?.id ?? 'null'}`,
        );
        entry.current = current?.id ?? null;
        break;
      }
      case 'seek': {
        const mode = rng.int(0, 3);
        const t =
          mode === 0
            ? rng.float(-200, duration + 200)
            : mode === 1 &&
                fixture.sequence &&
                fixture.sequence.frames.length > 0
              ? rng.pick(fixture.sequence.frames).timestampMs +
                rng.pick([0, 0.5, -60, 60, 120, 121, -121])
              : mode === 2 && stops.length > 0
                ? rng.pick(stops).atMs + rng.pick([0, -1, 1])
                : rng.float(0, duration);
        playhead = t;
        // jumpTo semantics: every stop at/behind the new position counts as seen.
        visited = new Set(
          stops.filter(stop => stop.atMs <= t).map(stop => stop.id),
        );
        passStart = t;
        fired = [];
        playing = false;
        const current = currentStop(stops, t);
        const expectedCurrent = refCurrentStop(stops, t);
        invariant(
          current?.id === expectedCurrent?.id,
          'current-stop',
          step,
          () =>
            `currentStop(${t}) ${current?.id ?? 'null'} ≠ ${expectedCurrent?.id ?? 'null'}`,
        );
        invariant(
          (current === null) === (stops.length === 0),
          'current-stop-null-only-empty',
          step,
          () => `currentStop(${t}) null with ${stops.length} stops`,
        );
        const frame = poseFrameAt(fixture.sequence, t);
        const expectedFrame = refFrameAt(fixture.sequence, t);
        invariant(
          (frame === null && expectedFrame === null) ||
            (frame !== null &&
              expectedFrame !== null &&
              frame.timestampMs === expectedFrame.timestampMs),
          'pose-frame-nearest',
          step,
          () =>
            `poseFrameAt(${t}) ${frame?.timestampMs ?? 'null'} ≠ ${expectedFrame?.timestampMs ?? 'null'}`,
        );
        if (frame) {
          invariant(
            fixture.sequence !== null &&
              fixture.sequence.frames.includes(frame),
            'pose-frame-recorded',
            step,
            () => `poseFrameAt(${t}) returned a frame that was never recorded`,
          );
          invariant(
            Math.abs(frame.timestampMs - t) <= POSE_FRAME_TOLERANCE_MS,
            'pose-frame-tolerance',
            step,
            () => `poseFrameAt(${t}) returned ${frame.timestampMs}`,
          );
          tally('framesShown');
        } else {
          tally('framesHidden');
        }
        const atStop = current && current.atMs === t ? current : null;
        const heat = checkHeatAt(script, t, step, atStop);
        for (const value of Object.values(heat)) checkTint(value, step);
        checkTint(
          rng.pick([-1, 0, 0.35, 0.7, 1, 2, Number.NaN, rng.float(0, 1)]),
          step,
        );
        const geometry = checkGeometry(rng, fixture, frame, step);
        entry.t = t;
        entry.current = current?.id ?? null;
        entry.frame = frame?.timestampMs ?? null;
        entry.heat = heat;
        entry.rect = geometry.rect;
        entry.arrow = checkArrow(current, script, rng, step);
        break;
      }
      case 'jumpToStop': {
        if (stops.length === 0) {
          entry.skipped = true;
          break;
        }
        const stop = rng.pick(stops);
        playhead = stop.atMs;
        visited = new Set(
          stops.filter(other => other.atMs <= stop.atMs).map(other => other.id),
        );
        passStart = stop.atMs;
        fired = [];
        playing = false;
        const current = currentStop(stops, stop.atMs);
        invariant(
          current !== null,
          'current-stop-null-only-empty',
          step,
          () => 'currentStop null on a stop',
        );
        invariant(
          (current as ReviewStop).atMs === stop.atMs ||
            !(stop.atMs >= stop.startMs && stop.atMs <= stop.endMs),
          'current-stop-at-own-moment',
          step,
          () =>
            `seeking to ${stop.id}@${stop.atMs} shows ${current?.id} (${current?.atMs})`,
        );
        checkHeatAt(script, stop.atMs, step, stop);
        const next = nextAutoPause(stops, stop.atMs - 1, stop.atMs, visited);
        invariant(
          next === null,
          'jump-marks-visited',
          step,
          () =>
            `after jumping to ${stop.id} it (or an earlier stop) would still auto-pause: ${next?.id}`,
        );
        entry.stop = stop.id;
        entry.current = current?.id ?? null;
        break;
      }
      case 'restart': {
        // togglePlay() from the end: visited cleared, playhead back to 0.
        playhead = 0;
        passStart = 0;
        visited = new Set();
        fired = [];
        playing = true;
        const next = nextAutoPause(stops, 0, 0, visited);
        invariant(
          next === null,
          'auto-pause-zero-tick',
          step,
          () => `a zero-length tick at 0 fired ${next?.id}`,
        );
        const current = currentStop(stops, 0);
        invariant(
          current?.id === refCurrentStop(stops, 0)?.id,
          'current-stop',
          step,
          () => `currentStop(0) ${current?.id ?? 'null'}`,
        );
        entry.current = current?.id ?? null;
        break;
      }
      case 'finish': {
        playhead = duration;
        visited = new Set();
        fired = [];
        passStart = duration;
        playing = false;
        const current = currentStop(stops, duration);
        const expectedCurrent = refCurrentStop(stops, duration);
        invariant(
          current?.id === expectedCurrent?.id,
          'current-stop',
          step,
          () =>
            `currentStop(end) ${current?.id ?? 'null'} ≠ ${expectedCurrent?.id ?? 'null'}`,
        );
        entry.current = current?.id ?? null;
        break;
      }
      case 'speed': {
        const rate = rng.chance(0.7)
          ? rng.pick(REVIEW_SPEEDS)
          : rng.pick([2, 0.75, 0, -1, Number.NaN]);
        const label = speedLabel(rate);
        const expected =
          rate === 1
            ? '1×'
            : rate === 0.5
              ? '½×'
              : rate === 0.25
                ? '¼×'
                : `${rate}×`;
        invariant(
          label === expected,
          'speed-label',
          step,
          () => `speedLabel(${rate}) = ${label}`,
        );
        invariant(
          label.endsWith('×') && forbiddenCopyIn(label) === null,
          'speed-label-copy',
          step,
          () => label,
        );
        entry.rate = rate;
        entry.label = label;
        break;
      }
      case 'lists': {
        Object.assign(entry, checkLists(fixture, rng, step));
        break;
      }
      case 'nonfinite': {
        const bad = rng.pick([
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
        ]);
        invariant(
          poseFrameAt(fixture.sequence, bad) === null,
          'pose-frame-nonfinite',
          step,
          () => `poseFrameAt(${bad}) returned a frame`,
        );
        invariant(
          nextAutoPause(stops, bad, duration, visited) === null,
          'auto-pause-nonfinite',
          step,
          () => `nextAutoPause(${bad}, …) fired`,
        );
        invariant(
          nextAutoPause(stops, 0, bad, visited) === null,
          'auto-pause-nonfinite',
          step,
          () => `nextAutoPause(…, ${bad}) fired`,
        );
        const current = currentStop(stops, bad);
        invariant(
          current?.id === refCurrentStop(stops, 0)?.id,
          'current-stop-nonfinite',
          step,
          () => `currentStop(${bad}) ${current?.id ?? 'null'}`,
        );
        const heat = jointHeatAt(script, bad);
        for (const [joint, value] of Object.entries(heat)) {
          const base = script.jointHeat[joint as ReviewJoint];
          invariant(
            isFinite(base) &&
              Math.abs((value as number) - 0.35 * clamp01(base)) < 1e-9,
            'heat-nonfinite-floor-only',
            step,
            () => `jointHeatAt(${bad}) ${joint}=${value} (static ${base})`,
          );
        }
        invariant(
          dominantSide(
            fixture.sequence,
            { startMs: bad, endMs: bad },
            fixture.analysis.handedness,
          ) === 'left' ||
            dominantSide(
              fixture.sequence,
              { startMs: bad, endMs: bad },
              fixture.analysis.handedness,
            ) === 'right',
          'dominant-nonfinite-window',
          step,
          () => 'dominantSide with a non-finite window produced a non-side',
        );
        const facing = facingSign(
          fixture.sequence,
          fixture.analysis,
          script.dominant,
        );
        invariant(
          facing === script.facing,
          'facing-stable',
          step,
          () => `facingSign re-read as ${facing} ≠ ${script.facing}`,
        );
        entry.bad = String(bad);
        entry.current = current?.id ?? null;
        break;
      }
      case 'rebuild': {
        const again = buildFormReviewScript(fixture.analysis, fixture.sequence);
        invariant(
          stableJson(again) === scriptJson,
          'script-deterministic',
          step,
          () => 'rebuilding the script from the same inputs changed it',
        );
        checkScript(again, fixture, step, tally);
        entry.identical = true;
        break;
      }
      default:
        break;
    }
    invariant(
      stableJson(fixture.analysis) === analysisBefore,
      'analysis-not-mutated',
      step,
      () => `${action} mutated the analysis`,
    );
    invariant(
      stableJson(fixture.sequence) === sequenceBefore,
      'sequence-not-mutated',
      step,
      () => `${action} mutated the pose sequence`,
    );
    trace.push(entry);
  }

  tallies.stops = stops.length;
  tallies.steps = trace.length;
  return { trace, length, tallies };
}

// ─── Campaign ───────────────────────────────────────────────────────────────

describe('seeded randomized long-run: form review replay model + geometry + drills', () => {
  it('holds every documented invariant after every step, deterministically', async () => {
    const result = await runCampaign({
      name: 'formReviewReplay.seeded',
      run: runSequence,
    });
    expect(result.executed).toBe(result.requested);
    expect(result.lengthMin).toBeGreaterThanOrEqual(5);
    expect(result.lengthMax).toBeLessThanOrEqual(60);
    expect(result.determinismMismatches).toBe(0);
    expect(result.failures).toEqual([]);
  });
});
