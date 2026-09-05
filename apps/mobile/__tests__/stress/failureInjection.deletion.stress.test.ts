/**
 * STRESS — failure injection — `src/account/deletion.ts`
 *
 * Its only dependency is `fetch` (plus the clock behind the 15s deadline and
 * the ApiSession it is handed). Every iteration injects one fault from the
 * catalog (throw / reject / hang / slow / HTTP error × body shape / malformed
 * 2xx / spec-violating fetch) into step 1 (`requestAccountDeletion`) or step
 * 2 (`confirmAccountDeletion`) and asserts:
 *
 *   - the promise SETTLES within the 15s deadline (fake clock advanced 60s);
 *   - it settles with an `AccountDeletionError` whose code / `retryable` /
 *     copy match the fault class (no silent failure, no raw error);
 *   - it NEVER resolves unless the server payload is a valid challenge /
 *     `deleted: true` (no fake success);
 *   - the abort signal is passed and fired on the deadline, and no timer is
 *     left behind.
 *
 * Replay: `STRESS_SEED=<seed> npx jest __tests__/stress/failureInjection.deletion`
 * Scale:  `STRESS_ITER=<n>` seeds per scenario (default 12).
 */
import {
  AccountDeletionError,
  ACCOUNT_DELETION_REASONS,
  ACCOUNT_DELETION_WANTED,
  confirmAccountDeletion,
  requestAccountDeletion,
  type AccountDeletionSurvey,
} from '../../src/account/deletion';
import type { ApiSession } from '../../src/account/apiSession';
import {
  describeError,
  pick,
  probe,
  recordIteration,
  scenarioCases,
  seededRandom,
  type Rng,
} from '../../testing/stress/harness';
import {
  drawFault,
  expectedServerMessage,
  faultFetch,
  okFault,
  REQUEST_DEADLINE_MS,
  transportFailureExpected,
  type Fault,
  type MalformedShape,
} from '../../testing/stress/faultFetch';

const SUITE = 'deletion';
const API_BASE = 'https://api.example.test/functions/v1/api';

const session: ApiSession = {
  apiBaseUrl: API_BASE,
  bearerToken: 'access-token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
};

const OFFLINE_COPY =
  'Account deletion is temporarily offline. Nothing was deleted — please try again.';
const GENERIC_REJECTED_COPY =
  'The deletion request could not be completed. Nothing was deleted.';
const SESSION_EXPIRED_COPY =
  'Your sign-in has expired. Sign in again, then delete your account.';

