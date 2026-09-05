/**
 * stress-route-post-v1-me-delete-confirm / lens fuzz-boundary.
 *
 * Seeded, replayable fuzz + boundary campaign against the REAL edge handler
 * (../index.ts booted in-process by stress_delete_confirm_harness.ts) for
 * `POST /v1/me/delete-confirm`. Every iteration derives its whole scenario
 * — bearer, body, headers, path, method, upstream world and faults — from
 * one 32-bit seed, runs 1..N requests (sequential or concurrent) and checks
 * a differential model of the route plus the campaign invariants:
 *
 *   - bad input answers only 400/401/403/404/405/413/415/429
 *   - every 5xx carries the generic body (no upstream detail, no stack)
 *   - x-request-id on every response (echoed when well-formed)
 *   - no write (PostgREST/GoTrue admin/RevenueCat/Apple) on rejection
 *   - a 200 deletes exactly once; a replay never deletes twice
 *
 * Env: STRESS_ITER (iterations, default 300 — the suite default is fast),
 * STRESS_SEED (campaign seed), STRESS_ONLY (one iteration seed to replay),
 * STRESS_OUT_DIR (write the JSON table there), STRESS_FAIL_FAST=1.
 *
 * Replay one iteration: STRESS_ONLY=<iterationSeed> deno test -A --no-check
 *   --config deno.json stress_delete_confirm_fuzz.test.ts
 */

import { assertEquals } from "@std/assert";
import { envInt, histogram, Prng } from "./xc_concurrency_harness.ts";
import {
  b64url,
  type DeletionRow,
  type ExternalRow,
  freshWorld,
  iterationSeed,
  LEAK_MARKER,
  loadStressHarness,
  type RecordedCall,
  type ResponseSnapshot,
  snapshot,
  STACK_OR_INTERNAL_RE,
  type StressHarness,
  SUPABASE_URL,
  type UpstreamAnswer,
  type World,
} from "./stress_delete_confirm_harness.ts";
import { encryptAppleRefreshToken } from "../externalAccounts.ts";

// ─── Campaign knobs ──────────────────────────────────────────────────────────

const STRESS_ITER = envInt("STRESS_ITER", 300);
const STRESS_SEED = envInt("STRESS_SEED", 20260905);
const STRESS_ONLY = Deno.env.get("STRESS_ONLY") ?? "";
const STRESS_OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ?? "";
const FAIL_FAST = Deno.env.get("STRESS_FAIL_FAST") === "1";

const MAX_BODY = 5_000_000;
const DELETE_CONFIRM_MIN_AGE_MS = 3_000;
const ROUTE = "/v1/me/delete-confirm";
const BAD_INPUT_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 429]);
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERIC_5XX = new Set([
  "Something went wrong. Please try again.",
]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// ─── Scenario model ──────────────────────────────────────────────────────────

type BodySpec =
  | { kind: "text"; text: string }
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "stream"; chunks: string[]; totalBytes: number }
  | { kind: "none" };

interface RequestSpec {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: BodySpec;
}

interface Step {
  label: string;
  request: RequestSpec;
  /** Steps sharing a group run concurrently (Promise.all). */
  group: number;
}

interface Scenario {
  seed: number;
  category: string;
  variant: string;
  provider: "google" | "apple";
  userId: string;
  world: World;
  steps: Step[];
  notes: string[];
}

interface Expectation {
  statuses: number[];
  code?: string | null;
  /** Upstream call kinds that may carry `write=true` for this step. */
  writesAllowed: Set<RecordedCall["kind"]>;
  adminDelete: "none" | "attempt" | "success";
  /** Model says the request is a rejection of bad/unauthorized input. */
  rejection: boolean;
  lenient: string | null;
}

interface StepResult {
  label: string;
  method: string;
  path: string;
  bodyPreview: string;
  bodyBytes: number;
  expected: number[];
  expectedCode: string | null;
  status: number;
  code: string | null;
  requestId: string | null;
  writes: string[];
  calls: string[];
  verdict: "HELD" | "BROKEN" | "TOLERATED";
  violations: string[];
  /** Non-failing observations worth reporting (e.g. reflected input). */
  observations: string[];
  bodyExcerpt?: string;
}

interface IterationRow {
  seed: number;
  category: string;
  variant: string;
  provider: string;
  steps: StepResult[];
  verdict: "HELD" | "BROKEN" | "TOLERATED";
  notes: string[];
  ms: number;
}

// ─── Request-level generators ────────────────────────────────────────────────

const SAFE_HEADER_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~\t";

function safeHeaderText(prng: Prng, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += SAFE_HEADER_ALPHABET[prng.int(0, SAFE_HEADER_ALPHABET.length - 1)];
  }
  return out;
}

function latin1Text(prng: Prng, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(prng.int(0xa0, 0xff));
  }
  return out;
}

function ipv4(prng: Prng): string {
  return `${prng.int(1, 223)}.${prng.int(0, 255)}.${prng.int(0, 255)}.${
    prng.int(1, 254)
  }`;
}

