/**
 * Installs a controllable `PickleVideoCapture` native module into
 * `NativeModules` BEFORE `src/camera/capture.ts` is evaluated, so the real
 * camera seam (`captureStrokeVideo`, `subscribeToCameraEvents`,
 * `cancelCameraOperation`, the real `NativeEventEmitter` →
 * `DeviceEventEmitter` subscription path) runs unmodified against a Swift
 * stand-in whose promises the test settles by hand.
 *
 * Import this module FIRST in a suite (ES imports evaluate in order); it is the
 * only "mock" the stress suites apply to the camera — everything above the
 * native boundary is production code.
 *
 * Counters expose exactly what iOS would see: how many `addListener` /
 * `removeListeners` calls the JS side made, and how many `cancel()` calls.
 */
import { DeviceEventEmitter, NativeModules } from 'react-native';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
}

export function deferred<T>(): Deferred<T> {
  const d = { settled: false } as Deferred<T>;
  d.promise = new Promise<T>((resolve, reject) => {
    d.resolve = value => {
      d.settled = true;
      resolve(value);
    };
    d.reject = reason => {
      d.settled = true;
      reject(reason);
    };
  });
  return d;
}

export const CAMERA_EVENT_NAME = 'PickleCameraEvent';

export interface FakeNativeCaptureState {
  /** Net `addListener` − `removeListeners` the JS side reported to native. */
  nativeListenerBalance: number;
  addListenerCalls: number;
  removeListenersCalls: number;
  cancelCalls: number;
  captureCalls: number;
  importCalls: number;
  /** Pending `capture()` / `importVideo()` promises, oldest first. */
  pendingCaptures: Deferred<unknown>[];
  pendingImports: Deferred<unknown>[];
}

export const fakeNativeCaptureState: FakeNativeCaptureState = {
  nativeListenerBalance: 0,
  addListenerCalls: 0,
  removeListenersCalls: 0,
  cancelCalls: 0,
  captureCalls: 0,
  importCalls: 0,
  pendingCaptures: [],
  pendingImports: [],
};

export function resetFakeNativeCaptureCounters(): void {
  fakeNativeCaptureState.addListenerCalls = 0;
  fakeNativeCaptureState.removeListenersCalls = 0;
  fakeNativeCaptureState.cancelCalls = 0;
  fakeNativeCaptureState.captureCalls = 0;
  fakeNativeCaptureState.importCalls = 0;
  fakeNativeCaptureState.pendingCaptures = [];
  fakeNativeCaptureState.pendingImports = [];
}

/** Text the fake `readTextFile` returns per URI (pose sequences etc.). */
export const fakeNativeFiles = new Map<string, string>();

const fakeNativeCapture = {
  capture(): Promise<unknown> {
    fakeNativeCaptureState.captureCalls += 1;
    const d = deferred<unknown>();
    fakeNativeCaptureState.pendingCaptures.push(d);
    return d.promise;
  },
  importVideo(): Promise<unknown> {
    fakeNativeCaptureState.importCalls += 1;
    const d = deferred<unknown>();
    fakeNativeCaptureState.pendingImports.push(d);
    return d.promise;
  },
  async readTextFile(uri: string): Promise<string> {
    const text = fakeNativeFiles.get(uri);
    if (text === undefined) throw new Error(`fake native: no file at ${uri}`);
    return text;
  },
  cancel(): void {
    fakeNativeCaptureState.cancelCalls += 1;
  },
  addListener(_eventType: string): void {
    fakeNativeCaptureState.addListenerCalls += 1;
    fakeNativeCaptureState.nativeListenerBalance += 1;
  },
  removeListeners(count: number): void {
    fakeNativeCaptureState.removeListenersCalls += 1;
    fakeNativeCaptureState.nativeListenerBalance -= count;
  },
};

(NativeModules as Record<string, unknown>).PickleVideoCapture =
  fakeNativeCapture;

/** Delivers a camera event exactly like the iOS bridge would. */
export function emitNativeCameraEvent(event: object): void {
  DeviceEventEmitter.emit(CAMERA_EVENT_NAME, event);
}

/** Live JS subscriptions to the camera event, as the bridge emitter sees it. */
export function cameraEventListenerCount(): number {
  return DeviceEventEmitter.listenerCount(CAMERA_EVENT_NAME);
}
