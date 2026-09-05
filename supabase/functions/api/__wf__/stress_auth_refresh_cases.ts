// Fault catalogue + seeded fault generator for `POST /v1/auth/refresh`.
//
// Every case carries an ORACLE: the user-visible class the contract promises
// (index.ts refreshSessionRoute / authRequest; the client-side decision in
// apps/mobile/src/account/sessionLifecycle.ts):
//   • GoTrue 400/401/403          → 401  (client: signed out)   authfail charged
//   • any other GoTrue HTTP answer→ 503  (client: retry later)  Retry-After honoured
//   • 2xx without a usable session→ 503  (client: retry later)
//   • socket failures             → retried on 100/200/400/800/1600ms backoff
//                                   inside ONE deadline, then 503 Retry-After 2
//   • deadline (hang)             → 503 Retry-After 2
//   • missing/blank refreshToken  → 400 validation.refresh, GoTrue never called
//   • oversized body              → 413
//   • PostgREST / RevenueCat      → never consulted by this route
//
// The deterministic catalogue (`CATALOGUE`) is the ≥40-case matrix; `generate`
// derives a random case from a seed for the campaign, using the same oracle.

import {
  type Behaviour,
  bodyHang,
  bodyStreamError,
  type ClientClass,
  delayed,
  GOTRUE_REFUSAL,
  hang,
  jsonResponse,
  type Observed,
  Prng,
  rawResponse,
  refreshRequest,
  sequence,
  socketFailure,
  userIdForToken,
  validSession,
} from "./stress_auth_refresh_harness.ts";

/** Mirrors index.ts AUTH_CONNECT_RETRY_BACKOFF_MS / AUTH_RETRY_AFTER_SECONDS. */
export const BACKOFF_MS: readonly number[] = [100, 200, 400, 800, 1600];
export const DEFAULT_RETRY_AFTER = "2";
/** Short deadline used so hang/retry-exhaustion cases finish in <0.5s. Chosen
 * so no backoff decision is within ~90ms of the deadline (setTimeout jitter). */
export const SHORT_TIMEOUT_MS = 400;

export interface Expectation {
  status: number;
  clientClass: ClientClass;
  /** Exact Retry-After header (null = must be absent); undefined = not asserted. */
  retryAfter?: string | null;
  errorCode?: string;
  gotrueAttempts: number;
  /** Whether this answer charges the per-IP auth-failure budget (401 only). */
  authfailCharged: boolean;
  /** Lower bound on end-to-end latency (delays / backoffs the route must wait). */
  minLatencyMs?: number;
  /** Upper bound (deadline + slack). */
  maxLatencyMs?: number;
  /** 200 only: expiresAt the client must receive (exact or ±3s of now+delta). */
  expiresAt?: { exact: number } | { nowPlus: number };
  /** The refresh_token GoTrue must have been sent (trim contract). */
  upstreamToken?: string;
}

export interface FaultCase {
  id: string;
  family: string;
  description: string;
  /** null → the edge function's default 6s deadline. */
  authTimeoutMs: number | null;
  gotrue?: Behaviour;
  postgrest?: Behaviour;
  revenuecat?: Behaviour;
  request: (ip: string) => Request;
  expect: Expectation;
  /** Replay parameters (for the seeded generator). */
  params?: Record<string, unknown>;
}

const refusalStatuses = [400, 401, 403] as const;
const serviceStatuses = [
  301, 302, 307, 404, 405, 408, 409, 410, 418, 422, 425, 429, 431, 451, 500, 501, 502, 503, 504,
  507, 508, 511, 520, 599,
] as const;

/** index.ts retryAfterOf(): Number(header) integer > 0 wins, else 2. */
export function expectedRetryAfter(header: string | null): string {
  const seconds = Number(header);
  return Number.isInteger(seconds) && seconds > 0 ? String(seconds) : DEFAULT_RETRY_AFTER;
}

const RETRY_AFTER_HEADERS: ReadonlyArray<string | null> = [
  null,
  "7",
  "0",
  "-3",
  "abc",
  "1.5",
  " 7 ",
  "7, 8",
  "3600",
  "Wed, 21 Oct 2015 07:28:00 GMT",
  "1e2",
  "0x10",
  "",
];

type BodyVariant = { name: string; response: (status: number) => Response };

const refusalBodies: readonly BodyVariant[] = [
  {
    name: "gotrue_invalid_grant",
    response: (status) =>
      jsonResponse(status, {
        error: "invalid_grant",
        error_code: "refresh_token_not_found",
        error_description: "Invalid Refresh Token: Refresh Token Not Found",
      }),
  },
  {
    name: "gotrue_already_used",
    response: (status) =>
      jsonResponse(status, {
        error: "invalid_grant",
        error_code: "refresh_token_already_used",
        error_description: "Invalid Refresh Token: Already Used",
      }),
  },
  {
    name: "gotrue_code_msg",
    response: (status) =>
      jsonResponse(status, {
        code: status,
        error_code: "session_not_found",
        msg: "Session not found",
      }),
  },
  {
    name: "plain_text",
    response: (status) => rawResponse(status, "nope", { "Content-Type": "text/plain" }),
  },
  { name: "empty", response: (status) => rawResponse(status, null) },
  {
    name: "html",
    response: (status) =>
      rawResponse(status, "<html><body>denied</body></html>", { "Content-Type": "text/html" }),
  },
  { name: "json_array", response: (status) => jsonResponse(status, [1, 2, 3]) },
];

