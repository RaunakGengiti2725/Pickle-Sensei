/**
 * Gate 11 (mobile failure modes) — capture-screen certification at
 * jest/component level. Native camera execution is BLOCKED_EXTERNAL; these
 * tests drive the real AnalyzeScreen through the failure paths the native
 * layer reports into JS:
 *   - Photos/camera permission denied → fail closed with explanation + retry
 *   - user cancellation → clean recovery, no error surface
 *   - analysis/API failure → typed error phase, no stale Result, retry offered
 *   - duplicate taps → exactly one analysis run (one permit) per capture
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/account/apiSession', () => ({ getApiSession: () => null }));
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(),
    subscribeToCameraEvents: jest.fn(() => () => {}),
  };
});
jest.mock('../src/camera/TargetSelector', () => ({
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
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import { TargetSelector } from '../src/camera/TargetSelector';
import {
  assertCapturedClip,
  importStrokeVideo,
  cancelCameraOperation,
} from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

const importedClip = assertCapturedClip({
  uri: 'file:///private/var/mobile/import.mov',
  durationMs: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
});

function textContents(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

async function renderLibraryScreen(): Promise<ReactTestRenderer> {
  mockRouteParams = { source: 'library' };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  // Library imports auto-launch after a short arming delay.
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  await act(async () => {});
  return renderer;
}

describe('Gate 11 — AnalyzeScreen failure surfaces', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('Photos permission denied fails closed: explanation, retry, nothing rated', async () => {
    (importStrokeVideo as jest.Mock).mockRejectedValue(
      new Error('Photos permission denied. Enable access in Settings.'),
    );
    const renderer = await renderLibraryScreen();
    const rendered = textContents(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('Photos permission denied');
    expect(rendered).toContain('Try again');
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });

  it('user cancellation recovers cleanly without an error surface', async () => {
    (importStrokeVideo as jest.Mock).mockRejectedValue(
      new Error('User cancelled the video picker.'),
    );
    const renderer = await renderLibraryScreen();
    expect(textContents(renderer)).not.toContain('Nothing was rated.');
    expect(mockNavigation.goBack).toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });

  it('analysis failure shows a typed error with retry — no stale Result, no spinner', async () => {
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    (runCaptureAnalysis as jest.Mock).mockRejectedValue(
      new Error(
        'The server took too long to respond. Your work is saved on this device — try again when the connection recovers.',
      ),
    );
    const renderer = await renderLibraryScreen();
    const radios = renderer.root.findAll(
      node => node.props?.accessibilityRole === 'radio',
    );
    expect(radios.length).toBeGreaterThan(0);
    await act(async () => {
      radios[0]!.props.onPress();
    });
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      selector.props.onSkip();
    });
    const rendered = textContents(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('took too long to respond');
    expect(rendered).toContain('Try again');
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });

  it('duplicate taps run exactly one analysis for one capture', async () => {
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    let resolveAnalysis!: (value: unknown) => void;
    (runCaptureAnalysis as jest.Mock).mockImplementation(
      () =>
        new Promise(resolve => {
          resolveAnalysis = resolve;
        }),
    );
    const renderer = await renderLibraryScreen();
    const radios = renderer.root.findAll(
      node => node.props?.accessibilityRole === 'radio',
    );
    await act(async () => {
      radios[0]!.props.onPress();
    });
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      void selector.props.onSkip();
      void selector.props.onSkip();
      void selector.props.onSkip();
    });
    expect(runCaptureAnalysis).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveAnalysis({
        kind: 'unavailable',
        reason: 'Imported videos cannot be scored yet.',
      });
    });
    await act(async () => {
      renderer.unmount();
    });
  });

  it('unmounting mid-operation cancels the native camera work', async () => {
    (importStrokeVideo as jest.Mock).mockImplementation(
      () => new Promise(() => {}),
    );
    const renderer = await renderLibraryScreen();
    await act(async () => {
      await act(async () => {
        renderer.unmount();
      });
    });
    expect(cancelCameraOperation).toHaveBeenCalled();
  });
});
