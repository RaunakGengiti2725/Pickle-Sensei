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

describe('AUTH_LIMITATIONS.md documents the provider-token bearer lifetime', () => {
  it('states that the provider identity token is the bearer and has no refresh path', () => {
    expect(doc).toMatch(/provider identity token IS the API bearer/);
    expect(doc).toMatch(
      /no\s+backend token-exchange or refresh-session endpoint/,
    );
  });

  it('states both provider token lifetimes and the resulting 401', () => {
    expect(doc).toMatch(/Apple ID tokens expire after roughly\s+10 minutes/);
    expect(doc).toMatch(/Google ID tokens after roughly 1 hour/);
    expect(doc).toMatch(/401 `The identity token could not be verified\.`/);
  });

  it('pins the expired-bearer contract every client caller must follow', () => {
    expect(doc).toMatch(/exactly one recovery, never a blind retry/);
    expect(doc).toMatch(/GoogleSignin\.signInSilently\(\)/);
    expect(doc).toMatch(/Apple has no\s+silent path/);
    expect(doc).toMatch(
      /read the bearer from `getApiSession\(\)` at request time/,
    );
    expect(doc).toMatch(/401 pauses\s+the retry loop/);
    expect(doc).toMatch(/AUTH_FAILURE_LIMIT/);
    expect(doc).toMatch(/App Review 2\.1 \/ 4\.2/);
  });
});
