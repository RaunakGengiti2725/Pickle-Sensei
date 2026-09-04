import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import type { ConsentFetch } from '../../src/account/consentApi';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../src/account/consentApi';
import { useConsentStore } from '../../src/state/consentStore';

/**
 * CONCURRENCY STRESS CAMPAIGN for `state/consentStore`.
 *
 * A seeded scheduler drives the store with interleaved hydrate / grant /
 * withdraw calls, same-tick bursts, sign-out, account switch, bearer
 * rotation and out-of-order response delivery against a deterministic mock
 * consent server that owns the ledger. Every iteration is replayable from
 * its seed (`STRESS_SEED=<n>`), the campaign size is `STRESS_ITER` seeds per
 * delivery mode (default 60; the recorded campaign ran 1000 × 2 modes) and
 * `STRESS_OUT=<file>` writes the seed → outcome JSON table.
 *
 * An "epoch" is one signed-in stretch: sign-out, sign-in and account switch
 * each start a new one; bearer rotation does not. The store can only tell
 * sessions apart by `canonicalAppUserId`, so a response from an EARLIER
 * epoch of the SAME account (A → sign out → A, or A → B → A) is treated by
 * the store exactly like a current one — the harness tags those separately
 * (`stale_epoch_same_account`) from other-account responses (`other_account`).
 * The store is passive: it only learns about a sign-out through the next
 * `hydrate()` (the Settings screens re-hydrate on session change) or the
 * next response that lands, so signed-out checks apply once it was told.
 *
 * Invariants:
 *  I1  ≤ 1 mutation request in flight per signed-in epoch (no duplicate
 *      grant/withdraw while `busy`).
 *  I2  a response for a session that is no longer current never turns
 *      consent on and never changes `lastActionAt`.
 *  I3  every store call settles within bounded time and `busy` is false
 *      once every request has been answered (no deadlock, no stuck toggle).
 *  I4  at quiescence the store shows the LAST APPLIED server snapshot.
 *  I7  hydrate / setModelTrainingConsent never reject.
 *  I9  a same-tick burst of N toggles issues at most one POST.
 *  I10 `lastActionAt` is passed through verbatim (clock skew is the
 *      server's business, never re-interpreted on the device).
 *  I5  ledger agreement: `ready` ⇒ `modelTrainingActive` equals the server
 *      ledger — holds under FIFO delivery, VIOLATED under reordering
 *      (a late GET overwrites a newer POST result) → `test.failing`.
 *  I6  `ready` after a successful response ⇒ `error === null` — VIOLATED
 *      (a hydrate failure's error survives a later successful grant) →
 *      `test.failing`.
 *  I8  a response from a previous epoch must not clear `busy` while the
 *      current epoch has a mutation in flight (both the other-account and
 *      the same-account-earlier-epoch variants) — VIOLATED → `test.failing`.
 *      Every I1 violation the campaign found is downstream of an I8 clobber;
 *      an I1 with no earlier I8 in its interleaving fails the HELD test.
 *
 * `test.failing` blocks assert the EXPECTED behaviour; once the store is
 * fixed they start failing and must be flipped to plain `test`.
 */

// ─── Seeded PRNG (mulberry32) ──────────────────────────────────────────────

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

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function weighted<T extends string>(
  rng: () => number,
  table: readonly (readonly [T, number])[],
): T {
  const total = table.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [item, w] of table) {
    roll -= w;
    if (roll < 0) return item;
  }
  return table[table.length - 1]![0];
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

type Actor = 'A' | 'B';

const USER_ID: Record<Actor, string> = {
  A: 'a0000000-0000-0000-0000-00000000000a',
  B: 'b0000000-0000-0000-0000-00000000000b',
};

const CLOCK_SKEW_TIMESTAMPS = [
  '2026-08-29T00:00:00.000Z',
  '1999-12-31T23:59:59.000Z',
  '2099-01-01T00:00:00.000Z',
  '2026-09-04T22:51:00+14:00',
  '2026-09-04T22:51:00-12:00',
  '0001-01-01T00:00:00.000Z',
] as const;

