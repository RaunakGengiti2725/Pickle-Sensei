/**
 * STRESS / CONCURRENCY — `src/state/accessStore.ts` (permits, free-rating
 * counts, stale snapshots, refresh races).
 *
 * A seeded scheduler drives the REAL store against fake billing dependencies
 * whose every call (`store.configure/loadPlans/purchase/restore`,
 * `backend.getAccess/syncBilling`) stays pending until the scheduler resolves
 * or rejects it. Each iteration is a script of atomic actions — call a store
 * method (two UI actors share the same account row: Settings focus and the
 * Analyze unmount cleanup), settle an arbitrary in-flight call, mutate the
 * server ledger (a scored shot consumed a rating, a permit was reserved or
 * released, a webhook granted premium), rotate the configuration
 * (`configureAccessStore` for another account), sign out
 * (`clearAccessStoreConfiguration`), or `reset()`. The script is derived from
 * the seed, so every iteration replays byte-for-byte:
 *
 *   cd apps/mobile && STRESS_SEED=<seed> npx jest --ci __tests__/stress/accessStoreConcurrency.stress.test.ts
 *
 * Server responses carry the ledger state AT ISSUE TIME (the server answers
 * the request when it arrives; only the delivery is reordered), so two
 * concurrent reads can legitimately return different snapshots and the store
 * must keep the newer one.
 *
 * Invariants (checked after every step and at quiescence):
 *   I1  liveness — every method promise settles, `status` leaves 'loading'
 *       and `operation` returns to 'idle' once nothing is in flight
 *   I2  no method promise rejects
 *   I3  mutual exclusion of the store-mutating operations — never more than
 *       one `store.purchase` / `store.restore` / `backend.syncBilling` in
 *       flight (a double tap can never double-purchase)
 *   I4  `initialize()` is idempotent while loading — never more than one
 *       `store.configure` / `store.loadPlans` in flight
 *   I5  premium is server-authoritative — `canonicalAccess.premium` only ever
 *       comes from a backend response, never from the store SDK result
 *   I6  identity isolation — `canonicalAccess` always belongs to the account
 *       the store is currently configured for; null when unconfigured
 *   I7  sign-out resets — while unconfigured, `canonicalAccess` and `plans`
 *       stay null and `status` is 'idle' or 'unconfigured'
 *   I8  freshness — at quiescence `canonicalAccess` reflects the LATEST-ISSUED
 *       backend response delivered to the current configuration (null when
 *       that response failed); an older snapshot must never overwrite a
 *       newer one
 *   I9  `initialize()` requested in this configuration ⇒ `plans` are loaded
 *       (or the load failed with an error) — a swallowed initialize leaves the
 *       paywall with no plans and a "Try again" button
 *
 * HELD invariants (I1, I2, I5, I6, I7) are plain `test`s. Invariants the
 * campaign found BROKEN on 1fb0efd7 (I3, I4, I8, I9) are pinned with
 * `test.failing`: the campaign-level pins assert the EXPECTED behaviour over
 * the default seed window, and each has a hand-minimized deterministic script
 * under "minimal deterministic reproductions". The fix must flip them to plain
 * `test`. Results (seed → outcome, violation categories, minimized scripts) are
 * written as JSON to `STRESS_OUT`
 * (default `<repo>/artifacts/stress/access-store-concurrency/`).
 *
 * Root causes (all in accessStore.ts):
 *   - `status` is one field shared by `initialize()` and `refreshAccess()`;
 *     the only initialize guard is `status === 'loading'`, and every
 *     refreshAccess outcome rewrites `status` → I4 (a refresh landing
 *     re-opens the guard) and I9 (a refresh in flight closes it).
 *   - `initialize()`'s final `set` writes `operation: 'idle'` unconditionally,
 *     releasing the purchase/restore/sync mutex while one is in flight → I3.
 *   - No response is sequenced: each `set` applies whatever landed last → I8.
 *
 * Scale: `STRESS_ITER` iterations (default 500, ~1 ms each);
 * `STRESS_SEED_BASE` shifts the seed window; `STRESS_SEED` replays one seed
 * (the campaign-level pins are skipped below 200 iterations or when replaying
 * a single seed — the minimal reproductions always run).
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import type { AccessStoreState } from '../../src/state/accessStore';

const ITERATIONS = Number(process.env.STRESS_ITER ?? 500);
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? 20260905_000);
const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const OUT_DIR =
  process.env.STRESS_OUT ??
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'artifacts',
    'stress',
    'access-store-concurrency',
  );
/** Upper bound for one iteration's promises to settle (I1). */
const SETTLE_TIMEOUT_MS = 2000;

// ─── Seeded PRNG (mulberry32) ───────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Script vocabulary ──────────────────────────────────────────────────────

type MethodName =
  | 'initialize'
  | 'refreshAccess'
  | 'syncBilling'
  | 'purchaseSelected'
  | 'restorePurchases';

type Actor = 'settings' | 'analyze';

type ServerMutation = 'consume' | 'reserve' | 'release' | 'grantPremium';

