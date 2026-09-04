import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { fail, failure, ok, type Result } from "@pickle/shared-types";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import { unavailable, type PoseSequence, type StrokeIdentity } from "@pickle/swing-domain";
import { GeometricPhaseSegmenter, GeometryBiomechanicsExtractor } from "@pickle/vision-geometry";
import type {
  IStrokeClassifier,
  ITechniqueScorer,
  ProviderDescriptor,
} from "@pickle/vision-contracts";
import {
  analyzeCapture,
  type CaptureAnalysisInput,
  type CaptureAnalysisOptions,
  type CaptureAnalysisRecord,
  type FusionProviders,
} from "../../../src/index.js";

/**
 * Adversarial pass 3 — scenarios S3–S6 against `analyzeCapture` at 4d812e1a:
 *   S3 concurrent same-analysisId runs (shared mutable state leak),
 *   S4 classifier hang with no deadline (fake timers),
 *   S5 degenerate pose sequences (1 frame, equal timestamps, NaN),
 *   S6 shadow scorer throwing synchronously.
 *
 * Providers are the REAL geometry + sm-v1 bundle unless a scenario swaps
 * one stage for a scripted double. `it.fails` marks reproductions of
 * findings (see the FINDING comment on each); flip to `it` once fixed.
 *
 * Seeded randomness: mulberry32(SEED) — recorded in the test names.
 */

const SEED = 0x9a5572a8;

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

