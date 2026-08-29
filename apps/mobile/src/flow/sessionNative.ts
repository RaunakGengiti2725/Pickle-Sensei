import { SESSION_ENGINE_VERSION } from '@pickle/analysis-pipeline';
import {
  extractSessionEventClip,
  subscribeToCameraEvents,
  type CapturedClip,
} from '../camera/capture';
import type { ApiConfigState } from '../data/api';
import type { LocalDb } from '../data/db';
import { sessionEventClipEnvelope } from '../camera/captureEnvelope';
import { savePendingCapture } from '../data/repository';
import { runCaptureAnalysis } from '../analysis/runCaptureAnalysis';
import { makeUuid } from '../util/uuid';
import {
  NATIVE_CLIP_EXTRACTION_NOT_BUILT,
  SESSION_MOTION_SAMPLE_EVENT_TYPE,
  type LiveSessionFlow,
  type SessionEventAnalysisOutcome,
  type SessionEventAnalysisProvider,
  type SessionEventAnalysisRequest,
  type SessionEventClipExtraction,
  type SessionEventClipSource,
  type SessionMotionSampleEvent,
} from './session';

/**
 * NATIVE SESSION PLUMBING (D-040 Gap 1 + Gap 2 closure, TS side).
 *
 * Three seams, all built on validated contracts:
 *   1. Motion stream — every native `session_motion_sample` PickleCameraEvent
 *      (frozen `{ tMs, v }` shape) is runtime-validated and pushed into
 *      LiveSessionFlow.pushSample, the exact entry point replay mode uses.
 *   2. Clip source — a SessionEventClipSource that asks the native rolling
 *      recording for one closed event's exact bounds and returns the same
 *      validated CapturedClip contract guided capture produces.
 *   3. Analysis provider — dispatches each per-event clip through the
 *      canonical runCaptureAnalysis path with declared-null (AUTO) routing.
 *      Real records only; abstentions and failures stay honest.
 */

/** Runtime validation for the frozen native motion-sample payload. Anything
 * that does not match the contract is dropped and counted, never coerced. */
export function isSessionMotionSampleEvent(
  value: unknown,
): value is SessionMotionSampleEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === SESSION_MOTION_SAMPLE_EVENT_TYPE &&
    typeof record.tMs === 'number' &&
    Number.isFinite(record.tMs) &&
    record.tMs >= 0 &&
    typeof record.v === 'number' &&
    Number.isFinite(record.v) &&
    record.v >= 0 &&
    (record.captureId === undefined || typeof record.captureId === 'string') &&
    (record.emittedAtIso === undefined ||
      typeof record.emittedAtIso === 'string')
  );
}

export interface SessionMotionFeedConnection {
  disconnect: () => void;
  /** Malformed `session_motion_sample` payloads dropped so far. */
  droppedInvalidSamples: () => number;
}

/**
 * Subscribes the flow to the native continuous wrist-motion stream (Gap 1).
 * Samples arrive on the existing 'PickleCameraEvent' channel; only validated
 * `session_motion_sample` events reach the engine. When `sessionCaptureId`
 * is given, samples stamped with a DIFFERENT captureId are ignored (stale
 * emissions from a previous session capture can never leak in).
 */
export function connectNativeSessionMotionFeed(
  flow: LiveSessionFlow,
  options?: { sessionCaptureId?: string },
): SessionMotionFeedConnection {
  let connected = true;
  let droppedInvalid = 0;
  const unsubscribe = subscribeToCameraEvents(event => {
    if (!connected) return;
    const raw: unknown = event;
    if (
      typeof raw === 'object' &&
      raw !== null &&
      (raw as { type?: unknown }).type === SESSION_MOTION_SAMPLE_EVENT_TYPE &&
      !isSessionMotionSampleEvent(raw)
    ) {
      droppedInvalid += 1;
      return;
    }
    if (!isSessionMotionSampleEvent(raw)) return;
    if (
      options?.sessionCaptureId !== undefined &&
      raw.captureId !== undefined &&
      raw.captureId !== options.sessionCaptureId
    ) {
      return;
    }
    if (flow.ended()) {
      // Queued native emissions delivered after stop: expected, disconnect.
      connected = false;
      unsubscribe();
      return;
    }
    try {
      flow.pushSample({ tMs: raw.tMs, v: raw.v });
    } catch {
      // A push failure on a still-running flow is unexpected; drop the
      // sample and count it rather than silently killing the whole feed.
      droppedInvalid += 1;
    }
  });
  return {
    disconnect: () => {
      connected = false;
      unsubscribe();
    },
    droppedInvalidSamples: () => droppedInvalid,
  };
}

