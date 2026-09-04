/**
 * Adversarial fan-out test for XC-UAI-08 (candidate 7d0e8859): the camera
 * event bus is a broadcast, so every mounted AnalyzeScreen hears every
 * readiness read. Only the screen whose capture is in flight may act on it —
 * an idle sibling (a second Analyze instance on the stack) must stay idle.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type {
  CameraEvent,
  CameraReadinessState,
  CapturedClip,
} from '../src/camera/capture';

const mockNavigation = {
  replace: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  popToTop: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: 'camera' } }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});
jest.mock('../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();
const mockCaptureImpl: () => Promise<CapturedClip> = () =>
  new Promise<CapturedClip>(() => undefined);
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: () => mockCaptureImpl(),
    importStrokeVideo: () => Promise.reject(new Error('out of scope')),
    cancelCameraOperation: jest.fn(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
  };
});
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: () => Promise.reject(new Error('not reached')),
}));

import { AnalyzeScreen, READINESS_COPY } from '../src/screens/AnalyzeScreen';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';

const owner = '33333333-3333-4333-8333-333333333333';
const recordingDb: LocalDb = {
  async execute() {
    return { rows: [] };
  },
  close() {},
};
function mockCurrentDb(): LocalDb {
  return recordingDb;
}

function readinessEvent(state: CameraReadinessState): CameraEvent {
  return {
    emittedAtIso: '2026-09-04T18:00:00.000Z',
    type: 'readiness',
    state,
    poseConfidence: 0.9,
    jointCoverage: 0.9,
    stableForMs: 300,
    missingJoints: [],
    source: 'apple_vision_body_pose',
    modelVersion: 'apple-vision-bodypose-1',
  };
}

function emit(event: CameraEvent) {
  act(() => {
    for (const listener of mockCameraListeners) listener(event);
  });
}

async function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  return renderer;
}

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 200));
  });
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function pressButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const candidates = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.findAll(t => t.type === Text && String(t.props.children) === label)
        .length > 0,
  );
  const node = candidates[candidates.length - 1];
  if (!node) throw new Error(`No button labeled ${label}`);
  act(() => node.props.onPress());
}

beforeEach(() => {
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  mockCameraListeners.clear();
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('XC-UAI-08 attack — broadcast readiness reaches only the capturing screen', () => {
  it('an idle sibling AnalyzeScreen stays on its landing while another instance captures', async () => {
    const idle = await renderScreen();
    const capturing = await renderScreen();
    expect(mockCameraListeners.size).toBe(2);
    pressButton(capturing, 'Open automatic camera');
    await flush();
    expect(textOf(capturing)).toContain('Opening camera…');

    emit(readinessEvent('hold_still'));
    expect(textOf(capturing)).toContain(READINESS_COPY.hold_still);
    const idleRendered = textOf(idle);
    expect(idleRendered).toContain('Open automatic camera');
    expect(idleRendered).not.toContain(READINESS_COPY.hold_still);

    await act(async () => {
      idle.unmount();
      capturing.unmount();
    });
  });
});
