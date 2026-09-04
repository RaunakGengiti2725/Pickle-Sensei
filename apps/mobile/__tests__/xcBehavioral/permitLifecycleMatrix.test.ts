/**
 * xc-matrix-behavioral — PERMIT LIFECYCLE over the REAL `runCaptureAnalysis`
 * (real pose sidecar, real fusion pipeline, real repository SQL against an
 * in-memory LocalDb). Only the two I/O edges are seams: the sidecar reader
 * and `fetch` (the permit server).
 *
 * Invariants asserted per seeded run:
 *   - at most ONE `POST /v1/analysis-permits` per run, and NONE when the
 *     input gate (envelope / sidecar / hash / parse) rejects first;
 *   - a scored run persists exactly one local_shot + one outbox row whose
 *     payload carries the reserved permit id (no rating without a permit);
 *   - every non-scored run that DID reserve releases exactly once with the
 *     matching outcome, or is a reserve failure that never touched the db;
 *   - a sidecar the pose-quality gate rejects (tracking dropout gap through
 *     the stroke) is never scored: one reserve, one `unsupported` release,
 *     zero local_shot rows, outcome `quality_blocked` carrying the reason;
 *   - concurrent runs never share a permit id (no duplicate shots) and leave
 *     no open transaction behind.
 *
 * Every seed is replayable:
 *   XC_SEED=<seed> npx jest __tests__/xcBehavioral/permitLifecycleMatrix
 */
import type { EnvelopeVerdict } from '@pickle/shared-types';
import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import type { CapturedClip } from '../../src/camera/capture';
import { setActiveDataOwner } from '../../src/data/accountScope';
import {
  randomInt,
  recordScenario,
  scenarioSeeds,
  seededRandom,
} from '../../testing/xcBehavioral/evidence';
import { createFakeLocalDb } from '../../testing/xcBehavioral/fakeLocalDb';
import { deferred } from '../../testing/xcBehavioral/deferred';

let mockReadArtifact: (uri: string) => Promise<string> = () =>
  Promise.reject(new Error('readCaptureArtifact mock not configured'));
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

import {
  runCaptureAnalysis,
  type CaptureAnalysisOutcome,
} from '../../src/analysis/runCaptureAnalysis';

const SUITE = 'permitLifecycleMatrix';
const OWNER = '22222222-2222-4222-8222-222222222222';
const API = { baseUrl: 'https://api.test', token: 'bearer-token' };

// ─── Fixture: real generated swing + real sidecar ──────────────────────────

/**
 * Player leaves the frame across the stroke: frames inside the window are
 * NOT measured (a real gap in the canonical record, never filled). The gap
 * is wider than the pose-quality gate's 700 ms dropout threshold.
 */
function dropFramesThroughContact(
  sequence: PoseSequence,
  window: { startMs: number; endMs: number; peakMs: number },
  gapMs: number,
): PoseSequence {
  const from = window.peakMs - gapMs / 2;
  const to = window.peakMs + gapMs / 2;
  return {
    ...sequence,
    frames: sequence.frames.filter(
      frame => frame.timestampMs < from || frame.timestampMs > to,
    ),
  };
}

function fixture(
  id: string,
  handed: 'right' | 'left',
  degrade: { dropoutGapMs: number } | null = null,
) {
  const generated = generateSwingSequence({ handed });
  const { window } = generated;
  const sequence = degrade
    ? dropFramesThroughContact(generated.sequence, window, degrade.dropoutGapMs)
    : generated.sequence;
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: `file:///captures/${id}.mov`,
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-08-29T18:00:00.000Z',
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
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
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
    preRollMs: 2000,
    postRollMs: 1500,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///captures/${id}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function envelope(overall: 'DEGRADED' | 'UNSUPPORTED'): EnvelopeVerdict {
  return {
    thresholdsVersion: 'xc-test-1',
    provisional: true,
    dimensions: [
      {
        dimension: 'motion_blur',
        status: overall,
        measured: 0.9,
        unit: 'ratio',
        thresholdId: 'motion_blur.v1',
      },
    ],
    overall,
    overallWithCoverage: overall,
    notMeasured: [],
  };
}

// ─── Permit server seam ────────────────────────────────────────────────────

type ReserveMode =
  'ok' | 'paywall_402' | 'server_500' | 'network_throw' | 'not_reserved_status';
type ReleaseMode = 'ok' | 'server_500' | 'network_throw';

