import React, { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  AppState,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Card, Pill } from '../design/components';
import { color, space, type } from '../design/tokens';
import { useAuthStore } from '../auth/authStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getDataOwnerSnapshot,
  isDataOwnerContextCurrent,
  subscribeToDataOwner,
  type DataOwnerContext,
} from '../data/accountScope';
import { getDb } from '../data/db';
import {
  readOfflineAllocation,
  type HeldOfflineGrantView,
  type OfflineAllocationSnapshot,
} from '../data/offlineCapabilities';
import {
  readOfflineWalletStatus,
  type OfflineWalletStatus,
} from '../data/offlineWallet';
import { withTransaction } from '../data/transactions';
import {
  evaluateLease,
  trustedTime,
  type TrustedTimeLeaseVerdict,
  type TrustedTimeReading,
} from '../data/trustedTime';

/**
 * The offline journey as the wallet actually records it — held allocation,
 * the lease end measured by trusted time, receipts waiting to sync and any
 * HOLD for a presentation the server never answered. The card only reads the
 * ledger (`readOfflineAllocation`, `readOfflineWalletStatus`): it never
 * spends, releases, refunds or re-presents anything, and an unreadable wallet
 * is shown as unreadable rather than as empty. While it stays on screen it
 * keeps following two things that change with no action on this screen: the
 * ledger (re-read on every return to the foreground and on a short cadence
 * while a receipt is waiting or on hold, since the sync runtime's drain may
 * answer it at any moment) and the trusted clock (watched while a pass is
 * held, so an anchor the server provides, a detected rollback or the lease
 * end reaches the card without the player navigating away). A read that
 * fails is retried on a bounded backoff, never parked.
 */

export const OFFLINE_ALLOCATION_CARD_TEST_ID = 'offline-allocation-card';

export type OfflineJourneyState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'read';
      readonly allocation: OfflineAllocationSnapshot;
      readonly wallet: OfflineWalletStatus;
    };

type OfflineJourneyRead = Extract<OfflineJourneyState, { kind: 'read' }>;

type ReconcileReason = Extract<
  TrustedTimeLeaseVerdict,
  { kind: 'reconcile_required' }
>['reason'];

const RECONCILE_REASON_COPY: Record<ReconcileReason, string> = {
  no_trusted_time:
    'This phone has not confirmed the time with the server yet, so the pass ' +
    'cannot be rated offline until it does.',
  storage_invalid:
    'The saved time record on this phone could not be read, so the pass ' +
    'needs an online check before it is used.',
  clock_rollback:
    'This phone’s clock moved backwards since the last confirmed time, so ' +
    'the pass needs an online check before it is used.',
  floor_only:
    'The time since this pass was issued could not be measured on this ' +
    'phone, so it needs an online check before it is used.',
  elapsed_unmeasured:
    'The time since this pass was issued could not be measured on this ' +
    'phone, so it needs an online check before it is used.',
  invalid_lease:
    'This pass carries inconsistent dates and needs an online check before ' +
    'it is used.',
  lease_ahead_of_clock:
    'This pass is dated ahead of the confirmed time and needs an online ' +
    'check before it is used.',
};

const NOT_PHONE_CLOCK =
  'The pass end is measured by time confirmed with the server, not this ' +
  'phone’s clock.';

const SPEND_RULE =
  'An analysis is only spent once a validated result is saved on this ' +
  'phone.';

const HOLD_RULE =
  'A result was sent to the server and no confirmation has been recorded on ' +
  'this phone yet. The same receipt is presented again on the next sync, so ' +
  'nothing is charged twice.';

const SERVER_HOLD_RULE =
  'The server received a result and is still confirming it. The same ' +
  'receipt is presented again on the next sync, so nothing is charged ' +
  'twice.';

const UNIDENTIFIED_HOLD_RULE =
  'A result submission is on record, but the receipt it names was never ' +
  'recorded on this phone, so its outcome cannot be read here. It needs an ' +
  'online check; this phone charges nothing for it.';

const ALLOCATION_STAYS =
  'stay allocated to this phone until they sync with the server — an ' +
  'unused pass is never taken back automatically.';

