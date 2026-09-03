/**
 * Workflow verification — Analyze → Result (Result side).
 *
 * The Result route is a short sequential guide (SCORE → THE PROBLEM →
 * DRILLS → NEXT; pages without evidence are skipped) and the former one-page
 * surface — the canonical StrokeResult with the personalized training section
 * — is `ResultBreakdownSheet`, hosted by the `ResultDetails` route. Both are
 * mounted for real here (evidence loading mocked at the data seam) and
 * pressed as a player would:
 *   - opening spinner → header Close pops to top; spinner never survives the
 *     evidence load (loaded / missing / rejected)
 *   - "Result missing" → its action goes back (no dead end)
 *   - Try it again (last page) → single-use handoff armed with the SAME
 *     declared intent + practice set and navigation to Analyze{source:'camera'}
 *   - Done → popToTop; another attempt's pill on THIS SET →
 *     replace('Result', {analysisId}); the current one is inert
 *   - training section (ResultDetails): unconfigured API is honest,
 *     pending/unknown sync pauses plan creation, synced scored read exposes
 *     "Build reviewed plan" and the in-flight mutation disables it; no
 *     unbounded sync spinner
 *   - abstained (result-null) record: ONE page, no score stage, "A score is
 *     required.", Try it again / Done live
 */
jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('../../src/data/repository', () => ({
  hasShotSyncReceipt: jest.fn(),
  getShotOutboxStatus: jest.fn(),
  listRealAnalysisFacts: jest.fn(),
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
  popTo: jest.fn(),
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
    SafeAreaView: (props: { children?: React.ReactNode; testID?: string }) =>
      React.createElement(View, { testID: props.testID }, props.children),
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
import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  listRealAnalysisFacts,
  type RealAnalysisFact,
} from '../../src/data/repository';
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
    review: null,
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
    review: null,
    attempts: [],
  };
}

const missingEvidence: StrokeResultEvidence = {
  analysis: null,
  record: null,
  clip: null,
  review: null,
  attempts: [],
};

/** The scored facts of practice set `s1` as the repository reports them —
 * two comparable attempts, so THIS SET renders on the score page. */
function setFacts(): RealAnalysisFact[] {
  const base = {
    shotType: 'forehand_drive',
    confidence: 0.82,
    resultKind: 'scored' as const,
    scoringModelVersion: 'scoring-1',
    shotConfigVersion: 'config-1',
    sessionId: 's1',
    priorityCheckpoint: null,
    checkpointScores: {},
  };
  return [
    {
      ...base,
      id: 'a0',
      capturedAt: '2026-08-31T10:00:00.000Z',
      overallScore: 6.8,
    },
    {
      ...base,
      id: 'a1',
      capturedAt: '2026-09-01T10:00:00.000Z',
      overallScore: 7.4,
    },
  ];
}

function textOf(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function hosts(
  renderer: ReactTestRenderer,
  predicate: (node: TestRenderer.ReactTestInstance) => boolean,
) {
  return renderer.root.findAll(n => typeof n.type === 'string' && predicate(n));
}

/** Drops every candidate that contains another candidate (composite wrappers
 * such as PressableScale re-emit the props of the Pressable inside them). */
function innermost(candidates: TestRenderer.ReactTestInstance[]) {
  return candidates.filter(
    n =>
      !candidates.some(
        other => other !== n && n.findAll(x => x === other).length > 0,
      ),
  );
}

/** Innermost pressable per visible label (composite Pressable nodes carry
 * onPress; host Views do not), in render order. */
function findButtons(renderer: ReactTestRenderer, label: string) {
  return innermost(
    renderer.root.findAll(
      n =>
        typeof n.props.onPress === 'function' &&
        n.props.accessibilityRole === 'button' &&
        n.findAll(t => t.type === Text && String(t.props.children) === label)
          .length > 0,
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

/** Evidence → sync receipt → outbox status → plan resolve on successive
 * microtask turns (timers are faked so no Animated tick outlives a test). */
async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** The Result route: the four-page guide. */
async function render(analysisId = 'a1') {
  mockRouteParams = { analysisId };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultScreen />);
  });
  return renderer;
}

/** The ResultDetails route: the full breakdown (StrokeResult + training). */
async function renderDetails(analysisId = 'a1') {
  mockRouteParams = { analysisId };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultDetailsScreen />);
  });
  return renderer;
}

