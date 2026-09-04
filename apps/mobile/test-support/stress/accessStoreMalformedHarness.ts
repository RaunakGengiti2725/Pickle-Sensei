/**
 * Boundary / malformed-input stress model for `src/state/accessStore.ts`.
 *
 * The store is driven through its public surface only (configureAccessStore,
 * clearAccessStoreConfiguration, useAccessStore.getState().<op>, the three
 * selectors). Everything the store consumes from the outside world — the
 * `BillingAccessDependencies` object, every resolved value and every
 * rejection reason of its six methods, and the `selectPeriod` argument — is
 * generated from a seeded RNG so any iteration replays from its seed.
 *
 * Invariants (the store's own typed contract, checked after EVERY operation):
 *   op-no-throw          no store method throws / rejects
 *   op-returns-boolean   Promise<boolean> methods resolve to a strict boolean
 *   selectors-boolean    selectHasPremium / selectCanStartRating /
 *                        selectPaywallRequired return strict booleans
 *   enum-fields          status / operation / selectedPeriod stay in-enum
 *   error-shape          error is null or {code∈BillingErrorCode, message:string,
 *                        retryable:boolean}
 *   settled-idle         once every started call settled: operation==='idle'
 *                        and status!=='loading' (nothing is stuck)
 *   no-prototype-pollution
 *   fail-closed-after-clear   after clearAccessStoreConfiguration the state is
 *                        the defaults and stays so when a stale call settles
 *   canonical-provenance canonicalAccess is null or reference-equal to a value
 *                        the CURRENT configuration's backend actually resolved
 *   purchase-arg-string  store.purchase is only ever called with a string id
 *   sync-after-store-ok  backend.syncBilling is only called after the store
 *                        step of purchase/restore resolved
 *   latest-refresh-wins  when two refreshes of one configuration both resolve,
 *                        the snapshot of the later-ISSUED call is what remains
 */
import {
  BillingError,
  type BillingAccessDependencies,
  type BillingErrorCode,
  type CanonicalAccessState,
  type StorePlans,
} from '../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectCanStartRating,
  selectHasPremium,
  selectPaywallRequired,
  useAccessStore,
  type AccessStoreState,
} from '../../src/state/accessStore';

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — every iteration is a pure function of its seed.
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined && items.length === 0) {
      throw new Error('pick from empty list');
    }
    return item as T;
  }
}

/** Deterministic per-iteration seed derived from the campaign seed. */
export function iterationSeed(campaignSeed: number, index: number): number {
  // Finalize the campaign seed first so that two nearby campaign seeds do
  // not share iteration seeds at shifted indices.
  let h = (campaignSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h ^ Math.imul(index + 1, 0x9e3779b1), 0x27d4eb2f) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x165667b1) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// Malformed value generators
// ---------------------------------------------------------------------------

export type ValueTag =
  | 'null'
  | 'undefined'
  | 'boolean'
  | 'number-edge'
  | 'string-edge'
  | 'string-huge'
  | 'string-unicode'
  | 'string-traversal'
  | 'string-proto-key'
  | 'string-json-fragment'
  | 'array'
  | 'object-empty'
  | 'object-proto'
  | 'object-future-schema'
  | 'bigint'
  | 'nested';

const NUMBER_EDGES: readonly number[] = [
  0,
  -0,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MAX_SAFE_INTEGER + 2,
  -1,
  3,
  2.5,
  1e308,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  5e-324,
  2 ** 31,
  -(2 ** 31),
  2 ** 32,
  0.1 + 0.2,
];

const STRING_EDGES: readonly string[] = [
  '',
  ' ',
  '2',
  '-0',
  'NaN',
  'true',
  'false',
  'null',
  'undefined',
  '\u0000',
  'a\u0000b',
  '\u0000'.repeat(64),
  '\n\r\t',
  'annual',
  'premium',
];

const TRAVERSAL_STRINGS: readonly string[] = [
  '../../etc/passwd',
  '..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2f',
  '/v1/me/access/../../admin',
  'file:///etc/passwd',
  '\u2025\u2025/',
  'C:\\..\\..\\',
  'plan/../../lifetime',
];

const PROTO_KEYS: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '__defineGetter__',
];

const JSON_FRAGMENTS: readonly string[] = [
  '{"premium":',
  '{"premium":true,"entitlements":["premium"],',
  '[',
  ']',
  '{"__proto__":{"polluted":1}}',
  '"',
  '{"a":1}}',
  '\ufeff{"premium":true}',
  '{"premium":tru',
];

const UNICODE_STRINGS: readonly string[] = [
  '\u00e9',
  'e\u0301',
  '\u00c5',
  'A\u030a',
  '\u212b',
  '\ufb01',
  '\ud83d\ude00',
  '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66',
  '\u202e\u0644\u0627\u0644\u0647\u202c',
  '\u200b\u200c\u200d\ufeff',
  '\ud800',
  '\udfff',
  '\ud83d',
  'a\u0301'.repeat(2048),
  '\ud83c\udff4\udb40\udc67\udb40\udc62\udb40\udc65\udb40\udc6e\udb40\udc67\udb40\udc7f',
];

function hugeString(rng: Rng): string {
  const kind = rng.int(4);
  const length = 65536 + rng.int(4096);
  if (kind === 0) return 'A'.repeat(length);
  if (kind === 1) return '\ud83d\ude00'.repeat(Math.ceil(length / 2));
  if (kind === 2) return 'e\u0301'.repeat(Math.ceil(length / 2));
  return '\u0000'.repeat(length);
}

