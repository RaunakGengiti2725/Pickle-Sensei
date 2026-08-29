// The screen module pulls in the SQLite-backed db, whose native binding does
// not exist under jest. The pure gating/presentation logic under test never
// touches it, so the db module is replaced wholesale.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  CaptureAnalysisRecord,
  StrokeIntentEnvelope,
} from '@pickle/analysis-pipeline';
import type { TechniqueIntent } from '@pickle/shared-types';
import {
  canAutoScoreWithoutDeclaration,
  strokeIntentPresentation,
} from '../src/screens/AnalyzeScreen';
import {
  autoDetectIntent,
  TechniqueIntentPicker,
} from '../src/flow/TechniqueIntentPicker';
import { assertCapturedClip } from '../src/camera/capture';

/**
 * W4 — AUTO DETECT admission + honest outcome surface.
 *
 * The chip emits a REAL intent ({source:'auto'}, distinguishable from
 * "nothing selected"); only guided captures with a recorded pose sequence
 * may analyze declared-null; imported videos stay declared-only; and the
 * outcome surface reports the strokeIntent envelope without relabeling it.
 */

const baseClip = {
  uri: 'file:///private/var/mobile/clip.mov',
  durationMs: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
};

const trigger = {
  startMs: 2000,
  endMs: 2700,
  peakMotionMs: 2400,
  confidence: 0.82,
  source: 'temporal_pose_motion',
  modelVersion: 'temporal-stroke-heuristic-2',
};

const captureEvidence = {
  schemaVersion: 1,
  window: 'detected_motion',
  poseSource: 'apple_vision_body_pose',
  poseModelVersion: 'apple-vision-bodypose-1',
  triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
  motionUnit: 'normalized_image_units_per_second',
  analysisInputFrameCount: 7,
  poseFrameCount: 6,
  poseMissingFrameCount: 1,
  trackedDurationMs: 620,
  meanCanonicalJointVisibility: 0.88,
  meanJointCoverage: 0.94,
  minimumJointCoverage: 0.83,
  fullBodyVisibleFrameCount: 4,
  jointMotion: [
    {
      joint: 'left_wrist',
      sampleCount: 5,
      meanNormalizedPerSecond: 1.1,
      peakNormalizedPerSecond: 2.4,
    },
  ],
};

const guidedWithPose = assertCapturedClip({
  ...baseClip,
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger,
  captureEvidence,
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 2000,
  postRollMs: 1500,
  poseSequence: {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: 'file:///private/var/mobile/clip.pose.json',
    frameCount: 6,
    sha256: 'a'.repeat(64),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
  },
});

const guidedWithoutPose = assertCapturedClip({
  ...baseClip,
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger,
  captureEvidence,
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 2000,
  postRollMs: 1500,
});

const importedClip = assertCapturedClip({
  ...baseClip,
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
});

const tapIntent: TechniqueIntent = {
  version: 'technique-intent-v1',
  source: 'tap',
  canonical: 'FOREHAND_DRIVE',
  legacySlug: 'forehand_drive',
  confidence: 1,
};

function record(
  strokeIntent: StrokeIntentEnvelope,
  result: { shotType: string } | null,
): CaptureAnalysisRecord {
  // Presentation reads only strokeIntent + result; the full record shape is
  // exercised end to end by autoDetectAnalysis.test.ts with real records.
  return { strokeIntent, result } as unknown as CaptureAnalysisRecord;
}

describe('canAutoScoreWithoutDeclaration', () => {
  it('admits declared-null analysis only for guided captures with a pose sequence and an armed auto intent', () => {
    expect(
      canAutoScoreWithoutDeclaration(guidedWithPose, autoDetectIntent()),
    ).toBe(true);
  });

  it('refuses when auto is not armed — null and tap intents are not auto', () => {
    expect(canAutoScoreWithoutDeclaration(guidedWithPose, null)).toBe(false);
    expect(canAutoScoreWithoutDeclaration(guidedWithPose, tapIntent)).toBe(
      false,
    );
  });

  it('refuses pose-less guided captures — there is nothing real to classify', () => {
    expect(
      canAutoScoreWithoutDeclaration(guidedWithoutPose, autoDetectIntent()),
    ).toBe(false);
  });

  it('keeps imported videos declared-only', () => {
    expect(
      canAutoScoreWithoutDeclaration(importedClip, autoDetectIntent()),
    ).toBe(false);
  });
});

