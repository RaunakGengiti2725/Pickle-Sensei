/**
 * STRESS / mod-access-store / randomized-seeded — seeded randomized long-run
 * over the public API of `src/state/accessStore.ts`.
 *
 * Every sequence is generated from a 32-bit seed (mulberry32) into an EXPLICIT
 * action script: store calls (initialize, refreshAccess, syncBilling,
 * purchaseSelected, restorePurchases, selectPeriod, clearError, reset,
 * configureAccessStore, clearAccessStoreConfiguration) interleaved with
 * settlement of the fake store/backend calls they issued (resolve or reject,
 * in ANY order — that is where refresh races and stale snapshots live). The
 * script is then executed against the real store and the invariants below are
 * model-checked after every step. Because the script is explicit, a failing
 * seed is delta-minimized (ddmin over the action list) and every seed is run
 * twice to prove the trace is identical (determinism).
 *
 * Invariants (from AGENTS.md "Billing" + the comments in accessStore.ts):
 *  I1 enums     status/operation/selectedPeriod stay inside their unions.
 *  I2 provenance canonicalAccess is null or the EXACT object the backend of
 *               the CURRENT configuration epoch returned (server-authoritative,
 *               never a store entitlement, never a previous account's answer).
 *  I3 freshness within one epoch an applied snapshot never regresses to an
 *               answer the server produced EARLIER than one already shown
 *               (the "stale snapshot" property; freshness = request order).
 *  I4 quiescence no pending call in the current epoch ⇒ status ≠ 'loading'
 *               and operation = 'idle' (nothing stuck busy).
 *  I5 ready     status = 'ready' ⇒ canonicalAccess ≠ null.
 *  I6 period    when any plan exists, selectedPeriod names an existing plan.
 *  I7 selectors selectHasPremium / selectCanStartRating / selectPaywallRequired
 *               are pure functions of canonicalAccess.
 *  I8 exclusivity at most one store.purchase/store.restore in flight, and
 *               while one is in flight operation ≠ 'idle' (Paywall disables
 *               its buttons from `operation`).
 *  I9 liveness every store method promise settles once the fakes are drained.
 *
 * Knobs: STRESS_ITER (sequences, default 300 — 2000 for a campaign),
 * STRESS_SEED (base seed, default 20260904), STRESS_OUT (write the seed →
 * outcome JSON table to this path), STRESS_REPLAY (run exactly one seed),
 * STRESS_SKIP (comma-separated invariant ids to evaluate but not report, so the
 * remaining invariants are still checked to full length once a class is known).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  BillingError,
  type BillingAccessDependencies,
  type BillingPeriod,
  type CanonicalAccessState,
  type CanonicalBillingSync,
  type StoreEntitlementState,
  type StorePlan,
  type StorePlans,
} from '../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectCanStartRating,
  selectHasPremium,
  selectPaywallRequired,
  useAccessStore,
  type AccessLoadStatus,
  type AccessOperation,
  type AccessStoreState,
} from '../../src/state/accessStore';

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Action script
// ---------------------------------------------------------------------------

/** Three uniform rolls; the settler maps them onto whatever call it picks. */
interface Outcome {
  ok: boolean;
  r1: number;
  r2: number;
  r3: number;
}

type Action =
  | { kind: 'configure'; sameDeps: boolean }
  | { kind: 'clear' }
  | { kind: 'reset' }
  | { kind: 'initialize' }
  | { kind: 'refreshAccess' }
  | { kind: 'syncBilling' }
  | { kind: 'purchaseSelected' }
  | { kind: 'restorePurchases' }
  | { kind: 'selectPeriod'; period: BillingPeriod }
  | { kind: 'clearError' }
  | { kind: 'settle'; pick: number; outcome: Outcome }
  | { kind: 'flush' };

const PERIODS: readonly BillingPeriod[] = ['annual', 'monthly', 'lifetime'];

const WEIGHTED_KINDS: ReadonlyArray<[Action['kind'], number]> = [
  ['configure', 4],
  ['clear', 2],
  ['reset', 2],
  ['initialize', 9],
  ['refreshAccess', 12],
  ['syncBilling', 6],
  ['purchaseSelected', 8],
  ['restorePurchases', 6],
  ['selectPeriod', 4],
  ['clearError', 3],
  ['settle', 30],
  ['flush', 4],
];
const TOTAL_WEIGHT = WEIGHTED_KINDS.reduce((sum, [, w]) => sum + w, 0);

