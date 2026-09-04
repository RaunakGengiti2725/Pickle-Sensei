/**
 * Failure-injection harness for `src/account/sessionVault.ts`.
 *
 * The vault has exactly one dependency — `react-native-keychain` — reached
 * through `require()` at call time. This module provides:
 *
 *   - `FaultyKeychain`: an in-memory Keychain whose three operations
 *     (get/set/reset) can each be armed with ONE fault at a time, plus a
 *     module-shape mode that decides what `require('react-native-keychain')`
 *     hands back (missing native module, undefined functions, throwing
 *     getters, ...). Every call is logged with the fault that was live.
 *   - The fault catalogue: throw / reject / never-resolves / slow / malformed
 *     return shape / partial write, per operation.
 *   - The record corruption catalogue: malformed, partial (truncated),
 *     oversized and accepted-but-noisy Keychain payloads, each with the
 *     verdict the vault contract requires (`reject` → null + discarded,
 *     `accept` → record with exactly the allowed keys).
 *   - Deterministic helpers (seeded record generation, settle-within-budget
 *     under fake timers, artifact writer).
 *
 * Nothing here touches production code; the suites under
 * `__tests__/stress/` wire it in through `jest.mock('react-native-keychain')`.
 */
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';

declare const __dirname: string;

// ─── Constants mirrored from the contract (AGENTS.md "Auth sessions") ───────

export const VAULT_SERVICE = 'com.picklesensei.auth.session';
export const VAULT_ACCOUNT = 'session';
export const VAULT_ACCESSIBLE = 'AccessibleAfterFirstUnlockThisDeviceOnly';
export const ALLOWED_VAULT_KEYS = [
  'version',
  'provider',
  'canonicalAppUserId',
  'refreshToken',
  'email',
  'displayName',
].sort();

export const CANONICAL_IDS = [
  '7fc2c743-028f-4ec6-942c-a84508f3be38',
  '0b4d1f9e-3c2a-4b8e-9f1d-2a6c7e8b9d01',
  'C1D2E3F4-A5B6-4C7D-8E9F-0A1B2C3D4E5F',
] as const;

export interface VaultRecord {
  version: 1;
  provider: 'apple' | 'google';
  canonicalAppUserId: string;
  refreshToken: string;
  email: string | null;
  displayName: string | null;
}

export function isVaultRecord(value: unknown): value is VaultRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort()) !==
    JSON.stringify(ALLOWED_VAULT_KEYS)
  ) {
    return false;
  }
  return (
    record['version'] === 1 &&
    (record['provider'] === 'apple' || record['provider'] === 'google') &&
    typeof record['canonicalAppUserId'] === 'string' &&
    record['canonicalAppUserId'].length > 0 &&
    typeof record['refreshToken'] === 'string' &&
    record['refreshToken'].length > 0 &&
    (record['email'] === null || typeof record['email'] === 'string') &&
    (record['displayName'] === null ||
      typeof record['displayName'] === 'string')
  );
}

/**
 * Reference parser — the contract (AGENTS.md "Auth sessions"), written
 * independently of sessionVault.ts: version 1, provider apple|google,
 * non-empty canonical id and refresh token are required; email/displayName
 * normalize to string|null; everything else is dropped. Anything else is
 * garbage the vault must refuse.
 */
export function referenceParse(raw: string | null): VaultRecord | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const provider = record['provider'];
  const canonicalAppUserId = record['canonicalAppUserId'];
  const refreshToken = record['refreshToken'];
  if (
    record['version'] !== 1 ||
    (provider !== 'apple' && provider !== 'google') ||
    typeof canonicalAppUserId !== 'string' ||
    canonicalAppUserId.length === 0 ||
    typeof refreshToken !== 'string' ||
    refreshToken.length === 0
  ) {
    return null;
  }
  return {
    version: 1,
    provider,
    canonicalAppUserId,
    refreshToken,
    email: typeof record['email'] === 'string' ? record['email'] : null,
    displayName:
      typeof record['displayName'] === 'string' ? record['displayName'] : null,
  };
}

export function sameRecord(
  a: VaultRecord | null,
  b: VaultRecord | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.version === b.version &&
    a.provider === b.provider &&
    a.canonicalAppUserId === b.canonicalAppUserId &&
    a.refreshToken === b.refreshToken &&
    a.email === b.email &&
    a.displayName === b.displayName
  );
}

const EMAILS = [
  'pat@example.com',
  null,
  'ünïcödé@例え.jp',
  '',
  'a'.repeat(300),
];
const NAMES = ['Pat Player', null, '🏓 Dink Master', '', 'O\u2019Brien'];

