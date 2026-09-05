// STRESS (fuzz-boundary) — POST /v1/sessions/:id/finalize ("end session").
//
// Seeded fuzz/boundary campaign against the REAL edge handler in-process
// (routesHarness captures Deno.serve; Supabase Auth / PostgREST / RevenueCat
// are stubbed). Every iteration is derived from ONE 32-bit seed, so any row
// of the emitted JSON table replays byte-for-byte:
//
//   STRESS_ITER=3000 STRESS_OUT=/tmp/fuzz.json deno test -A --no-check --config deno.json stress_sessions_end_fuzz.test.ts
//   STRESS_REPLAY=123456789,987654321 deno test -A --no-check --config deno.json stress_sessions_end_fuzz.test.ts
//
// Env knobs (all optional):
//   STRESS_ITER    iterations for the random campaign (default 300 — keeps the
//                  suite fast; the ≥3000 campaign is run explicitly)
//   STRESS_SEED    campaign seed (default 20260905)
//   STRESS_OUT     write the seed → outcome JSON table to this path
//   STRESS_REPLAY  comma-separated iteration seeds to replay (verbose) instead
//                  of the random campaign
//
// Invariants asserted for EVERY generated request (see `checkInvariants`):
//   I1  handler resolves (never throws / rejects)
//   I2  status is inside the class the oracle predicts from the generated
//       request; for bad input ONLY 400/401/403/404/405/413/415/429
//   I3  `x-request-id` present, well-formed, echoed only when the client value
//       is well-formed (≤64 chars of [A-Za-z0-9._-]); never a malformed echo
//   I4  JSON responses carry Content-Type application/json + nosniff + no-store
//   I5  every ≥400 body is `{error:{message}}`; 5xx bodies are the generic
//       strings; no stack frames / file paths / PostgREST or Auth detail; the
//       upstream-error CANARY never reaches the body or headers
//   I6  no PostgREST write (PATCH/POST/DELETE) on ANY non-2xx response; a
//       200 on an OPEN session performs exactly ONE PATCH of `{ended_at}` scoped
//       by id=eq.<uuid>&user_id=eq.<authed user>; a 200 on an ENDED session
//       performs ZERO writes (replay never moves ended_at)
//   I7  exactly one structured access-log line per request, carrying the same
//       request id, a templated route for UUID ids, and never the bearer
//   I8  the ONLY upstream fetches are Supabase Auth + PostgREST `sessions`
//       (no RevenueCat / Apple / other-table traffic from this route)

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import { fakeGoogleIdToken, loadHarness, SUPABASE_URL, TEST_USER_ID } from "./routesHarness.ts";

// ───────────────────────────── seeded RNG ─────────────────────────────

