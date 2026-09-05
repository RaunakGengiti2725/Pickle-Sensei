/**
 * BOUNDARY / MALFORMED-INPUT stress toolkit for `src/account/bootstrap.ts` and
 * `src/account/apiSession.ts`.
 *
 * Everything here is deterministic: a campaign iteration `i` derives every
 * random choice from `mulberry32(campaignSalt ^ i)`, so any row in the
 * emitted JSON table can be replayed with `STRESS_SEED=<i>`.
 *
 * The generators deliberately cover the lens catalogue: malformed/truncated
 * JSON, wrong runtime types, prototype-pollution keys, numeric
 * overflow/NaN/Infinity/-0, null bytes, 64 KB+ strings (byte, code point and
 * grapheme heavy), path traversal in ids/slugs, future schema versions,
 * empty arrays/objects, and Unicode normalization pairs.
 */

// ─── Seeded PRNG ─────────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;

  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }

  float(): number {
    return this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      const a = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = a;
    }
    return copy;
  }
}

// ─── Hostile scalars ─────────────────────────────────────────────────────────

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function alnum(rng: Rng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1)
    out += ALNUM[rng.int(0, ALNUM.length - 1)];
  return out;
}

/** 64 KiB + a bit: over any byte, code point or grapheme cap a store might use. */
export const OVER_CAP = 65_536 + 17;

export const NORMALIZATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['\u00e9', 'e\u0301'], // é NFC / NFD
  ['\u00c5', 'A\u030a'], // Å NFC / NFD
  ['\u1e69', 's\u0323\u0307'], // ṩ
  ['\ufb01', 'fi'], // ﬁ ligature (NFKC → fi)
  ['\u212b', '\u00c5'], // ANGSTROM SIGN → Å under NFC
  ['\u2126', '\u03a9'], // OHM SIGN → Ω
  ['\uff21', 'A'], // fullwidth A (NFKC)
];

const CONTROL_STRINGS = [
  '\u0000',
  'a\u0000b',
  '\u0000'.repeat(8),
  '\r\n',
  'a\r\nX-Injected: 1',
  'Bearer x\nAuthorization: y',
  '\t',
  '\u000b\u000c',
  '\u001b[31mred\u001b[0m',
  '\u007f',
  '\u0085',
  '\u2028\u2029',
  '\u200b',
  '\u200e\u200f',
  '\u202e\u202d',
  '\ufeff',
  '\ud800', // lone high surrogate
  '\udc00', // lone low surrogate
  '\ud83d\ude00', // 😀
  '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66', // family ZWJ
];

const TRAVERSAL_STRINGS = [
  '../../etc/passwd',
  '..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2f',
  '....//....//',
  '/etc/passwd\u0000.png',
  'file:///etc/passwd',
  '~/.ssh/id_rsa',
  '/v1/account/bootstrap/../admin',
  '${jndi:ldap://x}',
  "' OR 1=1 --",
  '<script>alert(1)</script>',
  '{{7*7}}',
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'toString',
  'valueOf',
];

const NUMERIC_LOOKING_STRINGS = [
  '0',
  '-0',
  '1e308',
  '1e309',
  'NaN',
  'Infinity',
  '-Infinity',
  '0x7fffffff',
  '1800000000',
  '1800000000.5',
  '9007199254740993',
  'true',
  'false',
  'null',
  'undefined',
  '[]',
  '{}',
  '{"user":{"id":"7fc2c743-028f-4ec6-942c-a84508f3be38"}}',
];

export function hugeString(rng: Rng): string {
  switch (rng.int(0, 5)) {
    case 0:
      return 'a'.repeat(OVER_CAP); // bytes == code points == graphemes
    case 1:
      return '\u00e9'.repeat(OVER_CAP); // 2 bytes each
    case 2:
      return '\u4e2d'.repeat(OVER_CAP); // 3 bytes each
    case 3:
      return '\ud83d\ude00'.repeat(OVER_CAP); // 4 bytes, 2 UTF-16 units each
    case 4:
      // ZWJ family: 1 grapheme = 7 code points = 25 bytes.
      return '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66'.repeat(
        OVER_CAP / 8,
      );
    default:
      return alnum(rng, OVER_CAP * 2);
  }
}

