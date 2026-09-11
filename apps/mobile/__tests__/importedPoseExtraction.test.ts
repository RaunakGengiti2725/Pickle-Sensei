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
  cancelCameraOperation,
  captureStrokeVideo,
  extractImportedPoseSequence,
  importedPoseExtractionAvailable,
  importStrokeVideo,
  MAX_IMPORTED_POSE_FRAMES,
  type CapturedClip,
  type NativeImportOptions,
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
  mockBridge.capture = jest.fn();
  mockBridge.importVideo = jest.fn();
  mockBridge.cancel = jest.fn();
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
      operationId: expect.any(String),
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
      operationId: expect.any(String),
      uri: importedClip.uri,
    });
  });

  it('refuses a seed outside the normalized frame instead of sending it', async () => {
    await expect(
      extractImportedPoseSequence(importedClip, { x: 1.4, y: 0.5 }),
    ).rejects.toThrow(/normalized point/i);
    expect(mockBridge.extractImportedPoseSequence).not.toHaveBeenCalled();
  });

  it.each([
    { durationMs: 0 },
    { uri: 'https://example.test/video.mov' },
    { fps: Number.NaN },
    { width: -1 },
    { captureMode: 'automatic_pose_trigger' },
  ])('rejects an invalid clip before any native work: %s', async override => {
    await expect(
      extractImportedPoseSequence({
        ...importedClip,
        ...override,
      } as typeof importedClip),
    ).rejects.toThrow(/invalid or incomplete/i);
    expect(mockBridge.extractImportedPoseSequence).not.toHaveBeenCalled();
  });

  it('preserves a relocated container URI for the native managed-file resolver', async () => {
    const uri =
      'file:///old-container/Library/Application%20Support/PickleSensei/Captures/import-123.mov';
    mockBridge.extractImportedPoseSequence!.mockResolvedValue(
      validExtractionPayload(),
    );
    await extractImportedPoseSequence({ ...importedClip, uri }, null, {
      operationId: 'relocated-retry',
    });
    expect(mockBridge.extractImportedPoseSequence).toHaveBeenCalledWith({
      uri,
      operationId: 'relocated-retry',
    });
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
      new Error('Imported videos longer than 60 seconds are not supported.'),
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

function deferredNative() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushNativeCompletion() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('native import cancellation interface', () => {
  it('ignores old guided cancellation and its abort signal while a later import owns native work', async () => {
    const guidedResult = deferredNative();
    const oldController = new AbortController();
    mockBridge.capture!.mockReturnValue(guidedResult.promise);
    const guided = captureStrokeVideo({
      operationId: 'guided-before-import',
      signal: oldController.signal,
    });
    void guided.catch(() => {});
    cancelCameraOperation('guided-before-import');
    guidedResult.reject(
      Object.assign(new Error('Native cancelled'), {
        code: 'camera.cancelled',
      }),
    );
    await expect(guided).rejects.toMatchObject({ code: 'camera.cancelled' });
    const nativeResult = deferredNative();
    mockBridge.importVideo!.mockReturnValue(nativeResult.promise);
    const run = importStrokeVideo({ operationId: 'import-after-guided' });
    void run.catch(() => {});
    const callsBeforeOldCancellation = mockBridge.cancel!.mock.calls.length;
    let callsAfterOldCancellation = -1;
    try {
      cancelCameraOperation('guided-before-import');
      oldController.abort();
      callsAfterOldCancellation = mockBridge.cancel!.mock.calls.length;
      cancelCameraOperation('import-after-guided');
    } finally {
      nativeResult.resolve(importedClipPayload);
      await flushNativeCompletion();
    }
    expect(callsBeforeOldCancellation).toBe(1);
    expect(callsAfterOldCancellation).toBe(callsBeforeOldCancellation);
    expect(mockBridge.cancel).toHaveBeenCalledTimes(2);
    await expect(run).rejects.toMatchObject({
      code: 'camera.cancelled',
      message: 'Camera operation was canceled.',
    });
  });

  it('ignores old import cancellation and its abort signal while a later guided attempt owns native work', async () => {
    const oldController = new AbortController();
    mockBridge.importVideo!.mockResolvedValue(importedClipPayload);
    await importStrokeVideo({
      operationId: 'import-before-guided',
      signal: oldController.signal,
    });
    const nativeResult = deferredNative();
    const controller = new AbortController();
    mockBridge.capture!.mockReturnValue(nativeResult.promise);
    const run = captureStrokeVideo({
      operationId: 'guided-after-import',
      signal: controller.signal,
    });
    void run.catch(() => {});
    let staleCancelCalls = -1;
    try {
      cancelCameraOperation('import-before-guided');
      oldController.abort();
      staleCancelCalls = mockBridge.cancel!.mock.calls.length;
      controller.abort();
    } finally {
      nativeResult.reject(
        Object.assign(new Error('Native cancelled'), {
          code: 'camera.cancelled',
        }),
      );
      await flushNativeCompletion();
    }
    expect(staleCancelCalls).toBe(0);
    expect(mockBridge.cancel).toHaveBeenCalledTimes(1);
    await expect(run).rejects.toMatchObject({
      code: 'camera.cancelled',
      message: 'Camera operation was canceled.',
    });
  });

  it('keeps the picker and cancel argument shapes compatible with the exported native bridge', async () => {
    const nativeResult = deferredNative();
    mockBridge.importVideo!.mockReturnValue(nativeResult.promise);
    const run = importStrokeVideo({ operationId: 'logical-picker-attempt' });
    expect(mockBridge.importVideo).toHaveBeenCalledWith();
    cancelCameraOperation('logical-picker-attempt');
    await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });
    expect(mockBridge.cancel).toHaveBeenCalledWith();
    nativeResult.reject(
      Object.assign(new Error('Cancelled'), { code: 'camera.cancelled' }),
    );
    await flushNativeCompletion();
  });

  it('rejects overlapping import and guided requests without canceling someone else’s camera', async () => {
    const nativeResult = deferredNative();
    mockBridge.capture!.mockReturnValue(nativeResult.promise);
    const guided = captureStrokeVideo();
    await expect(importStrokeVideo()).rejects.toMatchObject({
      code: 'camera.busy',
    });
    await expect(
      extractImportedPoseSequence(importedClip),
    ).rejects.toMatchObject({ code: 'camera.busy' });
    cancelCameraOperation('not-this-guided-capture');
    expect(mockBridge.importVideo).not.toHaveBeenCalled();
    expect(mockBridge.extractImportedPoseSequence).not.toHaveBeenCalled();
    expect(mockBridge.cancel).not.toHaveBeenCalled();
    nativeResult.reject(
      Object.assign(new Error('Cancelled'), { code: 'camera.cancelled' }),
    );
    await expect(guided).rejects.toMatchObject({ code: 'camera.cancelled' });
    mockBridge.importVideo!.mockResolvedValue(importedClipPayload);
    await expect(importStrokeVideo()).resolves.toMatchObject({
      captureMode: 'imported_video',
    });
  });

  it('does not extract imported poses while a canceled guided capture is still draining', async () => {
    const nativeResult = deferredNative();
    mockBridge.capture!.mockReturnValue(nativeResult.promise);
    const run = captureStrokeVideo({ operationId: 'guided-before-extraction' });
    void run.catch(() => {});
    cancelCameraOperation('guided-before-extraction');
    try {
      await expect(
        extractImportedPoseSequence(importedClip),
      ).rejects.toMatchObject({ code: 'camera.busy' });
      expect(mockBridge.extractImportedPoseSequence).not.toHaveBeenCalled();
    } finally {
      nativeResult.reject(
        Object.assign(new Error('Native cancelled'), {
          code: 'camera.cancelled',
        }),
      );
      await flushNativeCompletion();
    }
    await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });
    mockBridge.extractImportedPoseSequence!.mockResolvedValue(
      validExtractionPayload(),
    );
    await expect(
      extractImportedPoseSequence(importedClip),
    ).resolves.toMatchObject({ framesTotal: 126 });
  });

  it('does not open guided capture while an abandoned import is still draining', async () => {
    const nativeResult = deferredNative();
    mockBridge.extractImportedPoseSequence!.mockReturnValue(
      nativeResult.promise,
    );
    const run = extractImportedPoseSequence(importedClip);
    cancelCameraOperation();
    await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });
    await expect(captureStrokeVideo()).rejects.toMatchObject({
      code: 'camera.busy',
    });
    expect(mockBridge.capture).not.toHaveBeenCalled();
    nativeResult.resolve(validExtractionPayload());
    await flushNativeCompletion();
  });

  it('does not treat an empty foreign id as an unscoped cancellation', async () => {
    const nativeResult = deferredNative();
    mockBridge.extractImportedPoseSequence!.mockReturnValue(
      nativeResult.promise,
    );
    const run = extractImportedPoseSequence(importedClip);
    cancelCameraOperation('');
    expect(mockBridge.cancel).not.toHaveBeenCalled();
    nativeResult.resolve(validExtractionPayload());
    await expect(run).resolves.toMatchObject({ framesTotal: 126 });
  });

  it('handles an abort during listener registration without starting or canceling native work', async () => {
    const signal = {
      aborted: false,
      addEventListener: jest.fn((_type, listener) => {
        signal.aborted = true;
        listener();
      }),
      removeEventListener: jest.fn(),
    };
    await expect(
      importStrokeVideo({ signal: signal as unknown as AbortSignal }),
    ).rejects.toMatchObject({ code: 'camera.cancelled' });
    expect(mockBridge.importVideo).not.toHaveBeenCalled();
    expect(mockBridge.cancel).not.toHaveBeenCalled();
    mockBridge.importVideo!.mockResolvedValue(importedClipPayload);
    await expect(importStrokeVideo()).resolves.toMatchObject({
      captureMode: 'imported_video',
    });
  });

  it('settles synchronous native errors and detaches the original signal even if options mutate', async () => {
    const controller = new AbortController();
    const options: NativeImportOptions = { signal: controller.signal };
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    mockBridge.importVideo!.mockImplementation(() => {
      options.signal = new AbortController().signal;
      throw new Error('Bridge unavailable');
    });
    await expect(importStrokeVideo(options)).rejects.toThrow(
      'Bridge unavailable',
    );
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(mockBridge.cancel).not.toHaveBeenCalled();
    mockBridge.importVideo!.mockResolvedValue(importedClipPayload);
    await expect(importStrokeVideo()).resolves.toMatchObject({
      captureMode: 'imported_video',
    });
  });

  it('still rejects cancellation if the native cancel bridge throws, while retaining the drain barrier', async () => {
    const nativeResult = deferredNative();
    mockBridge.extractImportedPoseSequence!.mockReturnValue(
      nativeResult.promise,
    );
    mockBridge.cancel!.mockImplementation(() => {
      throw new Error('Bridge unavailable');
    });
    const run = extractImportedPoseSequence(importedClip);
    expect(() => cancelCameraOperation()).not.toThrow();
    await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });
    await expect(importStrokeVideo()).rejects.toMatchObject({
      code: 'camera.busy',
    });
    nativeResult.reject(new Error('Decoder stopped'));
    await flushNativeCompletion();
    mockBridge.importVideo!.mockResolvedValue(importedClipPayload);
    await expect(importStrokeVideo()).resolves.toMatchObject({
      captureMode: 'imported_video',
    });
  });

  it.each([
    'camera.import_timeout',
    'camera.import_low_storage',
    'camera.import_resource_limit',
    'camera.invalid_media',
  ])(
    'preserves %s and permits a subsequent attempt after native settles',
    async code => {
      mockBridge.importVideo!.mockRejectedValue(
        Object.assign(new Error('Import refused'), { code }),
      );
      await expect(importStrokeVideo()).rejects.toMatchObject({ code });
      mockBridge.extractImportedPoseSequence!.mockResolvedValue(
        validExtractionPayload(),
      );
      await expect(
        extractImportedPoseSequence(importedClip),
      ).resolves.toMatchObject({ framesTotal: 126 });
    },
  );

  it('forwards an explicit extraction operation id', async () => {
    mockBridge.extractImportedPoseSequence!.mockResolvedValue(
      validExtractionPayload(),
    );
    await extractImportedPoseSequence(importedClip, null, {
      operationId: 'owned-run-1',
    });
    expect(mockBridge.extractImportedPoseSequence).toHaveBeenCalledWith({
      uri: importedClip.uri,
      operationId: 'owned-run-1',
    });
  });

  it('creates distinct extraction ids when the caller does not provide one', async () => {
    mockBridge.extractImportedPoseSequence!.mockResolvedValue(
      validExtractionPayload(),
    );
    await extractImportedPoseSequence(importedClip);
    await extractImportedPoseSequence(importedClip);
    const ids = mockBridge.extractImportedPoseSequence!.mock.calls.map(
      ([request]) => request.operationId,
    );
    expect(ids[0]).toEqual(expect.any(String));
    expect(ids[0]).not.toEqual(ids[1]);
  });

  it.each([
    '',
    '../escape',
    'x'.repeat(129),
    'run\n',
    'run\r',
    'run with spaces',
  ])(
    'rejects invalid operation id %s before native work',
    async operationId => {
      await expect(
        extractImportedPoseSequence(importedClip, null, { operationId }),
      ).rejects.toThrow(/operation id/i);
      expect(mockBridge.extractImportedPoseSequence).not.toHaveBeenCalled();
    },
  );

  it('does not start an already-aborted extraction or picker', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractImportedPoseSequence(importedClip, null, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'camera.cancelled' });
    await expect(
      importStrokeVideo({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'camera.cancelled' });
    expect(mockBridge.extractImportedPoseSequence).not.toHaveBeenCalled();
    expect(mockBridge.importVideo).not.toHaveBeenCalled();
    expect(mockBridge.cancel).not.toHaveBeenCalled();
  });

  it('cancels extraction promptly, suppresses late success, and does not abandon a concurrent native job', async () => {
    const nativeResult = deferredNative();
    mockBridge.extractImportedPoseSequence!.mockReturnValue(
      nativeResult.promise,
    );
    const controller = new AbortController();
    const published = jest.fn();
    const run = extractImportedPoseSequence(importedClip, null, {
      signal: controller.signal,
    });
    void run.then(published, () => {});
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });
    expect(mockBridge.cancel).toHaveBeenCalledTimes(1);
    await expect(
      extractImportedPoseSequence(importedClip),
    ).rejects.toMatchObject({ code: 'camera.busy' });
    await expect(importStrokeVideo()).rejects.toMatchObject({
      code: 'camera.busy',
    });
    expect(mockBridge.extractImportedPoseSequence).toHaveBeenCalledTimes(1);
    expect(mockBridge.importVideo).not.toHaveBeenCalled();
    nativeResult.resolve(validExtractionPayload());
    await flushNativeCompletion();
    expect(published).not.toHaveBeenCalled();
    mockBridge.extractImportedPoseSequence!.mockResolvedValue(
      validExtractionPayload(),
    );
    await expect(
      extractImportedPoseSequence(importedClip),
    ).resolves.toMatchObject({ framesTotal: 126 });
  });

  it('cancels a pending picker and never returns its late capture', async () => {
    const nativeResult = deferredNative();
    mockBridge.importVideo!.mockReturnValue(nativeResult.promise);
    const controller = new AbortController();
    const run = importStrokeVideo({
      operationId: 'picker-1',
      signal: controller.signal,
    });
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });
    expect(mockBridge.cancel).toHaveBeenCalledTimes(1);
    nativeResult.resolve(importedClipPayload);
    await flushNativeCompletion();
    await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });
  });

  it('ignores cancellation of an old id while a different extraction is active', async () => {
    mockBridge.extractImportedPoseSequence!.mockResolvedValue(
      validExtractionPayload(),
    );
    await extractImportedPoseSequence(importedClip, null, {
      operationId: 'run-A',
    });
    const nativeResult = deferredNative();
    mockBridge.extractImportedPoseSequence!.mockReturnValue(
      nativeResult.promise,
    );
    const run = extractImportedPoseSequence(importedClip, null, {
      operationId: 'run-B',
    });
    cancelCameraOperation('run-A');
    expect(mockBridge.cancel).not.toHaveBeenCalled();
    cancelCameraOperation('run-B');
    await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });
    expect(mockBridge.cancel).toHaveBeenCalledTimes(1);
    nativeResult.reject(
      Object.assign(new Error('Cancelled'), { code: 'camera.cancelled' }),
    );
    await flushNativeCompletion();
  });

  it('detaches an old abort signal before a later extraction starts', async () => {
    const controller = new AbortController();
    mockBridge.extractImportedPoseSequence!.mockResolvedValue(
      validExtractionPayload(),
    );
    await extractImportedPoseSequence(importedClip, null, {
      signal: controller.signal,
    });
    const nativeResult = deferredNative();
    mockBridge.extractImportedPoseSequence!.mockReturnValue(
      nativeResult.promise,
    );
    const run = extractImportedPoseSequence(importedClip);
    controller.abort();
    expect(mockBridge.cancel).not.toHaveBeenCalled();
    nativeResult.resolve(validExtractionPayload());
    await expect(run).resolves.toMatchObject({ framesTotal: 126 });
  });
});