/** mulberry32 — tiny, deterministic, good enough for scenario selection. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** splitmix-style hash so iteration seeds are decorrelated from the index. */
function iterationSeed(campaignSeed: number, index: number): number {
  let z = (campaignSeed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

class Rng {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = prng(seed);
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  hex(n: number): string {
    let out = "";
    for (let i = 0; i < n; i += 1) out += "0123456789abcdef"[this.int(16)];
    return out;
  }
  uuidV4(): string {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-${this.pick(["8", "9", "a", "b"])}${this.hex(3)}-${this.hex(12)}`;
  }
  ascii(
    n: number,
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-",
  ): string {
    let out = "";
    for (let i = 0; i < n; i += 1) out += alphabet[this.int(alphabet.length)];
    return out;
  }
}

// ───────────────────────────── scenario model ─────────────────────────────

const ID_KINDS = [
  "uuid-v4",
  "uuid-upper",
  "uuid-v1",
  "uuid-v7",
  "uuid-percent-encoded",
  "uuid-nil",
  "uuid-max",
  "uuid-bad-version",
  "uuid-bad-variant",
  "uuid-no-dashes",
  "uuid-short",
  "uuid-long",
  "uuid-braced",
  "uuid-urn",
  "uuid-trailing-space",
  "uuid-leading-space-encoded",
  "uuid-plus-newline-encoded",
  "malformed-percent",
  "percent-encoded-slash",
  "null-byte",
  "empty-decoded", // "%20" → " " (segment present, decodes to whitespace)
  "dotdot",
  "sql-injection",
  "postgrest-filter-injection",
  "unicode",
  "unicode-fullwidth-digits",
  "very-long",
  "huge-100k",
  "numeric",
  "word",
  "json-object",
] as const;
type IdKind = (typeof ID_KINDS)[number];

const PATH_KINDS = [
  "canonical", // /v1/sessions/<id>/finalize
  "canonical", // weighted
  "canonical",
  "canonical",
  "trailing-slash", // /v1/sessions/<id>/finalize/
  "double-slash", // /v1/sessions//<id>/finalize
  "missing-id", // /v1/sessions//finalize
  "missing-action", // /v1/sessions/<id>
  "wrong-action", // /v1/sessions/<id>/end
  "upper-action", // /v1/sessions/<id>/FINALIZE
  "upper-v1", // /V1/sessions/<id>/finalize
  "extra-segment", // /v1/sessions/<id>/finalize/extra
  "nested-v1", // /v1/x/v1/sessions/<id>/finalize (router uses LAST /v1/)
  "dotdot-normalised", // /v1/sessions/../sessions/<id>/finalize → canonical after URL parsing
  "encoded-slash-in-action", // /v1/sessions/<id>%2Ffinalize
] as const;
type PathKind = (typeof PATH_KINDS)[number];

const PREFIXES = ["/functions/v1/api", "/api", ""] as const;

const METHODS = [
  "POST",
  "POST",
  "POST",
  "POST",
  "POST",
  "POST",
  "GET",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

const AUTH_KINDS = [
  "google-valid",
  "google-valid",
  "google-valid",
  "session-valid",
  "session-revoked", // /auth/v1/user answers 401
  "session-auth-500", // /auth/v1/user answers 500 → generic 503 (upstream outage)
  "missing",
  "empty-bearer",
  "not-a-jwt",
  "two-segments",
  "four-segments",
  "bad-base64-payload",
  "payload-not-object",
  "unknown-issuer",
  "expired-google",
  "exp-not-number",
  "no-sub",
  "basic-scheme",
  "lowercase-bearer",
  "bearer-no-space",
  "huge-token",
  "control-chars",
  "duplicate-authorization",
] as const;
type AuthKind = (typeof AUTH_KINDS)[number];

const IP_KINDS = [
  "fresh", // unique per seed → never trips shared budgets
  "fresh",
  "fresh",
  "fresh",
  "fresh",
  "fresh-behind-proxy-list", // "1.2.3.4, <fresh>" — last hop wins
  "cf-connecting-ip", // cf header preferred over xff
  "ipv6-fresh",
  "missing", // → "unknown" bucket (shared) — 429 permitted
  "garbage", // "not an ip" (shared) — 429 permitted
  "empty", // "" → unknown (shared) — 429 permitted
  "huge", // 8 KB header (shared) — 429 permitted
] as const;
type IpKind = (typeof IP_KINDS)[number];

const REQ_ID_KINDS = [
  "absent",
  "absent",
  "valid-uuid",
  "valid-short-8",
  "valid-64",
  "too-short-7",
  "too-long-65",
  "too-long-4k",
  "bad-chars-space",
  "bad-chars-unicode",
  "bad-chars-json",
  "padded-valid", // "  <valid>  " — Headers trims → echoed
] as const;
type ReqIdKind = (typeof REQ_ID_KINDS)[number];

const BODY_KINDS = [
  "none",
  "none",
  "empty-string",
  "client-shape", // {"id":"<uuid>"} — what apps/mobile sends
  "empty-object",
  "invalid-json",
  "json-array",
  "json-number",
  "json-null",
  "deep-nested",
  "huge-keys-256k",
  "binary-random-4k",
  "invalid-utf8",
  "declared-oversize", // Content-Length 5_000_001 → 413 pre-auth
  "streamed-6mb", // chunked 6 MB, no Content-Length (route never reads it)
  "content-length-lies-small", // says 1, sends 1 KB
  "content-length-garbage", // "abc"
  "content-length-negative",
] as const;
type BodyKind = (typeof BODY_KINDS)[number];

const CONTENT_TYPES = [
  undefined,
  "application/json",
  "application/json; charset=utf-8",
  "text/plain",
  "multipart/form-data; boundary=xx",
  "application/x-www-form-urlencoded",
  "application/octet-stream",
  "garbage/\u00bf", // Latin-1 only: a non-ByteString header value is rejected by Headers itself
] as const;

const DB_KINDS = [
  "open", // row with ended_at null → 200 + ONE PATCH
  "open",
  "ended", // row already ended → 200 + ZERO writes
  "ended",
  "none", // no row (RLS hides other users too) → 404
  "none",
  "select-500", // PostgREST 500 with canary detail → 503 generic
  "select-401", // JWT rejected by PostgREST → 503 generic
  "select-non-json", // 200 text/html garbage → 5xx generic
  "select-multi-row", // two rows where one expected → 5xx generic (maybeSingle)
  "select-hang-then-500", // slow upstream (30ms) then 500
  "patch-42501", // column grant refused → 503 generic (write attempted, refused upstream)
  "patch-500",
  "patch-non-json",
  "row-ended_at-missing", // shape drift: no ended_at key → treated as ended
  "row-ended_at-empty-string",
] as const;
type DbKind = (typeof DB_KINDS)[number];

const QUERY_KINDS = [
  "none",
  "none",
  "none",
  "simple", // ?id=<uuid>
  "postgrest-ish", // ?user_id=eq.<other>&select=*
  "huge-8k",
  "encoded-newline",
  "fragment",
  "duplicate-keys",
] as const;
type QueryKind = (typeof QUERY_KINDS)[number];

/** Two draws per seed: `wide` samples every dimension uniformly (mostly
 * rejected before the route body runs); `deep` pins method/path/id/auth to
 * shapes that REACH finalizeSession so the DB/idempotency/5xx paths get
 * thousands of hits too. Both are fully determined by the seed. */
export type Mode = "wide" | "deep";

const DEEP_PATH_KINDS: readonly PathKind[] = [
  "canonical",
  "canonical",
  "canonical",
  "dotdot-normalised",
  "nested-v1",
];
const DEEP_ID_KINDS: readonly IdKind[] = [
  "uuid-v4",
  "uuid-upper",
  "uuid-v1",
  "uuid-v7",
  "uuid-percent-encoded",
];
const DEEP_AUTH_KINDS: readonly AuthKind[] = [
  "google-valid",
  "google-valid",
  "session-valid",
  "session-valid",
  "control-chars",
  "exp-not-number",
  "huge-token",
  "no-sub",
  "session-revoked",
  "session-auth-500",
];

export interface Scenario {
  seed: number;
  mode: Mode;
  method: string;
  prefix: string;
  pathKind: PathKind;
  idKind: IdKind;
  idRaw: string;
  idDecoded: string | null; // null when decodeURIComponent throws
  path: string; // pathname (before prefix)
  queryKind: QueryKind;
  query: string;
  authKind: AuthKind;
  userSub: string;
  ipKind: IpKind;
  reqIdKind: ReqIdKind;
  reqIdValue: string | null;
  bodyKind: BodyKind;
  contentType: string | undefined;
  dbKind: DbKind;
  canary: string;
  extraHeaders: Record<string, string>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The user the stubbed Supabase Auth resolves the bearer to. The stub (like
 * the real routesHarness) trusts any structurally valid Google-issuer token,
 * so unsigned-but-well-formed variants authenticate here (they would be
 * refused by real Supabase Auth): that is what lets them reach the route. A
 * Google token WITHOUT `sub` resolves to the harness default user. */
function effectiveSub(s: Scenario): string | null {
  switch (s.authKind) {
    case "google-valid":
    case "session-valid":
    case "control-chars": // trailing tab is HTTP whitespace → stripped by Headers
    case "exp-not-number": // non-numeric exp is "not expired" → verified upstream
    case "huge-token": // 200 KB payload; structurally a Google token
      return s.userSub;
    case "no-sub":
      return TEST_USER_ID;
    default:
      return null;
  }
}
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const BAD_INPUT_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 429]);

function b64url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwt(
  payload: unknown,
  header: unknown = { alg: "RS256", typ: "JWT", kid: "fuzz" },
): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.sig`;
}

/** A Supabase-issued session bearer the stubbed GET /auth/v1/user will answer. */
function sessionToken(sub: string, seed: number): string {
  return jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    aud: "authenticated",
    role: "authenticated",
    session_id: `sess-${seed.toString(16)}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

function makeId(kind: IdKind, rng: Rng, canary: string): string {
  const base = rng.uuidV4();
  switch (kind) {
    case "uuid-v4":
      return base;
    case "uuid-upper":
      return base.toUpperCase();
    case "uuid-v1":
      return `${rng.hex(8)}-${rng.hex(4)}-1${rng.hex(3)}-${rng.pick(["8", "9", "a", "b"])}${rng.hex(3)}-${rng.hex(12)}`;
    case "uuid-v7":
      return `${rng.hex(8)}-${rng.hex(4)}-7${rng.hex(3)}-${rng.pick(["8", "9", "a", "b"])}${rng.hex(3)}-${rng.hex(12)}`;
    case "uuid-percent-encoded":
      // percent-encode every hex char except dashes: decodes to a valid UUID
      return base
        .split("")
        .map((c) => (c === "-" ? c : `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`))
        .join("");
    case "uuid-nil":
      return "00000000-0000-0000-0000-000000000000";
    case "uuid-max":
      return "ffffffff-ffff-ffff-ffff-ffffffffffff";
    case "uuid-bad-version":
      return `${rng.hex(8)}-${rng.hex(4)}-${rng.pick(["0", "9", "a", "f"])}${rng.hex(3)}-${rng.pick(["8", "9", "a", "b"])}${rng.hex(3)}-${rng.hex(12)}`;
    case "uuid-bad-variant":
      return `${rng.hex(8)}-${rng.hex(4)}-4${rng.hex(3)}-${rng.pick(["0", "7", "c", "f"])}${rng.hex(3)}-${rng.hex(12)}`;
    case "uuid-no-dashes":
      return base.replace(/-/g, "");
    case "uuid-short":
      return base.slice(0, -1);
    case "uuid-long":
      return `${base}0`;
    case "uuid-braced":
      return `%7B${base}%7D`;
    case "uuid-urn":
      return `urn:uuid:${base}`;
    case "uuid-trailing-space":
      return `${base}%20`;
    case "uuid-leading-space-encoded":
      return `%20${base}`;
    case "uuid-plus-newline-encoded":
      return `${base}%0A`;
    case "malformed-percent":
      return rng.pick([
        `${base}%`,
        `${base}%E0%A4%A`,
        `%ZZ${base}`,
        `${base.slice(0, 8)}%FF%FE${base.slice(8)}`,
        "%C0%AF",
      ]);
    case "percent-encoded-slash":
      return `${base.slice(0, 18)}%2F${base.slice(18)}`;
    case "null-byte":
      return `${base}%00`;
    case "empty-decoded":
      return "%20";
    case "dotdot":
      return rng.pick(["..", "%2E%2E", "..%2F..", "%2e%2e%2f"]);
    case "sql-injection":
      return encodeURIComponent(
        rng.pick([
          `' OR 1=1 --`,
          `${base}'; drop table sessions; --`,
          `1 UNION SELECT * FROM auth.users`,
        ]),
      );
    case "postgrest-filter-injection":
      return encodeURIComponent(
        rng.pick([
          `${base},user_id.neq.x`,
          `${base}&user_id=eq.${rng.uuidV4()}`,
          `not.is.null`,
          `in.(${base})`,
        ]),
      );
    case "unicode":
      return encodeURIComponent(
        rng.pick(["日本語", "🥒🥒🥒", "Ω≈ç√∫˜µ≤≥÷", "\u202e" + base, "\ufeff" + base]),
      );
    case "unicode-fullwidth-digits":
      return encodeURIComponent(
        base.replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d))),
      );
    case "very-long":
      return rng.hex(2048);
    case "huge-100k":
      return rng.ascii(100_000, "abcdef0123456789-");
    case "numeric":
      return String(rng.int(2 ** 31));
    case "word":
      return rng.pick(["latest", "current", "me", "null", "undefined", "true", `cnry${canary}`]);
    case "json-object":
      return encodeURIComponent(JSON.stringify({ id: base, canary }));
  }
}