type LeaseSummary =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'active';
      readonly remainingMs: number;
      readonly pro: boolean;
    }
  | { readonly kind: 'expired'; readonly pro: boolean }
  | {
      readonly kind: 'reconcile_required';
      readonly reason: ReconcileReason;
      readonly pro: boolean;
    };

function isProGrant(grant: HeldOfflineGrantView): boolean {
  return grant.entitlementSource === 'verified_store';
}

/** A live verdict carries a measurable, positive remaining time; anything
 * else the ledger labelled active is inconsistent and is treated as a pass
 * that needs an online check, never as a live one. */
function liveRemainingMs(verdict: TrustedTimeLeaseVerdict): number | null {
  if (verdict.kind !== 'active') return null;
  const remaining = verdict.remainingMs;
  return Number.isFinite(remaining) && remaining > 0 ? remaining : null;
}

/** One verdict for the wallet, named after the grant that governs it: a live
 * Pro lease first (it covers every analysis), then the live grant with the
 * most time left; without a live grant, an unconfirmed reading is named
 * before an expiry (a floor reading can prove an expiry, but never that time
 * has run out on an unconfirmed pass). A lapsed grant never lends its
 * entitlement to the copy while another grant is live. */
function summarizeLease(grants: readonly HeldOfflineGrantView[]): LeaseSummary {
  if (grants.length === 0) return { kind: 'none' };
  let active: {
    readonly remainingMs: number;
    readonly pro: boolean;
  } | null = null;
  let reconcile: {
    readonly reason: ReconcileReason;
    readonly pro: boolean;
  } | null = null;
  let expired: { readonly pro: boolean } | null = null;
  for (const grant of grants) {
    const verdict = grant.execution;
    const pro = isProGrant(grant);
    const remainingMs = liveRemainingMs(verdict);
    if (remainingMs !== null) {
      if (
        active === null ||
        (pro && !active.pro) ||
        (pro === active.pro && remainingMs > active.remainingMs)
      )
        active = { remainingMs, pro };
    } else if (verdict.kind === 'active') {
      if (reconcile === null) reconcile = { reason: 'invalid_lease', pro };
    } else if (verdict.kind === 'reconcile_required') {
      if (reconcile === null) reconcile = { reason: verdict.reason, pro };
    } else if (expired === null || (pro && !expired.pro)) {
      expired = { pro };
    }
  }
  if (active) return { kind: 'active', ...active };
  if (reconcile !== null) return { kind: 'reconcile_required', ...reconcile };
  return { kind: 'expired', pro: expired?.pro ?? false };
}

/** Tickets the ledger would execute now: the unspent tickets of every free
 * grant whose lease is live under the current trusted reading. A ticket that
 * stays allocated in a generation whose lease has ended (never reclaimed) is
 * counted by `spendableTickets`, but not here. */
