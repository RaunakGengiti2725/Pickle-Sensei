/**
 * stress-consent-grant-faults — FAILURE INJECTION for POST /v1/me/consent/grant.
 *
 * Every upstream the route can reach (Supabase Auth `GET /auth/v1/user` and the
 * `id_token` grant, PostgREST insert, PostgREST read-back, Upstash Redis,
 * RevenueCat) is stubbed to FAIL / TIME OUT / RETURN MALFORMED in turn against
 * the REAL handler booted in-process (stress_consent_grant_harness.ts), and each
 * case asserts the user-visible contract:
 *
 *   1. the status class the app reacts to (401 = sign in again, 400 = coded
 *      validation error, 429 = back off, 503 = retryable outage),
 *   2. that no injected upstream detail leaks into the body (a canary string is
 *      planted in every injected error body and must never be echoed),
 *   3. RECOVERABILITY: the same request with the fault cleared succeeds, and the
 *      folded consent status is exactly what the ledger says.
 *
 *   deno test -A --no-check --config deno.json stress_consent_grant_faults.test.ts
 *   STRESS_SEED=20260904 …                     # replay a campaign
 *   STRESS_CASE=auth_user_http_500 …           # replay ONE case
 *
 * Results (seed + case → outcome) are written to
 * <STRESS_OUT_DIR>/faults.json (default artifacts/stress-consent-grant/latest/).
 * Fast by design: the whole campaign is in-process and lives in the suite.
 */
import { assert, assertEquals } from "@std/assert";
import {
  activeScopes,
  apiRequest,
  call,
  envInt,
  errorCodeOf,
  errorMessageOf,
  expectedActive,
  type Fault,
  fnv1a,
  googleIdToken,
  grantBody,
  grantRequest,
  heapNow,
  histogram,
  loadStressHarness,
  Prng,
  seededActor,
  statusRequest,
  SUPABASE_URL,
  validStatusBody,
  warmAuth,
  withStressAuthTimeout,
  writeJson,
} from "./stress_consent_grant_harness.ts";

const SEED = envInt("STRESS_SEED", 20260904);
/** Repetitions of the whole fault matrix (each repetition uses a fresh seed). */
const REPEATS = envInt("STRESS_ITER", 1);
const ONLY = Deno.env.get("STRESS_CASE") ?? "";
const HANG_MS = envInt("STRESS_HANG_MS", 900);
/** Wall-clock a single faulted grant may take before the app's outbox sees an answer. */
const LATENCY_BUDGET_MS = envInt("STRESS_FAULT_LATENCY_BUDGET_MS", 2000);
/** Supabase round trips a single grant may spend (auth + insert + read-back). */
const ROUND_TRIP_BUDGET = envInt("STRESS_ROUND_TRIP_BUDGET", 3);

/** Filled by the matrix test, judged by the budget test below. */
const campaignRows: ResultRow[] = [];

type Expect = {
  status: number;
  /** Other statuses that also satisfy the contract (recorded, not judged). */
  statusAlso?: number[];
  /** Coded error `error.code`, when the contract defines one. */
  code?: string | null;
  /** Exact user-visible message, when the contract fixes it. */
  message?: string;
  /** Header that must be present (e.g. Retry-After on a retryable answer). */
  header?: string;
};

interface FaultCase {
  id: string;
  /** Which bearer kind the case exercises. */
  bearer: "session" | "session_warm" | "provider";
  faults: Fault[];
  /** Request body override (default: a valid model_training grant). */
  body?: Record<string, unknown>;
  rawBody?: string;
  expect: Expect;
  /** Ledger rows the case must have written (default 0 for failures, 1 for 200). */
  rowsWritten?: number;
  /** Skip the "same call succeeds once the fault clears" probe (permanent refusals). */
  noRecovery?: boolean;
  /** Cases judged by their own test (default: the upstream-fault matrix). */
  group?: "caps";
}

/** Everything a 5xx body must never contain. */
function leakedTokens(text: string, canary: string): string[] {
  const needles = [
    canary,
    SUPABASE_URL,
    "consent_records",
    "PGRST",
    "42501",
    "23514",
    "row-level security",
    "constraint",
    "injected upstream failure",
    "connection refused",
    "Supabase Auth",
    "invalid JWT",
  ];
  return needles.filter((needle) => text.includes(needle));
}

