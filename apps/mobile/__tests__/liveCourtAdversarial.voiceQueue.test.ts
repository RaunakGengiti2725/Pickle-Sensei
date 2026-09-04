/**
 * ADVERSARIAL HARNESS — voice cue queue behaviour under overlap and
 * interruption.
 *
 * The coach emits one cue per terminal event with NO coalescing, queueing or
 * rate limiting in JS; the port decides. The real port (PickleAudioCoach,
 * AVSpeechSynthesizer) cannot run on Linux, so the cue stream is driven into
 * a VIRTUAL-CLOCK synthesizer model whose interruption policies mirror the
 * Swift module's documented modes. Measurements are about the cue stream the
 * JS layer produces (how many cues a player could hear under each policy),
 * never about Apple runtime truth.
 *
 * Evidence: artifacts/live-court-adversarial/<run>/voice-queue/*.json
 */
import { LiveSessionCoach } from '../src/flow/liveSessionCoach';
import type { SessionEventView } from '../src/flow/session';
import {
  CLEAN_CHECKPOINTS,
  FAULT_CHECKPOINT_KEYS,
  FAULT_DIRECTIONS,
  eventView,
  lowConfidenceAnalysis,
  scoredAnalysis,
  snapshotOf,
} from '../harness/liveCourtAdversarial/doubles';
import { Evidence, nowMs } from '../harness/liveCourtAdversarial/evidence';
import { SeededRng } from '../harness/liveCourtAdversarial/prng';
import {
  SynthesizerModelPort,
  categoryAwarePolicy,
  synthesizerMetrics,
  type InterruptionPolicy,
  type SynthesizerMetrics,
} from '../harness/liveCourtAdversarial/voicePorts';

declare const process: { env: Record<string, string | undefined> };

const SCALE = Number(process.env.LIVE_COURT_HARNESS_EVENTS ?? 10_000);
const evidence = new Evidence('voice-queue');

function randomTerminal(rng: SeededRng, index: number): SessionEventView {
  const id = `v-E${index + 1}`;
  if (rng.chance(0.2)) {
    return eventView(index, {
      state: 'ready',
      analysis: lowConfidenceAnalysis(id),
    });
  }
  const checkpoints = [...CLEAN_CHECKPOINTS];
  if (rng.chance(0.6)) {
    checkpoints.push({
      key: rng.pick(FAULT_CHECKPOINT_KEYS),
      score: rng.int(20, 60),
      direction: rng.pick(FAULT_DIRECTIONS),
      severity: Math.round(rng.float(0.3, 0.9) * 100) / 100,
    });
  }
  return eventView(index, {
    state: 'ready',
    analysis: scoredAnalysis(
      id,
      Math.round(rng.float(3, 9.6) * 10) / 10,
      checkpoints,
    ),
  });
}

interface OverlapRun {
  policy: string;
  interArrivalMs: [number, number];
  events: number;
  seed: number;
  metrics: SynthesizerMetrics;
  /** Seconds of speech still queued when the last event arrived. */
  backlogAtEndMs: number;
  /** Max (utterance start − event arrival) — how stale a spoken cue got. */
  maxStalenessMs: number;
  wallMs: number;
}

