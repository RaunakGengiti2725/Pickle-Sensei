import { SHOT_TYPES } from '@pickle/shared-types';
import type { ShotTypeSlug } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import type { Profile } from '../../src/state/profile';
import { focusForGoal } from '../../src/state/profile';
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
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';

/**
 * Seeded randomized long-run model for `state/appStore` (+ `state/profile`).
 *
 * The world owns every seam the store touches — the SQLite kv (`getDb`), the
 * canonical onboarding endpoint (`fetch/saveCanonicalOnboardingProfile`), the
 * active data owner and the in-memory ApiSession — and turns each async hop
 * into a DEFERRED operation that the sequence releases explicitly, in a
 * seeded order. That makes every interleaving of concurrent `hydrate()`,
 * `completeOnboarding()` and `completePreAuthOnboarding()` calls a
 * first-class, replayable scenario: the seed fixes the action list AND the
 * release order, so a failing seed is a deterministic repro.
 *
 * Invariants are documented next to `checkInvariants()`; they follow the
 * contract written on appStore.ts (pre-auth stash is single-use and adopted
 * only by a writable owner, a failed adoption keeps stash + existing
 * profile, state never shows another owner's profile, hydrate never throws,
 * the Gate is never left without a hydrated owner once everything settled).
 */

// ─── Owners ──────────────────────────────────────────────────────────────────

export const OWNER_A = '7fc2c743-028f-4ec6-942c-a84508f3be38';
export const OWNER_B = '0b4d1f9e-3c2a-4b8e-9f1d-2a6c7e8b9d01';

export const OWNER_NAMES = ['signed-out', 'guest', 'A', 'B'] as const;
export type OwnerName = (typeof OWNER_NAMES)[number];

export function ownerKeyOf(name: OwnerName): string {
  switch (name) {
    case 'signed-out':
      return SIGNED_OUT_DATA_OWNER;
    case 'guest':
      return GUEST_DATA_OWNER;
    case 'A':
      return OWNER_A;
    case 'B':
      return OWNER_B;
  }
}

export function ownerNameOf(key: string | null): OwnerName | 'unknown' {
  if (key === SIGNED_OUT_DATA_OWNER) return 'signed-out';
  if (key === GUEST_DATA_OWNER) return 'guest';
  if (key === OWNER_A) return 'A';
  if (key === OWNER_B) return 'B';
  return 'unknown';
}

function isCanonical(name: OwnerName): name is 'A' | 'B' {
  return name === 'A' || name === 'B';
}

// ─── Profiles ────────────────────────────────────────────────────────────────

const GOALS = [
  'dinks',
  'drives',
  'drops',
  'serve',
  'return',
  'volleys',
  'footwork',
  'all-around',
  'consistency',
] as const;

/** The server recomputes focus from the goal; a fixed distinct key makes the
 * "server focusCheckpoint wins" rule observable in the trace. */
export const SERVER_FOCUS = 'recovery';

/** `biggestProblem` carries the content tag: every generated profile is
 * unique per tag, so a value seen in state or kv can be traced back to the
 * call (or stash) that produced it. */
export function makeProfile(tag: string, rng: () => number): Profile {
  const goal = pick(rng, GOALS);
  return {
    firstName: `name-${tag}`,
    gender: pick(rng, ['female', 'male', 'nonbinary', 'prefer_not_to_say']),
    skillLevel: pick(rng, ['2.5', '3.0', '3.5', '4.0', '4.5']),
    handedness: pick(rng, ['right', 'left']),
    goal,
    biggestProblem: tag,
    focusCheckpoint: focusForGoal(goal),
  };
}

export function tagOf(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const tag = (value as Record<string, unknown>)['biggestProblem'];
  return typeof tag === 'string' ? tag : null;
}

