/**
 * STRESS (seeded randomized long-run) — `src/account/deletion.ts`.
 *
 * Generates legal and near-legal action sequences over the two-step deletion
 * client (`requestAccountDeletion` / `confirmAccountDeletion`) against a
 * simulated server whose every answer is drawn from the seed: clean
 * responses, the real error statuses the edge fn emits (401 / 403 / 429 /
 * 5xx), malformed 2xx bodies, non-JSON bodies, network failures and stalled
 * sockets. The client's own 15 s deadline is driven with fake timers.
 *
 * Invariants model-checked after EVERY step (from the module docblock and
 * `__tests__/accountDeletion.test.ts`):
 *   D1  no session → `deletion.not_configured`, zero network calls
 *   D2  exactly one request per call — the client never retries a deletion
 *   D3  request envelope: POST to `${apiBaseUrl}/v1/me/delete-request|confirm`,
 *       JSON Accept/Content-Type, `Authorization: Bearer <current token>`,
 *       an abort signal; step 1 sends NO body for a skipped survey and
 *       `{survey}` verbatim otherwise; step 2 sends exactly `{challenge}`
 *   D4  status → error class: 401 → session_expired (not retryable);
 *       429 / 5xx → rejected + retryable; other non-2xx → rejected, not
 *       retryable, carrying the server's `error.message` when it is a string
 *       and the "Nothing was deleted" default otherwise; network/abort →
 *       unavailable + retryable
 *   D5  the deadline: a stalled request is still pending 1 ms before 15 s
 *       and rejected as `deletion.unavailable` right after
 *   D6  malformed 2xx bodies never resolve: step 1 needs string
 *       challenge+expiresAt, step 2 needs `deleted === true`; an unknown or
 *       missing revocation outcome is coerced to `not_applicable`
 *   D7  every thrown error is an `AccountDeletionError` (never a raw
 *       TypeError / SyntaxError / AbortError)
 *   D8  no timer survives a settled call (`jest.getTimerCount() === 0`)
 *   D9  SAFETY: the client believes the account is deleted ONLY when the
 *       simulated server actually deleted it
 *   D10 determinism: the same seed replays to an identical trace
 *
 * Replay one seed:  STRESS_ONLY_SEED=<seed> npx jest __tests__/stress/accountDeletionRandomized
 * Long campaign:    STRESS_ITER=2500 npx jest __tests__/stress/accountDeletionRandomized
 */
import type { ApiSession } from '../../src/account/apiSession';
import {
  ACCOUNT_DELETION_DETAILS_MAX,
  ACCOUNT_DELETION_REASONS,
  ACCOUNT_DELETION_WANTED,
  AccountDeletionError,
  confirmAccountDeletion,
  requestAccountDeletion,
  type AccountDeletionSurvey,
} from '../../src/account/deletion';
import {
  campaignConfig,
  createFakeFetch,
  describeFailures,
  runCampaign,
  seededUuid,
  settle,
  stable,
  type Rng,
  type SequenceSpec,
  type WireFault,
} from '../../test-support/stress/seededCampaign';

const DEADLINE_MS = 15_000;
const API_BASE = 'https://api.example.test/functions/v1/api';
const CLOCK_START = Date.parse('2026-09-05T00:00:00.000Z');

// Client-authored copy the oracle pins verbatim (a change here is a
// user-visible behaviour change and must be deliberate).
const MSG_NOT_CONFIGURED = 'Sign in to a synced account before deleting it.';
const MSG_UNAVAILABLE =
  'Account deletion is temporarily offline. Nothing was deleted — please try again.';
const MSG_EXPIRED =
  'Your sign-in has expired. Sign in again, then delete your account.';
const MSG_REJECTED_DEFAULT =
  'The deletion request could not be completed. Nothing was deleted.';
const MSG_INVALID_RESPONSE =
  'The server returned an invalid deletion response.';
const MSG_INVALID_CHALLENGE =
  'The server returned an invalid deletion challenge.';
const MSG_NOT_CONFIRMED = 'The server did not confirm the deletion.';

type RequestFault =
  | 'none'
  | 'network'
  | 'hang'
  | 'http401'
  | 'http403'
  | 'http429'
  | 'http500'
  | 'http503'
  | 'http400_msg'
  | 'http400_nomsg'
  | 'http400_error_not_record'
  | 'http400_text'
  | 'ok_nonjson'
  | 'ok_array'
  | 'ok_null'
  | 'ok_string'
  | 'ok_bad_challenge'
  | 'ok_missing_expires';