describe('assertImportedPoseExtraction (receipt validation)', () => {
  it('accepts the exact frozen-contract payload', () => {
    expect(() =>
      assertImportedPoseExtraction(validExtractionPayload()),
    ).not.toThrow();
  });

  it('accepts real no-person gaps and the provisional analyzed-frame boundary', () => {
    expect(
      assertImportedPoseExtraction({
        ...validExtractionPayload(),
        framesTotal: MAX_IMPORTED_POSE_FRAMES,
      }).framesWithPose,
    ).toBe(126);
    expect(
      assertImportedPoseExtraction({
        ...validExtractionPayload(),
        poseSequence: {
          ...validPoseSequence,
          frameCount: MAX_IMPORTED_POSE_FRAMES,
        },
        framesWithPose: MAX_IMPORTED_POSE_FRAMES,
        framesTotal: MAX_IMPORTED_POSE_FRAMES,
      }).framesTotal,
    ).toBe(MAX_IMPORTED_POSE_FRAMES);
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
    ['a sidecar-count mismatch', { framesWithPose: 125 }],
    [
      'an analyzed-frame budget overflow',
      { framesTotal: MAX_IMPORTED_POSE_FRAMES + 1 },
    ],
    ['a non-finite frame total', { framesTotal: Number.POSITIVE_INFINITY }],
    ['a fractional pose count', { framesWithPose: 125.5 }],
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
    expect(clip.posterUri).toBe('file:///private/var/mobile/import.poster.jpg');
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
