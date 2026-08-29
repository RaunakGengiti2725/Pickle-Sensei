import {
  SESSION_COMPLETION,
  SESSION_ENGINE_VERSION,
  SessionEventEngine,
  type Session,
  type SessionEventCloseReason,
  type SessionEventState,
  type SessionStrokeEvent,
  type StrokeEventProposalV2,
} from '@pickle/analysis-pipeline';
import {
  SELECTABLE_TECHNIQUES_V1,
  type SelectableTechnique,
  type ShotTypeSlug,
} from '@pickle/shared-types';
import type { AnalysisRecord } from '@pickle/swing-domain';
import {
  sessionCaptureAvailable,
  type CapturedClip,
  type PoseSequenceSidecarRef,
} from '../camera/capture';
import { stabilitySlo } from '../analysis/stabilityTelemetry';

/**
 * SESSION FLOW — the mobile state machine around the canonical
 * SessionEventEngine (@pickle/analysis-pipeline, moved from swing-lab in
 * Wave B/W6). One instance per session: target lock → play → E1, E2, E3…,
 * recording never stops. This module owns three things and nothing else:
 *
 *   1. FEEDING — wrist-speed samples in, closed StrokeEvents out. The sample
 *      shape `{ tMs, v }` is exactly the D-029 wrist-motion series shape the
 *      capture instrument already records (CaptureCompletionTelemetryV1.
 *      postCompletionMotion, src/camera/capture.ts) and exactly what
 *      workstream E specified for the future native stream event.
 *   2. PER-EVENT ANALYSIS DISPATCH — a typed seam
 *      (SessionEventAnalysisRequest → SessionEventAnalysisProvider) plus a
 *      clip-extraction seam (SessionEventClipSource) that cuts real clip
 *      video and a pose-sidecar slice from the rolling native recording for
 *      each closed event. Replay mode has no clip source and keeps the
 *      honest pending-stub provider. No fake results, ever.
 *   3. VIEW MAPPING — pure functions that turn the engine's Session into
 *      timeline segments, event cards and count-only technique distribution
 *      (MOBBIN brief §3). Pure so jest can pin them without rendering.
 *
 * ── NATIVE SESSION SURFACE (D-040 gaps, closed in TS + Swift; Swift is
 *    UNVERIFIED-ON-DEVICE until an iOS build runs) ───────────────────────
 *
 * GAP 1 — CONTINUOUS WRIST-SPEED EMITTER (NATIVE_SESSION_MOTION_STREAM_NOT_BUILT):
 * The native session capture mode (SessionCaptureCoordinator.swift) keeps
 * the AVCapture session recording + pose sidecar rolling and emits every
 * wrist-motion sample as a `{ type: 'session_motion_sample', tMs, v }`
 * PickleCameraEvent (SESSION_MOTION_SAMPLE_EVENT_TYPE — the frozen
 * contract). src/flow/sessionNative.ts consumes the stream and feeds
 * LiveSessionFlow.pushSample. Builds whose bridge lacks the session surface
 * still report the gap honestly and run replay mode only.
 *
 * GAP 2 — PER-EVENT CLIP EXTRACTION (NATIVE_CLIP_EXTRACTION_NOT_BUILT):
 * A closed SessionStrokeEvent's exact [startMs, endMs] bounds are cut from
 * the rolling recording (clip video + pose-sidecar slice) through the
 * SessionEventClipSource seam below (native implementation:
 * extractSessionEventClip, src/camera/capture.ts). runCaptureAnalysis
 * (src/analysis/runCaptureAnalysis.ts) consumes the validated CapturedClip;
 * analyzeCapture maps trigger.startMs/endMs/peakMotionMs — which the
 * proposal provides verbatim (startMs/endMs/peakMs) — so the seam carries
 * the proposal untouched. Declared stroke: session play has no per-event
 * declaration; declared-null (AUTO) routing in @pickle/analysis-pipeline
 * (strokeAutoResolution.ts) is the analysis path.
 */

