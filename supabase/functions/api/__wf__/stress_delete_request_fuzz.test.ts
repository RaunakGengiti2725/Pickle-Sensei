// stress-route-post-v1-me-delete-request / lens fuzz-boundary.
//
// Seeded fuzz + boundary campaign against the REAL handler for
// POST /v1/me/delete-request (see stress_delete_request_harness.ts for the
// generator, the fault-injecting upstream stub and the contract oracle).
//
//   STRESS_ITER=<n>          cases per campaign (default 250; the task-level
//                            campaign is ≥ 3000). Bursts send 4–6 requests.
//   STRESS_SEED=<n>          campaign seed (default 20260904).
//   STRESS_REPLAY=<s1,s2>    run ONLY these case seeds (replay a table row).
//   STRESS_OUT_DIR=<dir>     results table location (default
//                            artifacts/stress-delete-request/latest/, or
//                            .../replay/ when STRESS_REPLAY is set).
//
// Per request the campaign asserts:
//   • status == oracle (413 → 401 → 404 → 429 → 413 → 503 → 200 order);
//   • non-200 statuses ⊂ {400,401,403,404,405,413,415,429} unless an upstream
//     fault was INJECTED (then exactly one generic 5xx body, no leak markers,
//     no stack frames);
//   • x-request-id present, well-formed, echoed iff the sent one was valid;
//   • JSON security headers on every response;
//   • ZERO REST writes on every rejection; on 200 exactly one
//     account_deletion_requests upsert (own user_id, on_conflict=user_id,
//     challenge == response) and the feedback insert iff the survey was
//     usable, with sanitized bounded fields and server-stamped context;
//   • exactly one access-log record carrying the request id, without the
//     bearer, the body, the query string or the client IP;
//   • console output never contains the bearer or the free-text details.
//
// Results: <out>/fuzz_results.json (one row per request), <out>/fuzz_summary.json.

import { assert, assertEquals } from "@std/assert";
import {
  ALLOWED_REJECTION_STATUSES,
  authorizationFor,
  buildRequest,
  envInt,
  type Expectation,
  expectedFeedbackRow,
  expectedRequestIdEcho,
  expectFor,
  type FuzzCase,
  generateCase,
  GENERIC_500,
  GENERIC_503_DELETION,
  GENERIC_503_SESSION,
  histogram,
  iterationSeed,
  LEAK_MARKERS,
  loadStressRuntime,
  REQUEST_ID_RE,
  ROUTE_LIMIT,
  STRESS_SEED,
  type StressRuntime,
  UUID_V4_RE,
  writeJson,
} from "./stress_delete_request_harness.ts";
import { Prng } from "./xc_concurrency_harness.ts";

const STRESS_ITER = envInt("STRESS_ITER", 250);
const REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map(Number)
  .filter((n) => Number.isFinite(n) && n >= 0);

// deno-lint-ignore no-control-regex
const CONTROL_CHARS =
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const STACK_FRAME = /\n\s+at\s|\.ts:\d+:\d+/;

interface Row {
  seed: number;
  n: number;
  kind: string;
  method: string;
  path: string;
  pathKind: string;
  auth: string;
  ipHeader: string;
  requestIdKind: string;
  contentType: string | null;
  contentLengthKind: string;
  contentLength: string | null;
  bodyKind: string;
  bodyDescribe: string;
  bodyBytes: number;
  extraHeaders: string[];
  fault: string;
  expected: number;
  expectedWhy: string;
  status: number;
  requestId: string | null;
  restWrites: string[];
  rpcs: string[];
  authCalls: number;
  upstreamCalls: number;
  accessLogLines: number;
  durationMs: number;
  violations: string[];
  ok: boolean;
}

function bodyBytes(c: FuzzCase): number {
  if (c.body.streamBytes) return c.body.streamBytes;
  if (c.body.bytes) return c.body.bytes.byteLength;
  if (c.body.text !== undefined) {
    return new TextEncoder().encode(c.body.text).byteLength;
  }
  return 0;
}

