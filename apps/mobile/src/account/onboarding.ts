import { CHECKPOINTS, type Handedness } from '@pickle/shared-types';
import type { ApiSession } from './apiSession';
import { focusForGoal, type Profile } from '../state/profile';

export class OnboardingSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingSyncError';
  }
}

export type OnboardingFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function request(
  session: ApiSession,
  method: 'GET' | 'PUT',
  path: string,
  body?: unknown,
  fetchFn: OnboardingFetch = globalThis.fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetchFn(`${session.apiBaseUrl}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.bearerToken}`,
        'X-Client-Version': '0.1.0',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new OnboardingSyncError(
      'Your coaching profile could not be securely saved. Check your connection and try again.',
    );
  } finally {
    clearTimeout(timeout);
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const serverMessage =
      isRecord(payload) &&
      isRecord(payload['error']) &&
      typeof payload['error']['message'] === 'string'
        ? payload['error']['message']
        : null;
    throw new OnboardingSyncError(
      serverMessage ?? 'Your coaching profile could not be securely saved.',
    );
  }
  return payload;
}

function parseServerProfile(payload: unknown): Profile | null {
  if (!isRecord(payload) || payload['onboardingState'] !== 'complete') {
    return null;
  }
  const raw = payload['profile'];
  if (!isRecord(raw)) return null;
  const skillLevel = raw['skill_level'];
  const handedness = raw['handedness'];
  const goal = raw['primary_goal'];
  const biggestProblem = raw['biggest_problem'];
  if (
    typeof skillLevel !== 'string' ||
    !skillLevel.trim() ||
    (handedness !== 'right' &&
      handedness !== 'left' &&
      handedness !== 'ambidextrous') ||
    typeof goal !== 'string' ||
    !goal.trim() ||
    typeof biggestProblem !== 'string' ||
    !biggestProblem.trim()
  ) {
    return null;
  }
  return {
    skillLevel,
    handedness: handedness as Handedness,
    goal,
    biggestProblem,
    focusCheckpoint: focusForGoal(goal),
  };
}

export async function fetchCanonicalOnboardingProfile(
  session: ApiSession,
  fetchFn?: OnboardingFetch,
): Promise<Profile | null> {
  return parseServerProfile(
    await request(session, 'GET', '/v1/me', undefined, fetchFn),
  );
}

export async function saveCanonicalOnboardingProfile(
  session: ApiSession,
  profile: Profile,
  fetchFn?: OnboardingFetch,
): Promise<Profile> {
  const payload = await request(
    session,
    'PUT',
    '/v1/me/onboarding',
    {
      skillLevel: profile.skillLevel,
      handedness: profile.handedness,
      goal: profile.goal,
      biggestProblem: profile.biggestProblem,
    },
    fetchFn,
  );
  if (!isRecord(payload)) {
    throw new OnboardingSyncError(
      'The account server returned an invalid coaching profile.',
    );
  }
  const recommendation = payload['recommendedCheckpoint'];
  if (
    typeof recommendation !== 'string' ||
    !CHECKPOINTS.includes(recommendation as (typeof CHECKPOINTS)[number])
  ) {
    throw new OnboardingSyncError(
      'The account server returned an invalid training focus.',
    );
  }
  return {
    ...profile,
    focusCheckpoint: recommendation as Profile['focusCheckpoint'],
  };
}
