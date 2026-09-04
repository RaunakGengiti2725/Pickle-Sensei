/**
 * Shared fixtures + evidence sink for the xc-journey-account-switch harness.
 *
 * Two mocked canonical identities (backend UUIDs — the only thing a signed-in
 * local owner may be keyed by), deterministic builders for every owner-scoped
 * artefact the repository persists, a seeded PRNG for the randomized suite,
 * and a JSON evidence writer. Evidence never contains tokens: the builders
 * here produce no credentials and `assertNoSecretMaterial` is the tripwire.
 */
/// <reference types="node" />
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { PlayerRankSummary, ShotAnalysis } from '@pickle/shared-types';
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { CapturedClip } from '../../src/camera/capture';
import { canonicalDataOwner } from '../../src/data/accountScope';
import type { Profile } from '../../src/state/profile';
import type { RealSqliteHandle, SqlRow } from './realSqlite';

// ─── Identities ──────────────────────────────────────────────────────────────

export interface Identity {
  label: 'A' | 'B';
  canonicalAppUserId: string;
  provider: 'apple' | 'google';
  displayName: string;
  email: string;
  bearer: string;
  refresh: string;
}

export const IDENTITY_A: Identity = {
  label: 'A',
  canonicalAppUserId: 'aaaaaaaa-0a0a-4a0a-8a0a-aaaaaaaaaaa1',
  provider: 'apple',
  displayName: 'Ada Alpha',
  email: 'ada.alpha@example.test',
  bearer: 'access-A-1',
  refresh: 'refresh-A-1',
};

export const IDENTITY_B: Identity = {
  label: 'B',
  canonicalAppUserId: 'bbbbbbbb-0b0b-4b0b-8b0b-bbbbbbbbbbb2',
  provider: 'google',
  displayName: 'Bo Bravo',
  email: 'bo.bravo@example.test',
  bearer: 'access-B-1',
  refresh: 'refresh-B-1',
};

export const OWNER_A = canonicalDataOwner(IDENTITY_A.canonicalAppUserId);
export const OWNER_B = canonicalDataOwner(IDENTITY_B.canonicalAppUserId);

export const PERMIT_A = '0a0a0a0a-1111-4111-8111-0a0a0a0a0a0a';
export const PERMIT_B = '0b0b0b0b-2222-4222-8222-0b0b0b0b0b0b';

/** Every string that must never appear in any persisted row or evidence. */
export const SECRET_MATERIAL = [
  IDENTITY_A.bearer,
  IDENTITY_A.refresh,
  IDENTITY_B.bearer,
  IDENTITY_B.refresh,
  'apple-identity-token',
  'one-use-apple-code',
  'google-id-token',
];

export function assertNoSecretMaterial(haystack: string, where: string): void {
  for (const secret of SECRET_MATERIAL) {
    if (haystack.includes(secret)) {
      throw new Error(
        `secret material (${secret.slice(0, 8)}…) leaked into ${where}`,
      );
    }
  }
}

// ─── Builders ────────────────────────────────────────────────────────────────

export const VERSION_VECTOR: ShotAnalysis['versionVector'] = {
  appVersion: '0.1.0',
  modelBundleVersion: 'validated-bundle-1',
  poseModelVersion: 'pose-1',
  paddleModelVersion: 'paddle-1',
  strokeDetectorVersion: 'stroke-1',
  phaseModelVersion: 'phase-1',
  scoringModelVersion: 'score-1',
  shotConfigVersion: 'forehand_drive@1',
};

export function buildAnalysis(
  overrides: Partial<ShotAnalysis> & { id: string },
): ShotAnalysis {
  return {
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.8,
    analysisConfidence: 0.91,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: VERSION_VECTOR,
    source: 'real',
    ...overrides,
  };
}

export function buildAbstainedAnalysis(
  overrides: Partial<ShotAnalysis> & { id: string },
): ShotAnalysis {
  return buildAnalysis({
    overallScore: null,
    analysisConfidence: 0.31,
    resultKind: 'low_confidence',
    ...overrides,
  });
}

type AutomaticClip = Extract<
  CapturedClip,
  { captureMode: 'automatic_pose_trigger' }
>;

