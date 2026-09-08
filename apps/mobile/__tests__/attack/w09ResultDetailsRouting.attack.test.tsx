/**
 * W09-02 ADVERSARIAL — attacks on the `ResultDetails` entry the Result guide's
 * SCORE page gained ("Full breakdown" → `navigate('ResultDetails', {
 * analysisId })`). Each test is one attack at a failure boundary of that
 * routing decision; none of them changes the candidate's code or tests.
 *
 *   A1 double submit          — two presses in one tick + one after: the
 *                               component has no guard, so the REAL
 *                               `StackRouter` (v7 `navigate` pushes unless the
 *                               target is the current route) is fed exactly the
 *                               actions the component dispatched and must end
 *                               with ONE `ResultDetails` above the guide.
 *   A2 interleaved actions    — "Full breakdown" and the page's Next in the
 *                               same tick: one push, the guide advances, the
 *                               entry leaves with the page and returns with it.
 *   A3 route repoint          — `popTo('Result', { analysisId })` from the
 *                               details' attempt chips keeps the Result route
 *                               KEY, so the guide is re-rendered (not
 *                               remounted) with new params: the entry must
 *                               follow the params, never a stale closure.
 *   A4 corrupt/partial state  — the row vanishes (or the read hangs) between
 *                               the guide and the details push: the details
 *                               route must show "Result missing" / the loading
 *                               shell with a working Back, never a fabricated
 *                               breakdown.
 *   A5 attempt chips + Done   — the real router: `popTo` repoints the SAME
 *                               Result route with exactly the typed params;
 *                               `popToTop` from the details leaves only Tabs;
 *                               `goBack` returns to the identical guide route.
 *   A6 copy / accessibility   — every pressable on the SCORE page and the
 *                               details route carries a button role and a
 *                               label equal to its visible text; the entry's
 *                               label appears once; no forbidden store copy.
 *   A7 boundary ids           — long / unicode / whitespace analysis ids pass
 *                               through unchanged (no trimming, no encoding,
 *                               no extra keys).
 *   A8 legacy evidence        — a row whose scored analysis lives only on
 *                               `record.result` (analysis null) still offers
 *                               the entry and the details route renders it.
 *   A9 reentrancy             — the OLD attempt's evidence read resolves
 *                               (as missing) AFTER the route was repointed:
 *                               the new attempt must stay on screen.
 *   A10 try-again stack       — pins, through the real router, the stack
 *                               "Try it again" from the details leaves under
 *                               the new run, next to the guide's own.
 */
jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));

const mockLoadEvidence = jest.fn();
jest.mock('../../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: (...args: unknown[]) => mockLoadEvidence(...args),
}));

const mockLoadSequence = jest.fn();
jest.mock('../../src/review/poseSidecar', () => ({
  loadReviewPoseSequence: (...args: unknown[]) => mockLoadSequence(...args),
}));

const mockHasShotSyncReceipt = jest.fn();
const mockGetShotOutboxStatus = jest.fn();
const mockRetryShotSync = jest.fn();
const mockListRealAnalysisFacts = jest.fn();
jest.mock('../../src/data/syncRuntime', () => ({
  triggerOutboxSync: jest.fn(async () => {}),
}));
jest.mock('../../src/data/repository', () => ({
  hasShotSyncReceipt: (...args: unknown[]) => mockHasShotSyncReceipt(...args),
  getShotOutboxStatus: (...args: unknown[]) => mockGetShotOutboxStatus(...args),
  retryShotSync: (...args: unknown[]) => mockRetryShotSync(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
}));

const mockGetApiSession = jest.fn();
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockListCatalogDrills = jest.fn();
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({ listCatalogDrills: mockListCatalogDrills }),
}));

const mockConsistencyState = {
  refresh: jest.fn(async () => {}),
  daySecured: null as unknown,
  consumeDaySecured: jest.fn(() => null),
};
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (state: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));

