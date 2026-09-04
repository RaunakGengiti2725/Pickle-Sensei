/**
 * Seeds one data owner's complete local footprint — every owner-scoped table
 * and every owner-scoped kv namespace from `src/data/repository.ts` — with
 * sentinel strings that embed the owner, and classifies what is left in the
 * database afterwards into:
 *   - `deletedOwnerRows`   rows that still name the deleted owner (a leak)
 *   - `otherOwnerRows`     rows for a different owner (must be untouched)
 *   - `deviceRows`         device-level kv that legal.ts / AGENTS.md expect to
 *                          survive (view prefs, walkthrough, review prompt)
 *
 * Writes go through the real repository where the production entry point
 * exists (`saveSession`, `saveAnalysis`, `setKv`); the tables the app only
 * reaches through screen-specific flows are populated with the same schema
 * the app's migrations create.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../../../src/data/db';
import {
  OWNER_SCOPED_KV_NAMESPACES,
  saveAnalysis,
  saveSession,
  setKv,
} from '../../../src/data/repository';
import { setActiveDataOwner } from '../../../src/data/accountScope';
import { WALKTHROUGH_KV_KEY } from '../../../src/walkthrough/walkthroughStore';
import { WEEK_CHART_KV_KEY } from '../../../src/screens/HomeScreen';
import { REVIEW_PROMPT_KV_KEY } from '../../../src/review/appStoreReview';
import { dumpDatabase, type NodeSqliteHandle } from './nodeSqlite';

export const OWNER_SCOPED_TABLES = [
  'local_shot',
  'local_session',
  'local_capture',
  'local_analysis_record',
  'outbox',
  'sync_receipt',
] as const;

export const DEVICE_LEVEL_KV_KEYS = [
  WALKTHROUGH_KV_KEY,
  WEEK_CHART_KV_KEY,
  REVIEW_PROMPT_KV_KEY,
] as const;

/** Device-level auth markers authStore blanks (never deletes) on sign-out /
 * deletion; they carry no account material once blanked. */
export const AUTH_MARKER_KV_KEYS = [
  'auth.local-mode',
  'auth.last-provider',
  'auth.session',
] as const;

export function sentinel(owner: string, tag: string): string {
  return `SENTINEL[${owner}][${tag}]`;
}

