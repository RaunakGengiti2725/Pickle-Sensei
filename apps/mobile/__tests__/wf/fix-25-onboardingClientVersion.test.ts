import {
  fetchCanonicalOnboardingProfile,
  saveCanonicalOnboardingProfile,
  type OnboardingFetch,
} from '../../src/account/onboarding';
import type { ApiSession } from '../../src/account/apiSession';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import type { Profile } from '../../src/state/profile';

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'provider-token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
};

const profile: Profile = {
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe('onboarding X-Client-Version header', () => {
  const expected = getRuntimePublicConfig().appVersion;

  it('matches the shipped app version and never the stale 0.1.0 literal', () => {
    expect(expected).toBe('1.0');
    expect(expected).not.toBe('0.1.0');
  });

  it('sends the runtime app version on PUT /v1/me/onboarding', async () => {
    const seen: (string | null)[] = [];
    const fetchFn: OnboardingFetch = async (_input, init) => {
      seen.push(headerOf(init, 'X-Client-Version'));
      return jsonResponse({ recommendedCheckpoint: 'paddle_set' });
    };

    await saveCanonicalOnboardingProfile(session, profile, fetchFn);

    expect(seen).toEqual([expected]);
  });

  it('sends the runtime app version on GET /v1/me', async () => {
    const seen: (string | null)[] = [];
    const fetchFn: OnboardingFetch = async (_input, init) => {
      seen.push(headerOf(init, 'X-Client-Version'));
      return jsonResponse({ onboardingState: 'pending' });
    };

    await fetchCanonicalOnboardingProfile(session, fetchFn);

    expect(seen).toEqual([expected]);
  });
});
