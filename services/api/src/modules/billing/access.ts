import type pg from "pg";
import type { AppContext } from "../../context.js";
import { many, one, withTransaction } from "../../lib/db.js";

export const LIFETIME_FREE_RATING_LIMIT = 2;
const PERMIT_LIFETIME_HOURS = 24;

export type PermitAccessSource = "free" | "premium";
export type PermitStatus = "reserved" | "consumed" | "released" | "expired";
export type PermitOutcome =
  | "scored"
  | "low_confidence"
  | "cancelled"
  | "failed"
  | "unsupported"
  | "incorrect_recognition"
  | "expired";

type Db = pg.Pool | pg.PoolClient;

interface PermitRow extends Record<string, unknown> {
  id: string;
  access_source: PermitAccessSource;
  status: PermitStatus;
  outcome: PermitOutcome | null;
  rating_id: string | null;
  reserved_at: Date | string;
  expires_at: Date | string;
  finalized_at: Date | string | null;
}

export interface AnalysisPermit {
  id: string;
  accessSource: PermitAccessSource;
  status: PermitStatus;
  outcome: PermitOutcome | null;
  ratingId: string | null;
  reservedAt: string;
  expiresAt: string;
  finalizedAt: string | null;
}

export interface AccessState {
  premium: boolean;
  entitlements: string[];
  freeRatings: {
    limit: typeof LIFETIME_FREE_RATING_LIMIT;
    used: number;
    reserved: number;
    remaining: number;
    availableToReserve: number;
  };
  canStartRating: boolean;
  paywallRequired: boolean;
}

export class AccessServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPermit(row: PermitRow): AnalysisPermit {
  return {
    id: row.id,
    accessSource: row.access_source,
    status: row.status,
    outcome: row.outcome,
    ratingId: row.rating_id,
    reservedAt: iso(row.reserved_at),
    expiresAt: iso(row.expires_at),
    finalizedAt: row.finalized_at ? iso(row.finalized_at) : null,
  };
}

async function ensureAccessAccount(db: Db, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO analysis_access_account (user_id)
     VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
}

async function lockAccessAccount(
  db: Db,
  userId: string,
): Promise<{ free_successful_ratings: number }> {
  await ensureAccessAccount(db, userId);
  const account = await one<{ free_successful_ratings: number }>(
    db,
    `SELECT free_successful_ratings
     FROM analysis_access_account WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  if (!account) throw new Error("analysis access account disappeared while locked");
  return account;
}

/**
 * Serialize a shot write with every other permit mutation for this user.
 * Callers must hold this lock before locking a permit row. Keeping one lock
 * order (access account -> permit) prevents a direct permit-finalize request
 * from deadlocking an offline shot replay.
 */
export async function lockRatingAccessForAtomicWrite(db: Db, userId: string): Promise<void> {
  await lockAccessAccount(db, userId);
}

async function expireReservations(db: Db, userId: string): Promise<void> {
  await db.query(
    `UPDATE analysis_permit
     SET status = 'expired', outcome = 'expired', finalized_at = now(), updated_at = now()
     WHERE user_id = $1 AND status = 'reserved' AND expires_at <= now()`,
    [userId],
  );
}

async function activeEntitlements(db: Db, userId: string): Promise<string[]> {
  const rows = await many<{ feature_key: string }>(
    db,
    `SELECT feature_key FROM entitlement
     WHERE user_id = $1 AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
     ORDER BY feature_key`,
    [userId],
  );
  return rows.map((row) => row.feature_key);
}

async function readAccessStateFromDb(db: Db, userId: string): Promise<AccessState> {
  await ensureAccessAccount(db, userId);
  await expireReservations(db, userId);
  // Keep these sequential: pg.PoolClient does not support concurrent queries,
  // and this helper is also used from inside locked transactions.
  const account = await one<{ free_successful_ratings: number }>(
    db,
    "SELECT free_successful_ratings FROM analysis_access_account WHERE user_id = $1",
    [userId],
  );
  const reservation = await one<{ count: string }>(
    db,
    `SELECT count(*)::text AS count FROM analysis_permit
     WHERE user_id = $1 AND access_source = 'free' AND status = 'reserved' AND expires_at > now()`,
    [userId],
  );
  const entitlements = await activeEntitlements(db, userId);
  const used = account?.free_successful_ratings ?? 0;
  const reserved = Number(reservation?.count ?? 0);
  const remaining = Math.max(0, LIFETIME_FREE_RATING_LIMIT - used);
  const availableToReserve = Math.max(0, remaining - reserved);
  const premium = entitlements.includes("premium");
  const canStartRating = premium || availableToReserve > 0;
  return {
    premium,
    entitlements,
    freeRatings: {
      limit: LIFETIME_FREE_RATING_LIMIT,
      used,
      reserved,
      remaining,
      availableToReserve,
    },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

export async function readAccessState(context: AppContext, userId: string): Promise<AccessState> {
  return readAccessStateFromDb(context.pool!, userId);
}

export async function reserveAnalysisPermit(
  context: AppContext,
  userId: string,
  idempotencyKey: string,
): Promise<{ permit: AnalysisPermit; access: AccessState }> {
  return withTransaction(context.pool!, async (tx) => {
    const account = await lockAccessAccount(tx, userId);
    await expireReservations(tx, userId);

    const existing = await one<PermitRow>(
      tx,
      `SELECT id, access_source, status, outcome, rating_id, reserved_at, expires_at, finalized_at
       FROM analysis_permit WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    if (existing) {
      return { permit: toPermit(existing), access: await readAccessStateFromDb(tx, userId) };
    }

    const entitlements = await activeEntitlements(tx, userId);
    const premium = entitlements.includes("premium");
    let accessSource: PermitAccessSource = "premium";
    if (!premium) {
      const active = await one<{ count: string }>(
        tx,
        `SELECT count(*)::text AS count FROM analysis_permit
         WHERE user_id = $1 AND access_source = 'free' AND status = 'reserved' AND expires_at > now()`,
        [userId],
      );
      if (
        account.free_successful_ratings + Number(active?.count ?? 0) >=
        LIFETIME_FREE_RATING_LIMIT
      ) {
        throw new AccessServiceError(
          402,
          "access.paywall_required",
          "Both lifetime free ratings have been used or reserved. Membership is required for another rating.",
        );
      }
      accessSource = "free";
    }

    const row = await one<PermitRow>(
      tx,
      `INSERT INTO analysis_permit
         (user_id, idempotency_key, access_source, expires_at)
       VALUES ($1, $2, $3, now() + ($4 * interval '1 hour'))
       RETURNING id, access_source, status, outcome, rating_id, reserved_at, expires_at, finalized_at`,
      [userId, idempotencyKey, accessSource, PERMIT_LIFETIME_HOURS],
    );
    if (!row) throw new Error("analysis permit insert returned no row");
    return { permit: toPermit(row), access: await readAccessStateFromDb(tx, userId) };
  });
}

