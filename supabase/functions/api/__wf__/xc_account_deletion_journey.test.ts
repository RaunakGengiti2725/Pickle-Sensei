// xc-journey-settings-account-deletion — server half of the deletion journey.
//
// Black-box tests of the REAL edge handlers (index.ts imported with Deno.serve
// captured) against a stateful fake Supabase (GoTrue + PostgREST) that, unlike
// the sibling account_routes fake, keeps deletion challenges PER USER, records
// every account_deletion_feedback insert, applies account_external_credentials
// checkpoints, and lets RevenueCat / GoTrue fail on demand. Nothing here talks
// to a real project.
//
// Run:
//   cd supabase/functions/api/__wf__ && deno task test
// or just this file:
//   deno test -A --no-check --config supabase/functions/api/__wf__/deno.json \
//     supabase/functions/api/__wf__/xc_account_deletion_journey.test.ts
//
// Cases marked OBSERVED pin behaviour that is reported as a finding; the
// assertion is what the function does today.

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";

// ─── Fake Supabase ──────────────────────────────────────────────────────────

interface DeletionRow {
  user_id: string;
  challenge: string;
  created_at: string;
  expires_at: string;
}

interface ExternalRow {
  user_id: string;
  apple_refresh_token_encrypted: string | null;
  apple_revoked_at: string | null;
  revenuecat_deleted_at: string | null;
}

interface FakeState {
  deletionRows: Map<string, DeletionRow>;
  /** Every POST body PostgREST received for account_deletion_feedback. */
  feedbackInserts: Array<Record<string, unknown>>;
  /** Status PostgREST answers the feedback insert with (201 = ok). */
  feedbackStatus: number;
  externalRows: Map<string, ExternalRow>;
  /** Queue of statuses for DELETE /auth/v1/admin/users/:id (default 200). */
  adminDeleteStatuses: number[];
  adminDeleteCalls: string[];
  /** Queue of statuses for RevenueCat DELETE (default 200). */
  revenueCatStatuses: number[];
  revenueCatDeleteCalls: string[];
  profileCreatedAt: string;
  accessState: { premium: boolean; scored_count: number; reserved_count: number };
  requestLog: Array<{ method: string; path: string; query: string; status: number }>;
  edgeLog: Array<{ method: string; path: string; status: number; code: string | null }>;
}

/** One row per test: edge-facing calls, upstream (fake Supabase/RevenueCat)
 * calls, and the end-of-test side effects. Written to XC_ARTIFACT_DIR at
 * teardown as edge.request_matrix.json (raw, replayable evidence). */
const matrix: Array<Record<string, unknown>> = [];
let currentTest = "";
function snapshotCurrent(): void {
  if (!currentTest) return;
  matrix.push({
    test: currentTest,
    edge: state.edgeLog,
    upstream: state.requestLog,
    adminDeleteCalls: state.adminDeleteCalls,
    revenueCatDeleteCalls: state.revenueCatDeleteCalls,
    feedbackInserts: state.feedbackInserts,
    deletionRowsRemaining: [...state.deletionRows.keys()],
  });
}

const state: FakeState = {
  deletionRows: new Map(),
  feedbackInserts: [],
  feedbackStatus: 201,
  externalRows: new Map(),
  adminDeleteStatuses: [],
  adminDeleteCalls: [],
  revenueCatStatuses: [],
  revenueCatDeleteCalls: [],
  profileCreatedAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  accessState: { premium: false, scored_count: 2, reserved_count: 0 },
  requestLog: [],
  edgeLog: [],
};

