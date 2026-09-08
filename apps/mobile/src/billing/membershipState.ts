import type { PendingFulfilment } from './pendingFulfilment';
import type {
  BillingErrorState,
  BillingFulfilmentVerdict,
  CanonicalAccessState,
  CanonicalBillingState,
} from './types';
import { plural } from '../util/plural';

/** Apple's account-level subscription management surface. */
export const APP_STORE_SUBSCRIPTIONS_URL =
  'https://apps.apple.com/account/subscriptions';

/**
 * Membership as the SERVER last stated it. Every kind is derived from the
 * canonical access snapshot, the last `/v1/billing/sync` answer and the
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
 *                 verified (renewal not yet re-verified).
 * - `expired`:    the server settled THIS device's own purchase as
 *                 expired/refunded. A lapse the server has not described
 *                 (a premium snapshot that predates a non-premium access
 *                 answer) is `free`, never `expired`.
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
  /**
   * Last server disposition bound to this device's own pending record. The
   * store drops it once the server grants premium again, so it only ever
   * describes the purchase it was bound to.
   */
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
  /**
   * App Store subscription management applies: the server verified a
   * membership WITH an end date (a subscription). Lifetime access and
   * non-members have nothing to manage there.
   */
  manageSubscription: boolean;
  /** A new store purchase may be offered (never while pending or on hold). */
  purchaseAllowed: boolean;
  /** A server re-check is the only action that can move this state on. */
  retryAllowed: boolean;
}

export function formatMembershipDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function parsedHorizon(expiresAt: string | null): string | null {
  return expiresAt !== null && Number.isFinite(Date.parse(expiresAt))
    ? expiresAt
    : null;
}

/**
 * The billing snapshot that still describes the membership once the server
 * has answered `GET /v1/me/access` WITHOUT a new billing sync. The server
 * reports `billing.premium === access.premium` and a horizon only while
 * `expires_at > now`, so a non-premium answer, a premium answer beside a
 * non-premium snapshot, and a premium answer received past the stored horizon
 * all mean the snapshot belongs to a period the server has already moved past.
 * The client then knows exactly what a cold start knows: the access answer.
 */
export function billingSnapshotAfterAccess(
  access: CanonicalAccessState,
  billing: CanonicalBillingState | null,
  receivedAtMs: number,
): CanonicalBillingState | null {
  if (billing === null || !access.premium || !billing.premium) return null;
  const horizon = parsedHorizon(billing.expiresAt);
  if (billing.expiresAt !== null && horizon === null) return null;
  return horizon === null || Date.parse(horizon) > receivedAtMs
    ? billing
    : null;
}

function freeRatingsLeft(access: CanonicalAccessState): string | null {
  const available = access.freeRatings.availableToReserve;
  return access.canStartRating
    ? `${available} free ${plural(available, 'rating')} left`
    : null;
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
      label: premium
        ? 'Pro active · verification on hold'
        : 'Verification on hold',
      eyebrow: 'VERIFICATION ON HOLD',
      title: 'Verify your membership.',
      detail:
        'Verification is pending, not another purchase. Our server can’t confirm it right now. Retry verification before opening another store request.',
      horizon: null,
      manageSubscription: false,
      purchaseAllowed: false,
      retryAllowed: true,
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
      detail: premium
        ? 'Rating access is verified on this account, but a completed store request is still awaiting our server’s confirmation. Retry verification without opening the app store.'
        : 'Verification is pending, not another purchase. Retry with our server without opening the app store.',
      horizon: null,
      manageSubscription: false,
      purchaseAllowed: false,
      retryAllowed: true,
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
      retryAllowed: true,
    };
  }

  if (premium) {
    // Only a horizon the server attached to a PREMIUM verdict describes this
    // membership; a non-premium billing answer beside premium access is an
    // older snapshot and states nothing about the current period.
    const horizon = billing?.premium ? parsedHorizon(billing.expiresAt) : null;
    if (horizon !== null && Date.parse(horizon) <= nowMs) {
      const date = formatMembershipDate(horizon);
      return {
        kind: 'grace',
        label: 'Pro active · renewal unconfirmed',
        eyebrow: 'MEMBERSHIP ACTIVE · RENEWAL UNCONFIRMED',
        title: 'Your full court is still open.',
        detail:
          reconciliationStatus === 'unavailable'
            ? `Your last verified membership period ended ${date}, and our server could not be reached to re-verify it since. Access stays as last verified. Renewals are confirmed by the App Store — open Manage subscription if billing needs attention.`
            : `Your last verified membership period ended ${date}. Our server still grants access on this account, but it has not re-verified a renewal yet. Renewals are confirmed by the App Store — open Manage subscription if billing needs attention.`,
        horizon,
        manageSubscription: true,
        purchaseAllowed: false,
        retryAllowed: false,
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
          ? 'Unlimited rating access is verified on this account. Published reviewed coaching stays tied to it.'
          : `Unlimited rating access is verified on this account through ${date}. Published reviewed coaching stays tied to it.`,
      horizon,
      manageSubscription: horizon !== null,
      purchaseAllowed: false,
      retryAllowed: false,
    };
  }

  // Only a disposition the server bound to THIS device's own purchase names
  // a lapse; a premium snapshot that merely predates the current access
  // answer states nothing about why access ended.
  const settled =
    fulfilmentVerdict?.outcome === 'expired' ||
    fulfilmentVerdict?.outcome === 'refunded'
      ? fulfilmentVerdict.outcome
      : error?.code === 'billing.purchase_settled'
        ? 'expired'
        : null;
  if (settled !== null) {
    const refunded = settled === 'refunded';
    const settledLabel = refunded ? 'Purchase refunded' : 'Membership expired';
    const left = freeRatingsLeft(access);
    return {
      kind: 'expired',
      label: left === null ? settledLabel : `${settledLabel} · ${left}`,
      eyebrow: refunded ? 'PURCHASE REFUNDED' : 'MEMBERSHIP EXPIRED',
      title: 'Your membership has ended.',
      detail: `${
        refunded
          ? 'Our server confirmed this purchase was refunded.'
          : 'Our server confirmed the membership from this purchase has ended.'
      }${left === null ? '' : ` Our server counts ${left} on this account.`} A new membership can start from store-verified pricing.`,
      horizon: null,
      manageSubscription: false,
      purchaseAllowed: true,
      retryAllowed: false,
    };
  }

  return {
    kind: 'free',
    label: freeRatingsLeft(access) ?? 'Upgrade required',
    eyebrow: 'PLAY PAST THE FIRST TWO',
    title: 'A coach for every stroke.',
    detail:
      'Free ratings are counted by our server; membership pricing comes only from the App Store.',
    horizon: null,
    manageSubscription: false,
    purchaseAllowed: true,
    retryAllowed: false,
  };
}