export function isProfileShape(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return [
    'skillLevel',
    'handedness',
    'goal',
    'biggestProblem',
    'focusCheckpoint',
  ].every(key => typeof record[key] === 'string');
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export type FaultTarget =
  'dbRead' | 'dbWrite' | 'dbOpen' | 'netFetch' | 'netSave';

export type Action =
  /** Auth event: the data owner changes and the Gate re-hydrates. */
  | { kind: 'switch'; to: OwnerName }
  /** Gate "Try again" / remount: hydrate() for the current owner. */
  | { kind: 'rehydrate' }
  | { kind: 'completeOnboarding'; tag: string; profileSeed: number }
  | { kind: 'completePreAuth'; tag: string; profileSeed: number }
  | { kind: 'setLastShotType'; shot: ShotTypeSlug }
  /** Another device wrote (or cleared) the canonical profile server-side. */
  | {
      kind: 'serverSet';
      owner: 'A' | 'B';
      tag: string | null;
      profileSeed: number;
    }
  | { kind: 'fault'; target: FaultTarget; on: boolean }
  /** Release `n` pending deferred operations, chosen by `subSeed`. */
  | { kind: 'tick'; n: number; subSeed: number }
  /** Release every pending operation (and everything they spawn). */
  | { kind: 'drain'; subSeed: number };

export interface InitialState {
  /** Profile already stored under profile:<owner> before launch. */
  storedProfiles: Partial<Record<OwnerName, string>>;
  /** Legacy device-level `profile` kv from before owner scoping. */
  legacyProfileTag: string | null;
  stash: 'none' | 'valid' | 'malformed';
  serverProfiles: Partial<Record<'A' | 'B', string>>;
  launchOwner: OwnerName;
}

export type Mode = 'legal' | 'near-legal';

export interface Scenario {
  seed: number;
  mode: Mode;
  initial: InitialState;
  actions: Action[];
}

// ─── Deferred scheduler ──────────────────────────────────────────────────────

interface Op {
  id: number;
  label: string;
  call: CallRecord | null;
  resolve: () => void;
}

export interface CallRecord {
  id: number;
  kind: 'hydrate' | 'completeOnboarding' | 'completePreAuth';
  owner: string;
  faults: number;
  done: boolean;
  rejected: string | null;
  result: unknown;
  startedAt: number;
  finishedAt: number | null;
  /** Active data owner when the call settled (owner checks in the store
   * compare against this, not against the owner at call time). */
  ownerAtFinish: string | null;
}

function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// ─── World ───────────────────────────────────────────────────────────────────

export interface KvWrite {
  key: string;
  value: string;
  callId: number | null;
  stashTagAtWrite: string | null;
  at: number;
}

export class World {
  /** The World the store's mocked seams resolve to (newest constructed). */
  static current: World | null = null;

  constructor() {
    World.current = this;
  }

  readonly kv = new Map<string, string>();
  readonly server = new Map<string, Profile | null>();
  readonly faults: Record<FaultTarget, boolean> = {
    dbRead: false,
    dbWrite: false,
    dbOpen: false,
    netFetch: false,
    netSave: false,
  };
  readonly pending: Op[] = [];
  readonly calls: CallRecord[] = [];
  readonly kvWrites: KvWrite[] = [];
  readonly trace: string[] = [];
  /** Every value ever stored under profile:<owner> (seed + writes). */
  readonly profileHistory = new Map<string, Set<string>>();
  /** stash tag → owners whose profile:<owner> received that stash while it
   * was still the live stash. */
  readonly adoptions = new Map<string, Set<string>>();
  /** Tags durably written to the pending key, in write order. */
  readonly stashTagsWritten: string[] = [];
  readonly expectedRejections = new Set<number>();
  /** Stash tags whose adoption write (profile:<owner> ← stash) threw. */
  readonly adoptionWriteFaults = new Set<string>();
  /** Number of `pending ← ''` (stash clear) writes that threw. */
  stashClearFaults = 0;
  currentCall: CallRecord | null = null;
  /** Logical clock: advanced on call start/finish and every kv write. */
  clock = 0;
  private nextOpId = 0;
  private nextCallId = 0;

  // ── seams ──

  getDb(): LocalDb {
    if (this.faults.dbOpen) {
      this.note('db:open:THROW');
      if (this.currentCall) this.currentCall.faults += 1;
      throw new Error('SQLITE_CANTOPEN (simulated)');
    }
    return {
      execute: async (sql: string, params: unknown[] = []) => {
        const statement = sql.trim().replace(/\s+/g, ' ');
        const key = String(params[0]);
        if (statement.startsWith('SELECT value FROM kv')) {
          const willThrow = this.faults.dbRead;
          await this.defer(`db:get:${short(key)}${willThrow ? ':THROW' : ''}`);
          if (willThrow) throw new Error('SQLITE_IOERR (simulated read)');
          const value = this.kv.get(key);
          return { rows: value === undefined ? [] : [{ value }] };
        }
        if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
          const willThrow = this.faults.dbWrite;
          const value = String(params[1]);
          await this.defer(
            `db:set:${short(key)}=${short(tagOf(safeParse(value)) ?? value)}${
              willThrow ? ':THROW' : ''
            }`,
          );
          if (willThrow) {
            const tag = tagOf(safeParse(value));
            // A hydrate writing a stash tag to profile:<owner> is the
            // adoption write (the stash it READ, which may since have been
            // superseded by a newer pre-auth save).
            if (
              key.startsWith('profile:') &&
              tag &&
              this.stashTagsWritten.includes(tag) &&
              this.currentCall?.kind === 'hydrate'
            ) {
              this.adoptionWriteFaults.add(tag);
            }
            if (key === PENDING_ONBOARDING_PROFILE_KV_KEY && value === '') {
              this.stashClearFaults += 1;
            }
            throw new Error('SQLITE_IOERR (simulated write)');
          }
          this.applyKvWrite(key, value);
          return { rows: [] };
        }
        await this.defer(`db:other:${statement.slice(0, 24)}`);
        return { rows: [] };
      },
      close: () => {},
    };
  }

  async fetchCanonical(session: ApiSession): Promise<Profile | null> {
    const owner = session.canonicalAppUserId.toLowerCase();
    const willThrow = this.faults.netFetch;
    await this.defer(
      `net:fetch:${ownerNameOf(owner)}${willThrow ? ':THROW' : ''}`,
    );
    if (willThrow) throw new Error('Network request failed (simulated)');
    return this.server.get(owner) ?? null;
  }

  async saveCanonical(session: ApiSession, profile: Profile): Promise<Profile> {
    const owner = session.canonicalAppUserId.toLowerCase();
    const willThrow = this.faults.netSave;
    await this.defer(
      `net:save:${ownerNameOf(owner)}:${short(profile.biggestProblem)}${
        willThrow ? ':THROW' : ''
      }`,
    );
    if (willThrow) throw new Error('503 (simulated)');
    const stored: Profile = { ...profile, focusCheckpoint: SERVER_FOCUS };
    this.server.set(owner, stored);
    // Accepted by the account's canonical endpoint ⇒ it is that owner's.
    this.remember(owner, JSON.stringify(stored));
    return stored;
  }

  // ── scheduler ──

  private defer(label: string): Promise<void> {
    return new Promise<void>(resolve => {
      this.pending.push({
        id: this.nextOpId++,
        label,
        call: this.currentCall,
        resolve,
      });
    });
  }

  async releaseOne(rng: () => number): Promise<boolean> {
    if (this.pending.length === 0) return false;
    const index = Math.min(
      Math.floor(rng() * this.pending.length),
      this.pending.length - 1,
    );
    const [op] = this.pending.splice(index, 1);
    if (!op) return false;
    if (op.label.includes(':THROW') && op.call) op.call.faults += 1;
    this.note(`  release ${op.label} (call#${op.call?.id ?? '-'})`);
    this.currentCall = op.call;
    op.resolve();
    await flushMicrotasks();
    this.currentCall = null;
    return true;
  }

  async drain(rng: () => number): Promise<void> {
    let guard = 0;
    while (await this.releaseOne(rng)) {
      guard += 1;
      if (guard > 10_000) throw new Error('drain did not converge');
    }
  }

  get quiescent(): boolean {
    return this.pending.length === 0 && this.calls.every(call => call.done);
  }

  // ── bookkeeping ──

  private applyKvWrite(key: string, value: string): void {
    const stashTagAtWrite = this.liveStashTag();
    this.kv.set(key, value);
    this.kvWrites.push({
      key,
      value,
      callId: this.currentCall?.id ?? null,
      stashTagAtWrite,
      at: this.clock++,
    });
    if (key.startsWith('profile:')) {
      const owner = key.slice('profile:'.length);
      this.remember(owner, value);
      const tag = tagOf(safeParse(value));
      if (tag && tag === stashTagAtWrite) {
        const owners = this.adoptions.get(tag) ?? new Set<string>();
        owners.add(owner);
        this.adoptions.set(tag, owners);
      }
    }
    if (key === PENDING_ONBOARDING_PROFILE_KV_KEY && value !== '') {
      const tag = tagOf(
        (safeParse(value) as Record<string, unknown> | null)?.['profile'],
      );
      if (tag) this.stashTagsWritten.push(tag);
    }
  }

  remember(owner: string, value: string): void {
    const seen = this.profileHistory.get(owner) ?? new Set<string>();
    seen.add(value);
    this.profileHistory.set(owner, seen);
  }

  liveStashTag(): string | null {
    const raw = this.kv.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
    if (!raw) return null;
    const parsed = safeParse(raw) as Record<string, unknown> | null;
    return tagOf(parsed?.['profile']);
  }

  note(line: string): void {
    this.trace.push(line);
  }

  /** Runs a store call with call attribution: ops deferred during its
   * synchronous prefix, and during every later continuation, are tagged
   * with this record so faults can be charged to the call that saw them. */
  invoke(kind: CallRecord['kind'], fn: () => Promise<unknown>): CallRecord {
    const record: CallRecord = {
      id: this.nextCallId++,
      kind,
      owner: getActiveDataOwner(),
      faults: 0,
      done: false,
      rejected: null,
      result: undefined,
      startedAt: this.clock++,
      finishedAt: null,
      ownerAtFinish: null,
    };
    this.calls.push(record);
    this.currentCall = record;
    let promise: Promise<unknown>;
    try {
      promise = fn();
    } catch (error) {
      promise = Promise.reject(error);
    }
    this.currentCall = null;
    promise.then(
      value => {
        record.done = true;
        record.result = value;
        record.finishedAt = this.clock++;
        record.ownerAtFinish = getActiveDataOwner();
      },
      (error: unknown) => {
        record.done = true;
        record.rejected =
          error instanceof Error ? error.message : String(error);
        record.finishedAt = this.clock++;
        record.ownerAtFinish = getActiveDataOwner();
      },
    );
    return record;
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function short(text: string): string {
  return text.length > 28 ? `${text.slice(0, 25)}…` : text;
}

// ─── Store reset ─────────────────────────────────────────────────────────────

export function resetStore(): void {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
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

function sessionFor(name: 'A' | 'B'): ApiSession {
  return {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: `access-${name}`,
    canonicalAppUserId: ownerKeyOf(name),
    provider: 'apple',
    refreshToken: `refresh-${name}`,
    bearerExpiresAtMs: 4102444800000,
  };
}

// ─── Generator ───────────────────────────────────────────────────────────────

/**
 * Builds the initial device/server state and the FIRST action (launch) from
 * the seed. Subsequent actions are drawn during execution by
 * `nextAction()`, because "legal" preconditions depend on live store state.
 */
export function initialStateFor(seed: number, mode: Mode): Scenario {
  const rng = makePrng(seed ^ 0x9e3779b9);
  const storedProfiles: Partial<Record<OwnerName, string>> = {};
  for (const owner of ['guest', 'A', 'B'] as const) {
    if (rng() < 0.35) storedProfiles[owner] = `seed-${owner}-${seed}`;
  }
  const serverProfiles: Partial<Record<'A' | 'B', string>> = {};
  for (const owner of ['A', 'B'] as const) {
    if (rng() < 0.4) serverProfiles[owner] = `srv-${owner}-${seed}`;
  }
  const stashRoll = rng();
  return {
    seed,
    mode,
    initial: {
      storedProfiles,
      legacyProfileTag: rng() < 0.2 ? `legacy-${seed}` : null,
      stash:
        stashRoll < 0.45 ? 'valid' : stashRoll < 0.55 ? 'malformed' : 'none',
      serverProfiles,
      launchOwner: pick(rng, OWNER_NAMES),
    },
    actions: [],
  };
}

interface GenContext {
  rng: () => number;
  counter: number;
  mode: Mode;
  world: World;
}

function legalSwitchTargets(current: OwnerName): OwnerName[] {
  // authStore: sign-in starts from signed-out (no screen calls
  // continueAsGuest, so a guest owner only comes from a restored legacy
  // session at launch); signOut, account deletion and a refused refresh
  // always land on signed-out.
  return current === 'signed-out' ? ['A', 'B'] : ['signed-out'];
}

export function nextAction(ctx: GenContext): Action {
  const { rng, world } = ctx;
  const state = useAppStore.getState();
  const current = ownerNameOf(getActiveDataOwner());
  const currentName: OwnerName = current === 'unknown' ? 'signed-out' : current;
  const quiescent = world.quiescent;
  const nearLegal = ctx.mode === 'near-legal';
  const writable = currentName !== 'signed-out';
  const ready =
    quiescent && state.hydrated && state.ownerKey === getActiveDataOwner();

  const candidates: { weight: number; make: () => Action }[] = [];
  const add = (weight: number, make: () => Action) =>
    candidates.push({ weight, make });

  if (world.pending.length > 0) {
    add(30, () => ({
      kind: 'tick',
      n: 1 + Math.floor(rng() * 3),
      subSeed: Math.floor(rng() * 0xffffffff),
    }));
    add(10, () => ({ kind: 'drain', subSeed: Math.floor(rng() * 0xffffffff) }));
  }
  // Legal sign-in (signed-out → account) needs the SignIn screen, which the
  // Gate only shows once hydrated, and OnboardingScreen awaits
  // completePreAuthOnboarding() before navigating there — so a legal sign-in
  // never overlaps an in-flight store call. Sign-out may land any time (401).
  const preAuthInFlight = world.calls.some(
    call => call.kind === 'completePreAuth' && !call.done,
  );
  const legalSwitchOk =
    currentName === 'signed-out' ? ready && !preAuthInFlight : true;
  if (nearLegal || legalSwitchOk) {
    add(quiescent ? 14 : 8, () => ({
      kind: 'switch',
      to: pick(
        rng,
        nearLegal
          ? OWNER_NAMES.filter(name => name !== currentName)
          : legalSwitchTargets(currentName),
      ),
    }));
  }
  if (nearLegal || (ready && state.hydrateError !== null && !state.profile)) {
    add(nearLegal ? 6 : 12, () => ({ kind: 'rehydrate' }));
  }
  if (
    nearLegal ||
    (ready &&
      writable &&
      state.profile === null &&
      state.hydrateError === null &&
      !state.onboardingBusy)
  ) {
    add(nearLegal ? 8 : 16, () => ({
      kind: 'completeOnboarding',
      tag: `onb-${ctx.counter++}`,
      profileSeed: Math.floor(rng() * 0xffffffff),
    }));
  }
  if (nearLegal || (ready && currentName === 'signed-out')) {
    add(nearLegal ? 8 : 16, () => ({
      kind: 'completePreAuth',
      tag: `stash-${ctx.counter++}`,
      profileSeed: Math.floor(rng() * 0xffffffff),
    }));
  }
  add(4, () => ({ kind: 'setLastShotType', shot: pick(rng, SHOT_TYPES) }));
  add(5, () => {
    const owner = pick(rng, ['A', 'B'] as const);
    return {
      kind: 'serverSet',
      owner,
      tag: rng() < 0.25 ? null : `remote-${owner}-${ctx.counter++}`,
      profileSeed: Math.floor(rng() * 0xffffffff),
    };
  });
  add(10, () => {
    const target = pick(rng, [
      'dbRead',
      'dbWrite',
      'dbOpen',
      'netFetch',
      'netSave',
    ] as const);
    return { kind: 'fault', target, on: !world.faults[target] };
  });

  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  let roll = rng() * total;
  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll <= 0) return candidate.make();
  }
  const last = candidates[candidates.length - 1];
  if (!last) throw new Error('no candidate action');
  return last.make();
}

// ─── Executor ────────────────────────────────────────────────────────────────

export interface StepFailure {
  step: number;
  action: Action | 'epilogue' | 'init';
  invariants: string[];
  snapshot: Record<string, unknown>;
  /** Documented deviation(s) explaining every failed invariant, e.g.
   * 'D1' or 'D3+D4'; null when any failed invariant is unexplained. */
  known: string | null;
}

/**
 * Deviations the campaign reproduced and that are reported as findings
 * (stress report for unit mod-app-store). They stay listed here so the suite
 * keeps distinguishing them from NEW failures; matching is deliberately
 * narrow — anything else is unknown and fails the campaign.
 *
 *  D1 adoption-write-fault-leaks-into-memory  appStore.ts hydrate(): `raw`
 *     is reassigned to the adopted stash BEFORE `setKv(profile:<owner>)`; when
 *     that write throws the catch swallows it and the final `set()` installs
 *     the stash as the in-memory profile while the durable profile is the
 *     old one (contradicts "existing profile survives").
 *  D2 busy-stuck-after-owner-switch  completeOnboarding(): both the success
 *     and error paths skip `set()` once the owner changed, so
 *     `onboardingBusy` stays true; hydrate()'s error path does not reset it.
 *  D3 stale-hydrate-clobbers-newer-write  hydrate(): two hydrate() calls
 *     for the same owner (X→Y→X) or a completeOnboarding landing while a
 *     hydrate is in flight — the older hydrate passes the owner check and
 *     overwrites state with the values it read earlier (no generation token).
 *  D4 blind-stash-clear  hydrate(): the stash is cleared with a plain
 *     `setKv(PENDING, '')` after adoption, so a stash written between the
 *     read and the clear is dropped without ever being adopted.
 *  D6 stash-adopted-twice  hydrate(): the adoption branch re-checks the
 *     owner only BEFORE the (slow) canonical save; two hydrate() calls that
 *     both read the stash before either cleared it (X→Y→X, or a clear write
 *     that threw) each install it — the stash lands in two owners.
 */
export type KnownDeviation = 'D1' | 'D2' | 'D3' | 'D4' | 'D6';

export function classifyKnown(
  world: World,
  invariants: readonly string[],
): string | null {
  const names = [...new Set(invariants.map(name => name.replace(/\(.*$/, '')))];
  if (names.length === 0) return null;
  const state = useAppStore.getState();
  const active = getActiveDataOwner();
  const profileTag = tagOf(state.profile);

  const winner = [...world.calls]
    .filter(
      call => call.kind === 'hydrate' && call.owner === active && call.done,
    )
    .sort((a, b) => (b.finishedAt ?? -1) - (a.finishedAt ?? -1))[0];
  const newestStash = world.stashTagsWritten[world.stashTagsWritten.length - 1];
  const stashWroteAt = world.kvWrites.findIndex(
    write =>
      write.key === PENDING_ONBOARDING_PROFILE_KV_KEY &&
      tagOf(
        (safeParse(write.value) as Record<string, unknown> | null)?.['profile'],
      ) === newestStash,
  );
  const adopters = world.kvWrites
    .filter(
      write =>
        write.key.startsWith('profile:') &&
        write.stashTagAtWrite !== null &&
        tagOf(safeParse(write.value)) === write.stashTagAtWrite,
    )
    .map(write => world.calls.find(call => call.id === write.callId))
    .filter((call): call is CallRecord => call !== undefined);

  // Each deviation: the invariants it explains + the narrow condition that
  // must hold in the trace for it to apply.
  const deviations: {
    id: KnownDeviation;
    covers: string[];
    applies: () => boolean;
  }[] = [
    {
      id: 'D1',
      covers: ['stateMatchesKv', 'profileIsOwnersOwn'],
      applies: () =>
        profileTag !== null && world.adoptionWriteFaults.has(profileTag),
    },
    {
      id: 'D2',
      covers: ['notBusy'],
      applies: () =>
        world.calls.some(
          call =>
            call.kind === 'completeOnboarding' &&
            call.done &&
            call.ownerAtFinish !== call.owner,
        ),
    },
    {
      id: 'D3',
      covers: ['stateMatchesKv', 'profileIsOwnersOwn'],
      applies: () =>
        winner !== undefined &&
        world.kvWrites.some(
          write =>
            write.key === `profile:${active}` &&
            write.at > winner.startedAt &&
            write.callId !== winner.id,
        ),
    },
    {
      id: 'D4',
      covers: ['stashConserved'],
      applies: () =>
        newestStash !== undefined &&
        stashWroteAt >= 0 &&
        world.kvWrites.some(
          (write, index) =>
            index > stashWroteAt &&
            write.key === PENDING_ONBOARDING_PROFILE_KV_KEY &&
            write.value === '',
        ),
    },
    {
      id: 'D6',
      covers: ['stashSingleUse'],
      applies: () =>
        world.stashClearFaults > 0 ||
        adopters.some((a, i) =>
          adopters.some(
            (b, j) =>
              i !== j &&
              a.startedAt < (b.finishedAt ?? Number.POSITIVE_INFINITY) &&
              b.startedAt < (a.finishedAt ?? Number.POSITIVE_INFINITY),
          ),
        ),
    },
  ];

  const matched = new Set<KnownDeviation>();
  for (const name of names) {
    const deviation = deviations.find(
      candidate => candidate.covers.includes(name) && candidate.applies(),
    );
    if (!deviation) return null;
    matched.add(deviation.id);
  }
  return [...matched].sort().join('+');
}

export interface RunResult {
  seed: number;
  mode: Mode;
  actions: Action[];
  initial: InitialState;
  /** Planned sequence length (5–60). */
  length: number;
  /** Actions actually applied (shorter when a step broke an invariant). */
  executedLength: number;
  outcome: 'HELD' | 'BROKEN';
  failure: StepFailure | null;
  traceHash: string;
  trace: string[];
  opsReleased: number;
  calls: number;
  durationMs: number;
}

function describe(action: Action): string {
  switch (action.kind) {
    case 'switch':
      return `switch → ${action.to}`;
    case 'rehydrate':
      return 'rehydrate';
    case 'completeOnboarding':
      return `completeOnboarding(${action.tag})`;
    case 'completePreAuth':
      return `completePreAuth(${action.tag})`;
    case 'setLastShotType':
      return `setLastShotType(${action.shot})`;
    case 'serverSet':
      return `serverSet(${action.owner}, ${action.tag ?? 'null'})`;
    case 'fault':
      return `fault ${action.target}=${action.on ? 'on' : 'off'}`;
    case 'tick':
      return `tick ×${action.n} [${action.subSeed}]`;
    case 'drain':
      return `drain [${action.subSeed}]`;
  }
}

export function applyInitial(world: World, initial: InitialState): void {
  const rng = makePrng(0x51ed);
  for (const [owner, tag] of Object.entries(initial.storedProfiles)) {
    if (!tag) continue;
    const key = `profile:${ownerKeyOf(owner as OwnerName)}`;
    const value = JSON.stringify(makeProfile(tag, rng));
    world.kv.set(key, value);
    world.remember(ownerKeyOf(owner as OwnerName), value);
  }
  if (initial.legacyProfileTag) {
    const value = JSON.stringify(makeProfile(initial.legacyProfileTag, rng));
    world.kv.set('profile', value);
    // A migrated legacy profile is legitimately the guest's.
    world.remember(GUEST_DATA_OWNER, value);
  }
  if (initial.stash === 'valid') {
    const profile = makeProfile('stash-seed', rng);
    world.kv.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile }),
    );
    world.stashTagsWritten.push('stash-seed');
  } else if (initial.stash === 'malformed') {
    world.kv.set(PENDING_ONBOARDING_PROFILE_KV_KEY, '{"version":1}');
  }
  for (const [owner, tag] of Object.entries(initial.serverProfiles)) {
    if (!tag) continue;
    world.server.set(ownerKeyOf(owner as 'A' | 'B'), {
      ...makeProfile(tag, rng),
      focusCheckpoint: SERVER_FOCUS,
    });
  }
}

