/**
 * STRESS · scr-resultdetailsscreen · lens randomized-seeded — WORLD FIXTURES
 *
 * Everything the campaign feeds the REAL local store (production `getDb()`
 * migrations over an in-memory node:sqlite database) is generated here from
 * a seeded RNG so any iteration replays byte-for-byte from its seed. The
 * data goes through the production repository writers (`saveAnalysis`,
 * `saveLocalOnlyAnalysis`, `savePendingCapture`) wherever a writer exists;
 * the immutable analysis-record row and the sync ledgers are written with
 * the same SQL shape the app uses because their writers demand the full
 * engine record the mobile app never fabricates.
 */
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
  ShotTypeSlug,
} from '@pickle/shared-types';
import { CHECKPOINTS, SHOT_TYPES } from '@pickle/shared-types';
import type {
  CapturedClip,
  PoseSequenceSidecarRef,
} from '../../src/camera/capture';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';
import type { LocalDb } from '../../src/data/db';
import {
  saveAnalysis,
  saveLocalOnlyAnalysis,
  savePendingCapture,
} from '../../src/data/repository';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';

// ─── Seeded RNG (mulberry32 — tiny, fast, fully replayable) ─────────────────

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
    );
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick out of range');
    return item;
  }

  hex(length: number): string {
    let out = '';
    for (let i = 0; i < length; i += 1) out += this.int(0, 15).toString(16);
    return out;
  }

  /** RFC-4122 shaped v4 UUID (the training API and account scope demand it). */
  uuid(): string {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-${this.pick(['8', '9', 'a', 'b'])}${this.hex(3)}-${this.hex(12)}`;
  }
}

// ─── Analysis fixtures ──────────────────────────────────────────────────────

const DIRECTIONS: readonly FaultDirection[] = [
  'none',
  'narrow',
  'low',
  'late',
  'unstable',
  'short',
];
const PHASES: readonly PhaseKey[] = [
  'ready',
  'prepare',
  'accelerate',
  'contact',
  'follow_through',
  'recover',
];

function phase(key: PhaseKey, startMs: number, endMs: number): PhaseSpan {
  return {
    key,
    startMs,
    representativeMs: startMs + (endMs - startMs) / 2,
    endMs,
    confidence: 0.8,
  };
}

function bandFor(score: number): ScoreBand {
  if (score >= 75) return 'green';
  if (score >= 60) return 'yellow';
  return 'red';
}

function checkpoint(rng: Rng, key: CheckpointKey): CheckpointScore {
  const unscored = rng.chance(0.12);
  const score = unscored ? null : rng.int(20, 98);
  return {
    key,
    score,
    confidence: rng.chance(0.2) ? 0.4 : 0.8,
    band: score === null ? 'unscored' : bandFor(score),
    direction: score !== null && score < 75 ? rng.pick(DIRECTIONS) : 'none',
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: !rng.chance(0.15),
  };
}

export type AnalysisKind = 'scored' | 'low_confidence';

export function buildAnalysis(
  rng: Rng,
  input: {
    id: string;
    sessionId: string | null;
    shotType: ShotTypeSlug;
    capturedAtIso: string;
    kind: AnalysisKind;
  },
): ShotAnalysis {
  const checkpoints = CHECKPOINTS.map(key => checkpoint(rng, key));
  const scoredKeys = checkpoints.filter(c => c.score !== null && c.applicable);
  const worst =
    scoredKeys.length > 0
      ? scoredKeys.reduce((a, b) => ((a.score ?? 0) <= (b.score ?? 0) ? a : b))
      : null;
  const scored = input.kind === 'scored';
  return {
    id: input.id,
    sessionId: input.sessionId,
    shotType: input.shotType,
    cameraView: rng.pick(['side', 'rear_oblique'] as const),
    handedness: rng.pick(['right', 'left'] as const),
    capturedAtIso: input.capturedAtIso,
    timestamps: { startMs: 0, contactMs: scored ? 1900 : null, endMs: 3200 },
    phases: [
      phase(PHASES[0] ?? 'ready', 0, 900),
      phase(PHASES[1] ?? 'prepare', 900, 1500),
      phase(PHASES[2] ?? 'accelerate', 1500, 1900),
      phase(PHASES[3] ?? 'contact', 1880, 1920),
      phase(PHASES[4] ?? 'follow_through', 1920, 2400),
      phase(PHASES[5] ?? 'recover', 2400, 3200),
    ],
    measurements: [],
    checkpoints,
    overallScore: scored ? rng.int(20, 98) / 10 : null,
    analysisConfidence: scored ? rng.int(60, 97) / 100 : rng.int(5, 45) / 100,
    resultKind: input.kind,
    guidance: scored ? null : 'Step back so your whole body is in frame.',
    priorityFix:
      scored && worst
        ? {
            checkpoint: worst.key,
            reasonKey: 'lowest_score',
            severity: worst.severity,
            confidence: 0.8,
          }
        : null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: `${input.shotType}@1`,
    },
    source: 'real',
  };
}

// ─── Record / capture fixtures ──────────────────────────────────────────────

export type IntentKind = 'declared' | 'auto' | 'legacy_no_intent';

export function buildRecord(input: {
  id: string;
  captureId: string | null;
  createdAtIso: string;
  shotType: ShotTypeSlug;
  intent: IntentKind;
  /** Record-only result (the local_shot row is absent) when set. */
  result: ShotAnalysis | null;
  confidence: number;
}): StrokeResultEvidenceRecord {
  const record: StrokeResultEvidenceRecord = {
    id: input.id,
    createdAtIso: input.createdAtIso,
    result: input.result,
    uncertainty: {
      analysisConfidence: input.confidence,
      presentation: input.confidence >= 0.6 ? 'normal' : 'lower_confidence',
      limitingFactors: [
        'paddle_track_unavailable',
        'ball_track_unavailable',
        'court_geometry_unavailable',
      ],
    },
  };
  if (input.captureId !== null) record.captureId = input.captureId;
  if (input.intent === 'declared') {
    record.strokeIntent = {
      declaredStroke: input.shotType,
      predictedStroke: null,
      resolutionBasis: 'declared',
      resolvedProfileId: input.shotType.toUpperCase(),
      resolvedProfileVersion: 'technique-profile-v1',
      disagreement: null,
    };
  } else if (input.intent === 'auto') {
    record.strokeIntent = {
      declaredStroke: null,
      predictedStroke: null,
      resolutionBasis: 'abstained',
      resolvedProfileId: null,
      resolvedProfileVersion: null,
      disagreement: null,
    };
  }
  return record;
}

export function buildImportedClip(input: {
  uri: string;
  capturedAtIso: string;
  durationMs: number;
  poseSequence: PoseSequenceSidecarRef | null;
  posterUri: string | null;
}): CapturedClip {
  return {
    captureMode: 'imported_video',
    uri: input.uri,
    durationMs: input.durationMs,
    fps: 30,
    width: 1080,
    height: 1920,
    capturedAtIso: input.capturedAtIso,
    recognition: { status: 'unknown', reason: 'imported_clip' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    ...(input.poseSequence ? { poseSequence: input.poseSequence } : {}),
    ...(input.posterUri !== null ? { posterUri: input.posterUri } : {}),
  };
}

// ─── The generated world ────────────────────────────────────────────────────

export type SidecarKind = 'none' | 'valid' | 'hash_mismatch' | 'unreadable';
export type SyncKind =
  'synced' | 'queued' | 'rejected' | 'exhausted' | 'absent';
export type TrainingKind =
  | 'unconfigured'
  | 'plan_none'
  | 'plan_for_this_read'
  | 'plan_other_read'
  | 'plan_completed_by_this_read'
  | 'server_error'
  | 'invalid_response'
  | 'session_expired';
export type FeedbackKind = 'accept' | 'reject_500' | 'unauthorized' | 'slow';
export type PlanCreateKind = 'accept' | 'reject_422' | 'slow';
export type OwnerKind = 'canonical' | 'guest' | 'signed_out';

export interface Attempt {
  id: string;
  capturedAtIso: string;
  kind: AnalysisKind;
}

export interface World {
  seed: number;
  owner: OwnerKind;
  ownerKey: string;
  shotType: ShotTypeSlug;
  sessionId: string | null;
  /** The route target. `present` = there is a local_shot row for it. */
  target: {
    id: string;
    present: boolean;
    kind: AnalysisKind;
    /** Record row: absent, record-only result, or record beside the shot. */
    record: 'absent' | 'with_result' | 'without_result' | 'corrupt_json';
    intent: IntentKind;
    capture: 'absent' | 'valid' | 'zero_duration' | 'legacy_payload';
    sidecar: SidecarKind;
    poster: boolean;
  };
  /** Other attempts in the same session (local_shot rows). */
  siblings: Attempt[];
  /** A real shot in ANOTHER session (must never appear as a chip). */
  foreign: Attempt | null;
  sync: SyncKind;
  training: TrainingKind;
  feedback: FeedbackKind;
  planCreate: PlanCreateKind;
  /** Whether the api session is established (feedback prompt gate). */
  apiSession: boolean;
  /** Capture-row uri the sidecar reads through the native bridge. */
  sidecarUri: string;
  /** Unknown id used by near-legal "open details for a missing id" actions. */
  unknownId: string;
}

function isoAt(rng: Rng, minuteOffset: number): string {
  const base = Date.UTC(2026, 8, 1, 10, 0, 0) + minuteOffset * 60_000;
  return new Date(base + rng.int(0, 59) * 1000).toISOString();
}

export function generateWorld(seed: number): World {
  const rng = new Rng(seed ^ 0x9e3779b9);
  const owner = rng.pick<OwnerKind>([
    'canonical',
    'canonical',
    'canonical',
    'guest',
    'signed_out',
  ]);
  const ownerKey =
    owner === 'canonical'
      ? rng.uuid()
      : owner === 'guest'
        ? 'device-guest'
        : 'signed-out';
  const shotType = rng.pick(SHOT_TYPES);
  const sessionId = rng.chance(0.8) ? rng.uuid() : null;
  const present = rng.chance(0.85);
  const kind: AnalysisKind = rng.chance(0.78) ? 'scored' : 'low_confidence';
  const record = rng.pick<World['target']['record']>(
    present
      ? [
          'with_result',
          'without_result',
          'without_result',
          'absent',
          'corrupt_json',
        ]
      : [
          'with_result',
          'with_result',
          'absent',
          'corrupt_json',
          'without_result',
        ],
  );
  const capture = rng.pick<World['target']['capture']>([
    'valid',
    'valid',
    'valid',
    'absent',
    'zero_duration',
    'legacy_payload',
  ]);
  const sidecar =
    capture === 'valid'
      ? rng.pick<SidecarKind>([
          'valid',
          'valid',
          'none',
          'hash_mismatch',
          'unreadable',
        ])
      : 'none';
  const siblingCount = sessionId === null ? rng.int(0, 2) : rng.int(0, 4);
  const siblings: Attempt[] = [];
  for (let i = 0; i < siblingCount; i += 1) {
    siblings.push({
      id: rng.uuid(),
      capturedAtIso: isoAt(rng, -(i + 1) * 3),
      kind: rng.chance(0.8) ? 'scored' : 'low_confidence',
    });
  }
  const foreign = rng.chance(0.5)
    ? {
        id: rng.uuid(),
        capturedAtIso: isoAt(rng, -40),
        kind: 'scored' as const,
      }
    : null;
  const sync = rng.pick<SyncKind>([
    'synced',
    'synced',
    'queued',
    'rejected',
    'exhausted',
    'absent',
  ]);
  const training = rng.pick<TrainingKind>([
    'unconfigured',
    'unconfigured',
    'plan_none',
    'plan_for_this_read',
    'plan_other_read',
    'plan_completed_by_this_read',
    'server_error',
    'invalid_response',
    'session_expired',
  ]);
  return {
    seed,
    owner,
    ownerKey,
    shotType,
    sessionId,
    target: {
      id: rng.uuid(),
      present,
      kind,
      record,
      intent: rng.pick<IntentKind>([
        'declared',
        'declared',
        'auto',
        'legacy_no_intent',
      ]),
      capture,
      sidecar,
      poster: rng.chance(0.5),
    },
    siblings,
    foreign,
    sync,
    training,
    feedback: rng.pick<FeedbackKind>([
      'accept',
      'accept',
      'reject_500',
      'unauthorized',
      'slow',
    ]),
    planCreate: rng.pick<PlanCreateKind>([
      'accept',
      'accept',
      'reject_422',
      'slow',
    ]),
    apiSession: rng.chance(0.6),
    sidecarUri: `file:///captures/${rng.hex(8)}.pose.json`,
    unknownId: rng.uuid(),
  };
}

