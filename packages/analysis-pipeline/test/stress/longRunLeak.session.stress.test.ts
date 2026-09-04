import { unavailable } from "@pickle/swing-domain";
import type { AnalysisRecord } from "@pickle/swing-domain";
import { describe, expect, it } from "vitest";
import {
  analyzeCapture,
  SessionAnalysisScheduler,
  SessionEventEngine,
  type SessionAnalysisExecutor,
  type SessionAnalysisTask,
  type SessionAnalysisTaskOutcome,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../../src/index.js";
import { hashSeed, SeededRng } from "../visibilityMatrix/rng.js";
import { shippingProviders } from "../visibilityMatrix/runner.js";
import { buildCase, SCENARIOS } from "../visibilityMatrix/scenarios.js";
import {
  CHECKPOINT_EVERY,
  HEAP_SLOPE_LIMIT_PCT_PER_100,
  STRESS_ITER,
  STRESS_SEED,
  TimeoutTracker,
  campaignRuntime,
  gcAvailable,
  heapCheckpoint,
  heapSlope,
  median,
  nonFinitePaths,
  resourceDelta,
  resourceGrowth,
  resourceSnapshot,
  stableStringify,
  timeDrift,
  writeArtifact,
  type HeapCheckpoint,
} from "./leakProbe.js";

/**
 * LONG-RUN LEAK — session engine + scheduler.
 *
 * Campaign B (lifecycle churn): construct `SessionEventEngine` +
 * `SessionAnalysisScheduler` STRESS_ITER times in one process, feed each a
 * seeded synthetic wrist-speed stream (2–10 strokes, jittered, delivered in
 * random-sized batches, optional suspend/resume mid-stream), drain, drop.
 * Per iteration: every event terminal or honestly pending-with-recorded-failure,
 * no `processing` left after drain, ready ⇒ real AnalysisRecord, abstained ⇒
 * reason, metrics finite and consistent, engine output deterministic for the
 * seed (replayed), Timeout handles back to baseline.
 *
 * Campaign C (single long-lived session, invocation drift): ONE engine, fed
 * one sample at a time exactly as apps/mobile/src/flow/session.ts does
 * (`pushWristSample` then `snapshot()` per sample), for STRESS_ITER strokes.
 * Records per-50-stroke blocks: median/max push latency, median snapshot
 * latency, heap. This is the "invocation time drift" measurement of the lens.
 *
 * Campaign D (cancellation honoured): suspend() mid-flight → in-flight
 * outcomes still applied, no new dispatch while suspended, resume drains;
 * plus the abandonment probe: a `drained()` waiter on a suspended scheduler
 * that is then dropped — do its timers return to baseline?
 *
 *   STRESS_ITER=525 NODE_OPTIONS=--expose-gc npx vitest run test/stress/longRunLeak.session.stress.test.ts
 */

/** Exact live-timer accounting for the whole file (see TimeoutTracker). */
const timers = new TimeoutTracker().enable();

// ─── Seeded synthetic wrist-speed streams (same shape as the E2E suites) ────

interface Bump {
  peakMs: number;
  height: number;
  halfWidthMs: number;
}

function speedBumps(
  bumps: readonly Bump[],
  fromMs: number,
  toMs: number,
  stepMs: number,
  rng: SeededRng | null,
): SpeedSample[] {
  const series: SpeedSample[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    let value = 0.08;
    for (const bump of bumps) {
      value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
    }
    if (rng) value = Math.max(0, value + 0.01 * rng.gaussian());
    series.push({ timestampMs: t, value });
  }
  return series;
}

interface StreamSpec {
  strokes: number;
  stepMs: number;
  bumps: Bump[];
  endMs: number;
}

function seededStream(rng: SeededRng, strokes: number): StreamSpec {
  const stepMs = rng.pick([33, 40]);
  const bumps: Bump[] = [];
  let t = rng.uniform(900, 1500);
  for (let i = 0; i < strokes; i += 1) {
    bumps.push({
      peakMs: Math.round(t),
      height: rng.uniform(1.2, 3.0),
      halfWidthMs: rng.uniform(90, 160),
    });
    t += rng.uniform(1400, 3200);
  }
  return { strokes, stepMs, bumps, endMs: Math.round(t + 1200) };
}

// ─── Executor: real AnalysisRecord for ready outcomes, seeded failure mix ────

let realRecordPromise: Promise<AnalysisRecord> | null = null;

/** One REAL record from the shipping pipeline on the committed clean control
 * (seed 1); cloned per ready outcome so every event holds its own object. */
function realAnalysisRecord(): Promise<AnalysisRecord> {
  realRecordPromise ??= (async () => {
    const control = SCENARIOS.find((entry) => entry.id === "full_body_clean");
    if (!control) throw new Error("full_body_clean scenario missing");
    const scenario = buildCase(control, 1);
    let ids = 0;
    const result = await analyzeCapture(
      shippingProviders(),
      {
        captureId: "stress-real-record",
        pose: scenario.sequence,
        paddle: unavailable("paddle_detector_not_installed"),
        ball: unavailable("ball_tracker_not_installed"),
        trigger: {
          startMs: scenario.window.startMs,
          endMs: scenario.window.endMs,
          peakMotionMs: scenario.peakHintMs,
          confidence: 0.9,
          producedBy: {
            providerId: "trigger.temporal-heuristic",
            modelVersion: "temporal-stroke-heuristic-2",
            runtime: "deterministic",
            executionTarget: "on_device",
            artifactHash: null,
          },
        },
        stroke: { declared: "forehand_drive", predicted: null },
        handedness: scenario.handedness,
        cameraView: "side",
        capturedAtIso: "2026-09-04T00:00:00.000Z",
      },
      {
        analysisId: "analysis-stress-real",
        sessionId: null,
        appVersion: "stress",
        modelBundleVersion: "on-device-fusion-1",
        nowIso: () => "2026-09-04T00:00:00.000Z",
        makeId: () => `id-${++ids}`,
      },
    );
    if (!result.ok) throw new Error(`clean control did not analyze: ${result.failure.code}`);
    if (!result.value.result || result.value.result.resultKind !== "scored") {
      throw new Error("clean control did not score — harness baseline broken");
    }
    return result.value;
  })();
  return realRecordPromise;
}

type ExecutorMode = "ready" | "abstain" | "retryable_then_ready" | "final_fail" | "throw";

function seededExecutor(
  rng: SeededRng,
  record: AnalysisRecord,
  delay: "microtask" | "timer",
): SessionAnalysisExecutor & { calls: SessionAnalysisTask[] } {
  const modeByEvent = new Map<string, ExecutorMode>();
  const calls: SessionAnalysisTask[] = [];
  return {
    executorId: "stress-seeded-executor",
    calls,
    execute(task) {
      calls.push(task);
      let mode = modeByEvent.get(task.eventId);
      if (!mode) {
        const roll = rng.next();
        mode =
          roll < 0.6
            ? "ready"
            : roll < 0.75
              ? "abstain"
              : roll < 0.88
                ? "retryable_then_ready"
                : roll < 0.95
                  ? "final_fail"
                  : "throw";
        modeByEvent.set(task.eventId, mode);
      }
      if (mode === "throw" && task.attempt === 1) throw new Error("synthetic executor throw");
      const outcome = (): SessionAnalysisTaskOutcome => {
        switch (mode) {
          case "ready":
            return { status: "ready", analysis: structuredClone(record) };
          case "abstain":
            return { status: "abstained", abstainReason: "synthetic_abstain" };
          case "retryable_then_ready":
            return task.attempt === 1
              ? { status: "failed", reason: "synthetic_transient", retryable: true }
              : { status: "ready", analysis: structuredClone(record) };
          case "final_fail":
            return { status: "failed", reason: "synthetic_permanent", retryable: false };
          case "throw":
            return { status: "ready", analysis: structuredClone(record) };
        }
      };
      if (delay === "timer") {
        return new Promise((resolve) => setTimeout(() => resolve(outcome()), 0));
      }
      return Promise.resolve().then(outcome);
    },
  };
}

// ─── Campaign B ─────────────────────────────────────────────────────────────

interface LifecycleRow {
  iteration: number;
  seed: number;
  strokes: number;
  stepMs: number;
  samples: number;
  events: number;
  states: Record<string, number>;
  closeReasons: Record<string, number>;
  metrics: {
    enqueued: number;
    dispatched: number;
    retries: number;
    ready: number;
    abstained: number;
    failedFinal: number;
    retryExhausted: number;
    executorThrows: number;
    maxInFlight: number;
    queueDepth: number;
    inFlight: number;
  };
  suspendedMidStream: boolean;
  durationMs: number;
  /** Same seed, same batch schedule → identical emitted events (asserted). */
  deterministic: boolean;
  /** Whole-stream push emits the same events as the batched feed (recorded, not asserted). */
  batchInvariant: boolean;
  nonFinite: string[];
  invariantBreaches: string[];
  timeoutHandlesLeaked: number;
  leakedTimerStacks: string[];
}

function engineFingerprint(events: readonly SessionStrokeEvent[]): string {
  return stableStringify(
    events.map((event) => ({
      eventId: event.eventId,
      startMs: event.proposal.startMs,
      endMs: event.proposal.endMs,
      peakMs: event.proposal.peakMs,
      peakSpeed: event.proposal.peakSpeed,
      closeReason: event.closeReason,
      closedAtMs: event.closedAtMs,
    })),
  );
}

/** Bounds only — close reason/time legitimately differ between a live feed
 * and a single whole-stream push, so the batch diagnostic ignores them. */
function boundsFingerprint(events: readonly SessionStrokeEvent[]): string {
  return stableStringify(
    events.map((event) => ({
      startMs: event.proposal.startMs,
      endMs: event.proposal.endMs,
      peakMs: event.proposal.peakMs,
      peakSpeed: event.proposal.peakSpeed,
    })),
  );
}

async function runLifecycle(iteration: number, seed: number): Promise<LifecycleRow> {
  const record = await realAnalysisRecord();
  const rng = new SeededRng(hashSeed("long-run-leak-lifecycle", seed));
  const stream = seededStream(rng, 2 + rng.int(9));
  const samples = speedBumps(stream.bumps, 0, stream.endMs, stream.stepMs, rng);
  const concurrency = 1 + rng.int(3);
  const suspendMidStream = rng.chance(0.3);
  const executorDelay = rng.chance(0.5) ? "timer" : "microtask";
  const batches: SpeedSample[][] = [];
  for (let cursor = 0; cursor < samples.length;) {
    const size = 1 + rng.int(40);
    batches.push(samples.slice(cursor, cursor + size));
    cursor += size;
  }
  const executorRng = new SeededRng(hashSeed("long-run-leak-executor", seed));
  const timersAtStart = await timers.mark();

  const t0 = performance.now();
  const engine = new SessionEventEngine({ sessionId: `stress-${seed}` });
  const executor = seededExecutor(executorRng, record, executorDelay);
  const scheduler = new SessionAnalysisScheduler({
    engine,
    executor,
    concurrency,
    maxAttempts: 2,
  });
  batches.forEach((batch, index) => {
    scheduler.pushSamples({ wrist: batch });
    if (suspendMidStream && index === 2) scheduler.suspend();
    if (suspendMidStream && index === 5) scheduler.resume();
  });
  if (scheduler.metrics().suspended) scheduler.resume();
  scheduler.endOfStream();
  await scheduler.drained();
  const metrics = scheduler.metrics();
  const session = engine.snapshot();
  const durationMs = performance.now() - t0;

  // Replay the engine alone with the same batch schedule: emitted events must match.
  const replay = new SessionEventEngine({ sessionId: `stress-${seed}` });
  const replayed = batches.flatMap((batch) => replay.push({ wrist: batch }));
  replayed.push(...replay.flush());
  // Diagnostic: the whole stream in one push vs the batched feed.
  const whole = new SessionEventEngine({ sessionId: `stress-${seed}` });
  const wholeEvents = [...whole.push({ wrist: samples }), ...whole.flush()];

  const states: Record<string, number> = {};
  const closeReasons: Record<string, number> = {};
  const breaches: string[] = [];
  for (const event of session.events) {
    states[event.state] = (states[event.state] ?? 0) + 1;
    closeReasons[event.closeReason] = (closeReasons[event.closeReason] ?? 0) + 1;
    const task = metrics.tasks.find((entry) => entry.eventId === event.eventId);
    if (!task) breaches.push(`${event.eventId}: closed but never enqueued`);
    if (event.state === "processing") breaches.push(`${event.eventId}: processing after drain`);
    if (event.state === "ready" && !event.analysis)
      breaches.push(`${event.eventId}: ready without record`);
    if (event.state === "abstained" && !event.abstainReason) {
      breaches.push(`${event.eventId}: abstained without reason`);
    }
    if (event.state === "pending" && task) {
      if (task.outcome !== "failed_final" && task.outcome !== "retry_exhausted") {
        breaches.push(`${event.eventId}: pending after drain with outcome ${String(task.outcome)}`);
      }
      if (task.failures.length === 0)
        breaches.push(`${event.eventId}: pending with no recorded failure`);
    }
    if (event.proposal.endMs <= event.proposal.startMs) {
      breaches.push(`${event.eventId}: non-positive event duration`);
    }
  }
  if (metrics.enqueued !== session.events.length) breaches.push("enqueued != closed events");
  if (metrics.queueDepth !== 0 || metrics.inFlight !== 0)
    breaches.push("queue not empty after drain");
  if (metrics.maxInFlight > concurrency) breaches.push("concurrency bound exceeded");
  if (
    metrics.ready + metrics.abstained + metrics.failedFinal + metrics.retryExhausted !==
    metrics.enqueued
  ) {
    breaches.push("terminal task outcomes do not sum to enqueued");
  }
  if (metrics.duplicatesRefused !== 0) breaches.push("duplicate enqueue attempted");
  const leakedTimeouts = await timers.leakedSince(timersAtStart);

  return {
    iteration,
    seed,
    strokes: stream.strokes,
    stepMs: stream.stepMs,
    samples: samples.length,
    events: session.events.length,
    states,
    closeReasons,
    metrics: {
      enqueued: metrics.enqueued,
      dispatched: metrics.dispatched,
      retries: metrics.retries,
      ready: metrics.ready,
      abstained: metrics.abstained,
      failedFinal: metrics.failedFinal,
      retryExhausted: metrics.retryExhausted,
      executorThrows: metrics.executorThrows,
      maxInFlight: metrics.maxInFlight,
      queueDepth: metrics.queueDepth,
      inFlight: metrics.inFlight,
    },
    suspendedMidStream: suspendMidStream,
    durationMs,
    deterministic: engineFingerprint(session.events) === engineFingerprint(replayed),
    batchInvariant: boundsFingerprint(session.events) === boundsFingerprint(wholeEvents),
    nonFinite: [...nonFinitePaths(session, "session"), ...nonFinitePaths(metrics, "metrics")],
    invariantBreaches: breaches,
    timeoutHandlesLeaked: leakedTimeouts.length,
    leakedTimerStacks: leakedTimeouts,
  };
}

// ─── Campaign C ─────────────────────────────────────────────────────────────

interface DriftBlock {
  strokesDone: number;
  samplesDone: number;
  eventsEmitted: number;
  pushMedianMs: number;
  pushP95Ms: number;
  pushMaxMs: number;
  snapshotMedianMs: number;
  blockWallMs: number;
  heapUsedBytes: number;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

async function runLongSession(strokes: number, seed: number) {
  const record = await realAnalysisRecord();
  const rng = new SeededRng(hashSeed("long-run-leak-long-session", seed));
  const stream = seededStream(rng, strokes);
  const samples = speedBumps(stream.bumps, 0, stream.endMs, stream.stepMs, rng);
  const executor = seededExecutor(
    new SeededRng(hashSeed("long-run-leak-long-session-executor", seed)),
    record,
    "microtask",
  );
  const startedAt = performance.now();
  const engine = new SessionEventEngine({ sessionId: `stress-long-${seed}` });
  const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 2 });
  const blocks: DriftBlock[] = [];
  let blockPush: number[] = [];
  let blockSnapshot: number[] = [];
  let blockStart = performance.now();
  let strokesDone = 0;
  let emitted = 0;
  const closeBlock = (samplesDone: number, strokesNow: number): void => {
    strokesDone = strokesNow;
    blocks.push({
      strokesDone,
      samplesDone,
      eventsEmitted: emitted,
      pushMedianMs: median(blockPush),
      pushP95Ms: percentile(blockPush, 0.95),
      pushMaxMs: blockPush.reduce((acc, value) => Math.max(acc, value), 0),
      snapshotMedianMs: median(blockSnapshot),
      blockWallMs: performance.now() - blockStart,
      heapUsedBytes: heapCheckpoint(strokesDone, startedAt).heapUsedBytes,
    });
    blockPush = [];
    blockSnapshot = [];
    blockStart = performance.now();
  };
  // A block closes 900 ms after the peak of its last stroke (the stroke has
  // settled by then), so per-block latency covers whole strokes.
  const boundaryFor = (strokesNow: number): number => {
    const index = strokesNow + CHECKPOINT_EVERY - 1;
    return index < stream.bumps.length ? stream.bumps[index]!.peakMs + 900 : Infinity;
  };
  let nextBoundaryMs = boundaryFor(0);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    // Native samples arrive as separate events; yield to the macrotask queue
    // about once per second of session time so the scheduler's microtask
    // executor actually runs concurrently and the runner RPC is not starved.
    if (i % 25 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const t0 = performance.now();
    emitted += scheduler.pushSamples({ wrist: [sample] }).length;
    const t1 = performance.now();
    engine.snapshot();
    const t2 = performance.now();
    blockPush.push(t1 - t0);
    blockSnapshot.push(t2 - t1);
    if (sample.timestampMs >= nextBoundaryMs) {
      closeBlock(i + 1, strokesDone + CHECKPOINT_EVERY);
      nextBoundaryMs = boundaryFor(strokesDone);
    }
  }
  if (blockPush.length > 0) closeBlock(samples.length, stream.bumps.length);
  emitted += scheduler.endOfStream().length;
  await scheduler.drained();
  const session = engine.snapshot();
  const metrics = scheduler.metrics();
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  return {
    seed,
    strokes,
    stepMs: stream.stepMs,
    samples: samples.length,
    sessionDurationMs: stream.endMs,
    eventsEmitted: session.events.length,
    states: session.events.reduce<Record<string, number>>((acc, event) => {
      acc[event.state] = (acc[event.state] ?? 0) + 1;
      return acc;
    }, {}),
    metrics: { ...metrics, tasks: undefined },
    nonFinite: nonFinitePaths(session, "session"),
    blocks,
    drift:
      first && last
        ? {
            pushMedianRatio:
              first.pushMedianMs === 0 ? null : last.pushMedianMs / first.pushMedianMs,
            pushP95Ratio: first.pushP95Ms === 0 ? null : last.pushP95Ms / first.pushP95Ms,
            snapshotMedianRatio:
              first.snapshotMedianMs === 0 ? null : last.snapshotMedianMs / first.snapshotMedianMs,
            firstBlockWallMs: first.blockWallMs,
            lastBlockWallMs: last.blockWallMs,
          }
        : null,
    totalWallMs: performance.now() - startedAt,
  };
}

