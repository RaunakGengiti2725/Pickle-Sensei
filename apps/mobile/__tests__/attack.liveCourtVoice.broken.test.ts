/**
 * ADVERSARIAL PASS — mobile-live-court-voice (BROKEN set).
 *
 * Each test asserts the product contract the Live Court voice subsystem is
 * supposed to honour, and FAILS against 4d812e1a. A failing test here is a
 * documented finding (see the coordinator report); when the production fix
 * lands these tests must be moved into the HELD file unchanged.
 *
 * Nothing in this file touches production code. Native (AVFoundation)
 * behaviour is never asserted from Linux — only the JS side of the bridge.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  LiveSessionCoach,
  getCompletedCoachRecap,
  type CoachVoicePort,
  type SpokenCue,
} from '../src/flow/liveSessionCoach';
import type {
  LiveSessionSnapshot,
  SessionEventView,
} from '../src/flow/session';
import { sessionScoreProgression } from '../src/flow/sessionProgress';
import { buildLiveSessionSummaryRecord } from '../src/flow/liveSessionSummary';
import { LiveCourtEngine } from '../src/flow/liveCourt';

jest.mock('@pickle/analysis-pipeline', () => ({ analyzeClip: jest.fn() }));

// ─── fixtures ──────────────────────────────────────────────────────────────

function view(
  partial: Partial<SessionEventView> & { index: number },
): SessionEventView {
  const { index } = partial;
  return {
    eventId: `E${index + 1}`,
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
    index,
  };
}

function snap(
  events: SessionEventView[],
  overrides: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot {
  return {
    sessionId: 'attack-broken',
    phase: 'running',
    source: 'live',
    startedAtIso: '2026-09-04T10:00:00.000Z',
    durationMs: events.length * 1000,
    strokeCount: events.length,
    events,
    distribution: [],
    qualityNotes: [],
    droppedLateSamples: 0,
    onUpdateFailures: 0,
    engineVersion: 'attack-engine',
    analysisProviderId: 'attack-provider',
    ...overrides,
  };
}

function scoredRecord(overallScore: number): AnalysisRecord {
  return {
    strokeResolution: { kind: 'declared', shotType: 'forehand_drive' },
    result: {
      resultKind: 'scored',
      overallScore,
      checkpoints: [
        {
          key: 'knee_bend',
          score: 6,
          confidence: 0.9,
          band: 'yellow',
          direction: 'low',
          severity: 0.6,
          applicable: true,
        },
      ],
    },
  } as unknown as AnalysisRecord;
}

function makeVoice() {
  const spoken: Array<{ text: string; category: string | undefined }> = [];
  const voice: CoachVoicePort = {
    available: () => true,
    speak: (text, options) => {
      spoken.push({ text, category: options?.category });
    },
    stop: jest.fn(),
  };
  return { voice, spoken };
}

// ─── scenario 4: tts bridge ignores category / never reaches speakCue ──────

describe('tts bridge — category-aware speech (scenario 4)', () => {
  function loadTtsWithNative() {
    const native = {
      speak: jest.fn(),
      speakCue: jest.fn(),
      stop: jest.fn(),
      listVoices: jest.fn(),
    };
    let tts!: typeof import('../src/audio/tts').tts;
    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({
        NativeModules: { PickleAudioCoach: native },
      }));
      tts =
        jest.requireActual<typeof import('../src/audio/tts')>(
          '../src/audio/tts',
        ).tts;
    });
    return { native, tts };
  }

  it('tts.speak(text, { category: SESSION_END }) reaches native speakCue with an interruption policy, not legacy immediate speak', () => {
    const { native, tts } = loadTtsWithNative();
    // The coach calls `voice.speak(text, { category })` — the tts object is
    // handed to LiveSessionCoach as its CoachVoicePort, so it receives the
    // category as its second argument. `CoachVoicePort.speak` has that
    // parameter in its type; `tts.speak` does not — TS lets the assignment
    // through because a shorter parameter list is compatible.
    const coach = new LiveSessionCoach({ voice: tts });
    coach.sessionStarted('live');
    coach.consumeSnapshot(
      snap([view({ index: 0, state: 'ready', analysis: scoredRecord(6.2) })]),
    );
    coach.sessionEnded(
      snap([view({ index: 0, state: 'ready', analysis: scoredRecord(6.2) })], {
        phase: 'ended',
      }),
    );

    // EXPECTED: category-aware path. Every cue reaches `speakCue`, the
    // SESSION_END line carries a non-immediate interruption (it must not cut
    // the last per-swing cue), legacy `speak(text, rate)` is never used.
    expect(native.speak).not.toHaveBeenCalled();
    expect(native.speakCue).toHaveBeenCalledTimes(3);
    const endCall = native.speakCue.mock.calls.at(-1) as
      [string, Record<string, unknown>] | undefined;
    expect(endCall?.[0]).toMatch(/^Session over\./);
    expect(endCall?.[1]).toEqual(
      expect.objectContaining({
        interruption: expect.stringMatching(/^(enqueue|word)$/),
      }),
    );
  });

  it('the CoachVoicePort implemented by tts reports `spoken:false` when nothing was voiced (native rejected)', () => {
    const { native, tts } = loadTtsWithNative();
    native.speak.mockImplementation(() => {
      throw new Error('AVAudioSession activation failed');
    });
    native.speakCue.mockImplementation(() => {
      throw new Error('AVAudioSession activation failed');
    });
    const coach = new LiveSessionCoach({ voice: tts });
    // EXPECTED: the caption records the truth (spoken:false) and the coach
    // keeps running. OBSERVED: the native error propagates out of
    // sessionStarted() and no cue is logged at all.
    expect(() => coach.sessionStarted('live')).not.toThrow();
    expect(coach.lastCue()).toEqual(expect.objectContaining({ spoken: false }));
  });
});

// ─── scenario 5: dispose() before sessionEnded(final) ──────────────────────

describe('LiveSessionCoach — teardown ordering (scenario 5)', () => {
  it('dispose() before sessionEnded(final) still registers the recap for LiveSummary', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.sessionStarted('live');
    const events = [
      view({ index: 0, state: 'ready', analysis: scoredRecord(6.2) }),
    ];
    coach.consumeSnapshot(snap(events));
    const final = snap(events, {
      sessionId: 'attack-dispose-first',
      phase: 'ended',
    });

    // Screen unmount races the flow's end(): dispose() lands first.
    coach.dispose();
    const recap = coach.sessionEnded(final);

    // EXPECTED: the summary screen can still read what the coach said
    // (recap has the 2 real cues) — the registry is the ONLY channel to
    // LiveSummary. OBSERVED: getCompletedCoachRecap → null.
    expect(recap.cues).toHaveLength(2);
    expect(getCompletedCoachRecap('attack-dispose-first')).not.toBeNull();
    expect(getCompletedCoachRecap('attack-dispose-first')?.cues).toHaveLength(
      2,
    );
  });

  it('a voice port that throws on the end line must not lose the recap registration', () => {
    let calls = 0;
    const voice: CoachVoicePort = {
      available: () => true,
      speak: () => {
        calls += 1;
        if (calls === 2) throw new Error('speech synthesizer gone');
      },
      stop: jest.fn(),
    };
    const coach = new LiveSessionCoach({ voice });
    coach.sessionStarted('live');
    const final = snap([], { sessionId: 'attack-end-throws', phase: 'ended' });
    // EXPECTED: registry write + end cue captioned as spoken:false, no throw.
    // OBSERVED: throw escapes, `ended` is already true, the registry is
    // never written and a retry of sessionEnded is a no-op — the recap is
    // lost for good.
    expect(() => coach.sessionEnded(final)).not.toThrow();
    expect(getCompletedCoachRecap('attack-end-throws')).not.toBeNull();
    expect(coach.lastCue()).toEqual(
      expect.objectContaining({ category: 'SESSION_END', spoken: false }),
    );
  });
});

// ─── scenario 7: sessionStarted twice ──────────────────────────────────────

describe('LiveSessionCoach — intro idempotency (scenario 7)', () => {
  it('sessionStarted twice (live then replay) speaks a single intro line', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.sessionStarted('live');
    coach.sessionStarted('replay');
    // EXPECTED: one intro. OBSERVED: two SESSION_START cues, the second one
    // says "Demo rally replay" in a live session.
    expect(spoken.filter(s => s.category === 'SESSION_START')).toHaveLength(1);
    expect(
      coach.recap().cues.filter(c => c.category === 'SESSION_START'),
    ).toHaveLength(1);
  });

  it('sessionStarted after sessionEnded / dispose stays silent (the coach is over)', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.sessionStarted('live');
    coach.sessionEnded(
      snap([], { sessionId: 'attack-start-after-end', phase: 'ended' }),
    );
    coach.sessionStarted('live');
    coach.dispose();
    coach.sessionStarted('replay');
    // EXPECTED: nothing after the end line. OBSERVED: two extra intros are
    // spoken after "Session over", and the recap registered at end no
    // longer matches coach.recap().
    expect(spoken.map(s => s.category)).toEqual([
      'SESSION_START',
      'SESSION_END',
    ]);
    expect(coach.recap().cues).toHaveLength(2);
  });
});

// ─── voice-port failure mid-snapshot ───────────────────────────────────────

describe('LiveSessionCoach — voice port throws mid-snapshot', () => {
  it('a throwing port must not drop the remaining events of the snapshot or lose the caption', () => {
    let calls = 0;
    const seen: SpokenCue[] = [];
    const voice: CoachVoicePort = {
      available: () => true,
      speak: () => {
        calls += 1;
        if (calls === 2) throw new Error('native bridge rejected utterance');
      },
      stop: jest.fn(),
    };
    const coach = new LiveSessionCoach({ voice, onCue: cue => seen.push(cue) });
    const events = [0, 1, 2].map(i =>
      view({ index: i, state: 'ready', analysis: scoredRecord(5 + i) }),
    );
    // EXPECTED: E1..E3 all captioned (E2 with spoken:false). OBSERVED: the
    // throw escapes consumeSnapshot after E2 was marked consumed — E2 is
    // never captioned and E3 is not processed until the next snapshot.
    expect(() => coach.consumeSnapshot(snap(events))).not.toThrow();
    expect(seen.map(c => c.eventId)).toEqual(['E1', 'E2', 'E3']);
    expect(seen[1]?.spoken).toBe(false);
  });
});

// ─── corrupt state: non-finite scores ──────────────────────────────────────

describe('LiveSessionCoach — corrupt analysis scores', () => {
  it('a NaN / Infinity overallScore is never voiced as a score and never enters the end line', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const events = [
      view({ index: 0, state: 'ready', analysis: scoredRecord(Number.NaN) }),
      view({
        index: 1,
        state: 'ready',
        analysis: scoredRecord(Number.POSITIVE_INFINITY),
      }),
    ];
    coach.consumeSnapshot(snap(events));
    coach.sessionEnded(
      snap(events, { sessionId: 'attack-nan', phase: 'ended' }),
    );
    // EXPECTED: no "NaN." / "Infinity." spoken; treated as no-read.
    const texts = spoken.map(s => s.text);
    for (const text of texts) {
      expect(text).not.toMatch(/NaN|Infinity/);
    }
    expect(
      coach.recap().cues.filter(c => c.category === 'NO_READ'),
    ).toHaveLength(2);
  });
});

// ─── coach ↔ summary consistency ──────────────────────────────────────────

describe('LiveSessionCoach ↔ sessionScoreProgression — the voice and the summary must agree', () => {
  it("a 'ready' event with no analysis record is spoken as a no-read by the coach but counted nowhere by the progression", () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const events = [view({ index: 0, state: 'ready', analysis: null })];
    coach.consumeSnapshot(snap(events));
    const progression = sessionScoreProgression(events);
    const noReadCues = coach
      .recap()
      .cues.filter(c => c.category === 'NO_READ').length;
    // EXPECTED: same count on both channels — the summary screen shows
    // "N no reads" from the progression and the coach recap side by side.
    expect(noReadCues).toBe(progression.noReadCount);
  });

  it("a 'scored' result with overallScore null is spoken as a no-read but the progression drops it", () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const record = {
      strokeResolution: { kind: 'declared', shotType: 'forehand_drive' },
      result: { resultKind: 'scored', overallScore: null, checkpoints: [] },
    } as unknown as AnalysisRecord;
    const events = [view({ index: 0, state: 'ready', analysis: record })];
    coach.consumeSnapshot(snap(events));
    const final = snap(events, {
      sessionId: 'attack-null-score',
      phase: 'ended',
    });
    const recap = coach.sessionEnded(final);
    const progression = sessionScoreProgression(events);
    const summary = buildLiveSessionSummaryRecord(final, progression, recap);
    expect(recap.cues.filter(c => c.category === 'NO_READ')).toHaveLength(1);
    // EXPECTED: the persisted summary agrees with what was spoken.
    expect(summary.noReadCount).toBe(1);
    expect(progression.noReadCount).toBe(1);
  });
});

// ─── LiveCourtEngine — concurrent strokes ──────────────────────────────────

describe('LiveCourtEngine — analyses that land out of order', () => {
  function shotAnalysis(overallScore: number): ShotAnalysis {
    return {
      id: `a-${overallScore}`,
      sessionId: 's',
      shotType: 'forehand_drive',
      cameraView: 'side',
      handedness: 'right',
      capturedAtIso: '2026-09-04T00:00:00.000Z',
      timestamps: { startMs: 0, contactMs: 100, endMs: 400 },
      phases: [],
      measurements: [],
      checkpoints: [
        {
          key: 'contact_position',
          score: overallScore,
          confidence: 0.9,
          band: 'yellow',
          direction: 'low',
          severity: 0.5,
          applicable: true,
        },
      ],
      overallScore,
      analysisConfidence: 0.9,
      resultKind: 'scored',
      guidance: null,
      priorityFix: null,
      versionVector: {
        appVersion: 't',
        modelBundleVersion: 't',
        scoringVersion: 't',
      },
      source: 'fixture',
    } as unknown as ShotAnalysis;
  }

  it('reps are recorded in stroke (repIndex) order even when the second analysis resolves first', async () => {
    const { analyzeClip } = jest.requireMock('@pickle/analysis-pipeline') as {
      analyzeClip: jest.Mock;
    };
    const resolvers: Array<(value: { ok: true; value: ShotAnalysis }) => void> =
      [];
    analyzeClip.mockImplementation(
      () =>
        new Promise(resolve => {
          resolvers.push(
            resolve as (value: { ok: true; value: ShotAnalysis }) => void,
          );
        }),
    );
    let counter = 0;
    const engine = new LiveCourtEngine({} as never, {
      sessionId: 'attack-live-court',
      shotType: 'forehand_drive',
      focusCheckpoint: 'contact_position',
      handedness: 'right',
      appVersion: 't',
      modelBundleVersion: 't',
      makeId: () => `id-${++counter}`,
    });
    const clip = {
      uri: 'x',
      durationMs: 1000,
      fps: 30,
      width: 720,
      height: 1280,
    };
    const first = engine.onStroke(clip);
    const second = engine.onStroke(clip);
    expect(resolvers).toHaveLength(2);
    // Stroke 2 (a worse swing) is analysed faster than stroke 1.
    resolvers[1]!({ ok: true, value: shotAnalysis(4.0) });
    await second;
    resolvers[0]!({ ok: true, value: shotAnalysis(7.5) });
    await first;

    // EXPECTED: the session's rep list and start/end scores follow stroke
    // order (7.5 then 4.0). OBSERVED: `repIndex: this.repCounter` is read
    // AFTER the await, so BOTH reps carry repIndex 2, the list is in
    // resolution order (startScore 4.0, endScore 7.5) and the cue engine
    // saw rep 2 before rep 1.
    expect(engine.allReps().map(r => r.repIndex)).toEqual([1, 2]);
    const summary = engine.summary();
    expect(summary.startScore).toBe(7.5);
    expect(summary.endScore).toBe(4.0);
  });

  it('a failed analysis is still accounted for in the summary (a swing does not vanish)', async () => {
    const { analyzeClip } = jest.requireMock('@pickle/analysis-pipeline') as {
      analyzeClip: jest.Mock;
    };
    analyzeClip
      .mockResolvedValueOnce({ ok: false, error: { code: 'PIPELINE_FAILED' } })
      .mockResolvedValueOnce({ ok: true, value: shotAnalysis(6.0) });
    const engine = new LiveCourtEngine({} as never, {
      sessionId: 'attack-live-court-fail',
      shotType: 'forehand_drive',
      focusCheckpoint: 'contact_position',
      handedness: 'right',
      appVersion: 't',
      modelBundleVersion: 't',
      makeId: () => 'id',
    });
    const clip = {
      uri: 'x',
      durationMs: 1000,
      fps: 30,
      width: 720,
      height: 1280,
    };
    expect(await engine.onStroke(clip)).toBeNull();
    expect(await engine.onStroke(clip)).not.toBeNull();
    const summary = engine.summary();
    // EXPECTED: 2 strokes seen → 1 valid + 1 unscorable. OBSERVED: the
    // failed stroke is dropped from every counter (validReps 1,
    // lowConfidenceReps 0) although repIndex already advanced to 2.
    expect(summary.validReps + summary.lowConfidenceReps).toBe(2);
    expect(engine.allReps().at(-1)?.repIndex).toBe(2);
  });
});
