jest.mock('../src/vision/motion3d', () => ({
  currentAnalysisPlan: () => ({
    engine: 'motion_3d',
    policyVersion: 'analysis-plan-3d-validation-1',
    purpose: 'development_validation',
    providerId: 'pose.apple-vision-3d',
    permits: 'none',
    scoring: 'blocked',
    fallbackAfterFailure: false,
  }),
}));
jest.mock('../src/vision/providers', () => {
  const provider = {
    descriptor: {
      providerId: 'pose.apple-vision-3d',
      modelVersion: 'apple-vision-3d-raw-1',
      runtime: 'vision_framework',
      executionTarget: 'on_device',
      artifactHash: null,
      inputSchemaVersion: 1,
      outputSchemaVersion: 1,
    },
    reconstruct: jest.fn(),
    cancel: jest.fn(),
  };
  return {
    createFusionProviders: jest.fn(),
    createMotion3DProvider: () => ({ kind: 'real', provider }),
    __provider: provider,
  };
});
jest.mock('../src/data/motion3dRepository', () => ({
  ...jest.requireActual('../src/data/motion3dRepository'),
  saveMotion3DAnalysis: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/data/api', () => ({
  ApiError: class extends Error {},
  createAnalysisPermitClient: jest.fn(),
}));
jest.mock('../src/evaluation/trialCapture', () => ({
  recordEvaluationTrial: jest.fn(),
}));

import { sha256Hex, type Motion3DArtifact } from '@pickle/swing-domain';
import {
  runCaptureAnalysis,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import { setActiveDataOwner } from '../src/data/accountScope';
import { createAnalysisPermitClient } from '../src/data/api';
import { recordEvaluationTrial } from '../src/evaluation/trialCapture';
import { createFusionProviders } from '../src/vision/providers';

const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '22222222-2222-4222-8222-222222222222';
const provider = (
  jest.requireMock('../src/vision/providers') as {
    __provider: { reconstruct: jest.Mock; cancel: jest.Mock };
  }
).__provider;
const saveMotion3DAnalysis = (
  jest.requireMock('../src/data/motion3dRepository') as {
    saveMotion3DAnalysis: jest.Mock;
  }
).saveMotion3DAnalysis;

function softwareArtifact(): Motion3DArtifact {
  return {
    schemaVersion: 1,
    format: 'pickle.motion-3d.v1',
    role: 'reconstructed_estimate',
    coordinateSystem: 'vision_root_relative',
    axes: 'right_handed_y_up',
    units: 'vision_estimated_meters',
    imageCoordinates: 'normalized_image_top_left',
    uncertainty: 'uncalibrated',
    temporalProcessing: 'none',
    source: {
      captureId: 'capture-software-fixture',
      videoSha256: 'a'.repeat(64),
      videoByteLength: 1000,
      width: 1080,
      height: 1920,
      durationMs: 1000,
      nominalFrameRate: 30,
      preferredTransform: [1, 0, 0, 1, 0, 0],
      orientationPolicy: 'preferred_track_transform_applied',
      mirroring: 'as_encoded',
    },
    estimator: {
      providerId: 'pose.apple-vision-3d',
      revision: 1,
      osVersion: 'software-test-only',
      modelAsset: 'os_managed',
      modelAssetSha256: null,
      configurationVersion: 'apple-vision-3d-raw-1',
      maxSampleRate: 30,
    },
    frames: [
      {
        frameIndex: 0,
        timestampMs: 0,
        ptsValue: 0,
        ptsTimescale: 30,
        segmentId: 0,
        status: 'estimated',
        observationConfidence: 1,
        height: { meters: 1.8, source: 'reference' },
        cameraOriginMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1],
        joints: [
          {
            name: 'root',
            x: 0,
            y: 0,
            z: 0,
            imageX: 0.5,
            imageY: 0.5,
            confidence: null,
            visibility2D: null,
          },
        ],
      },
    ],
  };
}

function receipt() {
  const artifactJson = JSON.stringify(softwareArtifact());
  return {
    ok: true,
    value: { artifactJson, artifactSha256: sha256Hex(artifactJson) },
  };
}

function request(): RunCaptureAnalysisRequest {
  const clip: RunCaptureAnalysisRequest['clip'] = {
    captureMode: 'imported_video',
    uri: 'file:///private/Captures/test.mov',
    durationMs: 1000,
    width: 1080,
    height: 1920,
    fps: 30,
    capturedAtIso: '2026-09-05T12:00:00.000Z',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
  const capture = {
    id: 'capture-software-fixture',
    owner_key: ownerA,
    uri: clip.uri,
    shot_type: 'unrecognized',
    declared_stroke: 'dink',
    captured_at: clip.capturedAtIso,
    duration_ms: clip.durationMs,
    fps: clip.fps,
    width: clip.width,
    height: clip.height,
    status: 'awaiting_model',
    payload: JSON.stringify(clip),
  };
  return {
    db: {
      execute: jest.fn(async (sql: string) => ({
        rows: sql.includes('FROM local_capture') ? [capture] : [],
      })),
      close: jest.fn(),
    },
    captureId: capture.id,
    clip,
    declaredStroke: 'dink',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: '', token: null },
    appVersion: 'software-test',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  setActiveDataOwner(ownerA);
  provider.reconstruct.mockResolvedValue(receipt());
  saveMotion3DAnalysis.mockResolvedValue(undefined);
});

