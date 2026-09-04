/**
 * Fixtures shared by the real-SQLite data-layer suites (see realSqlite.ts):
 * a canonical owner, an analysis permit, and a scored REAL analysis whose
 * `source` survives the launch migration that deletes fixture reads.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../src/data/db';

export const CANONICAL_USER = '11111111-1111-4111-8111-111111111111';
export const PERMIT_ID = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Deterministic v4-shaped shot id. */
export function shotId(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Deterministic v4-shaped session id. */
export function sessionId(n: number): string {
  return `bbbbbbbb-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export function realAnalysis(overrides: {
  id: string;
  sessionId?: string | null;
}): ShotAnalysis {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId ?? null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-26T18:00:00.000Z',
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
      appVersion: '1.0',
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
}

/** Every outbox row of an owner, oldest first. */
export async function outboxRows(
  db: LocalDb,
  owner: string,
): Promise<
  Array<{
    id: number;
    kind: string;
    payload: string;
    attempts: number;
    lastError: string | null;
  }>
> {
  const { rows } = await db.execute(
    `SELECT id, kind, payload, attempts, last_error FROM outbox
     WHERE owner_key = ? ORDER BY id ASC`,
    [owner],
  );
  return rows.map(row => ({
    id: Number(row['id']),
    kind: String(row['kind']),
    payload: String(row['payload']),
    attempts: Number(row['attempts']),
    lastError: row['last_error'] == null ? null : String(row['last_error']),
  }));
}
