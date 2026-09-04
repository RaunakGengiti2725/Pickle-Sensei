/**
 * Adversarial pass (mobile-results-review, tester #2) against
 * `TrainingPlanSection.openMedia` (ResultScreen.tsx): "Watch reviewed
 * instruction" awaits `Linking.canOpenURL` then `Linking.openURL`; the catch
 * path calls `setDialog(...)`. Attack: let the promises settle AFTER the
 * ResultDetails tree has unmounted and observe whether the unmounted
 * component's `setDialog` is still invoked.
 *
 * Observation channel: React's `useState` is wrapped (identity-stable per
 * setter) so every state-setter call is journaled with the value it carried.
 * A journal entry carrying the "Video unavailable" dialog after `unmount()`
 * IS a setDialog call on an unmounted component. `console.error` /
 * `console.warn` are also captured so any React warning is evidence too.
 *
 * Production code is untouched.
 */
import React from 'react';
import { Linking } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';
import type { StrokeResultEvidence } from '../../src/components/strokeResultData';
import type {
  RealAnalysisFact,
  ShotOutboxStatus,
} from '../../src/data/repository';
import type { CatalogDrill } from '../../src/training/api';
import type {
  DrillDetail,
  TrainingApi,
  TrainingPlan,
  TrainingPlanItem,
} from '../../src/training/types';
import { BrandDialog } from '../../src/design/components';

// ─── setState journal ───────────────────────────────────────────────────────

type JournalEntry = { value: unknown; afterUnmount: boolean };
const mockJournal: JournalEntry[] = [];
let mockUnmounted = false;

jest.mock('react', () => {
  const mockActual = jest.requireActual<typeof import('react')>('react');
  const mockWrapped = new WeakMap<object, unknown>();
  function mockUseState(initial: unknown) {
    const pair = mockActual.useState(initial);
    const mockOriginal = pair[1];
    let mockSetter = mockWrapped.get(mockOriginal);
    if (!mockSetter) {
      mockSetter = function journaledSetter(value: unknown) {
        mockJournal.push({ value, afterUnmount: mockUnmounted });
        mockOriginal(value);
      };
      mockWrapped.set(mockOriginal, mockSetter);
    }
    return [pair[0], mockSetter];
  }
  return {
    ...mockActual,
    useState: mockUseState,
    default: { ...mockActual, useState: mockUseState },
  };
});

function isVideoUnavailable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { title?: unknown }).title === 'Video unavailable'
  );
}

// ─── Module mocks (same shape as __tests__/wf/ResultScreen.buttons.test.tsx) ─

jest.mock('../../src/data/db', () => ({
  getDb: jest.fn(() => ({
    execute: jest.fn(async () => ({ rows: [] })),
    close() {},
  })),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
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

const mockNavigation = {
  navigate: jest.fn(),
  replace: jest.fn(),
  popTo: jest.fn(),
  goBack: jest.fn(),
  popToTop: jest.fn(),
};
const mockRoute = { params: { analysisId: 'a1' } };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => mockRoute,
}));

const mockLoadEvidence = jest.fn<Promise<StrokeResultEvidence>, unknown[]>();
jest.mock('../../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: (...args: unknown[]) => mockLoadEvidence(...args),
}));

const mockHasShotSyncReceipt = jest.fn<Promise<boolean>, unknown[]>();
const mockGetShotOutboxStatus = jest.fn<Promise<ShotOutboxStatus>, unknown[]>();
const mockListRealAnalysisFacts = jest.fn<
  Promise<RealAnalysisFact[]>,
  unknown[]
