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

/**
 * ADVERSARIAL PASS 3 / TESTER #1 — SessionAnalysisScheduler attacks
 * (crash recovery over a stuck 'processing' event, suspend/drained timer
 * behaviour, a never-settling executor, and an executor that violates the
 * outcome contract). Target commit 4d812e1a; production code untouched.
 *
 * Same convention as attackPass3SessionEngine.test.ts: "HELD" tests assert
 * the contract; "GAP"/"BROKEN" tests reproduce the deviation and PIN THE
 * OBSERVED behaviour (never `it.fails`, so a failing precondition cannot be
 * mistaken for a reproduced gap) and console.log the observation.
 *
 * Only the executor is a test double (native clip extraction does not exist
 * on this box); the engine and scheduler are the production classes.
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

const fakeAnalysis = { id: "attack-analysis" } as unknown as NonNullable<
  SessionStrokeEvent["analysis"]
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

function strokes(count: number): SpeedSample[] {
  return speedBumps(
    Array.from({ length: count }, (_, index) => ({
      peakMs: 1200 + index * 2400,
      height: 2.0 + (index % 3) * 0.2,
      halfWidthMs: 120,
    })),
    0,
    1200 + count * 2400,
  );
}

/** Engine pre-loaded with `count` CLOSED events and nothing else. */
function closedEngine(sessionId: string, count: number): SessionEventEngine {
  const engine = new SessionEventEngine({ sessionId });
  for (const sample of strokes(count)) engine.pushWristSample(sample);
  engine.flush();
  expect(engine.snapshot().events.map((e) => e.eventId)).toEqual(
    Array.from({ length: count }, (_, index) => `E${index + 1}`),
  );
  return engine;
}

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Race a promise against a deadline; returns "settled" or "pending". */
async function settledWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<"settled" | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Counts live timers created through the global setTimeout while `fn` runs
 * (created − fired/cleared). Instrumented on globalThis so the scheduler's own
 * `setTimeout(…, 5)` polling loop is observed exactly as production runs it. */