const TRIGGER_MODEL = {
  providerId: "trigger.temporal-heuristic",
  modelVersion: "temporal-stroke-heuristic-2",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

const descriptor = (providerId: string): ProviderDescriptor => ({
  providerId,
  modelVersion: "attack-1",
  runtime: "deterministic",
  executionTarget: "on_device",
  artifactHash: null,
  inputSchemaVersion: 1,
  outputSchemaVersion: 1,
});

function providers(overrides: Partial<FusionProviders> = {}): FusionProviders {
  return {
    phase: new GeometricPhaseSegmenter({ aspectRatio: 1 }),
    biomechanics: new GeometryBiomechanicsExtractor(),
    scorer: new Sm1TechniqueScorer(),
    faultDetector: new CheckpointThresholdFaultDetector(),
    uncertainty: new EngineUncertaintyEstimator(),
    coach: new PriorityCoachingRanker(),
    classifier: null,
    shadowScorers: [],
    ...overrides,
  };
}

function captureInput(
  stroke: StrokeIdentity = { declared: "forehand_drive", predicted: null },
  sequence?: PoseSequence,
  window?: { startMs: number; endMs: number; peakMs: number | null },
): CaptureAnalysisInput {
  const generated = generateSwingSequence();
  const pose = sequence ?? generated.sequence;
  const w = window ?? generated.window;
  return {
    captureId: "capture-attack-3",
    pose,
    paddle: unavailable("paddle_detector_not_installed"),
    ball: unavailable("ball_tracker_not_installed"),
    trigger: {
      startMs: w.startMs,
      endMs: w.endMs,
      peakMotionMs: w.peakMs,
      confidence: 0.9,
      producedBy: TRIGGER_MODEL,
    },
    stroke,
    handedness: "right",
    cameraView: "side",
    capturedAtIso: "2026-08-27T18:00:00.000Z",
  };
}

const fixedOptions = (): CaptureAnalysisOptions => ({
  analysisId: "analysis-shared-id",
  sessionId: null,
  appVersion: "0.1.0",
  modelBundleVersion: "fusion-attack",
  nowIso: () => "2026-08-27T18:30:00.000Z",
  makeId: () => "run-constant",
});

/** Deep-walk a value and collect every non-finite number (path → value). */
function nonFiniteNumbers(value: unknown, path = "$", out: string[] = []): string[] {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(`${path}=${String(value)}`);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => nonFiniteNumbers(entry, `${path}[${index}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      nonFiniteNumbers(entry, `${path}.${key}`, out);
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wrap every stage of a provider bundle so each call yields for `delayFor(stage)` ms. */
function jittered(base: FusionProviders, delayFor: (stage: string) => number): FusionProviders {
  const wrap =
    <A extends unknown[], R>(stage: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await sleep(delayFor(stage));
      return fn(...args);
    };
  return {
    ...base,
    phase: {
      ...base.phase,
      segmentPhases: wrap("phase", base.phase.segmentPhases.bind(base.phase)),
    },
    biomechanics: {
      descriptor: base.biomechanics.descriptor,
      extract: wrap("biomechanics", base.biomechanics.extract.bind(base.biomechanics)),
    },
    scorer: {
      descriptor: base.scorer.descriptor,
      score: wrap("scorer", base.scorer.score.bind(base.scorer)),
    },
    faultDetector: {
      descriptor: base.faultDetector.descriptor,
      detectFaults: wrap("faults", base.faultDetector.detectFaults.bind(base.faultDetector)),
    },
    uncertainty: {
      descriptor: base.uncertainty.descriptor,
      estimate: wrap("uncertainty", base.uncertainty.estimate.bind(base.uncertainty)),
    },
    coach: {
      descriptor: base.coach.descriptor,
      rank: wrap("coach", base.coach.rank.bind(base.coach)),
    },
  };
}

function unwrap(result: Result<CaptureAnalysisRecord>): CaptureAnalysisRecord {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpected failure ${result.failure.code}`);
  return result.value;
}

describe("analyzeCapture — concurrent same analysisId + constant makeId (attack pass 3 / S3)", () => {
  it("HELD: two concurrent runs sharing providers, input, analysisId and a constant makeId produce structurally identical records", async () => {
    const shared = providers();
    const input = captureInput();
    const inputSnapshot = JSON.stringify(input);
    const options = fixedOptions();
    const [a, b] = await Promise.all([
      analyzeCapture(shared, input, options),
      analyzeCapture(shared, input, options),
    ]);
    const recordA = unwrap(a);
    const recordB = unwrap(b);
    expect(recordB).toEqual(recordA);
    expect(recordA.id).toBe("analysis-shared-id");
    expect(recordA.result?.id).toBe("analysis-shared-id");
    expect(recordA.result?.resultKind).toBe("scored");
    // No shared mutable state: the run lists are distinct objects with the
    // same length, and the caller's input was not mutated by either run.
    expect(recordA.modelRuns).not.toBe(recordB.modelRuns);
    expect(recordA.modelRuns.length).toBeGreaterThan(0);
    expect(recordA.modelRuns.every((run) => run.id === "run-constant")).toBe(true);
    expect(JSON.stringify(input)).toBe(inputSnapshot);
    // Serial reference run: concurrency changed nothing.
    const serial = unwrap(await analyzeCapture(providers(), captureInput(), fixedOptions()));
    expect(recordA).toEqual(serial);
  });

  it(`HELD: 12 interleaved runs with seeded per-stage jitter (seed 0x${SEED.toString(16)}) are byte-identical and the pose input is untouched`, async () => {
    const random = mulberry32(SEED);
    const shared = providers();
    const input = captureInput();
    const inputSnapshot = JSON.stringify(input);
    const options = fixedOptions();
    const runs = await Promise.all(
      Array.from({ length: 12 }, () =>
        analyzeCapture(
          jittered(shared, () => Math.floor(random() * 4)),
          input,
          options,
        ),
      ),
    );
    const records = runs.map(unwrap);
    const reference = JSON.stringify(records[0]);
    for (const record of records) expect(JSON.stringify(record)).toBe(reference);
    expect(JSON.stringify(input)).toBe(inputSnapshot);
    // Each record's model-run list has exactly one entry per stage —
    // no run from a sibling invocation leaked into another record.
    const expectedRuns = records[0]!.modelRuns.length;
    for (const record of records) expect(record.modelRuns.length).toBe(expectedRuns);
    expect(nonFiniteNumbers(records[0])).toEqual([]);
  });

  it("HELD: concurrent runs with a shared classifier + shadow scorer keep their runs and shadow arrays separate", async () => {
    let classifyCalls = 0;
    const classifier: IStrokeClassifier = {
      descriptor: descriptor("classifier.shared"),
      classify: async () => {
        classifyCalls += 1;
        await sleep(classifyCalls % 2);
        return ok({
          shotType: "forehand_drive" as const,
          confidence: 0.95,
          alternatives: [],
          producedBy: {
            providerId: "classifier.shared",
            modelVersion: "attack-1",
            runtime: "deterministic" as const,
            executionTarget: "on_device" as const,
            artifactHash: null,
          },
        });
      },
    };
    const shadow: ITechniqueScorer = {
      descriptor: descriptor("scorer.shadow-shared"),
      score: async () =>
        fail(failure("low_confidence", "shadow.abstain", "shadow abstained on purpose")),
    };
    const shared = providers({ classifier, shadowScorers: [shadow] });
    const input = captureInput();
    const options = fixedOptions();
    const records = (
      await Promise.all(Array.from({ length: 6 }, () => analyzeCapture(shared, input, options)))
    ).map(unwrap);
    const reference = JSON.stringify(records[0]);
    for (const record of records) {
      expect(JSON.stringify(record)).toBe(reference);
      expect(record.shadow.length).toBe(1);
      expect(record.shadow[0]!.run.status).toBe("abstained");
      expect(record.modelRuns.filter((run) => run.task === "stroke_classification").length).toBe(1);
    }
  });
});

describe("analyzeCapture — classifier hang with no deadline (attack pass 3 / S4)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("HELD (type-level + runtime): CaptureAnalysisOptions offers no deadline/timeout/signal and analyzeCapture takes no 4th argument", () => {
    expectTypeOf<CaptureAnalysisOptions>().not.toHaveProperty("deadline");
    expectTypeOf<CaptureAnalysisOptions>().not.toHaveProperty("deadlineMs");
    expectTypeOf<CaptureAnalysisOptions>().not.toHaveProperty("timeoutMs");
    expectTypeOf<CaptureAnalysisOptions>().not.toHaveProperty("signal");
    expectTypeOf<CaptureAnalysisOptions>().not.toHaveProperty("abortSignal");
    expect(analyzeCapture.length).toBe(3);
    const keys = Object.keys(fixedOptions());
    expect(keys).toEqual([
      "analysisId",
      "sessionId",
      "appVersion",
      "modelBundleVersion",
      "nowIso",
      "makeId",
    ]);
  });

  it("OBSERVED: a classifier that resolves after 10 s (fake timers) holds analyzeCapture unsettled for the full 10 s, then the run completes and is recorded", async () => {
    vi.useFakeTimers();
    const classifier: IStrokeClassifier = {
      descriptor: descriptor("classifier.slow"),
      classify: () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                ok({
                  shotType: "forehand_drive" as const,
                  confidence: 0.95,
                  alternatives: [],
                  producedBy: {
                    providerId: "classifier.slow",
                    modelVersion: "attack-1",
                    runtime: "deterministic" as const,
                    executionTarget: "on_device" as const,
                    artifactHash: null,
                  },
                }),
              ),
            10_000,
          );
        }),
    };
    let settled: "pending" | "resolved" | "rejected" = "pending";
    const promise = analyzeCapture(providers({ classifier }), captureInput(), fixedOptions());
    promise.then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    // Later stages are real async work; flush them.
    await vi.runAllTimersAsync();
    expect(settled).toBe("resolved");
    const record = unwrap(await promise);
    expect(record.strokeResolution).toMatchObject({
      kind: "predicted",
      shotType: "forehand_drive",
    });
    const classification = record.modelRuns.find((run) => run.task === "stroke_classification");
    expect(classification?.status).toBe("succeeded");
  });

  /**
   * FINDING (P2, 4d812e1a): analyzeCapture has NO deadline. A classifier
   * (or any provider) that never settles pins the whole analysis forever —
   * there is no timeout, no AbortSignal, no partial record, and the mobile
   * caller (apps/mobile/src/analysis/runCaptureAnalysis.ts:316) awaits it
   * unguarded AFTER reserving an analysis permit, so the permit is held
   * until server-side expiry. Device-side hang behaviour: UNKNOWN (not
   * runnable from Linux; this test proves the pipeline contract only).
   */
  it.fails(
    "FINDING: a never-settling classifier is converted to a typed failure within 10 minutes of fake time",
    async () => {
      vi.useFakeTimers();
      const classifier: IStrokeClassifier = {
        descriptor: descriptor("classifier.hung"),
        classify: () => new Promise(() => undefined),
      };
      let settled = false;
      const promise = analyzeCapture(providers({ classifier }), captureInput(), fixedOptions());
      promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled).toBe(true);
    },
  );

  it("OBSERVED (documents the hang): a never-settling classifier leaves analyzeCapture pending after 10 minutes of fake time with zero model runs observable", async () => {
    vi.useFakeTimers();
    const classifier: IStrokeClassifier = {
      descriptor: descriptor("classifier.hung"),
      classify: () => new Promise(() => undefined),
    };
    let settled = false;
    const promise = analyzeCapture(providers({ classifier }), captureInput(), fixedOptions());
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // nothing scheduled that could ever settle it
  });

  it("HELD: a hung stage in one run does not stall a concurrent independent run sharing the same providers", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const classifier: IStrokeClassifier = {
      descriptor: descriptor("classifier.half-hung"),
      classify: () => {
        calls += 1;
        if (calls === 1) return new Promise(() => undefined);
        return Promise.resolve(
          ok({
            shotType: "forehand_drive" as const,
            confidence: 0.95,
            alternatives: [],
            producedBy: {
              providerId: "classifier.half-hung",
              modelVersion: "attack-1",
              runtime: "deterministic" as const,
              executionTarget: "on_device" as const,
              artifactHash: null,
            },
          }),
        );
      },
    };
    const shared = providers({ classifier });
    const hung = analyzeCapture(shared, captureInput(), fixedOptions());
    let hungSettled = false;
    hung.then(
      () => {
        hungSettled = true;
      },
      () => {
        hungSettled = true;
      },
    );
    const healthy = analyzeCapture(shared, captureInput(), fixedOptions());
    await vi.runAllTimersAsync();
    const record = unwrap(await healthy);
    expect(record.result?.resultKind).toBe("scored");
    expect(hungSettled).toBe(false);
  });
});

