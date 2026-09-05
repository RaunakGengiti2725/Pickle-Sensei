/**
 * Action vocabulary + seeded generator for the outbox drain stress campaign.
 *
 * A sequence is 5–60 legal / near-legal operations over the public surface
 * `drainOutbox()` sees: rows arriving in `outbox` (valid and poisoned
 * payloads, every kind, foreign owners, pre-spent attempt budgets), the active
 * data owner changing, and drains — sequential, overlapping on one connection,
 * or with a one-shot local-database fault — each with its own scripted server
 * behaviour (2xx acknowledgements, per-item rejections of both classes, 4xx /
 * 401 / 408 / 429 / 5xx, transport errors, malformed 2xx bodies).
 *
 * Everything is derived from the seed through mulberry32, so
 * `generateSequence(seed)` is the complete replay key.
 *
 * Test-only harness; never imported by production code.
 */
import { randomInt, seededRandom } from '../../xcBehavioral/evidence';

export const OWNER_A = '11111111-1111-4111-8111-111111111111';
export const OWNER_B = '22222222-2222-4222-8222-222222222222';
export const OWNER_GUEST = 'device-guest';
/** accountScope.SIGNED_OUT_DATA_OWNER — a drain in this state must be a no-op. */
export const OWNER_SIGNED_OUT = 'signed-out';
export const OWNERS = [
  OWNER_A,
  OWNER_B,
  OWNER_GUEST,
  OWNER_SIGNED_OUT,
] as const;
/** Owners repository.ts can actually write rows for (requireWritableDataOwner). */
export const WRITABLE_OWNERS = [OWNER_A, OWNER_B, OWNER_GUEST] as const;
export type Owner = (typeof OWNERS)[number];

export type ShotVariant =
  | 'valid'
  | 'valid_with_session'
  | 'orphan_session'
  | 'missing_permit'
  | 'blank_permit'
  | 'corrupt_json'
  | 'json_null'
  | 'json_string'
  | 'no_id'
  | 'no_checkpoints'
  | 'duplicate_id'
  | 'fixture_source';

export type SessionVariant = 'valid' | 'corrupt_json' | 'no_id';
export type TrialVariant =
  'valid' | 'corrupt_json' | 'json_null' | 'missing_trial_id';

export type EnqueueAction =
  | {
      type: 'enqueue';
      owner: 'active' | Owner;
      kind: 'shot.sync';
      variant: ShotVariant;
      attempts: number;
    }
  | {
      type: 'enqueue';
      owner: 'active' | Owner;
      kind: 'session.create' | 'session.finalize';
      variant: SessionVariant;
      attempts: number;
    }
  | {
      type: 'enqueue';
      owner: 'active' | Owner;
      kind: 'evaluation.trial';
      variant: TrialVariant;
      attempts: number;
    }
  | {
      type: 'enqueue';
      owner: 'active' | Owner;
      kind: 'unknown';
      variant: 'valid' | 'corrupt_json';
      attempts: number;
    };

/** HTTP statuses the transport can surface as `ApiError`. */
export const API_STATUSES = [
  400, 401, 403, 404, 408, 409, 410, 413, 422, 429, 500, 502, 503, 504,
] as const;

export type Thrown =
  | { throw: 'api'; status: number; code: string; message: string }
  | { throw: 'error'; message: string }
  | { throw: 'type_error'; message: string }
  | { throw: 'string'; value: string };

export type EndpointBehavior = { kind: 'ok' } | Thrown;

/** Server codes drainOutbox treats as contract verdicts (attempt consumed). */
export const PERMANENT_REJECTION_CODES = [
  'access.permit_not_reserved',
  'shot.invalid_payload',
  'shot.non_real_source',
  'shot.duplicate_permit',
  'access.free_limit_reached',
] as const;
/** Mirrors TRANSIENT_SYNC_REJECTION_CODES in src/data/sync.ts. */
export const TRANSIENT_REJECTION_CODES = [
  'shot.write_failed',
  'evaluation.trial_write_failed',
  'auth.required',
  'shot.session_not_found',
] as const;

export type Verdict = 'accept' | 'omit' | { reject: string };

export type MalformedShape =
  | 'empty_object'
  | 'null'
  | 'string_ids'
  | 'rejected_null'
  | 'foreign_ids'
  | 'dup_ids'
  | 'accept_and_reject';

export type BatchBehavior =
  | { kind: 'ok' }
  | { kind: 'verdicts'; verdicts: Verdict[] }
  | { kind: 'malformed'; shape: MalformedShape }
  | Thrown;

export interface DrainPolicy {
  /** Consumed one per createSession/finalizeSession call; the last repeats. */
  session: EndpointBehavior[];
  shots: BatchBehavior;
  trials: BatchBehavior | 'absent';
}

