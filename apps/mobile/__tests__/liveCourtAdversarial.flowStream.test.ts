/**
 * ADVERSARIAL HARNESS — LiveSessionFlow + SessionEventEngine + native motion
 * feed + LiveSessionCoach, driven end to end by a seeded synthetic wrist-speed
 * stream (≥10k samples) with rapid / duplicate / out-of-order / malformed
 * deliveries, pause/resume gaps, stop mid-flight → summary.
 *
 * The native bridge is SIMULATED (same jest.mock shape as sessionNative.test);
 * the analysis provider is a state-machine double. Stroke recall numbers are
 * about the engine's segmentation of a SYNTHETIC profile, never about a
 * recorded rally or Apple runtime behaviour.
 *
 * Evidence: artifacts/live-court-adversarial/<run>/flow-stream/*.json
 */
jest.mock('react-native', () => {
  const listeners: Array<(event: object) => void> = [];
  const bridge = {
    capture: jest.fn(),
    importVideo: jest.fn(),
    cancel: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    startSessionCapture: jest.fn(),
    stopSessionCapture: jest.fn(),
    extractSessionEventClip: jest.fn(),
  };
  return {
    Platform: { OS: 'ios' },
    NativeModules: { PickleVideoCapture: bridge },
    NativeEventEmitter: class {
      addListener(_type: string, listener: (event: object) => void) {
        listeners.push(listener);
        return {
          remove: () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      }
    },
    __simulatedListeners: listeners,
  };
});

const { __simulatedListeners: mockListeners } = jest.requireMock(
  'react-native',
) as {
  __simulatedListeners: Array<(event: object) => void>;
};

import { LiveSessionCoach } from '../src/flow/liveSessionCoach';
import {
  LiveSessionFlow,
  getCompletedSession,
  type LiveSessionSnapshot,
  type SessionEventAnalysisProvider,
} from '../src/flow/session';
import { connectNativeSessionMotionFeed } from '../src/flow/sessionNative';
import { SessionEventEngine } from '@pickle/analysis-pipeline';
import { sessionScoreProgression } from '../src/flow/sessionProgress';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
} from '../src/flow/liveSessionSummary';
import {
  CLEAN_CHECKPOINTS,
  KNEE_FAULT,
  lowConfidenceAnalysis,
  scoredAnalysis,
} from '../harness/liveCourtAdversarial/doubles';
import {
  Evidence,
  heapSample,
  linearFit,
  nowMs,
} from '../harness/liveCourtAdversarial/evidence';
import { SeededRng } from '../harness/liveCourtAdversarial/prng';
import {
  DEFAULT_STROKE_PARAMS,
  MALFORMED_MOTION_KINDS,
  generateStrokeStream,
  malformedMotionEvent,
  mutateStream,
  toNativeEvent,
  type GeneratedStream,
} from '../harness/liveCourtAdversarial/streams';
import { RecordingVoicePort } from '../harness/liveCourtAdversarial/voicePorts';

declare const process: { env: Record<string, string | undefined> };

const evidence = new Evidence('flow-stream');
const STROKES = Number(process.env.LIVE_COURT_HARNESS_STROKES ?? 300);
const MIN_SAMPLES = Number(process.env.LIVE_COURT_HARNESS_EVENTS ?? 10_000);

function emit(event: unknown): void {
  for (const listener of [...mockListeners]) listener(event as object);
}

/** Deterministic provider double: scored / low-confidence / abstain by eventId hash. */
function makeProvider(
  seed: number,
  delayMs = 0,
): SessionEventAnalysisProvider & { calls: number } {
  const rng = new SeededRng(seed);
  const provider = {
    providerId: `adversarial-provider-${seed}`,
    calls: 0,
    availability: () => ({ status: 'available' as const }),
    async analyzeEvent(request: { eventId: string }) {
      provider.calls += 1;
      if (delayMs > 0)
        await new Promise<void>(resolve =>
          setTimeout(() => resolve(), delayMs),
        );
      const roll = rng.next();
      if (roll < 0.75) {
        const faults = rng.chance(0.5) ? [KNEE_FAULT] : [];
        return {
          status: 'ready' as const,
          analysis: scoredAnalysis(
            `analysis-${request.eventId}`,
            Math.round(rng.float(3, 9.6) * 10) / 10,
            [...CLEAN_CHECKPOINTS, ...faults],
          ),
        };
      }
      if (roll < 0.9) {
        return {
          status: 'ready' as const,
          analysis: lowConfidenceAnalysis(`analysis-${request.eventId}`),
        };
      }
      return { status: 'abstained' as const, abstainReason: 'POSE_TOO_SPARSE' };
    },
  };
  return provider;
}

