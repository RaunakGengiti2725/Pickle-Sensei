/**
 * STRESS — fuzz/boundary campaign for `POST /v1/billing/sync`.
 *
 * Drives the REAL production handler (supabase/functions/api/index.ts, captured
 * in-process through routesHarness.ts — no port, no network) with seeded,
 * replayable generated requests: method / path / query / header / body
 * variations on the client side and RevenueCat / Supabase Auth / PostgREST
 * fault shapes on the upstream side. Every iteration derives from one 32-bit
 * seed and is replayable alone.
 *
 * Invariants asserted per request (a failing iteration is BROKEN, with its seed
 * and the minimal payload recorded in the JSON table):
 *   - bad client input is answered with 400/401/403/404/405/413/415/429 ONLY;
 *   - a 5xx is answered ONLY when an upstream was deliberately broken in that
 *     iteration, and its body is one of the generic messages — never the
 *     upstream detail (a per-iteration CANARY string is planted in every
 *     upstream error and must never surface), never a stack trace;
 *   - `x-request-id` is present on every response (echoed only when well-formed);
 *   - a rejected request (4xx, or 502 because RevenueCat returned no verdict)
 *     never writes `billing_entitlements`; an accepted verdict writes EXACTLY
 *     once, for the authenticated user, with the service-role key, with the
 *     premium/product/expiry the oracle computed from the RevenueCat shape;
 *   - RevenueCat is asked at most once per request, only after auth and rate
 *     limits, and only for the authenticated user id;
 *   - a 200 body satisfies the mobile parseAccess arithmetic contract and
 *     agrees with the oracle verdict; the per-user 10/min budget never admits
 *     an 11th sync in one window;
 *   - no secret (RevenueCat key, service-role key, bearer) appears in any
 *     response body or captured log line.
 *
 * Knobs (all optional):
 *   STRESS_ITER    iterations for the stub-backed campaign (default 150)
 *   STRESS_SEED    master seed (default 20260905)
 *   STRESS_REPLAY  comma-separated iteration seeds to run alone (minimisation)
 *   STRESS_OUT     directory for the JSON result table (default: not written)
 *   STRESS_PG_URL  (or XC_PG_URL / PICKLE_AUDIT_PG_URL) — also run the
 *                  Postgres-backed campaign: PostgREST is replaced by a shim
 *                  that executes the upsert / access_state() RPC against a
 *                  disposable postgres:16 with every migration applied
 *                  (./xc_pg_up.sh prints the URL). Skipped otherwise.
 *   STRESS_PG_ITER iterations for the Postgres-backed campaign (default 200)
 *
 * Full campaign, as run for the evidence table:
 *   STRESS_ITER=3200 STRESS_OUT=/tmp/stress deno test -A --no-check \
 *     --config deno.json stress_billing_sync_fuzz_boundary.test.ts
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import { type Harness, loadHarness, RC_URL, SUPABASE_URL, TEST_USER_ID } from "./routesHarness.ts";

// Install the fault-injecting fetch once, ahead of the first request (module
// evaluation precedes every test body). The harness's own stub stays the
// delegate, so requests outside a scenario behave like every other __wf__ test.
await loadHarness();
{
  const delegate = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    faultedFetch(delegate, input, init)) as typeof fetch;
}

// ── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

class Rng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  /** Weighted pick: [[weight, value], ...]. */
  weighted<T>(items: ReadonlyArray<readonly [number, T]>): T {
    const total = items.reduce((sum, [w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [w, v] of items) {
      roll -= w;
      if (roll < 0) return v;
    }
    return items[items.length - 1][1];
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
  /** Header-safe (ByteString, no CR/LF/NUL) string of `len` chars. */
  byteString(len: number): string {
    const alphabet =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~\t\u00e9\u00ff\u00a0\u0080";
    let out = "";
    for (let i = 0; i < len; i += 1) out += alphabet[this.int(0, alphabet.length - 1)];
    return out;
  }
  asciiToken(len: number): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";
    let out = "";
    for (let i = 0; i < len; i += 1) out += alphabet[this.int(0, alphabet.length - 1)];
    return out;
  }
}

/** Per-iteration seed from the master seed (splitmix-style, replayable alone). */
function iterationSeed(master: number, iteration: number): number {
  let z = (master + Math.imul(iteration + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

// ── Constants mirrored from the production contract (INFERRED from index.ts) ─

const MAX_JSON_BODY_BYTES = 5_000_000;
const BILLING_SYNC_LIMIT = 10;
const BILLING_SYNC_WINDOW_SECONDS = 60;
const PREMIUM_ENTITLEMENT_KEYS = ["pickle_sensei_pro", "premium"] as const;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BAD_INPUT_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 429]);
const GENERIC_5XX_MESSAGES = new Set([
  "Billing verification is temporarily unavailable. Please try again.",
  "Access state is temporarily unavailable. Please try again.",
  "Session verification is temporarily unavailable. Please try again.",
  "Something went wrong. Please try again.",
  "The billing provider could not be reached to verify membership. Try again shortly.",
  "Billing verification is not configured on the server.",
]);
const SECRETS = ["sk_test_revenuecat", "service-role-test-key"];
const STACK_TRACE_RE =
  /(\bat\s+\S+\s*\(|\.ts:\d+|node_modules|TypeError|ReferenceError|SyntaxError|PGRST\d|\b42501\b|\b2350[0-9]\b|\b22P02\b|violates|constraint|relation "|syntax error|is not a function|Cannot read|undefined is not)/;

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// ── Scenario model ──────────────────────────────────────────────────────────

type AuthKind =
  | "provider_google"
  | "provider_apple"
  | "provider_expired"
  | "provider_no_sub"
  | "provider_sub_not_string"
  | "session"
  | "session_expired"
  | "session_no_exp"
  | "cached_reuse"
  | "unknown_issuer"
  | "not_jwt"
  | "two_segments"
  | "four_segments"
  | "payload_not_json"
  | "payload_array"
  | "empty_bearer"
  | "lowercase_bearer"
  | "basic"
  | "huge_token"
  | "latin1_token"
  | "missing";

type GotrueMode =
  "ok" | "refuse" | "outage_500" | "outage_garbage" | "outage_throw" | "no_provider";

interface RcShape {
  kind: "ok" | "http" | "nonjson" | "throw" | "no_subscriber" | "subscriber_not_record";
  status: number;
  subscriber: unknown;
  note: string;
}

type UpsertMode = "ok" | "pg_error_4xx" | "pg_error_5xx" | "nonjson_500" | "nonjson_200" | "throw";
type RpcMode =
  | "ok"
  | "empty"
  | "null"
  | "object"
  | "error_4xx"
  | "error_5xx"
  | "nonjson"
  | "throw"
  | "weird_types";

interface AccessRow {
  premium: unknown;
  scored_count: unknown;
  reserved_count: unknown;
}

interface Oracle {
  premium: boolean;
  productKey: string | null;
  expiresAt: string | null;
  activeEntitlements: string[];
}

interface Scenario {
  seed: number;
  iteration: number;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  headerNotes: string[];
  bodyKind: string;
  body: BodyInit | null;
  authKind: AuthKind;
  /** The user the bearer stands for (null when it cannot authenticate). */
  user: string | null;
  token: string | null;
  gotrue: GotrueMode;
  rc: RcShape;
  upsert: UpsertMode;
  rpc: RpcMode;
  row: AccessRow;
  canary: string;
  /** Oracle verdict from the RevenueCat shape (null → provider unreachable). */
  oracle: Oracle | null;
}

interface Expectation {
  statuses: number[];
  /** "none" | "one" — writes to billing_entitlements. */
  writes: "none" | "one";
  rcCalls: 0 | 1;
  reason: string;
  /** True when a 5xx here is upstream-induced by design of this iteration. */
  upstreamFault: boolean;
  reachesRoute: boolean;
}

interface Outcome {
  seed: number;
  iteration: number;
  request: {
    method: string;
    path: string;
    query: string;
    auth: AuthKind;
    user: string | null;
    headers: string[];
    body: string;
  };
  upstream: {
    gotrue: GotrueMode;
    rc: string;
    upsert: UpsertMode;
    rpc: RpcMode;
    row: AccessRow;
  };
  expected: Expectation;
  status: number;
  requestId: string | null;
  writes: number;
  rcCalls: number;
  durationMs: number;
  verdict: "HELD" | "BROKEN";
  failures: string[];
  bucketStraddle: boolean;
  /** Function-log lines of a BROKEN iteration (the 5xx detail lives only there). */
  logExcerpt?: string[];
  replay: string;
}

// ── Token minting ───────────────────────────────────────────────────────────

function jwt(payload: unknown, segments = 3): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = typeof payload === "string" ? b64url(payload) : b64url(JSON.stringify(payload));
  const parts = [header, body, "sig", "extra"].slice(0, segments);
  return parts.join(".");
}

function providerToken(
  rng: Rng,
  sub: unknown,
  issuer: string,
  expOffsetSeconds: number,
  extra: Record<string, unknown> = {},
): string {
  const payload: Record<string, unknown> = {
    iss: issuer,
    aud: "com.picklesensei",
    exp: Math.floor(Date.now() / 1000) + expOffsetSeconds,
    iat: Math.floor(Date.now() / 1000) - 5,
    nonce: rng.asciiToken(12),
    ...extra,
  };
  if (sub !== undefined) payload.sub = sub;
  return jwt(payload);
}

function sessionToken(rng: Rng, sub: string, expOffsetSeconds: number | null): string {
  const payload: Record<string, unknown> = {
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    aud: "authenticated",
    role: "authenticated",
    session_id: rng.uuid(),
    iat: Math.floor(Date.now() / 1000) - 5,
  };
  if (expOffsetSeconds !== null) payload.exp = Math.floor(Date.now() / 1000) + expOffsetSeconds;
  return jwt(payload);
}

// ── Generators ──────────────────────────────────────────────────────────────

const USER_POOL_SIZE = 640;
const IP_POOL = [
  ...Array.from({ length: 24 }, (_, i) => `203.0.113.${100 + i}`),
  "2001:db8::1",
  "2001:db8:0:0:0:0:0:2",
  "::ffff:198.51.100.7",
  "10.0.0.1, 203.0.113.250",
  "198.51.100.1, 198.51.100.2, 198.51.100.3",
  "unknown",
  "",
  "  ",
  ",,,",
  "not an ip at all",
];

function userFromPool(rng: Rng, master: number): string {
  // Deterministic pool: the k-th user is derived from the master seed only,
  // so a replayed iteration talks about the same user as the campaign did.
  const k = rng.int(0, USER_POOL_SIZE - 1);
  return new Rng(iterationSeed(master ^ 0x5eed, k)).uuid();
}

function genPath(rng: Rng): { path: string; query: string; note: string } {
  const long = "a".repeat(rng.int(1024, 8192));
  const variants: ReadonlyArray<readonly [number, string]> = [
    [40, "/functions/v1/api/v1/billing/sync"],
    [6, "/api/v1/billing/sync"],
    [6, "/v1/billing/sync"],
    [3, "/functions/v1/api/v1/billing/sync/"],
    [3, "/functions/v1/api//v1/billing/sync"],
    [3, "/functions/v1/api/v1//billing/sync"],
    [3, "/functions/v1/api/v1/billing//sync"],
    [3, "/functions/v1/api/v1/Billing/sync"],
    [3, "/functions/v1/api/v1/billing/SYNC"],
    [3, "/functions/v1/api/v1/billing/sync%20"],
    [3, "/functions/v1/api/v1/billing/%73ync"],
    [3, "/functions/v1/api/v1/billing/sync;jsessionid=1"],
    [3, "/functions/v1/api/v1/billing/./sync"],
    [3, "/functions/v1/api/v1/billing/x/../sync"],
    [3, "/functions/v1/api/v1/billing/sync/../sync"],
    [3, "/functions/v1/api/v1/billing/sync/../../healthz"],
    [3, "/functions/v1/api/v1/billing/sync/../../../webhooks/revenuecat"],
    [3, "/functions/v1/api/v1/billing/sync/v1/billing/sync"],
    [3, "/functions/v1/api/v1/x/v1/billing/sync"],
    [3, "/functions/v1/api/v1/billing/sync%00"],
    [3, "/functions/v1/api/v1/billing/sync%zz"],
    [3, "/functions/v1/api/v1/billing/sync%2F"],
    [3, "/functions/v1/api/v1/billing%2Fsync"],
    [3, "/functions/v1/api/v1/billing/sync\u2713"],
    [3, "/functions/v1/api/v1/billing/sync/" + long],
    [3, "/functions/v1/api/v1/" + long + "/v1/billing/sync"],
    [2, "/functions/v1/api/v1/billing"],
    [2, "/functions/v1/api/v1/billing/sync/extra"],
    [2, "/functions/v1/api/v1/billing/sync/1"],
    [2, "/functions/v1/api/billing/sync"],
    [2, "/functions/v1/api/v2/billing/sync"],
    [2, "/functions/v1/api/v1/billing/sync\\"],
    [2, "/functions/v1/api/v1/billing/sync."],
  ];
  const path = rng.weighted(variants);
  const queries: ReadonlyArray<readonly [number, string]> = [
    [50, ""],
    [5, "?"],
    [5, "?a=1"],
    [5, `?user_id=${TEST_USER_ID}`],
    [5, "?premium=true&expires_at=null"],
    [5, "?on_conflict=user_id&select=*"],
    [3, "?a=1&a=2&a=3"],
    [3, "?__proto__=polluted&constructor=x"],
    [3, "?%zz%"],
    [3, "?" + "q=" + "x".repeat(rng.int(1000, 8000))],
    [3, "?apikey=service-role-test-key"],
    [2, "#fragment"],
    [2, "?%00=%00"],
    [2, "?\u00e9=\u00ff"],
  ];
  const query = rng.weighted(queries);
  return { path, query, note: `${path}${query}` };
}

function genMethod(rng: Rng): string {
  return rng.weighted<string>([
    [82, "POST"],
    [3, "GET"],
    [2, "HEAD"],
    [3, "PUT"],
    [3, "PATCH"],
    [3, "DELETE"],
    [2, "OPTIONS"],
    [1, "PROPFIND"],
    [1, "post"],
  ]);
}

function genBody(rng: Rng): { kind: string; body: BodyInit | null; contentType: string | null } {
  const kind = rng.weighted<string>([
    [30, "none"],
    [8, "empty"],
    [10, "json_object"],
    [6, "json_array"],
    [4, "json_null"],
    [4, "json_number"],
    [4, "json_string"],
    [8, "invalid_json"],
    [4, "deep_json"],
    [4, "large_json_256k"],
    [3, "binary"],
    [3, "invalid_utf8"],
    [3, "form"],
    [3, "multipart"],
    [3, "stream"],
    [3, "stream_error"],
  ]);
  switch (kind) {
    case "none":
      return { kind, body: null, contentType: null };
    case "empty":
      return { kind, body: "", contentType: "application/json" };
    case "json_object":
      return {
        kind,
        body: JSON.stringify({
          userId: rng.uuid(),
          premium: rng.chance(0.5),
          entitlements: { pickle_sensei_pro: { expires_date: null } },
          appUserId: rng.asciiToken(rng.int(0, 64)),
          __proto__: { polluted: true },
          nested: { a: [1, 2, { b: "c" }] },
        }),
        contentType: "application/json",
      };
    case "json_array":
      return { kind, body: JSON.stringify([1, "two", null, {}]), contentType: "application/json" };
    case "json_null":
      return { kind, body: "null", contentType: "application/json" };
    case "json_number":
      return { kind, body: "1e309", contentType: "application/json" };
    case "json_string":
      return {
        kind,
        body: JSON.stringify("x".repeat(rng.int(0, 512))),
        contentType: "application/json",
      };
    case "invalid_json":
      return {
        kind,
        body: rng.pick(["{", '{"a":', "{'a':1}", "\u0000\u0001", '{"a":1}}}}', "\ufeff{}", "//"]),
        contentType: "application/json",
      };
    case "deep_json": {
      const depth = rng.int(64, 512);
      return {
        kind,
        body: "[".repeat(depth) + "]".repeat(depth),
        contentType: "application/json",
      };
    }
    case "large_json_256k":
      return {
        kind,
        body: JSON.stringify({ pad: "p".repeat(rng.int(64_000, 262_144)) }),
        contentType: "application/json",
      };
    case "binary":
      return {
        kind,
        body: crypto.getRandomValues(new Uint8Array(rng.int(1, 4096))),
        contentType: "application/octet-stream",
      };
    case "invalid_utf8":
      return {
        kind,
        body: new Uint8Array([0xff, 0xfe, 0xc0, 0x80, 0xed, 0xa0, 0x80]),
        contentType: "application/json",
      };
    case "form":
      return {
        kind,
        body: "premium=true&user_id=" + rng.uuid(),
        contentType: "application/x-www-form-urlencoded",
      };
    case "multipart":
      return {
        kind,
        body: '--b\r\nContent-Disposition: form-data; name="x"\r\n\r\ny\r\n--b--\r\n',
        contentType: "multipart/form-data; boundary=b",
      };
    case "stream": {
      const chunks = rng.int(1, 8);
      let sent = 0;
      return {
        kind,
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= chunks) return controller.close();
            sent += 1;
            controller.enqueue(new TextEncoder().encode('{"chunk":' + sent + "}"));
          },
        }),
        contentType: "application/json",
      };
    }
    case "stream_error":
      return {
        kind,
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("client stream aborted"));
          },
        }),
        contentType: "application/json",
      };
    default:
      return { kind: "none", body: null, contentType: null };
  }
}

