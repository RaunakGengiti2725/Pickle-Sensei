import { canonicalDataOwner } from '../data/accountScope';
import type { LocalDb } from '../data/db';
import { withTransaction } from '../data/transactions';
import { makeUuid } from '../util/uuid';
import {
  BillingError,
  parseBillingTransaction,
  type BillingTransactionEvidence,
} from './types';

export const PENDING_FULFILMENT_KV_NAMESPACE = 'billing.pending-fulfilment';
export const PENDING_FULFILMENT_MAX_LENGTH = 2_048;
export const PENDING_FULFILMENT_MAX_BACKOFF_MS = 5 * 60_000;

export interface PendingFulfilment {
  schemaVersion: 1 | 2;
  id: string;
  owner: string;
  source: 'purchase' | 'restore';
  state: 'pending';
  completedAtMs: number;
  attempts: number;
  lastAttemptAtMs: number | null;
  transaction?: BillingTransactionEvidence;
}

export interface PendingFulfilmentStorage {
  read(owner: string): Promise<PendingFulfilment | null>;
  write(record: PendingFulfilment, assertActive?: () => void): Promise<void>;
  remove(record: PendingFulfilment, assertActive?: () => void): Promise<void>;
}

export function pendingFulfilmentKeyForOwner(owner: string): string {
  return `${PENDING_FULFILMENT_KV_NAMESPACE}:${canonicalDataOwner(owner)}`;
}

function invalidRecord(): BillingError {
  return new BillingError(
    'billing.backend_verification_pending',
    'Saved membership verification could not be read. Please try again before making another purchase.',
    true,
  );
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parsePendingFulfilment(
  raw: string | null,
  owner: string,
): PendingFulfilment | null {
  if (raw === null) return null;
  if (raw.length > PENDING_FULFILMENT_MAX_LENGTH) throw invalidRecord();
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw invalidRecord();
    const record = value as Record<string, unknown>;
    if (
      (record.schemaVersion !== 1 && record.schemaVersion !== 2) ||
      typeof record.id !== 'string' ||
      canonicalDataOwner(record.id) !== record.id ||
      record.owner !== canonicalDataOwner(owner) ||
      (record.source !== 'purchase' && record.source !== 'restore') ||
      record.state !== 'pending' ||
      !validTimestamp(record.completedAtMs) ||
      typeof record.attempts !== 'number' ||
      !Number.isSafeInteger(record.attempts) ||
      record.attempts < 0 ||
      record.attempts > 31 ||
      !(
        record.lastAttemptAtMs === null ||
        validTimestamp(record.lastAttemptAtMs)
      ) ||
      (record.attempts === 0) !== (record.lastAttemptAtMs === null)
    ) {
      throw invalidRecord();
    }
    const transaction =
      record.schemaVersion === 2
        ? parseBillingTransaction(record.transaction)
        : null;
    if (
      record.schemaVersion === 2 &&
      (record.source !== 'purchase' || !transaction)
    )
      throw invalidRecord();
    return {
      schemaVersion: record.schemaVersion,
      id: record.id,
      owner: canonicalDataOwner(owner),
      source: record.source,
      state: 'pending',
      completedAtMs: record.completedAtMs,
      attempts: record.attempts,
      lastAttemptAtMs: record.lastAttemptAtMs,
      ...(transaction ? { transaction } : {}),
    };
  } catch {
    throw invalidRecord();
  }
}

export function createPendingFulfilment(
  owner: string,
  source: PendingFulfilment['source'],
  evidence?: BillingTransactionEvidence,
): PendingFulfilment {
  const transaction =
    source === 'purchase' ? parseBillingTransaction(evidence) : null;
  return {
    schemaVersion: transaction ? 2 : 1,
    id: makeUuid(),
    owner: canonicalDataOwner(owner),
    source,
    state: 'pending',
    completedAtMs: Date.now(),
    attempts: 0,
    lastAttemptAtMs: null,
    ...(transaction ? { transaction } : {}),
  };
}

export function pendingFulfilmentRetryAtMs(record: PendingFulfilment): number {
  if (record.lastAttemptAtMs === null) return 0;
  return (
    record.lastAttemptAtMs +
    Math.min(
      5_000 * 2 ** Math.min(Math.max(0, record.attempts - 1), 6),
      PENDING_FULFILMENT_MAX_BACKOFF_MS,
    )
  );
}

export function pendingFulfilmentRetryDue(
  record: PendingFulfilment,
  now = Date.now(),
): boolean {
  return (
    record.lastAttemptAtMs === null ||
    now < record.lastAttemptAtMs ||
    now >= pendingFulfilmentRetryAtMs(record)
  );
}

function serialize(record: PendingFulfilment): string {
  return JSON.stringify(
    parsePendingFulfilment(JSON.stringify(record), record.owner),
  );
}

async function readValue(db: LocalDb, owner: string): Promise<string | null> {
  const { rows } = await db.execute('SELECT value FROM kv WHERE key = ?', [
    pendingFulfilmentKeyForOwner(owner),
  ]);
  if (rows.length === 0) return null;
  const raw = rows[0]?.['value'];
  if (typeof raw !== 'string') throw invalidRecord();
  return raw;
}

export function createPendingFulfilmentStorage(
  db: () => LocalDb | Promise<LocalDb> = async () =>
    (await import('../data/db')).getDb(),
): PendingFulfilmentStorage {
  return {
    read: async owner =>
      withTransaction(await db(), async transaction =>
        parsePendingFulfilment(await readValue(transaction, owner), owner),
      ),
    write: async (record, assertActive) => {
      const value = serialize(record);
      await withTransaction(await db(), async transaction => {
        assertActive?.();
        const existing = parsePendingFulfilment(
          await readValue(transaction, record.owner),
          record.owner,
        );
        assertActive?.();
        if (
          existing &&
          (existing.id !== record.id ||
            existing.source !== record.source ||
            existing.completedAtMs !== record.completedAtMs ||
            JSON.stringify(existing.transaction) !==
              JSON.stringify(record.transaction) ||
            existing.attempts > record.attempts)
        )
          throw invalidRecord();
        await transaction.execute(
          'INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          [pendingFulfilmentKeyForOwner(record.owner), value],
        );
        assertActive?.();
      });
    },
    remove: async (record, assertActive) => {
      const value = serialize(record);
      await withTransaction(await db(), async transaction => {
        assertActive?.();
        const raw = await readValue(transaction, record.owner);
        assertActive?.();
        if (raw === null) return;
        if (raw !== value) throw invalidRecord();
        await transaction.execute(
          'DELETE FROM kv WHERE key = ? AND value = ?',
          [pendingFulfilmentKeyForOwner(record.owner), value],
        );
        assertActive?.();
      });
    },
  };
}
