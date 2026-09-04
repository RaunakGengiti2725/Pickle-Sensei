/**
 * STRESS · mod-training · lens `boundary-malformed` · layer: `training/store.ts`
 *
 * Campaign `store-sequence`: the REAL `createTrainingApi` is wired to a seeded
 * hostile transport (valid / mutated / corrupted / error / 401 / thrown /
 * slow responses, catalog slugs drawn from Object.prototype member names and
 * unicode pairs) and `useTrainingStore` is driven through random operation
 * sequences: loads, plan create / reassess, save / unsave, complete-item,
 * concurrent double-fire, reconfigure-mid-flight, clear-configuration, reset.
 *
 * Invariants checked after EVERY operation:
 *   1. the store method resolves to a boolean — it never rejects;
 *   2. state stays coherent: statuses in their enum, `mutation` back to
 *      'idle' once every in-flight op settled, errors are TrainingErrorState
 *      or null, `savedDrills` / `currentPlan` / `drillDetails` entries satisfy
 *      the independent validators, and a `drillDetails[slug]` lookup for a
 *      saved / plan slug is either undefined or a DrillDetail;
 *   3. 'unconfigured' status only while the store really has no api;
 *   4. write safety: at most ONE write request (PUT / DELETE / POST) per
 *      mutation op, none while another mutation is in flight, none after
 *      the configuration changed under an in-flight op;
 *   5. a response that arrives after reconfigure / clear never lands in state;
 *   6. Object.prototype / Array.prototype stay clean.
 *
 * Replay one row:  STRESS_ONLY=store-sequence:<seed> npx jest modTrainingBoundaryStore
 * Full campaign:   STRESS_ITER=1500 npx jest modTrainingBoundaryStore
 * Table:           apps/mobile/artifacts/stress/mod-training/store-sequence.json
 */
import { createTrainingApi } from '../../src/training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
  type TrainingStoreState,
} from '../../src/training/store';
import type { TrainingPlanItem } from '../../src/training/types';
import {
  FIX,
  INHERITED_SLUGS,
  Rng,
  apiConfig,
  corruptJsonText,
  describeError,
  drillDetailWire,
  fakeResponse,
  globalPollution,
  hostileString,
  iterations,
  mutate,
  onlySeed,
  planWire,
  recordingFetch,
  savedDrillWire,
  seedFor,
  validDrillDetail,
  validErrorState,
  validPlan,
  validSavedDrill,
  writeTable,
  type Outcome,
  type Recorded,
  type TableRow,
} from '../../test-support/stress/modTrainingBoundary';

const mockRecordDrillCompletion = jest.fn(async () => undefined);
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: {
    getState: () => ({ recordDrillCompletion: mockRecordDrillCompletion }),
  },
}));

// ─── Hostile transport routed by URL ─────────────────────────────────────────

const PLAIN_SLUGS: readonly string[] = [
  FIX.slug,
  'second-drill',
  'third-drill',
];
const HOSTILE_SLUGS: readonly string[] = [
  ...INHERITED_SLUGS,
  '__proto__',
  'prototype',
  'caf\u00e9',
  'cafe\u0301',
  'a\u0000b',
  '..',
  '.',
  'x'.repeat(120),
];

function slugFor(rng: Rng): string {
  return rng.bool(0.3) ? rng.pick(HOSTILE_SLUGS) : rng.pick(PLAIN_SLUGS);
}

interface HostileServer {
  fetchFn: ReturnType<typeof recordingFetch>['fetchFn'];
  calls: Recorded[];
  /** Slugs the server will hand out in list / plan payloads this session. */
  slugs: string[];
}

