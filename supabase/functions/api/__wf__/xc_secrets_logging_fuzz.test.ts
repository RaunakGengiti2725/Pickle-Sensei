// Cross-cutting security harness (secrets / logging / privacy) for the edge
// function: seeded adversarial fuzz through the REAL handler (routesHarness:
// Deno.serve captured, Supabase Auth/PostgREST + RevenueCat stubbed at fetch).
//
// Every iteration fires one request at a random route with sentinel-laden
// bearer, headers, query string and body (free-text fields, tokens, emails,
// file URIs, pose-frame markers), under a random upstream posture (PostgREST
// healthy / 5xx with a sentinel in its error text / RPC missing), and then
// asserts on what came OUT:
//
//   response body      never carries the bearer, any server secret from env
//                      (service role key, RevenueCat key, webhook secret,
//                      Apple PEM/encryption key), any upstream error text, or
//                      a request-side sentinel when the status is >= 400;
//   response headers   x-request-id is minted (never the malformed client one);
//   access-log lines   exactly the categorical key set {evt, requestId,
//                      method, route, status, durationMs[, code]} and no
//                      sentinel of any kind;
//   console.error/warn never a bearer, a server secret, or a request-side
//                      free-text / query / header sentinel. Upstream error
//                      TEXT is allowed there by design (5xx detail lives in
//                      function logs only) and is counted, not failed.
//
// Failures record {seed, iteration, route, auth, upstream, channel, kinds}
// so they replay with XC_SEED=<seed> XC_ITER=<iteration+1>. The JSON matrix
// is written to XC_ARTIFACT_DIR (default: Deno temp dir).
//
//   cd supabase/functions/api/__wf__ && XC_SEED=1 XC_ITER=1500 \
//     XC_ARTIFACT_DIR=/tmp/xc deno test -A --no-check --config deno.json \
//     xc_secrets_logging_fuzz.test.ts

import { assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  loadHarness,
  TEST_USER_ID,
  WEBHOOK_SECRET,
} from "./routesHarness.ts";

const SEED = Number.parseInt(Deno.env.get("XC_SEED") ?? "1602847", 10);
const ITER = Number.parseInt(Deno.env.get("XC_ITER") ?? "1500", 10);
const ARTIFACT_DIR = Deno.env.get("XC_ARTIFACT_DIR") ?? Deno.makeTempDirSync();

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHANUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function randomString(rng: () => number, n: number, alphabet = ALPHANUM): string {
  let out = "";
  for (let i = 0; i < n; i += 1) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}
function randomUuid(rng: () => number): string {
  const hex = "0123456789abcdef";
  const s = (n: number) => randomString(rng, n, hex);
  return `${s(8)}-${s(4)}-4${s(3)}-8${s(3)}-${s(12)}`;
}
function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

// ─── Sentinels ───────────────────────────────────────────────────────────────

type Channel = "body" | "header" | "access_log" | "console";

interface Sentinel {
  kind: string;
  /** Where it was injected. */
  side: "request" | "upstream" | "env";
  needle: string;
}

/** Server secrets the harness planted in env (routesHarness.loadHarness). */
function envSecrets(appleTokenEncryptionKey: string): Sentinel[] {
  return [
    { kind: "env.service_role_key", side: "env", needle: "service-role-test-key" },
    { kind: "env.revenuecat_secret", side: "env", needle: "sk_test_revenuecat" },
    { kind: "env.webhook_secret", side: "env", needle: WEBHOOK_SECRET },
    { kind: "env.apple_private_key", side: "env", needle: "-----BEGIN PRIVATE KEY-----" },
    { kind: "env.apple_encryption_key", side: "env", needle: appleTokenEncryptionKey },
    { kind: "env.anon_key", side: "env", needle: "anon-test-key" },
  ];
}

interface Case {
  route: string;
  method: string;
  path: string;
  auth: "google" | "apple" | "garbage" | "sentinel_jwt" | "none";
  upstream: "ok" | "pg_error_with_sentinel" | "rpc_missing";
  request: Request;
  sentinels: Sentinel[];
  upstreamNeedle: string;
}

