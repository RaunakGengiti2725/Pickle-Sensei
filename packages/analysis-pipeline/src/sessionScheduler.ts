import type { AnalysisRecord } from "@pickle/swing-domain";
import type {
  SessionEventCloseReason,
  SessionEventEngine,
  SessionEventState,
  SessionStrokeEvent,
  SpeedSample,
  StrokeEventProposalV2,
} from "./sessionEngine.js";

/**
 * SESSION ANALYSIS SCHEDULER — progressive per-event analysis while
 * RECORDING NEVER STOPS (E1 closes → analyze while E2 records → …).
 *
 * The SessionEventEngine answers "which closed StrokeEvents exist so far?";
 * this module owns the OTHER half of session mode: WHEN each closed event's
 * analysis runs, under bounded concurrency, with honest outcomes when
 * extraction or analysis cannot complete. It composes the engine (never
 * re-implements event identity/completion) and drives the engine's own
 * per-event lifecycle (`markEvent`), so every honesty invariant the engine
 * enforces (terminal append-only, 'ready' requires a real AnalysisRecord,
 * processing→pending is the only revert) also binds the scheduler.
 *
 * CONTRACTS:
 *
 *  1. EVERY closed event is enqueued exactly once, in emission (= time)
 *     order, at the moment the engine closes it. FIFO within a session:
 *     retried tasks re-enter at the BACK of the queue (a stuck event may
 *     never starve newer ones).
 *
 *  2. OUTCOME HONESTY mirrors the mobile flow's seam semantics
 *     (apps/mobile/src/flow/session.ts): 'ready' only with a real
 *     AnalysisRecord; 'abstained' only when the ANALYSIS abstained; a failed
 *     or unavailable extraction/analysis reverts the event to 'pending' with
 *     a recorded reason — never a fabricated result, never a fake abstain.
 *
 *  3. RETRY only on failures the executor declares retryable (e.g. transient
 *     extraction failure), up to `maxAttempts` total; exhausted retries
 *     leave the event honestly 'pending' with the final failure recorded.
 *
 *  4. INTERRUPTION/RECOVERY: `suspend()` halts new dispatches (in-flight
 *     work settles and its outcome is still applied — results are never
 *     dropped on the floor); `resume()` continues. `recoverPending()`
 *     re-enqueues engine events that are non-terminal and not already
 *     tracked — the restart path after a crash/kill where queue state was
 *     lost but the engine's session survived.
 *
 *  5. METRICS are measured, per event and aggregate: queue wait, service
 *     time, close→terminal latency, attempts, backlog high-water mark.
 *     The clock is injectable so simulations can use a virtual clock.
 *
 *  6. LIVENESS. A concurrency slot is held only for a bounded time: every
 *     attempt runs under `taskTimeoutMs` (finite by default); an executor
 *     that has not settled by the deadline fails that attempt with
 *     `EXECUTOR_TIMEOUT` (retryable — `maxAttempts` governs it), the event
 *     reverts to 'pending', the slot is released and the queue continues.
 *     A settlement arriving after its deadline is not a result and is
 *     ignored (counted, never applied). The deadline is not a dispatch, so
 *     it also fires while suspended.
 *
 *  7. EXTERNAL WRITERS. The engine is shared state; a recovery path or a
 *     second writer may settle an event this scheduler holds or awaits a
 *     lease on. Every engine transition the scheduler drives (processing,
 *     ready, abstained, pending) is therefore guarded: a refused transition
 *     is recorded on the task as an `ENGINE_TRANSITION` failure
 *     (`failed_final`), the slot is released and the queue continues. No
 *     transition error ever escapes into the sample-feeding path, `resume()`,
 *     or the settle chain (which would reject `drained()`).
 */

export const SESSION_SCHEDULER_VERSION =
  "session-scheduler-2 (bounded-concurrency FIFO over SessionEventEngine closures · retryable-failure revert-to-pending · suspend/resume + recoverPending · per-attempt deadline (EXECUTOR_TIMEOUT) · guarded engine transitions (ENGINE_TRANSITION))";

/** Default per-attempt deadline. On-device clip extraction + analysis for one
 * stroke is expected to settle well inside this; a slot held longer is a hung
 * executor, not a slow one. */
export const DEFAULT_SESSION_TASK_TIMEOUT_MS = 120_000;

