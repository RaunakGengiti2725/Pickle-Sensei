import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { CaptureEvidenceCard } from '../src/camera/CaptureEvidenceCard';
import type { CapturedClip } from '../src/camera/capture';

const clip: CapturedClip = {
  uri: 'file:///private/captures/real.mov',
  durationMs: 3900,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger: {
    startMs: 1800,
    endMs: 2450,
    peakMotionMs: 2220,
    confidence: 0.84,
    source: 'temporal_pose_motion',
    modelVersion: 'temporal-stroke-heuristic-2',
  },
  captureEvidence: {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    analysisInputFrameCount: 8,
    poseFrameCount: 7,
    poseMissingFrameCount: 1,
    trackedDurationMs: 600,
    meanCanonicalJointVisibility: 0.86,
    meanJointCoverage: 0.93,
    minimumJointCoverage: 0.83,
    fullBodyVisibleFrameCount: 5,
    jointMotion: [
      {
        joint: 'left_wrist',
        sampleCount: 6,
        meanNormalizedPerSecond: 1.2,
        peakNormalizedPerSecond: 2.1,
      },
    ],
  },
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 1800,
  postRollMs: 1450,
};

describe('CaptureEvidenceCard', () => {
  it('renders measured motion while keeping physical speed explicitly unavailable', async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(<CaptureEvidenceCard clip={clip} />);
    });
    const text = renderer!.root
      .findAllByType(Text)
      .flatMap(node => node.props.children)
      .filter(value => typeof value === 'string')
      .join(' ');

    expect(text).toContain('MEASURED MOTION');
    expect(text).toContain('left wrist');
    expect(text).toContain('POSE FRAMES');
    expect(text).toContain('Not measured');
    expect(text).toContain('never converted to MPH');
    expect(text).not.toMatch(/\b\d+(\.\d+)? MPH\b/);
  });
});
