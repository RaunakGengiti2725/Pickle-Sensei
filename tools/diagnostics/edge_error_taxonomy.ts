// Edge Function error-taxonomy probe.
//
// Boots the REAL production handler (supabase/functions/api/index.ts) in-process
// through the existing `__wf__/routesHarness.ts` test double (Supabase Auth +
// PostgREST + RevenueCat stubbed at the fetch layer; no port opened, no network),
// drives a fixed set of requests through it, and prints one structured record per
// request: status, typed `error.code` (or its absence), response headers that
// matter for diagnosis, and whether ANY correlation/request-id header came back.
//
// It also statically scans index.ts / rateLimit.ts for every `codedError(...)` and
// `code: "..."` literal so the full taxonomy is listed even for branches this
// probe cannot reach without a real database.
//
// This is a LOCAL diagnostic of handler behaviour. It proves nothing about the
// deployed project (ucqnaiwqwjtgvlduiuib); it never contacts it.
//
// Run (from the repo root):
//   ~/.deno/bin/deno run -A --no-check --config supabase/functions/api/__wf__/deno.json \
//     tools/diagnostics/edge_error_taxonomy.ts [--json]
//
// Exit code: 0 when every expectation holds, 1 otherwise.

import {
  fakeGoogleIdToken,
  loadHarness,
  userRequest,
  webhookRequest,
} from "../../supabase/functions/api/__wf__/routesHarness.ts";
import { captureAccessLog } from "../../supabase/functions/api/http.ts";

const encoder = new TextEncoder();
// Root eslint forbids console.log in *.ts; this probe's report IS its stdout.
const print = (line: string): void => {
  Deno.stdout.writeSync(encoder.encode(`${line}\n`));
};

interface Expect {
  status: number;
  /** Expected `error.code`; `null` = expect a generic body WITHOUT a code. */
  code: string | null;
}

interface Probe {
  name: string;
  why: string;
  request: () => Request;
  expect: Expect;
  /** PostgREST rows / RPC results to stub before the request. */
  stub?: { tables?: Record<string, unknown[]>; rpcs?: Record<string, unknown> };
}

interface Record_ {
  name: string;
  method: string;
  path: string;
  status: number;
  errorCode: string | null;
  errorMessage: string | null;
  bodyKind: "coded" | "generic" | "ok" | "text" | "empty";
  headers: Record<string, string>;
  correlationHeader: string | null;
  latencyMs: number;
  expected: Expect;
  pass: boolean;
  why: string;
}

const DIAG_HEADERS = [
  "content-type",
  "cache-control",
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  "www-authenticate",
  "x-request-id",
];
const CORRELATION_HEADERS = ["x-request-id", "sb-request-id", "cf-ray", "x-correlation-id"];

const BIG = 5_000_001;