// ─── Seeding the real local store ───────────────────────────────────────────

export interface SeededWorld {
  world: World;
  targetAnalysis: ShotAnalysis | null;
  targetRecord: StrokeResultEvidenceRecord | null;
  /** Exactly the chips `attemptChips` must produce (sorted by captured time). */
  expectedChipIds: string[];
  /** Every analysis the screen can resolve (local_shot rows + record result). */
  analyses: Map<string, ShotAnalysis>;
}

export async function seedWorld(
  db: LocalDb,
  world: World,
  sidecar: { ref: PoseSequenceSidecarRef; mismatchRef: PoseSequenceSidecarRef },
): Promise<SeededWorld> {
  const rng = new Rng(world.seed ^ 0x51ed270b);
  if (world.owner === 'signed_out') {
    // Nothing is writable for a signed-out process; the route must land on
    // the honest "not on this device" state.
    return {
      world,
      targetAnalysis: null,
      targetRecord: null,
      expectedChipIds: [],
      analyses: new Map(),
    };
  }
  const targetIso = isoAt(rng, 0);
  const targetAnalysis = buildAnalysis(rng, {
    id: world.target.id,
    sessionId: world.sessionId,
    shotType: world.shotType,
    capturedAtIso: targetIso,
    kind: world.target.kind,
  });
  const analyses = new Map<string, ShotAnalysis>();
  if (world.target.present || world.target.record === 'with_result') {
    analyses.set(world.target.id, targetAnalysis);
  }
  if (world.target.present) {
    if (targetAnalysis.resultKind === 'scored') {
      await saveAnalysis(db, targetAnalysis, `permit-${rng.hex(6)}`);
    } else {
      await saveLocalOnlyAnalysis(db, targetAnalysis);
    }
  }
  for (const sibling of world.siblings) {
    const analysis = buildAnalysis(rng, {
      id: sibling.id,
      sessionId: world.sessionId,
      shotType: world.shotType,
      capturedAtIso: sibling.capturedAtIso,
      kind: sibling.kind,
    });
    analyses.set(sibling.id, analysis);
    if (analysis.resultKind === 'scored') {
      await saveAnalysis(db, analysis, `permit-${rng.hex(6)}`);
    } else {
      await saveLocalOnlyAnalysis(db, analysis);
    }
  }
  if (world.foreign) {
    const analysis = buildAnalysis(rng, {
      id: world.foreign.id,
      sessionId: rng.uuid(),
      shotType: world.shotType,
      capturedAtIso: world.foreign.capturedAtIso,
      kind: 'scored',
    });
    await saveAnalysis(db, analysis, `permit-${rng.hex(6)}`);
  }

  const captureId = world.target.capture === 'absent' ? null : rng.uuid();
  const captureUri = `file:///captures/${rng.hex(10)}.mov`;
  if (captureId !== null) {
    const sidecarRef: PoseSequenceSidecarRef | null =
      world.target.sidecar === 'none'
        ? null
        : world.target.sidecar === 'hash_mismatch'
          ? { ...sidecar.mismatchRef, uri: world.sidecarUri }
          : { ...sidecar.ref, uri: world.sidecarUri };
    const clip = buildImportedClip({
      uri: captureUri,
      capturedAtIso: targetIso,
      durationMs: world.target.capture === 'zero_duration' ? 1 : 3200,
      poseSequence: sidecarRef,
      posterUri: world.target.poster ? `${captureUri}.poster.jpg` : null,
    });
    await savePendingCapture(
      db,
      captureId,
      world.shotType,
      clip,
      world.shotType,
    );
    if (world.target.capture === 'zero_duration') {
      // The row was written by the app writer; a duration of 0 is what an
      // older build could have persisted — the clip card must not render.
      await db.execute(
        `UPDATE local_capture SET duration_ms = 0 WHERE owner_key = ? AND id = ?`,
        [world.ownerKey, captureId],
      );
    } else if (world.target.capture === 'legacy_payload') {
      await db.execute(
        `UPDATE local_capture SET payload = NULL WHERE owner_key = ? AND id = ?`,
        [world.ownerKey, captureId],
      );
    }
  }

  let targetRecord: StrokeResultEvidenceRecord | null = null;
  if (world.target.record !== 'absent') {
    targetRecord = buildRecord({
      id: world.target.id,
      captureId,
      createdAtIso: targetIso,
      shotType: world.shotType,
      intent: world.target.intent,
      result: world.target.record === 'with_result' ? targetAnalysis : null,
      confidence: targetAnalysis.analysisConfidence,
    });
    const payload =
      world.target.record === 'corrupt_json'
        ? '{"id":"' + world.target.id + '","result":'
        : JSON.stringify(targetRecord);
    await db.execute(
      `INSERT INTO local_analysis_record
        (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        world.ownerKey,
        world.target.id,
        captureId ?? 'capture-missing',
        targetIso,
        'fusion-engine-1',
        'sm-v1',
        payload,
      ],
    );
    if (world.target.record === 'corrupt_json') targetRecord = null;
  }

  // Sync ledgers: the receipt wins over the outbox row; the outbox row's
  // attempt count decides queued / rejected / exhausted.
  if (world.sync === 'synced') {
    await db.execute(
      `INSERT OR REPLACE INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)`,
      [world.ownerKey, world.target.id],
    );
  } else if (world.sync !== 'absent') {
    // `saveAnalysis` already queued a row for a scored present target; drive
    // its attempts to the generated state. For other targets add the row the
    // way the sync engine would have left it.
    const attempts =
      world.sync === 'queued'
        ? 0
        : world.sync === 'rejected'
          ? rng.int(1, OUTBOX_MAX_ATTEMPTS - 1)
          : OUTBOX_MAX_ATTEMPTS + rng.int(0, 2);
    const lastError =
      attempts > 0 ? `HTTP ${rng.pick([400, 409, 422, 429])}` : null;
    const existing = await db.execute(
      `SELECT id FROM outbox WHERE owner_key = ? AND kind = 'shot.sync' AND json_extract(payload, '$.id') = ?`,
      [world.ownerKey, world.target.id],
    );
    if (existing.rows.length > 0) {
      await db.execute(
        `UPDATE outbox SET attempts = ?, last_error = ? WHERE owner_key = ? AND kind = 'shot.sync' AND json_extract(payload, '$.id') = ?`,
        [attempts, lastError, world.ownerKey, world.target.id],
      );
    } else {
      await db.execute(
        `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error) VALUES (?, 'shot.sync', ?, ?, ?)`,
        [
          world.ownerKey,
          JSON.stringify({
            ...targetAnalysis,
            analysisPermitId: `permit-${rng.hex(6)}`,
          }),
          attempts,
          lastError,
        ],
      );
    }
  } else {
    await db.execute(
      `DELETE FROM outbox WHERE owner_key = ? AND kind = 'shot.sync' AND json_extract(payload, '$.id') = ?`,
      [world.ownerKey, world.target.id],
    );
  }

  // Every local_shot row of the session (a record-only target has no row),
  // in the order `attemptChips` sorts them.
  const chips =
    world.sessionId !== null
      ? [
          ...(world.target.present
            ? [{ id: world.target.id, iso: targetIso }]
            : []),
          ...world.siblings.map(s => ({ id: s.id, iso: s.capturedAtIso })),
        ]
          .sort((a, b) =>
            a.iso === b.iso
              ? a.id.localeCompare(b.id)
              : a.iso.localeCompare(b.iso),
          )
          .map(c => c.id)
      : [];
  return {
    world,
    targetAnalysis,
    targetRecord,
    expectedChipIds: chips,
    analyses,
  };
}
