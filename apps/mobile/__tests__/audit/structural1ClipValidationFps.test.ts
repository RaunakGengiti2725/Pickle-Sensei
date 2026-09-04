/**
 * Structural audit #1 (mobile-analyze-capture) — frame-rate contract of
 * `assertCapturedClip` vs the capture envelope.
 *
 * `assertCapturedClip` rejects non-finite and negative fps but accepts
 * `fps === 0` (capture.ts:706-708). A zero frame rate is not a measurement of
 * a real clip; downstream, the envelope judges it as a MEASURED
 * frame_rate = 0 ("too low to follow a swing") rather than NOT_MEASURED.
 * These cases pin what the validator does today so the contract mismatch is
 * visible: positive-finite fps is the documented shape of every other
 * numeric clip field (duration, width, height).
 */
import { assertCapturedClip } from '../../src/camera/capture';
import { attemptCaptureEnvelope } from '../../src/camera/captureEnvelope';

const importedBase = {
  uri: 'file:///private/var/mobile/import.mov',
  durationMs: 4200,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
};

describe('structural audit #1 — captured clip fps contract', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, '30', undefined])(
    'rejects fps=%p',
    fps => {
      expect(() => assertCapturedClip({ ...importedBase, fps })).toThrow();
    },
  );

  it('rejects fps=0 like every other non-positive clip dimension', () => {
    expect(() => assertCapturedClip({ ...importedBase, fps: 0 })).toThrow();
  });

  it('a zero fps clip that passes validation is judged UNSUPPORTED on frame_rate by the attempt envelope', () => {
    const verdict = attemptCaptureEnvelope(
      { width: 720, height: 1280, fps: 0, durationMs: 4200 },
      null,
      null,
    );
    const frameRate = verdict.dimensions.find(
      d => d.dimension === 'frame_rate',
    );
    expect(frameRate?.status).toBe('UNSUPPORTED');
    expect(frameRate?.measured).toBe(0);
    expect(verdict.overall).toBe('UNSUPPORTED');
  });
});