// ─── Motion feed contract ───────────────────────────────────────────────────

/** One wrist-speed sample. Same shape as CaptureCompletionTelemetryV1
 * postCompletionMotion entries and the future native stream payload.
 * `v` is normalized-image units/second — never physical speed. */
export interface SessionMotionSample {
  tMs: number;
  v: number;
}

/** The event `type` the future native emitter must use on the existing
 * 'PickleCameraEvent' NativeEventEmitter channel (capture.ts L349–362). */
export const SESSION_MOTION_SAMPLE_EVENT_TYPE = 'session_motion_sample';

/** TS contract for the future native payload (Gap 1). */
export interface SessionMotionSampleEvent {
  type: typeof SESSION_MOTION_SAMPLE_EVENT_TYPE;
  tMs: number;
  v: number;
  captureId?: string;
  emittedAtIso?: string;
}

export const NATIVE_SESSION_MOTION_STREAM_NOT_BUILT =
  'NATIVE_SESSION_MOTION_STREAM_NOT_BUILT';

export type SessionMotionFeedAvailability =
  | { available: true; mode: 'native' }
  | {
      available: false;
      gap: typeof NATIVE_SESSION_MOTION_STREAM_NOT_BUILT;
      detail: string;
    };

/**
 * Honest capability check for the live feed. Available exactly when the
 * native bridge exposes the full session-capture surface (start/stop +
 * per-event clip extraction) — the same native mode that emits
 * SESSION_MOTION_SAMPLE_EVENT_TYPE. Builds without it (including jest and
 * any partial bridge) stay honestly unavailable and run replay mode only.
 */
export function nativeSessionMotionFeedAvailability(): SessionMotionFeedAvailability {
  if (sessionCaptureAvailable()) {
    return { available: true, mode: 'native' };
  }
  return {
    available: false,
    gap: NATIVE_SESSION_MOTION_STREAM_NOT_BUILT,
    detail:
      'This build has no native continuous capture: the camera pipeline ' +
      'finalizes one clip per stroke and never streams wrist-motion samples ' +
      `('${SESSION_MOTION_SAMPLE_EVENT_TYPE}') to JS. Sessions run in replay mode only.`,
  };
}

// ─── Per-event analysis seam ────────────────────────────────────────────────

export const NATIVE_CLIP_EXTRACTION_NOT_BUILT =
  'NATIVE_CLIP_EXTRACTION_NOT_BUILT';

/**
 * Everything a per-event analysis needs. The proposal maps 1:1 into the
 * trigger envelope the canonical pipeline already consumes
 * (trigger.startMs/endMs/peakMotionMs ← proposal.startMs/endMs/peakMs);
 * `clip`/`poseSequenceSlice` are null when the flow has no clip source
 * (replay mode, or a build without native extraction) — never fabricated.
 */
export interface SessionEventAnalysisRequest {
  sessionId: string;
  eventId: string;
  /** Frozen canonical StrokeEventProposalV2 (bounds are final at close). */
  proposal: StrokeEventProposalV2;
  closeReason: SessionEventCloseReason;
  closedAtMs: number;
  /** Session play has no per-event declaration. Declared-null (AUTO) routing
   * in @pickle/analysis-pipeline (strokeAutoResolution.ts) is the analysis
   * path for per-event inputs. */
  declaredStroke: ShotTypeSlug | null;
  /** Validated per-event clip from the rolling recording, when a clip source
   * is attached; null in replay mode or without native extraction (Gap 2). */
  clip: CapturedClip | null;
  /** The clip's pose sidecar sliced to the extracted window; null exactly
   * when `clip` is null or the window held no measured pose frames. */
  poseSequenceSlice: PoseSequenceSidecarRef | null;
}

// ─── Per-event clip extraction seam (Gap 2 closure) ────────────────────────