// ─── Campaign D ─────────────────────────────────────────────────────────────

async function runCancellationProbe(seed: number) {
  const record = await realAnalysisRecord();
  const rng = new SeededRng(hashSeed("long-run-leak-cancel", seed));
  const stream = seededStream(rng, 8);
  const samples = speedBumps(stream.bumps, 0, stream.endMs, stream.stepMs, rng);
  const before = resourceSnapshot();
  const timersAtStart = await timers.mark();

  // D1 — suspend mid-flight with a timer-backed executor.
  const engine = new SessionEventEngine({ sessionId: `stress-cancel-${seed}` });
  const executor = seededExecutor(
    new SeededRng(hashSeed("long-run-leak-cancel-exec", seed)),
    record,
    "timer",
  );
  const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
  scheduler.pushSamples({ wrist: samples });
  scheduler.endOfStream();
  const totalEvents = engine.snapshot().events.length;
  const dispatchedBeforeSuspend = scheduler.metrics().dispatched;
  scheduler.suspend();
  // Let the in-flight timer executor settle; nothing new may be dispatched.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const afterSuspend = scheduler.metrics();
  const breaches: string[] = [];
  if (afterSuspend.inFlight !== 0) breaches.push("in-flight work did not settle while suspended");
  if (afterSuspend.dispatched > dispatchedBeforeSuspend) {
    breaches.push("dispatched new work while suspended");
  }
  const settledWhileSuspended = engine
    .snapshot()
    .events.filter((event) => event.state === "ready" || event.state === "abstained").length;
  // The one in-flight attempt must have been APPLIED while suspended: either a
  // terminal outcome or a recorded failure (retryable → re-queued, honest).
  const startedTasks = afterSuspend.tasks.filter((task) => task.startedAt !== null);
  if (startedTasks.length !== dispatchedBeforeSuspend) {
    breaches.push("started task count != dispatched before suspend");
  }
  for (const task of startedTasks) {
    if (task.outcome === null && task.failures.length === 0) {
      breaches.push(`${task.eventId}: in-flight outcome dropped on suspend`);
    }
  }
  scheduler.resume();
  await scheduler.drained();
  const finalMetrics = scheduler.metrics();
  if (finalMetrics.queueDepth !== 0 || finalMetrics.inFlight !== 0)
    breaches.push("did not drain after resume");
  if (engine.snapshot().events.some((event) => event.state === "processing")) {
    breaches.push("processing left after resume+drain");
  }
  return {
    seed,
    totalEvents,
    dispatchedBeforeSuspend,
    settledWhileSuspended,
    finalStates: engine.snapshot().events.reduce<Record<string, number>>((acc, event) => {
      acc[event.state] = (acc[event.state] ?? 0) + 1;
      return acc;
    }, {}),
    breaches,
    timersLeaked: (await timers.leakedSince(timersAtStart)).length,
    resourceDeltaAfterSuspendResume: resourceDelta(before, resourceSnapshot()),
    resourceGrowthAfterSuspendResume: resourceGrowth(before, resourceSnapshot()),
  };
}