export function hostileString(rng: Rng): string {
  switch (rng.int(0, 9)) {
    case 0:
      return '';
    case 1:
      return rng.pick([' ', '   ', '\t\n', '\u00a0', '\u3000', ' \u200b ']);
    case 2:
      return rng.pick(CONTROL_STRINGS);
    case 3:
      return rng.pick(TRAVERSAL_STRINGS);
    case 4:
      return rng.pick(NUMERIC_LOOKING_STRINGS);
    case 5: {
      const pair = rng.pick(NORMALIZATION_PAIRS);
      return rng.chance(0.5) ? pair[0] : pair[1];
    }
    case 6:
      return rng.chance(0.15) ? hugeString(rng) : alnum(rng, rng.int(1, 4096));
    case 7:
      return (
        alnum(rng, rng.int(1, 24)) +
        rng.pick(CONTROL_STRINGS) +
        alnum(rng, rng.int(0, 8))
      );
    case 8:
      return `${alnum(rng, 8)}.${alnum(rng, 40)}.${alnum(rng, 43)}`; // JWT-shaped
    default:
      return alnum(rng, rng.int(1, 64));
  }
}

export const HOSTILE_NUMBERS: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  0,
  -1,
  1,
  0.5,
  1.5,
  Number.MIN_VALUE,
  Number.EPSILON,
  Number.MAX_VALUE,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  2 ** 31 - 1,
  2 ** 31,
  2 ** 32,
  -(2 ** 31),
  2 ** 53,
  2 ** 53 + 2,
  1e15,
  1e18,
  1e300,
  1e306, // finite, but × 1000 overflows to Infinity
  -1e306,
  1_800_000_000,
  1_800_000_000.75,
  4_102_444_800, // 2100-01-01
  253_402_300_799, // 9999-12-31 in seconds
  8.64e15, // max Date ms
  8.64e12, // max Date in seconds
];

export function hostileNumber(rng: Rng): number {
  return rng.chance(0.8)
    ? rng.pick(HOSTILE_NUMBERS)
    : (rng.float() - 0.5) * 10 ** rng.int(0, 20);
}

// ─── UUIDs ───────────────────────────────────────────────────────────────────

const HEX = '0123456789abcdef';

export function validUuidV4(rng: Rng): string {
  const h = (n: number) => {
    let s = '';
    for (let i = 0; i < n; i += 1) s += HEX[rng.int(0, 15)];
    return s;
  };
  return `${h(8)}-${h(4)}-4${h(3)}-${rng.pick(['8', '9', 'a', 'b'])}${h(3)}-${h(12)}`;
}

/** Valid and near-valid UUID spellings; the oracle decides which are accepted. */
export function uuidVariant(rng: Rng): string {
  const base = validUuidV4(rng);
  switch (rng.int(0, 21)) {
    case 0:
      return base;
    case 1:
      return base.toUpperCase();
    case 2:
      return base
        .split('')
        .map(c => (rng.chance(0.5) ? c.toUpperCase() : c))
        .join('');
    case 3:
      return '00000000-0000-0000-0000-000000000000';
    case 4:
      return 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    case 5:
      return `${base.slice(0, 14)}${rng.pick(['0', '9', 'a', 'f'])}${base.slice(15)}`; // bad version
    case 6:
      return `${base.slice(0, 19)}${rng.pick(['0', '7', 'c', 'f'])}${base.slice(20)}`; // bad variant
    case 7:
      return `${base.slice(0, 19)}${rng.pick(['8', '9', 'A', 'B'])}${base.slice(20)}`; // uppercase variant nibble
    case 8:
      return `{${base}}`;
    case 9:
      return `urn:uuid:${base}`;
    case 10:
      return `${base}\n`;
    case 11:
      return ` ${base} `;
    case 12:
      return base.slice(0, 35);
    case 13:
      return `${base}0`;
    case 14:
      return base.replace(/-/g, '');
    case 15:
      return base.replace(/[0-9a-f]/, 'g');
    case 16:
      return base.replace(/[0-9a-f]/, '\uff10'); // fullwidth digit zero
    case 17:
      return `${base}\u0000`;
    case 18:
      return base.replace(/-/, '\u2010'); // hyphen look-alike
    case 19:
      return `${base.slice(0, 14)}${rng.pick(['1', '2', '3', '5', '6', '7', '8'])}${base.slice(15)}`; // other allowed versions
    case 20:
      return `../${base}`;
    default:
      return hostileString(rng);
  }
}

