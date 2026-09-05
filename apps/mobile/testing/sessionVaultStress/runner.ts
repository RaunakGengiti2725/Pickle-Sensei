/**
 * Executes one seeded scenario against the real vault module with the fake
 * native underneath, then hands the trace to the oracle.
 */
import type { PersistedSession } from '../../src/account/sessionVault';
import {
  type FakeKeychainNative,
  flushMicrotasks,
  seededRng,
} from './fakeKeychain';
import type { SeedRow } from './report';
import {
  type CallOutcome,
  type GeneratorOptions,
  type Scenario,
  UNDECODABLE_PASSWORD,
  generateScenario,
  judge,
} from './scenario';

// Node typings are excluded from the mobile tsconfig; only the two hooks the
// runner uses are declared (module-scoped, like testing/xcBehavioral).
declare const process: {
  on(event: 'unhandledRejection', listener: () => void): unknown;
  off(event: 'unhandledRejection', listener: () => void): unknown;
};

export interface VaultApi {
  savePersistedSession: (session: PersistedSession) => Promise<boolean>;
  loadPersistedSession: () => Promise<PersistedSession | null>;
  clearPersistedSession: () => Promise<void>;
}

export interface RunOptions extends GeneratorOptions {
  /** Per-iteration wall budget; exceeding it is an I8 violation. */
  wallBudgetMs: number;
  maxSteps: number;
}

export const VAULT_SERVICE = 'com.picklesensei.auth.session';

export async function runSeed(
  seed: number,
  native: FakeKeychainNative,
  vault: VaultApi,
  options: RunOptions,
): Promise<{ row: SeedRow; scenario: Scenario }> {
  const rng = seededRng(seed);
  const scenario = generateScenario(seed, rng, options);
  native.reset();
  native.configure({
    order: options.order,
    rng: seededRng(seed ^ 0x9e3779b9),
    faultRate: scenario.faultRate,
    maxBytes: Number.POSITIVE_INFINITY,
    failedSetDeletesFirst: true,
    corruptRead: undefined,
  });
  switch (scenario.initial.kind) {
    case 'empty':
      break;
    case 'valid':
      native.store.set(VAULT_SERVICE, {
        username: 'session',
        password: JSON.stringify(
          scenario.sessions[scenario.initial.sessionIndex],
        ),
        accessible: 'AccessibleAfterFirstUnlockThisDeviceOnly',
      });
      break;
    case 'malformed':
      native.store.set(VAULT_SERVICE, {
        username: 'session',
        password: scenario.initial.password,
        accessible: 'AccessibleAfterFirstUnlockThisDeviceOnly',
      });
      break;
    case 'no-password':
      // The item exists but the native cannot decode it as UTF-8: it hands
      // back an item with no `password` field (RNKeychainManager.m).
      native.store.set(VAULT_SERVICE, {
        username: 'session',
        password: UNDECODABLE_PASSWORD,
        accessible: 'AccessibleAfterFirstUnlockThisDeviceOnly',
      });
      native.configure({
        corruptRead: stored =>
          stored.password === UNDECODABLE_PASSWORD
            ? { password: undefined }
            : null,
      });
      break;
  }

  const outcomes: CallOutcome[] = scenario.calls.map(call => ({
    index: call.index,
    kind: call.kind,
    value: undefined,
    threw: false,
    settled: false,
    nativeId: null,
  }));
  const issueOrder: number[] = [];
  let unhandledRejections = 0;

  const children = new Map<number, number[]>();
  const burst: number[] = [];
  for (const call of scenario.calls) {
    const parent = call.afterCall;
    if (parent === undefined || scenario.calls[parent]!.abandoned) {
      burst.push(call.index);
    } else {
      const list = children.get(parent) ?? [];
      list.push(call.index);
      children.set(parent, list);
    }
  }

  const invoke = (index: number): Promise<void> => {
    const call = scenario.calls[index]!;
    issueOrder.push(index);
    const issuedBefore = native.issued;
    let promise: Promise<unknown>;
    try {
      if (call.kind === 'save') {
        promise = vault.savePersistedSession(
          scenario.sessions[call.sessionIndex!]!,
        );
      } else if (call.kind === 'load') {
        promise = vault.loadPersistedSession();
      } else {
        promise = vault.clearPersistedSession();
      }
    } catch (error) {
      outcomes[index]!.threw = true;
      outcomes[index]!.settled = true;
      outcomes[index]!.value = error;
      promise = Promise.resolve(undefined);
    }
    // The vault issues its one native call synchronously (before its first
    // await), so the call issued during the invoke is this API call's.
    if (native.issued === issuedBefore + 1) {
      outcomes[index]!.nativeId = issuedBefore;
    }
    const recorded = promise.then(
      value => {
        outcomes[index]!.value = value;
        outcomes[index]!.settled = true;
      },
      (error: unknown) => {
        outcomes[index]!.threw = true;
        outcomes[index]!.settled = true;
        outcomes[index]!.value = error;
      },
    );
    const chained = (children.get(index) ?? []).map(child =>
      recorded.then(() => invoke(child)),
    );
    return Promise.all([recorded, ...chained]).then(() => undefined);
  };

  const onUnhandled = (): void => {
    unhandledRejections += 1;
  };
  process.on('unhandledRejection', onUnhandled);
  const started = Date.now();
  let drainError: string | null = null;
  const all = Promise.all(burst.map(index => invoke(index)));
  let steps = 0;
  try {
    steps = await native.drain(options.maxSteps, options.wallBudgetMs);
    await Promise.race([all, flushMicrotasks().then(() => flushMicrotasks())]);
  } catch (error) {
    drainError = error instanceof Error ? error.message : String(error);
  } finally {
    await flushMicrotasks();
    process.off('unhandledRejection', onUnhandled);
  }
  const wallMs = Date.now() - started;

  const verdict = judge({
    scenario,
    issueOrder,
    outcomes,
    log: native.log,
    issuedNativeCalls: native.issued,
    finalStore: native.store.get(VAULT_SERVICE) ?? null,
    storeSize: native.store.size,
    wallMs,
    wallBudgetMs: options.wallBudgetMs,
    unhandledRejections,
  });
  if (drainError) {
    verdict.violated.push(`I8.deadlock:${drainError}`);
    verdict.defectClass = null;
  }

  const row: SeedRow = {
    seed,
    scenario: `${options.order}/${scenario.initial.kind}/${scenario.calls.length}calls`,
    inputs: {
      order: scenario.order,
      initial: scenario.initial,
      faultRate: scenario.faultRate,
      calls: scenario.calls.map(call => ({
        i: call.index,
        kind: call.kind,
        actor: call.actor,
        session: call.sessionIndex,
        after: call.afterCall,
        abandoned: call.abandoned,
      })),
    },
    observed: { ...verdict.observed, issueOrder, steps },
    violated: verdict.violated,
    verdict: verdict.violated.length === 0 ? 'HELD' : 'BROKEN',
    defectClass: verdict.defectClass,
    durationMs: wallMs,
  };
  return { row, scenario };
}
