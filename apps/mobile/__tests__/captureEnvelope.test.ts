import type { CameraEvent } from '../src/camera/capture';
import {
  DEGRADED_JOINT_COVERAGE,
  DEGRADED_STABILITY_MS,
  captureGuidanceLines,
  envelopeFromReadinessEvent,
  readyGate,
  type EnvelopeVerdict,
} from '../src/camera/captureEnvelope';

/**
 * C13 — pre-Ready capture envelope. SUPPORTED/DEGRADED/UNSUPPORTED per
 * measured dimension; Ready blocks ONLY on UNSUPPORTED; unmeasured
 * dimensions (lighting has no live signal in this build) never produce
 * guidance or blocks.
 */

function readinessEvent(
  overrides: Partial<Extract<CameraEvent, { type: 'readiness' }>> = {},
): CameraEvent {
  return {
    type: 'readiness',
    state: 'ready',
    poseConfidence: 0.9,
    jointCoverage: 0.95,
    stableForMs: 900,
    missingJoints: [],
    source: 'apple_vision_body_pose',
    modelVersion: 'apple-vision-bodypose-1',
    emittedAtIso: '2026-08-30T10:00:00.000Z',
    ...overrides,
  };
}

describe('envelopeFromReadinessEvent', () => {
  it('non-readiness events produce no envelope', () => {
    expect(
      envelopeFromReadinessEvent({
        type: 'processing',
        state: 'preparing_clip',
        emittedAtIso: '2026-08-30T10:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('no_person: visibility UNSUPPORTED, distance unmeasured, lighting always absent', () => {
    const envelope = envelopeFromReadinessEvent(
      readinessEvent({ state: 'no_person', jointCoverage: 0 }),
    );
    expect(envelope?.dimensions.subject_visibility?.verdict).toBe(
      'UNSUPPORTED',
    );
    expect(envelope?.dimensions.subject_distance).toBeUndefined();
    expect(envelope?.dimensions.lighting).toBeUndefined();
  });

  it('full_body_required: visibility UNSUPPORTED with the state as reason', () => {
    const envelope = envelopeFromReadinessEvent(
      readinessEvent({ state: 'full_body_required', jointCoverage: 0.6 }),
    );
    expect(envelope?.dimensions.subject_visibility).toEqual({
      verdict: 'UNSUPPORTED',
      reason: 'full_body_required',
    });
  });

  it('move_closer: distance UNSUPPORTED while visibility follows joint coverage', () => {
    const envelope = envelopeFromReadinessEvent(
      readinessEvent({ state: 'move_closer', jointCoverage: 0.9 }),
    );
    expect(envelope?.dimensions.subject_distance?.verdict).toBe('UNSUPPORTED');
    expect(envelope?.dimensions.subject_visibility?.verdict).toBe('SUPPORTED');
  });

  it('partial joint coverage below the floor reads as DEGRADED visibility', () => {
    const envelope = envelopeFromReadinessEvent(
      readinessEvent({ jointCoverage: DEGRADED_JOINT_COVERAGE - 0.01 }),
    );
    expect(envelope?.dimensions.subject_visibility?.verdict).toBe('DEGRADED');
  });

  it('hold_still: stability UNSUPPORTED; short ready hold: DEGRADED', () => {
    expect(
      envelopeFromReadinessEvent(readinessEvent({ state: 'hold_still' }))
        ?.dimensions.stability?.verdict,
    ).toBe('UNSUPPORTED');
    expect(
      envelopeFromReadinessEvent(
        readinessEvent({ stableForMs: DEGRADED_STABILITY_MS - 1 }),
      )?.dimensions.stability?.verdict,
    ).toBe('DEGRADED');
    expect(
      envelopeFromReadinessEvent(readinessEvent())?.dimensions.stability
        ?.verdict,
    ).toBe('SUPPORTED');
  });
});

describe('captureGuidanceLines', () => {
  it('renders one actionable line per measured non-SUPPORTED dimension, in fixed order', () => {
    const envelope: EnvelopeVerdict = {
      schemaVersion: 1,
      source: 'live_readiness_events',
      dimensions: {
        stability: { verdict: 'UNSUPPORTED', reason: 'hold_still' },
        subject_visibility: {
          verdict: 'DEGRADED',
          reason: 'partial_joint_coverage',
        },
        subject_distance: { verdict: 'SUPPORTED' },
      },
    };
    const lines = captureGuidanceLines(envelope);
    expect(lines.map(line => line.dimension)).toEqual([
      'subject_visibility',
      'stability',
    ]);
    expect(lines[0]?.text).toContain('Keep your full body visible');
    expect(lines[1]?.text).toContain('Hold still');
  });

  it('a clean or absent envelope produces no guidance', () => {
    expect(captureGuidanceLines(null)).toEqual([]);
    expect(
      captureGuidanceLines({
        schemaVersion: 1,
        source: 'live_readiness_events',
        dimensions: { subject_visibility: { verdict: 'SUPPORTED' } },
      }),
    ).toEqual([]);
  });
});

describe('readyGate', () => {
  it('blocks ONLY on UNSUPPORTED dimensions — DEGRADED guides but permits', () => {
    const degradedOnly: EnvelopeVerdict = {
      schemaVersion: 1,
      source: 'live_readiness_events',
      dimensions: {
        subject_visibility: { verdict: 'DEGRADED' },
        stability: { verdict: 'DEGRADED' },
      },
    };
    expect(readyGate(degradedOnly)).toEqual({
      blocked: false,
      blockingDimensions: [],
    });

    const unsupported: EnvelopeVerdict = {
      schemaVersion: 1,
      source: 'live_readiness_events',
      dimensions: {
        subject_visibility: { verdict: 'DEGRADED' },
        subject_distance: { verdict: 'UNSUPPORTED', reason: 'move_closer' },
      },
    };
    expect(readyGate(unsupported)).toEqual({
      blocked: true,
      blockingDimensions: ['subject_distance'],
    });
  });

  it('no envelope means nothing measured and nothing blocked', () => {
    expect(readyGate(null).blocked).toBe(false);
  });
});
