/**
 * ADVERSARIAL PASS 3 — `edge-domain-routes` (in-process, no Postgres).
 *
 * Every request goes through the REAL Deno.serve handler captured by
 * routesHarness.ts; Supabase PostgREST/Auth are faked at the fetch layer. On
 * top of the harness's static table/rpc maps this file installs a stateful
 * interceptor (`intercept`) so a table can answer differently on successive
 * reads (0 rows then 1 row), paginate by `offset`/`limit`, or act as an
 * append-only ledger — and a controllable clock (`clock`) so the auth-cache
 * TTL and the UTC day boundary can be driven deterministically.
 *
 * Run (from supabase/functions/api/__wf__):
 *   deno test -A --no-check --config deno.json attack_edge_domain_routes_1.test.ts
 *
 * Scenarios (coordinator numbering):
 *   S1  account deletion vs a SECOND cached bearer of the same user
 *   S2  consent withdraw → feedback.reviewEligible / evaluation trials 403
 *   S3  HTTP path of cross-user permit theft (RPC status → sync rejection)
 *   S4  GET /v1/me profile retry timing + generic 503
 *   S5  GET /v1/progress MAX_PAGES truncation + streak from truncated rows
 *   S6  GET /v1/progress UTC day boundary vs device-local, future rows
 *   S7  GET /v1/rank null/NaN saved rating + zero confidence_weight
 *   X*  extra probes (leak checks, rapid repeats, interleavings, unicode)
 */
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
  fakeGoogleIdToken,
  loadHarness,
  SUPABASE_URL,
  userRequest,
  type Harness,
} from "./routesHarness.ts";

// ─── Controllable clock ──────────────────────────────────────────────────────
// `offsetMs` shifts Date.now()/new Date() forward; `frozenMs` pins them.
const RealDate = Date;
const clock = { offsetMs: 0, frozenMs: null as number | null };
const nowMs = (): number =>
  clock.frozenMs !== null ? clock.frozenMs : RealDate.now() + clock.offsetMs;
class TestDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(nowMs());
    else super(...(args as [number]));
  }
  static override now(): number {
    return nowMs();
  }
}
globalThis.Date = TestDate as unknown as DateConstructor;

// ─── Stateful fetch interceptor layered over the harness fake ────────────────
interface Seen {
  at: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
type Interceptor = (req: Request, seen: Seen) => Promise<Response | null> | Response | null;
const seen: Seen[] = [];
let interceptors: Interceptor[] = [];
let h: Harness;
let harnessFetch: typeof fetch;

async function boot(): Promise<Harness> {
  if (!h) {
    h = await loadHarness();
    harnessFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      const text = await req.clone().text().catch(() => "");
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const entry: Seen = { at: performance.now(), method: req.method, url: req.url, headers, body };
      seen.push(entry);
      for (const interceptor of interceptors) {
        const res = await interceptor(req.clone(), entry);
        if (res) return res;
      }
      return harnessFetch(input, init);
    }) as typeof fetch;
  } else {
    h.reset();
  }
  seen.length = 0;
  interceptors = [];
  clock.offsetMs = 0;
  clock.frozenMs = null;
  return h;
}

const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const restPath = (req: Request): string => new URL(req.url).pathname;
const seenRest = (table: string): Seen[] =>
  seen.filter((s) => new URL(s.url).pathname === `/rest/v1/${table}`);

const b64url = (v: string): string =>
  btoa(v).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Supabase-issued access token (iss ends with /auth/v1) — the contract
 * bearer every non-bootstrap route takes; verified through GET /auth/v1/user. */
