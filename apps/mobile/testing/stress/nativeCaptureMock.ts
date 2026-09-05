/**
 * Installs a controllable `PickleVideoCapture` native module BEFORE
 * `src/camera/capture.ts` captures `NativeModules.PickleVideoCapture` at
 * import time — import this module first in a stress suite.
 *
 * The only method FormReviewScreen's dependency graph should ever reach is
 * `readTextFile` (the pose sidecar). Every other property access on the
 * module is recorded so a scenario can prove the screen never touched the
 * camera (start/stop capture, import, permissions…).
 */
import { NativeModules } from 'react-native';

export type ReadTextFile = (uri: string) => unknown;

let readTextFileImpl: ReadTextFile | undefined = () => {
  throw new Error('stress: readTextFile not configured');
};

/** `undefined` → the native module has no `readTextFile` (older build). */
export function setReadTextFile(impl: ReadTextFile | undefined): void {
  readTextFileImpl = impl;
}

/** Property reads other than `readTextFile` (feature probes; informational). */
export const nativeCaptureAccesses: string[] = [];
/** Camera methods actually INVOKED — must stay empty for this screen. */
export const nativeCaptureCalls: string[] = [];
export const readTextFileCalls: string[] = [];

(NativeModules as Record<string, unknown>)['PickleVideoCapture'] = new Proxy(
  {},
  {
    get: (_target, prop) => {
      const name = String(prop);
      if (name === 'readTextFile') {
        if (readTextFileImpl === undefined) return undefined;
        const impl = readTextFileImpl;
        return (uri: string) => {
          readTextFileCalls.push(uri);
          return impl(uri);
        };
      }
      nativeCaptureAccesses.push(name);
      return (..._args: unknown[]) => {
        nativeCaptureCalls.push(name);
        throw new Error(`stress: camera method ${name} must not be called`);
      };
    },
  },
);
