/**
 * STRESS / mod-launch-gate / lens = concurrency (against 1fb0efd7).
 *
 * Unit under attack: `src/flow/launchGate.ts` — the three pre-auth routing
 * decisions App.tsx wires into Welcome / Onboarding / SignIn callbacks
 * (Welcome → onboarding → sign-in, no skip affordance). The module is pure
 * and synchronous, so the concurrency question is not "does it lock" but
 * "can ANY interleaving, duplicate/re-entrant/cancelled call, concurrent
 * session change, clock skew, argument smuggling or module reload make a
 * decision drift" — in particular make `stageAfterGetStarted()` or
 * `stageWhenLeavingOnboarding()` answer `'signin'` (a skip) or make
 * `stageAfterOnboarding()` answer anything but `'signin'`.
 *
 * Every campaign is driven by a seeded PRNG (mulberry32); an iteration is
 * replayable from `STRESS_SEED` + its index. Scale is `STRESS_ITER` per
 * campaign (default 500, the lens minimum). When `STRESS_OUT` names a file,
 * the seed → outcome table is written there as JSON.
 *
 * Campaigns:
 *  C1 burst      Promise.all bursts of 2–64 actors on a seeded scheduler
 *                (sync / microtask / queueMicrotask / setTimeout /
 *                setImmediate / nested microtasks), with duplicate calls,
 *                call-during-call (re-entrant), cancel-during-call
 *                (AbortController), a session cell flipped/rotated/logged
 *                out mid-burst by rival actors, and Date.now skew installed
 *                mid-burst. Asserts: every completed call returns its
 *                constant, completed + cancelled = actors (nothing lost, no
 *                double count), bounded wall time (no deadlock).
 *  C2 argFuzz    random device-history-shaped payloads (incl. throwing
 *                Proxies and hostile `this`) smuggled into the zero-arity
 *                functions. Asserts: constants unchanged, args never read.
 *  C3 wiring     the App.tsx Gate reducer MODEL (App.tsx:202-216, INFERRED
 *                wiring, real mount is pinned by wf/App.buttons.test.tsx):
 *                exhaustive 3 stages × 5 events table + seeded random walks
 *                + two independent Gate cells driven by interleaved actors.
 *                Asserts: 'signin' is entered ONLY via the explicit link
 *                from Welcome or by finishing onboarding; 'onboarding' only
 *                via Start; Start and step-one Back never reach sign-in;
 *                per-cell linearizability (final state = sequential replay
 *                of that cell's applied order); no cross-talk between cells.
 *  C4 reload     concurrent `jest.isolateModules` re-evaluation while other
 *                actors call the already-loaded module. Asserts: export
 *                surface is exactly the three zero-arity functions and their
 *                answers match across module instances.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as launchGateModule from '../../src/flow/launchGate';
import {
  stageAfterGetStarted,
  stageAfterOnboarding,
  stageWhenLeavingOnboarding,
  type PreAuthStage,
} from '../../src/flow/launchGate';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

const ITER = readPositiveInt(process.env.STRESS_ITER, 500);
const SEED_BASE = readPositiveInt(process.env.STRESS_SEED, 20260905);
const OUT_FILE = process.env.STRESS_OUT;
/** Wall-time bound per burst; a burst that outlives it is a deadlock/hang. */
const BURST_DEADLINE_MS = 2000;
/** Jest timeout scales with the campaign size (ITER=500 finishes in ~2–3 s). */
const CAMPAIGN_TIMEOUT_MS = Math.max(30_000, ITER * 40);

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — every iteration is replayable from its seed.
// ---------------------------------------------------------------------------

interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  bool(p?: number): boolean;
}

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: max => Math.floor(next() * max),
    pick: items => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from empty list');
      return item;
    },
    bool: (p = 0.5) => next() < p,
  };
}

// ---------------------------------------------------------------------------
// Gate function table + expected constants (the contract under attack).
// ---------------------------------------------------------------------------

type GateName = 'getStarted' | 'onboardingFinished' | 'leavingOnboarding';

const GATE: Record<GateName, () => PreAuthStage> = {
  getStarted: stageAfterGetStarted,
  onboardingFinished: stageAfterOnboarding,
  leavingOnboarding: stageWhenLeavingOnboarding,
};

const EXPECTED: Record<GateName, PreAuthStage> = {
  getStarted: 'onboarding',
  onboardingFinished: 'signin',
  leavingOnboarding: 'welcome',
};

const GATE_NAMES: readonly GateName[] = [
  'getStarted',
  'onboardingFinished',
  'leavingOnboarding',
];

