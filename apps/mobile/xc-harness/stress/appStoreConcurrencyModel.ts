/**
 * Concurrency model for `src/state/appStore.ts`.
 *
 * A scenario is generated from a seed: an initial device/server state, an
 * active data owner, and a short program of actions (hydrate, account switch
 * followed by the App-driven re-hydrate, completeOnboarding,
 * completePreAuthOnboarding, bearer rotation, sign-out). The scheduler
 * interleaves launching those actions with settling the store's I/O
 * (kv reads/writes, canonical fetch/save) in a seeded random order, with
 * optional injected faults. When everything has settled, the invariants below
 * are evaluated against the store state, the kv table, the fake server, and
 * the write trace.
 *
 * Profile identity: every profile carries a unique `firstName` MARKER so a
 * value found in kv / on the server / in memory can be attributed to the
 * action that produced it:
 *   K<owner>  seeded kv row            C<owner>  seeded canonical (server) row
 *   L         seeded legacy `profile`  P<n>      completeOnboarding payload
 *   S<n>      pre-auth stash payload
 */
import type { LocalDb } from '../../src/data/db';
import type { ApiSession } from '../../src/account/apiSession';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { Profile } from '../../src/state/profile';
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import {
  SeededScheduler,
  drainMicrotasks,
  makePrng,
  pick,
  pickWeighted,
} from './seededScheduler';

export const OWNER_A = '11111111-1111-4111-8111-111111111111';
export const OWNER_B = '22222222-2222-4222-8222-222222222222';
export const OWNERS = [
  OWNER_A,
  OWNER_B,
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
] as const;
export type Owner = (typeof OWNERS)[number];

const LEGACY_PROFILE_KEY = 'profile';
const SERVER_FOCUS: Profile['focusCheckpoint'] = 'preparation';
const CLIENT_FOCUS: Profile['focusCheckpoint'] = 'contact_position';

export function profileKey(owner: string): string {
  return `profile:${owner}`;
}

export function makeProfile(
  marker: string,
  focus: Profile['focusCheckpoint'] = CLIENT_FOCUS,
): Profile {
  return {
    firstName: marker,
    gender: 'prefer_not_to_say',
    skillLevel: '3.5',
    handedness: 'right',
    goal: 'dinks',
    biggestProblem: 'control',
    focusCheckpoint: focus,
  };
}

export function markerOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const profile =
      'profile' in record && record['profile'] && !('skillLevel' in record)
        ? (record['profile'] as Record<string, unknown>)
        : record;
    return typeof profile['firstName'] === 'string'
      ? profile['firstName']
      : null;
  } catch {
    return null;
  }
}

function isCanonical(owner: string): boolean {
  return owner === OWNER_A || owner === OWNER_B;
}

// ─── Fault plan ─────────────────────────────────────────────────────────────

export type FaultKind =
  | 'none'
  | 'kvGetThrows'
  | 'kvSetThrows'
  | 'fetchThrows'
  | 'saveThrows'
  | 'saveAppliedThenThrows';

export interface KvWrite {
  seq: number;
  key: string;
  value: string;
  faulted: boolean;
}

// ─── Fake SQLite kv ─────────────────────────────────────────────────────────

export class ScheduledKvDb {
  readonly kv = new Map<string, string>();
  readonly writes: KvWrite[] = [];
  readonly statements: string[] = [];
  private seq = 0;

  constructor(
    private readonly scheduler: SeededScheduler,
    private readonly faultFor: (op: 'kvGet' | 'kvSet') => FaultKind,
  ) {}

