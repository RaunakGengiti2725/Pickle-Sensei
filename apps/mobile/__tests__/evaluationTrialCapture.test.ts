/**
 * Evaluation-trial capture (Wave G2 h07): consent gating, honest claim
 * mapping, and outbox upload of 'evaluation.trial' rows.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import { validateEvaluationTrial } from '@pickle/shared-types';
import type { CaptureAnalysisRecord } from '@pickle/analysis-pipeline';
import type { CaptureAnalysisOutcome } from '../src/analysis/runCaptureAnalysis';
import type { LocalDb } from '../src/data/db';
import { drainOutbox, type SyncTransport } from '../src/data/sync';
import {
  buildEvaluationTrial,
  recordEvaluationTrial,
  type EvaluationTelemetryContext,
} from '../src/evaluation/trialCapture';
import { GUEST_DATA_OWNER, setActiveDataOwner } from '../src/data/accountScope';

const shotResult: ShotAnalysis = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sessionId: 'sess-1',
  shotType: 'dink',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-29T00:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 450, endMs: 900 },
  phases: [
    {
      key: 'prepare',
      startMs: 0,
      representativeMs: 150,
      endMs: 300,
      confidence: 0.9,
    },
    {
      key: 'contact',
      startMs: 300,
      representativeMs: 450,
      endMs: 500,
      confidence: 0.9,
    },
    {
      key: 'follow_through',
      startMs: 500,
      representativeMs: 700,
      endMs: 900,
      confidence: 0.9,
    },
  ],
  measurements: [],
  checkpoints: [],
  overallScore: 7.2,
  analysisConfidence: 0.85,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'on-device-fusion-1',
    poseModelVersion: 'pose-1',
    paddleModelVersion: 'none',
    strokeDetectorVersion: 'stroke-1',
    phaseModelVersion: 'phase-1',
    scoringModelVersion: 'score-1',
    shotConfigVersion: 'dink-1',
  },
  source: 'real',
};

const record: CaptureAnalysisRecord = {
  schemaVersion: 1,
  id: 'an-1',
  captureId: 'cap-1',
  createdAtIso: '2026-08-29T00:00:01.000Z',
  engineVersion: 'fusion-1',
  strokeTaxonomyVersion: 'v3',
  strokeResolution: { kind: 'predicted', shotType: 'dink', confidence: 0.8 },
  modalities: {
    pose: true,
    paddle: false,
    ball: false,
    court: false,
    camera: true,
  },
  modelRuns: [],
  provenance: {
    appVersion: '0.1.0',
    pipelineVersion: 'fusion-1',
    providerVersions: [
      {
        providerId: 'pose.apple-vision',
        modelVersion: 'pose-1',
        runtime: 'vision_framework',
        executionTarget: 'on_device',
        artifactHash: null,
      },
    ],
    scoreVersion: 'score-1',
    taxonomyVersion: 'v3',
    drillMappingVersion: 'none',
    captureEnvelopeVersion: 'capture-envelope-not-measured',
    recordedAtIso: '2026-08-29T00:00:01.000Z',
  },
  result: shotResult,
  faults: [],
  uncertainty: {
    analysisConfidence: 0.85,
    presentation: 'normal',
    perCheckpoint: {},
    limitingFactors: ['paddle_unavailable'],
  },
  evidence: [],
  shadow: [],
  strokeIntent: {
    declaredStroke: null,
    predictedStroke: null,
    resolutionBasis: 'predicted_l3',
    resolvedProfileId: null,
    resolvedProfileVersion: null,
    disagreement: null,
  },
  captureEnvelope: null,
};

const scored: CaptureAnalysisOutcome = {
  kind: 'scored',
  analysisId: 'an-1',
  record,
  freeLimitReached: false,
};

const context: EvaluationTelemetryContext = {
  consentActive: true,
  dims: {
    userPseudonym: 'u1',
    sessionId: 'sess-1',
    courtId: null,
    deviceModel: 'iPhone15,2',
    devicePlatform: 'ios',
    osVersion: '17.5',
  },
};

function buildInput(outcome: CaptureAnalysisOutcome, ctx = context) {
  return {
    outcome,
    captureId: 'cap-1',
    capturedAtIso: '2026-08-29T00:00:00.000Z',
    declaredStroke: null,
    latencyMs: 1200,
    appVersion: '0.1.0',
    context: ctx,
    nowIso: () => '2026-08-29T00:00:02.000Z',
  };
}

describe('buildEvaluationTrial', () => {
  it('returns null without active consent — no record, no exception', () => {
    expect(
      buildEvaluationTrial(
        buildInput(scored, { ...context, consentActive: false }),
      ),
    ).toBeNull();
  });

  it('maps a scored outcome to presented claims and passes contract validation', () => {
    const trial = buildEvaluationTrial(buildInput(scored));
    expect(trial).not.toBeNull();
    expect(validateEvaluationTrial(trial)).toEqual({ ok: true, errors: [] });
    expect(trial!.outcomeKind).toBe('scored');
    expect(trial!.claims.resultScore.status).toBe('presented');
    expect(trial!.claims.resultScore.presentation).toBe('normal');
    expect(trial!.claims.strokeLabel).toEqual({
      status: 'presented',
      label: 'dink',
      confidence: 0.8,
    });
    expect(trial!.claims.contactMarker.estimatedContactMs).toBe(450);
    expect(trial!.claims.targetLock.status).toBe('not_measured');
    expect(trial!.limitingFactors).toEqual(['paddle_unavailable']);
    expect(trial!.consent.scope).toBe('evaluation_telemetry');
  });

  it('records honest abstention claims for quality_blocked and unavailable outcomes', () => {
    const blocked = buildEvaluationTrial(
      buildInput({
        kind: 'quality_blocked',
        reason: 'unsupported envelope',
        envelope: { overall: 'UNSUPPORTED', dimensions: [] } as never,
        poseQualityReasons: [],
      }),
    );
    expect(blocked!.outcomeKind).toBe('quality_blocked');
    expect(blocked!.envelopeOverall).toBe('UNSUPPORTED');
    expect(blocked!.analysisId).toBeNull();
    expect(blocked!.claims.resultScore.status).toBe('abstained');
    expect(validateEvaluationTrial(blocked)).toEqual({ ok: true, errors: [] });

    const unavailable = buildEvaluationTrial(
      buildInput({ kind: 'unavailable', reason: 'no pose sequence' }),
    );
    expect(unavailable!.outcomeReason).toBe('no pose sequence');
    expect(validateEvaluationTrial(unavailable)).toEqual({
      ok: true,
      errors: [],
    });
  });
});

describe('evaluation.trial outbox sync', () => {
  function fakeDb() {
    interface OutboxRow {
      id: number;
      owner_key: string;
      kind: string;
      payload: string;
      attempts: number;
      last_error: string | null;
    }
    const outbox: OutboxRow[] = [];
    let nextId = 1;
    const db: LocalDb = {
      async execute(sql: string, params: unknown[] = []) {
        if (sql.includes('INSERT INTO outbox')) {
          outbox.push({
            id: nextId++,
            owner_key: String(params[0]),
            kind: 'evaluation.trial',
            payload: String(params[1]),
            attempts: 0,
            last_error: null,
          });
          return { rows: [] };
        }
        if (sql.startsWith('SELECT id, kind, payload')) {
          return {
            rows: outbox
              .filter(
                r =>
                  r.owner_key === String(params[0]) &&
                  r.attempts < Number(params[1]),
              )
              .map(r => ({ ...r })),
          };
        }
        if (sql.startsWith('DELETE FROM outbox')) {
          const idx = outbox.findIndex(
            r => r.owner_key === params[0] && r.id === params[1],
          );
          if (idx >= 0) outbox.splice(idx, 1);
          return { rows: [] };
        }
        if (sql.startsWith('UPDATE outbox')) {
          const row = outbox.find(
            r => r.owner_key === params[1] && r.id === params[2],
          );
          if (row) {
            row.attempts += 1;
            row.last_error = String(params[0]);
          }
          return { rows: [] };
        }
        if (sql.startsWith('SELECT count(*)')) {
          return {
            rows: [
              { n: outbox.filter(row => row.owner_key === params[0]).length },
            ],
          };
        }
        throw new Error(`fakeDb: unhandled sql ${sql}`);
      },
      close() {},
    };
    return { db, outbox };
  }

  beforeEach(() => {
    setActiveDataOwner(GUEST_DATA_OWNER);
  });

  it('uploads queued trials and deletes acknowledged rows', async () => {
    const { db, outbox } = fakeDb();
    const trial = await recordEvaluationTrial(db, buildInput(scored));
    expect(trial).not.toBeNull();
    expect(outbox).toHaveLength(1);
    const uploaded: unknown[][] = [];
    const transport: SyncTransport = {
      async syncShots() {
        return { acceptedIds: [], rejected: [] };
      },
      async createSession() {},
      async finalizeSession() {},
      async uploadEvaluationTrials(trials) {
        uploaded.push(trials);
        return { acceptedTrialIds: [trial!.trialId], rejected: [] };
      },
    };
    const result = await drainOutbox(db, transport);
    expect(uploaded).toHaveLength(1);
    expect(result.synced).toBe(1);
    expect(outbox).toHaveLength(0);
  });

  it('keeps rows queued without burning attempts when the transport lacks trial upload', async () => {
    const { db, outbox } = fakeDb();
    await recordEvaluationTrial(db, buildInput(scored));
    const transport: SyncTransport = {
      async syncShots() {
        return { acceptedIds: [], rejected: [] };
      },
      async createSession() {},
      async finalizeSession() {},
    };
    const result = await drainOutbox(db, transport);
    expect(result.remaining).toBe(1);
    expect(outbox[0]!.attempts).toBe(0);
  });

  it('increments attempts and records the rejection for rejected trials', async () => {
    const { db, outbox } = fakeDb();
    const trial = await recordEvaluationTrial(db, buildInput(scored));
    const transport: SyncTransport = {
      async syncShots() {
        return { acceptedIds: [], rejected: [] };
      },
      async createSession() {},
      async finalizeSession() {},
      async uploadEvaluationTrials() {
        return {
          acceptedTrialIds: [],
          rejected: [
            {
              trialId: trial!.trialId,
              code: 'evaluation.consent_inactive',
              message: 'no active grant',
            },
          ],
        };
      },
    };
    const result = await drainOutbox(db, transport);
    expect(result.failed).toBe(1);
    expect(outbox[0]!.attempts).toBe(1);
    expect(outbox[0]!.last_error).toContain('evaluation.consent_inactive');
  });
});
