import type { Session, SessionStrokeEvent } from "./sessionEngine.js";
import type { SessionSchedulerMetrics, SessionTaskRecord } from "./sessionScheduler.js";

/**
 * SESSION OPERATIONS HEALTH — the production observability contract for one
 * session run: given the engine's Session snapshot and the scheduler's
 * measured metrics, answer "did operations keep the analysis promise for
 * EVERY detected event?" with measured numbers, never inference.
 *
 * WHAT IT MEASURES (all derived from real engine/scheduler state):
 *  - events per session (detected by the engine, by lifecycle state);
 *  - clips extracted vs analyzed: extraction attempted = the event was
 *    dispatched to the executor at least once; analyzed = the analysis
 *    reached a terminal honest outcome (ready OR abstained — an abstain is
 *    an analyzed event, a failure is not);
 *  - processing backlog: live queue depth / in-flight and their high-water
 *    marks;
 *  - dropped events: engine-detected events the scheduler never tracked
 *    (never enqueued) plus late samples the engine refused;
 *  - per-event latency: queue wait, service time, close→terminal, aggregated
 *    (mean/max) over settled events only — unsettled events have no latency
 *    to report and are counted, not averaged in;
 *  - session completion: every detected event reached a terminal analysis
 *    state with nothing queued or in flight.
 *
 * HARD FAILURE CONTRACT: at end of session, a detected event without an
 * analyzed outcome is a production failure — detecting E1/E2/E3 but
 * analyzing only E1 is PARTIAL_EVENT_ANALYSIS, a hard signal, regardless of
 * whether the shortfall was a drop (never enqueued), a stuck pending, or an
 * exhausted retry. Honest per-event failure handling in the scheduler does
 * NOT excuse the session-level shortfall: the user was promised analysis of
 * every stroke.
 *
 * SUMMARY GENERATION is gated on that contract: a session summary is only
 * generated from full coverage; anything less returns an explicit refusal
 * with the reason — never a summary silently computed over a subset.
 */

export const SESSION_OPS_HEALTH_VERSION =
  "session-ops-health-1 (engine-snapshot + scheduler-metrics derived · PARTIAL_EVENT_ANALYSIS hard signal · coverage-gated summary)";

export type SessionOpsFailureSignal =
  /** Detected events without an analyzed (ready|abstained) outcome at end of
   * session — e.g. E1/E2/E3 detected but only E1 analyzed. HARD failure. */
  | "PARTIAL_EVENT_ANALYSIS"
  /** Engine-detected events the scheduler never tracked at all. HARD failure
   * (a silent drop, distinct from an honest tracked failure). */
  | "DROPPED_EVENTS"
  /** End of session declared but work is still queued or in flight. */
  | "BACKLOG_NOT_DRAINED"
  /** The engine refused late samples (input-side loss; degradation). */
  | "LATE_SAMPLES_DROPPED";

export type SessionOpsVerdict = "healthy" | "degraded" | "failed";

export interface SessionEventOpsRecord {
  eventId: string;
  state: SessionStrokeEvent["state"];
  /** Scheduler ever dispatched this event (= clip extraction attempted). */
  extractionAttempted: boolean;
  /** Terminal honest analysis outcome (ready or abstained). */
  analyzed: boolean;
  attempts: number;
  queueWaitMs: number | null;
  serviceMs: number | null;
  /** close→terminal latency (enqueue→terminal, includes retries). */
  totalLatencyMs: number | null;
  /** Recorded failure reasons from the scheduler — never silent. */
  failures: string[];
  /** Engine detected it but the scheduler never tracked it. */
  droppedBeforeQueue: boolean;
}

export interface SessionLatencyAggregate {
  /** Settled events contributing latency numbers. */
  settledCount: number;
  meanQueueWaitMs: number | null;
  maxQueueWaitMs: number | null;
  meanServiceMs: number | null;
  maxServiceMs: number | null;
  meanTotalLatencyMs: number | null;
  maxTotalLatencyMs: number | null;
}

