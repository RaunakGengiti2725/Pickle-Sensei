import {
  fetchCanonicalOnboardingProfile,
  OnboardingSyncError,
  type OnboardingFetch,
} from '../../src/account/onboarding';
import type { ApiSession } from '../../src/account/apiSession';

/**
 * Adjudication repro (ADJ-H) for `mobile-launch-onboarding` @ 4d812e1a.
 *
 * GET /v1/me contract (supabase/functions/api/index.ts): a 2xx body is
 * `{ user, onboardingState: 'complete' | 'pending', profile? }`. Anything
 * else with a 200 status (captive-portal HTML, a proxy stub, a truncated
 * body) is NOT "this account has no profile" — treating it as `null` sends a
 * fully onboarded account back into the questionnaire and the following PUT
 * replaces the server profile. Fails on 4d812e1a.
 */

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'bearer-1',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
};

function respond(
  body: string,
  contentType = 'application/json',
): OnboardingFetch {
  return async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': contentType },
    });
}

describe('ADJ-H — GET /v1/me 200 with an unrecognised body', () => {
  it.each([
    [
      'captive-portal HTML',
      '<html><body>Sign in to Wi-Fi</body></html>',
      'text/html',
    ],
    ['empty body', '', 'application/json'],
    ['JSON null', 'null', 'application/json'],
    ['JSON array', '[]', 'application/json'],
    [
      'object without onboardingState',
      '{"user":{"id":"x"}}',
      'application/json',
    ],
    [
      'unknown onboardingState',
      '{"onboardingState":"garbage"}',
      'application/json',
    ],
  ])(
    '%s is a typed OnboardingSyncError (retryable), not "no profile"',
    async (_label, body, contentType) => {
      await expect(
        fetchCanonicalOnboardingProfile(session, respond(body, contentType)),
      ).rejects.toBeInstanceOf(OnboardingSyncError);
    },
  );

  it('control: a contract-valid pending account is null (no profile) — must keep passing', async () => {
    await expect(
      fetchCanonicalOnboardingProfile(
        session,
        respond('{"user":{"id":"x"},"onboardingState":"pending"}'),
      ),
    ).resolves.toBeNull();
  });
});