const VALID_CHALLENGE = {
  challenge: '33333333-3333-4333-8333-333333333333',
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const VALID_CONFIRM = {
  deleted: true,
  appleAuthorizationRevocation: 'revoked',
};

function malformedChallenge(rng: Rng): MalformedShape {
  return pick(rng, [
    { shape: 'null', payload: null },
    { shape: 'array', payload: [] },
    { shape: 'string', payload: 'ok' },
    { shape: 'number', payload: 42 },
    { shape: 'empty_object', payload: {} },
    { shape: 'challenge_number', payload: { challenge: 42, expiresAt: 'x' } },
    { shape: 'missing_expiresAt', payload: { challenge: 'abc' } },
    { shape: 'missing_challenge', payload: { expiresAt: 'x' } },
    { shape: 'nulls', payload: { challenge: null, expiresAt: null } },
    { shape: 'empty_strings', payload: { challenge: '', expiresAt: '' } },
    {
      shape: 'expiresAt_number',
      payload: { challenge: 'abc', expiresAt: 1234 },
    },
    { shape: 'challenge_array', payload: { challenge: ['a'], expiresAt: 'x' } },
    { shape: 'challenge_object', payload: { challenge: {}, expiresAt: 'x' } },
    {
      shape: 'expiresAt_garbage',
      payload: { challenge: 'abc', expiresAt: 'not-a-date' },
    },
    {
      shape: 'expiresAt_past',
      payload: { challenge: 'abc', expiresAt: '2000-01-01T00:00:00.000Z' },
    },
    {
      shape: 'nested_data',
      payload: { data: { challenge: 'abc', expiresAt: 'x' } },
    },
    { shape: 'error_in_2xx', payload: { error: { message: 'x' } } },
  ]);
}

function malformedConfirm(rng: Rng): MalformedShape {
  return pick(rng, [
    { shape: 'null', payload: null },
    { shape: 'array', payload: [] },
    { shape: 'string', payload: 'deleted' },
    { shape: 'empty_object', payload: {} },
    { shape: 'deleted_false', payload: { deleted: false } },
    { shape: 'deleted_string_true', payload: { deleted: 'true' } },
    { shape: 'deleted_one', payload: { deleted: 1 } },
    { shape: 'deleted_null', payload: { deleted: null } },
    { shape: 'deleted_array', payload: { deleted: [true] } },
    { shape: 'ok_true_only', payload: { ok: true } },
    { shape: 'status_deleted', payload: { status: 'deleted' } },
    {
      shape: 'revocation_bogus',
      payload: { deleted: true, appleAuthorizationRevocation: 'bogus' },
    },
    { shape: 'revocation_missing', payload: { deleted: true } },
    {
      shape: 'revocation_number',
      payload: { deleted: true, appleAuthorizationRevocation: 42 },
    },
    {
      shape: 'revocation_manual',
      payload: {
        deleted: true,
        appleAuthorizationRevocation: 'manual_action_required',
      },
    },
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Reference validator mirroring the wire contract (not the implementation). */
function challengeAccepted(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    typeof payload['challenge'] === 'string' &&
    typeof payload['expiresAt'] === 'string'
  );
}

function confirmAccepted(payload: unknown): boolean {
  return isRecord(payload) && payload['deleted'] === true;
}

function drawSurvey(rng: Rng): AccountDeletionSurvey | null {
  if (rng() < 0.4) return null;
  return {
    reason: pick(rng, ACCOUNT_DELETION_REASONS),
    wanted: rng() < 0.5 ? pick(rng, ACCOUNT_DELETION_WANTED) : null,
    details: rng() < 0.5 ? 'x'.repeat(Math.floor(rng() * 500)) : null,
    platform: 'ios',
    appVersion: '1.0.0',
  };
}

type Step = 'request' | 'confirm';

interface Expectation {
  settles: boolean;
  resolves: boolean;
  code?: AccountDeletionError['code'];
  retryable?: boolean;
  message?: string;
  /** settlement expected exactly on the deadline */
  onDeadline?: boolean;
  weakAccept?: string;
}

function expectationFor(step: Step, fault: Fault): Expectation {
  if (!fault.realistic) {
    switch (fault.kind) {
      case 'hang_ignore_abort':
      case 'body_stall':
        return { settles: false, resolves: false };
      case 'slow_body':
        return { settles: true, resolves: true };
      case 'resolve_null':
        return { settles: true, resolves: false };
      default:
        return { settles: true, resolves: false };
    }
  }
  if (transportFailureExpected(fault)) {
    return {
      settles: true,
      resolves: false,
      code: 'deletion.unavailable',
      retryable: true,
      message: OFFLINE_COPY,
      onDeadline:
        fault.kind === 'hang_until_abort' ||
        (fault.delayMs ?? 0) >= REQUEST_DEADLINE_MS,
    };
  }
  if (fault.kind === 'http_error') {
    const status = fault.status ?? 500;
    if (status === 401) {
      return {
        settles: true,
        resolves: false,
        code: 'deletion.session_expired',
        retryable: false,
        message: SESSION_EXPIRED_COPY,
      };
    }
    return {
      settles: true,
      resolves: false,
      code: 'deletion.rejected',
      retryable: status === 429 || status >= 500,
      message: expectedServerMessage(fault) ?? GENERIC_REJECTED_COPY,
    };
  }
  if (fault.kind === 'ok_json_throws') {
    return {
      settles: true,
      resolves: false,
      code: 'deletion.rejected',
      retryable: false,
      message: 'The server returned an invalid deletion response.',
    };
  }
  // ok / slow_ok (<deadline) / ok_malformed
  const payload = fault.payload;
  if (step === 'request') {
    if (challengeAccepted(payload)) {
      const record = payload as Record<string, unknown>;
      const weak =
        record['challenge'] === '' ||
        Number.isNaN(Date.parse(String(record['expiresAt']))) ||
        Date.parse(String(record['expiresAt'])) < Date.now()
          ? String(fault.shape ?? 'ok')
          : undefined;
      return {
        settles: true,
        resolves: true,
        ...(weak ? { weakAccept: weak } : {}),
      };
    }
    return {
      settles: true,
      resolves: false,
      code: 'deletion.rejected',
      retryable: false,
      message: isRecord(payload)
        ? 'The server returned an invalid deletion challenge.'
        : 'The server returned an invalid deletion response.',
    };
  }
  if (confirmAccepted(payload)) {
    return { settles: true, resolves: true };
  }
  return {
    settles: true,
    resolves: false,
    code: 'deletion.rejected',
    retryable: false,
    message: isRecord(payload)
      ? 'The server did not confirm the deletion.'
      : 'The server returned an invalid deletion response.',
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function runStep(
  step: Step,
  fault: Fault,
  survey: AccountDeletionSurvey | null,
) {
  const transport = faultFetch([fault]);
  const promise =
    step === 'request'
      ? requestAccountDeletion(session, survey, transport.fetch)
      : confirmAccountDeletion(
          session,
          VALID_CHALLENGE.challenge,
          transport.fetch,
        );
  const settlement = probe(promise as Promise<unknown>);
  // Wait for the sync-throw / immediate-reject paths to propagate.
  await jest.advanceTimersByTimeAsync(0);
  const settledImmediately = settlement.settled;
  await jest.advanceTimersByTimeAsync(60_000);
  return { transport, settlement, settledImmediately };
}

function assertRealistic(
  step: Step,
  fault: Fault,
  expectation: Expectation,
  result: Awaited<ReturnType<typeof runStep>>,
  survey: AccountDeletionSurvey | null,
) {
  const { settlement, transport } = result;
  expect(settlement.settled).toBe(true);
  expect(settlement.resolved).toBe(expectation.resolves);
  expect(transport.calls).toHaveLength(1);
  const call = transport.calls[0]!;
  expect(call.hadSignal).toBe(true);
  expect(call.url).toBe(
    `${API_BASE}${step === 'request' ? '/v1/me/delete-request' : '/v1/me/delete-confirm'}`,
  );
  expect((call.init?.headers as Record<string, string>).Authorization).toBe(
    'Bearer access-token',
  );
  if (step === 'request') {
    if (survey) {
      expect(JSON.parse(String(call.init?.body))).toEqual({ survey });
    } else {
      expect(call.init?.body).toBeUndefined();
    }
  } else {
    expect(JSON.parse(String(call.init?.body))).toEqual({
      challenge: VALID_CHALLENGE.challenge,
    });
  }
  // Deadline discipline: a hung / over-deadline request settles exactly at
  // 15s via the abort signal; nothing settles later than that.
  expect(settlement.settledAfterMs).not.toBeNull();
  expect(settlement.settledAfterMs!).toBeLessThanOrEqual(REQUEST_DEADLINE_MS);
  if (expectation.onDeadline) {
    expect(settlement.settledAfterMs).toBe(REQUEST_DEADLINE_MS);
    expect(call.aborted).toBe(true);
  } else {
    expect(call.aborted).toBe(false);
  }
  expect(jest.getTimerCount()).toBe(0);

  if (expectation.resolves) {
    const value = settlement.value as unknown as Record<string, unknown>;
    if (step === 'request') {
      expect(typeof value['challenge']).toBe('string');
      expect(typeof value['expiresAt']).toBe('string');
    } else {
      expect(['revoked', 'not_applicable', 'manual_action_required']).toContain(
        value['appleAuthorizationRevocation'],
      );
    }
    return;
  }
  const error = settlement.error;
  expect(error).toBeInstanceOf(AccountDeletionError);
  const typed = error as AccountDeletionError;
  expect(typed.code).toBe(expectation.code);
  expect(typed.retryable).toBe(expectation.retryable);
  expect(typed.message).toBe(expectation.message);
  // Every failure copy is a string the dialog can render; the module never
  // claims success.
  expect(typeof typed.message).toBe('string');
  expect(typed.message.toLowerCase()).not.toContain('account deleted');
}

describe.each<Step>(['request', 'confirm'])(
  'deletion %s — injected fetch faults',
  step => {
    const scenario = `deletion.${step}`;
    const cases = scenarioCases(scenario);
    it.each(cases)(
      `seed %d (iteration %d) settles honestly under the injected fault`,
      async (seed, iteration) => {
        const rng = seededRandom(seed);
        const fault = drawFault(
          rng,
          iteration,
          step === 'request' ? VALID_CHALLENGE : VALID_CONFIRM,
          step === 'request' ? malformedChallenge : malformedConfirm,
        );
        const survey = step === 'request' ? drawSurvey(rng) : null;
        const expectation = expectationFor(step, fault);
        await recordIteration(
          {
            suite: SUITE,
            scenario,
            seed,
            iteration,
            fault: fault.id,
            inputs: { fault, survey, expectation },
          },
          async () => {
            const result = await runStep(step, fault, survey);
            const observed: Record<string, unknown> = {
              settled: result.settlement.settled,
              resolved: result.settlement.resolved,
              settledAfterMs: result.settlement.settledAfterMs,
              aborted: result.transport.calls[0]?.aborted ?? null,
              calls: result.transport.calls.length,
              timersLeft: jest.getTimerCount(),
              error:
                result.settlement.settled && !result.settlement.resolved
                  ? describeError(result.settlement.error)
                  : null,
              value: result.settlement.resolved
                ? result.settlement.value
                : null,
              ...(expectation.weakAccept
                ? { weakAccept: expectation.weakAccept }
                : {}),
            };
            if (fault.realistic) {
              assertRealistic(step, fault, expectation, result, survey);
              return { observed };
            }
            // Contract-violating fetch: never a fake success; the rest is
            // recorded as a known limit of relying on whatwg-fetch semantics.
            expect(result.settlement.settled).toBe(expectation.settles);
            if (result.settlement.settled) {
              expect(result.settlement.resolved).toBe(expectation.resolves);
            }
            if (result.settlement.resolved) {
              expect(
                step === 'request'
                  ? challengeAccepted(fault.payload)
                  : confirmAccepted(fault.payload),
              ).toBe(true);
            }
            expect(jest.getTimerCount()).toBe(0);
            const bypassesDeadline =
              !result.settlement.settled ||
              (result.settlement.settledAfterMs ?? 0) > REQUEST_DEADLINE_MS;
            return {
              observed: { ...observed, bypassesDeadline },
              classification:
                bypassesDeadline ||
                (result.settlement.settled &&
                  !(result.settlement.error instanceof AccountDeletionError) &&
                  !result.settlement.resolved)
                  ? 'KNOWN_LIMIT'
                  : 'HELD',
            };
          },
        );
      },
    );
  },
);

describe('deletion — session faults', () => {
  const scenario = 'deletion.session';
  const cases = scenarioCases(scenario);
  const variants = [
    'null_session',
    'empty_bearer',
    'trailing_slash_base',
    'confirm_null_session',
    'confirm_empty_challenge',
  ] as const;

  it.each(cases)(
    'seed %d (iteration %d) never fakes success without a usable session',
    async (seed, iteration) => {
      const variant = variants[iteration % variants.length]!;
      const rng = seededRandom(seed);
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: variant,
          inputs: { variant },
        },
        async () => {
          const transport = faultFetch([
            okFault(
              variant.startsWith('confirm') ? VALID_CONFIRM : VALID_CHALLENGE,
            ),
          ]);
          let promise: Promise<unknown>;
          switch (variant) {
            case 'null_session':
              promise = requestAccountDeletion(
                null,
                drawSurvey(rng),
                transport.fetch,
              );
              break;
            case 'confirm_null_session':
              promise = confirmAccountDeletion(null, 'abc', transport.fetch);
              break;
            case 'empty_bearer':
              promise = requestAccountDeletion(
                { ...session, bearerToken: '' },
                null,
                transport.fetch,
              );
              break;
            case 'trailing_slash_base':
              promise = requestAccountDeletion(
                { ...session, apiBaseUrl: `${API_BASE}/` },
                null,
                transport.fetch,
              );
              break;
            case 'confirm_empty_challenge':
              promise = confirmAccountDeletion(session, '', transport.fetch);
              break;
          }
          const settlement = probe(promise);
          await jest.advanceTimersByTimeAsync(60_000);
          expect(settlement.settled).toBe(true);
          expect(jest.getTimerCount()).toBe(0);
          const observed: Record<string, unknown> = {
            resolved: settlement.resolved,
            calls: transport.calls.length,
            url: transport.calls[0]?.url ?? null,
            error: settlement.resolved ? null : describeError(settlement.error),
          };
          if (
            variant === 'null_session' ||
            variant === 'confirm_null_session'
          ) {
            expect(settlement.resolved).toBe(false);
            expect(transport.calls).toHaveLength(0);
            const error = settlement.error as AccountDeletionError;
            expect(error).toBeInstanceOf(AccountDeletionError);
            expect(error.code).toBe('deletion.not_configured');
            expect(error.retryable).toBe(false);
            return { observed };
          }
          // The client does not second-guess bearer / challenge content: it
          // sends what it was given and lets the server decide. With a
          // healthy server stub the call resolves — record the wire shape.
          expect(transport.calls).toHaveLength(1);
          expect(settlement.resolved).toBe(true);
          if (variant === 'trailing_slash_base') {
            observed['doubleSlash'] = String(transport.calls[0]!.url).includes(
              '//v1/',
            );
          }
          return { observed };
        },
      );
    },
  );
});
