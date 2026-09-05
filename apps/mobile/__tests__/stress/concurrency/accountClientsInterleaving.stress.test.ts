/**
 * Seeded concurrency campaign over the stateless account clients:
 * src/account/deletion.ts, consentApi.ts, onboarding.ts.
 *
 * Each iteration fires a Promise.all burst of 2–14 calls (duplicates,
 * call-during-call, two actors, a rotated bearer mid-burst) whose replies
 * land in a seeded order with seeded outcomes (2xx, every error status, a
 * non-JSON 2xx body, a network throw, a hang until the client deadline, a
 * late reply that ignores abort). Invariants checked per call:
 *
 *  - attribution: every request carries exactly the bearer/body of the call
 *    that made it (no cross-talk between concurrent calls);
 *  - idempotency/isolation: the outcome of a call is a pure function of ITS
 *    reply plan, whatever else is in flight;
 *  - bounded time: a hung request is aborted at exactly the 15 s deadline and
 *    the call settles by then; nothing waits on another call;
 *  - no leaked timers once the burst settled;
 *  - onboarding's identity-field retry issues exactly one extra request with
 *    the core body, and only after a transport/HTTP failure.
 *
 * Scale: STRESS_ITER (default 40); replay: STRESS_SEED=<seed>.
 */
import { CHECKPOINTS } from '@pickle/shared-types';
import type { ApiSession } from '../../../src/account/apiSession';
import {
  AccountDeletionError,
  confirmAccountDeletion,
  requestAccountDeletion,
  type AccountDeletionSurvey,
} from '../../../src/account/deletion';
import {
  ConsentApiError,
  EVALUATION_TELEMETRY_CONSENT_VERSION,
  MODEL_TRAINING_CONSENT_VERSION,
  fetchConsentStatus,
  grantEvaluationTelemetryConsent,
  grantModelTrainingConsent,
  withdrawEvaluationTelemetryConsent,
  withdrawModelTrainingConsent,
} from '../../../src/account/consentApi';
import {
  OnboardingSyncError,
  fetchCanonicalOnboardingProfile,
  saveCanonicalOnboardingProfile,
} from '../../../src/account/onboarding';
import { getRuntimePublicConfig } from '../../../src/config/runtimeConfig';
import type { Profile } from '../../../src/state/profile';
import {
  CLIENT_DEADLINE_MS,
  ScheduledTransport,
  campaignSeeds,
  chance,
  drain,
  errorMessage,
  pick,
  planReply,
  randomInt,
  runIteration,
  track,
  type IssuedRequest,
  type ReplyPlan,
  type Rng,
  type Settled,
} from '../../../testing/stress/concurrency';

const SUITE = 'accountClientsInterleaving';
const API = 'https://api.example.test/functions/v1/api';

const ACTORS = {
  A: '11111111-1111-4111-8111-111111111111',
  B: '22222222-2222-4222-8222-222222222222',
} as const;
type Actor = keyof typeof ACTORS;

function sessionFor(actor: Actor, bearerVersion: number): ApiSession {
  return {
    apiBaseUrl: API,
    bearerToken: `bearer-${actor}-v${bearerVersion}`,
    canonicalAppUserId: ACTORS[actor],
    provider: actor === 'A' ? 'apple' : 'google',
    refreshToken: `refresh-${actor}`,
    bearerExpiresAtMs: Date.now() + 3_600_000,
  };
}

type CallKind =
  | 'delete_request'
  | 'delete_confirm'
  | 'consent_status'
  | 'consent_grant_mt'
  | 'consent_withdraw_mt'
  | 'consent_grant_et'
  | 'consent_withdraw_et'
  | 'onboarding_fetch'
  | 'onboarding_save';

const CALL_KINDS: readonly CallKind[] = [
  'delete_request',
  'delete_confirm',
  'consent_status',
  'consent_grant_mt',
  'consent_withdraw_mt',
  'consent_grant_et',
  'consent_withdraw_et',
  'onboarding_fetch',
  'onboarding_save',
];

interface CallPlan {
  id: string;
  kind: CallKind;
  actor: Actor;
  bearerVersion: number;
  /** delete_request: survey attached? onboarding_save: identity fields? */
  withExtras: boolean;
  /** Reply plan per request the call may issue (index 0 = first). */
  replies: ReplyPlan[];
}