function statusBody(active: boolean, lastActionAt: string | null) {
  return {
    subjectPseudonym: 'c0000000-0000-0000-0000-00000000000c',
    scopes: [
      {
        scope: 'video_analysis',
        active: true,
        consentVersion: 'video-analysis-v1',
        lastAction: 'granted',
        lastActionAt: '2026-08-01T00:00:00.000Z',
      },
      {
        scope: 'model_training',
        active,
        consentVersion: active ? MODEL_TRAINING_CONSENT_VERSION : null,
        lastAction: active ? 'granted' : 'withdrawn',
        lastActionAt,
      },
    ],
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function resetStore() {
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
}

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
};

// ─── Deterministic mock consent server ─────────────────────────────────────

type RequestKind = 'status' | 'grant' | 'withdraw';
type Outcome = 'ok' | 'network' | 'http500' | 'malformed';

interface PendingRequest {
  id: number;
  kind: RequestKind;
  actor: Actor;
  epoch: number;
  outcome: Outcome;
  /** Ledger value for `actor` right after the server processed it. */
  snapshot: boolean;
  lastActionAt: string | null;
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
}

interface Violation {
  invariant: string;
  step: number;
  detail: string;
}

interface AppliedSnapshot {
  active: boolean;
  lastActionAt: string | null;
  epoch: number;
  id: number;
  kind: RequestKind;
}

class MockConsentServer {
  ledger: Record<Actor, boolean> = { A: false, B: false };
  pending: PendingRequest[] = [];
  requests = 0;
  mutations = 0;
  private nextId = 1;
  readonly tokenOwner = new Map<string, Actor>();

  constructor(
    private readonly rng: () => number,
    private readonly failureRate: number,
    private readonly currentEpoch: () => number,
    private readonly onRequest: (req: PendingRequest) => void,
  ) {}

  readonly fetchFn: ConsentFetch = (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = headers['Authorization']?.replace('Bearer ', '') ?? '';
    const actor = this.tokenOwner.get(bearer);
    if (!actor) {
      throw new Error(`mock server: unknown bearer ${bearer}`);
    }
    const kind: RequestKind = input.endsWith('/status')
      ? 'status'
      : input.endsWith('/grant')
        ? 'grant'
        : 'withdraw';
    if (kind !== 'status') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body['scope'] !== 'model_training') {
        throw new Error(`mock server: unexpected scope ${body['scope']}`);
      }
    }
    const outcome: Outcome =
      this.rng() < this.failureRate
        ? pick(this.rng, ['network', 'http500', 'malformed'] as const)
        : 'ok';
    if (kind !== 'status' && outcome === 'ok') {
      this.ledger[actor] = kind === 'grant';
    }
    this.requests += 1;
    if (kind !== 'status') this.mutations += 1;
    return new Promise<Response>((resolve, reject) => {
      const req: PendingRequest = {
        id: this.nextId++,
        kind,
        actor,
        epoch: this.currentEpoch(),
        outcome,
        snapshot: this.ledger[actor],
        lastActionAt:
          this.rng() < 0.15 ? null : pick(this.rng, CLOCK_SKEW_TIMESTAMPS),
        resolve,
        reject,
      };
      this.pending.push(req);
      this.onRequest(req);
    });
  };

  deliver(index: number): PendingRequest {
    const [req] = this.pending.splice(index, 1);
    if (!req) throw new Error('mock server: nothing pending');
    switch (req.outcome) {
      case 'ok':
        req.resolve(jsonResponse(statusBody(req.snapshot, req.lastActionAt)));
        break;
      case 'network':
        req.reject(new Error('network down'));
        break;
      case 'http500':
        req.resolve(jsonResponse({ error: 'internal' }, false));
        break;
      case 'malformed':
        req.resolve(jsonResponse({ scopes: 'nope' }));
        break;
    }
    return req;
  }
}

// ─── One seeded interleaving ───────────────────────────────────────────────

type Action =
  | 'hydrate'
  | 'grant'
  | 'withdraw'
  | 'toggleBurst'
  | 'hydrateBurst'
  | 'signOut'
  | 'switchAccount'
  | 'rotateBearer'
  | 'deliver'
  | 'flush';

const ACTION_WEIGHTS: readonly (readonly [Action, number])[] = [
  ['hydrate', 14],
  ['grant', 12],
  ['withdraw', 12],
  ['toggleBurst', 6],
  ['hydrateBurst', 4],
  ['signOut', 4],
  ['switchAccount', 5],
  ['rotateBearer', 5],
  ['deliver', 30],
  ['flush', 8],
];

export interface IterationResult {
  seed: number;
  mode: 'fifo' | 'reorder';
  steps: number;
  requests: number;
  mutations: number;
  reorderedDeliveries: number;
  violations: Violation[];
  trace: string[];
  finalState: {
    availability: string;
    modelTrainingActive: boolean;
    busy: boolean;
    error: string | null;
    currentActor: Actor | null;
    ledger: Record<Actor, boolean>;
  };
}

