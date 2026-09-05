/**
 * stress — FUZZ/BOUNDARY campaign for `PUT /v1/me/saved-drills/:slug`.
 *
 * Drives the REAL handler (../index.ts, `Deno.serve` captured by
 * routesHarness.ts) in-process with Supabase Auth / PostgREST / RevenueCat
 * stubbed and Upstash unset. On top of routesHarness' canned stubs this file
 * installs a STATEFUL model of the `user_saved_drills` table (RLS by bearer,
 * the `user_saved_drills_slug_bounds` check constraint, `ON CONFLICT DO
 * NOTHING` upserts, eq-filtered selects/deletes) so "no write on rejection"
 * and "one row after N identical PUTs" are checked against real state, not
 * call counts alone. A small share of iterations injects UPSTREAM faults
 * (PostgREST 500 / garbage / thrown fetch, Auth 500 / garbage) to prove 5xx
 * bodies stay generic.
 *
 * Every iteration is generated from a per-iteration seed derived from the
 * campaign seed, so any single case replays exactly:
 *
 *   STRESS_ITER=3000 STRESS_SEED=20260905 \
 *     STRESS_OUT_DIR=/tmp/stress deno test -A --no-check --config deno.json \
 *     stress_saved_drills_put_fuzz.test.ts
 *   STRESS_REPLAY=<iterSeed>[,<iterSeed>...] STRESS_REPEAT=10 deno test ... (replay / flake check)
 *
 * Invariants asserted per request (a violation fails the test and is written
 * with its seed + full generated request to <out>/violations.json):
 *   I1 status ∈ {200, 204} ∪ {400, 401, 403, 404, 405, 413, 415, 429}; 5xx only
 *      when this iteration injected an upstream fault (and then 503/500 only)
 *   I2 every 5xx body is exactly the generic shape — no detail, code, stack,
 *      table/host/token/slug echo
 *   I3 no body (any status) leaks a stack frame, source path, error class
 *      name, PostgREST code, table name, upstream host or the bearer
 *   I4 every rejected request (status ≥ 400) performed NO PostgREST write
 *      (no POST/PATCH/DELETE upstream call) and left the table model unchanged
 *   I5 every response carries a well-formed `x-request-id`; a well-formed
 *      client id is echoed, a malformed one is NEVER echoed
 *   I6 JSON responses carry the security headers (nosniff, no-store)
 *   I7 429 carries Retry-After and never reached PostgREST
 *   I8 the oracle's expected status set (from the handler's documented
 *      order: 413 → 429(ip) → 401 → 429(user) → 404 → 400 → 200) contains the
 *      observed status; a 200 PUT wrote exactly one row for the AUTHENTICATED
 *      user with the DECODED slug and echoed slug/saved/savedAt from the row
 *   I9 the handler promise resolves (never rejects) within 10 s
 *
 * Default STRESS_ITER is small so the file lives in `deno task test`; the
 * campaign is run explicitly at ≥ 3000.
 */
import { assert, assertEquals } from "@std/assert";
import { type Harness, loadHarness, SUPABASE_URL } from "./routesHarness.ts";
import {
  DIGITS,
  DRILL_SLUG_RE,
  genSlug,
  iterSeedOf,
  LATIN1_PRINTABLE,
  LOWER,
  Prng,
  type SlugGen,
  type SlugKind,
  UPPER,
  validSlug,
} from "./stress_saved_drills_gen.ts";

// ── Config ───────────────────────────────────────────────────────────────────

const envInt = (name: string, fallback: number): number => {
  const raw = Deno.env.get(name);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

const STRESS_SEED = envInt("STRESS_SEED", 20260905);
const STRESS_ITER = envInt("STRESS_ITER", 120);
const STRESS_REPEAT = envInt("STRESS_REPEAT", 1);
const STRESS_REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s) >>> 0);
const OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ??
  new URL(
    "../../../../artifacts/stress/saved-drills-put-fuzz/latest/",
    import.meta.url,
  ).pathname;
const TEST_FILE = "stress_saved_drills_put_fuzz.test.ts";

const ROUTE_RE = /^\/v1\/me\/saved-drills\/([^/]+)$/;
/** Mirrors http.ts REQUEST_ID_RE (oracle only). */
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const MAX_JSON_BODY_BYTES = 5_000_000;
const GENERAL_USER_LIMIT = 240;
const AUTH_FAILURE_LIMIT = 30;

// ── Tokens ───────────────────────────────────────────────────────────────────