const REVOCATIONS = [
  'revoked',
  'not_applicable',
  'manual_action_required',
  undefined,
  'garbage',
] as const;

function okBodyFor(rng: Rng, plan: Omit<CallPlan, 'replies'>): unknown {
  switch (plan.kind) {
    case 'delete_request':
      return chance(rng, 0.85)
        ? {
            challenge: `challenge-${plan.id}`,
            expiresAt: '2026-09-05T03:00:00.000Z',
          }
        : { challenge: `challenge-${plan.id}` };
    case 'delete_confirm':
      return chance(rng, 0.85)
        ? {
            deleted: true,
            appleAuthorizationRevocation: pick(rng, REVOCATIONS),
          }
        : { deleted: false };
    case 'consent_status':
    case 'consent_grant_mt':
    case 'consent_withdraw_mt':
    case 'consent_grant_et':
    case 'consent_withdraw_et':
      return chance(rng, 0.85)
        ? {
            subjectPseudonym: chance(rng, 0.5) ? `pseud-${plan.id}` : null,
            scopes: [
              {
                scope: 'model_training',
                active: plan.kind === 'consent_grant_mt',
                consentVersion: null,
                lastAction: null,
                lastActionAt: null,
              },
              {
                scope: 'evaluation_telemetry',
                active: plan.kind === 'consent_grant_et',
                consentVersion: null,
                lastAction: 'withdrawn',
                lastActionAt: '2026-09-01T00:00:00.000Z',
              },
            ],
          }
        : {
            subjectPseudonym: null,
            scopes: [{ scope: 'bogus', active: true }],
          };
    case 'onboarding_fetch':
      return chance(rng, 0.7)
        ? {
            onboardingState: 'complete',
            profile: {
              skill_level: 'intermediate',
              handedness: 'right',
              primary_goal: 'dinks',
              biggest_problem: `problem-${plan.id}`,
              first_name: chance(rng, 0.5) ? `  Sam-${plan.id} ` : null,
              gender: chance(rng, 0.5) ? 'nonbinary' : undefined,
            },
          }
        : { onboardingState: 'pending', profile: null };
    case 'onboarding_save':
      return chance(rng, 0.85)
        ? { recommendedCheckpoint: pick(rng, CHECKPOINTS) }
        : { recommendedCheckpoint: 'not_a_checkpoint' };
  }
}

function surveyFor(id: string): AccountDeletionSurvey {
  return {
    reason: 'too_expensive',
    wanted: 'price',
    details: `details for ${id}`,
    platform: 'ios',
    appVersion: '1.0',
  };
}

function profileFor(id: string, identity: boolean): Profile {
  return {
    ...(identity ? { firstName: `  Sam-${id}  `, gender: 'female' } : {}),
    skillLevel: 'intermediate',
    handedness: 'right',
    goal: 'dinks',
    biggestProblem: `problem-${id}`,
    focusCheckpoint: 'contact_position',
  };
}

function issue(
  plan: CallPlan,
  transport: ScheduledTransport,
): Promise<Settled<unknown>> {
  const session = sessionFor(plan.actor, plan.bearerVersion);
  const fetchFn = transport.fetchFor(plan.id, req => {
    const reply = plan.replies[req.attempt];
    if (!reply) throw new Error('no reply plan');
    return reply;
  });
  switch (plan.kind) {
    case 'delete_request':
      return track(
        requestAccountDeletion(
          session,
          plan.withExtras ? surveyFor(plan.id) : null,
          fetchFn,
        ),
      );
    case 'delete_confirm':
      return track(
        confirmAccountDeletion(session, `challenge-${plan.id}`, fetchFn),
      );
    case 'consent_status':
      return track(fetchConsentStatus(session, fetchFn));
    case 'consent_grant_mt':
      return track(
        grantModelTrainingConsent(session, `device-${plan.id}`, fetchFn),
      );
    case 'consent_withdraw_mt':
      return track(
        withdrawModelTrainingConsent(session, `device-${plan.id}`, fetchFn),
      );
    case 'consent_grant_et':
      return track(
        grantEvaluationTelemetryConsent(session, `device-${plan.id}`, fetchFn),
      );
    case 'consent_withdraw_et':
      return track(
        withdrawEvaluationTelemetryConsent(
          session,
          `device-${plan.id}`,
          fetchFn,
        ),
      );
    case 'onboarding_fetch':
      return track(fetchCanonicalOnboardingProfile(session, fetchFn));
    case 'onboarding_save':
      return track(
        saveCanonicalOnboardingProfile(
          session,
          profileFor(plan.id, plan.withExtras),
          fetchFn,
        ),
      );
  }
}

