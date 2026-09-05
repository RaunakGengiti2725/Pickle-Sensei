/// <reference types="node" />
/**
 * BOUNDARY/MALFORMED stress runner for the account module
 * (deletion + consentApi + onboarding). Each iteration is a pure function of
 * its integer seed: pick a target, a transport behaviour (real `Response`
 * with generated status/body text, or a rejected fetch), and hostile direct
 * arguments; invoke the module; judge the outcome against the invariants:
 *
 *   1. the call either resolves to a shape-valid result or rejects with the
 *      module's typed error class — nothing else escapes;
 *   2. every outgoing request goes to the expected URL/method with the bearer
 *      in the Authorization header, a JSON-parseable body, and no more calls
 *      than the contract allows (no retry storms, no extra writes);
 *   3. `Object.prototype` / `Array.prototype` are unchanged afterwards.
 *
 * Results are written as a JSON table (seed → outcome) under
 * `artifacts/stress/account-boundary-malformed/` (git-ignored).
 */
import fs from 'node:fs';
import path from 'node:path';

import { CHECKPOINTS } from '@pickle/shared-types';
import type { ApiSession } from '../../src/account/apiSession';
import {
  AccountDeletionError,
  confirmAccountDeletion,
  requestAccountDeletion,
  type AccountDeletionSurvey,
} from '../../src/account/deletion';
import {
  ConsentApiError,
  fetchConsentStatus,
  grantEvaluationTelemetryConsent,
  grantModelTrainingConsent,
  withdrawEvaluationTelemetryConsent,
  withdrawModelTrainingConsent,
} from '../../src/account/consentApi';
import {
  OnboardingSyncError,
  fetchCanonicalOnboardingProfile,
  saveCanonicalOnboardingProfile,
} from '../../src/account/onboarding';
import type { Profile } from '../../src/state/profile';
import {
  HTTP_STATUSES,
  POLLUTION_KEYS,
  POLLUTION_SENTINEL,
  bigString,
  bodyText,
  digest,
  hostileString,
  mutateRecord,
  wrongTypeValue,
  type BodyTextKind,
} from './generators';
import { SeededRng } from './rng';

export const STRESS_SESSION: ApiSession = {
  apiBaseUrl: 'https://stress.invalid',
  bearerToken: 'stress-bearer-token',
  canonicalAppUserId: 'a0000000-0000-0000-0000-00000000c0de',
  provider: 'apple',
};

export const TARGETS = [
  'deletion.request',
  'deletion.confirm',
  'consent.status',
  'consent.grantTraining',
  'consent.withdrawTraining',
  'consent.grantTelemetry',
  'consent.withdrawTelemetry',
  'onboarding.fetch',
  'onboarding.save',
] as const;
export type TargetId = (typeof TARGETS)[number];

export type Transport =
  | { kind: 'response'; status: number; body: BodyTextKind; text: string }
  | { kind: 'reject'; error: string };

export interface RecordedCall {
  url: string;
  method: string;
  authorization: string | undefined;
  bodyParseable: boolean | null;
  bodyLength: number;
}

export interface StressRow {
  seed: number;
  target: TargetId;
  transport: string;
  argument: string;
  mutations: string[];
  outcome: 'HELD' | 'BROKEN';
  /** `ok`, `typed:<ErrorClass>[:<code>]` or `untyped:<name>`. */
  result: string;
  violations: string[];
  calls: number;
  payload: string;
}

export interface CampaignSummary {
  module: string;
  lens: string;
  commit: string | null;
  seedBase: number;
  iterations: number;
  executed: number;
  held: number;
  broken: number;
  brokenSeeds: number[];
  byTarget: Record<string, { executed: number; broken: number }>;
  byTransport: Record<string, { executed: number; broken: number }>;
  byViolation: Record<string, number>;
  knownBrokenClasses: string[];
  rows: StressRow[];
}

const ALLOWED_PATH: Record<
  TargetId,
  { method: string; path: string; maxCalls: number }
