import type { PendingFulfilment } from './pendingFulfilment';
import type {
  BillingErrorState,
  BillingFulfilmentVerdict,
  CanonicalAccessState,
  CanonicalBillingState,
} from './types';

/** Apple's account-level subscription management surface. */
export const APP_STORE_SUBSCRIPTIONS_URL =
  'https://apps.apple.com/account/subscriptions';

/**
 * Membership as the SERVER last stated it. Every kind is derived from the
 * canonical access snapshot, the last `/v1/billing/sync` verdict and the
 * durable pending-fulfilment journal — never from local StoreKit/RevenueCat
 * state, and never with a price.
 *
 * - `unverified`: the server has not answered yet (fail closed).
 * - `pending`:    a completed store purchase/restore the server has not
 *                 confirmed, or a server verdict of `pending`.
 * - `hold`:       it is unknown whether a purchase is waiting (journal
 *                 unreadable, or a pending record with the server unreachable).
 * - `fulfilled`:  server-verified premium, with the horizon it stated.
 * - `grace`:      the server still grants access past the horizon it last
 *                 verified (renewal not yet confirmed).
 * - `expired`:    a bound expired/refunded disposition, or a verified horizon
 *                 that has passed with access no longer premium.
 * - `free`:       server-verified non-member with the free-rating ledger.
 */
export type MembershipStateKind =
  | 'unverified'
  | 'pending'
  | 'hold'
  | 'fulfilled'
  | 'grace'
  | 'expired'
  | 'free';

export type MembershipFulfilmentStatus =
  'unchecked' | 'clear' | 'pending' | 'unavailable';

export type MembershipReconciliationStatus =
  'unchecked' | 'checking' | 'verified' | 'unavailable';

export interface MembershipStateInput {
  access: CanonicalAccessState | null;
  billing: CanonicalBillingState | null;
  pendingFulfilment: PendingFulfilment | null;
  fulfilmentStatus: MembershipFulfilmentStatus;
  reconciliationStatus: MembershipReconciliationStatus;
  /** Last server disposition bound to this device's own pending record. */
  fulfilmentVerdict: BillingFulfilmentVerdict | null;
  error: BillingErrorState | null;
  nowMs: number;
}

export interface MembershipState {
  kind: MembershipStateKind;
  /** Short row value (Settings). */
  label: string;
  /** Upper-case eyebrow (Paywall). */
  eyebrow: string;
  /** Headline (Paywall). */
  title: string;
  /** One or two sentences of server-derived explanation. */
  detail: string;
  /** ISO end of the access period the server last verified, when it stated one. */
  horizon: string | null;
  /** App Store subscription management is relevant to this state. */
  manageSubscription: boolean;
  /** A new store purchase may be offered (never while pending or on hold). */
  purchaseAllowed: boolean;
}

export function formatMembershipDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function verifiedHorizon(billing: CanonicalBillingState | null): string | null {
  if (!billing || !billing.premium || billing.expiresAt === null) return null;
  return Number.isFinite(Date.parse(billing.expiresAt))
    ? billing.expiresAt
    : null;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

export function describeMembershipState(
  input: MembershipStateInput,
): MembershipState {
  const {
    access,
    billing,
    pendingFulfilment,
    fulfilmentStatus,
    reconciliationStatus,
    fulfilmentVerdict,
    error,
    nowMs,
  } = input;
  const premium = access?.premium === true;

  if (
    fulfilmentStatus === 'unavailable' ||
    (pendingFulfilment !== null && reconciliationStatus === 'unavailable')
  ) {
    return {
      kind: 'hold',
      label: 'Verification on hold',
      eyebrow: 'VERIFICATION ON HOLD',
      title: 'Verify your membership.',
      detail:
        'Verification is pending, not another purchase. Our server can’t confirm it right now — nothing more will be charged. Retry verification before any store request.',
      horizon: null,
      manageSubscription: false,
      purchaseAllowed: false,
    };
  }

  if (
    pendingFulfilment !== null ||
    fulfilmentStatus === 'pending' ||
    fulfilmentVerdict?.outcome === 'pending' ||
    error?.code === 'billing.backend_verification_pending'
  ) {
    return {
      kind: 'pending',
      label: premium
        ? 'Pro active · verification pending'
        : 'Verification pending',
      eyebrow: 'VERIFICATION PENDING',
      title: 'Verify your membership.',
      detail:
        'Verification is pending, not another purchase. Retry with our server without opening the app store.',
      horizon: null,
      manageSubscription: false,
      purchaseAllowed: false,
    };
  }

  if (access === null) {
    return {
      kind: 'unverified',
      label: 'Verify access',
      eyebrow: 'MEMBERSHIP UNVERIFIED',
      title: 'Verify your access.',
      detail:
        'Membership is confirmed by our server. Nothing is shown until that check completes.',
      horizon: null,
      manageSubscription: false,
      purchaseAllowed: false,
    };
  }

  const horizon = verifiedHorizon(billing);

  if (premium) {
    if (horizon !== null && Date.parse(horizon) <= nowMs) {
      const date = formatMembershipDate(horizon);
      return {
        kind: 'grace',
        label: 'Pro active · renewal unconfirmed',
        eyebrow: 'MEMBERSHIP ACTIVE · RENEWAL UNCONFIRMED',
        title: 'Your full court is still open.',
        detail: `Our server still reports your membership active past ${date}, the last end date it verified. Renewal is confirmed by the App Store — open Manage subscription if billing needs attention.`,
        horizon,
        manageSubscription: true,
        purchaseAllowed: false,
      };
    }
    const date = horizon === null ? null : formatMembershipDate(horizon);
    return {
      kind: 'fulfilled',
      label: date === null ? 'Pro active' : `Pro active through ${date}`,
      eyebrow: 'MEMBERSHIP VERIFIED',
      title: 'Your full court is open.',
      detail:
        date === null
          ? 'Unlimited rating access is verified on this account.'
          : `Unlimited rating access is verified on this account through ${date}.`,
      horizon,
      manageSubscription: true,
      purchaseAllowed: false,
    };
  }

  const settled =
    fulfilmentVerdict?.outcome === 'expired' ||
    fulfilmentVerdict?.outcome === 'refunded'
      ? fulfilmentVerdict.outcome
      : error?.code === 'billing.purchase_settled'
        ? 'expired'
        : null;
  const lapsed = horizon !== null && Date.parse(horizon) <= nowMs;
  if (settled !== null || lapsed) {
    const refunded = settled === 'refunded';
    const date = lapsed ? formatMembershipDate(horizon) : null;
    return {
      kind: 'expired',
      label: refunded ? 'Purchase refunded' : 'Membership expired',
      eyebrow: refunded ? 'PURCHASE REFUNDED' : 'MEMBERSHIP EXPIRED',
      title: 'Your membership has ended.',
      detail: refunded
        ? 'The App Store confirmed this purchase was refunded. A new membership can start from store-verified pricing.'
        : `Your verified membership ended${date === null ? '' : ` on ${date}`}. A new membership can start from store-verified pricing.`,
      horizon: lapsed ? horizon : null,
      manageSubscription: false,
      purchaseAllowed: true,
    };
  }

  const available = access.freeRatings.availableToReserve;
  return {
    kind: 'free',
    label: access.canStartRating
      ? `${available} free ${plural(available, 'rating')} left`
      : 'Upgrade required',
    eyebrow: 'PLAY PAST THE FIRST TWO',
    title: 'A coach for every stroke.',
    detail:
      'Free ratings are counted by our server; membership pricing comes only from the App Store.',
    horizon: null,
    manageSubscription: false,
    purchaseAllowed: true,
  };
}