export interface SessionOpsHealthReport {
  version: string;
  sessionId: string;
  /** Events the engine closed (detected) this session. */
  eventsDetected: number;
  eventsByState: Record<SessionStrokeEvent["state"], number>;
  /** Extraction attempted = dispatched at least once. */
  clipsExtractionAttempted: number;
  /** Analyzed = terminal ready or abstained. */
  eventsAnalyzed: number;
  eventsReady: number;
  eventsAbstained: number;
  /** Tracked by the scheduler but not analyzed (failed/exhausted/stuck). */
  eventsUnanalyzedTracked: number;
  /** Detected by the engine but never tracked by the scheduler. */
  eventsDroppedBeforeQueue: number;
  droppedLateSamples: number;
  backlog: {
    queueDepth: number;
    inFlight: number;
    maxQueueDepth: number;
    maxInFlight: number;
    suspended: boolean;
  };
  latency: SessionLatencyAggregate;
  /** Every detected event analyzed, nothing queued/in-flight. */
  sessionComplete: boolean;
  events: SessionEventOpsRecord[];
  failureSignals: SessionOpsFailureSignal[];
  verdict: SessionOpsVerdict;
}

export type SessionOpsSummary =
  | {
      status: "generated";
      sessionId: string;
      eventsDetected: number;
      eventsReady: number;
      eventsAbstained: number;
      meanTotalLatencyMs: number | null;
      maxTotalLatencyMs: number | null;
    }
  /** Coverage-gated refusal: never a summary over a subset of events. */
  | { status: "refused"; sessionId: string; reason: string };

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function max(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((best, value) => Math.max(best, value), -Infinity);
}

/** Assess operations health for one session at a point in time. Pass
 * `endOfSession: true` once recording has ended and the caller expects the
 * backlog drained — that is when coverage shortfalls become HARD failures. */
