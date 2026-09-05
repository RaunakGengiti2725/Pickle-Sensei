/**
 * STRESS · failure-injection · LiveSessionFlow + LiveSessionCoach end to end
 * (src/flow/session.ts driving src/flow/liveSessionCoach.ts and
 * src/flow/liveSessionSummary.ts) over the REAL SessionEventEngine.
 *
 * The recorded dev rally (DEV_REPLAY_RALLY, 114 wrist-speed samples → 3
 * stroke events) is streamed LOOPS times with a time offset, so every seed
 * pushes ~114×LOOPS motion samples and closes ~3×LOOPS real events.
 *
 * Injected per event (keyed by emission order E1, E2, …):
 *   vision provider (SessionEventAnalysisProvider)
 *     availability → unavailable | throw | garbage
 *     analyzeEvent → throw | reject | timeout(90s) | slow(5s) | never |
 *                    malformed outcome | partial outcome
 *   camera clip source (SessionEventClipSource.extract)
 *     → throw | reject | timeout | slow | never | malformed | partial
 *   onUpdate subscriber → throw
 *   TTS voice port → speak false / throw (through the coach)
 * Injected on the sample stream:
 *   duplicate samples, out-of-order (late) samples, NaN / negative / huge
 *   samples, pause/resume gaps (app background: 30s–10min of silence), a
 *   late pushSample after end() (must throw by contract, never corrupt).
 *
 * Invariants (after 60s of fake time per loop and a final 90s drain):
 *   F1 pushSample never throws while running; throws after end().
 *   F2 no infinite spinner: an event still 'processing' after the drain is
 *      allowed ONLY if its own fault was a never-resolving dependency.
 *   F3 no fake success: 'ready' ⇒ analysis object with a result field;
 *      an event whose provider threw/rejected/returned garbage is never
 *      'ready'; pending events carry a non-empty pendingReason.
 *   F4 snapshot integrity: strokeCount === events.length, indices are
 *      0..n-1 in order, ids unique, durationMs finite & monotonic,
 *      onUpdateFailures === injected onUpdate throws.
 *   F5 persisted state: getCompletedSession() equals the live snapshot after
 *      end(); terminal events never change state afterwards; the summary
 *      record round-trips through parseLiveSessionSummaryRecord unchanged.
 *   F6 replayable: same seed ⇒ same canonical event-state table.
 *
 * Scale: STRESS_ITER seeds (default 4) × LOOPS (STRESS_LOOPS, default 50)
 *        ≈ 600 events / 22 800 samples by default;
 *        STRESS_ITER=4 STRESS_LOOPS=850 ≈ 10 200 events.
 * Output: artifacts/stress/live-court/liveSessionFlowFaults.json
 */
import type { CapturedClip } from '../../src/camera/capture';
import { LiveSessionCoach } from '../../src/flow/liveSessionCoach';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
} from '../../src/flow/liveSessionSummary';
import { sessionScoreProgression } from '../../src/flow/sessionProgress';
import {
  DEV_REPLAY_RALLY,
  LiveSessionFlow,
  getCompletedSession,
  type LiveSessionSnapshot,
  type SessionEventAnalysisOutcome,
  type SessionEventAnalysisProvider,
  type SessionEventClipExtraction,
  type SessionEventClipSource,
  type SessionMotionSample,
} from '../../src/flow/session';
import {
  INJECTED_FAULT_MODES,
  InjectedFault,
  TIMEOUT_MS,
  WATCHDOG_MS,
  after,
  assertKnownBrokenStillReproduce,
  assertSeedOutcome,
  buildTable,
  campaignSeeds,
  canonicalJson,
  lowConfidenceAnalysis,
  mulberry32,
  never,
  randomScoredAnalysis,
  writeArtifact,
  type FaultMode,
  type KnownBroken,
  type Rng,
  type SeedOutcome,
} from '../../test-support/stress/liveCourtStressKit';

declare const process: { env: Record<string, string | undefined> };

const SUITE = 'liveSessionFlowFaults';
const LOOPS = Number(process.env.STRESS_LOOPS ?? 25);
const RALLY_SPAN_MS = 4_000;

/** Reproduced production defects (see the MINIMIZED / SWEEP tests below). */
const KNOWN_BROKEN: readonly KnownBroken[] = [
  {
    finding: 'LSF-1',
    violationClass: 'F7:snapshot_threw',
    observed:
      'A provider outcome {status:"ready"} whose analysis is not a full AnalysisRecord is stored as-is; ' +
      'LiveSessionFlow.snapshot() then throws TypeError in eventTechniqueFamily (strokeResolution.kind) ' +
      'on every later call — the live UI stops receiving snapshots and end() cannot register the session.',
  },
  {
    finding: 'LSF-1',
    violationClass: 'F7:end_threw',
    observed:
      'flow.end() throws for the same poisoned session (completedSessions.set(this.snapshot()) is unguarded).',
  },
  {
    finding: 'LSF-1',
    violationClass: 'F7:onUpdate_starved',
    observed:
      'notify() builds the snapshot inside the onUpdate try/catch, so the TypeError is swallowed as an ' +
      '"onUpdate subscriber failure" and the UI subscriber is never called again for the session.',
  },
  {
    finding: 'LSF-3',
    violationClass: 'F3:pending_without_reason_after_malformed_outcome',
    observed:
      'A provider/clip outcome with status "pending"/"unavailable"/unknown and a missing or empty reason is ' +
      'accepted unvalidated: the event is parked in "pending" with pendingReason undefined/"" — an ' +
      'un-explained spinner with no retry path.',
  },
  {
    finding: 'LSF-3',
    violationClass: 'F3:abstained_without_reason_after_malformed_outcome',
    observed:
      'A provider outcome {status:"abstained"} with a missing/empty abstainReason becomes a terminal abstained event with no reason.',
  },
  {
    finding: 'LSF-4',
    violationClass: 'F1:availability_throw_escaped_pushSample',
    observed:
      'provider.availability() is called unguarded from dispatchAnalysis → pushSample; its exception propagates to the motion-feed caller.',
  },
  {
    finding: 'LSF-4',
    violationClass: 'F3:pending_without_reason_after_availability_throw',
    observed:
      'The event closed by that sample is left "pending" with pendingReason null.',
  },
  {
    finding: 'LSF-5',
    violationClass: 'F2:stuck_processing',
    observed:
      'A provider.analyzeEvent() that resolves to null is mistaken for the internal "clip unavailable" ' +
      'sentinel (`if (outcome === null) return`): the event stays "processing" forever with no reason, ' +
      'no timeout and no notify.',
  },
  {
    finding: 'LSF-6',
    violationClass: 'F5:completed_session_registry_diverges_from_live_snapshot',
    observed:
      'notify() writes the completed-session registry BEFORE calling onUpdate, so when the last ' +
      'onUpdate after end() throws, the registry copy is one onUpdateFailures behind snapshot().',
  },
  {
    finding: 'LSF-2',
    violationClass: 'F4:durationMs',
    observed:
      'One motion sample with tMs=NaN/Infinity poisons snapshot.durationMs via Math.max for the rest of the session.',
  },
  {
    finding: 'LSF-2',
    violationClass: 'F4:durationMs_exploded',
    observed:
      'One motion sample with tMs=1e15 sets snapshot.durationMs to 1e15 (Math.max, no sanity bound).',
  },
  {
    finding: 'LSF-2',
    violationClass: 'F5:summary_durationMs',
    observed:
      'The poisoned durationMs is copied into the persisted LiveSessionSummaryRecordV1.',
  },
];

