/**
 * Workflow verification — Analyze → Result (ResultScreen side).
 *
 * Mounts the real ResultScreen (evidence loading mocked at the data seam)
 * and presses its controls as a player would:
 *   - opening spinner → header Close pops to top; spinner never survives the
 *     evidence load (loaded / missing / rejected)
 *   - "Result missing" → its action goes back (no dead end)
 *   - Try again → single-use handoff armed with the SAME declared intent and
 *     navigation to Analyze{source:'camera'}
 *   - Done → popToTop; attempt tab → replace('Result', {analysisId})
 *   - training section: unconfigured API is honest, pending/unknown sync
 *     pauses plan creation, synced scored read exposes "Build reviewed plan"
 *     and the in-flight mutation disables it; no unbounded sync spinner
 *   - abstained (result-null) record: no score stage, "A score is required."
 */
jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('../../src/data/repository', () => ({
  hasShotSyncReceipt: jest.fn(),
}));
jest.mock('../../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: jest.fn(),
}));
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (state: { refresh: () => Promise<void> }) => unknown,
  ) => selector({ refresh: async () => {} }),
}));
jest.mock('../../src/consistency/DaySecuredBanner', () => ({
  DaySecuredBanner: () => null,
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));
const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
let mockRouteParams: { analysisId: string } = { analysisId: 'a1' };
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
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';
import { ResultScreen } from '../../src/screens/ResultScreen';
import { hasShotSyncReceipt } from '../../src/data/repository';
import {
  loadStrokeResultEvidence,
  type StrokeResultEvidence,
} from '../../src/components/strokeResultData';
import {
  clearTryAgainHandoff,
  peekTryAgainHandoff,
  consumeTryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import type { TrainingApi } from '../../src/training/types';

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'a1',
    sessionId: 's1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 2000, contactMs: null, endMs: 2700 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.82,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-heuristic-1',
      scoringModelVersion: 'scoring-1',
      shotConfigVersion: 'config-1',
    },
    source: 'real',
    ...overrides,
  };
}

function scoredEvidence(): StrokeResultEvidence {
  const analysis = analysisFixture();
  return {
    analysis,
    record: {
      id: 'a1',
      captureId: 'c1',
      strokeIntent: {
        declaredStroke: 'forehand_drive',
        predictedStroke: null,
        resolutionBasis: 'declared',
        resolvedProfileId: 'FOREHAND_DRIVE',
        resolvedProfileVersion: 'technique-profile-v1',
        disagreement: null,
      },
      result: analysis,
    },
    clip: null,
    attempts: [
      {
        analysisId: 'a1',
        capturedAtIso: analysis.capturedAtIso,
        sessionId: 's1',
      },
      {
        analysisId: 'a0',
        capturedAtIso: '2026-08-31T10:00:00.000Z',
        sessionId: 's1',
      },
    ],
  };
}

function abstainedEvidence(): StrokeResultEvidence {
  return {
    analysis: null,
    record: {
      id: 'a1',
      captureId: 'c1',
      strokeIntent: {
        declaredStroke: null,
        predictedStroke: null,
        resolutionBasis: 'abstained',
        resolvedProfileId: null,
        resolvedProfileVersion: null,
        disagreement: null,
      },
      result: null,
      uncertainty: {
        presentation: 'abstained',
        limitingFactors: ['analysis_confidence_below_threshold'],
      },
    },
    clip: null,
    attempts: [],
  };
}

const missingEvidence: StrokeResultEvidence = {
  analysis: null,
  record: null,
  clip: null,
  attempts: [],
};

function textOf(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function hosts(
  renderer: ReactTestRenderer,
  predicate: (node: TestRenderer.ReactTestInstance) => boolean,
) {
  return renderer.root.findAll(n => typeof n.type === 'string' && predicate(n));
}

/** Innermost pressable per visible label (composite Pressable nodes carry
 * onPress; host Views do not), in render order. */
function findButtons(renderer: ReactTestRenderer, label: string) {
  const candidates = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityRole === 'button' &&
      n.findAll(t => t.type === Text && String(t.props.children) === label)
        .length > 0,
  );
  return candidates.filter(
    n =>
      !candidates.some(
        other => other !== n && n.findAll(x => x === other).length > 0,
      ),
  );
}

function findButton(renderer: ReactTestRenderer, label: string) {
  const buttons = findButtons(renderer, label);
  return buttons[buttons.length - 1] ?? null;
}

async function press(
  renderer: ReactTestRenderer,
  label: string,
  which: 'first' | 'last' = 'last',
) {
  const buttons = findButtons(renderer, label);
  const node = which === 'first' ? buttons[0] : buttons[buttons.length - 1];
  if (!node) throw new Error(`No button labeled ${label}`);
  expect(node.props.accessibilityState?.disabled).not.toBe(true);
  await act(async () => {
    node.props.onPress();
  });
}

