/**
 * STRESS · fuzz/boundary · POST /v1/me/consent/grant (edge route)
 *
 * Drives the REAL edge handler in process (routesHarness captures the
 * `Deno.serve` callback of supabase/functions/api/index.ts; GoTrue, PostgREST,
 * RevenueCat and Apple are fetch-level stubs — no network, no hosted project)
 * with seeded, generated requests: method, path, query, headers
 * (authorization, content-type, content-length, x-request-id, x-forwarded-for,
 * noise), body bytes (valid/invalid objects, non-JSON, invalid UTF-8, 5 MB
 * boundary, 200k-deep nesting) and injected PostgREST faults.
 *
 * Per request it asserts, against the model in stress_consent_grant_gen.ts:
 *   - the status equals the modelled one, and every rejection is one of
 *     400/401/403/404/405/413/415/429;
 *   - 5xx only ever appears where a fault was injected, with a generic body,
 *     no error code, no stack trace and no upstream/DB detail (a per-iteration
 *     canary string is planted in every injected upstream error);
 *   - `x-request-id` is present on every response — echoed when the client
 *     sent a well-formed one, a freshly minted UUID otherwise — and exactly
 *     one `{"evt":"api_request"}` access-log line carries the same id;
 *   - JSON security headers (nosniff, no-store) on every response;
 *   - NO write on any rejected request, exactly one insert + one caller-scoped
 *     reload on success, the inserted row equals the sanitized model row, and
 *     every PostgREST call bears the caller's own session (RLS);
 *   - a 200 body is the fold of the caller's ledger.
 *
 * Scale: STRESS_ITER iterations (default 300 so the file can live in
 * `deno task test`; the campaign of record runs 3000+).
 *
 *   cd supabase/functions/api/__wf__
 *   deno task test                                  # default 300
 *   STRESS_ITER=3000 STRESS_SEED=20260904 \
 *     STRESS_OUT_DIR=/tmp/stress-consent/ \
 *     deno test -A --no-check --config deno.json stress_consent_grant_fuzz.test.ts
 *
 * Replay a single iteration (the JSON table's `replay` field):
 *   STRESS_REPLAY=20260904:1487 deno test -A --no-check --config deno.json \
 *     stress_consent_grant_fuzz.test.ts --filter "campaign"
 *
 * Every run writes <STRESS_OUT_DIR>/fuzz-boundary.json — the seed → outcome
 * table (one row per iteration: seed, replay key, tags, status, predicted
 * status, request-id, write count, failures) plus histograms and the 5xx list.
 */
import { assert, assertEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL } from "./routesHarness.ts";
import {
  buildRequest,
  checkOutcome,
  generateScenario,
  ipPool,
  type LedgerRow,
  type Observed,
  outcomeRow,
  type OutcomeRow,
  predict,
  RateModel,
  type RecordedRestCall,
  replaySelection,
  type Scenario,
  STRESS_ITER,
  STRESS_SEED,
  stressOutDir,
  summarize,
  userPool,
  writeStressReport,
} from "./stress_consent_grant_gen.ts";

const h = await loadHarness();
const innerFetch = globalThis.fetch;

// ── Per-campaign fake consent ledger + fault injection ───────────────────────

interface RequestState {
  scenario: Scenario | null;
  restCalls: RecordedRestCall[];
  writes: LedgerRow[];
  unexpectedUpstream: string[];
}

const ledger = new Map<string, LedgerRow[]>();
let rowCounter = 0;
let state: RequestState = { scenario: null, restCalls: [], writes: [], unexpectedUpstream: [] };

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Rows PostgREST would return for `?user_id=eq.<id>` ordered by created_at,id. */
function ledgerFor(userId: string): LedgerRow[] {
  return ledger.get(userId) ?? [];
}

