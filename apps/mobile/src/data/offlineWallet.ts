/**
 * Offline wallet store: the write-ahead journal that makes receipt
 * presentation crash-safe and idempotent per receipt id.
 *
 * `offlineCapabilities.ts` owns the ledger (grants, tickets, receipts) and
 * the per-receipt settlement rules. This module owns the SUBMISSION protocol
 * around it:
 *
 *   1. `journal`   — the batch of pending receipt ids is committed as an
 *                    `in_flight` journal entry BEFORE the request leaves the
 *                    device (write-ahead);
 *   2. `present`   — exactly those receipts are submitted, keyed by their
 *                    receipt ids (never a fresh receipt, never a new
 *                    operation id);
 *   3. `apply`     — the server's verdicts are recorded on the receipts and
 *                    the journal entry is closed as `applied` in ONE
 *                    transaction, so a crash leaves either "unanswered" or
 *                    "fully recorded", never a half-applied batch.
 *
 * An `in_flight` entry that survives a relaunch is an ambiguous commitment:
 * the server may or may not have recorded the receipt. The wallet reports it
 * as a HOLD (`readOfflineWalletStatus().hold`), never refunds the ticket and
 * never re-consumes, and the next drain re-presents the SAME receipt ids —
 * the server settles by receipt id, so a replay is acknowledged, not charged
 * twice. The stale entry is then closed as `superseded` by the new
 * presentation (history is kept; nothing is deleted).
 *
 * Presentation is serialized per owner within the process so two concurrent
 * drains cannot present one receipt twice; journal rows belong to one owner
 * and are never read across accounts; unreadable journal state is the typed
 * `offline.wallet_corrupt` failure, never an empty wallet.
 */
import { OFFLINE_SIGNED_GRANT_SCHEMA_VERSION } from '@pickle/shared-types';
import { sha256Hex } from '@pickle/swing-domain';
import { originalCanonicalJson } from '../analysis/originalAnalysisSnapshot';
import { makeUuid } from '../util/uuid';
import {
  captureDataOwnerContext,
  GUEST_DATA_OWNER,
  getActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
  type DataOwnerContext,
} from './accountScope';
import type {
  OfflineGrantClient,
  OfflineReceiptSubmission,
  OfflineReceiptVerdict,
  OfflineReceiptVerdictKind,
  OfflineReceiptWireEntry,
} from './api';
import type { LocalDb } from './db';
import {
  OfflineGrantError,
  pendingOfflineReceipts,
  readHeldOfflineGrantJws,
  settleOfflineReceipt,
  type OfflineConsumptionReceipt,
  type OfflineReceiptReconciliation,
  type OfflineReceiptSettlement,
} from './offlineCapabilities';
import { readScoredShotPayload, recordShotSyncReceipt } from './repository';
import { forDataOwner, withTransaction } from './transactions';
import type { TrustedTimeReading } from './trustedTime';

/** Installed by `db.ts` beside `OFFLINE_WALLET_DDL`. One row per
 * presentation attempt; `receipt_ids` is the JSON list presented, `verdicts`
 * the JSON list the server answered (null until applied). */
