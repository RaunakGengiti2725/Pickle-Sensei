import type { PaddleFrame, PoseFrame, Result } from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import type {
  IPaddleDetector,
  IPoseProvider,
  IStrokeDetector,
  StrokeEvent,
  VideoClipRef,
} from "@pickle/vision-contracts";

/**
 * Recorded-data providers. The capture pipeline already runs real on-device
 * pose inference while filming; these providers replay that measured record
 * into the analysis pipeline instead of re-running (or worse, inventing)
 * inference. Nothing here fabricates a frame, a window, or a confidence.
 */

/** Replays pose frames measured at capture time by the native camera engine. */
export class RecordedPoseProvider implements IPoseProvider {
  public readonly source = "real" as const;
  public readonly modelVersion: string;

  private readonly frames: readonly PoseFrame[];

  public constructor(options: { frames: readonly PoseFrame[]; poseModelVersion: string }) {
    this.modelVersion = options.poseModelVersion;
    // A non-finite timestamp cannot be placed on the timeline; it must go
    // before sorting because `a - b` is not a total order once NaN is present.
    this.frames = options.frames
      .filter((frame) => Number.isFinite(frame.timestampMs))
      .sort((a, b) => a.timestampMs - b.timestampMs);
  }

  public async extractPose(
    _clip: VideoClipRef,
    window: { startMs: number; endMs: number },
  ): Promise<Result<PoseFrame[]>> {
    const inWindow = this.frames.filter(
      (frame) => frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs,
    );
    if (inWindow.length < 6) {
      return fail(
        failure(
          "low_confidence",
          "pose.too_few_recorded_frames",
          `Only ${inWindow.length} recorded pose frames overlap the stroke window; at least 6 are required.`,
        ),
      );
    }
    return ok(inWindow);
  }
}

/**
 * The stroke window measured by the native temporal trigger during capture.
 * It is a real detection made at record time; this simply replays it.
 */
export class RecordedTriggerStrokeDetector implements IStrokeDetector {
  public readonly source = "real" as const;
  public readonly modelVersion: string;

  private readonly event: StrokeEvent;

  public constructor(options: {
    triggerModelVersion: string;
    startMs: number;
    endMs: number;
    peakMotionMs: number | null;
    confidence: number;
  }) {
    this.modelVersion = options.triggerModelVersion;
    this.event = {
      startMs: options.startMs,
      endMs: options.endMs,
      contactMs: options.peakMotionMs,
      shotTypeHypothesis: null,
      confidence: options.confidence,
    };
  }

  public async detectStrokes(_clip: VideoClipRef): Promise<Result<StrokeEvent[]>> {
    if (this.event.endMs <= this.event.startMs) {
      return fail(
        failure(
          "low_confidence",
          "stroke.invalid_recorded_window",
          "The recorded trigger window is empty or inverted.",
        ),
      );
    }
    return ok([this.event]);
  }
}

/**
 * Honest absence of paddle detection: returns zero paddle frames so
 * paddle-dependent metrics stay unobserved instead of being invented.
 */
export class AbsentPaddleDetector implements IPaddleDetector {
  public readonly source = "real" as const;
  public readonly modelVersion = "paddle-none-0";

  public async detectPaddle(
    _clip: VideoClipRef,
    _window: { startMs: number; endMs: number },
  ): Promise<Result<PaddleFrame[]>> {
    return ok([]);
  }
}
