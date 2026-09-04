/**
 * stress_consent_withdraw_fuzz — FUZZ/BOUNDARY lens for POST /v1/me/consent/withdraw.
 *
 * Generated requests (body / query / headers / path / method / bearer /
 * injected upstream faults) are driven through the REAL handler in-process
 * (../index.ts, Deno.serve captured) with Supabase Auth, PostgREST and
 * RevenueCat stubbed at the fetch layer. Every iteration is generated from
 * its own seed and replayable alone:
 *
 *   deno test -A --no-check --config deno.json stress_consent_withdraw_fuzz.test.ts
 *   STRESS_ITER=3000  …            # campaign size (default 300 — fast enough for the suite)
 *   STRESS_SEED=20260904 …         # campaign base seed
 *   STRESS_REPLAY=<iterationSeed> …# run exactly one iteration (printed on failure)
 *   STRESS_OUT_DIR=/tmp/stress …   # JSON tables (seed → outcome) land here
 *   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres …
 *                                  # ALSO drive the same campaign over a real
 *                                  # docker postgres:16 with every migration
 *                                  # applied (./xc_pg_up.sh); STRESS_PG_ITER
 *                                  # sizes it (default 400). Without it the PG
 *                                  # tests are `ignore`d — an ignored run is
 *                                  # NOT a pass.
 *
 * Invariants asserted on EVERY iteration:
 *   - rejected input answers only 400/401/403/404/405/413/415/429; 5xx only
 *     when an upstream fault was injected, and then with a generic body
 *   - no stack trace / PostgREST or PG code / table name / host / injected
 *     canary anywhere in the client-visible body or headers
 *   - no consent_records write on any rejection (PostgREST POST count and
 *     ledger row count), exactly one correct row on acceptance
 *   - x-request-id on every response; a well-formed incoming id is echoed,
 *     anything else is replaced
 *   - the stub saw no fetch outside Auth + consent_records
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  ALLOWED_REJECT_STATUSES,
  appleIdToken,
  type ConsentBackend,
  CONSENT_SCOPES,
  hasControlChars,
  expectedFold,
  expectedInsertRow,
  type Fault,
  googleIdToken,
  headersRecord,
  jwt,
  leaks,
  type LedgerRow,
  loadStressHarness,
  MAX_JSON_BODY_BYTES,
  MemoryBackend,
  Prng,
  REQUEST_ID_RE,
  RestError,
  ROUTE_PATH,
  sessionToken,
  type StressHarness,
  SUPABASE_URL,
} from "./stress_consent_withdraw_harness.ts";

const envInt = (name: string, fallback: number): number => {
  const raw = Deno.env.get(name);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};
const STRESS_ITER = envInt("STRESS_ITER", 300);
const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_REPLAY = Deno.env.get("STRESS_REPLAY");
const STRESS_OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ?? "/tmp/stress-consent-withdraw";
const STRESS_PG_URL = Deno.env.get("STRESS_PG_URL") ?? "";
const STRESS_PG_ITER = envInt("STRESS_PG_ITER", 400);
const BASE_URL = "http://edge.test/functions/v1/api";

// ─── iteration model ────────────────────────────────────────────────────────

type Category = "valid" | "bad_body" | "bad_auth" | "bad_route" | "headers" | "oversize" | "fault";

interface Plan {
  seed: number;
  category: Category;
  kind: string;
  userId: string;
  ledgerBefore: LedgerRow[];
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  /** The JSON object the route will see (null when the body is not a valid object). */
  bodyObject: Record<string, unknown> | null;
  providedRequestId: string | null;
  fault: Fault | null;
  refusedSub: boolean;
  providerless: boolean;
  /** What the contract says must come back. */
  expectStatus: number[];
  expectWrite: boolean;
  /** false → Supabase Auth must NOT be consulted (locally refusable bearer,
   * pre-auth 413, or an auth-cache hit); null → not asserted. */
  expectAuthCall: boolean | null;
  /** Owner reuses the previous iteration's identity (auth-cache hit path). */
  reuse: boolean;
}

interface Outcome {
  seed: number;
  category: Category;
  kind: string;
  method: string;
  path: string;
  status: number;
  expectStatus: number[];
  requestId: string | null;
  restGets: number;
  restPosts: number;
  ledgerDelta: number;
  ms: number;
  violations: string[];
  bodyPreview: string;
}

const iterationSeed = (base: number, i: number): number => {
  // splitmix-ish mixing so neighbouring iterations are unrelated
  let x = (base ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
};

const ipOf = (seed: number): string =>
  `10.${(seed >>> 16) & 255}.${(seed >>> 8) & 255}.${seed & 255}`;

/** Header values must be Latin-1 without NUL/CR/LF (Headers throws otherwise). */
function headerSafe(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0 || code === 10 || code === 13) continue;
    out += code > 0xff ? String.fromCharCode(0x20 + (code % 0x5f)) : ch;
  }
  return out;
}

function seedLedger(rng: Prng, userId: string): LedgerRow[] {
  const n = rng.int(0, 6);
  const rows: LedgerRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      user_id: userId,
      scope: rng.pick(CONSENT_SCOPES),
      action: rng.chance(0.65) ? "grant" : "withdraw",
      consent_version: rng.chance(0.85)
        ? rng.pick([
            "model-training-v1",
            "evaluation-telemetry-v1",
            "v1",
            "2026-08-29",
            "x".repeat(rng.int(1, 50)),
          ])
        : null,
      source: rng.chance(0.5) ? "settings" : null,
      device: rng.chance(0.5) ? "iPhone16,1 iOS 18.5" : null,
      created_at: "",
    });
  }
  return rows;
}

/** A body the route must ACCEPT: valid scope plus optional/extra fields of
 * every type (only string source/device are stored, sanitized). `raw` may
 * carry extra keys (`__proto__`, `constructor`, …) appended textually so the
 * generator's own object is never prototype-polluted. */
function validBody(rng: Prng): { object: Record<string, unknown>; raw: string } {
  const body: Record<string, unknown> = { scope: rng.pick(CONSENT_SCOPES) };
  const roll = rng.next();
  if (roll < 0.3) body.source = rng.pick(["settings", "onboarding", "", " ", rng.nastyString(200)]);
  else if (roll < 0.45) body.source = rng.pick([null, 1, true, [], {}, { a: 1 }]);
  const roll2 = rng.next();
  if (roll2 < 0.3)
    body.device = rng.pick(["iPhone16,1", rng.nastyString(1500), "😀".repeat(rng.int(1, 600))]);
  else if (roll2 < 0.45) body.device = rng.pick([null, 7, false, ["x"], { model: "iPhone" }]);
  let raw = JSON.stringify(body);
  if (rng.chance(0.25)) {
    const key = rng.pick([
      "consentVersion",
      "captureMode",
      "__proto__",
      "constructor",
      "user_id",
      "action",
      "id",
      rng.nastyString(20),
    ]);
    const value = rng.pick<unknown>([
      rng.nastyString(40),
      1,
      null,
      { toString: "x" },
      "grant",
      { scope: "model_training" },
    ]);
    raw = `${raw.slice(0, -1)},${JSON.stringify(key)}:${JSON.stringify(value)}}`;
  }
  return { object: body, raw };
}

