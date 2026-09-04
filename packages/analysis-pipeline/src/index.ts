export * from "./analyzeClip.js";
export * from "./analyzeCapture.js";
export * from "./strokeAutoResolution.js";
export * from "./preAnalysisGate.js";
// Session multi-event engine (moved from swing-lab in Wave B/W6 so mobile can
// consume it). Deliberately explicit — the in-module stroke-event-2 proposer
// mirror stays package-private; swing-lab's strokeEvents.ts remains the
// canonical proposer API for lab consumers. Only the proposal TYPES leak
// (SessionStrokeEvent.proposal is part of the engine's public shape).
export {
  BOUND_STABILITY_MS,
  SESSION_COMPLETION,
  SESSION_ENGINE_VERSION,
  SESSION_PROPOSAL_HORIZON_MS,
  SessionEventEngine,
  type Session,
  type SessionCaptureMeta,
  type SessionEventCloseReason,
  type SessionEventState,
  type SessionQualityState,
  type SessionStrokeEvent,
  type SessionTargetRef,
  type SpeedSample,
  type StrokeEventProposal,
  type StrokeEventProposalV2,
} from "./sessionEngine.js";
// Progressive per-event analysis scheduling over the session engine
// (Wave E / e16): bounded-concurrency FIFO dispatch of closed events while
// recording continues, with honest failure/retry/recovery semantics.
export {
  DEFAULT_SESSION_TASK_TIMEOUT_MS,
  SESSION_SCHEDULER_VERSION,
  SessionAnalysisScheduler,
  type SessionAnalysisExecutor,
  type SessionAnalysisTask,
  type SessionAnalysisTaskOutcome,
  type SessionSchedulerMetrics,
  type SessionSchedulerOptions,
  type SessionTaskRecord,
  type SessionTaskTerminal,
} from "./sessionScheduler.js";
// Session operations health (Wave I / i20): measured per-session ops report
// over the engine snapshot + scheduler metrics, with PARTIAL_EVENT_ANALYSIS
// as a hard production failure signal and a coverage-gated summary.
export {
  SESSION_OPS_HEALTH_VERSION,
  assessSessionOpsHealth,
  generateSessionOpsSummary,
  type SessionEventOpsRecord,
  type SessionLatencyAggregate,
  type SessionOpsFailureSignal,
  type SessionOpsHealthReport,
  type SessionOpsSummary,
  type SessionOpsVerdict,
} from "./sessionOpsHealth.js";