/**
 * Independent reference for `bootstrap.ts` UUID acceptance, written without a
 * regular expression: 8-4-4-4-12 hex groups, version nibble 1–8, variant nibble
 * 8/9/a/b, ASCII case-insensitive, nothing else.
 */
export function oracleIsCanonicalUuid(value: unknown): boolean {
  if (typeof value !== 'string' || value.length !== 36) return false;
  const groups = value.split('-');
  if (groups.length !== 5) return false;
  const lengths = [8, 4, 4, 4, 12];
  for (let g = 0; g < 5; g += 1) {
    const group = groups[g] ?? '';
    if (group.length !== lengths[g]) return false;
    for (const ch of group) {
      if (!/[0-9a-fA-F]/.test(ch)) return false;
    }
  }
  const version = (groups[2] ?? '').charAt(0).toLowerCase();
  const variant = (groups[3] ?? '').charAt(0).toLowerCase();
  return '12345678'.includes(version) && '89ab'.includes(variant);
}

// ─── Arbitrary values ────────────────────────────────────────────────────────

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A JSON-representable tree (what `Response.json()` can actually produce). */
export function randomJson(rng: Rng, depth = 0): JsonValue {
  const leaf = depth >= 3 || rng.chance(0.55);
  if (leaf) {
    switch (rng.int(0, 5)) {
      case 0:
        return null;
      case 1:
        return rng.chance(0.5);
      case 2: {
        const n = hostileNumber(rng);
        return Number.isFinite(n) ? n : 0;
      }
      case 3:
        return hostileString(rng);
      case 4:
        return rng.chance(0.5) ? [] : {};
      default:
        return alnum(rng, rng.int(0, 12));
    }
  }
  if (rng.chance(0.4)) {
    const out: JsonValue[] = [];
    const n = rng.int(0, 4);
    for (let i = 0; i < n; i += 1) out.push(randomJson(rng, depth + 1));
    return out;
  }
  const out: { [key: string]: JsonValue } = {};
  const n = rng.int(0, 5);
  for (let i = 0; i < n; i += 1) {
    const key = rng.chance(0.3)
      ? rng.pick([
          'user',
          'id',
          'email',
          'onboardingState',
          'session',
          'accessToken',
          'refreshToken',
          'expiresAt',
          'error',
          'message',
        ])
      : rng.chance(0.2)
        ? rng.pick(['__proto__', 'constructor', 'prototype'])
        : alnum(rng, rng.int(1, 8));
    out[key] = randomJson(rng, depth + 1);
  }
  return out;
}

/**
 * Any JavaScript runtime value, JSON or not: what a broken SDK, a wrong-typed
 * bridge or a misbehaving fetch polyfill could hand the module.
 */
