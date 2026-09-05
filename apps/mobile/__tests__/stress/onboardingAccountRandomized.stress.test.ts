/**
 * STRESS (seeded randomized long-run) — `src/account/onboarding.ts`.
 *
 * Random sequences of `fetchCanonicalOnboardingProfile` (GET /v1/me) and
 * `saveCanonicalOnboardingProfile` (PUT /v1/me/onboarding) with randomly
 * generated valid and near-valid profiles (whitespace names, every gender,
 * unknown goals, unicode) against a simulated account server whose answers
 * — including the answer to the one-shot identity-field fallback retry —
 * are all drawn from the seed: clean payloads, malformed profiles (wrong
 * state, empty/non-string core fields, bad handedness, bad identity
 * fields), HTTP errors with and without a server message, non-JSON, network
 * failures and stalled sockets driven past the 15 s deadline (twice when
 * both the first PUT and the retry stall).
 *
 * Invariants model-checked after EVERY step (module comments +
 * `__tests__/onboardingAccount.test.ts`):
 *   O1  every request: right method/path on `${apiBaseUrl}`, JSON
 *       Accept/Content-Type, `Authorization: Bearer <current>`,
 *       `X-Client-Version: <runtime appVersion>`, an abort signal; GET sends
 *       no body
 *   O2  save sends `{skillLevel, handedness, goal, biggestProblem}` plus
 *       `firstName` (trimmed) only when non-blank and `gender` only when
 *       set — no `undefined`/blank identity keys ever reach the wire
 *   O3  the identity fallback: exactly ONE retry, with EXACTLY the core body
 *       (same four values), and only when the first PUT failed at the
 *       request level AND identity fields were present; never a retry for a
 *       core-only body, never a retry for a 2xx with a bad payload, never a
 *       third request
 *   O4  a failed save never completes onboarding: it throws
 *       OnboardingSyncError with the server's `error.message` when the
 *       server sent one, otherwise the client copy; when the retry also
 *       fails the FIRST error is what surfaces
 *   O5  a save resolves only with a `recommendedCheckpoint` from the shared
 *       CHECKPOINTS list, and the returned profile keeps every answer, the
 *       trimmed name and the server focus
 *   O6  fetch hydrates a profile only when `onboardingState === 'complete'`
 *       and all four core fields are valid; `focusCheckpoint` is
 *       `focusForGoal(goal)`; blank/invalid `first_name`/`gender` are dropped
 *       without dropping the profile; anything else → null (never a throw
 *       for shape problems)
 *   O7  every thrown error is an OnboardingSyncError; a stalled request is
 *       still pending at 14 999 ms and fails right after; no timer survives
 *       a settled call
 *   O8  determinism: the same seed replays to an identical trace
 *
 * Replay one seed:  STRESS_ONLY_SEED=<seed> npx jest __tests__/stress/onboardingAccountRandomized
 * Long campaign:    STRESS_ITER=2500 npx jest __tests__/stress/onboardingAccountRandomized
 */
import { CHECKPOINTS } from '@pickle/shared-types';
import type { ApiSession } from '../../src/account/apiSession';
import {
  OnboardingSyncError,
  fetchCanonicalOnboardingProfile,
  saveCanonicalOnboardingProfile,
} from '../../src/account/onboarding';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import {
  focusForGoal,
  type Gender,
  type Profile,
} from '../../src/state/profile';
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

const API_BASE = 'https://api.example.test/functions/v1/api';
const CLOCK_START = Date.parse('2026-09-05T00:00:00.000Z');
const DEADLINE_MS = 15_000;

const MSG_NETWORK =
  'Your coaching profile could not be securely saved. Check your connection and try again.';
const MSG_HTTP_DEFAULT = 'Your coaching profile could not be securely saved.';
const MSG_INVALID_PROFILE =
  'The account server returned an invalid coaching profile.';
const MSG_INVALID_FOCUS =
  'The account server returned an invalid training focus.';