type Action =
  | { t: 'init' }
  | { t: 'refresh'; actor: Actor }
  | { t: 'purchase' }
  | { t: 'restore' }
  | { t: 'sync' }
  | { t: 'select'; period: 'annual' | 'monthly' | 'lifetime' }
  | { t: 'resolve'; pick: number }
  | { t: 'reject'; pick: number }
  | { t: 'server'; mut: ServerMutation }
  | { t: 'configure' }
  | { t: 'clear' }
  | { t: 'reset' }
  | { t: 'flush' };

const ACTION_WEIGHTS: ReadonlyArray<[number, (rng: () => number) => Action]> = [
  [10, () => ({ t: 'init' })],
  [18, rng => ({ t: 'refresh', actor: rng() < 0.5 ? 'settings' : 'analyze' })],
  [6, () => ({ t: 'purchase' })],
  [4, () => ({ t: 'restore' })],
  [5, () => ({ t: 'sync' })],
  [
    2,
    rng => ({
      t: 'select',
      period: (['annual', 'monthly', 'lifetime'] as const)[
        Math.floor(rng() * 3)
      ]!,
    }),
  ],
  [26, rng => ({ t: 'resolve', pick: Math.floor(rng() * 1000) })],
  [8, rng => ({ t: 'reject', pick: Math.floor(rng() * 1000) })],
  [
    8,
    rng => ({
      t: 'server',
      mut: (['consume', 'reserve', 'release', 'grantPremium'] as const)[
        Math.floor(rng() * 4)
      ]!,
    }),
  ],
  [2, () => ({ t: 'configure' })],
  [2, () => ({ t: 'clear' })],
  [1, () => ({ t: 'reset' })],
  [3, () => ({ t: 'flush' })],
];
const TOTAL_WEIGHT = ACTION_WEIGHTS.reduce((sum, [w]) => sum + w, 0);

function generateScript(seed: number): Action[] {
  const rng = mulberry32(seed);
  const steps = 8 + Math.floor(rng() * 24);
  const script: Action[] = [{ t: 'configure' }];
  for (let i = 0; i < steps; i += 1) {
    let roll = rng() * TOTAL_WEIGHT;
    for (const [weight, make] of ACTION_WEIGHTS) {
      roll -= weight;
      if (roll < 0) {
        script.push(make(rng));
        break;
      }
    }
  }
  return script;
}

// ─── Fake server + dependencies ─────────────────────────────────────────────

type CallKind =
  | 'configure'
  | 'loadPlans'
  | 'purchase'
  | 'restore'
  | 'getAccess'
  | 'syncBilling';

interface Ledger {
  seq: number;
  used: number;
  reserved: number;
  premium: boolean;
}

