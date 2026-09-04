/**
 * STRESS — mod-sync-runtime / lens `randomized-seeded`.
 *
 * Seeded randomized long-run over the PUBLIC surface of the sync runtime
 * (`configureSyncRuntime` / `clearSyncRuntime` / `triggerOutboxSync`, the
 * AppState 'change' listener it installs, the api-session + active-owner
 * stores it reads) and the offline-capability status derivation
 * (`deriveUploadQueueStatus`). Real `drainOutbox` + real `createTransport`
 * run against an in-memory LocalDb and a fetch mock that plays a server with
 * switchable network weather (online / offline / 401 / 429 / 500 / 400 /
 * hung-until-timeout / per-item permanent rejections).
 *
 * Each sequence: seed → 5..60 generated actions (reconnect storms, app-state
 * flaps, sign-out/sign-in/account switch, token rotation, enqueue of
 * well-formed / malformed / orphan rows, network weather changes, held
 * responses released later, clock advances across the back-off ceiling,
 * SQLite fault injection), then a settle phase (network online, clock runs
 * past several retry ceilings) that asserts eventual delivery.
 *
 * Invariants (model-checked after every flushed step; names match the
 * `violations[].invariant` field in the results JSON):
 *   I1  no_overlap_per_generation      — a runtime generation never has two
 *                                        requests in flight (syncRuntime.ts
 *                                        runningGenerations).
 *   I2  dead_generation_stays_dead     — once a cleared/replaced generation
 *                                        is quiescent it never issues another
 *                                        request (generation guard).
 *   I3  drain_owner_is_live_owner      — a drain only starts while the active
 *                                        data owner is the live runtime's
 *                                        owner (owner check before drain).
 *   I4  timers_bounded                 — fake-timer count == request timers
 *                                        in flight + at most one retry timer
 *                                        (exactly one when the live runtime
 *                                        is idle; zero when there is none).
 *   I5  receipt_implies_server_accept  — every sync_receipt names a shot the
 *                                        server accepted, for its owner.
 *   I6  row_removed_only_after_accept  — an outbox row disappears only after
 *                                        the server accepted its entity;
 *                                        malformed rows are never removed.
 *   I7  attempts_bounded_by_verdicts   — attempts <= permanent verdicts the
 *                                        server issued for the row and
 *                                        <= OUTBOX_MAX_ATTEMPTS (transient
 *                                        failures never burn budget).
 *   I8  parked_rows_never_sent         — a row at OUTBOX_MAX_ATTEMPTS is not
 *                                        put on the wire again.
 *   I9  no_open_transaction            — no orphaned BEGIN after a flush.
 *   I10 bearer_bound_to_owner          — every request carries exactly the
 *                                        bearer `bearerTokenFor(owner)` yields
 *                                        at send time (never a successor
 *                                        account's token) and every request
 *                                        of a generation is for its owner.
 *   I11 batch_single_owner             — one request never mixes owners.
 *   I12 queue_status_consistent        — deriveUploadQueueStatus(rows) agrees
 *                                        with an independent computation.
 *   I13 no_drain_without_runtime       — no timer-driven drain while no
 *                                        runtime is configured.
 *   I14 timer_cadence_bounds           — a timer-driven drain starts >= 24s
 *                                        (BASE*(1-jitter)) after the previous
 *                                        drain start of that generation and
 *                                        <= 380s (MAX*(1+jitter) + request
 *                                        timeout) after it.
 *   I15 listeners_bounded              — exactly one AppState listener per
 *                                        live runtime, none otherwise.
 *   I16 no_cross_owner_write           — UPDATE/DELETE on outbox and receipt
 *                                        inserts name the row's owner.
 *   I17 configure_builds_one_transport — configureSyncRuntime creates exactly
 *                                        one transport.
 *   I18 no_concurrent_transactions     — a BEGIN IMMEDIATE never opens while
 *                                        another transaction on the same
 *                                        connection is open. The harness
 *                                        refuses the nested BEGIN exactly like
 *                                        SQLite ("cannot start a transaction
 *                                        within a transaction") so the drain
 *                                        that loses the race sees the real
 *                                        error and the remaining invariants
 *                                        observe the real consequence.
 *                                        KNOWN OPEN (finding F1, see the
 *                                        `test.failing` at the bottom): a
 *                                        stale generation whose request is
 *                                        still in flight keeps draining after
 *                                        configureSyncRuntime replaced it, so
 *                                        two drains of one owner interleave on
 *                                        one connection. Seeds that violate
 *                                        only known-open invariants are still
 *                                        reported BROKEN in results.json but do
 *                                        not fail the gate; delete the entry
 *                                        from KNOWN_OPEN_FINDINGS once fixed
 *                                        (the failing test flips red then).
 *   I19 stale_generation_keeps_draining — the DB handle a drain took via
 *                                        getDb() is never used again once its
 *                                        generation has been superseded
 *                                        (clearSyncRuntime / configureSyncRuntime
 *                                        neither await nor cancel the in-flight
 *                                        drainOutbox of the generation they
 *                                        retire). This is the ROOT CAUSE of F1;
 *                                        I18 and the F1_CONSEQUENCES below
 *                                        (attempts overshooting
 *                                        OUTBOX_MAX_ATTEMPTS or an exhausted row
 *                                        being sent once more because two
 *                                        drains selected the same row at MAX-1)
 *                                        are its downstream effects.
 *                                        A seed counts as known-open only when
 *                                        I19 fired in that run AND every other
 *                                        violation is in F1_CONSEQUENCES; any
 *                                        violation without an I19 root cause
 *                                        in the same run fails the gate.
 *   S1  settle_well_formed_delivered   — after settle every well-formed,
 *                                        non-orphan row of the live owner is
 *                                        gone (shots have receipts).
 *   S2  settle_malformed_parked        — malformed rows are still present and
 *                                        parked (attempts >= OUTBOX_MAX_ATTEMPTS;
 *                                        I7 owns the upper bound).
 *   S3  settle_orphans_durable         — orphan shots stay queued (never
 *                                        dropped) with attempts <= verdicts.
 *   S4  settle_other_owner_untouched   — the non-live owner's rows do not
 *                                        change during settle.
 *   S5  settle_quiescent               — the outbox reaches quiescence within
 *                                        the settle budget (no livelock).
 *   D1  deterministic_replay           — the same seed replays to an identical
 *                                        event trace.
 *
 * Scale / replay:
 *   STRESS_ITER=<n>        sequences (default 40; campaign used 2000)
 *   STRESS_SEED_BASE=<n>   first seed (default 20260904)
 *   STRESS_SEED=<n>        replay exactly one seed
 *   STRESS_REPLAY=0|1      determinism replay of every seed (default 1)
 *   STRESS_RUN_ID=<id>     results dir under artifacts/stress/… (default local)
 *   STRESS_TRACE=1         keep the full event trace of every seed in results
 *
 * Replay a failing seed:
 *   STRESS_SEED=<seed> npx jest __tests__/stress/syncRuntimeRandomizedSeeded
 */
import { AppState } from 'react-native';
import { getDb, type LocalDb } from '../../src/data/db';
import {
  API_REQUEST_TIMEOUT_MS,
  createTransport,
  type ApiConfigState,
} from '../../src/data/api';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  type SyncTransport,
} from '../../src/data/sync';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  SYNC_RETRY_MAX_MS,
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  deriveUploadQueueStatus,
  type OutboxRowStatus,
} from '../../src/data/offlineCapabilities';
import {
  createFakeLocalDb,
  type FakeLocalDb,
} from '../../testing/xcBehavioral/fakeLocalDb';
import { randomInt, seededRandom } from '../../testing/xcBehavioral/evidence';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/api', () => {
  const actual =
    jest.requireActual<typeof import('../../src/data/api')>(
      '../../src/data/api',
    );
  return { ...actual, createTransport: jest.fn() };
});

// Node built-ins for the results sink; the mobile tsconfig excludes node
// typings (same convention as testing/xcBehavioral/evidence.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

// ─── Scale knobs ─────────────────────────────────────────────────────────────

const ENV = process.env;
const ITER = Math.max(1, Number(ENV['STRESS_ITER'] ?? '40') || 40);
const SEED_BASE = Number(ENV['STRESS_SEED_BASE'] ?? '20260904') || 20260904;
const ONLY_SEED =
  ENV['STRESS_SEED'] !== undefined ? Number(ENV['STRESS_SEED']) : null;
