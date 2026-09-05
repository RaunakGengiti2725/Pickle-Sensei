import type pg from "pg";

/** Small typed helpers over pg. All SQL is parameterized — no interpolation. */

export async function one<T extends Record<string, unknown>>(
  pool: pg.Pool | pg.PoolClient,
  sql: string,
  params: unknown[],
): Promise<T | null> {
  const { rows } = await pool.query(sql, params);
  return (rows[0] as T | undefined) ?? null;
}

export async function many<T extends Record<string, unknown>>(
  pool: pg.Pool | pg.PoolClient,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}

/** A server-reported failure carries a SQLSTATE (or a socket code) in `code`. */
function hasErrorCode(error: unknown): boolean {
  return typeof (error as { code?: unknown }).code === "string";
}

/**
 * Runs `fn` inside BEGIN … COMMIT on one pooled client.
 *
 * A checked-out pg.Client emits 'error' on ITSELF when PostgreSQL closes the
 * connection underneath it (pg_terminate_backend, restart/failover,
 * idle_in_transaction_session_timeout, a dropped socket) — pg-pool detaches
 * its own listener for the duration of the checkout. The client is watched
 * for the whole transaction: a dead connection surfaces as the connection
 * error (unless the statement itself already reported a coded failure),
 * ROLLBACK is not attempted on it, and the client is handed back with the
 * error so the pool destroys it instead of re-idling a dead socket.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let connectionError: Error | null = null;
  const onConnectionError = (error: Error) => {
    connectionError ??= error;
  };
  client.on("error", onConnectionError);
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (connectionError === null) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // The transaction state is unknown; the client must not go back idle.
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
    }
    const connectionDied = connectionError !== null && !hasErrorCode(error);
    throw connectionDied ? connectionError : error;
  } finally {
    client.removeListener("error", onConnectionError);
    client.release(connectionError ?? releaseError);
  }
}

export async function audit(
  db: pg.Pool | pg.PoolClient,
  entry: {
    actorUserId?: string | null;
    actorService?: string;
    action: string;
    targetKind?: string;
    targetId?: string;
    requestId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, actor_service, action, target_kind, target_id, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.actorUserId ?? null,
      entry.actorService ?? "api",
      entry.action,
      entry.targetKind ?? null,
      entry.targetId ?? null,
      entry.requestId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}