/** Bodies the route must REFUSE with 400 — except `accepted`, where the
 * platform normalises the wire bytes into a valid object (a UTF-8 BOM is
 * stripped by `Request.text()`), so the contract is a correct 200. */
function badBody(rng: Prng): {
  kind: string;
  raw: string | null;
  accepted?: Record<string, unknown>;
} {
  const kind = rng.pick([
    "no_body",
    "empty",
    "not_json",
    "truncated_json",
    "json_array",
    "json_scalar",
    "empty_object",
    "scope_missing",
    "scope_wrong_type",
    "scope_unknown",
    "scope_case_or_space",
    "scope_homoglyph",
    "scope_huge",
    "deep_nesting",
    "proto_pollution",
    "duplicate_keys",
    "bom_prefixed",
    "unicode_escapes",
  ] as const);
  const valid = rng.pick(CONSENT_SCOPES);
  switch (kind) {
    case "no_body":
      return { kind, raw: null };
    case "empty":
      return { kind, raw: "" };
    case "not_json":
      return {
        kind,
        raw: rng.pick([
          rng.nastyString(300),
          "scope=video_analysis",
          "<xml/>",
          "NaN",
          "undefined",
          "'{}'",
        ]),
      };
    case "truncated_json": {
      const full = JSON.stringify({ scope: valid, source: "settings" });
      return { kind, raw: full.slice(0, rng.int(1, full.length - 1)) };
    }
    case "json_array":
      return { kind, raw: JSON.stringify([{ scope: valid }]) };
    case "json_scalar":
      return { kind, raw: rng.pick(['"video_analysis"', "1", "null", "true", "-0", "1e999"]) };
    case "empty_object":
      return { kind, raw: "{}" };
    case "scope_missing":
      return { kind, raw: JSON.stringify({ Scope: valid, source: "settings", scopes: [valid] }) };
    case "scope_wrong_type":
      return {
        kind,
        raw: JSON.stringify({
          scope: rng.pick([1, 0, null, true, [valid], { scope: valid }, [""], -1e308]),
        }),
      };
    case "scope_unknown":
      return {
        kind,
        raw: JSON.stringify({
          scope: rng.pick([
            rng.nastyString(60),
            "",
            "all",
            "*",
            "video",
            "video_analysis;drop",
            valid + "\u0000",
            "video_analysis\u200b",
          ]),
        }),
      };
    case "scope_case_or_space":
      return {
        kind,
        raw: JSON.stringify({
          scope: rng.pick([
            valid.toUpperCase(),
            ` ${valid}`,
            `${valid} `,
            valid.replace("_", "-"),
            valid.replace("_", " "),
          ]),
        }),
      };
    case "scope_homoglyph":
      return {
        kind,
        raw: JSON.stringify({ scope: valid.replace("a", "\u0430").replace("e", "\u0435") }),
      };
    case "scope_huge":
      return { kind, raw: JSON.stringify({ scope: valid.repeat(rng.int(2, 5000)) }) };
    case "deep_nesting": {
      const depth = rng.int(1000, 200_000);
      return { kind, raw: `{"scope":${"[".repeat(depth)}${"]".repeat(depth)}}` };
    }
    case "proto_pollution":
      return {
        kind,
        raw: `{"__proto__":{"scope":"${valid}"},"constructor":{"prototype":{"scope":"${valid}"}}}`,
      };
    case "duplicate_keys":
      return {
        kind,
        raw: `{"scope":"${valid}","scope":${rng.pick(["1", "null", '"nope"', "[]"])}}`,
      };
    case "bom_prefixed":
      return { kind, raw: `\ufeff${JSON.stringify({ scope: valid })}`, accepted: { scope: valid } };
    case "unicode_escapes":
      return {
        kind,
        raw: `{"scope":"${valid.replace(/./g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\\u0000"}`,
      };
  }
}

function validAuth(rng: Prng, userId: string): { kind: string; header: string } {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const kind = rng.pick([
    "google",
    "apple",
    "session",
    "google_string_exp",
    "google_no_scheme_iss",
    "session_extra_claims",
    "session_huge_payload",
    "bearer_padding",
  ] as const);
  switch (kind) {
    case "google":
      return { kind, header: `Bearer ${googleIdToken(userId, exp)}` };
    case "apple":
      return { kind, header: `Bearer ${appleIdToken(userId, exp)}` };
    case "session":
      return { kind, header: `Bearer ${sessionToken(userId, exp)}` };
    case "google_string_exp":
      return {
        kind,
        header: `Bearer ${jwt({ iss: "https://accounts.google.com", sub: userId, exp: "9999999999" })}`,
      };
    case "google_no_scheme_iss":
      return { kind, header: `Bearer ${jwt({ iss: "accounts.google.com", sub: userId, exp })}` };
    case "session_extra_claims":
      return {
        kind,
        header: `Bearer ${jwt({ iss: `${SUPABASE_URL}/auth/v1`, sub: userId, exp, session_id: "s", role: "service_role", is_anonymous: true, aal: "aal1", amr: [{ method: "oauth" }] })}`,
      };
    case "session_huge_payload":
      return {
        kind,
        header: `Bearer ${jwt({ iss: `${SUPABASE_URL}/auth/v1`, sub: userId, exp, pad: "p".repeat(rng.int(1000, 20_000)) })}`,
      };
    case "bearer_padding":
      return {
        kind,
        header: `Bearer ${" ".repeat(rng.int(1, 3))}${googleIdToken(userId, exp)}${" ".repeat(rng.int(0, 3))}`,
      };
  }
}

