// Pickle Sensei — Supabase Edge Function implementing the mobile app's
// account + onboarding + access + sync + consent API contracts on top of
// Supabase Auth.
//
//   POST /v1/account/bootstrap takes Authorization: Bearer <Google/Apple ID
//   TOKEN (OIDC)>, exchanges it with Supabase Auth, and returns a durable
//   Supabase session { accessToken, refreshToken, expiresAt } beside the
//   account. Every other endpoint takes Authorization: Bearer <Supabase
//   ACCESS TOKEN> (a provider ID token is still accepted there transitionally
//   for app builds that predate the session contract — see authenticate()).
//     → 401/403 { error: { message } }   (app maps to rejected)
//     → 5xx     { error: { message } }   (app maps to retryable unavailable)
//
//   POST /v1/account/bootstrap → { user:{id,email}, onboardingState, session }
//   POST /v1/auth/refresh      → { session } (rotates the refresh token; 401
//                                when it was revoked or already rotated away)
//   POST /v1/auth/logout       → 204; revokes THIS device's session so its
//                                refresh token is dead server-side
//   GET  /v1/me                → + profile { skill_level, handedness, … }
//   PUT  /v1/me/onboarding     → { plan:{focusCheckpoint}, recommendedCheckpoint }
//   GET  /v1/me/access         → free-ratings/premium access state (used is
//                                derived from real scored shots; premium from
//                                the server-verified billing_entitlements row)
//   POST /v1/billing/sync      → { billing, access } — verifies the user's
//                                entitlements against RevenueCat's REST API
//                                (REVENUECAT_SECRET_API_KEY) and persists the
//                                verdict to public.billing_entitlements
//   POST /v1/analysis-permits             → reserve a rating permit
//   POST /v1/analysis-permits/:id/finalize→ release/finalize a permit
//   POST /v1/shots:sync        → idempotent batch upsert of on-device analyses
//   POST /v1/sessions          → idempotent session create
//   POST /v1/sessions/:id/finalize → stamp ended_at
//   POST /v1/me/evaluation/trials  → consent-gated trial evidence intake
//   POST /v1/analyses/:id/feedback → "was this accurate?" failure-mining signal
//   GET  /v1/progress          → canonical progress series + practice streak
//   GET  /v1/rank              → saved personal rank (bronze…diamond) + the
//                                per-technique scores it averages
//   GET  /v1/me/consent/status, POST /v1/me/consent/grant|withdraw
//   GET/PUT/DELETE /v1/me/saved-drills[/:slug]
//   POST /v1/me/delete-request  → two-step account deletion, step 1 (body may
//                                carry the optional exit survey)
//   POST /v1/me/delete-confirm  → step 2 (requires the step-1 challenge)
//
//   Public (no auth):
//   GET  /healthz               → { ok: true } (monitoring + load tests)
//   GET  /support, /privacy,
//        /terms                 → hosted support/legal documents (legal.ts; plain
//                                text — the gateway sandboxes HTML on
//                                *.supabase.co)
//   POST /webhooks/revenuecat   → billing webhook (shared-secret gated;
//                                entitlements re-verified against RevenueCat,
//                                never trusted from the event body)
//
// Scale + abuse posture (cache.ts / rateLimit.ts / http.ts):
//   * Verified auth sessions are cached (Upstash Redis when configured, else
//     per-isolate memory) so Supabase Auth is consulted ~once per user per
//     10 minutes instead of on every request.
//   * Every route family carries a rate budget (per-user once authed,
//     per-IP before), 429 + Retry-After on exhaustion.
//   * 5xx responses never leak internal detail; JSON responses carry
//     no-store/nosniff headers; request bodies are size-capped.
//
// The app (apps/mobile/src/account/bootstrap.ts) sends the provider ID token
// to bootstrap; this function exchanges it with Supabase Auth
// (signInWithIdToken), which verifies it against the Google/Apple provider
// configuration and creates/returns the auth.users row. The profiles trigger
// (see migrations) provisions the canonical account row. From then on the
// app bears the Supabase access token, keeps the refresh token in the device
// Keychain (apps/mobile/src/account/sessionVault.ts) so a relaunch restores
// the session through /v1/auth/refresh instead of a fresh provider sign-in,
// and calls /v1/auth/logout on explicit sign-out.
//
// Deploy with JWT verification OFF (bootstrap's bearer is a provider token,
// not a Supabase JWT):   supabase functions deploy api --no-verify-jwt
//
// UNVERIFIED-HERE: written locally without a Supabase project attached; the
// TypeScript is Deno-targeted (not part of the pnpm workspace typecheck).
// Verify with `supabase functions serve api` + a real Google ID token.

import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import { drillCatalogEntry, searchDrillCatalog } from "./drills.ts";
import { drillInstructionalMedia } from "./drillMedia.ts";
import {
  cacheDel,
  cacheFence,
  cacheGet,
  cacheGetUnlessRevoked,
  cacheIsRevoked,
  cacheSet,
  cacheSetFenced,
  L1_READTHROUGH_TTL_SECONDS,
  redisConfigured,
  sha256Hex,
} from "./cache.ts";
import { enforceRateLimit, peekRateLimit, rateLimitResponse } from "./rateLimit.ts";
import {
  accessLogEntry,
  clientIp,
  constantTimeEqual,
  emitAccessLog,
  errorCodeOf,
  JSON_SECURITY_HEADERS,
  legalTextResponse,
  resolveRequestId,
  sanitizeUserText,
  withRequestId,
} from "./http.ts";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "./legal.ts";
import {
  type AppleServerConfiguration,
  decryptAppleRefreshToken,
  deleteRevenueCatCustomer,
  encryptAppleRefreshToken,
  exchangeAppleAuthorizationCode,
  ExternalAccountError,
  isPermanentExternalAccountError,
  revokeAppleRefreshToken,
} from "./externalAccounts.ts";

// Publishable key (sb_publishable_…) set via `supabase secrets set
// SB_PUBLISHABLE_KEY=…`, falling back to the platform-injected legacy anon
// key. After signInWithIdToken we hold the USER's own session, and data
// access runs as that user under row-level security. Narrow administrative
// operations (verified billing writes, webhook audit, encrypted Apple-token
// storage, external-deletion checkpoints, and Auth user deletion) use the
// platform-injected service-role key through billingAdminDb below. The client
// has no write policy to any of those server-owned records.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SB_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;

/** Service-role client for verified billing/webhook writes, encrypted Apple
 * revocation-token storage, retry-safe external-deletion checkpoints, and
 * Auth admin deleteUser. Lazy so unrelated routes do not depend on the key. */
let billingAdminClient: ReturnType<typeof createClient> | null = null;
function billingAdminDb(): ReturnType<typeof createClient> | null {
  if (billingAdminClient) return billingAdminClient;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) return null;
  billingAdminClient = createClient(SUPABASE_URL, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return billingAdminClient;
}

/** Secrets required for Apple's server-to-server token exchange/revocation.
 * Read lazily so Google sign-in and unrelated routes do not depend on them. */
function appleServerConfiguration(): AppleServerConfiguration | null {
  const config: AppleServerConfiguration = {
    clientId: Deno.env.get("APPLE_SIGN_IN_CLIENT_ID") ?? "",
    teamId: Deno.env.get("APPLE_SIGN_IN_TEAM_ID") ?? "",
    keyId: Deno.env.get("APPLE_SIGN_IN_KEY_ID") ?? "",
    privateKeyPem: Deno.env.get("APPLE_SIGN_IN_PRIVATE_KEY") ?? "",
    tokenEncryptionKey: Deno.env.get("APPLE_TOKEN_ENCRYPTION_KEY") ?? "",
  };
  return Object.values(config).every((value) => value.trim()) ? config : null;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_SECURITY_HEADERS },
  });

const errorJson = (status: number, message: string): Response =>
  json(status, { error: { message } });

/** 5xx responses NEVER carry internal detail (DB error strings, stack traces,
 * table names). The detail is logged server-side for operators; the client
 * gets a stable, generic, retryable message. */
const serviceUnavailable = (
  context: string,
  detail?: unknown,
  retryAfterSeconds?: number,
): Response => {
  console.error(`[api] ${context}:`, detail ?? "(no detail)");
  const response = json(503, {
    error: {
      message: `${context} is temporarily unavailable. Please try again.`,
    },
  });
  if (retryAfterSeconds !== undefined) {
    response.headers.set("Retry-After", String(retryAfterSeconds));
  }
  return response;
};

// Coded errors: the app's ApiError reads error.code (e.g. the feedback prompt
// treats analysis.feedback_exists as already-done).
const codedError = (status: number, code: string, message: string): Response =>
  json(status, { error: { code, message } });

// 204: the app's request helpers treat No Content as null (training/api.ts).
const noContent = (): Response => new Response(null, { status: 204 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);

/** The wire shape every client timestamp has (`Date#toISOString`, the
 * api-contracts `z.iso.datetime()`): UTC, `Z`-suffixed, optional fraction.
 * `Date.parse` is deliberately NOT the gate — V8's legacy parser accepts
 * free-form text such as `Jan 1 2026 (anything)`, which would then travel
 * verbatim into the database error path and the function logs. */
const ISO_UTC_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
/** Sane range for a capture/session instant; mirrors the DB CHECKs
 * `shots_captured_at_bounds` / `captures_captured_at_bounds`. */
const ISO_INSTANT_MIN_MS = Date.UTC(2000, 0, 1);
const ISO_INSTANT_MAX_MS = Date.UTC(2100, 0, 1);

const isIsoDate = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = ISO_UTC_INSTANT_RE.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  // A calendar round-trip catches rollovers Date.parse silently accepts
  // (2026-02-30 → March 2).
  const parsed = new Date(ms);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return false;
  }
  return ms >= ISO_INSTANT_MIN_MS && ms < ISO_INSTANT_MAX_MS;
};

/** Log-safe rendering of an RPC status string: one line, control and
 * spoofing characters stripped, length-capped. Statuses are server-generated
 * (SQLSTATE-only since 20260904000000) but the log line must stay categorical
 * even if a future RPC ever echoed input. */
const RPC_STATUS_LOG_MAX = 120;
const logSafeStatus = (status: string): string => sanitizeUserText(status, RPC_STATUS_LOG_MAX);

/** Largest JSON body any route accepts. Shot batches are ~2 KB per shot ×
 * 200; evaluation trials are the biggest legitimate payload and get the
 * same ceiling (their per-trial cap is enforced separately). */
const MAX_JSON_BODY_BYTES = 5_000_000;

/** Thrown while streaming a body that exceeds MAX_JSON_BODY_BYTES; the
 * outermost handler turns it into a 413 so no route buffers past the cap. */
class RequestBodyTooLarge extends Error {
  constructor() {
    super("Request body is too large.");
    this.name = "RequestBodyTooLarge";
  }
}

/** Read the body as text while counting BYTES on the wire, cancelling the
 * stream the moment it passes the cap (Content-Length is advisory only —
 * chunked uploads carry none). */
async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestBodyTooLarge();
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) throw error;
    return "";
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readBoundedText(request, MAX_JSON_BODY_BYTES);
  try {
    const body = JSON.parse(text) as unknown;
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

/** decodeURIComponent that reports a malformed escape as a 400 instead of
 * letting URIError escape the handler. */
function decodePathSegment(segment: string): string | Response {
  try {
    return decodeURIComponent(segment);
  } catch {
    return errorJson(400, "Malformed path segment.");
  }
}

/** Base64url-decode one JWT segment (NOT verification — routing only). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Route the token to the Supabase provider by issuer claim. Verification
 * itself happens inside Supabase Auth (signInWithIdToken). */
function providerForIssuer(issuer: unknown): "google" | "apple" | null {
  if (typeof issuer !== "string") return null;
  const iss = issuer.replace(/^https:\/\//, "");
  if (iss === "accounts.google.com") return "google";
  if (iss === "appleid.apple.com") return "apple";
  return null;
}

/** Onboarding goal → starting focus checkpoint. Mirrors services/api
 * identity routes AND the client's GOAL_FOCUS map verbatim. */
const GOAL_FOCUS: Record<string, string> = {
  dinks: "contact_position",
  drives: "preparation",
  drops: "paddle_set",
  serve: "sequencing",
  return: "athletic_base",
  volleys: "face_wrist_stability",
  footwork: "athletic_base",
  "all-around": "contact_position",
};

/** Optional onboarding gender vocabulary — mirrors the profiles.gender check
 * constraint (20260830120000_production_launch.sql). */
const GENDER_OPTIONS = new Set(["female", "male", "nonbinary", "prefer_not_to_say"]);

interface AuthedUser {
  id: string;
  email: string | null;
  provider: "google" | "apple";
  // Supabase client acting AS this user (RLS enforced on every query).
  db: ReturnType<typeof createClient>;
}

/** Cached, verified session material keyed by SHA-256 of the bearer. For a
 * provider ID token the exchange with Supabase Auth (signInWithIdToken)
 * verifies it cryptographically and mints a Supabase session; for a Supabase
 * access token getUser() verifies it and confirms its session still exists.
 * Either way that is the expensive, auth-service-bound step. Caching the
 * VERIFIED result for a few minutes (never past either token's own expiry)
 * removes an auth round trip from every request, which is the difference
 * between Supabase Auth seeing every API call and seeing ~one call per user
 * per ten minutes. */
interface CachedAuthSession {
  userId: string;
  email: string | null;
  provider: "google" | "apple";
  accessToken: string;
  expiresAtMs: number;
}

const AUTH_CACHE_MAX_TTL_SECONDS = 600;

/** A Supabase session revoked at this edge is fenced by a marker keyed by the
 * JWT `session_id`, so EVERY access token of that session (the one that
 * logged out, its pre-refresh siblings, copies cached by other isolates or
 * re-cached by a request that raced the logout) is refused from the very
 * next request. The marker outlives any cached verification of the session:
 * the cache cap plus the longest an L2 row can linger in an isolate's L1. */
const AUTH_REVOCATION_TTL_SECONDS = AUTH_CACHE_MAX_TTL_SECONDS + L1_READTHROUGH_TTL_SECONDS;

const authRevokedKey = (sessionId: string): string => `auth:revoked:${sessionId}`;

function sessionIdOf(payload: Record<string, unknown> | null): string | null {
  const sessionId = payload?.session_id;
  return typeof sessionId === "string" && sessionId ? sessionId : null;
}

/** Fence a Supabase session at this edge once upstream no longer honours it:
 * publish its revocation marker (L1 + L2) and drop the calling bearer's own
 * cached verification. Call ONLY after upstream revocation completed — a
 * request racing the logout may re-verify and re-cache the bearer, and only
 * the marker outlasts that. */
async function fenceRevokedSession(token: string): Promise<void> {
  const sessionId = sessionIdOf(decodeJwtPayload(token));
  if (sessionId) {
    const shared = await cacheSet(authRevokedKey(sessionId), "1", AUTH_REVOCATION_TTL_SECONDS);
    if (!shared && redisConfigured()) {
      // Upstream has already refused the session; only the cross-isolate
      // fence is missing, so other isolates' cached verifications of it age
      // out on their own (≤ AUTH_CACHE_MAX_TTL_SECONDS) instead of dying now.
      console.warn(`[api] session fence not shared (Redis unavailable): ${sessionId}`);
    }
  }
  await cacheDel(await authCacheKey(token));
}

function userScopedClient(accessToken: string): ReturnType<typeof createClient> {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function anonAuthClient(): ReturnType<typeof createClient> {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── Supabase Auth (GoTrue) gateway ──────────────────────────────────────────
//
// Session verification and refresh talk to GoTrue's REST API directly rather
// than through the supabase-js auth client. The client folds every failure
// into one `error` (an HTTP verdict, a network fault, a body it could not
// parse, its own internal retry loop of ~25 s on a dead socket) and the
// routes then had nothing but "failed" to hand the app — which reads a 401
// as "the server refused your session" and signs the user out. The gateway
// keeps the verdict typed: `refused` is the ONE outcome that may become a
// 401 (and the one that charges the auth-failure budget); `unavailable` is
// retryable for the app and says nothing about the credential.

/** Deadline for one Auth round trip. The app gives a refresh 15 s
 * (sessionLifecycle REQUEST_TIMEOUT_MS) and launch waits 8 s for it, so the
 * edge answers — with a verdict or a retryable 503 — well inside that.
 * `AUTH_UPSTREAM_TIMEOUT_MS` overrides it (positive integer, milliseconds). */
const AUTH_UPSTREAM_TIMEOUT_MS_DEFAULT = 6_000;
/** Pauses before re-sending an Auth call whose SOCKET failed (reset, refused,
 * DNS) — never after an HTTP answer of any status. All attempts share the one
 * deadline above, so a flaky link is ridden out for ≈3 s, not the ~25 s the
 * supabase-js retry loop spent. */
const AUTH_CONNECT_RETRY_BACKOFF_MS: readonly number[] = [100, 200, 400, 800, 1600];
/** Retry hint on a retryable Auth answer when upstream named none. */
const AUTH_RETRY_AFTER_SECONDS = 2;
/** GoTrue statuses that are a verdict on the credential itself: bad/expired
 * JWT (401), session or user gone / banned (403), refresh token not found or
 * already rotated (400 invalid_grant). Everything else is the service, not
 * the credential. */
const AUTH_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 403]);

function authUpstreamTimeoutMs(): number {
  const configured = Number(Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS"));
  return Number.isInteger(configured) && configured > 0
    ? configured
    : AUTH_UPSTREAM_TIMEOUT_MS_DEFAULT;
}

type AuthVerdict<T> =
  | { kind: "ok"; value: T }
  | { kind: "refused"; status: number; detail: string }
  | { kind: "unavailable"; detail: string; retryAfterSeconds: number };

interface AuthUserLike {
  id: string;
  email?: string | null;
  app_metadata?: Record<string, unknown>;
}

function authUserOf(payload: unknown): AuthUserLike | null {
  if (!isRecord(payload) || typeof payload.id !== "string" || !payload.id) {
    return null;
  }
  return {
    id: payload.id,
    email: typeof payload.email === "string" ? payload.email : null,
    app_metadata: isRecord(payload.app_metadata) ? payload.app_metadata : undefined,
  };
}

function authSessionOf(payload: unknown): (SupabaseSessionLike & { user: AuthUserLike }) | null {
  if (!isRecord(payload)) return null;
  const user = authUserOf(payload.user);
  if (
    !user ||
    typeof payload.access_token !== "string" ||
    !payload.access_token ||
    typeof payload.refresh_token !== "string" ||
    !payload.refresh_token
  ) {
    return null;
  }
  // A session that is already dead on arrival (expires_in ≤ 0, expires_at in
  // the past) is a half-written answer, not a usable rotation: handing it to
  // the app would make it refresh again immediately, forever.
  const expiresIn = payload.expires_in ?? undefined;
  if (expiresIn !== undefined && (typeof expiresIn !== "number" || !(expiresIn > 0))) {
    return null;
  }
  const expiresAt = payload.expires_at ?? undefined;
  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== "number" || !(expiresAt * 1000 > Date.now()))
  ) {
    return null;
  }
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: expiresAt,
    expires_in: expiresIn,
    user,
  };
}

