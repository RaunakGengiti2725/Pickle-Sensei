/**
 * Adversarial pass 3 — Progress screen.
 *
 * Attacks the load pipeline of `ProgressScreen` with the REAL
 * `fetchCanonicalProgress` (only `globalThis.fetch` is stubbed), the real
 * practice-history / technique-dashboard math and a controllable focus
 * effect so blur/refocus/unmount can be interleaved with in-flight loads:
 *
 *   A1 canonical progress never resolves → 15 s timeout → canonical null,
 *      local content rendered;
 *   A2 a stored capture whose `clip.uri` differs from the row `uri` is
 *      excluded from practice volume and disclosed by the excluded note;
 *   A3 `listRealAnalysisFacts` resolves after blur / unmount → the stale
 *      result never reaches state (a fresh load wins, unmount is silent);
 *   A4 newest local read is `low_confidence` on a NEWER model while five
 *      scored older-model reads exist → BY STROKE degrades, KEY STATISTICS
 *      still count the scored reads.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../src/data/db', () => ({
  getDb: jest.fn(() => ({
    execute: jest.fn(async () => ({ rows: [] })),
    close() {},
  })),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

// Controllable focus effect: the test decides when the screen is focused
// (effect runs) and blurred (cleanup runs), independent of React commits.
type FocusCallback = () => void | (() => void);
const focusControl: {
  callback: FocusCallback | null;
  cleanup: (() => void) | null;
  auto: boolean;
} = { callback: null, cleanup: null, auto: true };

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: (callback: FocusCallback) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => {
      focusControl.callback = callback;
      if (!focusControl.auto) return undefined;
      const cleanup = callback();
      focusControl.cleanup = typeof cleanup === 'function' ? cleanup : null;
      return () => {
        focusControl.cleanup?.();
        focusControl.cleanup = null;
      };
    }, [callback]);
  },
}));

const mockListRealAnalysisFacts = jest.fn<Promise<unknown[]>, unknown[]>();
const mockListCaptureHistory = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('../src/data/repository', () => ({
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
  listCaptureHistory: (...args: unknown[]) => mockListCaptureHistory(...args),
}));

const mockGetApiSession = jest.fn<unknown, []>(() => null);
jest.mock('../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

jest.mock('../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../src/progress/playerRank')
  >('../src/progress/playerRank');
  return { ...actual, fetchPlayerRank: jest.fn(async () => null) };
});

const mockAppState = { profile: null as { skillLevel?: string } | null };
jest.mock('../src/state/appStore', () => ({
  useAppStore: (selector: (s: typeof mockAppState) => unknown) =>
    selector(mockAppState),
}));

const mockConsistencyState = {
  snapshot: null as unknown,
  refresh: jest.fn(async () => {}),
};
jest.mock('../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (s: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));

jest.mock('../src/progress/rankCelebration', () => {
  const state = { maybeCelebrate: jest.fn(async () => {}) };
  return {
    useRankCelebrationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { ProgressScreen } from '../src/screens/ProgressScreen';
import {
  fetchCanonicalProgress,
  PROGRESS_REQUEST_TIMEOUT_MS,
  ProgressApiError,
  type ProgressFetch,
} from '../src/progress/api';
import type { ApiSession } from '../src/account/apiSession';
import type { RealAnalysisFact } from '../src/data/repository';
import type { CaptureEvidenceV1 } from '../src/camera/capture';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'attack-token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
};

function daysAgoIso(days: number, hoursBack = 0): string {
  return new Date(
    Date.now() - days * DAY_MS - hoursBack * HOUR_MS,
  ).toISOString();
}

let sequence = 0;

function fact(overrides: Partial<RealAnalysisFact>): RealAnalysisFact {
  sequence += 1;
  return {
    id: `fact-${sequence}`,
    shotType: 'dink',
    capturedAt: daysAgoIso(2),
    overallScore: 7,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'model-2',
    shotConfigVersion: 'config-1',
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
    ...overrides,
  };
}

/** Repository-shaped automatic capture; `clipUri` lets the attack detach
 * the clip from the row it claims to describe. */
