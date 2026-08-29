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
  type SessionAnalysisTask,
  type SessionAnalysisTaskOutcome,
} from "../src/sessionScheduler.js";

/**
 * Wave H (h11-session-cert) — full Session lifecycle certification.
 *
 * Unlike the scheduler suites (which script executor outcomes), this suite
 * runs the REAL fusion engine (`analyzeCapture` with the production provider
 * bundle) behind the executor seam, so every 'ready' event carries a real,
 * provenance-complete AnalysisRecord whose CONTENT is asserted per event —
 * not just lifecycle state chips. The pose input is the synthetic
 * `generateSwingSequence` fixture (Apple Vision pose extraction does not
 * exist on Linux — NATIVE_CLIP_EXTRACTION gap, D-040); the segmentation,
 * scheduling, and fusion stages are all production code.
 */

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

const TRIGGER_MODEL = {
  providerId: "trigger.session-engine",
  modelVersion: "session-engine-1",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

let idCounter = 0;

/** Real per-event fusion behind the executor seam: each event analyzes its
 * own capture (captureId = capture-<eventId>) so routing is verifiable. */
async function fuseEvent(task: SessionAnalysisTask): Promise<SessionAnalysisTaskOutcome> {
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
      capturedAtIso: "2026-08-29T17:00:00.000Z",
    },
    {
      analysisId: `analysis-${task.sessionId}-${task.eventId}`,
      sessionId: task.sessionId,
      appVersion: "0.1.0",
      modelBundleVersion: "h11-cert",
      nowIso: () => "2026-08-29T17:30:00.000Z",
      makeId: () => `run-${++idCounter}`,
    },
  );
  if (!result.ok) {
    return { status: "failed", reason: `fusion: ${result.failure.code}`, retryable: false };
  }
  return { status: "ready", analysis: result.value };
}

function speedBumps(
  bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }>,
  fromMs = 0,
  toMs = 8000,
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

/** 12 strokes over ~26s, including a rapid pair 900ms apart. */
function twelveStrokeStream(): SpeedSample[] {
  const peaks = [1200, 3200, 5200, 7200, 9200, 11200, 12100, 14200, 16800, 19200, 21600, 24000];
  return speedBumps(
    peaks.map((peakMs) => ({ peakMs, height: 2.0, halfWidthMs: 110 })),
    0,
    26000,
  );
}