type ConfirmFault =
  | Exclude<RequestFault, 'ok_bad_challenge' | 'ok_missing_expires'>
  | 'ok_deleted_false'
  | 'ok_deleted_missing'
  | 'ok_no_revocation'
  | 'ok_unknown_revocation';

const REQUEST_FAULTS: readonly RequestFault[] = [
  'network',
  'hang',
  'http401',
  'http403',
  'http429',
  'http500',
  'http503',
  'http400_msg',
  'http400_nomsg',
  'http400_error_not_record',
  'http400_text',
  'ok_nonjson',
  'ok_array',
  'ok_null',
  'ok_string',
  'ok_bad_challenge',
  'ok_missing_expires',
];

const CONFIRM_FAULTS: readonly ConfirmFault[] = [
  'network',
  'hang',
  'http401',
  'http403',
  'http429',
  'http500',
  'http503',
  'http400_msg',
  'http400_nomsg',
  'http400_error_not_record',
  'http400_text',
  'ok_nonjson',
  'ok_array',
  'ok_null',
  'ok_string',
  'ok_deleted_false',
  'ok_deleted_missing',
  'ok_no_revocation',
  'ok_unknown_revocation',
];

type ChallengeChoice = 'current' | 'stale' | 'garbage' | 'empty';

type Action =
  | {
      kind: 'request';
      survey: AccountDeletionSurvey | null;
      fault: RequestFault;
      noSession: boolean;
    }
  | {
      kind: 'confirm';
      challengeChoice: ChallengeChoice;
      fault: ConfirmFault;
      noSession: boolean;
    }
  | { kind: 'rotateBearer' }
  | { kind: 'expireChallenge' };

// ─── Generator ───────────────────────────────────────────────────────────────

const DETAIL_ALPHABET =
  'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?-\'"\n\t<>&éñ日本語🏓';

function randomText(rng: Rng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += DETAIL_ALPHABET[rng.int(0, DETAIL_ALPHABET.length - 1)];
  }
  return out;
}

function randomSurvey(rng: Rng): AccountDeletionSurvey {
  const detailsKind = rng.weighted([
    ['null', 4],
    ['empty', 1],
    ['short', 4],
    ['at_max', 1],
    ['over_max', 1],
  ] as const);
  const details =
    detailsKind === 'null'
      ? null
      : detailsKind === 'empty'
        ? ''
        : detailsKind === 'short'
          ? randomText(rng, rng.int(1, 80))
          : detailsKind === 'at_max'
            ? randomText(rng, ACCOUNT_DELETION_DETAILS_MAX)
            : randomText(rng, ACCOUNT_DELETION_DETAILS_MAX + rng.int(1, 200));
  return {
    reason: rng.pick(ACCOUNT_DELETION_REASONS),
    wanted: rng.chance(0.3) ? null : rng.pick(ACCOUNT_DELETION_WANTED),
    details,
    platform: rng.weighted([
      ['ios', 6],
      ['android', 1],
      [null, 1],
    ] as const),
    appVersion: rng.chance(0.85) ? '1.0' : null,
  };
}

function generate(rng: Rng, length: number): Action[] {
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const kind = rng.weighted([
      ['request', 35],
      ['confirm', 35],
      ['rotateBearer', 15],
      ['expireChallenge', 15],
    ] as const);
    if (kind === 'request') {
      actions.push({
        kind,
        survey: rng.chance(0.5) ? randomSurvey(rng) : null,
        fault: rng.chance(0.5) ? 'none' : rng.pick(REQUEST_FAULTS),
        noSession: rng.chance(0.06),
      });
    } else if (kind === 'confirm') {
      actions.push({
        kind,
        challengeChoice: rng.weighted([
          ['current', 6],
          ['stale', 2],
          ['garbage', 1],
          ['empty', 1],
        ] as const),
        fault: rng.chance(0.5) ? 'none' : rng.pick(CONFIRM_FAULTS),
        noSession: rng.chance(0.06),
      });
    } else {
      actions.push({ kind });
    }
  }
  return actions;
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'request':
      return `request(survey=${action.survey ? stable(action.survey) : 'null'}, fault=${action.fault}${action.noSession ? ', noSession' : ''})`;
    case 'confirm':
      return `confirm(challenge=${action.challengeChoice}, fault=${action.fault}${action.noSession ? ', noSession' : ''})`;
    case 'rotateBearer':
    case 'expireChallenge':
      return action.kind;
  }
}