> = {
  'deletion.request': {
    method: 'POST',
    path: '/v1/me/delete-request',
    maxCalls: 1,
  },
  'deletion.confirm': {
    method: 'POST',
    path: '/v1/me/delete-confirm',
    maxCalls: 1,
  },
  'consent.status': {
    method: 'GET',
    path: '/v1/me/consent/status',
    maxCalls: 1,
  },
  'consent.grantTraining': {
    method: 'POST',
    path: '/v1/me/consent/grant',
    maxCalls: 1,
  },
  'consent.withdrawTraining': {
    method: 'POST',
    path: '/v1/me/consent/withdraw',
    maxCalls: 1,
  },
  'consent.grantTelemetry': {
    method: 'POST',
    path: '/v1/me/consent/grant',
    maxCalls: 1,
  },
  'consent.withdrawTelemetry': {
    method: 'POST',
    path: '/v1/me/consent/withdraw',
    maxCalls: 1,
  },
  'onboarding.fetch': { method: 'GET', path: '/v1/me', maxCalls: 1 },
  // One retry without the optional identity fields is part of the contract.
  'onboarding.save': { method: 'PUT', path: '/v1/me/onboarding', maxCalls: 2 },
};

const HANDEDNESS = ['right', 'left', 'ambidextrous'] as const;
const GENDERS = ['female', 'male', 'nonbinary', 'prefer_not_to_say'] as const;
const REVOCATION = [
  'revoked',
  'not_applicable',
  'manual_action_required',
] as const;
const CONSENT_SCOPES = [
  'video_analysis',
  'model_training',
  'evaluation_telemetry',
] as const;

// ---------------------------------------------------------------------------
// Valid baselines per target (then mutated by the seed).
// ---------------------------------------------------------------------------

function validResponseBody(
  rng: SeededRng,
  target: TargetId,
): Record<string, unknown> {
  switch (target) {
    case 'deletion.request':
      return {
        challenge: `chal_${rng.int(0, 1e9)}`,
        expiresAt: new Date(1_800_000_000_000 + rng.int(0, 1e6)).toISOString(),
      };
    case 'deletion.confirm':
      return {
        deleted: true,
        appleAuthorizationRevocation: rng.pick(REVOCATION),
      };
    case 'consent.status':
    case 'consent.grantTraining':
    case 'consent.withdrawTraining':
    case 'consent.grantTelemetry':
    case 'consent.withdrawTelemetry':
      return {
        subjectPseudonym: rng.chance(0.5) ? null : `pseud_${rng.int(0, 1e6)}`,
        scopes: CONSENT_SCOPES.map(scope => ({
          scope,
          active: rng.chance(0.5),
          consentVersion: rng.chance(0.5) ? null : 'model-training-v1',
          lastAction: rng.pick([null, 'granted', 'withdrawn']),
          lastActionAt: rng.chance(0.5) ? null : '2026-09-01T00:00:00.000Z',
        })),
      };
    case 'onboarding.fetch':
      return {
        onboardingState: 'complete',
        profile: {
          skill_level: rng.pick(['beginner', 'intermediate', 'advanced']),
          handedness: rng.pick(HANDEDNESS),
          primary_goal: rng.pick([
            'dinks',
            'drives',
            'drops',
            'serves',
            'consistency',
          ]),
          biggest_problem: rng.pick(['pop_ups', 'net_errors', 'footwork']),
          focus_checkpoint: rng.pick(CHECKPOINTS),
          first_name: rng.chance(0.5) ? 'Sam' : null,
          gender: rng.chance(0.5) ? rng.pick(GENDERS) : null,
        },
      };
    case 'onboarding.save':
      return {
        plan: { focusCheckpoint: rng.pick(CHECKPOINTS) },
        recommendedCheckpoint: rng.pick(CHECKPOINTS),
        profile: {},
      };
  }
}

function validProfile(rng: SeededRng): Profile {
  return {
    ...(rng.chance(0.6) ? { firstName: 'Sam' } : {}),
    ...(rng.chance(0.6) ? { gender: rng.pick(GENDERS) } : {}),
    skillLevel: 'intermediate',
    handedness: rng.pick(HANDEDNESS),
    goal: 'dinks',
    biggestProblem: 'pop_ups',
    focusCheckpoint: 'contact_position',
  };
}

function validSurvey(rng: SeededRng): AccountDeletionSurvey {
  return {
    reasons: ['not_useful'],
    wanted: ['other'],
    details: rng.chance(0.5) ? 'stress' : null,
    scoredCount: rng.int(0, 5),
    isPremium: rng.chance(0.5),
    appVersion: '1.0.0',
  } as unknown as AccountDeletionSurvey;
}

