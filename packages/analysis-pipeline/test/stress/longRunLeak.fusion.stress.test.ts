import { unavailable, type PoseSequence } from "@pickle/swing-domain";
import { evaluateCaptureQuality } from "@pickle/vision-geometry";
import { describe, expect, it } from "vitest";
import {
  analyzeCapture,
  evaluatePreAnalysisGate,
  type CaptureAnalysisRecord,
} from "../../src/index.js";
import { shippingProviders } from "../visibilityMatrix/runner.js";
import { buildCase, SCENARIOS, type ScenarioCase } from "../visibilityMatrix/scenarios.js";
import {
  CHECKPOINT_EVERY,
  HEAP_SLOPE_LIMIT_PCT_PER_100,
  STRESS_ITER,
  STRESS_SEED,
  campaignRuntime,
  gcAvailable,
  heapCheckpoint,
  heapSlope,
  nonFinitePaths,
  resourceDelta,
  resourceGrowth,
  resourceSnapshot,
  TimeoutTracker,
  stableStringify,
  timeDrift,
  writeArtifact,
  type HeapCheckpoint,
} from "./leakProbe.js";

/**
 * LONG-RUN LEAK — fusion pipeline (`evaluateCaptureQuality → evaluatePreAnalysisGate
 * → analyzeCapture` with the shipping provider bundle), invoked STRESS_ITER
 * times in ONE process. Inputs are the committed visibility-matrix
 * generators (seeded synthetic keypoint streams derived from the committed
 * swing fixture — no labels are fabricated, no datasets are touched).
 *
 * Per iteration (seed = STRESS_SEED + i, scenario = SCENARIOS[i mod n]):
 *   - determinism: the same (scenario, seed) run twice yields a byte-identical
 *     CaptureAnalysisRecord (ids/timestamps are injected constants),
 *   - no NaN/Infinity anywhere in the record or the gate decision,
 *   - abstention is bounded: the clean control (`must_score`) never abstains
 *     and `must_abstain` scenarios never score (the matrix' hard invariants),
 *   - invocation time is recorded for drift.
 * Every CHECKPOINT_EVERY iterations: explicit GC + heap + live handles.
 *
 *   STRESS_ITER=525 NODE_OPTIONS=--expose-gc npx vitest run test/stress/longRunLeak.fusion.stress.test.ts
 */

/** Exact live-timer accounting for the whole file (see TimeoutTracker). */
const timers = new TimeoutTracker().enable();