function authUserResponse(scenario: Scenario): Response | null {
  if (scenario.auth.kind !== "session") return null;
  switch (scenario.auth.verdict) {
    case "refused":
      return jsonResponse(401, { code: "bad_jwt", msg: "invalid JWT" });
    case "outage":
      return new Response("<html>Bad Gateway</html>", { status: 502 });
    case "no-provider":
      return jsonResponse(200, { id: scenario.auth.sub, email: null, app_metadata: {} });
    case "live":
      return jsonResponse(200, {
        id: scenario.auth.sub,
        email: "user@example.com",
        aud: "authenticated",
        role: "authenticated",
        app_metadata: { provider: "google", providers: ["google"] },
        user_metadata: {},
      });
  }
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const url = request.url;
  const scenario = state.scenario;

  if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
    const answer = scenario ? authUserResponse(scenario) : null;
    if (answer) return answer;
    state.unexpectedUpstream.push(`GET /auth/v1/user without a session scenario`);
    return jsonResponse(401, { msg: "no scenario" });
  }

  if (url.startsWith(`${SUPABASE_URL}/rest/v1/consent_records`)) {
    const parsed = new URL(url);
    const call: RecordedRestCall = {
      method: request.method,
      url,
      authorization: request.headers.get("Authorization"),
      apikey: request.headers.get("apikey"),
      body: null,
    };
    const fault = scenario?.fault ?? null;

    if (request.method === "POST") {
      const text = await request.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep raw
      }
      call.body = body;
      state.restCalls.push(call);
      if (fault?.kind === "insert-4xx") {
        return jsonResponse(fault.status, {
          code: "23514",
          message: `new row for relation "consent_records" violates check constraint`,
          details: fault.canary,
          hint: null,
        });
      }
      if (fault?.kind === "insert-401") {
        return jsonResponse(401, {
          code: "42501",
          message: `permission denied`,
          details: fault.canary,
        });
      }
      if (fault?.kind === "insert-5xx-html") {
        return new Response(`<html><body>Bad Gateway ${fault.canary}</body></html>`, {
          status: 502,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (fault?.kind === "insert-throw") {
        throw new TypeError(`network reset ${fault.canary}`);
      }
      const row = body as Record<string, unknown>;
      const stored: LedgerRow = {
        id: `00000000-0000-4000-8000-${String(++rowCounter).padStart(12, "0")}`,
        user_id: String(row.user_id),
        scope: String(row.scope),
        consent_version: String(row.consent_version),
        action: "grant",
        source: (row.source ?? null) as string | null,
        device: (row.device ?? null) as string | null,
        capture_mode: (row.capture_mode ?? null) as string | null,
        created_at: new Date(Date.UTC(2026, 0, 1) + rowCounter * 1000).toISOString(),
      };
      const rows = ledger.get(stored.user_id) ?? [];
      rows.push(stored);
      ledger.set(stored.user_id, rows);
      state.writes.push(stored);
      return new Response(null, { status: 201 });
    }

    if (request.method === "GET") {
      state.restCalls.push(call);
      if (fault?.kind === "select-5xx") {
        return jsonResponse(503, {
          code: "PGRST000",
          message: "could not connect to server",
          details: fault.canary,
        });
      }
      if (fault?.kind === "select-nonarray") {
        return jsonResponse(200, { unexpected: "object", canary: fault.canary });
      }
      const filter = parsed.searchParams.get("user_id") ?? "";
      const userId = filter.startsWith("eq.") ? filter.slice(3) : "";
      return jsonResponse(200, ledgerFor(userId));
    }

    state.restCalls.push(call);
    state.unexpectedUpstream.push(`${request.method} consent_records`);
    return new Response(null, { status: 405 });
  }

  const response = await innerFetch(input, init);
  if (response.status === 599) {
    state.unexpectedUpstream.push(`${request.method} ${url}`);
  }
  return response;
}) as typeof fetch;

// ── Console capture (access-log correlation, no test-output flooding) ─────────

const realLog = console.log;
const realError = console.error;
let logLines: string[] = [];
let errorLines: string[] = [];

function captureConsole(): void {
  logLines = [];
  errorLines = [];
  console.log = (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errorLines.push(
      args
        .map((a) =>
          typeof a === "string"
            ? a
            : a instanceof Error
              ? `${a.name}: ${a.message}`
              : JSON.stringify(a),
        )
        .join(" "),
    );
  };
}

function restoreConsole(): void {
  console.log = realLog;
  console.error = realError;
}

// ── One iteration ────────────────────────────────────────────────────────────

const headersOf = (response: Response): Record<string, string> => {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => (out[key.toLowerCase()] = value));
  return out;
};