const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popTo: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
let mockRouteParams: Record<string, unknown> = { analysisId: 'analysis-1' };
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
    initialWindowMetrics: null,
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
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import type {
  CommonNavigationAction,
  NavigationState,
  ParamListBase,
  Router,
  RouterConfigOptions,
  StackActionType,
  StackNavigationState,
} from '@react-navigation/routers';
import type { RootStackParams } from '../../src/navigation/params';
import { ResultScreen } from '../../src/screens/ResultScreen';
import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import { clearTryAgainHandoff } from '../../src/screens/tryAgainHandoff';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';
import { clearTrainingStoreConfiguration } from '../../src/training/store';

// The REAL stack router — the module the mocked `@react-navigation/native`
// re-exports in production. Nothing native is touched: it is the pure state
// reducer that decides what `navigate` / `popTo` / `goBack` do to the stack.
const routers = jest.requireActual<typeof import('@react-navigation/routers')>(
  '@react-navigation/routers',
);

// ─── Fixtures (same shapes as the result guide + details suites) ────────────

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
  };
}

function scoredAnalysis(id: string): ShotAnalysis {
  return {
    id,
    sessionId: 'set-1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: [
      phase('ready', 0, 900),
      phase('prepare', 900, 1500),
      phase('accelerate', 1500, 1900),
      phase('contact', 1880, 1920, 1900),
      phase('follow_through', 1920, 2400),
      phase('recover', 2400, 3200),
    ],
    measurements: [],
    checkpoints: [
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('athletic_base', 72, 'yellow', 'narrow'),
      checkpoint('paddle_path', 61, 'red', 'low'),
      checkpoint('contact_position', 48, 'red', 'late'),
      checkpoint('recovery', 92, 'green', 'none'),
    ],
    overallScore: 7.1,
    analysisConfidence: 0.84,
    resultKind: 'scored',
    guidance: null,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'lowest_score',
      severity: 0.52,
      confidence: 0.8,
    },
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

function declaredRecord(
  id: string,
  result: ShotAnalysis | null = null,
): StrokeResultEvidenceRecord {
  return {
    id,
    captureId: `capture-${id}`,
    strokeIntent: {
      declaredStroke: 'forehand_drive',
      predictedStroke: null,
      resolutionBasis: 'declared',
      resolvedProfileId: 'FOREHAND_DRIVE',
      resolvedProfileVersion: 'technique-profile-v1',
      disagreement: null,
    },
    result,
    uncertainty: {
      analysisConfidence: 0.84,
      presentation: 'normal',
      limitingFactors: ['paddle_track_unavailable'],
    },
  };
}

function scoredEvidence(id: string) {
  return {
    analysis: scoredAnalysis(id),
    record: declaredRecord(id),
    clip: {
      uri: `file:///captures/${id}.mov`,
      durationMs: 3400,
      posterUri: `file:///captures/${id}.poster.jpg`,
    },
    review: { width: 1080, height: 1920, poseSequence: null },
    attempts: [
      {
        analysisId: id,
        capturedAtIso: '2026-09-01T10:00:00.000Z',
        sessionId: 'set-1',
      },
    ],
  };
}

/** A row whose analysis store is empty but whose record still carries the
 * scored result (the evidence hook falls back to `record.result`). */
function legacyRecordOnlyEvidence(id: string) {
  return {
    analysis: null,
    record: declaredRecord(id, scoredAnalysis(id)),
    clip: null,
    review: null,
    attempts: [],
  };
}

const emptyEvidence = {
  analysis: null,
  record: null,
  clip: null,
  review: null,
  attempts: [],
};

// ─── Harness ────────────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(element: React.ReactElement) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  await settle();
  mounted.push(renderer);
  return renderer;
}

async function update(
  renderer: ReactTestRenderer,
  element: React.ReactElement,
) {
  await act(async () => {
    renderer.update(element);
  });
  await settle();
}

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function pressablesByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    candidate =>
      candidate.props.testID === testID &&
      typeof candidate.props.onPress === 'function',
  );
}

