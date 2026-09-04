/**
 * STRESS SUITE (lens: concurrency) for apps/mobile/src/training/store.ts.
 *
 * A seeded scheduler drives the real Zustand training store against an
 * in-memory server model with a virtual clock. Every request has a seeded
 * process delay, delivery delay and fault (network failure before/after the
 * server applied it, 401/429/500). Bursts of store calls are fired
 * synchronously (Promise.all semantics) at seeded ticks so calls overlap
 * with in-flight calls, follow-up reloads, account switches, session
 * re-installs and logouts.
 *
 * Invariants checked at quiescence of every iteration:
 *   - bounded wall time, every promise settles (no deadlock);
 *   - the mutation lock and loading statuses are released;
 *   - no cross-account or post-logout data leaks;
 *   - no duplicate saved-drill rows, at most one API call per store call;
 *   - no lost update: the store reflects the freshest server response the
 *     client received (an older response must never overwrite a newer one);
 *   - no double spend of a drill completion.
 *
 * Replay: STRESS_SEED=<n> runs only that seed. STRESS_ITER=<n> sets the
 * campaign size (default 500). STRESS_OUT_DIR=<dir> writes the seed → outcome
 * JSON table for the campaign.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockRecordDrillCompletion = jest.fn(async () => undefined);

jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: {
    getState: () => ({ recordDrillCompletion: mockRecordDrillCompletion }),
  },
}));

import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import {
  TrainingError,
  type CompletionEvidence,
  type DrillCompletion,
  type DrillDetail,
  type SavedDrill,
  type TrainingApi,
  type TrainingPlan,
  type TrainingPlanDrill,
  type TrainingPlanItem,
} from '../../src/training/types';

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: Rng, maxExclusive: number): number =>
  Math.floor(rng() * maxExclusive);
const pick = <T>(rng: Rng, items: readonly T[]): T => {
  const item = items[int(rng, items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
};

// ---------------------------------------------------------------------------
// Virtual-time scheduler
// ---------------------------------------------------------------------------

const flushMicrotasks = (): Promise<void> =>
  new Promise(resolve => setImmediate(resolve));

interface ScheduledEvent {
  at: number;
  seq: number;
  run: () => void;
}

class Scheduler {
  private now = 0;
  private seq = 0;
  private readonly queue: ScheduledEvent[] = [];

  get time(): number {
    return this.now;
  }

  schedule(delay: number, run: () => void): void {
    this.queue.push({
      at: this.now + Math.max(0, delay),
      seq: this.seq++,
      run,
    });
  }

  async drain(maxEvents: number): Promise<number> {
    let events = 0;
    while (this.queue.length > 0) {
      if (events >= maxEvents) {
        throw new Error(`scheduler did not quiesce after ${maxEvents} events`);
      }
      let best = 0;
      for (let i = 1; i < this.queue.length; i += 1) {
        const candidate = this.queue[i];
        const current = this.queue[best];
        if (!candidate || !current) continue;
        if (
          candidate.at < current.at ||
          (candidate.at === current.at && candidate.seq < current.seq)
        ) {
          best = i;
        }
      }
      const [event] = this.queue.splice(best, 1);
      if (!event) break;
      this.now = event.at;
      event.run();
      events += 1;
      await flushMicrotasks();
    }
    return events;
  }
}

// ---------------------------------------------------------------------------
// Server model (one row set per account, shared virtual clock)
// ---------------------------------------------------------------------------

const BASE_EPOCH_MS = Date.UTC(2026, 8, 4, 12, 0, 0);
const TICK_MS = 250;

const uuidAt = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

interface ServerCompletionRow {
  id: string;
  planId: string;
  itemId: string;
  seq: number;
  completedAt: string;
  clientCompletedAt: string;
}

class TrainingServer {
  readonly saved = new Map<string, string>();
  readonly completions: ServerCompletionRow[] = [];
  plan: TrainingPlan | null = null;
  plansCreated = 0;
  private seqCounter = 0;

  constructor(
    readonly account: string,
    readonly catalog: readonly string[],
    private readonly scheduler: Scheduler,
    private readonly clockOffsetMs: number,
  ) {}

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  nowIso(): string {
    return new Date(
      BASE_EPOCH_MS + this.scheduler.time * TICK_MS + this.clockOffsetMs,
    ).toISOString();
  }

  private drillId(slug: string): string {
    return uuidAt(0xd000 + this.catalog.indexOf(slug));
  }

  private planDrill(slug: string): TrainingPlanDrill {
    return {
      slug,
      title: `Drill ${slug}`,
      description: `Description ${slug}`,
      coachName: 'Coach',
      equipment: [],
      saved: this.saved.has(slug),
    };
  }

  listSavedDrills(): SavedDrill[] {
    return [...this.saved.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
      .map(([slug, savedAt]) => ({
        id: this.drillId(slug),
        slug,
        title: `Drill ${slug}`,
        description: `Description ${slug}`,
        coachName: 'Coach',
        equipment: [],
        difficultyMin: 'beginner',
        difficultyMax: null,
        savedAt,
      }));
  }

  getDrill(slug: string): DrillDetail {
    if (!this.catalog.includes(slug)) {
      throw new TrainingError(
        'training.request_failed',
        'Drill not found.',
        false,
        404,
      );
    }
    return {
      id: this.drillId(slug),
      slug,
      title: `Drill ${slug}`,
      description: `Description ${slug}`,
      coachName: 'Coach',
      equipment: [],
      difficultyMin: 'beginner',
      difficultyMax: null,
      saved: this.saved.has(slug),
      mappings: [
        {
          checkpoint: 'contact_point',
          shotType: 'dink',
          planRole: 'targeted',
          faultDirections: ['late'],
          cueText: 'Meet the ball in front.',
          targetSets: 2,
          targetRepetitionsPerSet: 10,
          targetDurationSeconds: null,
          restSeconds: 30,
        },
      ],
      instructionalMedia: [],
    };
  }

  saveDrill(slug: string): void {
    if (!this.catalog.includes(slug)) {
      throw new TrainingError(
        'training.request_failed',
        'Drill not found.',
        false,
        404,
      );
    }
    if (!this.saved.has(slug)) this.saved.set(slug, this.nowIso());
  }

  unsaveDrill(slug: string): void {
    this.saved.delete(slug);
  }

  getCurrentPlan(): TrainingPlan | null {
    return this.plan && this.plan.status === 'active' ? this.plan : null;
  }

  createPlan(sourceShotId: string, rng: Rng): TrainingPlan {
    if (this.plan && this.plan.status === 'active') {
      this.plan = { ...this.plan, status: 'superseded' };
    }
    this.plansCreated += 1;
    const planId = `plan-${this.account}-${this.plansCreated}`;
    const drillCount = 2 + int(rng, 2);
    const slugs = [...this.catalog]
      .sort(() => rng() - 0.5)
      .slice(0, drillCount);
    const items: TrainingPlanItem[] = slugs.map((slug, index) => {
      const timed = rng() < 0.3;
      return {
        id: `${planId}-item-${index + 1}`,
        position: index + 1,
        kind: index === 0 ? 'warmup' : 'targeted',
        drill: this.planDrill(slug),
        cueText: 'Stay low.',
        targetSets: 1 + int(rng, 3),
        targetRepetitionsPerSet: timed ? null : 5 + int(rng, 6),
        targetDurationSeconds: timed ? 30 + int(rng, 60) : null,
        restSeconds: 30,
        completion: null,
      };
    });
    items.push({
      id: `${planId}-item-${items.length + 1}`,
      position: items.length + 1,
      kind: 'reassessment',
      drill: null,
      cueText: null,
      targetSets: null,
      targetRepetitionsPerSet: null,
      targetDurationSeconds: null,
      restSeconds: null,
      completion: null,
    });
    this.plan = {
      id: planId,
      status: 'active',
      algorithmVersion: 'stress-1',
      sourceShotId,
      shotType: 'dink',
      priorityCheckpoint: 'contact_point',
      priorityDirection: 'late',
      baselineScore: 61,
      baselineCheckpointScore: 40,
      reassessmentShotId: null,
      scoreDelta: null,
      createdAt: this.nowIso(),
      completedAt: null,
      items,
    };
    return this.plan;
  }

  completeDrill(evidence: CompletionEvidence): DrillCompletion {
    const plan = this.plan;
    const item = plan?.items.find(
      candidate => candidate.id === evidence.trainingPlanItemId,
    );
    if (!plan || !item || plan.status !== 'active') {
      throw new TrainingError(
        'training.request_failed',
        'Plan item not found.',
        false,
        404,
      );
    }
    if (Number.isNaN(Date.parse(evidence.completedAt))) {
      throw new TrainingError(
        'training.request_failed',
        'completedAt is not an ISO timestamp.',
        false,
        400,
      );
    }
    const existing = this.completions.find(row => row.id === evidence.id);
    const completion: DrillCompletion = {
      id: evidence.id,
      completedAt: existing?.completedAt ?? this.nowIso(),
      actualRepetitions: evidence.actualRepetitions,
      actualDurationSeconds: evidence.actualDurationSeconds,
      qualifiesForStreak: true,
    };
    if (!existing) {
      this.completions.push({
        id: evidence.id,
        planId: plan.id,
        itemId: item.id,
        seq: this.nextSeq(),
        completedAt: completion.completedAt,
        clientCompletedAt: evidence.completedAt,
      });
      item.completion = completion;
    }
    return completion;
  }

  reassessPlan(planId: string, shotId: string): TrainingPlan {
    if (
      !this.plan ||
      this.plan.id !== planId ||
      this.plan.status !== 'active'
    ) {
      throw new TrainingError(
        'training.request_failed',
        'Plan is not active.',
        false,
        409,
      );
    }
    this.plan = {
      ...this.plan,
      status: 'completed',
      reassessmentShotId: shotId,
      scoreDelta: 4,
      completedAt: this.nowIso(),
    };
    return this.plan;
  }
}

// ---------------------------------------------------------------------------
// Fake TrainingApi with seeded latency + faults and a delivery log
// ---------------------------------------------------------------------------

type Fault =
  'none' | 'net-before' | 'net-after' | 'http-500' | 'http-429' | 'http-401';

const FAULTS: readonly Fault[] = [
  'net-before',
  'net-after',
  'http-500',
  'http-429',
  'http-401',
];

type ApiKind = keyof TrainingApi;

interface RequestRecord {
  n: number;
  configId: number;
  account: string;
  kind: ApiKind;
  arg: string;
  fault: Fault;
  issuedAt: number;
  processedAt: number | null;
  seq: number | null;
  deliveredAt: number | null;
  outcome: 'pending' | 'ok' | 'error';
  liveOnDelivery: boolean;
}

type DeliveredSource = { configId: number; seq: number } & (
  | { surface: 'saved'; kind: 'list'; slugs: string[] }
  | { surface: 'saved'; kind: 'unsave'; slug: string }
  | { surface: 'plan'; kind: 'plan'; plan: TrainingPlan | null }
  | { surface: 'plan'; kind: 'completion'; planId: string; itemId: string }
);

interface FakeApiOptions {
  configId: number;
  server: TrainingServer;
  scheduler: Scheduler;
  rng: Rng;
  faultRate: number;
  maxDelay: number;
  log: RequestRecord[];
  sources: DeliveredSource[];
  isLive: () => boolean;
}

function faultError(fault: Fault): TrainingError {
  switch (fault) {
    case 'net-before':
    case 'net-after':
      return new TrainingError(
        'training.unavailable',
        'Network request failed.',
        true,
        null,
      );
    case 'http-500':
      return new TrainingError(
        'training.request_failed',
        'Server error.',
        true,
        500,
      );
    case 'http-429':
      return new TrainingError(
        'training.request_failed',
        'Too many requests.',
        true,
        429,
      );
    case 'http-401':
      return new TrainingError(
        'training.session_expired',
        'Session expired.',
        false,
        401,
      );
    case 'none':
      throw new Error('no fault');
  }
}

function createFakeApi(options: FakeApiOptions): TrainingApi {
  const { server, scheduler, rng, log, sources } = options;

  const call = <T>(
    kind: ApiKind,
    arg: string,
    op: () => T,
    onDelivered?: (result: T, seq: number) => void,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const fault: Fault =
        rng() < options.faultRate ? pick(rng, FAULTS) : 'none';
      const processDelay = int(rng, options.maxDelay + 1);
      const deliverDelay = int(rng, options.maxDelay + 1);
      const record: RequestRecord = {
        n: log.length,
        configId: options.configId,
        account: server.account,
        kind,
        arg,
        fault,
        issuedAt: scheduler.time,
        processedAt: null,
        seq: null,
        deliveredAt: null,
        outcome: 'pending',
        liveOnDelivery: false,
      };
      log.push(record);
      const fail = (error: unknown) => {
        scheduler.schedule(deliverDelay, () => {
          record.deliveredAt = scheduler.time;
          record.outcome = 'error';
          record.liveOnDelivery = options.isLive();
          reject(error);
        });
      };
      scheduler.schedule(processDelay, () => {
        record.processedAt = scheduler.time;
        if (fault === 'net-before' || fault.startsWith('http-')) {
          fail(faultError(fault));
          return;
        }
        let result: T;
        try {
          result = op();
        } catch (error) {
          fail(error);
          return;
        }
        const seq = server.nextSeq();
        record.seq = seq;
        if (fault === 'net-after') {
          fail(faultError(fault));
          return;
        }
        const snapshot = clone(result);
        scheduler.schedule(deliverDelay, () => {
          record.deliveredAt = scheduler.time;
          record.outcome = 'ok';
          record.liveOnDelivery = options.isLive();
          if (record.liveOnDelivery) onDelivered?.(snapshot, seq);
          resolve(snapshot);
        });
      });
    });

  return {
    listSavedDrills: () =>
      call(
        'listSavedDrills',
        '',
        () => server.listSavedDrills(),
        (rows, seq) =>
          sources.push({
            configId: options.configId,
            surface: 'saved',
            seq,
            kind: 'list',
            slugs: rows.map(row => row.slug),
          }),
      ),
    getDrill: slug => call('getDrill', slug, () => server.getDrill(slug)),
    saveDrill: slug => call('saveDrill', slug, () => server.saveDrill(slug)),
    unsaveDrill: slug =>
      call(
        'unsaveDrill',
        slug,
        () => server.unsaveDrill(slug),
        (_result, seq) =>
          sources.push({
            configId: options.configId,
            surface: 'saved',
            seq,
            kind: 'unsave',
            slug,
          }),
      ),
    getCurrentPlan: () =>
      call(
        'getCurrentPlan',
        '',
        () => server.getCurrentPlan(),
        (plan, seq) =>
          sources.push({
            configId: options.configId,
            surface: 'plan',
            seq,
            kind: 'plan',
            plan,
          }),
      ),
    createPlan: shotId =>
      call(
        'createPlan',
        shotId,
        () => server.createPlan(shotId, rng),
        (plan, seq) =>
          sources.push({
            configId: options.configId,
            surface: 'plan',
            seq,
            kind: 'plan',
            plan,
          }),
      ),
    completeDrill: evidence =>
      call(
        'completeDrill',
        evidence.trainingPlanItemId,
        () => server.completeDrill(evidence),
        (_completion, seq) => {
          const row = server.completions.find(
            candidate => candidate.id === evidence.id,
          );
          if (row) {
            sources.push({
              configId: options.configId,
              surface: 'plan',
              seq,
              kind: 'completion',
              planId: row.planId,
              itemId: row.itemId,
            });
          }
        },
      ),
    reassessPlan: (planId, shotId) =>
      call(
        'reassessPlan',
        `${planId}:${shotId}`,
        () => server.reassessPlan(planId, shotId),
        (plan, seq) =>
          sources.push({
            configId: options.configId,
            surface: 'plan',
            seq,
            kind: 'plan',
            plan,
          }),
      ),
  };
}

// ---------------------------------------------------------------------------
// Scripts (generated from a seed, replayable, minimizable)
// ---------------------------------------------------------------------------

type Action =
  | { type: 'loadSaved' }
  | { type: 'loadPlan' }
  | { type: 'save'; slug: number }
  | { type: 'unsave'; slug: number }
  | { type: 'createPlan' }
  | { type: 'complete'; stale: boolean }
  | { type: 'reassess' }
  | { type: 'reinstall' }
  | { type: 'switchAccount' }
  | { type: 'logout' }
  | { type: 'login' };

interface Burst {
  delay: number;
  actions: Action[];
}

interface Script {
  seed: number;
  faultRate: number;
  maxDelay: number;
  clockSkewMs: number;
  serverClockOffsetMs: number;
  preSaved: number[];
  /** Server already holds an active plan for account A. */
  prePlan: boolean;
  /** The store has loaded saved drills + plan (settled) before the bursts. */
  primed: boolean;
  bursts: Burst[];
}