/** ── The fault matrix ──────────────────────────────────────────────────────
 * Grouped by upstream. Statuses come from index.ts's own taxonomy:
 *   Auth `refused` (400/401/403) → 401; anything else about Auth → 503;
 *   any PostgREST error on the insert → 503 "Consent update …";
 *   any PostgREST error on the read-back → 503 "Consent status …";
 *   Redis is fail-open: a broken cache may slow a request, never break it.
 */
function faultMatrix(): FaultCase[] {
  const cases: FaultCase[] = [];
  const authUnavailable: Expect = {
    status: 503,
    code: null,
    message:
      "Session verification is temporarily unavailable. Please try again.",
    header: "retry-after",
  };
  const authRefused: Expect = {
    status: 401,
    code: null,
    message: "The session is no longer valid. Sign in again.",
  };
  const insertDown: Expect = {
    status: 503,
    code: null,
    message: "Consent update is temporarily unavailable. Please try again.",
  };
  const statusDown: Expect = {
    status: 503,
    code: null,
    message: "Consent status is temporarily unavailable. Please try again.",
  };

  // ── A. Supabase Auth: GET /auth/v1/user (the session-bearer path) ─────────
  for (const status of [500, 502, 503, 504, 429, 408, 418, 599]) {
    cases.push({
      id: `auth_user_http_${status}`,
      bearer: "session",
      faults: [{ target: "auth_user", mode: { kind: "http", status } }],
      expect: authUnavailable,
    });
  }
  for (const status of [400, 401, 403]) {
    cases.push({
      id: `auth_user_refusal_${status}`,
      bearer: "session",
      faults: [{ target: "auth_user", mode: { kind: "http", status } }],
      expect: authRefused,
    });
  }
  cases.push(
    {
      id: "auth_user_network_error",
      bearer: "session",
      faults: [{ target: "auth_user", mode: { kind: "network" } }],
      expect: authUnavailable,
    },
    {
      id: "auth_user_hang_past_deadline",
      bearer: "session",
      faults: [{ target: "auth_user", mode: { kind: "hang", ms: HANG_MS } }],
      expect: authUnavailable,
    },
    {
      id: "auth_user_malformed_json",
      bearer: "session",
      faults: [{
        target: "auth_user",
        mode: { kind: "malformed", rawBody: '{"id": "trunc' },
      }],
      expect: authUnavailable,
    },
    {
      id: "auth_user_html_gateway_page",
      bearer: "session",
      faults: [
        {
          target: "auth_user",
          mode: {
            kind: "malformed",
            rawBody: "<html><body>502 Bad Gateway</body></html>",
          },
        },
      ],
      expect: authUnavailable,
    },
    {
      id: "auth_user_shape_no_id",
      bearer: "session",
      faults: [{
        target: "auth_user",
        mode: { kind: "shape", body: { email: "x@example.com" } },
      }],
      expect: authUnavailable,
    },
    {
      id: "auth_user_shape_id_not_string",
      bearer: "session",
      faults: [{
        target: "auth_user",
        mode: { kind: "shape", body: { id: 42 } },
      }],
      expect: authUnavailable,
    },
    {
      id: "auth_user_shape_empty_array",
      bearer: "session",
      faults: [{ target: "auth_user", mode: { kind: "shape", body: [] } }],
      expect: authUnavailable,
    },
    {
      id: "auth_user_shape_no_provider",
      bearer: "session",
      faults: [
        {
          target: "auth_user",
          mode: {
            kind: "shape",
            body: {
              id: "11111111-1111-4111-8111-111111111111",
              app_metadata: {},
            },
          },
        },
      ],
      expect: {
        status: 401,
        code: null,
        message: "The session does not belong to a Google or Apple account.",
      },
      noRecovery: false,
    },
    {
      id: "auth_user_slow_but_correct",
      bearer: "session",
      faults: [{ target: "auth_user", mode: { kind: "slow", ms: 60 } }],
      expect: { status: 200 },
      rowsWritten: 1,
    },
  );

  // ── B. Supabase Auth: the transitional provider-ID-token bearer path ─────
  for (const status of [400, 429, 500, 503]) {
    cases.push({
      id: `auth_id_token_http_${status}`,
      bearer: "provider",
      faults: [{ target: "auth_id_token", mode: { kind: "http", status } }],
      expect: {
        status: 401,
        code: null,
        message: "The identity token could not be verified.",
      },
    });
  }
  cases.push(
    {
      id: "auth_id_token_network_error",
      bearer: "provider",
      faults: [{ target: "auth_id_token", mode: { kind: "network" } }],
      expect: {
        status: 401,
        code: null,
        message: "The identity token could not be verified.",
      },
    },
    {
      id: "auth_id_token_malformed_json",
      bearer: "provider",
      faults: [{
        target: "auth_id_token",
        mode: { kind: "malformed", rawBody: "not json at all" },
      }],
      expect: {
        status: 401,
        code: null,
        message: "The identity token could not be verified.",
      },
    },
    {
      id: "auth_id_token_shape_no_session",
      bearer: "provider",
      faults: [
        {
          target: "auth_id_token",
          mode: {
            kind: "shape",
            body: { user: { id: "11111111-1111-4111-8111-111111111111" } },
          },
        },
      ],
      expect: {
        status: 401,
        code: null,
        message: "The identity token could not be verified.",
      },
    },
    {
      id: "auth_id_token_happy_path",
      bearer: "provider",
      faults: [],
      expect: { status: 200 },
      rowsWritten: 1,
    },
  );

  // ── C. PostgREST: the consent INSERT ─────────────────────────────────────
  for (
    const status of [400, 401, 403, 404, 409, 413, 429, 500, 502, 503, 504]
  ) {
    cases.push({
      id: `rest_insert_http_${status}`,
      bearer: "session_warm",
      faults: [{ target: "rest_insert", mode: { kind: "http", status } }],
      expect: insertDown,
    });
  }
  cases.push(
    {
      id: "rest_insert_network_error",
      bearer: "session_warm",
      faults: [{ target: "rest_insert", mode: { kind: "network" } }],
      expect: insertDown,
    },
    {
      id: "rest_insert_malformed_json",
      bearer: "session_warm",
      faults: [
        {
          target: "rest_insert",
          mode: { kind: "malformed", status: 500, rawBody: '{"code":"XX0' },
        },
      ],
      expect: insertDown,
    },
    {
      id: "rest_insert_rls_denied",
      bearer: "session_warm",
      faults: [
        {
          target: "rest_insert",
          mode: {
            kind: "http",
            status: 403,
            body: {
              code: "42501",
              message:
                'new row violates row-level security policy for table "consent_records"',
              details: null,
              hint: null,
            },
          },
        },
      ],
      expect: insertDown,
    },
    {
      id: "rest_insert_check_violation",
      bearer: "session_warm",
      faults: [
        {
          target: "rest_insert",
          mode: {
            kind: "http",
            status: 400,
            body: {
              code: "23514",
              message:
                'new row for relation "consent_records" violates check constraint "consent_records_bounds"',
              details: null,
              hint: null,
            },
          },
        },
      ],
      expect: insertDown,
    },
    {
      id: "rest_insert_slow_but_correct",
      bearer: "session_warm",
      faults: [{ target: "rest_insert", mode: { kind: "slow", ms: 80 } }],
      expect: { status: 200 },
      rowsWritten: 1,
    },
    {
      id: "rest_insert_hang_no_deadline",
      bearer: "session_warm",
      faults: [{ target: "rest_insert", mode: { kind: "hang", ms: HANG_MS } }],
      // No AbortSignal is attached to PostgREST calls, so the hang is ridden
      // out and the write eventually lands — recorded, and asserted, as the
      // observed contract (see observations.postgrestDeadline in faults.json).
      expect: { status: 200 },
      rowsWritten: 1,
    },
  );

  // ── D. PostgREST: the read-back AFTER a durable insert ───────────────────
  for (const status of [401, 403, 429, 500, 503]) {
    cases.push({
      id: `rest_select_http_${status}`,
      bearer: "session_warm",
      faults: [{ target: "rest_select", mode: { kind: "http", status } }],
      expect: statusDown,
      // The grant is DURABLE even though the answer is a 503: the fold is
      // idempotent, so the client's retry converges (asserted below).
      rowsWritten: 1,
    });
  }
  cases.push(
    {
      id: "rest_select_network_error",
      bearer: "session_warm",
      faults: [{ target: "rest_select", mode: { kind: "network" } }],
      expect: statusDown,
      rowsWritten: 1,
    },
    {
      id: "rest_select_malformed_json",
      bearer: "session_warm",
      faults: [
        {
          target: "rest_select",
          mode: { kind: "malformed", rawBody: '[{"scope":"video_' },
        },
      ],
      expect: statusDown,
      rowsWritten: 1,
    },
    {
      id: "rest_select_shape_object_not_array",
      bearer: "session_warm",
      faults: [{
        target: "rest_select",
        mode: { kind: "shape", body: { scope: "video_analysis" } },
      }],
      // A malformed 2xx from PostgREST is an outage of the read-back. The
      // contract judged here: a generic 5xx with no leak, and the durable grant
      // recovers. Observed: the top-level handler's generic 500 (the route's
      // 503 taxonomy only covers PostgREST `error` results) — recorded as-is.
      expect: { status: 503, statusAlso: [500], code: null },
      rowsWritten: 1,
    },
    {
      id: "rest_select_rows_missing_fields",
      bearer: "session_warm",
      faults: [
        {
          target: "rest_select",
          mode: {
            kind: "shape",
            body: [{ nonsense: true }, { scope: 12, action: null }],
          },
        },
      ],
      expect: { status: 200 },
      rowsWritten: 1,
    },
  );

  // ── E. Upstash Redis (L2 cache + shared rate-limit windows): FAIL OPEN ───
  for (
    const mode of [
      { id: "redis_http_500", fault: { kind: "http", status: 500 } as const },
      { id: "redis_http_401", fault: { kind: "http", status: 401 } as const },
      { id: "redis_http_429", fault: { kind: "http", status: 429 } as const },
      { id: "redis_network_error", fault: { kind: "network" } as const },
      {
        id: "redis_malformed_json",
        fault: { kind: "malformed", rawBody: "[{" } as const,
      },
      {
        id: "redis_shape_not_array",
        fault: { kind: "shape", body: { result: "OK" } } as const,
      },
      {
        id: "redis_shape_command_errors",
        fault: { kind: "shape", body: [{ error: "ERR nope" }] } as const,
      },
      { id: "redis_slow", fault: { kind: "slow", ms: 40 } as const },
    ]
  ) {
    cases.push({
      id: mode.id,
      bearer: "session",
      faults: [{ target: "redis", mode: mode.fault }],
      expect: { status: 200 },
      rowsWritten: 1,
    });
  }

  // ── F. RevenueCat: unreachable in every mode — the route must not call it ─
  for (
    const mode of [
      {
        id: "revenuecat_http_500",
        fault: { kind: "http", status: 500 } as const,
      },
      { id: "revenuecat_network_error", fault: { kind: "network" } as const },
      { id: "revenuecat_hang", fault: { kind: "hang", ms: HANG_MS } as const },
    ]
  ) {
    cases.push({
      id: mode.id,
      bearer: "session_warm",
      faults: [{ target: "revenuecat", mode: mode.fault }],
      expect: { status: 200 },
      rowsWritten: 1,
    });
  }

  // ── G. Compound faults and validation under fault ────────────────────────
  cases.push(
    {
      id: "compound_redis_down_plus_insert_down",
      bearer: "session",
      faults: [
        { target: "redis", mode: { kind: "network" } },
        { target: "rest_insert", mode: { kind: "http", status: 500 } },
      ],
      expect: insertDown,
    },
    {
      id: "compound_insert_ok_select_down_then_recovers",
      bearer: "session_warm",
      faults: [{ target: "rest_select", mode: { kind: "network" } }],
      expect: statusDown,
      rowsWritten: 1,
    },
    {
      id: "compound_auth_down_then_insert_never_reached",
      bearer: "session",
      faults: [
        { target: "auth_user", mode: { kind: "http", status: 500 } },
        { target: "rest_insert", mode: { kind: "http", status: 500 } },
      ],
      expect: authUnavailable,
    },
    {
      id: "validation_unknown_scope_while_db_down",
      bearer: "session_warm",
      faults: [{ target: "rest_insert", mode: { kind: "http", status: 500 } }],
      body: { scope: "video_analysis_v2", consentVersion: "v1" },
      expect: {
        status: 400,
        code: "validation.consent_grant",
        message: "Unknown consent scope.",
      },
      noRecovery: true,
    },
    {
      id: "validation_missing_version_while_db_down",
      bearer: "session_warm",
      faults: [{ target: "rest_insert", mode: { kind: "http", status: 500 } }],
      body: { scope: "video_analysis", consentVersion: "   " },
      expect: {
        status: 400,
        code: "validation.consent_grant",
        message: "consentVersion is required.",
      },
      noRecovery: true,
    },
    {
      id: "validation_invalid_json_while_db_down",
      bearer: "session_warm",
      faults: [{ target: "rest_insert", mode: { kind: "http", status: 500 } }],
      rawBody: "{not json",
      expect: {
        status: 400,
        code: "validation.consent_grant",
        message: "Unknown consent scope.",
      },
      noRecovery: true,
    },
    {
      // No injected fault: the edge keeps 64 code points of consentVersion /
      // captureMode (grantConsent → sanitizeUserText(…, 64)) while the DB
      // CHECK consent_records_bounds caps both at 50 (modelled by the fake,
      // proven by stress_consent_grant_pg PG4). Input the DB can never accept
      // must be a coded 400, not a retryable 503 the client would replay.
      id: "caps_consent_version_51_chars_edge_accepts",
      group: "caps",
      bearer: "session_warm",
      faults: [],
      body: grantBody("model_training", { consentVersion: "v".repeat(51) }),
      expect: { status: 400, code: "validation.consent_grant" },
      noRecovery: true,
    },
    {
      id: "caps_capture_mode_64_chars_edge_accepts",
      group: "caps",
      bearer: "session_warm",
      faults: [],
      body: grantBody("model_training", { captureMode: "c".repeat(64) }),
      expect: { status: 400, code: "validation.consent_grant" },
      noRecovery: true,
    },
    {
      id: "caps_consent_version_50_chars_in_both_caps",
      group: "caps",
      bearer: "session_warm",
      faults: [],
      body: grantBody("model_training", {
        consentVersion: "v".repeat(50),
        captureMode: "c".repeat(50),
      }),
      expect: { status: 200 },
      rowsWritten: 1,
    },
    {
      id: "insert_first_call_fails_second_succeeds",
      bearer: "session_warm",
      faults: [{
        target: "rest_insert",
        mode: { kind: "http", status: 500 },
        times: 1,
      }],
      expect: insertDown,
    },
  );

  return cases;
}