/** GoTrue error bodies come as `{code, error_code, msg}` or
 * `{error, error_description}`; keep a short operator-facing summary. */
function authErrorDetail(status: number, body: unknown): string {
  if (isRecord(body)) {
    const code = [body.error_code, body.error, body.code].find(
      (candidate) => typeof candidate === "string" && candidate,
    );
    const message = [body.msg, body.error_description, body.message].find(
      (candidate) => typeof candidate === "string" && candidate,
    );
    return `HTTP ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`.slice(0, 200);
  }
  return `HTTP ${status}${typeof body === "string" && body ? " (non-JSON body)" : ""}`;
}

function retryAfterOf(header: string | null): number {
  const seconds = Number(header);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : AUTH_RETRY_AFTER_SECONDS;
}

class AuthDeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`no answer within ${timeoutMs}ms`);
    this.name = "AuthDeadlineError";
  }
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** One bounded GoTrue call. `parse` turns a 2xx JSON body into the value the
 * caller needs; a 2xx it cannot read is an outage (a gateway page, a
 * half-written answer), never a verdict on the credential. Connection-level
 * faults are re-sent per `AUTH_CONNECT_RETRY_BACKOFF_MS` inside the single
 * deadline; the first HTTP answer, whatever its status, is final. */
async function authRequest<T>(
  path: string,
  init: {
    method: "GET" | "POST";
    bearer?: string;
    body?: Record<string, unknown>;
  },
  parse: (payload: unknown) => T | null,
): Promise<AuthVerdict<T>> {
  const headers: Record<string, string> = {
    apikey: SUPABASE_ANON_KEY,
    Accept: "application/json",
  };
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  if (init.body) headers["Content-Type"] = "application/json";
  const timeoutMs = authUpstreamTimeoutMs();
  const startedAt = Date.now();
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      reject(new AuthDeadlineError(timeoutMs));
    }, timeoutMs);
  });
  // A deadline that fires while nothing races it must not surface as an
  // unhandled rejection.
  deadline.catch(() => undefined);
  const unreachable = (detail: string): AuthVerdict<T> => ({
    kind: "unavailable",
    detail: `Supabase Auth unreachable: ${detail}`,
    retryAfterSeconds: AUTH_RETRY_AFTER_SECONDS,
  });
  const attemptOnce = async () => {
    const response = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
      method: init.method,
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    return {
      status: response.status,
      retryAfter: response.headers.get("Retry-After"),
      text: await response.text(),
    };
  };
  let answer: { status: number; retryAfter: string | null; text: string };
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        answer = await Promise.race([attemptOnce(), deadline]);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof AuthDeadlineError || controller.signal.aborted) {
          return unreachable(attempt === 0 ? message : `${message} (${attempt + 1} attempts)`);
        }
        const backoffMs = AUTH_CONNECT_RETRY_BACKOFF_MS[attempt];
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (backoffMs === undefined || backoffMs >= remainingMs) {
          return unreachable(`${message} (${attempt + 1} attempts)`);
        }
        await Promise.race([sleepUnlessAborted(backoffMs, controller.signal), deadline]).catch(
          () => undefined,
        );
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
  }
  let body: unknown = answer.text;
  try {
    body = JSON.parse(answer.text);
  } catch {
    // Non-JSON body: a verdict status still stands; a 2xx is malformed below.
  }
  if (AUTH_REFUSAL_STATUSES.has(answer.status)) {
    return {
      kind: "refused",
      status: answer.status,
      detail: authErrorDetail(answer.status, body),
    };
  }
  if (answer.status >= 200 && answer.status < 300) {
    const value = parse(body);
    if (value !== null) return { kind: "ok", value };
    return {
      kind: "unavailable",
      detail: `Supabase Auth answered HTTP ${answer.status} without a usable body`,
      retryAfterSeconds: AUTH_RETRY_AFTER_SECONDS,
    };
  }
  return {
    kind: "unavailable",
    detail: `Supabase Auth answered ${authErrorDetail(answer.status, body)}`,
    retryAfterSeconds: retryAfterOf(answer.retryAfter),
  };
}

/** GET /auth/v1/user — the user behind a Supabase access token, which also
 * fails (refused) once the session was logged out or the account deleted. */
const verifyAccessToken = (accessToken: string): Promise<AuthVerdict<AuthUserLike>> =>
  authRequest("/user", { method: "GET", bearer: accessToken }, authUserOf);

/** POST /auth/v1/token?grant_type=refresh_token — rotate a refresh token. */
const rotateRefreshToken = (
  refreshToken: string,
): Promise<AuthVerdict<SupabaseSessionLike & { user: AuthUserLike }>> =>
  authRequest(
    "/token?grant_type=refresh_token",
    { method: "POST", body: { refresh_token: refreshToken } },
    authSessionOf,
  );

/** A bearer whose own `exp` has passed is dead whatever else is true of it:
 * refuse it before the auth cache or Supabase Auth is consulted (a cached
 * verification is bounded by this exp anyway, so this is a round trip saved
 * and a stale-cache defense, not a new rule). */
function bearerExpired(payload: Record<string, unknown> | null): boolean {
  return typeof payload?.exp === "number" && payload.exp * 1_000 <= Date.now();
}

function bearerOf(request: Request): string {
  const authorization = request.headers.get("Authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

const authCacheKey = async (token: string): Promise<string> => `auth:${await sha256Hex(token)}`;

/** Cached verification for the bearer, or null when there is none — or when
 * the Supabase session behind a session bearer has been revoked at this edge
 * (`revoked`), which no cached row may override. */
async function readAuthCache(
  cacheKey: string,
  provider: "google" | "apple" | null,
  sessionId: string | null,
): Promise<{ authed: AuthedUser | null; revoked: boolean }> {
  let cachedRaw: string | null;
  if (sessionId) {
    const hit = await cacheGetUnlessRevoked(cacheKey, authRevokedKey(sessionId));
    if (hit.revoked) return { authed: null, revoked: true };
    cachedRaw = hit.value;
  } else {
    cachedRaw = await cacheGet(cacheKey);
  }
  if (!cachedRaw) return { authed: null, revoked: false };
  try {
    const cached = JSON.parse(cachedRaw) as CachedAuthSession;
    if (
      (provider === null || cached.provider === provider) &&
      cached.expiresAtMs > Date.now() + 5_000
    ) {
      return {
        authed: {
          id: cached.userId,
          email: cached.email,
          provider: cached.provider,
          db: userScopedClient(cached.accessToken),
        },
        revoked: false,
      };
    }
  } catch {
    // Corrupt cache entry — fall through to a real verification.
  }
  return { authed: null, revoked: false };
}

/** Cache lifetime: bounded by the bearer's own exp (the credential the
 * client actually holds), the Supabase session's expiry, and a hard
 * ten-minute cap. Sub-minute remainders are not worth caching. */
async function writeAuthCache(
  cacheKey: string,
  entry: Omit<CachedAuthSession, "expiresAtMs">,
  bearerExpSeconds: unknown,
  sessionExpSeconds: unknown,
): Promise<void> {
  const bearerExpMs = typeof bearerExpSeconds === "number" ? bearerExpSeconds * 1_000 : 0;
  const sessionExpMs = typeof sessionExpSeconds === "number" ? sessionExpSeconds * 1_000 : 0;
  const expiresAtMs = Math.min(
    bearerExpMs > 0 ? bearerExpMs : Number.MAX_SAFE_INTEGER,
    sessionExpMs > 0 ? sessionExpMs : Number.MAX_SAFE_INTEGER,
    Date.now() + AUTH_CACHE_MAX_TTL_SECONDS * 1_000,
  );
  const ttlSeconds = Math.floor((expiresAtMs - Date.now()) / 1_000) - 30;
  if (ttlSeconds >= 60) {
    await cacheSet(cacheKey, JSON.stringify({ ...entry, expiresAtMs }), ttlSeconds);
  }
}

interface SupabaseSessionLike {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
}

/** The session shape returned to the app: the access token it bears from now
 * on, the rotating refresh token that keeps it alive across relaunches, and
 * the access token's expiry (unix seconds) so the app can rotate ahead of it. */
function sessionView(session: SupabaseSessionLike) {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600),
  };
}

/** A Supabase user's sign-in provider, from app_metadata. `provider` is the
 * first identity; `providers` lists every linked one. */
function providerOfUser(user: {
  app_metadata?: Record<string, unknown>;
}): "google" | "apple" | null {
  const meta = user.app_metadata ?? {};
  const candidates = [meta.provider, ...(Array.isArray(meta.providers) ? meta.providers : [])];
  for (const candidate of candidates) {
    if (candidate === "google" || candidate === "apple") return candidate;
  }
  return null;
}

/** Bootstrap-only: verify the provider ID token with Supabase Auth (the
 * signInWithIdToken exchange) and return the user plus the freshly minted
 * Supabase session the app will bear and persist from now on. Every
 * bootstrap mints a NEW session on purpose — one per device sign-in — so
 * this path never reads the auth cache. */
async function authenticateProviderToken(request: Request): Promise<
  | {
      authed: AuthedUser;
      session: SupabaseSessionLike;
      providerSubject: string;
    }
  | Response
> {
  const token = bearerOf(request);
  if (!token) return errorJson(401, "Missing bearer token.");
  const payload = decodeJwtPayload(token);
  const provider = providerForIssuer(payload?.iss);
  if (!provider) {
    return errorJson(401, "Bearer token is not a Google or Apple ID token.");
  }
  if (bearerExpired(payload)) {
    return errorJson(401, "The identity token has expired.");
  }
  const providerSubject = payload?.sub;
  if (typeof providerSubject !== "string" || !providerSubject) {
    return errorJson(401, "The identity token has no subject.");
  }
  const signIn = await anonAuthClient().auth.signInWithIdToken({
    provider,
    token,
  });
  if (signIn.error || !signIn.data.user || !signIn.data.session) {
    return errorJson(401, "The identity token could not be verified.");
  }
  return {
    authed: {
      id: signIn.data.user.id,
      email: signIn.data.user.email ?? null,
      provider,
      db: userScopedClient(signIn.data.session.access_token),
    },
    session: signIn.data.session,
    providerSubject,
  };
}

/** Authenticate the bearer and return a client that acts as that user under
 * RLS. Two bearer kinds are accepted:
 *
 *  - a Supabase ACCESS token issued by bootstrap or /v1/auth/refresh (the
 *    contract since 2026-09-01): verified with getUser(), which also fails
 *    once the session behind it was logged out or the account deleted;
 *  - transitionally, a Google/Apple ID token, for app builds that predate
 *    the session contract and still bear the provider token on every call.
 *    Remove this branch once no such build is in the field. */
async function authenticate(request: Request): Promise<AuthedUser | Response> {
  const token = bearerOf(request);
  if (!token) return errorJson(401, "Missing bearer token.");

  const payload = decodeJwtPayload(token);
  const provider = providerForIssuer(payload?.iss);
  const supabaseIssued = typeof payload?.iss === "string" && payload.iss.endsWith("/auth/v1");
  if (!provider && !supabaseIssued) {
    return errorJson(401, "Bearer token is not a session token or a Google/Apple ID token.");
  }
  if (bearerExpired(payload)) {
    return errorJson(
      401,
      provider ? "The identity token has expired." : "The session token has expired.",
    );
  }

  // Session bearers carry the Supabase session_id; a provider ID token does
  // not (its session is minted below and lives only in the cache row).
  const sessionId = provider ? null : sessionIdOf(payload);
  const cacheKey = await authCacheKey(token);
  const cached = await readAuthCache(cacheKey, provider, sessionId);
  if (cached.revoked) {
    return errorJson(401, "The session is no longer valid. Sign in again.");
  }
  if (cached.authed) return cached.authed;

  if (provider) {
    const signIn = await anonAuthClient().auth.signInWithIdToken({
      provider,
      token,
    });
    if (signIn.error || !signIn.data.user || !signIn.data.session) {
      return errorJson(401, "The identity token could not be verified.");
    }
    await writeAuthCache(
      cacheKey,
      {
        userId: signIn.data.user.id,
        email: signIn.data.user.email ?? null,
        provider,
        accessToken: signIn.data.session.access_token,
      },
      payload?.exp,
      signIn.data.session.expires_at,
    );
    return {
      id: signIn.data.user.id,
      email: signIn.data.user.email ?? null,
      provider,
      db: userScopedClient(signIn.data.session.access_token),
    };
  }

  const verified = await verifyAccessToken(token);
  if (verified.kind === "unavailable") {
    return serviceUnavailable("Session verification", verified.detail, verified.retryAfterSeconds);
  }
  if (verified.kind === "refused") {
    return errorJson(401, "The session is no longer valid. Sign in again.");
  }
  const user = verified.value;
  const sessionProvider = providerOfUser(user);
  if (!sessionProvider) {
    return errorJson(401, "The session does not belong to a Google or Apple account.");
  }
  // The session may have been logged out while getUser() was in flight: a
  // verification that raced its own revocation must neither be served nor
  // cached. (Revocation is fenced again on every later read regardless.)
  if (sessionId && (await cacheIsRevoked(authRevokedKey(sessionId))) === true) {
    return errorJson(401, "The session is no longer valid. Sign in again.");
  }
  await writeAuthCache(
    cacheKey,
    {
      userId: user.id,
      email: user.email ?? null,
      provider: sessionProvider,
      accessToken: token,
    },
    payload?.exp,
    payload?.exp,
  );
  return {
    id: user.id,
    email: user.email ?? null,
    provider: sessionProvider,
    db: userScopedClient(token),
  };
}

/** POST /v1/auth/refresh — rotate { refreshToken } into a fresh Supabase
 * session. 401 means Supabase Auth REFUSED the refresh token (revoked or
 * already rotated away): the app must sign in again. Anything else — Auth
 * down, rate-limiting us, unreachable, answering nonsense — is 503 with a
 * Retry-After, and the app keeps its session and tries again. */
