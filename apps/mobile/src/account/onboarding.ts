import { CHECKPOINTS, type Handedness } from '@pickle/shared-types';
import type { ApiSession } from './apiSession';
import { focusForGoal, type Gender, type Profile } from '../state/profile';

const GENDERS: readonly Gender[] = [
  'female',
  'male',
  'nonbinary',
  'prefer_not_to_say',
];

function parseGender(value: unknown): Gender | undefined {
  return GENDERS.includes(value as Gender) ? (value as Gender) : undefined;
}

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
  // Identity fields are optional on the wire (first_name/gender): older
  // server profiles predate them and must keep hydrating unchanged.
  const firstName = raw['first_name'];
  const gender = parseGender(raw['gender']);
  return {
    ...(typeof firstName === 'string' && firstName.trim()
      ? { firstName: firstName.trim() }
      : {}),
    ...(gender ? { gender } : {}),
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
  const coreBody = {
    skillLevel: profile.skillLevel,
    handedness: profile.handedness,
    goal: profile.goal,
    biggestProblem: profile.biggestProblem,
  };
  const firstName = profile.firstName?.trim();
  const hasIdentityFields = Boolean(firstName) || profile.gender !== undefined;
  let payload: unknown;
  try {
    payload = await request(
      session,
      'PUT',
      '/v1/me/onboarding',
      {
        ...coreBody,
        // Optional personalization; JSON.stringify drops undefined keys.
        firstName: firstName || undefined,
        gender: profile.gender,
      },
      fetchFn,
    );
  } catch (error) {
    // Never fail onboarding because the OPTIONAL identity fields could not
    // be saved remotely (e.g. a backend that rejects unknown keys). Retry
    // once with the always-supported body; the local profile keeps them.
    if (!hasIdentityFields) throw error;
    try {
      payload = await request(
        session,
        'PUT',
        '/v1/me/onboarding',
        coreBody,
        fetchFn,
      );
    } catch {
      throw error;
    }
  }
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
    ...(firstName ? { firstName } : {}),
    focusCheckpoint: recommendation as Profile['focusCheckpoint'],
  };
}