interface AuthChoice {
  kind: AuthKind;
  user: string | null;
  token: string | null;
  header: string | null;
}

function genAuth(
  rng: Rng,
  master: number,
  cache: Array<{ token: string; user: string }>,
): AuthChoice {
  const user = userFromPool(rng, master);
  const kind = rng.weighted<AuthKind>([
    [34, "provider_google"],
    [10, "provider_apple"],
    [16, "session"],
    [8, "cached_reuse"],
    [3, "provider_expired"],
    [2, "provider_no_sub"],
    [2, "provider_sub_not_string"],
    [3, "session_expired"],
    [2, "session_no_exp"],
    [3, "unknown_issuer"],
    [3, "not_jwt"],
    [1, "two_segments"],
    [1, "four_segments"],
    [1, "payload_not_json"],
    [1, "payload_array"],
    [2, "empty_bearer"],
    [1, "lowercase_bearer"],
    [1, "basic"],
    [1, "huge_token"],
    [1, "latin1_token"],
    [4, "missing"],
  ]);
  const bearer = (token: string): AuthChoice => ({ kind, user, token, header: `Bearer ${token}` });
  switch (kind) {
    case "provider_google":
      return bearer(providerToken(rng, user, "https://accounts.google.com", 3600));
    case "provider_apple":
      return bearer(providerToken(rng, user, "https://appleid.apple.com", 3600));
    case "provider_expired":
      return {
        ...bearer(providerToken(rng, user, "https://accounts.google.com", -rng.int(1, 100_000))),
        user: null,
      };
    case "provider_no_sub":
      return { ...bearer(providerToken(rng, undefined, "accounts.google.com", 3600)), user: null };
    case "provider_sub_not_string":
      return {
        ...bearer(
          providerToken(
            rng,
            rng.pick([123, null, { id: user }, ["x"]]),
            "https://accounts.google.com",
            3600,
          ),
        ),
        user: null,
      };
    case "session":
      return bearer(sessionToken(rng, user, 3600));
    case "session_no_exp":
      return bearer(sessionToken(rng, user, null));
    case "session_expired":
      return { ...bearer(sessionToken(rng, user, -rng.int(1, 100_000))), user: null };
    case "cached_reuse": {
      if (cache.length === 0)
        return bearer(providerToken(rng, user, "https://accounts.google.com", 3600));
      const hit = cache[rng.int(0, cache.length - 1)];
      return { kind, user: hit.user, token: hit.token, header: `Bearer ${hit.token}` };
    }
    case "unknown_issuer":
      return {
        ...bearer(
          providerToken(
            rng,
            user,
            rng.pick([
              "https://evil.example.com",
              "https://accounts.google.com.evil.example",
              "https://supabase.test/auth/v1/",
              "https://supabase.test/auth/v2",
              "",
              "accounts.google.com ",
            ]),
            3600,
          ),
        ),
        user: null,
      };
    case "not_jwt":
      return {
        ...bearer(rng.pick(["not-a-jwt", rng.asciiToken(40), "..", ".", "null"])),
        user: null,
      };
    case "two_segments":
      return {
        ...bearer(jwt({ iss: "https://accounts.google.com", sub: user, exp: 9_999_999_999 }, 2)),
        user: null,
      };
    case "four_segments":
      return {
        ...bearer(jwt({ iss: "https://accounts.google.com", sub: user, exp: 9_999_999_999 }, 4)),
        user: null,
      };
    case "payload_not_json":
      return { ...bearer(jwt("this is not json")), user: null };
    case "payload_array":
      return { ...bearer(jwt(["https://accounts.google.com", user])), user: null };
    case "empty_bearer":
      return { kind, user: null, token: "", header: rng.pick(["Bearer ", "Bearer", "Bearer   "]) };
    case "lowercase_bearer":
      return {
        kind,
        user: null,
        token: null,
        header: `bearer ${providerToken(rng, user, "https://accounts.google.com", 3600)}`,
      };
    case "basic":
      return { kind, user: null, token: null, header: `Basic ${btoa(`${user}:x`)}` };
    case "huge_token":
      return bearer(
        jwt({
          iss: "https://accounts.google.com",
          sub: user,
          pad: "x".repeat(rng.int(16_000, 64_000)),
        }),
      );
    case "latin1_token":
      return { ...bearer(rng.byteString(rng.int(20, 200))), user: null };
    case "missing":
    default:
      return { kind: "missing", user: null, token: null, header: null };
  }
}

