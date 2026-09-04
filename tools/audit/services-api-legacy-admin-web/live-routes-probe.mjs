#!/usr/bin/env node
// Execution-audit probe for the LEGACY local Fastify API (services/api).
//
// Drives a RUNNING local API through auth / dev-token gating / admin allowlist /
// feature-flag / typed-error / empty / missing-data / rate-limit states with real
// HTTP requests and records one JSON record per scenario (status, typed error
// code, request-id echo, latency, pass/fail vs. expectation). WRITES throwaway
// rows to the LOCAL dev database it is pointed at (never production).
//
// Node built-ins only. Companion to tools/diagnostics/local_api_probe.mjs, which
// covers the anonymous/health surface; this file covers everything gated by
// bearer tokens.
//
// Usage (repo root, API already listening):
//   DEV_AUTH_SECRET=<same secret the API was started with> \
//   ADMIN_ALLOWED_SUBJECT=audit-admin-allowed \
//   node tools/audit/services-api-legacy-admin-web/live-routes-probe.mjs --json > out.json
//
// Env:
//   API_BASE_URL            default http://127.0.0.1:3001
//   DEV_AUTH_SECRET         required (>=16 chars)
//   ADMIN_ALLOWED_SUBJECT   the admin subject present in the API's ADMIN_AUTH_SUBJECTS
//                           (if the API was started WITHOUT an allowlist, set
//                           PROBE_EXPECT_ALLOWLIST=0 and the denied-admin scenario
//                           expects 200 instead of 403)
//   PROBE_RATE_LIMIT=1      also hammer an expensive route (60/min budget) until 429
//   PROBE_EXPECT_DB=0       API started without DATABASE_URL: expect 503 auth.db_unavailable
//
// Exit code: 0 all executed scenarios matched; 1 any mismatch; 2 API unreachable.