interface PermitServer {
  reserves: number;
  releases: Array<{ permitId: string; outcome: string }>;
  reserveMode: ReserveMode;
  releaseMode: ReleaseMode;
  /** When set, the next reserve response waits for this gate. */
  holdReserve: (() => Promise<void>) | null;
  inFlightReserves: number;
  maxInFlightReserves: number;
  fetch: jest.Mock;
}

function permitServer(): PermitServer {
  const server: PermitServer = {
    reserves: 0,
    releases: [],
    reserveMode: 'ok',
    releaseMode: 'ok',
    holdReserve: null,
    inFlightReserves: 0,
    maxInFlightReserves: 0,
    fetch: jest.fn(),
  };
  const json = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
    }) as unknown as Response;
  server.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      server.reserves += 1;
      const seq = server.reserves;
      server.inFlightReserves += 1;
      server.maxInFlightReserves = Math.max(
        server.maxInFlightReserves,
        server.inFlightReserves,
      );
      try {
        if (server.holdReserve) await server.holdReserve();
      } finally {
        server.inFlightReserves -= 1;
      }
      switch (server.reserveMode) {
        case 'paywall_402':
          return json(402, {
            error: {
              code: 'access.paywall_required',
              message: 'Upgrade to keep rating strokes.',
            },
          });
        case 'server_500':
          return json(500, { error: { code: 'internal', message: 'boom' } });
        case 'network_throw':
          throw new TypeError('Network request failed');
        case 'not_reserved_status':
          return json(200, {
            permit: {
              id: `permit-${seq}`,
              accessSource: 'free',
              status: 'released',
              expiresAt: '2026-08-29T20:00:00.000Z',
            },
          });
        default:
          return json(200, {
            permit: {
              id: `permit-${seq}`,
              accessSource: 'free',
              status: 'reserved',
              expiresAt: '2026-08-29T20:00:00.000Z',
            },
            access: {
              premium: false,
              freeRatings: { availableToReserve: seq === 2 ? 0 : 1 },
            },
          });
      }
    }
    if (url.includes('/v1/analysis-permits/') && url.endsWith('/finalize')) {
      const permitId = decodeURIComponent(
        url.slice(
          url.indexOf('/v1/analysis-permits/') + '/v1/analysis-permits/'.length,
          url.length - '/finalize'.length,
        ),
      );
      const body = JSON.parse(String(init?.body)) as { outcome: string };
      server.releases.push({ permitId, outcome: body.outcome });
      if (server.releaseMode === 'server_500') {
        return json(500, { error: { code: 'internal', message: 'boom' } });
      }
      if (server.releaseMode === 'network_throw') {
        throw new TypeError('Network request failed');
      }
      return json(200, { ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return server;
}

// ─── Harness ───────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let server: PermitServer;

beforeEach(() => {
  setActiveDataOwner(OWNER);
  server = permitServer();
  globalThis.fetch = server.fetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function outboxPermitIds(fake: ReturnType<typeof createFakeLocalDb>) {
  return fake.outbox
    .filter(row => row.kind === 'shot.sync')
    .map(row => {
      const payload = JSON.parse(row.payload) as { analysisPermitId?: string };
      return payload.analysisPermitId ?? null;
    });
}

async function runOnce(
  fake: ReturnType<typeof createFakeLocalDb>,
  clip: CapturedClip,
  declared: 'forehand_drive' | null,
  extra: { captureEnvelope?: EnvelopeVerdict | null } = {},
): Promise<{ outcome: CaptureAnalysisOutcome | null; error: string | null }> {
  try {
    const outcome = await runCaptureAnalysis({
      db: fake.db,
      captureId: `capture-${clip.uri}`,
      clip,
      declaredStroke: declared,
      declaredCanonical: declared ? 'FOREHAND_DRIVE' : null,
      handedness: 'right',
      cameraView: 'side',
      apiConfig: API,
      appVersion: '1.0.0-xc',
      sessionId: null,
      ...extra,
    });
    return { outcome, error: null };
  } catch (error) {
    return {
      outcome: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

describe('xc-matrix-behavioral: permit lifecycle over real runCaptureAnalysis', () => {
  describe('input gates: rejected input NEVER reserves a permit or writes', () => {
    for (const seed of scenarioSeeds('permitInputGate')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const gate = (
          [
            'unsupported_envelope',
            'imported_no_sidecar',
            'no_sidecar',
            'unreadable_sidecar',
            'hash_mismatch',
            'invalid_sidecar',
          ] as const
        )[randomInt(random, 0, 5)]!;
        const declared = random() < 0.5 ? 'forehand_drive' : null;
        await recordScenario(
          SUITE,
          'permitInputGate',
          seed,
          { gate, declared },
          async () => {
            const fake = createFakeLocalDb();
            const { clip, sidecarJson } = fixture(`gate-${seed}`, 'right');
            mockReadArtifact = async () => sidecarJson;
            let subject: CapturedClip = clip;
            let captureEnvelope: EnvelopeVerdict | null = null;
            switch (gate) {
              case 'unsupported_envelope':
                captureEnvelope = envelope('UNSUPPORTED');
                break;
              case 'imported_no_sidecar':
                subject = {
                  ...clip,
                  captureMode: 'imported_video',
                  trigger: null,
                  poseSequence: null,
                } as unknown as CapturedClip;
                break;
              case 'no_sidecar':
                subject = {
                  ...clip,
                  poseSequence: null,
                } as unknown as CapturedClip;
                break;
              case 'unreadable_sidecar':
                mockReadArtifact = () =>
                  Promise.reject(new Error('ENOENT: sidecar missing'));
                break;
              case 'hash_mismatch':
                mockReadArtifact = async () => sidecarJson + ' ';
                break;
              case 'invalid_sidecar': {
                const bad = '{"schemaVersion":1,"frames":"nope"}';
                subject = {
                  ...clip,
                  poseSequence: {
                    ...clip.poseSequence!,
                    sha256: sha256Hex(bad),
                  },
                };
                mockReadArtifact = async () => bad;
                break;
              }
            }
            const { outcome, error } = await runOnce(fake, subject, declared, {
              captureEnvelope,
            });
            expect(error).toBeNull();
            expect(outcome).not.toBeNull();
            expect(
              outcome!.kind === 'unavailable' ||
                outcome!.kind === 'quality_blocked',
            ).toBe(true);
            if (gate === 'unsupported_envelope') {
              expect(outcome!.kind).toBe('quality_blocked');
            }
            expect(server.reserves).toBe(0);
            expect(server.releases).toHaveLength(0);
            expect(fake.shots).toHaveLength(0);
            expect(fake.outbox).toHaveLength(0);
            expect(fake.analysisRecords).toHaveLength(0);
            expect(fake.statements).toHaveLength(0);
            return {
              kind: outcome!.kind,
              reason: (outcome as { reason?: string }).reason,
            };
          },
        );
      });
    }
  });

  describe('pose-quality gate AFTER reserve: a dropout gap through the stroke is never scored', () => {
    for (const seed of scenarioSeeds('permitPoseQualityGate')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const declared = random() < 0.6 ? 'forehand_drive' : null;
        const handed = random() < 0.5 ? 'right' : 'left';
        // Strictly above the 700 ms gate threshold, up to a 1.5 s hole.
        const dropoutGapMs = randomInt(random, 800, 1500);
        const releaseMode = (['ok', 'server_500', 'network_throw'] as const)[
          randomInt(random, 0, 2)
        ]!;
        await recordScenario(
          SUITE,
          'permitPoseQualityGate',
          seed,
          { declared, handed, dropoutGapMs, releaseMode },
          async () => {
            const fake = createFakeLocalDb();
            const { clip, sidecarJson } = fixture(`gap-${seed}`, handed, {
              dropoutGapMs,
            });
            mockReadArtifact = async () => sidecarJson;
            server.releaseMode = releaseMode;
            const { outcome, error } = await runOnce(fake, clip, declared);
            expect(error).toBeNull();
            expect(outcome).not.toBeNull();
            expect(outcome!.kind).not.toBe('scored');
            expect(outcome!.kind).toBe('quality_blocked');
            const reason =
              outcome!.kind === 'quality_blocked' ? outcome!.reason : '';
            expect(reason).toMatch(/tracking_dropout_gap/);
            // Exactly one reserve and exactly one release: the rating was
            // reserved, found unmeasurable, and handed back as unsupported.
            expect(server.reserves).toBe(1);
            expect(server.releases).toEqual([
              { permitId: 'permit-1', outcome: 'unsupported' },
            ]);
            // Nothing was rated: no local shot, no sync row, no record.
            expect(fake.shots).toHaveLength(0);
            expect(fake.outbox).toHaveLength(0);
            expect(fake.analysisRecords).toHaveLength(0);
            expect(fake.openTransactions()).toBe(0);
            return {
              kind: outcome!.kind,
              reason,
              reserves: server.reserves,
              releases: server.releases,
              shots: fake.shots.length,
            };
          },
        );
      });
    }
  });

  describe('reserve edge: every reserve failure is a clean unavailable with zero writes', () => {
    for (const seed of scenarioSeeds('permitReserveFailure')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const reserveMode = (
          [
            'paywall_402',
            'server_500',
            'network_throw',
            'not_reserved_status',
          ] as const
        )[randomInt(random, 0, 3)]!;
        const declared = random() < 0.7 ? 'forehand_drive' : null;
        await recordScenario(
          SUITE,
          'permitReserveFailure',
          seed,
          { reserveMode, declared },
          async () => {
            const fake = createFakeLocalDb();
            const { clip, sidecarJson } = fixture(`reserve-${seed}`, 'right');
            mockReadArtifact = async () => sidecarJson;
            server.reserveMode = reserveMode;
            const { outcome, error } = await runOnce(fake, clip, declared);
            expect(error).toBeNull();
            expect(outcome!.kind).toBe('unavailable');
            const cause =
              outcome?.kind === 'unavailable' ? (outcome.cause ?? null) : null;
            if (reserveMode === 'paywall_402') {
              expect(cause).toBe('paywall_required');
            } else {
              expect(cause).toBeNull();
            }
            expect(server.reserves).toBe(1);
            // Nothing was reserved from the client's point of view, so
            // nothing is released and nothing is written.
            expect(server.releases).toHaveLength(0);
            expect(fake.statements).toHaveLength(0);
            expect(fake.openTransactions()).toBe(0);
            return { kind: outcome!.kind, cause };
          },
        );
      });
    }
  });

  describe('happy + release paths: one reserve, matching release/consume, real pipeline', () => {
    for (const seed of scenarioSeeds('permitAccounting')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const declared = random() < 0.6 ? 'forehand_drive' : null;
        const handed = random() < 0.5 ? 'right' : 'left';
        const degraded = random() < 0.3;
        const releaseMode = (['ok', 'server_500', 'network_throw'] as const)[
          randomInt(random, 0, 2)
        ]!;
        await recordScenario(
          SUITE,
          'permitAccounting',
          seed,
          { declared, handed, degraded, releaseMode },
          async () => {
            const fake = createFakeLocalDb();
            const { clip, sidecarJson } = fixture(`acct-${seed}`, handed);
            mockReadArtifact = async () => sidecarJson;
            server.releaseMode = releaseMode;
            const { outcome, error } = await runOnce(fake, clip, declared, {
              captureEnvelope: degraded ? envelope('DEGRADED') : null,
            });
            expect(error).toBeNull();
            expect(outcome).not.toBeNull();
            expect(server.reserves).toBe(1);
            expect(fake.openTransactions()).toBe(0);
            const permitIds = outboxPermitIds(fake);
            if (outcome!.kind === 'scored') {
              // Consumed by the sync transaction — never released.
              expect(server.releases).toHaveLength(0);
              expect(fake.shots).toHaveLength(1);
              expect(permitIds).toEqual(['permit-1']);
              expect(fake.analysisRecords).toHaveLength(1);
              expect(outcome!.freeLimitReached).toBe(false);
            } else if (outcome!.kind === 'low_confidence') {
              expect(server.releases).toEqual([
                { permitId: 'permit-1', outcome: 'low_confidence' },
              ]);
              expect(fake.outbox).toHaveLength(0);
              expect(fake.analysisRecords).toHaveLength(1);
            } else if (outcome!.kind === 'unavailable') {
              // Pipeline failure after reserve: released as failed, no record.
              expect(server.releases).toEqual([
                { permitId: 'permit-1', outcome: 'failed' },
              ]);
              expect(fake.statements).toHaveLength(0);
            } else {
              throw new Error(`unexpected kind ${outcome!.kind}`);
            }
            return {
              kind: outcome!.kind,
              releases: server.releases.length,
              shots: fake.shots.length,
              outbox: fake.outbox.length,
              records: fake.analysisRecords.length,
            };
          },
        );
      });
    }
  });

  describe('persistence faults AFTER reserve: what happens to the permit', () => {
    for (const seed of scenarioSeeds('permitPersistFault')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const fault = (
          [
            'INSERT INTO local_analysis_record',
            "UPDATE local_capture SET status = 'analyzed'",
            'INSERT OR REPLACE INTO local_shot',
            'INSERT INTO outbox',
          ] as const
        )[randomInt(random, 0, 3)]!;
        await recordScenario(
          SUITE,
          'permitPersistFault',
          seed,
          { fault, declared: 'forehand_drive' },
          async () => {
            const fake = createFakeLocalDb();
            const { clip, sidecarJson } = fixture(`persist-${seed}`, 'right');
            mockReadArtifact = async () => sidecarJson;
            // Establish that this fixture scores without the fault, so the
            // fault is the only variable.
            const dry = createFakeLocalDb();
            const dryRun = await runOnce(dry, clip, 'forehand_drive');
            if (dryRun.outcome?.kind !== 'scored') {
              return {
                skipped: `fixture did not score: ${dryRun.outcome?.kind}`,
              };
            }
            server.reserves = 0;
            server.releases.length = 0;
            fake.failNext(fault, new Error(`SQLITE_FULL: ${fault}`));
            const { outcome, error } = await runOnce(
              fake,
              clip,
              'forehand_drive',
            );
            expect(outcome).toBeNull();
            expect(error).toContain('SQLITE_FULL');
            expect(server.reserves).toBe(1);
            // No rating ever leaves the device without its permit.
            expect(outboxPermitIds(fake).every(id => id === 'permit-1')).toBe(
              true,
            );
            // The saveAnalysis transaction rolled back: no half-written shot.
            expect(fake.openTransactions()).toBe(0);
            const shotWithoutOutbox =
              fake.shots.length === 1 && fake.outbox.length === 0;
            expect(shotWithoutOutbox).toBe(false);
            // OBSERVED (not asserted): the reserved permit is never released
            // on this path — runCaptureAnalysis.ts:360-365 throw past the
            // release calls, so the server holds it as `reserved` until the
            // 24h sweep, and reserve_analysis_permit counts it against the
            // free allowance meanwhile.
            const permitReleasedAfterPersistFailure =
              server.releases.length > 0;
            return {
              error,
              permitReleasedAfterPersistFailure,
              shots: fake.shots.length,
              outbox: fake.outbox.length,
              records: fake.analysisRecords.length,
            };
          },
        );
      });
    }
  });

  describe('simultaneous runs: N concurrent analyses reserve N distinct permits, no shared/duplicate rating', () => {
    for (const seed of scenarioSeeds('permitConcurrentRuns')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const runs = randomInt(random, 2, 4);
        const holdReserves = random() < 0.6;
        const declared = random() < 0.7 ? 'forehand_drive' : null;
        await recordScenario(
          SUITE,
          'permitConcurrentRuns',
          seed,
          { runs, holdReserves, declared },
          async () => {
            const fake = createFakeLocalDb();
            const fixtures = Array.from({ length: runs }, (_, i) =>
              fixture(`conc-${seed}-${i}`, i % 2 === 0 ? 'right' : 'left'),
            );
            const byUri = new Map(
              fixtures.map(f => [f.clip.poseSequence!.uri, f.sidecarJson]),
            );
            mockReadArtifact = async uri => {
              const json = byUri.get(uri);
              if (!json) throw new Error(`unknown sidecar ${uri}`);
              return json;
            };
            const gate = deferred<void>();
            if (holdReserves) server.holdReserve = () => gate.promise;
            const pending = fixtures.map(f => runOnce(fake, f.clip, declared));
            if (holdReserves) {
              // Let every run reach the permit edge before any answer lands.
              for (let i = 0; i < 20; i += 1) await Promise.resolve();
              expect(server.inFlightReserves).toBe(runs);
              gate.resolve(undefined);
            }
            const results = await Promise.all(pending);
            for (const r of results) expect(r.error).toBeNull();
            expect(server.reserves).toBe(runs);
            const kinds = results.map(r => r.outcome!.kind);
            const scored = kinds.filter(k => k === 'scored').length;
            const permitIds = outboxPermitIds(fake);
            expect(permitIds).toHaveLength(scored);
            expect(new Set(permitIds).size).toBe(scored);
            expect(permitIds.every(id => id !== null)).toBe(true);
            expect(fake.shots).toHaveLength(scored);
            expect(new Set(fake.shots.map(s => s.id)).size).toBe(scored);
            // Released permits are exactly the non-scored, post-reserve runs.
            expect(server.releases).toHaveLength(runs - scored);
            expect(new Set(server.releases.map(r => r.permitId)).size).toBe(
              runs - scored,
            );
            for (const r of server.releases) {
              expect(permitIds).not.toContain(r.permitId);
            }
            expect(fake.openTransactions()).toBe(0);
            return {
              kinds,
              maxInFlightReserves: server.maxInFlightReserves,
              permitIds,
              releases: server.releases,
            };
          },
        );
      });
    }
  });
});
