/**
 * Controllable stand-in for `react-native-keychain` used by the sessionVault
 * stress suites (`__tests__/stress/sessionVault*.stress.test.ts`).
 *
 * Unlike the auto-mock in `__mocks__/react-native-keychain.ts` (which settles
 * every call immediately), this fake models the NATIVE side as a queue of
 * pending operations that a seeded scheduler completes one at a time, so a
 * burst of vault calls can be interleaved deterministically and replayed from
 * its seed:
 *
 *  - `order: 'fifo'` completes calls in issue order — the model of the iOS
 *    module, whose methods run on one serial dispatch queue
 *    (`RNKeychainManager.m` → `methodQueue`), so JS issue order is native
 *    completion order;
 *  - `order: 'random'` completes any pending call next (seeded) — an
 *    adversarial ordering that the platform does not produce, used to
 *    measure how much of the vault's safety rests on native FIFO.
 *
 * Fault model (all seeded): a call rejects like a Keychain OSStatus error; a
 * `set` whose payload exceeds `maxBytes` rejects; when
 * `failedSetDeletesFirst` is on, a rejected `set` has already deleted the
 * previous item (the vendored iOS implementation deletes before inserting);
 * `corruptRead` can replace what a `get` returns (malformed text, or an
 * item without a `password` field — what the iOS module returns when the
 * stored bytes are not UTF-8).
 *
 * Every completed native call is appended to `log` with the store contents it
 * observed/produced, which is what the suites' oracles fold over.
 */

export interface StoredItem {
  username: string;
  password: string;
  accessible?: string;
}

export type NativeKind = 'set' | 'get' | 'reset';

export interface PendingOp {
  id: number;
  kind: NativeKind;
  service: string;
  username?: string;
  password?: string;
  accessible?: string;
  settle: (result: SettledResult) => void;
}

export type SettledResult =
  { type: 'resolve'; value: unknown } | { type: 'reject'; error: Error };

export interface CompletedOp {
  id: number;
  kind: NativeKind;
  service: string;
  /** Position in completion order (0-based). */
  completedAt: number;
  outcome: 'ok' | 'fault' | 'oversize';
  /** Store contents for the vault service AFTER this op applied. */
  storeAfter: string | null;
  /** For `get`: the password handed back (undefined = field omitted). */
  returned?: string | false | undefined;
  /** For `set`: the password the caller asked to store. */
  password?: string;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  int(maxExclusive: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 — small, fast, and fully determined by a 32-bit seed. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: maxExclusive => Math.floor(next() * maxExclusive),
    chance: p => next() < p,
    pick: items => {
      if (items.length === 0) throw new Error('pick from empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
  };
}

export interface FakeKeychainConfig {
  order: 'fifo' | 'random';
  rng: Rng;
  /** Probability that a native call rejects with a Keychain error. */
  faultRate: number;
  /** `set` payloads (UTF-8 bytes of the password) above this reject. */
  maxBytes: number;
  /** iOS module semantics: a failed set has already deleted the old item. */
  failedSetDeletesFirst: boolean;
  /**
   * Called for every successful `get` that finds an item; may replace the
   * password handed back (`{ password: undefined }` ⇒ omit the field, which
   * is what the iOS module does when the stored bytes are not UTF-8,
   * RNKeychainManager.m `getGenericPasswordForOptions`). Return `null` to
   * hand back the real stored value.
   */
  corruptRead?: (
    stored: StoredItem,
    opId: number,
  ) => { password: string | undefined } | null;
}

const DEFAULT_SERVICE = '__default__';

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export class FakeKeychainNative {
  readonly store = new Map<string, StoredItem>();
  readonly pending: PendingOp[] = [];
  readonly log: CompletedOp[] = [];
  issued = 0;
  private nextId = 0;
  config: FakeKeychainConfig = {
    order: 'fifo',
    rng: seededRng(1),
    faultRate: 0,
    maxBytes: Number.POSITIVE_INFINITY,
    failedSetDeletesFirst: true,
  };

  configure(config: Partial<FakeKeychainConfig>): void {
    this.config = { ...this.config, ...config };
  }

  reset(): void {
    this.store.clear();
    this.pending.length = 0;
    this.log.length = 0;
    this.issued = 0;
    this.nextId = 0;
  }

  /** Enqueue a native call; resolves/rejects only when the scheduler steps it. */
  issue(
    kind: NativeKind,
    args: {
      service?: string;
      username?: string;
      password?: string;
      accessible?: string;
    },
  ): Promise<unknown> {
    this.issued += 1;
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.push({
        id,
        kind,
        service: args.service ?? DEFAULT_SERVICE,
        username: args.username,
        password: args.password,
        accessible: args.accessible,
        settle: result => {
          if (result.type === 'resolve') resolve(result.value);
          else reject(result.error);
        },
      });
    });
  }

