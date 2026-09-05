/**
 * STRESS — sessionVault, lens `boundary-malformed`.
 *
 * The Keychain record is the only durable credential on the device. This
 * suite throws seeded, replayable garbage at `src/account/sessionVault.ts`
 * and checks the module's documented contract under every input:
 *
 *  - `loadPersistedSession()` NEVER throws. It returns either `null` or a
 *    record that is exactly `{version:1, provider, canonicalAppUserId,
 *    refreshToken, email, displayName}` with the documented types — never an
 *    extra key (a tampered record must not resurrect an access token), never
 *    a polluted prototype.
 *  - A malformed record is DISCARDED (the Keychain item is reset) and load
 *    never WRITES (no `setGenericPassword`). A well-formed record is left
 *    byte-for-byte untouched. Items under other services are never touched.
 *  - `savePersistedSession()` NEVER throws: an unserialisable value (BigInt,
 *    cycle, throwing toJSON) or a Keychain failure yields `false` and no
 *    write; a Keychain success yields `true`.
 *  - `clearPersistedSession()` NEVER throws.
 *  - Adversarial-but-valid content (null bytes, 64 KB+ strings, lone
 *    surrogates, NFC/NFD pairs, JSON metacharacters, path-traversal ids)
 *    round-trips save → load unchanged: no truncation, no normalisation.
 *  - Keychain faults (throws of any shape, `false`, malformed result
 *    objects, non-string passwords, a missing native module) degrade to
 *    "nothing persisted", never to a rejection.
 *
 * Every iteration derives from `STRESS_SEED` + campaign + index through a
 * mulberry32 generator, so any row of the JSON table can be replayed with
 * `STRESS_REPLAY=<campaign>:<seed>`. `STRESS_ITER` scales each campaign
 * (default keeps the suite in the seconds range); `STRESS_MAX_BYTES` caps
 * the oversized-string generator. The table of seed → outcome is written to
 * `STRESS_OUT` (default `<repo>/artifacts/stress/`).
 *
 * The oracle is an independent re-statement of the contract (not a copy of
 * the implementation): parse with JSON.parse, require a plain object with
 * version === 1, provider ∈ {apple, google}, non-empty string id and
 * refresh token; email/displayName are kept only when they are strings.
 */
import type { PersistedSession } from '../../src/account/sessionVault';

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings (see networkAuthAdversarial.test.ts), so the shims stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const path = require('path') as { join: (...parts: string[]) => string };

// ─── Fault-injectable Keychain ───────────────────────────────────────────────

type KeychainFault =
  | { kind: 'none' }
  | { kind: 'get-throws'; error: unknown }
  | { kind: 'get-returns'; value: unknown }
  | { kind: 'set-throws'; error: unknown }
  | { kind: 'set-returns'; value: unknown }
  | { kind: 'reset-throws'; error: unknown };

interface StoredItem {
  username: string;
  password: string;
  accessible?: string;
}

const mockKeychain = {
  store: new Map<string, StoredItem>(),
  fault: { kind: 'none' } as KeychainFault,
  log: [] as Array<{
    op: 'get' | 'set' | 'reset';
    service: string | undefined;
  }>,
  reset() {
    this.store.clear();
    this.fault = { kind: 'none' };
    this.log.length = 0;
  },
};
const keychain = mockKeychain;

const mockKeychainModule = {
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly',
  },
  setGenericPassword: async (
    username: string,
    password: string,
    options: { service?: string; accessible?: string } = {},
  ) => {
    mockKeychain.log.push({ op: 'set', service: options.service });
    if (mockKeychain.fault.kind === 'set-throws')
      throw mockKeychain.fault.error;
    if (mockKeychain.fault.kind === 'set-returns')
      return mockKeychain.fault.value;
    mockKeychain.store.set(options.service ?? '__default__', {
      username,
      password,
      accessible: options.accessible,
    });
    return { service: options.service, storage: 'mock' };
  },
  getGenericPassword: async (options: { service?: string } = {}) => {
    mockKeychain.log.push({ op: 'get', service: options.service });
    if (mockKeychain.fault.kind === 'get-throws')
      throw mockKeychain.fault.error;
    if (mockKeychain.fault.kind === 'get-returns')
      return mockKeychain.fault.value;
    const item = mockKeychain.store.get(options.service ?? '__default__');
    if (!item) return false;
    return { service: options.service, storage: 'mock', ...item };
  },
  resetGenericPassword: async (options: { service?: string } = {}) => {
    mockKeychain.log.push({ op: 'reset', service: options.service });
    if (mockKeychain.fault.kind === 'reset-throws')
      throw mockKeychain.fault.error;
    return mockKeychain.store.delete(options.service ?? '__default__');
  },
};

jest.mock('react-native-keychain', () => mockKeychainModule);

// Imported after the mock is registered (jest hoists jest.mock anyway; the
// require keeps the intent explicit and lets the missing-module campaign use
// jest.isolateModules with a different factory).
const vault = require('../../src/account/sessionVault') as {
  SESSION_VAULT_SERVICE: string;
  savePersistedSession: (session: PersistedSession) => Promise<boolean>;
  loadPersistedSession: () => Promise<PersistedSession | null>;
  clearPersistedSession: () => Promise<void>;
};
const { SESSION_VAULT_SERVICE } = vault;
const DECOY_SERVICE = 'com.picklesensei.decoy.other-item';

// ─── Seeded RNG ──────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(...parts: Array<string | number>): number {
  // FNV-1a over the textual parts: campaign name + base seed + index.
  let h = 0x811c9dc5;
  for (const part of parts) {
    for (const ch of String(part)) {
      h ^= ch.codePointAt(0) ?? 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x9e3779b9;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

class Rng {
  private readonly next: () => number;
  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
}

// ─── Configuration ───────────────────────────────────────────────────────────

const BASE_SEED = Number(process.env.STRESS_SEED ?? '20260905');
const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? '800'));
const MAX_BYTES = Math.max(
  65_536,
  Number(process.env.STRESS_MAX_BYTES ?? String(256 * 1024)),
);
const REPLAY = process.env.STRESS_REPLAY ?? null;
const OUT_DIR =
  process.env.STRESS_OUT ??
  path.join(__dirname, '..', '..', '..', '..', 'artifacts', 'stress');

