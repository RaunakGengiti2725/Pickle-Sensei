import { analyzeClip } from '@pickle/analysis-pipeline';
import {
  createFusionProviders,
  scoringStackStatus,
  selectVisionProviders,
  SCORING_STACK_VERSION,
} from '../src/vision/providers';
import { generateSwing } from '@pickle/evaluation';

/**
 * App-level scoring gate: providers exist only for captures with a real
 * recorded pose sequence, and a valid recording flows through the full
 * pipeline to a scored, provenance-tagged analysis.
 */

function recordingFromSwing() {
  const swing = generateSwing();
  return {
    swing,
    recording: {
      poseFrames: swing.frames,
      poseModelVersion: 'apple-vision-bodypose-1',
      trigger: {
        modelVersion: 'temporal-stroke-heuristic-2',
        startMs: swing.window.startMs,
        endMs: swing.window.endMs,
        peakMotionMs: swing.window.peakMs,
        confidence: 0.86,
      },
      video: { width: swing.clip.width, height: swing.clip.height },
    },
  };
}

describe('vision provider selection', () => {
  it('reports the installed deterministic scoring stack', () => {
    expect(SCORING_STACK_VERSION).toBe('sm-v1 · geometry-3');
    expect(scoringStackStatus()).toEqual({
      installed: true,
      version: 'sm-v1 · geometry-3',
      requirement: 'recorded_pose_sequence',
    });
  });

  it('composes the installed v3 phase and feature providers in both analysis paths', () => {
    const { recording } = recordingFromSwing();
    const legacy = selectVisionProviders('forehand_drive', recording);
    expect(legacy.kind).toBe('real');
    if (legacy.kind !== 'real') throw new Error(legacy.reason);
    expect(legacy.providers.phase.modelVersion).toBe('phase-geometry-3');
    expect(legacy.providers.features.version).toBe('features-geometry-3');
    // Capture-side provenance is not rewritten to match the installed bundle.
    expect(legacy.providers.pose.modelVersion).toBe(recording.poseModelVersion);
    expect(legacy.providers.stroke.modelVersion).toBe(
      recording.trigger.modelVersion,
    );

    const fusion = createFusionProviders('forehand_drive');
    expect(fusion.kind).toBe('real');
    if (fusion.kind !== 'real') throw new Error(fusion.reason);
    expect(fusion.providers.phase.modelVersion).toBe('phase-geometry-3');
    expect(fusion.providers.biomechanics.descriptor.modelVersion).toBe(
      'features-geometry-3',
    );
  });

  it('refuses to issue providers without a recorded pose sequence', () => {
    const withoutRecording = selectVisionProviders('forehand_drive');
    expect(withoutRecording.kind).toBe('unavailable');
    if (withoutRecording.kind === 'unavailable') {
      expect(withoutRecording.reason).toContain('recorded pose sequence');
    }

    const { recording } = recordingFromSwing();
    const starved = selectVisionProviders('forehand_drive', {
      ...recording,
      poseFrames: recording.poseFrames.slice(0, 3),
    });
    expect(starved.kind).toBe('unavailable');
  });

  it('scores a recorded stroke end to end through the app providers', async () => {
    const { swing, recording } = recordingFromSwing();
    const availability = selectVisionProviders('forehand_drive', recording);
    expect(availability.kind).toBe('real');
    if (availability.kind !== 'real') return;

    const result = await analyzeClip(
      availability.providers,
      {
        uri: swing.clip.uri,
        durationMs: swing.clip.durationMs,
        fps: swing.clip.fps,
        width: swing.clip.width,
        height: swing.clip.height,
      },
      {
        analysisId: 'app-analysis-1',
        sessionId: null,
        shotType: 'forehand_drive',
        handedness: 'right',
        cameraView: 'side',
        appVersion: '0.1.0',
        modelBundleVersion: scoringStackStatus().version,
        capturedAtIso: '2026-08-27T18:00:00.000Z',
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe('real');
    expect(result.value.versionVector).toMatchObject({
      modelBundleVersion: 'sm-v1 · geometry-3',
      phaseModelVersion: 'phase-geometry-3',
      scoringModelVersion: 'sm-v1',
      poseModelVersion: recording.poseModelVersion,
      strokeDetectorVersion: recording.trigger.modelVersion,
    });
    expect(result.value.resultKind).toBe('scored');
    expect(result.value.overallScore).not.toBeNull();
    expect(result.value.measurements.every(m => m.source === 'real')).toBe(
      true,
    );
  });
});
