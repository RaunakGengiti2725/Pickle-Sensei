import { create } from 'zustand';
import { BILLING_REQUEST_TIMEOUT_MS } from '../billing/accessApi';
import {
  billingSnapshotAfterAccess,
  describeMembershipState,
  type MembershipState,
} from '../billing/membershipState';
import {
  createPendingFulfilment,
  createPendingFulfilmentStorage,
  parsePendingFulfilment,
  pendingFulfilmentRetryDue,
  pendingFulfilmentRetryAtMs,
  type PendingFulfilment,
  type PendingFulfilmentStorage,
} from '../billing/pendingFulfilment';
import {
  BillingError,
  type BillingAccessDependencies,
  type BillingErrorCode,
  type BillingErrorState,
  type BillingFulfilmentRequest,
  type BillingFulfilmentVerdict,
  type BillingPeriod,
  type CanonicalAccessState,
  type CanonicalBillingState,
  type CanonicalBillingSync,
  type StoreEntitlementState,
  type StorePlans,
} from '../billing/types';
import {
  canonicalDataOwner,
  captureDataOwnerContext,
  DataOwnerChangedError,
  getActiveDataOwner,
  isDataOwnerContextCurrent,
  type DataOwnerContext,
} from '../data/accountScope';
import { makeUuid } from '../util/uuid';

export type AccessLoadStatus =
  'idle' | 'loading' | 'ready' | 'unconfigured' | 'error';

export type AccessOperation = 'idle' | 'purchasing' | 'restoring' | 'syncing';
export type FulfilmentStatus =
  'unchecked' | 'clear' | 'pending' | 'unavailable';

export const BILLING_RECONCILIATION_INTERVAL_MS = 5 * 60_000;
export const BILLING_RECONCILIATION_RETRY_MS = 5_000;

export interface BillingReconciliationState {
  status: 'unchecked' | 'checking' | 'verified' | 'unavailable';
  lastAttemptAtMs: number | null;
  nextAttemptAtMs: number | null;
  error: BillingErrorState | null;
}

export interface AccessStoreState {
  status: AccessLoadStatus;
  operation: AccessOperation;
  plans: StorePlans | null;
  selectedPeriod: BillingPeriod;
  /** Server-authoritative. Null means fail closed. */
  canonicalAccess: CanonicalAccessState | null;
  /** Last `/v1/billing/sync` billing answer (verified horizon), if any. */
  canonicalBilling: CanonicalBillingState | null;
  pendingFulfilment: PendingFulfilment | null;
  fulfilmentStatus: FulfilmentStatus;
  reconciliation: BillingReconciliationState;
  /**
   * Server disposition bound to this device's own pending record. Superseded
   * (cleared) as soon as the server grants premium again, so a settled
   * verdict never describes a later, unrelated membership period.
   */
  fulfilmentVerdict: BillingFulfilmentVerdict | null;
  error: BillingErrorState | null;
  initialize(): Promise<void>;
  refreshAccess(): Promise<boolean>;
  syncBilling(): Promise<boolean>;
  reconcileBilling(options?: { force?: boolean }): Promise<boolean>;
  retryPendingFulfilment(options?: { automatic?: boolean }): Promise<boolean>;
  purchaseSelected(): Promise<boolean>;
  restorePurchases(): Promise<boolean>;
  selectPeriod(period: BillingPeriod): void;
  clearError(): void;
  reset(): void;
}

export interface AccessStoreConfigurationOptions {
  owner?: string;
  pendingFulfilmentStorage?: PendingFulfilmentStorage;
}

interface ReconciliationTracker {
  state: BillingReconciliationState;
  failures: number;
  inFlight: object | null;
}

interface BillingConfiguration {
  clients: BillingAccessDependencies;
  owner: string | null;
  ownerContext: DataOwnerContext | null;
  storage: PendingFulfilmentStorage;
  reconciliation: ReconciliationTracker;
  lifecycleRequested: boolean;
  ownerEpoch: number;
}

interface OperationScope {
  configuration: BillingConfiguration;
  active: boolean;
}

interface VerifiedAccess {
  access: CanonicalAccessState;
  error: BillingError | null;
  billingSynced: boolean;
}