const ROUTES: ReadonlyArray<{ method: string; path: (rng: () => number) => string; kind: string }> =
  [
    { method: "GET", path: () => "/v1/me", kind: "me" },
    { method: "PUT", path: () => "/v1/me/onboarding", kind: "onboarding" },
    { method: "GET", path: () => "/v1/me/access", kind: "access" },
    { method: "POST", path: () => "/v1/billing/sync", kind: "billing" },
    { method: "POST", path: () => "/v1/analysis-permits", kind: "permit" },
    {
      method: "POST",
      path: (rng) => `/v1/analysis-permits/${randomUuid(rng)}/finalize`,
      kind: "permit_finalize",
    },
    { method: "POST", path: () => "/v1/shots:sync", kind: "shots" },
    { method: "POST", path: () => "/v1/sessions", kind: "session" },
    {
      method: "POST",
      path: (rng) => `/v1/sessions/${randomUuid(rng)}/finalize`,
      kind: "session_finalize",
    },
    { method: "POST", path: () => "/v1/me/evaluation/trials", kind: "trials" },
    { method: "GET", path: () => "/v1/progress", kind: "progress" },
    { method: "GET", path: () => "/v1/rank", kind: "rank" },
    { method: "GET", path: () => "/v1/me/consent/status", kind: "consent_status" },
    { method: "POST", path: () => "/v1/me/consent/grant", kind: "consent_grant" },
    { method: "POST", path: () => "/v1/me/consent/withdraw", kind: "consent_withdraw" },
    { method: "POST", path: () => "/v1/me/delete-request", kind: "delete_request" },
    { method: "POST", path: () => "/v1/me/delete-confirm", kind: "delete_confirm" },
    { method: "GET", path: () => "/v1/me/saved-drills", kind: "saved_drills" },
    {
      method: "PUT",
      path: (rng) => `/v1/me/saved-drills/${randomString(rng, 8)}`,
      kind: "save_drill",
    },
    { method: "GET", path: () => "/v1/catalog/drills", kind: "catalog" },
    {
      method: "GET",
      path: (rng) => `/v1/catalog/drills/${randomString(rng, 8)}`,
      kind: "catalog_one",
    },
    { method: "GET", path: () => "/v1/training-plans/current", kind: "plan_current" },
    { method: "POST", path: () => "/v1/training-plans", kind: "plan_create" },
    {
      method: "POST",
      path: (rng) => `/v1/analyses/${randomUuid(rng)}/feedback`,
      kind: "feedback",
    },
    { method: "POST", path: () => "/v1/auth/logout", kind: "logout" },
    { method: "POST", path: () => "/v1/auth/refresh", kind: "refresh" },
    { method: "POST", path: () => "/v1/account/bootstrap", kind: "bootstrap" },
    { method: "GET", path: (rng) => `/v1/${randomString(rng, 6)}`, kind: "unknown" },
    { method: "GET", path: () => "/healthz", kind: "healthz" },
    { method: "GET", path: () => "/privacy", kind: "privacy" },
    { method: "POST", path: () => "/webhooks/revenuecat", kind: "webhook" },
  ];