async function withTimerLedger<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; created: number; fired: number; cleared: number; outstanding: number }> {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let created = 0;
  let fired = 0;
  let cleared = 0;
  const live = new Set<ReturnType<typeof setTimeout>>();
  const patchedSetTimeout = ((
    handler: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    created += 1;
    const id = realSetTimeout(
      (...inner: unknown[]) => {
        fired += 1;
        live.delete(id);
        handler(...inner);
      },
      ms,
      ...args,
    );
    live.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  const patchedClearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    if (live.delete(id)) cleared += 1;
    realClearTimeout(id);
  }) as unknown as typeof clearTimeout;
  globalThis.setTimeout = patchedSetTimeout;
  globalThis.clearTimeout = patchedClearTimeout;
  try {
    const result = await fn();
    // Let any timer already scheduled for "now" fire before we read the ledger.
    await new Promise<void>((resolve) => realSetTimeout(resolve, 20));
    return { result, created, fired, cleared, outstanding: live.size };
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

describe("ATTACK S2 — recoverPending() over an engine whose E1 is stuck in 'processing' (crash mid-dispatch)", () => {
  it("GAP (P2, pre-existing): an event left 'processing' by a lost scheduler is never re-admitted — recoverPending() returns [], drained() resolves, E1 stays 'processing' forever", async () => {
    const engine = closedEngine("s2-stuck-processing", 3);
    // Crash simulation: a previous scheduler instance marked E1 'processing'
    // and died before settling (its queue/inFlight state is gone). E2/E3 were
    // never dispatched.
    engine.markEvent("E1", "processing");
    expect(engine.eventState("E1")).toBe("processing");

    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const recovered = new SessionAnalysisScheduler({ engine, executor });
    const readmitted = recovered.recoverPending();
    const readmittedAgain = recovered.recoverPending({ readmitExhausted: true });
    await recovered.drained();
    const states = engine.snapshot().events.map((e) => [e.eventId, e.state]);
    const metrics = recovered.metrics();
    console.log(
      JSON.stringify({
        scenario: "S2-stuck-processing",
        readmitted,
        readmittedAgain,
        states,
        dispatched: executor.calls.map((c) => c.eventId),
        enqueued: metrics.enqueued,
        tasks: metrics.tasks.map((t) => [t.eventId, t.outcome]),
      }),
    );
    // CONTRACT (scheduler doc L40-L45 / L211-L216): recovery "re-enqueues
    // engine events that are NON-TERMINAL and not already tracked — the
    // restart path after a crash/kill where queue state was lost". 'processing'
    // is non-terminal, and after a crash nothing is tracking it.
    // OBSERVED (pinned): only 'pending' is scanned (L220); E1 is skipped by
    // both plain and readmitExhausted recovery, the executor never sees it,
    // drained() resolves as if the session were complete, and E1 can never be
    // finished by anyone (markEvent processing→ready needs a record only the
    // scheduler produces; nothing else reads 'processing').
    expect(readmitted).toEqual(["E2", "E3"]);
    expect(readmittedAgain).toEqual([]);
    expect(states).toEqual([
      ["E1", "processing"],
      ["E2", "ready"],
      ["E3", "ready"],
    ]);
    expect(executor.calls.map((c) => c.eventId)).toEqual(["E2", "E3"]);
    expect(metrics.enqueued).toBe(2);
  });

  it("HELD: the in-process path stays exact-once — recoverPending() while the SAME scheduler has E1 in flight never re-dispatches it", async () => {
    const engine = closedEngine("s2-inflight", 2);
    let release: (() => void) | null = null;
    const executor = scriptedExecutor(
      () =>
        new Promise<SessionAnalysisTaskOutcome>((resolve) => {
          release = () => resolve({ status: "ready", analysis: fakeAnalysis });
        }),
    );
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    expect(scheduler.recoverPending()).toEqual(["E1", "E2"]);
    await tick();
    expect(engine.eventState("E1")).toBe("processing");
    for (let index = 0; index < 50; index += 1) {
      expect(scheduler.recoverPending()).toEqual([]);
      expect(scheduler.recoverPending({ readmitExhausted: true })).toEqual([]);
    }
    release!();
    await tick();
    release!();
    await scheduler.drained();
    expect(executor.calls.map((c) => c.eventId)).toEqual(["E1", "E2"]);
    expect(scheduler.metrics().duplicatesRefused).toBe(0);
  });

  it("HELD: a corrupted engine (event forced to a terminal state behind the scheduler's back) is skipped by recovery, not crashed on", async () => {
    const engine = closedEngine("s2-corrupt", 3);
    engine.markEvent("E2", "abstained", { abstainReason: "FORCED_BY_TEST" });
    engine.markEvent("E3", "ready", { analysis: fakeAnalysis });
    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const scheduler = new SessionAnalysisScheduler({ engine, executor });
    expect(scheduler.recoverPending()).toEqual(["E1"]);
    await scheduler.drained();
    expect(engine.snapshot().events.map((e) => e.state)).toEqual(["ready", "abstained", "ready"]);
    expect(executor.calls.map((c) => c.eventId)).toEqual(["E1"]);
  });
});

describe("ATTACK S5 — suspend() + concurrent drained() over a non-empty queue for 2 s, then resume()", () => {
  it("HELD: all waiters resolve after resume(), every queued event reaches ready, and the setTimeout(5) polling loop leaves no live timer behind", async () => {
    const ledger = await withTimerLedger(async () => {
      const engine = closedEngine("s5-suspend-drained", 4);
      const executor = scriptedExecutor(async () => {
        await tick(1);
        return { status: "ready", analysis: fakeAnalysis };
      });
      const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
      scheduler.suspend();
      expect(scheduler.recoverPending()).toEqual(["E1", "E2", "E3", "E4"]);
      expect(scheduler.metrics().queueDepth).toBe(4);
      expect(scheduler.metrics().inFlight).toBe(0);
      const waiters = Array.from({ length: 8 }, () => scheduler.drained());
      // Interleave: rapid suspend() repeats and a mid-flight recoverPending()
      // while the waiters poll.
      const started = Date.now();
      let polls = 0;
      while (Date.now() - started < 2000) {
        scheduler.suspend();
        expect(scheduler.recoverPending()).toEqual([]);
        expect(scheduler.metrics().inFlight).toBe(0);
        polls += 1;
        await tick(25);
      }
      const beforeResume = await settledWithin(Promise.all(waiters), 50);
      scheduler.resume();
      await Promise.all(waiters);
      await scheduler.drained();
      return {
        polls,
        beforeResume,
        states: engine.snapshot().events.map((e) => e.state),
        metrics: scheduler.metrics(),
      };
    });
    console.log(
      JSON.stringify({
        scenario: "S5-suspend-drained-2s",
        polls: ledger.result.polls,
        waitersBeforeResume: ledger.result.beforeResume,
        timersCreated: ledger.created,
        timersFired: ledger.fired,
        timersCleared: ledger.cleared,
        timersOutstanding: ledger.outstanding,
        dispatched: ledger.result.metrics.dispatched,
        ready: ledger.result.metrics.ready,
      }),
    );
    expect(ledger.result.beforeResume).toBe("pending");
    expect(ledger.result.states).toEqual(["ready", "ready", "ready", "ready"]);
    expect(ledger.result.metrics.ready).toBe(4);
    expect(ledger.result.metrics.dispatched).toBe(4);
    expect(ledger.result.metrics.suspended).toBe(false);
    // The 8 waiters × 2 s / 5 ms ≈ 3200 polling timers must all have fired;
    // nothing may still be live once drained() resolved.
    expect(ledger.created).toBeGreaterThan(8 * 200);
    expect(ledger.outstanding).toBe(0);
    expect(ledger.fired + ledger.cleared).toBe(ledger.created);
  });

  it("MEASURE (P3, pre-existing): a suspended drained() waiter is a busy 5 ms poll — ≈200 wakeups/s per waiter, N waiters poll independently (no shared wake-up)", async () => {
    const ledger = await withTimerLedger(async () => {
      const engine = closedEngine("s5-poll-cost", 1);
      const scheduler = new SessionAnalysisScheduler({
        engine,
        executor: scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis })),
      });
      scheduler.suspend();
      scheduler.recoverPending();
      const waiters = Array.from({ length: 4 }, () => scheduler.drained());
      await tick(500);
      scheduler.resume();
      await Promise.all(waiters);
      return null;
    });
    console.log(
      JSON.stringify({
        scenario: "S5-poll-cost-4-waiters-500ms",
        timersCreated: ledger.created,
        perWaiterPerSecond: ledger.created / 4 / 0.5,
        outstanding: ledger.outstanding,
      }),
    );
    // OBSERVED (pinned loosely): 4 waiters × 0.5 s × (1000/5) ≈ 400 timers
    // (Node's timer granularity makes it a little lower). Not a leak (all
    // fire), but a suspended app (background) keeps ≥ 100 wakeups/s/waiter
    // alive for as long as anyone awaits drained().
    expect(ledger.created).toBeGreaterThan(4 * 50);
    expect(ledger.outstanding).toBe(0);
  });

  it("HELD: resume() with nothing queued, double resume(), and suspend() after drain are all harmless", async () => {
    const engine = closedEngine("s5-idempotent", 1);
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor: scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis })),
    });
    scheduler.resume();
    scheduler.resume();
    await scheduler.drained();
    scheduler.recoverPending();
    await scheduler.drained();
    scheduler.suspend();
    scheduler.suspend();
    await scheduler.drained(); // empty queue → resolves even while suspended
    expect(scheduler.metrics().suspended).toBe(true);
    expect(engine.eventState("E1")).toBe("ready");
  });
});

