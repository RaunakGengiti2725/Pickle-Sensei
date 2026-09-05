/**
 * STRESS — failure injection — `src/account/onboarding.ts` + its consumer
 * `src/state/appStore.ts` (hydrate / completeOnboarding /
 * completePreAuthOnboarding) over the SQLite `kv` table.
 *
 * Dependencies injected:
 *   fetch   — every catalog fault on GET /v1/me and on BOTH PUT attempts
 *             (the identity-field save and its core-only retry);
 *   SQLite  — a fake `getDb()` whose kv reads/writes can throw, return
 *             corrupted JSON, wrong-shape JSON, or an empty row on demand;
 *   clock   — 15s deadline per request; fake clock advanced 60s;
 *   session — canonical owner vs. a switched / signed-out owner mid-flight.
 *
 * Invariants asserted per iteration:
 *   - every module call settles by its deadline budget with an
 *     `OnboardingSyncError` (or a validated profile) — no raw error, no
 *     silent failure;
 *   - a malformed 2xx never yields a half-parsed profile;
 *   - the store never strands `onboardingBusy`/`hydrated=false`, never
 *     claims success without a server-accepted save, and the kv table is
 *     either untouched or holds exactly the server-accepted JSON (no
 *     corrupted persisted state, pre-auth stash preserved on failure).
 *
 * Replay: `STRESS_SEED=<seed> npx jest __tests__/stress/failureInjection.onboarding`
 */
type KvFault =
  | null
  | 'read_throw'
  | 'write_throw'
  | 'write_throw_after_first'
  | 'read_empty_string';

const mockKv = new Map<string, string>();
let mockKvFault: KvFault = null;
let mockKvWrites = 0;
let mockKvReads = 0;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        mockKvReads += 1;
        if (mockKvFault === 'read_throw') {
          throw new Error('SQLITE_IOERR: disk I/O error');
        }
        if (mockKvFault === 'read_empty_string')
          return { rows: [{ value: '' }] };
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvWrites += 1;
        if (
          mockKvFault === 'write_throw' ||
          (mockKvFault === 'write_throw_after_first' && mockKvWrites > 1)
        ) {
          throw new Error('SQLITE_FULL: database or disk is full');
        }
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import { CHECKPOINTS } from '@pickle/shared-types';
import {
  fetchCanonicalOnboardingProfile,
  OnboardingSyncError,
  saveCanonicalOnboardingProfile,
} from '../../src/account/onboarding';
import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  GUEST_DATA_OWNER,
  profileKeyForOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import { focusForGoal, type Profile } from '../../src/state/profile';
import {
  chance,
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
  type MalformedShape,
} from '../../testing/stress/faultFetch';

const SUITE = 'onboarding';
/** See failureInjection.ui.stress.test.tsx — same defect, store-level view. */
const FINDING_EMPTY_SERVER_MESSAGE = 'F1-empty-server-message-renders-no-copy';
const API_BASE = 'https://api.example.test/functions/v1/api';
const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const sessionA: ApiSession = {
  apiBaseUrl: API_BASE,
  bearerToken: 'token-a',
  canonicalAppUserId: OWNER_A,
  provider: 'apple',
};

const CONNECTION_COPY =
  'Your coaching profile could not be securely saved. Check your connection and try again.';
const GENERIC_HTTP_COPY = 'Your coaching profile could not be securely saved.';
const INVALID_PROFILE_COPY =
  'The account server returned an invalid coaching profile.';
const INVALID_FOCUS_COPY =
  'The account server returned an invalid training focus.';

const SERVER_PROFILE = {
  skill_level: '3.5',
  handedness: 'right',
  primary_goal: 'drops',
  biggest_problem: 'control',
  first_name: 'Dana',
  gender: 'female',
};

function validFetchPayload(): unknown {
  return {
    onboardingState: 'complete',
    profile: SERVER_PROFILE,
    recommendedCheckpoint: 'paddle_set',
  };
}

function validSavePayload(checkpoint = 'contact_position'): unknown {
  return { recommendedCheckpoint: checkpoint };
}

/** 2xx GET bodies. `accepted` = expected parsed result (null = "no
 * profile"). */