async function refreshSessionRoute(request: Request): Promise<Response> {
  const body = await readBody(request);
  const refreshToken = body.refreshToken;
  if (typeof refreshToken !== "string" || !refreshToken.trim()) {
    return codedError(400, "validation.refresh", "refreshToken is required.");
  }
  const rotated = await rotateRefreshToken(refreshToken.trim());
  if (rotated.kind === "unavailable") {
    return serviceUnavailable("Session refresh", rotated.detail, rotated.retryAfterSeconds);
  }
  if (rotated.kind === "refused") {
    return errorJson(401, "The session could not be refreshed. Sign in again.");
  }
  return json(200, { session: sessionView(rotated.value) });
}

/** POST /v1/auth/logout — revoke the calling device's session (scope=local:
 * its refresh token dies now; other devices stay signed in), then fence the
 * whole session at this edge so none of its access tokens works here from
 * the next request on. Upstream goes FIRST: until Supabase Auth has refused
 * the session, a request racing this one may legitimately re-verify and
 * re-cache the bearer, and only a fence published after that completes is
 * final. A sign-out Supabase Auth could not perform is reported as retryable
 * (503) with nothing evicted, so the app can try again rather than believe
 * it is signed out while the server session lives on. */
async function logoutRoute(request: Request): Promise<Response> {
  const token = bearerOf(request);
  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    return serviceUnavailable("Sign-out", error);
  }
  await response.body?.cancel().catch(() => undefined);
  // 401/403/404 here mean the session is already gone — the outcome the
  // caller wanted. Only a server-side failure is worth reporting.
  if (!response.ok && response.status >= 500) {
    return serviceUnavailable("Sign-out", `status ${response.status}`);
  }
  await fenceRevokedSession(token);
  return noContent();
}

interface ProfileRow {
  id: string;
  email: string | null;
  onboarding_state: string;
  provider: string;
  skill_level: string | null;
  handedness: string | null;
  primary_goal: string | null;
  biggest_problem: string | null;
  focus_checkpoint: string | null;
  first_name: string | null;
  gender: string | null;
}

async function readProfile(user: AuthedUser): Promise<ProfileRow | Response> {
  const select = () =>
    user.db
      .from("profiles")
      .select(
        "id, email, onboarding_state, provider, skill_level, handedness, primary_goal, biggest_problem, focus_checkpoint, first_name, gender",
      )
      .eq("id", user.id)
      .maybeSingle();
  let profile = await select();
  if (!profile.error && !profile.data) {
    // Signup-trigger race is unlikely; one short retry, then fail retryably.
    await new Promise((resolve) => setTimeout(resolve, 400));
    profile = await select();
  }
  if (profile.error || !profile.data) {
    return serviceUnavailable("Your account", profile.error?.message);
  }
  return profile.data as unknown as ProfileRow;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis permits + access state
// ─────────────────────────────────────────────────────────────────────────────

/** Advisory permit lifetime, mirroring services/api PERMIT_LIFETIME_HOURS.
 * Expiry is enforced in three layers: access counting ignores reserved
 * permits older than this window, apply_synced_shot refuses to consume one
 * (access.permit_expired), and an hourly pg_cron sweep releases stragglers
 * (migration 20260831000000) — so the advertised expiresAt is honest. */
const PERMIT_LIFETIME_HOURS = 24;
const PERMIT_COLUMNS = "id, status, outcome, created_at";

interface PermitRow {
  id: string;
  status: string;
  outcome: string | null;
  created_at: string;
}

/** ReservedAnalysisPermit shape (apps/mobile/src/data/api.ts:24-29): id,
 * accessSource, status, expiresAt — plus outcome/reservedAt for parity with
 * services/api. accessSource stays 'free': permits are recorded against the
 * free-rating ledger even for premium members (whose access never depends on
 * that ledger — accessPayload lets premium bypass the free limit);
 * expiresAt derives from created_at + the advisory lifetime. */
function permitView(row: PermitRow) {
  const reservedAtMs = Date.parse(row.created_at);
  return {
    id: row.id,
    accessSource: "free" as const,
    status: row.status,
    outcome: row.outcome,
    reservedAt: new Date(reservedAtMs).toISOString(),
    expiresAt: new Date(reservedAtMs + PERMIT_LIFETIME_HOURS * 3_600_000).toISOString(),
  };
}

/** The RevenueCat entitlement identifiers that grant membership. The app's
 * entitlement is named 'pickle_sensei_pro'; 'premium' is honored as an alias
 * so a rename inside RevenueCat can never silently lock paying users out. */
const PREMIUM_ENTITLEMENT_KEYS = ["pickle_sensei_pro", "premium"] as const;

interface VerifiedBilling {
  premium: boolean;
  /** RevenueCat entitlement identifiers verified active (informational). */
  activeEntitlements: string[];
}

/** Access state (GET /v1/me/access contract; parsed by
 * apps/mobile/src/billing/accessApi.ts parseAccess with strict arithmetic
 * invariants). `used` is derived from real server-side accepted scored shots
 * — counted per SIGN-IN IDENTITY, not per account row (migration
 * 20260902150000: public.free_rating_ledger survives account deletion, so
 * deleting and re-creating the account with the same Apple ID / Google
 * account does not mint two new free ratings); `reserved` from
 * still-reserved, unexpired permits — never invented client state.
 * reserved is clamped to `remaining` so the client invariants
 * (reserved <= remaining, availableToReserve = remaining - reserved) hold
 * even if stale holds linger. premium comes from the server-verified
 * billing_entitlements row (or the just-verified state the billing sync
 * route passes in) and, when active, unlocks rating regardless of the
 * free-rating ledger: canStartRating true, paywallRequired false, and
 * entitlements always includes 'premium' (parseAccess requires
 * premium === entitlements.includes('premium')). */
async function accessPayload(
  user: AuthedUser,
  verifiedBilling?: VerifiedBilling,
): Promise<unknown | Response> {
  // One round trip: the access_state() RPC returns the verified-billing
  // verdict plus both counters in a single query under the user's RLS
  // (migration 20260831000000_scale_and_security.sql). Previously this was
  // three sequential PostgREST calls per access check.
  const stateQ = await user.db.rpc("access_state");
  if (stateQ.error) {
    return serviceUnavailable("Access state", stateQ.error.message);
  }
  const rows = stateQ.data as Array<{
    premium: boolean;
    scored_count: number;
    reserved_count: number;
  }> | null;
  const state = rows?.[0];
  if (!state) {
    return serviceUnavailable("Access state", "access_state returned no row");
  }
  const billing = verifiedBilling ?? {
    premium: Boolean(state.premium),
    activeEntitlements: [],
  };
  const used = Math.min(2, state.scored_count ?? 0);
  const remaining = 2 - used;
  const reserved = Math.min(state.reserved_count ?? 0, remaining);
  const availableToReserve = remaining - reserved;
  const premium = billing.premium;
  const entitlements = premium
    ? ["premium", ...billing.activeEntitlements.filter((name) => name !== "premium")]
    : [];
  const canStartRating = premium || availableToReserve > 0;
  return {
    premium,
    entitlements,
    freeRatings: {
      limit: 2,
      used,
      reserved,
      remaining,
      availableToReserve,
    },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

/** POST /v1/analysis-permits — mirrors apps/mobile/src/data/api.ts:121-134
 * (reserve): upsert-by-idempotency-key, respond { permit } (+ access, as
 * services/api does; the client only reads permit). */
async function reserveAnalysisPermit(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request);
  const idempotencyKey = body.idempotencyKey;
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 128) {
    return codedError(
      400,
      "validation.analysis_permit",
      "idempotencyKey is required (max 128 characters).",
    );
  }

  const respond = async (row: PermitRow): Promise<Response> => {
    const access = await accessPayload(authed);
    if (access instanceof Response) return access;
    return json(200, { permit: permitView(row), access });
  };

  // ONE atomic reserve_analysis_permit RPC (idempotent lookup + lifetime
  // free-limit check + insert, under a per-user advisory lock — migration
  // 20260901000000). This replaces a read-then-insert whose two statements
  // nothing serialized: concurrent reserves carrying DIFFERENT idempotency
  // keys could each observe canStartRating and both insert, taking an account
  // past its two lifetime free ratings. The old 23505 branch only ever
  // covered the same-key retry, which the RPC now handles internally.
  const reserved = await authed.db.rpc("reserve_analysis_permit", {
    p_idempotency_key: idempotencyKey,
  });
  if (reserved.error) {
    return serviceUnavailable("Rating reservation", reserved.error.message);
  }
  const row = (Array.isArray(reserved.data) ? reserved.data[0] : reserved.data) as {
    result: string;
    permit_id: string | null;
    permit_status: string | null;
    permit_outcome: string | null;
    permit_created_at: string | null;
  } | null;
  if (!row) {
    return serviceUnavailable("Rating reservation", "reserve_analysis_permit returned no row");
  }
  if (row.result === "access.paywall_required") {
    return codedError(
      402,
      "access.paywall_required",
      "Both lifetime free ratings have been used or reserved. Membership is required for another rating.",
    );
  }
  if (row.result !== "accepted" || !row.permit_id) {
    return serviceUnavailable("Rating reservation", row.result);
  }
  return respond({
    id: row.permit_id,
    status: row.permit_status,
    outcome: row.permit_outcome,
    created_at: row.permit_created_at,
  } as unknown as PermitRow);
}

/** Outcomes the client may finalize directly (api.ts release():136-147 sends
 * exactly these plus ratingId:null). 'scored' is deliberately NOT accepted
 * here: successful scores are consumed by the shot-sync transaction
 * (api.ts:107-109), never by an unbound finalize call. */
const RELEASABLE_OUTCOMES = new Set([
  "low_confidence",
  "cancelled",
  "failed",
  "unsupported",
  "incorrect_recognition",
]);

/** POST /v1/analysis-permits/:id/finalize — mirrors apps/mobile/src/data/
 * api.ts:136-147. The client ignores the response body; { permit, access }
 * is returned for parity with services/api. */
async function finalizeAnalysisPermitRoute(
  authed: AuthedUser,
  request: Request,
  permitId: string,
): Promise<Response> {
  if (!isUuid(permitId)) {
    return codedError(400, "validation.analysis_permit_finalize", "Permit id must be a UUID.");
  }
  const body = await readBody(request);
  const outcome = body.outcome;
  if (typeof outcome !== "string" || !RELEASABLE_OUTCOMES.has(outcome)) {
    return codedError(
      400,
      "validation.analysis_permit_finalize",
      "outcome must be one of low_confidence|cancelled|failed|unsupported|incorrect_recognition. Scored permits are consumed by POST /v1/shots:sync, never finalized directly.",
    );
  }
  if (body.ratingId !== null && body.ratingId !== undefined) {
    return codedError(
      400,
      "validation.analysis_permit_finalize",
      "ratingId must be null for a released outcome.",
    );
  }

  const found = await authed.db
    .from("analysis_permits")
    .select(PERMIT_COLUMNS)
    .eq("id", permitId)
    .eq("user_id", authed.id)
    .maybeSingle();
  if (found.error) {
    return serviceUnavailable("Rating finalize", found.error.message);
  }
  if (!found.data) {
    return codedError(404, "access.permit_not_found", "Analysis permit not found.");
  }
  const row = found.data as unknown as PermitRow;

  const respond = async (permit: PermitRow): Promise<Response> => {
    const access = await accessPayload(authed);
    if (access instanceof Response) return access;
    return json(200, { permit: permitView(permit), access });
  };

  if (row.status !== "reserved") {
    // Idempotent replay of the same finalize is acknowledged; anything else
    // is a real conflict (mirrors services/api access.permit_already_finalized).
    if (row.outcome === outcome) return respond(row);
    return codedError(
      409,
      "access.permit_already_finalized",
      `Analysis permit was already finalized as ${row.outcome ?? row.status}.`,
    );
  }

  const updated = await authed.db
    .from("analysis_permits")
    .update({ status: "finalized", outcome })
    .eq("id", permitId)
    .eq("user_id", authed.id)
    .eq("status", "reserved")
    .select(PERMIT_COLUMNS)
    .maybeSingle();
  if (updated.error) {
    return serviceUnavailable("Rating finalize", updated.error.message);
  }
  if (!updated.data) {
    // Lost a race with another finalize/sync; report the settled state.
    const settled = await authed.db
      .from("analysis_permits")
      .select(PERMIT_COLUMNS)
      .eq("id", permitId)
      .eq("user_id", authed.id)
      .maybeSingle();
    const settledRow = settled.data as unknown as PermitRow | null;
    if (settledRow && settledRow.outcome === outcome) {
      return respond(settledRow);
    }
    return codedError(
      409,
      "access.permit_already_finalized",
      `Analysis permit was already finalized as ${
        settledRow?.outcome ?? settledRow?.status ?? "unknown"
      }.`,
    );
  }
  return respond(updated.data as unknown as PermitRow);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shot sync
// ─────────────────────────────────────────────────────────────────────────────

const CAMERA_VIEWS = new Set(["side", "rear_oblique"]);
const CHECKPOINT_BANDS = new Set(["green", "yellow", "red", "unscored"]);
const VERSION_VECTOR_KEYS = [
  "appVersion",
  "modelBundleVersion",
  "poseModelVersion",
  "paddleModelVersion",
  "strokeDetectorVersion",
  "phaseModelVersion",
  "scoringModelVersion",
  "shotConfigVersion",
] as const;

interface SyncShot {
  id: string;
  analysisPermitId: string;
  sessionId: string | null;
  shotType: string;
  cameraView: string;
  capturedAt: string;
  startMs: number;
  contactMs: number | null;
  endMs: number;
  overallScore: number | null;
  confidence: number;
  resultKind: "scored" | "low_confidence";
  phases: Array<{
    key: string;
    startMs: number;
    representativeMs: number;
    endMs: number;
    confidence: number;
  }>;
  checkpoints: Array<{
    key: string;
    score: number | null;
    confidence: number;
    band: string;
    direction: string;
    severity: number;
    applicable: boolean;
  }>;
  versionVector: Record<(typeof VERSION_VECTOR_KEYS)[number], string>;
}

/** Millisecond offsets land in Postgres `int` columns (shot_phases, shots). */
const MAX_MS = 2_147_483_647;
const isMs = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_MS;
const isUnit = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Validate one entry of the shots:sync batch against the canonical payload
 * the client builds in apps/mobile/src/data/sync.ts toSyncPayload (lines
 * 31-62; schema packages/api-contracts ShotSyncPayload). Invalid entries are
 * rejected PER SHOT — one bad row never poisons the batch. */
function parseSyncShot(
  value: unknown,
): { shot: SyncShot } | { rejectedCode: string; rejectedMessage: string } {
  const invalid = (message: string) => ({
    rejectedCode: "shot.invalid_payload",
    rejectedMessage: message,
  });
  if (!isRecord(value)) return invalid("Shot payload must be an object.");
  if (!isUuid(value.id)) return invalid("id must be a UUID.");
  if (value.source !== "real") {
    return {
      rejectedCode: "shot.non_real_source",
      rejectedMessage: "Only analyses produced by a real provider may be synced.",
    };
  }
  if (!isUuid(value.analysisPermitId)) {
    return invalid("analysisPermitId must be a UUID.");
  }
  if (value.sessionId !== null && !isUuid(value.sessionId)) {
    return invalid("sessionId must be a UUID or null.");
  }
  if (typeof value.shotType !== "string" || !value.shotType.trim() || value.shotType.length > 64) {
    return invalid("shotType is required (max 64 characters).");
  }
  if (typeof value.cameraView !== "string" || !CAMERA_VIEWS.has(value.cameraView)) {
    return invalid("cameraView must be side|rear_oblique.");
  }
  if (!isIsoDate(value.capturedAt)) {
    return invalid("capturedAt must be an ISO-8601 UTC instant (e.g. 2026-08-31T10:00:00.000Z).");
  }
  const ts = value.timestamps;
  if (
    !isRecord(ts) ||
    !isMs(ts.startMs) ||
    !isMs(ts.endMs) ||
    (ts.contactMs !== null && !isMs(ts.contactMs))
  ) {
    return invalid("timestamps { startMs, contactMs|null, endMs } are required.");
  }
  if (value.resultKind !== "scored" && value.resultKind !== "low_confidence") {
    return invalid("resultKind must be scored|low_confidence.");
  }
  const overallScore = value.overallScore;
  if (value.resultKind === "scored") {
    if (
      typeof overallScore !== "number" ||
      !Number.isFinite(overallScore) ||
      overallScore < 0 ||
      overallScore > 10
    ) {
      return invalid("overallScore (0..10) is required when resultKind=scored.");
    }
  } else if (overallScore !== null) {
    return invalid("overallScore must be null when resultKind=low_confidence.");
  }
  if (!isUnit(value.confidence)) return invalid("confidence must be 0..1.");
  if (!Array.isArray(value.phases)) return invalid("phases must be an array.");
  const phases: SyncShot["phases"] = [];
  if (value.phases.length > 32) return invalid("Too many phases.");
  const phaseKeys = new Set<string>();
  for (const p of value.phases) {
    if (
      !isRecord(p) ||
      typeof p.key !== "string" ||
      !p.key.trim() ||
      p.key.length > 64 ||
      !isMs(p.startMs) ||
      !isMs(p.representativeMs) ||
      !isMs(p.endMs) ||
      !isUnit(p.confidence)
    ) {
      return invalid("Each phase needs key, startMs, representativeMs, endMs, confidence.");
    }
    if (phaseKeys.has(p.key)) return invalid(`Duplicate phase key: ${p.key}.`);
    phaseKeys.add(p.key);
    phases.push({
      key: p.key,
      startMs: p.startMs,
      representativeMs: p.representativeMs,
      endMs: p.endMs,
      confidence: p.confidence,
    });
  }
  if (!Array.isArray(value.checkpoints)) {
    return invalid("checkpoints must be an array.");
  }
  const checkpoints: SyncShot["checkpoints"] = [];
  if (value.checkpoints.length > 64) return invalid("Too many checkpoints.");
  const checkpointKeys = new Set<string>();
  for (const c of value.checkpoints) {
    if (
      !isRecord(c) ||
      typeof c.key !== "string" ||
      !c.key.trim() ||
      c.key.length > 64 ||
      !(
        c.score === null ||
        (typeof c.score === "number" && Number.isFinite(c.score) && c.score >= 0 && c.score <= 100)
      ) ||
      !isUnit(c.confidence) ||
      typeof c.band !== "string" ||
      !CHECKPOINT_BANDS.has(c.band) ||
      typeof c.direction !== "string" ||
      c.direction.length > 64 ||
      !isUnit(c.severity) ||
      typeof c.applicable !== "boolean"
    ) {
      return invalid(
        "Each checkpoint needs key, score|null, confidence, band, direction, severity, applicable.",
      );
    }
    if (checkpointKeys.has(c.key)) {
      return invalid(`Duplicate checkpoint key: ${c.key}.`);
    }
    checkpointKeys.add(c.key);
    checkpoints.push({
      key: c.key,
      score: c.score,
      confidence: c.confidence,
      band: c.band,
      direction: c.direction,
      severity: c.severity,
      applicable: c.applicable,
    });
  }
  const vv = value.versionVector;
  if (!isRecord(vv)) return invalid("versionVector is required.");
  const versionVector = {} as SyncShot["versionVector"];
  for (const key of VERSION_VECTOR_KEYS) {
    const v = vv[key];
    if (typeof v !== "string" || !v.trim() || v.length > 64) {
      return invalid(`versionVector.${key} is required (max 64 characters).`);
    }
    versionVector[key] = v;
  }
  return {
    shot: {
      id: value.id,
      analysisPermitId: value.analysisPermitId,
      sessionId: value.sessionId,
      shotType: value.shotType,
      cameraView: value.cameraView,
      capturedAt: value.capturedAt,
      startMs: ts.startMs,
      contactMs: ts.contactMs as number | null,
      endMs: ts.endMs,
      overallScore: overallScore as number | null,
      confidence: value.confidence,
      resultKind: value.resultKind,
      phases,
      checkpoints,
      versionVector,
    },
  };
}

/** Cache keys for a user's derived read models (rank, progress). Busted on
 * every accepted shot write so cached responses can never go stale. */
const rankCacheKey = (userId: string): string => `rank:${userId}`;
const progressCacheKey = (userId: string): string => `progress:${userId}`;

/** Per-isolate single-flight for cache misses: concurrent requests for the
 * same key share one DB read instead of each re-running it. Every caller
 * gets its own clone because a Response body can be sent only once. */
const inflightBuilds = new Map<string, Promise<Response>>();
function coalesce(key: string, build: () => Promise<Response>): Promise<Response> {
  let pending = inflightBuilds.get(key);
  if (!pending) {
    pending = build().finally(() => {
      inflightBuilds.delete(key);
    });
    inflightBuilds.set(key, pending);
  }
  return pending.then((response) => response.clone());
}

/** PostgREST silently truncates unpaged reads at its max_rows (1000 on the
 * hosted platform); page in that unit until a short page arrives. */
const PAGE_ROWS = 1_000;
const MAX_PAGES = 20;
async function readAllRows(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
  }>,
): Promise<{ rows: Array<Record<string, unknown>> } | { error: string }> {
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const from = index * PAGE_ROWS;
    const result = await page(from, from + PAGE_ROWS - 1);
    if (result.error) return { error: result.error.message };
    const batch = (result.data ?? []) as Array<Record<string, unknown>>;
    rows.push(...batch);
    if (batch.length < PAGE_ROWS) break;
  }
  return { rows };
}