/** Statement needles a local-database fault can hit (see backends.ts). */
export const FAULT_NEEDLES = [
  'SELECT id, kind, payload',
  'BEGIN IMMEDIATE',
  'INSERT OR REPLACE INTO sync_receipt',
  'DELETE FROM outbox',
  'COMMIT',
  'UPDATE outbox SET attempts',
  'UPDATE outbox SET last_error',
  'SELECT count(*)',
] as const;
export type FaultNeedle = (typeof FAULT_NEEDLES)[number];

export type Action =
  | EnqueueAction
  /** Many rows at once for the active owner — drives the 50-row window. */
  | { type: 'enqueueBurst'; rows: EnqueueAction[] }
  | { type: 'drain'; policy: DrainPolicy }
  | { type: 'concurrentDrain'; policies: DrainPolicy[] }
  | {
      type: 'faultDrain';
      policy: DrainPolicy;
      fault: { needle: FaultNeedle; message: string };
    }
  | { type: 'switchOwner'; owner: Owner };

export interface Sequence {
  seed: number;
  actions: Action[];
}

export const MIN_LENGTH = 5;
export const MAX_LENGTH = 60;

type Rng = () => number;

function pick<T>(random: Rng, items: readonly T[]): T {
  const index = Math.floor(random() * items.length);
  const item = items[index];
  if (item === undefined) throw new Error('pick: empty list');
  return item;
}

function weighted<T extends string>(
  random: Rng,
  table: ReadonlyArray<readonly [T, number]>,
): T {
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [value, weight] of table) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return table[table.length - 1]![0];
}

function thrown(random: Rng): Thrown {
  const which = weighted(random, [
    ['api', 6],
    ['error', 2],
    ['type_error', 1],
    ['string', 1],
  ] as const);
  switch (which) {
    case 'api': {
      const status = pick(random, API_STATUSES);
      return {
        throw: 'api',
        status,
        code: `http.${status}`,
        message: `server said ${status}`,
      };
    }
    case 'error':
      return { throw: 'error', message: pick(random, ['offline', 'timeout']) };
    case 'type_error':
      return { throw: 'type_error', message: 'fetch is not a function' };
    case 'string':
      return { throw: 'string', value: 'boom' };
  }
}

function endpointBehavior(random: Rng): EndpointBehavior {
  return random() < 0.7 ? { kind: 'ok' } : thrown(random);
}

function verdict(random: Rng): Verdict {
  const which = weighted(random, [
    ['accept', 5],
    ['omit', 1],
    ['permanent', 2],
    ['transient', 2],
  ] as const);
  switch (which) {
    case 'accept':
      return 'accept';
    case 'omit':
      return 'omit';
    case 'permanent':
      return { reject: pick(random, PERMANENT_REJECTION_CODES) };
    case 'transient':
      return { reject: pick(random, TRANSIENT_REJECTION_CODES) };
  }
}

const MALFORMED_SHAPES: readonly MalformedShape[] = [
  'empty_object',
  'null',
  'string_ids',
  'rejected_null',
  'foreign_ids',
  'dup_ids',
  'accept_and_reject',
];

function batchBehavior(random: Rng): BatchBehavior {
  const which = weighted(random, [
    ['ok', 5],
    ['verdicts', 3],
    ['thrown', 3],
    ['malformed', 1],
  ] as const);
  switch (which) {
    case 'ok':
      return { kind: 'ok' };
    case 'verdicts': {
      const count = randomInt(random, 1, 4);
      const verdicts: Verdict[] = [];
      for (let i = 0; i < count; i += 1) verdicts.push(verdict(random));
      return { kind: 'verdicts', verdicts };
    }
    case 'thrown':
      return thrown(random);
    case 'malformed':
      return { kind: 'malformed', shape: pick(random, MALFORMED_SHAPES) };
  }
}

export function drainPolicy(random: Rng): DrainPolicy {
  const sessionCalls = randomInt(random, 1, 3);
  const session: EndpointBehavior[] = [];
  for (let i = 0; i < sessionCalls; i += 1)
    session.push(endpointBehavior(random));
  return {
    session,
    shots: batchBehavior(random),
    trials: random() < 0.15 ? 'absent' : batchBehavior(random),
  };
}

const SHOT_VARIANTS: ReadonlyArray<readonly [ShotVariant, number]> = [
  ['valid', 14],
  ['valid_with_session', 4],
  ['orphan_session', 2],
  ['missing_permit', 1],
  ['blank_permit', 1],
  ['corrupt_json', 1],
  ['json_null', 1],
  ['json_string', 1],
  ['no_id', 1],
  ['no_checkpoints', 1],
  ['duplicate_id', 2],
  ['fixture_source', 1],
];