export function hostileValue(rng: Rng, depth = 0): unknown {
  switch (rng.int(0, 16)) {
    case 0:
      return undefined;
    case 1:
      return null;
    case 2:
      return rng.chance(0.5);
    case 3:
      return hostileNumber(rng);
    case 4:
      return hostileString(rng);
    case 5:
      return BigInt(rng.int(0, 1_000_000)) * 1_000_000_000_000n;
    case 6:
      return Symbol(alnum(rng, 4));
    case 7:
      return () => 'called';
    case 8:
      return new Date(rng.chance(0.5) ? Number.NaN : 1_800_000_000_000);
    case 9:
      return rng.chance(0.5) ? [] : [hostileValue(rng, depth + 1)];
    case 10:
      return depth >= 2
        ? {}
        : { [alnum(rng, 3)]: hostileValue(rng, depth + 1) };
    case 11:
      return Object.create(null);
    case 12:
      return new Map([['id', 'x']]);
    case 13:
      return /re/g;
    case 14:
      return JSON.parse(
        '{"__proto__":{"id":"7fc2c743-028f-4ec6-942c-a84508f3be38"}}',
      );
    case 15:
      return randomJson(rng, depth + 1);
    default:
      return new (class Weird {
        id = validUuidV4(rng);
      })();
  }
}

// ─── Payload construction / mutation for /v1/account/bootstrap responses ─────

export interface ValidPayloadShape {
  user: { id: string; email: string | null };
  onboardingState: 'pending' | 'complete';
  session?: { accessToken: string; refreshToken: string; expiresAt: number };
}

export function validPayload(rng: Rng): ValidPayloadShape {
  const payload: ValidPayloadShape = {
    user: {
      id: validUuidV4(rng),
      email: rng.chance(0.2) ? null : `${alnum(rng, 6)}@example.com`,
    },
    onboardingState: rng.chance(0.5) ? 'pending' : 'complete',
  };
  if (rng.chance(0.75)) {
    payload.session = {
      accessToken: `at.${alnum(rng, 40)}`,
      refreshToken: `rt-${alnum(rng, 24)}`,
      expiresAt: 1_800_000_000 + rng.int(0, 10_000_000),
    };
  }
  return payload;
}

export type PayloadStrategy =
  | 'valid'
  | 'random-json'
  | 'random-value'
  | 'field-swap'
  | 'delete-key'
  | 'proto-keys'
  | 'future-schema'
  | 'uuid-variant'
  | 'session-number'
  | 'email-hostile'
  | 'onboarding-variant'
  | 'session-partial'
  | 'empty-shapes';

export const PAYLOAD_STRATEGIES: readonly PayloadStrategy[] = [
  'valid',
  'random-json',
  'random-value',
  'field-swap',
  'delete-key',
  'proto-keys',
  'future-schema',
  'uuid-variant',
  'session-number',
  'email-hostile',
  'onboarding-variant',
  'session-partial',
  'empty-shapes',
];