function jwt(
  prng: Prng,
  payload: unknown,
  header: unknown = { alg: "RS256", typ: "JWT" },
): string {
  const sig = b64url(`sig-${prng.int(0, 1e9)}`);
  return `${b64url(JSON.stringify(header))}.${
    b64url(JSON.stringify(payload))
  }.${sig}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

interface Bearer {
  header: string | null;
  label: string;
  /** What the model derives from the header exactly like authenticate(). */
  kind: "provider" | "session" | "invalid";
  sub: string | null;
}

function validBearer(
  prng: Prng,
  provider: "google" | "apple",
  userId: string,
): Bearer {
  const exp = nowSec() + prng.int(120, 86_400);
  if (prng.next() < 0.5) {
    const iss = provider === "google"
      ? "https://accounts.google.com"
      : "https://appleid.apple.com";
    const token = jwt(prng, {
      iss,
      sub: userId,
      aud: "com.picklesensei",
      exp,
      iat: nowSec(),
    });
    return {
      header: `Bearer ${token}`,
      label: `provider:${provider}`,
      kind: "provider",
      sub: userId,
    };
  }
  const token = jwt(prng, {
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: userId,
    session_id: prng.uuid(),
    role: "authenticated",
    aud: "authenticated",
    exp,
  });
  return {
    header: `Bearer ${token}`,
    label: "session",
    kind: "session",
    sub: userId,
  };
}

function mutatedBearer(
  prng: Prng,
  provider: "google" | "apple",
  userId: string,
): Bearer {
  const iss = provider === "google"
    ? "https://accounts.google.com"
    : "https://appleid.apple.com";
  const pick = prng.int(0, 27);
  const raw = (header: string | null, label: string): Bearer => ({
    header,
    label,
    kind: "invalid",
    sub: null,
  });
  switch (pick) {
    case 0:
      return raw(null, "no-authorization");
    case 1:
      return raw("Bearer", "bare-bearer");
    case 2:
      return raw("Bearer ", "bearer-space-only");
    case 3:
      return raw(
        `bearer ${jwt(prng, { iss, sub: userId, exp: nowSec() + 600 })}`,
        "lowercase-scheme",
      );
    case 4:
      return raw(`Basic ${b64url("user:pass")}`, "basic-scheme");
    case 5:
      return raw(
        `Bearer ${safeHeaderText(prng, prng.int(1, 40)).replace(/\s/g, "x")}`,
        "garbage-token",
      );
    case 6:
      return raw(`Bearer a.b`, "two-segments");
    case 7:
      return raw(`Bearer a.b.c.d`, "four-segments");
    case 8:
      return raw(
        `Bearer ${b64url("{}")}.${b64url("not json")}.sig`,
        "payload-not-json",
      );
    case 9:
      return raw(
        `Bearer ${b64url("{}")}.${b64url("[1,2]")}.sig`,
        "payload-array",
      );
    case 10:
      return raw(
        `Bearer ${b64url("{}")}.${b64url("null")}.sig`,
        "payload-null",
      );
    case 11:
      return raw(
        `Bearer ${b64url("{}")}.${b64url("42")}.sig`,
        "payload-number",
      );
    case 12:
      return raw(
        `Bearer ${
          jwt(prng, {
            iss: "https://evil.example.com",
            sub: userId,
            exp: nowSec() + 600,
          })
        }`,
        "unknown-issuer",
      );
    case 13:
      return raw(
        `Bearer ${
          jwt(prng, { iss, sub: userId, exp: nowSec() - prng.int(1, 10_000) })
        }`,
        "expired-provider",
      );
    case 14:
      return raw(
        `Bearer ${
          jwt(prng, {
            iss: `${SUPABASE_URL}/auth/v1`,
            sub: userId,
            session_id: prng.uuid(),
            exp: nowSec() - prng.int(1, 10_000),
          })
        }`,
        "expired-session",
      );
    case 15:
      return raw(
        `Bearer ${jwt(prng, { iss, sub: userId, exp: 0 })}`,
        "exp-zero",
      );
    case 16:
      return raw(
        `Bearer ${jwt(prng, { iss, sub: userId, exp: -1 })}`,
        "exp-negative",
      );
    case 17:
      return raw(
        `Bearer ${
          jwt(prng, {
            iss: "http://accounts.google.com",
            sub: userId,
            exp: nowSec() + 600,
          })
        }`,
        "http-issuer",
      );
    case 18:
      return raw(
        `Bearer ${
          jwt(prng, {
            iss: "https://accounts.google.com/",
            sub: userId,
            exp: nowSec() + 600,
          })
        }`,
        "issuer-trailing-slash",
      );
    case 19:
      return raw(
        `Bearer ${
          jwt(prng, {
            iss: "https://ACCOUNTS.GOOGLE.COM",
            sub: userId,
            exp: nowSec() + 600,
          })
        }`,
        "issuer-uppercase",
      );
    case 20:
      return raw(
        `Bearer ${jwt(prng, { iss: 42, sub: userId, exp: nowSec() + 600 })}`,
        "issuer-number",
      );
    case 21:
      return raw(
        `Bearer ${
          jwt(prng, {
            iss: ["https://accounts.google.com"],
            sub: userId,
            exp: nowSec() + 600,
          })
        }`,
        "issuer-array",
      );
    case 22:
      return raw(
        `Bearer ${jwt(prng, { sub: userId, exp: nowSec() + 600 })}`,
        "no-issuer",
      );
    case 23:
      return raw(
        `Bearer ${"A".repeat(prng.int(4_000, 60_000))}`,
        "huge-opaque-token",
      );
    case 24:
      return raw(
        `Bearer ${jwt(prng, { iss, sub: userId, exp: nowSec() + 600 })} extra`,
        "token-with-trailing-word",
      );
    case 25:
      return raw(
        `Bearer  ${jwt(prng, { iss, sub: userId, exp: nowSec() + 600 })}`,
        "double-space",
      );
    case 26:
      return raw(
        `Bearer ${
          jwt(prng, {
            iss: `${SUPABASE_URL}/auth/v1`,
            sub: prng.uuid(),
            session_id: prng.uuid(),
            exp: nowSec() + 600,
          })
        }`,
        "session-unknown-user",
      );
    default:
      return raw(
        `Bearer ${
          jwt(prng, {
            iss: "https://appleid.apple.com/auth/v1",
            sub: userId,
            exp: nowSec() + 600,
          })
        }`,
        "issuer-apple-auth-v1-suffix",
      );
  }
}

function uuidMutation(
  prng: Prng,
  match: string,
): { value: unknown; label: string } {
  const pick = prng.int(0, 27);
  switch (pick) {
    case 0:
      return { value: match, label: "exact" };
    case 1:
      return { value: match.toUpperCase(), label: "uppercase" };
    case 2:
      return { value: prng.uuid(), label: "other-uuid" };
    case 3:
      return { value: `{${match}}`, label: "braced" };
    case 4:
      return { value: `urn:uuid:${match}`, label: "urn-prefix" };
    case 5:
      return { value: match.replace(/-/g, ""), label: "no-hyphens" };
    case 6:
      return { value: `${match}0`, label: "extra-char" };
    case 7:
      return { value: match.slice(0, -1), label: "truncated" };
    case 8:
      return { value: ` ${match}`, label: "leading-space" };
    case 9:
      return { value: `${match}\n`, label: "trailing-newline" };
    case 10:
      return {
        value: "00000000-0000-0000-0000-000000000000",
        label: "nil-uuid",
      };
    case 11:
      return {
        value: match.slice(0, 14) + "0" + match.slice(15),
        label: "version-0",
      };
    case 12:
      return {
        value: match.slice(0, 14) + "9" + match.slice(15),
        label: "version-9",
      };
    case 13:
      return {
        value: match.slice(0, 19) + "c" + match.slice(20),
        label: "variant-c",
      };
    case 14:
      return {
        value: match.slice(0, 19) + "f" + match.slice(20),
        label: "variant-f",
      };
    case 15:
      return { value: null, label: "null" };
    case 16:
      return { value: true, label: "boolean" };
    case 17:
      return { value: 123456789, label: "number" };
    case 18:
      return { value: [match], label: "array-wrapped" };
    case 19:
      return { value: { challenge: match }, label: "object-wrapped" };
    case 20:
      return { value: "", label: "empty-string" };
    case 21:
      return { value: match.replace(/[0-9a-f]/, "g"), label: "non-hex-char" };
    case 22:
      return {
        value: match.replace(/0/g, "\u0660"),
        label: "arabic-indic-digits",
      };
    case 23:
      return { value: `${match}\u0000`, label: "trailing-nul" };
    case 24:
      return {
        value: "x".repeat(prng.int(1_000, 200_000)),
        label: "long-string",
      };
    case 25:
      return { value: match.split("").reverse().join(""), label: "reversed" };
    case 26:
      return {
        value: `${match.slice(0, 8)}_${match.slice(9)}`,
        label: "underscore-separator",
      };
    default:
      return { value: "ffffffff-ffff-4fff-bfff-ffffffffffff", label: "all-f" };
  }
}

/** JSON body shapes. `expectedChallenge` is what readBody()+isUuid() will see. */
function bodyMutation(
  prng: Prng,
  match: string,
): { body: BodySpec; label: string } {
  const text = (t: string): BodySpec => ({ kind: "text", text: t });
  const pick = prng.int(0, 30);
  switch (pick) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7: {
      const mutation = uuidMutation(prng, match);
      return {
        body: text(JSON.stringify({ challenge: mutation.value })),
        label: `challenge:${mutation.label}`,
      };
    }
    case 8:
      return {
        body: text(JSON.stringify({ Challenge: match })),
        label: "key-capitalised",
      };
    case 9:
      return {
        body: text(JSON.stringify({ "challenge ": match })),
        label: "key-trailing-space",
      };
    case 10:
      return {
        body: text(JSON.stringify({ "challenge\u0000": match })),
        label: "key-nul",
      };
    case 11:
      return {
        body: text(`{"challenge":"${prng.uuid()}","challenge":"${match}"}`),
        label: "duplicate-key-last-wins",
      };
    case 12:
      return {
        body: text(`{"challenge":"${match}","challenge":"${prng.uuid()}"}`),
        label: "duplicate-key-first-lost",
      };
    case 13:
      return {
        body: text(
          `{"__proto__":{"challenge":"${match}"},"constructor":{"prototype":{"challenge":"${match}"}}}`,
        ),
        label: "proto-pollution",
      };
    case 14: {
      const extras: Record<string, unknown> = { challenge: match };
      const n = prng.int(1, 5_000);
      for (let i = 0; i < n; i++) extras[`k${i}`] = i;
      return { body: text(JSON.stringify(extras)), label: `extra-keys:${n}` };
    }
    case 15:
      return {
        body: text(JSON.stringify([{ challenge: match }])),
        label: "top-level-array",
      };
    case 16:
      return { body: text(JSON.stringify(match)), label: "top-level-string" };
    case 17:
      return { body: text("null"), label: "top-level-null" };
    case 18:
      return { body: text(""), label: "empty-body" };
    case 19:
      return { body: { kind: "none" }, label: "no-body" };
    case 20:
      return { body: text("   \n\t "), label: "whitespace-only" };
    case 21:
      return { body: text(`{"challenge":"${match}"`), label: "truncated-json" };
    case 22:
      return {
        body: text(`{"challenge":"${match}",}`),
        label: "trailing-comma",
      };
    case 23:
      return { body: text(`{'challenge':'${match}'}`), label: "single-quotes" };
    case 24:
      return {
        body: text(`\ufeff{"challenge":"${match}"}`),
        label: "bom-prefix",
      };
    case 25:
      return {
        body: text(`{"challenge":"${match}"}\u0000`),
        label: "trailing-nul-byte",
      };
    case 26:
      return { body: text(`challenge=${match}`), label: "form-encoded" };
    case 27:
      return { body: text(`<challenge>${match}</challenge>`), label: "xml" };
    case 28: {
      const bytes = new Uint8Array(prng.int(1, 4_096));
      for (let i = 0; i < bytes.length; i++) bytes[i] = prng.int(0, 255);
      return {
        body: { kind: "bytes", bytes },
        label: `binary-garbage:${bytes.length}`,
      };
    }
    case 29: {
      const depth = prng.int(1_000, 60_000);
      return {
        body: text("[".repeat(depth) + "]".repeat(depth)),
        label: `deep-nesting:${depth}`,
      };
    }
    default:
      return {
        body: text(
          `{"challenge":"${match}","pad":"${
            "\\ud800".repeat(prng.int(1, 64))
          }"}`,
        ),
        label: "lone-surrogate-escape",
      };
  }
}

// ─── Model: what the real route should do ────────────────────────────────────

/** Mirror of memory rate limiting (aligned buckets) for the scopes touched. */
class LimiterModel {
  private windows = new Map<string, { count: number; resetAtMs: number }>();
  clone(): LimiterModel {
    const copy = new LimiterModel();
    for (const [key, value] of this.windows) {
      copy.windows.set(key, { ...value });
    }
    return copy;
  }
  incr(
    scope: string,
    id: string,
    windowSeconds: number,
    nowMs: number,
  ): number {
    const bucket = Math.floor(nowMs / (windowSeconds * 1_000));
    const key = `rl:${scope}:${bucket}:${id}`;
    const existing = this.windows.get(key);
    if (existing && existing.resetAtMs > nowMs) {
      existing.count += 1;
      return existing.count;
    }
    this.windows.set(key, {
      count: 1,
      resetAtMs: nowMs + windowSeconds * 1_000,
    });
    return 1;
  }
  adjust(
    scope: string,
    id: string,
    windowSeconds: number,
    nowMs: number,
    delta: number,
  ): void {
    const bucket = Math.floor(nowMs / (windowSeconds * 1_000));
    const key = `rl:${scope}:${bucket}:${id}`;
    const existing = this.windows.get(key);
    if (existing && existing.resetAtMs > nowMs) {
      existing.count = Math.max(0, existing.count + delta);
    } else if (delta > 0) {
      this.windows.set(key, {
        count: delta,
        resetAtMs: nowMs + windowSeconds * 1_000,
      });
    }
  }
  peek(
    scope: string,
    id: string,
    windowSeconds: number,
    nowMs: number,
  ): number {
    const bucket = Math.floor(nowMs / (windowSeconds * 1_000));
    const existing = this.windows.get(`rl:${scope}:${bucket}:${id}`);
    return existing && existing.resetAtMs > nowMs ? existing.count : 0;
  }
  nearBoundary(windowSeconds: number, nowMs: number): boolean {
    const ms = nowMs % (windowSeconds * 1_000);
    return ms < 250 || ms > windowSeconds * 1_000 - 250;
  }
}

