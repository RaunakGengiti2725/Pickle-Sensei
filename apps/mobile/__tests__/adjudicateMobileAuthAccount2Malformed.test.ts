/**
 * Adjudication replay (stress area mobile-auth-account-2, baseline 1fb0efd7).
 *
 * P3-level hardening candidates replayed for the record. Each needs a
 * non-conforming first-party server, a modified client, or corrupted device
 * storage to reach; none is reachable from the shipped UI with the shipped
 * edge function. They are recorded as deferred, not confirmed.
 *
 *  - deletion: `{error:{message:''}}` is accepted as the typed message.
 *  - onboarding: `primary_goal` = '__proto__' / 'isPrototypeOf' from the
 *    server hydrates a non-string focusCheckpoint (plain-object lookup).
 *  - onboarding: a non-string `firstName` throws a raw TypeError (no request).
 *  - bootstrap: normalizeApiBaseUrl keeps a query string / fragment that is
 *    later string-appended with `/v1/account/bootstrap`.
 */
import type { ApiSession } from '../src/account/apiSession';
import { normalizeApiBaseUrl } from '../src/account/bootstrap';
import {
  AccountDeletionError,
  requestAccountDeletion,
} from '../src/account/deletion';
import {
  fetchCanonicalOnboardingProfile,
  saveCanonicalOnboardingProfile,
} from '../src/account/onboarding';
import { focusForGoal, type Profile } from '../src/state/profile';

const session: ApiSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'a0000000-0000-0000-0000-000000000001',
  provider: 'apple',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('adjudication: deletion error payloads', () => {
  it.each(['', '   '])(
    'a rejected deletion with error.message=%p yields a non-blank user message',
    async message => {
      let caught: unknown = null;
      try {
        await requestAccountDeletion(session, null, async () =>
          jsonResponse({ error: { message } }, 400),
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AccountDeletionError);
      const text = (caught as AccountDeletionError).message;
      console.log(
        `[adjudicate] deletion message for ${JSON.stringify(message)} = ${JSON.stringify(text)}`,
      );
      expect(text.trim().length).toBeGreaterThan(0);
    },
  );
});

describe('adjudication: onboarding goal lookup', () => {
  it.each(['__proto__', 'isPrototypeOf', 'constructor', 'toString'])(
    'focusForGoal(%p) is a string checkpoint',
    goal => {
      const focus: unknown = focusForGoal(goal);
      console.log(
        `[adjudicate] focusForGoal(${goal}) typeof = ${typeof focus}`,
      );
      expect(typeof focus).toBe('string');
    },
  );

  it.each(['__proto__', 'isPrototypeOf'])(
    'a server profile with primary_goal=%p hydrates a string focusCheckpoint',
    async goal => {
      const profile = await fetchCanonicalOnboardingProfile(session, async () =>
        jsonResponse({
          onboardingState: 'complete',
          profile: {
            skill_level: 'beginner',
            handedness: 'right',
            primary_goal: goal,
            biggest_problem: 'consistency',
            focus_checkpoint: 'contact_position',
          },
        }),
      );
      expect(profile).not.toBeNull();
      console.log(
        `[adjudicate] hydrated focusCheckpoint for primary_goal=${goal}: typeof = ${typeof profile?.focusCheckpoint}`,
      );
      expect(typeof profile?.focusCheckpoint).toBe('string');
    },
  );
});

describe('adjudication: onboarding save input', () => {
  it('a non-string firstName is rejected as a typed error, never a raw TypeError', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse({ recommendedCheckpoint: 'contact_position' }),
    );
    const malformed = {
      firstName: 42,
      skillLevel: 'beginner',
      handedness: 'right',
      goal: 'dinks',
      biggestProblem: 'consistency',
      focusCheckpoint: 'contact_position',
    } as unknown as Profile;
    let caught: unknown = null;
    try {
      await saveCanonicalOnboardingProfile(session, malformed, fetchFn);
    } catch (e) {
      caught = e;
    }
    console.log(
      `[adjudicate] firstName=42 → ${caught instanceof Error ? caught.name : String(caught)}: ${
        caught instanceof Error ? caught.message : ''
      }; requests=${fetchFn.mock.calls.length}`,
    );
    expect(caught).not.toBeInstanceOf(TypeError);
  });
});

describe('adjudication: api base url normalization', () => {
  it.each(['https://api.test/base?x=1', 'https://api.test/base#frag'])(
    'normalizeApiBaseUrl(%p) does not keep a query string or fragment',
    value => {
      let out: string | null = null;
      let caught: unknown = null;
      try {
        out = normalizeApiBaseUrl(value);
      } catch (e) {
        caught = e;
      }
      console.log(
        `[adjudicate] normalizeApiBaseUrl(${value}) → ${out ?? String(caught)}; bootstrap url → ${out}/v1/account/bootstrap`,
      );
      expect(out === null || !/[?#]/.test(out)).toBe(true);
    },
  );
});
