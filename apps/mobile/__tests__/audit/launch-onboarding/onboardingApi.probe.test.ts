import {
  fetchCanonicalOnboardingProfile,
  OnboardingSyncError,
  saveCanonicalOnboardingProfile,
  type OnboardingFetch,
} from '../../../src/account/onboarding';
import type { ApiSession } from '../../../src/account/apiSession';
import type { Profile } from '../../../src/state/profile';

/**
 * Execution audit — /v1/me + /v1/me/onboarding client under failure, empty,
 * stale and corrupt server states. `it.failing` cases pin CURRENT behaviour
 * the audit classifies as a defect (see appStoreHydrate.probe.test.ts).
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/audit/launch-onboarding
 */

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'bearer-1',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
};

const withIdentity: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

const coreOnly: Profile = {
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recorder(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn: OnboardingFetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('probe: unexpected extra request');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchFn, calls };
}

const bodyOf = (init: RequestInit | undefined) =>
  JSON.parse(String(init?.body)) as Record<string, unknown>;

describe('PUT /v1/me/onboarding identity-field fallback', () => {
  it.each([
    ['401 unauthorized', json({ error: { message: 'Unauthorized' } }, 401)],
    [
      '429 rate limited',
      json({ error: { message: 'Too many requests' } }, 429),
    ],
    ['500 server error', json({ error: { message: 'boom' } }, 500)],
    ['network failure', new TypeError('Network request failed')],
  ])(
    'FINDING: after a %s the client immediately re-PUTs WITHOUT first name/gender, and a 2xx on the retry silently drops them server-side',
    async (_label, first) => {
      const { fetchFn, calls } = recorder([
        first,
        json({ recommendedCheckpoint: 'paddle_set' }),
      ]);
      const saved = await saveCanonicalOnboardingProfile(
        session,
        withIdentity,
        fetchFn,
      );
      expect(calls).toHaveLength(2);
      expect(bodyOf(calls[0]!.init)).toMatchObject({
        firstName: 'Dana',
        gender: 'female',
      });
      expect(bodyOf(calls[1]!.init)).toEqual({
        skillLevel: '3.5',
        handedness: 'right',
        goal: 'drops',
        biggestProblem: 'control',
      });
      expect(calls[1]!.init?.headers).toMatchObject({
        Authorization: 'Bearer bearer-1',
      });
      // The local profile keeps the identity fields; the server never got them
      // and nothing reports the divergence to the caller.
      expect(saved).toEqual(withIdentity);
    },
  );

  it('core-only profiles do not retry on failure (single request)', async () => {
    const { fetchFn, calls } = recorder([
      json({ error: { message: 'boom' } }, 500),
    ]);
    await expect(
      saveCanonicalOnboardingProfile(session, coreOnly, fetchFn),
    ).rejects.toThrow(OnboardingSyncError);
    expect(calls).toHaveLength(1);
  });

  it('when both attempts fail the FIRST error (with the server message) is what surfaces', async () => {
    const { fetchFn, calls } = recorder([
      json({ error: { message: 'first-message' } }, 500),
      json({ error: { message: 'second-message' } }, 503),
    ]);
    await expect(
      saveCanonicalOnboardingProfile(session, withIdentity, fetchFn),
    ).rejects.toThrow('first-message');
    expect(calls).toHaveLength(2);
  });
});

describe('request deadline', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('aborts a hanging GET /v1/me after 15s and reports a connection error', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn: OnboardingFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      });
    const pending = fetchCanonicalOnboardingProfile(session, fetchFn);
    const settled = expect(pending).rejects.toThrow(OnboardingSyncError);
    jest.advanceTimersByTime(14_999);
    expect(signal?.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(signal?.aborted).toBe(true);
    await settled;
  });

  it('a hanging identity PUT that aborts is retried once more (worst case two full deadlines = 30s of "Finishing setup…")', async () => {
    const signals: AbortSignal[] = [];
    const fetchFn: OnboardingFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signals.push(signal);
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
          );
        }
      });
    const pending = saveCanonicalOnboardingProfile(
      session,
      withIdentity,
      fetchFn,
    );
    const settled = expect(pending).rejects.toThrow(OnboardingSyncError);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(signals[1]!.aborted).toBe(true);
    await settled;
  });
});

