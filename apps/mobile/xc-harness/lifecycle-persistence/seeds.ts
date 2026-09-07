/**
 * Deterministic inputs for the lifecycle/persistence matrix.
 *
 * Everything here is a pure function of a name or a 32-bit seed, so any row
 * of the emitted JSON tables can be replayed by name/seed alone. Nothing is
 * random at import time.
 */

/** mulberry32 — tiny, deterministic, good enough for scenario sampling. */
export function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

export const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';
export const OTHER_CANONICAL_ID = '0b4d1f9e-3c2a-4b8e-9f1d-2a6c7e8b9d01';

/**
 * Raw string corruptions applied to ANY persisted string slot (a SQLite kv
 * value, a Keychain password). `absent` means the key/row does not exist.
 */
export const RAW_STRING_VARIANTS = {
  absent: null,
  empty: '',
  whitespace: '   \n\t ',
  'not-json': 'definitely not json',
  'truncated-json': '{"version":1,"provider":"app',
  'json-null': 'null',
  'json-true': 'true',
  'json-number': '42',
  'json-string': '"a string"',
  'json-array': '[1,2,3]',
  'json-empty-object': '{}',
  'json-nested-garbage': '{"a":{"b":[{"c":null}]}}',
  'nul-bytes': 'abc\u0000def\u0000',
  'unicode-noise': '\u{1F3D3}\uFFFD\u202E{"version":1}',
  'huge-1mb': 'x'.repeat(1024 * 1024),
  'deep-nesting': '['.repeat(5000) + ']'.repeat(5000),
  'html-injection': '<script>alert(1)</script>',
  'sql-injection': "'; DROP TABLE local_shot; --",
} as const;

export type RawVariantName = keyof typeof RAW_STRING_VARIANTS;
export const RAW_VARIANT_NAMES = Object.keys(
  RAW_STRING_VARIANTS,
) as RawVariantName[];

export interface ValidVaultRecord {
  version: 1;
  provider: 'apple' | 'google';
  canonicalAppUserId: string;
  refreshToken: string;
  email: string | null;
  displayName: string | null;
}

export function validVault(
  overrides: Partial<ValidVaultRecord> = {},
): ValidVaultRecord {
  return {
    version: 1,
    provider: 'apple',
    canonicalAppUserId: CANONICAL_ID,
    refreshToken: 'refresh-seeded',
    email: 'pat@example.com',
    displayName: 'Pat Player',
    ...overrides,
  };
}

/**
 * Structured Keychain-record mutations: every field omitted, wrong-typed,
 * emptied or moved out of its allowed set, plus additive junk. Each entry is
 * the exact JSON string that ends up as the Keychain password.
 */
export const VAULT_RECORD_VARIANTS: Record<string, string> = (() => {
  const base = validVault();
  const out: Record<string, string> = {
    'valid-apple': JSON.stringify(base),
    'valid-google': JSON.stringify(validVault({ provider: 'google' })),
    'valid-null-descriptor': JSON.stringify(
      validVault({ email: null, displayName: null }),
    ),
    'valid-uppercase-uuid': JSON.stringify(
      validVault({ canonicalAppUserId: CANONICAL_ID.toUpperCase() }),
    ),
    'valid-extra-fields': JSON.stringify({
      ...base,
      accessToken: 'MUST-NOT-BE-HONOURED',
      bearerToken: 'MUST-NOT-BE-HONOURED',
      providerToken: 'MUST-NOT-BE-HONOURED',
    }),
    'version-0': JSON.stringify({ ...base, version: 0 }),
    'version-2-future': JSON.stringify({ ...base, version: 2 }),
    'version-string-1': JSON.stringify({ ...base, version: '1' }),
    'version-missing': JSON.stringify(omit(base, 'version')),
    'provider-guest': JSON.stringify({ ...base, provider: 'guest' }),
    'provider-facebook': JSON.stringify({ ...base, provider: 'facebook' }),
    'provider-missing': JSON.stringify(omit(base, 'provider')),
    'provider-number': JSON.stringify({ ...base, provider: 1 }),
    'canonical-missing': JSON.stringify(omit(base, 'canonicalAppUserId')),
    'canonical-empty': JSON.stringify({ ...base, canonicalAppUserId: '' }),
    'canonical-number': JSON.stringify({ ...base, canonicalAppUserId: 42 }),
    'canonical-not-uuid': JSON.stringify({
      ...base,
      canonicalAppUserId: 'not-a-uuid',
    }),
    'canonical-nil-uuid': JSON.stringify({
      ...base,
      canonicalAppUserId: '00000000-0000-0000-0000-000000000000',
    }),
    'canonical-padded-uuid': JSON.stringify({
      ...base,
      canonicalAppUserId: `  ${CANONICAL_ID}  `,
    }),
    'canonical-other-account': JSON.stringify({
      ...base,
      canonicalAppUserId: OTHER_CANONICAL_ID,
    }),
    'refresh-missing': JSON.stringify(omit(base, 'refreshToken')),
    'refresh-empty': JSON.stringify({ ...base, refreshToken: '' }),
    'refresh-number': JSON.stringify({ ...base, refreshToken: 12345 }),
    'refresh-whitespace': JSON.stringify({ ...base, refreshToken: '   ' }),
    'refresh-huge': JSON.stringify({
      ...base,
      refreshToken: 'r'.repeat(64 * 1024),
    }),
    'email-number': JSON.stringify({ ...base, email: 7 }),
    'email-object': JSON.stringify({ ...base, email: { x: 1 } }),
    'displayName-array': JSON.stringify({ ...base, displayName: ['Pat'] }),
    'displayName-huge': JSON.stringify({
      ...base,
      displayName: 'n'.repeat(100_000),
    }),
    // Written by hand: an object-literal `__proto__:` key sets the prototype
    // instead of producing an own property, so JSON.stringify would drop it.
    'proto-pollution': `${JSON.stringify(base).slice(0, -1)},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`,
  };
  for (const name of RAW_VARIANT_NAMES) {
    const raw = RAW_STRING_VARIANTS[name];
    if (raw !== null) out[`raw-${name}`] = raw;
  }
  return out;
})();

