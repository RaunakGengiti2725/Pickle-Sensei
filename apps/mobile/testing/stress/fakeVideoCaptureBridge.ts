import { DeviceEventEmitter, NativeModules } from 'react-native';
import type { CameraEvent } from '../../src/camera/capture';

/**
 * Controllable stand-in for the native `PickleVideoCapture` bridge
 * (`native/` Swift is BLOCKED_EXTERNAL on Linux). It implements the exact
 * `NativeVideoCapture` surface `src/camera/capture.ts` binds at import time,
 * so the production camera module runs unmodified on top of it: every
 * `capture()` / `importVideo()` / `extractImportedPoseSequence()` call parks
 * a pending operation the stress driver resolves or rejects on its own
 * schedule, `cancel()` rejects the pending camera operation with the typed
 * `camera.cancelled` code the real bridge uses, and camera events go through
 * the same `NativeEventEmitter` channel the screen subscribes to.
 *
 * Install BEFORE `src/camera/capture.ts` is first imported (that module reads
 * `NativeModules.PickleVideoCapture` once, at module evaluation).
 */
export type NativeOperationKind =
  'capture' | 'importVideo' | 'extractImportedPoseSequence';

export interface PendingNativeOperation {
  readonly id: number;
  readonly kind: NativeOperationKind;
  readonly request: unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export interface BridgeCounters {
  capture: number;
  importVideo: number;
  extractImportedPoseSequence: number;
  cancel: number;
  readTextFile: number;
}

export function typedCameraCancel(): Error {
  return Object.assign(new Error('Camera capture was canceled.'), {
    code: 'camera.cancelled',
  });
}

export class FakeVideoCaptureBridge {
  readonly pending: PendingNativeOperation[] = [];
  readonly counters: BridgeCounters = {
    capture: 0,
    importVideo: 0,
    extractImportedPoseSequence: 0,
    cancel: 0,
    readTextFile: 0,
  };
  /** Sidecar text by URI — what `readTextFile` hands back. */
  readonly artifacts = new Map<string, string>();
  /** Peak number of camera operations (capture/import) pending at once. */
  peakConcurrentCameraOps = 0;
  private nextId = 1;

  private defer(kind: NativeOperationKind, request: unknown): Promise<unknown> {
    this.counters[kind] += 1;
    return new Promise<unknown>((resolve, reject) => {
      const op: PendingNativeOperation = {
        id: this.nextId++,
        kind,
        request,
        resolve: value => {
          this.drop(op);
          resolve(value);
        },
        reject: error => {
          this.drop(op);
          reject(error);
        },
      };
      this.pending.push(op);
      const cameraOps = this.pending.filter(
        p => p.kind === 'capture' || p.kind === 'importVideo',
      ).length;
      if (cameraOps > this.peakConcurrentCameraOps) {
        this.peakConcurrentCameraOps = cameraOps;
      }
    });
  }

  private drop(op: PendingNativeOperation): void {
    const index = this.pending.indexOf(op);
    if (index !== -1) this.pending.splice(index, 1);
  }

  pendingOf(kind: NativeOperationKind): PendingNativeOperation[] {
    return this.pending.filter(op => op.kind === kind);
  }

  /** The object handed to `NativeModules.PickleVideoCapture`. Arrow fields
   * keep `this` bound when capture.ts calls the methods detached. */
  readonly nativeModule = {
    capture: (): Promise<unknown> => this.defer('capture', null),
    importVideo: (): Promise<unknown> => this.defer('importVideo', null),
    extractImportedPoseSequence: (request: unknown): Promise<unknown> =>
      this.defer('extractImportedPoseSequence', request),
    readTextFile: (uri: string): Promise<string> => {
      this.counters.readTextFile += 1;
      const text = this.artifacts.get(uri);
      return text === undefined
        ? Promise.reject(new Error(`No capture artifact at ${uri}`))
        : Promise.resolve(text);
    },
    cancel: (): void => {
      this.counters.cancel += 1;
      for (const op of [...this.pending]) {
        if (op.kind === 'capture' || op.kind === 'importVideo') {
          op.reject(typedCameraCancel());
        }
      }
    },
    addListener: (_eventType: string): void => {},
    removeListeners: (_count: number): void => {},
  };

  emit(event: CameraEvent): void {
    DeviceEventEmitter.emit('PickleCameraEvent', event);
  }

  reset(): void {
    for (const op of [...this.pending]) {
      op.reject(new Error('bridge reset with operation pending'));
    }
    this.pending.length = 0;
    this.artifacts.clear();
    this.peakConcurrentCameraOps = 0;
    this.counters.capture = 0;
    this.counters.importVideo = 0;
    this.counters.extractImportedPoseSequence = 0;
    this.counters.cancel = 0;
    this.counters.readTextFile = 0;
  }
}

let installed: FakeVideoCaptureBridge | null = null;

/** Idempotent: the first call installs the bridge into `NativeModules`. */
export function installFakeVideoCaptureBridge(): FakeVideoCaptureBridge {
  if (installed) return installed;
  installed = new FakeVideoCaptureBridge();
  (
    NativeModules as { PickleVideoCapture?: typeof installed.nativeModule }
  ).PickleVideoCapture = installed.nativeModule;
  return installed;
}
