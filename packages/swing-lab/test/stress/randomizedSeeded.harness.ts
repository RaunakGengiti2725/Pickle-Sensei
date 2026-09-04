/**
 * Seeded randomized long-run stress harness for the @pickle/swing-lab public
 * API (lens: `randomized-seeded`).
 *
 * Every campaign is a generator of legal / near-legal ACTION SEQUENCES over a
 * public surface (length 5..60, one seed per sequence) plus an executor that
 * model-checks invariants after EVERY action. Generation is a pure function
 * of the seed, execution is a pure function of the action list, so:
 *
 *  - every iteration is replayable from `(campaign, seed)`;
 *  - a failing sequence can be MINIMIZED by deleting actions (the minimized
 *    case is `(campaign, seed, keptActionIndices)`);
 *  - determinism is checked by executing the same seed twice and comparing
 *    the serialized trace.
 *
 * The invariants are the ones documented in code comments / pinned by the
 * existing unit tests (sessionEngine.ts D-029/D-030, invariants.ts,
 * ballTracker.ts, paddleTracker.ts, playerTracker.ts, strokeHeuristicLite.ts,
 * coachGates.ts). Nothing here mutates production code or fixtures; all input
 * streams are seeded synthetic data (no labels are fabricated — the harness
 * never asserts a stroke label, only structural/honesty properties).
 *
 * No vitest import on purpose: the suite (randomizedSeeded.stress.test.ts)
 * and a CLI campaign run both drive this module.
 */

import { toLegacyPoseFrames, type PoseSequence } from "@pickle/swing-domain";
import { generateSwingSequence, type SwingTruth } from "@pickle/evaluation";
import {
  buildBallTracks,
  linkBallTimeline,
  selectPrimaryBallTrack,
  BALL_GATES2,
  type BallCandidate,
  type BallCandidateFile,
  type BallTrackCandidate,
  type BallTrackingOutcome,
} from "../../src/ballTracker.js";
import { pairwiseRankingAgreement, spearman } from "../../src/coachGates.js";
import { dominantWristSpeeds } from "../../src/detectSpanPlan.js";
import { checkArtifactInvariants } from "../../src/invariants.js";
import {
  buildPaddleTracks,
  mergePaddleTracklets,
  selectPrimaryPaddleTrack,
  wristSeries,
  TRACKER_GATES,
  type PaddleTrackCandidate,
  type RawPaddleDetectionFile,
  type TrackedPaddleObservation,
} from "../../src/paddleTracker.js";
import { segmentPhasesTemporalV2 } from "../../src/phaseTemporal.js";
import {
  buildPlayerTracks,
  initializeTargetFromSeed,
  otherPlayersWrists,
  selectTargetPlayer,
  targetPoseSequence,
  type PeopleFile,
  type PlayerTrack,
  type TargetSeed,
} from "../../src/playerTracker.js";
import {
  BOUND_STABILITY_MS,
  SessionEventEngine,
  type SessionEventState,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../../src/sessionEngine.js";
import {
  proposeStrokeEventsV2,
  selectTargetEventV2,
  type StrokeEventProposalV2,
} from "../../src/strokeEvents.js";
import { classifyStroke, STROKE_TAXONOMY_V3 } from "../../src/strokeHeuristic.js";

// ─── seeded RNG ──────────────────────────────────────────────────────────────

/** mulberry32 — small, fast, full 32-bit state; identical output per seed. */
export class Rand {
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
  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  float(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  gauss(): number {
    // Box–Muller; both uniforms strictly inside (0,1].
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** FNV-1a 32-bit over a string, hex. Used for trace fingerprints. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** JSON with NaN/±Infinity preserved as tagged strings (JSON.stringify would
 * silently turn them into null and hide exactly what we hunt for). */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) return `__nonfinite:${String(item)}`;
    if (item === undefined) return "__undefined";
    return item;
  });
}

/** Deep scan: every number reachable from `value` must be finite. Returns
 * the paths of offending numbers. */
export function nonFinitePaths(
  value: unknown,
  path = "$",
  out: string[] = [],
  depth = 0,
): string[] {
  if (depth > 40) return out;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(`${path}=${String(value)}`);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => nonFinitePaths(item, `${path}[${index}]`, out, depth + 1));
    return out;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      nonFinitePaths(item, `${path}.${key}`, out, depth + 1);
    }
  }
  return out;
}

// ─── campaign framework ──────────────────────────────────────────────────────

export const SEQUENCE_LENGTH = { min: 5, max: 60 } as const;

/**
 * Fraction of sequences that may inject NEAR-LEGAL input (NaN/Infinity
 * values, out-of-order timestamps). The remaining sequences are purely legal
 * so the bulk of the campaign checks the documented contract; the near-legal
 * share probes "survives caller bugs without emitting NaN/Infinity".
 */
export const NEAR_LEGAL_SEQUENCE_SHARE = 0.3;

/**
 * Input class of the state the violation was observed in:
 *  - "legal": every input so far was finite and time-ordered (the documented
 *    contract of the API) — a violation here is a BROKEN invariant;
 *  - "near_legal": the stream carried NaN/Infinity or out-of-order
 *    timestamps (caller bugs the unit is expected to survive without
 *    emitting NaN/Infinity) — reported as BROKEN_NEAR_LEGAL and gated by the
 *    STRESS_STRICT flag in the suite.
 */
export type InputClass = "legal" | "near_legal";

export interface StepViolation {
  step: number;
  action: string;
  rule: string;
  detail: string;
  inputClass: InputClass;
}

export interface ExecutionResult {
  /** Violations found across the whole sequence (empty = HELD). */
  violations: StepViolation[];
  /** Serialized per-step observation trace — identical for identical seeds. */
  trace: string;
  /** Free-form campaign metrics (counts) for the JSON table. */
  metrics: Record<string, number>;
}

export interface Campaign<A> {
  name: string;
  /** Seed for iteration i is `seedBase + i`; bases differ per campaign so a
   * seed alone identifies a row of the JSON table. */
  seedBase: number;
  generate(seed: number): A[];
  describe(action: A): string;
  execute(actions: readonly A[], seed: number): ExecutionResult;
}

export interface SequenceOutcome {
  campaign: string;
  seed: number;
  length: number;
  outcome: "HELD" | "BROKEN" | "BROKEN_NEAR_LEGAL";
  traceHash: string;
  /** Second run of the same seed produced the same trace. */
  deterministic: boolean;
  violations: StepViolation[];
  /** Present only when BROKEN: the minimized action subset (indices into the
   * generated sequence) and the first violation it still reproduces. */
  minimized?: { keptActionIndices: number[]; length: number; violation: StepViolation };
  metrics: Record<string, number>;
  durationMs: number;
}

export interface CampaignOptions {
  iterations: number;
  /** Seed for iteration i is `seedBase + i` (seedBase differs per campaign). */
  seedBase: number;
  /** Re-run each failing seed this many times to measure flake rate. */
  flakeReruns?: number;
  /** Max sequence executions spent minimizing one failing seed (default 64). */
  minimizeBudget?: number;
}

export interface CampaignReport {
  campaign: string;
  iterations: number;
  seedBase: number;
  held: number;
  /** Sequences with a violation under legal (finite, ordered) input. */
  broken: number;
  /** Sequences whose only violations occurred under near-legal input. */
  brokenNearLegal: number;
  nonDeterministic: number;
  /** Total actions executed (every action ran its invariant checks). */
  actionsExecuted: number;
  outcomes: SequenceOutcome[];
  /** failing seed → fraction of `flakeReruns` that failed (1 = deterministic failure). */
  flakeRates: Record<string, number>;
  /** Failing seeds whose first two runs produced identical traces AND
   * identical violations (the 10× rerun is then a formality, still done for
   * BROKEN; skipped for BROKEN_NEAR_LEGAL to keep large campaigns tractable). */
  replayIdenticalSeeds: number[];
  metricsTotal: Record<string, number>;
}

function addMetrics(total: Record<string, number>, metrics: Record<string, number>): void {
  for (const [key, value] of Object.entries(metrics)) total[key] = (total[key] ?? 0) + value;
}

/** Greedy delta-debugging over the action list: repeatedly try to drop
 * chunks (halving chunk size) while the sequence still violates. */
export function minimizeActions<A>(
  campaign: Campaign<A>,
  actions: readonly A[],
  seed: number,
  inputClass: InputClass,
  budget = 64,
): { keptActionIndices: number[]; violation: StepViolation } {
  let kept = actions.map((_action, index) => index);
  let spent = 0;
  const fails = (indices: number[]): StepViolation | null => {
    if (spent >= budget) return null;
    spent += 1;
    const subset = indices.map((index) => actions[index]!);
    const result = campaign.execute(subset, seed);
    // Minimize toward the class being reported: a legal-input failure must
    // not be "minimized" into a NaN-injection repro.
    return (
      result.violations.find(
        (violation) => inputClass === "near_legal" || violation.inputClass === "legal",
      ) ?? null
    );
  };
  let violation = fails(kept);
  if (!violation)
    return {
      keptActionIndices: kept,
      violation: { step: -1, action: "", rule: "", detail: "", inputClass },
    };
  let progressed = true;
  // Prefix truncation first: keep only actions up to the first violation.
  const prefix = kept.slice(0, violation.step + 1);
  const prefixViolation = fails(prefix);
  if (prefixViolation) {
    kept = prefix;
    violation = prefixViolation;
  }
  let chunk = Math.max(1, Math.floor(kept.length / 2));
  while (chunk >= 1 && spent < budget) {
    progressed = false;
    for (let start = 0; start < kept.length; start += chunk) {
      const candidate = [...kept.slice(0, start), ...kept.slice(start + chunk)];
      if (candidate.length === 0) continue;
      const candidateViolation = fails(candidate);
      if (candidateViolation) {
        kept = candidate;
        violation = candidateViolation;
        progressed = true;
        start -= chunk;
      }
    }
    if (!progressed) chunk = Math.floor(chunk / 2);
  }
  return { keptActionIndices: kept, violation };
}

export function runCampaign<A>(campaign: Campaign<A>, options: CampaignOptions): CampaignReport {
  const outcomes: SequenceOutcome[] = [];
  const flakeRates: Record<string, number> = {};
  const replayIdenticalSeeds: number[] = [];
  const metricsTotal: Record<string, number> = {};
  let held = 0;
  let broken = 0;
  let brokenNearLegal = 0;
  let nonDeterministic = 0;
  let actionsExecuted = 0;
  for (let i = 0; i < options.iterations; i += 1) {
    const seed = (options.seedBase + i) >>> 0;
    const startedAt = performance.now();
    const actions = campaign.generate(seed);
    const first = campaign.execute(actions, seed);
    const second = campaign.execute(campaign.generate(seed), seed);
    const deterministic = first.trace === second.trace;
    actionsExecuted += actions.length;
    const violations = [...first.violations];
    if (!deterministic) {
      nonDeterministic += 1;
      violations.push({
        step: -1,
        action: "replay",
        rule: "non_deterministic_trace",
        detail: `trace hash ${fnv1a(first.trace)} vs ${fnv1a(second.trace)}`,
        inputClass: "legal",
      });
    }
    const outcomeClass: SequenceOutcome["outcome"] =
      violations.length === 0
        ? "HELD"
        : violations.some((violation) => violation.inputClass === "legal")
          ? "BROKEN"
          : "BROKEN_NEAR_LEGAL";
    const outcome: SequenceOutcome = {
      campaign: campaign.name,
      seed,
      length: actions.length,
      outcome: outcomeClass,
      traceHash: fnv1a(first.trace),
      deterministic,
      violations,
      metrics: first.metrics,
      durationMs: 0,
    };
    addMetrics(metricsTotal, first.metrics);
    if (outcome.outcome !== "HELD") {
      if (outcome.outcome === "BROKEN") broken += 1;
      else brokenNearLegal += 1;
      if (first.violations.length > 0) {
        const minimized = minimizeActions(
          campaign,
          actions,
          seed,
          outcome.outcome === "BROKEN" ? "legal" : "near_legal",
          options.minimizeBudget,
        );
        outcome.minimized = {
          keptActionIndices: minimized.keptActionIndices,
          length: minimized.keptActionIndices.length,
          violation: minimized.violation,
        };
      }
      const replayIdentical =
        deterministic && stableJson(first.violations) === stableJson(second.violations);
      if (replayIdentical) replayIdenticalSeeds.push(seed);
      if (outcome.outcome === "BROKEN" || !replayIdentical) {
        const reruns = options.flakeReruns ?? 10;
        let failed = 0;
        for (let r = 0; r < reruns; r += 1) {
          const rerun = campaign.execute(campaign.generate(seed), seed);
          if (rerun.violations.length > 0 || rerun.trace !== first.trace) failed += 1;
        }
        flakeRates[String(seed)] = reruns === 0 ? 1 : failed / reruns;
      }
    } else {
      held += 1;
    }
    outcome.durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    outcomes.push(outcome);
  }
  return {
    campaign: campaign.name,
    iterations: options.iterations,
    seedBase: options.seedBase,
    held,
    broken,
    brokenNearLegal,
    nonDeterministic,
    actionsExecuted,
    outcomes,
    flakeRates,
    replayIdenticalSeeds,
    metricsTotal,
  };
}