interface AuthCacheEntry {
  userId: string;
  provider: "google" | "apple";
  expiresAtMs: number;
}

interface ModelState {
  limiter: LimiterModel;
  authCache: Map<string, AuthCacheEntry>;
  revokedSessions: Set<string>;
}

const cloneModel = (model: ModelState): ModelState => ({
  limiter: model.limiter.clone(),
  authCache: new Map(model.authCache),
  revokedSessions: new Set(model.revokedSessions),
});

function decodeJwtPayloadExact(token: string): unknown {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64)) as unknown;
  } catch {
    return null;
  }
}

function providerForIssuer(issuer: unknown): "google" | "apple" | null {
  if (typeof issuer !== "string") return null;
  const iss = issuer.replace(/^https:\/\//, "");
  if (iss === "accounts.google.com") return "google";
  if (iss === "appleid.apple.com") return "apple";
  return null;
}

function claim(payload: unknown, key: string): unknown {
  if (payload === null || payload === undefined) return undefined;
  return (payload as Record<string, unknown>)[key];
}

function clientIp(headers: Headers): string {
  const edgeIp = headers.get("cf-connecting-ip")?.trim();
  if (edgeIp) return edgeIp;
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops[hops.length - 1] || "unknown";
}

/** The route decodes the wire bytes with TextDecoder (BOM stripped, invalid
 * UTF-8 replaced) — the model must see the same text. */
function bodyText(body: BodySpec): string {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  switch (body.kind) {
    case "text":
      return decoder.decode(encoder.encode(body.text));
    case "bytes":
      return decoder.decode(body.bytes);
    case "stream":
      return decoder.decode(encoder.encode(body.chunks.join("")));
    case "none":
      return "";
  }
}

function bodyBytes(body: BodySpec): number {
  switch (body.kind) {
    case "text":
      return new TextEncoder().encode(body.text).byteLength;
    case "bytes":
      return body.bytes.byteLength;
    case "stream":
      return body.totalBytes;
    case "none":
      return 0;
  }
}

/** What PostgREST-through-supabase-js maybeSingle() yields for an override. */
function maybeSingleOf(
  override: UpstreamAnswer,
): { error: boolean; data: unknown } {
  if (override === "throw") return { error: true, data: null };
  if (override.status < 200 || override.status >= 300) {
    return { error: true, data: null };
  }
  if (override.text !== undefined) {
    if (override.text === "") return { error: false, data: null };
    try {
      return { error: false, data: JSON.parse(override.text) };
    } catch {
      return { error: true, data: null };
    }
  }
  const data = override.body === undefined ? {} : override.body;
  if (Array.isArray(data)) {
    if (data.length > 1) return { error: true, data: null };
    return { error: false, data: data.length === 1 ? data[0] : null };
  }
  return { error: false, data };
}

const KNOWN_OTHER_ROUTES = new Set([
  "POST /v1/auth/logout",
  "GET /v1/me",
  "PUT /v1/me/onboarding",
  "GET /v1/me/access",
  "POST /v1/billing/sync",
  "POST /v1/analysis-permits",
  "POST /v1/shots:sync",
  "POST /v1/sessions",
  "POST /v1/me/evaluation/trials",
  "GET /v1/progress",
  "GET /v1/rank",
  "GET /v1/me/consent/status",
  "POST /v1/me/consent/grant",
  "POST /v1/me/consent/withdraw",
  "POST /v1/me/delete-request",
  "GET /v1/me/saved-drills",
  "GET /v1/training-plans/current",
  "POST /v1/training-plans",
  "POST /v1/account/bootstrap",
  "POST /v1/auth/refresh",
  "GET /v1/catalog/drills",
]);

function routeOf(
  method: string,
  urlText: string,
): { path: string; route: string; pathname: string } {
  const url = new URL(urlText);
  const v1 = url.pathname.lastIndexOf("/v1/");
  const path = v1 >= 0 ? url.pathname.slice(v1) : url.pathname;
  return { path, route: `${method} ${path}`, pathname: url.pathname };
}

/** True when the URL would reach a real route other than delete-confirm
 * (public suffix routes, parameterised routes, other static routes). */
function hitsAnotherRoute(method: string, urlText: string): boolean {
  const { path, route, pathname } = routeOf(method, urlText);
  if (method === "GET" || method === "HEAD") {
    if (/\/(healthz|support|privacy|terms)$/.test(pathname)) return true;
    if (/^\/v1\/catalog\/drills\/[^/]+$/.test(path)) return true;
  }
  if (method === "POST" && pathname.endsWith("/webhooks/revenuecat")) {
    return true;
  }
  if (
    method === "POST" &&
    /^\/v1\/(analysis-permits|sessions)\/[^/]+\/finalize$/.test(path)
  ) return true;
  if (method === "POST" && /^\/v1\/analyses\/[^/]+\/feedback$/.test(path)) {
    return true;
  }
  if (
    (method === "PUT" || method === "DELETE") &&
    /^\/v1\/me\/saved-drills\/[^/]+$/.test(path)
  ) return true;
  return KNOWN_OTHER_ROUTES.has(route);
}

function predict(
  spec: RequestSpec,
  world: World,
  model: ModelState,
  nowMs: number,
  tokenCacheKey: string,
): Expectation {
  const headers = new Headers();
  for (const [name, value] of spec.headers) headers.append(name, value);
  const none = new Set<RecordedCall["kind"]>();
  const ip = clientIp(headers);
  // Requests without a client-ip header share one "unknown" bucket across
  // the whole isolate (and therefore across iterations); the model tracks
  // it too, but a single-seed replay cannot reproduce campaign history.
  const sharedBucket = ip === "unknown" ? "shared-unknown-ip-bucket" : null;
  const reject = (
    status: number,
    code: string | null = null,
    lenient: string | null = null,
  ): Expectation => ({
    statuses: [status],
    code,
    writesAllowed: none,
    adminDelete: "none",
    rejection: true,
    lenient: lenient ?? sharedBucket,
  });
  const unavailable = (writes: RecordedCall["kind"][] = []): Expectation => ({
    statuses: [503],
    code: null,
    writesAllowed: new Set(writes),
    adminDelete: "none",
    rejection: false,
    lenient: null,
  });

  const declared = Number(headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) return reject(413);

  const ipCount = model.limiter.incr("ip", ip, 60, nowMs);
  if (ipCount > 1_200) {
    return reject(
      429,
      "rate_limited",
      model.limiter.nearBoundary(60, nowMs) ? "ip-window-boundary" : null,
    );
  }
  const failures = model.limiter.peek("authfail", ip, 300, nowMs);
  if (failures >= 30) {
    return reject(
      429,
      "rate_limited",
      model.limiter.nearBoundary(300, nowMs)
        ? "authfail-window-boundary"
        : null,
    );
  }
  const authfailLenient =
    failures >= 29 && model.limiter.nearBoundary(300, nowMs)
      ? "authfail-window-boundary"
      : null;

  const { path } = routeOf(spec.method, spec.url);

  // authenticate()
  const authorization = headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  const authFailure = (
    status: number,
    code: string | null = null,
  ): Expectation => {
    model.limiter.incr("authfail", ip, 300, nowMs);
    return reject(status, code, authfailLenient);
  };
  if (!token) return authFailure(401);
  const payload = decodeJwtPayloadExact(token);
  const provider = providerForIssuer(claim(payload, "iss"));
  const iss = claim(payload, "iss");
  const supabaseIssued = typeof iss === "string" && iss.endsWith("/auth/v1");
  if (!provider && !supabaseIssued) return authFailure(401);
  const exp = claim(payload, "exp");
  if (typeof exp === "number" && exp * 1_000 <= nowMs) return authFailure(401);
  const sessionIdRaw = claim(payload, "session_id");
  const sessionId = provider
    ? null
    : typeof sessionIdRaw === "string" && sessionIdRaw
    ? sessionIdRaw
    : null;

  let authed: { id: string; provider: "google" | "apple" } | null = null;
  if (sessionId && model.revokedSessions.has(sessionId)) {
    return authFailure(401);
  }
  const cached = model.authCache.get(tokenCacheKey);
  if (
    cached && (provider === null || cached.provider === provider) &&
    cached.expiresAtMs > nowMs + 5_000
  ) {
    authed = { id: cached.userId, provider: cached.provider };
  }
  const writeCache = (
    userId: string,
    prov: "google" | "apple",
    sessionExpSeconds: number | null,
  ) => {
    const bearerExpMs = typeof exp === "number" ? exp * 1_000 : 0;
    const sessionExpMs = typeof sessionExpSeconds === "number"
      ? sessionExpSeconds * 1_000
      : 0;
    const expiresAtMs = Math.min(
      bearerExpMs > 0 ? bearerExpMs : Number.MAX_SAFE_INTEGER,
      sessionExpMs > 0 ? sessionExpMs : Number.MAX_SAFE_INTEGER,
      nowMs + 600_000,
    );
    const ttl = Math.floor((expiresAtMs - nowMs) / 1_000) - 30;
    if (ttl >= 60) {
      model.authCache.set(tokenCacheKey, {
        userId,
        provider: prov,
        expiresAtMs,
      });
    }
  };
  if (!authed && provider) {
    const override = world.idTokenExchange;
    if (override) {
      // Any non-2xx or unparseable answer is folded into a 401 by supabase-js.
      const exchange = override !== "throw" && override.status >= 200 &&
          override.status < 300 && isRecord(override.body) &&
          typeof override.body.access_token === "string"
        ? override.body
        : null;
      if (!exchange) return authFailure(401);
      const user =
        isRecord(exchange.user) && typeof exchange.user.id === "string"
          ? exchange.user.id
          : null;
      if (!user) return authFailure(401);
      authed = { id: user, provider };
      writeCache(user, provider, nowMs / 1000 + 3600);
    } else {
      const sub = claim(payload, "sub");
      if (typeof sub !== "string" || !sub) return authFailure(401);
      if (!world.users.has(sub)) {
        world.users.set(sub, {
          provider,
          email: `${sub.slice(0, 8)}@example.com`,
        });
      }
      authed = { id: sub, provider };
      writeCache(sub, provider, Math.floor(nowMs / 1000) + 3600);
    }
  } else if (!authed) {
    const override = world.getUser;
    let user: { id: string; provider: "google" | "apple" | "none" } | null =
      null;
    if (override) {
      if (override === "throw") return unavailable();
      if (override.status >= 200 && override.status < 300) {
        let body: unknown = override.body ?? {};
        if (override.text !== undefined) {
          try {
            body = JSON.parse(override.text);
          } catch {
            return unavailable();
          }
        }
        if (!isRecord(body) || typeof body.id !== "string" || !body.id) {
          return unavailable();
        }
        const meta = isRecord(body.app_metadata) ? body.app_metadata : {};
        const candidates = [
          meta.provider,
          ...(Array.isArray(meta.providers) ? meta.providers : []),
        ];
        const prov = candidates.find((c) => c === "google" || c === "apple") as
          | "google"
          | "apple"
          | undefined;
        user = { id: body.id, provider: prov ?? "none" };
      } else if ([400, 401, 403].includes(override.status)) {
        return authFailure(401);
      } else {
        return unavailable();
      }
    } else {
      const sub = claim(payload, "sub");
      const known = typeof sub === "string" ? world.users.get(sub) : undefined;
      if (!known) return authFailure(401);
      user = { id: sub as string, provider: known.provider };
    }
    if (user.provider === "none") return authFailure(401);
    if (sessionId && model.revokedSessions.has(sessionId)) {
      return authFailure(401);
    }
    authed = { id: user.id, provider: user.provider };
    writeCache(user.id, user.provider, typeof exp === "number" ? exp : null);
  }
  if (!authed) return authFailure(401);

  // Per-user budget.
  const isRoute = spec.method === "POST" && path === ROUTE;
  const scope = isRoute ? "delete_confirm" : "user";
  const limit = isRoute ? 5 : 240;
  const windowSeconds = isRoute ? 3_600 : 60;
  const userCount = model.limiter.incr(scope, authed.id, windowSeconds, nowMs);
  if (userCount > limit) {
    return reject(
      429,
      "rate_limited",
      model.limiter.nearBoundary(windowSeconds, nowMs)
        ? "user-window-boundary"
        : null,
    );
  }
  if (!isRoute) return reject(404);

  // confirmAccountDeletion()
  const total = bodyBytes(spec.body);
  if (total > MAX_BODY) return reject(413);
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(bodyText(spec.body)) as unknown;
    parsed = isRecord(value) ? value : {};
  } catch {
    parsed = {};
  }
  const challenge = parsed.challenge;
  if (typeof challenge !== "string" || !UUID_RE.test(challenge)) {
    return reject(400, "validation.account_deletion");
  }

  let row: unknown;
  if (world.deletionRead) {
    const read = maybeSingleOf(world.deletionRead);
    if (read.error) return unavailable();
    row = read.data;
  } else {
    row = world.deletionRows.get(authed.id) ?? null;
  }
  const rowChallenge = row === null || row === undefined
    ? undefined
    : (row as Record<string, unknown>).challenge;
  if (!row || rowChallenge !== challenge) {
    return reject(403, "account.deletion_challenge_invalid");
  }
  const rowRecord = row as Record<string, unknown>;
  const expiresAt = Date.parse(String(rowRecord.expires_at));
  const createdAt = Date.parse(String(rowRecord.created_at));
  const expiryLenient = Math.abs(expiresAt - nowMs) < 1_500
    ? "expiry-boundary"
    : null;
  const ageLenient =
    Math.abs(nowMs - createdAt - DELETE_CONFIRM_MIN_AGE_MS) < 1_500
      ? "min-age-boundary"
      : null;
  if (expiresAt <= nowMs) {
    return reject(403, "account.deletion_challenge_expired", expiryLenient);
  }
  if (nowMs - createdAt < DELETE_CONFIRM_MIN_AGE_MS) {
    return reject(429, "account.deletion_too_fast", ageLenient);
  }
  const lenient = expiryLenient ?? ageLenient;

  // deleteExternalAccounts()
  const writes: RecordedCall["kind"][] = [];
  let external: ExternalRow | null;
  if (world.externalRead) {
    const read = maybeSingleOf(world.externalRead);
    if (read.error) return unavailable();
    external = isRecord(read.data)
      ? {
        apple_refresh_token_encrypted:
          typeof read.data.apple_refresh_token_encrypted === "string"
            ? read.data.apple_refresh_token_encrypted
            : null,
        apple_revoked_at: typeof read.data.apple_revoked_at === "string"
          ? read.data.apple_revoked_at
          : null,
        revenuecat_deleted_at:
          typeof read.data.revenuecat_deleted_at === "string"
            ? read.data.revenuecat_deleted_at
            : null,
      }
      : null;
  } else {
    external = world.externalRows.get(authed.id) ?? null;
  }
  if (authed.provider === "apple") {
    if (external?.apple_revoked_at) {
      // revoked
    } else if (external?.apple_refresh_token_encrypted) {
      const ciphertext = external.apple_refresh_token_encrypted;
      const decryptable = ciphertext.startsWith("v1.") &&
        ciphertext.split(".").length === 3 &&
        !ciphertext.endsWith(".garbage");
      if (decryptable) {
        writes.push("apple.revoke");
        const revoke = world.appleRevoke;
        if (revoke) {
          if (revoke === "throw") return unavailable(writes);
          if (revoke.status < 200 || revoke.status >= 300) {
            const code =
              isRecord(revoke.body) && typeof revoke.body.error === "string"
                ? revoke.body.error
                : null;
            if (code !== "invalid_grant") return unavailable(writes);
          }
        }
      }
      writes.push("rest.external_credentials.write");
      if (world.externalWrite) return unavailable(writes);
    }
  }
  if (!external?.revenuecat_deleted_at) {
    writes.push("revenuecat.delete");
    const rc = world.revenuecatDelete;
    if (rc) {
      if (rc === "throw") return unavailable(writes);
      if ((rc.status < 200 || rc.status >= 300) && rc.status !== 404) {
        return unavailable(writes);
      }
    }
    writes.push("rest.external_credentials.write");
    if (world.externalWrite) return unavailable(writes);
  }

  // Auth admin deleteUser
  writes.push("gotrue.admin_delete");
  const admin = world.adminDelete;
  if (admin) {
    if (admin === "throw") {
      return { ...unavailable(writes), adminDelete: "attempt" };
    }
    const ok = admin.status >= 200 && admin.status < 300 &&
      admin.text === undefined;
    const alreadyDeleted = admin.status === 404 ||
      (isRecord(admin.body) &&
        (admin.body.code === "user_not_found" ||
          admin.body.error_code === "user_not_found"));
    if (!ok && !alreadyDeleted) {
      return { ...unavailable(writes), adminDelete: "attempt" };
    }
  }
  if (sessionId) model.revokedSessions.add(sessionId);
  model.authCache.delete(tokenCacheKey);
  return {
    statuses: [200],
    code: null,
    writesAllowed: new Set(writes),
    adminDelete: "success",
    rejection: false,
    lenient,
  };
}

