/**
 * SESSION MULTI-EVENT ENGINE — thin re-export shim (Wave B / W6).
 *
 * The engine moved VERBATIM to packages/analysis-pipeline/src/sessionEngine.ts
 * so the mobile app can consume it: mobile cannot import @pickle/swing-lab
 * (node-only tooling — fs/child_process CLIs), while @pickle/analysis-pipeline
 * is already consumed from TypeScript source by metro/jest/tsc. swing-lab
 * depends on analysis-pipeline (see package.json), so this shim keeps every
 * existing swing-lab import path — including workstream E's tests and replay
 * validation in test/sessionEngine.test.ts — working unchanged.
 *
 * The engine still composes the CANONICAL stroke-event-2 proposer semantics:
 * analysis-pipeline cannot depend back on swing-lab, so it carries a verbatim
 * mirror of src/strokeEvents.ts, drift-guarded two ways —
 *   (a) packages/analysis-pipeline/test/sessionEngine.test.ts byte-compares
 *       the mirror against src/strokeEvents.ts;
 *   (b) this package's replay suite streams real rallies through the moved
 *       engine and asserts exact-bound equality against src/strokeEvents.ts
 *       batch proposals.
 */
export {
  BOUND_STABILITY_MS,
  SESSION_COMPLETION,
  SESSION_ENGINE_VERSION,
  SessionEventEngine,
  type Session,
  type SessionCaptureMeta,
  type SessionEventCloseReason,
  type SessionEventState,
  type SessionQualityState,
  type SessionStrokeEvent,
  type SessionTargetRef,
  type SpeedSample,
} from "@pickle/analysis-pipeline";