function makePath(kind: PathKind, idRaw: string): string {
  switch (kind) {
    case "canonical":
      return `/v1/sessions/${idRaw}/finalize`;
    case "trailing-slash":
      return `/v1/sessions/${idRaw}/finalize/`;
    case "double-slash":
      return `/v1/sessions//${idRaw}/finalize`;
    case "missing-id":
      return `/v1/sessions//finalize`;
    case "missing-action":
      return `/v1/sessions/${idRaw}`;
    case "wrong-action":
      return `/v1/sessions/${idRaw}/end`;
    case "upper-action":
      return `/v1/sessions/${idRaw}/FINALIZE`;
    case "upper-v1":
      return `/V1/sessions/${idRaw}/finalize`;
    case "extra-segment":
      return `/v1/sessions/${idRaw}/finalize/extra`;
    case "nested-v1":
      return `/v1/other/v1/sessions/${idRaw}/finalize`;
    case "dotdot-normalised":
      return `/v1/sessions/../sessions/${idRaw}/finalize`;
    case "encoded-slash-in-action":
      return `/v1/sessions/${idRaw}%2Ffinalize`;
  }
}

function makeQuery(kind: QueryKind, rng: Rng): string {
  switch (kind) {
    case "none":
      return "";
    case "simple":
      return `?id=${rng.uuidV4()}`;
    case "postgrest-ish":
      return `?user_id=eq.${rng.uuidV4()}&select=*&ended_at=is.null`;
    case "huge-8k":
      return `?q=${rng.ascii(8192)}`;
    case "encoded-newline":
      return `?x=%0D%0AX-Injected:%201`;
    case "fragment":
      return `#frag-${rng.hex(4)}`;
    case "duplicate-keys":
      return `?id=a&id=b&id=${rng.uuidV4()}`;
  }
}

function makeReqId(kind: ReqIdKind, rng: Rng): string | null {
  switch (kind) {
    case "absent":
      return null;
    case "valid-uuid":
      return rng.uuidV4();
    case "valid-short-8":
      return rng.ascii(8);
    case "valid-64":
      return rng.ascii(64);
    case "too-short-7":
      return rng.ascii(7);
    case "too-long-65":
      return rng.ascii(65);
    case "too-long-4k":
      return rng.ascii(4096);
    case "bad-chars-space":
      return `${rng.ascii(6)} ${rng.ascii(6)}`;
    case "bad-chars-unicode":
      return `${rng.ascii(8)}\u00e9\u00ff`;
    case "bad-chars-json":
      return `{"id":"${rng.ascii(8)}"}`;
    case "padded-valid":
      return `  ${rng.ascii(12)}  `;
  }
}

function ipFor(seed: number): string {
  return `10.${(seed >>> 16) & 255}.${(seed >>> 8) & 255}.${seed & 255}`;
}

function generate(seed: number): Scenario {
  const rng = new Rng(seed);
  const canary = `CNRY${seed.toString(16)}`;
  const mode: Mode = rng.chance(0.45) ? "deep" : "wide";
  const idKind = mode === "deep" ? rng.pick(DEEP_ID_KINDS) : rng.pick(ID_KINDS);
  const idRaw = makeId(idKind, rng, canary);
  let idDecoded: string | null;
  try {
    idDecoded = decodeURIComponent(idRaw);
  } catch {
    idDecoded = null;
  }
  const pathKind = mode === "deep" ? rng.pick(DEEP_PATH_KINDS) : rng.pick(PATH_KINDS);
  const queryKind = rng.pick(QUERY_KINDS);
  const authKind = mode === "deep" ? rng.pick(DEEP_AUTH_KINDS) : rng.pick(AUTH_KINDS);
  // 90 % fresh subjects; 10 % from a small pool so the auth cache sees hits.
  const userSub = rng.chance(0.9)
    ? rng.uuidV4()
    : `${"0".repeat(8)}-0000-4000-8000-${String(rng.int(16)).padStart(12, "0")}`;
  const reqIdKind = rng.pick(REQ_ID_KINDS);
  const bodyKind = rng.pick(BODY_KINDS);
  const extraHeaders: Record<string, string> = {};
  if (rng.chance(0.15))
    extraHeaders["accept"] = rng.pick([
      "*/*",
      "text/html",
      "application/xml",
      "application/vnd.pgrst.object+json",
    ]);
  if (rng.chance(0.1))
    extraHeaders["origin"] = rng.pick(["https://evil.example", "null", "http://localhost:3000"]);
  if (rng.chance(0.1)) extraHeaders["x-http-method-override"] = rng.pick(["DELETE", "PUT", "GET"]);
  if (rng.chance(0.1))
    extraHeaders["prefer"] = rng.pick(["return=representation", "resolution=merge-duplicates"]);
  if (rng.chance(0.05)) extraHeaders["apikey"] = rng.ascii(40);
  if (rng.chance(0.05)) extraHeaders["x-supabase-role"] = "service_role";
  const method = rng.pick(METHODS);
  return {
    seed,
    mode,
    method: mode === "deep" ? "POST" : method,
    prefix: rng.pick(PREFIXES),
    pathKind,
    idKind,
    idRaw,
    idDecoded,
    path: makePath(pathKind, idRaw),
    queryKind,
    query: makeQuery(queryKind, rng),
    authKind,
    userSub,
    ipKind: rng.pick(IP_KINDS),
    reqIdKind,
    reqIdValue: makeReqId(reqIdKind, rng),
    bodyKind,
    contentType: rng.pick(CONTENT_TYPES),
    dbKind: rng.pick(DB_KINDS),
    canary,
    extraHeaders,
  };
}

// ───────────────────────────── request builder ─────────────────────────────