/** A valid record, a pure function of the seed. */
export function seededRecord(seed: number, salt = 0): VaultRecord {
  const rng = makePrng((seed * 7919 + salt * 104729) >>> 0);
  return {
    version: 1,
    provider: rng() < 0.5 ? 'apple' : 'google',
    canonicalAppUserId: pick(rng, CANONICAL_IDS),
    refreshToken: `refresh-${seed}-${salt}-${Math.floor(rng() * 1e9).toString(36)}`,
    email: pick(rng, EMAILS),
    displayName: pick(rng, NAMES),
  };
}

// ─── The faulty Keychain ────────────────────────────────────────────────────

export type KeychainOp = 'get' | 'set' | 'reset';

export interface StoredItem {
  username: string;
  password: string;
  accessible: string | undefined;
}

export interface KeychainCall {
  op: KeychainOp;
  service: string | undefined;
  fault: string | null;
  /** Fake-clock timestamp of the call. */
  at: number;
}

export interface FaultContext {
  store: Map<string, StoredItem>;
  service: string;
  username: string | undefined;
  password: string | undefined;
  accessible: string | undefined;
  /** Runs the honest behaviour of the operation and returns its result. */
  real: () => unknown;
}

export type FaultCategory =
  'throw' | 'reject' | 'never-resolves' | 'slow' | 'malformed' | 'partial';

export interface KeychainFault {
  id: string;
  op: KeychainOp;
  category: FaultCategory;
  /** Fake-clock delay before the operation settles (slow faults). */
  delayMs?: number;
  /**
   * How the honest store ends up relative to the operation's intent:
   *   'unchanged'  the store is exactly what it was before the call
   *   'applied'    the honest effect happened (possibly late)
   *   'partial'    a truncated write landed (garbage in the store)
   */
  storeEffect: 'unchanged' | 'applied' | 'partial';
  /** What the caller observes for a fault-free vault: the library's own
   * return value would have been used; this is what we hand back instead. */
  run: (ctx: FaultContext) => unknown;
}

export type ModuleMode =
  | 'ok'
  | 'require-throws'
  | 'null-module'
  | 'functions-undefined'
  | 'functions-not-callable'
  | 'accessible-undefined'
  | 'getter-throws';

export const MODULE_MODES: readonly ModuleMode[] = [
  'require-throws',
  'null-module',
  'functions-undefined',
  'functions-not-callable',
  'accessible-undefined',
  'getter-throws',
];

export class FaultyKeychain {
  readonly store = new Map<string, StoredItem>();
  readonly calls: KeychainCall[] = [];
  faults: Record<KeychainOp, KeychainFault | null> = {
    get: null,
    set: null,
    reset: null,
  };
  moduleMode: ModuleMode = 'ok';

  reset(): void {
    this.store.clear();
    this.calls.length = 0;
    this.faults = { get: null, set: null, reset: null };
    this.moduleMode = 'ok';
  }

  arm(fault: KeychainFault | null, op?: KeychainOp): void {
    if (fault) this.faults[fault.op] = fault;
    else if (op) this.faults[op] = null;
    else this.faults = { get: null, set: null, reset: null };
  }

  seed(record: VaultRecord | string, service = VAULT_SERVICE): void {
    this.store.set(service, {
      username: VAULT_ACCOUNT,
      password: typeof record === 'string' ? record : JSON.stringify(record),
      accessible: VAULT_ACCESSIBLE,
    });
  }

  raw(service = VAULT_SERVICE): string | null {
    return this.store.get(service)?.password ?? null;
  }

  /** 'empty' | 'valid' | 'garbage' — the contract's classification of the
   * store (a noisy-but-parseable record is 'valid'). */
  classify(service = VAULT_SERVICE): 'empty' | 'valid' | 'garbage' {
    const raw = this.raw(service);
    if (raw === null) return 'empty';
    return referenceParse(raw) ? 'valid' : 'garbage';
  }

  /** The record the contract says a load must return, or null. */
  parsed(service = VAULT_SERVICE): VaultRecord | null {
    return referenceParse(this.raw(service));
  }

  opsSince(index: number): KeychainOp[] {
    return this.calls.slice(index).map(call => call.op);
  }

  private honest(op: KeychainOp, ctx: Omit<FaultContext, 'real'>): unknown {
    switch (op) {
      case 'set':
        this.store.set(ctx.service, {
          username: ctx.username ?? '',
          password: ctx.password ?? '',
          accessible: ctx.accessible,
        });
        return { service: ctx.service, storage: 'keychain' };
      case 'get': {
        const item = this.store.get(ctx.service);
        if (!item) return false;
        return {
          service: ctx.service,
          storage: 'keychain',
          username: item.username,
          password: item.password,
        };
      }
      case 'reset':
        return this.store.delete(ctx.service);
    }
  }