function malformedFetch(rng: Rng): MalformedShape {
  return pick(rng, [
    { shape: 'null', payload: null },
    { shape: 'array', payload: [] },
    { shape: 'string', payload: 'ok' },
    { shape: 'empty_object', payload: {} },
    {
      shape: 'state_pending',
      payload: {
        onboardingState: 'pending',
        profile: SERVER_PROFILE,
        recommendedCheckpoint: 'paddle_set',
      },
    },
    {
      shape: 'state_missing',
      payload: { profile: SERVER_PROFILE, recommendedCheckpoint: 'paddle_set' },
    },
    {
      shape: 'profile_null',
      payload: {
        onboardingState: 'complete',
        profile: null,
        recommendedCheckpoint: 'paddle_set',
      },
    },
    {
      shape: 'profile_array',
      payload: {
        onboardingState: 'complete',
        profile: [],
        recommendedCheckpoint: 'paddle_set',
      },
    },
    {
      shape: 'skill_empty',
      payload: {
        onboardingState: 'complete',
        profile: { ...SERVER_PROFILE, skill_level: '' },
        recommendedCheckpoint: 'paddle_set',
      },
    },
    {
      shape: 'skill_number',
      payload: {
        onboardingState: 'complete',
        profile: { ...SERVER_PROFILE, skill_level: 3.5 },
        recommendedCheckpoint: 'paddle_set',
      },
    },
    {
      shape: 'handedness_bogus',
      payload: {
        onboardingState: 'complete',
        profile: { ...SERVER_PROFILE, handedness: 'both' },
        recommendedCheckpoint: 'paddle_set',
      },
    },
    {
      shape: 'goal_missing',
      payload: {
        onboardingState: 'complete',
        profile: {
          skill_level: '3.5',
          handedness: 'right',
          biggest_problem: 'x',
        },
        recommendedCheckpoint: 'paddle_set',
      },
    },
    {
      shape: 'problem_whitespace',
      payload: {
        onboardingState: 'complete',
        profile: { ...SERVER_PROFILE, biggest_problem: '   ' },
        recommendedCheckpoint: 'paddle_set',
      },
    },
    {
      shape: 'checkpoint_bogus',
      payload: {
        onboardingState: 'complete',
        profile: SERVER_PROFILE,
        recommendedCheckpoint: 'bogus',
      },
    },
    {
      shape: 'checkpoint_number',
      payload: {
        onboardingState: 'complete',
        profile: SERVER_PROFILE,
        recommendedCheckpoint: 3,
      },
    },
    {
      shape: 'checkpoint_missing',
      payload: { onboardingState: 'complete', profile: SERVER_PROFILE },
    },
    {
      shape: 'first_name_number',
      payload: {
        onboardingState: 'complete',
        profile: { ...SERVER_PROFILE, first_name: 7 },
        recommendedCheckpoint: 'paddle_set',
      },
    },
    {
      shape: 'gender_bogus',
      payload: {
        onboardingState: 'complete',
        profile: { ...SERVER_PROFILE, gender: 'robot' },
        recommendedCheckpoint: 'paddle_set',
      },
    },
    {
      shape: 'identity_nulls_valid',
      payload: {
        onboardingState: 'complete',
        profile: { ...SERVER_PROFILE, first_name: null, gender: null },
        recommendedCheckpoint: 'paddle_set',
      },
    },
    {
      shape: 'identity_missing_valid',
      payload: {
        onboardingState: 'complete',
        profile: {
          skill_level: '3.5',
          handedness: 'left',
          primary_goal: 'g',
          biggest_problem: 'p',
        },
        recommendedCheckpoint: 'ready_position',
      },
    },
    {
      shape: 'first_name_padded_valid',
      payload: {
        onboardingState: 'complete',
        profile: { ...SERVER_PROFILE, first_name: '  Dana  ' },
        recommendedCheckpoint: 'paddle_set',
      },
    },
    {
      shape: 'first_name_blank_valid',
      payload: {
        onboardingState: 'complete',
        profile: { ...SERVER_PROFILE, first_name: '   ' },
        recommendedCheckpoint: 'paddle_set',
      },
    },
  ]);
}

function malformedSave(rng: Rng): MalformedShape {
  return pick(rng, [
    { shape: 'null', payload: null },
    { shape: 'array', payload: [] },
    { shape: 'string', payload: 'saved' },
    { shape: 'empty_object', payload: {} },
    { shape: 'checkpoint_bogus', payload: { recommendedCheckpoint: 'bogus' } },
    { shape: 'checkpoint_number', payload: { recommendedCheckpoint: 3 } },
    { shape: 'checkpoint_null', payload: { recommendedCheckpoint: null } },
    { shape: 'checkpoint_empty', payload: { recommendedCheckpoint: '' } },
    { shape: 'nested_profile_only', payload: { profile: SERVER_PROFILE } },
    {
      shape: 'checkpoint_valid_other',
      payload: { recommendedCheckpoint: 'follow_through' },
    },
  ]);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}
function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Reference parser for GET /v1/me (wire contract: identity fields are
 * optional and silently dropped when unusable; the focus checkpoint is
 * derived from the goal, the server recommendation is not read here). */
function referenceFetchProfile(payload: unknown): Profile | null {
  if (!isRecord(payload) || payload['onboardingState'] !== 'complete')
    return null;
  const p = payload['profile'];
  if (!isRecord(p)) return null;
  if (
    !nonEmpty(p['skill_level']) ||
    !['right', 'left', 'ambidextrous'].includes(String(p['handedness'])) ||
    !nonEmpty(p['primary_goal']) ||
    !nonEmpty(p['biggest_problem'])
  ) {
    return null;
  }
  const fn = p['first_name'];
  const g = p['gender'];
  const genderOk = GENDERS.includes(String(g));
  return {
    ...(typeof fn === 'string' && fn.trim() ? { firstName: fn.trim() } : {}),
    ...(genderOk ? { gender: g as NonNullable<Profile['gender']> } : {}),
    skillLevel: p['skill_level'] as string,
    handedness: p['handedness'] as Profile['handedness'],
    goal: p['primary_goal'] as string,
    biggestProblem: p['biggest_problem'] as string,
    focusCheckpoint: focusForGoal(p['primary_goal'] as string),
  };
}
const GENDERS = ['female', 'male', 'nonbinary', 'prefer_not_to_say'];