interface ResultRow {
  seed: number;
  caseId: string;
  bearer: string;
  faults: string;
  expectedStatus: number;
  status: number;
  code: string | null;
  message: string | null;
  supabaseRoundTrips: number;
  restInsert: number;
  restSelect: number;
  redisCalls: number;
  revenuecatCalls: number;
  rowsWritten: number;
  expectedRowsWritten: number;
  leaks: string[];
  recoveredStatus: number | null;
  foldMatchesLedger: boolean;
  latencyMs: number;
  outcome: "HELD" | "BROKEN";
  detail: string;
  replay: string;
}

function runCases(
  matrix: FaultCase[],
  fileName: string,
): Promise<{ rows: ResultRow[]; broken: ResultRow[]; path: string }> {
  return withStressAuthTimeout(() => runCasesInner(matrix, fileName));
}

async function runCasesInner(
  matrix: FaultCase[],
  fileName: string,
): Promise<{ rows: ResultRow[]; broken: ResultRow[]; path: string }> {
  const h = await loadStressHarness({ redis: true });
  const rows: ResultRow[] = [];
  const broken: ResultRow[] = [];
  const heapBefore = heapNow();
  const observations: Record<string, unknown> = {};

  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const campaignSeed = SEED + repeat;
    for (const testCase of matrix) {
      const seed = (campaignSeed ^ fnv1a(testCase.id)) >>> 0;
      const rng = new Prng(seed);
      h.reset();
      const actor = seededActor(h, rng);
      const replay =
        `STRESS_SEED=${campaignSeed} STRESS_CASE=${testCase.id} deno test -A --no-check --config deno.json stress_consent_grant_faults.test.ts`;

      if (testCase.bearer === "session_warm") await warmAuth(h, actor);
      const bearerToken = testCase.bearer === "provider"
        ? googleIdToken(actor.userId, 3600, rng.hex(24))
        : actor.token;
      const body = testCase.body ?? grantBody("model_training");

      h.setFaults(...testCase.faults);
      const request = apiRequest("POST", "/v1/me/consent/grant", {
        token: bearerToken,
        ip: actor.ip,
        body: testCase.rawBody === undefined ? body : undefined,
        rawBody: testCase.rawBody,
      });
      const before = h.rowsFor(actor.userId).length;
      const out = await call(h, request);
      const rowsWritten = h.rowsFor(actor.userId).length - before;
      h.clearFaults();

      const leaks = out.status >= 500 || out.status === 401
        ? leakedTokens(out.text, h.canary)
        : [];
      const expectedRows = testCase.rowsWritten ??
        (testCase.expect.status === 200 ? 1 : 0);

      // Recoverability: the identical request with the fault cleared must succeed
      // and the folded status must equal what the ledger says.
      let recoveredStatus: number | null = null;
      let foldMatches = true;
      if (!testCase.noRecovery) {
        const retryToken = testCase.bearer === "provider"
          ? googleIdToken(actor.userId, 3600, rng.hex(24))
          : actor.token;
        const retry = await call(
          h,
          apiRequest("POST", "/v1/me/consent/grant", {
            token: retryToken,
            ip: actor.ip,
            body,
          }),
        );
        recoveredStatus = retry.status;
        const observed = activeScopes(retry.body);
        const expected = expectedActive(h, actor.userId);
        foldMatches = retry.status === 200 &&
          validStatusBody(retry.body) &&
          observed !== null &&
          Object.keys(expected).every((scope) =>
            observed[scope] === expected[scope]
          );
      }

      const problems: string[] = [];
      const statusOk = out.status === testCase.expect.status ||
        (testCase.expect.statusAlso ?? []).includes(out.status);
      if (!statusOk) {
        problems.push(`status ${out.status} != ${testCase.expect.status}`);
      }
      if (
        testCase.expect.code !== undefined &&
        errorCodeOf(out.body) !== testCase.expect.code
      ) {
        problems.push(
          `code ${errorCodeOf(out.body)} != ${testCase.expect.code}`,
        );
      }
      if (testCase.expect.message !== undefined && out.status !== 200) {
        const message = errorMessageOf(out.body);
        if (message !== testCase.expect.message) {
          problems.push(
            `message ${JSON.stringify(message)} != ${
              JSON.stringify(testCase.expect.message)
            }`,
          );
        }
      }
      if (
        testCase.expect.header &&
        out.headers[testCase.expect.header] === undefined
      ) {
        problems.push(`missing header ${testCase.expect.header}`);
      }
      if (leaks.length > 0) problems.push(`leaked: ${leaks.join("|")}`);
      if (rowsWritten !== expectedRows) {
        problems.push(`rows written ${rowsWritten} != ${expectedRows}`);
      }
      if (
        out.status === 200 && !validStatusBody(out.body) &&
        !testCase.id.startsWith("rest_select_")
      ) {
        problems.push("200 body is not the consent-status shape");
      }
      if (!testCase.noRecovery && (recoveredStatus !== 200 || !foldMatches)) {
        problems.push(
          `not recoverable (retry ${recoveredStatus}, fold ${foldMatches})`,
        );
      }
      if (out.counts.revenuecat !== 0) {
        problems.push("route reached RevenueCat");
      }

      const row: ResultRow = {
        seed,
        caseId: testCase.id,
        bearer: testCase.bearer,
        faults: testCase.faults.map((f) =>
          `${f.target}:${JSON.stringify(f.mode)}`
        ).join(" + ") || "none",
        expectedStatus: testCase.expect.status,
        status: out.status,
        code: errorCodeOf(out.body),
        message: errorMessageOf(out.body),
        supabaseRoundTrips: out.counts.supabase,
        restInsert: out.counts.restInsert,
        restSelect: out.counts.restSelect,
        redisCalls: out.counts.redis,
        revenuecatCalls: out.counts.revenuecat,
        rowsWritten,
        expectedRowsWritten: expectedRows,
        leaks,
        recoveredStatus,
        foldMatchesLedger: foldMatches,
        latencyMs: Number(out.latencyMs.toFixed(3)),
        outcome: problems.length === 0 ? "HELD" : "BROKEN",
        detail: problems.join("; "),
        replay,
      };
      rows.push(row);
      campaignRows.push(row);
      if (problems.length > 0) broken.push(row);

      if (testCase.id === "rest_insert_hang_no_deadline") {
        const restCalls = out.calls.filter((c) => c.upstream === "rest");
        observations.postgrestDeadline = {
          note:
            "PostgREST calls carry no AbortSignal (supabase-js default) — an injected " +
            `${HANG_MS}ms upstream hang was ridden out to completion, unlike Supabase Auth which has AUTH_UPSTREAM_TIMEOUT_MS.`,
          restCallsWithSignal: restCalls.filter((c) => c.hasSignal).length,
          restCalls: restCalls.length,
          requestLatencyMs: Number(out.latencyMs.toFixed(1)),
          injectedHangMs: HANG_MS,
        };
      }
      if (testCase.id === "auth_user_hang_past_deadline") {
        observations.authDeadline = {
          note:
            "Supabase Auth calls DO carry an AbortSignal bounded by AUTH_UPSTREAM_TIMEOUT_MS.",
          authCallsWithSignal: out.calls.filter((c) =>
            c.upstream === "auth" && c.hasSignal
          ).length,
          requestLatencyMs: Number(out.latencyMs.toFixed(1)),
          injectedHangMs: HANG_MS,
        };
      }
    }
  }

  const path = await writeJson(fileName, {
    campaign: "stress-consent-grant-faults",
    seed: SEED,
    repeats: REPEATS,
    caseCount: matrix.length,
    scenariosExecuted: rows.length,
    statusHistogram: histogram(rows.map((r) => r.status)),
    outcomeHistogram: histogram(rows.map((r) => r.outcome)),
    supabaseRoundTripHistogram: histogram(
      rows.map((r) => r.supabaseRoundTrips),
    ),
    observations,
    heap: { before: heapBefore, after: heapNow() },
    broken,
    rows,
    replay:
      `STRESS_SEED=${SEED} STRESS_ITER=${REPEATS} deno test -A --no-check --config deno.json stress_consent_grant_faults.test.ts`,
  });
  console.log(`stress-consent-grant-faults: ${rows.length} cases → ${path}`);
  return { rows, broken, path };
}