function fakeSupabaseAccessToken(sub: string, nonce = crypto.randomUUID()): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      session_id: nonce,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.sig`;
}

let ipCounter = 0;
/** Unique client IP per test so per-IP budgets never couple scenarios. */
const nextIp = (): string => `198.51.100.${(ipCounter++ % 250) + 1}`;

const pastIso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const futureIso = (msAhead: number): string => new Date(Date.now() + msAhead).toISOString();
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

function validSyncShot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    source: "real",
    analysisPermitId: crypto.randomUUID(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// S1 — account deletion vs a second cached bearer of the same user
// ═════════════════════════════════════════════════════════════════════════════

Deno.test("S1: a second cached bearer of a deleted account is served from cache until the 600 s cap, then rejected", async () => {
  await boot();
  const userId = crypto.randomUUID();
  const ip = nextIp();
  const deviceA = fakeGoogleIdToken(userId); // legacy provider bearer (device A)
  const deviceB = fakeSupabaseAccessToken(userId); // session bearer (device B)
  let accountDeleted = false;
  let getUserCalls = 0;

  // Fake GoTrue getUser: valid while the account exists; once auth.users is
  // gone GoTrue answers 403 session_not_found (the token is still signed).
  interceptors.push((req) => {
    if (restPath(req) !== "/auth/v1/user") return null;
    getUserCalls += 1;
    if (accountDeleted) {
      return jsonRes(403, {
        code: 403,
        error_code: "session_not_found",
        msg: "Session from session_id claim in JWT does not exist",
      });
    }
    return jsonRes(200, {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: "u@example.com",
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: {},
    });
  });

  // access_state() for a LIVE account: one scored shot already used.
  h.rpcs.access_state = [{ premium: false, scored_count: 1, reserved_count: 0 }];
  h.tables.profiles = [{ id: userId, email: "u@example.com", onboarding_state: "complete", provider: "google" }];

  // 1. Device B warms its own auth-cache entry.
  const warm = await h.handler(userRequest("GET", "/v1/me/access", { token: deviceB, ip }));
  assertEquals(warm.status, 200);
  assertEquals(getUserCalls, 1);
  assertEquals(((await warm.json()) as { freeRatings: { used: number } }).freeRatings.used, 1);

  // 2. Device A deletes the account.
  const challenge = crypto.randomUUID();
  h.tables.account_deletion_requests = [
    { challenge, created_at: pastIso(10_000), expires_at: futureIso(60_000) },
  ];
  const del = await h.handler(
    userRequest("POST", "/v1/me/delete-confirm", { token: deviceA, ip, body: { challenge } }),
  );
  assertEquals(del.status, 200);
  assertEquals(((await del.json()) as { deleted: boolean }).deleted, true);
  assertEquals(seen.filter((s) => s.method === "DELETE" && s.url.includes("/auth/v1/admin/users/")).length, 1);
  accountDeleted = true;
  // Post-cascade world, as measured on Postgres for a non-existent auth.uid()
  // (attack_edge_domain_routes_1_pg.test.ts "PG-S1"): access_state() returns
  // premium=false, scored_count=0, reserved_count=0 — a FRESH free-rating state.
  h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
  h.tables.profiles = [];
  h.tables.account_deletion_requests = [];

  // 3. Device B keeps working from cache — and the deleted account now looks
  //    like a brand-new one with both free ratings available.
  const stale = await h.handler(userRequest("GET", "/v1/me/access", { token: deviceB, ip }));
  assertEquals(stale.status, 200, "second bearer still authenticates after deletion");
  assertEquals(getUserCalls, 1, "served from the auth cache: no GoTrue round trip");
  const staleBody = (await stale.json()) as {
    freeRatings: { used: number; availableToReserve: number };
    canStartRating: boolean;
  };
  assertEquals(staleBody.freeRatings.used, 0);
  assertEquals(staleBody.freeRatings.availableToReserve, 2);
  assertEquals(staleBody.canStartRating, true);

  // 3b. GET /v1/me from device B: profile row is gone → generic retryable 503
  //     (the app will retry; nothing tells it the account no longer exists).
  const me = await h.handler(userRequest("GET", "/v1/me", { token: deviceB, ip }));
  assertEquals(me.status, 503);
  assertEquals(
    ((await me.json()) as { error: { message: string } }).error.message,
    "Your account is temporarily unavailable. Please try again.",
  );
  assertEquals(getUserCalls, 1);

  // 4. Just under the cap the entry is still served. writeAuthCache stores
  //    the entry with ttl = 600 s - 30 s = 570 s and readAuthCache keeps a 5 s
  //    margin, so ~565 s is the last served instant; probe at 560 s.
  clock.offsetMs = 560_000;
  const nearCap = await h.handler(userRequest("GET", "/v1/me/access", { token: deviceB, ip }));
  assertEquals(nearCap.status, 200);
  assertEquals(getUserCalls, 1);

  // 5. Past the 600 s cap the bearer is re-verified and GoTrue refuses it.
  clock.offsetMs = 601_000;
  const expired = await h.handler(userRequest("GET", "/v1/me/access", { token: deviceB, ip }));
  assertEquals(getUserCalls, 2, "cache entry aged out → GoTrue consulted");
  assertEquals(expired.status, 401);
  assertStringIncludes(
    ((await expired.json()) as { error: { message: string } }).error.message,
    "no longer valid",
  );

  // 6. Device A's own bearer was evicted immediately (regression guard).
  clock.offsetMs = 0;
  const tokenCallsBefore = seen.filter((s) => s.url.startsWith(`${SUPABASE_URL}/auth/v1/token`)).length;
  const a = await h.handler(userRequest("GET", "/v1/me/access", { token: deviceA, ip }));
  const tokenCallsAfter = seen.filter((s) => s.url.startsWith(`${SUPABASE_URL}/auth/v1/token`)).length;
  assertEquals(tokenCallsAfter, tokenCallsBefore + 1, "deleting bearer is re-exchanged, not cached");
  assertEquals(a.status, 200); // the fake token endpoint always mints; the real one would 401
});

Deno.test("S1b: a stale second bearer can still hit write routes; FK failures surface as generic 503, not 401", async () => {
  await boot();
  const userId = crypto.randomUUID();
  const ip = nextIp();
  const deviceB = fakeSupabaseAccessToken(userId);
  interceptors.push((req) =>
    restPath(req) === "/auth/v1/user"
      ? jsonRes(200, {
          id: userId,
          email: "u@example.com",
          app_metadata: { provider: "apple", providers: ["apple"] },
        })
      : null,
  );
  h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
  assertEquals((await h.handler(userRequest("GET", "/v1/me/access", { token: deviceB, ip }))).status, 200);

  // Account deleted elsewhere. As measured on Postgres (PG-S1), a stale uid
  // calling reserve_analysis_permit hits the profiles FK → PostgREST 409/23503.
  interceptors.push((req) =>
    restPath(req) === "/rest/v1/rpc/reserve_analysis_permit"
      ? jsonRes(409, {
          code: "23503",
          message: 'insert or update on table "analysis_permits" violates foreign key constraint "analysis_permits_user_id_fkey"',
          details: `Key (user_id)=(${userId}) is not present in table "profiles".`,
          hint: null,
        })
      : null,
  );
  const reserve = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token: deviceB,
      ip,
      body: { idempotencyKey: "after-delete-1" },
    }),
  );
  assertEquals(reserve.status, 503);
  const body = (await reserve.json()) as { error: { message: string; code?: string } };
  assertEquals(body.error.message, "Rating reservation is temporarily unavailable. Please try again.");
  assertEquals(body.error.code, undefined);
  // No DB detail leaks (table names, constraint names, the uid).
  const raw = JSON.stringify(body);
  assert(!raw.includes("profiles") && !raw.includes("23503") && !raw.includes(userId));
  // Consent grant on the deleted account: insert fails on the FK the same way.
  interceptors.push((req) =>
    restPath(req) === "/rest/v1/consent_records" && req.method === "POST"
      ? jsonRes(409, { code: "23503", message: "fk", details: "profiles", hint: null })
      : null,
  );
  const grant = await h.handler(
    userRequest("POST", "/v1/me/consent/grant", {
      token: deviceB,
      ip,
      body: { scope: "model_training", consentVersion: "v1" },
    }),
  );
  assertEquals(grant.status, 503);
});

// ═════════════════════════════════════════════════════════════════════════════
// S2 — consent ledger drives feedback.reviewEligible and evaluation trials
// ═════════════════════════════════════════════════════════════════════════════

/** Append-only consent ledger faked at PostgREST level: POST appends, GET
 * returns everything in insertion order (the real query orders by
 * created_at, id — identical here). */
function installConsentLedger(): Array<Record<string, unknown>> {
  const ledger: Array<Record<string, unknown>> = [];
  let seq = 0;
  interceptors.push(async (req) => {
    if (restPath(req) !== "/rest/v1/consent_records") return null;
    if (req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown> | Record<string, unknown>[];
      for (const row of Array.isArray(body) ? body : [body]) {
        seq += 1;
        ledger.push({
          ...row,
          id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
          created_at: new Date(Date.now() + seq).toISOString(),
        });
      }
      return new Response(null, { status: 201 });
    }
    if (req.method === "GET") return jsonRes(200, ledger);
    return null;
  });
  return ledger;
}

type ConsentStatus = {
  scopes: Array<{ scope: string; active: boolean; consentVersion: string | null; lastAction: string | null }>;
};
const scopeOf = (status: ConsentStatus, scope: string) => status.scopes.find((s) => s.scope === scope)!;

Deno.test("S2: grant→withdraw model_training; feedback.reviewEligible=false from the server ledger despite client claims", async () => {
  await boot();
  const ip = nextIp();
  const token = fakeGoogleIdToken(crypto.randomUUID());
  const ledger = installConsentLedger();

  const granted = await h.handler(
    userRequest("POST", "/v1/me/consent/grant", {
      token,
      ip,
      body: { scope: "model_training", consentVersion: "2026-09-01", source: "mobile_settings" },
    }),
  );
  assertEquals(granted.status, 200);
  assertEquals(scopeOf((await granted.json()) as ConsentStatus, "model_training").active, true);

  const withdrawn = await h.handler(
    userRequest("POST", "/v1/me/consent/withdraw", {
      token,
      ip,
      // Hostile body: tries to smuggle a grant through the withdraw route.
      body: { scope: "model_training", action: "grant", active: true, consentVersion: "v-evil" },
    }),
  );
  assertEquals(withdrawn.status, 200);
  const w = scopeOf((await withdrawn.json()) as ConsentStatus, "model_training");
  assertEquals(w.active, false);
  assertEquals(w.lastAction, "withdrawn");
  assertEquals(w.consentVersion, "2026-09-01", "withdraw carries the granted version forward");
  assertEquals(ledger.length, 2);
  assertEquals(ledger[1].action, "withdraw");
  assertEquals(ledger[1].consent_version, "2026-09-01");

  // Feedback on an owned shot while the client body screams "consented".
  const analysisId = crypto.randomUUID();
  h.tables.shots = [{ id: analysisId }];
  let insertedFeedback: Record<string, unknown> | null = null;
  interceptors.push(async (req) => {
    if (restPath(req) !== "/rest/v1/analysis_feedback" || req.method !== "POST") return null;
    insertedFeedback = (await req.json()) as Record<string, unknown>;
    return jsonRes(201, { id: crypto.randomUUID(), created_at: new Date().toISOString() });
  });
  const fb = await h.handler(
    userRequest("POST", `/v1/analyses/${analysisId}/feedback`, {
      token,
      ip,
      body: {
        rating: "accurate",
        reviewEligible: true,
        review_eligible: true,
        consent: { model_training: true },
        consentScopes: ["model_training"],
      },
    }),
  );
  assertEquals(fb.status, 201);
  const fbBody = (await fb.json()) as { feedback: { reviewEligible: boolean } };
  assertEquals(fbBody.feedback.reviewEligible, false, "derived from the server ledger, not the body");
  assert(insertedFeedback !== null);
  const insertedKeys = Object.keys(insertedFeedback!);
  assert(!insertedKeys.includes("review_eligible") && !insertedKeys.includes("reviewEligible"));
  assertEquals(insertedFeedback!.rating, "accurate");
  assertEquals(insertedFeedback!.category, null);

  // Re-grant → the same route now reports eligible (ledger is the only input).
  h.tables.shots = [{ id: analysisId }];
  assertEquals(
    (await h.handler(
      userRequest("POST", "/v1/me/consent/grant", {
        token,
        ip,
        body: { scope: "model_training", consentVersion: "2026-09-02" },
      }),
    )).status,
    200,
  );
  const analysisId2 = crypto.randomUUID();
  h.tables.shots = [{ id: analysisId2 }];
  const fb2 = await h.handler(
    userRequest("POST", `/v1/analyses/${analysisId2}/feedback`, {
      token,
      ip,
      body: { rating: "not_quite", category: "wrong_stroke", reviewEligible: false },
    }),
  );
  assertEquals(fb2.status, 201);
  assertEquals(((await fb2.json()) as { feedback: { reviewEligible: boolean } }).feedback.reviewEligible, true);
});

Deno.test("S2: evaluation trials are refused (403) once evaluation_telemetry is withdrawn; nothing is written", async () => {
  await boot();
  const ip = nextIp();
  const token = fakeGoogleIdToken(crypto.randomUUID());
  installConsentLedger();
  const trial = { trials: [{ trialId: crypto.randomUUID(), consent: true, telemetryConsent: "granted" }] };

  // Never granted → 403.
  const never = await h.handler(userRequest("POST", "/v1/me/evaluation/trials", { token, ip, body: trial }));
  assertEquals(never.status, 403);
  assertEquals(((await never.json()) as { error: { code: string } }).error.code, "evaluation.consent_inactive");

  // Granted → accepted (control; proves the ledger read is live).
  await h.handler(
    userRequest("POST", "/v1/me/consent/grant", {
      token,
      ip,
      body: { scope: "evaluation_telemetry", consentVersion: "v1" },
    }),
  );
  h.tables.evaluation_trials = [{ id: trial.trials[0].trialId }];
  const ok = await h.handler(userRequest("POST", "/v1/me/evaluation/trials", { token, ip, body: trial }));
  assertEquals(ok.status, 200);
  assertEquals(((await ok.json()) as { acceptedTrialIds: string[] }).acceptedTrialIds.length, 1);

  // Withdrawn → 403 again and no upsert reaches PostgREST.
  await h.handler(
    userRequest("POST", "/v1/me/consent/withdraw", { token, ip, body: { scope: "evaluation_telemetry" } }),
  );
  const writesBefore = seenRest("evaluation_trials").filter((s) => s.method === "POST").length;
  const refused = await h.handler(userRequest("POST", "/v1/me/evaluation/trials", { token, ip, body: trial }));
  assertEquals(refused.status, 403);
  assertEquals(((await refused.json()) as { error: { code: string } }).error.code, "evaluation.consent_inactive");
  assertEquals(seenRest("evaluation_trials").filter((s) => s.method === "POST").length, writesBefore);

  // Granting a DIFFERENT scope (model_training) does not unlock trials.
  await h.handler(
    userRequest("POST", "/v1/me/consent/grant", {
      token,
      ip,
      body: { scope: "model_training", consentVersion: "v1" },
    }),
  );
  const stillRefused = await h.handler(userRequest("POST", "/v1/me/evaluation/trials", { token, ip, body: trial }));
  assertEquals(stillRefused.status, 403);
});

Deno.test("S2x: interleaved grant/withdraw bursts fold to the LAST ledger action; unknown scopes are rejected", async () => {
  await boot();
  const ip = nextIp();
  const token = fakeGoogleIdToken(crypto.randomUUID());
  installConsentLedger();
  // Seeded pseudo-random interleaving so the run is reproducible.
  const seed = Number(Deno.env.get("PICKLE_ATTACK_SEED") ?? "20260904");
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let expected = false;
  for (let i = 0; i < 12; i += 1) {
    const grant = rand() < 0.5;
    const res = await h.handler(
      userRequest("POST", grant ? "/v1/me/consent/grant" : "/v1/me/consent/withdraw", {
        token,
        ip,
        body: { scope: "model_training", consentVersion: `v${i}` },
      }),
    );
    assertEquals(res.status, 200, `seed ${seed} step ${i}`);
    expected = grant;
    assertEquals(scopeOf((await res.json()) as ConsentStatus, "model_training").active, expected);
  }
  const status = await h.handler(userRequest("GET", "/v1/me/consent/status", { token, ip }));
  assertEquals(scopeOf((await status.json()) as ConsentStatus, "model_training").active, expected);

  for (const scope of ["Model_Training", "model_training ", "modél_training", "", null, 42, ["model_training"]]) {
    const bad = await h.handler(
      userRequest("POST", "/v1/me/consent/grant", { token, ip, body: { scope, consentVersion: "v" } }),
    );
    assertEquals(bad.status, 400, `scope ${JSON.stringify(scope)}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// S3 — HTTP path of cross-user permit theft
