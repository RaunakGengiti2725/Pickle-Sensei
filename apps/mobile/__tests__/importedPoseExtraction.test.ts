/**
 * Imported-video pose extraction — the typed JS boundary over the native
 * `extractImportedPoseSequence` bridge method (frozen contract):
 *  - availability is a real method check, never assumed;
 *  - the request carries the clip uri and the SOURCE-normalized tap seed
 *    verbatim (or no seed at all when the user skipped);
 *  - the receipt is validated field-by-field with assertCapturedClip-grade
 *    strictness — an invalid payload is rejected, never repaired;
 *  - native rejection codes (camera.import_too_long / import_no_person)
 *    pass through untouched so the screen can map them to honest copy;
 *  - the CapturedClip contract accepts the new optional posterUri and an
 *    imported clip whose poseSequence is the validated extraction sidecar.
 */
// Only the names capture.ts imports — spreading the real RN index would pull
// TurboModule getters that jest cannot satisfy (sessionNative.test.ts
// pattern). The simulated bridge lives inside the factory and is re-exported
// for the tests to drive.
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
  assertImportedPoseExtraction,
  extractImportedPoseSequence,
  importedPoseExtractionAvailable,
  type CapturedClip,
} from '../src/camera/capture';

const importedClipPayload = {
  uri: 'file:///private/var/mobile/import.mov',
  durationMs: 4200,
  fps: 30,
  width: 1920,
  height: 1080,
  capturedAtIso: '2026-08-29T18:00:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
};

const importedClip = assertCapturedClip(
  importedClipPayload,
  'imported_video',
) as Extract<CapturedClip, { captureMode: 'imported_video' }>;

const validPoseSequence = {
  schemaVersion: 1,
  format: 'pickle.pose-sequence.v1',
  uri: 'file:///private/var/mobile/import.pose.json',
  frameCount: 126,
  sha256: 'ab'.repeat(32),
  coordinateSystem: 'normalized_image_top_left',
  poseModelVersion: 'apple-vision-bodypose-1',
};

function validExtractionPayload(): Record<string, unknown> {
  return {
    poseSequence: { ...validPoseSequence },
    posterUri: 'file:///private/var/mobile/import.poster.jpg',
    framesWithPose: 126,
    framesTotal: 126,
  };
}

beforeEach(() => {
  mockBridge.extractImportedPoseSequence = jest.fn();
});

describe('importedPoseExtractionAvailable', () => {
  it('is true only while the native bridge actually exposes the method', () => {
    expect(importedPoseExtractionAvailable()).toBe(true);
    delete mockBridge.extractImportedPoseSequence;
    expect(importedPoseExtractionAvailable()).toBe(false);
  });
});

describe('extractImportedPoseSequence', () => {
  it('sends the clip uri plus the source-normalized seed verbatim', async () => {
    mockBridge.extractImportedPoseSequence!.mockResolvedValue(
      validExtractionPayload(),
    );
    const result = await extractImportedPoseSequence(importedClip, {
      x: 0.42,
      y: 0.63,
    });
    expect(mockBridge.extractImportedPoseSequence).toHaveBeenCalledWith({
      uri: importedClip.uri,
      seedX: 0.42,
      seedY: 0.63,
    });
    expect(result.poseSequence).toEqual(validPoseSequence);
    expect(result.posterUri).toBe(
      'file:///private/var/mobile/import.poster.jpg',
    );
    expect(result.framesWithPose).toBe(126);
    expect(result.framesTotal).toBe(126);
  });

  it('omits the seed entirely when the user skipped the tap', async () => {
    mockBridge.extractImportedPoseSequence!.mockResolvedValue(
      validExtractionPayload(),
    );
    await extractImportedPoseSequence(importedClip, null);
    expect(mockBridge.extractImportedPoseSequence).toHaveBeenCalledWith({
      uri: importedClip.uri,
    });
  });

  it('refuses a seed outside the normalized frame instead of sending it', async () => {
    await expect(
      extractImportedPoseSequence(importedClip, { x: 1.4, y: 0.5 }),
    ).rejects.toThrow(/normalized point/i);
    expect(mockBridge.extractImportedPoseSequence).not.toHaveBeenCalled();
  });

  it('accepts a payload without a poster (posterUri stays absent)', async () => {
    const payload = validExtractionPayload();
    delete payload.posterUri;
    mockBridge.extractImportedPoseSequence!.mockResolvedValue(payload);
    const result = await extractImportedPoseSequence(importedClip, null);
    expect(result.posterUri).toBeUndefined();
  });

  it('passes native rejections through with their contract codes intact', async () => {
    const tooLong = Object.assign(
      new Error('Imported videos longer than 30 seconds are not supported.'),
      { code: 'camera.import_too_long' },
    );
    mockBridge.extractImportedPoseSequence!.mockRejectedValue(tooLong);
    await expect(
      extractImportedPoseSequence(importedClip, null),
    ).rejects.toMatchObject({ code: 'camera.import_too_long' });
  });

  it('throws an honest unavailability error when the bridge method is missing', async () => {
    delete mockBridge.extractImportedPoseSequence;
    await expect(extractImportedPoseSequence(importedClip)).rejects.toThrow(
      /not available/i,
    );
  });
});