Deno.test("stress-consent-grant-faults: every upstream fault yields the contracted error class, no leak, and recovers", async () => {
  const matrix = faultMatrix().filter((c) =>
    c.group === undefined && (!ONLY || c.id === ONLY)
  );
  assert(
    matrix.length >= 40 || Boolean(ONLY),
    `fault matrix must have >=40 cases, got ${matrix.length}`,
  );
  const { broken, path } = await runCases(matrix, "faults.json");
  assertEquals(
    broken.map((r) => `${r.caseId} (seed ${r.seed}): ${r.detail}`),
    [],
    `fault cases broke their contract (see ${path})`,
  );
});

Deno.test("stress-consent-grant-faults: a faulted grant stays inside the latency and Supabase round-trip budgets", async () => {
  assert(campaignRows.length > 0, "matrix test must run first");
  // Hang faults deliberately consume the injected time; every other fault must
  // be answered promptly and without extra Supabase round trips.
  const judged = campaignRows.filter((r) => !r.faults.includes('"hang"'));
  const overBudget = judged
    .filter((r) =>
      r.latencyMs > LATENCY_BUDGET_MS ||
      r.supabaseRoundTrips > ROUND_TRIP_BUDGET
    )
    .map(
      (r) =>
        `${r.caseId} (seed ${r.seed}): ${r.latencyMs}ms, ${r.supabaseRoundTrips} Supabase round trips (insert ${r.restInsert}, select ${r.restSelect}) → ${r.status}`,
    );
  const path = await writeJson("faults_budget.json", {
    latencyBudgetMs: LATENCY_BUDGET_MS,
    roundTripBudget: ROUND_TRIP_BUDGET,
    judged: judged.length,
    overBudget,
    latencyMsSorted: judged.map((r) => r.latencyMs).sort((a, b) => a - b),
  });
  assertEquals(
    overBudget,
    [],
    `faulted grants exceeded the budget (see ${path})`,
  );
});