export type SessionEventClipExtraction =
  /** A REAL validated clip cut from the rolling recording. */
  | {
      status: 'extracted';
      clip: CapturedClip;
      poseSequenceSlice: PoseSequenceSidecarRef | null;
    }
  /** Extraction could not produce a trustworthy clip; the event stays
   * honestly pending with this reason. Never a fabricated clip. */
  | { status: 'unavailable'; pendingReason: string };

/** Cuts clip video + pose-sidecar slice for one closed event's exact bounds
 * from the rolling session recording. Bounds come from the frozen proposal
 * verbatim; implementations must never alter them. */
export interface SessionEventClipSource {
  readonly sourceId: string;
  extract(event: SessionStrokeEvent): Promise<SessionEventClipExtraction>;
}

export type SessionEventAnalysisOutcome =
  /** A REAL AnalysisRecord from the canonical pipeline. Never fabricated. */
  | { status: 'ready'; analysis: AnalysisRecord }
  | { status: 'abstained'; abstainReason: string }
  /** Analysis could not start; the event stays honestly pending. */
  | { status: 'pending'; pendingReason: string };

export interface SessionEventAnalysisProvider {
  readonly providerId: string;
  /** Build-level capability. 'unavailable' short-circuits dispatch so the UI
   * never shows a fake "processing" moment for work that cannot start. */
  availability():
    { status: 'available' } | { status: 'unavailable'; pendingReason: string };
  analyzeEvent(
    request: SessionEventAnalysisRequest,
  ): Promise<SessionEventAnalysisOutcome>;
}

/** Replay-mode provider: honest about having no per-event inputs. Every
 * closed event keeps state 'pending' with reason
 * NATIVE_CLIP_EXTRACTION_NOT_BUILT. Live native sessions use
 * createNativeSessionAnalysisProvider (src/flow/sessionNative.ts). */
export function createPendingStubAnalysisProvider(): SessionEventAnalysisProvider {
  return {
    providerId:
      'session-analysis-stub-1 (per-event clip extraction not built natively)',
    availability() {
      return {
        status: 'unavailable',
        pendingReason: NATIVE_CLIP_EXTRACTION_NOT_BUILT,
      };
    },
    async analyzeEvent() {
      return {
        status: 'pending',
        pendingReason: NATIVE_CLIP_EXTRACTION_NOT_BUILT,
      };
    },
  };
}

// ─── View models (pure mapping — jest-pinned) ───────────────────────────────

export type TechniqueFamily = SelectableTechnique['family'];

/** Family for a shot slug via the shared technique registry (first match —
 * families are for count-only chips, never for scoring). */
export function strokeFamilyForShotType(
  shotType: ShotTypeSlug,
): TechniqueFamily | null {
  const technique = SELECTABLE_TECHNIQUES_V1.find(
    entry => entry.legacySlug === shotType,
  );
  return technique?.family ?? null;
}

/** Family ONLY from a completed analysis' stroke resolution. Everything else
 * is honestly unclassified — never inferred from motion. */
export function eventTechniqueFamily(event: {
  state: SessionEventState;
  analysis: AnalysisRecord | null;
}): TechniqueFamily | null {
  if (event.state !== 'ready' || !event.analysis) return null;
  const resolution = event.analysis.strokeResolution;
  if (resolution.kind === 'unresolved') return null;
  return strokeFamilyForShotType(resolution.shotType);
}

/**
 * Honest per-event view state. A recorded pending reason means analysis never
 * actually produced a result for this event — the card must say "pending"
 * even if a dispatch was optimistically marked processing before the
 * provider reported it could not start.
 */
export function resolveEventViewState(
  state: SessionEventState,
  pendingReason: string | null,
  analysis: AnalysisRecord | null,
): SessionEventState {
  if (state === 'ready' || state === 'abstained') return state;
  if (pendingReason !== null && analysis === null) return 'pending';
  return state;
}