const serviceBodies: readonly BodyVariant[] = [
  {
    name: "gotrue_error",
    response: (status) =>
      jsonResponse(status, { code: status, error_code: "unexpected_failure", msg: "boom" }),
  },
  {
    name: "cloudflare_html",
    response: (status) =>
      rawResponse(status, "<html>502 Bad Gateway</html>", { "Content-Type": "text/html" }),
  },
  { name: "empty", response: (status) => rawResponse(status, null) },
  {
    name: "valid_session_body",
    response: (status) =>
      jsonResponse(status, validSession("00000000-0000-4000-8000-000000000000")),
  },
];

const TOKEN_USER = "11111111-1111-4111-8111-111111111111";

/** 2xx answers the parser must REJECT (→ 503). */
const malformed2xx: ReadonlyArray<{ name: string; response: () => Response }> = [
  {
    name: "html_body",
    response: () => rawResponse(200, "<html>ok</html>", { "Content-Type": "text/html" }),
  },
  { name: "empty_body", response: () => rawResponse(200, null) },
  {
    name: "json_null",
    response: () => rawResponse(200, "null", { "Content-Type": "application/json" }),
  },
  { name: "json_array", response: () => jsonResponse(200, [validSession(TOKEN_USER)]) },
  { name: "json_string", response: () => jsonResponse(200, "ok") },
  { name: "empty_object", response: () => jsonResponse(200, {}) },
  {
    name: "missing_access_token",
    response: () => jsonResponse(200, validSession(TOKEN_USER, { access_token: undefined })),
  },
  {
    name: "empty_access_token",
    response: () => jsonResponse(200, validSession(TOKEN_USER, { access_token: "" })),
  },
  {
    name: "numeric_access_token",
    response: () => jsonResponse(200, validSession(TOKEN_USER, { access_token: 12345 })),
  },
  {
    name: "missing_refresh_token",
    response: () => jsonResponse(200, validSession(TOKEN_USER, { refresh_token: undefined })),
  },
  {
    name: "empty_refresh_token",
    response: () => jsonResponse(200, validSession(TOKEN_USER, { refresh_token: "" })),
  },
  {
    name: "missing_user",
    response: () => jsonResponse(200, validSession(TOKEN_USER, { user: undefined })),
  },
  {
    name: "user_without_id",
    response: () =>
      jsonResponse(200, validSession(TOKEN_USER, { user: { email: "x@example.com" } })),
  },
  {
    name: "user_empty_id",
    response: () => jsonResponse(200, validSession(TOKEN_USER, { user: { id: "" } })),
  },
  {
    name: "user_is_string",
    response: () => jsonResponse(200, validSession(TOKEN_USER, { user: TOKEN_USER })),
  },
  {
    name: "expires_in_zero",
    response: () =>
      jsonResponse(200, validSession(TOKEN_USER, { expires_in: 0, expires_at: undefined })),
  },
  {
    name: "expires_in_negative",
    response: () =>
      jsonResponse(200, validSession(TOKEN_USER, { expires_in: -1, expires_at: undefined })),
  },
  {
    name: "expires_in_string",
    response: () => jsonResponse(200, validSession(TOKEN_USER, { expires_in: "3600" })),
  },
  {
    name: "expires_at_past",
    response: () =>
      jsonResponse(
        200,
        validSession(TOKEN_USER, { expires_at: Math.floor(Date.now() / 1000) - 60 }),
      ),
  },
  {
    name: "expires_at_zero",
    response: () => jsonResponse(200, validSession(TOKEN_USER, { expires_at: 0 })),
  },
  {
    name: "expires_at_string",
    response: () => jsonResponse(200, validSession(TOKEN_USER, { expires_at: "soon" })),
  },
  {
    name: "truncated_json",
    response: () =>
      rawResponse(200, '{"access_token":"abc","refresh_token":"de', {
        "Content-Type": "application/json",
      }),
  },
  { name: "http_204_no_body", response: () => rawResponse(204, null) },
  {
    name: "expires_at_ms_not_seconds_past",
    response: () => jsonResponse(200, validSession(TOKEN_USER, { expires_at: 1_600_000_000 })),
  },
];

/** 2xx answers the parser must ACCEPT (→ 200 with the right expiresAt). */
const valid2xx: ReadonlyArray<{
  name: string;
  response: (token: string) => Response;
  expiresAt: () => Expectation["expiresAt"];
}> = [
  {
    name: "both_expiry_fields",
    response: (token) =>
      jsonResponse(
        200,
        validSession(userIdForToken(token), { expires_at: 1_900_000_000, expires_in: 3600 }),
      ),
    expiresAt: () => ({ exact: 1_900_000_000 }),
  },
  {
    name: "expires_in_only",
    response: (token) =>
      jsonResponse(
        200,
        validSession(userIdForToken(token), { expires_at: undefined, expires_in: 1800 }),
      ),
    expiresAt: () => ({ nowPlus: 1800 }),
  },
  {
    name: "expires_at_only",
    response: (token) =>
      jsonResponse(
        200,
        validSession(userIdForToken(token), { expires_in: undefined, expires_at: 1_900_000_001 }),
      ),
    expiresAt: () => ({ exact: 1_900_000_001 }),
  },
  {
    name: "no_expiry_fields_defaults_3600",
    response: (token) =>
      jsonResponse(
        200,
        validSession(userIdForToken(token), { expires_in: undefined, expires_at: undefined }),
      ),
    expiresAt: () => ({ nowPlus: 3600 }),
  },
  {
    name: "null_expiry_fields_defaults_3600",
    response: (token) =>
      jsonResponse(
        200,
        validSession(userIdForToken(token), { expires_in: null, expires_at: null }),
      ),
    expiresAt: () => ({ nowPlus: 3600 }),
  },
  {
    name: "http_201",
    response: (token) =>
      jsonResponse(201, validSession(userIdForToken(token), { expires_at: 1_900_000_002 })),
    expiresAt: () => ({ exact: 1_900_000_002 }),
  },
  {
    name: "text_plain_content_type",
    response: (token) =>
      rawResponse(
        200,
        JSON.stringify(validSession(userIdForToken(token), { expires_at: 1_900_000_003 })),
        {
          "Content-Type": "text/plain",
        },
      ),
    expiresAt: () => ({ exact: 1_900_000_003 }),
  },
  {
    name: "100kb_of_extra_fields",
    response: (token) =>
      jsonResponse(
        200,
        validSession(userIdForToken(token), {
          expires_at: 1_900_000_004,
          padding: "x".repeat(100_000),
        }),
      ),
    expiresAt: () => ({ exact: 1_900_000_004 }),
  },
  {
    name: "one_second_lifetime",
    response: (token) =>
      jsonResponse(
        200,
        validSession(userIdForToken(token), { expires_at: undefined, expires_in: 1 }),
      ),
    expiresAt: () => ({ nowPlus: 1 }),
  },
  {
    name: "user_without_email",
    response: (token) =>
      jsonResponse(
        200,
        validSession(userIdForToken(token), {
          user: { id: userIdForToken(token) },
          expires_at: 1_900_000_005,
        }),
      ),
    expiresAt: () => ({ exact: 1_900_000_005 }),
  },
];