describe("ATTACK S6 — executor never settles for E1 (cancellation gap)", () => {
  it("GAP (P2, pre-existing): with concurrency 1 a hung E1 holds the only slot — drained() never resolves, E2..E5 stay queued, no timeout/cancel exists, and endOfStream()/pushSamples() cannot unstick it", async () => {
    const engine = new SessionEventEngine({ sessionId: "s6-hang" });
    const executor = scriptedExecutor((task) =>
      task.eventId === "E1"
        ? new Promise<SessionAnalysisTaskOutcome>(() => {
            /* never settles */
          })
        : { status: "ready", analysis: fakeAnalysis },
    );
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    // Progressive feed: E1 closes while E2..E5 are still being recorded.
    for (const sample of strokes(5)) scheduler.pushSamples({ wrist: [sample] });
    scheduler.endOfStream();
    const drained = scheduler.drained();
    const verdict = await settledWithin(drained, 1500);
    // Try every public lever that could plausibly free the slot.
    scheduler.suspend();
    scheduler.resume();
    expect(scheduler.recoverPending()).toEqual([]);
    expect(scheduler.recoverPending({ readmitExhausted: true })).toEqual([]);
    scheduler.endOfStream();
    scheduler.pushSamples({ wrist: [{ timestampMs: 999_999, value: 0.05 }] });
    const afterLevers = await settledWithin(drained, 200);
    const metrics = scheduler.metrics();
    console.log(
      JSON.stringify({
        scenario: "S6-never-settling-executor",
        drainedAfter1500ms: verdict,
        drainedAfterLevers: afterLevers,
        queueDepth: metrics.queueDepth,
        inFlight: metrics.inFlight,
        dispatched: metrics.dispatched,
        states: engine.snapshot().events.map((e) => e.state),
        e1: metrics.tasks.find((t) => t.eventId === "E1"),
      }),
    );
    // OBSERVED (pinned): no timeout, no cancel, no per-task deadline — the
    // whole session's analysis is hostage to one hung executor call.
    expect(verdict).toBe("pending");
    expect(afterLevers).toBe("pending");
    expect(metrics.inFlight).toBe(1);
    expect(metrics.queueDepth).toBe(4);
    expect(metrics.dispatched).toBe(1);
    expect(engine.snapshot().events.map((e) => e.state)).toEqual([
      "processing",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(metrics.tasks.find((t) => t.eventId === "E1")?.outcome).toBeNull();
    // The dangling drained() promise is intentionally abandoned here (it can
    // never resolve) — vitest exits fine because the hung executor promise
    // holds no timer.
  });

  it("HELD (mitigation exists): with concurrency 2 the hung E1 costs exactly one slot — E2..E5 all complete, drained() still never resolves", async () => {
    const engine = closedEngine("s6-concurrency-2", 5);
    const executor = scriptedExecutor((task) =>
      task.eventId === "E1"
        ? new Promise<SessionAnalysisTaskOutcome>(() => {
            /* never settles */
          })
        : { status: "ready", analysis: fakeAnalysis },
    );
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 2 });
    scheduler.recoverPending();
    const verdict = await settledWithin(scheduler.drained(), 300);
    const metrics = scheduler.metrics();
    console.log(
      JSON.stringify({
        scenario: "S6-concurrency-2",
        drainedAfter300ms: verdict,
        states: engine.snapshot().events.map((e) => e.state),
        ready: metrics.ready,
        inFlight: metrics.inFlight,
      }),
    );
    expect(verdict).toBe("pending");
    expect(engine.snapshot().events.map((e) => e.state)).toEqual([
      "processing",
      "ready",
      "ready",
      "ready",
      "ready",
    ]);
    expect(metrics.inFlight).toBe(1);
    expect(metrics.queueDepth).toBe(0);
  });
});