  invoke(
    op: KeychainOp,
    input: {
      service: string | undefined;
      username?: string;
      password?: string;
      accessible?: string;
    },
  ): unknown {
    const fault = this.faults[op];
    const service = input.service ?? '__default__';
    this.calls.push({
      op,
      service: input.service,
      fault: fault?.id ?? null,
      at: Date.now(),
    });
    const base = {
      store: this.store,
      service,
      username: input.username,
      password: input.password,
      accessible: input.accessible,
    };
    const real = () => this.honest(op, base);
    if (!fault) return Promise.resolve(real());
    return fault.run({ ...base, real });
  }
}

/**
 * Singleton the jest.mock factories reach through `jest.requireActual`.
 * Pinned on globalThis so a `jest.isolateModules` registry (used to re-run
 * the module factory for module-shape faults) sees the SAME runtime.
 */
const globalSlot = globalThis as {
  __sessionVaultStressKeychain?: FaultyKeychain;
};
export const mockKeychain: FaultyKeychain =
  (globalSlot.__sessionVaultStressKeychain ??= new FaultyKeychain());

interface SetOptions {
  service?: string;
  accessible?: string;
}

/** Builds what `require('react-native-keychain')` returns for the runtime's
 * current `moduleMode`. Called by the jest.mock factory. */
export function buildKeychainModule(rt: FaultyKeychain): unknown {
  const mode = rt.moduleMode;
  if (mode === 'require-throws') {
    // RN throws at property access on a missing native module; the closest
    // load-time equivalent is the package's index throwing.
    throw new TypeError(
      "Cannot read properties of null (reading 'getGenericPassword')",
    );
  }
  if (mode === 'null-module') return null;
  const ACCESSIBLE = {
    WHEN_UNLOCKED: 'AccessibleWhenUnlocked',
    AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
    ALWAYS: 'AccessibleAlways',
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: VAULT_ACCESSIBLE,
  };
  const full = {
    ACCESSIBLE,
    setGenericPassword: (
      username: string,
      password: string,
      options: SetOptions = {},
    ) =>
      rt.invoke('set', {
        service: options.service,
        username,
        password,
        accessible: options.accessible,
      }),
    getGenericPassword: (options: SetOptions = {}) =>
      rt.invoke('get', { service: options.service }),
    resetGenericPassword: (options: SetOptions = {}) =>
      rt.invoke('reset', { service: options.service }),
  };
  switch (mode) {
    case 'functions-undefined':
      return { ACCESSIBLE };
    case 'functions-not-callable':
      return {
        ACCESSIBLE,
        setGenericPassword: 42,
        getGenericPassword: 'not a function',
        resetGenericPassword: {},
      };
    case 'accessible-undefined':
      return { ...full, ACCESSIBLE: undefined };
    case 'getter-throws':
      return new Proxy(full, {
        get(_target, property) {
          throw new TypeError(
            `Cannot read properties of null (reading '${String(property)}') — RNKeychainManager native module is null`,
          );
        },
      });
    default:
      return full;
  }
}

// ─── Fault catalogue ────────────────────────────────────────────────────────

const never = () => new Promise<never>(() => {});
const rejectWith = (value: unknown) => () => Promise.reject(value);
const throwWith = (value: unknown) => () => {
  throw value;
};
const secError = (code: number, message: string) =>
  Object.assign(new Error(message), {
    code: String(code),
    name: 'KeychainError',
  });
const slow = (delayMs: number) => (ctx: FaultContext) =>
  new Promise<unknown>(resolve => {
    setTimeout(() => resolve(ctx.real()), delayMs);
  });
const returning = (value: unknown) => () => Promise.resolve(value);

function fault(
  op: KeychainOp,
  id: string,
  category: FaultCategory,
  run: (ctx: FaultContext) => unknown,
  extra: Partial<Pick<KeychainFault, 'delayMs' | 'storeEffect'>> = {},
): KeychainFault {
  const storeEffect =
    extra.storeEffect ??
    (category === 'slow' || category === 'malformed' ? 'applied' : 'unchanged');
  return {
    id: `${op}/${id}`,
    op,
    category,
    run,
    storeEffect,
    delayMs: extra.delayMs,
  };
}

