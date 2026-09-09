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
import { trustedTime, type TrustedTimeLeaseVerdict } from '../data/trustedTime';

/**
 * The offline journey as the wallet actually records it — held allocation,
 * the lease end measured by trusted time, receipts waiting to sync and any
 * HOLD for a presentation the server never answered. The card only reads the
 * ledger (`readOfflineAllocation`, `readOfflineWalletStatus`): it never
 * spends, releases, refunds or re-presents anything, and an unreadable wallet
 * is shown as unreadable rather than as empty. While it stays on screen it
 * keeps following the ledger by reading again: on every return to the
 * foreground, on a short cadence while a receipt is waiting or on hold (the
 * sync runtime's drain may answer it at any moment) or while the last read
 * failed, and on a slower cadence while a pass is held (the trusted reading
 * that decides its verdict changes with no action on this screen).
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
  'A result was sent, but this phone has no confirmed answer for it. The ' +
  'same receipt is presented again on the next sync, so nothing is charged ' +
  'twice.';

const SERVER_HOLD_RULE =
  'The server received a result and is still confirming it. The same ' +
  'receipt is presented again on the next sync, so nothing is charged ' +
  'twice.';

const UNIDENTIFIED_HOLD_RULE =
  'A result submission is on record, but it names no receipt that is still ' +
  'waiting on this phone, so its outcome cannot be read here. The next ' +
  'online sync closes it; nothing is charged twice.';

const ALLOCATION_STAYS =
  'stay allocated to this phone until they sync with the server — an ' +
  'unused pass is never taken back automatically.';

/** Tickets hosted by a generation that is not live under the current
 * reading: allocated (the ledger never reclaims them) but not spendable
 * until the server restates them. */
function strandedCopy(stranded: number): string {
  const one = stranded === 1;
  return (
    `${plural(stranded, 'held analysis', 'held analyses')} ` +
    `${one ? 'belongs' : 'belong'} to a pass that is not live on this ` +
    `phone, so ${one ? 'it needs' : 'they need'} an online check before ` +
    `${one ? 'it' : 'they'} can be rated. ${one ? 'It stays' : 'They stay'} ` +
    `allocated to this phone until ${one ? 'it syncs' : 'they sync'} with ` +
    'the server — an unused pass is never taken back automatically.'
  );
}

type LeaseSummary =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'active';
      readonly remainingMs: number;
      /** The live grant that governs is a Pro lease. */
      readonly pro: boolean;
    }
  | { readonly kind: 'expired' }
  | {
      readonly kind: 'reconcile_required';
      readonly reason: ReconcileReason;
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
 * has run out on an unconfirmed pass). Only a LIVE grant lends its
 * entitlement to the copy: a lapsed or unconfirmed Pro lease is a row the
 * ledger keeps, not a pass, and the wallet it sits in is described by the
 * tickets it holds. */