function pickKind(rng: () => number): Action['kind'] {
  let roll = rng() * TOTAL_WEIGHT;
  for (const [kind, weight] of WEIGHTED_KINDS) {
    roll -= weight;
    if (roll < 0) return kind;
  }
  return 'settle';
}

function outcome(rng: () => number): Outcome {
  return { ok: rng() < 0.7, r1: rng(), r2: rng(), r3: rng() };
}

export function generateScript(seed: number): Action[] {
  const rng = mulberry32(seed);
  const length = 5 + Math.floor(rng() * 56); // 5..60
  const script: Action[] = [];
  // Most sequences start configured; some exercise the unconfigured store.
  if (rng() < 0.85) script.push({ kind: 'configure', sameDeps: false });
  while (script.length < length) {
    const kind = pickKind(rng);
    switch (kind) {
      case 'configure':
        script.push({ kind, sameDeps: rng() < 0.3 });
        break;
      case 'selectPeriod':
        script.push({
          kind,
          period: PERIODS[Math.floor(rng() * 3)] ?? 'annual',
        });
        break;
      case 'settle':
        script.push({
          kind,
          pick: Math.floor(rng() * 64),
          outcome: outcome(rng),
        });
        break;
      default:
        script.push({ kind } as Action);
    }
  }
  return script;
}

// ---------------------------------------------------------------------------
// Fake dependencies with explicit settlement
// ---------------------------------------------------------------------------

type CallKind =
  | 'configure'
  | 'loadPlans'
  | 'purchase'
  | 'restore'
  | 'readEntitlement'
  | 'getAccess'
  | 'syncBilling';

interface PendingCall {
  id: number;
  kind: CallKind;
  epoch: number;
  /** Request order — the server answers reflect state as of this point. */
  freshness: number;
  planId: string | null;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface SnapshotMeta {
  id: number;
  epoch: number;
  freshness: number;
  source: 'getAccess' | 'syncBilling';
}

class Harness {
  epoch = 0;
  nextCallId = 1;
  pending: PendingCall[] = [];
  snapshots = new Map<CanonicalAccessState, SnapshotMeta>();
  plansById = new Map<StorePlans, number>();
  currentDeps: BillingAccessDependencies | null = null;
  /** Highest freshness applied to canonicalAccess per epoch (I3). */
  appliedHighWater = new Map<number, number>();

  bumpEpoch(): void {
    this.epoch += 1;
  }

  private issue<T>(kind: CallKind, planId: string | null = null): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        id: this.nextCallId++,
        kind,
        epoch: this.epoch,
        freshness: this.nextCallId,
        planId,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  makeDeps(): BillingAccessDependencies {
    return {
      store: {
        configure: () => this.issue<void>('configure'),
        loadPlans: () => this.issue<StorePlans>('loadPlans'),
        purchase: (planId: string) =>
          this.issue<StoreEntitlementState>('purchase', planId),
        restore: () => this.issue<StoreEntitlementState>('restore'),
        readEntitlement: () =>
          this.issue<StoreEntitlementState>('readEntitlement'),
      },
      backend: {
        getAccess: () => this.issue<CanonicalAccessState>('getAccess'),
        syncBilling: () => this.issue<CanonicalBillingSync>('syncBilling'),
      },
    };
  }

  pendingInEpoch(...kinds: CallKind[]): PendingCall[] {
    return this.pending.filter(
      call =>
        call.epoch === this.epoch &&
        (kinds.length === 0 || kinds.includes(call.kind)),
    );
  }

  /** Resolve/reject one pending call chosen by `pick mod pending.length`. */
  settle(pick: number, out: Outcome): string {
    if (this.pending.length === 0) return 'settle:none';
    const index = pick % this.pending.length;
    const [call] = this.pending.splice(index, 1);
    if (!call) return 'settle:none';
    if (out.ok) {
      const value = this.successValue(call, out);
      call.resolve(value);
      return `settle:${call.kind}#${call.id}:ok`;
    }
    const error = this.failureValue(call, out);
    call.reject(error);
    return `settle:${call.kind}#${call.id}:err(${
      error instanceof BillingError ? error.code : 'Error'
    })`;
  }

