/**
 * Pure UI-logic mapping tests for the session screens (MOBBIN brief §3):
 * timeline segment geometry, count-only technique distribution, honest state
 * resolution and event-card view building. No rendering — these functions
 * are pure by design so the screen stays a thin projection.
 */
import type { Session, SessionStrokeEvent } from '@pickle/analysis-pipeline';
import type { AnalysisRecord } from '@pickle/swing-domain';
import {
  buildEventViews,
  eventTechniqueFamily,
  formatSessionClock,
  resolveEventViewState,
  strokeFamilyForShotType,
  techniqueDistribution,
  timelineSegments,
  type SessionEventView,
} from '../src/flow/session';

function analysisRecordDouble(
  shotType: 'forehand_drive' | 'dink',
): AnalysisRecord {
  return {
    schemaVersion: 1,
    id: `analysis-${shotType}`,
    captureId: 'capture-1',
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

function view(partial: Partial<SessionEventView>): SessionEventView {
  return {
    eventId: 'E1',
    index: 0,
    startMs: 0,
    endMs: 500,
    peakMs: 250,
    durationMs: 500,
    peakSpeed: 1,
    paddleConfirmed: false,
    closeReason: 'settle',
    closedAtMs: 600,
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

function sessionEvent(
  eventId: string,
  bounds: { startMs: number; peakMs: number; endMs: number },
  overrides?: Partial<SessionStrokeEvent>,
): SessionStrokeEvent {
  return {
    eventId,
    proposal: {
      eventId,
      startMs: bounds.startMs,
      peakMs: bounds.peakMs,
      endMs: bounds.endMs,
      peakSpeed: 2,
      prominence: 3,
      source: 'wrist',
      confidence: 0.6,
      paddleConfirmed: false,
      paddlePeakMs: null,
      paddleSupport: 0,
    },
    closedAtMs: bounds.endMs + 100,
    closeReason: 'settle',
    state: 'pending',
    analysis: null,
    abstainReason: null,
    ...overrides,
  };
}

function sessionWith(
  events: SessionStrokeEvent[],
  notes: string[] = [],
): Session {
  return {
    sessionId: 'ui-session',
    target: {
      trackId: null,
      seedMode: null,
      lockedAtMs: null,
      confidence: null,
    },
    captureMeta: { startedAtIso: null, fps: null, source: 'replay' },
    events,
    modelVersions: {
      sessionEngine: 'test',
      strokeEvents: 'test',
      completion: 'test',
    },
    qualityState: {
      wristSamples: 100,
      paddleSamples: 0,
      droppedLateSamples: 0,
      lastSampleMs: 4000,
      notes,
    },
  };
}

describe('timelineSegments', () => {
  it('maps events to clamped fractions on the session time axis, in order', () => {
    const segments = timelineSegments(
      [
        view({ eventId: 'E1', startMs: 0, endMs: 1000 }),
        view({
          eventId: 'E2',
          startMs: 2000,
          endMs: 3000,
          family: 'drive',
          state: 'ready',
        }),
        view({ eventId: 'E3', startMs: 3500, endMs: 4200 }),
      ],
      4000,
    );
    expect(segments.map(s => s.eventId)).toEqual(['E1', 'E2', 'E3']);
    expect(segments[0]).toEqual({
      eventId: 'E1',
      startFraction: 0,
      endFraction: 0.25,
      family: null,
      state: 'pending',
    });
    expect(segments[1]!.startFraction).toBeCloseTo(0.5, 10);
    expect(segments[1]!.endFraction).toBeCloseTo(0.75, 10);
    expect(segments[1]!.family).toBe('drive');
    // Ends past the axis clamp to 1 — never overflow the strip.
    expect(segments[2]!.endFraction).toBe(1);
  });

  it('renders nothing on an empty/zero-length axis (no fake geometry)', () => {
    expect(timelineSegments([view({})], 0)).toEqual([]);
    expect(timelineSegments([], 4000)).toEqual([]);
  });
});

describe('techniqueDistribution (counts only)', () => {
  it('counts by family, known families first, unclassified last — never scores', () => {
    const chips = techniqueDistribution([
      view({ eventId: 'E1' }),
      view({ eventId: 'E2', family: 'drive', state: 'ready' }),
      view({ eventId: 'E3', family: 'drive', state: 'ready' }),
      view({ eventId: 'E4', family: 'dink', state: 'ready' }),
      view({ eventId: 'E5' }),
      view({ eventId: 'E6' }),
    ]);
    expect(chips).toEqual([
      { label: 'drive', family: 'drive', count: 2 },
      { label: 'dink', family: 'dink', count: 1 },
      { label: 'unclassified', family: null, count: 3 },
    ]);
    for (const chip of chips) {
      expect(Object.keys(chip).sort()).toEqual(['count', 'family', 'label']);
    }
  });

  it('is empty for an event-less session', () => {
    expect(techniqueDistribution([])).toEqual([]);
  });
});

describe('formatSessionClock', () => {
  it('formats m:ss from milliseconds', () => {
    expect(formatSessionClock(0)).toBe('0:00');
    expect(formatSessionClock(999)).toBe('0:00');
    expect(formatSessionClock(3871)).toBe('0:03');
    expect(formatSessionClock(65_000)).toBe('1:05');
    expect(formatSessionClock(600_000)).toBe('10:00');
    expect(formatSessionClock(-5)).toBe('0:00');
  });
});

describe('family + state resolution', () => {
  it('maps shot slugs to registry families (count-only chips)', () => {
    expect(strokeFamilyForShotType('forehand_drive')).toBe('drive');
    expect(strokeFamilyForShotType('backhand_drive')).toBe('drive');
    expect(strokeFamilyForShotType('dink')).toBe('dink');
    expect(strokeFamilyForShotType('volley')).toBe('volley');
    expect(strokeFamilyForShotType('serve')).toBe('serve');
  });

  it('derives a family ONLY from a completed analysis', () => {
    expect(
      eventTechniqueFamily({
        state: 'ready',
        analysis: analysisRecordDouble('forehand_drive'),
      }),
    ).toBe('drive');
    expect(
      eventTechniqueFamily({
        state: 'pending',
        analysis: analysisRecordDouble('forehand_drive'),
      }),
    ).toBeNull();
    expect(eventTechniqueFamily({ state: 'ready', analysis: null })).toBeNull();
  });

  it('a recorded pending reason overrides an optimistic processing mark', () => {
    expect(
      resolveEventViewState(
        'processing',
        'NATIVE_CLIP_EXTRACTION_NOT_BUILT',
        null,
      ),
    ).toBe('pending');
    expect(resolveEventViewState('processing', null, null)).toBe('processing');
    expect(
      resolveEventViewState(
        'ready',
        'stale-reason',
        analysisRecordDouble('dink'),
      ),
    ).toBe('ready');
    expect(resolveEventViewState('abstained', 'stale-reason', null)).toBe(
      'abstained',
    );
  });
});

describe('buildEventViews', () => {
  it('flags flush closes as boundary-uncertain and retro-suppressed events from engine notes', () => {
    const session = sessionWith(
      [
        sessionEvent('E1', { startMs: 67, peakMs: 300, endMs: 1401 }),
        sessionEvent(
          'E2',
          { startMs: 2703, peakMs: 3403, endMs: 3770 },
          { closeReason: 'flush' },
        ),
      ],
      [
        'SESSION_EVENT_RETRO_SUPPRESSED: E1 (peak 0.60 u/s at 300ms) is no longer proposed by the full-series batch (a later stroke raised the relative proposal floor); kept append-only, flagged',
      ],
    );
    const views = buildEventViews(
      session,
      new Map([['E1', 'NATIVE_CLIP_EXTRACTION_NOT_BUILT']]),
    );
    expect(views.length).toBe(2);
    expect(views[0]!.retroSuppressed).toBe(true);
    expect(views[0]!.boundaryUncertain).toBe(false);
    expect(views[0]!.state).toBe('pending');
    expect(views[0]!.pendingReason).toBe('NATIVE_CLIP_EXTRACTION_NOT_BUILT');
    expect(views[1]!.retroSuppressed).toBe(false);
    expect(views[1]!.boundaryUncertain).toBe(true);
    expect(views[1]!.durationMs).toBe(3770 - 2703);
    expect(views.map(v => v.index)).toEqual([0, 1]);
  });
});