const REPLAY = (ENV['STRESS_REPLAY'] ?? '1') !== '0';
const RUN_ID = ENV['STRESS_RUN_ID'] ?? 'local';
const KEEP_TRACE = ENV['STRESS_TRACE'] === '1';
const MIN_LEN = 5;
const MAX_LEN = 60;
const BATCH = 25;

/** Root-cause invariants with an open finding on the baseline (I19 → F1). */
const KNOWN_OPEN_FINDINGS: ReadonlySet<string> = new Set([
  'stale_generation_keeps_draining',
]);

/**
 * Invariants that an I19 overlap is known to knock over in the same run. They
 * are attributed to F1 only when I19 actually fired in that run.
 */
const F1_CONSEQUENCES: ReadonlySet<string> = new Set([
  'no_concurrent_transactions',
  'attempts_bounded_by_verdicts',
  'parked_rows_never_sent',
]);

function attributedToKnownOpen(violations: readonly Violation[]): boolean {
  if (violations.length === 0) return false;
  const rootCauseFired = violations.some(v =>
    KNOWN_OPEN_FINDINGS.has(v.invariant),
  );
  return violations.every(
    v =>
      KNOWN_OPEN_FINDINGS.has(v.invariant) ||
      (rootCauseFired && F1_CONSEQUENCES.has(v.invariant)),
  );
}

/** Minimised plan of seed 20260960 (finding F1): a hung request, a durable
 * row, then two configureSyncRuntime calls for the same account while the
 * request is still in flight. */
const F1_STALE_GENERATION_PLAN: Step[] = [
  { action: { t: 'net', mode: 'hang' }, flush: false },
  {
    action: {
      t: 'enqueue',
      owner: 'live',
      kind: 'shot',
      count: 2,
      triggerAfter: false,
    },
    flush: true,
  },
  { action: { t: 'configure', user: 'A' }, flush: true },
  { action: { t: 'configure', user: 'A' }, flush: true },
];

/** Hand-minimised variant of seed 20261142 (finding F1, consequence b): a
 * malformed row is driven to OUTBOX_MAX_ATTEMPTS-1 by seven separate drains,
 * then a trigger starts an eighth drain (no flush, so it is mid-SELECT) and
 * configureSyncRuntime immediately starts a ninth in the new generation. */
const F1_ATTEMPTS_OVERSHOOT_PLAN: Step[] = [
  {
    action: {
      t: 'enqueue',
      owner: 'A',
      kind: 'corruptTrial',
      count: 1,
      triggerAfter: false,
    },
    flush: true,
  },
  { action: { t: 'configure', user: 'A' }, flush: true },
  ...Array.from({ length: OUTBOX_MAX_ATTEMPTS - 2 }, (): Step => ({
    action: { t: 'trigger', n: 1 },
    flush: true,
  })),
  { action: { t: 'trigger', n: 1 }, flush: false },
  { action: { t: 'configure', user: 'A' }, flush: true },
];

function resultsDir(): string {
  // apps/mobile/__tests__/stress → repo root
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  return path.join(
    root,
    'artifacts',
    'stress',
    'mod-sync-runtime-randomized-seeded',
    RUN_ID,
  );
}

// ─── Fixed identities ────────────────────────────────────────────────────────

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
type UserKey = 'A' | 'B';
const USERS: Record<UserKey, string> = { A: USER_A, B: USER_B };
const OWNER_OF: Record<UserKey, string> = {
  A: canonicalDataOwner(USER_A),
  B: canonicalDataOwner(USER_B),
};
const USER_OF_OWNER = new Map<string, UserKey>([
  [OWNER_OF.A, 'A'],
  [OWNER_OF.B, 'B'],
]);
const BASE_URL = 'https://api.stress.test';

const MIN_RETRY_GAP_MS = Math.round(
  SYNC_RETRY_BASE_MS * (1 - SYNC_RETRY_JITTER_RATIO),
);
const MAX_RETRY_GAP_MS =
  Math.round(SYNC_RETRY_MAX_MS * (1 + SYNC_RETRY_JITTER_RATIO)) +
  API_REQUEST_TIMEOUT_MS;

// ─── Action grammar (JSON-serialisable so minimised plans can be recorded) ──

type AppStateName = 'active' | 'background' | 'inactive';
type NetMode =
  | 'online'
  | 'offline'
  | 'hang'
  | 'http401'
  | 'http429'
  | 'http500'
  | 'http400'
  | 'partial_reject';
type EnqueueKind =
  | 'shot'
  | 'shotThenSession'
  | 'sessionThenShot'
  | 'orphanShot'
  | 'sessionFinalize'
  | 'trial'
  | 'corruptShot'
  | 'noPermitShot'
  | 'corruptSession'
  | 'unknownKind'
  | 'corruptTrial';
type FaultNeedle =
  | 'INSERT OR REPLACE INTO sync_receipt'
  | 'COMMIT'
  | 'DELETE FROM outbox'
  | 'SELECT id, kind, payload'
  | 'UPDATE outbox';

type Action =
  | { t: 'configure'; user: UserKey }
  | { t: 'signOut' }
  | { t: 'appState'; states: AppStateName[] }
  | { t: 'trigger'; n: number }
  | {
      t: 'enqueue';
      owner: UserKey | 'live';
      kind: EnqueueKind;
      count: number;
      triggerAfter: boolean;
    }
  | { t: 'net'; mode: NetMode }
  | { t: 'release'; all: boolean }
  | { t: 'advance'; ms: number; chunk: number }
  | { t: 'rotateToken' }
  | { t: 'ownerDrift'; owner: UserKey | 'signedOut' }
  | { t: 'dbFault'; needle: FaultNeedle }
  | { t: 'flushOnly' };

interface Step {
  action: Action;
  flush: boolean;
}

const NET_MODES: NetMode[] = [
  'online',
  'online',
  'online',
  'offline',
  'hang',
  'http401',
  'http429',
  'http500',
  'http400',
  'partial_reject',
];
const ENQUEUE_KINDS: EnqueueKind[] = [
  'shot',
  'shot',
  'shot',
  'shotThenSession',
  'shotThenSession',
  'sessionThenShot',
  'orphanShot',
  'sessionFinalize',
  'trial',
  'corruptShot',
  'noPermitShot',
  'corruptSession',
  'unknownKind',
  'corruptTrial',
];
const FAULTS: FaultNeedle[] = [
  'INSERT OR REPLACE INTO sync_receipt',
  'COMMIT',
  'DELETE FROM outbox',
  'SELECT id, kind, payload',
  'UPDATE outbox',
];
const APP_STATES: AppStateName[] = ['active', 'background', 'inactive'];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[randomInt(random, 0, items.length - 1)]!;
}

function generateAction(random: () => number, orphansSoFar: number): Action {
  const roll = randomInt(random, 1, 100);
  if (roll <= 14) return { t: 'configure', user: random() < 0.7 ? 'A' : 'B' };
  if (roll <= 20) return { t: 'signOut' };
  if (roll <= 36) {
    const burst = randomInt(random, 1, 12);
    return {
      t: 'appState',
      states: Array.from({ length: burst }, () => pick(random, APP_STATES)),
    };
  }
  if (roll <= 48) return { t: 'trigger', n: randomInt(random, 1, 10) };
  if (roll <= 64) {
    let kind = pick(random, ENQUEUE_KINDS);
    if (kind === 'orphanShot' && orphansSoFar >= 3) kind = 'shot';
    return {
      t: 'enqueue',
      owner: random() < 0.75 ? 'live' : random() < 0.6 ? 'A' : 'B',
      kind,
      count: randomInt(random, 1, kind === 'shot' ? 6 : 2),
      triggerAfter: random() < 0.6,
    };
  }
  if (roll <= 76) return { t: 'net', mode: pick(random, NET_MODES) };
  if (roll <= 82) return { t: 'release', all: random() < 0.5 };
  if (roll <= 93) {
    const scale = random();
    const ms =
      scale < 0.4
        ? randomInt(random, 0, 2_000)
        : scale < 0.8
          ? randomInt(random, 2_000, 90_000)
          : randomInt(random, 90_000, 7 * 60_000);
    return { t: 'advance', ms, chunk: pick(random, [1_000, 5_000, 10_000]) };
  }
  if (roll <= 96) return { t: 'rotateToken' };
  if (roll <= 98) {
    return {
      t: 'ownerDrift',
      owner: pick(random, ['A', 'B', 'signedOut'] as const),
    };
  }
  return { t: 'dbFault', needle: pick(random, FAULTS) };
}