type Mutable = { [key: string]: unknown };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function mutatePayload(rng: Rng, strategy: PayloadStrategy): unknown {
  const base = clone(validPayload(rng)) as unknown as Mutable;
  const user = base['user'] as Mutable;
  switch (strategy) {
    case 'valid':
      return base;
    case 'random-json':
      return randomJson(rng);
    case 'random-value':
      return hostileValue(rng);
    case 'field-swap': {
      const target = rng.pick([
        'user',
        'user.id',
        'user.email',
        'onboardingState',
        'session',
        'session.accessToken',
        'session.refreshToken',
        'session.expiresAt',
      ]);
      const value = rng.chance(0.6) ? hostileValue(rng) : randomJson(rng);
      setPath(base, target, value);
      return base;
    }
    case 'delete-key': {
      const target = rng.pick([
        'user',
        'user.id',
        'user.email',
        'onboardingState',
        'session',
        'session.accessToken',
        'session.refreshToken',
        'session.expiresAt',
      ]);
      deletePath(base, target);
      return base;
    }
    case 'proto-keys': {
      // JSON.parse makes `__proto__` an OWN property, exactly like a real body.
      const polluted = JSON.parse(
        JSON.stringify(base).replace(
          /^\{/,
          `{"__proto__":{"user":{"id":"${validUuidV4(rng)}","email":null},"onboardingState":"complete","polluted":true},"constructor":{"prototype":{"polluted":true}},`,
        ),
      ) as Mutable;
      if (rng.chance(0.5)) {
        // Real key replaced by the polluted one so only a prototype walk would "find" it.
        const which = rng.pick(['user', 'onboardingState', 'session']);
        delete polluted[which];
      }
      return polluted;
    }
    case 'future-schema': {
      switch (rng.int(0, 4)) {
        case 0:
          return {
            schemaVersion: 2,
            account: base['user'],
            onboarding: { state: base['onboardingState'] },
            session: base['session'],
          };
        case 1:
          return { data: base };
        case 2:
          return [base];
        case 3:
          return { ...base, user: { ...user, id: { value: user['id'] } } };
        default:
          return { ...base, version: 99, extra: randomJson(rng) };
      }
    }
    case 'uuid-variant':
      user['id'] = uuidVariant(rng);
      return base;
    case 'session-number': {
      const session = (base['session'] as Mutable | undefined) ?? {
        accessToken: 'at',
        refreshToken: 'rt',
      };
      session['expiresAt'] = rng.chance(0.7)
        ? hostileNumber(rng)
        : rng.pick<unknown>([
            '1800000000',
            1800000000n,
            null,
            true,
            [1800000000],
            { seconds: 1800000000 },
          ]);
      base['session'] = session;
      return base;
    }
    case 'email-hostile':
      user['email'] = rng.chance(0.85) ? hostileString(rng) : hostileValue(rng);
      return base;
    case 'onboarding-variant':
      base['onboardingState'] = rng.pick<unknown>([
        'Pending',
        'PENDING',
        'complete ',
        ' complete',
        'completed',
        'pending\u0000',
        'p\u0065nding',
        '',
        null,
        0,
        1,
        true,
        ['pending'],
        { state: 'pending' },
        'complete\n',
      ]);
      return base;
    case 'session-partial': {
      const session: Mutable = {};
      if (rng.chance(0.6))
        session['accessToken'] = rng.chance(0.7)
          ? `at.${alnum(rng, 20)}`
          : hostileString(rng);
      if (rng.chance(0.6))
        session['refreshToken'] = rng.chance(0.7)
          ? `rt-${alnum(rng, 20)}`
          : hostileString(rng);
      if (rng.chance(0.6))
        session['expiresAt'] = rng.chance(0.7)
          ? 1_800_000_000
          : hostileNumber(rng);
      base['session'] = rng.chance(0.15)
        ? rng.pick<unknown>([null, [], '', 0, 'session', [session]])
        : session;
      return base;
    }
    case 'empty-shapes':
      return rng.pick<unknown>([
        {},
        [],
        '',
        null,
        0,
        false,
        { user: {} },
        { user: [] },
        { user: null },
        { user: {}, onboardingState: 'pending' },
        { session: {} },
      ]);
    default:
      return base;
  }
}

function setPath(target: Mutable, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Mutable = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const next = cursor[parts[i] as string];
    if (!next || typeof next !== 'object') {
      const created: Mutable = {};
      cursor[parts[i] as string] = created;
      cursor = created;
    } else {
      cursor = next as Mutable;
    }
  }
  cursor[parts[parts.length - 1] as string] = value;
}

function deletePath(target: Mutable, path: string): void {
  const parts = path.split('.');
  let cursor: Mutable | undefined = target;
  for (let i = 0; i < parts.length - 1 && cursor; i += 1) {
    const next: unknown = cursor[parts[i] as string];
    cursor = next && typeof next === 'object' ? (next as Mutable) : undefined;
  }
  if (cursor) delete cursor[parts[parts.length - 1] as string];
}

// ─── Oracle: the documented bootstrap response contract ──────────────────────

export interface OracleAccount {
  id: string;
  email: string | null;
  onboardingState: 'pending' | 'complete';
}

export interface OracleSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