function authorizationFor(s: Scenario): string[] {
  const rng = new Rng(s.seed ^ 0xa11ce);
  switch (s.authKind) {
    case "google-valid":
      return [`Bearer ${fakeGoogleIdToken(s.userSub)}`];
    case "session-valid":
    case "session-revoked":
    case "session-auth-500":
      return [`Bearer ${sessionToken(s.userSub, s.seed)}`];
    case "missing":
      return [];
    case "empty-bearer":
      return ["Bearer "];
    case "not-a-jwt":
      return [`Bearer ${rng.ascii(40)}`];
    case "two-segments":
      return [
        `Bearer ${b64url("{}")}.${b64url(JSON.stringify({ iss: "https://accounts.google.com", sub: s.userSub }))}`,
      ];
    case "four-segments":
      return [`Bearer ${fakeGoogleIdToken(s.userSub)}.extra`];
    case "bad-base64-payload":
      return [`Bearer ${b64url("{}")}.!!!not-base64!!!.sig`];
    case "payload-not-object":
      return [`Bearer ${b64url("{}")}.${b64url(rng.pick(["42", "null", "[1,2]", '"str"']))}.sig`];
    case "unknown-issuer":
      return [
        `Bearer ${jwt({ iss: rng.pick(["https://accounts.google.com.evil.example", "https://login.microsoftonline.com/x/v2.0", "accounts.google.com/auth/v1", `${SUPABASE_URL}/auth/v1/`]), sub: s.userSub, exp: Math.floor(Date.now() / 1000) + 600 })}`,
      ];
    case "expired-google":
      return [
        `Bearer ${jwt({ iss: "https://accounts.google.com", sub: s.userSub, exp: Math.floor(Date.now() / 1000) - 60 })}`,
      ];
    case "exp-not-number":
      return [
        `Bearer ${jwt({ iss: "https://accounts.google.com", sub: s.userSub, exp: rng.pick(["0", null, {}, "9999999999"]) })}`,
      ];
    case "no-sub":
      return [
        `Bearer ${jwt({ iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 600 })}`,
      ];
    case "basic-scheme":
      return [`Basic ${btoa(`${s.userSub}:password`)}`];
    case "lowercase-bearer":
      return [`bearer ${fakeGoogleIdToken(s.userSub)}`];
    case "bearer-no-space":
      return [`Bearer${fakeGoogleIdToken(s.userSub)}`];
    case "huge-token":
      return [
        `Bearer ${b64url("{}")}.${b64url(JSON.stringify({ iss: "https://accounts.google.com", sub: s.userSub, pad: rng.ascii(200_000) }))}.sig`,
      ];
    case "control-chars":
      return [`Bearer ${fakeGoogleIdToken(s.userSub)}\t`];
    case "duplicate-authorization":
      return [
        `Bearer ${fakeGoogleIdToken(s.userSub)}`,
        `Bearer ${fakeGoogleIdToken(rng.uuidV4())}`,
      ];
  }
}

function ipHeadersFor(s: Scenario): Record<string, string> {
  const fresh = ipFor(s.seed);
  switch (s.ipKind) {
    case "fresh":
      return { "x-forwarded-for": fresh };
    case "fresh-behind-proxy-list":
      return { "x-forwarded-for": `203.0.113.7, 198.51.100.9, ${fresh}` };
    case "cf-connecting-ip":
      return { "cf-connecting-ip": fresh, "x-forwarded-for": "203.0.113.1" };
    case "ipv6-fresh":
      return {
        "x-forwarded-for": `2001:db8::${(s.seed >>> 16).toString(16)}:${(s.seed & 0xffff).toString(16)}`,
      };
    case "missing":
      return {};
    case "garbage":
      return { "x-forwarded-for": "not an ip at all" };
    case "empty":
      return { "x-forwarded-for": "" };
    case "huge":
      return { "x-forwarded-for": "1.".repeat(4096) };
  }
}

function bodyFor(s: Scenario): {
  body: BodyInit | null;
  headers: Record<string, string>;
  bytes: number;
} {
  const rng = new Rng(s.seed ^ 0xb0d7);
  const enc = new TextEncoder();
  const headers: Record<string, string> = {};
  if (s.contentType !== undefined) headers["content-type"] = s.contentType;
  const text = (t: string) => ({ body: t, headers, bytes: enc.encode(t).byteLength });
  switch (s.bodyKind) {
    case "none":
      return { body: null, headers, bytes: 0 };
    case "empty-string":
      return text("");
    case "client-shape":
      return text(JSON.stringify({ id: s.idDecoded ?? rng.uuidV4() }));
    case "empty-object":
      return text("{}");
    case "invalid-json":
      return text(rng.pick(["{", "{'id': 1}", '{"id": }', "\uFEFF{}", "NaN", '{"a":1}garbage']));
    case "json-array":
      return text(JSON.stringify([s.idDecoded, 1, null]));
    case "json-number":
      return text("12345678901234567890");
    case "json-null":
      return text("null");
    case "deep-nested": {
      const depth = 5000;
      return text("[".repeat(depth) + "]".repeat(depth));
    }
    case "huge-keys-256k": {
      const obj: Record<string, string> = {};
      for (let i = 0; i < 4096; i += 1) obj[`k${i}_${rng.ascii(40)}`] = rng.ascii(16);
      return text(JSON.stringify(obj));
    }
    case "binary-random-4k": {
      const bytes = new Uint8Array(4096);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = rng.int(256);
      return { body: bytes, headers, bytes: bytes.length };
    }
    case "invalid-utf8":
      return {
        body: new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0xc0, 0x80, 0x22, 0x3a, 0x31, 0x7d]),
        headers,
        bytes: 10,
      };
    case "declared-oversize":
      return { body: "{}", headers: { ...headers, "content-length": "5000001" }, bytes: 2 };
    case "streamed-6mb": {
      const chunk = new Uint8Array(64 * 1024).fill(0x41);
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 6 * 1024 * 1024) {
            controller.close();
            return;
          }
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      return { body: stream, headers, bytes: 6 * 1024 * 1024 };
    }
    case "content-length-lies-small":
      return { body: rng.ascii(1024), headers: { ...headers, "content-length": "1" }, bytes: 1024 };
    case "content-length-garbage":
      return { body: "{}", headers: { ...headers, "content-length": "abc" }, bytes: 2 };
    case "content-length-negative":
      return { body: "{}", headers: { ...headers, "content-length": "-1" }, bytes: 2 };
  }
}

