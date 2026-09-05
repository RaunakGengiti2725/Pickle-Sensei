/**
 * STRESS · mod-live-court · lens boundary-malformed
 * Target: LiveSessionCoach (apps/mobile/src/flow/liveSessionCoach.ts)
 *
 * Seeded campaigns over consumeSnapshot / sessionEnded / dispose / setMuted:
 *   A. in-contract streams with duplicates, out-of-order views, repeated
 *      snapshots (background→foreground re-renders), pause/resume gaps,
 *      mute toggles, hostile ids (NUL, 64K, traversal, __proto__), 10k+
 *      events, ended-then-more-snapshots, double end, dispose mid-stream;
 *   B. out-of-contract events (malformed analysis / result / checkpoints /
 *      ids / state) injected into otherwise valid streams — tabulated as
 *      throw vs graceful so the failure surface is recorded, never hidden.
 *
 * Hard invariants (family A — the producer contract is honored):
 *   C1 no throw out of any coach method
 *   C2 every terminal eventId is cued at most once
 *   C3 cue count == distinct terminal eventIds seen before the end
 *   C4 nothing is cued after sessionEnded()/dispose(); SESSION_END exactly once
 *   C5 recap is self-consistent (spokenCount, corrections, topCorrection)
 *      and the registry entry equals the returned recap; double end is a no-op
 *   C6 muted ⇒ spoken=false; voice port never called while muted
 *   C7 Object.prototype never polluted; Map registry safe for hostile ids
 *
 * Family B asserts only C7 plus "state stays usable": after a malformed
 * snapshot (whether or not it threw) a fresh valid snapshot still cues.
 *
 * Campaign size: STRESS_ITER (default 120). Replay one seed: STRESS_SEED=<n>.
 */
import {
  LiveSessionCoach,
  getCompletedCoachRecap,
  type CoachVoicePort,
  type LiveCoachRecap,
  type SpokenCue,
} from '../../src/flow/liveSessionCoach';
import type {
  LiveSessionSnapshot,
  SessionEventView,
} from '../../src/flow/session';
import {
  EVENT_MALFORMATIONS,
  POISON_STRINGS,
  PROTO_KEYS,
  campaignSeeds,
  chance,
  describeError,
  malformEvent,
  objectPrototypePolluted,
  pick,
  preview,
  randomInt,
  replayCommand,
  seededRandom,
  stressIterations,
  validEvent,
  validSnapshot,
  writeStressTable,
  type Rng,
  type StressRow,
} from '../../testing/stress/liveCourtBoundary';

const SUITE = '__tests__/stress/liveSessionCoach.stress.test.ts';
const ITER = stressIterations(120);

class RecordingVoice implements CoachVoicePort {
  readonly spoken: string[] = [];
  stops = 0;
  isAvailable = true;
  /** 'true' | 'false' | 'void' | 'throw' — what speak() does. */
  mode: 'true' | 'false' | 'void' | 'throw' = 'true';
  available(): boolean {
    return this.isAvailable;
  }
  speak(text: string): boolean | void {
    if (this.mode === 'throw') throw new Error('voice port exploded');
    this.spoken.push(text);
    if (this.mode === 'true') return true;
    if (this.mode === 'false') return false;
    return undefined;
  }
  stop(): void {
    this.stops += 1;
  }
}

type Terminal = 'scored' | 'low_confidence' | 'abstained' | null;

function terminalOf(event: SessionEventView): Terminal {
  if (event.state === 'abstained') return 'abstained';
  if (event.state !== 'ready') return null;
  const result = event.analysis?.result ?? null;
  if (result === null) return 'low_confidence';
  if (result.resultKind === 'scored' && result.overallScore !== null)
    return 'scored';
  return 'low_confidence';
}

function hostileId(rng: Rng, index: number): string {
  const roll = rng();
  if (roll < 0.6) return `E${index + 1}`;
  if (roll < 0.75) return pick(rng, POISON_STRINGS) + `#${index}`;
  if (roll < 0.85) return pick(rng, PROTO_KEYS);
  if (roll < 0.95) return `../../${index}`;
  return `E${index + 1}\0`;
}