>();
jest.mock('../../src/data/repository', () => ({
  hasShotSyncReceipt: (...args: unknown[]) => mockHasShotSyncReceipt(...args),
  getShotOutboxStatus: (...args: unknown[]) => mockGetShotOutboxStatus(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
}));

const mockConsistencyState = {
  daySecured: null as unknown,
  refresh: jest.fn(async () => {}),
  consumeDaySecured: jest.fn(() => null),
  recordDrillCompletion: jest.fn(async () => {}),
};
jest.mock('../../src/consistency/store', () => {
  const useConsistencyStore = (
    selector: (s: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState);
  useConsistencyStore.getState = () => mockConsistencyState;
  return { useConsistencyStore };
});

const mockGetApiSession = jest.fn<unknown, []>(() => null);
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

jest.mock('../../src/data/api', () => {
  const actual =
    jest.requireActual<typeof import('../../src/data/api')>(
      '../../src/data/api',
    );
  return {
    ...actual,
    submitAnalysisFeedback: jest.fn(async () => ({})),
  };
});

const mockListCatalogDrills = jest.fn<Promise<CatalogDrill[]>, unknown[]>();
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({
    listCatalogDrills: (...args: unknown[]) => mockListCatalogDrills(...args),
  }),
}));

import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';
import {
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const analysis: ShotAnalysis = {
  id: 'a1',
  sessionId: 's1',
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-30T10:00:00.000Z',
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
};

const declaredEnvelope: StrokeIntentEnvelope = {
  declaredStroke: 'forehand_drive',
  predictedStroke: null,
  resolutionBasis: 'declared',
  resolvedProfileId: 'FOREHAND_DRIVE',
  resolvedProfileVersion: 'technique-profile-v1',
  disagreement: null,
};

const record = {
  id: 'a1',
  captureId: 'capture-1',
  strokeIntent: declaredEnvelope,
  result: null,
  uncertainty: {
    analysisConfidence: 0.82,
    presentation: 'normal',
    limitingFactors: [],
  },
} as StrokeResultEvidenceRecord;

const evidence: StrokeResultEvidence = {
  analysis,
  record,
  clip: null,
  review: null,
  attempts: [
    {
      analysisId: 'a1',
      capturedAtIso: '2026-08-30T10:00:00Z',
      sessionId: 's1',
    },
  ],
};

function planItem(overrides: Partial<TrainingPlanItem> = {}): TrainingPlanItem {
  return {
    id: 'item-1',
    position: 1,
    kind: 'warmup',
    drill: {
      slug: 'shadow-swings',
      title: 'Shadow swings',
      description: 'Swing without a ball.',
      coachName: 'Coach Kim',
      equipment: [],
      saved: false,
    },
    cueText: 'Finish high',
    targetSets: 3,
    targetRepetitionsPerSet: 10,
    targetDurationSeconds: null,
    restSeconds: 30,
    completion: null,
    ...overrides,
  };
}

const plan: TrainingPlan = {
  id: 'plan-1',
  status: 'active',
  algorithmVersion: 'v1',
  sourceShotId: 'a1',
  shotType: 'forehand_drive',
  priorityCheckpoint: 'contact_point',
  priorityDirection: 'late',
  baselineScore: 7.4,
  baselineCheckpointScore: 6,
  reassessmentShotId: null,
  scoreDelta: null,
  createdAt: '2026-08-29T10:00:00.000Z',
  completedAt: null,
  items: [
    planItem(),
    planItem({
      id: 'item-2',
      position: 2,
      kind: 'targeted',
      drill: {
        slug: 'wall-drive',
        title: 'Wall drive',
        description: 'Drive against a wall.',
        coachName: 'Coach Kim',
        equipment: [],
        saved: true,
      },
    }),
  ],
};

function detailFixture(slug: string): DrillDetail {
  return {
    id: `detail-${slug}`,
    slug,
    title: slug,
    description: 'detail',
    coachName: 'Coach Kim',
    equipment: [],
    difficultyMin: null,
    difficultyMax: null,
    saved: false,
    mappings: [],
    instructionalMedia:
      slug === 'shadow-swings'
        ? [
            {
              kind: 'embed',
              id: 'media-embed',
              provider: 'youtube',
              videoId: 'abc123',
              embedUrl: 'https://www.youtube.com/embed/abc123',
              sourceUrl: 'https://www.youtube.com/watch?v=abc123',
              creatorName: 'Coach Kim',
              licenseName: 'CC BY 4.0',
              licenseUrl: null,
              attribution: 'Coach Kim · CC BY 4.0',
            },
          ]
        : slug === 'wall-drive'
          ? [
              {
                kind: 'hosted',
                id: 'media-hosted',
                playbackUrl: 'https://cdn.example.test/wall-drive.mp4',
                expiresAt: '2999-01-01T00:00:00.000Z',
                sourceUrl: 'https://cdn.example.test/wall-drive',
                creatorName: 'Coach Kim',
                licenseName: 'Licensed',
                licenseUrl: null,
                attribution: 'Coach Kim · Licensed',
              },
            ]
          : [],
  };
}

const session = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'user-1',
  provider: 'apple',
};