// ═════════════════════════════════════════════════════════════════════════════

Deno.test("S3-http: apply_synced_shot 'access.permit_not_found' → 200 with a coded rejection, no evidence written, caches untouched", async () => {
  await boot();
  const ip = nextIp();
  const bob = crypto.randomUUID();
  const token = fakeGoogleIdToken(bob);
  const alicePermit = crypto.randomUUID();
  // What Postgres returns when Bob's jwt sub presents Alice's permit id
  // (measured in attack_edge_domain_routes_1_pg.test.ts PG-S3).
  h.rpcs.apply_synced_shot = "access.permit_not_found";
  h.tables.shots = [];
  const shot = validSyncShot({ analysisPermitId: alicePermit });

  // Warm Bob's rank cache so we can prove a rejected sync does not bust it.
  h.tables.player_technique_rating = [
    { shot_type: "dink", score: 6, captured_at: "2026-09-01T00:00:00Z", sampled_count: 1, confidence_weight: 1 },
  ];
  assertEquals((await h.handler(userRequest("GET", "/v1/rank", { token, ip }))).status, 200);
  const rankReadsBefore = seenRest("player_technique_rating").length;

  const res = await h.handler(userRequest("POST", "/v1/shots:sync", { token, ip, body: { shots: [shot] } }));
  assertEquals(res.status, 200);
  const body = (await res.json()) as {
    acceptedIds: string[];
    rejected: Array<{ id: string; code: string; message: string }>;
  };
  assertEquals(body.acceptedIds, []);
  assertEquals(body.rejected, [
    { id: shot.id as string, code: "access.permit_not_found", message: "Analysis permit not found." },
  ]);
  const rpcCall = seen.find((s) => s.url.endsWith("/rest/v1/rpc/apply_synced_shot"))!;
  assertEquals((rpcCall.body as { shot: { analysisPermitId: string } }).shot.analysisPermitId, alicePermit);
  // The message never reveals whether the permit exists for someone else.
  assert(!body.rejected[0].message.toLowerCase().includes("another") && !body.rejected[0].message.includes(alicePermit));

  // Rank cache intact (no accepted write → no cacheDel).
  assertEquals((await h.handler(userRequest("GET", "/v1/rank", { token, ip }))).status, 200);
  assertEquals(seenRest("player_technique_rating").length, rankReadsBefore);

  // Every other RPC status maps to its coded rejection; unknown → generic write_failed.
  for (const [status, code] of [
    ["access.permit_not_reserved", "access.permit_not_reserved"],
    ["access.permit_expired", "access.permit_expired"],
    ["access.paywall_required", "access.paywall_required"],
    ["shot.session_not_found", "shot.session_not_found"],
    ["shot.id_conflict", "shot.id_conflict"],
    ["shot.write_failed:duplicate key value violates unique constraint \"shots_pkey\"", "shot.write_failed"],
    ["something.unexpected", "shot.write_failed"],
    ["", "shot.write_failed"],
  ] as const) {
    h.rpcs.apply_synced_shot = status;
    const r = await h.handler(
      userRequest("POST", "/v1/shots:sync", { token, ip, body: { shots: [validSyncShot()] } }),
    );
    assertEquals(r.status, 200);
    const b = (await r.json()) as { rejected: Array<{ code: string; message: string }> };
    assertEquals(b.rejected[0].code, code, status);
    assert(!b.rejected[0].message.includes("shots_pkey"), "DB detail must not leak");
  }
});

