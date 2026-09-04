/**
 * STRUCTURAL AUDIT #1 (mobile-results-review) — contract probes for the
 * TRY AGAIN handoff, the App Store review prompt queue, and the coaching
 * copy / form-review model invariants the architecture map listed as
 * weak or untested.
 *
 *  1. tryAgainHandoff: wall clock moving BACKWARDS after arming (device
 *     clock change) must not expire the handoff; TTL is measured from the
 *     LAST arm; peek never consumes; expiry telemetry fires exactly once.
 *  2. appStoreReview: concurrent reportScoredAnalysisForReview calls are
 *     serialized (state counters never lose an increment); a
 *     markStoreReviewCompleted racing a report ends the asks durably; the
 *     write-review deep link is the App Store's documented form with the
 *     configured Apple ID.
 *  3. coachingCue: every (checkpoint × direction × shot type) cue is
 *     non-empty, trimmed, ≤120 chars (the stop card reserves three body
 *     lines), and free of store-policy vocabulary.
 *  4. buildFormReviewScript: for producer-contract phases (phaseSegmenter
 *     clamps representativeMs into [startMs, endMs]) every stop.atMs lies
 *     inside its span and inside the pose-only measured extent, so the JS
 *     clock can always reach it; an out-of-span representative (contract
 *     violation) is passed through unclamped and never throws.
 */

import { NativeModules } from 'react-native';
import {
  CHECKPOINTS,
  FAULT_DIRECTIONS,
  SHOT_TYPES,
  type CheckpointKey,
  type CheckpointScore,
  type FaultDirection,
  type PhaseKey,
  type PhaseSpan,
  type ScoreBand,
  type ShotAnalysis,
} from '@pickle/shared-types';

const mockKvTable = new Map<string, string>();
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import {
  TRY_AGAIN_HANDOFF_TTL_MS,
  armTryAgain,
  clearTryAgainHandoff,
  consumeTryAgainHandoff,
  peekTryAgainHandoff,
  tryAgainFromResult,
} from '../../src/screens/tryAgainHandoff';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import {
  REVIEW_PROMPT_KV_KEY,
  markStoreReviewCompleted,
  parseReviewPromptState,
  rateAppFromSettings,
  reportScoredAnalysisForReview,
} from '../../src/review/appStoreReview';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import {
  buildFormReviewScript,
  coachingCue,
} from '../../src/review/formReviewModel';

// ─── 1. tryAgainHandoff ─────────────────────────────────────────────────────

function declaredHandoff() {
  return tryAgainFromResult(
    {
      strokeIntent: {
        declaredStroke: 'forehand_drive',
        predictedStroke: null,
        resolutionBasis: 'declared',
        resolvedProfileId: 'FOREHAND_DRIVE',
        resolvedProfileVersion: 'technique-profile-v1',
        disagreement: null,
      },
    },
    { shotType: 'forehand_drive', sessionId: 'set-1' },
  );
}

describe('tryAgainHandoff — clock and TTL edges', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
    stabilitySlo.reset();
    clearTryAgainHandoff();
  });
  afterEach(() => {
    jest.useRealTimers();
    clearTryAgainHandoff();
    stabilitySlo.reset();
  });

  it('survives the wall clock jumping BACKWARDS between arm and consume', () => {
    armTryAgain(declaredHandoff());
    jest.setSystemTime(Date.now() - 60 * 60 * 1000); // clock set back 1h
    expect(peekTryAgainHandoff()).not.toBeNull();
    const handoff = consumeTryAgainHandoff();
    expect(handoff).toMatchObject({ declaredStroke: 'forehand_drive' });
    expect(stabilitySlo.events()).toHaveLength(1);
    expect(stabilitySlo.events()[0]).toMatchObject({
      kind: 'try_again_rearmed',
    });
  });

  it('measures the TTL from the LAST arm, not the first', () => {
    armTryAgain(declaredHandoff());
    jest.setSystemTime(Date.now() + TRY_AGAIN_HANDOFF_TTL_MS - 1_000);
    armTryAgain(declaredHandoff());
    jest.setSystemTime(Date.now() + TRY_AGAIN_HANDOFF_TTL_MS - 1_000);
    expect(consumeTryAgainHandoff()).not.toBeNull();
  });

  it('peek never consumes and never records telemetry; expiry telemetry fires exactly once', () => {
    armTryAgain(declaredHandoff());
    peekTryAgainHandoff();
    peekTryAgainHandoff();
    expect(stabilitySlo.events()).toEqual([]);
    jest.setSystemTime(Date.now() + TRY_AGAIN_HANDOFF_TTL_MS + 1);
    expect(peekTryAgainHandoff()).toBeNull();
    expect(stabilitySlo.events()).toEqual([]);
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(stabilitySlo.events()).toHaveLength(1);
    expect(stabilitySlo.events()[0]).toMatchObject({
      kind: 'try_again_failed',
      reason: 'handoff_expired',
    });
  });

  it('consuming with nothing armed records nothing', () => {
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(stabilitySlo.events()).toEqual([]);
  });

  it('exactly at the TTL boundary the handoff is still live (> not >=)', () => {
    armTryAgain(declaredHandoff());
    jest.setSystemTime(Date.now() + TRY_AGAIN_HANDOFF_TTL_MS);
    expect(consumeTryAgainHandoff()).not.toBeNull();
  });
});