/**
 * SessionEventClipSource backed by the native rolling recording (Gap 2).
 * Bounds are the frozen proposal's startMs/endMs/peakMs verbatim. A clip
 * without a pose sidecar cannot be analyzed and is reported as unavailable —
 * the event stays honestly pending, nothing is fabricated.
 */
export function createNativeSessionEventClipSource(
  sessionCaptureId: string,
): SessionEventClipSource {
  return {
    sourceId: `session-clip-native-1:${sessionCaptureId}`,
    async extract(event): Promise<SessionEventClipExtraction> {
      let clip: CapturedClip;
      try {
        clip = await extractSessionEventClip(sessionCaptureId, {
          startMs: event.proposal.startMs,
          endMs: event.proposal.endMs,
          peakMs: event.proposal.peakMs ?? null,
          confidence: event.proposal.confidence,
          detectionModelVersion: SESSION_ENGINE_VERSION,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: 'unavailable',
          pendingReason: `SESSION_CLIP_EXTRACTION_FAILED: ${message}`,
        };
      }
      if (clip.captureMode !== 'automatic_pose_trigger') {
        return {
          status: 'unavailable',
          pendingReason:
            'SESSION_CLIP_EXTRACTION_FAILED: unexpected capture mode',
        };
      }
      if (!clip.poseSequence) {
        return {
          status: 'unavailable',
          pendingReason:
            'SESSION_CLIP_POSE_SLICE_EMPTY: the extracted window held no measured pose frames',
        };
      }
      return {
        status: 'extracted',
        clip,
        poseSequenceSlice: clip.poseSequence,
      };
    },
  };
}

export interface NativeSessionAnalysisDeps {
  db: LocalDb;
  apiConfig: ApiConfigState;
  appVersion: string;
  handedness: 'right' | 'left' | 'ambidextrous';
  cameraView?: 'side' | 'rear_oblique';
}

/**
 * Per-event analysis provider for live native sessions. Each request carries
 * a validated per-event clip; the clip is durably saved as a pending capture
 * and dispatched through the canonical runCaptureAnalysis path with
 * declared-null (AUTO) routing — session play never invents a declaration.
 */
export function createNativeSessionAnalysisProvider(
  deps: NativeSessionAnalysisDeps,
): SessionEventAnalysisProvider {
  return {
    providerId:
      'session-analysis-native-1 (per-event clips via rolling recording)',
    availability() {
      return { status: 'available' };
    },
    async analyzeEvent(
      request: SessionEventAnalysisRequest,
    ): Promise<SessionEventAnalysisOutcome> {
      const { clip } = request;
      if (clip === null) {
        // A request without per-event inputs cannot be analyzed honestly.
        return {
          status: 'pending',
          pendingReason: NATIVE_CLIP_EXTRACTION_NOT_BUILT,
        };
      }
      const captureId = makeUuid();
      const shotType =
        clip.recognition.status === 'recognized'
          ? clip.recognition.shotType
          : 'unrecognized';
      await savePendingCapture(deps.db, captureId, shotType, clip, null);
      const outcome = await runCaptureAnalysis({
        db: deps.db,
        captureId,
        clip,
        declaredStroke: null,
        declaredCanonical: null,
        handedness: deps.handedness,
        cameraView: deps.cameraView ?? 'side',
        apiConfig: deps.apiConfig,
        appVersion: deps.appVersion,
        sessionId: request.sessionId,
        captureEnvelope: sessionEventClipEnvelope(clip),
      });
      if (
        outcome.kind === 'unavailable' ||
        outcome.kind === 'quality_blocked'
      ) {
        return { status: 'pending', pendingReason: outcome.reason };
      }
      return { status: 'ready', analysis: outcome.record };
    },
  };
}