/** The guide's footer label that names what the NEXT page is about. */
function stepLabel(renderer: ReactTestRenderer): string {
  const [label] = hosts(
    renderer,
    n => n.props.testID === 'result-guide-step-label',
  );
  if (!label) return '';
  const children = label.props.children;
  return Array.isArray(children) ? children.join('') : String(children);
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
  jest.useFakeTimers();
  jest.clearAllMocks();
  clearTryAgainHandoff();
  clearTrainingStoreConfiguration();
  (hasShotSyncReceipt as jest.Mock).mockResolvedValue(true);
  (getShotOutboxStatus as jest.Mock).mockResolvedValue({
    state: 'queued',
    attempts: 0,
    lastError: null,
  });
  (listRealAnalysisFacts as jest.Mock).mockResolvedValue([]);
});

afterEach(() => {
  clearTrainingStoreConfiguration();
  jest.useRealTimers();
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
    // The guide opens on its SCORE page — nothing else is on the first screen.
    expect(textOf(renderer)).toContain('TECHNIQUE SCORE');
    expect(
      hosts(renderer, n => n.props.testID === 'result-guide-step-score'),
    ).toHaveLength(1);
    expect(textOf(renderer)).not.toContain('Personalized training');
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
    // Evidence that is gone gets "Go back", never a retry that cannot work.
    expect(actions[actions.length - 1]!.props.accessibilityLabel).toBe(
      'Go back',
    );
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

  it('the ResultDetails route loads its own evidence and its Back returns to the guide', async () => {
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await renderDetails();
    await settle();
    expect(loadStrokeResultEvidence).toHaveBeenCalledWith({}, 'a1');
    expect(textOf(renderer)).toContain('Full breakdown');
    expect(
      hosts(renderer, n => n.props.testID === 'result-details-breakdown'),
    ).toHaveLength(1);
    const [back] = renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === 'Back' &&
        typeof n.props.onPress === 'function',
    );
    expect(back).toBeDefined();
    await act(async () => back!.props.onPress());
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });
});

describe('scored result controls', () => {
  it('Try it again (last page) arms a single-use handoff carrying the declared intent + set and opens the camera', async () => {
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await render();
    await settle();
    expect(peekTryAgainHandoff()).toBeNull();
    // No fault, no replay, no drill focus: SCORE → NEXT is the whole guide.
    expect(stepLabel(renderer)).toBe('1 OF 2 · SCORE');
    expect(findButton(renderer, 'Try it again')).toBeNull();
    await press(renderer, 'Continue');
    expect(stepLabel(renderer)).toBe('2 OF 2 · NEXT');

    await press(renderer, 'Try it again');
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    const handoff = peekTryAgainHandoff();
    expect(handoff).not.toBeNull();
    expect(handoff!.declaredStroke).toBe('forehand_drive');
    expect(handoff!.declaredCanonical).toBe('FOREHAND_DRIVE');
    expect(handoff!.auto).toBe(false);
    // The re-record joins the SAME practice set.
    expect(handoff!.sessionId).toBe('s1');
    // Consumed exactly once by the next AnalyzeScreen mount.
    expect(consumeTryAgainHandoff()).not.toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    await act(async () => renderer.unmount());
  });

  it('Done pops to top; another attempt pill on THIS SET replaces the Result route with that analysisId', async () => {
    (listRealAnalysisFacts as jest.Mock).mockResolvedValue(setFacts());
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await render();
    await settle();

    // THIS SET renders on the score page once two comparable attempts exist.
    expect(
      hosts(renderer, n => n.props.testID === 'result-guide-practice-set'),
    ).toHaveLength(1);
    expect(textOf(renderer)).toContain('THIS SET');
    const pills = innermost(
      renderer.root.findAll(
        n =>
          typeof n.props.testID === 'string' &&
          n.props.testID.startsWith('practice-set-attempt-') &&
          typeof n.props.onPress === 'function',
      ),
    );
    expect(pills.map(p => p.props.testID)).toEqual([
      'practice-set-attempt-a0',
      'practice-set-attempt-a1',
    ]);
    for (const pill of pills) {
      expect(typeof pill.props.accessibilityLabel).toBe('string');
    }
    // The attempt on screen is inert; the other one repoints the route.
    await act(async () => pills[1]!.props.onPress());
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    await act(async () => pills[0]!.props.onPress());
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'a0',
    });

    await press(renderer, 'Continue');
    await press(renderer, 'Done');
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });

  it('attempt tabs on the ResultDetails sheet pop back to the guide repointed at that attempt', async () => {
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await renderDetails();
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
    await act(async () => current!.props.onPress());
    expect(mockNavigation.popTo).not.toHaveBeenCalled();
    await act(async () => other!.props.onPress());
    // Never a second Result on the stack: the guide underneath is repointed.
    expect(mockNavigation.popTo).toHaveBeenCalledWith('Result', {
      analysisId: 'a0',
    });
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    // The sheet embeds the surface without a second CTA row.
    expect(findButton(renderer, 'Try again')).toBeNull();
    expect(findButton(renderer, 'Done')).toBeNull();
    await act(async () => renderer.unmount());
  });

  it('every button on the guide has an accessibility label and none is disabled without a reason', async () => {
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await render();
    await settle();
    const audit = (expected: string[]) => {
      const buttons = hosts(
        renderer,
        n =>
          n.props.accessibilityRole === 'button' && n.props.accessible === true,
      );
      expect(buttons.length).toBeGreaterThan(1);
      for (const button of buttons) {
        expect(typeof button.props.accessibilityLabel).toBe('string');
        expect(button.props.accessibilityLabel.length).toBeGreaterThan(0);
        expect(button.props.accessibilityState?.disabled).not.toBe(true);
      }
      const labels = buttons.map(b => b.props.accessibilityLabel as string);
      expect(labels.sort()).toEqual(expected.sort());
    };
    // SCORE: Close + the descriptive Next; no Back on the first page.
    audit(['Close', 'Continue']);
    await press(renderer, 'Continue');
    // NEXT: Try it again with Back and Done beside it.
    audit(['Close', 'Try it again', 'Back', 'Done']);
    await press(renderer, 'Back');
    audit(['Close', 'Continue']);
    await act(async () => renderer.unmount());
  });
});