Deno.test("S3-http: a mixed batch — replayed id accepted without RPC, stolen permit rejected, malformed rejected, valid accepted → caches busted once", async () => {
  await boot();
  const ip = nextIp();
  const token = fakeGoogleIdToken(crypto.randomUUID());
  const replayed = validSyncShot();
  const stolen = validSyncShot();
  const malformed = validSyncShot({ cameraView: "top" });
  const good = validSyncShot();
  h.tables.shots = [{ id: replayed.id }];
  const statuses = new Map<string, string>([
    [stolen.id as string, "access.permit_not_found"],
    [good.id as string, "accepted"],
  ]);
  interceptors.push(async (req) => {
    if (restPath(req) !== "/rest/v1/rpc/apply_synced_shot") return null;
    const { shot } = (await req.json()) as { shot: { id: string } };
    return jsonRes(200, statuses.get(shot.id) ?? "shot.write_failed:unexpected id");
  });
  const res = await h.handler(
    userRequest("POST", "/v1/shots:sync", { token, ip, body: { shots: [replayed, stolen, malformed, good] } }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as { acceptedIds: string[]; rejected: Array<{ id: string; code: string }> };
  assertEquals(body.acceptedIds, [replayed.id, good.id]);
  assertEquals(body.rejected.map((r) => [r.id, r.code]), [
    [malformed.id, "shot.invalid_payload"],
    [stolen.id, "access.permit_not_found"],
  ]);
  assertEquals(seen.filter((s) => s.url.endsWith("/rest/v1/rpc/apply_synced_shot")).length, 2);
});

// ═════════════════════════════════════════════════════════════════════════════
// S4 — GET /v1/me profile retry
// ═════════════════════════════════════════════════════════════════════════════

function installProfileQueue(pages: Array<unknown[] | { status: number; body: unknown }>): void {
  interceptors.push((req) => {
    if (restPath(req) !== "/rest/v1/profiles" || req.method !== "GET") return null;
    const next = pages.shift();
    if (next === undefined) return null;
    if (Array.isArray(next)) return jsonRes(200, next);
    return jsonRes(next.status, next.body);
  });
}

Deno.test("S4: profiles empty then present → exactly two PostgREST GETs ~400 ms apart and 200", async () => {
  await boot();
  const ip = nextIp();
  const userId = crypto.randomUUID();
  const token = fakeGoogleIdToken(userId);
  installProfileQueue([
    [],
    [{ id: userId, email: "u@example.com", onboarding_state: "pending", provider: "google", first_name: "Zoë" }],
  ]);
  const started = performance.now();
  const res = await h.handler(userRequest("GET", "/v1/me", { token, ip }));
  const elapsed = performance.now() - started;
  assertEquals(res.status, 200);
  const body = (await res.json()) as { user: { id: string }; onboardingState: string; profile: { first_name: string } };
  assertEquals(body.user.id, userId);
  assertEquals(body.onboardingState, "pending");
  assertEquals(body.profile.first_name, "Zoë");
  const reads = seenRest("profiles").filter((s) => s.method === "GET");
  assertEquals(reads.length, 2);
  const gap = reads[1].at - reads[0].at;
  assert(gap >= 395 && gap < 700, `retry gap ${gap.toFixed(1)} ms (expected ≈400 ms)`);
  assert(elapsed >= 400, `whole request ${elapsed.toFixed(1)} ms`);
  // Both reads target the same user and the same columns.
  assertEquals(new URL(reads[0].url).searchParams.get("id"), `eq.${userId}`);
  assertEquals(new URL(reads[0].url).search, new URL(reads[1].url).search);
});

Deno.test("S4: profiles empty twice → generic 503 with no detail; a PostgREST error is not retried and never leaks", async () => {
  await boot();
  const ip = nextIp();
  const token = fakeGoogleIdToken(crypto.randomUUID());
  installProfileQueue([[], []]);
  const res = await h.handler(userRequest("GET", "/v1/me", { token, ip }));
  assertEquals(res.status, 503);
  const body = (await res.json()) as { error: Record<string, unknown> };
  assertEquals(body, { error: { message: "Your account is temporarily unavailable. Please try again." } });
  assertEquals(seenRest("profiles").filter((s) => s.method === "GET").length, 2);
  assert((res.headers.get("x-request-id") ?? "").length > 0);

  // Same request budget: a 42501 (missing column grant) → one read, 503, no leak.
  seen.length = 0;
  const token2 = fakeGoogleIdToken(crypto.randomUUID());
  installProfileQueue([
    { status: 403, body: { code: "42501", message: "permission denied for table profiles", details: null, hint: null } },
  ]);
  const denied = await h.handler(userRequest("GET", "/v1/me", { token: token2, ip }));
  assertEquals(denied.status, 503);
  const raw = await denied.text();
  assertEquals(JSON.parse(raw), { error: { message: "Your account is temporarily unavailable. Please try again." } });
  assert(!raw.includes("permission") && !raw.includes("42501") && !raw.includes("profiles"));
  assertEquals(seenRest("profiles").filter((s) => s.method === "GET").length, 1, "errors are not retried");
});

Deno.test("S4x: rapid concurrent GET /v1/me for one user each pay their own retry (no coalescing, no caching)", async () => {
  await boot();
  const ip = nextIp();
  const userId = crypto.randomUUID();
  const token = fakeGoogleIdToken(userId);
  installProfileQueue([[], [], [], [], [], [{ id: userId, email: null, onboarding_state: "complete", provider: "google" }]]);
  const results = await Promise.all(
    [0, 1, 2].map(() => h.handler(userRequest("GET", "/v1/me", { token, ip }))),
  );
  const statuses = results.map((r) => r.status).sort();
  // Three requests → six reads: 5 empty + 1 present. Exactly one wins.
  assertEquals(statuses, [200, 503, 503]);
  assertEquals(seenRest("profiles").filter((s) => s.method === "GET").length, 6);
  await Promise.all(results.map((r) => r.text()));
});

// ═════════════════════════════════════════════════════════════════════════════
// S5 — GET /v1/progress: MAX_PAGES truncation
// ═════════════════════════════════════════════════════════════════════════════

/** Serves `total` rows for a table by PostgREST offset/limit, generating row
 * i via `row(i)`. Returns the log of (offset, limit) pairs requested. */
function installPaged(
  table: string,
  total: number,
  row: (i: number) => Record<string, unknown>,
): Array<{ offset: number; limit: number }> {
  const pages: Array<{ offset: number; limit: number }> = [];
  interceptors.push((req) => {
    const url = new URL(req.url);
    if (url.pathname !== `/rest/v1/${table}` || req.method !== "GET") return null;
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? String(total));
    pages.push({ offset, limit });
    const rows: Record<string, unknown>[] = [];
    for (let i = offset; i < Math.min(total, offset + limit); i += 1) rows.push(row(i));
    return jsonRes(200, rows);
  });
  return pages;
}

Deno.test("S5: 21 000 progress_daily rows → exactly 20 pages, 20 000 rows, the NEWEST 1 000 days silently missing", async () => {
  await boot();
  const ip = nextIp();
  const token = fakeGoogleIdToken(crypto.randomUUID());
  clock.frozenMs = RealDate.UTC(2026, 8, 4, 12, 0, 0); // 2026-09-04T12:00Z
  const today = utcDay(clock.frozenMs);
  const TOTAL = 21_000;
  // Ascending days ending today (matches the server's order by day asc).
  const dayOf = (i: number) => utcDay(clock.frozenMs! - (TOTAL - 1 - i) * DAY_MS);
  const dailyPages = installPaged("progress_daily", TOTAL, (i) => ({
    day: dayOf(i),
    shot_type: "dink",
    scoring_model_version: "scoring-1",
    shot_count: 1,
    avg_score: 6.5,
    best_score: 7,
  }));
  h.tables.practice_days = [{ day: today }];

  const res = await h.handler(userRequest("GET", "/v1/progress", { token, ip }));
  assertEquals(res.status, 200);
  const body = (await res.json()) as {
    series: Array<{ day: string; avg_score: number }>;
    streak: { currentDays: number; practicedToday: boolean };
  };
  assertEquals(dailyPages.length, 20, "MAX_PAGES");
  assertEquals(dailyPages.map((p) => p.offset), Array.from({ length: 20 }, (_, i) => i * 1000));
  assert(dailyPages.every((p) => p.limit === 1000));
  assertEquals(body.series.length, 20_000, "silently truncated");
  assertEquals(body.series[0].day, dayOf(0));
  assertEquals(body.series.at(-1)!.day, dayOf(19_999));
  // The most recent 1 000 days — including TODAY — are absent from the series.
  assertNotEquals(body.series.at(-1)!.day, today);
  assertEquals(body.series.some((r) => r.day === today), false);
  assertEquals(body.series.at(-1)!.avg_score, 65);
  // No indication of truncation anywhere in the payload.
  assertEquals("truncated" in body, false);
  assertEquals("nextPage" in body, false);
  // Streak came from practice_days (1 row) and is unaffected here.
  assertEquals(body.streak.currentDays, 1);
  assertEquals(body.streak.practicedToday, true);
});

Deno.test("S5: 21 000 practice_days rows ending today → streak computed from the truncated OLDEST 20 000: currentDays=0, practicedToday=false", async () => {
  await boot();
  const ip = nextIp();
  const token = fakeGoogleIdToken(crypto.randomUUID());
  clock.frozenMs = RealDate.UTC(2026, 8, 4, 12, 0, 0);
  const today = utcDay(clock.frozenMs);
  const TOTAL = 21_000;
  const dayOf = (i: number) => utcDay(clock.frozenMs! - (TOTAL - 1 - i) * DAY_MS);
  const daysPages = installPaged("practice_days", TOTAL, (i) => ({ day: dayOf(i) }));
  h.tables.progress_daily = [];

  const res = await h.handler(userRequest("GET", "/v1/progress", { token, ip }));
  assertEquals(res.status, 200);
  const body = (await res.json()) as {
    streak: { currentDays: number; longestDays: number; practicedToday: boolean; lastPracticeDate: string };
  };
  assertEquals(daysPages.length, 20);
  // The user practiced every day for 21 000 days including today; the server
  // answers as if the streak ended 1 000 days ago.
  assertEquals(body.streak.longestDays, 20_000);
  assertEquals(body.streak.currentDays, 0);
  assertEquals(body.streak.practicedToday, false);
  assertEquals(body.streak.lastPracticeDate, dayOf(19_999));
  assertNotEquals(body.streak.lastPracticeDate, today);
});

Deno.test("S5x: exactly 20 000 rows stops after 20 full pages without probing page 21; 19 999 stops at the short page", async () => {
  await boot();
  const ip = nextIp();
  clock.frozenMs = RealDate.UTC(2026, 8, 4, 12, 0, 0);
  for (const [total, expectedPages] of [
    [20_000, 20],
    [19_999, 20],
    [1_000, 2],
    [999, 1],
    [0, 1],
  ] as const) {
    await boot();
    clock.frozenMs = RealDate.UTC(2026, 8, 4, 12, 0, 0);
    const token = fakeGoogleIdToken(crypto.randomUUID());
    const pages = installPaged("progress_daily", total, (i) => ({
      day: utcDay(clock.frozenMs! - i * DAY_MS),
      shot_type: "dink",
      scoring_model_version: "v",
      shot_count: 1,
      avg_score: 5,
      best_score: 5,
    }));
    h.tables.practice_days = [];
    const res = await h.handler(userRequest("GET", "/v1/progress", { token, ip }));
    assertEquals(res.status, 200);
    const body = (await res.json()) as { series: unknown[] };
    assertEquals(body.series.length, total, `total ${total}`);
    assertEquals(pages.length, expectedPages, `pages for ${total}`);
  }
});

Deno.test("S5x: a PostgREST error on page 7 fails the whole response with a generic 503 (no partial series)", async () => {
  await boot();
  const ip = nextIp();
  const token = fakeGoogleIdToken(crypto.randomUUID());
  let calls = 0;
  interceptors.push((req) => {
    if (restPath(req) !== "/rest/v1/progress_daily") return null;
    calls += 1;
    if (calls === 7) return jsonRes(500, { code: "57014", message: "canceling statement due to statement timeout" });
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      day: "2026-01-01",
      shot_type: `t${i}`,
      scoring_model_version: "v",
      shot_count: 1,
      avg_score: 5,
      best_score: 5,
    }));
    return jsonRes(200, rows);
  });
  h.tables.practice_days = [];
  const res = await h.handler(userRequest("GET", "/v1/progress", { token, ip }));
  assertEquals(res.status, 503);
  const raw = await res.text();
  assertEquals(JSON.parse(raw), { error: { message: "Progress is temporarily unavailable. Please try again." } });
  assert(!raw.includes("timeout") && !raw.includes("57014"));
  assertEquals(calls, 7);
});