function runOverlap(input: {
  seed: number;
  events: number;
  interArrivalMs: [number, number];
  policy: InterruptionPolicy | 'category-aware';
}): OverlapRun {
  const rng = new SeededRng(input.seed);
  const port = new SynthesizerModelPort(
    input.policy === 'category-aware'
      ? { policyFor: categoryAwarePolicy }
      : { defaultPolicy: input.policy },
  );
  const coach = new LiveSessionCoach({ voice: port });
  const t0 = nowMs();
  coach.sessionStarted('live');
  const views: SessionEventView[] = [];
  let maxStaleness = 0;
  for (let index = 0; index < input.events; index += 1) {
    port.advance(rng.float(input.interArrivalMs[0], input.interArrivalMs[1]));
    views.push(randomTerminal(rng, index));
    const before = port.utterances.length;
    // Real flow shape: the coach sees the whole event list each time; only
    // the newest is un-consumed. Keep the window bounded so the harness cost
    // is the coach's, not the array copy's.
    coach.consumeSnapshot(snapshotOf(views.slice(-64)));
    for (const utterance of port.utterances.slice(before)) {
      if (utterance.startedAtMs !== null) {
        maxStaleness = Math.max(
          maxStaleness,
          utterance.startedAtMs - utterance.enqueuedAtMs,
        );
      }
    }
  }
  const lastArrival = port.now();
  port.drain();
  for (const utterance of port.utterances) {
    if (utterance.startedAtMs !== null) {
      maxStaleness = Math.max(
        maxStaleness,
        utterance.startedAtMs - utterance.enqueuedAtMs,
      );
    }
  }
  const backlogAtEndMs = Math.max(
    0,
    port.utterances.reduce(
      (latest, u) => Math.max(latest, u.endedAtMs ?? 0),
      0,
    ) - lastArrival,
  );
  return {
    policy: input.policy,
    interArrivalMs: input.interArrivalMs,
    events: input.events,
    seed: input.seed,
    metrics: synthesizerMetrics(port),
    backlogAtEndMs,
    maxStalenessMs: maxStaleness,
    wallMs: nowMs() - t0,
  };
}