/** Rejection copy per apply_synced_shot status. Statuses map verbatim to the
 * client contract codes; DB detail never reaches the response. */
const SYNC_STATUS_MESSAGES: Record<string, string> = {
  "auth.required": "Sign in again to sync analyses.",
  "access.permit_not_found": "Analysis permit not found.",
  "access.permit_not_reserved": "Analysis permit is no longer reserved.",
  "access.permit_expired": "Analysis permit expired.",
  // Free-limit backstop in apply_synced_shot: the permit was valid but the
  // account is already at its two lifetime scored ratings, so the scored shot
  // is refused rather than recorded as a third free rating.
  "access.paywall_required":
    "Both lifetime free ratings have been used. Membership is required for another rating.",
  "shot.session_not_found": "Session not found or not yours.",
  "shot.id_conflict": "Shot id is already bound to a different user.",
};

/** POST /v1/shots:sync — mirrors apps/mobile/src/data/sync.ts drainOutbox
 * (lines 149-204): responds { acceptedIds, rejected:[{id,code,message}] }.
 * Client-generated UUIDs keep re-syncs idempotent. Each shot is written by
 * ONE atomic apply_synced_shot RPC (shot + phases + checkpoints + permit
 * consumption in a single transaction under the user's RLS — migration
 * 20260831000000), replacing the previous ~7 sequential round trips per shot
 * with compensating deletes. Replays are detected with one batched lookup
 * for the whole request. */
async function syncShots(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request);
  const shotsRaw = body.shots;
  if (!Array.isArray(shotsRaw) || shotsRaw.length < 1 || shotsRaw.length > 200) {
    return codedError(400, "validation.shots_sync", "Body must be { shots: [1..200 entries] }.");
  }

  const acceptedIds: string[] = [];
  const rejected: Array<{ id: string; code: string; message: string }> = [];
  const reject = (id: string, code: string, message: string) =>
    rejected.push({ id, code, message });

  // Validate the whole batch first; malformed entries never cost a query.
  const parsedShots: SyncShot[] = [];
  for (const raw of shotsRaw) {
    const rawId = isRecord(raw) && typeof raw.id === "string" ? raw.id : "unknown";
    const parsed = parseSyncShot(raw);
    if ("rejectedCode" in parsed) {
      reject(rawId, parsed.rejectedCode, parsed.rejectedMessage);
      continue;
    }
    parsedShots.push(parsed.shot);
  }

  // Idempotent replay: rows this user already owns (a prior sync committed
  // them) are acknowledged without rewriting — one batched SELECT for all.
  let replayIds = new Set<string>();
  if (parsedShots.length > 0) {
    const existing = await authed.db
      .from("shots")
      .select("id")
      .eq("user_id", authed.id)
      .in(
        "id",
        parsedShots.map((shot) => shot.id),
      );
    if (existing.error) {
      // Retryable for the whole batch: the outbox keeps every row.
      return serviceUnavailable("Shot sync", existing.error.message);
    }
    replayIds = new Set(((existing.data ?? []) as Array<{ id: string }>).map((row) => row.id));
  }

  let wroteEvidence = false;
  for (const shot of parsedShots) {
    if (replayIds.has(shot.id)) {
      acceptedIds.push(shot.id);
      continue;
    }
    const applied = await authed.db.rpc("apply_synced_shot", {
      shot: {
        id: shot.id,
        analysisPermitId: shot.analysisPermitId,
        sessionId: shot.sessionId,
        shotType: shot.shotType,
        cameraView: shot.cameraView,
        capturedAt: shot.capturedAt,
        startMs: shot.startMs,
        contactMs: shot.contactMs,
        endMs: shot.endMs,
        overallScore: shot.overallScore,
        confidence: shot.confidence,
        resultKind: shot.resultKind,
        phases: shot.phases,
        checkpoints: shot.checkpoints,
        versionVector: shot.versionVector,
      },
    });
    if (applied.error) {
      console.error("[api] shot sync RPC failed:", applied.error.message);
      reject(
        shot.id,
        "shot.write_failed",
        "The analysis could not be saved right now. It stays on this device and will retry.",
      );
      continue;
    }
    const status = String(applied.data ?? "");
    if (status === "accepted") {
      acceptedIds.push(shot.id);
      wroteEvidence = true;
      continue;
    }
    if (status in SYNC_STATUS_MESSAGES) {
      reject(shot.id, status, SYNC_STATUS_MESSAGES[status]);
      continue;
    }
    // shot.write_failed:<SQLSTATE> and anything unexpected: log the status
    // (sanitized to one capped line), reject with the stable code and a
    // generic message.
    console.error("[api] shot sync write failed:", logSafeStatus(status));
    reject(
      shot.id,
      "shot.write_failed",
      "The analysis could not be saved right now. It stays on this device and will retry.",
    );
  }

  if (wroteEvidence) {
    // New scored evidence changes rank + progress; drop their cached copies.
    await cacheDel(rankCacheKey(authed.id), progressCacheKey(authed.id));
  }

  return json(200, { acceptedIds, rejected });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

/** POST /v1/sessions — mirrors apps/mobile/src/data/sync.ts:269-271 (payload
 * built in repository.ts saveSession: { id, mode, shotType, focusCheckpoint,
 * startedAt }). The sessions table stores id + started_at; mode, shotType and
 * focusCheckpoint have no columns and are skipped, not invented (all client
 * modes are practice-type, so kind keeps its 'practice' default). The client
 * discards the response body → 200 {}. */
async function createSession(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request);
  if (!isUuid(body.id) || !isIsoDate(body.startedAt)) {
    return codedError(
      400,
      "validation.session",
      "Body must include id (UUID) and startedAt (ISO).",
    );
  }
  // Idempotent by client UUID — offline reconnect never duplicates.
  const upserted = await authed.db
    .from("sessions")
    .upsert(
      { id: body.id, user_id: authed.id, started_at: body.startedAt },
      { onConflict: "id", ignoreDuplicates: true },
    );
  if (upserted.error) {
    return serviceUnavailable("Session sync", upserted.error.message);
  }
  const owned = await authed.db
    .from("sessions")
    .select("id")
    .eq("id", body.id)
    .eq("user_id", authed.id)
    .maybeSingle();
  if (owned.error) {
    return serviceUnavailable("Session sync", owned.error.message);
  }
  if (!owned.data) {
    return codedError(409, "session.id_conflict", "Session id belongs to another user.");
  }
  return json(200, {});
}

/** POST /v1/sessions/:id/finalize — mirrors apps/mobile/src/data/sync.ts:272
 * (payload is just { id }; body unused, response discarded). Stamps ended_at
 * once (a replay never moves it). */