// ── Transport oracle ─────────────────────────────────────────────────────────

export type Terminal =
  "ok" | "refusal" | "service" | "malformed" | "hang" | "body_error" | "body_hang";

export interface TransportPlan {
  /** GoTrue attempts the edge function makes. */
  attempts: number;
  /** Whether the terminal answer is reached (false → 503 unreachable). */
  answered: boolean;
  /** Why the loop ended: the next backoff would not fit (→ answers at once) or
   * the deadline fired (→ answers at the deadline). */
  ended: "answered" | "backoff_exhausted" | "deadline";
  /** Time spent sleeping between attempts. */
  sleptMs: number;
}

/** Replays authRequest()'s retry arithmetic for `failures` instant socket
 * failures followed by a terminal behaviour under deadline `timeoutMs`. */
export function transportPlan(
  timeoutMs: number,
  failures: number,
  terminal: Terminal,
): TransportPlan {
  let elapsed = 0;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt < failures) {
      const backoff = BACKOFF_MS[attempt];
      const remaining = timeoutMs - elapsed;
      if (backoff === undefined || backoff >= remaining) {
        return {
          attempts: attempt + 1,
          answered: false,
          ended: "backoff_exhausted",
          sleptMs: elapsed,
        };
      }
      elapsed += backoff;
      continue;
    }
    if (terminal === "hang" || terminal === "body_hang") {
      return { attempts: attempt + 1, answered: false, ended: "deadline", sleptMs: elapsed };
    }
    if (terminal === "body_error") {
      // A body read error is a connection fault: it retries like a socket failure.
      const backoff = BACKOFF_MS[attempt];
      const remaining = timeoutMs - elapsed;
      if (backoff === undefined || backoff >= remaining) {
        return {
          attempts: attempt + 1,
          answered: false,
          ended: "backoff_exhausted",
          sleptMs: elapsed,
        };
      }
      // the retry then gets a clean answer (sequence: body_error, then ok)
      return {
        attempts: attempt + 2,
        answered: true,
        ended: "answered",
        sleptMs: elapsed + backoff,
      };
    }
    return { attempts: attempt + 1, answered: true, ended: "answered", sleptMs: elapsed };
  }
}

/** The attempt steps a terminal contributes (body_error is two: the broken
 * body, then the clean answer the retry receives). */
function terminalSteps(terminal: Terminal, token: string, retryAfter: string | null): Behaviour[] {
  const ok: Behaviour = () =>
    jsonResponse(200, validSession(userIdForToken(token), { expires_at: 1_900_000_000 }));
  switch (terminal) {
    case "ok":
      return [ok];
    case "refusal":
      return [() => GOTRUE_REFUSAL()];
    case "service":
      return [
        () =>
          jsonResponse(
            502,
            { msg: "bad gateway" },
            retryAfter === null ? {} : { "Retry-After": retryAfter },
          ),
      ];
    case "malformed":
      return [() => jsonResponse(200, {})];
    case "hang":
      return [hang];
    case "body_error":
      return [bodyStreamError(200), ok];
    case "body_hang":
      return [bodyHang(200)];
  }
}

function terminalExpectation(
  terminal: Terminal,
  plan: TransportPlan,
  retryAfter: string | null,
): Omit<Expectation, "gotrueAttempts" | "minLatencyMs" | "maxLatencyMs"> {
  if (!plan.answered) {
    return {
      status: 503,
      clientClass: "retryable",
      retryAfter: DEFAULT_RETRY_AFTER,
      authfailCharged: false,
    };
  }
  switch (terminal) {
    case "ok":
    case "body_error":
      return {
        status: 200,
        clientClass: "rotated",
        retryAfter: null,
        authfailCharged: false,
        expiresAt: { exact: 1_900_000_000 },
      };
    case "refusal":
      return { status: 401, clientClass: "signed_out", retryAfter: null, authfailCharged: true };
    case "service":
      return {
        status: 503,
        clientClass: "retryable",
        retryAfter: expectedRetryAfter(retryAfter),
        authfailCharged: false,
      };
    case "malformed":
      return {
        status: 503,
        clientClass: "retryable",
        retryAfter: DEFAULT_RETRY_AFTER,
        authfailCharged: false,
      };
    default:
      throw new Error(`unreachable terminal ${terminal}`);
  }
}