const b64url = (value: string): string =>
  btoa(unescape(encodeURIComponent(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const JWT_HEADER = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));

function jwt(payload: Record<string, unknown>, signature = "sig"): string {
  return `${JWT_HEADER}.${b64url(JSON.stringify(payload))}.${signature}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** Session access token as the model's Auth issues it (iss ends /auth/v1). */
function sessionToken(
  sub: string,
  flags: Record<string, unknown> = {},
): string {
  return jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    aud: "authenticated",
    role: "authenticated",
    session_id: `sess-${sub}`,
    exp: nowSec() + 3600,
    ...flags,
  });
}

// ── Stateful upstream model layered over routesHarness' stubs ────────────────

type Fault =
  | "none"
  | "pgrst_500_text"
  | "pgrst_503_json_detail"
  | "pgrst_fetch_throw"
  | "pgrst_200_garbage"
  | "pgrst_select_empty"
  | "pgrst_409_conflict"
  | "auth_500"
  | "auth_200_garbage"
  | "auth_fetch_throw";

interface SavedRow {
  user_id: string;
  slug: string;
  saved_at: string;
}

interface UpstreamCall {
  method: string;
  url: string;
  isWrite: boolean;
  status: number | "throw";
}

class Model {
  rows = new Map<string, SavedRow>();
  fault: Fault = "none";
  calls: UpstreamCall[] = [];
  /** users whose session bearer Auth reports revoked */
  revokedSubs = new Set<string>();
  /** users whose Auth record has no google/apple provider */
  providerlessSubs = new Set<string>();
  clock = 1_700_000_000_000;

  key(userId: string, slug: string) {
    return `${userId}\u0000${slug}`;
  }
  snapshot(): string {
    return [...this.rows.keys()].sort().join("\n");
  }
  reset() {
    this.rows.clear();
    this.fault = "none";
    this.calls = [];
    this.revokedSubs.clear();
    this.providerlessSubs.clear();
  }
}

const PGRST_SLUG_BOUNDS = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

function pgrstError(
  status: number,
  code: string,
  message: string,
  details: unknown = null,
) {
  return new Response(JSON.stringify({ code, message, details, hint: null }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** The authenticated sub behind a PostgREST bearer: routesHarness mints
 * `session-for-<sub>` for provider ID tokens; our session tokens are JWTs. */
function subOfBearer(auth: string | null): string | null {
  const token = (auth ?? "").replace(/^Bearer\s+/, "");
  if (token.startsWith("session-for-")) {
    return token.slice("session-for-".length);
  }
  const seg = token.split(".")[1];
  if (!seg) return null;
  try {
    const raw = seg.replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)));
    return typeof p.sub === "string" ? p.sub : null;
  } catch {
    return null;
  }
}

function eqFilter(url: URL, column: string): string | null {
  const raw = url.searchParams.get(column);
  return raw && raw.startsWith("eq.") ? raw.slice(3) : null;
}

function installModel(h: Harness, model: Model): void {
  const base = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const isRest = request.url.startsWith(`${SUPABASE_URL}/rest/v1/`);
    const isWrite = isRest && request.method !== "GET" &&
      request.method !== "HEAD";
    const record = (status: number | "throw") =>
      model.calls.push({
        method: request.method,
        url: request.url,
        isWrite,
        status,
      });

    // Auth: GET /auth/v1/user for session bearers (routesHarness only stubs
    // the id-token exchange).
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      if (model.fault === "auth_fetch_throw") {
        record("throw");
        throw new TypeError(
          "error sending request for url (auth): connection reset",
        );
      }
      if (model.fault === "auth_500") {
        record(500);
        return new Response("upstream auth exploded\n    at gotrue.go:1", {
          status: 500,
        });
      }
      if (model.fault === "auth_200_garbage") {
        record(200);
        return new Response("<html>not json</html>", { status: 200 });
      }
      const sub = subOfBearer(request.headers.get("Authorization"));
      if (!sub || model.revokedSubs.has(sub)) {
        record(401);
        return new Response(
          JSON.stringify({ code: 401, msg: "invalid JWT" }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      record(200);
      return new Response(
        JSON.stringify({
          id: sub,
          aud: "authenticated",
          role: "authenticated",
          email: `${sub}@example.com`,
          app_metadata: model.providerlessSubs.has(sub)
            ? {}
            : { provider: "google" },
          user_metadata: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      if (model.fault === "auth_fetch_throw") {
        record("throw");
        throw new TypeError(
          "error sending request for url (auth): connection reset",
        );
      }
      if (model.fault === "auth_500") {
        record(500);
        return new Response("upstream auth exploded\n    at gotrue.go:1", {
          status: 500,
        });
      }
      if (model.fault === "auth_200_garbage") {
        record(200);
        return new Response("<html>not json</html>", { status: 200 });
      }
      return base(input, init);
    }

    if (isRest && url.pathname === "/rest/v1/user_saved_drills") {
      const bodyText = await request.clone().text().catch(() => "");
      const sub = subOfBearer(request.headers.get("Authorization"));
      switch (model.fault) {
        case "pgrst_fetch_throw":
          record("throw");
          throw new TypeError(
            "error sending request for url (pgrst): connection refused",
          );
        case "pgrst_500_text":
          record(500);
          return new Response(
            'FATAL: relation "user_saved_drills" exploded\n    at PostgREST/App.hs:42',
            { status: 500, headers: { "Content-Type": "text/plain" } },
          );
        case "pgrst_503_json_detail":
          record(503);
          return pgrstError(
            503,
            "PGRST001",
            "could not connect to server: Connection refused (postgres://db.internal:5432)",
            "SECRET_DETAIL_MARKER",
          );
        case "pgrst_200_garbage":
          record(200);
          return new Response("}{not-json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        case "pgrst_409_conflict":
          if (request.method === "POST") {
            record(409);
            return pgrstError(
              409,
              "23505",
              'duplicate key value violates unique constraint "user_saved_drills_pkey"',
              "Key (user_id, slug)=(SECRET_DETAIL_MARKER) already exists.",
            );
          }
          break;
        default:
          break;
      }
      if (!sub) {
        record(401);
        return pgrstError(401, "PGRST301", "JWT invalid");
      }
      if (request.method === "POST") {
        let rows: unknown;
        try {
          rows = JSON.parse(bodyText);
        } catch {
          record(400);
          return pgrstError(
            400,
            "PGRST102",
            "Empty or invalid json request body",
          );
        }
        const list = Array.isArray(rows) ? rows : [rows];
        const prefer = request.headers.get("Prefer") ?? "";
        const ignoreDuplicates = prefer.includes(
          "resolution=ignore-duplicates",
        );
        for (const r of list) {
          const row = r as Record<string, unknown>;
          if (row.user_id !== sub) {
            record(403);
            return pgrstError(
              403,
              "42501",
              'new row violates row-level security policy for table "user_saved_drills"',
            );
          }
          if (
            typeof row.slug !== "string" || !PGRST_SLUG_BOUNDS.test(row.slug)
          ) {
            record(400);
            return pgrstError(
              400,
              "23514",
              'new row for relation "user_saved_drills" violates check constraint "user_saved_drills_slug_bounds"',
            );
          }
          const key = model.key(sub, row.slug);
          if (model.rows.has(key)) {
            if (!ignoreDuplicates) {
              record(409);
              return pgrstError(
                409,
                "23505",
                'duplicate key value violates unique constraint "user_saved_drills_pkey"',
              );
            }
            continue;
          }
          model.clock += 1;
          model.rows.set(key, {
            user_id: sub,
            slug: row.slug,
            saved_at: new Date(model.clock).toISOString(),
          });
        }
        record(201);
        return new Response(null, { status: 201 });
      }
      const userFilter = eqFilter(url, "user_id");
      const slugFilter = eqFilter(url, "slug");
      const visible = [...model.rows.values()].filter(
        (r) =>
          r.user_id === sub &&
          (userFilter === null || r.user_id === userFilter) &&
          (slugFilter === null || r.slug === slugFilter),
      );
      if (request.method === "GET") {
        if (model.fault === "pgrst_select_empty") {
          record(200);
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        const accept = request.headers.get("Accept") ?? "";
        record(200);
        if (accept.includes("application/vnd.pgrst.object+json")) {
          if (visible.length !== 1) {
            return pgrstError(406, "PGRST116", `${visible.length} rows`);
          }
          return new Response(JSON.stringify(visible[0]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(visible), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (request.method === "DELETE") {
        for (const r of visible) {
          model.rows.delete(model.key(r.user_id, r.slug));
        }
        record(204);
        return new Response(null, { status: 204 });
      }
      record(405);
      return pgrstError(405, "PGRST", "method not modelled");
    }
    if (isRest) record(0);
    return base(input, init);
  }) as typeof fetch;
  // Keep routesHarness' bookkeeping reachable for tests that inspect it.
  void h;
}

// ── Generators ───────────────────────────────────────────────────────────────

type PathShape =
  | "canonical"
  | "gateway_stripped"
  | "bare_v1"
  | "trailing_slash"
  | "extra_segment"
  | "uppercase_v1"
  | "double_slash"
  | "interior_v1"
  | "wrong_resource"
  | "no_slug_segment"
  | "backslash";

interface PathGen {
  shape: PathShape;
  url: string;
  hasQuery: boolean;
}

function genQuery(rng: Prng): string {
  if (!rng.chance(0.45)) return "";
  const n = rng.int(1, 4);
  const parts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const k = rng.pick([
      "slug",
      "user_id",
      "select",
      "apikey",
      "Authorization",
      "x",
      "%00",
      "a[b]",
      "__proto__",
      "",
    ]);
    const v = rng.pick([
      "1",
      "eq.evil",
      "*",
      encodeURIComponent(validSlug(rng, 8)),
      "%",
      "%zz",
      rng.string(LATIN1_PRINTABLE.replace(/[#&=?]/g, ""), rng.int(0, 40))
        .replace(/%/g, "%25"),
      "x".repeat(rng.pick([0, 100, 4096])),
    ]);
    parts.push(v === "" ? k : `${k}=${v}`);
  }
  return `?${parts.join("&")}`;
}

function genPath(rng: Prng, slug: SlugGen): PathGen {
  const shape = rng.weighted<PathShape>([
    [46, "canonical"],
    [10, "gateway_stripped"],
    [8, "bare_v1"],
    [5, "trailing_slash"],
    [5, "extra_segment"],
    [4, "uppercase_v1"],
    [4, "double_slash"],
    [5, "interior_v1"],
    [5, "wrong_resource"],
    [4, "no_slug_segment"],
    [4, "backslash"],
  ]);
  const seg = slug.raw;
  let path: string;
  switch (shape) {
    case "canonical":
      path = `/functions/v1/api/v1/me/saved-drills/${seg}`;
      break;
    case "gateway_stripped":
      path = `/api/v1/me/saved-drills/${seg}`;
      break;
    case "bare_v1":
      path = `/v1/me/saved-drills/${seg}`;
      break;
    case "trailing_slash":
      path = `/functions/v1/api/v1/me/saved-drills/${seg}/`;
      break;
    case "extra_segment":
      path = `/functions/v1/api/v1/me/saved-drills/${seg}/${
        rng.pick(["x", "finalize", "..", "%2e%2e"])
      }`;
      break;
    case "uppercase_v1":
      path = `/functions/v1/api/V1/me/saved-drills/${seg}`;
      break;
    case "double_slash":
      path = rng.pick([
        `/functions/v1/api/v1/me//saved-drills/${seg}`,
        `/functions/v1/api/v1//me/saved-drills/${seg}`,
        `/functions/v1/api/v1/me/saved-drills//${seg}`,
        `//v1/me/saved-drills/${seg}`,
      ]);
      break;
    case "interior_v1":
      path = `/functions/v1/api/v1/me/saved-drills/${seg}/v1/me/saved-drills/${
        validSlug(rng, 4)
      }`;
      break;
    case "wrong_resource":
      path = rng.pick([
        `/functions/v1/api/v1/me/saved-drill/${seg}`,
        `/functions/v1/api/v1/me/saved_drills/${seg}`,
        `/functions/v1/api/v1/me/Saved-Drills/${seg}`,
        `/functions/v1/api/v1/saved-drills/${seg}`,
        `/functions/v1/api/v1/me/saved-drills%2F${seg}`,
        `/functions/v1/api/v2/me/saved-drills/${seg}`,
      ]);
      break;
    case "no_slug_segment":
      path = rng.pick([
        `/functions/v1/api/v1/me/saved-drills`,
        `/functions/v1/api/v1/me/saved-drills/`,
        `/functions/v1/api/v1/me/saved-drills?slug=${seg}`,
      ]);
      break;
    case "backslash":
      path = `/functions/v1/api/v1/me/saved-drills\\${seg}`;
      break;
  }
  const query = genQuery(rng);
  return {
    shape,
    url: `http://edge.test${path}${query}`,
    hasQuery: query !== "",
  };
}

