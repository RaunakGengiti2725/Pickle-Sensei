/**
 * Seeded fixtures for the repository stress harness. Everything derives from
 * a `makePrng(seed)` stream so an iteration is replayable from its seed alone.
 */
import {
  CHECKPOINTS,
  SHOT_TYPES,
  type CheckpointScore,
  type ShotAnalysis,
  type ShotTypeSlug,
} from '@pickle/shared-types';
import type { CapturedClip } from '../../src/camera/capture';
import type { SqliteDatabaseSync } from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  CANONICAL_ID,
  OTHER_CANONICAL_ID,
  RAW_STRING_VARIANTS,
  pick,
} from '../../xc-harness/lifecycle-persistence/seeds';
import { GUEST_DATA_OWNER } from '../../src/data/accountScope';

export const OWNER_A = CANONICAL_ID;
export const OWNER_B = OTHER_CANONICAL_ID;
export const OWNER_GUEST = GUEST_DATA_OWNER;

export type Rng = () => number;

export function int(rng: Rng, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

const HEX = '0123456789abcdef';

/** RFC-4122-shaped v4 id from the seeded stream (matches the app's ids). */
export function uuid(rng: Rng): string {
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += pick(rng, ['8', '9', 'a', 'b']);
    else out += HEX[int(rng, 0, 15)];
  }
  return out;
}

export function isoAt(index: number, rng?: Rng): string {
  const base = Date.UTC(2026, 0, 1) + index * 60_000;
  const jitter = rng ? int(rng, 0, 59_000) : 0;
  return new Date(base + jitter).toISOString();
}

export function checkpointScores(rng: Rng): CheckpointScore[] {
  const count = int(rng, 0, CHECKPOINTS.length);
  return CHECKPOINTS.slice(0, count).map(key => {
    const applicable = rng() < 0.8;
    const observed = rng() < 0.85;
    const score = observed ? int(rng, 0, 100) : null;
    return {
      key,
      score,
      confidence: Math.round(rng() * 100) / 100,
      band:
        score === null
          ? 'unscored'
          : score < 50
            ? 'red'
            : score < 75
              ? 'yellow'
              : 'green',
      direction: 'none',
      severity:
        score === null ? 0 : Math.round(((100 - score) / 100) * 100) / 100,
      applicable,
    };
  });
}

export interface AnalysisOptions {
  id?: string;
  sessionId?: string | null;
  shotType?: ShotTypeSlug;
  resultKind?: 'scored' | 'low_confidence';
  source?: ShotAnalysis['source'];
  capturedAtIso?: string;
}

export function makeAnalysis(
  rng: Rng,
  options: AnalysisOptions = {},
): ShotAnalysis {
  const resultKind =
    options.resultKind ?? (rng() < 0.8 ? 'scored' : 'low_confidence');
  const checkpoints = checkpointScores(rng);
  const scored = resultKind === 'scored';
  return {
    id: options.id ?? uuid(rng),
    sessionId: options.sessionId ?? (rng() < 0.3 ? uuid(rng) : null),
    shotType: options.shotType ?? pick(rng, SHOT_TYPES),
    cameraView: pick(rng, ['side', 'rear_oblique'] as const),
    handedness: pick(rng, ['right', 'left'] as const),
    capturedAtIso: options.capturedAtIso ?? isoAt(int(rng, 0, 100_000)),
    timestamps: {
      startMs: 0,
      contactMs: scored ? int(rng, 100, 1500) : null,
      endMs: 1800,
    },
    phases: [],
    measurements: [],
    checkpoints,
    overallScore: scored ? int(rng, 0, 100) / 10 : null,
    analysisConfidence: Math.round(rng() * 100) / 100,
    resultKind,
    guidance: scored ? null : 'Move the camera to the side of the court.',
    priorityFix:
      scored && checkpoints.length > 0
        ? {
            checkpoint: (pick(rng, checkpoints) as CheckpointScore).key,
            reasonKey: 'lowest_applicable',
            severity: Math.round(rng() * 100) / 100,
            confidence: Math.round(rng() * 100) / 100,
          }
        : null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'validated-bundle-1',
      poseModelVersion: 'pose-1',
      paddleModelVersion: 'paddle-1',
      strokeDetectorVersion: 'stroke-1',
      phaseModelVersion: 'phase-1',
      scoringModelVersion: `score-${int(rng, 1, 3)}`,
      shotConfigVersion: `${options.shotType ?? 'forehand_drive'}@1`,
    },
    source: options.source ?? 'real',
  };
}