export const OFFLINE_WALLET_JOURNAL_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS offline_wallet_journal (
     owner_key TEXT NOT NULL,
     journal_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     receipt_ids TEXT NOT NULL,
     state TEXT NOT NULL,
     opened_at TEXT NOT NULL,
     closed_at TEXT,
     verdicts TEXT,
     PRIMARY KEY (owner_key, journal_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_offline_wallet_journal_open
     ON offline_wallet_journal (owner_key, state, opened_at)`,
];

const JOURNAL_KIND = 'receipt_submission';

/** Upper bound on the JSON of one presentation. The server refuses a body
 * over 2,000,000 bytes whole (naming no receipt), so a queue is presented in
 * chunks under half that — the margin covers UTF-8 expansion of the JSON
 * text — and a week of ratings can never be refused forever for its size. A
 * single entry over the bound is still presented alone. */
export const OFFLINE_RECEIPT_PRESENTATION_MAX_CHARS = 1_000_000;

/** `in_flight`: committed before the request; the answer is not recorded.
 * `applied`: every verdict recorded with the receipts, atomically.
 * `superseded`: an unanswered entry closed by a later drain — the same
 * receipts were re-presented, or every receipt it named had since been
 * settled terminally (the ambiguity was resolved by the server's answer, not
 * by guessing). */
export type OfflineWalletJournalState = 'in_flight' | 'applied' | 'superseded';

export interface OfflineWalletJournalEntry {
  readonly journalId: string;
  readonly ownerId: string;
  readonly receiptIds: readonly string[];
  readonly state: OfflineWalletJournalState;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly verdicts: readonly OfflineReceiptVerdict[] | null;
}

/** `queued`: never presented. `presented_unanswered`: at least one
 * presentation is still in flight — the server's decision is unknown and the
 * receipt is a HOLD. `held`: the server answered but withheld a terminal
 * verdict; the receipt is re-presented until it is accepted or refused. */
export type OfflineWalletReceiptPhase =
  'queued' | 'presented_unanswered' | 'held';

export interface OfflineWalletPendingReceipt {
  readonly receiptId: string;
  readonly operationId: string;
  readonly settlement: OfflineReceiptSettlement | null;
  /** Journal entries (any state) that name this receipt. */
  readonly presentations: number;
  readonly phase: OfflineWalletReceiptPhase;
}

export interface OfflineWalletStatus {
  readonly pending: readonly OfflineWalletPendingReceipt[];
  /** `in_flight` journal entries found for this owner. */
  readonly unansweredPresentations: number;
  /** True while any presentation is unanswered: an ambiguous commitment the
   * wallet neither refunds nor retries under a new id. */
  readonly hold: boolean;
}

export interface OfflineWalletReconciliation extends OfflineReceiptReconciliation {
  /** Unanswered journal entries this drain superseded by re-presenting. */
  readonly recovered: number;
  /** Verdicts for receipts already settled terminally by the time the
   * answer arrived; the recorded settlement wins and is never rewritten. */
  readonly stale: number;
}

function corrupt(detail: string): OfflineGrantError {
  return new OfflineGrantError(
    'offline.wallet_corrupt',
    `Offline wallet journal state is unreadable (${detail}); reconciliation is required before offline ratings continue.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isJournalState(value: unknown): value is OfflineWalletJournalState {
  return value === 'in_flight' || value === 'applied' || value === 'superseded';
}

function isVerdictKind(value: unknown): value is OfflineReceiptVerdictKind {
  return value === 'accepted' || value === 'held' || value === 'refused';
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function parseReceiptIdList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every(isIdentifier)) return null;
  return new Set(value).size === value.length ? value : null;
}

function parseVerdictList(
  value: unknown,
  receiptIds: readonly string[],
): readonly OfflineReceiptVerdict[] | null {
  if (!Array.isArray(value) || value.length !== receiptIds.length) return null;
  const verdicts: OfflineReceiptVerdict[] = [];
  for (const [index, entry] of value.entries()) {
    if (
      !isRecord(entry) ||
      entry['receiptId'] !== receiptIds[index] ||
      !isVerdictKind(entry['verdict']) ||
      !isIdentifier(entry['code'])
    ) {
      return null;
    }
    verdicts.push({
      receiptId: receiptIds[index]!,
      verdict: entry['verdict'],
      code: entry['code'],
    });
  }
  return verdicts;
}

function parseJournalRow(
  row: Record<string, unknown>,
  ownerKey: string,
): OfflineWalletJournalEntry {
  const journalId = row['journal_id'];
  const label = `journal ${String(journalId)}`;
  if (!isIdentifier(journalId) || row['owner_key'] !== ownerKey) {
    throw corrupt(label);
  }
  if (row['kind'] !== JOURNAL_KIND) throw corrupt(`${label} kind`);
  const receiptIds = parseReceiptIdList(parseJson(row['receipt_ids']));
  if (receiptIds === null) throw corrupt(`${label} receipts`);
  const state = row['state'];
  if (!isJournalState(state)) throw corrupt(`${label} state`);
  const openedAt = row['opened_at'];
  const closedAt = row['closed_at'] ?? null;
  if (
    typeof openedAt !== 'string' ||
    (closedAt !== null && typeof closedAt !== 'string') ||
    (closedAt === null) !== (state === 'in_flight')
  ) {
    throw corrupt(`${label} timestamps`);
  }
  const rawVerdicts = row['verdicts'] ?? null;
  let verdicts: readonly OfflineReceiptVerdict[] | null = null;
  if (state === 'applied') {
    verdicts = parseVerdictList(parseJson(rawVerdicts), receiptIds);
    if (verdicts === null) throw corrupt(`${label} verdicts`);
  } else if (rawVerdicts !== null) {
    throw corrupt(`${label} verdicts`);
  }
  return {
    journalId,
    ownerId: ownerKey,
    receiptIds,
    state,
    openedAt,
    closedAt,
    verdicts,
  };
}

/** Receipts are consumed only by a signed-in owner, so a guest or signed-out
 * device has nothing to present and nothing to journal. */
function isSignedInOwner(): boolean {
  const owner = getActiveDataOwner();
  return owner !== GUEST_DATA_OWNER && owner !== SIGNED_OUT_DATA_OWNER;
}

async function loadJournal(
  db: LocalDb,
  ownerKey: string,
  state?: OfflineWalletJournalState,
): Promise<OfflineWalletJournalEntry[]> {
  const { rows } = await db.execute(
    state === undefined
      ? `SELECT * FROM offline_wallet_journal WHERE owner_key = ?
         ORDER BY opened_at ASC, rowid ASC`
      : `SELECT * FROM offline_wallet_journal WHERE owner_key = ? AND state = ?
         ORDER BY opened_at ASC, rowid ASC`,
    state === undefined ? [ownerKey] : [ownerKey, state],
  );
  return rows.map(row => parseJournalRow(row, ownerKey));
}

/** Every presentation this owner ever journalled, oldest first. */
export async function readOfflineWalletJournal(
  rawDb: LocalDb,
): Promise<OfflineWalletJournalEntry[]> {
  const context = captureDataOwnerContext();
  return loadJournal(forDataOwner(rawDb, context), context.ownerKey);
}

function pendingPhase(
  receipt: OfflineConsumptionReceipt,
  unanswered: number,
): OfflineWalletReceiptPhase {
  if (unanswered > 0) return 'presented_unanswered';
  return receipt.settlement === 'held' ? 'held' : 'queued';
}

/** What the wallet owes the server right now, and whether any of it is an
 * ambiguous commitment (a presentation without a recorded answer). Read
 * before draining so a relaunch can surface the HOLD instead of pretending
 * the receipt was never sent. */
export async function readOfflineWalletStatus(
  rawDb: LocalDb,
): Promise<OfflineWalletStatus> {
  const context = captureDataOwnerContext();
  const db = forDataOwner(rawDb, context);
  return withTransaction(db, async transaction => {
    const pending = await pendingOfflineReceipts(transaction);
    const journal = await loadJournal(transaction, context.ownerKey);
    const presentations = new Map<string, number>();
    const unanswered = new Map<string, number>();
    for (const entry of journal) {
      for (const receiptId of entry.receiptIds) {
        presentations.set(receiptId, (presentations.get(receiptId) ?? 0) + 1);
        if (entry.state === 'in_flight') {
          unanswered.set(receiptId, (unanswered.get(receiptId) ?? 0) + 1);
        }
      }
    }
    const inFlight = journal.filter(entry => entry.state === 'in_flight');
    return {
      pending: pending.map(receipt => ({
        receiptId: receipt.receiptId,
        operationId: receipt.operationId,
        settlement: receipt.settlement,
        presentations: presentations.get(receipt.receiptId) ?? 0,
        phase: pendingPhase(receipt, unanswered.get(receipt.receiptId) ?? 0),
      })),
      unansweredPresentations: inFlight.length,
      hold: inFlight.length > 0,
    };
  });
}

function submission(
  receipt: OfflineConsumptionReceipt,
): OfflineReceiptSubmission {
  const { settlement: _settlement, settledAt: _settledAt, ...body } = receipt;
  return body;
}

/** The exact output a receipt paid for, as the receipt hashed it: the shot
 * payload without any live-permit binding. Null when this device no longer
 * holds that exact payload — the server is told so rather than shown a
 * substitute. */
async function presentedOutput(
  db: LocalDb,
  context: DataOwnerContext,
  receipt: OfflineConsumptionReceipt,
): Promise<Record<string, unknown> | null> {
  const payload = await readScoredShotPayload(
    forDataOwner(db, context),
    receipt.resultId,
  );
  if (payload === null) return null;
  const { analysisPermitId: _analysisPermitId, ...output } = payload;
  return sha256Hex(originalCanonicalJson(output)) === receipt.fullOutputSha256
    ? output
    : null;
}

/** The 1.0 wire entry: the persisted receipt (flat, as every reader of the
 * pre-1.0 entry expects, and again under `receipt`), the held grant's exact
 * compact JWS (the server re-verifies the signature) and the output. */
async function wireEntry(
  db: LocalDb,
  context: DataOwnerContext,
  receipt: OfflineConsumptionReceipt,
): Promise<OfflineReceiptWireEntry> {
  const compactJws = await readHeldOfflineGrantJws(db, receipt.grantId);
  if (compactJws === null) throw corrupt(`receipt ${receipt.receiptId} grant`);
  const presented = submission(receipt);
  return {
    ...presented,
    receipt: presented,
    grant: { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws },
    output: await presentedOutput(db, context, receipt),
  };
}

interface OpenedPresentation {
  readonly journalId: string;
  readonly receipts: readonly OfflineConsumptionReceipt[];
  readonly entries: readonly OfflineReceiptWireEntry[];
  /** Pending receipts left for a later chunk of this drain. */
  readonly remaining: number;
}

interface PresentationPlan {
  /** Null when nothing is pending: nothing is journalled and nothing sent. */
  readonly opened: OpenedPresentation | null;
  /** Unanswered entries closed as superseded by this drain. */
  readonly recovered: number;
}

/** The longest prefix of `pending` whose wire entries fit the presentation
 * bound (always at least one). Entries are built inside the write-ahead
 * transaction so unreadable grant or shot state fails the drain before any
 * journal row exists — a presentation is journalled only once its exact body
 * is in hand. */
async function chunkPresentation(
  db: LocalDb,
  context: DataOwnerContext,
  pending: readonly OfflineConsumptionReceipt[],
  maxChars: number,
): Promise<{
  receipts: OfflineConsumptionReceipt[];
  entries: OfflineReceiptWireEntry[];
}> {
  const receipts: OfflineConsumptionReceipt[] = [];
  const entries: OfflineReceiptWireEntry[] = [];
  let chars = 2;
  for (const receipt of pending) {
    const entry = await wireEntry(db, context, receipt);
    const size = JSON.stringify(entry).length + 1;
    if (entries.length > 0 && chars + size > maxChars) break;
    chars += size;
    receipts.push(receipt);
    entries.push(entry);
  }
  return { receipts, entries };
}

/** Write-ahead step, one transaction: read what is pending, close every
 * unanswered entry as superseded — either the same receipts are about to be
 * re-presented, or every receipt it named has since been settled terminally
 * (the ambiguity is resolved either way) — build the exact wire entries of
 * the next chunk, and commit the new `in_flight` entry for exactly those
 * receipts. Receipts in `presented` were already presented by this drain and
 * wait for the next one. */
async function openPresentation(
  db: LocalDb,
  context: DataOwnerContext,
  reading: TrustedTimeReading,
  presented: ReadonlySet<string>,
  maxChars: number,
): Promise<PresentationPlan> {
  return withTransaction(db, async transaction => {
    const pending = (await pendingOfflineReceipts(transaction)).filter(
      receipt => !presented.has(receipt.receiptId),
    );
    const inFlight = await loadJournal(
      transaction,
      context.ownerKey,
      'in_flight',
    );
    const now = new Date(reading.wallClockMs).toISOString();
    for (const entry of inFlight) {
      const updated = await transaction.execute(
        `UPDATE offline_wallet_journal SET state = 'superseded', closed_at = ?
         WHERE owner_key = ? AND journal_id = ? AND state = 'in_flight'`,
        [now, context.ownerKey, entry.journalId],
      );
      if (updated.rowsAffected !== undefined && updated.rowsAffected !== 1) {
        throw corrupt(`journal ${entry.journalId} supersede`);
      }
    }
    if (pending.length === 0) {
      return { opened: null, recovered: inFlight.length };
    }
    const chunk = await chunkPresentation(
      transaction,
      context,
      pending,
      maxChars,
    );
    const journalId = makeUuid();
    await transaction.execute(
      `INSERT INTO offline_wallet_journal (
         owner_key, journal_id, kind, receipt_ids, state, opened_at, closed_at, verdicts
       ) VALUES (?, ?, ?, ?, 'in_flight', ?, NULL, NULL)`,
      [
        context.ownerKey,
        journalId,
        JOURNAL_KIND,
        JSON.stringify(chunk.receipts.map(receipt => receipt.receiptId)),
        now,
      ],
    );
    return {
      opened: {
        journalId,
        receipts: chunk.receipts,
        entries: chunk.entries,
        remaining: pending.length - chunk.receipts.length,
      },
      recovered: inFlight.length,
    };
  });
}

interface AppliedVerdicts {
  readonly accepted: number;
  readonly held: number;
  readonly refused: number;
  readonly stale: number;
}

/** Apply step: every verdict and the journal close in one transaction. A
 * receipt that reached a terminal settlement meanwhile keeps it (the verdict
 * is recorded in the journal as history and counted as stale). */
async function applyVerdicts(
  db: LocalDb,
  context: DataOwnerContext,
  opened: OpenedPresentation,
  verdicts: readonly OfflineReceiptVerdict[],
  reading: TrustedTimeReading,
): Promise<AppliedVerdicts> {
  const presented = opened.receipts.map(receipt => receipt.receiptId);
  if (
    verdicts.length !== presented.length ||
    verdicts.some((verdict, index) => verdict.receiptId !== presented[index])
  ) {
    throw new OfflineGrantError(
      'offline.receipt_unknown',
      'The server answered for receipts this device did not present; nothing was settled.',
    );
  }
  return withTransaction(db, async transaction => {
    const { rows } = await transaction.execute(
      `SELECT state FROM offline_wallet_journal WHERE owner_key = ? AND journal_id = ?`,
      [context.ownerKey, opened.journalId],
    );
    if (rows[0]?.['state'] !== 'in_flight') {
      throw corrupt(`journal ${opened.journalId} not in flight`);
    }
    const counts = { accepted: 0, held: 0, refused: 0, stale: 0 };
    for (const verdict of verdicts) {
      const current = await transaction.execute(
        `SELECT settled_at FROM offline_receipt WHERE owner_key = ? AND receipt_id = ?`,
        [context.ownerKey, verdict.receiptId],
      );
      const row = current.rows[0];
      if (!row) throw corrupt(`receipt ${verdict.receiptId} missing`);
      if (row['settled_at'] !== null && row['settled_at'] !== undefined) {
        counts.stale += 1;
        continue;
      }
      const settled = await settleOfflineReceipt(
        transaction,
        verdict.receiptId,
        verdict.verdict,
        reading,
      );
      // The server recorded the result the receipt carried: the local shot
      // is delivered exactly as a successful `shot.sync` marks it.
      if (verdict.verdict === 'accepted')
        await recordShotSyncReceipt(
          forDataOwner(transaction, context),
          settled.resultId,
        );
      counts[verdict.verdict] += 1;
    }
    const closed = await transaction.execute(
      `UPDATE offline_wallet_journal SET state = 'applied', closed_at = ?, verdicts = ?
       WHERE owner_key = ? AND journal_id = ? AND state = 'in_flight'`,
      [
        new Date(reading.wallClockMs).toISOString(),
        JSON.stringify(verdicts),
        context.ownerKey,
        opened.journalId,
      ],
    );
    if (closed.rowsAffected !== undefined && closed.rowsAffected !== 1) {
      throw corrupt(`journal ${opened.journalId} apply`);
    }
    return counts;
  });
}

const presentationQueues = new Map<string, Promise<unknown>>();

/** One presentation at a time per owner within this process. A drain that
 * arrives while another is in flight waits for it and then sees the updated
 * queue, so the same receipt is never in two requests at once. */
function serializedPerOwner<T>(
  ownerKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = presentationQueues.get(ownerKey) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(
    () => {},
    () => {},
  );
  presentationQueues.set(ownerKey, settled);
  void settled.then(() => {
    if (presentationQueues.get(ownerKey) === settled) {
      presentationQueues.delete(ownerKey);
    }
  });
  return result;
}

/** Present every pending receipt of the active owner through the write-ahead
 * journal, one byte-bounded chunk at a time: journal → submit (keyed by
 * receipt id) → apply atomically, then the next chunk, until every receipt
 * pending at the start has been presented once (a receipt the server held
 * stays pending and is re-presented by the NEXT drain, not this one). A lost
 * connection or an unreadable answer leaves that chunk's entry `in_flight`
 * (a HOLD) and throws; its receipts stay queued and the next drain
 * re-presents the same ids. Corrupt journal, grant or shot state fails before
 * anything is journalled or sent. */
export interface OfflineWalletReconcileOptions {
  /** Presentation bound in JSON characters; defaults to
   * `OFFLINE_RECEIPT_PRESENTATION_MAX_CHARS`. */
  readonly presentationMaxChars?: number;
}

export async function reconcileOfflineWallet(
  rawDb: LocalDb,
  client: OfflineGrantClient,
  reading: TrustedTimeReading,
  options: OfflineWalletReconcileOptions = {},
): Promise<OfflineWalletReconciliation> {
  const maxChars =
    options.presentationMaxChars ?? OFFLINE_RECEIPT_PRESENTATION_MAX_CHARS;
  const idle: OfflineWalletReconciliation = {
    submitted: 0,
    accepted: 0,
    held: 0,
    refused: 0,
    pending: 0,
    recovered: 0,
    stale: 0,
  };
  if (!isSignedInOwner()) return idle;
  const context = captureDataOwnerContext();
  const db = forDataOwner(rawDb, context);
  return serializedPerOwner(context.ownerKey, async () => {
    const totals = { submitted: 0, accepted: 0, held: 0, refused: 0, stale: 0 };
    const presented = new Set<string>();
    let recovered = 0;
    for (;;) {
      const plan = await openPresentation(
        db,
        context,
        reading,
        presented,
        maxChars,
      );
      recovered += plan.recovered;
      if (plan.opened === null) break;
      for (const receipt of plan.opened.receipts)
        presented.add(receipt.receiptId);
      const verdicts = await client.submitReceipts(plan.opened.entries);
      const applied = await applyVerdicts(
        db,
        context,
        plan.opened,
        verdicts,
        reading,
      );
      totals.submitted += plan.opened.receipts.length;
      totals.accepted += applied.accepted;
      totals.held += applied.held;
      totals.refused += applied.refused;
      totals.stale += applied.stale;
      if (plan.opened.remaining === 0) break;
    }
    return {
      ...totals,
      pending: (await pendingOfflineReceipts(db)).length,
      recovered,
    };
  });
}
