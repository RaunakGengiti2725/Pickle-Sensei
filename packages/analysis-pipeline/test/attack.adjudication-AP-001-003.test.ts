import { describe, expect, it } from "vitest";
import {
  SessionEventEngine,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../src/sessionEngine.js";
import {
  SessionAnalysisScheduler,
  type SessionAnalysisExecutor,
  type SessionAnalysisTaskOutcome,
  type SessionSchedulerOptions,
} from "../src/sessionScheduler.js";

/**
 * ADVERSARIAL VARIANTS for cluster ADJ-AP-001 + ADJ-AP-002 + ADJ-AP-003
 * (baseline 4d812e1a). Every `it` asserts the behaviour a fix of the cluster
 * must deliver; each one FAILS at the baseline (see the attack report).
 *
 * Real SessionEventEngine + real SessionAnalysisScheduler; only the analysis
 * behind the executor seam is a test double. Synthetic wrist/paddle streams.
 */

function threeStrokes(): SpeedSample[] {
  const out: SpeedSample[] = [];
  for (let t = 0; t <= 8200; t += 40) {
    let value = 0.08;
    for (const peakMs of [1200, 3600, 6000]) {
      value += 2.0 * Math.exp(-0.5 * ((t - peakMs) / 120) ** 2);
    }
    out.push({ timestampMs: t, value });
  }
  return out;
}

/** ~30 fps stream, one stroke bump every 2.4 s, with mild capture jitter:
 * every 7th pair of frames arrives swapped (the mobile path receives frames
 * from an async callback; strict monotonic arrival is not guaranteed). */
function jitteredLiveStream(seconds: number, stepMs = 33): SpeedSample[] {
  const out: SpeedSample[] = [];
  for (let t = 0; t <= seconds * 1000; t += stepMs) {
    const phase = t % 2400;
    out.push({
      timestampMs: t,
      value: 0.08 + 2.0 * Math.exp(-0.5 * ((phase - 1200) / 120) ** 2),
    });
  }
  for (let i = 7; i + 1 < out.length; i += 7) {
    const a = out[i]!;
    out[i] = out[i + 1]!;
    out[i + 1] = a;
  }
  return out;
}

const fakeAnalysis = { id: "synthetic-analysis" } as unknown as NonNullable<
  SessionStrokeEvent["analysis"]
>;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "TIMEOUT"> {
  return Promise.race([
    promise,
    new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), ms)),
  ]);
}

/** The deadline option the cluster fix must add (ADJ-AP-003 acceptance names
 * it `taskTimeoutMs`). Typed loosely so this file compiles at the baseline. */
function withDeadline(
  options: SessionSchedulerOptions,
  taskTimeoutMs: number,
): SessionSchedulerOptions {
  return { ...options, taskTimeoutMs } as SessionSchedulerOptions;
}

describe("ADJ-AP-001 variants: per-push cost must stay bounded for the shipping feed shape", () => {
  it("wrist+paddle 30 fps feed with out-of-order arrival: minute-5 mean push cost <= 3x minute 1", () => {
    const engine = new SessionEventEngine({ sessionId: "attack-push-cost-jitter" });
    const perMinute: Array<{ minute: number; meanMs: number; maxMs: number }> = [];
    let windowStart = 0;
    let cost = 0;
    let max = 0;
    let count = 0;
    for (const sample of jitteredLiveStream(305)) {
      const t0 = performance.now();
      engine.push({ wrist: [sample], paddle: [{ ...sample, value: sample.value * 1.5 }] });
      const dt = performance.now() - t0;
      cost += dt;
      max = Math.max(max, dt);
      count += 1;
      if (sample.timestampMs - windowStart >= 60_000) {
        perMinute.push({ minute: perMinute.length + 1, meanMs: cost / count, maxMs: max });
        windowStart = sample.timestampMs;
        cost = 0;
        max = 0;
        count = 0;
      }
    }
    console.log(
      "ATTACK AP-001 jittered wrist+paddle push cost:",
      perMinute
        .map((r) => `m${r.minute} mean=${r.meanMs.toFixed(3)}ms max=${r.maxMs.toFixed(2)}ms`)
        .join(" | "),
    );
    const first = perMinute[0]!;
    const last = perMinute[perMinute.length - 1]!;
    expect(perMinute.length).toBe(5);
    expect(
      last.meanMs / first.meanMs,
      `per-push cost grew ${(last.meanMs / first.meanMs).toFixed(1)}x from minute 1 to minute ${last.minute}`,
    ).toBeLessThanOrEqual(3);
  }, 120_000);
});