/** Faults for `getGenericPassword` — the store still holds whatever it held. */
export const GET_FAULTS: readonly KeychainFault[] = [
  fault(
    'get',
    'throw-sync-error',
    'throw',
    throwWith(new Error('errSecInternalError (simulated)')),
  ),
  fault('get', 'throw-sync-string', 'throw', throwWith('boom')),
  fault(
    'get',
    'reject-error',
    'reject',
    rejectWith(new Error('errSecAuthFailed (simulated)')),
  ),
  fault(
    'get',
    'reject-errSecInteractionNotAllowed',
    'reject',
    rejectWith(secError(-25308, 'User interaction is not allowed.')),
  ),
  fault(
    'get',
    'reject-errSecDecode',
    'reject',
    rejectWith(secError(-26275, 'Unable to decode the provided data.')),
  ),
  fault(
    'get',
    'reject-errSecItemNotFound',
    'reject',
    rejectWith(
      secError(
        -25300,
        'The specified item could not be found in the keychain.',
      ),
    ),
  ),
  fault(
    'get',
    'reject-android-keystore',
    'reject',
    rejectWith(
      secError(0, 'E_CRYPTO_FAILED: Could not decrypt data with alias'),
    ),
  ),
  fault(
    'get',
    'reject-string',
    'reject',
    rejectWith('rejected with a bare string'),
  ),
  fault('get', 'reject-null', 'reject', rejectWith(null)),
  fault('get', 'reject-undefined', 'reject', rejectWith(undefined)),
  fault('get', 'never-resolves', 'never-resolves', never),
  fault('get', 'slow-1s', 'slow', slow(1_000), { delayMs: 1_000 }),
  fault('get', 'slow-7s', 'slow', slow(7_000), { delayMs: 7_000 }),
  fault('get', 'slow-9s', 'slow', slow(9_000), { delayMs: 9_000 }),
  fault('get', 'slow-30s', 'slow', slow(30_000), { delayMs: 30_000 }),
  fault('get', 'slow-59s', 'slow', slow(59_000), { delayMs: 59_000 }),
  fault('get', 'returns-null', 'malformed', returning(null)),
  fault('get', 'returns-undefined', 'malformed', returning(undefined)),
  fault('get', 'returns-true', 'malformed', returning(true)),
  fault('get', 'returns-string', 'malformed', returning('{"version":1}')),
  fault('get', 'returns-number', 'malformed', returning(0)),
  fault('get', 'returns-empty-object', 'malformed', returning({})),
  fault('get', 'returns-array', 'malformed', returning([])),
  fault(
    'get',
    'returns-username-only',
    'malformed',
    returning({ username: VAULT_ACCOUNT, service: VAULT_SERVICE }),
  ),
  fault(
    'get',
    'returns-password-null',
    'malformed',
    returning({ username: VAULT_ACCOUNT, password: null }),
  ),
  fault(
    'get',
    'returns-password-number',
    'malformed',
    returning({ username: VAULT_ACCOUNT, password: 12345 }),
  ),
  fault(
    'get',
    'returns-password-object',
    'malformed',
    returning({ username: VAULT_ACCOUNT, password: { version: 1 } }),
  ),
  fault(
    'get',
    'returns-password-array',
    'malformed',
    returning({ username: VAULT_ACCOUNT, password: ['{"version":1}'] }),
  ),
  fault('get', 'returns-password-getter-throws', 'malformed', () =>
    Promise.resolve(
      Object.defineProperty({ username: VAULT_ACCOUNT }, 'password', {
        enumerable: true,
        get() {
          throw new Error('bridge serialization failed (simulated)');
        },
      }),
    ),
  ),
  fault('get', 'returns-other-service-item', 'malformed', ctx =>
    Promise.resolve({
      service: 'com.other.app',
      username: 'other',
      password:
        ctx.store.get('com.other.app')?.password ??
        '{"version":1,"provider":"apple"}',
    }),
  ),
  fault('get', 'sync-value-not-promise', 'malformed', ctx => ctx.real()),
];

/**
 * True when the fault still hands the caller the honest result (late, or as
 * a bare value instead of a promise) — the contract's fault-free outcome is
 * then expected.
 */
export function deliversRealResult(fault: KeychainFault | null): boolean {
  return (
    fault === null ||
    fault.category === 'slow' ||
    fault.id.endsWith('/sync-value-not-promise')
  );
}

