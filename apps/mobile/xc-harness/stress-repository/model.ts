/**
 * Reference model of the account-scoped local repository.
 *
 * The model is a plain in-memory description of what the SQLite store MUST
 * contain after a sequence of public-API calls, derived only from the
 * documented contracts in src/data/repository.ts and accountScope.ts:
 *
 *  - every row is partitioned by owner_key; reads see the active owner only
 *  - signed-out is never a writable owner
 *  - saveAnalysis/saveSession/finishSession are atomic with their outbox row
 *  - INSERT OR REPLACE semantics for shots/sessions, INSERT (unique) for
 *    captures (id and uri) and analysis records
 *  - purgeOwnerData removes every owner-partitioned row and kv namespace key
 *  - list ordering: shots newest-first (activity oldest-first), analysis
 *    records (created_at, id) ascending, live sessions (started_at, id) asc
 *  - recentScores returns the newest `limit` scored values oldest-first
 *  - facts expose only applicable, finite checkpoint scores
 *
 * The model deliberately knows nothing about SQL; the campaign compares its
 * projections with what the real repository functions return.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { ShotAnalysis, ShotTypeSlug } from '@pickle/shared-types';
import type { CapturedClip } from '../../src/camera/capture';
import type { ScoredCheckpointFact } from '../../src/library/libraryFocus';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import type {
  ActivityShotRow,
  CaptureHistoryEntry,
  CaptureTargetSeed,
  LiveSessionHistoryRow,
  LocalShotRow,
  PendingCapture,
  RealAnalysisFact,
  ShotOutboxStatus,
} from '../../src/data/repository';
import { OWNER_SCOPED_KV_NAMESPACES } from '../../src/data/repository';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';

export const OWNER_SCOPED_TABLES = [
  'local_shot',
  'local_session',
  'local_capture',
  'local_analysis_record',
  'outbox',
  'sync_receipt',
] as const;
export type OwnerScopedTable = (typeof OWNER_SCOPED_TABLES)[number];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ModelSession {
  id: string;
  mode: string;
  shotType: string | null;
  focusCheckpoint: string | null;
  startedAt: string;
  completed: boolean;
  summary: string | null;
}

export interface ModelCapture {
  id: string;
  shotType: string;
  declaredStroke: ShotTypeSlug | null;
  /** Identity columns as written by savePendingCapture. */
  identity: CapturedClip;
  /** Current payload column (may diverge after updateCaptureClipPayload). */
  payload: CapturedClip;
  status: 'awaiting_model' | 'analyzed';
  targetSeed: CaptureTargetSeed | null;
}

export interface ModelOutboxRow {
  kind: 'shot.sync' | 'session.create' | 'session.finalize';
  entityId: string;
  attempts: number;
  lastError: string | null;
}

export interface OwnerBucket {
  shots: Map<string, ShotAnalysis>;
  sessions: Map<string, ModelSession>;
  captures: Map<string, ModelCapture>;
  records: Map<string, AnalysisRecord>;
  outbox: ModelOutboxRow[];
  receipts: Set<string>;
}

function emptyBucket(): OwnerBucket {
  return {
    shots: new Map(),
    sessions: new Map(),
    captures: new Map(),
    records: new Map(),
    outbox: [],
    receipts: new Set(),
  };
}

export class RepositoryModel {
  activeOwner: string = SIGNED_OUT_DATA_OWNER;
  readonly owners = new Map<string, OwnerBucket>();
  readonly kv = new Map<string, string>();

  bucket(owner: string): OwnerBucket {
    let bucket = this.owners.get(owner);
    if (!bucket) {
      bucket = emptyBucket();
      this.owners.set(owner, bucket);
    }
    return bucket;
  }

  peek(owner: string): OwnerBucket | null {
    return this.owners.get(owner) ?? null;
  }

  /** Mirrors setActiveDataOwner's acceptance rule; returns false when the
   * real call must throw. */
  setOwner(owner: string): boolean {
    if (
      owner !== GUEST_DATA_OWNER &&
      owner !== SIGNED_OUT_DATA_OWNER &&
      !UUID_PATTERN.test(owner)
    ) {
      return false;
    }
    this.activeOwner = owner.toLowerCase();
    return true;
  }