function referenceSaveCheckpoint(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const cp = payload['recommendedCheckpoint'];
  return (CHECKPOINTS as readonly string[]).includes(String(cp))
    ? String(cp)
    : null;
}

function drawLocalProfile(rng: Rng): Profile {
  const withIdentity = chance(rng, 0.6);
  return {
    skillLevel: pick(rng, ['2.5', '3.0', '3.5', '4.0+']),
    handedness: pick(rng, ['right', 'left', 'ambidextrous'] as const),
    goal: pick(rng, ['drops', 'drives', 'consistency']),
    biggestProblem: pick(rng, ['control', 'power', 'footwork']),
    focusCheckpoint: pick(rng, CHECKPOINTS),
    ...(withIdentity
      ? {
          firstName: pick(rng, ['Dana', '  Sam ', '']),
          gender: pick(rng, [
            'female',
            'male',
            'nonbinary',
            'prefer_not_to_say',
          ] as const),
        }
      : {}),
  };
}

function hasIdentity(profile: Profile): boolean {
  return (
    (typeof profile.firstName === 'string' &&
      profile.firstName.trim().length > 0) ||
    typeof profile.gender === 'string'
  );
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  mockKv.clear();
  mockKvFault = null;
  mockKvWrites = 0;
  mockKvReads = 0;
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  clearApiSession();
});

// ─── module: GET /v1/me ────────────────────────────────────────────────────

describe('onboarding.fetchCanonicalOnboardingProfile — injected fetch faults', () => {
  const scenario = 'onboarding.fetch';
  const cases = scenarioCases(scenario);
  it.each(cases)(
    'seed %d (iteration %d) settles with a typed error, a validated profile, or null',
    async (seed, iteration) => {
      const rng = seededRandom(seed);
      const fault = drawFault(
        rng,
        iteration,
        validFetchPayload(),
        malformedFetch,
      );
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: fault.id,
          inputs: { fault },
        },
        async () => {
          const transport = faultFetch([fault]);
          const settlement = probe(
            fetchCanonicalOnboardingProfile(sessionA, transport.fetch),
          );
          await jest.advanceTimersByTimeAsync(60_000);
          const observed: Record<string, unknown> = {
            settled: settlement.settled,
            resolved: settlement.resolved,
            settledAfterMs: settlement.settledAfterMs,
            aborted: transport.calls[0]?.aborted ?? null,
            timersLeft: jest.getTimerCount(),
            value: settlement.resolved ? settlement.value : undefined,
            error:
              settlement.settled && !settlement.resolved
                ? describeError(settlement.error)
                : null,
          };
          expect(jest.getTimerCount()).toBe(0);
          if (!fault.realistic) {
            if (settlement.resolved && settlement.value !== null) {
              expect(settlement.value).toEqual(
                referenceFetchProfile(fault.payload),
              );
            }
            const bypasses =
              !settlement.settled ||
              (settlement.settledAfterMs ?? 0) > REQUEST_DEADLINE_MS;
            return {
              observed: { ...observed, bypassesDeadline: bypasses },
              classification:
                bypasses ||
                (settlement.settled &&
                  !settlement.resolved &&
                  !(settlement.error instanceof OnboardingSyncError))
                  ? 'KNOWN_LIMIT'
                  : 'HELD',
            };
          }
          expect(settlement.settled).toBe(true);
          expect(transport.calls).toHaveLength(1);
          const call = transport.calls[0]!;
          expect(call.url).toBe(`${API_BASE}/v1/me`);
          expect(call.hadSignal).toBe(true);
          expect(settlement.settledAfterMs!).toBeLessThanOrEqual(
            REQUEST_DEADLINE_MS,
          );
          if (transportFailureExpected(fault)) {
            expect(settlement.resolved).toBe(false);
            expect(settlement.error).toBeInstanceOf(OnboardingSyncError);
            expect((settlement.error as Error).message).toBe(CONNECTION_COPY);
            const onDeadline =
              fault.kind === 'hang_until_abort' ||
              (fault.delayMs ?? 0) >= REQUEST_DEADLINE_MS;
            expect(call.aborted).toBe(onDeadline);
            return { observed };
          }
          expect(call.aborted).toBe(false);
          if (fault.kind === 'http_error') {
            expect(settlement.resolved).toBe(false);
            expect(settlement.error).toBeInstanceOf(OnboardingSyncError);
            expect((settlement.error as Error).message).toBe(
              expectedServerMessage(fault) ?? GENERIC_HTTP_COPY,
            );
            return {
              observed: {
                ...observed,
                status401MaskedAsGeneric: fault.status === 401,
              },
            };
          }
          // 2xx: ok / slow_ok(<deadline) / ok_malformed / ok_json_throws
          expect(settlement.resolved).toBe(true);
          const reference =
            fault.kind === 'ok_json_throws'
              ? null
              : referenceFetchProfile(fault.payload);
          expect(settlement.value).toEqual(reference);
          const malformedTreatedAsNoProfile =
            reference === null && fault.kind !== 'ok';
          return {
            observed: { ...observed, malformedTreatedAsNoProfile },
            // A 2xx body that is not a profile is indistinguishable from
            // "no profile yet": the caller re-asks the questionnaire instead
            // of showing the retry state. Recorded as a known limit of the
            // wire contract, see findings.
            classification: malformedTreatedAsNoProfile
              ? 'KNOWN_LIMIT'
              : 'HELD',
          };
        },
      );
    },
  );
});