interface PendingCall {
  id: number;
  kind: CallKind;
  account: string;
  epoch: number;
  issuer: MethodName | 'unknown';
  /** Ledger state when the server processed the request (backend calls). */
  snapshot: Ledger | null;
  settled: 'pending' | 'resolved' | 'rejected';
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface Delivered {
  id: number;
  kind: 'getAccess' | 'syncBilling';
  issuer: MethodName | 'unknown';
  ok: boolean;
  seq: number;
  epoch: number;
}

const PLANS: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual-plan',
    productId: 'pickle_sensei_pro_yearly',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: {
    id: 'monthly-plan',
    productId: 'pickle_sensei_pro_monthly',
    period: 'monthly',
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  lifetime: {
    id: 'lifetime-plan',
    productId: 'pickle_sensei_pro_lifetime',
    period: 'lifetime',
    price: 159.99,
    priceString: '$159.99',
    pricePerMonthString: null,
    freeTrial: null,
  },
};

function accessFrom(
  account: string,
  callId: number,
  ledger: Ledger,
): CanonicalAccessState {
  const remaining = Math.max(0, 2 - ledger.used);
  const availableToReserve = Math.max(0, remaining - ledger.reserved);
  const canStartRating = ledger.premium || availableToReserve > 0;
  return {
    premium: ledger.premium,
    entitlements: [
      ...(ledger.premium ? ['pickle_sensei_pro'] : []),
      `acct:${account}`,
      `seq:${ledger.seq}`,
      `call:${callId}`,
      'src:backend',
    ],
    freeRatings: {
      limit: 2,
      used: ledger.used,
      reserved: ledger.reserved,
      remaining,
      availableToReserve,
    },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

function tag(access: CanonicalAccessState, prefix: string): string | null {
  const found = access.entitlements.find(entry =>
    entry.startsWith(`${prefix}:`),
  );
  return found ? found.slice(prefix.length + 1) : null;
}

interface Violation {
  invariant: string;
  category: string;
  step: number;
  detail: string;
}

interface MethodCall {
  method: MethodName;
  actor: Actor | null;
  step: number;
  epoch: number;
  settled: 'pending' | 'resolved' | 'rejected';
  value: unknown;
}

interface IterationResult {
  seed: number | null;
  scriptLength: number;
  steps: number;
  epochs: number;
  methodCalls: number;
  backendCalls: number;
  violations: Violation[];
  durationMs: number;
  trace: string[];
  /** Store state at quiescence, captured before the harness clears the store. */
  finalState: Pick<
    AccessStoreState,
    'status' | 'operation' | 'plans' | 'canonicalAccess' | 'error'
  >;
}

class Harness {
  private nextCallId = 1;
  private nextAccount = 0;
  private epoch = 0;
  private account: string | null = null;
  private readonly ledgers = new Map<string, Ledger>();
  private readonly pending: PendingCall[] = [];
  private readonly delivered: Delivered[] = [];
  private readonly methodCalls: MethodCall[] = [];
  private readonly promises: Promise<unknown>[] = [];
  private readonly violations: Violation[] = [];
  private readonly trace: string[] = [];
  private swallowedInitsInEpoch = 0;
  private issuer: MethodName | 'unknown' = 'unknown';
  private step = 0;
  private backendCallCount = 0;

  constructor(private readonly drainRng: () => number) {
    clearAccessStoreConfiguration();
  }

  // ── dependencies ──

  private ledgerFor(account: string): Ledger {
    let ledger = this.ledgers.get(account);
    if (!ledger) {
      ledger = { seq: 0, used: 0, reserved: 0, premium: false };
      this.ledgers.set(account, ledger);
    }
    return ledger;
  }

  private issue(kind: CallKind, account: string): Promise<unknown> {
    const ledger = this.ledgerFor(account);
    const call: PendingCall = {
      id: this.nextCallId++,
      kind,
      account,
      epoch: this.epoch,
      issuer: this.issuer,
      snapshot:
        kind === 'getAccess' || kind === 'syncBilling' ? { ...ledger } : null,
      settled: 'pending',
      resolve: () => undefined,
      reject: () => undefined,
    };
    if (call.snapshot) this.backendCallCount += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      call.resolve = resolve;
      call.reject = reject;
    });
    this.pending.push(call);
    this.trace.push(
      `  ↳ issued #${call.id} ${kind} by ${call.issuer} (seq ${ledger.seq})`,
    );
    return promise;
  }

  private dependenciesFor(account: string): BillingAccessDependencies {
    return {
      store: {
        configure: () => this.issue('configure', account) as Promise<void>,
        loadPlans: () =>
          this.issue('loadPlans', account) as Promise<StorePlans>,
        purchase: () =>
          this.issue('purchase', account) as Promise<{
            premium: boolean;
            productId: string | null;
            expirationDate: string | null;
          }>,
        restore: () =>
          this.issue('restore', account) as Promise<{
            premium: boolean;
            productId: string | null;
            expirationDate: string | null;
          }>,
        readEntitlement: async () => ({
          premium: false,
          productId: null,
          expirationDate: null,
        }),
      },
      backend: {
        getAccess: () =>
          this.issue('getAccess', account) as Promise<CanonicalAccessState>,
        syncBilling: () =>
          this.issue('syncBilling', account) as Promise<{
            billing: {
              premium: boolean;
              productKey: string | null;
              expiresAt: string | null;
              verifiedAt: string;
            };
            access: CanonicalAccessState;
          }>,
      },
    };
  }

  // ── settling calls ──

  private settle(call: PendingCall, ok: boolean): void {
    const index = this.pending.indexOf(call);
    if (index !== -1) this.pending.splice(index, 1);
    call.settled = ok ? 'resolved' : 'rejected';
    this.trace.push(
      `  ↳ ${ok ? 'resolved' : 'rejected'} #${call.id} ${call.kind}`,
    );
    if (call.kind === 'getAccess' || call.kind === 'syncBilling') {
      this.delivered.push({
        id: call.id,
        kind: call.kind,
        issuer: call.issuer,
        ok,
        seq: call.snapshot!.seq,
        epoch: call.epoch,
      });
    }
    if (!ok) {
      call.reject(new Error(`${call.kind} failed (#${call.id})`));
      return;
    }
    const ledger = this.ledgerFor(call.account);
    switch (call.kind) {
      case 'configure':
        call.resolve(undefined);
        return;
      case 'loadPlans':
        call.resolve(PLANS);
        return;
      case 'purchase':
      case 'restore':
        // The store SDK reports an entitlement; the server learns about it
        // through RevenueCat before the follow-up syncBilling is processed.
        if (!ledger.premium) {
          ledger.premium = true;
          ledger.seq += 1;
        }
        call.resolve({
          premium: true,
          productId: 'pickle_sensei_pro_yearly',
          expirationDate: '2027-09-05T00:00:00.000Z',
        });
        return;
      case 'getAccess':
        call.resolve(accessFrom(call.account, call.id, call.snapshot!));
        return;
      case 'syncBilling':
        call.resolve({
          billing: {
            premium: call.snapshot!.premium,
            productKey: call.snapshot!.premium
              ? 'pickle_sensei_pro_yearly'
              : null,
            expiresAt: call.snapshot!.premium
              ? '2027-09-05T00:00:00.000Z'
              : null,
            verifiedAt: '2026-09-05T00:00:00.000Z',
          },
          access: accessFrom(call.account, call.id, call.snapshot!),
        });
        return;
    }
  }

  private pickPending(pick: number): PendingCall | null {
    if (this.pending.length === 0) return null;
    return this.pending[pick % this.pending.length]!;
  }

  // ── store method invocation with attribution ──

  private invoke(method: MethodName, actor: Actor | null): void {
    const record: MethodCall = {
      method,
      actor,
      step: this.step,
      epoch: this.epoch,
      settled: 'pending',
      value: undefined,
    };
    this.methodCalls.push(record);
    if (method === 'initialize' && this.account !== null) {
      const before = useAccessStore.getState().status;
      const initInFlight = this.pending.some(
        call =>
          call.epoch === this.epoch &&
          (call.kind === 'configure' ||
            call.kind === 'loadPlans' ||
            call.issuer === 'initialize'),
      );
      if (before === 'loading' && !initInFlight) {
        this.swallowedInitsInEpoch += 1;
        this.trace.push(
          `  ↳ initialize() swallowed by a non-initialize 'loading' status`,
        );
      }
    }
    this.issuer = method;
    let promise: Promise<unknown>;
    try {
      promise = useAccessStore.getState()[method]();
    } catch (error) {
      promise = Promise.reject(error);
    } finally {
      this.issuer = 'unknown';
    }
    const tracked = promise.then(
      value => {
        record.settled = 'resolved';
        record.value = value;
      },
      error => {
        record.settled = 'rejected';
        record.value = error;
        this.violations.push({
          invariant: 'I2',
          category: `${method} rejected`,
          step: this.step,
          detail: String(error),
        });
      },
    );
    this.promises.push(tracked);
  }

  /** Which store method will continue when this call settles. */
  private static issuerAfter(call: PendingCall): MethodName | 'unknown' {
    return call.issuer;
  }

  // ── actions ──

  private async apply(action: Action): Promise<void> {
    switch (action.t) {
      case 'init':
        this.invoke('initialize', null);
        break;
      case 'refresh':
        this.invoke('refreshAccess', action.actor);
        break;
      case 'purchase':
        this.invoke('purchaseSelected', null);
        break;
      case 'restore':
        this.invoke('restorePurchases', null);
        break;
      case 'sync':
        this.invoke('syncBilling', null);
        break;
      case 'select':
        useAccessStore.getState().selectPeriod(action.period);
        break;
      case 'resolve':
      case 'reject': {
        const call = this.pickPending(action.pick);
        if (!call) break;
        this.issuer = Harness.issuerAfter(call);
        try {
          this.settle(call, action.t === 'resolve');
          await flush();
        } finally {
          this.issuer = 'unknown';
        }
        break;
      }
      case 'server': {
        if (this.account === null) break;
        const ledger = this.ledgerFor(this.account);
        switch (action.mut) {
          case 'consume':
            if (ledger.used < 2) {
              ledger.used += 1;
              ledger.reserved = Math.max(0, ledger.reserved - 1);
              ledger.seq += 1;
            }
            break;
          case 'reserve':
            if (ledger.reserved + ledger.used < 2) {
              ledger.reserved += 1;
              ledger.seq += 1;
            }
            break;
          case 'release':
            if (ledger.reserved > 0) {
              ledger.reserved -= 1;
              ledger.seq += 1;
            }
            break;
          case 'grantPremium':
            if (!ledger.premium) {
              ledger.premium = true;
              ledger.seq += 1;
            }
            break;
        }
        break;
      }
      case 'configure':
        this.epoch += 1;
        this.account = `A${this.nextAccount++}`;
        this.swallowedInitsInEpoch = 0;
        configureAccessStore(this.dependenciesFor(this.account));
        break;
      case 'clear':
        this.epoch += 1;
        this.account = null;
        this.swallowedInitsInEpoch = 0;
        clearAccessStoreConfiguration();
        break;
      case 'reset':
        this.epoch += 1;
        this.swallowedInitsInEpoch = 0;
        useAccessStore.getState().reset();
        break;
      case 'flush':
        break;
    }
    await flush();
  }

  // ── invariants ──

  private checkContinuous(): void {
    const state = useAccessStore.getState();
    // Calls issued under a previous configuration are dead to the store
    // (isCurrentConfiguration discards them); only live-epoch calls count.
    const live = this.pending.filter(call => call.epoch === this.epoch);
    const inFlight = (...kinds: CallKind[]) =>
      live.filter(call => kinds.includes(call.kind)).length;
    const liveList = live.map(call => `${call.kind}#${call.id}`).join(', ');

    const mutating = inFlight('purchase', 'restore', 'syncBilling');
    if (mutating > 1) {
      this.violations.push({
        invariant: 'I3',
        category: 'concurrent store-mutating calls',
        step: this.step,
        detail: `${mutating} of purchase/restore/syncBilling in flight: ${liveList}`,
      });
    }
    if (inFlight('configure') > 1 || inFlight('loadPlans') > 1) {
      this.violations.push({
        invariant: 'I4',
        category: 'duplicate initialize work',
        step: this.step,
        detail: liveList,
      });
    }
    const access = state.canonicalAccess;
    if (access) {
      if (tag(access, 'src') !== 'backend') {
        this.violations.push({
          invariant: 'I5',
          category: 'non-backend access snapshot',
          step: this.step,
          detail: JSON.stringify(access.entitlements),
        });
      }
      if (access.premium) {
        const backedByServer = this.delivered.some(
          entry =>
            entry.ok &&
            entry.epoch === this.epoch &&
            entry.id === Number(tag(access, 'call')),
        );
        if (!backedByServer) {
          this.violations.push({
            invariant: 'I5',
            category: 'premium without backend evidence',
            step: this.step,
            detail: JSON.stringify(access.entitlements),
          });
        }
      }
      if (this.account === null) {
        this.violations.push({
          invariant: 'I6',
          category: 'access present while unconfigured',
          step: this.step,
          detail: JSON.stringify(access.entitlements),
        });
      } else if (tag(access, 'acct') !== this.account) {
        this.violations.push({
          invariant: 'I6',
          category: 'access from another account',
          step: this.step,
          detail: `store shows ${tag(access, 'acct')}, configured ${this.account}`,
        });
      }
    }
    if (this.account === null) {
      if (
        state.plans !== null ||
        (state.status !== 'idle' && state.status !== 'unconfigured')
      ) {
        this.violations.push({
          invariant: 'I7',
          category: 'state survives sign-out',
          step: this.step,
          detail: `status=${state.status} plans=${state.plans ? 'set' : 'null'} operation=${state.operation}`,
        });
      }
    }
  }

  private checkQuiescent(): void {
    const state = useAccessStore.getState();
    if (state.status === 'loading' || state.operation !== 'idle') {
      this.violations.push({
        invariant: 'I1',
        category: 'stuck busy at quiescence',
        step: this.step,
        detail: `status=${state.status} operation=${state.operation}`,
      });
    }
    if (this.account === null) return;

    const current = this.delivered.filter(entry => entry.epoch === this.epoch);
    const latest = current.reduce<Delivered | null>(
      (best, entry) => (best === null || entry.id > best.id ? entry : best),
      null,
    );
    const access = state.canonicalAccess;
    if (latest === null) {
      if (access !== null) {
        this.violations.push({
          invariant: 'I8',
          category: 'access without any delivered response',
          step: this.step,
          detail: JSON.stringify(access.entitlements),
        });
      }
    } else if (latest.ok) {
      if (access === null) {
        // A failed older response (or a later purchase/restore verification
        // failure) nulled a newer successful snapshot.
        const holder = current
          .filter(entry => !entry.ok && entry.id < latest.id)
          .map(entry => `${entry.issuer}.${entry.kind}#${entry.id}`)
          .join(', ');
        this.violations.push({
          invariant: 'I8',
          category: `stale failure nulled newer snapshot`,
          step: this.step,
          detail: `latest ok response ${latest.issuer}.${latest.kind}#${latest.id} (seq ${latest.seq}); failures: ${holder}`,
        });
      } else {
        const shownSeq = Number(tag(access, 'seq'));
        const shownId = Number(tag(access, 'call'));
        if (shownSeq !== latest.seq) {
          const shown = current.find(entry => entry.id === shownId);
          this.violations.push({
            invariant: 'I8',
            category: `${shown?.issuer ?? '?'}.${shown?.kind ?? '?'} overwrote ${latest.issuer}.${latest.kind}`,
            step: this.step,
            detail: `shows #${shownId} seq ${shownSeq}; latest #${latest.id} seq ${latest.seq} (${shownSeq < latest.seq ? 'STALE' : 'newer-than-latest?'})`,
          });
        }
      }
    } else if (access !== null) {
      const shownId = Number(tag(access, 'call'));
      const shown = current.find(entry => entry.id === shownId);
      this.violations.push({
        invariant: 'I8',
        category: `${shown?.issuer ?? '?'}.${shown?.kind ?? '?'} survived newer failure of ${latest.issuer}.${latest.kind}`,
        step: this.step,
        detail: `shows #${shownId}; latest response #${latest.id} failed`,
      });
    }

    if (
      this.swallowedInitsInEpoch > 0 &&
      state.status === 'ready' &&
      state.plans === null
    ) {
      this.violations.push({
        invariant: 'I9',
        category: 'initialize swallowed by refreshAccess — ready without plans',
        step: this.step,
        detail: `${this.swallowedInitsInEpoch} initialize() call(s) returned early on refreshAccess's 'loading'; status=ready plans=null`,
      });
    }
  }

  // ── driver ──

  async run(script: Action[], seed: number | null): Promise<IterationResult> {
    const started = Date.now();
    for (const action of script) {
      this.step += 1;
      this.trace.push(`${this.step}. ${describeAction(action)}`);
      await this.apply(action);
      this.checkContinuous();
    }
    // Deterministic drain: settle whatever is still in flight.
    while (this.pending.length > 0) {
      this.step += 1;
      const pick = Math.floor(this.drainRng() * 1000);
      const ok = this.drainRng() < 0.8;
      const action: Action = ok
        ? { t: 'resolve', pick }
        : { t: 'reject', pick };
      this.trace.push(`${this.step}. [drain] ${describeAction(action)}`);
      await this.apply(action);
      this.checkContinuous();
    }
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      Promise.all(this.promises),
      new Promise<void>(resolve => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, SETTLE_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    await flush();
    if (timedOut) {
      const unsettled = this.methodCalls.filter(
        call => call.settled === 'pending',
      );
      this.violations.push({
        invariant: 'I1',
        category: 'method promise never settled',
        step: this.step,
        detail: unsettled.map(call => `${call.method}@${call.step}`).join(', '),
      });
    }
    this.checkQuiescent();
    const { status, operation, plans, canonicalAccess, error } =
      useAccessStore.getState();
    clearAccessStoreConfiguration();
    return {
      finalState: { status, operation, plans, canonicalAccess, error },
      seed,
      scriptLength: script.length,
      steps: this.step,
      epochs: this.epoch,
      methodCalls: this.methodCalls.length,
      backendCalls: this.backendCallCount,
      violations: this.violations,
      durationMs: Date.now() - started,
      trace: this.trace,
    };
  }
}

function describeAction(action: Action): string {
  switch (action.t) {
    case 'refresh':
      return `refreshAccess() from ${action.actor}`;
    case 'select':
      return `selectPeriod(${action.period})`;
    case 'resolve':
      return `resolve pending[${action.pick}]`;
    case 'reject':
      return `reject pending[${action.pick}]`;
    case 'server':
      return `server ${action.mut}`;
    case 'init':
      return 'initialize()';
    case 'purchase':
      return 'purchaseSelected()';
    case 'restore':
      return 'restorePurchases()';
    case 'sync':
      return 'syncBilling()';
    case 'configure':
      return 'configureAccessStore(next account)';
    case 'clear':
      return 'clearAccessStoreConfiguration()';
    case 'reset':
      return 'reset()';
    case 'flush':
      return 'flush';
  }
}

/** Drain every queued microtask (and one macrotask turn). */
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

async function runSeed(seed: number): Promise<IterationResult> {
  return new Harness(mulberry32(seed ^ 0x5eed)).run(generateScript(seed), seed);
}

async function runScript(
  script: Action[],
  drainSeed: number,
): Promise<IterationResult> {
  return new Harness(mulberry32(drainSeed ^ 0x5eed)).run(script, null);
}

/** Greedy 1-minimal reduction of a failing script for one violation category. */
async function minimize(
  script: Action[],
  drainSeed: number,
  invariant: string,
  category: string,
): Promise<Action[]> {
  const reproduces = async (candidate: Action[]) => {
    const result = await runScript(candidate, drainSeed);
    return result.violations.some(
      v => v.invariant === invariant && v.category === category,
    );
  };
  let current = script;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < current.length; i += 1) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      if (await reproduces(candidate)) {
        current = candidate;
        changed = true;
        i -= 1;
      }
    }
  }
  return current;
}