function badAuth(
  rng: Prng,
  userId: string,
): { kind: string; header: string | null; refused?: boolean; providerless?: boolean } {
  const past = Math.floor(Date.now() / 1000) - rng.int(1, 100_000);
  const kind = rng.pick([
    "missing",
    "empty_bearer",
    "wrong_scheme",
    "lowercase_scheme",
    "garbage",
    "not_jwt",
    "jwt_bad_iss",
    "jwt_no_iss",
    "jwt_garbage_payload",
    "expired_google",
    "expired_apple",
    "expired_session",
    "refused_google",
    "refused_session",
    "providerless_session",
    "issuer_lookalike",
  ] as const);
  switch (kind) {
    case "missing":
      return { kind, header: null };
    case "empty_bearer":
      return { kind, header: rng.pick(["Bearer", "Bearer ", "Bearer    "]) };
    case "wrong_scheme":
      return {
        kind,
        header: rng.pick([
          `Basic ${btoa("a:b")}`,
          `Token ${googleIdToken(userId)}`,
          googleIdToken(userId),
        ]),
      };
    case "lowercase_scheme":
      return { kind, header: `bearer ${googleIdToken(userId)}` };
    case "garbage":
      return { kind, header: headerSafe(rng.nastyString(200)) || "x" };
    case "not_jwt":
      return {
        kind,
        header: `Bearer ${rng.pick(["abc", "a.b", "a.b.c.d", "....", "session-for-" + userId, "x".repeat(5000)])}`,
      };
    case "jwt_bad_iss":
      return {
        kind,
        header: `Bearer ${jwt({ iss: rng.pick(["https://evil.example", "http://accounts.google.com", "https://accounts.google.com.evil", `${SUPABASE_URL}/auth/v2`, `${SUPABASE_URL}/auth/v1/`, 42]), sub: userId, exp: past + 200_000 })}`,
      };
    case "jwt_no_iss":
      return { kind, header: `Bearer ${jwt({ sub: userId, exp: past + 200_000 })}` };
    case "jwt_garbage_payload":
      return {
        kind,
        header: `Bearer eyJhbGciOiJSUzI1NiJ9.${rng.pick(["!!!", "e30", "bnVsbA", "W10", "IiI"])}.sig`,
      };
    case "expired_google":
      return { kind, header: `Bearer ${googleIdToken(userId, past)}` };
    case "expired_apple":
      return { kind, header: `Bearer ${appleIdToken(userId, past)}` };
    case "expired_session":
      return { kind, header: `Bearer ${sessionToken(userId, past)}` };
    case "refused_google":
      return { kind, header: `Bearer ${googleIdToken(userId)}`, refused: true };
    case "refused_session":
      return { kind, header: `Bearer ${sessionToken(userId)}`, refused: true };
    case "providerless_session":
      return { kind, header: `Bearer ${sessionToken(userId)}`, providerless: true };
    case "issuer_lookalike":
      // Ends in /auth/v1 so the edge routes it to getUser(); real GoTrue (and
      // the stub) refuse a JWT they did not issue.
      return {
        kind,
        header: `Bearer ${jwt({ iss: rng.pick(["https://accounts.google.com/auth/v1", "https://evil.example/auth/v1"]), sub: userId, exp: past + 200_000 })}`,
      };
  }
}

const PUBLIC_SUFFIXES = ["/healthz", "/support", "/privacy", "/terms", "/webhooks/revenuecat"];

function badRoute(rng: Prng): { kind: string; method: string; path: string } {
  const roll = rng.next();
  if (roll < 0.35) {
    return {
      kind: "method",
      method: rng.pick([
        "GET",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
        "P0ST",
        "post",
        "Post",
        "POSTX",
        "QUERY",
      ]),
      path: ROUTE_PATH,
    };
  }
  const variants: Record<string, string> = {
    trailing_slash: `${ROUTE_PATH}/`,
    upper: "/v1/me/consent/WITHDRAW",
    mixed: "/v1/Me/consent/withdraw",
    suffix: `${ROUTE_PATH}${rng.pick(["x", ".json", "%20", "%00", "%", "%zz", "\u00e9", ";", ":1"])}`,
    extra_segment: `${ROUTE_PATH}/${rng.pick(["extra", "..", ".", "video_analysis"])}`,
    double_slash: "/v1/me/consent//withdraw",
    leading_double_slash: `/${ROUTE_PATH}`,
    percent_encoded_letter: "/v1/me/consent/wit%68draw",
    percent_encoded_slash: "/v1/me%2Fconsent/withdraw",
    dot_segment: "/v1/me/consent/./withdraw",
    dotdot_segment: "/v1/me/consent/../consent/withdraw",
    v1_twice: "/v1/me/consent/withdraw/v1/",
    prefix_v1: "/v1/v1/me/consent/withdraw",
    no_v1: "/me/consent/withdraw",
    unicode_path: "/v1/me/consent/with\u200bdraw",
    long_path: `${ROUTE_PATH}/${"a".repeat(rng.int(100, 8000))}`,
    sibling_probe: `/v1/me/consent/${rng.pick(["grant/", "status", "revoke", "withdrawal", "withdraw-all", "withdraw?x", "withdraw#f"])}`,
    query_only: `${ROUTE_PATH}?${rng.pick(["scope=video_analysis", "scope=x&scope=y", "%00", "a".repeat(5000), "path=/v1/me/consent/grant"])}`,
  };
  const kind = rng.pick(Object.keys(variants));
  return { kind, method: "POST", path: variants[kind] };
}

/** The route string the handler will compute for `method` + `url`. */
function routeOf(method: string, url: string): string {
  const pathname = new URL(url).pathname;
  const v1 = pathname.lastIndexOf("/v1/");
  return `${method} ${v1 >= 0 ? pathname.slice(v1) : pathname}`;
}