// ═════════════════════════════════════════════════════════════════════════════
// S6 — GET /v1/progress: UTC day boundary vs device-local, future rows
// ═════════════════════════════════════════════════════════════════════════════

type Streak = { currentDays: number; longestDays: number; practicedToday: boolean; lastPracticeDate: string | null };
async function streakFor(days: unknown[], ip: string): Promise<Streak> {
  const token = fakeGoogleIdToken(crypto.randomUUID());
  h.tables.practice_days = days.map((day) => ({ day }));
  h.tables.progress_daily = [];
  const res = await h.handler(userRequest("GET", "/v1/progress", { token, ip }));
  assertEquals(res.status, 200);
  return ((await res.json()) as { streak: Streak }).streak;
}

Deno.test("S6: at 02:00Z on 2026-09-04 (18:00 on 09-03 in UTC-8) future rows are dropped and the streak counts UTC today/yesterday only", async () => {
  await boot();
  const ip = nextIp();
  clock.frozenMs = RealDate.UTC(2026, 8, 4, 2, 0, 0); // 2026-09-04T02:00:00Z

  // Rows: UTC today, UTC yesterday, two future days, junk formats.
  const s1 = await streakFor(
    ["2026-09-04", "2026-09-03", "2026-09-05", "2026-09-06", "2027-01-01", "2026-9-4", "yesterday", "2026-09-04T00:00:00Z", null, 20260904],
    ip,
  );
  assertEquals(s1, { currentDays: 2, longestDays: 2, practicedToday: true, lastPracticeDate: "2026-09-04" });

  // Only a row for UTC "today" (09-04). The device in UTC-8 is still on 09-03,
  // so it would show this as practiced TOMORROW; the server says today.
  const s2 = await streakFor(["2026-09-04"], ip);
  assertEquals(s2, { currentDays: 1, longestDays: 1, practicedToday: true, lastPracticeDate: "2026-09-04" });

  // Only a row for 09-03: UTC says "yesterday" (streak alive, not practiced
  // today); the UTC-8 device is still ON 09-03 (practiced today locally).
  const s3 = await streakFor(["2026-09-03"], ip);
  assertEquals(s3, { currentDays: 1, longestDays: 1, practicedToday: false, lastPracticeDate: "2026-09-03" });

  // Only 09-02: UTC → two days ago → streak dead (0). For the UTC-8 device
  // 09-02 is YESTERDAY, so a device-local streak would still be alive.
  const s4 = await streakFor(["2026-09-02"], ip);
  assertEquals(s4, { currentDays: 0, longestDays: 1, practicedToday: false, lastPracticeDate: "2026-09-02" });

  // Only future rows → treated as no practice at all.
  const s5 = await streakFor(["2026-09-05", "2030-12-31"], ip);
  assertEquals(s5, { currentDays: 0, longestDays: 0, practicedToday: false, lastPracticeDate: null });

  // Future rows never bridge a gap: 09-01, 09-02, (future 09-05) → latest 09-02 → dead.
  const s6 = await streakFor(["2026-09-01", "2026-09-02", "2026-09-05"], ip);
  assertEquals(s6, { currentDays: 0, longestDays: 2, practicedToday: false, lastPracticeDate: "2026-09-02" });
});

