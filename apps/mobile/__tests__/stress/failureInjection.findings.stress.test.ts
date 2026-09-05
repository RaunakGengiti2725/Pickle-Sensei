/**
 * STRESS — minimized reproductions of the findings surfaced by the seeded
 * failure-injection campaign (`failureInjection.*.stress.test.ts`).
 *
 * Each block is the seed-free minimum payload that reproduces a finding. The
 * tests assert only the invariants that must hold either way (settles, no
 * fake success, typed error) and RECORD the defect classification, so the
 * suite stays green while the evidence row says BROKEN until the fix lands
 * (at which point the same row flips to HELD — the reproduction doubles as
 * the regression pin).
 *
 * F1 — `{error:{message:""}}` on a non-2xx passes the `typeof === 'string'`
 *      check in deletion.ts (`requestAccountDeletion` / `confirmAccountDeletion`)
 *      and onboarding.ts (`request`), so the empty string becomes the user-
 *      facing message. ManageAccountScreen and OnboardingScreen both render
 *      `error ? <Text>{error}</Text> : null`, so the user sees the sheet /
 *      footer return to its idle state with NO copy at all: a silent failure
 *      with a retry control but no explanation. Seeds: ui.manageAccount.confirm
 *      2473763343, appStore.completeOnboarding 1725365415.
 *      Reachability: every `errorJson` / `codedError` call site in
 *      supabase/functions/api/index.ts passes a literal (INFERRED) — this
 *      needs an intermediary (gateway/WAF) or a future server change.
 */
import {
  AccountDeletionError,
  confirmAccountDeletion,
  requestAccountDeletion,
} from '../../src/account/deletion';
import {
  OnboardingSyncError,
  saveCanonicalOnboardingProfile,
} from '../../src/account/onboarding';
import type { ApiSession } from '../../src/account/apiSession';
import { focusForGoal, type Profile } from '../../src/state/profile';
import { probe, recordIteration } from '../../testing/stress/harness';
import { fakeResponse } from '../../testing/stress/faultFetch';

const SUITE = 'findings';
const FINDING_EMPTY_SERVER_MESSAGE = 'F1-empty-server-message-renders-no-copy';

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test/functions/v1/api',
  bearerToken: 'access-token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
};

const coreOnlyProfile: Profile = {
  skillLevel: '3.0',
  handedness: 'right',
  goal: 'consistency',
  biggestProblem: 'control',
  focusCheckpoint: focusForGoal('consistency'),
};

const EMPTY_MESSAGE_STATUSES = [400, 409, 422, 429, 500, 501, 503] as const;

