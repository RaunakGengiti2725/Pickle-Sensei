import {
  isVerifiedMotion3DAnalysis,
  parseMotion3DAnalysis,
  type Motion3DAnalysis,
} from '@pickle/analysis-pipeline';
import { SHOT_TYPES, type ShotTypeSlug } from '@pickle/shared-types';
import {
  captureDataOwnerScope,
  isDataOwnerScopeCurrent,
  SIGNED_OUT_DATA_OWNER,
  type DataOwnerScope,
} from './accountScope';
import type { LocalDb } from './db';

const ERROR_MESSAGES = {
  'motion_3d.signed_out':
    'Sign in or continue locally before saving product data.',
  'motion_3d.owner_changed':
    'The data owner changed before the 3D analysis could be saved.',
  'motion_3d.invalid_analysis':
    'The 3D analysis is unsupported or could not be verified.',
  'motion_3d.capture_missing':
    'The saved recording could not be found for this account.',
  'motion_3d.capture_mismatch':
    'The 3D analysis does not match the saved recording.',
  'motion_3d.storage_failed':
    'The local 3D analysis could not be read or saved.',
  'motion_3d.invalid_limit':
    '3D history limit must be an integer from 1 to 500.',
} as const;

export type Motion3DRepositoryErrorCode = keyof typeof ERROR_MESSAGES;

export class Motion3DRepositoryError extends Error {
  constructor(
    readonly code: Motion3DRepositoryErrorCode,
    readonly cause?: unknown,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'Motion3DRepositoryError';
  }
}

export interface Motion3DHistoryEntry {
  id: string;
  captureId: string;
  capturedAtIso: string;
  declaredStroke: ShotTypeSlug | null;
}

const ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const ANALYSIS_SELECT = `SELECT motion.owner_key, motion.id, motion.capture_id,
  motion.created_at, motion.captured_at, motion.declared_stroke,
  motion.record_json, motion.artifact_json,
  capture.id AS linked_capture_id, capture.captured_at AS linked_captured_at
  FROM local_motion_analysis AS motion
  INNER JOIN local_capture AS capture
    ON capture.owner_key = motion.owner_key AND capture.id = motion.capture_id`;

function assertWritableScope(scope: DataOwnerScope): void {
  if (scope.owner === SIGNED_OUT_DATA_OWNER) {
    throw new Motion3DRepositoryError('motion_3d.signed_out');
  }
  if (!isDataOwnerScopeCurrent(scope)) {
    throw new Motion3DRepositoryError('motion_3d.owner_changed');
  }
}

function snapshotAnalysis(analysis: Motion3DAnalysis): {
  analysis: Motion3DAnalysis;
  recordJson: string;
} {
  try {
    const recordJson = JSON.stringify(analysis.record);
    if (isVerifiedMotion3DAnalysis(analysis)) return { analysis, recordJson };
    const parsed = parseMotion3DAnalysis(recordJson, analysis.artifactJson);
    if (
      !parsed.ok ||
      JSON.stringify(analysis.artifact) !==
        JSON.stringify(parsed.value.artifact)
    ) {
      throw new Motion3DRepositoryError('motion_3d.invalid_analysis');
    }
    return { analysis: parsed.value, recordJson };
  } catch (error) {
    if (error instanceof Motion3DRepositoryError) throw error;
    throw new Motion3DRepositoryError('motion_3d.invalid_analysis', error);
  }
}