/** Replay a single (campaign, seed[, keptActionIndices]) — the repro entry point. */
export function replay<A>(
  campaign: Campaign<A>,
  seed: number,
  keptActionIndices?: readonly number[],
): ExecutionResult & { actions: string[] } {
  const all = campaign.generate(seed);
  const actions = keptActionIndices ? keptActionIndices.map((index) => all[index]!) : all;
  const result = campaign.execute(actions, seed);
  return { ...result, actions: actions.map((action) => campaign.describe(action)) };
}

// ─── shared synthetic signal helpers ─────────────────────────────────────────

interface StrokeBump {
  peakMs: number;
  height: number;
  halfWidthMs: number;
}

/** Idle baseline + gaussian bumps + optional white noise, like the unit
 * tests' `speedBumps` but seeded. */
function speedAt(t: number, bumps: readonly StrokeBump[], baseline: number): number {
  let value = baseline;
  for (const bump of bumps) {
    value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
  }
  return value;
}

function randomSwingTruth(rand: Rand): Partial<SwingTruth> {
  return {
    torsoLength: rand.float(0.12, 0.3),
    stanceWidthRatio: rand.float(1.0, 1.8),
    kneeFlexionDeg: rand.float(10, 50),
    contactForwardNorm: rand.float(0.1, 0.8),
    contactHeightRatio: rand.float(0.2, 0.9),
    backswingLengthNorm: rand.float(0.3, 1.2),
    swingDipNorm: rand.float(0, 0.3),
    shoulderTurnDeg: rand.float(10, 80),
    handed: rand.pick(["right", "left"] as const),
    fps: rand.pick([30, 60]),
    readyMs: rand.int(200, 700),
    backswingMs: rand.int(250, 800),
    accelerateMs: rand.int(120, 400),
    followMs: rand.int(150, 500),
    recoverMs: rand.int(300, 800),
  };
}