function plan(seed: number, previous: Plan | null): Plan {
  const rng = new Prng(seed);
  const roll = rng.next();
  const category: Category =
    roll < 0.3
      ? "valid"
      : roll < 0.55
        ? "bad_body"
        : roll < 0.7
          ? "bad_auth"
          : roll < 0.8
            ? "bad_route"
            : roll < 0.9
              ? "headers"
              : roll < 0.905
                ? "oversize"
                : "fault";

  // Identity: fresh per iteration (rate limits never trip), occasionally the
  // previous identity so the auth-cache hit path is exercised too.
  const reuse = previous !== null && previous.category === "valid" && rng.chance(0.2);
  const userId = reuse ? previous.userId : rng.uuid();
  const ledgerBefore = reuse ? [] : seedLedger(rng, userId);

  const headers: Record<string, string> = { "x-forwarded-for": ipOf(seed) };
  let method = "POST";
  let path = ROUTE_PATH;
  let body: string | null = null;
  let bodyObject: Record<string, unknown> | null = null;
  let kind = "";
  let fault: Fault | null = null;
  let refusedSub = false;
  let providerless = false;
  let expectStatus: number[] = [200];
  let expectWrite = true;
  let expectAuthCall: boolean | null = reuse ? false : null;
  let providedRequestId: string | null = null;

  const setValidBody = () => {
    const generated = validBody(rng);
    bodyObject = generated.object;
    body = generated.raw;
    headers["content-type"] = "application/json";
  };
  const setValidAuth = () => {
    if (reuse) {
      headers["authorization"] = previous!.headers["authorization"];
      kind += `+reuse(${previous!.kind})`;
      return;
    }
    const auth = validAuth(rng, userId);
    headers["authorization"] = auth.header;
    kind += `+${auth.kind}`;
  };

  switch (category) {
    case "valid": {
      kind = "valid";
      setValidBody();
      setValidAuth();
      if (rng.chance(0.3)) {
        providedRequestId = `req-${seed.toString(16)}-${"a".repeat(rng.int(0, 40))}`;
        headers["x-request-id"] = providedRequestId;
      }
      if (rng.chance(0.3))
        path += `?${rng.pick(["", "scope=model_training", "x=1&y=2", "%ff", "a".repeat(2000)])}`;
      break;
    }
    case "bad_body": {
      const bad = badBody(rng);
      kind = bad.kind;
      body = bad.raw;
      if (body !== null)
        headers["content-type"] = rng.pick([
          "application/json",
          "text/plain",
          "application/json; charset=utf-8",
        ]);
      setValidAuth();
      if (bad.accepted) {
        bodyObject = bad.accepted;
      } else {
        expectStatus = [400];
        expectWrite = false;
      }
      break;
    }
    case "bad_auth": {
      const auth = badAuth(rng, userId);
      kind = auth.kind;
      if (auth.header !== null) headers["authorization"] = auth.header;
      refusedSub = Boolean(auth.refused);
      providerless = Boolean(auth.providerless);
      setValidBody();
      expectStatus = [401];
      expectWrite = false;
      expectAuthCall =
        kind.startsWith("refused_") ||
        kind === "providerless_session" ||
        kind === "issuer_lookalike"
          ? null
          : false;
      break;
    }
    case "bad_route": {
      const r = badRoute(rng);
      kind = `route:${r.kind}`;
      method = r.method;
      path = r.path;
      setValidAuth();
      if (method !== "GET" && method !== "HEAD") setValidBody();
      break; // expectStatus resolved after URL construction (normalisation may re-match)
    }
    case "headers": {
      setValidBody();
      setValidAuth();
      const h = rng.pick([
        "content_type",
        "request_id_valid",
        "request_id_invalid",
        "forwarded_for",
        "cf_ip",
        "content_length",
        "accept",
        "random_headers",
        "auth_whitespace",
      ] as const);
      kind = `hdr:${h}`;
      switch (h) {
        case "content_type":
          headers["content-type"] = rng.pick([
            "text/plain",
            "application/xml",
            "multipart/form-data; boundary=x",
            "",
            "application/json; charset=utf-16",
            headerSafe(rng.nastyString(80)),
          ]);
          break;
        case "request_id_valid":
          providedRequestId = rng.pick([
            `r${seed}`.padEnd(8, "0"),
            "a".repeat(64),
            "A-b_c.d1",
            `${crypto.randomUUID()}`,
            "........",
          ]);
          headers["x-request-id"] = providedRequestId;
          break;
        case "request_id_invalid":
          headers["x-request-id"] = rng.pick([
            "short",
            "a".repeat(65),
            "has space 12345",
            "../../etc/passwd",
            "",
            "id;drop",
            headerSafe(rng.nastyString(70)),
            "\t\t\t\t\t\t\t\t",
          ]);
          break;
        case "forwarded_for":
          headers["x-forwarded-for"] = rng.pick([
            `1.2.3.4, ${ipOf(seed)}`,
            `${ipOf(seed)},`,
            ` , ${ipOf(seed)} `,
            `${headerSafe(rng.nastyString(100))}, ${ipOf(seed)}`,
            `${"9.9.9.9, ".repeat(500)}${ipOf(seed)}`,
            `[::1], ${ipOf(seed)}`,
          ]);
          break;
        case "cf_ip":
          headers["cf-connecting-ip"] = rng.pick([
            ipOf(seed),
            `2001:db8::${seed.toString(16)}`,
            headerSafe(rng.nastyString(60)) || ipOf(seed),
          ]);
          break;
        case "content_length": {
          const cl = rng.pick([
            "abc",
            "-1",
            "1e400",
            "Infinity",
            "NaN",
            " 12 ",
            "0x10",
            "5000000",
            "5000001",
            "1e7",
            "9007199254740993",
            "0",
            "1,2",
            "",
            "4999999.9",
          ]);
          headers["content-length"] = cl;
          const n = Number(cl);
          if (Number.isFinite(n) && n > MAX_JSON_BODY_BYTES) {
            expectStatus = [413];
            expectWrite = false;
            expectAuthCall = false;
          }
          break;
        }
        case "accept":
          headers["accept"] = rng.pick([
            "application/vnd.pgrst.object+json",
            "text/html",
            "*/*",
            "",
            headerSafe(rng.nastyString(60)),
          ]);
          break;
        case "random_headers":
          for (let i = rng.int(1, 6); i > 0; i--) {
            const name = rng.pick([
              "x-" + rng.nastyString(10).replace(/[^a-z0-9-]/gi, "") || "x-h",
              "prefer",
              "range",
              "x-supabase-auth",
              "apikey",
              "cookie",
              "origin",
              "host",
              "if-match",
              "te",
            ]);
            headers[name] = headerSafe(rng.nastyString(120));
          }
          break;
        case "auth_whitespace":
          headers["authorization"] = headers["authorization"].replace(
            "Bearer ",
            `Bearer ${"\t".repeat(rng.int(1, 3))}`,
          );
          break;
      }
      break;
    }
    case "oversize": {
      kind = "oversize";
      setValidAuth();
      const overBy = rng.int(1, 4096);
      bodyObject = null;
      const prefix = `{"scope":"${rng.pick(CONSENT_SCOPES)}","pad":"`;
      const suffix = '"}';
      body =
        prefix + "p".repeat(MAX_JSON_BODY_BYTES + overBy - prefix.length - suffix.length) + suffix;
      headers["content-type"] = "application/json";
      expectStatus = [413];
      expectWrite = false;
      break;
    }
    case "fault": {
      setValidBody();
      setValidAuth();
      const canary = `CANARY-${seed.toString(16)}-${rng.uuid()}`;
      const at = rng.pick(["select", "insert", "auth"] as const);
      let injected: Fault;
      if (at === "auth" && reuse) {
        // a cached identity never reaches Auth; make this iteration a select fault instead
        injected = { at: "select", kind: "rest_error", status: 500, canary };
      } else if (at === "auth") {
        const k = rng.pick(["status", "throw", "garbage"] as const);
        injected =
          k === "status"
            ? { at, kind: k, status: rng.pick([500, 502, 503, 429, 404, 200]), canary }
            : { at, kind: k, canary };
        expectAuthCall = null;
      } else {
        const k = rng.pick(["rest_error", "throw", "garbage"] as const);
        injected =
          k === "rest_error"
            ? { at, kind: k, status: rng.pick([500, 503, 400, 401, 403, 404, 409]), canary }
            : { at, kind: k, canary };
      }
      fault = injected;
      kind = `fault:${injected.at}:${injected.kind}${"status" in injected ? ":" + injected.status : ""}`;
      // Any injected upstream failure must surface as a GENERIC 5xx (or, on
      // the transitional provider-token path where Auth is the identity
      // verifier, as 401). Never a 200, never detail.
      expectStatus = injected.at === "auth" ? [401, 503] : [503, 500];
      // A 200 from a garbage/"200" auth stub is refused by the parser → still 401/503.
      expectWrite = false;
      break;
    }
  }

  const url = `${BASE_URL}${path}`;
  const constructed = (() => {
    try {
      return new Request(url, { method, headers: new Headers(headers), body: body ?? undefined });
    } catch (error) {
      return error as Error;
    }
  })();
  if (constructed instanceof Error) {
    // The generated method/header combination is not a legal Request in the
    // platform (never reaches the handler); degrade to a plain 404 probe.
    method = "PUT";
    body = null;
    bodyObject = null;
    for (const key of Object.keys(headers)) {
      if (key !== "authorization" && key !== "x-forwarded-for") delete headers[key];
    }
    headers["x-forwarded-for"] = ipOf(seed);
    if (!headers["authorization"]) headers["authorization"] = `Bearer ${googleIdToken(userId)}`;
    kind += "+illegal_request→PUT";
    expectStatus = [404];
    expectWrite = false;
  }
  const finalMethod = constructed instanceof Request ? constructed.method : method;
  if (category === "bad_route" && constructed instanceof Request) {
    const route = routeOf(finalMethod, url);
    const matches = route === `POST ${ROUTE_PATH}`;
    const isPublic =
      (finalMethod === "GET" || finalMethod === "HEAD") &&
      PUBLIC_SUFFIXES.some((s) => new URL(url).pathname.endsWith(s));
    assert(!isPublic, `generator must not produce public routes: ${route}`);
    expectStatus = matches ? [200] : [404];
    expectWrite = matches;
  }

  return {
    seed,
    category,
    kind,
    userId,
    ledgerBefore,
    method: finalMethod,
    url,
    headers,
    body,
    bodyObject: expectStatus[0] === 200 ? bodyObject : null,
    providedRequestId,
    fault,
    refusedSub,
    providerless,
    expectStatus,
    expectWrite,
    expectAuthCall,
    reuse,
  };
}