function emptyMessageFetch(status: number) {
  const calls: string[] = [];
  const fetchFn = (input: string): Promise<Response> => {
    calls.push(String(input));
    return Promise.resolve(
      fakeResponse(status, () => Promise.resolve({ error: { message: '' } })),
    );
  };
  return { fetchFn, calls };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('F1 — empty server error.message becomes empty user-facing copy', () => {
  describe.each(EMPTY_MESSAGE_STATUSES)('HTTP %d', status => {
    it('requestAccountDeletion surfaces the empty string verbatim', async () => {
      await recordIteration(
        {
          suite: SUITE,
          scenario: 'F1.deletion.request',
          seed: status,
          iteration: 0,
          fault: `http_error:${status}:json_error_message_empty`,
          inputs: { status, body: { error: { message: '' } } },
        },
        async () => {
          const transport = emptyMessageFetch(status);
          const run = probe(
            requestAccountDeletion(session, null, transport.fetchFn),
          );
          await jest.advanceTimersByTimeAsync(60_000);
          expect(run.settled).toBe(true);
          expect(run.resolved).toBe(false); // no fake challenge
          expect(run.error).toBeInstanceOf(AccountDeletionError);
          const error = run.error as AccountDeletionError;
          expect(error.code).toBe('deletion.rejected');
          expect(typeof error.message).toBe('string');
          const observed = {
            code: error.code,
            retryable: error.retryable,
            message: error.message,
            messageLength: error.message.length,
            timersLeft: jest.getTimerCount(),
          };
          expect(jest.getTimerCount()).toBe(0);
          if (error.message.length === 0) {
            return {
              observed,
              classification: 'BROKEN',
              finding: FINDING_EMPTY_SERVER_MESSAGE,
            };
          }
          return { observed };
        },
      );
    });

    it('confirmAccountDeletion surfaces the empty string verbatim', async () => {
      await recordIteration(
        {
          suite: SUITE,
          scenario: 'F1.deletion.confirm',
          seed: status,
          iteration: 0,
          fault: `http_error:${status}:json_error_message_empty`,
          inputs: { status, body: { error: { message: '' } } },
        },
        async () => {
          const transport = emptyMessageFetch(status);
          const run = probe(
            confirmAccountDeletion(session, 'challenge', transport.fetchFn),
          );
          await jest.advanceTimersByTimeAsync(60_000);
          expect(run.settled).toBe(true);
          expect(run.resolved).toBe(false); // no fake `deleted: true`
          expect(run.error).toBeInstanceOf(AccountDeletionError);
          const error = run.error as AccountDeletionError;
          expect(error.code).toBe('deletion.rejected');
          expect(error.retryable).toBe(status === 429 || status >= 500);
          const observed = {
            code: error.code,
            retryable: error.retryable,
            message: error.message,
            messageLength: error.message.length,
            timersLeft: jest.getTimerCount(),
          };
          expect(jest.getTimerCount()).toBe(0);
          if (error.message.length === 0) {
            return {
              observed,
              classification: 'BROKEN',
              finding: FINDING_EMPTY_SERVER_MESSAGE,
            };
          }
          return { observed };
        },
      );
    });

    it('saveCanonicalOnboardingProfile (core-only, no retry) surfaces the empty string verbatim', async () => {
      await recordIteration(
        {
          suite: SUITE,
          scenario: 'F1.onboarding.save',
          seed: status,
          iteration: 0,
          fault: `http_error:${status}:json_error_message_empty`,
          inputs: {
            status,
            body: { error: { message: '' } },
            profile: coreOnlyProfile,
          },
        },
        async () => {
          const transport = emptyMessageFetch(status);
          const run = probe(
            saveCanonicalOnboardingProfile(
              session,
              coreOnlyProfile,
              transport.fetchFn,
            ),
          );
          await jest.advanceTimersByTimeAsync(60_000);
          expect(run.settled).toBe(true);
          expect(run.resolved).toBe(false); // no fake save
          // Core-only profile: no identity retry, exactly one PUT.
          expect(transport.calls).toHaveLength(1);
          expect(run.error).toBeInstanceOf(OnboardingSyncError);
          const error = run.error as OnboardingSyncError;
          const observed = {
            message: error.message,
            messageLength: error.message.length,
            fetchCalls: transport.calls.length,
            timersLeft: jest.getTimerCount(),
          };
          expect(jest.getTimerCount()).toBe(0);
          if (error.message.length === 0) {
            return {
              observed,
              classification: 'BROKEN',
              finding: FINDING_EMPTY_SERVER_MESSAGE,
            };
          }
          return { observed };
        },
      );
    });
  });

  it('control: a non-empty server message and a missing message both yield visible copy', async () => {
    await recordIteration(
      {
        suite: SUITE,
        scenario: 'F1.control',
        seed: 0,
        iteration: 0,
        fault: 'http_error:400:json_error_message|json_error_no_message',
        inputs: {},
      },
      async () => {
        const withMessage = probe(
          requestAccountDeletion(session, null, () =>
            Promise.resolve(
              fakeResponse(400, () =>
                Promise.resolve({ error: { message: 'Rate limit exceeded' } }),
              ),
            ),
          ),
        );
        const noMessage = probe(
          requestAccountDeletion(session, null, () =>
            Promise.resolve(
              fakeResponse(400, () =>
                Promise.resolve({ error: { code: 'x' } }),
              ),
            ),
          ),
        );
        await jest.advanceTimersByTimeAsync(60_000);
        expect((withMessage.error as AccountDeletionError).message).toBe(
          'Rate limit exceeded',
        );
        expect((noMessage.error as AccountDeletionError).message).toBe(
          'The deletion request could not be completed. Nothing was deleted.',
        );
        return {
          observed: {
            withMessage: (withMessage.error as Error).message,
            noMessage: (noMessage.error as Error).message,
          },
        };
      },
    );
  });
});