type AuthKind =
  | "google_ok"
  | "apple_ok"
  | "session_ok"
  | "session_revoked"
  | "session_providerless"
  | "missing"
  | "empty_bearer"
  | "lowercase_scheme"
  | "basic"
  | "not_jwt"
  | "two_segments"
  | "four_segments"
  | "bad_base64_payload"
  | "payload_not_object"
  | "payload_array"
  | "unknown_issuer"
  | "expired"
  | "exp_string"
  | "iss_non_string"
  | "huge_token"
  | "unicode_token"
  | "session_no_sub";

interface AuthGen {
  kind: AuthKind;
  header: string | null;
  /** user the handler will act as when the bearer is accepted */
  sub: string | null;
  valid: boolean;
}

/** Bearers the handler accepts and that leave the model untouched. */
const ACCEPTED_AUTH_KINDS: readonly AuthKind[] = [
  "google_ok",
  "apple_ok",
  "session_ok",
];

function genAuth(
  rng: Prng,
  sub: string,
  model: Model,
  onlyAccepted = false,
): AuthGen {
  const kind = onlyAccepted
    ? rng.pick(ACCEPTED_AUTH_KINDS)
    : rng.weighted<AuthKind>([
      [30, "google_ok"],
      [8, "apple_ok"],
      [14, "session_ok"],
      [3, "session_revoked"],
      [2, "session_providerless"],
      [5, "missing"],
      [2, "empty_bearer"],
      [2, "lowercase_scheme"],
      [2, "basic"],
      [3, "not_jwt"],
      [2, "two_segments"],
      [2, "four_segments"],
      [3, "bad_base64_payload"],
      [2, "payload_not_object"],
      [2, "payload_array"],
      [3, "unknown_issuer"],
      [3, "expired"],
      [2, "exp_string"],
      [2, "iss_non_string"],
      [2, "huge_token"],
      [2, "unicode_token"],
      [2, "session_no_sub"],
    ]);
  const google = (p: Record<string, unknown> = {}) =>
    jwt({
      iss: "https://accounts.google.com",
      sub,
      exp: nowSec() + 3600,
      ...p,
    });
  switch (kind) {
    case "google_ok":
      return { kind, header: `Bearer ${google()}`, sub, valid: true };
    case "apple_ok":
      return {
        kind,
        header: `Bearer ${
          jwt({ iss: "https://appleid.apple.com", sub, exp: nowSec() + 3600 })
        }`,
        sub,
        valid: true,
      };
    case "session_ok":
      return { kind, header: `Bearer ${sessionToken(sub)}`, sub, valid: true };
    case "session_revoked":
      model.revokedSubs.add(sub);
      return {
        kind,
        header: `Bearer ${sessionToken(sub)}`,
        sub: null,
        valid: false,
      };
    case "session_providerless":
      model.providerlessSubs.add(sub);
      return {
        kind,
        header: `Bearer ${sessionToken(sub)}`,
        sub: null,
        valid: false,
      };
    case "missing":
      return { kind, header: null, sub: null, valid: false };
    case "empty_bearer":
      return {
        kind,
        header: rng.pick(["Bearer", "Bearer ", "Bearer   "]),
        sub: null,
        valid: false,
      };
    case "lowercase_scheme":
      return { kind, header: `bearer ${google()}`, sub: null, valid: false };
    case "basic":
      return {
        kind,
        header: `Basic ${btoa("user:pass")}`,
        sub: null,
        valid: false,
      };
    case "not_jwt":
      return {
        kind,
        header: `Bearer ${
          rng.string(LATIN1_PRINTABLE.replace(/\s/g, ""), rng.int(1, 60))
        }`,
        sub: null,
        valid: false,
      };
    case "two_segments":
      return {
        kind,
        header: `Bearer ${JWT_HEADER}.${
          b64url(JSON.stringify({ iss: "https://accounts.google.com", sub }))
        }`,
        sub: null,
        valid: false,
      };
    case "four_segments":
      return {
        kind,
        header: `Bearer ${google()}.extra`,
        sub: null,
        valid: false,
      };
    case "bad_base64_payload":
      return {
        kind,
        header: `Bearer ${JWT_HEADER}.${
          rng.pick(["!!!", "%%%", "\u00e9\u00e9", "AAAA", "e30", "e3", "="])
        }.sig`,
        sub: null,
        valid: false,
      };
    case "payload_not_object":
      return {
        kind,
        header: `Bearer ${JWT_HEADER}.${
          b64url(rng.pick(["null", "42", '"str"', "true"]))
        }.sig`,
        sub: null,
        valid: false,
      };
    case "payload_array":
      return {
        kind,
        header: `Bearer ${JWT_HEADER}.${b64url("[1,2,3]")}.sig`,
        sub: null,
        valid: false,
      };
    case "unknown_issuer":
      return {
        kind,
        header: `Bearer ${
          jwt({
            iss: rng.pick([
              "https://evil.example.com",
              "accounts.google.com.evil",
              "https://accounts.google.com/",
              "http://accounts.google.com",
              "auth/v1",
              `${SUPABASE_URL}/auth/v1/`,
              "",
            ]),
            sub,
            exp: nowSec() + 3600,
          })
        }`,
        sub: null,
        valid: false,
      };
    case "expired":
      return {
        kind,
        header: `Bearer ${google({ exp: nowSec() - rng.int(0, 100_000) })}`,
        sub: null,
        valid: false,
      };
    case "exp_string":
      // exp is not a number → bearerExpired() ignores it → accepted by routing
      return {
        kind,
        header: `Bearer ${google({ exp: String(nowSec() - 1000) })}`,
        sub,
        valid: true,
      };
    case "iss_non_string":
      return {
        kind,
        header: `Bearer ${
          jwt({
            iss: rng.pick([1, null, ["https://accounts.google.com"], {
              iss: "x",
            }]),
            sub,
            exp: nowSec() + 3600,
          })
        }`,
        sub: null,
        valid: false,
      };
    case "huge_token":
      return {
        kind,
        header: `Bearer ${
          google({ pad: "x".repeat(rng.pick([10_000, 60_000])) })
        }`,
        sub,
        valid: true,
      };
    case "unicode_token":
      // non-ASCII claims in the payload (sub stays the routing key)
      return {
        kind,
        header: `Bearer ${
          google({
            name: "\u{1f3d3} Pickl\u00e9 \u0421\u0435\u043d\u0441\u0435\u0439",
            locale: "\u200e\u202e",
          })
        }`,
        sub,
        valid: true,
      };
    case "session_no_sub":
      return {
        kind,
        header: `Bearer ${
          jwt({ iss: `${SUPABASE_URL}/auth/v1`, exp: nowSec() + 3600 })
        }`,
        sub: null,
        valid: false,
      };
  }
}

type BodyKind =
  | "none"
  | "empty"
  | "json_object"
  | "json_array"
  | "invalid_json"
  | "large_1mb"
  | "binary"
  | "declared_oversize"
  | "declared_negative"
  | "declared_nan";

interface BodyGen {
  kind: BodyKind;
  body: BodyInit | null;
  contentType: string | null;
  contentLength: string | null;
  bytes: number;
}

