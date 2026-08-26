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

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
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