  private accessSnapshot(
    call: PendingCall,
    out: Outcome,
    source: SnapshotMeta['source'],
    forcePremium: boolean | null,
  ): CanonicalAccessState {
    const premium = forcePremium ?? out.r1 < 0.3;
    // Near-legal ledgers on purpose (used > limit, reserved > remaining):
    // the store must carry the server's answer verbatim, never repair it.
    const used = Math.floor(out.r2 * 4); // 0..3
    const reserved = Math.floor(out.r3 * 3); // 0..2
    const remaining = Math.max(0, 2 - used);
    const availableToReserve = Math.max(0, remaining - reserved);
    const canStartRating = premium || availableToReserve > 0;
    const snapshot: CanonicalAccessState = {
      premium,
      entitlements: premium ? ['pickle_sensei_pro'] : [],
      freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
      canStartRating,
      paywallRequired: !canStartRating,
    };
    this.snapshots.set(snapshot, {
      id: call.id,
      epoch: call.epoch,
      freshness: call.freshness,
      source,
    });
    return snapshot;
  }

  private successValue(call: PendingCall, out: Outcome): unknown {
    switch (call.kind) {
      case 'configure':
        return undefined;
      case 'loadPlans': {
        const plan = (period: BillingPeriod, threshold: number) =>
          out.r1 < threshold
            ? null
            : ({
                id: `${period}-plan`,
                productId: `pickle_sensei_pro_${period}`,
                period,
                price: 1,
                priceString: '$1.00',
                pricePerMonthString: period === 'lifetime' ? null : '$1.00',
                freeTrial: null,
              } satisfies StorePlan);
        const plans: StorePlans = {
          offeringId: 'default',
          annual: plan('annual', 0.25),
          monthly: plan('monthly', 0.15),
          lifetime: plan('lifetime', 0.35),
        };
        if (out.r2 < 0.08) {
          plans.annual = null;
          plans.monthly = null;
          plans.lifetime = null;
        }
        this.plansById.set(plans, call.id);
        return plans;
      }
      case 'purchase':
      case 'restore':
      case 'readEntitlement':
        return {
          // Store says premium most of the time; the store must ignore it.
          premium: out.r1 < 0.85,
          productId: call.planId ?? 'pickle_sensei_pro_annual',
          expirationDate: '2027-01-01T00:00:00.000Z',
        } satisfies StoreEntitlementState;
      case 'getAccess':
        return this.accessSnapshot(call, out, 'getAccess', null);
      case 'syncBilling': {
        const premium = out.r1 < 0.6;
        return {
          billing: {
            premium,
            productKey: premium ? 'pickle_sensei_pro_annual' : null,
            expiresAt: premium ? '2027-01-01T00:00:00.000Z' : null,
            verifiedAt: '2026-09-04T00:00:00.000Z',
          },
          access: this.accessSnapshot(call, out, 'syncBilling', premium),
        } satisfies CanonicalBillingSync;
      }
    }
  }

  private failureValue(call: PendingCall, out: Outcome): unknown {
    const roll = out.r1;
    switch (call.kind) {
      case 'configure':
        return roll < 0.5
          ? new Error('sdk boot failed')
          : new BillingError(
              'billing.unconfigured',
              'no public key',
              false,
              'missing_public_sdk_key',
            );
      case 'loadPlans':
        return roll < 0.5
          ? new Error('offerings timeout')
          : new BillingError('billing.offerings_unavailable', 'none', true);
      case 'purchase':
        return roll < 0.4
          ? new BillingError('billing.purchase_cancelled', 'cancelled', false)
          : roll < 0.7
            ? new BillingError('billing.purchase_failed', 'declined', true)
            : new Error('storekit crashed');
      case 'restore':
        return roll < 0.5
          ? new BillingError('billing.restore_failed', 'nothing', false)
          : new Error('storekit offline');
      case 'readEntitlement':
        return new Error('unused');
      case 'getAccess':
      case 'syncBilling':
        return roll < 0.4
          ? new Error('network')
          : roll < 0.7
            ? new BillingError('billing.backend_unavailable', '503', true)
            : roll < 0.85
              ? new BillingError(
                  'billing.backend_unconfigured',
                  'no token',
                  false,
                  'missing_api_token',
                )
              : new BillingError(
                  'billing.backend_invalid_response',
                  'bad json',
                  true,
                );
    }
  }
}

// ---------------------------------------------------------------------------
// Execution + invariants
// ---------------------------------------------------------------------------

const STATUSES: readonly AccessLoadStatus[] = [
  'idle',
  'loading',
  'ready',
  'unconfigured',
  'error',
];
const OPERATIONS: readonly AccessOperation[] = [
  'idle',
  'purchasing',
  'restoring',
  'syncing',
];

interface Violation {
  invariant: string;
  step: number;
  action: string;
  detail: string;
}

interface OpHandle {
  id: number;
  kind: string;
  step: number;
  settled: boolean;
  result: unknown;
}

interface TraceEntry {
  step: number;
  action: string;
  status: AccessLoadStatus;
  operation: AccessOperation;
  period: BillingPeriod;
  plans: number | null;
  access: string | null;
  error: string | null;
  pending: string;
  ops: string;
}

export interface RunResult {
  seed: number | null;
  length: number;
  violation: Violation | null;
  trace: TraceEntry[];
  steps: number;
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'configure':
      return action.sameDeps ? 'configure(same)' : 'configure(new)';
    case 'selectPeriod':
      return `selectPeriod(${action.period})`;
    case 'settle':
      return `settle(${action.pick},${action.outcome.ok ? 'ok' : 'err'})`;
    default:
      return action.kind;
  }
}

