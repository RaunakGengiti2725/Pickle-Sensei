/**
 * INT-charging-permits adversary — mobile plane of the joint chargeability
 * contract at HEAD 30a4065036a917514fb4984fde73f87867f38619.
 *
 * ATK-M1 drives the REAL capture pipeline (fusion providers, segmentation,
 * scoring) through runCaptureAnalysis over the canonical synthetic swing
 * (same harness as attack4RunCaptureAnalysisPermits.test.ts); only the file
 * read and globalThis.fetch are simulated. ATK-M2..M5 drive drainOutbox over
 * the fake outbox LocalDb.
 *
 * A test that PASSES documents a boundary that HELD; a test that FAILS is a
 * confirmed break at this head.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFakeOutboxDb } from '../../__harness__/serverResponseMatrix/outboxFakeDb';
import {
  createCaptureAnalysisDb,
  fixtureUuid,
  signInCaptureOwner,
  closeCaptureHarness,
  seedCaptureRequest,
} from '../../testSupport/captureAnalysisHarness';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import {
  decideChargeability,
  parseChargeabilityFixtureTable,
  JOINT_CHARGEABILITY_CONTRACT_VERSION,
  type ShotAnalysis,
} from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import type { CapturedClip } from '../../src/camera/capture';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  isTransientSyncRejection,
} from '../../src/data/sync';
import { TECHNIQUE_BENCHMARK_UNAVAILABLE } from '../../src/progress/techniqueBenchmarkDisplay';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '44444444-4444-4444-8444-444444444444';
const RELEASE_CODE = 'access.release_not_authorized';

const FIXTURE_PATH = resolve(
  __dirname,
  '../../../../packages/shared-types/fixtures/chargeability/joint-chargeability-v1.json',
);

/** The shared table's mechanics-only case: validated mechanics, withheld
 * benchmark — the honest outcome of every run the shipping app performs. */
function mechanicsOnlyFixture() {
  const parsed = parseChargeabilityFixtureTable(
    JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')),
  );
  if (!parsed.ok) {
    throw new Error(`fixture table rejected: ${parsed.failure.code}`);
  }
  const found = parsed.value.cases.find(
    c => c.id === 'partial_mechanics_only_benchmark_insufficient_evidence',
  );
  if (!found) throw new Error('mechanics-only fixture case missing');
  return found;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: async () => body,
  } as unknown as Response;
}

