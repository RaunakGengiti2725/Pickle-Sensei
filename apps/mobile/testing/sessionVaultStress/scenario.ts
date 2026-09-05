/**
 * Seeded scenario generator + oracle for the sessionVault concurrency
 * campaign. A scenario is a burst of vault API calls (save / load / clear)
 * with an initial Keychain state; the oracle folds the fake native's
 * completion log into the API-level invariants the vault must keep no matter
 * how the calls interleave.
 */
import type { PersistedSession } from '../../src/account/sessionVault';
import type { CompletedOp, Rng } from './fakeKeychain';

export type ApiKind = 'save' | 'load' | 'clear';

export interface ApiCall {
  index: number;
  kind: ApiKind;
  /** Which actor issues it (two actors share the one Keychain row). */
  actor: 'A' | 'B';
  /** Index into `sessions` for `save`. */
  sessionIndex?: number;
  /**
   * When set, the call is issued from the continuation of that earlier call
   * (call-during-call) instead of in the initial Promise.all burst.
   */
  afterCall?: number;
  /**
   * The caller abandons the promise (cancel-during-call): calls chained onto
   * it are issued right away instead of waiting for it, the way a caller
   * that raced the vault against a timeout moves on. The native call still
   * completes and the harness still records the eventual value.
   */
  abandoned: boolean;
}

export type InitialState =
  | { kind: 'empty' }
  | { kind: 'valid'; sessionIndex: number }
  | { kind: 'malformed'; password: string }
  | { kind: 'no-password' };

export interface Scenario {
  seed: number;
  sessions: PersistedSession[];
  initial: InitialState;
  calls: ApiCall[];
  faultRate: number;
  order: 'fifo' | 'random';
}

const MALFORMED_RECORDS: readonly string[] = [
  '',
  'null',
  '[]',
  '{}',
  '{"version":1,"provider":"apple"}',
  '{"version":2,"provider":"apple","canonicalAppUserId":"u","refreshToken":"r"}',
  '{"version":1,"provider":"facebook","canonicalAppUserId":"u","refreshToken":"r"}',
  '{"version":1,"provider":"apple","canonicalAppUserId":"","refreshToken":"r"}',
  '{"version":1,"provider":"apple","canonicalAppUserId":"u","refreshToken":""}',
  '{"version":1,"provider":"apple","canonicalAppUserId":7,"refreshToken":"r"}',
  '{"version":1,"provider":"apple","canonicalAppUserId":"u","refreshToken":["r"]}',
  '{"version":"1","provider":"apple","canonicalAppUserId":"u","refreshToken":"r"}',
  '{"version":1,"provider":"apple","canonicalAppUserId":"u","refreshToken":"r"', // truncated
  'not json at all',
  '\u0000\ufffd\ufffd',
  '"a bare string"',
  '42',
];

/** Stored bytes the fake native cannot decode: `get` omits `password`. */
export const UNDECODABLE_PASSWORD = '\u0000<not-utf8>\u0000';

/** The password stored in the row before the burst starts (null = empty). */
export function initialPassword(scenario: Scenario): string | null {
  const initial = scenario.initial;
  switch (initial.kind) {
    case 'empty':
      return null;
    case 'valid':
      return JSON.stringify(scenario.sessions[initial.sessionIndex]);
    case 'malformed':
      return initial.password;
    case 'no-password':
      return UNDECODABLE_PASSWORD;
  }
}

export function sessionFor(
  actor: 'A' | 'B',
  version: number,
): PersistedSession {
  return {
    version: 1,
    provider: actor === 'A' ? 'apple' : 'google',
    canonicalAppUserId: actor === 'A' ? 'user-a-0001' : 'user-b-0002',
    refreshToken: `rt-${actor}-v${version}-${'x'.repeat(24)}`,
    email: version % 2 === 0 ? `${actor.toLowerCase()}@example.com` : null,
    displayName: version % 3 === 0 ? null : `Player ${actor} v${version}`,
  };
}