// ─── Scenario generation ─────────────────────────────────────────────────────

const iso = (ms: number) => new Date(ms).toISOString();

function readyRow(prng: Prng, nowMs: number, challenge: string): DeletionRow {
  const age = prng.int(DELETE_CONFIRM_MIN_AGE_MS + 2_000, 20 * 60_000);
  return {
    challenge,
    created_at: iso(nowMs - age),
    expires_at: iso(nowMs - age + 30 * 60_000),
  };
}

function rowVariant(
  prng: Prng,
  nowMs: number,
  challenge: string,
): { row: DeletionRow | null; label: string } {
  const pick = prng.int(0, 19);
  if (pick <= 8) {
    return { row: readyRow(prng, nowMs, challenge), label: "ready" };
  }
  if (pick <= 10) return { row: null, label: "absent" };
  if (pick <= 12) {
    return {
      row: readyRow(prng, nowMs, prng.uuid()),
      label: "other-challenge",
    };
  }
  if (pick <= 14) {
    const created = nowMs - prng.int(31 * 60_000, 48 * 3_600_000);
    return {
      row: {
        challenge,
        created_at: iso(created),
        expires_at: iso(created + 30 * 60_000),
      },
      label: "expired",
    };
  }
  if (pick <= 16) {
    const created = nowMs - prng.int(0, DELETE_CONFIRM_MIN_AGE_MS - 1_600);
    return {
      row: {
        challenge,
        created_at: iso(created),
        expires_at: iso(created + 30 * 60_000),
      },
      label: "too-fast",
    };
  }
  if (pick === 17) {
    const offset = prng.int(-1_000, 1_000);
    return {
      row: {
        challenge,
        created_at: iso(nowMs - 10 * 60_000),
        expires_at: iso(nowMs + offset),
      },
      label: `expiry-boundary:${offset}ms`,
    };
  }
  if (pick === 18) {
    const offset = prng.int(-1_000, 1_000);
    return {
      row: {
        challenge,
        created_at: iso(nowMs - DELETE_CONFIRM_MIN_AGE_MS + offset),
        expires_at: iso(nowMs + 30 * 60_000),
      },
      label: `min-age-boundary:${offset}ms`,
    };
  }
  const garbage = prng.int(0, 5);
  const rows: Array<[DeletionRow, string]> = [
    [
      { challenge, created_at: "not-a-date", expires_at: "not-a-date" },
      "garbage-timestamps",
    ],
    [{ challenge, created_at: null, expires_at: null }, "null-timestamps"],
    [{
      challenge: null,
      created_at: iso(nowMs - 60_000),
      expires_at: iso(nowMs + 60_000),
    }, "null-challenge"],
    [{
      challenge: 12345,
      created_at: iso(nowMs - 60_000),
      expires_at: iso(nowMs + 60_000),
    }, "numeric-challenge"],
    [{
      challenge,
      created_at: iso(nowMs + 3_600_000),
      expires_at: iso(nowMs + 7_200_000),
    }, "created-in-future"],
    [{ challenge, created_at: "", expires_at: "" }, "empty-timestamps"],
  ];
  return { row: rows[garbage][0], label: rows[garbage][1] };
}