// ─── 2. appStoreReview ──────────────────────────────────────────────────────

const mockRequestReview = jest.fn(() => Promise.resolve(true));

function storedState() {
  return parseReviewPromptState(mockKvTable.get(REVIEW_PROMPT_KV_KEY) ?? null);
}

describe('appStoreReview — queue serialization and deep link', () => {
  beforeEach(() => {
    mockKvTable.clear();
    mockRequestReview.mockClear();
    mockRequestReview.mockResolvedValue(true);
    (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview = {
      requestReview: mockRequestReview,
    };
  });
  afterAll(() => {
    delete (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview;
  });

  it('five concurrent reports serialize: counters reach exactly 5, one ask each', async () => {
    await Promise.all(
      Array.from({ length: 5 }, () =>
        reportScoredAnalysisForReview({ delayMs: 0 }),
      ),
    );
    expect(storedState().scoredAnalyses).toBe(5);
    expect(storedState().promptedCount).toBe(5);
    expect(mockRequestReview).toHaveBeenCalledTimes(5);
  });

  it('a completion racing a report ends the asks: later reports never prompt', async () => {
    await Promise.all([
      reportScoredAnalysisForReview({ delayMs: 0 }),
      markStoreReviewCompleted(),
      reportScoredAnalysisForReview({ delayMs: 0 }),
    ]);
    expect(storedState().reviewedAtIso).not.toBeNull();
    // Only the report queued BEFORE completion may have asked.
    expect(mockRequestReview.mock.calls.length).toBeLessThanOrEqual(1);
    mockRequestReview.mockClear();
    await reportScoredAnalysisForReview({ delayMs: 0 });
    expect(mockRequestReview).not.toHaveBeenCalled();
    expect(storedState().promptedCount).toBeLessThanOrEqual(1);
  });

  it('a rejected native prompt does not poison the queue for the next report', async () => {
    mockRequestReview.mockRejectedValueOnce(new Error('StoreKit refused'));
    await reportScoredAnalysisForReview({ delayMs: 0 });
    await reportScoredAnalysisForReview({ delayMs: 0 });
    expect(storedState().promptedCount).toBe(2);
    expect(mockRequestReview).toHaveBeenCalledTimes(2);
  });

  it("the configured write-review deep link is Apple's documented form with the dossier Apple ID", async () => {
    const config = getRuntimePublicConfig();
    expect(config.appStoreId).toBe('6806918402');
    expect(config.appStoreWriteReviewUrl).toBe(
      'https://apps.apple.com/app/id6806918402?action=write-review',
    );
    const openUrl = jest.fn(async () => true);
    const outcome = await rateAppFromSettings({ openUrl });
    expect(outcome).toBe('store_page');
    expect(openUrl).toHaveBeenCalledWith(
      'https://apps.apple.com/app/id6806918402?action=write-review',
    );
    expect(storedState().reviewedAtIso).not.toBeNull();
  });
});

// ─── 3. coachingCue ─────────────────────────────────────────────────────────

describe('coachingCue — every cue is bounded, trimmed and policy-clean', () => {
  const FORBIDDEN = [
    /android/i,
    /google play/i,
    /guest mode/i,
    /live court/i,
    /\bdupr\b/i,
    /swingvision|pb vision|selkirk|joola/i,
    /\d+\s?%/,
    /\b(best|perfect|guarantee|guaranteed|pro-level|like a pro)\b/i,
    /\b(injur|pain|medical|doctor|therap)/i,
  ];

  it('holds for all checkpoint × direction × shot-type combinations', () => {
    const offenders: string[] = [];
    let longest = 0;
    for (const key of CHECKPOINTS) {
      for (const direction of FAULT_DIRECTIONS) {
        for (const shotType of SHOT_TYPES) {
          const cue = coachingCue(key, direction, shotType);
          longest = Math.max(longest, cue.length);
          const problems: string[] = [];
          if (cue.length === 0) problems.push('empty');
          if (cue !== cue.trim()) problems.push('untrimmed');
          if (cue.length > 120) problems.push(`len=${cue.length}`);
          for (const pattern of FORBIDDEN) {
            if (pattern.test(cue)) problems.push(`matches ${pattern}`);
          }
          if (problems.length > 0) {
            offenders.push(
              `${key}/${direction}/${shotType}: ${problems.join(', ')} — "${cue}"`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(longest).toBeLessThanOrEqual(120);
  });
});

// ─── 4. buildFormReviewScript — representativeMs outside its span ──────────

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
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
  };
}

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'analysis-1',
    sessionId: 'set-1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.1,
    analysisConfidence: 0.84,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
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
    ...overrides,
  };
}

/** Mirrors FormReviewPlayer.measuredExtentMs for a pose-only replay. */
function poseOnlyExtentMs(
  analysis: ShotAnalysis,
  stops: readonly { endMs: number }[],
): number {
  return (
    Math.max(
      analysis.timestamps.endMs,
      ...analysis.phases.map(p => p.endMs),
      ...stops.map(stop => stop.endMs),
    ) + 250
  );
}

describe('buildFormReviewScript — stop moments stay reachable', () => {
  it('producer-contract phases (representative inside its span, contact at the window edge) yield stops inside the pose-only extent', () => {
    // Contact phase ends exactly at timestamps.endMs and its representative
    // sits on that edge: the tightest in-contract case.
    const analysis = analysisFixture({
      timestamps: { startMs: 0, contactMs: 1100, endMs: 1100 },
      phases: [phase('ready', 0, 900), phase('contact', 1000, 1100, 1100)],
      checkpoints: [
        checkpoint('ready_position', 85, 'green', 'none'),
        checkpoint('contact_position', 48, 'red', 'late'),
      ],
    });
    const script = buildFormReviewScript(analysis, null);
    expect(script.stops.map(stop => stop.phase)).toEqual(['ready', 'contact']);
    const extentMs = poseOnlyExtentMs(analysis, script.stops);
    for (const stop of script.stops) {
      expect(stop.atMs).toBeGreaterThanOrEqual(stop.startMs);
      expect(stop.atMs).toBeLessThanOrEqual(stop.endMs);
      expect(stop.atMs).toBeLessThan(extentMs);
    }
  });

  it('a legacy row with no phases places the single stop at contactMs inside [startMs, endMs]', () => {
    const analysis = analysisFixture({
      timestamps: { startMs: 200, contactMs: 1500, endMs: 3000 },
      phases: [],
      checkpoints: [checkpoint('contact_position', 48, 'red', 'late')],
    });
    const script = buildFormReviewScript(analysis, null);
    expect(script.stops).toHaveLength(1);
    expect(script.stops[0]).toMatchObject({
      phase: 'contact',
      atMs: 1500,
      startMs: 200,
      endMs: 3000,
    });
  });

  it('an out-of-span representative (contract violation upstream) never throws; the model passes it through unclamped', () => {
    const analysis = analysisFixture({
      timestamps: { startMs: 0, contactMs: 1500, endMs: 1100 },
      phases: [phase('ready', 0, 900), phase('contact', 1000, 1100, 1500)],
      checkpoints: [
        checkpoint('ready_position', 85, 'green', 'none'),
        checkpoint('contact_position', 48, 'red', 'late'),
      ],
    });
    const script = buildFormReviewScript(analysis, null);
    const contact = script.stops.find(stop => stop.phase === 'contact');
    // Documented observation (INFERRED, not a finding): formReviewModel
    // relies on packages/vision-geometry/src/phaseSegmenter.ts clamping
    // representativeMs into the span; it does not re-clamp here, so such a
    // stop would sit past the pose-only extent (1350ms) and be unreachable
    // by the JS clock. Producer contract + swing-lab `contact_outside_event`
    // invariant make this input non-reachable from real analyses.
    expect(contact?.atMs).toBe(1500);
    expect(poseOnlyExtentMs(analysis, script.stops)).toBe(1350);
  });
});
