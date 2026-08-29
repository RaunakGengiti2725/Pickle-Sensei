import {
  assertCapturedClip,
  CAPTURE_COMPLETION_PARAMS_V1,
  MAX_BALL_SPEED_REPROJECTION_ERROR_PX,
  setCaptureCompletionStrategy,
} from '../src/camera/capture';

const baseClip = {
  uri: 'file:///private/var/mobile/clip.mov',
  durationMs: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
};

const trigger = {
  startMs: 2000,
  endMs: 2700,
  peakMotionMs: 2400,
  confidence: 0.82,
  source: 'temporal_pose_motion',
  modelVersion: 'temporal-stroke-heuristic-2',
};

const captureEvidence = {
  schemaVersion: 1,
  window: 'detected_motion',
  poseSource: 'apple_vision_body_pose',
  poseModelVersion: 'apple-vision-bodypose-1',
  triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
  motionUnit: 'normalized_image_units_per_second',
  analysisInputFrameCount: 7,
  poseFrameCount: 6,
  poseMissingFrameCount: 1,
  trackedDurationMs: 620,
  meanCanonicalJointVisibility: 0.88,
  meanJointCoverage: 0.94,
  minimumJointCoverage: 0.83,
  fullBodyVisibleFrameCount: 4,
  jointMotion: [
    {
      joint: 'left_shoulder',
      sampleCount: 3,
      meanNormalizedPerSecond: 0.3,
      peakNormalizedPerSecond: 0.7,
    },
    {
      joint: 'left_wrist',
      sampleCount: 5,
      meanNormalizedPerSecond: 1.1,
      peakNormalizedPerSecond: 2.4,
    },
  ],
};

const automaticClip = {
  ...baseClip,
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger,
  captureEvidence,
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 2000,
  postRollMs: 1500,
};

