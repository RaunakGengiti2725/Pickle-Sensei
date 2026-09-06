import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { fail, failure, ok, type FailureKind } from '@pickle/shared-types';
import { MOTION_3D_MAX_JSON_BYTES } from '@pickle/swing-domain';
import type { ModelManifestEntry } from '@pickle/model-registry';
import type {
  IPoseReconstructor3D,
  ProviderDescriptor,
} from '@pickle/vision-contracts';
import {
  resolveAnalysisPlan,
  type AnalysisPlan,
} from '@pickle/analysis-pipeline';

const NATIVE_FAILURES: Record<string, readonly [FailureKind, string]> = {
  'motion3d.timeout': [
    'timeout',
    '3D reconstruction took too long. Try a shorter recording.',
  ],
  'motion3d.busy': [
    'retryable',
    'Another 3D reconstruction is finishing. Try again once it completes.',
  ],
  'motion3d.cancelled': [
    'retryable',
    '3D reconstruction was cancelled. Your recording is still saved.',
  ],
  'motion3d.exceeds_limits': [
    'permanent',
    'Use a shorter or lower-resolution recording. 3D clips must be 60 seconds or less.',
  ],
  'motion3d.invalid_source': [
    'corrupted_media',
    'This video cannot be opened for 3D analysis. Import a new copy or record again.',
  ],
  'motion3d.invalid_options': [
    'permanent',
    'This recording could not be prepared for 3D analysis. Open it again from Library.',
  ],
  'motion3d.decoding_failed': [
    'corrupted_media',
    'This video could not be decoded. Try a different video export or record again.',
  ],
  'motion3d.unavailable': [
    'unsupported_device',
    '3D reconstruction is unavailable on this device or app build.',
  ],
};

interface Motion3DNativeModule {
  available: boolean;
  schemaVersion: number;
  reconstruct(options: {
    uri: string;
    captureId: string;
    runId: string;
  }): Promise<unknown>;
  cancel(runId: string): void;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

function nativeModule(): Motion3DNativeModule | null {
  const module = NativeModules.PickleMotion3D as
    Partial<Motion3DNativeModule> | undefined;
  return module?.available === true &&
    module.schemaVersion === 1 &&
    typeof module.reconstruct === 'function' &&
    typeof module.cancel === 'function' &&
    typeof module.addListener === 'function' &&
    typeof module.removeListeners === 'function'
    ? (module as Motion3DNativeModule)
    : null;
}

export function nativeOSMajorVersion(): number {
  const version = String(Platform.Version ?? '');
  return /^\d+(?:\.\d+)*$/.test(version) ? Number(version.split('.')[0]) : 0;
}

export function motion3DNativeAvailable(): boolean {
  return (
    Platform.OS === 'ios' &&
    nativeOSMajorVersion() >= 17 &&
    nativeModule() !== null
  );
}

export function currentAnalysisPlan(): AnalysisPlan {
  const isDevelopmentBuild = typeof __DEV__ !== 'undefined' && __DEV__;
  return resolveAnalysisPlan({
    platform: Platform.OS,
    osMajorVersion: nativeOSMajorVersion(),
    isDevelopmentBuild,
    nativeReconstructionAvailable:
      isDevelopmentBuild && motion3DNativeAvailable(),
  });
}

export class NativeMotion3DReconstructor implements IPoseReconstructor3D {
  public readonly descriptor: ProviderDescriptor;

  public constructor(entry: ModelManifestEntry) {
    this.descriptor = Object.freeze({
      providerId: entry.id,
      modelVersion: entry.version,
      runtime: entry.runtime,
      executionTarget: entry.executionTarget,
      artifactHash: entry.artifactHash,
      inputSchemaVersion: entry.inputSchemaVersion,
      outputSchemaVersion: entry.outputSchemaVersion,
    });
  }

  public async reconstruct(
    input: Parameters<IPoseReconstructor3D['reconstruct']>[0],
  ): ReturnType<IPoseReconstructor3D['reconstruct']> {
    const module = nativeModule();
    if (!motion3DNativeAvailable() || !module) {
      return fail(
        failure(
          'unsupported_device',
          'motion3d.unavailable',
          '3D reconstruction is unavailable on this device or app build.',
        ),
      );
    }
    if (
      !input.videoUri.startsWith('file://') ||
      ![input.captureId, input.runId].every(id =>
        /^[a-zA-Z0-9._:-]{1,128}$/.test(id),
      )
    ) {
      return fail(
        failure(
          'corrupted_media',
          'motion3d.invalid_source',
          '3D reconstruction needs a saved local recording.',
        ),
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const emitter = new NativeEventEmitter(module);
    const subscription = emitter.addListener(
      'PickleMotion3DProgress',
      (event: unknown) => {
        if (!event || typeof event !== 'object') return;
        const progress = event as Record<string, unknown>;
        const { runId, processedFrames, timestampMs, durationMs } = progress;
        if (
          runId !== input.runId ||
          typeof processedFrames !== 'number' ||
          !Number.isSafeInteger(processedFrames) ||
          processedFrames < 0 ||
          processedFrames > 1_000_000 ||
          typeof timestampMs !== 'number' ||
          !Number.isFinite(timestampMs) ||
          timestampMs < 0 ||
          typeof durationMs !== 'number' ||
          !Number.isFinite(durationMs) ||
          durationMs <= 0 ||
          durationMs > 60_000 ||
          timestampMs > durationMs
        )
          return;
        input.onProgress?.({ processedFrames, timestampMs, durationMs });
      },
    );
    try {
      const result = await Promise.race([
        module.reconstruct({
          uri: input.videoUri,
          captureId: input.captureId,
          runId: input.runId,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.cancel(input.runId);
            reject(
              Object.assign(new Error('Reconstruction timed out.'), {
                code: 'motion3d.timeout',
              }),
            );
          }, 90_000);
        }),
      ]);
      if (!result || typeof result !== 'object') {
        return fail(
          failure(
            'corrupted_media',
            'motion3d.invalid_response',
            'The 3D reconstruction could not be read. Try this recording again.',
          ),
        );
      }
      const receipt = result as Record<string, unknown>;
      if (
        typeof receipt['json'] !== 'string' ||
        receipt['json'].length > MOTION_3D_MAX_JSON_BYTES ||
        typeof receipt['sha256'] !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt['sha256'])
      ) {
        return fail(
          failure(
            'corrupted_media',
            'motion3d.invalid_response',
            'The 3D reconstruction could not be verified. No rating was created.',
          ),
        );
      }
      return ok({
        artifactJson: receipt['json'],
        artifactSha256: receipt['sha256'],
      });
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : '';
      const known = Object.hasOwn(NATIVE_FAILURES, code)
        ? NATIVE_FAILURES[code]
        : undefined;
      const [kind, message] = known ?? [
        'retryable',
        '3D reconstruction could not finish. Your recording is still saved. Try again.',
      ];
      return fail(failure(kind, known ? code : 'motion3d.failed', message));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      subscription.remove();
    }
  }

  public cancel(runId: string): void {
    try {
      nativeModule()?.cancel(runId);
    } catch {
      return;
    }
  }
}