import { createHmac, randomUUID } from "node:crypto";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const baseUrl = (process.env.API_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const secret = process.env.DEV_AUTH_SECRET;
const expectAllowlist = (process.env.PROBE_EXPECT_ALLOWLIST ?? "1") !== "0";
const expectDb = (process.env.PROBE_EXPECT_DB ?? "1") !== "0";
const probeRateLimit = process.env.PROBE_RATE_LIMIT === "1";
const adminAllowed = process.env.ADMIN_ALLOWED_SUBJECT ?? "audit-admin-allowed";
if (!secret || secret.length < 16) {
  console.error("DEV_AUTH_SECRET (>=16 chars) is required");
  process.exit(2);
}

const b64url = (v) => Buffer.from(v).toString("base64url");
function mint({ sub, role = "user", iss = "pickle-dev", exp, key = secret, omitSub = false }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { pickle_role: role, iss, iat: now, exp: exp ?? now + 900 };
  if (!omitSub) payload.sub = sub;
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify(payload));
  const s = createHmac("sha256", key).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

const runId = randomUUID().slice(0, 8);
const userSub = `audit-user-${runId}`;
const adminDeniedSub = `audit-admin-denied-${runId}`;
const userTok = mint({ sub: userSub });
const adminTok = mint({ sub: adminAllowed, role: "admin" });
const adminDeniedTok = mint({ sub: adminDeniedSub, role: "admin" });
const bootstrapBody = JSON.stringify({
  locale: "en-US",
  timezone: "UTC",
  device: { platform: "ios", osVersion: "audit", appVersion: "0.0.0-audit", model: "audit" },
});
const JSON_CT = { "content-type": "application/json" };

const records = [];
let unreachable = false;

async function call(name, { method = "GET", path, token, headers = {}, body, expect, check, why }) {
  const requestId = `audit-${randomUUID()}`;
  const h = { "x-request-id": requestId, ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: h,
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    unreachable = true;
    records.push({
      name,
      method,
      path,
      outcome: "unavailable",
      reason: String(error?.message ?? error),
      why,
    });
    return null;
  }
  const latencyMs = Math.round((performance.now() - started) * 10) / 10;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const err =
    json && typeof json === "object" && json.error && typeof json.error === "object"
      ? json.error
      : null;
  const code = typeof err?.code === "string" ? err.code : null;
  const echoed = res.headers.get("x-request-id");
  const problems = [];
  if (expect?.status !== undefined && res.status !== expect.status)
    problems.push(`status ${res.status} != ${expect.status}`);
  if (expect?.code !== undefined && code !== expect.code)
    problems.push(`code ${code} != ${expect.code}`);
  if (echoed !== requestId) problems.push(`x-request-id not echoed (${echoed})`);
  if (err && err.requestId !== requestId) problems.push("error.requestId not echoed");
  if (check) {
    const extra = check(json, res);
    if (extra) problems.push(extra);
  }
  records.push({
    name,
    method,
    path,
    outcome: problems.length === 0 ? "pass" : "fail",
    status: res.status,
    error: err ? { kind: err.kind, code, retryable: err.retryable === true } : null,
    retryAfter: res.headers.get("retry-after"),
    latencyMs,
    problems,
    why,
    bodyPreview: problems.length ? text.slice(0, 300) : undefined,
  });
  return { json, res, text };
}

// ---------------------------------------------------------------- anonymous
await call("health", { path: "/v1/health", expect: { status: 200, code: null }, why: "liveness" });
if (unreachable) {
  console.error(`API unreachable at ${baseUrl}`);
  process.exit(2);
}
await call("health/slo", {
  path: "/v1/health/slo",
  expect: { status: 200 },
  why: "SLO + DB probe",
});
const openapi = await call("openapi", {
  path: "/v1/openapi.json",
  expect: { status: 200 },
  why: "contract present",
});
await call("nul byte in path", {
  path: "/v1/shots/%00",
  token: userTok,
  expect: { status: 400, code: "validation.identifier" },
  why: "onRequest NUL guard fires before auth",
});
await call("unknown route", {
  path: "/v1/nope",
  expect: { status: 404 },
  why: "fastify default 404",
});

// ---------------------------------------------------------------- token gating
await call("flags: missing bearer", {
  path: "/v1/flags",
  expect: { status: 401, code: "auth.missing_token" },
});
await call("flags: non-Bearer scheme", {
  path: "/v1/flags",
  headers: { authorization: `Basic ${userTok}` },
  expect: { status: 401, code: "auth.missing_token" },
});
await call("flags: garbage token", {
  path: "/v1/flags",
  token: "abc.def.ghi",
  expect: { status: 401, code: "auth.invalid_token" },
});
await call("flags: wrong secret", {
  path: "/v1/flags",
  token: mint({ sub: userSub, key: "definitely-not-the-server-secret" }),
  expect: { status: 401, code: "auth.invalid_token" },
});
await call("flags: wrong issuer", {
  path: "/v1/flags",
  token: mint({ sub: userSub, iss: "someone-else" }),
  expect: { status: 401, code: "auth.invalid_token" },
});
await call("flags: expired token", {
  path: "/v1/flags",
  token: mint({ sub: userSub, exp: Math.floor(Date.now() / 1000) - 120 }),
  expect: { status: 401, code: "auth.invalid_token" },
});
await call("flags: token without sub", {
  path: "/v1/flags",
  token: mint({ omitSub: true }),
  expect: { status: 401, code: "auth.no_subject" },
});
await call("flags: alg=none token", {
  path: "/v1/flags",
  token: `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify({ sub: userSub, iss: "pickle-dev", pickle_role: "admin" }))}.`,
  expect: { status: 401, code: "auth.invalid_token" },
  why: "alg=none must never verify",
});

if (!expectDb) {
  await call("flags: valid token, no database", {
    path: "/v1/flags",
    token: userTok,
    expect: { status: 503, code: "auth.db_unavailable" },
    check: (j) => (j?.error?.retryable === true ? null : "retryable should be true"),
  });
  await call("bootstrap: no database", {
    method: "POST",
    path: "/v1/account/bootstrap",
    token: userTok,
    headers: JSON_CT,
    body: bootstrapBody,
    expect: { status: 503, code: "db.unavailable" },
  });
  finish();
}

await call("flags: valid token before bootstrap", {
  path: "/v1/flags",
  token: userTok,
  expect: { status: 401, code: "auth.no_account" },
});
await call("admin route: valid token before bootstrap", {
  path: "/v1/admin/stability/decision",
  token: adminDeniedTok,
  expect: { status: 401, code: "auth.no_account" },
  why: "admin claim never bypasses the account requirement (per-run subject: never bootstrapped yet)",
});

// ---------------------------------------------------------------- bootstrap states
await call("bootstrap: missing bearer", {
  method: "POST",
  path: "/v1/account/bootstrap",
  headers: JSON_CT,
  body: bootstrapBody,
  expect: { status: 401, code: "auth.missing_token" },
});
await call("bootstrap: invalid body", {
  method: "POST",
  path: "/v1/account/bootstrap",
  token: userTok,
  headers: JSON_CT,
  body: JSON.stringify({ locale: 1 }),
  expect: { status: 400, code: "validation.bootstrap" },
});
await call("bootstrap: empty body", {
  method: "POST",
  path: "/v1/account/bootstrap",
  token: userTok,
  headers: JSON_CT,
  body: "",
  expect: { status: 400 },
  check: (j) => (j?.error?.code ? null : "typed error expected"),
});
await call("bootstrap: unparseable json", {
  method: "POST",
  path: "/v1/account/bootstrap",
  token: userTok,
  headers: JSON_CT,
  body: "{nope",
  expect: { status: 400, code: "validation.request" },
});
await call("bootstrap: text/plain body (fastify built-in text parser => string => schema 400)", {
  method: "POST",
  path: "/v1/account/bootstrap",
  token: userTok,
  headers: { "content-type": "text/plain" },
  body: bootstrapBody,
  expect: { status: 400, code: "validation.bootstrap" },
});
await call("bootstrap: unsupported media type", {
  method: "POST",
  path: "/v1/account/bootstrap",
  token: userTok,
  headers: { "content-type": "application/xml" },
  body: "<x/>",
  expect: { status: 415, code: "validation.unsupported_media_type" },
});
const boot1 = await call("bootstrap: create user", {
  method: "POST",
  path: "/v1/account/bootstrap",
  token: userTok,
  headers: JSON_CT,
  body: bootstrapBody,
  expect: { status: 200 },
  check: (j) =>
    j?.user?.id && j?.onboardingState === "pending"
      ? null
      : "user.id / onboardingState=pending expected",
});
const userId = boot1?.json?.user?.id;
await call("bootstrap: idempotent replay", {
  method: "POST",
  path: "/v1/account/bootstrap",
  token: userTok,
  headers: JSON_CT,
  body: bootstrapBody,
  expect: { status: 200 },
  check: (j) => (j?.user?.id === userId ? null : `different user id ${j?.user?.id}`),
});
await call("me: after bootstrap", {
  path: "/v1/me",
  token: userTok,
  expect: { status: 200 },
  check: (j) =>
    Array.isArray(j?.entitlements) && j.entitlements.length === 0
      ? null
      : "empty entitlements expected",
  why: "empty-state: no entitlements/goals",
});

// ---------------------------------------------------------------- flags (user)
const REGISTRY_KEYS = [
  "live_court",
  "ball_tracking",
  "cloud_deep_analysis",
  "reference_comparison",
  "social",
  "leaderboards",
  "experimental_camera_setup",
  "paywall_v1",
  "stroke_return",
  "stroke_backhand_drive",
  "stroke_volley",
  "stroke_overhead",
  "auto_detect",
  "contact_model",
  "scoring_engine",
  "drill_ranker",
  "session_processing",
  "stroke_detector",
];
const flags0 = await call("flags: user, seeded rows", {
  path: "/v1/flags",
  token: userTok,
  expect: { status: 200 },
  check: (j) => {
    const missing = REGISTRY_KEYS.filter((k) => typeof j?.flags?.[k] !== "boolean");
    if (missing.length) return `registry keys missing: ${missing.join(",")}`;
    if (j?.flagState?.registryVersion !== 1) return "registryVersion != 1";
    if (!Array.isArray(j?.flagState?.killSwitchesActive)) return "killSwitchesActive missing";
    if (typeof j?.flagState?.fingerprint !== "string") return "fingerprint missing";
    return null;
  },
});
const fingerprint0 = flags0?.json?.flagState?.fingerprint;
await call("flags: fingerprint stable across requests", {
  path: "/v1/flags",
  token: userTok,
  expect: { status: 200 },
  check: (j) =>
    j?.flagState?.fingerprint === fingerprint0
      ? null
      : "fingerprint changed between identical requests",
});

// ---------------------------------------------------------------- admin gating
await call("admin: user token", {
  path: "/v1/admin/stability/decision",
  token: userTok,
  expect: { status: 403, code: "auth.admin_required" },
});
await call("admin: bootstrap allowed admin", {
  method: "POST",
  path: "/v1/account/bootstrap",
  token: adminTok,
  headers: JSON_CT,
  body: bootstrapBody,
  expect: { status: 200 },
});
await call("admin: bootstrap denied admin", {
  method: "POST",
  path: "/v1/account/bootstrap",
  token: adminDeniedTok,
  headers: JSON_CT,
  body: bootstrapBody,
  expect: { status: 200 },
});
await call("admin: allowlisted admin reads decision", {
  path: "/v1/admin/stability/decision",
  token: adminTok,
  expect: { status: 200 },
  check: (j) => ("window" in (j ?? {}) ? null : "window key expected (null when inactive)"),
  why: "empty-state: no stability window yet",
});
await call("admin: admin claim NOT in allowlist", {
  path: "/v1/admin/stability/decision",
  token: adminDeniedTok,
  expect: expectAllowlist ? { status: 403, code: "auth.admin_not_authorized" } : { status: 200 },
  why: "ADMIN_AUTH_SUBJECTS enforced whenever set (always outside development)",
});
await call("admin: user lookup, unknown uuid", {
  path: `/v1/admin/users/${randomUUID()}`,
  token: adminTok,
  expect: { status: 404, code: "admin.user_not_found" },
});
await call("admin: user lookup, malformed id", {
  path: "/v1/admin/users/not-a-uuid",
  token: adminTok,
  expect: { status: 400, code: "validation.path_id" },
});
await call("admin: user lookup, real user", {
  path: `/v1/admin/users/${userId}`,
  token: adminTok,
  expect: { status: 200 },
  check: (j) => (j?.user?.id === userId && j?.counts?.shots === 0 ? null : "user/counts expected"),
  why: "empty-state: zero shots/sessions",
});
await call("admin: support analyses list, real user, none", {
  path: `/v1/admin/support/users/${userId}/analyses`,
  token: adminTok,
  expect: { status: 200 },
  check: (j) =>
    Array.isArray(j?.analyses) && j.analyses.length === 0 ? null : "empty analyses expected",
});
await call("admin: support analyses list, unknown user", {
  path: `/v1/admin/support/users/${randomUUID()}/analyses`,
  token: adminTok,
  expect: { status: 404, code: "admin.user_not_found" },
});
await call("admin: support analysis, unknown job", {
  path: `/v1/admin/support/analyses/${randomUUID()}`,
  token: adminTok,
  expect: { status: 404, code: "support.analysis_not_found" },
});
await call("admin: entitlement grant, invalid body", {
  method: "PUT",
  path: `/v1/admin/users/${userId}/entitlements`,
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({ featureKey: "x".repeat(41), validTo: null }),
  expect: { status: 400, code: "validation.admin_entitlement" },
});
await call("admin: entitlement grant", {
  method: "PUT",
  path: `/v1/admin/users/${userId}/entitlements`,
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({ featureKey: "premium", validTo: null }),
  expect: { status: 200 },
});
await call("me: entitlement visible after grant", {
  path: "/v1/me",
  token: userTok,
  expect: { status: 200 },
  check: (j) =>
    j?.entitlements?.some((e) => e.feature_key === "premium")
      ? null
      : "premium entitlement expected",
});
await call("admin: entitlement revoke (validTo in past)", {
  method: "PUT",
  path: `/v1/admin/users/${userId}/entitlements`,
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({ featureKey: "premium", validTo: "2020-01-01T00:00:00.000Z" }),
  expect: { status: 200 },
});
await call("me: entitlement gone after revoke", {
  path: "/v1/me",
  token: userTok,
  expect: { status: 200 },
  check: (j) => (j?.entitlements?.length === 0 ? null : "entitlements should be empty"),
});

// ---------------------------------------------------------------- flags (admin writes)
const probeFlag = `audit_probe_${runId}`;
await call("admin flag: invalid rolloutPercent", {
  method: "PUT",
  path: `/v1/admin/flags/${probeFlag}`,
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({ enabled: true, rolloutPercent: 101 }),
  expect: { status: 400, code: "validation.admin_flag" },
});
await call("admin flag: user token forbidden", {
  method: "PUT",
  path: `/v1/admin/flags/${probeFlag}`,
  token: userTok,
  headers: JSON_CT,
  body: JSON.stringify({ enabled: true }),
  expect: { status: 403, code: "auth.admin_required" },
});
await call("admin flag: create unregistered flag enabled 100%", {
  method: "PUT",
  path: `/v1/admin/flags/${probeFlag}`,
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({ enabled: true, rolloutPercent: 100, description: "audit probe" }),
  expect: { status: 200 },
  check: (j) =>
    j?.flag?.enabled === true && j?.flag?.rollout_percent === 100 ? null : "flag echo mismatch",
});
await call("flags: unregistered flag evaluates true, no version", {
  path: "/v1/flags",
  token: userTok,
  expect: { status: 200 },
  check: (j) =>
    j?.flags?.[probeFlag] === true && j?.flagState?.versions?.[probeFlag] === undefined
      ? null
      : `probe flag ${j?.flags?.[probeFlag]} version ${j?.flagState?.versions?.[probeFlag]}`,
});
await call("admin flag: rollout 0%", {
  method: "PUT",
  path: `/v1/admin/flags/${probeFlag}`,
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({ rolloutPercent: 0 }),
  expect: { status: 200 },
});
await call("flags: rollout 0% evaluates false", {
  path: "/v1/flags",
  token: userTok,
  expect: { status: 200 },
  check: (j) => (j?.flags?.[probeFlag] === false ? null : "expected false at 0% rollout"),
});
await call("admin flag: disable registered kill-switch flag 'auto_detect'", {
  method: "PUT",
  path: "/v1/admin/flags/auto_detect",
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({ enabled: false }),
  expect: { status: 200 },
});
await call("flags: auto_detect false after admin disable", {
  path: "/v1/flags",
  token: userTok,
  expect: { status: 200 },
  check: (j) => (j?.flags?.auto_detect === false ? null : "auto_detect should be false"),
});
await call("admin flag: restore auto_detect", {
  method: "PUT",
  path: "/v1/admin/flags/auto_detect",
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({ enabled: true, rolloutPercent: 100 }),
  expect: { status: 200 },
});
await call("flags: auto_detect true after restore", {
  path: "/v1/flags",
  token: userTok,
  expect: { status: 200 },
  check: (j) => (j?.flags?.auto_detect === true ? null : "auto_detect should be true"),
});
await call("admin flag: 4 KB flag key => typed 4xx envelope?", {
  method: "PUT",
  path: `/v1/admin/flags/${"k".repeat(4096)}`,
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({ enabled: false }),
  expect: { status: 414 },
  check: (j) =>
    j?.error && typeof j.error === "object" && typeof j.error.kind === "string"
      ? null
      : "fastify default error body, not the typed {error:{kind,code,...}} envelope",
  why: "params > maxParamLength(100) are rejected by the router before hooks/error handler run",
});
await call("user route: 101-char path id => typed 4xx envelope?", {
  method: "GET",
  path: `/v1/shots/${"a".repeat(101)}`,
  token: userTok,
  expect: { status: 414 },
  check: (j) =>
    j?.error && typeof j.error === "object" && typeof j.error.kind === "string"
      ? null
      : "fastify default error body, not the typed {error:{kind,code,...}} envelope",
});
await call("admin flag: empty patch {} creates row", {
  method: "PUT",
  path: `/v1/admin/flags/${probeFlag}_empty`,
  token: adminTok,
  headers: JSON_CT,
  body: "{}",
  expect: { status: 200 },
  why: "documents that an empty patch upserts enabled=false rollout=100",
});

// ---------------------------------------------------------------- admin drills / bundles
await call("admin drill: path slug vs body slug", {
  method: "PUT",
  path: `/v1/admin/drills/path-slug-${runId}`,
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({
    slug: `body-slug-${runId}`,
    title: "audit",
    description: "audit",
    coachName: null,
    difficultyMin: null,
    difficultyMax: null,
    active: false,
    mappings: [],
  }),
  expect: { status: 200 },
  why: "which slug is persisted is checked by the wrapper via psql",
});
await call("admin drill: invalid body", {
  method: "PUT",
  path: `/v1/admin/drills/x-${runId}`,
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({ slug: "BAD SLUG" }),
  expect: { status: 400, code: "validation.admin_drill" },
});
await call("admin bundle: invalid sha", {
  method: "PUT",
  path: `/v1/admin/model-bundles/audit-${runId}`,
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({ manifestSha256: "nope", status: "draft", rolloutPercent: 0 }),
  expect: { status: 400, code: "validation.admin_bundle" },
});
await call("admin bundle: draft 0%", {
  method: "PUT",
  path: `/v1/admin/model-bundles/audit-${runId}`,
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({ manifestSha256: "a".repeat(64), status: "draft", rolloutPercent: 0 }),
  expect: { status: 200 },
});
await call("admin scoring release: prerequisite missing", {
  method: "PUT",
  path: `/v1/admin/scoring-models/dink/v-audit-${runId}/release`,
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({
    modelBundleVersion: `audit-${runId}`,
    datasetSnapshotId: "snapshot-audit-1",
    evaluationReportSha256: "b".repeat(64),
    coachValidationReference: "audit-ref",
  }),
  expect: { status: 409, code: "scoring.release_prerequisite_missing" },
  why: "draft bundle at 0% must not release",
});
await call("admin stability: invalid window", {
  method: "POST",
  path: "/v1/admin/stability/window",
  token: adminTok,
  headers: JSON_CT,
  body: JSON.stringify({ windowId: 1 }),
  expect: { status: 400, code: "validation.stability_window" },
});

// ---------------------------------------------------------------- catalog / library empty states (user)
await call("catalog drills (public seed only)", {
  path: "/v1/catalog/drills",
  token: userTok,
  expect: { status: 200 },
  check: (j) => {
    const drills = j?.items;
    if (!Array.isArray(drills)) return "items array expected";
    if (drills.some((d) => String(d.slug).includes(runId)))
      return "inactive audit drill leaked into catalog";
    return null;
  },
});
await call("library shots: empty", {
  path: "/v1/library/shots",
  token: userTok,
  expect: { status: 200 },
  check: (j) =>
    Array.isArray(j?.items) && j.items.length === 0 && j.cursor === null
      ? null
      : "empty items + null cursor expected",
});
await call("shot by id: not mine / missing", {
  path: `/v1/shots/${randomUUID()}`,
  token: userTok,
  expect: { status: 404, code: "shot.not_found" },
});
await call("progress: no data", { path: "/v1/progress", token: userTok, expect: { status: 200 } });
await call("weekly-reports/latest: no reps => report null (never fabricated)", {
  path: "/v1/weekly-reports/latest",
  token: userTok,
  expect: { status: 200 },
  check: (j) => (j && "report" in j && j.report === null ? null : "report:null expected"),
});
await call("consent export: no ledger", {
  path: "/v1/me/consent/export",
  token: userTok,
  expect: { status: 404, code: "consent.no_ledger" },
});

// ---------------------------------------------------------------- rate limit
if (probeRateLimit) {
  const rlTok = mint({ sub: `audit-rl-${runId}` });
  let first429 = null;
  let n = 0;
  for (; n < 80; n++) {
    const r = await fetch(`${baseUrl}/v1/account/bootstrap`, {
      method: "POST",
      headers: { ...JSON_CT, authorization: `Bearer ${rlTok}` },
      body: bootstrapBody,
    });
    await r.text();
    if (r.status === 429) {
      first429 = { at: n + 1, retryAfter: r.headers.get("retry-after") };
      break;
    }
  }
  records.push({
    name: "rate limit: expensive route budget (60/min per token)",
    method: "POST",
    path: "/v1/account/bootstrap",
    outcome: first429 && first429.at === 61 && first429.retryAfter ? "pass" : "fail",
    first429,
    requestsSent: n + 1,
    why: "61st call within the window must be 429 with retry-after",
  });
}

finish();

function finish() {
  const summary = {
    total: records.length,
    pass: records.filter((r) => r.outcome === "pass").length,
    fail: records.filter((r) => r.outcome === "fail").length,
    unavailable: records.filter((r) => r.outcome === "unavailable").length,
    openapiPaths: Object.keys(openapi?.json?.paths ?? {}).length,
    userId,
    runId,
  };
  if (asJson) {
    console.log(JSON.stringify({ baseUrl, summary, records }, null, 2));
  } else {
    for (const r of records) {
      console.log(
        `${r.outcome.padEnd(11)} ${String(r.status ?? "-").padEnd(4)} ${r.name}${r.problems?.length ? "  <- " + r.problems.join("; ") : ""}`,
      );
    }
    console.log(JSON.stringify(summary));
  }
  process.exit(summary.fail > 0 ? 1 : summary.unavailable === summary.total ? 2 : 0);
}
