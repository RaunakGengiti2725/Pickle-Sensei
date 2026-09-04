/**
 * ADVERSARIAL PASS 3 — mobile-ios-config — S6 (runtime half)
 *
 * The static half of S6 (mutating API_BASE_URL to http:// in a scratch
 * worktree and running be-mobile-security-secrets / the compliance suite) is
 * performed by scripts/attack/ios-config-3/mutation-harness.mjs. This file
 * attacks the RUNTIME guard, `normalizeApiBaseUrl`, with hostile URL shapes:
 * scheme case, userinfo, IPv6, look-alike hosts, whitespace, unicode, huge
 * inputs, and the exact local-development allow-list.
 */
import {
  AccountBootstrapError,
  normalizeApiBaseUrl,
} from '../../../src/account/bootstrap';

const HTTPS_ONLY = 'The account API must use HTTPS outside local development.';
const INVALID = 'The configured account API URL is invalid.';
const MISSING =
  'Synced accounts need a public API URL in the release configuration.';

function rejection(value: string | null | undefined): AccountBootstrapError {
  try {
    normalizeApiBaseUrl(value);
  } catch (error) {
    if (error instanceof AccountBootstrapError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(value)} to be rejected`);
}

describe('S6 — normalizeApiBaseUrl rejects non-HTTPS origins outside local development', () => {
  it.each([
    'http://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api',
    'HTTP://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api',
    'http://ucqnaiwqwjtgvlduiuib.supabase.co',
    'http://localhost.evil.example/functions/v1/api',
    'http://127.0.0.1.nip.io/functions/v1/api',
    'http://10.0.2.2.example.com/api',
    'http://localhost@evil.example/api', // userinfo trick: hostname is evil.example
    'http://evil.example/localhost',
    'http://[::1]:54321/functions/v1/api', // IPv6 loopback is NOT on the allow-list
    'http://0.0.0.0:54321/functions/v1/api',
    'http://192.168.1.10:54321/functions/v1/api',
    'http://xn--localhost-9ya.example/api',
    'http://lоcalhost:54321/api', // Cyrillic о
    'ws://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api',
    'ftp://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'https+http://host/api',
  ])('rejects %s with account.not_configured / HTTPS message', value => {
    const error = rejection(value);
    expect(error.code).toBe('account.not_configured');
    expect(error.message).toBe(HTTPS_ONLY);
    expect(error.retryable).toBe(false);
  });

  it.each([
    ['not a url', 'ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api'],
    ['scheme-relative', '//ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api'],
    ['space inside scheme', 'ht tps://ucqnaiwqwjtgvlduiuib.supabase.co'],
    ['bare word', 'https'],
    ['colon only', 'https:'],
    ['unicode garbage', '\u{1F952}\u{1F952}\u{1F952}'],
    ['NUL embedded host', 'https://ucq\u0000naiwq.supabase.co/api'],
  ])('rejects %s as invalid', (_label, value) => {
    const error = rejection(value);
    expect(error.code).toBe('account.not_configured');
    expect(error.message).toBe(INVALID);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   \t\n'],
    ['only slashes', '///'],
    ['slashes and whitespace', '  ///  '],
  ])('rejects %s as missing', (_label, value) => {
    const error = rejection(value);
    expect(error.code).toBe('account.not_configured');
    expect(error.message).toBe(MISSING);
  });

  it('accepts the checked-in production URL exactly, stripping trailing slashes', () => {
    const url = 'https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api';
    expect(normalizeApiBaseUrl(url)).toBe(url);
    expect(normalizeApiBaseUrl(`${url}///`)).toBe(url);
    expect(normalizeApiBaseUrl(`  ${url}/  `)).toBe(url);
  });

  it('accepts plain http only for the three local-development hosts (exact hostname match)', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.2.2']) {
      expect(normalizeApiBaseUrl(`http://${host}:54321/functions/v1/api`)).toBe(
        `http://${host}:54321/functions/v1/api`,
      );
      expect(normalizeApiBaseUrl(`http://${host}/functions/v1/api/`)).toBe(
        `http://${host}/functions/v1/api`,
      );
    }
    // uppercase hostname is lower-cased by URL(), so still local
    expect(normalizeApiBaseUrl('http://LOCALHOST:54321/api')).toBe(
      'http://LOCALHOST:54321/api',
    );
  });

  it('upper/mixed-case HTTPS scheme is still HTTPS (URL() normalizes) and returns the input verbatim', () => {
    expect(
      normalizeApiBaseUrl('HTTPS://ucqnaiwqwjtgvlduiuib.supabase.co/api'),
    ).toBe('HTTPS://ucqnaiwqwjtgvlduiuib.supabase.co/api');
  });

  it('huge inputs are rejected or accepted without throwing anything but AccountBootstrapError', () => {
    const hugePath = '/a'.repeat(200_000);
    expect(
      normalizeApiBaseUrl(
        `https://ucqnaiwqwjtgvlduiuib.supabase.co${hugePath}`,
      ),
    ).toBe(`https://ucqnaiwqwjtgvlduiuib.supabase.co${hugePath}`);
    const error = rejection(
      `http://ucqnaiwqwjtgvlduiuib.supabase.co${hugePath}`,
    );
    expect(error.message).toBe(HTTPS_ONLY);
    const garbage = 'x'.repeat(1_000_000);
    expect(rejection(garbage).message).toBe(INVALID);
  });

  it('is deterministic under rapid seeded repeats and mixed interleavings', () => {
    let seed = 0x5eed1234;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const candidates: Array<
      [string, 'ok' | typeof HTTPS_ONLY | typeof INVALID | typeof MISSING]
    > = [
      ['https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api', 'ok'],
      ['http://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api', HTTPS_ONLY],
      ['http://localhost:54321/functions/v1/api', 'ok'],
      ['http://[::1]:54321/functions/v1/api', HTTPS_ONLY],
      ['nope', INVALID],
      ['', MISSING],
    ];
    for (let i = 0; i < 5_000; i += 1) {
      const pick = candidates[Math.floor(rand() * candidates.length)];
      if (!pick) throw new Error('seeded pick out of range');
      const [value, expected] = pick;
      if (expected === 'ok') {
        expect(normalizeApiBaseUrl(value)).toBe(value);
      } else {
        expect(rejection(value).message).toBe(expected);
      }
    }
  });
});
