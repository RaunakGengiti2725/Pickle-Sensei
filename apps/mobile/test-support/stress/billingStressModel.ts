/**
 * mod-billing stress — seeded action sequences + model-checked invariants.
 *
 * A sequence is a list of user actions (sign in / out, initialize, refresh,
 * purchase, restore, sync, select plan, clear error, reset, token rotation,
 * misconfiguration) interleaved with environment actions (settle the oldest /
 * newest / a random pending native or network call with a seeded outcome, or
 * settle everything at once). Every sequence is generated from one seed,
 * executed against the real accessStore + revenueCatClient + accessApi, and
 * the invariants below are checked after EVERY step. The trace is a pure
 * function of (seed, actions), which is what the determinism test pins.
 *
 * HARD invariants (a violation fails the suite):
 *   H1  operation mutex — `operation !== 'idle'` ⇔ exactly one entered,
 *       unresolved purchase/restore/sync of the current configuration, and it
 *       is of the matching kind. A second op while one is active returns
 *       false without touching state.
 *   H2  `status === 'loading'` ⇒ an initialize()/refreshAccess() of the
 *       current configuration is still in flight.
 *   H3  server authority — a non-null `canonicalAccess` deep-equals a VALID
 *       backend body that landed under the CURRENT configuration; so store
 *       (RevenueCat) success alone never unlocks, and nothing is inherited
 *       across sign-out / account switch / reset. Premium in particular is
 *       only ever a server-verified snapshot.
 *   H4  coherence — `canonicalAccess` satisfies the accessApi parse rules
 *       (limit 2, remaining = 2 - used, reserved ≤ remaining,
 *       availableToReserve = remaining - reserved, premium ⇔ 'premium'
 *       entitlement, canStartRating ⇔ premium ∨ availableToReserve > 0,
 *       paywallRequired = ¬canStartRating).
 *   H5  stale settlement — settling a call issued under an older
 *       configuration (deps or version) leaves the store state byte-identical.
 *   H6  operation semantics at resolution (current configuration only):
 *       purchase: true ⇔ store ok ∧ backend sync premium; cancellation ⇒
 *       result false, no error, no sync; store failure ⇒ purchase_failed, no
 *       sync; non-premium sync ⇒ backend_verification_pending + snapshot;
 *       failed sync ⇒ canonicalAccess null (fail closed).
 *       restore: mirror with restore_failed codes.
 *       syncBilling / refreshAccess: true ⇔ valid (premium for sync) body;
 *       failure ⇒ canonicalAccess null.
 *   H7  purchase preconditions — no plan / no canonical access / not idle ⇒
 *       the store SDK is never asked to purchase; each entered purchase
 *       issues ≤ 1 purchasePackage, each restore ≤ 1 restorePurchases, and a
 *       backend sync is only ever issued by the active operation.
 *   H8  bearer binding — every backend request carries the CURRENT session's
 *       bearer for the SAME canonical user the deps were built for (never a
 *       previous account's token, never after sign-out).
 *   H9  unconfigured ⇒ fail closed — with no dependencies installed the
 *       store holds no access, no plans, operation idle.
 *   H10 plans ≠ null ⇒ the selected period has a plan.
 *   H11 liveness — after every pending call is settled the store is not
 *       `loading`, operation is idle, and every store promise resolved.
 *
 * OBSERVED invariants (recorded in the JSON table and reported; asserted
 * only when STRESS_STRICT=1 so the campaign's verdict stays honest without
 * turning a known, already-documented behaviour into a permanently red
 * suite — see __tests__/xcBehavioral/storesMatrix.test.ts accessStaleRefresh):
 *   F1  freshness — a snapshot from an OLDER-issued backend response must not
 *       replace one from a NEWER-issued response (stale refresh landing after
 *       a premium purchase/restore/sync regresses premium).
 *   F2  a failed OLDER-issued refresh must not clear a NEWER verified
 *       snapshot to null.
 *   F3  a store SDK purchase/restore sheet issued while the store is idle
 *       (a chain cut by reset/sign-out still reaching StoreKit).
 */
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
  type AccessStoreState,
} from '../../src/state/accessStore';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import type {
  BillingPeriod,
  CanonicalAccessState,
} from '../../src/billing/types';
import { randomInt, seededRandom } from '../../testing/xcBehavioral/evidence';
import {
  BillingStressWorld,
  accessSnapshotFor,
  outcomeFor,
  type PendingCall,
  type SettledCall,
} from './billingStressWorld';

// ─── Actions ───────────────────────────────────────────────────────────────

export type UserTag = 'A' | 'B';
export type BadConfig = 'noKey' | 'secretKey' | 'providerSubject' | 'noBaseUrl';

