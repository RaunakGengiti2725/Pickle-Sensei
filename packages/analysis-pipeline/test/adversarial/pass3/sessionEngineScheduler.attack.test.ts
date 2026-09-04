import { describe, expect, it } from "vitest";
import { SessionEventEngine, type SpeedSample } from "../../../src/sessionEngine.js";
import {
  SessionAnalysisScheduler,
  type SessionAnalysisExecutor,
  type SessionAnalysisTask,
  type SessionAnalysisTaskOutcome,
} from "../../../src/sessionScheduler.js";

/**
 * Adversarial pass 3 — scenarios S1 (non-finite wrist samples) and S2
 * (100× recoverPending readmission lease accounting) against 4d812e1a.
 *
 * The engine and scheduler are REAL; only the executor seam is scripted.
 * `it.fails` marks reproductions of findings (see the FINDING comment on
 * each); flip to `it` once production is fixed.
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

const oneStroke = (): SpeedSample[] =>
  speedBumps([{ peakMs: 1200, height: 2.0, halfWidthMs: 120 }], 0, 3000);

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

const NON_FINITE_WRIST: SpeedSample[] = [
  { timestampMs: Number.NaN, value: 1.5 },
  { timestampMs: Number.POSITIVE_INFINITY, value: 1.5 },
  { timestampMs: Number.NEGATIVE_INFINITY, value: 1.5 },
  { timestampMs: 1500, value: Number.NaN },
  { timestampMs: 1500, value: Number.POSITIVE_INFINITY },
  { timestampMs: 1500, value: Number.NEGATIVE_INFINITY },
  { timestampMs: Number.NaN, value: Number.NaN },
];

describe("SessionEventEngine — non-finite wrist samples (attack pass 3 / S1)", () => {
  it("CONTROL: a finite wrist sample at/behind the frontier IS counted in droppedLateSamples", () => {
    const engine = new SessionEventEngine({ sessionId: "s1-control" });
    for (const sample of oneStroke()) engine.push({ wrist: [sample] });
    engine.flush();
    const before = engine.snapshot().qualityState;
    expect(before.droppedLateSamples).toBe(0);
    expect(engine.snapshot().events.length).toBeGreaterThanOrEqual(1);
    // Behind the frontier: counted, never silently vanishes.
    engine.push({ wrist: [{ timestampMs: 100, value: 0.5 }] });
    const after = engine.snapshot().qualityState;
    expect(after.droppedLateSamples).toBe(1);
    expect(after.wristSamples).toBe(before.wristSamples + 1);
  });

  it("HELD: NaN/±Infinity wrist AND paddle samples never throw, never poison the snapshot, never change the emitted events", () => {
    const control = new SessionEventEngine({ sessionId: "s1-ctl" });
    const attacked = new SessionEventEngine({ sessionId: "s1-ctl" });
    const stream = oneStroke();
    // Interleave a full set of non-finite samples before, between and after
    // the real samples — including paddle samples on the same path.
    expect(() => {
      attacked.push({ wrist: NON_FINITE_WRIST, paddle: NON_FINITE_WRIST });
      stream.forEach((sample, index) => {
        control.push({ wrist: [sample] });
        attacked.push({
          wrist:
            index % 7 === 0
              ? [NON_FINITE_WRIST[index % NON_FINITE_WRIST.length]!, sample]
              : [sample],
          paddle: index % 11 === 0 ? [NON_FINITE_WRIST[index % NON_FINITE_WRIST.length]!] : [],
        });
      });
      attacked.push({ wrist: NON_FINITE_WRIST, paddle: NON_FINITE_WRIST });
      control.flush();
      attacked.flush();
    }).not.toThrow();

    const controlSnap = control.snapshot();
    const attackedSnap = attacked.snapshot();
    expect(attackedSnap.events.length).toBeGreaterThanOrEqual(1);
    expect(attackedSnap.events).toEqual(controlSnap.events);
    expect(nonFiniteNumbers(attackedSnap)).toEqual([]);
    expect(attackedSnap.qualityState.lastSampleMs).toBe(controlSnap.qualityState.lastSampleMs);
    // The retained series are byte-identical to the clean run.
    expect(attackedSnap.qualityState.paddleSamples).toBe(controlSnap.qualityState.paddleSamples);
  });

  it("HELD: a -Infinity timestamp does not move the frontier and a +Infinity one does not close every future event", () => {
    const engine = new SessionEventEngine({ sessionId: "s1-frontier" });
    engine.push({ wrist: [{ timestampMs: Number.POSITIVE_INFINITY, value: 9 }] });
    engine.push({ wrist: [{ timestampMs: Number.NEGATIVE_INFINITY, value: 9 }] });
    expect(engine.snapshot().qualityState.lastSampleMs).toBeNull();
    for (const sample of oneStroke()) engine.push({ wrist: [sample] });
    engine.flush();
    const snap = engine.snapshot();
    expect(snap.events.length).toBeGreaterThanOrEqual(1);
    expect(snap.events[0]!.closeReason).not.toBe("flush");
    expect(nonFiniteNumbers(snap)).toEqual([]);
  });

  /**
   * FINDING (P3, 4d812e1a): `SessionEventEngine.push` discards non-finite
   * wrist/paddle samples with a bare `continue` (sessionEngine.ts:834,838)
   * — they are neither counted in `droppedLateSamples` nor noted in
   * `qualityState.notes`. A corrupt sensor stream (NaN timestamps from a
   * broken clock, ±Infinity from a division) is indistinguishable from a
   * clean stream in the quality report; `wristSamples` under-counts what
   * the device actually delivered.
   */
  it.fails(
    "FINDING: non-finite wrist samples are recorded in droppedLateSamples or qualityState.notes",
    () => {
      const engine = new SessionEventEngine({ sessionId: "s1-silent" });
      for (const sample of oneStroke()) engine.push({ wrist: [sample] });
      const before = engine.snapshot().qualityState;
      engine.push({ wrist: NON_FINITE_WRIST });
      const after = engine.snapshot().qualityState;
      const counted = after.droppedLateSamples - before.droppedLateSamples;
      const noted = after.notes.filter((note) => !before.notes.includes(note));
      // Either accounting channel is acceptable; silence is not.
      expect(counted + noted.length).toBeGreaterThan(0);
    },
  );

  it("OBSERVED (documents the silent drop): non-finite samples change nothing in qualityState", () => {
    const engine = new SessionEventEngine({ sessionId: "s1-observed" });
    for (const sample of oneStroke()) engine.push({ wrist: [sample] });
    const before = engine.snapshot().qualityState;
    engine.push({ wrist: NON_FINITE_WRIST, paddle: NON_FINITE_WRIST });
    const after = engine.snapshot().qualityState;
    expect(after).toEqual(before);
  });

  it("HELD: huge-but-finite timestamps (MAX_SAFE_INTEGER, 1e300) do not throw and leave no non-finite numbers in the snapshot", () => {
    const engine = new SessionEventEngine({ sessionId: "s1-huge" });
    for (const sample of oneStroke()) engine.push({ wrist: [sample] });
    expect(() => {
      engine.push({ wrist: [{ timestampMs: Number.MAX_SAFE_INTEGER, value: 3 }] });
      engine.push({ wrist: [{ timestampMs: 1e300, value: 1e300 }] });
      engine.push({ wrist: [{ timestampMs: 1e300 + 1, value: Number.MAX_VALUE }] });
      engine.flush();
    }).not.toThrow();
    const snap = engine.snapshot();
    expect(nonFiniteNumbers(snap)).toEqual([]);
    expect(snap.qualityState.lastSampleMs).toBe(1e300);
  });
});

