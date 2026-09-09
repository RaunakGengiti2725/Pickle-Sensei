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
 * is shown as unreadable rather than as empty.
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
  'A result was sent before the connection dropped and the answer never ' +
  'arrived. The same receipt is presented again on the next sync, so ' +
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
  const held = allocation.spendableTickets;
  const spent = allocation.consumedTickets;
  const total = held + spent;
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

  const heldCopy = proLease
    ? 'Your Pro pass results'
    : `Your ${plural(held, 'held analysis', 'held analyses')}`;

  if (lease.kind === 'expired') {
    notes.push(`${heldCopy} ${ALLOCATION_STAYS}`, NOT_PHONE_CLOCK);
    return {
      badge: hold ? 'ON HOLD' : 'EXPIRED',
      badgeTone: hold ? 'warn' : 'neutral',
      title: hold ? holdTitle : 'Offline pass expired',
      rows,
      notes,
    };
  }

  if (lease.kind === 'reconcile_required') {
    notes.push(
      RECONCILE_REASON_COPY[lease.reason],
      `${heldCopy} ${ALLOCATION_STAYS}`,
    );
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
  return {
    badge: 'READY',
    badgeTone: 'good',
    title: proLease
      ? 'Pro offline pass active'
      : `${plural(held, 'offline analysis', 'offline analyses')} ready`,
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
 */
async function refreshOfflineJourney(owner: DataOwnerContext): Promise<void> {
  latestRead += 1;
  const read = latestRead;
  publish(owner, read, { kind: 'loading' });
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
 * of the hosting screen and on every owner switch, and publishes it for
 * observing surfaces. Local-only and signed-out owners hold no server-issued
 * allocation, so they read as `null` and the card is omitted.
 */
export function useOfflineJourney(): OfflineJourneyState | null {
  const owner = useActiveOwner();
  const applicable = useOfflineJourneyApplicable(owner);

  useFocusEffect(
    useCallback(() => {
      if (!applicable) return;
      void refreshOfflineJourney(owner);
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
 * foreground while focused, and on every owner or session switch. Nothing is
 * read for local-only or signed-out owners, and the read never writes.
 */
export function useOfflineJourneyOnFocus(
  navigation: OfflineJourneyFocusSource,
): OfflineJourneyState | null {
  const owner = useActiveOwner();
  const applicable = useOfflineJourneyApplicable(owner);

  useEffect(() => {
    if (!applicable) return undefined;
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