  get writable(): boolean {
    return this.activeOwner !== SIGNED_OUT_DATA_OWNER;
  }

  get active(): OwnerBucket {
    return this.bucket(this.activeOwner);
  }

  purge(owner: string): void {
    this.owners.set(owner, emptyBucket());
    for (const namespace of OWNER_SCOPED_KV_NAMESPACES) {
      this.kv.delete(`${namespace}:${owner}`);
    }
  }

  // ---- projections (what the public reads must return) -------------------

  private realShotsDesc(): ShotAnalysis[] {
    return Array.from(this.active.shots.values())
      .filter(shot => shot.source === 'real')
      .sort((a, b) => cmp(b.capturedAtIso, a.capturedAtIso));
  }

  listShots(limit: number): LocalShotRow[] {
    return this.realShotsDesc()
      .slice(0, limit)
      .map(shot => ({
        id: shot.id,
        sessionId: shot.sessionId ? shot.sessionId : null,
        shotType: shot.shotType,
        capturedAt: shot.capturedAtIso,
        overallScore: shot.overallScore,
        confidence: shot.analysisConfidence,
        resultKind: shot.resultKind,
        source: shot.source,
        favorite: false,
      }));
  }

  listActivityShots(): ActivityShotRow[] {
    return this.realShotsDesc()
      .reverse()
      .map(shot => ({
        id: shot.id,
        sessionId: shot.sessionId ? shot.sessionId : null,
        shotType: shot.shotType,
        capturedAt: shot.capturedAtIso,
        overallScore: shot.overallScore,
        resultKind: shot.resultKind,
      }));
  }

  getAnalysis(id: string): ShotAnalysis | null {
    const shot = this.active.shots.get(id);
    return shot && shot.source === 'real' ? shot : null;
  }

  recentScores(shotType: string | null, limit: number): number[] {
    return this.realShotsDesc()
      .filter(
        shot =>
          shot.resultKind === 'scored' &&
          (shotType === null || shot.shotType === shotType),
      )
      .slice(0, limit)
      .map(shot => shot.overallScore)
      .filter((value): value is number => value !== null)
      .reverse();
  }

  listRealAnalysisFacts(limit: number | null): RealAnalysisFact[] {
    const shots = this.realShotsDesc();
    return (limit === null ? shots : shots.slice(0, limit)).map(shot => ({
      id: shot.id,
      shotType: shot.shotType,
      capturedAt: shot.capturedAtIso,
      overallScore: shot.overallScore,
      confidence: shot.analysisConfidence,
      resultKind: shot.resultKind,
      scoringModelVersion: shot.versionVector.scoringModelVersion,
      shotConfigVersion: shot.versionVector.shotConfigVersion,
      sessionId: shot.sessionId ? shot.sessionId : null,
      priorityCheckpoint: shot.priorityFix?.checkpoint ?? null,
      checkpointScores: Object.fromEntries(
        shot.checkpoints
          .filter(
            checkpoint =>
              checkpoint.applicable === true &&
              typeof checkpoint.score === 'number' &&
              Number.isFinite(checkpoint.score),
          )
          .map(checkpoint => [checkpoint.key, checkpoint.score as number]),
      ),
    }));
  }

  listScoredCheckpointFacts(limit: number): ScoredCheckpointFact[] {
    return this.realShotsDesc()
      .filter(shot => shot.resultKind === 'scored')
      .slice(0, limit)
      .map(shot => ({
        id: shot.id,
        shotType: shot.shotType,
        capturedAt: shot.capturedAtIso,
        checkpoints: shot.checkpoints.map(checkpoint => ({
          key: checkpoint.key,
          score:
            typeof checkpoint.score === 'number' &&
            Number.isFinite(checkpoint.score)
              ? checkpoint.score
              : null,
          applicable: checkpoint.applicable === true,
        })),
      }));
  }