async function externalVariant(
  prng: Prng,
  userId: string,
  encryptionKey: string,
): Promise<{ row: ExternalRow | null; label: string }> {
  const pick = prng.int(0, 9);
  if (pick <= 3) return { row: null, label: "no-external-row" };
  const rcDeleted = prng.next() < 0.3 ? iso(Date.now() - 60_000) : null;
  if (pick <= 6) {
    const encrypted = await encryptAppleRefreshToken(
      `apple-refresh-${prng.int(0, 1e9)}`,
      userId,
      encryptionKey,
    );
    return {
      row: {
        apple_refresh_token_encrypted: encrypted,
        apple_revoked_at: null,
        revenuecat_deleted_at: rcDeleted,
      },
      label: `apple-token-encrypted${rcDeleted ? "+rc-done" : ""}`,
    };
  }
  if (pick === 7) {
    return {
      row: {
        apple_refresh_token_encrypted: "v1.AAAA.garbage",
        apple_revoked_at: null,
        revenuecat_deleted_at: rcDeleted,
      },
      label: `apple-token-garbage${rcDeleted ? "+rc-done" : ""}`,
    };
  }
  if (pick === 8) {
    return {
      row: {
        apple_refresh_token_encrypted: null,
        apple_revoked_at: iso(Date.now() - 120_000),
        revenuecat_deleted_at: rcDeleted,
      },
      label: `apple-revoked${rcDeleted ? "+rc-done" : ""}`,
    };
  }
  return {
    row: {
      apple_refresh_token_encrypted: null,
      apple_revoked_at: null,
      revenuecat_deleted_at: rcDeleted,
    },
    label: `apple-no-token${rcDeleted ? "+rc-done" : ""}`,
  };
}

/** Upstream faults. GoTrue paths never use "throw" (supabase-js retries a
 * dead socket for tens of seconds) and PostgREST reads never answer 503/520
 * (postgrest-js retries GET on those with 1s/2s/4s backoff). */
function faultVariant(prng: Prng, world: World): string[] {
  const notes: string[] = [];
  const maybe = (p: number) => prng.next() < p;
  if (maybe(0.05)) {
    const pick = prng.int(0, 6);
    const answers: Array<[UpstreamAnswer, string]> = [
      [{
        status: 500,
        body: { message: `db down ${LEAK_MARKER}`, code: "XX000" },
      }, "deletionRead:500"],
      [
        { status: 200, text: `<html>gateway ${LEAK_MARKER}</html>` },
        "deletionRead:200-html",
      ],
      [{ status: 200, body: [] }, "deletionRead:200-empty-array"],
      [
        { status: 200, body: [{ challenge: "x" }, { challenge: "y" }] },
        "deletionRead:200-two-rows",
      ],
      [{ status: 200, body: null }, "deletionRead:200-null"],
      [{
        status: 401,
        body: { message: `JWT expired ${LEAK_MARKER}`, code: "PGRST301" },
      }, "deletionRead:401"],
      [{ status: 200, body: "just-a-string" }, "deletionRead:200-string"],
    ];
    world.deletionRead = answers[pick][0];
    notes.push(answers[pick][1]);
  }
  if (maybe(0.04)) {
    const pick = prng.int(0, 2);
    const answers: Array<[UpstreamAnswer, string]> = [
      [
        { status: 500, body: { message: `boom ${LEAK_MARKER}` } },
        "externalRead:500",
      ],
      [{
        status: 200,
        body: [{ apple_revoked_at: 7, revenuecat_deleted_at: false }],
      }, "externalRead:200-typed-garbage"],
      [{ status: 200, text: `oops ${LEAK_MARKER}` }, "externalRead:200-text"],
    ];
    world.externalRead = answers[pick][0];
    notes.push(answers[pick][1]);
  }
  if (maybe(0.04)) {
    const pick = prng.int(0, 2);
    const answers: Array<[UpstreamAnswer, string]> = [
      [
        { status: 500, body: { message: `write failed ${LEAK_MARKER}` } },
        "externalWrite:500",
      ],
      [{
        status: 403,
        body: { message: `permission denied ${LEAK_MARKER}`, code: "42501" },
      }, "externalWrite:403"],
      ["throw", "externalWrite:throw"],
    ];
    world.externalWrite = answers[pick][0];
    notes.push(answers[pick][1]);
  }
  if (maybe(0.05)) {
    const pick = prng.int(0, 4);
    const answers: Array<[UpstreamAnswer, string]> = [
      [
        { status: 500, body: { message: `rc down ${LEAK_MARKER}` } },
        "revenuecat:500",
      ],
      [
        { status: 429, body: { message: `slow down ${LEAK_MARKER}` } },
        "revenuecat:429",
      ],
      [{
        status: 404,
        body: { code: 7259, message: `not found ${LEAK_MARKER}` },
      }, "revenuecat:404"],
      ["throw", "revenuecat:throw"],
      [
        { status: 401, body: { message: `bad key ${LEAK_MARKER}` } },
        "revenuecat:401",
      ],
    ];
    world.revenuecatDelete = answers[pick][0];
    notes.push(answers[pick][1]);
  }
  if (maybe(0.05)) {
    const pick = prng.int(0, 4);
    const answers: Array<[UpstreamAnswer, string]> = [
      [
        { status: 400, body: { error: "invalid_grant" } },
        "appleRevoke:400-invalid_grant",
      ],
      [
        { status: 400, body: { error: "invalid_client" } },
        "appleRevoke:400-invalid_client",
      ],
      [{ status: 500, text: "" }, "appleRevoke:500"],
      ["throw", "appleRevoke:throw"],
      [{ status: 429, body: {} }, "appleRevoke:429"],
    ];
    world.appleRevoke = answers[pick][0];
    notes.push(answers[pick][1]);
  }
  if (maybe(0.05)) {
    const pick = prng.int(0, 4);
    const answers: Array<[UpstreamAnswer, string]> = [
      [{
        status: 404,
        body: {
          code: 404,
          error_code: "user_not_found",
          msg: `gone ${LEAK_MARKER}`,
        },
      }, "adminDelete:404"],
      [{
        status: 500,
        body: {
          code: 500,
          error_code: "unexpected_failure",
          msg: `boom ${LEAK_MARKER}`,
        },
      }, "adminDelete:500"],
      [{
        status: 422,
        body: {
          code: 422,
          error_code: "validation_failed",
          msg: `nope ${LEAK_MARKER}`,
        },
      }, "adminDelete:422"],
      [
        { status: 200, text: `<html>${LEAK_MARKER}</html>` },
        "adminDelete:200-html",
      ],
      [{
        status: 401,
        body: {
          code: 401,
          error_code: "bad_jwt",
          msg: `service key ${LEAK_MARKER}`,
        },
      }, "adminDelete:401"],
    ];
    world.adminDelete = answers[pick][0];
    notes.push(answers[pick][1]);
  }
  if (maybe(0.04)) {
    const pick = prng.int(0, 4);
    const answers: Array<[UpstreamAnswer, string]> = [
      [
        { status: 500, body: { code: 500, msg: `auth down ${LEAK_MARKER}` } },
        "getUser:500",
      ],
      [
        { status: 200, text: `<html>${LEAK_MARKER}</html>` },
        "getUser:200-html",
      ],
      [{ status: 200, body: { id: "", email: null } }, "getUser:200-empty-id"],
      [{
        status: 401,
        body: { code: 401, error_code: "bad_jwt", msg: `bad ${LEAK_MARKER}` },
      }, "getUser:401"],
      [
        { status: 429, body: { code: 429, msg: `rate ${LEAK_MARKER}` } },
        "getUser:429",
      ],
    ];
    world.getUser = answers[pick][0];
    notes.push(answers[pick][1]);
  }
  if (maybe(0.04)) {
    const pick = prng.int(0, 3);
    const answers: Array<[UpstreamAnswer, string]> = [
      [{
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: `bad token ${LEAK_MARKER}`,
        },
      }, "idToken:400"],
      [
        { status: 500, body: { code: 500, msg: `auth down ${LEAK_MARKER}` } },
        "idToken:500",
      ],
      [
        { status: 200, body: { access_token: "x", user: null } },
        "idToken:200-no-user",
      ],
      [
        { status: 200, text: `<html>${LEAK_MARKER}</html>` },
        "idToken:200-html",
      ],
    ];
    world.idTokenExchange = answers[pick][0];
    notes.push(answers[pick][1]);
  }
  return notes;
}