Deno.test("S6: the same rows flip practicedToday/currentDays across the UTC midnight boundary while a UTC-8 user's evening is unchanged", async () => {
  await boot();
  const ip = nextIp();
  // 23:30Z on 09-03 → UTC today = 09-03.
  clock.frozenMs = RealDate.UTC(2026, 8, 3, 23, 30, 0);
  const before = await streakFor(["2026-09-02"], ip);
  assertEquals(before, { currentDays: 1, longestDays: 1, practicedToday: false, lastPracticeDate: "2026-09-02" });
  // 00:30Z on 09-04 (still 16:30 on 09-03 in UTC-8): the streak DIES on the
  // server one hour later, although for the player it is mid-afternoon of the
  // day after their last practice.
  clock.frozenMs = RealDate.UTC(2026, 8, 4, 0, 30, 0);
  const after = await streakFor(["2026-09-02"], ip);
  assertEquals(after.currentDays, 0);
  assertEquals(after.practicedToday, false);
});

Deno.test("S6x: the 60 s progress cache serves the pre-midnight streak after UTC midnight", async () => {
  await boot();
  const ip = nextIp();
  const token = fakeGoogleIdToken(crypto.randomUUID());
  h.tables.practice_days = [{ day: "2026-09-02" }];
  h.tables.progress_daily = [];
  clock.frozenMs = RealDate.UTC(2026, 8, 3, 23, 59, 40);
  const a = await h.handler(userRequest("GET", "/v1/progress", { token, ip }));
  assertEquals(((await a.json()) as { streak: Streak }).streak.currentDays, 1);
  clock.frozenMs = RealDate.UTC(2026, 8, 4, 0, 0, 10); // 30 s later, new UTC day
  const b = await h.handler(userRequest("GET", "/v1/progress", { token, ip }));
  assertEquals(((await b.json()) as { streak: Streak }).streak.currentDays, 1, "cached copy (≤60 s) still says alive");
  assertEquals(seenRest("practice_days").length, 1);
  clock.frozenMs = RealDate.UTC(2026, 8, 4, 0, 1, 0); // cache expired
  const c = await h.handler(userRequest("GET", "/v1/progress", { token, ip }));
  assertEquals(((await c.json()) as { streak: Streak }).streak.currentDays, 0);
  assertEquals(seenRest("practice_days").length, 2);
});

