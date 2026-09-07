#!/usr/bin/env node
// Local Fastify API probe (services/api — LEGACY/LOCAL backend, not production).
//
// Exercises the health / SLO / OpenAPI / typed-error routes of a running local
// API and prints one structured request/response record per probe: the
// request id we sent, the request id the server echoed (x-request-id header
// AND error.requestId body field), status, typed error {kind, code, retryable},
// and latency. Optionally starts the API itself (--start) against the local
// Docker Postgres.
//
// Node built-ins only (fetch, crypto, child_process); no workspace deps, so it
// runs from any checkout with Node >= 20.
//
// Usage (repo root):
//   node tools/diagnostics/local_api_probe.mjs                 # probe an already-running API on :3001
//   node tools/diagnostics/local_api_probe.mjs --start         # spawn `pnpm --filter @pickle/api start`, probe, stop
//   node tools/diagnostics/local_api_probe.mjs --json          # machine-readable output
//   node tools/diagnostics/local_api_probe.mjs --with-account  # also POST /v1/account/bootstrap for a throwaway
//                                                              # dev subject (WRITES to the local dev DB)
// Env:
//   API_BASE_URL     default http://127.0.0.1:3001
//   DEV_AUTH_SECRET  HS256 secret the API was started with (>=16 chars). With --start a
//                    random one is generated for this process only. Without --start and
//                    without DEV_AUTH_SECRET, bearer-authenticated probes are SKIPPED
//                    (reported as "unavailable", never as pass).
//   DATABASE_URL     (--start only) default postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev
//
// Exit code: 0 when every executed probe matched its expectation and at least one
// executed; 1 when any probe mismatched; 2 when nothing could be executed (API
// down / unreachable). Skipped probes are listed as `unavailable`, never as pass.

import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const start = args.has("--start");
const withAccount = args.has("--with-account");

const baseUrl = (process.env.API_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
let devAuthSecret = process.env.DEV_AUTH_SECRET;
if (start && !devAuthSecret) devAuthSecret = randomBytes(24).toString("hex");

const b64url = (value) => Buffer.from(value).toString("base64url");

/** Mirror of services/api/src/auth/tokens.ts DevTokenVerifier.mint (HS256, iss pickle-dev, 15m). */
function mintDevToken(secret, subject, role = "user") {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      pickle_role: role,
      iss: "pickle-dev",
      sub: subject,
      iat: now,
      exp: now + 900,
    }),
  );
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

const subject = `diag-${randomUUID()}`;
const bearer = devAuthSecret ? mintDevToken(devAuthSecret, subject) : null;

/**
 * @typedef {{ status: number, code: string | null, kind?: string }} Expect
 * @typedef {{ name: string, why: string, method?: string, path: string, headers?: Record<string,string>,
 *             body?: string, auth?: boolean, expect: Expect, summarize?: (json: unknown) => string }} Probe
 */

/** @type {Probe[]} */
const probes = [
  {
    name: "health",
    why: "liveness; version string comes from APP_VERSION/package.json",
    path: "/v1/health",
    expect: { status: 200, code: null },
    summarize: (j) => `status=${j?.status} version=${j?.version}`,
  },
  {
    name: "health/slo",
    why: "SELECT 1 DB probe + in-process SLO snapshot (not_evaluable under 100 requests is honest, not a failure)",
    path: "/v1/health/slo",
    expect: { status: 200, code: null },
    summarize: (j) => {
      const s = j?.snapshot ?? {};
      const evals = Array.isArray(j?.evaluations) ? j.evaluations : [];
      const byStatus = {};
      for (const e of evals) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
      return (
        `requests=${s.requestCount} 5xx=${s.fiveXxCount} p95=${fmt(s.latency?.p95)}ms ` +
        `db_p95=${fmt(s.dbLatency?.p95)}ms db_samples=${s.dbLatency?.sampleCount} ` +
        `pool=${s.pool?.totalCount}/${s.pool?.maxSize} queueDepth=${j?.queueDepth ?? "n/a"} ` +
        `evals=${JSON.stringify(byStatus)}`
      );
    },
  },
  {
    name: "openapi",
    why: "generated contract; path count is a cheap drift check",
    path: "/v1/openapi.json",
    expect: { status: 200, code: null },
    summarize: (j) => `openapi=${j?.openapi} paths=${Object.keys(j?.paths ?? {}).length}`,
  },
  {
    name: "unknown route",
    why: "Fastify default 404 — NOT the typed envelope (no error.code)",
    path: "/v1/does-not-exist",
    expect: { status: 404, code: null },
  },
  {
    name: "missing bearer",
    why: "typed 401 with echoed requestId",
    path: "/v1/me",
    expect: { status: 401, code: "auth.missing_token", kind: "auth_failed" },
  },
  {
    name: "malformed bearer",
    why: "typed 401; verifier rejected the token",
    path: "/v1/me",
    headers: { authorization: "Bearer not-a-jwt" },
    expect: { status: 401, code: "auth.invalid_token", kind: "auth_failed" },
  },
  {
    name: "authed, no account",
    why: "valid dev token but no app_user row => auth.no_account (bootstrap required)",
    path: "/v1/me",
    auth: true,
    expect: { status: 401, code: "auth.no_account", kind: "auth_failed" },
  },
  {
    name: "invalid path id",
    why: "non-UUID path id rejected before any query",
    path: "/v1/shots/not-a-uuid",
    auth: true,
    expect: { status: 400, code: "validation.path_id", kind: "permanent" },
  },
  {
    name: "unparseable json",
    why: "body parse failure => validation.request",
    method: "POST",
    path: "/v1/sessions",
    headers: { "content-type": "application/json" },
    body: "{bad",
    auth: true,
    expect: { status: 400, code: "validation.request", kind: "permanent" },
  },
  {
    name: "payload too large",
    why: "over Fastify bodyLimit => validation.payload_too_large",
    method: "POST",
    path: "/v1/sessions",
    headers: { "content-type": "application/json" },
    body: `{"pad":"${"x".repeat(1_100_000)}"}`,
    auth: true,
    expect: { status: 413, code: "validation.payload_too_large", kind: "permanent" },
  },
];