/** Own-property read: prototype-pollution keys must never satisfy the contract. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

export function oracleAccount(payload: unknown): OracleAccount | null {
  const root = ownRecord(payload);
  if (!root) return null;
  const user = ownRecord(own(root, 'user'));
  if (!user) return null;
  const id = own(user, 'id');
  const email = own(user, 'email');
  const onboardingState = own(root, 'onboardingState');
  if (!oracleIsCanonicalUuid(id)) return null;
  if (!(email === null || typeof email === 'string')) return null;
  if (onboardingState !== 'pending' && onboardingState !== 'complete')
    return null;
  return { id: id as string, email: email as string | null, onboardingState };
}

export function oracleSession(payload: unknown): OracleSession | null {
  const root = ownRecord(payload);
  if (!root) return null;
  const session = ownRecord(own(root, 'session'));
  if (!session) return null;
  const accessToken = own(session, 'accessToken');
  const refreshToken = own(session, 'refreshToken');
  const expiresAt = own(session, 'expiresAt');
  if (typeof accessToken !== 'string' || accessToken.trim() === '') return null;
  if (typeof refreshToken !== 'string' || refreshToken.trim() === '')
    return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  return { accessToken, refreshToken, expiresAt };
}

// ─── API base URL generator + oracle ─────────────────────────────────────────

export function urlVariant(rng: Rng): unknown {
  const host = rng.pick([
    'api.pickle.example',
    'ucqnaiwqwjtgvlduiuib.functions.supabase.co',
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.1',
    '0x7f000001',
    '2130706433',
    '10.0.2.2',
    '[::1]',
    '0.0.0.0',
    'localhost.',
    'localhost.evil.example',
    'evil.example\\@localhost',
    'localhost@evil.example',
    'xn--pi-ela.example',
    '\u0430pi.example', // Cyrillic а
    'api.exam\tple.com',
    'api.exam\nple.com',
    'api .example',
    'api.example:443',
    'api.example:0',
    'api.example:65536',
    'api.example:abc',
    '',
  ]);
  const scheme = rng.pick([
    'https',
    'http',
    'HTTPS',
    'Https',
    'ftp',
    'file',
    'javascript',
    'data',
    'wss',
    'https:',
    'http:',
    'https:/',
    'https:///',
  ]);
  const tail = rng.pick([
    '',
    '/',
    '//',
    '////',
    '/v1',
    '/v1/',
    '/functions/v1/api',
    '/../..',
    '/..%2f..',
    '/a/../../b',
    '?x=1',
    '?x=1/',
    '#frag',
    '#frag/',
    '/path?x=1#y',
    `/${alnum(rng, 12)}`,
    `/${hugeString(rng).slice(0, 70_000)}`,
    '\u0000',
    ' ',
    '\n',
    ' /',
  ]);
  const userinfo = rng.chance(0.1) ? 'user:pa%20ss@' : '';
  switch (rng.int(0, 9)) {
    case 0:
      return null;
    case 1:
      return undefined;
    case 2:
      return rng.pick([
        '',
        ' ',
        '\t\n',
        '\u200b',
        '\ufeff',
        'https',
        'https:',
        'https://',
        '//api.pickle.example',
        'api.pickle.example',
        'api.pickle.example/v1',
      ]);
    case 3:
      return hostileValue(rng); // wrong runtime type
    case 4:
      return `${rng.pick(['  ', '\n', '\ufeff', ''])}${scheme}://${userinfo}${host}${tail}${rng.pick(['  ', '\n', ''])}`;
    case 5:
      return `${scheme}${scheme.endsWith(':') || scheme.endsWith('/') ? '' : '://'}${host}${tail}`;
    default:
      return `${scheme}://${userinfo}${host}${tail}`;
  }
}

export interface UrlOracle {
  accepted: boolean;
  /** Normalized origin the request must actually reach when accepted. */
  origin: string | null;
}

/** Documented rule: trim, strip trailing slashes, parse, https or local dev host. */
export function oracleBaseUrl(value: unknown): UrlOracle {
  if (typeof value !== 'string') return { accepted: false, origin: null };
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return { accepted: false, origin: null };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { accepted: false, origin: null };
  }
  const local = ['localhost', '127.0.0.1', '10.0.2.2'].includes(
    parsed.hostname,
  );
  if (parsed.protocol !== 'https:' && !local)
    return { accepted: false, origin: null };
  return { accepted: true, origin: parsed.origin };
}