export function transportCase(
  id: string,
  timeoutMs: number | null,
  failures: number,
  terminal: Terminal,
  retryAfter: string | null = null,
  extra: { preDelayMs?: number } = {},
): FaultCase {
  const token = `rt-${id}`;
  const effectiveTimeout = timeoutMs ?? 6000;
  const plan = transportPlan(effectiveTimeout, failures, terminal);
  const steps: Behaviour[] = [];
  for (let i = 0; i < failures; i += 1)
    steps.push(socketFailure(`connection reset by peer (${i})`));
  const terminals = terminalSteps(terminal, token, retryAfter);
  if (extra.preDelayMs) terminals[0] = delayed(extra.preDelayMs, terminals[0]);
  steps.push(...terminals);
  const expectation = terminalExpectation(terminal, plan, retryAfter);
  const minLatencyMs =
    plan.ended === "deadline"
      ? effectiveTimeout - 5
      : plan.sleptMs + (plan.answered ? (extra.preDelayMs ?? 0) : 0);
  return {
    id,
    family: "transport",
    description: `${failures} socket failure(s) then ${terminal}${extra.preDelayMs ? ` after ${extra.preDelayMs}ms` : ""} under a ${effectiveTimeout}ms deadline`,
    authTimeoutMs: timeoutMs,
    gotrue: sequence(steps),
    request: (ip) => refreshRequest({ ip, token }),
    expect: {
      ...expectation,
      gotrueAttempts: plan.attempts,
      minLatencyMs,
      maxLatencyMs: effectiveTimeout + 400,
      upstreamToken: token,
    },
    params: { timeoutMs, failures, terminal, retryAfter, preDelayMs: extra.preDelayMs ?? 0 },
  };
}

// ── Deterministic catalogue ──────────────────────────────────────────────────

function gotrueCase(
  id: string,
  family: string,
  description: string,
  behaviour: Behaviour,
  expect: Omit<Expectation, "gotrueAttempts"> & { gotrueAttempts?: number },
  authTimeoutMs: number | null = null,
): FaultCase {
  const token = `rt-${id}`;
  return {
    id,
    family,
    description,
    authTimeoutMs,
    gotrue: behaviour,
    request: (ip) => refreshRequest({ ip, token }),
    expect: { gotrueAttempts: 1, upstreamToken: token, ...expect },
  };
}

const REFUSED: Omit<Expectation, "gotrueAttempts"> = {
  status: 401,
  clientClass: "signed_out",
  retryAfter: null,
  authfailCharged: true,
};
const UNAVAILABLE = (retryAfter = DEFAULT_RETRY_AFTER): Omit<Expectation, "gotrueAttempts"> => ({
  status: 503,
  clientClass: "retryable",
  retryAfter,
  authfailCharged: false,
});
const VALIDATION: Expectation = {
  status: 400,
  clientClass: "retryable",
  errorCode: "validation.refresh",
  retryAfter: null,
  gotrueAttempts: 0,
  authfailCharged: false,
};

function clientCase(
  id: string,
  description: string,
  request: (ip: string) => Request,
  expect: Expectation,
): FaultCase {
  return { id, family: "client_request", description, authTimeoutMs: null, request, expect };
}

