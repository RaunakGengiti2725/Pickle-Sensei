jest.mock('react-native', () => {
  const bridge = {
    capture: jest.fn(),
    importVideo: jest.fn(),
    cancel: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  return {
    Platform: { OS: 'ios' },
    NativeModules: { PickleVideoCapture: bridge },
    NativeEventEmitter: class {
      addListener() {
        return { remove: () => {} };
      }
    },
    __simulatedBridge: bridge,
  };
});

const { __simulatedBridge: mockBridge } = jest.requireMock('react-native') as {
  __simulatedBridge: Record<string, jest.Mock | undefined>;
};

import {
  assertCapturedClip,
  cancelCameraOperation,
  captureStrokeVideo,
  importStrokeVideo,
  CAPTURE_COMPLETION_PARAMS_V1,
  MAX_BALL_SPEED_REPROJECTION_ERROR_PX,
  setCaptureCompletionStrategy,
  TARGET_LOCK_PARAMS_V1,
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

function deferredCapture() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushCaptureCompletion() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('guided camera operation lifecycle', () => {
  beforeEach(() => {
    mockBridge.capture = jest.fn();
    mockBridge.importVideo = jest.fn();
    mockBridge.cancel = jest.fn();
  });

  it('keeps no-argument capture calls valid and native capture argument-free', async () => {
    mockBridge.capture!.mockResolvedValue(automaticClip);
    await expect(captureStrokeVideo()).resolves.toMatchObject({
      captureMode: 'automatic_pose_trigger',
      captureEvidence,
    });
    expect(mockBridge.capture).toHaveBeenCalledWith();
  });

  it('preserves optional native-export byte expectation without treating metadata as a byte read', async () => {
    const nativeMediaIdentity = {
      schemaVersion: 1,
      format: 'pickle.native-media-identity.v1',
      receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      videoFileName: 'clip.mov',
      origin: 'native_export',
      algorithm: 'sha256',
      sha256: 'a'.repeat(64),
      byteSize: 128,
    };
    const receipt = { ...automaticClip, byteSize: 128, nativeMediaIdentity };
    mockBridge.capture!.mockResolvedValue(receipt);
    const captured = await captureStrokeVideo();
    expect(captured.nativeMediaIdentity).toEqual(nativeMediaIdentity);
    expect(assertCapturedClip(JSON.parse(JSON.stringify(captured)))).toEqual(
      receipt,
    );
    expect(captured).not.toHaveProperty('verifiedCurrentBytes');
  });

  it('keeps unscoped no-argument cancellation compatible with a guided capture', async () => {
    const nativeResult = deferredCapture();
    mockBridge.capture!.mockReturnValue(nativeResult.promise);
    const run = captureStrokeVideo();
    void run.catch(() => {});
    cancelCameraOperation();
    nativeResult.resolve(automaticClip);
    await flushCaptureCompletion();
    await expect(run).rejects.toMatchObject({
      code: 'camera.cancelled',
      message: 'Camera operation was canceled.',
    });
    expect(mockBridge.capture).toHaveBeenCalledWith();
    expect(mockBridge.cancel).toHaveBeenCalledTimes(1);
    expect(mockBridge.cancel).toHaveBeenCalledWith();
  });

  it('does not start or cancel native work for an already-aborted guided attempt', async () => {
    mockBridge.capture!.mockResolvedValue(automaticClip);
    const controller = new AbortController();
    controller.abort();
    await expect(
      captureStrokeVideo({ signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'camera.cancelled',
      message: 'Camera operation was canceled.',
    });
    expect(mockBridge.capture).not.toHaveBeenCalled();
    expect(mockBridge.cancel).not.toHaveBeenCalled();
  });

  it.each(['', '../escape', 'x'.repeat(129), 'run\n'])(
    'rejects invalid guided operation id %s before native work',
    async operationId => {
      mockBridge.capture!.mockResolvedValue(automaticClip);
      await expect(captureStrokeVideo({ operationId })).rejects.toThrow(
        /operation id/i,
      );
      expect(mockBridge.capture).not.toHaveBeenCalled();
    },
  );

  it.each(['success', 'failure'])(
    'aborts guided capture promptly and ignores late native %s',
    async settlement => {
      const nativeResult = deferredCapture();
      const controller = new AbortController();
      const published = jest.fn();
      const rejected = jest.fn();
      mockBridge.capture!.mockReturnValue(nativeResult.promise);
      const run = captureStrokeVideo({
        operationId: 'guided-abort',
        signal: controller.signal,
      });
      void run.then(published, rejected);
      controller.abort();
      cancelCameraOperation('guided-abort');
      await flushCaptureCompletion();
      const earlyFailure: unknown = rejected.mock.calls[0]?.[0];
      if (settlement === 'success') nativeResult.resolve(automaticClip);
      else
        nativeResult.reject(
          Object.assign(new Error('Native failure after cancellation'), {
            code: 'camera.processing_failed',
          }),
        );
      await flushCaptureCompletion();
      expect(earlyFailure).toMatchObject({
        code: 'camera.cancelled',
        message: 'Camera operation was canceled.',
      });
      await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });
      expect(mockBridge.capture).toHaveBeenCalledWith();
      expect(mockBridge.cancel).toHaveBeenCalledTimes(1);
      expect(mockBridge.cancel).toHaveBeenCalledWith();
      expect(published).not.toHaveBeenCalled();
      expect(rejected).toHaveBeenCalledTimes(1);
    },
  );

  it('retains the guided drain barrier and rejects competing captures and imports', async () => {
    const nativeResult = deferredCapture();
    mockBridge.capture!.mockReturnValue(nativeResult.promise);
    const run = captureStrokeVideo({ operationId: 'guided-drain' });
    void run.catch(() => {});
    try {
      await expect(captureStrokeVideo()).rejects.toMatchObject({
        code: 'camera.busy',
      });
      await expect(importStrokeVideo()).rejects.toMatchObject({
        code: 'camera.busy',
      });
      cancelCameraOperation('guided-drain');
      await expect(captureStrokeVideo()).rejects.toMatchObject({
        code: 'camera.busy',
      });
      await expect(importStrokeVideo()).rejects.toMatchObject({
        code: 'camera.busy',
      });
      expect(mockBridge.capture).toHaveBeenCalledTimes(1);
      expect(mockBridge.importVideo).not.toHaveBeenCalled();
    } finally {
      nativeResult.resolve(automaticClip);
      await flushCaptureCompletion();
    }
    await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });
    mockBridge.capture!.mockResolvedValue(automaticClip);
    await expect(captureStrokeVideo()).resolves.toMatchObject({
      captureMode: 'automatic_pose_trigger',
    });
  });

  it('ignores a stale id while a later guided operation is active and accepts the current id', async () => {
    const oldController = new AbortController();
    mockBridge.capture!.mockResolvedValue(automaticClip);
    await captureStrokeVideo({
      operationId: 'guided-old',
      signal: oldController.signal,
    });
    const nativeResult = deferredCapture();
    mockBridge.capture!.mockReturnValue(nativeResult.promise);
    const run = captureStrokeVideo({ operationId: 'guided-current' });
    void run.catch(() => {});
    let staleCancelCalls = -1;
    try {
      cancelCameraOperation('guided-old');
      oldController.abort();
      staleCancelCalls = mockBridge.cancel!.mock.calls.length;
      cancelCameraOperation('guided-current');
    } finally {
      nativeResult.reject(
        Object.assign(new Error('Native cancelled'), {
          code: 'camera.cancelled',
        }),
      );
      await flushCaptureCompletion();
    }
    await expect(run).rejects.toMatchObject({
      code: 'camera.cancelled',
      message: 'Camera operation was canceled.',
    });
    expect(staleCancelCalls).toBe(0);
    expect(mockBridge.cancel).toHaveBeenCalledTimes(1);
    expect(mockBridge.cancel).toHaveBeenCalledWith();
  });

  it.each([
    'success',
    'native rejection',
    'invalid receipt',
    'synchronous throw',
  ])(
    'detaches the guided abort listener on %s without mutating validation or native errors',
    async settlement => {
      const controller = new AbortController();
      const add = jest.spyOn(controller.signal, 'addEventListener');
      const remove = jest.spyOn(controller.signal, 'removeEventListener');
      const error = Object.assign(new Error('Camera permission denied'), {
        code: 'camera.permission_denied',
      });
      if (settlement === 'success')
        mockBridge.capture!.mockResolvedValue(automaticClip);
      else if (settlement === 'native rejection')
        mockBridge.capture!.mockRejectedValue(error);
      else if (settlement === 'invalid receipt')
        mockBridge.capture!.mockResolvedValue({
          ...automaticClip,
          captureEvidence: undefined,
        });
      else
        mockBridge.capture!.mockImplementation(() => {
          throw error;
        });
      const options = {
        operationId: 'guided-cleanup',
        signal: controller.signal,
      };
      const run = captureStrokeVideo(options);
      options.signal = new AbortController().signal;
      if (settlement === 'success')
        await expect(run).resolves.toMatchObject({
          captureMode: 'automatic_pose_trigger',
        });
      else if (settlement === 'invalid receipt')
        await expect(run).rejects.toThrow(/invalid or incomplete/i);
      else await expect(run).rejects.toBe(error);
      controller.abort();
      expect(mockBridge.cancel).not.toHaveBeenCalled();
      expect(add).toHaveBeenCalledWith('abort', expect.any(Function), {
        once: true,
      });
      const listener = add.mock.calls[0]?.[1];
      expect(remove).toHaveBeenCalledWith('abort', listener);
      mockBridge.capture!.mockResolvedValue(automaticClip);
      await expect(captureStrokeVideo()).resolves.toMatchObject({
        captureMode: 'automatic_pose_trigger',
      });
    },
  );

  it('detaches the guided listener immediately on cancellation, even if native cancel throws', async () => {
    const nativeResult = deferredCapture();
    const controller = new AbortController();
    const add = jest.spyOn(controller.signal, 'addEventListener');
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const rejected = jest.fn();
    mockBridge.capture!.mockReturnValue(nativeResult.promise);
    mockBridge.cancel!.mockImplementation(() => {
      throw new Error('Bridge unavailable');
    });
    const run = captureStrokeVideo({
      operationId: 'guided-throwing-cancel',
      signal: controller.signal,
    });
    void run.catch(rejected);
    controller.abort();
    await flushCaptureCompletion();
    const earlyFailure: unknown = rejected.mock.calls[0]?.[0];
    const listenerRemoved = remove.mock.calls.some(
      ([type, listener]) =>
        type === 'abort' && listener === add.mock.calls[0]?.[1],
    );
    nativeResult.resolve(automaticClip);
    await flushCaptureCompletion();
    expect(earlyFailure).toMatchObject({ code: 'camera.cancelled' });
    expect(listenerRemoved).toBe(true);
    await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });
    expect(mockBridge.cancel).toHaveBeenCalledTimes(1);
  });
});