const GENDERS: readonly Gender[] = [
  'female',
  'male',
  'nonbinary',
  'prefer_not_to_say',
];
const SKILLS = ['beginner', 'intermediate', 'advanced', '3.5', 'pro'];
const GOALS = [
  'dinks',
  'drives',
  'drops',
  'serve',
  'return',
  'volleys',
  'footwork',
  'all-around',
];
const PROBLEMS = ['consistency', 'power', 'footwork', 'nerves', 'pop-ups'];
const HANDS = ['right', 'left', 'ambidextrous'] as const;

const TEXT_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_\'"<>&éñ日本語🏓';

function randomText(rng: Rng, min: number, max: number): string {
  const length = rng.int(min, max);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += TEXT_ALPHABET[rng.int(0, TEXT_ALPHABET.length - 1)];
  }
  return out;
}

/** Request-level faults: the client's `request()` throws before a payload. */
type TransportFault =
  | 'network'
  | 'hang'
  | 'http400_msg'
  | 'http401_msg'
  | 'http403_nomsg'
  | 'http409_error_string'
  | 'http429_msg'
  | 'http500_nomsg'
  | 'http503_text';

/** 2xx faults: the request resolves with a payload the client must vet. */
type SavePayloadFault =
  | 'none'
  | 'ok_nonjson'
  | 'ok_null'
  | 'ok_array'
  | 'ok_string'
  | 'ok_rec_missing'
  | 'ok_rec_number'
  | 'ok_rec_unknown'
  | 'ok_rec_case';

type FetchPayloadFault =
  | 'none'
  | 'incomplete'
  | 'ok_nonjson'
  | 'ok_null'
  | 'ok_array'
  | 'state_missing'
  | 'state_wrong_case'
  | 'profile_missing'
  | 'profile_array'
  | 'skill_empty'
  | 'skill_blank'
  | 'skill_number'
  | 'hand_invalid'
  | 'hand_case'
  | 'goal_blank'
  | 'goal_unknown'
  | 'problem_missing'
  | 'first_name_blank'
  | 'first_name_number'
  | 'first_name_padded'
  | 'gender_invalid'
  | 'gender_missing';

const TRANSPORT_FAULTS: readonly TransportFault[] = [
  'network',
  'hang',
  'http400_msg',
  'http401_msg',
  'http403_nomsg',
  'http409_error_string',
  'http429_msg',
  'http500_nomsg',
  'http503_text',
];
const SAVE_PAYLOAD_FAULTS: readonly SavePayloadFault[] = [
  'ok_nonjson',
  'ok_null',
  'ok_array',
  'ok_string',
  'ok_rec_missing',
  'ok_rec_number',
  'ok_rec_unknown',
  'ok_rec_case',
];
const FETCH_PAYLOAD_FAULTS: readonly FetchPayloadFault[] = [
  'incomplete',
  'ok_nonjson',
  'ok_null',
  'ok_array',
  'state_missing',
  'state_wrong_case',
  'profile_missing',
  'profile_array',
  'skill_empty',
  'skill_blank',
  'skill_number',
  'hand_invalid',
  'hand_case',
  'goal_blank',
  'goal_unknown',
  'problem_missing',
  'first_name_blank',
  'first_name_number',
  'first_name_padded',
  'gender_invalid',
  'gender_missing',
];

type SaveFault = TransportFault | SavePayloadFault;
type FetchFault = TransportFault | FetchPayloadFault;

type Action =
  | { kind: 'fetch'; fault: FetchFault }
  | { kind: 'save'; profile: Profile; first: SaveFault; retry: SaveFault }
  | { kind: 'rotateBearer' };