// ═════════════════════════════════════════════════════════════════════════════
// S7 — GET /v1/rank fallback
// ═════════════════════════════════════════════════════════════════════════════

type RankBody = {
  rank: null | {
    rating: number;
    tier: string;
    techniqueCount: number;
    scoredShotCount: number | null;
    updatedAt: string | null;
    techniques: Array<Record<string, unknown>>;
  };
};

async function rankFor(
  techniques: unknown[],
  state: Record<string, unknown> | null,
  ip: string,
): Promise<{ status: number; body: RankBody; raw: string }> {
  const token = fakeGoogleIdToken(crypto.randomUUID());
  h.tables.player_technique_rating = techniques;
  h.tables.player_rank_state = state ? [state] : [];
  const res = await h.handler(userRequest("GET", "/v1/rank", { token, ip }));
  const raw = await res.text();
  return { status: res.status, body: JSON.parse(raw) as RankBody, raw };
}

const tech = (overrides: Record<string, unknown>) => ({
  shot_type: "dink",
  score: 6.5,
  captured_at: "2026-09-01T00:00:00Z",
  sampled_count: 1,
  confidence_weight: 0,
  ...overrides,
});

Deno.test("S7: saved rating 'NaN' + technique confidence_weight 0 → finite fallback rating, never NaN/Infinity", async () => {
  await boot();
  const ip = nextIp();
  const r = await rankFor([tech({ confidence_weight: 0 })], {
    rating: "NaN",
    tier: "gold",
    technique_count: 1,
    scored_shot_count: 3,
    updated_at: "2026-09-01T00:00:00Z",
  }, ip);
  assertEquals(r.status, 200);
  assert(!r.raw.includes("NaN") && !r.raw.includes("Infinity"));
  assert(r.body.rank !== null);
  assertEquals(r.body.rank!.rating, 6.5);
  assertEquals(Number.isFinite(r.body.rank!.rating), true);
  assertEquals(r.body.rank!.tier, "platinum");
  assertEquals(r.body.rank!.scoredShotCount, null, "fallback path — saved counters are not trusted");
  assertEquals(r.body.rank!.updatedAt, null);
  assertEquals("confidence_weight" in r.body.rank!.techniques[0], false);
});

Deno.test("S7: every technique confidence_weight 0 (and sampled_count 0/null/'x') → weight 1 each, finite mean", async () => {
  await boot();
  const ip = nextIp();
  const r = await rankFor(
    [
      tech({ shot_type: "dink", score: 6, confidence_weight: 0, sampled_count: 0 }),
      tech({ shot_type: "drive", score: 8, confidence_weight: 0, sampled_count: null }),
      tech({ shot_type: "serve", score: 4, confidence_weight: "0", sampled_count: "x" }),
      tech({ shot_type: "volley", score: 5, confidence_weight: -3, sampled_count: -1 }),
    ],
    null,
    ip,
  );
  assertEquals(r.status, 200);
  assert(r.body.rank !== null);
  // (600+800+400+500)/4 = 575 → 5.75
  assertEquals(r.body.rank!.rating, 5.75);
  assertEquals(r.body.rank!.tier, "gold");
  assertEquals(r.body.rank!.techniqueCount, 4);
  assertEquals(r.body.rank!.techniques.map((t) => t.shot_type), ["drive", "dink", "volley", "serve"]);
  assert(!r.raw.includes("NaN"));
});

Deno.test("S7: technique rows with non-numeric string scores are dropped; none left → {rank:null} even with a saved state row", async () => {
  await boot();
  const ip = nextIp();
  const r = await rankFor(
    [tech({ score: "NaN" }), tech({ shot_type: "drive", score: "abc" }), tech({ shot_type: "serve", score: undefined })],
    { rating: 7.25, tier: "gold", technique_count: 3, scored_shot_count: 9, updated_at: "2026-09-01T00:00:00Z" },
    ip,
  );
  assertEquals(r.status, 200);
  assertEquals(r.body, { rank: null });
});

Deno.test("S7-BROKEN: a technique row with score null is NOT dropped — Number(null)===0 keeps it as a 0.00 technique", async () => {
  await boot();
  const ip = nextIp();
  // Unreachable through the current view (overall_score is not null filter),
  // but the endpoint's own guard (`Number.isFinite(Number(row.score))`) does
  // not reject null: the row survives as score 0 and drags the fallback mean.
  const r = await rankFor(
    [tech({ shot_type: "dink", score: 8, confidence_weight: 1 }), tech({ shot_type: "drive", score: null, confidence_weight: 1 })],
    null,
    ip,
  );
  assertEquals(r.status, 200);
  assert(r.body.rank !== null);
  assertEquals(r.body.rank!.techniqueCount, 2);
  assertEquals(r.body.rank!.techniques[1], { shot_type: "drive", score: 0, captured_at: "2026-09-01T00:00:00Z", sampled_count: 1 });
  assertEquals(r.body.rank!.rating, 4); // (800 + 0) / 2 → 4.00 instead of 8.00
  assertEquals(r.body.rank!.tier, "silver");
});

Deno.test("S7-BROKEN: saved rating null is coerced to 0 (Number(null)===0) → rank {rating:0, tier:'null'} instead of the fallback compute", async () => {
  await boot();
  const ip = nextIp();
  const r = await rankFor([tech({ confidence_weight: 0 })], {
    rating: null,
    tier: null,
    technique_count: null,
    scored_shot_count: null,
    updated_at: null,
  }, ip);
  assertEquals(r.status, 200);
  assert(r.body.rank !== null);
  // Observed at 4d812e1a. A correct fallback would return rating 6.5 / platinum.
  assertEquals(r.body.rank!.rating, 0);
  assertEquals(r.body.rank!.tier, "null");
  assertEquals(r.body.rank!.scoredShotCount, 0); // Number(null) again
  assertEquals(r.body.rank!.updatedAt, "null"); // String(null)
});

Deno.test("S7x: saved rating as a numeric string, Infinity string, empty string, boolean", async () => {
  await boot();
  const ip = nextIp();
  const cases: Array<[unknown, number, string]> = [
    ["7.25", 7.25, "gold"], // finite → saved row is authoritative (tier read verbatim)
    ["Infinity", 6.5, "platinum"], // not finite → fallback
    ["", 0, "gold"], // Number("") === 0 → treated as an authoritative 0 rating
    [true, 1, "gold"], // Number(true) === 1
    [false, 0, "gold"],
  ];
  for (const [rating, expectedRating, expectedTier] of cases) {
    const r = await rankFor([tech({ confidence_weight: 2 })], {
      rating,
      tier: "gold",
      technique_count: 1,
      scored_shot_count: 2,
      updated_at: "2026-09-01T00:00:00Z",
    }, ip);
    assertEquals(r.status, 200, JSON.stringify(rating));
    assertEquals(r.body.rank!.rating, expectedRating, `rating for ${JSON.stringify(rating)}`);
    assertEquals(r.body.rank!.tier, expectedTier, `tier for ${JSON.stringify(rating)}`);
    assert(!r.raw.includes("NaN"));
  }
});

