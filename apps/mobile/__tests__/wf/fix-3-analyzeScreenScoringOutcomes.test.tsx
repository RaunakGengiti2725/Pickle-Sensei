/**
 * AnalyzeScreen scoring-outcome routing:
 *   - the persisted appVersion is the runtime config's, never a literal
 *   - a scored run flushes the outbox now and refreshes canonical access
 *   - a 402 paywall refusal offers the upgrade, never a retry
 *   - the error header names the step that stopped (capture vs analysis)
 *   - closing the working screen abandons the run: no Result navigation,
 *     no free-limit prompt, no review ask on a screen the user left
 */
jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
}));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../../src/data/syncRuntime', () => ({
  triggerOutboxSync: jest.fn(),
}));
jest.mock('../../src/review/appStoreReview', () => ({
  reportScoredAnalysisForReview: jest.fn(async () => {}),
}));
const mockRefreshAccess = jest.fn(async () => true);
jest.mock('../../src/state/accessStore', () => {
  const state = {
    canonicalAccess: null,
    refreshAccess: () => mockRefreshAccess(),
  };
  const useAccessStore = (selector: (s: typeof state) => unknown) =>
    selector(state);
  useAccessStore.getState = () => state;
  return { useAccessStore };
});
jest.mock('../../src/account/apiSession', () => ({
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
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import { ScreenHeader } from '../../src/design/components';
import { TargetSelector } from '../../src/camera/TargetSelector';
import {
  assertCapturedClip,
  importStrokeVideo,
} from '../../src/camera/capture';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import { triggerOutboxSync } from '../../src/data/syncRuntime';
import { reportScoredAnalysisForReview } from '../../src/review/appStoreReview';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';

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
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  await act(async () => {});
  return renderer;
}

async function declareAndScore(renderer: ReactTestRenderer): Promise<void> {
  const radios = renderer.root.findAll(
    node => node.props?.accessibilityRole === 'radio',
  );
  expect(radios.length).toBeGreaterThan(0);
  await act(async () => {
    radios[0]!.props.onPress();
  });
  const selector = renderer.root.findByType(TargetSelector);
  await act(async () => {
    void selector.props.onSkip();
  });
}

function pendingAnalysis(): (value: unknown) => void {
  let resolveAnalysis!: (value: unknown) => void;
  (runCaptureAnalysis as jest.Mock).mockImplementation(
    () =>
      new Promise(resolve => {
        resolveAnalysis = resolve;
      }),
  );
  return value => resolveAnalysis(value);
}

function buttonLabelled(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      typeof node.props?.onPress === 'function' && node.props?.label === label,
  );
}

describe('AnalyzeScreen — scoring outcome routing (wf fix-3)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes the runtime appVersion (not a literal) into the analysis request', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'unavailable',
      reason: 'Imported videos cannot be scored yet.',
    });
    const renderer = await renderLibraryScreen();
    await declareAndScore(renderer);
    expect(runCaptureAnalysis).toHaveBeenCalledTimes(1);
    const request = (runCaptureAnalysis as jest.Mock).mock.calls[0]![0];
    expect(request.appVersion).toBe(getRuntimePublicConfig().appVersion);
    expect(request.appVersion).not.toBe('0.1.0');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('a scored run flushes the outbox immediately, refreshes access, opens Result and asks for a review', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'scored',
      analysisId: 'analysis-1',
      record: {},
      freeLimitReached: false,
    });
    const renderer = await renderLibraryScreen();
    await declareAndScore(renderer);
    expect(triggerOutboxSync).toHaveBeenCalledTimes(1);
    expect(mockRefreshAccess).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'analysis-1',
    });
    expect(reportScoredAnalysisForReview).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('the last free rating refreshes access before the upgrade prompt and skips the review ask', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'scored',
      analysisId: 'analysis-2',
      record: {},
      freeLimitReached: true,
    });
    const renderer = await renderLibraryScreen();
    await declareAndScore(renderer);
    expect(triggerOutboxSync).toHaveBeenCalledTimes(1);
    expect(mockRefreshAccess).toHaveBeenCalledTimes(1);
    expect(textContents(renderer)).toContain(
      'That was your last free analysis.',
    );
    expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });

  it('a 402 paywall refusal offers Upgrade to Pro (routing to Paywall) and never Try again', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'unavailable',
      reason: 'Your free ratings are used up. Upgrade to Pro to keep rating.',
      cause: 'paywall_required',
    });
    const renderer = await renderLibraryScreen();
    await declareAndScore(renderer);
    const rendered = textContents(renderer);
    expect(rendered).toContain('Analysis stopped');
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('Your free ratings are used up.');
    expect(rendered).toContain('Upgrade to Pro');
    expect(rendered).not.toContain('Try again');
    expect(mockRefreshAccess).toHaveBeenCalledTimes(1);
    expect(triggerOutboxSync).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();

    const [upgrade] = buttonLabelled(renderer, 'Upgrade to Pro');
    expect(upgrade).toBeDefined();
    await act(async () => {
      upgrade!.props.onPress();
    });
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Paywall', {
      source: 'rating',
    });
    expect(importStrokeVideo).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('a plain unavailable outcome keeps Try again and does not touch access', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'unavailable',
      reason: 'The rating service is temporarily unavailable.',
    });
    const renderer = await renderLibraryScreen();
    await declareAndScore(renderer);
    const rendered = textContents(renderer);
    expect(rendered).toContain('Analysis stopped');
    expect(rendered).toContain('Try again');
    expect(rendered).not.toContain('Upgrade to Pro');
    expect(mockRefreshAccess).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });

  it('a capture-stage failure is still headed "Capture interrupted"', async () => {
    (importStrokeVideo as jest.Mock).mockRejectedValue(
      new Error('Photos permission denied. Enable access in Settings.'),
    );
    const renderer = await renderLibraryScreen();
    const rendered = textContents(renderer);
    expect(rendered).toContain('Capture interrupted');
    expect(rendered).not.toContain('Analysis stopped');
    expect(rendered).toContain('Try again');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('an analysis exception is headed "Analysis stopped", not "Capture interrupted"', async () => {
    (runCaptureAnalysis as jest.Mock).mockRejectedValue(
      new Error('The server took too long to respond.'),
    );
    const renderer = await renderLibraryScreen();
    await declareAndScore(renderer);
    const rendered = textContents(renderer);
    expect(rendered).toContain('Analysis stopped');
    expect(rendered).not.toContain('Capture interrupted');
    expect(rendered).toContain('took too long to respond');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('closing the working screen mid-scoring abandons the run: no Result, no prompt, no review ask', async () => {
    const resolveAnalysis = pendingAnalysis();
    const renderer = await renderLibraryScreen();
    await declareAndScore(renderer);
    expect(runCaptureAnalysis).toHaveBeenCalledTimes(1);
    expect(textContents(renderer)).toContain('Measuring your swing');

    const header = renderer.root.findByType(ScreenHeader);
    await act(async () => {
      header.props.onClose();
    });
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveAnalysis({
        kind: 'scored',
        analysisId: 'analysis-3',
        record: {},
        freeLimitReached: true,
      });
    });
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
    expect(textContents(renderer)).not.toContain(
      'That was your last free analysis.',
    );
    expect(triggerOutboxSync).toHaveBeenCalledTimes(1);
    expect(mockRefreshAccess).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('unmounting mid-scoring abandons the run the same way', async () => {
    const resolveAnalysis = pendingAnalysis();
    const renderer = await renderLibraryScreen();
    await declareAndScore(renderer);
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      resolveAnalysis({
        kind: 'scored',
        analysisId: 'analysis-4',
        record: {},
        freeLimitReached: false,
      });
    });
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
    expect(triggerOutboxSync).toHaveBeenCalledTimes(1);
  });
});