function genGotrue(rng: Rng): GotrueMode {
  return rng.weighted<GotrueMode>([
    [80, "ok"],
    [6, "refuse"],
    [5, "outage_500"],
    [4, "outage_garbage"],
    [3, "outage_throw"],
    [2, "no_provider"],
  ]);
}

function genExpiresDate(rng: Rng): unknown {
  const now = Date.now();
  const hour = 3_600_000;
  return rng.weighted<unknown>([
    [20, null],
    [25, new Date(now + rng.int(1, 365 * 24) * hour).toISOString()],
    [15, new Date(now - rng.int(1, 365 * 24) * hour).toISOString()],
    [4, new Date(now + 6 * hour).toISOString().replace("Z", "+00:00")],
    [3, new Date(now + 6 * hour).toISOString().slice(0, 19)],
    [3, "2030-01-01"],
    [3, "1970-01-01T00:00:00Z"],
    [3, "9999-12-31T23:59:59Z"],
    [3, "+275760-09-13T00:00:00.000Z"],
    [3, "not a date"],
    [3, ""],
    [3, now + 6 * hour],
    [2, String(now + 6 * hour)],
    [2, true],
    [2, { expires: "2030-01-01" }],
    [2, ["2030-01-01T00:00:00Z"]],
    [2, "0000-00-00T00:00:00Z"],
    [2, " " + new Date(now + 6 * hour).toISOString()],
  ]);
}

function genEntitlement(rng: Rng): unknown {
  return rng.weighted<unknown>([
    [
      70,
      {
        expires_date: genExpiresDate(rng),
        product_identifier: rng.weighted<unknown>([
          [
            60,
            rng.pick([
              "pickle_sensei_pro_monthly",
              "pickle_sensei_pro_annual",
              "pickle_sensei_pro_lifetime",
            ]),
          ],
          [10, null],
          [10, 42],
          [10, "x".repeat(rng.int(0, 512))],
          [10, { sku: "y" }],
        ]),
        purchase_date: "2026-01-01T00:00:00Z",
        grace_period_expires_date: rng.chance(0.3) ? "2030-01-01T00:00:00Z" : null,
      },
    ],
    [10, { product_identifier: "no-expiry-key" }],
    [10, null],
    [5, "active"],
    [5, ["x"]],
  ]);
}