export async function applyAction(world: World, action: Action): Promise<void> {
  world.note(describe(action));
  switch (action.kind) {
    case 'switch': {
      // Mirrors authStore: signOut clears the ApiSession first, then moves
      // the owner; installApiSession sets the owner, then the session. The
      // Gate's effect hydrates on the owner change.
      if (isCanonical(action.to)) {
        setActiveDataOwner(ownerKeyOf(action.to));
        establishApiSession(sessionFor(action.to));
      } else {
        clearApiSession();
        setActiveDataOwner(ownerKeyOf(action.to));
      }
      world.invoke('hydrate', () => useAppStore.getState().hydrate());
      return;
    }
    case 'rehydrate':
      world.invoke('hydrate', () => useAppStore.getState().hydrate());
      return;
    case 'completeOnboarding': {
      const profile = makeProfile(action.tag, makePrng(action.profileSeed));
      const record = world.invoke('completeOnboarding', () =>
        useAppStore.getState().completeOnboarding(profile),
      );
      if (record.owner === SIGNED_OUT_DATA_OWNER) {
        world.expectedRejections.add(record.id);
      }
      return;
    }
    case 'completePreAuth': {
      const profile = makeProfile(action.tag, makePrng(action.profileSeed));
      world.invoke('completePreAuth', () =>
        useAppStore.getState().completePreAuthOnboarding(profile),
      );
      return;
    }
    case 'setLastShotType':
      useAppStore.getState().setLastShotType(action.shot);
      return;
    case 'serverSet':
      world.server.set(
        ownerKeyOf(action.owner),
        action.tag
          ? {
              ...makeProfile(action.tag, makePrng(action.profileSeed)),
              focusCheckpoint: SERVER_FOCUS,
            }
          : null,
      );
      return;
    case 'fault':
      world.faults[action.target] = action.on;
      return;
    case 'tick': {
      const rng = makePrng(action.subSeed);
      for (let i = 0; i < action.n; i += 1) {
        if (!(await world.releaseOne(rng))) break;
      }
      return;
    }
    case 'drain':
      await world.drain(makePrng(action.subSeed));
      return;
  }
}