// ─── Generators ──────────────────────────────────────────────────────────────

const VALID_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';

function validSession(rng: Rng): PersistedSession {
  return {
    version: 1,
    provider: rng.bool() ? 'apple' : 'google',
    canonicalAppUserId: VALID_ID,
    refreshToken: `rt-${rng.int(1e9).toString(36)}`,
    email: rng.bool(0.7) ? `user${rng.int(1e6)}@example.test` : null,
    displayName: rng.bool(0.7) ? `Player ${rng.int(1e4)}` : null,
  };
}

const ASTRAL = ['😀', '🏓', '👨‍👩‍👧‍👦', '🇺🇸', '𝔘𝔫𝔦', '👍🏽'];
const CONTROL = [
  '\u0000',
  '\u0001',
  '\u0007',
  '\u001b',
  '\u007f',
  '\r',
  '\n',
  '\t',
];
const UNICODE_TRAPS = [
  '\u202e', // RTL override
  '\u200b', // zero-width space
  '\u200d', // ZWJ
  '\ufeff', // BOM
  '\u2028', // line separator (JS-line-terminator, JSON-legal)
  '\u2029',
  '\ud83d', // lone high surrogate
  '\udc00', // lone low surrogate
  'e\u0301', // NFD é
  '\u00e9', // NFC é
  'ﬁ', // ligature (NFKC-folds)
  'Ａ', // fullwidth A
  '\u0130', // İ (Turkish dotted I)
  'ß',
];
const TRAVERSAL = [
  '../../etc/passwd',
  '..\\..\\Windows\\system32',
  '%2e%2e%2f%2e%2e%2f',
  '/dev/null',
  'file:///var/mobile/Containers',
  `${VALID_ID}/../other`,
  `..%00${VALID_ID}`,
  '\u0000',
  '   ',
  '\t\n',
];

function junkString(rng: Rng, maxLen = 48): string {
  const len = rng.int(maxLen + 1);
  let out = '';
  for (let i = 0; i < len; i++) {
    switch (rng.int(6)) {
      case 0:
        out += String.fromCharCode(0x20 + rng.int(0x5f));
        break;
      case 1:
        out += rng.pick(CONTROL);
        break;
      case 2:
        out += rng.pick(UNICODE_TRAPS);
        break;
      case 3:
        out += rng.pick(ASTRAL);
        break;
      case 4:
        out += rng.pick(['"', '\\', '{', '}', '[', ']', ':', ',', "'", '`']);
        break;
      default:
        out += String.fromCharCode(rng.int(0x10000));
    }
  }
  return out;
}

/** A string sized in BYTES, CODE POINTS or GRAPHEMES so the three caps are
 * exercised: 64 KB of ASCII, 64 K astral code points (~256 KB), or 64 K
 * multi-code-point grapheme clusters (~700 KB). */
function oversizedString(rng: Rng): { value: string; unit: string } {
  const unit = rng.pick(['bytes', 'codepoints', 'graphemes'] as const);
  const target = 65_536 + rng.int(3) * 1024;
  if (unit === 'bytes') {
    const n = Math.min(target * (1 + rng.int(4)), MAX_BYTES);
    return { value: 'x'.repeat(n), unit: `${n} bytes` };
  }
  if (unit === 'codepoints') {
    const n = Math.min(target, Math.floor(MAX_BYTES / 4));
    return { value: '🏓'.repeat(n), unit: `${n} codepoints` };
  }
  const n = Math.min(target, Math.floor(MAX_BYTES / 11));
  return { value: '👨‍👩‍👧'.repeat(n), unit: `${n} graphemes` };
}

const WRONG_TYPE_VALUES: ReadonlyArray<() => unknown> = [
  () => null,
  () => true,
  () => false,
  () => 0,
  () => -0,
  () => 1,
  () => -1,
  () => 1.5,
  () => Number.MAX_SAFE_INTEGER + 2,
  () => 1e308,
  () => [],
  () => [1],
  () => ['apple'],
  () => ({}),
  () => ({ value: 'apple' }),
  () => '',
];

function wrongTypeJson(rng: Rng): string {
  // Values JSON can carry directly plus the numeric literals JSON.parse maps
  // to Infinity / -0 / imprecise integers.
  const literals = [
    'null',
    'true',
    'false',
    '0',
    '-0',
    '1e999',
    '-1e999',
    '1e-999',
    '9007199254740993',
    '18446744073709551616',
    '1.0',
    '1e0',
    '0.999999999999999999999',
    '[]',
    '[1]',
    '["apple"]',
    '{}',
    '{"value":"apple"}',
    '""',
    '"\\u0000"',
  ];
  return rng.pick(literals);
}

function providerVariant(rng: Rng): string {
  return JSON.stringify(
    rng.pick([
      'Apple',
      'APPLE',
      ' apple',
      'apple ',
      'apple\u0000',
      'google\n',
      'Google',
      'facebook',
      'ａｐｐｌｅ',
      'appl\u0435', // Cyrillic е
      'g\u006fogle', // same as google — VALID via escape
      '',
      'apple/google',
    ]),
  );
}

function versionVariant(rng: Rng): string {
  return rng.pick([
    '0',
    '2',
    '999',
    '-1',
    '"1"',
    '1.5',
    '1.0000001',
    '1.0',
    '1e0',
    '1.00000000000000001', // parses to 1 → VALID
    '10e-1', // parses to 1 → VALID
    '[1]',
    '{"v":1}',
    'null',
    'true',
    '9007199254740993',
    '1e999',
    '-0',
  ]);
}

interface RawCase {
  category: string;
  raw: string;
  note?: string;
}