  handle(): LocalDb {
    return {
      execute: (sql: string, params: unknown[] = []) => {
        const statement = sql.trim().replace(/\s+/g, ' ');
        this.statements.push(statement);
        if (statement.startsWith('SELECT value FROM kv')) {
          const key = String(params[0]);
          return this.scheduler.defer(`kvGet(${key})`, () => {
            if (this.faultFor('kvGet') === 'kvGetThrows') {
              this.scheduler.note(`fault:kvGet(${key})`);
              throw new Error(`SQLITE_IOERR (simulated) reading ${key}`);
            }
            const value = this.kv.get(key);
            return { rows: value === undefined ? [] : [{ value }] };
          });
        }
        if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
          const key = String(params[0]);
          const value = String(params[1]);
          return this.scheduler.defer(`kvSet(${key})`, () => {
            const faulted = this.faultFor('kvSet') === 'kvSetThrows';
            this.seq += 1;
            this.writes.push({ seq: this.seq, key, value, faulted });
            if (faulted) {
              this.scheduler.note(`fault:kvSet(${key})`);
              throw new Error(`SQLITE_IOERR (simulated) writing ${key}`);
            }
            this.kv.set(key, value);
            return { rows: [] };
          });
        }
        return this.scheduler.defer(`sql(${statement.slice(0, 24)})`, () => ({
          rows: [],
        }));
      },
      close: () => {},
    };
  }

  destructiveStatements(): string[] {
    return this.statements.filter(sql =>
      /^(DELETE|DROP|UPDATE|ALTER|TRUNCATE)\b/i.test(sql),
    );
  }
}

// ─── Fake canonical profile server ──────────────────────────────────────────

export interface ServerSave {
  seq: number;
  owner: string;
  bearer: string;
  marker: string | null;
  outcome: 'applied' | 'rejected' | 'appliedThenRejected';
}

export class ScheduledProfileServer {
  readonly profiles = new Map<string, Profile>();
  readonly saves: ServerSave[] = [];
  fetchCalls = 0;
  private seq = 0;

  constructor(
    private readonly scheduler: SeededScheduler,
    private readonly faultFor: (op: 'fetch' | 'save') => FaultKind,
  ) {}

  fetch(session: ApiSession): Promise<Profile | null> {
    return this.scheduler.defer(
      `fetch(${session.canonicalAppUserId.slice(0, 2)})`,
      () => {
        this.fetchCalls += 1;
        if (this.faultFor('fetch') === 'fetchThrows') {
          this.scheduler.note('fault:fetch');
          throw new Error('Network request failed (simulated)');
        }
        return this.profiles.get(session.canonicalAppUserId) ?? null;
      },
    );
  }

  save(session: ApiSession, profile: Profile): Promise<Profile> {
    const owner = session.canonicalAppUserId;
    return this.scheduler.defer(
      `save(${owner.slice(0, 2)},${profile.firstName ?? '?'})`,
      () => {
        const fault = this.faultFor('save');
        const adjusted: Profile = { ...profile, focusCheckpoint: SERVER_FOCUS };
        this.seq += 1;
        if (fault === 'saveThrows') {
          this.saves.push({
            seq: this.seq,
            owner,
            bearer: session.bearerToken,
            marker: profile.firstName ?? null,
            outcome: 'rejected',
          });
          this.scheduler.note('fault:save');
          throw new Error('503 (simulated)');
        }
        this.profiles.set(owner, adjusted);
        if (fault === 'saveAppliedThenThrows') {
          this.saves.push({
            seq: this.seq,
            owner,
            bearer: session.bearerToken,
            marker: profile.firstName ?? null,
            outcome: 'appliedThenRejected',
          });
          this.scheduler.note('fault:saveAppliedThenThrows');
          throw new Error('response lost (simulated)');
        }
        this.saves.push({
          seq: this.seq,
          owner,
          bearer: session.bearerToken,
          marker: profile.firstName ?? null,
          outcome: 'applied',
        });
        return adjusted;
      },
    );
  }
}

// ─── Scenario ───────────────────────────────────────────────────────────────

export type Action =
  | { kind: 'hydrate' }
  | { kind: 'switchOwner'; owner: Owner }
  | { kind: 'rotateBearer' }
  | { kind: 'completeOnboarding'; marker: string }
  | { kind: 'completePreAuthOnboarding'; marker: string }
  | { kind: 'setLastShotType' };

export type FaultOp = 'kvGet' | 'kvSet' | 'fetch' | 'save';

export interface Scenario {
  seed: number;
  faultRate: number;
  /**
   * Deterministic faults keyed `<op>#<n>` (1-based n-th settle of that op),
   * e.g. `{ 'save#1': 'saveThrows' }`. Wins over `faultRate` for that call.
   */
  scriptedFaults?: Partial<Record<`${FaultOp}#${number}`, FaultKind>>;
  /** Launch each action only once everything before it has settled. */
  sequential?: boolean;
  initialOwner: Owner;
  initialKv: Record<string, string>;
  initialServer: Record<string, string>;
  actions: Action[];
}

