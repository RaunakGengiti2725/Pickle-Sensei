import type { OnboardingFetch } from '../../src/account/onboarding';
import { focusForGoal } from '../../src/state/profile';
import {
  type FakeResponsePlan,
  type ResponseKind,
  responseOfKind,
} from './generators';

/**
 * In-process stand-in for the two edge-function routes appStore reaches
 * through account/onboarding.ts (`GET /v1/me`, `PUT /v1/me/onboarding`).
 *
 * Default behaviour mirrors supabase/functions/api/index.ts (PUT validation
 * rules, sanitizeUserText caps, GET shape) so the harness exercises the REAL
 * client parser against realistic server verdicts. A per-route `plan` swaps
 * the realistic answer for one of the malformed/boundary responses in
 * generators.ts. Every request is recorded; anything addressed to a host
 * other than FAKE_API_BASE throws (nothing may leave the test process).
 */

export const FAKE_API_BASE = 'https://api.stress.invalid';

export interface RecordedRequest {
  method: string;
  path: string;
  bearer: string | null;
  body: unknown;
  bodyText: string | null;
  /** HTTP status answered, 0 when fetch threw. */
  status: number;
}

interface ServerProfileRow {
  skill_level: string;
  handedness: string;
  primary_goal: string;
  biggest_problem: string;
  focus_checkpoint: string;
  first_name: string | null;
  gender: string | null;
}

const CONTROL_AND_SPOOFING_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const LONE_SURROGATES =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const GENDER_OPTIONS = new Set([
  'female',
  'male',
  'nonbinary',
  'prefer_not_to_say',
]);

/** Verbatim port of supabase/functions/api/http.ts sanitizeUserText. */
export function sanitizeUserText(value: string, maxLength: number): string {
  const cleaned = value
    .replace(CONTROL_AND_SPOOFING_CHARS, '')
    .replace(LONE_SURROGATES, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, maxLength).join('').trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function makeResponse(status: number, body: string): Response {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  };
  return response as unknown as Response;
}

export class FakeOnboardingServer {
  readonly requests: RecordedRequest[] = [];
  /** bearer token → server-side profile row (null = onboarding pending). */
  readonly accounts = new Map<string, ServerProfileRow | null>();
  getPlan: ResponseKind | null = null;
  putPlan: ResponseKind | null = null;
  /** Awaited before answering a PUT — lets a test interleave other work. */
  putGate: (() => Promise<void>) | null = null;
  marker = 'MK0Z';

  readonly fetch: OnboardingFetch = async (input, init) => {
    if (!input.startsWith(FAKE_API_BASE)) {
      throw new Error(`stress harness: request escaped to ${input}`);
    }
    const path = input.slice(FAKE_API_BASE.length);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers['Authorization'] ?? null;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    let body: unknown = null;
    if (bodyText !== null) {
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        body = null;
      }
    }
    const entry: RecordedRequest = {
      method,
      path,
      bearer,
      body,
      bodyText,
      status: 0,
    };
    this.requests.push(entry);
    const response = await this.answer(method, path, bearer, body);
    entry.status = response.status;
    return response;
  };

  private async answer(
    method: string,
    path: string,
    bearer: string | null,
    body: unknown,
  ): Promise<Response> {
    if (method === 'GET' && path === '/v1/me') {
      const plan = this.getPlan;
      if (plan)
        return this.planned(responseOfKind(plan, this.marker, 'get-me'));
      return this.realGetMe(bearer);
    }
    if (method === 'PUT' && path === '/v1/me/onboarding') {
      if (this.putGate) await this.putGate();
      const plan = this.putPlan;
      if (plan) {
        return this.planned(
          responseOfKind(plan, this.marker, 'put-onboarding'),
        );
      }
      return this.realPutOnboarding(bearer, body);
    }
    return makeResponse(
      404,
      JSON.stringify({ error: { message: 'Not found.' } }),
    );
  }

  private planned(plan: FakeResponsePlan): Response {
    if (plan.throws) {
      if (plan.throws === 'AbortError') {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        throw error;
      }
      throw new TypeError(plan.throws);
    }
    return makeResponse(plan.status, plan.body);
  }

  private realGetMe(bearer: string | null): Response {
    if (!bearer || !this.accounts.has(bearer)) {
      return makeResponse(
        401,
        JSON.stringify({ error: { message: 'Unauthorized.' } }),
      );
    }
    const row = this.accounts.get(bearer) ?? null;
    return makeResponse(
      200,
      JSON.stringify({
        user: { id: bearer, email: null },
        onboardingState: row ? 'complete' : 'pending',
        profile: row ?? {
          skill_level: null,
          handedness: null,
          primary_goal: null,
          biggest_problem: null,
          focus_checkpoint: null,
          first_name: null,
          gender: null,
        },
      }),
    );
  }

  /** Port of the `PUT /v1/me/onboarding` case in index.ts. */
  private realPutOnboarding(bearer: string | null, rawBody: unknown): Response {
    if (!bearer || !this.accounts.has(bearer)) {
      return makeResponse(
        401,
        JSON.stringify({ error: { message: 'Unauthorized.' } }),
      );
    }
    const body: Record<string, unknown> = isRecord(rawBody) ? rawBody : {};
    const handedness = body['handedness'];
    const skillLevel =
      typeof body['skillLevel'] === 'string'
        ? sanitizeUserText(body['skillLevel'], 200)
        : '';
    const goal =
      typeof body['goal'] === 'string'
        ? sanitizeUserText(body['goal'], 200)
        : '';
    const biggestProblem =
      typeof body['biggestProblem'] === 'string'
        ? sanitizeUserText(body['biggestProblem'], 1000)
        : '';
    const reject = (message: string) =>
      makeResponse(
        400,
        JSON.stringify({ error: { message, code: 'invalid' } }),
      );
    if (
      !skillLevel ||
      skillLevel.length > 64 ||
      (handedness !== 'right' && handedness !== 'left') ||
      !goal ||
      goal.length > 64 ||
      !biggestProblem ||
      biggestProblem.length > 256
    ) {
      return reject('Invalid onboarding payload.');
    }
    const firstNameRaw = body['firstName'];
    let firstName: string | undefined;
    if (firstNameRaw !== undefined && firstNameRaw !== null) {
      if (typeof firstNameRaw !== 'string')
        return reject('Invalid onboarding payload.');
      const cleaned = sanitizeUserText(firstNameRaw, 200);
      if (cleaned.length < 1 || cleaned.length > 40) {
        return reject('firstName must be 1-40 characters after trimming.');
      }
      firstName = cleaned;
    }
    const genderRaw = body['gender'];
    let gender: string | undefined;
    if (genderRaw !== undefined && genderRaw !== null) {
      if (typeof genderRaw !== 'string' || !GENDER_OPTIONS.has(genderRaw)) {
        return reject(
          'gender must be one of female|male|nonbinary|prefer_not_to_say.',
        );
      }
      gender = genderRaw;
    }
    const focusSlug = focusForGoal(goal);
    const previous = this.accounts.get(bearer) ?? null;
    const row: ServerProfileRow = {
      skill_level: skillLevel,
      handedness,
      primary_goal: goal,
      biggest_problem: biggestProblem,
      focus_checkpoint: focusSlug,
      first_name: firstName ?? previous?.first_name ?? null,
      gender: gender ?? previous?.gender ?? null,
    };
    this.accounts.set(bearer, row);
    return makeResponse(
      200,
      JSON.stringify({
        plan: { focusCheckpoint: focusSlug },
        recommendedCheckpoint: focusSlug,
        profile: row,
      }),
    );
  }
}