describe('TechniqueIntentPicker AUTO chip', () => {
  it('emits a real auto intent — distinguishable from "nothing selected"', async () => {
    const onChange = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TechniqueIntentPicker value={null} onChange={onChange} />,
      );
    });
    const [autoChip] = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Auto detect' &&
        typeof node.props.onPress === 'function',
    );
    await act(async () => {
      autoChip!.props.onPress();
    });
    expect(onChange).toHaveBeenCalledWith({
      version: 'technique-intent-v1',
      source: 'auto',
      canonical: null,
      legacySlug: null,
      confidence: null,
    });
  });

  it('shows honest copy when auto is selected: family-level reads, no exact-stroke promise', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TechniqueIntentPicker
          value={autoDetectIntent()}
          onChange={jest.fn()}
        />,
      );
    });
    const copy = JSON.stringify(renderer.toJSON());
    expect(copy).toContain('forehand or backhand');
    expect(copy).toContain('not the exact stroke');
    expect(copy).toContain('withholds the result instead of guessing');
    // The old gating promise is gone.
    expect(copy).not.toContain('arrives with the verified stroke classifier');
    const [autoChip] = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Auto detect' &&
        node.props.accessibilityState !== undefined,
    );
    expect(autoChip!.props.accessibilityState.selected).toBe(true);
  });

  it('still emits concrete tap intents for technique chips', async () => {
    const onChange = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TechniqueIntentPicker value={null} onChange={onChange} />,
      );
    });
    const [chip] = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Forehand Drive' &&
        typeof node.props.onPress === 'function',
    );
    await act(async () => {
      chip!.props.onPress();
    });
    expect(onChange).toHaveBeenCalledWith({
      version: 'technique-intent-v1',
      source: 'tap',
      canonical: 'FOREHAND_DRIVE',
      legacySlug: 'forehand_drive',
      confidence: 1,
    });
  });
});

describe('strokeIntentPresentation', () => {
  it('reports a committed-leaf auto run and offers the full result', () => {
    const presentation = strokeIntentPresentation(
      record(
        {
          declaredStroke: null,
          predictedStroke: {
            taxonomyVersion: 'pickleball-stroke-taxonomy-v3',
            classifierVersion: 'stroke-heuristic-1 (uncalibrated)',
            label: 'OVERHEAD',
            leaf: 'OVERHEAD',
            taxonomyDepth: 1,
            confidence: 0.7,
            evidence: [],
            limitingFactors: [],
          },
          resolutionBasis: 'predicted_l3',
          resolvedProfileId: 'OVERHEAD',
          resolvedProfileVersion: 'technique-profile-v1',
          disagreement: null,
        },
        { shotType: 'overhead' },
      ),
    );
    expect(presentation?.title).toBe('Auto-detected: OVERHEAD');
    expect(presentation?.showResult).toBe(true);
    expect(presentation?.body).toContain('stored as a prediction');
  });

  it('surfaces a declared-vs-predicted disagreement without overriding the declaration', () => {
    const presentation = strokeIntentPresentation(
      record(
        {
          declaredStroke: 'forehand_drive',
          predictedStroke: {
            taxonomyVersion: 'pickleball-stroke-taxonomy-v3',
            classifierVersion: 'stroke-heuristic-1 (uncalibrated)',
            label: 'BACKHAND',
            leaf: null,
            taxonomyDepth: 2,
            confidence: 0.7,
            evidence: [],
            limitingFactors: [],
          },
          resolutionBasis: 'declared',
          resolvedProfileId: 'FOREHAND_DRIVE',
          resolvedProfileVersion: 'technique-profile-v1',
          disagreement: {
            declared: 'forehand_drive',
            predictedLabel: 'BACKHAND',
            basis: 'side_vs_declared',
          },
        },
        { shotType: 'forehand_drive' },
      ),
    );
    expect(presentation?.title).toBe(
      'You declared forehand drive — the camera read BACKHAND.',
    );
    expect(presentation?.body).toContain('Your declaration was kept');
    expect(presentation?.showResult).toBe(true);
  });

  it('returns null for a clean declared run — that path is unchanged', () => {
    const presentation = strokeIntentPresentation(
      record(
        {
          declaredStroke: 'forehand_drive',
          predictedStroke: null,
          resolutionBasis: 'declared',
          resolvedProfileId: 'FOREHAND_DRIVE',
          resolvedProfileVersion: 'technique-profile-v1',
          disagreement: null,
        },
        { shotType: 'forehand_drive' },
      ),
    );
    expect(presentation).toBeNull();
  });
});
