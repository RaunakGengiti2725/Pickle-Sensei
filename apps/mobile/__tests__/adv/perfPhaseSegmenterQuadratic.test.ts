/**
 * ADVERSARY (performance-bounds): the geometric phase segmenter against a
 * stroke window that spans a whole imported clip.
 *
 * Imported clips are analysed with the full-clip trigger window
 * (runCaptureAnalysis.ts `trigger.imported-full-clip`: startMs 0 → endMs
 * clip.durationMs), so every frame of a 60 s @ 60 fps import lands inside
 * `GeometricPhaseSegmenter.segmentPhases`' window. The segmenter is the one
 * provider stage whose cost is not linear in the frame count (the
 * end-to-end sibling attack in perfImportedSidecarPipeline.test.ts measures
 * ≈15x wall time for 4x the frames). Isolated here: wall time at 15 s, 30 s
 * and the 60 s import cap, and the growth exponent between them — linear
 * work doubles when the input doubles; quadratic work quadruples.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import type { PoseFrame } from '@pickle/shared-types';
import { toLegacyPoseFrames } from '@pickle/swing-domain';
import { GeometricPhaseSegmenter } from '@pickle/vision-geometry';

/** log2(cost ratio) per doubling of the input; 1 = linear, 2 = quadratic. */
const MAX_GROWTH_EXPONENT = 1.5;
/** Segmenting the largest supported import must stay well inside one
 * second in V8 — Hermes on an entry-level iPhone is several times slower and
 * this runs on the JS thread of the analysis. */
const CAP_BUDGET_MS = 1_000;

function importedFrames(seconds: number): {
  frames: PoseFrame[];
  durationMs: number;
  fps: number;
  width: number;
  height: number;
} {
  const swingMs = 1_200;
  const padMs = Math.max(0, (seconds * 1000 - swingMs) / 2);
  const { sequence, window } = generateSwingSequence({
    fps: 60,
    readyMs: padMs,
    recoverMs: padMs,
  });
  return {
    // The same conversion analyzeCapture.ts applies before segmentation.
    frames: toLegacyPoseFrames(sequence),
    durationMs: window.endMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
  };
}

async function segmentTimed(seconds: number): Promise<{
  frames: number;
  ms: number;
  ok: boolean;
}> {
  const input = importedFrames(seconds);
  const segmenter = new GeometricPhaseSegmenter({
    aspectRatio: input.width / input.height,
  });
  const start = performance.now();
  const result = await segmenter.segmentPhases(
    input.frames,
    [],
    // The StrokeEvent analyzeCapture.ts builds from the imported full-clip
    // trigger (startMs 0, endMs clip.durationMs, peakMotionMs null).
    {
      startMs: 0,
      endMs: input.durationMs,
      contactMs: null,
      shotTypeHypothesis: null,
      confidence: 1,
    },
    { width: input.width, height: input.height },
  );
  return {
    frames: input.frames.length,
    ms: performance.now() - start,
    ok: result.ok,
  };
}

describe('ADV perf: GeometricPhaseSegmenter over a full-clip import window', () => {
  it('scales close to linearly from 15 s to the 60 s import cap and segments the cap inside the budget', async () => {
    const small = await segmentTimed(15);
    const medium = await segmentTimed(30);
    const large = await segmentTimed(60);
    const exponent = (from: { frames: number; ms: number }, to: typeof from) =>
      Math.log2(to.ms / Math.max(from.ms, 1)) /
      Math.log2(to.frames / from.frames);
    const smallToMedium = exponent(small, medium);
    const mediumToLarge = exponent(medium, large);
    console.warn(
      `[adv] segmentPhases: 15s ${small.frames} frames ${small.ms.toFixed(0)} ms; ` +
        `30s ${medium.frames} frames ${medium.ms.toFixed(0)} ms; ` +
        `60s ${large.frames} frames ${large.ms.toFixed(0)} ms; ` +
        `growth exponent ${smallToMedium.toFixed(2)} (15→30 s), ${mediumToLarge.toFixed(2)} (30→60 s)`,
    );
    expect(small.ok && medium.ok && large.ok).toBe(true);
    expect(large.ms).toBeLessThan(CAP_BUDGET_MS);
    expect(smallToMedium).toBeLessThan(MAX_GROWTH_EXPONENT);
    expect(mediumToLarge).toBeLessThan(MAX_GROWTH_EXPONENT);
  });
});