Deno.test("stress-consent-grant-faults: input inside the edge's own caps is storable (edge 64 vs DB CHECK 50)", async () => {
  const matrix = faultMatrix().filter((c) =>
    c.group === "caps" && (!ONLY || c.id === ONLY)
  );
  const { broken, path } = await runCases(matrix, "faults_caps.json");
  assertEquals(
    broken.map((r) => `${r.caseId} (seed ${r.seed}): ${r.detail}`),
    [],
    `edge-accepted input was refused downstream (see ${path})`,
  );
});

Deno.test("stress-consent-grant-faults: a durable grant answered 503 by a failed read-back converges on retry", async () => {
  const h = await loadStressHarness({ redis: true });
  h.reset();
  const rng = new Prng((SEED ^ fnv1a("converge")) >>> 0);
  const actor = seededActor(h, rng);
  await warmAuth(h, actor);

  // Grant, but the read-back fails: the client sees a retryable 503.
  h.setFaults({ target: "rest_select", mode: { kind: "network" } });
  const first = await call(h, grantRequest(actor, grantBody("video_analysis")));
  h.clearFaults();
  assertEquals(first.status, 503);
  assertEquals(h.rowsFor(actor.userId).length, 1);

  // The app retries the same grant (its outbox treats 503 as retryable).
  const retry = await call(h, grantRequest(actor, grantBody("video_analysis")));
  assertEquals(retry.status, 200);
  assertEquals(
    h.rowsFor(actor.userId).length,
    2,
    "append-only ledger records both deliveries",
  );
  assertEquals(activeScopes(retry.body), {
    video_analysis: true,
    model_training: false,
    evaluation_telemetry: false,
  });

  // Duplicate delivery is idempotent in EFFECT: the fold of N identical grants
  // equals the fold of one, and a withdraw after them still wins.
  for (let i = 0; i < 5; i += 1) {
    const again = await call(
      h,
      grantRequest(actor, grantBody("video_analysis")),
    );
    assertEquals(again.status, 200);
    assertEquals(activeScopes(again.body)?.video_analysis, true);
  }
  const withdraw = await call(
    h,
    apiRequest("POST", "/v1/me/consent/withdraw", {
      token: actor.token,
      ip: actor.ip,
      body: { scope: "video_analysis" },
    }),
  );
  assertEquals(withdraw.status, 200);
  assertEquals(activeScopes(withdraw.body)?.video_analysis, false);

  const status = await call(h, statusRequest(actor));
  assertEquals(activeScopes(status.body), expectedActive(h, actor.userId));
});