Deno.test("S7x: rank read errors → generic 503 without the PostgREST message; the {rank:null} answer is cached 60 s", async () => {
  await boot();
  const ip = nextIp();
  const token = fakeGoogleIdToken(crypto.randomUUID());
  interceptors.push((req) =>
    restPath(req) === "/rest/v1/player_technique_rating"
      ? jsonRes(500, { code: "XX000", message: "internal error in view player_technique_rating" })
      : null,
  );
  const res = await h.handler(userRequest("GET", "/v1/rank", { token, ip }));
  assertEquals(res.status, 503);
  const raw = await res.text();
  assertEquals(JSON.parse(raw), { error: { message: "Player rank is temporarily unavailable. Please try again." } });
  assert(!raw.includes("XX000") && !raw.includes("player_technique_rating"));

  await boot();
  const token2 = fakeGoogleIdToken(crypto.randomUUID());
  h.tables.player_technique_rating = [];
  const first = await h.handler(userRequest("GET", "/v1/rank", { token: token2, ip }));
  assertEquals(await first.json(), { rank: null });
  h.tables.player_technique_rating = [tech({ confidence_weight: 1 })];
  const second = await h.handler(userRequest("GET", "/v1/rank", { token: token2, ip }));
  assertEquals(await second.json(), { rank: null }, "cached for 60 s");
  assertEquals(seenRest("player_technique_rating").length, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// Extra probes on the domain routes
// ═════════════════════════════════════════════════════════════════════════════

Deno.test("X1: onboarding — unicode/zero-width/bidi first names are sanitized; oversize and wrong types rejected", async () => {
  await boot();
  const ip = nextIp();
  const token = fakeGoogleIdToken(crypto.randomUUID());
  let patch: Record<string, unknown> | null = null;
  interceptors.push(async (req) => {
    if (restPath(req) !== "/rest/v1/profiles" || req.method !== "PATCH") return null;
    patch = (await req.json()) as Record<string, unknown>;
    return jsonRes(200, {
      skill_level: patch.skill_level,
      handedness: patch.handedness,
      primary_goal: patch.primary_goal,
      biggest_problem: patch.biggest_problem,
      focus_checkpoint: patch.focus_checkpoint,
      first_name: patch.first_name ?? null,
      gender: patch.gender ?? null,
    });
  });
  const base = { skillLevel: "beginner", handedness: "right", goal: "consistency", biggestProblem: "pop-ups" };
  const res = await h.handler(
    userRequest("PUT", "/v1/me/onboarding", {
      token,
      ip,
      body: { ...base, firstName: "  Zo\u200Bë\u202E\u0000 ", gender: "nonbinary" },
    }),
  );
  assertEquals(res.status, 200);
  assert(patch !== null);
  const firstName = String(patch!.first_name);
  assert(!firstName.includes("\u200B") && !firstName.includes("\u202E") && !firstName.includes("\u0000"));
  assertEquals(firstName.trim(), firstName);
  assertStringIncludes(firstName, "Zo");
  assertEquals(patch!.onboarding_state, "complete");

  for (const body of [
    { ...base, firstName: "x".repeat(41) },
    { ...base, firstName: 42 },
    { ...base, firstName: "\u200B\u200B" },
    { ...base, gender: "Male" },
    { ...base, handedness: "both" },
    { ...base, goal: "g".repeat(65) },
    { ...base, biggestProblem: "p".repeat(257) },
  ]) {
    const bad = await h.handler(userRequest("PUT", "/v1/me/onboarding", { token, ip, body }));
    assertEquals(bad.status, 400, JSON.stringify(body).slice(0, 60));
  }
});

Deno.test("X2: parameterized routes reject non-UUID ids and a foreign shot id before any consent/feedback write", async () => {
  await boot();
  const ip = nextIp();
  const token = fakeGoogleIdToken(crypto.randomUUID());
  h.tables.shots = [];
  for (const id of ["not-a-uuid", "%00", encodeURIComponent("../../v1/me"), "1".repeat(300)]) {
    const res = await h.handler(
      userRequest("POST", `/v1/analyses/${id}/feedback`, { token, ip, body: { rating: "accurate" } }),
    );
    assertEquals(res.status, 400, id);
    await res.text();
  }
  const foreign = await h.handler(
    userRequest("POST", `/v1/analyses/${crypto.randomUUID()}/feedback`, { token, ip, body: { rating: "accurate" } }),
  );
  assertEquals(foreign.status, 404);
  assertEquals(((await foreign.json()) as { error: { code: string } }).error.code, "analysis.not_found");
  assertEquals(seenRest("analysis_feedback").length, 0);
  assertEquals(seenRest("consent_records").length, 0, "ledger is not even read for a foreign shot");
});

Deno.test("X3: delete-confirm from a bearer whose cached entry belongs to the SAME user but different token still evicts only its own key", async () => {
  await boot();
  const ip = nextIp();
  const userId = crypto.randomUUID();
  const tokenA = fakeGoogleIdToken(userId);
  // Same sub, different exp → different token hash → separate cache entry.
  clock.offsetMs = 1000;
  const tokenA2 = fakeGoogleIdToken(userId);
  clock.offsetMs = 0;
  assertNotEquals(tokenA, tokenA2);
  h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
  for (const t of [tokenA, tokenA2]) {
    assertEquals((await h.handler(userRequest("GET", "/v1/me/access", { token: t, ip }))).status, 200);
  }
  const tokenExchanges = () => seen.filter((s) => s.url.startsWith(`${SUPABASE_URL}/auth/v1/token`)).length;
  assertEquals(tokenExchanges(), 2);
  const challenge = crypto.randomUUID();
  h.tables.account_deletion_requests = [{ challenge, created_at: pastIso(10_000), expires_at: futureIso(60_000) }];
  const del = await h.handler(userRequest("POST", "/v1/me/delete-confirm", { token: tokenA, ip, body: { challenge } }));
  assertEquals(del.status, 200);
  assertEquals(tokenExchanges(), 2, "deleting bearer served from cache for the delete itself");
  // tokenA2 (same user, other device) is still cached → no exchange.
  assertEquals((await h.handler(userRequest("GET", "/v1/me/access", { token: tokenA2, ip }))).status, 200);
  assertEquals(tokenExchanges(), 2);
  // tokenA was evicted → re-exchanged.
  await h.handler(userRequest("GET", "/v1/me/access", { token: tokenA, ip }));
  assertEquals(tokenExchanges(), 3);
});