let configuration: BillingConfiguration | null = null;
let activeOperation: OperationScope | null = null;
let nativeStoreOperation: object | null = null;
const defaultStorage = createPendingFulfilmentStorage();
const ownerEpochs = new Map<string, number>();
const rememberedCompletions = new Map<
  string,
  Map<PendingFulfilmentStorage, PendingFulfilment>
>();

const reconciliationTrackers = new Map<
  string,
  Map<PendingFulfilmentStorage, ReconciliationTracker>
>();

const reconciliationDefaults = (): BillingReconciliationState => ({
  status: 'unchecked',
  lastAttemptAtMs: null,
  nextAttemptAtMs: null,
  error: null,
});

function trackerFor(
  owner: string | null,
  storage: PendingFulfilmentStorage,
): ReconciliationTracker {
  const fresh = () => ({
    state: reconciliationDefaults(),
    failures: 0,
    inFlight: null,
  });
  if (!owner) return fresh();
  const trackers =
    reconciliationTrackers.get(owner) ??
    new Map<PendingFulfilmentStorage, ReconciliationTracker>();
  const tracker = trackers.get(storage) ?? fresh();
  trackers.set(storage, tracker);
  reconciliationTrackers.set(owner, trackers);
  return tracker;
}

function reconciliationDue(tracker: ReconciliationTracker): boolean {
  if (tracker.inFlight) return false;
  const { lastAttemptAtMs, nextAttemptAtMs } = tracker.state;
  return (
    nextAttemptAtMs === null ||
    (lastAttemptAtMs !== null && Date.now() < lastAttemptAtMs) ||
    Date.now() >= nextAttemptAtMs
  );
}

const dataDefaults = () => ({
  status: 'idle' as AccessLoadStatus,
  operation: 'idle' as AccessOperation,
  plans: null as StorePlans | null,
  selectedPeriod: 'monthly' as BillingPeriod,
  canonicalAccess: null as CanonicalAccessState | null,
  canonicalBilling: null as CanonicalBillingState | null,
  pendingFulfilment: null as PendingFulfilment | null,
  fulfilmentStatus: 'unchecked' as FulfilmentStatus,
  reconciliation: reconciliationDefaults(),
  fulfilmentVerdict: null as BillingFulfilmentVerdict | null,
  error: null as BillingErrorState | null,
});

const supersededVerdict = (access: CanonicalAccessState) =>
  access.premium ? { fulfilmentVerdict: null } : {};