// ─── module: PUT /v1/me/onboarding (+ core-only retry) ─────────────────────

describe('onboarding.saveCanonicalOnboardingProfile — injected fetch faults on both attempts', () => {
  const scenario = 'onboarding.save';
  const cases = scenarioCases(scenario);
  it.each(cases)(
    'seed %d (iteration %d) settles honestly across the identity save and the core retry',
    async (seed, iteration) => {
      const rng = seededRandom(seed);
      const profile = drawLocalProfile(rng);
      const first = drawFault(
        rng,
        iteration,
        validSavePayload(),
        malformedSave,
      );
      // second attempt: independent draw (skewed towards ok so the retry path
      // is exercised) — only reached when the first attempt fails AND the
      // profile carries identity fields.
      const second = chance(rng, 0.5)
        ? okFault(validSavePayload('swing_length'))
        : drawFault(
            rng,
            Math.floor(rng() * 1000),
            validSavePayload('swing_length'),
            malformedSave,
          );
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: `${first.id}|${second.id}`,
          inputs: { profile, first, second },
        },
        async () => {
          const transport = faultFetch([first, second]);
          const settlement = probe(
            saveCanonicalOnboardingProfile(sessionA, profile, transport.fetch),
          );
          await jest.advanceTimersByTimeAsync(60_000);
          const observed: Record<string, unknown> = {
            settled: settlement.settled,
            resolved: settlement.resolved,
            settledAfterMs: settlement.settledAfterMs,
            calls: transport.calls.length,
            bodies: transport.calls.map(c =>
              c.init?.body ? JSON.parse(String(c.init.body)) : null,
            ),
            timersLeft: jest.getTimerCount(),
            value: settlement.resolved ? settlement.value : undefined,
            error:
              settlement.settled && !settlement.resolved
                ? describeError(settlement.error)
                : null,
          };
          expect(jest.getTimerCount()).toBe(0);
          const retryExpected = hasIdentity(profile);
          const body0 = observed['bodies'] as Array<Record<
            string,
            unknown
          > | null>;
          const coreBody = {
            skillLevel: profile.skillLevel,
            handedness: profile.handedness,
            goal: profile.goal,
            biggestProblem: profile.biggestProblem,
          };
          const trimmedName = profile.firstName?.trim();
          const saved = (checkpoint: string): Profile => ({
            ...profile,
            ...(trimmedName ? { firstName: trimmedName } : {}),
            focusCheckpoint: checkpoint as Profile['focusCheckpoint'],
          });
          // wire shape of attempt 1: core fields always, identity only when present
          expect(body0[0]).toEqual({
            ...coreBody,
            ...(trimmedName ? { firstName: trimmedName } : {}),
            ...(profile.gender !== undefined ? { gender: profile.gender } : {}),
          });

          if (
            !first.realistic ||
            (transport.calls.length === 2 && !second.realistic)
          ) {
            if (settlement.resolved) {
              const v = settlement.value as Profile;
              expect(
                (CHECKPOINTS as readonly string[]).includes(v.focusCheckpoint),
              ).toBe(true);
            }
            const bypasses =
              !settlement.settled ||
              (settlement.settledAfterMs ?? 0) > 2 * REQUEST_DEADLINE_MS;
            return {
              observed: { ...observed, bypassesDeadline: bypasses },
              classification:
                bypasses ||
                (settlement.settled &&
                  !settlement.resolved &&
                  !(settlement.error instanceof OnboardingSyncError))
                  ? 'KNOWN_LIMIT'
                  : 'HELD',
            };
          }

          expect(settlement.settled).toBe(true);
          // Budget: one deadline per attempt.
          expect(settlement.settledAfterMs!).toBeLessThanOrEqual(
            retryExpected ? 2 * REQUEST_DEADLINE_MS : REQUEST_DEADLINE_MS,
          );

          const firstCheckpoint =
            first.kind === 'ok' ||
            first.kind === 'ok_malformed' ||
            (first.kind === 'slow_ok' &&
              (first.delayMs ?? 0) < REQUEST_DEADLINE_MS)
              ? referenceSaveCheckpoint(first.payload)
              : null;
          const firstAccepted2xx =
            first.kind === 'ok' ||
            first.kind === 'ok_malformed' ||
            first.kind === 'ok_json_throws' ||
            (first.kind === 'slow_ok' &&
              (first.delayMs ?? 0) < REQUEST_DEADLINE_MS);

          if (firstAccepted2xx) {
            expect(transport.calls).toHaveLength(1);
            if (firstCheckpoint) {
              expect(settlement.resolved).toBe(true);
              expect(settlement.value).toEqual(saved(firstCheckpoint));
              return { observed };
            }
            // 2xx without a usable recommendation: the module must not
            // invent one.
            expect(settlement.resolved).toBe(false);
            expect(settlement.error).toBeInstanceOf(OnboardingSyncError);
            expect((settlement.error as Error).message).toBe(
              isRecord(first.payload) && first.kind !== 'ok_json_throws'
                ? INVALID_FOCUS_COPY
                : INVALID_PROFILE_COPY,
            );
            return {
              observed: {
                ...observed,
                serverSavedButClientReportsFailure: true,
              },
            };
          }

          // First attempt failed (transport or HTTP).
          const firstMessage = transportFailureExpected(first)
            ? CONNECTION_COPY
            : (expectedServerMessage(first) ?? GENERIC_HTTP_COPY);
          if (!retryExpected) {
            expect(transport.calls).toHaveLength(1);
            expect(settlement.resolved).toBe(false);
            expect(settlement.error).toBeInstanceOf(OnboardingSyncError);
            expect((settlement.error as Error).message).toBe(firstMessage);
            return { observed };
          }
          expect(transport.calls).toHaveLength(2);
          expect(body0[1]).toEqual(coreBody);
          const retriedAfterStatus =
            first.kind === 'http_error' ? first.status : null;
          const secondCheckpoint =
            second.kind === 'ok' ||
            second.kind === 'ok_malformed' ||
            (second.kind === 'slow_ok' &&
              (second.delayMs ?? 0) < REQUEST_DEADLINE_MS)
              ? referenceSaveCheckpoint(second.payload)
              : null;
          const secondAccepted2xx =
            second.kind === 'ok' ||
            second.kind === 'ok_malformed' ||
            second.kind === 'ok_json_throws' ||
            (second.kind === 'slow_ok' &&
              (second.delayMs ?? 0) < REQUEST_DEADLINE_MS);
          const extra = {
            retriedAfterStatus,
            retriedAfterTimeout:
              transportFailureExpected(first) &&
              (first.kind === 'hang_until_abort' ||
                (first.delayMs ?? 0) >= REQUEST_DEADLINE_MS),
            totalWaitMs: settlement.settledAfterMs,
          };
          if (secondAccepted2xx) {
            if (secondCheckpoint) {
              expect(settlement.resolved).toBe(true);
              // The retry saved core fields only; the local profile keeps its
              // identity fields (server just never received them).
              expect(settlement.value).toEqual(saved(secondCheckpoint));
              return {
                observed: {
                  ...observed,
                  ...extra,
                  identityDroppedServerSide: true,
                },
              };
            }
            expect(settlement.resolved).toBe(false);
            expect((settlement.error as Error).message).toBe(
              isRecord(second.payload) && second.kind !== 'ok_json_throws'
                ? INVALID_FOCUS_COPY
                : INVALID_PROFILE_COPY,
            );
            return {
              observed: {
                ...observed,
                ...extra,
                serverSavedButClientReportsFailure: true,
              },
            };
          }
          // both failed: the FIRST error is what the user sees.
          expect(settlement.resolved).toBe(false);
          expect(settlement.error).toBeInstanceOf(OnboardingSyncError);
          expect((settlement.error as Error).message).toBe(firstMessage);
          return { observed: { ...observed, ...extra } };
        },
      );
    },
  );
});