function genRc(rng: Rng, canary: string): RcShape {
  const kind = rng.weighted<RcShape["kind"]>([
    [64, "ok"],
    [14, "http"],
    [6, "nonjson"],
    [6, "throw"],
    [5, "no_subscriber"],
    [5, "subscriber_not_record"],
  ]);
  if (kind === "http") {
    const status = rng.pick([400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]);
    return { kind, status, subscriber: null, note: `http_${status}` };
  }
  if (kind === "nonjson") return { kind, status: 200, subscriber: null, note: "nonjson_200" };
  if (kind === "throw") return { kind, status: 0, subscriber: null, note: "fetch_throws" };
  if (kind === "no_subscriber")
    return { kind, status: 200, subscriber: undefined, note: "no_subscriber_key" };
  if (kind === "subscriber_not_record") {
    return {
      kind,
      status: 200,
      subscriber: rng.pick([null, "sub", 7, ["a"], true]),
      note: "subscriber_not_record",
    };
  }
  const entitlementsShape = rng.weighted<string>([
    [70, "record"],
    [8, "empty"],
    [6, "missing"],
    [6, "array"],
    [5, "null"],
    [5, "string"],
  ]);
  let entitlements: unknown;
  if (entitlementsShape === "record") {
    const map: Record<string, unknown> = {};
    if (rng.chance(0.7)) map.pickle_sensei_pro = genEntitlement(rng);
    if (rng.chance(0.3)) map.premium = genEntitlement(rng);
    if (rng.chance(0.3))
      map[
        rng.pick(["Pickle_Sensei_Pro", "PREMIUM", "pro", "pickle_sensei_pro ", "premium\u0000"])
      ] = genEntitlement(rng);
    if (rng.chance(0.15)) {
      // An OWN "__proto__" key on the wire (plain assignment would only set the
      // prototype and never serialise).
      Object.defineProperty(map, "__proto__", {
        value: { expires_date: null, product_identifier: "polluted" },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (rng.chance(0.1))
      for (let i = 0; i < rng.int(50, 400); i += 1) map[`junk_${i}`] = genEntitlement(rng);
    entitlements = map;
  } else if (entitlementsShape === "empty") entitlements = {};
  else if (entitlementsShape === "array")
    entitlements = [{ id: "pickle_sensei_pro", expires_date: null }];
  else if (entitlementsShape === "null") entitlements = null;
  else if (entitlementsShape === "string") entitlements = "pickle_sensei_pro";
  const subscriber: Record<string, unknown> = {
    original_app_user_id: canary,
    subscriptions: {},
    non_subscriptions: {},
  };
  if (entitlementsShape !== "missing") subscriber.entitlements = entitlements;
  return { kind, status: rng.chance(0.9) ? 200 : 201, subscriber, note: `ok_${entitlementsShape}` };
}

/** Independent re-statement of the entitlement rule (the oracle): an
 * entitlement in PREMIUM_ENTITLEMENT_KEYS is active when its record's
 * expires_date is null or a parseable date in the future; the first active
 * one names the product and expiry. */
function oracleVerdict(rc: RcShape): Oracle | null {
  if (rc.kind !== "ok" || !isRecord(rc.subscriber)) return null;
  const map = isRecord(rc.subscriber.entitlements) ? rc.subscriber.entitlements : {};
  const oracle: Oracle = {
    premium: false,
    productKey: null,
    expiresAt: null,
    activeEntitlements: [],
  };
  for (const key of PREMIUM_ENTITLEMENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
    const ent = map[key];
    if (!isRecord(ent)) continue;
    const expires = ent.expires_date;
    const active =
      expires === null ||
      (typeof expires === "string" &&
        Number.isFinite(Date.parse(expires)) &&
        Date.parse(expires) > Date.now());
    if (!active) continue;
    oracle.activeEntitlements.push(key);
    if (!oracle.premium) {
      oracle.premium = true;
      oracle.productKey =
        typeof ent.product_identifier === "string" ? ent.product_identifier : null;
      oracle.expiresAt = typeof expires === "string" ? expires : null;
    }
  }
  return oracle;
}

function genRow(rng: Rng, mode: RpcMode): AccessRow {
  if (mode === "weird_types") {
    return {
      premium: rng.pick(["true", 1, null, "false", {}]),
      scored_count: rng.pick(["2", -1, 1e21, null, "abc", 2.5, true]),
      reserved_count: rng.pick(["1", -3, null, 99, "x"]),
    };
  }
  return {
    premium: rng.chance(0.3),
    scored_count: rng.weighted<number>([
      [40, 0],
      [20, 1],
      [20, 2],
      [10, rng.int(3, 50)],
      [10, 2_147_483_647],
    ]),
    reserved_count: rng.weighted<number>([
      [60, 0],
      [20, 1],
      [10, 2],
      [10, rng.int(3, 24)],
    ]),
  };
}

function genHeaders(
  rng: Rng,
  auth: AuthChoice,
  contentType: string | null,
  bodyKind: string,
): { headers: Record<string, string>; notes: string[] } {
  const headers: Record<string, string> = {};
  const notes: string[] = [];
  if (auth.header !== null) headers["Authorization"] = auth.header;
  const ipMode = rng.weighted<string>([
    [80, "xff"],
    [8, "cf"],
    [6, "both"],
    [6, "none"],
  ]);
  // Mostly one client per IP (so the per-IP auth-failure budget does not mask
  // the oracle), sometimes a shared/odd pool address to exercise that budget.
  const ipValue = () =>
    rng.chance(0.75) ? `198.18.${rng.int(0, 255)}.${rng.int(1, 254)}` : rng.pick(IP_POOL);
  if (ipMode === "xff" || ipMode === "both") headers["x-forwarded-for"] = ipValue();
  if (ipMode === "cf" || ipMode === "both") headers["cf-connecting-ip"] = ipValue();
  notes.push(`ip:${ipMode}`);
  if (contentType !== null) {
    const ct = rng.weighted<string>([
      [70, contentType],
      [8, "text/plain"],
      [6, "application/json; charset=utf-8"],
      [6, "APPLICATION/JSON"],
      [4, "application/xml"],
      [3, ""],
      [3, rng.byteString(rng.int(1, 200))],
    ]);
    headers["Content-Type"] = ct;
    notes.push(`ct:${ct.slice(0, 30)}`);
  }
  const clMode = rng.weighted<string>([
    [70, "absent"],
    [4, "zero"],
    [4, "exact_limit"],
    [6, "over_limit"],
    [3, "exponent"],
    [2, "infinity"],
    [2, "nan"],
    [2, "negative"],
    [2, "huge"],
    [2, "spaces"],
    [3, "small"],
  ]);
  const cl: Record<string, string> = {
    zero: "0",
    exact_limit: String(MAX_JSON_BODY_BYTES),
    over_limit: String(MAX_JSON_BODY_BYTES + rng.int(1, 1_000_000)),
    exponent: "1e9",
    infinity: "Infinity",
    nan: "abc",
    negative: "-1",
    huge: "9".repeat(40),
    spaces: " 6000000 ",
    small: String(rng.int(1, 1000)),
  };
  if (clMode !== "absent") {
    headers["Content-Length"] = cl[clMode];
    notes.push(`cl:${clMode}`);
  }
  const ridMode = rng.weighted<string>([
    [50, "absent"],
    [20, "valid"],
    [5, "short"],
    [5, "long"],
    [5, "invalid_chars"],
    [5, "max_len"],
    [5, "latin1"],
    [5, "spaces"],
  ]);
  const rid: Record<string, string> = {
    valid: rng.asciiToken(rng.int(8, 64)),
    short: rng.asciiToken(rng.int(1, 7)),
    long: rng.asciiToken(rng.int(65, 300)),
    invalid_chars: "req id/" + rng.asciiToken(10) + "<script>",
    max_len: rng.asciiToken(64),
    latin1: rng.byteString(20),
    spaces: "   " + rng.asciiToken(12) + "   ",
  };
  if (ridMode !== "absent") {
    headers["x-request-id"] = rid[ridMode];
    notes.push(`rid:${ridMode}`);
  }
  if (rng.chance(0.15)) {
    headers["Accept"] = rng.pick([
      "application/json",
      "text/html",
      "*/*",
      "application/vnd.pgrst.object+json",
      "",
    ]);
    notes.push("accept");
  }
  if (rng.chance(0.1)) {
    headers["Prefer"] = "resolution=merge-duplicates";
    headers["apikey"] = "service-role-test-key";
    notes.push("client_sends_pgrst_headers");
  }
  if (rng.chance(0.1)) {
    headers["x-" + rng.asciiToken(rng.int(1, 20))] = rng.byteString(rng.int(1, 16_000));
    notes.push("big_extra_header");
  }
  if (rng.chance(0.05)) {
    headers["Origin"] = "https://evil.example";
    headers["Cookie"] = "sb-access-token=" + rng.asciiToken(30);
    notes.push("origin_cookie");
  }
  if (rng.chance(0.05)) {
    headers["Transfer-Encoding"] = "chunked";
    notes.push("te_chunked");
  }
  if (bodyKind === "none" && rng.chance(0.05)) {
    headers["Content-Type"] = "application/json";
    notes.push("ct_without_body");
  }
  return { headers, notes };
}

/** Everything about an iteration derives from its 32-bit seed; `master` only
 * names the user pool (STRESS_SEED must match the campaign when replaying). */
function generate(
  master: number,
  seed: number,
  iteration: number,
  cache: Array<{ token: string; user: string }>,
): Scenario {
  const rng = new Rng(seed);
  const canary = `CANARY-${seed.toString(16)}-${rng.asciiToken(8)}`;
  const method = genMethod(rng);
  const { path, query } = genPath(rng);
  const auth = genAuth(rng, master, cache);
  const body =
    method === "GET" || method === "HEAD"
      ? { kind: "none", body: null, contentType: null }
      : genBody(rng);
  const { headers, notes } = genHeaders(rng, auth, body.contentType, body.kind);
  const gotrue = genGotrue(rng);
  const rc = genRc(rng, canary);
  const upsert = rng.weighted<UpsertMode>([
    [78, "ok"],
    [8, "pg_error_4xx"],
    [5, "pg_error_5xx"],
    [3, "nonjson_500"],
    [2, "nonjson_200"],
    [4, "throw"],
  ]);
  const rpc = rng.weighted<RpcMode>([
    [72, "ok"],
    [5, "empty"],
    [3, "null"],
    [3, "object"],
    [5, "error_4xx"],
    [3, "error_5xx"],
    [3, "nonjson"],
    [3, "throw"],
    [3, "weird_types"],
  ]);
  return {
    seed,
    iteration,
    method,
    path,
    query,
    headers,
    headerNotes: notes,
    bodyKind: body.kind,
    body: body.body,
    authKind: auth.kind,
    user: auth.user,
    token: auth.token,
    gotrue,
    rc,
    upsert,
    rpc,
    row: genRow(rng, rpc),
    canary,
    oracle: oracleVerdict(rc),
  };
}

// ── Expectation (oracle over the router contract) ───────────────────────────

function expectation(s: Scenario): Expectation {
  const url = new URL(`http://edge.test${s.path}${s.query}`);
  const pathname = url.pathname;
  const method = s.method.toUpperCase();
  const isPublicRead = method === "GET" || method === "HEAD";
  const none = (statuses: number[], reason: string, upstreamFault = false): Expectation => ({
    statuses,
    writes: "none",
    rcCalls: 0,
    reason,
    upstreamFault,
    reachesRoute: false,
  });
  if (isPublicRead && /\/(healthz|support|privacy|terms)$/.test(pathname)) {
    return none([200], "public pre-auth page");
  }
  if (method === "POST" && pathname.endsWith("/webhooks/revenuecat")) {
    // Webhook auth is a shared secret the fuzzer never sends → 401.
    return none([401], "webhook route without secret");
  }
  const contentLength = Number(s.headers["Content-Length"] ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    return none([413], "declared content-length over cap");
  }
  const v1 = pathname.lastIndexOf("/v1/");
  const routePath = v1 >= 0 ? pathname.slice(v1) : pathname;
  const route = `${method} ${routePath}`;

  // Authentication.
  const authFails401 = new Set<AuthKind>([
    "provider_expired",
    "provider_no_sub",
    "provider_sub_not_string",
    "session_expired",
    "unknown_issuer",
    "not_jwt",
    "two_segments",
    "four_segments",
    "payload_not_json",
    "payload_array",
    "empty_bearer",
    "lowercase_bearer",
    "basic",
    "latin1_token",
    "missing",
  ]);
  // `huge_token` is a well-formed (oversized) provider JWT: the handler has no
  // bearer-length cap, so it rides the provider-token exchange like the rest.
  if (authFails401.has(s.authKind)) return none([401], `auth ${s.authKind}`);
  const sessionBearer = s.authKind === "session" || s.authKind === "session_no_exp";
  if (s.authKind !== "cached_reuse") {
    if (s.gotrue === "refuse") return none([401], `gotrue ${s.gotrue}`);
    // A session whose GoTrue user carries no OAuth provider is refused; the
    // provider-token exchange ignores this knob.
    if (s.gotrue === "no_provider" && sessionBearer) return none([401], `gotrue ${s.gotrue}`);
    if (s.gotrue.startsWith("outage")) {
      // Session bearers: verification outage → retryable 503. Provider bearers
      // (transitional path): supabase-js folds the failure into a 401.
      if (sessionBearer) return none([503], `gotrue ${s.gotrue} on session bearer`, true);
      return none([401], `gotrue ${s.gotrue} on provider bearer (transitional path)`);
    }
  }
  if (route !== "POST /v1/billing/sync") return none([404], `route ${route} unknown`);

  // Inside the route.
  if (!s.oracle) {
    return {
      statuses: [502],
      writes: "none",
      rcCalls: 1,
      reason: `revenuecat ${s.rc.note}`,
      upstreamFault: true,
      reachesRoute: true,
    };
  }
  if (s.upsert !== "ok") {
    return {
      statuses: [503],
      writes: "one",
      rcCalls: 1,
      reason: `upsert ${s.upsert}`,
      upstreamFault: true,
      reachesRoute: true,
    };
  }
  if (s.rpc !== "ok" && s.rpc !== "weird_types") {
    return {
      statuses: [503],
      writes: "one",
      rcCalls: 1,
      reason: `access_state ${s.rpc}`,
      upstreamFault: true,
      reachesRoute: true,
    };
  }
  return {
    statuses: [200],
    writes: "one",
    rcCalls: 1,
    reason: "accepted",
    upstreamFault: false,
    reachesRoute: true,
  };
}

// ── Upstream fault injection (fetch layer) ──────────────────────────────────

interface Upstream {
  /** Scenario the next fetches belong to (null → delegate to the harness stub). */
  current: Scenario | null;
  /** Postgres-backed PostgREST shim, when configured. */
  pg: PgShim | null;
  /** Harness whose `calls` log receives the intercepted upstream calls too. */
  h: Harness | null;
}

const upstream: Upstream = { current: null, pg: null, h: null };

/** Record an intercepted upstream call in the harness log (the harness stub
 * records the delegated ones itself), then hand back the injected response. */
async function recordCall(request: Request): Promise<void> {
  if (!upstream.h) return;
  const method = request.method;
  const url = request.url;
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const text = method === "GET" || method === "HEAD" ? "" : await request.clone().text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  upstream.h.calls.push({ method, url, headers, body });
}

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

function decodeBearerSub(headers: Headers): unknown {
  const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const segment = token.split(".")[1] ?? "";
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    return JSON.parse(atob(padded)).sub;
  } catch {
    return undefined;
  }
}

function pgrstError(status: number, code: string, message: string): Response {
  return jsonResponse(status, { code, message, details: message, hint: null });
}

async function faultedFetch(
  delegate: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const s = upstream.current;
  if (!s) return delegate(input, init);
  const request = new Request(input, init);
  const url = request.url;
  const canary = s.canary;
  const intercepted =
    url.startsWith(`${SUPABASE_URL}/auth/v1/`) ||
    url.startsWith(RC_URL) ||
    url.startsWith(`${SUPABASE_URL}/rest/v1/`);
  if (!intercepted) return delegate(input, init);
  const answer = async (response: Promise<Response> | Response): Promise<Response> => {
    await recordCall(request);
    return response;
  };
  const fail = async (error: Error): Promise<never> => {
    await recordCall(request);
    throw error;
  };

  // Supabase Auth — provider ID token exchange (transitional bearer path).
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
    const payload = (await request
      .clone()
      .json()
      .catch(() => null)) as unknown;
    const idToken =
      isRecord(payload) && typeof payload.id_token === "string" ? payload.id_token : "";
    const segment = idToken.split(".")[1] ?? "";
    let sub: unknown;
    try {
      const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
      sub = JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4))).sub;
    } catch {
      sub = undefined;
    }
    if (typeof sub !== "string" || !sub) {
      return answer(
        jsonResponse(400, { error: "invalid_grant", error_description: `bad id_token ${canary}` }),
      );
    }
    switch (s.gotrue) {
      case "refuse":
        return answer(
          jsonResponse(400, { error: "invalid_grant", error_description: `refused ${canary}` }),
        );
      case "outage_500":
        return answer(jsonResponse(500, { message: `gotrue down ${canary}` }));
      case "outage_garbage":
        return answer(new Response(`<html>502 ${canary}</html>`, { status: 200 }));
      case "outage_throw":
        return fail(new TypeError(`network down ${canary}`));
      case "no_provider":
      case "ok":
      default:
        return delegate(input, init);
    }
  }
  // Supabase Auth — session bearer verification.
  if (request.method === "GET" && url === `${SUPABASE_URL}/auth/v1/user`) {
    const sub = decodeBearerSub(request.headers);
    switch (s.gotrue) {
      case "refuse":
        return answer(jsonResponse(401, { code: 401, msg: `invalid JWT ${canary}` }));
      case "outage_500":
        return answer(jsonResponse(500, { msg: `gotrue down ${canary}` }));
      case "outage_garbage":
        return answer(new Response(`<html>bad gateway ${canary}</html>`, { status: 200 }));
      case "outage_throw":
        return fail(new TypeError(`network down ${canary}`));
      case "no_provider":
        return answer(
          jsonResponse(200, {
            id: sub,
            email: "u@example.com",
            app_metadata: { provider: "email" },
          }),
        );
      case "ok":
      default:
        return answer(
          jsonResponse(200, {
            id: sub,
            aud: "authenticated",
            role: "authenticated",
            email: "u@example.com",
            app_metadata: { provider: "google", providers: ["google"] },
          }),
        );
    }
  }
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) return delegate(input, init);
  // RevenueCat.
  if (url.startsWith(RC_URL)) {
    switch (s.rc.kind) {
      case "http":
        return answer(
          s.rc.status === 429
            ? jsonResponse(
                429,
                { code: 7000, message: `rate limited ${canary}` },
                { "Retry-After": "7" },
              )
            : jsonResponse(s.rc.status, { code: 7225, message: `rc error ${canary}` }),
        );
      case "nonjson":
        return answer(new Response(`<html>RevenueCat ${canary}</html>`, { status: 200 }));
      case "throw":
        return fail(new TypeError(`connection reset ${canary}`));
      case "no_subscriber":
        return answer(jsonResponse(200, { request_date_ms: Date.now(), note: canary }));
      case "subscriber_not_record":
        return answer(
          jsonResponse(200, { request_date_ms: Date.now(), subscriber: s.rc.subscriber }),
        );
      case "ok":
      default:
        return answer(
          jsonResponse(s.rc.status, { request_date_ms: Date.now(), subscriber: s.rc.subscriber }),
        );
    }
  }
  // PostgREST — billing_entitlements upsert (service role).
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/billing_entitlements`)) {
    if (upstream.pg && s.upsert === "ok") return answer(upstream.pg.upsert(request.clone()));
    switch (s.upsert) {
      case "pg_error_4xx":
        return answer(
          pgrstError(403, "42501", `permission denied for table billing_entitlements ${canary}`),
        );
      case "pg_error_5xx":
        return answer(pgrstError(500, "XX000", `internal error ${canary}`));
      case "nonjson_500":
        return answer(
          new Response(`<html>upstream request timeout ${canary}</html>`, { status: 500 }),
        );
      case "nonjson_200":
        return answer(new Response(`<html>${canary}</html>`, { status: 200 }));
      case "throw":
        return fail(new TypeError(`connection refused ${canary}`));
      case "ok":
      default:
        return delegate(input, init);
    }
  }
  // PostgREST — access_state() RPC (user scoped).
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/access_state`)) {
    if (upstream.pg && (s.rpc === "ok" || s.rpc === "weird_types")) {
      return answer(upstream.pg.accessState(request.clone()));
    }
    switch (s.rpc) {
      case "empty":
        return answer(jsonResponse(200, []));
      case "null":
        return answer(jsonResponse(200, null));
      case "object":
        return answer(jsonResponse(200, { premium: false, scored_count: 0, reserved_count: 0 }));
      case "error_4xx":
        return answer(
          pgrstError(401, "42501", `permission denied for function access_state ${canary}`),
        );
      case "error_5xx":
        return answer(pgrstError(503, "57P03", `the database system is starting up ${canary}`));
      case "nonjson":
        return answer(new Response(`not json ${canary}`, { status: 200 }));
      case "throw":
        return fail(new TypeError(`socket hang up ${canary}`));
      case "ok":
      case "weird_types":
      default:
        return answer(jsonResponse(200, [s.row]));
    }
  }
  return delegate(input, init);
}

