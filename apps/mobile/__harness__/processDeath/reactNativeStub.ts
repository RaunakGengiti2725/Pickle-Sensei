/**
 * `react-native` surface the shipping data/analysis modules touch when they
 * run headless in a plain Node child. The one behavioural piece is the
 * `PickleVideoCapture` bridge: `readTextFile` serves the pose sidecar and
 * `compareCapturedClipBytes` hashes the on-disk clip exactly the way the iOS
 * module answers `verifyCapturedClipCurrentBytes` (`src/camera/capture.ts`),
 * so the saved-analysis admission gate runs its real byte proof.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NativeClipByteComparisonRequest } from '../../src/camera/nativeMediaIdentity';

function pathOf(uri: string): string {
  return uri.startsWith('file://') ? fileURLToPath(uri) : uri;
}

export const Platform = {
  OS: 'ios' as const,
  Version: '18.0',
  select<T>(spec: { ios?: T; default?: T }): T | undefined {
    return spec.ios ?? spec.default;
  },
};

export const NativeModules = {
  PickleVideoCapture: {
    async readTextFile(uri: string): Promise<string> {
      return readFileSync(pathOf(uri), 'utf8');
    },
    async compareCapturedClipBytes(request: NativeClipByteComparisonRequest) {
      const bytes = readFileSync(pathOf(request.uri));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const identity = request.nativeMediaIdentity;
      return {
        status:
          sha256 === identity.sha256 && bytes.byteLength === identity.byteSize
            ? 'verified-current-bytes'
            : 'mismatch',
        operationId: request.operationId,
        receiptId: identity.receiptId,
        videoFileName: identity.videoFileName,
        expectedSha256: identity.sha256,
        expectedByteSize: identity.byteSize,
      };
    },
  },
};

export interface EmitterSubscription {
  remove(): void;
}

export class NativeEventEmitter {
  addListener(): EmitterSubscription {
    return { remove() {} };
  }
}

export const AppState = {
  currentState: 'active' as const,
  addEventListener(): EmitterSubscription {
    return { remove() {} };
  },
};