// ─── execution + oracle ─────────────────────────────────────────────────────

async function execute(h: StressHarness, p: Plan): Promise<Outcome> {
  h.reset();
  h.refusedSubs.clear();
  h.providerlessSubs.clear();
  if (p.refusedSub) h.refusedSubs.add(p.userId);
  if (p.providerless) h.providerlessSubs.add(p.userId);
  if (!p.reuse) await h.backend.seed(p.userId, p.ledgerBefore);
  const ledgerBefore = await h.backend.ledgerOf(p.userId);
  h.fault = p.fault;

  const request = new Request(p.url, {
    method: p.method,
    headers: new Headers(p.headers),
    body: p.body === null || p.method === "GET" || p.method === "HEAD" ? undefined : p.body,
  });
  const started = performance.now();
  const response = await h.handler(request);
  const text = await response.text();
  const ms = performance.now() - started;
  const ledgerAfter = await h.backend.ledgerOf(p.userId);
  const violations: string[] = [];
  const v = (cond: boolean, msg: string) => {
    if (!cond) violations.push(msg);
  };

  const status = response.status;
  const requestId = response.headers.get("x-request-id");
  const restGets = h.restCalls("GET").length;
  const restPosts = h.restCalls("POST").length;
  const authCalls = h.calls.filter((c) => c.url.includes("/auth/v1/")).length;
  const ledgerDelta = ledgerAfter.length - ledgerBefore.length;

  // ── universal invariants
  v(
    requestId !== null && REQUEST_ID_RE.test(requestId),
    `x-request-id missing/malformed: ${requestId}`,
  );
  if (p.providedRequestId !== null) {
    v(
      requestId === p.providedRequestId,
      `well-formed x-request-id not echoed (${requestId} ≠ ${p.providedRequestId})`,
    );
  } else if (p.headers["x-request-id"] !== undefined) {
    v(
      requestId !== p.headers["x-request-id"].trim(),
      `malformed x-request-id echoed: ${requestId}`,
    );
  }
  v(
    status === 200 ||
      ALLOWED_REJECT_STATUSES.has(status) ||
      (p.fault !== null && status >= 500 && status < 600),
    `status ${status} outside contract`,
  );
  v(status < 500 || p.fault !== null, `5xx (${status}) without an injected fault`);
  v(h.unexpected.length === 0, `unexpected upstream fetch: ${h.unexpected.join(" | ")}`);
  v(
    (response.headers.get("content-type") ?? "").includes("application/json"),
    `content-type ${response.headers.get("content-type")}`,
  );
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    v(false, "body is not JSON");
  }
  const canary = p.fault?.canary;
  const headerText = JSON.stringify(headersRecord(response.headers));
  const leak = leaks(text, canary) ?? leaks(headerText, canary);
  v(leak === null, `internal detail leaked: ${leak}`);
  v(!hasControlChars(text), "control characters in body");
  v(!text.includes(p.userId) || status === 200, "user id echoed on a rejection");

  const isRecord = (x: unknown): x is Record<string, unknown> =>
    Boolean(x) && typeof x === "object" && !Array.isArray(x);
  if (status >= 400 && isRecord(parsed)) {
    const err = parsed.error;
    v(
      isRecord(err) &&
        typeof err.message === "string" &&
        err.message.length > 0 &&
        err.message.length <= 16_384,
      "error.message missing or oversized",
    );
    if (status >= 500 && isRecord(err)) {
      v(
        /temporarily unavailable|Something went wrong/.test(String(err.message)),
        `5xx body not generic: ${String(err.message)}`,
      );
      v(err.code === undefined, "5xx carries a code");
    }
    if (status === 429) v(response.headers.has("retry-after"), "429 without Retry-After");
    if (status === 503 && p.fault?.at === "auth")
      v(response.headers.has("retry-after"), "auth 503 without Retry-After");
  }

  // ── contract for this plan
  v(p.expectStatus.includes(status), `expected ${p.expectStatus.join("/")}, got ${status}`);
  if (p.expectAuthCall === false) {
    v(
      authCalls === 0,
      `Supabase Auth consulted (${authCalls}) for a locally refusable / cached / pre-auth-refused request`,
    );
  }
  if (status !== 200) {
    v(ledgerDelta === 0, `ledger grew by ${ledgerDelta} on a ${status}`);
    const insertFault = p.fault?.at === "insert";
    v(restPosts === (insertFault ? 1 : 0), `${restPosts} PostgREST writes on a ${status}`);
    if (status === 400 || status === 401 || status === 404 || status === 413) {
      v(restGets === 0, `${restGets} PostgREST reads on a ${status}`);
    }
    if (status === 400 && isRecord(parsed) && isRecord(parsed.error)) {
      v(
        parsed.error.code === "validation.consent_withdraw",
        `400 code ${String(parsed.error.code)}`,
      );
    }
    if (status === 404 && isRecord(parsed) && isRecord(parsed.error)) {
      v(
        String(parsed.error.message).startsWith("Unknown endpoint: "),
        `404 body ${String(parsed.error.message)}`,
      );
    }
  } else {
    v(p.expectWrite, "200 where a rejection was expected");
    v(ledgerDelta === 1, `ledger grew by ${ledgerDelta} on a 200`);
    v(
      restPosts === 1 && restGets === 2,
      `rest calls on a 200: ${restGets} GET / ${restPosts} POST`,
    );
    if (p.bodyObject !== null) {
      const want = expectedInsertRow(p.userId, ledgerBefore, p.bodyObject);
      const post = h.restCalls("POST")[0];
      if (post) {
        try {
          assertEquals(post.body, want);
        } catch (error) {
          v(
            false,
            `insert row mismatch: ${(error as Error).message.split("\n").slice(0, 6).join(" ")}`,
          );
        }
        v(
          (post.headers["authorization"] ?? "").startsWith("Bearer "),
          "write without the user's bearer",
        );
      }
      const appended = ledgerAfter[ledgerAfter.length - 1];
      if (appended) {
        v(
          appended.user_id === p.userId &&
            appended.scope === want.scope &&
            appended.action === "withdraw",
          "appended row is not the caller's withdraw",
        );
        v(
          (appended.consent_version ?? null) === want.consent_version,
          `appended consent_version ${appended.consent_version} ≠ ${want.consent_version}`,
        );
      }
      const fold = expectedFold(ledgerAfter);
      if (isRecord(parsed)) {
        try {
          assertEquals(parsed, { subjectPseudonym: null, scopes: fold });
        } catch (error) {
          v(
            false,
            `folded status mismatch: ${(error as Error).message.split("\n").slice(0, 8).join(" ")}`,
          );
        }
      }
      const scopeStatus = fold.find((s) => s.scope === want.scope);
      v(
        scopeStatus?.active === false && scopeStatus.lastAction === "withdrawn",
        "withdrawn scope still active in the folded status",
      );
    }
  }

  return {
    seed: p.seed,
    category: p.category,
    kind: p.kind,
    method: p.method,
    path: p.url.slice(BASE_URL.length),
    status,
    expectStatus: p.expectStatus,
    requestId,
    restGets,
    restPosts,
    ledgerDelta,
    ms: Math.round(ms * 100) / 100,
    violations,
    bodyPreview: text.slice(0, 160),
  };
}

