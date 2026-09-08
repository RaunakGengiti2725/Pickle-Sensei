/**
 * ADVERSARY (performance-bounds): upper bounds at the CapturedClip / pose
 * sidecar contract.
 *
 * Native is the first line of defence (ClipMediaStore.swift: imports over
 * `maximumDurationSeconds = 60` are refused with `camera.import_too_long`,
 * `readTextFile` refuses a sidecar over `maximumSidecarBytes = 16 MiB`;
 * extraction receipts are capped at MAX_IMPORTED_POSE_FRAMES in
 * `assertImportedPoseExtraction`) — read from source, NOT exercised here;
 * nothing below is a claim about iOS runtime behaviour. What IS exercised is
 * the JS layer that re-admits PERSISTED state: a `local_capture` payload is
 * re-validated with `assertCapturedClip` on every history load
 * (repository.ts `listCaptureHistory`) and, when analysed, its sidecar is
 * read, hashed and parsed in full before `frames.length` is compared with
 * the receipt (runCaptureAnalysis.ts) — so a corrupt or hand-edited payload
 * only has to be self-consistent to be processed. Probed:
 *  - does `assertCapturedClip` cap `durationMs` / `poseSequence.frameCount`
 *    for an imported clip at the product's 60 s / MAX_IMPORTED_POSE_FRAMES
 *    caps, or will it hand a 10-hour clip with a 2-million-frame receipt on;
 *  - does the canonical pose-sequence parser bound the wire frame count, or
 *    is the extraction RECEIPT check the only frame cap in the system.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import {
  parsePoseSequence,
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import {
  assertCapturedClip,
  MAX_IMPORTED_POSE_FRAMES,
} from '../../src/camera/capture';

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => {} };
    }
  },
}));

const TEN_HOURS_MS = 10 * 60 * 60 * 1000;
const HUGE_FRAME_COUNT = 2_000_000;
const PRODUCER = {
  providerId: 'pose.apple-vision',
  runtime: 'vision_framework',
  executionTarget: 'on_device',
  artifactHash: null,
} as const;

function importedClip(durationMs: number, frameCount: number): unknown {
  return {
    uri: 'file:///imports/marathon.mov',
    durationMs,
    fps: 60,
    width: 1080,
    height: 1920,
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///imports/marathon.pose.json',
      frameCount,
      sha256: sha256Hex('marathon'),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-1',
    },
  };
}

/** Repeats the generated swing's frames until the sequence holds `frames`
 * frames with strictly increasing timestamps at the source fps. */
function stretchedSequence(frames: number): PoseSequence {
  const { sequence } = generateSwingSequence({ fps: 60 });
  const interval = 1000 / sequence.video.fps;
  const source = sequence.frames;
  return {
    ...sequence,
    frames: Array.from({ length: frames }, (_, index) => ({
      ...source[index % source.length]!,
      frameIndex: index,
      timestampMs: Math.round(index * interval * 1000) / 1000,
    })),
  };
}

describe('ADV perf: CapturedClip / pose sidecar upper bounds', () => {
  it('assertCapturedClip refuses a persisted imported clip far beyond the 60 s import cap', () => {
    expect(() =>
      assertCapturedClip(
        importedClip(TEN_HOURS_MS, HUGE_FRAME_COUNT),
        'imported_video',
      ),
    ).toThrow();
  });

  it('assertCapturedClip refuses a persisted imported sidecar receipt above MAX_IMPORTED_POSE_FRAMES', () => {
    expect(() =>
      assertCapturedClip(
        importedClip(59_000, MAX_IMPORTED_POSE_FRAMES + 1),
        'imported_video',
      ),
    ).toThrow();
  });

  it('parsePoseSequence bounds the wire frame count at MAX_IMPORTED_POSE_FRAMES', () => {
    // Sized under the 16 MiB sidecar byte cap read from native source, so
    // the byte cap alone would not stop this sidecar.
    const frames = 19_000;
    const json = serializePoseSequence(stretchedSequence(frames));
    const start = performance.now();
    const parsed = parsePoseSequence(json, PRODUCER);
    const ms = performance.now() - start;
    console.warn(
      `[adv] parsePoseSequence over ${frames} frames (${json.length} B): ok=${parsed.ok} in ${ms.toFixed(0)} ms`,
    );
    expect(json.length).toBeLessThan(16 * 1024 * 1024);
    expect(parsed.ok).toBe(false);
  });
});