// ─── Harness ────────────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

const api: jest.Mocked<TrainingApi> = {
  listSavedDrills: jest.fn(),
  getDrill: jest.fn(),
  saveDrill: jest.fn(),
  unsaveDrill: jest.fn(),
  getCurrentPlan: jest.fn(),
  createPlan: jest.fn(),
  completeDrill: jest.fn(),
  reassessPlan: jest.fn(),
};

let canOpenSpy: jest.SpyInstance;
let openUrlSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

/** A promise whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(turns = 6) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderDetails(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultDetailsScreen />);
  });
  await flush();
  return renderer;
}

async function unmount(renderer: Renderer) {
  await act(async () => {
    renderer.unmount();
  });
  mockUnmounted = true;
}

function pressables(renderer: Renderer) {
  return renderer.root.findAll(node => {
    if (typeof node.type === 'string') return false;
    const type = node.type as { displayName?: string; name?: string };
    return (
      (type.displayName ?? type.name) === 'Pressable' &&
      typeof node.props.onPress === 'function'
    );
  });
}

function control(renderer: Renderer, label: string) {
  const matches = pressables(renderer).filter(
    node => node.props.accessibilityLabel === label,
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function dialog(renderer: Renderer) {
  return renderer.root.findByType(BrandDialog);
}

const WATCH = 'Watch reviewed instruction for Shadow swings';
const WATCH_URL = 'https://www.youtube.com/watch?v=abc123';

beforeEach(() => {
  jest.useFakeTimers();
  mockJournal.length = 0;
  mockUnmounted = false;
  mockRoute.params = { analysisId: 'a1' };
  mockLoadEvidence.mockReset();
  mockLoadEvidence.mockResolvedValue(evidence);
  mockHasShotSyncReceipt.mockReset();
  mockHasShotSyncReceipt.mockResolvedValue(true);
  mockGetShotOutboxStatus.mockReset();
  mockGetShotOutboxStatus.mockResolvedValue({
    state: 'queued',
    attempts: 0,
    lastError: null,
  });
  mockListRealAnalysisFacts.mockReset();
  mockListRealAnalysisFacts.mockResolvedValue([]);
  mockListCatalogDrills.mockReset();
  mockListCatalogDrills.mockResolvedValue([]);
  mockGetApiSession.mockReset();
  mockGetApiSession.mockReturnValue(session);

  for (const fn of Object.values(api)) fn.mockReset();
  api.listSavedDrills.mockResolvedValue([]);
  api.getDrill.mockImplementation(async slug => detailFixture(slug));
  api.saveDrill.mockResolvedValue(undefined);
  api.unsaveDrill.mockResolvedValue(undefined);
  api.getCurrentPlan.mockResolvedValue(plan);
  configureTrainingStore(api);

  canOpenSpy = jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
  openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  canOpenSpy.mockRestore();
  openUrlSpy.mockRestore();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  jest.useRealTimers();
});

function reactWarnings(): string[] {
  return [...errorSpy.mock.calls, ...warnSpy.mock.calls]
    .map(call => call.map(String).join(' '))
    .filter(line =>
      /unmounted|memory leak|not wrapped in act|Can't perform/i.test(line),
    );
}

// ─── Baseline: the harness sees the mounted path ────────────────────────────

describe('ATTACK S7 — baseline (mounted)', () => {
  it('openURL rejecting while MOUNTED journals setDialog and shows the dialog', async () => {
    openUrlSpy.mockRejectedValue(new Error('no handler'));
    const renderer = await renderDetails();
    await act(async () => {
      control(renderer, WATCH).props.onPress();
    });
    await flush();
    expect(canOpenSpy).toHaveBeenCalledWith(WATCH_URL);
    expect(openUrlSpy).toHaveBeenCalledWith(WATCH_URL);
    expect(dialog(renderer).props.title).toBe('Video unavailable');
    const entries = mockJournal.filter(entry =>
      isVideoUnavailable(entry.value),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.afterUnmount).toBe(false);
    await unmount(renderer);
  });
});

// ─── Scenario 7: settle after unmount ───────────────────────────────────────

describe('ATTACK S7 — canOpenURL true, openURL rejects AFTER unmount', () => {
  it('OBSERVED: setDialog IS invoked on the unmounted TrainingPlanSection (no mounted guard); React 19 makes it a silent no-op', async () => {
    const open = deferred<void>();
    openUrlSpy.mockReturnValue(open.promise);
    const renderer = await renderDetails();
    await act(async () => {
      control(renderer, WATCH).props.onPress();
    });
    await flush();
    expect(openUrlSpy).toHaveBeenCalledWith(WATCH_URL);
    expect(mockJournal.some(entry => isVideoUnavailable(entry.value))).toBe(
      false,
    );

    await unmount(renderer);
    open.reject(new Error('no handler — after unmount'));
    await flush();

    const late = mockJournal.filter(entry => isVideoUnavailable(entry.value));
    // The catch path runs and calls the unmounted component's setter.
    expect(late).toHaveLength(1);
    expect(late[0]!.afterUnmount).toBe(true);
    // No React warning is emitted (React 18+ removed the unmounted-setState
    // warning), no throw, no unhandled rejection surfaced to the test.
    expect(reactWarnings()).toEqual([]);
  });

  it.failing('CONTRACT: no setDialog on the unmounted component', async () => {
    const open = deferred<void>();
    openUrlSpy.mockReturnValue(open.promise);
    const renderer = await renderDetails();
    await act(async () => {
      control(renderer, WATCH).props.onPress();
    });
    await flush();
    await unmount(renderer);
    open.reject(new Error('no handler — after unmount'));
    await flush();
    expect(
      mockJournal.filter(
        entry => entry.afterUnmount && isVideoUnavailable(entry.value),
      ),
    ).toHaveLength(0);
  });

  it('canOpenURL resolving FALSE after unmount takes the same catch path → same late setDialog', async () => {
    const can = deferred<boolean>();
    canOpenSpy.mockReturnValue(can.promise);
    const renderer = await renderDetails();
    await act(async () => {
      control(renderer, WATCH).props.onPress();
    });
    await flush();
    expect(openUrlSpy).not.toHaveBeenCalled();
    await unmount(renderer);
    can.resolve(false);
    await flush();
    expect(openUrlSpy).not.toHaveBeenCalled();
    const late = mockJournal.filter(
      entry => entry.afterUnmount && isVideoUnavailable(entry.value),
    );
    expect(late).toHaveLength(1);
    expect(reactWarnings()).toEqual([]);
  });

  it('canOpenURL resolving TRUE after unmount still calls openURL (the tap intent is honoured, nothing rendered)', async () => {
    const can = deferred<boolean>();
    canOpenSpy.mockReturnValue(can.promise);
    const renderer = await renderDetails();
    await act(async () => {
      control(renderer, WATCH).props.onPress();
    });
    await flush();
    await unmount(renderer);
    can.resolve(true);
    await flush();
    expect(openUrlSpy).toHaveBeenCalledWith(WATCH_URL);
    expect(
      mockJournal.filter(entry => isVideoUnavailable(entry.value)),
    ).toHaveLength(0);
    expect(reactWarnings()).toEqual([]);
  });

  it('a hanging openURL that never settles leaves nothing behind: no dialog, no warning, no journal entry', async () => {
    openUrlSpy.mockReturnValue(new Promise(() => {}));
    const renderer = await renderDetails();
    await act(async () => {
      control(renderer, WATCH).props.onPress();
    });
    await flush();
    await unmount(renderer);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await flush();
    expect(
      mockJournal.filter(entry => isVideoUnavailable(entry.value)),
    ).toHaveLength(0);
    expect(reactWarnings()).toEqual([]);
  });
});

// ─── Extras: rapid repeats, interleavings, corrupt media ────────────────────

describe('ATTACK S7 extras — Watch button under abuse', () => {
  it('10 rapid taps while openURL hangs: openURL is called 10× (no debounce) and exactly one dialog appears when ALL reject', async () => {
    const opens: ReturnType<typeof deferred<void>>[] = [];
    openUrlSpy.mockImplementation(() => {
      const d = deferred<void>();
      opens.push(d);
      return d.promise;
    });
    const renderer = await renderDetails();
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        control(renderer, WATCH).props.onPress();
      });
    }
    await flush();
    expect(openUrlSpy).toHaveBeenCalledTimes(10);
    for (const d of opens) d.reject(new Error('reject all'));
    await flush();
    // Ten setDialog calls with identical payloads collapse to one visible
    // dialog; dismissing it once clears the screen.
    expect(
      mockJournal.filter(entry => isVideoUnavailable(entry.value)),
    ).toHaveLength(10);
    expect(renderer.root.findAllByType(BrandDialog)).toHaveLength(1);
    expect(dialog(renderer).props.visible).toBe(true);
    await act(async () => {
      dialog(renderer).props.onDismiss();
    });
    await flush();
    expect(dialog(renderer).props.visible).toBe(false);
    await unmount(renderer);
  });

  it('interleaving: a late rejection from tap #1 re-raises the dialog AFTER the user dismissed the one from tap #2', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    openUrlSpy
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const renderer = await renderDetails();
    await act(async () => {
      control(renderer, WATCH).props.onPress();
    });
    await act(async () => {
      control(renderer, WATCH).props.onPress();
    });
    await flush();
    second.reject(new Error('second fails first'));
    await flush();
    expect(dialog(renderer).props.visible).toBe(true);
    await act(async () => {
      dialog(renderer).props.onDismiss();
    });
    await flush();
    expect(dialog(renderer).props.visible).toBe(false);
    first.reject(new Error('first fails late'));
    await flush();
    // Documented behaviour: the stale failure re-opens the dialog.
    expect(dialog(renderer).props.visible).toBe(true);
    expect(dialog(renderer).props.title).toBe('Video unavailable');
    await unmount(renderer);
  });

  it('canOpenURL THROWING synchronously-in-promise (rejects) is caught → dialog, openURL never called', async () => {
    canOpenSpy.mockRejectedValue(new Error('permission denied'));
    const renderer = await renderDetails();
    await act(async () => {
      control(renderer, WATCH).props.onPress();
    });
    await flush();
    expect(openUrlSpy).not.toHaveBeenCalled();
    expect(dialog(renderer).props.title).toBe('Video unavailable');
    expect(dialog(renderer).props.detail).not.toMatch(/Android|Google Play/i);
    await unmount(renderer);
  });

  it('a unicode / javascript: / data: sourceUrl is passed to Linking verbatim (no scheme allow-list in openMedia)', async () => {
    const hostile = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://例え.テスト/動画?v=ｘ',
      'file:///etc/passwd',
      '',
    ];
    for (const sourceUrl of hostile) {
      api.getDrill.mockImplementation(async slug => {
        const detail = detailFixture(slug);
        if (slug === 'shadow-swings') {
          detail.instructionalMedia = [
            {
              kind: 'embed',
              id: 'media-embed',
              provider: 'youtube',
              videoId: 'abc123',
              embedUrl: 'https://www.youtube.com/embed/abc123',
              sourceUrl,
              creatorName: 'Coach Kim',
              licenseName: 'CC BY 4.0',
              licenseUrl: null,
              attribution: 'Coach Kim · CC BY 4.0',
            },
          ];
        }
        return detail;
      });
      useTrainingStore.setState({ drillDetails: {} });
      configureTrainingStore(api);
      canOpenSpy.mockClear();
      openUrlSpy.mockClear();
      const renderer = await renderDetails();
      await act(async () => {
        control(renderer, WATCH).props.onPress();
      });
      await flush();
      expect(canOpenSpy).toHaveBeenCalledTimes(1);
      const [asked] = canOpenSpy.mock.calls[0] as [string];
      // Whatever mediaUrl() derives is what Linking is asked about; record it.
      expect(typeof asked).toBe('string');
      expect(openUrlSpy).toHaveBeenCalledWith(asked);
      await unmount(renderer);
      mockUnmounted = false;
    }
  });
});
