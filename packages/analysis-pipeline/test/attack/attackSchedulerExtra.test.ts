import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionEventEngine } from "../../src/sessionEngine.js";
import {
  SessionAnalysisScheduler,
  type SessionAnalysisExecutor,
  type SessionAnalysisTaskOutcome,
} from "../../src/sessionScheduler.js";
import { fakeAnalysis, syntheticStream } from "./attackFixtures.js";

/**
 * ADVERSARIAL PASS 3 / TESTER #2 — extra scheduler/engine scenarios beyond
 * the assigned seven: buggy executor payloads, the no-waiter variant of the
 * terminal-overwrite race (does it crash the host process?), recovery after
 * the race, suspend/endOfStream interleavings, and hostile sample values.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Three closed events, no scheduler side effects yet. */
function engineWithThreeEvents(sessionId: string): SessionEventEngine {
  const engine = new SessionEventEngine({ sessionId });
  const stream = syntheticStream({ durationMs: 12_000, strokeEveryMs: 3000, firstStrokeMs: 1500 });
  engine.push({ wrist: stream });
  engine.flush();
  expect(engine.snapshot().events.length).toBeGreaterThanOrEqual(3);
  return engine;
}

/** Feed the engine's already-closed events into a scheduler by replaying the
 * same samples through a fresh engine (the scheduler owns its engine). */
function schedulerOver(
  sessionId: string,
  executor: SessionAnalysisExecutor,
  options?: { concurrency?: number; maxAttempts?: number; now?: () => number },
) {
  const engine = new SessionEventEngine({ sessionId });
  const scheduler = new SessionAnalysisScheduler({ engine, executor, ...options });
  const stream = syntheticStream({ durationMs: 12_000, strokeEveryMs: 3000, firstStrokeMs: 1500 });
  return { engine, scheduler, stream };
}

