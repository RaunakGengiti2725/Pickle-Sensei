// The screen module pulls in the SQLite-backed db, whose native binding does
// not exist under jest. The pure gating/presentation logic under test never
// touches it, so the db module is replaced wholesale.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/data/repository', () => ({
  ...jest.requireActual('../src/data/repository'),
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
  setCaptureTargetSeed: jest.fn(async () => {}),
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  ...jest.requireActual('../src/analysis/runCaptureAnalysis'),
  runCaptureAnalysis: jest.fn(),
  prepareOriginalCaptureAnalysis: jest.fn(),
  runOriginalCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/analysis/originalAnalysisOperations', () => {
  const actual = jest.requireActual(
    '../src/analysis/originalAnalysisOperations',
  );
  return {
    ...actual,
    originalAnalysisOperations: {
      ...actual.originalAnalysisOperations,
      read: jest.fn(),
    },
  };
});
jest.mock('../src/analysis/practiceSet', () => ({
  planPracticeSet: jest.fn(async () => null),
}));
jest.mock('../src/data/syncRuntime', () => ({ triggerOutboxSync: jest.fn() }));
jest.mock('../src/review/appStoreReview', () => ({
  reportScoredAnalysisForReview: jest.fn(),
}));
jest.mock('../src/camera/capture', () => ({
  ...jest.requireActual('../src/camera/capture'),
  captureStrokeVideo: jest.fn(),
  importStrokeVideo: jest.fn(),
  extractImportedPoseSequence: jest.fn(),
  subscribeToCameraEvents: jest.fn(() => () => {}),
  cancelCameraOperation: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
}));
const mockNavigation = {
  replace: jest.fn(),
  navigate: jest.fn(),
  goBack: jest.fn(),
  popToTop: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: 'camera' } }),
}));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  AnalysisInputSelectionSnapshot,
  CaptureAnalysisRecord,
  StrokeIntentEnvelope,
} from '@pickle/analysis-pipeline';
import type { TechniqueIntent } from '@pickle/shared-types';
import {
  AnalyzeScreen,
  canAutoScoreWithoutDeclaration,
  strokeIntentPresentation,
} from '../src/screens/AnalyzeScreen';
import {
  prepareOriginalCaptureAnalysis,
  runCaptureAnalysis,
  runOriginalCaptureAnalysis,
} from '../src/analysis/runCaptureAnalysis';
import {
  originalAnalysisOperations,
  type OriginalAnalysisOperation,
} from '../src/analysis/originalAnalysisOperations';
import { getDb } from '../src/data/db';
import {
  savePendingCapture,
  setCaptureTargetSeed,
  setDeclaredStroke,
} from '../src/data/repository';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  captureDataOwnerContext,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { Button, ScreenHeader } from '../src/design/components';
import { reportScoredAnalysisForReview } from '../src/review/appStoreReview';
import { triggerOutboxSync } from '../src/data/syncRuntime';
import {
  autoDetectIntent,
  TechniqueIntentPicker,
} from '../src/flow/TechniqueIntentPicker';
import {
  assertCapturedClip,
  captureStrokeVideo,
  importStrokeVideo,
  extractImportedPoseSequence,
} from '../src/camera/capture';

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

function screenInputSelection(
  captureId: string,
): AnalysisInputSelectionSnapshot {
  return {
    version: 'capture-analysis-input-v1',
    ownerKey: '22222222-2222-4222-8222-222222222222',
    ownerGeneration: captureDataOwnerContext().generation,
    apiOrigin: 'https://api.test',
    captureId,
    observationHash: 'a'.repeat(64),
    definitionHash: 'b'.repeat(64),
    modelPolicyHash: 'c'.repeat(64),
    capture: {
      captureMode: 'automatic_pose_trigger',
      capturedAtIso: baseClip.capturedAtIso,
      durationMs: baseClip.durationMs,
      width: baseClip.width,
      height: baseClip.height,
      fps: baseClip.fps,
      poseFrameCount: 6,
      poseModelVersion: 'apple-vision-bodypose-1',
      poseUri: 'file:///private/var/mobile/clip.pose.json',
      payloadHash: 'd'.repeat(64),
    },
    trigger: { ...trigger, peakMotionMs: trigger.peakMotionMs },
    declaredStroke: null,
    declaredCanonical: null,
    handedness: 'left',
    cameraView: 'rear_oblique',
    focusCheckpoint: 'swing_length',
    target: { userSelection: null, guidedStartTap: null, acquiredAnchor: null },
  };
}