  private captureEntry(capture: ModelCapture): PendingCapture {
    const identity = capture.identity;
    const payload = capture.payload;
    const metadataMatches =
      payload.uri === identity.uri &&
      payload.capturedAtIso === identity.capturedAtIso &&
      payload.durationMs === identity.durationMs &&
      payload.fps === identity.fps &&
      payload.width === identity.width &&
      payload.height === identity.height;
    return {
      id: capture.id,
      uri: identity.uri,
      shotType: capture.shotType,
      declaredStroke: capture.declaredStroke,
      capturedAtIso: identity.capturedAtIso,
      durationMs: identity.durationMs,
      fps: identity.fps,
      width: identity.width,
      height: identity.height,
      clip: metadataMatches ? payload : null,
      evidenceStatus: metadataMatches ? 'valid' : 'metadata_mismatch',
    };
  }

  private capturesDesc(): ModelCapture[] {
    return Array.from(this.active.captures.values()).sort((a, b) =>
      cmp(b.identity.capturedAtIso, a.identity.capturedAtIso),
    );
  }

  listPendingCaptures(limit: number | null): PendingCapture[] {
    const pending = this.capturesDesc().filter(
      capture => capture.status === 'awaiting_model',
    );
    return (limit === null ? pending : pending.slice(0, limit)).map(capture =>
      this.captureEntry(capture),
    );
  }

  listCaptureHistory(limit: number | null): CaptureHistoryEntry[] {
    const all = this.capturesDesc();
    return (limit === null ? all : all.slice(0, limit)).map(capture => ({
      ...this.captureEntry(capture),
      status: capture.status,
    }));
  }

  getPendingCapture(id: string): PendingCapture | null {
    const capture = this.active.captures.get(id);
    return capture ? this.captureEntry(capture) : null;
  }

  getCaptureTargetSeed(id: string): CaptureTargetSeed | null {
    return this.active.captures.get(id)?.targetSeed ?? null;
  }

  listAnalysisRecords(captureId: string): AnalysisRecord[] {
    return Array.from(this.active.records.values())
      .filter(record => record.captureId === captureId)
      .sort((a, b) => cmp(a.createdAtIso, b.createdAtIso) || cmp(a.id, b.id));
  }

  listLiveSessionHistory(limit: number): LiveSessionHistoryRow[] {
    return Array.from(this.active.sessions.values())
      .filter(session => session.mode === 'live_court' && session.completed)
      .sort((a, b) => cmp(a.startedAt, b.startedAt) || cmp(a.id, b.id))
      .slice(0, limit)
      .map(session => ({
        id: session.id,
        startedAt: session.startedAt,
        // ended_at is datetime('now'): only its presence is modelled.
        endedAt: session.completed ? 'present' : null,
        summary: session.summary,
      }));
  }

  hasShotSyncReceipt(shotId: string): boolean {
    return this.active.receipts.has(shotId);
  }

  getShotOutboxStatus(shotId: string): ShotOutboxStatus {
    const rows = this.active.outbox.filter(
      row => row.kind === 'shot.sync' && row.entityId === shotId,
    );
    const row = rows[rows.length - 1];
    if (!row) return { state: 'absent' };
    const lastError = row.lastError ? row.lastError : null;
    if (row.attempts >= OUTBOX_MAX_ATTEMPTS) {
      return { state: 'exhausted', attempts: row.attempts, lastError };
    }
    if (row.attempts > 0) {
      return { state: 'rejected', attempts: row.attempts, lastError };
    }
    return { state: 'queued', attempts: row.attempts, lastError };
  }

  getKv(key: string): string | null {
    return this.kv.get(key) ?? null;
  }

  /** owner_key → row count for one table, omitting owners with zero rows
   * (the shape of `SELECT owner_key, COUNT(*) … GROUP BY owner_key`). */
  rowCounts(table: OwnerScopedTable): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [owner, bucket] of this.owners) {
      const count =
        table === 'local_shot'
          ? bucket.shots.size
          : table === 'local_session'
            ? bucket.sessions.size
            : table === 'local_capture'
              ? bucket.captures.size
              : table === 'local_analysis_record'
                ? bucket.records.size
                : table === 'outbox'
                  ? bucket.outbox.length
                  : bucket.receipts.size;
      if (count > 0) counts[owner] = count;
    }
    return counts;
  }
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