// ── Postgres-backed PostgREST shim ──────────────────────────────────────────

/** Translates the two PostgREST calls the route makes into SQL against a real
 * Postgres with every migration applied, mirroring PostgREST's role model:
 * the service-role upsert runs as `service_role`, the RPC as `authenticated`
 * with `request.jwt.claim.sub` set from the bearer. Postgres errors come back
 * in PostgREST's error JSON with PostgREST's status mapping. */
class PgShim {
  readonly sql: ReturnType<typeof postgres>;
  constructor(url: string) {
    this.sql = postgres(url, { max: 4, onnotice: () => undefined });
  }

  private static statusFor(code: string): number {
    if (code === "42501") return 403;
    if (code.startsWith("23")) return 409;
    if (code.startsWith("22")) return 400;
    if (code === "PGRST102") return 400;
    return 500;
  }

  private static errorResponse(error: unknown): Response {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "XX000";
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse(PgShim.statusFor(code), { code, message, details: null, hint: null });
  }

  async upsert(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams;
    if (query.get("on_conflict") !== "user_id") {
      return jsonResponse(400, { code: "PGRST102", message: "unexpected on_conflict" });
    }
    if (request.headers.get("authorization") !== "Bearer service-role-test-key") {
      return pgrstError(401, "PGRST301", "not the service role");
    }
    const row = (await request.json().catch(() => null)) as unknown;
    if (!isRecord(row))
      return jsonResponse(400, { code: "PGRST102", message: "body is not a row" });
    try {
      await this.sql.begin(async (tx) => {
        await tx.unsafe("set local role service_role");
        await tx.unsafe(
          `insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
           values ($1, $2, $3, $4, $5)
           on conflict (user_id) do update set
             premium = excluded.premium,
             product_key = excluded.product_key,
             expires_at = excluded.expires_at,
             verified_at = excluded.verified_at`,
          [
            row.user_id as string,
            row.premium as boolean,
            (row.product_key as string | null) ?? null,
            (row.expires_at as string | null) ?? null,
            row.verified_at as string,
          ],
        );
      });
    } catch (error) {
      return PgShim.errorResponse(error);
    }
    return new Response(null, { status: 201 });
  }

  async accessState(request: Request): Promise<Response> {
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    // The harness mints `session-for-<sub>` access tokens for provider bearers;
    // session bearers carry their sub in the JWT payload.
    const sub = token.startsWith("session-for-")
      ? token.slice("session-for-".length)
      : decodeBearerSub(request.headers);
    try {
      const rows = await this.sql.begin(async (tx) => {
        await tx.unsafe("set local role authenticated");
        await tx.unsafe("select set_config('request.jwt.claim.sub', $1, true)", [
          String(sub ?? ""),
        ]);
        return await tx.unsafe(
          "select premium, scored_count, reserved_count from public.access_state()",
        );
      });
      return jsonResponse(200, rows);
    } catch (error) {
      return PgShim.errorResponse(error);
    }
  }

  /** Rerun-safe against a persistent database: the user is recreated from
   * scratch (every owned row cascades from auth.users) before seeding. */
  async seedUser(userId: string, scoredShots: number): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx.unsafe(`delete from auth.users where id = $1`, [userId]);
      await tx.unsafe(
        `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
        [userId, `${userId}@example.com`],
      );
      await tx.unsafe(
        `insert into public.profiles (id, email) values ($1, $2) on conflict (id) do nothing`,
        [userId, `${userId}@example.com`],
      );
      for (let i = 0; i < scoredShots; i += 1) {
        await tx.unsafe(
          `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
             overall_score, analysis_confidence, result_kind,
             app_version, model_bundle_version, pose_model_version, paddle_model_version,
             stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
           values (gen_random_uuid(), $1, 'dink', 'side', now(), 0, 100, 200, 7.0, 0.9, 'scored',
             'stress', 'stress', 'stress', 'stress', 'stress', 'stress', 'stress', 'stress')`,
          [userId],
        );
      }
    });
  }

  async entitlementRows(userId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.sql.unsafe(
      `select user_id::text, premium, product_key, expires_at, verified_at from public.billing_entitlements where user_id = $1`,
      [userId],
    );
    return rows as unknown as Array<Record<string, unknown>>;
  }

  async scoredCount(userId: string): Promise<number> {
    const rows = await this.sql.unsafe(
      `select count(*)::int as n from public.shots where user_id = $1 and result_kind = 'scored'`,
      [userId],
    );
    return Number(rows[0].n);
  }

  end(): Promise<void> {
    return this.sql.end();
  }
}

// ── Running one iteration ───────────────────────────────────────────────────

interface Captured {
  logs: string[];
  restore: () => void;
}

function captureConsole(): Captured {
  const logs: string[] = [];
  const original = { error: console.error, warn: console.warn, log: console.log };
  const sink =
    (level: string) =>
    (...args: unknown[]) => {
      logs.push(
        `${level} ${args.map((a) => (typeof a === "string" ? a : (JSON.stringify(a) ?? String(a)))).join(" ")}`,
      );
    };
  console.error = sink("error");
  console.warn = sink("warn");
  console.log = sink("log");
  const restoreAccess = captureAccessLog((line) => logs.push(`access ${line}`));
  return {
    logs,
    restore() {
      console.error = original.error;
      console.warn = original.warn;
      console.log = original.log;
      restoreAccess();
    },
  };
}

function bucketOf(windowSeconds: number): number {
  return Math.floor(Date.now() / (windowSeconds * 1_000));
}

function buildRequest(s: Scenario): Request | null {
  const init: RequestInit & { duplex?: "half" } = { method: s.method, headers: s.headers };
  if (s.body !== null) {
    init.body = s.body;
    if (s.body instanceof ReadableStream) init.duplex = "half";
  }
  try {
    return new Request(`http://edge.test${s.path}${s.query}`, init);
  } catch {
    return null;
  }
}

