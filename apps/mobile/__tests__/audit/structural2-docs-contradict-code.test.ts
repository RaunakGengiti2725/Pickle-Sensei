/**
 * Structural audit #2 (mobile-auth-session) — docs/comments that contradict
 * the code they sit next to.
 *
 * `src/account/AUTH_LIMITATIONS.md` describes the pre-vault model (provider
 * token IS the bearer, no refresh endpoint, re-authenticate on every restart)
 * and is pinned AS-IS by `__tests__/wf/fix-10-authLimitationsDoc.test.ts`,
 * while `sessionLifecycle.ts`, `sessionVault.ts`, `sessionKeeper.ts` and
 * `AGENTS.md` ("closing the app must NEVER sign out") implement and mandate
 * the opposite. This suite checks the doc against the code it documents.
 *
 * Audit-only: new file, touches no production code and no existing test.
 * The "SUSPECTED DEFECT" case is expected to FAIL on 4d812e1a.
 */
export {};

declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const account = (file: string) =>
  readFileSync(join(__dirname, '..', '..', 'src', 'account', file), 'utf8');
const authStore = readFileSync(
  join(__dirname, '..', '..', 'src', 'auth', 'authStore.ts'),
  'utf8',
);

describe('AUTH_LIMITATIONS.md vs. the session code beside it', () => {
  const doc = account('AUTH_LIMITATIONS.md');
  const lifecycle = account('sessionLifecycle.ts');
  const vault = account('sessionVault.ts');

  it('VERIFIED (code side): the refresh endpoint, the Keychain vault and the vault-first hydrate all exist', () => {
    expect(lifecycle).toMatch(/\/v1\/auth\/refresh/);
    expect(vault).toMatch(/react-native-keychain/);
    expect(vault).toMatch(/AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY/);
    expect(authStore).toMatch(/loadPersistedSession\(\)/);
    expect(authStore).toMatch(/startSessionKeeper\(/);
  });

  it('SUSPECTED DEFECT: the doc still asserts the pre-vault contract that the adjacent code no longer has', () => {
    const contradictions = [
      {
        claim: 'no backend token-exchange or refresh-session endpoint',
        pattern: /no\s+backend token-exchange or refresh-session endpoint/,
        reality: 'sessionLifecycle.ts posts to /v1/auth/refresh',
      },
      {
        claim: 'The provider identity token IS the API bearer',
        pattern: /provider identity token IS the API bearer/,
        reality:
          'bootstrap.ts returns the Supabase access token as bearerToken when the server mints a session',
      },
      {
        claim: 'On process restart a synced user must authenticate again',
        pattern: /On process restart a synced user must\s+authenticate again/,
        reality:
          'authStore.hydrate() restores from the Keychain vault first (AGENTS.md: closing the app must NEVER sign out)',
      },
      {
        claim:
          'Transports read the bearer from getApiSession() at request time',
        pattern: /read the bearer from `getApiSession\(\)` at request time/,
        reality:
          'long-lived clients resolve it through bearerTokenFor(canonicalAppUserId), which also scopes it to the current account',
      },
    ];
    const stale = contradictions.filter(c => c.pattern.test(doc));
    // Observed on 4d812e1a: all four claims are still in the doc (and
    // fix-10-authLimitationsDoc.test.ts pins two of them). Expected: none.
    expect(stale.map(c => `${c.claim} — but ${c.reality}`)).toEqual([]);
  });
});

describe('sessionVault.ts comment vs. behaviour', () => {
  it('SUSPECTED DEFECT: clearPersistedSession() documents a failed Keychain delete as harmless, but hydrate() trusts whatever the vault holds', () => {
    const vault = account('sessionVault.ts');
    expect(vault).toMatch(
      /a stale item is harmless until the next sign-in\s+\/\/\s*overwrites it/,
    );
    // authStore.hydrate() → loadPersistedSession() → restorePersistedSession():
    // a record that survived a failed delete is signed in again on the next
    // launch (see structural2-authStore-vault.test.ts, "Keychain delete
    // failure during sign-out"). The comment and the behaviour disagree; one
    // of them has to move.
    expect(authStore).toMatch(
      /const persisted = await loadPersistedSession\(\);\s+if \(persisted\) \{\s+const outcome = await restorePersistedSession\(persisted\);/,
    );
    expect(vault).not.toMatch(/a stale item is harmless/);
  });
});