describe("Wave H h11 — full Session lifecycle with real per-event analysis content", () => {
  it("start → E1..E12 analyzed progressively while recording continues → stop → every event carries a real, correctly-routed AnalysisRecord", async () => {
    const engine = new SessionEventEngine({ sessionId: "h11-full-lifecycle" });
    const dispatchedWhileRecording: string[] = [];
    let lastPushedMs = 0;
    let streamEnded = false;
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor: {
        executorId: "h11-real-fusion-executor",
        async execute(task) {
          if (!streamEnded) dispatchedWhileRecording.push(`${task.eventId}@${lastPushedMs}`);
          return fuseEvent(task);
        },
      },
      concurrency: 2,
    });

    for (const sample of twelveStrokeStream()) {
      lastPushedMs = sample.timestampMs;
      scheduler.pushSamples({ wrist: [sample] });
      // Yield so in-flight fusion promises can settle mid-stream — the
      // progressive property under certification.
      await Promise.resolve();
    }
    streamEnded = true;
    scheduler.endOfStream();
    await scheduler.drained();

    const events = engine.snapshot().events;
    const metrics = scheduler.metrics();
    // 10+ events actually closed and analyzed.
    expect(events.length).toBeGreaterThanOrEqual(10);
    expect(metrics.enqueued).toBe(events.length);
    expect(metrics.ready).toBe(events.length);
    expect(metrics.duplicatesRefused).toBe(0);
    expect(metrics.executorThrows).toBe(0);
    // Progressive: at least one analysis was dispatched mid-recording.
    expect(dispatchedWhileRecording.length).toBeGreaterThan(0);

    for (const event of events) {
      expect(event.state).toBe("ready");
      const record = event.analysis;
      expect(record).not.toBeNull();
      if (!record) continue;
      // Routing: each event holds ITS OWN analysis, not a neighbor's.
      expect(record.captureId).toBe(`capture-${event.eventId}`);
      expect(record.id).toBe(`analysis-h11-full-lifecycle-${event.eventId}`);
      // Content: versioned, provenance-complete, actually scored.
      expect(record.engineVersion).toBe(FUSION_ENGINE_VERSION);
      expect(record.strokeResolution).toEqual({ kind: "declared", shotType: "forehand_drive" });
      expect(record.result?.resultKind).toBe("scored");
      expect(record.result?.overallScore).not.toBeNull();
      expect(record.modelRuns.map((run) => run.task)).toEqual(
        expect.arrayContaining([
          "phase_segmentation",
          "biomechanics_extraction",
          "technique_scoring",
          "fault_detection",
          "uncertainty_estimation",
          "coaching_ranking",
        ]),
      );
      expect(record.evidence.length).toBeGreaterThan(0);
      // Missing modalities disclosed, never fabricated.
      expect(record.modalities.paddle).toBe(false);
      expect(record.uncertainty.limitingFactors).toContain("paddle_track_unavailable");
    }

    // Event bounds are frozen and ordered (E1 < E2 < ...).
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.proposal.startMs).toBeGreaterThan(events[i - 1]!.proposal.endMs);
    }
  });

  it("stop during processing → suspend → recoverPending resumes with real analysis; duplicates refused; terminal results cannot be rewritten (stale-analysis guard)", async () => {
    const engine = new SessionEventEngine({ sessionId: "h11-stop-recover" });
    let failFirst = true;
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor: {
        executorId: "h11-recovery-executor",
        async execute(task) {
          if (task.eventId === "E1" && failFirst) {
            failFirst = false;
            return {
              status: "failed",
              reason: "CLIP_EXTRACTION_FAILED: simulated transient extraction failure",
              retryable: true,
            };
          }
          if (task.eventId === "E2") {
            return {
              status: "abstained",
              abstainReason: "CONTACT_DISAGREEMENT: modality spread 380ms",
            };
          }
          return fuseEvent(task);
        },
      },
      concurrency: 1,
      maxAttempts: 2,
    });

    const stream = speedBumps(
      [
        { peakMs: 1200, height: 2.0, halfWidthMs: 120 },
        { peakMs: 3600, height: 2.2, halfWidthMs: 120 },
        { peakMs: 6000, height: 1.8, halfWidthMs: 120 },
      ],
      0,
      8200,
    );
    for (const sample of stream) scheduler.pushSamples({ wrist: [sample] });
    // Stop mid-processing: samples pushed, work still queued/in flight.
    scheduler.suspend();
    scheduler.endOfStream();
    expect(scheduler.metrics().suspended).toBe(true);

    // Restart/recovery: resume + recoverPending re-admits nothing that is
    // already queued or in flight (duplicate dispatch refused, exactly-once).
    scheduler.resume();
    scheduler.recoverPending();
    await scheduler.drained();

    const metrics = scheduler.metrics();
    const events = engine.snapshot().events;
    expect(events.length).toBe(3);

    const e1 = events.find((event) => event.eventId === "E1")!;
    const e2 = events.find((event) => event.eventId === "E2")!;
    const e3 = events.find((event) => event.eventId === "E3")!;
    // Failed extraction retried, then produced a REAL record.
    expect(e1.state).toBe("ready");
    expect(e1.analysis?.captureId).toBe("capture-E1");
    expect(e1.analysis?.result?.resultKind).toBe("scored");
    expect(metrics.retries).toBeGreaterThanOrEqual(1);
    // Abstained event carries its honest reason and NO analysis record.
    expect(e2.state).toBe("abstained");
    expect(e2.abstainReason).toContain("CONTACT_DISAGREEMENT");
    expect(e2.analysis).toBeNull();
    expect(e3.state).toBe("ready");
    expect(e3.analysis?.captureId).toBe("capture-E3");

    // Duplicate dispatch after settle: terminal events are never re-admitted.
    const readmitted = scheduler.recoverPending();
    expect(readmitted).toEqual([]);

    // Stale analysis can never rewrite a terminal outcome.
    expect(() => engine.markEvent("E1", "processing")).toThrow(/append-only/);
    expect(() => engine.markEvent("E2", "ready", { analysis: e3.analysis! })).toThrow(
      /append-only/,
    );
  });

  it("unrecoverable extraction failure exhausts its attempt budget and leaves the event honestly pending — never fake ready/abstained", async () => {
    const engine = new SessionEventEngine({ sessionId: "h11-exhausted" });
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor: {
        executorId: "h11-broken-extraction-executor",
        async execute(task) {
          if (task.eventId === "E1") {
            return {
              status: "failed",
              reason: "CLIP_EXTRACTION_FAILED: encoder rejected every attempt",
              retryable: true,
            };
          }
          return fuseEvent(task);
        },
      },
      maxAttempts: 2,
    });
    for (const sample of speedBumps(
      [
        { peakMs: 1200, height: 2.0, halfWidthMs: 120 },
        { peakMs: 3600, height: 2.2, halfWidthMs: 120 },
      ],
      0,
      5000,
    )) {
      scheduler.pushSamples({ wrist: [sample] });
    }
    scheduler.endOfStream();
    await scheduler.drained();

    const [e1, e2] = engine.snapshot().events;
    expect(e1!.state).toBe("pending");
    expect(e1!.analysis).toBeNull();
    expect(e2!.state).toBe("ready");
    expect(e2!.analysis?.captureId).toBe("capture-E2");
    const metrics = scheduler.metrics();
    expect(metrics.retryExhausted).toBe(1);
    expect(metrics.ready).toBe(1);
    const e1Task = metrics.tasks.find((task) => task.eventId === "E1")!;
    expect(e1Task.failures.length).toBe(2);
    expect(e1Task.failures[0]).toContain("CLIP_EXTRACTION_FAILED");
  });
});