async function runIteration(
  scenario: Scenario,
  rates: RateModel,
): Promise<{ row: OutcomeRow; accessLogFailures: string[] }> {
  state = { scenario, restCalls: [], writes: [], unexpectedUpstream: [] };
  const request = buildRequest(scenario);
  const prediction = rates.apply(request, predict(scenario, request), Date.now());
  captureConsole();
  let response: Response;
  let durationMs: number;
  try {
    const startedAt = performance.now();
    response = await h.handler(request);
    durationMs = performance.now() - startedAt;
  } finally {
    restoreConsole();
  }
  const bodyText = await response.text();
  const headers = headersOf(response);
  const userId = prediction.userId;
  const observed: Observed = {
    status: response.status,
    headers,
    bodyText,
    restCalls: state.restCalls,
    writes: state.writes,
    unexpectedUpstream: state.unexpectedUpstream,
    ledgerAfter: userId === null ? [] : ledgerFor(userId),
  };
  const check = checkOutcome(scenario, request, prediction, observed);

  // Access log: exactly one api_request line, carrying the response's request id.
  const accessLogFailures: string[] = [];
  const accessLines = logLines.filter((line) => line.includes('"evt":"api_request"'));
  if (accessLines.length !== 1) {
    accessLogFailures.push(`${accessLines.length} api_request log lines`);
  } else {
    const rid = headers["x-request-id"] ?? "";
    if (!accessLines[0].includes(`"requestId":${JSON.stringify(rid)}`)) {
      accessLogFailures.push(`access log request id does not match ${rid}`);
    }
    if (accessLines[0].includes("consentVersion") || accessLines[0].includes("Bearer ")) {
      accessLogFailures.push("access log line carries request payload/credential material");
    }
  }
  check.failures.push(...accessLogFailures);
  return { row: outcomeRow(scenario, prediction, observed, check, durationMs), accessLogFailures };
}

// ── Campaign ─────────────────────────────────────────────────────────────────

Deno.test(
  "stress consent-grant fuzz/boundary campaign — generated requests against the real handler",
  async (t) => {
    const replay = replaySelection();
    const iterations = replay ? replay.length : STRESS_ITER;
    const pools = {
      users: userPool(STRESS_SEED, Math.max(iterations, STRESS_ITER)),
      ips: ipPool(STRESS_SEED, Math.max(iterations, STRESS_ITER)),
    };
    const rates = new RateModel();
    const rows: OutcomeRow[] = [];
    const heapBefore = Deno.memoryUsage();

    await t.step(`campaign: ${iterations} generated requests`, async () => {
      if (replay) {
        for (const entry of replay) {
          const scenario = generateScenario(entry.campaignSeed, entry.iteration, {
            users: userPool(entry.campaignSeed, STRESS_ITER),
            ips: ipPool(entry.campaignSeed, STRESS_ITER),
          });
          rows.push((await runIteration(scenario, rates)).row);
        }
        return;
      }
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const scenario = generateScenario(STRESS_SEED, iteration, pools);
        rows.push((await runIteration(scenario, rates)).row);
      }
    });

    const heapAfter = Deno.memoryUsage();
    const summary = summarize(rows);
    const reportPath = await writeStressReport("fuzz-boundary", {
      unit: "route-post-v1-me-consent-grant",
      lens: "fuzz-boundary",
      campaignSeed: STRESS_SEED,
      iterations,
      replayCommand: `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${iterations} deno test -A --no-check --config deno.json stress_consent_grant_fuzz.test.ts`,
      singleReplayCommand:
        "STRESS_REPLAY=<campaignSeed>:<iteration> deno test -A --no-check --config deno.json stress_consent_grant_fuzz.test.ts",
      summary,
      heap: { before: heapBefore, after: heapAfter },
      rows,
    });
    console.log(`stress-consent-grant: ${rows.length} iterations → ${reportPath}`);

    await t.step("every rejection status is in the allowlist and matches the model", () => {
      const offenders = rows.filter((r) =>
        r.failures.some((f) => f.startsWith("status ") || f.includes("allowlist")),
      );
      assertEquals(
        offenders.map(
          (r) => `${r.replay} → ${r.status} (expected ${r.predicted}) ${r.failures.join("; ")}`,
        ),
        [],
      );
    });

    await t.step("no 5xx outside injected upstream faults, and every 5xx body is generic", () => {
      const unexplained = summary.fiveXx.filter((entry) => !entry.injected);
      assertEquals(unexplained, []);
      const leaks = rows.filter((r) =>
        r.failures.some((f) => f.includes("leak") || f.includes("generic") || f.includes("canary")),
      );
      assertEquals(
        leaks.map((r) => `${r.replay}: ${r.failures.join("; ")}`),
        [],
      );
    });

    await t.step("no write on any rejected request", () => {
      assertEquals(summary.writesOnRejection, []);
      const writeFailures = rows.filter((r) =>
        r.failures.some((f) => f.startsWith("writes ") || f.includes("write happened")),
      );
      assertEquals(
        writeFailures.map((r) => `${r.replay}: ${r.failures.join("; ")}`),
        [],
      );
    });

    await t.step("x-request-id on every response, echoed only when well formed", () => {
      const failures = rows.filter((r) =>
        r.failures.some(
          (f) => f.includes("request-id") || f.includes("request id") || f.includes("x-request-id"),
        ),
      );
      assertEquals(
        failures.map((r) => `${r.replay}: ${r.failures.join("; ")}`),
        [],
      );
    });

    await t.step("all other invariants held on every iteration", () => {
      const failures = rows.filter((r) => r.failures.length > 0);
      assertEquals(
        failures
          .slice(0, 20)
          .map((r) => `${r.replay} [${r.tags.join(",")}] → ${r.failures.join("; ")}`),
        [],
        `${failures.length}/${rows.length} iterations failed; full table at ${reportPath}`,
      );
    });

    await t.step("the campaign actually exercised the interesting shapes", () => {
      assert(rows.length === iterations, `executed ${rows.length} of ${iterations}`);
      if (iterations < 200) return;
      const tags = summary.tagHistogram;
      for (const required of [
        "kind:mixed",
        "kind:wrong-route",
        "auth:none",
        "rid:malformed",
        "cl:none",
      ]) {
        assert((tags[required] ?? 0) > 0, `no iteration carried ${required}`);
      }
      assert((summary.statusHistogram["200"] ?? 0) > 0, "no successful grant in the campaign");
      assert((summary.statusHistogram["400"] ?? 0) > 0, "no validation rejection in the campaign");
      assert((summary.statusHistogram["401"] ?? 0) > 0, "no auth rejection in the campaign");
      assert((summary.statusHistogram["404"] ?? 0) > 0, "no wrong-route rejection in the campaign");
    });
  },
);

