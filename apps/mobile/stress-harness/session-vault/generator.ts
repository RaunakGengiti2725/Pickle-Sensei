/**
 * Seeded generator of legal / near-legal action sequences over the
 * sessionVault public API (`savePersistedSession`, `loadPersistedSession`,
 * `clearPersistedSession`) plus the two things the device does behind the
 * module's back: another build (or another app version) leaving a corrupt or
 * oversized record in the Keychain item, and the Keychain itself refusing an
 * operation.
 *
 * Every sequence is a pure function of its 32-bit seed, so any row of the
 * emitted table replays from the seed alone.
 */
import type { PersistedSession } from '../../src/account/sessionVault';
import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';
import type { KeychainOpMode } from './keychainFake';

export const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';
export const OTHER_CANONICAL_ID = '0b4d1f9e-3c2a-4b8e-9f1d-2a6c7e8b9d01';
export const FOREIGN_SERVICE = 'com.picklesensei.other.item';

export interface SessionVariant {
  name: string;
  /** Passed to `savePersistedSession` — near-legal values are typed through
   * the public interface exactly as a buggy caller would produce them. */
  session: PersistedSession;
  /** Whether the contract's reader must accept the record it produces. */
  loadable: boolean;
}

function session(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    version: 1,
    provider: 'apple',
    canonicalAppUserId: CANONICAL_ID,
    refreshToken: 'refresh-token-seeded',
    email: 'pat@example.com',
    displayName: 'Pat Player',
    ...overrides,
  };
}

/** 1 MiB — larger than any real Keychain generic-password payload, kept to
 * prove the module neither truncates nor throws on an oversized record. */
const ONE_MIB = 1024 * 1024;

export const SESSION_VARIANTS: SessionVariant[] = [
  { name: 'apple', session: session(), loadable: true },
  {
    name: 'google',
    session: session({ provider: 'google', refreshToken: 'refresh-google' }),
    loadable: true,
  },
  {
    name: 'null-descriptor',
    session: session({ email: null, displayName: null }),
    loadable: true,
  },
  {
    name: 'uppercase-uuid',
    session: session({ canonicalAppUserId: CANONICAL_ID.toUpperCase() }),
    loadable: true,
  },
  {
    name: 'other-account',
    session: session({
      canonicalAppUserId: OTHER_CANONICAL_ID,
      refreshToken: 'refresh-other',
    }),
    loadable: true,
  },
  {
    name: 'unicode-descriptor',
    session: session({
      displayName: '🏓 Pat\u202E\uFFFD',
      email: 'pat+🏓@example.com',
    }),
    loadable: true,
  },
  {
    name: 'nul-bytes-in-token',
    session: session({ refreshToken: 'abc\u0000def' }),
    loadable: true,
  },
  {
    name: 'quote-heavy-descriptor',
    session: session({ displayName: '"}{\\\\"; DROP TABLE kv; --' }),
    loadable: true,
  },
  {
    name: 'token-64kb',
    session: session({ refreshToken: 'r'.repeat(64 * 1024) }),
    loadable: true,
  },
  {
    name: 'record-1mb',
    session: session({ refreshToken: 'r'.repeat(ONE_MIB) }),
    loadable: true,
  },
  {
    name: 'display-name-1mb',
    session: session({ displayName: 'n'.repeat(ONE_MIB) }),
    loadable: true,
  },
  // ── near-legal: allowed by the TypeScript interface, refused by the reader
  {
    name: 'near-empty-refresh',
    session: session({ refreshToken: '' }),
    loadable: false,
  },
  {
    name: 'near-empty-canonical',
    session: session({ canonicalAppUserId: '' }),
    loadable: false,
  },
];

export const SESSION_VARIANT_NAMES = SESSION_VARIANTS.map(
  variant => variant.name,
);