interface Campaign {
  plane: string;
  backend: string;
  baseSeed: number;
  iterations: number;
  executed: number;
  byCategory: Record<string, number>;
  byStatus: Record<string, number>;
  byKind: Record<string, { n: number; statuses: Record<string, number> }>;
  fiveXx: Outcome[];
  failures: Outcome[];
  latencyMs: { p50: number; p95: number; max: number };
  replay: string;
  outcomes: Outcome[];
}

async function runCampaign(
  h: StressHarness,
  backendName: string,
  iterations: number,
  baseSeed: number,
  file: string,
): Promise<Campaign> {
  const outcomes: Outcome[] = [];
  const byCategory: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byKind: Record<string, { n: number; statuses: Record<string, number> }> = {};
  let previous: Plan | null = null;
  const seeds =
    STRESS_REPLAY !== undefined
      ? [Number(STRESS_REPLAY)]
      : Array.from({ length: iterations }, (_, i) => iterationSeed(baseSeed, i));
  for (const seed of seeds) {
    const p = plan(seed, previous);
    const outcome = await execute(h, p);
    outcomes.push(outcome);
    byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
    byStatus[String(outcome.status)] = (byStatus[String(outcome.status)] ?? 0) + 1;
    const k = (byKind[p.kind.split("+")[0]] ??= { n: 0, statuses: {} });
    k.n += 1;
    k.statuses[String(outcome.status)] = (k.statuses[String(outcome.status)] ?? 0) + 1;
    previous = p;
  }
  const sorted = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const campaign: Campaign = {
    plane: "cloud/linux (in-process real handler)",
    backend: backendName,
    baseSeed,
    iterations: seeds.length,
    executed: outcomes.length,
    byCategory,
    byStatus,
    byKind,
    fiveXx: outcomes.filter((o) => o.status >= 500),
    failures: outcomes.filter((o) => o.violations.length > 0),
    latencyMs: { p50: q(0.5), p95: q(0.95), max: sorted[sorted.length - 1] ?? 0 },
    replay: `STRESS_REPLAY=<seed> ${backendName === "postgres" ? "STRESS_PG_URL=… " : ""}deno test -A --no-check --config deno.json stress_consent_withdraw_fuzz.test.ts`,
    outcomes,
  };
  await Deno.mkdir(STRESS_OUT_DIR, { recursive: true });
  await Deno.writeTextFile(`${STRESS_OUT_DIR}/${file}`, JSON.stringify(campaign, null, 1));
  return campaign;
}

function assertCampaignClean(c: Campaign): void {
  const lines = c.failures
    .slice(0, 25)
    .map(
      (f) =>
        `  seed=${f.seed} ${f.category}/${f.kind} ${f.method} ${f.path.slice(0, 60)} → ${f.status}: ${f.violations.join("; ")}`,
    );
  assertEquals(
    c.failures.length,
    0,
    `${c.failures.length}/${c.executed} iterations violated the contract (table: ${STRESS_OUT_DIR}); replay with STRESS_REPLAY=<seed>:\n${lines.join("\n")}`,
  );
  assert(c.executed === c.iterations, `executed ${c.executed} of ${c.iterations}`);
}

// ─── in-memory campaign ─────────────────────────────────────────────────────

Deno.test(
  `stress consent/withdraw fuzz — ${STRESS_ITER} seeded requests over the in-memory RLS model (STRESS_ITER, STRESS_SEED, STRESS_REPLAY)`,
  async () => {
    const backend = new MemoryBackend();
    const h = await loadStressHarness(backend);
    const c = await runCampaign(h, "memory", STRESS_ITER, STRESS_SEED, "fuzz_memory.json");
    console.log(
      `[stress] memory: executed=${c.executed} statuses=${JSON.stringify(c.byStatus)} 5xx=${c.fiveXx.length} failures=${c.failures.length} p95=${c.latencyMs.p95}ms`,
    );
    assertCampaignClean(c);
    // Coverage sanity: the campaign must have exercised every category (a
    // generator regression that silently drops one is not a pass).
    if (STRESS_REPLAY === undefined && STRESS_ITER >= 300) {
      for (const cat of ["valid", "bad_body", "bad_auth", "bad_route", "headers", "fault"]) {
        assert((c.byCategory[cat] ?? 0) > 0, `category ${cat} never generated`);
      }
      assert(
        (c.byStatus["200"] ?? 0) > 0 &&
          (c.byStatus["400"] ?? 0) > 0 &&
          (c.byStatus["401"] ?? 0) > 0 &&
          (c.byStatus["404"] ?? 0) > 0,
        "status coverage",
      );
    }
  },
);

// ─── deterministic boundary cases (always run, small) ───────────────────────