function pressableByTestId(renderer: ReactTestRenderer, testID: string) {
  const [node] = pressablesByTestId(renderer, testID);
  if (!node) throw new Error(`no pressable with testID ${testID}`);
  return node;
}

async function press(renderer: ReactTestRenderer, testID: string) {
  const node = pressableByTestId(renderer, testID);
  await act(async () => {
    node.props.onPress();
  });
  await settle();
}

async function pressByLabel(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.accessibilityLabel === label &&
      typeof candidate.props.onPress === 'function',
  );
  if (!node) throw new Error(`no pressable labelled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
  await settle();
}

/** Every `Pressable` (the one touchable primitive the screens use) with its
 * role, label and visible text. */
function hostPressables(renderer: ReactTestRenderer) {
  return renderer.root
    .findAll(node => {
      if (typeof node.type === 'string') return false;
      const type = node.type as { displayName?: string; name?: string };
      return (
        (type.displayName ?? type.name) === 'Pressable' &&
        typeof node.props.onPress === 'function'
      );
    })
    .map(node => ({
      role: node.props.accessibilityRole as string,
      label: node.props.accessibilityLabel as string | undefined,
      text: node
        .findAllByType(Text)
        .map(t => t.props.children)
        .flat(3)
        .filter((c): c is string => typeof c === 'string')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    }));
}

const BREAKDOWN_LINK = 'result-guide-breakdown-link';

// ─── The real router, configured like RootNavigator's stack ─────────────────

type RootState = StackNavigationState<RootStackParams>;
type RootRouter = Router<RootState, CommonNavigationAction | StackActionType>;

const ROOT_ROUTE_NAMES: (keyof RootStackParams)[] = [
  'Tabs',
  'Analyze',
  'Result',
  'ResultDetails',
  'FormReview',
  'DrillLibrary',
  'StreakCalendar',
  'ConnectAccount',
  'ManageAccount',
  'ConsentSettings',
  'NotificationSettings',
  'Paywall',
];

const routerOptions: RouterConfigOptions = {
  routeNames: ROOT_ROUTE_NAMES,
  routeParamList: {},
  routeGetIdList: {},
};

function rootRouter(): RootRouter {
  return routers.StackRouter({}) as unknown as RootRouter;
}

/** [Tabs, Result { analysisId }] — the stack every entry lands on. */
function stackAtResult(router: RootRouter, analysisId: string): RootState {
  const initial = router.getInitialState(routerOptions);
  const atResult = router.getStateForAction(
    initial,
    routers.CommonActions.navigate('Result', { analysisId }),
    routerOptions,
  );
  if (!atResult) throw new Error('could not push Result');
  return atResult as RootState;
}

function apply(
  router: RootRouter,
  state: RootState,
  action: Parameters<RootRouter['getStateForAction']>[1],
): RootState {
  const next = router.getStateForAction(state, action, routerOptions);
  if (next === null) throw new Error(`router refused ${action.type}`);
  return next as RootState;
}

function routeNames(state: NavigationState<ParamListBase>): string[] {
  return state.routes.map(route => route.name);
}

/** Replays what the component asked the mocked navigation to do, through the
 * real router, in the order it asked. */
function replayNavigateCalls(router: RootRouter, state: RootState): RootState {
  let next = state;
  for (const call of mockNavigation.navigate.mock.calls as [
    keyof RootStackParams,
    RootStackParams[keyof RootStackParams],
  ][]) {
    const [name, params] = call;
    next = apply(router, next, routers.CommonActions.navigate(name, params));
  }
  return next;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  clearTryAgainHandoff();
  clearTrainingStoreConfiguration();
  mockRouteParams = { analysisId: 'analysis-1' };
  mockLoadEvidence.mockImplementation(async (_db: unknown, id: unknown) =>
    scoredEvidence(String(id)),
  );
  mockLoadSequence.mockResolvedValue(null);
  mockHasShotSyncReceipt.mockResolvedValue(false);
  mockGetShotOutboxStatus.mockResolvedValue({
    state: 'queued',
    attempts: 0,
    lastError: null,
  });
  mockRetryShotSync.mockResolvedValue(true);
  mockListRealAnalysisFacts.mockResolvedValue([]);
  mockGetApiSession.mockReturnValue(null);
  mockListCatalogDrills.mockResolvedValue([]);
  setActiveDataOwner('00000000-0000-4000-8000-000000000001');
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('W09-02 attack — A1 double submit of "Full breakdown"', () => {
  it('three presses (two in one tick) leave ONE ResultDetails above the guide in the real stack', async () => {
    const renderer = await render(<ResultScreen />);
    const link = pressableByTestId(renderer, BREAKDOWN_LINK);

    // The component has no press guard: it dispatches once per press.
    await act(async () => {
      link.props.onPress();
      link.props.onPress();
    });
    await settle();
    await press(renderer, BREAKDOWN_LINK);
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(3);
    for (const call of mockNavigation.navigate.mock.calls) {
      expect(call).toEqual(['ResultDetails', { analysisId: 'analysis-1' }]);
    }

    // Feed exactly those dispatches to the real StackRouter from
    // [Tabs, Result]. v7 `navigate` pushes when the target is not the current
    // route — the second and third must resolve to the route the first
    // pushed, not stack two more.
    const router = rootRouter();
    const before = stackAtResult(router, 'analysis-1');
    expect(routeNames(before)).toEqual(['Tabs', 'Result']);
    const after = replayNavigateCalls(router, before);
    expect(routeNames(after)).toEqual(['Tabs', 'Result', 'ResultDetails']);
    expect(after.index).toBe(2);
    expect(after.routes[2]!.params).toEqual({ analysisId: 'analysis-1' });
    // The guide route underneath is untouched (same key, same params).
    expect(after.routes[1]).toEqual(before.routes[1]);

    // And Back from the details lands on that same guide route.
    const back = apply(router, after, routers.CommonActions.goBack());
    expect(routeNames(back)).toEqual(['Tabs', 'Result']);
    expect(back.routes[1]!.key).toBe(before.routes[1]!.key);
  });
});

describe('W09-02 attack — A2 interleaved "Full breakdown" + Next in one tick', () => {
  it('pushes once, the guide advances, the entry leaves with the page and comes back with it', async () => {
    const renderer = await render(<ResultScreen />);
    const link = pressableByTestId(renderer, BREAKDOWN_LINK);
    const next = pressableByTestId(renderer, 'result-guide-next');

    await act(async () => {
      link.props.onPress();
      next.props.onPress();
    });
    await settle();

    expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('ResultDetails', {
      analysisId: 'analysis-1',
    });
    // The guide moved to THE PROBLEM; no entry there.
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(0);
    expect(hostByTestId(renderer, BREAKDOWN_LINK)).toHaveLength(0);
    expect(allText(renderer)).not.toContain('Full breakdown');
    // Nothing else was dispatched.
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(mockNavigation.popTo).not.toHaveBeenCalled();
    expect(mockNavigation.popToTop).not.toHaveBeenCalled();
    expect(mockNavigation.goBack).not.toHaveBeenCalled();

    // Reverse order in one tick (Next first, then the entry that was on
    // screen when the tap landed): still one dispatch with the same params.
    await press(renderer, 'result-guide-back');
    expect(hostByTestId(renderer, BREAKDOWN_LINK)).toHaveLength(1);
    const link2 = pressableByTestId(renderer, BREAKDOWN_LINK);
    const next2 = pressableByTestId(renderer, 'result-guide-next');
    await act(async () => {
      next2.props.onPress();
      link2.props.onPress();
    });
    await settle();
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(2);
    expect(mockNavigation.navigate).toHaveBeenLastCalledWith('ResultDetails', {
      analysisId: 'analysis-1',
    });
    expect(hostByTestId(renderer, BREAKDOWN_LINK)).toHaveLength(0);
  });
});

describe('W09-02 attack — A3 the Result route is repointed in place (popTo keeps the key)', () => {
  it('the entry follows the new params; a stale closure would push the old attempt', async () => {
    const renderer = await render(<ResultScreen />);
    expect(mockLoadEvidence).toHaveBeenLastCalledWith({}, 'analysis-1');

    // `popTo('Result', { analysisId: 'analysis-0' })` from the details'
    // attempt chip changes route.params on the SAME route key: React
    // re-renders the mounted ResultScreen with the new params.
    mockRouteParams = { analysisId: 'analysis-0' };
    await update(renderer, <ResultScreen />);
    expect(mockLoadEvidence).toHaveBeenLastCalledWith({}, 'analysis-0');
    // The guide restarted on SCORE (keyed by attempt) with its entry.
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(1);
    expect(hostByTestId(renderer, BREAKDOWN_LINK)).toHaveLength(1);

    await press(renderer, BREAKDOWN_LINK);
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('ResultDetails', {
      analysisId: 'analysis-0',
    });
    expect(mockNavigation.navigate).not.toHaveBeenCalledWith('ResultDetails', {
      analysisId: 'analysis-1',
    });

    // Repoint again while the guide is on a later page: the page resets to
    // SCORE for the new attempt and the entry names the new attempt.
    await press(renderer, 'result-guide-next');
    expect(hostByTestId(renderer, BREAKDOWN_LINK)).toHaveLength(0);
    mockRouteParams = { analysisId: 'analysis-9' };
    await update(renderer, <ResultScreen />);
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(1);
    await press(renderer, BREAKDOWN_LINK);
    expect(mockNavigation.navigate).toHaveBeenLastCalledWith('ResultDetails', {
      analysisId: 'analysis-9',
    });
  });
});

describe('W09-02 attack — A4 the row disappears between the guide and the details push', () => {
  it('a read that now REJECTS shows "Result missing" with a working Back — no fabricated breakdown', async () => {
    // The guide read fine…
    const guide = await render(<ResultScreen />);
    expect(hostByTestId(guide, BREAKDOWN_LINK)).toHaveLength(1);
    await press(guide, BREAKDOWN_LINK);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('ResultDetails', {
      analysisId: 'analysis-1',
    });

    // …then the row is gone (deleted / owner scope changed) when the pushed
    // details route reads it.
    mockLoadEvidence.mockRejectedValue(new Error('no such row'));
    const details = await render(<ResultDetailsScreen />);
    expect(hostByTestId(details, 'result-details-breakdown')).toHaveLength(0);
    expect(hostByTestId(details, 'result-details')).toHaveLength(0);
    expect(hostByTestId(details, 'stroke-result-surface')).toHaveLength(0);
    const copy = allText(details);
    expect(copy).toContain('Result missing');
    expect(copy).toContain('This analysis is no longer on this device.');
    expect(copy).not.toContain('Stroke map');
    expect(copy).not.toContain('What to fix');
    expect(copy).not.toContain('Personalized training');

    await pressByLabel(details, 'Go back');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    expect(mockNavigation.popToTop).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(mockNavigation.popTo).not.toHaveBeenCalled();
  });

  it('a read that RESOLVES empty (partial state) shows the same missing state', async () => {
    mockLoadEvidence.mockResolvedValue(emptyEvidence);
    const details = await render(<ResultDetailsScreen />);
    expect(hostByTestId(details, 'result-details-breakdown')).toHaveLength(0);
    expect(allText(details)).toContain('Result missing');
    await pressByLabel(details, 'Go back');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('a read that never settles keeps the loading shell with Back — nothing is invented meanwhile', async () => {
    mockLoadEvidence.mockReturnValue(new Promise(() => {}));
    const details = await render(<ResultDetailsScreen />);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await settle();
    expect(hostByTestId(details, 'result-details-breakdown')).toHaveLength(0);
    const copy = allText(details);
    expect(copy).toContain('Full breakdown');
    expect(copy).toContain('Opening your result…');
    expect(copy).not.toContain('Result missing');
    expect(copy).not.toContain('Stroke map');
    await pressByLabel(details, 'Back');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  });
});

describe('W09-02 attack — A5 the details loops through the real router', () => {
  it('attempt chip → popTo repoints the SAME Result route with exactly the typed params', async () => {
    const router = rootRouter();
    const before = stackAtResult(router, 'analysis-1');
    const atDetails = apply(
      router,
      before,
      routers.CommonActions.navigate('ResultDetails', {
        analysisId: 'analysis-1',
      }),
    );
    expect(routeNames(atDetails)).toEqual(['Tabs', 'Result', 'ResultDetails']);

    // ResultDetailsScreen: `navigation.popTo('Result', { analysisId: target })`
    const popped = apply(
      router,
      atDetails,
      routers.StackActions.popTo('Result', { analysisId: 'analysis-0' }),
    );
    expect(routeNames(popped)).toEqual(['Tabs', 'Result']);
    expect(popped.index).toBe(1);
    // Same route key (the screen is re-rendered, not remounted — A3 covers
    // the component side) and EXACTLY the typed params, nothing merged in.
    expect(popped.routes[1]!.key).toBe(before.routes[1]!.key);
    expect(popped.routes[1]!.params).toEqual({ analysisId: 'analysis-0' });
    expect(Object.keys(popped.routes[1]!.params ?? {})).toEqual(['analysisId']);
  });

  it('Done → popToTop leaves only Tabs; goBack returns to the identical guide route', async () => {
    const router = rootRouter();
    const before = stackAtResult(router, 'analysis-1');
    const atDetails = apply(
      router,
      before,
      routers.CommonActions.navigate('ResultDetails', {
        analysisId: 'analysis-1',
      }),
    );
    const home = apply(router, atDetails, routers.StackActions.popToTop());
    expect(routeNames(home)).toEqual(['Tabs']);
    expect(home.index).toBe(0);

    const back = apply(router, atDetails, routers.CommonActions.goBack());
    expect(routeNames(back)).toEqual(['Tabs', 'Result']);
    expect(back.routes[1]).toEqual(before.routes[1]);
  });

  it('the details screen dispatches those exact actions (popTo for another attempt, nothing for the same one, popToTop for Done)', async () => {
    mockLoadEvidence.mockImplementation(async (_db: unknown, id: unknown) => ({
      ...scoredEvidence(String(id)),
      attempts: [
        {
          analysisId: 'analysis-0',
          capturedAtIso: '2026-09-01T09:59:00.000Z',
          sessionId: 'set-1',
        },
        {
          analysisId: 'analysis-1',
          capturedAtIso: '2026-09-01T10:00:00.000Z',
          sessionId: 'set-1',
        },
      ],
    }));
    const details = await render(<ResultDetailsScreen />);
    expect(hostByTestId(details, 'result-details-breakdown')).toHaveLength(1);

    await pressByLabel(details, 'Attempt 2');
    expect(mockNavigation.popTo).not.toHaveBeenCalled();
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();

    await pressByLabel(details, 'Attempt 1');
    expect(mockNavigation.popTo).toHaveBeenCalledTimes(1);
    expect(mockNavigation.popTo).toHaveBeenCalledWith('Result', {
      analysisId: 'analysis-0',
    });
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
  });
});

describe('W09-02 attack — A6 copy and accessibility of the new entry', () => {
  const FORBIDDEN = [
    /android/i,
    /google play/i,
    /guest mode/i,
    /live court/i,
    /\bDUPR\b/,
    /swingvision/i,
    /pb vision/i,
    /selkirk/i,
    /joola/i,
    /\d+\s*%\s*accura/i,
    /most accurate/i,
    /best (coach|app)/i,
    /as good as a( human)? coach/i,
    /replaces? (a|your) coach/i,
  ];

  it('every pressable on the SCORE page has a button role and a label equal to its visible text; the entry appears once', async () => {
    const renderer = await render(<ResultScreen />);
    const pressables = hostPressables(renderer);
    expect(pressables.length).toBeGreaterThan(0);
    for (const item of pressables) {
      expect(item.role).toBe('button');
      expect(typeof item.label).toBe('string');
      expect(item.label!.trim().length).toBeGreaterThan(0);
      if (item.text.length > 0) expect(item.label).toBe(item.text);
    }
    const entries = pressables.filter(item => item.label === 'Full breakdown');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe('Full breakdown');
    const copy = allText(renderer);
    expect(copy.match(/Full breakdown/g)).toHaveLength(1);
    for (const pattern of FORBIDDEN) expect(copy).not.toMatch(pattern);
  });

  it('the details route: header + sheet pressables are labelled buttons and the copy carries no forbidden claims', async () => {
    const details = await render(<ResultDetailsScreen />);
    expect(hostByTestId(details, 'result-details-breakdown')).toHaveLength(1);
    const pressables = hostPressables(details);
    expect(pressables.length).toBeGreaterThan(0);
    for (const item of pressables) {
      expect(['button', 'link']).toContain(item.role);
      expect(typeof item.label).toBe('string');
      expect(item.label!.trim().length).toBeGreaterThan(0);
    }
    expect(pressables.some(item => item.label === 'Back')).toBe(true);
    // The route never offers the guide's entry back into itself.
    expect(pressables.some(item => item.label === 'Full breakdown')).toBe(
      false,
    );
    const copy = allText(details);
    for (const pattern of FORBIDDEN) expect(copy).not.toMatch(pattern);
  });
});

describe('W09-02 attack — A7 boundary analysis ids pass through untouched', () => {
  const IDS = [
    'x'.repeat(2048),
    ' leading-and-trailing-space ',
    'ünïcödé-🥒-id',
    'id with spaces & symbols ?/#%',
    '00000000-0000-4000-8000-000000000001',
  ];

  it.each(IDS)('navigates ResultDetails with exactly %j', async id => {
    mockRouteParams = { analysisId: id };
    const renderer = await render(<ResultScreen />);
    expect(mockLoadEvidence).toHaveBeenCalledWith({}, id);
    await press(renderer, BREAKDOWN_LINK);
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
    const [name, params] = mockNavigation.navigate.mock.calls[0] as [
      string,
      RootStackParams['ResultDetails'],
    ];
    expect(name).toBe('ResultDetails');
    expect(params.analysisId).toBe(id);
    expect(Object.keys(params)).toEqual(['analysisId']);

    // The details route then reads exactly that id.
    mockLoadEvidence.mockClear();
    const details = await render(<ResultDetailsScreen />);
    expect(mockLoadEvidence).toHaveBeenCalledWith({}, id);
    expect(hostByTestId(details, 'result-details-breakdown')).toHaveLength(1);
  });
});

describe('W09-02 attack — A9 out-of-order evidence after a repoint (reentrancy)', () => {
  it('the OLD attempt resolving late (and as missing) after popTo repointed the guide must not replace the new attempt', async () => {
    let resolveOld!: (value: typeof emptyEvidence) => void;
    mockLoadEvidence.mockImplementation((_db: unknown, id: unknown) =>
      String(id) === 'analysis-1'
        ? new Promise<typeof emptyEvidence>(resolve => {
            resolveOld = resolve;
          })
        : Promise.resolve(scoredEvidence(String(id))),
    );
    const renderer = await render(<ResultScreen />);
    // Still loading the first attempt…
    expect(hostByTestId(renderer, BREAKDOWN_LINK)).toHaveLength(0);

    // …when the details' attempt chip repoints this route at analysis-0.
    mockRouteParams = { analysisId: 'analysis-0' };
    await update(renderer, <ResultScreen />);
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(1);
    expect(hostByTestId(renderer, BREAKDOWN_LINK)).toHaveLength(1);

    // The stale read lands, and lands as "gone".
    await act(async () => {
      resolveOld(emptyEvidence);
    });
    await settle();
    expect(allText(renderer)).not.toContain('Result missing');
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(1);
    await press(renderer, BREAKDOWN_LINK);
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('ResultDetails', {
      analysisId: 'analysis-0',
    });
  });

  it('the same race on the details route keeps the new attempt', async () => {
    let resolveOld!: (value: typeof emptyEvidence) => void;
    mockLoadEvidence.mockImplementation((_db: unknown, id: unknown) =>
      String(id) === 'analysis-1'
        ? new Promise<typeof emptyEvidence>(resolve => {
            resolveOld = resolve;
          })
        : Promise.resolve(scoredEvidence(String(id))),
    );
    const details = await render(<ResultDetailsScreen />);
    expect(hostByTestId(details, 'result-details-breakdown')).toHaveLength(0);
    mockRouteParams = { analysisId: 'analysis-0' };
    await update(details, <ResultDetailsScreen />);
    expect(hostByTestId(details, 'result-details-breakdown')).toHaveLength(1);
    await act(async () => {
      resolveOld(emptyEvidence);
    });
    await settle();
    expect(hostByTestId(details, 'result-details-breakdown')).toHaveLength(1);
    expect(allText(details)).not.toContain('Result missing');
    expect(mockLoadEvidence).toHaveBeenCalledTimes(2);
  });
});

describe('W09-02 attack — A10 "Try it again" from the details through the real router', () => {
  it('records the stack the guide + details leave under the new run (the guide keeps its own identical semantics)', async () => {
    const router = rootRouter();
    const before = stackAtResult(router, 'analysis-1');
    const atDetails = apply(
      router,
      before,
      routers.CommonActions.navigate('ResultDetails', {
        analysisId: 'analysis-1',
      }),
    );
    // ResultDetailsScreen.onTryAgain → navigate('Analyze', { source: 'camera' })
    const atAnalyze = apply(
      router,
      atDetails,
      routers.CommonActions.navigate('Analyze', { source: 'camera' }),
    );
    // AnalyzeScreen finishes → replace('Result', { analysisId: 'analysis-2' })
    const afterRun = apply(
      router,
      atAnalyze,
      routers.StackActions.replace('Result', { analysisId: 'analysis-2' }),
    );
    // OBSERVED (pinned): the retired guide and its details stay under the new
    // result — the same shape the guide's own TRY AGAIN produces one level
    // shallower ([Tabs, Result(old), Result(new)]).
    expect(routeNames(afterRun)).toEqual([
      'Tabs',
      'Result',
      'ResultDetails',
      'Result',
    ]);
    expect(afterRun.routes[3]!.params).toEqual({ analysisId: 'analysis-2' });
    // The guide's Close / Done (popToTop) still clears all of it.
    expect(
      routeNames(apply(router, afterRun, routers.StackActions.popToTop())),
    ).toEqual(['Tabs']);
    // Same shape from the guide alone, for comparison.
    const guideRun = apply(
      router,
      apply(
        router,
        before,
        routers.CommonActions.navigate('Analyze', { source: 'camera' }),
      ),
      routers.StackActions.replace('Result', { analysisId: 'analysis-2' }),
    );
    expect(routeNames(guideRun)).toEqual(['Tabs', 'Result', 'Result']);
  });
});

describe('W09-02 attack — A8 legacy evidence (scored result only on record.result)', () => {
  it('the guide still offers the entry and the details route renders the same attempt', async () => {
    mockLoadEvidence.mockImplementation(async (_db: unknown, id: unknown) =>
      legacyRecordOnlyEvidence(String(id)),
    );
    const renderer = await render(<ResultScreen />);
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(1);
    expect(hostByTestId(renderer, BREAKDOWN_LINK)).toHaveLength(1);
    await press(renderer, BREAKDOWN_LINK);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('ResultDetails', {
      analysisId: 'analysis-1',
    });

    const details = await render(<ResultDetailsScreen />);
    expect(hostByTestId(details, 'result-details-breakdown')).toHaveLength(1);
    expect(allText(details)).not.toContain('Result missing');
  });
});