describe('assertImportedPoseExtraction (receipt validation)', () => {
  it('accepts the exact frozen-contract payload', () => {
    expect(() =>
      assertImportedPoseExtraction(validExtractionPayload()),
    ).not.toThrow();
  });

  it.each([
    ['not a record', 'zzz'],
    ['missing poseSequence', { framesWithPose: 5, framesTotal: 5 }],
  ] as const)('rejects %s', (_label, payload) => {
    expect(() => assertImportedPoseExtraction(payload)).toThrow(
      /invalid pose-extraction/i,
    );
  });

  it.each([
    ['wrong schema version', { schemaVersion: 2 }],
    ['foreign format', { format: 'someone.elses-poses.v9' }],
    ['non-file sidecar uri', { uri: 'https://cdn.example.com/pose.json' }],
    ['zero frames', { frameCount: 0 }],
    ['fractional frame count', { frameCount: 3.5 }],
    ['short hash', { sha256: 'abc123' }],
    ['uppercase hash', { sha256: 'AB'.repeat(32) }],
    ['non-hex hash', { sha256: 'zz'.repeat(32) }],
    ['wrong coordinate system', { coordinateSystem: 'normalized_center' }],
    ['blank pose model version', { poseModelVersion: '   ' }],
  ] as const)('rejects a sidecar ref with %s', (_label, override) => {
    expect(() =>
      assertImportedPoseExtraction({
        ...validExtractionPayload(),
        poseSequence: { ...validPoseSequence, ...override },
      }),
    ).toThrow(/invalid pose-extraction/i);
  });

  it.each([
    ['a non-file poster uri', { posterUri: 'https://example.com/p.jpg' }],
    ['a non-string poster uri', { posterUri: 42 }],
    ['zero frames with pose', { framesWithPose: 0 }],
    ['negative frames with pose', { framesWithPose: -1 }],
    ['missing frame totals', { framesTotal: undefined }],
    ['more pose frames than frames', { framesWithPose: 200, framesTotal: 5 }],
  ] as const)('rejects a receipt with %s', (_label, override) => {
    expect(() =>
      assertImportedPoseExtraction({
        ...validExtractionPayload(),
        ...override,
      }),
    ).toThrow(/invalid pose-extraction/i);
  });
});

describe('CapturedClip contract additions', () => {
  it('accepts an imported clip carrying the new posterUri', () => {
    const clip = assertCapturedClip({
      ...importedClipPayload,
      posterUri: 'file:///private/var/mobile/import.poster.jpg',
    });
    expect(clip.posterUri).toBe(
      'file:///private/var/mobile/import.poster.jpg',
    );
  });

  it('rejects a posterUri that is not a private file: URI', () => {
    expect(() =>
      assertCapturedClip({
        ...importedClipPayload,
        posterUri: 'https://example.com/poster.jpg',
      }),
    ).toThrow(/invalid or incomplete/i);
    expect(() =>
      assertCapturedClip({ ...importedClipPayload, posterUri: 7 }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('accepts an imported clip whose poseSequence is a valid extraction sidecar', () => {
    const clip = assertCapturedClip({
      ...importedClipPayload,
      poseSequence: { ...validPoseSequence },
    });
    expect(clip.poseSequence).toEqual(validPoseSequence);
  });

  it('still rejects an imported clip with a malformed poseSequence', () => {
    expect(() =>
      assertCapturedClip({
        ...importedClipPayload,
        poseSequence: { ...validPoseSequence, sha256: 'not-a-hash' },
      }),
    ).toThrow(/invalid or incomplete/i);
  });

  it('accepts a guided clip carrying the new posterUri', () => {
    const trigger = {
      startMs: 2000,
      endMs: 2700,
      peakMotionMs: 2400,
      confidence: 0.82,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    };
    const clip = assertCapturedClip({
      uri: 'file:///private/var/mobile/clip.mov',
      durationMs: 4200,
      fps: 59.94,
      width: 720,
      height: 1280,
      capturedAtIso: '2026-08-27T18:00:00.000Z',
      posterUri: 'file:///private/var/mobile/clip.poster.jpg',
      captureMode: 'automatic_pose_trigger',
      recognition: {
        status: 'unknown',
        reason: 'validated_classifier_unavailable',
      },
      trigger,
      captureEvidence: {
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
            joint: 'left_wrist',
            sampleCount: 5,
            meanNormalizedPerSecond: 1.1,
            peakNormalizedPerSecond: 2.4,
          },
        ],
      },
      ballSpeed: {
        status: 'unavailable',
        reason: 'calibrated_ball_tracker_unavailable',
      },
      preRollMs: 2000,
      postRollMs: 1500,
    });
    expect(clip.posterUri).toBe('file:///private/var/mobile/clip.poster.jpg');
  });
});