// ─── consumer: appStore over SQLite kv ─────────────────────────────────────

type LocalProfileKv =
  | 'none'
  | 'valid'
  | 'corrupt_json'
  | 'wrong_shape_object'
  | 'wrong_shape_string'
  | 'wrong_shape_null'
  | 'wrong_shape_array';
type PendingKv = 'none' | 'valid' | 'corrupt_json' | 'wrong_shape';

function seedKv(
  rng: Rng,
  local: LocalProfileKv,
  pending: PendingKv,
  owner: string,
  profile: Profile,
) {
  const key = profileKeyForOwner(owner);
  switch (local) {
    case 'none':
      break;
    case 'valid':
      mockKv.set(key, JSON.stringify(profile));
      break;
    case 'corrupt_json':
      mockKv.set(key, '{"skillLevel":"3.5",');
      break;
    case 'wrong_shape_object':
      mockKv.set(key, '{}');
      break;
    case 'wrong_shape_string':
      mockKv.set(key, '"3.5"');
      break;
    case 'wrong_shape_null':
      mockKv.set(key, 'null');
      break;
    case 'wrong_shape_array':
      mockKv.set(key, '[]');
      break;
  }
  switch (pending) {
    case 'none':
      break;
    case 'valid':
      mockKv.set(
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({ version: 1, profile: drawLocalProfile(rng) }),
      );
      break;
    case 'corrupt_json':
      mockKv.set(PENDING_ONBOARDING_PROFILE_KV_KEY, '{"version":1,');
      break;
    case 'wrong_shape':
      mockKv.set(
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({ version: 1, profile: { skillLevel: 3 } }),
      );
      break;
  }
}

function isValidProfileJson(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  try {
    const p = JSON.parse(raw) as unknown;
    return (
      isRecord(p) &&
      nonEmpty(p['skillLevel']) &&
      ['right', 'left', 'ambidextrous'].includes(String(p['handedness'])) &&
      nonEmpty(p['goal']) &&
      nonEmpty(p['biggestProblem']) &&
      (CHECKPOINTS as readonly string[]).includes(String(p['focusCheckpoint']))
    );
  } catch {
    return false;
  }
}