export function buildClip(
  overrides: Partial<AutomaticClip> = {},
): CapturedClip {
  return {
    uri: 'file:///private/captures/real.mov',
    durationMs: 3900,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 1800,
      endMs: 2450,
      peakMotionMs: 2220,
      confidence: 0.84,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'mediapipe_pose_landmarker',
      poseModelVersion: 'mediapipe-pose-landmarker-full-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 8,
      poseFrameCount: 7,
      poseMissingFrameCount: 1,
      trackedDurationMs: 600,
      meanCanonicalJointVisibility: 0.86,
      meanJointCoverage: 0.93,
      minimumJointCoverage: 0.83,
      fullBodyVisibleFrameCount: 5,
      jointMotion: [
        {
          joint: 'left_wrist',
          sampleCount: 6,
          meanNormalizedPerSecond: 1.2,
          peakNormalizedPerSecond: 2.1,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 1800,
    postRollMs: 1450,
    ...overrides,
  };
}

export function buildAnalysisRecord(input: {
  id: string;
  captureId: string;
  result: ShotAnalysis | null;
  createdAtIso?: string;
}): AnalysisRecord {
  return {
    schemaVersion: 1,
    id: input.id,
    captureId: input.captureId,
    createdAtIso: input.createdAtIso ?? '2026-08-27T18:00:05.000Z',
    engineVersion: 'fusion-1',
    strokeTaxonomyVersion: 'taxonomy-1',
    strokeResolution: { kind: 'declared', shotType: 'forehand_drive' },
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
      providerVersions: [],
      scoreVersion: 'score-1',
      taxonomyVersion: 'taxonomy-1',
      drillMappingVersion: 'drills-1',
      captureEnvelopeVersion: 'envelope-1',
      recordedAtIso: input.createdAtIso ?? '2026-08-27T18:00:05.000Z',
    },
    result: input.result,
    faults: [],
    uncertainty: {
      analysisConfidence: input.result?.analysisConfidence ?? 0,
      presentation: input.result ? 'normal' : 'abstain',
      perCheckpoint: {},
      limitingFactors: [],
    },
    evidence: [],
    shadow: [],
  };
}

/** A's resolved rank: gold, well above B's. */
export const RANK_GOLD: PlayerRankSummary = {
  rating: 5.2,
  tier: 'gold',
  tierLabel: 'Gold',
  division: 3,
  divisionLabel: 'III',
  techniqueCount: 1,
  scoredAnalysisCount: 1,
  techniques: [],
  nextTier: {
    key: 'platinum',
    label: 'Platinum',
    minRating: 6.5,
    pointsNeeded: 1.3,
  },
};

/** B's resolved rank: silver, a distinct tier and rating from A's. */
export const RANK_SILVER: PlayerRankSummary = {
  rating: 3.1,
  tier: 'silver',
  tierLabel: 'Silver',
  division: 2,
  divisionLabel: 'II',
  techniqueCount: 2,
  scoredAnalysisCount: 2,
  techniques: [],
  nextTier: {
    key: 'gold',
    label: 'Gold',
    minRating: 4.5,
    pointsNeeded: 1.4,
  },
};

export function buildProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    firstName: 'Ada',
    skillLevel: 'intermediate',
    handedness: 'right',
    goal: 'dinks',
    biggestProblem: 'popups',
    focusCheckpoint: 'contact_position',
    ...overrides,
  };
}

// ─── Seeded PRNG (mulberry32) ────────────────────────────────────────────────

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: max => Math.floor(next() * max),
    pick: items => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from empty list');
      return item;
    },
    chance: p => next() < p,
  };
}

// ─── Physical ownership matrix ───────────────────────────────────────────────

export const OWNER_TABLES = [
  'local_shot',
  'local_session',
  'local_capture',
  'local_analysis_record',
  'outbox',
  'sync_receipt',
] as const;

export type OwnerMatrix = Record<string, Record<string, number>>;

/** rows per (table × owner_key) straight from the engine — owner-agnostic. */
export function ownershipMatrix(handle: RealSqliteHandle): OwnerMatrix {
  const matrix: OwnerMatrix = {};
  for (const table of OWNER_TABLES) {
    const counts: Record<string, number> = {};
    for (const row of handle.dumpTable(table)) {
      const owner = String(row['owner_key']);
      counts[owner] = (counts[owner] ?? 0) + 1;
    }
    matrix[table] = counts;
  }
  const kv: Record<string, number> = {};
  for (const row of handle.dumpTable('kv')) {
    const key = String(row['key']);
    const owner = key.includes(':')
      ? key.slice(key.indexOf(':') + 1)
      : '<device>';
    kv[owner] = (kv[owner] ?? 0) + 1;
  }
  matrix['kv'] = kv;
  return matrix;
}

/** Stable, owner-agnostic snapshot of every row an owner holds — used to
 * prove another owner's writes changed NOTHING physical for this owner. */
export function ownerSnapshot(
  handle: RealSqliteHandle,
  owner: string,
): Record<string, SqlRow[]> {
  const snapshot: Record<string, SqlRow[]> = {};
  for (const table of OWNER_TABLES) {
    snapshot[table] = handle
      .dumpTable(table)
      .filter(row => row['owner_key'] === owner)
      .map(row => {
        // outbox.created_at is engine time; identical inserts across runs
        // differ only there.
        const { created_at: _createdAt, ...rest } = row;
        return rest;
      });
  }
  snapshot['kv'] = handle
    .dumpTable('kv')
    .filter(row => String(row['key']).endsWith(`:${owner}`));
  return snapshot;
}

// ─── Evidence sink ───────────────────────────────────────────────────────────

export function artifactDir(): string {
  const configured = process.env['XC_ARTIFACT_DIR'];
  const dir = configured
    ? resolve(configured)
    : resolve(__dirname, '../../../../artifacts/xc-journey-account-switch');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeEvidence(name: string, payload: unknown): string {
  const body = JSON.stringify(payload, null, 2);
  assertNoSecretMaterial(body, `evidence ${name}`);
  const path = join(artifactDir(), name);
  writeFileSync(path, `${body}\n`);
  return path;
}

export function heapNumbers(): Record<string, number> {
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round((usage.rss / 1048576) * 100) / 100,
    heapUsedMb: Math.round((usage.heapUsed / 1048576) * 100) / 100,
    heapTotalMb: Math.round((usage.heapTotal / 1048576) * 100) / 100,
    externalMb: Math.round((usage.external / 1048576) * 100) / 100,
  };
}