/** A `drained()` waiter on a suspended, non-empty scheduler whose owner then
 * drops every reference. The lens requires timers to return to baseline; this
 * records the Timeout-handle delta 25/100/250 ms after abandonment. */
/**
 * `drained()` on a SUSPENDED scheduler with queued work is documented to stay
 * pending until `resume()` (sessionScheduler.ts §drained). It waits by polling
 * a 5 ms timer, so while suspended the waiter keeps one live Timeout — and
 * through it the scheduler + engine — reachable even after the caller drops
 * every reference. This probe measures exactly that with async_hooks (a
 * process-wide handle count cannot tell "+1 unit, −1 runner" from 0), then
 * checks the other half of the contract: after `resume()` the promise settles
 * and the unit's live timers return to zero.
 */
async function runAbandonedDrainedWaiterProbe(seed: number) {
  const record = await realAnalysisRecord();
  const rng = new SeededRng(hashSeed("long-run-leak-abandon", seed));
  const stream = seededStream(rng, 6);
  const samples = speedBumps(stream.bumps, 0, stream.endMs, stream.stepMs, rng);
  const tracker = timers;
  {
    const scheduler = new SessionAnalysisScheduler({
      engine: new SessionEventEngine({ sessionId: `stress-abandon-${seed}` }),
      executor: seededExecutor(new SeededRng(seed), record, "microtask"),
      concurrency: 1,
    });
    scheduler.suspend();
    scheduler.pushSamples({ wrist: samples });
    scheduler.endOfStream();
    const queuedWhileSuspended = scheduler.metrics().queueDepth;
    const timersBeforeWaiter = await tracker.mark();
    let settled = false;
    const waiter = scheduler.drained().then(() => {
      settled = true;
    });
    // Only this WeakRef survives below — the strong reference is dropped.
    const weak = new WeakRef(scheduler);
    const liveTimersWhileSuspended: Array<{ afterMs: number; timers: number; stacks: string[] }> =
      [];
    let elapsed = 0;
    for (const afterMs of [25, 100, 250]) {
      await new Promise<void>((resolve) => setTimeout(resolve, afterMs - elapsed));
      elapsed = afterMs;
      if (typeof globalThis.gc === "function") globalThis.gc();
      const stacks = await tracker.leakedSince(timersBeforeWaiter);
      liveTimersWhileSuspended.push({ afterMs, timers: stacks.length, stacks });
    }
    const settledWhileSuspended = settled;
    const schedulerCollectedWhileSuspended = weak.deref() === undefined;
    // The other half of the contract: resume → waiter settles, timers gone.
    weak.deref()?.resume();
    await waiter;
    const finalStates = weak.deref()?.metrics() ?? null;
    if (typeof globalThis.gc === "function") globalThis.gc();
    const liveTimersAfterResume = (await tracker.leakedSince(timersBeforeWaiter)).length;
    return {
      seed,
      queuedWhileSuspended,
      liveTimersWhileSuspended,
      settledWhileSuspended,
      schedulerCollectedWhileSuspended,
      /** true ⇔ a timer the unit created is still alive 250 ms after the
       * caller dropped its reference (only the suspended waiter keeps it). */
      timerRetainedWhileSuspended:
        (liveTimersWhileSuspended[liveTimersWhileSuspended.length - 1]?.timers ?? 0) > 0,
      liveTimersAfterResume,
      queueDepthAfterResume: finalStates?.queueDepth ?? null,
      inFlightAfterResume: finalStates?.inFlight ?? null,
    };
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("long-run leak — session engine + scheduler", () => {
  it(`B: constructs, drives and drops engine+scheduler ${STRESS_ITER}× with handles/heap back to baseline`, async () => {
    const startedAt = performance.now();
    await realAnalysisRecord();
    const resourcesBefore = resourceSnapshot();
    const heap: HeapCheckpoint[] = [heapCheckpoint(0, startedAt)];
    const rows: LifecycleRow[] = [];
    for (let i = 0; i < STRESS_ITER; i += 1) {
      rows.push(await runLifecycle(i, STRESS_SEED + i));
      if ((i + 1) % CHECKPOINT_EVERY === 0) heap.push(heapCheckpoint(i + 1, startedAt));
    }
    if (heap[heap.length - 1]!.iteration !== STRESS_ITER)
      heap.push(heapCheckpoint(STRESS_ITER, startedAt));
    const failures = rows.filter(
      (row) =>
        !row.deterministic ||
        row.nonFinite.length > 0 ||
        row.invariantBreaches.length > 0 ||
        row.timeoutHandlesLeaked > 0 ||
        row.events === 0,
    );
    const report = {
      version: "long-run-leak-session-lifecycle-1",
      plane: "linux_replay_proxy",
      unit: "SessionEventEngine + SessionAnalysisScheduler (seeded executor, real AnalysisRecord)",
      runtime: campaignRuntime(STRESS_ITER, startedAt),
      heap,
      heapSlope: heapSlope(heap),
      timeDrift: timeDrift(rows.map((row) => row.durationMs)),
      resourceDelta: resourceDelta(resourcesBefore, resourceSnapshot()),
      resourceGrowth: resourceGrowth(resourcesBefore, resourceSnapshot()),
      batchInvariantRows: rows.filter((row) => row.batchInvariant).length,
      totals: rows.reduce(
        (acc, row) => {
          acc.samples += row.samples;
          acc.events += row.events;
          acc.dispatched += row.metrics.dispatched;
          acc.retries += row.metrics.retries;
          acc.executorThrows += row.metrics.executorThrows;
          for (const [state, count] of Object.entries(row.states)) {
            acc.states[state] = (acc.states[state] ?? 0) + count;
          }
          return acc;
        },
        {
          samples: 0,
          events: 0,
          dispatched: 0,
          retries: 0,
          executorThrows: 0,
          states: {} as Record<string, number>,
        },
      ),
      failures,
      rows,
    };
    const artifact = writeArtifact("session-lifecycle.json", report);
    writeArtifact("session-lifecycle.summary.json", { ...report, rows: undefined });

    expect(rows.length).toBe(STRESS_ITER);
    expect(failures, `per-iteration failures — see ${artifact}`).toEqual([]);
    expect(report.resourceGrowth).toEqual({ handles: {}, processListeners: {} });
    if (gcAvailable && report.heapSlope.checkpointsUsed >= 3) {
      const monotoneLeak =
        report.heapSlope.pctPer100 > HEAP_SLOPE_LIMIT_PCT_PER_100 &&
        report.heapSlope.monotoneFraction >= 0.75;
      expect(monotoneLeak, `heap slope ${JSON.stringify(report.heapSlope)} — ${artifact}`).toBe(
        false,
      );
    }
  }, 1_800_000);

  it(`C: one live session of ${STRESS_ITER} strokes fed sample-by-sample — records per-50-stroke push/snapshot latency drift`, async () => {
    const result = await runLongSession(STRESS_ITER, STRESS_SEED);
    const artifact = writeArtifact("session-long-lived.json", result);
    expect(result.nonFinite, artifact).toEqual([]);
    expect(result.metrics.queueDepth).toBe(0);
    expect(result.metrics.inFlight).toBe(0);
    expect(result.states.processing ?? 0).toBe(0);
    // Every synthesized stroke is well separated (≥ 1.4 s) and well above the
    // event gates, so the engine must emit one event per stroke.
    expect(result.eventsEmitted).toBe(STRESS_ITER);
    // Real-time budget: the mobile flow pushes every native motion sample
    // through pushWristSample on the JS thread, so the sustained (median)
    // per-sample cost in the LAST block must stay under the sample interval
    // or the session falls progressively behind the camera.
    const last = result.blocks[result.blocks.length - 1]!;
    expect(
      last.pushMedianMs,
      `push median ${last.pushMedianMs.toFixed(2)}ms at ${last.samplesDone} samples exceeds the ${result.stepMs}ms sample interval (×${result.drift?.pushMedianRatio?.toFixed(1)} vs first block) — ${artifact}`,
    ).toBeLessThan(result.stepMs);
  }, 1_800_000);

  it("D: cancellation honoured — suspend keeps in-flight outcomes, blocks new dispatch, resume drains, handles back to baseline", async () => {
    const probes = [];
    const count = Math.max(1, Math.min(STRESS_ITER, 25));
    for (let i = 0; i < count; i += 1) probes.push(await runCancellationProbe(STRESS_SEED + i));
    const artifact = writeArtifact("session-cancellation.json", { count, probes });
    for (const probe of probes) {
      expect(probe.breaches, `seed ${probe.seed} — ${artifact}`).toEqual([]);
      expect(probe.timersLeaked, `seed ${probe.seed} timers — ${artifact}`).toBe(0);
      expect(probe.resourceGrowthAfterSuspendResume).toEqual({ handles: {}, processListeners: {} });
    }
  }, 600_000);

  // Last on purpose: if the waiter's timer does not die it would skew every
  // later handle baseline in this worker.
  it("D2: an abandoned drained() waiter on a suspended scheduler must not keep a timer alive", async () => {
    const probe = await runAbandonedDrainedWaiterProbe(STRESS_SEED);
    const artifact = writeArtifact("session-abandoned-waiter.json", probe);
    expect(probe.queuedWhileSuspended).toBeGreaterThan(0);
    // Documented: pending until resume. Recorded (not asserted away): the
    // pending waiter keeps exactly one polling timer + the scheduler alive.
    expect(probe.settledWhileSuspended).toBe(false);
    expect(probe.schedulerCollectedWhileSuspended).toBe(false);
    for (const sample of probe.liveTimersWhileSuspended) {
      expect(sample.timers, `${sample.afterMs} ms — ${artifact}`).toBeLessThanOrEqual(1);
    }
    expect(probe.queueDepthAfterResume).toBe(0);
    expect(probe.inFlightAfterResume).toBe(0);
    expect(probe.liveTimersAfterResume, `timers alive after resume+drain — ${artifact}`).toBe(0);
  }, 60_000);
});