export type Action =
  | { t: 'signIn'; user: UserTag }
  | { t: 'signOut' }
  | { t: 'reset' }
  | { t: 'configureBad'; kind: BadConfig }
  | { t: 'rotateToken' }
  | { t: 'initialize' }
  | { t: 'refreshAccess' }
  | { t: 'syncBilling' }
  | { t: 'purchaseSelected' }
  | { t: 'restorePurchases' }
  | { t: 'selectPeriod'; period: BillingPeriod }
  | { t: 'clearError' }
  | {
      t: 'settle';
      which: 'oldest' | 'newest' | 'random';
      pick: number;
      roll: number;
    }
  | { t: 'settleAll'; roll: number }
  | { t: 'flush' };

export const MIN_LENGTH = 5;
export const MAX_LENGTH = 60;

const WEIGHTED: Array<[number, (r: () => number) => Action]> = [
  [3, r => ({ t: 'signIn', user: r() < 0.7 ? 'A' : 'B' })],
  [2, () => ({ t: 'signOut' })],
  [1, () => ({ t: 'reset' })],
  [
    1,
    r => ({
      t: 'configureBad',
      kind: (['noKey', 'secretKey', 'providerSubject', 'noBaseUrl'] as const)[
        randomInt(r, 0, 3)
      ]!,
    }),
  ],
  [2, () => ({ t: 'rotateToken' })],
  [5, () => ({ t: 'initialize' })],
  [4, () => ({ t: 'refreshAccess' })],
  [3, () => ({ t: 'syncBilling' })],
  [6, () => ({ t: 'purchaseSelected' })],
  [4, () => ({ t: 'restorePurchases' })],
  [
    2,
    r => ({
      t: 'selectPeriod',
      period: (['annual', 'monthly', 'lifetime'] as const)[randomInt(r, 0, 2)]!,
    }),
  ],
  [1, () => ({ t: 'clearError' })],
  [8, r => ({ t: 'settle', which: 'oldest', pick: r(), roll: r() })],
  [5, r => ({ t: 'settle', which: 'newest', pick: r(), roll: r() })],
  [6, r => ({ t: 'settle', which: 'random', pick: r(), roll: r() })],
  [3, r => ({ t: 'settleAll', roll: r() })],
  [1, () => ({ t: 'flush' })],
];
const TOTAL_WEIGHT = WEIGHTED.reduce((sum, [w]) => sum + w, 0);

export function generateSequence(seed: number): Action[] {
  const random = seededRandom(seed);
  const length = randomInt(random, MIN_LENGTH, MAX_LENGTH);
  const actions: Action[] = [];
  // Almost every sequence starts signed in so the interesting flows are
  // reachable; the rest exercise the unconfigured surface first.
  if (random() < 0.9) actions.push({ t: 'signIn', user: 'A' });
  while (actions.length < length) {
    let pick = random() * TOTAL_WEIGHT;
    for (const [weight, make] of WEIGHTED) {
      pick -= weight;
      if (pick < 0) {
        actions.push(make(random));
        break;
      }
    }
  }
  return actions;
}

// ─── Model ─────────────────────────────────────────────────────────────────