export interface SessionEventView {
  eventId: string;
  /** 0-based emission index (E1 → 0). Append-only, never reordered. */
  index: number;
  startMs: number;
  endMs: number;
  peakMs: number;
  durationMs: number;
  peakSpeed: number;
  paddleConfirmed: boolean;
  closeReason: SessionEventCloseReason;
  closedAtMs: number;
  state: SessionEventState;
  pendingReason: string | null;
  abstainReason: string | null;
  analysis: AnalysisRecord | null;
  /** Count-only chip family; null = honestly unclassified. */
  family: TechniqueFamily | null;
  /** flush-closed = user stopped mid-motion; bounds are best-available. */
  boundaryUncertain: boolean;
  /** Engine flagged SESSION_EVENT_RETRO_SUPPRESSED for this event (weak
   * relative to the session's later strokes; kept append-only). */
  retroSuppressed: boolean;
}

export function buildEventViews(
  session: Session,
  pendingReasons: ReadonlyMap<string, string>,
): SessionEventView[] {
  return session.events.map((event, index) => {
    const pendingReason = pendingReasons.get(event.eventId) ?? null;
    return {
      eventId: event.eventId,
      index,
      startMs: event.proposal.startMs,
      endMs: event.proposal.endMs,
      peakMs: event.proposal.peakMs,
      durationMs: event.proposal.endMs - event.proposal.startMs,
      peakSpeed: event.proposal.peakSpeed,
      paddleConfirmed: event.proposal.paddleConfirmed,
      closeReason: event.closeReason,
      closedAtMs: event.closedAtMs,
      state: resolveEventViewState(event.state, pendingReason, event.analysis),
      pendingReason,
      abstainReason: event.abstainReason,
      analysis: event.analysis,
      family: eventTechniqueFamily(event),
      boundaryUncertain: event.closeReason === 'flush',
      retroSuppressed: session.qualityState.notes.some(
        note =>
          note.includes('SESSION_EVENT_RETRO_SUPPRESSED') &&
          note.includes(`: ${event.eventId} `),
      ),
    };
  });
}

export interface TimelineSegment {
  eventId: string;
  /** Fractions of the session time axis, clamped to [0, 1]. */
  startFraction: number;
  endFraction: number;
  family: TechniqueFamily | null;
  state: SessionEventState;
}

/** Horizontal event-timeline strip mapping (MOBBIN brief §3.2): segments on
 * the session time axis, colored by stroke family when one is KNOWN. */
export function timelineSegments(
  events: readonly SessionEventView[],
  sessionDurationMs: number,
): TimelineSegment[] {
  if (!(sessionDurationMs > 0)) return [];
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return events.map(event => ({
    eventId: event.eventId,
    startFraction: clamp(event.startMs / sessionDurationMs),
    endFraction: clamp(event.endMs / sessionDurationMs),
    family: event.family,
    state: event.state,
  }));
}

export interface TechniqueDistributionChip {
  /** Display label — a technique family or the honest 'unclassified'. */
  label: string;
  family: TechniqueFamily | null;
  count: number;
}

/** COUNT-ONLY distribution (MOBBIN brief §3.1) — no universal form score,
 * no ranking. Unclassified events are counted, not hidden. */
export function techniqueDistribution(
  events: readonly SessionEventView[],
): TechniqueDistributionChip[] {
  const counts = new Map<string, TechniqueDistributionChip>();
  for (const event of events) {
    const label = event.family ?? 'unclassified';
    const existing = counts.get(label);
    if (existing) existing.count += 1;
    else counts.set(label, { label, family: event.family, count: 1 });
  }
  // Known families first (by count desc), unclassified last.
  return [...counts.values()].sort((a, b) => {
    if ((a.family === null) !== (b.family === null))
      return a.family === null ? 1 : -1;
    return b.count - a.count;
  });
}

/** m:ss session clock (duration = last observed sample time). */
export function formatSessionClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Header pill for the active capture mode. Only a replay session may carry
 * the replay banner — a live camera session must never be labeled a replay,
 * and a replay must never pass as live. */
export function captureModePillLabel(
  source: LiveSessionSnapshot['source'],
): string | null {
  return source === 'replay' ? 'REPLAY · DEV RALLY' : null;
}