export function buildRequest(s: Scenario): Request {
  const headers = new Headers();
  for (const value of authorizationFor(s)) headers.append("authorization", value);
  for (const [k, v] of Object.entries(ipHeadersFor(s))) headers.set(k, v);
  if (s.reqIdValue !== null) headers.set("x-request-id", s.reqIdValue);
  for (const [k, v] of Object.entries(s.extraHeaders)) headers.set(k, v);
  const hasBody = s.method !== "GET" && s.method !== "HEAD";
  const built = bodyFor(s);
  for (const [k, v] of Object.entries(built.headers)) headers.set(k, v);
  const url = `http://edge.test${s.prefix}${s.path}${s.query}`;
  return new Request(url, {
    method: s.method,
    headers,
    body: hasBody ? built.body : null,
    // Only needed for ReadableStream bodies; harmless otherwise.
    ...(built.body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

// ───────────────────────────── oracle ─────────────────────────────

export type ExpectedClass =
  | "bad-input" // must be one of BAD_INPUT_STATUSES, zero writes
  | "ok-open" // 200, exactly one scoped PATCH {ended_at}
  | "ok-ended" // 200, zero writes
  | "upstream-5xx-read" // 5xx generic, zero writes (upstream read failed)
  | "upstream-5xx-write" // 5xx generic, exactly one attempted PATCH refused upstream
  | "upstream-5xx-auth"; // 5xx generic, zero DB traffic (Supabase Auth outage)

export interface Expectation {
  klass: ExpectedClass;
  statuses: Set<number>;
  writes: 0 | 1;
  /** 429 acceptable in addition (shared IP bucket or same user). */
  allow429: boolean;
  note: string;
}

function normalisedRoutePath(s: Scenario): string {
  const url = new URL(`http://edge.test${s.prefix}${s.path}${s.query}`);
  const v1 = url.pathname.lastIndexOf("/v1/");
  return v1 >= 0 ? url.pathname.slice(v1) : url.pathname;
}

export function expectationFor(s: Scenario): Expectation {
  const bad = (statuses: number[], note: string): Expectation => ({
    klass: "bad-input",
    statuses: new Set(statuses),
    writes: 0,
    allow429: true,
    note,
  });
  const sharedIp = !["fresh", "fresh-behind-proxy-list", "cf-connecting-ip", "ipv6-fresh"].includes(
    s.ipKind,
  );
  // 1. declared oversize → 413 before anything else (GET/HEAD carry no body,
  //    but the header still arrives; the handler only looks at the header).
  if (s.bodyKind === "declared-oversize")
    return bad([413], "Content-Length > 5 MB refused pre-auth");
  // 2. authentication
  if (s.authKind === "session-auth-500") {
    return {
      klass: "upstream-5xx-auth",
      statuses: new Set([503]),
      writes: 0,
      allow429: sharedIp,
      note: "Supabase Auth 500 → generic 503",
    };
  }
  const sub = effectiveSub(s);
  if (sub === null) return bad([401], `auth ${s.authKind} → 401`);
  // The no-sub variant shares ONE user budget across the whole campaign.
  const allow429 = sharedIp || s.authKind === "no-sub";
  // 3. routing
  const path = normalisedRoutePath(s);
  const m = /^\/v1\/sessions\/([^/]+)\/finalize$/.exec(path);
  if (s.method !== "POST" || !m)
    return bad([404, 405], `${s.method} ${path} does not route to finalize`);
  // 4. path segment decoding
  let decoded: string;
  try {
    decoded = decodeURIComponent(m[1]);
  } catch {
    return bad([400], "malformed percent-encoding in :id");
  }
  if (!UUID_RE.test(decoded)) return bad([400], "id is not a UUID");
  // 5. database behaviour
  const upstreamRead = (note: string): Expectation => ({
    klass: "upstream-5xx-read",
    statuses: new Set([500, 503]),
    writes: 0,
    allow429,
    note,
  });
  switch (s.dbKind) {
    case "open":
      return {
        klass: "ok-open",
        statuses: new Set([200]),
        writes: 1,
        allow429,
        note: "open session → one ended_at stamp",
      };
    case "ended":
    case "row-ended_at-missing":
    case "row-ended_at-empty-string":
      return {
        klass: "ok-ended",
        statuses: new Set([200]),
        writes: 0,
        allow429,
        note: `${s.dbKind} → replay-safe 200, no write`,
      };
    case "none":
      return bad([404], "no owned row → 404 session.not_found");
    case "select-500":
    case "select-401":
    case "select-non-json":
    case "select-multi-row":
    case "select-hang-then-500":
      return upstreamRead(`${s.dbKind} → generic 5xx, no write`);
    case "patch-42501":
    case "patch-500":
    case "patch-non-json":
      return {
        klass: "upstream-5xx-write",
        statuses: new Set([500, 503]),
        writes: 1,
        allow429,
        note: `${s.dbKind} → generic 5xx after one refused PATCH`,
      };
  }
}

// ───────────────────────────── upstream interceptor ─────────────────────────────

interface UpstreamCall {
  method: string;
  url: string;
  body: string;
  authorization: string | null;
}

interface Interceptor {
  restore(): void;
  /** Register DB behaviour + auth behaviour for a user subject. */
  arm(scenario: Scenario): void;
  disarm(scenario: Scenario): void;
  calls: UpstreamCall[];
}

function installInterceptor(): Interceptor {
  const base = globalThis.fetch;
  const bySub = new Map<string, Scenario>();
  const calls: UpstreamCall[] = [];
  const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request
      .clone()
      .text()
      .catch(() => "");
    calls.push({
      method: request.method,
      url: request.url,
      body,
      authorization: request.headers.get("authorization"),
    });

    if (url.href.startsWith(`${SUPABASE_URL}/auth/v1/user`) && request.method === "GET") {
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const segments = bearer.split(".");
      let sub = "";
      try {
        sub = String(JSON.parse(atob(segments[1].replace(/-/g, "+").replace(/_/g, "/"))).sub ?? "");
      } catch {
        // not one of ours
      }
      const s = bySub.get(sub);
      if (!s)
        return jsonResponse(401, {
          code: 401,
          msg: "invalid JWT: unable to parse or verify signature",
        });
      if (s.authKind === "session-revoked")
        return jsonResponse(401, { code: 401, msg: `invalid JWT: session not found ${s.canary}` });
      if (s.authKind === "session-auth-500")
        return jsonResponse(500, { code: 500, msg: `internal ${s.canary}` });
      // Only a bearer we minted as a Supabase session verifies; anything else
      // routed here (e.g. a Google token whose issuer merely ends in /auth/v1)
      // is refused exactly like real Supabase Auth would.
      if (s.authKind !== "session-valid")
        return jsonResponse(401, { code: 401, msg: `invalid JWT: bad signature ${s.canary}` });
      return jsonResponse(200, {
        id: sub,
        aud: "authenticated",
        role: "authenticated",
        email: "fuzz@example.com",
        app_metadata: { provider: "google", providers: ["google"] },
        user_metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
      });
    }

    if (url.href.startsWith(`${SUPABASE_URL}/rest/v1/sessions`)) {
      const userEq = url.searchParams.get("user_id") ?? "";
      const sub = userEq.startsWith("eq.") ? userEq.slice(3) : "";
      const s = bySub.get(sub);
      const dbKind: DbKind = s?.dbKind ?? "none";
      const canary = s?.canary ?? "CNRY-unarmed";
      const idEq = url.searchParams.get("id") ?? "";
      const id = idEq.startsWith("eq.") ? idEq.slice(3) : "";
      if (request.method === "GET") {
        const accept = request.headers.get("accept") ?? "";
        const single = accept.includes("application/vnd.pgrst.object+json");
        const rows = (list: unknown[]) =>
          single
            ? list.length === 1
              ? jsonResponse(200, list[0])
              : jsonResponse(406, {
                  code: "PGRST116",
                  message: `JSON object requested, multiple (or no) rows returned ${canary}`,
                  details: `Results contain ${list.length} rows`,
                  hint: null,
                })
            : jsonResponse(200, list);
        switch (dbKind) {
          case "open":
          case "patch-42501":
          case "patch-500":
          case "patch-non-json":
            return rows([{ id, ended_at: null }]);
          case "ended":
            return rows([{ id, ended_at: "2026-09-01T12:00:00.000Z" }]);
          case "row-ended_at-missing":
            return rows([{ id }]);
          case "row-ended_at-empty-string":
            return rows([{ id, ended_at: "" }]);
          case "none":
            return rows([]);
          case "select-500":
            return jsonResponse(500, {
              code: "XX000",
              message: `internal error ${canary}`,
              details: `stack: at finalize (index.ts:1) ${canary}`,
              hint: null,
            });
          case "select-401":
            return jsonResponse(401, {
              code: "PGRST301",
              message: `JWT expired ${canary}`,
              details: null,
              hint: null,
            });
          case "select-non-json":
            return new Response(`<html><body>502 Bad Gateway ${canary}</body></html>`, {
              status: 200,
              headers: { "Content-Type": "text/html" },
            });
          case "select-multi-row":
            return rows([
              { id, ended_at: null },
              { id, ended_at: null },
            ]);
          case "select-hang-then-500":
            await new Promise((r) => setTimeout(r, 30));
            return jsonResponse(500, {
              code: "57014",
              message: `canceling statement due to statement timeout ${canary}`,
            });
        }
      }
      if (request.method === "PATCH") {
        switch (dbKind) {
          case "patch-42501":
            return jsonResponse(401, {
              code: "42501",
              message: `permission denied for table sessions ${canary}`,
              details: null,
              hint: null,
            });
          case "patch-500":
            return jsonResponse(500, {
              code: "XX000",
              message: `internal ${canary}`,
              details: `at pg (sessions.ts:9) ${canary}`,
            });
          case "patch-non-json":
            return new Response(`upstream garbage ${canary}`, {
              status: 200,
              headers: { "Content-Type": "text/plain" },
            });
          default:
            return new Response(null, { status: 204 });
        }
      }
    }
    return base(request);
  }) as typeof fetch;

  return {
    calls,
    arm(s) {
      bySub.set(effectiveSub(s) ?? s.userSub, s);
    },
    disarm(s) {
      bySub.delete(effectiveSub(s) ?? s.userSub);
    },
    restore() {
      globalThis.fetch = base;
    },
  };
}

// ───────────────────────────── invariants ─────────────────────────────

export interface Outcome {
  seed: number;
  klass: ExpectedClass;
  status: number | null;
  code: string | null;
  requestId: string | null;
  writes: number;
  upstream: number;
  durationMs: number;
  violations: string[];
  /** Soft signals worth reporting but not lens invariants (log hygiene, echoes). */
  observations: string[];
  scenario: {
    mode: Mode;
    method: string;
    prefix: string;
    pathKind: PathKind;
    idKind: IdKind;
    idRaw: string;
    queryKind: QueryKind;
    authKind: AuthKind;
    ipKind: IpKind;
    reqIdKind: ReqIdKind;
    bodyKind: BodyKind;
    contentType: string | undefined;
    dbKind: DbKind;
  };
  note: string;
}

const STACK_OR_DETAIL_RE =
  /\n\s+at |\.ts:\d+|\.js:\d+|TypeError|ReferenceError|SyntaxError|RangeError|PGRST\d+|postgrest|supabase\.test|permission denied|statement timeout|invalid JWT|stack/i;
const GENERIC_5XX_RE =
  /^(.+ is temporarily unavailable\. Please try again\.|Something went wrong\. Please try again\.)$/;

async function runOne(
  s: Scenario,
  handler: (request: Request) => Promise<Response>,
  interceptor: Interceptor,
  logLines: string[],
): Promise<Outcome> {
  const expected = expectationFor(s);
  const violations: string[] = [];
  const observations: string[] = [];
  interceptor.calls.length = 0;
  logLines.length = 0;
  interceptor.arm(s);
  const request = buildRequest(s);
  const startedAt = performance.now();
  let response: Response | null = null;
  let status: number | null = null;
  let code: string | null = null;
  let requestId: string | null = null;
  let bodyText = "";
  try {
    response = await handler(request);
    bodyText = await response.text();
  } catch (error) {
    violations.push(
      `I1 handler threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  } finally {
    interceptor.disarm(s);
  }
  const durationMs = performance.now() - startedAt;
  const calls = [...interceptor.calls];
  const dbWrites = calls.filter(
    (c) =>
      c.url.startsWith(`${SUPABASE_URL}/rest/v1/`) &&
      ["PATCH", "POST", "PUT", "DELETE"].includes(c.method),
  );

  if (response) {
    status = response.status;
    requestId = response.headers.get("x-request-id");
    const contentType = response.headers.get("content-type") ?? "";
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }
    const errorObj =
      parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)
        ? (parsed as { error: unknown }).error
        : null;
    if (
      errorObj &&
      typeof errorObj === "object" &&
      typeof (errorObj as Record<string, unknown>).code === "string"
    ) {
      code = (errorObj as { code: string }).code;
    }

    // I2 status class
    const statusOk = expected.statuses.has(status) || (expected.allow429 && status === 429);
    if (!statusOk)
      violations.push(
        `I2 status ${status} not in {${[...expected.statuses].join(",")}}${expected.allow429 ? "+429" : ""} (${expected.note})`,
      );
    if (expected.klass === "bad-input" && !BAD_INPUT_STATUSES.has(status))
      violations.push(`I2 bad-input answered ${status}`);
    if (
      status >= 500 &&
      expected.klass !== "upstream-5xx-read" &&
      expected.klass !== "upstream-5xx-write" &&
      expected.klass !== "upstream-5xx-auth"
    ) {
      violations.push(`I2 unexpected 5xx ${status} for ${expected.klass}`);
    }

    // I3 request id
    if (!requestId) violations.push("I3 x-request-id missing");
    else {
      if (!REQUEST_ID_RE.test(requestId))
        violations.push(`I3 x-request-id malformed: ${JSON.stringify(requestId.slice(0, 80))}`);
      const clientValue = s.reqIdValue?.trim() ?? null;
      if (clientValue !== null && REQUEST_ID_RE.test(clientValue) && requestId !== clientValue)
        violations.push("I3 well-formed client x-request-id not echoed");
      if (clientValue !== null && !REQUEST_ID_RE.test(clientValue) && requestId === clientValue)
        violations.push("I3 malformed client x-request-id echoed");
    }

    // I4 headers / I5 body shape
    const isJson = contentType.includes("application/json");
    if (status !== 204 && s.method !== "HEAD") {
      if (!isJson)
        violations.push(
          `I4 non-JSON content-type ${JSON.stringify(contentType)} on status ${status}`,
        );
      if (response.headers.get("x-content-type-options") !== "nosniff")
        violations.push("I4 missing X-Content-Type-Options: nosniff");
      if (response.headers.get("cache-control") !== "no-store")
        violations.push(
          `I4 cache-control ${JSON.stringify(response.headers.get("cache-control"))}`,
        );
    }
    if (status >= 400) {
      const message =
        errorObj && typeof errorObj === "object"
          ? (errorObj as Record<string, unknown>).message
          : undefined;
      if (typeof message !== "string" || !message)
        violations.push(`I5 error body without error.message: ${bodyText.slice(0, 120)}`);
      if (status >= 500 && typeof message === "string" && !GENERIC_5XX_RE.test(message))
        violations.push(`I5 non-generic 5xx message: ${message.slice(0, 120)}`);
      if (STACK_OR_DETAIL_RE.test(bodyText))
        violations.push(`I5 body carries internal detail: ${bodyText.slice(0, 160)}`);
    }
    if (bodyText.includes(s.canary)) {
      // The only legitimate echo is the unknown-endpoint 404 (path in message).
      const unknownEndpoint = status === 404 && bodyText.includes("Unknown endpoint");
      if (!unknownEndpoint) violations.push(`I5 canary leaked into body (status ${status})`);
      else observations.push("O1 unknown-endpoint 404 echoes the raw request path");
    }
    for (const [k, v] of response.headers) {
      if (v.includes(s.canary)) violations.push(`I5 canary leaked into header ${k}`);
    }
    if (status === 429 && !response.headers.get("retry-after"))
      violations.push("I2 429 without Retry-After");

    // I6 writes
    if (status >= 300 && dbWrites.length > 0 && expected.klass !== "upstream-5xx-write") {
      violations.push(`I6 ${dbWrites.length} DB write(s) on status ${status}`);
    }
    if (status === 200) {
      if (dbWrites.length !== expected.writes)
        violations.push(`I6 expected ${expected.writes} write(s) on 200, saw ${dbWrites.length}`);
      for (const w of dbWrites) {
        const u = new URL(w.url);
        if (w.method !== "PATCH") violations.push(`I6 non-PATCH write ${w.method}`);
        if (!u.pathname.endsWith("/rest/v1/sessions")) violations.push(`I6 write to ${u.pathname}`);
        if (u.searchParams.get("id") !== `eq.${s.idDecoded}`)
          violations.push(`I6 PATCH id filter ${u.searchParams.get("id")}`);
        if (u.searchParams.get("user_id") !== `eq.${effectiveSub(s)}`)
          violations.push(`I6 PATCH user filter ${u.searchParams.get("user_id")}`);
        try {
          const patch = JSON.parse(w.body) as Record<string, unknown>;
          const keys = Object.keys(patch);
          if (
            keys.length !== 1 ||
            keys[0] !== "ended_at" ||
            typeof patch.ended_at !== "string" ||
            Number.isNaN(Date.parse(patch.ended_at))
          ) {
            violations.push(`I6 PATCH body not {ended_at:<iso>}: ${w.body.slice(0, 120)}`);
          }
        } catch {
          violations.push(`I6 PATCH body not JSON: ${w.body.slice(0, 120)}`);
        }
      }
    }
    if (status === 429 && dbWrites.length > 0) violations.push("I6 write on 429");

    // I8 upstream surface
    for (const c of calls) {
      const ok =
        c.url.startsWith(`${SUPABASE_URL}/auth/v1/`) ||
        c.url.startsWith(`${SUPABASE_URL}/rest/v1/sessions`);
      if (!ok) violations.push(`I8 unexpected upstream ${c.method} ${c.url.slice(0, 120)}`);
    }
  }

  // I7 access log
  if (logLines.length !== 1) violations.push(`I7 ${logLines.length} access-log lines (expected 1)`);
  else {
    try {
      const entry = JSON.parse(logLines[0]) as Record<string, unknown>;
      if (entry.evt !== "api_request") violations.push("I7 access log evt mismatch");
      if (requestId && entry.requestId !== requestId)
        violations.push("I7 access-log requestId differs from header");
      if (entry.status !== status)
        violations.push(`I7 access-log status ${entry.status} vs ${status}`);
      const bearer = request.headers.get("authorization")?.replace(/^Bearer\s*/i, "") ?? "";
      if (bearer.length > 12 && logLines[0].includes(bearer.slice(0, 40)))
        violations.push("I7 bearer material in access log");
      if (typeof entry.route === "string") {
        const route = entry.route.toLowerCase();
        const embeddedUuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(
          route,
        );
        if (embeddedUuid)
          observations.push(`O2 access-log route carries a raw UUID (${s.pathKind}/${s.idKind})`);
        if (entry.route.length > 512)
          observations.push(
            `O3 access-log route exceeds 512 chars (${entry.route.length}: unbounded client path)`,
          );
      }
    } catch {
      violations.push("I7 access log line is not JSON");
    }
  }

  return {
    seed: s.seed,
    klass: expected.klass,
    status,
    code,
    requestId,
    writes: dbWrites.length,
    upstream: calls.length,
    durationMs: Math.round(durationMs * 100) / 100,
    violations,
    observations,
    scenario: {
      mode: s.mode,
      method: s.method,
      prefix: s.prefix,
      pathKind: s.pathKind,
      idKind: s.idKind,
      idRaw: s.idRaw.length > 120 ? `${s.idRaw.slice(0, 117)}…` : s.idRaw,
      queryKind: s.queryKind,
      authKind: s.authKind,
      ipKind: s.ipKind,
      reqIdKind: s.reqIdKind,
      bodyKind: s.bodyKind,
      contentType: s.contentType,
      dbKind: s.dbKind,
    },
    note: expected.note,
  };
}

// ───────────────────────────── campaign ─────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

interface Campaign {
  campaignSeed: number;
  iterations: number;
  executed: number;
  violations: number;
  statusHistogram: Record<string, number>;
  classHistogram: Record<string, number>;
  observationHistogram: Record<string, { count: number; seeds: number[] }>;
  fiveXx: Outcome[];
  failures: Outcome[];
  durationMs: { p50: number; p95: number; p99: number; max: number };
  heap: { before: number; after: number };
  outcomes: Outcome[];
}

async function runCampaign(
  seeds: number[],
  campaignSeed: number,
  verbose: boolean,
): Promise<Campaign> {
  const h = await loadHarness();
  const interceptor = installInterceptor();
  const logLines: string[] = [];
  const restoreLog = captureAccessLog((line) => logLines.push(line));
  const realError = console.error;
  const realLog = console.log;
  const serverLog: string[] = [];
  // The handler logs 5xx detail via console.error by design (operators only);
  // capture it so the run stays readable and so we can prove the detail went
  // to the LOG rather than the client.
  console.error = (...args: unknown[]) => {
    serverLog.push(
      args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "),
    );
  };
  console.log = (...args: unknown[]) => {
    serverLog.push(args.map(String).join(" "));
  };
  const outcomes: Outcome[] = [];
  const heapBefore = Deno.memoryUsage().heapUsed;
  try {
    for (const seed of seeds) {
      const scenario = generate(seed);
      const outcome = await runOne(scenario, h.handler, interceptor, logLines);
      outcomes.push(outcome);
      if (verbose) {
        realLog(JSON.stringify({ scenario, outcome }, null, 2));
      }
    }
  } finally {
    console.error = realError;
    console.log = realLog;
    restoreLog();
    interceptor.restore();
  }
  const heapAfter = Deno.memoryUsage().heapUsed;
  const statusHistogram: Record<string, number> = {};
  const classHistogram: Record<string, number> = {};
  const observationHistogram: Record<string, { count: number; seeds: number[] }> = {};
  for (const o of outcomes) {
    statusHistogram[String(o.status)] = (statusHistogram[String(o.status)] ?? 0) + 1;
    classHistogram[o.klass] = (classHistogram[o.klass] ?? 0) + 1;
    for (const obs of o.observations) {
      const key = obs.split(" (")[0];
      const bucket = (observationHistogram[key] ??= { count: 0, seeds: [] });
      bucket.count += 1;
      if (bucket.seeds.length < 10) bucket.seeds.push(o.seed);
    }
  }
  const durations = outcomes.map((o) => o.durationMs).sort((a, b) => a - b);
  const q = (p: number) =>
    durations[Math.min(durations.length - 1, Math.floor(p * durations.length))] ?? 0;
  return {
    campaignSeed,
    iterations: seeds.length,
    executed: outcomes.length,
    violations: outcomes.filter((o) => o.violations.length > 0).length,
    statusHistogram,
    classHistogram,
    observationHistogram,
    fiveXx: outcomes.filter((o) => (o.status ?? 0) >= 500),
    failures: outcomes.filter((o) => o.violations.length > 0),
    durationMs: {
      p50: q(0.5),
      p95: q(0.95),
      p99: q(0.99),
      max: durations[durations.length - 1] ?? 0,
    },
    heap: { before: heapBefore, after: heapAfter },
    outcomes,
  };
}

const CAMPAIGN_SEED = envInt("STRESS_SEED", 20260905);
const ITERATIONS = envInt("STRESS_ITER", 300);
const REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s) >>> 0);
const OUT = Deno.env.get("STRESS_OUT");

Deno.test({
  name: `stress fuzz-boundary: POST /v1/sessions/:id/finalize — ${REPLAY.length ? `replay ${REPLAY.length} seed(s)` : `${ITERATIONS} seeded requests (campaign seed ${CAMPAIGN_SEED})`}`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const seeds = REPLAY.length
      ? REPLAY
      : Array.from({ length: ITERATIONS }, (_, i) => iterationSeed(CAMPAIGN_SEED, i));
    const campaign = await runCampaign(seeds, CAMPAIGN_SEED, REPLAY.length > 0);
    const summary = {
      route: "POST /v1/sessions/:id/finalize",
      lens: "fuzz-boundary",
      campaignSeed: campaign.campaignSeed,
      iterations: campaign.iterations,
      executed: campaign.executed,
      violations: campaign.violations,
      statusHistogram: campaign.statusHistogram,
      classHistogram: campaign.classHistogram,
      modeHistogram: campaign.outcomes.reduce<Record<string, number>>(
        (acc, o) => ((acc[o.scenario.mode] = (acc[o.scenario.mode] ?? 0) + 1), acc),
        {},
      ),
      dbKindHistogramOnRouteBody: campaign.outcomes
        .filter((o) => o.klass !== "bad-input" || o.code === "session.not_found")
        .reduce<Record<string, number>>(
          (acc, o) => ((acc[o.scenario.dbKind] = (acc[o.scenario.dbKind] ?? 0) + 1), acc),
          {},
        ),
      observations: campaign.observationHistogram,
      fiveXxCount: campaign.fiveXx.length,
      fiveXxSeeds: campaign.fiveXx.map((o) => ({
        seed: o.seed,
        status: o.status,
        klass: o.klass,
        dbKind: o.scenario.dbKind,
        authKind: o.scenario.authKind,
        violations: o.violations,
      })),
      failingSeeds: campaign.failures.map((o) => ({
        seed: o.seed,
        status: o.status,
        violations: o.violations,
        scenario: o.scenario,
      })),
      durationMs: campaign.durationMs,
      heapUsedBytes: campaign.heap,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (OUT) {
      await Deno.writeTextFile(OUT, JSON.stringify({ summary, rows: campaign.outcomes }, null, 1));
      console.log(`wrote ${campaign.outcomes.length} rows → ${OUT}`);
    }
    assertEquals(campaign.executed, seeds.length, "every seed executed");
    assertEquals(
      campaign.failures.map((o) => `${o.seed}: ${o.violations.join(" | ")}`),
      [],
      `invariant violations (replay with STRESS_REPLAY=<seed>)`,
    );
  },
});

// ───────────────────────────── deterministic boundary probes ─────────────────────────────
// Not random: these pin the exact edges the fuzz relies on (budget trip
// points, request-id correlation under concurrency, the 413 boundary).

Deno.test({
  name: "stress boundary: auth-failure budget trips to 429 after 30 bad bearers from one IP, never writes",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const interceptor = installInterceptor();
    const restoreLog = captureAccessLog(() => {});
    try {
      const ip = "10.99.0.1";
      const statuses: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        const res = await h.handler(
          new Request(
            `http://edge.test/functions/v1/api/v1/sessions/${crypto.randomUUID()}/finalize`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${jwt({ iss: "https://accounts.google.com.evil", sub: "x" })}`,
                "x-forwarded-for": ip,
              },
            },
          ),
        );
        statuses.push(res.status);
        await res.body?.cancel();
        assert(res.headers.get("x-request-id"), "request id on every response");
      }
      assertEquals(statuses.slice(0, 30), Array(30).fill(401), "first 30 are 401");
      assertEquals(statuses.slice(30), Array(10).fill(429), "31st onward are 429");
      assertEquals(
        interceptor.calls.filter((c) => c.url.includes("/rest/v1/")).length,
        0,
        "no DB traffic at all",
      );
    } finally {
      restoreLog();
      interceptor.restore();
    }
  },
});