const supersededBilling = (
  access: CanonicalAccessState,
  billing: CanonicalBillingState | null,
) => ({
  canonicalBilling: billingSnapshotAfterAccess(access, billing, Date.now()),
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

function pendingError(record?: PendingFulfilment | null): BillingError {
  return new BillingError(
    'billing.backend_verification_pending',
    record?.source === 'purchase'
      ? 'The store completed your purchase, but membership verification is still pending. Retry verification; do not purchase again.'
      : record?.source === 'restore'
        ? 'Restored purchases could not be verified yet. Retry verification; do not restore or purchase again.'
        : 'Membership verification could not be recovered. Retry verification before making another purchase.',
    true,
  );
}

function assertOwnerEpoch(current: BillingConfiguration): void {
  if (
    current.owner &&
    (ownerEpochs.get(current.owner) ?? 0) !== current.ownerEpoch
  ) {
    throw new DataOwnerChangedError();
  }
}

function isCurrentConfiguration(current: BillingConfiguration): boolean {
  return (
    configuration === current &&
    (!current.owner || current.ownerContext !== null) &&
    (!current.ownerContext ||
      (current.ownerContext.ownerKey === current.owner &&
        isDataOwnerContextCurrent(current.ownerContext))) &&
    (!current.owner ||
      (ownerEpochs.get(current.owner) ?? 0) === current.ownerEpoch)
  );
}

function invalidateCurrentOperations(): void {
  if (activeOperation) activeOperation.active = false;
  activeOperation = null;
  if (configuration) configuration.lifecycleRequested = false;
  try {
    configuration?.clients.store.invalidatePendingOperations?.();
  } catch {
    return;
  }
}

function isCurrent(scope: OperationScope): boolean {
  return scope.active && isCurrentConfiguration(scope.configuration);
}

function assertActive(scope: OperationScope): void {
  if (!isCurrent(scope)) throw new DataOwnerChangedError();
}

function remembered(current: BillingConfiguration): PendingFulfilment | null {
  if (!current.owner) return null;
  return rememberedCompletions.get(current.owner)?.get(current.storage) ?? null;
}

function remember(
  current: BillingConfiguration,
  record: PendingFulfilment,
): void {
  assertOwnerEpoch(current);
  const records = rememberedCompletions.get(record.owner) ?? new Map();
  records.set(current.storage, record);
  rememberedCompletions.set(record.owner, records);
}

function forget(
  current: BillingConfiguration,
  record: PendingFulfilment,
): void {
  const records = rememberedCompletions.get(record.owner);
  if (records?.get(current.storage)?.id !== record.id) return;
  records.delete(current.storage);
  if (records.size === 0) rememberedCompletions.delete(record.owner);
}

async function bounded<T>(
  operation: () => Promise<T>,
  error = new BillingError(
    'billing.backend_unavailable',
    'Membership verification took too long. Please try again.',
    true,
  ),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error), BILLING_REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function settled<T>(
  operation: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
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

export const selectNeedsFulfilmentRecovery = (
  state: AccessStoreState,
): boolean =>
  state.pendingFulfilment !== null || state.fulfilmentStatus === 'unavailable';

export const selectMembershipState = (
  state: AccessStoreState,
  now = Date.now(),
): MembershipState =>
  describeMembershipState({
    access: state.canonicalAccess,
    billing: state.canonicalBilling,
    pendingFulfilment: state.pendingFulfilment,
    fulfilmentStatus: state.fulfilmentStatus,
    reconciliationStatus: state.reconciliation.status,
    fulfilmentVerdict: state.fulfilmentVerdict,
    error: state.error ?? state.reconciliation.error,
    nowMs: now,
  });

export function selectBillingReconciliationRetryAtMs(
  state: AccessStoreState,
  now = Date.now(),
): number | null {
  const record = state.pendingFulfilment;
  if (record) {
    if (record.lastAttemptAtMs !== null && now < record.lastAttemptAtMs)
      return 0;
    return pendingFulfilmentRetryAtMs(record);
  }
  const { lastAttemptAtMs, nextAttemptAtMs } = state.reconciliation;
  return lastAttemptAtMs !== null && now < lastAttemptAtMs
    ? 0
    : nextAttemptAtMs;
}

export const useAccessStore = create<AccessStoreState>((set, get) => {
  const begin = (
    operation: AccessOperation,
    loading = false,
  ): OperationScope | null => {
    if (get().status === 'loading' || get().operation !== 'idle') return null;
    const current = configuration;
    if (!current) {
      const error = missingDependenciesError();
      set({
        ...dataDefaults(),
        status: 'unconfigured',
        error: error.toState(),
      });
      return null;
    }
    if (!isCurrentConfiguration(current)) {
      set(dataDefaults());
      return null;
    }
    const scope = { configuration: current, active: true };
    activeOperation = scope;
    set({
      operation,
      ...(loading ? { status: 'loading' as const } : {}),
      error: null,
    });
    return scope;
  };

  const finish = (scope: OperationScope) => {
    const current = isCurrent(scope);
    scope.active = false;
    if (activeOperation === scope) activeOperation = null;
    if (current) set({ operation: 'idle' });
    else if (configuration === scope.configuration) set(dataDefaults());
    if (current && scope.configuration.lifecycleRequested) {
      scope.configuration.lifecycleRequested = false;
      void Promise.resolve().then(() => {
        if (isCurrentConfiguration(scope.configuration))
          return get().reconcileBilling();
        return false;
      });
    }
  };

  const loadPending = async (
    scope: OperationScope,
  ): Promise<PendingFulfilment | null> => {
    assertActive(scope);
    const current = scope.configuration;
    if (!current.owner) {
      set({ pendingFulfilment: null, fulfilmentStatus: 'clear' });
      return null;
    }
    try {
      const value = await bounded(() => {
        assertActive(scope);
        return current.storage.read(current.owner!);
      }, pendingError());
      assertActive(scope);
      const saved =
        value === null
          ? null
          : parsePendingFulfilment(JSON.stringify(value), current.owner);
      const memory = remembered(current);
      if (saved && memory && saved.id !== memory.id) throw pendingError();
      const record =
        !saved || (memory && memory.attempts >= saved.attempts)
          ? memory
          : saved;
      if (record) remember(current, record);
      set({
        pendingFulfilment: record,
        fulfilmentStatus: record ? 'pending' : 'clear',
      });
      return record;
    } catch (cause) {
      if (isCurrent(scope)) {
        set({
          pendingFulfilment: remembered(current),
          fulfilmentStatus: 'unavailable',
        });
      }
      throw billingError(
        cause,
        'billing.backend_verification_pending',
        pendingError().message,
      );
    }
  };

  const verifyBackend = async (
    scope: OperationScope,
    fulfilment?: BillingFulfilmentRequest,
  ): Promise<CanonicalBillingSync> => {
    assertActive(scope);
    const tracker = scope.configuration.reconciliation;
    if (tracker.inFlight) {
      throw new BillingError(
        'billing.backend_unavailable',
        'Membership verification is already in progress. Please try again.',
        true,
      );
    }
    const request = {};
    tracker.inFlight = request;
    const lastAttemptAtMs = Date.now();
    tracker.state = {
      status: 'checking',
      lastAttemptAtMs,
      nextAttemptAtMs: lastAttemptAtMs + BILLING_REQUEST_TIMEOUT_MS,
      error: null,
    };
    set({ reconciliation: tracker.state });
    try {
      const result = await bounded(() => {
        assertActive(scope);
        return fulfilment
          ? scope.configuration.clients.backend.syncBilling(fulfilment)
          : scope.configuration.clients.backend.syncBilling();
      });
      assertActive(scope);
      tracker.failures = 0;
      tracker.state = {
        status: 'verified',
        lastAttemptAtMs,
        nextAttemptAtMs: Date.now() + BILLING_RECONCILIATION_INTERVAL_MS,
        error: null,
      };
      set({ reconciliation: tracker.state, canonicalBilling: result.billing });
      return result;
    } catch (cause) {
      if (isCurrent(scope)) {
        tracker.failures = Math.min(tracker.failures + 1, 31);
        const error = billingError(
          cause,
          'billing.backend_unavailable',
          'Membership verification is temporarily unavailable.',
        );
        tracker.state = {
          status: 'unavailable',
          lastAttemptAtMs,
          nextAttemptAtMs:
            Date.now() +
            Math.min(
              BILLING_RECONCILIATION_RETRY_MS *
                2 ** Math.min(tracker.failures - 1, 6),
              BILLING_RECONCILIATION_INTERVAL_MS,
            ),
          error: error.toState(),
        };
        set({ reconciliation: tracker.state });
      }
      throw cause;
    } finally {
      if (tracker.inFlight === request) tracker.inFlight = null;
    }
  };

  const verifyPending = async (
    scope: OperationScope,
    record: PendingFulfilment,
  ): Promise<VerifiedAccess> => {
    assertActive(scope);
    const current = scope.configuration;
    const attempted: PendingFulfilment = {
      ...record,
      attempts: Math.min(record.attempts + 1, 31),
      lastAttemptAtMs: Date.now(),
    };
    remember(current, attempted);
    set({ pendingFulfilment: attempted, fulfilmentStatus: 'pending' });
    await bounded(() => {
      assertActive(scope);
      return current.storage.write(attempted, () => assertActive(scope));
    }, pendingError(attempted));
    assertActive(scope);
    const fulfilmentRequest = attempted.transaction
      ? {
          pendingId: attempted.id,
          attemptId: makeUuid(),
          transaction: attempted.transaction,
        }
      : undefined;
    const synced = await verifyBackend(scope, fulfilmentRequest);
    assertActive(scope);
    const disposition = synced.fulfilment;
    const bound =
      fulfilmentRequest &&
      disposition &&
      disposition.pendingId === fulfilmentRequest.pendingId &&
      disposition.attemptId === fulfilmentRequest.attemptId &&
      JSON.stringify(disposition.transaction) ===
        JSON.stringify(fulfilmentRequest.transaction) &&
      Number.isFinite(Date.parse(disposition.verifiedAt)) &&
      Date.parse(disposition.verifiedAt) >=
        Date.parse(fulfilmentRequest.transaction.purchasedAt);
    const terminal =
      bound &&
      (disposition.outcome === 'expired' || disposition.outcome === 'refunded');
    const fulfilled =
      bound && disposition.outcome === 'fulfilled' && synced.access.premium;
    set({ fulfilmentVerdict: bound && disposition ? disposition : null });
    if (
      (fulfilmentRequest && !terminal && !fulfilled) ||
      (!fulfilmentRequest &&
        !synced.access.premium &&
        attempted.source === 'purchase')
    ) {
      return {
        access: synced.access,
        error: pendingError(attempted),
        billingSynced: true,
      };
    }
    await bounded(() => {
      assertActive(scope);
      return current.storage.remove(attempted, () => assertActive(scope));
    }, pendingError(attempted));
    assertActive(scope);
    forget(current, attempted);
    set({ pendingFulfilment: null, fulfilmentStatus: 'clear' });
    return {
      access: synced.access,
      billingSynced: true,
      error: terminal
        ? new BillingError(
            'billing.purchase_settled',
            disposition.outcome === 'refunded'
              ? 'The store confirmed this purchase was refunded. Membership verification is complete.'
              : 'The store confirmed this purchase has expired. Membership verification is complete.',
            false,
          )
        : synced.access.premium
          ? null
          : new BillingError(
              'billing.restore_failed',
              'No active Pickle Sensei membership was found for this store account.',
              false,
            ),
    };
  };

  const loadAccess = async (scope: OperationScope): Promise<VerifiedAccess> => {
    const record = await loadPending(scope);
    assertActive(scope);
    if (record) return verifyPending(scope, record);
    const access = await bounded(() => {
      assertActive(scope);
      return scope.configuration.clients.backend.getAccess();
    });
    assertActive(scope);
    return { access, error: null, billingSynced: false };
  };

  const publishedBilling = (result: VerifiedAccess) =>
    result.billingSynced
      ? {}
      : supersededBilling(result.access, get().canonicalBilling);

  const publishAccess = (scope: OperationScope, result: VerifiedAccess) => {
    assertActive(scope);
    set({
      status:
        result.error &&
        result.error.code !== 'billing.restore_failed' &&
        result.error.code !== 'billing.purchase_settled'
          ? statusFor(result.error)
          : 'ready',
      canonicalAccess: result.access,
      ...supersededVerdict(result.access),
      ...publishedBilling(result),
      error: result.error?.toState() ?? null,
    });
  };

  const failVerification = (scope: OperationScope, cause: unknown) => {
    if (!isCurrent(scope)) return;
    const error = get().pendingFulfilment
      ? pendingError(get().pendingFulfilment)
      : billingError(
          cause,
          'billing.backend_unavailable',
          'Membership verification is temporarily unavailable.',
        );
    set({
      status: statusFor(error),
      canonicalAccess: null,
      canonicalBilling: null,
      error: error.toState(),
    });
  };

  const completeStoreOperation = async (
    source: PendingFulfilment['source'],
    purchasePlanId?: string,
  ): Promise<boolean> => {
    const scope = begin(source === 'purchase' ? 'purchasing' : 'restoring');
    if (!scope) return false;
    const current = scope.configuration;
    let completed = false;
    try {
      if (!current.owner) {
        throw new BillingError(
          'billing.unconfigured',
          'Billing needs a canonical signed-in account before opening the app store.',
          false,
          'missing_canonical_app_user_id',
        );
      }
      const existing = await loadPending(scope);
      assertActive(scope);
      if (existing) {
        set({ status: 'error', error: pendingError(existing).toState() });
        return false;
      }
      if (
        get().reconciliation.status === 'unavailable' ||
        get().reconciliation.status === 'checking' ||
        current.reconciliation.inFlight
      ) {
        throw new BillingError(
          'billing.backend_unavailable',
          'Verify membership with the server before opening another store request.',
          true,
        );
      }
      if (nativeStoreOperation) {
        throw new BillingError(
          'billing.purchase_failed',
          'The app store is still finishing another request. Please wait before trying again.',
          true,
        );
      }
      const nativeOperation = {};
      nativeStoreOperation = nativeOperation;
      let record: PendingFulfilment;
      try {
        const request: () => Promise<StoreEntitlementState> =
          source === 'purchase'
            ? () => current.clients.store.purchase(purchasePlanId!)
            : () => current.clients.store.restore();
        const storeResult = await request();
        completed = true;
        assertOwnerEpoch(current);
        record = createPendingFulfilment(
          current.owner,
          source,
          storeResult?.transaction,
        );
        remember(current, record);
        if (isCurrent(scope))
          set({ pendingFulfilment: record, fulfilmentStatus: 'pending' });
        await bounded(
          () =>
            current.storage.write(record, () => {
              assertOwnerEpoch(current);
              const pending = remembered(current);
              if (
                pending?.id !== record.id ||
                pending.attempts !== record.attempts
              )
                throw new DataOwnerChangedError();
            }),
          pendingError(record),
        );
      } finally {
        if (nativeStoreOperation === nativeOperation)
          nativeStoreOperation = null;
      }
      assertActive(scope);
      const result = await verifyPending(scope, record);
      publishAccess(scope, result);
      return isCurrent(scope) && result.access.premium;
    } catch (cause) {
      if (!isCurrent(scope)) return false;
      if (completed || selectNeedsFulfilmentRecovery(get())) {
        failVerification(scope, cause);
      } else {
        const error = billingError(
          cause,
          source === 'purchase'
            ? 'billing.purchase_failed'
            : 'billing.restore_failed',
          source === 'purchase'
            ? 'The app store could not complete the purchase.'
            : 'The app store could not restore purchases.',
        );
        set({
          error:
            error.code === 'billing.purchase_cancelled'
              ? null
              : error.toState(),
        });
      }
      return false;
    } finally {
      finish(scope);
    }
  };

  return {
    ...dataDefaults(),

    initialize: async () => {
      const scope = begin('idle', true);
      if (!scope) return;
      try {
        const [accessResult, plansResult] = await Promise.all([
          settled(() => loadAccess(scope)),
          settled(async () => {
            try {
              await bounded(
                () => {
                  assertActive(scope);
                  return scope.configuration.clients.store.configure();
                },
                new BillingError(
                  'billing.unconfigured',
                  'RevenueCat could not start in this build. Please try again.',
                  true,
                ),
              );
            } catch (cause) {
              throw billingError(
                cause,
                'billing.unconfigured',
                'RevenueCat could not start in this build.',
                false,
              );
            }
            assertActive(scope);
            return bounded(
              () => {
                assertActive(scope);
                return scope.configuration.clients.store.loadPlans();
              },
              new BillingError(
                'billing.offerings_unavailable',
                'Membership pricing is unavailable from the app store right now.',
                true,
              ),
            );
          }),
        ]);
        assertActive(scope);
        const accessError = accessResult.ok
          ? accessResult.value.error
          : get().pendingFulfilment
            ? pendingError(get().pendingFulfilment)
            : billingError(
                accessResult.error,
                'billing.backend_unavailable',
                'Membership verification is temporarily unavailable.',
              );
        const plansError = plansResult.ok
          ? null
          : billingError(
              plansResult.error,
              'billing.offerings_unavailable',
              'Membership pricing is unavailable from the app store right now.',
            );
        // Free-rating access is server-authoritative and must remain available even
        // when the store SDK or offerings are not configured. Store failure blocks
        // purchase presentation; it never erases a verified free allowance.
        const error = accessError ?? plansError;
        const plans = plansResult.ok ? plansResult.value : null;
        set({
          status:
            error && error.code !== 'billing.restore_failed'
              ? statusFor(error)
              : 'ready',
          plans,
          // The recommended (monthly) plan is pre-selected; the paywall's
          // podium presents it as the hero, so the store must agree.
          selectedPeriod: plans?.monthly
            ? 'monthly'
            : plans?.annual
              ? 'annual'
              : plans?.lifetime
                ? 'lifetime'
                : 'monthly',
          canonicalAccess: accessResult.ok ? accessResult.value.access : null,
          ...(accessResult.ok
            ? {
                ...supersededVerdict(accessResult.value.access),
                ...publishedBilling(accessResult.value),
              }
            : {}),
          error: error?.toState() ?? null,
        });
      } catch (cause) {
        failVerification(scope, cause);
      } finally {
        finish(scope);
      }
    },

    refreshAccess: async () => {
      const scope = begin('idle', true);
      if (!scope) return false;
      try {
        const result = await loadAccess(scope);
        publishAccess(scope, result);
        return isCurrent(scope) && result.error === null;
      } catch (cause) {
        failVerification(scope, cause);
        return false;
      } finally {
        finish(scope);
      }
    },

    syncBilling: async () => {
      const scope = begin('syncing');
      if (!scope) return false;
      try {
        const record = await loadPending(scope);
        assertActive(scope);
        const result = record
          ? await verifyPending(scope, record)
          : {
              access: (await verifyBackend(scope)).access,
              error: null,
              billingSynced: true,
            };
        publishAccess(scope, result);
        return isCurrent(scope) && result.access.premium;
      } catch (cause) {
        failVerification(scope, cause);
        return false;
      } finally {
        finish(scope);
      }
    },

    reconcileBilling: async options => {
      const current = configuration;
      if (!current || !current.owner || !isCurrentConfiguration(current))
        return false;
      if (current.reconciliation.inFlight) return false;
      if (get().status === 'loading' || get().operation !== 'idle') {
        if (!options?.force) current.lifecycleRequested = true;
        return false;
      }
      const knownPending = get().pendingFulfilment ?? remembered(current);
      if (
        !options?.force &&
        !knownPending &&
        !reconciliationDue(current.reconciliation) &&
        (get().canonicalAccess !== null || get().status !== 'idle')
      )
        return false;
      const previousError = get().error;
      const previousReconciliation = current.reconciliation.state;
      const scope = begin('syncing');
      if (!scope) return false;
      set({
        reconciliation: {
          ...current.reconciliation.state,
          status: 'checking',
          error: null,
        },
      });
      let required = false;
      try {
        const record = await loadPending(scope);
        assertActive(scope);
        required = record !== null;
        if (record) {
          if (!options?.force && !pendingFulfilmentRetryDue(record)) {
            set({
              error: previousError,
              reconciliation: current.reconciliation.state,
            });
            return false;
          }
          const result = await verifyPending(scope, record);
          publishAccess(scope, result);
          return isCurrent(scope) && result.access.premium;
        }
        if (!get().canonicalAccess) {
          const access = await bounded(() => {
            assertActive(scope);
            return current.clients.backend.getAccess();
          });
          assertActive(scope);
          set({
            status: 'ready',
            canonicalAccess: access,
            ...supersededVerdict(access),
            ...supersededBilling(access, get().canonicalBilling),
          });
        }
        if (!options?.force && !reconciliationDue(current.reconciliation)) {
          set({ reconciliation: current.reconciliation.state });
          return false;
        }
        const synced = await verifyBackend(scope);
        publishAccess(scope, {
          access: synced.access,
          error: null,
          billingSynced: true,
        });
        return isCurrent(scope) && synced.access.premium;
      } catch (cause) {
        if (isCurrent(scope)) {
          if (
            !required &&
            current.reconciliation.state === previousReconciliation
          ) {
            const tracker = current.reconciliation;
            tracker.failures = Math.min(tracker.failures + 1, 31);
            tracker.state = {
              status: 'unavailable',
              lastAttemptAtMs: Date.now(),
              nextAttemptAtMs:
                Date.now() +
                Math.min(
                  BILLING_RECONCILIATION_RETRY_MS *
                    2 ** Math.min(tracker.failures - 1, 6),
                  BILLING_RECONCILIATION_INTERVAL_MS,
                ),
              error: billingError(
                cause,
                'billing.backend_unavailable',
                'Membership verification is temporarily unavailable.',
              ).toState(),
            };
            set({ reconciliation: tracker.state });
          }
          if (required || !get().canonicalAccess)
            failVerification(scope, cause);
          else set({ error: previousError });
        }
        return false;
      } finally {
        finish(scope);
      }
    },

    retryPendingFulfilment: async options => {
      const previousError = get().error;
      const scope = begin('syncing');
      if (!scope) return false;
      try {
        const record = await loadPending(scope);
        assertActive(scope);
        if (!record) {
          set({ error: previousError });
          return false;
        }
        if (options?.automatic && !pendingFulfilmentRetryDue(record)) {
          set({ status: 'error', error: pendingError(record).toState() });
          return false;
        }
        const result = await verifyPending(scope, record);
        publishAccess(scope, result);
        return isCurrent(scope) && result.access.premium;
      } catch (cause) {
        failVerification(scope, cause);
        return false;
      } finally {
        finish(scope);
      }
    },

    purchaseSelected: async () => {
      if (
        get().operation !== 'idle' ||
        get().status === 'loading' ||
        selectHasPremium(get())
      )
        return false;
      const plan = selectedPlan(get().plans, get().selectedPeriod);
      if (!plan || !get().canonicalAccess) {
        const error = new BillingError(
          plan
            ? 'billing.backend_unavailable'
            : 'billing.offerings_unavailable',
          plan
            ? 'Verify this account with the server before starting a purchase.'
            : 'That membership plan is unavailable from the app store.',
          true,
        );
        set({ status: 'error', error: error.toState() });
        return false;
      }
      // Store state is deliberately ignored for access. The authenticated
      // backend re-reads RevenueCat before this store changes canonicalAccess.
      return completeStoreOperation('purchase', plan.id);
    },

    restorePurchases: async () => {
      // As with purchase, a local RevenueCat entitlement never unlocks access.
      return completeStoreOperation('restore');
    },

    selectPeriod: period => {
      if (get().operation === 'idle' && selectedPlan(get().plans, period))
        set({ selectedPeriod: period });
    },
    clearError: () =>
      set({
        error: null,
        reconciliation: { ...get().reconciliation, error: null },
      }),
    reset: () => {
      invalidateCurrentOperations();
      if (configuration) configuration = { ...configuration };
      set(dataDefaults());
    },
  };
});

/**
 * Connect billing only after account bootstrap returns its canonical app UUID.
 * Passing an Apple/Google/guest subject to the RevenueCat client is rejected.
 */
export function configureAccessStore(
  nextDependencies: BillingAccessDependencies,
  options?: AccessStoreConfigurationOptions,
): void {
  invalidateCurrentOperations();
  let owner: string | null = null;
  try {
    owner = canonicalDataOwner(
      options?.owner ??
        nextDependencies.canonicalAppUserId ??
        getActiveDataOwner(),
    );
    if (
      nextDependencies.canonicalAppUserId &&
      canonicalDataOwner(nextDependencies.canonicalAppUserId) !== owner
    ) {
      configuration = null;
      const error = new BillingError(
        'billing.unconfigured',
        'Billing could not bind to this signed-in account.',
        false,
        'invalid_canonical_app_user_id',
      );
      useAccessStore.setState({
        ...dataDefaults(),
        status: 'unconfigured',
        error: error.toState(),
      });
      return;
    }
  } catch {
    owner = null;
  }
  let ownerContext: DataOwnerContext | null = null;
  try {
    canonicalDataOwner(getActiveDataOwner());
    ownerContext = captureDataOwnerContext();
  } catch {
    ownerContext = null;
  }
  const storage =
    options?.pendingFulfilmentStorage ??
    nextDependencies.pendingFulfilmentStorage ??
    defaultStorage;
  configuration = {
    clients: nextDependencies,
    owner,
    ownerContext,
    storage,
    reconciliation: trackerFor(owner, storage),
    lifecycleRequested: false,
    ownerEpoch: owner ? (ownerEpochs.get(owner) ?? 0) : 0,
  };
  useAccessStore.setState({
    ...dataDefaults(),
    reconciliation: configuration.reconciliation.state,
  });
}

/** Call on sign-out so the next account can never inherit in-memory access. */
export function clearAccessStoreConfiguration(): void {
  invalidateCurrentOperations();
  configuration = null;
  useAccessStore.setState(dataDefaults());
}

export function createBillingLifecycleCallback(
  owner: string,
): () => Promise<boolean> {
  const current = configuration;
  const canonicalOwner = canonicalDataOwner(owner);
  return async () => {
    if (
      !current ||
      current.owner !== canonicalOwner ||
      !isCurrentConfiguration(current)
    )
      return false;
    return useAccessStore.getState().reconcileBilling();
  };
}

export function discardPendingFulfilmentForOwner(owner: string): void {
  const normalized = canonicalDataOwner(owner);
  ownerEpochs.set(normalized, (ownerEpochs.get(normalized) ?? 0) + 1);
  rememberedCompletions.delete(normalized);
  reconciliationTrackers.delete(normalized);
  if (configuration?.owner === normalized) clearAccessStoreConfiguration();
}