describe("ATTACK S7 — executor returns { status: 'ready', analysis: null as any }", () => {
  it("BROKEN (P2, pre-existing): the engine's 'ready needs a record' throw escapes inside the settlement chain — drained() REJECTS, E1 is stuck 'processing', E2..E3 are not pumped, no failure is counted", async () => {
    const engine = closedEngine("s7-null-analysis", 3);
    const executor = scriptedExecutor((task) =>
      task.eventId === "E1"
        ? ({ status: "ready", analysis: null as never } as SessionAnalysisTaskOutcome)
        : { status: "ready", analysis: fakeAnalysis },
    );
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    scheduler.recoverPending();
    let drainedError: string | null = null;
    try {
      await scheduler.drained();
    } catch (error) {
      drainedError = error instanceof Error ? error.message : String(error);
    }
    const afterReject = scheduler.metrics();
    const statesAfterReject = engine.snapshot().events.map((e) => e.state);
    // A caller that survives the rejection and re-awaits: the queue does
    // pump again (drained() itself calls pump()), but E1 is lost for good.
    await scheduler.drained();
    const metrics = scheduler.metrics();
    const states = engine.snapshot().events.map((e) => e.state);
    const e1 = metrics.tasks.find((t) => t.eventId === "E1")!;
    console.log(
      JSON.stringify({
        scenario: "S7-ready-with-null-analysis",
        drainedError,
        statesAfterReject,
        queueDepthAfterReject: afterReject.queueDepth,
        inFlightAfterReject: afterReject.inFlight,
        statesAfterSecondDrain: states,
        e1: { outcome: e1.outcome, failures: e1.failures, attempts: e1.attempts },
        executorThrows: metrics.executorThrows,
        failedFinal: metrics.failedFinal,
        ready: metrics.ready,
        recoverPendingNow: scheduler.recoverPending(),
      }),
    );
    // CONTRACT (scheduler doc L30-L34, L117): an outcome the scheduler cannot
    // honour is "the same honest failure" as an executor throw — counted,
    // recorded on the task, event reverted to 'pending', queue keeps pumping,
    // drained() resolves. OBSERVED (pinned):
    expect(drainedError).toMatch(/cannot be marked 'ready' without an AnalysisRecord/);
    expect(statesAfterReject).toEqual(["processing", "pending", "pending"]);
    expect(afterReject.queueDepth).toBe(2); // pump() after applyOutcome never ran
    expect(afterReject.inFlight).toBe(0); // …but the slot WAS released (L380 precedes the throw)
    expect(states).toEqual(["processing", "ready", "ready"]);
    expect(e1.outcome).toBeNull();
    expect(e1.failures).toEqual([]);
    expect(metrics.executorThrows).toBe(0);
    expect(metrics.failedFinal).toBe(0);
    expect(metrics.ready).toBe(2);
    // …and the S2 gap compounds it: E1 is 'processing', so recovery skips it.
    expect(scheduler.recoverPending({ readmitExhausted: true })).toEqual([]);
  });

  it("BROKEN (P2, pre-existing): with NO drained() waiter the same outcome is an UNHANDLED PROMISE REJECTION (process-level in Node; red-box/logged in RN) — the tracked settle promise has no rejection handler", async () => {
    const engine = closedEngine("s7-unhandled", 1);
    const executor = scriptedExecutor(
      () => ({ status: "ready", analysis: null as never }) as SessionAnalysisTaskOutcome,
    );
    const unhandled: string[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason instanceof Error ? reason.message : String(reason));
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const scheduler = new SessionAnalysisScheduler({ engine, executor });
      scheduler.recoverPending();
      // Nobody awaits drained(); give the microtask chain + Node's
      // unhandled-rejection sweep a few macrotasks to run.
      await tick(20);
      await tick(20);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    console.log(JSON.stringify({ scenario: "S7-unhandled-rejection", unhandled }));
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0]).toMatch(/cannot be marked 'ready' without an AnalysisRecord/);
    expect(engine.eventState("E1")).toBe("processing");
  });

  it("HELD: the SAME class of misbehaviour via a throw or a rejection IS counted, reverted and pumped past (control for the null-analysis case)", async () => {
    const engine = closedEngine("s7-control", 3);
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E1") throw new Error("boom-sync");
      if (task.eventId === "E2") return Promise.reject(new Error("boom-async"));
      return { status: "ready", analysis: fakeAnalysis };
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    scheduler.recoverPending();
    await scheduler.drained();
    const metrics = scheduler.metrics();
    expect(engine.snapshot().events.map((e) => e.state)).toEqual(["pending", "pending", "ready"]);
    expect(metrics.executorThrows).toBe(2);
    expect(metrics.failedFinal).toBe(2);
    expect(metrics.tasks.map((t) => t.failures.length)).toEqual([1, 1, 0]);
  });

  it("GAP (P3, pre-existing): other contract-violating outcomes are applied verbatim — abstained with '' / undefined reason and an unknown status become silent terminal states", async () => {
    const engine = closedEngine("s7-other-shapes", 3);
    const executor = scriptedExecutor((task) => {
      if (task.eventId === "E1") return { status: "abstained", abstainReason: "" };
      if (task.eventId === "E2")
        return {
          status: "abstained",
          abstainReason: undefined as never,
        } as SessionAnalysisTaskOutcome;
      return { status: "bogus" } as unknown as SessionAnalysisTaskOutcome;
    });
    const scheduler = new SessionAnalysisScheduler({ engine, executor, concurrency: 1 });
    scheduler.recoverPending();
    await scheduler.drained();
    const events = engine.snapshot().events.map((e) => ({
      id: e.eventId,
      state: e.state,
      abstainReason: e.abstainReason,
    }));
    const metrics = scheduler.metrics();
    console.log(
      JSON.stringify({
        scenario: "S7-other-shapes",
        events,
        tasks: metrics.tasks.map((t) => [t.eventId, t.outcome, t.failures]),
      }),
    );
    // OBSERVED (pinned): E1/E2 terminal 'abstained' with an empty/null
    // reason; E3 (unknown status) falls into the failure branch with
    // reason `undefined` and retryable `undefined` → 'failed_final' with the
    // string "attempt 1: undefined" recorded.
    expect(events).toEqual([
      { id: "E1", state: "abstained", abstainReason: "" },
      { id: "E2", state: "abstained", abstainReason: null },
      { id: "E3", state: "pending", abstainReason: null },
    ]);
    expect(metrics.tasks.map((t) => [t.eventId, t.outcome])).toEqual([
      ["E1", "abstained"],
      ["E2", "abstained"],
      ["E3", "failed_final"],
    ]);
    expect(metrics.tasks[2]!.failures).toEqual(["attempt 1: undefined"]);
  });
});