/** Faults for `setGenericPassword`. */
export const SET_FAULTS: readonly KeychainFault[] = [
  fault(
    'set',
    'throw-sync-error',
    'throw',
    throwWith(new Error('errSecParam (simulated)')),
  ),
  fault('set', 'throw-sync-string', 'throw', throwWith('boom')),
  fault(
    'set',
    'reject-error',
    'reject',
    rejectWith(new Error('errSecIO (simulated)')),
  ),
  fault(
    'set',
    'reject-errSecDuplicateItem',
    'reject',
    rejectWith(
      secError(-25299, 'The specified item already exists in the keychain.'),
    ),
  ),
  fault(
    'set',
    'reject-errSecInteractionNotAllowed',
    'reject',
    rejectWith(secError(-25308, 'User interaction is not allowed.')),
  ),
  fault(
    'set',
    'reject-errSecNotAvailable',
    'reject',
    rejectWith(
      secError(
        -25291,
        'No keychain is available. You may need to restart your computer.',
      ),
    ),
  ),
  fault(
    'set',
    'reject-android-keystore',
    'reject',
    rejectWith(
      secError(0, 'E_CRYPTO_FAILED: Could not encrypt data with alias'),
    ),
  ),
  fault(
    'set',
    'reject-string',
    'reject',
    rejectWith('rejected with a bare string'),
  ),
  fault('set', 'reject-null', 'reject', rejectWith(null)),
  fault('set', 'never-resolves', 'never-resolves', never),
  fault('set', 'slow-1s', 'slow', slow(1_000), { delayMs: 1_000 }),
  fault('set', 'slow-9s', 'slow', slow(9_000), { delayMs: 9_000 }),
  fault('set', 'slow-30s', 'slow', slow(30_000), { delayMs: 30_000 }),
  fault('set', 'slow-59s', 'slow', slow(59_000), { delayMs: 59_000 }),
  fault('set', 'returns-false', 'malformed', returning(false), {
    storeEffect: 'unchanged',
  }),
  fault('set', 'returns-null', 'malformed', ctx => {
    ctx.real();
    return Promise.resolve(null);
  }),
  fault('set', 'returns-undefined', 'malformed', ctx => {
    ctx.real();
    return Promise.resolve(undefined);
  }),
  fault('set', 'returns-true', 'malformed', ctx => {
    ctx.real();
    return Promise.resolve(true);
  }),
  fault('set', 'returns-string', 'malformed', ctx => {
    ctx.real();
    return Promise.resolve('ok');
  }),
  fault('set', 'sync-value-not-promise', 'malformed', ctx => ctx.real()),
  fault(
    'set',
    'partial-write-then-reject',
    'partial',
    ctx => {
      const password = ctx.password ?? '';
      ctx.store.set(ctx.service, {
        username: ctx.username ?? '',
        password: password.slice(
          0,
          Math.max(1, Math.floor(password.length / 2)),
        ),
        accessible: ctx.accessible,
      });
      return Promise.reject(
        secError(-25293, 'errSecAuthFailed after partial write (simulated)'),
      );
    },
    { storeEffect: 'partial' },
  ),
  fault(
    'set',
    'write-then-reject',
    'partial',
    ctx => {
      ctx.real();
      return Promise.reject(
        new Error('bridge lost the reply after the write landed (simulated)'),
      );
    },
    { storeEffect: 'applied' },
  ),
  fault(
    'set',
    'write-then-never-resolves',
    'never-resolves',
    ctx => {
      ctx.real();
      return never();
    },
    { storeEffect: 'applied' },
  ),
];

/** Faults for `resetGenericPassword`. */
export const RESET_FAULTS: readonly KeychainFault[] = [
  fault(
    'reset',
    'throw-sync-error',
    'throw',
    throwWith(new Error('errSecInternalError (simulated)')),
  ),
  fault('reset', 'throw-sync-string', 'throw', throwWith('boom')),
  fault(
    'reset',
    'reject-error',
    'reject',
    rejectWith(new Error('errSecIO (simulated)')),
  ),
  fault(
    'reset',
    'reject-errSecItemNotFound',
    'reject',
    rejectWith(
      secError(
        -25300,
        'The specified item could not be found in the keychain.',
      ),
    ),
  ),
  fault(
    'reset',
    'reject-errSecInteractionNotAllowed',
    'reject',
    rejectWith(secError(-25308, 'User interaction is not allowed.')),
  ),
  fault(
    'reset',
    'reject-string',
    'reject',
    rejectWith('rejected with a bare string'),
  ),
  fault('reset', 'reject-undefined', 'reject', rejectWith(undefined)),
  fault('reset', 'never-resolves', 'never-resolves', never),
  fault('reset', 'slow-1s', 'slow', slow(1_000), { delayMs: 1_000 }),
  fault('reset', 'slow-9s', 'slow', slow(9_000), { delayMs: 9_000 }),
  fault('reset', 'slow-30s', 'slow', slow(30_000), { delayMs: 30_000 }),
  fault('reset', 'slow-59s', 'slow', slow(59_000), { delayMs: 59_000 }),
  fault(
    'reset',
    'returns-false-nothing-deleted',
    'malformed',
    returning(false),
    { storeEffect: 'unchanged' },
  ),
  fault('reset', 'returns-null', 'malformed', ctx => {
    ctx.real();
    return Promise.resolve(null);
  }),
  fault('reset', 'returns-undefined', 'malformed', ctx => {
    ctx.real();
    return Promise.resolve(undefined);
  }),
  fault('reset', 'sync-value-not-promise', 'malformed', ctx => ctx.real()),
  fault(
    'reset',
    'delete-then-reject',
    'partial',
    ctx => {
      ctx.real();
      return Promise.reject(
        new Error('bridge lost the reply after the delete landed (simulated)'),
      );
    },
    { storeEffect: 'applied' },
  ),
  fault(
    'reset',
    'delete-then-never-resolves',
    'never-resolves',
    ctx => {
      ctx.real();
      return never();
    },
    { storeEffect: 'applied' },
  ),
];

