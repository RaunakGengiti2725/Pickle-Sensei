import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import { unavailable } from "@pickle/swing-domain";
import { GeometricPhaseSegmenter, GeometryBiomechanicsExtractor } from "@pickle/vision-geometry";
import { analyzeCapture, FUSION_ENGINE_VERSION, type FusionProviders } from "../src/index.js";
import { SessionEventEngine, type SpeedSample } from "../src/sessionEngine.js";
import {
  SessionAnalysisScheduler,
  type SessionAnalysisExecutor,
  type SessionAnalysisTask,
  type SessionAnalysisTaskOutcome,
} from "../src/sessionScheduler.js";

/**
 * G21 — session product E2E on the TS stack: the REAL SessionEventEngine and
 * the REAL SessionAnalysisScheduler driving the REAL analyzeCapture fusion
 * pipeline per event. The ONLY seam that is not production code is the input:
 * a clearly-synthetic wrist-speed stream (event segmentation input) and the
 * deterministic generated pose sequence (analysis input) — native per-event
 * clip extraction does not exist on this box (NATIVE_CLIP_EXTRACTION gap,
 * D-040), so the extraction step is simulated while EVERYTHING downstream of
 * it (scheduling, retry, lifecycle, fusion analysis, record content) is real.
 */

const TRIGGER_MODEL = {
  providerId: "trigger.temporal-heuristic",
  modelVersion: "temporal-stroke-heuristic-2",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

function fusionProviders(): FusionProviders {
  return {
    phase: new GeometricPhaseSegmenter({ aspectRatio: 1 }),
    biomechanics: new GeometryBiomechanicsExtractor(),
    scorer: new Sm1TechniqueScorer(),
    faultDetector: new CheckpointThresholdFaultDetector(),
    uncertainty: new EngineUncertaintyEstimator(),
    coach: new PriorityCoachingRanker(),
    classifier: null,
    shadowScorers: [],
  };
}

/** Executor that runs the REAL fusion pipeline for each closed event. The
 * pose sequence is deterministic synthetic data (extraction gap stand-in);
 * the analysis itself — phases, biomechanics, scoring, faults, uncertainty,
 * coaching — is the production engine. */
function realAnalysisExecutor(
  intercept?: (task: SessionAnalysisTask) => SessionAnalysisTaskOutcome | null,
): SessionAnalysisExecutor & { tasks: SessionAnalysisTask[] } {
  let idCounter = 0;
  const tasks: SessionAnalysisTask[] = [];
  return {
    executorId: "g21-real-fusion-executor",
    tasks,
    async execute(task) {
      tasks.push(task);
      const scripted = intercept?.(task);
      if (scripted) return scripted;
      const { sequence, window } = generateSwingSequence();
      const result = await analyzeCapture(
        fusionProviders(),
        {
          captureId: `capture-${task.eventId}`,
          pose: sequence,
          paddle: unavailable("paddle_detector_not_installed"),
          ball: unavailable("ball_tracker_not_installed"),
          trigger: {
            startMs: window.startMs,
            endMs: window.endMs,
            peakMotionMs: window.peakMs,
            confidence: task.proposal.confidence,
            producedBy: TRIGGER_MODEL,
          },
          stroke: { declared: "forehand_drive", predicted: null },
          handedness: "right",
          cameraView: "side",
          capturedAtIso: "2026-08-29T12:00:00.000Z",
        },
        {
          analysisId: `analysis-${task.eventId}-${++idCounter}`,
          sessionId: task.sessionId,
          appVersion: "0.1.0",
          modelBundleVersion: "fusion-test",
          nowIso: () => "2026-08-29T12:30:00.000Z",
          makeId: () => `run-${task.eventId}-${++idCounter}`,
        },
      );
      if (!result.ok) {
        return {
          status: "failed",
          reason: result.failure.code,
          retryable: result.failure.kind === "retryable" || result.failure.kind === "timeout",
        };
      }
      return { status: "ready", analysis: result.value };
    },
  };
}

function speedBumps(
  bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }>,
  fromMs: number,
  toMs: number,
  stepMs = 40,
): SpeedSample[] {
  const series: SpeedSample[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    let value = 0.08;
    for (const bump of bumps) {
      value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
    }
    series.push({ timestampMs: t, value });
  }
  return series;
}