function baseHeaders(
  prng: Prng,
  bearer: Bearer,
  ip: string,
): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  if (bearer.header !== null) headers.push(["Authorization", bearer.header]);
  const ipStyle = prng.int(0, 19);
  if (ipStyle === 0) {
    // no client-ip header at all → shared "unknown" bucket
  } else if (ipStyle === 1) {
    headers.push(["cf-connecting-ip", ip]);
  } else if (ipStyle === 2) {
    headers.push(["x-forwarded-for", `${ipv4(prng)}, ${ipv4(prng)}, ${ip}`]);
  } else if (ipStyle === 3) {
    headers.push([
      "x-forwarded-for",
      `${safeHeaderText(prng, 12).replace(/,/g, ";")}, ${ip}`,
    ]);
  } else if (ipStyle === 4) {
    headers.push(["x-forwarded-for", `${ip},,, `]);
  } else {
    headers.push(["x-forwarded-for", ip]);
  }
  const ct = prng.int(0, 9);
  if (ct <= 5) headers.push(["Content-Type", "application/json"]);
  else if (ct === 6) headers.push(["Content-Type", "text/plain"]);
  else if (ct === 7) {
    headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
  } else if (ct === 8) {
    headers.push([
      "Content-Type",
      `multipart/form-data; boundary=${
        safeHeaderText(prng, 8).replace(/\s/g, "-")
      }`,
    ]);
  }
  const rid = prng.int(0, 9);
  if (rid <= 3) headers.push(["x-request-id", prng.uuid()]);
  else if (rid === 4) {
    headers.push([
      "x-request-id",
      safeHeaderText(prng, prng.int(1, 7)).replace(/\s/g, "a"),
    ]);
  } else if (rid === 5) {
    headers.push(["x-request-id", "z".repeat(prng.int(65, 4_096))]);
  } else if (rid === 6) {
    headers.push(["x-request-id", `  ${"req-".padEnd(12, "0")}  `]);
  } else if (rid === 7) {
    headers.push(["x-request-id", safeHeaderText(prng, 24)]);
  } else if (rid === 8) {
    headers.push(["x-request-id", `${LEAK_MARKER}<script>`]);
  }
  if (prng.next() < 0.15) {
    const n = prng.int(1, 12);
    for (let i = 0; i < n; i++) {
      headers.push([`x-fuzz-${i}`, safeHeaderText(prng, prng.int(0, 2_048))]);
    }
  }
  if (prng.next() < 0.05) {
    headers.push(["x-fuzz-latin1", latin1Text(prng, prng.int(1, 64))]);
  }
  if (prng.next() < 0.1) {
    headers.push(["Accept", prng.next() < 0.5 ? "text/html" : "*/*"]);
  }
  if (prng.next() < 0.1) {
    headers.push([
      "Origin",
      `https://${safeHeaderText(prng, 10).replace(/[^a-z]/g, "a")}.example`,
    ]);
  }
  if (prng.next() < 0.1) headers.push(["Prefer", "return=representation"]);
  if (prng.next() < 0.1) headers.push(["Transfer-Encoding", "chunked"]);
  return headers;
}

function pathVariant(
  prng: Prng,
  challenge: string,
): { method: string; url: string; label: string } {
  const base = `http://edge.stress.test/functions/v1/api${ROUTE}`;
  const pick = prng.int(0, 21);
  const q = (u: string) => `${u}?challenge=${challenge}&x=${prng.int(0, 1e6)}`;
  switch (pick) {
    case 0:
      return {
        method: "POST",
        url: `http://edge.stress.test${ROUTE}`,
        label: "bare-mount",
      };
    case 1:
      return {
        method: "POST",
        url: `http://edge.stress.test/api${ROUTE}`,
        label: "api-mount",
      };
    case 2:
      return { method: "POST", url: q(base), label: "query-string" };
    case 3:
      return { method: "POST", url: `${base}#frag`, label: "fragment" };
    case 4:
      return { method: "POST", url: `${base}/`, label: "trailing-slash" };
    case 5:
      return { method: "POST", url: `${base}/extra`, label: "extra-segment" };
    case 6:
      return {
        method: "POST",
        url: `http://edge.stress.test/functions/v1/api/v1/me/./delete-confirm`,
        label: "dot-segment",
      };
    case 7:
      return {
        method: "POST",
        url:
          `http://edge.stress.test/functions/v1/api/v1/me/../me/delete-confirm`,
        label: "dotdot-segment",
      };
    case 8:
      return {
        method: "POST",
        url: `http://edge.stress.test//v1/me/delete-confirm`,
        label: "double-slash-prefix",
      };
    case 9:
      return {
        method: "POST",
        url: `http://edge.stress.test/functions/v1/api/v1/me/delete%2Dconfirm`,
        label: "percent-encoded-hyphen",
      };
    case 10:
      return {
        method: "POST",
        url: `http://edge.stress.test/functions/v1/api/v1/me/Delete-Confirm`,
        label: "case-variant",
      };
    case 11:
      return {
        method: "POST",
        url: `http://edge.stress.test/functions/v1/api/v1/me/delete-confirm%00`,
        label: "encoded-nul-suffix",
      };
    case 12:
      return { method: "GET", url: base, label: "GET" };
    case 13:
      return { method: "PUT", url: base, label: "PUT" };
    case 14:
      return { method: "DELETE", url: base, label: "DELETE" };
    case 15:
      return { method: "PATCH", url: base, label: "PATCH" };
    case 16:
      return { method: "HEAD", url: base, label: "HEAD" };
    case 17:
      return { method: "OPTIONS", url: base, label: "OPTIONS" };
    case 18:
      return {
        method: "POST",
        url: `${base}/${"a".repeat(prng.int(1_000, 16_000))}`,
        label: "long-suffix",
      };
    case 19:
      return {
        method: "POST",
        url:
          `http://edge.stress.test/functions/v1/api/v1/me/delete-confirm/../delete-confirm`,
        label: "dotdot-self",
      };
    case 20:
      return {
        method: "POST",
        url:
          `http://edge.stress.test/functions/v1/api/v1/me/delete-confirm/../delete-request/../delete-confirm`,
        label: "dotdot-through-sibling",
      };
    default:
      return {
        method: "POST",
        url: `http://edge.stress.test/v1/x/v1/me/delete-confirm`,
        label: "interior-v1",
      };
  }
}

async function generate(
  seed: number,
  encryptionKey: string,
): Promise<Scenario> {
  const prng = new Prng(seed);
  const nowMs = Date.now();
  const provider: "google" | "apple" = prng.next() < 0.55 ? "google" : "apple";
  const userId = prng.uuid();
  const challenge = prng.uuid();
  const ip = ipv4(prng);
  const world = freshWorld();
  world.users.set(userId, {
    provider,
    email: `${userId.slice(0, 8)}@example.com`,
  });
  const notes: string[] = [];
  const base = `http://edge.stress.test/functions/v1/api${ROUTE}`;
  const validBody = (): BodySpec => ({
    kind: "text",
    text: JSON.stringify({ challenge }),
  });

  const roll = prng.next();
  let category: string;
  if (roll < 0.22) category = "auth";
  else if (roll < 0.55) category = "body";
  else if (roll < 0.67) category = "path";
  else if (roll < 0.74) category = "size";
  else if (roll < 0.86) category = "replay";
  else if (roll < 0.93) category = "concurrent";
  else category = "faults";

  const external = await externalVariant(prng, userId, encryptionKey);
  if (external.row) world.externalRows.set(userId, external.row);
  notes.push(`external:${external.label}`);

  const steps: Step[] = [];
  let variant = "";
  switch (category) {
    case "auth": {
      const rowV = rowVariant(prng, nowMs, challenge);
      if (rowV.row) world.deletionRows.set(userId, rowV.row);
      notes.push(`row:${rowV.label}`);
      const bearer = mutatedBearer(prng, provider, userId);
      variant = bearer.label;
      steps.push({
        label: "auth",
        group: 0,
        request: {
          method: "POST",
          url: base,
          headers: baseHeaders(prng, bearer, ip),
          body: validBody(),
        },
      });
      break;
    }
    case "body": {
      const rowV = rowVariant(prng, nowMs, challenge);
      if (rowV.row) world.deletionRows.set(userId, rowV.row);
      notes.push(`row:${rowV.label}`);
      const bearer = validBearer(prng, provider, userId);
      const mutation = bodyMutation(prng, challenge);
      variant = mutation.label;
      steps.push({
        label: "body",
        group: 0,
        request: {
          method: "POST",
          url: base,
          headers: baseHeaders(prng, bearer, ip),
          body: mutation.body,
        },
      });
      break;
    }
    case "path": {
      world.deletionRows.set(userId, readyRow(prng, nowMs, challenge));
      const bearer = validBearer(prng, provider, userId);
      let pv = pathVariant(prng, challenge);
      while (hitsAnotherRoute(pv.method, pv.url)) {
        pv = pathVariant(prng, challenge);
      }
      variant = pv.label;
      const body: BodySpec = pv.method === "GET" || pv.method === "HEAD"
        ? { kind: "none" }
        : validBody();
      steps.push({
        label: "path",
        group: 0,
        request: {
          method: pv.method,
          url: pv.url,
          headers: baseHeaders(prng, bearer, ip),
          body,
        },
      });
      break;
    }
    case "size": {
      world.deletionRows.set(userId, readyRow(prng, nowMs, challenge));
      const bearer = validBearer(prng, provider, userId);
      const headers = baseHeaders(prng, bearer, ip);
      const pick = prng.int(0, 9);
      let body: BodySpec = validBody();
      if (pick === 0) {
        headers.push(["Content-Length", String(MAX_BODY + prng.int(1, 1e9))]);
        variant = "declared-over-cap";
      } else if (pick === 1) {
        headers.push(["Content-Length", "1e9"]);
        variant = "declared-exponent";
      } else if (pick === 2) {
        headers.push(["Content-Length", "0x5F5E100"]);
        variant = "declared-hex";
      } else if (pick === 3) {
        headers.push(["Content-Length", " 6000000 "]);
        variant = "declared-padded";
      } else if (pick === 4) {
        headers.push(["Content-Length", "Infinity"]);
        variant = "declared-infinity";
      } else if (pick === 5) {
        headers.push(["Content-Length", "6,000,000"]);
        variant = "declared-nan";
      } else if (pick === 6) {
        headers.push(["Content-Length", "-1"]);
        variant = "declared-negative";
      } else if (pick === 7) {
        const pad = MAX_BODY - JSON.stringify({ challenge, pad: "" }).length;
        body = {
          kind: "text",
          text: JSON.stringify({ challenge, pad: "p".repeat(pad) }),
        };
        variant = "exactly-at-cap";
      } else if (pick === 8) {
        const chunk = "p".repeat(65_536);
        const chunks = [`{"challenge":"${challenge}","pad":"`];
        let total = chunks[0].length;
        while (total <= MAX_BODY + 65_536) {
          chunks.push(chunk);
          total += chunk.length;
        }
        chunks.push(`"}`);
        total += 2;
        body = { kind: "stream", chunks, totalBytes: total };
        variant = "streamed-over-cap";
      } else {
        const pad = MAX_BODY + 1 -
          JSON.stringify({ challenge, pad: "" }).length;
        body = {
          kind: "text",
          text: JSON.stringify({ challenge, pad: "p".repeat(pad) }),
        };
        variant = "one-byte-over-cap";
      }
      steps.push({
        label: "size",
        group: 0,
        request: { method: "POST", url: base, headers, body },
      });
      break;
    }
    case "replay": {
      world.deletionRows.set(userId, readyRow(prng, nowMs, challenge));
      const bearer = validBearer(prng, provider, userId);
      const repeats = prng.int(2, 7);
      variant = `sequential-x${repeats}:${bearer.label}`;
      for (let i = 0; i < repeats; i++) {
        steps.push({
          label: `replay-${i}`,
          group: i,
          request: {
            method: "POST",
            url: base,
            headers: baseHeaders(prng, bearer, ip),
            body: validBody(),
          },
        });
      }
      break;
    }
    case "concurrent": {
      world.deletionRows.set(userId, readyRow(prng, nowMs, challenge));
      const bearer = validBearer(prng, provider, userId);
      const fanout = prng.int(2, 5);
      variant = `parallel-x${fanout}:${bearer.label}`;
      for (let i = 0; i < fanout; i++) {
        steps.push({
          label: `parallel-${i}`,
          group: 0,
          request: {
            method: "POST",
            url: base,
            headers: baseHeaders(prng, bearer, ip),
            body: validBody(),
          },
        });
      }
      break;
    }
    default: {
      world.deletionRows.set(userId, readyRow(prng, nowMs, challenge));
      const bearer = validBearer(prng, provider, userId);
      const faults = faultVariant(prng, world);
      if (faults.length === 0) {
        world.adminDelete = {
          status: 500,
          body: { code: 500, msg: `boom ${LEAK_MARKER}` },
        };
        faults.push("adminDelete:500");
      }
      variant = faults.join("+");
      steps.push({
        label: "faults",
        group: 0,
        request: {
          method: "POST",
          url: base,
          headers: baseHeaders(prng, bearer, ip),
          body: validBody(),
        },
      });
      // A retry after the fault clears must still delete exactly once.
      if (prng.next() < 0.5) {
        steps.push({
          label: "retry-after-fault",
          group: 1,
          request: {
            method: "POST",
            url: base,
            headers: baseHeaders(prng, bearer, ip),
            body: validBody(),
          },
        });
      }
      break;
    }
  }
  if (category !== "faults" && prng.next() < 0.08) {
    notes.push(...faultVariant(prng, world).map((f) => `fault:${f}`));
  }
  return { seed, category, variant, provider, userId, world, steps, notes };
}