/** Everything the executor gets for one closed event. Bounds come from the
 * frozen proposal verbatim; executors must never alter them. */
export interface SessionAnalysisTask {
  sessionId: string;
  eventId: string;
  proposal: StrokeEventProposalV2;
  closeReason: SessionEventCloseReason;
  closedAtMs: number;
  /** 1-based attempt counter (1 = first try). */
  attempt: number;
}

export type SessionAnalysisTaskOutcome =
  /** A REAL AnalysisRecord from the canonical pipeline. Never fabricated. */
  | { status: "ready"; analysis: AnalysisRecord }
  /** The analysis itself abstained (its honest negative). */
  | { status: "abstained"; abstainReason: string }
  /** Extraction/analysis could not complete. `retryable: true` re-enqueues
   * (up to maxAttempts); otherwise the event stays honestly pending. */
  | { status: "failed"; reason: string; retryable: boolean };

export interface SessionAnalysisExecutor {
  readonly executorId: string;
  execute(task: SessionAnalysisTask): Promise<SessionAnalysisTaskOutcome>;
}

export type SessionTaskTerminal = "ready" | "abstained" | "failed_final" | "retry_exhausted";

/** Measured lifecycle of one event through the scheduler. Times come from
 * the injected clock (default Date.now). */
export interface SessionTaskRecord {
  eventId: string;
  attempts: number;
  enqueuedAt: number;
  /** First dispatch start; null while still queued. */
  startedAt: number | null;
  /** Terminal settle time; null while queued/in-flight/retrying. */
  finishedAt: number | null;
  /** enqueue → first dispatch. */
  queueWaitMs: number | null;
  /** Sum of executor time across attempts. */
  serviceMs: number;
  /** enqueue → terminal (includes retries + re-queue waits). */
  totalLatencyMs: number | null;
  outcome: SessionTaskTerminal | null;
  /** Recorded failure reasons, one per failed attempt — never silent. */
  failures: string[];
}

export interface SessionSchedulerMetrics {
  executorId: string;
  concurrency: number;
  maxAttempts: number;
  enqueued: number;
  /** Duplicate enqueue attempts refused (exactly-once guard). */
  duplicatesRefused: number;
  dispatched: number;
  retries: number;
  ready: number;
  abstained: number;
  failedFinal: number;
  retryExhausted: number;
  /** Executor throws (counted as non-retryable failures) — never silent. */
  executorThrows: number;
  /** Attempts that hit the per-attempt deadline (EXECUTOR_TIMEOUT). */
  timedOut: number;
  /** Executor settlements that arrived after their attempt's deadline and
   * were therefore not applied. */
  lateSettlementsIgnored: number;
  /** Engine transitions the scheduler attempted that the engine refused
   * (event settled by another writer) — each is a recorded task failure. */
  engineTransitionRefusals: number;
  taskTimeoutMs: number;
  queueDepth: number;
  inFlight: number;
  maxQueueDepth: number;
  maxInFlight: number;
  suspended: boolean;
  tasks: SessionTaskRecord[];
}

export interface SessionSchedulerOptions {
  engine: SessionEventEngine;
  executor: SessionAnalysisExecutor;
  /** Parallel analysis slots (device budget). Default 1. */
  concurrency?: number;
  /** Total tries per event including the first. Default 2. */
  maxAttempts?: number;
  /** Per-attempt deadline in wall-clock milliseconds (see contract 6).
   * Default DEFAULT_SESSION_TASK_TIMEOUT_MS. Must be a positive finite
   * number; `Infinity` disables the deadline (explicit opt-out only). */
  taskTimeoutMs?: number;
  /** Injectable clock for simulation; default Date.now. */
  now?: () => number;
}

interface QueuedTask {
  event: SessionStrokeEvent;
  attempt: number;
  /** Last attempt number this task's budget allows (recovery leases carry
   * their own fresh budget: readmission ceiling = attempts-so-far + maxAttempts). */
  attemptCeiling: number;
}

export class SessionAnalysisScheduler {
  private readonly engine: SessionEventEngine;
  private readonly executor: SessionAnalysisExecutor;
  /** Immutable for the engine's lifetime; cached so dispatch never pays for
   * a full snapshot (which copies every event) just to read the id. */
  private readonly sessionId: string;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly taskTimeoutMs: number;
  private readonly now: () => number;