/* ---------------------------- expectations ----------------------------- */

const PATHS: Record<CallKind, { method: string; path: string }> = {
  delete_request: { method: 'POST', path: '/v1/me/delete-request' },
  delete_confirm: { method: 'POST', path: '/v1/me/delete-confirm' },
  consent_status: { method: 'GET', path: '/v1/me/consent/status' },
  consent_grant_mt: { method: 'POST', path: '/v1/me/consent/grant' },
  consent_withdraw_mt: { method: 'POST', path: '/v1/me/consent/withdraw' },
  consent_grant_et: { method: 'POST', path: '/v1/me/consent/grant' },
  consent_withdraw_et: { method: 'POST', path: '/v1/me/consent/withdraw' },
  onboarding_fetch: { method: 'GET', path: '/v1/me' },
  onboarding_save: { method: 'PUT', path: '/v1/me/onboarding' },
};

function expectedBody(plan: CallPlan, attempt: number): unknown {
  switch (plan.kind) {
    case 'delete_request':
      return plan.withExtras ? { survey: surveyFor(plan.id) } : undefined;
    case 'delete_confirm':
      return { challenge: `challenge-${plan.id}` };
    case 'consent_status':
    case 'onboarding_fetch':
      return undefined;
    case 'consent_grant_mt':
      return {
        scope: 'model_training',
        consentVersion: MODEL_TRAINING_CONSENT_VERSION,
        source: 'mobile_settings',
        device: `device-${plan.id}`,
        captureMode: 'all_captures',
      };
    case 'consent_withdraw_mt':
      return {
        scope: 'model_training',
        source: 'mobile_settings',
        device: `device-${plan.id}`,
      };
    case 'consent_grant_et':
      return {
        scope: 'evaluation_telemetry',
        consentVersion: EVALUATION_TELEMETRY_CONSENT_VERSION,
        source: 'mobile_settings',
        device: `device-${plan.id}`,
        captureMode: 'all_captures',
      };
    case 'consent_withdraw_et':
      return {
        scope: 'evaluation_telemetry',
        source: 'mobile_settings',
        device: `device-${plan.id}`,
      };
    case 'onboarding_save': {
      const core = {
        skillLevel: 'intermediate',
        handedness: 'right',
        goal: 'dinks',
        biggestProblem: `problem-${plan.id}`,
      };
      return attempt === 0 && plan.withExtras
        ? { ...core, firstName: `Sam-${plan.id}`, gender: 'female' }
        : core;
    }
  }
}

/** Does this reply make `request()`/`post()` throw before the body check? */
function transportFails(reply: ReplyPlan): boolean {
  return (
    reply.kind === 'http_error' ||
    reply.kind === 'throw' ||
    reply.kind === 'hang'
  );
}

function expectedAttempts(plan: CallPlan): number {
  if (plan.kind !== 'onboarding_save' || !plan.withExtras) return 1;
  const first = plan.replies[0];
  return first && transportFails(first) ? 2 : 1;
}