const NOW_ISO = "2026-09-04T00:00:00.000Z";
const TRIGGER_MODEL = {
  providerId: "trigger.temporal-heuristic",
  modelVersion: "temporal-stroke-heuristic-2",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

type Invocation =
  | { kind: "gate_rejected"; reasons: string[] }
  | { kind: "failed"; failureKind: string; code: string }
  | { kind: "record"; record: CaptureAnalysisRecord };

async function invokeFusion(sequence: PoseSequence, scenario: ScenarioCase): Promise<Invocation> {
  const gate = evaluatePreAnalysisGate({
    frame: null,
    pose: sequence,
    poseQuality: evaluateCaptureQuality(sequence),
    stroke: { windowStartMs: scenario.window.startMs, windowEndMs: scenario.window.endMs },
  });
  if (!gate.analyzable) return { kind: "gate_rejected", reasons: [...gate.reasons] };
  let ids = 0;
  const result = await analyzeCapture(
    shippingProviders(),
    {
      captureId: `stress-${scenario.scenarioId}-${scenario.seed}`,
      pose: sequence,
      paddle: unavailable("paddle_detector_not_installed"),
      ball: unavailable("ball_tracker_not_installed"),
      trigger: {
        startMs: scenario.window.startMs,
        endMs: scenario.window.endMs,
        peakMotionMs: scenario.peakHintMs,
        confidence: 0.9,
        producedBy: TRIGGER_MODEL,
      },
      stroke: { declared: "forehand_drive", predicted: null },
      handedness: scenario.handedness,
      cameraView: "side",
      capturedAtIso: NOW_ISO,
    },
    {
      analysisId: `analysis-${scenario.scenarioId}-${scenario.seed}`,
      sessionId: null,
      appVersion: "stress",
      modelBundleVersion: "on-device-fusion-1",
      nowIso: () => NOW_ISO,
      makeId: () => `id-${++ids}`,
    },
  );
  if (!result.ok) {
    return { kind: "failed", failureKind: result.failure.kind, code: result.failure.code };
  }
  return { kind: "record", record: result.value };
}

function outcomeOf(invocation: Invocation): string {
  if (invocation.kind !== "record") return invocation.kind;
  const { record } = invocation;
  if (!record.result) return "abstained_partial";
  if (record.result.resultKind !== "scored" || record.result.overallScore === null) {
    return "low_confidence";
  }
  return record.uncertainty.presentation === "normal" ? "scored_normal" : "scored_lower_confidence";
}

interface IterationRow {
  iteration: number;
  seed: number;
  scenarioId: string;
  expectation: ScenarioCase["expectation"];
  outcome: string;
  overallScore: number | null;
  analysisConfidence: number | null;
  frames: number;
  durationMs: number;
  deterministic: boolean;
  nonFinite: string[];
  violations: string[];
  /** Scenario is a documented gap (visibilityMatrix.knownGaps.test.ts `it.fails`). */
  knownGap: boolean;
  timeoutHandlesLeaked: number;
  /** Creation stacks of the timers counted above. */
  leakedTimerStacks: string[];
}

/** Scenarios whose semantic expectation is ALREADY known not to hold at HEAD
 * (pinned as `it.fails` in visibilityMatrix.knownGaps.test.ts). Their
 * violations are counted and reported, not treated as new failures; every
 * other property (determinism, finiteness, handles, heap) still applies. */
const KNOWN_GAP_SCENARIOS: ReadonlySet<string> = new Set([
  "multi_person_identity_switch",
  "multi_person_flicker",
  "spectator_static",
]);

interface FusionReport {
  version: "long-run-leak-fusion-1";
  plane: "linux_replay_proxy";
  unit: "analyzeCapture (+ evaluateCaptureQuality, evaluatePreAnalysisGate)";
  runtime: ReturnType<typeof campaignRuntime>;
  heap: HeapCheckpoint[];
  heapSlope: ReturnType<typeof heapSlope>;
  timeDrift: ReturnType<typeof timeDrift>;
  resourceDelta: ReturnType<typeof resourceDelta>;
  resourceGrowth: ReturnType<typeof resourceGrowth>;
  outcomes: Record<string, number>;
  abstentionByScenario: Record<string, { cases: number; abstained: number; rate: number }>;
  knownGapsReproduced: Record<string, { cases: number; violated: number; seeds: number[] }>;
  failures: IterationRow[];
  rows: IterationRow[];
}

function violationsFor(scenario: ScenarioCase, outcome: string): string[] {
  const scored = outcome === "scored_normal" || outcome === "scored_lower_confidence";
  const violations: string[] = [];
  if (scenario.expectation === "must_score" && !scored)
    violations.push("abstained_on_clean_control");
  if (scenario.expectation === "must_abstain" && scored)
    violations.push("scored_when_must_abstain");
  if (scenario.expectation === "must_not_be_confident" && outcome === "scored_normal") {
    violations.push("confident_when_must_not_be_confident");
  }
  return violations;
}

describe("long-run leak — fusion pipeline", () => {
  it(`invokes analyzeCapture ${STRESS_ITER}× in one process without heap growth, handle leaks, or non-determinism`, async () => {
    const startedAt = performance.now();
    const rows: IterationRow[] = [];
    const heap: HeapCheckpoint[] = [heapCheckpoint(0, startedAt)];
    const resourcesBefore = resourceSnapshot();
    const outcomes: Record<string, number> = {};
    const abstentionByScenario: FusionReport["abstentionByScenario"] = {};
    const knownGapsReproduced: FusionReport["knownGapsReproduced"] = {};

    for (let i = 0; i < STRESS_ITER; i += 1) {
      const seed = STRESS_SEED + i;
      const definition = SCENARIOS[i % SCENARIOS.length]!;
      const scenario = buildCase(definition, seed);
      const timersAtStart = await timers.mark();

      const t0 = performance.now();
      const first = await invokeFusion(scenario.sequence, scenario);
      const durationMs = performance.now() - t0;
      const second = await invokeFusion(scenario.sequence, scenario);
      const leakedTimers = await timers.leakedSince(timersAtStart);

      const outcome = outcomeOf(first);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      const bucket = (abstentionByScenario[definition.id] ??= { cases: 0, abstained: 0, rate: 0 });
      bucket.cases += 1;
      if (!outcome.startsWith("scored")) bucket.abstained += 1;
      bucket.rate = bucket.abstained / bucket.cases;

      const record = first.kind === "record" ? first.record : null;
      const violations = violationsFor(scenario, outcome);
      const knownGap = KNOWN_GAP_SCENARIOS.has(definition.id);
      if (knownGap) {
        const gap = (knownGapsReproduced[definition.id] ??= { cases: 0, violated: 0, seeds: [] });
        gap.cases += 1;
        if (violations.length > 0) {
          gap.violated += 1;
          gap.seeds.push(seed);
        }
      }
      rows.push({
        iteration: i,
        seed,
        scenarioId: definition.id,
        expectation: scenario.expectation,
        outcome,
        overallScore: record?.result?.overallScore ?? null,
        analysisConfidence: record ? record.uncertainty.analysisConfidence : null,
        frames: scenario.sequence.frames.length,
        durationMs,
        deterministic: stableStringify(first) === stableStringify(second),
        nonFinite: nonFinitePaths(first),
        violations,
        knownGap,
        timeoutHandlesLeaked: leakedTimers.length,
        leakedTimerStacks: leakedTimers,
      });

      if ((i + 1) % CHECKPOINT_EVERY === 0) heap.push(heapCheckpoint(i + 1, startedAt));
    }
    if (heap[heap.length - 1]!.iteration !== STRESS_ITER) {
      heap.push(heapCheckpoint(STRESS_ITER, startedAt));
    }

    const resourcesAfter = resourceSnapshot();
    const failures = rows.filter(
      (row) =>
        !row.deterministic ||
        row.nonFinite.length > 0 ||
        (row.violations.length > 0 && !row.knownGap) ||
        row.timeoutHandlesLeaked > 0,
    );
    const report: FusionReport = {
      version: "long-run-leak-fusion-1",
      plane: "linux_replay_proxy",
      unit: "analyzeCapture (+ evaluateCaptureQuality, evaluatePreAnalysisGate)",
      runtime: campaignRuntime(STRESS_ITER, startedAt),
      heap,
      heapSlope: heapSlope(heap),
      timeDrift: timeDrift(rows.map((row) => row.durationMs)),
      resourceDelta: resourceDelta(resourcesBefore, resourcesAfter),
      resourceGrowth: resourceGrowth(resourcesBefore, resourcesAfter),
      outcomes,
      abstentionByScenario,
      knownGapsReproduced,
      failures,
      rows,
    };
    const artifact = writeArtifact("fusion.json", report);
    writeArtifact("fusion.summary.json", { ...report, rows: undefined });

    expect(rows.length).toBe(STRESS_ITER);
    expect(failures, `per-iteration failures — see ${artifact}`).toEqual([]);
    // No handle/listener kind may have grown over the campaign.
    expect(report.resourceGrowth).toEqual({ handles: {}, processListeners: {} });
    // The clean control must score on every seed; there is no other place
    // abstention is allowed to be unbounded.
    const control = abstentionByScenario.full_body_clean;
    if (control) expect(control.abstained).toBe(0);
    if (gcAvailable && report.heapSlope.checkpointsUsed >= 3) {
      const monotoneLeak =
        report.heapSlope.pctPer100 > HEAP_SLOPE_LIMIT_PCT_PER_100 &&
        report.heapSlope.monotoneFraction >= 0.75;
      expect(monotoneLeak, `heap slope ${JSON.stringify(report.heapSlope)} — ${artifact}`).toBe(
        false,
      );
    }
  }, 1_800_000);
});