export interface GeneratorOptions {
  order: 'fifo' | 'random';
  /** Upper bound on the injected native fault probability. */
  maxFaultRate: number;
}

export function generateScenario(
  seed: number,
  rng: Rng,
  options: GeneratorOptions,
): Scenario {
  // Two actors, each with up to 3 token generations (rotation).
  const sessions: PersistedSession[] = [];
  for (const actor of ['A', 'B'] as const) {
    for (let version = 1; version <= 3; version += 1) {
      sessions.push(sessionFor(actor, version));
    }
  }

  const initialRoll = rng.next();
  let initial: InitialState;
  if (initialRoll < 0.35) initial = { kind: 'empty' };
  else if (initialRoll < 0.7) {
    initial = { kind: 'valid', sessionIndex: rng.int(sessions.length) };
  } else if (initialRoll < 0.95) {
    initial = { kind: 'malformed', password: rng.pick(MALFORMED_RECORDS) };
  } else initial = { kind: 'no-password' };

  const callCount = 2 + rng.int(7); // 2..8 calls
  const calls: ApiCall[] = [];
  const pattern = rng.next();
  for (let index = 0; index < callCount; index += 1) {
    const actor: 'A' | 'B' = rng.chance(0.5) ? 'A' : 'B';
    let kind: ApiKind;
    if (pattern < 0.15) {
      // duplicate-call burst: everyone does the same thing
      kind =
        index === 0
          ? rng.pick(['save', 'load', 'clear'] as const)
          : calls[0]!.kind;
    } else {
      const roll = rng.next();
      kind = roll < 0.45 ? 'save' : roll < 0.8 ? 'load' : 'clear';
    }
    const call: ApiCall = { index, kind, actor, abandoned: rng.chance(0.15) };
    if (kind === 'save') {
      if (pattern < 0.15 && calls[0]?.sessionIndex !== undefined) {
        call.sessionIndex = calls[0].sessionIndex; // identical payload
      } else {
        const actorBase = actor === 'A' ? 0 : 3;
        call.sessionIndex = actorBase + rng.int(3);
      }
    }
    // call-during-call: chain onto an earlier call ~30% of the time
    if (index > 0 && rng.chance(0.3)) call.afterCall = rng.int(index);
    calls.push(call);
  }

  const faultRate =
    options.maxFaultRate > 0 && rng.chance(0.4)
      ? rng.next() * options.maxFaultRate
      : 0;
  return { seed, sessions, initial, calls, faultRate, order: options.order };
}

export interface CallOutcome {
  index: number;
  kind: ApiKind;
  /** Resolved value: boolean (save), PersistedSession|null (load), undefined (clear). */
  value: unknown;
  threw: boolean;
  /** False when the promise never settled by the end of the drain. */
  settled: boolean;
  /**
   * Id of the native call the vault issued synchronously for this API call
   * (set for save, get for load, reset for clear); null when it issued none.
   */
  nativeId: number | null;
}

export interface OracleInput {
  scenario: Scenario;
  /** Call indices in the order the vault API was actually invoked. */
  issueOrder: number[];
  outcomes: CallOutcome[];
  log: CompletedOp[];
  issuedNativeCalls: number;
  finalStore: {
    username: string;
    password: string;
    accessible?: string;
  } | null;
  storeSize: number;
  wallMs: number;
  wallBudgetMs: number;
  unhandledRejections: number;
}

export interface OracleVerdict {
  violated: string[];
  /**
   * Known, reported failure signature the violations match exactly, or null
   * for anything unclassified (which the campaign then fails on).
   */
  defectClass: 'discard-race' | null;
  observed: Record<string, unknown>;
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    r['version'] === 1 &&
    (r['provider'] === 'apple' || r['provider'] === 'google') &&
    typeof r['canonicalAppUserId'] === 'string' &&
    typeof r['refreshToken'] === 'string' &&
    (r['email'] === null || typeof r['email'] === 'string') &&
    (r['displayName'] === null || typeof r['displayName'] === 'string') &&
    Object.keys(r).length === 6
  );
}

