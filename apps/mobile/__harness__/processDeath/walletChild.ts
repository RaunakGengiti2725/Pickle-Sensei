/**
 * One "app launch" of the offline wallet path, run in a plain Node process
 * against a durable on-disk database (see register.js), for
 * `__tests__/w05WalletRecovery.test.ts`. The parent spawns it twice per kill
 * point: launch 1 dies at the configured step, launch 2 relaunches on the
 * same file and runs exactly what the app runs after a restart — hold the
 * same grant (idempotent per grant id), consume for the same operation id
 * (a replay returns the ORIGINAL receipt), then `configureSyncRuntime` +
 * `triggerOutboxSync`, which drains receipts through the wallet's write-ahead
 * journal (`src/data/offlineWallet.ts`).
 *
 * Nothing here decides recovery: the durable state observations are plain
 * SELECTs, and every state transition is made by `src/` modules.
 */
import { readFileSync } from 'node:fs';
import { establishApiSession } from '../../src/account/apiSession';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { parseIssuedOfflineGrant } from '../../src/data/api';
import { getDb, type LocalDb } from '../../src/data/db';
import {
  consumeOfflineAllocation,
  holdOfflineGrant,
} from '../../src/data/offlineCapabilities';
import {
  readOfflineWalletStatus,
  type OfflineWalletStatus,
} from '../../src/data/offlineWallet';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../../src/data/syncRuntime';
import type { TrustedTimeReading } from '../../src/data/trustedTime';
import { dieAtKillPoint, killTriggerFromEnvironment } from './killSwitch';
import { BEARER_TOKEN, OWNER_ID, REPORT_PREFIX } from './report';

/** Environment the parent hands to every wallet child launch. */
export interface WalletChildEnvironment {
  readonly PD_DB_PATH: string;
  readonly PD_FIXTURE_PATH: string;
  readonly PD_API_BASE_URL: string;
  readonly PD_LAUNCH: '1' | '2';
  readonly PD_KILL?: string;
  readonly PD_KILL_ID?: string;
}

export interface WalletFixtureFile {
  /** The `POST /v1/offline/grants` answer, as `parseIssuedOfflineGrant`
   * reads it; its `iss` must equal `PD_API_BASE_URL`. */
  readonly issued: Record<string, unknown>;
  readonly installationKeyId: string;
  /** The rated run's idempotency key: identical on both launches. */
  readonly operationId: string;
  readonly resultId: string;
  readonly fullOutputSha256: string;
}

export interface WalletGrantRow {
  readonly ownerKey: string;
  readonly grantId: string;
  readonly lifecycleSequence: number;
}

export interface WalletTicketRow {
  readonly ownerKey: string;
  readonly ticketId: string;
  readonly state: string;
  readonly receiptId: string | null;
}

export interface WalletReceiptRow {
  readonly ownerKey: string;
  readonly receiptId: string;
  readonly operationId: string;
  readonly settlement: string | null;
  readonly settledAt: string | null;
}

export interface WalletJournalRow {
  readonly ownerKey: string;
  readonly journalId: string;
  readonly state: string;
  readonly receiptIds: readonly string[];
  readonly verdictCount: number | null;
}

/** Every durable wallet table, read straight from SQLite. */
export interface WalletDurableSnapshot {
  readonly grants: readonly WalletGrantRow[];
  readonly tickets: readonly WalletTicketRow[];
  readonly receipts: readonly WalletReceiptRow[];
  readonly journal: readonly WalletJournalRow[];
}

export interface WalletConsumptionSummary {
  readonly receiptId: string;
  readonly ticketId: string | null;
  readonly replayed: boolean;
}