function decodeSlug(url: string, prefix: string): string {
  const path = url.split('?')[0] ?? url;
  const at = path.indexOf(prefix);
  const rest = path.slice(at + prefix.length).split('/')[0] ?? '';
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

function hostileServer(rng: Rng, slow: () => Promise<void>): HostileServer {
  const slugs = Array.from({ length: rng.int(0, 5) }, () => slugFor(rng));
  const errorBodies: unknown[] = [
    {
      error: { code: 'validation.saved_drill', message: 'Invalid drill slug.' },
    },
    {
      error: {
        code: 'training.unconfigured',
        message: 'server says unconfigured',
      },
    },
    {
      error: {
        code: 'training.session_expired',
        message: 'server says expired',
      },
    },
    { error: { code: 'training.plan_unavailable', message: 'No plans yet.' } },
    { error: { code: hostileString(rng), message: hostileString(rng) } },
    { error: 'string' },
    { error: null },
    [],
    'nope',
    { detail: 'stack trace: at Object.<anonymous> (/srv/index.ts:42)' },
  ];
  const { fetchFn, calls } = recordingFetch(async recorded => {
    if (rng.bool(0.15)) await slow();
    const url = recorded.url;
    const roll = rng.next();
    if (roll < 0.06) throw new TypeError('Network request failed');
    if (roll < 0.1) return fakeResponse(401, { json: rng.pick(errorBodies) });
    if (roll < 0.22) {
      return fakeResponse(
        rng.pick([400, 403, 404, 409, 413, 422, 429, 500, 502, 503]),
        { json: rng.pick(errorBodies) },
      );
    }
    if (roll < 0.28) {
      const corrupted = corruptJsonText(
        validBody(url, slugs, recorded.method),
        rng,
      );
      return fakeResponse(200, { text: corrupted.text });
    }
    if (roll < 0.5) {
      const { value } = mutate(
        validBody(url, slugs, recorded.method),
        rng,
        rng.int(1, 3),
      );
      return fakeResponse(rng.pick([200, 200, 204]), { json: value });
    }
    if (recorded.method === 'DELETE') return fakeResponse(204, { json: null });
    return fakeResponse(200, { json: validBody(url, slugs, recorded.method) });
  });
  return { fetchFn, calls, slugs };
}

function validBody(url: string, slugs: string[], method: string): unknown {
  if (url.includes('/v1/me/saved-drills/')) {
    return { slug: decodeSlug(url, '/v1/me/saved-drills/'), saved: true };
  }
  if (url.includes('/v1/me/saved-drills')) {
    return { items: slugs.map(slug => savedDrillWire(slug)) };
  }
  if (url.includes('/v1/catalog/drills/')) {
    return drillDetailWire(decodeSlug(url, '/v1/catalog/drills/'));
  }
  if (url.includes('/v1/training-plans/current')) {
    return { plan: slugs.length === 0 ? null : planWire(slugs[0]) };
  }
  if (url.includes('/v1/training-plans')) {
    return { plan: planWire(slugs[0] ?? FIX.slug) };
  }
  if (url.includes('/v1/drill-completions')) {
    return {
      completion: {
        id: FIX.uuid.completion,
        completedAt: '2026-08-27T19:00:00.000Z',
        actualRepetitions: 24,
        actualDurationSeconds: null,
        qualifiesForStreak: true,
      },
    };
  }
  return method === 'DELETE' ? null : {};
}

// ─── Operation model ─────────────────────────────────────────────────────────

type OpName =
  | 'loadSavedDrills'
  | 'loadCurrentPlan'
  | 'createPlan'
  | 'reassessCurrentPlan'
  | 'setDrillSaved'
  | 'completePlanItem'
  | 'concurrent-mutations'
  | 'reconfigure-mid-flight'
  | 'clear-mid-flight'
  | 'clearConfiguration'
  | 'reset'
  | 'clearMutationError';

const OPS: readonly OpName[] = [
  'loadSavedDrills',
  'loadSavedDrills',
  'loadCurrentPlan',
  'loadCurrentPlan',
  'createPlan',
  'reassessCurrentPlan',
  'setDrillSaved',
  'setDrillSaved',
  'completePlanItem',
  'concurrent-mutations',
  'reconfigure-mid-flight',
  'clear-mid-flight',
  'clearConfiguration',
  'reset',
  'clearMutationError',
];

function isWrite(call: Recorded): boolean {
  return call.method !== 'GET';
}

function syntheticItem(rng: Rng): TrainingPlanItem {
  const kind = rng.pick(['warmup', 'targeted', 'reassessment'] as const);
  const hostileTarget = rng.bool(0.4);
  return {
    id: rng.bool(0.8) ? FIX.uuid.item2 : hostileString(rng),
    position: rng.bool(0.8) ? 2 : rng.pick([0, -1, 2 ** 53, Number.NaN]),
    kind,
    drill:
      kind === 'reassessment' || rng.bool(0.15)
        ? null
        : {
            slug: slugFor(rng),
            title: 'Contact Shadow Reps',
            description: 'x',
            coachName: 'Coach',
            equipment: [],
            saved: rng.bool(),
          },
    cueText: null,
    targetSets: hostileTarget
      ? rng.pick([0, -1, 1e308, Number.MAX_SAFE_INTEGER, 0.5, null])
      : 3,
    targetRepetitionsPerSet: hostileTarget
      ? rng.pick([null, 0, -8, 1e308, Number.MAX_SAFE_INTEGER])
      : 8,
    targetDurationSeconds: hostileTarget
      ? rng.pick([null, 0, -60, 1e308])
      : null,
    restSeconds: null,
    completion: rng.bool(0.15)
      ? {
          id: FIX.uuid.completion,
          completedAt: '2026-08-27T19:00:00.000Z',
          actualRepetitions: 1,
          actualDurationSeconds: null,
          qualifiesForStreak: true,
        }
      : null,
  };
}

interface Session {
  rng: Rng;
  configured: boolean;
  server: HostileServer | null;
  /** Deferred slow responses waiting for `release()`. */
  pending: Array<() => void>;
}

function slowGate(session: Session): () => Promise<void> {
  return () =>
    new Promise<void>(resolve => {
      session.pending.push(resolve);
    });
}

function release(session: Session): void {
  const waiting = session.pending.splice(0);
  for (const resolve of waiting) resolve();
}

function configure(session: Session): void {
  const server = hostileServer(session.rng, slowGate(session));
  session.server = server;
  session.configured = true;
  configureTrainingStore(createTrainingApi(apiConfig(server.fetchFn)));
}

async function settleAll(
  session: Session,
  promises: Array<Promise<boolean>>,
): Promise<PromiseSettledResult<boolean>[]> {
  // Slow responses are parked behind the gate; release them in a few rounds
  // so nested awaits (detail fan-out after a list) also drain.
  let settled: PromiseSettledResult<boolean>[] | null = null;
  const race = Promise.allSettled(promises).then(result => {
    settled = result;
  });
  for (let round = 0; round < 64 && settled === null; round++) {
    release(session);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await Promise.resolve();
  }
  await race;
  return settled ?? [];
}

// ─── Invariants ──────────────────────────────────────────────────────────────

const LOAD_STATUSES = new Set([
  'idle',
  'loading',
  'ready',
  'error',
  'unconfigured',
]);

type Broken = Extract<Outcome, { kind: 'BROKEN' }>;

function stateInvariant(
  state: TrainingStoreState,
  configured: boolean,
  inFlight: boolean,
): Broken | null {
  const broken = (invariant: string, detail: string): Broken => ({
    kind: 'BROKEN',
    invariant,
    detail,
  });
  if (
    !LOAD_STATUSES.has(state.savedStatus) ||
    !LOAD_STATUSES.has(state.planStatus)
  ) {
    return broken('status-enum', `${state.savedStatus}/${state.planStatus}`);
  }
  if (!inFlight && state.mutation !== 'idle') {
    return broken('mutation-stuck', state.mutation.slice(0, 60));
  }
  if (
    !inFlight &&
    (state.savedStatus === 'loading' || state.planStatus === 'loading')
  ) {
    return broken('loading-stuck', `${state.savedStatus}/${state.planStatus}`);
  }
  for (const [name, error] of [
    ['savedError', state.savedError],
    ['planError', state.planError],
    ['mutationError', state.mutationError],
  ] as const) {
    if (error !== null && !validErrorState(error)) {
      return broken('error-state-shape', name);
    }
  }
  if (state.savedStatus === 'error' && state.savedError === null) {
    return broken('error-without-detail', 'savedStatus=error, savedError=null');
  }
  if (state.planStatus === 'error' && state.planError === null) {
    return broken('error-without-detail', 'planStatus=error, planError=null');
  }
  if (
    configured &&
    (state.savedStatus === 'unconfigured' ||
      state.planStatus === 'unconfigured')
  ) {
    return broken(
      'unconfigured-while-configured',
      `${state.savedStatus}/${state.planStatus} code=${state.savedError?.code ?? state.planError?.code ?? '?'}`,
    );
  }
  if (state.savedDrills.some(drill => !validSavedDrill(drill))) {
    return broken('saved-drills-shape', `${state.savedDrills.length} entries`);
  }
  if (state.currentPlan !== null && !validPlan(state.currentPlan)) {
    return broken('plan-shape', 'currentPlan');
  }
  for (const key of Object.keys(state.drillDetails)) {
    if (!validDrillDetail(state.drillDetails[key])) {
      return broken(
        'drill-details-invalid-entry',
        `${JSON.stringify(key)} ⇒ ${describeValue(state.drillDetails[key])}`,
      );
    }
  }
  const lookups = [
    ...state.savedDrills.map(d => d.slug),
    ...(state.currentPlan?.items.flatMap(i =>
      i.drill ? [i.drill.slug] : [],
    ) ?? []),
  ];
  for (const slug of lookups) {
    const detail = state.drillDetails[slug];
    if (detail !== undefined && !validDrillDetail(detail)) {
      return broken(
        'drill-details-inherited-lookup',
        `${JSON.stringify(slug)} ⇒ ${describeValue(detail)}`,
      );
    }
  }
  return null;
}

function describeValue(value: unknown): string {
  if (typeof value === 'function') return `function ${value.name}`;
  try {
    return JSON.stringify(value)?.slice(0, 400) ?? String(value);
  } catch {
    return String(value);
  }
}

/** `__proto__` reads Object.prototype through the same plain-object lookup. */
const INHERITED = new Set<string>([...INHERITED_SLUGS, '__proto__']);

/** Tags a coherence failure as a pinned finding; `detail` is the raw slug JSON. */
function knownTag(outcome: Outcome): string | undefined {
  if (outcome.kind !== 'BROKEN') return undefined;
  if (
    outcome.invariant === 'drill-details-inherited-lookup' ||
    outcome.invariant === 'drill-details-invalid-entry'
  ) {
    try {
      const slug = JSON.parse(outcome.detail.split(' ⇒ ')[0] ?? '') as unknown;
      return typeof slug === 'string' && INHERITED.has(slug)
        ? 'F-PROTO-LOOKUP'
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (outcome.invariant === 'unconfigured-while-configured')
    return 'F-SERVER-CODE';
  return undefined;
}

// ─── One seeded session ──────────────────────────────────────────────────────

async function runSession(seed: number, index: number): Promise<TableRow> {
  const rng = new Rng(seed);
  const session: Session = {
    rng,
    configured: false,
    server: null,
    pending: [],
  };
  const trace: string[] = [];
  let outcome: Outcome = { kind: 'accepted' };
  let known: string | undefined;
  let knownOutcome: Outcome | null = null;
  let writes = 0;

  clearTrainingStoreConfiguration();
  if (rng.bool(0.85)) configure(session);
  const steps = rng.int(4, 12);

  const store = () => useTrainingStore.getState();
  const callsBefore = () => session.server?.calls.length ?? 0;
  const writesSince = (from: number) =>
    (session.server?.calls.slice(from) ?? []).filter(isWrite).length;

  for (let step = 0; step < steps; step++) {
    const op = rng.pick(OPS);
    const from = callsBefore();
    const mutationBusy = store().mutation !== 'idle';
    let promises: Array<Promise<boolean>> = [];
    let maxWrites = 0;
    let staleCheck: (() => Outcome | null) | null = null;
    let label: string = op;
    switch (op) {
      case 'loadSavedDrills':
        promises = [store().loadSavedDrills()];
        break;
      case 'loadCurrentPlan':
        promises = [store().loadCurrentPlan()];
        break;
      case 'createPlan':
        promises = [
          store().createPlan(
            rng.bool(0.7) ? FIX.uuid.shot : hostileString(rng),
          ),
        ];
        maxWrites = 1;
        break;
      case 'reassessCurrentPlan':
        promises = [
          store().reassessCurrentPlan(
            rng.bool(0.7) ? FIX.uuid.shot : hostileString(rng),
          ),
        ];
        maxWrites = 1;
        break;
      case 'setDrillSaved': {
        const slug = slugFor(rng);
        const saved = rng.bool();
        label = `setDrillSaved(${JSON.stringify(slug).slice(0, 24)},${saved})`;
        promises = [store().setDrillSaved(slug, saved)];
        maxWrites = 1;
        break;
      }
      case 'completePlanItem': {
        const fromPlan = store().currentPlan?.items.find(
          i => i.drill && !i.completion,
        );
        const item = fromPlan && rng.bool(0.6) ? fromPlan : syntheticItem(rng);
        label = `completePlanItem(${item.kind},sets=${String(item.targetSets)})`;
        promises = [store().completePlanItem(item)];
        maxWrites = 1;
        break;
      }
      case 'concurrent-mutations': {
        const slug = slugFor(rng);
        promises = [
          store().setDrillSaved(slug, true),
          store().createPlan(FIX.uuid.shot),
          store().setDrillSaved(slug, false),
          store().completePlanItem(syntheticItem(rng)),
        ];
        // The mutation guard admits exactly one of these.
        maxWrites = 1;
        break;
      }
      case 'reconfigure-mid-flight':
      case 'clear-mid-flight': {
        const flight = rng.pick([
          () => store().loadSavedDrills(),
          () => store().loadCurrentPlan(),
          () => store().setDrillSaved(slugFor(rng), true),
          () => store().createPlan(FIX.uuid.shot),
        ]);
        promises = [flight()];
        const staleWritesFrom = callsBefore();
        if (op === 'reconfigure-mid-flight') configure(session);
        else {
          clearTrainingStoreConfiguration();
          session.configured = false;
        }
        const snapshot = JSON.stringify(dataOf(store()));
        maxWrites = 1;
        staleCheck = () => {
          const after = JSON.stringify(dataOf(store()));
          if (after !== snapshot) {
            return {
              kind: 'BROKEN',
              invariant: 'stale-response-landed',
              detail: op,
            };
          }
          if (writesSince(staleWritesFrom) > 1) {
            return { kind: 'BROKEN', invariant: 'stale-write', detail: op };
          }
          return null;
        };
        break;
      }
      case 'clearConfiguration':
        clearTrainingStoreConfiguration();
        session.configured = false;
        break;
      case 'reset':
        store().reset();
        break;
      case 'clearMutationError':
        store().clearMutationError();
        break;
    }
    trace.push(label);

    const settled = await settleAll(session, promises);
    const rejected = settled.find(r => r.status === 'rejected');
    if (rejected && rejected.status === 'rejected') {
      outcome = {
        kind: 'BROKEN',
        invariant: 'store-throw',
        detail: `${label}: ${describeError(rejected.reason)}`,
      };
      break;
    }
    for (const r of settled) {
      if (r.status === 'fulfilled' && typeof r.value !== 'boolean') {
        outcome = {
          kind: 'BROKEN',
          invariant: 'store-non-boolean',
          detail: label,
        };
      }
    }
    if (outcome.kind === 'BROKEN') break;
    const pollution = globalPollution();
    if (pollution) {
      outcome = {
        kind: 'BROKEN',
        invariant: 'global-prototype-polluted',
        detail: pollution,
      };
      break;
    }
    const w = writesSince(from);
    writes += w;
    if (w > maxWrites) {
      outcome = {
        kind: 'BROKEN',
        invariant: 'write-count',
        detail: `${label}: ${w} writes (max ${maxWrites})`,
      };
      break;
    }
    if (mutationBusy && maxWrites > 0 && w > 0) {
      outcome = {
        kind: 'BROKEN',
        invariant: 'write-while-busy',
        detail: label,
      };
      break;
    }
    const stale = staleCheck?.();
    if (stale) {
      outcome = stale;
      break;
    }
    const coherent = stateInvariant(store(), session.configured, false);
    if (coherent) {
      const tag = knownTag(coherent);
      if (tag === undefined) {
        outcome = { ...coherent, detail: `${label}: ${coherent.detail}` };
        break;
      }
      // Pinned finding: record the first hit and keep driving the session so
      // the remaining invariants still get exercised on this seed.
      if (known === undefined) {
        known = tag;
        knownOutcome = { ...coherent, detail: `${label}: ${coherent.detail}` };
      }
    }
  }
  if (outcome.kind !== 'BROKEN' && knownOutcome) outcome = knownOutcome;
  release(session);
  clearTrainingStoreConfiguration();
  return {
    campaign: 'store-sequence',
    seed,
    index,
    scenario: `${session.server ? 'configured' : 'unconfigured'} · ${writes === 0 ? 'no writes' : 'writes'}`,
    mutations: trace.join(' → '),
    outcome,
    known,
  };
}

function dataOf(state: TrainingStoreState) {
  return {
    savedStatus: state.savedStatus,
    planStatus: state.planStatus,
    mutation: state.mutation,
    savedDrills: state.savedDrills,
    drillDetails: state.drillDetails,
    currentPlan: state.currentPlan,
    savedError: state.savedError,
    planError: state.planError,
    mutationError: state.mutationError,
  };
}

jest.setTimeout(600_000);

describe('mod-training boundary/malformed · store', () => {
  afterEach(() => {
    clearTrainingStoreConfiguration();
    expect(globalPollution()).toBeNull();
  });

  test('campaign store-sequence: hostile transport never escapes the store as a throw, bad write or incoherent state', async () => {
    const name = 'store-sequence';
    const only = onlySeed(name);
    const total = only === null ? iterations(300) : 1;
    const rows: TableRow[] = [];
    for (let index = 0; index < total; index++) {
      rows.push(await runSession(only ?? seedFor(name, index), index));
    }
    const unexpected = rows.filter(
      r => r.outcome.kind === 'BROKEN' && !r.known,
    );
    const { path } = writeTable(name, rows, {
      replay: `STRESS_ONLY=${name}:<seed> npx jest modTrainingBoundaryStore`,
      unexpectedSeeds: unexpected.map(r => r.seed),
      knownSeeds: rows
        .filter(r => r.known)
        .map(r => ({ seed: r.seed, tag: r.known })),
      opsExecuted: rows.reduce(
        (n, r) => n + String(r.mutations).split(' → ').length,
        0,
      ),
    });
    expect(rows.length).toBeGreaterThan(0);
    expect({ path, unexpected: unexpected.slice(0, 10) }).toEqual({
      path,
      unexpected: [],
    });
  });

  // ── Minimised reproductions of BROKEN rows (flip to `test` once fixed) ────

  test.failing(
    'F-PROTO-LOOKUP: a saved drill whose slug is an Object.prototype member ("constructor") must not resolve to an inherited function in drillDetails',
    async () => {
      const { fetchFn } = recordingFetch(recorded =>
        recorded.url.endsWith('/v1/me/saved-drills')
          ? fakeResponse(200, {
              json: { items: [savedDrillWire('constructor')] },
            })
          : fakeResponse(404, {
              json: { error: { code: 'not_found', message: 'x' } },
            }),
      );
      configureTrainingStore(createTrainingApi(apiConfig(fetchFn)));
      await expect(useTrainingStore.getState().loadSavedDrills()).resolves.toBe(
        true,
      );
      // store.ts:26 `drillDetails: Record<string, DrillDetail>` is a plain
      // object; a held (404) detail leaves the key absent, so the screen's
      // `drillDetails[drill.slug]` (LibraryScreen) inherits Object's
      // `constructor` and SavedDrillCard reads `.mappings.length` off a
      // function. Server regex ^[a-z0-9][a-z0-9_-]{0,119}$ admits this slug.
      const detail = useTrainingStore.getState().drillDetails['constructor'];
      expect(detail === undefined || validDrillDetail(detail)).toBe(true);
    },
  );

  test.failing(
    'F-PROTO-LOOKUP: toggling saved on an inherited-name slug must not persist a non-DrillDetail entry',
    async () => {
      const { fetchFn } = recordingFetch(recorded =>
        recorded.method === 'PUT'
          ? fakeResponse(200, { json: { slug: 'hasOwnProperty', saved: true } })
          : fakeResponse(200, { json: { items: [] } }),
      );
      configureTrainingStore(createTrainingApi(apiConfig(fetchFn)));
      await expect(
        useTrainingStore.getState().setDrillSaved('hasOwnProperty', true),
      ).resolves.toBe(true);
      // store.ts:295-300 `state.drillDetails[slug] ? {...}` is truthy for the
      // inherited method, so `{ ...Function, saved }` = `{ saved: true }` is
      // written as an own entry.
      const entries = Object.values(useTrainingStore.getState().drillDetails);
      expect(entries.every(validDrillDetail)).toBe(true);
    },
  );

  test.failing(
    'F-SERVER-CODE: a 4xx body carrying code "training.unconfigured" must not flip a configured store into the sign-in state',
    async () => {
      const { fetchFn } = recordingFetch(() =>
        fakeResponse(400, {
          json: {
            error: { code: 'training.unconfigured', message: 'spoofed' },
          },
        }),
      );
      configureTrainingStore(createTrainingApi(apiConfig(fetchFn)));
      await expect(useTrainingStore.getState().loadSavedDrills()).resolves.toBe(
        false,
      );
      // api.ts:461-463 adopts the server `error.code`; store.ts:69-71 maps
      // that exact string to status 'unconfigured', which LibraryScreen
      // renders as "connect a synced account" although the account is synced.
      expect(useTrainingStore.getState().savedStatus).toBe('error');
    },
  );

  test('F-FANOUT (observation): loading N saved drills issues N concurrent catalog detail requests with no cap', async () => {
    const n = 500;
    let inFlight = 0;
    let peak = 0;
    const { fetchFn, calls } = recordingFetch(async recorded => {
      if (recorded.url.endsWith('/v1/me/saved-drills')) {
        return fakeResponse(200, {
          json: {
            items: Array.from({ length: n }, (_, i) =>
              savedDrillWire(`drill-${i}`),
            ),
          },
        });
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      inFlight -= 1;
      return fakeResponse(429, {
        json: { error: { code: 'rate_limited', message: 'slow down' } },
      });
    });
    configureTrainingStore(createTrainingApi(apiConfig(fetchFn)));
    await expect(useTrainingStore.getState().loadSavedDrills()).resolves.toBe(
      true,
    );
    const detailCalls = calls.filter(c =>
      c.url.includes('/v1/catalog/drills/'),
    );
    // Recorded as evidence for the finding; the store holds (does not throw)
    // and every detail is simply absent. store.ts:81-96 has no concurrency
    // limit; GENERAL_USER_LIMIT on the edge fn is 240 req / 60 s.
    expect(detailCalls).toHaveLength(n);
    expect(peak).toBe(n);
    expect(Object.keys(useTrainingStore.getState().drillDetails)).toHaveLength(
      0,
    );
    expect(useTrainingStore.getState().savedDrills).toHaveLength(n);
  });

  test('control: an "__proto__" catalog slug is dropped from drillDetails without polluting the prototype', async () => {
    const { fetchFn } = recordingFetch(recorded =>
      recorded.url.endsWith('/v1/me/saved-drills')
        ? fakeResponse(200, { json: { items: [savedDrillWire('__proto__')] } })
        : fakeResponse(200, { json: drillDetailWire('__proto__') }),
    );
    configureTrainingStore(createTrainingApi(apiConfig(fetchFn)));
    await expect(useTrainingStore.getState().loadSavedDrills()).resolves.toBe(
      true,
    );
    const state = useTrainingStore.getState();
    expect(Object.keys(state.drillDetails)).toEqual([]);
    expect(Object.getPrototypeOf(state.drillDetails)).toBe(Object.prototype);
    expect(globalPollution()).toBeNull();
  });
});
