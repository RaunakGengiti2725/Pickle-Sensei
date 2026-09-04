/**
 * ADVERSARIAL PASS 3 / mobile-ios-config — S5: camera permission denial at
 * the NATIVE bridge, driven through the real AnalyzeScreen.
 *
 * Unlike gate11AnalyzeScreenFailure / AnalyzeScreen.buttons (which mock
 * `captureStrokeVideo`), this suite installs a fake
 * `NativeModules.PickleVideoCapture` BEFORE `src/camera/capture.ts` captures
 * its module-level `native` reference, so the rejection travels the same path
 * a Swift `reject(code, message, error)` takes: an Error with `.code`.
 *
 * Invariant under test (coordinator): "UI must offer Settings guidance
 * consistent with NSCameraUsageDescription without crashing." Observed
 * baseline behaviour that falls short is pinned under `BASELINE BEHAVIOUR:`.
 */
jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
  setCaptureTargetSeed: jest.fn(async () => {}),
}));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));
jest.mock('../../src/review/appStoreReview', () => ({
  reportScoredAnalysisForReview: jest.fn(async () => {}),
}));
jest.mock('../../src/camera/TargetSelector', () => ({
  TargetSelector: () => null,
}));
const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
let mockRouteParams: Record<string, unknown> = {};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockRouteParams }),
}));
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: { children?: React.ReactNode }) =>
      React.createElement(View, null, props.children),
  };
});
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Ellipse: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    RadialGradient: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import { Linking, NativeModules, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

// The mobile tsconfig has no Node types (matches
// flow-app-store-compliance-ios-config.test.ts).
declare const __dirname: string;

const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

// ─── Native bridge fake (installed before capture.ts loads) ────────────────

const nativeCapture = jest.fn<Promise<unknown>, []>();
const nativeCancel = jest.fn();
const fakeNative = {
  capture: nativeCapture,
  importVideo: jest.fn<Promise<unknown>, []>(),
  cancel: nativeCancel,
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};
(
  NativeModules as { PickleVideoCapture?: typeof fakeNative }
).PickleVideoCapture = fakeNative;

// Loaded AFTER the bridge fake so `const native = NativeModules.PickleVideoCapture`
// inside capture.ts resolves to it.
const { AnalyzeScreen } =
  require('../../src/screens/AnalyzeScreen') as typeof import('../../src/screens/AnalyzeScreen');
const { cameraAvailable } =
  require('../../src/camera/capture') as typeof import('../../src/camera/capture');
const { runCaptureAnalysis } =
  require('../../src/analysis/runCaptureAnalysis') as typeof import('../../src/analysis/runCaptureAnalysis');
const { stabilitySlo } =
  require('../../src/analysis/stabilityTelemetry') as typeof import('../../src/analysis/stabilityTelemetry');

// ─── Fixtures ──────────────────────────────────────────────────────────────

const INFO_PLIST = readFileSync(
  join(__dirname, '..', '..', 'ios', 'PickleSensei', 'Info.plist'),
  'utf8',
);
const cameraUsageDescription =
  /<key>NSCameraUsageDescription<\/key>\s*<string>([^<]*)<\/string>/.exec(
    INFO_PLIST,
  )?.[1] ?? '';

/** Message PickleVideoCapture.swift emits with its permission rejection. */
const SWIFT_PERMISSION_MESSAGE =
  'Allow camera access in Settings to analyze a stroke.';
/** Code the coordinator asked us to inject (dotted). */
const COORDINATOR_CODE = 'camera.permission.denied';
/** Code PickleVideoCapture.swift actually emits (underscored). */
const SWIFT_CODE = 'camera.permission_denied';

/** Shape of a rejected native promise as RN's iOS bridge hands it to JS. */
function nativeRejection(code: string, message: string) {
  return Object.assign(new Error(message), {
    code,
    domain: 'PickleVideoCapture',
    userInfo: null,
    nativeStackIOS: [] as string[],
  });
}

function rendered(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function visibleText(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => {
      const children = node.props.children as unknown;
      return Array.isArray(children) ? children : [children];
    })
    .filter((c): c is string => typeof c === 'string');
}

function pressables(renderer: ReactTestRenderer) {
  return renderer.root.findAll(n => typeof n.props.onPress === 'function');
}

async function pressButton(renderer: ReactTestRenderer, label: string) {
  const candidates = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.findAll(t => t.type === Text && String(t.props.children) === label)
        .length > 0,
  );
  const node = candidates[candidates.length - 1];
  if (!node) throw new Error(`No button labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
  await act(async () => {});
}

async function renderCamera(): Promise<ReactTestRenderer> {
  mockRouteParams = { source: 'camera' };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  return renderer;
}

async function unmount(renderer: ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
}

function cameraStartupFailures() {
  return stabilitySlo
    .events()
    .filter(event => event.kind === 'camera_startup_failed');
}

let openSettings: jest.SpyInstance;
let openURL: jest.SpyInstance;
let consoleError: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockRouteParams = {};
  openSettings = jest
    .spyOn(Linking, 'openSettings')
    .mockImplementation(async () => {});
  openURL = jest.spyOn(Linking, 'openURL').mockImplementation(async () => {});
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  openSettings.mockRestore();
  openURL.mockRestore();
  consoleError.mockRestore();
  jest.useRealTimers();
});

describe('S5 — NativeModules.PickleVideoCapture.capture rejects with a permission-denied code', () => {
  it('precondition: the fake bridge is what capture.ts sees, and Info.plist carries a camera purpose string', () => {
    expect(cameraAvailable()).toBe(true);
    expect(cameraUsageDescription.length).toBeGreaterThan(20);
    expect(cameraUsageDescription.toLowerCase()).toContain('capture');
  });

  it(`code '${COORDINATOR_CODE}' + Swift message: no crash, error state, Try again + Close, copy names Settings and the camera`, async () => {
    nativeCapture.mockRejectedValueOnce(
      nativeRejection(COORDINATOR_CODE, SWIFT_PERMISSION_MESSAGE),
    );
    const failuresBefore = cameraStartupFailures().length;
    const renderer = await renderCamera();
    await pressButton(renderer, 'Open automatic camera');

    const text = rendered(renderer);
    expect(nativeCapture).toHaveBeenCalledTimes(1);
    expect(text).toContain('Nothing was rated.');
    expect(text).toContain('Capture interrupted');
    expect(text).toContain(SWIFT_PERMISSION_MESSAGE);
    expect(text).toContain('Try again');
    expect(text).toContain('Close');
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();

    // Guidance consistent with the plist purpose: the copy points at Settings
    // and both the purpose string and the copy describe the same job —
    // analyzing a stroke.
    const shown = visibleText(renderer).join(' ').toLowerCase();
    expect(shown).toContain('camera');
    expect(shown).toContain('settings');
    const purpose = cameraUsageDescription.toLowerCase();
    for (const stem of ['stroke', 'analy']) {
      expect(shown).toContain(stem);
      expect(purpose).toContain(stem);
    }

    // Copy hygiene (APP_STORE_SUBMISSION.md): nothing platform-foreign leaks.
    expect(shown).not.toMatch(/android|google play|guest mode|live court|dupr/);
    expect(cameraStartupFailures()).toHaveLength(failuresBefore + 1);
    await unmount(renderer);
  });

  it(`the Swift code '${SWIFT_CODE}' (underscored) is handled identically — the UI never branches on the code`, async () => {
    nativeCapture.mockRejectedValueOnce(
      nativeRejection(SWIFT_CODE, SWIFT_PERMISSION_MESSAGE),
    );
    const renderer = await renderCamera();
    await pressButton(renderer, 'Open automatic camera');
    const text = rendered(renderer);
    expect(text).toContain('Nothing was rated.');
    expect(text).toContain(SWIFT_PERMISSION_MESSAGE);
    expect(consoleError).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  it('BASELINE BEHAVIOUR: the permission error state offers NO action that opens Settings (guidance is text-only)', async () => {
    // Coordinator invariant asks for "Settings guidance". The screen shows
    // the Swift sentence verbatim but renders only Try again / Close; nothing
    // calls Linking.openSettings / openURL('app-settings:'). Pinned as the
    // observed gap — flip if a Settings action is added.
    nativeCapture.mockRejectedValueOnce(
      nativeRejection(COORDINATOR_CODE, SWIFT_PERMISSION_MESSAGE),
    );
    const renderer = await renderCamera();
    await pressButton(renderer, 'Open automatic camera');

    const controlLabels = pressables(renderer).flatMap(n => [
      String(n.props.accessibilityLabel ?? ''),
      ...n.findAllByType(Text).map(t => String(t.props.children)),
    ]);
    expect(controlLabels.length).toBeGreaterThan(0);
    expect(controlLabels.some(label => /settings/i.test(label))).toBe(false);

    for (const node of pressables(renderer)) {
      // Pressing every offered control must not open Settings nor throw.
      if (node.props.accessibilityLabel === 'Close') continue;
      await act(async () => {
        node.props.onPress();
      });
      await act(async () => {});
    }
    expect(openSettings).not.toHaveBeenCalled();
    expect(openURL).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  it('BASELINE BEHAVIOUR: a code-only rejection (message === code) puts the raw code on screen as the user-facing sentence', async () => {
    // The screen derives its copy from `error.message` alone
    // (AnalyzeScreen.tsx catch → setPhase({message})); there is no
    // code → copy mapping, so a bridge that reports only a code shows it.
    nativeCapture.mockRejectedValueOnce(
      nativeRejection(COORDINATOR_CODE, COORDINATOR_CODE),
    );
    const renderer = await renderCamera();
    await pressButton(renderer, 'Open automatic camera');
    const text = rendered(renderer);
    expect(text).toContain('Nothing was rated.');
    expect(visibleText(renderer)).toContain(COORDINATOR_CODE);
    expect(consoleError).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  it('BASELINE BEHAVIOUR: a permission-denied message containing "cancel" is silently treated as a user cancel (no error surface)', async () => {
    // Cancel detection is `message.toLowerCase().includes('cancel')`.
    const failuresBefore = cameraStartupFailures().length;
    nativeCapture.mockRejectedValueOnce(
      nativeRejection(
        COORDINATOR_CODE,
        'Camera permission prompt was cancelled by the system.',
      ),
    );
    const renderer = await renderCamera();
    await pressButton(renderer, 'Open automatic camera');
    const text = rendered(renderer);
    expect(text).not.toContain('Nothing was rated.');
    expect(text).toContain('Open automatic camera');
    expect(cameraStartupFailures()).toHaveLength(failuresBefore);
    await unmount(renderer);
  });

  it('Try again after denial re-invokes the native bridge; a later grant proceeds normally (no stale error)', async () => {
    nativeCapture
      .mockRejectedValueOnce(
        nativeRejection(COORDINATOR_CODE, SWIFT_PERMISSION_MESSAGE),
      )
      .mockRejectedValueOnce(
        nativeRejection(COORDINATOR_CODE, SWIFT_PERMISSION_MESSAGE),
      )
      .mockRejectedValueOnce(new Error('User cancelled the camera.'));
    const renderer = await renderCamera();
    await pressButton(renderer, 'Open automatic camera');
    expect(rendered(renderer)).toContain(SWIFT_PERMISSION_MESSAGE);

    await pressButton(renderer, 'Try again');
    expect(nativeCapture).toHaveBeenCalledTimes(2);
    expect(rendered(renderer)).toContain(SWIFT_PERMISSION_MESSAGE);

    await pressButton(renderer, 'Try again');
    expect(nativeCapture).toHaveBeenCalledTimes(3);
    // Third attempt: the user backed out of the (now granted) camera — the
    // screen returns to READY, no stale permission copy remains.
    const text = rendered(renderer);
    expect(text).not.toContain(SWIFT_PERMISSION_MESSAGE);
    expect(text).toContain('Open automatic camera');
    expect(consoleError).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  it('denial that arrives AFTER the user closed the screen mid-flight: bridge cancel fires, nothing throws, no navigation from a dead screen', async () => {
    let rejectCapture!: (reason: unknown) => void;
    nativeCapture.mockImplementationOnce(
      () =>
        new Promise<unknown>((_, reject) => {
          rejectCapture = reject;
        }),
    );
    const renderer = await renderCamera();
    await pressButton(renderer, 'Open automatic camera');
    expect(rendered(renderer)).toContain('Opening camera');

    await unmount(renderer);
    expect(nativeCancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectCapture(
        nativeRejection(COORDINATOR_CODE, SWIFT_PERMISSION_MESSAGE),
      );
    });
    await act(async () => {});
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('hostile rejection payloads (string, null, code-only object, 1 MiB message) never crash the screen', async () => {
    const payloads: unknown[] = [
      'camera.permission.denied',
      null,
      { code: COORDINATOR_CODE },
      nativeRejection(COORDINATOR_CODE, 'x'.repeat(1024 * 1024)),
    ];
    for (const payload of payloads) {
      nativeCapture.mockRejectedValueOnce(payload);
      const renderer = await renderCamera();
      await pressButton(renderer, 'Open automatic camera');
      expect(rendered(renderer)).toContain('Nothing was rated.');
      expect(rendered(renderer)).toContain('Try again');
      await unmount(renderer);
    }
    expect(consoleError).not.toHaveBeenCalled();
    expect(nativeCapture).toHaveBeenCalledTimes(payloads.length);
  });
});
