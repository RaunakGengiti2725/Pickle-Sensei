// FUZZ / BOUNDARY campaign against the REAL edge handler for
//   GET /v1/training-plans/current
// (supabase/functions/api/index.ts) — routesHarness imports ../index.ts with
// Deno.serve captured and Supabase Auth / PostgREST / RevenueCat stubbed at the
// fetch layer, so every generated request runs the production pipeline:
// body-size precheck → per-IP + auth-failure limits → path normalisation →
// authenticate() → per-user budget → route switch.
//
// Every iteration is derived from ONE seed (mulberry32) that fully determines
// the method, path shape, query, bearer, IP headers, request-id, extra
// headers, body and the injected upstream fault, so any row of the JSON table
// replays alone. Invariants asserted per request:
//   • bad input answers ONLY 400/401/403/404/405/413/415/429 (never 2xx, never 5xx)
//   • a valid bearer on the canonical route answers 200 {"plan":null} exactly
//   • every 5xx (only reachable through an injected Supabase Auth fault) has
//     the generic body, no stack trace / upstream detail, and Retry-After
//   • no response body contains stack-trace markers
//   • no write (POST/PATCH/PUT/DELETE to PostgREST, RevenueCat or Auth admin)
//     is issued for ANY request — the route is static and rejections must not
//     touch storage
//   • x-request-id is always present, well-formed, echoed when the client's
//     was well-formed and REPLACED when it was not
//   • JSON answers carry the security headers (nosniff, no-store)
//
// Default is a quick smoke (STRESS_ITER=120) so it can live in the suite; the
// full campaign is:
//   cd supabase/functions/api/__wf__ && STRESS_ITER=3200 STRESS_SEED=20260905 \
//     deno test -A --no-check --config deno.json stress_training_plans_current_fuzz.test.ts
// Replay one row of the table (its `seed` column):
//   STRESS_REPLAY_SEED=<seed> deno test -A --no-check --config deno.json \
//     stress_training_plans_current_fuzz.test.ts --filter fuzz
// Results (per-iteration table + summary) are written under
//   artifacts/stress-training-plans-current/<STRESS_RUN_ID|latest>/
// (override with STRESS_OUT_DIR).

import { assert, assertEquals } from "@std/assert";
import {
  type Harness,
  loadHarness,
  RC_URL,
  type RecordedCall,
  SUPABASE_URL,
} from "./routesHarness.ts";
import { envInt, histogram, Prng } from "./xc_concurrency_harness.ts";

// ── Configuration ────────────────────────────────────────────────────────────

const STRESS_ITER = envInt("STRESS_ITER", 120);
const STRESS_SEED = envInt("STRESS_SEED", 20260905);
const REPLAY_SEED = Deno.env.get("STRESS_REPLAY_SEED");
const ROUTE_PATH = "/v1/training-plans/current";
const CANONICAL_URL_PATH = `/functions/v1/api${ROUTE_PATH}`;
const MAX_JSON_BODY_BYTES = 5_000_000;
const BAD_INPUT_STATUSES: ReadonlySet<number> = new Set([
  400,
  401,
  403,
  404,
  405,
  413,
  415,
  429,
]);
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STACK_MARKERS = [
  /\n\s+at\s/,
  /file:\/\//,
  /index\.ts/,
  /\.ts:\d+/,
  /TypeError|ReferenceError|SyntaxError|RangeError/,
  /Deno\./,
  /supabase\.test/,
  /PGRST|postgres|Supabase Auth/i,
];
const GENERIC_5XX_RE =
  /^[A-Za-z ]+ is temporarily unavailable\. Please try again\.$|^Something went wrong\. Please try again\.$/;

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  const run = Deno.env.get("STRESS_RUN_ID") ?? "latest";
  return new URL(
    `../../../../artifacts/stress-training-plans-current/${run}/`,
    import.meta.url,
  )
    .pathname;
}

// ── Seeds ────────────────────────────────────────────────────────────────────