function baseStream(seed: number, strokes = STROKES): GeneratedStream {
  return generateStrokeStream({ ...DEFAULT_STROKE_PARAMS, seed, strokes });
}

interface FlowRunResult {
  samplesPushed: number;
  closedEvents: number;
  plannedStrokes: number;
  finalSnapshot: LiveSessionSnapshot;
  coachCues: number;
  coachEventIds: string[];
  wallMs: number;
  perPushTable: Array<{
    samplesSoFar: number;
    eventsSoFar: number;
    meanPushUs: number;
    maxPushUs: number;
  }>;
}

async function runFlow(
  stream: GeneratedStream,
  sessionId: string,
  options: {
    provider?: SessionEventAnalysisProvider;
    withCoach?: boolean;
  } = {},
): Promise<
  FlowRunResult & { flow: LiveSessionFlow; coach: LiveSessionCoach | null }
> {
  const provider = options.provider ?? makeProvider(stream.params.seed);
  const port = new RecordingVoicePort();
  const coach =
    options.withCoach === false ? null : new LiveSessionCoach({ voice: port });
  const flow = new LiveSessionFlow({
    sessionId,
    source: 'live',
    provider,
    fps: stream.params.fps,
    onUpdate: snapshot => coach?.consumeSnapshot(snapshot),
  });
  coach?.sessionStarted('live');
  const perPushTable: FlowRunResult['perPushTable'] = [];
  let bucketStart = nowMs();
  let bucketMax = 0;
  let closed = 0;
  const t0 = nowMs();
  for (let index = 0; index < stream.samples.length; index += 1) {
    const sample = stream.samples[index];
    if (!sample) continue;
    const t = nowMs();
    closed += flow.pushSample(sample).length;
    const dt = nowMs() - t;
    bucketMax = Math.max(bucketMax, dt);
    if ((index + 1) % 2000 === 0) {
      const elapsed = nowMs() - bucketStart;
      perPushTable.push({
        samplesSoFar: index + 1,
        eventsSoFar: closed,
        meanPushUs: (elapsed * 1000) / 2000,
        maxPushUs: bucketMax * 1000,
      });
      bucketStart = nowMs();
      bucketMax = 0;
    }
  }
  flow.end();
  await flow.settled();
  const wallMs = nowMs() - t0;
  const finalSnapshot = flow.snapshot();
  const cues = coach?.recap().cues ?? [];
  return {
    flow,
    coach,
    samplesPushed: stream.samples.length,
    closedEvents: finalSnapshot.events.length,
    plannedStrokes: stream.plannedPeaksMs.length,
    finalSnapshot,
    coachCues: cues.length,
    coachEventIds: cues
      .map(c => c.eventId)
      .filter((id): id is string => id !== null),
    wallMs,
    perPushTable,
  };
}

function terminalIdsInOrder(snapshot: LiveSessionSnapshot): string[] {
  return snapshot.events
    .filter(e => e.state === 'ready' || e.state === 'abstained')
    .map(e => e.eventId);
}