function genBody(rng: Prng): BodyGen {
  const kind = rng.weighted<BodyKind>([
    [40, "none"],
    [8, "empty"],
    [14, "json_object"],
    [5, "json_array"],
    [8, "invalid_json"],
    [3, "large_1mb"],
    [6, "binary"],
    [8, "declared_oversize"],
    [4, "declared_negative"],
    [4, "declared_nan"],
  ]);
  const ct = rng.weighted<string | null>([
    [40, "application/json"],
    [15, null],
    [10, "text/plain"],
    [10, "application/x-www-form-urlencoded"],
    [8, "multipart/form-data; boundary=x"],
    [8, "application/json; charset=utf-16"],
    [9, rng.string(LATIN1_PRINTABLE.replace(/[\s]/g, ""), rng.int(1, 30))],
  ]);
  switch (kind) {
    case "none":
      return {
        kind,
        body: null,
        contentType: rng.chance(0.3) ? ct : null,
        contentLength: null,
        bytes: 0,
      };
    case "empty":
      return { kind, body: "", contentType: ct, contentLength: null, bytes: 0 };
    case "json_object": {
      const s = JSON.stringify({
        slug: validSlug(rng, 8),
        user_id: rng.uuid(),
        saved: rng.chance(0.5),
        __proto__: { polluted: true },
        nested: { a: [1, 2, { b: null }] },
      });
      return {
        kind,
        body: s,
        contentType: ct,
        contentLength: null,
        bytes: s.length,
      };
    }
    case "json_array":
      return {
        kind,
        body: "[1,2,3]",
        contentType: ct,
        contentLength: null,
        bytes: 7,
      };
    case "invalid_json": {
      const s = rng.pick([
        "{",
        '{"a":',
        "\u0000",
        "}{",
        "<xml/>",
        "\ufeff{}",
        '{"a":1,}',
      ]);
      return {
        kind,
        body: s,
        contentType: ct,
        contentLength: null,
        bytes: new TextEncoder().encode(s).length,
      };
    }
    case "large_1mb": {
      const s = `{"pad":"${"x".repeat(1_000_000)}"}`;
      return {
        kind,
        body: s,
        contentType: ct,
        contentLength: null,
        bytes: s.length,
      };
    }
    case "binary": {
      const bytes = new Uint8Array(rng.int(1, 512));
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = rng.int(0, 255);
      return {
        kind,
        body: bytes,
        contentType: ct ?? "application/octet-stream",
        contentLength: null,
        bytes: bytes.length,
      };
    }
    case "declared_oversize":
      return {
        kind,
        body: rng.chance(0.5) ? "{}" : null,
        contentType: ct,
        contentLength: String(
          rng.pick([
            MAX_JSON_BODY_BYTES + 1,
            6_000_000,
            2 ** 31,
            2 ** 53,
            1e300,
          ]),
        ),
        bytes: 2,
      };
    case "declared_negative":
      return {
        kind,
        body: "{}",
        contentType: ct,
        contentLength: String(rng.pick([-1, -5_000_001])),
        bytes: 2,
      };
    case "declared_nan":
      return {
        kind,
        body: "{}",
        contentType: ct,
        contentLength: rng.pick([
          "abc",
          "Infinity",
          "-Infinity",
          "1e999",
          "",
          " 12 ",
          "0x10",
        ]),
        bytes: 2,
      };
  }
}

type RequestIdKind =
  | "absent"
  | "valid"
  | "too_short"
  | "too_long"
  | "bad_chars"
  | "spaces"
  | "unicode";

interface HeaderGen {
  requestIdKind: RequestIdKind;
  requestId: string | null;
  ipHeaders: Record<string, string>;
  ip: string;
  extra: Record<string, string>;
}

function ipOf(rng: Prng): string {
  return `10.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`;
}

function genHeaders(rng: Prng, ip: string): HeaderGen {
  const requestIdKind = rng.weighted<RequestIdKind>([
    [45, "absent"],
    [25, "valid"],
    [6, "too_short"],
    [6, "too_long"],
    [8, "bad_chars"],
    [5, "spaces"],
    [5, "unicode"],
  ]);
  let requestId: string | null = null;
  switch (requestIdKind) {
    case "absent":
      break;
    case "valid":
      requestId = rng.string(LOWER + UPPER + DIGITS + "._-", rng.int(8, 64));
      break;
    case "too_short":
      requestId = rng.string(LOWER + DIGITS, rng.int(0, 7));
      break;
    case "too_long":
      requestId = rng.string(LOWER + DIGITS, rng.pick([65, 200, 8192]));
      break;
    case "bad_chars":
      requestId = `req${
        rng.pick([
          "<script>",
          '"',
          "'",
          "/",
          "\\",
          "%0d%0a",
          "$(x)",
          "{{x}}",
          "\u00e9\u00e9\u00e9\u00e9\u00e9",
        ])
      }${rng.string(LOWER, 8)}`;
      break;
    case "spaces":
      requestId = rng.pick([
        `  ${rng.string(LOWER, 12)}  `,
        `a b c d e f g h`,
        `\t${rng.string(LOWER, 12)}`,
      ]);
      break;
    case "unicode":
      requestId = rng.string("\u00e0\u00e8\u00ec\u00f2\u00f9\u00ff", 12);
      break;
  }
  const ipHeaders: Record<string, string> = {};
  switch (rng.int(0, 9)) {
    case 0:
      ipHeaders["cf-connecting-ip"] = ip;
      break;
    case 1:
      ipHeaders["x-forwarded-for"] = `1.2.3.4, 5.6.7.8, ${ip}`;
      break;
    case 2:
      ipHeaders["x-forwarded-for"] = `${ip}, `;
      break;
    case 3:
      ipHeaders["x-forwarded-for"] = `,,, ${ip}`;
      break;
    case 4:
      ipHeaders["x-forwarded-for"] = `${"a".repeat(2000)}, ${ip}`;
      break;
    case 5:
      ipHeaders["cf-connecting-ip"] = ip;
      ipHeaders["x-forwarded-for"] = "9.9.9.9";
      break;
    default:
      ipHeaders["x-forwarded-for"] = ip;
  }
  const extra: Record<string, string> = {};
  if (rng.chance(0.3)) {
    extra["accept"] = rng.pick([
      "*/*",
      "text/html",
      "application/xml",
      "",
      rng.string(LATIN1_PRINTABLE.replace(/\s/g, ""), 20),
    ]);
  }
  if (rng.chance(0.2)) {
    extra["prefer"] = rng.pick([
      "return=representation",
      "resolution=merge-duplicates",
      "x".repeat(100),
    ]);
  }
  if (rng.chance(0.2)) {
    extra["apikey"] = rng.pick(["service-role-test-key", "anon-test-key", "x"]);
  }
  if (rng.chance(0.15)) {
    extra["x-" + rng.string(LOWER, rng.int(1, 20))] = rng.string(
      LATIN1_PRINTABLE,
      rng.pick([0, 10, 1000, 16_000]),
    );
  }
  if (rng.chance(0.1)) {
    extra["origin"] = rng.pick([
      "null",
      "https://evil.example",
      "http://edge.test",
    ]);
  }
  if (rng.chance(0.1)) {
    extra["range"] = rng.pick(["0-9", "rows=0-0", "bytes=0-"]);
  }
  if (rng.chance(0.1)) {
    extra["x-http-method-override"] = rng.pick(["DELETE", "GET", "PUT"]);
  }
  return { requestIdKind, requestId, ipHeaders, ip, extra };
}

type MethodKind =
  | "PUT"
  | "DELETE"
  | "POST"
  | "GET"
  | "PATCH"
  | "HEAD"
  | "OPTIONS"
  | "put"
  | "PROPFIND"
  | "PURGE";

interface GeneratedCase {
  i: number;
  iterSeed: number;
  method: MethodKind;
  slug: SlugGen;
  path: PathGen;
  auth: AuthGen;
  body: BodyGen;
  headers: HeaderGen;
  fault: Fault;
  /** shared-user flood lane (per-user limiter) */
  floodLane: boolean;
  /** shared-IP lane for auth failures (auth-failure limiter) */
  authFailLane: boolean;
  userSub: string;
}

const FLOOD_USER = "f100d000-0000-4000-8000-000000000001";
const AUTHFAIL_IPS = ["10.99.99.1", "10.99.99.2", "10.99.99.3"];