const CATALOG_SIZE = 4;
const ACTIONS: readonly Action['type'][] = [
  'loadSaved',
  'loadSaved',
  'loadPlan',
  'save',
  'save',
  'unsave',
  'unsave',
  'createPlan',
  'complete',
  'complete',
  'complete',
  'reassess',
  'reinstall',
  'switchAccount',
  'logout',
  'login',
];

function generateScript(seed: number): Script {
  const rng = mulberry32(seed);
  const maxDelay = 1 + int(rng, 6);
  const faultRate = pick(rng, [0, 0, 0.1, 0.25]);
  const bursts: Burst[] = [];
  const burstCount = 1 + int(rng, 5);
  for (let b = 0; b < burstCount; b += 1) {
    const actions: Action[] = [];
    const count = 1 + int(rng, 5);
    for (let a = 0; a < count; a += 1) {
      const previous = actions[actions.length - 1];
      if (previous && rng() < 0.25) {
        actions.push(clone(previous));
        continue;
      }
      const type = pick(rng, ACTIONS);
      switch (type) {
        case 'save':
        case 'unsave':
          actions.push({ type, slug: int(rng, CATALOG_SIZE) });
          break;
        case 'complete':
          actions.push({ type, stale: rng() < 0.3 });
          break;
        default:
          actions.push({ type });
      }
    }
    bursts.push({ delay: b === 0 ? 0 : int(rng, maxDelay * 2 + 1), actions });
  }
  const preSaved = [
    ...new Set(
      Array.from({ length: int(rng, 3) }, () => int(rng, CATALOG_SIZE)),
    ),
  ];
  return {
    seed,
    faultRate,
    maxDelay,
    clockSkewMs: pick(rng, [
      0,
      0,
      -86_400_000,
      86_400_000,
      3_600_000 * 13,
      -59_000,
    ]),
    serverClockOffsetMs: pick(rng, [0, 0, 90_000, -90_000, 7 * 86_400_000]),
    preSaved,
    prePlan: rng() < 0.7,
    primed: rng() < 0.6,
    bursts,
  };
}