// ---------------------------------------------------------------------------
// Seeded scheduler: places an actor's work on one of the event-loop lanes.
// ---------------------------------------------------------------------------

type Lane =
  | 'sync'
  | 'microtask'
  | 'queueMicrotask'
  | 'timeout'
  | 'immediate'
  | 'nestedMicro';

const LANES: readonly Lane[] = [
  'sync',
  'microtask',
  'queueMicrotask',
  'timeout',
  'immediate',
  'nestedMicro',
];

interface Slot {
  lane: Lane;
  /** setTimeout delay (ms) or nested-microtask depth. */
  arg: number;
}

function randomSlot(rng: Rng): Slot {
  const lane = rng.pick(LANES);
  const arg =
    lane === 'timeout'
      ? rng.int(3)
      : lane === 'nestedMicro'
        ? 1 + rng.int(4)
        : 0;
  return { lane, arg };
}

function schedule<T>(slot: Slot, work: () => T): Promise<T> {
  switch (slot.lane) {
    case 'sync':
      return new Promise<T>((resolve, reject) => {
        try {
          resolve(work());
        } catch (e) {
          reject(e);
        }
      });
    case 'microtask':
      return Promise.resolve().then(work);
    case 'queueMicrotask':
      return new Promise<T>((resolve, reject) => {
        queueMicrotask(() => {
          try {
            resolve(work());
          } catch (e) {
            reject(e);
          }
        });
      });
    case 'timeout':
      return new Promise<T>((resolve, reject) => {
        setTimeout(() => {
          try {
            resolve(work());
          } catch (e) {
            reject(e);
          }
        }, slot.arg);
      });
    case 'immediate':
      return new Promise<T>((resolve, reject) => {
        setImmediate(() => {
          try {
            resolve(work());
          } catch (e) {
            reject(e);
          }
        });
      });
    case 'nestedMicro': {
      let p: Promise<unknown> = Promise.resolve();
      for (let i = 0; i < slot.arg; i += 1) p = p.then(() => undefined);
      return p.then(work);
    }
  }
}