describe('one real reconstruction pipeline (software boundary tests)', () => {
  it('reconstructs an import without requiring a pre-existing 2D or 3D sidecar', async () => {
    const outcome = await runCaptureAnalysis(request());
    expect(outcome.kind).toBe('motion_3d');
    expect(provider.reconstruct).toHaveBeenCalledTimes(1);
    expect(saveMotion3DAnalysis).toHaveBeenCalledTimes(1);
    expect(createFusionProviders).not.toHaveBeenCalled();
    expect(createAnalysisPermitClient).not.toHaveBeenCalled();
    expect(recordEvaluationTrial).not.toHaveBeenCalled();
  });

  it('returns the same in-flight reconstruction for duplicate submissions', async () => {
    let finish!: (mockValue: unknown) => void;
    provider.reconstruct.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const first = runCaptureAnalysis(request());
    const second = runCaptureAnalysis(request());
    finish(receipt());
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(provider.reconstruct).toHaveBeenCalledTimes(1);
    expect(saveMotion3DAnalysis).toHaveBeenCalledTimes(1);
  });

  it('cancels and refuses an old owner result, including an A-to-B-to-A switch', async () => {
    let finish!: (mockValue: unknown) => void;
    provider.reconstruct.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const pending = runCaptureAnalysis(request());
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.reconstruct).toHaveBeenCalledTimes(1);
    setActiveDataOwner(ownerB);
    setActiveDataOwner(ownerA);
    finish(receipt());
    expect(await pending).toMatchObject({
      kind: 'unavailable',
      cause: 'owner_changed',
    });
    expect(provider.cancel).toHaveBeenCalled();
    expect(saveMotion3DAnalysis).not.toHaveBeenCalled();
  });

  it('stops a cancelled run without saving or starting a legacy score', async () => {
    const controller = new AbortController();
    let finish!: (mockValue: unknown) => void;
    provider.reconstruct.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const pending = runCaptureAnalysis({
      ...request(),
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    finish(receipt());
    expect(await pending).toMatchObject({
      kind: 'unavailable',
      cause: 'cancelled',
    });
    expect(provider.cancel).toHaveBeenCalledTimes(1);
    expect(saveMotion3DAnalysis).not.toHaveBeenCalled();
    expect(createAnalysisPermitClient).not.toHaveBeenCalled();
  });

  it('does not start an already-cancelled run', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await runCaptureAnalysis({ ...request(), signal: controller.signal }),
    ).toMatchObject({ kind: 'unavailable', cause: 'cancelled' });
    expect(provider.reconstruct).not.toHaveBeenCalled();
  });

  it('checks recording ownership before decoding any video', async () => {
    const input = request();
    input.db.execute = jest.fn().mockResolvedValue({ rows: [] });
    expect((await runCaptureAnalysis(input)).kind).toBe('unavailable');
    expect(provider.reconstruct).not.toHaveBeenCalled();
    expect(saveMotion3DAnalysis).not.toHaveBeenCalled();
  });

  it('does not rescue a failed 3D job with a legacy score', async () => {
    provider.reconstruct.mockResolvedValue({
      ok: false,
      failure: {
        message: 'No supported reconstruction.',
        code: 'motion3d.failed',
      },
    });
    expect(await runCaptureAnalysis(request())).toMatchObject({
      kind: 'unavailable',
    });
    expect(createFusionProviders).not.toHaveBeenCalled();
    expect(createAnalysisPermitClient).not.toHaveBeenCalled();
    expect(saveMotion3DAnalysis).not.toHaveBeenCalled();
  });

  it('refuses changed bytes and failed persistence rather than claiming completion', async () => {
    const corrupt = receipt();
    corrupt.value.artifactSha256 = 'b'.repeat(64);
    provider.reconstruct.mockResolvedValueOnce(corrupt);
    expect((await runCaptureAnalysis(request())).kind).toBe('unavailable');
    expect(saveMotion3DAnalysis).not.toHaveBeenCalled();
    saveMotion3DAnalysis.mockRejectedValueOnce(new Error('disk failure'));
    expect(await runCaptureAnalysis(request())).toMatchObject({
      kind: 'unavailable',
      cause: 'storage_failed',
    });
  });
});