/** Mutates one nested record when present (e.g. `profile` or a scope row) so
 * deep validation paths are exercised, not only the top level. */
function mutateDeep(
  rng: SeededRng,
  body: Record<string, unknown>,
  options: { jsonSafe: boolean },
): string[] {
  const labels: string[] = [];
  if (rng.chance(0.4)) {
    labels.push(...mutateRecord(rng, body, rng.int(1, 3), options));
  }
  const nested = body['profile'];
  if (
    nested &&
    typeof nested === 'object' &&
    !Array.isArray(nested) &&
    rng.chance(0.8)
  ) {
    labels.push(
      ...mutateRecord(
        rng,
        nested as Record<string, unknown>,
        rng.int(1, 3),
        options,
      ).map(l => `profile.${l}`),
    );
  }
  const scopes = body['scopes'];
  if (Array.isArray(scopes) && scopes.length > 0 && rng.chance(0.8)) {
    const index = rng.int(0, scopes.length - 1);
    const row = scopes[index];
    if (row && typeof row === 'object') {
      labels.push(
        ...mutateRecord(
          rng,
          row as Record<string, unknown>,
          rng.int(1, 2),
          options,
        ).map(l => `scopes[${index}].${l}`),
      );
    }
    if (rng.chance(0.2)) {
      scopes.push(wrongTypeValue(rng, options));
      labels.push('scopes.push:wrong-type');
    }
  }
  if (labels.length === 0) {
    labels.push(...mutateRecord(rng, body, 1, options));
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function buildTransport(
  rng: SeededRng,
  target: TargetId,
): { transport: Transport; mutations: string[]; payload: unknown } {
  if (rng.chance(0.12)) {
    const error = rng.pick([
      'TypeError:Network request failed',
      'AbortError',
      'string-throw',
      'null-throw',
      'object-throw',
      'RangeError',
    ]);
    return {
      transport: { kind: 'reject', error },
      mutations: [],
      payload: null,
    };
  }
  const status = rng.pick(HTTP_STATUSES);
  let payload: unknown;
  let mutations: string[] = [];
  const roll = rng.next();
  if (roll < 0.55) {
    const body = validResponseBody(rng, target);
    mutations = mutateDeep(rng, body, { jsonSafe: true });
    payload = body;
  } else if (roll < 0.7) {
    payload = validResponseBody(rng, target);
    mutations = ['valid-body'];
  } else if (roll < 0.85) {
    payload = wrongTypeValue(rng, { jsonSafe: true });
    mutations = ['whole-body:wrong-type'];
  } else {
    payload = {
      error: {
        code: rng.pick([
          'bad_request',
          'unauthorized',
          rng.pick(POLLUTION_KEYS),
        ]),
        message: rng.chance(0.5) ? hostileString(rng) : bigString(rng).value,
        details: wrongTypeValue(rng, { jsonSafe: true }),
      },
      schemaVersion: rng.pick([2, 99]),
    };
    mutations = ['error-envelope'];
  }
  const text = bodyText(rng, payload);
  return {
    transport: { kind: 'response', status, body: text.kind, text: text.text },
    mutations,
    payload,
  };
}

function makeRejection(kind: string): unknown {
  switch (kind) {
    case 'TypeError:Network request failed':
      return new TypeError('Network request failed');
    case 'AbortError': {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      return error;
    }
    case 'string-throw':
      return 'socket hang up';
    case 'null-throw':
      return null;
    case 'object-throw':
      return { code: 'ECONNRESET' };
    case 'RangeError':
      return new RangeError('Maximum call stack size exceeded');
    default:
      return new Error(kind);
  }
}

/** Real WHATWG `Response` for 200–599 (so `.json()` is the genuine parser);
 * a Response-like stub for statuses the constructor refuses (1xx, 599+),
 * which React Native's fetch does surface. Built OUTSIDE the module's try so
 * a harness bug can never masquerade as a caught network failure. */
function makeResponse(
  transport: Extract<Transport, { kind: 'response' }>,
): Response {
  const bodyless = transport.status === 204 || transport.status === 304;
  const text = bodyless ? '' : transport.text;
  if (transport.status < 200 || transport.status > 599) {
    const stub = {
      ok: transport.status >= 200 && transport.status <= 299,
      status: transport.status,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () => Promise.resolve().then(() => JSON.parse(text) as unknown),
      text: () => Promise.resolve(text),
    };
    return stub as unknown as Response;
  }
  return new Response(bodyless ? null : text, {
    status: transport.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetch(
  transport: Transport,
  calls: RecordedCall[],
): (input: string, init?: RequestInit) => Promise<Response> {
  // Construct once eagerly so a constructor failure is a harness error, not a
  // "network failure" swallowed by the module's try/catch; each call then gets
  // a fresh Response (bodies are single-use and onboarding.save may retry).
  if (transport.kind === 'response') makeResponse(transport);
  return async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body;
    let bodyParseable: boolean | null = null;
    let bodyLength = 0;
    if (typeof body === 'string') {
      bodyLength = body.length;
      try {
        JSON.parse(body);
        bodyParseable = true;
      } catch {
        bodyParseable = false;
      }
    } else if (body !== undefined) {
      bodyParseable = false;
    }
    calls.push({
      url: input,
      method: init?.method ?? 'GET',
      authorization: headers['Authorization'],
      bodyParseable,
      bodyLength,
    });
    if (transport.kind === 'reject') {
      throw makeRejection(transport.error);
    }
    return makeResponse(transport);
  };
}

// ---------------------------------------------------------------------------
// Direct arguments
// ---------------------------------------------------------------------------

function directArgument(
  rng: SeededRng,
  target: TargetId,
): { value: unknown; label: string } {
  const hostile = (): { value: unknown; label: string } => {
    const roll = rng.next();
    if (roll < 0.4) {
      const value = hostileString(rng);
      return { value, label: `hostile:${digest(value, 40)}` };
    }
    if (roll < 0.6) {
      const spec = bigString(rng);
      return {
        value: spec.value,
        label: `big:${spec.kind}(utf16=${spec.utf16Units},cp=${spec.codePoints},bytes=${spec.utf8Bytes})`,
      };
    }
    const value = wrongTypeValue(rng, { jsonSafe: false });
    return { value, label: `wrong-type:${digest(value, 40)}` };
  };
  switch (target) {
    case 'deletion.request': {
      if (rng.chance(0.4)) return { value: null, label: 'survey:null' };
      const survey = validSurvey(rng) as unknown as Record<string, unknown>;
      const labels = mutateRecord(rng, survey, rng.int(1, 3), {
        jsonSafe: false,
      });
      return { value: survey, label: `survey:${labels.join(',')}` };
    }
    case 'deletion.confirm':
      return rng.chance(0.3)
        ? { value: 'chal_valid', label: 'challenge:valid' }
        : (() => {
            const h = hostile();
            return { value: h.value, label: `challenge:${h.label}` };
          })();
    case 'consent.grantTraining':
    case 'consent.withdrawTraining':
    case 'consent.grantTelemetry':
    case 'consent.withdrawTelemetry':
      return rng.chance(0.3)
        ? { value: 'iPhone', label: 'device:valid' }
        : (() => {
            const h = hostile();
            return { value: h.value, label: `device:${h.label}` };
          })();
    case 'onboarding.save': {
      const profile = validProfile(rng) as unknown as Record<string, unknown>;
      if (rng.chance(0.3)) return { value: profile, label: 'profile:valid' };
      const labels = mutateRecord(rng, profile, rng.int(1, 3), {
        jsonSafe: false,
      });
      return { value: profile, label: `profile:${labels.join(',')}` };
    }
    case 'consent.status':
    case 'onboarding.fetch':
      return { value: undefined, label: 'none' };
  }
}

// ---------------------------------------------------------------------------
// Invocation + judging
// ---------------------------------------------------------------------------

type Settled =
  { kind: 'ok'; value: unknown } | { kind: 'threw'; error: unknown };

async function invoke(
  target: TargetId,
  argument: unknown,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<Settled> {
  try {
    let value: unknown;
    switch (target) {
      case 'deletion.request':
        value = await requestAccountDeletion(
          STRESS_SESSION,
          argument as AccountDeletionSurvey | null,
          fetchFn,
        );
        break;
      case 'deletion.confirm':
        value = await confirmAccountDeletion(
          STRESS_SESSION,
          argument as string,
          fetchFn,
        );
        break;
      case 'consent.status':
        value = await fetchConsentStatus(STRESS_SESSION, fetchFn);
        break;
      case 'consent.grantTraining':
        value = await grantModelTrainingConsent(
          STRESS_SESSION,
          argument as string,
          fetchFn,
        );
        break;
      case 'consent.withdrawTraining':
        value = await withdrawModelTrainingConsent(
          STRESS_SESSION,
          argument as string,
          fetchFn,
        );
        break;
      case 'consent.grantTelemetry':
        value = await grantEvaluationTelemetryConsent(
          STRESS_SESSION,
          argument as string,
          fetchFn,
        );
        break;
      case 'consent.withdrawTelemetry':
        value = await withdrawEvaluationTelemetryConsent(
          STRESS_SESSION,
          argument as string,
          fetchFn,
        );
        break;
      case 'onboarding.fetch':
        value = await fetchCanonicalOnboardingProfile(STRESS_SESSION, fetchFn);
        break;
      case 'onboarding.save':
        value = await saveCanonicalOnboardingProfile(
          STRESS_SESSION,
          argument as Profile,
          fetchFn,
        );
        break;
    }
    return { kind: 'ok', value };
  } catch (error) {
    return { kind: 'threw', error };
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isCheckpoint(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (CHECKPOINTS as readonly string[]).includes(value)
  );
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Shape rules the CONSUMERS of each result rely on (screens/stores index
 * these values without re-validating). */
function shapeViolations(
  target: TargetId,
  value: unknown,
  argument: unknown,
): string[] {
  const out: string[] = [];
  const bad = (what: string) => out.push(`ok-shape:${what}`);
  switch (target) {
    case 'deletion.request': {
      if (!isPlainRecord(value)) return ['ok-shape:not-record'];
      if (typeof value['challenge'] !== 'string') bad('challenge-not-string');
      if (typeof value['expiresAt'] !== 'string') bad('expiresAt-not-string');
      break;
    }
    case 'deletion.confirm': {
      if (!isPlainRecord(value)) return ['ok-shape:not-record'];
      if (
        !(REVOCATION as readonly unknown[]).includes(
          value['appleAuthorizationRevocation'],
        )
      ) {
        bad('revocation-not-enum');
      }
      break;
    }
    case 'consent.status':
    case 'consent.grantTraining':
    case 'consent.withdrawTraining':
    case 'consent.grantTelemetry':
    case 'consent.withdrawTelemetry': {
      if (!isPlainRecord(value)) return ['ok-shape:not-record'];
      const pseud = value['subjectPseudonym'];
      if (!(pseud === null || typeof pseud === 'string'))
        bad('subjectPseudonym');
      const scopes = value['scopes'];
      if (!Array.isArray(scopes)) return [...out, 'ok-shape:scopes-not-array'];
      scopes.forEach((row, i) => {
        if (!isPlainRecord(row)) return bad(`scopes[${i}]-not-record`);
        if (!(CONSENT_SCOPES as readonly unknown[]).includes(row['scope'])) {
          bad(`scopes[${i}].scope`);
        }
        if (typeof row['active'] !== 'boolean') bad(`scopes[${i}].active`);
        if (!(
          row['consentVersion'] === null ||
          typeof row['consentVersion'] === 'string'
        )) {
          bad(`scopes[${i}].consentVersion`);
        }
        if (!(
          row['lastAction'] === null ||
          ['granted', 'withdrawn'].includes(row['lastAction'] as string)
        )) {
          bad(`scopes[${i}].lastAction`);
        }
        if (!(
          row['lastActionAt'] === null ||
          typeof row['lastActionAt'] === 'string'
        )) {
          bad(`scopes[${i}].lastActionAt`);
        }
        const keys = Object.keys(row).sort().join(',');
        if (keys !== 'active,consentVersion,lastAction,lastActionAt,scope') {
          bad(`scopes[${i}].extra-keys:${keys}`);
        }
      });
      break;
    }
    case 'onboarding.fetch': {
      if (value === null) return [];
      if (!isPlainRecord(value)) return ['ok-shape:not-record-or-null'];
      if (!nonEmptyString(value['skillLevel'])) bad('skillLevel');
      if (!(HANDEDNESS as readonly unknown[]).includes(value['handedness']))
        bad('handedness');
      if (!nonEmptyString(value['goal'])) bad('goal');
      if (!nonEmptyString(value['biggestProblem'])) bad('biggestProblem');
      if (!isCheckpoint(value['focusCheckpoint'])) {
        bad(
          `focusCheckpoint-not-checkpoint:${describe(value['focusCheckpoint'])}`,
        );
      }
      if ('firstName' in value && !nonEmptyString(value['firstName']))
        bad('firstName');
      if (
        'gender' in value &&
        !(GENDERS as readonly unknown[]).includes(value['gender'])
      ) {
        bad('gender');
      }
      for (const key of Object.keys(value)) {
        if ((POLLUTION_KEYS as readonly string[]).includes(key))
          bad(`own-key:${key}`);
      }
      break;
    }
    case 'onboarding.save': {
      if (!isPlainRecord(value)) return ['ok-shape:not-record'];
      if (!isCheckpoint(value['focusCheckpoint'])) {
        bad(
          `focusCheckpoint-not-checkpoint:${describe(value['focusCheckpoint'])}`,
        );
      }
      // The module spreads the caller's profile; a well-typed caller profile
      // must come back with its keys intact plus the server focus.
      if (isPlainRecord(argument)) {
        for (const key of Object.keys(argument)) {
          if (key !== 'focusCheckpoint' && !(key in value))
            bad(`dropped-key:${key}`);
        }
      }
      break;
    }
  }
  return out;
}

function describe(value: unknown): string {
  if (value === Object.prototype) return 'Object.prototype';
  if (typeof value === 'function')
    return `function:${value.name || 'anonymous'}`;
  return digest(value, 40);
}

function typedErrorClass(target: TargetId): new (...args: never[]) => Error {
  if (target.startsWith('deletion.')) return AccountDeletionError as never;
  if (target.startsWith('consent.')) return ConsentApiError as never;
  return OnboardingSyncError as never;
}

function classifyError(
  target: TargetId,
  error: unknown,
): { result: string; violations: string[] } {
  const Typed = typedErrorClass(target);
  if (error instanceof Typed) {
    const code = (error as { code?: unknown }).code;
    const result = `typed:${Typed.name}${typeof code === 'string' ? `:${code}` : ''}`;
    const violations: string[] = [];
    if (
      typeof error.message !== 'string' ||
      error.message.trim().length === 0
    ) {
      violations.push('typed-error:empty-message');
    }
    return { result, violations };
  }
  const name =
    error instanceof Error
      ? error.name || error.constructor.name
      : `${typeof error}`;
  const message = error instanceof Error ? error.message : String(error);
  return {
    result: `untyped:${name}`,
    violations: [`untyped-throw:${name}:${message.slice(0, 80)}`],
  };
}

function prototypeViolations(): string[] {
  const out: string[] = [];
  const probe: Record<string, unknown> = {};
  if (probe[POLLUTION_SENTINEL] !== undefined)
    out.push('prototype-pollution:Object');
  if (Object.keys(Object.prototype).length > 0)
    out.push('prototype-pollution:Object-keys');
  if (Object.keys(Array.prototype).length > 0)
    out.push('prototype-pollution:Array-keys');
  if (
    ([] as unknown as Record<string, unknown>)[POLLUTION_SENTINEL] !== undefined
  ) {
    out.push('prototype-pollution:Array');
  }
  return out;
}

function callViolations(target: TargetId, calls: RecordedCall[]): string[] {
  const out: string[] = [];
  const contract = ALLOWED_PATH[target];
  if (calls.length > contract.maxCalls) {
    out.push(`write-amplification:${calls.length}>${contract.maxCalls}`);
  }
  calls.forEach((call, i) => {
    const expectedUrl = `${STRESS_SESSION.apiBaseUrl}${contract.path}`;
    if (call.url !== expectedUrl)
      out.push(`call[${i}].url:${digest(call.url, 60)}`);
    if (call.method !== contract.method)
      out.push(`call[${i}].method:${call.method}`);
    if (call.authorization !== `Bearer ${STRESS_SESSION.bearerToken}`) {
      out.push(`call[${i}].authorization-missing`);
    }
    if (call.bodyParseable === false) out.push(`call[${i}].body-not-json`);
    if (contract.method === 'GET' && call.bodyParseable !== null) {
      out.push(`call[${i}].get-with-body`);
    }
  });
  return out;
}

/** Violation classes pinned by `test.failing` cases in the suite; they are
 * reported separately so the campaign assertion stays green until fixed. */
export const KNOWN_BROKEN_CLASSES = [
  'onboarding.fetch:ok-shape:focusCheckpoint-not-checkpoint',
  'onboarding.save:untyped-throw:TypeError',
  'deletion.request:typed-error:empty-message',
  'deletion.confirm:typed-error:empty-message',
  'onboarding.fetch:typed-error:empty-message',
  'onboarding.save:typed-error:empty-message',
] as const;

export function violationClass(target: TargetId, violation: string): string {
  const head = violation.split(':').slice(0, 2).join(':');
  return `${target}:${head}`;
}

export function isKnownBroken(row: StressRow): boolean {
  return (
    row.violations.length > 0 &&
    row.violations.every(v =>
      (KNOWN_BROKEN_CLASSES as readonly string[]).includes(
        violationClass(row.target, v),
      ),
    )
  );
}

export async function runSeed(seed: number): Promise<StressRow> {
  const rng = new SeededRng(seed);
  const target = rng.pick(TARGETS);
  const { transport, mutations, payload } = buildTransport(rng, target);
  const argument = directArgument(rng, target);
  const calls: RecordedCall[] = [];
  const fetchFn = makeFetch(transport, calls);

  const settled = await invoke(target, argument.value, fetchFn);

  const violations: string[] = [];
  let result: string;
  if (settled.kind === 'ok') {
    result = 'ok';
    violations.push(...shapeViolations(target, settled.value, argument.value));
    if (transport.kind === 'reject') violations.push('ok-after-rejected-fetch');
    if (
      transport.kind === 'response' &&
      (transport.status < 200 || transport.status > 299)
    ) {
      violations.push(`ok-on-status:${transport.status}`);
    }
  } else {
    const classified = classifyError(target, settled.error);
    result = classified.result;
    violations.push(...classified.violations);
  }
  violations.push(...callViolations(target, calls));
  violations.push(...prototypeViolations());

  const transportLabel =
    transport.kind === 'reject'
      ? `reject:${transport.error}`
      : `response:${transport.status}:${transport.body}`;

  return {
    seed,
    target,
    transport: transportLabel,
    argument: argument.label.slice(0, 200),
    mutations,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    result,
    violations,
    calls: calls.length,
    payload:
      transport.kind === 'response'
        ? digest(transport.body === 'json' ? payload : transport.text)
        : 'n/a',
  };
}

export function readIterations(defaultCount: number): number {
  const raw = process.env['STRESS_ITER'];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultCount;
}

export function readSeedBase(defaultBase: number): number {
  const raw = process.env['STRESS_SEED_BASE'];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultBase;
}

export function readReplaySeed(): number | null {
  const raw = process.env['STRESS_SEED'];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function runCampaign(
  seedBase: number,
  iterations: number,
): Promise<CampaignSummary> {
  const rows: StressRow[] = [];
  for (let i = 0; i < iterations; i += 1) {
    rows.push(await runSeed(seedBase + i));
  }
  const byTarget: CampaignSummary['byTarget'] = {};
  const byTransport: CampaignSummary['byTransport'] = {};
  const byViolation: CampaignSummary['byViolation'] = {};
  for (const row of rows) {
    const t = (byTarget[row.target] ??= { executed: 0, broken: 0 });
    t.executed += 1;
    const transportKey = row.transport.split(':').slice(0, 2).join(':');
    const tr = (byTransport[transportKey] ??= { executed: 0, broken: 0 });
    tr.executed += 1;
    if (row.outcome === 'BROKEN') {
      t.broken += 1;
      tr.broken += 1;
      for (const v of row.violations) {
        const key = violationClass(row.target, v);
        byViolation[key] = (byViolation[key] ?? 0) + 1;
      }
    }
  }
  const broken = rows.filter(r => r.outcome === 'BROKEN');
  return {
    module: 'mod-account-deletion-consent',
    lens: 'boundary-malformed',
    commit: process.env['STRESS_COMMIT'] ?? null,
    seedBase,
    iterations,
    executed: rows.length,
    held: rows.length - broken.length,
    broken: broken.length,
    brokenSeeds: broken.map(r => r.seed),
    byTarget,
    byTransport,
    byViolation,
    knownBrokenClasses: [...KNOWN_BROKEN_CLASSES],
    rows,
  };
}

export function writeCampaign(summary: CampaignSummary, name: string): string {
  const dir =
    process.env['STRESS_OUT'] ??
    path.resolve(
      __dirname,
      '../../artifacts/stress/account-boundary-malformed',
    );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  return file;
}