// ─── Campaign ───────────────────────────────────────────────────────────────

interface CategorySummary {
  invariant: string;
  category: string;
  count: number;
  seeds: number[];
  firstSeed: number;
  minimizedScript: Action[] | null;
  minimizedTrace: string[] | null;
}

interface Campaign {
  results: IterationResult[];
  categories: CategorySummary[];
  outFile: string;
}

const HELD = ['I1', 'I2', 'I5', 'I6', 'I7'];
const BROKEN = ['I3', 'I4', 'I8', 'I9'];
const pinBroken =
  ONLY_SEED === null && ITERATIONS >= 200 ? test.failing : test.skip;

let campaign: Campaign;

beforeAll(async () => {
  const seeds =
    ONLY_SEED !== null
      ? [ONLY_SEED]
      : Array.from({ length: ITERATIONS }, (_, i) => SEED_BASE + i);
  const results: IterationResult[] = [];
  for (const seed of seeds) results.push(await runSeed(seed));

  const byCategory = new Map<string, CategorySummary>();
  for (const result of results) {
    const seen = new Set<string>();
    for (const violation of result.violations) {
      const key = `${violation.invariant}|${violation.category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = byCategory.get(key) ?? {
        invariant: violation.invariant,
        category: violation.category,
        count: 0,
        seeds: [],
        firstSeed: result.seed!,
        minimizedScript: null,
        minimizedTrace: null,
      };
      entry.count += 1;
      if (entry.seeds.length < 25) entry.seeds.push(result.seed!);
      byCategory.set(key, entry);
    }
  }
  for (const entry of byCategory.values()) {
    const minimized = await minimize(
      generateScript(entry.firstSeed),
      entry.firstSeed,
      entry.invariant,
      entry.category,
    );
    entry.minimizedScript = minimized;
    entry.minimizedTrace = (await runScript(minimized, entry.firstSeed)).trace;
  }

  const categories = [...byCategory.values()].sort((a, b) => b.count - a.count);
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, `campaign-${SEED_BASE}-${seeds.length}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        unit: 'apps/mobile/src/state/accessStore.ts',
        lens: 'concurrency',
        seedBase: SEED_BASE,
        iterations: results.length,
        stepsExecuted: results.reduce((sum, r) => sum + r.steps, 0),
        methodCalls: results.reduce((sum, r) => sum + r.methodCalls, 0),
        backendCalls: results.reduce((sum, r) => sum + r.backendCalls, 0),
        durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
        heldInvariants: [...HELD, ...BROKEN].filter(
          inv => !categories.some(c => c.invariant === inv),
        ),
        brokenInvariants: [...new Set(categories.map(c => c.invariant))],
        categories,
        table: results.map(r => ({
          seed: r.seed,
          steps: r.steps,
          methodCalls: r.methodCalls,
          outcome: r.violations.length === 0 ? 'HELD' : 'VIOLATION',
          violations: [
            ...new Set(r.violations.map(v => `${v.invariant}: ${v.category}`)),
          ],
        })),
        ...(ONLY_SEED !== null ? { trace: results[0]!.trace } : {}),
      },
      null,
      2,
    ),
  );
  campaign = { results, categories, outFile };
}, 120_000);

