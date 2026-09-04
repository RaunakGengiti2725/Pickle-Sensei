/**
 * Execution audit harness (pass 2 of 3) for `mobile-live-court-voice`.
 *
 * Adversarial scenarios for the dormant Live Court voice layer: real-time
 * event ordering, dedupe across snapshots, interruptions (mute / dispose /
 * throwing or unavailable voice ports), analysis "permission denial"
 * (provider unavailable → every event pending), stale/late analyses after
 * end, and strict summary-record parsing. Every test here asserts a property
 * that HOLDS on 4d812e1a; deviations found by the audit live in
 * `liveCourtVoiceExecutionAudit.findings.test.ts` so they fail loudly.
 *
 * New file only — production code is unchanged.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type {
  CheckpointKey,
  FaultDirection,
  ShotTypeSlug,
} from '@pickle/shared-types';
import { ok } from '@pickle/shared-types';
import {
  DEFAULT_LIVE_CUE_RULES,
  INITIAL_LIVE_COACH_STATE,
  selectLiveCue,
  sessionEndLine,
  type LiveRepObservation,
} from '@pickle/audio-coach-core';
import { createFixtureVisionProviderSet } from '../../../../packages/vision-contracts/test/support/fixtureProvider';
import { LiveCourtEngine } from '../../src/flow/liveCourt';
import {
  LiveSessionCoach,
  getCompletedCoachRecap,
  type CoachVoicePort,
  type SpokenCue,
} from '../../src/flow/liveSessionCoach';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
} from '../../src/flow/liveSessionSummary';
import {
  DEV_REPLAY_RALLY,
  LiveSessionFlow,
  createPendingStubAnalysisProvider,
  type LiveSessionSnapshot,
  type SessionEventAnalysisProvider,
  type SessionEventView,
} from '../../src/flow/session';
import { sessionScoreProgression } from '../../src/flow/sessionProgress';

declare const process: { env: Record<string, string | undefined> };
process.env.PICKLE_ENV = 'development';

// ─── Builders (mirrors __tests__/liveSessionCoach.test.ts) ──────────────────

interface CheckpointSpec {
  key: CheckpointKey;
  score: number | null;
  direction: FaultDirection;
  severity: number;
  applicable?: boolean;
}

function scoredAnalysis(
  overallScore: number,
  checkpoints: CheckpointSpec[],
  shotType: ShotTypeSlug = 'forehand_drive',
): AnalysisRecord {
  return {
    strokeResolution: { kind: 'declared', shotType },
    result: {
      resultKind: 'scored',
      overallScore,
      checkpoints: checkpoints.map(spec => ({
        key: spec.key,
        score: spec.score,
        confidence: 0.9,
        band: 'yellow',
        direction: spec.direction,
        severity: spec.severity,
        applicable: spec.applicable ?? true,
      })),
    },
  } as unknown as AnalysisRecord;
}

function lowConfidenceAnalysis(): AnalysisRecord {
  return {
    strokeResolution: { kind: 'unresolved' },
    result: {
      resultKind: 'low_confidence',
      overallScore: null,
      checkpoints: [],
    },
  } as unknown as AnalysisRecord;
}

function view(
  index: number,
  partial: Partial<SessionEventView> = {},
): SessionEventView {
  return {
    eventId: `E${index + 1}`,
    index,
    startMs: index * 1000,
    endMs: index * 1000 + 400,
    peakMs: index * 1000 + 200,
    durationMs: 400,
    peakSpeed: 2.5,
    paddleConfirmed: true,
    closeReason: 'settle',
    closedAtMs: index * 1000 + 600,
    state: 'pending',
    pendingReason: null,
    abstainReason: null,
    analysis: null,
    family: null,
    boundaryUncertain: false,
    retroSuppressed: false,
    ...partial,
  };
}

function scoredView(
  index: number,
  score: number,
  checkpoints: CheckpointSpec[],
) {
  return view(index, {
    state: 'ready',
    analysis: scoredAnalysis(score, checkpoints),
  });
}

function snap(
  events: SessionEventView[],
  overrides: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot {
  return {
    sessionId: 'audit-session',
    phase: 'running',
    source: 'live',
    startedAtIso: '2026-09-04T10:00:00.000Z',
    durationMs: events.length * 1000 + 600,
    strokeCount: events.length,
    events,
    distribution: [],
    qualityNotes: [],
    droppedLateSamples: 0,
    onUpdateFailures: 0,
    engineVersion: 'audit-engine-1',
    analysisProviderId: 'audit-provider',
    ...overrides,
  };
}

function makeVoice(available: () => boolean = () => true) {
  const spoken: Array<{ text: string; category: string | undefined }> = [];
  const stop = jest.fn();
  const voice: CoachVoicePort = {
    available,
    speak: (text, options) => {
      spoken.push({ text, category: options?.category });
    },
    stop,
  };
  return { voice, spoken, stop };
}

/** Lets LiveSessionFlow's clip-extraction → analyzeEvent promise chain
 * reach the provider (two awaits) without resolving any gated analysis. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

const kneeFault: CheckpointSpec = {
  key: 'athletic_base',
  score: 40,
  direction: 'low',
  severity: 0.5,
};
const clean: CheckpointSpec[] = [
  { key: 'contact_position', score: 88, direction: 'none', severity: 0.05 },
  { key: 'athletic_base', score: 90, direction: 'none', severity: 0.02 },
];

// ─── Dedupe & ordering ──────────────────────────────────────────────────────

describe('LiveSessionCoach dedupe under adversarial snapshot streams', () => {
  it('a duplicated eventId inside ONE snapshot is spoken once', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const e1 = scoredView(0, 6.2, [kneeFault]);
    coach.consumeSnapshot(snap([e1, { ...e1 }, { ...e1, index: 1 }]));
    expect(coach.recap().cues.filter(c => c.eventId === 'E1')).toHaveLength(1);
    expect(spoken).toHaveLength(1);
  });

  it('an event whose terminal state flips (ready → abstained) in a later snapshot is NOT re-spoken', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([scoredView(0, 6.2, [kneeFault])]));
    coach.consumeSnapshot(
      snap([view(0, { state: 'abstained', abstainReason: 'LATE_FLIP' })]),
    );
    const cues = coach.recap().cues.filter(c => c.eventId === 'E1');
    expect(cues).toHaveLength(1);
    expect(cues[0]!.category).toBe('CORRECTION');
  });

  it('1000 identical snapshots produce exactly one cue per terminal event', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const events = [
      scoredView(0, 6.2, [kneeFault]),
      view(1, { state: 'ready', analysis: lowConfidenceAnalysis() }),
      view(2, { state: 'abstained', abstainReason: 'POSE_TOO_SPARSE' }),
      view(3), // pending forever
    ];
    for (let i = 0; i < 1000; i += 1) coach.consumeSnapshot(snap(events));
    expect(spoken).toHaveLength(3);
    expect(coach.recap().cues.map(c => c.eventId)).toEqual(['E1', 'E2', 'E3']);
  });

  it('snapshots whose event array is reordered do not change which events speak', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const events = [
      scoredView(0, 6.2, [kneeFault]),
      scoredView(1, 7.1, clean),
      scoredView(2, 5.9, [kneeFault]),
    ];
    coach.consumeSnapshot(snap(events));
    coach.consumeSnapshot(snap([...events].reverse()));
    coach.consumeSnapshot(snap([events[1]!, events[2]!, events[0]!]));
    expect(coach.recap().cues.map(c => c.eventId)).toEqual(['E1', 'E2', 'E3']);
  });

  it('re-entrant consumeSnapshot from the onCue observer never duplicates a cue', () => {
    const { voice } = makeVoice();
    const events = [scoredView(0, 6.2, [kneeFault]), scoredView(1, 7.1, clean)];
    let depth = 0;
    const seen: SpokenCue[] = [];
    const coach = new LiveSessionCoach({
      voice,
      onCue: cue => {
        seen.push(cue);
        if (depth < 3) {
          depth += 1;
          coach.consumeSnapshot(snap(events));
          depth -= 1;
        }
      },
    });
    coach.consumeSnapshot(snap(events));
    const ids = seen.filter(c => c.eventId !== null).map(c => c.eventId);
    expect(ids.sort()).toEqual(['E1', 'E2']);
    expect(coach.recap().cues).toHaveLength(2);
  });
});

// ─── Interruptions ──────────────────────────────────────────────────────────

describe('LiveSessionCoach interruptions', () => {
  it('mute mid-session: in-flight utterance stopped once, later cues captioned with spoken=false, unmute resumes', () => {
    const { voice, spoken, stop } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([scoredView(0, 6.2, [kneeFault])]));
    coach.setMuted(true);
    coach.setMuted(true);
    expect(stop).toHaveBeenCalledTimes(2);
    coach.consumeSnapshot(
      snap([scoredView(0, 6.2, [kneeFault]), scoredView(1, 7.1, clean)]),
    );
    coach.setMuted(false);
    coach.consumeSnapshot(
      snap([
        scoredView(0, 6.2, [kneeFault]),
        scoredView(1, 7.1, clean),
        scoredView(2, 7.4, clean),
      ]),
    );
    const cues = coach.recap().cues;
    expect(cues.map(c => [c.eventId, c.spoken])).toEqual([
      ['E1', true],
      ['E2', false],
      ['E3', true],
    ]);
    expect(spoken).toHaveLength(2);
    expect(coach.recap().spokenCount).toBe(2);
  });

  it('voice availability flipping mid-session records the truth per cue', () => {
    let available = true;
    const { voice, spoken } = makeVoice(() => available);
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([scoredView(0, 6.2, [kneeFault])]));
    available = false;
    coach.consumeSnapshot(
      snap([scoredView(0, 6.2, [kneeFault]), scoredView(1, 7.1, clean)]),
    );
    expect(coach.voiceAvailable()).toBe(false);
    expect(coach.recap().cues.map(c => c.spoken)).toEqual([true, false]);
    expect(spoken).toHaveLength(1);
  });

  it('dispose() cuts the utterance, is idempotent, and silences everything after', () => {
    const { voice, spoken, stop } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([scoredView(0, 6.2, [kneeFault])]));
    coach.dispose();
    coach.dispose();
    expect(stop).toHaveBeenCalledTimes(2);
    coach.consumeSnapshot(
      snap([scoredView(0, 6.2, [kneeFault]), scoredView(1, 7.1, clean)]),
    );
    expect(spoken).toHaveLength(1);
    expect(coach.recap().cues).toHaveLength(1);
  });

  it('sessionEnded() is idempotent: one SESSION_END line, one registry write, late snapshots ignored', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const final = snap([scoredView(0, 6.2, [kneeFault])], {
      sessionId: 'idem-1',
      phase: 'ended',
    });
    coach.consumeSnapshot(final);
    const recapA = coach.sessionEnded(final);
    const recapB = coach.sessionEnded(final);
    coach.consumeSnapshot(
      snap([scoredView(0, 6.2, [kneeFault]), scoredView(1, 7.1, clean)], {
        sessionId: 'idem-1',
      }),
    );
    expect(recapA).toEqual(recapB);
    expect(spoken.filter(s => s.category === 'SESSION_END')).toHaveLength(1);
    expect(getCompletedCoachRecap('idem-1')?.cues.map(c => c.category)).toEqual(
      ['CORRECTION', 'SESSION_END'],
    );
  });

  it('a voice port whose speak() returns false is captioned, not spoken, and never re-attempted', () => {
    let calls = 0;
    const voice: CoachVoicePort = {
      available: () => true,
      speak: () => {
        calls += 1;
        return false;
      },
      stop: () => undefined,
    };
    const coach = new LiveSessionCoach({ voice });
    const events = [scoredView(0, 6.2, [kneeFault])];
    coach.consumeSnapshot(snap(events));
    coach.consumeSnapshot(snap(events));
    expect(calls).toBe(1);
    expect(coach.recap().cues[0]!.spoken).toBe(false);
    expect(coach.recap().spokenCount).toBe(0);
  });
});

// ─── Permission denial / missing-data analogue ──────────────────────────────

describe('analysis unavailable (permission-denial analogue) and stale/late data', () => {
  it('provider unavailable → every event stays pending, coach speaks only start + honest no-score end line', async () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'denied-1',
      source: 'live',
      provider: createPendingStubAnalysisProvider(),
      onUpdate: next => coach.consumeSnapshot(next),
    });
    coach.sessionStarted('live');
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    const final = flow.end();
    await flow.settled();
    expect(final.strokeCount).toBe(3);
    expect(final.events.every(e => e.state === 'pending')).toBe(true);
    expect(
      final.events.every(
        e => e.pendingReason === 'NATIVE_CLIP_EXTRACTION_NOT_BUILT',
      ),
    ).toBe(true);
    const recap = coach.sessionEnded(final);
    expect(recap.cues.map(c => c.category)).toEqual([
      'SESSION_START',
      'SESSION_END',
    ]);
    expect(recap.cues[1]!.text).toBe(
      'Session over. No swings could be scored this time.',
    );
    expect(spoken).toHaveLength(2);
    const progression = sessionScoreProgression(final.events);
    expect(progression).toMatchObject({
      scoredCount: 0,
      noReadCount: 0,
      pendingCount: 3,
    });
    const record = buildLiveSessionSummaryRecord(final, progression, recap);
    expect(record).toMatchObject({
      scoredCount: 0,
      pendingCount: 3,
      sessionAverage: null,
      bestScore: null,
      cuesSpoken: 2,
      topCorrection: null,
    });
  });

  it('a provider that rejects lands on ANALYSIS_DISPATCH_FAILED abstention and one honest NO_READ cue per event', async () => {
    const provider: SessionEventAnalysisProvider = {
      providerId: 'rejecting',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async () => {
        throw new Error('speech/camera permission denied');
      },
    };
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'reject-1',
      source: 'live',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    const final = flow.end();
    await flow.settled();
    const settled = flow.snapshot();
    expect(settled.events.map(e => e.state)).toEqual([
      'abstained',
      'abstained',
      'abstained',
    ]);
    expect(
      settled.events.every(e =>
        e.abstainReason?.startsWith('ANALYSIS_DISPATCH_FAILED:'),
      ),
    ).toBe(true);
    expect(
      settled.events.every(e => !e.abstainReason?.includes('undefined')),
    ).toBe(true);
    const categories = coach.recap().cues.map(c => c.category);
    expect(categories).toEqual(['NO_READ', 'NO_READ', 'SETUP_GUIDANCE']);
    expect(final.onUpdateFailures).toBe(0);
  });

  it('analyses settling AFTER end() reach the summary registry but never the voice', async () => {
    const gates = new Map<string, () => void>();
    const provider: SessionEventAnalysisProvider = {
      providerId: 'gated',
      availability: () => ({ status: 'available' }),
      analyzeEvent: request =>
        new Promise(resolve => {
          gates.set(request.eventId, () =>
            resolve({ status: 'ready', analysis: scoredAnalysis(7.2, clean) }),
          );
        }),
    };
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'late-1',
      source: 'live',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    const final = flow.end();
    await flushMicrotasks();
    expect(gates.size).toBe(3);
    coach.sessionEnded(final);
    for (const release of gates.values()) release();
    await flow.settled();
    expect(flow.snapshot().events.every(e => e.state === 'ready')).toBe(true);
    // Voice: no swing cue at all — the coach was already quiet.
    expect(coach.recap().cues.map(c => c.category)).toEqual(['SESSION_END']);
    expect(spoken).toHaveLength(1);
    // Registry: the late scores are still there for LiveSummary.
    expect(sessionScoreProgression(flow.snapshot().events).scoredCount).toBe(3);
  });

  it('out-of-order resolution (E3 → E1 → E2) still speaks each event exactly once', async () => {
    const gates = new Map<string, () => void>();
    const scores: Record<string, number> = { E1: 5.5, E2: 6.5, E3: 7.5 };
    const provider: SessionEventAnalysisProvider = {
      providerId: 'gated',
      availability: () => ({ status: 'available' }),
      analyzeEvent: request =>
        new Promise(resolve => {
          gates.set(request.eventId, () =>
            resolve({
              status: 'ready',
              analysis: scoredAnalysis(scores[request.eventId] ?? 6, clean),
            }),
          );
        }),
    };
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'ooo-1',
      source: 'live',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    flow.end();
    await flushMicrotasks();
    expect([...gates.keys()].sort()).toEqual(['E1', 'E2', 'E3']);
    for (const id of ['E3', 'E1', 'E2']) {
      gates.get(id)!();
      await flushMicrotasks();
    }
    await flow.settled();
    // Once per event, no duplicates, no loss.
    expect(
      coach
        .recap()
        .cues.map(c => c.eventId)
        .sort(),
    ).toEqual(['E1', 'E2', 'E3']);
    // The END line is computed over EVENT order regardless of resolution order.
    const progression = sessionScoreProgression(flow.snapshot().events);
    expect(progression.points.map(p => p.eventId)).toEqual(['E1', 'E2', 'E3']);
    expect(progression.delta).toBe(2);
  });
});

// ─── Cue-policy edge inputs (audio-coach-core through the mobile seam) ─────

describe('selectLiveCue adversarial inputs', () => {
  function run(observations: LiveRepObservation[]) {
    let state = INITIAL_LIVE_COACH_STATE;
    const out = [];
    for (const rep of observations) {
      const { decision, nextState } = selectLiveCue(
        state,
        rep,
        DEFAULT_LIVE_CUE_RULES,
      );
      state = nextState;
      out.push(decision);
    }
    return out;
  }

  it('never emits empty text for any terminal kind, including scored with no applicable checkpoints', () => {
    const decisions = run([
      { repIndex: 1, kind: 'scored', overallScore: 7.2, checkpoints: [] },
      {
        repIndex: 2,
        kind: 'scored',
        overallScore: 7.2,
        checkpoints: [
          {
            key: 'athletic_base',
            score: null,
            direction: 'low',
            severity: 0.9,
            applicable: false,
          },
        ],
      },
      {
        repIndex: 3,
        kind: 'low_confidence',
        overallScore: null,
        checkpoints: [],
      },
      { repIndex: 4, kind: 'abstained', overallScore: null, checkpoints: [] },
      { repIndex: 5, kind: 'scored', overallScore: 0, checkpoints: [] },
      { repIndex: 6, kind: 'scored', overallScore: 100, checkpoints: [] },
    ]);
    for (const d of decisions) {
      expect(d.text.trim().length).toBeGreaterThan(0);
      expect(d.text).not.toMatch(/undefined|NaN|null/);
    }
  });

  it('is deterministic across 3 identical runs of a 200-rep mixed stream', () => {
    const stream: LiveRepObservation[] = [];
    for (let i = 1; i <= 200; i += 1) {
      const mod = i % 5;
      stream.push(
        mod === 0
          ? {
              repIndex: i,
              kind: 'low_confidence',
              overallScore: null,
              checkpoints: [],
            }
          : mod === 1
            ? {
                repIndex: i,
                kind: 'abstained',
                overallScore: null,
                checkpoints: [],
              }
            : {
                repIndex: i,
                kind: 'scored',
                overallScore: 4 + (i % 7),
                checkpoints: [
                  {
                    key: 'athletic_base',
                    score: 30 + (i % 50),
                    direction: 'low',
                    severity: (i % 10) / 10,
                    applicable: true,
                  },
                ],
              },
      );
    }
    const a = run(stream).map(d => `${d.category}|${d.text}`);
    const b = run(stream).map(d => `${d.category}|${d.text}`);
    const c = run(stream).map(d => `${d.category}|${d.text}`);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('session end line never prints NaN/undefined for degenerate inputs', () => {
    const lines = [
      sessionEndLine({
        scoredCount: 0,
        startAverage: null,
        endAverage: null,
        best: null,
      }),
      sessionEndLine({
        scoredCount: 1,
        startAverage: 6.4,
        endAverage: 6.4,
        best: 6.4,
      }),
      sessionEndLine({
        scoredCount: 2,
        startAverage: 6.4,
        endAverage: 6.4,
        best: 6.4,
      }),
      sessionEndLine({
        scoredCount: 4,
        startAverage: 7,
        endAverage: 5,
        best: 7,
      }),
      sessionEndLine({
        scoredCount: 4,
        startAverage: null,
        endAverage: null,
        best: 7,
      }),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/NaN|undefined|null/);
      expect(line.startsWith('Session over.')).toBe(true);
    }
  });
});

// ─── LiveCourtEngine (older per-clip engine) ────────────────────────────────

describe('LiveCourtEngine failure paths', () => {
  const clip = {
    uri: 'fixture://forehand/live',
    durationMs: 2400,
    fps: 30,
    width: 720,
    height: 1280,
  };
  function makeEngine(
    providers = createFixtureVisionProviderSet('forehand_drive'),
  ) {
    let counter = 0;
    return new LiveCourtEngine(providers, {
      sessionId: '11111111-2222-4333-8444-555555555555',
      shotType: 'forehand_drive',
      focusCheckpoint: 'contact_position',
      handedness: 'right',
      appVersion: '0.1.0-test',
      modelBundleVersion: 'fixture-1',
      makeId: () =>
        `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    });
  }

  it('a stroke the detector cannot find returns null and is excluded from the summary (not miscounted)', async () => {
    const base = createFixtureVisionProviderSet('forehand_drive');
    const engine = makeEngine({
      ...base,
      stroke: { ...base.stroke, detectStrokes: async () => ok([]) },
    });
    expect(await engine.onStroke(clip)).toBeNull();
    const summary = engine.summary();
    expect(summary).toMatchObject({
      validReps: 0,
      lowConfidenceReps: 0,
      startScore: null,
      bestScore: null,
      cuesSpoken: 0,
    });
    expect(engine.allReps()).toEqual([]);
  });

  it('empty session summary is all-null / zero, never NaN', () => {
    const summary = makeEngine().summary();
    expect(summary.bestScore).toBeNull();
    expect(summary.startScore).toBeNull();
    expect(summary.endScore).toBeNull();
    expect(summary.focusStart).toBeNull();
    expect(Number.isNaN(summary.bestScore as unknown as number)).toBe(false);
  });
});

// ─── Summary record strict parsing ──────────────────────────────────────────

describe('parseLiveSessionSummaryRecord hostile inputs', () => {
  it('rejects garbage, wrong versions, wrong sources, arrays and primitives', () => {
    for (const input of [
      null,
      '',
      '{',
      'null',
      '42',
      '"live"',
      '[]',
      '[1,2]',
      '{}',
      '{"version":2,"source":"live"}',
      '{"version":"1","source":"live"}',
      '{"version":1,"source":"LIVE"}',
      '{"version":1,"source":null}',
      '{"version":1}',
    ]) {
      expect(parseLiveSessionSummaryRecord(input)).toBeNull();
    }
  });

  it('sanitizes hostile numeric fields instead of propagating them', () => {
    const record = parseLiveSessionSummaryRecord(
      JSON.stringify({
        version: 1,
        source: 'live',
        engineVersion: 12,
        durationMs: -5,
        strokeCount: 1e21,
        scoredCount: '3',
        noReadCount: 2.5,
        pendingCount: Number.MAX_SAFE_INTEGER,
        startAverage: 'NaN',
        endAverage: null,
        delta: -3.25,
        bestScore: 1e308,
        sessionAverage: {},
        cuesSpoken: -1,
        topCorrection: 42,
        correctionsByCheckpoint: {
          athletic_base: 2,
          contact_position: 1.5,
          x: 'y',
          __proto__: { polluted: 1 },
        },
      }),
    );
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      engineVersion: '12',
      durationMs: 0,
      strokeCount: 0,
      scoredCount: 0,
      noReadCount: 0,
      pendingCount: Number.MAX_SAFE_INTEGER,
      startAverage: null,
      endAverage: null,
      delta: -3.25,
      bestScore: 1e308,
      sessionAverage: null,
      cuesSpoken: 0,
      topCorrection: null,
      correctionsByCheckpoint: { athletic_base: 2 },
    });
    expect(Object.keys(record!.correctionsByCheckpoint)).toEqual([
      'athletic_base',
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('round-trips a real integer-timestamp session unchanged', async () => {
    const provider: SessionEventAnalysisProvider = {
      providerId: 'rt',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async request => ({
        status: 'ready',
        analysis:
          request.eventId === 'E2'
            ? lowConfidenceAnalysis()
            : scoredAnalysis(6.4, [kneeFault]),
      }),
    };
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'rt-1',
      source: 'live',
      provider,
      onUpdate: s => coach.consumeSnapshot(s),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();
    const final = flow.snapshot();
    const recap = coach.sessionEnded(final);
    const record = buildLiveSessionSummaryRecord(
      final,
      sessionScoreProgression(final.events),
      recap,
    );
    expect(Number.isInteger(record.durationMs)).toBe(true);
    expect(parseLiveSessionSummaryRecord(JSON.stringify(record))).toEqual(
      record,
    );
    expect(record).toMatchObject({
      scoredCount: 2,
      noReadCount: 1,
      pendingCount: 0,
      cuesSpoken: 4,
    });
  });
});