describe('training section states (ResultDetails)', () => {
  it('without a configured training API the section is honest and offers no dead button', async () => {
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await renderDetails();
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
    const renderer = await renderDetails();
    await settle();
    await settle();
    expect(textOf(renderer)).toContain('Sync this read first.');
    expect(textOf(renderer)).toContain('still in the secure outbox');
    expect(textOf(renderer)).not.toContain('Checking sync evidence');
    expect(findButton(renderer, 'Build reviewed plan')).toBeNull();
    // No feedback prompt is asked for a shot the server has not accepted.
    expect(textOf(renderer)).not.toContain('Was this analysis accurate?');
    await act(async () => renderer.unmount());
  });

  it('an unverifiable sync check resolves to the paused state instead of spinning', async () => {
    configureTrainingStore(fakeTrainingApi());
    (hasShotSyncReceipt as jest.Mock).mockRejectedValue(new Error('db'));
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await renderDetails();
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
    const renderer = await renderDetails();
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
    const renderer = await renderDetails();
    await settle();
    await settle();
    expect(textOf(renderer)).toContain('Training could not be verified.');
    // The sheet has no camera CTA row, so this Try again is the plan retry.
    expect(findButtons(renderer, 'Try again')).toHaveLength(1);
    await press(renderer, 'Try again', 'first');
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    await settle();
    expect(textOf(renderer)).toContain('Turn this read into a plan.');
    await act(async () => renderer.unmount());
  });

  it('the guide itself never shows the training section on any page', async () => {
    configureTrainingStore(fakeTrainingApi());
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(scoredEvidence());
    const renderer = await render();
    await settle();
    await settle();
    expect(
      hosts(renderer, n => n.props.testID === 'training-plan-section'),
    ).toHaveLength(0);
    expect(findButton(renderer, 'Build reviewed plan')).toBeNull();
    await press(renderer, 'Continue');
    expect(
      hosts(renderer, n => n.props.testID === 'training-plan-section'),
    ).toHaveLength(0);
    expect(textOf(renderer)).not.toContain('Personalized training');
    // Nor a link to the breakdown route (product decision 2026-09-02).
    expect(textOf(renderer)).not.toContain('See full breakdown');
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
});

describe('abstained (result-null) record', () => {
  it('collapses to one page with no score stage, says a score is required, and keeps Try it again / Done live', async () => {
    (loadStrokeResultEvidence as jest.Mock).mockResolvedValue(
      abstainedEvidence(),
    );
    const renderer = await render();
    await settle();
    const rendered = textOf(renderer);
    expect(rendered).not.toContain('TECHNIQUE SCORE');
    expect(rendered).toContain('RESULT · NOT SCORED');
    // The inline sheet's training section is honest about the missing score.
    expect(rendered).toContain('A score is required.');
    expect(rendered).not.toContain('analysis_confidence_below_threshold');
    expect(findButton(renderer, 'Build reviewed plan')).toBeNull();
    // ONE CTA pair — the guide's footer, not a second row in the surface.
    expect(findButton(renderer, 'Try again')).toBeNull();
    expect(findButton(renderer, 'Continue')).toBeNull();
    expect(findButton(renderer, 'Back')).toBeNull();
    await press(renderer, 'Try it again');
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    // Abstained AUTO runs re-arm without inventing a declaration.
    expect(peekTryAgainHandoff()).toEqual({
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: true,
      sessionId: null,
    });
    await press(renderer, 'Done');
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });
});