// ─── Simulated server + oracle ───────────────────────────────────────────────

interface ServerModel {
  challenge: string | null;
  stale: string | null;
  /** The server destroyed the account (subsequent bearers are refused). */
  deleted: boolean;
  /** Revocation outcome the server would report for the next real deletion. */
  nextRevocation: 'revoked' | 'not_applicable' | 'manual_action_required';
}

type Expected =
  | { outcome: 'resolved'; value: unknown }
  | {
      outcome: 'error';
      code: AccountDeletionError['code'];
      retryable: boolean;
      message: string;
    };

interface Plan {
  wire: WireFault | null;
  expected: Expected;
  expectedBody: unknown;
  /** Whether the server state changes to "deleted" if this answer is sent. */
  serverDeletes: boolean;
  mintsChallenge: string | null;
  hang: boolean;
}

const httpError = (
  status: number,
  fault: string,
  message: string | null,
): WireFault => {
  if (fault === 'http400_nomsg')
    return { kind: 'http', status, body: { error: { code: 'x' } } };
  if (fault === 'http400_error_not_record') {
    return { kind: 'http', status, body: { error: 'validation failed' } };
  }
  if (fault === 'http400_text') return { kind: 'http_nonjson', status };
  return {
    kind: 'http',
    status,
    body: { error: { code: 'account.deletion', message } },
  };
};

const STATUS_OF: Record<string, number> = {
  http401: 401,
  http403: 403,
  http429: 429,
  http500: 500,
  http503: 503,
  http400_msg: 400,
  http400_nomsg: 400,
  http400_error_not_record: 400,
  http400_text: 400,
};

/** Shared translation of a wire fault into the outcome the client must
 * produce, independent of the client code. */
function expectedForFault(
  fault: RequestFault | ConfirmFault,
  serverMessage: string,
): { wire: WireFault; expected: Expected } | null {
  switch (fault) {
    case 'network':
      return {
        wire: { kind: 'network' },
        expected: {
          outcome: 'error',
          code: 'deletion.unavailable',
          retryable: true,
          message: MSG_UNAVAILABLE,
        },
      };
    case 'hang':
      return {
        wire: { kind: 'hang' },
        expected: {
          outcome: 'error',
          code: 'deletion.unavailable',
          retryable: true,
          message: MSG_UNAVAILABLE,
        },
      };
    case 'http401':
      return {
        wire: httpError(401, fault, 'Unauthorized'),
        expected: {
          outcome: 'error',
          code: 'deletion.session_expired',
          retryable: false,
          message: MSG_EXPIRED,
        },
      };
    case 'http403':
    case 'http429':
    case 'http500':
    case 'http503':
    case 'http400_msg': {
      const status = STATUS_OF[fault]!;
      return {
        wire: httpError(status, fault, serverMessage),
        expected: {
          outcome: 'error',
          code: 'deletion.rejected',
          retryable: status === 429 || status >= 500,
          message: serverMessage,
        },
      };
    }
    case 'http400_nomsg':
    case 'http400_error_not_record':
    case 'http400_text':
      return {
        wire: httpError(400, fault, null),
        expected: {
          outcome: 'error',
          code: 'deletion.rejected',
          retryable: false,
          message: MSG_REJECTED_DEFAULT,
        },
      };
    case 'ok_nonjson':
      return {
        wire: { kind: 'ok_nonjson' },
        expected: {
          outcome: 'error',
          code: 'deletion.rejected',
          retryable: false,
          message: MSG_INVALID_RESPONSE,
        },
      };
    case 'ok_array':
    case 'ok_null':
    case 'ok_string':
      return {
        wire: {
          kind: 'ok',
          body:
            fault === 'ok_array'
              ? [{ challenge: 'x', deleted: true }]
              : fault === 'ok_null'
                ? null
                : 'deleted',
        },
        expected: {
          outcome: 'error',
          code: 'deletion.rejected',
          retryable: false,
          message: MSG_INVALID_RESPONSE,
        },
      };
    default:
      return null;
  }
}

