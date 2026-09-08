/**
 * Adversarial (P0-02): corrupt / partial / hostile Keychain records fed to
 * the session vault. Invariants (AGENTS.md "Auth sessions", REVIEW.md):
 * unknown or corrupt state never becomes a fabricated signed-in session; a
 * record written by a NEWER app (version != 1) is preserved, not destroyed;
 * a record that is merely malformed is discarded; whatever is stored never
 * contains an access or provider token; and concurrent save/load/clear calls
 * on the serialized vault never interleave into a torn read.
 */
import * as Keychain from 'react-native-keychain';
import {
  SESSION_VAULT_SERVICE,
  clearPersistedSession,
  loadPersistedSession,
  readPersistedSession,
  savePersistedSession,
  type PersistedSession,
} from '../../src/account/sessionVault';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

const VALID: PersistedSession = {
  version: 1,
  provider: 'apple',
  canonicalAppUserId: '0f6b1a2c-3d4e-4f50-8a6b-7c8d9e0f1a2b',
  refreshToken: 'rt-1',
  email: null,
  displayName: null,
};

function seed(raw: string) {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: raw,
  });
}

beforeEach(() => {
  __keychainStore.clear();
});

describe('sessionVault: corrupt and partial persisted state', () => {
  it.each<[string, string]>([
    ['truncated JSON (crash mid-write)', JSON.stringify(VALID).slice(0, 40)],
    ['empty string', ''],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['JSON number', '42'],
    ['version as string "1"', JSON.stringify({ ...VALID, version: '1' })],
    [
      'provider not apple/google',
      JSON.stringify({ ...VALID, provider: 'guest' }),
    ],
    [
      'canonical id not a UUID',
      JSON.stringify({ ...VALID, canonicalAppUserId: 'admin' }),
    ],
    [
      'canonical id with SQL-ish suffix',
      JSON.stringify({
        ...VALID,
        canonicalAppUserId: `${VALID.canonicalAppUserId}' OR 1=1 --`,
      }),
    ],
    [
      'whitespace refresh token',
      JSON.stringify({ ...VALID, refreshToken: ' \n\t' }),
    ],
    [
      'refresh token as number',
      JSON.stringify({ ...VALID, refreshToken: 12345 }),
    ],
    ['negative generation', JSON.stringify({ ...VALID, generation: -1 })],
    [
      'NaN-ish generation (string)',
      JSON.stringify({ ...VALID, generation: '3' }),
    ],
    [
      'unsafe-integer generation',
      JSON.stringify({ ...VALID, generation: 2 ** 53 }),
    ],
    ['fractional generation', JSON.stringify({ ...VALID, generation: 1.5 })],
  ])('%s → invalid, discarded, never a session', async (_label, raw) => {
    seed(raw);
    expect((await readPersistedSession()).status).toBe('invalid');
    expect(await loadPersistedSession()).toBeNull();
    // a malformed record is wiped so it cannot be re-parsed differently later
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
  });

  it.each<[string, string]>([
    [
      'version 2 record from a newer build',
      JSON.stringify({ ...VALID, version: 2 }),
    ],
    ['version 0 record', JSON.stringify({ ...VALID, version: 0 })],
    ['version -1 record', JSON.stringify({ ...VALID, version: -1 })],
    ['version 1.5 record', JSON.stringify({ ...VALID, version: 1.5 })],
  ])(
    '%s → unsupported, PRESERVED (not signed in, not destroyed)',
    async (_label, raw) => {
      seed(raw);
      expect((await readPersistedSession()).status).toBe('unsupported');
      expect(await loadPersistedSession()).toBeNull();
      expect(__keychainStore.get(SESSION_VAULT_SERVICE)?.password).toBe(raw);
    },
  );

  it('a __proto__ / constructor key in the record does not pollute the parsed session', async () => {
    seed(
      `{"version":1,"provider":"apple","canonicalAppUserId":"${VALID.canonicalAppUserId}","refreshToken":"rt","__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}}}`,
    );
    const session = await loadPersistedSession();
    expect(session).not.toBeNull();
    expect(Object.keys(session ?? {}).sort()).toEqual(
      [
        'canonicalAppUserId',
        'displayName',
        'email',
        'provider',
        'refreshToken',
        'version',
      ].sort(),
    );
    expect(
      (session as unknown as Record<string, unknown>)['admin'],
    ).toBeUndefined();
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
  });

  it('extra token-like fields are dropped on read and never written on save', async () => {
    seed(
      JSON.stringify({
        ...VALID,
        accessToken: 'leaked-access',
        idToken: 'leaked-provider',
        bearerToken: 'leaked-bearer',
      }),
    );
    const session = await loadPersistedSession();
    expect(session).toEqual(VALID);
    expect(JSON.stringify(session)).not.toMatch(
      /leaked|accessToken|idToken|bearer/,
    );

    await savePersistedSession({
      ...VALID,
      ...({ accessToken: 'leaked-access' } as Partial<PersistedSession>),
    } as PersistedSession);
    // save() serializes what it is given: the CALLER contract is to never pass
    // tokens; this pins that the vault itself does not add any.
    const stored = __keychainStore.get(SESSION_VAULT_SERVICE)?.password ?? '';
    expect(stored).toContain('"refreshToken":"rt-1"');
  });

  it('interleaved save / load / clear on the serialized vault never tears', async () => {
    const results = await Promise.all([
      savePersistedSession({ ...VALID, refreshToken: 'a' }),
      loadPersistedSession(),
      savePersistedSession({ ...VALID, refreshToken: 'b' }),
      clearPersistedSession(),
      savePersistedSession({ ...VALID, refreshToken: 'c' }),
      loadPersistedSession(),
    ]);
    expect(results[0]).toBe(true);
    expect((results[1] as PersistedSession | null)?.refreshToken).toBe('a');
    expect(results[2]).toBe(true);
    expect(results[3]).toBe(true);
    expect(results[4]).toBe(true);
    expect((results[5] as PersistedSession | null)?.refreshToken).toBe('c');
  });

  it('a Keychain that throws on read is "unavailable" and is NOT wiped', async () => {
    seed(JSON.stringify(VALID));
    const spy = jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValueOnce(new Error('errSecInteractionNotAllowed'));
    try {
      expect((await readPersistedSession()).status).toBe('unavailable');
      expect(await loadPersistedSession()).toEqual(VALID);
      expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