describe('appStore.hydrate — kv + canonical fetch/save faults', () => {
  const scenario = 'appStore.hydrate';
  const cases = scenarioCases(scenario);
  const locals: LocalProfileKv[] = [
    'none',
    'none',
    'none',
    'valid',
    'corrupt_json',
    'wrong_shape_object',
    'wrong_shape_string',
    'wrong_shape_null',
    'wrong_shape_array',
  ];
  const pendings: PendingKv[] = [
    'none',
    'none',
    'valid',
    'corrupt_json',
    'wrong_shape',
  ];
  const kvFaults: KvFault[] = [
    null,
    null,
    null,
    null,
    'read_throw',
    'write_throw',
    'read_empty_string',
  ];
  it.each(cases)(
    'seed %d (iteration %d) hydrates to a recoverable state without corrupting kv',
    async (seed, iteration) => {
      const rng = seededRandom(seed);
      const local = pick(rng, locals);
      const pending = pick(rng, pendings);
      const kvFault = pick(rng, kvFaults);
      const getFault = drawFault(
        rng,
        iteration,
        validFetchPayload(),
        malformedFetch,
      );
      const putFault = drawFault(
        rng,
        Math.floor(rng() * 1000),
        validSavePayload(),
        malformedSave,
      );
      const switchOwnerMidFlight = chance(rng, 0.15);
      const localProfile = drawLocalProfile(rng);
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: `kv:${kvFault ?? 'ok'}/local:${local}/pending:${pending}/get:${getFault.id}/put:${putFault.id}${switchOwnerMidFlight ? '/switch' : ''}`,
          inputs: {
            local,
            pending,
            kvFault,
            getFault,
            putFault,
            switchOwnerMidFlight,
            localProfile,
          },
        },
        async () => {
          seedKv(rng, local, pending, OWNER_A, localProfile);
          const kvBefore = new Map(mockKv);
          mockKvFault = kvFault;
          establishApiSession(sessionA);
          setActiveDataOwner(OWNER_A);
          // GET on /v1/me first (when no local profile), PUT for the stash.
          const transport = faultFetch(
            local === 'none' ? [getFault, putFault] : [putFault],
          );
          globalThis.fetch = transport.fetch as typeof fetch;
          const settlement = probe(useAppStore.getState().hydrate());
          // hydrate() has synchronously published `hydrated=false` for A and
          // is awaiting its first kv read: switch the owner underneath it.
          if (switchOwnerMidFlight) setActiveDataOwner(OWNER_B);
          await jest.advanceTimersByTimeAsync(60_000);
          const state = useAppStore.getState();
          const kvAfter = new Map(mockKv);
          const observed: Record<string, unknown> = {
            settled: settlement.settled,
            hydrated: state.hydrated,
            ownerKey: state.ownerKey,
            profile: state.profile,
            hydrateError: state.hydrateError,
            onboardingBusy: state.onboardingBusy,
            fetchCalls: transport.calls.map(
              c => `${c.init?.method ?? 'GET'} ${c.url.replace(API_BASE, '')}`,
            ),
            kvReads: mockKvReads,
            kvWrites: mockKvWrites,
            kvProfileAfter: kvAfter.get(profileKeyForOwner(OWNER_A)) ?? null,
            kvPendingAfter:
              kvAfter.get(PENDING_ONBOARDING_PROFILE_KV_KEY) ?? null,
            timersLeft: jest.getTimerCount(),
          };
          expect(jest.getTimerCount()).toBe(0);

          const anyNonRealisticHang =
            transport.calls.length > 0 &&
            transport.calls.some((_c, i) => {
              const f = local === 'none' ? [getFault, putFault][i] : putFault;
              return (
                f &&
                !f.realistic &&
                (f.kind === 'hang_ignore_abort' || f.kind === 'body_stall')
              );
            });
          if (anyNonRealisticHang && !settlement.settled) {
            // Fetch that ignores abort: hydrate never completes (launch gate
            // keeps its splash). Recorded; the kv table is untouched.
            expect(kvAfter.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe(
              kvBefore.get(PENDING_ONBOARDING_PROFILE_KV_KEY),
            );
            return { observed, classification: 'KNOWN_LIMIT' };
          }
          expect(settlement.settled).toBe(true);
          expect(settlement.resolved).toBe(true); // hydrate never rejects

          if (switchOwnerMidFlight) {
            // A stale hydrate must not publish OWNER_A's data under OWNER_B.
            expect(state.ownerKey === OWNER_A && state.hydrated).toBe(false);
            return { observed: { ...observed, staleHydrateSuppressed: true } };
          }

          // No infinite spinner: the launch gate needs hydrated=true.
          expect(state.hydrated).toBe(true);
          expect(state.ownerKey).toBe(OWNER_A);

          // Persisted-state discipline: the profile kv row is either
          // untouched or valid profile JSON; the stash is only cleared after
          // a successful adoption.
          const profileRowBefore = kvBefore.get(profileKeyForOwner(OWNER_A));
          const profileRowAfter = kvAfter.get(profileKeyForOwner(OWNER_A));
          if (profileRowAfter !== profileRowBefore) {
            expect(isValidProfileJson(profileRowAfter)).toBe(true);
          }
          const pendingBefore = kvBefore.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
          const pendingAfter = kvAfter.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
          if (pendingBefore !== undefined && pendingAfter !== pendingBefore) {
            expect(pendingAfter).toBe('');
            expect(pending).toBe('valid');
            expect(isValidProfileJson(profileRowAfter)).toBe(true);
            expect(state.profile).toEqual(JSON.parse(profileRowAfter!));
          }

          if (kvFault === 'read_throw') {
            expect(state.profile).toBeNull();
            expect(typeof state.hydrateError).toBe('string');
            expect(transport.calls).toHaveLength(0);
            return {
              observed: {
                ...observed,
                rawSqliteMessageSurfaced:
                  state.hydrateError!.includes('SQLITE'),
              },
            };
          }

          if (state.hydrateError) {
            // Failure state is visible + retryable (App.tsx ErrorState with
            // onRetry → hydrate), and never paired with a profile.
            expect(state.profile).toBeNull();
            const canonicalFailure =
              state.hydrateError === CANONICAL_PROFILE_UNAVAILABLE_MESSAGE;
            return {
              observed: {
                ...observed,
                canonicalFailure,
                rawParserMessageSurfaced:
                  !canonicalFailure && local === 'corrupt_json',
              },
            };
          }

          // hydrated without error: either a profile or an honest null.
          if (state.profile !== null) {
            const validShape = isValidProfileJson(
              JSON.stringify(state.profile),
            );
            return {
              observed: { ...observed, profileShapeValid: validShape },
              // A wrong-shape local row hydrates as a "profile" the gate
              // trusts; recorded as a known limit (see findings).
              classification: validShape ? 'HELD' : 'KNOWN_LIMIT',
            };
          }
          // null profile → questionnaire. Honest only if the server said
          // "no profile" (or the kv row was empty and no session fetch ran).
          const getReference =
            local === 'none' && transport.calls.length > 0
              ? getFault.kind === 'ok_json_throws'
                ? null
                : referenceFetchProfile(getFault.payload)
              : null;
          const reAskedOnMalformed2xx =
            local === 'none' &&
            transport.calls.length > 0 &&
            getReference === null &&
            getFault.kind !== 'ok' &&
            !transportFailureExpected(getFault) &&
            getFault.kind !== 'http_error';
          return {
            observed: { ...observed, reAskedOnMalformed2xx },
            classification: reAskedOnMalformed2xx ? 'KNOWN_LIMIT' : 'HELD',
          };
        },
      );
    },
  );
});