/** Only when the big campaign is requested: ~20k handler calls. */
const EVICTION_PROBE_ENABLED = ITERATIONS >= 3000 && REPLAY.length === 0;

Deno.test({
  name: "stress boundary (STRESS_ITER>=3000): a tripped auth-failure budget survives 20_000 distinct-IP requests (in-memory limiter eviction)",
  ignore: !EVICTION_PROBE_ENABLED,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const interceptor = installInterceptor();
    const restoreLog = captureAccessLog(() => {});
    try {
      const attackerIp = "10.98.0.1";
      const badBearer = `Bearer ${jwt({ iss: "https://accounts.google.com.evil", sub: "x" })}`;
      const hit = async (ip: string, auth?: string): Promise<number> => {
        const res = await h.handler(
          new Request(
            `http://edge.test/functions/v1/api/v1/sessions/${crypto.randomUUID()}/finalize`,
            {
              method: "POST",
              headers: auth
                ? { authorization: auth, "x-forwarded-for": ip }
                : { "x-forwarded-for": ip },
            },
          ),
        );
        await res.body?.cancel();
        return res.status;
      };
      const trip: number[] = [];
      for (let i = 0; i < 31; i += 1) trip.push(await hit(attackerIp, badBearer));
      assertEquals(trip[30], 429, "budget tripped after 30 failures");

      // 20_000 unrelated clients, each a fresh IP, no bearer (401, cheap).
      const flood: Record<string, number> = {};
      for (let i = 0; i < 20_000; i += 1) {
        const ip = `10.${100 + Math.floor(i / 65536)}.${Math.floor(i / 256) % 256}.${i % 256}`;
        const st = await hit(ip);
        flood[String(st)] = (flood[String(st)] ?? 0) + 1;
      }
      const after = await hit(attackerIp, badBearer);
      const evidence = {
        attackerIp,
        tripStatuses: trip,
        floodStatusHistogram: flood,
        attackerAfterFlood: after,
      };
      console.log(JSON.stringify({ probe: "rate-limit-eviction", ...evidence }, null, 2));
      assertEquals(
        interceptor.calls.filter((c) => c.url.includes("/rest/v1/")).length,
        0,
        "no DB traffic at all",
      );
      assertEquals(
        after,
        429,
        "tripped attacker budget must still be enforced after the flood (in-memory eviction must not reset it)",
      );
    } finally {
      restoreLog();
      interceptor.restore();
    }
  },
});