function checkDeletionOutcome(
  plan: CallPlan,
  reply: ReplyPlan,
  settled: Settled<unknown>,
): void {
  const rejected = (code: string, retryable: boolean, message?: string) => {
    expect(settled.status).toBe('rejected');
    if (settled.status !== 'rejected') return;
    expect(settled.reason).toBeInstanceOf(AccountDeletionError);
    expect(settled.reason).toMatchObject({ code, retryable });
    if (message !== undefined)
      expect(settled.reason).toMatchObject({ message });
  };
  switch (reply.kind) {
    case 'throw':
    case 'hang':
      rejected(
        'deletion.unavailable',
        true,
        'Account deletion is temporarily offline. Nothing was deleted — please try again.',
      );
      return;
    case 'http_error':
      if (reply.status === 401) {
        rejected('deletion.session_expired', false);
      } else {
        rejected(
          'deletion.rejected',
          reply.status === 429 || reply.status >= 500,
          `server said ${reply.status}`,
        );
      }
      return;
    case 'ok_non_json':
      rejected(
        'deletion.rejected',
        false,
        'The server returned an invalid deletion response.',
      );
      return;
    case 'ok':
    case 'late_ignores_abort': {
      const body = reply.body as Record<string, unknown>;
      if (plan.kind === 'delete_request') {
        if (typeof body['expiresAt'] !== 'string') {
          rejected(
            'deletion.rejected',
            false,
            'The server returned an invalid deletion challenge.',
          );
          return;
        }
        expect(settled).toMatchObject({
          status: 'fulfilled',
          value: {
            challenge: `challenge-${plan.id}`,
            expiresAt: body['expiresAt'],
          },
        });
        return;
      }
      if (body['deleted'] !== true) {
        rejected(
          'deletion.rejected',
          false,
          'The server did not confirm the deletion.',
        );
        return;
      }
      const revocation = body['appleAuthorizationRevocation'];
      expect(settled).toMatchObject({
        status: 'fulfilled',
        value: {
          appleAuthorizationRevocation:
            revocation === 'revoked' || revocation === 'manual_action_required'
              ? revocation
              : 'not_applicable',
        },
      });
    }
  }
}

function checkConsentOutcome(
  reply: ReplyPlan,
  settled: Settled<unknown>,
): void {
  const rejected = (message: string) => {
    expect(settled.status).toBe('rejected');
    if (settled.status !== 'rejected') return;
    expect(settled.reason).toBeInstanceOf(ConsentApiError);
    expect(errorMessage(settled.reason)).toBe(message);
  };
  switch (reply.kind) {
    case 'throw':
    case 'hang':
    case 'http_error':
      rejected('Consent settings are temporarily unavailable.');
      return;
    case 'ok_non_json':
      rejected('The consent server returned an invalid response.');
      return;
    case 'ok':
    case 'late_ignores_abort': {
      const body = reply.body as {
        subjectPseudonym: string | null;
        scopes: unknown[];
      };
      const scopes = body.scopes as Array<Record<string, unknown>>;
      if (scopes[0]?.['scope'] === 'bogus') {
        rejected('The consent server returned an invalid response.');
        return;
      }
      expect(settled).toEqual({
        status: 'fulfilled',
        value: { subjectPseudonym: body.subjectPseudonym, scopes: body.scopes },
        settledAtMs: expect.any(Number),
      });
    }
  }
}

function checkOnboardingFetchOutcome(
  reply: ReplyPlan,
  settled: Settled<unknown>,
): void {
  const rejected = (message: string) => {
    expect(settled.status).toBe('rejected');
    if (settled.status !== 'rejected') return;
    expect(settled.reason).toBeInstanceOf(OnboardingSyncError);
    expect(errorMessage(settled.reason)).toBe(message);
  };
  switch (reply.kind) {
    case 'throw':
    case 'hang':
      rejected(
        'Your coaching profile could not be securely saved. Check your connection and try again.',
      );
      return;
    case 'http_error':
      rejected(`server said ${reply.status}`);
      return;
    case 'ok_non_json':
      // Bounded and non-crashing is asserted here; WHAT it resolves to is
      // measured (`nonJsonProfileReadAsNone`) and pinned inverted in
      // knownRaces.stress.test.ts (the client reads a 2xx with an
      // unparseable body as "no canonical profile").
      expect(settled.status).toBe('fulfilled');
      return;
    case 'ok':
    case 'late_ignores_abort': {
      const body = reply.body as {
        onboardingState: string;
        profile: Record<string, unknown> | null;
      };
      if (body.onboardingState !== 'complete' || !body.profile) {
        expect(settled).toMatchObject({ status: 'fulfilled', value: null });
        return;
      }
      const firstName = body.profile['first_name'];
      expect(settled).toEqual({
        status: 'fulfilled',
        settledAtMs: expect.any(Number),
        value: {
          ...(typeof firstName === 'string'
            ? { firstName: firstName.trim() }
            : {}),
          ...(body.profile['gender'] === 'nonbinary'
            ? { gender: 'nonbinary' }
            : {}),
          skillLevel: 'intermediate',
          handedness: 'right',
          goal: 'dinks',
          biggestProblem: body.profile['biggest_problem'],
          focusCheckpoint: 'contact_position',
        },
      });
    }
  }
}