type AvailabilityFault = 'none' | 'unavailable' | 'throw' | 'garbage';

/**
 * `malformed_ready`: {status:'ready'} with an analysis that is not an
 * AnalysisRecord. Kept OUT of the random plan because the first occurrence
 * poisons LiveSessionFlow.snapshot() for the rest of the session (LSF-1) and
 * would hide every other invariant of the seed; covered by its own SWEEP.
 */
type ProviderFault = FaultMode | 'malformed_ready';

const READY_WITH_INVALID_ANALYSIS: ReadonlyArray<readonly [string, unknown]> = [
  ['analysis="garbage"', { status: 'ready', analysis: 'garbage' }],
  ['analysis={}', { status: 'ready', analysis: {} }],
  [
    'analysis.result-only',
    {
      status: 'ready',
      analysis: {
        result: { resultKind: 'scored', overallScore: 7.5, checkpoints: [] },
      },
    },
  ],
];

interface EventFault {
  availability: AvailabilityFault;
  provider: ProviderFault;
  providerVariant: number;
  clip: FaultMode;
  clipVariant: number;
}

interface LoopFault {
  duplicateSamples: boolean;
  outOfOrder: boolean;
  backgroundGapMs: number;
  onUpdateThrows: boolean;
  ttsFault: 'none' | 'speak_false' | 'speak_throws';
}

function eventFault(rng: Rng): EventFault {
  const fault: EventFault = {
    availability: 'none',
    provider: 'none',
    providerVariant: rng.int(0, 7),
    clip: 'none',
    clipVariant: rng.int(0, 7),
  };
  if (!rng.chance(0.55)) return fault;
  const roll = rng.int(0, 9);
  // availability:'throw' is excluded from the random plan: it escapes
  // pushSample synchronously (see the MINIMIZED test) and would mask every
  // other invariant in the seed.
  if (roll <= 1) fault.availability = rng.pick(['unavailable', 'garbage']);
  else if (roll <= 6) fault.provider = rng.pick(INJECTED_FAULT_MODES);
  else fault.clip = rng.pick(INJECTED_FAULT_MODES);
  return fault;
}

function loopFault(rng: Rng): LoopFault {
  return {
    duplicateSamples: rng.chance(0.15),
    outOfOrder: rng.chance(0.15),
    backgroundGapMs: rng.chance(0.08) ? rng.int(30_000, 600_000) : 0,
    onUpdateThrows: rng.chance(0.1),
    ttsFault: rng.chance(0.15)
      ? rng.pick(['speak_false', 'speak_throws'] as const)
      : 'none',
  };
}

function eventNumber(eventId: string): number {
  return Number(eventId.slice(1));
}

function labelsFor(fault: EventFault): string[] {
  const labels: string[] = [];
  if (fault.availability !== 'none')
    labels.push(`vision.availability:${fault.availability}`);
  if (fault.provider !== 'none')
    labels.push(`vision.analyzeEvent:${fault.provider}`);
  if (fault.clip !== 'none') labels.push(`camera.clipSource:${fault.clip}`);
  return labels;
}

/** A reason-less pending/abstained event is a known defect (LSF-3) only when
 * the injected outcome itself lacked the reason; from any other fault it is a
 * NEW violation class and fails the seed. */
function reasonlessClass(
  state: 'pending' | 'abstained',
  fault: EventFault,
): string {
  const malformedOutcome =
    fault.provider === 'malformed' ||
    fault.provider === 'partial' ||
    fault.clip === 'malformed' ||
    fault.clip === 'partial';
  return malformedOutcome
    ? `F3:${state}_without_reason_after_malformed_outcome`
    : `F3:${state}_without_reason`;
}

function providerReportsFailure(fault: EventFault): boolean {
  return (
    fault.provider === 'throw' ||
    fault.provider === 'reject' ||
    fault.provider === 'malformed' ||
    fault.provider === 'malformed_ready'
  );
}

function hangsForever(fault: EventFault): boolean {
  return (
    fault.provider === 'never' ||
    fault.provider === 'timeout' ||
    fault.clip === 'never' ||
    fault.clip === 'timeout'
  );
}