export function makePermitId(rng: Rng): string {
  return `permit-${uuid(rng)}`;
}

export function makeClip(
  rng: Rng,
  overrides: Partial<CapturedClip> = {},
): CapturedClip {
  const clip: CapturedClip = {
    uri: `file:///private/imports/${uuid(rng)}.mov`,
    durationMs: int(rng, 1000, 9000),
    fps: pick(rng, [30, 59.94, 60]),
    width: 1920,
    height: 1080,
    capturedAtIso: isoAt(int(rng, 0, 100_000)),
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
  return { ...clip, ...overrides } as CapturedClip;
}

export interface SessionFixture {
  id: string;
  mode: string;
  shotType: string | null;
  focusCheckpoint: string | null;
  startedAt: string;
}

export function makeSession(rng: Rng, mode?: string): SessionFixture {
  return {
    id: uuid(rng),
    mode: mode ?? pick(rng, ['practice_set', 'live_court', 'free']),
    shotType: rng() < 0.7 ? pick(rng, SHOT_TYPES) : null,
    focusCheckpoint: rng() < 0.5 ? pick(rng, CHECKPOINTS) : null,
    startedAt: isoAt(int(rng, 0, 100_000)),
  };
}

/** Persisted-corruption variants for TEXT payload columns. `shape-drift-*`
 * are valid JSON of the right provenance but the wrong shape — what an
 * older build's row or a partially migrated record looks like. */
export const PAYLOAD_CORRUPTIONS = {
  ...RAW_STRING_VARIANTS,
  'shape-drift-real-empty': '{"source":"real","versionVector":{}}',
  'shape-drift-real-no-vector': '{"source":"real","id":"x"}',
  'shape-drift-scored-no-checkpoints':
    '{"source":"real","resultKind":"scored","id":"x","versionVector":{"scoringModelVersion":"s"}}',
  'shape-drift-checkpoints-not-array':
    '{"source":"real","resultKind":"scored","id":"x","checkpoints":{"key":1},"versionVector":{}}',
  'shape-drift-checkpoint-nulls':
    '{"source":"real","resultKind":"scored","id":"x","checkpoints":[null,1,"a"],"versionVector":{}}',
  'fixture-source-in-real-row': JSON.stringify({
    id: 'fixture-1',
    source: 'fixture',
    resultKind: 'scored',
    versionVector: {},
  }),
} as const;
export type PayloadCorruptionName = keyof typeof PAYLOAD_CORRUPTIONS;
export const PAYLOAD_CORRUPTION_NAMES = Object.keys(
  PAYLOAD_CORRUPTIONS,
) as PayloadCorruptionName[];

export interface SeededShot {
  owner: string;
  analysis: ShotAnalysis;
}

/**
 * Bulk-inserts `count` real shots for `owner` straight into the raw
 * connection (mirrors saveAnalysis' row shape, plus a sync receipt so the
 * row reads as already synced). One prepared statement inside one
 * transaction: 10k rows land in well under a second.
 */
export function seedShots(
  raw: SqliteDatabaseSync,
  owner: string,
  count: number,
  rng: Rng,
  options: { duplicateEvery?: number; sessionIds?: string[] } = {},
): SeededShot[] {
  const insert = raw.prepare(
    `INSERT OR REPLACE INTO local_shot
       (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const receipt = raw.prepare(
    `INSERT OR REPLACE INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)`,
  );
  const seeded: SeededShot[] = [];
  raw.exec('BEGIN');
  try {
    for (let i = 0; i < count; i++) {
      const duplicateOf =
        options.duplicateEvery && i > 0 && i % options.duplicateEvery === 0
          ? seeded[int(rng, 0, seeded.length - 1)]
          : null;
      const analysis = makeAnalysis(rng, {
        id: duplicateOf?.analysis.id,
        sessionId: options.sessionIds
          ? pick(rng, options.sessionIds)
          : undefined,
        capturedAtIso: isoAt(i, rng),
      });
      insert.run(
        owner,
        analysis.id,
        analysis.sessionId,
        analysis.shotType,
        analysis.capturedAtIso,
        analysis.overallScore,
        analysis.analysisConfidence,
        analysis.resultKind,
        analysis.source,
        JSON.stringify(analysis),
      );
      receipt.run(owner, analysis.id);
      seeded.push({ owner, analysis });
    }
    raw.exec('COMMIT');
  } catch (error) {
    raw.exec('ROLLBACK');
    throw error;
  }
  return seeded;
}

/** Inserts one local_shot row whose payload is the named corruption but whose
 * columns look like a normal real scored shot. */
export function plantCorruptShot(
  raw: SqliteDatabaseSync,
  owner: string,
  id: string,
  corruption: PayloadCorruptionName,
  resultKind: 'scored' | 'low_confidence' = 'scored',
): void {
  const payload = PAYLOAD_CORRUPTIONS[corruption];
  raw
    .prepare(
      `INSERT OR REPLACE INTO local_shot
         (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
       VALUES (?, ?, NULL, 'dink', '2026-01-01T00:00:00.000Z', 5.5, 0.9, ?, 'real', ?)`,
    )
    .run(owner, id, resultKind, payload === null ? '' : payload);
  // The realistic history: the shot synced fine, the payload was damaged
  // afterwards (torn write, older build). Keep the pair consistent.
  raw
    .prepare(
      `INSERT OR REPLACE INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)`,
    )
    .run(owner, id);
}

export function plantCorruptOutbox(
  raw: SqliteDatabaseSync,
  owner: string,
  corruption: PayloadCorruptionName,
  kind = 'shot.sync',
): number {
  const payload = PAYLOAD_CORRUPTIONS[corruption];
  raw
    .prepare(`INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)`)
    .run(owner, kind, payload === null ? '' : payload);
  const row = raw.prepare('SELECT last_insert_rowid() AS id').get() as {
    id: number | bigint;
  };
  return Number(row.id);
}

export function plantCorruptCapture(
  raw: SqliteDatabaseSync,
  owner: string,
  id: string,
  corruption: PayloadCorruptionName | 'null-payload',
): void {
  const payload =
    corruption === 'null-payload' ? null : PAYLOAD_CORRUPTIONS[corruption];
  raw
    .prepare(
      `INSERT OR REPLACE INTO local_capture
         (owner_key, id, uri, shot_type, captured_at, duration_ms, fps, width, height, status, payload)
       VALUES (?, ?, ?, 'dink', '2026-01-01T00:00:00.000Z', 3000, 30, 1920, 1080, 'awaiting_model', ?)`,
    )
    .run(owner, id, `file:///corrupt/${id}.mov`, payload);
}

export function plantCorruptAnalysisRecord(
  raw: SqliteDatabaseSync,
  owner: string,
  captureId: string,
  corruption: PayloadCorruptionName,
  id = `rec-${corruption}`,
): void {
  const payload = PAYLOAD_CORRUPTIONS[corruption];
  raw
    .prepare(
      `INSERT OR REPLACE INTO local_analysis_record
         (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 'engine-1', 'score-1', ?)`,
    )
    .run(owner, id, captureId, payload === null ? '' : payload);
}
