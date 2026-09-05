/**
 * STRESS / failure-injection — `useAppStore.hydrate()` (state/appStore.ts).
 *
 * Every dependency the store calls is a seam here: getDb (open), the kv
 * table (real repository.getKv/setKv against FaultKv), getApiSession, the
 * canonical onboarding module (fetch/save, mocked at module level — the
 * transport-level faults live in appStoreOnboardingTransportFaults), the
 * active-owner clock (account switch mid-flight, with the Gate's concurrent
 * re-hydrate) and wall-clock time (jest modern fake timers, 60s budget).
 *
 * Each seed derives one scenario (owner, session, stored profile kind,
 * pending-stash kind, 0-3 faults from the seam table, optional owner switch)
 * and is judged against the contract below. Violations that reproduce on the
 * audited commit are pinned in KNOWN_ISSUES (each names its finding); the
 * suite fails on any NEW violation and on any pin that stops reproducing.
 *
 * Contract:
 *  - hydrate() never rejects (the Gate calls `void hydrateApp()`)
 *  - settles within 60s of fake time unless a dependency literally never
 *    settles (then: no watchdog → the spinner is infinite → KI-1)
 *  - after settling for the CURRENT owner: hydrated, ownerKey === owner, and
 *    exactly one of {valid profile, hydrateError (product copy), legitimate
 *    "needs onboarding"}; a profile in state must equal the persisted one
 *  - no silent failure: a dependency fault that prevented a profile from
 *    loading must surface as hydrateError (retry control), never as the
 *    questionnaire
 *  - persisted kv is never corrupted; the stash is single-use and survives a
 *    failed adoption; no cross-owner writes
 *
 * Artefacts (git-ignored): artifacts/stress/mod-app-store/<STRESS_RUN_ID>/
 *   hydrate.rows.json     one replayable row per seed
 *   hydrate.summary.json  counts per violation / pin / fault seam
 * Replay one seed: STRESS_SEED=<n> npx jest --ci __tests__/stress/appStoreHydrate
 * Campaign size:   STRESS_ITER=<n> (default 400)
 */
import {
  CANONICAL_A,
  CANONICAL_B,
  FaultKv,
  OK,
  campaignConfig,
  isValidProfile,
  makeProfile,
  makeRng,
  parseProfileJson,
  writeArtifact,
  type Fault,
  type FaultMode,
  type Rng,
  type Settlement,
} from '../../__harness__/appStoreFailureInjection/harness';
import type { ApiSession } from '../../src/account/apiSession';
import type { Profile } from '../../src/state/profile';

// ── seams ──────────────────────────────────────────────────────────────────

const mockDbSeam: { open: () => FaultKv } = {
  open: () => {
    throw new Error('db seam not configured');
  },
};
const mockSessionSeam: { read: () => ApiSession | null } = { read: () => null };
interface ApiCall {
  seq: number;
  op: 'fetch' | 'save';
  owner: string;
  mode: string;
}
const mockApiSeam: {
  fetch: (session: ApiSession) => Promise<Profile | null>;
  save: (session: ApiSession, profile: Profile) => Promise<Profile>;
} = {
  fetch: async () => null,
  save: async (_s, p) => p,
};

jest.mock('../../src/data/db', () => ({
  getDb: () => mockDbSeam.open(),
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockSessionSeam.read(),
}));
jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: (session: ApiSession) =>
    mockApiSeam.fetch(session),
  saveCanonicalOnboardingProfile: (session: ApiSession, profile: Profile) =>
    mockApiSeam.save(session, profile),
}));