function makeProvider(
  faults: Map<number, EventFault>,
  rng: Rng,
  calls: { availability: number; analyze: number },
): SessionEventAnalysisProvider {
  let cursor = 0;
  const outcomes: SessionEventAnalysisOutcome[] = [];
  return {
    providerId: 'stress-faulty-provider',
    availability() {
      calls.availability += 1;
      // availability() has no event argument: the flow calls it once per
      // dispatch, in emission order, so the cursor tracks E1, E2, …
      cursor += 1;
      const fault = faults.get(cursor);
      if (fault?.availability === 'unavailable') {
        return {
          status: 'unavailable',
          pendingReason: 'INJECTED_UNAVAILABLE:vision',
        };
      }
      if (fault?.availability === 'throw')
        throw new InjectedFault('vision.availability', 'throw');
      if (fault?.availability === 'garbage') {
        return { status: 'maybe' } as unknown as { status: 'available' };
      }
      return { status: 'available' };
    },
    analyzeEvent(request) {
      calls.analyze += 1;
      const fault = faults.get(eventNumber(request.eventId));
      const healthy = (): SessionEventAnalysisOutcome => {
        const outcome: SessionEventAnalysisOutcome = rng.chance(0.75)
          ? { status: 'ready', analysis: randomScoredAnalysis(rng) }
          : rng.chance(0.5)
            ? { status: 'ready', analysis: lowConfidenceAnalysis() }
            : { status: 'abstained', abstainReason: 'STRESS_ABSTAIN' };
        outcomes.push(outcome);
        return outcome;
      };
      const mode = fault?.provider ?? 'none';
      const variant = fault?.providerVariant ?? 0;
      switch (mode) {
        case 'none':
          return Promise.resolve(healthy());
        case 'throw':
          throw new InjectedFault('vision.analyzeEvent', 'throw');
        case 'reject':
          return Promise.reject(
            new InjectedFault('vision.analyzeEvent', 'reject'),
          );
        case 'timeout':
          return after(TIMEOUT_MS, healthy());
        case 'slow':
          return after(5_000, healthy());
        case 'never':
          return never();
        case 'malformed': {
          const shapes: unknown[] = [
            null,
            undefined,
            'ready',
            { status: 'ready', analysis: null },
            { status: 'ready' },
            { status: 'weird' },
            { status: 'READY', analysis: null },
            { status: 42 },
          ];
          return Promise.resolve(
            shapes[variant % shapes.length] as SessionEventAnalysisOutcome,
          );
        }
        case 'malformed_ready':
          return Promise.resolve(
            READY_WITH_INVALID_ANALYSIS[
              variant % READY_WITH_INVALID_ANALYSIS.length
            ]![1] as SessionEventAnalysisOutcome,
          );
        case 'partial': {
          const shapes: unknown[] = [
            { status: 'pending' },
            { status: 'abstained' },
            { status: 'pending', pendingReason: '' },
            { status: 'abstained', abstainReason: '' },
            { status: 'unavailable' },
          ];
          return Promise.resolve(
            shapes[variant % shapes.length] as SessionEventAnalysisOutcome,
          );
        }
      }
    },
  };
}

function makeClipSource(
  faults: Map<number, EventFault>,
): SessionEventClipSource {
  const healthy = (eventId: string): SessionEventClipExtraction => ({
    status: 'extracted',
    clip: {
      uri: `stress://clip/${eventId}`,
      durationMs: 1200,
      fps: 30,
      width: 1080,
      height: 1920,
    } as unknown as CapturedClip,
    poseSequenceSlice: null,
  });
  return {
    sourceId: 'stress-faulty-clip-source',
    extract(event) {
      const fault = faults.get(eventNumber(event.eventId));
      const mode = fault?.clip ?? 'none';
      const variant = fault?.clipVariant ?? 0;
      switch (mode) {
        case 'none':
          return Promise.resolve(healthy(event.eventId));
        case 'throw':
          throw new InjectedFault('camera.clipSource', 'throw');
        case 'reject':
          return Promise.reject(
            new InjectedFault('camera.clipSource', 'reject'),
          );
        case 'timeout':
          return after(TIMEOUT_MS, healthy(event.eventId));
        case 'slow':
          return after(5_000, healthy(event.eventId));
        case 'never':
          return never();
        case 'malformed': {
          const shapes: unknown[] = [
            null,
            undefined,
            { status: 'extracted' },
            { status: 'extracted', clip: null, poseSequenceSlice: null },
            { status: 'extracted', clip: 'garbage' },
            { status: 'bogus' },
            { status: 'unavailable' },
            { status: 'unavailable', pendingReason: '' },
          ];
          return Promise.resolve(
            shapes[variant % shapes.length] as SessionEventClipExtraction,
          );
        }
        case 'partial':
          return Promise.resolve({
            status: 'extracted',
            clip: { uri: '', durationMs: 0, fps: 0, width: 0, height: 0 },
            poseSequenceSlice: null,
          } as unknown as SessionEventClipExtraction);
      }
    },
  };
}

interface EventRow {
  eventId: string;
  faults: string[];
  state: string;
  pendingReason: string | null;
  abstainReason: string | null;
  hasAnalysis: boolean;
}

interface SeedRun {
  outcome: SeedOutcome;
  rows: EventRow[];
}