export const ALL_FAULTS: readonly KeychainFault[] = [
  ...GET_FAULTS,
  ...SET_FAULTS,
  ...RESET_FAULTS,
];

export function faultById(id: string): KeychainFault | null {
  return ALL_FAULTS.find(candidate => candidate.id === id) ?? null;
}

// ─── Record corruption catalogue ────────────────────────────────────────────

export type CorruptionCategory =
  'malformed' | 'partial' | 'oversized' | 'accepted';

export interface RecordCorruption {
  id: string;
  category: CorruptionCategory;
  /** Lazily built so the oversized payloads are not allocated at import. */
  raw: () => string;
  /** 'reject' → load must return null and discard; 'accept' → a record with
   * exactly the allowed keys whose token matches `acceptedToken`. */
  expect: 'reject' | 'accept';
  acceptedToken?: string;
}

const BASE: VaultRecord = {
  version: 1,
  provider: 'apple',
  canonicalAppUserId: CANONICAL_IDS[0],
  refreshToken: 'refresh-base',
  email: 'pat@example.com',
  displayName: 'Pat Player',
};
const withField = (patch: Record<string, unknown>) => () =>
  JSON.stringify({ ...BASE, ...patch });
const without = (key: keyof VaultRecord) => () => {
  const copy: Record<string, unknown> = { ...BASE };
  delete copy[key];
  return JSON.stringify(copy);
};
const MiB = 1024 * 1024;

function corruption(
  id: string,
  category: CorruptionCategory,
  raw: () => string,
  expect: 'reject' | 'accept' = 'reject',
  acceptedToken?: string,
): RecordCorruption {
  return { id, category, raw, expect, acceptedToken };
}

export function maxOversizedMiB(): number {
  const configured = Number(nodeProcess.env['STRESS_MAX_MB'] ?? '');
  return Number.isFinite(configured) && configured > 0 ? configured : 8;
}