describe('native camera result boundary', () => {
  it('accepts measured pose evidence while preserving unknown recognition', () => {
    const clip = assertCapturedClip(automaticClip);
    if (clip.captureMode !== 'automatic_pose_trigger') {
      throw new Error('expected automatic capture');
    }
    expect(clip.recognition.status).toBe('unknown');
    expect(clip.trigger.confidence).toBe(0.82);
    expect(clip.captureEvidence.poseFrameCount).toBe(6);
    expect(clip.ballSpeed).toEqual({
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    });
  });

  it('accepts a real imported video without inventing a trigger or scan', () => {
    const clip = assertCapturedClip({
      ...baseClip,
      captureMode: 'imported_video',
      recognition: { status: 'unknown', reason: 'analysis_not_run' },
      ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    });
    expect(clip.captureMode).toBe('imported_video');
    expect(clip.trigger).toBeUndefined();
  });

  it.each(['trigger', 'captureEvidence', 'ballSpeed'] as const)(
    'rejects an automatic result without %s provenance',
    field => {
      const value = { ...automaticClip } as Record<string, unknown>;
      delete value[field];
      expect(() => assertCapturedClip(value)).toThrow(/invalid or incomplete/i);
    },
  );

  it('rejects inconsistent pose attempt counts', () => {
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        captureEvidence: {
          ...captureEvidence,
          analysisInputFrameCount: 99,
        },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects duplicate, out-of-order, or unsupported joints', () => {
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        captureEvidence: {
          ...captureEvidence,
          jointMotion: [
            captureEvidence.jointMotion[1],
            captureEvidence.jointMotion[0],
          ],
        },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        captureEvidence: {
          ...captureEvidence,
          jointMotion: [
            {
              ...captureEvidence.jointMotion[0],
              joint: 'paddle_hand',
            },
          ],
        },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects the wrong unit or mismatched trigger provenance', () => {
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        captureEvidence: {
          ...captureEvidence,
          motionUnit: 'mph',
        },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        captureEvidence: {
          ...captureEvidence,
          triggerAlgorithmVersion: 'some-other-trigger',
        },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects fake numeric speed on an unavailable state', () => {
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        ballSpeed: {
          status: 'unavailable',
          reason: 'calibrated_ball_tracker_unavailable',
          milesPerHour: 42,
        },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('accepts speed only with a calibrated, internally consistent track', () => {
    const metersPerSecond = 20;
    const clip = assertCapturedClip({
      ...automaticClip,
      ballSpeed: {
        status: 'measured',
        milesPerHour: metersPerSecond * 2.2369362920544,
        metersPerSecond,
        confidence: 0.91,
        source: 'calibrated_monocular_ball_track',
        calibrationId: 'court-calibration-7',
        trackerModelVersion: 'ball-track-3',
        measurementFrameRate: 120,
        trackPointCount: 12,
        trackedDistanceMeters: 2,
        trackedDurationMs: 100,
        reprojectionErrorPx: 1.4,
      },
    });
    expect(clip.ballSpeed.status).toBe('measured');
  });

  it('rejects inconsistent physical-speed conversions or trajectories', () => {
    const measured = {
      status: 'measured',
      milesPerHour: 70,
      metersPerSecond: 20,
      confidence: 0.91,
      source: 'calibrated_monocular_ball_track',
      calibrationId: 'court-calibration-7',
      trackerModelVersion: 'ball-track-3',
      measurementFrameRate: 120,
      trackPointCount: 12,
      trackedDistanceMeters: 9,
      trackedDurationMs: 100,
      reprojectionErrorPx: 1.4,
    };
    expect(() =>
      assertCapturedClip({ ...automaticClip, ballSpeed: measured }),
    ).toThrow(/invalid or incomplete/i);
  });

  it.each([
    ['zero confidence', { confidence: 0 }],
    ['track longer than clip', { trackedDurationMs: baseClip.durationMs + 1 }],
    ['impossible point rate', { trackPointCount: 50 }],
    [
      'excessive reprojection error',
      { reprojectionErrorPx: MAX_BALL_SPEED_REPROJECTION_ERROR_PX + 0.01 },
    ],
  ])('rejects measured speed with %s', (_label, override) => {
    const metersPerSecond = 20;
    const measured = {
      status: 'measured',
      milesPerHour: metersPerSecond * 2.2369362920544,
      metersPerSecond,
      confidence: 0.91,
      source: 'calibrated_monocular_ball_track',
      calibrationId: 'court-calibration-7',
      trackerModelVersion: 'ball-track-3',
      measurementFrameRate: 120,
      trackPointCount: 12,
      trackedDistanceMeters: 2,
      trackedDurationMs: 100,
      reprojectionErrorPx: 1.4,
      ...override,
    };
    expect(() =>
      assertCapturedClip({ ...automaticClip, ballSpeed: measured }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects imported video that pretends an automatic scan ran', () => {
    expect(() =>
      assertCapturedClip({
        ...baseClip,
        captureMode: 'imported_video',
        recognition: { status: 'unknown', reason: 'analysis_not_run' },
        captureEvidence,
        ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects a claimed classification without model provenance', () => {
    expect(() =>
      assertCapturedClip({
        ...baseClip,
        captureMode: 'imported_video',
        recognition: {
          status: 'recognized',
          shotType: 'drive_forehand',
          confidence: 0.91,
        },
        ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('accepts only canonical pickleball techniques as recognized strokes', () => {
    const recognized = assertCapturedClip({
      ...automaticClip,
      recognition: {
        status: 'recognized',
        shotType: 'drive_forehand',
        confidence: 0.91,
        modelVersion: 'pickleball-temporal-1',
      },
    });
    expect(recognized.recognition.status).toBe('recognized');

    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        recognition: {
          status: 'recognized',
          shotType: 'generic_forehand',
          confidence: 0.91,
          modelVersion: 'pickleball-temporal-1',
        },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects ambiguous recognition and legacy contact claims', () => {
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        recognition: {
          status: 'unknown',
          reason: 'validated_classifier_unavailable',
          shotType: 'drive_forehand',
        },
      }),
    ).toThrow(/invalid or incomplete/i);

    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        trigger: { ...trigger, contactMs: trigger.peakMotionMs },
      }),
    ).toThrow(/invalid or incomplete/i);
  });
});

describe('D-029 movement-completion telemetry boundary', () => {
  // Clip-relative like the trigger: movement end = trigger.endMs (2700),
  // anchor = trigger.peakMotionMs (2400). Fixed finalize at endMs + 1500.
  const completion = {
    schemaVersion: 1,
    completionStrategy: 'fixed',
    algorithmVersion: 'completion-monitor-1',
    motionUnit: 'normalized_image_units_per_second',
    movementCompleteMs: trigger.endMs,
    anchorMs: trigger.peakMotionMs,
    finalizeMs: 4200,
    peakMotionValue: 2.4,
    settleDetectedMs: 3350,
    safetyMaxHit: false,
    observedUntilMs: 4200,
    observedSampleCount: 40,
    params: { ...CAPTURE_COMPLETION_PARAMS_V1 },
    postCompletionMotion: [
      { tMs: 2400, v: 2.4 },
      { tMs: 2620, v: 1.05 },
      { tMs: 2950, v: 0.31 },
      { tMs: 3350, v: 0.12 },
      { tMs: 4150, v: 0.05 },
    ],
  };

  it('accepts fixed-strategy telemetry with a shadow adaptive decision', () => {
    const clip = assertCapturedClip({ ...automaticClip, completion });
    if (clip.captureMode !== 'automatic_pose_trigger') {
      throw new Error('expected automatic capture');
    }
    expect(clip.completion?.completionStrategy).toBe('fixed');
    expect(clip.completion?.settleDetectedMs).toBe(3350);
    expect(clip.completion?.safetyMaxHit).toBe(false);
    expect(clip.completion?.postCompletionMotion).toHaveLength(5);
  });

  it('accepts adaptive-strategy telemetry ending at a next-stroke valley', () => {
    const clip = assertCapturedClip({
      ...automaticClip,
      completion: {
        ...completion,
        completionStrategy: 'adaptive',
        settleDetectedMs: undefined,
        valleyDetectedMs: 3100,
        finalizeMs: 3260,
        observedUntilMs: 3260,
      },
    });
    if (clip.captureMode !== 'automatic_pose_trigger') {
      throw new Error('expected automatic capture');
    }
    expect(clip.completion?.completionStrategy).toBe('adaptive');
    expect(clip.completion?.valleyDetectedMs).toBe(3100);
  });

  it('accepts clips from builds that predate the instrument', () => {
    const clip = assertCapturedClip(automaticClip);
    if (clip.captureMode !== 'automatic_pose_trigger') {
      throw new Error('expected automatic capture');
    }
    expect(clip.completion).toBeUndefined();
  });

  it('rejects telemetry that disagrees with the trigger it claims to extend', () => {
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        completion: { ...completion, movementCompleteMs: trigger.endMs + 40 },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        completion: { ...completion, anchorMs: trigger.peakMotionMs + 1 },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects more than one completion decision per capture', () => {
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        completion: { ...completion, valleyDetectedMs: 3100 },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        completion: { ...completion, safetyMaxHit: true },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects unbounded, unordered, or pre-anchor motion series', () => {
    const long = Array.from({ length: 51 }, (_, index) => ({
      tMs: 2400 + index * 30,
      v: 0.5,
    }));
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        completion: {
          ...completion,
          observedSampleCount: 120,
          postCompletionMotion: long,
        },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        completion: {
          ...completion,
          postCompletionMotion: [
            { tMs: 2950, v: 0.3 },
            { tMs: 2620, v: 1.05 },
          ],
        },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        completion: {
          ...completion,
          postCompletionMotion: [{ tMs: trigger.peakMotionMs - 20, v: 1.4 }],
        },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects telemetry whose params drifted from the benched D-029 constants', () => {
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        completion: {
          ...completion,
          params: { ...CAPTURE_COMPLETION_PARAMS_V1, settleHoldMs: 500 },
        },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        completion: { ...completion, completionStrategy: 'aggressive' },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects imported video that pretends completion instrumentation ran', () => {
    expect(() =>
      assertCapturedClip({
        ...baseClip,
        captureMode: 'imported_video',
        recognition: { status: 'unknown', reason: 'analysis_not_run' },
        ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
        completion,
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('throws instead of silently ignoring a strategy switch without native support', async () => {
    await expect(setCaptureCompletionStrategy('adaptive')).rejects.toThrow(
      /not available/i,
    );
  });
});