function randomProfile(rng: Rng): Profile {
  const goal = rng.chance(0.85)
    ? rng.pick(GOALS)
    : `g${randomText(rng, 1, 20)}`;
  const firstNameKind = rng.weighted([
    ['absent', 4],
    ['empty', 1],
    ['blank', 1],
    ['plain', 4],
    ['padded', 2],
    ['unicode', 1],
  ] as const);
  const firstName =
    firstNameKind === 'absent'
      ? undefined
      : firstNameKind === 'empty'
        ? ''
        : firstNameKind === 'blank'
          ? '   '
          : firstNameKind === 'plain'
            ? rng.pick(['Ana', 'Jordan', 'Wei', 'Priya', 'Sam'])
            : firstNameKind === 'padded'
              ? `  ${rng.pick(['Ana', 'Jordan'])}\t `
              : randomText(rng, 1, 30);
  const gender = rng.chance(0.55) ? rng.pick(GENDERS) : undefined;
  return {
    ...(firstName !== undefined ? { firstName } : {}),
    ...(gender !== undefined ? { gender } : {}),
    skillLevel: rng.chance(0.9)
      ? rng.pick(SKILLS)
      : `s${randomText(rng, 1, 12)}`,
    handedness: rng.pick(HANDS),
    goal,
    biggestProblem: rng.chance(0.9)
      ? rng.pick(PROBLEMS)
      : `p${randomText(rng, 1, 40)}`,
    focusCheckpoint: rng.pick(CHECKPOINTS),
  };
}

function generate(rng: Rng, length: number): Action[] {
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const kind = rng.weighted([
      ['fetch', 40],
      ['save', 50],
      ['rotateBearer', 10],
    ] as const);
    if (kind === 'fetch') {
      actions.push({
        kind,
        fault: rng.chance(0.45)
          ? 'none'
          : rng.chance(0.4)
            ? rng.pick(TRANSPORT_FAULTS)
            : rng.pick(FETCH_PAYLOAD_FAULTS),
      });
    } else if (kind === 'save') {
      const draw = (): SaveFault =>
        rng.chance(0.45)
          ? 'none'
          : rng.chance(0.5)
            ? rng.pick(TRANSPORT_FAULTS)
            : rng.pick(SAVE_PAYLOAD_FAULTS);
      actions.push({
        kind,
        profile: randomProfile(rng),
        first: draw(),
        retry: draw(),
      });
    } else {
      actions.push({ kind });
    }
  }
  return actions;
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'fetch':
      return `fetch(fault=${action.fault})`;
    case 'save':
      return `save(profile=${stable(action.profile)}, first=${action.first}, retry=${action.retry})`;
    case 'rotateBearer':
      return action.kind;
  }
}

// ─── Simulated server ────────────────────────────────────────────────────────

interface ServerProfile {
  skill_level: string;
  handedness: string;
  primary_goal: string;
  biggest_problem: string;
  first_name?: string;
  gender?: string;
}

interface ServerModel {
  saved: ServerProfile | null;
}

type Expected =
  | { outcome: 'resolved'; value: unknown }
  | { outcome: 'error'; message: string };

function isTransport(fault: SaveFault | FetchFault): fault is TransportFault {
  return (TRANSPORT_FAULTS as readonly string[]).includes(fault);
}

const TRANSPORT_STATUS: Record<TransportFault, number> = {
  network: 0,
  hang: 0,
  http400_msg: 400,
  http401_msg: 401,
  http403_nomsg: 403,
  http409_error_string: 409,
  http429_msg: 429,
  http500_nomsg: 500,
  http503_text: 503,
};

