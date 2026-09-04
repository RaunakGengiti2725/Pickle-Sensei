/**
 * ADVERSARIAL PASS 3 — scenario 2 (mobile-design-components-walkthrough).
 *
 * Attack: phaseTimelinePresentation() fed anchor-free (`event_peak`)
 * boundaries whose contact is NaN, whose motion peak is missing and whose
 * acceleration start lies AFTER the follow-through end. The presenter must
 * answer `kind:'none'` with a reason and must never leak NaN / ±Infinity into
 * any segment or tick it returns for ANY malformed numeric input.
 *
 * The test walks every boundary field through NaN, ±Infinity, and inverted
 * order. Every `segments` result is scanned for non-finite or inverted
 * numbers; every `none` result is checked for a string reason.
 */
import {
  phaseTimelinePresentation,
  type TemporalPhaseBoundariesV2,
  type TemporalPhasesV2,
} from '../../src/components/strokeResultModel';

function boundaries(
  overrides: Partial<TemporalPhaseBoundariesV2>,
): TemporalPhasesV2 {
  return {
    status: 'segmented',
    boundaries: {
      version: 'v2',
      source: 'wrist',
      anchor: 'speed_peak',
      anchorBasis: 'event_peak',
      confidence: 0.8,
      preparationStartMs: 100,
      accelerationStartMs: 400,
      contactMs: null,
      motionPeakMs: 600,
      followThroughEndMs: 900,
      recoveryEndMs: 1300,
      ...overrides,
    },
  };
}

function assertNoNumericPoison(
  result: ReturnType<typeof phaseTimelinePresentation>,
) {
  if (result.kind === 'none') {
    expect(result.reason === null || typeof result.reason === 'string').toBe(
      true,
    );
    return;
  }
  expect(result.segments.length).toBeGreaterThan(0);
  for (const segment of result.segments) {
    expect(Number.isFinite(segment.startMs)).toBe(true);
    expect(Number.isFinite(segment.endMs)).toBe(true);
    expect(segment.endMs).toBeGreaterThan(segment.startMs);
  }
  if (result.contactTickMs !== null) {
    expect(Number.isFinite(result.contactTickMs)).toBe(true);
  }
}

describe('phaseTimelinePresentation adversarial (anchor-free, NaN, inverted)', () => {
  it('assigned attack: event_peak + contactMs=NaN + motionPeakMs=undefined + accelerationStart > followThroughEnd → none, out of order', () => {
    const result = phaseTimelinePresentation(
      boundaries({
        contactMs: Number.NaN,
        motionPeakMs: undefined,
        accelerationStartMs: 950,
        followThroughEndMs: 900,
      }),
    );
    expect(result).toEqual({
      kind: 'none',
      reason: 'phase boundaries out of order',
    });
    assertNoNumericPoison(result);
  });

  it('event_peak + contactMs=NaN + motionPeakMs=undefined with sane order → a single swing segment (contact never leaks)', () => {
    const result = phaseTimelinePresentation(
      boundaries({ contactMs: Number.NaN, motionPeakMs: undefined }),
    );
    expect(result.kind).toBe('segments');
    if (result.kind !== 'segments') return;
    expect(result.contactTickMs).toBeNull();
    expect(result.anchorFree).toBe(true);
    expect(result.segments.map(s => s.key)).toEqual([
      'preparation',
      'swing',
      'recovery',
    ]);
    assertNoNumericPoison(result);
  });

  it('event_peak with motionPeakMs=NaN behaves like a missing peak (no NaN split)', () => {
    const result = phaseTimelinePresentation(
      boundaries({ contactMs: Number.NaN, motionPeakMs: Number.NaN }),
    );
    expect(result.kind).toBe('segments');
    if (result.kind !== 'segments') return;
    expect(result.segments.map(s => s.key)).toEqual([
      'preparation',
      'swing',
      'recovery',
    ]);
    assertNoNumericPoison(result);
  });

  it('contact-anchored with contactMs=NaN is refused as incomplete', () => {
    expect(
      phaseTimelinePresentation(
        boundaries({ anchorBasis: 'contact_estimate', contactMs: Number.NaN }),
      ),
    ).toEqual({ kind: 'none', reason: 'phase boundaries incomplete' });
  });

  it('accelerationStart == followThroughEnd (zero-length swing) with no other segment → incomplete, not a zero-width bar', () => {
    const result = phaseTimelinePresentation(
      boundaries({
        preparationStartMs: null,
        recoveryEndMs: null,
        motionPeakMs: undefined,
        accelerationStartMs: 900,
        followThroughEndMs: 900,
      }),
    );
    expect(result).toEqual({
      kind: 'none',
      reason: 'phase boundaries incomplete',
    });
  });

  // Every required boundary poisoned one at a time with NaN / ±Infinity.
  // Whatever the presenter decides, NO non-finite number may reach a segment.
  const poisons: Array<[string, number]> = [
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ];
  const requiredFields: Array<
    keyof Pick<
      TemporalPhaseBoundariesV2,
      'accelerationStartMs' | 'followThroughEndMs' | 'motionPeakMs'
    >
  > = ['accelerationStartMs', 'followThroughEndMs', 'motionPeakMs'];

  for (const field of requiredFields) {
    for (const [label, poison] of poisons) {
      it(`${field}=${label} never yields a non-finite or inverted segment`, () => {
        const result = phaseTimelinePresentation(
          boundaries({ [field]: poison }),
        );
        assertNoNumericPoison(result);
      });
    }
  }

  it('optional preparation/recovery boundaries poisoned with ±Infinity/NaN are dropped, not drawn', () => {
    for (const [, poison] of poisons) {
      const result = phaseTimelinePresentation(
        boundaries({ preparationStartMs: poison, recoveryEndMs: poison }),
      );
      expect(result.kind).toBe('segments');
      if (result.kind !== 'segments') continue;
      expect(result.segments.map(s => s.key)).toEqual([
        'acceleration',
        'follow_through',
      ]);
      assertNoNumericPoison(result);
    }
  });

  it('huge but finite offsets are accepted verbatim (no overflow to Infinity)', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const result = phaseTimelinePresentation(
      boundaries({
        preparationStartMs: big - 4000,
        accelerationStartMs: big - 3000,
        motionPeakMs: big - 2000,
        followThroughEndMs: big - 1000,
        recoveryEndMs: big,
      }),
    );
    expect(result.kind).toBe('segments');
    assertNoNumericPoison(result);
  });

  it('abstained with an empty/unicode reason humanizes without throwing', () => {
    expect(
      phaseTimelinePresentation({ status: 'abstained', reason: '' }),
    ).toEqual({ kind: 'none', reason: '' });
    expect(
      phaseTimelinePresentation({
        status: 'abstained',
        reason: 'too_few_frames_🎾_ünïcode',
      }),
    ).toEqual({ kind: 'none', reason: 'too few frames 🎾 ünïcode' });
  });
});