function summarizeLease(grants: readonly HeldOfflineGrantView[]): LeaseSummary {
  if (grants.length === 0) return { kind: 'none' };
  let active: {
    readonly remainingMs: number;
    readonly pro: boolean;
  } | null = null;
  let reconcile: ReconcileReason | null = null;
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
      if (reconcile === null) reconcile = 'invalid_lease';
    } else if (verdict.kind === 'reconcile_required') {
      if (reconcile === null) reconcile = verdict.reason;
    }
  }
  if (active) return { kind: 'active', ...active };
  if (reconcile !== null)
    return { kind: 'reconcile_required', reason: reconcile };
  return { kind: 'expired' };
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
  const held = allocation.spendableTickets;
  const spent = allocation.consumedTickets;
  const total = held + spent;
  // The wallet is a Pro pass when a live Pro lease governs it, or when it
  // holds nothing but Pro rows (no ticket was ever allocated here). A Pro
  // row that is not live beside allocated tickets is not what the wallet
  // is: those tickets are counted exactly as they would be without it.
  const proLease =
    lease.kind === 'active'
      ? lease.pro
      : lease.kind !== 'none' && total === 0 && grants.some(isProGrant);
  // Only a ticket hosted by a grant that is live under the current reading
  // is one the ledger would spend now; every other held ticket stays
  // allocated but is not ready.
  let ready = 0;
  for (const grant of grants) {
    if (!isProGrant(grant) && liveRemainingMs(grant.execution) !== null)
      ready += grant.remaining;
  }
  const stranded = Math.max(held - ready, 0);
  // Three receipt phases, described apart: queued (never presented),
  // presented with no answer (a HOLD the connection caused) and answered but
  // withheld by the server (a HOLD the server asked for).
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
    // Free tickets this phone holds beside a live Pro pass are a fact of the
    // wallet too: counted, never dropped behind the pass.
    if (proLease && total > 0) {
      rows.push({
        label: 'Free analyses',
        value: `${held} of ${total} unspent`,
      });
    }
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
    // With no grant row left, the receipts are the only record of what was
    // spent: one sentence per fact, agreeing in number, and none when the
    // HOLD names no receipt at all.
    const pendingCount = wallet.pending.length;
    if (!hold) {
      notes.push(
        'Offline analyses are issued while you are online and signed in; ' +
          'the ones this phone holds appear here.',
      );
    } else if (pendingCount === 1) {
      notes.push(
        'The spent analysis stays recorded until the server confirms it.',
      );
    } else if (pendingCount > 1) {
      notes.push(
        'The spent analyses stay recorded until the server confirms them.',
      );
    }
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
  // keep (the allocation row already states the count): no sentence claims
  // results that do not exist or announces a zero.
  const allocationNote =
    !proLease && held > 0
      ? `Your ${plural(held, 'held analysis', 'held analyses')} ` +
        ALLOCATION_STAYS
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
  if (!proLease && stranded > 0) notes.push(strandedCopy(stranded));
  if (!proLease && ready === 0) {
    return {
      badge: 'CONFIRM ONLINE',
      badgeTone: 'warn',
      title:
        `${plural(stranded, 'held analysis needs', 'held analyses need')} ` +
        'an online check',
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
  scheduleFollowUpRead(owner, state);
}

/**
 * A card that stays on screen keeps following the ledger. Two things change
 * what it shows with no action on this screen: the sync runtime's drain
 * answering a receipt (the HOLD or the queue resolves — on the foreground
 * transition or on its own retry timer, and it announces neither) and the
 * trusted reading changing the verdict on a held pass (an authenticated
 * response anchors the time the launch reading could only floor, a rollback
 * is detected, the lease end passes). Both are followed by READING again —
 * the card never drains, re-presents, anchors or expires anything itself:
 * while a receipt is waiting or on hold, or the last read failed, it re-reads
 * on a short cadence; while a pass is held it re-reads on a slower one, and
 * no later than a live pass's remaining time. Timers run only while a
 * surface is mounted for the owner the state was read for, and the phone's
 * own timers never end a pass: the trusted reading decides every verdict.
 */
let mountedFollowers = 0;
let followUpTimer: ReturnType<typeof setTimeout> | null = null;

/** While a receipt is waiting or on hold, or the last read failed, the
 * ledger is re-read this often: two small local reads, so a drain's answer
 * (or a wallet readable again) is on screen within seconds. */
export const PENDING_RECEIPT_READ_CADENCE_MS = 5_000;

/** While a pass is held with nothing pending, the ledger is re-read this
 * often: the trusted reading that decides the pass verdict is anchored,
 * rolled back or run out by the server and the clocks, never by this card. */
export const HELD_PASS_READ_CADENCE_MS = 15_000;

/** A read at the lease end is retried after this floor, never faster. */
const LEASE_END_READ_FLOOR_MS = 1000;

function clearFollowUpRead(): void {
  if (followUpTimer !== null) clearTimeout(followUpTimer);
  followUpTimer = null;
}

/** How long until the published state can change on its own, or null when
 * only a user action or a foreground event can change it: a wallet with
 * nothing held and nothing pending, or a read that is still in flight. */
function nextFollowUpDelayMs(state: OfflineJourneyState): number | null {
  if (state.kind === 'loading') return null;
  if (state.kind === 'unavailable') return PENDING_RECEIPT_READ_CADENCE_MS;
  if (state.wallet.hold || state.wallet.pending.length > 0)
    return PENDING_RECEIPT_READ_CADENCE_MS;
  const lease = summarizeLease(state.allocation.grants);
  if (lease.kind === 'none') return null;
  if (lease.kind === 'active') {
    return Math.min(
      HELD_PASS_READ_CADENCE_MS,
      Math.max(lease.remainingMs, LEASE_END_READ_FLOOR_MS),
    );
  }
  return HELD_PASS_READ_CADENCE_MS;
}

function scheduleFollowUpRead(
  owner: DataOwnerContext,
  state: OfflineJourneyState,
): void {
  clearFollowUpRead();
  if (mountedFollowers === 0) return;
  const delay = nextFollowUpDelayMs(state);
  if (delay === null) return;
  followUpTimer = setTimeout(() => {
    followUpTimer = null;
    if (mountedFollowers === 0 || !isDataOwnerContextCurrent(owner)) return;
    void refreshOfflineJourney(owner, 'quiet');
  }, delay);
}

/** Registers a mounted surface; the returned function unregisters it. The
 * follow-up timer stops with the last surface. */
function followLedger(): () => void {
  mountedFollowers += 1;
  return () => {
    mountedFollowers -= 1;
    if (mountedFollowers === 0) clearFollowUpRead();
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
  } catch {
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
 * on every owner switch, follows the ledger while the screen stays focused,
 * and publishes it for observing surfaces. Local-only and signed-out owners
 * hold no server-issued allocation, so they read as `null` and the card is
 * omitted.
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
 * the ledger for as long as the screen is mounted. Nothing is read for
 * local-only or signed-out owners, and the read never writes.
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