function withCaptureBridge(bridge: {
  capture: jest.Mock;
  captureWithOptions?: jest.Mock;
}) {
  let module!: typeof import('../src/camera/capture');
  jest.doMock('react-native', () => ({
    NativeModules: { PickleVideoCapture: bridge },
    Platform: { OS: 'ios' },
    NativeEventEmitter: jest.fn(),
  }));
  try {
    jest.isolateModules(() => {
      module = jest.requireActual<typeof import('../src/camera/capture')>(
        '../src/camera/capture',
      );
    });
  } finally {
    jest.dontMock('react-native');
  }
  return module;
}

describe('guided capture uses the declared hitting hand', () => {
  it.each(['left', 'right'] as const)(
    'passes %s handedness to the capable native bridge',
    async handedness => {
      const bridge = {
        capture: jest.fn(),
        captureWithOptions: jest.fn().mockResolvedValue(automaticClip),
      };
      const camera = withCaptureBridge(bridge);
      const clip = await camera.captureStrokeVideo({ handedness });
      expect(bridge.captureWithOptions).toHaveBeenCalledWith({ handedness });
      expect(bridge.capture).not.toHaveBeenCalled();
      expect(clip.recognition.status).toBe('unknown');
    },
  );

  it('preserves the legacy native capture signature on older binaries', async () => {
    const bridge = { capture: jest.fn().mockResolvedValue(automaticClip) };
    const camera = withCaptureBridge(bridge);
    await camera.captureStrokeVideo({ handedness: 'left' });
    expect(bridge.capture.mock.calls).toEqual([[]]);
  });

  it('keeps both wrists available for an ambidextrous declaration', async () => {
    const bridge = {
      capture: jest.fn().mockResolvedValue(automaticClip),
      captureWithOptions: jest.fn().mockResolvedValue(automaticClip),
    };
    const camera = withCaptureBridge(bridge);
    await camera.captureStrokeVideo({ handedness: 'ambidextrous' });
    expect(bridge.capture.mock.calls).toEqual([[]]);
    expect(bridge.captureWithOptions).not.toHaveBeenCalled();
  });

  it('does not start a second capture if the configured native capture fails', async () => {
    const bridge = {
      capture: jest.fn(),
      captureWithOptions: jest
        .fn()
        .mockRejectedValue(new Error('Camera interrupted')),
    };
    const camera = withCaptureBridge(bridge);
    await expect(
      camera.captureStrokeVideo({ handedness: 'right' }),
    ).rejects.toThrow('Camera interrupted');
    expect(bridge.capture).not.toHaveBeenCalled();
  });
});

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