describe("ATTACK (own) — interleavings, clock skew, storms", () => {
  it("HELD: 60 events with a seeded random executor (ready/abstain/retryable/non-retryable/throw) under concurrency 3 — every event terminal or honestly pending, metrics add up, FIFO first-dispatch order", async () => {
    // 60 (not more): building the engine costs O(n²) in samples — see the
    // MEASURE test in attackPass3SessionEngine.test.ts.
    const SEED = 0x5eed_2026;
    let state = SEED >>> 0;
    const rand = () => {
      // xorshift32 — deterministic across runs; seed recorded in the log.
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0x1_0000_0000;
    };
    const engine = closedEngine("own-storm", 60);
    const executor = scriptedExecutor(async () => {
      await tick(rand() < 0.3 ? 1 : 0);
      const roll = rand();
      if (roll < 0.5) return { status: "ready", analysis: fakeAnalysis };
      if (roll < 0.65) return { status: "abstained", abstainReason: "RANDOM_ABSTAIN" };
      if (roll < 0.85) return { status: "failed", reason: "RANDOM_RETRYABLE", retryable: true };
      if (roll < 0.95) return { status: "failed", reason: "RANDOM_FINAL", retryable: false };
      throw new Error("RANDOM_THROW");
    });
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor,
      concurrency: 3,
      maxAttempts: 3,
    });
    scheduler.recoverPending();
    // Interleave suspend/resume bursts while the storm drains.
    const drained = scheduler.drained();
    for (let index = 0; index < 20; index += 1) {
      scheduler.suspend();
      await tick(1);
      scheduler.resume();
      await tick(1);
    }
    await drained;
    const metrics = scheduler.metrics();
    const states = engine.snapshot().events.map((e) => e.state);
    console.log(
      JSON.stringify({
        scenario: "own-seeded-storm",
        seed: SEED,
        ready: metrics.ready,
        abstained: metrics.abstained,
        failedFinal: metrics.failedFinal,
        retryExhausted: metrics.retryExhausted,
        executorThrows: metrics.executorThrows,
        retries: metrics.retries,
        dispatched: metrics.dispatched,
        maxInFlight: metrics.maxInFlight,
      }),
    );
    expect(metrics.enqueued).toBe(60);
    expect(metrics.ready + metrics.abstained + metrics.failedFinal + metrics.retryExhausted).toBe(
      60,
    );
    expect(metrics.queueDepth).toBe(0);
    expect(metrics.inFlight).toBe(0);
    expect(metrics.maxInFlight).toBeLessThanOrEqual(3);
    expect(metrics.dispatched).toBe(60 + metrics.retries);
    expect(states.filter((s) => s === "processing")).toHaveLength(0);
    expect(states.filter((s) => s === "ready")).toHaveLength(metrics.ready);
    expect(states.filter((s) => s === "abstained")).toHaveLength(metrics.abstained);
    expect(states.filter((s) => s === "pending")).toHaveLength(
      metrics.failedFinal + metrics.retryExhausted,
    );
    // Every terminal record explains itself.
    for (const task of metrics.tasks) {
      if (task.outcome === "failed_final" || task.outcome === "retry_exhausted") {
        expect(task.failures.length).toBe(task.attempts);
      }
      if (task.outcome === "retry_exhausted") expect(task.attempts).toBe(3);
    }
    // FIRST dispatch order is FIFO (E1 … E60); retries go to the back.
    const firstDispatch = new Map<string, number>();
    executor.calls.forEach((call, index) => {
      if (!firstDispatch.has(call.eventId)) firstDispatch.set(call.eventId, index);
    });
    const order = [...firstDispatch.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    expect(order).toEqual(Array.from({ length: 60 }, (_, index) => `E${index + 1}`));
  }, 60_000);

  it("HELD: a wall clock that jumps backwards mid-task and NaN clock values never produce negative durations, and NaN is passed through (not sanitized) as documented behaviour", async () => {
    const engine = closedEngine("own-clock", 2);
    const clock = [1_000_000, 1_000_000, 500_000, 500_000, NaN, NaN, NaN, NaN];
    let index = 0;
    const now = () => clock[Math.min(index++, clock.length - 1)]!;
    const scheduler = new SessionAnalysisScheduler({
      engine,
      executor: scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis })),
      now,
    });
    scheduler.recoverPending();
    await scheduler.drained();
    const tasks = scheduler.metrics().tasks;
    console.log(JSON.stringify({ scenario: "own-clock-skew", tasks }));
    for (const task of tasks) {
      for (const value of [task.queueWaitMs, task.serviceMs, task.totalLatencyMs]) {
        expect(value === null || Number.isNaN(value) || value >= 0).toBe(true);
      }
    }
    expect(engine.snapshot().events.map((e) => e.state)).toEqual(["ready", "ready"]);
  });

  it("HELD: endOfStream() twice + pushSamples() after it enqueues nothing twice — duplicate refusals are counted, never re-dispatched", async () => {
    const engine = new SessionEventEngine({ sessionId: "own-eos-twice" });
    const executor = scriptedExecutor(() => ({ status: "ready", analysis: fakeAnalysis }));
    const scheduler = new SessionAnalysisScheduler({ engine, executor });
    scheduler.pushSamples({ wrist: strokes(2) });
    expect(scheduler.endOfStream().length + scheduler.endOfStream().length).toBeLessThanOrEqual(2);
    await scheduler.drained();
    expect(executor.calls.map((c) => c.eventId)).toEqual(["E1", "E2"]);
    // Late replay of the identical stream after end-of-stream: the engine
    // drops everything at/behind the frontier, so nothing new is enqueued.
    const late = scheduler.pushSamples({ wrist: strokes(2).slice(0, 60) });
    expect(late).toEqual([]);
    await scheduler.drained();
    expect(executor.calls).toHaveLength(2);
    expect(scheduler.metrics().duplicatesRefused).toBe(0);
    expect(engine.snapshot().qualityState.droppedLateSamples).toBeGreaterThan(0);
  });
});