/** 12 strokes: mostly settle-spaced, plus a rapid back-to-back pair
 * (E7/E8 ~900ms apart) exercising the next-event/valley close path. */
function twelveStrokeStream(): SpeedSample[] {
  const peaks = [
    1200,
    2800,
    4400,
    6000,
    7600,
    9200,
    10800,
    11700, // rapid pair
    13400,
    15000,
    16600,
    18200,
  ];
  return speedBumps(
    peaks.map((peakMs) => ({ peakMs, height: 2.0, halfWidthMs: 110 })),
    0,
    20400,
  );
}

describe("G21 session product E2E — real engine → real scheduler → real fusion analysis", () => {
  it("12 events incl. a rapid pair: every event terminal, ready events carry ACTUAL scored AnalysisRecords, FIFO order, backlog bounded", async () => {
    const engine = new SessionEventEngine({ sessionId: "g21-e2e-main" });
    const executor = realAnalysisExecutor((task) => {
      // E4: the analysis seam's honest abstention (scripted at the seam —
      // provider-level abstain path; content abstentions are covered by the
      // fusion engine's own tests).
      if (task.eventId === "E4") {
        return { status: "abstained", abstainReason: "SINGLE_MODALITY_LOW_CONFIDENCE" };
      }
      // E7 first attempt: simulated failed clip extraction (retryable) —
      // the retry must run the REAL analysis afterwards.
      if (task.eventId === "E7" && task.attempt === 1) {
        return {
          status: "failed",
          reason: "SESSION_CLIP_EXTRACTION_FAILED: rolling buffer miss",
          retryable: true,
        };
      }
      return null;
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 2 });
    for (const sample of twelveStrokeStream()) {
      scheduler.pushSamples({ wrist: [sample] });
      await Promise.resolve(); // let in-flight analyses progress mid-stream
    }
    scheduler.endOfStream();
    await scheduler.drained();

    const events = engine.snapshot().events;
    // 10+ events, append-only emission order E1..E12.
    expect(events.map((event) => event.eventId)).toEqual(
      Array.from({ length: 12 }, (_, i) => `E${i + 1}`),
    );
    // Event ordering: first dispatch attempts strictly FIFO by eventId.
    const firstAttempts = executor.tasks.filter((task) => task.attempt === 1);
    expect(firstAttempts.map((task) => task.eventId)).toEqual(events.map((event) => event.eventId));

    const metrics = scheduler.metrics();
    expect(metrics.enqueued).toBe(12);
    expect(metrics.ready).toBe(11);
    expect(metrics.abstained).toBe(1);
    expect(metrics.retries).toBe(1);
    expect(metrics.maxInFlight).toBeLessThanOrEqual(2);
    expect(metrics.maxQueueDepth).toBeGreaterThanOrEqual(1); // real backlog existed
    expect(metrics.duplicatesRefused).toBe(0);
    expect(metrics.executorThrows).toBe(0);

    // The user-facing content check: ready events hold the ACTUAL analysis
    // produced by the fusion engine — scored result, provenance, evidence —
    // not a state chip or a placeholder id.
    for (const event of events) {
      if (event.eventId === "E4") {
        expect(event.state).toBe("abstained");
        expect(event.abstainReason).toBe("SINGLE_MODALITY_LOW_CONFIDENCE");
        expect(event.analysis).toBeNull();
        continue;
      }
      expect(event.state).toBe("ready");
      const analysis = event.analysis!;
      expect(analysis.engineVersion).toBe(FUSION_ENGINE_VERSION);
      expect(analysis.captureId).toBe(`capture-${event.eventId}`);
      expect(analysis.result?.resultKind).toBe("scored");
      expect(analysis.result?.overallScore).not.toBeNull();
      expect(analysis.evidence.length).toBeGreaterThan(0);
      expect(analysis.modelRuns.map((run) => run.task)).toEqual(
        expect.arrayContaining([
          "phase_segmentation",
          "biomechanics_extraction",
          "technique_scoring",
          "fault_detection",
          "uncertainty_estimation",
          "coaching_ranking",
        ]),
      );
    }
    // E7's extraction failure is recorded, then the retry produced the real record.
    const e7 = metrics.tasks.find((task) => task.eventId === "E7")!;
    expect(e7.attempts).toBe(2);
    expect(e7.failures).toEqual(["attempt 1: SESSION_CLIP_EXTRACTION_FAILED: rolling buffer miss"]);
    expect(e7.outcome).toBe("ready");
  });

  it("stop during processing: suspend applies the in-flight REAL outcome, freezes the backlog; restart via recoverPending finishes with real content", async () => {
    const engine = new SessionEventEngine({ sessionId: "g21-e2e-stop" });
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const inner = realAnalysisExecutor();
    const gated: SessionAnalysisExecutor = {
      executorId: inner.executorId,
      async execute(task) {
        if (task.eventId === "E1" && task.attempt === 1) await firstGate;
        return inner.execute(task);
      },
    };
    const scheduler = new SessionAnalysisScheduler({ engine, executor: gated, concurrency: 1 });
    const stream = speedBumps(
      [1200, 2800, 4400, 6000].map((peakMs) => ({ peakMs, height: 2.0, halfWidthMs: 110 })),
      0,
      7200,
    );
    for (const sample of stream) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();

    // User stops the session while E1 is mid-analysis and E2..E4 are queued.
    scheduler.suspend();
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const mid = scheduler.metrics();
    // The in-flight result was applied (never dropped); nothing new dispatched.
    expect(engine.eventState("E1")).toBe("ready");
    expect(mid.dispatched).toBe(1);
    expect(mid.queueDepth).toBe(3);
    expect(mid.suspended).toBe(true);

    // Restart path: a NEW scheduler over the surviving engine (queue state
    // lost with the process) recovers exactly the non-terminal events.
    const restarted = new SessionAnalysisScheduler({
      engine,
      executor: realAnalysisExecutor(),
      concurrency: 1,
    });
    const readmitted = restarted.recoverPending();
    expect(readmitted).toEqual(["E2", "E3", "E4"]);
    // Duplicate recovery while queued must not double-dispatch.
    expect(restarted.recoverPending()).toEqual([]);
    await restarted.drained();
    for (const eventId of ["E1", "E2", "E3", "E4"]) {
      expect(engine.eventState(eventId)).toBe("ready");
    }
    for (const event of engine.snapshot().events) {
      expect(event.analysis?.result?.resultKind).toBe("scored");
    }
    expect(restarted.metrics().ready).toBe(3);
    expect(restarted.metrics().duplicatesRefused).toBe(0);
  });

  it("stale/duplicate protection: duplicate closure enqueue refused; a second outcome for a terminal event is rejected by the engine", async () => {
    const engine = new SessionEventEngine({ sessionId: "g21-e2e-stale" });
    const executor = realAnalysisExecutor();
    const scheduler = new SessionAnalysisScheduler({ engine, executor });
    const stream = speedBumps([{ peakMs: 1200, height: 2.0, halfWidthMs: 110 }], 0, 2600);
    for (const sample of stream) scheduler.pushSamples({ wrist: [sample] });
    const closed = scheduler.endOfStream();
    await scheduler.drained();
    expect(engine.eventState("E1")).toBe("ready");
    const readyAnalysis = engine.snapshot().events[0]!.analysis!;

    // Duplicate dispatch: re-offering the same closed event is refused.
    const flushed = closed.length > 0 ? closed : engine.snapshot().events;
    expect(flushed.map((event) => event.eventId)).toContain("E1");
    scheduler.recoverPending({ readmitExhausted: true });
    await scheduler.drained();
    expect(scheduler.metrics().dispatched).toBe(1);

    // Stale analysis: a late outcome for an already-terminal event must
    // throw (append-only), and the original record must survive untouched.
    expect(() => engine.markEvent("E1", "ready", { analysis: readyAnalysis })).toThrow();
    expect(() => engine.markEvent("E1", "pending")).toThrow();
    expect(engine.snapshot().events[0]!.analysis).toEqual(readyAnalysis);
  });
});