describe('target-lock telemetry boundary (acquire-v4 promotion evidence)', () => {
  const tapPoint = { x: 0.5, y: 0.62 };
  const lockTorso = { x: 0.53, y: 0.6 };
  const lockedTelemetry = {
    schemaVersion: 1,
    algorithmVersion: 'target-lock-live-v1',
    coordinateSystem: 'normalized_capture_space',
    tapPoint,
    lockOutcome: 'locked',
    lockSource: 'start_region_occupancy',
    lockTorso,
    tapToLockDistance: Math.hypot(
      lockTorso.x - tapPoint.x,
      lockTorso.y - tapPoint.y,
    ),
    timeToLockMs: 640,
    ambiguityEntered: false,
    params: TARGET_LOCK_PARAMS_V1,
  };
  const lockedClip = {
    ...automaticClip,
    targetSeed: {
      x: lockTorso.x,
      y: lockTorso.y,
      source: 'start_region_occupancy',
    },
    targetLock: lockedTelemetry,
  };

  it('accepts a locked record whose distance recomputes from its points', () => {
    const clip = assertCapturedClip(lockedClip);
    if (clip.captureMode !== 'automatic_pose_trigger') {
      throw new Error('expected automatic capture');
    }
    expect(clip.targetLock?.tapToLockDistance).toBeCloseTo(
      Math.hypot(0.03, 0.02),
      10,
    );
    expect(clip.targetLock?.lockSource).toBe('start_region_occupancy');
  });

  it('accepts captures that predate the instrument (no targetLock)', () => {
    expect(() => assertCapturedClip(automaticClip)).not.toThrow();
  });

  it('accepts an honest no-lock record with no seed', () => {
    const clip = assertCapturedClip({
      ...automaticClip,
      targetLock: {
        schemaVersion: 1,
        algorithmVersion: 'target-lock-live-v1',
        coordinateSystem: 'normalized_capture_space',
        tapPoint,
        lockOutcome: 'no_lock',
        ambiguityEntered: true,
        ambiguityDurationMs: 2100,
        params: TARGET_LOCK_PARAMS_V1,
      },
    });
    if (clip.captureMode !== 'automatic_pose_trigger') {
      throw new Error('expected automatic capture');
    }
    expect(clip.targetLock?.lockOutcome).toBe('no_lock');
  });

  it('rejects a distance that does not recompute from the recorded points', () => {
    expect(() =>
      assertCapturedClip({
        ...lockedClip,
        targetLock: { ...lockedTelemetry, tapToLockDistance: 0.01 },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects a locked record that disagrees with the clip targetSeed', () => {
    expect(() =>
      assertCapturedClip({
        ...lockedClip,
        targetSeed: { x: 0.9, y: 0.9, source: 'start_region_occupancy' },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...lockedClip,
        targetSeed: {
          x: lockTorso.x,
          y: lockTorso.y,
          source: 'gesture_confirmed',
        },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        targetLock: lockedTelemetry,
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects ambiguity-resolved locks that never flagged ambiguity', () => {
    const gestureTorso = { x: 0.47, y: 0.65 };
    const gestureLock = {
      ...lockedTelemetry,
      lockSource: 'gesture_confirmed',
      lockTorso: gestureTorso,
      tapToLockDistance: Math.hypot(
        gestureTorso.x - tapPoint.x,
        gestureTorso.y - tapPoint.y,
      ),
    };
    const gestureSeed = {
      x: gestureTorso.x,
      y: gestureTorso.y,
      source: 'gesture_confirmed',
    };
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        targetSeed: gestureSeed,
        targetLock: { ...gestureLock, ambiguityEntered: false },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        targetSeed: gestureSeed,
        targetLock: {
          ...gestureLock,
          ambiguityEntered: true,
          ambiguityDurationMs: 900,
        },
      }),
    ).not.toThrow();
  });

  it('rejects a timeout lock whose ambiguity lasted less than the timeout', () => {
    const timeoutLock = {
      ...lockedTelemetry,
      lockSource: 'ambiguity_timeout',
      ambiguityEntered: true,
    };
    const timeoutSeed = {
      x: lockTorso.x,
      y: lockTorso.y,
      source: 'ambiguity_timeout',
    };
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        targetSeed: timeoutSeed,
        targetLock: { ...timeoutLock, ambiguityDurationMs: 2000 },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        targetSeed: timeoutSeed,
        targetLock: { ...timeoutLock, ambiguityDurationMs: 3040 },
      }),
    ).not.toThrow();
  });

  it('rejects params drifted from the shipped D-027 constants', () => {
    expect(() =>
      assertCapturedClip({
        ...lockedClip,
        targetLock: {
          ...lockedTelemetry,
          params: { ...TARGET_LOCK_PARAMS_V1, startRegionRadius: 0.25 },
        },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects malformed points, sources, and outcomes', () => {
    expect(() =>
      assertCapturedClip({
        ...lockedClip,
        targetLock: { ...lockedTelemetry, tapPoint: { x: 1.4, y: 0.5 } },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...lockedClip,
        targetLock: { ...lockedTelemetry, lockSource: 'manual_override' },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...lockedClip,
        targetLock: { ...lockedTelemetry, lockOutcome: 'maybe' },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...lockedClip,
        targetLock: { ...lockedTelemetry, timeToLockMs: -5 },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects a no-lock record that still claims lock evidence or a seed', () => {
    const noLock = {
      schemaVersion: 1,
      algorithmVersion: 'target-lock-live-v1',
      coordinateSystem: 'normalized_capture_space',
      tapPoint,
      lockOutcome: 'no_lock',
      ambiguityEntered: false,
      params: TARGET_LOCK_PARAMS_V1,
    };
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        targetLock: { ...noLock, lockTorso },
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({
        ...automaticClip,
        targetSeed: {
          x: lockTorso.x,
          y: lockTorso.y,
          source: 'start_region_occupancy',
        },
        targetLock: noLock,
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('rejects imported video that pretends live target acquisition ran', () => {
    expect(() =>
      assertCapturedClip({
        ...baseClip,
        captureMode: 'imported_video',
        recognition: { status: 'unknown', reason: 'analysis_not_run' },
        ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
        targetLock: lockedTelemetry,
      }),
    ).toThrow(/invalid or incomplete/i);
  });
});