function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`${label}: exceeded ${ms}ms wall time (deadlock/hang)`),
        ),
      ms,
    );
  });
  return Promise.race([p, guard]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

function nowMs(): number {
  // process.hrtime, not Date.now — Date.now is spied on inside the bursts.
  return Number(process.hrtime.bigint()) / 1e6;
}

// ---------------------------------------------------------------------------
// Result table
// ---------------------------------------------------------------------------

type Campaign = 'C1_burst' | 'C2_argFuzz' | 'C3_wiring' | 'C4_reload';

interface Row {
  campaign: Campaign;
  index: number;
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  actors: number;
  wallMs: number;
  detail?: string;
}

const rows: Row[] = [];

function record(row: Row): void {
  rows.push(row);
}

function violations(rowsOf: Row[]): string[] {
  return rowsOf
    .filter(r => r.outcome === 'BROKEN')
    .map(
      r =>
        `${r.campaign} seed=${r.seed} idx=${r.index}: ${r.detail ?? 'unknown'}`,
    );
}

afterAll(() => {
  if (!OUT_FILE) return;
  const byCampaign: Record<
    string,
    { held: number; broken: number; maxWallMs: number }
  > = {};
  for (const r of rows) {
    const c = (byCampaign[r.campaign] ??= { held: 0, broken: 0, maxWallMs: 0 });
    if (r.outcome === 'HELD') c.held += 1;
    else c.broken += 1;
    c.maxWallMs = Math.max(c.maxWallMs, r.wallMs);
  }
  const report = {
    unit: 'apps/mobile/src/flow/launchGate.ts',
    lens: 'concurrency',
    config: { STRESS_ITER: ITER, STRESS_SEED: SEED_BASE, BURST_DEADLINE_MS },
    node: process.version,
    scenariosExecuted: rows.length,
    byCampaign,
    failingSeeds: rows.filter(r => r.outcome === 'BROKEN').map(r => r.seed),
    rows,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
});

// ---------------------------------------------------------------------------
// Shared "session" cell that rival actors flip during a burst
// (sign-in / rotation / logout racing the gate decisions).
// ---------------------------------------------------------------------------

interface SessionCell {
  token: string | null;
  rotations: number;
  logouts: number;
}

type SessionOp = 'signIn' | 'rotate' | 'logout';
const SESSION_OPS: readonly SessionOp[] = ['signIn', 'rotate', 'logout'];

function applySessionOp(cell: SessionCell, op: SessionOp, tag: string): void {
  switch (op) {
    case 'signIn':
      cell.token = `access-${tag}`;
      break;
    case 'rotate':
      if (cell.token !== null) {
        cell.token = `access-${tag}-rotated`;
        cell.rotations += 1;
      }
      break;
    case 'logout':
      cell.token = null;
      cell.logouts += 1;
      break;
  }
}

// ---------------------------------------------------------------------------
// C1 — Promise.all bursts on the seeded scheduler
// ---------------------------------------------------------------------------

type ActorKind =
  | 'plain'
  | 'duplicate'
  | 'reentrant'
  | 'cancelAware'
  | 'canceller'
  | 'sessionFlipper'
  | 'clockSkewer';

const ACTOR_KINDS: readonly ActorKind[] = [
  'plain',
  'plain',
  'plain',
  'duplicate',
  'reentrant',
  'cancelAware',
  'cancelAware',
  'canceller',
  'sessionFlipper',
  'clockSkewer',
];

interface ActorResult {
  kind: ActorKind;
  gate?: GateName;
  result?: PreAuthStage;
  /** Second answer of a duplicate / re-entrant call. */
  second?: PreAuthStage;
  cancelled?: boolean;
}

interface BurstPlan {
  seed: number;
  actors: Array<{
    kind: ActorKind;
    gate: GateName;
    slot: Slot;
    op: SessionOp;
    skew: number;
  }>;
}

function planBurst(seed: number): BurstPlan {
  const rng = mulberry32(seed);
  const count = 2 + rng.int(63);
  const actors: BurstPlan['actors'] = [];
  for (let i = 0; i < count; i += 1) {
    actors.push({
      kind: rng.pick(ACTOR_KINDS),
      gate: rng.pick(GATE_NAMES),
      slot: randomSlot(rng),
      op: rng.pick(SESSION_OPS),
      // ±~31 years of skew, or NaN-adjacent extremes.
      skew: rng.bool(0.1)
        ? rng.pick([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 0])
        : Math.floor((rng.next() - 0.5) * 2e12),
    });
  }
  return { seed, actors };
}

async function runBurst(
  plan: BurstPlan,
): Promise<{ results: ActorResult[]; session: SessionCell }> {
  const controller = new AbortController();
  const session: SessionCell = { token: null, rotations: 0, logouts: 0 };
  const realNow = Date.now;
  const dateSpy = jest.spyOn(Date, 'now');
  dateSpy.mockImplementation(() => realNow());
  try {
    const promises = plan.actors.map((actor, i) =>
      schedule(actor.slot, (): ActorResult => {
        switch (actor.kind) {
          case 'plain':
            return {
              kind: actor.kind,
              gate: actor.gate,
              result: GATE[actor.gate](),
            };
          case 'duplicate': {
            const first = GATE[actor.gate]();
            const second = GATE[actor.gate]();
            return {
              kind: actor.kind,
              gate: actor.gate,
              result: first,
              second,
            };
          }
          case 'reentrant': {
            // Call-during-call: the answer of one decision feeds a second
            // decision taken while the first is still "in flight" on the
            // caller's stack (the way App.tsx's setState updater would run).
            let inner: PreAuthStage | undefined;
            const outer = ((): PreAuthStage => {
              const r = GATE[actor.gate]();
              inner = GATE[actor.gate]();
              return r;
            })();
            return {
              kind: actor.kind,
              gate: actor.gate,
              result: outer,
              second: inner,
            };
          }
          case 'cancelAware': {
            // Cancel-during-call: an actor that observes the abort before
            // deciding records a cancellation and NO decision; one that has
            // already decided keeps that decision even if the abort lands
            // before it is consumed.
            if (controller.signal.aborted)
              return { kind: actor.kind, gate: actor.gate, cancelled: true };
            const result = GATE[actor.gate]();
            return {
              kind: actor.kind,
              gate: actor.gate,
              result,
              cancelled: false,
            };
          }
          case 'canceller':
            controller.abort();
            return { kind: actor.kind };
          case 'sessionFlipper':
            applySessionOp(session, actor.op, `${plan.seed}-${i}`);
            return { kind: actor.kind };
          case 'clockSkewer': {
            const skew = actor.skew;
            dateSpy.mockImplementation(() => realNow() + skew);
            return { kind: actor.kind };
          }
        }
      }),
    );
    const results = await withDeadline(
      Promise.all(promises),
      BURST_DEADLINE_MS,
      `burst seed=${plan.seed}`,
    );
    return { results, session };
  } finally {
    dateSpy.mockRestore();
  }
}

function checkBurst(
  plan: BurstPlan,
  results: ActorResult[],
): string | undefined {
  if (results.length !== plan.actors.length) {
    return `lost actors: planned=${plan.actors.length} completed=${results.length}`;
  }
  let decisions = 0;
  let cancelled = 0;
  let observers = 0;
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    const a = plan.actors[i];
    if (r === undefined || a === undefined) return `missing result at ${i}`;
    if (r.kind !== a.kind) return `actor ${i} kind drift ${a.kind}→${r.kind}`;
    if (
      r.kind === 'canceller' ||
      r.kind === 'sessionFlipper' ||
      r.kind === 'clockSkewer'
    ) {
      observers += 1;
      continue;
    }
    if (r.cancelled === true) {
      cancelled += 1;
      if (r.result !== undefined)
        return `actor ${i} cancelled AND produced a decision (double count)`;
      continue;
    }
    decisions += 1;
    if (r.gate === undefined) return `actor ${i} decision without gate`;
    if (r.result !== EXPECTED[r.gate]) {
      return `actor ${i} ${r.gate}() → ${String(r.result)} (expected ${EXPECTED[r.gate]}) lane=${a.slot.lane}`;
    }
    if (
      (r.kind === 'duplicate' || r.kind === 'reentrant') &&
      r.second !== EXPECTED[r.gate]
    ) {
      return `actor ${i} ${r.kind} second ${r.gate}() → ${String(r.second)} (expected ${EXPECTED[r.gate]})`;
    }
  }
  if (decisions + cancelled + observers !== plan.actors.length) {
    return `accounting: decisions=${decisions} cancelled=${cancelled} observers=${observers} actors=${plan.actors.length}`;
  }
  return undefined;
}

describe(`C1 burst — ${ITER} seeded Promise.all interleavings`, () => {
  it(
    'every interleaving (duplicate, re-entrant, cancel, session flip/rotate/logout, clock skew) yields the constant decisions, nothing lost, bounded time',
    async () => {
      const campaignRows: Row[] = [];
      for (let i = 0; i < ITER; i += 1) {
        const seed = SEED_BASE + i;
        const plan = planBurst(seed);
        const started = nowMs();
        let detail: string | undefined;
        try {
          const { results } = await runBurst(plan);
          detail = checkBurst(plan, results);
        } catch (e) {
          detail = e instanceof Error ? e.message : String(e);
        }
        const row: Row = {
          campaign: 'C1_burst',
          index: i,
          seed,
          outcome: detail === undefined ? 'HELD' : 'BROKEN',
          actors: plan.actors.length,
          wallMs: Math.round((nowMs() - started) * 1000) / 1000,
          ...(detail === undefined ? {} : { detail }),
        };
        campaignRows.push(row);
        record(row);
      }
      expect(violations(campaignRows)).toEqual([]);
      expect(campaignRows).toHaveLength(ITER);
      expect(Math.max(...campaignRows.map(r => r.wallMs))).toBeLessThan(
        BURST_DEADLINE_MS,
      );
    },
    CAMPAIGN_TIMEOUT_MS,
  );

  it('the decisions never consult the clock (Date.now / performance.now untouched by 3000 calls)', () => {
    const dateSpy = jest.spyOn(Date, 'now');
    const perfSpy = jest.spyOn(performance, 'now');
    try {
      dateSpy.mockClear();
      perfSpy.mockClear();
      for (let i = 0; i < 1000; i += 1) {
        expect(stageAfterGetStarted()).toBe('onboarding');
        expect(stageAfterOnboarding()).toBe('signin');
        expect(stageWhenLeavingOnboarding()).toBe('welcome');
      }
      expect(dateSpy).not.toHaveBeenCalled();
      expect(perfSpy).not.toHaveBeenCalled();
    } finally {
      dateSpy.mockRestore();
      perfSpy.mockRestore();
    }
  });

  it('a decision is not a promise, thenable or lazy accessor — it cannot be raced', () => {
    for (const name of GATE_NAMES) {
      const value: unknown = GATE[name]();
      expect(typeof value).toBe('string');
      expect(value).toBe(EXPECTED[name]);
    }
  });
});

// ---------------------------------------------------------------------------
// C2 — argument smuggling: the functions are zero-arity and must stay blind
// to anything a caller (or a future "helpful" wiring) passes in.
// ---------------------------------------------------------------------------

type Smuggled = (...args: unknown[]) => PreAuthStage;

function hostilePayload(rng: Rng, depth = 0): unknown {
  const kind = rng.int(12);
  switch (kind) {
    case 0:
      return {
        onboarded: true,
        hasProfile: true,
        deviceHistory: 'signed-in-before',
      };
    case 1:
      return { skip: true, stage: 'signin', preAuthStage: 'signin' };
    case 2:
      return 'signin';
    case 3:
      return rng.bool() ? null : undefined;
    case 4:
      return rng.bool() ? Number.NaN : -0;
    case 5:
      return Symbol('signin');
    case 6:
      return () => 'signin';
    case 7:
      return new Proxy(
        {},
        {
          get() {
            throw new Error('arguments must never be read');
          },
          has() {
            throw new Error('arguments must never be probed');
          },
          ownKeys() {
            throw new Error('arguments must never be enumerated');
          },
        },
      );
    case 8:
      return depth < 2
        ? [hostilePayload(rng, depth + 1), hostilePayload(rng, depth + 1)]
        : [];
    case 9:
      return depth < 2
        ? { session: hostilePayload(rng, depth + 1), token: 'access-x' }
        : {};
    case 10:
      return Object.freeze({ stage: 'signin' });
    default:
      return new Date(rng.int(1e13));
  }
}

describe(`C2 argFuzz — ${ITER} seeded hostile payloads`, () => {
  it(
    'zero-arity decisions ignore every smuggled argument, hostile this, and throwing proxies',
    () => {
      const campaignRows: Row[] = [];
      for (let i = 0; i < ITER; i += 1) {
        const seed = SEED_BASE + 100_000 + i;
        const rng = mulberry32(seed);
        const started = nowMs();
        const argc = rng.int(5);
        const args: unknown[] = [];
        for (let k = 0; k < argc; k += 1) args.push(hostilePayload(rng));
        const thisArg = hostilePayload(rng);
        let detail: string | undefined;
        for (const name of GATE_NAMES) {
          const fn = GATE[name] as unknown as Smuggled;
          try {
            const direct = fn(...args);
            const called = fn.call(thisArg, ...args);
            const applied = fn.apply(thisArg, args);
            if (
              direct !== EXPECTED[name] ||
              called !== EXPECTED[name] ||
              applied !== EXPECTED[name]
            ) {
              detail = `${name}(${argc} args) → ${String(direct)}/${String(called)}/${String(applied)} expected ${EXPECTED[name]}`;
              break;
            }
            if (fn.length !== 0) {
              detail = `${name}.length=${fn.length} (declared arity must stay 0)`;
              break;
            }
          } catch (e) {
            detail = `${name} threw with smuggled args: ${e instanceof Error ? e.message : String(e)}`;
            break;
          }
        }
        const row: Row = {
          campaign: 'C2_argFuzz',
          index: i,
          seed,
          outcome: detail === undefined ? 'HELD' : 'BROKEN',
          actors: argc,
          wallMs: Math.round((nowMs() - started) * 1000) / 1000,
          ...(detail === undefined ? {} : { detail }),
        };
        campaignRows.push(row);
        record(row);
      }
      expect(violations(campaignRows)).toEqual([]);
      expect(campaignRows).toHaveLength(ITER);
    },
    CAMPAIGN_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// C3 — App.tsx Gate wiring MODEL (App.tsx:202-216; INFERRED from source).
//
//   signin:     <SignInScreen onBack={() => set('welcome')} />
//   onboarding: <OnboardingScreen onFinished={() => set(stageAfterOnboarding())}
//                                 onBack={() => set(stageWhenLeavingOnboarding())} />
//   welcome:    <WelcomeScreen onGetStarted={() => set(stageAfterGetStarted())}
//                              onSignIn={() => set('signin')} />
//
// A callback can only be pressed on the screen that is mounted, so an event
// is APPLIED only when the current stage owns it; otherwise it is IGNORED
// (recorded, never applied). The real mount is pinned by
// __tests__/wf/App.buttons.test.tsx; this model exercises the reducer under
// far more sequences than a rendered App can afford.
// ---------------------------------------------------------------------------

type GateEvent =
  'GET_STARTED' | 'LINK_SIGNIN' | 'ONB_FINISHED' | 'ONB_BACK' | 'SIGNIN_BACK';

const EVENTS: readonly GateEvent[] = [
  'GET_STARTED',
  'LINK_SIGNIN',
  'ONB_FINISHED',
  'ONB_BACK',
  'SIGNIN_BACK',
];

const STAGES: readonly PreAuthStage[] = ['welcome', 'onboarding', 'signin'];

const OWNER: Record<GateEvent, PreAuthStage> = {
  GET_STARTED: 'welcome',
  LINK_SIGNIN: 'welcome',
  ONB_FINISHED: 'onboarding',
  ONB_BACK: 'onboarding',
  SIGNIN_BACK: 'signin',
};

/** The App.tsx callback body for an event (what setPreAuthStage receives). */
function callbackValue(event: GateEvent): PreAuthStage {
  switch (event) {
    case 'GET_STARTED':
      return stageAfterGetStarted();
    case 'LINK_SIGNIN':
      return 'signin';
    case 'ONB_FINISHED':
      return stageAfterOnboarding();
    case 'ONB_BACK':
      return stageWhenLeavingOnboarding();
    case 'SIGNIN_BACK':
      return 'welcome';
  }
}

interface Transition {
  from: PreAuthStage;
  event: GateEvent;
  to: PreAuthStage;
  applied: boolean;
}

interface GateCell {
  stage: PreAuthStage;
  log: Transition[];
}

function dispatch(cell: GateCell, event: GateEvent): Transition {
  const from = cell.stage;
  if (OWNER[event] !== from) {
    const t: Transition = { from, event, to: from, applied: false };
    cell.log.push(t);
    return t;
  }
  const to = callbackValue(event);
  cell.stage = to;
  const t: Transition = { from, event, to, applied: true };
  cell.log.push(t);
  return t;
}

/** The no-skip contract, checked over a transition log. */
function checkLog(log: Transition[], label: string): string | undefined {
  let applied = 0;
  for (let i = 0; i < log.length; i += 1) {
    const t = log[i];
    if (t === undefined) return `${label}: hole at ${i}`;
    if (!t.applied) {
      if (t.to !== t.from)
        return `${label}[${i}]: ignored event ${t.event} moved ${t.from}→${t.to}`;
      continue;
    }
    applied += 1;
    if (t.to === 'signin') {
      const legit =
        (t.event === 'LINK_SIGNIN' && t.from === 'welcome') ||
        (t.event === 'ONB_FINISHED' && t.from === 'onboarding');
      if (!legit)
        return `${label}[${i}]: SKIP — reached signin via ${t.event} from ${t.from}`;
    }
    if (
      t.to === 'onboarding' &&
      !(t.event === 'GET_STARTED' && t.from === 'welcome')
    ) {
      return `${label}[${i}]: entered onboarding via ${t.event} from ${t.from}`;
    }
    if (t.event === 'GET_STARTED' && t.to !== 'onboarding') {
      return `${label}[${i}]: Start landed on ${t.to}, not onboarding`;
    }
    if (t.event === 'ONB_BACK' && t.to !== 'welcome') {
      return `${label}[${i}]: step-one Back landed on ${t.to}, not welcome`;
    }
    if (t.event === 'ONB_FINISHED' && t.to !== 'signin') {
      return `${label}[${i}]: finishing onboarding landed on ${t.to}, not signin`;
    }
  }
  const expectedApplied = log.filter(t => OWNER[t.event] === t.from).length;
  if (applied !== expectedApplied) {
    return `${label}: applied=${applied} but ${expectedApplied} events were owned by their stage (lost/duplicated update)`;
  }
  return undefined;
}

describe('C3 wiring — App.tsx Gate reducer model', () => {
  it('exhaustive 3 stages × 5 events: the only doors into sign-in are the explicit link and finishing onboarding', () => {
    const table: Array<{
      from: PreAuthStage;
      event: GateEvent;
      to: PreAuthStage;
      applied: boolean;
    }> = [];
    for (const from of STAGES) {
      for (const event of EVENTS) {
        const cell: GateCell = { stage: from, log: [] };
        const t = dispatch(cell, event);
        table.push({ from, event, to: t.to, applied: t.applied });
      }
    }
    expect(table).toEqual([
      {
        from: 'welcome',
        event: 'GET_STARTED',
        to: 'onboarding',
        applied: true,
      },
      { from: 'welcome', event: 'LINK_SIGNIN', to: 'signin', applied: true },
      { from: 'welcome', event: 'ONB_FINISHED', to: 'welcome', applied: false },
      { from: 'welcome', event: 'ONB_BACK', to: 'welcome', applied: false },
      { from: 'welcome', event: 'SIGNIN_BACK', to: 'welcome', applied: false },
      {
        from: 'onboarding',
        event: 'GET_STARTED',
        to: 'onboarding',
        applied: false,
      },
      {
        from: 'onboarding',
        event: 'LINK_SIGNIN',
        to: 'onboarding',
        applied: false,
      },
      {
        from: 'onboarding',
        event: 'ONB_FINISHED',
        to: 'signin',
        applied: true,
      },
      { from: 'onboarding', event: 'ONB_BACK', to: 'welcome', applied: true },
      {
        from: 'onboarding',
        event: 'SIGNIN_BACK',
        to: 'onboarding',
        applied: false,
      },
      { from: 'signin', event: 'GET_STARTED', to: 'signin', applied: false },
      { from: 'signin', event: 'LINK_SIGNIN', to: 'signin', applied: false },
      { from: 'signin', event: 'ONB_FINISHED', to: 'signin', applied: false },
      { from: 'signin', event: 'ONB_BACK', to: 'signin', applied: false },
      { from: 'signin', event: 'SIGNIN_BACK', to: 'welcome', applied: true },
    ]);
    // No applied transition lands on 'signin' except the two legitimate doors.
    const doors = table
      .filter(t => t.applied && t.to === 'signin')
      .map(t => `${t.from}:${t.event}`);
    expect(doors.sort()).toEqual([
      'onboarding:ONB_FINISHED',
      'welcome:LINK_SIGNIN',
    ]);
  });

  it(
    `${ITER} seeded random walks: no walk ever skips the questionnaire`,
    () => {
      const campaignRows: Row[] = [];
      const doorsUsed = {
        LINK_SIGNIN: 0,
        ONB_FINISHED: 0,
        ONB_BACK: 0,
        GET_STARTED: 0,
      };
      for (let i = 0; i < ITER; i += 1) {
        const seed = SEED_BASE + 200_000 + i;
        const rng = mulberry32(seed);
        const started = nowMs();
        const cell: GateCell = { stage: 'welcome', log: [] };
        const steps = 1 + rng.int(64);
        for (let s = 0; s < steps; s += 1) {
          const t = dispatch(cell, rng.pick(EVENTS));
          if (t.applied && t.event !== 'SIGNIN_BACK') doorsUsed[t.event] += 1;
        }
        const detail = checkLog(cell.log, `walk seed=${seed}`);
        const row: Row = {
          campaign: 'C3_wiring',
          index: i,
          seed,
          outcome: detail === undefined ? 'HELD' : 'BROKEN',
          actors: steps,
          wallMs: Math.round((nowMs() - started) * 1000) / 1000,
          ...(detail === undefined ? {} : { detail }),
        };
        campaignRows.push(row);
        record(row);
      }
      expect(violations(campaignRows)).toEqual([]);
      expect(campaignRows).toHaveLength(ITER);
      // Coverage: the walks reached sign-in through BOTH doors and exercised
      // Start and step-one Back, so the no-skip assertions had teeth.
      expect(doorsUsed.GET_STARTED).toBeGreaterThan(0);
      expect(doorsUsed.LINK_SIGNIN).toBeGreaterThan(0);
      expect(doorsUsed.ONB_FINISHED).toBeGreaterThan(0);
      expect(doorsUsed.ONB_BACK).toBeGreaterThan(0);
    },
    CAMPAIGN_TIMEOUT_MS,
  );

  it(
    `${ITER} seeded two-cell bursts: interleaved actors on two Gate instances stay linearizable and isolated`,
    async () => {
      const campaignRows: Row[] = [];
      for (let i = 0; i < ITER; i += 1) {
        const seed = SEED_BASE + 300_000 + i;
        const rng = mulberry32(seed);
        const started = nowMs();
        const cells: [GateCell, GateCell] = [
          { stage: 'welcome', log: [] },
          { stage: 'welcome', log: [] },
        ];
        const count = 2 + rng.int(63);
        const plan = Array.from({ length: count }, () => ({
          cell: rng.int(2) as 0 | 1,
          event: rng.pick(EVENTS),
          slot: randomSlot(rng),
        }));
        // Actual application order per cell, as observed by the scheduler.
        const order: [GateEvent[], GateEvent[]] = [[], []];
        let detail: string | undefined;
        try {
          await withDeadline(
            Promise.all(
              plan.map(a =>
                schedule(a.slot, () => {
                  order[a.cell].push(a.event);
                  dispatch(cells[a.cell], a.event);
                }),
              ),
            ),
            BURST_DEADLINE_MS,
            `two-cell seed=${seed}`,
          );
          for (const c of [0, 1] as const) {
            // Linearizability: the cell's final stage equals a sequential
            // replay of exactly the events it received, in the order the
            // scheduler delivered them — nothing lost, nothing applied twice.
            const replay: GateCell = { stage: 'welcome', log: [] };
            for (const ev of order[c]) dispatch(replay, ev);
            if (replay.stage !== cells[c].stage) {
              detail = `cell${c}: final=${cells[c].stage} replay=${replay.stage}`;
              break;
            }
            if (cells[c].log.length !== order[c].length) {
              detail = `cell${c}: log=${cells[c].log.length} delivered=${order[c].length}`;
              break;
            }
            detail = checkLog(cells[c].log, `cell${c} seed=${seed}`);
            if (detail !== undefined) break;
          }
          if (
            detail === undefined &&
            order[0].length + order[1].length !== count
          ) {
            detail = `delivered ${order[0].length + order[1].length} of ${count} events`;
          }
        } catch (e) {
          detail = e instanceof Error ? e.message : String(e);
        }
        const row: Row = {
          campaign: 'C3_wiring',
          index: ITER + i,
          seed,
          outcome: detail === undefined ? 'HELD' : 'BROKEN',
          actors: count,
          wallMs: Math.round((nowMs() - started) * 1000) / 1000,
          ...(detail === undefined ? {} : { detail }),
        };
        campaignRows.push(row);
        record(row);
      }
      expect(violations(campaignRows)).toEqual([]);
      expect(campaignRows).toHaveLength(ITER);
    },
    CAMPAIGN_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// C4 — module re-evaluation racing live callers
// ---------------------------------------------------------------------------

type GateModule = typeof launchGateModule;

function loadIsolated(): GateModule {
  let loaded: GateModule | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<GateModule>('../../src/flow/launchGate');
  });
  if (loaded === undefined)
    throw new Error('isolateModules did not load the module');
  return loaded;
}

function checkModuleSurface(
  mod: GateModule,
  label: string,
): string | undefined {
  const keys = Object.keys(mod)
    .filter(k => k !== '__esModule')
    .sort();
  const expectedKeys = [
    'stageAfterGetStarted',
    'stageAfterOnboarding',
    'stageWhenLeavingOnboarding',
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    return `${label}: export surface ${JSON.stringify(keys)} ≠ ${JSON.stringify(expectedKeys)}`;
  }
  const table: Array<[keyof GateModule, PreAuthStage]> = [
    ['stageAfterGetStarted', 'onboarding'],
    ['stageAfterOnboarding', 'signin'],
    ['stageWhenLeavingOnboarding', 'welcome'],
  ];
  for (const [key, expected] of table) {
    const fn = mod[key];
    if (typeof fn !== 'function') return `${label}: ${key} is ${typeof fn}`;
    if (fn.length !== 0) return `${label}: ${key}.length=${fn.length}`;
    const got = fn();
    if (got !== expected)
      return `${label}: ${key}() → ${String(got)} expected ${expected}`;
  }
  return undefined;
}

const RELOADS = Math.max(1, Math.floor(ITER / 10));

describe(`C4 reload — ${RELOADS} seeded module re-evaluations racing live callers`, () => {
  const reloads = RELOADS;
  it(
    'a freshly evaluated module instance and the live one agree on every decision, and the export surface has exactly three zero-arity functions',
    async () => {
      const campaignRows: Row[] = [];
      expect(checkModuleSurface(launchGateModule, 'live')).toBeUndefined();
      for (let i = 0; i < reloads; i += 1) {
        const seed = SEED_BASE + 400_000 + i;
        const rng = mulberry32(seed);
        const started = nowMs();
        const callers = 1 + rng.int(16);
        let detail: string | undefined;
        try {
          const outcomes = await withDeadline(
            Promise.all([
              schedule(randomSlot(rng), () =>
                checkModuleSurface(loadIsolated(), `reload seed=${seed}`),
              ),
              ...Array.from({ length: callers }, () => {
                const gate = rng.pick(GATE_NAMES);
                return schedule(randomSlot(rng), () =>
                  GATE[gate]() === EXPECTED[gate]
                    ? undefined
                    : `live ${gate}() drifted during reload`,
                );
              }),
            ]),
            BURST_DEADLINE_MS,
            `reload seed=${seed}`,
          );
          detail = outcomes.find(o => o !== undefined);
        } catch (e) {
          detail = e instanceof Error ? e.message : String(e);
        }
        const row: Row = {
          campaign: 'C4_reload',
          index: i,
          seed,
          outcome: detail === undefined ? 'HELD' : 'BROKEN',
          actors: callers + 1,
          wallMs: Math.round((nowMs() - started) * 1000) / 1000,
          ...(detail === undefined ? {} : { detail }),
        };
        campaignRows.push(row);
        record(row);
      }
      expect(violations(campaignRows)).toEqual([]);
      expect(campaignRows).toHaveLength(reloads);
    },
    CAMPAIGN_TIMEOUT_MS,
  );
});