export const RECORD_CORRUPTIONS: readonly RecordCorruption[] = [
  // malformed
  corruption('empty-string', 'malformed', () => ''),
  corruption('whitespace', 'malformed', () => '  \n\t '),
  corruption('not-json', 'malformed', () => 'definitely not json'),
  corruption('json-null', 'malformed', () => 'null'),
  corruption('json-true', 'malformed', () => 'true'),
  corruption('json-number', 'malformed', () => '42'),
  corruption('json-string', 'malformed', () => '"a string"'),
  corruption('json-array', 'malformed', () => '[1,2,3]'),
  corruption('json-array-of-valid', 'malformed', () => JSON.stringify([BASE])),
  corruption('json-empty-object', 'malformed', () => '{}'),
  corruption('nested-valid', 'malformed', () =>
    JSON.stringify({ session: BASE }),
  ),
  corruption('double-encoded', 'malformed', () =>
    JSON.stringify(JSON.stringify(BASE)),
  ),
  corruption(
    'bom-prefixed',
    'malformed',
    () => '\uFEFF' + JSON.stringify(BASE),
  ),
  corruption('nul-bytes', 'malformed', () => 'abc\u0000def\u0000'),
  corruption(
    'unicode-noise',
    'malformed',
    () => '\u{1F3D3}\uFFFD\u202E{"version":1}',
  ),
  corruption(
    'lone-surrogate',
    'malformed',
    () => '{"version":1,"provider":"\uD800"}',
  ),
  corruption('html', 'malformed', () => '<script>alert(1)</script>'),
  corruption('sql', 'malformed', () => "'; DROP TABLE local_shot; --"),
  corruption('version-0', 'malformed', withField({ version: 0 })),
  corruption('version-2', 'malformed', withField({ version: 2 })),
  corruption('version-string', 'malformed', withField({ version: '1' })),
  corruption('version-null', 'malformed', withField({ version: null })),
  corruption('version-missing', 'malformed', without('version')),
  corruption('provider-guest', 'malformed', withField({ provider: 'guest' })),
  corruption(
    'provider-uppercase',
    'malformed',
    withField({ provider: 'Apple' }),
  ),
  corruption('provider-empty', 'malformed', withField({ provider: '' })),
  corruption('provider-null', 'malformed', withField({ provider: null })),
  corruption('provider-number', 'malformed', withField({ provider: 1 })),
  corruption('provider-missing', 'malformed', without('provider')),
  corruption(
    'canonical-empty',
    'malformed',
    withField({ canonicalAppUserId: '' }),
  ),
  corruption(
    'canonical-null',
    'malformed',
    withField({ canonicalAppUserId: null }),
  ),
  corruption(
    'canonical-number',
    'malformed',
    withField({ canonicalAppUserId: 42 }),
  ),
  corruption(
    'canonical-object',
    'malformed',
    withField({ canonicalAppUserId: { id: CANONICAL_IDS[0] } }),
  ),
  corruption('canonical-missing', 'malformed', without('canonicalAppUserId')),
  corruption('token-empty', 'malformed', withField({ refreshToken: '' })),
  corruption('token-null', 'malformed', withField({ refreshToken: null })),
  corruption('token-number', 'malformed', withField({ refreshToken: 123456 })),
  corruption('token-boolean', 'malformed', withField({ refreshToken: true })),
  corruption(
    'token-array',
    'malformed',
    withField({ refreshToken: ['refresh-base'] }),
  ),
  corruption('token-missing', 'malformed', without('refreshToken')),
  // partial (truncations)
  corruption('truncated-1', 'partial', () => JSON.stringify(BASE).slice(0, 1)),
  corruption('truncated-quarter', 'partial', () => {
    const full = JSON.stringify(BASE);
    return full.slice(0, Math.floor(full.length / 4));
  }),
  corruption('truncated-half', 'partial', () => {
    const full = JSON.stringify(BASE);
    return full.slice(0, Math.floor(full.length / 2));
  }),
  corruption('truncated-last-byte', 'partial', () =>
    JSON.stringify(BASE).slice(0, -1),
  ),
  corruption('truncated-mid-token', 'partial', () => {
    const full = JSON.stringify(BASE);
    return full.slice(0, full.indexOf('refresh-base') + 4);
  }),
  corruption('head-lost', 'partial', () => JSON.stringify(BASE).slice(10)),
  corruption('mid-spliced', 'partial', () => {
    const full = JSON.stringify(BASE);
    return full.slice(0, 20) + full.slice(60);
  }),
  // oversized
  corruption('oversized-1mib-junk', 'oversized', () => 'x'.repeat(MiB)),
  corruption(
    'oversized-token-64kib',
    'oversized',
    () => JSON.stringify({ ...BASE, refreshToken: 't'.repeat(64 * 1024) }),
    'accept',
    't'.repeat(64 * 1024),
  ),
  corruption(
    'oversized-token-1mib',
    'oversized',
    () => JSON.stringify({ ...BASE, refreshToken: 't'.repeat(MiB) }),
    'accept',
    't'.repeat(MiB),
  ),
  corruption(
    'oversized-token-max',
    'oversized',
    () =>
      JSON.stringify({
        ...BASE,
        refreshToken: 't'.repeat(maxOversizedMiB() * MiB),
      }),
    'accept',
    't'.repeat(maxOversizedMiB() * MiB),
  ),
  corruption(
    'oversized-extra-field-max',
    'oversized',
    () =>
      JSON.stringify({ ...BASE, blob: 'b'.repeat(maxOversizedMiB() * MiB) }),
    'accept',
    BASE.refreshToken,
  ),
  corruption(
    'oversized-deep-nesting-100k',
    'oversized',
    () => '['.repeat(100_000) + ']'.repeat(100_000),
  ),
  corruption(
    'oversized-deep-object-nesting-50k',
    'oversized',
    () => '{"a":'.repeat(50_000) + '1' + '}'.repeat(50_000),
  ),
  corruption(
    'oversized-many-keys-200k',
    'oversized',
    () => {
      const parts: string[] = [];
      for (let i = 0; i < 200_000; i += 1) parts.push(`"k${i}":${i}`);
      return `{${parts.join(',')},${JSON.stringify(BASE).slice(1)}`;
    },
    'accept',
    BASE.refreshToken,
  ),
  corruption(
    'oversized-1mib-whitespace-padded',
    'oversized',
    () => ' '.repeat(MiB) + JSON.stringify(BASE),
    'accept',
    BASE.refreshToken,
  ),
  // accepted-but-noisy: the parser must strip everything not in the contract
  corruption(
    'extra-token-fields',
    'accepted',
    withField({
      accessToken: 'LEAKED',
      bearerToken: 'LEAKED',
      idToken: 'LEAKED',
    }),
    'accept',
    BASE.refreshToken,
  ),
  corruption(
    'proto-pollution',
    'accepted',
    () =>
      `{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},${JSON.stringify(BASE).slice(1)}`,
    'accept',
    BASE.refreshToken,
  ),
  corruption(
    'duplicate-keys-last-wins',
    'accepted',
    () => `{"refreshToken":"first",${JSON.stringify(BASE).slice(1)}`,
    'accept',
    BASE.refreshToken,
  ),
  corruption(
    'email-number',
    'accepted',
    withField({ email: 42 }),
    'accept',
    BASE.refreshToken,
  ),
  corruption(
    'email-object',
    'accepted',
    withField({ email: { address: 'x' } }),
    'accept',
    BASE.refreshToken,
  ),
  corruption(
    'displayName-array',
    'accepted',
    withField({ displayName: ['Pat'] }),
    'accept',
    BASE.refreshToken,
  ),
  corruption(
    'descriptors-missing',
    'accepted',
    () => {
      const copy: Record<string, unknown> = { ...BASE };
      delete copy['email'];
      delete copy['displayName'];
      return JSON.stringify(copy);
    },
    'accept',
    BASE.refreshToken,
  ),
  corruption(
    'provider-google',
    'accepted',
    withField({ provider: 'google' }),
    'accept',
    BASE.refreshToken,
  ),
  corruption(
    'unicode-descriptors',
    'accepted',
    withField({ email: 'ünïcödé@例え.jp', displayName: '🏓\u0000\u202E' }),
    'accept',
    BASE.refreshToken,
  ),
];