/** A PostgREST 5xx on the post-insert reload is retried inside supabase-js
 * (pinned exactly in ../deno.lock) with 1 s / 2 s / 4 s backoff before the
 * handler's generic 503 goes out — the write itself is never re-sent. Pinned
 * here so a dependency bump that changes the retry shape is visible, and so
 * the ~7 s wall-clock cost of a reload outage is measured, not inferred. */
Deno.test(
  "stress consent-grant: a reload 5xx is retried by the client library, the insert is not",
  async () => {
    const pools = {
      users: userPool(STRESS_SEED, STRESS_ITER),
      ips: ipPool(STRESS_SEED, STRESS_ITER),
    };
    let scenario: Scenario | null = null;
    for (let iteration = 0; iteration < 100_000 && scenario === null; iteration += 1) {
      const candidate = generateScenario(STRESS_SEED, iteration, pools);
      if (candidate.fault?.kind !== "select-5xx") continue;
      if (predict(candidate, buildRequest(candidate)).stage !== "select-fault") continue;
      scenario = candidate;
    }
    assert(scenario !== null, "no select-5xx accept-path scenario in the first 100k seeds");
    const { row } = await runIteration(scenario, new RateModel());
    const gets = state.restCalls.filter((c) => c.method === "GET").length;
    const posts = state.restCalls.filter((c) => c.method === "POST").length;
    const observation = {
      replay: row.replay,
      status: row.status,
      durationMs: row.durationMs,
      postgrestGetAttempts: gets,
      postgrestPostAttempts: posts,
    };
    const path = await writeStressReport("reload-outage-retry", observation);
    console.log(`stress-consent-grant: reload-outage observation → ${path}`);
    assertEquals(row.failures, []);
    assertEquals(row.status, 503);
    assertEquals(posts, 1, "the insert was re-sent");
    assertEquals(gets, 4, "supabase-js retry shape changed — re-evaluate the outage cost");
    assert(row.durationMs >= 6_000, `retry backoff shorter than modelled: ${row.durationMs} ms`);
  },
);

Deno.test("stress consent-grant: report location is deterministic", () => {
  assert(stressOutDir().endsWith("/"));
});