function generatePlan(seed: number): Step[] {
  const random = seededRandom(seed);
  const length = randomInt(random, MIN_LEN, MAX_LEN);
  const steps: Step[] = [];
  let orphans = 0;
  for (let i = 0; i < length; i += 1) {
    const action = generateAction(random, orphans);
    if (action.t === 'enqueue' && action.kind === 'orphanShot') {
      orphans += action.count;
    }
    steps.push({ action, flush: random() < 0.8 });
  }
  return steps;
}

// ─── Payloads ────────────────────────────────────────────────────────────────

function shotPayload(id: string, sessionId: string | null) {
  return {
    id,
    sessionId,
    shotType: 'drive',
    stroke: 'drive',
    handedness: 'right',
    cameraView: 'side',
    createdAt: '2026-09-04T10:00:00.000Z',
    capturedAtIso: '2026-09-04T10:00:00.000Z',
    modelVersion: 'm1',
    pipelineVersion: 'p1',
    versionVector: { model: 'm1', pipeline: 'p1' },
    overallScore: 70,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    source: 'device',
    timestamps: {},
    phases: [],
    checkpoints: [],
    analysisPermitId: `permit-${id}`,
  };
}

function sessionFor(user: UserKey, tokenVersion: number): ApiSession {
  return {
    apiBaseUrl: BASE_URL,
    bearerToken: `tok-${user}-v${tokenVersion}`,
    canonicalAppUserId: USERS[user],
    provider: 'apple',
  };
}

// ─── Model ───────────────────────────────────────────────────────────────────

interface Violation {
  invariant: string;
  step: number;
  detail: string;
}

interface RowMeta {
  rowId: number;
  owner: string;
  kind: string;
  /** Server-facing id (shot id / session id / trial id); null when malformed. */
  entityId: string | null;
  wellFormed: boolean;
  /** Shot whose practice-set session row was never queued. */
  orphan: boolean;
  sessionId: string | null;
}

interface GenerationState {
  gen: number;
  owner: string;
  user: UserKey;
  deadAtStep: number | null;
  quiescentAfterDeath: boolean;
  inFlight: number;
  maxInFlight: number;
  calls: number;
  lastDrainStartMs: number | null;
}

interface HeldRequest {
  resolve: (response: FakeResponse) => void;
  response: FakeResponse;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

class Model {
  readonly fake: FakeLocalDb;
  readonly violations: Violation[] = [];
  readonly trace: string[] = [];
  readonly rows = new Map<number, RowMeta>();
  readonly entityOwner = new Map<string, string>();
  readonly entityRow = new Map<string, number>();
  readonly serverAccepted = new Map<string, number>();
  readonly permanentVerdicts = new Map<string, number>();
  readonly knownSessions = new Set<string>();
  readonly generations = new Map<number, GenerationState>();
  readonly appStateHandlers = new Map<number, (state: string) => void>();
  readonly held: HeldRequest[] = [];
  readonly serverRandom: () => number;
  net: NetMode = 'online';
  live: GenerationState | null = null;
  pendingConfigure: UserKey | null = null;
  transportsCreatedThisConfigure = 0;
  currentCallGen: number | null = null;
  step = 0;
  timerDriven = false;
  requests = 0;
  drains = 0;
  duplicateSends = 0;
  nestedBeginRefused = 0;
  staleGenerationDbOps = 0;
  readonly staleReportedGens = new Set<number>();
  faultsInjected = 0;
  faultsConsumed = 0;
  openTxDepth = 0;
  tokenVersion: Record<UserKey, number> = { A: 1, B: 1 };
  nextEntity = 0;
  nextGen = 0;
  nextHandler = 0;

  constructor(
    fake: FakeLocalDb,
    readonly seed: number,
  ) {
    this.fake = fake;
    this.serverRandom = seededRandom((seed ^ 0x85ebca6b) >>> 0);
  }

  record(line: string) {
    this.trace.push(`${this.step}|${line}`);
  }

  violate(invariant: string, detail: string) {
    this.violations.push({ invariant, step: this.step, detail });
    this.record(`VIOLATION ${invariant} ${detail}`);
  }

  check(condition: boolean, invariant: string, detail: () => string) {
    if (!condition) this.violate(invariant, detail());
  }

  newEntity(prefix: string): string {
    this.nextEntity += 1;
    return `${prefix}-${this.seed}-${this.nextEntity}`;
  }

  ownerKey(owner: UserKey | 'live'): string | null {
    if (owner === 'live') return this.live ? this.live.owner : null;
    return OWNER_OF[owner];
  }

  registerRow(
    rowId: number,
    owner: string,
    kind: string,
    entityId: string | null,
    wellFormed: boolean,
    orphan: boolean,
    sessionId: string | null,
  ) {
    this.rows.set(rowId, {
      rowId,
      owner,
      kind,
      entityId,
      wellFormed,
      orphan,
      sessionId,
    });
    if (entityId) {
      this.entityOwner.set(entityId, owner);
      this.entityRow.set(entityId, rowId);
    }
  }

  // ── transport / server ────────────────────────────────────────────────────

  buildTransport(config: ApiConfigState, real: SyncTransport): SyncTransport {
    const user = this.pendingConfigure;
    if (!user) {
      this.violate(
        'configure_builds_one_transport',
        'transport outside configure',
      );
    }
    this.transportsCreatedThisConfigure += 1;
    this.nextGen += 1;
    const state: GenerationState = {
      gen: this.nextGen,
      owner: user ? OWNER_OF[user] : 'unknown',
      user: user ?? 'A',
      deadAtStep: null,
      quiescentAfterDeath: false,
      inFlight: 0,
      maxInFlight: 0,
      calls: 0,
      lastDrainStartMs: null,
    };
    this.generations.set(state.gen, state);
    if (this.live) this.live.deadAtStep = this.step;
    this.live = state;
    this.record(`gen ${state.gen} owner=${state.owner} base=${config.baseUrl}`);
    const wrap = <A extends unknown[], R>(
      name: string,
      fn: (...args: A) => Promise<R>,
    ) => {
      return async (...args: A): Promise<R> => {
        state.calls += 1;
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        this.check(
          state.inFlight <= 1,
          'no_overlap_per_generation',
          () => `gen ${state.gen} ${name} inFlight=${state.inFlight}`,
        );
        this.check(
          !state.quiescentAfterDeath,
          'dead_generation_stays_dead',
          () =>
            `gen ${state.gen} (dead at step ${state.deadAtStep}) issued ${name}`,
        );
        this.currentCallGen = state.gen;
        this.record(`call gen=${state.gen} ${name}`);
        try {
          return await fn(...args);
        } finally {
          state.inFlight -= 1;
        }
      };
    };
    return {
      syncShots: wrap('syncShots', shots => real.syncShots(shots)),
      createSession: wrap('createSession', session =>
        real.createSession(session),
      ),
      finalizeSession: wrap('finalizeSession', id => real.finalizeSession(id)),
      uploadEvaluationTrials: wrap('uploadEvaluationTrials', trials =>
        real.uploadEvaluationTrials!(trials),
      ),
    };
  }

  private errorResponse(status: number, code: string): FakeResponse {
    return {
      ok: false,
      status,
      statusText: `HTTP ${status}`,
      json: async () => ({ error: { code, message: `${code} (${status})` } }),
    };
  }

  private okResponse(body: unknown): FakeResponse {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
    };
  }

  private countPermanent(entityIds: readonly string[]) {
    for (const id of entityIds) {
      this.permanentVerdicts.set(id, (this.permanentVerdicts.get(id) ?? 0) + 1);
    }
  }

  private accept(entityId: string) {
    const prior = this.serverAccepted.get(entityId) ?? 0;
    if (prior > 0) this.duplicateSends += 1;
    this.serverAccepted.set(entityId, prior + 1);
  }

