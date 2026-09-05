/**
 * Seeded randomized stress harness for `src/account/sessionVault.ts`.
 *
 * The unit under test is the Keychain-backed session vault: three async
 * operations (`savePersistedSession`, `loadPersistedSession`,
 * `clearPersistedSession`) over one Keychain item. This harness drives them
 * with seeded random sequences of legal AND near-legal actions against a
 * controllable in-memory Keychain (fault injection, external corruption,
 * oversized records, foreign items) and model-checks the documented
 * invariants after every step.
 *
 * Invariants (from the module header, AGENTS.md "Auth sessions", REVIEW.md
 * "Auth & session on mobile"):
 *
 *  I1 fail-soft      — no operation ever throws/rejects, whatever the Keychain does.
 *  I2 shape          — save resolves a boolean; load resolves null or a record with
 *                       EXACTLY the six contract keys (version 1, provider apple|google,
 *                       non-empty string ids/tokens, email/displayName string|null) and a
 *                       plain Object prototype.
 *  I3 model          — every return value and the Keychain content after the step equal
 *                       the sequential specification model (malformed items are discarded,
 *                       unreadable items are NOT discarded, faults leave the item alone).
 *  I4 scope          — every Keychain call names SESSION_VAULT_SERVICE, every write uses
 *                       account 'session' and AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY.
 *  I5 isolation      — items under other services are never touched.
 *  I6 only-contract  — the stored payload carries only the six contract keys; nothing a
 *                       caller smuggles in (an access token, a provider token) is persisted.
 *  I7 linearizable   — a concurrent batch of operations yields results + final Keychain
 *                       content reachable by SOME sequential ordering of that batch.
 *  I8 no-pollution   — a record carrying `__proto__` never pollutes Object.prototype.
 *  I9 bounded time   — a single operation (including on multi-MB records) finishes within
 *                       OP_TIME_BUDGET_MS.
 *
 * Everything is replayable: a sequence is a pure function of its seed, every
 * string payload is derived from the RNG, and a trace digest is produced so
 * the determinism check can compare two runs of one seed byte for byte.
 */

import type { PersistedSession } from '../../src/account/sessionVault';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';

// ─── Seeded RNG (sfc32 — small, fast, well distributed, no dependencies) ────

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    // splitmix-style seeding so neighbouring seeds do not correlate.
    let s = seed >>> 0;
    const next = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Weighted choice: entries are [weight, value]. */
  weighted<T>(entries: readonly (readonly [number, T])[]): T {
    let total = 0;
    for (const [w] of entries) total += w;
    let roll = this.next() * total;
    for (const [w, v] of entries) {
      roll -= w;
      if (roll < 0) return v;
    }
    const last = entries[entries.length - 1];
    if (!last) throw new Error('weighted from empty list');
    return last[1];
  }

  hex(bytes: number): string {
    let out = '';
    for (let i = 0; i < bytes; i++) {
      out += (this.nextU32() & 0xff).toString(16).padStart(2, '0');
    }
    return out;
  }
}

