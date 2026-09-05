import { create } from 'zustand';
import {
  BillingError,
  type BillingAccessDependencies,
  type BillingErrorCode,
  type BillingErrorState,
  type BillingPeriod,
  type CanonicalAccessState,
  type StorePlans,
} from '../billing/types';

export type AccessLoadStatus =
  'idle' | 'loading' | 'ready' | 'unconfigured' | 'error';

export type AccessOperation = 'idle' | 'purchasing' | 'restoring' | 'syncing';

export interface AccessStoreState {
  status: AccessLoadStatus;
  operation: AccessOperation;
  plans: StorePlans | null;
  selectedPeriod: BillingPeriod;
  /** Server-authoritative. Null means fail closed. */
  canonicalAccess: CanonicalAccessState | null;
  error: BillingErrorState | null;
  initialize(): Promise<void>;
  refreshAccess(): Promise<boolean>;
  syncBilling(): Promise<boolean>;
  purchaseSelected(): Promise<boolean>;
  restorePurchases(): Promise<boolean>;
  selectPeriod(period: BillingPeriod): void;
  clearError(): void;
  reset(): void;
}

let dependencies: BillingAccessDependencies | null = null;
let configurationVersion = 0;
/**
 * Ownership slot for the single GET /v1/me/access read that is allowed to
 * land. Both readers — initialize() and refreshAccess() — claim it with a fresh
 * identity the moment their read goes on the wire, and every canonical write
 * (a later read, or a backend-verified syncBilling/purchaseSelected/
 * restorePurchases commit) takes the slot, so a response or failure requested
 * before that write can no longer replace the newer snapshot. Null means no
 * in-flight read may commit.
 */
let accessReadOwner: object | null = null;

const dataDefaults = () => ({
  status: 'idle' as AccessLoadStatus,
  operation: 'idle' as AccessOperation,
  plans: null as StorePlans | null,
  selectedPeriod: 'annual' as BillingPeriod,
  canonicalAccess: null as CanonicalAccessState | null,
  error: null as BillingErrorState | null,
});

function billingError(
  error: unknown,
  code: BillingErrorCode,
  message: string,
  retryable = true,
): BillingError {
  if (error instanceof BillingError) return error;
  return new BillingError(code, message, retryable);
}

function statusFor(error: BillingError): AccessLoadStatus {
  return error.code === 'billing.unconfigured' ||
    error.code === 'billing.backend_unconfigured'
    ? 'unconfigured'
    : 'error';
}

function missingDependenciesError(): BillingError {
  return new BillingError(
    'billing.unconfigured',
    'Billing has not been connected to this signed-in account.',
    false,
  );
}

function isCurrentConfiguration(
  clients: BillingAccessDependencies,
  version: number,
): boolean {
  return dependencies === clients && configurationVersion === version;
}

/** Called by every canonical-access write; in-flight reads become stale. */
function supersedeAccessReads(): void {
  accessReadOwner = null;
}

/** Claim the slot for a read that is being issued right now. */
function claimAccessRead(): object {
  const owner = {};
  accessReadOwner = owner;
  return owner;
}

function ownsAccessRead(
  clients: BillingAccessDependencies,
  version: number,
  owner: object,
): boolean {
  return isCurrentConfiguration(clients, version) && accessReadOwner === owner;
}

/**
 * Result of a refreshAccess() call once it has settled: true when the store
 * holds a verified snapshot (supplied by this read or by the newer write that
 * superseded it), false when it fails closed or the configuration changed.
 */
function settledWithAccess(
  clients: BillingAccessDependencies,
  version: number,
  canonicalAccess: CanonicalAccessState | null,
): boolean {
  return isCurrentConfiguration(clients, version) && canonicalAccess !== null;
}

function selectedPlan(plans: StorePlans | null, period: BillingPeriod) {
  if (!plans) return null;
  switch (period) {
    case 'annual':
      return plans.annual;
    case 'monthly':
      return plans.monthly;
    case 'lifetime':
      return plans.lifetime;
  }
}

export const selectHasPremium = (state: AccessStoreState): boolean =>
  state.canonicalAccess?.premium === true;

export const selectCanStartRating = (state: AccessStoreState): boolean =>
  state.canonicalAccess?.canStartRating === true;

export const selectPaywallRequired = (state: AccessStoreState): boolean =>
  state.canonicalAccess === null || state.canonicalAccess.paywallRequired;