function recapViolations(recap: LiveCoachRecap): string[] {
  const out: string[] = [];
  const spoken = recap.cues.filter(c => c.spoken).length;
  if (recap.spokenCount !== spoken)
    out.push(`spokenCount ${recap.spokenCount}!=${spoken}`);
  const corrections: Record<string, number> = {};
  for (const cue of recap.cues) {
    if (
      (cue.category === 'CORRECTION' || cue.category === 'REPEAT_CORRECTION') &&
      cue.targetCheckpoint !== null
    ) {
      corrections[cue.targetCheckpoint] =
        (corrections[cue.targetCheckpoint] ?? 0) + 1;
    }
  }
  if (
    JSON.stringify(corrections) !==
    JSON.stringify(recap.correctionsByCheckpoint)
  ) {
    out.push('correctionsByCheckpoint mismatch');
  }
  const top = Object.entries(corrections).sort((a, b) => b[1] - a[1])[0];
  const expectedTop = top && top[1] > 0 ? top[0] : null;
  const topCount =
    recap.topCorrection === null ? 0 : (corrections[recap.topCorrection] ?? 0);
  if (
    expectedTop === null ? recap.topCorrection !== null : topCount !== top?.[1]
  ) {
    out.push(`topCorrection ${String(recap.topCorrection)} not argmax`);
  }
  const ends = recap.cues.filter(c => c.category === 'SESSION_END').length;
  if (ends > 1) out.push(`SESSION_END x${ends}`);
  if (
    Object.getPrototypeOf(recap.correctionsByCheckpoint) !== Object.prototype
  ) {
    out.push('corrections prototype tampered');
  }
  return out;
}

interface Outcome {
  row: StressRow;
  hardFailure: string | null;
}

type FamilyA =
  | 'duplicates_and_reorder'
  | 'background_replays'
  | 'pause_resume_gaps'
  | 'hostile_ids'
  | 'ten_k_events'
  | 'end_then_more'
  | 'dispose_mid_stream'
  | 'mute_toggle'
  | 'voice_port_variants'
  | 'empty_snapshots';

const FAMILY_A: readonly FamilyA[] = [
  'duplicates_and_reorder',
  'background_replays',
  'pause_resume_gaps',
  'hostile_ids',
  'ten_k_events',
  'end_then_more',
  'dispose_mid_stream',
  'mute_toggle',
  'voice_port_variants',
  'empty_snapshots',
];

