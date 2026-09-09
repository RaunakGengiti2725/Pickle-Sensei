import React, { useCallback, useSyncExternalStore } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Card, Pill } from '../design/components';
import { color, space, type } from '../design/tokens';
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

const ALLOCATION_STAYS =
  'stay allocated to this phone until they sync with the server — an ' +
  'unused pass is never taken back automatically.';

type LeaseSummary =
  | { readonly kind: 'none' }
  | { readonly kind: 'active'; readonly remainingMs: number }
  | { readonly kind: 'expired' }
  | { readonly kind: 'reconcile_required'; readonly reason: ReconcileReason };

/** One verdict for the wallet: any live grant makes the pass usable; without
 * one, an unconfirmed reading is named before an expiry (a floor reading can
 * prove an expiry, but never that time has run out on an unconfirmed pass). */
function summarizeLease(grants: readonly HeldOfflineGrantView[]): LeaseSummary {
  if (grants.length === 0) return { kind: 'none' };
  let active: { readonly kind: 'active'; readonly remainingMs: number } | null =
    null;
  let reconcile: ReconcileReason | null = null;
  for (const grant of grants) {
    const verdict = grant.execution;
    if (verdict.kind === 'active') {
      if (active === null || verdict.remainingMs > active.remainingMs)
        active = { kind: 'active', remainingMs: verdict.remainingMs };
    } else if (verdict.kind === 'reconcile_required' && reconcile === null) {
      reconcile = verdict.reason;
    }
  }
  if (active) return active;
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
  const proLease = grants.some(
    grant => grant.entitlementSource === 'verified_store',
  );
  const held = allocation.spendableTickets;
  const spent = allocation.consumedTickets;
  const total = held + spent;
  const onHold = wallet.pending.filter(
    receipt => receipt.phase !== 'queued',
  ).length;
  const waiting = wallet.pending.length - onHold;
  const hold = wallet.hold || onHold > 0;
  const lease = summarizeLease(grants);

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
  rows.push({
    label: 'Waiting to sync',
    value: syncParts.length === 0 ? 'Nothing' : syncParts.join(' · '),
  });

  const notes: string[] = [];
  if (hold) notes.push(HOLD_RULE);

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
      title: hold
        ? `${plural(onHold, 'result', 'results')} awaiting confirmation`
        : 'No offline pass on this phone',
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
      title: hold
        ? `${plural(onHold, 'result', 'results')} awaiting confirmation`
        : 'Offline pass expired',
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
      title: hold
        ? `${plural(onHold, 'result', 'results')} awaiting confirmation`
        : 'Offline pass needs an online check',
      rows,
      notes,
    };
  }

  notes.push(NOT_PHONE_CLOCK);
  if (!proLease) notes.push(SPEND_RULE);
  const title = hold
    ? `${plural(onHold, 'result', 'results')} awaiting confirmation`
    : proLease
      ? 'Pro offline pass active'
      : held === 0
        ? 'Offline pass fully spent'
        : `${plural(held, 'offline analysis', 'offline analyses')} ready`;
  return {
    badge: hold ? 'ON HOLD' : 'READY',
    badgeTone: hold ? 'warn' : 'good',
    title,
    rows,
    notes,
  };
}

/**
 * The last ledger read, bound to the owner context it was read under. The
 * ready surface of the Analyze screen renders from this publication and never
 * opens the wallet itself: that surface persists nothing and touches no local
 * storage until an attempt starts (pinned by the Analyze end-to-end suites).
 * A publication is only ever shown to the owner context it was read for.
 */
interface OfflineJourneyPublication {
  readonly owner: DataOwnerContext;
  readonly state: OfflineJourneyState;
}

let publication: OfflineJourneyPublication | null = null;
const publicationListeners = new Set<() => void>();

function subscribeToOfflineJourney(listener: () => void): () => void {
  publicationListeners.add(listener);
  return () => {
    publicationListeners.delete(listener);
  };
}

function readPublication(): OfflineJourneyPublication | null {
  return publication;
}

function publish(owner: DataOwnerContext, state: OfflineJourneyState): void {
  if (!isDataOwnerContextCurrent(owner)) return;
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
 * Reads the wallet for `owner` and publishes the result. A read that
 * finishes after the owner changed is dropped, never published under the new
 * account. An unreadable wallet is published as unreadable, not as empty.
 */
async function refreshOfflineJourney(owner: DataOwnerContext): Promise<void> {
  publish(owner, { kind: 'loading' });
  let next: OfflineJourneyState;
  try {
    const reading = await trustedTime.read();
    const db = getDb();
    const allocation = await readOfflineAllocation(db, reading);
    const wallet = await readOfflineWalletStatus(db);
    next = { kind: 'read', allocation, wallet };
  } catch {
    next = { kind: 'unavailable' };
  }
  publish(owner, next);
}

function useActiveOwner(): DataOwnerContext {
  return useSyncExternalStore(
    subscribeToDataOwner,
    getDataOwnerSnapshot,
    getDataOwnerSnapshot,
  );
}

/**
 * Reads the offline journey for the active signed-in owner on every focus
 * of the hosting screen and on every owner switch, and publishes it for
 * observing surfaces. Local-only and signed-out owners hold no server-issued
 * allocation, so they read as `null` and the card is omitted.
 */
export function useOfflineJourney(): OfflineJourneyState | null {
  const owner = useActiveOwner();
  const applicable = holdsServerIssuedAllocation(owner);
  const current = useSyncExternalStore(
    subscribeToOfflineJourney,
    readPublication,
    readPublication,
  );

  useFocusEffect(
    useCallback(() => {
      if (!applicable) return;
      void refreshOfflineJourney(owner);
    }, [applicable, owner]),
  );

  if (!applicable) return null;
  return publishedStateFor(owner, current) ?? { kind: 'loading' };
}

/**
 * Observes the published offline journey for the active owner without
 * reading the wallet. `null` until a read has been published for exactly
 * this owner context, so another account's allocation is never shown.
 */
export function usePublishedOfflineJourney(): OfflineJourneyState | null {
  const owner = useActiveOwner();
  const current = useSyncExternalStore(
    subscribeToOfflineJourney,
    readPublication,
    readPublication,
  );
  if (!holdsServerIssuedAllocation(owner)) return null;
  return publishedStateFor(owner, current);
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