export function assessSessionOpsHealth(
  session: Session,
  metrics: SessionSchedulerMetrics,
  options: { endOfSession: boolean },
): SessionOpsHealthReport {
  const taskById = new Map<string, SessionTaskRecord>(
    metrics.tasks.map((task) => [task.eventId, task]),
  );
  const eventsByState: Record<SessionStrokeEvent["state"], number> = {
    pending: 0,
    processing: 0,
    ready: 0,
    abstained: 0,
  };
  const events: SessionEventOpsRecord[] = session.events.map((event) => {
    eventsByState[event.state] += 1;
    const task = taskById.get(event.eventId) ?? null;
    const analyzed = event.state === "ready" || event.state === "abstained";
    return {
      eventId: event.eventId,
      state: event.state,
      extractionAttempted: task !== null && task.attempts > 0,
      analyzed,
      attempts: task?.attempts ?? 0,
      queueWaitMs: task?.queueWaitMs ?? null,
      serviceMs: task ? task.serviceMs : null,
      totalLatencyMs: task?.totalLatencyMs ?? null,
      failures: task ? [...task.failures] : [],
      droppedBeforeQueue: task === null,
    };
  });
  const analyzedEvents = events.filter((event) => event.analyzed);
  const settled = events.filter((event) => event.totalLatencyMs !== null);
  const latency: SessionLatencyAggregate = {
    settledCount: settled.length,
    meanQueueWaitMs: mean(settled.flatMap((e) => (e.queueWaitMs === null ? [] : [e.queueWaitMs]))),
    maxQueueWaitMs: max(settled.flatMap((e) => (e.queueWaitMs === null ? [] : [e.queueWaitMs]))),
    meanServiceMs: mean(settled.flatMap((e) => (e.serviceMs === null ? [] : [e.serviceMs]))),
    maxServiceMs: max(settled.flatMap((e) => (e.serviceMs === null ? [] : [e.serviceMs]))),
    meanTotalLatencyMs: mean(settled.map((e) => e.totalLatencyMs!)),
    maxTotalLatencyMs: max(settled.map((e) => e.totalLatencyMs!)),
  };
  const droppedBeforeQueue = events.filter((event) => event.droppedBeforeQueue).length;
  const backlogRemaining = metrics.queueDepth > 0 || metrics.inFlight > 0;
  const sessionComplete =
    session.events.length > 0 &&
    analyzedEvents.length === session.events.length &&
    !backlogRemaining;

  const failureSignals: SessionOpsFailureSignal[] = [];
  if (options.endOfSession) {
    if (session.events.length > 0 && analyzedEvents.length < session.events.length) {
      failureSignals.push("PARTIAL_EVENT_ANALYSIS");
    }
    if (droppedBeforeQueue > 0) failureSignals.push("DROPPED_EVENTS");
    if (backlogRemaining) failureSignals.push("BACKLOG_NOT_DRAINED");
  }
  if (session.qualityState.droppedLateSamples > 0) failureSignals.push("LATE_SAMPLES_DROPPED");

  const hardSignals: SessionOpsFailureSignal[] = [
    "PARTIAL_EVENT_ANALYSIS",
    "DROPPED_EVENTS",
    "BACKLOG_NOT_DRAINED",
  ];
  const verdict: SessionOpsVerdict = failureSignals.some((signal) => hardSignals.includes(signal))
    ? "failed"
    : failureSignals.length > 0
      ? "degraded"
      : "healthy";

  return {
    version: SESSION_OPS_HEALTH_VERSION,
    sessionId: session.sessionId,
    eventsDetected: session.events.length,
    eventsByState,
    clipsExtractionAttempted: events.filter((event) => event.extractionAttempted).length,
    eventsAnalyzed: analyzedEvents.length,
    eventsReady: eventsByState.ready,
    eventsAbstained: eventsByState.abstained,
    eventsUnanalyzedTracked: events.filter((event) => !event.analyzed && !event.droppedBeforeQueue)
      .length,
    eventsDroppedBeforeQueue: droppedBeforeQueue,
    droppedLateSamples: session.qualityState.droppedLateSamples,
    backlog: {
      queueDepth: metrics.queueDepth,
      inFlight: metrics.inFlight,
      maxQueueDepth: metrics.maxQueueDepth,
      maxInFlight: metrics.maxInFlight,
      suspended: metrics.suspended,
    },
    latency,
    sessionComplete,
    events,
    failureSignals,
    verdict,
  };
}

/** Coverage-gated session summary: generated ONLY from a complete report
 * (every detected event analyzed, backlog drained, no hard signals). A
 * partial session gets an explicit refusal with the reason — never a summary
 * silently computed over the analyzed subset. */
export function generateSessionOpsSummary(report: SessionOpsHealthReport): SessionOpsSummary {
  if (report.eventsDetected === 0) {
    return {
      status: "refused",
      sessionId: report.sessionId,
      reason: "NO_EVENTS_DETECTED: nothing to summarize",
    };
  }
  if (report.verdict === "failed" || !report.sessionComplete) {
    const shortfall = report.eventsDetected - report.eventsAnalyzed;
    return {
      status: "refused",
      sessionId: report.sessionId,
      reason: `INCOMPLETE_COVERAGE: ${report.eventsAnalyzed}/${report.eventsDetected} events analyzed (${shortfall} missing); signals: ${report.failureSignals.join(", ") || "none"}`,
    };
  }
  return {
    status: "generated",
    sessionId: report.sessionId,
    eventsDetected: report.eventsDetected,
    eventsReady: report.eventsReady,
    eventsAbstained: report.eventsAbstained,
    meanTotalLatencyMs: report.latency.meanTotalLatencyMs,
    maxTotalLatencyMs: report.latency.maxTotalLatencyMs,
  };
}