function generate(
  campaignSeed: number,
  i: number,
  model: Model,
): GeneratedCase {
  const iterSeed = iterSeedOf(campaignSeed, i);
  const rng = new Prng(iterSeed);
  const method = rng.weighted<MethodKind>([
    [72, "PUT"],
    [8, "DELETE"],
    [5, "POST"],
    [5, "GET"],
    [3, "PATCH"],
    [2, "HEAD"],
    [2, "OPTIONS"],
    [1, "put"],
    [1, "PROPFIND"],
    [1, "PURGE"],
  ]);
  const floodLane = rng.chance(0.12);
  const authFailLane = rng.chance(0.15);
  const userSub = floodLane ? FLOOD_USER : rng.uuid();
  const slug = genSlug(rng);
  const path = genPath(rng, slug);
  // The flood user's bearer repeats across iterations and is served from the
  // handler's auth cache, so its lane only uses accepted bearers (never a
  // revoked/providerless one, which would poison the shared sub) and never
  // an Auth-side fault (the oracle could not tell cache-hit from fault).
  const auth = genAuth(rng, userSub, model, floodLane);
  const body = genBody(rng);
  const ip = authFailLane && !auth.valid ? rng.pick(AUTHFAIL_IPS) : ipOf(rng);
  const headers = genHeaders(rng, ip);
  const PG_FAULTS: Fault[] = [
    "pgrst_500_text",
    "pgrst_503_json_detail",
    "pgrst_fetch_throw",
    "pgrst_200_garbage",
    "pgrst_select_empty",
    "pgrst_409_conflict",
  ];
  const AUTH_FAULTS: Fault[] = [
    "auth_500",
    "auth_200_garbage",
    "auth_fetch_throw",
  ];
  const fault = rng.chance(0.06)
    ? rng.pick<Fault>(floodLane ? PG_FAULTS : [...PG_FAULTS, ...AUTH_FAULTS])
    : "none";
  return {
    i,
    iterSeed,
    method,
    slug,
    path,
    auth,
    body,
    headers,
    fault,
    floodLane,
    authFailLane,
    userSub,
  };
}

interface BuiltRequest {
  request: Request;
  /** headers that could not be set (Headers rejects non-ByteString values) */
  droppedHeaders: string[];
}

function buildRequest(c: GeneratedCase): BuiltRequest {
  const headers = new Headers();
  const dropped: string[] = [];
  const trySet = (k: string, v: string) => {
    try {
      headers.set(k, v);
    } catch {
      dropped.push(k);
    }
  };
  if (c.auth.header !== null) trySet("Authorization", c.auth.header);
  for (const [k, v] of Object.entries(c.headers.ipHeaders)) trySet(k, v);
  for (const [k, v] of Object.entries(c.headers.extra)) trySet(k, v);
  if (c.headers.requestId !== null) trySet("x-request-id", c.headers.requestId);
  if (c.body.contentType !== null) trySet("Content-Type", c.body.contentType);
  if (c.body.contentLength !== null) {
    trySet("Content-Length", c.body.contentLength);
  }
  const method = c.method;
  const bodyAllowed = method !== "GET" && method !== "HEAD";
  let request: Request;
  try {
    request = new Request(c.path.url, {
      method,
      headers,
      body: bodyAllowed ? c.body.body : null,
    });
  } catch {
    // e.g. a body on a method Deno refuses — fall back to no body
    request = new Request(c.path.url, { method, headers });
  }
  return { request, droppedHeaders: dropped };
}

// ── Oracle ───────────────────────────────────────────────────────────────────

interface Oracle {
  /** statuses the handler is allowed to answer for this input */
  allowed: number[];
  /** the single status a correct handler answers when no limiter fires */
  primary: number;
  /** authenticated user + decoded slug when the primary answer is 200 */
  expectedWrite: { sub: string; slug: string } | null;
  reason: string;
}

function oracle(
  c: GeneratedCase,
  request: Request,
  limiter: LimiterModel,
): Oracle {
  const pathname = new URL(request.url).pathname;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    return {
      allowed: [413],
      primary: 413,
      expectedWrite: null,
      reason: "declared oversize body",
    };
  }
  const ipLimited = limiter.ipCount(c.headers.ip) >= 1_200;
  if (ipLimited) {
    return {
      allowed: [429],
      primary: 429,
      expectedWrite: null,
      reason: "ip limit",
    };
  }
  const authFailLimited =
    limiter.authFailCount(c.headers.ip) >= AUTH_FAILURE_LIMIT;
  if (authFailLimited) {
    return {
      allowed: [429],
      primary: 429,
      expectedWrite: null,
      reason: "auth-failure limit",
    };
  }
  if (!c.auth.valid) {
    if (
      c.fault === "auth_500" || c.fault === "auth_200_garbage" ||
      c.fault === "auth_fetch_throw"
    ) {
      return {
        allowed: [401, 503],
        primary: 401,
        expectedWrite: null,
        reason: "bad bearer under auth fault",
      };
    }
    return {
      allowed: [401],
      primary: 401,
      expectedWrite: null,
      reason: `bad bearer (${c.auth.kind})`,
    };
  }
  const authFault = c.fault === "auth_500" || c.fault === "auth_200_garbage" ||
    c.fault === "auth_fetch_throw";
  if (authFault) {
    // provider tokens: signInWithIdToken error → 401 (transitional path);
    // session tokens: Auth unavailable → 503
    const isSession = c.auth.kind === "session_ok";
    return {
      allowed: isSession ? [503] : [401],
      primary: isSession ? 503 : 401,
      expectedWrite: null,
      reason: `auth upstream fault ${c.fault}`,
    };
  }
  const userLimited = limiter.userCount(c.auth.sub!) >= GENERAL_USER_LIMIT;
  if (userLimited) {
    return {
      allowed: [429],
      primary: 429,
      expectedWrite: null,
      reason: "user limit",
    };
  }
  const v1 = pathname.lastIndexOf("/v1/");
  const path = v1 >= 0 ? pathname.slice(v1) : pathname;
  const m = ROUTE_RE.exec(path);
  // Request normalises known method names ("put" → "PUT"): judge what the
  // handler actually receives.
  const method = request.method;
  if (method === "GET" && path === "/v1/me/saved-drills") {
    // the sibling list route (a slug-less PUT/DELETE path lands here as GET)
    const pgFault = c.fault.startsWith("pgrst_") &&
      c.fault !== "pgrst_select_empty" && c.fault !== "pgrst_409_conflict";
    return {
      allowed: [pgFault ? 503 : 200],
      primary: pgFault ? 503 : 200,
      expectedWrite: null,
      reason: pgFault ? `list under ${c.fault}` : "list saved drills",
    };
  }
  if (!m || (method !== "PUT" && method !== "DELETE")) {
    return {
      allowed: [404],
      primary: 404,
      expectedWrite: null,
      reason: `no route (${method} ${c.path.shape})`,
    };
  }
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    return {
      allowed: [400],
      primary: 400,
      expectedWrite: null,
      reason: "malformed percent-encoding",
    };
  }
  if (method === "DELETE") {
    const pgFault = c.fault.startsWith("pgrst_") &&
      c.fault !== "pgrst_select_empty" && c.fault !== "pgrst_409_conflict";
    if (pgFault) {
      return {
        allowed: [503],
        primary: 503,
        expectedWrite: null,
        reason: `unsave under ${c.fault}`,
      };
    }
    return {
      allowed: [204],
      primary: 204,
      expectedWrite: null,
      reason: "unsave (no slug validation in route)",
    };
  }
  if (!DRILL_SLUG_RE.test(slug)) {
    return {
      allowed: [400],
      primary: 400,
      expectedWrite: null,
      reason: `invalid slug (${c.slug.kind})`,
    };
  }
  if (c.fault.startsWith("pgrst_")) {
    return {
      allowed: [503],
      primary: 503,
      expectedWrite: null,
      reason: `save under ${c.fault}`,
    };
  }
  return {
    allowed: [200],
    primary: 200,
    expectedWrite: { sub: c.auth.sub!, slug },
    reason: "valid save",
  };
}

/** Tracks the fixed windows the handler's in-memory limiter uses, keyed the
 * same way (aligned minute / 5-minute buckets), so the oracle knows when a
 * 429 is legitimately due. Counts what the handler COUNTS: every request that
 * reaches the ip limiter, every 401, every authenticated request. */
class LimiterModel {
  private counts = new Map<string, { bucket: number; n: number }>();
  private bump(scope: string, id: string, windowSeconds: number): number {
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `${scope}:${id}`;
    const cur = this.counts.get(key);
    if (!cur || cur.bucket !== bucket) {
      this.counts.set(key, { bucket, n: 1 });
      return 1;
    }
    cur.n += 1;
    return cur.n;
  }
  private peek(scope: string, id: string, windowSeconds: number): number {
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const cur = this.counts.get(`${scope}:${id}`);
    return cur && cur.bucket === bucket ? cur.n : 0;
  }
  ipCount(ip: string) {
    return this.peek("ip", ip, 60);
  }
  authFailCount(ip: string) {
    return this.peek("authfail", ip, 300);
  }
  userCount(sub: string) {
    return this.peek("user", sub, 60);
  }
  /** Apply what the handler will have counted for this request. */
  account(c: GeneratedCase, status: number, sawIpLimiter: boolean) {
    if (!sawIpLimiter) return;
    this.bump("ip", c.headers.ip, 60);
    if (status === 401) this.bump("authfail", c.headers.ip, 300);
    const authFault = c.fault === "auth_500" ||
      c.fault === "auth_200_garbage" || c.fault === "auth_fetch_throw";
    if (c.auth.valid && !authFault && status !== 401 && status !== 413) {
      this.bump("user", c.auth.sub!, 60);
    }
  }
}