export interface WalletChildReport {
  readonly launch: '1' | '2';
  readonly ownerKey: string;
  /** Read after the shipping schema open, before any recovery or sync. */
  readonly asFound: WalletDurableSnapshot;
  readonly asFoundStatus: OfflineWalletStatus;
  readonly consumption: WalletConsumptionSummary;
  /** After the sync runtime drained receipts through the wallet journal. */
  readonly final: WalletDurableSnapshot;
  readonly finalStatus: OfflineWalletStatus;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the wallet child`);
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`Expected text, got ${value}`);
  return value;
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function integer(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') throw new Error(`Expected integer: ${value}`);
  return value;
}

function jsonList(value: unknown): readonly unknown[] {
  const parsed: unknown = JSON.parse(text(value));
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON list');
  return parsed;
}

function stringList(value: unknown): readonly string[] {
  return jsonList(value).map(text);
}

function listLength(value: unknown): number | null {
  return value === null || value === undefined ? null : jsonList(value).length;
}

async function rows(
  db: LocalDb,
  sql: string,
): Promise<readonly Record<string, unknown>[]> {
  return (await db.execute(sql)).rows;
}

async function snapshot(db: LocalDb): Promise<WalletDurableSnapshot> {
  const grants: WalletGrantRow[] = (
    await rows(
      db,
      'SELECT owner_key, grant_id, lifecycle_sequence FROM offline_grant ORDER BY grant_id',
    )
  ).map(row => ({
    ownerKey: text(row['owner_key']),
    grantId: text(row['grant_id']),
    lifecycleSequence: integer(row['lifecycle_sequence']),
  }));
  const tickets: WalletTicketRow[] = (
    await rows(
      db,
      'SELECT owner_key, ticket_id, state, receipt_id FROM offline_ticket ORDER BY ticket_id',
    )
  ).map(row => ({
    ownerKey: text(row['owner_key']),
    ticketId: text(row['ticket_id']),
    state: text(row['state']),
    receiptId: textOrNull(row['receipt_id']),
  }));
  const receipts: WalletReceiptRow[] = (
    await rows(
      db,
      `SELECT owner_key, receipt_id, operation_id, settlement, settled_at
       FROM offline_receipt ORDER BY queued_at, receipt_id`,
    )
  ).map(row => ({
    ownerKey: text(row['owner_key']),
    receiptId: text(row['receipt_id']),
    operationId: text(row['operation_id']),
    settlement: textOrNull(row['settlement']),
    settledAt: textOrNull(row['settled_at']),
  }));
  const journal: WalletJournalRow[] = (
    await rows(
      db,
      `SELECT owner_key, journal_id, state, receipt_ids, verdicts
       FROM offline_wallet_journal ORDER BY opened_at, rowid`,
    )
  ).map(row => ({
    ownerKey: text(row['owner_key']),
    journalId: text(row['journal_id']),
    state: text(row['state']),
    receiptIds: stringList(row['receipt_ids']),
    verdictCount: listLength(row['verdicts']),
  }));
  return { grants, tickets, receipts, journal };
}

/**
 * Routes the shipping clients' fetch to the parent's receipt service and
 * applies an `http` kill trigger: `before` dies with the request unsent,
 * `after` dies once the server has answered (body fully received) but before
 * the shipping client can observe the response — the lost-acknowledgement
 * case.
 */
function installFetch(): void {
  const trigger = killTriggerFromEnvironment();
  if (trigger === null || trigger.kind !== 'http') return;
  const realFetch = globalThis.fetch;
  let seen = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : new URL(String(input)).href;
    const armed =
      url.includes(trigger.pathIncludes) && ++seen === trigger.ordinal;
    if (armed && trigger.phase === 'before') dieAtKillPoint(`http ${url}`);
    const response = await realFetch(input, init);
    if (armed && trigger.phase === 'after') {
      await response.clone().arrayBuffer();
      dieAtKillPoint(`http response ${url}`);
    }
    return response;
  };
}

/** The device's trusted clock as the app reads it while a lease is active:
 * anchored on this process's wall clock. Only consumption evaluates the
 * lease; settlement stamps use `trustedTime.read()` inside the runtime. */
function activeReading(): TrustedTimeReading {
  const nowMs = Date.now();
  return {
    authority: 'anchored',
    continuity: 'measured',
    nowMs,
    wallClockMs: nowMs,
    rollbackDetected: false,
    storage: 'loaded',
  };
}

async function main(): Promise<void> {
  const launch = requireEnv('PD_LAUNCH');
  if (launch !== '1' && launch !== '2')
    throw new Error(`PD_LAUNCH must be 1 or 2, got ${launch}`);
  const apiBaseUrl = requireEnv('PD_API_BASE_URL');
  const fixture = JSON.parse(
    readFileSync(requireEnv('PD_FIXTURE_PATH'), 'utf8'),
  ) as WalletFixtureFile;
  const issued = parseIssuedOfflineGrant(fixture.issued);
  if (issued === null) throw new Error('The fixture grant does not parse.');

  installFetch();
  setActiveDataOwner(OWNER_ID);
  const session = {
    canonicalAppUserId: OWNER_ID,
    apiBaseUrl,
    bearerToken: BEARER_TOKEN,
    provider: 'apple' as const,
  };
  establishApiSession(session);

  const db = getDb();
  const asFound = await snapshot(db);
  const asFoundStatus = await readOfflineWalletStatus(db);
  const ownerContext = captureDataOwnerContext();

  await holdOfflineGrant(db, issued, {
    installationKeyId: fixture.installationKeyId,
    issuer: apiBaseUrl,
  });
  const consumed = await consumeOfflineAllocation(
    db,
    {
      operationId: fixture.operationId,
      resultId: fixture.resultId,
      fullOutputSha256: fixture.fullOutputSha256,
    },
    activeReading(),
  );

  configureSyncRuntime(session);
  await triggerOutboxSync();
  clearSyncRuntime();

  const final = await snapshot(db);
  const finalStatus = await readOfflineWalletStatus(db);
  const report: WalletChildReport = {
    launch,
    ownerKey: ownerContext.ownerKey,
    asFound,
    asFoundStatus,
    consumption: {
      receiptId: consumed.receipt.receiptId,
      ticketId: consumed.receipt.ticket?.ticketId ?? null,
      replayed: consumed.replayed,
    },
    final,
    finalStatus,
  };
  process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(report)}\n`);
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