function planRequest(
  action: Extract<Action, { kind: 'request' }>,
  model: ServerModel,
  rng: Rng,
  nowMs: number,
): Plan {
  const expectedBody = action.survey ? { survey: action.survey } : undefined;
  const base = {
    expectedBody,
    serverDeletes: false,
    mintsChallenge: null,
    hang: action.fault === 'hang' && !action.noSession,
  };
  if (action.noSession) {
    return {
      ...base,
      wire: null,
      expected: {
        outcome: 'error',
        code: 'deletion.not_configured',
        retryable: false,
        message: MSG_NOT_CONFIGURED,
      },
    };
  }
  const shared = expectedForFault(action.fault, 'Deletion is rate limited.');
  if (shared) return { ...base, ...shared };
  const minted = seededUuid(rng);
  const expiresAt = new Date(nowMs + 10 * 60_000).toISOString();
  switch (action.fault) {
    case 'ok_bad_challenge':
      return {
        ...base,
        wire: { kind: 'ok', body: { challenge: 12345, expiresAt } },
        expected: {
          outcome: 'error',
          code: 'deletion.rejected',
          retryable: false,
          message: MSG_INVALID_CHALLENGE,
        },
      };
    case 'ok_missing_expires':
      return {
        ...base,
        wire: { kind: 'ok', body: { challenge: minted } },
        expected: {
          outcome: 'error',
          code: 'deletion.rejected',
          retryable: false,
          message: MSG_INVALID_CHALLENGE,
        },
      };
    case 'none':
      if (model.deleted) {
        return {
          ...base,
          wire: httpError(401, 'http401', 'Unauthorized'),
          expected: {
            outcome: 'error',
            code: 'deletion.session_expired',
            retryable: false,
            message: MSG_EXPIRED,
          },
        };
      }
      return {
        ...base,
        wire: { kind: 'ok', body: { challenge: minted, expiresAt } },
        expected: {
          outcome: 'resolved',
          value: { challenge: minted, expiresAt },
        },
        mintsChallenge: minted,
      };
    default:
      throw new Error(`unhandled request fault ${String(action.fault)}`);
  }
}

const CHALLENGE_INVALID_MSG =
  'This deletion was not requested, or the confirmation does not match. Start again from Settings.';

function planConfirm(
  action: Extract<Action, { kind: 'confirm' }>,
  model: ServerModel,
  sentChallenge: string,
): Plan {
  const base = {
    expectedBody: { challenge: sentChallenge },
    serverDeletes: false,
    mintsChallenge: null,
    hang: action.fault === 'hang' && !action.noSession,
  };
  if (action.noSession) {
    return {
      ...base,
      wire: null,
      expected: {
        outcome: 'error',
        code: 'deletion.not_configured',
        retryable: false,
        message: MSG_NOT_CONFIGURED,
      },
    };
  }
  const shared = expectedForFault(
    action.fault,
    'Please review the confirmation before deleting.',
  );
  if (shared) return { ...base, ...shared };
  switch (action.fault) {
    case 'ok_deleted_false':
      return {
        ...base,
        wire: { kind: 'ok', body: { deleted: false } },
        expected: {
          outcome: 'error',
          code: 'deletion.rejected',
          retryable: false,
          message: MSG_NOT_CONFIRMED,
        },
      };
    case 'ok_deleted_missing':
      return {
        ...base,
        wire: { kind: 'ok', body: { appleAuthorizationRevocation: 'revoked' } },
        expected: {
          outcome: 'error',
          code: 'deletion.rejected',
          retryable: false,
          message: MSG_NOT_CONFIRMED,
        },
      };
    case 'ok_no_revocation':
      // A pre-revocation backend: it deleted, and says only {deleted:true}.
      return {
        ...base,
        wire: { kind: 'ok', body: { deleted: true } },
        expected: {
          outcome: 'resolved',
          value: { appleAuthorizationRevocation: 'not_applicable' },
        },
        serverDeletes: true,
      };
    case 'ok_unknown_revocation':
      return {
        ...base,
        wire: {
          kind: 'ok',
          body: { deleted: true, appleAuthorizationRevocation: 'pending' },
        },
        expected: {
          outcome: 'resolved',
          value: { appleAuthorizationRevocation: 'not_applicable' },
        },
        serverDeletes: true,
      };
    case 'none': {
      if (model.deleted) {
        return {
          ...base,
          wire: httpError(401, 'http401', 'Unauthorized'),
          expected: {
            outcome: 'error',
            code: 'deletion.session_expired',
            retryable: false,
            message: MSG_EXPIRED,
          },
        };
      }
      if (model.challenge !== null && sentChallenge === model.challenge) {
        return {
          ...base,
          wire: {
            kind: 'ok',
            body: {
              deleted: true,
              appleAuthorizationRevocation: model.nextRevocation,
            },
          },
          expected: {
            outcome: 'resolved',
            value: { appleAuthorizationRevocation: model.nextRevocation },
          },
          serverDeletes: true,
        };
      }
      return {
        ...base,
        wire: {
          kind: 'http',
          status: 403,
          body: {
            error: {
              code: 'account.deletion_challenge_invalid',
              message: CHALLENGE_INVALID_MSG,
            },
          },
        },
        expected: {
          outcome: 'error',
          code: 'deletion.rejected',
          retryable: false,
          message: CHALLENGE_INVALID_MSG,
        },
      };
    }
    default:
      throw new Error(`unhandled confirm fault ${String(action.fault)}`);
  }
}