function capture(id: string, capturedAtIso: string, clipUri?: string) {
  const evidence: CaptureEvidenceV1 = {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    poseFrameCount: 4,
    poseMissingFrameCount: 1,
    analysisInputFrameCount: 5,
    trackedDurationMs: 300,
    meanCanonicalJointVisibility: 0.8,
    meanJointCoverage: 0.75,
    minimumJointCoverage: 0.6,
    fullBodyVisibleFrameCount: 2,
    jointMotion: [
      {
        joint: 'right_wrist',
        sampleCount: 2,
        meanNormalizedPerSecond: 0.8,
        peakNormalizedPerSecond: 1.2,
      },
    ],
  };
  const uri = `file:///captures/${id}.mov`;
  return {
    id,
    shotType: 'unrecognized',
    declaredStroke: null,
    uri,
    capturedAtIso,
    durationMs: 3_000,
    fps: 60,
    width: 1_080,
    height: 1_920,
    evidenceStatus: 'valid',
    status: 'analyzed',
    clip: {
      uri: clipUri ?? uri,
      capturedAtIso,
      durationMs: 3_000,
      fps: 60,
      width: 1_080,
      height: 1_920,
      captureMode: 'automatic_pose_trigger',
      recognition: {
        status: 'unknown',
        reason: 'validated_classifier_unavailable',
      },
      trigger: {
        startMs: 1_000,
        endMs: 1_800,
        peakMotionMs: 1_500,
        confidence: 0.82,
        source: 'temporal_pose_motion',
        modelVersion: 'temporal-stroke-heuristic-2',
      },
      captureEvidence: evidence,
      ballSpeed: {
        status: 'unavailable',
        reason: 'calibrated_ball_tracker_unavailable',
      },
      preRollMs: 1_000,
      postRollMs: 1_200,
    },
  };
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return out.join(' ');
}

async function renderScreen(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ProgressScreen />);
  });
  return renderer;
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

function findByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
  return node ?? null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fetch that never produces a response but honors the abort signal the
 * way the platform fetch does (rejects with an AbortError). */