const probes: Probe[] = [
  {
    name: "healthz",
    why: "public liveness; the only unauthenticated JSON route",
    request: () => new Request("http://edge.test/functions/v1/api/healthz"),
    expect: { status: 200, code: null },
  },
  {
    name: "support page is text",
    why: "public legal/support text; gateway rewrites Content-Type for HTML so plain text is intentional",
    request: () => new Request("http://edge.test/functions/v1/api/support"),
    expect: { status: 200, code: null },
  },
  {
    name: "missing bearer",
    why: "authenticate(): generic 401 body, NO error.code (client maps to 'unknown')",
    request: () =>
      new Request("http://edge.test/functions/v1/api/v1/me/access", {
        headers: { "x-forwarded-for": "198.51.100.101" },
      }),
    expect: { status: 401, code: null },
  },
  {
    name: "malformed bearer",
    why: "authenticate(): bearer is neither a session token nor a provider ID token",
    request: () =>
      new Request("http://edge.test/functions/v1/api/v1/me/access", {
        headers: {
          Authorization: "Bearer not-a-jwt",
          "x-forwarded-for": "198.51.100.102",
        },
      }),
    expect: { status: 401, code: null },
  },
  {
    name: "unknown endpoint",
    why: "authenticated request to a route the switch does not know",
    request: () => userRequest("GET", "/v1/does-not-exist", { ip: "198.51.100.103" }),
    expect: { status: 404, code: null },
  },
  {
    name: "auth refresh without refreshToken",
    why: "coded validation error on the session-rotation route",
    request: () =>
      new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.104" },
        body: JSON.stringify({}),
      }),
    expect: { status: 400, code: "validation.refresh" },
  },
  {
    name: "permit reserve without idempotencyKey",
    why: "coded validation error before any RPC",
    request: () => userRequest("POST", "/v1/analysis-permits", { ip: "198.51.100.105", body: {} }),
    expect: { status: 400, code: "validation.analysis_permit" },
  },
  {
    name: "permit reserve paywalled",
    why: "reserve_analysis_permit RPC reports the free allowance is spent",
    stub: {
      rpcs: {
        reserve_analysis_permit: [
          {
            result: "access.paywall_required",
            permit_id: null,
            permit_status: null,
            permit_outcome: null,
            permit_created_at: null,
          },
        ],
      },
    },
    request: () =>
      userRequest("POST", "/v1/analysis-permits", {
        ip: "198.51.100.106",
        body: { idempotencyKey: "diag-permit-1" },
      }),
    expect: { status: 402, code: "access.paywall_required" },
  },
  {
    name: "permit reserve accepted",
    why: "happy path: RPC accepted => 200 { permit, access } (access_state RPC also stubbed)",
    stub: {
      rpcs: {
        reserve_analysis_permit: [
          {
            result: "accepted",
            permit_id: "00000000-0000-4000-8000-00000000abcd",
            permit_status: "reserved",
            permit_outcome: null,
            permit_created_at: new Date().toISOString(),
          },
        ],
        access_state: [{ premium: false, scored_count: 0, reserved_count: 1 }],
      },
    },
    request: () =>
      userRequest("POST", "/v1/analysis-permits", {
        ip: "198.51.100.112",
        body: { idempotencyKey: "diag-permit-3" },
      }),
    expect: { status: 200, code: null },
  },
  {
    name: "permit reserve RPC missing",
    why: "database/RPC failure => GENERIC 503; detail only in console.error",
    request: () =>
      userRequest("POST", "/v1/analysis-permits", {
        ip: "198.51.100.107",
        body: { idempotencyKey: "diag-permit-2" },
      }),
    expect: { status: 503, code: null },
  },
  {
    name: "shots:sync empty batch",
    why: "coded validation error; body must be { shots: [1..200] }",
    request: () =>
      userRequest("POST", "/v1/shots:sync", { ip: "198.51.100.108", body: { shots: [] } }),
    expect: { status: 400, code: "validation.shots_sync" },
  },
  {
    name: "permit finalize unknown id",
    why: "coded 404 on the parameterized permit route",
    request: () =>
      userRequest("POST", "/v1/analysis-permits/00000000-0000-4000-8000-000000000000/finalize", {
        ip: "198.51.100.109",
        body: { outcome: "failed", ratingId: null },
      }),
    expect: { status: 404, code: "access.permit_not_found" },
  },
  {
    name: "oversized body",
    why: "Content-Length > MAX_JSON_BODY_BYTES is refused before auth; generic 413",
    request: () =>
      new Request("http://edge.test/functions/v1/api/v1/shots:sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(BIG),
          Authorization: `Bearer ${fakeGoogleIdToken()}`,
          "x-forwarded-for": "198.51.100.110",
        },
        body: "{}",
      }),
    expect: { status: 413, code: null },
  },
  {
    name: "webhook without shared secret",
    why: "RevenueCat webhook is secret-gated",
    request: () => webhookRequest({ type: "TEST" }, { authorization: null, ip: "198.51.100.111" }),
    expect: { status: 401, code: null },
  },
  {
    name: "rate limited (auth refresh budget)",
    why: "31st refresh from one IP in 60s => 429 + Retry-After + RateLimit-*; code 'rate_limited'",
    request: () =>
      new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.200" },
        body: JSON.stringify({}),
      }),
    expect: { status: 429, code: "rate_limited" },
  },
];

async function readBody(response: Response): Promise<{
  kind: Record_["bodyKind"];
  code: string | null;
  message: string | null;
}> {
  const text = await response.text();
  if (!text) return { kind: "empty", code: null, message: null };
  try {
    const json = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    if (json && typeof json === "object" && json.error) {
      const code = typeof json.error.code === "string" ? json.error.code : null;
      const message = typeof json.error.message === "string" ? json.error.message : null;
      return { kind: code ? "coded" : "generic", code, message };
    }
    return { kind: "ok", code: null, message: null };
  } catch {
    return { kind: "text", code: null, message: null };
  }
}

async function run(probe: Probe, handler: (r: Request) => Promise<Response>): Promise<Record_> {
  const request = probe.request();
  const url = new URL(request.url);
  const started = performance.now();
  const response = await handler(request);
  const latencyMs = Math.round((performance.now() - started) * 10) / 10;
  const body = await readBody(response);
  const headers: Record<string, string> = {};
  for (const h of DIAG_HEADERS) {
    const v = response.headers.get(h);
    if (v !== null) headers[h] = v;
  }
  const correlationHeader =
    CORRELATION_HEADERS.find((h) => response.headers.get(h) !== null) ?? null;
  const pass = response.status === probe.expect.status && body.code === probe.expect.code;
  return {
    name: probe.name,
    method: request.method,
    path: url.pathname.replace(/^\/functions\/v1\/api/, ""),
    status: response.status,
    errorCode: body.code,
    errorMessage: body.message,
    bodyKind: body.kind,
    headers,
    correlationHeader,
    latencyMs,
    expected: probe.expect,
    pass,
    why: probe.why,
  };
}