// ── Response checks ──────────────────────────────────────────────────────────

const LEAK_MARKERS = [
  "    at ",
  "index.ts",
  "routesHarness",
  ".ts:",
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
  "URIError",
  "stack",
  "PGRST",
  "user_saved_drills",
  "supabase.test",
  "session-for-",
  "SECRET_DETAIL_MARKER",
  "postgres://",
  "gotrue",
  "23514",
  "23505",
  "42501",
  "PostgREST",
  "App.hs",
  "connection refused",
  "connection reset",
];

const GENERIC_5XX_MESSAGES = new Set([
  "Drill save is temporarily unavailable. Please try again.",
  "Drill unsave is temporarily unavailable. Please try again.",
  "Session verification is temporarily unavailable. Please try again.",
  "Something went wrong. Please try again.",
]);

interface ResultRow {
  i: number;
  iterSeed: number;
  method: string;
  url: string;
  urlSha: string;
  slugKind: SlugKind;
  slugRaw: string;
  pathShape: PathShape;
  authKind: AuthKind;
  bodyKind: BodyKind;
  contentLength: string | null;
  requestIdKind: RequestIdKind;
  fault: Fault;
  floodLane: boolean;
  authFailLane: boolean;
  droppedHeaders: string[];
  status: number | null;
  code: string | null;
  message: string | null;
  requestId: string | null;
  retryAfter: string | null;
  upstreamCalls: number;
  upstreamWrites: number;
  tableChanged: boolean;
  durationMs: number;
  expectedPrimary: number;
  expectedAllowed: number[];
  oracleReason: string;
  violations: string[];
  ok: boolean;
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

const clip = (
  s: string,
  n = 200,
) => (s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s);

async function runCase(
  h: Harness,
  model: Model,
  limiter: LimiterModel,
  c: GeneratedCase,
): Promise<ResultRow> {
  const { request, droppedHeaders } = buildRequest(c);
  const expect = oracle(c, request, limiter);
  model.fault = c.fault;
  model.calls = [];
  const before = model.snapshot();
  const violations: string[] = [];
  const t0 = performance.now();
  let response: Response | null = null;
  let status: number | null = null;
  let text = "";
  let rejectedWith: string | null = null;
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("handler exceeded 10s")), 10_000)
    );
    response = await Promise.race([h.handler(request), timeout]);
    status = response.status;
    text = await response.text();
  } catch (error) {
    rejectedWith = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    violations.push(`I9 handler rejected: ${rejectedWith}`);
  }
  const durationMs = Math.round((performance.now() - t0) * 100) / 100;
  model.fault = "none";
  const after = model.snapshot();
  const upstreamWrites = model.calls.filter((k) => k.isWrite).length;
  const tableChanged = before !== after;

  let code: string | null = null;
  let message: string | null = null;
  let parsed: unknown = undefined;
  if (response) {
    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("application/json") && text) {
      try {
        parsed = JSON.parse(text);
        const err =
          (parsed as { error?: { code?: unknown; message?: unknown } }).error;
        if (err && typeof err === "object") {
          code = typeof err.code === "string" ? err.code : null;
          message = typeof err.message === "string" ? err.message : null;
        }
      } catch {
        violations.push(
          `I3 JSON content-type with unparsable body: ${clip(text)}`,
        );
      }
    }
  }

  // The handler's limiter counts only requests that reached it: everything
  // except the pre-auth 413 (which returns before it).
  const sawIpLimiter = status !== null && status !== 413;
  limiter.account(c, status ?? 0, sawIpLimiter);

  if (response && status !== null) {
    const rid = response.headers.get("x-request-id");
    // I1
    const okStatuses = new Set([
      200,
      204,
      400,
      401,
      403,
      404,
      405,
      413,
      415,
      429,
    ]);
    if (!okStatuses.has(status)) {
      if (
        status >= 500 && c.fault !== "none" &&
        (status === 503 || status === 500)
      ) {
        // induced upstream fault — allowed, but must be generic (I2)
      } else {
        violations.push(
          `I1 status ${status} outside allowed set (fault=${c.fault})`,
        );
      }
    }
    // I2
    if (status >= 500) {
      const ct = response.headers.get("content-type") ?? "";
      const shapeOk = ct.includes("application/json") &&
        parsed !== undefined &&
        typeof parsed === "object" &&
        parsed !== null &&
        Object.keys(parsed as object).join() === "error" &&
        Object.keys((parsed as { error: object }).error).join() === "message" &&
        message !== null &&
        GENERIC_5XX_MESSAGES.has(message);
      if (!shapeOk) violations.push(`I2 5xx body not generic: ${clip(text)}`);
    }
    // I3
    const lower = text.toLowerCase();
    for (const marker of LEAK_MARKERS) {
      if (lower.includes(marker.toLowerCase())) {
        violations.push(`I3 body leaks "${marker}": ${clip(text)}`);
        break;
      }
    }
    const bearer = (c.auth.header ?? "").replace(/^Bearer\s+/, "");
    if (bearer.length >= 8 && text.includes(bearer)) {
      violations.push("I3 body echoes bearer");
    }
    // (404 "Unknown endpoint: <method> <path>" echoes the route by design —
    // recorded in the summary as an observation, not judged here.)
    if (
      status >= 400 && status !== 404 && c.slug.raw.length >= 6 &&
      text.includes(c.slug.raw)
    ) {
      violations.push("I3 error body echoes raw path segment");
    }
    // I4 — a 4xx is a rejection and must not have written. (A 5xx AFTER the
    // upsert — e.g. the read-back failing — is a committed idempotent write
    // the client retries; counted separately as writesOn5xx.)
    if (status >= 400 && status < 500) {
      if (upstreamWrites > 0) {
        violations.push(`I4 ${upstreamWrites} upstream write(s) on ${status}`);
      }
      if (tableChanged) violations.push(`I4 table changed on ${status}`);
    }
    // I5
    if (!rid || !REQUEST_ID_RE.test(rid)) {
      violations.push(
        `I5 x-request-id missing/malformed: ${JSON.stringify(rid)}`,
      );
    }
    if (
      c.headers.requestId !== null && !droppedHeaders.includes("x-request-id")
    ) {
      const trimmed = c.headers.requestId.trim();
      if (REQUEST_ID_RE.test(trimmed)) {
        if (rid !== trimmed) {
          violations.push(
            `I5 well-formed client request id not echoed (${
              clip(trimmed, 40)
            } → ${rid})`,
          );
        }
      } else if (rid === c.headers.requestId || (trimmed && rid === trimmed)) {
        violations.push("I5 malformed client request id echoed");
      }
    }
    // I6
    if (
      (response.headers.get("content-type") ?? "").includes("application/json")
    ) {
      if (response.headers.get("x-content-type-options") !== "nosniff") {
        violations.push("I6 nosniff missing");
      }
      if (response.headers.get("cache-control") !== "no-store") {
        violations.push("I6 no-store missing");
      }
    }
    // I7
    if (status === 429) {
      if (!response.headers.get("retry-after")) {
        violations.push("I7 429 without Retry-After");
      }
      // the per-user budget is charged after authentication, so an Auth
      // round trip may precede a 429; PostgREST must never be reached
      const rest = model.calls.filter((call) => call.url.includes("/rest/v1/"));
      if (rest.length > 0) {
        violations.push(`I7 429 made ${rest.length} PostgREST call(s)`);
      }
    }
    // I8
    if (!expect.allowed.includes(status)) {
      violations.push(
        `I8 expected ${
          expect.allowed.join("/")
        } (${expect.reason}) got ${status}${code ? ` code=${code}` : ""}${
          message ? ` msg=${clip(message, 80)}` : ""
        }`,
      );
    }
    if (status === 200 && c.method === "PUT") {
      const w = expect.expectedWrite;
      const body = parsed as {
        slug?: unknown;
        saved?: unknown;
        savedAt?: unknown;
      } | undefined;
      if (!w) {
        violations.push("I8 200 without an expected write");
      } else {
        const row = model.rows.get(model.key(w.sub, w.slug));
        if (!row) {
          violations.push(
            `I8 200 but no row for authenticated user + decoded slug`,
          );
        }
        if (upstreamWrites !== 1) {
          violations.push(
            `I8 200 with ${upstreamWrites} upstream writes (expected exactly 1 upsert)`,
          );
        }
        if (
          !body || body.slug !== w.slug || body.saved !== true ||
          typeof body.savedAt !== "string"
        ) {
          violations.push(`I8 200 body shape wrong: ${clip(text)}`);
        } else if (row && body.savedAt !== row.saved_at) {
          violations.push(`I8 savedAt ${body.savedAt} != row ${row.saved_at}`);
        }
        const foreign = [...model.rows.values()].filter((r) =>
          r.user_id !== w.sub && r.slug === w.slug &&
          !before.includes(model.key(r.user_id, r.slug))
        );
        if (foreign.length) {
          violations.push("I8 200 wrote a row for a different user");
        }
      }
    }
    if (
      status === 400 && expect.primary === 400 &&
      expect.reason.startsWith("invalid slug") &&
      code !== "validation.saved_drill"
    ) {
      violations.push(
        `I8 invalid slug 400 without code validation.saved_drill (code=${code})`,
      );
    }
  }

  return {
    i: c.i,
    iterSeed: c.iterSeed,
    method: c.method,
    url: clip(request.url, 300),
    urlSha: await sha256(request.url),
    slugKind: c.slug.kind,
    slugRaw: clip(c.slug.raw, 120),
    pathShape: c.path.shape,
    authKind: c.auth.kind,
    bodyKind: c.body.kind,
    contentLength: c.body.contentLength,
    requestIdKind: c.headers.requestIdKind,
    fault: c.fault,
    floodLane: c.floodLane,
    authFailLane: c.authFailLane,
    droppedHeaders,
    status,
    code,
    message: message === null ? null : clip(message, 160),
    requestId: response?.headers.get("x-request-id") ?? null,
    retryAfter: response?.headers.get("retry-after") ?? null,
    upstreamCalls: model.calls.length,
    upstreamWrites,
    tableChanged,
    durationMs,
    expectedPrimary: expect.primary,
    expectedAllowed: expect.allowed,
    oracleReason: expect.reason,
    violations,
    ok: violations.length === 0,
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

function histogram(
  values: Array<string | number | null>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const k = String(v);
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

async function writeJson(name: string, value: unknown): Promise<string> {
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const path = `${OUT_DIR.replace(/\/$/, "")}/${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

function replayCommand(iterSeeds: number[]): string {
  return `STRESS_SEED=${STRESS_SEED} STRESS_REPLAY=${
    iterSeeds.join(",")
  } STRESS_REPEAT=10 deno test -A --no-check --config deno.json ${TEST_FILE} --filter "fuzz campaign"`;
}

// ── Shared setup ─────────────────────────────────────────────────────────────

let shared: { h: Harness; model: Model } | null = null;
async function setup(): Promise<{ h: Harness; model: Model }> {
  if (shared) {
    shared.h.reset();
    shared.model.reset();
    return shared;
  }
  const h = await loadHarness();
  const model = new Model();
  installModel(h, model);
  shared = { h, model };
  return shared;
}

// ── Tests ────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    `stress fuzz campaign: PUT /v1/me/saved-drills/:slug × STRESS_ITER (seed ${STRESS_SEED})`,
  async fn() {
    const { h, model } = await setup();
    const limiter = new LimiterModel();
    const rows: ResultRow[] = [];
    const heapBefore = Deno.memoryUsage();
    const t0 = performance.now();

    // Replay mode: run only the listed iteration seeds, STRESS_REPEAT times.
    const plan: Array<{ i: number; iterSeed: number }> = [];
    if (STRESS_REPLAY.length > 0) {
      // recover the iteration index for each seed by scanning the campaign
      const wanted = new Set(STRESS_REPLAY);
      for (
        let i = 0;
        i < Math.max(STRESS_ITER, 100_000) && wanted.size > 0;
        i += 1
      ) {
        const s = iterSeedOf(STRESS_SEED, i);
        if (wanted.has(s)) {
          wanted.delete(s);
          for (let r = 0; r < STRESS_REPEAT; r += 1) {
            plan.push({ i, iterSeed: s });
          }
        }
      }
      assert(
        wanted.size === 0,
        `STRESS_REPLAY seeds not found in campaign seed ${STRESS_SEED}: ${
          [...wanted].join(",")
        }`,
      );
    } else {
      for (let r = 0; r < STRESS_REPEAT; r += 1) {
        for (let i = 0; i < STRESS_ITER; i += 1) {
          plan.push({ i, iterSeed: iterSeedOf(STRESS_SEED, i) });
        }
      }
    }

    for (const step of plan) {
      const c = generate(STRESS_SEED, step.i, model);
      rows.push(await runCase(h, model, limiter, c));
      // keep routesHarness' unbounded call log from growing across thousands
      // of iterations (the model keeps its own per-request log)
      if (h.calls.length > 5_000) h.calls.length = 0;
    }

    const durationMs = Math.round(performance.now() - t0);
    const violations = rows.filter((r) => !r.ok);
    const fiveXx = rows.filter((r) =>
      (r.status ?? 0) >= 500 || r.status === null
    );
    const uninducedFiveXx = fiveXx.filter((r) => r.fault === "none");
    const summary = {
      testFile: TEST_FILE,
      campaignSeed: STRESS_SEED,
      iterationsPlanned: plan.length,
      iterationsExecuted: rows.length,
      repeat: STRESS_REPEAT,
      replay: STRESS_REPLAY,
      durationMs,
      heap: { before: heapBefore, after: Deno.memoryUsage() },
      statusHistogram: histogram(rows.map((r) => r.status)),
      statusByExpected: histogram(
        rows.map((r) => `${r.expectedPrimary}→${r.status}`),
      ),
      slugKindHistogram: histogram(rows.map((r) => r.slugKind)),
      pathShapeHistogram: histogram(rows.map((r) => r.pathShape)),
      authKindHistogram: histogram(rows.map((r) => r.authKind)),
      bodyKindHistogram: histogram(rows.map((r) => r.bodyKind)),
      methodHistogram: histogram(rows.map((r) => r.method)),
      faultHistogram: histogram(rows.map((r) => r.fault)),
      requestIdKindHistogram: histogram(rows.map((r) => r.requestIdKind)),
      writesOn4xx: rows.filter((r) =>
        (r.status ?? 0) >= 400 && (r.status ?? 0) < 500 &&
        (r.upstreamWrites > 0 || r.tableChanged)
      ).length,
      // write CALLS the handler issued before answering 5xx (the faulted call
      // itself counts) vs rows that actually landed before the 5xx (the
      // upsert committed and the read-back failed — idempotent on retry)
      writeAttemptsOn5xx: rows.filter((r) =>
        (r.status ?? 0) >= 500 && r.upstreamWrites > 0
      ).length,
      committedWritesOn5xx: rows.filter((r) =>
        (r.status ?? 0) >= 500 && r.tableChanged
      ).length,
      committedWritesOn5xxByFault: histogram(
        rows.filter((r) => (r.status ?? 0) >= 500 && r.tableChanged).map((r) =>
          r.fault
        ),
      ),
      notFoundEchoesPath: rows.filter((r) =>
        r.status === 404 && r.message !== null && r.message.includes("/v1/")
      ).length,
      rejectedRequests: rows.filter((r) =>
        (r.status ?? 0) >= 400
      ).length,
      acceptedPuts:
        rows.filter((r) => r.status === 200 && r.method === "PUT").length,
      rateLimited429: rows.filter((r) => r.status === 429).length,
      fiveXxTotal: fiveXx.length,
      fiveXxInduced: fiveXx.length - uninducedFiveXx.length,
      fiveXxUninduced: uninducedFiveXx.length,
      missingRequestId: rows.filter((r) => !r.requestId).length,
      violationCount: violations.length,
      violationSeeds: violations.map((r) => r.iterSeed),
      invariants: [
        {
          name: "I1 only 2xx/4xx (5xx only under injected upstream fault)",
          holds: !rows.some((r) =>
            r.violations.some((v) => v.startsWith("I1"))
          ),
        },
        {
          name: "I2 every 5xx body generic",
          holds: !rows.some((r) =>
            r.violations.some((v) => v.startsWith("I2"))
          ),
        },
        {
          name: "I3 no stack/detail/token/table leak in any body",
          holds: !rows.some((r) =>
            r.violations.some((v) => v.startsWith("I3"))
          ),
        },
        {
          name: "I4 no write on rejection",
          holds: !rows.some((r) =>
            r.violations.some((v) => v.startsWith("I4"))
          ),
        },
        {
          name:
            "I5 x-request-id present, well-formed, never echoes malformed input",
          holds: !rows.some((r) =>
            r.violations.some((v) => v.startsWith("I5"))
          ),
        },
        {
          name: "I6 security headers on JSON",
          holds: !rows.some((r) =>
            r.violations.some((v) => v.startsWith("I6"))
          ),
        },
        {
          name: "I7 429 has Retry-After and never reached PostgREST",
          holds: !rows.some((r) =>
            r.violations.some((v) => v.startsWith("I7"))
          ),
        },
        {
          name:
            "I8 status matches oracle; 200 wrote exactly the authed user's decoded slug",
          holds: !rows.some((r) =>
            r.violations.some((v) => v.startsWith("I8"))
          ),
        },
        {
          name: "I9 handler never rejects / never exceeds 10s",
          holds: !rows.some((r) =>
            r.violations.some((v) => v.startsWith("I9"))
          ),
        },
      ],
      replayCommandForViolations: violations.length
        ? replayCommand(
          [...new Set(violations.map((r) => r.iterSeed))].slice(0, 50),
        )
        : null,
      fullRunCommand:
        `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} STRESS_OUT_DIR=${OUT_DIR} deno test -A --no-check --config deno.json ${TEST_FILE}`,
    };
    const summaryPath = await writeJson("summary.json", summary);
    await writeJson("results.json", rows);
    await writeJson("violations.json", violations);
    await writeJson("fivexx.json", fiveXx);
    console.log(
      `[stress] seed=${STRESS_SEED} executed=${rows.length} ${durationMs}ms statuses=${
        JSON.stringify(summary.statusHistogram)
      } violations=${violations.length} 5xx(induced/uninduced)=${summary.fiveXxInduced}/${summary.fiveXxUninduced} → ${summaryPath}`,
    );
    for (const v of violations.slice(0, 20)) {
      console.log(
        `[stress]   BROKEN iterSeed=${v.iterSeed} i=${v.i} ${v.method} ${v.url} :: ${
          v.violations.join(" | ")
        }`,
      );
    }
    assertEquals(rows.length, plan.length, "every planned iteration executed");
    assert(
      violations.length === 0,
      `${violations.length} violation(s); replay: ${summary.replayCommandForViolations}`,
    );
  },
});

Deno.test({
  name:
    "stress burst: same user > 240 PUTs in one minute → 429 with Retry-After, zero writes after the first refusal",
  async fn() {
    const { h, model } = await setup();
    const sub = "b0b0b0b0-0000-4000-8000-00000000b0b0";
    const token = `Bearer ${
      jwt({ iss: "https://accounts.google.com", sub, exp: nowSec() + 3600 })
    }`;
    const statuses: number[] = [];
    let writesAfterRefusal = 0;
    let firstRefusal = -1;
    for (let n = 0; n < GENERAL_USER_LIMIT + 20; n += 1) {
      model.calls = [];
      const res = await h.handler(
        new Request(
          `http://edge.test/functions/v1/api/v1/me/saved-drills/burst-${n}`,
          {
            method: "PUT",
            headers: {
              Authorization: token,
              "x-forwarded-for": `10.77.${n % 250}.${(n * 7) % 250}`,
            },
          },
        ),
      );
      await res.text();
      statuses.push(res.status);
      if (res.status === 429) {
        if (firstRefusal < 0) firstRefusal = n;
        assert(res.headers.get("retry-after"), "429 carries Retry-After");
        assert(
          REQUEST_ID_RE.test(res.headers.get("x-request-id") ?? ""),
          "429 carries x-request-id",
        );
        writesAfterRefusal += model.calls.filter((k) => k.isWrite).length;
      }
    }
    const h429 = statuses.filter((s) => s === 429).length;
    const h200 = statuses.filter((s) => s === 200).length;
    const rowsForUser = [...model.rows.values()].filter((r) =>
      r.user_id === sub
    ).length;
    await writeJson("burst_per_user_limit.json", {
      sub,
      statuses,
      firstRefusal,
      h200,
      h429,
      rowsForUser,
      writesAfterRefusal,
    });
    // Fixed windows are minute-aligned: a boundary crossing mid-burst can
    // legitimately reset the count, so assert the shape, not the exact split.
    assert(
      h429 >= 1,
      `expected at least one 429 after ${GENERAL_USER_LIMIT} requests; statuses=${
        JSON.stringify(histogram(statuses))
      }`,
    );
    assertEquals(
      new Set(statuses).size <= 2 &&
        statuses.every((s) => s === 200 || s === 429),
      true,
      `only 200/429: ${JSON.stringify(histogram(statuses))}`,
    );
    assertEquals(writesAfterRefusal, 0, "no upstream write on a 429");
    assertEquals(rowsForUser, h200, "exactly one row per accepted PUT");
  },
});