async function drain(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

async function runSeed(seed: number): Promise<SeedRun> {
  const rng = mulberry32(seed);
  const violations: string[] = [];
  const faultsInjected = new Set<string>();
  const eventFaults = new Map<number, EventFault>();
  // Pre-plan faults for up to 4 events per loop (E1..E4·LOOPS) so the plan is
  // fixed before any timing-dependent code runs.
  for (let n = 1; n <= LOOPS * 4; n += 1) eventFaults.set(n, eventFault(rng));
  const loopFaults = Array.from({ length: LOOPS }, () => loopFault(rng));
  const providerRng = mulberry32(seed ^ 0x9e3779b9);

  const calls = { availability: 0, analyze: 0 };
  const provider = makeProvider(eventFaults, providerRng, calls);
  const clipSource = makeClipSource(eventFaults);
  let samplesPushed = 0;
  let onUpdateShouldThrow = false;
  let onUpdateThrows = 0;
  let snapshots = 0;
  let lastDuration = -1;
  let lastGood: LiveSessionSnapshot | null = null;
  const safeSnapshot = (where: string): LiveSessionSnapshot | null => {
    try {
      const snapshot = flow.snapshot();
      lastGood = snapshot;
      return snapshot;
    } catch (error) {
      violations.push(`F7:snapshot_threw(${where}): ${String(error)}`);
      return null;
    }
  };
  const abort = (): SeedRun => ({
    rows: [],
    outcome: {
      seed,
      outcome: 'BROKEN',
      iterations: lastGood?.events.length ?? 0,
      faultsInjected: [...faultsInjected].sort(),
      violations,
      detail: {
        loops: LOOPS,
        aborted: true,
        samplesPushed,
        onUpdateThrows,
        snapshots,
      },
    },
  });
  let ttsFault: LoopFault['ttsFault'] = 'none';
  let coachThrows = 0;
  const voice = {
    available: () => true,
    speak: () => {
      if (ttsFault === 'speak_throws')
        throw new InjectedFault('tts.speak', 'throw');
      return ttsFault !== 'speak_false';
    },
    stop: () => undefined,
  };
  const coach = new LiveSessionCoach({ voice });
  const sessionId = `flow-stress-${seed}`;
  const flow = new LiveSessionFlow({
    sessionId,
    source: 'live',
    provider,
    clipSource,
    startedAtIso: '2026-09-05T00:00:00.000Z',
    fps: 30,
    onUpdate: snapshot => {
      snapshots += 1;
      // F4 checks on every notification — the cheapest place to catch a
      // transiently corrupt snapshot.
      if (snapshot.strokeCount !== snapshot.events.length) {
        violations.push(
          `F4:strokeCount(${snapshot.strokeCount})!=events(${snapshot.events.length})`,
        );
      }
      if (
        !Number.isFinite(snapshot.durationMs) ||
        snapshot.durationMs < lastDuration
      ) {
        violations.push(
          `F4:durationMs_not_monotonic(${lastDuration}→${snapshot.durationMs})`,
        );
      }
      lastDuration = snapshot.durationMs;
      try {
        coach.consumeSnapshot(snapshot);
      } catch (error) {
        coachThrows += 1;
        if (!(error instanceof InjectedFault)) {
          violations.push(`F1:coach_threw_unexpectedly(${String(error)})`);
        }
      }
      if (onUpdateShouldThrow) {
        onUpdateThrows += 1;
        throw new InjectedFault('onUpdate', 'throw');
      }
    },
  });
  coach.sessionStarted('live');

  let duplicateSamples = 0;
  let lateSamples = 0;
  let offset = 0;
  for (let loop = 0; loop < LOOPS; loop += 1) {
    const lf = loopFaults[loop]!;
    onUpdateShouldThrow = lf.onUpdateThrows;
    ttsFault = lf.ttsFault;
    if (lf.onUpdateThrows) faultsInjected.add('onUpdate:throw');
    if (lf.ttsFault !== 'none') faultsInjected.add(`tts:${lf.ttsFault}`);
    if (lf.duplicateSamples) faultsInjected.add('sample_stream:duplicate');
    if (lf.outOfOrder) faultsInjected.add('sample_stream:out_of_order');
    if (lf.backgroundGapMs > 0) faultsInjected.add('lifecycle:background_gap');
    offset += lf.backgroundGapMs;

    const samples: SessionMotionSample[] = DEV_REPLAY_RALLY.samples.map(s => ({
      tMs: s.tMs + offset,
      v: s.v,
    }));
    let stream: SessionMotionSample[] = [...samples];
    if (lf.duplicateSamples) {
      const at = rng.int(0, stream.length - 1);
      stream.splice(at, 0, { ...stream[at]! });
      duplicateSamples += 1;
    }
    if (lf.outOfOrder) {
      // A late sample: one reading arrives ~200ms after its neighbours.
      const at = rng.int(2, stream.length - 2);
      const late = stream[at]!;
      stream = [
        ...stream.slice(0, at),
        ...stream.slice(at + 1, at + 6),
        late,
        ...stream.slice(at + 6),
      ];
      lateSamples += 1;
    }
    for (const sample of stream) {
      try {
        flow.pushSample(sample);
        samplesPushed += 1;
      } catch (error) {
        violations.push(
          `F1:pushSample_threw loop=${loop} t=${sample.tMs} v=${sample.v}: ${String(error)}`,
        );
      }
    }
    offset += RALLY_SPAN_MS;
    await drain(WATCHDOG_MS);
  }

  const beforeEnd = safeSnapshot('before_end');
  if (!beforeEnd) return abort();
  for (const [n, fault] of eventFaults) {
    if (n <= beforeEnd.events.length)
      for (const label of labelsFor(fault)) faultsInjected.add(label);
  }

  let finalSnapshot: LiveSessionSnapshot;
  try {
    finalSnapshot = flow.end();
  } catch (error) {
    violations.push(`F7:end_threw: ${String(error)}`);
    return abort();
  }
  onUpdateShouldThrow = false;
  ttsFault = 'none';
  // Late native emission after stop must be refused loudly, never absorbed.
  let lateThrew = false;
  try {
    flow.pushSample({ tMs: offset + 100, v: 0.4 });
  } catch {
    lateThrew = true;
  }
  if (!lateThrew) violations.push('F1:pushSample_after_end_did_not_throw');
  faultsInjected.add('lifecycle:sample_after_end');

  await drain(TIMEOUT_MS);
  const settledSnapshot = safeSnapshot('after_settle');
  if (!settledSnapshot) return abort();
  const rows: EventRow[] = settledSnapshot.events.map(event => ({
    eventId: event.eventId,
    faults: labelsFor(eventFaults.get(eventNumber(event.eventId))!),
    state: event.state,
    pendingReason: event.pendingReason,
    abstainReason: event.abstainReason,
    hasAnalysis: event.analysis !== null,
  }));

  // F2 / F3 per event.
  let processingForever = 0;
  let pendingWithReason = 0;
  let abstainedByDispatchFailure = 0;
  settledSnapshot.events.forEach((event, i) => {
    const fault = eventFaults.get(eventNumber(event.eventId))!;
    if (event.index !== i)
      violations.push(`F4:index_gap(${event.eventId} at ${i})`);
    if (event.state === 'processing') {
      if (hangsForever(fault)) processingForever += 1;
      else
        violations.push(
          `F2:stuck_processing(${event.eventId}) faults=${labelsFor(fault).join('+') || 'healthy'}`,
        );
    }
    if (event.state === 'pending') {
      if (event.pendingReason && event.pendingReason.length > 0)
        pendingWithReason += 1;
      else
        violations.push(
          `${reasonlessClass('pending', fault)}(${event.eventId}) faults=${labelsFor(fault).join('+') || 'healthy'}`,
        );
    }
    if (event.state === 'ready') {
      const analysis = event.analysis;
      if (
        !analysis ||
        typeof analysis !== 'object' ||
        !('result' in analysis)
      ) {
        violations.push(
          `F3:ready_without_analysis(${event.eventId}) faults=${labelsFor(fault).join('+')}`,
        );
      }
      if (providerReportsFailure(fault)) {
        violations.push(
          `F3:fake_success(${event.eventId}) faults=${labelsFor(fault).join('+')}`,
        );
      }
      if (fault.availability !== 'none' && fault.availability !== 'garbage') {
        violations.push(
          `F3:ready_despite_unavailable(${event.eventId}) faults=${labelsFor(fault).join('+')}`,
        );
      }
    }
    if (event.state === 'abstained') {
      if (!event.abstainReason) {
        violations.push(
          `${reasonlessClass('abstained', fault)}(${event.eventId}) faults=${labelsFor(fault).join('+') || 'healthy'}`,
        );
      } else if (event.abstainReason.startsWith('ANALYSIS_DISPATCH_FAILED'))
        abstainedByDispatchFailure += 1;
    }
  });
  const ids = settledSnapshot.events.map(event => event.eventId);
  if (new Set(ids).size !== ids.length)
    violations.push('F4:duplicate_event_ids');
  if (settledSnapshot.onUpdateFailures !== onUpdateThrows) {
    violations.push(
      `F4:onUpdateFailures(${settledSnapshot.onUpdateFailures})!=thrown(${onUpdateThrows})`,
    );
  }
  if (settledSnapshot.events.length < LOOPS * 2) {
    violations.push(
      `F4:too_few_events(${settledSnapshot.events.length}) for ${LOOPS} loops`,
    );
  }

  // F5 persisted state.
  const persisted = getCompletedSession(sessionId);
  if (!persisted) violations.push('F5:completed_session_not_registered');
  else {
    if (canonicalJson(persisted) !== canonicalJson(settledSnapshot)) {
      const differing = (
        Object.keys(settledSnapshot) as Array<keyof LiveSessionSnapshot>
      ).filter(
        key =>
          canonicalJson(persisted[key]) !== canonicalJson(settledSnapshot[key]),
      );
      violations.push(
        `F5:completed_session_registry_diverges_from_live_snapshot(${differing.join('+')})`,
      );
    }
    finalSnapshot.events.forEach((event, i) => {
      const later = persisted.events[i];
      if (!later || later.eventId !== event.eventId) {
        violations.push(`F5:event_order_changed(${event.eventId})`);
        return;
      }
      if (
        (event.state === 'ready' || event.state === 'abstained') &&
        later.state !== event.state
      ) {
        violations.push(
          `F5:terminal_state_rewritten(${event.eventId}:${event.state}→${later.state})`,
        );
      }
    });
  }
  if (finalSnapshot.events.length < beforeEnd.events.length) {
    violations.push('F4:end_dropped_events');
  }

  const recap = coach.sessionEnded(settledSnapshot);
  const record = buildLiveSessionSummaryRecord(
    settledSnapshot,
    sessionScoreProgression(settledSnapshot.events),
    recap,
  );
  const roundTrip = parseLiveSessionSummaryRecord(JSON.stringify(record));
  if (canonicalJson(roundTrip) !== canonicalJson(record)) {
    violations.push('F5:summary_record_does_not_round_trip');
  }
  const scoredEvents = settledSnapshot.events.filter(
    event =>
      event.state === 'ready' &&
      event.analysis?.result?.resultKind === 'scored' &&
      typeof event.analysis.result.overallScore === 'number',
  ).length;
  if (record.scoredCount !== scoredEvents) {
    violations.push(
      `F5:summary_scoredCount(${record.scoredCount})!=scored_events(${scoredEvents})`,
    );
  }
  if (record.strokeCount !== settledSnapshot.events.length) {
    violations.push(
      `F5:summary_strokeCount(${record.strokeCount})!=events(${settledSnapshot.events.length})`,
    );
  }

  return {
    rows,
    outcome: {
      seed,
      outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
      iterations: settledSnapshot.events.length,
      faultsInjected: [...faultsInjected].sort(),
      violations,
      detail: {
        loops: LOOPS,
        samplesPushed,
        duplicateSamples,
        lateSamples,
        droppedLateSamples: settledSnapshot.droppedLateSamples,
        qualityNotes: settledSnapshot.qualityNotes.length,
        events: settledSnapshot.events.length,
        states: {
          ready: rows.filter(r => r.state === 'ready').length,
          abstained: rows.filter(r => r.state === 'abstained').length,
          pending: rows.filter(r => r.state === 'pending').length,
          processing: rows.filter(r => r.state === 'processing').length,
        },
        processingForever,
        pendingWithReason,
        abstainedByDispatchFailure,
        onUpdateThrows,
        coachThrows,
        snapshots,
        providerCalls: calls,
        cues: recap.cues.length,
        spoken: recap.spokenCount,
        summary: record,
      },
    },
  };
}

describe('STRESS · LiveSessionFlow (real engine) × provider / clip / onUpdate / TTS / stream faults', () => {
  const seeds = campaignSeeds(4);
  const outcomes: SeedOutcome[] = [];
  const tables: Record<number, EventRow[]> = {};

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_757_030_400_000);
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  afterAll(() => {
    writeArtifact(`${SUITE}.json`, buildTable(SUITE, outcomes));
    writeArtifact(`${SUITE}.events.json`, tables);
  });

  it.each(seeds.map(seed => [seed] as const))(
    `seed=%i holds the flow invariants over ${LOOPS} rally loops`,
    async seed => {
      const run = await runSeed(seed);
      outcomes.push(run.outcome);
      tables[seed] = run.rows;
      assertSeedOutcome(
        SUITE,
        run.outcome,
        KNOWN_BROKEN,
        `STRESS_SEED=${seed} STRESS_LOOPS=${LOOPS} npx jest --ci ${SUITE}`,
      );
    },
    120_000,
  );

  it('is replayable: same seed ⇒ same canonical event-state table (F6)', async () => {
    const a = await runSeed(seeds[0]!);
    jest.useRealTimers();
    jest.useFakeTimers();
    const b = await runSeed(seeds[0]!);
    expect(canonicalJson(b.rows)).toBe(canonicalJson(a.rows));
  }, 120_000);

  it('MINIMIZED: a never-resolving analysis provider leaves the event "processing" with no timeout after 60s', async () => {
    const faults = new Map<number, EventFault>([
      [
        1,
        {
          availability: 'none',
          provider: 'never',
          providerVariant: 0,
          clip: 'none',
          clipVariant: 0,
        },
      ],
    ]);
    const flow = new LiveSessionFlow({
      sessionId: 'min-never',
      source: 'live',
      provider: makeProvider(faults, mulberry32(1), {
        availability: 0,
        analyze: 0,
      }),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    await drain(WATCHDOG_MS);
    const e1 = flow.snapshot().events[0]!;
    // Documents the current contract: the flow has no per-event analysis
    // watchdog, so a hung provider is an indefinite 'processing'.
    expect(e1.state).toBe('processing');
    expect(e1.pendingReason).toBeNull();
    expect(e1.abstainReason).toBeNull();
    const settled = Promise.race([
      flow.settled().then(() => 'settled'),
      after(1, 'still-pending'),
    ]);
    await drain(1);
    await expect(settled).resolves.toBe('still-pending');
  });

  it('MINIMIZED: a throwing provider.availability() escapes pushSample and leaves the closed event pending with no reason', async () => {
    const faults = new Map<number, EventFault>([
      [
        1,
        {
          availability: 'throw',
          provider: 'none',
          providerVariant: 0,
          clip: 'none',
          clipVariant: 0,
        },
      ],
    ]);
    const flow = new LiveSessionFlow({
      sessionId: 'min-availability-throw',
      source: 'live',
      provider: makeProvider(faults, mulberry32(1), {
        availability: 0,
        analyze: 0,
      }),
    });
    let escaped: unknown = null;
    for (const sample of DEV_REPLAY_RALLY.samples) {
      try {
        flow.pushSample(sample);
      } catch (error) {
        escaped = escaped ?? error;
      }
    }
    await drain(WATCHDOG_MS);
    const e1 = flow.snapshot().events[0]!;
    // Documents the current contract: the availability probe is not guarded,
    // so its exception propagates to the motion-sample caller and E1 is left
    // 'pending' with no pendingReason (an un-explained spinner).
    const violations: string[] = [];
    if (escaped instanceof InjectedFault)
      violations.push('F1:availability_throw_escaped_pushSample');
    if (e1.state === 'pending' && !e1.pendingReason) {
      violations.push(
        `F3:pending_without_reason_after_availability_throw(${e1.eventId})`,
      );
    }
    const outcome: SeedOutcome = {
      seed: -201,
      outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
      iterations: DEV_REPLAY_RALLY.samples.length,
      faultsInjected: ['vision.availability:throw'],
      violations,
      detail: { e1: { state: e1.state, pendingReason: e1.pendingReason } },
    };
    outcomes.push(outcome);
    assertSeedOutcome(
      SUITE,
      outcome,
      KNOWN_BROKEN,
      `npx jest --ci ${SUITE} -t "availability()"`,
    );
    expect(escaped).toBeInstanceOf(InjectedFault);
    expect({ state: e1.state, pendingReason: e1.pendingReason }).toEqual({
      state: 'pending',
      pendingReason: null,
    });
  });

  const MALFORMED_SAMPLES: ReadonlyArray<
    readonly [string, SessionMotionSample]
  > = [
    ['tMs=NaN', { tMs: NaN, v: 0.3 }],
    ['v=NaN', { tMs: 1_500, v: NaN }],
    ['tMs=-1', { tMs: -1, v: 0.1 }],
    ['v=-5', { tMs: 1_600, v: -5 }],
    ['v=Infinity', { tMs: 1_700, v: Infinity }],
    ['tMs=Infinity', { tMs: Infinity, v: 0.2 }],
    ['tMs=1e15', { tMs: 1e15, v: 0.2 }],
    ['v=undefined', { tMs: 1_800, v: undefined as unknown as number }],
  ];

  it.each(MALFORMED_SAMPLES.map(([name, sample]) => [name, sample] as const))(
    'SWEEP · one malformed motion sample (%s) mid-rally must not corrupt the snapshot (F4) or the persisted summary (F5)',
    async (name, malformed) => {
      const flow = new LiveSessionFlow({
        sessionId: `min-sample-${name}`,
        source: 'live',
        provider: makeProvider(new Map(), mulberry32(2), {
          availability: 0,
          analyze: 0,
        }),
      });
      const violations: string[] = [];
      const samples = [...DEV_REPLAY_RALLY.samples];
      samples.splice(40, 0, malformed);
      for (const sample of samples) {
        try {
          flow.pushSample(sample);
        } catch (error) {
          violations.push(`F1:pushSample_threw(${String(error)})`);
        }
      }
      await drain(WATCHDOG_MS);
      const snapshot = flow.end();
      await drain(1);
      const final = flow.snapshot();
      if (!Number.isFinite(final.durationMs))
        violations.push(`F4:durationMs=${final.durationMs}`);
      if (final.durationMs > 60_000)
        violations.push(`F4:durationMs_exploded=${final.durationMs}`);
      if (final.durationMs < 0)
        violations.push(`F4:durationMs_negative=${final.durationMs}`);
      for (const event of final.events) {
        if (
          !Number.isFinite(event.startMs) ||
          !Number.isFinite(event.endMs) ||
          !Number.isFinite(event.closedAtMs)
        ) {
          violations.push(`F4:event_bounds_not_finite(${event.eventId})`);
        }
        if (event.state === 'processing')
          violations.push(`F2:stuck_processing(${event.eventId})`);
      }
      const recap = new LiveSessionCoach({
        voice: {
          available: () => true,
          speak: () => true,
          stop: () => undefined,
        },
      }).sessionEnded(final);
      const record = buildLiveSessionSummaryRecord(
        final,
        sessionScoreProgression(final.events),
        recap,
      );
      if (
        record.durationMs !== final.durationMs &&
        Number.isFinite(final.durationMs)
      ) {
        violations.push(
          `F5:summary_durationMs(${record.durationMs})!=snapshot(${final.durationMs})`,
        );
      }
      if (!Number.isFinite(record.durationMs))
        violations.push(`F5:summary_durationMs=${record.durationMs}`);
      const outcome: SeedOutcome = {
        seed: -1 - MALFORMED_SAMPLES.findIndex(([n]) => n === name),
        outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
        iterations: samples.length,
        faultsInjected: [`sample_stream:malformed:${name}`],
        violations,
        detail: {
          durationMs: final.durationMs,
          events: final.events.length,
          endedEvents: snapshot.events.length,
        },
      };
      outcomes.push(outcome);
      assertSeedOutcome(
        SUITE,
        outcome,
        KNOWN_BROKEN,
        `npx jest --ci ${SUITE} -t "${name}"`,
      );
    },
  );

  it.failing(
    'MINIMIZED (LSF-2, expected-fail): one motion sample with tMs=NaN must not poison snapshot.durationMs and the persisted summary',
    async () => {
      const flow = new LiveSessionFlow({
        sessionId: 'min-nan-sample',
        source: 'live',
        provider: makeProvider(new Map(), mulberry32(2), {
          availability: 0,
          analyze: 0,
        }),
      });
      const samples = [...DEV_REPLAY_RALLY.samples];
      samples.splice(40, 0, { tMs: NaN, v: 0.3 });
      for (const sample of samples) flow.pushSample(sample);
      await drain(WATCHDOG_MS);
      const final = flow.end();
      const record = buildLiveSessionSummaryRecord(
        final,
        sessionScoreProgression(final.events),
        null,
      );
      expect(Number.isFinite(final.durationMs)).toBe(true);
      expect(Number.isFinite(record.durationMs)).toBe(true);
    },
  );

  it.each(
    READY_WITH_INVALID_ANALYSIS.map(
      ([name], variant) => [name, variant] as const,
    ),
  )(
    'SWEEP · provider {status:"ready"} with %s must not poison snapshot()/end() (F7) or become a ready event (F3)',
    async (name, variant) => {
      const faults = new Map<number, EventFault>([
        [
          1,
          {
            availability: 'none',
            provider: 'malformed_ready',
            providerVariant: variant,
            clip: 'none',
            clipVariant: 0,
          },
        ],
      ]);
      const violations: string[] = [];
      let onUpdateCalls = 0;
      const flow = new LiveSessionFlow({
        sessionId: `min-malformed-ready-${variant}`,
        source: 'live',
        provider: makeProvider(faults, mulberry32(3), {
          availability: 0,
          analyze: 0,
        }),
        onUpdate: () => {
          onUpdateCalls += 1;
        },
      });
      for (const sample of DEV_REPLAY_RALLY.samples) {
        try {
          flow.pushSample(sample);
        } catch (error) {
          violations.push(`F1:pushSample_threw: ${String(error)}`);
        }
      }
      await drain(WATCHDOG_MS);
      const callsBeforeExtraSample = onUpdateCalls;
      // A healthy flow notifies the UI on every sample; a poisoned one
      // swallows the TypeError inside notify() and never calls onUpdate again.
      try {
        flow.pushSample({ tMs: 5_000, v: 0.05 });
      } catch (error) {
        violations.push(`F1:pushSample_threw: ${String(error)}`);
      }
      if (onUpdateCalls === callsBeforeExtraSample)
        violations.push('F7:onUpdate_starved');
      let snapshot: LiveSessionSnapshot | null = null;
      try {
        snapshot = flow.snapshot();
      } catch (error) {
        violations.push(`F7:snapshot_threw(after_settle): ${String(error)}`);
      }
      if (snapshot) {
        const e1 = snapshot.events[0]!;
        if (e1.state === 'ready')
          violations.push(
            `F3:fake_success(${e1.eventId}) faults=vision.analyzeEvent:malformed_ready`,
          );
        if (e1.state === 'processing')
          violations.push(`F2:stuck_processing(${e1.eventId})`);
        if (snapshot.onUpdateFailures !== 0)
          violations.push(
            `F4:onUpdateFailures(${snapshot.onUpdateFailures})!=thrown(0)`,
          );
      }
      let ended = false;
      try {
        flow.end();
        ended = true;
      } catch (error) {
        violations.push(`F7:end_threw: ${String(error)}`);
      }
      if (ended && !getCompletedSession(`min-malformed-ready-${variant}`)) {
        violations.push('F5:completed_session_not_registered');
      }
      const outcome: SeedOutcome = {
        seed: -101 - variant,
        outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
        iterations: DEV_REPLAY_RALLY.samples.length,
        faultsInjected: [
          'vision.analyzeEvent:malformed_ready',
          `vision.analyzeEvent:malformed_ready:${name}`,
        ],
        violations,
        detail: {
          onUpdateCalls: callsBeforeExtraSample,
          ended,
          e1: snapshot?.events[0]?.state ?? 'snapshot_threw',
        },
      };
      outcomes.push(outcome);
      assertSeedOutcome(
        SUITE,
        outcome,
        KNOWN_BROKEN,
        `npx jest --ci ${SUITE} -t "${name}"`,
      );
    },
  );

  it.failing(
    'MINIMIZED (LSF-1, expected-fail): a ready outcome with analysis={} must not make LiveSessionFlow.snapshot() throw',
    async () => {
      const faults = new Map<number, EventFault>([
        [
          1,
          {
            availability: 'none',
            provider: 'malformed_ready',
            providerVariant: 1,
            clip: 'none',
            clipVariant: 0,
          },
        ],
      ]);
      const flow = new LiveSessionFlow({
        sessionId: 'min-malformed-ready',
        source: 'live',
        provider: makeProvider(faults, mulberry32(3), {
          availability: 0,
          analyze: 0,
        }),
      });
      for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
      await drain(WATCHDOG_MS);
      expect(() => flow.snapshot()).not.toThrow();
      expect(flow.snapshot().events[0]!.state).not.toBe('ready');
    },
  );

  // Surfaced by the scaled campaign (STRESS_ITER=140 STRESS_LOOPS=25: 44 of
  // 140 seeds); pinned deterministically so the default run carries the class.
  it.failing(
    'MINIMIZED (LSF-5, expected-fail): an analysis outcome of null must not leave the event "processing" forever',
    async () => {
      const faults = new Map<number, EventFault>([
        [
          1,
          {
            availability: 'none',
            provider: 'malformed',
            providerVariant: 0,
            clip: 'none',
            clipVariant: 0,
          },
        ],
      ]);
      const flow = new LiveSessionFlow({
        sessionId: 'min-null-outcome',
        source: 'live',
        provider: makeProvider(faults, mulberry32(1), {
          availability: 0,
          analyze: 0,
        }),
      });
      for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
      await drain(WATCHDOG_MS);
      const e1 = flow.snapshot().events[0]!;
      outcomes.push({
        seed: -301,
        outcome: e1.state === 'processing' ? 'BROKEN' : 'HELD',
        iterations: 1,
        faultsInjected: ['vision.analyzeEvent:malformed'],
        violations:
          e1.state === 'processing'
            ? [
                `F2:stuck_processing(${e1.eventId}) faults=vision.analyzeEvent:malformed`,
              ]
            : [],
        detail: { state: e1.state, pendingReason: e1.pendingReason },
      });
      expect(e1.state).not.toBe('processing');
    },
  );

  it.failing(
    'MINIMIZED (LSF-6, expected-fail): the completed-session registry must equal snapshot() after the last post-end onUpdate throws',
    async () => {
      let throwNext = false;
      const flow = new LiveSessionFlow({
        sessionId: 'min-registry-lag',
        source: 'live',
        provider: makeProvider(
          new Map<number, EventFault>([
            [
              1,
              {
                availability: 'none',
                provider: 'slow',
                providerVariant: 0,
                clip: 'none',
                clipVariant: 0,
              },
            ],
          ]),
          mulberry32(1),
          { availability: 0, analyze: 0 },
        ),
        onUpdate: () => {
          if (throwNext) throw new InjectedFault('onUpdate', 'throw');
        },
      });
      for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
      flow.end();
      throwNext = true;
      await drain(WATCHDOG_MS);
      const live = flow.snapshot();
      const persisted = getCompletedSession('min-registry-lag');
      const diverges =
        persisted === null || canonicalJson(persisted) !== canonicalJson(live);
      outcomes.push({
        seed: -302,
        outcome: diverges ? 'BROKEN' : 'HELD',
        iterations: 1,
        faultsInjected: ['vision.analyzeEvent:slow', 'onUpdate:throw'],
        violations: diverges
          ? [
              'F5:completed_session_registry_diverges_from_live_snapshot(onUpdateFailures)',
            ]
          : [],
        detail: {
          liveOnUpdateFailures: live.onUpdateFailures,
          persistedOnUpdateFailures: persisted?.onUpdateFailures ?? null,
        },
      });
      expect(persisted).toEqual(live);
    },
  );

  it('MINIMIZED: an analysis outcome of {status:"ready", analysis:null} must not become a ready event', async () => {
    const faults = new Map<number, EventFault>([
      [
        1,
        {
          availability: 'none',
          provider: 'malformed',
          providerVariant: 3,
          clip: 'none',
          clipVariant: 0,
        },
      ],
    ]);
    const flow = new LiveSessionFlow({
      sessionId: 'min-malformed',
      source: 'live',
      provider: makeProvider(faults, mulberry32(1), {
        availability: 0,
        analyze: 0,
      }),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    await drain(WATCHDOG_MS);
    const e1 = flow.snapshot().events[0]!;
    expect(e1.state).not.toBe('ready');
    expect(e1.state).not.toBe('processing');
  });

  it('exercises every provider/clip fault mode at least once across the campaign', () => {
    const injected = new Set(outcomes.flatMap(o => o.faultsInjected));
    const missing: string[] = [];
    for (const mode of INJECTED_FAULT_MODES) {
      if (!injected.has(`vision.analyzeEvent:${mode}`))
        missing.push(`vision.analyzeEvent:${mode}`);
      if (!injected.has(`camera.clipSource:${mode}`))
        missing.push(`camera.clipSource:${mode}`);
    }
    for (const extra of [
      'vision.analyzeEvent:malformed_ready',
      'vision.availability:unavailable',
      'vision.availability:throw',
      'vision.availability:garbage',
      'onUpdate:throw',
      'tts:speak_false',
      'tts:speak_throws',
      'sample_stream:duplicate',
      'sample_stream:out_of_order',
      'lifecycle:background_gap',
      'lifecycle:sample_after_end',
    ]) {
      if (!injected.has(extra)) missing.push(extra);
    }
    expect(missing).toEqual([]);
    expect(injected.size).toBeGreaterThanOrEqual(25);
  });

  it('KNOWN_BROKEN classes still reproduce (delete the entry + close the finding when this fails)', () => {
    assertKnownBrokenStillReproduce(SUITE, outcomes, KNOWN_BROKEN);
  });
});
