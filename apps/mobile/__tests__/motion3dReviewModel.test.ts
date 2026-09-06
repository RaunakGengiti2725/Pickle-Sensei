import type { Motion3DArtifact } from '@pickle/swing-domain';
const { execFileSync, spawnSync } = jest.requireActual('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } =
  jest.requireActual('node:fs');
const { tmpdir } = jest.requireActual('node:os');
const { dirname, join } = jest.requireActual('node:path');
const { platform: nativePlatform } = jest.requireActual('node:process');
import {
  MOTION_REVIEW_SPEEDS,
  motionFrameDescription,
  motionReviewClock,
  motionReviewError,
  motionReviewSeek,
  motionScaleDescription,
  readMotionReviewProgress,
  readMotionReviewReady,
  type MotionReviewProgress,
  type MotionReviewReady,
} from '../src/review/motion3dReviewModel';

const artifact: Motion3DArtifact = {
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
    captureId: 'synthetic-model-test',
    videoSha256: 'b'.repeat(64),
    videoByteLength: 10,
    width: 720,
    height: 1280,
    durationMs: 1000,
    nominalFrameRate: 30,
    preferredTransform: [1, 0, 0, 1, 0, 0],
    orientationPolicy: 'preferred_track_transform_applied',
    mirroring: 'as_encoded',
  },
  estimator: {
    providerId: 'pose.apple-vision-3d',
    revision: 1,
    osVersion: '17.0',
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
      status: 'unavailable',
      observationConfidence: null,
      height: null,
      cameraOriginMatrix: null,
      joints: [],
    },
  ],
};
const digest = 'a'.repeat(64);
const ready: MotionReviewReady = {
  artifactSha256: digest,
  durationMs: 1000,
  frameCount: 1,
  sourceState: 'verified',
  clock: 'video',
  scaleBasis: 'reference',
};
const progress: MotionReviewProgress = {
  artifactSha256: digest,
  durationMs: 1000,
  positionMs: 300,
  actualPositionMs: 300,
  seeking: false,
  commandId: 0,
  jointCount: 17,
  playing: true,
  canStepBackward: true,
  canStepForward: true,
  rate: 0.5,
  mode: 'motion',
  sourceState: 'verified',
  clock: 'video',
  frameIndex: 9,
  sourceFrameIndex: 9,
  poseTimestampMs: 300,
  frameStatus: 'estimated',
};

it('accepts only ready metadata matching the requested artifact and a coherent clock', () => {
  expect(readMotionReviewReady(ready, artifact, digest)).toBe(ready);
  for (const change of [
    { artifactSha256: 'old' },
    { durationMs: 1001 },
    { durationMs: NaN },
    { frameCount: 2 },
    { scaleBasis: 'calibrated' },
    { sourceState: 'missing' },
    { clock: 'js' },
  ]) {
    expect(
      readMotionReviewReady({ ...ready, ...change }, artifact, digest),
    ).toBeNull();
  }
  expect(
    readMotionReviewReady(
      { ...ready, sourceState: 'missing', clock: 'pose_only' },
      artifact,
      digest,
    ),
  ).not.toBeNull();
});

it('accepts only bounded native progress and never treats another clock as synchronized video', () => {
  expect(readMotionReviewProgress(progress, 1000, digest)).toBe(progress);
  for (const change of [
    { artifactSha256: 'old' },
    { durationMs: 1001 },
    { positionMs: NaN },
    { positionMs: Infinity },
    { positionMs: -1 },
    { positionMs: 1001 },
    { playing: 1 },
    { canStepBackward: 1 },
    { canStepForward: null },
    { rate: 0 },
    { rate: 2 },
    { frameIndex: 1.5 },
    { sourceFrameIndex: -1 },
    { poseTimestampMs: 1001 },
    { frameStatus: 'confident' },
    { mode: 'exemplar' },
    { clock: 'pose_only' },
    { frameIndex: null },
    { poseTimestampMs: null },
  ]) {
    expect(
      readMotionReviewProgress({ ...progress, ...change }, 1000, digest),
    ).toBeNull();
  }
  const missing = {
    ...progress,
    sourceState: 'missing',
    clock: 'pose_only',
    sourceFrameIndex: null,
  };
  expect(readMotionReviewProgress(missing, 1000, digest)).not.toBeNull();
  expect(
    readMotionReviewProgress({ ...missing, mode: 'recording' }, 1000, digest),
  ).toBeNull();
  expect(
    readMotionReviewProgress({ ...missing, sourceFrameIndex: 5 }, 1000, digest),
  ).toBeNull();
});