const fakeAnalysis = { id: "synthetic-analysis" } as unknown as NonNullable<
  ReturnType<SessionEventEngine["snapshot"]>["events"][number]["analysis"]
>;

function scriptedExecutor(
  script: (
    task: SessionAnalysisTask,
  ) => SessionAnalysisTaskOutcome | Promise<SessionAnalysisTaskOutcome>,
): SessionAnalysisExecutor & { calls: SessionAnalysisTask[] } {
  const calls: SessionAnalysisTask[] = [];
  return {
    executorId: "attack-pass3-executor",
    calls,
    async execute(task) {
      calls.push(task);
      return script(task);
    },
  };
}

async function exhaustedSingleEvent(maxAttempts: number, retryable = true) {
  const engine = new SessionEventEngine({ sessionId: `s2-readmit-${maxAttempts}` });
  const executor = scriptedExecutor(() => ({
    status: "failed",
    reason: retryable ? "CLIP_EXTRACTION_FAILED: transient" : "MODEL_LOAD_FAILED: permanent",
    retryable,
  }));
  const scheduler = new SessionAnalysisScheduler({ engine, executor, maxAttempts });
  for (const sample of oneStroke()) scheduler.pushSamples({ wrist: [sample] });
  scheduler.endOfStream();
  await scheduler.drained();
  expect(engine.snapshot().events.map((event) => event.eventId)).toEqual(["E1"]);
  return { engine, executor, scheduler };
}