function transportWire(
  fault: TransportFault,
  serverMessage: string,
): { wire: WireFault; message: string } {
  switch (fault) {
    case 'network':
      return { wire: { kind: 'network' }, message: MSG_NETWORK };
    case 'hang':
      return { wire: { kind: 'hang' }, message: MSG_NETWORK };
    case 'http400_msg':
    case 'http401_msg':
    case 'http429_msg':
      return {
        wire: {
          kind: 'http',
          status: TRANSPORT_STATUS[fault],
          body: {
            error: { code: 'account.onboarding', message: serverMessage },
          },
        },
        message: serverMessage,
      };
    case 'http403_nomsg':
    case 'http500_nomsg':
      return {
        wire: {
          kind: 'http',
          status: TRANSPORT_STATUS[fault],
          body: { error: { code: 'account.onboarding', message: 42 } },
        },
        message: MSG_HTTP_DEFAULT,
      };
    case 'http409_error_string':
      return {
        wire: { kind: 'http', status: 409, body: { error: 'conflict' } },
        message: MSG_HTTP_DEFAULT,
      };
    case 'http503_text':
      return {
        wire: { kind: 'http_nonjson', status: 503 },
        message: MSG_HTTP_DEFAULT,
      };
  }
}

interface SavePlan {
  wires: WireFault[];
  /** Number of PUTs the client must issue (1 or 2). */
  expectedRequests: number;
  expected: Expected;
  /** Whether the server stored the profile (a 2xx was produced). */
  serverStores: boolean;
  hangs: number;
}

function savePayloadPlan(
  fault: SavePayloadFault,
  rng: Rng,
  profile: Profile,
  trimmedName: string | undefined,
): { wire: WireFault; expected: Expected } {
  const bad = (
    body: unknown,
    message: string,
  ): { wire: WireFault; expected: Expected } => ({
    wire: { kind: 'ok', body },
    expected: { outcome: 'error', message },
  });
  switch (fault) {
    case 'none': {
      const recommendation = rng.chance(0.7)
        ? focusForGoal(profile.goal)
        : rng.pick(CHECKPOINTS);
      return {
        wire: {
          kind: 'ok',
          body: {
            recommendedCheckpoint: recommendation,
            onboardingState: 'complete',
          },
        },
        expected: {
          outcome: 'resolved',
          value: {
            ...profile,
            ...(trimmedName ? { firstName: trimmedName } : {}),
            focusCheckpoint: recommendation,
          },
        },
      };
    }
    case 'ok_nonjson':
      return {
        wire: { kind: 'ok_nonjson' },
        expected: { outcome: 'error', message: MSG_INVALID_PROFILE },
      };
    case 'ok_null':
      return bad(null, MSG_INVALID_PROFILE);
    case 'ok_array':
      return bad(
        [{ recommendedCheckpoint: 'ready_position' }],
        MSG_INVALID_PROFILE,
      );
    case 'ok_string':
      return bad('ready_position', MSG_INVALID_PROFILE);
    case 'ok_rec_missing':
      return bad({ onboardingState: 'complete' }, MSG_INVALID_FOCUS);
    case 'ok_rec_number':
      return bad({ recommendedCheckpoint: 3 }, MSG_INVALID_FOCUS);
    case 'ok_rec_unknown':
      return bad({ recommendedCheckpoint: 'dinking_touch' }, MSG_INVALID_FOCUS);
    case 'ok_rec_case':
      return bad(
        { recommendedCheckpoint: 'Ready_Position' },
        MSG_INVALID_FOCUS,
      );
  }
}

function planSave(
  action: Extract<Action, { kind: 'save' }>,
  rng: Rng,
): SavePlan {
  const trimmedName = action.profile.firstName?.trim() || undefined;
  const hasIdentity =
    Boolean(trimmedName) || action.profile.gender !== undefined;
  if (!isTransport(action.first)) {
    const p = savePayloadPlan(action.first, rng, action.profile, trimmedName);
    return {
      wires: [p.wire],
      expectedRequests: 1,
      expected: p.expected,
      serverStores: true,
      hangs: 0,
    };
  }
  const first = transportWire(
    action.first,
    'The onboarding answers were rejected.',
  );
  if (!hasIdentity) {
    return {
      wires: [first.wire],
      expectedRequests: 1,
      expected: { outcome: 'error', message: first.message },
      serverStores: false,
      hangs: action.first === 'hang' ? 1 : 0,
    };
  }
  if (isTransport(action.retry)) {
    const retry = transportWire(action.retry, 'Still rejected on retry.');
    return {
      wires: [first.wire, retry.wire],
      expectedRequests: 2,
      // The FIRST error surfaces when the fallback fails too.
      expected: { outcome: 'error', message: first.message },
      serverStores: false,
      hangs:
        (action.first === 'hang' ? 1 : 0) + (action.retry === 'hang' ? 1 : 0),
    };
  }
  const retry = savePayloadPlan(action.retry, rng, action.profile, trimmedName);
  return {
    wires: [first.wire, retry.wire],
    expectedRequests: 2,
    expected: retry.expected,
    serverStores: true,
    hangs: action.first === 'hang' ? 1 : 0,
  };
}