interface IterationOptions {
  seed: number;
  mode: 'fifo' | 'reorder';
  steps?: number;
  failureRate?: number;
  /** Actions to draw from; defaults to the full table. */
  actions?: readonly (readonly [Action, number])[];
}

export async function runInterleaving(
  opts: IterationOptions,
): Promise<IterationResult> {
  const rng = mulberry32(opts.seed);
  const steps = opts.steps ?? 24;
  const failureRate = opts.failureRate ?? 0.15;
  const actions = opts.actions ?? ACTION_WEIGHTS;
  const violations: Violation[] = [];
  const trace: string[] = [];
  const tracked: Promise<void>[] = [];
  let settledCount = 0;
  let epoch = 0;
  let step = 0;
  let currentActor: Actor | null = 'A';
  let tokenSerial = 0;
  let reorderedDeliveries = 0;
  /** Last snapshot the store was allowed to apply (response for the
   * account that was current at delivery time). Held in an object because
   * it is written from closures and read after the loop. */
  const applied: { snapshot: AppliedSnapshot | null } = { snapshot: null };
  let lastDeliveredForCurrent: Outcome | null = null;
  let busyClobbered = false;
  /** The store only hears about a sign-out via hydrate() or a landing
   * response; `I2_signed_out_never_ready` applies once it has. */
  let signedOutNotified = false;

  const violate = (invariant: string, detail: string) => {
    violations.push({ invariant, step, detail });
  };

  const server = new MockConsentServer(
    rng,
    failureRate,
    () => epoch,
    req => {
      if (req.kind === 'status') return;
      const concurrent = server.pending.filter(
        p =>
          p !== req &&
          p.kind !== 'status' &&
          p.actor === req.actor &&
          p.epoch === req.epoch,
      );
      if (concurrent.length > 0) {
        violate(
          'I1_single_mutation_in_flight',
          `${req.kind}#${req.id} for ${req.actor} epoch ${req.epoch} joined in-flight ${concurrent
            .map(p => `${p.kind}#${p.id}`)
            .join(',')}`,
        );
      }
    },
  );

  const track = (label: string, promise: Promise<void>) => {
    trace.push(`${step}:${label}`);
    tracked.push(
      promise.then(
        () => {
          settledCount += 1;
        },
        (error: unknown) => {
          settledCount += 1;
          violate('I7_never_rejects', `${label} rejected: ${String(error)}`);
        },
      ),
    );
  };

  const newEpoch = () => {
    epoch += 1;
    applied.snapshot = null;
    lastDeliveredForCurrent = null;
  };

  const signIn = (actor: Actor) => {
    tokenSerial += 1;
    const token = `token-${actor}-${tokenSerial}`;
    server.tokenOwner.set(token, actor);
    const session: ApiSession = {
      apiBaseUrl: 'https://api.test',
      bearerToken: token,
      canonicalAppUserId: USER_ID[actor],
      provider: actor === 'A' ? 'apple' : 'google',
    };
    establishApiSession(session);
    currentActor = actor;
  };

  const store = () => useConsentStore.getState();

  resetStore();
  clearApiSession();
  signIn('A');
  track('hydrate', store().hydrate(server.fetchFn));
  await flush();

  const deliverOne = async () => {
    if (server.pending.length === 0) return;
    const index =
      opts.mode === 'fifo' ? 0 : Math.floor(rng() * server.pending.length);
    if (index !== 0) reorderedDeliveries += 1;
    const before = store();
    const currentBefore = currentActor;
    const delivered = server.pending[index]!;
    const currentHasMutationInFlight = server.pending.some(
      p =>
        p !== delivered &&
        p.kind !== 'status' &&
        p.actor === currentBefore &&
        p.epoch === epoch,
    );
    const req = server.deliver(index);
    trace.push(
      `${step}:deliver ${req.kind}#${req.id}/${req.actor}/e${req.epoch}/${req.outcome}${
        req.outcome === 'ok' ? `/${req.snapshot ? 'on' : 'off'}` : ''
      }`,
    );
    await flush();
    const after = store();
    if (currentBefore === null) signedOutNotified = true;
    const isStale = req.actor !== currentBefore;
    const isStaleEpoch = req.epoch !== epoch;
    if (
      (isStale || isStaleEpoch) &&
      currentHasMutationInFlight &&
      before.busy &&
      !after.busy
    ) {
      busyClobbered = true;
      violate(
        'I8_stale_response_must_not_clear_successor_busy',
        `[${isStale ? 'other_account' : 'stale_epoch_same_account'}] ${req.kind}#${req.id} for ${req.actor} (epoch ${req.epoch}) cleared busy while ${currentBefore} has a mutation in flight in epoch ${epoch}`,
      );
    }
    if (isStale) {
      if (!before.modelTrainingActive && after.modelTrainingActive) {
        violate(
          'I2_stale_response_never_turns_consent_on',
          `${req.kind}#${req.id} for ${req.actor} turned consent on while ${currentBefore ?? 'nobody'} is signed in`,
        );
      }
      if (
        after.lastActionAt !== before.lastActionAt &&
        after.lastActionAt !== null
      ) {
        violate(
          'I2_stale_response_never_turns_consent_on',
          `${req.kind}#${req.id} for ${req.actor} changed lastActionAt to ${String(after.lastActionAt)}`,
        );
      }
    } else {
      lastDeliveredForCurrent = req.outcome;
      if (req.outcome === 'ok') {
        applied.snapshot = {
          active: req.snapshot,
          lastActionAt: req.lastActionAt,
          epoch: req.epoch,
          id: req.id,
          kind: req.kind,
        };
        if (after.availability === 'ready') {
          if (after.lastActionAt !== req.lastActionAt) {
            violate(
              'I10_lastActionAt_verbatim',
              `${req.kind}#${req.id} lastActionAt ${String(req.lastActionAt)} became ${String(after.lastActionAt)}`,
            );
          }
        }
      }
    }
  };

  for (step = 1; step <= steps; step += 1) {
    const action = weighted(rng, actions);
    switch (action) {
      case 'hydrate':
        if (!getApiSession()) {
          track('hydrate(signed-out)', store().hydrate(server.fetchFn));
        } else {
          track('hydrate', store().hydrate(server.fetchFn));
        }
        break;
      case 'grant':
      case 'withdraw': {
        const wasBusy = store().busy;
        const mutationsBefore = server.mutations;
        track(
          action,
          store().setModelTrainingConsent(action === 'grant', server.fetchFn),
        );
        if (
          wasBusy &&
          getApiSession() &&
          server.mutations !== mutationsBefore
        ) {
          violate(
            'I9_busy_guard_blocks_duplicate',
            `${action} issued a POST while busy`,
          );
        }
        break;
      }
      case 'toggleBurst': {
        const n = 2 + Math.floor(rng() * 4);
        const mutationsBefore = server.mutations;
        const wasBusy = store().busy;
        const burst = Array.from({ length: n }, () =>
          store().setModelTrainingConsent(rng() < 0.5, server.fetchFn),
        );
        track(
          `toggleBurst×${n}`,
          Promise.all(burst).then(() => undefined),
        );
        const issued = server.mutations - mutationsBefore;
        const allowed = getApiSession() && !wasBusy ? 1 : 0;
        if (issued > allowed) {
          violate(
            'I9_burst_issues_at_most_one_post',
            `burst of ${n} issued ${issued} POSTs (allowed ${allowed})`,
          );
        }
        break;
      }
      case 'hydrateBurst': {
        const n = 2 + Math.floor(rng() * 3);
        const burst = Array.from({ length: n }, () =>
          store().hydrate(server.fetchFn),
        );
        track(
          `hydrateBurst×${n}`,
          Promise.all(burst).then(() => undefined),
        );
        break;
      }
      case 'signOut':
        if (getApiSession()) {
          clearApiSession();
          currentActor = null;
          newEpoch();
          signedOutNotified = false;
          trace.push(`${step}:signOut`);
          // Both Settings screens re-hydrate whenever the session changes.
          if (rng() < 0.7) {
            signedOutNotified = true;
            track('hydrate(after signOut)', store().hydrate(server.fetchFn));
          }
        } else {
          signIn(rng() < 0.5 ? 'A' : 'B');
          newEpoch();
          trace.push(`${step}:signIn ${currentActor}`);
          if (rng() < 0.7) {
            track('hydrate(after signIn)', store().hydrate(server.fetchFn));
          }
        }
        break;
      case 'switchAccount': {
        const next: Actor = currentActor === 'A' ? 'B' : 'A';
        clearApiSession();
        signIn(next);
        newEpoch();
        trace.push(`${step}:switch→${next}`);
        if (rng() < 0.7) {
          track('hydrate(after switch)', store().hydrate(server.fetchFn));
        }
        break;
      }
      case 'rotateBearer':
        if (currentActor) {
          signIn(currentActor);
          trace.push(`${step}:rotate ${currentActor}`);
          if (rng() < 0.5) {
            track('hydrate(after rotate)', store().hydrate(server.fetchFn));
          }
        }
        break;
      case 'deliver':
        await deliverOne();
        break;
      case 'flush':
        await flush();
        break;
    }
    await flush(2);
  }

  // Quiescence: answer everything that is still pending.
  while (server.pending.length > 0) {
    step += 1;
    await deliverOne();
  }

  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    Promise.all(tracked).then(() => true),
    new Promise<boolean>(resolve => {
      settleTimer = setTimeout(() => resolve(false), 2000);
    }),
  ]);
  clearTimeout(settleTimer);
  if (!settled) {
    violate(
      'I3_bounded_settlement',
      `${tracked.length - settledCount} of ${tracked.length} store calls never settled`,
    );
  }
  const final = store();
  if (final.busy) {
    violate('I3_busy_released_at_quiescence', 'busy is still true');
  }
  const lastAppliedSnapshot = applied.snapshot;
  if (final.availability === 'ready' && currentActor && lastAppliedSnapshot) {
    if (final.modelTrainingActive !== lastAppliedSnapshot.active) {
      violate(
        'I4_last_applied_snapshot_wins',
        `store ${final.modelTrainingActive} vs last applied ${lastAppliedSnapshot.active}`,
      );
    }
    if (final.modelTrainingActive !== server.ledger[currentActor]) {
      const cause = busyClobbered
        ? 'after_busy_clobber'
        : lastAppliedSnapshot.epoch !== epoch
          ? 'stale_epoch_same_account'
          : 'same_epoch_reorder';
      violate(
        'I5_ledger_agreement',
        `[${cause}] store shows ${final.modelTrainingActive ? 'on' : 'off'} but server ledger for ${currentActor} is ${
          server.ledger[currentActor] ? 'on' : 'off'
        }; last applied ${lastAppliedSnapshot.kind}#${lastAppliedSnapshot.id} from epoch ${lastAppliedSnapshot.epoch} (current epoch ${epoch})`,
      );
    }
    if (lastDeliveredForCurrent === 'ok' && final.error !== null) {
      violate(
        'I6_error_cleared_after_success',
        `ready with a fresh successful response but error="${final.error}"`,
      );
    }
  }
  if (!currentActor && signedOutNotified && final.availability === 'ready') {
    violate(
      'I2_signed_out_never_ready',
      'availability is ready while nobody is signed in',
    );
  }

  return {
    seed: opts.seed,
    mode: opts.mode,
    steps: step,
    requests: server.requests,
    mutations: server.mutations,
    reorderedDeliveries,
    violations,
    trace,
    finalState: {
      availability: final.availability,
      modelTrainingActive: final.modelTrainingActive,
      busy: final.busy,
      error: final.error,
      currentActor,
      ledger: { ...server.ledger },
    },
  };
}