/** splitmix-style mixer: campaign seed × iteration index → 32-bit iteration seed. */
function iterationSeed(campaignSeed: number, index: number): number {
  let z = (campaignSeed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

const pick = <T>(rng: Prng, items: readonly T[]): T =>
  items[rng.int(0, items.length - 1)];
const chance = (rng: Prng, p: number): boolean => rng.next() < p;

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HEADER_SAFE = `${ALNUM}!#$%&'*+-.^_\`|~ :;,/=?@[]{}()<>"\\`;
const PATH_JUNK = `${ALNUM}-._~!$&'()*+,;=:@%[]{}|^\`"<>\\`;

function randomString(
  rng: Prng,
  alphabet: string,
  min: number,
  max: number,
): string {
  const n = rng.int(min, max);
  let out = "";
  for (let i = 0; i < n; i += 1) {
    out += alphabet[rng.int(0, alphabet.length - 1)];
  }
  return out;
}

/** Latin-1 header value (Headers accepts ByteString; CR/LF/NUL are refused, so
 * never generated). */
function latin1Junk(rng: Prng, min: number, max: number): string {
  const n = rng.int(min, max);
  let out = "";
  for (let i = 0; i < n; i += 1) {
    const code = chance(rng, 0.3) ? rng.int(0x80, 0xff) : rng.int(0x20, 0x7e);
    out += String.fromCharCode(code);
  }
  return out;
}

const b64url = (value: string): string =>
  btoa(unescape(encodeURIComponent(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function jwt(header: unknown, payload: unknown, signature = "sig"): string {
  return `${b64url(JSON.stringify(header))}.${
    b64url(JSON.stringify(payload))
  }.${signature}`;
}

// ── Plan: everything an iteration does, derived from its seed ────────────────

type AuthKind =
  | "valid_google"
  | "valid_google_bare_iss"
  | "valid_apple"
  | "valid_session"
  | "missing"
  | "empty_bearer"
  | "lowercase_scheme"
  | "basic_scheme"
  | "no_scheme"
  | "two_segments"
  | "four_segments"
  | "bad_base64"
  | "non_json_payload"
  | "array_payload"
  | "no_iss"
  | "iss_lookalike"
  | "iss_non_string"
  | "expired_google"
  | "expired_session"
  | "exp_string"
  | "exp_huge"
  | "exp_negative"
  | "no_sub_google"
  | "session_unknown_user"
  | "session_no_provider"
  | "giant_payload"
  | "latin1_junk"
  | "unicode_token";

type PathClass =
  | "canonical"
  | "api_prefix"
  | "bare_v1"
  | "double_v1_prefix"
  | "dot_segment_normalises"
  | "trailing_slash"
  | "double_slash"
  | "leading_double_slash"
  | "upper_case"
  | "mixed_case"
  | "percent_encoded_slash"
  | "percent_encoded_letter"
  | "encoded_traversal"
  | "null_byte"
  | "extra_suffix"
  | "sibling_training_plans"
  | "parent_only"
  | "junk_segment"
  | "unicode_segment"
  | "long_path"
  | "huge_path"
  | "backslash"
  | "no_v1"
  | "space_in_segment"
  | "other_route_shape";

type QueryClass =
  | "none"
  | "simple"
  | "many_params"
  | "repeated_param"
  | "huge_value"
  | "junk_chars"
  | "encoded_chars"
  | "array_syntax"
  | "empty_marker"
  | "proto_pollution"
  | "unicode";

type IpKind =
  | "xff_unique"
  | "xff_multi_hop"
  | "cf_connecting_ip"
  | "cf_overrides_xff"
  | "xff_garbage_with_cf"
  | "xff_empty_hops_with_cf"
  | "xff_huge_with_cf"
  | "no_ip_header";

type RequestIdKind =
  | "absent"
  | "well_formed"
  | "well_formed_max"
  | "too_short"
  | "too_long"
  | "bad_chars"
  | "whitespace_padded_ok"
  | "junk"
  | "empty";

type BodyKind =
  | "none"
  | "empty"
  | "json_object"
  | "json_array"
  | "json_scalar"
  | "invalid_json"
  | "binary_junk"
  | "large_under_cap"
  | "spoof_length_over_cap"
  | "spoof_length_garbage"
  | "spoof_length_negative"
  | "spoof_length_at_cap";

type UpstreamFault =
  | "healthy"
  | "auth_user_500"
  | "auth_user_throw"
  | "auth_user_garbage_2xx"
  | "auth_user_429"
  | "auth_user_403"
  | "auth_token_500";

interface Plan {
  index: number;
  seed: number;
  method: string;
  methodClass:
    | "get"
    | "head"
    | "lowercase_get"
    | "post"
    | "put"
    | "patch"
    | "delete"
    | "options"
    | "custom";
  urlPath: string;
  pathClass: PathClass;
  query: string;
  queryClass: QueryClass;
  authKind: AuthKind;
  authorization: string | null;
  userId: string | null;
  ipKind: IpKind;
  ipHeaders: Record<string, string>;
  requestIdKind: RequestIdKind;
  requestIdSent: string | null;
  extraHeaders: Record<string, string>;
  extraHeaderClasses: string[];
  bodyKind: BodyKind;
  body: string | Uint8Array<ArrayBuffer> | null;
  declaredContentLength: string | null;
  contentType: string | null;
  upstream: UpstreamFault;
}

const METHOD_TABLE: ReadonlyArray<[Plan["methodClass"], string, number]> = [
  ["get", "GET", 55],
  ["head", "HEAD", 5],
  ["lowercase_get", "get", 4],
  ["post", "POST", 12],
  ["put", "PUT", 5],
  ["patch", "PATCH", 5],
  ["delete", "DELETE", 5],
  ["options", "OPTIONS", 4],
  ["custom", "PROPFIND", 5],
];

function weighted<T extends readonly unknown[]>(
  rng: Prng,
  table: ReadonlyArray<T>,
  weightOf: (row: T) => number,
): T {
  const total = table.reduce((sum, row) => sum + weightOf(row), 0);
  let roll = rng.next() * total;
  for (const row of table) {
    roll -= weightOf(row);
    if (roll < 0) return row;
  }
  return table[table.length - 1];
}

const AUTH_KINDS: ReadonlyArray<[AuthKind, number]> = [
  ["valid_google", 20],
  ["valid_google_bare_iss", 2],
  ["valid_apple", 8],
  ["valid_session", 22],
  ["missing", 4],
  ["empty_bearer", 2],
  ["lowercase_scheme", 2],
  ["basic_scheme", 2],
  ["no_scheme", 2],
  ["two_segments", 2],
  ["four_segments", 2],
  ["bad_base64", 3],
  ["non_json_payload", 2],
  ["array_payload", 2],
  ["no_iss", 2],
  ["iss_lookalike", 3],
  ["iss_non_string", 2],
  ["expired_google", 2],
  ["expired_session", 2],
  ["exp_string", 2],
  ["exp_huge", 1],
  ["exp_negative", 1],
  ["no_sub_google", 2],
  ["session_unknown_user", 2],
  ["session_no_provider", 2],
  ["giant_payload", 1],
  ["latin1_junk", 2],
  ["unicode_token", 1],
];

const PATH_CLASSES: ReadonlyArray<[PathClass, number]> = [
  ["canonical", 30],
  ["api_prefix", 6],
  ["bare_v1", 6],
  ["double_v1_prefix", 3],
  ["dot_segment_normalises", 2],
  ["trailing_slash", 4],
  ["double_slash", 3],
  ["leading_double_slash", 2],
  ["upper_case", 3],
  ["mixed_case", 3],
  ["percent_encoded_slash", 3],
  ["percent_encoded_letter", 3],
  ["encoded_traversal", 3],
  ["null_byte", 2],
  ["extra_suffix", 4],
  ["sibling_training_plans", 2],
  ["parent_only", 2],
  ["junk_segment", 4],
  ["unicode_segment", 3],
  ["long_path", 3],
  ["huge_path", 1],
  ["backslash", 2],
  ["no_v1", 3],
  ["space_in_segment", 2],
  ["other_route_shape", 3],
];

const QUERY_CLASSES: ReadonlyArray<[QueryClass, number]> = [
  ["none", 40],
  ["simple", 12],
  ["many_params", 8],
  ["repeated_param", 6],
  ["huge_value", 4],
  ["junk_chars", 8],
  ["encoded_chars", 6],
  ["array_syntax", 4],
  ["empty_marker", 3],
  ["proto_pollution", 4],
  ["unicode", 5],
];

const IP_KINDS: ReadonlyArray<[IpKind, number]> = [
  ["xff_unique", 50],
  ["xff_multi_hop", 12],
  ["cf_connecting_ip", 10],
  ["cf_overrides_xff", 8],
  ["xff_garbage_with_cf", 8],
  ["xff_empty_hops_with_cf", 5],
  ["xff_huge_with_cf", 4],
  ["no_ip_header", 3],
];

const REQUEST_ID_KINDS: ReadonlyArray<[RequestIdKind, number]> = [
  ["absent", 40],
  ["well_formed", 20],
  ["well_formed_max", 4],
  ["too_short", 6],
  ["too_long", 6],
  ["bad_chars", 8],
  ["whitespace_padded_ok", 4],
  ["junk", 8],
  ["empty", 4],
];

const BODY_KINDS_NON_GET: ReadonlyArray<[BodyKind, number]> = [
  ["none", 25],
  ["empty", 8],
  ["json_object", 15],
  ["json_array", 6],
  ["json_scalar", 5],
  ["invalid_json", 10],
  ["binary_junk", 8],
  ["large_under_cap", 3],
  ["spoof_length_over_cap", 8],
  ["spoof_length_garbage", 4],
  ["spoof_length_negative", 3],
  ["spoof_length_at_cap", 5],
];

const BODY_KINDS_GET: ReadonlyArray<[BodyKind, number]> = [
  ["none", 82],
  ["spoof_length_over_cap", 8],
  ["spoof_length_garbage", 4],
  ["spoof_length_negative", 3],
  ["spoof_length_at_cap", 3],
];

const UPSTREAM_FAULTS: ReadonlyArray<[UpstreamFault, number]> = [
  ["healthy", 86],
  ["auth_user_500", 3],
  ["auth_user_throw", 3],
  ["auth_user_garbage_2xx", 2],
  ["auth_user_429", 2],
  ["auth_user_403", 2],
  ["auth_token_500", 2],
];

/** Bearers the stubbed Supabase Auth vouches for. The edge only routes on
 * the provider token (issuer + exp); verification is Supabase Auth's job, and
 * the harness stub exchanges ANY syntactically valid payload — so a
 * non-numeric/huge exp, a giant or unicode payload and even a missing `sub`
 * authenticate here (the real GoTrue refuses the unsigned token). */
const VALID_AUTH_KINDS: ReadonlySet<AuthKind> = new Set<AuthKind>([
  "valid_google",
  "valid_google_bare_iss",
  "valid_apple",
  "valid_session",
  "exp_string",
  "exp_huge",
  "giant_payload",
  "unicode_token",
  "no_sub_google",
]);
const isValidAuth = (kind: AuthKind): boolean => VALID_AUTH_KINDS.has(kind);

/** Session bearers (iss …/auth/v1) that reach GET /auth/v1/user and therefore
 * see an injected Supabase Auth fault. */
const SESSION_BEARER_KINDS: ReadonlySet<AuthKind> = new Set<AuthKind>([
  "valid_session",
  "session_unknown_user",
  "session_no_provider",
]);

/** Bearers authenticate() must refuse from the token alone — before any
 * Supabase Auth round trip. */
const STRUCTURALLY_BAD_KINDS: ReadonlySet<AuthKind> = new Set<AuthKind>([
  "missing",
  "empty_bearer",
  "lowercase_scheme",
  "basic_scheme",
  "no_scheme",
  "two_segments",
  "four_segments",
  "bad_base64",
  "non_json_payload",
  "array_payload",
  "no_iss",
  "iss_lookalike",
  "iss_non_string",
  "expired_google",
  "expired_session",
  "exp_negative",
  "latin1_junk",
]);

function buildAuth(
  rng: Prng,
  kind: AuthKind,
): { authorization: string | null; userId: string | null } {
  const now = Math.floor(Date.now() / 1000);
  const userId = rng.uuid();
  const header = { alg: "RS256", typ: "JWT" };
  const google = (extra: Record<string, unknown> = {}) =>
    jwt(header, {
      iss: "https://accounts.google.com",
      sub: userId,
      exp: now + 3600,
      ...extra,
    });
  const apple = () =>
    jwt(header, {
      iss: "https://appleid.apple.com",
      sub: userId,
      exp: now + 3600,
    });
  const session = (extra: Record<string, unknown> = {}) =>
    jwt(
      { alg: "HS256", typ: "JWT" },
      {
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: `sess-${userId}`,
        exp: now + 3600,
        iat: now,
        ...extra,
      },
    );
  const bearer = (token: string) => `Bearer ${token}`;
  switch (kind) {
    case "valid_google":
      return { authorization: bearer(google()), userId };
    case "valid_google_bare_iss":
      // Google documents both `accounts.google.com` and the https:// form.
      return {
        authorization: bearer(google({ iss: "accounts.google.com" })),
        userId,
      };
    case "valid_apple":
      return { authorization: bearer(apple()), userId };
    case "valid_session":
      return { authorization: bearer(session()), userId };
    case "missing":
      return { authorization: null, userId: null };
    case "empty_bearer":
      return {
        authorization: pick(rng, ["Bearer", "Bearer ", "Bearer   "]),
        userId: null,
      };
    case "lowercase_scheme":
      return { authorization: `bearer ${google()}`, userId: null };
    case "basic_scheme":
      return {
        authorization: `Basic ${btoa(`${userId}:secret`)}`,
        userId: null,
      };
    case "no_scheme":
      return { authorization: google(), userId: null };
    case "two_segments":
      return {
        authorization: bearer(google().split(".").slice(0, 2).join(".")),
        userId: null,
      };
    case "four_segments":
      return { authorization: bearer(`${google()}.extra`), userId: null };
    case "bad_base64":
      return {
        authorization: bearer(
          `${b64url("{}")}.${randomString(rng, "!@#$%^&*()", 4, 40)}.sig`,
        ),
        userId: null,
      };
    case "non_json_payload":
      return {
        authorization: bearer(
          `${b64url("{}")}.${b64url("not json at all")}.sig`,
        ),
        userId: null,
      };
    case "array_payload":
      return {
        authorization: bearer(`${b64url("{}")}.${b64url("[1,2,3]")}.sig`),
        userId: null,
      };
    case "no_iss":
      return {
        authorization: bearer(jwt(header, { sub: userId, exp: now + 3600 })),
        userId: null,
      };
    case "iss_lookalike":
      return {
        authorization: bearer(
          jwt(header, {
            iss: pick(rng, [
              "https://accounts.google.com.evil.example",
              "https://accounts.google.com/",
              "http://accounts.google.com",
              "https://accounts.google.com:443",
              "https://appleid.apple.com.evil.example",
              "https://evil.example/accounts.google.com",
              `${SUPABASE_URL}/auth/v1x`,
              `${SUPABASE_URL}/auth/v2`,
              "https://evil.example/auth/v1/",
              " https://accounts.google.com",
            ]),
            sub: userId,
            exp: now + 3600,
          }),
        ),
        userId: null,
      };
    case "iss_non_string":
      return {
        authorization: bearer(
          jwt(header, {
            iss: pick(rng, [
              12345,
              null,
              true,
              ["https://accounts.google.com"],
              { a: 1 },
            ]),
            sub: userId,
            exp: now + 3600,
          }),
        ),
        userId: null,
      };
    case "expired_google":
      return {
        authorization: bearer(google({ exp: now - rng.int(1, 86_400) })),
        userId: null,
      };
    case "expired_session":
      return {
        authorization: bearer(session({ exp: now - rng.int(1, 86_400) })),
        userId: null,
      };
    case "exp_string":
      // A non-numeric exp is not "expired" by the handler's definition; the
      // token is otherwise valid so upstream verification decides (valid).
      return {
        authorization: bearer(google({ exp: String(now + 3600) })),
        userId,
      };
    case "exp_huge":
      return {
        authorization: bearer(google({ exp: Number.MAX_SAFE_INTEGER })),
        userId,
      };
    case "exp_negative":
      return { authorization: bearer(google({ exp: -1 })), userId: null };
    case "no_sub_google":
      // Unique `jti` so consecutive iterations never share the token (the
      // auth cache is keyed by token hash and would otherwise serve them).
      return {
        authorization: bearer(
          jwt(header, {
            iss: "https://accounts.google.com",
            exp: now + 3600,
            jti: userId,
          }),
        ),
        userId: null,
      };
    case "session_unknown_user":
      return {
        authorization: bearer(session({ sub: `unknown-${userId}` })),
        userId: null,
      };
    case "session_no_provider":
      return {
        authorization: bearer(session({ sub: `noprov-${userId}` })),
        userId: null,
      };
    case "giant_payload":
      return {
        authorization: bearer(
          google({ pad: randomString(rng, ALNUM, 20_000, 60_000) }),
        ),
        userId,
      };
    case "latin1_junk":
      return {
        authorization: `Bearer ${latin1Junk(rng, 1, 200)}`,
        userId: null,
      };
    case "unicode_token":
      return {
        authorization: bearer(
          `${b64url("{}")}.${
            b64url(
              JSON.stringify({
                iss: "https://accounts.google.com",
                sub: "ünïcödé-ユーザー",
                exp: now + 3600,
              }),
            )
          }.sig`,
        ),
        userId: null,
      };
  }
}

function buildPath(rng: Prng, cls: PathClass): string {
  switch (cls) {
    case "canonical":
      return CANONICAL_URL_PATH;
    case "api_prefix":
      return `/api${ROUTE_PATH}`;
    case "bare_v1":
      return ROUTE_PATH;
    case "double_v1_prefix":
      return `/v1/${randomString(rng, ALNUM, 1, 12)}${CANONICAL_URL_PATH}`;
    case "dot_segment_normalises":
      return `/functions/v1/api/v1/training-plans/${
        randomString(rng, ALNUM, 1, 8)
      }/../current`;
    case "trailing_slash":
      return `${CANONICAL_URL_PATH}/`;
    case "double_slash":
      return pick(rng, [
        "/functions/v1/api/v1//training-plans/current",
        "/functions/v1/api/v1/training-plans//current",
        "/functions/v1/api//v1/training-plans/current",
      ]);
    case "leading_double_slash":
      return `/${CANONICAL_URL_PATH}`;
    case "upper_case":
      return CANONICAL_URL_PATH.toUpperCase();
    case "mixed_case":
      return CANONICAL_URL_PATH.replace(
        /[a-z]/g,
        (c) => (chance(rng, 0.3) ? c.toUpperCase() : c),
      );
    case "percent_encoded_slash":
      return pick(rng, [
        "/functions/v1/api/v1/training-plans%2Fcurrent",
        "/functions/v1/api/v1%2Ftraining-plans/current",
        "/functions/v1/api/v1/training-plans/current%2F",
        "/functions/v1/api%2Fv1/training-plans/current",
      ]);
    case "percent_encoded_letter":
      return pick(rng, [
        "/functions/v1/api/v1/training%2Dplans/current",
        "/functions/v1/api/v1/training-plans/%63urrent",
        "/functions/v1/api/%76%31/training-plans/current",
        "/functions/v1/api/v1/training-plans/current%20",
      ]);
    case "encoded_traversal":
      return pick(rng, [
        "/functions/v1/api/v1/training-plans/%2e%2e/training-plans/current",
        "/functions/v1/api/v1/training-plans/current/%2e%2e",
        "/functions/v1/api/v1/..%2ftraining-plans/current",
        "/functions/v1/api/v1/training-plans/current/..%00",
      ]);
    case "null_byte":
      return pick(rng, [
        "/functions/v1/api/v1/training-plans/current%00",
        "/functions/v1/api/v1/training-plans%00/current",
        "/functions/v1/api/v1/training-plans/current%00.json",
      ]);
    case "extra_suffix":
      return `${CANONICAL_URL_PATH}${
        pick(rng, [
          "/",
          "/x",
          ".json",
          "/../current",
          "/current",
          ";jsessionid=1",
          "/%2e",
        ])
      }`;
    case "sibling_training_plans":
      return "/functions/v1/api/v1/training-plans";
    case "parent_only":
      return pick(rng, [
        "/functions/v1/api/v1/",
        "/functions/v1/api/v1",
        "/functions/v1/api/",
      ]);
    case "junk_segment":
      return `/functions/v1/api/v1/training-plans/${
        randomString(rng, PATH_JUNK, 1, 40)
      }`;
    case "unicode_segment":
      return `/functions/v1/api/v1/training-plans/${
        pick(rng, ["現在", "cürrent", "current\u200b", "curr\u0435nt", "🏓"])
      }`;
    case "long_path":
      return `${CANONICAL_URL_PATH}/${randomString(rng, ALNUM, 2_000, 8_000)}`;
    case "huge_path":
      return `/functions/v1/api/v1/${
        randomString(rng, ALNUM, 60_000, 120_000)
      }/training-plans/current`;
    case "backslash":
      return pick(rng, [
        "/functions/v1/api/v1\\training-plans/current",
        "/functions/v1/api/v1/training-plans\\current",
        "\\functions\\v1\\api\\v1\\training-plans\\current",
      ]);
    case "no_v1":
      return pick(rng, [
        "/training-plans/current",
        "/functions/api/training-plans/current",
        "/",
        "/v2/training-plans/current",
      ]);
    case "space_in_segment":
      return pick(rng, [
        "/functions/v1/api/v1/training-plans/current ",
        "/functions/v1/api/v1/training plans/current",
        "/functions/v1/api/v1/training-plans/ current",
      ]);
    case "other_route_shape":
      // Shapes that brush the parameterised-route regexes without matching a
      // real route (real sibling routes are other units' business).
      return pick(rng, [
        "/functions/v1/api/v1/training-plans/current/finalize",
        "/functions/v1/api/v1/training-plans/current/feedback",
        "/functions/v1/api/v1/me/training-plans/current",
        "/functions/v1/api/v1/training-plans:current",
        "/functions/v1/api/v1/sessions/training-plans/current/finalize",
      ]);
  }
}

function buildQuery(rng: Prng, cls: QueryClass): string {
  switch (cls) {
    case "none":
      return "";
    case "simple":
      return `?${randomString(rng, ALNUM, 1, 8)}=${
        randomString(rng, ALNUM, 0, 16)
      }`;
    case "many_params": {
      const n = rng.int(20, 200);
      return `?${
        Array.from({ length: n }, (_, i) =>
          `p${i}=${randomString(rng, ALNUM, 0, 6)}`).join("&")
      }`;
    }
    case "repeated_param": {
      const key = randomString(rng, ALNUM, 1, 6);
      return `?${
        Array.from({ length: rng.int(2, 30) }, () =>
          `${key}=${randomString(rng, ALNUM, 0, 6)}`).join("&")
      }`;
    }
    case "huge_value":
      return `?q=${randomString(rng, ALNUM, 20_000, 80_000)}`;
    case "junk_chars":
      return `?${randomString(rng, PATH_JUNK, 1, 120)}`;
    case "encoded_chars":
      return `?${
        pick(rng, [
          "a=%00",
          "a=%2f%2e%2e",
          "a=%ZZ",
          "%3Fb=%26",
          "a=%E2%82",
          "a=%FF%FE",
        ])
      }`;
    case "array_syntax":
      return `?${
        pick(rng, [
          "a[]=1&a[]=2",
          "a[b][c]=1",
          "a[0]=x&a[1]=y",
          "a[__proto__][x]=1",
        ])
      }`;
    case "empty_marker":
      return pick(rng, ["?", "?&", "?=", "?&&&", "?=&="]);
    case "proto_pollution":
      return `?${
        pick(rng, [
          "__proto__=1",
          "constructor[prototype][x]=1",
          "__proto__[polluted]=1",
          "prototype=1",
        ])
      }`;
    case "unicode":
      return `?${pick(rng, ["q=現在", "q=🏓", "ünï=cödé", "q=\u202e"])}`;
  }
}

function buildIp(
  rng: Prng,
  kind: IpKind,
  index: number,
): Record<string, string> {
  // Unique per iteration so per-IP budgets (1200/min, 30 auth failures/5min)
  // never mask an outcome; rate limiting itself is exercised in a dedicated
  // scenario below.
  const unique = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${
    index & 255
  }`;
  switch (kind) {
    case "xff_unique":
      return { "x-forwarded-for": unique };
    case "xff_multi_hop":
      return {
        "x-forwarded-for": `${
          Array.from({ length: rng.int(1, 6) }, () =>
            `203.0.113.${rng.int(1, 254)}`).join(", ")
        }, ${unique}`,
      };
    case "cf_connecting_ip":
      return { "cf-connecting-ip": unique };
    case "cf_overrides_xff":
      return { "cf-connecting-ip": unique, "x-forwarded-for": "203.0.113.1" };
    case "xff_garbage_with_cf":
      return {
        "cf-connecting-ip": unique,
        "x-forwarded-for": randomString(rng, HEADER_SAFE, 1, 200),
      };
    case "xff_empty_hops_with_cf":
      return {
        "cf-connecting-ip": unique,
        "x-forwarded-for": pick(rng, [",", ", ,", "   ", ",,,,", " , "]),
      };
    case "xff_huge_with_cf":
      return {
        "cf-connecting-ip": unique,
        "x-forwarded-for": Array.from({ length: 2_000 }, () => "1.2.3.4").join(
          ",",
        ),
      };
    case "no_ip_header":
      return {};
  }
}

function buildRequestId(rng: Prng, kind: RequestIdKind): string | null {
  switch (kind) {
    case "absent":
      return null;
    case "well_formed":
      return randomString(rng, `${ALNUM}._-`, 8, 64);
    case "well_formed_max":
      return randomString(rng, `${ALNUM}._-`, 64, 64);
    case "too_short":
      return randomString(rng, ALNUM, 1, 7);
    case "too_long":
      return randomString(rng, ALNUM, 65, 400);
    case "bad_chars":
      return `${randomString(rng, ALNUM, 4, 20)}${
        pick(rng, [" ", "/", ":", "<", '"', "%", "ü", "ÿ", "\u007f", "\t"])
      }${randomString(rng, ALNUM, 4, 20)}`;
    case "whitespace_padded_ok":
      return `  ${randomString(rng, ALNUM, 8, 30)}  `;
    case "junk":
      return latin1Junk(rng, 1, 120);
    case "empty":
      return "";
  }
}

function buildExtraHeaders(
  rng: Prng,
): { headers: Record<string, string>; classes: string[] } {
  const headers: Record<string, string> = {};
  const classes: string[] = [];
  const add = (cls: string, name: string, value: string) => {
    headers[name] = value;
    classes.push(cls);
  };
  if (chance(rng, 0.15)) {
    add(
      "accept_junk",
      "accept",
      pick(rng, [
        "text/html",
        "*/*;q=0",
        randomString(rng, HEADER_SAFE, 1, 60),
        "application/xml",
      ]),
    );
  }
  if (chance(rng, 0.1)) {
    add(
      "accept_encoding",
      "accept-encoding",
      pick(rng, [
        "gzip, br",
        "identity",
        randomString(rng, HEADER_SAFE, 1, 30),
      ]),
    );
  }
  if (chance(rng, 0.1)) {
    add(
      "origin",
      "origin",
      pick(rng, ["https://evil.example", "null", "http://localhost:3000"]),
    );
  }
  if (chance(rng, 0.1)) {
    add(
      "host_override",
      "host",
      pick(rng, ["evil.example", "localhost", "127.0.0.1:1"]),
    );
  }
  if (chance(rng, 0.08)) {
    add("apikey", "apikey", randomString(rng, ALNUM, 1, 80));
  }
  if (chance(rng, 0.08)) {
    add(
      "cookie",
      "cookie",
      `sb-access-token=${randomString(rng, ALNUM, 1, 200)}`,
    );
  }
  if (chance(rng, 0.08)) {
    add(
      "x_forwarded_proto",
      "x-forwarded-proto",
      pick(rng, ["http", "javascript:", randomString(rng, ALNUM, 1, 10)]),
    );
  }
  if (chance(rng, 0.08)) {
    add(
      "if_none_match",
      "if-none-match",
      pick(rng, ["*", `"${randomString(rng, ALNUM, 1, 30)}"`]),
    );
  }
  if (chance(rng, 0.08)) {
    add(
      "range",
      "range",
      pick(rng, ["bytes=0-0", "bytes=-1", "bytes=999999999-"]),
    );
  }
  if (chance(rng, 0.06)) {
    add(
      "transfer_encoding",
      "transfer-encoding",
      pick(rng, ["chunked", "gzip, chunked"]),
    );
  }
  if (chance(rng, 0.06)) add("expect", "expect", "100-continue");
  if (chance(rng, 0.06)) add("upgrade", "upgrade", "websocket");
  if (chance(rng, 0.2)) {
    const n = rng.int(1, 8);
    for (let i = 0; i < n; i += 1) {
      add(
        "random_header",
        `x-fz-${randomString(rng, ALNUM, 1, 20)}`,
        latin1Junk(rng, 0, 300),
      );
    }
  }
  if (chance(rng, 0.03)) {
    add(
      "giant_header",
      "x-fz-giant",
      randomString(rng, ALNUM, 50_000, 120_000),
    );
  }
  if (chance(rng, 0.03)) add("many_headers", "x-fz-many", "1");
  if (classes.includes("many_headers")) {
    for (let i = 0; i < 300; i += 1) headers[`x-fz-m${i}`] = String(i);
  }
  return { headers, classes };
}

function buildBody(
  rng: Prng,
  kind: BodyKind,
): {
  body: string | Uint8Array<ArrayBuffer> | null;
  declaredContentLength: string | null;
  contentType: string | null;
} {
  const ct = () =>
    chance(rng, 0.7) ? "application/json" : pick(rng, [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      randomString(rng, HEADER_SAFE, 1, 40),
      "",
    ]);
  switch (kind) {
    case "none":
      return { body: null, declaredContentLength: null, contentType: null };
    case "empty":
      return { body: "", declaredContentLength: null, contentType: ct() };
    case "json_object":
      return {
        body: JSON.stringify({
          [randomString(rng, ALNUM, 1, 10)]: randomString(
            rng,
            PATH_JUNK,
            0,
            50,
          ),
          n: rng.int(-1e9, 1e9),
          deep: { a: { b: { c: [1, 2, { d: null }] } } },
          __proto__: { polluted: true },
        }),
        declaredContentLength: null,
        contentType: ct(),
      };
    case "json_array":
      return {
        body: JSON.stringify(
          Array.from({ length: rng.int(0, 50) }, () => rng.int(0, 9)),
        ),
        declaredContentLength: null,
        contentType: ct(),
      };
    case "json_scalar":
      return {
        body: pick(rng, ["null", "true", "0", '"str"', "1e309", "-0"]),
        declaredContentLength: null,
        contentType: ct(),
      };
    case "invalid_json":
      return {
        body: pick(rng, [
          "{",
          '{"a":',
          "[1,2,",
          "{'a':1}",
          "undefined",
          "NaN",
          "\uFEFF{}",
          randomString(rng, PATH_JUNK, 1, 200),
        ]),
        declaredContentLength: null,
        contentType: ct(),
      };
    case "binary_junk": {
      const bytes = new Uint8Array(new ArrayBuffer(rng.int(1, 4_096)));
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = rng.int(0, 255);
      return { body: bytes, declaredContentLength: null, contentType: ct() };
    }
    case "large_under_cap":
      return {
        body: `{"pad":"${"x".repeat(rng.int(100_000, 1_000_000))}"}`,
        declaredContentLength: null,
        contentType: "application/json",
      };
    case "spoof_length_over_cap":
      return {
        body: null,
        declaredContentLength: String(
          pick(rng, [
            MAX_JSON_BODY_BYTES + 1,
            MAX_JSON_BODY_BYTES + rng.int(2, 1e9),
            9_007_199_254_740_991,
            1e21,
          ]),
        ),
        contentType: null,
      };
    case "spoof_length_garbage":
      return {
        body: null,
        declaredContentLength: pick(rng, [
          "abc",
          "Infinity",
          "NaN",
          "0x10",
          "1e400",
          " 5000001",
          "5000001 ",
          "",
          "1,2",
        ]),
        contentType: null,
      };
    case "spoof_length_negative":
      return {
        body: null,
        declaredContentLength: String(-rng.int(1, 1e9)),
        contentType: null,
      };
    case "spoof_length_at_cap":
      return {
        body: null,
        declaredContentLength: String(
          pick(rng, [MAX_JSON_BODY_BYTES, MAX_JSON_BODY_BYTES - 1, 0]),
        ),
        contentType: null,
      };
  }
}

function planFor(index: number, seed: number): Plan {
  const rng = new Prng(seed);
  const [methodClass, method] = weighted(rng, METHOD_TABLE, (row) => row[2]);
  const [pathClass] = weighted(rng, PATH_CLASSES, (row) => row[1]);
  const [queryClass] = weighted(rng, QUERY_CLASSES, (row) => row[1]);
  const [authKind] = weighted(rng, AUTH_KINDS, (row) => row[1]);
  let [ipKind] = weighted(rng, IP_KINDS, (row) => row[1]);
  // Requests without any IP header all share the "unknown" budget; keep them
  // to valid bearers so the 30-failures/5min budget for that key is never spent
  // (a 429 there would be legitimate but would hide the input's own verdict).
  if (ipKind === "no_ip_header" && !isValidAuth(authKind)) {
    ipKind = "xff_unique";
  }
  const [requestIdKind] = weighted(rng, REQUEST_ID_KINDS, (row) => row[1]);
  const isBodyless = method.toUpperCase() === "GET" ||
    method.toUpperCase() === "HEAD";
  const [bodyKind] = weighted(
    rng,
    isBodyless ? BODY_KINDS_GET : BODY_KINDS_NON_GET,
    (row) => row[1],
  );
  const [upstream] = weighted(rng, UPSTREAM_FAULTS, (row) => row[1]);
  const auth = buildAuth(rng, authKind);
  const extra = buildExtraHeaders(rng);
  const body = buildBody(rng, bodyKind);
  return {
    index,
    seed,
    method,
    methodClass,
    urlPath: buildPath(rng, pathClass),
    pathClass,
    query: buildQuery(rng, queryClass),
    queryClass,
    authKind,
    authorization: auth.authorization,
    userId: auth.userId,
    ipKind,
    ipHeaders: buildIp(rng, ipKind, index),
    requestIdKind,
    requestIdSent: buildRequestId(rng, requestIdKind),
    extraHeaders: extra.headers,
    extraHeaderClasses: extra.classes,
    bodyKind,
    body: body.body,
    declaredContentLength: body.declaredContentLength,
    contentType: body.contentType,
    upstream,
  };
}

function requestFor(plan: Plan): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(plan.extraHeaders)) {
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(plan.ipHeaders)) {
    headers.set(name, value);
  }
  if (plan.authorization !== null) {
    headers.set("authorization", plan.authorization);
  }
  if (plan.requestIdSent !== null) {
    headers.set("x-request-id", plan.requestIdSent);
  }
  if (plan.contentType !== null) headers.set("content-type", plan.contentType);
  if (plan.declaredContentLength !== null) {
    headers.set("content-length", plan.declaredContentLength);
  }
  return new Request(`http://edge.test${plan.urlPath}${plan.query}`, {
    method: plan.method,
    headers,
    body: plan.body === null ? undefined : plan.body,
  });
}

// ── Upstream: Supabase Auth GET /auth/v1/user for session bearers + faults ───

interface FaultState {
  current: UpstreamFault;
  calls: RecordedCall[];
  /** Peel this layer off again, leaving the harness' own stub in place for
   * later test files in the same isolate (loadHarness installs it once). */
  restore(): void;
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

function bearerOf(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const seg = token.split(".")[1];
  if (!seg) return null;
  try {
    const raw = seg.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(
      atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Layer the session-bearer verification (and fault injection) over the
 * harness' fetch stub; everything else falls through to routesHarness. */
function installUpstream(h: Harness): FaultState {
  const base = globalThis.fetch;
  const state: FaultState = {
    current: "healthy",
    calls: [],
    restore() {
      globalThis.fetch = base;
    },
  };
  globalThis.fetch =
    ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const record: RecordedCall = {
        url: request.url,
        method: request.method,
        headers: {},
        body: null,
      };
      request.headers.forEach((
        value,
        key,
      ) => (record.headers[key.toLowerCase()] = value));
      state.calls.push(record);
      if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
        switch (state.current) {
          case "auth_user_500":
            return Promise.resolve(
              new Response("internal error at /srv/gotrue/user.go:42", {
                status: 500,
              }),
            );
          case "auth_user_throw":
            return Promise.reject(
              new TypeError("connection reset by peer (injected)"),
            );
          case "auth_user_garbage_2xx":
            return Promise.resolve(
              new Response("<html>not json</html>", { status: 200 }),
            );
          case "auth_user_429":
            return Promise.resolve(
              jsonResponse(429, { message: "over request rate limit" }, {
                "Retry-After": "7",
              }),
            );
          case "auth_user_403":
            return Promise.resolve(
              jsonResponse(403, { message: "invalid claim: missing sub" }),
            );
          default:
            break;
        }
        const payload = jwtPayload(bearerOf(request));
        const sub = typeof payload?.sub === "string" ? payload.sub : "";
        if (!sub || sub.startsWith("unknown-")) {
          return Promise.resolve(
            jsonResponse(401, {
              code: 401,
              msg: "invalid JWT: unable to parse or verify signature",
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, {
          id: sub,
          aud: "authenticated",
          role: "authenticated",
          email: "user@example.com",
          app_metadata: sub.startsWith("noprov-")
            ? {}
            : { provider: "google", providers: ["google"] },
          user_metadata: {},
          created_at: new Date().toISOString(),
        }));
      }
      if (
        state.current === "auth_token_500" &&
        request.url.startsWith(`${SUPABASE_URL}/auth/v1/token`)
      ) {
        return Promise.resolve(new Response("gateway error", { status: 502 }));
      }
      return base(request);
    }) as typeof fetch;
  h.calls.length = 0;
  return state;
}

// ── Oracle ───────────────────────────────────────────────────────────────────

const WRITE_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
]);

const isWriteCall = (call: RecordedCall): boolean =>
  WRITE_METHODS.has(call.method.toUpperCase()) &&
  (call.url.startsWith(`${SUPABASE_URL}/rest/v1/`) ||
    call.url.startsWith(RC_URL) ||
    call.url.startsWith(`${SUPABASE_URL}/auth/v1/admin/`) ||
    call.url.startsWith(`${SUPABASE_URL}/auth/v1/logout`));

interface Expectation {
  allowed: number[];
  exactBody: string | null;
  label: string;
}

function expectationFor(plan: Plan, pathname: string): Expectation {
  const v1 = pathname.lastIndexOf("/v1/");
  const normalised = v1 >= 0 ? pathname.slice(v1) : pathname;
  const method = plan.method.toUpperCase();
  const routeHit = method === "GET" && normalised === ROUTE_PATH;
  const declared = plan.declaredContentLength === null
    ? 0
    : Number(plan.declaredContentLength);
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    return {
      allowed: [413],
      exactBody: null,
      label: "oversized_declared_body",
    };
  }
  const valid = isValidAuth(plan.authKind);
  const sessionBearer = SESSION_BEARER_KINDS.has(plan.authKind);
  const providerBearer = valid && !sessionBearer;
  if (
    sessionBearer && plan.upstream !== "healthy" &&
    plan.upstream !== "auth_token_500"
  ) {
    // Supabase Auth itself is consulted for these bearers, so an injected
    // fault decides: refusal (403) → 401, anything else → generic 503.
    if (plan.upstream === "auth_user_403") {
      return {
        allowed: [401],
        exactBody: null,
        label: "auth_refused_upstream",
      };
    }
    return {
      allowed: [503],
      exactBody: null,
      label: "auth_unavailable_upstream",
    };
  }
  if (!valid) return { allowed: [401], exactBody: null, label: "bad_bearer" };
  if (providerBearer && plan.upstream === "auth_token_500") {
    return {
      allowed: [401],
      exactBody: null,
      label: "provider_exchange_failed",
    };
  }
  if (routeHit) {
    return {
      allowed: [200],
      exactBody: JSON.stringify({ plan: null }),
      label: "route_hit",
    };
  }
  if (method === "POST" && normalised === "/v1/training-plans") {
    return {
      allowed: [409],
      exactBody: null,
      label: "sibling_post_training_plans",
    };
  }
  return { allowed: [404, 400], exactBody: null, label: "unknown_endpoint" };
}

interface Outcome {
  index: number;
  seed: number;
  replay: string;
  request: {
    method: string;
    url: string;
    pathClass: PathClass;
    queryClass: QueryClass;
    authKind: AuthKind;
    ipKind: IpKind;
    requestIdKind: RequestIdKind;
    requestIdSent: string | null;
    extraHeaderClasses: string[];
    bodyKind: BodyKind;
    bodyBytes: number;
    declaredContentLength: string | null;
    upstream: UpstreamFault;
  };
  expected: Expectation;
  status: number | null;
  requestId: string | null;
  bodyLength: number;
  bodyPreview: string;
  contentType: string | null;
  retryAfter: string | null;
  upstreamCalls: string[];
  writes: number;
  durationMs: number;
  violations: string[];
  verdict: "HELD" | "BROKEN" | "CONSTRUCT_REJECTED";
  constructError?: string;
}

function replayCommand(seed: number): string {
  return `cd supabase/functions/api/__wf__ && STRESS_REPLAY_SEED=${seed} deno test -A --no-check --config deno.json stress_training_plans_current_fuzz.test.ts --filter fuzz`;
}

async function runIteration(
  h: Harness,
  fault: FaultState,
  plan: Plan,
): Promise<Outcome> {
  const url = `http://edge.test${plan.urlPath}${plan.query}`;
  const base: Outcome = {
    index: plan.index,
    seed: plan.seed,
    replay: replayCommand(plan.seed),
    request: {
      method: plan.method,
      url: url.length > 512
        ? `${url.slice(0, 512)}…(+${url.length - 512} chars)`
        : url,
      pathClass: plan.pathClass,
      queryClass: plan.queryClass,
      authKind: plan.authKind,
      ipKind: plan.ipKind,
      requestIdKind: plan.requestIdKind,
      requestIdSent:
        plan.requestIdSent !== null && plan.requestIdSent.length > 80
          ? `${plan.requestIdSent.slice(0, 80)}…(+${
            plan.requestIdSent.length - 80
          })`
          : plan.requestIdSent,
      extraHeaderClasses: plan.extraHeaderClasses,
      bodyKind: plan.bodyKind,
      bodyBytes: plan.body === null
        ? 0
        : typeof plan.body === "string"
        ? new TextEncoder().encode(plan.body).length
        : plan.body.length,
      declaredContentLength: plan.declaredContentLength,
      upstream: plan.upstream,
    },
    expected: { allowed: [], exactBody: null, label: "" },
    status: null,
    requestId: null,
    bodyLength: 0,
    bodyPreview: "",
    contentType: null,
    retryAfter: null,
    upstreamCalls: [],
    writes: 0,
    durationMs: 0,
    violations: [],
    verdict: "HELD",
  };

  let request: Request;
  try {
    request = requestFor(plan);
  } catch (error) {
    // The Fetch API refused to even build this request (it can never reach
    // the handler over the wire either); not counted as an executed scenario.
    base.verdict = "CONSTRUCT_REJECTED";
    base.constructError = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    return base;
  }
  base.expected = expectationFor(plan, new URL(request.url).pathname);

  fault.current = plan.upstream;
  fault.calls = [];
  h.calls.length = 0;
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await h.handler(request);
  } catch (error) {
    base.durationMs = performance.now() - startedAt;
    base.violations.push(
      `handler threw: ${
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
      }`,
    );
    base.verdict = "BROKEN";
    return base;
  } finally {
    fault.current = "healthy";
  }
  base.durationMs = performance.now() - startedAt;
  const text = await response.text();
  base.status = response.status;
  base.requestId = response.headers.get("x-request-id");
  base.bodyLength = text.length;
  base.bodyPreview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  base.contentType = response.headers.get("content-type");
  base.retryAfter = response.headers.get("retry-after");
  base.upstreamCalls = fault.calls.map((c) =>
    `${c.method} ${c.url.replace(/[?].*$/, "?…")}`
  );
  base.writes = fault.calls.filter(isWriteCall).length;

  const v = base.violations;
  const { allowed, exactBody } = base.expected;

  // 1. status is in the oracle's allowed set; bad input never 2xx/5xx.
  if (!allowed.includes(response.status)) {
    v.push(
      `status ${response.status} not in expected [${
        allowed.join(",")
      }] (${base.expected.label})`,
    );
  }
  if (response.status >= 500 && plan.upstream === "healthy") {
    v.push(`5xx (${response.status}) without any injected upstream fault`);
  }
  if (
    response.status >= 400 && response.status < 500 &&
    !BAD_INPUT_STATUSES.has(response.status) &&
    base.expected.label !== "sibling_post_training_plans"
  ) {
    v.push(`4xx ${response.status} outside the allowed rejection set`);
  }
  if (
    response.status >= 200 && response.status < 300 &&
    base.expected.label !== "route_hit"
  ) {
    v.push(
      `2xx (${response.status}) for input the oracle classified as ${base.expected.label}`,
    );
  }

  // 2. exact success body.
  if (exactBody !== null && response.status === 200 && text !== exactBody) {
    v.push(`200 body ${JSON.stringify(text.slice(0, 120))} !== ${exactBody}`);
  }

  // 3. generic 5xx: stable message, Retry-After, no upstream detail.
  if (response.status >= 500) {
    let message = "";
    try {
      const parsed = JSON.parse(text);
      message = typeof parsed?.error?.message === "string"
        ? parsed.error.message
        : "";
    } catch {
      v.push("5xx body is not JSON");
    }
    if (!GENERIC_5XX_RE.test(message)) {
      v.push(
        `5xx message not generic: ${JSON.stringify(message.slice(0, 120))}`,
      );
    }
    if (
      /injected|gotrue|reset by peer|html|HTTP \d|attempts|unreachable/i.test(
        text,
      )
    ) v.push("5xx body leaks upstream detail");
    if (response.status === 503 && base.retryAfter === null) {
      v.push("503 without Retry-After");
    }
  }

  // 4. stack-trace markers anywhere in the body (unless the marker was the
  //    client's own input reflected, which is recorded separately).
  for (const marker of STACK_MARKERS) {
    const m = marker.exec(text);
    if (
      m && !url.includes(m[0]) && !(plan.authorization ?? "").includes(m[0])
    ) {
      v.push(
        `body matches stack/detail marker ${marker}: ${JSON.stringify(m[0])}`,
      );
    }
  }

  // 5. no write for ANY request on a static route.
  if (base.writes > 0) {
    v.push(
      `${base.writes} write call(s) issued: ${
        fault.calls.filter(isWriteCall).map((c) => `${c.method} ${c.url}`).join(
          "; ",
        )
      }`,
    );
  }
  if (fault.calls.some((c) => c.url.startsWith(`${SUPABASE_URL}/rest/v1/`))) {
    v.push("PostgREST contacted for a static route");
  }
  if (fault.calls.some((c) => c.url.startsWith(RC_URL))) {
    v.push("RevenueCat contacted for a static route");
  }
  if (STRUCTURALLY_BAD_KINDS.has(plan.authKind)) {
    const authCalls = fault.calls.filter((c) =>
      c.url.startsWith(`${SUPABASE_URL}/auth/v1/`)
    );
    if (authCalls.length > 0) {
      v.push(
        `bearer of kind ${plan.authKind} reached Supabase Auth (${authCalls.length} call(s))`,
      );
    }
  }

  // 6. request-id contract.
  const rid = base.requestId;
  if (rid === null) v.push("x-request-id missing");
  else {
    if (!REQUEST_ID_RE.test(rid)) {
      v.push(`x-request-id malformed: ${JSON.stringify(rid.slice(0, 80))}`);
    }
    const sent = plan.requestIdSent?.trim() ?? "";
    if (sent && REQUEST_ID_RE.test(sent)) {
      if (rid !== sent) {
        v.push(
          `well-formed client x-request-id not echoed (${
            JSON.stringify(sent)
          } → ${JSON.stringify(rid)})`,
        );
      }
    } else {
      if (!UUID_RE.test(rid)) {
        v.push(
          `minted x-request-id is not a UUID: ${
            JSON.stringify(rid.slice(0, 80))
          }`,
        );
      }
      if (
        plan.requestIdSent !== null && plan.requestIdSent !== "" &&
        rid === plan.requestIdSent
      ) v.push("malformed client x-request-id echoed verbatim");
    }
  }

  // 7. JSON security headers on every JSON answer.
  if (response.status !== 204 && text.length > 0) {
    if (!(base.contentType ?? "").includes("application/json")) {
      v.push(`content-type ${base.contentType} is not JSON`);
    }
    if (response.headers.get("x-content-type-options") !== "nosniff") {
      v.push("missing X-Content-Type-Options: nosniff");
    }
    if (response.headers.get("cache-control") !== "no-store") {
      v.push("missing Cache-Control: no-store");
    }
  }
  if (response.status === 429 && base.retryAfter === null) {
    v.push("429 without Retry-After");
  }

  base.verdict = v.length === 0 ? "HELD" : "BROKEN";
  return base;
}

// ── Campaign ─────────────────────────────────────────────────────────────────

interface Summary {
  route: string;
  campaignSeed: number;
  requestedIterations: number;
  executed: number;
  constructRejected: number;
  held: number;
  broken: number;
  fiveXX: number;
  fiveXXInduced: number;
  fiveXXUninduced: number;
  statuses: Record<string, number>;
  expectedLabels: Record<string, number>;
  authKinds: Record<string, number>;
  pathClasses: Record<string, number>;
  bodyKinds: Record<string, number>;
  upstreamFaults: Record<string, number>;
  requestIdKinds: Record<string, number>;
  maxDurationMs: number;
  p99DurationMs: number;
  totalDurationMs: number;
  writesTotal: number;
  brokenSeeds: Array<{ seed: number; violations: string[]; replay: string }>;
  fiveXXSeeds: Array<
    {
      seed: number;
      status: number;
      upstream: UpstreamFault;
      authKind: AuthKind;
      bodyPreview: string;
      replay: string;
    }
  >;
  reflectedPathIn404: number;
  largest404BodyBytes: number;
  replayFull: string;
}

function summarise(
  outcomes: Outcome[],
  campaignSeed: number,
  requested: number,
): Summary {
  const executed = outcomes.filter((o) => o.verdict !== "CONSTRUCT_REJECTED");
  const durations = executed.map((o) => o.durationMs).sort((a, b) => a - b);
  const fiveXX = executed.filter((o) => (o.status ?? 0) >= 500);
  const notFound = executed.filter((o) => o.status === 404);
  return {
    route: `GET ${ROUTE_PATH}`,
    campaignSeed,
    requestedIterations: requested,
    executed: executed.length,
    constructRejected: outcomes.length - executed.length,
    held: executed.filter((o) => o.verdict === "HELD").length,
    broken: executed.filter((o) => o.verdict === "BROKEN").length,
    fiveXX: fiveXX.length,
    fiveXXInduced:
      fiveXX.filter((o) => o.request.upstream !== "healthy").length,
    fiveXXUninduced:
      fiveXX.filter((o) => o.request.upstream === "healthy").length,
    statuses: histogram(executed.map((o) => o.status ?? -1)),
    expectedLabels: histogram(executed.map((o) => o.expected.label)),
    authKinds: histogram(executed.map((o) => o.request.authKind)),
    pathClasses: histogram(executed.map((o) => o.request.pathClass)),
    bodyKinds: histogram(executed.map((o) => o.request.bodyKind)),
    upstreamFaults: histogram(executed.map((o) => o.request.upstream)),
    requestIdKinds: histogram(executed.map((o) => o.request.requestIdKind)),
    maxDurationMs: durations.length ? durations[durations.length - 1] : 0,
    p99DurationMs: durations.length
      ? durations[
        Math.min(durations.length - 1, Math.floor(durations.length * 0.99))
      ]
      : 0,
    totalDurationMs: durations.reduce((a, b) => a + b, 0),
    writesTotal: executed.reduce((a, o) => a + o.writes, 0),
    brokenSeeds: executed
      .filter((o) => o.verdict === "BROKEN")
      .map((o) => ({
        seed: o.seed,
        violations: o.violations,
        replay: o.replay,
      })),
    fiveXXSeeds: fiveXX.map((o) => ({
      seed: o.seed,
      status: o.status ?? -1,
      upstream: o.request.upstream,
      authKind: o.request.authKind,
      bodyPreview: o.bodyPreview,
      replay: o.replay,
    })),
    reflectedPathIn404:
      notFound.filter((o) => o.bodyPreview.includes("Unknown endpoint: "))
        .length,
    largest404BodyBytes: notFound.reduce(
      (max, o) => Math.max(max, o.bodyLength),
      0,
    ),
    replayFull:
      `cd supabase/functions/api/__wf__ && STRESS_ITER=${requested} STRESS_SEED=${campaignSeed} deno test -A --no-check --config deno.json stress_training_plans_current_fuzz.test.ts`,
  };
}

async function writeArtifacts(name: string, payload: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(payload, null, 2));
  return path;
}

Deno.test("fuzz: GET /v1/training-plans/current — seeded request campaign against the real handler", async (t) => {
  const h = await loadHarness();
  const fault = installUpstream(h);
  try {
    const seeds: Array<{ index: number; seed: number }> = REPLAY_SEED
      ? [{ index: 0, seed: Number(REPLAY_SEED) >>> 0 }]
      : Array.from(
        { length: STRESS_ITER },
        (_, index) => ({ index, seed: iterationSeed(STRESS_SEED, index) }),
      );

    const outcomes: Outcome[] = [];
    for (const { index, seed } of seeds) {
      outcomes.push(await runIteration(h, fault, planFor(index, seed)));
    }
    const summary = summarise(outcomes, STRESS_SEED, seeds.length);
    const resultsPath = await writeArtifacts(
      REPLAY_SEED ? `replay-${REPLAY_SEED}` : "results",
      {
        summary,
        rows: outcomes,
      },
    );
    const summaryPath = await writeArtifacts(
      REPLAY_SEED ? `replay-${REPLAY_SEED}-summary` : "summary",
      summary,
    );
    // Compact seed → outcome table (one row per iteration) for quick diffing.
    await writeArtifacts(
      REPLAY_SEED ? `replay-${REPLAY_SEED}-seed-table` : "seed-table",
      outcomes.map((o) => ({
        seed: o.seed,
        method: o.request.method,
        path: o.request.pathClass,
        auth: o.request.authKind,
        body: o.request.bodyKind,
        upstream: o.request.upstream,
        expected: o.expected.label,
        status: o.status,
        requestId: o.requestId !== null,
        writes: o.writes,
        verdict: o.verdict,
      })),
    );
    console.log(
      `[stress] executed=${summary.executed} held=${summary.held} broken=${summary.broken} 5xx=${summary.fiveXX} (induced=${summary.fiveXXInduced}) statuses=${
        JSON.stringify(summary.statuses)
      } → ${resultsPath}, ${summaryPath}`,
    );

    await t.step("every executed iteration held its invariants", () => {
      const broken = summary.brokenSeeds;
      assertEquals(
        broken.length,
        0,
        `${broken.length} broken seed(s):\n${
          broken.slice(0, 20).map((b) =>
            `  seed=${b.seed}: ${b.violations.join(" | ")}\n    ${b.replay}`
          ).join("\n")
        }`,
      );
    });
    await t.step("no 5xx without an injected upstream fault", () => {
      assertEquals(
        summary.fiveXXUninduced,
        0,
        JSON.stringify(
          summary.fiveXXSeeds.filter((s) => s.upstream === "healthy"),
        ),
      );
    });
    await t.step("no write was issued by any request", () => {
      assertEquals(summary.writesTotal, 0);
    });
    await t.step(
      "the campaign actually exercised the route and the rejection paths",
      () => {
        if (REPLAY_SEED) return;
        assert(
          summary.executed >= Math.floor(STRESS_ITER * 0.95),
          `only ${summary.executed}/${STRESS_ITER} requests were constructible`,
        );
        assert(
          (summary.statuses["200"] ?? 0) > 0,
          "no request reached the route with a valid bearer",
        );
        assert((summary.statuses["401"] ?? 0) > 0, "no bearer was refused");
        assert(
          (summary.statuses["404"] ?? 0) > 0,
          "no path variant was refused",
        );
        assert(
          (summary.statuses["413"] ?? 0) > 0,
          "no oversized body was refused",
        );
      },
    );
  } finally {
    fault.restore();
  }
});

// ── Boundary scenarios that need shared state (rate limits, real large bodies)

Deno.test("boundary: real bodies at the 5,000,000-byte cap on a route that ignores them", async (t) => {
  const h = await loadHarness();
  const fault = installUpstream(h);
  try {
    const auth = buildAuth(new Prng(1), "valid_google");
    const mk = (method: string, size: number, declare: boolean) => {
      const headers = new Headers({
        authorization: auth.authorization ?? "",
        "x-forwarded-for": `198.51.100.${size % 200}`,
      });
      if (declare) headers.set("content-length", String(size));
      return new Request(`http://edge.test${CANONICAL_URL_PATH}`, {
        method,
        headers,
        body: "x".repeat(size),
      });
    };
    const rows: Array<Record<string, unknown>> = [];
    for (
      const [size, declare] of [
        [MAX_JSON_BODY_BYTES, true],
        [MAX_JSON_BODY_BYTES + 1, true],
        [MAX_JSON_BODY_BYTES + 1, false],
        [MAX_JSON_BODY_BYTES * 2, false],
      ] as Array<[number, boolean]>
    ) {
      const req = mk("POST", size, declare);
      const response = await h.handler(req);
      const text = await response.text();
      rows.push({
        size,
        declared: declare,
        status: response.status,
        requestId: response.headers.get("x-request-id"),
        body: text.slice(0, 160),
      });
      assert(response.headers.get("x-request-id"), "request-id present");
      if (declare && size > MAX_JSON_BODY_BYTES) {
        assertEquals(response.status, 413);
      } else {assert(
          [404, 413].includes(response.status),
          `status ${response.status}`,
        );}
      assertEquals(fault.calls.filter(isWriteCall).length, 0);
    }
    await writeArtifacts("boundary-body-cap", rows);
    await t.step("recorded", () => assertEquals(rows.length, 4));
  } finally {
    fault.restore();
  }
});

Deno.test("boundary: auth-failure and per-user budgets answer 429 with request-id, Retry-After and a generic body", async (t) => {
  const h = await loadHarness();
  const fault = installUpstream(h);
  try {
    const rows: Array<Record<string, unknown>> = [];
    // 30 bad bearers from ONE IP trip the auth-failure budget; the 31st is 429
    // before Supabase Auth is consulted — and stays 429 even for a VALID bearer.
    const ip = "192.0.2.77";
    let first429At = -1;
    for (let i = 0; i < 40; i += 1) {
      const rng = new Prng(1000 + i);
      const bad = buildAuth(rng, "bad_base64");
      const response = await h.handler(
        new Request(`http://edge.test${CANONICAL_URL_PATH}`, {
          method: "GET",
          headers: {
            authorization: bad.authorization ?? "",
            "x-forwarded-for": ip,
          },
        }),
      );
      const text = await response.text();
      rows.push({
        scenario: "authfail",
        i,
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        requestId: response.headers.get("x-request-id"),
        body: text.slice(0, 160),
      });
      assert(response.headers.get("x-request-id"));
      assert([401, 429].includes(response.status), `status ${response.status}`);
      if (response.status === 429) {
        if (first429At < 0) first429At = i;
        assert(response.headers.get("retry-after"));
        assertEquals(JSON.parse(text).error.code, "rate_limited");
      }
    }
    assertEquals(
      first429At,
      30,
      "the 31st failing bearer from one IP is throttled",
    );
    const validAfter = buildAuth(new Prng(4242), "valid_google");
    const blocked = await h.handler(
      new Request(`http://edge.test${CANONICAL_URL_PATH}`, {
        method: "GET",
        headers: {
          authorization: validAfter.authorization ?? "",
          "x-forwarded-for": ip,
        },
      }),
    );
    await blocked.text();
    rows.push({
      scenario: "authfail_then_valid",
      status: blocked.status,
      requestId: blocked.headers.get("x-request-id"),
    });
    assertEquals(
      blocked.status,
      429,
      "a tripped IP is throttled even with a good bearer",
    );

    // 240 requests for ONE user exhaust the general per-user budget; #241 → 429.
    const user = buildAuth(new Prng(777), "valid_session");
    const authCallsBefore = fault.calls.filter((c) =>
      c.url.includes("/auth/v1/user")
    ).length;
    let firstUser429At = -1;
    for (let i = 0; i < 245; i += 1) {
      const response = await h.handler(
        new Request(`http://edge.test${CANONICAL_URL_PATH}`, {
          method: "GET",
          headers: {
            authorization: user.authorization ?? "",
            "x-forwarded-for": `192.0.2.${100 + (i % 100)}`,
          },
        }),
      );
      const text = await response.text();
      if (i < 3 || i >= 238) {
        rows.push({
          scenario: "user_budget",
          i,
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
          requestId: response.headers.get("x-request-id"),
          body: text.slice(0, 160),
        });
      }
      assert(response.headers.get("x-request-id"));
      if (response.status === 429) {
        if (firstUser429At < 0) firstUser429At = i;
        assert(response.headers.get("retry-after"));
      } else {
        assertEquals(response.status, 200);
        assertEquals(text, JSON.stringify({ plan: null }));
      }
    }
    assertEquals(
      firstUser429At,
      240,
      "the 241st request of one user is throttled",
    );
    const authCalls = fault.calls.filter((c) =>
      c.url.includes("/auth/v1/user")
    ).length - authCallsBefore;
    rows.push({ scenario: "user_budget_auth_calls", authCalls });
    assertEquals(
      authCalls,
      1,
      "the session bearer is verified upstream once, then served from the auth cache",
    );
    assertEquals(fault.calls.filter(isWriteCall).length, 0);
    await writeArtifacts("boundary-rate-limits", rows);
    await t.step("recorded", () => assert(rows.length > 40));
  } finally {
    fault.restore();
  }
});