interface RunContext {
  h: Harness;
  master: number;
  cache: Array<{ token: string; user: string }>;
  /** (user, bucket) → syncs the route admitted (200/502/503). */
  admitted: Map<string, number>;
  logs: string[];
  pgSeeded: Set<string> | null;
}

async function runIteration(ctx: RunContext, s: Scenario): Promise<Outcome> {
  const { h } = ctx;
  const expected = expectation(s);
  const request = buildRequest(s);
  const replay = `STRESS_REPLAY=${s.seed} STRESS_SEED=${ctx.master} deno test -A --no-check --config deno.json stress_billing_sync_fuzz_boundary.test.ts`;
  const base = {
    seed: s.seed,
    iteration: s.iteration,
    request: {
      method: s.method,
      path: s.path,
      query: s.query,
      auth: s.authKind,
      user: s.user,
      headers: s.headerNotes,
      body: s.bodyKind,
    },
    upstream: { gotrue: s.gotrue, rc: s.rc.note, upsert: s.upsert, rpc: s.rpc, row: s.row },
    expected,
    replay,
  };
  if (!request) {
    // The platform's Request constructor refused the shape (not a handler
    // outcome): recorded, not counted as an executed scenario.
    return {
      ...base,
      status: -1,
      requestId: null,
      writes: 0,
      rcCalls: 0,
      durationMs: 0,
      verdict: "HELD",
      failures: ["not_executed: Request constructor refused the input"],
      bucketStraddle: false,
    };
  }

  const failures: string[] = [];
  const callsBefore = h.calls.length;
  const logsBefore = ctx.logs.length;
  const bucketBefore = bucketOf(BILLING_SYNC_WINDOW_SECONDS);
  const t0 = Date.now();
  upstream.current = s;
  let response: Response;
  try {
    response = await h.handler(request);
  } catch (error) {
    upstream.current = null;
    failures.push(`handler threw: ${error instanceof Error ? error.message : String(error)}`);
    return {
      ...base,
      status: 0,
      requestId: null,
      writes: 0,
      rcCalls: 0,
      durationMs: Date.now() - t0,
      verdict: "BROKEN",
      failures,
      bucketStraddle: false,
    };
  }
  upstream.current = null;
  const durationMs = Date.now() - t0;
  const bucketStraddle = bucketOf(BILLING_SYNC_WINDOW_SECONDS) !== bucketBefore;
  const bodyText = await response.text();
  const calls = h.calls.slice(callsBefore);
  const writes = calls.filter((c) => c.url.includes("/rest/v1/billing_entitlements"));
  const rcCalls = calls.filter((c) => c.url.startsWith(RC_URL));
  const iterationLogs = ctx.logs.slice(logsBefore);
  const status = response.status;
  const requestId = response.headers.get("x-request-id");

  // ── Universal invariants.
  if (!requestId) failures.push("request-id missing");
  else {
    const incoming = (s.headers["x-request-id"] ?? "").trim();
    if (REQUEST_ID_RE.test(incoming)) {
      if (requestId !== incoming)
        failures.push(`request-id not echoed: sent ${incoming} got ${requestId}`);
    } else if (!UUID_RE.test(requestId))
      failures.push(`minted request-id not a uuid: ${requestId}`);
    else if (incoming && requestId === incoming)
      failures.push("malformed client request-id echoed");
  }
  if (status >= 500 && status !== 502 && status !== 503)
    failures.push(`5xx status ${status} (only 502/503 are contractually possible)`);
  if (status >= 500 && !expected.upstreamFault)
    failures.push(`5xx ${status} without an upstream fault in this iteration`);
  if (status >= 400 && status < 500 && !BAD_INPUT_STATUSES.has(status))
    failures.push(`4xx ${status} outside the allowed set`);
  for (const secret of SECRETS)
    if (bodyText.includes(secret)) failures.push(`secret in body: ${secret}`);
  if (s.token && s.token.length >= 16 && bodyText.includes(s.token))
    failures.push("bearer echoed in body");
  if (bodyText.includes(s.canary))
    failures.push("upstream detail (canary) leaked into response body");
  if (STACK_TRACE_RE.test(bodyText))
    failures.push(`stack trace / internal detail in body: ${bodyText.slice(0, 120)}`);
  for (const line of iterationLogs) {
    for (const secret of SECRETS)
      if (line.includes(secret)) failures.push(`secret in log: ${secret}`);
    if (s.token && s.token.length >= 16 && line.includes(s.token))
      failures.push("bearer in log line");
  }

  let parsed: unknown = undefined;
  if (s.method.toUpperCase() !== "HEAD") {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }
    const isText =
      expected.reason === "public pre-auth page" && status === 200 && !/healthz$/.test(s.path);
    if (!isText && parsed === undefined && status !== 204)
      failures.push(`non-JSON body for status ${status}: ${bodyText.slice(0, 80)}`);
    if (status >= 400) {
      const message = isRecord(parsed) && isRecord(parsed.error) ? parsed.error.message : undefined;
      if (typeof message !== "string" || !message) failures.push("error body lacks error.message");
      if (status >= 500 && typeof message === "string" && !GENERIC_5XX_MESSAGES.has(message))
        failures.push(`non-generic 5xx message: ${message}`);
      if (
        status === 502 &&
        (!isRecord(parsed) ||
          !isRecord(parsed.error) ||
          parsed.error.code !== "billing_unavailable")
      )
        failures.push("502 without billing_unavailable code");
      if (response.headers.get("x-content-type-options") !== "nosniff")
        failures.push("error response lacks nosniff");
      if (response.headers.get("cache-control") !== "no-store")
        failures.push("error response lacks no-store");
    }
  }
  if (status === 429) {
    if (!response.headers.get("retry-after")) failures.push("429 without Retry-After");
    const code = isRecord(parsed) && isRecord(parsed.error) ? parsed.error.code : undefined;
    if (s.method.toUpperCase() !== "HEAD" && code !== "rate_limited")
      failures.push("429 without rate_limited code");
  }

  // ── Status against the oracle (429 is admissible anywhere a budget exists).
  const admissible = new Set(expected.statuses);
  admissible.add(429);
  if (!admissible.has(status))
    failures.push(
      `status ${status} not in expected {${expected.statuses.join(",")}} — ${expected.reason}`,
    );

  // ── Writes and RevenueCat calls.
  if (status >= 400 && status < 500) {
    if (writes.length !== 0)
      failures.push(
        `write on rejection (${status}): ${writes.length} billing_entitlements call(s)`,
      );
    if (rcCalls.length !== 0) failures.push(`RevenueCat called on rejection (${status})`);
  }
  if (!expected.reachesRoute) {
    if (writes.length !== 0)
      failures.push(`write although the route should not be reached (${expected.reason})`);
    if (rcCalls.length !== 0)
      failures.push(
        `RevenueCat called although the route should not be reached (${expected.reason})`,
      );
  }
  if (status === 502 && writes.length !== 0)
    failures.push("write despite no RevenueCat verdict (502)");
  if (rcCalls.length > 1) failures.push(`RevenueCat called ${rcCalls.length}× in one request`);
  if (writes.length > 1)
    failures.push(`billing_entitlements written ${writes.length}× in one request`);
  if ((status === 200 || status === 503) && expected.reachesRoute && s.oracle) {
    if (writes.length !== 1 && !(status === 503 && s.rc.kind !== "ok"))
      failures.push(`expected exactly one write, saw ${writes.length}`);
    if (rcCalls.length !== 1)
      failures.push(`expected exactly one RevenueCat call, saw ${rcCalls.length}`);
  }
  if (expected.reachesRoute && status !== 429 && s.user) {
    for (const call of rcCalls) {
      if (call.url !== `${RC_URL}${encodeURIComponent(s.user)}`)
        failures.push(`RevenueCat asked about ${call.url}, not the authenticated user`);
      if (call.headers["authorization"] !== "Bearer sk_test_revenuecat")
        failures.push("RevenueCat call without the secret key");
    }
    for (const write of writes) {
      const row = write.body;
      if (write.headers["authorization"] !== "Bearer service-role-test-key")
        failures.push("billing_entitlements write not made with the service role");
      if (
        !/on_conflict=user_id/.test(write.url) ||
        !/resolution=merge-duplicates/.test(write.headers["prefer"] ?? "")
      )
        failures.push("write is not an upsert keyed by user_id");
      if (!isRecord(row)) failures.push("write body is not a row");
      else {
        if (row.user_id !== s.user)
          failures.push(`write for user ${String(row.user_id)} ≠ authenticated ${s.user}`);
        if (s.oracle) {
          if (row.premium !== s.oracle.premium)
            failures.push(`write premium=${String(row.premium)} oracle=${s.oracle.premium}`);
          if (row.product_key !== s.oracle.productKey)
            failures.push(
              `write product_key=${String(row.product_key)} oracle=${String(s.oracle.productKey)}`,
            );
          if (row.expires_at !== s.oracle.expiresAt)
            failures.push(
              `write expires_at=${String(row.expires_at)} oracle=${String(s.oracle.expiresAt)}`,
            );
        }
        if (typeof row.verified_at !== "string" || !Number.isFinite(Date.parse(row.verified_at)))
          failures.push("write verified_at is not a timestamp");
        else {
          const ts = Date.parse(row.verified_at);
          if (ts < t0 - 1000 || ts > t0 + durationMs + 1000)
            failures.push("write verified_at not within the request");
        }
      }
    }
  }

  // ── 200 body contract.
  if (status === 200 && expected.reachesRoute && s.oracle) {
    if (!isRecord(parsed) || !isRecord(parsed.billing) || !isRecord(parsed.access))
      failures.push("200 body lacks billing/access");
    else {
      const { billing, access } = parsed;
      if (billing.premium !== s.oracle.premium)
        failures.push(`billing.premium=${String(billing.premium)} oracle=${s.oracle.premium}`);
      if (billing.productKey !== s.oracle.productKey) failures.push("billing.productKey ≠ oracle");
      if (billing.expiresAt !== s.oracle.expiresAt) failures.push("billing.expiresAt ≠ oracle");
      if (typeof billing.verifiedAt !== "string") failures.push("billing.verifiedAt missing");
      if (access.premium !== billing.premium) failures.push("access.premium ≠ billing.premium");
      const ents = Array.isArray(access.entitlements) ? (access.entitlements as unknown[]) : null;
      if (!ents) failures.push("access.entitlements not an array");
      else {
        if (ents.includes("premium") !== s.oracle.premium)
          failures.push("entitlements/premium mismatch");
        const expectedEnts = s.oracle.premium
          ? ["premium", ...s.oracle.activeEntitlements.filter((n) => n !== "premium")]
          : [];
        if (JSON.stringify(ents) !== JSON.stringify(expectedEnts))
          failures.push(`entitlements ${JSON.stringify(ents)} ≠ ${JSON.stringify(expectedEnts)}`);
      }
      const fr = isRecord(access.freeRatings) ? access.freeRatings : null;
      const rowOk =
        s.rpc === "ok" &&
        typeof s.row.scored_count === "number" &&
        typeof s.row.reserved_count === "number" &&
        Number.isInteger(s.row.scored_count) &&
        Number.isInteger(s.row.reserved_count) &&
        s.row.scored_count >= 0 &&
        s.row.reserved_count >= 0;
      if (!fr) failures.push("access.freeRatings missing");
      else if (rowOk || upstream.pg) {
        const used = Number(fr.used);
        const remaining = Number(fr.remaining);
        const reserved = Number(fr.reserved);
        const avail = Number(fr.availableToReserve);
        if (fr.limit !== 2) failures.push("freeRatings.limit ≠ 2");
        if (!(used >= 0 && used <= 2 && Number.isInteger(used)))
          failures.push(`freeRatings.used=${String(fr.used)}`);
        if (remaining !== 2 - used) failures.push("remaining ≠ limit - used");
        if (!(reserved >= 0 && reserved <= remaining)) failures.push("reserved out of range");
        if (avail !== remaining - reserved)
          failures.push("availableToReserve ≠ remaining - reserved");
        if (access.canStartRating !== (s.oracle.premium || avail > 0))
          failures.push("canStartRating inconsistent");
        if (access.paywallRequired !== !access.canStartRating)
          failures.push("paywallRequired ≠ !canStartRating");
        if (
          !upstream.pg &&
          typeof s.row.scored_count === "number" &&
          used !== Math.min(2, s.row.scored_count)
        )
          failures.push("used ≠ min(2, scored_count)");
      }
    }
    if (
      s.token &&
      s.user &&
      (s.authKind === "provider_google" ||
        s.authKind === "provider_apple" ||
        s.authKind === "session")
    ) {
      ctx.cache.push({ token: s.token, user: s.user });
      if (ctx.cache.length > 64) ctx.cache.shift();
    }
  }

  // ── Per-user budget: never an 11th admitted sync in one aligned window.
  if (
    expected.reachesRoute &&
    s.user &&
    (status === 200 || status === 502 || status === 503) &&
    !bucketStraddle
  ) {
    const key = `${s.user}:${bucketBefore}`;
    const n = (ctx.admitted.get(key) ?? 0) + 1;
    ctx.admitted.set(key, n);
    if (n > BILLING_SYNC_LIMIT)
      failures.push(`per-user billing budget exceeded: ${n} admitted syncs in one window`);
  }

  return {
    ...base,
    status,
    requestId,
    writes: writes.length,
    rcCalls: rcCalls.length,
    durationMs,
    verdict: failures.length === 0 ? "HELD" : "BROKEN",
    failures,
    bucketStraddle,
    ...(failures.length > 0
      ? {
          logExcerpt: iterationLogs
            .filter((line) => !line.startsWith("access "))
            .slice(0, 6)
            .map((line) => line.slice(0, 400)),
        }
      : {}),
  };
}