function buildCase(rng: () => number, iteration: number): Case {
  const tag = `XC${iteration}_${randomString(rng, 10)}`;
  const route = pick(rng, ROUTES);
  const path = route.path(rng);

  const freeText = `free text ${tag}-ft`;
  const email = `${randomString(rng, 6).toLowerCase()}.${tag.toLowerCase()}@example.com`;
  const fileUri = `file:///var/mobile/Containers/${randomUuid(rng)}/Captures/${tag}.pose.json`;
  const landmark = `landmark:${tag}`;
  const sentinelJwt = `eyJhbGciOiJIUzI1NiJ9.${randomString(rng, 30)}${tag}-jwt.${randomString(rng, 20)}`;
  const garbageBearer = `${randomString(rng, 24)}${tag}-brr`;
  const queryNeedle = `${tag}-qs`;
  const headerNeedle = `${tag}-hdr`;
  const upstreamNeedle = `${tag}-upstream`;

  // ~70% authenticated so the post-auth routes get real coverage; each valid
  // token carries its own subject so the per-user budget never trips.
  const auth = pick(rng, [
    "google",
    "google",
    "google",
    "apple",
    "apple",
    "garbage",
    "sentinel_jwt",
    "none",
  ] as const);
  const subject = randomUuid(rng);
  const upstream = pick(rng, ["ok", "pg_error_with_sentinel", "rpc_missing"] as const);

  const headers = new Headers({
    "x-forwarded-for": `${pick(rng, ["203.0.113", "198.51.100", "192.0.2"])}.${
      1 + Math.floor(rng() * 250)
    }`,
    // Malformed on purpose (space + too long) so the server MUST mint one.
    "x-request-id": `${headerNeedle} ${randomString(rng, 70)}`,
    "user-agent": `PickleSensei/1.0 ${headerNeedle}`,
    "x-client-version": `1.0-${headerNeedle}`,
  });
  const bearer =
    auth === "google"
      ? fakeGoogleIdToken(subject)
      : auth === "apple"
        ? fakeAppleIdToken(subject)
        : auth === "garbage"
          ? garbageBearer
          : auth === "sentinel_jwt"
            ? sentinelJwt
            : null;
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  if (route.kind === "webhook" && rng() < 0.5) headers.set("Authorization", WEBHOOK_SECRET);

  const bodyByKind: Record<string, unknown> = {
    onboarding: {
      handedness: pick(rng, ["right", "left", freeText]),
      skillLevel: pick(rng, ["beginner", freeText]),
      goal: pick(rng, ["consistency", freeText]),
      biggestProblem: freeText,
      firstName: pick(rng, [freeText.slice(0, 30), email, undefined]),
      gender: pick(rng, ["prefer_not_to_say", freeText, undefined]),
      email,
      accessToken: sentinelJwt,
    },
    billing: { appUserId: TEST_USER_ID, note: freeText },
    permit: { shotType: pick(rng, ["dink", freeText]), clipUri: fileUri },
    permit_finalize: { outcome: pick(rng, ["scored", freeText]), note: freeText },
    shots: {
      shots: [
        {
          id: randomUuid(rng),
          analysisPermitId: randomUuid(rng),
          sessionId: null,
          shotType: pick(rng, ["dink", freeText]),
          cameraView: "side",
          capturedAt: new Date().toISOString(),
          timestamps: { startMs: 0, contactMs: 400, endMs: 900 },
          overallScore: 7,
          confidence: 0.9,
          resultKind: "scored",
          source: "real",
          phases: [],
          checkpoints: [],
          versionVector: { appVersion: "1.0" },
          clip: { uri: fileUri, poseSequence: { frames: [{ l: [{ n: landmark }] }] } },
          email,
        },
      ],
    },
    session: {
      id: randomUuid(rng),
      startedAt: new Date().toISOString(),
      mode: pick(rng, ["free", freeText]),
      shotType: null,
      focusCheckpoint: freeText,
      clipUri: fileUri,
    },
    session_finalize: { summary: { note: freeText } },
    trials: {
      trials: [
        {
          trialId: randomUuid(rng),
          schemaVersion: 1,
          notes: freeText,
          videoUri: fileUri,
          frames: [{ l: [{ n: landmark }] }],
          dims: { userPseudonym: email, deviceModel: freeText },
        },
      ],
    },
    consent_grant: {
      scope: pick(rng, ["evaluation_trials", freeText]),
      consentVersion: pick(rng, ["2026-08-01", freeText]),
      source: freeText,
      device: `${freeText} ${email}`,
      captureMode: freeText,
    },
    consent_withdraw: { scope: pick(rng, ["evaluation_trials", freeText]), reason: freeText },
    delete_request: {
      survey: {
        reason: pick(rng, ["not_useful", "too_expensive", freeText]),
        wanted: freeText,
        details: `${freeText} ${email} ${fileUri}`,
        platform: pick(rng, ["ios", freeText]),
        appVersion: freeText,
      },
    },
    delete_confirm: { requestId: randomUuid(rng), note: freeText },
    plan_create: { focus: freeText, days: 7, notes: `${freeText} ${email}` },
    feedback: {
      rating: pick(rng, ["accurate", "not_quite", freeText]),
      category: pick(rng, ["wrong_shot", freeText, undefined]),
      comment: `${freeText} ${email}`,
    },
    logout: { note: freeText },
    refresh: { refreshToken: pick(rng, [garbageBearer, sentinelJwt, freeText]) },
    bootstrap: {
      device: { appVersion: "1.0", model: freeText, osVersion: freeText },
      locale: freeText,
      appleAuthorizationCode: garbageBearer,
      email,
    },
    webhook: {
      api_version: "1.0",
      event: {
        type: "INITIAL_PURCHASE",
        app_user_id: pick(rng, [TEST_USER_ID, freeText, email]),
        id: randomUuid(rng),
        note: freeText,
      },
    },
    unknown: { anything: freeText },
  };

  const hasBody = route.method !== "GET" && route.method !== "HEAD";
  let body: string | undefined;
  if (hasBody) {
    const shape = rng();
    if (shape < 0.7) body = JSON.stringify(bodyByKind[route.kind] ?? { note: freeText });
    else if (shape < 0.85) body = `{"broken": "${freeText}`;
    else body = `not json ${freeText} ${email}`;
    headers.set("Content-Type", shape < 0.85 ? "application/json" : "text/plain");
  }

  const query = `?${encodeURIComponent(randomString(rng, 5))}=${encodeURIComponent(queryNeedle)}&token=${encodeURIComponent(garbageBearer)}&email=${encodeURIComponent(email)}`;
  const request = new Request(`http://edge.test/functions/v1/api${path}${query}`, {
    method: route.method,
    headers,
    body,
  });

  const sentinels: Sentinel[] = [
    { kind: "bearer", side: "request", needle: `${tag}-brr` },
    { kind: "sentinel_jwt", side: "request", needle: `${tag}-jwt` },
    { kind: "free_text", side: "request", needle: `${tag}-ft` },
    { kind: "email", side: "request", needle: email },
    { kind: "file_uri", side: "request", needle: fileUri },
    { kind: "pose_landmark", side: "request", needle: landmark },
    { kind: "query", side: "request", needle: queryNeedle },
    { kind: "header", side: "request", needle: headerNeedle },
    { kind: "upstream_error_text", side: "upstream", needle: upstreamNeedle },
  ];

  return {
    route: `${route.method} ${route.kind}`,
    method: route.method,
    path,
    auth,
    upstream,
    request,
    sentinels,
    upstreamNeedle,
  };
}

