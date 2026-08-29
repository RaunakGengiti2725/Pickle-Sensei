import type pg from "pg";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { audit, many, one, withTransaction } from "../../lib/db.js";

/**
 * Operational rollback (wave I, i06-rollback-drill): for the DB-backed
 * runtime selections — feature flags and model bundle rollout state — a
 * known-good snapshot can be recorded and later restored in one transaction.
 * A separate per-flag kill switch disables a single high-risk flag
 * immediately without touching the rest of the snapshot.
 *
 * Snapshots live in rollback_known_good (one row per subsystem); every
 * record/rollback/disable is audited with the affected row count.
 */

export const ROLLBACK_SUBSYSTEMS = ["feature-flags", "model-bundles"] as const;
export type RollbackSubsystem = (typeof ROLLBACK_SUBSYSTEMS)[number];

interface FlagRow extends Record<string, unknown> {
  key: string;
  description: string;
  enabled: boolean;
  rollout_percent: number;
}

interface BundleRow extends Record<string, unknown> {
  version: string;
  status: string;
  rollout_percent: number;
}

async function snapshotRows(pool: pg.Pool, subsystem: RollbackSubsystem): Promise<unknown[]> {
  if (subsystem === "feature-flags") {
    return many<FlagRow>(
      pool,
      "SELECT key, description, enabled, rollout_percent FROM feature_flag ORDER BY key",
      [],
    );
  }
  return many<BundleRow>(
    pool,
    "SELECT version, status, rollout_percent FROM model_bundle ORDER BY version",
    [],
  );
}

/** Records the CURRENT state of a subsystem as its known-good snapshot. */
export async function recordKnownGood(
  pool: pg.Pool,
  subsystem: RollbackSubsystem,
  recordedBy: string,
): Promise<{ subsystem: RollbackSubsystem; rowCount: number }> {
  const rows = await snapshotRows(pool, subsystem);
  await pool.query(
    `INSERT INTO rollback_known_good (subsystem, snapshot, recorded_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (subsystem) DO UPDATE SET
       snapshot = EXCLUDED.snapshot,
       recorded_by = EXCLUDED.recorded_by,
       recorded_at = now()`,
    [subsystem, JSON.stringify(rows), recordedBy],
  );
  return { subsystem, rowCount: rows.length };
}

/**
 * Restores a subsystem to its recorded known-good snapshot in one
 * transaction. Feature flags NOT present in the snapshot (created after it
 * was recorded) are disabled — an unreviewed flag is not known-good. Model
 * bundles not in the snapshot are retired for the same reason.
 * Returns null when no snapshot exists.
 */
export async function rollbackToKnownGood(
  pool: pg.Pool,
  subsystem: RollbackSubsystem,
): Promise<{ subsystem: RollbackSubsystem; restored: number; neutralized: number } | null> {
  const record = await one<{ snapshot: unknown[] }>(
    pool,
    "SELECT snapshot FROM rollback_known_good WHERE subsystem = $1",
    [subsystem],
  );
  if (!record) return null;
  return withTransaction(pool, async (tx) => {
    if (subsystem === "feature-flags") {
      const flags = record.snapshot as FlagRow[];
      for (const flag of flags) {
        await tx.query(
          `INSERT INTO feature_flag (key, description, enabled, rollout_percent)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (key) DO UPDATE SET
             description = EXCLUDED.description,
             enabled = EXCLUDED.enabled,
             rollout_percent = EXCLUDED.rollout_percent,
             updated_at = now()`,
          [flag.key, flag.description, flag.enabled, flag.rollout_percent],
        );
      }
      const neutralized = await tx.query(
        `UPDATE feature_flag SET enabled = false, rollout_percent = 0, updated_at = now()
         WHERE enabled = true AND NOT (key = ANY($1::text[]))`,
        [flags.map((flag) => flag.key)],
      );
      return { subsystem, restored: flags.length, neutralized: neutralized.rowCount ?? 0 };
    }
    const bundles = record.snapshot as BundleRow[];
    for (const bundle of bundles) {
      await tx.query(
        `UPDATE model_bundle SET status = $2, rollout_percent = $3 WHERE version = $1`,
        [bundle.version, bundle.status, bundle.rollout_percent],
      );
    }
    const neutralized = await tx.query(
      `UPDATE model_bundle SET status = 'retired', rollout_percent = 0
       WHERE status IN ('canary','active') AND NOT (version = ANY($1::text[]))`,
      [bundles.map((bundle) => bundle.version)],
    );
    return { subsystem, restored: bundles.length, neutralized: neutralized.rowCount ?? 0 };
  });
}

/** Kill switch for one high-risk flag: disabled and zeroed immediately. */
export async function disableFlag(
  pool: pg.Pool,
  key: string,
): Promise<{ key: string; disabled: boolean }> {
  const result = await pool.query(
    "UPDATE feature_flag SET enabled = false, rollout_percent = 0, updated_at = now() WHERE key = $1",
    [key],
  );
  return { key, disabled: (result.rowCount ?? 0) > 0 };
}

export function registerRollbackRoutes(app: FastifyInstance, context: AppContext): void {
  const parseSubsystem = (raw: string): RollbackSubsystem | null =>
    ROLLBACK_SUBSYSTEMS.find((subsystem) => subsystem === raw) ?? null;

  app.post(
    "/v1/admin/rollback/:subsystem/known-good",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const subsystem = parseSubsystem((request.params as { subsystem: string }).subsystem);
      if (!subsystem)
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.rollback_subsystem",
          `Unknown rollback subsystem. Known: ${ROLLBACK_SUBSYSTEMS.join(", ")}.`,
        );
      const recorded = await recordKnownGood(context.pool!, subsystem, request.user!.id);
      await audit(context.pool!, {
        actorUserId: request.user!.id,
        action: "rollback.known_good_recorded",
        targetKind: "rollback_known_good",
        targetId: subsystem,
        requestId: request.id,
        metadata: { rowCount: recorded.rowCount },
      });
      return recorded;
    },
  );

  app.post(
    "/v1/admin/rollback/:subsystem",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const subsystem = parseSubsystem((request.params as { subsystem: string }).subsystem);
      if (!subsystem)
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.rollback_subsystem",
          `Unknown rollback subsystem. Known: ${ROLLBACK_SUBSYSTEMS.join(", ")}.`,
        );
      const result = await rollbackToKnownGood(context.pool!, subsystem);
      if (!result)
        return sendFailure(
          reply,
          request,
          409,
          "permanent",
          "rollback.no_known_good",
          "No known-good snapshot recorded for this subsystem.",
        );
      await audit(context.pool!, {
        actorUserId: request.user!.id,
        action: "rollback.restored",
        targetKind: "rollback_known_good",
        targetId: subsystem,
        requestId: request.id,
        metadata: { restored: result.restored, neutralized: result.neutralized },
      });
      return result;
    },
  );

  app.post(
    "/v1/admin/flags/:key/disable",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const { key } = request.params as { key: string };
      const result = await disableFlag(context.pool!, key);
      if (!result.disabled)
        return sendFailure(
          reply,
          request,
          404,
          "permanent",
          "rollback.flag_not_found",
          "Feature flag not found.",
        );
      await audit(context.pool!, {
        actorUserId: request.user!.id,
        action: "rollback.flag_disabled",
        targetKind: "feature_flag",
        targetId: key,
        requestId: request.id,
      });
      return result;
    },
  );
}