export async function finalizeAnalysisPermitWithDb(
  db: Db,
  userId: string,
  permitId: string,
  outcome: Exclude<PermitOutcome, "expired">,
  ratingId: string | null,
): Promise<AnalysisPermit> {
  const account = await lockAccessAccount(db, userId);
  const row = await one<PermitRow>(
    db,
    `SELECT id, access_source, status, outcome, rating_id, reserved_at, expires_at, finalized_at
     FROM analysis_permit WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [permitId, userId],
  );
  if (!row) {
    throw new AccessServiceError(404, "access.permit_not_found", "Analysis permit not found.");
  }

  if (outcome === "scored") {
    if (!ratingId) {
      throw new AccessServiceError(
        400,
        "access.rating_id_required",
        "A successful rating requires its real rating ID.",
      );
    }
    const boundShot = await one<{ id: string }>(
      db,
      `SELECT id FROM shot
       WHERE id = $1 AND user_id = $2 AND analysis_permit_id = $3
       FOR UPDATE`,
      [ratingId, userId, permitId],
    );
    if (!boundShot) {
      throw new AccessServiceError(
        409,
        "access.rating_not_bound",
        "A successful permit can only be finalized with its atomically persisted shot.",
      );
    }
  }

  if (row.status !== "reserved") {
    if (row.outcome === outcome && row.rating_id === ratingId) return toPermit(row);
    throw new AccessServiceError(
      409,
      "access.permit_already_finalized",
      `Analysis permit was already finalized as ${row.outcome ?? row.status}.`,
    );
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    const expired = await one<PermitRow>(
      db,
      `UPDATE analysis_permit
       SET status = 'expired', outcome = 'expired', finalized_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING id, access_source, status, outcome, rating_id, reserved_at, expires_at, finalized_at`,
      [permitId],
    );
    if (outcome !== "scored") return toPermit(expired!);
    throw new AccessServiceError(
      409,
      "access.permit_expired",
      "Analysis permit expired before the successful rating was finalized.",
    );
  }

  if (outcome === "scored") {
    if (row.access_source === "free") {
      if (account.free_successful_ratings >= LIFETIME_FREE_RATING_LIMIT) {
        throw new AccessServiceError(
          409,
          "access.free_limit_reached",
          "The lifetime free-rating limit was already reached.",
        );
      }
      await db.query(
        `UPDATE analysis_access_account
         SET free_successful_ratings = free_successful_ratings + 1, updated_at = now()
         WHERE user_id = $1`,
        [userId],
      );
    }
  }

  const status: PermitStatus = outcome === "scored" ? "consumed" : "released";
  try {
    const finalized = await one<PermitRow>(
      db,
      `UPDATE analysis_permit
       SET status = $2, outcome = $3, rating_id = $4, finalized_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING id, access_source, status, outcome, rating_id, reserved_at, expires_at, finalized_at`,
      [permitId, status, outcome, ratingId],
    );
    return toPermit(finalized!);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new AccessServiceError(
        409,
        "access.rating_already_finalized",
        "That rating was already finalized with another permit.",
      );
    }
    throw error;
  }
}

export async function finalizeAnalysisPermit(
  context: AppContext,
  userId: string,
  permitId: string,
  outcome: Exclude<PermitOutcome, "expired">,
  ratingId: string | null,
): Promise<{ permit: AnalysisPermit; access: AccessState }> {
  const permit = await withTransaction(context.pool!, (tx) =>
    finalizeAnalysisPermitWithDb(tx, userId, permitId, outcome, ratingId),
  );
  return { permit, access: await readAccessState(context, userId) };
}

export async function assertUsablePermit(db: Db, userId: string, permitId: string): Promise<void> {
  const permit = await one<PermitRow>(
    db,
    `SELECT id, access_source, status, outcome, rating_id, reserved_at, expires_at, finalized_at
     FROM analysis_permit WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [permitId, userId],
  );
  if (!permit) {
    throw new AccessServiceError(404, "access.permit_not_found", "Analysis permit not found.");
  }
  if (permit.status !== "reserved") {
    throw new AccessServiceError(
      409,
      "access.permit_not_reserved",
      "Analysis permit is no longer reserved.",
    );
  }
  if (new Date(permit.expires_at).getTime() <= Date.now()) {
    await db.query(
      `UPDATE analysis_permit
       SET status = 'expired', outcome = 'expired', finalized_at = now(), updated_at = now()
       WHERE id = $1`,
      [permitId],
    );
    throw new AccessServiceError(409, "access.permit_expired", "Analysis permit expired.");
  }
}