describe("SessionAnalysisScheduler — 100× readmitExhausted lease accounting (attack pass 3 / S2)", () => {
  for (const maxAttempts of [1, 2, 3]) {
    it(`HELD (maxAttempts=${maxAttempts}): 100 readmissions each grant exactly maxAttempts more attempts — never more within one lease`, async () => {
      const { engine, executor, scheduler } = await exhaustedSingleEvent(maxAttempts);
      const record0 = scheduler.metrics().tasks.find((task) => task.eventId === "E1")!;
      expect(record0.outcome).toBe("retry_exhausted");
      expect(record0.attempts).toBe(maxAttempts);
      expect(executor.calls.length).toBe(maxAttempts);

      for (let lease = 1; lease <= 100; lease += 1) {
        const readmitted = scheduler.recoverPending({ readmitExhausted: true });
        expect(readmitted).toEqual(["E1"]);
        // A second call inside the same lease must NOT stack a second lease.
        expect(scheduler.recoverPending({ readmitExhausted: true })).toEqual([]);
        await scheduler.drained();
        const metrics = scheduler.metrics();
        const record = metrics.tasks.find((task) => task.eventId === "E1")!;
        expect(record.outcome).toBe("retry_exhausted");
        expect(record.attempts).toBe(maxAttempts * (lease + 1));
        expect(executor.calls.length).toBe(maxAttempts * (lease + 1));
        expect(record.failures.length).toBe(maxAttempts * (lease + 1));
        expect(metrics.queueDepth).toBe(0);
        expect(metrics.inFlight).toBe(0);
        expect(metrics.enqueued).toBe(1);
        expect(metrics.duplicatesRefused).toBe(0);
        expect(metrics.retryExhausted).toBe(1);
        expect(metrics.ready).toBe(0);
      }
      // Attempt numbers handed to the executor are a strict 1..N sequence
      // (no lease restarts at 1, no lease skips a number).
      expect(executor.calls.map((task) => task.attempt)).toEqual(
        Array.from({ length: maxAttempts * 101 }, (_, index) => index + 1),
      );
      // `retries` counts every dispatch with attempt > 1 (sessionScheduler.ts
      // dispatch: `if (attempt > 1) this.retries += 1`), so a readmitted
      // lease's first attempt is a retry too: total dispatches − 1.
      expect(scheduler.metrics().dispatched).toBe(maxAttempts * 101);
      expect(scheduler.metrics().retries).toBe(maxAttempts * 101 - 1);
      expect(engine.snapshot().events[0]!.state).toBe("pending");
    });
  }

  it("HELD: failed_final (non-retryable) readmission also gets exactly one maxAttempts budget per lease and stays non-retryable inside it", async () => {
    const { executor, scheduler } = await exhaustedSingleEvent(3, false);
    expect(scheduler.metrics().failedFinal).toBe(1);
    expect(executor.calls.length).toBe(1); // non-retryable: one try, no retries
    for (let lease = 1; lease <= 100; lease += 1) {
      expect(scheduler.recoverPending({ readmitExhausted: true })).toEqual(["E1"]);
      await scheduler.drained();
      const record = scheduler.metrics().tasks.find((task) => task.eventId === "E1")!;
      expect(record.outcome).toBe("failed_final");
      // A non-retryable failure ends the lease after one attempt regardless
      // of the maxAttempts=3 ceiling: attempts grow by exactly 1 per lease.
      expect(record.attempts).toBe(1 + lease);
      expect(executor.calls.length).toBe(1 + lease);
    }
    // Every readmitted attempt has attempt > 1 and is counted as a retry.
    expect(scheduler.metrics().retries).toBe(100);
    expect(scheduler.metrics().dispatched).toBe(101);
  });

  it("HELD: readmission while the previous lease is still in flight is refused (no lease stacking, no ceiling inflation)", async () => {
    const engine = new SessionEventEngine({ sessionId: "s2-inflight" });
    let release: (() => void) | null = null;
    let phase: "exhaust" | "hold" = "exhaust";
    const executor = scriptedExecutor(async () => {
      if (phase === "hold") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { status: "failed", reason: "CLIP_EXTRACTION_FAILED: transient", retryable: true };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, maxAttempts: 2 });
    for (const sample of oneStroke()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    await scheduler.drained();
    expect(executor.calls.length).toBe(2);

    phase = "hold";
    expect(scheduler.recoverPending({ readmitExhausted: true })).toEqual(["E1"]);
    await Promise.resolve();
    expect(scheduler.metrics().inFlight).toBe(1);
    // Hammer recoverPending 100× mid-flight: every call must be a no-op.
    for (let index = 0; index < 100; index += 1) {
      expect(scheduler.recoverPending({ readmitExhausted: true })).toEqual([]);
      expect(scheduler.recoverPending()).toEqual([]);
    }
    expect(scheduler.metrics().inFlight).toBe(1);
    expect(scheduler.metrics().queueDepth).toBe(0);
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Second attempt of this lease is now in flight; release it too.
    expect(scheduler.metrics().inFlight).toBe(1);
    release!();
    await scheduler.drained();
    const record = scheduler.metrics().tasks.find((task) => task.eventId === "E1")!;
    expect(record.attempts).toBe(4); // 2 (initial) + exactly 2 (one lease)
    expect(executor.calls.length).toBe(4);
    expect(record.outcome).toBe("retry_exhausted");
  });

  it("HELD: recoverPending() WITHOUT readmitExhausted never touches an exhausted event, even 100×", async () => {
    const { executor, scheduler } = await exhaustedSingleEvent(2);
    for (let index = 0; index < 100; index += 1) {
      expect(scheduler.recoverPending()).toEqual([]);
    }
    await scheduler.drained();
    expect(executor.calls.length).toBe(2);
    expect(scheduler.metrics().tasks[0]!.attempts).toBe(2);
  });

  it("HELD: a lease that eventually succeeds terminates at exactly the attempt it succeeded on and is never readmitted again", async () => {
    const engine = new SessionEventEngine({ sessionId: "s2-success" });
    let failuresRemaining = 2 * 50 + 1; // 50 exhausted leases of 2, then succeed on lease 51 attempt 2
    const executor = scriptedExecutor(() => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        return { status: "failed", reason: "CLIP_EXTRACTION_FAILED: transient", retryable: true };
      }
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, maxAttempts: 2 });
    for (const sample of oneStroke()) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    await scheduler.drained();
    let leases = 0;
    while (scheduler.metrics().tasks[0]!.outcome !== "ready") {
      expect(scheduler.recoverPending({ readmitExhausted: true })).toEqual(["E1"]);
      leases += 1;
      await scheduler.drained();
      expect(leases).toBeLessThanOrEqual(100);
    }
    expect(leases).toBe(50);
    expect(scheduler.metrics().tasks[0]!.attempts).toBe(2 * 51);
    expect(engine.snapshot().events[0]!.state).toBe("ready");
    for (let index = 0; index < 100; index += 1) {
      expect(scheduler.recoverPending({ readmitExhausted: true })).toEqual([]);
    }
    expect(executor.calls.length).toBe(2 * 51);
  });
});
