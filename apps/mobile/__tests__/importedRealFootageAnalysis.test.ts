/**
 * REAL-FOOTAGE import analysis: drives the exact imported-video scoring path
 * (runCaptureAnalysis with an attached pose-sequence sidecar) using REAL
 * Apple Vision poses of a REAL pickleball player — the wm-volley-02 canonical
 * run (rights-cleared WM footage; the case that passes the full strict
 * cascade on the Mac bench).
 *
 * The canonical run dirs are gitignored (Mac-only artifacts), so this suite
 * SKIPS LOUDLY when the artifact is absent (CI/Linux) and runs for real on
 * any machine that has regenerated the runs (`pnpm lab:regen`). Skipping is
 * disclosure, not silence: the suite name states the artifact requirement.
 *
 * HONESTY: poses are converted 1:1 (timestamps, confidences, landmarks) —
 * never resampled or repaired. Whatever the pipeline concludes about this
 * real swing is asserted only at the contract level (a durable, honest
 * outcome), never forced toward a score.
 */
import {
  parsePoseSequence,
  serializePoseSequence,
  sha256Hex,
} from '@pickle/swing-domain';
import type { PoseSequence } from '@pickle/swing-domain';

// Node built-ins for reading the local gitignored artifact. The mobile
// tsconfig deliberately excludes node typings, so the shims stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
const { existsSync, readFileSync } = require('fs') as {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';
import type { CapturedClip } from '../src/camera/capture';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { LocalDb } from '../src/data/db';

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const RUN_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'datasets',
  'paddle-bench',
  'runs',
  'wm-volley-02',
);
const POSE_PATH = join(RUN_DIR, 'pose.json');
const META_PATH = join(RUN_DIR, 'extract-meta.json');
const artifactsPresent = existsSync(POSE_PATH) && existsSync(META_PATH);

function loadRealSequence(): { sequence: PoseSequence; sidecarJson: string } {
  // The canonical run's pose.json IS a complete pickle.pose-sequence.v1 wire
  // document (the same format the native sidecar writer emits) — parse it
  // with the app's own strict parser, untouched.
  const raw = readFileSync(POSE_PATH, 'utf8');
  const parsed = parsePoseSequence(raw, {
    providerId: 'pose.apple-vision',
    runtime: 'vision_framework',
    executionTarget: 'on_device',
    artifactHash: null,
  });
  if (!parsed.ok) {
    throw new Error(
      `real pose artifact failed domain parsing: ${parsed.failure.message}`,
    );
  }
  return { sequence: parsed.value, sidecarJson: serializePoseSequence(parsed.value) };
}

function recordingDb(): LocalDb {
  return {
    async execute() {
      return { rows: [] };
    },
    close() {},
  } as unknown as LocalDb;
}

const describeReal = artifactsPresent ? describe : describe.skip;

describeReal(
  'imported-video analysis over REAL pickleball footage (wm-volley-02 canonical run; SKIPPED when the gitignored Mac run artifacts are absent)',
  () => {
    beforeEach(() =>
      setActiveDataOwner('33333333-3333-4333-8333-333333333333'),
    );
    afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

    it('produces a durable, honest analysis outcome from real Apple Vision poses', async () => {
      const { sequence, sidecarJson } = loadRealSequence();
      const sha256 = sha256Hex(sidecarJson);
      mockReadArtifact = async () => sidecarJson;

      const clip: CapturedClip = {
        uri: 'file:///imports/wm-volley-02.mov',
        durationMs: sequence.frames.at(-1)!.timestampMs,
        fps: sequence.video.fps,
        width: sequence.video.width,
        height: sequence.video.height,
        capturedAtIso: '2026-08-29T12:00:00.000Z',
        captureMode: 'imported_video',
        recognition: { status: 'unknown', reason: 'analysis_not_run' },
        ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
        poseSequence: {
          schemaVersion: 1,
          format: 'pickle.pose-sequence.v1',
          uri: 'file:///imports/wm-volley-02.pose.json',
          frameCount: sequence.frames.length,
          sha256,
          coordinateSystem: 'normalized_image_top_left',
          poseModelVersion: sequence.producedBy.modelVersion,
        },
      };

      const fetchMock = jest.fn(async (url: string) => {
        if (url.endsWith('/v1/analysis-permits')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
              permit: {
                id: 'permit-real-footage-1',
                accessSource: 'free',
                status: 'reserved',
                expiresAt: '2026-08-30T20:00:00.000Z',
              },
            }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ ok: true }),
        } as unknown as Response;
      });

      // Declared stroke must be in the RELEASED technique-scoring set
      // (model-registry: forehand_drive, dink, third_shot_drop, serve) —
      // volley scoring is honestly unreleased and would refuse before any
      // analysis. Declaring a drive simulates a user's own statement; the
      // pipeline's mismatch gates may still land low_confidence, which is a
      // valid durable outcome for this contract test.
      const previousFetch = (globalThis as { fetch?: unknown }).fetch;
      (globalThis as { fetch?: unknown }).fetch = fetchMock;
      let outcome;
      try {
        outcome = await runCaptureAnalysis({
          db: recordingDb(),
          captureId: 'real-footage-capture-1',
          clip,
          declaredStroke: 'forehand_drive',
          handedness: 'right',
          cameraView: 'side',
          captureEnvelope: null,
          apiConfig: { baseUrl: 'https://example.test', token: 'test-bearer' },
          appVersion: '0.1.0',
        });
      } finally {
        (globalThis as { fetch?: unknown }).fetch = previousFetch;
      }

      // Contract-level honesty: the REAL swing must yield a durable outcome —
      // scored or an explicit low-confidence record — never a crash, never a
      // fabricated rejection, and the permit must have been reserved.
      if (outcome.kind !== 'scored' && outcome.kind !== 'low_confidence') {
        throw new Error(
          `expected a durable outcome, got ${outcome.kind}: ${
            'reason' in outcome ? outcome.reason : '(no reason)'
          }`,
        );
      }
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/v1/analysis-permits'),
        expect.anything(),
      );
      const result = outcome.record.result;
      expect(result).not.toBeNull();
      if (!result) throw new Error('unreachable: durable outcome without a result');
      expect(result.source).toBe('real');
      if (outcome.kind === 'scored') {
        expect(result.overallScore).not.toBeNull();
      } else {
        expect(result.overallScore).toBeNull();
      }
      // 200 real frames in, real frame count preserved end to end.
      expect(sequence.frames).toHaveLength(200);
    });
  },
);