function providerOf(c: FuzzCase): string {
  return c.auth === "apple" ? "apple" : "google";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function codePoints(s: string): number {
  return Array.from(s).length;
}

/** Run one request of a case and return its results row. */
async function runOne(
  rt: StressRuntime,
  c: FuzzCase,
  n: number,
  authorization: string | null,
  exp: Expectation,
  seenChallenges: Set<string>,
): Promise<Row> {
  rt.reset(c.fault);
  const request = buildRequest(c, authorization);
  const started = performance.now();
  const response = await rt.run(request);
  const text = await response.text();
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  const v: string[] = [];

  const status = response.status;
  const restWrites = rt.upstream.filter((u) => u.kind === "rest_write");
  const rpcs = rt.upstream.filter((u) => u.kind === "rpc");
  const authCalls = rt.upstream.filter((u) => u.kind === "auth").length;

  // ── status contract ──
  if (status !== exp.status) {
    v.push(`status ${status} != oracle ${exp.status} (${exp.why})`);
  }
  if (status !== 200 && !ALLOWED_REJECTION_STATUSES.has(status)) {
    if (status >= 500) {
      if (exp.status < 500) {
        v.push(`UNEXPLAINED 5xx ${status} (no fault injected)`);
      }
    } else v.push(`rejection status ${status} outside allowed set`);
  }

  // ── request id ──
  const requestId = response.headers.get("x-request-id");
  if (!requestId) v.push("x-request-id missing");
  else if (!REQUEST_ID_RE.test(requestId)) {
    v.push(`x-request-id malformed: ${JSON.stringify(requestId)}`);
  }
  const echo = expectedRequestIdEcho(c.requestId);
  if (echo !== null && requestId !== echo) {
    v.push(
      `valid x-request-id not echoed (sent ${
        JSON.stringify(c.requestId)
      }, got ${requestId})`,
    );
  }
  if (echo === null && c.requestId !== null && requestId === c.requestId) {
    v.push("invalid x-request-id was echoed verbatim");
  }

  // ── headers ──
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    v.push(`content-type ${JSON.stringify(ct)} not JSON`);
  }
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    v.push("missing X-Content-Type-Options: nosniff");
  }
  if (response.headers.get("cache-control") !== "no-store") {
    v.push("missing Cache-Control: no-store");
  }
  if (status === 429) {
    if (!response.headers.get("retry-after")) v.push("429 without Retry-After");
    if (response.headers.get("ratelimit-limit") !== String(ROUTE_LIMIT)) {
      v.push(`429 RateLimit-Limit != ${ROUTE_LIMIT}`);
    }
  }

  // ── body hygiene ──
  for (const marker of LEAK_MARKERS) {
    if (text.includes(marker)) {
      v.push(`body leaks marker ${JSON.stringify(marker)}`);
    }
  }
  if (STACK_FRAME.test(text)) v.push("body contains a stack frame");
  if (
    authorization && authorization.length > 16 &&
    text.includes(authorization.slice(7, 40))
  ) v.push("body echoes bearer token");
  if (text.includes(c.sub)) v.push("body contains the user id");
  const rawDetails = c.body.survey && typeof c.body.survey.details === "string"
    ? c.body.survey.details
    : "";
  if (rawDetails.length >= 16 && text.includes(rawDetails)) {
    v.push("body echoes survey details");
  }
  if (c.method.toUpperCase() !== "HEAD" && text.length > 4_096) {
    v.push(`body unexpectedly large (${text.length}B)`);
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (c.method.toUpperCase() !== "HEAD") v.push("body is not JSON");
  }
  if (status === 200) {
    if (!isRecord(parsed)) v.push("200 body not an object");
    else {
      const keys = Object.keys(parsed).sort();
      if (keys.join(",") !== "challenge,expiresAt") {
        v.push(`200 body keys ${keys.join(",")}`);
      }
      const challenge = parsed.challenge;
      if (typeof challenge !== "string" || !UUID_V4_RE.test(challenge)) {
        v.push("challenge not a v4 UUID");
      } else {
        if (seenChallenges.has(challenge)) {
          v.push("challenge repeated within case");
        }
        seenChallenges.add(challenge);
      }
      const exp = typeof parsed.expiresAt === "string"
        ? Date.parse(parsed.expiresAt)
        : NaN;
      const delta = exp - Date.now();
      if (!(delta > 14 * 60_000 && delta <= 15 * 60_000 + 1_000)) {
        v.push(`expiresAt not ~15min ahead (${delta}ms)`);
      }
    }
  } else if (c.method.toUpperCase() !== "HEAD") {
    if (
      !isRecord(parsed) || !isRecord(parsed.error) ||
      typeof parsed.error.message !== "string"
    ) {
      v.push("error body not {error:{message}}");
    } else {
      const message = parsed.error.message;
      if (message.length > 200) v.push("error message > 200 chars");
      if (
        status >= 500 &&
        ![GENERIC_500, GENERIC_503_DELETION, GENERIC_503_SESSION].includes(
          message,
        )
      ) {
        v.push(`5xx message not generic: ${JSON.stringify(message)}`);
      }
      if (Object.keys(parsed).length !== 1) {
        v.push("error body has extra top-level keys");
      }
    }
  }

  // ── writes ──
  if (exp.noUpstream && rt.upstream.length > 0) {
    v.push(`${rt.upstream.length} upstream call(s) on a pre-auth rejection`);
  }
  if (status !== 200) {
    const attempted = restWrites.filter((w) =>
      w.table === "account_deletion_feedback"
    );
    if (attempted.length > 0) {
      v.push("survey insert attempted on a non-200 response");
    }
    if (rpcs.length > 0) v.push("RPC called on a non-200 response");
    const expectedWrites =
      exp.status === 503 && exp.restWrites === 1 && status === 503 ? 1 : 0;
    if (restWrites.length !== expectedWrites) {
      v.push(
        `${restWrites.length} REST write(s) on ${status} (expected ${expectedWrites})`,
      );
    }
  } else {
    const upserts = restWrites.filter((w) =>
      w.table === "account_deletion_requests"
    );
    const feedback = restWrites.filter((w) =>
      w.table === "account_deletion_feedback"
    );
    const others = restWrites.filter((w) =>
      w.table !== "account_deletion_requests" &&
      w.table !== "account_deletion_feedback"
    );
    if (upserts.length !== 1) {
      v.push(`${upserts.length} account_deletion_requests write(s) on 200`);
    }
    if (others.length > 0) {
      v.push(
        `unexpected writes: ${
          others.map((w) => `${w.method} ${w.table}`).join(",")
        }`,
      );
    }
    const up = upserts[0];
    if (up) {
      const url = new URL(up.url);
      if (url.searchParams.get("on_conflict") !== "user_id") {
        v.push("upsert without on_conflict=user_id");
      }
      if (!(up.prefer ?? "").includes("resolution=merge-duplicates")) {
        v.push("upsert without resolution=merge-duplicates");
      }
      if (!isRecord(up.body)) v.push("upsert body not an object");
      else {
        const keys = Object.keys(up.body).sort().join(",");
        if (keys !== "challenge,created_at,expires_at,user_id") {
          v.push(`upsert columns ${keys}`);
        }
        if (up.body.user_id !== c.sub) {
          v.push(
            `upsert user_id ${String(up.body.user_id)} != caller ${c.sub}`,
          );
        }
        if (isRecord(parsed)) {
          if (up.body.challenge !== parsed.challenge) {
            v.push("upsert challenge != response challenge");
          }
          if (up.body.expires_at !== parsed.expiresAt) {
            v.push("upsert expires_at != response expiresAt");
          }
        }
        const created = typeof up.body.created_at === "string"
          ? Date.parse(up.body.created_at)
          : NaN;
        const expires = typeof up.body.expires_at === "string"
          ? Date.parse(up.body.expires_at)
          : NaN;
        if (
          !(expires - created >= 15 * 60_000 - 50 &&
            expires - created <= 15 * 60_000 + 1_000)
        ) {
          v.push(`upsert expires_at - created_at = ${expires - created}ms`);
        }
      }
    }
    if (exp.surveyInsert) {
      if (
        c.fault === "feedback_500" || c.fault === "feedback_throw" ||
        c.fault === "access_state_500" || c.fault === "profiles_throw"
      ) {
        // Survey-path faults must never turn the 200 into an error. A failed
        // context lookup still records the survey with that stamp null.
        if (feedback.length !== 1) {
          v.push(`${feedback.length} feedback insert(s) under ${c.fault}`);
        }
        const row = feedback[0]?.body;
        if (isRecord(row)) {
          if (row.user_id !== c.sub) {
            v.push("feedback.user_id != caller under fault");
          }
          if (
            c.fault === "access_state_500" &&
            (row.was_premium !== null || row.scored_count !== null)
          ) {
            v.push(
              "feedback stamped membership context although access_state failed",
            );
          }
          if (c.fault === "profiles_throw" && row.account_age_days !== null) {
            v.push(
              "feedback stamped account age although the profile read failed",
            );
          }
        }
      } else {
        if (feedback.length !== 1) {
          v.push(`${feedback.length} feedback insert(s) for a usable survey`);
        }
        if (rpcs.filter((r) => r.rpc === "access_state").length !== 1) {
          v.push("access_state RPC not called exactly once");
        }
        const upIdx = rt.upstream.indexOf(up);
        const fbIdx = feedback[0] ? rt.upstream.indexOf(feedback[0]) : -1;
        if (fbIdx >= 0 && fbIdx < upIdx) {
          v.push("feedback insert ordered before the challenge upsert");
        }
        const row = feedback[0]?.body;
        const want = expectedFeedbackRow(c, providerOf(c));
        if (!isRecord(row)) v.push("feedback body not an object");
        else if (want) {
          for (
            const key of [
              "user_id",
              "reason",
              "wanted",
              "details",
              "provider",
              "platform",
              "app_version",
            ]
          ) {
            if (row[key] !== want[key]) {
              v.push(
                `feedback.${key} ${JSON.stringify(row[key])} != expected ${
                  JSON.stringify(want[key])
                }`,
              );
            }
          }
          if (row.was_premium !== false) {
            v.push("feedback.was_premium not stamped from access_state");
          }
          if (row.scored_count !== 1) {
            v.push("feedback.scored_count not stamped from access_state");
          }
          if (
            typeof row.account_age_days !== "number" ||
            !Number.isInteger(row.account_age_days) || row.account_age_days < 0
          ) {
            v.push("feedback.account_age_days not a non-negative integer");
          }
          const details = row.details;
          if (typeof details === "string") {
            if (codePoints(details) > 500) {
              v.push(
                `feedback.details ${codePoints(details)} code points > 500`,
              );
            }
            if (CONTROL_CHARS.test(details)) {
              v.push("feedback.details contains control/spoofing chars");
            }
            if (details !== details.trim()) {
              v.push("feedback.details not trimmed");
            }
            if (/\s\s/.test(details)) {
              v.push("feedback.details has collapsed-whitespace violation");
            }
            if (details.length === 0) {
              v.push("feedback.details empty string instead of null");
            }
          }
          const appVersion = row.app_version;
          if (
            typeof appVersion === "string" &&
            (codePoints(appVersion) > 64 || appVersion.length === 0)
          ) {
            v.push("feedback.app_version out of bounds");
          }
          if (Object.keys(row).length > 10) {
            v.push(`feedback row has ${Object.keys(row).length} columns`);
          }
        }
      }
    } else {
      if (feedback.length !== 0) {
        v.push(`${feedback.length} feedback insert(s) without a usable survey`);
      }
      if (rpcs.length !== 0) v.push("RPC called without a usable survey");
    }
  }

  // ── access log ──
  if (rt.accessLog.length !== 1) {
    v.push(`${rt.accessLog.length} access-log records`);
  }
  const logLine = rt.accessLog[0] ?? "";
  if (logLine) {
    let log: unknown = null;
    try {
      log = JSON.parse(logLine);
    } catch {
      v.push("access log not JSON");
    }
    if (isRecord(log)) {
      if (log.requestId !== requestId) {
        v.push("access log requestId != response header");
      }
      if (log.status !== status) v.push("access log status != response status");
      if (log.method !== c.method.toUpperCase()) {
        v.push("access log method mismatch");
      }
    }
    if (
      authorization && authorization.length > 16 &&
      logLine.includes(authorization.slice(7, 40))
    ) v.push("access log contains bearer");
    if (logLine.includes(c.ip)) v.push("access log contains client IP");
    if (
      c.path.includes("?") &&
      logLine.includes(c.path.slice(c.path.indexOf("?")))
    ) v.push("access log contains query string");
    if (rawDetails.length >= 16 && logLine.includes(rawDetails)) {
      v.push("access log contains survey details");
    }
  }
  for (const line of rt.consoleLines) {
    if (
      authorization && authorization.length > 16 &&
      line.includes(authorization.slice(7, 40))
    ) v.push("console output contains bearer");
    if (rawDetails.length >= 16 && line.includes(rawDetails)) {
      v.push("console output contains survey details");
    }
  }

  return {
    seed: c.seed,
    n,
    kind: c.kind,
    method: c.method,
    path: c.path,
    pathKind: c.pathKind,
    auth: c.auth,
    ipHeader: c.ipHeader,
    requestIdKind: c.requestIdKind,
    contentType: c.contentType,
    contentLengthKind: c.contentLengthKind,
    contentLength: c.contentLength && c.contentLength.length > 40
      ? `${c.contentLength.slice(0, 40)}…(${c.contentLength.length})`
      : c.contentLength,
    bodyKind: c.body.kind,
    bodyDescribe: c.body.describe,
    bodyBytes: bodyBytes(c),
    extraHeaders: Object.keys(c.extraHeaders),
    fault: c.fault,
    expected: exp.status,
    expectedWhy: exp.why,
    status,
    requestId,
    restWrites: restWrites.map((w) => `${w.method} ${w.table}`),
    rpcs: rpcs.map((r) => String(r.rpc)),
    authCalls,
    upstreamCalls: rt.upstream.length,
    accessLogLines: rt.accessLog.length,
    durationMs,
    violations: v,
    ok: v.length === 0,
  };
}