function hangingFetch(record: { aborted: boolean; calls: number }) {
  const fetchFn: ProgressFetch = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      record.calls += 1;
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener('abort', () => {
        record.aborted = true;
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  return fetchFn;
}

const originalFetch = globalThis.fetch;

describe('attack pass 3 — ProgressScreen load pipeline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    focusControl.callback = null;
    focusControl.cleanup = null;
    focusControl.auto = true;
    mockNavigate.mockClear();
    mockListRealAnalysisFacts.mockReset();
    mockListCaptureHistory.mockReset();
    mockListCaptureHistory.mockResolvedValue([]);
    mockGetApiSession.mockReset();
    mockGetApiSession.mockReturnValue(null);
    mockAppState.profile = null;
    mockConsistencyState.snapshot = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  describe('A1 — canonical progress never resolves', () => {
    it('fetchCanonicalProgress aborts at exactly 15 s with a ProgressApiError', async () => {
      const record = { aborted: false, calls: 0 };
      const pending = fetchCanonicalProgress(session, hangingFetch(record));
      let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
      void pending.then(
        () => (settled = 'resolved'),
        () => (settled = 'rejected'),
      );

      // One millisecond short of the deadline: still hanging, not aborted.
      await act(async () => {
        jest.advanceTimersByTime(PROGRESS_REQUEST_TIMEOUT_MS - 1);
      });
      expect(record.aborted).toBe(false);
      expect(settled).toBe('pending');

      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(record.aborted).toBe(true);
      await expect(pending).rejects.toBeInstanceOf(ProgressApiError);
      await expect(pending).rejects.toThrow(
        'Account progress is temporarily unavailable.',
      );
      expect(record.calls).toBe(1);
    });

    it('screen: 15 s of silence → canonical null, local content rendered', async () => {
      const record = { aborted: false, calls: 0 };
      globalThis.fetch = hangingFetch(record) as typeof fetch;
      mockGetApiSession.mockReturnValue(session);
      mockListRealAnalysisFacts.mockResolvedValue([
        fact({
          shotType: 'serve',
          overallScore: 6.4,
          capturedAt: daysAgoIso(1),
        }),
        fact({
          shotType: 'serve',
          overallScore: 7.1,
          capturedAt: daysAgoIso(0, 2),
        }),
      ]);
      mockListCaptureHistory.mockResolvedValue([capture('a', daysAgoIso(1))]);

      const renderer = await renderScreen();
      // Local data resolved long ago; the screen is still gated on the hung
      // network call.
      expect(renderedText(renderer)).toContain('Loading measured progress…');
      expect(record.calls).toBe(1);

      await act(async () => {
        jest.advanceTimersByTime(PROGRESS_REQUEST_TIMEOUT_MS - 1);
      });
      expect(renderedText(renderer)).toContain('Loading measured progress…');
      expect(record.aborted).toBe(false);

      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      await act(async () => {});
      expect(record.aborted).toBe(true);
      const text = renderedText(renderer);
      expect(text).not.toContain('Loading measured progress…');
      expect(text).not.toContain('Progress couldn’t load');
      // Local facts are on screen (technique tab default) — synced series
      // sections are absent because canonical resolved to null.
      expect(text).toContain('KEY STATISTICS');
      expect(
        findByTestId(renderer, 'technique-stat-reps')!.props.accessibilityLabel,
      ).toBe('SCORED REPS: 2');
      expect(text).not.toContain('OBSERVED SCORE SIGNALS');
      expect(text).toContain('scored reads');
      expect(text).not.toContain('daily averages');

      await pressByLabel(renderer, 'practice progress');
      expect(
        findByTestId(renderer, 'practice-stat-captures')!.props
          .accessibilityLabel,
      ).toBe('CAPTURES: 1');
      act(() => renderer.unmount());
    });

    it('screen: re-focus after a timed-out load issues a fresh request', async () => {
      const record = { aborted: false, calls: 0 };
      globalThis.fetch = hangingFetch(record) as typeof fetch;
      mockGetApiSession.mockReturnValue(session);
      mockListRealAnalysisFacts.mockResolvedValue([]);
      focusControl.auto = false;

      const renderer = await renderScreen();
      await act(async () => {
        focusControl.cleanup = focusControl.callback!() as () => void;
      });
      await act(async () => {
        jest.advanceTimersByTime(PROGRESS_REQUEST_TIMEOUT_MS);
      });
      await act(async () => {});
      expect(record.calls).toBe(1);
      expect(renderedText(renderer)).toContain('KEY STATISTICS');

      // Blur → refocus: the screen must retry rather than pin the null.
      await act(async () => {
        focusControl.cleanup?.();
        focusControl.cleanup = focusControl.callback!() as () => void;
      });
      expect(record.calls).toBe(2);
      act(() => renderer.unmount());
    });
  });

  describe('A2 — clip.uri detached from the capture row', () => {
    it('is excluded from practice volume and disclosed by the excluded note', async () => {
      mockListRealAnalysisFacts.mockResolvedValue([]);
      mockListCaptureHistory.mockResolvedValue([
        capture('good', daysAgoIso(1)),
        capture('swapped', daysAgoIso(1), 'file:///captures/someone-else.mov'),
        // Same bytes, different string: strict equality must still reject
        // a URI that differs only by Unicode normalization form.
        capture(
          'nfd',
          daysAgoIso(2),
          'file:///captures/nfd.mov'.normalize('NFD') + '\u0301',
        ),
      ]);
      const renderer = await renderScreen();
      await pressByLabel(renderer, 'practice progress');
      const text = renderedText(renderer);

      expect(
        findByTestId(renderer, 'practice-stat-captures')!.props
          .accessibilityLabel,
      ).toBe('CAPTURES: 1');
      expect(
        findByTestId(renderer, 'practice-stat-active-days')!.props
          .accessibilityLabel,
      ).toBe('ACTIVE DAYS: 1');
      // Pose-tracked seconds come only from the one verified capture.
      expect(
        findByTestId(renderer, 'practice-stat-pose-tracked')!.props
          .accessibilityLabel,
      ).toBe('POSE TRACKED: 0.3s');
      const note = findByTestId(renderer, 'practice-excluded-note');
      expect(note).not.toBeNull();
      expect(text).toContain(
        '2 saved clips without measured pose evidence are not counted.',
      );
      act(() => renderer.unmount());
    });

    it('a lone detached capture yields the empty chart, not a phantom capture', async () => {
      mockListRealAnalysisFacts.mockResolvedValue([]);
      mockListCaptureHistory.mockResolvedValue([
        capture('only', daysAgoIso(0, 1), 'file:///captures/other.mov'),
      ]);
      const renderer = await renderScreen();
      await pressByLabel(renderer, 'practice progress');
      const text = renderedText(renderer);
      expect(text).toContain('This chart is waiting on you.');
      expect(
        findByTestId(renderer, 'practice-stat-captures')!.props
          .accessibilityLabel,
      ).toBe('CAPTURES: 0');
      expect(text).toContain(
        '1 saved clip without measured pose evidence is not counted.',
      );
      act(() => renderer.unmount());
    });
  });

  describe('A3 — repository resolves after the focus effect was cancelled', () => {
    it('blur → refocus: a stale first load never overwrites the fresh one', async () => {
      focusControl.auto = false;
      const first = deferred<unknown[]>();
      const second = deferred<unknown[]>();
      mockListRealAnalysisFacts
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);

      const renderer = await renderScreen();
      await act(async () => {
        focusControl.cleanup = focusControl.callback!() as () => void;
      });
      expect(renderedText(renderer)).toContain('Loading measured progress…');

      // Blur while load #1 is in flight, then refocus → load #2.
      await act(async () => {
        focusControl.cleanup?.();
        focusControl.cleanup = focusControl.callback!() as () => void;
      });
      expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(2);

      // Load #2 lands first with ONE scored read.
      await act(async () => {
        second.resolve([fact({ shotType: 'dink', overallScore: 5.5 })]);
      });
      expect(renderedText(renderer)).not.toContain(
        'Loading measured progress…',
      );
      expect(
        findByTestId(renderer, 'technique-stat-reps')!.props.accessibilityLabel,
      ).toBe('SCORED REPS: 1');

      // Load #1 (cancelled) lands late with FIVE reads: must be ignored.
      await act(async () => {
        first.resolve([
          fact({ shotType: 'serve', overallScore: 9.1 }),
          fact({ shotType: 'serve', overallScore: 9.2 }),
          fact({ shotType: 'serve', overallScore: 9.3 }),
          fact({ shotType: 'serve', overallScore: 9.4 }),
          fact({ shotType: 'serve', overallScore: 9.5 }),
        ]);
      });
      await act(async () => {});
      expect(
        findByTestId(renderer, 'technique-stat-reps')!.props.accessibilityLabel,
      ).toBe('SCORED REPS: 1');
      expect(renderedText(renderer)).not.toContain('9.5');
      act(() => renderer.unmount());
    });

    it('blur → refocus: a stale REJECTION never surfaces the error state', async () => {
      focusControl.auto = false;
      const first = deferred<unknown[]>();
      mockListRealAnalysisFacts
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce([fact({ overallScore: 6 })]);

      const renderer = await renderScreen();
      await act(async () => {
        focusControl.cleanup = focusControl.callback!() as () => void;
      });
      await act(async () => {
        focusControl.cleanup?.();
        focusControl.cleanup = focusControl.callback!() as () => void;
      });
      await act(async () => {});
      expect(renderedText(renderer)).toContain('KEY STATISTICS');

      await act(async () => {
        first.reject(new Error('sqlite closed under us'));
      });
      await act(async () => {});
      expect(renderedText(renderer)).toContain('KEY STATISTICS');
      expect(renderedText(renderer)).not.toContain('Progress couldn’t load');
      act(() => renderer.unmount());
    });

    it('unmount mid-load: the late resolution is silent (no React warning)', async () => {
      const first = deferred<unknown[]>();
      mockListRealAnalysisFacts.mockReturnValueOnce(first.promise);
      const errorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const renderer = await renderScreen();
        expect(renderedText(renderer)).toContain('Loading measured progress…');
        act(() => renderer.unmount());
        await act(async () => {
          first.resolve([fact({ overallScore: 8 })]);
        });
        await act(async () => {});
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(renderer.toJSON()).toBeNull();
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe('A4 — newest read abstained on a newer model', () => {
    function m3AbstainedOverFiveM2Scored() {
      // Repository order: newest first (matches listRealAnalysisFacts).
      return [
        fact({
          shotType: 'dink',
          resultKind: 'low_confidence',
          overallScore: null,
          confidence: 0.2,
          scoringModelVersion: 'model-3',
          capturedAt: daysAgoIso(0, 1),
        }),
        fact({
          shotType: 'dink',
          overallScore: 6.1,
          capturedAt: daysAgoIso(1),
        }),
        fact({
          shotType: 'dink',
          overallScore: 6.4,
          capturedAt: daysAgoIso(2),
        }),
        fact({
          shotType: 'dink',
          overallScore: 6.8,
          capturedAt: daysAgoIso(3),
        }),
        fact({
          shotType: 'dink',
          overallScore: 7.2,
          capturedAt: daysAgoIso(4),
        }),
        fact({
          shotType: 'dink',
          overallScore: 7.5,
          capturedAt: daysAgoIso(5),
        }),
      ];
    }

    it('BY STROKE shows the Need 2 placeholder; KEY STATISTICS keep the five scored reads', async () => {
      mockListRealAnalysisFacts.mockResolvedValue(
        m3AbstainedOverFiveM2Scored(),
      );
      const renderer = await renderScreen();
      await pressByLabel(renderer, 'technique progress');
      const text = renderedText(renderer);

      // Key statistics: comparability is decided among SCORED reads only,
      // so the abstention on model-3 must not erase the five model-2 reads.
      expect(
        findByTestId(renderer, 'technique-stat-reps')!.props.accessibilityLabel,
      ).toBe('SCORED REPS: 5');
      expect(
        findByTestId(renderer, 'technique-stat-days')!.props.accessibilityLabel,
      ).toBe('SCORED DAYS: 5');
      expect(
        findByTestId(renderer, 'technique-stat-best')!.props.accessibilityLabel,
      ).toBe('BEST SCORE: 7.5');

      // BY STROKE: the dink card exists and cannot state a spread.
      expect(text).toContain('BY STROKE');
      expect(text).toContain('Need 2');
      expect(text).not.toContain('Comparable trends start after scoring');
      act(() => renderer.unmount());
    });

    it('BY STROKE card never renders an invented score for the abstained stroke', async () => {
      mockListRealAnalysisFacts.mockResolvedValue(
        m3AbstainedOverFiveM2Scored(),
      );
      const renderer = await renderScreen();
      await pressByLabel(renderer, 'technique progress');
      const text = renderedText(renderer);

      // Whatever the card decides to show, it must not fabricate a number
      // for a read that abstained, and must not present the model-2 series
      // as if it were the model-3 stroke's current score.
      const cardText = text.slice(text.indexOf('BY STROKE'));
      expect(cardText).toContain('dink');
      expect(cardText).not.toMatch(/SERIES/);
      // The card discloses how many reads back it: five older-model reads
      // are NOT comparable to the model-3 newest → 0 scored reads.
      expect(cardText).toMatch(/0\s+accepted reps ·\s+0\s+scored reads/);
      act(() => renderer.unmount());
    });
  });
});