function executableTickets(grants: readonly HeldOfflineGrantView[]): number {
  let executable = 0;
  for (const grant of grants) {
    if (isProGrant(grant) || liveRemainingMs(grant.execution) === null)
      continue;
    const remaining = grant.remaining;
    if (Number.isInteger(remaining) && remaining > 0) executable += remaining;
  }
  return executable;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Whole units only, rounded down: the card never promises more time than
 * the trusted reading measured. */
export function formatLeaseRemaining(remainingMs: number): string {
  const days = Math.floor(remainingMs / DAY_MS);
  if (days >= 1) return `In ${plural(days, 'day', 'days')}`;
  const hours = Math.floor(remainingMs / HOUR_MS);
  if (hours >= 1) return `In ${plural(hours, 'hour', 'hours')}`;
  return 'In under an hour';
}

export interface OfflineJourneyPresentation {
  readonly badge: string;
  readonly badgeTone: 'neutral' | 'good' | 'warn' | 'bad';
  readonly title: string;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
  readonly notes: readonly string[];
}

/** Pure copy derivation, exported so the states can be pinned without a
 * renderer. Every sentence describes a fact the ledger recorded. */
export function presentOfflineJourney(
  state: OfflineJourneyState,
): OfflineJourneyPresentation {
  if (state.kind === 'loading') {
    return {
      badge: 'CHECKING',
      badgeTone: 'neutral',
      title: 'Checking this phone’s offline pass',
      rows: [],
      notes: [],
    };
  }
  if (state.kind === 'unavailable') {
    return {
      badge: 'UNAVAILABLE',
      badgeTone: 'warn',
      title: 'Offline pass could not be read',
      rows: [],
      notes: [
        'This phone’s offline records could not be read right now, so ' +
          'nothing is shown about them. Nothing was changed.',
      ],
    };
  }

  const { allocation, wallet } = state;
  const grants = allocation.grants;
  const lease = summarizeLease(grants);
  const proLease = lease.kind !== 'none' && lease.pro;
  // Allocation is not consumption: `held` is every unspent ticket this phone
  // holds, whatever its generation's lease says; `ready` only the ones the
  // ledger would execute now. The difference is allocated but stranded in an
  // earlier pass that has ended — it stays held, but it is never "ready".
  const held = allocation.spendableTickets;
  const spent = allocation.consumedTickets;
  const total = held + spent;
  const ready = Math.min(executableTickets(grants), held);
  const stranded = held - ready;
  // Three receipt phases, described apart: queued (never presented),
  // presented with no answer recorded (a HOLD) and answered but withheld by
  // the server (a HOLD the server asked for).
  let waiting = 0;
  let unanswered = 0;
  let serverHeld = 0;
  for (const receipt of wallet.pending) {
    if (receipt.phase === 'queued') waiting += 1;
    else if (receipt.phase === 'presented_unanswered') unanswered += 1;
    else serverHeld += 1;
  }
  const onHold = unanswered + serverHeld;
  // The journal can hold an in-flight submission that names no receipt on
  // file: still a HOLD, but one with no count to state.
  const unidentifiedHold = wallet.hold && onHold === 0;
  const hold = wallet.hold || onHold > 0;

  const rows: { label: string; value: string }[] = [];
  if (lease.kind !== 'none') {
    rows.push({
      label: 'Allocation',
      value: proLease ? 'Pro pass' : `${held} of ${total} unspent`,
    });
    rows.push({
      label: 'Pass ends',
      value:
        lease.kind === 'active'
          ? formatLeaseRemaining(lease.remainingMs)
          : lease.kind === 'expired'
            ? 'Expired'
            : 'Unconfirmed',
    });
  }
  const syncParts: string[] = [];
  if (waiting > 0)
    syncParts.push(`${plural(waiting, 'result', 'results')} waiting`);
  if (onHold > 0) syncParts.push(`${onHold} on hold`);
  if (unidentifiedHold) syncParts.push('Unreadable');
  rows.push({
    label: 'Waiting to sync',
    value: syncParts.length === 0 ? 'Nothing' : syncParts.join(' · '),
  });

  const notes: string[] = [];
  if (unanswered > 0) notes.push(HOLD_RULE);
  if (serverHeld > 0) notes.push(SERVER_HOLD_RULE);
  if (unidentifiedHold) notes.push(UNIDENTIFIED_HOLD_RULE);
  const holdTitle = unidentifiedHold
    ? 'An offline result needs an online check'
    : `${plural(onHold, 'result', 'results')} awaiting confirmation`;

  if (lease.kind === 'none') {
    notes.push(
      hold
        ? 'The spent analysis stays recorded until the server confirms it.'
        : 'Offline analyses are issued while you are online and signed in; ' +
            'the ones this phone holds appear here.',
    );
    return {
      badge: hold ? 'ON HOLD' : 'NONE HELD',
      badgeTone: hold ? 'warn' : 'neutral',
      title: hold ? holdTitle : 'No offline pass on this phone',
      rows,
      notes,
    };
  }

  // The allocation note names what this phone still holds. A Pro lease is a
  // time lease with no allocation, and with nothing held there is nothing to
  // keep (the allocation row already states the count): neither gets a
  // sentence.
  const allocationNote =
    !proLease && held > 0
      ? `Your ${plural(held, 'held analysis', 'held analyses')} ${ALLOCATION_STAYS}`
      : null;

  if (lease.kind === 'expired') {
    if (allocationNote !== null) notes.push(allocationNote);
    notes.push(NOT_PHONE_CLOCK);
    return {
      badge: hold ? 'ON HOLD' : 'EXPIRED',
      badgeTone: hold ? 'warn' : 'neutral',
      title: hold ? holdTitle : 'Offline pass expired',
      rows,
      notes,
    };
  }

  if (lease.kind === 'reconcile_required') {
    notes.push(RECONCILE_REASON_COPY[lease.reason]);
    if (allocationNote !== null) notes.push(allocationNote);
    return {
      badge: hold ? 'ON HOLD' : 'CONFIRM ONLINE',
      badgeTone: 'warn',
      title: hold ? holdTitle : 'Offline pass needs an online check',
      rows,
      notes,
    };
  }

  notes.push(NOT_PHONE_CLOCK);
  if (!proLease) notes.push(SPEND_RULE);
  if (!proLease && stranded > 0) {
    notes.push(
      stranded === 1
        ? '1 unspent analysis belongs to an earlier pass that has ended; it ' +
            'stays allocated to this phone until the server restates it — an ' +
            'unused pass is never taken back automatically.'
        : `${stranded} unspent analyses belong to an earlier pass that has ` +
            'ended; they stay allocated to this phone until the server ' +
            'restates them — an unused pass is never taken back ' +
            'automatically.',
    );
  }
  if (hold) {
    return {
      badge: 'ON HOLD',
      badgeTone: 'warn',
      title: holdTitle,
      rows,
      notes,
    };
  }
  if (!proLease && held === 0) {
    return {
      badge: 'SPENT',
      badgeTone: 'neutral',
      title: 'Offline pass fully spent',
      rows,
      notes,
    };
  }
  if (!proLease && ready === 0) {
    return {
      badge: 'CONFIRM ONLINE',
      badgeTone: 'warn',
      title:
        held === 1
          ? '1 unspent analysis needs an online check'
          : `${held} unspent analyses need an online check`,
      rows,
      notes,
    };
  }
  return {
    badge: 'READY',
    badgeTone: 'good',
    title: proLease
      ? 'Pro offline pass active'
      : `${plural(ready, 'offline analysis', 'offline analyses')} ready`,
    rows,
    notes,
  };
}

/**
 * The last ledger read, bound to the owner context it was read under and to
 * the sequence number of the read that produced it. Every surface that shows
 * the offline journey (Analyze, Settings) reads the ledger itself on mount,
 * focus, foreground and owner switch; the shared publication only lets a
 * newer read replace an older one, never the reverse. A publication is only
 * ever shown to the owner context it was read for.
 */
interface OfflineJourneyPublication {
  readonly owner: DataOwnerContext;
  readonly state: OfflineJourneyState;
}

let publication: OfflineJourneyPublication | null = null;
const publicationListeners = new Set<() => void>();
/** Monotonic read counter: a read may publish only while it is the newest. */
let latestRead = 0;

function subscribeToOfflineJourney(listener: () => void): () => void {
  publicationListeners.add(listener);
  return () => {
    publicationListeners.delete(listener);
  };
}

function readPublication(): OfflineJourneyPublication | null {
  return publication;
}

function publish(
  owner: DataOwnerContext,
  read: number,
  state: OfflineJourneyState,
): void {
  if (read !== latestRead || !isDataOwnerContextCurrent(owner)) return;
  publication = { owner, state };
  for (const listener of publicationListeners) listener();
  scheduleFollowUp(owner, read, state);
}

/**
 * A card that stays on screen keeps following what it shows. Three things
 * change it with no action on this screen, and each is followed by READING
 * again — the card never drains, re-presents, anchors or expires anything:
 *
 * - The sync runtime's drain answering a receipt (the HOLD or the queue
 *   resolves, on the foreground transition or on its own retry timer, and it
 *   announces neither): while a receipt is waiting or on hold the ledger is
 *   re-read on a short cadence.
 * - The trusted clock moving: the server anchoring time on its next
 *   authenticated response (a pass that "needs an online check" becomes
 *   executable), a rollback being detected (a READY pass stops being one) or
 *   the lease end passing. While a pass is held the trusted reading is
 *   watched on a short cadence — a cheap in-memory read, no SQL — and the
 *   ledger is re-read only when a grant's verdict would present differently.
 * - A read that failed (storage busy, for one): retried on a bounded
 *   backoff, so "could not be read right now" does not outlive "right now".
 *
 * Timers run only while a surface is mounted for the owner the state was read
 * for, and the phone's own timers never end a pass: every change goes through
 * the trusted reading and the ledger.
 */
let mountedFollowers = 0;
let followUpTimer: ReturnType<typeof setTimeout> | null = null;
/** Consecutive reads that failed since the last one that landed. */
let failedReads = 0;

/** While a receipt is waiting or on hold, the ledger is re-read this often:
 * two small local reads, so a drain's answer is on screen within seconds. */
export const PENDING_RECEIPT_READ_CADENCE_MS = 5_000;

/** While a pass is held, the trusted reading is re-evaluated this often. */
export const TRUSTED_TIME_WATCH_MS = 5_000;

/** A failed read is retried after this delay, doubling on each further
 * failure up to the cap; a read that lands resets the backoff. */
export const UNAVAILABLE_RETRY_MS = 5_000;
const UNAVAILABLE_RETRY_MAX_MS = 60_000;

function clearFollowUp(): void {
  if (followUpTimer !== null) clearTimeout(followUpTimer);
  followUpTimer = null;
}

function unavailableRetryDelayMs(): number {
  const exponent = Math.min(Math.max(failedReads - 1, 0), 30);
  return Math.min(
    UNAVAILABLE_RETRY_MS * 2 ** exponent,
    UNAVAILABLE_RETRY_MAX_MS,
  );
}

/** What a grant's verdict shows on the card: its kind, the reason it needs
 * an online check, or the rounded time left. Two verdicts with the same
 * fingerprint present the same. */
function verdictFingerprint(verdict: TrustedTimeLeaseVerdict): string {
  const remaining = liveRemainingMs(verdict);
  if (remaining !== null) return `active:${formatLeaseRemaining(remaining)}`;
  if (verdict.kind === 'reconcile_required')
    return `reconcile:${verdict.reason}`;
  return verdict.kind === 'active' ? 'reconcile:invalid_lease' : 'expired';
}

function leaseFingerprint(
  grants: readonly HeldOfflineGrantView[],
  reading: TrustedTimeReading | null,
): string {
  return grants
    .map(grant =>
      verdictFingerprint(
        reading === null
          ? grant.execution
          : evaluateLease(
              {
                issuedAtMs: grant.issuedAt * 1000,
                expiresAtMs: grant.expiresAt * 1000,
              },
              reading,
            ),
      ),
    )
    .join('|');
}

/** True while `read` is still the newest read, a surface is mounted and the
 * owner it was read for is still the active one. */
function followUpStillWanted(owner: DataOwnerContext, read: number): boolean {
  return (
    read === latestRead &&
    mountedFollowers > 0 &&
    isDataOwnerContextCurrent(owner)
  );
}

function scheduleFollowUp(
  owner: DataOwnerContext,
  read: number,
  state: OfflineJourneyState,
): void {
  clearFollowUp();
  if (mountedFollowers === 0 || state.kind === 'loading') return;
  if (state.kind === 'unavailable') {
    followUpTimer = setTimeout(() => {
      followUpTimer = null;
      if (!followUpStillWanted(owner, read)) return;
      void refreshOfflineJourney(owner, 'quiet');
    }, unavailableRetryDelayMs());
    return;
  }
  if (state.wallet.hold || state.wallet.pending.length > 0) {
    followUpTimer = setTimeout(() => {
      followUpTimer = null;
      if (!followUpStillWanted(owner, read)) return;
      void refreshOfflineJourney(owner, 'quiet');
    }, PENDING_RECEIPT_READ_CADENCE_MS);
    return;
  }
  if (state.allocation.grants.length === 0) return;
  followUpTimer = setTimeout(() => {
    followUpTimer = null;
    if (!followUpStillWanted(owner, read)) return;
    void watchTrustedTime(owner, read, state);
  }, TRUSTED_TIME_WATCH_MS);
}

/** One tick of the trusted-time watch: re-read the ledger if any held
 * grant's verdict would present differently under the current reading,
 * otherwise keep watching. A reading that cannot be taken is treated as a
 * change (the ledger read states the outcome, whatever it is). */
async function watchTrustedTime(
  owner: DataOwnerContext,
  read: number,
  state: OfflineJourneyRead,
): Promise<void> {
  let reading: TrustedTimeReading | null = null;
  try {
    reading = await trustedTime.read();
  } catch {
    reading = null;
  }
  if (!followUpStillWanted(owner, read)) return;
  const grants = state.allocation.grants;
  if (
    reading === null ||
    leaseFingerprint(grants, reading) !== leaseFingerprint(grants, null)
  ) {
    void refreshOfflineJourney(owner, 'quiet');
    return;
  }
  scheduleFollowUp(owner, read, state);
}

/** Registers a mounted surface; the returned function unregisters it. The
 * follow-up timer stops with the last surface. */
function followLedger(): () => void {
  mountedFollowers += 1;
  return () => {
    mountedFollowers -= 1;
    if (mountedFollowers === 0) clearFollowUp();
  };
}

function holdsServerIssuedAllocation(owner: DataOwnerContext): boolean {
  return (
    owner.ownerKey !== SIGNED_OUT_DATA_OWNER &&
    owner.ownerKey !== GUEST_DATA_OWNER
  );
}

function publishedStateFor(
  owner: DataOwnerContext,
  current: OfflineJourneyPublication | null,
): OfflineJourneyState | null {
  if (
    current === null ||
    current.owner.ownerKey !== owner.ownerKey ||
    current.owner.generation !== owner.generation ||
    !isDataOwnerContextCurrent(current.owner)
  )
    return null;
  return current.state;
}

/**
 * Reads the wallet for `owner` and publishes the result. The allocation and
 * the receipt journal are read inside ONE transaction so the pair can never
 * tear. A read that finishes after a newer read started, or after the owner
 * changed, is dropped — never published over the newer state or under the
 * new account. An unreadable wallet is published as unreadable, not as empty.
 * A `quiet` follow-up read keeps the last published state on screen until
 * the new one lands instead of announcing a check; it is fenced the same way.
 */
async function refreshOfflineJourney(
  owner: DataOwnerContext,
  mode: 'announce' | 'quiet' = 'announce',
): Promise<void> {
  latestRead += 1;
  const read = latestRead;
  if (mode === 'announce') publish(owner, read, { kind: 'loading' });
  let next: OfflineJourneyState;
  try {
    const reading = await trustedTime.read();
    const db = getDb();
    next = await withTransaction(db, async transaction => ({
      kind: 'read',
      allocation: await readOfflineAllocation(transaction, reading),
      wallet: await readOfflineWalletStatus(transaction),
    }));
    failedReads = 0;
  } catch {
    failedReads += 1;
    next = { kind: 'unavailable' };
  }
  publish(owner, read, next);
}

function useActiveOwner(): DataOwnerContext {
  return useSyncExternalStore(
    subscribeToDataOwner,
    getDataOwnerSnapshot,
    getDataOwnerSnapshot,
  );
}

/**
 * A server-issued allocation belongs to the signed-in synced account: the
 * active owner must be a canonical account owner AND the live auth session
 * must be that account's synced sign-in. Local-only and signed-out owners
 * hold no such allocation, and nothing is read for them.
 */
function useOfflineJourneyApplicable(owner: DataOwnerContext): boolean {
  const session = useAuthStore(s => s.session);
  return (
    holdsServerIssuedAllocation(owner) &&
    session !== null &&
    !session.localOnly &&
    session.canonicalAppUserId !== null &&
    session.canonicalAppUserId.trim().toLowerCase() === owner.ownerKey
  );
}

function useCurrentPublication(
  owner: DataOwnerContext,
  applicable: boolean,
): OfflineJourneyState | null {
  const current = useSyncExternalStore(
    subscribeToOfflineJourney,
    readPublication,
    readPublication,
  );
  if (!applicable) return null;
  return publishedStateFor(owner, current) ?? { kind: 'loading' };
}

/**
 * Reads the offline journey for the active signed-in owner on every focus
 * of the hosting screen, on every return to the foreground while focused and
 * on every owner switch, follows the ledger and the trusted clock while the
 * screen stays focused, and publishes it for observing surfaces. Local-only
 * and signed-out owners hold no server-issued allocation, so they read as
 * `null` and the card is omitted.
 */
export function useOfflineJourney(): OfflineJourneyState | null {
  const owner = useActiveOwner();
  const applicable = useOfflineJourneyApplicable(owner);

  useFocusEffect(
    useCallback(() => {
      if (!applicable) return undefined;
      const unfollow = followLedger();
      void refreshOfflineJourney(owner);
      const foreground = AppState.addEventListener('change', status => {
        if (status === 'active') void refreshOfflineJourney(owner);
      });
      return () => {
        foreground.remove();
        unfollow();
      };
    }, [applicable, owner]),
  );

  return useCurrentPublication(owner, applicable);
}

/** The navigation events a hosting screen exposes; both are optional so the
 * hook also works where the screen is rendered outside a navigator. */
export interface OfflineJourneyFocusSource {
  addListener?(event: 'focus', listener: () => void): () => void;
  isFocused?(): boolean;
}

/**
 * The same read, driven by the hosting screen's own navigation object rather
 * than `useFocusEffect`: on mount, on every focus, on every return to the
 * foreground while focused, and on every owner or session switch, following
 * the ledger and the trusted clock for as long as the screen is mounted.
 * Nothing is read for local-only or signed-out owners, and the read never
 * writes.
 */
export function useOfflineJourneyOnFocus(
  navigation: OfflineJourneyFocusSource,
): OfflineJourneyState | null {
  const owner = useActiveOwner();
  const applicable = useOfflineJourneyApplicable(owner);

  useEffect(() => {
    if (!applicable) return undefined;
    const unfollow = followLedger();
    const refresh = () => {
      void refreshOfflineJourney(owner);
    };
    refresh();
    const unsubscribeFocus = navigation.addListener?.('focus', refresh);
    const foreground = AppState.addEventListener('change', status => {
      if (status === 'active' && navigation.isFocused?.() !== false) refresh();
    });
    return () => {
      unsubscribeFocus?.();
      foreground.remove();
      unfollow();
    };
  }, [applicable, owner, navigation]);

  return useCurrentPublication(owner, applicable);
}

export function OfflineAllocationCard(props: {
  state: OfflineJourneyState;
  dark?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const view = presentOfflineJourney(props.state);
  const dark = props.dark === true;
  const ink = dark ? color.onDark : color.ink;
  const inkSoft = dark ? color.onDarkMuted : color.inkSoft;
  return (
    <Card
      tone={dark ? 'dark' : 'light'}
      testID={OFFLINE_ALLOCATION_CARD_TEST_ID}
      style={[styles.card, props.style]}
    >
      <View style={styles.header}>
        <Text style={[type.micro, { color: inkSoft }]}>OFFLINE PASS</Text>
        <View testID={`${OFFLINE_ALLOCATION_CARD_TEST_ID}-status`}>
          <Pill
            label={view.badge}
            tone={
              dark && view.badgeTone === 'neutral' ? 'dark' : view.badgeTone
            }
          />
        </View>
      </View>
      <Text style={[type.h3, { color: ink }]}>{view.title}</Text>
      {view.rows.length > 0 ? (
        <View style={styles.rows}>
          {view.rows.map(row => (
            <View key={row.label} style={styles.row}>
              <Text style={[type.caption, { color: inkSoft }]}>
                {row.label}
              </Text>
              <Text style={[type.bodyBold, styles.rowValue, { color: ink }]}>
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {view.notes.map(note => (
        <Text key={note} style={[type.caption, { color: inkSoft }]}>
          {note}
        </Text>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  rows: { gap: space.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.md,
  },
  rowValue: { textAlign: 'right', flexShrink: 1 },
});