/**
 * Invariant ids listed in STRESS_SKIP (comma separated) are still evaluated
 * but not reported, so a campaign can keep model-checking the OTHER
 * invariants to full sequence length once a failure class is known.
 */
const SKIP = new Set(
  (process.env.STRESS_SKIP ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
);

function checkInvariants(
  h: Harness,
  state: AccessStoreState,
  ops: OpHandle[],
): Omit<Violation, 'step' | 'action'> | null {
  const found: Omit<Violation, 'step' | 'action'>[] = [];
  const fail = (invariant: string, detail: string): null => {
    if (!SKIP.has(invariant)) found.push({ invariant, detail });
    return null;
  };

  if (!STATUSES.includes(state.status))
    fail('I1.enums', `status=${String(state.status)}`);
  if (!OPERATIONS.includes(state.operation))
    fail('I1.enums', `operation=${String(state.operation)}`);
  if (!PERIODS.includes(state.selectedPeriod))
    fail('I1.enums', `selectedPeriod=${String(state.selectedPeriod)}`);

  if (state.canonicalAccess !== null) {
    const meta = h.snapshots.get(state.canonicalAccess);
    if (!meta)
      fail(
        'I2.provenance',
        'canonicalAccess is not an object the backend returned',
      );
    else if (meta.epoch !== h.epoch)
      fail(
        'I2.provenance',
        `canonicalAccess #${meta.id} is from epoch ${meta.epoch}, current epoch ${h.epoch}`,
      );
    else {
      const high = h.appliedHighWater.get(h.epoch) ?? -1;
      if (meta.freshness < high)
        fail(
          'I3.freshness',
          `applied ${meta.source} snapshot #${meta.id} (request order ${meta.freshness}) after a snapshot with request order ${high} had already been shown`,
        );
      h.appliedHighWater.set(h.epoch, Math.max(high, meta.freshness));
    }
  }

  if (h.pendingInEpoch().length === 0) {
    if (state.status === 'loading')
      fail('I4.quiescence', 'status=loading with nothing in flight');
    if (state.operation !== 'idle')
      fail(
        'I4.quiescence',
        `operation=${state.operation} with nothing in flight`,
      );
  }

  if (state.status === 'ready' && state.canonicalAccess === null)
    fail('I5.ready', 'status=ready with canonicalAccess=null');

  if (state.plans) {
    const { annual, monthly, lifetime } = state.plans;
    if (annual || monthly || lifetime) {
      const selected =
        state.selectedPeriod === 'annual'
          ? annual
          : state.selectedPeriod === 'monthly'
            ? monthly
            : lifetime;
      if (!selected)
        fail(
          'I6.period',
          `selectedPeriod=${state.selectedPeriod} but that plan is null`,
        );
    }
  }

  const access = state.canonicalAccess;
  if (selectHasPremium(state) !== (access?.premium === true))
    fail('I7.selectors', 'selectHasPremium disagrees with snapshot');
  if (selectCanStartRating(state) !== (access?.canStartRating === true))
    fail('I7.selectors', 'selectCanStartRating disagrees with snapshot');
  if (
    selectPaywallRequired(state) !== (access === null || access.paywallRequired)
  )
    fail('I7.selectors', 'selectPaywallRequired disagrees with snapshot');

  const storeOps = h.pendingInEpoch('purchase', 'restore');
  if (storeOps.length > 1)
    fail(
      'I8.exclusivity',
      `${storeOps.length} store operations in flight: ${storeOps
        .map(c => `${c.kind}#${c.id}`)
        .join(',')}`,
    );
  const onlyOp = storeOps[0];
  if (storeOps.length === 1 && onlyOp && state.operation === 'idle')
    fail(
      'I8.exclusivity',
      `${onlyOp.kind}#${onlyOp.id} in flight but operation=idle`,
    );

  void ops;
  return found[0] ?? null;
}

