import { describe, expect, it } from "vitest";
import {
  SessionEventEngine,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../src/sessionEngine.js";
import {
  SessionAnalysisScheduler,
  type SessionAnalysisExecutor,
  type SessionAnalysisTask,
  type SessionAnalysisTaskOutcome,
} from "../src/sessionScheduler.js";
import { assessSessionOpsHealth, generateSessionOpsSummary } from "../src/sessionOpsHealth.js";

/**
 * Ops-health tests drive the REAL SessionEventEngine and the REAL
 * SessionAnalysisScheduler (same rig as sessionScheduler.test.ts: synthetic
 * wrist-speed streams, scripted executor behind the seam because real
 * per-event analysis needs native clips that do not exist on this box).
 * The report under test is derived exclusively from measured engine/scheduler
 * state — nothing here fabricates coverage or latency numbers.
 */

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

const fakeAnalysis = { id: "synthetic-analysis" } as unknown as NonNullable<
  SessionStrokeEvent["analysis"]
>;

function scriptedExecutor(
  script: (
    task: SessionAnalysisTask,
  ) => SessionAnalysisTaskOutcome | Promise<SessionAnalysisTaskOutcome>,
): SessionAnalysisExecutor & { calls: SessionAnalysisTask[] } {
  const calls: SessionAnalysisTask[] = [];
  return {
    executorId: "scripted-ops-health-executor",
    calls,
    async execute(task) {
      calls.push(task);
      return script(task);
    },
  };
}

function threeStrokeStream(): SpeedSample[] {
  return speedBumps(
    [
      { peakMs: 1200, height: 2.0, halfWidthMs: 120 },
      { peakMs: 3600, height: 2.2, halfWidthMs: 120 },
      { peakMs: 6000, height: 1.8, halfWidthMs: 120 },
    ],
    0,
    8200,
  );
}

async function runSession(
  sessionId: string,
  executor: SessionAnalysisExecutor,
): Promise<{ engine: SessionEventEngine; scheduler: SessionAnalysisScheduler }> {
  const engine = new SessionEventEngine({ sessionId });
  const scheduler = new SessionAnalysisScheduler({ engine, executor });
  for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
  scheduler.endOfStream();
  await scheduler.drained();
  return { engine, scheduler };
}

describe("assessSessionOpsHealth — measured session operations report", () => {
  it("full coverage: 3 detected, 3 extracted, 3 analyzed → healthy, complete, summary generated", async () => {
    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const { engine, scheduler } = await runSession("ops-healthy", executor);
    const report = assessSessionOpsHealth(engine.snapshot(), scheduler.metrics(), {
      endOfSession: true,
    });
    expect(report.eventsDetected).toBe(3);
    expect(report.clipsExtractionAttempted).toBe(3);
    expect(report.eventsAnalyzed).toBe(3);
    expect(report.eventsReady).toBe(3);
    expect(report.eventsDroppedBeforeQueue).toBe(0);
    expect(report.backlog.queueDepth).toBe(0);
    expect(report.backlog.inFlight).toBe(0);
    expect(report.sessionComplete).toBe(true);
    expect(report.failureSignals).toEqual([]);
    expect(report.verdict).toBe("healthy");
    // Latency is measured over all three settled events.
    expect(report.latency.settledCount).toBe(3);
    expect(report.latency.maxTotalLatencyMs).not.toBeNull();
    for (const event of report.events) {
      expect(event.analyzed).toBe(true);
      expect(event.totalLatencyMs).not.toBeNull();
    }
    const summary = generateSessionOpsSummary(report);
    expect(summary.status).toBe("generated");
    if (summary.status === "generated") {
      expect(summary.eventsDetected).toBe(3);
      expect(summary.eventsReady).toBe(3);
    }
  });

  it("HARD FAILURE: E1/E2/E3 detected but only E1 analyzed → PARTIAL_EVENT_ANALYSIS, verdict failed, summary refused", async () => {
    // E2/E3 fail extraction non-retryably: the scheduler handles each failure
    // honestly (revert to pending, reason recorded), but at end of session the
    // COVERAGE shortfall is still a hard production failure signal.
    const executor = scriptedExecutor((task) =>
      task.eventId === "E1"
        ? { status: "ready", analysis: fakeAnalysis }
        : { status: "failed", reason: "CLIP_EXTRACTION_FAILED (synthetic)", retryable: false },
    );
    const { engine, scheduler } = await runSession("ops-partial", executor);
    const report = assessSessionOpsHealth(engine.snapshot(), scheduler.metrics(), {
      endOfSession: true,
    });
    expect(report.eventsDetected).toBe(3);
    expect(report.eventsAnalyzed).toBe(1);
    expect(report.eventsUnanalyzedTracked).toBe(2);
    expect(report.failureSignals).toContain("PARTIAL_EVENT_ANALYSIS");
    expect(report.verdict).toBe("failed");
    expect(report.sessionComplete).toBe(false);
    // Per-event failure reasons are surfaced, never silent.
    const e2 = report.events.find((event) => event.eventId === "E2")!;
    expect(e2.analyzed).toBe(false);
    expect(e2.failures.some((reason) => reason.includes("CLIP_EXTRACTION_FAILED"))).toBe(true);
    // Coverage-gated summary refuses — never a summary over the E1 subset.
    const summary = generateSessionOpsSummary(report);
    expect(summary.status).toBe("refused");
    if (summary.status === "refused") {
      expect(summary.reason).toContain("1/3 events analyzed");
      expect(summary.reason).toContain("PARTIAL_EVENT_ANALYSIS");
    }
  });

  it("an abstained event counts as ANALYZED (honest negative), not a coverage failure", async () => {
    const executor = scriptedExecutor((task) =>
      task.eventId === "E2"
        ? { status: "abstained", abstainReason: "MULTI_STROKE_AMBIGUOUS (synthetic)" }
        : { status: "ready", analysis: fakeAnalysis },
    );
    const { engine, scheduler } = await runSession("ops-abstain", executor);
    const report = assessSessionOpsHealth(engine.snapshot(), scheduler.metrics(), {
      endOfSession: true,
    });
    expect(report.eventsAnalyzed).toBe(3);
    expect(report.eventsReady).toBe(2);
    expect(report.eventsAbstained).toBe(1);
    expect(report.failureSignals).toEqual([]);
    expect(report.verdict).toBe("healthy");
    expect(generateSessionOpsSummary(report).status).toBe("generated");
  });

  it("DROPPED_EVENTS: engine-detected events the scheduler never tracked are a hard failure", async () => {
    // Simulate an ops bug where closed events bypass the scheduler entirely:
    // feed the engine directly, then only hand E1 to a scheduler-tracked run.
    const engine = new SessionEventEngine({ sessionId: "ops-dropped" });
    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const scheduler = new SessionAnalysisScheduler({ engine, executor });
    // Push only the first stroke through the scheduler...
    const firstStroke = threeStrokeStream().filter((sample) => sample.timestampMs <= 2600);
    for (const sample of firstStroke) scheduler.pushSamples({ wrist: [sample] });
    // ...then the rest of the stream through the ENGINE directly, so E2/E3
    // close without the scheduler ever seeing them.
    const rest = threeStrokeStream().filter((sample) => sample.timestampMs > 2600);
    engine.push({ wrist: rest });
    engine.flush();
    await scheduler.drained();
    const report = assessSessionOpsHealth(engine.snapshot(), scheduler.metrics(), {
      endOfSession: true,
    });
    expect(report.eventsDetected).toBeGreaterThan(1);
    expect(report.eventsDroppedBeforeQueue).toBeGreaterThan(0);
    expect(report.failureSignals).toContain("DROPPED_EVENTS");
    expect(report.failureSignals).toContain("PARTIAL_EVENT_ANALYSIS");
    expect(report.verdict).toBe("failed");
    for (const event of report.events.filter((entry) => entry.droppedBeforeQueue)) {
      expect(event.extractionAttempted).toBe(false);
      expect(event.attempts).toBe(0);
    }
  });

  it("BACKLOG_NOT_DRAINED: end-of-session with queued/in-flight work is a hard failure; mid-session it is not", async () => {
    const engine = new SessionEventEngine({ sessionId: "ops-backlog" });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = scriptedExecutor(async () => {
      await gate;
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    for (const sample of threeStrokeStream()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    // Mid-session view: backlog is visible but NOT a failure signal yet.
    const midReport = assessSessionOpsHealth(engine.snapshot(), scheduler.metrics(), {
      endOfSession: false,
    });
    expect(midReport.backlog.inFlight).toBe(1);
    expect(midReport.backlog.queueDepth).toBe(2);
    expect(midReport.failureSignals).not.toContain("BACKLOG_NOT_DRAINED");
    expect(midReport.verdict).toBe("healthy");
    expect(midReport.sessionComplete).toBe(false);
    // Declared end-of-session with the same backlog: hard failure.
    const endReport = assessSessionOpsHealth(engine.snapshot(), scheduler.metrics(), {
      endOfSession: true,
    });
    expect(endReport.failureSignals).toContain("BACKLOG_NOT_DRAINED");
    expect(endReport.failureSignals).toContain("PARTIAL_EVENT_ANALYSIS");
    expect(endReport.verdict).toBe("failed");
    expect(generateSessionOpsSummary(endReport).status).toBe("refused");
    release();
    await scheduler.drained();
    const drainedReport = assessSessionOpsHealth(engine.snapshot(), scheduler.metrics(), {
      endOfSession: true,
    });
    expect(drainedReport.verdict).toBe("healthy");
    expect(drainedReport.sessionComplete).toBe(true);
  });

  it("LATE_SAMPLES_DROPPED degrades (not hard-fails) a fully analyzed session", async () => {
    const engine = new SessionEventEngine({ sessionId: "ops-late" });
    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const scheduler = new SessionAnalysisScheduler({ engine, executor });
    const stream = threeStrokeStream();
    for (const sample of stream) scheduler.pushSamples({ wrist: [sample] });
    // A late (behind-the-frontier) sample the engine must refuse.
    scheduler.pushSamples({ wrist: [{ timestampMs: 10, value: 0.5 }] });
    scheduler.endOfStream();
    await scheduler.drained();
    const session = engine.snapshot();
    expect(session.qualityState.droppedLateSamples).toBeGreaterThan(0);
    const report = assessSessionOpsHealth(session, scheduler.metrics(), { endOfSession: true });
    expect(report.eventsAnalyzed).toBe(report.eventsDetected);
    expect(report.failureSignals).toEqual(["LATE_SAMPLES_DROPPED"]);
    expect(report.verdict).toBe("degraded");
  });

  it("zero-event session: no coverage failure, but summary refuses (nothing to summarize)", () => {
    const engine = new SessionEventEngine({ sessionId: "ops-empty" });
    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const scheduler = new SessionAnalysisScheduler({ engine, executor });
    const report = assessSessionOpsHealth(engine.snapshot(), scheduler.metrics(), {
      endOfSession: true,
    });
    expect(report.eventsDetected).toBe(0);
    expect(report.failureSignals).toEqual([]);
    expect(report.sessionComplete).toBe(false);
    const summary = generateSessionOpsSummary(report);
    expect(summary.status).toBe("refused");
    if (summary.status === "refused") expect(summary.reason).toContain("NO_EVENTS_DETECTED");
  });
});