/** Builds the raw Keychain password for one iteration. */
function malformedRaw(rng: Rng): RawCase {
  const base = validSession(rng);
  const baseJson = JSON.stringify(base);
  switch (rng.int(18)) {
    case 0: {
      const cut = rng.int(baseJson.length);
      return { category: 'truncated-json', raw: baseJson.slice(0, cut) };
    }
    case 1:
      return { category: 'garbage', raw: junkString(rng, 64) };
    case 2:
      return { category: 'non-object-json', raw: wrongTypeJson(rng) };
    case 3: {
      const field = rng.pick([
        'version',
        'provider',
        'canonicalAppUserId',
        'refreshToken',
        'email',
        'displayName',
      ] as const);
      const value = rng.pick(WRONG_TYPE_VALUES)();
      const record: Record<string, unknown> = { ...base };
      record[field] = value;
      return {
        category: `wrong-type:${field}`,
        raw: JSON.stringify(record),
        note: `${field}=${JSON.stringify(value)}`,
      };
    }
    case 4: {
      const v = versionVariant(rng);
      return {
        category: 'version-variant',
        raw: baseJson.replace('"version":1', `"version":${v}`),
        note: `version=${v}`,
      };
    }
    case 5: {
      const p = providerVariant(rng);
      return {
        category: 'provider-variant',
        raw: baseJson.replace(
          `"provider":"${base.provider}"`,
          `"provider":${p}`,
        ),
        note: `provider=${p}`,
      };
    }
    case 6: {
      const key = rng.pick(['__proto__', 'constructor', 'prototype']);
      const payload = rng.pick([
        '{"polluted":true}',
        '{"prototype":{"polluted":true}}',
        '"polluted"',
        'null',
      ]);
      const where = rng.pick(['top', 'email', 'both'] as const);
      let raw = baseJson;
      if (where !== 'email') raw = raw.replace('{', `{"${key}":${payload},`);
      if (where !== 'top') {
        raw = raw.replace(
          /"email":(null|"[^"]*")/,
          `"email":{"${key}":${payload}}`,
        );
      }
      return { category: 'prototype-pollution', raw, note: `${key}@${where}` };
    }
    case 7: {
      const field = rng.pick([
        'canonicalAppUserId',
        'refreshToken',
        'email',
        'displayName',
      ] as const);
      const big = oversizedString(rng);
      const record: Record<string, unknown> = { ...base, [field]: big.value };
      return {
        category: `oversized:${field}`,
        raw: JSON.stringify(record),
        note: big.unit,
      };
    }
    case 8: {
      const id = rng.pick(TRAVERSAL);
      const record = { ...base, canonicalAppUserId: id };
      return {
        category: 'traversal-id',
        raw: JSON.stringify(record),
        note: JSON.stringify(id),
      };
    }
    case 9: {
      // Duplicate keys: JSON.parse keeps the LAST occurrence.
      const dupField = rng.pick([
        'version',
        'provider',
        'refreshToken',
      ] as const);
      const first = rng.pick(['1', '"apple"', '"x"', '2', 'null']);
      return {
        category: 'duplicate-key',
        raw: baseJson.replace('{', `{"${dupField}":${first},`),
        note: `${dupField} first=${first}`,
      };
    }
    case 10:
      return {
        category: 'empty-container',
        raw: rng.pick([
          '{}',
          '[]',
          '',
          ' ',
          '{"version":1}',
          '[{}]',
          '{"":""}',
        ]),
      };
    case 11: {
      const extra = rng.pick([
        'accessToken',
        'idToken',
        'identityToken',
        'authorizationCode',
        'bearerToken',
        'password',
        '__proto__',
        'toString',
        'hasOwnProperty',
        'valueOf',
      ]);
      const record: Record<string, unknown> = {
        ...base,
        [extra]: junkString(rng, 16),
      };
      return {
        category: 'extra-key',
        raw: JSON.stringify(record),
        note: extra,
      };
    }
    case 12: {
      const depth = rng.pick([64, 1_000, 10_000, 50_000]);
      const open = rng.bool() ? '[' : '{"a":';
      const close = open === '[' ? ']' : '}';
      return {
        category: 'deep-nesting',
        raw: open.repeat(depth) + '1' + close.repeat(depth),
        note: `depth=${depth}`,
      };
    }
    case 13: {
      // NFC / NFD pairs in the string fields: kept verbatim, never normalised.
      const pair = rng.pick([
        ['\u00e9', 'e\u0301'],
        ['\u00f1', 'n\u0303'],
        ['\u1e69', 's\u0323\u0307'],
        ['\uac00', '\u1100\u1161'],
      ] as const);
      const record = {
        ...base,
        email: `caf${pair[0]}@example.test`,
        displayName: `caf${pair[1]}`,
      };
      return {
        category: 'unicode-normalization',
        raw: JSON.stringify(record),
        note: JSON.stringify(pair),
      };
    }
    case 14: {
      const prefix = rng.pick([
        '\ufeff',
        '\u0000',
        ' ',
        '\n',
        '//c\n',
        '\u200b',
      ]);
      return {
        category: 'prefixed-json',
        raw: prefix + baseJson,
        note: JSON.stringify(prefix),
      };
    }
    case 15: {
      const mutated = rng.pick([
        baseJson.replace(/"/g, "'"),
        baseJson.replace('}', ',}'),
        baseJson.replace('{', '{/*c*/'),
        baseJson.replace(':', '='),
        `${baseJson}${baseJson}`,
        `[${baseJson}]`,
        baseJson.replace('"version":1', '"version":01'),
        baseJson.replace('"version":1', '"version":+1'),
        baseJson.replace('"version":1', '"version":0x1'),
        baseJson.replace('"version":1', '"version":NaN'),
        baseJson.replace('"version":1', '"version":Infinity'),
        baseJson.replace('"version":1', '"version":undefined'),
      ]);
      return { category: 'json5-ish', raw: mutated };
    }
    case 16: {
      // Byte-level corruption: flip / drop / insert random UTF-16 units.
      const chars = Array.from(baseJson);
      const edits = 1 + rng.int(4);
      for (let i = 0; i < edits; i++) {
        const at = rng.int(chars.length);
        const op = rng.int(3);
        if (op === 0) chars[at] = String.fromCharCode(rng.int(0x100));
        else if (op === 1) chars.splice(at, 1);
        else chars.splice(at, 0, rng.pick(CONTROL));
      }
      return {
        category: 'bit-rot',
        raw: chars.join(''),
        note: `edits=${edits}`,
      };
    }
    default: {
      // Missing one or more required fields.
      const record: Record<string, unknown> = { ...base };
      const drop = rng.pick([
        ['version'],
        ['provider'],
        ['canonicalAppUserId'],
        ['refreshToken'],
        ['version', 'provider'],
        ['email', 'displayName'],
        ['canonicalAppUserId', 'refreshToken'],
      ]);
      for (const key of drop) delete record[key];
      return {
        category: 'missing-field',
        raw: JSON.stringify(record),
        note: drop.join(','),
      };
    }
  }
}

// ─── Oracle ──────────────────────────────────────────────────────────────────

const EXPECTED_KEYS = [
  'version',
  'provider',
  'canonicalAppUserId',
  'refreshToken',
  'email',
  'displayName',
].sort();

/** Independent statement of the record contract. */
function oracle(raw: unknown): PersistedSession | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const r = parsed as Record<string, unknown>;
  if (r.version !== 1) return null;
  if (r.provider !== 'apple' && r.provider !== 'google') return null;
  if (typeof r.canonicalAppUserId !== 'string' || r.canonicalAppUserId === '') {
    return null;
  }
  if (typeof r.refreshToken !== 'string' || r.refreshToken === '') return null;
  return {
    version: 1,
    provider: r.provider,
    canonicalAppUserId: r.canonicalAppUserId,
    refreshToken: r.refreshToken,
    email: typeof r.email === 'string' ? r.email : null,
    displayName: typeof r.displayName === 'string' ? r.displayName : null,
  };
}