import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
  getActiveDataOwner,
  profileKeyForOwner,
} from '../../src/data/accountScope';
import {
  CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';

const FALLBACK_HYDRATE_COPY = 'Your coaching profile could not be loaded.';
const PRODUCT_COPY = new Set([
  CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
  FALLBACK_HYDRATE_COPY,
]);

// ── scenario model ─────────────────────────────────────────────────────────

type OwnerKind = 'signed-out' | 'guest' | 'canonical-a' | 'canonical-b';
type SessionKind = 'none' | 'a' | 'b' | 'malformed-id';
type PendingKind =
  | 'none'
  | 'valid'
  | 'corrupt-json'
  | 'wrong-version'
  | 'missing-profile'
  | 'profile-not-object'
  | 'profile-missing-field'
  | 'empty-string';
type StoredKind =
  | 'none'
  | 'valid'
  | 'corrupt-json'
  | 'json-array'
  | 'json-string'
  | 'json-number'
  | 'json-null'
  | 'empty-object'
  | 'legacy-only';

type Seam =
  | 'db.open'
  | 'kv.get.pending'
  | 'kv.get.profile'
  | 'kv.get.legacy'
  | 'kv.set.profile'
  | 'kv.set.legacyClear'
  | 'kv.set.pendingClear'
  | 'session.read'
  | 'api.fetch'
  | 'api.save';

const SEAMS: readonly Seam[] = [
  'db.open',
  'kv.get.pending',
  'kv.get.profile',
  'kv.get.legacy',
  'kv.set.profile',
  'kv.set.legacyClear',
  'kv.set.pendingClear',
  'session.read',
  'api.fetch',
  'api.save',
];

/** Modes that have a real-world analogue at each seam. */
const SEAM_MODES: Record<Seam, readonly FaultMode[]> = {
  'db.open': ['throw'],
  'kv.get.pending': ['throw', 'reject', 'slow', 'never', 'malformed'],
  'kv.get.profile': ['throw', 'reject', 'slow', 'never', 'malformed'],
  'kv.get.legacy': ['throw', 'reject', 'slow', 'never', 'malformed'],
  'kv.set.profile': ['throw', 'reject', 'slow', 'never'],
  'kv.set.legacyClear': ['throw', 'reject', 'slow', 'never'],
  'kv.set.pendingClear': ['throw', 'reject', 'slow', 'never'],
  'session.read': ['throw'],
  // The real module bounds its request with a 15s abort, so `never` at the
  // module seam has no analogue; transport-level hangs are exercised by
  // appStoreOnboardingTransportFaults.stress.test.ts against the real module.
  'api.fetch': ['throw', 'reject', 'slow'],
  'api.save': ['throw', 'reject', 'slow'],
};

interface Scenario {
  seed: number;
  owner: OwnerKind;
  session: SessionKind;
  stored: StoredKind;
  /** Profile kind pre-seeded for the OTHER canonical account (cross-owner). */
  otherStored: 'none' | 'valid';
  pending: PendingKind;
  serverHasProfile: boolean;
  faults: Partial<Record<Seam, Fault>>;
  switch: null | {
    afterDependencyCall: number;
    to: OwnerKind;
    /** Gate behaviour: the new owner's hydrate starts while the stale one is in flight. */
    concurrent: boolean;
  };
}

function ownerId(kind: OwnerKind): string {
  switch (kind) {
    case 'signed-out':
      return SIGNED_OUT_DATA_OWNER;
    case 'guest':
      return GUEST_DATA_OWNER;
    case 'canonical-a':
      return CANONICAL_A;
    case 'canonical-b':
      return CANONICAL_B;
  }
}

function sessionFor(kind: SessionKind): ApiSession | null {
  if (kind === 'none') return null;
  const id =
    kind === 'a' ? CANONICAL_A : kind === 'b' ? CANONICAL_B : 'not-a-uuid';
  return {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'stress-bearer',
    canonicalAppUserId: id,
    provider: 'apple',
  };
}

/** The session the Gate would hold once the active owner becomes `kind`. */
function sessionMatching(kind: OwnerKind): SessionKind {
  if (kind === 'canonical-a') return 'a';
  if (kind === 'canonical-b') return 'b';
  return 'none';
}

function makeFault(mode: FaultMode, rng: Rng): Fault {
  if (mode === 'slow') return { mode, slowMs: 250 + rng.int(12) * 500 };
  if (mode === 'malformed') {
    return {
      mode,
      malformedRows: rng.pick([
        'no-rows-field',
        'row-without-value',
        'numeric-0',
        'object-value',
      ] as const),
    };
  }
  return { mode };
}

/** Stash payloads parsePendingProfile() accepts (it does not check `version`). */
function isAdoptableStash(kind: PendingKind): boolean {
  return kind === 'valid' || kind === 'wrong-version';
}

function reachableSeams(
  owner: OwnerKind,
  session: SessionKind,
  stored: StoredKind,
  pending: PendingKind,
  serverHasProfile: boolean,
): Seam[] {
  const canonicalMatch =
    (owner === 'canonical-a' && session === 'a') ||
    (owner === 'canonical-b' && session === 'b');
  const noLocal = stored === 'none' || stored === 'legacy-only';
  const adopts = isAdoptableStash(pending) && owner !== 'signed-out';
  const seams: Seam[] = [
    'db.open',
    'kv.get.pending',
    'kv.get.profile',
    'session.read',
  ];
  if (owner === 'guest' && noLocal) seams.push('kv.get.legacy');
  if (owner === 'guest' && stored === 'legacy-only')
    seams.push('kv.set.legacyClear');
  const fetches = canonicalMatch && noLocal;
  if (fetches) seams.push('api.fetch');
  if (stored === 'legacy-only' || (fetches && serverHasProfile) || adopts) {
    seams.push('kv.set.profile');
  }
  if (adopts) seams.push('kv.set.pendingClear');
  if (adopts && canonicalMatch) seams.push('api.save');
  return seams;
}

function deriveScenario(seed: number): Scenario {
  const rng = makeRng(seed);
  const owner = rng.weighted<OwnerKind>([
    ['signed-out', 1],
    ['guest', 3],
    ['canonical-a', 5],
    ['canonical-b', 1],
  ]);
  const session = rng.weighted<SessionKind>([
    [sessionMatching(owner), 6],
    ['none', 1],
    ['a', 1],
    ['b', 1],
    ['malformed-id', 1],
  ]);
  const stored = rng.weighted<StoredKind>([
    ['none', 8],
    ['valid', 5],
    ['corrupt-json', 1],
    ['json-array', 1],
    ['json-string', 1],
    ['json-number', 1],
    ['json-null', 1],
    ['empty-object', 1],
    ['legacy-only', owner === 'guest' ? 2 : 0],
  ]);
  const pending = rng.weighted<PendingKind>([
    ['none', 4],
    ['valid', 8],
    ['corrupt-json', 1],
    ['wrong-version', 1],
    ['missing-profile', 1],
    ['profile-not-object', 1],
    ['profile-missing-field', 1],
    ['empty-string', 1],
  ]);
  const serverHasProfile = rng.chance(0.5);
  const faultCount = rng.weighted([
    [0, 1],
    [1, 5],
    [2, 3],
    [3, 1],
  ]);
  const faults: Partial<Record<Seam, Fault>> = {};
  // Inject where the scenario will actually call (unreachable seams would
  // only inflate the count); every tenth seed samples the full table.
  const pool =
    seed % 10 === 0
      ? [...SEAMS]
      : reachableSeams(owner, session, stored, pending, serverHasProfile);
  for (let i = 0; i < faultCount && pool.length > 0; i += 1) {
    const seam = pool.splice(rng.int(pool.length), 1)[0]!;
    faults[seam] = makeFault(rng.pick(SEAM_MODES[seam]), rng);
  }
  const doSwitch = rng.chance(0.3);
  const switchTarget = doSwitch
    ? rng.pick(
        (['signed-out', 'guest', 'canonical-a', 'canonical-b'] as const).filter(
          kind => kind !== owner,
        ),
      )
    : null;
  return {
    seed,
    owner,
    session,
    stored,
    otherStored: rng.chance(0.5) ? 'valid' : 'none',
    pending,
    serverHasProfile,
    faults,
    switch:
      doSwitch && switchTarget
        ? {
            afterDependencyCall: 1 + rng.int(6),
            to: switchTarget,
            concurrent: rng.chance(0.6),
          }
        : null,
  };
}

// ── fixtures per scenario ──────────────────────────────────────────────────

interface Fixtures {
  stashProfile: Profile;
  storedProfile: Profile;
  otherProfile: Profile;
  serverProfile: Profile;
  /** What the canonical save endpoint hands back (server focus wins). */
  savedFromStash: Profile;
}

function makeFixtures(seed: number): Fixtures {
  const rng = makeRng(seed ^ 0x5eed);
  const stashProfile = makeProfile(`stash-${seed}`, rng);
  return {
    stashProfile,
    storedProfile: makeProfile(`stored-${seed}`, rng),
    otherProfile: makeProfile(`other-${seed}`, rng),
    serverProfile: makeProfile(`server-${seed}`, rng),
    savedFromStash: { ...stashProfile, focusCheckpoint: 'recovery' },
  };
}

function storedValue(kind: StoredKind, profile: Profile): string | undefined {
  switch (kind) {
    case 'none':
    case 'legacy-only':
      return undefined;
    case 'valid':
      return JSON.stringify(profile);
    case 'corrupt-json':
      return '{"skillLevel":"3.5",';
    case 'json-array':
      return '[]';
    case 'json-string':
      return '"3.5"';
    case 'json-number':
      return '42';
    case 'json-null':
      return 'null';
    case 'empty-object':
      return '{}';
  }
}

function pendingValue(kind: PendingKind, profile: Profile): string | undefined {
  switch (kind) {
    case 'none':
      return undefined;
    case 'valid':
      return JSON.stringify({ version: 1, profile });
    case 'corrupt-json':
      return '{"version":1,"profile":';
    case 'wrong-version':
      return JSON.stringify({ version: 2, profile });
    case 'missing-profile':
      return JSON.stringify({ version: 1 });
    case 'profile-not-object':
      return JSON.stringify({ version: 1, profile: 'yes' });
    case 'profile-missing-field': {
      const { goal: _goal, ...rest } = profile;
      return JSON.stringify({ version: 1, profile: rest });
    }
    case 'empty-string':
      return '';
  }
}

// ── one iteration ──────────────────────────────────────────────────────────

interface HydrateRun {
  owner: string;
  settlement: Settlement;
  fakeMs: number;
  error?: string;
}

interface Row {
  seed: number;
  scenario: Scenario;
  runs: HydrateRun[];
  kvCalls: Array<{
    seq: number;
    op: string;
    key: string;
    mode: string;
    value?: string;
  }>;
  apiCalls: ApiCall[];
  /** Faults that actually fired, excluding `slow` (a delay is not a failure). */
  faultsHit: string[];
  /** Subset of faultsHit that fired while `finalOwner` was the active owner. */
  faultsHitFinal: string[];
  slowHit: string[];
  neverHit: boolean;
  kvBefore: Record<string, string>;
  kvAfter: Record<string, string>;
  state: {
    hydrated: boolean;
    ownerKey: string | null;
    profile: unknown;
    hydrateError: string | null;
    onboardingBusy: boolean;
  };
  finalOwner: string;
  violations: string[];
  pins: string[];
}

function resetStore(): void {
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
}

interface Tracked {
  promise: Promise<void>;
  run: HydrateRun;
  done: boolean;
  observed: boolean;
}

async function settleAll(
  tracked: Tracked[],
  budgetMs: number,
  stepMs: number,
): Promise<void> {
  const pending = new Set(tracked.filter(item => !item.done));
  for (const item of pending) {
    if (item.observed) continue;
    item.observed = true;
    item.promise.then(
      () => {
        item.run.settlement = 'resolved';
        item.done = true;
        pending.delete(item);
      },
      (reason: unknown) => {
        item.run.settlement = 'rejected';
        item.run.error =
          reason instanceof Error ? reason.message : String(reason);
        item.done = true;
        pending.delete(item);
      },
    );
  }
  let elapsed = 0;
  for (let i = 0; i < 20 && pending.size > 0; i += 1) await Promise.resolve();
  while (pending.size > 0 && elapsed < budgetMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    elapsed += stepMs;
    for (const item of pending) item.run.fakeMs = elapsed;
  }
  for (const item of pending) {
    item.run.settlement = 'hung';
    item.done = true;
  }
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const fx = makeFixtures(scenario.seed);
  const owner = ownerId(scenario.owner);
  const profileKey = profileKeyForOwner(owner);

  // ── kv preload
  const seedKv: Record<string, string> = {};
  const stored = storedValue(scenario.stored, fx.storedProfile);
  if (stored !== undefined) seedKv[profileKey] = stored;
  if (scenario.stored === 'legacy-only') {
    seedKv['profile'] = JSON.stringify(fx.storedProfile);
  }
  const pendingRaw = pendingValue(scenario.pending, fx.stashProfile);
  if (pendingRaw !== undefined)
    seedKv[PENDING_ONBOARDING_PROFILE_KV_KEY] = pendingRaw;
  const otherOwner =
    scenario.owner === 'canonical-a' ? CANONICAL_B : CANONICAL_A;
  if (scenario.otherStored === 'valid') {
    seedKv[profileKeyForOwner(otherOwner)] = JSON.stringify(fx.otherProfile);
  }
  const kv = new FaultKv(seedKv);
  const kvBefore = kv.snapshot();

  // ── faults
  const faultsHit = new Set<string>();
  const faultsHitByOwner = new Map<string, Set<string>>();
  const slowHit = new Set<string>();
  const recordHit = (id: string, mode: FaultMode) => {
    if (mode === 'ok') return;
    if (mode === 'slow') {
      slowHit.add(id);
      return;
    }
    const hit = `${id}:${mode}`;
    faultsHit.add(hit);
    const active = getActiveDataOwner();
    if (!faultsHitByOwner.has(active)) faultsHitByOwner.set(active, new Set());
    faultsHitByOwner.get(active)!.add(hit);
  };
  const f = scenario.faults;
  const kvFault = (seam: Seam, op: 'get' | 'set', key: string) => {
    const fault = f[seam];
    if (fault) kv.fault(op, key, fault);
  };
  kvFault('kv.get.pending', 'get', PENDING_ONBOARDING_PROFILE_KV_KEY);
  kvFault('kv.get.profile', 'get', profileKey);
  kvFault('kv.get.legacy', 'get', 'profile');
  kvFault('kv.set.profile', 'set', profileKey);
  kvFault('kv.set.legacyClear', 'set', 'profile');
  kvFault('kv.set.pendingClear', 'set', PENDING_ONBOARDING_PROFILE_KV_KEY);

  let dependencyCalls = 0;
  const apiCalls: ApiCall[] = [];
  const tracked: Tracked[] = [];
  let switched = false;

  const startHydrate = () => {
    const run: HydrateRun = {
      owner: getActiveDataOwner(),
      settlement: 'hung',
      fakeMs: 0,
    };
    tracked.push({
      promise: useAppStore.getState().hydrate(),
      run,
      done: false,
      observed: false,
    });
  };

  const onDependencyCall = () => {
    dependencyCalls += 1;
    if (
      scenario.switch &&
      !switched &&
      dependencyCalls === scenario.switch.afterDependencyCall
    ) {
      switched = true;
      const to = scenario.switch.to;
      setActiveDataOwner(ownerId(to));
      mockSessionSeam.read = () => sessionFor(sessionMatching(to));
      if (scenario.switch.concurrent) startHydrate();
    }
  };

  kv.onCall = call => {
    recordHit(`${call.op}:${call.key}`, call.mode);
    onDependencyCall();
  };

  mockDbSeam.open = () => {
    if (f['db.open']?.mode === 'throw') {
      recordHit('db.open', 'throw');
      throw new Error('[op-sqlite] unable to open database file');
    }
    return kv;
  };
  mockSessionSeam.read = () => {
    if (f['session.read']?.mode === 'throw') {
      recordHit('session.read', 'throw');
      throw new Error('api session store unavailable');
    }
    return sessionFor(scenario.session);
  };

  const apiBehaviour = <T>(
    seam: 'api.fetch' | 'api.save',
    session: ApiSession,
    value: () => T,
  ): Promise<T> => {
    const fault = f[seam] ?? OK;
    apiCalls.push({
      seq: dependencyCalls + 1,
      op: seam === 'api.fetch' ? 'fetch' : 'save',
      owner: session.canonicalAppUserId,
      mode: fault.mode,
    });
    onDependencyCall();
    recordHit(seam, fault.mode);
    switch (fault.mode) {
      case 'throw':
        throw new TypeError('Cannot read properties of undefined');
      case 'reject':
        return Promise.reject(
          new Error(
            'Your coaching profile could not be securely saved. Check your connection and try again.',
          ),
        );
      case 'slow':
        return new Promise(resolve =>
          setTimeout(() => resolve(value()), fault.slowMs ?? 1_000),
        );
      default:
        return Promise.resolve(value());
    }
  };
  mockApiSeam.fetch = session =>
    apiBehaviour('api.fetch', session, () =>
      scenario.serverHasProfile ? fx.serverProfile : null,
    );
  mockApiSeam.save = (session, profile) =>
    apiBehaviour('api.save', session, () => ({
      ...profile,
      focusCheckpoint: 'recovery' as const,
    }));

  // ── run
  resetStore();
  setActiveDataOwner(owner);
  startHydrate();
  await settleAll(tracked, 60_000, 500);
  if (scenario.switch && !switched) {
    // The switch point was never reached (early return / hang before it);
    // still perform the switch the way the Gate would after the fact.
    switched = true;
    setActiveDataOwner(ownerId(scenario.switch.to));
    mockSessionSeam.read = () =>
      sessionFor(sessionMatching(scenario.switch!.to));
  }
  if (scenario.switch && tracked.length === 1) startHydrate();
  // A concurrent re-hydrate started mid-flight gets its own 60s budget.
  while (tracked.some(item => !item.done)) {
    await settleAll(tracked, 60_000, 500);
  }
  // Drain any timers left by slow seams so kv reflects every write that
  // was going to land.
  await jest.advanceTimersByTimeAsync(60_000);

  const finalOwner = getActiveDataOwner();
  const s = useAppStore.getState();
  const row: Row = {
    seed: scenario.seed,
    scenario,
    runs: tracked.map(t => t.run),
    kvCalls: kv.calls.map(c => ({
      seq: c.seq,
      op: c.op,
      key: c.key,
      mode: c.mode,
      ...(c.value !== undefined ? { value: c.value } : {}),
    })),
    apiCalls,
    faultsHit: [...faultsHit].sort(),
    faultsHitFinal: [...(faultsHitByOwner.get(finalOwner) ?? [])].sort(),
    slowHit: [...slowHit].sort(),
    neverHit: [...faultsHit].some(hit => hit.endsWith(':never')),
    kvBefore,
    kvAfter: kv.snapshot(),
    state: {
      hydrated: s.hydrated,
      ownerKey: s.ownerKey,
      profile: s.profile,
      hydrateError: s.hydrateError,
      onboardingBusy: s.onboardingBusy,
    },
    finalOwner,
    violations: [],
    pins: [],
  };
  row.violations = judge(row, fx);
  return row;
}

// ── oracle ─────────────────────────────────────────────────────────────────

function judge(row: Row, fx: Fixtures): string[] {
  const v = new Set<string>();
  const { scenario, state, kvAfter, kvBefore, finalOwner } = row;
  // A concurrent re-hydrate is pushed before its parent (it starts inside
  // the parent's first dependency call), so locate the final owner's run by
  // owner rather than by position.
  const finalRun = [...row.runs]
    .reverse()
    .find(run => run.owner === finalOwner)!;
  const stashJson = JSON.stringify(fx.stashProfile);
  const pendingBefore = kvBefore[PENDING_ONBOARDING_PROFILE_KV_KEY];
  const pendingAfter = kvAfter[PENDING_ONBOARDING_PROFILE_KV_KEY];
  const stashWasValid = isAdoptableStash(scenario.pending);

  for (const run of row.runs) {
    if (run.settlement === 'rejected') v.add('hydrate_rejected');
    if (run.settlement === 'hung') {
      v.add(row.neverHit ? 'hung_on_never' : 'hung_without_never');
    }
  }

  // Persistence integrity — every profile:* value is either untouched or a
  // valid profile; the pending key is untouched, consumed ('') or valid.
  for (const [key, value] of Object.entries(kvAfter)) {
    if (key.startsWith('profile:') || key === 'profile') {
      if (value === kvBefore[key]) continue;
      if (key === 'profile') {
        if (value !== '') v.add('legacy_key_rewritten');
        continue;
      }
      const parsed = parseProfileJson(value);
      if (!isValidProfile(parsed)) v.add('corrupt_persisted_profile');
      const keyOwner = key.slice('profile:'.length);
      const active = new Set([ownerId(scenario.owner), finalOwner]);
      if (!active.has(keyOwner)) v.add('cross_owner_write');
    } else if (key === PENDING_ONBOARDING_PROFILE_KV_KEY) {
      if (value !== pendingBefore && value !== '') v.add('corrupt_pending');
    }
  }
  for (const key of Object.keys(kvBefore)) {
    if (!(key in kvAfter)) v.add('kv_key_deleted');
  }

  // Stash: single-use, and it survives a failed adoption.
  const adoptedLocally = new Set(
    Object.entries(kvAfter)
      .filter(([key, value]) => {
        if (!key.startsWith('profile:') || value === kvBefore[key])
          return false;
        const parsed = parseProfileJson(value) as Profile;
        return (
          isValidProfile(parsed) &&
          parsed.biggestProblem === fx.stashProfile.biggestProblem
        );
      })
      .map(([key]) => key.slice('profile:'.length)),
  );
  const adoptedRemotely = new Set(
    row.apiCalls
      .filter(c => c.op === 'save' && c.mode !== 'throw' && c.mode !== 'reject')
      .map(c => c.owner),
  );
  const adopters = new Set([...adoptedLocally, ...adoptedRemotely]);
  if (stashWasValid && adopters.size > 1) v.add('stash_adopted_twice');
  const adoptionAttempted =
    stashWasValid &&
    (row.apiCalls.some(c => c.op === 'save') ||
      row.kvCalls.some(
        c =>
          c.op === 'set' &&
          c.key.startsWith('profile:') &&
          c.value === stashJson,
      ));
  const adoptionFaultHitAny = row.faultsHit.some(
    hit =>
      hit.startsWith('api.save:') ||
      hit.startsWith(`set:${profileKeyForOwner(ownerId(scenario.owner))}:`) ||
      hit.startsWith(`set:${profileKeyForOwner(finalOwner)}:`) ||
      hit.startsWith(`set:${PENDING_ONBOARDING_PROFILE_KV_KEY}:`),
  );
  const adoptionFaultHit = row.faultsHitFinal.some(
    hit =>
      hit.startsWith('api.save:') ||
      hit.startsWith(`set:${profileKeyForOwner(finalOwner)}:`) ||
      hit.startsWith(`set:${PENDING_ONBOARDING_PROFILE_KV_KEY}:`),
  );
  const finalNever = row.faultsHitFinal.some(hit => hit.endsWith(':never'));
  if (stashWasValid && pendingAfter === '' && adopters.size === 0) {
    v.add('stash_consumed_without_adoption');
  }
  if (
    stashWasValid &&
    adoptionAttempted &&
    adoptionFaultHitAny &&
    adopters.size === 0 &&
    pendingAfter !== pendingBefore
  ) {
    v.add('stash_lost_on_failed_adoption');
  }

  if (finalRun.settlement !== 'resolved') return [...v].sort();

  // State for the CURRENT owner after its hydrate resolved.
  if (state.hydrated !== true) v.add('not_hydrated_after_resolve');
  if (state.ownerKey !== finalOwner) v.add('owner_mismatch');
  if (state.onboardingBusy) v.add('busy_stuck');
  if (state.profile !== null && state.hydrateError !== null) {
    v.add('error_and_profile');
  }
  if (state.hydrateError !== null && !PRODUCT_COPY.has(state.hydrateError)) {
    v.add('raw_error_copy');
  }
  const kvFinal = kvAfter[profileKeyForOwner(finalOwner)];
  const kvParsed = parseProfileJson(kvFinal);
  if (state.profile !== null) {
    if (!isValidProfile(state.profile)) v.add('invalid_profile_in_state');
    else if (
      isValidProfile(kvParsed) &&
      JSON.stringify(kvParsed) !== JSON.stringify(state.profile)
    ) {
      v.add('state_profile_differs_from_kv');
    } else if (kvFinal === undefined) {
      v.add('state_profile_not_persisted');
    }
  } else if (state.hydrateError === null) {
    // "Needs onboarding" — legitimate only if nothing loadable existed.
    if (isValidProfile(kvParsed)) {
      v.add('valid_kv_profile_not_loaded');
    } else if (kvFinal !== undefined && kvFinal !== 'null') {
      // Unparseable/garbage stored profile must surface as an error, not
      // as a fresh questionnaire (that would overwrite it silently).
      if (kvParsed === Symbol.for('unparseable')) {
        v.add('corrupt_kv_silently_reonboards');
      }
    }
    const finalWritable = finalOwner !== SIGNED_OUT_DATA_OWNER;
    const stashStillThere = pendingAfter === pendingBefore && stashWasValid;
    if (stashStillThere && finalWritable) {
      if (adoptionFaultHit) v.add('silent_adoption_failure');
      else if (
        !row.faultsHitFinal.some(hit => hit.startsWith('api.fetch:')) &&
        !finalNever
      ) {
        // (a malformed pending read that reads as "no stash" lands here)
        v.add('stash_not_adopted');
      }
    }
    const loadFaultHit = row.faultsHitFinal.some(
      hit =>
        hit.startsWith('db.open') ||
        hit.startsWith(`get:${profileKeyForOwner(finalOwner)}:`) ||
        hit.startsWith('session.read'),
    );
    if (loadFaultHit && !finalNever) v.add('silent_load_failure');
  }
  return [...v].sort();
}

// ── pins ───────────────────────────────────────────────────────────────────

interface Pin {
  id: string;
  finding: string;
  matches: (row: Row, violation: string) => boolean;
}

const KNOWN_ISSUES: readonly Pin[] = [
  {
    id: 'KI-1',
    finding:
      'no hydrate watchdog: a kv read/write that never settles leaves the Gate on the splash spinner forever (appStore.ts:117-129 awaits getKv/setKv with no timeout; App.tsx:174-178 `ready` never flips)',
    matches: (row, violation) => violation === 'hung_on_never' && row.neverHit,
  },
  {
    id: 'KI-2',
    finding:
      'raw dependency error text becomes user-facing copy: appStore.ts:196-199 sets hydrateError = error.message for SQLite/JSON.parse/account-scope errors, rendered verbatim by App.tsx:219-223 ErrorState',
    matches: (_row, violation) => violation === 'raw_error_copy',
  },
  {
    id: 'KI-3',
    finding:
      'failed stash adoption is silent: appStore.ts:176-178 swallows the save error and, with no prior profile, hydrate ends {profile:null, hydrateError:null} so App.tsx:224 shows the questionnaire again with no retry control — the stash stays and is re-adopted on the next hydrate, REPLACING whatever the user answers now (completeOnboarding never clears the stash)',
    matches: (_row, violation) => violation === 'silent_adoption_failure',
  },
  {
    id: 'KI-4',
    finding:
      'a stored non-object profile (JSON [], "", 42, {}) is trusted as a profile: appStore.ts:182 `JSON.parse(raw) as Profile` with no shape check, so the Gate skips onboarding with an unusable profile',
    matches: (row, violation) =>
      violation === 'invalid_profile_in_state' &&
      ['json-array', 'json-string', 'json-number', 'empty-object'].includes(
        row.scenario.stored,
      ) &&
      row.finalOwner === ownerId(row.scenario.owner),
  },
  {
    id: 'KI-5',
    finding:
      'kv read returning a row without a string value is coerced to "no profile" (repository.ts:getKv `rows[0]?.["value"] ? … : null`), so a driver-level malformed read silently re-onboards instead of surfacing an error',
    matches: (row, violation) =>
      ((violation === 'silent_load_failure' ||
        violation === 'valid_kv_profile_not_loaded' ||
        violation === 'stash_not_adopted' ||
        // legacy migration copies the coerced "[object Object]" into the
        // guest bucket and blanks the legacy row before validating it
        violation === 'raw_error_copy') &&
        row.faultsHitFinal.some(hit => hit.endsWith(':malformed'))) ||
      // the corrupted row persists whichever owner is active afterwards
      (violation === 'corrupt_persisted_profile' &&
        row.faultsHit.some(hit => hit.endsWith(':malformed'))),
  },
  {
    id: 'KI-6',
    finding:
      'stash adoption is not atomic after the canonical save: appStore.ts:169-176 PUTs the stash to the account, then the local profile write or the `setKv(PENDING, "")` clear fails inside the same try, so the stash the server already accepted stays live and is adopted AGAIN by every later hydrate — including a different account signing in on the device, whose existing (server-fetched) profile it replaces',
    matches: (row, violation) =>
      violation === 'stash_adopted_twice' &&
      row.faultsHit.some(hit => hit.startsWith('set:')),
  },
  {
    id: 'KI-7',
    finding:
      "stash adoption is not atomic across an owner switch: the owner guard at appStore.ts:162-165 runs once BEFORE the awaits, so while owner A's adoption is awaiting the canonical save / local writes (:169-175) an account switch + re-hydrate reads the still-present stash and adopts it for the new owner too — one questionnaire lands on two owners and the stale owner's writes still complete",
    matches: (row, violation) =>
      violation === 'stash_adopted_twice' &&
      row.scenario.switch?.concurrent === true &&
      !row.faultsHit.some(hit => hit.startsWith('set:')),
  },
  {
    id: 'OBS-1',
    finding:
      'observation (converges, not a finding): adoption assigns `raw` before `await setKv` (appStore.ts:172-173), so when the local profile write fails state shows the adopted profile while kv still has the previous one (or none); the stash is kept (clear is skipped) so the next hydrate re-adopts and kv catches up',
    matches: (row, violation) =>
      (violation === 'state_profile_differs_from_kv' ||
        violation === 'state_profile_not_persisted') &&
      row.faultsHitFinal.some(hit =>
        hit.startsWith(`set:${profileKeyForOwner(row.finalOwner)}:`),
      ),
  },
  {
    id: 'OBS-2',
    finding:
      'observation (unreachable in product): a session whose canonicalAppUserId is not a UUID makes canonicalDataOwner() throw inside the adoption try, silently skipping adoption; authStore.installApiSession validates the id before establishApiSession, so such a session cannot exist at runtime',
    matches: (row, violation) =>
      (violation === 'stash_not_adopted' ||
        violation === 'silent_adoption_failure') &&
      row.scenario.session === 'malformed-id',
  },
];

function pinFor(row: Row, violation: string): Pin | null {
  return KNOWN_ISSUES.find(pin => pin.matches(row, violation)) ?? null;
}

// ── campaign ───────────────────────────────────────────────────────────────

const config = campaignConfig(400);
const rows: Row[] = [];

beforeAll(async () => {
  jest.useFakeTimers();
  for (const seed of config.seeds) {
    rows.push(await runScenario(deriveScenario(seed)));
  }
  jest.useRealTimers();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  for (const row of rows) {
    row.pins = row.violations
      .map(violation => pinFor(row, violation)?.id ?? null)
      .filter((id): id is string => id !== null);
  }
  const faultSeams = new Map<string, number>();
  const violationCounts = new Map<string, number>();
  const pinCounts = new Map<string, number>();
  for (const row of rows) {
    for (const hit of row.faultsHit) {
      faultSeams.set(hit, (faultSeams.get(hit) ?? 0) + 1);
    }
    for (const violation of row.violations) {
      violationCounts.set(violation, (violationCounts.get(violation) ?? 0) + 1);
    }
    for (const pin of row.pins)
      pinCounts.set(pin, (pinCounts.get(pin) ?? 0) + 1);
  }
  const table = rows.map(row => ({
    seed: row.seed,
    outcome: row.violations.length === 0 ? 'HELD' : 'VIOLATION',
    violations: row.violations,
    pins: row.pins,
    runs: row.runs.map(r => `${r.owner}:${r.settlement}@${r.fakeMs}ms`),
    faultsHit: row.faultsHit,
    owner: row.scenario.owner,
    switch: row.scenario.switch
      ? `${row.scenario.switch.to}@call${row.scenario.switch.afterDependencyCall}${
          row.scenario.switch.concurrent ? ':concurrent' : ''
        }`
      : null,
    stored: row.scenario.stored,
    pending: row.scenario.pending,
  }));
  writeArtifact('hydrate.rows.json', rows);
  writeArtifact('hydrate.table.json', table);
  writeArtifact('hydrate.summary.json', {
    iterations: rows.length,
    replaySeed: config.replaySeed,
    held: rows.filter(r => r.violations.length === 0).length,
    withViolations: rows.filter(r => r.violations.length > 0).length,
    rowsWithFaults: rows.filter(r => r.faultsHit.length > 0).length,
    distinctFaultKinds: faultSeams.size,
    faultKinds: Object.fromEntries([...faultSeams.entries()].sort()),
    violations: Object.fromEntries([...violationCounts.entries()].sort()),
    pins: Object.fromEntries([...pinCounts.entries()].sort()),
    unpinned: rows
      .flatMap(row =>
        row.violations
          .filter(violation => !pinFor(row, violation))
          .map(violation => `${row.seed}:${violation}`),
      )
      .sort(),
  });
});

afterAll(() => {
  jest.useRealTimers();
});

test('campaign ran every seed', () => {
  expect(rows.length).toBe(config.seeds.length);
  expect(rows.length).toBeGreaterThan(0);
});

test('every violation is a pinned known issue, and every pin still reproduces', () => {
  const unpinned: string[] = [];
  const matched = new Set<string>();
  for (const row of rows) {
    for (const violation of row.violations) {
      const pin = pinFor(row, violation);
      if (pin) matched.add(pin.id);
      else
        unpinned.push(
          `seed ${row.seed}: ${violation} (faults ${row.faultsHit.join(',') || 'none'})`,
        );
    }
  }
  expect(unpinned).toEqual([]);
  // Only the default campaign (seeds 1..400) is required to hit every KI pin;
  // OBS pins are observations, each KI also has a minimized repro below.
  if (config.isDefault) {
    const stale = KNOWN_ISSUES.filter(
      pin => pin.id.startsWith('KI-') && !matched.has(pin.id),
    ).map(pin => `${pin.id}: ${pin.finding}`);
    expect(stale).toEqual([]);
  }
});

test('hydrate() never rejects and never hangs unless a dependency literally never settles', () => {
  const rejected = rows.filter(row =>
    row.violations.includes('hydrate_rejected'),
  );
  const hung = rows.filter(row =>
    row.violations.includes('hung_without_never'),
  );
  expect(rejected.map(r => r.seed)).toEqual([]);
  expect(hung.map(r => r.seed)).toEqual([]);
});

test('persisted kv: no cross-owner write, no deleted key, stash never lost or consumed without adoption (HELD unconditionally)', () => {
  const bad = rows.filter(row =>
    row.violations.some(violation =>
      [
        'corrupt_pending',
        'cross_owner_write',
        'kv_key_deleted',
        'legacy_key_rewritten',
        'stash_consumed_without_adoption',
        'stash_lost_on_failed_adoption',
      ].includes(violation),
    ),
  );
  expect(bad.map(r => `${r.seed}:${r.violations.join(',')}`)).toEqual([]);
});

test('persisted kv: corruption and double adoption occur ONLY through the pinned paths (KI-5 legacy migration of a malformed row, KI-6/KI-7 stash lifecycle)', () => {
  const bad = rows.filter(row =>
    row.violations.some(
      violation =>
        ['corrupt_persisted_profile', 'stash_adopted_twice'].includes(
          violation,
        ) && pinFor(row, violation) === null,
    ),
  );
  expect(bad.map(r => `${r.seed}:${r.violations.join(',')}`)).toEqual([]);
});

test('after an account switch the state belongs to the new owner only', () => {
  const switched = rows.filter(row => row.scenario.switch !== null);
  const bad = switched.filter(row =>
    row.violations.some(violation =>
      [
        'owner_mismatch',
        'state_profile_differs_from_kv',
        'error_and_profile',
      ].includes(violation),
    ),
  );
  expect(bad.map(r => `${r.seed}:${r.violations.join(',')}`)).toEqual([]);
  if (config.replaySeed === null && rows.length >= 400) {
    expect(switched.length).toBeGreaterThan(0);
  }
});

test('the campaign fired at least 60 injected faults across every seam and mode', () => {
  if (config.replaySeed !== null || rows.length < 400) return;
  const fired = rows.reduce((n, row) => n + row.faultsHit.length, 0);
  expect(fired).toBeGreaterThanOrEqual(60);
  const seams = new Set(
    rows.flatMap(row => row.faultsHit.map(hit => hit.split(':')[0])),
  );
  expect([...seams].sort()).toEqual([
    'api.fetch',
    'api.save',
    'db.open',
    'get',
    'session.read',
    'set',
  ]);
  const modes = new Set(
    rows.flatMap(row => row.faultsHit.map(hit => hit.split(':').pop())),
  );
  expect([...modes].sort()).toEqual(['malformed', 'never', 'reject', 'throw']);
  expect(rows.some(row => row.slowHit.length > 0)).toBe(true);
});

// ── minimized reproductions (assert the CONTRACT; `failing` until fixed) ───

describe('minimized reproductions', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  test.failing(
    'KI-1: hydrate settles within 60s when the profile kv read never resolves',
    async () => {
      const row = await runScenario({
        seed: 0,
        owner: 'guest',
        session: 'none',
        stored: 'valid',
        otherStored: 'none',
        pending: 'none',
        serverHasProfile: false,
        faults: { 'kv.get.profile': { mode: 'never' } },
        switch: null,
      });
      expect(row.runs[0]!.settlement).toBe('resolved');
    },
  );

  test.failing(
    'KI-2: a SQLite read failure surfaces product copy, not the driver message',
    async () => {
      const row = await runScenario({
        seed: 0,
        owner: 'guest',
        session: 'none',
        stored: 'valid',
        otherStored: 'none',
        pending: 'none',
        serverHasProfile: false,
        faults: { 'kv.get.profile': { mode: 'reject' } },
        switch: null,
      });
      expect(row.state.hydrateError).not.toBeNull();
      expect(PRODUCT_COPY.has(row.state.hydrateError!)).toBe(true);
    },
  );

  test.failing(
    'KI-3: a failed canonical stash adoption with no prior profile shows a retry state, not the questionnaire',
    async () => {
      const row = await runScenario({
        seed: 0,
        owner: 'canonical-a',
        session: 'a',
        stored: 'none',
        otherStored: 'none',
        pending: 'valid',
        serverHasProfile: false,
        faults: { 'api.save': { mode: 'reject' } },
        switch: null,
      });
      expect(row.state.profile).toBeNull();
      expect(row.kvAfter[PENDING_ONBOARDING_PROFILE_KV_KEY]).toBe(
        row.kvBefore[PENDING_ONBOARDING_PROFILE_KV_KEY],
      );
      expect(row.state.hydrateError).not.toBeNull();
    },
  );

  test('KI-3 consequence: answering the questionnaire again does NOT retire the stale stash, so the next hydrate replaces the newer answers', async () => {
    const fx = makeFixtures(7);
    const kv = new FaultKv({
      [PENDING_ONBOARDING_PROFILE_KV_KEY]: JSON.stringify({
        version: 1,
        profile: fx.stashProfile,
      }),
    });
    mockDbSeam.open = () => kv;
    mockSessionSeam.read = () => sessionFor('a');
    let saveFails = true;
    mockApiSeam.fetch = async () => null;
    mockApiSeam.save = async (_s, p) => {
      if (saveFails) throw new Error('offline');
      return { ...p, focusCheckpoint: 'recovery' };
    };
    resetStore();
    setActiveDataOwner(CANONICAL_A);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    expect(useAppStore.getState().hydrateError).toBeNull(); // questionnaire shown

    // User answers again (newest intent), now online.
    saveFails = false;
    const newer: Profile = {
      ...fx.storedProfile,
      biggestProblem: 'NEWER-ANSWER',
    };
    await useAppStore.getState().completeOnboarding(newer);
    expect(useAppStore.getState().profile?.biggestProblem).toBe('NEWER-ANSWER');
    expect(kv.table.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).not.toBe('');

    // Next launch: the stale pre-auth stash is adopted over the newer answers.
    await useAppStore.getState().hydrate();
    const after = useAppStore.getState().profile as Profile;
    expect(after.biggestProblem).toBe(fx.stashProfile.biggestProblem);
    expect(after.biggestProblem).not.toBe('NEWER-ANSWER');
  });

  test.failing(
    'KI-6: a stash whose clear write failed after a successful adoption is not adopted again by the next account',
    async () => {
      const row = await runScenario({
        seed: 2,
        owner: 'canonical-a',
        session: 'a',
        stored: 'none',
        otherStored: 'valid',
        pending: 'valid',
        serverHasProfile: false,
        faults: { 'kv.set.pendingClear': { mode: 'reject' } },
        // A's hydrate completes fully; B signs in on the same device afterwards.
        switch: {
          afterDependencyCall: 99,
          to: 'canonical-b',
          concurrent: false,
        },
      });
      const fx = makeFixtures(2);
      // Account A adopted the stash (server save + local write both succeeded).
      expect(
        row.apiCalls.filter(c => c.op === 'save').map(c => c.owner),
      ).toContain(CANONICAL_A);
      // Account B must keep its own profile.
      expect(
        parseProfileJson(row.kvAfter[profileKeyForOwner(CANONICAL_B)]),
      ).toEqual(fx.otherProfile);
    },
  );

  test.failing(
    'KI-7: a stash being adopted by account A is not adopted again by a concurrent sign-out → continue-locally hydrate',
    async () => {
      const row = await runScenario({
        seed: 47,
        owner: 'canonical-a',
        session: 'a',
        stored: 'none',
        otherStored: 'none',
        pending: 'valid',
        serverHasProfile: false,
        // The canonical save is merely slow (a delay, not a failure).
        faults: { 'api.save': { mode: 'slow', slowMs: 4000 } },
        // Sign out + continue locally while A's save (dependency call 4:
        // pending, profile, fetch, save) is still in flight.
        switch: { afterDependencyCall: 4, to: 'guest', concurrent: true },
      });
      const adopters = row.kvCalls
        .filter(call => call.op === 'set' && call.key.startsWith('profile:'))
        .map(call => call.key);
      expect(row.runs.map(run => run.settlement)).toEqual([
        'resolved',
        'resolved',
      ]);
      // One questionnaire must land on exactly one owner.
      expect(new Set(adopters).size).toBe(1);
    },
  );

  test.failing(
    'KI-4: a stored `[]` profile is not treated as an onboarded profile',
    async () => {
      const row = await runScenario({
        seed: 0,
        owner: 'guest',
        session: 'none',
        stored: 'json-array',
        otherStored: 'none',
        pending: 'none',
        serverHasProfile: false,
        faults: {},
        switch: null,
      });
      expect(
        row.state.profile === null || isValidProfile(row.state.profile),
      ).toBe(true);
    },
  );

  test.failing(
    'KI-5: a kv row without a string value is an error, not "no profile"',
    async () => {
      const row = await runScenario({
        seed: 0,
        owner: 'guest',
        session: 'none',
        stored: 'valid',
        otherStored: 'none',
        pending: 'none',
        serverHasProfile: false,
        faults: {
          'kv.get.profile': { mode: 'malformed', malformedRows: 'numeric-0' },
        },
        switch: null,
      });
      expect(
        row.state.profile !== null || row.state.hydrateError !== null,
      ).toBe(true);
    },
  );
});