export interface ScenarioOptions {
  /** Restrict the generator, e.g. to reproduce a class of interleavings. */
  faultRates?: readonly number[];
  minActions?: number;
  maxActions?: number;
}

export function generateScenario(
  seed: number,
  options: ScenarioOptions = {},
): Scenario {
  const rng = makePrng(seed ^ 0x9e3779b9);
  const faultRate = pick(rng, options.faultRates ?? [0, 0, 0.05, 0.2]);
  const initialOwner = pick(rng, OWNERS);
  const initialKv: Record<string, string> = {};
  const initialServer: Record<string, string> = {};
  for (const owner of [OWNER_A, OWNER_B, GUEST_DATA_OWNER]) {
    if (rng() < 0.4) {
      initialKv[profileKey(owner)] = JSON.stringify(
        makeProfile(`K${owner.slice(0, 1)}`),
      );
    }
  }
  if (rng() < 0.25) {
    initialKv[LEGACY_PROFILE_KEY] = JSON.stringify(makeProfile('L'));
  }
  if (rng() < 0.4) {
    initialKv[PENDING_ONBOARDING_PROFILE_KV_KEY] = JSON.stringify({
      version: 1,
      profile: makeProfile('S0'),
    });
  }
  for (const owner of [OWNER_A, OWNER_B]) {
    if (rng() < 0.4) {
      initialServer[owner] = JSON.stringify(
        makeProfile(`C${owner.slice(0, 1)}`, SERVER_FOCUS),
      );
    }
  }
  const minActions = options.minActions ?? 2;
  const maxActions = options.maxActions ?? 7;
  const count = minActions + Math.floor(rng() * (maxActions - minActions + 1));
  const actions: Action[] = [{ kind: 'hydrate' }];
  let nextMarker = 1;
  for (let i = 1; i < count; i += 1) {
    const kind = pickWeighted<Action['kind']>(rng, [
      { weight: 30, value: 'hydrate' },
      { weight: 25, value: 'switchOwner' },
      { weight: 15, value: 'completeOnboarding' },
      { weight: 15, value: 'completePreAuthOnboarding' },
      { weight: 8, value: 'rotateBearer' },
      { weight: 7, value: 'setLastShotType' },
    ]);
    switch (kind) {
      case 'switchOwner':
        actions.push({ kind, owner: pick(rng, OWNERS) });
        break;
      case 'completeOnboarding':
        actions.push({ kind, marker: `P${nextMarker}` });
        nextMarker += 1;
        break;
      case 'completePreAuthOnboarding':
        actions.push({ kind, marker: `S${nextMarker}` });
        nextMarker += 1;
        break;
      default:
        actions.push({ kind });
    }
  }
  return { seed, faultRate, initialOwner, initialKv, initialServer, actions };
}

// ─── Execution ──────────────────────────────────────────────────────────────

export interface LaunchedOp {
  index: number;
  kind: Action['kind'];
  owner: string;
  marker: string | null;
  launchedAtStep: number;
  settledAtStep: number | null;
  rejected: boolean;
  error: string | null;
  returned: unknown;
  /** Store state captured right after the promise settled. */
  stateAfter: StateSnapshot | null;
}

export interface StateSnapshot {
  hydrated: boolean;
  ownerKey: string | null;
  profileMarker: string | null;
  profileFocus: string | null;
  hydrateError: string | null;
  onboardingBusy: boolean;
  onboardingError: string | null;
}

export function snapshot(): StateSnapshot {
  const state = useAppStore.getState();
  return {
    hydrated: state.hydrated,
    ownerKey: state.ownerKey,
    profileMarker: state.profile?.firstName ?? null,
    profileFocus: state.profile?.focusCheckpoint ?? null,
    hydrateError: state.hydrateError,
    onboardingBusy: state.onboardingBusy,
    onboardingError: state.onboardingError,
  };
}

