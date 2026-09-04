import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import type { SyncTransport } from '../../src/data/sync';

export const CANONICAL_USER = '11111111-2222-4333-8444-555555555555';
export const PERMIT_ID = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

export function realAnalysis(
  overrides: Partial<ShotAnalysis> = {},
): ShotAnalysis {
  return {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    sessionId: null,
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
    ...overrides,
  };
}

export function shotId(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

/** Accepts every shot / session it sees. */
export function acceptAllTransport(): SyncTransport & {
  syncCalls: unknown[][];
  sessions: string[];
} {
  const syncCalls: unknown[][] = [];
  const sessions: string[] = [];
  return {
    syncCalls,
    sessions,
    async syncShots(shots) {
      syncCalls.push(shots);
      return {
        acceptedIds: shots.map(s => String((s as { id: unknown }).id)),
        rejected: [],
      };
    },
    async createSession(session) {
      sessions.push(String((session as { id: unknown }).id));
    },
    async finalizeSession() {},
  };
}

export async function outboxRows(
  db: LocalDb,
  owner: string,
): Promise<
  Array<{
    id: number;
    kind: string;
    attempts: number;
    last_error: string | null;
  }>
> {
  const { rows } = await db.execute(
    `SELECT id, kind, attempts, last_error FROM outbox
     WHERE owner_key = ? ORDER BY id ASC`,
    [owner],
  );
  return rows.map(r => ({
    id: Number(r['id']),
    kind: String(r['kind']),
    attempts: Number(r['attempts']),
    last_error: r['last_error'] === null ? null : String(r['last_error']),
  }));
}
