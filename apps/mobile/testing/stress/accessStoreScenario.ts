/**
 * Scenario runner for the accessStore failure-injection harness: executes a
 * plan (faults + interleaved store operations + configuration cuts) against
 * the real `useAccessStore`, then evaluates the invariants in
 * `accessStoreFaults.ts`. Requires jest modern fake timers to be installed by
 * the calling suite (`jest.useFakeTimers()`); the 60s "no infinite spinner"
 * window is advanced with `jest.advanceTimersByTimeAsync`.
 */
import type {
  BillingPeriod,
  CanonicalAccessState,
} from '../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import type { AccessStoreState } from '../../src/state/accessStore';
import {
  buildEnvironment,
  checkCallCounts,
  checkInFlightInvariants,
  checkTerminalInvariants,
  dedupeViolations,
  flushMicrotasks,
  isRecord,
  paywallShowsRetry,
  serverAccess,
  track,
} from './accessStoreFaults';
import type {
  Environment,
  Fault,
  Seam,
  SettledOp,
  StoreOp,
  Violation,
} from './accessStoreFaults';

declare const jest: {
  advanceTimersByTimeAsync(ms: number): Promise<void>;
};

export type Step =
  | { kind: 'op'; op: StoreOp }
  | { kind: 'flush' }
  | { kind: 'advance'; ms: number }
  | { kind: 'reset' }
  | { kind: 'clear' }
  | { kind: 'reconfigure' }
  | { kind: 'select'; period: BillingPeriod }
  | { kind: 'clearError' }
  /** Server-side truth changes (a rating was scored elsewhere, a refund…). */
  | { kind: 'server'; premium: boolean; used: number; reserved: number };

export interface ScenarioPlan {
  faults: Fault[];
  /** Run a healthy `initialize()` (plans + access) before arming faults. */
  warmup: boolean;
  access: CanonicalAccessState;
  syncPremium: boolean;
  introOffering: boolean;
  sdkPreconfiguredFor: string | null;
  steps: Step[];
}

export interface ScenarioOutcome {
  observed: Record<string, unknown>;
  violations: Violation[];
}

export const SPINNER_WINDOW_MS = 60_000;

function snapshot(state: AccessStoreState): Record<string, unknown> {
  return {
    status: state.status,
    operation: state.operation,
    selectedPeriod: state.selectedPeriod,
    plans: state.plans
      ? {
          annual: state.plans.annual?.id ?? null,
          monthly: state.plans.monthly?.id ?? null,
          lifetime: state.plans.lifetime?.id ?? null,
        }
      : state.plans,
    canonicalAccess: state.canonicalAccess,
    error: state.error,
    showRetry: paywallShowsRetry(state),
  };
}

function groupFaults(faults: Fault[]): Map<Seam, Fault[]> {
  const grouped = new Map<Seam, Fault[]>();
  for (const fault of faults) {
    const list = grouped.get(fault.seam) ?? [];
    list.push(fault);
    grouped.set(fault.seam, list);
  }
  return grouped;
}

async function warmUp(env: Environment): Promise<void> {
  configureAccessStore(env.deps);
  await useAccessStore.getState().initialize();
  await flushMicrotasks();
}