describe('appStore.completeOnboarding — save + kv write faults', () => {
  const scenario = 'appStore.completeOnboarding';
  const cases = scenarioCases(scenario);
  const kvFaults: KvFault[] = [null, null, null, 'write_throw'];
  it.each(cases)(
    'seed %d (iteration %d) never claims success without a server-accepted save',
    async (seed, iteration) => {
      const rng = seededRandom(seed);
      const profile = drawLocalProfile(rng);
      const first = drawFault(
        rng,
        iteration,
        validSavePayload(),
        malformedSave,
      );
      const second = chance(rng, 0.5)
        ? okFault(validSavePayload('swing_length'))
        : drawFault(
            rng,
            Math.floor(rng() * 1000),
            validSavePayload('swing_length'),
            malformedSave,
          );
      const kvFault = pick(rng, kvFaults);
      const owner = chance(rng, 0.15) ? GUEST_DATA_OWNER : OWNER_A;
      const switchMidFlight = chance(rng, 0.15);
      const priorProfile = chance(rng, 0.5) ? drawLocalProfile(rng) : null;
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: `kv:${kvFault ?? 'ok'}/put:${first.id}|${second.id}/owner:${owner === OWNER_A ? 'canonical' : 'guest'}${switchMidFlight ? '/switch' : ''}`,
          inputs: {
            profile,
            first,
            second,
            kvFault,
            owner,
            switchMidFlight,
            priorProfile,
          },
        },
        async () => {
          if (owner === OWNER_A) establishApiSession(sessionA);
          setActiveDataOwner(owner);
          if (priorProfile)
            mockKv.set(profileKeyForOwner(owner), JSON.stringify(priorProfile));
          const kvBefore = new Map(mockKv);
          useAppStore.setState({
            hydrated: true,
            ownerKey: owner,
            profile: priorProfile,
            hydrateError: null,
          });
          mockKvFault = kvFault;
          const transport = faultFetch([first, second]);
          globalThis.fetch = transport.fetch as typeof fetch;
          const settlement = probe(
            useAppStore.getState().completeOnboarding(profile),
          );
          const busyMidFlight = useAppStore.getState().onboardingBusy;
          if (switchMidFlight)
            setActiveDataOwner(
              GUEST_DATA_OWNER === owner ? OWNER_B : GUEST_DATA_OWNER,
            );
          await jest.advanceTimersByTimeAsync(60_000);
          const state = useAppStore.getState();
          const kvAfter = new Map(mockKv);
          const rowAfter = kvAfter.get(profileKeyForOwner(owner));
          const observed: Record<string, unknown> = {
            settled: settlement.settled,
            busyMidFlight,
            onboardingBusy: state.onboardingBusy,
            onboardingError: state.onboardingError,
            profile: state.profile,
            fetchCalls: transport.calls.length,
            kvWrites: mockKvWrites,
            kvRowAfter: rowAfter ?? null,
            timersLeft: jest.getTimerCount(),
          };
          expect(jest.getTimerCount()).toBe(0);
          const faultsInPlay = transport.calls.map(
            (_c, i) => [first, second][i]!,
          );
          const nonRealisticHang = faultsInPlay.some(
            f =>
              !f.realistic &&
              (f.kind === 'hang_ignore_abort' || f.kind === 'body_stall'),
          );
          if (nonRealisticHang && !settlement.settled) {
            expect(state.onboardingBusy).toBe(true);
            expect(rowAfter).toBe(kvBefore.get(profileKeyForOwner(owner)));
            return { observed, classification: 'KNOWN_LIMIT' };
          }
          expect(settlement.settled).toBe(true);
          expect(settlement.resolved).toBe(true); // completeOnboarding never rejects

          // kv discipline: unchanged, or exactly the profile that was
          // published with a server-validated checkpoint.
          if (rowAfter !== kvBefore.get(profileKeyForOwner(owner))) {
            expect(isValidProfileJson(rowAfter)).toBe(true);
            const stored = JSON.parse(rowAfter!) as Profile;
            const trimmed = profile.firstName?.trim();
            expect({
              ...stored,
              focusCheckpoint: profile.focusCheckpoint,
            }).toEqual({
              ...profile,
              ...(owner === OWNER_A && trimmed ? { firstName: trimmed } : {}),
            });
          }

          if (switchMidFlight) {
            // Stale completion: state must not be published for the old
            // owner under the new one; busy flag is whatever the new owner's
            // hydrate will reset — record it.
            expect(state.profile).toBe(priorProfile);
            return {
              observed: { ...observed, staleBusyLeft: state.onboardingBusy },
              classification: state.onboardingBusy ? 'KNOWN_LIMIT' : 'HELD',
            };
          }

          // No stuck spinner on the onboarding footer.
          expect(state.onboardingBusy).toBe(false);

          if (state.onboardingError === null) {
            // Success claimed: kv holds it and (for canonical) the server
            // accepted it with a valid checkpoint.
            expect(state.profile).not.toBeNull();
            expect(isValidProfileJson(rowAfter)).toBe(true);
            expect(JSON.stringify(state.profile)).toBe(rowAfter);
            if (owner === OWNER_A) {
              expect(transport.calls.length).toBeGreaterThanOrEqual(1);
            } else {
              expect(transport.calls).toHaveLength(0);
              expect(state.profile).toEqual(profile);
            }
            return { observed };
          }
          // Failure: visible copy, prior profile untouched in state, and
          // either kv untouched (save failed) or kv/server ahead of state
          // (kv write failed AFTER a server-accepted save — recoverable via
          // hydrate; recorded).
          expect(typeof state.onboardingError).toBe('string');
          expect(state.profile).toEqual(priorProfile);
          if (state.onboardingError === '') {
            // F1: `{error:{message:""}}` on a non-2xx is a string, so
            // onboarding.ts surfaces it verbatim; OnboardingScreen renders
            // `onboardingError ? <Text/> : null` → nothing visible.
            expect(
              faultsInPlay.some(
                f =>
                  f.kind === 'http_error' &&
                  f.bodyKind === 'json_error_message_empty',
              ),
            ).toBe(true);
            return {
              observed,
              classification: 'BROKEN',
              finding: FINDING_EMPTY_SERVER_MESSAGE,
            };
          }
          expect(state.onboardingError!.length).toBeGreaterThan(0);
          const serverAcceptedButKvFailed =
            kvFault === 'write_throw' &&
            state.onboardingError!.includes('SQLITE');
          return {
            observed: {
              ...observed,
              serverAcceptedButKvFailed,
              rawSqliteMessageSurfaced:
                state.onboardingError!.includes('SQLITE'),
            },
          };
        },
      );
    },
  );
});