describe('Voice cue queue under overlap and interruption (virtual-clock synthesizer model)', () => {
  it(`V1 overlap matrix: ${SCALE} events × inter-arrival × interruption policy → completion rate / backlog`, () => {
    const policies: Array<InterruptionPolicy | 'category-aware'> = [
      'immediate',
      'word',
      'enqueue',
      'category-aware',
    ];
    const cadences: Array<[number, number]> = [
      [400, 900], // fast rally: events land faster than a cue can be spoken
      [900, 1600], // brisk drilling
      [1600, 3000], // relaxed drilling: one cue usually fits
      [3000, 6000], // slow: every cue fits
    ];
    const matrix: OverlapRun[] = [];
    let seed = 0x0c0ffee0;
    for (const policy of policies) {
      for (const cadence of cadences) {
        seed += 1;
        matrix.push(
          runOverlap({ seed, events: SCALE, interArrivalMs: cadence, policy }),
        );
      }
    }
    evidence.writeJson('V1-overlap-matrix', {
      model: {
        msPerWord: 343,
        startupMs: 120,
        note: 'AVSpeech rate 0.5 ≈ 175 wpm; utterance duration = 120ms + 343ms/word. "immediate"/"word" cancel the current utterance and clear the queue (AVSpeechSynthesizer.stopSpeaking semantics); "enqueue" appends.',
      },
      rows: matrix.map(row => ({
        ...row,
        completionRatePct: Math.round(row.metrics.completionRate * 1000) / 10,
        underHalfHeardPct:
          Math.round((row.metrics.underHalfHeard / row.metrics.total) * 1000) /
          10,
      })),
    });
    for (const row of matrix) {
      evidence.log(
        `V1 policy=${row.policy} cadence=${row.interArrivalMs.join('-')} completion=${(row.metrics.completionRate * 100).toFixed(1)}% underHalf=${row.metrics.underHalfHeard} backlog=${(row.backlogAtEndMs / 1000).toFixed(1)}s maxStale=${(row.maxStalenessMs / 1000).toFixed(1)}s`,
      );
    }
    // Contract invariants of the JS layer regardless of policy: every event
    // produced exactly one speak() call (no drops, no duplicates in JS).
    for (const row of matrix) expect(row.metrics.total).toBe(SCALE + 1);
    // Enqueue never loses a cue in the model — it only gets stale.
    for (const row of matrix.filter(r => r.policy === 'enqueue')) {
      expect(row.metrics.completed).toBe(SCALE + 1);
    }
  });

  it('V2 burst after a stall: 50 analyses settle in one snapshot → per-policy heard/dropped table', () => {
    const burst = 50;
    const rows: Array<{
      policy: string;
      metrics: SynthesizerMetrics;
      totalSpeechMs: number;
    }> = [];
    for (const policy of [
      'immediate',
      'word',
      'enqueue',
      'category-aware',
    ] as const) {
      const rng = new SeededRng(0xb0057);
      const port = new SynthesizerModelPort(
        policy === 'category-aware'
          ? { policyFor: categoryAwarePolicy }
          : { defaultPolicy: policy },
      );
      const coach = new LiveSessionCoach({ voice: port });
      const views = Array.from({ length: burst }, (_, i) =>
        randomTerminal(rng, i),
      );
      coach.consumeSnapshot(snapshotOf(views));
      const lastArrival = port.now();
      port.drain();
      const totalSpeechMs =
        port.utterances.reduce((s, u) => Math.max(s, u.endedAtMs ?? 0), 0) -
        lastArrival;
      rows.push({ policy, metrics: synthesizerMetrics(port), totalSpeechMs });
    }
    evidence.writeJson('V2-burst-after-stall', { burst, rows });
    for (const row of rows)
      evidence.log(
        `V2 policy=${row.policy} completed=${row.metrics.completed}/${row.metrics.total} neverStarted=${row.metrics.neverStarted} speechBacklog=${(row.totalSpeechMs / 1000).toFixed(1)}s`,
      );
    const immediate = rows.find(r => r.policy === 'immediate');
    const enqueue = rows.find(r => r.policy === 'enqueue');
    // Model consequence, recorded as evidence: with the shipped category-blind
    // "latest wins" path exactly one of the burst survives; with pure
    // queueing all survive but the backlog is the whole burst's speech.
    expect(immediate?.metrics.completed).toBe(1);
    expect(immediate?.metrics.underHalfHeard).toBe(burst - 1);
    expect(enqueue?.metrics.completed).toBe(burst);
  });

  it('V3 interruption: mute mid-utterance, unmute, session end while a cue is in flight, dispose with a queue', () => {
    const rng = new SeededRng(0x1a7e);
    const results: Record<string, unknown> = {};

    // (a) mute cuts the current utterance at a word boundary and clears the queue.
    {
      const port = new SynthesizerModelPort({ defaultPolicy: 'enqueue' });
      const coach = new LiveSessionCoach({ voice: port });
      coach.sessionStarted('live');
      coach.consumeSnapshot(
        snapshotOf([randomTerminal(rng, 0), randomTerminal(rng, 1)]),
      );
      port.advance(700);
      coach.setMuted(true);
      const cancelled = port.utterances.filter(u => u.outcome === 'cancelled');
      const neverStarted = port.utterances.filter(
        u => u.outcome === 'never_started',
      );
      coach.consumeSnapshot(
        snapshotOf([
          randomTerminal(rng, 0),
          randomTerminal(rng, 1),
          randomTerminal(rng, 2),
        ]),
      );
      const speakCallsWhileMuted = port.utterances.length;
      coach.setMuted(false);
      coach.consumeSnapshot(
        snapshotOf([0, 1, 2, 3].map(i => randomTerminal(rng, i))),
      );
      port.drain();
      results.mute = {
        stopCalls: port.stopCalls,
        cancelledAtMute: cancelled.map(u => ({
          seq: u.seq,
          heardFraction: u.heardFraction,
        })),
        neverStartedAtMute: neverStarted.length,
        speakCallsWhileMuted: speakCallsWhileMuted - 3,
        cuesLoggedWhileMuted: coach
          .recap()
          .cues.filter(c => c.eventId === 'E3' && !c.spoken).length,
        spokenAfterUnmute: port.utterances.filter(
          u => u.seq > 3 && u.outcome === 'completed',
        ).length,
      };
      expect(port.stopCalls).toBe(1);
      expect(cancelled).toHaveLength(1);
      expect(neverStarted).toHaveLength(2);
      expect(speakCallsWhileMuted - 3).toBe(0);
    }

    // (b) session end line arrives while a swing cue is speaking.
    {
      const table: Array<{
        policy: string;
        swingCueOutcome: string;
        swingHeard: number;
        endOutcome: string;
      }> = [];
      for (const policy of [
        'immediate',
        'word',
        'enqueue',
        'category-aware',
      ] as const) {
        const port = new SynthesizerModelPort(
          policy === 'category-aware'
            ? { policyFor: categoryAwarePolicy }
            : { defaultPolicy: policy },
        );
        const coach = new LiveSessionCoach({ voice: port });
        const view = eventView(0, {
          state: 'ready',
          analysis: scoredAnalysis('end-E1', 6.4, [
            {
              key: 'athletic_base',
              score: 40,
              direction: 'low',
              severity: 0.5,
            },
          ]),
        });
        coach.consumeSnapshot(snapshotOf([view]));
        port.advance(500);
        coach.sessionEnded(
          snapshotOf([view], { phase: 'ended', sessionId: `v3-${policy}` }),
        );
        port.drain();
        const swing = port.utterances[0];
        const end = port.utterances[1];
        table.push({
          policy,
          swingCueOutcome: swing?.outcome ?? 'missing',
          swingHeard: swing?.heardFraction ?? 0,
          endOutcome: end?.outcome ?? 'missing',
        });
      }
      results.sessionEndWhileSpeaking = table;
      // Category-blind immediate: the wrap-up cuts the last swing cue.
      expect(table.find(r => r.policy === 'immediate')?.swingCueOutcome).toBe(
        'cancelled',
      );
      // Category-aware: the wrap-up queues behind it.
      expect(
        table.find(r => r.policy === 'category-aware')?.swingCueOutcome,
      ).toBe('completed');
      for (const row of table) expect(row.endOutcome).toBe('completed');
    }

    // (c) dispose with a queue: everything queued is cancelled, nothing after.
    {
      const port = new SynthesizerModelPort({ defaultPolicy: 'enqueue' });
      const coach = new LiveSessionCoach({ voice: port });
      coach.consumeSnapshot(
        snapshotOf([0, 1, 2, 3, 4].map(i => randomTerminal(rng, i))),
      );
      port.advance(300);
      coach.dispose();
      const outcomes = port.utterances.map(u => u.outcome);
      coach.consumeSnapshot(
        snapshotOf([0, 1, 2, 3, 4, 5].map(i => randomTerminal(rng, i))),
      );
      results.dispose = {
        outcomes,
        speakCallsAfterDispose: port.utterances.length - 5,
        stopCalls: port.stopCalls,
      };
      expect(outcomes).toEqual([
        'cancelled',
        'never_started',
        'never_started',
        'never_started',
        'never_started',
      ]);
      expect(port.utterances.length).toBe(5);
    }

    evidence.writeJson('V3-interruption', results);
  });

  it('V4 unavailable voice mid-session: availability toggles are honoured per cue, captions never stop', () => {
    const rng = new SeededRng(0x0ff);
    let available = true;
    const spoken: string[] = [];
    const coach = new LiveSessionCoach({
      voice: {
        available: () => available,
        speak: text => {
          spoken.push(text);
        },
        stop: () => {},
      },
    });
    const views: SessionEventView[] = [];
    const rows: Array<{ index: number; available: boolean; spoken: boolean }> =
      [];
    for (let index = 0; index < 2000; index += 1) {
      if (index % 250 === 0) available = !available;
      views.push(randomTerminal(rng, index));
      coach.consumeSnapshot(snapshotOf(views.slice(-32)));
      const cue = coach.lastCue();
      rows.push({ index, available, spoken: cue?.spoken ?? false });
    }
    const mismatches = rows.filter(r => r.available !== r.spoken);
    evidence.writeJson('V4-availability-toggles', {
      cues: coach.recap().cues.length,
      spokenCount: coach.recap().spokenCount,
      portCalls: spoken.length,
      mismatches: mismatches.length,
    });
    expect(coach.recap().cues.length).toBe(2000);
    expect(mismatches).toEqual([]);
    expect(spoken.length).toBe(coach.recap().spokenCount);
  });
});