// ─── Text-level JSON corruption (fed through a REAL Response body) ───────────

export type TextCorruption =
  | 'none'
  | 'truncate-codepoint'
  | 'truncate-byte'
  | 'null-byte'
  | 'flip-byte'
  | 'duplicate-key'
  | 'proto-inject'
  | 'deep-nest'
  | 'trailing-garbage'
  | 'bom'
  | 'unicode-escape'
  | 'whitespace-storm'
  | 'not-json';

export const TEXT_CORRUPTIONS: readonly TextCorruption[] = [
  'none',
  'truncate-codepoint',
  'truncate-byte',
  'null-byte',
  'flip-byte',
  'duplicate-key',
  'proto-inject',
  'deep-nest',
  'trailing-garbage',
  'bom',
  'unicode-escape',
  'whitespace-storm',
  'not-json',
];

export function corruptText(
  rng: Rng,
  text: string,
  corruption: TextCorruption,
): Uint8Array {
  const enc = new TextEncoder();
  switch (corruption) {
    case 'none':
      return enc.encode(text);
    case 'truncate-codepoint': {
      const points = Array.from(text);
      return enc.encode(
        points.slice(0, rng.int(0, Math.max(0, points.length - 1))).join(''),
      );
    }
    case 'truncate-byte': {
      const bytes = enc.encode(text);
      return bytes.slice(0, rng.int(0, Math.max(0, bytes.length - 1)));
    }
    case 'null-byte': {
      const at = rng.int(0, text.length);
      return enc.encode(`${text.slice(0, at)}\u0000${text.slice(at)}`);
    }
    case 'flip-byte': {
      const bytes = enc.encode(text);
      if (bytes.length === 0) return bytes;
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i += 1) {
        const at = rng.int(0, bytes.length - 1);
        bytes[at] = (bytes[at] as number) ^ (1 << rng.int(0, 7));
      }
      return bytes;
    }
    case 'duplicate-key': {
      // JSON.parse keeps the LAST duplicate; a validator that keeps the first is wrong.
      const dup = rng.pick([
        `"user":${JSON.stringify(hostileValue(rng) ?? null, (_k, v) => (typeof v === 'bigint' ? Number(v) : typeof v === 'symbol' || typeof v === 'function' ? String(v) : v))}`,
        `"onboardingState":"${rng.pick(['pending', 'complete', 'nope'])}"`,
        `"session":{"accessToken":"dup","refreshToken":"dup","expiresAt":${rng.pick(['1', '1e400', '-0', 'null', '"1"'])}}`,
      ]);
      return enc.encode(text.replace(/^\{/, '{').replace(/\}$/, `,${dup}}`));
    }
    case 'proto-inject':
      return enc.encode(
        text.replace(
          /^\{/,
          `{"__proto__":{"user":{"id":"${validUuidV4(rng)}","email":null},"onboardingState":"complete"},`,
        ),
      );
    case 'deep-nest': {
      const depth = rng.pick([64, 1024, 20_000]);
      return enc.encode(`${'['.repeat(depth)}${text}${']'.repeat(depth)}`);
    }
    case 'trailing-garbage':
      return enc.encode(
        `${text}${rng.pick(['}', ']', ',', 'null', '{}', '\u0000', ' x', '\n\n{'])}`,
      );
    case 'bom':
      return enc.encode(`\ufeff${text}`);
    case 'unicode-escape':
      return enc.encode(
        text.replace(
          /"id":"([^"]+)"/,
          (_m, id: string) =>
            `"id":"${Array.from(id)
              .map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
              .join('')}"`,
        ),
      );
    case 'whitespace-storm':
      return enc.encode(
        text.replace(
          /([{}[\]:,])/g,
          (m: string) =>
            `${rng.pick([' ', '\n', '\t', '\r\n', ''])}${m}${rng.pick([' ', '\n', '\t', ''])}`,
        ),
      );
    case 'not-json':
      return enc.encode(
        rng.pick([
          '<!doctype html><html><body>502 Bad Gateway</body></html>',
          'Unauthorized',
          '',
          'undefined',
          'NaN',
          "{'user': {'id': 'x'}}",
          '{"user":{"id":"7fc2c743-028f-4ec6-942c-a84508f3be38",}}',
          'user: {id: 1}',
          '\u0000\u0000\u0000',
          hugeString(rng),
        ]),
      );
    default:
      return enc.encode(text);
  }
}