describe('appStore.completePreAuthOnboarding — kv write faults', () => {
  const scenario = 'appStore.completePreAuthOnboarding';
  const cases = scenarioCases(scenario);
  const kvFaults: KvFault[] = [null, 'write_throw', 'read_throw'];
  it.each(cases)(
    'seed %d (iteration %d) returns false and shows copy when the stash cannot be written',
    async (seed, iteration) => {
      const rng = seededRandom(seed);
      const profile = drawLocalProfile(rng);
      const kvFault = kvFaults[iteration % kvFaults.length]!;
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: `kv:${kvFault ?? 'ok'}`,
          inputs: { profile, kvFault },
        },
        async () => {
          mockKvFault = kvFault;
          const settlement = probe(
            useAppStore.getState().completePreAuthOnboarding(profile),
          );
          await jest.advanceTimersByTimeAsync(60_000);
          const state = useAppStore.getState();
          const stash = mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
          const observed = {
            settled: settlement.settled,
            returned: settlement.value,
            onboardingBusy: state.onboardingBusy,
            onboardingError: state.onboardingError,
            stash: stash ?? null,
          };
          expect(settlement.settled).toBe(true);
          expect(state.onboardingBusy).toBe(false);
          if (kvFault === 'write_throw') {
            expect(settlement.value).toBe(false);
            expect(typeof state.onboardingError).toBe('string');
            expect(stash).toBeUndefined();
            return {
              observed: {
                ...observed,
                rawSqliteMessageSurfaced:
                  state.onboardingError!.includes('SQLITE'),
              },
            };
          }
          expect(settlement.value).toBe(true);
          expect(state.onboardingError).toBeNull();
          expect(JSON.parse(stash!)).toEqual({ version: 1, profile });
          return { observed };
        },
      );
    },
  );
});