function prototypeIsClean(): string | null {
  const probe: Record<string, unknown> = {};
  if ('polluted' in probe) return 'Object.prototype gained "polluted"';
  if (Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')) {
    return 'Object.prototype own "polluted"';
  }
  if (
    typeof (Object.prototype as { polluted?: unknown }).polluted !== 'undefined'
  ) {
    return 'Object.prototype.polluted defined';
  }
  return null;
}

function shapeViolation(result: PersistedSession): string | null {
  if (Object.getPrototypeOf(result) !== Object.prototype) {
    return 'result prototype is not Object.prototype';
  }
  const keys = Object.keys(result).sort();
  if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_KEYS)) {
    return `unexpected key set ${JSON.stringify(keys)}`;
  }
  if (Object.prototype.hasOwnProperty.call(result, '__proto__')) {
    return 'own __proto__ key on result';
  }
  if (result.version !== 1) return 'version !== 1';
  if (result.provider !== 'apple' && result.provider !== 'google') {
    return `provider ${String(result.provider)}`;
  }
  if (
    typeof result.canonicalAppUserId !== 'string' ||
    !result.canonicalAppUserId
  ) {
    return 'canonicalAppUserId not a non-empty string';
  }
  if (typeof result.refreshToken !== 'string' || !result.refreshToken) {
    return 'refreshToken not a non-empty string';
  }
  if (result.email !== null && typeof result.email !== 'string') {
    return 'email neither string nor null';
  }
  if (result.displayName !== null && typeof result.displayName !== 'string') {
    return 'displayName neither string nor null';
  }
  return null;
}

// ─── Result table ────────────────────────────────────────────────────────────

type Outcome = 'HELD' | 'BROKEN' | 'GAP';

interface Row {
  campaign: string;
  index: number;
  seed: number;
  category: string;
  note?: string;
  outcome: Outcome;
  detail?: string;
  durationMs: number;
}

const rows: Row[] = [];

function seedFor(campaign: string, index: number): number {
  return hashSeed(campaign, BASE_SEED, index);
}

function iterations(campaign: string): number[] {
  if (REPLAY) {
    const [name, seed] = REPLAY.split(':');
    if (name !== campaign) return [];
    // Replay by seed: locate its index (fall back to running the seed raw).
    for (let i = 0; i < ITER * 4; i++) {
      if (seedFor(campaign, i) === Number(seed)) return [i];
    }
    return [-Number(seed)];
  }
  return Array.from({ length: ITER }, (_, i) => i);
}

function rngFor(campaign: string, index: number): Rng {
  return new Rng(index < 0 ? -index : seedFor(campaign, index));
}