// ─── Campaign ──────────────────────────────────────────────────────────────

const STRESS_ITER = Math.max(
  1,
  Number.parseInt(process.env['STRESS_ITER'] ?? '60', 10) || 60,
);
const STRESS_SEED_BASE =
  Number.parseInt(process.env['STRESS_SEED'] ?? '', 10) || 1;
const STRESS_OUT = process.env['STRESS_OUT'];

/** Invariants that the current store is KNOWN to violate; tracked separately
 * by the `test.failing` blocks below so the campaign stays green on the
 * held invariants without hiding the broken ones. */
const KNOWN_BROKEN = new Set([
  'I5_ledger_agreement',
  'I6_error_cleared_after_success',
  'I8_stale_response_must_not_clear_successor_busy',
]);

/** I1 is HELD on its own: the busy guard is only ever defeated after a
 * previous-epoch response cleared `busy` (I8). An I1 violation with no
 * earlier I8 in the same interleaving would be a new, independent bug. */
function isConsequenceOfBusyClobber(row: IterationResult, v: Violation) {
  return (
    v.invariant === 'I1_single_mutation_in_flight' &&
    row.violations.some(
      w =>
        w.invariant === 'I8_stale_response_must_not_clear_successor_busy' &&
        w.step <= v.step,
    )
  );
}