function onboardingSaveError(reply: ReplyPlan): string | null {
  switch (reply.kind) {
    case 'throw':
    case 'hang':
      return 'Your coaching profile could not be securely saved. Check your connection and try again.';
    case 'http_error':
      return `server said ${reply.status}`;
    case 'ok_non_json':
      return 'The account server returned an invalid coaching profile.';
    case 'ok':
    case 'late_ignores_abort': {
      const body = reply.body as { recommendedCheckpoint: string };
      return body.recommendedCheckpoint === 'not_a_checkpoint'
        ? 'The account server returned an invalid training focus.'
        : null;
    }
  }
}

function checkOnboardingSaveOutcome(
  plan: CallPlan,
  settled: Settled<unknown>,
  attempts: IssuedRequest[],
): void {
  const first = plan.replies[0];
  if (!first) throw new Error('missing reply plan');
  const retried = expectedAttempts(plan) === 2;
  const decisive = retried ? plan.replies[1] : first;
  if (!decisive) throw new Error('missing retry reply plan');
  let error = onboardingSaveError(decisive);
  // A failed retry surfaces the FIRST attempt's error (onboarding.ts:166-168).
  if (retried && transportFails(decisive)) error = onboardingSaveError(first);
  if (error !== null) {
    expect(settled.status).toBe('rejected');
    if (settled.status !== 'rejected') return;
    expect(settled.reason).toBeInstanceOf(OnboardingSyncError);
    expect(errorMessage(settled.reason)).toBe(error);
    return;
  }
  const body = decisive.body as { recommendedCheckpoint: string };
  expect(settled).toEqual({
    status: 'fulfilled',
    settledAtMs: expect.any(Number),
    value: {
      ...(plan.withExtras
        ? { firstName: `Sam-${plan.id}`, gender: 'female' }
        : {}),
      skillLevel: 'intermediate',
      handedness: 'right',
      goal: 'dinks',
      biggestProblem: `problem-${plan.id}`,
      focusCheckpoint: body.recommendedCheckpoint,
    },
  });
  expect(attempts).toHaveLength(retried ? 2 : 1);
}

function checkRequestEnvelope(
  plan: CallPlan,
  request: IssuedRequest,
  attempt: number,
): void {
  const session = sessionFor(plan.actor, plan.bearerVersion);
  const { method, path } = PATHS[plan.kind];
  expect(request.url).toBe(`${API}${path}`);
  expect(request.method).toBe(method);
  expect(request.headers['Authorization']).toBe(
    `Bearer ${session.bearerToken}`,
  );
  expect(request.headers['Accept']).toBe('application/json');
  expect(request.headers['Content-Type']).toBe('application/json');
  if (plan.kind.startsWith('consent') || plan.kind.startsWith('onboarding')) {
    expect(request.headers['X-Client-Version']).toBe(
      getRuntimePublicConfig().appVersion,
    );
  }
  expect(request.body).toEqual(expectedBody(plan, attempt));
  expect(request.signal).toBeInstanceOf(AbortSignal);
}

function checkDeadline(request: IssuedRequest, settledAtMs: number): void {
  const deadline = request.issuedAtMs + CLIENT_DEADLINE_MS;
  switch (request.plan.kind) {
    case 'hang':
      expect(request.abortedAtMs).toBe(deadline);
      expect(settledAtMs).toBeLessThanOrEqual(deadline);
      return;
    case 'late_ignores_abort':
      // The client DID abort at the deadline; the transport ignored it.
      expect(request.abortedAtMs).toBe(deadline);
      expect(settledAtMs).toBe(request.issuedAtMs + request.plan.delayMs);
      return;
    default:
      expect(request.abortedAtMs).toBeNull();
      expect(settledAtMs).toBeLessThanOrEqual(deadline);
  }
}

/* ------------------------------ campaign -------------------------------- */

function planIteration(rng: Rng): CallPlan[] {
  const count = randomInt(rng, 2, 14);
  const plans: CallPlan[] = [];
  for (let i = 0; i < count; i += 1) {
    // Duplicates: with probability 0.3 repeat the previous call's kind/actor
    // so the burst contains same-endpoint, same-user pairs.
    const previous = plans[i - 1];
    const kind =
      previous && chance(rng, 0.3) ? previous.kind : pick(rng, CALL_KINDS);
    const actor: Actor =
      previous && chance(rng, 0.5) ? previous.actor : pick(rng, ['A', 'B']);
    const base = {
      id: `c${i}`,
      kind,
      actor,
      // Rotation during the burst: later calls may hold a newer bearer.
      bearerVersion: chance(rng, 0.25) ? 2 : 1,
      withExtras: chance(rng, 0.5),
    };
    const replies = [planReply(rng, () => okBodyFor(rng, base))];
    if (kind === 'onboarding_save')
      replies.push(planReply(rng, () => okBodyFor(rng, base)));
    plans.push({ ...base, replies });
  }
  return plans;
}