// ---------------------------------------------------------------------------
// Execution + invariants
// ---------------------------------------------------------------------------

type ViolationKind =
  | 'deadlock'
  | 'stuck-mutation'
  | 'stuck-loading'
  | 'isolation:cross-account'
  | 'isolation:post-logout'
  | 'duplicate-saved-rows'
  | 'double-api-call'
  | 'lost-update:saved'
  | 'lost-update:plan'
  | 'lost-update:completion'
  | 'double-spend:completion'
  | 'evidence:completedAt'
  | 'threw';

interface Violation {
  kind: ViolationKind;
  detail: string;
}

interface IterationResult {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  violations: Violation[];
  metrics: {
    storeCalls: number;
    apiCalls: number;
    apiCallsByKind: Record<string, number>;
    apiOkByKind: Record<string, number>;
    overlappingRequests: number;
    events: number;
    wallMs: number;
    duplicateCompletionRows: number;
    duplicateCompletionRowsByCause: Record<string, number>;
  };
}

const MAX_EVENTS = 5_000;
const ITERATION_WALL_MS = 5_000;

const storeDefaults = () => {
  const state = useTrainingStore.getState();
  return {
    savedStatus: state.savedStatus,
    savedDrills: state.savedDrills,
    drillDetails: state.drillDetails,
    savedError: state.savedError,
    planStatus: state.planStatus,
    currentPlan: state.currentPlan,
    planError: state.planError,
    mutation: state.mutation,
    mutationError: state.mutationError,
  };
};