describe("ADJ-AP-002 variants: EVERY engine transition the scheduler performs must be guarded", () => {
  it("retry path: event terminalized externally while in flight + executor returns retryable failure -> failed_final, queue continues", async () => {
    // The unguarded transition here is markEvent(...,'pending') (the failure
    // revert), not the 'ready' branch the original repro exercised.
    const engine = new SessionEventEngine({ sessionId: "attack-terminal-retry-path" });
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-retry-path",
      async execute(task): Promise<SessionAnalysisTaskOutcome> {
        if (task.eventId === "E1") {
          engine.markEvent(task.eventId, "ready", { analysis: fakeAnalysis });
          return { status: "failed", reason: "transient", retryable: true };
        }
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor,
      concurrency: 1,
      maxAttempts: 3,
    });
    scheduler.pushSamples({ wrist: threeStrokes() });
    scheduler.endOfStream();
    expect(engine.snapshot().events.map((e) => e.eventId)).toEqual(["E1", "E2", "E3"]);

    const drained = await withTimeout(
      scheduler.drained().then(
        () => "resolved" as const,
        (error: unknown) => ({ rejected: String(error) }),
      ),
      2_000,
    );
    const metrics = scheduler.metrics();
    console.log(
      "ATTACK AP-002/retry drained:",
      JSON.stringify(drained),
      metrics.tasks.map((t) => `${t.eventId}:${t.outcome}`).join(","),
      {
        queueDepth: metrics.queueDepth,
        inFlight: metrics.inFlight,
        dispatched: metrics.dispatched,
      },
    );
    expect(drained).toBe("resolved");
    expect(metrics.tasks.find((t) => t.eventId === "E1")?.outcome).toBe("failed_final");
    expect(metrics.tasks.find((t) => t.eventId === "E1")?.failures.join(" ")).toMatch(
      /ENGINE_TRANSITION/,
    );
    expect(metrics.dispatched).toBe(3);
    expect(metrics.inFlight).toBe(0);
    expect(metrics.queueDepth).toBe(0);
  });

  it("dispatch path: event terminalized externally while still QUEUED -> pump must not throw out of endOfStream() nor leak the slot", async () => {
    // markEvent(...,'processing') in dispatch() runs AFTER inFlightIds.add();
    // if it throws, the exception escapes pump() into the sample-feeding
    // caller and the slot is never released.
    const engine = new SessionEventEngine({ sessionId: "attack-terminal-queued" });
    let release: (() => void) | null = null;
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-queued-terminal",
      execute(task): Promise<SessionAnalysisTaskOutcome> {
        if (task.eventId === "E1") {
          return new Promise<SessionAnalysisTaskOutcome>((resolve) => {
            release = () => resolve({ status: "ready", analysis: fakeAnalysis });
          });
        }
        return Promise.resolve({ status: "ready", analysis: fakeAnalysis });
      },
    };
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    scheduler.pushSamples({ wrist: threeStrokes() });
    // E1 is in flight (held); E2/E3 are queued. A recovery/other writer
    // settles E2 before the scheduler ever dispatches it.
    expect(scheduler.metrics().inFlight).toBe(1);
    engine.markEvent("E2", "abstained", { abstainReason: "external_writer" });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let endOfStreamThrew: string | null = null;
    let drained: "resolved" | "TIMEOUT" | { rejected: string };
    try {
      release!();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      try {
        scheduler.endOfStream();
      } catch (error) {
        endOfStreamThrew = String(error);
      }
      drained = await withTimeout(
        scheduler.drained().then(
          () => "resolved" as const,
          (error: unknown) => ({ rejected: String(error) }),
        ),
        2_000,
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    const metrics = scheduler.metrics();
    console.log("ATTACK AP-002/queued endOfStream threw:", endOfStreamThrew, "drained:", drained, {
      unhandled: unhandled.map(String),
      inFlight: metrics.inFlight,
      queueDepth: metrics.queueDepth,
      tasks: metrics.tasks.map((t) => `${t.eventId}:${t.outcome}`),
    });
    expect(endOfStreamThrew, "engine transition errors must not escape the feed path").toBeNull();
    expect(unhandled, "engine transition errors must not surface as unhandled rejections").toEqual(
      [],
    );
    expect(drained).toBe("resolved");
    expect(metrics.inFlight, "no leaked concurrency slot").toBe(0);
    expect(metrics.tasks.find((t) => t.eventId === "E2")?.outcome).toBe("failed_final");
    expect(metrics.tasks.find((t) => t.eventId === "E3")?.outcome).toBe("ready");
  });

  it("suspend/resume: event terminalized externally while parked in the suspended queue -> resume() must not throw or leak the slot", async () => {
    const engine = new SessionEventEngine({ sessionId: "attack-terminal-suspended" });
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-suspended-terminal",
      async execute(): Promise<SessionAnalysisTaskOutcome> {
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    scheduler.suspend();
    scheduler.pushSamples({ wrist: threeStrokes() });
    scheduler.endOfStream();
    expect(scheduler.metrics().queueDepth).toBe(3);
    // App backgrounded (suspended); a recovery writer settles E1 meanwhile.
    engine.markEvent("E1", "abstained", { abstainReason: "external_writer" });

    let resumeThrew: string | null = null;
    try {
      scheduler.resume();
    } catch (error) {
      resumeThrew = String(error);
    }
    const drained = await withTimeout(
      scheduler.drained().then(
        () => "resolved" as const,
        (error: unknown) => ({ rejected: String(error) }),
      ),
      2_000,
    );
    const metrics = scheduler.metrics();
    console.log("ATTACK AP-002/suspended resume threw:", resumeThrew, "drained:", drained, {
      inFlight: metrics.inFlight,
      queueDepth: metrics.queueDepth,
      dispatched: metrics.dispatched,
      tasks: metrics.tasks.map((t) => `${t.eventId}:${t.outcome}`),
    });
    expect(resumeThrew, "resume() must never throw an engine transition error").toBeNull();
    expect(drained).toBe("resolved");
    expect(metrics.inFlight).toBe(0);
    expect(metrics.tasks.find((t) => t.eventId === "E1")?.outcome).toBe("failed_final");
    expect(metrics.dispatched).toBe(3);
    expect(engine.eventState("E2")).toBe("ready");
    expect(engine.eventState("E3")).toBe("ready");
  });

  it("concurrency 2: two events terminalized externally while in flight -> both failed_final, E3 still dispatched, drained() resolves", async () => {
    const engine = new SessionEventEngine({ sessionId: "attack-terminal-concurrency-2" });
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-concurrency-2",
      async execute(task): Promise<SessionAnalysisTaskOutcome> {
        if (task.eventId === "E1" || task.eventId === "E2") {
          engine.markEvent(task.eventId, "abstained", { abstainReason: "external_writer" });
        }
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 2 });
    scheduler.pushSamples({ wrist: threeStrokes() });
    scheduler.endOfStream();
    const drained = await withTimeout(
      scheduler.drained().then(
        () => "resolved" as const,
        (error: unknown) => ({ rejected: String(error) }),
      ),
      2_000,
    );
    const metrics = scheduler.metrics();
    console.log(
      "ATTACK AP-002/c2 drained:",
      JSON.stringify(drained),
      metrics.tasks.map((t) => `${t.eventId}:${t.outcome}`).join(","),
      {
        inFlight: metrics.inFlight,
        queueDepth: metrics.queueDepth,
        dispatched: metrics.dispatched,
      },
    );
    expect(drained).toBe("resolved");
    expect(metrics.failedFinal).toBe(2);
    expect(metrics.dispatched).toBe(3);
    expect(metrics.inFlight).toBe(0);
    expect(metrics.queueDepth).toBe(0);
  });
});