interface CampaignSummary {
  mode: 'fifo' | 'reorder';
  iterations: number;
  seeds: number[];
  totalSteps: number;
  totalRequests: number;
  totalMutations: number;
  violationsByInvariant: Record<string, number>;
  seedsByInvariant: Record<string, number[]>;
  rows: IterationResult[];
}

async function runCampaign(mode: 'fifo' | 'reorder'): Promise<CampaignSummary> {
  const rows: IterationResult[] = [];
  const violationsByInvariant: Record<string, number> = {};
  const seedsByInvariant: Record<string, number[]> = {};
  for (let i = 0; i < STRESS_ITER; i += 1) {
    const seed = STRESS_SEED_BASE + i;
    const row = await runInterleaving({ seed, mode });
    rows.push(row);
    const seen = new Set<string>();
    for (const v of row.violations) {
      violationsByInvariant[v.invariant] =
        (violationsByInvariant[v.invariant] ?? 0) + 1;
      if (!seen.has(v.invariant)) {
        seen.add(v.invariant);
        (seedsByInvariant[v.invariant] ??= []).push(seed);
      }
    }
  }
  return {
    mode,
    iterations: rows.length,
    seeds: rows.map(r => r.seed),
    totalSteps: rows.reduce((s, r) => s + r.steps, 0),
    totalRequests: rows.reduce((s, r) => s + r.requests, 0),
    totalMutations: rows.reduce((s, r) => s + r.mutations, 0),
    violationsByInvariant,
    seedsByInvariant,
    rows,
  };
}