export async function runCase(
  rt: StressRuntime,
  seed: number,
  allowOverLimitStream: boolean,
): Promise<Row[]> {
  const c = generateCase(seed, { allowOverLimitStream });
  const authorization = authorizationFor(
    c.auth,
    c.sub,
    new Prng(seed ^ 0x5bd1e995),
  );
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (let n = 1; n <= c.repeat; n++) {
    rows.push(await runOne(rt, c, n, authorization, expectFor(c, n), seen));
  }
  return rows;
}

Deno.test({
  name:
    `stress delete-request fuzz: seeded campaign (STRESS_ITER=${STRESS_ITER}, STRESS_SEED=${STRESS_SEED})`,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const rt = await loadStressRuntime();
    const seeds = REPLAY.length > 0
      ? REPLAY
      : Array.from({ length: STRESS_ITER }, (_, i) =>
        iterationSeed(STRESS_SEED, i));
    const rows: Row[] = [];
    const started = performance.now();
    for (const seed of seeds) rows.push(...(await runCase(rt, seed, true)));
    const elapsedMs = Math.round(performance.now() - started);

    const failing = rows.filter((r) => !r.ok);
    const fiveXX = rows.filter((r) => r.status >= 500);
    const unexplained5xx = fiveXX.filter((r) => r.expected < 500);
    const summary = {
      campaign: {
        seed: STRESS_SEED,
        cases: seeds.length,
        requests: rows.length,
        replay: REPLAY.length > 0 ? REPLAY : null,
        elapsedMs,
      },
      statusHistogram: histogram(rows.map((r) => r.status)),
      authHistogram: histogram(rows.map((r) => r.auth)),
      bodyKindHistogram: histogram(rows.map((r) => r.bodyKind)),
      pathKindHistogram: histogram(rows.map((r) => r.pathKind)),
      methodHistogram: histogram(rows.map((r) => r.method)),
      faultHistogram: histogram(rows.map((r) => r.fault)),
      contentLengthHistogram: histogram(rows.map((r) => r.contentLengthKind)),
      fiveXX: fiveXX.map((r) => ({
        seed: r.seed,
        n: r.n,
        status: r.status,
        fault: r.fault,
        auth: r.auth,
        explained: r.expected >= 500,
      })),
      unexplained5xxSeeds: unexplained5xx.map((r) => r.seed),
      violations: failing.map((r) => ({
        seed: r.seed,
        n: r.n,
        status: r.status,
        expected: r.expected,
        violations: r.violations,
      })),
      observations: {
        // Characterization, NOT asserted: the handler treats an unparseable or
        // non-object body as `{}` and still arms the deletion challenge.
        nonJsonBodyAccepted200: rows.filter((r) =>
          r.status === 200 &&
          [
            "malformed_json",
            "json_non_object",
            "binary_garbage",
            "form_encoded",
            "xml",
          ].includes(r.bodyKind)
        ).length,
        nonJsonContentTypeAccepted200: rows.filter((r) =>
          r.status === 200 && r.contentType !== null &&
          !r.contentType.toLowerCase().includes("application/json")
        ).length,
        providerTokenAuthOutage401: rows.filter((r) =>
          r.fault === "auth_token_503" && r.auth !== "session" &&
          r.status === 401
        ).length,
      },
      replayCommand:
        "STRESS_REPLAY=<seed> deno test -A --no-check stress_delete_request_fuzz.test.ts --filter 'seeded campaign'",
    };
    const sub = REPLAY.length > 0 ? "replay" : "latest";
    const table = await writeJson("fuzz_results.json", rows, sub);
    const summaryPath = await writeJson("fuzz_summary.json", summary, sub);
    console.error(
      `[stress] ${rows.length} requests / ${seeds.length} cases in ${elapsedMs}ms → ${table}, ${summaryPath}`,
    );

    assert(rows.length >= seeds.length, "every case ran at least once");
    assertEquals(
      unexplained5xx.length,
      0,
      `unexplained 5xx seeds: ${
        unexplained5xx.map((r) => r.seed).join(",")
      }`,
    );
    assertEquals(
      failing.length,
      0,
      `${failing.length} request(s) violated the contract; first: seed ${
        failing[0]?.seed
      } n=${failing[0]?.n} → ${failing[0]?.violations.join(" | ")}`,
    );
  },
});
