jest.mock('react-native', () => {
  const listeners = new Map<string, (mockEvent: unknown) => void>();
  return {
    Platform: { OS: 'ios', Version: '17.5' },
    NativeModules: {
      PickleMotion3D: {
        available: true,
        schemaVersion: 1,
        reconstruct: jest.fn(),
        cancel: jest.fn(),
        addListener: jest.fn(),
        removeListeners: jest.fn(),
      },
    },
    NativeEventEmitter: class {
      addListener(name: string, listener: (mockEvent: unknown) => void) {
        listeners.set(name, listener);
        return { remove: () => listeners.delete(name) };
      }
    },
    __listeners: listeners,
  };
});

import { DEFAULT_MODEL_MANIFEST } from '@pickle/model-registry';
import {
  NativeMotion3DReconstructor,
  motion3DNativeAvailable,
  nativeOSMajorVersion,
} from '../src/vision/motion3d';

const native = jest.requireMock('react-native') as {
  Platform: { OS: string; Version: string };
  NativeModules: {
    PickleMotion3D: {
      available: boolean;
      schemaVersion: number;
      reconstruct: jest.Mock;
      cancel: jest.Mock;
    };
  };
  __listeners: Map<string, (mockEvent: unknown) => void>;
};
const bridge = native.NativeModules.PickleMotion3D;
const entry = DEFAULT_MODEL_MANIFEST.entries.find(
  item => item.id === 'pose.apple-vision-3d',
)!;
const request = {
  captureId: 'capture-test',
  videoUri: 'file:///private/Captures/test.mov',
  runId: 'run-test',
};

beforeEach(() => {
  jest.clearAllMocks();
  native.Platform.OS = 'ios';
  native.Platform.Version = '17.5';
  bridge.available = true;
  bridge.schemaVersion = 1;
  bridge.reconstruct = jest
    .fn()
    .mockResolvedValue({ json: '{}', sha256: 'a'.repeat(64) });
  native.__listeners.clear();
});

afterEach(() => jest.useRealTimers());

it('checks actual native support, schema, platform and OS instead of guessing', () => {
  expect(motion3DNativeAvailable()).toBe(true);
  native.Platform.OS = 'android';
  expect(motion3DNativeAvailable()).toBe(false);
  native.Platform.OS = 'ios';
  native.Platform.Version = '16.6';
  expect(motion3DNativeAvailable()).toBe(false);
  native.Platform.Version = '17.5';
  bridge.available = false;
  expect(motion3DNativeAvailable()).toBe(false);
  bridge.available = true;
  bridge.schemaVersion = 2;
  expect(motion3DNativeAvailable()).toBe(false);
});

it.each(['unknown', '17beta', '', '-17', 'Infinity'])(
  'does not infer a supported OS from %s',
  version => {
    native.Platform.Version = version;
    expect(nativeOSMajorVersion()).toBe(0);
  },
);

it('sends only source identity to the genuine native extractor and returns untouched bytes', async () => {
  const provider = new NativeMotion3DReconstructor(entry);
  const outcome = await provider.reconstruct(request);
  expect(bridge.reconstruct).toHaveBeenCalledWith({
    uri: request.videoUri,
    captureId: request.captureId,
    runId: request.runId,
  });
  expect(outcome).toEqual({
    ok: true,
    value: { artifactJson: '{}', artifactSha256: 'a'.repeat(64) },
  });
  expect(native.__listeners.size).toBe(0);
});

it('routes progress only for this run and drops malformed events', async () => {
  let resolve!: (value: unknown) => void;
  bridge.reconstruct.mockReturnValue(
    new Promise(done => {
      resolve = done;
    }),
  );
  const onProgress = jest.fn();
  const promise = new NativeMotion3DReconstructor(entry).reconstruct({
    ...request,
    onProgress,
  });
  const emit = native.__listeners.get('PickleMotion3DProgress')!;
  emit({
    runId: 'other',
    processedFrames: 1,
    timestampMs: 10,
    durationMs: 100,
  });
  emit({
    runId: request.runId,
    processedFrames: 1,
    timestampMs: NaN,
    durationMs: 100,
  });
  expect(onProgress).not.toHaveBeenCalled();
  emit({
    runId: request.runId,
    processedFrames: 2,
    timestampMs: 50,
    durationMs: 100,
  });
  expect(onProgress).toHaveBeenCalledWith({
    processedFrames: 2,
    timestampMs: 50,
    durationMs: 100,
  });
  resolve({ json: '{}', sha256: 'a'.repeat(64) });
  await promise;
  expect(native.__listeners.size).toBe(0);
});

it.each([
  null,
  {},
  { json: 3, sha256: 'a'.repeat(64) },
  { json: '{}', sha256: 'invalid' },
])('refuses an invalid native receipt', async receipt => {
  bridge.reconstruct.mockResolvedValue(receipt);
  expect(
    (await new NativeMotion3DReconstructor(entry).reconstruct(request)).ok,
  ).toBe(false);
});

it('does not expose native exception details to the user', async () => {
  bridge.reconstruct.mockRejectedValue(
    new Error('/private/captures/person.mov internal error'),
  );
  const result = await new NativeMotion3DReconstructor(entry).reconstruct(
    request,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.message).not.toContain('/private');
  expect(native.__listeners.size).toBe(0);
});

it.each([
  'motion3d.exceeds_limits',
  'motion3d.invalid_source',
  'motion3d.decoding_failed',
  'motion3d.unavailable',
])('gives actionable, non-retryable guidance for %s', async code => {
  bridge.reconstruct.mockRejectedValue({
    code,
    message: '/private/internal-detail',
  });
  const result = await new NativeMotion3DReconstructor(entry).reconstruct(
    request,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.failure.code).toBe(code);
    expect(result.failure.retryable).toBe(false);
    expect(result.failure.message).not.toContain('/private');
    expect(result.failure.message).not.toContain('Try again.');
  }
});

it('cancels a stalled native job and releases its event listener', async () => {
  jest.useFakeTimers();
  bridge.reconstruct.mockReturnValue(new Promise(() => {}));
  const result = new NativeMotion3DReconstructor(entry).reconstruct(request);
  await jest.advanceTimersByTimeAsync(90_001);
  expect((await result).ok).toBe(false);
  expect(bridge.cancel).toHaveBeenCalledWith(request.runId);
  expect(native.__listeners.size).toBe(0);
});

it('rejects remote media before entering native code', async () => {
  const result = await new NativeMotion3DReconstructor(entry).reconstruct({
    ...request,
    videoUri: 'https://invalid.example/video',
  });
  expect(result.ok).toBe(false);
  expect(bridge.reconstruct).not.toHaveBeenCalled();
});