export const VAULT_VARIANT_NAMES = Object.keys(VAULT_RECORD_VARIANTS);

/** Variants whose record the vault parser must ACCEPT (valid shape). */
export const VAULT_ACCEPTED_VARIANTS = new Set<string>([
  'valid-apple',
  'valid-google',
  'valid-null-descriptor',
  'valid-uppercase-uuid',
  'valid-extra-fields',
  'email-number',
  'email-object',
  'displayName-array',
  'displayName-huge',
  'proto-pollution',
  'refresh-whitespace',
  'refresh-huge',
  'canonical-not-uuid',
  'canonical-nil-uuid',
  'canonical-padded-uuid',
  'canonical-other-account',
]);

/** Accepted by the parser but NOT a canonical backend UUID after trim —
 * `canonicalDataOwner()` refuses these. */
export const VAULT_ACCEPTED_NON_UUID = new Set<string>([
  'canonical-not-uuid',
  'canonical-nil-uuid',
]);

function omit<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const copy = { ...(value as Record<string, unknown>) };
  delete copy[key as string];
  return copy as Omit<T, K>;
}

/** SQLite kv values the auth store reads at launch. */
export const LOCAL_GUEST_VALUE = JSON.stringify({ version: 1, mode: 'guest' });
export const LAST_PROVIDER_GOOGLE_VALUE = JSON.stringify({
  version: 1,
  provider: 'google',
});

export const KV_LOCAL_MODE_VARIANTS: Record<string, string | null> = {
  ...prefixRaw('raw'),
  'valid-guest': LOCAL_GUEST_VALUE,
  'guest-version-2': JSON.stringify({ version: 2, mode: 'guest' }),
  'guest-key-order': '{"mode":"guest","version":1}',
  'guest-spaced': '{ "version": 1, "mode": "guest" }',
  'mode-synced': JSON.stringify({ version: 1, mode: 'synced' }),
};

export const KV_LAST_PROVIDER_VARIANTS: Record<string, string | null> = {
  ...prefixRaw('raw'),
  'valid-google': LAST_PROVIDER_GOOGLE_VALUE,
  'provider-apple': JSON.stringify({ version: 1, provider: 'apple' }),
  'google-key-order': '{"provider":"google","version":1}',
  'google-version-2': JSON.stringify({ version: 2, provider: 'google' }),
};

export const KV_LEGACY_SESSION_VARIANTS: Record<string, string | null> = {
  ...prefixRaw('raw'),
  'legacy-token-blob': JSON.stringify({
    provider: 'google',
    idToken: 'LEGACY-ID-TOKEN-MUST-BE-WIPED',
    subject: 'legacy-subject',
  }),
};

function prefixRaw(prefix: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of RAW_VARIANT_NAMES) {
    out[`${prefix}-${name}`] = RAW_STRING_VARIANTS[name];
  }
  return out;
}

export interface ValidProfile {
  skillLevel: string;
  handedness: string;
  goal: string;
  biggestProblem: string;
  focusCheckpoint: string;
  firstName?: string;
}

export function validProfile(
  overrides: Partial<ValidProfile> = {},
): ValidProfile {
  return {
    skillLevel: 'intermediate',
    handedness: 'right',
    goal: 'consistency',
    biggestProblem: 'popups',
    focusCheckpoint: 'contact_point',
    ...overrides,
  };
}

export const PROFILE_KV_VARIANTS: Record<string, string | null> = {
  ...prefixRaw('raw'),
  valid: JSON.stringify(validProfile()),
  'valid-with-name': JSON.stringify(validProfile({ firstName: 'Pat' })),
  'missing-focus': JSON.stringify(omit(validProfile(), 'focusCheckpoint')),
  'wrong-types': JSON.stringify({
    skillLevel: 3,
    handedness: null,
    goal: [],
    biggestProblem: {},
    focusCheckpoint: true,
  }),
  'nested-profile-wrapper': JSON.stringify({ profile: validProfile() }),
};

export const PENDING_PROFILE_KV_VARIANTS: Record<string, string | null> = {
  ...prefixRaw('raw'),
  valid: JSON.stringify({ version: 1, profile: validProfile() }),
  'bare-profile': JSON.stringify(validProfile()),
  'profile-missing-field': JSON.stringify({
    version: 1,
    profile: omit(validProfile(), 'goal'),
  }),
  'profile-wrong-types': JSON.stringify({
    version: 1,
    profile: { ...validProfile(), skillLevel: 5 },
  }),
  'profile-array': JSON.stringify({ version: 1, profile: [validProfile()] }),
};

export const GENERIC_JSON_KV_VARIANTS: Record<string, string | null> = {
  ...prefixRaw('raw'),
  'version-99': JSON.stringify({ version: 99 }),
  'wrong-shape': JSON.stringify({ version: 1, enabled: 'yes', drills: 3 }),
};