it('preserves explicit no-person, multiple-person, insufficient-joint and unsampled states', () => {
  expect(
    motionFrameDescription({ ...progress, frameStatus: 'no_person' }),
  ).toContain('No person');
  expect(
    motionFrameDescription({ ...progress, frameStatus: 'multiple_people' }),
  ).toContain('No body is selected');
  expect(
    motionFrameDescription({ ...progress, frameStatus: 'unavailable' }),
  ).toContain('unavailable');
  expect(
    motionFrameDescription({ ...progress, frameStatus: 'insufficient_joints' }),
  ).toContain('Not enough');
  expect(motionFrameDescription({ ...progress, frameStatus: 'gap' })).toContain(
    'gaps are not filled',
  );
  expect(motionFrameDescription(progress)).toBe(
    'Raw estimate · source frame 10 at 0.30s',
  );
  expect(motionFrameDescription(null)).toContain('native playback');
});

it('clamps scrub requests and rejects undefined geometry or duration instead of starting a JS clock', () => {
  expect(motionReviewSeek(50, 200, 1000)).toBe(250);
  expect(motionReviewSeek(-20, 200, 1000)).toBe(0);
  expect(motionReviewSeek(500, 200, 1000)).toBe(1000);
  expect(motionReviewSeek(50, 0, 1000)).toBeNull();
  expect(motionReviewSeek(NaN, 200, 1000)).toBeNull();
  expect(motionReviewSeek(50, Infinity, 1000)).toBeNull();
  expect(motionReviewSeek(50, 200, 0)).toBeNull();
  expect(motionReviewSeek(50, 200, 60_001)).toBeNull();
  expect(motionReviewClock(NaN)).toBe('0.00s');
  expect(motionReviewClock(-5)).toBe('0.00s');
  expect(motionReviewClock(1234)).toBe('1.23s');
  expect(MOTION_REVIEW_SPEEDS).toEqual([0.25, 0.5, 1]);
});

it('discloses reference and estimated body scale without treating either as a calibrated measurement', () => {
  expect(motionScaleDescription('reference')).toContain(
    '1.8 m reference height',
  );
  expect(motionScaleDescription('reference')).toContain(
    'not your measured height',
  );
  expect(motionScaleDescription('measured')).toContain(
    'not a calibrated body measurement',
  );
  expect(motionScaleDescription('mixed')).toContain('It is not calibrated');
  expect(motionScaleDescription('unavailable')).toContain(
    'No body-scale estimate',
  );
});

it('keeps integrity, private-path and timing failures distinct from missing-video fallback', () => {
  expect(motionReviewError('artifact_digest_mismatch')).toContain(
    'integrity check',
  );
  expect(motionReviewError('source_digest_mismatch')).toContain(
    'does not match',
  );
  expect(motionReviewError('invalid_source_uri')).toContain(
    'private Captures folder',
  );
  expect(motionReviewError('source_timing_mismatch')).toContain(
    'source frames',
  );
  expect(motionReviewError('source_unreadable')).toContain('could not be read');
  expect(motionReviewError('unknown')).toContain('invalid or unsupported');
});