/** Raw payloads another build / a corrupted item can leave in the vault. */
export const CORRUPT_RECORD_VARIANTS: Record<string, string> = {
  empty: '',
  whitespace: '   \n\t ',
  'not-json': 'definitely not json',
  'truncated-json': '{"version":1,"provider":"app',
  'json-null': 'null',
  'json-true': 'true',
  'json-number': '42',
  'json-string': '"a string"',
  'json-array': JSON.stringify([session()]),
  'json-empty-object': '{}',
  'nul-bytes': 'abc\u0000def\u0000',
  'unicode-noise': '\u{1F3D3}\uFFFD\u202E{"version":1}',
  'huge-1mb-garbage': 'x'.repeat(ONE_MIB),
  'deep-nesting': '['.repeat(5000) + ']'.repeat(5000),
  'version-0': JSON.stringify({ ...session(), version: 0 }),
  'version-2-future': JSON.stringify({ ...session(), version: 2 }),
  'version-string': JSON.stringify({ ...session(), version: '1' }),
  'provider-unknown': JSON.stringify({ ...session(), provider: 'facebook' }),
  'provider-number': JSON.stringify({ ...session(), provider: 7 }),
  'canonical-number': JSON.stringify({ ...session(), canonicalAppUserId: 42 }),
  'canonical-missing': '{"version":1,"provider":"apple","refreshToken":"r"}',
  'refresh-number': JSON.stringify({ ...session(), refreshToken: 5 }),
  'refresh-missing':
    '{"version":1,"provider":"apple","canonicalAppUserId":"7fc2c743-028f-4ec6-942c-a84508f3be38"}',
  'email-number': JSON.stringify({ ...session(), email: 7 }),
  'display-name-array': JSON.stringify({ ...session(), displayName: ['Pat'] }),
  'extra-token-fields': JSON.stringify({
    ...session(),
    accessToken: 'MUST-NOT-BE-RETURNED',
    bearerToken: 'MUST-NOT-BE-RETURNED',
    providerToken: 'MUST-NOT-BE-RETURNED',
  }),
  // Written by hand: an object-literal `__proto__` key sets the prototype
  // instead of producing an own property, so JSON.stringify would drop it.
  'proto-pollution': `${JSON.stringify(session()).slice(0, -1)},"__proto__":{"vaultPolluted":true},"constructor":{"prototype":{"vaultPolluted":true}}}`,
};

export const CORRUPT_VARIANT_NAMES = Object.keys(CORRUPT_RECORD_VARIANTS);

export const OP_MODES: KeychainOpMode[] = ['ok', 'throws', 'returns-false'];

export type Step =
  | { kind: 'save'; variant: string }
  | { kind: 'load' }
  | { kind: 'clear' }
  | { kind: 'corrupt'; variant: string }
  | { kind: 'foreign-write' }
  | { kind: 'fault'; op: 'set' | 'get' | 'reset'; mode: KeychainOpMode };

const STEP_KINDS = [
  'save',
  'save',
  'load',
  'load',
  'load',
  'clear',
  'corrupt',
  'corrupt',
  'foreign-write',
  'fault',
  'fault',
] as const;

export interface Sequence {
  seed: number;
  steps: Step[];
}

/** Length 5–60, mirroring a launch/sign-in/relaunch burst on one device. */
export function generateSequence(seed: number): Sequence {
  const rng = makePrng(seed);
  const length = 5 + Math.floor(rng() * 56);
  const steps: Step[] = [];
  for (let index = 0; index < length; index += 1) {
    const kind = pick(rng, STEP_KINDS);
    switch (kind) {
      case 'save':
        steps.push({ kind: 'save', variant: pick(rng, SESSION_VARIANT_NAMES) });
        break;
      case 'corrupt':
        steps.push({
          kind: 'corrupt',
          variant: pick(rng, CORRUPT_VARIANT_NAMES),
        });
        break;
      case 'fault':
        steps.push({
          kind: 'fault',
          op: pick(rng, ['set', 'get', 'reset'] as const),
          mode: pick(rng, OP_MODES),
        });
        break;
      case 'load':
        steps.push({ kind: 'load' });
        break;
      case 'clear':
        steps.push({ kind: 'clear' });
        break;
      case 'foreign-write':
        steps.push({ kind: 'foreign-write' });
        break;
    }
  }
  return { seed, steps };
}

export function sessionVariant(name: string): SessionVariant {
  const found = SESSION_VARIANTS.find(variant => variant.name === name);
  if (!found) throw new Error(`unknown session variant: ${name}`);
  return found;
}

/** Compact, replayable rendering of a step (used in traces and artifacts). */
export function describeStep(step: Step): string {
  switch (step.kind) {
    case 'save':
      return `save:${step.variant}`;
    case 'corrupt':
      return `corrupt:${step.variant}`;
    case 'fault':
      return `fault:${step.op}=${step.mode}`;
    default:
      return step.kind;
  }
}

/** FNV-1a over the trace text: two runs of a seed must hash identically. */
export function traceHash(lines: readonly string[]): string {
  let hash = 0x811c9dc5;
  const text = lines.join('\n');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