function protoObject(rng: Rng): Record<string, unknown> {
  const kind = rng.int(4);
  if (kind === 0) {
    return JSON.parse('{"__proto__":{"polluted":"yes"}}') as Record<
      string,
      unknown
    >;
  }
  if (kind === 1) {
    return JSON.parse(
      '{"constructor":{"prototype":{"polluted":"yes"}}}',
    ) as Record<string, unknown>;
  }
  if (kind === 2) {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, '__proto__', {
      value: { polluted: 'yes' },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return value;
  }
  return { ['__proto__']: null, polluted: 'yes' };
}

export function malformedValue(
  rng: Rng,
  depth = 0,
): { tag: ValueTag; value: unknown } {
  const tags: readonly ValueTag[] = [
    'null',
    'undefined',
    'boolean',
    'number-edge',
    'string-edge',
    'string-huge',
    'string-unicode',
    'string-traversal',
    'string-proto-key',
    'string-json-fragment',
    'array',
    'object-empty',
    'object-proto',
    'object-future-schema',
    'bigint',
    'nested',
  ];
  let tag = rng.pick(tags);
  if (depth >= 2 && (tag === 'nested' || tag === 'array')) tag = 'null';
  switch (tag) {
    case 'null':
      return { tag, value: null };
    case 'undefined':
      return { tag, value: undefined };
    case 'boolean':
      return { tag, value: rng.chance(0.5) };
    case 'number-edge':
      return { tag, value: rng.pick(NUMBER_EDGES) };
    case 'string-edge':
      return { tag, value: rng.pick(STRING_EDGES) };
    case 'string-huge':
      return { tag, value: hugeString(rng) };
    case 'string-unicode':
      return { tag, value: rng.pick(UNICODE_STRINGS) };
    case 'string-traversal':
      return { tag, value: rng.pick(TRAVERSAL_STRINGS) };
    case 'string-proto-key':
      return { tag, value: rng.pick(PROTO_KEYS) };
    case 'string-json-fragment':
      return { tag, value: rng.pick(JSON_FRAGMENTS) };
    case 'array': {
      const length = rng.int(4);
      const items: unknown[] = [];
      for (let i = 0; i < length; i++) {
        items.push(malformedValue(rng, depth + 1).value);
      }
      return { tag, value: items };
    }
    case 'object-empty':
      return { tag, value: {} };
    case 'object-proto':
      return { tag, value: protoObject(rng) };
    case 'object-future-schema':
      return {
        tag,
        value: {
          schemaVersion: 2 + rng.int(98),
          premium: rng.chance(0.5),
          v2: { access: { premium: true } },
        },
      };
    case 'bigint':
      return { tag, value: BigInt(rng.int(1 << 30)) };
    case 'nested': {
      const value: Record<string, unknown> = {};
      const keys = 1 + rng.int(3);
      for (let i = 0; i < keys; i++) {
        const key = rng.chance(0.3) ? rng.pick(PROTO_KEYS) : `k${i}`;
        value[key] = malformedValue(rng, depth + 1).value;
      }
      return { tag, value };
    }
  }
}

// ---------------------------------------------------------------------------
// Valid fixtures and structured mutators
// ---------------------------------------------------------------------------

export function validAccess(rng: Rng): CanonicalAccessState {
  const premium = rng.chance(0.3);
  const used = rng.int(3);
  const remaining = 2 - used;
  const reserved = rng.int(remaining + 1);
  const availableToReserve = remaining - reserved;
  const canStartRating = premium || availableToReserve > 0;
  return {
    premium,
    entitlements: premium ? ['premium'] : [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

export function validPlans(rng: Rng): StorePlans {
  const plan = (period: 'annual' | 'monthly' | 'lifetime', price: number) => ({
    id: `${period}-plan`,
    productId: `pickle_sensei_pro_${period}`,
    period,
    price,
    priceString: `$${price.toFixed(2)}`,
    pricePerMonthString: period === 'lifetime' ? null : '$4.99',
    freeTrial: null,
  });
  return {
    offeringId: 'default',
    annual: rng.chance(0.85) ? plan('annual', 59.99) : null,
    monthly: rng.chance(0.85) ? plan('monthly', 7.99) : null,
    lifetime: rng.chance(0.85) ? plan('lifetime', 159.99) : null,
  };
}

export type MutationOp =
  | 'replace-field'
  | 'delete-field'
  | 'add-proto-key'
  | 'add-future-schema'
  | 'whole-value'
  | 'numeric-boundary'
  | 'huge-string-field'
  | 'entitlements-shape';

export interface Mutation {
  op: MutationOp;
  path?: string;
  tag?: ValueTag;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** All own dotted paths (depth ≤ 2) of a plain object. */
function paths(value: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(value)) {
    out.push(key);
    const child = value[key];
    if (isPlainObject(child)) {
      for (const inner of Object.keys(child)) out.push(`${key}.${inner}`);
    }
  }
  return out;
}

function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const [head, tail] = path.split('.');
  if (head === undefined) return;
  if (tail === undefined) {
    target[head] = value;
    return;
  }
  const child = target[head];
  if (isPlainObject(child)) child[tail] = value;
}

function deletePath(target: Record<string, unknown>, path: string): void {
  const [head, tail] = path.split('.');
  if (head === undefined) return;
  if (tail === undefined) {
    delete target[head];
    return;
  }
  const child = target[head];
  if (isPlainObject(child)) delete child[tail];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Applies 1–3 random structural mutations to a valid fixture. Returns the
 * (possibly no-longer-an-object) value and the mutation log for the report.
 */
export function mutate<T extends object>(
  rng: Rng,
  fixture: T,
): { value: unknown; mutations: Mutation[] } {
  const mutations: Mutation[] = [];
  let value: unknown = clone(fixture);
  const count = 1 + rng.int(3);
  for (let i = 0; i < count; i++) {
    if (!isPlainObject(value)) break;
    const op = rng.pick<MutationOp>([
      'replace-field',
      'replace-field',
      'delete-field',
      'add-proto-key',
      'add-future-schema',
      'whole-value',
      'numeric-boundary',
      'huge-string-field',
      'entitlements-shape',
    ]);
    switch (op) {
      case 'replace-field': {
        const available = paths(value);
        if (available.length === 0) break;
        const path = rng.pick(available);
        const generated = malformedValue(rng);
        setPath(value, path, generated.value);
        mutations.push({ op, path, tag: generated.tag });
        break;
      }
      case 'delete-field': {
        const available = paths(value);
        if (available.length === 0) break;
        const path = rng.pick(available);
        deletePath(value, path);
        mutations.push({ op, path });
        break;
      }
      case 'add-proto-key': {
        const key = rng.pick(PROTO_KEYS);
        if (key === '__proto__') {
          Object.defineProperty(value, '__proto__', {
            value: { polluted: 'yes' },
            enumerable: true,
            configurable: true,
            writable: true,
          });
        } else {
          value[key] = { polluted: 'yes' };
        }
        mutations.push({ op, path: key });
        break;
      }
      case 'add-future-schema': {
        value.schemaVersion = 2 + rng.int(98);
        value.v2 = { premium: true, freeRatings: { limit: 5 } };
        mutations.push({ op });
        break;
      }
      case 'whole-value': {
        const generated = malformedValue(rng);
        value = generated.value;
        mutations.push({ op, tag: generated.tag });
        break;
      }
      case 'numeric-boundary': {
        const numeric = paths(value).filter(
          p => typeof readPath(value, p) === 'number',
        );
        if (numeric.length === 0) break;
        const path = rng.pick(numeric);
        setPath(value, path, rng.pick(NUMBER_EDGES));
        mutations.push({ op, path, tag: 'number-edge' });
        break;
      }
      case 'huge-string-field': {
        const available = paths(value);
        if (available.length === 0) break;
        const path = rng.pick(available);
        setPath(value, path, hugeString(rng));
        mutations.push({ op, path, tag: 'string-huge' });
        break;
      }
      case 'entitlements-shape': {
        const shapes: unknown[] = [
          'premium',
          ['premium', 5],
          [null],
          [{ id: 'premium' }],
          ['pre\u0000mium'],
          [hugeString(rng)],
          new Array(3),
          Array.from({ length: 512 }, () => 'premium'),
          ['pickle_sensei_pro'],
        ];
        setPath(value, 'entitlements', rng.pick(shapes));
        mutations.push({ op, path: 'entitlements' });
        break;
      }
    }
  }
  return { value, mutations };
}

function readPath(value: unknown, path: string): unknown {
  if (!isPlainObject(value)) return undefined;
  const [head, tail] = path.split('.');
  if (head === undefined) return undefined;
  const child = value[head];
  if (tail === undefined) return child;
  return isPlainObject(child) ? child[tail] : undefined;
}

// ---------------------------------------------------------------------------
// Rejection reasons
// ---------------------------------------------------------------------------

export const BILLING_ERROR_CODES: readonly BillingErrorCode[] = [
  'billing.unconfigured',
  'billing.offerings_unavailable',
  'billing.purchase_cancelled',
  'billing.purchase_failed',
  'billing.restore_failed',
  'billing.backend_unconfigured',
  'billing.backend_unavailable',
  'billing.backend_invalid_response',
  'billing.backend_verification_pending',
];

export type RejectionTag =
  | 'raw-malformed'
  | 'plain-error'
  | 'error-huge-message'
  | 'billing-error-valid'
  | 'billing-error-unknown-code'
  | 'billing-error-wrong-types'
  | 'billing-error-lookalike';

export function malformedRejection(rng: Rng): {
  tag: RejectionTag;
  reason: unknown;
} {
  const tag = rng.pick<RejectionTag>([
    'raw-malformed',
    'plain-error',
    'error-huge-message',
    'billing-error-valid',
    'billing-error-unknown-code',
    'billing-error-wrong-types',
    'billing-error-lookalike',
  ]);
  switch (tag) {
    case 'raw-malformed':
      return { tag, reason: malformedValue(rng).value };
    case 'plain-error':
      return { tag, reason: new Error(rng.pick(STRING_EDGES)) };
    case 'error-huge-message':
      return { tag, reason: new Error(hugeString(rng)) };
    case 'billing-error-valid':
      return {
        tag,
        reason: new BillingError(
          rng.pick(BILLING_ERROR_CODES),
          rng.pick(UNICODE_STRINGS),
          rng.chance(0.5),
        ),
      };
    case 'billing-error-unknown-code':
      return {
        tag,
        reason: new BillingError(
          rng.pick([
            'billing.nope',
            '',
            '__proto__',
            'BILLING.UNCONFIGURED',
            rng.pick(TRAVERSAL_STRINGS),
          ]) as BillingErrorCode,
          'unknown code',
          true,
        ),
      };
    case 'billing-error-wrong-types': {
      const error = new BillingError(
        rng.pick(BILLING_ERROR_CODES),
        hugeString(rng),
        rng.pick([1, 'yes', null, undefined]) as unknown as boolean,
        rng.pick(['bogus_reason', '', 42]) as unknown as undefined,
      );
      return { tag, reason: error };
    }
    case 'billing-error-lookalike':
      return {
        tag,
        reason: {
          code: rng.pick(BILLING_ERROR_CODES),
          message: 'not an instance',
          retryable: true,
          toState: () => ({ code: 'billing.unconfigured', message: 'x' }),
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Dependency model
// ---------------------------------------------------------------------------

export type MethodName =
  | 'configure'
  | 'loadPlans'
  | 'purchase'
  | 'restore'
  | 'getAccess'
  | 'syncBilling';

export const METHOD_NAMES: readonly MethodName[] = [
  'configure',
  'loadPlans',
  'purchase',
  'restore',
  'getAccess',
  'syncBilling',
];

export type MethodMode =
  | 'ok'
  | 'malformed'
  | 'reject'
  | 'deferred'
  | 'missing'
  | 'not-function'
  | 'sync-throw';

export interface MethodPlan {
  mode: MethodMode;
  detail?: string;
}

export interface DependencyPlan {
  structural: 'complete' | 'missing-store' | 'missing-backend' | 'null';
  methods: Record<MethodName, MethodPlan>;
}

export interface Deferred {
  method: MethodName;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

export interface DependencyModel {
  plan: DependencyPlan;
  dependencies: BillingAccessDependencies;
  /** Every value a backend method resolved (provenance for canonicalAccess). */
  resolvedAccess: unknown[];
  purchaseArgs: unknown[];
  restoreCalls: number;
  syncCalls: number;
  storeStepOutcomes: Array<'ok' | 'rejected'>;
  deferred: Deferred[];
}

function isStructuralMode(mode: MethodMode): boolean {
  return mode === 'missing' || mode === 'not-function' || mode === 'sync-throw';
}

export function chooseMethodMode(rng: Rng, structuralRate: number): MethodMode {
  if (rng.chance(structuralRate)) {
    return rng.pick<MethodMode>(['missing', 'not-function', 'sync-throw']);
  }
  const r = rng.float();
  if (r < 0.35) return 'ok';
  if (r < 0.65) return 'malformed';
  if (r < 0.9) return 'reject';
  return 'deferred';
}

export function buildDependencies(
  rng: Rng,
  options: { structuralRate: number },
): DependencyModel {
  const methods = {} as Record<MethodName, MethodPlan>;
  for (const name of METHOD_NAMES) {
    methods[name] = { mode: chooseMethodMode(rng, options.structuralRate) };
  }
  const structural: DependencyPlan['structural'] = rng.chance(
    options.structuralRate / 2,
  )
    ? rng.pick(['missing-store', 'missing-backend', 'null'] as const)
    : 'complete';
  const plan: DependencyPlan = { structural, methods };

  const model: DependencyModel = {
    plan,
    dependencies: null as unknown as BillingAccessDependencies,
    resolvedAccess: [],
    purchaseArgs: [],
    restoreCalls: 0,
    syncCalls: 0,
    storeStepOutcomes: [],
    deferred: [],
  };

  const okValue = (name: MethodName): unknown => {
    switch (name) {
      case 'configure':
        return undefined;
      case 'loadPlans':
        return validPlans(rng);
      case 'purchase':
      case 'restore':
        return {
          premium: true,
          productId: 'pickle_sensei_pro_yearly',
          expirationDate: '2027-01-01T00:00:00.000Z',
        };
      case 'getAccess':
        return validAccess(rng);
      case 'syncBilling': {
        const access = validAccess(rng);
        return {
          billing: {
            premium: access.premium,
            productKey: access.premium ? 'pickle_sensei_pro_yearly' : null,
            expiresAt: access.premium ? '2027-01-01T00:00:00.000Z' : null,
            verifiedAt: '2026-09-04T00:00:00.000Z',
          },
          access,
        };
      }
    }
  };

  const malformedFor = (name: MethodName): unknown => {
    switch (name) {
      case 'configure':
        return malformedValue(rng).value;
      case 'loadPlans': {
        const result = mutate(rng, validPlans(rng));
        methods.loadPlans.detail = JSON.stringify(result.mutations);
        return result.value;
      }
      case 'purchase':
      case 'restore': {
        const result = mutate(rng, {
          premium: true,
          productId: 'x',
          expirationDate: null,
        });
        methods[name].detail = JSON.stringify(result.mutations);
        return result.value;
      }
      case 'getAccess': {
        const result = mutate(rng, validAccess(rng));
        methods.getAccess.detail = JSON.stringify(result.mutations);
        return result.value;
      }
      case 'syncBilling': {
        const base = okValue('syncBilling') as {
          billing: unknown;
          access: unknown;
        };
        if (rng.chance(0.3)) {
          const whole = malformedValue(rng);
          methods.syncBilling.detail = `whole:${whole.tag}`;
          return whole.value;
        }
        const result = mutate(rng, base as object);
        methods.syncBilling.detail = JSON.stringify(result.mutations);
        return result.value;
      }
    }
  };

  const track = (name: MethodName, value: unknown) => {
    if (name === 'getAccess') model.resolvedAccess.push(value);
    if (name === 'syncBilling' && isPlainObject(value)) {
      model.resolvedAccess.push(value.access);
    }
  };

  const makeMethod = (name: MethodName): unknown => {
    const method = methods[name];
    const record = (args: unknown[]) => {
      if (name === 'purchase') model.purchaseArgs.push(args[0]);
      if (name === 'restore') model.restoreCalls += 1;
      if (name === 'syncBilling') model.syncCalls += 1;
    };
    switch (method.mode) {
      case 'missing':
        return undefined;
      case 'not-function':
        return rng.pick(['getAccess', 42, null, {}]);
      case 'sync-throw':
        return (...args: unknown[]) => {
          record(args);
          throw malformedRejection(rng).reason;
        };
      case 'ok':
        return async (...args: unknown[]) => {
          record(args);
          if (name === 'purchase' || name === 'restore') {
            model.storeStepOutcomes.push('ok');
          }
          const value = okValue(name);
          track(name, value);
          return value;
        };
      case 'malformed':
        return async (...args: unknown[]) => {
          record(args);
          if (name === 'purchase' || name === 'restore') {
            model.storeStepOutcomes.push('ok');
          }
          const value = malformedFor(name);
          track(name, value);
          return value;
        };
      case 'reject':
        return async (...args: unknown[]) => {
          record(args);
          if (name === 'purchase' || name === 'restore') {
            model.storeStepOutcomes.push('rejected');
          }
          const rejection = malformedRejection(rng);
          method.detail = rejection.tag;
          throw rejection.reason;
        };
      case 'deferred':
        return (...args: unknown[]) => {
          record(args);
          return new Promise<unknown>((resolve, reject) => {
            model.deferred.push({
              method: name,
              resolve: value => {
                if (name === 'purchase' || name === 'restore') {
                  model.storeStepOutcomes.push('ok');
                }
                track(name, value);
                resolve(value);
              },
              reject: reason => {
                if (name === 'purchase' || name === 'restore') {
                  model.storeStepOutcomes.push('rejected');
                }
                reject(reason);
              },
            });
          });
        };
    }
  };

  const store = {
    configure: makeMethod('configure'),
    loadPlans: makeMethod('loadPlans'),
    purchase: makeMethod('purchase'),
    restore: makeMethod('restore'),
    readEntitlement: async () => ({
      premium: false,
      productId: null,
      expirationDate: null,
    }),
  };
  const backend = {
    getAccess: makeMethod('getAccess'),
    syncBilling: makeMethod('syncBilling'),
  };
  let dependencies: unknown;
  switch (structural) {
    case 'complete':
      dependencies = { store, backend };
      break;
    case 'missing-store':
      dependencies = { backend };
      break;
    case 'missing-backend':
      dependencies = { store };
      break;
    case 'null':
      dependencies = null;
      break;
  }
  model.dependencies = dependencies as BillingAccessDependencies;
  return model;
}

/** Settles a deferred call with a fresh valid / malformed / rejected outcome. */
export function settleDeferred(
  rng: Rng,
  deferred: Deferred,
  how: 'ok' | 'malformed' | 'reject',
  okValueFor: (name: MethodName) => unknown,
): void {
  if (how === 'reject') {
    deferred.reject(malformedRejection(rng).reason);
    return;
  }
  if (how === 'ok') {
    deferred.resolve(okValueFor(deferred.method));
    return;
  }
  const mutated =
    deferred.method === 'getAccess'
      ? mutate(rng, validAccess(rng)).value
      : deferred.method === 'loadPlans'
        ? mutate(rng, validPlans(rng)).value
        : malformedValue(rng).value;
  deferred.resolve(mutated);
}

// ---------------------------------------------------------------------------
// Scenario ops
// ---------------------------------------------------------------------------

export type OpName =
  | 'configure'
  | 'initialize'
  | 'refreshAccess'
  | 'syncBilling'
  | 'purchaseSelected'
  | 'restorePurchases'
  | 'selectPeriod'
  | 'clearError'
  | 'reset'
  | 'clearConfiguration'
  | 'settleDeferred'
  | 'raceClearMidFlight'
  | 'raceReconfigureMidFlight'
  | 'raceOutOfOrderRefresh';

export const OP_NAMES: readonly OpName[] = [
  'configure',
  'initialize',
  'initialize',
  'refreshAccess',
  'refreshAccess',
  'syncBilling',
  'purchaseSelected',
  'restorePurchases',
  'selectPeriod',
  'clearError',
  'reset',
  'clearConfiguration',
  'settleDeferred',
  'raceClearMidFlight',
  'raceReconfigureMidFlight',
  'raceOutOfOrderRefresh',
];

export interface Violation {
  invariant: string;
  detail: string;
  afterOp: string;
}

export interface OpRecord {
  op: OpName;
  arg?: string;
}

export interface IterationResult {
  seed: number;
  index: number;
  ok: boolean;
  ops: OpRecord[];
  dependencyPlans: DependencyPlan[];
  violations: Violation[];
  stats: {
    storeCalls: number;
    deferredSettled: number;
    maxErrorMessageLength: number;
  };
}

const STATUSES = new Set(['idle', 'loading', 'ready', 'unconfigured', 'error']);
const OPERATIONS = new Set(['idle', 'purchasing', 'restoring', 'syncing']);
const PERIODS = new Set(['annual', 'monthly', 'lifetime']);
const CODES = new Set<string>(BILLING_ERROR_CODES);

const PROTO_BASELINE = {
  object: Object.getOwnPropertyNames(Object.prototype).sort().join(','),
  array: Object.getOwnPropertyNames(Array.prototype).sort().join(','),
};

function show(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 40
      ? `string(len=${value.length})`
      : JSON.stringify(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (value === undefined) return 'undefined';
  if (Object.is(value, -0)) return '-0';
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return String(value);
  }
  try {
    const text = JSON.stringify(value);
    if (text !== undefined) {
      return text.length > 80 ? `${text.slice(0, 77)}...` : text;
    }
  } catch {
    // cyclic / BigInt inside / throwing toJSON — fall through
  }
  try {
    return String(value);
  } catch {
    // null-prototype objects and Symbol.toPrimitive traps
    return `[unprintable ${typeof value}]`;
  }
}

export interface Checker {
  violations: Violation[];
  check(afterOp: string, context: CheckContext): void;
}

export interface CheckContext {
  model: DependencyModel | null;
  cleared: boolean;
  /** Number of started store calls that have not yet settled. */
  inFlight: number;
}

export function createChecker(): Checker {
  const violations: Violation[] = [];
  const push = (invariant: string, detail: string, afterOp: string) => {
    violations.push({ invariant, detail, afterOp });
  };
  return {
    violations,
    check(afterOp, context) {
      const state: AccessStoreState = useAccessStore.getState();
      for (const [selectorName, selector] of [
        ['selectHasPremium', selectHasPremium],
        ['selectCanStartRating', selectCanStartRating],
        ['selectPaywallRequired', selectPaywallRequired],
      ] as const) {
        try {
          const result: unknown = selector(state);
          if (typeof result !== 'boolean') {
            push(
              'selectors-boolean',
              `${selectorName} returned ${show(result)} for canonicalAccess=${show(state.canonicalAccess)}`,
              afterOp,
            );
          }
        } catch (error) {
          push(
            'selectors-boolean',
            `${selectorName} threw ${show(String(error))}`,
            afterOp,
          );
        }
      }
      if (!STATUSES.has(state.status)) {
        push('enum-fields', `status=${show(state.status)}`, afterOp);
      }
      if (!OPERATIONS.has(state.operation)) {
        push('enum-fields', `operation=${show(state.operation)}`, afterOp);
      }
      if (!PERIODS.has(state.selectedPeriod)) {
        push(
          'enum-fields',
          `selectedPeriod=${show(state.selectedPeriod)}`,
          afterOp,
        );
      }
      const error: unknown = state.error;
      if (error !== null) {
        if (
          !isPlainObject(error) ||
          typeof error.code !== 'string' ||
          !CODES.has(error.code) ||
          typeof error.message !== 'string' ||
          typeof error.retryable !== 'boolean'
        ) {
          push('error-shape', `error=${show(error)}`, afterOp);
        }
      }
      if (context.inFlight === 0) {
        if (state.operation !== 'idle') {
          push(
            'settled-idle',
            `operation=${state.operation} with nothing in flight`,
            afterOp,
          );
        }
        if (state.status === 'loading') {
          push(
            'settled-idle',
            'status=loading with nothing in flight',
            afterOp,
          );
        }
      }
      const objectProto = Object.getOwnPropertyNames(Object.prototype)
        .sort()
        .join(',');
      const arrayProto = Object.getOwnPropertyNames(Array.prototype)
        .sort()
        .join(',');
      if (
        objectProto !== PROTO_BASELINE.object ||
        arrayProto !== PROTO_BASELINE.array ||
        ({} as { polluted?: unknown }).polluted !== undefined
      ) {
        push('no-prototype-pollution', 'prototype gained a property', afterOp);
      }
      if (context.cleared) {
        // Calls made while unconfigured are allowed to report exactly the
        // typed `billing.unconfigured` state; anything else is a leak.
        if (
          (state.status !== 'idle' && state.status !== 'unconfigured') ||
          state.operation !== 'idle' ||
          state.plans !== null ||
          state.canonicalAccess !== null ||
          (state.error !== null &&
            state.error.code !== 'billing.unconfigured') ||
          state.selectedPeriod !== 'annual'
        ) {
          push(
            'fail-closed-after-clear',
            `state after clear: status=${state.status} operation=${state.operation} canonicalAccess=${show(state.canonicalAccess)} error=${show(state.error)}`,
            afterOp,
          );
        }
      }
      if (state.canonicalAccess !== null) {
        const known =
          context.model !== null &&
          context.model.resolvedAccess.some(v =>
            Object.is(v, state.canonicalAccess),
          );
        if (!known) {
          push(
            'canonical-provenance',
            `canonicalAccess=${show(state.canonicalAccess)} was not resolved by the current backend`,
            afterOp,
          );
        }
      }
      if (context.model) {
        for (const arg of context.model.purchaseArgs) {
          if (typeof arg !== 'string') {
            push(
              'purchase-arg-string',
              `store.purchase(${show(arg)})`,
              afterOp,
            );
          }
        }
        context.model.purchaseArgs.length = 0;
      }
    },
  };
}

/**
 * Runs one seeded iteration against the REAL store. The store is a module
 * singleton, so callers must run iterations sequentially.
 */
export async function runIteration(
  seed: number,
  index: number,
  options: { structuralRate: number; maxOps: number },
): Promise<IterationResult> {
  const rng = new Rng(seed);
  const checker = createChecker();
  const ops: OpRecord[] = [];
  const dependencyPlans: DependencyPlan[] = [];
  let model: DependencyModel | null = null;
  const models: DependencyModel[] = [];
  let cleared = true;
  let inFlight = 0;
  let storeCalls = 0;
  let deferredSettled = 0;
  let maxErrorMessageLength = 0;
  const pending: Array<Promise<void>> = [];

  clearAccessStoreConfiguration();

  const okValueFor = (name: MethodName): unknown => {
    switch (name) {
      case 'configure':
        return undefined;
      case 'loadPlans':
        return validPlans(rng);
      case 'purchase':
      case 'restore':
        return { premium: true, productId: 'p', expirationDate: null };
      case 'getAccess':
        return validAccess(rng);
      case 'syncBilling': {
        const access = validAccess(rng);
        return {
          billing: {
            premium: access.premium,
            productKey: null,
            expiresAt: null,
            verifiedAt: '2026-09-04T00:00:00.000Z',
          },
          access,
        };
      }
    }
  };

  const configure = () => {
    model = buildDependencies(rng, { structuralRate: options.structuralRate });
    models.push(model);
    dependencyPlans.push(model.plan);
    cleared = false;
    try {
      configureAccessStore(model.dependencies);
    } catch (error) {
      checker.violations.push({
        invariant: 'op-no-throw',
        detail: `configureAccessStore threw ${show(String(error))}`,
        afterOp: 'configure',
      });
    }
  };

  const callAsync = (
    name:
      | 'initialize'
      | 'refreshAccess'
      | 'syncBilling'
      | 'purchaseSelected'
      | 'restorePurchases',
  ): Promise<void> => {
    storeCalls += 1;
    inFlight += 1;
    let promise: Promise<unknown>;
    try {
      promise = useAccessStore.getState()[name]();
    } catch (error) {
      inFlight -= 1;
      checker.violations.push({
        invariant: 'op-no-throw',
        detail: `${name}() threw synchronously: ${show(String(error))}`,
        afterOp: name,
      });
      return Promise.resolve();
    }
    return promise.then(
      value => {
        inFlight -= 1;
        if (name !== 'initialize' && typeof value !== 'boolean') {
          checker.violations.push({
            invariant: 'op-returns-boolean',
            detail: `${name}() resolved ${show(value)}`,
            afterOp: name,
          });
        }
        if (name === 'initialize' && value !== undefined) {
          checker.violations.push({
            invariant: 'op-returns-boolean',
            detail: `initialize() resolved ${show(value)}`,
            afterOp: name,
          });
        }
      },
      (reason: unknown) => {
        inFlight -= 1;
        checker.violations.push({
          invariant: 'op-no-throw',
          detail: `${name}() rejected: ${show(
            reason instanceof Error
              ? `${reason.name}: ${reason.message.slice(0, 120)}`
              : reason,
          )}`,
          afterOp: name,
        });
      },
    );
  };

  const flush = async () => {
    // Let every microtask chain the store started make progress.
    for (let i = 0; i < 16; i++) await Promise.resolve();
  };

  const settleAll = async (how: 'ok' | 'malformed' | 'reject' | 'mixed') => {
    for (const owner of models) {
      while (owner.deferred.length > 0) {
        const deferred = owner.deferred.shift();
        if (!deferred) break;
        const mode =
          how === 'mixed'
            ? rng.pick(['ok', 'malformed', 'reject'] as const)
            : how;
        settleDeferred(rng, deferred, mode, okValueFor);
        deferredSettled += 1;
        await flush();
      }
    }
  };

  // Most iterations exercise a configured store; the rest start signed-out so
  // the unconfigured branches of every method are covered too.
  if (rng.chance(0.85)) {
    ops.push({ op: 'configure' });
    configure();
  }

  const opCount = 2 + rng.int(options.maxOps - 1);
  for (let i = 0; i < opCount; i++) {
    const op = rng.pick(OP_NAMES);
    const record: OpRecord = { op };
    ops.push(record);
    switch (op) {
      case 'configure':
        configure();
        break;
      case 'initialize':
      case 'refreshAccess':
      case 'syncBilling':
      case 'purchaseSelected':
      case 'restorePurchases':
        pending.push(callAsync(op));
        break;
      case 'selectPeriod': {
        const generated = rng.chance(0.3)
          ? {
              tag: 'valid' as const,
              value: rng.pick(['annual', 'monthly', 'lifetime']),
            }
          : malformedValue(rng);
        record.arg = `${generated.tag}:${show(generated.value)}`;
        try {
          useAccessStore.getState().selectPeriod(generated.value as 'annual');
        } catch (error) {
          checker.violations.push({
            invariant: 'op-no-throw',
            detail: `selectPeriod(${show(generated.value)}) threw ${show(String(error))}`,
            afterOp: op,
          });
        }
        break;
      }
      case 'clearError':
        useAccessStore.getState().clearError();
        break;
      case 'reset':
        useAccessStore.getState().reset();
        // reset() bumps the configuration version: in-flight calls become
        // stale and must not write, but dependencies remain configured.
        if (model) model.resolvedAccess.length = 0;
        break;
      case 'clearConfiguration':
        clearAccessStoreConfiguration();
        cleared = true;
        model = null;
        break;
      case 'settleDeferred':
        await settleAll('mixed');
        break;
      case 'raceClearMidFlight': {
        // Force a deferred backend, start a refresh, sign out, then let the
        // stale response land with a malformed / valid / rejected payload.
        model = buildDependencies(rng, { structuralRate: 0 });
        models.push(model);
        model.plan.methods.getAccess.mode = 'deferred';
        const deferredList = model.deferred;
        const backend = model.dependencies.backend;
        backend.getAccess = () =>
          new Promise<CanonicalAccessState>((resolve, reject) => {
            deferredList.push({
              method: 'getAccess',
              resolve: value => resolve(value as CanonicalAccessState),
              reject,
            });
          });
        dependencyPlans.push(model.plan);
        cleared = false;
        configureAccessStore(model.dependencies);
        pending.push(callAsync('refreshAccess'));
        await flush();
        clearAccessStoreConfiguration();
        cleared = true;
        const staleModel = model;
        model = null;
        while (staleModel.deferred.length > 0) {
          const deferred = staleModel.deferred.shift();
          if (!deferred) break;
          settleDeferred(
            rng,
            deferred,
            rng.pick(['ok', 'malformed', 'reject'] as const),
            okValueFor,
          );
          deferredSettled += 1;
        }
        await flush();
        break;
      }
      case 'raceReconfigureMidFlight': {
        const oldModel = buildDependencies(rng, { structuralRate: 0 });
        models.push(oldModel);
        oldModel.plan.methods.getAccess.mode = 'deferred';
        const oldDeferred = oldModel.deferred;
        oldModel.dependencies.backend.getAccess = () =>
          new Promise<CanonicalAccessState>((resolve, reject) => {
            oldDeferred.push({
              method: 'getAccess',
              resolve: value => resolve(value as CanonicalAccessState),
              reject,
            });
          });
        dependencyPlans.push(oldModel.plan);
        cleared = false;
        configureAccessStore(oldModel.dependencies);
        model = oldModel;
        pending.push(callAsync('refreshAccess'));
        await flush();
        // New account signs in while the old refresh is still in flight.
        model = buildDependencies(rng, { structuralRate: 0 });
        models.push(model);
        dependencyPlans.push(model.plan);
        configureAccessStore(model.dependencies);
        while (oldDeferred.length > 0) {
          const deferred = oldDeferred.shift();
          if (!deferred) break;
          settleDeferred(
            rng,
            deferred,
            rng.pick(['ok', 'malformed', 'reject'] as const),
            okValueFor,
          );
          deferredSettled += 1;
        }
        await flush();
        break;
      }
      case 'raceOutOfOrderRefresh': {
        const fresh = buildDependencies(rng, { structuralRate: 0 });
        models.push(fresh);
        fresh.plan.methods.getAccess.mode = 'deferred';
        const queue = fresh.deferred;
        fresh.dependencies.backend.getAccess = () =>
          new Promise<CanonicalAccessState>((resolve, reject) => {
            queue.push({
              method: 'getAccess',
              resolve: value => {
                fresh.resolvedAccess.push(value);
                resolve(value as CanonicalAccessState);
              },
              reject,
            });
          });
        dependencyPlans.push(fresh.plan);
        cleared = false;
        configureAccessStore(fresh.dependencies);
        model = fresh;
        pending.push(callAsync('refreshAccess'));
        pending.push(callAsync('refreshAccess'));
        await flush();
        const first = queue.shift();
        const second = queue.shift();
        if (first && second) {
          const older = validAccess(rng);
          const newer = validAccess(rng);
          // The later-issued call answers first; the earlier one lands last.
          second.resolve(newer);
          await flush();
          first.resolve(older);
          await flush();
          const now = useAccessStore.getState().canonicalAccess;
          if (now !== newer) {
            checker.violations.push({
              invariant: 'latest-refresh-wins',
              detail: `canonicalAccess is the EARLIER-issued snapshot (used=${show(
                (now as CanonicalAccessState | null)?.freeRatings?.used,
              )}) after the later-issued one (used=${newer.freeRatings.used}) already landed`,
              afterOp: op,
            });
          }
          deferredSettled += 2;
        }
        break;
      }
    }
    await flush();
    checker.check(op, { model, cleared, inFlight });
    const currentError = useAccessStore.getState().error;
    if (currentError && typeof currentError.message === 'string') {
      maxErrorMessageLength = Math.max(
        maxErrorMessageLength,
        currentError.message.length,
      );
    }
  }

  // Drain: settle every deferred call (a settled step may start another
  // deferred step, e.g. purchase → syncBilling), then wait for every call.
  for (let round = 0; round < 8; round++) {
    await settleAll('mixed');
    if (models.every(owner => owner.deferred.length === 0)) break;
  }
  await Promise.all(pending);
  await flush();
  checker.check('drain', { model, cleared, inFlight });

  if (model) {
    const finalModel = model as DependencyModel;
    // sync-after-store-ok: syncBilling may only run once per store step that
    // resolved; a rejected store step must never be followed by a sync.
    const okSteps = finalModel.storeStepOutcomes.filter(o => o === 'ok').length;
    if (finalModel.syncCalls > okSteps + countDirectSyncOps(ops)) {
      checker.violations.push({
        invariant: 'sync-after-store-ok',
        detail: `backend.syncBilling called ${finalModel.syncCalls}× but only ${okSteps} store steps resolved (+${countDirectSyncOps(ops)} direct syncBilling ops)`,
        afterOp: 'drain',
      });
    }
  }

  return {
    seed,
    index,
    ok: checker.violations.length === 0,
    ops,
    dependencyPlans,
    violations: checker.violations,
    stats: { storeCalls, deferredSettled, maxErrorMessageLength },
  };
}

function countDirectSyncOps(ops: OpRecord[]): number {
  return ops.filter(o => o.op === 'syncBilling').length;
}

export function hasStructuralPlan(result: IterationResult): boolean {
  return result.dependencyPlans.some(
    plan =>
      plan.structural !== 'complete' ||
      METHOD_NAMES.some(name => isStructuralMode(plan.methods[name].mode)),
  );
}