  /** Completes ONE pending call (FIFO or seeded); false when none pending. */
  step(): boolean {
    if (this.pending.length === 0) return false;
    const index =
      this.config.order === 'fifo'
        ? 0
        : this.config.rng.int(this.pending.length);
    const [op] = this.pending.splice(index, 1);
    if (!op) return false;
    const entry: CompletedOp = {
      id: op.id,
      kind: op.kind,
      service: op.service,
      completedAt: this.log.length,
      outcome: 'ok',
      storeAfter: null,
    };
    let result: SettledResult;
    if (this.config.rng.chance(this.config.faultRate)) {
      entry.outcome = 'fault';
      if (op.kind === 'set') entry.password = op.password ?? '';
      if (op.kind === 'set' && this.config.failedSetDeletesFirst) {
        this.store.delete(op.service);
      }
      result = {
        type: 'reject',
        error: new Error(
          `Keychain fault injected (op ${op.id} ${op.kind}, errSecInternalComponent)`,
        ),
      };
    } else if (op.kind === 'set') {
      const password = op.password ?? '';
      entry.password = password;
      if (utf8Bytes(password) > this.config.maxBytes) {
        entry.outcome = 'oversize';
        if (this.config.failedSetDeletesFirst) this.store.delete(op.service);
        result = {
          type: 'reject',
          error: new Error(
            `Keychain refused oversized item (op ${op.id}, errSecParam)`,
          ),
        };
      } else {
        this.store.set(op.service, {
          username: op.username ?? '',
          password,
          accessible: op.accessible,
        });
        result = {
          type: 'resolve',
          value: { service: op.service, storage: 'keychain' },
        };
      }
    } else if (op.kind === 'get') {
      const item = this.store.get(op.service);
      if (!item) {
        entry.returned = false;
        result = { type: 'resolve', value: false };
      } else {
        const replaced = this.config.corruptRead?.(item, op.id) ?? null;
        const password = replaced === null ? item.password : replaced.password;
        entry.returned = password;
        const value: Record<string, unknown> = {
          service: op.service,
          storage: 'keychain',
          username: item.username,
        };
        if (password !== undefined) value['password'] = password;
        result = { type: 'resolve', value };
      }
    } else {
      const existed = this.store.delete(op.service);
      result = { type: 'resolve', value: existed };
    }
    entry.storeAfter = this.store.get(op.service)?.password ?? null;
    this.log.push(entry);
    op.settle(result);
    return true;
  }

  /**
   * Steps until no call is pending and no continuation issues another one.
   * Between steps every microtask runs (so a vault continuation that issues
   * a follow-up native call gets queued before the next step). Bounded by
   * `maxSteps` and `deadlineMs` so a hang is a failure, not a timeout.
   */
  async drain(maxSteps: number, deadlineMs: number): Promise<number> {
    const started = Date.now();
    let steps = 0;
    for (;;) {
      await flushMicrotasks();
      if (this.pending.length === 0) {
        await flushMicrotasks();
        if (this.pending.length === 0) return steps;
      }
      if (steps >= maxSteps) {
        throw new Error(
          `scheduler exceeded ${maxSteps} steps with ${this.pending.length} calls still pending`,
        );
      }
      if (Date.now() - started > deadlineMs) {
        throw new Error(
          `scheduler exceeded ${deadlineMs}ms with ${this.pending.length} calls still pending`,
        );
      }
      this.step();
      steps += 1;
    }
  }
}

/** Lets every queued microtask (promise continuation) run before returning. */
export function flushMicrotasks(): Promise<void> {
  return new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

/** The one native the mocked module talks to (shared with the test file). */
export const fakeKeychainNative = new FakeKeychainNative();

/** Drop-in module shape for `jest.mock('react-native-keychain', ...)`. */
export const fakeKeychainModule = {
  ACCESSIBLE: {
    WHEN_UNLOCKED: 'AccessibleWhenUnlocked',
    AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
    ALWAYS: 'AccessibleAlways',
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY:
      'AccessibleWhenPasscodeSetThisDeviceOnly',
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly',
  },
  setGenericPassword(
    username: string,
    password: string,
    options: { service?: string; accessible?: string } = {},
  ): Promise<unknown> {
    return fakeKeychainNative.issue('set', {
      service: options.service,
      username,
      password,
      accessible: options.accessible,
    });
  },
  getGenericPassword(options: { service?: string } = {}): Promise<unknown> {
    return fakeKeychainNative.issue('get', { service: options.service });
  },
  resetGenericPassword(options: { service?: string } = {}): Promise<unknown> {
    return fakeKeychainNative.issue('reset', { service: options.service });
  },
};