export const useAccessStore = create<AccessStoreState>((set, get) => ({
  ...dataDefaults(),

  initialize: async () => {
    if (get().status === 'loading') return;
    const clients = dependencies;
    if (!clients) {
      const error = missingDependenciesError();
      set({
        ...dataDefaults(),
        status: 'unconfigured',
        error: error.toState(),
      });
      return;
    }
    const version = configurationVersion;
    set({ status: 'loading', error: null });
    let storeConfigurationError: BillingError | null = null;
    try {
      await clients.store.configure();
    } catch (cause) {
      if (!isCurrentConfiguration(clients, version)) return;
      storeConfigurationError = billingError(
        cause,
        'billing.unconfigured',
        'RevenueCat could not start in this build.',
        false,
      );
    }
    if (!isCurrentConfiguration(clients, version)) return;

    const owner = claimAccessRead();
    const [accessResult, plansResult] = await Promise.all([
      clients.backend
        .getAccess()
        .then(value => ({ value, error: null as unknown }))
        .catch(error => ({ value: null, error })),
      storeConfigurationError
        ? Promise.resolve({
            value: null,
            error: storeConfigurationError as unknown,
          })
        : clients.store
            .loadPlans()
            .then(value => ({ value, error: null as unknown }))
            .catch(error => ({ value: null, error })),
    ]);
    if (!isCurrentConfiguration(clients, version)) return;

    const plansError = plansResult.error
      ? billingError(
          plansResult.error,
          'billing.offerings_unavailable',
          'Membership pricing is unavailable from the app store right now.',
        )
      : null;
    const plans = plansResult.value;
    const selectedPeriod: BillingPeriod = plans?.annual
      ? 'annual'
      : plans?.lifetime
        ? 'lifetime'
        : plans?.monthly
          ? 'monthly'
          : 'annual';
    if (!ownsAccessRead(clients, version, owner)) {
      // A newer canonical write landed while this read was in flight: the
      // access result (or failure) is stale and must not touch the snapshot,
      // the status that write settled, or an operation still in progress.
      // The store plans are not part of that ordering and still land.
      const current = get();
      set({
        plans,
        selectedPeriod,
        ...(plansError && current.error === null
          ? { status: statusFor(plansError), error: plansError.toState() }
          : {}),
      });
      return;
    }
    supersedeAccessReads();
    const accessError = accessResult.error
      ? billingError(
          accessResult.error,
          'billing.backend_unavailable',
          'Membership verification is temporarily unavailable.',
        )
      : null;
    // Free-rating access is server-authoritative and must remain available even
    // when the store SDK or offerings are not configured. Store failure blocks
    // purchase presentation; it never erases a verified free allowance.
    const error = accessError ?? plansError;
    set({
      status: error ? statusFor(error) : 'ready',
      plans,
      selectedPeriod,
      canonicalAccess: accessResult.value,
      error: error?.toState() ?? null,
    });
  },

  refreshAccess: async () => {
    const clients = dependencies;
    if (!clients) {
      const error = missingDependenciesError();
      set({
        status: 'unconfigured',
        canonicalAccess: null,
        error: error.toState(),
      });
      return false;
    }
    const version = configurationVersion;
    const owner = claimAccessRead();
    set({ status: 'loading', error: null });
    try {
      const canonicalAccess = await clients.backend.getAccess();
      if (!ownsAccessRead(clients, version, owner)) {
        return settledWithAccess(clients, version, get().canonicalAccess);
      }
      supersedeAccessReads();
      set({ status: 'ready', canonicalAccess, error: null });
      return true;
    } catch (cause) {
      if (!ownsAccessRead(clients, version, owner)) {
        return settledWithAccess(clients, version, get().canonicalAccess);
      }
      supersedeAccessReads();
      const error = billingError(
        cause,
        'billing.backend_unavailable',
        'Membership verification is temporarily unavailable.',
      );
      set({
        status: statusFor(error),
        canonicalAccess: null,
        error: error.toState(),
      });
      return false;
    }
  },

  syncBilling: async () => {
    if (get().operation !== 'idle') return false;
    const clients = dependencies;
    if (!clients) {
      const error = missingDependenciesError();
      set({
        status: 'unconfigured',
        canonicalAccess: null,
        error: error.toState(),
      });
      return false;
    }
    const version = configurationVersion;
    set({ operation: 'syncing', error: null });
    try {
      const synced = await clients.backend.syncBilling();
      if (!isCurrentConfiguration(clients, version)) return false;
      supersedeAccessReads();
      set({
        status: 'ready',
        operation: 'idle',
        canonicalAccess: synced.access,
        error: null,
      });
      return synced.access.premium;
    } catch (cause) {
      if (!isCurrentConfiguration(clients, version)) return false;
      supersedeAccessReads();
      const source = billingError(
        cause,
        'billing.backend_unavailable',
        'Membership verification is temporarily unavailable.',
      );
      const error = new BillingError(
        'billing.backend_verification_pending',
        'Your store status could not be verified yet. Try Restore purchases.',
        true,
        source.unconfiguredReason,
      );
      set({
        status: statusFor(source),
        operation: 'idle',
        canonicalAccess: null,
        error: error.toState(),
      });
      return false;
    }
  },

  purchaseSelected: async () => {
    if (get().operation !== 'idle') return false;
    const clients = dependencies;
    if (!clients) {
      const error = missingDependenciesError();
      set({ status: 'unconfigured', error: error.toState() });
      return false;
    }
    const version = configurationVersion;
    const plan = selectedPlan(get().plans, get().selectedPeriod);
    if (!plan) {
      const error = new BillingError(
        'billing.offerings_unavailable',
        'That membership plan is unavailable from the app store.',
        true,
      );
      set({ status: 'error', error: error.toState() });
      return false;
    }
    if (!get().canonicalAccess) {
      const error = new BillingError(
        'billing.backend_unavailable',
        'Verify this account with the server before starting a purchase.',
        true,
      );
      set({ status: 'error', error: error.toState() });
      return false;
    }
    set({ operation: 'purchasing', error: null });
    try {
      // Store state is deliberately ignored for access. The authenticated
      // backend re-reads RevenueCat before this store changes canonicalAccess.
      await clients.store.purchase(plan.id);
    } catch (cause) {
      if (!isCurrentConfiguration(clients, version)) return false;
      const error = billingError(
        cause,
        'billing.purchase_failed',
        'The app store could not complete the purchase.',
      );
      set({
        operation: 'idle',
        error:
          error.code === 'billing.purchase_cancelled' ? null : error.toState(),
      });
      return false;
    }
    if (!isCurrentConfiguration(clients, version)) return false;
    try {
      const synced = await clients.backend.syncBilling();
      if (!isCurrentConfiguration(clients, version)) return false;
      supersedeAccessReads();
      if (!synced.access.premium) {
        const error = new BillingError(
          'billing.backend_verification_pending',
          'The store completed your purchase, but membership verification is still pending. Try Restore purchases.',
          true,
        );
        set({
          status: 'error',
          operation: 'idle',
          canonicalAccess: synced.access,
          error: error.toState(),
        });
        return false;
      }
      set({
        status: 'ready',
        operation: 'idle',
        canonicalAccess: synced.access,
        error: null,
      });
      return true;
    } catch {
      if (!isCurrentConfiguration(clients, version)) return false;
      supersedeAccessReads();
      const error = new BillingError(
        'billing.backend_verification_pending',
        'The store completed your purchase, but membership verification is still pending. Try Restore purchases.',
        true,
      );
      set({
        status: 'error',
        operation: 'idle',
        canonicalAccess: null,
        error: error.toState(),
      });
      return false;
    }
  },

  restorePurchases: async () => {
    if (get().operation !== 'idle') return false;
    const clients = dependencies;
    if (!clients) {
      const error = missingDependenciesError();
      set({ status: 'unconfigured', error: error.toState() });
      return false;
    }
    const version = configurationVersion;
    set({ operation: 'restoring', error: null });
    try {
      // As with purchase, a local RevenueCat entitlement never unlocks access.
      await clients.store.restore();
    } catch (cause) {
      if (!isCurrentConfiguration(clients, version)) return false;
      const error = billingError(
        cause,
        'billing.restore_failed',
        'The app store could not restore purchases.',
      );
      set({ operation: 'idle', error: error.toState() });
      return false;
    }
    if (!isCurrentConfiguration(clients, version)) return false;
    try {
      const synced = await clients.backend.syncBilling();
      if (!isCurrentConfiguration(clients, version)) return false;
      supersedeAccessReads();
      if (!synced.access.premium) {
        const error = new BillingError(
          'billing.restore_failed',
          'No active Pickle Sensei membership was found for this store account.',
          false,
        );
        set({
          status: 'ready',
          operation: 'idle',
          canonicalAccess: synced.access,
          error: error.toState(),
        });
        return false;
      }
      set({
        status: 'ready',
        operation: 'idle',
        canonicalAccess: synced.access,
        error: null,
      });
      return true;
    } catch {
      if (!isCurrentConfiguration(clients, version)) return false;
      supersedeAccessReads();
      const error = new BillingError(
        'billing.backend_verification_pending',
        'Restored purchases could not be verified yet. Please try again.',
        true,
      );
      set({
        status: 'error',
        operation: 'idle',
        canonicalAccess: null,
        error: error.toState(),
      });
      return false;
    }
  },

  selectPeriod: period => {
    if (selectedPlan(get().plans, period)) set({ selectedPeriod: period });
  },
  clearError: () => set({ error: null }),
  reset: () => {
    configurationVersion += 1;
    supersedeAccessReads();
    set(dataDefaults());
  },
}));

/**
 * Connect billing only after account bootstrap returns its canonical app UUID.
 * Passing an Apple/Google/guest subject to the RevenueCat client is rejected.
 */
export function configureAccessStore(
  nextDependencies: BillingAccessDependencies,
): void {
  dependencies = nextDependencies;
  configurationVersion += 1;
  supersedeAccessReads();
  useAccessStore.setState(dataDefaults());
}

/** Call on sign-out so the next account can never inherit in-memory access. */
export function clearAccessStoreConfiguration(): void {
  dependencies = null;
  configurationVersion += 1;
  supersedeAccessReads();
  useAccessStore.setState(dataDefaults());
}
