import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from './db';

/**
 * Outbox sync engine (directive §32): durable queue drained on reconnect.
 * Client-generated UUIDs + server-side idempotent upserts guarantee that
 * reconnection never duplicates records. Pure over LocalDb + fetch for tests.
 */

export interface SyncTransport {
  syncShots(shots: unknown[]): Promise<{ acceptedIds: string[] }>;
  createSession(session: unknown): Promise<void>;
  finalizeSession(id: string): Promise<void>;
}

/** Convert a persisted ShotAnalysis into the canonical sync payload (spec p. 21). */
export function toSyncPayload(analysis: ShotAnalysis): Record<string, unknown> {
  return {
    id: analysis.id,
    sessionId: analysis.sessionId,
    shotType: analysis.shotType,
    cameraView: analysis.cameraView,
    capturedAt: analysis.capturedAtIso,
    timestamps: analysis.timestamps,
    overallScore: analysis.overallScore,
    confidence: analysis.analysisConfidence,
    resultKind: analysis.resultKind,
    source: analysis.source,
    phases: analysis.phases,
    checkpoints: analysis.checkpoints.map(c => ({
      key: c.key,
      score: c.score,
      confidence: c.confidence,
      band: c.band,
      direction: c.direction,
      severity: c.severity,
      applicable: c.applicable,
    })),
    versionVector: analysis.versionVector,
  };
}

const MAX_ATTEMPTS = 8;

export async function drainOutbox(
  db: LocalDb,
  transport: SyncTransport,
): Promise<{ synced: number; failed: number; remaining: number }> {
  const { rows } = await db.execute(
    `SELECT id, kind, payload, attempts FROM outbox WHERE attempts < ? ORDER BY id ASC LIMIT 50`,
    [MAX_ATTEMPTS],
  );
  let synced = 0;
  let failed = 0;

  const shotRows = rows.filter(r => r['kind'] === 'shot.sync');
  if (shotRows.length > 0) {
    try {
      const payloads = shotRows.map(r =>
        toSyncPayload(JSON.parse(String(r['payload'])) as ShotAnalysis),
      );
      await transport.syncShots(payloads);
      for (const r of shotRows) {
        await db.execute(`DELETE FROM outbox WHERE id = ?`, [r['id']]);
        synced++;
      }
    } catch (error) {
      for (const r of shotRows) {
        await db.execute(
          `UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
          [String(error), r['id']],
        );
        failed++;
      }
    }
  }

  for (const r of rows.filter(row => row['kind'] !== 'shot.sync')) {
    try {
      const payload = JSON.parse(String(r['payload'])) as Record<
        string,
        unknown
      >;
      if (r['kind'] === 'session.create')
        await transport.createSession(payload);
      else if (r['kind'] === 'session.finalize')
        await transport.finalizeSession(String(payload['id']));
      else throw new Error(`unknown outbox kind ${String(r['kind'])}`);
      await db.execute(`DELETE FROM outbox WHERE id = ?`, [r['id']]);
      synced++;
    } catch (error) {
      await db.execute(
        `UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
        [String(error), r['id']],
      );
      failed++;
    }
  }

  const { rows: left } = await db.execute(
    `SELECT count(*) AS n FROM outbox`,
    [],
  );
  return { synced, failed, remaining: Number(left[0]?.['n'] ?? 0) };
}