Deno.test({
  name:
    "stress idempotency: 64 concurrent + 32 sequential PUTs of one slug → all 200, ONE row, identical savedAt",
  async fn() {
    const { h, model } = await setup();
    const sub = "1de11de1-0000-4000-8000-0000001de11d";
    const token = `Bearer ${
      jwt({ iss: "https://accounts.google.com", sub, exp: nowSec() + 3600 })
    }`;
    const put = () =>
      h.handler(
        new Request(
          "http://edge.test/functions/v1/api/v1/me/saved-drills/third-shot-drop",
          {
            method: "PUT",
            headers: { Authorization: token, "x-forwarded-for": "10.66.0.1" },
          },
        ),
      );
    const concurrent = await Promise.all(Array.from({ length: 64 }, put));
    const sequential: Response[] = [];
    for (let n = 0; n < 32; n += 1) sequential.push(await put());
    const bodies: Array<{ slug: string; saved: boolean; savedAt: string }> = [];
    for (const res of [...concurrent, ...sequential]) {
      assertEquals(res.status, 200);
      bodies.push(await res.json());
    }
    const savedAts = new Set(bodies.map((b) => b.savedAt));
    const rows = [...model.rows.values()].filter((r) => r.user_id === sub);
    await writeJson("idempotent_reput.json", {
      sub,
      responses: bodies.length,
      savedAts: [...savedAts],
      rows,
    });
    assertEquals(rows.length, 1, "one row after 96 PUTs of the same slug");
    assertEquals(
      savedAts.size,
      1,
      "savedAt never changes on re-PUT (ignoreDuplicates keeps the first row)",
    );
    assert(
      bodies.every((b) => b.slug === "third-shot-drop" && b.saved === true),
    );
  },
});