// ─── Invariants ──────────────────────────────────────────────────────────────

export function snapshot(world: World): Record<string, unknown> {
  const state = useAppStore.getState();
  return {
    activeOwner: ownerNameOf(getActiveDataOwner()),
    hydrated: state.hydrated,
    ownerKey: ownerNameOf(state.ownerKey),
    profileTag: tagOf(state.profile),
    profileFocus: state.profile?.focusCheckpoint ?? null,
    hydrateError: state.hydrateError,
    onboardingBusy: state.onboardingBusy,
    onboardingError: state.onboardingError,
    lastShotType: state.lastShotType,
    kv: Object.fromEntries(
      [...world.kv.entries()].map(([key, value]) => [
        key,
        tagOf(safeParse(value)) ??
          tagOf(
            (safeParse(value) as Record<string, unknown> | null)?.['profile'],
          ) ??
          (value === '' ? '' : value.slice(0, 40)),
      ]),
    ),
    pendingOps: world.pending.map(op => op.label),
    faults: Object.entries(world.faults)
      .filter(([, on]) => on)
      .map(([name]) => name),
  };
}

/**
 * ALWAYS (after every step, mid-flight included):
 *   noThrow             no public call rejected, except completeOnboarding
 *                       while signed out (requireWritableDataOwner throws)
 *   profileShapeSafe    state.profile is null or a Profile
 *   noSignedOutWrite    profile:signed-out is never written
 *   profileIsOwnersOwn  a non-null state.profile is a value that was stored
 *                       under profile:<state.ownerKey> (kv seed or write) —
 *                       never another owner's, never an unsaved value
 *   stashSingleUse      one stash is adopted into at most ONE owner
 *   stashNeverSignedOut (implied by noSignedOutWrite)
 * QUIESCENT (no pending ops, every call settled):
 *   hydratedForOwner    hydrated && ownerKey === active owner (every owner
 *                       change hydrates, so the Gate is never left waiting)
 *   stateMatchesKv      hydrateError === null ⇒ state.profile equals the
 *                       durable profile:<owner> (both null when absent)
 *   errorImpliesFault   the hydrate that produced the current state saw a
 *                       faulting op whenever hydrateError !== null
 *   stashConserved      the newest durably written stash is either still in
 *                       kv or was adopted into some owner
 *   notBusy             onboardingBusy === false
 */