// ─── Execution ───────────────────────────────────────────────────────────────

function buildRequest(spec: RequestSpec): Request {
  const headers = new Headers();
  for (const [name, value] of spec.headers) headers.append(name, value);
  let body: BodyInit | null = null;
  switch (spec.body.kind) {
    case "text":
      body = spec.body.text;
      break;
    case "bytes":
      body = new Blob([spec.body.bytes as BlobPart]);
      break;
    case "stream": {
      const chunks = spec.body.chunks;
      let i = 0;
      const encoder = new TextEncoder();
      body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunks[i++]));
        },
      });
      break;
    }
    case "none":
      body = null;
  }
  const init: RequestInit & { duplex?: "half" } = {
    method: spec.method,
    headers,
    body,
  };
  if (spec.body.kind === "stream") init.duplex = "half";
  return new Request(spec.url, init);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

function tokenOf(spec: RequestSpec): string {
  const auth =
    spec.headers.find(([name]) => name.toLowerCase() === "authorization")
      ?.[1] ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

function preview(body: BodySpec): string {
  const text = body.kind === "bytes"
    ? `<${body.bytes.byteLength} raw bytes>`
    : bodyText(body);
  return text.length > 160
    ? `${text.slice(0, 160)}…(${text.length} chars)`
    : text;
}

function judge(
  spec: RequestSpec,
  expected: Expectation,
  snap: ResponseSnapshot,
  /** Calls attributable to this request; null when the request ran in a
   * concurrent group (write checks then happen at group level). */
  calls: RecordedCall[] | null,
): {
  violations: string[];
  observations: string[];
  verdict: StepResult["verdict"];
} {
  const violations: string[] = [];
  const tolerated: string[] = [];
  const observations: string[] = [];
  const statusOk = expected.statuses.includes(snap.status);
  if (!statusOk) {
    if (
      expected.lenient &&
      (BAD_INPUT_STATUSES.has(snap.status) || snap.status === 200)
    ) {
      tolerated.push(
        `status ${snap.status} vs model ${
          expected.statuses.join("/")
        } (${expected.lenient})`,
      );
    } else {
      violations.push(
        `status ${snap.status}, model expected ${expected.statuses.join("/")}`,
      );
    }
  } else if (expected.code && snap.errorCode !== expected.code) {
    violations.push(`error code ${snap.errorCode} != ${expected.code}`);
  }

  // Campaign-wide invariants (independent of the model).
  if (expected.rejection && !BAD_INPUT_STATUSES.has(snap.status)) {
    violations.push(
      `rejection answered ${snap.status}, allowed ${
        [...BAD_INPUT_STATUSES].join("/")
      }`,
    );
  }
  if (snap.status >= 500) {
    if (snap.status !== 503 && snap.status !== 500) {
      violations.push(`unexpected 5xx ${snap.status}`);
    }
    if (
      !snap.errorMessage ||
      (!GENERIC_5XX.has(snap.errorMessage) &&
        !/^[A-Za-z ]+ is temporarily unavailable\. Please try again\.$/.test(
          snap.errorMessage,
        ))
    ) {
      violations.push(`5xx body not generic: ${snap.body.slice(0, 200)}`);
    }
  }
  if (snap.body.includes(LEAK_MARKER)) {
    violations.push("response echoes upstream detail marker");
  }
  if (STACK_OR_INTERNAL_RE.test(snap.body)) {
    violations.push(
      `response body looks like a stack trace / internal detail: ${
        snap.body.slice(0, 200)
      }`,
    );
  }
  if (spec.method !== "HEAD") {
    if (snap.json === null) {
      violations.push(`non-JSON body (${snap.contentType})`);
    }
    if (!/application\/json/.test(snap.contentType ?? "")) {
      violations.push(`content-type ${snap.contentType}`);
    }
  }
  if (!snap.requestId) {
    violations.push("missing x-request-id");
  } else {
    const incoming = spec.headers.find(([name]) =>
      name.toLowerCase() === "x-request-id"
    )?.[1]?.trim() ?? "";
    if (REQUEST_ID_RE.test(incoming)) {
      if (snap.requestId !== incoming) {
        violations.push(`x-request-id not echoed (${snap.requestId})`);
      }
    } else if (!UUID_RE.test(snap.requestId)) {
      violations.push(
        `x-request-id not regenerated for malformed input: ${snap.requestId}`,
      );
    }
  }
  if (
    snap.status === 429 && snap.errorCode === "rate_limited" &&
    !snap.headers["retry-after"]
  ) {
    violations.push("429 rate_limited without Retry-After");
  }
  if (snap.status === 200) {
    const ok = isRecord(snap.json) && snap.json.deleted === true &&
      ["revoked", "not_applicable", "manual_action_required"].includes(
        String(snap.json.appleAuthorizationRevocation),
      );
    if (!ok) {
      violations.push(
        `200 body is not the deletion contract: ${snap.body.slice(0, 200)}`,
      );
    }
  }
  if (snap.status === 404 && snap.body.length > 512) {
    observations.push(
      `404 body reflects the request path (${snap.body.length} chars)`,
    );
  }

  if (calls) {
    const writes = calls.filter((c) => c.write);
    // 4xx: never a write. 5xx / 200: only the writes the model allows.
    const allowed = snap.status >= 400 && snap.status < 500
      ? new Set<RecordedCall["kind"]>()
      : expected.writesAllowed;
    for (const w of writes) {
      if (!allowed.has(w.kind)) {
        violations.push(
          `write on ${snap.status}: ${w.kind} ${w.method} ${w.url}`,
        );
      }
    }
    const adminAttempts = calls.filter((c) =>
      c.kind === "gotrue.admin_delete"
    ).length;
    if (expected.adminDelete === "none" && adminAttempts > 0) {
      violations.push(`admin deleteUser attempted on ${snap.status}`);
    }
    if (snap.status === 200 && adminAttempts !== 1) {
      violations.push(`200 with ${adminAttempts} admin deleteUser calls`);
    }
    if (calls.some((c) => c.kind === "unexpected")) {
      violations.push("handler called an unstubbed upstream");
    }
  }
  const verdict: StepResult["verdict"] = violations.length
    ? "BROKEN"
    : tolerated.length
    ? "TOLERATED"
    : "HELD";
  return {
    violations: violations.concat(tolerated.map((t) => `tolerated: ${t}`)),
    observations,
    verdict,
  };
}

async function runIteration(
  harness: StressHarness,
  scenario: Scenario,
  /** Mirrors the isolate-wide memory limiter/auth cache, so it lives for
   * the whole campaign, not one iteration. */
  model: ModelState,
): Promise<IterationRow> {
  const startedAt = performance.now();
  harness.begin(scenario.world);
  const results: StepResult[] = [];
  const groups = new Map<number, Step[]>();
  for (const step of scenario.steps) {
    groups.set(step.group, [...(groups.get(step.group) ?? []), step]);
  }
  const world = scenario.world;
  const record = (
    step: Step,
    expected: Expectation,
    snap: ResponseSnapshot,
    calls: RecordedCall[],
    judged: ReturnType<typeof judge>,
  ) => {
    const { path } = routeOf(step.request.method, step.request.url);
    results.push({
      label: step.label,
      method: step.request.method,
      path,
      bodyPreview: preview(step.request.body),
      bodyBytes: bodyBytes(step.request.body),
      expected: expected.statuses,
      expectedCode: expected.code ?? null,
      status: snap.status,
      code: snap.errorCode,
      requestId: snap.requestId,
      writes: calls.filter((c) => c.write).map((c) => c.kind),
      calls: calls.map((c) => c.kind),
      verdict: judged.verdict,
      violations: judged.violations,
      observations: judged.observations,
      bodyExcerpt: judged.verdict === "BROKEN"
        ? snap.body.slice(0, 300)
        : undefined,
    });
  };

  for (const [, steps] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const nowMs = Date.now();
    const existedBefore = world.users.has(scenario.userId);
    // Concurrent steps all start from the pre-group state (none of them can
    // observe a sibling's fence or cache write); the shared model still
    // absorbs every step so limiter counts and fences carry forward.
    const preGroup = steps.length > 1 ? cloneModel(model) : null;
    const expectations: Expectation[] = [];
    const sharedPredictions: Expectation[] = [];
    for (const step of steps) {
      const cacheKey = await sha256Hex(tokenOf(step.request));
      const shared = predict(step.request, world, model, nowMs, cacheKey);
      sharedPredictions.push(shared);
      expectations.push(
        preGroup
          ? predict(step.request, world, cloneModel(preGroup), nowMs, cacheKey)
          : shared,
      );
    }
    const before = harness.calls.length;
    const snaps = await Promise.all(
      steps.map(async (step) =>
        snapshot(await harness.handler(buildRequest(step.request)))
      ),
    );
    const groupCalls = harness.calls.slice(before);
    const concurrent = steps.length > 1;
    snaps.forEach((snap, index) => {
      const expected = expectations[index];
      if (concurrent && expected.statuses.includes(200)) {
        // In-flight duplicates race: whichever reads the row after the
        // winner's cascade sees no challenge (403); a session bearer fenced
        // by the winner sees 401; a second admin delete is idempotent (200).
        expected.statuses = [200, 403, 401];
        expected.code = null;
      }
      const judged = judge(
        steps[index].request,
        expected,
        snap,
        concurrent ? null : groupCalls,
      );
      record(steps[index], expectations[index], snap, groupCalls, judged);
    });
    const last = results[results.length - 1];
    const okCount = snaps.filter((s) => s.status === 200).length;
    const rejectedCount = snaps.filter((s) =>
      s.status >= 400 && s.status < 500
    ).length;
    const existsAfter = world.users.has(scenario.userId);
    // The shared model is a sequential prediction; races (and any model
    // divergence, tolerated or not) decide how many requests actually failed
    // authentication, so reconcile the per-IP auth-failure counter with what
    // the real limiter saw — the "unknown" bucket is shared across iterations.
    steps.forEach((step, index) => {
      const predicted401 = sharedPredictions[index].statuses.includes(401)
        ? 1
        : 0;
      const actual401 = snaps[index].status === 401 ? 1 : 0;
      if (predicted401 !== actual401) {
        model.limiter.adjust(
          "authfail",
          clientIp(new Headers(step.request.headers)),
          300,
          nowMs,
          actual401 - predicted401,
        );
      }
    });
    if (concurrent) {
      // Duplicate in-flight confirms: every 200 is idempotent (at most one
      // upstream deletion actually removes the user), rejections write nothing.
      const adminCalls =
        groupCalls.filter((c) => c.kind === "gotrue.admin_delete").length;
      if (adminCalls > steps.length) {
        last.violations.push(
          `admin deleteUser called ${adminCalls}x for ${steps.length} requests`,
        );
      }
      if (rejectedCount === steps.length && groupCalls.some((c) => c.write)) {
        last.violations.push(
          `writes on an all-rejected concurrent group: ${
            groupCalls.filter((c) => c.write).map((c) => c.kind).join(",")
          }`,
        );
      }
      if (rejectedCount === steps.length && adminCalls > 0) {
        last.violations.push(
          "admin deleteUser attempted although every response was a rejection",
        );
      }
      if (groupCalls.some((c) => c.kind === "unexpected")) {
        last.violations.push("handler called an unstubbed upstream");
      }
    }
    // Upstream post-condition: a 200 removed the user (unless the admin
    // answer was forced); no 200 → the user is still there.
    // (A concurrent sibling bearing a provider ID token can re-create the
    // user through the id-token exchange after the winner's cascade — that
    // is GoTrue sign-in semantics, not a failed deletion.)
    const recreatedByExchange = concurrent &&
      groupCalls.some((c) => c.kind === "gotrue.id_token");
    if (
      okCount > 0 && existsAfter && !world.adminDelete && !recreatedByExchange
    ) {
      last.violations.push("200 answered but the user still exists upstream");
    }
    if (okCount === 0 && existedBefore && !existsAfter) {
      last.violations.push("user removed upstream without a 200");
    }
    if (last.violations.some((v) => !v.startsWith("tolerated"))) {
      last.verdict = "BROKEN";
    }
  }
  const verdict: IterationRow["verdict"] =
    results.some((r) => r.verdict === "BROKEN")
      ? "BROKEN"
      : results.some((r) => r.verdict === "TOLERATED")
      ? "TOLERATED"
      : "HELD";
  return {
    seed: scenario.seed,
    category: scenario.category,
    variant: scenario.variant,
    provider: scenario.provider,
    steps: results,
    verdict,
    notes: scenario.notes,
    ms: Math.round(performance.now() - startedAt),
  };
}

Deno.test({
  name: `stress delete-confirm fuzz/boundary (${
    STRESS_ONLY
      ? `replay ${STRESS_ONLY}`
      : `${STRESS_ITER} iterations, seed ${STRESS_SEED}`
  })`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await loadStressHarness();
    // The route logs one JSON line per request; keep the campaign output legible.
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      if (typeof args[0] === "string" && /^(\{"evt":|\[api\])/.test(args[0])) {
        return;
      }
      realLog(...args);
    };
    try {
      await campaign(harness);
    } finally {
      console.log = realLog;
      harness.teardown();
    }
  },
});