describe('LiveSessionFlow adversarial motion stream', () => {
  beforeEach(() => {
    mockListeners.length = 0;
  });

  it(`F1 clean rapid stream (≥${MIN_SAMPLES} samples): segmentation, one coach cue per terminal event in event order, per-push cost scaling, heap`, async () => {
    const seed = 0xf10a01;
    const stream = baseStream(seed);
    const before = heapSample('F1 before');
    const run = await runFlow(stream, `adv-f1-${seed}`);
    const after = heapSample('F1 after');
    evidence.heapSnapshot('F1-after-flow');
    const terminal = terminalIdsInOrder(run.finalSnapshot);
    const fit = linearFit(
      run.perPushTable.map(row => ({ x: row.samplesSoFar, y: row.meanPushUs })),
    );
    const states: Record<string, number> = {};
    for (const event of run.finalSnapshot.events)
      states[event.state] = (states[event.state] ?? 0) + 1;
    const recall = run.closedEvents / run.plannedStrokes;
    evidence.writeJson('F1-clean-stream', {
      seed,
      params: stream.params,
      samples: run.samplesPushed,
      plannedStrokes: run.plannedStrokes,
      closedEvents: run.closedEvents,
      recallVsPlanned: recall,
      states,
      qualityNotes: run.finalSnapshot.qualityNotes.length,
      droppedLateSamples: run.finalSnapshot.droppedLateSamples,
      onUpdateFailures: run.finalSnapshot.onUpdateFailures,
      wallMs: run.wallMs,
      perPushTable: run.perPushTable,
      perPushFit: {
        ...fit,
        note: 'mean µs per pushSample vs samples pushed so far; slope > 0 with r² near 1 = per-frame cost grows with session length',
      },
      coachCues: run.coachCues,
      terminalEvents: terminal.length,
      coachOrderMatchesEventOrder:
        JSON.stringify(run.coachEventIds) === JSON.stringify(terminal),
      heap: {
        before,
        after,
        deltaHeapUsedMb: after.heapUsedMb - before.heapUsedMb,
      },
    });
    evidence.log(
      `F1 seed=${seed} samples=${run.samplesPushed} planned=${run.plannedStrokes} closed=${run.closedEvents} wall=${run.wallMs.toFixed(0)}ms lastMeanPushUs=${run.perPushTable.at(-1)?.meanPushUs.toFixed(1)}`,
    );
    expect(run.samplesPushed).toBeGreaterThanOrEqual(MIN_SAMPLES);
    expect(run.finalSnapshot.droppedLateSamples).toBe(0);
    expect(run.finalSnapshot.onUpdateFailures).toBe(0);
    expect(new Set(run.coachEventIds).size).toBe(run.coachEventIds.length);
    expect(run.coachEventIds.length).toBe(terminal.length);
    // Every closed event is terminal once settled (no event stuck processing).
    expect(states.processing ?? 0).toBe(0);
    expect(states.pending ?? 0).toBe(0);
    expect(recall).toBeGreaterThan(0.5);
  });

  it('F1b per-push cost attribution: bare SessionEventEngine vs LiveSessionFlow vs flow+coach on the same stream', async () => {
    const seed = 0xf10b01;
    const stream = baseStream(seed, Math.min(STROKES, 100));
    const bucket = 1000;
    const table: Record<
      string,
      Array<{ samplesSoFar: number; meanPushUs: number }>
    > = {};
    // (a) engine only
    {
      const engine = new SessionEventEngine({
        sessionId: 'attr-engine',
        captureMeta: { startedAtIso: null, fps: 30, source: 'live' },
      });
      const rows: Array<{ samplesSoFar: number; meanPushUs: number }> = [];
      let t = nowMs();
      stream.samples.forEach((sample, index) => {
        engine.pushWristSample({ timestampMs: sample.tMs, value: sample.v });
        if ((index + 1) % bucket === 0) {
          rows.push({
            samplesSoFar: index + 1,
            meanPushUs: ((nowMs() - t) * 1000) / bucket,
          });
          t = nowMs();
        }
      });
      engine.flush();
      table.engineOnly = rows;
    }
    // (b) flow without subscribers, (c) flow + coach
    for (const withCoach of [false, true]) {
      const rows: Array<{ samplesSoFar: number; meanPushUs: number }> = [];
      const coachSink = new LiveSessionCoach({
        voice: new RecordingVoicePort(),
      });
      const flow = new LiveSessionFlow({
        sessionId: `adv-f1b-${withCoach}-${seed}`,
        source: 'live',
        provider: makeProvider(seed),
        onUpdate: withCoach
          ? snapshot => coachSink.consumeSnapshot(snapshot)
          : undefined,
      });
      let t = nowMs();
      stream.samples.forEach((sample, index) => {
        flow.pushSample(sample);
        if ((index + 1) % bucket === 0) {
          rows.push({
            samplesSoFar: index + 1,
            meanPushUs: ((nowMs() - t) * 1000) / bucket,
          });
          t = nowMs();
        }
      });
      flow.end();
      await flow.settled();
      table[withCoach ? 'flowWithCoach' : 'flowNoSubscriber'] = rows;
    }
    const fits = Object.fromEntries(
      Object.entries(table).map(([name, rows]) => [
        name,
        linearFit(rows.map(r => ({ x: r.samplesSoFar, y: r.meanPushUs }))),
      ]),
    );
    evidence.writeJson('F1b-per-push-attribution', {
      seed,
      samples: stream.samples.length,
      bucket,
      table,
      fits,
    });
    evidence.log(
      `F1b samples=${stream.samples.length} slopes(us/sample): ${Object.entries(
        fits,
      )
        .map(([k, f]) => `${k}=${f.slope.toFixed(3)}`)
        .join(' ')}`,
    );
    expect(Object.keys(table)).toHaveLength(3);
  });

  it('F2 native feed under duplicate / out-of-order / malformed delivery: boundary counts, engine late drops, closed events vs clean baseline', async () => {
    const seed = 0xf10a02;
    const stream = baseStream(seed, Math.min(STROKES, 120));
    const clean = await runFlow(stream, `adv-f2-clean-${seed}`, {
      withCoach: false,
    });
    const captureId = 'capture-f2';
    const mutated = mutateStream(stream, captureId, {
      seed: seed ^ 0xffff,
      duplicateRate: 0.05,
      outOfOrderRate: 0.05,
      maxDelay: 8,
      malformedRate: 0.03,
    });
    const provider = makeProvider(seed);
    const port = new RecordingVoicePort();
    const coach = new LiveSessionCoach({ voice: port });
    const flow = new LiveSessionFlow({
      sessionId: `adv-f2-mutated-${seed}`,
      source: 'live',
      provider,
      onUpdate: snapshot => coach.consumeSnapshot(snapshot),
    });
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: captureId,
    });
    const t0 = nowMs();
    for (const entry of mutated.events) emit(entry.payload);
    flow.end();
    await flow.settled();
    const wallMs = nowMs() - t0;
    feed.disconnect();
    const final = flow.snapshot();
    // Malformed kinds that carry the right `type` but fail validation are the
    // ONLY ones the boundary counts (by contract); others are silently ignored
    // or are structurally valid.
    const countedKinds = new Set<string>([
      'tMs_nan',
      'tMs_negative',
      'tMs_string',
      'tMs_missing',
      'tMs_infinite',
      'v_nan',
      'v_negative',
      'v_string',
      'v_missing',
      'v_infinite',
      'captureId_number',
      'emittedAtIso_number',
    ]);
    const expectedCounted = Object.entries(mutated.log.malformedKinds)
      .filter(([kind]) => countedKinds.has(kind))
      .reduce((sum, [, n]) => sum + n, 0);
    const structurallyValidAdversarial =
      (mutated.log.malformedKinds.huge_v ?? 0) +
      (mutated.log.malformedKinds.tMs_far_future ?? 0);
    const terminal = terminalIdsInOrder(final);
    const coachIds = coach
      .recap()
      .cues.map(c => c.eventId)
      .filter((id): id is string => id !== null);
    const result = {
      seed,
      mutationSeed: seed ^ 0xffff,
      delivered: mutated.events.length,
      mutationLog: mutated.log,
      boundaryDroppedInvalid: feed.droppedInvalidSamples(),
      expectedBoundaryDrops: expectedCounted,
      structurallyValidAdversarial,
      engineDroppedLate: final.droppedLateSamples,
      duplicatesInjected: mutated.log.duplicatesInjected,
      outOfOrderMoves: mutated.log.outOfOrderMoves,
      closedEvents: final.events.length,
      cleanClosedEvents: clean.closedEvents,
      closedDeltaVsClean: final.events.length - clean.closedEvents,
      durationMs: final.durationMs,
      cleanDurationMs: clean.finalSnapshot.durationMs,
      maxPeakSpeed: Math.max(...final.events.map(e => e.peakSpeed)),
      cleanMaxPeakSpeed: Math.max(
        ...clean.finalSnapshot.events.map(e => e.peakSpeed),
      ),
      onUpdateFailures: final.onUpdateFailures,
      coachCues: coachIds.length,
      coachDuplicates: coachIds.length - new Set(coachIds).size,
      coachOrderMatchesEventOrder:
        JSON.stringify(coachIds) === JSON.stringify(terminal),
      wallMs,
    };
    evidence.writeJson('F2-native-feed-mutations', result);
    evidence.log(
      `F2 delivered=${result.delivered} boundaryDrops=${result.boundaryDroppedInvalid}/${expectedCounted} lateDrops=${result.engineDroppedLate} closed=${result.closedEvents} (clean ${clean.closedEvents}) duration=${result.durationMs} (clean ${result.cleanDurationMs}) maxPeak=${result.maxPeakSpeed}`,
    );
    expect(feed.droppedInvalidSamples()).toBe(expectedCounted);
    expect(final.onUpdateFailures).toBe(0);
    expect(result.coachDuplicates).toBe(0);
    expect(result.coachOrderMatchesEventOrder).toBe(true);
    // Out-of-order samples that land behind the frontier are dropped and
    // COUNTED — never silently. The count must be ≤ the moves we made (+dups
    // that landed behind the frontier).
    expect(final.droppedLateSamples).toBeLessThanOrEqual(
      mutated.log.outOfOrderMoves + mutated.log.duplicatesInjected,
    );
  });

  it('F3 single structurally-valid adversarial samples: far-future timestamp and huge speed — effect on summary duration, events, peak speed', async () => {
    const seed = 0xf10a03;
    const stream = baseStream(seed, 40);
    const clean = await runFlow(stream, `adv-f3-clean-${seed}`, {
      withCoach: false,
    });
    const rows: Array<Record<string, unknown>> = [];
    for (const kind of ['tMs_far_future', 'huge_v'] as const) {
      const captureId = `capture-f3-${kind}`;
      const flow = new LiveSessionFlow({
        sessionId: `adv-f3-${kind}-${seed}`,
        source: 'live',
        provider: makeProvider(seed),
      });
      const feed = connectNativeSessionMotionFeed(flow, {
        sessionCaptureId: captureId,
      });
      const injectAt = Math.floor(stream.samples.length / 2);
      let samplesAfterInjectionDropped = 0;
      stream.samples.forEach((sample, index) => {
        emit(toNativeEvent(sample, captureId));
        if (index === injectAt) {
          emit(malformedMotionEvent(sample, kind, captureId));
        }
      });
      const summary = flow.end();
      await flow.settled();
      feed.disconnect();
      samplesAfterInjectionDropped = summary.droppedLateSamples;
      rows.push({
        kind,
        durationMs: summary.durationMs,
        cleanDurationMs: clean.finalSnapshot.durationMs,
        durationInflatedBy: summary.durationMs - clean.finalSnapshot.durationMs,
        closedEvents: summary.events.length,
        cleanClosedEvents: clean.closedEvents,
        droppedLateSamples: samplesAfterInjectionDropped,
        maxPeakSpeed: Math.max(...summary.events.map(e => e.peakSpeed)),
        cleanMaxPeakSpeed: Math.max(
          ...clean.finalSnapshot.events.map(e => e.peakSpeed),
        ),
        boundaryDropped: feed.droppedInvalidSamples(),
        qualityNotes: summary.qualityNotes,
      });
    }
    evidence.writeJson('F3-valid-but-adversarial-samples', rows);
    for (const row of rows)
      evidence.log(
        `F3 ${String(row.kind)} duration=${String(row.durationMs)} (clean ${String(row.cleanDurationMs)}) closed=${String(row.closedEvents)} (clean ${String(row.cleanClosedEvents)}) late=${String(row.droppedLateSamples)} maxPeak=${String(row.maxPeakSpeed)}`,
      );
    // Both pass the boundary by contract (finite, non-negative).
    for (const row of rows) expect(row.boundaryDropped).toBe(0);

    // F3b — outlier sweep: ONE wrist-speed spike of k × the clean peak, injected
    // at the midpoint. How many of the remaining planned strokes still close?
    const cleanPeak = Math.max(
      ...clean.finalSnapshot.events.map(e => e.peakSpeed),
    );
    const injectAt = Math.floor(stream.samples.length / 2);
    const cleanAfter = clean.finalSnapshot.events.filter(
      e => e.startMs > (stream.samples[injectAt]?.tMs ?? 0),
    ).length;
    const sweep: Array<{
      multiplier: number;
      spikeV: number;
      closedTotal: number;
      closedAfterSpike: number;
      cleanClosedAfterSpike: number;
      retroSuppressedNotes: number;
    }> = [];
    for (const multiplier of [1.5, 2, 3, 5, 10, 100, 1_000, 1e6]) {
      const captureId = `capture-f3b-${multiplier}`;
      const flow = new LiveSessionFlow({
        sessionId: `adv-f3b-${multiplier}-${seed}`,
        source: 'live',
        provider: makeProvider(seed),
      });
      const feed = connectNativeSessionMotionFeed(flow, {
        sessionCaptureId: captureId,
      });
      const spikeV = cleanPeak * multiplier;
      stream.samples.forEach((sample, index) => {
        emit(toNativeEvent(sample, captureId));
        if (index === injectAt)
          emit({
            type: 'session_motion_sample',
            tMs: sample.tMs + 1,
            v: spikeV,
            captureId,
          });
      });
      const summary = flow.end();
      await flow.settled();
      feed.disconnect();
      const spikeMs = stream.samples[injectAt]?.tMs ?? 0;
      sweep.push({
        multiplier,
        spikeV,
        closedTotal: summary.events.length,
        closedAfterSpike: summary.events.filter(e => e.startMs > spikeMs + 1)
          .length,
        cleanClosedAfterSpike: cleanAfter,
        retroSuppressedNotes: summary.qualityNotes.filter(n =>
          n.startsWith('SESSION_EVENT_RETRO_SUPPRESSED'),
        ).length,
      });
    }
    evidence.writeJson('F3b-speed-outlier-sweep', {
      seed,
      cleanPeak,
      cleanClosed: clean.closedEvents,
      injectAtSample: injectAt,
      sweep,
    });
    evidence.log(
      `F3b cleanPeak=${cleanPeak.toFixed(3)} ` +
        sweep
          .map(
            s =>
              `x${s.multiplier}:${s.closedAfterSpike}/${s.cleanClosedAfterSpike}`,
          )
          .join(' '),
    );
    // Pin the reproduced failure mode: a single 1e6× spike leaves NO strokes
    // detected after it (the relative proposal floor is raised for the rest of the session).
    const extreme = sweep[sweep.length - 1];
    expect(extreme?.closedAfterSpike).toBe(0);
    expect(sweep.find(s => s.multiplier === 10)?.closedAfterSpike).toBe(0);
    expect(cleanAfter).toBeGreaterThan(10);
  });

  it('F4 pause/resume: background gap with continuing clock vs. clock reset on resume → what the engine keeps', async () => {
    const seed = 0xf10a04;
    const stream = baseStream(seed, 60);
    const half = Math.floor(stream.samples.length / 2);
    const first = stream.samples.slice(0, half);
    const second = stream.samples.slice(half);
    const rows: Array<Record<string, unknown>> = [];
    for (const mode of [
      'clock_continues_after_60s_gap',
      'clock_resets_on_resume',
    ] as const) {
      const flow = new LiveSessionFlow({
        sessionId: `adv-f4-${mode}-${seed}`,
        source: 'live',
        provider: makeProvider(seed),
      });
      for (const sample of first) flow.pushSample(sample);
      const midSnapshot = flow.snapshot();
      const offset =
        mode === 'clock_continues_after_60s_gap'
          ? 60_000
          : -(second[0]?.tMs ?? 0);
      for (const sample of second)
        flow.pushSample({ tMs: sample.tMs + offset, v: sample.v });
      const summary = flow.end();
      await flow.settled();
      rows.push({
        mode,
        eventsBeforePause: midSnapshot.events.length,
        eventsAfterResume: summary.events.length,
        durationMs: summary.durationMs,
        droppedLateSamples: summary.droppedLateSamples,
        secondHalfSamples: second.length,
        plannedStrokes: stream.plannedPeaksMs.length,
        qualityNotes: summary.qualityNotes,
      });
    }
    evidence.writeJson('F4-pause-resume', rows);
    for (const row of rows)
      evidence.log(
        `F4 ${String(row.mode)} before=${String(row.eventsBeforePause)} after=${String(row.eventsAfterResume)} late=${String(row.droppedLateSamples)} duration=${String(row.durationMs)}`,
      );
    const reset = rows.find(r => r.mode === 'clock_resets_on_resume');
    const cont = rows.find(r => r.mode === 'clock_continues_after_60s_gap');
    // Contract: late samples are dropped and COUNTED, never rewritten.
    expect(reset?.droppedLateSamples).toBeGreaterThan(0);
    expect(cont?.droppedLateSamples).toBe(0);
  });

  it('F5 stop mid-flight → summary: analyses settle after end(), registry/summary/coach recap agree, post-stop native emissions disconnect the feed', async () => {
    const seed = 0xf10a05;
    const stream = baseStream(seed, 80);
    const captureId = 'capture-f5';
    const provider = makeProvider(seed, 1);
    const port = new RecordingVoicePort();
    const coach = new LiveSessionCoach({ voice: port });
    const sessionId = `adv-f5-${seed}`;
    const flow = new LiveSessionFlow({
      sessionId,
      source: 'live',
      provider,
      onUpdate: s => coach.consumeSnapshot(s),
    });
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: captureId,
    });
    coach.sessionStarted('live');
    const stopAt = Math.floor(stream.samples.length * 0.7);
    stream.samples
      .slice(0, stopAt)
      .forEach(sample => emit(toNativeEvent(sample, captureId)));
    const atStop = flow.end();
    const inFlightAtStop = atStop.events.filter(
      e => e.state === 'processing',
    ).length;
    // Queued native emissions after stop.
    stream.samples
      .slice(stopAt, stopAt + 30)
      .forEach(sample => emit(toNativeEvent(sample, captureId)));
    const listenersAfterPostStop = mockListeners.length;
    await flow.settled();
    const settled = flow.snapshot();
    const registry = getCompletedSession(sessionId);
    const recap = coach.sessionEnded(settled);
    const progression = sessionScoreProgression(settled.events);
    const summary = buildLiveSessionSummaryRecord(settled, progression, recap);
    const reparsed = parseLiveSessionSummaryRecord(JSON.stringify(summary));
    const roundTripDiff = Object.entries(summary)
      .filter(
        ([key, value]) =>
          JSON.stringify(value) !==
          JSON.stringify(reparsed?.[key as keyof typeof summary]),
      )
      .map(([key, value]) => ({
        key,
        written: value,
        readBack: reparsed?.[key as keyof typeof summary] ?? null,
      }));
    const result = {
      seed,
      inFlightAtStop,
      eventsAtStop: atStop.events.length,
      eventsSettled: settled.events.length,
      statesSettled: settled.events.reduce<Record<string, number>>(
        (acc, e) => ((acc[e.state] = (acc[e.state] ?? 0) + 1), acc),
        {},
      ),
      registryMatchesSettled:
        JSON.stringify(registry) === JSON.stringify(settled),
      registryProcessing: registry?.events.filter(e => e.state === 'processing')
        .length,
      listenersAfterPostStop,
      boundaryDropped: feed.droppedInvalidSamples(),
      coachEventCues: recap.cues.filter(c => c.eventId !== null).length,
      terminalEvents: terminalIdsInOrder(settled).length,
      summary,
      summaryRoundTrips: JSON.stringify(reparsed) === JSON.stringify(summary),
      roundTripDiff,
      summaryCountsAddUp:
        summary.scoredCount + summary.noReadCount + summary.pendingCount ===
        summary.strokeCount,
    };
    evidence.writeJson('F5-stop-summary', result);
    evidence.log(
      `F5 inFlightAtStop=${inFlightAtStop} events=${result.eventsSettled} states=${JSON.stringify(result.statesSettled)} listeners=${listenersAfterPostStop}`,
    );
    expect(inFlightAtStop).toBeGreaterThan(0);
    expect(result.registryMatchesSettled).toBe(true);
    expect(result.registryProcessing).toBe(0);
    expect(listenersAfterPostStop).toBe(0);
    expect(feed.droppedInvalidSamples()).toBe(0);
    expect(result.coachEventCues).toBe(result.terminalEvents);
    // Pin the exact read-back divergence: a non-integer durationMs (30 fps → 33.333 ms
    // frames) is zeroed by the strict integer parser; every other field round-trips.
    expect(roundTripDiff.map(d => d.key)).toEqual(
      Number.isSafeInteger(summary.durationMs) ? [] : ['durationMs'],
    );
    if (!Number.isSafeInteger(summary.durationMs))
      expect(reparsed?.durationMs).toBe(0);
    expect(result.summaryCountsAddUp).toBe(true);
    expect(summary.cuesSpoken).toBe(recap.spokenCount);
  });

  it('F6 analysis unavailable (capability denied): every event stays honestly pending, coach stays silent, summary counts pending', async () => {
    const seed = 0xf10a06;
    const stream = baseStream(seed, 40);
    const provider: SessionEventAnalysisProvider = {
      providerId: 'adversarial-denied',
      availability: () => ({
        status: 'unavailable',
        pendingReason: 'ANALYSIS_CAPABILITY_DENIED',
      }),
      analyzeEvent: async () => ({
        status: 'pending',
        pendingReason: 'ANALYSIS_CAPABILITY_DENIED',
      }),
    };
    const run = await runFlow(stream, `adv-f6-${seed}`, { provider });
    const progression = sessionScoreProgression(run.finalSnapshot.events);
    const summary = buildLiveSessionSummaryRecord(
      run.finalSnapshot,
      progression,
      run.coach?.recap() ?? null,
    );
    evidence.writeJson('F6-capability-denied', {
      seed,
      closedEvents: run.closedEvents,
      pendingReasons: [
        ...new Set(run.finalSnapshot.events.map(e => e.pendingReason)),
      ],
      coachCues: run.coachCues,
      summary,
    });
    expect(
      run.finalSnapshot.events.every(
        e =>
          e.state === 'pending' &&
          e.pendingReason === 'ANALYSIS_CAPABILITY_DENIED',
      ),
    ).toBe(true);
    expect(run.coachEventIds).toEqual([]);
    expect(summary.pendingCount).toBe(run.closedEvents);
    expect(summary.scoredCount).toBe(0);
  });

  it('F7 throwing onUpdate subscriber at scale: counted, isolated, feed and states intact', async () => {
    const seed = 0xf10a07;
    const stream = baseStream(seed, 60);
    let calls = 0;
    const flow = new LiveSessionFlow({
      sessionId: `adv-f7-${seed}`,
      source: 'live',
      provider: makeProvider(seed),
      onUpdate: () => {
        calls += 1;
        if (calls % 7 === 0) throw new Error('subscriber failure');
      },
    });
    for (const sample of stream.samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();
    const final = flow.snapshot();
    evidence.writeJson('F7-throwing-subscriber', {
      seed,
      onUpdateCalls: calls,
      onUpdateFailures: final.onUpdateFailures,
      events: final.events.length,
      processing: final.events.filter(e => e.state === 'processing').length,
    });
    expect(final.onUpdateFailures).toBe(Math.floor(calls / 7));
    expect(final.events.filter(e => e.state === 'processing')).toHaveLength(0);
  });

  it('F8 memory growth: completed-session registry across many stop → summary cycles (module-level Map, never evicted)', async () => {
    const sessions = 150;
    const samples: Array<{ sessions: number; heapUsedMb: number }> = [];
    const base = heapSample('F8 start');
    samples.push({ sessions: 0, heapUsedMb: base.heapUsedMb });
    for (let s = 1; s <= sessions; s += 1) {
      const stream = baseStream(0xf10a08 + s, 12);
      const flow = new LiveSessionFlow({
        sessionId: `adv-f8-${s}`,
        source: 'live',
        provider: makeProvider(s),
      });
      for (const sample of stream.samples) flow.pushSample(sample);
      flow.end();
      await flow.settled();
      if (s % 50 === 0)
        samples.push({
          sessions: s,
          heapUsedMb: heapSample(`F8 ${s}`).heapUsedMb,
        });
    }
    evidence.heapSnapshot('F8-registry-after');
    const first = samples[0];
    const last = samples[samples.length - 1];
    const growthMb = first && last ? last.heapUsedMb - first.heapUsedMb : 0;
    evidence.writeJson('F8-completed-session-registry-growth', {
      sessions,
      gcForced: base.gcForced,
      samples,
      growthMb,
      perSessionKb: (growthMb * 1024) / sessions,
      firstStillRetained: getCompletedSession('adv-f8-1') !== null,
    });
    evidence.log(
      `F8 sessions=${sessions} growth=${growthMb.toFixed(3)}MB gc=${base.gcForced}`,
    );
    expect(getCompletedSession('adv-f8-1')).not.toBeNull();
  });

  it('F9 malformed payload matrix at the native boundary (every kind, isolated)', () => {
    const rows = MALFORMED_MOTION_KINDS.map(kind => {
      const captureId = `capture-f9-${kind}`;
      const flow = new LiveSessionFlow({
        sessionId: `adv-f9-${kind}`,
        source: 'live',
        provider: makeProvider(1),
      });
      const feed = connectNativeSessionMotionFeed(flow, {
        sessionCaptureId: captureId,
      });
      let threw: string | null = null;
      try {
        emit(malformedMotionEvent({ tMs: 1000, v: 0.5 }, kind, captureId));
      } catch (error) {
        threw = error instanceof Error ? error.message : String(error);
      }
      const snapshot = flow.snapshot();
      feed.disconnect();
      return {
        kind,
        threw,
        boundaryDropped: feed.droppedInvalidSamples(),
        reachedEngine: snapshot.durationMs > 0,
        durationMs: snapshot.durationMs,
      };
    });
    evidence.writeJson('F9-native-boundary-matrix', rows);
    for (const row of rows) expect(row.threw).toBeNull();
    const reached = rows
      .filter(r => r.reachedEngine)
      .map(r => r.kind)
      .sort();
    expect(reached).toEqual(['huge_v', 'tMs_far_future']);
  });
});
