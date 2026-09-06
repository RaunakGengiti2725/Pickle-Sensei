let mockReducedMotion = false;
let mockViewport = { width: 390, height: 844, scale: 3, fontScale: 1 };

jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  return {
    AppState: native.AppState,
    Platform: { OS: 'ios', Version: 17 },
    Pressable: native.Pressable,
    ScrollView: native.ScrollView,
    StyleSheet: native.StyleSheet,
    Text: native.Text,
    View: native.View,
    UIManager: { getViewManagerConfig: jest.fn(() => ({})) },
    requireNativeComponent: jest.fn(() => 'MotionReviewNative'),
    useWindowDimensions: () => mockViewport,
  };
});
jest.mock('../src/design/components', () => ({
  useReducedMotion: () => mockReducedMotion,
}));
jest.mock('../src/design/icons', () => ({ Icon: () => null }));

import React from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
} from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type { Motion3DArtifact } from '@pickle/swing-domain';
import {
  Motion3DPlayer,
  type Motion3DPlayerProps,
} from '../src/review/Motion3DPlayer';
import type {
  MotionReviewProgress,
  MotionReviewReady,
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
    captureId: 'synthetic-player-test',
    videoSha256: 'b'.repeat(64),
    videoByteLength: 123,
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
  frames: [0, 1].map(index => ({
    frameIndex: index,
    timestampMs: (index * 1000) / 30,
    ptsValue: index,
    ptsTimescale: 30,
    segmentId: 0,
    status: 'estimated',
    observationConfidence: 0.7,
    height: { meters: 1.8, source: 'reference' },
    cameraOriginMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
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
      {
        name: 'spine',
        x: 0,
        y: 0.2,
        z: 0,
        imageX: 0.5,
        imageY: 0.4,
        confidence: null,
        visibility2D: null,
      },
    ],
  })),
};
const digest = 'a'.repeat(64);
const props: Motion3DPlayerProps = {
  artifact,
  artifactJson: JSON.stringify(artifact),
  artifactSha256: digest,
  videoUri:
    'file:///private/Library/Application%20Support/PickleSensei/Captures/synthetic.mov',
  fill: true,
};
const loaded: MotionReviewReady = {
  artifactSha256: digest,
  durationMs: 1000,
  frameCount: 2,
  sourceState: 'verified',
  clock: 'video',
  scaleBasis: 'reference',
};
const progress: MotionReviewProgress = {
  artifactSha256: digest,
  durationMs: 1000,
  positionMs: 0,
  actualPositionMs: 0,
  seeking: false,
  commandId: -1,
  jointCount: 17,
  playing: false,
  canStepBackward: false,
  canStepForward: true,
  rate: 1,
  mode: 'motion',
  sourceState: 'verified',
  clock: 'video',
  frameIndex: 0,
  poseTimestampMs: 0,
  sourceFrameIndex: 0,
  frameStatus: 'estimated',
};
let tree: ReactTestRenderer;

function byId(id: string): ReactTestInstance {
  return tree.root.findAll(node => node.props.testID === id)[0]!;
}

function press(id: string) {
  act(() => {
    byId(id).props.onPress();
  });
}

function nativeReady(overrides: Partial<MotionReviewReady> = {}) {
  act(() => {
    byId('motion3d-native').props.onReviewReady({
      nativeEvent: { ...loaded, ...overrides },
    });
  });
}

function nativeProgress(overrides: Partial<MotionReviewProgress> = {}) {
  act(() => {
    byId('motion3d-native').props.onReviewProgress({
      nativeEvent: {
        ...progress,
        actualPositionMs: overrides.positionMs ?? 0,
        commandId: byId('motion3d-native').props.command?.id ?? -1,
        jointCount: [
          'gap',
          'seeking',
          'no_person',
          'multiple_people',
          'unavailable',
        ].includes(overrides.frameStatus ?? '')
          ? 0
          : 17,
        canStepBackward: (overrides.positionMs ?? 0) > 0,
        canStepForward: (overrides.positionMs ?? 0) < 1000,
        ...overrides,
      },
    });
  });
}