export const USERS: Record<UserTag, string> = {
  A: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  B: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const API_BASE_URL = 'https://api.test';
const PUBLIC_KEY = 'appl_test_public_key';

type OpKind =
  | 'initialize'
  | 'refreshAccess'
  | 'syncBilling'
  | 'purchaseSelected'
  | 'restorePurchases';

interface TrackedCall {
  kind: OpKind;
  step: number;
  gen: number;
  entered: boolean;
  resolved: boolean;
  checked: boolean;
  result: unknown;
  rejected: unknown;
  storeIssued: number;
  storeOutcome: string | null;
  syncIssued: number;
  syncOutcome: string | null;
  accessIssued: number;
  accessOutcome: string | null;
}

interface Landed {
  snapshot: CanonicalAccessState;
  issuedStep: number;
  settledStep: number;
  seq: number;
}

export interface StateSnapshot {
  status: AccessStoreState['status'];
  operation: AccessStoreState['operation'];
  plans: string[] | null;
  selectedPeriod: BillingPeriod;
  canonicalAccess: CanonicalAccessState | null;
  error: AccessStoreState['error'];
}

export interface Violation {
  step: number;
  invariant: string;
  detail: string;
}

export interface TraceStep {
  step: number;
  action: Action | { t: 'drain'; roll: number } | { t: 'final' };
  settled: SettledCall[];
  pendingAfter: string[];
  state: StateSnapshot;
  resolved: Array<{ kind: OpKind; step: number; result: unknown }>;
  violations: Violation[];
  observed: Violation[];
}

export interface RunResult {
  seed: number;
  length: number;
  actions: Action[];
  trace: TraceStep[];
  violations: Violation[];
  observed: Violation[];
  hung: boolean;
  callsIssued: number;
  callsSettled: number;
  opsEntered: number;
}

export function snapshotState(): StateSnapshot {
  const s = useAccessStore.getState();
  return {
    status: s.status,
    operation: s.operation,
    plans: s.plans
      ? (['annual', 'monthly', 'lifetime'] as const)
          .filter(p => s.plans![p] !== null)
          .map(p => `${p}:${s.plans![p]!.productId}`)
      : null,
    selectedPeriod: s.selectedPeriod,
    canonicalAccess: s.canonicalAccess,
    error: s.error,
  };
}

function coherent(a: CanonicalAccessState): string | null {
  const f = a.freeRatings;
  if (f.limit !== 2) return 'limit';
  if (f.remaining !== 2 - f.used) return 'remaining';
  if (f.reserved < 0 || f.reserved > f.remaining) return 'reserved';
  if (f.availableToReserve !== f.remaining - f.reserved) return 'available';
  if (a.premium !== a.entitlements.includes('premium'))
    return 'premium/entitlement';
  const canStart = a.premium || f.availableToReserve > 0;
  if (a.canStartRating !== canStart) return 'canStartRating';
  if (a.paywallRequired !== !canStart) return 'paywallRequired';
  return null;
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Resets every global the unit touches. Call between sequences. */
export function resetBillingGlobals(): void {
  clearAccessStoreConfiguration();
  clearApiSession();
  setApiUnauthorizedListener(null);
}

class Model {
  readonly world = new BillingStressWorld();
  readonly tracked: TrackedCall[] = [];
  readonly landed: Landed[] = [];
  readonly violations: Violation[] = [];
  readonly observed: Violation[] = [];
  private landedSeq = 0;
  private tokenSeq = 0;
  private currentUser: UserTag | null = null;
  private depsInstalled = false;
  /** false when the installed deps cannot reach the backend at all (no base
   * URL, or a canonical id no session token can ever be resolved for). */
  private backendConfigured = false;
  private displayed: {
    value: CanonicalAccessState;
    issuedStep: number;
  } | null = null;
  private pendingRefresh: TrackedCall | null = null;
  unauthorizedReports = 0;

  constructor() {
    this.world.onIssued = call => this.attribute(call);
    setApiUnauthorizedListener(() => {
      this.unauthorizedReports += 1;
    });
  }

  private cut(): void {
    this.world.gen += 1;
    this.landed.length = 0;
    this.displayed = null;
  }

  private activeOp(): TrackedCall | null {
    const active = this.tracked.filter(
      t =>
        t.entered &&
        !t.resolved &&
        t.gen === this.world.gen &&
        (t.kind === 'purchaseSelected' ||
          t.kind === 'restorePurchases' ||
          t.kind === 'syncBilling'),
    );
    return active[0] ?? null;
  }

  private attribute(call: PendingCall): void {
    const fifo = (kind: OpKind) =>
      this.tracked.find(
        t => t.kind === kind && t.entered && !t.resolved && t.storeIssued === 0,
      ) ?? null;
    switch (call.kind) {
      case 'sdk.purchasePackage': {
        const owner = fifo('purchaseSelected');
        if (owner) {
          owner.storeIssued += 1;
          call.owner = owner;
        } else {
          this.violations.push({
            step: this.world.step,
            invariant: 'H7',
            detail:
              'purchasePackage issued with no entered purchase awaiting it',
          });
        }
        if (useAccessStore.getState().operation === 'idle') {
          this.observed.push({
            step: this.world.step,
            invariant: 'F3',
            detail:
              'purchasePackage reached the store SDK while operation is idle',
          });
        }
        break;
      }
      case 'sdk.restorePurchases': {
        const owner = fifo('restorePurchases');
        if (owner) {
          owner.storeIssued += 1;
          call.owner = owner;
        } else {
          this.violations.push({
            step: this.world.step,
            invariant: 'H7',
            detail:
              'restorePurchases issued with no entered restore awaiting it',
          });
        }
        if (useAccessStore.getState().operation === 'idle') {
          this.observed.push({
            step: this.world.step,
            invariant: 'F3',
            detail:
              'restorePurchases reached the store SDK while operation is idle',
          });
        }
        break;
      }
      case 'http.syncBilling': {
        const owner = this.activeOp();
        if (owner) {
          owner.syncIssued += 1;
          call.owner = owner;
          if (owner.syncIssued > 1) {
            this.violations.push({
              step: this.world.step,
              invariant: 'H7',
              detail: `${owner.kind}@${owner.step} issued a second backend sync`,
            });
          }
        } else {
          this.violations.push({
            step: this.world.step,
            invariant: 'H7',
            detail: 'backend sync issued with no active operation',
          });
        }
        break;
      }
      case 'http.getAccess': {
        if (this.pendingRefresh) {
          this.pendingRefresh.accessIssued += 1;
          call.owner = this.pendingRefresh;
        }
        break;
      }
      default:
        break;
    }
  }

  /** Registers a store call BEFORE it is invoked so calls the store issues
   * synchronously (refresh → getAccess, sync → syncBilling) can be attributed
   * to it; `entered` is provisional until `attach` fixes it. */
  private begin(kind: OpKind, entered: boolean): TrackedCall {
    const t: TrackedCall = {
      kind,
      step: this.world.step,
      gen: this.world.gen,
      entered,
      resolved: false,
      checked: false,
      result: undefined,
      rejected: undefined,
      storeIssued: 0,
      storeOutcome: null,
      syncIssued: 0,
      syncOutcome: null,
      accessIssued: 0,
      accessOutcome: null,
    };
    this.tracked.push(t);
    return t;
  }

  private attach(t: TrackedCall, entered: boolean, promise: Promise<unknown>) {
    t.entered = entered;
    promise.then(
      value => {
        t.resolved = true;
        t.result = value;
      },
      error => {
        t.resolved = true;
        t.rejected = error ?? new Error('rejected with undefined');
      },
    );
  }

  private signIn(user: UserTag): void {
    this.tokenSeq += 1;
    establishApiSession({
      apiBaseUrl: API_BASE_URL,
      bearerToken: `tok-${user}-${this.tokenSeq}`,
      canonicalAppUserId: USERS[user],
      provider: 'apple',
    });
    this.cut();
    const { deps } = this.world.makeDeps({
      canonicalAppUserId: USERS[user],
      revenueCatPublicSdkKey: PUBLIC_KEY,
      apiBaseUrl: API_BASE_URL,
    });
    configureAccessStore(deps);
    this.currentUser = user;
    this.depsInstalled = true;
    this.backendConfigured = true;
  }

  private configureBad(kind: BadConfig): void {
    this.tokenSeq += 1;
    establishApiSession({
      apiBaseUrl: API_BASE_URL,
      bearerToken: `tok-A-${this.tokenSeq}`,
      canonicalAppUserId: USERS.A,
      provider: 'apple',
    });
    this.cut();
    const { deps } = this.world.makeDeps({
      canonicalAppUserId:
        kind === 'providerSubject' ? '001234.9f8e7d6c5b4a.0987' : USERS.A,
      revenueCatPublicSdkKey:
        kind === 'noKey'
          ? null
          : kind === 'secretKey'
            ? 'sk_secret'
            : PUBLIC_KEY,
      apiBaseUrl: kind === 'noBaseUrl' ? null : API_BASE_URL,
    });
    configureAccessStore(deps);
    this.currentUser = 'A';
    this.depsInstalled = true;
    this.backendConfigured = kind === 'noKey' || kind === 'secretKey';
  }

  private signOut(): void {
    clearApiSession();
    this.cut();
    this.world.currentDepsId = 0;
    clearAccessStoreConfiguration();
    this.currentUser = null;
    this.depsInstalled = false;
    this.backendConfigured = false;
  }

  private settleOne(call: PendingCall, roll: number): SettledCall {
    const outcome = outcomeFor(call.kind, roll);
    const owner = call.owner as TrackedCall | null;
    if (owner) {
      if (
        call.kind === 'sdk.purchasePackage' ||
        call.kind === 'sdk.restorePurchases'
      ) {
        owner.storeOutcome = outcome;
      } else if (call.kind === 'http.syncBilling') {
        owner.syncOutcome = outcome;
      } else if (call.kind === 'http.getAccess') {
        owner.accessOutcome = outcome;
      }
    }
    const record = this.world.settle(call, outcome);
    if (!record.stale) {
      const snapshot =
        call.kind === 'http.getAccess' || call.kind === 'http.syncBilling'
          ? accessSnapshotFor(outcome)
          : null;
      if (snapshot) {
        this.landed.push({
          snapshot,
          issuedStep: call.issuedStep,
          settledStep: this.world.step,
          seq: ++this.landedSeq,
        });
      }
    }
    return record;
  }

  async apply(action: Action): Promise<SettledCall[]> {
    const settled: SettledCall[] = [];
    const store = useAccessStore.getState();
    switch (action.t) {
      case 'signIn':
        this.signIn(action.user);
        break;
      case 'signOut':
        this.signOut();
        break;
      case 'reset':
        this.cut();
        store.reset();
        break;
      case 'configureBad':
        this.configureBad(action.kind);
        break;
      case 'rotateToken': {
        const session = getApiSession();
        if (session) {
          this.tokenSeq += 1;
          establishApiSession({
            ...session,
            bearerToken: `tok-${this.currentUser ?? 'X'}-${this.tokenSeq}`,
          });
        }
        break;
      }
      case 'initialize': {
        const before = store.status;
        const t = this.begin('initialize', false);
        const p = store.initialize();
        this.attach(
          t,
          this.depsInstalled &&
            before !== 'loading' &&
            useAccessStore.getState().status === 'loading',
          p,
        );
        break;
      }
      case 'refreshAccess': {
        const t = this.begin('refreshAccess', this.depsInstalled);
        this.pendingRefresh = t;
        const p = store.refreshAccess();
        this.pendingRefresh = null;
        this.attach(t, this.depsInstalled, p);
        break;
      }
      case 'syncBilling':
      case 'purchaseSelected':
      case 'restorePurchases': {
        const opBefore = store.operation;
        const stateBefore = snapshotState();
        const t = this.begin(
          action.t,
          opBefore === 'idle' && this.depsInstalled,
        );
        const p = store[action.t]();
        const expectedOp =
          action.t === 'syncBilling'
            ? 'syncing'
            : action.t === 'purchaseSelected'
              ? 'purchasing'
              : 'restoring';
        const entered =
          opBefore === 'idle' &&
          useAccessStore.getState().operation === expectedOp;
        this.attach(t, entered, p);
        if (opBefore !== 'idle') {
          // H1: a concurrent operation bounces without touching state.
          const after = snapshotState();
          if (!same(stateBefore, after)) {
            this.violations.push({
              step: this.world.step,
              invariant: 'H1',
              detail: `${action.t} while ${opBefore} mutated state`,
            });
          }
          t.checked = true;
          p.then(value => {
            if (value !== false) {
              this.violations.push({
                step: this.world.step,
                invariant: 'H1',
                detail: `${action.t} while ${opBefore} resolved ${String(value)}`,
              });
            }
          });
        } else if (
          !entered &&
          action.t === 'purchaseSelected' &&
          this.depsInstalled
        ) {
          // H7: refused purchase must explain itself and never reach the SDK.
          const s = useAccessStore.getState();
          const plan = s.plans?.[s.selectedPeriod] ?? null;
          if (plan && s.canonicalAccess) {
            this.violations.push({
              step: this.world.step,
              invariant: 'H7',
              detail:
                'purchase refused although a plan and canonical access exist',
            });
          }
          if (!s.error) {
            this.violations.push({
              step: this.world.step,
              invariant: 'H7',
              detail: 'purchase refused without an error state',
            });
          }
        }
        break;
      }
      case 'selectPeriod':
        store.selectPeriod(action.period);
        break;
      case 'clearError':
        store.clearError();
        break;
      case 'settle': {
        const pending = this.world.pending;
        if (pending.length === 0) break;
        const index =
          action.which === 'oldest'
            ? 0
            : action.which === 'newest'
              ? pending.length - 1
              : Math.min(
                  pending.length - 1,
                  Math.floor(action.pick * pending.length),
                );
        settled.push(this.settleOne(pending[index]!, action.roll));
        break;
      }
      case 'settleAll': {
        const calls = [...this.world.pending];
        let roll = action.roll;
        for (const call of calls) {
          settled.push(this.settleOne(call, roll));
          roll = (roll * 9301 + 0.49297) % 1;
        }
        break;
      }
      case 'flush':
        break;
    }
    return settled;
  }

  /** Runs after every step's flush. */
  check(
    settled: SettledCall[],
    stateBefore: StateSnapshot,
    multiSettle: boolean,
  ) {
    const step = this.world.step;
    const state = snapshotState();
    const s = useAccessStore.getState();
    const gen = this.world.gen;
    const fail = (invariant: string, detail: string) =>
      this.violations.push({ step, invariant, detail });
    const observe = (invariant: string, detail: string) =>
      this.observed.push({ step, invariant, detail });

    // H5 — only stale calls settled ⇒ nothing may have changed.
    if (
      settled.length > 0 &&
      settled.every(r => r.stale) &&
      !same(stateBefore, state)
    ) {
      fail(
        'H5',
        `stale settlement (${settled.map(r => `${r.kind}:${r.outcome}`).join(',')}) mutated state: ${JSON.stringify(stateBefore)} → ${JSON.stringify(state)}`,
      );
    }

    // H1 — operation mutex.
    const activeOps = this.tracked.filter(
      t =>
        t.entered &&
        !t.resolved &&
        t.gen === gen &&
        (t.kind === 'purchaseSelected' ||
          t.kind === 'restorePurchases' ||
          t.kind === 'syncBilling'),
    );
    if (activeOps.length > 1) {
      fail('H1', `${activeOps.length} operations active at once`);
    }
    if (state.operation !== 'idle') {
      const expectedKind =
        state.operation === 'purchasing'
          ? 'purchaseSelected'
          : state.operation === 'restoring'
            ? 'restorePurchases'
            : 'syncBilling';
      if (activeOps.length !== 1 || activeOps[0]!.kind !== expectedKind) {
        fail(
          'H1',
          `operation=${state.operation} but active ops = [${activeOps.map(t => t.kind).join(',')}]`,
        );
      }
    } else if (activeOps.length === 1) {
      fail(
        'H1',
        `operation idle while ${activeOps[0]!.kind}@${activeOps[0]!.step} is in flight`,
      );
    }

    // H2 — loading implies a live initialize/refresh.
    if (state.status === 'loading') {
      const live = this.tracked.some(
        t =>
          t.entered &&
          !t.resolved &&
          t.gen === gen &&
          (t.kind === 'initialize' || t.kind === 'refreshAccess'),
      );
      if (!live)
        fail('H2', 'status loading with no initialize/refresh in flight');
    }

    // H3 / H4 — server authority + coherence.
    if (state.canonicalAccess) {
      const match = this.landed.filter(l =>
        same(l.snapshot, state.canonicalAccess),
      );
      if (match.length === 0) {
        fail(
          'H3',
          `canonicalAccess ${JSON.stringify(state.canonicalAccess)} matches no valid backend body of the current configuration`,
        );
      }
      const why = coherent(state.canonicalAccess);
      if (why) fail('H4', `canonicalAccess incoherent: ${why}`);
      // F1 — freshness (observed). `displayed.issuedStep` is the newest
      // request whose body equals what the store shows.
      const bestIssued = match.reduce((m, l) => Math.max(m, l.issuedStep), -1);
      if (same(this.displayed?.value ?? null, state.canonicalAccess)) {
        if (this.displayed) {
          this.displayed.issuedStep = Math.max(
            this.displayed.issuedStep,
            bestIssued,
          );
        }
      } else {
        if (
          this.displayed &&
          match.length > 0 &&
          bestIssued < this.displayed.issuedStep
        ) {
          observe(
            'F1',
            `snapshot issued@${bestIssued} (premium=${state.canonicalAccess.premium}) replaced snapshot issued@${this.displayed.issuedStep} (premium=${this.displayed.value.premium})`,
          );
        }
        this.displayed = {
          value: state.canonicalAccess,
          issuedStep: bestIssued,
        };
      }
    } else {
      // F2 — an OLDER failed refresh clearing a NEWER snapshot (observed).
      if (this.displayed && stateBefore.canonicalAccess && !multiSettle) {
        const clearing = settled.find(
          r =>
            !r.stale &&
            r.kind === 'http.getAccess' &&
            accessSnapshotFor(r.outcome) === null &&
            r.issuedStep < this.displayed!.issuedStep,
        );
        if (clearing) {
          observe(
            'F2',
            `getAccess issued@${clearing.issuedStep} failed (${clearing.outcome}) and cleared snapshot issued@${this.displayed.issuedStep} (premium=${this.displayed.value.premium})`,
          );
        }
      }
      this.displayed = null;
    }

    // H8 — bearer binding (recorded by the fetch seam at issue time).
    while (this.world.bearerViolations.length > 0) {
      const v = this.world.bearerViolations.shift()!;
      fail(
        'H8',
        `${v.kind} sent token=${v.sentToken} for deps user=${v.depsUser} while session user=${v.sessionUser} token=${v.sessionToken}`,
      );
    }
    while (this.world.unexpectedRequests.length > 0) {
      fail('H8', `unexpected request ${this.world.unexpectedRequests.shift()}`);
    }

    // H9 — unconfigured ⇒ fail closed.
    if (!this.depsInstalled) {
      if (
        state.canonicalAccess !== null ||
        state.plans !== null ||
        state.operation !== 'idle'
      ) {
        fail(
          'H9',
          `no dependencies installed but state=${JSON.stringify(state)}`,
        );
      }
      if (state.status !== 'idle' && state.status !== 'unconfigured') {
        fail('H9', `no dependencies installed but status=${state.status}`);
      }
    }

    // H10 — selected period has a plan.
    if (s.plans && !s.plans[s.selectedPeriod]) {
      fail(
        'H10',
        `selectedPeriod=${s.selectedPeriod} has no plan in ${JSON.stringify(state.plans)}`,
      );
    }

    // H6 — semantics of freshly resolved operations.
    const resolved: TraceStep['resolved'] = [];
    for (const t of this.tracked) {
      if (!t.resolved || t.checked) continue;
      t.checked = true;
      resolved.push({
        kind: t.kind,
        step: t.step,
        result: t.rejected ? 'REJECTED' : t.result,
      });
      if (t.rejected) {
        fail(
          'H6',
          `${t.kind}@${t.step} rejected: ${String((t.rejected as Error)?.message ?? t.rejected)}`,
        );
        continue;
      }
      if (!t.entered || t.gen !== gen) continue;
      this.checkSemantics(t, state, multiSettle, fail);
    }
    return { state, resolved };
  }

  private checkSemantics(
    t: TrackedCall,
    state: StateSnapshot,
    multiSettle: boolean,
    fail: (invariant: string, detail: string) => void,
  ) {
    const tag = `${t.kind}@${t.step}`;
    const result = t.result;
    const premiumSync = t.syncOutcome === 'premium';
    const validSync =
      t.syncOutcome !== null && accessSnapshotFor(t.syncOutcome) !== null;
    const syncSnapshot = t.syncOutcome
      ? accessSnapshotFor(t.syncOutcome)
      : null;
    const storeOk =
      t.storeOutcome === 'entitled' ||
      t.storeOutcome === 'not_entitled' ||
      t.storeOutcome === 'none';
    const cancelled =
      t.storeOutcome === 'cancelled' || t.storeOutcome === 'cancelled_code1';
    const eq = (label: string, actual: unknown, expected: unknown) => {
      if (!same(actual, expected)) {
        fail(
          'H6',
          `${tag} ${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`,
        );
      }
    };
    switch (t.kind) {
      case 'purchaseSelected':
      case 'restorePurchases': {
        const isPurchase = t.kind === 'purchaseSelected';
        eq('result ⇔ store ok ∧ sync premium', result, storeOk && premiumSync);
        if (result === true && state.canonicalAccess?.premium !== true) {
          fail('H6', `${tag} returned true but canonicalAccess is not premium`);
        }
        if (t.storeIssued === 0) {
          eq('sync issued without store call', t.syncIssued, 0);
          if (!multiSettle && !state.error) {
            fail('H6', `${tag} failed before the store without an error`);
          }
        } else if (cancelled) {
          eq('sync after cancellation', t.syncIssued, 0);
          if (isPurchase && !multiSettle)
            eq('cancel is non-fatal (error)', state.error, null);
        } else if (t.storeOutcome === 'error') {
          eq('sync after store failure', t.syncIssued, 0);
          if (!multiSettle) {
            eq(
              'error code after store failure',
              state.error?.code,
              isPurchase ? 'billing.purchase_failed' : 'billing.restore_failed',
            );
          }
        } else if (storeOk && !this.backendConfigured) {
          eq('no sync possible without a backend', t.syncIssued, 0);
          if (multiSettle) break;
          eq('unreachable backend fails closed', state.canonicalAccess, null);
          eq(
            'unreachable backend error code',
            state.error?.code,
            'billing.backend_verification_pending',
          );
        } else if (storeOk) {
          eq('exactly one sync after store success', t.syncIssued, 1);
          if (multiSettle) break;
          if (premiumSync) {
            eq('premium sync clears error', state.error, null);
            eq('premium sync snapshot', state.canonicalAccess, syncSnapshot);
            eq('status after premium', state.status, 'ready');
          } else if (validSync) {
            eq(
              'non-premium sync snapshot',
              state.canonicalAccess,
              syncSnapshot,
            );
            eq(
              'non-premium error code',
              state.error?.code,
              isPurchase
                ? 'billing.backend_verification_pending'
                : 'billing.restore_failed',
            );
            eq(
              'non-premium status',
              state.status,
              isPurchase ? 'error' : 'ready',
            );
          } else {
            eq('failed sync fails closed', state.canonicalAccess, null);
            eq(
              'failed sync error code',
              state.error?.code,
              'billing.backend_verification_pending',
            );
            eq('failed sync status', state.status, 'error');
          }
        }
        break;
      }
      case 'syncBilling': {
        eq('result ⇔ premium sync', result, premiumSync);
        if (multiSettle) break;
        if (t.syncIssued === 0) {
          eq('unconfigured backend fails closed', state.canonicalAccess, null);
          eq('unconfigured backend status', state.status, 'unconfigured');
        } else if (validSync) {
          eq('sync snapshot', state.canonicalAccess, syncSnapshot);
          eq('sync clears error', state.error, null);
          eq('sync status', state.status, 'ready');
        } else {
          eq('failed sync fails closed', state.canonicalAccess, null);
          eq(
            'failed sync error code',
            state.error?.code,
            'billing.backend_verification_pending',
          );
        }
        break;
      }
      case 'refreshAccess': {
        const validAccess =
          t.accessOutcome !== null &&
          accessSnapshotFor(t.accessOutcome) !== null;
        eq('result ⇔ valid access body', result, validAccess);
        if (multiSettle) break;
        if (t.accessIssued === 0) {
          eq('unconfigured backend fails closed', state.canonicalAccess, null);
          eq('unconfigured backend status', state.status, 'unconfigured');
        } else if (validAccess) {
          eq(
            'refresh snapshot',
            state.canonicalAccess,
            accessSnapshotFor(t.accessOutcome!),
          );
          eq('refresh clears error', state.error, null);
          eq('refresh status', state.status, 'ready');
        } else {
          eq('failed refresh fails closed', state.canonicalAccess, null);
          if (!state.error) fail('H6', `${tag} failed without an error state`);
          if (state.status !== 'error' && state.status !== 'unconfigured') {
            fail('H6', `${tag} failed with status ${state.status}`);
          }
        }
        break;
      }
      case 'initialize': {
        if (state.status === 'loading') {
          const other = this.tracked.some(
            x =>
              x !== t &&
              x.entered &&
              !x.resolved &&
              x.gen === this.world.gen &&
              (x.kind === 'initialize' || x.kind === 'refreshAccess'),
          );
          if (!other) fail('H6', `${tag} resolved leaving status loading`);
        }
        break;
      }
    }
  }

  finalCheck(): void {
    const step = this.world.step;
    const state = snapshotState();
    if (this.world.pending.length > 0) {
      this.violations.push({
        step,
        invariant: 'H11',
        detail: `${this.world.pending.length} calls still pending after drain`,
      });
    }
    if (state.status === 'loading') {
      this.violations.push({
        step,
        invariant: 'H11',
        detail: 'status loading after drain',
      });
    }
    if (state.operation !== 'idle') {
      this.violations.push({
        step,
        invariant: 'H11',
        detail: `operation ${state.operation} after drain`,
      });
    }
    const unresolved = this.tracked.filter(t => !t.resolved);
    if (unresolved.length > 0) {
      this.violations.push({
        step,
        invariant: 'H11',
        detail: `unresolved store promises: ${unresolved.map(t => `${t.kind}@${t.step}`).join(',')}`,
      });
    }
  }
}

// ─── Runner ────────────────────────────────────────────────────────────────

const DRAIN_LIMIT = 400;

export async function runSequence(
  seed: number,
  actions: Action[],
): Promise<RunResult> {
  resetBillingGlobals();
  const model = new Model();
  const trace: TraceStep[] = [];
  const record = (
    action: TraceStep['action'],
    settled: SettledCall[],
    stateBefore: StateSnapshot,
    multiSettle: boolean,
  ) => {
    const violationsBefore = model.violations.length;
    const observedBefore = model.observed.length;
    const { state, resolved } = model.check(settled, stateBefore, multiSettle);
    trace.push({
      step: model.world.step,
      action,
      settled,
      pendingAfter: model.world.pendingKinds(),
      state,
      resolved,
      violations: model.violations.slice(violationsBefore),
      observed: model.observed.slice(observedBefore),
    });
  };
  try {
    for (const action of actions) {
      model.world.step += 1;
      const stateBefore = snapshotState();
      const settled = await model.apply(action);
      await flush();
      record(action, settled, stateBefore, settled.length > 1);
    }
    // Drain: settle everything still pending, oldest first, with rolls from a
    // seed-derived stream independent of the action list (so a minimized
    // action list replays the same drain).
    const drain = seededRandom((seed ^ 0x9e3779b9) >>> 0);
    let hung = false;
    let guard = 0;
    while (model.world.pending.length > 0) {
      guard += 1;
      if (guard > DRAIN_LIMIT) {
        hung = true;
        break;
      }
      model.world.step += 1;
      const stateBefore = snapshotState();
      const roll = drain();
      const done = await model.apply({
        t: 'settle',
        which: 'oldest',
        pick: 0,
        roll,
      });
      await flush();
      record({ t: 'drain', roll }, done, stateBefore, false);
    }
    await flush(5);
    model.world.step += 1;
    model.finalCheck();
    record({ t: 'final' }, [], snapshotState(), false);
    return {
      seed,
      length: actions.length,
      actions,
      trace,
      violations: model.violations,
      observed: model.observed,
      hung,
      callsIssued: model.world.issuedCount,
      callsSettled: model.world.settledLog.length,
      opsEntered: model.tracked.filter(t => t.entered).length,
    };
  } finally {
    resetBillingGlobals();
  }
}

export async function runSeed(seed: number): Promise<RunResult> {
  return runSequence(seed, generateSequence(seed));
}

/** Trace projection used for the determinism check: everything except the
 * violation/observation prose (which is itself derived from the same data). */
export function traceFingerprint(result: RunResult): string {
  return JSON.stringify(
    result.trace.map(step => ({
      step: step.step,
      action: step.action,
      settled: step.settled,
      pendingAfter: step.pendingAfter,
      state: step.state,
      resolved: step.resolved,
      violations: step.violations.map(v => v.invariant),
      observed: step.observed.map(v => v.invariant),
    })),
  );
}

// ─── Minimizer ─────────────────────────────────────────────────────────────

/**
 * ddmin over the action list: keeps removing chunks while the reduced list
 * still trips the same invariant. Sequences shorter than MIN_LENGTH are fine
 * here — a minimized repro is for humans, not for the length contract.
 */
export async function minimize(
  seed: number,
  actions: Action[],
  failing: (result: RunResult) => boolean,
): Promise<{ actions: Action[]; result: RunResult }> {
  let current = actions;
  let currentResult = await runSequence(seed, current);
  if (!failing(currentResult)) {
    return { actions: current, result: currentResult };
  }
  let n = 2;
  while (current.length >= 2) {
    const chunk = Math.ceil(current.length / n);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (candidate.length === 0) continue;
      const result = await runSequence(seed, candidate);
      if (failing(result)) {
        current = candidate;
        currentResult = result;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(current.length, n * 2);
    }
  }
  return { actions: current, result: currentResult };
}