Deno.test(
  "stress consent/withdraw boundary — body size cap is exact (5,000,000 bytes accepted, +1 refused with 413 and no read/write)",
  async () => {
    const backend = new MemoryBackend();
    const h = await loadStressHarness(backend);
    const rows: {
      bytes: number;
      status: number;
      posts: number;
      gets: number;
      requestId: boolean;
    }[] = [];
    const send = async (bytes: number, scope: string, contentLength?: string) => {
      h.reset();
      const userId = `bbbbbbbb-0000-4000-8000-${String(bytes).padStart(12, "0")}`;
      await backend.seed(userId, [
        {
          user_id: userId,
          scope: "video_analysis",
          action: "grant",
          consent_version: "v1",
          created_at: "",
        },
      ]);
      const prefix = `{"scope":"${scope}","pad":"`;
      const suffix = '"}';
      const body = prefix + "p".repeat(bytes - prefix.length - suffix.length) + suffix;
      assertEquals(new TextEncoder().encode(body).byteLength, bytes);
      const headers: Record<string, string> = {
        authorization: `Bearer ${googleIdToken(userId)}`,
        "content-type": "application/json",
        "x-forwarded-for": `10.99.${bytes % 250}.1`,
      };
      if (contentLength !== undefined) headers["content-length"] = contentLength;
      const res = await h.handler(
        new Request(`${BASE_URL}${ROUTE_PATH}`, { method: "POST", headers, body }),
      );
      const text = await res.text();
      rows.push({
        bytes,
        status: res.status,
        posts: h.restCalls("POST").length,
        gets: h.restCalls("GET").length,
        requestId: REQUEST_ID_RE.test(res.headers.get("x-request-id") ?? ""),
      });
      assert(leaks(text) === null, `leak in ${text}`);
      return res.status;
    };
    assertEquals(await send(MAX_JSON_BODY_BYTES, "video_analysis"), 200);
    assertEquals(await send(MAX_JSON_BODY_BYTES, "nope"), 400);
    assertEquals(await send(MAX_JSON_BODY_BYTES + 1, "video_analysis"), 413);
    assertEquals(await send(MAX_JSON_BODY_BYTES + 1, "nope"), 413);
    // Declared length is honoured pre-auth even when the wire body is tiny
    assertEquals(await send(64, "video_analysis", String(MAX_JSON_BODY_BYTES + 1)), 413);
    assertEquals(await send(64, "video_analysis", String(MAX_JSON_BODY_BYTES)), 200);
    for (const r of rows) {
      assert(r.requestId, `x-request-id missing for ${r.bytes}`);
      if (r.status !== 200) assertEquals(r.posts, 0, `write on ${r.status} (${r.bytes} bytes)`);
      if (r.status === 413) assertEquals(r.gets, 0, "read before refusing an oversized body");
    }
    await Deno.mkdir(STRESS_OUT_DIR, { recursive: true });
    await Deno.writeTextFile(
      `${STRESS_OUT_DIR}/boundary_body_size.json`,
      JSON.stringify(rows, null, 1),
    );
  },
);

Deno.test(
  "stress consent/withdraw duplicate delivery — N identical withdraws (sequential + concurrent) never fail, fold to one withdrawn status, and append exactly N ledger rows",
  async () => {
    const backend = new MemoryBackend();
    const h = await loadStressHarness(backend);
    const userId = "dddddddd-0000-4000-8000-000000000001";
    await backend.seed(userId, [
      {
        user_id: userId,
        scope: "model_training",
        action: "grant",
        consent_version: "model-training-v1",
        created_at: "",
      },
    ]);
    const token = sessionToken(userId);
    const withdraw = () =>
      h.handler(
        new Request(`${BASE_URL}${ROUTE_PATH}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-forwarded-for": "10.98.0.1",
            "x-request-id": "dup-delivery-0001",
          },
          body: JSON.stringify({
            scope: "model_training",
            source: "settings",
            device: "iPhone16,1",
          }),
        }),
      );
    const first = await withdraw();
    const second = await withdraw();
    const concurrent = await Promise.all(Array.from({ length: 8 }, withdraw));
    const all = [first, second, ...concurrent];
    const bodies = await Promise.all(all.map((r) => r.json()));
    for (const [i, r] of all.entries()) {
      assertEquals(r.status, 200, `delivery ${i} → ${r.status}`);
      assertEquals(r.headers.get("x-request-id"), "dup-delivery-0001");
    }
    const ledger = await backend.ledgerOf(userId);
    assertEquals(ledger.length, 1 + all.length, "append-only ledger: one row per delivery");
    assert(
      ledger
        .slice(1)
        .every(
          (r) =>
            r.action === "withdraw" &&
            r.consent_version === "model-training-v1" &&
            r.source === "settings",
        ),
    );
    for (const body of bodies) {
      const mt = (
        body as {
          scopes: {
            scope: string;
            active: boolean;
            lastAction: string;
            consentVersion: string | null;
          }[];
        }
      ).scopes.find((s) => s.scope === "model_training");
      assertEquals(mt?.active, false);
      assertEquals(mt?.lastAction, "withdrawn");
      assertEquals(mt?.consentVersion, "model-training-v1");
    }
  },
);

// ─── real Postgres (docker postgres:16 + every migration) ───────────────────

type Sql = ReturnType<typeof postgres>;

/** PostgREST semantics over the real schema: each edge call becomes one
 * transaction as role `authenticated` with the caller's JWT sub, so RLS,
 * check constraints and the append-only trigger are the migrations' own. */
class PgBackend implements ConsentBackend {
  constructor(private readonly sql: Sql) {}
  async select(bearerUserId: string, filterUserId: string): Promise<LedgerRow[]> {
    return await this.sql.begin(async (tx) => {
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [bearerUserId]);
      let filter = filterUserId;
      if (!/^[0-9a-f-]{36}$/i.test(filterUserId)) filter = "00000000-0000-0000-0000-000000000000";
      const rows = await tx.unsafe(
        `select user_id, scope, action, consent_version, source, device, capture_mode, created_at
           from public.consent_records where user_id = $1 order by created_at asc, id asc`,
        [filter],
      );
      return rows.map((r) => ({
        ...r,
        created_at: new Date(r.created_at as string).toISOString(),
      })) as unknown as LedgerRow[];
    });
  }
  async insert(bearerUserId: string, row: Record<string, unknown>): Promise<void> {
    const allowed = new Set([
      "user_id",
      "scope",
      "consent_version",
      "action",
      "source",
      "device",
      "capture_mode",
    ]);
    for (const key of Object.keys(row)) {
      if (!allowed.has(key))
        throw new RestError(400, {
          code: "PGRST204",
          message: `Could not find the '${key}' column`,
        });
    }
    try {
      await this.sql.begin(async (tx) => {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [bearerUserId]);
        await tx.unsafe(
          `insert into public.consent_records (user_id, scope, consent_version, action, source, device, capture_mode)
             values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            row.user_id as string,
            row.scope as string,
            (row.consent_version as string | null) ?? null,
            row.action as string,
            (row.source as string | null) ?? null,
            (row.device as string | null) ?? null, // postgres.js JSON-encodes jsonb parameters itself
            (row.capture_mode as string | null) ?? null,
          ],
        );
      });
    } catch (error) {
      const e = error as { code?: string; message?: string };
      const status =
        e.code === "42501"
          ? 403
          : e.code?.startsWith("23")
            ? e.code === "23503"
              ? 409
              : 400
            : 500;
      throw new RestError(status, {
        code: e.code ?? "XX000",
        message: e.message ?? String(error),
        details: null,
        hint: null,
      });
    }
  }
  async seed(userId: string, rows: LedgerRow[]): Promise<void> {
    const users = new Set([userId, ...rows.map((r) => r.user_id)]);
    for (const id of users) await this.ensureUser(id);
    for (const row of rows) {
      await this.sql.unsafe(
        `insert into public.consent_records (user_id, scope, consent_version, action, source, device)
           values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          row.user_id,
          row.scope,
          row.consent_version,
          row.action,
          row.source ?? null,
          (row.device as string | null) ?? null,
        ],
      );
    }
  }
  async ensureUser(userId: string): Promise<void> {
    await this.sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, '{"provider":"google"}')
         on conflict (id) do nothing`,
      [userId, `${userId}@example.com`],
    );
  }
  async ledgerOf(userId: string): Promise<LedgerRow[]> {
    const rows = await this.sql.unsafe(
      `select user_id, scope, action, consent_version, source, device, capture_mode, created_at
         from public.consent_records where user_id = $1 order by created_at asc, id asc`,
      [userId],
    );
    return rows.map((r) => ({
      ...r,
      created_at: new Date(r.created_at as string).toISOString(),
    })) as unknown as LedgerRow[];
  }
  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

/** The PG campaign seeds users on the fly: the in-memory `seed()` path is the
 * same call, so `plan()` is byte-identical between the two backends. */
Deno.test({
  name: `stress consent/withdraw fuzz — ${STRESS_PG_ITER} seeded requests over docker postgres:16 with every migration applied (STRESS_PG_URL)`,
  ignore: STRESS_PG_URL === "",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = postgres(STRESS_PG_URL, { max: 4 });
    const backend = new PgBackend(sql);
    try {
      const h = await loadStressHarness(backend);
      // Every planned identity must exist in auth.users BEFORE the edge
      // writes (FK to profiles via the auth trigger); seed() does that for
      // fresh users, and reused identities were seeded by their first plan.
      const c = await runCampaign(
        h,
        "postgres",
        STRESS_PG_ITER,
        STRESS_SEED + 1,
        "fuzz_postgres.json",
      );
      console.log(
        `[stress] postgres: executed=${c.executed} statuses=${JSON.stringify(c.byStatus)} 5xx=${c.fiveXx.length} failures=${c.failures.length} p95=${c.latencyMs.p95}ms`,
      );
      assertCampaignClean(c);
    } finally {
      await backend.close();
    }
  },
});