function writeCampaign(summary: CampaignSummary) {
  if (!STRESS_OUT) return;
  const file = STRESS_OUT.replace(/\.json$/, '') + `.${summary.mode}.json`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(summary, null, 2));
}

function heldViolations(summary: CampaignSummary) {
  return summary.rows.flatMap(r =>
    r.violations
      .filter(
        v =>
          !KNOWN_BROKEN.has(v.invariant) && !isConsequenceOfBusyClobber(r, v),
      )
      .map(v => ({ seed: r.seed, ...v })),
  );
}

describe('consentStore concurrency stress campaign', () => {
  afterEach(() => {
    resetStore();
    clearApiSession();
  });

  let fifo: CampaignSummary;
  let reorder: CampaignSummary;

  beforeAll(async () => {
    fifo = await runCampaign('fifo');
    writeCampaign(fifo);
    reorder = await runCampaign('reorder');
    writeCampaign(reorder);
  }, 600_000);

  test(`FIFO delivery: I1/I2/I3/I4/I7/I9/I10 hold over ${STRESS_ITER} seeded interleavings`, () => {
    expect(fifo.iterations).toBe(STRESS_ITER);
    expect(fifo.totalRequests).toBeGreaterThan(0);
    expect(heldViolations(fifo)).toEqual([]);
  });

  test(`reordered delivery: I1/I2/I3/I4/I7/I9/I10 hold over ${STRESS_ITER} seeded interleavings`, () => {
    expect(reorder.iterations).toBe(STRESS_ITER);
    expect(reorder.totalRequests).toBeGreaterThan(0);
    expect(heldViolations(reorder)).toEqual([]);
  });

  test('FIFO delivery: I5 ledger agreement holds (responses in request order never disagree with the server)', () => {
    expect(fifo.seedsByInvariant['I5_ledger_agreement'] ?? []).toEqual([]);
  });

  test.failing(
    'reordered delivery: I5 ledger agreement — a late GET must not overwrite a newer grant/withdraw result',
    () => {
      expect(reorder.seedsByInvariant['I5_ledger_agreement'] ?? []).toEqual([]);
    },
  );

  test.failing(
    'I6 — a successful response must clear the error left by a concurrent failed hydrate',
    () => {
      expect(
        fifo.seedsByInvariant['I6_error_cleared_after_success'] ?? [],
      ).toEqual([]);
    },
  );

  test.failing(
    'I1 — after a stale response cleared busy, a second grant/withdraw goes out while the first is still in flight',
    () => {
      const seeds = [
        ...(fifo.seedsByInvariant['I1_single_mutation_in_flight'] ?? []),
        ...(reorder.seedsByInvariant['I1_single_mutation_in_flight'] ?? []),
      ];
      expect(seeds).toEqual([]);
    },
  );

  test.failing(
    "I8 — a previous epoch's late response must not clear busy under the current epoch's in-flight mutation",
    () => {
      const seeds = [
        ...(fifo.seedsByInvariant[
          'I8_stale_response_must_not_clear_successor_busy'
        ] ?? []),
        ...(reorder.seedsByInvariant[
          'I8_stale_response_must_not_clear_successor_busy'
        ] ?? []),
      ];
      expect(seeds).toEqual([]);
    },
  );
});