export async function runScenario(
  plan: ScenarioPlan,
): Promise<ScenarioOutcome> {
  clearAccessStoreConfiguration();
  let env = buildEnvironment({
    faults: groupFaults(plan.faults),
    access: plan.access,
    syncPremium: plan.syncPremium,
    introOffering: plan.introOffering,
    sdkPreconfiguredFor: plan.sdkPreconfiguredFor,
  });
  const envs: Environment[] = [env];
  const violations: Violation[] = [];
  const ops: SettledOp[] = [];
  const started: Record<StoreOp, number> = {
    initialize: 0,
    refreshAccess: 0,
    syncBilling: 0,
    purchaseSelected: 0,
    restorePurchases: 0,
  };
  let initializeOverlappedOperation = false;
  let opsOverlapped = false;
  let purchaseCancelOverlapped = false;
  let resetOverlappedOperation = false;
  let userClearedError = false;
  const cancelPurchaseArmed = plan.faults.some(
    f =>
      f.seam === 'rc:purchasePackage' &&
      f.behaviour.kind === 'reject' &&
      isRecord(f.behaviour.error) &&
      (f.behaviour.error['userCancelled'] === true ||
        f.behaviour.error['code'] === '1'),
  );
  let cuts = 0;
  const armedIds = plan.faults.map(f => f.id);
  const slowTotalMs = plan.faults.reduce(
    (sum, f) => sum + (f.behaviour.kind === 'slow' ? f.behaviour.delayMs : 0),
    0,
  );
  // A chain of slow answers longer than the window is not a missing deadline
  // bug in the store; it is the same finding (no deadline) seen through a
  // longer wait, so it is classified with it rather than as a new failure.
  const hungFaults = plan.faults
    .filter(
      f =>
        f.hangs ||
        (slowTotalMs > SPINNER_WINDOW_MS && f.behaviour.kind === 'slow'),
    )
    .map(f => f.id);
  const directFaults = plan.faults.filter(f => f.seam.startsWith('direct:'));

  if (plan.warmup) {
    await warmUp(env);
  } else {
    configureAccessStore(env.deps);
  }
  const warmState = snapshot(useAccessStore.getState());
  env.arm();

  const store = useAccessStore.getState();
  const cut = (by: 'reset' | 'clear' | 'reconfigure') => {
    cuts += 1;
    for (const op of ops) {
      if (!op.settled) {
        op.cutWhilePending = true;
        op.cutBy ??= by;
      }
    }
  };

  const timeline: string[] = [];
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'op': {
        started[step.op] += 1;
        const isAction = (op: StoreOp) =>
          op === 'purchaseSelected' ||
          op === 'restorePurchases' ||
          op === 'syncBilling';
        const pending = ops.filter(o => !o.settled && !o.cutWhilePending);
        // reset() keeps the dependencies, so a re-tapped purchase/restore
        // reaches the same store while the cut call is still in flight.
        if (
          isAction(step.op) &&
          ops.some(o => !o.settled && o.cutBy === 'reset' && isAction(o.op))
        ) {
          resetOverlappedOperation = true;
        }
        // initialize() settling while an action is in flight (whichever
        // started first) is what erases the operation flag.
        if (
          (step.op === 'initialize' && pending.some(o => isAction(o.op))) ||
          (isAction(step.op) && pending.some(o => o.op === 'initialize'))
        ) {
          initializeOverlappedOperation = true;
        }
        if (pending.length > 0) {
          opsOverlapped = true;
          if (
            cancelPurchaseArmed &&
            (step.op === 'purchaseSelected' ||
              pending.some(o => o.op === 'purchaseSelected'))
          ) {
            purchaseCancelOverlapped = true;
          }
        }
        userClearedError = false;
        const promise: Promise<boolean | void> =
          step.op === 'initialize'
            ? store.initialize()
            : step.op === 'refreshAccess'
              ? store.refreshAccess()
              : step.op === 'syncBilling'
                ? store.syncBilling()
                : step.op === 'purchaseSelected'
                  ? store.purchaseSelected()
                  : store.restorePurchases();
        ops.push(track(step.op, promise));
        timeline.push(`op:${step.op}`);
        break;
      }
      case 'flush':
        await flushMicrotasks();
        timeline.push('flush');
        break;
      case 'advance':
        await jest.advanceTimersByTimeAsync(step.ms);
        await flushMicrotasks();
        timeline.push(`advance:${step.ms}`);
        break;
      case 'reset':
        store.reset();
        cut('reset');
        timeline.push('reset');
        break;
      case 'clear':
        clearAccessStoreConfiguration();
        cut('clear');
        timeline.push('clear');
        break;
      case 'reconfigure': {
        // A new account: fresh dependencies, fresh server truth.
        env = buildEnvironment({
          faults: new Map(),
          access: serverAccess(false, 0),
          syncPremium: false,
          armed: true,
        });
        envs.push(env);
        configureAccessStore(env.deps);
        cut('reconfigure');
        timeline.push('reconfigure');
        break;
      }
      case 'server':
        env.server.access = serverAccess(
          step.premium,
          step.used,
          step.reserved,
        );
        env.server.syncPremium = step.premium;
        timeline.push(
          `server:${step.premium ? 'premium' : 'free'}/${step.used}/${step.reserved}`,
        );
        break;
      case 'select':
        store.selectPeriod(step.period);
        timeline.push(`select:${step.period}`);
        break;
      case 'clearError':
        store.clearError();
        userClearedError = true;
        timeline.push('clearError');
        break;
    }
    // Only a settled view is meaningful here: `op` steps deliberately leave
    // microtasks unflushed so consecutive ops overlap, and a store `set` is
    // observable one tick before the op promise reports settled.
    if (step.kind === 'flush' || step.kind === 'advance') {
      violations.push(
        ...checkInFlightInvariants(
          useAccessStore.getState(),
          env,
          ops,
          initializeOverlappedOperation,
        ),
      );
    }
  }

  // Let everything that can settle, settle; then the spinner window.
  await flushMicrotasks();
  const afterSteps = snapshot(useAccessStore.getState());
  await jest.advanceTimersByTimeAsync(SPINNER_WINDOW_MS);
  await flushMicrotasks();
  const terminal = useAccessStore.getState();
  const terminalSnapshot = snapshot(terminal);
  const pendingAfter60s = ops.filter(o => !o.settled).map(o => o.op);
  violations.push(
    ...checkTerminalInvariants(terminal, env, ops, {
      hungFaults,
      directFaults,
      initializeOverlappedOperation,
      opsOverlapped,
      userClearedError,
      purchaseCancelOverlapped,
      resetOverlappedOperation,
    }),
    ...checkCallCounts(env, started),
  );

  // Release never-settling dependencies: the op must then settle and the
  // store must still be consistent (no state corruption from a late answer).
  // A released hang may unblock a chain that still contains slow answers,
  // so wait out every armed delay before judging the op settled.
  for (const e of envs) e.release();
  await flushMicrotasks();
  await jest.advanceTimersByTimeAsync(slowTotalMs + 1);
  await flushMicrotasks();
  const released = useAccessStore.getState();
  const stillPending = ops.filter(o => !o.settled).map(o => o.op);
  if (stillPending.length > 0) {
    violations.push({
      invariant: 'ops_settle_once_dependencies_answer',
      detail: `still pending after release: ${stillPending.join(',')}`,
    });
  }
  const releasedViolations = checkTerminalInvariants(released, env, ops, {
    hungFaults: [],
    directFaults,
    initializeOverlappedOperation,
    opsOverlapped,
    userClearedError,
    purchaseCancelOverlapped,
    resetOverlappedOperation,
  }).map(v => ({ ...v, invariant: `after_release.${v.invariant}` }));
  violations.push(...releasedViolations);

  clearAccessStoreConfiguration();

  return {
    observed: {
      warmState,
      afterSteps,
      terminal: terminalSnapshot,
      afterRelease: snapshot(released),
      pendingAfter60s,
      opResults: ops.map(o => ({
        op: o.op,
        settled: o.settled,
        result: o.result,
        cutWhilePending: o.cutWhilePending,
      })),
      timeline,
      calls: envs.flatMap(e =>
        e.calls.map(c => `${c.seam}${c.faultId ? `[${c.faultId}]` : ''}`),
      ),
      armedFaults: armedIds,
      cuts,
      servedAccessCount: env.servedAccess.length,
    },
    violations: dedupeViolations(violations),
  };
}