async function staticTaxonomy(): Promise<{ file: string; codes: string[] }[]> {
  const files = ["index.ts", "rateLimit.ts", "externalAccounts.ts"];
  const out: { file: string; codes: string[] }[] = [];
  for (const file of files) {
    const source = await Deno.readTextFile(
      new URL(`../../supabase/functions/api/${file}`, import.meta.url),
    );
    const codes = new Set<string>();
    for (const m of source.matchAll(/codedError\(\s*\d+\s*,\s*"([^"]+)"/g)) codes.add(m[1]);
    for (const m of source.matchAll(/\bcode:\s*"([a-z_]+(?:\.[a-z_]+)?)"/g)) codes.add(m[1]);
    out.push({ file: `supabase/functions/api/${file}`, codes: [...codes].sort() });
  }
  return out;
}

const asJson = Deno.args.includes("--json");
const h = await loadHarness();

// Silence the handler's own console.error/warn during probes so the report is
// readable; count them instead (they ARE the only place 5xx detail goes). The
// handler's one `{"evt":"api_request",...}` access line per request (requestId,
// route template, status, code, durationMs) is captured through its sink.
const logged: string[] = [];
const accessLog: Record<string, unknown>[] = [];
const realError = console.error;
const realWarn = console.warn;
console.error = (...args: unknown[]) => logged.push(`error: ${args.map(String).join(" ")}`);
console.warn = (...args: unknown[]) => logged.push(`warn: ${args.map(String).join(" ")}`);
const restoreAccessLog = captureAccessLog((line) => accessLog.push(JSON.parse(line)));

const records: Record_[] = [];
try {
  for (const probe of probes) {
    h.reset();
    if (probe.stub?.tables) Object.assign(h.tables, probe.stub.tables);
    if (probe.stub?.rpcs) Object.assign(h.rpcs, probe.stub.rpcs);
    if (probe.name.startsWith("rate limited")) {
      // Burn the per-IP refresh budget (30/60s) first.
      for (let i = 0; i < 30; i++) {
        const warm = await h.handler(probe.request());
        await warm.body?.cancel();
      }
    }
    records.push(await run(probe, h.handler));
  }
} finally {
  console.error = realError;
  console.warn = realWarn;
  restoreAccessLog();
}

const taxonomy = await staticTaxonomy();
// Correlation contract: every response carries x-request-id, and the access
// line for a request carries the same id, its status, and its error.code.
const probeAccessLines = accessLog.filter((entry) =>
  records.some((r) => r.headers["x-request-id"] === entry.requestId),
);
const correlationFailures = records.filter((r) => {
  const id = r.headers["x-request-id"];
  if (!id) return true;
  const line = probeAccessLines.find((entry) => entry.requestId === id);
  if (!line) return true;
  return line.status !== r.status || (line.code ?? null) !== r.errorCode;
});
const taxonomyFailures = records.filter((r) => !r.pass);
const failures = taxonomyFailures.length + correlationFailures.length;

if (asJson) {
  print(
    JSON.stringify(
      {
        tool: "edge_error_taxonomy",
        target: "supabase/functions/api/index.ts (in-process, __wf__ routesHarness doubles)",
        records,
        handlerLogLines: logged,
        accessLog: probeAccessLines,
        correlationFailures: correlationFailures.map((r) => r.name),
        staticTaxonomy: taxonomy,
        pass: failures === 0,
      },
      null,
      2,
    ),
  );
} else {
  print("edge_error_taxonomy — real handler, stubbed Supabase/RevenueCat, no network\n");
  const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
  const nameWidth = Math.max(...records.map((r) => r.name.length)) + 6;
  print(
    pad("probe", nameWidth) +
      pad("status", 8) +
      pad("error.code", 38) +
      pad("corr-id", 9) +
      "headers",
  );
  for (const r of records) {
    print(
      pad(`${r.pass ? "ok  " : "FAIL"} ${r.name}`, nameWidth) +
        pad(String(r.status), 8) +
        pad(r.errorCode ?? `(${r.bodyKind})`, 38) +
        pad(r.correlationHeader ?? "none", 9) +
        Object.entries(r.headers)
          .filter(([k]) => k !== "content-type")
          .map(([k, v]) => `${k}=${v}`)
          .join(" "),
    );
    if (!r.pass) {
      print(
        `      expected status=${r.expected.status} code=${r.expected.code ?? "(none)"}; ` +
          `got message=${JSON.stringify(r.errorMessage)}`,
      );
    }
  }
  print(`\nhandler console.error/warn lines captured: ${logged.length}`);
  for (const line of logged) print(`  ${line}`);
  print('\nstatic error-code taxonomy (codedError(...) and code: "..." literals):');
  for (const t of taxonomy) {
    print(`  ${t.file}: ${t.codes.length}`);
    for (const c of t.codes) print(`    ${c}`);
  }
  print(
    `\ncorrelation: x-request-id on ${records.length - correlationFailures.length}/${records.length} responses, ` +
      `matched by an access-log line {evt:"api_request", requestId, route, status, code, durationMs}`,
  );
  for (const r of correlationFailures) print(`  FAIL correlation: ${r.name}`);
  print(
    `\n${failures === 0 ? "PASS" : "FAIL"}: ${records.length - taxonomyFailures.length}/${records.length} probes matched, ` +
      `${records.length - correlationFailures.length}/${records.length} correlated`,
  );
}

Deno.exit(failures === 0 ? 0 : 1);