async function finalizeSession(authed: AuthedUser, sessionId: string): Promise<Response> {
  if (!isUuid(sessionId)) {
    return codedError(400, "validation.session", "Session id must be a UUID.");
  }
  const found = await authed.db
    .from("sessions")
    .select("id, ended_at")
    .eq("id", sessionId)
    .eq("user_id", authed.id)
    .maybeSingle();
  if (found.error) {
    return serviceUnavailable("Session finalize", found.error.message);
  }
  if (!found.data) {
    return codedError(404, "session.not_found", "Session not found.");
  }
  if ((found.data as { ended_at: string | null }).ended_at === null) {
    const updated = await authed.db
      .from("sessions")
      .update({ ended_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("user_id", authed.id);
    if (updated.error) {
      return serviceUnavailable("Session finalize", updated.error.message);
    }
  }
  return json(200, {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Consent ledger
// ─────────────────────────────────────────────────────────────────────────────

const CONSENT_SCOPES = ["video_analysis", "model_training", "evaluation_telemetry"] as const;

interface ConsentRow {
  scope: string;
  action: "grant" | "withdraw";
  consent_version: string | null;
  created_at: string;
}

async function loadConsentRows(authed: AuthedUser): Promise<ConsentRow[] | Response> {
  const rows = await authed.db
    .from("consent_records")
    .select("scope, action, consent_version, created_at")
    .eq("user_id", authed.id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (rows.error) {
    return serviceUnavailable("Consent status", rows.error.message);
  }
  return (rows.data ?? []) as unknown as ConsentRow[];
}

/** Fold the append-only ledger into per-scope status — latest action per
 * scope wins; absence means NOT consented (default always off). Mirrors
 * shared-types deriveConsentStatus and the client parser in apps/mobile/src/
 * account/consentApi.ts parseStatus (lines 54-101): all three scopes are
 * always present, DB actions grant/withdraw map to granted/withdrawn, and
 * subjectPseudonym is null because no pseudonymization system exists in this
 * deployment (the parser accepts null). */
function foldConsentStatus(rows: ConsentRow[]) {
  return {
    subjectPseudonym: null,
    scopes: CONSENT_SCOPES.map((scope) => {
      const last = rows.filter((r) => r.scope === scope).at(-1) ?? null;
      return {
        scope,
        active: last?.action === "grant",
        consentVersion: last?.consent_version ?? null,
        lastAction: last === null ? null : last.action === "grant" ? "granted" : "withdrawn",
        lastActionAt: last?.created_at ?? null,
      };
    }),
  };
}

const consentScopeActive = (rows: ConsentRow[], scope: string): boolean =>
  (rows.filter((r) => r.scope === scope).at(-1) ?? null)?.action === "grant";

/** POST /v1/me/consent/grant — mirrors apps/mobile/src/account/consentApi.ts
 * grant callers (lines 139-151, 170-182): body { scope, consentVersion,
 * source, device, captureMode }; responds with the folded status. */
async function grantConsent(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request);
  const scope = body.scope;
  const consentVersion = body.consentVersion;
  if (typeof scope !== "string" || !(CONSENT_SCOPES as readonly string[]).includes(scope)) {
    return codedError(400, "validation.consent_grant", "Unknown consent scope.");
  }
  if (typeof consentVersion !== "string" || !consentVersion.trim()) {
    return codedError(400, "validation.consent_grant", "consentVersion is required.");
  }
  const inserted = await authed.db.from("consent_records").insert({
    user_id: authed.id,
    scope,
    consent_version: sanitizeUserText(consentVersion, 64),
    action: "grant",
    source: typeof body.source === "string" ? sanitizeUserText(body.source, 64) : null,
    device: typeof body.device === "string" ? sanitizeUserText(body.device, 512) : null,
    capture_mode:
      typeof body.captureMode === "string" ? sanitizeUserText(body.captureMode, 64) : null,
  });
  if (inserted.error) {
    return serviceUnavailable("Consent update", inserted.error.message);
  }
  const rows = await loadConsentRows(authed);
  return rows instanceof Response ? rows : json(200, foldConsentStatus(rows));
}

/** POST /v1/me/consent/withdraw — mirrors consentApi.ts withdraw callers
 * (lines 153-163, 184-194): body { scope, source, device }. The withdrawal
 * row carries forward the version being withdrawn from (or null when the
 * scope was never granted), mirroring services/api. */
async function withdrawConsent(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request);
  const scope = body.scope;
  if (typeof scope !== "string" || !(CONSENT_SCOPES as readonly string[]).includes(scope)) {
    return codedError(400, "validation.consent_withdraw", "Unknown consent scope.");
  }
  const before = await loadConsentRows(authed);
  if (before instanceof Response) return before;
  const latest = before.filter((r) => r.scope === scope).at(-1) ?? null;
  const inserted = await authed.db.from("consent_records").insert({
    user_id: authed.id,
    scope,
    consent_version: latest?.consent_version ?? null,
    action: "withdraw",
    source: typeof body.source === "string" ? sanitizeUserText(body.source, 64) : null,
    device: typeof body.device === "string" ? sanitizeUserText(body.device, 512) : null,
  });
  if (inserted.error) {
    return serviceUnavailable("Consent update", inserted.error.message);
  }
  const rows = await loadConsentRows(authed);
  return rows instanceof Response ? rows : json(200, foldConsentStatus(rows));
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation trials
// ─────────────────────────────────────────────────────────────────────────────

const TRIAL_WRITE_FAILED_MESSAGE =
  "The trial could not be saved right now. It stays on this device and will retry.";

/** POST /v1/me/evaluation/trials — mirrors apps/mobile/src/data/sync.ts
 * drainOutbox trials branch (lines 206-253): body { trials:[…] }, response
 * { acceptedTrialIds, rejected:[{trialId,code,message}] }. Trials are
 * accepted ONLY while evaluation_telemetry consent is active in the SERVER
 * ledger — the client's opinion of its own consent is never trusted. Records
 * are stored verbatim; full schema validation (shared-types
 * validateEvaluationTrial) is a workspace package this Deno function cannot
 * import, so structural checks here are minimal and labeling tools
 * re-validate offline. */
async function uploadEvaluationTrials(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request);
  const trials = body.trials;
  if (!Array.isArray(trials) || trials.length < 1 || trials.length > 200) {
    return codedError(
      400,
      "validation.evaluation_trials",
      "Body must be { trials: [1..200 entries] }.",
    );
  }
  const ledger = await loadConsentRows(authed);
  if (ledger instanceof Response) return ledger;
  if (!consentScopeActive(ledger, "evaluation_telemetry")) {
    return codedError(
      403,
      "evaluation.consent_inactive",
      "evaluation_telemetry consent is not active for this account; trials are not accepted.",
    );
  }

  const acceptedTrialIds: string[] = [];
  const rejected: Array<{ trialId: string; code: string; message: string }> = [];
  for (const trial of trials) {
    const trialId = isRecord(trial) ? trial.trialId : undefined;
    if (!isUuid(trialId)) {
      rejected.push({
        trialId: String(trialId ?? "unknown"),
        code: "evaluation.trial_invalid",
        message: "trialId must be a UUID.",
      });
      continue;
    }
    // Per-trial ceiling (the DB enforces the same limit as a CHECK): one
    // oversized record can never blow up storage or the request budget.
    if (JSON.stringify(trial).length > 250_000) {
      rejected.push({
        trialId,
        code: "evaluation.trial_invalid",
        message: "Trial payload exceeds the 250KB limit.",
      });
      continue;
    }
    // trialId is client-generated and idempotent: a retried upload of the
    // same trial is acknowledged, never duplicated.
    const upserted = await authed.db
      .from("evaluation_trials")
      .upsert(
        { id: trialId, user_id: authed.id, payload: trial },
        { onConflict: "id", ignoreDuplicates: true },
      );
    if (upserted.error) {
      console.error("[api] evaluation trial write failed:", upserted.error.message);
      rejected.push({
        trialId,
        code: "evaluation.trial_write_failed",
        message: TRIAL_WRITE_FAILED_MESSAGE,
      });
      continue;
    }
    const owned = await authed.db
      .from("evaluation_trials")
      .select("id")
      .eq("id", trialId)
      .eq("user_id", authed.id)
      .maybeSingle();
    if (owned.error) {
      console.error("[api] evaluation trial ownership read failed:", owned.error.message);
      rejected.push({
        trialId,
        code: "evaluation.trial_write_failed",
        message: TRIAL_WRITE_FAILED_MESSAGE,
      });
      continue;
    }
    if (!owned.data) {
      rejected.push({
        trialId,
        code: "evaluation.trial_id_conflict",
        message: "This trialId was already recorded for a different subject.",
      });
      continue;
    }
    acceptedTrialIds.push(trialId);
  }
  return json(200, { acceptedTrialIds, rejected });
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis feedback
// ─────────────────────────────────────────────────────────────────────────────

const FEEDBACK_RATINGS = new Set(["accurate", "not_quite"]);
const FEEDBACK_CATEGORIES = new Set([
  "wrong_stroke",
  "wrong_player",
  "contact_looks_wrong",
  "feedback_mismatch",
  "other",
]);

/** POST /v1/analyses/:id/feedback — mirrors apps/mobile/src/data/api.ts
 * submitAnalysisFeedback (lines 155-173): body { rating, category }, response
 * { feedback: { reviewEligible } } (plus row fields for parity with
 * services/api). reviewEligible is DERIVED from the real consent ledger at
 * submission time — an active model_training grant — never a cached client
 * flag. A duplicate submit returns 409 analysis.feedback_exists, which the
 * app's prompt treats as already-done (AnalysisFeedbackPrompt.tsx:54-60). */
async function submitAnalysisFeedback(
  authed: AuthedUser,
  request: Request,
  analysisId: string,
): Promise<Response> {
  if (!isUuid(analysisId)) {
    return codedError(400, "validation.analysis_feedback", "Analysis id must be a UUID.");
  }
  const body = await readBody(request);
  const rating = body.rating;
  const category = body.category ?? null;
  if (typeof rating !== "string" || !FEEDBACK_RATINGS.has(rating)) {
    return codedError(400, "validation.analysis_feedback", "rating must be accurate|not_quite.");
  }
  // Category is required exactly when the answer is not_quite (contract
  // refine in packages/api-contracts AnalysisFeedbackRequest).
  if (
    (rating === "not_quite") !==
    (typeof category === "string" && FEEDBACK_CATEGORIES.has(category))
  ) {
    return codedError(
      400,
      "validation.analysis_feedback",
      "category is required exactly when rating is not_quite.",
    );
  }

  // The analysis identity the client holds is the synced shot row.
  const shot = await authed.db
    .from("shots")
    .select("id")
    .eq("id", analysisId)
    .eq("user_id", authed.id)
    .maybeSingle();
  if (shot.error) {
    return serviceUnavailable("Feedback", shot.error.message);
  }
  if (!shot.data) {
    return codedError(404, "analysis.not_found", "Analysis not found.");
  }

  const ledger = await loadConsentRows(authed);
  if (ledger instanceof Response) return ledger;
  const reviewEligible = consentScopeActive(ledger, "model_training");

  const inserted = await authed.db
    .from("analysis_feedback")
    .insert({
      user_id: authed.id,
      analysis_id: analysisId,
      rating,
      category: rating === "not_quite" ? category : null,
    })
    .select("id, created_at")
    .single();
  if (inserted.error) {
    if (inserted.error.code === "23505") {
      return codedError(
        409,
        "analysis.feedback_exists",
        "Feedback was already recorded for this analysis.",
      );
    }
    return serviceUnavailable("Feedback", inserted.error.message);
  }
  const row = inserted.data as unknown as { id: string; created_at: string };
  return json(201, {
    feedback: {
      id: row.id,
      analysisId,
      rating,
      category: rating === "not_quite" ? category : null,
      reviewEligible,
      createdAt: row.created_at,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Streak from distinct practice days. Port of services/api
 * computePracticeStreak (training/logic.ts): a streak stays current through
 * the end of the day after the last practice. Days here are UTC — the
 * practice_days view localizes to UTC and this deployment stores no user
 * timezone; the app still computes device-local streaks from raw rows. */
function computePracticeStreak(days: string[], today: string) {
  const toDay = (value: string): number | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed) ? Math.floor(parsed / DAY_MS) : null;
  };
  const todayDay = toDay(today)!;
  const uniqueDays = [...new Set(days.map(toDay).filter((d): d is number => d !== null))]
    .filter((d) => d <= todayDay)
    .sort((a, b) => a - b);
  if (uniqueDays.length === 0) {
    return {
      currentDays: 0,
      longestDays: 0,
      practicedToday: false,
      lastPracticeDate: null,
    };
  }
  let longestDays = 1;
  let run = 1;
  for (let i = 1; i < uniqueDays.length; i += 1) {
    if (uniqueDays[i] === uniqueDays[i - 1] + 1) {
      run += 1;
      longestDays = Math.max(longestDays, run);
    } else {
      run = 1;
    }
  }
  const latestDay = uniqueDays[uniqueDays.length - 1];
  let currentDays = 0;
  if (latestDay === todayDay || latestDay === todayDay - 1) {
    currentDays = 1;
    for (let i = uniqueDays.length - 2; i >= 0; i -= 1) {
      if (uniqueDays[i] !== uniqueDays[i + 1] - 1) break;
      currentDays += 1;
    }
  }
  return {
    currentDays,
    longestDays,
    practicedToday: latestDay === todayDay,
    lastPracticeDate: new Date(latestDay * DAY_MS).toISOString().slice(0, 10),
  };
}

/** GET /v1/progress — mirrors apps/mobile/src/progress/api.ts parseProgress
 * (lines 3-131) exactly: series rows use snake_case keys and 0-100 scores
 * (the client divides by 10); streak fields are camelCase. The progress_daily
 * view stores 0-10 scores, so they are ×10 here. improving/needsAttention are
 * honestly EMPTY: no server-side checkpoint trend aggregates exist yet (the
 * shot_checkpoints table has no rollup view) — nothing is fabricated. */
async function getProgress(authed: AuthedUser): Promise<Response> {
  // Short-lived cache: progress only changes when new evidence syncs (which
  // busts this key). The 60s TTL bounds staleness from any other writer.
  const cacheKey = progressCacheKey(authed.id);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    try {
      return json(200, JSON.parse(cached));
    } catch {
      // Fall through to a fresh read.
    }
  }
  return coalesce(cacheKey, () => buildProgress(authed, cacheKey));
}

async function buildProgress(authed: AuthedUser, cacheKey: string): Promise<Response> {
  // Taken before the reads: an accepted sync that busts the key while the
  // build is in flight turns the cacheSetFenced below into a no-op instead of
  // re-caching the pre-sync payload.
  const fence = await cacheFence(cacheKey);
  const [seriesQ, daysQ] = await Promise.all([
    readAllRows((from, to) =>
      authed.db
        .from("progress_daily")
        .select("day, shot_type, scoring_model_version, shot_count, avg_score, best_score")
        .eq("user_id", authed.id)
        .order("day", { ascending: true })
        .order("shot_type", { ascending: true })
        .order("scoring_model_version", { ascending: true })
        .range(from, to),
    ),
    readAllRows((from, to) =>
      authed.db
        .from("practice_days")
        .select("day")
        .eq("user_id", authed.id)
        .order("day", { ascending: true })
        .range(from, to),
    ),
  ]);
  if ("error" in seriesQ) {
    return serviceUnavailable("Progress", seriesQ.error);
  }
  if ("error" in daysQ) {
    return serviceUnavailable("Progress", daysQ.error);
  }

  const series = seriesQ.rows.map((row) => ({
    day: String(row.day),
    shot_type: String(row.shot_type),
    scoring_model_version: String(row.scoring_model_version),
    shot_count: Number(row.shot_count),
    // View scores are 0-10; the contract (and services/api) sends 0-100
    // with one decimal, and the client divides by 10.
    avg_score: Math.round(Number(row.avg_score) * 100) / 10,
    best_score: Math.round(Number(row.best_score) * 100) / 10,
  }));
  const streak = computePracticeStreak(
    daysQ.rows.map((row) => String(row.day)),
    new Date().toISOString().slice(0, 10),
  );
  const payload = { series, improving: [], needsAttention: [], streak };
  await cacheSetFenced(fence, JSON.stringify(payload), 60);
  return json(200, payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// Player rank (personal, not a leaderboard)
// ─────────────────────────────────────────────────────────────────────────────

/** Tier thresholds — MUST stay identical to PLAYER_RANK_TIERS in
 * packages/shared-types/src/playerRank.ts and public.player_rank_tier() in
 * supabase/migrations/20260829150000_player_rank.sql (thresholds unchanged
 * by the averaging-formula migration 20260830120000_production_launch.sql
 * and the form-weighted migration 20260831130000_form_weighted_rank.sql). */
const PLAYER_RANK_TIERS = [
  { key: "bronze", label: "Bronze", minRating: 0 },
  { key: "silver", label: "Silver", minRating: 3.5 },
  { key: "gold", label: "Gold", minRating: 5 },
  { key: "platinum", label: "Platinum", minRating: 6.5 },
  { key: "diamond", label: "Diamond", minRating: 7.5 },
] as const;

function playerRankTierForRating(rating: number): string {
  let current: string = PLAYER_RANK_TIERS[0].key;
  for (const tier of PLAYER_RANK_TIERS) {
    if (rating >= tier.minRating) current = tier.key;
  }
  return current;
}

/** GET /v1/rank — mirrors apps/mobile/src/progress/playerRank.ts
 * parsePlayerRank exactly. The saved row (player_rank_state, maintained by
 * the shots trigger) is authoritative; if it is missing while scored shots
 * exist (e.g. rank migration applied after those shots synced through an
 * older deployment), the same formula is computed inline from the technique
 * view so the endpoint keeps functioning — and the very next shot sync
 * persists the saved row again.
 *
 * Formula (form-weighted v2 — 20260831130000_form_weighted_rank.sql,
 * mirroring packages/shared-types/src/playerRank.ts computePlayerRank):
 *   - technique score = round2 of the linearly recency-weighted average of
 *     the technique's most recent 8 scored analyses (newest ×8 … oldest in
 *     the window ×1) — the player_technique_rating view emits exactly that,
 *     plus sampled_count (rows inside the window, ≤8) and confidence_weight
 *     (min(total scored analyses, 5): evidence-capped rating weight);
 *   - rating = round(Σ(confidence_weight × round(score×100)) /
 *     Σ confidence_weight) / 100 over the per-technique ROUNDED scores —
 *     integer-hundredths math with half-away-from-zero rounding, so the
 *     inline fallback below stays bit-identical to
 *     public.recompute_player_rank.
 * Scores here are 0-10, matching the shots table verbatim (no ×10 legacy
 * scaling on this newer endpoint). */
async function getPlayerRank(authed: AuthedUser): Promise<Response> {
  // Rank only moves when a shot syncs (which busts this key); 60s TTL
  // bounds staleness from any other writer. Both reads run in parallel.
  const cacheKey = rankCacheKey(authed.id);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    try {
      return json(200, JSON.parse(cached));
    } catch {
      // Fall through to a fresh read.
    }
  }
  return coalesce(cacheKey, () => buildPlayerRank(authed, cacheKey));
}

async function buildPlayerRank(authed: AuthedUser, cacheKey: string): Promise<Response> {
  const fence = await cacheFence(cacheKey);
  const [techniquesQ, stateQ] = await Promise.all([
    authed.db
      .from("player_technique_rating")
      .select("shot_type, score, captured_at, sampled_count, confidence_weight")
      .eq("user_id", authed.id)
      .order("shot_type", { ascending: true }),
    authed.db
      .from("player_rank_state")
      .select("rating, tier, technique_count, scored_shot_count, updated_at")
      .eq("user_id", authed.id)
      .maybeSingle(),
  ]);
  if (techniquesQ.error) {
    return serviceUnavailable("Player rank", techniquesQ.error.message);
  }
  // confidence_weight rides along for the inline fallback compute only; the
  // payload rows expose sampled_count but never the weight.
  const techniqueRows = ((techniquesQ.data ?? []) as Array<Record<string, unknown>>)
    .map((row) => ({
      shot_type: String(row.shot_type),
      score: Number(row.score),
      captured_at: String(row.captured_at),
      sampled_count: Number(row.sampled_count),
      confidence_weight: Number(row.confidence_weight),
    }))
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score || (a.shot_type < b.shot_type ? -1 : 1));
  if (techniqueRows.length === 0) {
    // No scored evidence → honestly unranked, never a fabricated Bronze.
    const empty = { rank: null };
    await cacheSetFenced(fence, JSON.stringify(empty), 60);
    return json(200, empty);
  }

  if (stateQ.error) {
    return serviceUnavailable("Player rank", stateQ.error.message);
  }
  const state = stateQ.data as {
    rating: unknown;
    tier: unknown;
    technique_count: unknown;
    scored_shot_count: unknown;
    updated_at: unknown;
  } | null;

  let rating: number;
  let tier: string;
  let scoredShotCount: number | null;
  let updatedAt: string | null;
  if (state && Number.isFinite(Number(state.rating))) {
    rating = Number(state.rating);
    tier = String(state.tier);
    scoredShotCount = Number(state.scored_shot_count);
    updatedAt = String(state.updated_at);
  } else {
    // Same formula as the trigger: the view already returns each technique's
    // form-weighted round2 score; the rating is the confidence-weighted
    // average of those ROUNDED scores in integer hundredths, rounded half
    // away from zero to 2 decimals (Postgres round(numeric)) — so this
    // fallback is bit-identical to public.recompute_player_rank. If a row
    // somehow lacks confidence_weight (older view still deployed), fall back
    // to min(sampled_count, 5) — the two are equal by construction (window
    // 8 ≥ cap 5) — and finally to 1 (a technique row proves ≥1 analysis).
    let confidenceSum = 0;
    let weightedHundredths = 0;
    for (const t of techniqueRows) {
      const confidenceWeight =
        Number.isFinite(t.confidence_weight) && t.confidence_weight >= 1
          ? t.confidence_weight
          : Number.isFinite(t.sampled_count) && t.sampled_count >= 1
            ? Math.min(t.sampled_count, 5)
            : 1;
      confidenceSum += confidenceWeight;
      weightedHundredths += confidenceWeight * Math.round(t.score * 100);
    }
    rating = Math.round(weightedHundredths / confidenceSum) / 100;
    tier = playerRankTierForRating(rating);
    scoredShotCount = null;
    updatedAt = null;
  }

  // Payload technique rows: { shot_type, score, captured_at, sampled_count }
  // — confidence_weight is a compute-only detail, never exposed.
  const techniques = techniqueRows.map(
    ({ confidence_weight: _confidenceWeight, ...technique }) => technique,
  );
  const payload = {
    rank: {
      rating,
      tier,
      techniqueCount: techniques.length,
      scoredShotCount,
      updatedAt,
      techniques,
    },
  };
  await cacheSetFenced(fence, JSON.stringify(payload), 60);
  return json(200, payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved drills
// ─────────────────────────────────────────────────────────────────────────────

const DRILL_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;

/** The catalog swap promised by the fallback comment: drills.ts ships the
 * drill-library-v1 records plus the standard-drill expansion, all PUBLISHED
 * under the Pickle Sensei Training Library byline. Bookmarks for slugs that
 * ever leave the catalog degrade to a placeholder entry rather than breaking
 * the saved list. */
async function savedDrillEntry(slug: string): Promise<{
  id: string;
  slug: string;
  title: string;
  description: string;
  coach_name: string;
  equipment: string[];
  difficulty_min: string | null;
  difficulty_max: string | null;
}> {
  const entry = await drillCatalogEntry(slug);
  if (entry) {
    const { families: _families, validation_state: _state, ...saved } = entry;
    return saved;
  }
  return {
    id: crypto.randomUUID(),
    slug,
    title: slug,
    description:
      "This drill is no longer in the published catalog. Its full instructions are unavailable.",
    coach_name: "Pickle Sensei Training Library",
    equipment: [],
    difficulty_min: null,
    difficulty_max: null,
  };
}

/** GET /v1/catalog/drills — mirrors apps/mobile/src/training/api.ts
 * listCatalogDrills: { items: [...], cursor: null } with q/family filters.
 * Every item carries validation_state PUBLISHED under the Pickle Sensei
 * Training Library byline (see drills.ts for content provenance). */
async function listCatalogDrills(authed: AuthedUser, url: URL): Promise<Response> {
  const items = await searchDrillCatalog({
    q: url.searchParams.get("q") ?? undefined,
    family: url.searchParams.get("family") ?? undefined,
  });
  const saved = await authed.db.from("user_saved_drills").select("slug").eq("user_id", authed.id);
  if (saved.error) {
    return serviceUnavailable("Drill catalog", saved.error.message);
  }
  const savedSlugs = new Set(
    ((saved.data ?? []) as Array<{ slug: string }>).map((row) => row.slug),
  );
  return json(200, {
    items: items.map((item) => ({ ...item, saved: savedSlugs.has(item.slug) })),
    cursor: null,
  });
}

/** GET /v1/catalog/drills/:slug — mirrors training/api.ts getDrill →
 * parseDrillDetail (lines 187-207): { drill: {..., saved}, mappings,
 * instructionalMedia }. mappings are honestly EMPTY (no fault→drill
 * prescription is coach-endorsed). instructionalMedia serves the
 * oEmbed-verified, attributed third-party videos from drillMedia.ts — the
 * client labels them community video, never Pickle Sensei coaching. */
async function getCatalogDrill(authed: AuthedUser, slug: string): Promise<Response> {
  const entry = await drillCatalogEntry(slug);
  if (!entry) {
    return codedError(404, "drill.not_found", "This drill is not in the catalog.");
  }
  const saved = await authed.db
    .from("user_saved_drills")
    .select("slug")
    .eq("user_id", authed.id)
    .eq("slug", slug)
    .maybeSingle();
  if (saved.error) {
    return serviceUnavailable("Drill detail", saved.error.message);
  }
  const { families: _families, validation_state: _state, ...drill } = entry;
  return json(200, {
    drill: { ...drill, saved: Boolean(saved.data) },
    mappings: [],
    instructionalMedia: await drillInstructionalMedia(slug),
  });
}

/** GET /v1/me/saved-drills — mirrors apps/mobile/src/training/api.ts
 * listSavedDrills (lines 405-411): { items: [SavedDrill] }. */
async function listSavedDrills(authed: AuthedUser): Promise<Response> {
  const rows = await authed.db
    .from("user_saved_drills")
    .select("slug, saved_at")
    .eq("user_id", authed.id)
    .order("saved_at", { ascending: false });
  if (rows.error) {
    return serviceUnavailable("Saved drills", rows.error.message);
  }
  const items = await Promise.all(
    ((rows.data ?? []) as Array<Record<string, unknown>>).map(async (row) => ({
      ...(await savedDrillEntry(String(row.slug))),
      saved_at: String(row.saved_at),
    })),
  );
  return json(200, { items });
}

/** PUT /v1/me/saved-drills/:slug — mirrors training/api.ts saveDrill (lines
 * 414-426), which requires { slug, saved: true }. Without a published
 * catalog there is no drill existence check yet (services/api 404s unknown
 * slugs against its drill table); the slug is only shape-validated. */
async function saveDrill(authed: AuthedUser, slug: string): Promise<Response> {
  if (!DRILL_SLUG_RE.test(slug)) {
    return codedError(400, "validation.saved_drill", "Invalid drill slug.");
  }
  const upserted = await authed.db.from("user_saved_drills").upsert(
    { user_id: authed.id, slug },
    {
      onConflict: "user_id,slug",
      ignoreDuplicates: true,
    },
  );
  if (upserted.error) {
    return serviceUnavailable("Drill save", upserted.error.message);
  }
  const row = await authed.db
    .from("user_saved_drills")
    .select("slug, saved_at")
    .eq("user_id", authed.id)
    .eq("slug", slug)
    .maybeSingle();
  if (row.error || !row.data) {
    return serviceUnavailable("Drill save", row.error?.message);
  }
  return json(200, {
    slug,
    saved: true,
    savedAt: String((row.data as { saved_at: string }).saved_at),
  });
}

/** DELETE /v1/me/saved-drills/:slug — mirrors training/api.ts unsaveDrill
 * (lines 427-432): body ignored, request() maps 204 to null → respond 204.
 * Deleting an absent bookmark is a no-op (idempotent). */
async function unsaveDrill(authed: AuthedUser, slug: string): Promise<Response> {
  const deleted = await authed.db
    .from("user_saved_drills")
    .delete()
    .eq("user_id", authed.id)
    .eq("slug", slug);
  if (deleted.error) {
    return serviceUnavailable("Drill unsave", deleted.error.message);
  }
  return noContent();
}

// ─────────────────────────────────────────────────────────────────────────────
// Billing verification (shared by POST /v1/billing/sync and the RevenueCat
// webhook): the entitlement TRUTH is always RevenueCat's REST API — neither
// the client's StoreKit state nor a webhook body is ever trusted directly.
// ─────────────────────────────────────────────────────────────────────────────

interface BillingVerdict {
  premium: boolean;
  productKey: string | null;
  expiresAt: string | null;
  activeEntitlements: string[];
}

/** Fetch + fold the subscriber's entitlements from RevenueCat. Returns null
 * when RevenueCat cannot be reached (callers respond retryably). */
async function verifyRevenueCatSubscriber(appUserId: string): Promise<BillingVerdict | null> {
  const rcKey =
    Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? Deno.env.get("REVENUECAT_PUBLIC_SDK_KEY");
  if (!rcKey) return null;

  // The RevenueCat app_user_id IS the canonical account id (the mobile SDK
  // logs in with the same uuid). GET auto-creates unknown subscribers
  // (200/201), so a user who never purchased still resolves to an honest
  // premium:false — never an error.
  let subscriber: Record<string, unknown> | null = null;
  try {
    const rcResponse = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
      {
        headers: {
          Authorization: `Bearer ${rcKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (rcResponse.ok) {
      const parsed = (await rcResponse.json().catch(() => null)) as unknown;
      subscriber = isRecord(parsed) && isRecord(parsed.subscriber) ? parsed.subscriber : null;
    } else {
      await rcResponse.text().catch(() => undefined);
    }
  } catch {
    subscriber = null;
  }
  if (!subscriber) return null;

  // entitlements is an object map keyed by entitlement identifier. An
  // entitlement is ACTIVE when expires_date is null (lifetime) or parses
  // to a future timestamp; anything else — including malformed shapes —
  // honestly does not grant membership.
  const entitlementMap = isRecord(subscriber.entitlements) ? subscriber.entitlements : {};
  const verdict: BillingVerdict = {
    premium: false,
    productKey: null,
    expiresAt: null,
    activeEntitlements: [],
  };
  for (const name of PREMIUM_ENTITLEMENT_KEYS) {
    const entitlement = entitlementMap[name];
    if (!isRecord(entitlement)) continue;
    const expires = entitlement.expires_date;
    const active =
      expires === null ||
      (typeof expires === "string" &&
        Number.isFinite(Date.parse(expires)) &&
        Date.parse(expires) > Date.now());
    if (!active) continue;
    verdict.activeEntitlements.push(name);
    if (!verdict.premium) {
      // First active entitlement (pickle_sensei_pro preferred) carries
      // the product/expiry the client displays.
      verdict.premium = true;
      verdict.productKey =
        typeof entitlement.product_identifier === "string" ? entitlement.product_identifier : null;
      verdict.expiresAt = typeof expires === "string" ? expires : null;
    }
  }
  return verdict;
}

/** Persist the verified verdict — premium AND not-premium alike, so a lapsed
 * subscription revokes saved access on its next sync. Written with the
 * service-role client: billing_entitlements has no user write policies, so
 * verified paths are the ONLY writers. */
async function persistBillingVerdict(
  userId: string,
  verdict: BillingVerdict,
  verifiedAt: string,
): Promise<string | null> {
  const adminDb = billingAdminDb();
  if (!adminDb) return "service role unavailable";
  const upserted = await adminDb.from("billing_entitlements").upsert(
    {
      user_id: userId,
      premium: verdict.premium,
      product_key: verdict.productKey,
      expires_at: verdict.expiresAt,
      verified_at: verifiedAt,
    },
    { onConflict: "user_id" },
  );
  return upserted.error ? upserted.error.message : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RevenueCat webhook — POST /webhooks/revenuecat (public URL, secret-gated).
//
// Configure in RevenueCat → Project → Integrations → Webhooks with the
// Authorization header set to the exact value of the REVENUECAT_WEBHOOK_AUTH
// secret. Processing NEVER trusts the event payload for entitlement state:
// the event only tells us WHICH subscriber to re-verify against RevenueCat's
// API. A forged request therefore cannot grant premium — at worst it makes
// the server re-check a real subscriber. Events are logged (webhook_events)
// for audit + replay analysis.
// ─────────────────────────────────────────────────────────────────────────────

async function handleRevenueCatWebhook(request: Request): Promise<Response> {
  const secret = Deno.env.get("REVENUECAT_WEBHOOK_AUTH") ?? "";
  if (!secret) {
    // Fail closed: without a configured secret no webhook is accepted.
    return errorJson(503, "Webhook is not configured.");
  }
  const authorization = request.headers.get("Authorization") ?? "";
  if (!constantTimeEqual(authorization, secret)) {
    return errorJson(401, "Invalid webhook credentials.");
  }

  const body = await readBody(request);
  const event = isRecord(body.event) ? body.event : null;
  if (!event) {
    return errorJson(400, "Missing event payload.");
  }
  const eventId = typeof event.id === "string" ? event.id : crypto.randomUUID();
  const eventType = typeof event.type === "string" ? event.type : "unknown";

  // The subscribers to re-verify: app_user_id, falling back to any alias that
  // parses as our canonical uuid. TRANSFER events carry no app_user_id — both
  // sides of the transfer (transferred_from / transferred_to) are re-verified
  // so the source account loses premium as soon as RevenueCat moves it.
  const uuidList = (value: unknown): string[] =>
    Array.isArray(value) ? (value as unknown[]).filter(isUuid) : [];
  const subjectIds = new Set<string>();
  if (isUuid(event.app_user_id)) {
    subjectIds.add(event.app_user_id);
  } else {
    const alias = uuidList(event.aliases)[0];
    if (alias) subjectIds.add(alias);
  }
  for (const id of uuidList(event.transferred_from)) subjectIds.add(id);
  for (const id of uuidList(event.transferred_to)) subjectIds.add(id);
  const appUserId: string | null = subjectIds.values().next().value ?? null;

  const adminDb = billingAdminDb();
  if (!adminDb) {
    return errorJson(503, "Webhook processing is not configured.");
  }

  // The audit row is written only once an event has been handled to
  // completion, so its presence means "already processed": replays are
  // acknowledged without another RevenueCat round trip, while a delivery
  // that failed (503 below) leaves no row and is fully re-processed.
  const seen = await adminDb.from("webhook_events").select("id").eq("id", eventId).maybeSingle();
  if (seen.error) {
    console.error("[api] webhook event lookup failed:", seen.error.message);
  } else if (seen.data) {
    return json(200, { received: true, duplicate: true });
  }
  const logEvent = async () => {
    const logged = await adminDb.from("webhook_events").upsert(
      {
        id: eventId,
        provider: "revenuecat",
        event_type: eventType,
        app_user_id: appUserId,
        payload: body,
      },
      { onConflict: "id", ignoreDuplicates: true },
    );
    if (logged.error) {
      console.error("[api] webhook event log failed:", logged.error.message);
    }
  };

  if (!appUserId) {
    // Nothing to verify (e.g. an anonymous-only subscriber). Acknowledge so
    // RevenueCat stops retrying; the audit row preserves the event.
    await logEvent();
    return json(200, { received: true, verified: false });
  }

  const verdicts: Array<{ userId: string; verdict: BillingVerdict }> = [];
  for (const userId of subjectIds) {
    const verdict = await verifyRevenueCatSubscriber(userId);
    if (!verdict) {
      // RevenueCat unreachable: 503 makes RevenueCat retry with backoff.
      return errorJson(503, "Verification is temporarily unavailable.");
    }
    verdicts.push({ userId, verdict });
  }
  const verifiedAt = new Date().toISOString();
  let verified = true;
  for (const { userId, verdict } of verdicts) {
    const persistError = await persistBillingVerdict(userId, verdict, verifiedAt);
    if (persistError) {
      // A user who has never bootstrapped has no profiles row (FK target); log
      // and acknowledge — their state will be written on first billing sync.
      console.error("[api] webhook verdict persist failed:", persistError);
      verified = false;
    }
  }
  await logEvent();
  return json(200, { received: true, verified });
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-step account deletion.
//
//   POST /v1/me/delete-request { survey? } → { challenge, expiresAt }
//   POST /v1/me/delete-confirm { challenge } → { deleted: true }
//
// The confirm call must present the challenge minted by a SEPARATE prior
// request (min age enforced), so no single call — accidental or scripted —
// can destroy an account. The actual deletion uses the service-role Auth
// admin API; the auth.users → profiles cascade removes every user row
// (shots, sessions, permits, consent, trials, feedback, saved drills,
// billing entitlement, rank state, deletion request itself). Two things
// outlive the account, both disclosed in the privacy policy (legal.ts §7/§8):
// the optional exit survey (account_deletion_feedback, FK ON DELETE SET NULL
// → anonymized, kept) and the free-rating identity ledger
// (free_rating_ledger: SHA-256 of the provider sign-in identifier → lifetime
// scored count, no FK by design, migration 20260902150000), which is what
// stops delete-and-recreate from re-earning the two free ratings.
// ─────────────────────────────────────────────────────────────────────────────

const DELETE_CONFIRM_MIN_AGE_MS = 3_000;

/** Exit-survey vocabularies — mirror apps/mobile/src/account/deletion.ts
 * ACCOUNT_DELETION_REASONS / ACCOUNT_DELETION_WANTED verbatim. The database
 * bounds only the length (20260902000000 + 20260902120000), so these sets
 * are the authority; an unknown reason drops the survey and an unknown
 * "wanted" drops just that answer — never the deletion. */
const DELETION_SURVEY_REASONS = new Set([
  "not_using",
  "not_helpful",
  "scores_inaccurate",
  "technical_issues",
  "too_expensive",
  "privacy",
  "other",
]);
const DELETION_SURVEY_WANTED = new Set([
  "accuracy",
  "price",
  "content",
  "stability",
  "switched",
  "nothing",
]);
const DELETION_SURVEY_DETAILS_MAX = 500;
const DELETION_SURVEY_PLATFORMS = new Set(["ios", "android"]);

interface DeletionSurvey {
  reason: string;
  wanted: string | null;
  details: string | null;
  platform: string | null;
  appVersion: string | null;
}

/** body.survey → validated survey, or null when absent/unusable. Free text
 * is sanitized (control/zero-width/bidi stripped, whitespace collapsed) and
 * capped; an empty remainder is stored as null, not "". */
function parseDeletionSurvey(body: Record<string, unknown>): DeletionSurvey | null {
  const survey = body.survey;
  if (!isRecord(survey)) return null;
  const reason = survey.reason;
  if (typeof reason !== "string" || !DELETION_SURVEY_REASONS.has(reason)) {
    console.warn("[api] delete-request: exit survey ignored (unknown reason)");
    return null;
  }
  const wanted = survey.wanted;
  const details =
    typeof survey.details === "string"
      ? sanitizeUserText(survey.details, DELETION_SURVEY_DETAILS_MAX)
      : "";
  const platform = survey.platform;
  const appVersion =
    typeof survey.appVersion === "string" ? sanitizeUserText(survey.appVersion, 64) : "";
  return {
    reason,
    wanted: typeof wanted === "string" && DELETION_SURVEY_WANTED.has(wanted) ? wanted : null,
    details: details.length > 0 ? details : null,
    platform:
      typeof platform === "string" && DELETION_SURVEY_PLATFORMS.has(platform) ? platform : null,
    appVersion: appVersion.length > 0 ? appVersion : null,
  };
}

/** Best-effort: the survey is our nicety, the deletion is the user's right.
 * Every failure here is logged and swallowed — it must never turn a
 * successful delete-request into an error the app shows. Churn context
 * (tenure, membership, how many reads they got) is stamped from the
 * user's own rows under RLS, so nothing here is client-asserted. */
async function recordDeletionSurvey(authed: AuthedUser, survey: DeletionSurvey): Promise<void> {
  const [stateQ, profileQ] = await Promise.all([
    authed.db.rpc("access_state"),
    authed.db.from("profiles").select("created_at").eq("id", authed.id).maybeSingle(),
  ]);
  const state = (stateQ.data as Array<{ premium: boolean; scored_count: number }> | null)?.[0];
  const createdAt = (profileQ.data as { created_at: string } | null)?.created_at;
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const accountAgeDays = Number.isFinite(createdAtMs)
    ? Math.max(0, Math.floor((Date.now() - createdAtMs) / 86_400_000))
    : null;
  if (stateQ.error || profileQ.error) {
    console.warn(
      "[api] delete-request: survey context partial:",
      stateQ.error?.message ?? profileQ.error?.message,
    );
  }
  const inserted = await authed.db.from("account_deletion_feedback").insert({
    user_id: authed.id,
    reason: survey.reason,
    wanted: survey.wanted,
    details: survey.details,
    provider: authed.provider,
    platform: survey.platform,
    app_version: survey.appVersion,
    account_age_days: accountAgeDays,
    was_premium: state ? Boolean(state.premium) : null,
    scored_count: state && Number.isFinite(state.scored_count) ? state.scored_count : null,
  });
  if (inserted.error) {
    console.error("[api] delete-request: exit survey not recorded:", inserted.error.message);
  }
}

async function requestAccountDeletion(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request);
  const survey = parseDeletionSurvey(body);
  const challenge = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const upserted = await authed.db.from("account_deletion_requests").upsert(
    {
      user_id: authed.id,
      challenge,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    },
    { onConflict: "user_id" },
  );
  if (upserted.error) {
    return serviceUnavailable("Account deletion", upserted.error.message);
  }
  // Only after the challenge is safely minted: a 503 above makes the app
  // retry this whole request, and the survey must not be double-counted.
  if (survey) await recordDeletionSurvey(authed, survey);
  return json(200, { challenge, expiresAt });
}

interface ExternalCredentialRow {
  apple_refresh_token_encrypted: string | null;
  apple_revoked_at: string | null;
  revenuecat_deleted_at: string | null;
}

type AppleDeletionOutcome = "revoked" | "not_applicable" | "manual_action_required";

/** Complete provider-side erasure before removing the Supabase identity. A
 * successful external step is checkpointed in the service-role-only row so a
 * later provider/database failure can be retried safely. */
async function deleteExternalAccounts(
  authed: AuthedUser,
  adminDb: ReturnType<typeof createClient>,
): Promise<AppleDeletionOutcome | Response> {
  const externalQ = await adminDb
    .from("account_external_credentials")
    .select("apple_refresh_token_encrypted, apple_revoked_at, revenuecat_deleted_at")
    .eq("user_id", authed.id)
    .maybeSingle();
  if (externalQ.error) {
    return serviceUnavailable("Account deletion", externalQ.error.message);
  }
  const external = externalQ.data as ExternalCredentialRow | null;
  let appleOutcome: AppleDeletionOutcome = "not_applicable";

  if (authed.provider === "apple") {
    if (external?.apple_revoked_at) {
      appleOutcome = "revoked";
    } else if (external?.apple_refresh_token_encrypted) {
      const config = appleServerConfiguration();
      if (!config) {
        return serviceUnavailable("Account deletion", "Apple server secrets unavailable");
      }
      let revoked = false;
      try {
        const refreshToken = await decryptAppleRefreshToken(
          external.apple_refresh_token_encrypted,
          authed.id,
          config.tokenEncryptionKey,
        );
        await revokeAppleRefreshToken(refreshToken, config);
        revoked = true;
      } catch (error) {
        const detail = error instanceof ExternalAccountError ? error.message : error;
        // Transport failures, Apple 5xx/429 and missing secrets are retried
        // by the client (fail closed: nothing downstream runs). A credential
        // that can never be revoked — ciphertext under a rotated key, a token
        // Apple refuses with 4xx — must not leave the account undeletable:
        // Apple requires deletion to be fulfilled, so it is dropped and the
        // user is directed to Apple's manual authorization controls.
        if (!isPermanentExternalAccountError(error)) {
          return serviceUnavailable("Account deletion", detail);
        }
        console.error(
          `[api] account deletion: Apple credential unrevocable for ${authed.id}:`,
          detail,
        );
      }
      // Checkpoint before RevenueCat so a later failure retries without a
      // second revoke attempt. The capture pair (token + captured_at) is
      // cleared together — the table constrains them to be null together.
      const now = new Date().toISOString();
      const marked = await adminDb
        .from("account_external_credentials")
        .update(
          revoked
            ? { apple_revoked_at: now, updated_at: now }
            : {
                apple_refresh_token_encrypted: null,
                apple_token_captured_at: null,
                updated_at: now,
              },
        )
        .eq("user_id", authed.id);
      if (marked.error) {
        return serviceUnavailable("Account deletion", marked.error.message);
      }
      appleOutcome = revoked ? "revoked" : "manual_action_required";
    } else {
      // Accounts created by an older app build have no stored Apple refresh
      // token. Apple explicitly says deletion must still be fulfilled; the
      // response tells the client to direct that user to Apple's manual
      // Sign in with Apple authorization controls.
      appleOutcome = "manual_action_required";
      console.warn(`[api] account deletion has no Apple revocation token: ${authed.id}`);
    }
  }

  if (!external?.revenuecat_deleted_at) {
    const revenueCatSecret = Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? "";
    try {
      await deleteRevenueCatCustomer(authed.id, revenueCatSecret);
    } catch (error) {
      const detail = error instanceof ExternalAccountError ? error.message : error;
      return serviceUnavailable("Account deletion", detail);
    }
    const now = new Date().toISOString();
    const marked = await adminDb
      .from("account_external_credentials")
      .upsert(
        { user_id: authed.id, revenuecat_deleted_at: now, updated_at: now },
        { onConflict: "user_id" },
      );
    if (marked.error) {
      return serviceUnavailable("Account deletion", marked.error.message);
    }
  }

  return appleOutcome;
}

async function confirmAccountDeletion(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request);
  const challenge = body.challenge;
  if (!isUuid(challenge)) {
    return codedError(
      400,
      "validation.account_deletion",
      "challenge must be the UUID returned by delete-request.",
    );
  }
  const pending = await authed.db
    .from("account_deletion_requests")
    .select("challenge, created_at, expires_at")
    .eq("user_id", authed.id)
    .maybeSingle();
  if (pending.error) {
    return serviceUnavailable("Account deletion", pending.error.message);
  }
  const row = pending.data as {
    challenge: string;
    created_at: string;
    expires_at: string;
  } | null;
  if (!row || row.challenge !== challenge) {
    return codedError(
      403,
      "account.deletion_challenge_invalid",
      "This deletion was not requested, or the confirmation does not match. Start again from Settings.",
    );
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    return codedError(
      403,
      "account.deletion_challenge_expired",
      "The deletion request expired. Start again from Settings.",
    );
  }
  if (Date.now() - Date.parse(row.created_at) < DELETE_CONFIRM_MIN_AGE_MS) {
    return codedError(
      429,
      "account.deletion_too_fast",
      "Please review the confirmation before deleting.",
    );
  }

  const adminDb = billingAdminDb();
  if (!adminDb) {
    return serviceUnavailable("Account deletion", "service role unavailable");
  }
  const appleAuthorizationRevocation = await deleteExternalAccounts(authed, adminDb);
  if (appleAuthorizationRevocation instanceof Response) {
    return appleAuthorizationRevocation;
  }

  const deleted = await adminDb.auth.admin.deleteUser(authed.id);
  const authError = deleted.error as {
    status?: number;
    code?: string;
    error_code?: string;
    message?: string;
  } | null;
  const alreadyDeleted =
    authError?.status === 404 ||
    authError?.code === "user_not_found" ||
    authError?.error_code === "user_not_found";
  if (authError && !alreadyDeleted) {
    return serviceUnavailable("Account deletion", deleted.error.message);
  }

  // Drop this user's cached derived state AND fence the session that just
  // deleted the account, so none of its bearers can keep authenticating (a
  // bearer of another device's session ages out within ≤10 min, and every
  // query behind it hits RLS-empty rows).
  await cacheDel(rankCacheKey(authed.id), progressCacheKey(authed.id));
  await fenceRevokedSession(bearerOf(request));
  console.warn(`[api] account deleted: ${authed.id}`);
  return json(200, { deleted: true, appleAuthorizationRevocation });
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

/** Per-user request budgets by route family. The general budget comfortably
 * covers the app's real chattiness (bootstrap + access + a screenful of GETs)
 * while stopping any single account from monopolizing the backend; writes
 * that fan out to storage or third parties get tighter budgets. */
const ROUTE_LIMITS: Array<{
  match: (method: string, path: string) => boolean;
  scope: string;
  limit: number;
  windowSeconds: number;
}> = [
  {
    match: (m, p) => m === "POST" && p === "/v1/billing/sync",
    scope: "billing_sync",
    limit: 10,
    windowSeconds: 60,
  },
  {
    match: (m, p) => m === "POST" && p === "/v1/shots:sync",
    scope: "shots_sync",
    limit: 30,
    windowSeconds: 60,
  },
  {
    match: (m, p) => m === "POST" && p === "/v1/me/evaluation/trials",
    scope: "trials",
    limit: 12,
    windowSeconds: 60,
  },
  {
    match: (m, p) => m === "POST" && p === "/v1/analysis-permits",
    scope: "permits",
    limit: 30,
    windowSeconds: 60,
  },
  {
    match: (m, p) => m === "POST" && p.startsWith("/v1/me/consent/"),
    scope: "consent",
    limit: 30,
    windowSeconds: 60,
  },
  {
    match: (m, p) => m === "POST" && p === "/v1/me/delete-request",
    scope: "delete_request",
    limit: 3,
    windowSeconds: 3_600,
  },
  {
    match: (m, p) => m === "POST" && p === "/v1/me/delete-confirm",
    scope: "delete_confirm",
    limit: 5,
    windowSeconds: 3_600,
  },
];

const GENERAL_USER_LIMIT = { limit: 240, windowSeconds: 60 };
/** Per-IP budget sized for shared egress (carrier-grade NAT, club Wi-Fi): a
 * handful of players behind one address each get their full user budget. */
const IP_LIMIT = { limit: 1_200, windowSeconds: 60 };
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
/** Refresh is anonymous (authenticated by the body's refresh token) and a
 * healthy device needs it about once per access-token lifetime, so a tight
 * per-IP budget costs real users nothing and starves refresh-token guessing. */
const AUTH_REFRESH_LIMIT = { limit: 30, windowSeconds: 60 };
const PUBLIC_PAGE_LIMIT = { limit: 60, windowSeconds: 60 };
const WEBHOOK_LIMIT = { limit: 240, windowSeconds: 60 };

/** POST /v1/account/bootstrap — the canonical account for a freshly
 * exchanged provider token, plus the Supabase session the app bears and
 * persists from now on. */
async function bootstrapAccount(
  authed: AuthedUser,
  session: SupabaseSessionLike,
  providerSubject: string,
  request: Request,
): Promise<Response> {
  const profile = await readProfile(authed);
  if (profile instanceof Response) return profile;
  if (profile.provider !== authed.provider) {
    await authed.db.from("profiles").update({ provider: authed.provider }).eq("id", authed.id);
  }

  if (authed.provider === "apple") {
    const body = await readBody(request);
    const authorizationCode = body.appleAuthorizationCode;
    const supportsRevocationProtocol = request.headers.get("X-Apple-Revocation-Protocol") === "1";
    const usableAuthorizationCode =
      typeof authorizationCode === "string" &&
      Boolean(authorizationCode.trim()) &&
      authorizationCode.length <= 4_096;
    if (!usableAuthorizationCode) {
      if (supportsRevocationProtocol) {
        return codedError(
          400,
          "auth.apple_authorization_code_required",
          "Apple did not provide the authorization needed to finish secure sign-in. Try again.",
        );
      }
      // Deployment must precede the new mobile build. A pre-protocol build
      // has no authorization code to send, so keep it working and let its
      // eventual deletion use Apple's documented manual-disconnect path.
      console.warn(`[api] legacy Apple bootstrap has no revocation credential: ${authed.id}`);
    } else {
      const config = appleServerConfiguration();
      const adminDb = billingAdminDb();
      if (!config || !adminDb) {
        return serviceUnavailable(
          "Apple sign-in",
          "Apple server secrets or service role unavailable",
        );
      }
      try {
        const grant = await exchangeAppleAuthorizationCode(authorizationCode.trim(), config);
        if (grant.subject !== providerSubject) {
          return codedError(
            401,
            "auth.apple_authorization_mismatch",
            "Apple returned authorization for a different account. Try again.",
          );
        }
        const encrypted = await encryptAppleRefreshToken(
          grant.refreshToken,
          authed.id,
          config.tokenEncryptionKey,
        );
        const now = new Date().toISOString();
        const stored = await adminDb.from("account_external_credentials").upsert(
          {
            user_id: authed.id,
            apple_refresh_token_encrypted: encrypted,
            apple_token_captured_at: now,
            apple_revoked_at: null,
            updated_at: now,
          },
          { onConflict: "user_id" },
        );
        if (stored.error) {
          return serviceUnavailable("Apple sign-in", stored.error.message);
        }
      } catch (error) {
        if (error instanceof ExternalAccountError && error.kind === "invalid_grant") {
          return codedError(
            401,
            "auth.apple_authorization_invalid",
            "Apple could not validate this sign-in authorization. Try again.",
          );
        }
        const detail = error instanceof ExternalAccountError ? error.message : error;
        return serviceUnavailable("Apple sign-in", detail);
      }
    }
  }

  return json(200, {
    user: { id: profile.id, email: profile.email },
    onboardingState: profile.onboarding_state === "complete" ? "complete" : "pending",
    session: sessionView(session),
  });
}

// Every response carries `x-request-id` and every request emits one JSON
// access-log line (`{"evt":"api_request",...}`) so a client-visible failure
// can be matched to the `[api] <context>:` error line logged just before it.
Deno.serve(async (request: Request): Promise<Response> => {
  const requestId = resolveRequestId(request);
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await handleRequest(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) {
      response = errorJson(413, "Request body is too large.");
    } else {
      console.error(`[api] unhandled error (${requestId}):`, error);
      response = errorJson(500, "Something went wrong. Please try again.");
    }
  }
  const code = await errorCodeOf(response);
  emitAccessLog(accessLogEntry(request, response, requestId, startedAt, code));
  return withRequestId(response, requestId);
});

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ip = clientIp(request);
  const isPublicRead = request.method === "GET" || request.method === "HEAD";

  // ── Public, pre-auth routes (matched on the RAW pathname suffix — these
  // paths never contain "/v1/", so the gateway's mount prefix is irrelevant).
  // HEAD is required because App Store Connect and other link validators use
  // it before accepting public listing URLs.
  if (isPublicRead && url.pathname.endsWith("/healthz")) {
    const rl = await enforceRateLimit(
      "healthz",
      ip,
      PUBLIC_PAGE_LIMIT.limit,
      PUBLIC_PAGE_LIMIT.windowSeconds,
    );
    if (!rl.allowed) return rateLimitResponse(rl);
    return json(200, { ok: true });
  }
  if (isPublicRead && url.pathname.endsWith("/support")) {
    const rl = await enforceRateLimit(
      "legal",
      ip,
      PUBLIC_PAGE_LIMIT.limit,
      PUBLIC_PAGE_LIMIT.windowSeconds,
    );
    if (!rl.allowed) return rateLimitResponse(rl);
    return legalTextResponse(SUPPORT_TEXT);
  }
  if (isPublicRead && url.pathname.endsWith("/privacy")) {
    const rl = await enforceRateLimit(
      "legal",
      ip,
      PUBLIC_PAGE_LIMIT.limit,
      PUBLIC_PAGE_LIMIT.windowSeconds,
    );
    if (!rl.allowed) return rateLimitResponse(rl);
    return legalTextResponse(PRIVACY_POLICY_TEXT);
  }
  if (isPublicRead && url.pathname.endsWith("/terms")) {
    const rl = await enforceRateLimit(
      "legal",
      ip,
      PUBLIC_PAGE_LIMIT.limit,
      PUBLIC_PAGE_LIMIT.windowSeconds,
    );
    if (!rl.allowed) return rateLimitResponse(rl);
    return legalTextResponse(TERMS_TEXT);
  }
  if (request.method === "POST" && url.pathname.endsWith("/webhooks/revenuecat")) {
    const rl = await enforceRateLimit(
      "webhook",
      ip,
      WEBHOOK_LIMIT.limit,
      WEBHOOK_LIMIT.windowSeconds,
    );
    if (!rl.allowed) return rateLimitResponse(rl);
    return handleRevenueCatWebhook(request);
  }

  // ── Oversized bodies are refused before any work happens.
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    return errorJson(413, "Request body is too large.");
  }

  // ── Pre-auth limits: a global per-IP budget, plus a much tighter budget
  // for IPs that keep failing authentication (token stuffing / credential
  // probing) — those never even reach Supabase Auth once tripped.
  const ipLimit = await enforceRateLimit("ip", ip, IP_LIMIT.limit, IP_LIMIT.windowSeconds);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit);
  const authFailures = await peekRateLimit(
    "authfail",
    ip,
    AUTH_FAILURE_LIMIT.limit,
    AUTH_FAILURE_LIMIT.windowSeconds,
  );
  if (!authFailures.allowed) return rateLimitResponse(authFailures);

  // The gateway may present the pathname as /functions/v1/api/v1/… or /api/v1/…
  // depending on where it strips the mount prefix — route on everything from
  // the LAST "/v1/" segment onward so both shapes normalize identically (no
  // app route contains an interior "/v1/").
  const v1 = url.pathname.lastIndexOf("/v1/");
  const path = v1 >= 0 ? url.pathname.slice(v1) : url.pathname;
  const route = `${request.method} ${path}`;

  // Atomic INCR on the aligned auth-failure window (peeked above) — never a
  // read-then-write, so concurrent bad bearers cannot under-count.
  const recordAuthFailure = () =>
    enforceRateLimit("authfail", ip, AUTH_FAILURE_LIMIT.limit, AUTH_FAILURE_LIMIT.windowSeconds);

  // ── Session establishment and rotation run BEFORE general authentication:
  // bootstrap is the one route that spends a provider ID token (and mints
  // the session the app persists), and refresh authenticates by the refresh
  // token in its body. Both count toward the per-IP auth-failure budget so
  // token stuffing is throttled exactly like a bad bearer.
  if (route === "POST /v1/account/bootstrap") {
    const exchanged = await authenticateProviderToken(request);
    if (exchanged instanceof Response) {
      if (exchanged.status === 401) await recordAuthFailure();
      return exchanged;
    }
    const userLimit = await enforceRateLimit(
      "user",
      exchanged.authed.id,
      GENERAL_USER_LIMIT.limit,
      GENERAL_USER_LIMIT.windowSeconds,
    );
    if (!userLimit.allowed) return rateLimitResponse(userLimit);
    return bootstrapAccount(
      exchanged.authed,
      exchanged.session,
      exchanged.providerSubject,
      request,
    );
  }
  if (route === "POST /v1/auth/refresh") {
    const rl = await enforceRateLimit(
      "auth_refresh",
      ip,
      AUTH_REFRESH_LIMIT.limit,
      AUTH_REFRESH_LIMIT.windowSeconds,
    );
    if (!rl.allowed) return rateLimitResponse(rl);
    const refreshed = await refreshSessionRoute(request);
    if (refreshed.status === 401) await recordAuthFailure();
    return refreshed;
  }

  const authed = await authenticate(request);
  if (authed instanceof Response) {
    if (authed.status === 401) await recordAuthFailure();
    return authed;
  }

  // ── Per-user budgets: the tightest matching route family wins; everything
  // else shares the general budget.
  const routeLimit = ROUTE_LIMITS.find((entry) => entry.match(request.method, path));
  const userLimit = await enforceRateLimit(
    routeLimit?.scope ?? "user",
    authed.id,
    routeLimit?.limit ?? GENERAL_USER_LIMIT.limit,
    routeLimit?.windowSeconds ?? GENERAL_USER_LIMIT.windowSeconds,
  );
  if (!userLimit.allowed) return rateLimitResponse(userLimit);

  // ── Parameterized routes (an id/slug in the path) are regex-matched first;
  // everything static falls through to the exact-route switch below.
  if (request.method === "POST") {
    let m = /^\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(path);
    if (m) {
      const permitId = decodePathSegment(m[1]);
      if (permitId instanceof Response) return permitId;
      return finalizeAnalysisPermitRoute(authed, request, permitId);
    }
    m = /^\/v1\/sessions\/([^/]+)\/finalize$/.exec(path);
    if (m) {
      const sessionId = decodePathSegment(m[1]);
      if (sessionId instanceof Response) return sessionId;
      return finalizeSession(authed, sessionId);
    }
    m = /^\/v1\/analyses\/([^/]+)\/feedback$/.exec(path);
    if (m) {
      const analysisId = decodePathSegment(m[1]);
      if (analysisId instanceof Response) return analysisId;
      return submitAnalysisFeedback(authed, request, analysisId);
    }
  }
  if (request.method === "PUT" || request.method === "DELETE") {
    const m = /^\/v1\/me\/saved-drills\/([^/]+)$/.exec(path);
    if (m) {
      const slug = decodePathSegment(m[1]);
      if (slug instanceof Response) return slug;
      return request.method === "PUT" ? saveDrill(authed, slug) : unsaveDrill(authed, slug);
    }
  }

  if (request.method === "GET") {
    if (path === "/v1/catalog/drills") {
      return listCatalogDrills(authed, url);
    }
    const m = /^\/v1\/catalog\/drills\/([^/]+)$/.exec(path);
    if (m) {
      const slug = decodePathSegment(m[1]);
      if (slug instanceof Response) return slug;
      return getCatalogDrill(authed, slug);
    }
  }

  switch (route) {
    case "POST /v1/auth/logout":
      return logoutRoute(request);

    case "GET /v1/me": {
      const profile = await readProfile(authed);
      if (profile instanceof Response) return profile;
      return json(200, {
        user: { id: profile.id, email: profile.email },
        onboardingState: profile.onboarding_state === "complete" ? "complete" : "pending",
        profile: {
          skill_level: profile.skill_level,
          handedness: profile.handedness,
          primary_goal: profile.primary_goal,
          biggest_problem: profile.biggest_problem,
          focus_checkpoint: profile.focus_checkpoint,
          first_name: profile.first_name,
          gender: profile.gender,
        },
      });
    }

    case "PUT /v1/me/onboarding": {
      const body = await readBody(request);
      const handedness = body.handedness;
      const skillLevel =
        typeof body.skillLevel === "string" ? sanitizeUserText(body.skillLevel, 200) : "";
      const goal = typeof body.goal === "string" ? sanitizeUserText(body.goal, 200) : "";
      const biggestProblem =
        typeof body.biggestProblem === "string" ? sanitizeUserText(body.biggestProblem, 1_000) : "";
      if (
        !skillLevel ||
        skillLevel.length > 64 ||
        (handedness !== "right" && handedness !== "left") ||
        !goal ||
        goal.length > 64 ||
        !biggestProblem ||
        biggestProblem.length > 256
      ) {
        return errorJson(400, "Invalid onboarding payload.");
      }
      // Optional personal fields: firstName (trimmed, 1-40 chars) and gender
      // (fixed vocabulary). Absent/null means "not stated" — the columns are
      // left untouched; present-but-invalid is rejected, never coerced.
      const firstNameRaw = body.firstName;
      let firstName: string | undefined;
      if (firstNameRaw !== undefined && firstNameRaw !== null) {
        if (typeof firstNameRaw !== "string") {
          return errorJson(400, "Invalid onboarding payload.");
        }
        // Sanitized before storage: control/zero-width/bidi characters are
        // stripped so the stored name is safe to render anywhere (XSS and
        // spoofing defense in depth; clients render via <Text>).
        const cleaned = sanitizeUserText(firstNameRaw, 200);
        if (cleaned.length < 1 || cleaned.length > 40) {
          return errorJson(400, "firstName must be 1-40 characters after trimming.");
        }
        firstName = cleaned;
      }
      const genderRaw = body.gender;
      let gender: string | undefined;
      if (genderRaw !== undefined && genderRaw !== null) {
        if (typeof genderRaw !== "string" || !GENDER_OPTIONS.has(genderRaw)) {
          return errorJson(400, "gender must be one of female|male|nonbinary|prefer_not_to_say.");
        }
        gender = genderRaw;
      }
      const focusSlug = GOAL_FOCUS[goal] ?? "contact_position";
      const patch: Record<string, unknown> = {
        skill_level: skillLevel,
        handedness,
        primary_goal: goal,
        biggest_problem: biggestProblem,
        focus_checkpoint: focusSlug,
        onboarding_state: "complete",
      };
      if (firstName !== undefined) patch.first_name = firstName;
      if (gender !== undefined) patch.gender = gender;
      const updated = await authed.db
        .from("profiles")
        .update(patch)
        .eq("id", authed.id)
        .select(
          "skill_level, handedness, primary_goal, biggest_problem, focus_checkpoint, first_name, gender",
        )
        .maybeSingle();
      if (updated.error || !updated.data) {
        return serviceUnavailable("Your coaching profile", updated.error?.message);
      }
      const saved = updated.data as unknown as {
        skill_level: string | null;
        handedness: string | null;
        primary_goal: string | null;
        biggest_problem: string | null;
        focus_checkpoint: string | null;
        first_name: string | null;
        gender: string | null;
      };
      return json(200, {
        plan: { focusCheckpoint: focusSlug },
        recommendedCheckpoint: focusSlug,
        profile: {
          skill_level: saved.skill_level,
          handedness: saved.handedness,
          primary_goal: saved.primary_goal,
          biggest_problem: saved.biggest_problem,
          focus_checkpoint: saved.focus_checkpoint,
          first_name: saved.first_name,
          gender: saved.gender,
        },
      });
    }

    case "GET /v1/me/access": {
      const payload = await accessPayload(authed);
      return payload instanceof Response ? payload : json(200, payload);
    }

    case "POST /v1/billing/sync": {
      // apps/mobile/src/billing/accessApi.ts syncBilling (lines 187-194)
      // parses { billing, access } and requires billing.premium ===
      // access.premium. Entitlements are verified SERVER-SIDE against
      // RevenueCat's REST API (verifyRevenueCatSubscriber — shared with the
      // webhook) — the client's local StoreKit state is never trusted. The
      // verified verdict is persisted to billing_entitlements so every
      // access computation benefits until the next sync or expiry.
      const rcKey =
        Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? Deno.env.get("REVENUECAT_PUBLIC_SDK_KEY");
      if (!rcKey) {
        return codedError(
          503,
          "billing_unconfigured",
          "Billing verification is not configured on the server.",
        );
      }

      const verdict = await verifyRevenueCatSubscriber(authed.id);
      if (!verdict) {
        return codedError(
          502,
          "billing_unavailable",
          "The billing provider could not be reached to verify membership. Try again shortly.",
        );
      }

      const verifiedAt = new Date().toISOString();
      const persistError = await persistBillingVerdict(authed.id, verdict, verifiedAt);
      if (persistError === "service role unavailable") {
        return codedError(
          503,
          "billing_unconfigured",
          "Billing verification is not configured on the server.",
        );
      }
      if (persistError) {
        return serviceUnavailable("Billing verification", persistError);
      }

      // Build access from the state just verified (not a re-read) so
      // billing.premium === access.premium holds by construction.
      const access = await accessPayload(authed, {
        premium: verdict.premium,
        activeEntitlements: verdict.activeEntitlements,
      });
      if (access instanceof Response) return access;
      return json(200, {
        billing: {
          premium: verdict.premium,
          productKey: verdict.productKey,
          expiresAt: verdict.expiresAt,
          verifiedAt,
        },
        access,
      });
    }

    case "POST /v1/analysis-permits":
      return reserveAnalysisPermit(authed, request);

    case "POST /v1/shots:sync":
      return syncShots(authed, request);

    case "POST /v1/sessions":
      return createSession(authed, request);

    case "POST /v1/me/evaluation/trials":
      return uploadEvaluationTrials(authed, request);

    case "GET /v1/progress":
      return getProgress(authed);

    case "GET /v1/rank":
      return getPlayerRank(authed);

    case "GET /v1/me/consent/status": {
      const rows = await loadConsentRows(authed);
      return rows instanceof Response ? rows : json(200, foldConsentStatus(rows));
    }

    case "POST /v1/me/consent/grant":
      return grantConsent(authed, request);

    case "POST /v1/me/consent/withdraw":
      return withdrawConsent(authed, request);

    case "POST /v1/me/delete-request":
      return requestAccountDeletion(authed, request);

    case "POST /v1/me/delete-confirm":
      return confirmAccountDeletion(authed, request);

    case "GET /v1/me/saved-drills":
      return listSavedDrills(authed);

    // ── Training plans: honest empty states. Plans require published,
    // coach-validated drill content; none exists (0 real coach reviews — the
    // coach gates are frozen shut), so the current plan is null. These are
    // truthful values, not stubs: the moment validated content ships, these
    // grow real backends.
    case "GET /v1/training-plans/current":
      return json(200, { plan: null });

    case "POST /v1/training-plans":
      return json(409, {
        error: {
          code: "training.plan_unavailable",
          message:
            "Training plans require coach-validated drill content, which has not been published yet.",
        },
      });

    default:
      return errorJson(404, `Unknown endpoint: ${route}.`);
  }
}