const accountOf = (id: string): string => /acct-[a-z]/.exec(id)?.[0] ?? '';

const countBy = (keys: string[]): Record<string, number> =>
  keys.reduce<Record<string, number>>((acc, key) => {
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

const sumBy = (records: Record<string, number>[]): Record<string, number> =>
  records.reduce<Record<string, number>>((acc, record) => {
    for (const [key, value] of Object.entries(record)) {
      acc[key] = (acc[key] ?? 0) + value;
    }
    return acc;
  }, {});

async function runScript(script: Script): Promise<IterationResult> {
  const startedAt = performance.now();
  jest.setSystemTime(BASE_EPOCH_MS + script.clockSkewMs);
  const rng = mulberry32(script.seed ^ 0x9e3779b9);
  const scheduler = new Scheduler();
  const log: RequestRecord[] = [];
  const sources: DeliveredSource[] = [];
  const violations: Violation[] = [];
  const outstanding: Promise<unknown>[] = [];
  const catalogFor = (account: string) =>
    Array.from({ length: CATALOG_SIZE }, (_, i) => `${account}.drill-${i}`);
  const servers = new Map<string, TrainingServer>();
  const serverFor = (account: string) => {
    let server = servers.get(account);
    if (!server) {
      server = new TrainingServer(
        account,
        catalogFor(account),
        scheduler,
        script.serverClockOffsetMs,
      );
      servers.set(account, server);
    }
    return server;
  };
  let configId = 0;
  let currentAccount: string | null = null;
  let currentConfigId = -1;
  let storeMutationCalls = 0;
  const apiCallsBefore = () =>
    log.filter(
      r =>
        r.kind !== 'listSavedDrills' &&
        r.kind !== 'getDrill' &&
        r.kind !== 'getCurrentPlan',
    ).length;
  const staleItems: TrainingPlanItem[] = [];
  // What the store's own plan said about the item at the moment the user
  // tapped complete (keyed by the request that the tap produced).
  const completeContext = new Map<
    number,
    { storeHasItem: boolean; storeShowsCompleted: boolean }
  >();

  const install = (account: string) => {
    configId += 1;
    const id = configId;
    currentAccount = account;
    currentConfigId = id;
    configureTrainingStore(
      createFakeApi({
        configId: id,
        server: serverFor(account),
        scheduler,
        rng,
        faultRate: script.faultRate,
        maxDelay: script.maxDelay,
        log,
        sources,
        isLive: () => currentConfigId === id,
      }),
    );
  };

  const accountA = 'acct-a';
  const accountB = 'acct-b';
  for (const index of script.preSaved) {
    serverFor(accountA).saveDrill(`${accountA}.drill-${index}`);
  }
  if (script.prePlan) serverFor(accountA).createPlan(uuidAt(0xa00), rng);
  install(accountA);

  const fire = (action: Action) => {
    const state = useTrainingStore.getState();
    const account = currentAccount;
    const slugOf = (index: number) => `${account ?? accountA}.drill-${index}`;
    switch (action.type) {
      case 'loadSaved':
        return state.loadSavedDrills();
      case 'loadPlan':
        return state.loadCurrentPlan();
      case 'save':
        storeMutationCalls += 1;
        return state.setDrillSaved(slugOf(action.slug), true);
      case 'unsave':
        storeMutationCalls += 1;
        return state.setDrillSaved(slugOf(action.slug), false);
      case 'createPlan':
        storeMutationCalls += 1;
        return state.createPlan(uuidAt(0xa11));
      case 'complete': {
        const open = state.currentPlan?.items.find(
          item => item.drill !== null && item.completion === null,
        );
        if (open) staleItems.push(clone(open));
        const target = action.stale
          ? (staleItems[int(rng, staleItems.length)] ?? open)
          : open;
        if (!target) return Promise.resolve(false);
        storeMutationCalls += 1;
        const inStore = state.currentPlan?.items.find(
          item => item.id === target.id,
        );
        const logBefore = log.length;
        const promise = state.completePlanItem(target);
        const issued = log[logBefore];
        if (issued && issued.kind === 'completeDrill') {
          completeContext.set(issued.n, {
            storeHasItem: inStore !== undefined,
            storeShowsCompleted: (inStore?.completion ?? null) !== null,
          });
        }
        return promise;
      }
      case 'reassess':
        storeMutationCalls += 1;
        return state.reassessCurrentPlan(uuidAt(0xb22));
      case 'reinstall':
        if (account) install(account);
        return Promise.resolve(true);
      case 'switchAccount':
        install(account === accountA ? accountB : accountA);
        return Promise.resolve(true);
      case 'logout':
        currentAccount = null;
        currentConfigId = -1;
        clearTrainingStoreConfiguration();
        return Promise.resolve(true);
      case 'login':
        if (!account) install(accountA);
        return Promise.resolve(true);
    }
  };

  if (script.primed) {
    const primeLoads = [
      useTrainingStore.getState().loadSavedDrills(),
      useTrainingStore.getState().loadCurrentPlan(),
    ];
    await scheduler.drain(MAX_EVENTS);
    await Promise.allSettled(primeLoads);
  }

  let cursor = 0;
  for (const burst of script.bursts) {
    cursor += burst.delay;
    scheduler.schedule(cursor, () => {
      for (const action of burst.actions) {
        outstanding.push(
          fire(action).catch(error => {
            violations.push({
              kind: 'threw',
              detail: `${action.type}: ${String(error)}`,
            });
          }),
        );
      }
    });
  }

  let events = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error('iteration exceeded wall-time budget')),
        ITERATION_WALL_MS,
      );
    });
    events = await Promise.race([
      (async () => {
        const drained = await scheduler.drain(MAX_EVENTS);
        await Promise.allSettled(outstanding);
        return drained;
      })(),
      timeout,
    ]);
  } catch (error) {
    violations.push({ kind: 'deadlock', detail: String(error) });
  } finally {
    if (deadline) clearTimeout(deadline);
  }

  const state = useTrainingStore.getState();
  if (state.mutation !== 'idle') {
    violations.push({
      kind: 'stuck-mutation',
      detail: JSON.stringify(state.mutation),
    });
  }
  if (state.savedStatus === 'loading' || state.planStatus === 'loading') {
    violations.push({
      kind: 'stuck-loading',
      detail: `saved=${state.savedStatus} plan=${state.planStatus}`,
    });
  }

  const mentionedAccounts = new Set<string>();
  for (const slug of state.savedDrills.map(row => row.slug)) {
    mentionedAccounts.add(accountOf(slug));
  }
  for (const slug of Object.keys(state.drillDetails)) {
    mentionedAccounts.add(accountOf(slug));
  }
  if (state.currentPlan) {
    mentionedAccounts.add(accountOf(state.currentPlan.id));
    for (const item of state.currentPlan.items) {
      if (item.drill) mentionedAccounts.add(accountOf(item.drill.slug));
    }
  }
  if (currentAccount === null) {
    // After logout the store may only hold the reset shape: no rows, no plan,
    // idle/unconfigured statuses and at most `training.unconfigured` errors.
    const snapshot = storeDefaults();
    const unconfiguredOnly = (error: { code: string } | null) =>
      error === null || error.code === 'training.unconfigured';
    const clean =
      snapshot.savedDrills.length === 0 &&
      Object.keys(snapshot.drillDetails).length === 0 &&
      snapshot.currentPlan === null &&
      snapshot.mutation === 'idle' &&
      (snapshot.savedStatus === 'idle' ||
        snapshot.savedStatus === 'unconfigured') &&
      (snapshot.planStatus === 'idle' ||
        snapshot.planStatus === 'unconfigured') &&
      unconfiguredOnly(snapshot.savedError) &&
      unconfiguredOnly(snapshot.planError) &&
      unconfiguredOnly(snapshot.mutationError);
    if (!clean) {
      violations.push({
        kind: 'isolation:post-logout',
        detail: JSON.stringify(snapshot),
      });
    }
  } else {
    const account: string = currentAccount;
    const foreign = [...mentionedAccounts].filter(
      candidate => candidate !== '' && candidate !== account,
    );
    if (foreign.length > 0) {
      violations.push({
        kind: 'isolation:cross-account',
        detail: `store for ${account} mentions ${foreign.join(',')}`,
      });
    }
  }

  const savedSlugs = state.savedDrills.map(row => row.slug);
  if (new Set(savedSlugs).size !== savedSlugs.length) {
    violations.push({
      kind: 'duplicate-saved-rows',
      detail: savedSlugs.join(','),
    });
  }

  const mutationApiCalls = apiCallsBefore();
  if (mutationApiCalls > storeMutationCalls) {
    violations.push({
      kind: 'double-api-call',
      detail: `${mutationApiCalls} mutation requests for ${storeMutationCalls} store calls`,
    });
  }

  // Lost-update oracle: the store must reflect the freshest response it
  // received on the live configuration (older responses never win).
  const liveSources = sources.filter(s => s.configId === currentConfigId);
  if (currentAccount !== null && state.savedStatus === 'ready') {
    const lists = liveSources.filter(
      (s): s is Extract<DeliveredSource, { kind: 'list' }> => s.kind === 'list',
    );
    const freshestList = lists.reduce<Extract<
      DeliveredSource,
      { kind: 'list' }
    > | null>(
      (best, s) => (best === null || s.seq > best.seq ? s : best),
      null,
    );
    if (freshestList) {
      const expected = new Set(freshestList.slugs);
      for (const s of liveSources) {
        if (s.kind === 'unsave' && s.seq > freshestList.seq)
          expected.delete(s.slug);
      }
      const actual = new Set(savedSlugs);
      const missing = [...expected].filter(slug => !actual.has(slug));
      const extra = [...actual].filter(slug => !expected.has(slug));
      if (missing.length > 0 || extra.length > 0) {
        violations.push({
          kind: 'lost-update:saved',
          detail: `store=[${[...actual].join(',')}] freshest(seq ${freshestList.seq})=[${[...expected].join(',')}] missing=[${missing.join(',')}] extra=[${extra.join(',')}]`,
        });
      }
    }
  }
  if (currentAccount !== null && state.planStatus === 'ready') {
    const plans = liveSources.filter(
      (s): s is Extract<DeliveredSource, { kind: 'plan' }> => s.kind === 'plan',
    );
    const freshestPlan = plans.reduce<Extract<
      DeliveredSource,
      { kind: 'plan' }
    > | null>(
      (best, s) => (best === null || s.seq > best.seq ? s : best),
      null,
    );
    if (freshestPlan) {
      const expectedPlan = freshestPlan.plan;
      const actualPlan = state.currentPlan;
      // GET current returns null once a plan is no longer active, while a
      // reassessment response legitimately leaves the completed plan on
      // screen: `null` and a non-active plan describe the same server truth.
      const identityMatches =
        (expectedPlan?.id ?? null) === (actualPlan?.id ?? null) ||
        (expectedPlan === null &&
          actualPlan !== null &&
          actualPlan.status !== 'active');
      if (!identityMatches) {
        violations.push({
          kind: 'lost-update:plan',
          detail: `store plan=${actualPlan ? `${actualPlan.id}(${actualPlan.status})` : null} freshest(seq ${freshestPlan.seq})=${expectedPlan ? `${expectedPlan.id}(${expectedPlan.status})` : null}`,
        });
      } else if (expectedPlan && actualPlan) {
        const expectedCompleted = new Set(
          expectedPlan.items
            .filter(item => item.completion !== null)
            .map(item => item.id),
        );
        for (const s of liveSources) {
          if (
            s.kind === 'completion' &&
            s.planId === expectedPlan.id &&
            s.seq > freshestPlan.seq
          ) {
            expectedCompleted.add(s.itemId);
          }
        }
        const actualCompleted = new Set(
          actualPlan.items
            .filter(item => item.completion !== null)
            .map(item => item.id),
        );
        const lost = [...expectedCompleted].filter(
          id => !actualCompleted.has(id),
        );
        const phantom = [...actualCompleted].filter(
          id => !expectedCompleted.has(id),
        );
        if (lost.length > 0 || phantom.length > 0) {
          violations.push({
            kind: 'lost-update:completion',
            detail: `plan ${actualPlan.id} lost=[${lost.join(',')}] phantom=[${phantom.join(',')}]`,
          });
        }
      }
    }
  }

  // Double-spend oracle: one completion row per plan item, attributed.
  const duplicateCompletionRowsByCause: Record<string, number> = {};
  let duplicateCompletionRows = 0;
  for (const server of servers.values()) {
    const byItem = new Map<string, ServerCompletionRow[]>();
    for (const row of server.completions) {
      const rows = byItem.get(row.itemId) ?? [];
      rows.push(row);
      byItem.set(row.itemId, rows);
    }
    for (const [itemId, rows] of byItem) {
      if (rows.length < 2) continue;
      duplicateCompletionRows += rows.length - 1;
      const requests = log
        .filter(
          r =>
            r.kind === 'completeDrill' &&
            r.arg === itemId &&
            r.account === server.account,
        )
        .sort((a, b) => a.n - b.n);
      for (let i = 1; i < requests.length; i += 1) {
        const current = requests[i];
        if (!current || current.seq === null) continue;
        const earlier = requests.slice(0, i);
        const context = completeContext.get(current.n);
        const knownSuccess = earlier.some(
          r =>
            r.outcome === 'ok' &&
            r.liveOnDelivery &&
            r.deliveredAt !== null &&
            r.deliveredAt <= current.issuedAt,
        );
        const lostSuccess = earlier.some(
          r => r.seq !== null && !r.liveOnDelivery,
        );
        const netAfter = earlier.some(
          r =>
            r.fault === 'net-after' &&
            r.deliveredAt !== null &&
            r.deliveredAt <= current.issuedAt,
        );
        const cause = knownSuccess
          ? context?.storeShowsCompleted
            ? 'stale-item-object-recompleted'
            : context && !context.storeHasItem
              ? 'item-not-in-store-plan'
              : 'stale-reload-cleared-completion'
          : netAfter
            ? 'retry-after-network-loss-new-id'
            : lostSuccess
              ? 'reinstall-discarded-success'
              : 'concurrent-in-flight';
        duplicateCompletionRowsByCause[cause] =
          (duplicateCompletionRowsByCause[cause] ?? 0) + 1;
        violations.push({
          kind: 'double-spend:completion',
          detail: `${server.account} ${itemId} rows=${rows.length} cause=${cause}`,
        });
      }
    }
  }

  // Clock skew: the client stamps evidence with its own (skewed) clock and
  // must store the server's authoritative completedAt verbatim.
  const expectedClientStamp = new Date(
    BASE_EPOCH_MS + script.clockSkewMs,
  ).toISOString();
  for (const server of servers.values()) {
    for (const row of server.completions) {
      if (row.clientCompletedAt !== expectedClientStamp) {
        violations.push({
          kind: 'evidence:completedAt',
          detail: `client stamped ${row.clientCompletedAt}, expected ${expectedClientStamp}`,
        });
      }
    }
  }
  if (state.currentPlan) {
    const server = servers.get(currentAccount ?? '');
    for (const item of state.currentPlan.items) {
      if (!item.completion || !server) continue;
      const row = server.completions.find(r => r.id === item.completion?.id);
      if (row && row.completedAt !== item.completion.completedAt) {
        violations.push({
          kind: 'evidence:completedAt',
          detail: `store kept ${item.completion.completedAt}, server said ${row.completedAt}`,
        });
      }
    }
  }

  const wallMs = performance.now() - startedAt;
  return {
    seed: script.seed,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    metrics: {
      storeCalls: storeMutationCalls,
      apiCalls: log.length,
      apiCallsByKind: countBy(log.map(r => r.kind)),
      apiOkByKind: countBy(
        log.filter(r => r.outcome === 'ok').map(r => r.kind),
      ),
      overlappingRequests: log.filter(a =>
        log.some(
          b =>
            b !== a &&
            b.issuedAt >= a.issuedAt &&
            a.deliveredAt !== null &&
            b.issuedAt < a.deliveredAt,
        ),
      ).length,
      events,
      wallMs,
      duplicateCompletionRows,
      duplicateCompletionRowsByCause,
    },
  };
}