// ── Campaign driver ─────────────────────────────────────────────────────────

interface CampaignReport {
  campaign: string;
  master: number;
  commit: string | null;
  iterations: number;
  executed: number;
  notExecuted: number;
  held: number;
  broken: number;
  statusHistogram: Record<string, number>;
  reasonHistogram: Record<string, number>;
  authHistogram: Record<string, number>;
  writes: number;
  rcCalls: number;
  durationMs: number;
  failingSeeds: Array<{ seed: number; failures: string[]; replay: string }>;
  outcomes: Outcome[];
}

const envInt = (name: string, fallback: number): number => {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const MASTER_SEED = envInt("STRESS_SEED", 20260905);
const REPLAY_SEEDS = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s) >>> 0);
const OUT_DIR = Deno.env.get("STRESS_OUT") ?? "";
const PROGRESS = Deno.env.get("STRESS_PROGRESS") === "1";
const PG_URL =
  Deno.env.get("STRESS_PG_URL") ??
  Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ??
  "";

async function gitCommit(): Promise<string | null> {
  try {
    const out = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      stdout: "piped",
      stderr: "null",
    }).output();
    return out.success ? new TextDecoder().decode(out.stdout).trim() : null;
  } catch {
    return null;
  }
}

async function writeReport(report: CampaignReport): Promise<string | null> {
  if (!OUT_DIR) return null;
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const path = `${OUT_DIR}/${report.campaign}-seed${report.master}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 1));
  return path;
}

async function runCampaign(
  campaign: string,
  iterations: number,
  pg: PgShim | null,
): Promise<CampaignReport> {
  const h = await loadHarness();
  const started = Date.now();
  const captured = captureConsole();
  const ctx: RunContext = {
    h,
    master: MASTER_SEED,
    cache: [],
    admitted: new Map(),
    logs: captured.logs,
    pgSeeded: pg ? new Set() : null,
  };
  upstream.pg = pg;
  upstream.h = h;
  const outcomes: Outcome[] = [];
  try {
    const plan =
      REPLAY_SEEDS.length > 0
        ? REPLAY_SEEDS.map((seed, i) => ({ seed, iteration: i }))
        : Array.from({ length: iterations }, (_, i) => ({
            seed: iterationSeed(MASTER_SEED, i),
            iteration: i,
          }));
    for (const step of plan) {
      const scenario = generate(MASTER_SEED, step.seed, step.iteration, ctx.cache);
      if (pg && scenario.user && ctx.pgSeeded && !ctx.pgSeeded.has(scenario.user)) {
        // Real FK: billing_entitlements.user_id → profiles.id → auth.users.id.
        await pg.seedUser(scenario.user, 0);
        ctx.pgSeeded.add(scenario.user);
      }
      // Keep the harness call log bounded across thousands of iterations.
      if (h.calls.length > 5_000) h.calls.splice(0, h.calls.length - 100);
      if (ctx.logs.length > 5_000) ctx.logs.splice(0, ctx.logs.length - 100);
      const outcome = await runIteration(ctx, scenario);
      outcomes.push(outcome);
      if (PROGRESS && (outcome.durationMs > 2_000 || outcomes.length % 250 === 0)) {
        // Console is captured during the campaign; progress goes to stderr.
        Deno.stderr.writeSync(
          new TextEncoder().encode(
            `[stress] ${campaign} #${outcomes.length} seed=${outcome.seed} status=${outcome.status} ${outcome.durationMs}ms ${outcome.request.auth} ${outcome.request.body} ${outcome.upstream.rc}\n`,
          ),
        );
      }
    }
  } finally {
    upstream.current = null;
    upstream.pg = null;
    upstream.h = null;
    captured.restore();
  }
  const executed = outcomes.filter((o) => o.status !== -1);
  const hist = (pick: (o: Outcome) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const o of executed) out[pick(o)] = (out[pick(o)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort());
  };
  const broken = executed.filter((o) => o.verdict === "BROKEN");
  const report: CampaignReport = {
    campaign,
    master: MASTER_SEED,
    commit: await gitCommit(),
    iterations: outcomes.length,
    executed: executed.length,
    notExecuted: outcomes.length - executed.length,
    held: executed.length - broken.length,
    broken: broken.length,
    statusHistogram: hist((o) => String(o.status)),
    reasonHistogram: hist((o) => o.expected.reason.replace(/ [0-9a-f-]{36}/g, "")),
    authHistogram: hist((o) => o.request.auth),
    writes: executed.reduce((n, o) => n + o.writes, 0),
    rcCalls: executed.reduce((n, o) => n + o.rcCalls, 0),
    durationMs: Date.now() - started,
    failingSeeds: broken.map((o) => ({ seed: o.seed, failures: o.failures, replay: o.replay })),
    outcomes,
  };
  const path = await writeReport(report);
  console.log(
    `[stress] ${campaign}: seed=${MASTER_SEED} executed=${report.executed}/${report.iterations} held=${report.held} broken=${report.broken} writes=${report.writes} rc=${report.rcCalls} ${report.durationMs}ms${path ? ` → ${path}` : ""}`,
  );
  console.log(`[stress]   statuses ${JSON.stringify(report.statusHistogram)}`);
  for (const f of report.failingSeeds.slice(0, 20))
    console.log(`[stress]   BROKEN seed=${f.seed} ${f.failures.join(" | ")}`);
  return report;
}

