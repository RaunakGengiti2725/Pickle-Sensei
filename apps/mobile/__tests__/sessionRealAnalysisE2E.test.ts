/**
 * G21 — mobile session E2E: the REAL LiveSessionFlow driving the REAL
 * analyzeCapture fusion pipeline per closed event, then the REAL Result-route
 * evidence loader reading the stored record back by the SAME analysisId the
 * event card navigates with.
 *
 * The user-facing claim under test: a session user tapping a READY event
 * receives the ACTUAL per-event analysis content (scored result, evidence,
 * provenance) — not just a state chip. The only non-production seams are the
 * inputs: the recorded dev-split wrist stream (fixture) and a deterministic
 * generated pose sequence standing in for native per-event clip extraction,
 * which does not exist on this box (NATIVE_CLIP_EXTRACTION gap, D-040).
 */
import { generateSwingSequence } from '@pickle/evaluation';
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from '@pickle/scoring';
import { unavailable } from '@pickle/swing-domain';
import {
  GeometricPhaseSegmenter,
  GeometryBiomechanicsExtractor,
} from '@pickle/vision-geometry';
import {
  analyzeCapture,
  FUSION_ENGINE_VERSION,
  type FusionProviders,
} from '@pickle/analysis-pipeline';
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { LocalDb } from '../src/data/db';
import { loadStrokeResultEvidence } from '../src/components/strokeResultData';
import {
  LiveSessionFlow,
  type SessionEventAnalysisProvider,
  type SessionMotionSample,
} from '../src/flow/session';
import fixture from './fixtures/sessionReplay.afn-sasebo-rally1.json';

const samples: SessionMotionSample[] = fixture.wristSamples;

const TRIGGER_MODEL = {
  providerId: 'trigger.temporal-heuristic',
  modelVersion: 'temporal-stroke-heuristic-2',
  runtime: 'deterministic' as const,
  executionTarget: 'on_device' as const,
  artifactHash: null,
};

function fusionProviders(): FusionProviders {
  return {
    phase: new GeometricPhaseSegmenter({ aspectRatio: 1 }),
    biomechanics: new GeometryBiomechanicsExtractor(),
    scorer: new Sm1TechniqueScorer(),
    faultDetector: new CheckpointThresholdFaultDetector(),
    uncertainty: new EngineUncertaintyEstimator(),
    coach: new PriorityCoachingRanker(),
    classifier: null,
    shadowScorers: [],
  };
}

/** Provider running the REAL fusion analysis for each event; every produced
 * record is kept so the Result-route loader can be checked against it. */
function realFusionProvider(store: Map<string, AnalysisRecord>): {
  provider: SessionEventAnalysisProvider;
} {
  let counter = 0;
  const provider: SessionEventAnalysisProvider = {
    providerId: 'g21-real-fusion-provider',
    availability: () => ({ status: 'available' }),
    analyzeEvent: async request => {
      const { sequence, window } = generateSwingSequence();
      const result = await analyzeCapture(
        fusionProviders(),
        {
          captureId: `capture-${request.eventId}`,
          pose: sequence,
          paddle: unavailable('paddle_detector_not_installed'),
          ball: unavailable('ball_tracker_not_installed'),
          trigger: {
            startMs: window.startMs,
            endMs: window.endMs,
            peakMotionMs: window.peakMs,
            confidence: request.proposal.confidence,
            producedBy: TRIGGER_MODEL,
          },
          stroke: { declared: 'forehand_drive', predicted: null },
          handedness: 'right',
          cameraView: 'side',
          capturedAtIso: '2026-08-29T12:00:00.000Z',
        },
        {
          analysisId: `analysis-${request.eventId}`,
          sessionId: request.sessionId,
          appVersion: '0.1.0',
          modelBundleVersion: 'fusion-test',
          nowIso: () => '2026-08-29T12:30:00.000Z',
          makeId: () => `run-${request.eventId}-${++counter}`,
        },
      );
      if (!result.ok) {
        return { status: 'pending', pendingReason: result.failure.code };
      }
      store.set(result.value.id, result.value);
      return { status: 'ready', analysis: result.value };
    },
  };
  return { provider };
}

/** LocalDb double backed by the records the provider actually produced —
 * the same JSON row shape the canonical path persists. */
function dbFromRecords(store: Map<string, AnalysisRecord>): LocalDb {
  return {
    async execute(sql: string, params?: unknown[]) {
      if (sql.includes('FROM local_analysis_record')) {
        const id = String(params?.[1] ?? '');
        const record = store.get(id);
        return { rows: record ? [{ record: JSON.stringify(record) }] : [] };
      }
      return { rows: [] };
    },
    close() {},
  };
}

describe('G21 mobile session E2E — real per-event analysis reaches the Result route', () => {
  it('every fixture event becomes ready with the ACTUAL scored record, and the Result loader returns that content by the routed analysisId', async () => {
    const store = new Map<string, AnalysisRecord>();
    const { provider } = realFusionProvider(store);
    const flow = new LiveSessionFlow({
      sessionId: 'g21-mobile-e2e',
      source: 'replay',
      provider,
    });
    for (const sample of samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();

    const events = flow.snapshot().events;
    expect(events.map(event => event.eventId)).toEqual(
      fixture.expectedEmissions.map(
        (emission: { eventId: string }) => emission.eventId,
      ),
    );
    expect(events.length).toBeGreaterThan(0);

    const db = dbFromRecords(store);
    for (const event of events) {
      // Not just a chip: the event view holds the real record …
      expect(event.state).toBe('ready');
      const analysis = event.analysis!;
      expect(analysis.engineVersion).toBe(FUSION_ENGINE_VERSION);
      expect(analysis.result?.resultKind).toBe('scored');
      expect(analysis.result?.overallScore).not.toBeNull();
      expect(analysis.evidence.length).toBeGreaterThan(0);
      // … the family chip derives from that record, not from a default …
      expect(event.family).toBe('drive');

      // … and the Result route (navigate('Result', { analysisId })) loads
      // the SAME content back from the store by that id.
      const evidence = await loadStrokeResultEvidence(db, analysis.id);
      expect(evidence.record).not.toBeNull();
      expect(evidence.record!.id).toBe(analysis.id);
      expect(evidence.record!.result?.overallScore).toBe(
        analysis.result?.overallScore,
      );
      expect(evidence.record!.uncertainty?.analysisConfidence).toBe(
        analysis.uncertainty.analysisConfidence,
      );
    }

    // The distribution the user sees counts the real families.
    const distribution = flow.snapshot().distribution;
    expect(distribution).toEqual([
      { family: 'drive', label: 'drive', count: events.length },
    ]);
  });
});