/** What a stored password means to the vault's parser. */
function parses(password: string | undefined): boolean {
  if (password === undefined) return false;
  try {
    return isPersistedSession(JSON.parse(password));
  } catch {
    return false;
  }
}

interface Simulation {
  /** Final row under the IDEAL spec: a load's discard only removes the
   * (malformed) record it read. */
  ideal: string | null;
  /** Final row under the vault's ACTUAL unconditional-discard semantics. */
  blind: string | null;
  /** Set when `ideal !== blind`: a load-origin reset completed while the row
   * held a valid session written after the read. */
  discardRace: boolean;
}

/**
 * Replays the native completion log as a sequential store. Because the fake
 * completes one call at a time, completion order IS the linearization, for
 * FIFO and random scheduling alike — so this is the "no lost update" oracle
 * for both campaigns.
 */
function simulate(
  scenario: Scenario,
  log: CompletedOp[],
  clearResetIds: Set<number>,
  validPayloads: Set<string>,
): Simulation {
  let ideal = initialPassword(scenario);
  let blind = ideal;
  let discardRace = false;
  for (const op of log) {
    if (op.kind === 'set') {
      // iOS deletes before inserting: a failed set leaves the row empty.
      const next = op.outcome === 'ok' ? (op.password ?? '') : null;
      ideal = next;
      blind = next;
    } else if (op.kind === 'reset') {
      if (op.outcome !== 'ok') continue;
      if (clearResetIds.has(op.id)) {
        ideal = null;
        blind = null;
      } else {
        // load-origin discard
        blind = null;
        if (ideal !== null && validPayloads.has(ideal)) discardRace = true;
        else ideal = null;
      }
    }
  }
  return { ideal, blind, discardRace };
}

