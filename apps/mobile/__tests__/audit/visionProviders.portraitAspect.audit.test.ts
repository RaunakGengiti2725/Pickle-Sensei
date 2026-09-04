/**
 * AUDIT HARNESS (mobile-analyze-capture execution pass, cloud plane).
 *
 * `createFusionProviders()` (apps/mobile/src/vision/providers.ts) builds the
 * phase segmenter with `aspectRatio: 1`, while the biomechanics extractor in
 * the same fusion set derives the aspect ratio from the recorded
 * `pose.video.width / pose.video.height`. iPhone guided captures are
 * portrait, so the two providers measure the SAME wrist path with different
 * horizontal scaling. This harness measures whether that changes phase
 * segmentation on a portrait-embedded synthetic swing, and pins the
 * provider-composition refusals that the existing suite leaves uncovered.
 *
 * New file only; production code and existing tests are untouched.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import type { PhaseSpan, PoseFrame } from '@pickle/shared-types';
import { toLegacyPoseFrames } from '@pickle/swing-domain';
import type { StrokeEvent } from '@pickle/vision-contracts';
import { GeometricPhaseSegmenter } from '@pickle/vision-geometry';
import {
  createFusionProviders,
  scoringStackStatus,
  selectVisionProviders,
} from '../../src/vision/providers';

const PORTRAIT = { width: 1080, height: 1920 };
const PORTRAIT_ASPECT = PORTRAIT.width / PORTRAIT.height;

/**
 * Embeds a square (1080x1080) synthetic swing inside a portrait 1080x1920
 * frame: x stays, y is compressed by 1080/1920 and centred. Physically this
 * is the same motion filmed by a portrait phone.
 */
function embedPortrait(frames: readonly PoseFrame[]): PoseFrame[] {
  const scale = PORTRAIT.width / PORTRAIT.height;
  const offset = (1 - scale) / 2;
  return frames.map(frame => ({
    ...frame,
    landmarks: frame.landmarks.map(mark => ({
      ...mark,
      y: mark.y * scale + offset,
    })),
  }));
}

function strokeEvent(window: {
  startMs: number;
  endMs: number;
  peakMs: number;
}): StrokeEvent {
  return {
    startMs: window.startMs,
    endMs: window.endMs,
    contactMs: window.peakMs,
    shotTypeHypothesis: null,
    confidence: 0.9,
  };
}

describe('AUDIT vision providers — portrait aspect handling in phase segmentation', () => {
  it('measures whether aspectRatio=1 (mobile) vs the true portrait aspect changes phase spans on a portrait-embedded swing', async () => {
    const { sequence, window } = generateSwingSequence({});
    const portraitFrames = embedPortrait(toLegacyPoseFrames(sequence));
    const stroke = strokeEvent(window);

    const mobileSegmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const trueSegmenter = new GeometricPhaseSegmenter({
      aspectRatio: PORTRAIT_ASPECT,
    });
    const mobile = await mobileSegmenter.segmentPhases(
      portraitFrames,
      [],
      stroke,
    );
    const truth = await trueSegmenter.segmentPhases(portraitFrames, [], stroke);
    expect(mobile.ok).toBe(true);
    expect(truth.ok).toBe(true);
    if (!mobile.ok || !truth.ok) return;

    const summarize = (spans: readonly PhaseSpan[]) =>
      spans.map(span => ({
        key: span.key,
        startMs: span.startMs,
        endMs: span.endMs,
      }));
    // Report the concrete difference (if any) in the assertion message so
    // the log artifact carries the evidence either way.
    const same =
      JSON.stringify(summarize(mobile.value)) ===
      JSON.stringify(summarize(truth.value));
    console.info(
      JSON.stringify(
        {
          audit: 'portrait-aspect-phase-spans',
          identical: same,
          mobileAspect1: summarize(mobile.value),
          trueAspect: summarize(truth.value),
        },
        null,
        2,
      ),
    );
    // Both configurations must at least agree on the phase ORDER; timing
    // differences are what the coordinator needs to judge.
    expect(mobile.value.map(span => span.key)).toEqual(
      truth.value.map(span => span.key),
    );
    const maxBoundaryShiftMs = Math.max(
      ...mobile.value.map((span, index) =>
        Math.max(
          Math.abs(span.startMs - truth.value[index]!.startMs),
          Math.abs(span.endMs - truth.value[index]!.endMs),
        ),
      ),
    );
    console.info(
      `portrait-aspect max phase boundary shift: ${maxBoundaryShiftMs.toFixed(1)} ms (identical=${same})`,
    );
    // CHARACTERIZATION: on this synthetic portrait swing the aspect choice
    // moves phase boundaries (a non-zero shift is the reproduced behaviour).
    expect(maxBoundaryShiftMs).toBeGreaterThan(0);
  });
});

describe('AUDIT vision providers — composition refusals', () => {
  it('scoringStackStatus reports the recorded-sequence requirement and a stack version string', () => {
    const status = scoringStackStatus();
    expect(status.installed).toBe(true);
    expect(status.requirement).toBe('recorded_pose_sequence');
    expect(typeof status.version).toBe('string');
    expect(status.version.length).toBeGreaterThan(0);
  });

  it('CHARACTERIZATION: the production scorer registers supportedStrokes="all", so composition does NOT gate an out-of-registry slug — per-slug refusal is deferred to score time', () => {
    const result = createFusionProviders(
      'made_up_stroke_zzz' as unknown as Parameters<
        typeof createFusionProviders
      >[0],
    );
    // Type-level ShotTypeSlug prevents this in the app; this pins that the
    // runtime "not yet released" branch in providers.ts is unreachable with
    // the current manifest (coverage shows lines 187-205 uncovered).
    expect(result.kind).toBe('real');
  });

  it('AUTO DETECT (declared null) composes when the hierarchical classifier is registered', () => {
    const result = createFusionProviders(null);
    expect(result.kind).toBe('real');
    if (result.kind !== 'real') return;
    expect(result.providers.autoStrokeClassifier).not.toBeNull();
  });

  it('a declared forehand drive composes a full provider set', () => {
    const result = createFusionProviders('forehand_drive');
    expect(result.kind).toBe('real');
  });

  it('selectVisionProviders refuses a missing recording and a recording under six frames (no synthetic fallback)', () => {
    const missing = selectVisionProviders('forehand_drive', null);
    expect(missing.kind).toBe('unavailable');
    const { sequence, window } = generateSwingSequence({});
    const short = selectVisionProviders('forehand_drive', {
      poseFrames: toLegacyPoseFrames(sequence).slice(0, 5),
      poseModelVersion: 'apple-vision-bodypose-1',
      trigger: {
        modelVersion: 'temporal-stroke-heuristic-2',
        startMs: window.startMs,
        endMs: window.endMs,
        peakMotionMs: window.peakMs,
        confidence: 0.9,
      },
      video: { width: sequence.video.width, height: sequence.video.height },
    });
    expect(short.kind).toBe('unavailable');
    if (short.kind !== 'unavailable') return;
    expect(short.reason).toContain('Too few pose frames');
  });
});