export function checkInvariants(world: World): string[] {
  const failed: string[] = [];
  const state = useAppStore.getState();
  const active = getActiveDataOwner();

  for (const call of world.calls) {
    if (
      call.done &&
      call.rejected !== null &&
      !world.expectedRejections.has(call.id)
    ) {
      failed.push(`noThrow(${call.kind}#${call.id}: ${call.rejected})`);
    }
  }
  if (!isProfileShape(state.profile)) failed.push('profileShapeSafe');
  if (
    world.kvWrites.some(
      write => write.key === `profile:${SIGNED_OUT_DATA_OWNER}`,
    )
  ) {
    failed.push('noSignedOutWrite');
  }
  if (state.profile !== null) {
    const owner = state.ownerKey ?? '';
    const history = world.profileHistory.get(owner);
    if (!history || !history.has(JSON.stringify(state.profile))) {
      failed.push('profileIsOwnersOwn');
    }
  }
  for (const [tag, owners] of world.adoptions) {
    if (owners.size > 1)
      failed.push(
        `stashSingleUse(${tag}→${[...owners].map(o => ownerNameOf(o)).join(',')})`,
      );
  }

  if (world.quiescent) {
    if (!(state.hydrated && state.ownerKey === active)) {
      failed.push('hydratedForOwner');
    }
    if (state.hydrateError === null) {
      const durable = world.kv.get(`profile:${active}`) ?? '';
      const inMemory =
        state.profile === null ? '' : JSON.stringify(state.profile);
      if (durable !== inMemory) failed.push('stateMatchesKv');
    } else {
      const winner = [...world.calls]
        .filter(
          call => call.kind === 'hydrate' && call.owner === active && call.done,
        )
        .sort((a, b) => (b.finishedAt ?? -1) - (a.finishedAt ?? -1))[0];
      if (winner && winner.faults === 0) failed.push('errorImpliesFault');
    }
    const newest = world.stashTagsWritten[world.stashTagsWritten.length - 1];
    if (newest) {
      const live = world.liveStashTag();
      const adopted = (world.adoptions.get(newest)?.size ?? 0) > 0;
      if (live !== newest && !adopted) failed.push(`stashConserved(${newest})`);
    }
    if (state.onboardingBusy) failed.push('notBusy');
  }
  return failed;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export function hashTrace(lines: readonly string[]): string {
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

export interface RunOptions {
  minLength?: number;
  maxLength?: number;
  /** Replay exactly these actions instead of generating from the seed. */
  actions?: Action[];
  /** Skip the epilogue (used while minimizing a mid-sequence failure). */
  epilogue?: boolean;
}

/** One sequence: generated from `seed` (or replayed), invariants after every
 * step, then the recoverability epilogue (faults off, drain, hydrate, drain). */
export async function runSequence(
  seed: number,
  mode: Mode,
  options: RunOptions = {},
): Promise<RunResult> {
  const started = Date.now();
  const scenario = initialStateFor(seed, mode);
  const world = new World();
  resetStore();
  applyInitial(world, scenario.initial);
  world.note(`init ${JSON.stringify(scenario.initial)}`);

  const rng = makePrng(seed);
  const minLength = options.minLength ?? 5;
  const maxLength = options.maxLength ?? 60;
  const length =
    options.actions?.length ??
    minLength + Math.floor(rng() * (maxLength - minLength + 1));
  const ctx: GenContext = { rng, counter: 0, mode, world };
  const actions: Action[] = [];
  const outcome: { failure: StepFailure | null } = { failure: null };

  const check = (step: number, action: StepFailure['action']) => {
    const failedNow = checkInvariants(world);
    world.note(`  state ${JSON.stringify(snapshot(world))}`);
    if (failedNow.length > 0 && outcome.failure === null) {
      outcome.failure = {
        step,
        action,
        invariants: failedNow,
        snapshot: snapshot(world),
        known: classifyKnown(world, failedNow),
      };
    }
  };

  for (let step = 0; step < length; step += 1) {
    const action: Action =
      options.actions?.[step] ??
      (step === 0
        ? { kind: 'switch', to: scenario.initial.launchOwner }
        : nextAction(ctx));
    actions.push(action);
    await applyAction(world, action);
    check(step, action);
    if (outcome.failure) break;
  }

  if (!outcome.failure && options.epilogue !== false) {
    world.note('epilogue: faults off, drain, hydrate, drain');
    for (const target of Object.keys(world.faults) as FaultTarget[]) {
      world.faults[target] = false;
    }
    await world.drain(makePrng(seed ^ 0xe91));
    check(actions.length, 'epilogue');
    if (!outcome.failure) {
      world.invoke('hydrate', () => useAppStore.getState().hydrate());
      await world.drain(makePrng(seed ^ 0xe92));
      check(actions.length + 1, 'epilogue');
      if (!outcome.failure) {
        const state = useAppStore.getState();
        if (state.hydrateError !== null) {
          outcome.failure = {
            step: actions.length + 1,
            action: 'epilogue',
            invariants: ['recoverable'],
            snapshot: snapshot(world),
            known: null,
          };
        }
      }
    }
  }
  // Leave nothing in flight for the next sequence.
  await world.drain(makePrng(seed ^ 0xe93));
  const opsReleased = world.trace.filter(line =>
    line.startsWith('  release'),
  ).length;

  return {
    seed,
    mode,
    actions,
    initial: scenario.initial,
    length,
    executedLength: actions.length,
    outcome: outcome.failure ? 'BROKEN' : 'HELD',
    failure: outcome.failure,
    traceHash: hashTrace(world.trace),
    trace: world.trace,
    opsReleased,
    calls: world.calls.length,
    durationMs: Date.now() - started,
  };
}

/**
 * ddmin over the recorded action list: the smallest sub-list (preserving
 * order and the launch switch) that still fails with the SAME invariant set.
 */
export async function minimize(result: RunResult): Promise<RunResult> {
  if (!result.failure) return result;
  const target = [...result.failure.invariants].sort().join('|');
  const fails = async (actions: Action[]): Promise<RunResult | null> => {
    const replay = await runSequence(result.seed, result.mode, {
      actions,
      epilogue: result.failure?.action === 'epilogue',
    });
    if (!replay.failure) return null;
    return [...replay.failure.invariants].sort().join('|') === target
      ? replay
      : null;
  };
  let current = result.actions.slice(0, result.failure.step + 1);
  let best = result;
  let granularity = 2;
  while (current.length >= 2) {
    const chunk = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (candidate.length === 0) continue;
      const first = candidate[0];
      if (!first || first.kind !== 'switch') continue;
      const outcome = await fails(candidate);
      if (outcome) {
        current = candidate;
        best = outcome;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(granularity * 2, current.length);
    }
  }
  return best;
}