export const CLOSE_REASON_LABEL: Record<SessionEventCloseReason, string> = {
  settle: 'Closed on settle',
  next_stroke_valley: 'Closed at next-stroke valley',
  safety_max: 'Closed at safety limit',
  next_event_proposed: 'Closed by next stroke',
  flush: 'Closed at session end',
};

// ─── The flow state machine ─────────────────────────────────────────────────

export type SessionFlowPhase = 'running' | 'ended';

export interface LiveSessionSnapshot {
  sessionId: string;
  phase: SessionFlowPhase;
  source: 'live' | 'replay';
  startedAtIso: string | null;
  /** Last observed sample time — the session time axis. */
  durationMs: number;
  strokeCount: number;
  events: SessionEventView[];
  distribution: TechniqueDistributionChip[];
  qualityNotes: string[];
  droppedLateSamples: number;
  /** onUpdate callbacks that threw — isolated and counted, never allowed to
   * corrupt event states or kill the motion feed. */
  onUpdateFailures: number;
  engineVersion: string;
  analysisProviderId: string;
}

export interface LiveSessionFlowOptions {
  sessionId: string;
  source: 'live' | 'replay';
  provider: SessionEventAnalysisProvider;
  /** Per-event clip extraction (Gap 2). Absent in replay mode: requests then
   * carry clip: null and the provider decides honestly what that means. */
  clipSource?: SessionEventClipSource;
  startedAtIso?: string;
  fps?: number | null;
  /** Called after every state change (new samples, closures, analysis
   * outcomes) with a fresh snapshot. */
  onUpdate?: (snapshot: LiveSessionSnapshot) => void;
}

export class LiveSessionFlow {
  private readonly engine: SessionEventEngine;
  private readonly pendingReasons = new Map<string, string>();
  private readonly dispatches: Array<Promise<void>> = [];
  private phase: SessionFlowPhase = 'running';
  private lastSampleMs = 0;
  private onUpdateFailures = 0;

  constructor(private readonly options: LiveSessionFlowOptions) {
    this.engine = new SessionEventEngine({
      sessionId: options.sessionId,
      captureMeta: {
        startedAtIso: options.startedAtIso ?? null,
        fps: options.fps ?? null,
        source: options.source,
      },
    });
  }

  /** True once end() has run; late samples (e.g. a queued native emission
   * delivered after stop) must not be pushed. */
  ended(): boolean {
    return this.phase === 'ended';
  }

  /** Feed one wrist-speed sample; returns the events CLOSED by this sample
   * (already dispatched to the analysis seam). */
  pushSample(sample: SessionMotionSample): SessionStrokeEvent[] {
    if (this.phase === 'ended') {
      throw new Error('session already ended — no samples may follow flush()');
    }
    this.lastSampleMs = Math.max(this.lastSampleMs, sample.tMs);
    const closed = this.engine.pushWristSample({
      timestampMs: sample.tMs,
      value: sample.v,
    });
    for (const event of closed) this.dispatchAnalysis(event);
    this.notify();
    return closed;
  }

  /** End of session (user stop). Flushes remaining candidates, dispatches
   * them, freezes the flow and registers the snapshot for LiveSummary. */
  end(): LiveSessionSnapshot {
    if (this.phase === 'running') {
      const closed = this.engine.flush();
      this.phase = 'ended';
      for (const event of closed) this.dispatchAnalysis(event);
      const snapshot = this.snapshot();
      completedSessions.set(this.options.sessionId, snapshot);
      this.notify();
      return snapshot;
    }
    return this.snapshot();
  }

  /** Resolves when every in-flight analysis dispatch has settled. */
  async settled(): Promise<void> {
    await Promise.all([...this.dispatches]);
  }

