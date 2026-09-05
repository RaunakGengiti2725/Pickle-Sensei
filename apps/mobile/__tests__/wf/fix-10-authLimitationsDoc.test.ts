export {};

declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const doc = readFileSync(
  join(__dirname, '..', '..', 'src', 'account', 'AUTH_LIMITATIONS.md'),
  'utf8',
);

describe('AUTH_LIMITATIONS.md documents the shipping durable-session contract', () => {
  it('names the production exchange, access bearer and secure refresh-token storage', () => {
    expect(doc).toContain('POST /v1/account/bootstrap');
    expect(doc).toContain('Supabase access token');
    expect(doc).toContain('POST /v1/auth/refresh');
    expect(doc).toContain('Keychain/Keystore');
    expect(doc).toContain('AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY');
    expect(doc).not.toContain('provider identity token IS the API bearer');
    expect(doc).not.toContain(
      'no backend token-exchange or refresh-session endpoint',
    );
  });

  it('separates transient failures and compatibility from definitive revocation', () => {
    expect(doc).toContain('Only a definitive refresh-token refusal');
    expect(doc).toContain('429 responses and 5xx responses remain retryable');
    expect(doc).toContain('AUTH_FAILURE_LIMIT');
    expect(doc).toContain('transitional path');
    expect(doc).toContain('legacy Google silent-restore flag');
  });

  it('states per-request resolution and the limits of logout and deletion', () => {
    expect(doc).toContain('bearerTokenFor(canonicalAppUserId)');
    expect(doc).toContain('POST /v1/auth/logout');
    expect(doc).toContain('scope=local');
    expect(doc).toContain('Access JWTs can remain valid until their `exp`');
    expect(doc).toContain('captureAccountDeletionScope()');
    expect(doc).toContain('media cleanup precedes owner-row purge');
    expect(doc).toContain('App Review approval');
  });
});