function inside(node: ReactTestInstance, type: unknown): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === type) return true;
  }
  return false;
}

beforeEach(() => {
  mockReducedMotion = false;
  mockViewport = { width: 390, height: 844, scale: 3, fontScale: 1 };
  act(() => {
    tree = TestRenderer.create(<Motion3DPlayer {...props} />);
  });
});

afterEach(() => {
  act(() => tree.unmount());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('sends one serialized artifact, not React joints or a second player, and waits for native verification', () => {
  const native = byId('motion3d-native');
  expect(native.props.artifactJson).toBe(props.artifactJson);
  expect(native.props.artifactSha256).toBe(digest);
  expect(native.props.videoUri).toBe(props.videoUri);
  expect(native.props.artifact).toBeUndefined();
  expect(native.props.frames).toBeUndefined();
  expect(native.props.joints).toBeUndefined();
  expect(byId('motion3d-play').props.disabled).toBe(true);
  expect(byId('motion3d-native').props.command).toBeNull();
  nativeReady();
  expect(byId('motion3d-play').props.disabled).toBe(false);
  expect(byId('motion3d-native').props.command).toBeNull();
  expect(
    tree.root.findAll(node => node.type === ('MotionReviewNative' as never)),
  ).toHaveLength(1);
});

it.each([
  ['android', 35, true],
  ['ios', 16, true],
  ['ios', 'unknown', true],
  ['ios', 17, false],
])(
  'does not offer native playback on %s %s with native availability %s',
  (os, version, available) => {
    jest.isolateModules(() => {
      const native = require('react-native');
      Object.assign(native.Platform, { OS: os, Version: version });
      native.UIManager.getViewManagerConfig.mockReturnValue(
        available ? {} : null,
      );
      const player = require('../src/review/Motion3DPlayer');
      expect(player.motion3DPlaybackAvailable()).toBe(false);
    });
  },
);

it('uses native progress only, even when JS timers advance', () => {
  jest.useFakeTimers();
  nativeReady();
  nativeProgress({
    positionMs: 200,
    playing: true,
    frameStatus: 'gap',
    frameIndex: null,
    poseTimestampMs: null,
    sourceFrameIndex: 6,
  });
  expect(byId('motion3d-timeline').props.accessibilityValue.now).toBe(200);
  act(() => jest.advanceTimersByTime(10_000));
  expect(byId('motion3d-timeline').props.accessibilityValue.now).toBe(200);
  expect(byId('motion3d-native').props.artifactJson).toBe(props.artifactJson);
  nativeProgress({ positionMs: 900, artifactSha256: 'stale' });
  nativeProgress({ positionMs: Number.NaN });
  expect(byId('motion3d-timeline').props.accessibilityValue.now).toBe(200);
});

it('keeps play, source-frame steps, repeated seeks, speeds and view switching on the native command API', () => {
  nativeReady();
  nativeProgress();
  press('motion3d-play');
  expect(byId('motion3d-native').props.command).toMatchObject({
    action: 'play',
    id: 1,
  });
  nativeProgress({ playing: true, positionMs: 100 });
  press('motion3d-play');
  expect(byId('motion3d-native').props.command.action).toBe('pause');
  press('motion3d-previous');
  expect(byId('motion3d-native').props.command).toMatchObject({
    action: 'step',
    value: -1,
  });
  press('motion3d-next');
  expect(byId('motion3d-native').props.command).toMatchObject({
    action: 'step',
    value: 1,
  });
  press('motion3d-speed');
  expect(byId('motion3d-native').props.command).toMatchObject({
    action: 'rate',
    value: 0.25,
  });
  nativeProgress({ rate: 0.25 });
  press('motion3d-speed');
  expect(byId('motion3d-native').props.command).toMatchObject({
    action: 'rate',
    value: 0.5,
  });
  nativeProgress({ rate: 0.5 });
  press('motion3d-speed');
  expect(byId('motion3d-native').props.command).toMatchObject({
    action: 'rate',
    value: 1,
  });
  act(() =>
    byId('motion3d-timeline').props.onLayout({
      nativeEvent: { layout: { width: 200 } },
    }),
  );
  act(() =>
    byId('motion3d-timeline').props.onResponderGrant({
      nativeEvent: { locationX: 50 },
    }),
  );
  const firstSeek = byId('motion3d-native').props.command;
  expect(firstSeek).toMatchObject({ action: 'seek', value: 250 });
  act(() => byId('motion3d-timeline').props.onResponderRelease());
  expect(byId('motion3d-native').props.command.id).toBeGreaterThan(
    firstSeek.id,
  );
  expect(byId('motion3d-native').props.command.value).toBe(250);
  press('motion3d-mode-recording');
  expect(byId('motion3d-native').props.command.action).toBe('recording');
  nativeProgress({ mode: 'recording', positionMs: 250 });
  expect(byId('motion3d-turnLeft').props.disabled).toBe(true);
  expect(
    byId('motion3d-mode-recording').props.accessibilityState.selected,
  ).toBe(true);
  press('motion3d-mode-motion');
  expect(byId('motion3d-native').props.command.action).toBe('motion');
});

it('uses native source-frame boundaries rather than clip duration to enable frame buttons', () => {
  nativeReady();
  nativeProgress({
    positionMs: 966,
    canStepBackward: true,
    canStepForward: false,
  });
  expect(byId('motion3d-next').props.disabled).toBe(true);
  expect(byId('motion3d-previous').props.disabled).toBe(false);
  nativeProgress({
    positionMs: 20,
    canStepBackward: false,
    canStepForward: true,
  });
  expect(byId('motion3d-previous').props.disabled).toBe(true);
  expect(byId('motion3d-next').props.disabled).toBe(false);
});

it('provides visible 44-point camera controls outside the scene and leaves transport outside scrolling information', () => {
  nativeReady();
  for (const action of [
    'turnLeft',
    'turnRight',
    'zoomOut',
    'zoomIn',
    'reset',
  ]) {
    const button = byId(`motion3d-${action}`);
    const style = StyleSheet.flatten(button.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
    expect(button.props.accessibilityRole).toBe('button');
    press(`motion3d-${action}`);
    expect(byId('motion3d-native').props.command.action).toBe(action);
  }
  expect(byId('motion3d-stage').findAllByType(Pressable)).toHaveLength(0);
  expect(inside(byId('motion3d-stage'), ScrollView)).toBe(true);
  expect(inside(byId('motion3d-transport'), ScrollView)).toBe(false);
  expect(
    StyleSheet.flatten(byId('motion3d-timeline').props.style).minHeight,
  ).toBeGreaterThanOrEqual(44);
});

it('keeps information scrollable and text untruncated on a small phone with large Dynamic Type', () => {
  mockViewport = { width: 320, height: 568, scale: 2, fontScale: 3.2 };
  act(() => tree.update(<Motion3DPlayer {...props} />));
  nativeReady();
  expect(
    StyleSheet.flatten(byId('motion3d-information').props.style),
  ).toMatchObject({ flex: 1, minHeight: 0 });
  expect(
    StyleSheet.flatten(byId('motion3d-transport').props.style),
  ).toMatchObject({ flexShrink: 0 });
  for (const text of tree.root.findAllByType(Text)) {
    expect(text.props.numberOfLines).toBeUndefined();
    expect(text.props.maxFontSizeMultiplier).toBeUndefined();
  }
  expect(inside(byId('motion3d-development-disclosure'), ScrollView)).toBe(
    true,
  );
});

it('starts reduced-motion review paused and preserves stepping and accessible scrubbing', () => {
  mockReducedMotion = true;
  act(() => tree.update(<Motion3DPlayer {...props} />));
  nativeReady();
  expect(byId('motion3d-native').props.command.action).toBe('pause');
  expect(byId('motion3d-play').props.accessibilityLabel).toBe(
    'Play motion playback',
  );
  press('motion3d-next');
  expect(byId('motion3d-native').props.command).toMatchObject({
    action: 'step',
    value: 1,
  });
  act(() =>
    byId('motion3d-timeline').props.onAccessibilityAction({
      nativeEvent: { actionName: 'decrement' },
    }),
  );
  expect(byId('motion3d-native').props.command).toMatchObject({
    action: 'step',
    value: -1,
  });
  expect(byId('motion3d-timeline').props.accessibilityRole).toBe('adjustable');
});

it('requests pause on background and does not automatically resume on foreground', () => {
  const callbacks: Array<(state: 'active' | 'background') => void> = [];
  const remove = jest.fn();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, callback) => {
      callbacks.push(callback);
      return { remove };
    });
  act(() => tree.unmount());
  act(() => {
    tree = TestRenderer.create(<Motion3DPlayer {...props} />);
  });
  nativeReady();
  press('motion3d-play');
  act(() => callbacks[0]?.('background'));
  const pause = byId('motion3d-native').props.command;
  expect(pause.action).toBe('pause');
  act(() => callbacks[0]?.('active'));
  expect(byId('motion3d-native').props.command).toBe(pause);
  act(() => tree.unmount());
  expect(remove).toHaveBeenCalledTimes(1);
});

it('labels pose-only playback and sampled-frame stepping when native reports the recording missing', () => {
  nativeReady({ sourceState: 'missing', clock: 'pose_only' });
  nativeProgress({
    sourceState: 'missing',
    clock: 'pose_only',
    sourceFrameIndex: null,
  });
  expect(byId('motion3d-pose-only').props.children).toContain(
    'Recording missing',
  );
  expect(byId('motion3d-mode-recording').props.disabled).toBe(true);
  expect(byId('motion3d-next').props.accessibilityLabel).toBe(
    'Next sampled frame',
  );
  expect(byId('motion3d-play').props.disabled).toBe(false);
});

it.each([
  'no_person',
  'multiple_people',
  'unavailable',
  'gap',
  'insufficient_joints',
] as const)(
  'shows an explicit %s state without a substitute reference or a fabricated body',
  frameStatus => {
    nativeReady();
    nativeProgress({
      frameStatus,
      ...(frameStatus === 'gap'
        ? { frameIndex: null, poseTimestampMs: null }
        : {}),
    });
    const message = byId('motion3d-frame-state').props.children as string;
    expect(message).not.toContain('Raw estimate');
    expect(message.length).toBeGreaterThan(20);
    expect(byId('motion3d-stage').children).toHaveLength(1);
  },
);

it('fails closed on digest errors and does not turn corrupt evidence into pose-only playback', () => {
  nativeReady();
  act(() =>
    byId('motion3d-native').props.onReviewError({
      nativeEvent: { artifactSha256: digest, code: 'source_digest_mismatch' },
    }),
  );
  expect(
    tree.root.findAll(node => node.props.testID === 'motion3d-native'),
  ).toHaveLength(0);
  expect(
    tree.root.findAll(node => node.props.testID === 'motion3d-pose-only'),
  ).toHaveLength(0);
  expect(byId('motion3d-play').props.disabled).toBe(true);
  expect(
    byId('motion3d-evidence-state')
      .findAllByType(Text)
      .map(node => node.props.children)
      .join(' '),
  ).toContain('does not match');
});

it('shows native scrub intent and seeking rather than a stale missing-estimate caption', () => {
  nativeReady();
  nativeProgress({ positionMs: 40 });
  act(() =>
    byId('motion3d-timeline').props.onLayout({
      nativeEvent: { layout: { width: 200 } },
    }),
  );
  act(() =>
    byId('motion3d-timeline').props.onResponderGrant({
      nativeEvent: { locationX: 100 },
    }),
  );
  nativeProgress({
    positionMs: 500,
    actualPositionMs: 40,
    seeking: true,
    frameStatus: 'seeking',
    frameIndex: null,
    sourceFrameIndex: null,
    poseTimestampMs: null,
    jointCount: 0,
  });
  expect(byId('motion3d-timeline').props.accessibilityValue.now).toBe(500);
  expect(byId('motion3d-frame-state').props.children).toContain(
    'Seeking to 0.50s',
  );
  expect(byId('motion3d-frame-state').props.children).not.toContain('gap');
  nativeProgress({
    positionMs: 480,
    frameIndex: 12,
    poseTimestampMs: 480,
    sourceFrameIndex: 12,
  });
  expect(byId('motion3d-timeline').props.accessibilityValue.now).toBe(480);
  expect(byId('motion3d-frame-state').props.children).toContain('Raw estimate');
});

it('recovers play intent from a native rejected-play acknowledgement and ignores older acknowledgements', () => {
  nativeReady();
  nativeProgress();
  press('motion3d-play');
  const firstID = byId('motion3d-native').props.command.id;
  nativeProgress({ playing: false, commandId: firstID - 1 });
  press('motion3d-play');
  expect(byId('motion3d-native').props.command.action).toBe('pause');
  press('motion3d-play');
  const rejectedID = byId('motion3d-native').props.command.id;
  nativeProgress({ playing: false, commandId: rejectedID });
  press('motion3d-play');
  expect(byId('motion3d-native').props.command.action).toBe('play');
});

it('keeps limitations in accessible Evidence and labels genuine partial frames clearly', () => {
  nativeReady();
  nativeProgress({ jointCount: 12 });
  expect(byId('motion3d-frame-state').props.children).toContain(
    'Partial estimate · 12 of 17',
  );
  expect(
    tree.root.findAll(
      node => node.props.testID === 'motion3d-evidence-details',
    ),
  ).toHaveLength(0);
  const toggle = byId('motion3d-evidence-toggle');
  expect(toggle.props.accessibilityState.expanded).toBe(false);
  expect(
    StyleSheet.flatten(toggle.props.style).minHeight,
  ).toBeGreaterThanOrEqual(44);
  press('motion3d-evidence-toggle');
  const copy = byId('motion3d-evidence-details')
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .join(' ');
  expect(copy).toContain('one visible person');
  expect(copy).toContain('does not verify identity or track bystanders');
  expect(copy).toContain('not been independently validated');
  expect(copy).toContain('not your measured height');
  expect(inside(byId('motion3d-evidence-details'), ScrollView)).toBe(true);
  expect(inside(byId('motion3d-transport'), ScrollView)).toBe(false);
  press('motion3d-evidence-toggle');
  expect(
    tree.root.findAll(
      node => node.props.testID === 'motion3d-evidence-details',
    ),
  ).toHaveLength(0);
});

it('remounts paused for a different artifact and rejects inconsistent native metadata', () => {
  nativeReady();
  nativeProgress({ playing: true, positionMs: 500 });
  const nextDigest = 'c'.repeat(64);
  act(() =>
    tree.update(<Motion3DPlayer {...props} artifactSha256={nextDigest} />),
  );
  expect(byId('motion3d-timeline').props.accessibilityValue.now).toBe(0);
  expect(byId('motion3d-native').props.command).toBeNull();
  act(() =>
    byId('motion3d-native').props.onReviewReady({
      nativeEvent: { ...loaded, artifactSha256: nextDigest, durationMs: 999 },
    }),
  );
  expect(byId('motion3d-play').props.disabled).toBe(true);
  expect(
    tree.root.findAll(node => node.props.testID === 'motion3d-native'),
  ).toHaveLength(0);
});
