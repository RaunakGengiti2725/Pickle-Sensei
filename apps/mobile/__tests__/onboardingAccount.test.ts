import {
  fetchCanonicalOnboardingProfile,
  OnboardingSyncError,
  saveCanonicalOnboardingProfile,
  type OnboardingFetch,
} from '../src/account/onboarding';
import type { ApiSession } from '../src/account/apiSession';
import type { Profile } from '../src/state/profile';

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'provider-token',
  refreshToken: 'refresh-token-1',
  bearerExpiresAtMs: Date.now() + 3_600_000,
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

describe('canonical onboarding profile', () => {
  it('hydrates the real server profile for an already-onboarded account', async () => {
    const fetchFn: OnboardingFetch = async () =>
      jsonResponse({
        onboardingState: 'complete',
        profile: {
          skill_level: '3.5',
          handedness: 'left',
          primary_goal: 'drives',
          biggest_problem: 'contact',
        },
      });

    await expect(
      fetchCanonicalOnboardingProfile(session, fetchFn),
    ).resolves.toEqual({
      skillLevel: '3.5',
      handedness: 'left',
      goal: 'drives',
      biggestProblem: 'contact',
      focusCheckpoint: 'preparation',
    });
  });

  it('saves the answers with authentication and uses the server focus', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn: OnboardingFetch = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ recommendedCheckpoint: 'paddle_set' });
    };

    await expect(
      saveCanonicalOnboardingProfile(session, profile, fetchFn),
    ).resolves.toEqual(profile);
    expect(calls[0]?.url).toBe('https://api.example.test/v1/me/onboarding');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer provider-token',
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      skillLevel: '3.5',
      handedness: 'right',
      goal: 'drops',
      biggestProblem: 'control',
    });
  });

  it('does not convert a server failure into local completion', async () => {
    const fetchFn: OnboardingFetch = async () =>
      jsonResponse(
        {
          error: {
            code: 'db.unavailable',
            message: 'Profile service unavailable.',
          },
        },
        503,
      );

    await expect(
      saveCanonicalOnboardingProfile(session, profile, fetchFn),
    ).rejects.toEqual(
      expect.objectContaining<Partial<OnboardingSyncError>>({
        name: 'OnboardingSyncError',
        message: 'Profile service unavailable.',
      }),
    );
  });
});