export interface ScenarioResult {
  seed: number;
  scenario: Scenario;
  steps: number;
  durationMs: number;
  deadlocked: boolean;
  faultsInjected: number;
  ops: LaunchedOp[];
  finalState: StateSnapshot;
  finalOwner: string;
  finalKv: Record<string, string>;
  finalServer: Record<string, string>;
  kvWrites: KvWrite[];
  serverSaves: ServerSave[];
  trace: string[];
  invariants: Record<string, boolean>;
  failed: string[];
  ok: boolean;
}

export interface Seams {
  db: { current: ScheduledKvDb | null };
  server: { current: ScheduledProfileServer | null };
}

function sessionFor(owner: string, bearerGeneration: number): ApiSession {
  return {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: `tok-${owner.slice(0, 1)}-${bearerGeneration}`,
    canonicalAppUserId: owner,
    provider: 'apple',
  };
}

function applyOwner(owner: Owner, bearerGeneration: number): void {
  setActiveDataOwner(owner);
  if (isCanonical(owner)) {
    establishApiSession(sessionFor(owner, bearerGeneration));
  } else {
    clearApiSession();
  }
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

const MAX_STEPS = 2_000;

export async function runScenario(
  scenario: Scenario,
  seams: Seams,
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const rng = makePrng(scenario.seed);
  const scheduler = new SeededScheduler(rng);
  let faultsInjected = 0;
  const opCounts: Record<FaultOp, number> = {
    kvGet: 0,
    kvSet: 0,
    fetch: 0,
    save: 0,
  };
  const faultFor = (op: FaultOp): FaultKind => {
    opCounts[op] += 1;
    const scripted = scenario.scriptedFaults?.[`${op}#${opCounts[op]}`];
    if (scripted !== undefined) {
      if (scripted !== 'none') faultsInjected += 1;
      return scripted;
    }
    if (scenario.faultRate <= 0 || rng() >= scenario.faultRate) return 'none';
    faultsInjected += 1;
    switch (op) {
      case 'kvGet':
        return 'kvGetThrows';
      case 'kvSet':
        return 'kvSetThrows';
      case 'fetch':
        return 'fetchThrows';
      case 'save':
        return rng() < 0.5 ? 'saveThrows' : 'saveAppliedThenThrows';
    }
  };
  const db = new ScheduledKvDb(scheduler, faultFor);
  const server = new ScheduledProfileServer(scheduler, faultFor);
  seams.db.current = db;
  seams.server.current = server;
  for (const [key, value] of Object.entries(scenario.initialKv)) {
    db.kv.set(key, value);
  }
  for (const [owner, raw] of Object.entries(scenario.initialServer)) {
    server.profiles.set(owner, JSON.parse(raw) as Profile);
  }
  resetStore();
  let bearerGeneration = 1;
  applyOwner(scenario.initialOwner, bearerGeneration);

  const ops: LaunchedOp[] = [];
  let step = 0;
  const launch = (
    kind: Action['kind'],
    marker: string | null,
    run: () => Promise<unknown>,
  ): void => {
    const op: LaunchedOp = {
      index: ops.length,
      kind,
      owner: getActiveDataOwner(),
      marker,
      launchedAtStep: step,
      settledAtStep: null,
      rejected: false,
      error: null,
      returned: undefined,
      stateAfter: null,
    };
    ops.push(op);
    scheduler.note(`launch:${kind}${marker ? `(${marker})` : ''}@${op.owner}`);
    let promise: Promise<unknown>;
    try {
      promise = run();
    } catch (error) {
      promise = Promise.reject(error);
    }
    void promise.then(
      value => {
        op.settledAtStep = step;
        op.returned = value;
        op.stateAfter = snapshot();
      },
      (error: unknown) => {
        op.settledAtStep = step;
        op.rejected = true;
        op.error = error instanceof Error ? error.message : String(error);
        op.stateAfter = snapshot();
      },
    );
  };

  const perform = (action: Action): void => {
    switch (action.kind) {
      case 'hydrate':
        launch('hydrate', null, () => useAppStore.getState().hydrate());
        return;
      case 'switchOwner':
        bearerGeneration += 1;
        applyOwner(action.owner, bearerGeneration);
        scheduler.note(`env:switchOwner(${action.owner})`);
        // App.tsx re-hydrates on every owner change.
        launch('hydrate', null, () => useAppStore.getState().hydrate());
        return;
      case 'rotateBearer': {
        const owner = getActiveDataOwner();
        if (isCanonical(owner)) {
          bearerGeneration += 1;
          establishApiSession(sessionFor(owner, bearerGeneration));
          scheduler.note(`env:rotateBearer(${bearerGeneration})`);
        }
        return;
      }
      case 'completeOnboarding':
        launch('completeOnboarding', action.marker, () =>
          useAppStore.getState().completeOnboarding(makeProfile(action.marker)),
        );
        return;
      case 'completePreAuthOnboarding':
        launch('completePreAuthOnboarding', action.marker, () =>
          useAppStore
            .getState()
            .completePreAuthOnboarding(makeProfile(action.marker)),
        );
        return;
      case 'setLastShotType':
        useAppStore.getState().setLastShotType('backhand_drive');
        scheduler.note('env:setLastShotType');
        return;
    }
  };

  let nextAction = 0;
  let deadlocked = false;
  for (;;) {
    const canLaunch = nextAction < scenario.actions.length;
    const pending = scheduler.pendingCount();
    if (!canLaunch && pending === 0) break;
    step += 1;
    if (step > MAX_STEPS) {
      deadlocked = true;
      break;
    }
    // Launching the next program action competes with every pending I/O
    // completion so an action can land at any point of another's execution.
    const launchNow =
      canLaunch &&
      (pending === 0 ||
        (scenario.sequential !== true && rng() < 1 / (pending + 1)));
    if (launchNow) {
      perform(scenario.actions[nextAction] as Action);
      nextAction += 1;
    } else {
      scheduler.fireRandom();
    }
    await drainMicrotasks();
  }
  await drainMicrotasks();
  await drainMicrotasks();

  const finalState = snapshot();
  const finalOwner = getActiveDataOwner();
  const finalKv = Object.fromEntries(db.kv.entries());
  const finalServer = Object.fromEntries(
    [...server.profiles.entries()].map(([owner, profile]) => [
      owner,
      JSON.stringify(profile),
    ]),
  );
  const partial = {
    seed: scenario.seed,
    scenario,
    steps: step,
    durationMs: Date.now() - startedAt,
    deadlocked,
    faultsInjected,
    ops,
    finalState,
    finalOwner,
    finalKv,
    finalServer,
    kvWrites: db.writes,
    serverSaves: server.saves,
    trace: scheduler.trace,
  };
  const invariants = evaluateInvariants(partial, db);
  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  return { ...partial, invariants, failed, ok: failed.length === 0 };
}

// ─── Invariants ─────────────────────────────────────────────────────────────

type PartialResult = Omit<ScenarioResult, 'invariants' | 'failed' | 'ok'>;

function isIntentionalMarker(marker: string | null): boolean {
  return marker !== null && (marker.startsWith('P') || marker.startsWith('S'));
}

export function evaluateInvariants(
  r: PartialResult,
  db: ScheduledKvDb,
): Record<string, boolean> {
  const inv: Record<string, boolean> = {};
  const unsettled = r.ops.filter(op => op.settledAtStep === null);

  // Liveness: every launched call settles and the run stays bounded.
  inv['terminates'] = !r.deadlocked && unsettled.length === 0;
  inv['boundedWallTime'] = r.durationMs < 5_000;

  // Rejection contract: hydrate/completePreAuthOnboarding never reject;
  // completeOnboarding rejects only when launched without a writable owner.
  inv['hydrateNeverRejects'] = r.ops
    .filter(op => op.kind === 'hydrate')
    .every(op => !op.rejected);
  inv['preAuthNeverRejects'] = r.ops
    .filter(op => op.kind === 'completePreAuthOnboarding')
    .every(op => !op.rejected && typeof op.returned === 'boolean');
  inv['completeOnboardingRejectsOnlySignedOut'] = r.ops
    .filter(op => op.kind === 'completeOnboarding')
    .every(op => op.rejected === (op.owner === SIGNED_OUT_DATA_OWNER));

  // Quiescent UI state: not busy, hydrated for the current owner.
  inv['busyCleared'] = r.finalState.onboardingBusy === false;
  inv['hydratedForActiveOwner'] =
    r.finalState.hydrated === true && r.finalState.ownerKey === r.finalOwner;

  // Memory vs durable copy for the current owner.
  const activeRaw = r.finalKv[profileKey(r.finalOwner)] ?? null;
  const activeMarker = markerOf(activeRaw);
  const memMarker = r.finalState.profileMarker;
  inv['memoryProfileIsDurable'] =
    memMarker === null ||
    (activeMarker === memMarker &&
      r.finalState.profileFocus ===
        (JSON.parse(activeRaw as string) as Profile).focusCheckpoint);
  inv['noNullMemoryWhileProfileStored'] = !(
    memMarker === null &&
    activeMarker !== null &&
    r.finalState.hydrateError === null &&
    r.finalOwner !== SIGNED_OUT_DATA_OWNER
  );
  inv['errorOnlyAfterFault'] =
    r.finalState.hydrateError === null || r.faultsInjected > 0;

  // A stale hydrate must not repaint over a newer one for the same owner:
  // when the latest-launched hydrate for the final owner settled cleanly and
  // no completeOnboarding for that owner settled after it, the final state
  // is what that hydrate left (no error, same profile).
  const hydratesForOwner = r.ops.filter(
    op => op.kind === 'hydrate' && op.owner === r.finalOwner,
  );
  const newest = hydratesForOwner[hydratesForOwner.length - 1];
  const laterWrites = newest
    ? r.ops.some(
        op =>
          op.kind === 'completeOnboarding' &&
          op.owner === r.finalOwner &&
          (op.settledAtStep === null ||
            newest.settledAtStep === null ||
            op.settledAtStep >= newest.settledAtStep),
      )
    : true;
  inv['newestCleanHydrateWins'] =
    !newest ||
    laterWrites ||
    !newest.stateAfter ||
    newest.stateAfter.hydrateError !== null ||
    (newest.stateAfter.profileMarker === r.finalState.profileMarker &&
      r.finalState.hydrateError === null);

  // Pre-auth stash: single-use across owners, never silently lost.
  const stashMarkers = new Set<string>();
  const seededStash = markerOf(
    r.scenario.initialKv[PENDING_ONBOARDING_PROFILE_KV_KEY],
  );
  if (seededStash) stashMarkers.add(seededStash);
  const stashWrittenAt = new Map<string, number>();
  if (seededStash) stashWrittenAt.set(seededStash, 0);
  for (const op of r.ops) {
    if (op.kind === 'completePreAuthOnboarding' && op.marker) {
      stashMarkers.add(op.marker);
      stashWrittenAt.set(op.marker, op.launchedAtStep);
    }
  }
  const profileWrites = r.kvWrites.filter(
    w => w.key.startsWith('profile:') && !w.faulted,
  );
  const ownersAdopting = (marker: string): Set<string> => {
    const owners = new Set<string>();
    for (const w of profileWrites) {
      if (markerOf(w.value) === marker)
        owners.add(w.key.slice('profile:'.length));
    }
    for (const save of r.serverSaves) {
      if (save.marker === marker && save.outcome === 'applied') {
        owners.add(save.owner);
      }
    }
    return owners;
  };
  inv['stashAdoptedByAtMostOneOwner'] = [...stashMarkers].every(
    marker => ownersAdopting(marker).size <= 1,
  );
  // Adopting one stash into one owner needs one server save.
  inv['stashSavedOncePerOwner'] = [...stashMarkers].every(marker => {
    const perOwner = new Map<string, number>();
    for (const save of r.serverSaves) {
      if (save.marker === marker && save.outcome === 'applied') {
        perOwner.set(save.owner, (perOwner.get(save.owner) ?? 0) + 1);
      }
    }
    return [...perOwner.values()].every(count => count <= 1);
  });
  // The newest stash that landed durably is either adopted or still pending.
  const stashWrites = r.kvWrites.filter(
    w =>
      w.key === PENDING_ONBOARDING_PROFILE_KV_KEY &&
      w.value !== '' &&
      !w.faulted,
  );
  const newestStash =
    stashWrites.length > 0
      ? markerOf((stashWrites[stashWrites.length - 1] as KvWrite).value)
      : seededStash;
  const pendingNow = markerOf(r.finalKv[PENDING_ONBOARDING_PROFILE_KV_KEY]);
  inv['stashNotLost'] =
    newestStash === null ||
    pendingNow === newestStash ||
    ownersAdopting(newestStash).size >= 1;
  inv['pendingKvWellFormed'] = (() => {
    const raw = r.finalKv[PENDING_ONBOARDING_PROFILE_KV_KEY];
    if (raw === undefined || raw === '') return true;
    try {
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        profile?: unknown;
      };
      return parsed.version === 1 && typeof parsed.profile === 'object';
    } catch {
      return false;
    }
  })();

  // Durable intent per owner: once an intentional write (completeOnboarding
  // or stash adoption) landed for an owner, a derived write (canonical cache
  // fill, legacy migration) must not replace it.
  inv['durableIntentKept'] = [OWNER_A, OWNER_B, GUEST_DATA_OWNER].every(
    owner => {
      const writes = profileWrites.filter(w => w.key === profileKey(owner));
      const lastIntentional = [...writes]
        .reverse()
        .find(w => isIntentionalMarker(markerOf(w.value)));
      if (!lastIntentional) return true;
      return (
        markerOf(r.finalKv[profileKey(owner)]) ===
        markerOf(lastIntentional.value)
      );
    },
  );

  // Later intent wins: between a pre-auth stash and an in-account completion
  // the owner must end up with the more recently EXPRESSED one (stash write
  // time vs completeOnboarding call time) — never an older stash resurrected
  // over a newer completion. Two racing completeOnboarding calls are a tie
  // (last writer wins is acceptable; the UI serialises them).
  inv['laterIntentWins'] = [OWNER_A, OWNER_B, GUEST_DATA_OWNER].every(owner => {
    const finalMarker = markerOf(r.finalKv[profileKey(owner)]);
    if (!isIntentionalMarker(finalMarker)) return true;
    const expressedAt = (marker: string): number | null => {
      if (marker.startsWith('S')) return stashWrittenAt.get(marker) ?? null;
      const op = r.ops.find(
        o => o.kind === 'completeOnboarding' && o.marker === marker,
      );
      return op ? op.launchedAtStep : null;
    };
    const finalAt = expressedAt(finalMarker as string);
    if (finalAt === null) return true;
    const landedForOwner = new Set(
      profileWrites
        .filter(w => w.key === profileKey(owner))
        .map(w => markerOf(w.value))
        .filter(isIntentionalMarker),
    );
    return [...landedForOwner].every(marker => {
      if ((marker as string)[0] === (finalMarker as string)[0]) return true;
      const at = expressedAt(marker as string);
      return at === null || at <= finalAt;
    });
  });

  // Device/server agreement: every canonical write path (cache fill, adoption,
  // completeOnboarding) writes both sides, so once a canonical owner's row
  // was touched in a fault-free run the two copies must agree.
  inv['deviceMatchesServerAfterWrite'] =
    r.faultsInjected > 0 ||
    [OWNER_A, OWNER_B].every(owner => {
      const touched =
        profileWrites.some(w => w.key === profileKey(owner)) ||
        r.serverSaves.some(save => save.owner === owner);
      if (!touched) return true;
      return (
        markerOf(r.finalKv[profileKey(owner)]) ===
        markerOf(r.finalServer[owner])
      );
    });

  // Owner isolation: a profile row for X only ever holds X's own material.
  inv['noCrossOwnerProfileWrite'] = r.kvWrites
    .filter(w => w.key.startsWith('profile:') && !w.faulted)
    .every(w => {
      const owner = w.key.slice('profile:'.length);
      const marker = markerOf(w.value);
      if (marker === null) return false;
      if (marker.startsWith('S') || marker === 'L') return true;
      if (marker.startsWith('P')) {
        const op = r.ops.find(
          o => o.kind === 'completeOnboarding' && o.marker === marker,
        );
        return op?.owner === owner;
      }
      // K<x>/C<x> seeded material must stay with its owner.
      return marker.slice(1) === owner.slice(0, 1);
    });

  // Server writes go out only for the owner whose session issued them.
  inv['saveBearerMatchesOwner'] = r.serverSaves.every(save =>
    save.bearer.startsWith(`tok-${save.owner.slice(0, 1)}-`),
  );

  inv['noDestructiveSql'] = db.destructiveStatements().length === 0;
  return inv;
}