export async function saveMotion3DAnalysis(
  db: LocalDb,
  analysis: Motion3DAnalysis,
  scope: DataOwnerScope,
): Promise<void> {
  const ownerScope = { owner: scope.owner, generation: scope.generation };
  assertWritableScope(ownerScope);
  const snapshot = snapshotAnalysis(analysis);
  const { record, artifactJson } = snapshot.analysis;
  const transact = async (executor: LocalDb) => {
    assertWritableScope(ownerScope);
    await executor.execute('BEGIN IMMEDIATE');
    try {
      assertWritableScope(ownerScope);
      const { rows } = await executor.execute(
        `SELECT owner_key, id, captured_at, declared_stroke
         FROM local_capture WHERE owner_key = ? AND id = ?`,
        [ownerScope.owner, record.captureId],
      );
      assertWritableScope(ownerScope);
      const capture = rows[0];
      if (!capture) {
        throw new Motion3DRepositoryError('motion_3d.capture_missing');
      }
      if (
        capture['owner_key'] !== ownerScope.owner ||
        capture['id'] !== record.captureId ||
        capture['captured_at'] !== record.capturedAtIso ||
        capture['declared_stroke'] !== record.declaredStroke
      ) {
        throw new Motion3DRepositoryError('motion_3d.capture_mismatch');
      }
      await executor.execute(
        `INSERT INTO local_motion_analysis
          (owner_key, id, capture_id, created_at, captured_at, declared_stroke, record_json, artifact_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ownerScope.owner,
          record.id,
          record.captureId,
          record.createdAtIso,
          record.capturedAtIso,
          record.declaredStroke,
          snapshot.recordJson,
          artifactJson,
        ],
      );
      assertWritableScope(ownerScope);
      await executor.execute(
        `UPDATE local_capture SET status = 'analyzed'
         WHERE owner_key = ? AND id = ?`,
        [ownerScope.owner, record.captureId],
      );
      assertWritableScope(ownerScope);
      await executor.execute('COMMIT');
    } catch (error) {
      try {
        await executor.execute('ROLLBACK');
      } catch {
        throw error;
      }
      throw error;
    }
  };
  try {
    await (db.withExclusive ? db.withExclusive(transact) : transact(db));
    assertWritableScope(ownerScope);
  } catch (error) {
    if (error instanceof Motion3DRepositoryError) throw error;
    throw new Motion3DRepositoryError('motion_3d.storage_failed', error);
  }
}

function verifiedAnalysisRow(
  row: Record<string, unknown> | undefined,
  scope: DataOwnerScope,
): Motion3DAnalysis | null {
  if (
    !row ||
    row['owner_key'] !== scope.owner ||
    typeof row['record_json'] !== 'string' ||
    typeof row['artifact_json'] !== 'string'
  ) {
    return null;
  }
  const parsed = parseMotion3DAnalysis(
    row['record_json'],
    row['artifact_json'],
  );
  if (!parsed.ok) return null;
  const { record } = parsed.value;
  if (
    row['id'] !== record.id ||
    row['capture_id'] !== record.captureId ||
    row['created_at'] !== record.createdAtIso ||
    row['captured_at'] !== record.capturedAtIso ||
    row['declared_stroke'] !== record.declaredStroke ||
    row['linked_capture_id'] !== record.captureId ||
    row['linked_captured_at'] !== record.capturedAtIso
  ) {
    return null;
  }
  return parsed.value;
}

async function readAnalysis(
  db: LocalDb,
  column: 'id' | 'capture_id',
  id: string,
  scope: DataOwnerScope,
): Promise<Motion3DAnalysis | null> {
  if (scope.owner === SIGNED_OUT_DATA_OWNER || !ID_PATTERN.test(id)) {
    return null;
  }
  try {
    const { rows } = await db.execute(
      `${ANALYSIS_SELECT}
       WHERE motion.owner_key = ? AND motion.${column} = ?
       ORDER BY motion.created_at DESC, motion.id DESC LIMIT 1`,
      [scope.owner, id],
    );
    if (!isDataOwnerScopeCurrent(scope)) return null;
    const analysis = verifiedAnalysisRow(rows[0], scope);
    if (
      analysis &&
      (column === 'id' ? analysis.record.id : analysis.record.captureId) !== id
    ) {
      return null;
    }
    return analysis;
  } catch (error) {
    if (!isDataOwnerScopeCurrent(scope)) return null;
    throw new Motion3DRepositoryError('motion_3d.storage_failed', error);
  }
}

export async function loadMotion3DAnalysis(
  db: LocalDb,
  id: string,
): Promise<Motion3DAnalysis | null> {
  const scope = captureDataOwnerScope();
  const analysis = await readAnalysis(db, 'id', id, scope);
  return isDataOwnerScopeCurrent(scope) ? analysis : null;
}

export async function getLatestMotion3DAnalysisId(
  db: LocalDb,
  captureId: string,
): Promise<string | null> {
  const scope = captureDataOwnerScope();
  const analysis = await readAnalysis(db, 'capture_id', captureId, scope);
  return isDataOwnerScopeCurrent(scope) ? (analysis?.record.id ?? null) : null;
}

export async function listMotion3DHistory(
  db: LocalDb,
  limit = 50,
): Promise<Motion3DHistoryEntry[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Motion3DRepositoryError('motion_3d.invalid_limit');
  }
  const scope = captureDataOwnerScope();
  if (scope.owner === SIGNED_OUT_DATA_OWNER) return [];
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await db.execute(
      `SELECT motion.owner_key, motion.id, motion.capture_id,
         motion.captured_at, motion.declared_stroke
       FROM local_motion_analysis AS motion
       INNER JOIN local_capture AS capture
         ON capture.owner_key = motion.owner_key AND capture.id = motion.capture_id
           AND capture.captured_at = motion.captured_at
       WHERE motion.owner_key = ?
       ORDER BY motion.captured_at DESC, motion.created_at DESC, motion.id DESC
       LIMIT ?`,
      [scope.owner, limit],
    ));
  } catch (error) {
    if (!isDataOwnerScopeCurrent(scope)) return [];
    throw new Motion3DRepositoryError('motion_3d.storage_failed', error);
  }
  if (!isDataOwnerScopeCurrent(scope)) return [];
  const entries: Motion3DHistoryEntry[] = [];
  for (const row of rows) {
    const id = row['id'];
    const captureId = row['capture_id'];
    const capturedAtIso = row['captured_at'];
    const declaredStroke = row['declared_stroke'];
    if (
      row['owner_key'] !== scope.owner ||
      typeof id !== 'string' ||
      !ID_PATTERN.test(id) ||
      typeof captureId !== 'string' ||
      !ID_PATTERN.test(captureId) ||
      typeof capturedAtIso !== 'string' ||
      !Number.isFinite(Date.parse(capturedAtIso)) ||
      (declaredStroke !== null &&
        (typeof declaredStroke !== 'string' ||
          !(SHOT_TYPES as readonly string[]).includes(declaredStroke)))
    ) {
      continue;
    }
    entries.push({
      id,
      captureId,
      capturedAtIso,
      declaredStroke: declaredStroke as ShotTypeSlug | null,
    });
  }
  return entries;
}
