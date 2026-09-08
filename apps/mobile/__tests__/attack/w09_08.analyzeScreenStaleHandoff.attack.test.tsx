// Same substitution set as analyzeScreenRearmSignals.test.tsx: the screen
// module pulls in the SQLite-backed db and the native camera module, neither
// of which exists under jest.
jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(() => Promise.resolve()),
  setCaptureTargetSeed: jest.fn(() => Promise.resolve()),
  setDeclaredStroke: jest.fn(() => Promise.resolve()),
  getKv: jest.fn(() => Promise.resolve(null)),
  setKv: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/account/apiSession', () => ({
  ...jest.requireActual('../../src/account/apiSession'),
  getApiSession: jest.fn(() => null),
}));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

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

type Listener = (event: unknown) => void;
const cameraFake: {
  listener: Listener | null;
  resolvers: Array<(clip: unknown) => void>;
} = { listener: null, resolvers: [] };
jest.mock('../../src/camera/capture', () => ({
  ...jest.requireActual('../../src/camera/capture'),
  subscribeToCameraEvents: (listener: Listener) => {
    cameraFake.listener = listener;
    return () => {
      cameraFake.listener = null;
    };
  },
  captureStrokeVideo: jest.fn(
    () =>
      new Promise(resolve => {
        cameraFake.resolvers.push(resolve);
      }),
  ),
  importStrokeVideo: jest.fn(),
  cancelCameraOperation: jest.fn(),
}));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import {
  armTryAgain,
  clearTryAgainHandoff,
  tryAgainStackDepth,
} from '../../src/screens/tryAgainHandoff';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';

/**
 * W09-08 adversarial — the shipping consumer. ResultScreen arms the handoff
 * and navigates to Analyze; AnalyzeScreen consumes it in a lazy initializer
 * and, for an AUTO re-arm, launches the camera by itself after a 160 ms beat.
 * If the account changes between the tap and the mount, that auto-launch
 * must NOT happen — the wrong account would be seeded with a declaration the
 * player never made for it.
 */

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';

function autoHandoff() {
  return {
    source: 'camera' as const,
    declaredStroke: null,
    declaredCanonical: null,
    auto: true,
    sessionId: null,
  };
}

async function mountAnalyze(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  return renderer;
}

function failureReasons(): string[] {
  return stabilitySlo
    .events()
    .flatMap(event =>
      event.kind === 'try_again_failed' ? [event.reason] : [],
    );
}

describe('W09-08 attack — AnalyzeScreen vs. a handoff armed under another owner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    stabilitySlo.reset();
    clearTryAgainHandoff();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  afterEach(() => {
    jest.useRealTimers();
    clearTryAgainHandoff();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    cameraFake.listener = null;
    cameraFake.resolvers = [];
    jest.clearAllMocks();
  });

  it('control: same owner generation auto-launches the re-armed AUTO capture', async () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(autoHandoff());
    const renderer = await mountAnalyze();

    expect(cameraFake.resolvers).toHaveLength(1);
    expect(failureReasons()).toEqual([]);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('account switched between the tap and the mount: no auto-launch, chain dropped', async () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(autoHandoff());
    setActiveDataOwner(OWNER_B);
    const renderer = await mountAnalyze();

    expect(cameraFake.resolvers).toHaveLength(0);
    expect(failureReasons()).toEqual(['owner_changed']);
    expect(tryAgainStackDepth()).toBe(0);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('A → B → A between the tap and the mount is a new generation of A: no auto-launch', async () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(autoHandoff());
    setActiveDataOwner(OWNER_B);
    setActiveDataOwner(OWNER_A);
    const renderer = await mountAnalyze();

    expect(cameraFake.resolvers).toHaveLength(0);
    expect(failureReasons()).toEqual(['owner_changed']);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('a second Analyze mount under the new owner after the first rejected the stale hop starts clean', async () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(autoHandoff());
    setActiveDataOwner(OWNER_B);
    const first = await mountAnalyze();
    await act(async () => {
      first.unmount();
    });
    const second = await mountAnalyze();

    expect(cameraFake.resolvers).toHaveLength(0);
    expect(failureReasons()).toEqual(['owner_changed']);

    await act(async () => {
      second.unmount();
    });
  });
});
