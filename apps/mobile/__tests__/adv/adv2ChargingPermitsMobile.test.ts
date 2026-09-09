/**
 * INT-charging-permits adversary (pass 2) — the MOBILE half of the charge
 * boundary at HEAD 2994371e1c5edf9a1e9bb12f6c6e4751e3fb4ea1.
 *
 * M1 runs the REAL analysis pipeline (fusion providers, phase segmentation,
 * scoring) over the canonical @pickle/evaluation swing fixture through
 * runCaptureAnalysis() with a stubbed permit server, then inspects the exact
 * row the app queues for the chargeable sync. The shared contract
 * (joint-chargeability-v1) says a credit is chargeable only when BOTH the
 * mechanics score and the benchmark range are independently validated; the
 * attack asks whether the row the app promotes to "scored" (the value the
 * server settles as a credit) carries a validated benchmark output at all.
 *
 * M2–M4 drive drainOutbox() with a fake LocalDb and a scripted transport for
 * the server verdicts the Edge actually emits on this head for a stranded
 * scored row (release authority withdrawn, allowance exhausted, permit
 * already settled): the durable local rating must stay on the device under
 * HOLD (row kept, surfaced, no receipt) — never be silently dropped, never be
 * acknowledged locally without the server accepting it.
 *
 *   cd apps/mobile && npx jest __tests__/adv/adv2ChargingPermitsMobile.test.ts
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import {
  decideChargeability,
  parseChargeabilityFixtureTable,
} from '@pickle/shared-types';
import type { CapturedClip } from '../../src/camera/capture';
import type { LocalDb } from '../../src/data/db';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { ApiError } from '../../src/data/api';
import { drainOutbox, OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import { createFakeOutboxDb } from '../../__harness__/serverResponseMatrix/outboxFakeDb';
import { finalizeAcknowledgement } from '../../__harness__/analysisPermitRoute';
import {
  closeCaptureHarness,
  createCaptureAnalysisDb,
  fixtureUuid,
  seedCaptureRequest,
  signInCaptureOwner,
} from '../../testSupport/captureAnalysisHarness';

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

declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readFileSync } = require('node:fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { resolve } = require('node:path') as {
  resolve: (...parts: string[]) => string;
};

const FIXTURE_PATH = resolve(
  __dirname,
  '../../../../packages/shared-types/fixtures/chargeability/joint-chargeability-v1.json',
);

const owner = '44444444-4444-4444-8444-444444444444';
const PERMIT_ID = fixtureUuid('permit-adv2-m1');

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
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      return jsonResponse({
        permit: {
          id: PERMIT_ID,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-09-10T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) {
      const body: unknown = JSON.parse(String(init?.body));
      finalizeBodies.push(body);
      return jsonResponse(finalizeAcknowledgement(url, body));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, finalizeBodies };
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/adv2.mov',
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
      uri: 'file:///captures/adv2.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip) {
  return {
    db,
    ...seedCaptureRequest(db, clip, 'capture-adv2-m1'),
    clip,
    declaredStroke: 'forehand_drive' as const,
    declaredCanonical: 'FOREHAND_DRIVE' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-adv2' },
    appVersion: '0.1.0',
  };
}

function setFetch(fetchMock: unknown) {
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('ADV2-M1 joint chargeability at the capture boundary (real pipeline)', () => {
  beforeEach(() => signInCaptureOwner(owner));
  afterEach(() => {
    closeCaptureHarness();
    setFetch(undefined);
  });

  it('the row the app queues as a chargeable "scored" sync must carry a validated benchmark output — the contract charges only for BOTH outputs', async () => {
    const table = parseChargeabilityFixtureTable(
      JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')),
    );
    expect(table.ok).toBe(true);
    if (!table.ok) return;
    const mechanicsOnly = table.value.cases.find(
      entry =>
        entry.id === 'partial_mechanics_only_benchmark_insufficient_evidence',
    );
    expect(mechanicsOnly).toBeDefined();
    if (!mechanicsOnly) return;
    // Control: the shared contract refuses to charge a mechanics-only outcome.
    expect(
      decideChargeability(mechanicsOnly.outcome, mechanicsOnly.eligibility),
    ).toMatchObject({
      chargeable: false,
      reasonCode: 'outcome_partial',
      creditsConsumed: 0,
    });

    const store = createCaptureAnalysisDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    setFetch(server.fetchMock);

    const outcome = await runCaptureAnalysis(request(store.db, clip));
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(server.finalizeBodies).toEqual([]);

    const queued = store.native
      .prepare(`SELECT kind, payload FROM outbox`)
      .all() as Array<{ kind: string; payload: string }>;
    expect(queued.map(row => row.kind)).toEqual(['shot.sync']);
    const payload: unknown = JSON.parse(queued[0]!.payload);
    expect(isRecord(payload)).toBe(true);
    if (!isRecord(payload)) return;
    expect(payload.analysisPermitId).toBe(PERMIT_ID);
    expect(payload.resultKind).toBe('scored');
    expect(typeof payload.overallScore).toBe('number');

    // The attack: what SECOND output does the chargeable row carry?
    const benchmark = payload.benchmark;
    expect(isRecord(benchmark) && benchmark.status === 'validated_range').toBe(
      true,
    );
  });
});

// ─── Outbox HOLD under the Edge's stranded-scored-row verdicts ───────────────

const SHOT_ID = 'aaaaaaaa-ad02-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_SHOT_ID = 'bbbbbbbb-ad02-4ccc-8ddd-eeeeeeeeeeee';
const OUTBOX_PERMIT = 'cccccccc-ad02-4ccc-8ddd-eeeeeeeeeeee';

const scoredRow = (id: string) => ({
  id,
  analysisPermitId: OUTBOX_PERMIT,
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
});

const idle = {
  createSession: async () => {},
  finalizeSession: async () => {},
};

describe('ADV2-M2..M4 stranded scored rows stay under HOLD on the device', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it.each([
    ['access.release_not_authorized', 'release authority withdrawn'],
    ['access.paywall_required', 'free allowance exhausted server-side'],
    ['access.permit_not_reserved', 'permit already settled server-side'],
  ])(
    'ADV2-M2 per-row rejection %s (%s) repeated past OUTBOX_MAX_ATTEMPTS: the row is never deleted, never receipted, drops out of the batch only once exhausted, and keeps its full payload',
    async code => {
      const fake = createFakeOutboxDb();
      fake.push('shot.sync', scoredRow(SHOT_ID), GUEST_DATA_OWNER);
      let requests = 0;
      const transport = {
        ...idle,
        syncShots: async (shots: unknown[]) => {
          requests++;
          return {
            acceptedIds: [],
            rejected: shots.map(shot => ({
              id: (shot as { id: string }).id,
              code,
              message: 'refused',
            })),
          };
        },
      };
      for (let pass = 1; pass <= OUTBOX_MAX_ATTEMPTS; pass++) {
        const result = await drainOutbox(fake.db, transport);
        expect(result).toEqual({ synced: 0, failed: 1, remaining: 1 });
        expect(fake.outbox[0]!.attempts).toBe(pass);
        expect(fake.outbox[0]!.last_error).toBe(`${code}: refused`);
      }
      expect(requests).toBe(OUTBOX_MAX_ATTEMPTS);
      // One more drain: the exhausted row is held back, not sent, not dropped.
      const after = await drainOutbox(fake.db, transport);
      expect(after).toEqual({ synced: 0, failed: 0, remaining: 1 });
      expect(requests).toBe(OUTBOX_MAX_ATTEMPTS);
      expect(fake.outbox).toHaveLength(1);
      expect(fake.outbox[0]!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
      expect(fake.receipts).toEqual([]);
      expect(
        fake.statements.some(statement =>
          statement.startsWith('DELETE FROM outbox'),
        ),
      ).toBe(false);
      expect(fake.outbox[0]!.repair_reason).toBeNull();
      expect(JSON.parse(fake.outbox[0]!.payload)).toEqual(scoredRow(SHOT_ID));
    },
  );

  it('ADV2-M3 a whole-batch 503 (release authority unavailable) never consumes the attempt budget, however often it repeats; the first 200 after it settles the row exactly once', async () => {
    const fake = createFakeOutboxDb();
    fake.push('shot.sync', scoredRow(SHOT_ID), GUEST_DATA_OWNER);
    let mode: 'outage' | 'accept' = 'outage';
    let accepted = 0;
    const transport = {
      ...idle,
      syncShots: async (shots: unknown[]) => {
        if (mode === 'outage') {
          throw new ApiError(
            503,
            'service_unavailable',
            'Shot sync is temporarily unavailable.',
          );
        }
        accepted++;
        return {
          acceptedIds: shots.map(shot => (shot as { id: string }).id),
          rejected: [],
        };
      },
    };
    for (let pass = 0; pass < OUTBOX_MAX_ATTEMPTS * 3; pass++) {
      const result = await drainOutbox(fake.db, transport);
      expect(result).toEqual({ synced: 0, failed: 1, remaining: 1 });
    }
    expect(fake.outbox[0]!.attempts).toBe(0);
    expect(fake.outbox[0]!.repair_reason).toBeNull();
    mode = 'accept';
    expect(await drainOutbox(fake.db, transport)).toEqual({
      synced: 1,
      failed: 0,
      remaining: 0,
    });
    expect(accepted).toBe(1);
    expect(fake.receipts).toEqual([
      { owner: GUEST_DATA_OWNER, kind: 'shot.sync', entityId: SHOT_ID },
    ]);
    // A relaunch-style second drain has nothing to send: no double settlement.
    expect(await drainOutbox(fake.db, transport)).toEqual({
      synced: 0,
      failed: 0,
      remaining: 0,
    });
    expect(accepted).toBe(1);
  });

  it('ADV2-M4 mixed batch: a scored row refused for release authority does not poison the sibling that the server accepted, and the refused row keeps every byte of its payload', async () => {
    const fake = createFakeOutboxDb();
    fake.push('shot.sync', scoredRow(SHOT_ID), GUEST_DATA_OWNER);
    fake.push('shot.sync', scoredRow(OTHER_SHOT_ID), GUEST_DATA_OWNER);
    const before = fake.outbox.find(
      row => JSON.parse(row.payload).id === SHOT_ID,
    )!.payload;
    const result = await drainOutbox(fake.db, {
      ...idle,
      syncShots: async () => ({
        acceptedIds: [OTHER_SHOT_ID],
        rejected: [
          {
            id: SHOT_ID,
            code: 'access.release_not_authorized',
            message: 'refused',
          },
        ],
      }),
    });
    expect(result).toEqual({ synced: 1, failed: 1, remaining: 1 });
    expect(fake.receipts).toEqual([
      { owner: GUEST_DATA_OWNER, kind: 'shot.sync', entityId: OTHER_SHOT_ID },
    ]);
    expect(fake.outbox).toHaveLength(1);
    expect(fake.outbox[0]!.payload).toBe(before);
    expect(fake.outbox[0]!.attempts).toBe(1);
    expect(fake.outbox[0]!.repair_reason).toBeNull();
  });
});