if (withAccount) {
  probes.push(
    {
      name: "account bootstrap (WRITE)",
      why: "creates app_user/user_profile/user_setting for the throwaway dev subject in the LOCAL DB",
      method: "POST",
      path: "/v1/account/bootstrap",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        locale: "en-US",
        timezone: "UTC",
        device: { platform: "ios", osVersion: "diag", appVersion: "diag", model: "diag" },
      }),
      auth: true,
      expect: { status: 200, code: null },
      summarize: (j) => `keys=${Object.keys(j ?? {}).join(",")}`,
    },
    {
      name: "me after bootstrap",
      why: "the same bearer now resolves to an account",
      path: "/v1/me",
      auth: true,
      expect: { status: 200, code: null },
    },
  );
}

const fmt = (n) => (typeof n === "number" ? n.toFixed(1) : "n/a");

async function runProbe(probe) {
  const requestId = `diag-${randomUUID()}`;
  const headers = { "x-request-id": requestId, ...(probe.headers ?? {}) };
  if (probe.auth) {
    if (!bearer) {
      return {
        name: probe.name,
        method: probe.method ?? "GET",
        path: probe.path,
        outcome: "unavailable",
        reason: "DEV_AUTH_SECRET not set; cannot mint a dev bearer",
        why: probe.why,
      };
    }
    headers.authorization = `Bearer ${bearer}`;
  }
  const started = performance.now();
  let response;
  try {
    response = await fetch(`${baseUrl}${probe.path}`, {
      method: probe.method ?? "GET",
      headers,
      body: probe.body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return {
      name: probe.name,
      method: probe.method ?? "GET",
      path: probe.path,
      outcome: "unavailable",
      reason: `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      why: probe.why,
    };
  }
  const latencyMs = Math.round((performance.now() - started) * 10) / 10;
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  // Typed envelope is { error: { kind, code, ... } }; Fastify's default 404 has
  // error: "Not Found" (a string) and is deliberately NOT treated as typed.
  const err =
    json && typeof json === "object" && json.error && typeof json.error === "object"
      ? json.error
      : null;
  const code = typeof err?.code === "string" ? err.code : null;
  const kind = typeof err?.kind === "string" ? err.kind : null;
  const echoedHeader = response.headers.get("x-request-id");
  const echoedBody = typeof err?.requestId === "string" ? err.requestId : null;
  const pass =
    response.status === probe.expect.status &&
    code === probe.expect.code &&
    (probe.expect.kind === undefined || kind === probe.expect.kind) &&
    echoedHeader === requestId &&
    (err === null || echoedBody === requestId);
  return {
    name: probe.name,
    method: probe.method ?? "GET",
    path: probe.path,
    outcome: pass ? "pass" : "fail",
    status: response.status,
    sentRequestId: requestId,
    echoedRequestIdHeader: echoedHeader,
    echoedRequestIdBody: echoedBody,
    error: err ? { kind, code, retryable: err.retryable === true } : null,
    latencyMs,
    summary: probe.summarize && json && !err ? probe.summarize(json) : null,
    expected: probe.expect,
    why: probe.why,
  };
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

let child = null;
const childLog = [];

function stopChild() {
  if (!child || child.exitCode !== null) return Promise.resolve();
  // pnpm → tsx → node: kill the whole process group so no orphan keeps :3001.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  return Promise.race([new Promise((r) => child.once("exit", r)), sleep(5_000)]);
}

if (start) {
  if (await waitForHealth(1_500)) {
    const report = {
      tool: "local_api_probe",
      target: baseUrl,
      outcome: "unavailable",
      reason:
        "--start requested but something already answers /v1/health at this URL; " +
        "its DEV_AUTH_SECRET is unknown so results would be misleading. Stop it or drop --start.",
    };
    console.log(asJson ? JSON.stringify(report, null, 2) : report.reason);
    process.exit(1);
  }
  const env = {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ?? "postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev",
    DEV_AUTH_SECRET: devAuthSecret,
    PORT: String(new URL(baseUrl).port || 3001),
    HOST: new URL(baseUrl).hostname,
  };
  child = spawn("pnpm", ["--filter", "@pickle/api", "start"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const capture = (chunk) => {
    for (const line of chunk.toString().split("\n")) if (line.trim()) childLog.push(line);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const up = await waitForHealth(45_000);
  if (!up) {
    const report = {
      tool: "local_api_probe",
      target: baseUrl,
      outcome: "unavailable",
      reason: "API did not answer /v1/health within 45s after --start",
      apiLogTail: childLog.slice(-30),
    };
    console.log(
      asJson
        ? JSON.stringify(report, null, 2)
        : `${report.reason}\n${report.apiLogTail.join("\n")}`,
    );
    await stopChild();
    process.exit(1);
  }
}

const records = [];
for (const probe of probes) records.push(await runProbe(probe));

await stopChild();

const failed = records.filter((r) => r.outcome === "fail");
const unavailable = records.filter((r) => r.outcome === "unavailable");
const executed = records.length - unavailable.length;
const verdict = failed.length > 0 ? "FAIL" : executed === 0 ? "UNAVAILABLE" : "PASS";

// Structured API log lines (Fastify/pino JSON) that carry the request ids we sent,
// so the reader can see the id round-trips into server logs — only with --start.
const correlatedLogLines = childLog.filter((line) => /"reqId":"diag-/.test(line)).length;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        tool: "local_api_probe",
        target: baseUrl,
        backend: "services/api (Fastify) — legacy/local, NOT the production Edge Function",
        started: start,
        devBearerAvailable: bearer !== null,
        records,
        apiLogLinesWithOurRequestIds: start ? correlatedLogLines : null,
        verdict,
      },
      null,
      2,
    ),
  );
} else {
  const pad = (s, n) =>
    String(s).length >= n ? String(s) : String(s) + " ".repeat(n - String(s).length);
  console.log(
    `local_api_probe — ${baseUrl} (services/api Fastify; legacy/local, not production)\n`,
  );
  console.log(
    pad("probe", 30) +
      pad("status", 8) +
      pad("kind/code", 42) +
      pad("reqid", 12) +
      "latency  summary",
  );
  for (const r of records) {
    if (r.outcome === "unavailable") {
      console.log(pad(`skip ${r.name}`, 30) + pad("-", 8) + pad(`unavailable: ${r.reason}`, 42));
      continue;
    }
    const echoed =
      r.echoedRequestIdHeader === r.sentRequestId
        ? r.error === null || r.echoedRequestIdBody === r.sentRequestId
          ? "echoed"
          : "hdr-only"
        : "MISSING";
    console.log(
      pad(`${r.outcome === "pass" ? "ok  " : "FAIL"} ${r.name}`, 30) +
        pad(r.status, 8) +
        pad(
          r.error
            ? `${r.error.kind}/${r.error.code}${r.error.retryable ? " (retryable)" : ""}`
            : "-",
          42,
        ) +
        pad(echoed, 12) +
        pad(`${r.latencyMs}ms`, 9) +
        (r.summary ?? ""),
    );
    if (r.outcome === "fail") {
      console.log(
        `      expected status=${r.expected.status} code=${r.expected.code ?? "(none)"}` +
          (r.expected.kind ? ` kind=${r.expected.kind}` : ""),
      );
    }
  }
  if (start) {
    console.log(
      `\nAPI stdout/stderr lines: ${childLog.length}; lines carrying our x-request-id values: ${correlatedLogLines}`,
    );
  }
  console.log(
    `\n${verdict}: ${executed - failed.length}/${records.length} probes matched` +
      (unavailable.length ? `, ${unavailable.length} unavailable` : ""),
  );
}

process.exit(verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2);