function resetState(name: string): void {
  snapshotCurrent();
  currentTest = name;
  state.deletionRows = new Map();
  state.feedbackInserts = [];
  state.feedbackStatus = 201;
  state.externalRows = new Map();
  state.adminDeleteStatuses = [];
  state.adminDeleteCalls = [];
  state.revenueCatStatuses = [];
  state.revenueCatDeleteCalls = [];
  state.profileCreatedAt = new Date(Date.now() - 40 * 86_400_000).toISOString();
  state.accessState = { premium: false, scored_count: 2, reserved_count: 0 };
  state.requestLog = [];
  state.edgeLog = [];
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const b64url = (input: string): string =>
  btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Unsigned JWT-shaped provider token; verification is delegated to the fake
 * GoTrue, which trusts `sub` as the user id. */
function providerToken(sub: string, issuer: "google" | "apple" = "google"): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: issuer === "google" ? "https://accounts.google.com" : "https://appleid.apple.com",
      sub,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    }),
  );
  return `${header}.${payload}.sig`;
}

/** `user_id=eq.<uuid>` from a PostgREST query string. */
function userFilter(url: URL): string | null {
  const raw = url.searchParams.get("user_id");
  return raw?.startsWith("eq.") ? raw.slice(3) : null;
}

async function fakeSupabase(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const respond = (response: Response): Response => {
    state.requestLog.push({
      method: request.method,
      path,
      query: url.search,
      status: response.status,
    });
    return response;
  };

  if (request.method === "POST" && path === "/auth/v1/token") {
    const body = (await request.json()) as { id_token: string };
    const payloadSegment = body.id_token.split(".")[1];
    const claims = JSON.parse(atob(payloadSegment.replace(/-/g, "+").replace(/_/g, "/"))) as {
      sub: string;
    };
    const userId = claims.sub;
    return respond(
      jsonResponse(200, {
        access_token: `sb-access-${userId}`,
        token_type: "bearer",
        expires_in: 3_600,
        expires_at: Math.floor(Date.now() / 1_000) + 3_600,
        refresh_token: `sb-refresh-${userId}`,
        user: { id: userId, aud: "authenticated", role: "authenticated", email: "u@example.com" },
      }),
    );
  }

  if (request.method === "DELETE" && path.startsWith("/auth/v1/admin/users/")) {
    const userId = path.slice("/auth/v1/admin/users/".length);
    state.adminDeleteCalls.push(userId);
    const status = state.adminDeleteStatuses.shift() ?? 200;
    if (status === 200) {
      // The cascade: every account-keyed row disappears with auth.users.
      state.deletionRows.delete(userId);
      state.externalRows.delete(userId);
      for (const row of state.feedbackInserts) {
        if (row.user_id === userId) row.user_id = null;
      }
      return respond(jsonResponse(200, {}));
    }
    if (status === 404) {
      return respond(
        jsonResponse(404, { code: 404, error_code: "user_not_found", msg: "User not found" }),
      );
    }
    return respond(jsonResponse(status, { code: status, msg: "gotrue unavailable" }));
  }

  if (path === "/rest/v1/account_deletion_requests") {
    if (request.method === "POST") {
      const body = (await request.json()) as DeletionRow;
      state.deletionRows.set(body.user_id, body);
      return respond(new Response(null, { status: 201 }));
    }
    if (request.method === "GET") {
      const userId = userFilter(url);
      const row = userId ? state.deletionRows.get(userId) : undefined;
      const rows = row ? [row] : [];
      if ((request.headers.get("accept") ?? "").includes("vnd.pgrst.object")) {
        return respond(
          rows.length === 0
            ? jsonResponse(406, { code: "PGRST116", message: "0 rows" })
            : jsonResponse(200, rows[0]),
        );
      }
      return respond(jsonResponse(200, rows));
    }
  }

  if (path === "/rest/v1/account_deletion_feedback" && request.method === "POST") {
    const body = (await request.json()) as Record<string, unknown>;
    if (state.feedbackStatus === 201) state.feedbackInserts.push(body);
    return respond(
      state.feedbackStatus === 201
        ? new Response(null, { status: 201 })
        : jsonResponse(state.feedbackStatus, { code: "XX000", message: "insert failed" }),
    );
  }

  if (path === "/rest/v1/account_external_credentials") {
    const userId = userFilter(url);
    if (request.method === "GET") {
      const row = userId ? state.externalRows.get(userId) : undefined;
      const rows = row ? [row] : [];
      if ((request.headers.get("accept") ?? "").includes("vnd.pgrst.object")) {
        return respond(
          rows.length === 0
            ? jsonResponse(406, { code: "PGRST116", message: "0 rows" })
            : jsonResponse(200, rows[0]),
        );
      }
      return respond(jsonResponse(200, rows));
    }
    if (request.method === "POST") {
      const body = (await request.json()) as Partial<ExternalRow> & { user_id: string };
      const existing = state.externalRows.get(body.user_id);
      state.externalRows.set(body.user_id, {
        user_id: body.user_id,
        apple_refresh_token_encrypted: existing?.apple_refresh_token_encrypted ?? null,
        apple_revoked_at: body.apple_revoked_at ?? existing?.apple_revoked_at ?? null,
        revenuecat_deleted_at:
          body.revenuecat_deleted_at ?? existing?.revenuecat_deleted_at ?? null,
      });
      return respond(new Response(null, { status: 201 }));
    }
    if (request.method === "PATCH") {
      const body = (await request.json()) as Partial<ExternalRow>;
      const existing = userId ? state.externalRows.get(userId) : undefined;
      if (existing && userId) {
        state.externalRows.set(userId, { ...existing, ...body, user_id: userId });
      }
      return respond(new Response(null, { status: 204 }));
    }
  }

  if (path === "/rest/v1/profiles" && request.method === "GET") {
    const rows = [{ created_at: state.profileCreatedAt }];
    if ((request.headers.get("accept") ?? "").includes("vnd.pgrst.object")) {
      return respond(jsonResponse(200, rows[0]));
    }
    return respond(jsonResponse(200, rows));
  }

  if (path === "/rest/v1/rpc/access_state" && request.method === "POST") {
    return respond(jsonResponse(200, [state.accessState]));
  }

  return respond(
    jsonResponse(404, { message: `fake supabase: unhandled ${request.method} ${path}` }),
  );
}