describe('GET /v1/me server states', () => {
  it.each([
    ['empty object', {}],
    ['onboardingState pending', { onboardingState: 'pending', profile: null }],
    ['complete but profile missing', { onboardingState: 'complete' }],
    [
      'complete but profile is an array',
      { onboardingState: 'complete', profile: [] },
    ],
    [
      'complete with blank skill level',
      {
        onboardingState: 'complete',
        profile: {
          skill_level: '  ',
          handedness: 'left',
          primary_goal: 'x',
          biggest_problem: 'y',
        },
      },
    ],
    [
      'complete with unknown handedness',
      {
        onboardingState: 'complete',
        profile: {
          skill_level: '3.5',
          handedness: 'both',
          primary_goal: 'x',
          biggest_problem: 'y',
        },
      },
    ],
    ['JSON string body', 'complete'],
    ['JSON null body', null],
  ])(
    'treats %s as "no server profile" (null) rather than throwing — the Gate then shows in-account onboarding',
    async (_label, body) => {
      const { fetchFn } = recorder([json(body)]);
      await expect(
        fetchCanonicalOnboardingProfile(session, fetchFn),
      ).resolves.toBeNull();
    },
  );

  it('a 200 with a non-JSON body is also "no server profile" (null), not an error', async () => {
    const fetchFn: OnboardingFetch = async () =>
      new Response('<html>maintenance</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    await expect(
      fetchCanonicalOnboardingProfile(session, fetchFn),
    ).resolves.toBeNull();
  });

  it('a complete server profile ignores any server focus hint and derives focus from the goal', async () => {
    const { fetchFn } = recorder([
      json({
        onboardingState: 'complete',
        recommendedCheckpoint: 'sequencing',
        profile: {
          skill_level: '3.5',
          handedness: 'left',
          primary_goal: 'drives',
          biggest_problem: 'contact',
          focus_checkpoint: 'sequencing',
        },
      }),
    ]);
    const profile = await fetchCanonicalOnboardingProfile(session, fetchFn);
    expect(profile?.focusCheckpoint).toBe('preparation');
  });

  it.each([401, 403, 404, 429, 500, 503])(
    'HTTP %s rejects with OnboardingSyncError (appStore maps it to a retryable hydrateError)',
    async status => {
      const { fetchFn } = recorder([
        json({ error: { message: `status ${status}` } }, status),
      ]);
      await expect(
        fetchCanonicalOnboardingProfile(session, fetchFn),
      ).rejects.toThrow(`status ${status}`);
    },
  );

  it('an error body that is not JSON falls back to generic copy (no raw HTML leaks)', async () => {
    const fetchFn: OnboardingFetch = async () =>
      new Response('<html>502</html>', { status: 502 });
    await expect(
      fetchCanonicalOnboardingProfile(session, fetchFn),
    ).rejects.toThrow('Your coaching profile could not be securely saved.');
  });
});

describe('PUT response validation', () => {
  it.each([
    ['empty object', {}],
    ['unknown checkpoint', { recommendedCheckpoint: 'nope' }],
    ['numeric checkpoint', { recommendedCheckpoint: 3 }],
    ['array body', []],
    ['null body', null],
  ])('rejects a 2xx save whose body is %s', async (_label, body) => {
    const { fetchFn } = recorder([json(body)]);
    await expect(
      saveCanonicalOnboardingProfile(session, coreOnly, fetchFn),
    ).rejects.toThrow(OnboardingSyncError);
  });

  it('server recommendedCheckpoint wins over the locally derived focus', async () => {
    const { fetchFn } = recorder([
      json({ recommendedCheckpoint: 'sequencing' }),
    ]);
    const saved = await saveCanonicalOnboardingProfile(
      session,
      coreOnly,
      fetchFn,
    );
    expect(saved.focusCheckpoint).toBe('sequencing');
  });
});