function enqueue(random: Rng): EnqueueAction {
  const owner: 'active' | Owner =
    random() < 0.85 ? 'active' : pick(random, WRITABLE_OWNERS);
  const attempts = weighted(random, [
    ['fresh', 20],
    ['one_left', 2],
    ['dead', 2],
    ['overspent', 1],
  ] as const);
  const attemptsValue =
    attempts === 'fresh'
      ? 0
      : attempts === 'one_left'
        ? 7
        : attempts === 'dead'
          ? 8
          : randomInt(random, 9, 40);
  const kind = weighted(random, [
    ['shot.sync', 12],
    ['session.create', 3],
    ['session.finalize', 2],
    ['evaluation.trial', 3],
    ['unknown', 1],
  ] as const);
  switch (kind) {
    case 'shot.sync':
      return {
        type: 'enqueue',
        owner,
        kind,
        variant: weighted(random, SHOT_VARIANTS),
        attempts: attemptsValue,
      };
    case 'session.create':
    case 'session.finalize':
      return {
        type: 'enqueue',
        owner,
        kind,
        variant: weighted(random, [
          ['valid', 8],
          ['corrupt_json', 1],
          ['no_id', 1],
        ] as const),
        attempts: attemptsValue,
      };
    case 'evaluation.trial':
      return {
        type: 'enqueue',
        owner,
        kind,
        variant: weighted(random, [
          ['valid', 8],
          ['corrupt_json', 1],
          ['json_null', 1],
          ['missing_trial_id', 1],
        ] as const),
        attempts: attemptsValue,
      };
    case 'unknown':
      return {
        type: 'enqueue',
        owner,
        kind,
        variant: random() < 0.8 ? 'valid' : 'corrupt_json',
        attempts: attemptsValue,
      };
  }
}

export function generateAction(random: Rng): Action {
  const type = weighted(random, [
    ['enqueue', 42],
    ['enqueueBurst', 4],
    ['drain', 30],
    ['concurrentDrain', 8],
    ['faultDrain', 10],
    ['switchOwner', 6],
  ] as const);
  switch (type) {
    case 'enqueue':
      return enqueue(random);
    case 'enqueueBurst': {
      const count = randomInt(random, 10, 60);
      const rows: EnqueueAction[] = [];
      for (let i = 0; i < count; i += 1) {
        rows.push({ ...enqueue(random), owner: 'active' });
      }
      return { type, rows };
    }
    case 'drain':
      return { type, policy: drainPolicy(random) };
    case 'concurrentDrain': {
      const count = randomInt(random, 2, 3);
      const policies: DrainPolicy[] = [];
      for (let i = 0; i < count; i += 1) policies.push(drainPolicy(random));
      return { type, policies };
    }
    case 'faultDrain':
      return {
        type,
        policy: drainPolicy(random),
        fault: {
          needle: pick(random, FAULT_NEEDLES),
          message: `injected sqlite failure #${randomInt(random, 1, 999)}`,
        },
      };
    case 'switchOwner':
      return { type, owner: pick(random, OWNERS) };
  }
}

export function generateSequence(seed: number): Sequence {
  const random = seededRandom(seed);
  const length = randomInt(random, MIN_LENGTH, MAX_LENGTH);
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) actions.push(generateAction(random));
  return { seed, actions };
}

/** Deterministic UUID-shaped id from the seed stream (v4 layout, valid per
 * accountScope's UUID_PATTERN so it can double as an owner-like key). */
export function uuidFrom(random: Rng): string {
  const hex = (count: number) => {
    let out = '';
    for (let i = 0; i < count; i += 1)
      out += Math.floor(random() * 16).toString(16);
    return out;
  };
  const variant = '89ab'[Math.floor(random() * 4)]!;
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

/** Whether a policy can, for a locally valid row, consume an attempt. */
export function behaviorMayConsumeAttempt(behavior: BatchBehavior): boolean {
  if ('throw' in behavior) {
    return (
      behavior.throw === 'api' &&
      behavior.status >= 400 &&
      behavior.status < 500 &&
      behavior.status !== 401 &&
      behavior.status !== 408 &&
      behavior.status !== 429
    );
  }
  switch (behavior.kind) {
    case 'ok':
      return false;
    case 'verdicts':
      return behavior.verdicts.some(
        v =>
          v === 'omit' ||
          (typeof v === 'object' &&
            !(TRANSIENT_REJECTION_CODES as readonly string[]).includes(
              v.reject,
            )),
      );
    case 'malformed':
      return (
        behavior.shape === 'string_ids' ||
        behavior.shape === 'foreign_ids' ||
        behavior.shape === 'accept_and_reject'
      );
  }
}

export function endpointMayConsumeAttempt(behavior: EndpointBehavior): boolean {
  return 'throw' in behavior && behaviorMayConsumeAttempt(behavior);
}