// ─── Result table ────────────────────────────────────────────────────────────

export type Outcome = 'HELD' | 'OBSERVATION' | 'BROKEN';

export interface Row {
  campaign: string;
  seed: number;
  outcome: Outcome;
  /** Short classification: what held / which known-finding class was hit. */
  kind: string;
  detail?: string;
}

export interface CampaignSummary {
  campaign: string;
  iterations: number;
  held: number;
  observations: Record<string, number>;
  broken: Record<string, number>;
  /** Smallest replay per observation/broken class (seed + rendered input). */
  minimized: Record<string, { seed: number; size: number; detail: string }>;
}

export function summarize(
  rows: readonly Row[],
  campaign: string,
): CampaignSummary {
  const summary: CampaignSummary = {
    campaign,
    iterations: rows.length,
    held: 0,
    observations: {},
    broken: {},
    minimized: {},
  };
  for (const row of rows) {
    if (row.outcome === 'HELD') {
      summary.held += 1;
      continue;
    }
    const bucket =
      row.outcome === 'BROKEN' ? summary.broken : summary.observations;
    bucket[row.kind] = (bucket[row.kind] ?? 0) + 1;
    const size = row.detail?.length ?? 0;
    const current = summary.minimized[row.kind];
    if (!current || size < current.size) {
      summary.minimized[row.kind] = {
        seed: row.seed,
        size,
        detail: row.detail ?? '',
      };
    }
  }
  return summary;
}

/** Stable, bounded rendering for the JSON table (no secrets involved here). */
export function render(value: unknown, max = 240): string {
  const text = JSON.stringify(renderable(value, new WeakSet()));
  return text.length > max
    ? `${text.slice(0, max)}…(${text.length} chars)`
    : text;
}

/** JSON-safe projection: cycles, BigInt, symbols, functions, throwing toJSON. */
function renderable(value: unknown, seen: WeakSet<object>): JsonValue {
  switch (typeof value) {
    case 'undefined':
      return '[undefined]';
    case 'bigint':
      return `${value.toString()}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return '[function]';
    case 'number':
      return Number.isFinite(value)
        ? Object.is(value, -0)
          ? '-0'
          : value
        : String(value);
    case 'string':
    case 'boolean':
      return value;
    default:
      break;
  }
  if (value === null) return null;
  const obj = value as object;
  if (seen.has(obj)) return '[cycle]';
  seen.add(obj);
  if (obj instanceof Map) return '[Map]';
  if (obj instanceof Date)
    return `[Date ${Number.isNaN(obj.getTime()) ? 'Invalid' : obj.toISOString()}]`;
  if (obj instanceof RegExp) return obj.toString();
  if (Array.isArray(obj)) return obj.map(item => renderable(item, seen));
  const out: { [key: string]: JsonValue } = {};
  if (typeof (obj as { toJSON?: unknown }).toJSON === 'function')
    out['[toJSON]'] = true;
  for (const key of Object.keys(obj)) {
    out[key] = renderable((obj as Record<string, unknown>)[key], seen);
  }
  return out;
}

/** Cross-realm safe (Jest vm context vs Node internals): duck-types Error. */
export function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const { name, message, code } = error as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
    };
    return `${typeof name === 'string' ? name : 'Error'}${typeof code === 'string' ? `[${code}]` : ''}: ${String(message).slice(0, 120)}`;
  }
  return `non-Error throw: ${render(error, 80)}`;
}

/** `instanceof TypeError` fails across realms; match by name instead. */
export function isTypeError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'TypeError')
  );
}