export async function runScript(
  script: Action[],
  seed: number | null,
): Promise<RunResult> {
  clearAccessStoreConfiguration();
  const h = new Harness();
  const ops: OpHandle[] = [];
  const trace: TraceEntry[] = [];
  let opId = 0;

  const track = (kind: string, step: number, promise: Promise<unknown>) => {
    const handle: OpHandle = {
      id: ++opId,
      kind,
      step,
      settled: false,
      result: undefined,
    };
    ops.push(handle);
    promise.then(
      value => {
        handle.settled = true;
        handle.result = value;
      },
      error => {
        handle.settled = true;
        handle.result = `threw:${String(error)}`;
      },
    );
  };

  const record = (step: number, action: string) => {
    const s = useAccessStore.getState();
    const accessMeta = s.canonicalAccess
      ? h.snapshots.get(s.canonicalAccess)
      : undefined;
    trace.push({
      step,
      action,
      status: s.status,
      operation: s.operation,
      period: s.selectedPeriod,
      plans: s.plans ? (h.plansById.get(s.plans) ?? -1) : null,
      access: s.canonicalAccess
        ? accessMeta
          ? `#${accessMeta.id}@e${accessMeta.epoch}`
          : 'foreign'
        : null,
      error: s.error?.code ?? null,
      pending: h.pending.map(c => `${c.kind}#${c.id}@e${c.epoch}`).join(' '),
      ops: ops
        .map(o => `${o.kind}#${o.id}=${o.settled ? String(o.result) : '…'}`)
        .join(' '),
    });
  };

  const perform = (action: Action, step: number): string => {
    const store = useAccessStore.getState();
    switch (action.kind) {
      case 'configure': {
        const deps =
          action.sameDeps && h.currentDeps ? h.currentDeps : h.makeDeps();
        h.currentDeps = deps;
        h.bumpEpoch();
        configureAccessStore(deps);
        return describeAction(action);
      }
      case 'clear':
        h.currentDeps = null;
        h.bumpEpoch();
        clearAccessStoreConfiguration();
        return 'clear';
      case 'reset':
        h.bumpEpoch();
        store.reset();
        return 'reset';
      case 'initialize':
        track('initialize', step, store.initialize());
        return 'initialize';
      case 'refreshAccess':
        track('refreshAccess', step, store.refreshAccess());
        return 'refreshAccess';
      case 'syncBilling':
        track('syncBilling', step, store.syncBilling());
        return 'syncBilling';
      case 'purchaseSelected':
        track('purchaseSelected', step, store.purchaseSelected());
        return 'purchaseSelected';
      case 'restorePurchases':
        track('restorePurchases', step, store.restorePurchases());
        return 'restorePurchases';
      case 'selectPeriod':
        store.selectPeriod(action.period);
        return describeAction(action);
      case 'clearError':
        store.clearError();
        return 'clearError';
      case 'settle':
        return h.settle(action.pick, action.outcome);
      case 'flush':
        return 'flush';
    }
  };

  let violation: Violation | null = null;
  let step = 0;
  const check = (label: string) => {
    const result = checkInvariants(h, useAccessStore.getState(), ops);
    if (result && !violation) violation = { ...result, step, action: label };
  };

  for (const action of script) {
    step += 1;
    const label = perform(action, step);
    await flush();
    record(step, label);
    check(label);
    if (violation) break;
  }

  // Drain: settle everything still pending with seed-derived outcomes so the
  // liveness property (I9) can be checked. Deterministic per seed.
  if (!violation) {
    const drain = mulberry32(((seed ?? 0) ^ 0x9e3779b9) >>> 0);
    let guard = 0;
    while (h.pending.length > 0 && guard < 500) {
      guard += 1;
      step += 1;
      const label = `drain:${h.settle(
        Math.floor(drain() * 64),
        outcome(drain),
      )}`;
      await flush();
      record(step, label);
      check(label);
      if (violation) break;
    }
    await flush();
    if (!violation) {
      const hung = ops.filter(o => !o.settled);
      if (hung.length > 0) {
        violation = {
          invariant: 'I9.liveness',
          step,
          action: 'drain',
          detail: `unsettled: ${hung.map(o => `${o.kind}#${o.id}@step${o.step}`).join(',')}`,
        };
      } else {
        step += 1;
        record(step, 'final');
        check('final');
      }
    }
  }

  clearAccessStoreConfiguration();
  return { seed, length: script.length, violation, trace, steps: step };
}