describe("analyzeCapture — degenerate pose sequences (attack pass 3 / S5)", () => {
  function sequenceWith(frames: PoseSequence["frames"]): PoseSequence {
    const { sequence } = generateSwingSequence();
    return { ...sequence, frames };
  }
  const wideWindow = { startMs: 0, endMs: 5_000, peakMs: 1_000 };

  it("HELD: exactly 1 frame → typed low_confidence failure, no NaN anywhere", async () => {
    const { sequence } = generateSwingSequence();
    const one = sequenceWith([sequence.frames[0]!]);
    const result = await analyzeCapture(
      providers(),
      captureInput(undefined, one, wideWindow),
      fixedOptions(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["low_confidence", "corrupted_media"]).toContain(result.failure.kind);
    expect(result.failure.code).toBe("phase.too_few_pose_frames");
    expect(nonFiniteNumbers(result)).toEqual([]);
  });

  it("HELD: 2 frames with equal timestamps → typed low_confidence failure, no NaN anywhere", async () => {
    const { sequence } = generateSwingSequence();
    const [first, second] = sequence.frames;
    const twin = sequenceWith([first!, { ...second!, timestampMs: first!.timestampMs }]);
    const result = await analyzeCapture(
      providers(),
      captureInput(undefined, twin, wideWindow),
      fixedOptions(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["low_confidence", "corrupted_media"]).toContain(result.failure.kind);
    expect(nonFiniteNumbers(result)).toEqual([]);
  });

  it("HELD: 8 frames ALL at the same timestamp (passes the <6 gate, dt=0 everywhere) → typed failure, never a division-by-zero speed", async () => {
    const { sequence } = generateSwingSequence();
    const stuck = sequenceWith(
      sequence.frames.slice(0, 8).map((frame) => ({ ...frame, timestampMs: 1_000 })),
    );
    const result = await analyzeCapture(
      providers(),
      captureInput(undefined, stuck, wideWindow),
      fixedOptions(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.code).toBe("phase.wrist_not_tracked");
    expect(nonFiniteNumbers(result)).toEqual([]);
  });

  it("HELD: frames with NaN timestamps are excluded from the window → typed failure, no NaN leaks", async () => {
    const { sequence } = generateSwingSequence();
    const poisoned = sequenceWith(
      sequence.frames.map((frame, index) =>
        index % 2 === 0 ? { ...frame, timestampMs: Number.NaN } : frame,
      ),
    );
    const result = await analyzeCapture(
      providers(),
      captureInput(undefined, poisoned, wideWindow),
      fixedOptions(),
    );
    // Either a typed failure or a scored record — but never a non-finite number.
    if (!result.ok) {
      expect(["low_confidence", "corrupted_media"]).toContain(result.failure.kind);
    }
    expect(nonFiniteNumbers(result)).toEqual([]);
  });

  it("HELD: frames whose landmark coordinates are all NaN → typed failure or finite-only record, never NaN measurements/scores", async () => {
    const { sequence, window } = generateSwingSequence();
    const poisoned = sequenceWith(
      sequence.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) => ({ ...mark, x: Number.NaN, y: Number.NaN })),
      })),
    );
    const result = await analyzeCapture(
      providers(),
      captureInput(undefined, poisoned, window),
      fixedOptions(),
    );
    expect(nonFiniteNumbers(result)).toEqual([]);
    if (result.ok) {
      expect(result.value.result?.resultKind).not.toBe("scored");
    } else {
      expect(["low_confidence", "corrupted_media"]).toContain(result.failure.kind);
    }
  });

  it("HELD: a trigger window with NaN bounds → typed failure, no NaN leaks", async () => {
    const { sequence } = generateSwingSequence();
    const result = await analyzeCapture(
      providers(),
      captureInput(undefined, sequence, { startMs: Number.NaN, endMs: Number.NaN, peakMs: null }),
      fixedOptions(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(nonFiniteNumbers(result)).toEqual([]);
  });

  it("HELD: an inverted trigger window (start > end) → typed failure", async () => {
    const { sequence, window } = generateSwingSequence();
    const result = await analyzeCapture(
      providers(),
      captureInput(undefined, sequence, {
        startMs: window.endMs,
        endMs: window.startMs,
        peakMs: window.peakMs,
      }),
      fixedOptions(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(nonFiniteNumbers(result)).toEqual([]);
  });

  it("HELD: frames in REVERSED time order still yield finite-only output (typed failure or record)", async () => {
    const { sequence, window } = generateSwingSequence();
    const reversed = sequenceWith([...sequence.frames].reverse());
    const result = await analyzeCapture(
      providers(),
      captureInput(undefined, reversed, window),
      fixedOptions(),
    );
    expect(nonFiniteNumbers(result)).toEqual([]);
    if (result.ok) {
      expect(
        result.value.result?.overallScore === null ||
          Number.isFinite(result.value.result?.overallScore),
      ).toBe(true);
    }
  });

  it("HELD: 0 frames → fusion.empty_pose_sequence", async () => {
    const result = await analyzeCapture(
      providers(),
      captureInput(undefined, sequenceWith([]), wideWindow),
      fixedOptions(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("fusion.empty_pose_sequence");
  });
});

describe("analyzeCapture — shadow scorer throwing synchronously (attack pass 3 / S6)", () => {
  const syncThrowingShadow = (): ITechniqueScorer => ({
    descriptor: descriptor("scorer.shadow-sync-throw"),
    // Deliberately NOT async: a JS/native-bridge scorer can throw before
    // ever returning a promise.
    score: () => {
      throw new Error("shadow scorer exploded synchronously");
    },
  });
  const asyncThrowingShadow = (): ITechniqueScorer => ({
    descriptor: descriptor("scorer.shadow-async-throw"),
    score: async () => {
      throw new Error("shadow scorer exploded asynchronously");
    },
  });

  function primaryOnly(record: CaptureAnalysisRecord) {
    return {
      result: record.result,
      strokeResolution: record.strokeResolution,
      evidence: record.evidence,
      uncertainty: record.uncertainty,
      modalities: record.modalities,
      primaryRuns: record.modelRuns.filter(
        (run) => !run.model.providerId.startsWith("scorer.shadow"),
      ),
    };
  }

  it("CONTROL/HELD: an ASYNC-throwing shadow scorer leaves the primary result unchanged and lands as a failed shadow entry", async () => {
    const baseline = unwrap(await analyzeCapture(providers(), captureInput(), fixedOptions()));
    const shadowed = unwrap(
      await analyzeCapture(
        providers({ shadowScorers: [asyncThrowingShadow()] }),
        captureInput(),
        fixedOptions(),
      ),
    );
    expect(primaryOnly(shadowed)).toEqual(primaryOnly(baseline));
    expect(shadowed.shadow.length).toBe(1);
    expect(shadowed.shadow[0]!.overallScore).toBeNull();
    expect(shadowed.shadow[0]!.analysisConfidence).toBeNull();
    expect(shadowed.shadow[0]!.run.status).toBe("failed");
    expect(shadowed.shadow[0]!.run.failure?.code).toBe("technique_scoring.provider_crash");
    expect(shadowed.shadow[0]!.run.failure?.message).toContain("asynchronously");
  });

  /**
   * FINDING (P3 latent, 4d812e1a): the `run` wrapper in analyzeCapture.ts
   * (`await execute().catch(...)`, ~line 153) only converts REJECTIONS. A
   * provider whose method throws synchronously throws out of `execute()`
   * before `.catch` is attached, so the whole analyzeCapture promise rejects
   * — no typed failure, no record, no shadow entry — and the mobile caller
   * (runCaptureAnalysis.ts:316) has no try/catch around it, so the reserved
   * permit is never released (server-side expiry only). All shipped
   * providers are `async` methods today, so this is latent, but the shadow
   * seam exists precisely to plug in third-party/bridge scorers.
   */
  it.fails(
    "FINDING: a SYNC-throwing shadow scorer leaves the primary result unchanged and lands in the shadow array",
    async () => {
      const baseline = unwrap(await analyzeCapture(providers(), captureInput(), fixedOptions()));
      const shadowed = unwrap(
        await analyzeCapture(
          providers({ shadowScorers: [syncThrowingShadow()] }),
          captureInput(),
          fixedOptions(),
        ),
      );
      expect(primaryOnly(shadowed)).toEqual(primaryOnly(baseline));
      expect(shadowed.shadow.length).toBe(1);
      expect(shadowed.shadow[0]!.run.status).toBe("failed");
      expect(shadowed.shadow[0]!.run.failure?.code).toBe("technique_scoring.provider_crash");
    },
  );

  it("OBSERVED (documents the break): a SYNC-throwing shadow scorer rejects the entire analyzeCapture promise with the raw error", async () => {
    await expect(
      analyzeCapture(
        providers({ shadowScorers: [syncThrowingShadow()] }),
        captureInput(),
        fixedOptions(),
      ),
    ).rejects.toThrow("shadow scorer exploded synchronously");
  });

  it("OBSERVED (same root cause, PRIMARY stage): a SYNC-throwing primary scorer also rejects analyzeCapture instead of technique_scoring.provider_crash", async () => {
    const syncPrimary: ITechniqueScorer = {
      descriptor: descriptor("scorer.primary-sync-throw"),
      score: () => {
        throw new Error("primary scorer exploded synchronously");
      },
    };
    await expect(
      analyzeCapture(providers({ scorer: syncPrimary }), captureInput(), fixedOptions()),
    ).rejects.toThrow("primary scorer exploded synchronously");
  });

  it("HELD: a shadow scorer that REJECTS after the primary succeeded never alters the primary score, even 5 shadows deep", async () => {
    const baseline = unwrap(await analyzeCapture(providers(), captureInput(), fixedOptions()));
    const shadows: ITechniqueScorer[] = Array.from({ length: 5 }, (_, index) => ({
      descriptor: descriptor(`scorer.shadow-${index}`),
      score: async () => {
        if (index % 2 === 0) throw new Error(`shadow ${index} rejected`);
        return fail(failure("permanent", "shadow.model_load_failed", `shadow ${index} typed`));
      },
    }));
    const shadowed = unwrap(
      await analyzeCapture(providers({ shadowScorers: shadows }), captureInput(), fixedOptions()),
    );
    expect(primaryOnly(shadowed)).toEqual(primaryOnly(baseline));
    expect(shadowed.shadow.length).toBe(5);
    expect(shadowed.shadow.map((entry) => entry.run.failure?.code)).toEqual([
      "technique_scoring.provider_crash",
      "shadow.model_load_failed",
      "technique_scoring.provider_crash",
      "shadow.model_load_failed",
      "technique_scoring.provider_crash",
    ]);
    expect(shadowed.result?.overallScore).toBe(baseline.result?.overallScore);
  });
});