  private readonly queue: QueuedTask[] = [];
  private readonly records = new Map<string, SessionTaskRecord>();
  private readonly inFlightIds = new Set<string>();
  private readonly settlePromises = new Set<Promise<void>>();
  private suspendedFlag = false;
  private duplicatesRefused = 0;
  private dispatched = 0;
  private retries = 0;
  private executorThrows = 0;
  private timedOut = 0;
  private lateSettlementsIgnored = 0;
  private engineTransitionRefusals = 0;
  private maxQueueDepth = 0;
  private maxInFlight = 0;

  constructor(options: SessionSchedulerOptions) {
    this.engine = options.engine;
    this.sessionId = options.engine.snapshot().sessionId;
    this.executor = options.executor;
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    const timeout = options.taskTimeoutMs ?? DEFAULT_SESSION_TASK_TIMEOUT_MS;
    if (Number.isNaN(timeout) || timeout <= 0) {
      throw new Error(
        `SessionAnalysisScheduler: taskTimeoutMs must be a positive number of milliseconds (got ${String(timeout)})`,
      );
    }
    this.taskTimeoutMs = timeout;
    this.now = options.now ?? Date.now;
  }

  /** Feed samples through the engine; every event the engine closes because
   * of this push is enqueued immediately (recording continues while queued
   * work analyzes — the progressive contract). Returns the closed events. */
  pushSamples(input: {
    wrist?: readonly SpeedSample[];
    paddle?: readonly SpeedSample[];
  }): SessionStrokeEvent[] {
    const closed = this.engine.push(input);
    for (const event of closed) this.enqueue(event, 1);
    this.pump();
    return closed;
  }

  /** End of recording: flush the engine's remaining candidates into the
   * queue. Analysis of the backlog continues after the stream ends. */
  endOfStream(): SessionStrokeEvent[] {
    const closed = this.engine.flush();
    for (const event of closed) this.enqueue(event, 1);
    this.pump();
    return closed;
  }

  /** Interruption: stop dispatching new tasks. In-flight executions settle
   * and their outcomes are still applied — never dropped. */
  suspend(): void {
    this.suspendedFlag = true;
  }

  /** Recovery from suspension: continue dispatching. */
  resume(): void {
    this.suspendedFlag = false;
    this.pump();
  }

  /** Restart-path recovery: re-enqueue engine events that are non-terminal
   * ('pending' — including honest reverts after failures) and not already
   * queued/in-flight. Terminal events are never re-dispatched; events whose
   * retries were exhausted are re-admitted with a fresh attempt budget only
   * when `readmitExhausted` is set (explicit operator decision). Returns the
   * re-enqueued eventIds. */
  recoverPending(options?: { readmitExhausted?: boolean }): string[] {
    const readmitted: string[] = [];
    for (const event of this.engine.snapshot().events) {
      if (event.state !== "pending") continue;
      if (this.inFlightIds.has(event.eventId)) continue;
      if (this.queue.some((entry) => entry.event.eventId === event.eventId)) continue;
      const record = this.records.get(event.eventId);
      if (record?.outcome === "ready" || record?.outcome === "abstained") continue;
      const exhausted = record?.outcome === "retry_exhausted" || record?.outcome === "failed_final";
      if (exhausted && !options?.readmitExhausted) continue;
      if (record) {
        // Fresh recovery lease: the terminal verdict is superseded by an
        // explicit recovery decision; prior failures stay recorded. The lease
        // carries its own full attempt budget.
        record.outcome = null;
        record.finishedAt = null;
        this.enqueueExisting(event, record.attempts + 1, record.attempts + this.maxAttempts);
      } else {
        this.enqueue(event, 1);
      }
      readmitted.push(event.eventId);
    }
    this.pump();
    return readmitted;
  }