// ─── Run ─────────────────────────────────────────────────────────────────────

interface Failure {
  seed: number;
  iteration: number;
  route: string;
  auth: string;
  upstream: string;
  status: number;
  channel: Channel;
  kinds: string[];
  detail?: string;
}

const ACCESS_LOG_KEYS = new Set([
  "evt",
  "requestId",
  "method",
  "route",
  "status",
  "durationMs",
  "code",
]);

Deno.test(`edge secrets/logging fuzz (seed=${SEED}, iter=${ITER})`, async () => {
  const harness = await loadHarness();
  const secrets = envSecrets(harness.appleTokenEncryptionKey);
  const rng = mulberry32(SEED);

  const failures: Failure[] = [];
  const statusHistogram: Record<string, number> = {};
  const routeHistogram: Record<string, number> = {};
  let upstreamTextInConsole = 0;
  let requestEchoIn2xxBody = 0;
  let consoleLines = 0;
  let accessLines = 0;

  const realConsole = { error: console.error, warn: console.warn, log: console.log };
  const captured: string[] = [];
  const capture = (...args: unknown[]) => {
    captured.push(
      args
        .map((a) =>
          a instanceof Error
            ? `${a.name}: ${a.message} ${a.stack ?? ""}`
            : typeof a === "string"
              ? a
              : JSON.stringify(a),
        )
        .join(" "),
    );
  };
  const access: string[] = [];
  const restoreAccess = captureAccessLog((line) => access.push(line));
  console.error = capture;
  console.warn = capture;
  console.log = capture;

  // Route the fake PostgREST posture through the harness fetch by wrapping it.
  const harnessFetch = globalThis.fetch;
  let currentUpstream: Case["upstream"] = "ok";
  let currentNeedle = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("http://supabase.test/rest/v1/")) {
      if (currentUpstream === "pg_error_with_sentinel") {
        return new Response(
          JSON.stringify({
            code: "23514",
            message: `new row violates check constraint ${currentNeedle}`,
            details: `Failing row contains (${currentNeedle}, secret-row-content)`,
            hint: null,
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
      if (currentUpstream === "rpc_missing" && url.includes("/rest/v1/rpc/")) {
        return new Response(
          JSON.stringify({ code: "PGRST202", message: `rpc missing ${currentNeedle}` }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    return harnessFetch(input, init);
  }) as typeof fetch;

  try {
    for (let iteration = 0; iteration < ITER; iteration += 1) {
      harness.reset();
      harness.rpcs = {
        access_state: [{ scored_count: 0, reserved: 0, premium: false }],
        reserve_analysis_permit: [{ result: "ok", permit_id: randomUuid(rng) }],
        apply_synced_shot: [{ accepted: true }],
      };
      const c = buildCase(rng, iteration);
      currentUpstream = c.upstream;
      currentNeedle = c.upstreamNeedle;
      captured.length = 0;
      access.length = 0;

      const response = await harness.handler(c.request);
      const text = await response.text();
      const requestId = response.headers.get("x-request-id") ?? "";
      const key = String(response.status);
      statusHistogram[key] = (statusHistogram[key] ?? 0) + 1;
      routeHistogram[c.route] = (routeHistogram[c.route] ?? 0) + 1;
      consoleLines += captured.length;
      accessLines += access.length;

      const all = [...c.sentinels, ...secrets];
      const record = (channel: Channel, kinds: string[], detail?: string) => {
        if (kinds.length === 0) return;
        failures.push({
          seed: SEED,
          iteration,
          route: c.route,
          auth: c.auth,
          upstream: c.upstream,
          status: response.status,
          channel,
          kinds,
          detail,
        });
      };

      // Response body: never a bearer/JWT, never env secrets, never upstream
      // text; request-side free-text/email/uri/query/header never on >= 400.
      const bodyBanned = all.filter(
        (s) =>
          s.side === "env" ||
          s.side === "upstream" ||
          s.kind === "bearer" ||
          s.kind === "sentinel_jwt" ||
          (response.status >= 400 && s.side === "request"),
      );
      record(
        "body",
        bodyBanned.filter((s) => text.includes(s.needle)).map((s) => s.kind),
      );

      // Headers: minted request id, nothing reflected.
      const headerText = [...response.headers.entries()].map(([k, v]) => `${k}:${v}`).join("\n");
      const headerHits = all.filter((s) => headerText.includes(s.needle)).map((s) => s.kind);
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) headerHits.push("request_id_not_minted");
      record("header", headerHits);

      // Access log: exactly one line, categorical keys only, no sentinels.
      const accessHits: string[] = [];
      if (access.length !== 1) accessHits.push(`access_lines=${access.length}`);
      for (const line of access) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        for (const k of Object.keys(parsed))
          if (!ACCESS_LOG_KEYS.has(k)) accessHits.push(`key:${k}`);
        if (parsed.route !== undefined && /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(parsed.route))) {
          accessHits.push("route_contains_uuid");
        }
        for (const s of all) if (line.includes(s.needle)) accessHits.push(s.kind);
      }
      record("access_log", accessHits);

      // console.*: never bearer / env / request-side sentinels. Upstream error
      // text is allowed (detail belongs in function logs) and counted.
      const consoleText = captured.join("\n");
      const consoleBanned = all.filter((s) => s.side !== "upstream");
      record(
        "console",
        consoleBanned.filter((s) => consoleText.includes(s.needle)).map((s) => s.kind),
      );
      if (consoleText.includes(c.upstreamNeedle)) upstreamTextInConsole += 1;
      // Positive control for the body detector: a 2xx echoing the caller's own
      // free text (e.g. the onboarding profile) is legitimate and counted.
      if (
        response.status < 400 &&
        c.sentinels.some(
          (s) => s.side === "request" && s.kind === "free_text" && text.includes(s.needle),
        )
      ) {
        requestEchoIn2xxBody += 1;
      }
    }
  } finally {
    globalThis.fetch = harnessFetch;
    restoreAccess();
    console.error = realConsole.error;
    console.warn = realConsole.warn;
    console.log = realConsole.log;
  }

  await Deno.mkdir(ARTIFACT_DIR, { recursive: true });
  const artifact = `${ARTIFACT_DIR}/xc-edge-secrets-logging-fuzz.json`;
  await Deno.writeTextFile(
    artifact,
    JSON.stringify(
      {
        harness: "xc_secrets_logging_fuzz",
        seed: SEED,
        iterations: ITER,
        routes: ROUTES.length,
        sentinelsPerIteration: 9 + 6,
        statusHistogram,
        routeHistogram,
        consoleLines,
        accessLines,
        upstreamErrorTextSeenInConsole: upstreamTextInConsole,
        requestFreeTextEchoedIn2xxBody: requestEchoIn2xxBody,
        failures,
      },
      null,
      2,
    ),
  );
  // Positive control: the console capture must have seen upstream error text
  // (5xx detail is logged server-side by design); zero means the detector is
  // blind and the run proves nothing.
  if (ITER >= 100 && upstreamTextInConsole === 0) {
    failures.push({
      seed: SEED,
      iteration: -1,
      route: "*",
      auth: "*",
      upstream: "pg_error_with_sentinel",
      status: 0,
      channel: "console",
      kinds: ["positive_control_missing"],
    });
  }
  assertEquals(failures, [], `see ${artifact}`);
});