/** Per-sequence seed derived from a campaign base seed and an index. */
export function sequenceSeed(baseSeed: number, index: number): number {
  let h = (baseSeed ^ 0x811c9dc5) >>> 0;
  h = Math.imul(h ^ index, 0x01000193) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** FNV-1a over UTF-16 code units — cheap digest for traces and big payloads. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Multi-MB payloads are digested many times per sequence; V8 caches string
 * hashes per instance so a small Map keyed by the string keeps this O(1). */
const digestCache = new Map<string, string>();
function digestString(input: string): string {
  if (input.length < 4096) return fnv1a(input);
  const cached = digestCache.get(input);
  if (cached) return cached;
  const digest = fnv1a(input);
  if (digestCache.size > 64) digestCache.clear();
  digestCache.set(input, digest);
  return digest;
}

// ─── Fake Keychain with fault injection ─────────────────────────────────────

export const ACCESSIBLE = {
  WHEN_UNLOCKED: 'AccessibleWhenUnlocked',
  AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
  ALWAYS: 'AccessibleAlways',
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'AccessibleWhenPasscodeSetThisDeviceOnly',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
    'AccessibleAfterFirstUnlockThisDeviceOnly',
} as const;

export type SetMode = 'ok' | 'reject' | 'false';
export type GetMode =
  | 'ok'
  | 'reject'
  | 'false'
  | 'garbagePassword'
  | 'undefinedPassword'
  | 'objectPassword';
export type ResetMode = 'ok' | 'reject' | 'false';

export interface FaultState {
  setMode: SetMode;
  getMode: GetMode;
  resetMode: ResetMode;
  /** Simulates a build without the native module: every property access on
   * the module object throws (react-native-keychain's JS binding throws when
   * `NativeModules.RNKeychainManager` is absent). */
  moduleMissing: boolean;
}

export function defaultFaults(): FaultState {
  return {
    setMode: 'ok',
    getMode: 'ok',
    resetMode: 'ok',
    moduleMissing: false,
  };
}

export interface FakeItem {
  username: string;
  password: unknown;
  accessible?: string;
}

export interface KeychainCall {
  op: 'set' | 'get' | 'reset';
  service: string | undefined;
  username?: string;
  accessible?: string;
}

const DEFAULT_SERVICE = '__default__';
const GARBAGE_PASSWORD = '\u0000\u0001garbage\uFFFF{not json';

export interface FakeKeychain {
  /** The object handed to `require('react-native-keychain')`. */
  module: Record<string, unknown>;
  store: Map<string, FakeItem>;
  faults: FaultState;
  calls: KeychainCall[];
  reset(): void;
}

export function createFakeKeychain(): FakeKeychain {
  const store = new Map<string, FakeItem>();
  const faults = defaultFaults();
  const calls: KeychainCall[] = [];

  const guard = () => {
    if (faults.moduleMissing) {
      throw new TypeError(
        "Cannot read properties of null (reading 'RNKeychainManager')",
      );
    }
  };

  async function setGenericPassword(
    username: string,
    password: string,
    options: { service?: string; accessible?: string } = {},
  ): Promise<false | { service: string; storage: string }> {
    calls.push({
      op: 'set',
      service: options.service,
      username,
      accessible: options.accessible,
    });
    if (faults.setMode === 'reject') {
      throw new Error('errSecInteractionNotAllowed (-25308)');
    }
    if (faults.setMode === 'false') return false;
    const service = options.service ?? DEFAULT_SERVICE;
    store.set(service, { username, password, accessible: options.accessible });
    return { service, storage: 'KeychainFake' };
  }

  async function getGenericPassword(
    options: { service?: string } = {},
  ): Promise<
    | false
    | { service: string; storage: string; username: string; password: unknown }
  > {
    calls.push({ op: 'get', service: options.service });
    if (faults.getMode === 'reject') {
      throw new Error('errSecInteractionNotAllowed (-25308)');
    }
    if (faults.getMode === 'false') return false;
    const service = options.service ?? DEFAULT_SERVICE;
    const item = store.get(service);
    if (!item) return false;
    let password: unknown = item.password;
    if (faults.getMode === 'garbagePassword') password = GARBAGE_PASSWORD;
    if (faults.getMode === 'undefinedPassword') password = undefined;
    if (faults.getMode === 'objectPassword') password = { nested: true };
    return {
      service,
      storage: 'KeychainFake',
      username: item.username,
      password,
    };
  }

  async function resetGenericPassword(
    options: { service?: string } = {},
  ): Promise<boolean> {
    calls.push({ op: 'reset', service: options.service });
    if (faults.resetMode === 'reject') {
      throw new Error('errSecItemNotFound (-25300)');
    }
    if (faults.resetMode === 'false') return false;
    return store.delete(options.service ?? DEFAULT_SERVICE);
  }

  const module = {
    get ACCESSIBLE() {
      guard();
      return ACCESSIBLE;
    },
    get setGenericPassword() {
      guard();
      return setGenericPassword;
    },
    get getGenericPassword() {
      guard();
      return getGenericPassword;
    },
    get resetGenericPassword() {
      guard();
      return resetGenericPassword;
    },
  };

  return {
    module,
    store,
    faults,
    calls,
    reset() {
      store.clear();
      calls.length = 0;
      Object.assign(faults, defaultFaults());
    },
  };
}

// ─── Action vocabulary (serializable, replayable) ───────────────────────────

/** Session payload spec: long tokens are described by length + seed so the
 * JSON table stays small while replay stays exact. */
export interface SessionSpec {
  provider: 'apple' | 'google';
  canonicalAppUserId: string;
  refreshToken: string;
  /** When set, refreshToken is expanded to this many chars (deterministic fill). */
  refreshTokenLength?: number;
  email: string | null;
  displayName: string | null;
}

export type CorruptionKind =
  | 'emptyString'
  | 'jsonNull'
  | 'jsonArray'
  | 'jsonEmptyObject'
  | 'jsonString'
  | 'jsonNumber'
  | 'jsonBoolean'
  | 'truncated'
  | 'trailingGarbage'
  | 'bomPrefixed'
  | 'nanLiteral'
  | 'nestedWrapper'
  | 'hugeGarbage'
  | 'version2'
  | 'versionString'
  | 'versionMissing'
  | 'versionFraction'
  | 'providerUnknown'
  | 'providerCapitalised'
  | 'providerEmpty'
  | 'providerMissing'
  | 'userIdEmpty'
  | 'userIdNumber'
  | 'userIdMissing'
  | 'refreshTokenEmpty'
  | 'refreshTokenNumber'
  | 'refreshTokenMissing'
  | 'refreshTokenArray'
  | 'bitflip'
  // equivalent encodings — must still load as the normalized record
  | 'prettyPrinted'
  | 'keysShuffled'
  | 'extraKeys'
  | 'extraAccessTokenKey'
  | 'protoKey'
  | 'emailNumber'
  | 'displayNameObject'
  | 'optionalsMissing'
  | 'versionOnePointZero'
  | 'duplicateKeysLastWins'
  | 'usernameSwapped'
  | 'oversizedValid';

export type Action =
  | { kind: 'save'; session: SessionSpec }
  | { kind: 'saveWide'; session: SessionSpec; smuggled: string }
  | { kind: 'saveUnserializable'; session: SessionSpec }
  | { kind: 'load' }
  | { kind: 'clear' }
  | {
      kind: 'corrupt';
      corruption: CorruptionKind;
      session: SessionSpec;
      cut?: number;
    }
  | { kind: 'externalDelete' }
  | { kind: 'foreignWrite'; service: string; payload: string }
  | { kind: 'fault'; faults: Partial<FaultState> }
  | { kind: 'concurrent'; ops: Action[] };

export const CORRUPTION_KINDS: readonly CorruptionKind[] = [
  'emptyString',
  'jsonNull',
  'jsonArray',
  'jsonEmptyObject',
  'jsonString',
  'jsonNumber',
  'jsonBoolean',
  'truncated',
  'trailingGarbage',
  'bomPrefixed',
  'nanLiteral',
  'nestedWrapper',
  'hugeGarbage',
  'version2',
  'versionString',
  'versionMissing',
  'versionFraction',
  'providerUnknown',
  'providerCapitalised',
  'providerEmpty',
  'providerMissing',
  'userIdEmpty',
  'userIdNumber',
  'userIdMissing',
  'refreshTokenEmpty',
  'refreshTokenNumber',
  'refreshTokenMissing',
  'refreshTokenArray',
  'bitflip',
  'prettyPrinted',
  'keysShuffled',
  'extraKeys',
  'extraAccessTokenKey',
  'protoKey',
  'emailNumber',
  'displayNameObject',
  'optionalsMissing',
  'versionOnePointZero',
  'duplicateKeysLastWins',
  'usernameSwapped',
  'oversizedValid',
];

const NASTY_STRINGS = [
  'Ada Lovelace',
  'O\u2019Brien "The Dink" \\ Smith',
  'line\nbreak\ttab\r\n',
  '\u0000\u0001\u001f control',
  '\uD83E\uDD52 pickle \uD83C\uDFBE',
  '\uD800 lone surrogate',
  '\uFEFFbom-inside',
  '</script><img src=x onerror=alert(1)>',
  '{"json":"inside a string"}',
  'ünïcödé ñ 日本語 العربية',
  ' ',
  'x'.repeat(2048),
];

const EMAILS = [
  'player@example.com',
  'privaterelay@privaterelay.appleid.com',
  'ünïcode@exämple.org',
  'a"quote"@example.com',
  '',
];

const SMUGGLED_KEYS = ['accessToken', 'providerIdToken', 'idToken', 'password'];

export function genSession(rng: Rng): SessionSpec {
  const huge = rng.chance(0.02);
  const spec: SessionSpec = {
    provider: rng.pick(['apple', 'google'] as const),
    canonicalAppUserId: `user-${rng.hex(rng.int(4, 16))}`,
    refreshToken: `rt-${rng.hex(rng.int(8, 48))}`,
    email: rng.chance(0.3) ? null : rng.pick(EMAILS),
    displayName: rng.chance(0.3) ? null : rng.pick(NASTY_STRINGS),
  };
  if (huge) {
    // Oversized records: 64 KiB … 4 MiB refresh tokens.
    spec.refreshTokenLength = rng.pick([
      64 * 1024,
      256 * 1024,
      1024 * 1024,
      4 * 1024 * 1024,
    ]);
  }
  return spec;
}

/** The exact record the module receives / must return for a spec. */
export function materialize(spec: SessionSpec): PersistedSession {
  let refreshToken = spec.refreshToken;
  if (spec.refreshTokenLength !== undefined) {
    const fill = fnv1a(spec.refreshToken);
    refreshToken = (refreshToken + fill).padEnd(spec.refreshTokenLength, fill);
  }
  return {
    version: 1,
    provider: spec.provider,
    canonicalAppUserId: spec.canonicalAppUserId,
    refreshToken,
    email: spec.email,
    displayName: spec.displayName,
  };
}

export function genAction(rng: Rng): Action {
  const kind = rng.weighted<Action['kind']>([
    [24, 'save'],
    [4, 'saveWide'],
    [2, 'saveUnserializable'],
    [24, 'load'],
    [10, 'clear'],
    [14, 'corrupt'],
    [3, 'externalDelete'],
    [3, 'foreignWrite'],
    [8, 'fault'],
    [8, 'concurrent'],
  ]);
  switch (kind) {
    case 'save':
      return { kind, session: genSession(rng) };
    case 'saveWide':
      return {
        kind,
        session: genSession(rng),
        smuggled: rng.pick(SMUGGLED_KEYS),
      };
    case 'saveUnserializable':
      return { kind, session: genSession(rng) };
    case 'load':
    case 'clear':
    case 'externalDelete':
      return { kind };
    case 'corrupt': {
      const corruption = rng.pick(CORRUPTION_KINDS);
      const session = genSession(rng);
      if (corruption === 'truncated' || corruption === 'bitflip') {
        return { kind, corruption, session, cut: rng.next() };
      }
      return { kind, corruption, session };
    }
    case 'foreignWrite':
      return {
        kind,
        service: rng.pick([
          'com.picklesensei.auth.session.other',
          'com.other.app',
          'com.picklesensei.auth',
          '__default__',
        ]),
        payload: rng.pick([
          '{}',
          'foreign',
          JSON.stringify(materialize(genSession(rng))),
        ]),
      };
    case 'fault': {
      const faults: Partial<FaultState> = {};
      const which = rng.weighted<
        'set' | 'get' | 'reset' | 'module' | 'clearAll'
      >([
        [3, 'set'],
        [4, 'get'],
        [2, 'reset'],
        [2, 'module'],
        [5, 'clearAll'],
      ]);
      if (which === 'set') faults.setMode = rng.pick(['ok', 'reject', 'false']);
      if (which === 'get') {
        faults.getMode = rng.pick([
          'ok',
          'reject',
          'false',
          'garbagePassword',
          'undefinedPassword',
          'objectPassword',
        ]);
      }
      if (which === 'reset')
        faults.resetMode = rng.pick(['ok', 'reject', 'false']);
      if (which === 'module') faults.moduleMissing = rng.chance(0.5);
      if (which === 'clearAll') Object.assign(faults, defaultFaults());
      return { kind, faults };
    }
    case 'concurrent': {
      const n = rng.int(2, 4);
      const ops: Action[] = [];
      for (let i = 0; i < n; i++) {
        const sub = rng.weighted<'save' | 'load' | 'clear'>([
          [5, 'save'],
          [5, 'load'],
          [3, 'clear'],
        ]);
        ops.push(
          sub === 'save'
            ? { kind: 'save', session: genSession(rng) }
            : { kind: sub },
        );
      }
      return { kind, ops };
    }
  }
}

export interface Sequence {
  seed: number;
  actions: Action[];
}

export function genSequence(seed: number, minLen = 5, maxLen = 60): Sequence {
  const rng = new Rng(seed);
  const length = rng.int(minLen, maxLen);
  const actions: Action[] = [];
  for (let i = 0; i < length; i++) actions.push(genAction(rng));
  return { seed, actions };
}

// ─── Corruption payloads with construction-derived expectations ─────────────

export interface KeychainContent {
  username: string;
  password: unknown;
  /** What a correct load must return for this content (null = discard). */
  expected: PersistedSession | null;
}

function shuffleKeys(
  obj: Record<string, unknown>,
  rng: Rng,
): Record<string, unknown> {
  const keys = Object.keys(obj);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const a = keys[i];
    const b = keys[j];
    if (a !== undefined && b !== undefined) {
      keys[i] = b;
      keys[j] = a;
    }
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

export function corruptionContent(
  corruption: CorruptionKind,
  spec: SessionSpec,
  cut: number | undefined,
): KeychainContent {
  const record = materialize(spec);
  const json = JSON.stringify(record);
  const base: Record<string, unknown> = { ...record };
  const valid = (password: unknown, username = 'session'): KeychainContent => ({
    username,
    password,
    expected: record,
  });
  const invalid = (
    password: unknown,
    username = 'session',
  ): KeychainContent => ({
    username,
    password,
    expected: null,
  });
  const withField = (field: string, value: unknown): string => {
    const copy: Record<string, unknown> = { ...base };
    copy[field] = value;
    return JSON.stringify(copy);
  };
  const without = (field: string): string => {
    const copy: Record<string, unknown> = { ...base };
    delete copy[field];
    return JSON.stringify(copy);
  };
  switch (corruption) {
    case 'emptyString':
      return invalid('');
    case 'jsonNull':
      return invalid('null');
    case 'jsonArray':
      return invalid(JSON.stringify([record]));
    case 'jsonEmptyObject':
      return invalid('{}');
    case 'jsonString':
      return invalid(JSON.stringify(json));
    case 'jsonNumber':
      return invalid('42');
    case 'jsonBoolean':
      return invalid('true');
    case 'truncated': {
      // Any proper prefix of a compact JSON object is not valid JSON.
      const at = Math.max(
        1,
        Math.min(json.length - 1, Math.floor((cut ?? 0.5) * json.length)),
      );
      return invalid(json.slice(0, at));
    }
    case 'trailingGarbage':
      return invalid(`${json}\u0000trailing`);
    case 'bomPrefixed':
      return invalid(`\uFEFF${json}`);
    case 'nanLiteral':
      return invalid(json.replace('"version":1', '"version":NaN'));
    case 'nestedWrapper':
      return invalid(JSON.stringify({ session: record }));
    case 'hugeGarbage':
      return invalid('\u00ff'.repeat(2 * 1024 * 1024));
    case 'version2':
      return invalid(withField('version', 2));
    case 'versionString':
      return invalid(withField('version', '1'));
    case 'versionMissing':
      return invalid(without('version'));
    case 'versionFraction':
      return invalid(withField('version', 1.5));
    case 'providerUnknown':
      return invalid(withField('provider', 'facebook'));
    case 'providerCapitalised':
      return invalid(withField('provider', 'Apple'));
    case 'providerEmpty':
      return invalid(withField('provider', ''));
    case 'providerMissing':
      return invalid(without('provider'));
    case 'userIdEmpty':
      return invalid(withField('canonicalAppUserId', ''));
    case 'userIdNumber':
      return invalid(withField('canonicalAppUserId', 12345));
    case 'userIdMissing':
      return invalid(without('canonicalAppUserId'));
    case 'refreshTokenEmpty':
      return invalid(withField('refreshToken', ''));
    case 'refreshTokenNumber':
      return invalid(withField('refreshToken', 0));
    case 'refreshTokenMissing':
      return invalid(without('refreshToken'));
    case 'refreshTokenArray':
      return invalid(withField('refreshToken', [record.refreshToken]));
    case 'bitflip': {
      // Flip one character of the structural prefix (before the token value)
      // so the mutation is guaranteed to break the JSON or a required field.
      const prefixEnd = json.indexOf('"refreshToken"');
      const at = Math.max(
        0,
        Math.min(prefixEnd - 1, Math.floor((cut ?? 0.5) * prefixEnd)),
      );
      const ch = json.charCodeAt(at);
      const flipped = String.fromCharCode(ch ^ 0x40);
      const mutated = json.slice(0, at) + flipped + json.slice(at + 1);
      return {
        username: 'session',
        password: mutated,
        expected: expectedFromContent(mutated),
      };
    }
    case 'prettyPrinted':
      return valid(JSON.stringify(record, null, 2));
    case 'keysShuffled':
      return valid(JSON.stringify(shuffleKeys(base, new Rng(json.length))));
    case 'extraKeys':
      return valid(
        JSON.stringify({ ...base, legacy: true, nested: { a: [1, 2] } }),
      );
    case 'extraAccessTokenKey':
      return valid(
        JSON.stringify({ ...base, accessToken: 'ACCESS-SHOULD-NOT-SURFACE' }),
      );
    case 'protoKey':
      return valid(`{"__proto__":{"polluted":"yes"},${json.slice(1)}`);
    case 'emailNumber':
      return {
        username: 'session',
        password: withField('email', 42),
        expected: { ...record, email: null },
      };
    case 'displayNameObject':
      return {
        username: 'session',
        password: withField('displayName', { first: 'A' }),
        expected: { ...record, displayName: null },
      };
    case 'optionalsMissing': {
      const copy: Record<string, unknown> = { ...base };
      delete copy['email'];
      delete copy['displayName'];
      return {
        username: 'session',
        password: JSON.stringify(copy),
        expected: { ...record, email: null, displayName: null },
      };
    }
    case 'versionOnePointZero':
      return valid(json.replace('"version":1', '"version":1.0'));
    case 'duplicateKeysLastWins':
      return valid(`{"version":2,"provider":"facebook",${json.slice(1)}`);
    case 'usernameSwapped':
      return valid(json, 'someone-else');
    case 'oversizedValid': {
      const big = materialize({ ...spec, refreshTokenLength: 1024 * 1024 });
      return {
        username: 'session',
        password: JSON.stringify(big),
        expected: big,
      };
    }
  }
}

/** A flipped structural character usually breaks the JSON; when it happens to
 * leave valid JSON, the record is judged by the contract (independent of the
 * module's own parser). */
export function expectedFromContent(content: unknown): PersistedSession | null {
  if (typeof content !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  return contractNormalize(parsed);
}

/** The persisted-session contract as an independent normalizer. Used only
 * where the expectation cannot be derived from construction (bitflips). */
export function contractNormalize(value: unknown): PersistedSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const provider = r['provider'];
  const canonicalAppUserId = r['canonicalAppUserId'];
  const refreshToken = r['refreshToken'];
  if (r['version'] !== 1) return null;
  if (provider !== 'apple' && provider !== 'google') return null;
  if (typeof canonicalAppUserId !== 'string' || canonicalAppUserId === '')
    return null;
  if (typeof refreshToken !== 'string' || refreshToken === '') return null;
  return {
    version: 1,
    provider,
    canonicalAppUserId,
    refreshToken,
    email: typeof r['email'] === 'string' ? r['email'] : null,
    displayName: typeof r['displayName'] === 'string' ? r['displayName'] : null,
  };
}

// ─── Specification model ────────────────────────────────────────────────────

export interface ModelState {
  /** Content of the vault item, or null when absent. */
  item: KeychainContent | null;
}

export type OpResult =
  | { op: 'save'; value: boolean }
  | { op: 'load'; value: PersistedSession | null }
  | { op: 'clear'; value: undefined };

/** Sequential specification of the three operations under the current
 * faults. `garbage*` read faults deliver an unparseable password, so the
 * module must treat the item as malformed and discard it. */
export function modelStep(
  state: ModelState,
  faults: FaultState,
  action: Action,
): OpResult {
  if (action.kind === 'save' || action.kind === 'saveWide') {
    if (faults.moduleMissing || faults.setMode !== 'ok')
      return { op: 'save', value: false };
    const record = materialize(action.session);
    state.item = {
      username: 'session',
      password: JSON.stringify(record),
      expected: record,
    };
    return { op: 'save', value: true };
  }
  if (action.kind === 'saveUnserializable') {
    return { op: 'save', value: false };
  }
  if (action.kind === 'load') {
    if (
      faults.moduleMissing ||
      faults.getMode === 'reject' ||
      faults.getMode === 'false'
    ) {
      return { op: 'load', value: null };
    }
    if (!state.item) return { op: 'load', value: null };
    const expected = faults.getMode === 'ok' ? state.item.expected : null;
    if (expected === null && faults.resetMode === 'ok') state.item = null;
    return { op: 'load', value: expected };
  }
  if (action.kind === 'clear') {
    if (!faults.moduleMissing && faults.resetMode === 'ok') state.item = null;
    return { op: 'clear', value: undefined };
  }
  throw new Error(`modelStep: not an operation: ${action.kind}`);
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export type InvariantId =
  'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7' | 'I8' | 'I9';

export interface Violation {
  step: number;
  invariant: InvariantId;
  action: Action;
  detail: string;
}

export interface SequenceOutcome {
  seed: number;
  length: number;
  outcome: 'HELD' | 'BROKEN';
  violations: Violation[];
  actionsExecuted: number;
  opsExecuted: number;
  maxOpMs: number;
  durationMs: number;
  traceDigest: string;
}

export interface VaultApi {
  savePersistedSession(session: PersistedSession): Promise<boolean>;
  loadPersistedSession(): Promise<PersistedSession | null>;
  clearPersistedSession(): Promise<void>;
}

export const OP_TIME_BUDGET_MS = 2000;
const CONTRACT_KEYS = [
  'version',
  'provider',
  'canonicalAppUserId',
  'refreshToken',
  'email',
  'displayName',
].sort();

function summarizeAction(action: Action): string {
  switch (action.kind) {
    case 'save':
    case 'saveUnserializable':
      return `${action.kind}(${action.session.provider},${action.session.refreshTokenLength ?? action.session.refreshToken.length}b)`;
    case 'saveWide':
      return `saveWide(${action.smuggled})`;
    case 'corrupt':
      return `corrupt(${action.corruption})`;
    case 'fault':
      return `fault(${JSON.stringify(action.faults)})`;
    case 'foreignWrite':
      return `foreignWrite(${action.service})`;
    case 'concurrent':
      return `concurrent[${action.ops.map(summarizeAction).join(',')}]`;
    default:
      return action.kind;
  }
}

function digestValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return String(value);
  if (isPlainRecord(value) && typeof value['refreshToken'] === 'string') {
    const { refreshToken, ...rest } = value;
    return `rec:${fnv1a(JSON.stringify(rest))}:${digestString(refreshToken)}`;
  }
  return `obj:${fnv1a(JSON.stringify(value))}`;
}

function digestStore(store: Map<string, FakeItem>): string {
  const parts: string[] = [];
  for (const [service, item] of [...store.entries()].sort()) {
    parts.push(
      `${service}=${item.username}:${typeof item.password === 'string' ? digestString(item.password) : typeof item.password}`,
    );
  }
  return parts.join('|');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function shapeProblem(value: unknown): string | null {
  if (value === null) return null;
  if (!isPlainRecord(value))
    return `load returned non-plain value ${typeof value}`;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== CONTRACT_KEYS.join(',')) {
    return `load returned keys [${keys.join(',')}]`;
  }
  if (value['version'] !== 1) return 'version !== 1';
  if (value['provider'] !== 'apple' && value['provider'] !== 'google') {
    return `provider ${String(value['provider'])}`;
  }
  if (
    typeof value['canonicalAppUserId'] !== 'string' ||
    !value['canonicalAppUserId']
  ) {
    return 'canonicalAppUserId not a non-empty string';
  }
  if (typeof value['refreshToken'] !== 'string' || !value['refreshToken']) {
    return 'refreshToken not a non-empty string';
  }
  if (value['email'] !== null && typeof value['email'] !== 'string')
    return 'email type';
  if (
    value['displayName'] !== null &&
    typeof value['displayName'] !== 'string'
  ) {
    return 'displayName type';
  }
  return null;
}

function sameRecord(
  a: PersistedSession | null,
  b: PersistedSession | null,
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

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

function cloneState(state: ModelState): ModelState {
  return { item: state.item ? { ...state.item } : null };
}

function makeWideSession(
  spec: SessionSpec,
  smuggled: string,
): PersistedSession {
  const record: Record<string, unknown> = { ...materialize(spec) };
  record[smuggled] = `SMUGGLED-${smuggled}-VALUE`;
  return record as unknown as PersistedSession;
}

function makeUnserializable(spec: SessionSpec): PersistedSession {
  const record: Record<string, unknown> = { ...materialize(spec) };
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  record['displayName'] = cycle;
  return record as unknown as PersistedSession;
}

async function runOp(
  vault: VaultApi,
  action: Action,
): Promise<{ result: OpResult; threw: unknown }> {
  try {
    switch (action.kind) {
      case 'save':
        return {
          result: {
            op: 'save',
            value: await vault.savePersistedSession(
              materialize(action.session),
            ),
          },
          threw: undefined,
        };
      case 'saveWide':
        return {
          result: {
            op: 'save',
            value: await vault.savePersistedSession(
              makeWideSession(action.session, action.smuggled),
            ),
          },
          threw: undefined,
        };
      case 'saveUnserializable':
        return {
          result: {
            op: 'save',
            value: await vault.savePersistedSession(
              makeUnserializable(action.session),
            ),
          },
          threw: undefined,
        };
      case 'load':
        return {
          result: { op: 'load', value: await vault.loadPersistedSession() },
          threw: undefined,
        };
      case 'clear':
        await vault.clearPersistedSession();
        return { result: { op: 'clear', value: undefined }, threw: undefined };
      default:
        throw new Error(`runOp: not an operation: ${action.kind}`);
    }
  } catch (error) {
    return {
      result: { op: 'clear', value: undefined },
      threw: error ?? new Error('undefined thrown'),
    };
  }
}

export interface RunOptions {
  /** Invariants to evaluate; defaults to all. */
  invariants?: readonly InvariantId[];
}

/**
 * Executes one action sequence against the module and the fake Keychain,
 * checking every invariant after every step. Never throws for a module
 * failure — violations are returned so campaigns can tabulate them.
 */
export async function runSequence(
  vault: VaultApi,
  keychain: FakeKeychain,
  sequence: Sequence,
  options: RunOptions = {},
): Promise<SequenceOutcome> {
  const enabled = new Set<InvariantId>(
    options.invariants ?? [
      'I1',
      'I2',
      'I3',
      'I4',
      'I5',
      'I6',
      'I7',
      'I8',
      'I9',
    ],
  );
  const started = Date.now();
  keychain.reset();
  const state: ModelState = { item: null };
  const foreign = new Map<string, FakeItem>();
  const violations: Violation[] = [];
  const trace: string[] = [];
  let opsExecuted = 0;
  let maxOpMs = 0;

  const fail = (
    step: number,
    invariant: InvariantId,
    action: Action,
    detail: string,
  ) => {
    if (enabled.has(invariant))
      violations.push({ step, invariant, action, detail });
  };

  const checkCalls = (step: number, action: Action, from: number) => {
    for (const call of keychain.calls.slice(from)) {
      if (call.service !== SESSION_VAULT_SERVICE) {
        fail(
          step,
          'I4',
          action,
          `${call.op} used service ${String(call.service)}`,
        );
      }
      if (call.op === 'set') {
        if (call.username !== 'session')
          fail(step, 'I4', action, `set username ${String(call.username)}`);
        if (
          call.accessible !== ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
        ) {
          fail(step, 'I4', action, `set accessible ${String(call.accessible)}`);
        }
      }
    }
  };

  const checkForeign = (step: number, action: Action) => {
    for (const [service, item] of foreign) {
      const now = keychain.store.get(service);
      if (
        !now ||
        now.password !== item.password ||
        now.username !== item.username
      ) {
        fail(step, 'I5', action, `foreign item ${service} changed`);
      }
    }
    for (const service of keychain.store.keys()) {
      if (service !== SESSION_VAULT_SERVICE && !foreign.has(service)) {
        fail(step, 'I5', action, `unexpected item under ${service}`);
      }
    }
  };

  const checkStoreAgainstModel = (step: number, action: Action) => {
    const actual = keychain.store.get(SESSION_VAULT_SERVICE);
    const expected = state.item;
    if (!expected && actual) {
      fail(
        step,
        'I3',
        action,
        'Keychain holds an item the model says is absent',
      );
    } else if (expected && !actual) {
      fail(
        step,
        'I3',
        action,
        'Keychain lost the item the model says is present',
      );
    } else if (expected && actual && actual.password !== expected.password) {
      // Same record under a different encoding is a contract (I6) question —
      // the model's content is the six-key whitelist serialization.
      const smuggled =
        typeof actual.password === 'string' &&
        actual.password.includes('SMUGGLED-');
      if (
        smuggled &&
        sameRecord(expectedFromContent(actual.password), expected.expected)
      ) {
        fail(step, 'I6', action, 'stored payload carries a non-contract field');
      } else {
        fail(step, 'I3', action, 'Keychain content differs from the model');
      }
    }
  };

  const checkResult = (
    step: number,
    action: Action,
    actual: OpResult,
    threw: unknown,
    expected: OpResult,
    ms: number,
  ) => {
    if (threw !== undefined) {
      fail(step, 'I1', action, `operation threw: ${String(threw)}`);
      return;
    }
    if (ms > OP_TIME_BUDGET_MS)
      fail(step, 'I9', action, `operation took ${ms.toFixed(0)}ms`);
    if (actual.op === 'save') {
      const saved: unknown = actual.value;
      if (typeof saved !== 'boolean')
        fail(step, 'I2', action, `save resolved ${typeof saved}`);
    }
    if (actual.op === 'load') {
      const problem = shapeProblem(actual.value);
      if (problem) fail(step, 'I2', action, problem);
    }
    if (
      expected.op === 'save' &&
      actual.op === 'save' &&
      actual.value !== expected.value
    ) {
      fail(
        step,
        'I3',
        action,
        `save returned ${String(actual.value)}, model expects ${String(expected.value)}`,
      );
    }
    if (
      expected.op === 'load' &&
      actual.op === 'load' &&
      !sameRecord(actual.value, expected.value)
    ) {
      fail(
        step,
        'I3',
        action,
        `load returned ${digestValue(actual.value)}, model expects ${digestValue(expected.value)}`,
      );
    }
  };

  for (let step = 0; step < sequence.actions.length; step++) {
    const action = sequence.actions[step];
    if (!action) continue;
    const callsBefore = keychain.calls.length;
    const protoBefore = Object.keys(Object.prototype).length;

    switch (action.kind) {
      case 'save':
      case 'saveWide':
      case 'saveUnserializable':
      case 'load':
      case 'clear': {
        const expected = modelStep(state, keychain.faults, action);
        const t0 = Date.now();
        const { result, threw } = await runOp(vault, action);
        const ms = Date.now() - t0;
        maxOpMs = Math.max(maxOpMs, ms);
        opsExecuted++;
        checkResult(step, action, result, threw, expected, ms);
        trace.push(
          `${step}:${summarizeAction(action)}=>${digestValue(result.value)}`,
        );
        break;
      }
      case 'corrupt': {
        const content = corruptionContent(
          action.corruption,
          action.session,
          action.cut,
        );
        keychain.store.set(SESSION_VAULT_SERVICE, {
          username: content.username,
          password: content.password,
          accessible: ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        });
        state.item = content;
        trace.push(`${step}:${summarizeAction(action)}`);
        break;
      }
      case 'externalDelete':
        keychain.store.delete(SESSION_VAULT_SERVICE);
        state.item = null;
        trace.push(`${step}:externalDelete`);
        break;
      case 'foreignWrite': {
        const item: FakeItem = {
          username: 'foreign',
          password: action.payload,
        };
        keychain.store.set(action.service, item);
        foreign.set(action.service, { ...item });
        trace.push(`${step}:${summarizeAction(action)}`);
        break;
      }
      case 'fault':
        Object.assign(keychain.faults, action.faults);
        trace.push(`${step}:${summarizeAction(action)}`);
        break;
      case 'concurrent': {
        const faultsSnapshot = { ...keychain.faults };
        const before = cloneState(state);
        const t0 = Date.now();
        const outcomes = await Promise.all(
          action.ops.map(op => runOp(vault, op)),
        );
        const ms = Date.now() - t0;
        maxOpMs = Math.max(maxOpMs, ms);
        opsExecuted += action.ops.length;
        outcomes.forEach((o, i) => {
          const op = action.ops[i];
          if (!op) return;
          if (o.threw !== undefined)
            fail(
              step,
              'I1',
              action,
              `concurrent ${summarizeAction(op)} threw: ${String(o.threw)}`,
            );
          if (o.result.op === 'load') {
            const problem = shapeProblem(o.result.value);
            if (problem)
              fail(step, 'I2', action, `concurrent load: ${problem}`);
          }
        });
        if (ms > OP_TIME_BUDGET_MS)
          fail(step, 'I9', action, `batch took ${ms.toFixed(0)}ms`);
        // Linearizability: some sequential ordering explains results + final content.
        const actualContent =
          keychain.store.get(SESSION_VAULT_SERVICE)?.password ?? null;
        const indices = action.ops.map((_, i) => i);
        let explained: ModelState | null = null;
        for (const order of permutations(indices)) {
          const candidate = cloneState(before);
          const results: OpResult[] = new Array<OpResult>(action.ops.length);
          for (const i of order) {
            const op = action.ops[i];
            if (!op) continue;
            results[i] = modelStep(candidate, faultsSnapshot, op);
          }
          const matchesResults = outcomes.every((o, i) => {
            const r = results[i];
            if (!r) return false;
            if (r.op === 'save' && o.result.op === 'save')
              return r.value === o.result.value;
            if (r.op === 'load' && o.result.op === 'load')
              return sameRecord(r.value, o.result.value);
            return r.op === o.result.op;
          });
          const candidateContent = candidate.item?.password ?? null;
          if (
            matchesResults &&
            contentEquivalent(candidateContent, actualContent)
          ) {
            explained = candidate;
            break;
          }
        }
        if (explained) {
          state.item = explained.item;
        } else {
          fail(
            step,
            'I7',
            action,
            `no serialization explains results [${outcomes.map(o => digestValue(o.result.value)).join(',')}] with final content ${
              actualContent === null ? 'absent' : 'present'
            }`,
          );
          // Re-sync the model to reality so later steps are judged on their own.
          const actual = keychain.store.get(SESSION_VAULT_SERVICE);
          state.item = actual
            ? {
                username: actual.username,
                password: actual.password,
                expected: expectedFromContent(actual.password),
              }
            : null;
        }
        trace.push(
          `${step}:${summarizeAction(action)}=>${outcomes.map(o => digestValue(o.result.value)).join(',')}`,
        );
        break;
      }
    }

    checkCalls(step, action, callsBefore);
    checkForeign(step, action);
    checkStoreAgainstModel(step, action);
    if (
      Object.keys(Object.prototype).length !== protoBefore ||
      'polluted' in {}
    ) {
      fail(step, 'I8', action, 'Object.prototype gained keys');
    }
    trace.push(`  store=${digestStore(keychain.store)}`);
  }

  return {
    seed: sequence.seed,
    length: sequence.actions.length,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    actionsExecuted: sequence.actions.length,
    opsExecuted,
    maxOpMs,
    durationMs: Date.now() - started,
    traceDigest: fnv1a(trace.join('\n')),
  };
}

/** Model content vs Keychain content, up to the contract projection: a wide
 * record the model tracks as its contract subset (judged by I6, not I7)
 * still counts as the same item. Presence/absence must agree exactly. */
function contentEquivalent(model: unknown, actual: unknown) {
  if (model === actual) return true;
  if (typeof model !== 'string' || typeof actual !== 'string') return false;
  const expected = expectedFromContent(model);
  return expected !== null && sameRecord(expected, expectedFromContent(actual));
}

// ─── Minimization (greedy one-step ddmin) ───────────────────────────────────

export async function minimizeSequence(
  vault: VaultApi,
  keychain: FakeKeychain,
  sequence: Sequence,
  invariant: InvariantId,
  options: RunOptions = {},
): Promise<Sequence> {
  const reproduces = async (actions: Action[]) => {
    const outcome = await runSequence(
      vault,
      keychain,
      { seed: sequence.seed, actions },
      options,
    );
    return outcome.violations.some(v => v.invariant === invariant);
  };
  let current = [...sequence.actions];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < current.length; i++) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      if (candidate.length === 0) continue;
      if (await reproduces(candidate)) {
        current = candidate;
        changed = true;
        i--;
      }
    }
    // Shrink concurrent batches to their smallest reproducing subset.
    for (let i = 0; i < current.length; i++) {
      for (let j = 0; ; j++) {
        const action = current[i];
        if (!action || action.kind !== 'concurrent') break;
        if (action.ops.length <= 2 || j >= action.ops.length) break;
        const ops = [...action.ops.slice(0, j), ...action.ops.slice(j + 1)];
        const candidate = [...current];
        candidate[i] = { kind: 'concurrent', ops };
        if (await reproduces(candidate)) {
          current = candidate;
          changed = true;
          j--;
        }
      }
    }
  }
  return { seed: sequence.seed, actions: current };
}
