/**
 * STRUCTURAL AUDIT #2 (mobile-analyze-capture) — captured-clip validation
 * edge values and how the attempt envelope judges them.
 *
 * Hotspot: `assertCapturedClip` accepts `fps === 0` (the check is `fps < 0`).
 * These cases pin what downstream does with such a clip so the acceptance is
 * classified honestly (defect vs. handled edge).
 */
import { assertCapturedClip } from '../src/camera/capture';
import {
  attemptCaptureEnvelope,
  createAttemptEvidenceBuffer,
  liveCaptureEnvelope,
  readyGate,
  sessionEventClipEnvelope,
} from '../src/camera/captureEnvelope';

function importedPayload(fps: number): Record<string, unknown> {
  return {
    uri: 'file:///private/var/mobile/import.mov',
    durationMs: 4200,
    fps,
    width: 1920,
    height: 1080,
    capturedAtIso: '2026-08-29T18:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
}

describe('fps === 0 clips (audit)', () => {
  it('VERIFY: assertCapturedClip accepts fps 0 (documented: finite fps ≥ 0) and rejects negative / non-finite fps', () => {
    expect(assertCapturedClip(importedPayload(0)).fps).toBe(0);
    expect(() => assertCapturedClip(importedPayload(-1))).toThrow();
    expect(() => assertCapturedClip(importedPayload(Number.NaN))).toThrow();
    expect(() =>
      assertCapturedClip(importedPayload(Number.POSITIVE_INFINITY)),
    ).toThrow();
  });

  it('VERIFY: a guided clip reporting fps 0 is judged frame_rate UNSUPPORTED by the attempt envelope, so the Ready gate blocks before any permit', () => {
    const envelope = attemptCaptureEnvelope(
      { width: 1080, height: 1080, fps: 0, durationMs: 2700 },
      null,
      { state: 'ready', jointCoverage: 0.9 },
    );
    const frameRate = envelope.dimensions.find(
      d => d.dimension === 'frame_rate',
    );
    expect(frameRate?.status).toBe('UNSUPPORTED');
    expect(envelope.overall).toBe('UNSUPPORTED');
    expect(readyGate(envelope).blocked).toBe(true);
    expect(readyGate(envelope).blockingDimensions).toContain('frame_rate');
  });

  it('VERIFY: a session event clip reporting fps 0 is likewise UNSUPPORTED', () => {
    const envelope = sessionEventClipEnvelope({
      width: 720,
      height: 1280,
      fps: 0,
    });
    expect(
      envelope.dimensions.find(d => d.dimension === 'frame_rate')?.status,
    ).toBe('UNSUPPORTED');
  });
});

describe('attempt evidence buffer semantics (audit)', () => {
  it('VERIFY: no_person is an observed zero-visibility read (UNSUPPORTED), a missing readiness is NOT_MEASURED', () => {
    const noPerson = liveCaptureEnvelope(
      { state: 'no_person', jointCoverage: 0.7 },
      null,
    );
    expect(
      noPerson?.dimensions.find(d => d.dimension === 'player_visibility')
        ?.status,
    ).toBe('UNSUPPORTED');
    expect(liveCaptureEnvelope(null, null)).toBeNull();
    const attempt = attemptCaptureEnvelope(
      { width: 1080, height: 1080, fps: 60, durationMs: 2700 },
      null,
      null,
    );
    expect(
      attempt.dimensions.find(d => d.dimension === 'player_visibility')
        ?.status,
    ).toBe('NOT_MEASURED');
  });

  it('DOCUMENT: the buffer keeps only the LAST readiness read — nothing freezes it at the swing', () => {
    const buffer = createAttemptEvidenceBuffer();
    buffer.noteReadiness({ state: 'ready', jointCoverage: 0.92 });
    buffer.noteReadiness({ state: 'no_person', jointCoverage: 0 });
    expect(buffer.readiness).toEqual({ state: 'no_person', jointCoverage: 0 });
    buffer.beginAttempt();
    expect(buffer.readiness).toBeNull();
    expect(buffer.quality).toBeNull();
  });
});