function assertCampaignHeld(report: CampaignReport, minExecuted: number): void {
  assert(
    report.executed >= minExecuted,
    `only ${report.executed} scenarios executed (< ${minExecuted})`,
  );
  assertEquals(
    report.failingSeeds.map((f) => `${f.seed}: ${f.failures.join(" | ")}`),
    [],
    `${report.broken} BROKEN iteration(s) — replay with STRESS_REPLAY=<seed>`,
  );
  if (REPLAY_SEEDS.length > 0) return;
  // The campaign must actually reach the route, not drown in 401/404/429.
  assert(
    (report.statusHistogram["200"] ?? 0) > 0,
    "no request reached a 200 — campaign did not exercise the route",
  );
  assert(
    (report.statusHistogram["502"] ?? 0) + (report.statusHistogram["503"] ?? 0) > 0,
    "no upstream-fault iteration ran",
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

Deno.test(
  "STRESS fuzz-boundary: POST /v1/billing/sync — stub-backed campaign (STRESS_ITER, default 150)",
  async () => {
    const iterations = envInt("STRESS_ITER", 150);
    const report = await runCampaign("billing-sync-fuzz-stub", iterations, null);
    assertCampaignHeld(report, REPLAY_SEEDS.length > 0 ? 1 : Math.min(iterations, 100));
  },
);

Deno.test({
  name: "STRESS fuzz-boundary: POST /v1/billing/sync — Postgres-backed campaign (STRESS_PG_URL; every migration applied)",
  ignore: PG_URL === "",
  async fn() {
    const pg = new PgShim(PG_URL);
    try {
      const iterations = envInt("STRESS_PG_ITER", 200);
      const report = await runCampaign("billing-sync-fuzz-pg", iterations, pg);
      assertCampaignHeld(report, REPLAY_SEEDS.length > 0 ? 1 : Math.min(iterations, 100));
      // Every accepted verdict landed as exactly one row per user (upsert keyed
      // by user_id — repeat deliveries never duplicate).
      const users = new Set(
        report.outcomes
          .filter((o) => o.status === 200 && o.request.user)
          .map((o) => o.request.user as string),
      );
      for (const user of users) {
        const rows = await pg.entitlementRows(user);
        assertEquals(rows.length, 1, `user ${user} has ${rows.length} billing_entitlements rows`);
      }
    } finally {
      await pg.end();
    }
  },
});

Deno.test({
  name: "STRESS idempotency: repeated syncs upsert one row, the last verdict wins, free ratings never reset (Postgres)",
  ignore: PG_URL === "",
  async fn() {
    const pg = new PgShim(PG_URL);
    const h = await loadHarness();
    const captured = captureConsole();
    upstream.pg = pg;
    upstream.h = h;
    try {
      const master = MASTER_SEED ^ 0x1d3;
      const rng = new Rng(master);
      const user = rng.uuid();
      await pg.seedUser(user, 2); // both free ratings spent
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const past = new Date(Date.now() - 86_400_000).toISOString();
      const sequence: Array<{ expires: unknown; product: string; premium: boolean }> = [
        { expires: future, product: "pickle_sensei_pro_monthly", premium: true },
        { expires: future, product: "pickle_sensei_pro_monthly", premium: true },
        { expires: null, product: "pickle_sensei_pro_lifetime", premium: true },
        { expires: past, product: "pickle_sensei_pro_monthly", premium: false },
        { expires: future, product: "pickle_sensei_pro_annual", premium: true },
        { expires: past, product: "pickle_sensei_pro_annual", premium: false },
        { expires: "garbage", product: "pickle_sensei_pro_annual", premium: false },
        { expires: null, product: "pickle_sensei_pro_lifetime", premium: true },
      ];
      let ip = 0;
      for (const [i, step] of sequence.entries()) {
        const seed = iterationSeed(master, i);
        const canary = `CANARY-idem-${seed.toString(16)}`;
        const scenario: Scenario = {
          seed,
          iteration: i,
          method: "POST",
          path: "/functions/v1/api/v1/billing/sync",
          query: "",
          headers: {
            Authorization: `Bearer ${providerToken(new Rng(seed), user, "https://accounts.google.com", 3600)}`,
            "x-forwarded-for": `198.51.100.${(ip += 1)}`,
          },
          headerNotes: [],
          bodyKind: "none",
          body: null,
          authKind: "provider_google",
          user,
          token: null,
          gotrue: "ok",
          rc: {
            kind: "ok",
            status: 200,
            subscriber: {
              entitlements: {
                pickle_sensei_pro: { expires_date: step.expires, product_identifier: step.product },
              },
            },
            note: "idempotency",
          },
          upsert: "ok",
          rpc: "ok",
          row: { premium: false, scored_count: 0, reserved_count: 0 },
          canary,
          oracle: null,
        };
        scenario.oracle = oracleVerdict(scenario.rc);
        upstream.current = scenario;
        const response = await h.handler(buildRequest(scenario) as Request);
        upstream.current = null;
        const body = (await response.json()) as {
          billing: Record<string, unknown>;
          access: Record<string, unknown>;
        };
        assertEquals(response.status, 200, `step ${i}: ${JSON.stringify(body)}`);
        assertEquals(body.billing.premium, step.premium, `step ${i} billing.premium`);
        assertEquals(body.access.premium, step.premium, `step ${i} access.premium`);
        // Free ratings are spent (2 scored shots); only premium unlocks rating.
        assertEquals(
          (body.access.freeRatings as Record<string, unknown>).used,
          2,
          `step ${i} used`,
        );
        assertEquals(body.access.canStartRating, step.premium, `step ${i} canStartRating`);
        assertEquals(body.access.paywallRequired, !step.premium, `step ${i} paywallRequired`);
        const rows = await pg.entitlementRows(user);
        assertEquals(rows.length, 1, `step ${i}: exactly one billing_entitlements row`);
        assertEquals(rows[0].premium, step.premium, `step ${i}: persisted premium`);
        assertEquals(
          rows[0].product_key,
          step.premium ? step.product : null,
          `step ${i}: persisted product_key`,
        );
        assertEquals(
          await pg.scoredCount(user),
          2,
          `step ${i}: scored shots untouched by billing sync`,
        );
      }
      // The real access_state() sees the persisted verdict (last step: lifetime).
      const state = await pg.accessState(
        new Request(`${SUPABASE_URL}/rest/v1/rpc/access_state`, {
          method: "POST",
          headers: { authorization: `Bearer session-for-${user}` },
        }),
      );
      const rows = (await state.json()) as Array<{ premium: boolean; scored_count: number }>;
      assertEquals(rows[0].premium, true);
      assertEquals(rows[0].scored_count, 2);
    } finally {
      upstream.current = null;
      upstream.pg = null;
      upstream.h = null;
      captured.restore();
      await pg.end();
    }
  },
});

// Minimized from campaign seed 499178393 (master 20260905, Postgres-backed):
// an entitlement whose expires_date parses in JS (Date.parse → finite, future)
// but not in Postgres. The verdict is ACTIVE, so the route persists the raw
// string into billing_entitlements.expires_at (timestamptz) — the upsert is
// refused and the subscriber gets a 503 on every sync.
Deno.test({
  name: "STRESS minimized seed 499178393: RevenueCat expires_date accepted by JS but not by timestamptz must still sync (Postgres)",
  ignore: PG_URL === "",
  async fn() {
    const pg = new PgShim(PG_URL);
    const h = await loadHarness();
    const captured = captureConsole();
    upstream.pg = pg;
    upstream.h = h;
    try {
      const master = MASTER_SEED ^ 0x7e5;
      const rng = new Rng(master);
      const user = rng.uuid();
      await pg.seedUser(user, 0);
      const expiresVariants = ["+275760-09-13T00:00:00.000Z", "99999-01-01"];
      for (const [i, expires] of expiresVariants.entries()) {
        assert(Date.parse(expires) > Date.now(), `${expires} is a future date for JS`);
        const seed = iterationSeed(master, i);
        const scenario: Scenario = {
          seed,
          iteration: i,
          method: "POST",
          path: "/functions/v1/api/v1/billing/sync",
          query: "",
          headers: {
            Authorization: `Bearer ${providerToken(new Rng(seed), user, "https://accounts.google.com", 3600)}`,
            "x-forwarded-for": `198.51.100.${200 + i}`,
          },
          headerNotes: [],
          bodyKind: "none",
          body: null,
          authKind: "provider_google",
          user,
          token: null,
          gotrue: "ok",
          rc: {
            kind: "ok",
            status: 200,
            subscriber: {
              entitlements: {
                pickle_sensei_pro: {
                  expires_date: expires,
                  product_identifier: "pickle_sensei_pro_annual",
                },
              },
            },
            note: "minimized-499178393",
          },
          upsert: "ok",
          rpc: "ok",
          row: { premium: false, scored_count: 0, reserved_count: 0 },
          canary: `CANARY-min-${seed.toString(16)}`,
          oracle: null,
        };
        scenario.oracle = oracleVerdict(scenario.rc);
        upstream.current = scenario;
        const response = await h.handler(buildRequest(scenario) as Request);
        upstream.current = null;
        const text = await response.text();
        assertEquals(
          response.status,
          200,
          `expires_date=${expires}: status ${response.status} body ${text} logs ${JSON.stringify(
            captured.logs.filter((l) => !l.startsWith("access ")),
          )}`,
        );
        const rows = await pg.entitlementRows(user);
        assertEquals(rows.length, 1, `expires_date=${expires}: verdict persisted`);
        assertEquals(rows[0].premium, true, `expires_date=${expires}: persisted premium`);
      }
    } finally {
      upstream.current = null;
      upstream.pg = null;
      upstream.h = null;
      captured.restore();
      await pg.end();
    }
  },
});