it('distinguishes seek intent from acknowledged video and exposes no pose while seeking', () => {
  const seeking: MotionReviewProgress = {
    ...progress,
    positionMs: 160,
    actualPositionMs: 300,
    seeking: true,
    frameStatus: 'seeking',
    frameIndex: null,
    sourceFrameIndex: null,
    poseTimestampMs: null,
    jointCount: 0,
    playing: false,
  };
  expect(readMotionReviewProgress(seeking, 1000, digest)).toEqual(seeking);
  expect(motionFrameDescription(seeking)).toContain('Seeking to 0.16s');
  expect(motionFrameDescription(seeking)).not.toContain('gap');
  for (const change of [
    { frameIndex: 4, poseTimestampMs: 160 },
    { sourceFrameIndex: 4 },
    { jointCount: 12 },
    { frameStatus: 'gap' },
    { seeking: false },
    { actualPositionMs: NaN },
    { commandId: 1.5 },
  ])
    expect(
      readMotionReviewProgress({ ...seeking, ...change }, 1000, digest),
    ).toBeNull();
  expect(
    readMotionReviewProgress(
      { ...progress, actualPositionMs: 299 },
      1000,
      digest,
    ),
  ).toBeNull();
});

it('names partial estimates instead of presenting a fragmented surface as a complete body', () => {
  expect(motionFrameDescription({ ...progress, jointCount: 12 })).toBe(
    'Partial estimate · 12 of 17 joints available at 0.30s',
  );
  expect(
    readMotionReviewProgress({ ...progress, jointCount: 18 }, 1000, digest),
  ).toBeNull();
});

const nativeSDKTest =
  nativePlatform === 'darwin' &&
  spawnSync('/usr/bin/xcrun', ['--find', 'swift'], { timeout: 5000 }).status ===
    0
    ? it
    : it.skip;