// ---------------------------------------------------------------------------
// ddmin over the action list
// ---------------------------------------------------------------------------

async function minimizeScript(
  script: Action[],
  seed: number,
  budget = 400,
): Promise<{ script: Action[]; runs: number }> {
  let current = script;
  let runs = 0;
  const fails = async (candidate: Action[]) => {
    runs += 1;
    return (await runScript(candidate, seed)).violation !== null;
  };
  let n = 2;
  while (current.length >= 2 && runs < budget) {
    const chunk = Math.ceil(current.length / n);
    let reduced = false;
    for (
      let start = 0;
      start < current.length && runs < budget;
      start += chunk
    ) {
      const complement = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (complement.length > 0 && (await fails(complement))) {
        current = complement;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(n * 2, current.length);
    }
  }
  return { script: current, runs };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

interface SeedRow {
  seed: number;
  length: number;
  steps: number;
  outcome: 'HELD' | 'BROKEN' | 'NONDETERMINISTIC';
  violation: Violation | null;
  minimized: { length: number; runs: number; script: string[] } | null;
}

const ITER = Number(process.env.STRESS_ITER ?? 300);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const REPLAY =
  process.env.STRESS_REPLAY !== undefined
    ? Number(process.env.STRESS_REPLAY)
    : null;
const OUT = process.env.STRESS_OUT;

function traceKey(result: RunResult): string {
  return JSON.stringify({ v: result.violation, t: result.trace });
}

describe('accessStore randomized seeded long-run', () => {
  jest.setTimeout(20 * 60 * 1000);

  it(`holds every invariant over ${REPLAY === null ? ITER : 1} seeded action sequences, deterministically`, async () => {
    const seeds =
      REPLAY !== null
        ? [REPLAY]
        : Array.from({ length: ITER }, (_, i) => BASE_SEED + i);
    const rows: SeedRow[] = [];
    let executedSteps = 0;

    for (const seed of seeds) {
      const script = generateScript(seed);
      const first = await runScript(script, seed);
      const second = await runScript(script, seed);
      executedSteps += first.steps + second.steps;
      const deterministic = traceKey(first) === traceKey(second);
      let row: SeedRow = {
        seed,
        length: script.length,
        steps: first.steps,
        outcome: !deterministic
          ? 'NONDETERMINISTIC'
          : first.violation
            ? 'BROKEN'
            : 'HELD',
        violation: first.violation,
        minimized: null,
      };
      if (row.outcome === 'BROKEN') {
        const { script: small, runs } = await minimizeScript(script, seed);
        const replay = await runScript(small, seed);
        row = {
          ...row,
          violation: replay.violation ?? first.violation,
          minimized: {
            length: small.length,
            runs,
            script: small.map(describeAction),
          },
        };
      }
      rows.push(row);
    }

    const summary = {
      unit: 'apps/mobile/src/state/accessStore.ts',
      lens: 'randomized-seeded',
      baseSeed: BASE_SEED,
      sequences: rows.length,
      executedSteps,
      held: rows.filter(r => r.outcome === 'HELD').length,
      broken: rows.filter(r => r.outcome === 'BROKEN').length,
      nondeterministic: rows.filter(r => r.outcome === 'NONDETERMINISTIC')
        .length,
      byInvariant: rows.reduce<Record<string, number>>((acc, r) => {
        if (r.violation)
          acc[r.violation.invariant] = (acc[r.violation.invariant] ?? 0) + 1;
        return acc;
      }, {}),
      rows,
    };
    if (OUT) {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify(summary, null, 2));
    }

    const failures = rows
      .filter(r => r.outcome !== 'HELD')
      .map(r => ({
        seed: r.seed,
        outcome: r.outcome,
        invariant: r.violation?.invariant,
        step: r.violation?.step,
        detail: r.violation?.detail,
        minimized: r.minimized?.script,
      }));
    expect(failures).toEqual([]);
    expect(rows.length).toBe(seeds.length);
  });
});
