/**
 * Session flow tests — replay-driven against the RECORDED dev rally
 * (afn-sasebo-rally1), using the static fixture exported by
 * datasets/experiments/wave-b/W6-fixture-gen.ts from workstream E's exact
 * replay reconstruction. No run directories are read at jest time.
 *
 * What is pinned here:
 *  - E1/E2/E3 emission order with the EXACT recorded bounds + close reasons
 *    (settle → next_stroke_valley → flush), closedAt ≤ endMs + 2500ms;
 *  - append-only arrival: closed events never change or reorder mid-stream;
 *  - honest per-event states: the shipped stub provider leaves every event
 *    'pending' with reason NATIVE_CLIP_EXTRACTION_NOT_BUILT — no fake results;
 *  - the analysis seam state machine (processing → ready/abstained) with
 *    test-double providers (state-machine doubles, never product results).
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { ShotTypeSlug } from '@pickle/shared-types';
import {
  DEV_REPLAY_RALLY,
  LiveSessionFlow,
  NATIVE_CLIP_EXTRACTION_NOT_BUILT,
  SESSION_CLOSE_SAFETY_MS,
  createPendingStubAnalysisProvider,
  getCompletedSession,
  nativeSessionMotionFeedAvailability,
  type SessionEventAnalysisProvider,
  type SessionMotionSample,
} from '../src/flow/session';
import fixture from './fixtures/sessionReplay.afn-sasebo-rally1.json';

const samples: SessionMotionSample[] = fixture.wristSamples;

function makeFlow(
  provider: SessionEventAnalysisProvider,
  sessionId = `session-${Math.random().toString(36).slice(2)}`,
  onUpdate?: (snapshot: ReturnType<LiveSessionFlow['snapshot']>) => void,
) {
  return new LiveSessionFlow({
    sessionId,
    source: 'replay',
    startedAtIso: '2026-01-01T00:00:00.000Z',
    provider,
    ...(onUpdate ? { onUpdate } : {}),
  });
}

/** Minimal AnalysisRecord STATE-MACHINE DOUBLE. Only the seam is under test;
 * real records come exclusively from the canonical pipeline. */
function analysisRecordDouble(
  id: string,
  shotType: ShotTypeSlug,
): AnalysisRecord {
  return {
    schemaVersion: 1,
    id,
    captureId: `capture-${id}`,
    createdAtIso: '2026-01-01T00:00:00.000Z',
    engineVersion: 'test-double',
    strokeTaxonomyVersion: 'test-double',
    strokeResolution: { kind: 'declared', shotType },
    modalities: {
      pose: true,
      paddle: false,
      ball: false,
      court: false,
      camera: false,
    },
    modelRuns: [],
    result: null,
    faults: [],
    uncertainty: {
      analysisConfidence: 0,
      presentation: 'abstain',
      perCheckpoint: {},
      limitingFactors: ['TEST_DOUBLE'],
    },
    evidence: [],
    shadow: [],
  };
}