nativeSDKTest(
  'executes the actual Swift control-buffer budgets, continuity holds and latest-only seek queue',
  () => {
    const source = readFileSync(
      join(
        dirname(expect.getState().testPath ?? ''),
        '../ios/LocalPods/PickleNative/Sources/PickleMotionReview.swift',
      ),
      'utf8',
    );
    const start = source.indexOf('private enum MotionReviewFailure:');
    const end = source.indexOf('private enum MotionReviewDecoder {');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source).not.toContain('CMSampleBufferGetTotalSampleSize');
    expect(source).not.toContain('cancelPendingSeeks');
    const directory = mkdtempSync(
      join(tmpdir(), 'pickle-review-native-regression-'),
    );
    const harness = join(directory, 'main.swift');
    const assertions = `
private func runChecks() throws {
func stamp(_ ms: Double) -> CMTime { CMTime(seconds: ms / 1000, preferredTimescale: 1_000_000) }
func rejected(_ block: () throws -> Void) -> Bool { do { try block(); return false } catch { return true } }
var timeline = MotionReviewSourceTimeline(durationMs: 1000)
try timeline.consume(sampleCount: 0, pts: .zero)
for index in 0..<25 { try timeline.consume(sampleCount: 1, pts: stamp(Double(index) * 40)) }
try timeline.consume(sampleCount: 0, pts: .invalid)
try timeline.consume(sampleCount: 0, pts: .invalid)
try timeline.consume(sampleCount: 0, pts: stamp(1000))
precondition(timeline.times.count == 25)
precondition(CMTimeCompare(timeline.times[4], stamp(160)) == 0)
precondition(CMTimeCompare(timeline.times[5], stamp(200)) == 0)
for time in [CMTime.invalid, .indefinite, .positiveInfinity, stamp(-1), stamp(1001)] {
  var invalid = MotionReviewSourceTimeline(durationMs: 1000)
  precondition(rejected { try invalid.consume(sampleCount: 1, pts: time) })
}
for count in [-1, 2] {
  var invalid = MotionReviewSourceTimeline(durationMs: 1000)
  precondition(rejected { try invalid.consume(sampleCount: count, pts: .zero) })
}
var bufferBound = MotionReviewSourceTimeline(durationMs: 1000)
for _ in 0..<MotionReviewSourceTimeline.maximumBuffers { try bufferBound.consume(sampleCount: 0, pts: .invalid) }
precondition(rejected { try bufferBound.consume(sampleCount: 0, pts: .invalid) })
var frameBound = MotionReviewSourceTimeline(durationMs: 60_000)
for index in 0..<MotionReviewSourceTimeline.maximumFrames { try frameBound.consume(sampleCount: 1, pts: stamp(Double(index))) }
precondition(rejected { try frameBound.consume(sampleCount: 1, pts: stamp(15000)) })
let ticket = MotionReviewLoadTicket()
ticket.cancel()
precondition(rejected { try ticket.check() })
func frame(_ index: Int, _ ms: Double, _ status: String = "estimated", _ segment: Int = 0) -> MotionReviewFrame {
  MotionReviewFrame(frameIndex: index, timestampMs: ms, pts: stamp(ms), segmentId: segment, status: status, joints: [:])
}
func document(_ fps: Double, _ frames: [MotionReviewFrame]) -> MotionReviewDocument {
  MotionReviewDocument(durationMs: 1000, nominalFrameRate: fps, videoSha256: "", videoByteLength: 1, width: 1, height: 1, frames: frames, scaleBasis: "reference")
}
let forty = document(40, [frame(0, 0), frame(2, 50), frame(4, 100)])
precondition(forty.sampleIndex(at: 25) == 0 && forty.sampleIndex(at: 49) == 0)
precondition(forty.sampleIndex(at: 50) == 1 && forty.sampleIndex(at: 99) == 1)
let fifty = document(50, [frame(0, 0), frame(2, 40), frame(4, 80)])
precondition(fifty.sampleIndex(at: 39) == 0 && fifty.sampleIndex(at: 79) == 1)
let variable = document(50, [frame(0, 0), frame(2, 40), frame(5, 106), frame(8, 172)])
precondition(variable.sampleIndex(at: 100) == 1 && variable.sampleIndex(at: 170) == 2)
let longGap = document(50, [frame(0, 0), frame(25, 500)])
precondition(longGap.sampleIndex(at: 99) == 0 && longGap.sampleIndex(at: 101) == nil && longGap.sampleIndex(at: 499) == nil)
for status in ["no_person", "multiple_people", "unavailable"] {
  let gap = document(50, [frame(0, 0), frame(2, 40, status), frame(4, 80, "estimated", 1)])
  precondition(gap.sampleIndex(at: 0) == 0 && gap.sampleIndex(at: 20) == nil)
  precondition(gap.sampleIndex(at: 40) == 1 && gap.sampleIndex(at: 60) == 1 && gap.sampleIndex(at: 80) == 2)
}
let segment = document(50, [frame(0, 0), frame(2, 40, "estimated", 1)])
precondition(segment.sampleIndex(at: 20) == nil)
let last = document(25, [frame(0, 100)])
precondition(last.sampleIndex(at: 99) == nil && last.sampleIndex(at: 139) == 0 && last.sampleIndex(at: 141) == nil)
precondition(last.sampleIndex(at: .nan) == nil && last.sampleIndex(at: -1) == nil && last.sampleIndex(at: 1001) == nil)
var queue = MotionReviewSeekQueue()
queue.offer(stamp(0))
precondition(CMTimeCompare(queue.begin()!, stamp(0)) == 0)
for ms in stride(from: 40, through: 800, by: 40) {
  queue.offer(stamp(Double(ms)))
  precondition(queue.begin() == nil)
}
queue.finish()
precondition(CMTimeCompare(queue.begin()!, stamp(800)) == 0)
queue.offer(stamp(800))
precondition(queue.pending == nil)
queue.offer(stamp(160))
queue.offer(stamp(800))
precondition(queue.pending == nil)
queue.finish()
precondition(queue.begin() == nil)
print("native motion review regression checks passed")
}
try runChecks()
`;
    try {
      writeFileSync(
        harness,
        'import Foundation\nimport CoreMedia\nimport simd\n' +
          source.slice(start, end) +
          assertions,
      );
      expect(
        execFileSync(
          '/usr/bin/xcrun',
          ['swift', '-swift-version', '5', harness],
          { encoding: 'utf8', timeout: 45000 },
        ),
      ).toContain('native motion review regression checks passed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60000,
);
