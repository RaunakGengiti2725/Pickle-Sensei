/**
 * ADVERSARIAL HARNESS — LiveSessionCoach under a scripted event stream.
 *
 * Journey slice: stroke events reaching the voice coach rapidly, duplicated,
 * out of order and malformed; mute/resume; dispose/stop → recap. Scale is
 * ≥10k events per scenario (accelerated: no timers, snapshots are delivered
 * back-to-back). Every scenario is seed-deterministic; failures record the
 * seed + offending input so they replay from the evidence tables.
 *
 * Evidence: artifacts/live-court-adversarial/<run>/coach-stream/*.json
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import {
  LiveSessionCoach,
  getCompletedCoachRecap,
  type SpokenCue,
} from '../src/flow/liveSessionCoach';
import type { SessionEventView } from '../src/flow/session';
import {
  CLEAN_CHECKPOINTS,
  FAULT_CHECKPOINT_KEYS,
  FAULT_DIRECTIONS,
  MALFORMED_KINDS,
  eventView,
  lowConfidenceAnalysis,
  malformedAnalysis,
  nullResultAnalysis,
  scoredAnalysis,
  snapshotOf,
  type MalformedKind,
} from '../harness/liveCourtAdversarial/doubles';
import {
  Evidence,
  heapSample,
  nowMs,
} from '../harness/liveCourtAdversarial/evidence';
import { SeededRng } from '../harness/liveCourtAdversarial/prng';
import { RecordingVoicePort } from '../harness/liveCourtAdversarial/voicePorts';

declare const process: { env: Record<string, string | undefined> };

const SCALE = Number(process.env.LIVE_COURT_HARNESS_EVENTS ?? 10_000);
const evidence = new Evidence('coach-stream');

type OutcomePlan =
  | { kind: 'scored'; score: number; faults: number }
  | { kind: 'low' }
  | { kind: 'null_result' }
  | { kind: 'abstained' };

function planOutcomes(rng: SeededRng, count: number): OutcomePlan[] {
  const plans: OutcomePlan[] = [];
  for (let index = 0; index < count; index += 1) {
    const roll = rng.next();
    if (roll < 0.7) {
      plans.push({
        kind: 'scored',
        score: Math.round(rng.float(3.0, 9.6) * 10) / 10,
        faults: rng.int(0, 2),
      });
    } else if (roll < 0.82) plans.push({ kind: 'low' });
    else if (roll < 0.88) plans.push({ kind: 'null_result' });
    else plans.push({ kind: 'abstained' });
  }
  return plans;
}

function terminalView(
  rng: SeededRng,
  index: number,
  plan: OutcomePlan,
): SessionEventView {
  const id = `analysis-E${index + 1}`;
  switch (plan.kind) {
    case 'scored': {
      const checkpoints = [...CLEAN_CHECKPOINTS];
      for (let f = 0; f < plan.faults; f += 1) {
        checkpoints.push({
          key: rng.pick(FAULT_CHECKPOINT_KEYS),
          score: rng.int(20, 60),
          direction: rng.pick(FAULT_DIRECTIONS),
          severity: Math.round(rng.float(0.3, 0.9) * 100) / 100,
        });
      }
      return eventView(index, {
        state: 'ready',
        analysis: scoredAnalysis(id, plan.score, checkpoints),
      });
    }
    case 'low':
      return eventView(index, {
        state: 'ready',
        analysis: lowConfidenceAnalysis(id),
      });
    case 'null_result':
      return eventView(index, {
        state: 'ready',
        analysis: nullResultAnalysis(id),
      });
    case 'abstained':
      return eventView(index, {
        state: 'abstained',
        abstainReason: 'POSE_TOO_SPARSE',
      });
  }
}

interface CueAudit {
  cueCount: number;
  eventCues: number;
  duplicateEventCues: number;
  missingEvents: string[];
  extraEvents: string[];
  orderInversions: number;
  categories: Record<string, number>;
  spoken: number;
  emptyTexts: number;
}

function auditCues(
  cues: readonly SpokenCue[],
  expectedEventIds: readonly string[],
): CueAudit {
  const seen = new Map<string, number>();
  const categories: Record<string, number> = {};
  let spoken = 0;
  let emptyTexts = 0;
  let inversions = 0;
  let lastIndex = -1;
  for (const cue of cues) {
    categories[cue.category] = (categories[cue.category] ?? 0) + 1;
    if (cue.spoken) spoken += 1;
    if (cue.text.trim().length === 0) emptyTexts += 1;
    if (cue.eventId === null) continue;
    seen.set(cue.eventId, (seen.get(cue.eventId) ?? 0) + 1);
    const index = Number(cue.eventId.slice(1)) - 1;
    if (index < lastIndex) inversions += 1;
    lastIndex = Math.max(lastIndex, index);
  }
  const expected = new Set(expectedEventIds);
  return {
    cueCount: cues.length,
    eventCues: cues.filter(c => c.eventId !== null).length,
    duplicateEventCues: [...seen.values()].filter(n => n > 1).length,
    missingEvents: expectedEventIds.filter(id => !seen.has(id)),
    extraEvents: [...seen.keys()].filter(id => !expected.has(id)),
    orderInversions: inversions,
    categories,
    spoken,
    emptyTexts,
  };
}

describe('LiveSessionCoach adversarial event stream', () => {
  it(`C1 rapid bulk: ${SCALE} terminal events in ONE snapshot → exactly one cue per event, in event order`, () => {
    const seed = 0x51c0de01;
    const rng = new SeededRng(seed);
    const plans = planOutcomes(rng, SCALE);
    const events = plans.map((plan, index) => terminalView(rng, index, plan));
    const port = new RecordingVoicePort();
    const coach = new LiveSessionCoach({ voice: port });
    const before = heapSample('C1 before');
    coach.sessionStarted('live');
    const t0 = nowMs();
    coach.consumeSnapshot(snapshotOf(events));
    const elapsedMs = nowMs() - t0;
    const after = heapSample('C1 after consume');
    const recap = coach.recap();
    const audit = auditCues(
      recap.cues,
      events.map(e => e.eventId),
    );
    evidence.writeJson('C1-rapid-bulk', {
      seed,
      scale: SCALE,
      elapsedMs,
      perEventUs: (elapsedMs * 1000) / SCALE,
      heap: {
        before,
        after,
        deltaHeapUsedMb: after.heapUsedMb - before.heapUsedMb,
      },
      audit,
      recapTopCorrection: recap.topCorrection,
      correctionsByCheckpoint: recap.correctionsByCheckpoint,
      portCalls: port.calls.length,
    });
    evidence.log(
      `C1 seed=${seed} events=${SCALE} elapsed=${elapsedMs.toFixed(1)}ms cues=${audit.cueCount}`,
    );
    expect(audit.eventCues).toBe(SCALE);
    expect(audit.duplicateEventCues).toBe(0);
    expect(audit.missingEvents).toEqual([]);
    expect(audit.extraEvents).toEqual([]);
    expect(audit.orderInversions).toBe(0);
    expect(audit.emptyTexts).toBe(0);
    expect(audit.spoken).toBe(SCALE + 1);
    expect(port.calls.length).toBe(SCALE + 1);
  });

  it(`C2 incremental full snapshots (real flow shape): ${SCALE} events, one growing snapshot per event → one cue each; cost table`, () => {
    const seed = 0x51c0de02;
    const rng = new SeededRng(seed);
    const plans = planOutcomes(rng, SCALE);
    const events = plans.map((plan, index) => terminalView(rng, index, plan));
    const port = new RecordingVoicePort();
    const coach = new LiveSessionCoach({ voice: port });
    const costTable: Array<{ eventsInSnapshot: number; snapshotMs: number }> =
      [];
    const before = heapSample('C2 before');
    const t0 = nowMs();
    for (let n = 1; n <= SCALE; n += 1) {
      const t = nowMs();
      coach.consumeSnapshot(snapshotOf(events.slice(0, n)));
      const dt = nowMs() - t;
      if (n % 1000 === 0 || n === 1)
        costTable.push({ eventsInSnapshot: n, snapshotMs: dt });
    }
    const elapsedMs = nowMs() - t0;
    const after = heapSample('C2 after');
    const audit = auditCues(
      coach.recap().cues,
      events.map(e => e.eventId),
    );
    evidence.writeJson('C2-incremental-snapshots', {
      seed,
      scale: SCALE,
      elapsedMs,
      costTable,
      heap: {
        before,
        after,
        deltaHeapUsedMb: after.heapUsedMb - before.heapUsedMb,
      },
      audit,
    });
    evidence.log(
      `C2 seed=${seed} elapsed=${elapsedMs.toFixed(1)}ms lastSnapshotMs=${costTable.at(-1)?.snapshotMs.toFixed(3)}`,
    );
    expect(audit.eventCues).toBe(SCALE);
    expect(audit.duplicateEventCues).toBe(0);
    expect(audit.missingEvents).toEqual([]);
    expect(audit.orderInversions).toBe(0);
  });

  it(`C3 duplicate delivery: every snapshot ×3 and every event twice inside the array → still one cue per event`, () => {
    const seed = 0x51c0de03;
    const rng = new SeededRng(seed);
    const count = Math.max(1000, Math.floor(SCALE / 4));
    const plans = planOutcomes(rng, count);
    const events = plans.map((plan, index) => terminalView(rng, index, plan));
    const port = new RecordingVoicePort();
    const coach = new LiveSessionCoach({ voice: port });
    let deliveries = 0;
    const batch = 50;
    for (let start = 0; start < count; start += batch) {
      const slice = events.slice(0, start + batch);
      const doubled = slice.flatMap(e => [e, { ...e }]);
      for (let repeat = 0; repeat < 3; repeat += 1) {
        coach.consumeSnapshot(snapshotOf(doubled));
        deliveries += 1;
      }
    }
    const audit = auditCues(
      coach.recap().cues,
      events.map(e => e.eventId),
    );
    evidence.writeJson('C3-duplicate-delivery', {
      seed,
      count,
      deliveries,
      audit,
    });
    expect(audit.eventCues).toBe(count);
    expect(audit.duplicateEventCues).toBe(0);
    expect(audit.missingEvents).toEqual([]);
  });

  it('C4 out-of-order resolution: events turn terminal in shuffled order and arrive in shuffled array order → one cue each; order metric recorded', () => {
    const seed = 0x51c0de04;
    const rng = new SeededRng(seed);
    const count = Math.max(1000, Math.floor(SCALE / 4));
    const plans = planOutcomes(rng, count);
    const terminal = plans.map((plan, index) => terminalView(rng, index, plan));
    const resolutionOrder = rng.shuffle(terminal.map((_, i) => i));
    const resolved = new Set<number>();
    const port = new RecordingVoicePort();
    const coach = new LiveSessionCoach({ voice: port });
    const step = 25;
    for (let cursor = 0; cursor < resolutionOrder.length; cursor += step) {
      for (const index of resolutionOrder.slice(cursor, cursor + step))
        resolved.add(index);
      // Snapshot events: pending unless resolved; array order shuffled too.
      const views = terminal.map((view, index) =>
        resolved.has(index) ? view : eventView(index, { state: 'processing' }),
      );
      coach.consumeSnapshot(snapshotOf(rng.shuffle([...views])));
    }
    const audit = auditCues(
      coach.recap().cues,
      terminal.map(e => e.eventId),
    );
    // Resolution order is what the coach must follow: it cannot speak about
    // an event whose analysis has not landed. Compare cue order to the order
    // events RESOLVED (not to index order).
    const firstResolvedBatch = new Map<number, number>();
    resolutionOrder.forEach((index, position) =>
      firstResolvedBatch.set(index, Math.floor(position / step)),
    );
    let resolutionViolations = 0;
    let lastBatch = -1;
    for (const cue of coach.recap().cues) {
      if (cue.eventId === null) continue;
      const batch =
        firstResolvedBatch.get(Number(cue.eventId.slice(1)) - 1) ?? -1;
      if (batch < lastBatch) resolutionViolations += 1;
      lastBatch = Math.max(lastBatch, batch);
    }
    evidence.writeJson('C4-out-of-order', {
      seed,
      count,
      audit,
      resolutionViolations,
      note: 'orderInversions counts cues spoken for a LOWER event index after a higher one; with shuffled resolution this is expected. resolutionViolations counts cues spoken before the event resolved — must be 0.',
    });
    expect(audit.eventCues).toBe(count);
    expect(audit.duplicateEventCues).toBe(0);
    expect(audit.missingEvents).toEqual([]);
    expect(resolutionViolations).toBe(0);
  });

  it('C5 malformed analysis records: matrix of how the coach copes (recorded, asserted where contract is explicit)', () => {
    const matrix: Array<{
      kind: MalformedKind;
      threw: string | null;
      cueForMalformed: { category: string; text: string } | null;
      followingEventCuedInSameSnapshot: boolean;
      followingEventCuedInNextSnapshot: boolean;
      malformedEventEverCued: boolean;
      cueTextContainsNonFinite: boolean;
    }> = [];
    for (const kind of MALFORMED_KINDS) {
      const port = new RecordingVoicePort();
      const coach = new LiveSessionCoach({ voice: port });
      const good0 = eventView(0, {
        state: 'ready',
        analysis: scoredAnalysis('a-E1', 6.4, CLEAN_CHECKPOINTS),
      });
      const bad = eventView(1, {
        state: 'ready',
        analysis: malformedAnalysis('a-E2', kind),
      });
      const good2 = eventView(2, {
        state: 'ready',
        analysis: scoredAnalysis('a-E3', 7.1, CLEAN_CHECKPOINTS),
      });
      let threw: string | null = null;
      try {
        coach.consumeSnapshot(snapshotOf([good0, bad, good2]));
      } catch (error) {
        threw =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
      }
      const afterFirst = coach.recap().cues;
      const followingSame = afterFirst.some(c => c.eventId === 'E3');
      // A second delivery (the flow re-notifies on every state change).
      let threwAgain: string | null = null;
      try {
        coach.consumeSnapshot(snapshotOf([good0, bad, good2]));
      } catch (error) {
        threwAgain = error instanceof Error ? error.message : String(error);
      }
      const cues = coach.recap().cues;
      const malformedCue = cues.find(c => c.eventId === 'E2') ?? null;
      matrix.push({
        kind,
        threw: threw ?? (threwAgain ? `second delivery: ${threwAgain}` : null),
        cueForMalformed: malformedCue
          ? { category: malformedCue.category, text: malformedCue.text }
          : null,
        followingEventCuedInSameSnapshot: followingSame,
        followingEventCuedInNextSnapshot: cues.some(c => c.eventId === 'E3'),
        malformedEventEverCued: malformedCue !== null,
        cueTextContainsNonFinite: malformedCue
          ? /NaN|Infinity/.test(malformedCue.text)
          : false,
      });
    }
    evidence.writeJson('C5-malformed-matrix', matrix);
    for (const row of matrix)
      evidence.log(
        `C5 ${row.kind} threw=${row.threw ?? 'no'} cue=${row.cueForMalformed?.text ?? 'none'}`,
      );
    // Explicit contract: a good event must never be starved of its cue for
    // good — after re-delivery every well-formed event has spoken.
    for (const row of matrix)
      expect(row.followingEventCuedInNextSnapshot).toBe(true);
    // Recorded (not asserted): thrown kinds and non-finite spoken text. The
    // table is the finding surface; see the harness report.
  });

  it('C6 pause/resume/stop at the coach layer: mute mid-stream, unmute, dispose → captions continue muted, nothing after dispose', () => {
    const seed = 0x51c0de06;
    const rng = new SeededRng(seed);
    const count = 3000;
    const plans = planOutcomes(rng, count);
    const events = plans.map((plan, index) => terminalView(rng, index, plan));
    const port = new RecordingVoicePort();
    const seenCues: SpokenCue[] = [];
    const coach = new LiveSessionCoach({
      voice: port,
      onCue: cue => seenCues.push(cue),
    });
    coach.sessionStarted('live');
    const phases: Array<{ phase: string; from: number; to: number }> = [
      { phase: 'speaking', from: 0, to: 1000 },
      { phase: 'muted', from: 1000, to: 2000 },
      { phase: 'speaking', from: 2000, to: 2500 },
      { phase: 'disposed', from: 2500, to: 3000 },
    ];
    const results: Array<{
      phase: string;
      cuesLogged: number;
      cuesSpoken: number;
      portCalls: number;
    }> = [];
    for (const { phase, from, to } of phases) {
      if (phase === 'muted') coach.setMuted(true);
      if (phase === 'speaking' && from > 0) coach.setMuted(false);
      if (phase === 'disposed') coach.dispose();
      const cuesBefore = coach.recap().cues.length;
      const portBefore = port.calls.length;
      for (let n = from + 1; n <= to; n += 1)
        coach.consumeSnapshot(snapshotOf(events.slice(0, n)));
      const cuesNow = coach.recap().cues.slice(cuesBefore);
      results.push({
        phase,
        cuesLogged: cuesNow.length,
        cuesSpoken: cuesNow.filter(c => c.spoken).length,
        portCalls: port.calls.length - portBefore,
      });
    }
    evidence.writeJson('C6-mute-resume-dispose', {
      seed,
      count,
      results,
      stopCalls: port.stopCalls,
    });
    expect(results[0]).toEqual({
      phase: 'speaking',
      cuesLogged: 1000,
      cuesSpoken: 1000,
      portCalls: 1000,
    });
    expect(results[1]).toEqual({
      phase: 'muted',
      cuesLogged: 1000,
      cuesSpoken: 0,
      portCalls: 0,
    });
    expect(results[2]).toEqual({
      phase: 'speaking',
      cuesLogged: 500,
      cuesSpoken: 500,
      portCalls: 500,
    });
    expect(results[3]).toEqual({
      phase: 'disposed',
      cuesLogged: 0,
      cuesSpoken: 0,
      portCalls: 0,
    });
    expect(port.stopCalls).toBe(2); // mute + dispose
    expect(seenCues.length).toBe(coach.recap().cues.length);
  });

  it('C7 stop → recap: sessionEnded speaks once, registers the recap, and late events after end are silent', () => {
    const seed = 0x51c0de07;
    const rng = new SeededRng(seed);
    const count = 2000;
    const plans = planOutcomes(rng, count);
    const events = plans.map((plan, index) => terminalView(rng, index, plan));
    const port = new RecordingVoicePort();
    const coach = new LiveSessionCoach({ voice: port });
    coach.sessionStarted('live');
    const half = events.slice(0, count / 2);
    coach.consumeSnapshot(snapshotOf(half));
    const finalSnapshot = snapshotOf(half, {
      phase: 'ended',
      sessionId: `adv-stop-${seed}`,
    });
    const recap1 = coach.sessionEnded(finalSnapshot);
    const recap2 = coach.sessionEnded(finalSnapshot);
    coach.consumeSnapshot(
      snapshotOf(events, { phase: 'ended', sessionId: `adv-stop-${seed}` }),
    );
    const endCues = coach
      .recap()
      .cues.filter(c => c.category === 'SESSION_END');
    evidence.writeJson('C7-stop-recap', {
      seed,
      count,
      endCueText: endCues[0]?.text,
      endCues: endCues.length,
      cuesAfterEnd: coach.recap().cues.length - recap1.cues.length,
      registered: getCompletedCoachRecap(`adv-stop-${seed}`) !== null,
      recapEqual: JSON.stringify(recap1) === JSON.stringify(recap2),
    });
    expect(endCues).toHaveLength(1);
    expect(coach.recap().cues.length).toBe(recap1.cues.length);
    expect(getCompletedCoachRecap(`adv-stop-${seed}`)).toEqual(recap1);
  });

  it('C8 voice port that throws mid-stream: what the coach loses (recorded)', () => {
    const port = new RecordingVoicePort({ throwOnCall: 3 });
    const coach = new LiveSessionCoach({ voice: port });
    const events = [0, 1, 2, 3, 4].map(index =>
      eventView(index, {
        state: 'ready',
        analysis: scoredAnalysis(
          `t-E${index + 1}`,
          6 + index * 0.3,
          CLEAN_CHECKPOINTS,
        ),
      }),
    );
    let threw: string | null = null;
    try {
      coach.consumeSnapshot(snapshotOf(events));
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    const afterThrow = coach.recap().cues.map(c => c.eventId);
    coach.consumeSnapshot(snapshotOf(events));
    const afterRedelivery = coach.recap().cues.map(c => c.eventId);
    const lostForever = events
      .map(e => e.eventId)
      .filter(id => !afterRedelivery.includes(id));
    evidence.writeJson('C8-throwing-port', {
      threw,
      afterThrow,
      afterRedelivery,
      lostForever,
    });
    evidence.log(
      `C8 threw=${threw} lostForever=${JSON.stringify(lostForever)}`,
    );
    // Recorded behaviour: the event whose speak() threw was marked consumed
    // BEFORE the cue was logged, so its cue (and HUD caption) never appears.
    expect(threw).not.toBeNull();
    expect(
      afterRedelivery.filter(id => id !== null).length + lostForever.length,
    ).toBe(events.length);
  });

  it('C9 memory growth: coach recap registry across many sessions (module-level Map is never evicted)', () => {
    const sessions = 400;
    const eventsPerSession = 25;
    const samples: Array<{ sessions: number; heapUsedMb: number }> = [];
    const base = heapSample('C9 start');
    samples.push({ sessions: 0, heapUsedMb: base.heapUsedMb });
    for (let s = 1; s <= sessions; s += 1) {
      const rng = new SeededRng(0x51c0de09 + s);
      const plans = planOutcomes(rng, eventsPerSession);
      const events = plans.map((plan, index) => terminalView(rng, index, plan));
      const coach = new LiveSessionCoach({ voice: new RecordingVoicePort() });
      coach.sessionStarted('live');
      const snapshot = snapshotOf(events, {
        sessionId: `adv-registry-${s}`,
        phase: 'ended',
      });
      coach.consumeSnapshot(snapshot);
      coach.sessionEnded(snapshot);
      if (s % 100 === 0)
        samples.push({
          sessions: s,
          heapUsedMb: heapSample(`C9 ${s}`).heapUsedMb,
        });
    }
    const first = samples[0];
    const last = samples[samples.length - 1];
    const growthMb = first && last ? last.heapUsedMb - first.heapUsedMb : 0;
    const perSessionKb = (growthMb * 1024) / sessions;
    const analysisRecordDouble: AnalysisRecord = scoredAnalysis(
      'size-probe',
      6.4,
      CLEAN_CHECKPOINTS,
    );
    evidence.writeJson('C9-recap-registry-growth', {
      sessions,
      eventsPerSession,
      gcForced: base.gcForced,
      samples,
      growthMb,
      perSessionKb,
      retainedRecapPresent: getCompletedCoachRecap('adv-registry-1') !== null,
      probeRecordBytes: JSON.stringify(analysisRecordDouble).length,
    });
    evidence.log(
      `C9 sessions=${sessions} growth=${growthMb.toFixed(3)}MB perSession=${perSessionKb.toFixed(2)}KB gc=${base.gcForced}`,
    );
    expect(getCompletedCoachRecap('adv-registry-1')).not.toBeNull();
    expect(getCompletedCoachRecap(`adv-registry-${sessions}`)).not.toBeNull();
  });
});