export function buildCatalogue(): FaultCase[] {
  const cases: FaultCase[] = [];

  // A. GoTrue refuses the credential → 401 (client signs out) — the ONLY 401 path.
  for (const status of refusalStatuses) {
    for (const body of refusalBodies) {
      cases.push(
        gotrueCase(
          `refusal_${status}_${body.name}`,
          "gotrue_refusal",
          `GoTrue ${status} with ${body.name} body`,
          () => body.response(status),
          REFUSED,
        ),
      );
    }
  }

  // B. GoTrue answers with a non-verdict status → 503, Retry-After honoured.
  for (const status of serviceStatuses) {
    const body = serviceBodies[status % serviceBodies.length];
    cases.push(
      gotrueCase(
        `service_${status}_${body.name}`,
        "gotrue_service",
        `GoTrue ${status} with ${body.name} body`,
        () => body.response(status),
        UNAVAILABLE(),
      ),
    );
  }
  for (const header of RETRY_AFTER_HEADERS) {
    for (const status of [429, 503] as const) {
      const label = header === null ? "absent" : header.replace(/[^A-Za-z0-9]+/g, "_") || "blank";
      cases.push(
        gotrueCase(
          `retry_after_${status}_${label}`,
          "gotrue_retry_after",
          `GoTrue ${status} with Retry-After ${header === null ? "(absent)" : JSON.stringify(header)}`,
          () =>
            jsonResponse(
              status,
              { msg: "rate limited" },
              header === null ? {} : { "Retry-After": header },
            ),
          UNAVAILABLE(expectedRetryAfter(header)),
        ),
      );
    }
  }

  // C. 2xx the parser must reject → 503 (never a verdict on the credential).
  for (const variant of malformed2xx) {
    cases.push(
      gotrueCase(
        `malformed_${variant.name}`,
        "gotrue_malformed_2xx",
        `GoTrue 2xx with ${variant.name}`,
        () => variant.response(),
        UNAVAILABLE(),
      ),
    );
  }

  // D. 2xx the parser must accept → 200 with the right expiresAt.
  for (const variant of valid2xx) {
    const id = `valid_${variant.name}`;
    const token = `rt-${id}`;
    cases.push({
      id,
      family: "gotrue_valid_2xx",
      description: `GoTrue 2xx ${variant.name}`,
      authTimeoutMs: null,
      gotrue: () => variant.response(token),
      request: (ip) => refreshRequest({ ip, token }),
      expect: {
        status: 200,
        clientClass: "rotated",
        retryAfter: null,
        gotrueAttempts: 1,
        authfailCharged: false,
        expiresAt: variant.expiresAt(),
        upstreamToken: token,
      },
    });
  }

  // E. Transport: socket failures, hangs, slow answers, body-stream faults.
  cases.push(transportCase("transport_1_fail_then_ok", null, 1, "ok"));
  cases.push(transportCase("transport_2_fail_then_ok", null, 2, "ok"));
  cases.push(transportCase("transport_2_fail_then_refusal", null, 2, "refusal"));
  cases.push(transportCase("transport_2_fail_then_service", null, 2, "service", "9"));
  cases.push(transportCase("transport_2_fail_then_malformed", null, 2, "malformed"));
  cases.push(transportCase("transport_exhausted_short_deadline", SHORT_TIMEOUT_MS, 9, "ok"));
  cases.push(transportCase("transport_hang_short_deadline", SHORT_TIMEOUT_MS, 0, "hang"));
  cases.push(transportCase("transport_1_fail_then_hang", SHORT_TIMEOUT_MS, 1, "hang"));
  cases.push(transportCase("transport_body_stream_error_then_ok", null, 0, "body_error"));
  cases.push(transportCase("transport_body_hang", SHORT_TIMEOUT_MS, 0, "body_hang"));
  cases.push(
    transportCase("transport_slow_ok_within_deadline", null, 0, "ok", null, { preDelayMs: 150 }),
  );
  cases.push(
    transportCase("transport_slow_refusal_within_deadline", null, 0, "refusal", null, {
      preDelayMs: 150,
    }),
  );
  // A refusal that arrives AFTER the deadline is an outage, not a refusal.
  {
    const id = "transport_refusal_after_deadline";
    const token = `rt-${id}`;
    cases.push({
      id,
      family: "transport",
      description: "GoTrue 400 arrives after the deadline → 503, never 401",
      authTimeoutMs: SHORT_TIMEOUT_MS,
      gotrue: delayed(SHORT_TIMEOUT_MS + 600, () => GOTRUE_REFUSAL()),
      request: (ip) => refreshRequest({ ip, token }),
      expect: {
        ...UNAVAILABLE(),
        gotrueAttempts: 1,
        minLatencyMs: SHORT_TIMEOUT_MS - 5,
        maxLatencyMs: SHORT_TIMEOUT_MS + 400,
        upstreamToken: token,
      },
    });
  }
  cases.push(
    gotrueCase(
      "transport_non_typeerror_throw",
      "transport",
      "fetch rejects with a non-TypeError → treated as a connection fault, retried, then ok",
      sequence([
        () => {
          throw new Error("unexpected runtime failure");
        },
        () => jsonResponse(200, validSession(TOKEN_USER, { expires_at: 1_900_000_000 })),
      ]),
      {
        status: 200,
        clientClass: "rotated",
        retryAfter: null,
        authfailCharged: false,
        gotrueAttempts: 2,
        minLatencyMs: 100,
        expiresAt: { exact: 1_900_000_000 },
      },
    ),
  );

  // F. Client request shapes → 400 validation.refresh without touching GoTrue.
  cases.push(
    clientCase(
      "client_body_not_json",
      "body is not JSON",
      (ip) => refreshRequest({ ip, rawBody: "not json" }),
      VALIDATION,
    ),
  );
  cases.push(
    clientCase(
      "client_body_array",
      "body is a JSON array",
      (ip) => refreshRequest({ ip, body: ["rt-x"] }),
      VALIDATION,
    ),
  );
  cases.push(
    clientCase(
      "client_token_number",
      "refreshToken is a number",
      (ip) => refreshRequest({ ip, body: { refreshToken: 12345 } }),
      VALIDATION,
    ),
  );
  cases.push(
    clientCase(
      "client_token_empty",
      "refreshToken is empty",
      (ip) => refreshRequest({ ip, body: { refreshToken: "" } }),
      VALIDATION,
    ),
  );
  cases.push(
    clientCase(
      "client_token_blank",
      "refreshToken is whitespace",
      (ip) => refreshRequest({ ip, body: { refreshToken: "   \t\n" } }),
      VALIDATION,
    ),
  );
  cases.push(
    clientCase(
      "client_token_null",
      "refreshToken is null",
      (ip) => refreshRequest({ ip, body: { refreshToken: null } }),
      VALIDATION,
    ),
  );
  cases.push(
    clientCase(
      "client_token_object",
      "refreshToken is an object",
      (ip) => refreshRequest({ ip, body: { refreshToken: { value: "x" } } }),
      VALIDATION,
    ),
  );
  cases.push(
    clientCase(
      "client_empty_object",
      "body is {}",
      (ip) => refreshRequest({ ip, body: {} }),
      VALIDATION,
    ),
  );
  cases.push(
    clientCase(
      "client_no_body",
      "no body at all",
      (ip) => refreshRequest({ ip, rawBody: null }),
      VALIDATION,
    ),
  );
  cases.push(
    clientCase(
      "client_proto_key",
      "refreshToken hidden under __proto__",
      (ip) => refreshRequest({ ip, rawBody: '{"__proto__":{"refreshToken":"rt-x"}}' }),
      VALIDATION,
    ),
  );
  cases.push(
    clientCase(
      "client_wrong_key_case",
      "refresh_token (snake_case) instead of refreshToken",
      (ip) => refreshRequest({ ip, body: { refresh_token: "rt-x" } }),
      VALIDATION,
    ),
  );
  cases.push(
    clientCase(
      "client_declared_content_length_over_cap",
      "Content-Length declares 6MB",
      (ip) =>
        refreshRequest({
          ip,
          headers: { "content-length": "6000000" },
          body: { refreshToken: "rt-x" },
        }),
      {
        status: 413,
        clientClass: "retryable",
        retryAfter: null,
        gotrueAttempts: 0,
        authfailCharged: false,
      },
    ),
  );
  cases.push(
    clientCase(
      "client_streamed_body_over_cap",
      "5MB+1 byte body without a trustworthy Content-Length",
      (ip) =>
        refreshRequest({
          ip,
          rawBody: new ReadableStream<Uint8Array>({
            start(controller) {
              const chunk = new Uint8Array(1_000_000).fill(0x61);
              for (let i = 0; i < 5; i += 1) controller.enqueue(chunk);
              controller.enqueue(new Uint8Array([0x61]));
              controller.close();
            },
          }),
        }),
      {
        status: 413,
        clientClass: "retryable",
        retryAfter: null,
        gotrueAttempts: 0,
        authfailCharged: false,
      },
    ),
  );
  // Accepted shapes: the token is trimmed, unknown fields ignored, path forms equal.
  for (const [id, description, build, upstreamToken] of [
    [
      "client_token_padded",
      "refreshToken with surrounding whitespace is trimmed",
      (ip: string) => refreshRequest({ ip, body: { refreshToken: "  rt-padded \n" } }),
      "rt-padded",
    ],
    [
      "client_extra_fields",
      "unknown body fields are ignored",
      (ip: string) =>
        refreshRequest({
          ip,
          body: { refreshToken: "rt-extra", deviceId: "abc", nested: { a: [1, 2] } },
        }),
      "rt-extra",
    ],
    [
      "client_duplicate_keys_last_wins",
      "duplicate JSON keys → last wins",
      (ip: string) =>
        refreshRequest({ ip, rawBody: '{"refreshToken":"rt-first","refreshToken":"rt-second"}' }),
      "rt-second",
    ],
    [
      "client_unicode_token",
      "refreshToken with unicode / emoji / control chars is forwarded intact",
      (ip: string) => refreshRequest({ ip, body: { refreshToken: 'rt-ünï-😀-\u0001-"quoted"' } }),
      'rt-ünï-😀-\u0001-"quoted"',
    ],
    [
      "client_path_without_mount_prefix",
      "/v1/auth/refresh routes like the gateway form",
      (ip: string) => refreshRequest({ ip, path: "/v1/auth/refresh", token: "rt-path-a" }),
      "rt-path-a",
    ],
    [
      "client_path_api_prefix",
      "/api/v1/auth/refresh routes like the gateway form",
      (ip: string) => refreshRequest({ ip, path: "/api/v1/auth/refresh", token: "rt-path-b" }),
      "rt-path-b",
    ],
    [
      "client_no_accept_header",
      "no Accept header",
      (ip: string) => refreshRequest({ ip, token: "rt-noaccept", headers: { Accept: "" } }),
      "rt-noaccept",
    ],
    [
      "client_1mb_token",
      "a 1MB refreshToken is forwarded to GoTrue as-is (no length cap before the upstream call)",
      (ip: string) => refreshRequest({ ip, token: `rt-${"m".repeat(1_000_000)}` }),
      `rt-${"m".repeat(1_000_000)}`,
    ],
  ] as const) {
    cases.push(
      clientCase(id, description, build, {
        status: 200,
        clientClass: "rotated",
        retryAfter: null,
        gotrueAttempts: 1,
        authfailCharged: false,
        upstreamToken,
      }),
    );
  }
  // Not the route: falls through to bearer authentication (client never does this).
  cases.push(
    clientCase(
      "client_get_method",
      "GET /v1/auth/refresh is not the route → bearer auth → 401 missing bearer",
      (ip) => refreshRequest({ ip, method: "GET", rawBody: null }),
      {
        status: 401,
        clientClass: "signed_out",
        retryAfter: null,
        gotrueAttempts: 0,
        authfailCharged: true,
      },
    ),
  );
  cases.push(
    clientCase(
      "client_trailing_slash",
      "POST /v1/auth/refresh/ is not the route → bearer auth → 401 missing bearer",
      (ip) => refreshRequest({ ip, path: "/functions/v1/api/v1/auth/refresh/", token: "rt-slash" }),
      {
        status: 401,
        clientClass: "signed_out",
        retryAfter: null,
        gotrueAttempts: 0,
        authfailCharged: true,
      },
    ),
  );

  // G. Other upstreams failing must be invisible: the route never calls them.
  const okExpect: Expectation = {
    status: 200,
    clientClass: "rotated",
    retryAfter: null,
    gotrueAttempts: 1,
    authfailCharged: false,
  };
  const fail500: Behaviour = () => jsonResponse(500, { message: "down" });
  const throwing: Behaviour = () => {
    throw new TypeError("connection refused");
  };
  const slow: Behaviour = delayed(2_000, fail500);
  for (const [name, patch] of [
    ["postgrest_500", { postgrest: fail500 }],
    ["postgrest_throws", { postgrest: throwing }],
    ["postgrest_slow", { postgrest: slow }],
    ["revenuecat_500", { revenuecat: fail500 }],
    ["revenuecat_throws", { revenuecat: throwing }],
    ["revenuecat_slow", { revenuecat: slow }],
  ] as const) {
    const token = `rt-indep-${name}`;
    cases.push({
      id: `independence_${name}`,
      family: "other_upstream",
      description: `${name} while refreshing → unaffected, zero calls`,
      authTimeoutMs: null,
      request: (ip) => refreshRequest({ ip, token }),
      expect: { ...okExpect, upstreamToken: token },
      ...patch,
    });
  }

  return cases;
}