Deno.test({
  name: "stress boundary: 64 concurrent finalizes keep request-id correlation and exactly one PATCH each (stub)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const interceptor = installInterceptor();
    const restoreLog = captureAccessLog(() => {});
    try {
      const scenarios = Array.from({ length: 64 }, (_, i) => {
        const s = generate(iterationSeed(0xc0ffee, i));
        const rng = new Rng(s.seed);
        const forced: Scenario = {
          ...s,
          mode: "deep",
          method: "POST",
          prefix: "/functions/v1/api",
          pathKind: "canonical",
          idKind: "uuid-v4",
          idRaw: rng.uuidV4(),
          idDecoded: null,
          path: "",
          queryKind: "none",
          query: "",
          authKind: "google-valid",
          userSub: rng.uuidV4(),
          ipKind: "fresh",
          reqIdKind: "valid-uuid",
          reqIdValue: `corr-${i}-${s.seed.toString(16)}`,
          bodyKind: "client-shape",
          contentType: "application/json",
          dbKind: "open",
        };
        forced.idDecoded = forced.idRaw;
        forced.path = makePath("canonical", forced.idRaw);
        return forced;
      });
      for (const s of scenarios) interceptor.arm(s);
      const responses = await Promise.all(scenarios.map((s) => h.handler(buildRequest(s))));
      for (let i = 0; i < scenarios.length; i += 1) {
        const res = responses[i];
        assertEquals(res.status, 200, `request ${i} status`);
        assertEquals(
          res.headers.get("x-request-id"),
          scenarios[i].reqIdValue,
          `request ${i} correlation`,
        );
        await res.body?.cancel();
      }
      const patches = interceptor.calls.filter(
        (c) => c.method === "PATCH" && c.url.includes("/rest/v1/sessions"),
      );
      assertEquals(patches.length, scenarios.length, "one PATCH per open session");
      const perUser = new Set(patches.map((p) => new URL(p.url).searchParams.get("user_id")));
      assertEquals(perUser.size, scenarios.length, "every PATCH scoped to its own user");
    } finally {
      restoreLog();
      interceptor.restore();
    }
  },
});

Deno.test({
  name: "stress boundary: Content-Length exactly 5_000_000 passes the size gate; 5_000_001 is 413 before auth",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadHarness();
    const interceptor = installInterceptor();
    const restoreLog = captureAccessLog(() => {});
    try {
      const mk = (len: string) =>
        new Request(
          `http://edge.test/functions/v1/api/v1/sessions/${crypto.randomUUID()}/finalize`,
          {
            method: "POST",
            headers: { "content-length": len, "x-forwarded-for": `10.98.0.${len.length}` },
            body: "{}",
          },
        );
      const atCap = await h.handler(mk("5000000"));
      await atCap.body?.cancel();
      assertEquals(
        atCap.status,
        401,
        "at the cap the request proceeds to auth (missing bearer → 401)",
      );
      const overCap = await h.handler(mk("5000001"));
      const body = await overCap.json();
      assertEquals(overCap.status, 413);
      assertEquals(body.error.message, "Request body is too large.");
      assertEquals(interceptor.calls.length, 0, "413 happens before any upstream call");
    } finally {
      restoreLog();
      interceptor.restore();
    }
  },
});
