import type { EnvelopeVerdict } from '@pickle/shared-types';
import {
  CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  evaluateCaptureEnvelope,
} from '@pickle/capture-envelope';
import type { CaptureQualitySignalsV1 } from '../src/camera/capture';
import {
  attemptCaptureEnvelope,
  captureGuidanceLines,
  createAttemptEvidenceBuffer,
  liveCaptureEnvelope,
  qualityBlockedMessage,
  readyGate,
  sessionEventClipEnvelope,
} from '../src/camera/captureEnvelope';

/**
 * D07 — the mobile capture flow consumes the CANONICAL EnvelopeVerdict from
 * @pickle/shared-types, evaluated by the shared checker (C12) with its
 * versioned provisional thresholds. Gating rule under test: Ready blocks
 * ONLY on UNSUPPORTED; DEGRADED guides but permits; NOT_MEASURED produces
 * no guidance and never blocks.
 */

function qualitySignals(
  overrides: Partial<CaptureQualitySignalsV1> = {},
): CaptureQualitySignalsV1 {
  return {
    schemaVersion: 1,
    frameWidthPx: 1080,
    frameHeightPx: 1920,
    avgFrameRateFps: 60,
    brightnessMeanLuma: 120,
    laplacianVarianceMedian: 250,
    meanAbsFrameDiff: 2,
    sampledFrameCount: 12,
    ...overrides,
  };
}

function dimension(verdict: EnvelopeVerdict, name: string) {
  const found = verdict.dimensions.find(d => d.dimension === name);
  if (!found) throw new Error(`dimension ${name} missing`);
  return found;
}

describe('liveCaptureEnvelope', () => {
  it('returns null when nothing has been measured — no verdict from silence', () => {
    expect(liveCaptureEnvelope(null, null)).toBeNull();
  });

  it('produces the canonical shared-types verdict with versioned thresholds', () => {
    const verdict = liveCaptureEnvelope(
      { state: 'ready', jointCoverage: 0.95 },
      qualitySignals(),
    );
    expect(verdict).not.toBeNull();
    expect(verdict!.thresholdsVersion).toBe(
      CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
    );
    expect(verdict!.provisional).toBe(true);
    expect(verdict!.dimensions).toHaveLength(13);
  });

  it('reports unmeasured dimensions NOT_MEASURED, never SUPPORTED', () => {
    // Readiness only — no native quality emitter has fired.
    const verdict = liveCaptureEnvelope(
      { state: 'ready', jointCoverage: 0.95 },
      null,
    )!;
    expect(dimension(verdict, 'brightness').status).toBe('NOT_MEASURED');
    expect(dimension(verdict, 'motion_blur').status).toBe('NOT_MEASURED');
    expect(dimension(verdict, 'resolution').status).toBe('NOT_MEASURED');
    expect(verdict.notMeasured).toContain('brightness');
    expect(dimension(verdict, 'player_visibility').status).toBe('SUPPORTED');
  });

  it('reads no_person as an observed zero-visibility measurement', () => {
    const verdict = liveCaptureEnvelope(
      { state: 'no_person', jointCoverage: 0 },
      null,
    )!;
    const visibility = dimension(verdict, 'player_visibility');
    expect(visibility.status).toBe('UNSUPPORTED');
    expect(visibility.measured).toBe(0);
  });
});

describe('attemptCaptureEnvelope', () => {
  it('takes resolution/fps/duration from the real clip configuration', () => {
    const verdict = attemptCaptureEnvelope(
      { width: 1080, height: 1920, fps: 60, durationMs: 3200 },
      null,
      null,
    );
    expect(dimension(verdict, 'resolution')).toMatchObject({
      status: 'SUPPORTED',
      measured: 1080,
    });
    expect(dimension(verdict, 'frame_rate')).toMatchObject({
      status: 'SUPPORTED',
      measured: 60,
    });
    expect(dimension(verdict, 'clip_duration')).toMatchObject({
      status: 'SUPPORTED',
      measured: 3200,
    });
  });

  it('classifies a low-resolution clip UNSUPPORTED with the shared thresholds', () => {
    const verdict = attemptCaptureEnvelope(
      { width: 320, height: 240, fps: 60, durationMs: 3200 },
      null,
      null,
    );
    expect(dimension(verdict, 'resolution').status).toBe('UNSUPPORTED');
    expect(verdict.overall).toBe('UNSUPPORTED');
  });
});