export function judge(input: OracleInput): OracleVerdict {
  const { scenario, issueOrder, outcomes, log, finalStore } = input;
  const violated: string[] = [];
  const validPayloads = new Set(
    scenario.sessions.map(session => JSON.stringify(session)),
  );
  const byId = new Map(log.map(op => [op.id, op] as const));

  // I0 every call was issued exactly once and every promise settled.
  if (
    issueOrder.length !== scenario.calls.length ||
    new Set(issueOrder).size !== scenario.calls.length
  ) {
    violated.push('I0.issue-order');
  }
  if (outcomes.some(o => !o.settled)) violated.push('I0.promise-never-settled');

  // I1 fail-soft: no vault call rejects, no unhandled rejection escapes.
  if (outcomes.some(o => o.threw)) violated.push('I1.fail-soft-no-throw');
  if (input.unhandledRejections > 0) violated.push('I1.unhandled-rejection');

  // I2 no torn/blended write: the row is either absent, the untouched
  // initial record, or exactly one issued session, under the right account
  // name and accessibility class.
  if (finalStore) {
    if (
      !validPayloads.has(finalStore.password) &&
      finalStore.password !== initialPassword(scenario)
    ) {
      violated.push('I2.torn-or-foreign-record');
    }
    if (finalStore.username !== 'session') violated.push('I2.account-name');
    if (finalStore.accessible !== 'AccessibleAfterFirstUnlockThisDeviceOnly') {
      violated.push('I2.accessibility-class');
    }
  }
  // I3 no duplicate rows: one Keychain item at most, one service only.
  if (input.storeSize > 1) violated.push('I3.duplicate-rows');
  if (log.some(op => op.service !== 'com.picklesensei.auth.session')) {
    violated.push('I3.foreign-service');
  }

  // I4 save result is truthful: true ⇔ its native set stored the payload.
  // I5 load result is truthful and never fabricated: a returned session is
  // exactly the record the native handed back, else null.
  const clearResetIds = new Set<number>();
  let malformedReads = 0;
  for (const outcome of outcomes) {
    const call = scenario.calls[outcome.index]!;
    const op =
      outcome.nativeId === null ? undefined : byId.get(outcome.nativeId);
    if (!op) {
      violated.push(`I6.${call.kind}-without-native-call`);
      continue;
    }
    if (call.kind === 'save') {
      if (op.kind !== 'set') violated.push('I6.save-issued-wrong-call');
      const stored = op.outcome === 'ok';
      if (outcome.settled && outcome.value !== stored) {
        violated.push('I4.save-result-untruthful');
      }
    } else if (call.kind === 'clear') {
      if (op.kind !== 'reset') violated.push('I6.clear-issued-wrong-call');
      clearResetIds.add(op.id);
      if (outcome.settled && outcome.value !== undefined) {
        violated.push('I4.clear-result');
      }
    } else {
      if (op.kind !== 'get') violated.push('I6.load-issued-wrong-call');
      let expected: PersistedSession | null = null;
      if (op.outcome === 'ok' && op.returned !== false) {
        if (typeof op.returned === 'string' && parses(op.returned)) {
          expected = JSON.parse(op.returned) as PersistedSession;
        } else {
          malformedReads += 1;
        }
      }
      if (!outcome.settled) continue;
      if (expected === null) {
        if (outcome.value !== null) violated.push('I5.load-fabricated-session');
      } else if (!isPersistedSession(outcome.value)) {
        violated.push('I5.load-dropped-valid-session');
      } else if (JSON.stringify(outcome.value) !== JSON.stringify(expected)) {
        violated.push('I5.load-mismatch');
      }
    }
  }

  // I6 exactly one native call per API call (+1 discard per malformed read):
  // no duplicate, leaked or dropped native traffic.
  if (input.issuedNativeCalls !== log.length) {
    violated.push('I6.native-calls-not-drained');
  }
  const sets = log.filter(op => op.kind === 'set').length;
  const gets = log.filter(op => op.kind === 'get').length;
  const resets = log.filter(op => op.kind === 'reset').length;
  const saveCalls = scenario.calls.filter(c => c.kind === 'save').length;
  const loadCalls = scenario.calls.filter(c => c.kind === 'load').length;
  const clearCalls = scenario.calls.filter(c => c.kind === 'clear').length;
  if (
    sets !== saveCalls ||
    gets !== loadCalls ||
    resets !== clearCalls + malformedReads
  ) {
    violated.push('I6.native-call-count');
  }

  // I7 no lost update: the row equals the sequential replay of the
  // completion log; a load's discard may only remove what it read.
  const sim = simulate(scenario, log, clearResetIds, validPayloads);
  const finalPassword = finalStore?.password ?? null;
  if (finalPassword !== sim.ideal) violated.push('I7.lost-update');

  // I8 bounded wall time / no deadlock.
  if (input.wallMs > input.wallBudgetMs) violated.push('I8.wall-time');

  // Known defect signature: the ONLY violation is I7, and the row is exactly
  // what the unconditional discard predicts.
  const defectClass: 'discard-race' | null =
    violated.length === 1 &&
    violated[0] === 'I7.lost-update' &&
    sim.discardRace &&
    finalPassword === sim.blind
      ? 'discard-race'
      : null;

  return {
    violated,
    defectClass,
    observed: {
      finalPassword,
      expectedFinalPassword: sim.ideal,
      blindDiscardFinalPassword: sim.blind,
      malformedReads,
      nativeIssued: input.issuedNativeCalls,
      nativeCompleted: log.length,
      completionOrder: log.map(op => `${op.id}:${op.kind}:${op.outcome}`),
      outcomes: outcomes.map(o => ({
        index: o.index,
        kind: o.kind,
        nativeId: o.nativeId,
        settled: o.settled,
        threw: o.threw,
        value:
          o.value && typeof o.value === 'object'
            ? (o.value as PersistedSession).refreshToken
            : o.value,
      })),
      wallMs: input.wallMs,
    },
  };
}