// ─── Executor ────────────────────────────────────────────────────────────────

function describeSettled(
  settled: Awaited<ReturnType<typeof settle<unknown>>>,
): unknown {
  if (settled.kind === 'stuck') return { outcome: 'stuck' };
  if (settled.kind === 'resolved') {
    return { outcome: 'resolved', value: settled.value };
  }
  const error = settled.error;
  if (error instanceof AccountDeletionError) {
    return {
      outcome: 'error',
      code: error.code,
      retryable: error.retryable,
      message: error.message,
      name: error.name,
    };
  }
  return {
    outcome: 'error',
    foreign:
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
  };
}

async function execute(
  actions: Action[],
  rng: Rng,
  seed: number,
): Promise<{
  trace: { step: number; action: string; outcome: string }[];
  violation: { step: number; message: string } | null;
}> {
  jest.useFakeTimers({ now: CLOCK_START + (seed % 1000) * 1000 });
  const trace: { step: number; action: string; outcome: string }[] = [];
  const model: ServerModel = {
    challenge: null,
    stale: null,
    deleted: false,
    nextRevocation: rng.pick([
      'revoked',
      'not_applicable',
      'manual_action_required',
    ] as const),
  };
  let bearerSerial = 0;
  const session: ApiSession = {
    apiBaseUrl: API_BASE,
    bearerToken: `bearer-${seed}-0`,
    canonicalAppUserId: seededUuid(rng),
    provider: rng.pick(['apple', 'google'] as const),
  };
  let clientBelievesDeleted = false;
  const violations: { step: number; message: string }[] = [];

  const fail = (step: number, message: string): void => {
    if (violations.length === 0) violations.push({ step, message });
  };

  try {
    for (const [step, action] of actions.entries()) {
      const fake = createFakeFetch();
      let outcome: unknown;

      if (action.kind === 'rotateBearer') {
        bearerSerial += 1;
        session.bearerToken = `bearer-${seed}-${bearerSerial}`;
        outcome = { outcome: 'rotated', serial: bearerSerial };
      } else if (action.kind === 'expireChallenge') {
        model.stale = model.challenge ?? model.stale;
        model.challenge = null;
        outcome = { outcome: 'expired' };
      } else {
        let plan: Plan;
        let promise: Promise<unknown>;
        if (action.kind === 'request') {
          plan = planRequest(action, model, rng, Date.now());
          if (plan.wire) fake.queue(plan.wire);
          promise = requestAccountDeletion(
            action.noSession ? null : session,
            action.survey,
            fake.fetchFn,
          );
        } else {
          const sent =
            action.challengeChoice === 'current'
              ? (model.challenge ?? 'never-minted')
              : action.challengeChoice === 'stale'
                ? (model.stale ?? 'never-staled')
                : action.challengeChoice === 'garbage'
                  ? randomText(rng, rng.int(1, 40))
                  : '';
          plan = planConfirm(action, model, sent);
          if (plan.wire) fake.queue(plan.wire);
          promise = confirmAccountDeletion(
            action.noSession ? null : session,
            sent,
            fake.fetchFn,
          );
        }
        const settled = await settle(promise, DEADLINE_MS);
        outcome = describeSettled(settled);

        // Server-side effects happen when the request reached the server.
        if (plan.wire && plan.serverDeletes) model.deleted = true;
        if (plan.wire && plan.mintsChallenge) {
          model.stale = model.challenge ?? model.stale;
          model.challenge = plan.mintsChallenge;
        }
        if (settled.kind === 'resolved' && action.kind === 'confirm') {
          clientBelievesDeleted = true;
        }

        // ── Invariants ──
        const expectedCalls = plan.wire ? 1 : 0;
        if (fake.requests.length !== expectedCalls) {
          fail(
            step,
            `D1/D2 expected ${expectedCalls} request(s), saw ${fake.requests.length}`,
          );
        }
        if (fake.pending() !== 0)
          fail(step, 'harness: queued answer not consumed');
        const req = fake.requests[0];
        if (req) {
          const path =
            action.kind === 'request'
              ? '/v1/me/delete-request'
              : '/v1/me/delete-confirm';
          if (req.url !== `${API_BASE}${path}`) fail(step, `D3 url ${req.url}`);
          if (req.method !== 'POST') fail(step, `D3 method ${req.method}`);
          if (req.headers.Authorization !== `Bearer ${session.bearerToken}`) {
            fail(step, `D3 bearer ${req.headers.Authorization}`);
          }
          if (
            req.headers.Accept !== 'application/json' ||
            req.headers['Content-Type'] !== 'application/json'
          ) {
            fail(step, `D3 headers ${stable(req.headers)}`);
          }
          if (!req.hadSignal) fail(step, 'D3 request carried no abort signal');
          if (stable(req.body) !== stable(plan.expectedBody)) {
            fail(
              step,
              `D3 body ${stable(req.body)} ≠ ${stable(plan.expectedBody)}`,
            );
          }
          if (plan.expectedBody === undefined && req.rawBody !== undefined) {
            fail(step, 'D3 skipped survey must send no body at all');
          }
        }
        if (settled.kind === 'stuck') {
          fail(step, 'D5 call never settled after the deadline');
        } else if (plan.hang && !settled.pendingBeforeDeadline) {
          fail(step, 'D5 stalled request settled before the 15 s deadline');
        }
        if (
          settled.kind === 'rejected' &&
          !(settled.error instanceof AccountDeletionError)
        ) {
          fail(step, `D7 foreign error ${stable(describeSettled(settled))}`);
        }
        const expectedOutcome =
          plan.expected.outcome === 'resolved'
            ? { outcome: 'resolved', value: plan.expected.value }
            : { ...plan.expected, name: 'AccountDeletionError' };
        if (stable(outcome) !== stable(expectedOutcome)) {
          fail(
            step,
            `D4/D6 outcome ${stable(outcome)} ≠ expected ${stable(expectedOutcome)}`,
          );
        }
        if (jest.getTimerCount() !== 0) {
          fail(step, `D8 ${jest.getTimerCount()} timer(s) leaked`);
          jest.clearAllTimers();
        }
        if (clientBelievesDeleted && !model.deleted) {
          fail(
            step,
            'D9 client believes the account is deleted but the server never deleted it',
          );
        }
      }

      trace.push({
        step,
        action: describeAction(action),
        outcome: stable(outcome),
      });
      if (violations.length > 0) break;
    }
  } finally {
    jest.useRealTimers();
  }
  return { trace, violation: violations[0] ?? null };
}

function coverageKey(action: Action): string {
  switch (action.kind) {
    case 'request':
      return `request:${action.noSession ? 'noSession' : action.fault}:${action.survey ? 'survey' : 'noSurvey'}`;
    case 'confirm':
      return `confirm:${action.noSession ? 'noSession' : action.fault}:${action.challengeChoice}`;
    default:
      return action.kind;
  }
}

const spec: SequenceSpec<Action> = {
  generate,
  execute,
  describeAction,
  coverageKey,
};

describe('STRESS account deletion client — seeded randomized sequences', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it(
    'holds D1–D10 on every seeded sequence (see STRESS_* knobs)',
    async () => {
      const config = campaignConfig();
      const output = await runCampaign(
        'account-deletion-randomized',
        spec,
        config,
      );
      const digest = describeFailures(output);
      expect(digest).toBe('');
      expect(output.summary.sequencesExecuted).toBe(
        config.onlySeeds?.length ?? config.iterations,
      );
      expect(output.summary.nonDeterministicSeeds).toEqual([]);
    },
    20 * 60_000,
  );
});