  snapshot(): LiveSessionSnapshot {
    const session = this.engine.snapshot();
    const events = buildEventViews(session, this.pendingReasons);
    return {
      sessionId: session.sessionId,
      phase: this.phase,
      source: this.options.source,
      startedAtIso: session.captureMeta.startedAtIso,
      durationMs: this.lastSampleMs,
      strokeCount: events.length,
      events,
      distribution: techniqueDistribution(events),
      qualityNotes: session.qualityState.notes,
      droppedLateSamples: session.qualityState.droppedLateSamples,
      onUpdateFailures: this.onUpdateFailures,
      engineVersion: SESSION_ENGINE_VERSION,
      analysisProviderId: this.options.provider.providerId,
    };
  }

  private dispatchAnalysis(event: SessionStrokeEvent): void {
    const availability = this.options.provider.availability();
    if (availability.status === 'unavailable') {
      // Honest short-circuit: no fake 'processing' for work that cannot start.
      this.pendingReasons.set(event.eventId, availability.pendingReason);
      return;
    }
    this.engine.markEvent(event.eventId, 'processing');
    const run = this.extractClip(event)
      .then(extraction => {
        if (extraction.status === 'unavailable') {
          // Could not produce per-event inputs — honest 'pending', no
          // analysis. The ENGINE state reverts too: nothing is processing.
          this.pendingReasons.set(event.eventId, extraction.pendingReason);
          this.engine.markEvent(event.eventId, 'pending');
          this.notify();
          return null;
        }
        const request: SessionEventAnalysisRequest = {
          sessionId: this.options.sessionId,
          eventId: event.eventId,
          proposal: event.proposal,
          closeReason: event.closeReason,
          closedAtMs: event.closedAtMs,
          declaredStroke: null,
          clip: extraction.clip,
          poseSequenceSlice: extraction.poseSequenceSlice,
        };
        return this.options.provider.analyzeEvent(request);
      })
      .then(outcome => {
        if (outcome === null) return;
        if (outcome.status === 'ready') {
          this.engine.markEvent(event.eventId, 'ready', {
            analysis: outcome.analysis,
          });
        } else if (outcome.status === 'abstained') {
          this.engine.markEvent(event.eventId, 'abstained', {
            abstainReason: outcome.abstainReason,
          });
        } else {
          // Could not start after all — honest revert to 'pending' (engine
          // state included), never a fake terminal outcome.
          this.pendingReasons.set(event.eventId, outcome.pendingReason);
          this.engine.markEvent(event.eventId, 'pending');
        }
        this.notify();
      })
      .catch((error: unknown) => {
        // A terminal state already recorded for this event is append-only:
        // a late dispatch failure (e.g. from a notify subscriber) must never
        // rewrite a real outcome into ANALYSIS_DISPATCH_FAILED.
        const state = this.engine.eventState(event.eventId);
        if (state === 'ready' || state === 'abstained') return;
        const message = error instanceof Error ? error.message : String(error);
        stabilitySlo.record({
          kind: 'session_flow_failed',
          reason: 'analysis_dispatch_failed',
        });
        this.engine.markEvent(event.eventId, 'abstained', {
          abstainReason: `ANALYSIS_DISPATCH_FAILED: ${message}`,
        });
        this.notify();
      });
    this.dispatches.push(run);
  }

  /** Replay mode (no clip source) legitimately has no per-event clip; the
   * request carries nulls exactly as before Gap 2 closed. */
  private async extractClip(event: SessionStrokeEvent): Promise<
    | {
        status: 'extracted';
        clip: CapturedClip | null;
        poseSequenceSlice: PoseSequenceSidecarRef | null;
      }
    | { status: 'unavailable'; pendingReason: string }
  > {
    if (!this.options.clipSource) {
      return { status: 'extracted', clip: null, poseSequenceSlice: null };
    }
    try {
      return await this.options.clipSource.extract(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 'unavailable',
        pendingReason: `SESSION_CLIP_EXTRACTION_FAILED: ${message}`,
      };
    }
  }

