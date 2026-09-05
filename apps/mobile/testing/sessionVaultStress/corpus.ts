/**
 * Seeded generator of stored-record payloads (valid, corrupt, oversized) plus
 * an INDEPENDENT reference implementation of the persisted-session contract
 * (AGENTS.md "Auth sessions"), so the fuzz oracle never trusts the unit.
 */
import type { PersistedSession } from '../../src/account/sessionVault';
import type { Rng } from './fakeKeychain';

const VALID_KEYS = [
  'version',
  'provider',
  'canonicalAppUserId',
  'refreshToken',
  'email',
  'displayName',
] as const;

const JUNK_VALUES: readonly unknown[] = [
  null,
  true,
  false,
  0,
  1,
  -1,
  1.5,
  '',
  ' ',
  '1',
  'apple ',
  'Apple',
  'APPLE',
  'facebook',
  [],
  {},
  [1],
  { nested: true },
  'x'.repeat(1024),
];

const TEXT_ALPHABET = [
  'a',
  'Z',
  '0',
  '9',
  '-',
  '_',
  '.',
  ' ',
  '"',
  '\\',
  '{',
  '}',
  '[',
  ']',
  ':',
  ',',
  '\n',
  '\u0000',
  '\u00e9',
  '\u4e2d',
  '\ud83c\udfd3', // 🏓 (surrogate pair)
  '\ufeff',
];

function randomText(rng: Rng, maxLength: number): string {
  const length = rng.int(maxLength + 1);
  let out = '';
  for (let i = 0; i < length; i += 1) out += rng.pick(TEXT_ALPHABET);
  return out;
}

export function utf8ByteLength(text: string): number {
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

export function validRecord(rng: Rng): Record<string, unknown> {
  return {
    version: 1,
    provider: rng.chance(0.5) ? 'apple' : 'google',
    canonicalAppUserId: `user-${rng.int(1_000_000)}`,
    refreshToken: `rt-${randomText(rng, 40)}${rng.int(1_000_000)}`,
    email: rng.chance(0.5) ? null : `${randomText(rng, 12)}@example.com`,
    displayName: rng.chance(0.5) ? null : randomText(rng, 24),
  };
}

export type CorpusKind =
  | 'valid'
  | 'valid-extra-keys'
  | 'valid-reordered'
  | 'drop-key'
  | 'retype-key'
  | 'bad-provider'
  | 'bad-version'
  | 'empty-required'
  | 'scalar'
  | 'array'
  | 'truncated'
  | 'garbage-text'
  | 'proto-key'
  | 'huge-field';

export interface CorpusEntry {
  kind: CorpusKind;
  password: string;
}

/** One seeded stored-record payload. */
export function generateRecord(rng: Rng): CorpusEntry {
  const base = validRecord(rng);
  const roll = rng.next();
  const emit = (kind: CorpusKind, value: unknown): CorpusEntry => ({
    kind,
    password: JSON.stringify(value),
  });
  if (roll < 0.2) return emit('valid', base);
  if (roll < 0.26) {
    return emit('valid-extra-keys', {
      ...base,
      accessToken: 'MUST-NOT-LEAK',
      [randomText(rng, 8) || 'extra']: rng.pick(JUNK_VALUES),
    });
  }
  if (roll < 0.3) {
    const entries = Object.entries(base);
    for (let i = entries.length - 1; i > 0; i -= 1) {
      const j = rng.int(i + 1);
      [entries[i], entries[j]] = [entries[j]!, entries[i]!];
    }
    return emit('valid-reordered', Object.fromEntries(entries));
  }
  if (roll < 0.4) {
    const key = rng.pick(VALID_KEYS);
    const copy: Record<string, unknown> = { ...base };
    delete copy[key];
    return emit('drop-key', copy);
  }
  if (roll < 0.52) {
    const key = rng.pick(VALID_KEYS);
    return emit('retype-key', { ...base, [key]: rng.pick(JUNK_VALUES) });
  }
  if (roll < 0.58) {
    return emit('bad-provider', { ...base, provider: randomText(rng, 8) });
  }
  if (roll < 0.64) {
    return emit('bad-version', {
      ...base,
      version: rng.pick([0, 2, '1', 1.0000001, null, -1]),
    });
  }
  if (roll < 0.7) {
    const key = rng.pick(['canonicalAppUserId', 'refreshToken'] as const);
    return emit('empty-required', { ...base, [key]: '' });
  }
  if (roll < 0.75) return emit('scalar', rng.pick(JUNK_VALUES.slice(0, 11)));
  if (roll < 0.79) return emit('array', [base]);
  if (roll < 0.86) {
    const text = JSON.stringify(base);
    return { kind: 'truncated', password: text.slice(0, rng.int(text.length)) };
  }
  if (roll < 0.92)
    return { kind: 'garbage-text', password: randomText(rng, 64) };
  if (roll < 0.96) {
    return {
      kind: 'proto-key',
      password: `{"__proto__":{"polluted":true},${JSON.stringify(base).slice(1)}`,
    };
  }
  return emit('huge-field', {
    ...base,
    displayName: 'd'.repeat(1 + rng.int(200_000)),
  });
}

/**
 * Reference parser: the contract as written in AGENTS.md / sessionVault.ts
 * doc comments, re-implemented here so a fuzz row fails when the unit and
 * the contract disagree.
 */
export function referenceParse(password: string): PersistedSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(password);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const provider = record['provider'];
  const canonicalAppUserId = record['canonicalAppUserId'];
  const refreshToken = record['refreshToken'];
  if (record['version'] !== 1) return null;
  if (provider !== 'apple' && provider !== 'google') return null;
  if (typeof canonicalAppUserId !== 'string' || canonicalAppUserId === '') {
    return null;
  }
  if (typeof refreshToken !== 'string' || refreshToken === '') return null;
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

/** A session whose serialized size lands at (roughly) `targetBytes`. */
export function sessionOfSize(rng: Rng, targetBytes: number): PersistedSession {
  const skeleton: PersistedSession = {
    version: 1,
    provider: rng.chance(0.5) ? 'apple' : 'google',
    canonicalAppUserId: `user-${rng.int(1_000_000)}`,
    refreshToken: '',
    email: rng.chance(0.5) ? null : 'big@example.com',
    displayName: rng.chance(0.5) ? null : 'Big Session',
  };
  const overhead = utf8ByteLength(JSON.stringify(skeleton));
  const fill = Math.max(1, targetBytes - overhead);
  // Mix single-byte and multi-byte characters so byte length != char length.
  const unit = rng.chance(0.5) ? 'r' : '\u00e9';
  const unitBytes = utf8ByteLength(unit);
  const count = Math.floor(fill / unitBytes);
  return {
    ...skeleton,
    refreshToken: unit.repeat(count) + 'r'.repeat(fill - count * unitBytes),
  };
}