describe('W03 same-capture confirmation screen', () => {
  beforeEach(() => {
    setActiveDataOwner('22222222-2222-4222-8222-222222222222');
    establishApiSession({
      canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token',
      provider: 'apple',
    });
  });
  afterEach(() => {
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    jest.clearAllMocks();
  });

  it('mounts a loaded pending confirmation with the same capture and no native operation', async () => {
    setActiveDataOwner('22222222-2222-4222-8222-222222222222');
    (getDb as jest.Mock).mockReturnValue({
      execute: jest.fn(async () => ({ rows: [] })),
    });
    const captureId = '44444444-4444-4444-8444-444444444444';
    const stored = {
      ...record(
        {
          declaredStroke: null,
          predictedStroke: null,
          resolutionBasis: 'abstained',
          resolvedProfileId: null,
          resolvedProfileVersion: null,
          disagreement: null,
        },
        null,
      ),
      id: '33333333-3333-4333-8333-333333333333',
      captureId,
      kind: 'needs_technique_confirmation' as const,
      confirmationReason: 'unresolved_technique' as const,
      result: null,
      captureEnvelope: null,
      observationHash: 'a'.repeat(64),
      inputSelection: screenInputSelection(captureId),
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(
          <AnalyzeScreen
            savedTechniqueConfirmation={{
              captureId,
              clip: guidedWithPose,
              record: stored,
              ownerContext: captureDataOwnerContext(),
              apiOrigin: 'https://api.test',
              targetSeed: null,
            }}
          />,
        );
      });
      expect(renderer.root.findByType(ScreenHeader).props.title).toBe(
        'Confirm technique',
      );
      expect(renderer.root.findAllByType(TechniqueIntentPicker)).toHaveLength(
        1,
      );
      expect(
        renderer.root
          .findAllByType(Button)
          .find(button => button.props.label === 'Confirm technique')?.props
          .disabled,
      ).toBe(true);
      expect(captureStrokeVideo).not.toHaveBeenCalled();
      expect(importStrokeVideo).not.toHaveBeenCalled();
      expect(runCaptureAnalysis).not.toHaveBeenCalled();
      await act(async () => {
        renderer.root
          .findByType(TechniqueIntentPicker)
          .props.onChange(tapIntent);
      });
      const staleConfirm = renderer.root
        .findAllByType(Button)
        .find(button => button.props.label === 'Confirm technique')!.props
        .onPress;
      await act(async () => {
        renderer.root.findByType(ScreenHeader).props.onClose();
        staleConfirm();
      });
      expect(setDeclaredStroke).not.toHaveBeenCalled();
      expect(runCaptureAnalysis).not.toHaveBeenCalled();
    } finally {
      if (renderer) await act(async () => renderer.unmount());
    }
  });

  it('uses the existing picker and one explicit confirmation, not another camera/import or an invented declaration', async () => {
    setActiveDataOwner('22222222-2222-4222-8222-222222222222');
    (getDb as jest.Mock).mockReturnValue({
      execute: jest.fn(async () => ({ rows: [] })),
    });
    (captureStrokeVideo as jest.Mock).mockResolvedValue(guidedWithPose);
    const analysisId = '33333333-3333-4333-8333-333333333333';
    const pending = {
      ...record(
        {
          declaredStroke: null,
          predictedStroke: {
            taxonomyVersion: 'pickleball-stroke-taxonomy-v3',
            classifierVersion: 'heuristic-test',
            label: 'FOREHAND',
            leaf: null,
            taxonomyDepth: 2,
            confidence: 0.9,
            evidence: ['measured side'],
            limitingFactors: [],
          },
          resolutionBasis: 'predicted_family',
          resolvedProfileId: 'SHARED_FOREHAND_SWING',
          resolvedProfileVersion: 'technique-profile-v1',
          disagreement: null,
        },
        null,
      ),
      id: analysisId,
      kind: 'needs_technique_confirmation',
      confirmationReason: 'family_only',
    };
    let finishConfirmation!: (value: unknown) => void;
    let prepared!: OriginalAnalysisOperation;
    // This presentation test stops at the runners' typed boundaries. The
    // full-flow suite exercises the real original store/attempt transitions.
    jest
      .mocked(prepareOriginalCaptureAnalysis)
      .mockImplementationOnce(async (input, execution, operationId) => {
        prepared = {
          operationId: operationId!,
          analysisId,
          settingsHash: 'b'.repeat(64),
          modelPolicyHash: null,
          observation: null,
          executionHash: null,
          currentAttemptId: null,
          finalRecordId: analysisId,
          winningAttemptId: null,
          completionKind: 'needs_technique_confirmation',
          snapshot: {
            version: 'original-analysis-v1',
            ...execution.scope,
            captureId: input.captureId,
            clip: input.clip,
            declaredStroke: input.declaredStroke,
            declaredCanonical: input.declaredCanonical ?? null,
            handedness: input.handedness,
            cameraView: input.cameraView,
            focusCheckpoint: input.focusCheckpoint ?? null,
            targetSeed: input.targetSeed ?? null,
            sessionId: input.sessionId ?? null,
            practiceSet: input.practiceSet ?? null,
            appVersion: input.appVersion,
            modelPolicy: null,
            captureEnvelope: input.captureEnvelope ?? null,
          },
        };
        jest
          .mocked(originalAnalysisOperations.read)
          .mockResolvedValue(prepared);
        return prepared;
      });
    (runOriginalCaptureAnalysis as jest.Mock).mockImplementationOnce(
      async () => ({
        kind: 'needs_technique_confirmation',
        analysisId,
        record: {
          ...pending,
          captureId: prepared.snapshot.captureId,
          observationHash: 'a'.repeat(64),
          captureEnvelope: null,
          inputSelection: screenInputSelection(prepared.snapshot.captureId),
        },
      }),
    );
    (runCaptureAnalysis as jest.Mock).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishConfirmation = resolve;
        }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(<AnalyzeScreen />);
      });
      await act(async () => {
        renderer.root
          .findByType(TechniqueIntentPicker)
          .props.onChange(autoDetectIntent());
      });
      const staleStart = renderer.root
        .findAllByType(Button)
        .find(button => button.props.label === 'Open automatic camera')!.props
        .onPress;
      await act(async () => staleStart());
      expect(prepareOriginalCaptureAnalysis).toHaveBeenCalledTimes(1);
      expect(runOriginalCaptureAnalysis).toHaveBeenCalledTimes(1);
      expect(runCaptureAnalysis).not.toHaveBeenCalled();
      expect(setDeclaredStroke).not.toHaveBeenCalled();
      expect(mockNavigation.replace).not.toHaveBeenCalled();
      expect(triggerOutboxSync).not.toHaveBeenCalled();
      expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
      expect(renderer.root.findAllByType(TechniqueIntentPicker)).toHaveLength(
        1,
      );
      expect(JSON.stringify(renderer.toJSON())).toContain('same saved capture');
      expect(
        renderer.root
          .findAllByType(Button)
          .find(button => button.props.label === 'Confirm technique')?.props
          .disabled,
      ).toBe(true);
      const intent: TechniqueIntent = {
        version: 'technique-intent-v1',
        source: 'tap',
        canonical: 'BACKHAND_DINK',
        legacySlug: 'dink',
        confidence: 1,
      };
      await act(async () => {
        renderer.root.findByType(TechniqueIntentPicker).props.onChange(intent);
      });
      expect(runOriginalCaptureAnalysis).toHaveBeenCalledTimes(1);
      expect(runCaptureAnalysis).not.toHaveBeenCalled();
      await act(async () => {
        const confirm = renderer.root
          .findAllByType(Button)
          .find(button => button.props.label === 'Confirm technique')!;
        confirm.props.onPress();
        confirm.props.onPress();
      });
      expect(runCaptureAnalysis).toHaveBeenCalledTimes(1);
      expect(runOriginalCaptureAnalysis).toHaveBeenCalledTimes(1);
      await act(async () => staleStart());
      expect(captureStrokeVideo).toHaveBeenCalledTimes(1);
      const original = jest.mocked(prepareOriginalCaptureAnalysis).mock
        .calls[0]![0];
      const confirmed = jest.mocked(runCaptureAnalysis).mock.calls[0]![0];
      expect(confirmed).toMatchObject({
        captureId: original.captureId,
        clip: original.clip,
        declaredStroke: 'dink',
        declaredCanonical: 'BACKHAND_DINK',
        ownerContext: original.ownerContext,
        handedness: 'left',
        cameraView: 'rear_oblique',
        focusCheckpoint: 'swing_length',
        signal: expect.any(AbortSignal),
        techniqueConfirmation: {
          analysisId,
          intent,
          confirmedAtIso: expect.any(String),
        },
      });
      expect(captureStrokeVideo).toHaveBeenCalledTimes(1);
      expect(importStrokeVideo).not.toHaveBeenCalled();
      expect(extractImportedPoseSequence).not.toHaveBeenCalled();
      expect(savePendingCapture).toHaveBeenCalledTimes(1);
      await act(async () => {
        renderer.root.findByType(ScreenHeader).props.onClose();
        finishConfirmation({
          kind: 'scored',
          analysisId: 'confirmed-analysis',
          record: {},
          freeLimitReached: false,
        });
      });
      expect(mockNavigation.replace).not.toHaveBeenCalled();
      expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
      expect(triggerOutboxSync).not.toHaveBeenCalled();
      expect(confirmed.signal?.aborted).toBe(true);
      expect(setDeclaredStroke).not.toHaveBeenCalled();
      expect(setCaptureTargetSeed).not.toHaveBeenCalled();
    } finally {
      if (renderer) await act(async () => renderer.unmount());
    }
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