describe("ADJ-AP-003 variants: the per-task deadline must release the slot honestly", () => {
  it("hung E1 under a 200 ms deadline: EXECUTOR_TIMEOUT recorded, slot released, E2/E3 run, event honestly non-terminal", async () => {
    const engine = new SessionEventEngine({ sessionId: "attack-deadline-basic" });
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-hang",
      execute(task): Promise<SessionAnalysisTaskOutcome> {
        if (task.eventId === "E1") return new Promise<never>(() => {});
        return Promise.resolve({ status: "ready", analysis: fakeAnalysis });
      },
    };
    const scheduler = new SessionAnalysisScheduler(
      withDeadline({ engine, executor, concurrency: 1, maxAttempts: 1 }, 200),
    );
    scheduler.pushSamples({ wrist: threeStrokes() });
    scheduler.endOfStream();
    const drained = await withTimeout(
      scheduler.drained().then(() => "resolved" as const),
      3_000,
    );
    const metrics = scheduler.metrics();
    const e1 = metrics.tasks.find((t) => t.eventId === "E1");
    console.log("ATTACK AP-003/basic drained:", drained, {
      dispatched: metrics.dispatched,
      inFlight: metrics.inFlight,
      e1: e1 ? `${e1.outcome} ${e1.failures.join("; ")}` : null,
      states: engine.snapshot().events.map((e) => `${e.eventId}:${e.state}`),
    });
    expect(drained).toBe("resolved");
    expect(metrics.dispatched).toBe(3);
    expect(metrics.inFlight).toBe(0);
    expect(e1?.failures.join(" ")).toMatch(/EXECUTOR_TIMEOUT/);
    // A timed-out analysis is not a result: the event may not be 'ready' or
    // 'abstained', and it may not stay 'processing' with no worker attached.
    expect(engine.eventState("E1")).toBe("pending");
    expect(engine.eventState("E2")).toBe("ready");
    expect(engine.eventState("E3")).toBe("ready");
  });

  it("late settlement after the deadline is ignored: no second outcome applied, no throw, records untouched", async () => {
    const engine = new SessionEventEngine({ sessionId: "attack-deadline-late" });
    let settleLate: (() => void) | null = null;
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-late-settle",
      execute(task): Promise<SessionAnalysisTaskOutcome> {
        if (task.eventId === "E1") {
          return new Promise<SessionAnalysisTaskOutcome>((resolve) => {
            settleLate = () => resolve({ status: "ready", analysis: fakeAnalysis });
          });
        }
        return Promise.resolve({ status: "ready", analysis: fakeAnalysis });
      },
    };
    const scheduler = new SessionAnalysisScheduler(
      withDeadline({ engine, executor, concurrency: 1, maxAttempts: 1 }, 150),
    );
    scheduler.pushSamples({ wrist: threeStrokes() });
    scheduler.endOfStream();
    const drained = await withTimeout(
      scheduler.drained().then(() => "resolved" as const),
      3_000,
    );
    expect(drained).toBe("resolved");
    const before = JSON.stringify(scheduler.metrics().tasks);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      settleLate!();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    const after = JSON.stringify(scheduler.metrics().tasks);
    console.log("ATTACK AP-003/late unhandled:", unhandled.map(String), {
      e1State: engine.eventState("E1"),
      dispatched: scheduler.metrics().dispatched,
    });
    expect(unhandled).toEqual([]);
    expect(after).toBe(before);
    expect(engine.eventState("E1"), "a late result after timeout is not a result").not.toBe(
      "ready",
    );
    expect(scheduler.metrics().dispatched).toBe(3);
  });

  it("suspend() while a hung task is in flight, then resume(): the deadline still fires and drained() resolves", async () => {
    const engine = new SessionEventEngine({ sessionId: "attack-deadline-suspend" });
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-hang-suspend",
      execute(task): Promise<SessionAnalysisTaskOutcome> {
        if (task.eventId === "E1") return new Promise<never>(() => {});
        return Promise.resolve({ status: "ready", analysis: fakeAnalysis });
      },
    };
    const scheduler = new SessionAnalysisScheduler(
      withDeadline({ engine, executor, concurrency: 1, maxAttempts: 1 }, 150),
    );
    scheduler.pushSamples({ wrist: threeStrokes() });
    scheduler.endOfStream();
    scheduler.suspend();
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    const whileSuspended = scheduler.metrics();
    scheduler.resume();
    const drained = await withTimeout(
      scheduler.drained().then(() => "resolved" as const),
      3_000,
    );
    const metrics = scheduler.metrics();
    console.log("ATTACK AP-003/suspend:", {
      inFlightWhileSuspended: whileSuspended.inFlight,
      dispatchedWhileSuspended: whileSuspended.dispatched,
      drained,
      dispatched: metrics.dispatched,
    });
    // Suspension halts NEW dispatches, but a deadline is not a dispatch: the
    // hung slot must have been released while suspended.
    expect(whileSuspended.inFlight).toBe(0);
    expect(whileSuspended.dispatched).toBe(1);
    expect(drained).toBe("resolved");
    expect(metrics.dispatched).toBe(3);
    expect(metrics.inFlight).toBe(0);
  });

  it("timeout is retryable per policy: with maxAttempts 2 the hung event is re-dispatched once, then retry_exhausted", async () => {
    const engine = new SessionEventEngine({ sessionId: "attack-deadline-retry" });
    const attempts: number[] = [];
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-hang-retry",
      execute(task): Promise<SessionAnalysisTaskOutcome> {
        if (task.eventId === "E1") {
          attempts.push(task.attempt);
          return new Promise<never>(() => {});
        }
        return Promise.resolve({ status: "ready", analysis: fakeAnalysis });
      },
    };
    const scheduler = new SessionAnalysisScheduler(
      withDeadline({ engine, executor, concurrency: 1, maxAttempts: 2 }, 100),
    );
    scheduler.pushSamples({ wrist: threeStrokes() });
    scheduler.endOfStream();
    const drained = await withTimeout(
      scheduler.drained().then(() => "resolved" as const),
      3_000,
    );
    const metrics = scheduler.metrics();
    const e1 = metrics.tasks.find((t) => t.eventId === "E1");
    console.log("ATTACK AP-003/retry:", { drained, attempts, e1: e1?.outcome, f: e1?.failures });
    expect(drained).toBe("resolved");
    expect(attempts).toEqual([1, 2]);
    expect(e1?.outcome).toBe("retry_exhausted");
    expect(e1?.failures).toHaveLength(2);
    expect(metrics.dispatched).toBe(4);
    expect(metrics.inFlight).toBe(0);
  });
});