Deno.test({
  name: "stress consent/withdraw postgres — the row the edge writes for the LARGEST client-accepted source/device fits consent_records_bounds (64-cp source, 512-cp astral device)",
  ignore: STRESS_PG_URL === "",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = postgres(STRESS_PG_URL, { max: 2 });
    const backend = new PgBackend(sql);
    try {
      const h = await loadStressHarness(backend);
      const userId = crypto.randomUUID(); // the disposable DB persists between runs
      await backend.seed(userId, [
        {
          user_id: userId,
          scope: "evaluation_telemetry",
          action: "grant",
          consent_version: "x".repeat(50),
          created_at: "",
        },
      ]);
      h.reset();
      const res = await h.handler(
        new Request(`${BASE_URL}${ROUTE_PATH}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${sessionToken(userId)}`,
            "content-type": "application/json",
            "x-forwarded-for": "10.97.0.1",
          },
          body: JSON.stringify({
            scope: "evaluation_telemetry",
            source: "😀".repeat(64) + "overflow".repeat(50),
            device: "👨‍👩‍👧".repeat(600),
          }),
        }),
      );
      const text = await res.text();
      assertEquals(res.status, 200, text);
      assert(leaks(text) === null);
      const ledger = await backend.ledgerOf(userId);
      assertEquals(ledger.length, 2);
      const row = ledger[1];
      assertEquals(row.action, "withdraw");
      assertEquals(row.consent_version, "x".repeat(50));
      assertEquals(Array.from(row.source ?? "").length, 64);
      assertEquals(Array.from(row.device as string).length, 512);
    } finally {
      await backend.close();
    }
  },
});

/** Adjacent-route probe (same file, same ledger): grantConsent caps
 * consentVersion/captureMode at 64 code points but consent_records_bounds
 * caps them at 50 — a 51..64 character value is client-valid to the edge and
 * refused by Postgres, which the edge reports as a 503 "temporarily
 * unavailable" (a 5xx for bad input, not retryable) instead of a 400. The
 * withdraw route inherits consent_version from the ledger so it cannot hit
 * this itself; recorded here because the fuzz lens forbids 5xx on bad input.
 * The assertion states the CONTRACT (400); on 1fb0efd7 it fails → finding. */
Deno.test({
  name: "stress consent/grant postgres — consentVersion of 51..64 code points must be refused as 400, not surface as a 503 (edge cap 64 vs consent_records_bounds 50)",
  ignore: STRESS_PG_URL === "",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = postgres(STRESS_PG_URL, { max: 2 });
    const backend = new PgBackend(sql);
    try {
      const h = await loadStressHarness(backend);
      const userId = crypto.randomUUID();
      await backend.ensureUser(userId);
      const results: { field: string; length: number; status: number; body: string }[] = [];
      for (const [field, length] of [
        ["consentVersion", 50],
        ["consentVersion", 51],
        ["consentVersion", 64],
        ["captureMode", 50],
        ["captureMode", 51],
        ["captureMode", 64],
      ] as const) {
        h.reset();
        const body: Record<string, unknown> = { scope: "video_analysis", consentVersion: "v1" };
        body[field] = "v".repeat(length);
        const res = await h.handler(
          new Request(`${BASE_URL}/v1/me/consent/grant`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${sessionToken(userId)}`,
              "content-type": "application/json",
              "x-forwarded-for": "10.96.0.1",
            },
            body: JSON.stringify(body),
          }),
        );
        const text = await res.text();
        results.push({ field, length, status: res.status, body: text });
        assert(leaks(text) === null, `leak: ${text}`);
      }
      await Deno.mkdir(STRESS_OUT_DIR, { recursive: true });
      await Deno.writeTextFile(
        `${STRESS_OUT_DIR}/grant_version_bounds.json`,
        JSON.stringify(results, null, 1),
      );
      for (const r of results) {
        if (r.length <= 50) assertEquals(r.status, 200, `${r.field}[${r.length}] ${r.body}`);
        else
          assertEquals(
            r.status,
            400,
            `${r.field}[${r.length}] → ${r.status} ${r.body} (expected a 400 validation refusal, not a 5xx)`,
          );
      }
    } finally {
      await backend.close();
    }
  },
});