async function runSeed(seed: number): Promise<IterationResult> {
  return runScript(generateScript(seed));
}

async function minimize(script: Script, kind: ViolationKind): Promise<Script> {
  const fails = async (candidate: Script) =>
    (await runScript(candidate)).violations.some(v => v.kind === kind);
  let current = script;
  let progress = true;
  while (progress) {
    progress = false;
    for (let b = 0; b < current.bursts.length && !progress; b += 1) {
      const burst = current.bursts[b];
      if (!burst) continue;
      for (let a = 0; a < burst.actions.length; a += 1) {
        const candidate: Script = clone(current);
        const target = candidate.bursts[b];
        if (!target) continue;
        target.actions.splice(a, 1);
        if (target.actions.length === 0) candidate.bursts.splice(b, 1);
        if (candidate.bursts.length === 0) continue;
        if (await fails(candidate)) {
          current = candidate;
          progress = true;
          break;
        }
      }
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const ITERATIONS = Number(process.env['STRESS_ITER'] ?? 500);
const ONLY_SEED = process.env['STRESS_SEED'];
const OUT_DIR = process.env['STRESS_OUT_DIR'];
const CAMPAIGN_WALL_BUDGET_MS = 25_000 + ITERATIONS * 40;

const results: IterationResult[] = [];
const minimized: Record<
  string,
  { seed: number; script: Script; violations: Violation[] }[]
> = {};
let campaignWallMs = 0;

const failingSeeds = (kind: ViolationKind) =>
  results.filter(r => r.violations.some(v => v.kind === kind)).map(r => r.seed);

// Each failing seed is rendered as a self-describing line so the assertion
// diff itself carries the replay seeds and the observed violation.
const expectHeld = (kind: ViolationKind) => {
  const seeds = failingSeeds(kind);
  const report = results
    .filter(r => seeds.includes(r.seed))
    .map(
      r =>
        `${kind} seed=${r.seed} (${seeds.length}/${results.length} seeds): ${r.violations
          .filter(v => v.kind === kind)
          .map(v => v.detail)
          .join(' | ')}`,
    );
  expect(report).toEqual([]);
};

beforeAll(async () => {
  jest.useFakeTimers({
    doNotFake: [
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'nextTick',
      'queueMicrotask',
      'hrtime',
      'performance',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
    ],
    now: BASE_EPOCH_MS,
  });
  const startedAt = performance.now();
  const seeds = ONLY_SEED
    ? [Number(ONLY_SEED)]
    : Array.from({ length: ITERATIONS }, (_, i) => 1 + i);
  for (const seed of seeds) {
    clearTrainingStoreConfiguration();
    results.push(await runSeed(seed));
  }
  campaignWallMs = performance.now() - startedAt;

  const kinds = [
    ...new Set(results.flatMap(r => r.violations.map(v => v.kind))),
  ];
  for (const kind of kinds) {
    const list: { seed: number; script: Script; violations: Violation[] }[] =
      [];
    for (const seed of failingSeeds(kind).slice(0, 3)) {
      clearTrainingStoreConfiguration();
      const script = await minimize(generateScript(seed), kind);
      clearTrainingStoreConfiguration();
      const replay = await runScript(script);
      list.push({
        seed,
        script,
        violations: replay.violations.filter(v => v.kind === kind),
      });
    }
    minimized[kind] = list;
  }

  if (OUT_DIR) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const summary = {
      suite: 'trainingStoreConcurrency.stress',
      iterations: results.length,
      campaignWallMs: Math.round(campaignWallMs),
      held: results.filter(r => r.outcome === 'HELD').length,
      broken: results.filter(r => r.outcome === 'BROKEN').length,
      violationsByKind: Object.fromEntries(
        kinds.map(kind => [kind, failingSeeds(kind).length]),
      ),
      duplicateCompletionRowsByCause: sumBy(
        results.map(r => r.metrics.duplicateCompletionRowsByCause),
      ),
      totals: {
        storeCalls: results.reduce((n, r) => n + r.metrics.storeCalls, 0),
        apiCalls: results.reduce((n, r) => n + r.metrics.apiCalls, 0),
        apiCallsByKind: sumBy(results.map(r => r.metrics.apiCallsByKind)),
        apiOkByKind: sumBy(results.map(r => r.metrics.apiOkByKind)),
        overlappingRequests: results.reduce(
          (n, r) => n + r.metrics.overlappingRequests,
          0,
        ),
        iterationsWithOverlap: results.filter(
          r => r.metrics.overlappingRequests > 0,
        ).length,
        events: results.reduce((n, r) => n + r.metrics.events, 0),
      },
      minimized,
      results,
    };
    fs.writeFileSync(
      path.join(OUT_DIR, 'trainingStoreConcurrency.json'),
      JSON.stringify(summary, null, 2),
    );
  }
}, 600_000);

afterAll(() => {
  jest.useRealTimers();
  clearTrainingStoreConfiguration();
});

describe('training store under seeded concurrent interleavings', () => {
  it('executes every seeded interleaving to quiescence within bounded wall time', () => {
    expect(results).toHaveLength(ONLY_SEED ? 1 : ITERATIONS);
    expect(results.map(r => r.seed)).toEqual([
      ...new Set(results.map(r => r.seed)),
    ]);
    expect(
      results.every(r => r.metrics.events > 0 || r.metrics.apiCalls === 0),
    ).toBe(true);
    expectHeld('deadlock');
    expectHeld('threw');
    expect(campaignWallMs).toBeLessThan(CAMPAIGN_WALL_BUDGET_MS);
  });

  it('releases the mutation lock and loading statuses after every interleaving', () => {
    expectHeld('stuck-mutation');
    expectHeld('stuck-loading');
  });

  it('never leaks previous-account or post-logout data into the store', () => {
    expectHeld('isolation:cross-account');
    expectHeld('isolation:post-logout');
  });

  it('never duplicates saved-drill rows and issues at most one request per store mutation', () => {
    expectHeld('duplicate-saved-rows');
    expectHeld('double-api-call');
  });

  it('keeps the plan id in freshness order (no lost update on plan identity)', () => {
    expectHeld('lost-update:plan');
  });

  it('keeps saved drills in freshness order (no lost update on saved rows)', () => {
    expectHeld('lost-update:saved');
  });

  it('keeps plan completions in freshness order (no lost update on completions)', () => {
    expectHeld('lost-update:completion');
  });

  it('never spends a plan item completion twice', () => {
    expectHeld('double-spend:completion');
  });

  it('only sends ISO completion timestamps under client/server clock skew', () => {
    expectHeld('evidence:completedAt');
  });
});

describe('training store: minimal deterministic interleavings', () => {
  it('a slow focus reload must not resurrect a drill the user unsaved during it', async () => {
    clearTrainingStoreConfiguration();
    const script: Script = {
      seed: -1,
      faultRate: 0,
      maxDelay: 4,
      clockSkewMs: 0,
      serverClockOffsetMs: 0,
      preSaved: [0],
      prePlan: false,
      primed: false,
      bursts: [
        // Focus reload starts (list processed early, details delivered late).
        { delay: 0, actions: [{ type: 'loadSaved' }] },
        // User taps Unsave while the reload is still in flight.
        { delay: 1, actions: [{ type: 'unsave', slug: 0 }] },
      ],
    };
    let result: IterationResult | null = null;
    // Deterministic latency search: the first schedule that interleaves
    // list-before-unsave and delivery-after-unsave exposes the race.
    for (
      let seed = 1;
      seed <= 64 && !(result && result.outcome === 'BROKEN');
      seed += 1
    ) {
      clearTrainingStoreConfiguration();
      result = await runScript({ ...script, seed });
    }
    expect(result).not.toBeNull();
    const lostUpdates = (result?.violations ?? [])
      .filter(v => v.kind === 'lost-update:saved')
      .map(v => `seed=${result?.seed} ${v.detail}`);
    expect(lostUpdates).toEqual([]);
  });

  it('a slow plan reload must not un-complete an item the user finished during it', async () => {
    clearTrainingStoreConfiguration();
    const script: Script = {
      seed: -2,
      faultRate: 0,
      maxDelay: 4,
      clockSkewMs: 0,
      serverClockOffsetMs: 0,
      preSaved: [],
      prePlan: true,
      primed: true,
      bursts: [
        // Plan screen refocuses (reload processed early, delivered late).
        { delay: 0, actions: [{ type: 'loadPlan' }] },
        // User marks the first open item done while the reload is in flight.
        { delay: 1, actions: [{ type: 'complete', stale: false }] },
      ],
    };
    let result: IterationResult | null = null;
    for (
      let seed = 1;
      seed <= 64 && !(result && result.outcome === 'BROKEN');
      seed += 1
    ) {
      clearTrainingStoreConfiguration();
      result = await runScript({ ...script, seed });
    }
    expect(result).not.toBeNull();
    const lostUpdates = (result?.violations ?? [])
      .filter(v => v.kind === 'lost-update:completion')
      .map(v => `seed=${result?.seed} ${v.detail}`);
    expect(lostUpdates).toEqual([]);
  });

  it('retrying a completion whose response was lost must reuse the evidence id (idempotent)', async () => {
    clearTrainingStoreConfiguration();
    const script: Script = {
      seed: -3,
      faultRate: 0.5, // the search below finds a schedule whose first completion is net-after
      maxDelay: 1,
      clockSkewMs: 0,
      serverClockOffsetMs: 0,
      preSaved: [],
      prePlan: true,
      primed: true,
      bursts: [
        { delay: 0, actions: [{ type: 'complete', stale: false }] },
        { delay: 3, actions: [{ type: 'complete', stale: true }] },
      ],
    };
    let result: IterationResult | null = null;
    for (
      let seed = 1;
      seed <= 256 && !(result && result.outcome === 'BROKEN');
      seed += 1
    ) {
      clearTrainingStoreConfiguration();
      result = await runScript({ ...script, seed });
      // Only the net-after schedule is the case under test; other faults make
      // the first request fail before the server applied it.
      if (
        result.metrics.duplicateCompletionRowsByCause[
          'retry-after-network-loss-new-id'
        ] === undefined
      ) {
        result = { ...result, outcome: 'HELD', violations: [] };
      }
    }
    expect(result).not.toBeNull();
    const duplicates = (result?.violations ?? [])
      .filter(v => v.kind === 'double-spend:completion')
      .map(v => `seed=${result?.seed} ${v.detail}`);
    expect(duplicates).toEqual([]);
  });
});
