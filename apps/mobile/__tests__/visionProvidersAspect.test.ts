import type { PoseSequence } from '@pickle/swing-domain';
import { toLegacyPoseFrames } from '@pickle/swing-domain';
import type { PhaseSpan } from '@pickle/shared-types';
import { GeometricPhaseSegmenter } from '@pickle/vision-geometry';
import { generateSwingSequence } from '@pickle/evaluation';
import { createFusionProviders } from '../src/vision/providers';

/**
 * Every provider in one fusion set must measure the SAME capture with the
 * SAME aspect ratio — the one derived from the recorded pose video
 * (`pose.video.width / pose.video.height`), exactly as
 * GeometryBiomechanicsExtractor derives it. iPhone guided captures are
 * portrait, so a segmenter hard-wired to a square aspect scales the wrist
 * path differently from the extractor and moves phase boundaries.
 */

const PORTRAIT = { width: 1080, height: 1920 } as const;

/**
 * Embeds the square synthetic swing (1080×1080) into a portrait frame of the
 * same pixel width: x stays put, y is re-normalized over the taller frame.
 * Pixel geometry is unchanged, so the true-aspect segmentation of this
 * sequence must reproduce the square sequence's phases.
 */
function portraitSwing(): {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number; peakMs: number };
} {
  const { sequence, window } = generateSwingSequence();
  const squareSide = sequence.video.width;
  const bandOffsetPx = (PORTRAIT.height - squareSide) / 2;
  return {
    window,
    sequence: {
      ...sequence,
      video: { ...PORTRAIT, fps: sequence.video.fps },
      frames: sequence.frames.map(frame => ({
        ...frame,
        landmarks: frame.landmarks.map(mark => ({
          ...mark,
          y: (bandOffsetPx + mark.y * squareSide) / PORTRAIT.height,
        })),
      })),
    },
  };
}

function maxBoundaryShiftMs(a: PhaseSpan[], b: PhaseSpan[]): number {
  expect(a.map(s => s.key)).toEqual(b.map(s => s.key));
  return Math.max(
    ...a.map((span, index) => {
      const other = b[index]!;
      return Math.max(
        Math.abs(span.startMs - other.startMs),
        Math.abs(span.endMs - other.endMs),
        Math.abs(span.representativeMs - other.representativeMs),
      );
    }),
  );
}

async function segment(
  segmenter: { segmentPhases: GeometricPhaseSegmenter['segmentPhases'] },
  swing: ReturnType<typeof portraitSwing>,
): Promise<PhaseSpan[]> {
  const result = await segmenter.segmentPhases(
    toLegacyPoseFrames(swing.sequence),
    [],
    {
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      contactMs: swing.window.peakMs,
      shotTypeHypothesis: null,
      confidence: 0.9,
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.code);
  return result.value;
}

function realProviders(swing: ReturnType<typeof portraitSwing>) {
  const fusion = createFusionProviders('forehand_drive', swing.sequence.video);
  expect(fusion.kind).toBe('real');
  if (fusion.kind !== 'real') throw new Error(fusion.reason);
  return fusion.providers;
}

describe('fusion provider set aspect ratio', () => {
  it('configures the phase segmenter with the recorded video aspect (portrait)', () => {
    const swing = portraitSwing();
    const { phase } = realProviders(swing);
    const trueAspect = swing.sequence.video.width / swing.sequence.video.height;
    expect(trueAspect).toBeCloseTo(0.5625, 10);
    expect(phase).toStrictEqual(
      new GeometricPhaseSegmenter({ aspectRatio: trueAspect }),
    );
    expect(phase).not.toStrictEqual(
      new GeometricPhaseSegmenter({ aspectRatio: 1 }),
    );
  });

  it('segments a portrait sequence identically to a true-aspect segmenter (0 ms shift)', async () => {
    const swing = portraitSwing();
    const { phase } = realProviders(swing);
    const trueAspect = swing.sequence.video.width / swing.sequence.video.height;

    const fromProviders = await segment(phase, swing);
    const fromTrueAspect = await segment(
      new GeometricPhaseSegmenter({ aspectRatio: trueAspect }),
      swing,
    );
    const fromSquareAspect = await segment(
      new GeometricPhaseSegmenter({ aspectRatio: 1 }),
      swing,
    );

    // The fixture must actually discriminate: a square-aspect segmenter
    // reads this portrait swing differently from the true aspect.
    expect(
      maxBoundaryShiftMs(fromSquareAspect, fromTrueAspect),
    ).toBeGreaterThan(0);
    expect(maxBoundaryShiftMs(fromProviders, fromTrueAspect)).toBe(0);
    expect(fromProviders).toEqual(fromTrueAspect);
  });

  it('keeps the segmenter square for a square capture', () => {
    const { sequence } = generateSwingSequence();
    const { phase } = realProviders({
      sequence,
      window: { startMs: 0, endMs: 0, peakMs: 0 },
    });
    expect(phase).toStrictEqual(
      new GeometricPhaseSegmenter({ aspectRatio: 1 }),
    );
  });
});