function serverProfileFor(
  profile: Profile,
  trimmedName: string | undefined,
  core: boolean,
): ServerProfile {
  return {
    skill_level: profile.skillLevel,
    handedness: profile.handedness,
    primary_goal: profile.goal,
    biggest_problem: profile.biggestProblem,
    ...(!core && trimmedName ? { first_name: trimmedName } : {}),
    ...(!core && profile.gender ? { gender: profile.gender } : {}),
  };
}

function hydrated(server: ServerProfile): Profile {
  const gender = GENDERS.includes(server.gender as Gender)
    ? (server.gender as Gender)
    : undefined;
  return {
    ...(typeof server.first_name === 'string' && server.first_name.trim()
      ? { firstName: server.first_name.trim() }
      : {}),
    ...(gender ? { gender } : {}),
    skillLevel: server.skill_level,
    handedness: server.handedness as Profile['handedness'],
    goal: server.primary_goal,
    biggestProblem: server.biggest_problem,
    focusCheckpoint: focusForGoal(server.primary_goal),
  };
}

function planFetch(
  fault: FetchFault,
  model: ServerModel,
  rng: Rng,
): { wire: WireFault; expected: Expected; hang: boolean } {
  if (isTransport(fault)) {
    const t = transportWire(fault, 'Profile lookup rejected.');
    return {
      wire: t.wire,
      expected: { outcome: 'error', message: t.message },
      hang: fault === 'hang',
    };
  }
  const nullish = (
    body: unknown,
  ): { wire: WireFault; expected: Expected; hang: boolean } => ({
    wire: { kind: 'ok', body },
    expected: { outcome: 'resolved', value: null },
    hang: false,
  });
  // Base: the stored profile, or a synthetic complete one when nothing is
  // stored yet (so field-level corruption always has something to corrupt).
  const base: ServerProfile = model.saved ?? {
    skill_level: rng.pick(SKILLS),
    handedness: rng.pick(HANDS),
    primary_goal: rng.pick(GOALS),
    biggest_problem: rng.pick(PROBLEMS),
    ...(rng.chance(0.5) ? { first_name: 'Ana' } : {}),
    ...(rng.chance(0.5) ? { gender: rng.pick(GENDERS) } : {}),
  };
  const complete = (profile: Record<string, unknown>): unknown => ({
    onboardingState: 'complete',
    profile,
  });
  const okWith = (
    profile: ServerProfile,
  ): { wire: WireFault; expected: Expected; hang: boolean } => ({
    wire: { kind: 'ok', body: complete({ ...profile }) },
    expected: { outcome: 'resolved', value: hydrated(profile) },
    hang: false,
  });
  switch (fault) {
    case 'none':
      return model.saved
        ? okWith(model.saved)
        : nullish({ onboardingState: 'incomplete', profile: null });
    case 'incomplete':
      return nullish({ onboardingState: 'incomplete', profile: { ...base } });
    case 'ok_nonjson':
      // Current contract: an unparseable 2xx hydrates as "no profile".
      return {
        wire: { kind: 'ok_nonjson' },
        expected: { outcome: 'resolved', value: null },
        hang: false,
      };
    case 'ok_null':
      return nullish(null);
    case 'ok_array':
      return nullish([complete({ ...base })]);
    case 'state_missing':
      return nullish({ profile: { ...base } });
    case 'state_wrong_case':
      return nullish({ onboardingState: 'Complete', profile: { ...base } });
    case 'profile_missing':
      return nullish({ onboardingState: 'complete' });
    case 'profile_array':
      return nullish({ onboardingState: 'complete', profile: [base] });
    case 'skill_empty':
      return nullish(complete({ ...base, skill_level: '' }));
    case 'skill_blank':
      return nullish(complete({ ...base, skill_level: ' \t ' }));
    case 'skill_number':
      return nullish(complete({ ...base, skill_level: 3.5 }));
    case 'hand_invalid':
      return nullish(complete({ ...base, handedness: 'both' }));
    case 'hand_case':
      return nullish(complete({ ...base, handedness: 'Right' }));
    case 'goal_blank':
      return nullish(complete({ ...base, primary_goal: '   ' }));
    case 'goal_unknown':
      // Legal: unknown goals hydrate with the default focus.
      return okWith({ ...base, primary_goal: `g${randomText(rng, 1, 15)}` });
    case 'problem_missing': {
      const { biggest_problem: _dropped, ...rest } = base;
      return nullish(complete({ ...rest }));
    }
    case 'first_name_blank':
      return okWith({ ...base, first_name: '   ' });
    case 'first_name_number': {
      const wire: WireFault = {
        kind: 'ok',
        body: complete({ ...base, first_name: 7 }),
      };
      const { first_name: _dropped, ...rest } = base;
      return {
        wire,
        expected: { outcome: 'resolved', value: hydrated(rest) },
        hang: false,
      };
    }
    case 'first_name_padded':
      return okWith({ ...base, first_name: '  Jordan \n' });
    case 'gender_invalid':
      return okWith({ ...base, gender: 'Female' });
    case 'gender_missing': {
      const { gender: _dropped, ...rest } = base;
      return okWith(rest);
    }
  }
}