function violationsOf(...invariants: string[]): string[] {
  return campaign.results.flatMap(result =>
    result.violations
      .filter(v => invariants.includes(v.invariant))
      .map(
        v => `seed ${result.seed}: ${v.invariant} ${v.category} — ${v.detail}`,
      ),
  );
}

describe('accessStore concurrency stress (seeded scheduler)', () => {
  test('campaign ran at scale and every iteration is replayable from its seed', async () => {
    expect(campaign.results.length).toBe(ONLY_SEED !== null ? 1 : ITERATIONS);
    const sample = campaign.results[0]!;
    const replay = await runSeed(sample.seed!);
    expect(replay.trace).toEqual(sample.trace);
    expect(replay.violations).toEqual(sample.violations);
  });

  test('I1 liveness — every promise settles and the store leaves loading/busy', () => {
    expect(violationsOf('I1')).toEqual([]);
  });

  test('I2 no store method ever rejects', () => {
    expect(violationsOf('I2')).toEqual([]);
  });

  test('I5 premium only ever comes from a backend response', () => {
    expect(violationsOf('I5')).toEqual([]);
  });

  test('I6 canonicalAccess always belongs to the configured account; null once signed out', () => {
    expect(violationsOf('I6')).toEqual([]);
  });

  test('I7 nothing survives sign-out while unconfigured', () => {
    expect(violationsOf('I7')).toEqual([]);
  });

  // BROKEN on 1fb0efd7 (pinned inverted; the fix flips these to plain `test`).
  pinBroken(
    'I3 no double purchase/restore/sync — mutating operations are mutually exclusive',
    () => {
      expect(violationsOf('I3')).toEqual([]);
    },
  );

  pinBroken(
    'I4 initialize() is idempotent while loading (one configure, one loadPlans)',
    () => {
      expect(violationsOf('I4')).toEqual([]);
    },
  );

  pinBroken(
    'I8 freshness — an older snapshot never overwrites a newer one',
    () => {
      expect(violationsOf('I8')).toEqual([]);
    },
  );

  pinBroken(
    'I9 an initialize() request is never swallowed by a refreshAccess() in flight',
    () => {
      expect(violationsOf('I9')).toEqual([]);
    },
  );
});

