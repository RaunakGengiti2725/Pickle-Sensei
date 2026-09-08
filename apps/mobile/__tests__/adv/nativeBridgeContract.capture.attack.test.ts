/**
 * INT-native-bridge-contract adversary — guided capture / import / byte
 * comparison surface (the paths AnalyzeScreen ships today), against a
 * SIMULATED native module. Each block encodes what the TS seam must uphold
 * when Swift misbehaves or settles in a hostile order; a failing test is a
 * confirmed TS-side break, a passing test is seam evidence. Swift/Vision
 * runtime itself is NOT proven here (`scripts/mac-full-verify.sh --remote`).
 */
jest.mock('react-native', () => {
  const listeners: Array<(event: object) => void> = [];
  const bridge = {
    capture: jest.fn(),
    captureWithOptions: jest.fn(),
    importVideo: jest.fn(),
    extractImportedPoseSequence: jest.fn(),
    compareCapturedClipBytes: jest.fn(),
    cancel: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  return {
    Platform: { OS: 'ios' },
    NativeModules: { PickleVideoCapture: bridge },
    NativeEventEmitter: class {
      addListener(_type: string, listener: (event: object) => void) {
        listeners.push(listener);
        return {
          remove: () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      }
    },
    __simulatedBridge: bridge,
    __simulatedListeners: listeners,
  };
});

const { __simulatedBridge: mockBridge } = jest.requireMock('react-native') as {
  __simulatedBridge: {
    capture: jest.Mock;
    captureWithOptions: jest.Mock;
    importVideo: jest.Mock;
    extractImportedPoseSequence: jest.Mock;
    compareCapturedClipBytes: jest.Mock;
    cancel: jest.Mock;
  };
};

import {
  assertCapturedClip,
  assertImportedPoseExtraction,
  cancelCameraOperation,
  captureStrokeVideo,
  extractImportedPoseSequence,
  importStrokeVideo,
  MAX_IMPORTED_POSE_FRAMES,
  verifyCapturedClipCurrentBytes,
  type CapturedClip,
} from '../../src/camera/capture';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';

const ownerA = '11111111-1111-4111-8111-111111111111';

/** Automatic-capture payload with exactly the keys `ClipMediaStore.
 * exportStrokeWindow` emits for a guided capture (no optional keys). */
function guidedPayload(): Record<string, unknown> {
  return {
    uri: 'file:///private/var/mobile/Containers/Data/Application/APP/Library/Application%20Support/PickleSensei/Captures/guided-adv.mov',
    durationMs: 4300,
    width: 1080,
    height: 1920,
    fps: 30,
    capturedAtIso: '2026-09-08T10:00:05.000Z',
    captureMode: 'automatic_pose_trigger',
    preRollMs: 2000,
    postRollMs: 1500,
    trigger: {
      startMs: 2000,
      endMs: 2800,
      peakMotionMs: 2400,
      confidence: 0.7,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 24,
      poseFrameCount: 22,
      poseMissingFrameCount: 2,
      trackedDurationMs: 760,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.95,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: 18,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 21,
          meanNormalizedPerSecond: 1.3,
          peakNormalizedPerSecond: 3.1,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
  };
}

const identity = {
  schemaVersion: 1,
  format: 'pickle.native-media-identity.v1',
  receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  videoFileName: 'import-cccccccc-cccc-4ccc-8ccc-cccccccccccc.mov',
  origin: 'import_copy',
  algorithm: 'sha256',
  sha256: 'a'.repeat(64),
  byteSize: 2097169,
};

function importedPayload(): Record<string, unknown> {
  return {
    uri: `file:///private/var/mobile/Containers/Data/Application/APP/Library/Application%20Support/PickleSensei/Captures/${identity.videoFileName}`,
    durationMs: 4200,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-09-08T10:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'imported_video_not_analyzed' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    byteSize: identity.byteSize,
    nativeMediaIdentity: { ...identity },
  };
}

function comparisonEcho(
  operationId: string,
  status = 'verified-current-bytes',
) {
  return {
    status,
    operationId,
    receiptId: identity.receiptId,
    videoFileName: identity.videoFileName,
    expectedSha256: identity.sha256,
    expectedByteSize: identity.byteSize,
  };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function drain() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function nativeError(code: string, message = code) {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  mockBridge.capture.mockReset();
  mockBridge.captureWithOptions.mockReset();
  mockBridge.importVideo.mockReset();
  mockBridge.extractImportedPoseSequence.mockReset();
  mockBridge.compareCapturedClipBytes.mockReset();
  mockBridge.cancel.mockReset();
  setActiveDataOwner(ownerA);
});

afterEach(() => {
  cancelCameraOperation();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('ATTACK B1 — permission denial then recovery', () => {
  it('propagates camera.permission_denied verbatim and releases the lock so the next attempt can start', async () => {
    mockBridge.capture.mockRejectedValueOnce(
      nativeError('camera.permission_denied', 'Camera access was denied.'),
    );
    await expect(captureStrokeVideo()).rejects.toMatchObject({
      code: 'camera.permission_denied',
      message: 'Camera access was denied.',
    });
    expect(mockBridge.cancel).not.toHaveBeenCalled();
    mockBridge.capture.mockResolvedValueOnce(guidedPayload());
    const clip = await captureStrokeVideo();
    expect(clip.captureMode).toBe('automatic_pose_trigger');
    expect(mockBridge.capture).toHaveBeenCalledTimes(2);
  });

  it('surfaces a synchronous native throw (bridge not ready) as that error, not as busy, and releases the lock', async () => {
    mockBridge.capture.mockImplementationOnce(() => {
      throw nativeError('camera.configuration_failed');
    });
    await expect(captureStrokeVideo()).rejects.toMatchObject({
      code: 'camera.configuration_failed',
    });
    mockBridge.importVideo.mockResolvedValueOnce(importedPayload());
    await expect(importStrokeVideo()).resolves.toMatchObject({
      captureMode: 'imported_video',
    });
  });
});

describe('ATTACK B2 — hostile settlement order after cancellation', () => {
  it('keeps camera.cancelled when native later rejects with a different code (interrupted/backgrounded)', async () => {
    const pending = deferred();
    mockBridge.capture.mockReturnValueOnce(pending.promise);
    const attempt = captureStrokeVideo({ operationId: 'adv-cancel-1' });
    const settled = attempt.then(
      () => 'resolved',
      (error: { code?: string }) => error.code ?? 'no-code',
    );
    await drain();
    cancelCameraOperation('adv-cancel-1');
    expect(mockBridge.cancel).toHaveBeenCalledTimes(1);
    pending.reject(nativeError('camera.interrupted'));
    await expect(settled).resolves.toBe('camera.cancelled');
    // Drained: a new capture is admitted.
    mockBridge.capture.mockResolvedValueOnce(guidedPayload());
    await expect(captureStrokeVideo()).resolves.toMatchObject({
      captureMode: 'automatic_pose_trigger',
    });
  });

  it('a native success that arrives after cancel is discarded, never validated or returned', async () => {
    const pending = deferred();
    const validate = jest.fn();
    mockBridge.capture.mockReturnValueOnce(pending.promise);
    const attempt = captureStrokeVideo({ operationId: 'adv-cancel-2' });
    const settled = attempt.then(
      clip => {
        validate(clip);
        return 'resolved';
      },
      (error: { code?: string }) => error.code ?? 'no-code',
    );
    await drain();
    cancelCameraOperation('adv-cancel-2');
    const poisoned = guidedPayload();
    poisoned.uri = 'https://attacker.example/clip.mov';
    pending.resolve(poisoned);
    await expect(settled).resolves.toBe('camera.cancelled');
    expect(validate).not.toHaveBeenCalled();
  });

  it('a hung native capture keeps the busy barrier (no timeout) — documents the recovery cost of a wedged native op', async () => {
    const pending = deferred();
    mockBridge.capture.mockReturnValueOnce(pending.promise);
    const attempt = captureStrokeVideo({ operationId: 'adv-hung' });
    const settled = attempt.then(
      () => 'resolved',
      (error: { code?: string }) => error.code ?? 'no-code',
    );
    await drain();
    cancelCameraOperation('adv-hung');
    await expect(settled).resolves.toBe('camera.cancelled');
    // Native never settles: TS still refuses new work with camera.busy.
    await expect(importStrokeVideo()).rejects.toMatchObject({
      code: 'camera.busy',
    });
    await expect(captureStrokeVideo()).rejects.toMatchObject({
      code: 'camera.busy',
    });
    // Only native settlement (here: its own cancel rejection) drains the barrier.
    pending.reject(nativeError('camera.cancelled'));
    await drain();
    mockBridge.capture.mockResolvedValueOnce(guidedPayload());
    await expect(captureStrokeVideo()).resolves.toMatchObject({
      captureMode: 'automatic_pose_trigger',
    });
  });
});

describe('ATTACK B3 — Swift-emitted trigger vs measured export duration boundary', () => {
  it('accepts trigger.endMs === durationMs and rejects trigger.endMs === durationMs + 1 (clamped-tail exports sit on this edge)', () => {
    const onEdge = guidedPayload();
    onEdge.durationMs = 2800;
    (onEdge.captureEvidence as Record<string, unknown>).trackedDurationMs = 760;
    expect(assertCapturedClip(onEdge).captureMode).toBe(
      'automatic_pose_trigger',
    );
    const pastEdge = guidedPayload();
    pastEdge.durationMs = 2799;
    expect(() => assertCapturedClip(pastEdge)).toThrow();
  });

  it('rejects a guided payload whose evidence window exceeds the trigger (native tracked more than it cut)', () => {
    const payload = guidedPayload();
    (payload.captureEvidence as Record<string, unknown>).trackedDurationMs =
      801;
    expect(() => assertCapturedClip(payload)).toThrow();
  });

  it('rejects malformed scalars Swift could never emit but a bridge coercion might (incl. a path-less file: uri)', () => {
    const accepted: string[] = [];
    for (const [label, mutate] of [
      ['fps: true', (p: Record<string, unknown>) => (p.fps = true)],
      ['width: "1080"', (p: Record<string, unknown>) => (p.width = '1080')],
      ['byteSize: 0', (p: Record<string, unknown>) => (p.byteSize = 0)],
      ['preRollMs: -1', (p: Record<string, unknown>) => (p.preRollMs = -1)],
      [
        'capturedAtIso: "yesterday"',
        (p: Record<string, unknown>) => (p.capturedAtIso = 'yesterday'),
      ],
      [
        'uri: file: (empty path)',
        (p: Record<string, unknown>) => (p.uri = 'file:'),
      ],
    ] as Array<[string, (p: Record<string, unknown>) => unknown]>) {
      const payload = guidedPayload();
      mutate(payload);
      try {
        assertCapturedClip(payload);
        accepted.push(label);
      } catch {
        // rejected as expected
      }
    }
    expect(accepted).toEqual([]);
  });
});

describe('ATTACK B4 — imported pose receipt at the Swift budget boundary', () => {
  const importedClip = assertCapturedClip(
    importedPayload(),
    'imported_video',
  ) as Extract<CapturedClip, { captureMode: 'imported_video' }>;

  function receipt(framesWithPose: number, framesTotal: number) {
    return {
      poseSequence: {
        schemaVersion: 1,
        format: 'pickle.pose-sequence.v1',
        uri: 'file:///private/var/mobile/Containers/Data/Application/APP/Library/Application%20Support/PickleSensei/Captures/import-adv.pose.json',
        frameCount: framesWithPose,
        sha256: 'cd'.repeat(32),
        coordinateSystem: 'normalized_image_top_left',
        poseModelVersion: 'apple-vision-bodypose-1',
      },
      framesWithPose,
      framesTotal,
    };
  }

  it('accepts framesTotal === MAX_IMPORTED_POSE_FRAMES (Swift guard is <=) and rejects one past it', () => {
    expect(
      assertImportedPoseExtraction(
        receipt(MAX_IMPORTED_POSE_FRAMES, MAX_IMPORTED_POSE_FRAMES),
      ).framesTotal,
    ).toBe(MAX_IMPORTED_POSE_FRAMES);
    expect(() =>
      assertImportedPoseExtraction(
        receipt(MAX_IMPORTED_POSE_FRAMES, MAX_IMPORTED_POSE_FRAMES + 1),
      ),
    ).toThrow();
  });

  it('rejects a receipt whose sidecar frameCount disagrees with framesWithPose or that has zero poses', () => {
    const drift = receipt(120, 130);
    drift.poseSequence.frameCount = 121;
    expect(() => assertImportedPoseExtraction(drift)).toThrow();
    expect(() => assertImportedPoseExtraction(receipt(0, 130))).toThrow();
    expect(() => assertImportedPoseExtraction(receipt(131, 130))).toThrow();
  });

  it('forwards the seed only when supplied and never forwards a seed on the frame edge outside [0,1]', async () => {
    mockBridge.extractImportedPoseSequence.mockResolvedValue(receipt(10, 12));
    await extractImportedPoseSequence(importedClip, { x: 0, y: 1 });
    expect(mockBridge.extractImportedPoseSequence).toHaveBeenLastCalledWith(
      expect.objectContaining({ seedX: 0, seedY: 1, uri: importedClip.uri }),
    );
    mockBridge.extractImportedPoseSequence.mockClear();
    await expect(
      extractImportedPoseSequence(importedClip, { x: 1.0000001, y: 0.5 }),
    ).rejects.toThrow(/normalized point/);
    await expect(
      extractImportedPoseSequence(importedClip, { x: Number.NaN, y: 0.5 }),
    ).rejects.toThrow(/normalized point/);
    await expect(
      extractImportedPoseSequence(importedClip, { x: -0, y: -0.0001 }),
    ).rejects.toThrow(/normalized point/);
    expect(mockBridge.extractImportedPoseSequence).not.toHaveBeenCalled();
  });

  it('native pose-extraction failure codes survive the operation wrapper and release the lock', async () => {
    for (const code of [
      'camera.import_too_long',
      'camera.import_no_person',
      'camera.import_resource_limit',
      'camera.import_pose_failed',
      'camera.import_timeout',
      'camera.import_low_storage',
    ]) {
      mockBridge.extractImportedPoseSequence.mockRejectedValueOnce(
        nativeError(code),
      );
      await expect(
        extractImportedPoseSequence(importedClip, null),
      ).rejects.toMatchObject({ code });
    }
    mockBridge.extractImportedPoseSequence.mockResolvedValueOnce(receipt(3, 4));
    await expect(
      extractImportedPoseSequence(importedClip, null),
    ).resolves.toMatchObject({ framesWithPose: 3, framesTotal: 4 });
  });
});

describe('ATTACK B5 — byte comparison echo strictness against a hostile native', () => {
  const clip = importedPayload();

  it('treats an echo with an extra key, a stale operation id, or a foreign receipt as invalid — never as verified', async () => {
    const outcomes: string[] = [];
    const mutations: Array<[string, (echo: Record<string, unknown>) => void]> =
      [
        [
          'extra key emittedAtIso',
          echo => (echo.emittedAtIso = '2026-09-08T10:00:00.000Z'),
        ],
        ['stale operationId', echo => (echo.operationId = 'previous-op')],
        [
          'foreign receiptId',
          echo => (echo.receiptId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
        ],
        [
          'expectedByteSize as string',
          echo => (echo.expectedByteSize = String(identity.byteSize)),
        ],
        ['status: "verified"', echo => (echo.status = 'verified')],
        ['status: true', echo => (echo.status = true)],
        [
          'array echo',
          echo => {
            for (const key of Object.keys(echo)) delete echo[key];
          },
        ],
      ];
    for (const [label, mutate] of mutations) {
      mockBridge.compareCapturedClipBytes.mockImplementationOnce(
        async (request: { operationId: string }) => {
          const echo: Record<string, unknown> = comparisonEcho(
            request.operationId,
          );
          mutate(echo);
          return Object.keys(echo).length === 0 ? [] : echo;
        },
      );
      const result = await verifyCapturedClipCurrentBytes(
        clip,
        captureDataOwnerContext(),
      );
      outcomes.push(`${label} => ${result.status}`);
    }
    expect(outcomes).toEqual(mutations.map(([label]) => `${label} => invalid`));
  });

  it('a default (caller-less) operation id satisfies the Swift request regex and the echo round-trips as verified', async () => {
    mockBridge.compareCapturedClipBytes.mockImplementationOnce(
      async (request: { operationId: string; byteSize: number }) =>
        comparisonEcho(request.operationId),
    );
    const result = await verifyCapturedClipCurrentBytes(
      clip,
      captureDataOwnerContext(),
    );
    expect(result.status).toBe('verified-current-bytes');
    const request = mockBridge.compareCapturedClipBytes.mock.calls[0]![0] as {
      operationId: string;
      byteSize: number;
      nativeMediaIdentity: unknown;
      uri: string;
    };
    expect(request.operationId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(Object.keys(request).sort()).toEqual(
      ['byteSize', 'nativeMediaIdentity', 'operationId', 'uri'].sort(),
    );
    expect(request.byteSize).toBe(identity.byteSize);
    expect(request.nativeMediaIdentity).toEqual(identity);
  });

  it('native byte_comparison_unavailable and invalid_byte_comparison_request map to distinct honest statuses', async () => {
    mockBridge.compareCapturedClipBytes.mockRejectedValueOnce(
      nativeError('camera.byte_comparison_unavailable'),
    );
    await expect(
      verifyCapturedClipCurrentBytes(clip, captureDataOwnerContext()),
    ).resolves.toEqual({ status: 'unavailable' });
    mockBridge.compareCapturedClipBytes.mockRejectedValueOnce(
      nativeError('camera.invalid_byte_comparison_request'),
    );
    await expect(
      verifyCapturedClipCurrentBytes(clip, captureDataOwnerContext()),
    ).resolves.toEqual({ status: 'invalid' });
    mockBridge.compareCapturedClipBytes.mockResolvedValueOnce(undefined);
    await expect(
      verifyCapturedClipCurrentBytes(clip, captureDataOwnerContext()),
    ).resolves.toEqual({ status: 'invalid' });
  });

  it('account switch mid-comparison yields cancelled even when native answers verified for the old owner', async () => {
    const pending = deferred();
    mockBridge.compareCapturedClipBytes.mockImplementationOnce(
      async () => pending.promise,
    );
    const context = captureDataOwnerContext();
    const result = verifyCapturedClipCurrentBytes(clip, context, {
      operationId: 'adv-compare-switch',
    });
    await drain();
    setActiveDataOwner('22222222-2222-4222-8222-222222222222');
    pending.resolve(comparisonEcho('adv-compare-switch'));
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });
});
