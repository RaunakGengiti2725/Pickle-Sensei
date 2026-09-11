/**
 * Shared statement handling for hand-rolled outbox fakes.
 *
 * `src/data/sync.ts` drains the outbox through a small SQL vocabulary beyond
 * the plain select/delete/update the older fakes modelled: a fairness ordinal
 * (`last_attempt_order`), repair marking (`repair_reason`), bounded duplicate-
 * identity lookups and parent-session lookups. Fakes that keep rows in a plain
 * array route statements through `executeSyncSql` first and build their drain
 * result with `drainRows`, so they keep the real driver's semantics instead
 * of failing on an unknown statement — which the drain would record as a
 * permanent row failure and silently change what the suite is measuring.
 */

export interface FakeOutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
  repair_reason?: string | null;
}

const scheduled = new WeakMap<FakeOutboxRow, number>();

export function lastAttemptOrder(row: FakeOutboxRow): number {
  return scheduled.get(row) ?? 0;
}

export function drainOrder(a: FakeOutboxRow, b: FakeOutboxRow): number {
  return lastAttemptOrder(a) - lastAttemptOrder(b) || a.id - b.id;
}

/** The rows `sync.nextBatch` selects: owner's retryable, unrepaired rows in
 * drain order, at most fifty, copied. */
export function drainRows(
  outbox: readonly FakeOutboxRow[],
  params: readonly unknown[],
): Array<Record<string, unknown>> {
  return outbox
    .filter(
      row =>
        row.owner_key === String(params[0]) &&
        row.attempts < Number(params[1]) &&
        (row.repair_reason ?? null) === null,
    )
    .sort(drainOrder)
    .slice(0, 50)
    .map(row => ({ ...row, repair_reason: row.repair_reason ?? null }));
}

function payloadField(payload: string, key: string): unknown {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return undefined;
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Handles the sync statements the older fakes did not know. Returns
 * `undefined` for anything else so the caller's own handlers (and its
 * "unhandled sql" guard) still apply.
 */
export function executeSyncSql(
  outbox: readonly FakeOutboxRow[],
  sql: string,
  params: readonly unknown[],
): { rows: Array<Record<string, unknown>> } | undefined {
  const statement = sql.trim().replace(/\s+/g, ' ');
  if (statement.startsWith('SELECT COALESCE(MAX(last_attempt_order)')) {
    const owned = outbox.filter(row => row.owner_key === params[0]);
    return {
      rows: [{ ordinal: Math.max(0, ...owned.map(lastAttemptOrder)) + 1 }],
    };
  }
  if (statement.startsWith('UPDATE outbox')) {
    if (statement.includes('SET last_attempt_order = ?')) {
      const row = outbox.find(
        candidate =>
          candidate.owner_key === params[1] && candidate.id === params[2],
      );
      if (row) scheduled.set(row, Number(params[0]));
      return { rows: [] };
    }
    if (statement.includes('SET repair_reason = ?, last_error = ?')) {
      const row = outbox.find(
        candidate =>
          candidate.owner_key === params[2] && candidate.id === params[3],
      );
      if (row) {
        row.repair_reason = String(params[0]);
        row.last_error = String(params[1]);
      }
      return { rows: [] };
    }
    return undefined;
  }
  if (
    statement.startsWith('SELECT payload FROM outbox') &&
    statement.includes('LIMIT 51')
  ) {
    const key = /json_extract\(payload, '\$\.(\w+)'\)/.exec(statement)?.[1];
    if (!key) return undefined;
    return {
      rows: outbox
        .filter(
          row =>
            row.owner_key === params[0] &&
            row.kind === params[1] &&
            payloadField(row.payload, key) === params[2],
        )
        .slice(0, 51)
        .map(row => ({ payload: row.payload })),
    };
  }
  if (
    statement.startsWith('SELECT id, kind, payload') &&
    statement.includes("kind = 'session.create'") &&
    statement.includes("json_extract(payload, '$.id')")
  ) {
    return {
      rows: outbox
        .filter(
          row =>
            row.owner_key === params[0] &&
            row.kind === 'session.create' &&
            payloadField(row.payload, 'id') === params[1],
        )
        .sort((a, b) => a.id - b.id)
        .slice(0, 1)
        .map(row => ({ ...row })),
    };
  }
  // These fakes hold no local sessions; the original-owner reconstruction
  // path is covered by the SQLite integration suite.
  if (statement.startsWith('SELECT id, started_at FROM local_session'))
    return { rows: [] };
  return undefined;
}