  private notify(): void {
    // Analysis outcomes can settle after end(): keep the completed-session
    // registry (what LiveSummary reads) in sync with every state change
    // instead of freezing the summary at whatever was in flight at stop.
    if (this.phase === 'ended') {
      completedSessions.set(this.options.sessionId, this.snapshot());
    }
    if (!this.options.onUpdate) return;
    try {
      this.options.onUpdate(this.snapshot());
    } catch {
      // A throwing UI subscriber must not corrupt event states, break the
      // dispatch chain, or take down the native motion feed. Counted, and
      // surfaced on every snapshot — never silent.
      this.onUpdateFailures += 1;
      stabilitySlo.record({
        kind: 'session_flow_failed',
        reason: 'on_update_subscriber_failed',
      });
    }
  }
}

// ─── Completed-session registry (LiveSummary reads engine output, not DB) ──

const completedSessions = new Map<string, LiveSessionSnapshot>();

export function getCompletedSession(
  sessionId: string,
): LiveSessionSnapshot | null {
  return completedSessions.get(sessionId) ?? null;
}

// ─── Dev replay series (Gap 1 stand-in; provenance-stamped, never "live") ──

/**
 * Recorded wrist-speed series from the dev-split rally run
 * afn-sasebo-rally1 — the same series workstream E replay-validated
 * (5/5 exact-bound event match across both dev rallies). Generated by
 * datasets/experiments/wave-b/W6-fixture-gen.ts via the exact analyzeVideo.ts
 * reconstruction; byte-identical to
 * apps/mobile/__tests__/fixtures/sessionReplay.afn-sasebo-rally1.json.
 * Streaming this through LiveSessionFlow yields E1(settle), E2(valley),
 * E3(flush). Replay is ALWAYS labeled as replay in the UI.
 */
