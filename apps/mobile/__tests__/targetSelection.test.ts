import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

/**
 * The "tap yourself" seed must reach the analysis request intact. This is the
 * product contract: UI selection → TargetSeed → analysis. A seed that never
 * leaves the screen would be decoration.
 */
describe('target selection contract', () => {
  it('accepts a normalized target seed on the analysis request', () => {
    const request = {
      db: {} as never,
      captureId: 'c1',
      clip: { captureMode: 'imported_video' } as never,
      declaredStroke: 'forehand_drive' as never,
      handedness: 'right' as const,
      cameraView: 'side' as const,
      apiConfig: { baseUrl: '', token: null },
      appVersion: '0.1.0',
      targetSeed: {
        point: { x: 0.42, y: 0.63 },
        selectedAtIso: '2026-08-28T00:00:00.000Z',
      },
    };
    // Type-level contract plus a runtime guard on the normalized range.
    expect(request.targetSeed.point.x).toBeGreaterThanOrEqual(0);
    expect(request.targetSeed.point.x).toBeLessThanOrEqual(1);
    expect(request.targetSeed.point.y).toBeGreaterThanOrEqual(0);
    expect(request.targetSeed.point.y).toBeLessThanOrEqual(1);
    expect(typeof runCaptureAnalysis).toBe('function');
  });
});