function permitServer() {
  const finalizeBodies: unknown[] = [];
  const reserveBodies: unknown[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      reserveBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({
        permit: {
          id: fixtureUuid('permit-adv-m1'),
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-09-09T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) {
      finalizeBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, finalizeBodies, reserveBodies };
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/adv.mov',
    durationMs: window.endMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-09-08T12:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: sequence.producedBy.modelVersion,
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs - window.startMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 400,
    postRollMs: 300,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///captures/adv.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip, captureId = 'capture-adv') {
  return {
    db,
    ...seedCaptureRequest(db, clip, captureId),
    clip,
    declaredStroke: 'forehand_drive' as const,
    declaredCanonical: 'FOREHAND_DRIVE' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-adv' },
    appVersion: '0.1.0',
  };
}

function setFetch(fetchMock: unknown) {
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
}

// ── ATK-M1 — the shipping scored path charges on ONE output ─────────────────
// The joint contract (packages/shared-types/src/chargeability.ts) charges only
// when mechanics AND technique benchmark are both validated and durably
// published. The shipping app never produces a benchmark: ResultScreen renders
// TECHNIQUE_BENCHMARK_UNAVAILABLE unconditionally, yet the same run queues a
// `resultKind: 'scored'` shot.sync row — the permit-consuming, ledger-counting
// wire shape. The contract's own verdict on that outcome is `outcome_partial`.

describe('ATK-M1 — happy-path scored run without a validated benchmark', () => {
  beforeEach(() => signInCaptureOwner(owner));
  afterEach(() => {
    closeCaptureHarness();
    setFetch(undefined);
  });

  it('queues a chargeable `scored` sync although the second output is unconditionally unavailable', async () => {
    const harness = createCaptureAnalysisDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    setFetch(server.fetchMock);

    const outcome = await runCaptureAnalysis(request(harness.db, clip));
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(server.reserveBodies).toHaveLength(1);
    expect(server.finalizeBodies).toHaveLength(0);

    const result = outcome.record.result as ShotAnalysis;
    expect(result.resultKind).toBe('scored');
    // No benchmark exists anywhere on the persisted record or the wire row.
    const recordJson = JSON.stringify(outcome.record);
    expect(recordJson.includes('technique-benchmark-v1')).toBe(false);
    expect(harness.outbox).toHaveLength(1);
    const wire = JSON.parse(harness.outbox[0]!.payload) as {
      resultKind: string;
      analysisPermitId?: string;
    };
    expect(wire.analysisPermitId).toBe(fixtureUuid('permit-adv-m1'));
    // The screen tells the user the benchmark is unavailable...
    expect(TECHNIQUE_BENCHMARK_UNAVAILABLE).toContain('unavailable');

    // ...and the shared contract's verdict on exactly this shape of outcome
    // (validated mechanics, WITHHELD benchmark) is: not chargeable.
    const fixture = mechanicsOnlyFixture();
    const verdict = decideChargeability(fixture.outcome, fixture.eligibility);
    expect(verdict.contractVersion).toBe(JOINT_CHARGEABILITY_CONTRACT_VERSION);
    expect(verdict).toMatchObject({
      chargeable: false,
      creditsConsumed: 0,
      reasonCode: 'outcome_partial',
    });

    // EXPECTED (invariant: charge only after BOTH outputs are delivered):
    // the wire row for a benchmark-less run must not be the chargeable kind.
    // OBSERVED at HEAD: 'scored' — one output, one credit.
    expect(wire.resultKind).not.toBe('scored');
  });
});

// ── Outbox-layer attacks over the fake LocalDb ──────────────────────────────

const analysis: ShotAnalysis = {
  id: 'aaaaaaaa-1111-4ccc-8ddd-eeeeeeeeeeee',
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-09-08T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.4,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'test-native-1',
    poseModelVersion: 'test-pose-1',
    paddleModelVersion: 'test-paddle-1',
    strokeDetectorVersion: 'test-stroke-1',
    phaseModelVersion: 'test-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};
const analysisPermitId = 'cccccccc-1111-4ccc-8ddd-eeeeeeeeeeee';
const permitted = { ...analysis, analysisPermitId };

const noSessions = {
  createSession: async () => {},
  finalizeSession: async () => {},
};

describe('outbox attacks', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  // ATK-M2 — the release-authority refusal is FINAL on the device: the row
  // burns its budget and silently leaves the drain; nothing on the device
  // ever settles the permit that still backs it (server half: ATK-E3).
  it('ATK-M2 `access.release_not_authorized` burns the attempt budget and drops out of the drain with no settlement', async () => {
    expect(isTransientSyncRejection(RELEASE_CODE)).toBe(false);
    const fake = createFakeOutboxDb();
    fake.push('shot.sync', permitted, GUEST_DATA_OWNER);
    const transport = {
      ...noSessions,
      syncShots: async () => ({
        acceptedIds: [],
        rejected: [
          {
            id: analysis.id,
            code: RELEASE_CODE,
            message: 'This rating could not be validated for release.',
          },
        ],
      }),
    };
    for (let i = 1; i <= OUTBOX_MAX_ATTEMPTS; i++) {
      const r = await drainOutbox(fake.db, transport);
      expect(r).toMatchObject({ synced: 0, failed: 1 });
      expect(fake.outbox[0]!.attempts).toBe(i);
    }
    const after = await drainOutbox(fake.db, transport);
    // Budget exhausted: the row is no longer presented to the transport,
    // nothing was received, no repair was requested — the rating sits in
    // the outbox as a dead letter and its permit stays reserved server-side.
    expect(after).toMatchObject({ synced: 0, failed: 0, remaining: 1 });
    expect(fake.receipts).toEqual([]);
    expect(fake.outbox).toHaveLength(1);
    expect(fake.outbox[0]!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(fake.outbox[0]!.repair_reason).toBeNull();
  });

  // ATK-M3 — withheld acknowledgement: the server answers 200 but names
  // neither accepted nor rejected. The row must stay queued, budget intact.
  it('ATK-M3 an acknowledgement that names no ids keeps the row queued without spending the budget', async () => {
    const fake = createFakeOutboxDb();
    fake.push('shot.sync', permitted, GUEST_DATA_OWNER);
    const r = await drainOutbox(fake.db, {
      ...noSessions,
      syncShots: async () => ({ acceptedIds: [], rejected: [] }),
    });
    expect(r.synced).toBe(0);
    expect(r.remaining).toBe(1);
    expect(fake.receipts).toEqual([]);
    expect(fake.outbox).toHaveLength(1);
    expect(fake.outbox[0]!.attempts).toBe(0);
  });

  // ATK-M4 — replayed acknowledgement: the same id accepted twice in one
  // response, plus an id that was never sent. The acknowledgement is not a
  // valid settlement of the batch: nothing may be receipted or deleted on
  // its strength, and the budget must not be spent (it is the server's
  // fault, not the row's).
  it('ATK-M4 duplicate and foreign accepted ids are refused as a whole: no receipt, row kept, budget intact', async () => {
    const fake = createFakeOutboxDb();
    fake.push('shot.sync', permitted, GUEST_DATA_OWNER);
    const r = await drainOutbox(fake.db, {
      ...noSessions,
      syncShots: async () => ({
        acceptedIds: [
          analysis.id,
          analysis.id,
          'ffffffff-1111-4ccc-8ddd-eeeeeeeeeeee',
        ],
        rejected: [],
      }),
    });
    expect(r.synced).toBe(0);
    expect(fake.receipts).toEqual([]);
    expect(fake.outbox).toHaveLength(1);
    expect(fake.outbox[0]!.attempts).toBe(0);
  });

  // ATK-M5 — corrupt persisted state: a row whose payload is not JSON and a
  // row whose scored payload lost its permit id fail alone and permanently;
  // the healthy row in the same batch still syncs.
  it('ATK-M5 corrupt and permit-less rows fail closed alone; the healthy row still syncs', async () => {
    const fake = createFakeOutboxDb();
    const corruptId = fake.push('shot.sync', permitted, GUEST_DATA_OWNER);
    fake.outbox.find(row => row.id === corruptId)!.payload = '{not json';
    fake.push('shot.sync', analysis, GUEST_DATA_OWNER);
    fake.push(
      'shot.sync',
      { ...permitted, id: 'bbbbbbbb-1111-4ccc-8ddd-eeeeeeeeeeee' },
      GUEST_DATA_OWNER,
    );
    const sent: unknown[][] = [];
    const r = await drainOutbox(fake.db, {
      ...noSessions,
      syncShots: async shots => {
        sent.push(shots);
        return {
          acceptedIds: shots.map(s => (s as { id: string }).id),
          rejected: [],
        };
      },
    });
    expect(r).toMatchObject({ synced: 1, failed: 2, remaining: 2 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
    expect(fake.receipts).toEqual([
      {
        owner: GUEST_DATA_OWNER,
        kind: 'shot.sync',
        entityId: 'bbbbbbbb-1111-4ccc-8ddd-eeeeeeeeeeee',
      },
    ]);
    for (const row of fake.outbox) {
      expect(row.attempts).toBe(1);
    }
  });
});