export const DEV_REPLAY_RALLY: {
  runId: string;
  split: 'dev';
  motionUnit: 'normalized_image_units_per_second';
  samples: readonly SessionMotionSample[];
} = {
  runId: 'afn-sasebo-rally1',
  split: 'dev',
  motionUnit: 'normalized_image_units_per_second',
  samples: [
    { tMs: 67, v: 0.06151137875028179 },
    { tMs: 100, v: 0.179539357120003 },
    { tMs: 133, v: 0.17777322880156335 },
    { tMs: 167, v: 0.5897302432747377 },
    { tMs: 200, v: 0.37027880863034746 },
    { tMs: 234, v: 0.20976648581546117 },
    { tMs: 300, v: 0.12351139498818323 },
    { tMs: 334, v: 0.32395898167306564 },
    { tMs: 367, v: 0.062018549776069694 },
    { tMs: 400, v: 2.9154108941445416 },
    { tMs: 467, v: 1.5212468701185486 },
    { tMs: 567, v: 0.2897222973239916 },
    { tMs: 601, v: 0.1496290940939217 },
    { tMs: 634, v: 0.5119973204749789 },
    { tMs: 667, v: 0.5943623581542139 },
    { tMs: 701, v: 1.1878604332189664 },
    { tMs: 767, v: 0.20746822520638739 },
    { tMs: 801, v: 0.33507547925395753 },
    { tMs: 834, v: 0.20644511483056457 },
    { tMs: 868, v: 0.3227756286041532 },
    { tMs: 901, v: 0.18680516965519495 },
    { tMs: 934, v: 0.1857776947314764 },
    { tMs: 968, v: 0.0091028800026311 },
    { tMs: 1001, v: 0.13554900239531195 },
    { tMs: 1034, v: 0.14125493381351337 },
    { tMs: 1068, v: 0.015971010101659366 },
    { tMs: 1101, v: 0.09087399928728865 },
    { tMs: 1134, v: 0.13756799618833365 },
    { tMs: 1168, v: 0.1352307499015452 },
    { tMs: 1201, v: 0.1332593781464103 },
    { tMs: 1235, v: 0.2394331776102494 },
    { tMs: 1268, v: 0.2151334293199351 },
    { tMs: 1301, v: 0.4085256196055336 },
    { tMs: 1335, v: 0.034984190694367395 },
    { tMs: 1368, v: 0.09337604766635324 },
    { tMs: 1401, v: 0.3772581584372343 },
    { tMs: 1435, v: 0.47494944390487026 },
    { tMs: 1468, v: 0.14437751397274393 },
    { tMs: 1502, v: 0.9789480095927733 },
    { tMs: 1602, v: 0.18096829961500835 },
    { tMs: 1702, v: 0.16233804048147943 },
    { tMs: 1768, v: 0.3579104941991294 },
    { tMs: 1802, v: 0.43261176038734117 },
    { tMs: 1835, v: 0.2273633667005058 },
    { tMs: 1869, v: 0.3650739751695123 },
    { tMs: 1902, v: 0.3046615166063337 },
    { tMs: 1935, v: 0.539805828622006 },
    { tMs: 1969, v: 0.1840171150355835 },
    { tMs: 2002, v: 0.49114155480563815 },
    { tMs: 2035, v: 0.42337191405150915 },
    { tMs: 2069, v: 0.36324884031683247 },
    { tMs: 2102, v: 0.26235179989076807 },
    { tMs: 2135, v: 0.45257770927327345 },
    { tMs: 2169, v: 0.12054389696641343 },
    { tMs: 2202, v: 0.20478467145103896 },
    { tMs: 2236, v: 0.12386551478216445 },
    { tMs: 2269, v: 0.10177419562887226 },
    { tMs: 2302, v: 0.2268985675237942 },
    { tMs: 2336, v: 0.10939294712177498 },
    { tMs: 2369, v: 0.10568461887761191 },
    { tMs: 2402, v: 0.17902715913155445 },
    { tMs: 2436, v: 0.07055017153091823 },
    { tMs: 2536, v: 0.21609661687802956 },
    { tMs: 2569, v: 0.19270212996767505 },
    { tMs: 2603, v: 0.1352814862153393 },
    { tMs: 2636, v: 0.16976705464229816 },
    { tMs: 2669, v: 0.04066591377749948 },
    { tMs: 2703, v: 0.11272113502696825 },
    { tMs: 2736, v: 0.3085231667738006 },
    { tMs: 2769, v: 0.4465612355781366 },
    { tMs: 2803, v: 0.6171341739573466 },
    { tMs: 2870, v: 0.7504461376896165 },
    { tMs: 3003, v: 0.5822522893212937 },
    { tMs: 3103, v: 0.3997009756642818 },
    { tMs: 3136, v: 0.0474065368148296 },
    { tMs: 3170, v: 0.1193917523497369 },
    { tMs: 3203, v: 0.18287070257028354 },
    { tMs: 3237, v: 0.13801441018091395 },
    { tMs: 3270, v: 0.058880048972201504 },
    { tMs: 3303, v: 0.46662015726924544 },
    { tMs: 3370, v: 1.289864286283206 },
    { tMs: 3403, v: 1.3942873388012602 },
    { tMs: 3437, v: 0.49241713145067884 },
    { tMs: 3470, v: 0.5127826875498657 },
    { tMs: 3504, v: 0.790891942624639 },
    { tMs: 3537, v: 0.48255589218357964 },
    { tMs: 3570, v: 0.1040353193891363 },
    { tMs: 3604, v: 0.15173426976026846 },
    { tMs: 3637, v: 0.269888649532786 },
    { tMs: 3670, v: 0.14023879102222447 },
    { tMs: 3704, v: 0.06233587244931303 },
    { tMs: 3737, v: 0.27327183933813465 },
    { tMs: 3770, v: 0.13060891155242585 },
    { tMs: 3804, v: 0.06325232631211199 },
    { tMs: 3837, v: 0.13797876504859757 },
    { tMs: 3871, v: 0.1712414482371673 },
  ],
};

/** Safety bound every emission honors (replay-verified): closedAt ≤ endMs +
 * this. Exposed for UI copy/tests. */
export const SESSION_CLOSE_SAFETY_MS = SESSION_COMPLETION.safetyMaxMs;