async function record(
  campaign: string,
  index: number,
  category: string,
  note: string | undefined,
  body: () => Promise<string | null>,
): Promise<void> {
  const seed = rngFor(campaign, index).seed;
  const started = Date.now();
  let detail: string | null;
  try {
    detail = await body();
  } catch (error) {
    detail = `THREW: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
  }
  rows.push({
    campaign,
    index,
    seed,
    category,
    note,
    outcome:
      detail === null ? 'HELD' : detail.startsWith('GAP:') ? 'GAP' : 'BROKEN',
    detail: detail ?? undefined,
    durationMs: Date.now() - started,
  });
}

function seedDecoy(): StoredItem {
  const decoy = { username: 'other', password: '{"unrelated":true}' };
  keychain.store.set(DECOY_SERVICE, decoy);
  return decoy;
}

function decoyIntact(decoy: StoredItem): string | null {
  const now = keychain.store.get(DECOY_SERVICE);
  if (!now || now.password !== decoy.password) {
    return 'decoy item under another service was modified/removed';
  }
  return null;
}

function writesDuringLoad(): string | null {
  const sets = keychain.log.filter(entry => entry.op === 'set');
  if (sets.length > 0) return `load performed ${sets.length} write(s)`;
  const foreign = keychain.log.filter(
    entry => entry.service !== SESSION_VAULT_SERVICE,
  );
  if (foreign.length > 0) {
    return `load touched service ${String(foreign[0]?.service)}`;
  }
  return null;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

beforeEach(() => {
  keychain.reset();
});

afterAll(() => {
  const byCampaign: Record<string, Record<Outcome, number>> = {};
  const byCategory: Record<string, Record<Outcome, number>> = {};
  for (const row of rows) {
    for (const [bucket, key] of [
      [byCampaign, row.campaign],
      [byCategory, `${row.campaign}/${row.category}`],
    ] as const) {
      const entry = (bucket[key] ??= { HELD: 0, BROKEN: 0, GAP: 0 });
      entry[row.outcome] += 1;
    }
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'session-vault-boundary-malformed.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        unit: 'mod-session-vault',
        lens: 'boundary-malformed',
        config: { BASE_SEED, ITER, MAX_BYTES, REPLAY },
        totals: {
          executed: rows.length,
          held: rows.filter(r => r.outcome === 'HELD').length,
          broken: rows.filter(r => r.outcome === 'BROKEN').length,
          gap: rows.filter(r => r.outcome === 'GAP').length,
          maxDurationMs: rows.reduce((m, r) => Math.max(m, r.durationMs), 0),
        },
        byCampaign,
        byCategory,
        failingSeeds: rows
          .filter(r => r.outcome !== 'HELD')
          .map(r => ({
            replay: `STRESS_REPLAY=${r.campaign}:${r.seed}`,
            category: r.category,
            note: r.note,
            outcome: r.outcome,
            detail: r.detail,
          })),
        rows,
      },
      null,
      2,
    ),
  );
});

// ─── Campaign A: malformed / hostile Keychain records → loadPersistedSession ─

describe('sessionVault stress — boundary/malformed (seeded, replayable)', () => {
  it('A. loadPersistedSession never throws, matches the oracle, discards malformed records without writing, and leaves prototypes and other items alone', async () => {
    const campaign = 'load-malformed';
    for (const index of iterations(campaign)) {
      const rng = rngFor(campaign, index);
      const testCase = malformedRaw(rng);
      keychain.reset();
      const decoy = seedDecoy();
      keychain.store.set(SESSION_VAULT_SERVICE, {
        username: 'session',
        password: testCase.raw,
      });
      await record(
        campaign,
        index,
        testCase.category,
        testCase.note,
        async () => {
          const expected = oracle(testCase.raw);
          const result = await vault.loadPersistedSession();
          const pollution = prototypeIsClean();
          if (pollution) return pollution;
          if (!same(result, expected)) {
            return `result ${JSON.stringify(result)?.slice(0, 200)} ≠ oracle ${JSON.stringify(expected)?.slice(0, 200)}`;
          }
          const writes = writesDuringLoad();
          if (writes) return writes;
          const decoyState = decoyIntact(decoy);
          if (decoyState) return decoyState;
          const stored = keychain.store.get(SESSION_VAULT_SERVICE);
          if (result === null) {
            if (stored)
              return 'malformed record was NOT discarded from the Keychain';
            const resets = keychain.log.filter(e => e.op === 'reset').length;
            if (resets !== 1) return `expected exactly 1 reset, saw ${resets}`;
          } else {
            const shape = shapeViolation(result);
            if (shape) return shape;
            if (!stored || stored.password !== testCase.raw) {
              return 'well-formed record was modified by load';
            }
            if (keychain.log.some(e => e.op === 'reset')) {
              return 'well-formed record triggered a reset';
            }
          }
          return null;
        },
      );
    }
    const failures = rows.filter(
      r => r.campaign === campaign && r.outcome === 'BROKEN',
    );
    expect(failures.map(f => `${f.seed}:${f.category}:${f.detail}`)).toEqual(
      [],
    );
    if (!REPLAY)
      expect(rows.filter(r => r.campaign === campaign).length).toBeGreaterThan(
        0,
      );
  });

  // ─── Campaign B: hostile values through savePersistedSession ──────────────

  it('B. savePersistedSession never throws: unserialisable input or a Keychain failure → false and no write; otherwise true and the exact JSON', async () => {
    const campaign = 'save-malformed';
    const hostileValues: ReadonlyArray<{
      label: string;
      make: (rng: Rng) => unknown;
    }> = [
      { label: 'bigint', make: () => BigInt(2) ** BigInt(64) },
      {
        label: 'cycle',
        make: () => {
          const o: Record<string, unknown> = {};
          o.self = o;
          return o;
        },
      },
      {
        label: 'toJSON-throws',
        make: () => ({
          toJSON() {
            throw new RangeError('toJSON boom');
          },
        }),
      },
      {
        label: 'toJSON-returns-bigint',
        make: () => ({ toJSON: () => BigInt(1) }),
      },
      {
        label: 'toJSON-returns-string',
        make: () => ({ toJSON: () => 'apple' }),
      },
      { label: 'symbol', make: () => Symbol('s') },
      { label: 'function', make: () => () => 'apple' },
      { label: 'undefined', make: () => undefined },
      { label: 'NaN', make: () => NaN },
      { label: 'Infinity', make: () => Infinity },
      { label: '-0', make: () => -0 },
      { label: 'Date', make: () => new Date(0) },
      { label: 'Map', make: () => new Map([['a', 1]]) },
      { label: 'nested-array', make: rng => [[[junkString(rng, 8)]]] },
      { label: 'oversized', make: rng => oversizedString(rng).value },
      { label: 'junk', make: rng => junkString(rng, 64) },
      { label: 'traversal', make: rng => rng.pick(TRAVERSAL) },
      {
        label: 'getter-throws',
        make: () => {
          const o = {};
          Object.defineProperty(o, 'x', {
            enumerable: true,
            get() {
              throw new Error('getter boom');
            },
          });
          return o;
        },
      },
      {
        label: 'proxy-throws',
        make: () =>
          new Proxy(
            {},
            {
              ownKeys() {
                throw new TypeError('proxy boom');
              },
            },
          ),
      },
    ];
    const fields = [
      'version',
      'provider',
      'canonicalAppUserId',
      'refreshToken',
      'email',
      'displayName',
    ] as const;

    for (const index of iterations(campaign)) {
      const rng = rngFor(campaign, index);
      const base = validSession(rng);
      let category: string;
      let note: string | undefined;
      let input: unknown;
      let fault: KeychainFault = { kind: 'none' };
      const mode = rng.int(6);
      if (mode === 0) {
        // Whole-value replacement (the argument itself is hostile).
        const hostile = rng.pick(hostileValues);
        category = `whole:${hostile.label}`;
        input = hostile.make(rng);
      } else if (mode === 1) {
        const hostile = rng.pick(hostileValues);
        const field = rng.pick(fields);
        category = `field:${hostile.label}`;
        note = field;
        input = { ...base, [field]: hostile.make(rng) };
      } else if (mode === 2) {
        const key = rng.pick(['__proto__', 'constructor', 'prototype']);
        category = 'prototype-key';
        note = key;
        // JSON.parse yields an OWN __proto__ property (not a setter call).
        input = JSON.parse(
          `{"${key}":{"polluted":true},${JSON.stringify(base).slice(1)}`,
        );
      } else if (mode === 3) {
        const which = rng.pick([
          {
            kind: 'set-throws',
            error: new Error('errSecDuplicateItem (simulated)'),
          },
          { kind: 'set-throws', error: 'string error' },
          { kind: 'set-throws', error: null },
          { kind: 'set-throws', error: { code: -25299 } },
          { kind: 'set-returns', value: false },
          { kind: 'set-returns', value: null },
          { kind: 'set-returns', value: undefined },
          { kind: 'set-returns', value: 0 },
          { kind: 'set-returns', value: '' },
          {
            kind: 'set-returns',
            value: { service: 'x', storage: 'KeychainMock' },
          },
        ] as const);
        fault = which;
        category = `keychain:${which.kind}`;
        note = JSON.stringify(
          which.kind === 'set-throws' ? String(which.error) : which.value,
        );
        input = base;
      } else if (mode === 4) {
        category = 'valid';
        input = base;
      } else {
        category = 'valid-adversarial-strings';
        input = {
          ...base,
          refreshToken: junkString(rng, 128) || 'rt',
          email: rng.bool() ? junkString(rng, 64) : null,
          displayName: rng.bool() ? junkString(rng, 64) : null,
        };
      }

      keychain.reset();
      const decoy = seedDecoy();
      keychain.fault = fault;
      await record(campaign, index, category, note, async () => {
        let serialised: string | null;
        let stringifyThrew = false;
        try {
          const text = JSON.stringify(input);
          serialised = typeof text === 'string' ? text : null;
        } catch {
          serialised = null;
          stringifyThrew = true;
        }
        const wouldWrite =
          serialised !== null &&
          fault.kind !== 'set-throws' &&
          fault.kind !== 'set-returns';
        const ok = await vault.savePersistedSession(input as PersistedSession);
        const pollution = prototypeIsClean();
        if (pollution) return pollution;
        const decoyState = decoyIntact(decoy);
        if (decoyState) return decoyState;
        const stored = keychain.store.get(SESSION_VAULT_SERVICE);
        if (serialised === null) {
          if (!stringifyThrew && ok !== false) {
            // JSON.stringify returned undefined (not a string) — the vault
            // forwards a non-string password to the Keychain. Unreachable
            // through the typed API; native behaviour is unknowable here.
            return `GAP: JSON.stringify(input) is undefined yet saved=${String(ok)}; a non-string password reached setGenericPassword (native result UNKNOWN from Linux)`;
          }
          if (ok !== false)
            return `unserialisable input reported saved=${String(ok)}`;
          if (stored) return 'unserialisable input produced a Keychain write';
          if (keychain.log.some(e => e.op === 'set')) {
            return 'unserialisable input reached setGenericPassword';
          }
          return null;
        }
        if (fault.kind === 'set-throws') {
          if (ok !== false)
            return `Keychain throw reported saved=${String(ok)}`;
          return stored ? 'Keychain throw left a stored item' : null;
        }
        if (fault.kind === 'set-returns') {
          const expectedOk = fault.value !== false;
          if (ok !== expectedOk) {
            return `set returned ${JSON.stringify(fault.value)}: saved=${String(ok)} expected ${String(expectedOk)}`;
          }
          return null;
        }
        if (!wouldWrite) return 'unreachable';
        if (ok !== true)
          return `serialisable input reported saved=${String(ok)}`;
        if (!stored) return 'saved=true but nothing stored';
        if (stored.password !== serialised)
          return 'stored JSON differs from JSON.stringify(input)';
        if (stored.username !== 'session') return `username ${stored.username}`;
        if (stored.accessible !== 'AccessibleAfterFirstUnlockThisDeviceOnly') {
          return `accessible=${String(stored.accessible)}`;
        }
        // Round-trip through load must agree with the oracle on the stored text.
        keychain.log.length = 0;
        const loaded = await vault.loadPersistedSession();
        if (!same(loaded, oracle(serialised))) {
          return `round-trip ${JSON.stringify(loaded)?.slice(0, 120)} ≠ oracle`;
        }
        if (loaded && shapeViolation(loaded)) return shapeViolation(loaded);
        if (keychain.log.some(e => e.op === 'set'))
          return 'round-trip load wrote';
        return null;
      });
    }
    const failures = rows.filter(
      r => r.campaign === campaign && r.outcome === 'BROKEN',
    );
    expect(failures.map(f => `${f.seed}:${f.category}:${f.detail}`)).toEqual(
      [],
    );
    if (!REPLAY)
      expect(rows.filter(r => r.campaign === campaign).length).toBeGreaterThan(
        0,
      );
  });

  // ─── Campaign C: adversarial-but-valid content must round-trip verbatim ────

  it('C. adversarial-but-valid records (null bytes, 64 KB+, lone surrogates, NFC/NFD, traversal ids) round-trip save → load byte-for-byte, then clear', async () => {
    const campaign = 'roundtrip-adversarial';
    for (const index of iterations(campaign)) {
      const rng = rngFor(campaign, index);
      const base = validSession(rng);
      const flavour = rng.int(7);
      let session: PersistedSession;
      let category: string;
      let note: string | undefined;
      switch (flavour) {
        case 0: {
          const big = oversizedString(rng);
          const field = rng.pick([
            'refreshToken',
            'email',
            'displayName',
          ] as const);
          session = { ...base, [field]: big.value };
          category = `oversized:${field}`;
          note = big.unit;
          break;
        }
        case 1:
          session = {
            ...base,
            refreshToken: `rt\u0000${rng.int(1e6)}\u0000`,
            displayName: '\u0000',
            email: 'a\u0000b@example.test',
          };
          category = 'null-bytes';
          break;
        case 2: {
          const lone = rng.pick([
            '\ud83d',
            '\udc00',
            '\ud800\ud800',
            '\udfff\ud83d',
          ]);
          session = {
            ...base,
            refreshToken: `rt${lone}${rng.int(1e6)}`,
            displayName: lone,
          };
          category = 'lone-surrogates';
          note = JSON.stringify(lone);
          break;
        }
        case 3: {
          const pair = rng.pick([
            ['\u00e9', 'e\u0301'],
            ['\u00f1', 'n\u0303'],
            ['\uac00', '\u1100\u1161'],
            ['\u1e0b\u0323', 'd\u0323\u0307'],
          ] as const);
          session = {
            ...base,
            email: `${pair[0]}${pair[1]}@example.test`,
            displayName: `${pair[1]}${pair[0]}`,
          };
          category = 'unicode-normalization-pairs';
          note = JSON.stringify(pair);
          break;
        }
        case 4:
          session = { ...base, canonicalAppUserId: rng.pick(TRAVERSAL) };
          category = 'traversal-id';
          note = JSON.stringify(session.canonicalAppUserId);
          break;
        case 5:
          session = {
            ...base,
            refreshToken: `"\\/\b\f\n\r\t\u2028\u2029{}[]:,${rng.int(1e6)}`,
            displayName: '__proto__',
            email: 'constructor',
          };
          category = 'json-metacharacters';
          break;
        default:
          session = {
            ...base,
            refreshToken: junkString(rng, 256) || 'rt',
            email: junkString(rng, 128),
            displayName: junkString(rng, 128),
          };
          category = 'random-junk-strings';
      }

      keychain.reset();
      const decoy = seedDecoy();
      await record(campaign, index, category, note, async () => {
        const saved = await vault.savePersistedSession(session);
        if (saved !== true) return `save returned ${String(saved)}`;
        const loaded = await vault.loadPersistedSession();
        if (loaded === null) return 'valid record was rejected on load';
        const shape = shapeViolation(loaded);
        if (shape) return shape;
        for (const key of EXPECTED_KEYS as Array<keyof PersistedSession>) {
          if (loaded[key] !== session[key]) {
            return `field ${key} changed: len ${String(session[key]).length} → ${String(loaded[key]).length}`;
          }
        }
        const stored = keychain.store.get(SESSION_VAULT_SERVICE);
        if (!stored) return 'record vanished after load';
        if (keychain.log.filter(e => e.op === 'set').length !== 1) {
          return 'more than one write for a single save';
        }
        await vault.clearPersistedSession();
        if (keychain.store.has(SESSION_VAULT_SERVICE))
          return 'clear left the record';
        if ((await vault.loadPersistedSession()) !== null)
          return 'load after clear not null';
        const decoyState = decoyIntact(decoy);
        if (decoyState) return decoyState;
        // The vault accepts any non-empty id; the data-owner scope that
        // consumes it requires a canonical UUID. Recorded as a GAP (not a
        // module failure) so the table shows which ids pass the vault but
        // cannot be adopted downstream.
        if (category === 'traversal-id') {
          return `GAP: vault accepted canonicalAppUserId ${JSON.stringify(session.canonicalAppUserId)} (non-UUID) — authStore.hydrate lands signed-out and leaves the record`;
        }
        return null;
      });
    }
    const failures = rows.filter(
      r => r.campaign === campaign && r.outcome === 'BROKEN',
    );
    expect(failures.map(f => `${f.seed}:${f.category}:${f.detail}`)).toEqual(
      [],
    );
    if (!REPLAY)
      expect(rows.filter(r => r.campaign === campaign).length).toBeGreaterThan(
        0,
      );
  });

  // ─── Campaign D: Keychain read/reset faults and malformed native results ──

  it('D. Keychain faults on load (throws of any shape, false, malformed result objects, non-string passwords, reset failures) degrade to null without throwing or writing', async () => {
    const campaign = 'keychain-faults';
    const errors: ReadonlyArray<{ label: string; value: unknown }> = [
      {
        label: 'Error',
        value: new Error('errSecInteractionNotAllowed (simulated)'),
      },
      { label: 'TypeError', value: new TypeError('null is not an object') },
      { label: 'string', value: 'E_KEYCHAIN' },
      { label: 'null', value: null },
      { label: 'undefined', value: undefined },
      { label: 'number', value: -25300 },
      { label: 'object', value: { code: 'E_CRYPTO_FAILED', message: 'x' } },
    ];
    const results: ReadonlyArray<{
      label: string;
      make: (rng: Rng) => unknown;
    }> = [
      { label: 'false', make: () => false },
      { label: 'true', make: () => true },
      { label: 'null', make: () => null },
      { label: 'undefined', make: () => undefined },
      { label: 'empty-object', make: () => ({}) },
      { label: 'string', make: () => 'session' },
      { label: 'number', make: () => 1 },
      { label: 'array', make: () => [] },
      { label: 'password-undefined', make: () => ({ username: 'session' }) },
      {
        label: 'password-null',
        make: () => ({ username: 'session', password: null }),
      },
      {
        label: 'password-number',
        make: () => ({ username: 'session', password: 42 }),
      },
      {
        label: 'password-object',
        make: () => ({ username: 'session', password: {} }),
      },
      {
        label: 'password-array',
        make: () => ({ username: 'session', password: ['{}'] }),
      },
      {
        label: 'password-empty',
        make: () => ({ username: 'session', password: '' }),
      },
      {
        label: 'password-valid-json-object-not-string',
        make: rng => ({ username: 'session', password: validSession(rng) }),
      },
      {
        label: 'password-valid',
        make: rng => ({
          username: 'session',
          password: JSON.stringify(validSession(rng)),
        }),
      },
      {
        label: 'password-valid-wrong-username',
        make: rng => ({
          username: 'other',
          password: JSON.stringify(validSession(rng)),
        }),
      },
      {
        label: 'password-malformed',
        make: rng => ({ username: 'session', password: malformedRaw(rng).raw }),
      },
    ];

    for (const index of iterations(campaign)) {
      const rng = rngFor(campaign, index);
      keychain.reset();
      const decoy = seedDecoy();
      let category: string;
      let note: string | undefined;
      let expected: PersistedSession | null = null;
      const mode = rng.int(3);
      if (mode === 0) {
        const err = rng.pick(errors);
        keychain.fault = { kind: 'get-throws', error: err.value };
        category = 'get-throws';
        note = err.label;
      } else if (mode === 1) {
        const res = rng.pick(results);
        const value = res.make(rng);
        keychain.fault = { kind: 'get-returns', value };
        category = `get-returns:${res.label}`;
        const password =
          value && typeof value === 'object' && 'password' in value
            ? (value as { password: unknown }).password
            : undefined;
        expected = oracle(password);
      } else {
        // Malformed record AND the cleanup reset fails: still null, no throw.
        const err = rng.pick(errors);
        const bad = malformedRaw(rng);
        keychain.store.set(SESSION_VAULT_SERVICE, {
          username: 'session',
          password: bad.raw,
        });
        keychain.fault = { kind: 'reset-throws', error: err.value };
        category = `reset-throws:${bad.category}`;
        note = err.label;
        expected = oracle(bad.raw);
      }
      await record(campaign, index, category, note, async () => {
        const result = await vault.loadPersistedSession();
        if (!same(result, expected)) {
          return `result ${JSON.stringify(result)?.slice(0, 120)} ≠ expected ${JSON.stringify(expected)?.slice(0, 120)}`;
        }
        if (result && shapeViolation(result)) return shapeViolation(result);
        const writes = writesDuringLoad();
        if (writes) return writes;
        const decoyState = decoyIntact(decoy);
        if (decoyState) return decoyState;
        // clear must also be fault-tolerant in this state.
        await vault.clearPersistedSession();
        return null;
      });
    }
    const failures = rows.filter(
      r => r.campaign === campaign && r.outcome === 'BROKEN',
    );
    expect(failures.map(f => `${f.seed}:${f.category}:${f.detail}`)).toEqual(
      [],
    );
    if (!REPLAY)
      expect(rows.filter(r => r.campaign === campaign).length).toBeGreaterThan(
        0,
      );
  });

  // ─── Campaign E: the native module is absent ──────────────────────────────

  it('E. a build without react-native-keychain: save → false, load → null, clear resolves — for every input shape', async () => {
    const campaign = 'module-missing';
    // The module registry caches the mocked keychain, so a fresh factory only
    // takes effect after resetModules(). sessionVault requires the native
    // module lazily on every call, so the swap is visible to a fresh instance.
    jest.resetModules();
    jest.doMock('react-native-keychain', () => {
      throw new Error("Cannot find module 'react-native-keychain'");
    });
    try {
      // Harness self-check: the swap must be in effect, otherwise the rows
      // below would measure the mock and not the missing-module path.
      expect(() => require('react-native-keychain')).toThrow(
        'Cannot find module',
      );
      const missing = require('../../src/account/sessionVault') as typeof vault;
      keychain.reset();
      const count = Math.max(1, Math.floor(ITER / 8));
      for (const index of iterations(campaign).slice(0, count)) {
        const rng = rngFor(campaign, index);
        const input = rng.bool()
          ? validSession(rng)
          : (malformedRaw(rng).raw as unknown);
        await record(campaign, index, 'module-missing', undefined, async () => {
          const saved = await missing.savePersistedSession(
            input as PersistedSession,
          );
          if (saved !== false)
            return `save without module returned ${String(saved)}`;
          const loaded = await missing.loadPersistedSession();
          if (loaded !== null)
            return `load without module returned ${JSON.stringify(loaded)}`;
          await missing.clearPersistedSession();
          if (keychain.log.length > 0)
            return 'missing-module vault reached the mock Keychain';
          return null;
        });
      }
    } finally {
      // Restore the fault-injectable module for anything that requires it later.
      jest.doMock('react-native-keychain', () => mockKeychainModule);
      jest.resetModules();
    }
    const failures = rows.filter(
      r => r.campaign === campaign && r.outcome === 'BROKEN',
    );
    expect(failures.map(f => `${f.seed}:${f.category}:${f.detail}`)).toEqual(
      [],
    );
  });

  it('campaign volume: the seeded table covers every generator category at least once at the default scale', () => {
    const categories = new Set(
      rows.map(r => `${r.campaign}/${r.category.split(':')[0]}`),
    );
    for (const expected of [
      'load-malformed/truncated-json',
      'load-malformed/garbage',
      'load-malformed/non-object-json',
      'load-malformed/wrong-type',
      'load-malformed/version-variant',
      'load-malformed/provider-variant',
      'load-malformed/prototype-pollution',
      'load-malformed/oversized',
      'load-malformed/traversal-id',
      'load-malformed/duplicate-key',
      'load-malformed/empty-container',
      'load-malformed/extra-key',
      'load-malformed/deep-nesting',
      'load-malformed/unicode-normalization',
      'load-malformed/prefixed-json',
      'load-malformed/json5-ish',
      'load-malformed/bit-rot',
      'load-malformed/missing-field',
      'save-malformed/whole',
      'save-malformed/field',
      'save-malformed/prototype-key',
      'save-malformed/keychain',
      'roundtrip-adversarial/oversized',
      'roundtrip-adversarial/null-bytes',
      'roundtrip-adversarial/lone-surrogates',
      'roundtrip-adversarial/unicode-normalization-pairs',
      'roundtrip-adversarial/json-metacharacters',
      'keychain-faults/get-throws',
      'keychain-faults/get-returns',
      'keychain-faults/reset-throws',
      'module-missing/module-missing',
    ]) {
      if (REPLAY) break;
      expect(categories.has(expected)).toBe(true);
    }
    expect(prototypeIsClean()).toBeNull();
  });
});