export const REJECTED_CORRUPTIONS = RECORD_CORRUPTIONS.filter(
  c => c.expect === 'reject',
);

// ─── Settling under fake timers ─────────────────────────────────────────────

export type Settled<T> =
  | { state: 'resolved'; value: T }
  | { state: 'rejected'; error: string }
  | { state: 'pending' };

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `non-error: ${String(error)}`;
}

/**
 * Advances the fake clock in steps until the promise settles or `budgetMs`
 * is exhausted; reports how much fake time it took. Must run under
 * `jest.useFakeTimers()`.
 */
export async function settleWithin<T>(
  promise: Promise<T>,
  budgetMs: number,
  stepMs = 500,
): Promise<Settled<T> & { elapsedMs: number }> {
  const box: { out: Settled<T> } = { out: { state: 'pending' } };
  promise.then(
    value => {
      box.out = { state: 'resolved', value };
    },
    (error: unknown) => {
      box.out = { state: 'rejected', error: describeError(error) };
    },
  );
  await jest.advanceTimersByTimeAsync(0);
  let elapsed = 0;
  while (box.out.state === 'pending' && elapsed < budgetMs) {
    const step = Math.min(stepMs, budgetMs - elapsed);
    await jest.advanceTimersByTimeAsync(step);
    elapsed += step;
  }
  return { ...box.out, elapsedMs: elapsed };
}

// ─── Rows + artifacts ───────────────────────────────────────────────────────

export interface StressRow {
  suite: string;
  campaign: string;
  scenario: string;
  seed: number | null;
  faults: string[];
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  ok: boolean;
  failed: string[];
  knownDeviations: string[];
  durationMs: number;
}

export function stressArtifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress/session-vault');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeStressArtifact(name: string, value: unknown): string {
  const file = path.join(stressArtifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

export function stressIterations(name: string, fallback: number): number {
  const configured = Number(
    nodeProcess.env[name] ?? nodeProcess.env['STRESS_ITER'] ?? '',
  );
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : fallback;
}

export function summarizeRows(rows: StressRow[]): Record<string, unknown> {
  const byCampaign: Record<
    string,
    { rows: number; failed: number; known: number }
  > = {};
  const faultIds = new Set<string>();
  const failedInvariants: Record<string, number> = {};
  const knownCounts: Record<string, number> = {};
  for (const row of rows) {
    const bucket = (byCampaign[row.campaign] ??= {
      rows: 0,
      failed: 0,
      known: 0,
    });
    bucket.rows += 1;
    if (!row.ok) bucket.failed += 1;
    if (row.knownDeviations.length > 0) bucket.known += 1;
    for (const id of row.faults) faultIds.add(id);
    for (const name of row.failed)
      failedInvariants[name] = (failedInvariants[name] ?? 0) + 1;
    for (const entry of row.knownDeviations) {
      const id = entry.split(':')[0] as string;
      knownCounts[id] = (knownCounts[id] ?? 0) + 1;
    }
  }
  return {
    rows: rows.length,
    failedRows: rows.filter(row => !row.ok).length,
    rowsWithKnownDeviations: rows.filter(row => row.knownDeviations.length > 0)
      .length,
    distinctFaultsInjected: faultIds.size,
    totalFaultInjections: rows.reduce((sum, row) => sum + row.faults.length, 0),
    byCampaign,
    failedInvariants,
    knownDeviations: knownCounts,
    failingSeeds: rows
      .filter(row => !row.ok && row.seed !== null)
      .map(row => row.seed),
    slowestMs: Math.max(0, ...rows.map(row => row.durationMs)),
  };
}