describe('captureGuidanceLines', () => {
  it('returns nothing for a null or clean envelope', () => {
    expect(captureGuidanceLines(null)).toEqual([]);
    const clean = attemptCaptureEnvelope(
      { width: 1080, height: 1920, fps: 60, durationMs: 3200 },
      qualitySignals(),
      { state: 'ready', jointCoverage: 0.95 },
    );
    expect(captureGuidanceLines(clean)).toEqual([]);
  });

  it('never invents guidance for NOT_MEASURED dimensions', () => {
    const verdict = liveCaptureEnvelope(
      { state: 'ready', jointCoverage: 0.95 },
      null,
    )!;
    // Six dimensions are NOT_MEASURED here; none may produce a line.
    expect(captureGuidanceLines(verdict)).toEqual([]);
  });

  it('emits actionable lines for DEGRADED and UNSUPPORTED in canonical order', () => {
    const verdict = evaluateCaptureEnvelope({
      frameWidthPx: 640, // DEGRADED (480 ≤ 640 < 720)
      frameHeightPx: 1280,
      avgFrameRateFps: 60,
      frameIntervalCv: null,
      brightnessMeanLuma: 10, // UNSUPPORTED (too dark)
      brightnessStdLuma: null,
      laplacianVarianceMedian: null,
      denoiseSurvivalRatio: null,
      clippedPixelFraction: null,
      meanAbsFrameDiff: null,
      contrastNormalizedFrameDiff: null,
      clipDurationMs: null,
      playerPixelHeightFraction: null,
      playerMeanJointVisibility: null,
    });
    const lines = captureGuidanceLines(verdict);
    expect(lines.map(l => l.dimension)).toEqual(['resolution', 'brightness']);
    expect(lines[0]).toMatchObject({ status: 'DEGRADED' });
    expect(lines[1]).toMatchObject({ status: 'UNSUPPORTED' });
    for (const line of lines) expect(line.text.length).toBeGreaterThan(0);
  });
});

describe('readyGate', () => {
  it('does not block with no envelope', () => {
    expect(readyGate(null)).toEqual({ blocked: false, blockingDimensions: [] });
  });

  it('DEGRADED dimensions guide but never block Ready', () => {
    const verdict = attemptCaptureEnvelope(
      // 640 short side → resolution DEGRADED; 25fps → frame_rate DEGRADED.
      { width: 640, height: 1280, fps: 25, durationMs: 3200 },
      null,
      null,
    );
    expect(verdict.overall).toBe('DEGRADED');
    expect(captureGuidanceLines(verdict).length).toBeGreaterThan(0);
    expect(readyGate(verdict)).toEqual({
      blocked: false,
      blockingDimensions: [],
    });
  });

  it('UNSUPPORTED dimensions block Ready and are named', () => {
    const verdict = attemptCaptureEnvelope(
      { width: 320, height: 240, fps: 10, durationMs: 3200 },
      null,
      null,
    );
    const gate = readyGate(verdict);
    expect(gate.blocked).toBe(true);
    expect(gate.blockingDimensions).toEqual(['resolution', 'frame_rate']);
  });
});

describe('qualityBlockedMessage', () => {
  it('appends the actionable guidance line for every failing dimension', () => {
    const verdict = attemptCaptureEnvelope(
      { width: 320, height: 240, fps: 60, durationMs: 3200 },
      null,
      null,
    );
    const message = qualityBlockedMessage('Nothing was rated.', verdict);
    expect(message).toContain('Nothing was rated.');
    expect(message).toContain('raise the camera quality setting');
  });

  it('returns the plain reason when there is no guidance to give', () => {
    expect(qualityBlockedMessage('Nothing was rated.', null)).toBe(
      'Nothing was rated.',
    );
  });
});

describe('createAttemptEvidenceBuffer', () => {
  it('clears evidence at attempt start so one clip never inherits another clip readings', () => {
    const buffer = createAttemptEvidenceBuffer();
    buffer.noteReadiness({ state: 'no_person', jointCoverage: 0 });
    buffer.noteQuality(qualitySignals({ brightnessMeanLuma: 10 }));
    expect(buffer.readiness).not.toBeNull();
    expect(buffer.quality).not.toBeNull();

    buffer.beginAttempt();
    expect(buffer.readiness).toBeNull();
    expect(buffer.quality).toBeNull();
    // Without carried-over evidence the attempt envelope judges only what
    // the clip itself measures — stale no_person cannot block a new clip.
    const verdict = attemptCaptureEnvelope(
      { width: 1080, height: 1920, fps: 60, durationMs: 3200 },
      buffer.quality,
      buffer.readiness,
    );
    expect(dimension(verdict, 'player_visibility').status).toBe('NOT_MEASURED');
    expect(dimension(verdict, 'brightness').status).toBe('NOT_MEASURED');
    expect(verdict.overall).toBe('SUPPORTED');
  });
});

describe('sessionEventClipEnvelope', () => {
  it('judges resolution and frame rate from the real clip configuration', () => {
    const verdict = sessionEventClipEnvelope({
      width: 1080,
      height: 1920,
      fps: 60,
    });
    expect(dimension(verdict, 'resolution')).toMatchObject({
      status: 'SUPPORTED',
      measured: 1080,
    });
    expect(dimension(verdict, 'frame_rate')).toMatchObject({
      status: 'SUPPORTED',
      measured: 60,
    });
    expect(verdict.overall).toBe('SUPPORTED');
  });

  it('classifies a low-resolution session recording UNSUPPORTED', () => {
    const verdict = sessionEventClipEnvelope({
      width: 320,
      height: 240,
      fps: 60,
    });
    expect(dimension(verdict, 'resolution').status).toBe('UNSUPPORTED');
    expect(verdict.overall).toBe('UNSUPPORTED');
  });

  it('leaves engine-chosen clip duration NOT_MEASURED — the window length is not user capture quality', () => {
    const verdict = sessionEventClipEnvelope({
      width: 1080,
      height: 1920,
      fps: 60,
    });
    expect(dimension(verdict, 'clip_duration').status).toBe('NOT_MEASURED');
    expect(verdict.notMeasured).toContain('clip_duration');
  });
});