  /** Resolves once the queue is empty and nothing is in flight (suspension
   * counts as drained-for-now only when nothing is in flight AND queued —
   * a suspended non-empty queue keeps this pending until resumed). */
  async drained(): Promise<void> {
    for (;;) {
      if (this.settlePromises.size > 0) {
        await Promise.all([...this.settlePromises]);
        continue;
      }
      if (this.queue.length === 0 && this.inFlightIds.size === 0) return;
      if (this.suspendedFlag) {
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 5));
        continue;
      }
      this.pump();
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));
    }
  }

  metrics(): SessionSchedulerMetrics {
    let ready = 0;
    let abstained = 0;
    let failedFinal = 0;
    let retryExhausted = 0;
    for (const record of this.records.values()) {
      if (record.outcome === "ready") ready += 1;
      else if (record.outcome === "abstained") abstained += 1;
      else if (record.outcome === "failed_final") failedFinal += 1;
      else if (record.outcome === "retry_exhausted") retryExhausted += 1;
    }
    return {
      executorId: this.executor.executorId,
      concurrency: this.concurrency,
      maxAttempts: this.maxAttempts,
      enqueued: this.records.size,
      duplicatesRefused: this.duplicatesRefused,
      dispatched: this.dispatched,
      retries: this.retries,
      ready,
      abstained,
      failedFinal,
      retryExhausted,
      executorThrows: this.executorThrows,
      timedOut: this.timedOut,
      lateSettlementsIgnored: this.lateSettlementsIgnored,
      engineTransitionRefusals: this.engineTransitionRefusals,
      taskTimeoutMs: this.taskTimeoutMs,
      queueDepth: this.queue.length,
      inFlight: this.inFlightIds.size,
      maxQueueDepth: this.maxQueueDepth,
      maxInFlight: this.maxInFlight,
      suspended: this.suspendedFlag,
      tasks: [...this.records.values()].map((record) => ({ ...record })),
    };
  }

  private enqueue(event: SessionStrokeEvent, attempt: number): void {
    if (this.records.has(event.eventId)) {
      this.duplicatesRefused += 1;
      return;
    }
    this.records.set(event.eventId, {
      eventId: event.eventId,
      attempts: 0,
      enqueuedAt: this.now(),
      startedAt: null,
      finishedAt: null,
      queueWaitMs: null,
      serviceMs: 0,
      totalLatencyMs: null,
      outcome: null,
      failures: [],
    });
    this.queue.push({ event, attempt, attemptCeiling: this.maxAttempts });
    this.maxQueueDepth = Math.max(this.maxQueueDepth, this.queue.length);
  }

  private enqueueExisting(
    event: SessionStrokeEvent,
    attempt: number,
    attemptCeiling: number,
  ): void {
    this.queue.push({ event, attempt, attemptCeiling });
    this.maxQueueDepth = Math.max(this.maxQueueDepth, this.queue.length);
  }

  private pump(): void {
    while (
      !this.suspendedFlag &&
      this.inFlightIds.size < this.concurrency &&
      this.queue.length > 0
    ) {
      const task = this.queue.shift()!;
      this.dispatch(task);
    }
  }

  private dispatch(task: QueuedTask): void {
    const { event, attempt } = task;
    const record = this.records.get(event.eventId)!;
    this.dispatched += 1;
    if (attempt > 1) this.retries += 1;
    record.attempts = attempt;
    const startedAt = this.now();
    record.startedAt ??= startedAt;
    // Clamped at 0: a wall clock may step backwards (NTP correction, device
    // clock reset); measured durations are never negative.
    record.queueWaitMs ??= Math.max(0, startedAt - record.enqueuedAt);
    // The lease is taken BEFORE the slot: an event another writer settled
    // while it sat in the queue never occupies a slot or reaches the executor.
    const leaseRefused = this.transition(event.eventId, "processing");
    if (leaseRefused !== null) {
      record.failures.push(`attempt ${attempt}: ${leaseRefused}`);
      this.finish(record, "failed_final");
      return;
    }
    this.inFlightIds.add(event.eventId);
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlightIds.size);
    let executed: Promise<SessionAnalysisTaskOutcome>;
    try {
      // A misbehaving executor may throw synchronously instead of returning
      // a rejected promise; both are the same honest failure, and neither may
      // escape into the sample-feeding path or leak the dispatch slot.
      executed = this.executor.execute({
        sessionId: this.sessionId,
        eventId: event.eventId,
        proposal: event.proposal,
        closeReason: event.closeReason,
        closedAtMs: event.closedAtMs,
        attempt,
      });
    } catch (error) {
      executed = Promise.reject(error);
    }
    // First settlement wins: the executor's outcome or the deadline, never
    // both. Whatever loses is not applied to the record or the engine.
    const settle = new Promise<SessionAnalysisTaskOutcome>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settleOnce = (outcome: SessionAnalysisTaskOutcome): void => {
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(outcome);
      };
      if (Number.isFinite(this.taskTimeoutMs)) {
        timer = setTimeout(() => {
          if (settled) return;
          this.timedOut += 1;
          settleOnce({
            status: "failed",
            reason: `EXECUTOR_TIMEOUT: attempt did not settle within ${this.taskTimeoutMs} ms`,
            retryable: true,
          });
        }, this.taskTimeoutMs);
      }
      executed.then(
        (outcome) => {
          if (settled) {
            this.lateSettlementsIgnored += 1;
            return;
          }
          settleOnce(outcome);
        },
        (error: unknown) => {
          if (settled) {
            this.lateSettlementsIgnored += 1;
            return;
          }
          this.executorThrows += 1;
          settleOnce({
            status: "failed",
            reason: `EXECUTOR_THREW: ${error instanceof Error ? error.message : String(error)}`,
            retryable: false,
          });
        },
      );
    }).then((outcome) => {
      record.serviceMs += Math.max(0, this.now() - startedAt);
      this.inFlightIds.delete(event.eventId);
      try {
        this.applyOutcome(task, outcome, record);
      } finally {
        this.pump();
      }
    });
    const tracked: Promise<void> = settle.finally(() => {
      this.settlePromises.delete(tracked);
    });
    this.settlePromises.add(tracked);
  }

  private applyOutcome(
    task: QueuedTask,
    outcome: SessionAnalysisTaskOutcome,
    record: SessionTaskRecord,
  ): void {
    const { event, attempt } = task;
    if (outcome.status === "ready") {
      const refused = this.transition(event.eventId, "ready", { analysis: outcome.analysis });
      if (refused !== null) {
        record.failures.push(`attempt ${attempt}: ${refused}`);
        this.finish(record, "failed_final");
        return;
      }
      this.finish(record, "ready");
      return;
    }
    if (outcome.status === "abstained") {
      const refused = this.transition(event.eventId, "abstained", {
        abstainReason: outcome.abstainReason,
      });
      if (refused !== null) {
        record.failures.push(`attempt ${attempt}: ${refused}`);
        this.finish(record, "failed_final");
        return;
      }
      this.finish(record, "abstained");
      return;
    }
    // Failure: honest revert to 'pending' (the engine's only allowed revert);
    // the reason is recorded on the task record — never silent.
    record.failures.push(`attempt ${attempt}: ${outcome.reason}`);
    const refused = this.transition(event.eventId, "pending");
    if (refused !== null) {
      // The event was settled by another writer while this attempt ran; there
      // is nothing left to retry against.
      record.failures.push(`attempt ${attempt}: ${refused}`);
      this.finish(record, "failed_final");
      return;
    }
    if (outcome.retryable && attempt < task.attemptCeiling) {
      // Back of the queue: a flaky event may never starve newer events.
      this.enqueueExisting(event, attempt + 1, task.attemptCeiling);
      return;
    }
    this.finish(record, outcome.retryable ? "retry_exhausted" : "failed_final");
  }

  /** The single seam through which the scheduler writes engine state. The
   * engine's honesty invariants (terminal append-only, ready needs an
   * AnalysisRecord, only processing→pending reverts) may refuse a
   * transition when another writer got there first; that refusal is a fact
   * about the event, returned as an `ENGINE_TRANSITION` reason for the task
   * record — never thrown into the feed path or the settle chain. */
  private transition(
    eventId: string,
    state: SessionEventState,
    outcome?: { analysis?: AnalysisRecord | null; abstainReason?: string | null },
  ): string | null {
    try {
      this.engine.markEvent(eventId, state, outcome);
      return null;
    } catch (error) {
      this.engineTransitionRefusals += 1;
      const message = error instanceof Error ? error.message : String(error);
      return `ENGINE_TRANSITION(${state}): ${message}`;
    }
  }

  private finish(record: SessionTaskRecord, outcome: SessionTaskTerminal): void {
    record.outcome = outcome;
    record.finishedAt = this.now();
    record.totalLatencyMs = Math.max(0, record.finishedAt - record.enqueuedAt);
  }
}