// ─── Boot the Edge Function in-process ───────────────────────────────────────

const fake = Deno.serve({ port: 0, onListen: () => undefined }, fakeSupabase);
const fakeUrl = `http://127.0.0.1:${fake.addr.port}`;

Deno.env.set("SUPABASE_URL", fakeUrl);
Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_revenuecat");
Deno.env.delete("UPSTASH_REDIS_REST_URL");
Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  if (request.url.startsWith("https://api.revenuecat.com/v1/subscribers/")) {
    assertEquals(request.method, "DELETE");
    state.revenueCatDeleteCalls.push(
      decodeURIComponent(request.url.slice("https://api.revenuecat.com/v1/subscribers/".length)),
    );
    const status = state.revenueCatStatuses.shift() ?? 200;
    return Promise.resolve(new Response(status === 200 ? null : "upstream", { status }));
  }
  return realFetch(input, init);
}) as typeof fetch;

type Handler = (request: Request) => Promise<Response> | Response;
let handler: Handler | null = null;
const realServe = Deno.serve;
(Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
  handler = (typeof args[0] === "function" ? args[0] : args[1]) as Handler;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};
await import("../index.ts");
(Deno as unknown as { serve: unknown }).serve = realServe;
if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
const api: Handler = handler;

let ipCounter = 0;
const call = async (
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<Response> => {
  const response = await api(
    new Request(`http://edge.local/functions/v1/api${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        // One IP per test so the per-IP budgets never couple the cases.
        "x-forwarded-for": `203.0.113.${(ipCounter % 200) + 10}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  let code: string | null = null;
  if (response.status >= 400) {
    try {
      code = ((await response.clone().json()) as ErrorBody).error?.code ?? null;
    } catch {
      code = null;
    }
  }
  state.edgeLog.push({ method, path, status: response.status, code });
  return response;
};

const nowIso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

interface ErrorBody {
  error: { code?: string; message: string };
}

/** Ages the user's pending challenge past the 3s minimum so confirm may run. */
function ageChallenge(userId: string, ms = 10_000): void {
  const row = state.deletionRows.get(userId);
  if (!row) throw new Error("no pending challenge to age");
  row.created_at = nowIso(-ms);
}

/** Deterministic, low-entropy user ids (replayable; and the production
 * `console.warn(... revocation token: ${authed.id})` line lands in
 * verify-cloud's edge.log, where a random UUID trips the gitleaks gate). */
let userCounter = 0;
function nextUserId(): string {
  userCounter += 1;
  return `0000e000-0000-4000-8000-${String(userCounter).padStart(12, "0")}`;
}

function newCase(issuer: "google" | "apple" = "google"): { userId: string; token: string } {
  ipCounter += 1;
  const userId = nextUserId();
  return { userId, token: providerToken(userId, issuer) };
}

// ─── Golden path ─────────────────────────────────────────────────────────────

Deno.test(
  "E1 full journey: survey → challenge → confirm deletes RevenueCat then GoTrue and de-identifies the survey",
  async () => {
    resetState("E1");
    const { userId, token } = newCase();
    const requested = await call("POST", "/v1/me/delete-request", token, {
      survey: {
        reason: "privacy",
        wanted: "nothing",
        details: "  Please   erase\u200b everything.  ",
        platform: "ios",
        appVersion: "1.0",
      },
    });
    assertEquals(requested.status, 200);
    const { challenge, expiresAt } = (await requested.json()) as {
      challenge: string;
      expiresAt: string;
    };
    const ttl = Date.parse(expiresAt) - Date.now();
    assert(ttl > 14 * 60_000 && ttl <= 15 * 60_000, `ttl ${ttl}`);

    // Survey stored under the live account id, context stamped server-side.
    assertEquals(state.feedbackInserts.length, 1);
    const feedback = state.feedbackInserts[0];
    assertEquals(feedback.user_id, userId);
    assertEquals(feedback.reason, "privacy");
    assertEquals(feedback.wanted, "nothing");
    assertEquals(feedback.details, "Please erase everything.");
    assertEquals(feedback.provider, "google");
    assertEquals(feedback.platform, "ios");
    assertEquals(feedback.app_version, "1.0");
    assertEquals(feedback.account_age_days, 40);
    assertEquals(feedback.was_premium, false);
    assertEquals(feedback.scored_count, 2);

    // Too fast: the row was minted <3s ago.
    const tooFast = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(tooFast.status, 429);
    assertEquals(((await tooFast.json()) as ErrorBody).error.code, "account.deletion_too_fast");
    assertEquals(state.adminDeleteCalls, []);
    assertEquals(state.revenueCatDeleteCalls, []);

    ageChallenge(userId);
    const confirmed = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(confirmed.status, 200);
    assertEquals(await confirmed.json(), {
      deleted: true,
      appleAuthorizationRevocation: "not_applicable",
    });
    // Order: RevenueCat erased + checkpointed BEFORE the identity is removed.
    assertEquals(state.revenueCatDeleteCalls, [userId]);
    assertEquals(state.adminDeleteCalls, [userId]);
    const order = state.requestLog
      .filter(
        (e) =>
          e.path === "/rest/v1/account_external_credentials" ||
          e.path.startsWith("/auth/v1/admin/users/"),
      )
      .map((e) => `${e.method} ${e.path.replace(userId, ":id")}`);
    assertEquals(order, [
      "GET /rest/v1/account_external_credentials",
      "POST /rest/v1/account_external_credentials",
      "DELETE /auth/v1/admin/users/:id",
    ]);
    // Cascade / SET NULL mirrored by the fake: the survey outlives the account
    // with no user id (legal.ts §7).
    assertEquals(state.deletionRows.has(userId), false);
    assertEquals(state.feedbackInserts[0].user_id, null);
  },
);

Deno.test(
  "E2 apple sign-in without a stored refresh token: deletion still completes and reports manual_action_required",
  async () => {
    resetState("E2");
    const { userId, token } = newCase("apple");
    const requested = await call("POST", "/v1/me/delete-request", token, {});
    assertEquals(requested.status, 200);
    const { challenge } = (await requested.json()) as { challenge: string };
    assertEquals(state.feedbackInserts, []);
    ageChallenge(userId);
    const confirmed = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(confirmed.status, 200);
    assertEquals(await confirmed.json(), {
      deleted: true,
      appleAuthorizationRevocation: "manual_action_required",
    });
    assertEquals(state.adminDeleteCalls, [userId]);
  },
);

// ─── Survey parsing at the boundary ──────────────────────────────────────────

Deno.test(
  "E3 survey details are capped at 500 code points without splitting emoji; control/bidi chars stripped",
  async () => {
    resetState("E3");
    const { token } = newCase();
    const emoji = "\u{1F3D3}"; // 🏓 — two UTF-16 units, one code point
    const details = `${"a".repeat(498)}${emoji}${emoji}${"z".repeat(300)}\u202e\u0007`;
    const res = await call("POST", "/v1/me/delete-request", token, {
      survey: { reason: "other", details, platform: "ios", appVersion: "x".repeat(200) },
    });
    assertEquals(res.status, 200);
    assertEquals(state.feedbackInserts.length, 1);
    const stored = String(state.feedbackInserts[0].details);
    assertEquals(Array.from(stored).length, 500);
    assertEquals(stored.endsWith(`${emoji}${emoji}`), true);
    assertEquals(stored.includes("\u202e"), false);
    assertEquals(stored.includes("\u0007"), false);
    assertEquals(String(state.feedbackInserts[0].app_version).length, 64);
    assertEquals(state.feedbackInserts[0].wanted, null);
  },
);

Deno.test(
  "E4 unknown reason / non-object survey: no feedback row, challenge still minted",
  async () => {
    resetState("E4");
    const { token } = newCase();
    const bad = await call("POST", "/v1/me/delete-request", token, {
      survey: { reason: "made_up", details: "ignored" },
    });
    assertEquals(bad.status, 200);
    const alsoBad = await call("POST", "/v1/me/delete-request", token, { survey: "privacy" });
    assertEquals(alsoBad.status, 200);
    assertEquals(state.feedbackInserts, []);
  },
);

Deno.test(
  "E5 survey insert failing (PostgREST 500) never blocks the deletion request",
  async () => {
    resetState("E5");
    const { userId, token } = newCase();
    state.feedbackStatus = 500;
    const res = await call("POST", "/v1/me/delete-request", token, {
      survey: { reason: "cost" },
    });
    assertEquals(res.status, 200);
    assertEquals(state.feedbackInserts, []);
    assertEquals(state.deletionRows.has(userId), true);
  },
);

Deno.test(
  "OBSERVED E6 re-sending delete-request with the survey (after 403 expired or a lost response) inserts a second feedback row",
  async () => {
    resetState("E6");
    const { userId, token } = newCase();
    const survey = { reason: "privacy", wanted: "nothing", details: "twice" };
    const first = await call("POST", "/v1/me/delete-request", token, { survey });
    assertEquals(first.status, 200);
    const { challenge: c1 } = (await first.json()) as { challenge: string };
    // Let the challenge expire on the server, exactly like leaving the sheet open.
    state.deletionRows.get(userId)!.expires_at = nowIso(-1);
    state.deletionRows.get(userId)!.created_at = nowIso(-16 * 60_000);
    const expired = await call("POST", "/v1/me/delete-confirm", token, { challenge: c1 });
    assertEquals(expired.status, 403);
    assertEquals(
      ((await expired.json()) as ErrorBody).error.code,
      "account.deletion_challenge_expired",
    );
    assertEquals(state.adminDeleteCalls, []);
    assertEquals(state.revenueCatDeleteCalls, []);

    const second = await call("POST", "/v1/me/delete-request", token, { survey });
    assertEquals(second.status, 200);
    const { challenge: c2 } = (await second.json()) as { challenge: string };
    assertNotEquals(c2, c1);
    // The old challenge is dead (upsert on user_id replaced it).
    const stale = await call("POST", "/v1/me/delete-confirm", token, { challenge: c1 });
    assertEquals(stale.status, 403);
    assertEquals(
      ((await stale.json()) as ErrorBody).error.code,
      "account.deletion_challenge_invalid",
    );
    // One person, two survey rows (account_deletion_feedback has no
    // uniqueness on user_id and the insert is unconditional).
    assertEquals(state.feedbackInserts.length, 2);
    assertEquals(
      state.feedbackInserts.map((r) => r.user_id),
      [userId, userId],
    );
  },
);

Deno.test(
  "OBSERVED E7 per-user budget: the 4th delete-request within an hour is refused with 429 even when the earlier ones failed to complete",
  async () => {
    resetState("E7");
    const { token } = newCase();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await call("POST", "/v1/me/delete-request", token, {});
      statuses.push(res.status);
      if (res.status === 429) {
        const body = (await res.json()) as ErrorBody;
        assertEquals(body.error.code, "rate_limited");
        assertEquals(
          body.error.message,
          "Too many requests. Please slow down and try again shortly.",
        );
        assert(Number(res.headers.get("Retry-After")) > 60, "Retry-After is the 1h window");
      } else {
        await res.body?.cancel();
      }
    }
    assertEquals(statuses, [200, 200, 200, 429]);
  },
);

// ─── Challenge ownership / lifecycle ─────────────────────────────────────────

Deno.test(
  "E8 a challenge minted for user A cannot confirm user B (RLS-scoped lookup → 403 invalid, no admin call)",
  async () => {
    resetState("E8");
    const a = newCase();
    const b = newCase();
    const requested = await call("POST", "/v1/me/delete-request", a.token, {});
    const { challenge } = (await requested.json()) as { challenge: string };
    ageChallenge(a.userId);
    const crossed = await call("POST", "/v1/me/delete-confirm", b.token, { challenge });
    assertEquals(crossed.status, 403);
    assertEquals(
      ((await crossed.json()) as ErrorBody).error.code,
      "account.deletion_challenge_invalid",
    );
    assertEquals(state.adminDeleteCalls, []);
    assertEquals(state.deletionRows.has(a.userId), true);
    // The lookup was filtered by the caller's id, not by the challenge value.
    const lookups = state.requestLog.filter(
      (e) => e.method === "GET" && e.path === "/rest/v1/account_deletion_requests",
    );
    assert(lookups.some((e) => e.query.includes(`user_id=eq.${b.userId}`)));
  },
);

Deno.test(
  "E9 confirm without a prior request → 403 invalid; without a bearer → 401; nothing external is touched",
  async () => {
    resetState("E9");
    const { token } = newCase();
    const orphan = await call("POST", "/v1/me/delete-confirm", token, {
      challenge: crypto.randomUUID(),
    });
    assertEquals(orphan.status, 403);
    assertEquals(
      ((await orphan.json()) as ErrorBody).error.code,
      "account.deletion_challenge_invalid",
    );
    const anonymous = await call("POST", "/v1/me/delete-confirm", null, {
      challenge: crypto.randomUUID(),
    });
    assertEquals(anonymous.status, 401);
    await anonymous.body?.cancel();
    assertEquals(state.adminDeleteCalls, []);
    assertEquals(state.revenueCatDeleteCalls, []);
  },
);

// ─── Provider / auth outages: nothing half-deleted, retry completes ──────────

Deno.test(
  "E10 RevenueCat 500 → generic 503, GoTrue never called, account intact; retry after recovery deletes once",
  async () => {
    resetState("E10");
    const { userId, token } = newCase();
    const requested = await call("POST", "/v1/me/delete-request", token, {});
    const { challenge } = (await requested.json()) as { challenge: string };
    ageChallenge(userId);

    state.revenueCatStatuses = [500];
    const failed = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(failed.status, 503);
    const body = (await failed.json()) as ErrorBody;
    assertEquals(
      body.error.message,
      "Account deletion is temporarily unavailable. Please try again.",
    );
    assertEquals(JSON.stringify(body).includes("500"), false); // no upstream detail leaks
    assertEquals(state.adminDeleteCalls, []);
    assertEquals(state.externalRows.has(userId), false); // no checkpoint on failure
    assertEquals(state.deletionRows.has(userId), true); // same challenge stays valid

    const retried = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(retried.status, 200);
    assertEquals(((await retried.json()) as { deleted: boolean }).deleted, true);
    assertEquals(state.revenueCatDeleteCalls, [userId, userId]);
    assertEquals(state.adminDeleteCalls, [userId]);
  },
);

Deno.test(
  "E11 GoTrue deleteUser 500 → 503 without `deleted`; the RevenueCat checkpoint makes the retry skip RevenueCat and finish",
  async () => {
    resetState("E11");
    const { userId, token } = newCase();
    const requested = await call("POST", "/v1/me/delete-request", token, {});
    const { challenge } = (await requested.json()) as { challenge: string };
    ageChallenge(userId);

    state.adminDeleteStatuses = [500];
    const failed = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(failed.status, 503);
    const body = (await failed.json()) as Record<string, unknown>;
    assertEquals("deleted" in body, false);
    assertEquals(state.revenueCatDeleteCalls, [userId]);
    assertEquals(state.externalRows.get(userId)?.revenuecat_deleted_at != null, true);
    assertEquals(state.adminDeleteCalls, [userId]);
    assertEquals(state.deletionRows.has(userId), true);

    const retried = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(retried.status, 200);
    assertEquals(((await retried.json()) as { deleted: boolean }).deleted, true);
    assertEquals(state.revenueCatDeleteCalls, [userId]); // checkpoint honoured
    assertEquals(state.adminDeleteCalls, [userId, userId]);
    assertEquals(state.deletionRows.has(userId), false);
  },
);

Deno.test(
  "E12 lost confirm response: the server-side deletion is complete, so the retry with the same bearer is refused as an unknown challenge",
  async () => {
    resetState("E12");
    const { userId, token } = newCase();
    const requested = await call("POST", "/v1/me/delete-request", token, {});
    const { challenge } = (await requested.json()) as { challenge: string };
    ageChallenge(userId);
    const first = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(first.status, 200);
    await first.body?.cancel();
    // The response never reached the phone. In this fake GoTrue still mints a
    // session for the bearer (the real one answers 401 → the app's
    // "sign-in expired" copy, pinned in the mobile harness S9/U6); either way
    // the retry can never report `deleted: true` a second time.
    const retry = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(retry.status, 403);
    assertEquals(
      ((await retry.json()) as ErrorBody).error.code,
      "account.deletion_challenge_invalid",
    );
    assertEquals(state.adminDeleteCalls, [userId]);
  },
);

Deno.test({
  name: "teardown fake supabase",
  fn: async () => {
    snapshotCurrent();
    const dir =
      Deno.env.get("XC_ARTIFACT_DIR") ??
      `${Deno.env.get("HOME") ?? "."}/.cache/pickle-sensei/xc-artifacts/account-deletion`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/edge.request_matrix.json`,
      JSON.stringify({ generatedAt: new Date().toISOString(), tests: matrix }, null, 2),
    );
    await fake.shutdown();
    globalThis.fetch = realFetch;
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