describe('minimal deterministic reproductions', () => {
  const settingsAccount: Action[] = [{ t: 'configure' }];

  test.failing(
    'I3: initialize() finishing mid-restore releases the operation mutex — a second Restore reaches the store',
    async () => {
      // Paywall: "Try again" (initialize) is loading; the Restore button is
      // only disabled by `operation`, so the user taps it; initialize lands and
      // writes operation:'idle'; the button re-enables; the user taps again.
      const script: Action[] = [
        ...settingsAccount,
        { t: 'init' }, // configure #1
        { t: 'restore' }, // store.restore #2, operation 'restoring'
        { t: 'resolve', pick: 0 }, // configure ok → getAccess #3 + loadPlans #4
        { t: 'resolve', pick: 1 }, // getAccess #3
        { t: 'resolve', pick: 1 }, // loadPlans #4 → initialize sets operation 'idle'
        { t: 'restore' }, // guard is open → store.restore #5 while #2 is in flight
      ];
      const result = await runScript(script, 1);
      expect(result.violations.filter(v => v.invariant === 'I3')).toEqual([]);
      expect(
        result.trace.filter(line => /issued #\d+ restore /.test(line)),
      ).toHaveLength(1);
    },
  );

  test.failing(
    'I4: a refreshAccess() landing while initialize() is loading re-opens the guard — initialize runs twice',
    async () => {
      const script: Action[] = [
        ...settingsAccount,
        { t: 'init' }, // configure #1, status 'loading'
        { t: 'refresh', actor: 'analyze' }, // getAccess #2
        { t: 'resolve', pick: 1 }, // #2 lands → status 'ready' (configure #1 still pending)
        { t: 'init' }, // guard sees 'ready' → configure #3
      ];
      const result = await runScript(script, 1);
      expect(result.violations.filter(v => v.invariant === 'I4')).toEqual([]);
      expect(
        result.trace.filter(line => /issued #\d+ configure /.test(line)),
      ).toHaveLength(1);
      expect(
        result.trace.filter(line => /issued #\d+ loadPlans /.test(line)),
      ).toHaveLength(1);
    },
  );

  test.failing(
    'I8: refresh reordering — the response issued first but delivered last wins',
    async () => {
      // Settings focus refresh is issued, a scored shot syncs (ledger moves),
      // Analyze's unmount refresh is issued, Analyze's response lands first.
      const script: Action[] = [
        ...settingsAccount,
        { t: 'refresh', actor: 'settings' }, // #1 getAccess, seq 0 (used 0)
        { t: 'server', mut: 'consume' }, // ledger: used 1, seq 1
        { t: 'refresh', actor: 'analyze' }, // #2 getAccess, seq 1 (used 1)
        { t: 'resolve', pick: 1 }, // deliver #2 first → used 1
        { t: 'resolve', pick: 0 }, // deliver #1 last → used 0 (stale)
      ];
      const result = await runScript(script, 1);
      expect(result.violations.filter(v => v.invariant === 'I8')).toEqual([]);
      expect(result.finalState.canonicalAccess?.freeRatings.used).toBe(1);
    },
  );

  test.failing(
    'I8: initialize() holds its access snapshot until loadPlans lands and then overwrites a newer refresh',
    async () => {
      const script: Action[] = [
        ...settingsAccount,
        { t: 'init' }, // configure
        { t: 'resolve', pick: 0 }, // configure ok → getAccess #2 (seq 0) + loadPlans #3
        { t: 'server', mut: 'consume' }, // seq 1
        { t: 'refresh', actor: 'analyze' }, // getAccess #4 (seq 1)
        { t: 'resolve', pick: 0 }, // #2 resolves (held by Promise.all)
        { t: 'resolve', pick: 1 }, // #4 resolves → store shows seq 1
        { t: 'resolve', pick: 0 }, // #3 loadPlans resolves → initialize sets seq 0
      ];
      const result = await runScript(script, 1);
      expect(result.violations.filter(v => v.invariant === 'I8')).toEqual([]);
    },
  );

  test.failing(
    'I8: a purchase verified premium is erased by a slower pre-purchase refresh',
    async () => {
      const script: Action[] = [
        ...settingsAccount,
        { t: 'init' },
        { t: 'resolve', pick: 0 }, // configure
        { t: 'resolve', pick: 0 }, // getAccess
        { t: 'resolve', pick: 0 }, // loadPlans → ready
        { t: 'refresh', actor: 'settings' }, // slow pre-purchase read (free)
        { t: 'purchase' }, // store.purchase
        { t: 'resolve', pick: 1 }, // purchase ok → server premium → syncBilling issued
        { t: 'resolve', pick: 1 }, // syncBilling → premium shown
        { t: 'resolve', pick: 0 }, // slow refresh lands → premium erased
      ];
      const result = await runScript(script, 1);
      expect(result.violations.filter(v => v.invariant === 'I8')).toEqual([]);
      expect(result.finalState.canonicalAccess?.premium).toBe(true);
    },
  );

  test.failing(
    'I9: initialize() while a refreshAccess() is loading is dropped and plans never load',
    async () => {
      const script: Action[] = [
        ...settingsAccount,
        { t: 'refresh', actor: 'settings' }, // status 'loading'
        { t: 'init' }, // swallowed by the loading guard
        { t: 'resolve', pick: 0 }, // refresh lands → status 'ready', plans null
      ];
      const result = await runScript(script, 1);
      expect(result.violations.filter(v => v.invariant === 'I9')).toEqual([]);
      expect(result.finalState.plans).not.toBeNull();
    },
  );

  test('HELD: two concurrent purchaseSelected() calls reach the store exactly once', async () => {
    const script: Action[] = [
      ...settingsAccount,
      { t: 'init' },
      { t: 'resolve', pick: 0 },
      { t: 'resolve', pick: 0 },
      { t: 'resolve', pick: 0 },
      { t: 'purchase' }, // store.purchase issued
      { t: 'purchase' }, // operation guard → false, nothing issued
      { t: 'restore' }, // operation guard → false
      { t: 'sync' }, // operation guard → false
      { t: 'resolve', pick: 0 }, // purchase ok → syncBilling issued
      { t: 'resolve', pick: 0 }, // syncBilling ok → premium
    ];
    const result = await runScript(script, 1);
    expect(result.violations).toEqual([]);
    expect(result.finalState.canonicalAccess?.premium).toBe(true);
    expect(result.finalState.operation).toBe('idle');
    expect(
      result.trace.filter(line => /issued #\d+ purchase /.test(line)),
    ).toHaveLength(1);
    expect(
      result.trace.filter(line => /issued #\d+ restore /.test(line)),
    ).toHaveLength(0);
    expect(
      result.trace.filter(line => /issued #\d+ syncBilling /.test(line)),
    ).toHaveLength(1);
  });

  test('HELD: sign-out during purchase verification never lands the old account snapshot', async () => {
    const script: Action[] = [
      ...settingsAccount,
      { t: 'init' },
      { t: 'resolve', pick: 0 },
      { t: 'resolve', pick: 0 },
      { t: 'resolve', pick: 0 },
      { t: 'purchase' },
      { t: 'resolve', pick: 0 }, // store purchase ok → syncBilling in flight
      { t: 'clear' },
      { t: 'resolve', pick: 0 }, // old account's syncBilling lands after sign-out
    ];
    const result = await runScript(script, 1);
    expect(result.violations).toEqual([]);
    expect(result.finalState.canonicalAccess).toBeNull();
    expect(result.finalState.status).toBe('idle');
  });

  test('HELD: rotating to another account discards every in-flight response of the previous one', async () => {
    const script: Action[] = [
      ...settingsAccount,
      { t: 'init' },
      { t: 'resolve', pick: 0 },
      { t: 'refresh', actor: 'analyze' },
      { t: 'configure' }, // account A1
      { t: 'init' },
      { t: 'resolve', pick: 0 },
      { t: 'resolve', pick: 0 },
      { t: 'resolve', pick: 0 },
      { t: 'resolve', pick: 0 },
      { t: 'resolve', pick: 0 },
      { t: 'resolve', pick: 0 },
    ];
    const result = await runScript(script, 1);
    expect(result.violations.filter(v => v.invariant === 'I6')).toEqual([]);
    const access = result.finalState.canonicalAccess;
    expect(access !== null && tag(access, 'acct') === 'A1').toBe(true);
  });
});