  async fetch(url: string, init: RequestInit): Promise<FakeResponse> {
    this.requests += 1;
    const gen = this.currentCallGen;
    const genState = gen === null ? null : (this.generations.get(gen) ?? null);
    const pathname = url.startsWith(BASE_URL)
      ? url.slice(BASE_URL.length)
      : url;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const auth = headers['authorization'];
    const token = auth ? auth.replace(/^Bearer /, '') : null;
    const body =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;

    // Classify the request → entity ids + owner.
    let entityIds: string[] = [];
    let route: 'shots' | 'session' | 'finalize' | 'trials' | 'unknown' =
      'unknown';
    if (pathname === '/v1/shots:sync') {
      route = 'shots';
      const shots = (body?.['shots'] as Array<Record<string, unknown>>) ?? [];
      entityIds = shots.map(s => String(s['id']));
    } else if (pathname === '/v1/sessions') {
      route = 'session';
      const id = body?.['id'];
      entityIds = typeof id === 'string' ? [id] : [];
    } else if (/^\/v1\/sessions\/[^/]+\/finalize$/.test(pathname)) {
      route = 'finalize';
      entityIds = [pathname.split('/')[3]!];
    } else if (pathname === '/v1/me/evaluation/trials') {
      route = 'trials';
      const trials = (body?.['trials'] as Array<Record<string, unknown>>) ?? [];
      entityIds = trials.map(t => String(t['trialId']));
    } else {
      this.violate('bearer_bound_to_owner', `unexpected route ${pathname}`);
    }
    const owners = new Set(
      entityIds
        .map(id => this.entityOwner.get(id))
        .filter((o): o is string => o !== undefined),
    );
    this.check(
      owners.size <= 1,
      'batch_single_owner',
      () => `${route} mixes owners ${[...owners].join(',')}`,
    );
    const owner = owners.size === 1 ? [...owners][0]! : null;
    if (genState && owner) {
      this.check(
        genState.owner === owner,
        'bearer_bound_to_owner',
        () =>
          `gen ${genState.gen} owner ${genState.owner} sent rows of ${owner}`,
      );
    }
    const boundUser = owner
      ? USER_OF_OWNER.get(owner)
      : genState
        ? genState.user
        : undefined;
    if (boundUser) {
      const session = getApiSession();
      const expected =
        session && session.canonicalAppUserId === USERS[boundUser]
          ? session.bearerToken
          : null;
      this.check(
        token === expected,
        'bearer_bound_to_owner',
        () => `${route} sent bearer ${token} expected ${expected}`,
      );
    }
    // I8: nothing at the attempt ceiling goes on the wire.
    for (const id of entityIds) {
      const rowId = this.entityRow.get(id);
      const row =
        rowId === undefined
          ? undefined
          : this.fake.outbox.find(r => r.id === rowId);
      if (row) {
        this.check(
          row.attempts < OUTBOX_MAX_ATTEMPTS,
          'parked_rows_never_sent',
          () => `${id} sent with attempts=${row.attempts}`,
        );
      }
    }
    this.record(
      `fetch ${route} gen=${gen} net=${this.net} tok=${token} ids=${entityIds.join(',')}`,
    );

    const mode = this.net;
    if (mode === 'offline') {
      throw new TypeError('Network request failed');
    }
    if (mode === 'http401') return this.errorResponse(401, 'auth.required');
    if (mode === 'http429') return this.errorResponse(429, 'rate.limited');
    if (mode === 'http500') return this.errorResponse(500, 'internal');
    if (mode === 'http400') {
      this.countPermanent(entityIds);
      return this.errorResponse(400, 'request.invalid');
    }
    // online / hang / partial_reject: the server processes the request now
    // (a hung response was still received by the server).
    const response = this.serve(route, body, entityIds, mode);
    if (mode === 'hang') {
      return new Promise<FakeResponse>((resolve, reject) => {
        this.held.push({ resolve, response });
        const signal = init.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }
      });
    }
    return response;
  }

  private serve(
    route: string,
    body: Record<string, unknown> | null,
    entityIds: readonly string[],
    mode: NetMode,
  ): FakeResponse {
    if (route === 'session') {
      const id = body?.['id'];
      if (typeof id !== 'string' || !id) {
        this.countPermanent(entityIds);
        return this.errorResponse(400, 'session.invalid');
      }
      this.knownSessions.add(id);
      this.accept(id);
      return this.okResponse({ ok: true });
    }
    if (route === 'finalize') {
      const id = entityIds[0]!;
      if (!this.knownSessions.has(id)) {
        this.countPermanent(entityIds);
        return this.errorResponse(404, 'session.not_found');
      }
      this.accept(id);
      return this.okResponse({ ok: true });
    }
    if (route === 'shots') {
      const shots = (body?.['shots'] as Array<Record<string, unknown>>) ?? [];
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      for (const shot of shots) {
        const id = String(shot['id']);
        const sessionId = shot['sessionId'];
        if (
          typeof sessionId === 'string' &&
          !this.knownSessions.has(sessionId)
        ) {
          rejected.push({
            id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'unknown session',
          });
          continue;
        }
        if (mode === 'partial_reject' && this.serverRandom() < 0.5) {
          rejected.push({
            id,
            code: 'shot.invalid_payload',
            message: 'contract verdict',
          });
          this.countPermanent([id]);
          continue;
        }
        acceptedIds.push(id);
        this.accept(id);
      }
      return this.okResponse({ acceptedIds, rejected });
    }
    if (route === 'trials') {
      const trials = (body?.['trials'] as Array<Record<string, unknown>>) ?? [];
      const acceptedTrialIds: string[] = [];
      const rejected: Array<{
        trialId: string;
        code: string;
        message: string;
      }> = [];
      for (const trial of trials) {
        const id = String(trial['trialId']);
        if (mode === 'partial_reject' && this.serverRandom() < 0.5) {
          rejected.push({
            trialId: id,
            code: 'evaluation.trial_invalid',
            message: 'contract verdict',
          });
          this.countPermanent([id]);
          continue;
        }
        acceptedTrialIds.push(id);
        this.accept(id);
      }
      return this.okResponse({ acceptedTrialIds, rejected });
    }
    return this.errorResponse(404, 'route.unknown');
  }

  // ── db observation ────────────────────────────────────────────────────────

  wrapDb(db: LocalDb, gen: GenerationState | null): LocalDb {
    return {
      execute: async (sql: string, params: unknown[] = []) => {
        if (gen && gen.deadAtStep !== null) {
          this.staleGenerationDbOps += 1;
          if (!this.staleReportedGens.has(gen.gen)) {
            this.staleReportedGens.add(gen.gen);
            this.violate(
              'stale_generation_keeps_draining',
              `gen ${gen.gen} (dead at step ${gen.deadAtStep}) ran "${sql.slice(0, 28)}" while ${this.live ? `gen ${this.live.gen} is live` : 'no runtime is live'}`,
            );
          } else {
            this.record(`stale gen=${gen.gen} ${sql.slice(0, 28)}`);
          }
        }
        if (sql === 'BEGIN IMMEDIATE') {
          if (this.openTxDepth > 0) {
            this.violate(
              'no_concurrent_transactions',
              `BEGIN IMMEDIATE while ${this.openTxDepth} transaction(s) open`,
            );
            this.nestedBeginRefused += 1;
            this.record('sqlite refuses nested BEGIN');
            throw new Error('cannot start a transaction within a transaction');
          }
          this.openTxDepth += 1;
        } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          this.openTxDepth = Math.max(0, this.openTxDepth - 1);
        } else if (sql.startsWith('DELETE FROM outbox')) {
          const meta = this.rows.get(Number(params[1]));
          this.check(
            !meta || meta.owner === params[0],
            'no_cross_owner_write',
            () => `DELETE row ${String(params[1])} as ${String(params[0])}`,
          );
        } else if (sql.startsWith('UPDATE outbox')) {
          const meta = this.rows.get(Number(params[2]));
          this.check(
            !meta || meta.owner === params[1],
            'no_cross_owner_write',
            () => `UPDATE row ${String(params[2])} as ${String(params[1])}`,
          );
        } else if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
          const owner = this.entityOwner.get(String(params[1]));
          this.check(
            owner === undefined || owner === params[0],
            'no_cross_owner_write',
            () => `receipt ${String(params[1])} as ${String(params[0])}`,
          );
        }
        try {
          return await db.execute(sql, params);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith('stress.fault')
          ) {
            this.faultsConsumed += 1;
            this.record(`fault ${sql.slice(0, 24)}`);
          }
          throw error;
        }
      },
      close: () => db.close(),
    };
  }

  onGetDb(): LocalDb {
    this.drains += 1;
    const live = this.live;
    const now = Date.now();
    const active = getActiveDataOwner();
    this.record(`drain gen=${live?.gen ?? 'none'} owner=${active} t=${now}`);
    if (!live) {
      this.violate('no_drain_without_runtime', 'getDb without live runtime');
      return this.wrapDb(this.fake.db, null);
    }
    this.check(
      active === live.owner,
      'drain_owner_is_live_owner',
      () => `active ${active} live ${live.owner}`,
    );
    if (this.timerDriven) {
      if (live.lastDrainStartMs !== null) {
        const gap = now - live.lastDrainStartMs;
        this.check(
          gap >= MIN_RETRY_GAP_MS - 1,
          'timer_cadence_bounds',
          () =>
            `gen ${live.gen} timer drain after ${gap}ms (< ${MIN_RETRY_GAP_MS})`,
        );
        this.check(
          gap <= MAX_RETRY_GAP_MS + 1,
          'timer_cadence_bounds',
          () =>
            `gen ${live.gen} timer drain after ${gap}ms (> ${MAX_RETRY_GAP_MS})`,
        );
      }
    }
    live.lastDrainStartMs = now;
    return this.wrapDb(this.fake.db, live);
  }

  // ── invariants over durable state ─────────────────────────────────────────

  liveInFlight(): number {
    return this.live ? this.live.inFlight : 0;
  }

  totalInFlight(): number {
    let n = 0;
    for (const g of this.generations.values()) n += g.inFlight;
    return n;
  }

  checkAfterFlush() {
    // Quiescence marker for dead generations (I2).
    for (const g of this.generations.values()) {
      if (g.deadAtStep !== null && g.inFlight === 0)
        g.quiescentAfterDeath = true;
    }
    // I4 timers.
    const timers = jest.getTimerCount();
    const inFlight = this.totalInFlight();
    const retryTimers = timers - inFlight;
    if (!this.live) {
      this.check(
        retryTimers === 0,
        'timers_bounded',
        () => `no runtime but ${timers} timers (${inFlight} in flight)`,
      );
    } else if (this.liveInFlight() === 0) {
      this.check(
        retryTimers === 1,
        'timers_bounded',
        () =>
          `idle runtime has ${retryTimers} retry timers (${timers} total, ${inFlight} in flight)`,
      );
    } else {
      this.check(
        retryTimers === 0 || retryTimers === 1,
        'timers_bounded',
        () => `draining runtime has ${retryTimers} retry timers`,
      );
    }
    // I15 listeners.
    this.check(
      this.appStateHandlers.size === (this.live ? 1 : 0),
      'listeners_bounded',
      () =>
        `${this.appStateHandlers.size} AppState listeners, live=${!!this.live}`,
    );
    // I9 transactions.
    this.check(
      this.fake.openTransactions() === 0,
      'no_open_transaction',
      () => `${this.fake.openTransactions()} open`,
    );
    this.checkDurableState();
  }

  checkDurableState() {
    const present = new Set(this.fake.outbox.map(r => r.id));
    // I5 receipts.
    for (const receipt of this.fake.receipts) {
      const accepted = this.serverAccepted.get(receipt.entityId) ?? 0;
      this.check(
        accepted >= 1,
        'receipt_implies_server_accept',
        () => `receipt for ${receipt.entityId} never accepted`,
      );
      const owner = this.entityOwner.get(receipt.entityId);
      this.check(
        owner === receipt.owner,
        'receipt_implies_server_accept',
        () =>
          `receipt for ${receipt.entityId} owner ${receipt.owner} != ${owner}`,
      );
    }
    const receiptSet = new Set(
      this.fake.receipts.map(r => `${r.owner}|${r.entityId}`),
    );
    for (const meta of this.rows.values()) {
      const row = this.fake.outbox.find(r => r.id === meta.rowId);
      if (!present.has(meta.rowId)) {
        // I6 removed only after acceptance.
        if (!meta.wellFormed || !meta.entityId) {
          this.violate(
            'row_removed_only_after_accept',
            `malformed row ${meta.rowId} (${meta.kind}) vanished`,
          );
          continue;
        }
        const accepted = this.serverAccepted.get(meta.entityId) ?? 0;
        this.check(
          accepted >= 1,
          'row_removed_only_after_accept',
          () => `row ${meta.rowId} ${meta.entityId} removed without acceptance`,
        );
        if (meta.kind === 'shot.sync') {
          this.check(
            receiptSet.has(`${meta.owner}|${meta.entityId}`),
            'row_removed_only_after_accept',
            () =>
              `shot row ${meta.rowId} ${meta.entityId} removed without receipt`,
          );
        }
        continue;
      }
      if (!row) continue;
      // I7 attempts.
      this.check(
        row.attempts <= OUTBOX_MAX_ATTEMPTS,
        'attempts_bounded_by_verdicts',
        () => `row ${row.id} attempts ${row.attempts} > max`,
      );
      if (meta.entityId && meta.wellFormed) {
        const verdicts = this.permanentVerdicts.get(meta.entityId) ?? 0;
        this.check(
          row.attempts <= verdicts,
          'attempts_bounded_by_verdicts',
          () =>
            `row ${row.id} ${meta.entityId} attempts ${row.attempts} > permanent verdicts ${verdicts}`,
        );
      }
    }
    // I12 status derivation, per owner.
    for (const owner of [OWNER_OF.A, OWNER_OF.B]) {
      const rows: OutboxRowStatus[] = this.fake.outbox
        .filter(r => r.owner_key === owner)
        .map(r => ({
          kind: r.kind,
          attempts: r.attempts,
          lastError: r.last_error,
        }));
      const status = deriveUploadQueueStatus(rows);
      const exhausted = rows.filter(
        r => r.attempts >= OUTBOX_MAX_ATTEMPTS,
      ).length;
      const pending = rows.length - exhausted;
      const expected =
        rows.length === 0
          ? { state: 'idle' }
          : exhausted > 0
            ? { state: 'needs_attention', pending, exhausted }
            : { state: 'queued', pending };
      this.check(
        JSON.stringify(status) === JSON.stringify(expected),
        'queue_status_consistent',
        () =>
          `${owner}: ${JSON.stringify(status)} != ${JSON.stringify(expected)}`,
      );
    }
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function flushMicrotasks(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

interface RunOutcome {
  seed: number;
  steps: number;
  violations: Violation[];
  traceHash: string;
  traceLength: number;
  trace: string[];
  drains: number;
  requests: number;
  duplicateSends: number;
  nestedBeginRefused: number;
  staleGenerationDbOps: number;
  rowsEnqueued: number;
  faultsInjected: number;
  faultsConsumed: number;
  settleRounds: number;
  finalOutbox: number;
  finalReceipts: number;
}

function fnv1a(lines: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const line of lines) {
    for (let i = 0; i < line.length; i += 1) {
      hash ^= line.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function installRuntimeHooks(model: Model) {
  (getDb as jest.Mock).mockImplementation(() => model.onGetDb());
  (createTransport as jest.Mock).mockImplementation(
    (config: ApiConfigState) => {
      const actual =
        jest.requireActual<typeof import('../../src/data/api')>(
          '../../src/data/api',
        );
      return model.buildTransport(config, actual.createTransport(config));
    },
  );
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      model.nextHandler += 1;
      const id = model.nextHandler;
      model.appStateHandlers.set(id, handler as (state: string) => void);
      return {
        remove: () => {
          model.appStateHandlers.delete(id);
        },
      } as ReturnType<typeof AppState.addEventListener>;
    });
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    model.fetch(url, init ?? {})) as unknown as typeof fetch;
}

async function enqueue(
  model: Model,
  action: Extract<Action, { t: 'enqueue' }>,
) {
  const owner = model.ownerKey(action.owner) ?? OWNER_OF.A;
  const fake = model.fake;
  // The repository writes a row on its own connection turn, never in the
  // middle of the sync engine's receipt transaction (a real BEGIN IMMEDIATE
  // would refuse the nested write); wait for the connection to be free.
  if (fake.openTransactions() > 0) {
    model.record('enqueue waits for open transaction');
    await flushMicrotasks();
  }
  for (let i = 0; i < action.count; i += 1) {
    switch (action.kind) {
      case 'shot': {
        const id = model.newEntity('shot');
        const rowId = fake.push('shot.sync', shotPayload(id, null), owner);
        model.registerRow(rowId, owner, 'shot.sync', id, true, false, null);
        break;
      }
      case 'shotThenSession':
      case 'sessionThenShot': {
        const sessionId = model.newEntity('session');
        const shotId = model.newEntity('shot');
        const pushSession = () => {
          const rowId = fake.push(
            'session.create',
            { id: sessionId, mode: 'practice_set' },
            owner,
          );
          model.registerRow(
            rowId,
            owner,
            'session.create',
            sessionId,
            true,
            false,
            null,
          );
        };
        const pushShot = () => {
          const rowId = fake.push(
            'shot.sync',
            shotPayload(shotId, sessionId),
            owner,
          );
          model.registerRow(
            rowId,
            owner,
            'shot.sync',
            shotId,
            true,
            false,
            sessionId,
          );
        };
        if (action.kind === 'shotThenSession') {
          pushShot();
          pushSession();
        } else {
          pushSession();
          pushShot();
        }
        break;
      }
      case 'orphanShot': {
        const sessionId = model.newEntity('ghost');
        const id = model.newEntity('shot');
        const rowId = fake.push('shot.sync', shotPayload(id, sessionId), owner);
        model.registerRow(rowId, owner, 'shot.sync', id, true, true, sessionId);
        break;
      }
      case 'sessionFinalize': {
        const sessionId = model.newEntity('session');
        const createId = fake.push(
          'session.create',
          { id: sessionId, mode: 'practice_set' },
          owner,
        );
        model.registerRow(
          createId,
          owner,
          'session.create',
          sessionId,
          true,
          false,
          null,
        );
        const finalizeId = fake.push(
          'session.finalize',
          { id: sessionId },
          owner,
        );
        model.registerRow(
          finalizeId,
          owner,
          'session.finalize',
          sessionId,
          true,
          false,
          null,
        );
        break;
      }
      case 'trial': {
        const id = model.newEntity('trial');
        const rowId = fake.push(
          'evaluation.trial',
          { trialId: id, verdict: 'agree' },
          owner,
        );
        model.registerRow(
          rowId,
          owner,
          'evaluation.trial',
          id,
          true,
          false,
          null,
        );
        break;
      }
      case 'corruptShot': {
        const rowId = fake.push('shot.sync', '{not json', owner);
        model.registerRow(rowId, owner, 'shot.sync', null, false, false, null);
        break;
      }
      case 'noPermitShot': {
        const id = model.newEntity('shot');
        const payload = shotPayload(id, null) as Record<string, unknown>;
        delete payload['analysisPermitId'];
        const rowId = fake.push('shot.sync', payload, owner);
        model.registerRow(rowId, owner, 'shot.sync', null, false, false, null);
        break;
      }
      case 'corruptSession': {
        const rowId = fake.push(
          'session.create',
          { mode: 'practice_set' },
          owner,
        );
        model.registerRow(
          rowId,
          owner,
          'session.create',
          null,
          false,
          false,
          null,
        );
        break;
      }
      case 'unknownKind': {
        const rowId = fake.push('telemetry.blob', { x: 1 }, owner);
        model.registerRow(
          rowId,
          owner,
          'telemetry.blob',
          null,
          false,
          false,
          null,
        );
        break;
      }
      case 'corruptTrial': {
        const rowId = fake.push(
          'evaluation.trial',
          { verdict: 'agree' },
          owner,
        );
        model.registerRow(
          rowId,
          owner,
          'evaluation.trial',
          null,
          false,
          false,
          null,
        );
        break;
      }
    }
  }
  model.record(`enqueue ${action.kind}x${action.count} owner=${owner}`);
  if (action.triggerAfter) triggerOutboxSync();
}

async function advance(model: Model, ms: number, chunk: number) {
  model.timerDriven = true;
  let remaining = ms;
  while (remaining > 0) {
    const slice = Math.min(chunk, remaining);
    jest.advanceTimersByTime(slice);
    remaining -= slice;
    await flushMicrotasks();
  }
  model.timerDriven = false;
}

function configure(model: Model, user: UserKey) {
  establishApiSession(sessionFor(user, model.tokenVersion[user]));
  setActiveDataOwner(OWNER_OF[user]);
  model.pendingConfigure = user;
  model.transportsCreatedThisConfigure = 0;
  configureSyncRuntime(sessionFor(user, model.tokenVersion[user]));
  model.check(
    model.transportsCreatedThisConfigure === 1,
    'configure_builds_one_transport',
    () => `${model.transportsCreatedThisConfigure} transports`,
  );
  model.pendingConfigure = null;
}

function signOut(model: Model) {
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  if (model.live) model.live.deadAtStep = model.step;
  model.live = null;
  model.record('signOut');
}

async function applyStep(model: Model, step: Step) {
  const { action } = step;
  switch (action.t) {
    case 'configure':
      model.record(`configure ${action.user}`);
      configure(model, action.user);
      break;
    case 'signOut':
      signOut(model);
      break;
    case 'appState':
      model.record(`appState ${action.states.join('>')}`);
      for (const state of action.states) {
        for (const handler of [...model.appStateHandlers.values()]) {
          handler(state);
        }
      }
      break;
    case 'trigger':
      model.record(`trigger x${action.n}`);
      for (let i = 0; i < action.n; i += 1) triggerOutboxSync();
      break;
    case 'enqueue':
      await enqueue(model, action);
      break;
    case 'net':
      model.net = action.mode;
      model.record(`net ${action.mode}`);
      break;
    case 'release': {
      const count = action.all
        ? model.held.length
        : Math.min(1, model.held.length);
      model.record(`release ${count}/${model.held.length}`);
      for (let i = 0; i < count; i += 1) {
        const held = model.held.shift()!;
        held.resolve(held.response);
      }
      break;
    }
    case 'advance':
      model.record(`advance ${action.ms} chunk=${action.chunk}`);
      await advance(model, action.ms, action.chunk);
      break;
    case 'rotateToken': {
      const session = getApiSession();
      const user = session
        ? USER_OF_OWNER.get(canonicalDataOwner(session.canonicalAppUserId))
        : undefined;
      if (user) {
        model.tokenVersion[user] += 1;
        establishApiSession(sessionFor(user, model.tokenVersion[user]));
        model.record(`rotateToken ${user} v${model.tokenVersion[user]}`);
      } else {
        model.record('rotateToken none');
      }
      break;
    }
    case 'ownerDrift': {
      const owner =
        action.owner === 'signedOut'
          ? SIGNED_OUT_DATA_OWNER
          : OWNER_OF[action.owner];
      setActiveDataOwner(owner);
      if (model.live && model.live.owner !== owner) {
        // Skipped drains leave no start to measure the next cadence from.
        model.live.lastDrainStartMs = null;
      }
      model.record(`ownerDrift ${owner}`);
      break;
    }
    case 'dbFault':
      model.faultsInjected += 1;
      model.fake.failNext(
        action.needle,
        new Error(`stress.fault:${model.faultsInjected}:${action.needle}`),
      );
      model.record(`dbFault ${action.needle}`);
      break;
    case 'flushOnly':
      model.record('flushOnly');
      break;
  }
  if (step.flush) {
    await flushMicrotasks();
    model.checkAfterFlush();
  }
}

/** Rows of `owner` that may legitimately remain queued after settle. */
function settleAllowsRow(model: Model, rowId: number): boolean {
  const meta = model.rows.get(rowId);
  const row = model.fake.outbox.find(r => r.id === rowId);
  if (!meta || !row) return true;
  // I7 owns the upper bound on attempts; settle only asks "is it parked?".
  if (!meta.wellFormed) return row.attempts >= OUTBOX_MAX_ATTEMPTS;
  if (meta.orphan) return true;
  // A well-formed row whose server verdicts exhausted its budget parks too
  // (per-item permanent rejections during `partial_reject`).
  return row.attempts >= OUTBOX_MAX_ATTEMPTS;
}

async function settle(model: Model): Promise<number> {
  model.step += 1;
  model.record('settle');
  model.net = 'online';
  while (model.held.length > 0) {
    const held = model.held.shift()!;
    held.resolve(held.response);
  }
  await flushMicrotasks();
  // Re-establish the owner drift a near-legal action may have left behind.
  const liveUser = model.live ? model.live.user : null;
  const user: UserKey =
    liveUser ??
    (model.fake.outbox.filter(r => r.owner_key === OWNER_OF.B).length >
    model.fake.outbox.filter(r => r.owner_key === OWNER_OF.A).length
      ? 'B'
      : 'A');
  if (!model.live || getActiveDataOwner() !== model.live.owner) {
    configure(model, user);
  }
  const owner = OWNER_OF[user];
  const otherRowsBefore = JSON.stringify(
    model.fake.outbox.filter(r => r.owner_key !== owner),
  );
  const isQuiescent = () =>
    model.fake.outbox
      .filter(r => r.owner_key === owner)
      .every(r => settleAllowsRow(model, r.id));
  let rounds = 0;
  // Each round crosses the back-off ceiling once (plus request timeout).
  const ROUND_MS = MAX_RETRY_GAP_MS + 1_000;
  const MAX_ROUNDS = 12;
  await flushMicrotasks();
  while (!isQuiescent() && rounds < MAX_ROUNDS) {
    rounds += 1;
    await advance(model, ROUND_MS, 10_000);
  }
  model.check(isQuiescent(), 'settle_quiescent', () => {
    const stuck = model.fake.outbox
      .filter(r => r.owner_key === owner && !settleAllowsRow(model, r.id))
      .map(r => `${r.id}:${r.kind}:a${r.attempts}:${r.last_error ?? ''}`);
    return `after ${rounds} rounds: ${stuck.join(' | ')}`;
  });
  for (const meta of model.rows.values()) {
    if (meta.owner !== owner) continue;
    const row = model.fake.outbox.find(r => r.id === meta.rowId);
    if (!meta.wellFormed) {
      model.check(
        row !== undefined && row.attempts >= OUTBOX_MAX_ATTEMPTS,
        'settle_malformed_parked',
        () =>
          `row ${meta.rowId} ${meta.kind} attempts=${row?.attempts ?? 'gone'}`,
      );
      continue;
    }
    if (meta.orphan) {
      const verdicts = model.permanentVerdicts.get(meta.entityId ?? '') ?? 0;
      model.check(
        row !== undefined && row.attempts <= verdicts,
        'settle_orphans_durable',
        () =>
          `orphan ${meta.entityId} row=${row ? `a${row.attempts}` : 'gone'} verdicts=${verdicts}`,
      );
      continue;
    }
    if (row && row.attempts >= OUTBOX_MAX_ATTEMPTS) continue; // parked by verdicts
    model.check(
      row === undefined,
      'settle_well_formed_delivered',
      () =>
        `row ${meta.rowId} ${meta.kind} ${meta.entityId} still queued a${row?.attempts}`,
    );
    if (meta.kind === 'shot.sync' && row === undefined) {
      model.check(
        model.fake.receipts.some(
          r => r.owner === owner && r.entityId === meta.entityId,
        ),
        'settle_well_formed_delivered',
        () => `shot ${meta.entityId} delivered without receipt`,
      );
    }
  }
  model.check(
    JSON.stringify(model.fake.outbox.filter(r => r.owner_key !== owner)) ===
      otherRowsBefore,
    'settle_other_owner_untouched',
    () => 'other owner rows changed during settle',
  );
  model.checkAfterFlush();
  return rounds;
}

async function runPlan(
  seed: number,
  plan: readonly Step[],
): Promise<RunOutcome> {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
  const fake = createFakeLocalDb();
  const model = new Model(fake, seed);
  const jitter = seededRandom((seed ^ 0x9e3779b9) >>> 0);
  const randomSpy = jest.spyOn(Math, 'random').mockImplementation(jitter);
  installRuntimeHooks(model);
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  let settleRounds = 0;
  try {
    for (const step of plan) {
      model.step += 1;
      await applyStep(model, step);
    }
    settleRounds = await settle(model);
  } finally {
    // Teardown: nothing may leak into the next seed.
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    while (model.held.length > 0) {
      const held = model.held.shift()!;
      held.resolve(held.response);
    }
    await flushMicrotasks();
    jest.clearAllTimers();
    randomSpy.mockRestore();
    jest.restoreAllMocks();
    jest.useRealTimers();
  }
  return {
    seed,
    steps: plan.length,
    violations: model.violations,
    traceHash: fnv1a(model.trace),
    traceLength: model.trace.length,
    trace: model.trace,
    drains: model.drains,
    requests: model.requests,
    duplicateSends: model.duplicateSends,
    nestedBeginRefused: model.nestedBeginRefused,
    staleGenerationDbOps: model.staleGenerationDbOps,
    rowsEnqueued: model.rows.size,
    faultsInjected: model.faultsInjected,
    faultsConsumed: model.faultsConsumed,
    settleRounds,
    finalOutbox: fake.outbox.length,
    finalReceipts: fake.receipts.length,
  };
}

// ─── Campaign bookkeeping ────────────────────────────────────────────────────

interface SeedResult {
  seed: number;
  length: number;
  outcome: 'HELD' | 'BROKEN';
  /** BROKEN only through KNOWN_OPEN_FINDINGS root causes + their consequences. */
  knownOpenOnly: boolean;
  violations: Violation[];
  traceHash: string;
  traceLength: number;
  replayTraceHash: string | null;
  deterministic: boolean | null;
  firstTraceDivergence: { index: number; first: string; replay: string } | null;
  drains: number;
  requests: number;
  duplicateSends: number;
  nestedBeginRefused: number;
  staleGenerationDbOps: number;
  rowsEnqueued: number;
  faultsInjected: number;
  faultsConsumed: number;
  settleRounds: number;
  finalOutbox: number;
  finalReceipts: number;
  minimizedPlan: Step[] | null;
  minimizedLength: number | null;
  flakeRuns: { runs: number; failures: number } | null;
  traceExcerpt: string[] | null;
}

const results: SeedResult[] = [];
const realFetch = globalThis.fetch;

function seedList(): number[] {
  if (ONLY_SEED !== null) return [ONLY_SEED];
  return Array.from({ length: ITER }, (_, i) => (SEED_BASE + i) >>> 0);
}

function invariantSet(violations: readonly Violation[]): string {
  return [...new Set(violations.map(v => v.invariant))].sort().join(',');
}

/** Greedy one-at-a-time step removal preserving the failing invariant set. */
async function minimize(
  seed: number,
  plan: Step[],
  target: string,
): Promise<Step[]> {
  let current = plan;
  let progressed = true;
  let budget = plan.length * 2;
  while (progressed && budget > 0) {
    progressed = false;
    for (let i = current.length - 1; i >= 0 && budget > 0; i -= 1) {
      budget -= 1;
      const candidate = current.filter((_, idx) => idx !== i);
      if (candidate.length === 0) break;
      const outcome = await runPlan(seed, candidate);
      if (
        outcome.violations.length > 0 &&
        invariantSet(outcome.violations) === target
      ) {
        current = candidate;
        progressed = true;
      }
    }
  }
  return current;
}

async function runSeed(seed: number): Promise<SeedResult> {
  const plan = generatePlan(seed);
  const first = await runPlan(seed, plan);
  let replayTraceHash: string | null = null;
  let deterministic: boolean | null = null;
  let firstTraceDivergence: SeedResult['firstTraceDivergence'] = null;
  const violations = [...first.violations];
  if (REPLAY) {
    const second = await runPlan(seed, plan);
    replayTraceHash = second.traceHash;
    deterministic =
      second.traceHash === first.traceHash &&
      second.traceLength === first.traceLength;
    if (!deterministic) {
      const limit = Math.max(first.trace.length, second.trace.length);
      for (let i = 0; i < limit; i += 1) {
        if (first.trace[i] !== second.trace[i]) {
          firstTraceDivergence = {
            index: i,
            first: first.trace[i] ?? '<end>',
            replay: second.trace[i] ?? '<end>',
          };
          break;
        }
      }
      violations.push({
        invariant: 'deterministic_replay',
        step: firstTraceDivergence?.index ?? -1,
        detail: `trace ${first.traceHash}/${first.traceLength} vs ${second.traceHash}/${second.traceLength}`,
      });
    }
  }
  const broken = violations.length > 0;
  let minimizedPlan: Step[] | null = null;
  let flakeRuns: SeedResult['flakeRuns'] = null;
  if (broken && first.violations.length > 0) {
    const target = invariantSet(first.violations);
    minimizedPlan = await minimize(seed, plan, target);
    let failures = 0;
    for (let i = 0; i < 10; i += 1) {
      const rerun = await runPlan(seed, plan);
      if (rerun.violations.length > 0) failures += 1;
    }
    flakeRuns = { runs: 10, failures };
  }
  return {
    seed,
    length: plan.length,
    outcome: broken ? 'BROKEN' : 'HELD',
    knownOpenOnly: attributedToKnownOpen(violations),
    violations,
    traceHash: first.traceHash,
    traceLength: first.traceLength,
    replayTraceHash,
    deterministic,
    firstTraceDivergence,
    drains: first.drains,
    requests: first.requests,
    duplicateSends: first.duplicateSends,
    nestedBeginRefused: first.nestedBeginRefused,
    staleGenerationDbOps: first.staleGenerationDbOps,
    rowsEnqueued: first.rowsEnqueued,
    faultsInjected: first.faultsInjected,
    faultsConsumed: first.faultsConsumed,
    settleRounds: first.settleRounds,
    finalOutbox: first.finalOutbox,
    finalReceipts: first.finalReceipts,
    minimizedPlan,
    minimizedLength: minimizedPlan ? minimizedPlan.length : null,
    flakeRuns,
    traceExcerpt: KEEP_TRACE
      ? first.trace
      : broken
        ? first.trace.slice(-60)
        : null,
  };
}

function writeResults() {
  const dir = resultsDir();
  fs.mkdirSync(dir, { recursive: true });
  const broken = results.filter(r => r.outcome === 'BROKEN');
  const byInvariant: Record<string, number> = {};
  for (const r of broken) {
    for (const inv of new Set(r.violations.map(v => v.invariant))) {
      byInvariant[inv] = (byInvariant[inv] ?? 0) + 1;
    }
  }
  const summary = {
    unit: 'mod-sync-runtime',
    lens: 'randomized-seeded',
    runId: RUN_ID,
    seedBase: SEED_BASE,
    iterations: results.length,
    replayedForDeterminism: results.filter(r => r.deterministic !== null)
      .length,
    nonDeterministic: results.filter(r => r.deterministic === false).length,
    held: results.length - broken.length,
    broken: broken.length,
    brokenSeeds: broken.map(r => r.seed),
    brokenKnownOpenOnly: broken.filter(r => r.knownOpenOnly).length,
    brokenNew: broken.filter(r => !r.knownOpenOnly).map(r => r.seed),
    knownOpenFindings: [...KNOWN_OPEN_FINDINGS],
    knownOpenConsequences: [...F1_CONSEQUENCES],
    seedsWithStaleGenerationOverlap: results.filter(
      r => r.staleGenerationDbOps > 0,
    ).length,
    byInvariant,
    sequenceLength: {
      min: Math.min(...results.map(r => r.length)),
      max: Math.max(...results.map(r => r.length)),
      mean:
        results.reduce((acc, r) => acc + r.length, 0) /
        Math.max(1, results.length),
    },
    totals: {
      steps: results.reduce((acc, r) => acc + r.length, 0),
      drains: results.reduce((acc, r) => acc + r.drains, 0),
      requests: results.reduce((acc, r) => acc + r.requests, 0),
      duplicateSends: results.reduce((acc, r) => acc + r.duplicateSends, 0),
      nestedBeginRefused: results.reduce(
        (acc, r) => acc + r.nestedBeginRefused,
        0,
      ),
      staleGenerationDbOps: results.reduce(
        (acc, r) => acc + r.staleGenerationDbOps,
        0,
      ),
      rowsEnqueued: results.reduce((acc, r) => acc + r.rowsEnqueued, 0),
      faultsInjected: results.reduce((acc, r) => acc + r.faultsInjected, 0),
    },
    replay:
      'STRESS_SEED=<seed> npx jest __tests__/stress/syncRuntimeRandomizedSeeded',
    atIso: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results));
  fs.writeFileSync(
    path.join(dir, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('stress: sync runtime under seeded randomized reconnect/app-state storms', () => {
  const seeds = seedList();

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (results.length > 0) writeResults();
  });

  const batches: number[][] = [];
  for (let i = 0; i < seeds.length; i += BATCH) {
    batches.push(seeds.slice(i, i + BATCH));
  }

  for (const batch of batches) {
    const label = `seeds ${batch[0]}..${batch[batch.length - 1]} (${batch.length})`;
    it(
      label,
      async () => {
        const broken: string[] = [];
        for (const seed of batch) {
          const result = await runSeed(seed);
          results.push(result);
          if (result.outcome === 'BROKEN' && !result.knownOpenOnly) {
            broken.push(
              `seed ${seed}: ${result.violations
                .slice(0, 3)
                .map(v => `[step ${v.step}] ${v.invariant}: ${v.detail}`)
                .join(' || ')}`,
            );
          }
        }
        expect(broken).toEqual([]);
      },
      600_000,
    );
  }

  it('generated sequences respect the lens contract (length 5..60, seeded)', () => {
    for (const seed of seeds.slice(0, Math.min(seeds.length, 200))) {
      const plan = generatePlan(seed);
      expect(plan.length).toBeGreaterThanOrEqual(MIN_LEN);
      expect(plan.length).toBeLessThanOrEqual(MAX_LEN);
      expect(JSON.stringify(generatePlan(seed))).toBe(JSON.stringify(plan));
    }
  });

  // Finding F1 (known open): configureSyncRuntime replaces the runtime while
  // the previous generation's drainOutbox is still running (a request in
  // flight, or simply mid-way through its async SQLite work); that stale drain
  // is neither awaited nor cancelled, so it keeps operating on the same owner
  // and the same connection concurrently with the live generation's drain.
  // Observed consequences: (a) on one SQLite connection the second
  // `BEGIN IMMEDIATE` fails ("cannot start a transaction within a
  // transaction") and the losing drain records a spurious transient failure
  // for its whole shot batch — the server had already accepted those shots
  // (idempotent by id), so the cost is duplicate uploads and a backoff, not
  // data loss; (b) both drains select the same malformed row at MAX-1 and both
  // bump it, so `attempts` overshoots OUTBOX_MAX_ATTEMPTS (harmless for
  // deriveUploadQueueStatus, which uses >=) and an exhausted row can be sent
  // one extra time. The `test.failing`s pass while the defect exists and
  // fail the moment it is fixed — promote them to `it` and drop
  // 'stale_generation_keeps_draining' from KNOWN_OPEN_FINDINGS then.
  test.failing(
    'F1 (known open): a superseded generation must stop touching the DB',
    async () => {
      const outcome = await runPlan(20260960, F1_STALE_GENERATION_PLAN);
      expect(outcome.staleGenerationDbOps).toBe(0);
    },
  );

  test.failing(
    'F1a (known open): a stale generation must not open a transaction over the live one',
    async () => {
      const outcome = await runPlan(20260960, F1_STALE_GENERATION_PLAN);
      expect(outcome.nestedBeginRefused).toBe(0);
      expect(
        outcome.violations.filter(
          v => v.invariant === 'no_concurrent_transactions',
        ),
      ).toEqual([]);
    },
  );

  test.failing(
    'F1b (known open): two overlapping drains must not push attempts past OUTBOX_MAX_ATTEMPTS',
    async () => {
      const outcome = await runPlan(20261142, F1_ATTEMPTS_OVERSHOOT_PLAN);
      expect(
        outcome.violations.filter(
          v => v.invariant === 'attempts_bounded_by_verdicts',
        ),
      ).toEqual([]);
    },
  );

  it('F1 consequences are bounded: no data loss, no cross-owner write, no other invariant', async () => {
    for (const [seed, plan] of [
      [20260960, F1_STALE_GENERATION_PLAN],
      [20261142, F1_ATTEMPTS_OVERSHOOT_PLAN],
    ] as const) {
      const outcome = await runPlan(seed, plan);
      expect(outcome.staleGenerationDbOps).toBeGreaterThan(0);
      expect(attributedToKnownOpen(outcome.violations)).toBe(true);
      expect(
        outcome.violations.filter(
          v =>
            !KNOWN_OPEN_FINDINGS.has(v.invariant) &&
            !F1_CONSEQUENCES.has(v.invariant),
        ),
      ).toEqual([]);
    }
    const shots = await runPlan(20260960, F1_STALE_GENERATION_PLAN);
    expect(shots.finalOutbox).toBe(0);
    expect(shots.finalReceipts).toBe(2);
    expect(shots.duplicateSends).toBeGreaterThan(0);
    const parked = await runPlan(20261142, F1_ATTEMPTS_OVERSHOOT_PLAN);
    expect(parked.finalOutbox).toBe(1);
    expect(parked.finalReceipts).toBe(0);
  });
});