async function settle() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

async function render(analysisId = 'a1') {
  mockRouteParams = { analysisId };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultScreen />);
  });
  return renderer;
}

function spinnerCount(renderer: ReactTestRenderer) {
  return hosts(renderer, n => n.props.testID === 'stroke-result-analyzing')
    .length;
}

function fakeTrainingApi(overrides: Partial<TrainingApi> = {}): TrainingApi {
  return {
    listSavedDrills: async () => [],
    getDrill: async () => {
      throw new Error('no catalog in this test');
    },
    saveDrill: async () => {},
    unsaveDrill: async () => {},
    getCurrentPlan: async () => null,
    createPlan: async () => {
      throw new Error('createPlan not configured');
    },
    completeDrill: async () => {
      throw new Error('completeDrill not configured');
    },
    reassessPlan: async () => {
      throw new Error('reassessPlan not configured');
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearTryAgainHandoff();
  clearTrainingStoreConfiguration();
  (hasShotSyncReceipt as jest.Mock).mockResolvedValue(true);
});

afterEach(() => {
  clearTrainingStoreConfiguration();
});

describe('opening / missing result', () => {
  it('shows the opening spinner with a live Close that pops to top, then swaps to content', async () => {
    let resolveEvidence!: (value: StrokeResultEvidence) => void;
    (loadStrokeResultEvidence as jest.Mock).mockImplementation(
      () =>
        new Promise<StrokeResultEvidence>(resolve => {
          resolveEvidence = resolve;
        }),
    );
    const renderer = await render();
    expect(spinnerCount(renderer)).toBe(1);
    expect(textOf(renderer)).toContain('Opening your result');
    const spinner = hosts(
      renderer,
      n => n.props.testID === 'stroke-result-analyzing',
    )[0]!;
    expect(spinner.props.accessibilityLiveRegion).toBe('polite');
    const [close] = renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === 'Close' &&
        typeof n.props.onPress === 'function',
    );
    expect(close).toBeDefined();
    await act(async () => close!.props.onPress());
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);

    await act(async () => resolveEvidence(scoredEvidence()));
    await settle();
    expect(spinnerCount(renderer)).toBe(0);
    expect(textOf(renderer)).toContain('TECHNIQUE SCORE');
    await act(async () => renderer.unmount());
  });

  it('a record that no longer exists renders "Result missing" whose action goes back', async () => {
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(missingEvidence);
    const renderer = await render('gone');
    await settle();
    expect(spinnerCount(renderer)).toBe(0);
    expect(textOf(renderer)).toContain('Result missing');
    expect(textOf(renderer)).toContain('no longer on this device');
    const actions = renderer.root.findAll(
      n =>
        n.props.accessibilityRole === 'button' &&
        typeof n.props.onPress === 'function',
    );
    expect(actions.length).toBeGreaterThan(0);
    await act(async () => actions[actions.length - 1]!.props.onPress());
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });

  it('a rejected evidence load never leaves the spinner up', async () => {
    (loadStrokeResultEvidence as jest.Mock).mockRejectedValue(
      new Error('database closed'),
    );
    const renderer = await render();
    await settle();
    expect(spinnerCount(renderer)).toBe(0);
    expect(textOf(renderer)).toContain('Result missing');
    await act(async () => renderer.unmount());
  });
});

describe('scored result controls', () => {
  it('Try again arms a single-use handoff carrying the declared intent and opens the camera', async () => {
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await render();
    await settle();
    expect(peekTryAgainHandoff()).toBeNull();

    await press(renderer, 'Try again');
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    const handoff = peekTryAgainHandoff();
    expect(handoff).not.toBeNull();
    expect(handoff!.declaredStroke).toBe('forehand_drive');
    // Consumed exactly once by the next AnalyzeScreen mount.
    expect(consumeTryAgainHandoff()).not.toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    await act(async () => renderer.unmount());
  });

  it('Done pops to top; another attempt chip replaces the Result route with that analysisId', async () => {
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await render();
    await settle();

    const tabs = hosts(renderer, n => n.props.accessibilityRole === 'tab');
    expect(tabs.length).toBe(2);
    for (const tab of tabs) {
      expect(typeof tab.props.accessibilityLabel).toBe('string');
    }
    const tabPressables = renderer.root.findAll(
      n =>
        n.props.accessibilityRole === 'tab' &&
        typeof n.props.onPress === 'function',
    );
    const current = tabPressables.find(
      t => t.props.accessibilityState?.selected,
    );
    const other = tabPressables.find(
      t => !t.props.accessibilityState?.selected,
    );
    expect(current).toBeDefined();
    expect(other).toBeDefined();
    await act(async () => other!.props.onPress());
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'a0',
    });

    await press(renderer, 'Done');
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });

  it('every button on the surface has an accessibility label and none is disabled without a reason', async () => {
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await render();
    await settle();
    const buttons = hosts(
      renderer,
      n =>
        n.props.accessibilityRole === 'button' && n.props.accessible === true,
    );
    expect(buttons.length).toBeGreaterThan(2);
    for (const button of buttons) {
      expect(typeof button.props.accessibilityLabel).toBe('string');
      expect(button.props.accessibilityLabel.length).toBeGreaterThan(0);
      expect(button.props.accessibilityState?.disabled).not.toBe(true);
    }
    const labels = buttons.map(b => b.props.accessibilityLabel as string);
    expect(labels).toEqual(expect.arrayContaining(['Try again', 'Done']));
    await act(async () => renderer.unmount());
  });
});