Deno.test({
  name:
    "stress cross-user: PUT never writes another user's row; a slug saved by A is invisible to B",
  async fn() {
    const { h, model } = await setup();
    const a = "aaaaaaaa-0000-4000-8000-0000000000aa";
    const b = "bbbbbbbb-0000-4000-8000-0000000000bb";
    const tok = (sub: string) =>
      `Bearer ${
        jwt({ iss: "https://accounts.google.com", sub, exp: nowSec() + 3600 })
      }`;
    const resA = await h.handler(
      new Request(
        "http://edge.test/functions/v1/api/v1/me/saved-drills/dink-ladder",
        {
          method: "PUT",
          headers: { Authorization: tok(a), "x-forwarded-for": "10.55.0.1" },
        },
      ),
    );
    assertEquals(resA.status, 200);
    await resA.text();
    // B saves the same slug: separate row, A's row untouched.
    const resB = await h.handler(
      new Request(
        "http://edge.test/functions/v1/api/v1/me/saved-drills/dink-ladder",
        {
          method: "PUT",
          headers: { Authorization: tok(b), "x-forwarded-for": "10.55.0.2" },
        },
      ),
    );
    assertEquals(resB.status, 200);
    const bodyB = await resB.json();
    const rowA = model.rows.get(model.key(a, "dink-ladder"))!;
    const rowB = model.rows.get(model.key(b, "dink-ladder"))!;
    assert(rowA && rowB, "two rows, one per user");
    assertEquals(bodyB.savedAt, rowB.saved_at, "B sees B's saved_at, not A's");
    assert(rowA.saved_at !== rowB.saved_at);
    // Every upstream write carried the caller's own user_id.
    const writes = model.calls.filter((k) => k.isWrite);
    assert(writes.length >= 1);
    assertEquals(model.rows.size, 2);
  },
});