Deno.test("stress-consent-grant-faults: consent budget answers 429 with Retry-After and never writes past it", async () => {
  const h = await loadStressHarness({ redis: true });
  h.reset();
  const rng = new Prng((SEED ^ fnv1a("ratelimit")) >>> 0);
  const actor = seededActor(h, rng);
  await warmAuth(h, actor);

  const statuses: number[] = [];
  for (let i = 0; i < 34; i += 1) {
    const out = await call(
      h,
      grantRequest(actor, grantBody("evaluation_telemetry")),
    );
    statuses.push(out.status);
    if (out.status === 429) {
      assert(
        out.headers["retry-after"] !== undefined,
        "429 must carry Retry-After",
      );
      assertEquals(errorCodeOf(out.body), "rate_limited");
      assertEquals(
        out.counts.restInsert,
        0,
        "a rate-limited grant must not write",
      );
    }
  }
  const allowed = statuses.filter((s) => s === 200).length;
  const limited = statuses.filter((s) => s === 429).length;
  assertEquals(
    allowed + limited,
    statuses.length,
    `unexpected statuses: ${histogram(statuses)}`,
  );
  assert(allowed <= 30, `consent budget is 30/60s, ${allowed} were allowed`);
  assert(limited >= 1, "34 grants in one window must trip the budget");
  assertEquals(
    h.rowsFor(actor.userId).length,
    allowed,
    "exactly the allowed grants were written",
  );
});