describe('training section states', () => {
  it('without a configured training API the section is honest and offers no dead button', async () => {
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await render();
    await settle();
    expect(textOf(renderer)).toContain('Training is not connected.');
    expect(findButton(renderer, 'Build reviewed plan')).toBeNull();
    expect(textOf(renderer)).not.toContain('Checking reviewed training');
    await act(async () => renderer.unmount());
  });

  it('a pending sync pauses plan creation with honest copy (no spinner, no button)', async () => {
    configureTrainingStore(fakeTrainingApi());
    (hasShotSyncReceipt as jest.Mock).mockResolvedValue(false);
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await render();
    await settle();
    await settle();
    expect(textOf(renderer)).toContain('Sync this read first.');
    expect(textOf(renderer)).toContain('still in the secure outbox');
    expect(textOf(renderer)).not.toContain('Checking sync evidence');
    expect(findButton(renderer, 'Build reviewed plan')).toBeNull();
    await act(async () => renderer.unmount());
  });

  it('an unverifiable sync check resolves to the paused state instead of spinning', async () => {
    configureTrainingStore(fakeTrainingApi());
    (hasShotSyncReceipt as jest.Mock).mockRejectedValue(new Error('db'));
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await render();
    await settle();
    await settle();
    expect(textOf(renderer)).toContain('could not verify whether this shot');
    expect(textOf(renderer)).not.toContain('Checking sync evidence');
    await act(async () => renderer.unmount());
  });

  it('a synced scored read exposes "Build reviewed plan"; the in-flight mutation disables it and a server failure is dismissible', async () => {
    let rejectCreate!: (error: Error) => void;
    configureTrainingStore(
      fakeTrainingApi({
        createPlan: () =>
          new Promise((_resolve, reject) => {
            rejectCreate = reject;
          }),
      }),
    );
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await render();
    await settle();
    await settle();
    expect(textOf(renderer)).toContain('Turn this read into a plan.');

    await press(renderer, 'Build reviewed plan');
    expect(useTrainingStore.getState().mutation).toBe('creating-plan');
    const busy = findButton(renderer, 'Building plan…');
    expect(busy).not.toBeNull();
    expect(busy!.props.accessibilityState?.disabled).toBe(true);

    await act(async () => rejectCreate(new Error('server said no')));
    await settle();
    expect(useTrainingStore.getState().mutation).toBe('idle');
    expect(textOf(renderer)).toContain('Training not changed');
    expect(findButton(renderer, 'Build reviewed plan')).not.toBeNull();
    await press(renderer, 'Dismiss');
    expect(textOf(renderer)).not.toContain('Training not changed');
    await act(async () => renderer.unmount());
  });

  it('a training API failure shows an error card with a live "Try again"', async () => {
    let attempts = 0;
    configureTrainingStore(
      fakeTrainingApi({
        getCurrentPlan: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('offline');
          return null;
        },
      }),
    );
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await render();
    await settle();
    await settle();
    expect(textOf(renderer)).toContain('Training could not be verified.');
    // The training card's retry renders before the surface's camera retry.
    await press(renderer, 'Try again', 'first');
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    await settle();
    expect(textOf(renderer)).toContain('Turn this read into a plan.');
    await act(async () => renderer.unmount());
  });
});

describe('abstained (result-null) record', () => {
  it('renders no score stage, says a score is required, and keeps Try again / Done live', async () => {
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(
      abstainedEvidence(),
    );
    const renderer = await render();
    await settle();
    const rendered = textOf(renderer);
    expect(rendered).not.toContain('TECHNIQUE SCORE');
    expect(rendered).toContain('A score is required.');
    expect(rendered).not.toContain('analysis_confidence_below_threshold');
    expect(findButton(renderer, 'Build reviewed plan')).toBeNull();
    await press(renderer, 'Try again');
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    // Abstained AUTO runs re-arm without inventing a declaration.
    expect(peekTryAgainHandoff()?.declaredStroke ?? null).toBeNull();
    await press(renderer, 'Done');
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });
});
