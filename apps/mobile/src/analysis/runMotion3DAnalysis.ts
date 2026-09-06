import {
  buildMotion3DAnalysis,
  type AnalysisPlan,
} from '@pickle/analysis-pipeline';
import {
  captureDataOwnerScope,
  isDataOwnerScopeCurrent,
  subscribeDataOwnerChanges,
  SIGNED_OUT_DATA_OWNER,
} from '../data/accountScope';
import {
  Motion3DRepositoryError,
  saveMotion3DAnalysis,
} from '../data/motion3dRepository';
import { getPendingCapture } from '../data/repository';
import { createMotion3DProvider } from '../vision/providers';
import { makeUuid } from '../util/uuid';
import { stabilitySlo } from './stabilityTelemetry';
import type {
  CaptureAnalysisOutcome,
  RunCaptureAnalysisRequest,
} from './runCaptureAnalysis';

const inFlight = new Map<string, Promise<CaptureAnalysisOutcome>>();
const cancelled = (): CaptureAnalysisOutcome => ({
  kind: 'unavailable',
  cause: 'cancelled',
  reason: '3D reconstruction was cancelled. Your recording is still saved.',
});

export function runMotion3DAnalysis(
  request: RunCaptureAnalysisRequest,
  plan: Extract<AnalysisPlan, { engine: 'motion_3d' }>,
): Promise<CaptureAnalysisOutcome> {
  if (request.signal?.aborted) return Promise.resolve(cancelled());
  const scope = captureDataOwnerScope();
  if (scope.owner === SIGNED_OUT_DATA_OWNER)
    return Promise.resolve({
      kind: 'unavailable',
      reason: 'Sign in before reconstructing a saved recording.',
    });
  const key = `${scope.owner}:${scope.generation}:${request.captureId}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = reconstructAndSave(request, plan, scope).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

async function reconstructAndSave(
  request: RunCaptureAnalysisRequest,
  plan: Extract<AnalysisPlan, { engine: 'motion_3d' }>,
  scope: ReturnType<typeof captureDataOwnerScope>,
): Promise<CaptureAnalysisOutcome> {
  const ownerChanged = (): CaptureAnalysisOutcome => ({
    kind: 'unavailable',
    cause: 'owner_changed',
    reason:
      'The account changed during reconstruction. No result was saved to the new account.',
  });
  const selection = createMotion3DProvider(plan);
  if (selection.kind === 'unavailable')
    return { kind: 'unavailable', reason: selection.reason };
  const { provider } = selection;
  const analysisId = makeUuid();
  const cancelNative = () => provider.cancel(analysisId);
  const unsubscribe = subscribeDataOwnerChanges(() => {
    if (!isDataOwnerScopeCurrent(scope)) cancelNative();
  });
  request.signal?.addEventListener('abort', cancelNative, { once: true });
  stabilitySlo.record({ kind: 'analysis_started' });
  let completed = false;
  let stage: 'loading' | 'reconstructing' | 'saving' = 'loading';
  try {
    if (!isDataOwnerScopeCurrent(scope)) return ownerChanged();
    if (request.signal?.aborted) return cancelled();
    const capture = await getPendingCapture(request.db, request.captureId);
    if (!isDataOwnerScopeCurrent(scope)) return ownerChanged();
    if (request.signal?.aborted) return cancelled();
    if (
      !capture?.clip ||
      capture.evidenceStatus !== 'valid' ||
      capture.uri !== request.clip.uri ||
      capture.capturedAtIso !== request.clip.capturedAtIso
    ) {
      return {
        kind: 'unavailable',
        cause: 'invalid_recording',
        reason:
          'This recording could not be verified in the current account. Open it again from Library.',
      };
    }
    stage = 'reconstructing';
    const reconstructed = await provider.reconstruct({
      captureId: request.captureId,
      videoUri: capture.uri,
      runId: analysisId,
      onProgress: progress => {
        if (isDataOwnerScopeCurrent(scope) && !request.signal?.aborted)
          request.onReconstructionProgress?.(progress);
      },
    });
    if (!isDataOwnerScopeCurrent(scope)) return ownerChanged();
    if (request.signal?.aborted) return cancelled();
    if (!reconstructed.ok)
      return {
        kind: 'unavailable',
        reason: reconstructed.failure.message,
        ...(reconstructed.failure.retryable === false
          ? { cause: 'invalid_recording' as const }
          : {}),
      };
    const analysis = buildMotion3DAnalysis({
      id: analysisId,
      captureId: request.captureId,
      createdAtIso: new Date().toISOString(),
      capturedAtIso: capture.capturedAtIso,
      declaredStroke: request.declaredStroke ?? capture.declaredStroke,
      declaredCanonical: request.declaredCanonical ?? null,
      handedness: request.handedness,
      ...reconstructed.value,
    });
    if (!analysis.ok)
      return { kind: 'unavailable', reason: analysis.failure.message };
    if (
      analysis.value.artifact.estimator.providerId !==
        provider.descriptor.providerId ||
      analysis.value.artifact.estimator.configurationVersion !==
        provider.descriptor.modelVersion
    ) {
      return {
        kind: 'unavailable',
        reason:
          'The reconstruction does not match the selected analysis version.',
      };
    }
    if (request.signal?.aborted) return cancelled();
    stage = 'saving';
    await saveMotion3DAnalysis(request.db, analysis.value, scope);
    if (!isDataOwnerScopeCurrent(scope)) return ownerChanged();
    completed = true;
    return { kind: 'motion_3d', analysisId, analysis: analysis.value };
  } catch (error) {
    if (!isDataOwnerScopeCurrent(scope)) return ownerChanged();
    if (request.signal?.aborted) return cancelled();
    if (error instanceof Motion3DRepositoryError) {
      return {
        kind: 'unavailable',
        cause:
          error.code === 'motion_3d.owner_changed'
            ? 'owner_changed'
            : error.code === 'motion_3d.capture_mismatch' ||
                error.code === 'motion_3d.capture_missing'
              ? 'invalid_recording'
              : 'storage_failed',
        reason: error.message,
      };
    }
    return {
      kind: 'unavailable',
      ...(stage !== 'reconstructing'
        ? { cause: 'storage_failed' as const }
        : {}),
      reason:
        stage === 'loading'
          ? 'The saved recording could not be opened. Try again from Library.'
          : stage === 'saving'
            ? 'The 3D result could not be saved. Your recording is still on this device. Try again.'
            : '3D reconstruction could not finish. Your recording is still saved. Try again.',
    };
  } finally {
    unsubscribe();
    request.signal?.removeEventListener('abort', cancelNative);
    stabilitySlo.record(
      completed
        ? { kind: 'analysis_completed' }
        : {
            kind: 'analysis_failed',
            failureKind: '3d_reconstruction_unavailable',
          },
    );
  }
}
