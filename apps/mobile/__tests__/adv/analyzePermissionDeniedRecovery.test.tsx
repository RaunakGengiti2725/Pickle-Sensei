/**
 * INT-ui-flows-a11y adversary — missing-permission recovery on the
 * AnalyzeScreen.
 *
 * iOS never re-prompts once Photos/Camera access was denied; the only
 * recovery is Settings. Attacks:
 *  1. The native bridge rejects with `camera.permission_denied`: the error
 *     surface must offer a route into Settings (Linking.openSettings), not
 *     only a "Try again" that re-runs the same denied request forever.
 *  2. Double-tapping "Try again" on that surface must start exactly ONE
 *     new import operation.
 *  3. A denial must never leave a stale "Opening…" spinner or a rated
 *     result: the alert copy is present and no analysis ran.
 */
jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
}));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../../src/account/apiSession', () => ({
  ...jest.requireActual('../../src/account/apiSession'),
  getApiSession: () => null,
}));
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(),
    subscribeToCameraEvents: jest.fn(() => () => {}),
  };
});
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
    Stop: Mock,
  };
});

import React from 'react';
import { Linking } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import { importStrokeVideo } from '../../src/camera/capture';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';

const PERMISSION_DENIED = Object.assign(
  new Error('Photos permission denied. Enable access in Settings.'),
  { code: 'camera.permission_denied' },
);

function textContents(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

/** Host buttons (what VoiceOver sees) mapped to the nearest onPress owner. */
function pressables(renderer: ReactTestRenderer): ReactTestInstance[] {
  const hosts = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.accessibilityRole === 'button' &&
      typeof node.props.accessibilityLabel === 'string',
  );
  return hosts.flatMap(host => {
    let owner: ReactTestInstance | null = host;
    while (owner && typeof owner.props.onPress !== 'function') {
      owner = owner.parent;
    }
    return owner ? [owner] : [];
  });
}

function labelOf(node: { props: Record<string, unknown> }): string {
  const label = node.props.accessibilityLabel;
  return typeof label === 'string' ? label : '';
}

async function renderLibraryScreen(): Promise<ReactTestRenderer> {
  mockRouteParams = { source: 'library' };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  await act(async () => {});
  mounted.push(renderer);
  return renderer;
}

const mounted: ReactTestRenderer[] = [];

describe('adv: AnalyzeScreen permission-denied recovery', () => {
  let openSettings: jest.SpyInstance;

  beforeEach(() => {
    setActiveDataOwner('11111111-1111-4111-8111-111111111111');
    jest.useFakeTimers();
    jest.clearAllMocks();
    openSettings = jest
      .spyOn(Linking, 'openSettings')
      .mockImplementation(async () => {});
  });

  afterEach(async () => {
    for (const renderer of mounted.splice(0)) {
      await act(async () => {
        renderer.unmount();
      });
    }
    openSettings.mockRestore();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    jest.useRealTimers();
  });

  it('fails closed on a permission denial: alert copy, nothing rated, no spinner', async () => {
    (importStrokeVideo as jest.Mock).mockRejectedValue(PERMISSION_DENIED);
    const renderer = await renderLibraryScreen();
    const rendered = textContents(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('Photos permission denied');
    expect(rendered).not.toContain('Opening video library');
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
  });

  it('offers a Settings route after a permission denial (iOS never re-prompts)', async () => {
    (importStrokeVideo as jest.Mock).mockRejectedValue(PERMISSION_DENIED);
    const renderer = await renderLibraryScreen();
    const settingsControl = pressables(renderer).find(node =>
      /settings/i.test(labelOf(node)),
    );
    expect(settingsControl).toBeDefined();
    await act(async () => {
      settingsControl!.props.onPress();
    });
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('double-tapping Try again after a denial starts exactly one new import', async () => {
    (importStrokeVideo as jest.Mock).mockRejectedValue(PERMISSION_DENIED);
    const renderer = await renderLibraryScreen();
    expect(importStrokeVideo).toHaveBeenCalledTimes(1);

    let releaseImport!: (error: Error) => void;
    (importStrokeVideo as jest.Mock).mockImplementation(
      () =>
        new Promise((_, reject) => {
          releaseImport = reject;
        }),
    );
    const tryAgain = pressables(renderer).find(
      node => labelOf(node) === 'Try again',
    );
    expect(tryAgain).toBeDefined();
    await act(async () => {
      tryAgain!.props.onPress();
      tryAgain!.props.onPress();
    });
    expect(importStrokeVideo).toHaveBeenCalledTimes(2);

    await act(async () => {
      releaseImport(PERMISSION_DENIED);
    });
    expect(textContents(renderer)).toContain('Nothing was rated.');
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
  });
});
