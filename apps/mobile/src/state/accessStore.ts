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
 * Ordering for `canonicalAccess` writes. Every backend access request takes
 * the next sequence number when it is issued; a plain read (initialize,
 * refreshAccess) may land only while no later request has committed. Reads
 * overlap freely with the mutually exclusive store operations, so a
 * Settings-focus refresh issued before a purchase can answer after the server
 * has verified the membership — its snapshot predates the verification and
 * is dropped instead of displacing the verified result. Verifications
 * (syncBilling, purchase, restore) always land: they carry the server's
 * post-mutation truth.
 */
let operationSequence = 0;
let committedOperationSequence = 0;

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

function beginOperation(): number {
  operationSequence += 1;
  return operationSequence;
}

/** False once an operation that started after `sequence` has committed. */
function mayCommit(sequence: number): boolean {
  return sequence > committedOperationSequence;
}

type AccessCommit = Partial<AccessStoreState> & {
  canonicalAccess: CanonicalAccessState | null;
};

function commitAccess(
  set: (patch: Partial<AccessStoreState>) => void,
  sequence: number,
  patch: AccessCommit,
): void {
  committedOperationSequence = Math.max(committedOperationSequence, sequence);
  set(patch);
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
    const sequence = beginOperation();
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

    const plans = plansResult.value;
    const selectedPeriod: BillingPeriod = plans?.annual
      ? 'annual'
      : plans?.lifetime
        ? 'lifetime'
        : plans?.monthly
          ? 'monthly'
          : 'annual';
    // A newer operation verified access while this read was in flight: its
    // status, error and snapshot stand; only the offerings loaded here land.
    if (!mayCommit(sequence)) {
      set({ plans, selectedPeriod });
      return;
    }

    const accessError = accessResult.error
      ? billingError(
          accessResult.error,
          'billing.backend_unavailable',
          'Membership verification is temporarily unavailable.',
        )
      : null;
    const plansError = plansResult.error
      ? billingError(
          plansResult.error,
          'billing.offerings_unavailable',
          'Membership pricing is unavailable from the app store right now.',
        )
      : null;
    // Free-rating access is server-authoritative and must remain available even
    // when the store SDK or offerings are not configured. Store failure blocks
    // purchase presentation; it never erases a verified free allowance.
    const error = accessError ?? plansError;
    commitAccess(set, sequence, {
      status: error ? statusFor(error) : 'ready',
      operation: 'idle',
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
    const sequence = beginOperation();
    set({ status: 'loading', error: null });
    try {
      const canonicalAccess = await clients.backend.getAccess();
      if (!isCurrentConfiguration(clients, version)) return false;
      if (!mayCommit(sequence)) return false;
      commitAccess(set, sequence, {
        status: 'ready',
        canonicalAccess,
        error: null,
      });
      return true;
    } catch (cause) {
      if (!isCurrentConfiguration(clients, version)) return false;
      if (!mayCommit(sequence)) return false;
      const error = billingError(
        cause,
        'billing.backend_unavailable',
        'Membership verification is temporarily unavailable.',
      );
      commitAccess(set, sequence, {
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
    const sequence = beginOperation();
    set({ operation: 'syncing', error: null });
    try {
      const synced = await clients.backend.syncBilling();
      if (!isCurrentConfiguration(clients, version)) return false;
      commitAccess(set, sequence, {
        status: 'ready',
        operation: 'idle',
        canonicalAccess: synced.access,
        error: null,
      });
      return synced.access.premium;
    } catch (cause) {
      if (!isCurrentConfiguration(clients, version)) return false;
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
      commitAccess(set, sequence, {
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
    const sequence = beginOperation();
    try {
      const synced = await clients.backend.syncBilling();
      if (!isCurrentConfiguration(clients, version)) return false;
      if (!synced.access.premium) {
        const error = new BillingError(
          'billing.backend_verification_pending',
          'The store completed your purchase, but membership verification is still pending. Try Restore purchases.',
          true,
        );
        commitAccess(set, sequence, {
          status: 'error',
          operation: 'idle',
          canonicalAccess: synced.access,
          error: error.toState(),
        });
        return false;
      }
      commitAccess(set, sequence, {
        status: 'ready',
        operation: 'idle',
        canonicalAccess: synced.access,
        error: null,
      });
      return true;
    } catch {
      if (!isCurrentConfiguration(clients, version)) return false;
      const error = new BillingError(
        'billing.backend_verification_pending',
        'The store completed your purchase, but membership verification is still pending. Try Restore purchases.',
        true,
      );
      commitAccess(set, sequence, {
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
    const sequence = beginOperation();
    try {
      const synced = await clients.backend.syncBilling();
      if (!isCurrentConfiguration(clients, version)) return false;
      if (!synced.access.premium) {
        const error = new BillingError(
          'billing.restore_failed',
          'No active Pickle Sensei membership was found for this store account.',
          false,
        );
        commitAccess(set, sequence, {
          status: 'ready',
          operation: 'idle',
          canonicalAccess: synced.access,
          error: error.toState(),
        });
        return false;
      }
      commitAccess(set, sequence, {
        status: 'ready',
        operation: 'idle',
        canonicalAccess: synced.access,
        error: null,
      });
      return true;
    } catch {
      if (!isCurrentConfiguration(clients, version)) return false;
      const error = new BillingError(
        'billing.backend_verification_pending',
        'Restored purchases could not be verified yet. Please try again.',
        true,
      );
      commitAccess(set, sequence, {
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
  useAccessStore.setState(dataDefaults());
}

/** Call on sign-out so the next account can never inherit in-memory access. */
export function clearAccessStoreConfiguration(): void {
  dependencies = null;
  configurationVersion += 1;
  useAccessStore.setState(dataDefaults());
}