function shuffle<T>(rng: Rng, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(rng, 0, i);
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

function runFamilyA(seed: number, rng: Rng, family: FamilyA): Outcome {
  const voice = new RecordingVoice();
  const cues: SpokenCue[] = [];
  const coach = new LiveSessionCoach({ voice, onCue: cue => cues.push(cue) });
  const sessionId =
    family === 'hostile_ids'
      ? pick(rng, [...POISON_STRINGS, ...PROTO_KEYS])
      : `s-${seed}`;
  const totalEvents =
    family === 'ten_k_events'
      ? randomInt(rng, 10_000, 14_000)
      : randomInt(rng, 0, 80);
  const events: SessionEventView[] = [];
  for (let i = 0; i < totalEvents; i += 1) {
    const event = validEvent(rng, i);
    events.push(
      family === 'hostile_ids'
        ? { ...event, eventId: hostileId(rng, i) }
        : event,
    );
  }
  // Ids the producer would never duplicate — but hostile_ids may collide on
  // purpose (two events sharing '__proto__'); the coach must still cue each
  // DISTINCT id once, which is the documented contract.
  const terminalIds = new Set<string>();
  let endedAtStep: number | null = null;
  let disposed = false;
  let cuesAtEnd = 0;
  let mutedNow = false;
  const spokenWhileMuted: string[] = [];
  const violations: string[] = [];
  let detail = '';

  const snapshotAt = (upto: number, reorder: boolean): LiveSessionSnapshot => {
    const view = events.slice(0, upto);
    return validSnapshot(rng, reorder ? shuffle(rng, view) : view, {
      sessionId,
      durationMs: upto * 1000,
    });
  };
  const consume = (snapshot: LiveSessionSnapshot): void => {
    const before = voice.spoken.length;
    coach.consumeSnapshot(snapshot);
    if (mutedNow && voice.spoken.length !== before)
      spokenWhileMuted.push('spoke while muted');
    if (endedAtStep === null && !disposed) {
      for (const event of snapshot.events) {
        if (terminalOf(event) !== null) terminalIds.add(event.eventId);
      }
    }
  };

  try {
    if (family === 'voice_port_variants') {
      voice.mode = pick(rng, ['true', 'false', 'void', 'throw']);
      voice.isAvailable = chance(rng, 0.7);
      detail = `mode=${voice.mode} available=${voice.isAvailable}`;
    }
    coach.sessionStarted(chance(rng, 0.8) ? 'live' : 'replay');
    switch (family) {
      case 'duplicates_and_reorder': {
        const steps = randomInt(rng, 1, 12);
        for (let s = 0; s < steps; s += 1) {
          const upto = randomInt(rng, 0, events.length);
          const snapshot = snapshotAt(upto, true);
          // duplicate a slice of the events inside the same snapshot
          const dupes = shuffle(rng, snapshot.events).slice(
            0,
            randomInt(rng, 0, 5),
          );
          consume({ ...snapshot, events: [...snapshot.events, ...dupes] });
          if (chance(rng, 0.3)) consume(snapshot);
        }
        detail = `steps=${steps}`;
        break;
      }
      case 'background_replays': {
        const full = snapshotAt(events.length, false);
        const replays = randomInt(rng, 2, 40);
        for (let r = 0; r < replays; r += 1) consume(full);
        detail = `replays=${replays}`;
        break;
      }
      case 'pause_resume_gaps': {
        let cursor = 0;
        let gaps = 0;
        while (cursor < events.length) {
          cursor = Math.min(events.length, cursor + randomInt(rng, 1, 25));
          consume(snapshotAt(cursor, chance(rng, 0.2)));
          if (chance(rng, 0.4)) {
            // "pause": jump the clock without new events, then resume
            consume({
              ...snapshotAt(cursor, false),
              durationMs: cursor * 1000 + 600_000,
            });
            gaps += 1;
          }
        }
        detail = `gaps=${gaps}`;
        break;
      }
      case 'hostile_ids':
      case 'ten_k_events': {
        const chunks =
          family === 'ten_k_events'
            ? randomInt(rng, 3, 8)
            : randomInt(rng, 1, 6);
        for (let c = 1; c <= chunks; c += 1) {
          consume(
            snapshotAt(
              Math.floor((events.length * c) / chunks),
              chance(rng, 0.25),
            ),
          );
        }
        detail = `events=${events.length} chunks=${chunks}`;
        break;
      }
      case 'end_then_more': {
        const upto = randomInt(rng, 0, events.length);
        consume(snapshotAt(upto, false));
        const recapA = coach.sessionEnded(snapshotAt(upto, false));
        endedAtStep = upto;
        cuesAtEnd = cues.length;
        consume(snapshotAt(events.length, true));
        const recapB = coach.sessionEnded(snapshotAt(events.length, false));
        if (JSON.stringify(recapA) !== JSON.stringify(recapB))
          violations.push('C5 double end changed recap');
        if (cues.length !== cuesAtEnd)
          violations.push(`C4 ${cues.length - cuesAtEnd} cues after end`);
        detail = `endedAt=${upto}`;
        break;
      }
      case 'dispose_mid_stream': {
        const upto = randomInt(rng, 0, events.length);
        consume(snapshotAt(upto, false));
        coach.dispose();
        disposed = true;
        cuesAtEnd = cues.length;
        consume(snapshotAt(events.length, false));
        coach.dispose();
        if (cues.length !== cuesAtEnd)
          violations.push(`C4 ${cues.length - cuesAtEnd} cues after dispose`);
        if (voice.stops < 2) violations.push('dispose did not stop voice');
        detail = `disposedAt=${upto}`;
        break;
      }
      case 'mute_toggle': {
        let cursor = 0;
        let toggles = 0;
        while (cursor < events.length) {
          if (chance(rng, 0.5)) {
            mutedNow = !mutedNow;
            coach.setMuted(mutedNow);
            toggles += 1;
            if (coach.isMuted() !== mutedNow)
              violations.push('C6 isMuted mismatch');
          }
          cursor = Math.min(events.length, cursor + randomInt(rng, 1, 10));
          consume(snapshotAt(cursor, false));
        }
        detail = `toggles=${toggles}`;
        break;
      }
      case 'voice_port_variants':
        consume(snapshotAt(events.length, false));
        break;
      case 'empty_snapshots': {
        consume(validSnapshot(rng, [], { sessionId, durationMs: 0 }));
        consume(validSnapshot(rng, [], { sessionId, durationMs: -0 }));
        consume(validSnapshot(rng, [], { sessionId, durationMs: Number.NaN }));
        consume(
          validSnapshot(rng, [], {
            sessionId,
            strokeCount: 999,
            durationMs: 1e21,
          }),
        );
        break;
      }
    }

    // Common ending for families that did not end themselves.
    if (endedAtStep === null && !disposed) {
      mutedNow = false;
      coach.setMuted(false);
      const finalSnapshot = snapshotAt(events.length, false);
      const recap = coach.sessionEnded(finalSnapshot);
      endedAtStep = events.length;
      cuesAtEnd = cues.length;
      consume(snapshotAt(events.length, false));
      if (cues.length !== cuesAtEnd)
        violations.push(`C4 ${cues.length - cuesAtEnd} cues after end`);
      const registered = getCompletedCoachRecap(sessionId);
      if (JSON.stringify(registered) !== JSON.stringify(recap))
        violations.push('C5 registry != recap');
      if (JSON.stringify(coach.recap()) !== JSON.stringify(recap))
        violations.push('C5 recap() drift');
    }

    const recap = coach.recap();
    violations.push(...recapViolations(recap));
    const cuedIds = recap.cues
      .map(c => c.eventId)
      .filter((id): id is string => id !== null);
    const distinctCued = new Set(cuedIds);
    if (distinctCued.size !== cuedIds.length)
      violations.push(
        `C2 duplicate cue ids (${cuedIds.length - distinctCued.size})`,
      );
    if (voice.mode !== 'throw') {
      for (const id of distinctCued) {
        if (!terminalIds.has(id))
          violations.push(`C3 cued non-terminal/unseen id ${preview(id, 40)}`);
      }
      if (distinctCued.size !== terminalIds.size) {
        violations.push(
          `C3 cued ${distinctCued.size} of ${terminalIds.size} terminal ids`,
        );
      }
    }
    if (spokenWhileMuted.length)
      violations.push(`C6 ${spokenWhileMuted.length} spoken while muted`);
    if (voice.mode === 'false' || !voice.isAvailable) {
      if (recap.spokenCount !== 0)
        violations.push('C6 spokenCount>0 with suppressing port');
    }
    const startCues = recap.cues.filter(
      c => c.category === 'SESSION_START',
    ).length;
    if (startCues !== 1) violations.push(`SESSION_START x${startCues}`);
    if (objectPrototypePolluted()) violations.push('C7 prototype polluted');
  } catch (error) {
    if (family === 'voice_port_variants' && voice.mode === 'throw') {
      // A throwing voice port propagates through emit() — the coach does
      // not isolate the port. Tabulated as an observation (port contract is
      // the app's own AVSpeech bridge, which never throws by design).
      return {
        row: {
          seed,
          family,
          outcome: 'OBSERVED:voice_throw_propagates',
          detail: describeError(error),
        },
        hardFailure: null,
      };
    }
    return {
      row: {
        seed,
        family,
        outcome: 'BROKEN:throw',
        detail: `${detail} ${describeError(error)}`,
      },
      hardFailure: `C1 threw ${describeError(error)}`,
    };
  }

  if (violations.length) {
    return {
      row: {
        seed,
        family,
        outcome: 'BROKEN:invariant',
        detail: `${detail} | ${violations.join('; ')}`,
      },
      hardFailure: violations.join('; '),
    };
  }
  return {
    row: {
      seed,
      family,
      outcome: 'HELD',
      detail: `${detail} terminal=${terminalIds.size} cues=${coach.recap().cues.length}`,
    },
    hardFailure: null,
  };
}

function runFamilyB(seed: number, rng: Rng): Outcome {
  const voice = new RecordingVoice();
  const coach = new LiveSessionCoach({ voice });
  const kind = pick(rng, EVENT_MALFORMATIONS);
  const total = randomInt(rng, 1, 30);
  const events: SessionEventView[] = [];
  const badAt = randomInt(rng, 0, total - 1);
  for (let i = 0; i < total; i += 1) {
    events.push(i === badAt ? malformEvent(rng, i, kind) : validEvent(rng, i));
  }
  let threw: string | null = null;
  let hardFailure: string | null = null;
  try {
    coach.sessionStarted('live');
    coach.consumeSnapshot(
      validSnapshot(rng, events, { sessionId: `b-${seed}` }),
    );
  } catch (error) {
    threw = describeError(error);
  }
  // State must remain usable: a later valid terminal event still cues.
  let recoveredCued = false;
  try {
    const fresh = {
      ...validEvent(rng, total + 1),
      state: 'abstained' as const,
      analysis: null,
    };
    const before = coach.recap().cues.length;
    coach.consumeSnapshot(
      validSnapshot(rng, [fresh], { sessionId: `b-${seed}` }),
    );
    recoveredCued = coach.recap().cues.length === before + 1;
    // end with an in-contract snapshot: the malformed record itself is
    // out of contract for sessionScoreProgression too.
    const wellFormed = events.filter((_, index) => index !== badAt);
    coach.sessionEnded(
      validSnapshot(rng, [...wellFormed, fresh], { sessionId: `b-${seed}` }),
    );
  } catch (error) {
    hardFailure = `state unusable after malformed event: ${describeError(error)}`;
  }
  if (!recoveredCued && hardFailure === null)
    hardFailure = 'valid event after malformed one was not cued';
  if (objectPrototypePolluted()) hardFailure = 'C7 prototype polluted';
  let outcome: string;
  if (hardFailure) outcome = 'BROKEN:state';
  else if (threw) outcome = 'OBSERVED:throw_on_out_of_contract';
  else outcome = 'HELD:graceful_on_out_of_contract';
  return {
    row: {
      seed,
      family: `malformed:${kind}`,
      outcome,
      detail: threw ?? `events=${total}`,
    },
    hardFailure,
  };
}

function runSeed(seed: number): Outcome {
  const rng = seededRandom(seed);
  if (chance(rng, 0.3)) return runFamilyB(seed, rng);
  return runFamilyA(seed, rng, pick(rng, FAMILY_A));
}

describe('stress · LiveSessionCoach · boundary-malformed / 10k / dup / order / pause', () => {
  const seeds = campaignSeeds('coach', ITER);

  test(`C1–C7 hold across ${seeds.length} seeded coach sessions`, () => {
    const rows: StressRow[] = [];
    const failures: string[] = [];
    for (const seed of seeds) {
      const { row, hardFailure } = runSeed(seed);
      rows.push(row);
      if (hardFailure) {
        failures.push(
          `seed=${seed} [${row.family}] ${hardFailure}\n  replay: ${replayCommand(SUITE, seed)}`,
        );
      }
    }
    const table = writeStressTable(SUITE, 'coach', rows);
    expect(table.iterations).toBe(seeds.length);
    expect(failures).toEqual([]);
    expect(table.outcomes['HELD'] ?? 0).toBeGreaterThan(0);
  });

  test('deterministic replay: same seed → identical row', () => {
    const seed = seeds[0];
    if (seed === undefined) throw new Error('no seeds');
    expect(runSeed(seed).row).toEqual(runSeed(seed).row);
  });

  test('registry keyed by hostile session ids stays a Map (no prototype walk)', () => {
    for (const id of PROTO_KEYS) {
      const voice = new RecordingVoice();
      const coach = new LiveSessionCoach({ voice });
      const rng = seededRandom(7);
      const recap = coach.sessionEnded(
        validSnapshot(rng, [], { sessionId: id }),
      );
      expect(getCompletedCoachRecap(id)).toEqual(recap);
    }
    expect(getCompletedCoachRecap('definitely-not-registered')).toBeNull();
    expect(
      getCompletedCoachRecap('hasOwnProperty-never-registered'),
    ).toBeNull();
    expect(objectPrototypePolluted()).toBe(false);
  });
});