const BUDGET_MS = 2 * (CLIENT_DEADLINE_MS + 5_000) + 1_000;

describe('account clients — seeded concurrent bursts', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-05T02:00:00.000Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const seeds = campaignSeeds(`${SUITE}/burst`, 40);
  const totals = {
    calls: 0,
    requests: 0,
    lateAccepted: 0,
    hung: 0,
    peakInFlight: 0,
  };

  it.each(seeds)('seed %i: every call settles per its own plan', async seed => {
    await runIteration(SUITE, 'burst', seed, async rng => {
      const plans = planIteration(rng);
      const transport = new ScheduledTransport();
      const startedAt = Date.now();
      let burstSettled = false;
      const burst = Promise.all(plans.map(plan => issue(plan, transport))).then(
        r => {
          burstSettled = true;
          return r;
        },
      );
      // Deadlock guard: virtual time is advanced in bounded steps; a call
      // that never settles leaves `burstSettled` false instead of hanging Jest.
      const elapsed = await drain(() => burstSettled, BUDGET_MS);
      expect(burstSettled).toBe(true);
      const results = await burst;
      const observed = {
        calls: plans.length,
        requests: transport.requests.length,
        peakInFlight: transport.peakInFlight,
        virtualElapsedMs: elapsed,
        maxSettleMs: Math.max(...results.map(r => r.settledAtMs - startedAt)),
        lateAccepted: transport.requests.filter(
          r => r.plan.kind === 'late_ignores_abort',
        ).length,
        hung: transport.requests.filter(r => r.plan.kind === 'hang').length,
        nonJsonProfileReadAsNone: plans.filter((plan, index) => {
          const settled = results[index];
          return (
            plan.kind === 'onboarding_fetch' &&
            plan.replies[0]?.kind === 'ok_non_json' &&
            settled?.status === 'fulfilled' &&
            settled.value === null
          );
        }).length,
        timersLeft: jest.getTimerCount(),
      };
      return {
        plan: { calls: plans },
        observed,
        check: () => {
          totals.calls += plans.length;
          totals.requests += transport.requests.length;
          totals.lateAccepted += observed.lateAccepted;
          totals.hung += observed.hung;
          totals.peakInFlight = Math.max(
            totals.peakInFlight,
            observed.peakInFlight,
          );
          expect(observed.timersLeft).toBe(0);
          plans.forEach((plan, index) => {
            const settled = results[index];
            if (!settled) throw new Error('missing result');
            const attempts = transport.requestsFor(plan.id);
            expect(attempts).toHaveLength(expectedAttempts(plan));
            attempts.forEach((request, attempt) => {
              checkRequestEnvelope(plan, request, attempt);
              // Bounded per request; the call settles when its last request does.
              if (attempt === attempts.length - 1)
                checkDeadline(request, settled.settledAtMs);
            });
            const first = plan.replies[0];
            if (!first) throw new Error('missing reply plan');
            switch (plan.kind) {
              case 'delete_request':
              case 'delete_confirm':
                checkDeletionOutcome(plan, first, settled);
                break;
              case 'consent_status':
              case 'consent_grant_mt':
              case 'consent_withdraw_mt':
              case 'consent_grant_et':
              case 'consent_withdraw_et':
                checkConsentOutcome(first, settled);
                break;
              case 'onboarding_fetch':
                checkOnboardingFetchOutcome(first, settled);
                break;
              case 'onboarding_save':
                checkOnboardingSaveOutcome(plan, settled, attempts);
                break;
            }
          });
        },
      };
    });
  });

  it('records campaign totals', () => {
    // Not an assertion on behaviour — the NDJSON rows hold the per-seed
    // evidence; this makes the aggregate visible in the run log.
    expect(totals.calls).toBeGreaterThan(0);
    expect(totals.requests).toBeGreaterThanOrEqual(totals.calls);
  });
});
