/**
 * ADVERSARY (INT-import-media-capture): import bridge lifecycle — cancelled
 * import followed by a LATE native failure, foreign media locations, and
 * extraction receipts that are not bound to the clip they were requested for.
 *
 * Uses the same simulated PickleVideoCapture bridge as the frozen contract
 * tests. Honest outcomes: a cancelled import settles exactly once as
 * camera.cancelled and releases its drain barrier when native finally
 * settles (even with a failure); a clip pointing at the Photos library
 * instead of a private copy is not accepted as an imported capture; a
 * sidecar receipt for another clip is not attached to this one.
 */
jest.mock('react-native', () => {
  const bridge: Record<string, unknown> = {
    capture: jest.fn(),
    importVideo: jest.fn(),
    cancel: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    extractImportedPoseSequence: jest.fn(),
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
  extractImportedPoseSequence,
  importStrokeVideo,
  type CapturedClip,
} from '../../src/camera/capture';

const importedClipPayload = {
  uri: 'file:///private/var/mobile/Containers/Data/Application/APP/Library/Application%20Support/PickleSensei/Captures/import-abc.mov',
  durationMs: 4200,
  fps: 30,
  width: 1920,
  height: 1080,
  capturedAtIso: '2026-08-29T18:00:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
};

function deferredNative<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function nativeError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => {
  mockBridge.extractImportedPoseSequence = jest.fn();
  mockBridge.capture = jest.fn();
  mockBridge.importVideo = jest.fn();
  mockBridge.cancel = jest.fn();
});

describe('ADV import bridge lifecycle', () => {
  it('ATTACK F1: user cancels the picker, native later fails with import_too_long -> caller sees ONLY camera.cancelled and the next import can start', async () => {
    const first = deferredNative();
    mockBridge.importVideo!.mockReturnValueOnce(first.promise);
    const controller = new AbortController();
    const run = importStrokeVideo({
      operationId: 'picker-late-failure',
      signal: controller.signal,
    });
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });
    expect(mockBridge.cancel).toHaveBeenCalledTimes(1);

    // Native settles late — with a FAILURE, not a result.
    first.reject(
      nativeError(
        'camera.import_too_long',
        'Trim this video to 60 seconds or less.',
      ),
    );
    await flush();
    await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });

    // The drain barrier must be released by the late failure too.
    mockBridge.importVideo!.mockResolvedValueOnce(importedClipPayload);
    const next = await importStrokeVideo({ operationId: 'picker-next' });
    expect(next.captureMode).toBe('imported_video');
    expect(mockBridge.importVideo).toHaveBeenCalledTimes(2);
  });

  it('ATTACK F2: native import returns a GUIDED-mode clip through the import path -> refused', async () => {
    mockBridge.importVideo!.mockResolvedValueOnce({
      ...importedClipPayload,
      captureMode: 'automatic_pose_trigger',
      trigger: {
        source: 'pose-motion',
        startMs: 0,
        endMs: 4200,
        confidence: 0.9,
      },
    });
    await expect(
      importStrokeVideo({ operationId: 'guided-as-import' }),
    ).rejects.toThrow();
  });

  it('ATTACK F3: native import returns the ORIGINAL Photos-library path instead of a private copy -> refused', async () => {
    // Without a private copy the movie can vanish from under the saved capture
    // the moment the user deletes it from Photos (missing media at replay).
    mockBridge.importVideo!.mockResolvedValueOnce({
      ...importedClipPayload,
      uri: 'file:///var/mobile/Media/DCIM/100APPLE/img_0001.mov',
    });
    await expect(
      importStrokeVideo({ operationId: 'photos-path' }),
    ).rejects.toThrow();
  });

  it('ATTACK F4: extraction receipt names a sidecar belonging to a DIFFERENT clip -> not attached to this clip', async () => {
    const clip = assertCapturedClip(
      importedClipPayload,
      'imported_video',
    ) as Extract<CapturedClip, { captureMode: 'imported_video' }>;
    mockBridge.extractImportedPoseSequence!.mockResolvedValueOnce({
      poseSequence: {
        schemaVersion: 1,
        format: 'pickle.pose-sequence.v1',
        uri: 'file:///private/var/mobile/Containers/Data/Application/APP/Library/Application%20Support/PickleSensei/Captures/import-OTHER-pose-1.pose.json',
        frameCount: 126,
        sha256: 'ab'.repeat(32),
        coordinateSystem: 'normalized_image_top_left',
        poseModelVersion: 'apple-vision-bodypose-1',
      },
      framesWithPose: 126,
      framesTotal: 126,
    });
    await expect(
      extractImportedPoseSequence(clip, null, {
        operationId: 'foreign-sidecar',
      }),
    ).rejects.toThrow();
  });

  it('ATTACK F5: extraction receipt claims a poster OUTSIDE the private captures directory -> refused', async () => {
    const clip = assertCapturedClip(
      importedClipPayload,
      'imported_video',
    ) as Extract<CapturedClip, { captureMode: 'imported_video' }>;
    mockBridge.extractImportedPoseSequence!.mockResolvedValueOnce({
      poseSequence: {
        schemaVersion: 1,
        format: 'pickle.pose-sequence.v1',
        uri: 'file:///private/var/mobile/Containers/Data/Application/APP/Library/Application%20Support/PickleSensei/Captures/import-abc-pose-1.pose.json',
        frameCount: 126,
        sha256: 'ab'.repeat(32),
        coordinateSystem: 'normalized_image_top_left',
        poseModelVersion: 'apple-vision-bodypose-1',
      },
      posterUri: 'file:///var/mobile/Media/DCIM/100APPLE/img_0001.jpg',
      framesWithPose: 126,
      framesTotal: 126,
    });
    await expect(
      extractImportedPoseSequence(clip, null, {
        operationId: 'foreign-poster',
      }),
    ).rejects.toThrow();
  });

  it('ATTACK F6: a permission-denied import rejection keeps its code and a real message for the error surface', async () => {
    mockBridge.importVideo!.mockRejectedValueOnce(
      nativeError(
        'camera.permission_denied',
        'Allow photo library access in Settings.',
      ),
    );
    await expect(
      importStrokeVideo({ operationId: 'no-permission' }),
    ).rejects.toMatchObject({
      code: 'camera.permission_denied',
      message: expect.stringMatching(/\S/),
    });
    expect(mockBridge.cancel).not.toHaveBeenCalled();
  });
});