// ─── Executor ────────────────────────────────────────────────────────────────

function describeSettled(
  settled: Awaited<ReturnType<typeof settle<unknown>>>,
): unknown {
  if (settled.kind === 'stuck') return { outcome: 'stuck' };
  if (settled.kind === 'resolved')
    return { outcome: 'resolved', value: settled.value };
  const error = settled.error;
  if (error instanceof OnboardingSyncError) {
    return { outcome: 'error', name: error.name, message: error.message };
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
  const violations: { step: number; message: string }[] = [];
  const fail = (step: number, message: string): void => {
    if (violations.length === 0) violations.push({ step, message });
  };
  const model: ServerModel = { saved: null };
  let bearerSerial = 0;
  const session: ApiSession = {
    apiBaseUrl: API_BASE,
    bearerToken: `bearer-${seed}-0`,
    canonicalAppUserId: seededUuid(rng),
    provider: rng.pick(['apple', 'google'] as const),
  };
  const appVersion = getRuntimePublicConfig().appVersion;

  const checkEnvelope = (
    step: number,
    req: ReturnType<typeof createFakeFetch>['requests'][number],
    method: string,
    path: string,
  ): void => {
    if (req.url !== `${API_BASE}${path}`) fail(step, `O1 url ${req.url}`);
    if (req.method !== method) fail(step, `O1 method ${req.method}`);
    if (req.headers.Authorization !== `Bearer ${session.bearerToken}`) {
      fail(step, `O1 bearer ${req.headers.Authorization}`);
    }
    if (
      req.headers.Accept !== 'application/json' ||
      req.headers['Content-Type'] !== 'application/json' ||
      req.headers['X-Client-Version'] !== appVersion
    ) {
      fail(step, `O1 headers ${stable(req.headers)}`);
    }
    if (!req.hadSignal) fail(step, 'O1 no abort signal');
  };

  try {
    for (const [step, action] of actions.entries()) {
      let outcome: unknown;
      if (action.kind === 'rotateBearer') {
        bearerSerial += 1;
        session.bearerToken = `bearer-${seed}-${bearerSerial}`;
        outcome = { outcome: 'rotated', serial: bearerSerial };
      } else if (action.kind === 'fetch') {
        const fake = createFakeFetch();
        const planned = planFetch(action.fault, model, rng);
        fake.queue(planned.wire);
        const settled = await settle(
          fetchCanonicalOnboardingProfile(session, fake.fetchFn),
          DEADLINE_MS,
        );
        outcome = describeSettled(settled);
        if (fake.requests.length !== 1)
          fail(step, `O1 expected 1 GET, saw ${fake.requests.length}`);
        const req = fake.requests[0];
        if (req) {
          checkEnvelope(step, req, 'GET', '/v1/me');
          if (req.rawBody !== undefined) fail(step, 'O1 GET carried a body');
        }
        const expectedOutcome =
          planned.expected.outcome === 'resolved'
            ? { outcome: 'resolved', value: planned.expected.value }
            : {
                outcome: 'error',
                name: 'OnboardingSyncError',
                message: planned.expected.message,
              };
        if (stable(outcome) !== stable(expectedOutcome)) {
          fail(
            step,
            `O4/O6 fetch outcome ${stable(outcome)} ≠ expected ${stable(expectedOutcome)}`,
          );
        }
        if (settled.kind === 'resolved' && settled.value) {
          const v = settled.value;
          if (v.focusCheckpoint !== focusForGoal(v.goal))
            fail(
              step,
              `O6 focus ${v.focusCheckpoint} ≠ focusForGoal(${v.goal})`,
            );
          if (
            !v.skillLevel.trim() ||
            !v.goal.trim() ||
            !v.biggestProblem.trim()
          )
            fail(step, 'O6 blank core field hydrated');
          if (
            'firstName' in v &&
            (typeof v.firstName !== 'string' ||
              !v.firstName.trim() ||
              v.firstName !== v.firstName.trim())
          ) {
            fail(
              step,
              `O6 firstName not trimmed/non-blank: ${stable(v.firstName)}`,
            );
          }
          if ('gender' in v && !GENDERS.includes(v.gender as Gender))
            fail(step, `O6 invalid gender ${stable(v.gender)}`);
        }
        if (
          settled.kind === 'rejected' &&
          !(settled.error instanceof OnboardingSyncError)
        ) {
          fail(step, `O7 foreign error ${stable(outcome)}`);
        }
        if (settled.kind === 'stuck') fail(step, 'O7 never settled');
        else if (planned.hang && !settled.pendingBeforeDeadline)
          fail(step, 'O7 stalled GET settled before 15 s');
      } else {
        const fake = createFakeFetch();
        const planned = planSave(action, rng);
        for (const wire of planned.wires) fake.queue(wire);
        const settled = await settle(
          saveCanonicalOnboardingProfile(session, action.profile, fake.fetchFn),
          DEADLINE_MS,
          Math.max(1, planned.hangs),
        );
        outcome = describeSettled(settled);
        if (planned.serverStores) {
          const trimmedName = action.profile.firstName?.trim() || undefined;
          model.saved = serverProfileFor(
            action.profile,
            trimmedName,
            planned.expectedRequests === 2,
          );
        }

        const trimmedName = action.profile.firstName?.trim() || undefined;
        const core = {
          skillLevel: action.profile.skillLevel,
          handedness: action.profile.handedness,
          goal: action.profile.goal,
          biggestProblem: action.profile.biggestProblem,
        };
        const firstBody = {
          ...core,
          ...(trimmedName ? { firstName: trimmedName } : {}),
          ...(action.profile.gender !== undefined
            ? { gender: action.profile.gender }
            : {}),
        };
        if (fake.requests.length !== planned.expectedRequests) {
          fail(
            step,
            `O3 expected ${planned.expectedRequests} PUT(s), saw ${fake.requests.length}`,
          );
        }
        if (
          fake.pending() !== 0 &&
          fake.requests.length === planned.expectedRequests
        ) {
          // Only the retry answer may stay queued when the client (correctly)
          // did not retry; that cannot happen here because wires are sized.
          fail(step, 'harness: unconsumed answer');
        }
        fake.requests.forEach((req, i) => {
          checkEnvelope(step, req, 'PUT', '/v1/me/onboarding');
          const expectedBody = i === 0 ? firstBody : core;
          if (stable(req.body) !== stable(expectedBody)) {
            fail(
              step,
              `O2/O3 PUT#${i + 1} body ${stable(req.body)} ≠ ${stable(expectedBody)}`,
            );
          }
          if (req.rawBody !== undefined) {
            const raw = JSON.parse(req.rawBody) as Record<string, unknown>;
            for (const [k, v] of Object.entries(raw)) {
              if (
                v === undefined ||
                v === null ||
                (typeof v === 'string' && k === 'firstName' && !v.trim())
              ) {
                fail(step, `O2 blank/undefined key on the wire: ${k}`);
              }
            }
          }
        });
        const expectedOutcome =
          planned.expected.outcome === 'resolved'
            ? { outcome: 'resolved', value: planned.expected.value }
            : {
                outcome: 'error',
                name: 'OnboardingSyncError',
                message: planned.expected.message,
              };
        if (stable(outcome) !== stable(expectedOutcome)) {
          fail(
            step,
            `O4/O5 save outcome ${stable(outcome)} ≠ expected ${stable(expectedOutcome)}`,
          );
        }
        if (settled.kind === 'resolved') {
          const v = settled.value;
          if (!CHECKPOINTS.includes(v.focusCheckpoint))
            fail(step, `O5 focus ${v.focusCheckpoint} not a checkpoint`);
          if (
            v.skillLevel !== core.skillLevel ||
            v.handedness !== core.handedness ||
            v.goal !== core.goal ||
            v.biggestProblem !== core.biggestProblem
          ) {
            fail(step, 'O5 core answers changed by save');
          }
          if (v.gender !== action.profile.gender)
            fail(step, 'O5 gender changed by save');
        }
        if (
          settled.kind === 'rejected' &&
          !(settled.error instanceof OnboardingSyncError)
        ) {
          fail(step, `O7 foreign error ${stable(outcome)}`);
        }
        if (settled.kind === 'stuck') fail(step, 'O7 never settled');
        else if (action.first === 'hang' && !settled.pendingBeforeDeadline)
          fail(step, 'O7 stalled PUT settled before 15 s');
      }
      if (action.kind !== 'rotateBearer' && jest.getTimerCount() !== 0) {
        fail(step, `O7 ${jest.getTimerCount()} timer(s) leaked`);
        jest.clearAllTimers();
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
    case 'fetch':
      return `fetch:${action.fault}`;
    case 'save': {
      const trimmed = action.profile.firstName?.trim();
      const identity = Boolean(trimmed) || action.profile.gender !== undefined;
      return `save:${identity ? 'identity' : 'core'}:${action.first}${
        identity && isTransport(action.first) ? `>${action.retry}` : ''
      }`;
    }
    case 'rotateBearer':
      return action.kind;
  }
}

const spec: SequenceSpec<Action> = {
  generate,
  execute,
  describeAction,
  coverageKey,
};

describe('STRESS onboarding account client — seeded randomized sequences', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it(
    'holds O1–O8 on every seeded sequence (see STRESS_* knobs)',
    async () => {
      const config = campaignConfig();
      const output = await runCampaign(
        'onboarding-account-randomized',
        spec,
        config,
      );
      expect(describeFailures(output)).toBe('');
      expect(output.summary.sequencesExecuted).toBe(
        config.onlySeeds?.length ?? config.iterations,
      );
      expect(output.summary.nonDeterministicSeeds).toEqual([]);
    },
    20 * 60_000,
  );
});