export const CATALOGUE: readonly FaultCase[] = buildCatalogue();

// ── Seeded generator (same oracle, random parameters) ────────────────────────

export function generate(seed: number): FaultCase {
  const rng = new Prng(seed);
  const id = `seed_${seed}`;
  const token = `rt-${id}`;
  const family = rng.pick([
    "refusal",
    "service",
    "retry_after",
    "malformed",
    "valid",
    "transport",
    "transport_short",
    "slow",
    "client",
  ] as const);
  const withToken = (c: FaultCase): FaultCase => ({ ...c, id, params: { family, ...c.params } });

  switch (family) {
    case "refusal": {
      const status = rng.pick(refusalStatuses);
      const body = rng.pick(refusalBodies);
      return withToken({
        ...gotrueCase(
          id,
          "gotrue_refusal",
          `GoTrue ${status} ${body.name}`,
          () => body.response(status),
          REFUSED,
        ),
        params: { status, body: body.name },
      });
    }
    case "service": {
      const status = rng.pick(serviceStatuses);
      const body = rng.pick(serviceBodies);
      const header = rng.pick(RETRY_AFTER_HEADERS);
      return withToken({
        ...gotrueCase(
          id,
          "gotrue_service",
          `GoTrue ${status} ${body.name} Retry-After ${JSON.stringify(header)}`,
          () => {
            const response = body.response(status);
            if (header !== null) response.headers.set("Retry-After", header);
            return response;
          },
          UNAVAILABLE(expectedRetryAfter(header)),
        ),
        params: { status, body: body.name, retryAfter: header },
      });
    }
    case "retry_after": {
      const seconds = rng.int(1, 100_000);
      const header = rng.chance(0.5) ? String(seconds) : `${seconds}.${rng.int(1, 9)}`;
      return withToken({
        ...gotrueCase(
          id,
          "gotrue_retry_after",
          `GoTrue 429 Retry-After ${header}`,
          () => jsonResponse(429, { msg: "slow down" }, { "Retry-After": header }),
          UNAVAILABLE(expectedRetryAfter(header)),
        ),
        params: { retryAfter: header },
      });
    }
    case "malformed": {
      const variant = rng.pick(malformed2xx);
      return withToken({
        ...gotrueCase(
          id,
          "gotrue_malformed_2xx",
          `GoTrue 2xx ${variant.name}`,
          () => variant.response(),
          UNAVAILABLE(),
        ),
        params: { variant: variant.name },
      });
    }
    case "valid": {
      const variant = rng.pick(valid2xx);
      return withToken({
        id,
        family: "gotrue_valid_2xx",
        description: `GoTrue 2xx ${variant.name}`,
        authTimeoutMs: null,
        gotrue: () => variant.response(token),
        request: (ip) => refreshRequest({ ip, token }),
        expect: {
          status: 200,
          clientClass: "rotated",
          retryAfter: null,
          gotrueAttempts: 1,
          authfailCharged: false,
          expiresAt: variant.expiresAt(),
          upstreamToken: token,
        },
        params: { variant: variant.name },
      });
    }
    case "transport": {
      // Default 6s deadline: keep total backoff ≤ 300ms (k ≤ 2) so the case is fast.
      const failures = rng.int(0, 2);
      const terminal = rng.pick(["ok", "refusal", "service", "malformed", "body_error"] as const);
      const header = rng.pick(RETRY_AFTER_HEADERS);
      return withToken(transportCase(id, null, failures, terminal, header));
    }
    case "transport_short": {
      const failures = rng.int(0, 6);
      const terminal = rng.pick([
        "ok",
        "refusal",
        "service",
        "malformed",
        "hang",
        "body_hang",
      ] as const);
      return withToken(transportCase(id, SHORT_TIMEOUT_MS, failures, terminal));
    }
    case "slow": {
      const preDelayMs = rng.int(1, 150);
      const terminal = rng.pick(["ok", "refusal", "service", "malformed"] as const);
      return withToken(transportCase(id, null, 0, terminal, null, { preDelayMs }));
    }
    case "client": {
      const shape = rng.pick([
        "not_json",
        "array",
        "number",
        "empty",
        "blank",
        "null",
        "object",
        "no_body",
        "padded",
        "extra_fields",
        "unicode",
      ] as const);
      const padding = " ".repeat(rng.int(1, 5));
      const real = `rt-${seed.toString(16)}`;
      const shapes: Record<typeof shape, { build: (ip: string) => Request; expect: Expectation }> =
        {
          not_json: {
            build: (ip) => refreshRequest({ ip, rawBody: `garbage-${seed}` }),
            expect: VALIDATION,
          },
          array: { build: (ip) => refreshRequest({ ip, body: [real] }), expect: VALIDATION },
          number: {
            build: (ip) => refreshRequest({ ip, body: { refreshToken: seed } }),
            expect: VALIDATION,
          },
          empty: {
            build: (ip) => refreshRequest({ ip, body: { refreshToken: "" } }),
            expect: VALIDATION,
          },
          blank: {
            build: (ip) => refreshRequest({ ip, body: { refreshToken: padding } }),
            expect: VALIDATION,
          },
          null: {
            build: (ip) => refreshRequest({ ip, body: { refreshToken: null } }),
            expect: VALIDATION,
          },
          object: {
            build: (ip) => refreshRequest({ ip, body: { refreshToken: { real } } }),
            expect: VALIDATION,
          },
          no_body: { build: (ip) => refreshRequest({ ip, rawBody: null }), expect: VALIDATION },
          padded: {
            build: (ip) =>
              refreshRequest({ ip, body: { refreshToken: `${padding}${real}${padding}` } }),
            expect: {
              status: 200,
              clientClass: "rotated",
              retryAfter: null,
              gotrueAttempts: 1,
              authfailCharged: false,
              upstreamToken: real,
            },
          },
          extra_fields: {
            build: (ip) =>
              refreshRequest({ ip, body: { refreshToken: real, seed, extra: { seed } } }),
            expect: {
              status: 200,
              clientClass: "rotated",
              retryAfter: null,
              gotrueAttempts: 1,
              authfailCharged: false,
              upstreamToken: real,
            },
          },
          unicode: {
            build: (ip) =>
              refreshRequest({ ip, body: { refreshToken: `${real}-\u{1F3D3}-\u00e9-\u0007` } }),
            expect: {
              status: 200,
              clientClass: "rotated",
              retryAfter: null,
              gotrueAttempts: 1,
              authfailCharged: false,
              upstreamToken: `${real}-\u{1F3D3}-\u00e9-\u0007`,
            },
          },
        };
      return withToken({
        id,
        family: "client_request",
        description: `client shape ${shape}`,
        authTimeoutMs: null,
        request: shapes[shape].build,
        expect: shapes[shape].expect,
        params: { shape },
      });
    }
  }
}