async function campaign(harness: StressHarness): Promise<void> {
  {
    const seeds = STRESS_ONLY
      ? [Number(STRESS_ONLY)]
      : Array.from({ length: STRESS_ITER }, (_, i) =>
        iterationSeed(STRESS_SEED, i));
    const rows: IterationRow[] = [];
    const startedAt = performance.now();
    const model: ModelState = {
      limiter: new LimiterModel(),
      authCache: new Map(),
      revokedSessions: new Set(),
    };
    for (const seed of seeds) {
      const scenario = await generate(seed, harness.appleTokenEncryptionKey);
      const row = await runIteration(harness, scenario, model);
      rows.push(row);
      if (FAIL_FAST && row.verdict === "BROKEN") break;
    }
    const requests = rows.reduce((n, r) => n + r.steps.length, 0);
    const broken = rows.filter((r) => r.verdict === "BROKEN");
    const tolerated = rows.filter((r) => r.verdict === "TOLERATED");
    const statuses = histogram(
      rows.flatMap((r) => r.steps.map((s) => s.status)),
    );
    const fiveXx = rows.flatMap((r) =>
      r.steps.filter((s) => s.status >= 500).map((s) => ({
        seed: r.seed,
        variant: r.variant,
        status: s.status,
        label: s.label,
      }))
    );
    const report = {
      campaign: "stress-route-post-v1-me-delete-confirm/fuzz-boundary",
      seed: STRESS_SEED,
      iterations: rows.length,
      requests,
      elapsedMs: Math.round(performance.now() - startedAt),
      categories: histogram(rows.map((r) => r.category)),
      statuses,
      verdicts: histogram(rows.map((r) => r.verdict)),
      fiveXx,
      broken: broken.map((r) => ({
        seed: r.seed,
        category: r.category,
        variant: r.variant,
        replay:
          `STRESS_ONLY=${r.seed} deno test -A --no-check --config deno.json stress_delete_confirm_fuzz.test.ts`,
        violations: r.steps.flatMap((s) =>
          s.violations.filter((v) => !v.startsWith("tolerated"))
        ),
      })),
      tolerated: tolerated.map((r) => ({
        seed: r.seed,
        variant: r.variant,
        notes: r.steps.flatMap((s) => s.violations),
      })),
      observations: rows.flatMap((r) =>
        r.steps.filter((s) => s.observations.length).map((s) => ({
          seed: r.seed,
          variant: r.variant,
          label: s.label,
          observations: s.observations,
        }))
      ),
      rows,
    };
    if (STRESS_OUT_DIR) {
      await Deno.mkdir(STRESS_OUT_DIR, { recursive: true });
      const file = `${
        STRESS_OUT_DIR.replace(/\/$/, "")
      }/stress_delete_confirm_fuzz_${STRESS_ONLY || STRESS_SEED}.json`;
      await Deno.writeTextFile(file, JSON.stringify(report, null, 2));
      console.log(`[stress] wrote ${file}`);
    }
    console.log(
      `[stress] iterations=${rows.length} requests=${requests} verdicts=${
        JSON.stringify(report.verdicts)
      } statuses=${
        JSON.stringify(statuses)
      } 5xx=${fiveXx.length} elapsed=${report.elapsedMs}ms`,
    );
    for (const b of report.broken.slice(0, 25)) {
      console.log(
        `[stress] BROKEN seed=${b.seed} ${b.category}/${b.variant}: ${
          b.violations.join(" | ")
        }`,
      );
    }
    assertEquals(
      broken.map((r) => r.seed),
      [],
      `${broken.length} broken iteration(s); replay with STRESS_ONLY=<seed>`,
    );
  }
}