export function analysisFor(
  owner: string,
  id: string,
  sessionId: string | null,
): ShotAnalysis {
  return {
    id,
    sessionId,
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
    guidance: sentinel(owner, 'guidance'),
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'validated-bundle-1',
      poseModelVersion: 'pose-1',
      paddleModelVersion: 'paddle-1',
      strokeDetectorVersion: 'stroke-1',
      phaseModelVersion: 'phase-1',
      scoringModelVersion: 'score-1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

export interface SeedSummary {
  owner: string;
  tables: Record<string, number>;
  kvKeys: string[];
}

/** Every owner-scoped table gets `rowsPerTable` rows; every namespace one key.
 * Leaves the active owner set to `owner`. */
export async function seedOwner(
  db: LocalDb,
  owner: string,
  seedTag: string,
  rowsPerTable = 2,
): Promise<SeedSummary> {
  setActiveDataOwner(owner);
  const tables: Record<string, number> = {};
  for (let i = 0; i < rowsPerTable; i += 1) {
    const sessionId = `${seedTag}-sess-${i}`;
    await saveSession(db, {
      id: sessionId,
      mode: 'guided',
      shotType: 'forehand_drive',
      focusCheckpoint: sentinel(owner, `focus-${i}`),
      startedAt: '2026-08-27T17:00:00.000Z',
    });
    await saveAnalysis(
      db,
      analysisFor(owner, `${seedTag}-shot-${i}`, sessionId),
      `${seedTag}-permit-${i}`,
    );
    await db.execute(
      `INSERT INTO local_capture
        (owner_key, id, uri, shot_type, captured_at, duration_ms, fps, width, height, status, payload)
       VALUES (?, ?, ?, 'forehand_drive', '2026-08-27T18:00:00.000Z', 1800, 30, 1080, 1920, 'awaiting_model', ?)`,
      [
        owner,
        `${seedTag}-capture-${i}`,
        `file:///clips/${sentinel(owner, `clip-${i}`)}.mov`,
        JSON.stringify({ note: sentinel(owner, `capture-${i}`) }),
      ],
    );
    await db.execute(
      `INSERT INTO local_analysis_record
        (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
       VALUES (?, ?, ?, '2026-08-27T18:01:00.000Z', 'engine-1', 'score-1', ?)`,
      [
        owner,
        `${seedTag}-record-${i}`,
        `${seedTag}-capture-${i}`,
        JSON.stringify({ note: sentinel(owner, `record-${i}`) }),
      ],
    );
    await db.execute(
      `INSERT OR REPLACE INTO sync_receipt (owner_key, kind, entity_id)
       VALUES (?, 'shot.sync', ?)`,
      [owner, `${seedTag}-receipt-${i}`],
    );
  }
  const kvKeys: string[] = [];
  for (const namespace of OWNER_SCOPED_KV_NAMESPACES) {
    const key = `${namespace}:${owner}`;
    await setKv(db, key, JSON.stringify({ value: sentinel(owner, namespace) }));
    kvKeys.push(key);
  }
  for (const table of OWNER_SCOPED_TABLES) {
    const { rows } = await db.execute(
      `SELECT COUNT(*) AS n FROM ${table} WHERE owner_key = ?`,
      [owner],
    );
    tables[table] = Number(rows[0]?.['n'] ?? 0);
  }
  return { owner, tables, kvKeys };
}

/** Device-level values the deletion must NOT touch (legal §7: device-only
 * data and preferences stay until the app is removed). */
export async function seedDeviceLevel(db: LocalDb): Promise<string[]> {
  await setKv(db, WALKTHROUGH_KV_KEY, 'seen');
  await setKv(db, WEEK_CHART_KV_KEY, 'reads');
  await setKv(
    db,
    REVIEW_PROMPT_KV_KEY,
    JSON.stringify({ version: 1, lastPromptedAt: '2026-08-01T00:00:00.000Z' }),
  );
  return [...DEVICE_LEVEL_KV_KEYS];
}

export interface ClassifiedRow {
  table: string;
  row: Record<string, unknown>;
}

export interface LocalSurvival {
  deletedOwnerRows: ClassifiedRow[];
  otherOwnerRows: ClassifiedRow[];
  deviceRows: ClassifiedRow[];
  unclassified: ClassifiedRow[];
  /** Any serialized cell that still contains the deleted owner's sentinel
   * or owner key, regardless of column. */
  sentinelHits: ClassifiedRow[];
  totalRows: number;
}

export function classifySurvival(
  handle: NodeSqliteHandle,
  deletedOwner: string,
  otherOwners: readonly string[],
): LocalSurvival {
  const out: LocalSurvival = {
    deletedOwnerRows: [],
    otherOwnerRows: [],
    deviceRows: [],
    unclassified: [],
    sentinelHits: [],
    totalRows: 0,
  };
  const deletedMarker = sentinel(deletedOwner, '');
  const deletedPrefix = deletedMarker.slice(0, deletedMarker.indexOf('][') + 1);
  for (const { table, rows } of dumpDatabase(handle)) {
    for (const row of rows) {
      out.totalRows += 1;
      const item = { table, row };
      const serialized = JSON.stringify(row);
      if (
        serialized.includes(deletedPrefix) ||
        serialized.includes(deletedOwner)
      ) {
        out.sentinelHits.push(item);
      }
      const ownerKey =
        typeof row['owner_key'] === 'string' ? row['owner_key'] : null;
      const kvKey =
        table === 'kv' && typeof row['key'] === 'string' ? row['key'] : null;
      if (
        ownerKey === deletedOwner ||
        (kvKey && kvKey.endsWith(`:${deletedOwner}`))
      ) {
        out.deletedOwnerRows.push(item);
      } else if (
        (ownerKey && otherOwners.includes(ownerKey)) ||
        (kvKey && otherOwners.some(o => kvKey.endsWith(`:${o}`)))
      ) {
        out.otherOwnerRows.push(item);
      } else if (
        kvKey &&
        ((DEVICE_LEVEL_KV_KEYS as readonly string[]).includes(kvKey) ||
          (AUTH_MARKER_KV_KEYS as readonly string[]).includes(kvKey))
      ) {
        out.deviceRows.push(item);
      } else {
        out.unclassified.push(item);
      }
    }
  }
  return out;
}