// ── Verdict ──────────────────────────────────────────────────────────────────

export interface Verdict {
  holds: boolean;
  mismatches: string[];
}

export function judge(
  c: FaultCase,
  observed: Observed,
  extras: { upstreamToken?: string; authfailCharged?: boolean; nowSeconds: number },
): Verdict {
  const mismatches: string[] = [];
  const e = c.expect;
  if (observed.status !== e.status) mismatches.push(`status ${observed.status} ≠ ${e.status}`);
  if (observed.clientClass !== e.clientClass) {
    mismatches.push(`clientClass ${observed.clientClass} ≠ ${e.clientClass}`);
  }
  if (e.retryAfter !== undefined && observed.retryAfter !== e.retryAfter) {
    mismatches.push(
      `Retry-After ${JSON.stringify(observed.retryAfter)} ≠ ${JSON.stringify(e.retryAfter)}`,
    );
  }
  if (e.errorCode !== undefined && observed.errorCode !== e.errorCode) {
    mismatches.push(`error.code ${observed.errorCode} ≠ ${e.errorCode}`);
  }
  if (observed.gotrueAttempts !== e.gotrueAttempts) {
    mismatches.push(`gotrue attempts ${observed.gotrueAttempts} ≠ ${e.gotrueAttempts}`);
  }
  if (observed.postgrestCalls !== 0)
    mismatches.push(`postgrest called ${observed.postgrestCalls}×`);
  if (observed.revenuecatCalls !== 0)
    mismatches.push(`revenuecat called ${observed.revenuecatCalls}×`);
  if (e.minLatencyMs !== undefined && observed.latencyMs < e.minLatencyMs) {
    mismatches.push(`latency ${observed.latencyMs}ms < ${e.minLatencyMs}ms (answered too early)`);
  }
  if (e.maxLatencyMs !== undefined && observed.latencyMs > e.maxLatencyMs) {
    mismatches.push(
      `latency ${observed.latencyMs}ms > ${e.maxLatencyMs}ms (deadline not enforced)`,
    );
  }
  if (
    e.upstreamToken !== undefined &&
    observed.gotrueAttempts > 0 &&
    extras.upstreamToken !== e.upstreamToken
  ) {
    mismatches.push(
      `upstream refresh_token ${JSON.stringify(extras.upstreamToken).slice(0, 60)} ≠ expected`,
    );
  }
  if (extras.authfailCharged !== undefined && extras.authfailCharged !== e.authfailCharged) {
    mismatches.push(`authfail charged=${extras.authfailCharged} ≠ ${e.authfailCharged}`);
  }
  if (!observed.requestId) mismatches.push("no x-request-id header");
  if (e.status === 200) {
    const session = (observed.body.session ?? {}) as Record<string, unknown>;
    if (e.expiresAt && "exact" in e.expiresAt && session.expiresAt !== e.expiresAt.exact) {
      mismatches.push(`expiresAt ${session.expiresAt} ≠ ${e.expiresAt.exact}`);
    }
    if (e.expiresAt && "nowPlus" in e.expiresAt) {
      const want = extras.nowSeconds + e.expiresAt.nowPlus;
      if (typeof session.expiresAt !== "number" || Math.abs(session.expiresAt - want) > 3) {
        mismatches.push(
          `expiresAt ${session.expiresAt} not within 3s of now+${e.expiresAt.nowPlus}`,
        );
      }
    }
    if (Object.keys(observed.body).join(",") !== "session") {
      mismatches.push(`200 body keys ${Object.keys(observed.body).join(",")} ≠ session`);
    }
  } else {
    // Error bodies are generic: never leak upstream detail to the client.
    const text = JSON.stringify(observed.body);
    if (
      /boom|bad gateway|Refresh Token Not Found|unexpected_failure|connection|attempts/i.test(text)
    ) {
      mismatches.push(`error body leaks upstream detail: ${text.slice(0, 120)}`);
    }
    if (observed.status >= 500 && text.includes("session"))
      mismatches.push("5xx body carries a session");
  }
  return { holds: mismatches.length === 0, mismatches };
}