function landmark(sequence: PoseSequence, frameIndex: number, name: string) {
  return sequence.frames[frameIndex]?.landmarks.find((mark) => mark.name === name) ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Campaign 1 — SessionEventEngine action sequences (stateful, the core lens)
// ═══════════════════════════════════════════════════════════════════════════

export type SessionAction =
  | { kind: "push"; wrist: SpeedSample[]; paddle: SpeedSample[] | null }
  | { kind: "pushWristSample"; sample: SpeedSample }
  | { kind: "flush" }
  | { kind: "activeProposal" }
  | { kind: "snapshot" }
  | { kind: "eventState"; eventPick: number }
  | {
      kind: "markEvent";
      eventPick: number;
      state: SessionEventState;
      withAnalysis: boolean;
      abstainReason: string | null;
      /** When true the id is unknown on purpose ("E999"). */
      unknownId: boolean;
    };

const CLOSE_REASONS = new Set([
  "settle",
  "next_stroke_valley",
  "safety_max",
  "next_event_proposed",
  "flush",
]);
const EVENT_STATES = new Set<SessionEventState>(["pending", "processing", "ready", "abstained"]);

interface SessionGenPlan {
  /** Clean plan: strictly monotone timestamps, finite values, no mutations. */
  clean: boolean;
  bumps: StrokeBump[];
  baseline: number;
  noise: number;
  stepMs: number;
}

function planSession(rand: Rand): SessionGenPlan {
  const clean = rand.chance(0.35);
  const strokeCount = rand.int(0, 8);
  const bumps: StrokeBump[] = [];
  let t = rand.int(400, 1500);
  for (let i = 0; i < strokeCount; i += 1) {
    bumps.push({
      peakMs: t,
      height: rand.chance(0.2) ? rand.float(0.2, 0.6) : rand.float(0.6, 4.5),
      halfWidthMs: rand.int(40, 220),
    });
    t += rand.int(500, 3200);
  }
  return {
    clean,
    bumps,
    baseline: rand.float(0.03, 0.15),
    noise: clean ? rand.float(0, 0.02) : rand.float(0, 0.12),
    stepMs: rand.pick([16.6667, 33.3333, 40, rand.float(10, 120)]),
  };
}

export const sessionEngineCampaign: Campaign<SessionAction> = {
  name: "session_engine",
  seedBase: 100_000,
  generate(seed) {
    const rand = new Rand(seed);
    const plan = planSession(rand);
    const length = rand.int(SEQUENCE_LENGTH.min, SEQUENCE_LENGTH.max);
    const actions: SessionAction[] = [];
    let clock = 0;
    const nextSample = (): SpeedSample => {
      clock += plan.stepMs;
      const noisy = speedAt(clock, plan.bumps, plan.baseline) + plan.noise * rand.gauss();
      return { timestampMs: clock, value: Math.max(0, noisy) };
    };
    const mutate = (sample: SpeedSample): SpeedSample => {
      if (plan.clean || !rand.chance(0.08)) return sample;
      switch (rand.int(0, 8)) {
        case 0:
          return { timestampMs: Number.NaN, value: sample.value };
        case 1:
          return { timestampMs: sample.timestampMs, value: Number.NaN };
        case 2:
          return { timestampMs: Number.POSITIVE_INFINITY, value: sample.value };
        case 3:
          return { timestampMs: sample.timestampMs, value: Number.NEGATIVE_INFINITY };
        case 4: // late / out-of-order sample
          return { timestampMs: sample.timestampMs - rand.float(1, 4000), value: sample.value };
        case 5: // duplicate timestamp
          return { timestampMs: sample.timestampMs - plan.stepMs, value: sample.value };
        case 6: // negative speed (illegal but must not poison)
          return { timestampMs: sample.timestampMs, value: -sample.value };
        case 7: // absurd spike
          return { timestampMs: sample.timestampMs, value: sample.value + rand.float(50, 1e6) };
        default: // huge time jump forward
          clock += rand.float(3000, 20000);
          return { timestampMs: clock, value: sample.value };
      }
    };
    for (let i = 0; i < length; i += 1) {
      const roll = rand.next();
      if (roll < 0.5) {
        const n = rand.chance(0.1) ? 0 : rand.int(1, 40);
        const wrist: SpeedSample[] = [];
        for (let k = 0; k < n; k += 1) wrist.push(mutate(nextSample()));
        const paddle: SpeedSample[] | null = rand.chance(0.35)
          ? wrist.map((sample) =>
              mutate({
                timestampMs: sample.timestampMs + rand.float(-10, 10),
                value: Math.max(0, sample.value * rand.float(0.8, 1.4) + rand.float(-0.05, 0.05)),
              }),
            )
          : null;
        actions.push({ kind: "push", wrist, paddle });
      } else if (roll < 0.65) {
        actions.push({ kind: "pushWristSample", sample: mutate(nextSample()) });
      } else if (roll < 0.72) {
        actions.push({ kind: "flush" });
      } else if (roll < 0.8) {
        actions.push({ kind: "activeProposal" });
      } else if (roll < 0.87) {
        actions.push({ kind: "snapshot" });
      } else if (roll < 0.91) {
        actions.push({ kind: "eventState", eventPick: rand.int(0, 1_000_000) });
      } else {
        const state = rand.pick([...EVENT_STATES]);
        actions.push({
          kind: "markEvent",
          eventPick: rand.int(0, 1_000_000),
          state,
          withAnalysis: state === "ready" ? rand.chance(0.7) : rand.chance(0.1),
          abstainReason: state === "abstained" ? `STRESS_ABSTAIN seed=${seed} step=${i}` : null,
          unknownId: rand.chance(0.05),
        });
      }
    }
    return actions;
  },
  describe(action) {
    switch (action.kind) {
      case "push":
        return `push(wrist=${action.wrist.length}, paddle=${action.paddle ? action.paddle.length : "null"})`;
      case "pushWristSample":
        return `pushWristSample(${action.sample.timestampMs}, ${action.sample.value})`;
      case "markEvent":
        return `markEvent(pick=${action.eventPick}, ${action.state}, analysis=${action.withAnalysis}, unknownId=${action.unknownId})`;
      case "eventState":
        return `eventState(pick=${action.eventPick})`;
      default:
        return action.kind;
    }
  },
  execute(actions, seed) {
    const engine = new SessionEventEngine({
      sessionId: `stress-${seed}`,
      target: { trackId: 1, seedMode: "auto_single_player", confidence: 0.8 },
      captureMeta: { source: "live", fps: 30 },
    });
    const violations: StepViolation[] = [];
    const trace: unknown[] = [];
    const metrics: Record<string, number> = {
      events: 0,
      flushEvents: 0,
      droppedLate: 0,
      overlappingBounds: 0,
      expectedThrows: 0,
      markEventsApplied: 0,
      notes: 0,
      closedBeforeBoundStability: 0,
    };
    // ── reference model ────────────────────────────────────────────────────
    const model = {
      finiteWrist: 0,
      finitePaddle: 0,
      dropped: 0,
      lastAcceptedMs: null as number | null,
      frontier: Number.NEGATIVE_INFINITY,
      states: new Map<string, SessionEventState>(),
      analysis: new Map<string, unknown>(),
      abstain: new Map<string, string | null>(),
    };
    let known: SessionStrokeEvent[] = [];
    const record = (step: number, action: SessionAction, rule: string, detail: string) => {
      violations.push({
        step,
        action: sessionEngineCampaign.describe(action),
        rule,
        detail,
        inputClass: "legal",
      });
    };
    const analysisRecord = {
      analysisId: "stress-analysis",
      version: "stress-v1",
      overallScore: 0,
    } as unknown as NonNullable<SessionStrokeEvent["analysis"]>;

    const checkEvents = (step: number, action: SessionAction, returned: SessionStrokeEvent[]) => {
      const snapshot = engine.snapshot();
      const events = snapshot.events;
      // Emitted proposals are frozen (the snapshot holds copies, so check the
      // engine-owned objects handed to the caller).
      for (const event of returned) {
        if (!Object.isFrozen(event.proposal))
          record(step, action, "proposal_not_frozen", event.eventId);
      }
      // I1 return value == appended delta
      const delta = events.slice(known.length);
      if (
        stableJson(delta.map((event) => ({ ...event, proposal: { ...event.proposal } }))) !==
        stableJson(returned.map((event) => ({ ...event, proposal: { ...event.proposal } })))
      ) {
        record(
          step,
          action,
          "returned_events_not_snapshot_delta",
          `returned=${returned.length} delta=${delta.length}`,
        );
      }
      // I2 ids sequential
      events.forEach((event, index) => {
        if (event.eventId !== `E${index + 1}`) {
          record(step, action, "event_id_not_sequential", `${event.eventId} at index ${index}`);
        }
      });
      // I5 append-only: previously seen events unchanged apart from lifecycle fields
      known.forEach((previous, index) => {
        const current = events[index];
        if (!current) {
          record(step, action, "event_removed", previous.eventId);
          return;
        }
        if (
          stableJson(previous.proposal) !== stableJson(current.proposal) ||
          previous.closedAtMs !== current.closedAtMs ||
          previous.closeReason !== current.closeReason
        ) {
          record(step, action, "closed_event_rewritten", previous.eventId);
        }
        if (current.state !== model.states.get(current.eventId)) {
          record(
            step,
            action,
            "lifecycle_state_mismatch",
            `${current.eventId} ${current.state} vs model ${model.states.get(current.eventId)}`,
          );
        }
      });
      // I3/I4 per-event structural invariants
      let frontier = Number.NEGATIVE_INFINITY;
      let lastClosedAt = Number.NEGATIVE_INFINITY;
      events.forEach((event, index) => {
        const p = event.proposal;
        const bad = nonFinitePaths({ p, closedAtMs: event.closedAtMs });
        if (bad.length > 0)
          record(step, action, "non_finite_event_field", `${event.eventId}: ${bad.join(",")}`);
        if (!(p.startMs <= p.peakMs && p.peakMs <= p.endMs)) {
          record(
            step,
            action,
            "proposal_bounds_disordered",
            `${event.eventId} ${p.startMs}/${p.peakMs}/${p.endMs}`,
          );
        }
        if (p.confidence < 0 || p.confidence > 1)
          record(step, action, "confidence_out_of_unit", `${event.eventId} ${p.confidence}`);
        if (p.paddleSupport < 0 || p.paddleSupport > 1)
          record(step, action, "paddle_support_out_of_unit", `${event.eventId} ${p.paddleSupport}`);
        if (p.peakSpeed < 0)
          record(step, action, "negative_peak_speed", `${event.eventId} ${p.peakSpeed}`);
        if (!CLOSE_REASONS.has(event.closeReason))
          record(step, action, "unknown_close_reason", event.closeReason);
        if (!EVENT_STATES.has(event.state))
          record(step, action, "unknown_event_state", event.state);
        if (index >= known.length) {
          // newly emitted: peak must lie strictly past the frontier of earlier events
          if (!(p.peakMs > frontier)) {
            record(
              step,
              action,
              "peak_not_past_frontier",
              `${event.eventId} peak=${p.peakMs} frontier=${frontier}`,
            );
          }
          if (event.closedAtMs < p.peakMs) {
            record(
              step,
              action,
              "closed_before_peak",
              `${event.eventId} closedAt=${event.closedAtMs} peak=${p.peakMs}`,
            );
          }
          // Settle/valley closures normally wait for the ±BOUND_STABILITY_MS
          // reach cap; flush and a newer proposal legitimately close earlier
          // (D-029 "condition already held"), so this is a metric, not a rule.
          if (event.closedAtMs < p.peakMs + BOUND_STABILITY_MS)
            metrics.closedBeforeBoundStability! += 1;
          if (
            event.state !== "pending" ||
            event.analysis !== null ||
            event.abstainReason !== null
          ) {
            record(step, action, "new_event_not_pending", event.eventId);
          }
          model.states.set(event.eventId, "pending");
          if (event.closeReason === "flush") metrics.flushEvents! += 1;
          if (index > 0 && p.startMs < events[index - 1]!.proposal.endMs)
            metrics.overlappingBounds! += 1;
        }
        if (event.closedAtMs < lastClosedAt)
          record(step, action, "closed_at_not_monotone", `${event.eventId}`);
        lastClosedAt = Math.max(lastClosedAt, event.closedAtMs);
        frontier = Math.max(frontier, p.endMs);
      });
      model.frontier = frontier;
      // I6 quality-state counters vs model
      const q = snapshot.qualityState;
      if (q.wristSamples !== model.finiteWrist)
        record(
          step,
          action,
          "wrist_sample_count_mismatch",
          `${q.wristSamples} vs ${model.finiteWrist}`,
        );
      if (q.paddleSamples !== model.finitePaddle)
        record(
          step,
          action,
          "paddle_sample_count_mismatch",
          `${q.paddleSamples} vs ${model.finitePaddle}`,
        );
      if (q.droppedLateSamples !== model.dropped)
        record(
          step,
          action,
          "dropped_late_count_mismatch",
          `${q.droppedLateSamples} vs ${model.dropped}`,
        );
      if (q.lastSampleMs !== model.lastAcceptedMs)
        record(
          step,
          action,
          "last_sample_ms_mismatch",
          `${q.lastSampleMs} vs ${model.lastAcceptedMs}`,
        );
      // I7 artifact invariants + finite scan over the whole snapshot
      const artifact = checkArtifactInvariants(snapshot);
      if (artifact.length > 0)
        record(
          step,
          action,
          "artifact_invariant",
          artifact.map((v) => `${v.rule}@${v.path}`).join(";"),
        );
      const nonFinite = nonFinitePaths(snapshot);
      if (nonFinite.length > 0) record(step, action, "non_finite_in_snapshot", nonFinite.join(","));
      metrics.events = events.length;
      metrics.droppedLate = q.droppedLateSamples;
      metrics.notes = q.notes.length;
      known = events;
      trace.push({
        n: events.length,
        ids: returned.map((event) => event.eventId),
        bounds: returned.map((event) => [
          event.proposal.startMs,
          event.proposal.peakMs,
          event.proposal.endMs,
          event.closeReason,
        ]),
        q: [q.wristSamples, q.paddleSamples, q.droppedLateSamples, q.lastSampleMs],
        notes: q.notes.length,
      });
    };

    const ingest = (wrist: readonly SpeedSample[], paddle: readonly SpeedSample[] | null) => {
      for (const sample of paddle ?? []) {
        if (Number.isFinite(sample.timestampMs) && Number.isFinite(sample.value))
          model.finitePaddle += 1;
      }
      const frontierBefore = model.frontier;
      for (const sample of wrist) {
        if (!Number.isFinite(sample.timestampMs) || !Number.isFinite(sample.value)) continue;
        model.finiteWrist += 1;
        if (sample.timestampMs <= frontierBefore) {
          model.dropped += 1;
          continue;
        }
        model.lastAcceptedMs = Math.max(
          model.lastAcceptedMs ?? Number.NEGATIVE_INFINITY,
          sample.timestampMs,
        );
      }
    };

    actions.forEach((action, step) => {
      try {
        switch (action.kind) {
          case "push": {
            ingest(action.wrist, action.paddle);
            const returned = engine.push({
              wrist: action.wrist,
              ...(action.paddle ? { paddle: action.paddle } : {}),
            });
            checkEvents(step, action, returned);
            break;
          }
          case "pushWristSample": {
            ingest([action.sample], null);
            checkEvents(step, action, engine.pushWristSample(action.sample));
            break;
          }
          case "flush": {
            const returned = engine.flush();
            checkEvents(step, action, returned);
            // flush is idempotent without new samples
            const again = engine.flush();
            if (again.length > 0)
              record(step, action, "flush_not_idempotent", `second flush emitted ${again.length}`);
            checkEvents(step, action, again);
            if (engine.activeProposal() !== null)
              record(step, action, "active_proposal_after_flush", "flush left an open candidate");
            break;
          }
          case "activeProposal": {
            const open = engine.activeProposal();
            if (open) {
              const bad = nonFinitePaths(open);
              if (bad.length > 0) record(step, action, "non_finite_active_proposal", bad.join(","));
              if (!(open.startMs <= open.peakMs && open.peakMs <= open.endMs))
                record(
                  step,
                  action,
                  "active_proposal_bounds_disordered",
                  `${open.startMs}/${open.peakMs}/${open.endMs}`,
                );
              if (!(open.peakMs > model.frontier))
                record(
                  step,
                  action,
                  "active_proposal_behind_frontier",
                  `peak=${open.peakMs} frontier=${model.frontier}`,
                );
              if (
                known.some(
                  (event) =>
                    event.proposal.peakMs === open.peakMs && event.proposal.endMs === open.endMs,
                )
              ) {
                record(step, action, "active_proposal_is_emitted_event", `peak=${open.peakMs}`);
              }
            }
            // read-only: no emission, no state change
            checkEvents(step, action, []);
            trace.push({ open: open ? [open.startMs, open.peakMs, open.endMs] : null });
            break;
          }
          case "snapshot": {
            const first = engine.snapshot();
            // Mutating the snapshot must not leak into the engine.
            first.qualityState.notes.push("MUTATED");
            first.events.forEach((event) => {
              event.state = "ready";
              (event as { closedAtMs: number }).closedAtMs = -1;
            });
            const second = engine.snapshot();
            if (second.qualityState.notes.includes("MUTATED"))
              record(step, action, "snapshot_notes_alias_engine", "notes array shared");
            if (second.events.some((event) => event.closedAtMs === -1))
              record(step, action, "snapshot_events_alias_engine", "event object shared");
            checkEvents(step, action, []);
            break;
          }
          case "eventState": {
            const id = known.length > 0 ? known[action.eventPick % known.length]!.eventId : "E1";
            const state = engine.eventState(id);
            const expected = model.states.get(id) ?? null;
            if (state !== expected)
              record(step, action, "event_state_lookup_mismatch", `${id}: ${state} vs ${expected}`);
            checkEvents(step, action, []);
            break;
          }
          case "markEvent": {
            const id =
              action.unknownId || known.length === 0
                ? "E999"
                : known[action.eventPick % known.length]!.eventId;
            const current = model.states.get(id);
            let expectThrow: string | null = null;
            if (current === undefined) expectThrow = "unknown";
            else if (current === "ready" || current === "abstained") expectThrow = "terminal";
            else if (action.state === "pending" && current !== "processing") expectThrow = "revert";
            else if (action.state === "ready" && !action.withAnalysis)
              expectThrow = "ready_without_analysis";
            let threw: string | null = null;
            let result: SessionStrokeEvent | null = null;
            try {
              result = engine.markEvent(id, action.state, {
                analysis: action.withAnalysis ? analysisRecord : null,
                abstainReason: action.abstainReason,
              });
            } catch (error) {
              threw = error instanceof Error ? error.message : String(error);
            }
            if (expectThrow && !threw)
              record(
                step,
                action,
                "illegal_transition_accepted",
                `${id} ${current}→${action.state} (${expectThrow})`,
              );
            if (!expectThrow && threw)
              record(
                step,
                action,
                "legal_transition_rejected",
                `${id} ${current}→${action.state}: ${threw}`,
              );
            if (expectThrow && threw) metrics.expectedThrows! += 1;
            if (!expectThrow && !threw && result) {
              metrics.markEventsApplied! += 1;
              model.states.set(id, action.state);
              if (result.state !== action.state)
                record(step, action, "mark_event_state_not_applied", `${id} ${result.state}`);
              if (action.state === "ready" && result.analysis === null)
                record(step, action, "ready_without_analysis_record", id);
              if (action.state === "abstained" && result.abstainReason !== action.abstainReason)
                record(step, action, "abstain_reason_dropped", id);
            }
            if (expectThrow && threw) {
              // model unchanged: the engine must not have applied anything
              if (engine.eventState(id) !== (current ?? null))
                record(step, action, "state_changed_despite_throw", id);
            }
            checkEvents(step, action, []);
            trace.push({ mark: id, threw: threw !== null });
            break;
          }
        }
      } catch (error) {
        record(
          step,
          action,
          "unexpected_throw",
          error instanceof Error ? `${error.message}` : String(error),
        );
      }
    });
    return { violations, trace: stableJson(trace), metrics };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Campaign 2 — batching equivalence on clean monotone streams
//   "Feed incremental samples (any batch size ≥ 1)" — sessionEngine.ts push()
//   docstring, pinned by the chunk-7 unit test. Random chunk sizes here.
// ═══════════════════════════════════════════════════════════════════════════

export interface BatchingAction {
  kind: "chunk";
  size: number;
}

export const sessionBatchingCampaign: Campaign<BatchingAction> = {
  name: "session_batching",
  seedBase: 200_000,
  generate(seed) {
    const rand = new Rand(seed);
    const length = rand.int(SEQUENCE_LENGTH.min, SEQUENCE_LENGTH.max);
    const actions: BatchingAction[] = [];
    for (let i = 0; i < length; i += 1) actions.push({ kind: "chunk", size: rand.int(1, 30) });
    return actions;
  },
  describe(action) {
    return `chunk(${action.size})`;
  },
  execute(actions, seed) {
    // Series derives from the seed only (a second Rand stream, so the chunk
    // plan and the series are independent and minimization keeps the series).
    const rand = new Rand(seed ^ 0x9e3779b9);
    const plan = planSession(rand);
    const totalSamples = actions.reduce((sum, action) => sum + action.size, 0);
    const series: SpeedSample[] = [];
    for (let i = 0; i < totalSamples; i += 1) {
      const t = (i + 1) * plan.stepMs;
      series.push({
        timestampMs: t,
        value: Math.max(0, speedAt(t, plan.bumps, plan.baseline) + plan.noise * rand.gauss()),
      });
    }
    const shape = (events: readonly SessionStrokeEvent[]) =>
      events.map((event) => [
        event.proposal.startMs,
        event.proposal.peakMs,
        event.proposal.endMs,
        event.closeReason,
      ]);
    const violations: StepViolation[] = [];
    const perSample = new SessionEventEngine({ sessionId: `batch-a-${seed}` });
    const chunked = new SessionEventEngine({ sessionId: `batch-b-${seed}` });
    const emittedPerSample: SessionStrokeEvent[] = [];
    const emittedChunked: SessionStrokeEvent[] = [];
    let cursor = 0;
    const trace: unknown[] = [];
    actions.forEach((action, step) => {
      const slice = series.slice(cursor, cursor + action.size);
      cursor += action.size;
      for (const sample of slice) emittedPerSample.push(...perSample.pushWristSample(sample));
      emittedChunked.push(...chunked.push({ wrist: slice }));
      // After every chunk both engines have seen the same samples: emitted
      // prefixes must agree on every event both have emitted so far.
      const common = Math.min(emittedPerSample.length, emittedChunked.length);
      const a = stableJson(shape(emittedPerSample.slice(0, common)));
      const b = stableJson(shape(emittedChunked.slice(0, common)));
      if (a !== b) {
        violations.push({
          step,
          action: `chunk(${action.size})`,
          rule: "batching_changes_emitted_events",
          detail: `perSample=${a} chunked=${b}`,
          inputClass: "legal",
        });
      }
      trace.push([emittedPerSample.length, emittedChunked.length]);
    });
    const finalA = [...emittedPerSample, ...perSample.flush()];
    const finalB = [...emittedChunked, ...chunked.flush()];
    if (stableJson(shape(finalA)) !== stableJson(shape(finalB))) {
      violations.push({
        step: actions.length,
        action: "flush",
        rule: "batching_changes_final_events",
        detail: `perSample=${stableJson(shape(finalA))} chunked=${stableJson(shape(finalB))}`,
        inputClass: "legal",
      });
    }
    // Acausal (whole-series) run for the record: divergence here is the
    // DOCUMENTED causal-vs-acausal effect (retro-suppression), a metric only.
    const whole = new SessionEventEngine({ sessionId: `batch-c-${seed}` });
    const wholeEvents = [...whole.push({ wrist: series }), ...whole.flush()];
    const acausalDiverges = stableJson(shape(wholeEvents)) !== stableJson(shape(finalA)) ? 1 : 0;
    trace.push(shape(finalA), shape(wholeEvents));
    return {
      violations,
      trace: stableJson(trace),
      metrics: {
        events: finalA.length,
        acausalDiverges,
        samples: series.length,
        strokesPlanned: plan.bumps.length,
      },
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Campaign 3 — stroke pipeline on perturbed synthetic swings
//   proposeStrokeEventsV2 → selectTargetEventV2 → segmentPhasesTemporalV2 →
//   classifyStroke, re-run after every perturbation of the pose sequence.
// ═══════════════════════════════════════════════════════════════════════════

export type StrokeAction =
  | { kind: "dropFrame"; at: number }
  | { kind: "dupFrame"; at: number }
  | { kind: "jitter"; sigma: number }
  | { kind: "nanJoint"; at: number; joint: number }
  | { kind: "zeroVisibility"; at: number }
  | { kind: "shiftTime"; deltaMs: number }
  | { kind: "scaleCoords"; factor: number }
  | { kind: "setContact"; mode: "null" | "peak" | "inside" | "outside" | "nan" }
  | { kind: "togglePaddle"; on: boolean; offset: number }
  | { kind: "truncateTail"; frames: number }
  | { kind: "reverseFrameOrder" }
  | { kind: "handedness"; value: "right" | "left" | "ambidextrous" };

export const strokePipelineCampaign: Campaign<StrokeAction> = {
  name: "stroke_pipeline",
  seedBase: 300_000,
  generate(seed) {
    const rand = new Rand(seed);
    const length = rand.int(SEQUENCE_LENGTH.min, SEQUENCE_LENGTH.max);
    const nearLegal = rand.chance(NEAR_LEGAL_SEQUENCE_SHARE);
    const actions: StrokeAction[] = [];
    for (let i = 0; i < length; i += 1) {
      const kind = rand.int(0, 11);
      switch (kind) {
        case 0:
          actions.push({ kind: "dropFrame", at: rand.int(0, 1_000_000) });
          break;
        case 1:
          actions.push({ kind: "dupFrame", at: rand.int(0, 1_000_000) });
          break;
        case 2:
          actions.push({ kind: "jitter", sigma: rand.float(0, 0.02) });
          break;
        case 3: {
          const at = rand.int(0, 1_000_000);
          const joint = rand.int(0, 1_000_000);
          if (nearLegal) actions.push({ kind: "nanJoint", at, joint });
          else actions.push({ kind: "zeroVisibility", at });
          break;
        }
        case 4:
          actions.push({ kind: "zeroVisibility", at: rand.int(0, 1_000_000) });
          break;
        case 5:
          actions.push({ kind: "shiftTime", deltaMs: rand.float(-500, 5000) });
          break;
        case 6:
          actions.push({ kind: "scaleCoords", factor: rand.float(0.5, 1.5) });
          break;
        case 7: {
          const mode = rand.pick(["null", "peak", "inside", "outside", "nan"] as const);
          actions.push({ kind: "setContact", mode: mode === "nan" && !nearLegal ? "null" : mode });
          break;
        }
        case 8:
          actions.push({
            kind: "togglePaddle",
            on: rand.chance(0.6),
            offset: rand.float(0.02, 0.15),
          });
          break;
        case 9:
          actions.push({ kind: "truncateTail", frames: rand.int(1, 6) });
          break;
        case 10:
          actions.push({
            kind: "handedness",
            value: rand.pick(["right", "left", "ambidextrous"] as const),
          });
          break;
        default:
          if (nearLegal) actions.push({ kind: "reverseFrameOrder" });
          else actions.push({ kind: "jitter", sigma: rand.float(0, 0.01) });
      }
    }
    return actions;
  },
  describe(action) {
    return stableJson(action);
  },
  execute(actions, seed) {
    const rand = new Rand(seed ^ 0x5bd1e995);
    const truth = randomSwingTruth(rand);
    const base = generateSwingSequence(truth);
    const sequence: PoseSequence = JSON.parse(JSON.stringify(base.sequence)) as PoseSequence;
    let window = { ...base.window };
    let contactMs: number | null = base.window.peakMs;
    let paddleOffset: number | null = null;
    let handedness: "right" | "left" | "ambidextrous" = truth.handed ?? "right";
    const violations: StepViolation[] = [];
    const trace: unknown[] = [];
    const metrics: Record<string, number> = {
      unknownPredictions: 0,
      leafPredictions: 0,
      segmented: 0,
      abstainedPhases: 0,
      proposalsTotal: 0,
      selected: 0,
      noneSelected: 0,
      pipelineThrows: 0,
    };
    // Rules are tagged with the input class so the table separates "finite
    // legal input" from "near-legal input carrying NaN/Infinity".
    const tainted = () =>
      sequence.frames.some((frame) =>
        frame.landmarks.some((mark) => !Number.isFinite(mark.x) || !Number.isFinite(mark.y)),
      ) ||
      sequence.frames.some(
        (frame, index) => index > 0 && frame.timestampMs < sequence.frames[index - 1]!.timestampMs,
      ) ||
      (contactMs !== null && !Number.isFinite(contactMs));
    const record = (step: number, action: StrokeAction, rule: string, detail: string) =>
      violations.push({
        step,
        action: stableJson(action),
        rule,
        detail,
        inputClass: tainted() ? "near_legal" : "legal",
      });

    const runPipeline = (step: number, action: StrokeAction) => {
      const frames = sequence.frames;
      if (frames.length === 0) return;
      const clipStartMs = Math.min(...frames.map((frame) => frame.timestampMs));
      const clipEndMs = Math.max(...frames.map((frame) => frame.timestampMs));
      const wristSpeeds = dominantWristSpeeds(sequence, { startMs: clipStartMs, endMs: clipEndMs });
      const legacy = toLegacyPoseFrames(sequence);
      const paddle =
        paddleOffset === null
          ? null
          : legacy.map((frame) => {
              const wrist = frame.landmarks.find(
                (mark) => mark.name === `${handedness === "left" ? "left" : "right"}_wrist`,
              );
              return {
                timestampMs: frame.timestampMs,
                center: {
                  x: (wrist?.x ?? 0.5) + paddleOffset!,
                  y: (wrist?.y ?? 0.5) - paddleOffset!,
                },
                confidence: 0.7,
              };
            });
      const paddleSpeeds = paddle
        ? paddle.slice(1).map((obs, index) => {
            const previous = paddle[index]!;
            const dt = (obs.timestampMs - previous.timestampMs) / 1000;
            return {
              timestampMs: obs.timestampMs,
              value:
                dt > 0
                  ? Math.hypot(obs.center.x - previous.center.x, obs.center.y - previous.center.y) /
                    dt
                  : 0,
            };
          })
        : null;
      const proposals = proposeStrokeEventsV2({
        paddleSpeeds,
        wristSpeeds,
        clipStartMs,
        clipEndMs,
      });
      const bad = nonFinitePaths(proposals);
      if (bad.length > 0) record(step, action, "non_finite_proposal", bad.slice(0, 5).join(","));
      const artifact = checkArtifactInvariants(proposals);
      if (artifact.length > 0)
        record(
          step,
          action,
          "artifact_invariant_proposals",
          artifact.map((v) => `${v.rule}@${v.path}`).join(";"),
        );
      proposals.events.forEach((event: StrokeEventProposalV2, index) => {
        if (event.eventId !== `E${index + 1}`)
          record(step, action, "proposal_id_not_sequential", `${event.eventId}@${index}`);
        if (index > 0 && event.startMs < proposals.events[index - 1]!.endMs)
          record(
            step,
            action,
            "proposals_overlap",
            `${event.eventId} start=${event.startMs} prevEnd=${proposals.events[index - 1]!.endMs}`,
          );
        if (index > 0 && event.peakMs <= proposals.events[index - 1]!.peakMs)
          record(step, action, "proposal_peaks_not_increasing", event.eventId);
        if (event.startMs < clipStartMs || event.endMs > clipEndMs)
          record(
            step,
            action,
            "proposal_outside_clip",
            `${event.eventId} [${event.startMs},${event.endMs}] clip [${clipStartMs},${clipEndMs}]`,
          );
        if (event.paddleConfirmed && event.paddlePeakMs === null)
          record(step, action, "paddle_confirmed_without_peak", event.eventId);
        if (event.paddleConfirmed && paddleSpeeds === null)
          record(step, action, "paddle_confirmed_without_paddle", event.eventId);
      });
      metrics.proposalsTotal! += proposals.events.length;
      const selection = selectTargetEventV2(proposals.events, contactMs);
      const selBad = nonFinitePaths(selection);
      if (selBad.length > 0) record(step, action, "non_finite_selection", selBad.join(","));
      let phases: unknown = null;
      let prediction: unknown = null;
      if (selection.status === "selected") {
        metrics.selected! += 1;
        if (!proposals.events.some((event) => event.eventId === selection.event.eventId))
          record(step, action, "selected_event_not_proposed", selection.event.eventId);
        const outcome = segmentPhasesTemporalV2({
          event: {
            startMs: selection.event.startMs,
            endMs: selection.event.endMs,
            peakMs: selection.event.peakMs,
          },
          contactMs,
          paddleSpeeds,
          wristSpeeds,
        });
        phases = outcome;
        // Anchor-free timelines document contactMs = NaN in-process
        // (phaseTemporal.ts: "anchorBasis === event_peak ⇒ NO contact"); every
        // other non-finite number in the outcome is a violation.
        const scan =
          outcome.status === "segmented" && outcome.boundaries.anchorBasis === "event_peak"
            ? { ...outcome, boundaries: { ...outcome.boundaries, contactMs: 0 } }
            : outcome;
        const phaseBad = nonFinitePaths(scan);
        if (phaseBad.length > 0)
          record(step, action, "non_finite_phase_output", phaseBad.join(","));
        if (
          outcome.status === "segmented" &&
          outcome.boundaries.anchorBasis !== "event_peak" &&
          !Number.isFinite(outcome.boundaries.contactMs)
        ) {
          record(
            step,
            action,
            "anchored_timeline_without_finite_contact",
            `anchorBasis=${String(outcome.boundaries.anchorBasis)} contactMs=${String(outcome.boundaries.contactMs)}`,
          );
        }
        const phaseArtifact = checkArtifactInvariants(outcome);
        if (phaseArtifact.length > 0)
          record(
            step,
            action,
            "artifact_invariant_phases",
            phaseArtifact.map((v) => `${v.rule}@${v.path}`).join(";"),
          );
        if (outcome.status === "segmented") metrics.segmented! += 1;
        else {
          metrics.abstainedPhases! += 1;
          if (typeof outcome.reason !== "string" || outcome.reason.length === 0)
            record(step, action, "phase_abstain_without_reason", stableJson(outcome));
        }
        const predicted = classifyStroke({
          sequence,
          window: { startMs: selection.event.startMs, endMs: selection.event.endMs },
          contactMs,
          eventPeakMs: selection.event.peakMs,
          handedness,
          paddle,
          paddleSpeeds,
          wristSpeeds,
          legacyFrames: legacy,
        });
        prediction = predicted;
        const predBad = nonFinitePaths(predicted);
        if (predBad.length > 0) record(step, action, "non_finite_prediction", predBad.join(","));
        if (predicted.confidence < 0 || predicted.confidence > 1)
          record(step, action, "prediction_confidence_out_of_unit", String(predicted.confidence));
        if (typeof predicted.label !== "string" || predicted.label.length === 0)
          record(step, action, "prediction_label_empty", stableJson(predicted));
        if (
          predicted.leaf !== null &&
          !(STROKE_TAXONOMY_V3.labels as readonly string[]).includes(predicted.leaf)
        )
          record(step, action, "leaf_outside_taxonomy", String(predicted.leaf));
        if (![1, 2, 3].includes(predicted.taxonomyDepth))
          record(step, action, "taxonomy_depth_invalid", String(predicted.taxonomyDepth));
        if (
          predicted.leaf !== null &&
          predicted.taxonomyDepth !== 3 &&
          predicted.leaf !== "OVERHEAD" &&
          predicted.leaf !== "UNKNOWN"
        ) {
          record(
            step,
            action,
            "leaf_without_depth_3",
            `${predicted.leaf} depth=${predicted.taxonomyDepth}`,
          );
        }
        if (predicted.label === "UNKNOWN") {
          metrics.unknownPredictions! += 1;
          if (predicted.limitingFactors.length === 0)
            record(step, action, "unknown_without_limiting_factor", stableJson(predicted));
        } else if (predicted.leaf !== null) {
          metrics.leafPredictions! += 1;
        }
        if (predicted.contactPointSource === "paddle" && paddle === null)
          record(step, action, "paddle_contact_source_without_paddle", stableJson(predicted));
      } else {
        metrics.noneSelected! += 1;
        if (selection.status === "none" && proposals.events.length > 0 && contactMs === null) {
          // documented: prominence fallback selects when no contact is known
          record(
            step,
            action,
            "no_selection_despite_proposals",
            `${proposals.events.length} proposals, contact=null`,
          );
        }
      }
      trace.push({
        frames: frames.length,
        proposals: proposals.events.map((event) => [event.startMs, event.peakMs, event.endMs]),
        selection: selection.status,
        phases: phases ? stableJson(phases) : null,
        prediction: prediction ? stableJson(prediction) : null,
      });
    };

    actions.forEach((action, step) => {
      try {
        const frames = sequence.frames;
        switch (action.kind) {
          case "dropFrame":
            if (frames.length > 2) frames.splice(action.at % frames.length, 1);
            break;
          case "dupFrame": {
            if (frames.length > 0) {
              const at = action.at % frames.length;
              frames.splice(at, 0, JSON.parse(JSON.stringify(frames[at])));
            }
            break;
          }
          case "jitter": {
            const jitterRand = new Rand((seed ^ step) >>> 0);
            for (const frame of frames)
              for (const mark of frame.landmarks) {
                mark.x += action.sigma * jitterRand.gauss();
                mark.y += action.sigma * jitterRand.gauss();
              }
            break;
          }
          case "nanJoint": {
            if (frames.length > 0) {
              const frame = frames[action.at % frames.length]!;
              const mark = frame.landmarks[action.joint % frame.landmarks.length];
              if (mark) mark.x = Number.NaN;
            }
            break;
          }
          case "zeroVisibility": {
            if (frames.length > 0)
              for (const mark of frames[action.at % frames.length]!.landmarks) mark.visibility = 0;
            break;
          }
          case "shiftTime":
            for (const frame of frames) frame.timestampMs += action.deltaMs;
            window = {
              startMs: window.startMs + action.deltaMs,
              endMs: window.endMs + action.deltaMs,
              peakMs: window.peakMs + action.deltaMs,
            };
            if (contactMs !== null && Number.isFinite(contactMs)) contactMs += action.deltaMs;
            break;
          case "scaleCoords":
            for (const frame of frames)
              for (const mark of frame.landmarks) {
                mark.x = 0.5 + (mark.x - 0.5) * action.factor;
                mark.y = 0.5 + (mark.y - 0.5) * action.factor;
              }
            break;
          case "setContact":
            if (action.mode === "null") contactMs = null;
            else if (action.mode === "peak") contactMs = window.peakMs;
            else if (action.mode === "inside")
              contactMs = window.startMs + (window.endMs - window.startMs) * 0.5;
            else if (action.mode === "outside") contactMs = window.endMs + 5000;
            else contactMs = Number.NaN;
            break;
          case "togglePaddle":
            paddleOffset = action.on ? action.offset : null;
            break;
          case "truncateTail":
            if (frames.length > action.frames + 2)
              frames.splice(frames.length - action.frames, action.frames);
            break;
          case "reverseFrameOrder":
            // near-legal: PoseSequence documents "ascending by timestampMs";
            // reversing is the caller bug the pipeline must survive w/o NaN.
            frames.reverse();
            break;
          case "handedness":
            handedness = action.value;
            break;
        }
        runPipeline(step, action);
      } catch (error) {
        metrics.pipelineThrows! += 1;
        record(
          step,
          action,
          "unexpected_throw",
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    return { violations, trace: stableJson(trace), metrics };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Campaign 4 — ball tracker on incrementally built candidate files
// ═══════════════════════════════════════════════════════════════════════════

export type BallAction =
  | { kind: "frame"; ballVisible: boolean; decoys: number; noise: number }
  | { kind: "frameNaN" }
  | { kind: "frameDuplicateTime" }
  | { kind: "frameBackwards"; deltaMs: number }
  | { kind: "frameHugeBlob" }
  | { kind: "frameEmpty" };

interface BallWorld {
  pose: PoseSequence;
  window: { startMs: number; endMs: number };
  fps: number;
  contact: { tMs: number; x: number; y: number };
  velocityIn: { x: number; y: number };
  velocityOut: { x: number; y: number };
  decoyAnchors: Array<{ x: number; y: number; drift: { x: number; y: number } }>;
}

function ballWorld(seed: number): BallWorld {
  const rand = new Rand(seed ^ 0x27d4eb2f);
  const truth = randomSwingTruth(rand);
  const generated = generateSwingSequence(truth);
  const pose = generated.sequence;
  const fps = truth.fps ?? 60;
  const contactFrame = pose.frames.reduce(
    (best, frame, index) =>
      Math.abs(frame.timestampMs - generated.window.peakMs) <
      Math.abs(pose.frames[best]!.timestampMs - generated.window.peakMs)
        ? index
        : best,
    0,
  );
  const wrist = landmark(
    pose,
    contactFrame,
    `${truth.handed === "left" ? "left" : "right"}_wrist`,
  ) ?? { x: 0.5, y: 0.5 };
  const speed = rand.float(0.6, 2.8); // norm units / s
  const angleIn = rand.float(-0.6, 0.6);
  const dir = rand.pick([-1, 1]);
  return {
    pose,
    window: { startMs: generated.window.startMs, endMs: generated.window.endMs },
    fps,
    contact: { tMs: pose.frames[contactFrame]!.timestampMs, x: wrist.x + 0.03 * dir, y: wrist.y },
    velocityIn: { x: dir * speed * Math.cos(angleIn), y: speed * Math.sin(angleIn) },
    velocityOut: { x: -dir * speed * rand.float(0.7, 1.3), y: -rand.float(0.2, 1.0) * speed },
    decoyAnchors: Array.from({ length: rand.int(0, 4) }, () => ({
      x: rand.float(0.05, 0.95),
      y: rand.float(0.05, 0.95),
      drift: { x: rand.float(-0.05, 0.05), y: rand.float(-0.05, 0.05) },
    })),
  };
}

function ballPositionAt(world: BallWorld, tMs: number): { x: number; y: number } {
  const dt = (tMs - world.contact.tMs) / 1000;
  const v = dt < 0 ? world.velocityIn : world.velocityOut;
  return {
    x: world.contact.x + v.x * dt,
    y: world.contact.y + v.y * dt + (dt > 0 ? 0.6 * dt * dt : 0),
  };
}

export const ballTrackerCampaign: Campaign<BallAction> = {
  name: "ball_tracker",
  seedBase: 400_000,
  generate(seed) {
    const rand = new Rand(seed);
    const length = rand.int(SEQUENCE_LENGTH.min, SEQUENCE_LENGTH.max);
    const nearLegal = rand.chance(NEAR_LEGAL_SEQUENCE_SHARE);
    const actions: BallAction[] = [];
    for (let i = 0; i < length; i += 1) {
      const roll = rand.next();
      const legalFrame = (): BallAction => ({
        kind: "frame",
        ballVisible: rand.chance(0.88),
        decoys: rand.int(0, 4),
        noise: rand.int(0, 6),
      });
      if (roll < 0.82) actions.push(legalFrame());
      else if (roll < 0.86) actions.push(nearLegal ? { kind: "frameNaN" } : legalFrame());
      else if (roll < 0.9) actions.push({ kind: "frameDuplicateTime" });
      else if (roll < 0.94)
        actions.push(
          nearLegal ? { kind: "frameBackwards", deltaMs: rand.float(1, 300) } : legalFrame(),
        );
      else if (roll < 0.97) actions.push({ kind: "frameHugeBlob" });
      else actions.push({ kind: "frameEmpty" });
    }
    return actions;
  },
  describe(action) {
    return stableJson(action);
  },
  execute(actions, seed) {
    const world = ballWorld(seed);
    const rand = new Rand(seed ^ 0x165667b1);
    const stepMs = 1000 / world.fps;
    const file: BallCandidateFile = {
      schemaVersion: 1,
      generator: { version: "stress-synthetic", method: "seeded", scale: 1, note: `seed ${seed}` },
      video: {
        path: `synthetic://${seed}`,
        width: 1080,
        height: 1080,
        fps: world.fps,
        durationMs: 0,
      },
      window: world.window,
      backgroundActivity: { grid: 8, cells: Array.from({ length: 64 }, () => rand.float(0, 0.9)) },
      timing: { framesProcessed: 0, wallSecTotal: 0, msPerFrame: 0 },
      frames: [],
    };
    let tMs = world.window.startMs - 200;
    const violations: StepViolation[] = [];
    const trace: unknown[] = [];
    const metrics: Record<string, number> = {
      tracked: 0,
      untracked: 0,
      gatedTracks: 0,
      fragments: 0,
      timelines: 0,
      throws: 0,
      equalTimestampObservations: 0,
    };
    const tainted = () =>
      file.frames.some(
        (frame) =>
          !Number.isFinite(frame.tMs) ||
          frame.candidates.some(
            (c) => !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.areaPx),
          ),
      ) || file.frames.some((frame, index) => index > 0 && frame.tMs < file.frames[index - 1]!.tMs);
    const record = (step: number, action: BallAction, rule: string, detail: string) =>
      violations.push({
        step,
        action: stableJson(action),
        rule,
        detail,
        inputClass: tainted() ? "near_legal" : "legal",
      });
    const candidate = (
      x: number,
      y: number,
      area: number,
      elong: number,
      score: number,
    ): BallCandidate => ({
      x,
      y,
      areaPx: area,
      wNorm: Math.sqrt(area) / 1080,
      hNorm: Math.sqrt(area) / 1080,
      elong,
      score,
    });

    const check = (step: number, action: BallAction) => {
      const legacy = toLegacyPoseFrames(world.pose);
      const built = buildBallTracks(file, world.pose, world.window, null, legacy);
      const outcome: BallTrackingOutcome = selectPrimaryBallTrack(
        built.gated,
        built.ablation,
        world.window,
        {
          paddleTrackExists: false,
          fragments: built.fragments,
          contact: world.contact,
        },
      );
      const bad = nonFinitePaths({ built, outcome });
      if (bad.length > 0) record(step, action, "non_finite_ball_output", bad.slice(0, 6).join(","));
      const artifact = checkArtifactInvariants({ built, outcome });
      if (artifact.length > 0)
        record(
          step,
          action,
          "artifact_invariant_ball",
          artifact.map((v) => `${v.rule}@${v.path}`).join(";"),
        );
      const ids = new Set<number>();
      const inputAt = new Map<number, BallCandidate[]>();
      for (const frame of file.frames)
        inputAt.set(frame.tMs, [...(inputAt.get(frame.tMs) ?? []), ...frame.candidates]);
      const checkTrack = (
        track: BallTrackCandidate,
        bucket: string,
        minObs: number,
        maxObs: number,
      ) => {
        if (ids.has(track.trackId))
          record(step, action, "ball_track_id_duplicate", `${bucket} ${track.trackId}`);
        ids.add(track.trackId);
        if (track.observations.length < minObs || track.observations.length > maxObs) {
          record(
            step,
            action,
            "ball_track_length_out_of_bucket",
            `${bucket} ${track.trackId} n=${track.observations.length} expected [${minObs},${maxObs}]`,
          );
        }
        track.observations.forEach((obs, index) => {
          if (index > 0 && obs.timestampMs < track.observations[index - 1]!.timestampMs)
            record(
              step,
              action,
              "ball_observations_out_of_order",
              `${bucket} ${track.trackId}@${index}`,
            );
          if (index > 0 && obs.timestampMs === track.observations[index - 1]!.timestampMs)
            metrics.equalTimestampObservations! += 1;
          if (obs.confidence < 0 || obs.confidence > 1)
            record(
              step,
              action,
              "ball_confidence_out_of_unit",
              `${track.trackId} ${obs.confidence}`,
            );
          const inputs = inputAt.get(obs.timestampMs) ?? [];
          if (
            !inputs.some(
              (c) =>
                Object.is(c.x, obs.x) && Object.is(c.y, obs.y) && Object.is(c.areaPx, obs.areaPx),
            )
          ) {
            record(
              step,
              action,
              "ball_observation_not_from_input",
              `${bucket} ${track.trackId}@${obs.timestampMs} (${obs.x},${obs.y})`,
            );
          }
        });
        for (const key of [
          "jerkyFraction",
          "chronicFraction",
          "inBandFraction",
          "nearPaddleFraction",
          "coherentMotionFraction",
          "bodyDwellFraction",
          "straightness",
        ] as const) {
          const value = track[key];
          if (value < -1e-9 || value > 1 + 1e-9)
            record(step, action, "ball_fraction_out_of_unit", `${track.trackId}.${key}=${value}`);
        }
        if (track.medianSpeed < 0 || track.maxSpeed < track.medianSpeed)
          record(
            step,
            action,
            "ball_speed_stats_inconsistent",
            `${track.trackId} median=${track.medianSpeed} max=${track.maxSpeed}`,
          );
      };
      for (const track of built.all)
        checkTrack(track, "all", BALL_GATES2.minObservations, Number.POSITIVE_INFINITY);
      const allIds = new Set(built.all.map((track) => track.trackId));
      for (const track of built.gated) {
        if (!allIds.has(track.trackId))
          record(step, action, "gated_not_subset_of_all", String(track.trackId));
      }
      ids.clear();
      for (const track of built.fragments) checkTrack(track, "fragment", 3, 4);
      if (built.ablation.stageC_tracks !== built.gated.length)
        record(
          step,
          action,
          "ablation_stageC_mismatch",
          `${built.ablation.stageC_tracks} vs ${built.gated.length}`,
        );
      if (built.ablation.stageB_tracks < built.gated.length)
        record(
          step,
          action,
          "ablation_stageB_below_gated",
          `${built.ablation.stageB_tracks} < ${built.gated.length}`,
        );
      metrics.gatedTracks! += built.gated.length;
      metrics.fragments! += built.fragments.length;
      if (outcome.status === "tracked") {
        metrics.tracked! += 1;
        const known = [...built.gated, ...built.fragments].some(
          (track) => track.trackId === outcome.lab.trackId,
        );
        if (!known)
          record(step, action, "primary_not_among_candidates", String(outcome.lab.trackId));
        const states = outcome.timeline.states;
        states.forEach((state, index) => {
          if (state.toMs < state.fromMs)
            record(step, action, "timeline_state_negative_span", stableJson(state));
          if (index > 0 && state.fromMs < states[index - 1]!.toMs)
            record(step, action, "timeline_states_overlap", stableJson([states[index - 1], state]));
        });
        if (
          states.length > 0 &&
          states[0]!.state !== "TRACKED" &&
          states[0]!.state !== "ENTERING_OCCLUSION"
        )
          record(step, action, "timeline_first_state_invalid", states[0]!.state);
        if (outcome.timeline.bridge.some((point) => point.predicted !== true))
          record(step, action, "bridge_point_not_marked_predicted", "");
        if (
          outcome.timeline.reacquisition.attempted &&
          outcome.timeline.reacquisition.detail.length === 0
        )
          record(step, action, "reacquisition_without_detail", "");
        metrics.timelines! += 1;
        // Linking must be replayable directly with the same inputs.
        const relinked = linkBallTimeline({
          primary: outcome.lab,
          candidates: [...built.gated, ...built.fragments],
          contact: world.contact,
          windowEndMs: world.window.endMs,
        });
        const relinkBad = nonFinitePaths(relinked);
        if (relinkBad.length > 0) record(step, action, "non_finite_relink", relinkBad.join(","));
      } else {
        metrics.untracked! += 1;
        if (typeof outcome.reason !== "string" || outcome.reason.length === 0)
          record(step, action, "untracked_without_reason", stableJson(outcome));
      }
      trace.push({
        frames: file.frames.length,
        all: built.all.map((track) => [track.trackId, track.observations.length]),
        gated: built.gated.map((track) => track.trackId),
        status: outcome.status,
        primary: outcome.status === "tracked" ? outcome.lab.trackId : outcome.reason,
      });
    };

    actions.forEach((action, step) => {
      try {
        let frameT = tMs + stepMs;
        const candidates: BallCandidate[] = [];
        let rawCount = 0;
        const pushBall = (t: number, jitter = 0.003) => {
          const position = ballPositionAt(world, t);
          candidates.push(
            candidate(
              position.x + jitter * rand.gauss(),
              position.y + jitter * rand.gauss(),
              rand.float(20, 110),
              rand.float(1, 1.6),
              rand.float(0.4, 1),
            ),
          );
        };
        const pushDecoys = (n: number) => {
          for (let i = 0; i < n; i += 1) {
            const anchor = world.decoyAnchors[i % Math.max(1, world.decoyAnchors.length)];
            if (!anchor) break;
            const age = (frameT - world.window.startMs) / 1000;
            candidates.push(
              candidate(
                anchor.x + anchor.drift.x * age + 0.002 * rand.gauss(),
                anchor.y + anchor.drift.y * age + 0.002 * rand.gauss(),
                rand.float(15, 300),
                rand.float(1, 4),
                rand.float(0.2, 0.9),
              ),
            );
          }
        };
        switch (action.kind) {
          case "frame":
            if (action.ballVisible) pushBall(frameT);
            pushDecoys(action.decoys);
            for (let i = 0; i < action.noise; i += 1)
              candidates.push(
                candidate(
                  rand.next(),
                  rand.next(),
                  rand.float(5, 500),
                  rand.float(1, 6),
                  rand.next(),
                ),
              );
            rawCount = candidates.length + rand.int(0, 3);
            break;
          case "frameNaN":
            pushBall(frameT);
            candidates.push(candidate(Number.NaN, rand.next(), rand.float(20, 100), 1.2, 0.8));
            candidates.push(candidate(rand.next(), Number.POSITIVE_INFINITY, Number.NaN, 1.2, 0.8));
            rawCount = candidates.length;
            break;
          case "frameDuplicateTime":
            frameT = tMs; // same timestamp as the previous frame
            pushBall(frameT, 0.01);
            rawCount = candidates.length;
            break;
          case "frameBackwards":
            frameT = tMs - action.deltaMs;
            pushBall(frameT);
            rawCount = candidates.length;
            break;
          case "frameHugeBlob":
            pushBall(frameT);
            candidates.push(candidate(rand.next(), rand.next(), 5e6, 40, 1));
            rawCount = candidates.length;
            break;
          case "frameEmpty":
            rawCount = 0;
            break;
        }
        file.frames.push({ tMs: frameT, candidates, rawComponentCount: rawCount });
        tMs = Math.max(tMs, frameT);
        file.timing.framesProcessed = file.frames.length;
        file.video.durationMs = Math.max(file.video.durationMs, tMs);
        check(step, action);
      } catch (error) {
        metrics.throws! += 1;
        record(
          step,
          action,
          "unexpected_throw",
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    return { violations, trace: stableJson(trace), metrics };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Campaign 5 — paddle tracker on incrementally built detection files
// ═══════════════════════════════════════════════════════════════════════════

export type PaddleAction =
  | { kind: "frame"; paddleVisible: boolean; score: number; otherPaddle: boolean; extras: number }
  | { kind: "frameNaNBox" }
  | { kind: "frameZeroBox" }
  | { kind: "frameOutOfImage" }
  | { kind: "frameDuplicateTime" }
  | { kind: "frameBackwards"; deltaMs: number }
  | { kind: "gap"; frames: number };

export const paddleTrackerCampaign: Campaign<PaddleAction> = {
  name: "paddle_tracker",
  seedBase: 500_000,
  generate(seed) {
    const rand = new Rand(seed);
    const length = rand.int(SEQUENCE_LENGTH.min, SEQUENCE_LENGTH.max);
    const nearLegal = rand.chance(NEAR_LEGAL_SEQUENCE_SHARE);
    const actions: PaddleAction[] = [];
    for (let i = 0; i < length; i += 1) {
      const roll = rand.next();
      const legalFrame = (): PaddleAction => ({
        kind: "frame",
        paddleVisible: rand.chance(0.85),
        score: rand.float(0.1, 0.99),
        otherPaddle: rand.chance(0.4),
        extras: rand.int(0, 3),
      });
      if (roll < 0.78) actions.push(legalFrame());
      else if (roll < 0.82) actions.push(nearLegal ? { kind: "frameNaNBox" } : legalFrame());
      else if (roll < 0.86) actions.push({ kind: "frameZeroBox" });
      else if (roll < 0.9) actions.push({ kind: "frameOutOfImage" });
      else if (roll < 0.93) actions.push({ kind: "frameDuplicateTime" });
      else if (roll < 0.96)
        actions.push(
          nearLegal ? { kind: "frameBackwards", deltaMs: rand.float(1, 200) } : legalFrame(),
        );
      else actions.push({ kind: "gap", frames: rand.int(1, 12) });
    }
    return actions;
  },
  describe(action) {
    return stableJson(action);
  },
  execute(actions, seed) {
    const rand = new Rand(seed ^ 0x3c6ef372);
    const truth = randomSwingTruth(rand);
    const generated = generateSwingSequence(truth);
    const pose = generated.sequence;
    const window = { startMs: generated.window.startMs, endMs: generated.window.endMs };
    const wrists = wristSeries(pose);
    const otherWrists = rand.chance(0.5)
      ? wrists.map((entry) => ({
          timestampMs: entry.timestampMs,
          wrists: entry.wrists.map((w) => ({ x: 1 - w.x, y: w.y })),
        }))
      : [];
    const ownershipGuard = rand.chance(0.5);
    const width = 1920;
    const height = 1080;
    const file: RawPaddleDetectionFile = {
      schemaVersion: 1,
      detector: {
        modelId: "stress-synthetic",
        version: "0",
        license: "n/a",
        device: "cpu",
        proxyLabels: ["paddle"],
        proxyNote: "seeded synthetic",
        scoreFloor: 0.1,
      },
      video: { path: `synthetic://${seed}`, width, height, fps: truth.fps ?? 60, durationMs: 0 },
      window,
      timing: {
        modelLoadSec: 0,
        framesProcessed: 0,
        inferenceSecTotal: 0,
        inferenceMsPerFrame: 0,
        wallSecTotal: 0,
      },
      frames: [],
    };
    const stepMs = 1000 / (truth.fps ?? 60);
    let frameIndex = 0;
    let tMs = pose.frames[0]!.timestampMs - stepMs;
    const violations: StepViolation[] = [];
    const trace: unknown[] = [];
    const metrics: Record<string, number> = {
      tracked: 0,
      untracked: 0,
      tracks: 0,
      merged: 0,
      throws: 0,
      equalTimestampObservations: 0,
    };
    const tainted = () =>
      file.frames.some((frame) =>
        frame.detections.some((d) => !d.box.every(Number.isFinite) || !Number.isFinite(d.score)),
      ) || file.frames.some((frame, index) => index > 0 && frame.tMs < file.frames[index - 1]!.tMs);
    const record = (step: number, action: PaddleAction, rule: string, detail: string) =>
      violations.push({
        step,
        action: stableJson(action),
        rule,
        detail,
        inputClass: tainted() ? "near_legal" : "legal",
      });
    const wristFor = (t: number) => {
      const frame = pose.frames.reduce(
        (best, f) => (Math.abs(f.timestampMs - t) < Math.abs(best.timestampMs - t) ? f : best),
        pose.frames[0]!,
      );
      return (
        frame.landmarks.find(
          (mark) => mark.name === `${truth.handed === "left" ? "left" : "right"}_wrist`,
        ) ?? { x: 0.5, y: 0.5 }
      );
    };
    const boxAround = (
      cx: number,
      cy: number,
      w: number,
      h: number,
    ): [number, number, number, number] => [
      (cx - w / 2) * width,
      (cy - h / 2) * height,
      (cx + w / 2) * width,
      (cy + h / 2) * height,
    ];

    const check = (step: number, action: PaddleAction) => {
      const candidates = buildPaddleTracks(file, window);
      const merged = mergePaddleTracklets(candidates, window);
      const outcome = selectPrimaryPaddleTrack(merged.merged, wrists, window, otherWrists, {
        ownershipGuard,
      });
      const bad = nonFinitePaths({ candidates, merged, outcome });
      if (bad.length > 0)
        record(step, action, "non_finite_paddle_output", bad.slice(0, 6).join(","));
      const artifact = checkArtifactInvariants({ candidates, merged, outcome });
      if (artifact.length > 0)
        record(
          step,
          action,
          "artifact_invariant_paddle",
          artifact.map((v) => `${v.rule}@${v.path}`).join(";"),
        );
      const checkTrack = (track: PaddleTrackCandidate, bucket: string, ids: Set<number>) => {
        if (ids.has(track.trackId))
          record(step, action, "paddle_track_id_duplicate", `${bucket} ${track.trackId}`);
        ids.add(track.trackId);
        if (track.observations.length < TRACKER_GATES.minObservations)
          record(
            step,
            action,
            "paddle_track_below_min_observations",
            `${bucket} ${track.trackId} n=${track.observations.length}`,
          );
        if (track.windowCoverage < 0 || track.windowCoverage > 1 + 1e-9)
          record(
            step,
            action,
            "paddle_window_coverage_out_of_unit",
            `${track.trackId} ${track.windowCoverage}`,
          );
        if (track.meanScore < 0 || track.meanScore > 1)
          record(
            step,
            action,
            "paddle_mean_score_out_of_unit",
            `${track.trackId} ${track.meanScore}`,
          );
        if (track.meanWristDistance !== null && track.meanWristDistance < 0)
          record(step, action, "paddle_negative_wrist_distance", String(track.meanWristDistance));
        track.observations.forEach((obs: TrackedPaddleObservation, index) => {
          if (index > 0 && obs.timestampMs < track.observations[index - 1]!.timestampMs)
            record(
              step,
              action,
              "paddle_observations_out_of_order",
              `${bucket} ${track.trackId}@${index}`,
            );
          if (index > 0 && obs.timestampMs === track.observations[index - 1]!.timestampMs)
            metrics.equalTimestampObservations! += 1;
          if (obs.confidence < 0 || obs.confidence > 1)
            record(
              step,
              action,
              "paddle_confidence_out_of_unit",
              `${track.trackId} ${obs.confidence}`,
            );
          if (obs.box.width <= 0 || obs.box.height <= 0)
            record(
              step,
              action,
              "paddle_box_non_positive",
              `${track.trackId} ${stableJson(obs.box)}`,
            );
          if (
            Math.abs(obs.center.x - (obs.box.x + obs.box.width / 2)) > 1e-6 ||
            Math.abs(obs.center.y - (obs.box.y + obs.box.height / 2)) > 1e-6
          ) {
            record(
              step,
              action,
              "paddle_center_not_box_center",
              `${track.trackId}@${obs.timestampMs}`,
            );
          }
        });
      };
      const buildIds = new Set<number>();
      for (const track of candidates) checkTrack(track, "built", buildIds);
      const mergedIds = new Set<number>();
      for (const track of merged.merged) checkTrack(track, "merged", mergedIds);
      if (merged.merged.length > candidates.length)
        record(
          step,
          action,
          "merge_increased_track_count",
          `${merged.merged.length} > ${candidates.length}`,
        );
      if (merged.links !== candidates.length - merged.merged.length)
        record(
          step,
          action,
          "merge_links_count_mismatch",
          `links=${merged.links} built=${candidates.length} merged=${merged.merged.length}`,
        );
      const builtObs = candidates.reduce((sum, track) => sum + track.observations.length, 0);
      const mergedObs = merged.merged.reduce((sum, track) => sum + track.observations.length, 0);
      if (mergedObs !== builtObs)
        record(step, action, "merge_changed_observation_count", `${mergedObs} vs ${builtObs}`);
      metrics.tracks! += candidates.length;
      metrics.merged! += merged.merged.length;
      if (outcome.status === "tracked") {
        metrics.tracked! += 1;
        if (!merged.merged.some((track) => track.trackId === outcome.lab.trackId))
          record(step, action, "primary_paddle_not_in_candidates", String(outcome.lab.trackId));
        if (outcome.association.selectionMargin !== null && outcome.association.selectionMargin < 0)
          record(
            step,
            action,
            "negative_selection_margin",
            String(outcome.association.selectionMargin),
          );
        if (outcome.association.rejectedOtherPlayerTracks < 0)
          record(step, action, "negative_rejected_count", "");
        if (otherWrists.length === 0 && outcome.association.rejectedOtherPlayerTracks !== 0)
          record(
            step,
            action,
            "rejected_other_player_without_other_players",
            String(outcome.association.rejectedOtherPlayerTracks),
          );
      } else {
        metrics.untracked! += 1;
        if (typeof outcome.reason !== "string" || outcome.reason.length === 0)
          record(step, action, "untracked_without_reason", stableJson(outcome));
      }
      trace.push({
        frames: file.frames.length,
        built: candidates.map((track) => [track.trackId, track.observations.length]),
        merged: merged.merged.map((track) => [track.trackId, track.observations.length]),
        status: outcome.status,
        primary: outcome.status === "tracked" ? outcome.lab.trackId : outcome.reason,
      });
    };

    actions.forEach((action, step) => {
      try {
        let frameT = tMs + stepMs;
        const detections: RawPaddleDetectionFile["frames"][number]["detections"] = [];
        const extras: RawPaddleDetectionFile["frames"][number]["extras"] = [];
        const wrist = wristFor(frameT);
        const paddleBox = (t: number, score: number) => {
          const w = wristFor(t);
          detections.push({
            box: boxAround(
              w.x + 0.04 + 0.003 * rand.gauss(),
              w.y - 0.05 + 0.003 * rand.gauss(),
              0.05,
              0.08,
            ),
            score,
            label: "paddle",
            source: "full_frame",
          });
        };
        switch (action.kind) {
          case "frame":
            if (action.paddleVisible) paddleBox(frameT, action.score);
            if (action.otherPaddle)
              detections.push({
                box: boxAround(1 - wrist.x + 0.04, wrist.y - 0.05, 0.05, 0.08),
                score: rand.float(0.3, 0.9),
                label: "paddle",
              });
            for (let i = 0; i < action.extras; i += 1)
              extras.push({
                box: boxAround(
                  rand.next(),
                  rand.next(),
                  rand.float(0.01, 0.3),
                  rand.float(0.01, 0.3),
                ),
                score: rand.next(),
                label: "tennis racket",
              });
            break;
          case "frameNaNBox":
            paddleBox(frameT, 0.8);
            detections.push({ box: [Number.NaN, 10, 20, 30], score: 0.9, label: "paddle" });
            detections.push({ box: [10, 10, 20, 30], score: Number.NaN, label: "paddle" });
            break;
          case "frameZeroBox":
            detections.push({ box: [500, 500, 500, 500], score: 0.9, label: "paddle" });
            paddleBox(frameT, 0.6);
            break;
          case "frameOutOfImage":
            detections.push({ box: [-500, -500, -100, -100], score: 0.9, label: "paddle" });
            detections.push({
              box: [width + 10, height + 10, width + 200, height + 300],
              score: 0.9,
              label: "paddle",
            });
            break;
          case "frameDuplicateTime":
            frameT = tMs;
            paddleBox(frameT, 0.7);
            break;
          case "frameBackwards":
            frameT = tMs - action.deltaMs;
            paddleBox(frameT, 0.7);
            break;
          case "gap":
            frameT = tMs + stepMs * (action.frames + 1);
            paddleBox(frameT, 0.7);
            break;
        }
        file.frames.push({ tMs: frameT, detections, extras });
        frameIndex += 1;
        tMs = Math.max(tMs, frameT);
        file.timing.framesProcessed = frameIndex;
        file.video.durationMs = Math.max(file.video.durationMs, tMs);
        check(step, action);
      } catch (error) {
        metrics.throws! += 1;
        record(
          step,
          action,
          "unexpected_throw",
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    return { violations, trace: stableJson(trace), metrics };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Campaign 6 — player tracker / target selection on incremental people files
// ═══════════════════════════════════════════════════════════════════════════

export type PlayerAction =
  | { kind: "frame"; present: boolean[]; shuffle: boolean }
  | { kind: "frameNaN" }
  | { kind: "frameLowConfidence" }
  | { kind: "frameDuplicateTime" }
  | { kind: "frameSwapped" }
  | { kind: "frameBackwards"; deltaMs: number }
  | { kind: "gap"; frames: number };

const PERSON_JOINTS = [
  "nose",
  "left_eye",
  "right_eye",
  "left_ear",
  "right_ear",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
] as const;

export const playerTrackerCampaign: Campaign<PlayerAction> = {
  name: "player_tracker",
  seedBase: 600_000,
  generate(seed) {
    const rand = new Rand(seed);
    const people = rand.int(1, 3);
    const length = rand.int(SEQUENCE_LENGTH.min, SEQUENCE_LENGTH.max);
    const nearLegal = rand.chance(NEAR_LEGAL_SEQUENCE_SHARE);
    const actions: PlayerAction[] = [];
    for (let i = 0; i < length; i += 1) {
      const roll = rand.next();
      const legalFrame = (): PlayerAction => ({
        kind: "frame",
        present: Array.from({ length: people }, () => rand.chance(0.9)),
        shuffle: rand.chance(0.3),
      });
      if (roll < 0.8) actions.push(legalFrame());
      else if (roll < 0.85) actions.push(nearLegal ? { kind: "frameNaN" } : legalFrame());
      else if (roll < 0.9) actions.push({ kind: "frameLowConfidence" });
      else if (roll < 0.93) actions.push({ kind: "frameDuplicateTime" });
      else if (roll < 0.95) actions.push({ kind: "frameSwapped" });
      else if (roll < 0.97)
        actions.push(
          nearLegal ? { kind: "frameBackwards", deltaMs: rand.float(1, 150) } : legalFrame(),
        );
      else actions.push({ kind: "gap", frames: rand.int(1, 20) });
    }
    return actions;
  },
  describe(action) {
    return stableJson(action);
  },
  execute(actions, seed) {
    const rand = new Rand(seed ^ 0x7f4a7c15);
    const peopleCount = new Rand(seed).int(1, 3); // matches generate()
    const people = Array.from({ length: peopleCount }, () => ({
      x: rand.float(0.15, 0.85),
      y: rand.float(0.3, 0.8),
      scale: rand.float(0.1, 0.3),
      vx: rand.float(-0.02, 0.02),
      vy: rand.float(-0.01, 0.01),
    }));
    const file: PeopleFile = {
      schemaVersion: 1,
      poseModelVersion: "stress-synthetic",
      video: { w: 1920, h: 1080, fps: 30 },
      frames: [],
    };
    const stepMs = 1000 / 30;
    let t = 0;
    const seedMode: TargetSeed = rand.chance(0.4)
      ? { mode: "user_tapped_person", point: { x: people[0]!.x, y: people[0]!.y } }
      : rand.chance(0.5)
        ? {
            mode: "user_selected_court_half",
            half: rand.pick(["left", "right"] as const),
            nearSide: rand.chance(0.5),
          }
        : { mode: "auto_single_player" };
    const violations: StepViolation[] = [];
    const trace: unknown[] = [];
    const metrics: Record<string, number> = {
      tracks: 0,
      selectOk: 0,
      selectFail: 0,
      seedOk: 0,
      seedFail: 0,
      throws: 0,
      equalTimestampFrames: 0,
    };
    const tainted = () =>
      file.frames.some((frame) =>
        frame.p.some((entry) =>
          entry.l.some((mark) => !Number.isFinite(mark.x) || !Number.isFinite(mark.y)),
        ),
      ) || file.frames.some((frame, index) => index > 0 && frame.t < file.frames[index - 1]!.t);
    const record = (step: number, action: PlayerAction, rule: string, detail: string) =>
      violations.push({
        step,
        action: stableJson(action),
        rule,
        detail,
        inputClass: tainted() ? "near_legal" : "legal",
      });
    const person = (
      index: number,
      tt: number,
      mutate?: (l: { n: string; x: number; y: number; v: number }) => void,
    ) => {
      const p = people[index]!;
      const age = tt / 1000;
      const cx = p.x + p.vx * age;
      const cy = p.y + p.vy * age;
      const s = p.scale;
      const l = PERSON_JOINTS.map((n) => {
        const side = n.startsWith("left_") ? -1 : n.startsWith("right_") ? 1 : 0;
        const level =
          n.includes("eye") || n.includes("ear") || n === "nose"
            ? -1.1
            : n.includes("shoulder")
              ? -0.5
              : n.includes("elbow")
                ? -0.15
                : n.includes("wrist")
                  ? 0.15
                  : n.includes("hip")
                    ? 0.5
                    : n.includes("knee")
                      ? 1.1
                      : 1.7;
        const mark = {
          n,
          x: cx + side * s * 0.35 + 0.004 * rand.gauss(),
          y: cy + level * s + 0.004 * rand.gauss(),
          v: rand.float(0.5, 1),
        };
        mutate?.(mark);
        return mark;
      });
      return { c: rand.float(0.6, 1), l };
    };
    const check = (step: number, action: PlayerAction) => {
      const tracks = buildPlayerTracks(file);
      const bad = nonFinitePaths(tracks);
      if (bad.length > 0)
        record(step, action, "non_finite_player_tracks", bad.slice(0, 6).join(","));
      const ids = new Set<number>();
      tracks.forEach((track: PlayerTrack) => {
        if (ids.has(track.trackId))
          record(step, action, "player_track_id_duplicate", String(track.trackId));
        ids.add(track.trackId);
        if (track.coverage < 0 || track.coverage > 1 + 1e-9)
          record(step, action, "player_coverage_out_of_unit", `${track.trackId} ${track.coverage}`);
        if (track.meanTorsoSpan < 0)
          record(step, action, "negative_torso_span", String(track.meanTorsoSpan));
        track.frames.forEach((frame, index) => {
          if (index > 0 && frame.timestampMs < track.frames[index - 1]!.timestampMs)
            record(step, action, "player_frames_out_of_order", `${track.trackId}@${index}`);
          if (index > 0 && frame.timestampMs === track.frames[index - 1]!.timestampMs)
            metrics.equalTimestampFrames! += 1;
          if (frame.confidence < 0 || frame.confidence > 1)
            record(
              step,
              action,
              "player_frame_confidence_out_of_unit",
              `${track.trackId} ${frame.confidence}`,
            );
        });
        for (const loss of track.lossPeriods)
          if (loss.toMs < loss.fromMs)
            record(step, action, "loss_period_negative", stableJson(loss));
        for (const resume of track.occlusionResumes)
          if (resume.toMs < resume.fromMs)
            record(step, action, "occlusion_resume_negative", stableJson(resume));
      });
      metrics.tracks! += tracks.length;
      const explicitId = tracks.length > 0 ? tracks[step % tracks.length]!.trackId : 1;
      const selection = selectTargetPlayer(
        tracks,
        step % 2 === 0 ? { policy: "auto" } : { policy: "explicit", explicitTrackId: explicitId },
        step % 3 === 0 ? null : { startMs: 0, endMs: t },
      );
      const selBad = nonFinitePaths(selection);
      if (selBad.length > 0) record(step, action, "non_finite_selection", selBad.join(","));
      if (selection.ok) {
        metrics.selectOk! += 1;
        if (!tracks.some((track) => track.trackId === selection.value.target.trackId))
          record(
            step,
            action,
            "selected_target_not_a_track",
            String(selection.value.target.trackId),
          );
        if (selection.value.confidence < 0 || selection.value.confidence > 1)
          record(
            step,
            action,
            "selection_confidence_out_of_unit",
            String(selection.value.confidence),
          );
        if (selection.value.allTracks.length !== tracks.length)
          record(
            step,
            action,
            "selection_all_tracks_mismatch",
            `${selection.value.allTracks.length} vs ${tracks.length}`,
          );
        const sequence = targetPoseSequence(file, selection.value.target);
        if (sequence.frames.length !== selection.value.target.frames.length)
          record(
            step,
            action,
            "target_pose_frame_count_mismatch",
            `${sequence.frames.length} vs ${selection.value.target.frames.length}`,
          );
        sequence.frames.forEach((frame, index) => {
          // PoseSequence documents frames "ascending by timestampMs".
          if (index > 0 && frame.timestampMs < sequence.frames[index - 1]!.timestampMs)
            record(step, action, "target_pose_not_ascending", String(index));
          if (frame.frameIndex !== index)
            record(
              step,
              action,
              "target_pose_frame_index_mismatch",
              `${frame.frameIndex}@${index}`,
            );
        });
        const seqBad = nonFinitePaths(
          sequence.frames.map((frame) => [frame.timestampMs, frame.confidence]),
        );
        if (seqBad.length > 0)
          record(step, action, "non_finite_target_pose_meta", seqBad.join(","));
        const others = otherPlayersWrists(tracks, selection.value.target.trackId);
        if (nonFinitePaths(others).length > 0) record(step, action, "non_finite_other_wrists", "");
      } else {
        metrics.selectFail! += 1;
        if (tracks.length > 0 && step % 2 === 0)
          record(step, action, "auto_selection_failed_with_tracks", stableJson(selection.failure));
        if (!selection.failure || typeof selection.failure.message !== "string")
          record(step, action, "selection_failure_without_message", stableJson(selection));
      }
      const seeded = initializeTargetFromSeed(tracks, seedMode);
      if (nonFinitePaths(seeded).length > 0) record(step, action, "non_finite_seed_identity", "");
      if (seeded.ok) {
        metrics.seedOk! += 1;
        const identity = seeded.value.identity;
        if (identity.trackId !== seeded.value.target.trackId)
          record(
            step,
            action,
            "seed_identity_track_mismatch",
            `${identity.trackId} vs ${seeded.value.target.trackId}`,
          );
        if (identity.confidence < 0 || identity.confidence > 1)
          record(step, action, "seed_confidence_out_of_unit", String(identity.confidence));
        if (identity.aliasTrackIds.includes(identity.trackId))
          record(step, action, "seed_alias_includes_self", String(identity.trackId));
        if (!tracks.some((track) => track.trackId === identity.trackId))
          record(step, action, "seed_target_not_a_track", String(identity.trackId));
        if (identity.seedMode !== seedMode.mode)
          record(step, action, "seed_mode_not_echoed", identity.seedMode);
      } else {
        metrics.seedFail! += 1;
        if (tracks.length === 0 && seeded.failure.code !== "player.no_tracks")
          record(step, action, "no_tracks_failure_code", seeded.failure.code);
      }
      trace.push({
        frames: file.frames.length,
        tracks: tracks.map((track) => [track.trackId, track.frames.length]),
        selection: selection.ok ? selection.value.target.trackId : selection.failure.code,
        seed: seeded.ok ? seeded.value.identity.trackId : seeded.failure.code,
      });
    };
    actions.forEach((action, step) => {
      try {
        let frameT = t + stepMs;
        let p: PeopleFile["frames"][number]["p"] = [];
        switch (action.kind) {
          case "frame":
            p = action.present
              .map((present, index) => (present ? person(index, frameT) : null))
              .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
            if (action.shuffle) p.reverse();
            break;
          case "frameNaN":
            p = people.map((_p, index) =>
              person(index, frameT, (mark) => {
                if (mark.n === "left_hip") mark.x = Number.NaN;
              }),
            );
            break;
          case "frameLowConfidence":
            p = people.map((_p, index) =>
              person(index, frameT, (mark) => {
                mark.v = 0.01;
              }),
            );
            p.forEach((entry) => {
              entry.c = 0.05;
            });
            break;
          case "frameDuplicateTime":
            frameT = t;
            p = people.map((_p, index) => person(index, frameT));
            break;
          case "frameSwapped": {
            p = people.map((_p, index) => person(index, frameT));
            if (p.length > 1) {
              const first = p[0]!;
              p[0] = p[p.length - 1]!;
              p[p.length - 1] = first;
            }
            break;
          }
          case "frameBackwards":
            frameT = t - action.deltaMs;
            p = people.map((_p, index) => person(index, frameT));
            break;
          case "gap":
            frameT = t + stepMs * (action.frames + 1);
            p = people.map((_p, index) => person(index, frameT));
            break;
        }
        file.frames.push({ t: frameT, p });
        t = Math.max(t, frameT);
        check(step, action);
      } catch (error) {
        metrics.throws! += 1;
        record(
          step,
          action,
          "unexpected_throw",
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    return { violations, trace: stableJson(trace), metrics };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Campaign 7 — coach-gate rank statistics (pure math surface)
// ═══════════════════════════════════════════════════════════════════════════

export type CoachAction =
  | { kind: "append"; score: number; quality: number }
  | { kind: "appendTie" }
  | { kind: "appendNonFinite"; which: "score" | "quality"; value: "nan" | "inf" }
  | { kind: "setMinGap"; minGap: number };

export const coachGatesMathCampaign: Campaign<CoachAction> = {
  name: "coach_gates_math",
  seedBase: 700_000,
  generate(seed) {
    const rand = new Rand(seed);
    const length = rand.int(SEQUENCE_LENGTH.min, SEQUENCE_LENGTH.max);
    const actions: CoachAction[] = [];
    for (let i = 0; i < length; i += 1) {
      const roll = rand.next();
      if (roll < 0.8)
        actions.push({
          kind: "append",
          score: rand.float(0, 100),
          quality: rand.int(1, 5) + (rand.chance(0.3) ? rand.float(-0.4, 0.4) : 0),
        });
      else if (roll < 0.9) actions.push({ kind: "appendTie" });
      else if (roll < 0.95)
        actions.push({
          kind: "appendNonFinite",
          which: rand.pick(["score", "quality"] as const),
          value: rand.pick(["nan", "inf"] as const),
        });
      else actions.push({ kind: "setMinGap", minGap: rand.float(0, 3) });
    }
    return actions;
  },
  describe(action) {
    return stableJson(action);
  },
  execute(actions) {
    const scores: number[] = [];
    const qualities: number[] = [];
    let minGap = 1;
    const violations: StepViolation[] = [];
    const trace: unknown[] = [];
    const metrics: Record<string, number> = {
      nonFiniteInputs: 0,
      spearmanNull: 0,
      agreementNull: 0,
    };
    const record = (step: number, action: CoachAction, rule: string, detail: string) =>
      violations.push({ step, action: stableJson(action), rule, detail, inputClass: "legal" });
    actions.forEach((action, step) => {
      switch (action.kind) {
        case "append":
          scores.push(action.score);
          qualities.push(action.quality);
          break;
        case "appendTie":
          scores.push(scores[scores.length - 1] ?? 50);
          qualities.push(qualities[qualities.length - 1] ?? 3);
          break;
        case "appendNonFinite": {
          const value = action.value === "nan" ? Number.NaN : Number.POSITIVE_INFINITY;
          scores.push(action.which === "score" ? value : 42);
          qualities.push(action.which === "quality" ? value : 3);
          metrics.nonFiniteInputs! += 1;
          break;
        }
        case "setMinGap":
          minGap = action.minGap;
          break;
      }
      const inputsFinite = scores.every(Number.isFinite) && qualities.every(Number.isFinite);
      const rho = spearman(scores, qualities);
      const rhoSwapped = spearman(qualities, scores);
      const rhoSelf = spearman(scores, scores);
      const rhoMonotone = spearman(
        scores,
        scores.map((value) => Math.exp(value / 50)),
      );
      const rhoReversed = spearman(
        scores,
        scores.map((value) => -value),
      );
      const agreement = pairwiseRankingAgreement(scores, qualities, minGap);
      const selfAgreement = pairwiseRankingAgreement(scores, scores, 1e-9);
      if (rho === null) metrics.spearmanNull! += 1;
      if (agreement === null) metrics.agreementNull! += 1;
      const outputs = {
        rho,
        rhoSwapped,
        rhoSelf,
        rhoMonotone,
        rhoReversed,
        agreement,
        selfAgreement,
      };
      const bad = nonFinitePaths(outputs);
      if (bad.length > 0)
        record(
          step,
          action,
          inputsFinite
            ? "non_finite_output_from_finite_input"
            : "non_finite_output_from_non_finite_input",
          bad.join(","),
        );
      if (rho !== null && Number.isFinite(rho) && (rho < -1 - 1e-9 || rho > 1 + 1e-9))
        record(step, action, "spearman_out_of_range", String(rho));
      if (inputsFinite && rho !== null && rhoSwapped !== null && Math.abs(rho - rhoSwapped) > 1e-9)
        record(step, action, "spearman_not_symmetric", `${rho} vs ${rhoSwapped}`);
      if (inputsFinite && rhoSelf !== null && Math.abs(rhoSelf - 1) > 1e-9)
        record(step, action, "spearman_self_not_one", String(rhoSelf));
      if (
        inputsFinite &&
        rhoSelf !== null &&
        rhoMonotone !== null &&
        Math.abs(rhoSelf - rhoMonotone) > 1e-9
      )
        record(step, action, "spearman_not_monotone_invariant", `${rhoSelf} vs ${rhoMonotone}`);
      if (
        inputsFinite &&
        rhoSelf !== null &&
        rhoReversed !== null &&
        Math.abs(rhoReversed + 1) > 1e-9
      )
        record(step, action, "spearman_reversed_not_minus_one", String(rhoReversed));
      if (
        scores.length >= 3 &&
        inputsFinite &&
        new Set(scores).size > 1 &&
        new Set(qualities).size > 1 &&
        rho === null
      )
        record(step, action, "spearman_null_on_valid_input", `n=${scores.length}`);
      if (agreement !== null) {
        if (agreement.agreement < 0 || agreement.agreement > 1)
          record(step, action, "agreement_out_of_unit", String(agreement.agreement));
        if (agreement.pairs <= 0 || !Number.isInteger(agreement.pairs))
          record(step, action, "agreement_pairs_invalid", String(agreement.pairs));
        if (agreement.pairs > (scores.length * (scores.length - 1)) / 2)
          record(step, action, "agreement_pairs_exceed_total", String(agreement.pairs));
      }
      if (inputsFinite && selfAgreement !== null && selfAgreement.agreement !== 1)
        record(step, action, "self_agreement_not_one", String(selfAgreement.agreement));
      trace.push(outputs);
    });
    return { violations, trace: stableJson(trace), metrics };
  },
};

// ─── registry ───────────────────────────────────────────────────────────────

export const CAMPAIGNS: readonly Campaign<unknown>[] = [
  sessionEngineCampaign,
  sessionBatchingCampaign,
  strokePipelineCampaign,
  ballTrackerCampaign,
  paddleTrackerCampaign,
  playerTrackerCampaign,
  coachGatesMathCampaign,
];

export function campaignByName(name: string): Campaign<unknown> {
  const found = CAMPAIGNS.find((campaign) => campaign.name === name);
  if (!found) throw new Error(`unknown stress campaign '${name}'`);
  return found;
}