describe("extra — executor returns a malformed outcome", () => {
  let unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  it("'ready' with analysis:null (executor bug) must be recorded as a failure, not throw out of applyOutcome and stall the queue", async () => {
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-ready-null",
      async execute(task) {
        if (task.eventId === "E1") {
          return { status: "ready", analysis: null } as unknown as SessionAnalysisTaskOutcome;
        }
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const { engine, scheduler, stream } = schedulerOver("attack-ready-null", executor);
    scheduler.pushSamples({ wrist: stream });
    scheduler.endOfStream();
    let drainError: unknown = null;
    try {
      await withTimeout(scheduler.drained(), 5_000, "drained()");
    } catch (error) {
      drainError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const metrics = scheduler.metrics();
    const diagnostic = JSON.stringify({
      drainError: drainError instanceof Error ? drainError.message : drainError,
      queueDepth: metrics.queueDepth,
      inFlight: metrics.inFlight,
      states: engine.snapshot().events.map((e) => `${e.eventId}=${e.state}`),
      e1: metrics.tasks.find((t) => t.eventId === "E1"),
    });
    expect(drainError, diagnostic).toBeNull();
    expect(unhandled, diagnostic).toEqual([]);
    expect(metrics.queueDepth, diagnostic).toBe(0);
    expect(engine.eventState("E2"), diagnostic).toBe("ready");
    expect(engine.eventState("E3"), diagnostic).toBe("ready");
    // E1 must not be counted analyzed AND must not be stuck in 'processing'.
    expect(engine.eventState("E1"), diagnostic).toBe("pending");
    expect(metrics.tasks.find((t) => t.eventId === "E1")?.outcome, diagnostic).toBe("failed_final");
  });

  it("an unknown status string is treated as a non-retryable failure and the queue drains", async () => {
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-unknown-status",
      async execute(task) {
        if (task.eventId === "E2") {
          return { status: "\u{1F3D3} banana" } as unknown as SessionAnalysisTaskOutcome;
        }
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const { engine, scheduler, stream } = schedulerOver("attack-unknown-status", executor);
    scheduler.pushSamples({ wrist: stream });
    scheduler.endOfStream();
    await withTimeout(scheduler.drained(), 5_000, "drained()");
    const metrics = scheduler.metrics();
    expect(unhandled).toEqual([]);
    expect(metrics.queueDepth).toBe(0);
    expect(engine.eventState("E2")).toBe("pending");
    const e2 = metrics.tasks.find((t) => t.eventId === "E2")!;
    expect(e2.outcome).toBe("failed_final");
    expect(e2.failures).toHaveLength(1);
    // The recorded reason must be a string, not 'undefined'.
    expect(e2.failures[0], JSON.stringify(e2.failures)).not.toMatch(/undefined/);
  });

  it("executor resolves with a non-object (null) — same honest failure, no throw", async () => {
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-null-outcome",
      async execute(task) {
        if (task.eventId === "E1") return null as unknown as SessionAnalysisTaskOutcome;
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const { engine, scheduler, stream } = schedulerOver("attack-null-outcome", executor);
    scheduler.pushSamples({ wrist: stream });
    scheduler.endOfStream();
    let drainError: unknown = null;
    try {
      await withTimeout(scheduler.drained(), 5_000, "drained()");
    } catch (error) {
      drainError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const metrics = scheduler.metrics();
    const diagnostic = JSON.stringify({
      drainError: drainError instanceof Error ? drainError.message : drainError,
      queueDepth: metrics.queueDepth,
      states: engine.snapshot().events.map((e) => `${e.eventId}=${e.state}`),
    });
    expect(drainError, diagnostic).toBeNull();
    expect(unhandled, diagnostic).toEqual([]);
    expect(metrics.queueDepth, diagnostic).toBe(0);
    expect(engine.eventState("E2"), diagnostic).toBe("ready");
  });
});

describe("extra — terminal-overwrite race WITHOUT a drained() waiter (host-process impact)", () => {
  let unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  it("an external abstain while in flight must not surface as an unhandledRejection (Node default: process crash)", async () => {
    const gate = deferred<void>();
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-no-waiter",
      async execute(task) {
        if (task.eventId === "E1") await gate.promise;
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const { engine, scheduler, stream } = schedulerOver("attack-no-waiter", executor);
    scheduler.pushSamples({ wrist: stream });
    scheduler.endOfStream();
    expect(engine.eventState("E1")).toBe("processing");
    engine.markEvent("E1", "abstained", { abstainReason: "user dismissed the card" });
    gate.resolve();
    // Nobody awaits drained() — the real live flow never does; it just keeps
    // pushing samples. Give the microtask/macrotask queue time to surface.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const metrics = scheduler.metrics();
    const diagnostic = JSON.stringify({
      unhandled: unhandled.map((u) => (u instanceof Error ? u.message : String(u))),
      queueDepth: metrics.queueDepth,
      inFlight: metrics.inFlight,
      states: engine.snapshot().events.map((e) => `${e.eventId}=${e.state}`),
    });
    expect(unhandled, diagnostic).toEqual([]);
    expect(metrics.queueDepth, diagnostic).toBe(0);
  });

  it("(recoverability) after the race, does a later pushSamples()/drained() re-pump the stalled queue?", async () => {
    const gate = deferred<void>();
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-recover",
      async execute(task) {
        if (task.eventId === "E1") await gate.promise;
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const { engine, scheduler, stream } = schedulerOver("attack-recover", executor);
    scheduler.pushSamples({ wrist: stream });
    scheduler.endOfStream();
    engine.markEvent("E1", "abstained", { abstainReason: "external" });
    gate.resolve();
    await scheduler.drained().catch(() => undefined);
    const stalled = scheduler.metrics();
    // Second drained() call: settlePromises is empty, queue non-empty → pump.
    await withTimeout(scheduler.drained(), 5_000, "second drained()");
    const recovered = scheduler.metrics();
    const diagnostic = JSON.stringify({
      stalledQueueDepth: stalled.queueDepth,
      recoveredQueueDepth: recovered.queueDepth,
      states: engine.snapshot().events.map((e) => `${e.eventId}=${e.state}`),
      e1: recovered.tasks.find((t) => t.eventId === "E1"),
    });
    // Recorded for the report: the queue itself is recoverable by a second
    // pump, but E1's task record is left with outcome=null / finishedAt=null
    // forever — it is neither in flight nor queued nor finished.
    expect(recovered.queueDepth, diagnostic).toBe(0);
    expect(engine.eventState("E2"), diagnostic).toBe("ready");
    expect(engine.eventState("E3"), diagnostic).toBe("ready");
    const e1 = recovered.tasks.find((t) => t.eventId === "E1")!;
    expect(e1.outcome, diagnostic).not.toBeNull();
  });
});

describe("extra — suspend / endOfStream / resume interleavings", () => {
  it("suspend while 2 of 3 are in flight (concurrency 2), endOfStream during suspension, resume → all terminal exactly once", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const calls: string[] = [];
    const executor: SessionAnalysisExecutor = {
      executorId: "attack-suspend",
      async execute(task) {
        calls.push(task.eventId);
        const gate = deferred<void>();
        gates.set(task.eventId, gate);
        await gate.promise;
        return { status: "ready", analysis: fakeAnalysis };
      },
    };
    const engine = new SessionEventEngine({ sessionId: "attack-suspend" });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 2 });
    const stream = syntheticStream({
      durationMs: 12_000,
      strokeEveryMs: 3000,
      firstStrokeMs: 1500,
    });
    // Push everything except the tail, so only the first events close now.
    scheduler.pushSamples({ wrist: stream.slice(0, 250) });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    scheduler.suspend();
    scheduler.pushSamples({ wrist: stream.slice(250) });
    scheduler.endOfStream();
    const queuedWhileSuspended = scheduler.metrics().queueDepth;
    // Settle the in-flight ones while suspended; outcomes must still apply.
    for (const gate of gates.values()) gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scheduler.metrics().inFlight).toBe(0);
    expect(scheduler.metrics().queueDepth).toBe(queuedWhileSuspended);
    // Rapid resume/suspend/resume flapping.
    for (let index = 0; index < 20; index += 1) {
      scheduler.resume();
      scheduler.suspend();
    }
    scheduler.resume();
    const settle = async () => {
      for (;;) {
        for (const [id, gate] of gates) {
          gate.resolve();
          gates.delete(id);
        }
        const m = scheduler.metrics();
        if (m.queueDepth === 0 && m.inFlight === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    };
    await withTimeout(Promise.all([scheduler.drained(), settle()]), 5_000, "drain after flapping");
    const events = engine.snapshot().events;
    expect(events.every((e) => e.state === "ready")).toBe(true);
    // Each event executed exactly once (no duplicate dispatch from flapping).
    expect([...calls].sort()).toEqual(events.map((e) => e.eventId).sort());
    expect(scheduler.metrics().dispatched).toBe(events.length);
  });
});

describe("extra — hostile sample values on the engine", () => {
  it("NaN / ±Infinity samples are ignored and never reach a proposal", () => {
    const engine = new SessionEventEngine({ sessionId: "attack-nonfinite" });
    const stream = syntheticStream({ durationMs: 7_000, strokeEveryMs: 3000, firstStrokeMs: 1500 });
    const poisoned = stream.flatMap((s, index) =>
      index % 7 === 0
        ? [
            s,
            { timestampMs: s.timestampMs + 1, value: NaN },
            { timestampMs: NaN, value: 1 },
            { timestampMs: s.timestampMs + 2, value: Infinity },
          ]
        : [s],
    );
    const closed = [...engine.push({ wrist: poisoned }), ...engine.flush()];
    const clean = new SessionEventEngine({ sessionId: "attack-nonfinite-clean" });
    const expected = [...clean.push({ wrist: stream }), ...clean.flush()];
    expect(closed.map((e) => ({ ...e.proposal }))).toEqual(
      expected.map((e) => ({ ...e.proposal })),
    );
    for (const event of closed) {
      expect(Number.isFinite(event.proposal.peakSpeed)).toBe(true);
      expect(Number.isFinite(event.proposal.prominence)).toBe(true);
    }
    expect(engine.snapshot().qualityState.wristSamples).toBe(stream.length);
  });

  it("negative and huge (1e15) timestamps: bounds stay ordered and finite; no throw", () => {
    for (const offset of [-5_000_000, 1e15]) {
      const engine = new SessionEventEngine({ sessionId: `attack-offset-${offset}` });
      const stream = syntheticStream({
        durationMs: 7_000,
        strokeEveryMs: 3000,
        firstStrokeMs: 1500,
      }).map((s) => ({
        timestampMs: s.timestampMs + offset,
        value: s.value,
      }));
      const closed = [...engine.push({ wrist: stream }), ...engine.flush()];
      expect(closed.length, `offset ${offset}`).toBeGreaterThan(0);
      for (const event of closed) {
        expect(event.proposal.startMs).toBeLessThanOrEqual(event.proposal.peakMs);
        expect(event.proposal.peakMs).toBeLessThanOrEqual(event.proposal.endMs);
        expect(Number.isFinite(event.proposal.startMs)).toBe(true);
      }
    }
  });

  it("push() after flush(): the engine keeps emitting new events; late samples behind the frontier are dropped and counted", () => {
    const engine = new SessionEventEngine({ sessionId: "attack-post-flush" });
    const a = syntheticStream({ durationMs: 7_000, strokeEveryMs: 3000, firstStrokeMs: 1500 });
    const first = [...engine.push({ wrist: a }), ...engine.flush()];
    expect(first.length).toBeGreaterThan(0);
    const frontier = first[first.length - 1]!.proposal.endMs;
    const b = a.map((s) => ({ timestampMs: s.timestampMs + 7_000, value: s.value }));
    const late = a.filter((s) => s.timestampMs <= frontier);
    const second = [...engine.push({ wrist: [...late, ...b] }), ...engine.flush()];
    expect(second.length).toBeGreaterThan(0);
    const snap = engine.snapshot();
    expect(snap.qualityState.droppedLateSamples).toBe(late.length);
    expect(snap.events.map((e) => e.eventId)).toEqual(snap.events.map((_, i) => `E${i + 1}`));
    // Frontier monotonic: no second-round event starts before the first-round frontier.
    for (const event of second) expect(event.proposal.peakMs).toBeGreaterThan(frontier);
  });

  it("markEvent on an unknown / unicode eventId throws a clear error (documented caller bug)", () => {
    const engine = engineWithThreeEvents("attack-unknown-id");
    expect(() => engine.markEvent("E\u{1F3D3}", "processing")).toThrow(/unknown session event/);
    expect(() => engine.markEvent("", "processing")).toThrow(/unknown session event/);
    expect(engine.snapshot().events.every((e) => e.state === "pending")).toBe(true);
  });
});