describe('replay-driven session flow (recorded rally afn-sasebo-rally1)', () => {
  it('the embedded dev replay series is byte-equivalent to the generated fixture', () => {
    // Guards the copy inside src/flow/session.ts against drift from the
    // fixture both are generated from.
    expect(DEV_REPLAY_RALLY.runId).toBe(fixture.runId);
    expect([...DEV_REPLAY_RALLY.samples]).toEqual(samples);
  });

  it('emits E1/E2/E3 in order with the exact recorded bounds, reasons and closure times', async () => {
    const flow = makeFlow(createPendingStubAnalysisProvider());
    const closed: Array<{
      eventId: string;
      startMs: number;
      peakMs: number;
      endMs: number;
      closeReason: string;
      closedAtMs: number;
    }> = [];
    for (const sample of samples) {
      for (const event of flow.pushSample(sample)) {
        closed.push({
          eventId: event.eventId,
          startMs: event.proposal.startMs,
          peakMs: event.proposal.peakMs,
          endMs: event.proposal.endMs,
          closeReason: event.closeReason,
          closedAtMs: event.closedAtMs,
        });
      }
    }
    const final = flow.end();
    await flow.settled();
    for (const event of final.events.slice(closed.length)) {
      closed.push({
        eventId: event.eventId,
        startMs: event.startMs,
        peakMs: event.peakMs,
        endMs: event.endMs,
        closeReason: event.closeReason,
        closedAtMs: event.closedAtMs,
      });
    }
    expect(closed).toEqual(fixture.expectedEmissions);
    expect(closed.map(event => event.closeReason)).toEqual([
      'settle',
      'next_stroke_valley',
      'flush',
    ]);
    for (const event of closed) {
      expect(event.closedAtMs).toBeLessThanOrEqual(
        event.endMs + SESSION_CLOSE_SAFETY_MS,
      );
    }
    // Every batch-proposed event was emitted with matching bounds.
    expect(closed.map(({ startMs, peakMs, endMs }) => ({ startMs, peakMs, endMs }))).toEqual(
      fixture.batchProposals.map(({ startMs, peakMs, endMs }) => ({
        startMs,
        peakMs,
        endMs,
      })),
    );
  });

  it('event arrival is append-only: closed events never change or reorder mid-stream', () => {
    const flow = makeFlow(createPendingStubAnalysisProvider());
    const seen = new Map<string, string>();
    let previousCount = 0;
    for (const sample of samples) {
      flow.pushSample(sample);
      const events = flow.snapshot().events;
      expect(events.length).toBeGreaterThanOrEqual(previousCount);
      previousCount = events.length;
      events.forEach((event, index) => {
        expect(event.eventId).toBe(`E${index + 1}`);
        const shape = JSON.stringify({
          startMs: event.startMs,
          peakMs: event.peakMs,
          endMs: event.endMs,
          closeReason: event.closeReason,
          closedAtMs: event.closedAtMs,
        });
        const before = seen.get(event.eventId);
        if (before !== undefined) expect(shape).toBe(before);
        seen.set(event.eventId, shape);
      });
    }
  });

  it('stub provider: every event stays honestly pending with NATIVE_CLIP_EXTRACTION_NOT_BUILT', async () => {
    const sessionId = 'stub-session-1';
    const flow = makeFlow(createPendingStubAnalysisProvider(), sessionId);
    for (const sample of samples) flow.pushSample(sample);
    const final = flow.end();
    await flow.settled();
    expect(final.phase).toBe('ended');
    expect(final.strokeCount).toBe(3);
    expect(final.durationMs).toBe(samples[samples.length - 1]!.tMs);
    for (const event of final.events) {
      expect(event.state).toBe('pending');
      expect(event.pendingReason).toBe(NATIVE_CLIP_EXTRACTION_NOT_BUILT);
      expect(event.analysis).toBeNull();
      expect(event.family).toBeNull();
    }
    // Count-only distribution: everything honestly unclassified.
    expect(final.distribution).toEqual([
      { label: 'unclassified', family: null, count: 3 },
    ]);
    // flush-closed trailing event is flagged boundary-uncertain.
    expect(final.events[2]!.boundaryUncertain).toBe(true);
    expect(final.events[0]!.boundaryUncertain).toBe(false);
    // The ended snapshot is registered for LiveSummary.
    expect(getCompletedSession(sessionId)?.strokeCount).toBe(3);
    expect(getCompletedSession(sessionId)?.phase).toBe('ended');
    // No samples may follow the flush.
    expect(() => flow.pushSample({ tMs: 9000, v: 1 })).toThrow(
      /already ended/,
    );
  });

  it('available provider: events transition processing → ready and families count in the distribution', async () => {
    const stateTrail = new Map<string, string[]>();
    const provider: SessionEventAnalysisProvider = {
      providerId: 'test-ready-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async request => ({
        status: 'ready',
        analysis: analysisRecordDouble(
          `analysis-${request.eventId}`,
          'forehand_drive',
        ),
      }),
    };
    const flow = makeFlow(provider, 'ready-session-1', snapshot => {
      for (const event of snapshot.events) {
        const trail = stateTrail.get(event.eventId) ?? [];
        if (trail[trail.length - 1] !== event.state) {
          trail.push(event.state);
          stateTrail.set(event.eventId, trail);
        }
      }
    });
    for (const sample of samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();
    const final = flow.snapshot();
    for (const event of final.events) {
      expect(event.state).toBe('ready');
      expect(event.analysis?.id).toBe(`analysis-${event.eventId}`);
      expect(event.family).toBe('drive');
      // Observable lifecycle: processing before ready, never fake-pending.
      expect(stateTrail.get(event.eventId)).toEqual(['processing', 'ready']);
    }
    expect(final.distribution).toEqual([
      { label: 'drive', family: 'drive', count: 3 },
    ]);
  });

  it('abstaining and failing providers land in honest abstained states', async () => {
    const provider: SessionEventAnalysisProvider = {
      providerId: 'test-mixed-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async request => {
        if (request.eventId === 'E1') {
          return {
            status: 'abstained',
            abstainReason: 'CONTACT_DISAGREEMENT: spread 380ms',
          };
        }
        if (request.eventId === 'E2') {
          throw new Error('permit service unreachable');
        }
        return {
          status: 'pending',
          pendingReason: 'PER_EVENT_CLIP_MISSING',
        };
      },
    };
    const flow = makeFlow(provider, 'mixed-session-1');
    for (const sample of samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();
    const [e1, e2, e3] = flow.snapshot().events;
    expect(e1!.state).toBe('abstained');
    expect(e1!.abstainReason).toContain('CONTACT_DISAGREEMENT');
    expect(e2!.state).toBe('abstained');
    expect(e2!.abstainReason).toContain('ANALYSIS_DISPATCH_FAILED');
    expect(e2!.abstainReason).toContain('permit service unreachable');
    // A provider that could not start resolves back to honest 'pending'.
    expect(e3!.state).toBe('pending');
    expect(e3!.pendingReason).toBe('PER_EVENT_CLIP_MISSING');
  });

  it('the native motion feed reports its gap honestly', () => {
    const availability = nativeSessionMotionFeedAvailability();
    expect(availability.available).toBe(false);
    if (!availability.available) {
      expect(availability.gap).toBe('NATIVE_SESSION_MOTION_STREAM_NOT_BUILT');
      expect(availability.detail).toContain('session_motion_sample');
    }
  });
});
