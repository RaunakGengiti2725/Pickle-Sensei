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

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.112.4";
import { drillCatalogEntry, searchDrillCatalog } from "./drills.ts";
import { drillInstructionalMedia } from "./drillMedia.ts";
import {
  readChargeableReleaseAdmission,
  readVerifiedReleasePolicy,
  ReleasePolicyError,
  type ChargeableReleaseAdmission,
  type ReleaseIneligibilityReason,
  type VerifiedReleasePolicy,
} from "./releasePolicy.ts";
import {
  CanonicalDigestError,
  canonicalizeOfflineJson,
  digestCanonicalOfflineJson,
  digestOfflineGrantTransport,
} from "./canonicalDigest.ts";
import {
  importOfflineGrantKeyRing,
  OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS,
  offlineGrantClaimsFromIssuance,
  OfflineGrantCryptoError,
  OfflineGrantIssuanceError,
  signOfflineExecutionGrant,
  verifyOfflineExecutionGrant,
  type OfflineGrantKey,
  type OfflineGrantKeyRing,
} from "./offlineSignature.ts";
import {
  OFFLINE_RECONCILIATION_SCHEMA_VERSION,
  validateOfflineReconciliationStatus,
  validateOfflineResultReceiptShape,
  validateOfflineSignedGrantShape,
  type OfflineReleasedArtifacts,
  type OfflineResultReceipt,
  type OfflineSignedExecutionGrant,
} from "../../../packages/shared-types/src/offlineAuthorization.ts";
import {
  cacheDel,
  cacheFence,
  cacheGet,
  cacheGetUnlessRevoked,
  cacheIsRevoked,
  cacheLocalGeneration,
  cacheSet,
  cacheSetFenced,
  L1_READTHROUGH_TTL_SECONDS,
  redisConfigured,
  sha256Hex,
} from "./cache.ts";
import {
  admitAuthCredential,
  chargeAuthFailure,
  chargeMarkedAuthRefusal,
  enforceRateLimit,
  markAuthRefusal,
  rateLimitResponse,
} from "./rateLimit.ts";
import {
  accessLogEntry,
  clientIp,
  constantTimeEqual,
  failureDetail,
  isSupabaseEndpointRequest,
  emitAccessLog,
  errorCodeOf,
  JSON_SECURITY_HEADERS,
  legalTextResponse,
  resolveRequestId,
  sanitizeUserText,
  withBrowserHardening,
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
  revokeAppleRefreshToken,
} from "./externalAccounts.ts";
import {
  AccountDeletionStatusBudget,
  accountDeletionAllowsAppleBootstrap,
  accountDeletionStatusResponse,
  accountDeletionStatusUnavailableResponse,
  beginAccountDeletionOperation,
  confirmAccountDeletionOperation,
  INVENTORY_INCOMPLETE_CODES,
  isAccountDeletionStatusCapability,
  isIntendedAuthUserNotFound,
  isIntendedRevenueCatCustomerNotFound,
  ownerNamespaceSelectColumns,
  postgrestKeysetAfter,
  postgrestKeysetBefore,
  readAccountDeletionResponseBody,
  readOwnerInventory,
  storeAccountAppleCredential,
  type DeletionOperationRpc,
  type InventoryPage,
  type KeysetColumn,
} from "./accountDeletionOperations.ts";

// Publishable key (sb_publishable_…) set via `supabase secrets set
// SB_PUBLISHABLE_KEY=…`, falling back to the platform-injected legacy anon
// key. After signInWithIdToken we hold the USER's own session, and data
// access runs as that user under row-level security. Narrow administrative
// operations (verified billing writes, webhook audit, encrypted Apple-token
// storage, external-deletion checkpoints, and Auth user deletion) use the
// platform-injected service-role key through billingAdminDb below. The client
// has no write policy to any of those server-owned records.
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = Deno.env.get("SB_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_AUTH_SECRET_KEY = ((key) => (key.startsWith("sb_secret_") ? key : null))(
  Deno.env.get("SB_SECRET_KEY") ?? "",
);

/** Service-role client for verified billing/webhook writes, encrypted Apple
 * revocation-token storage, retry-safe external-deletion checkpoints, and
 * Auth admin deleteUser. Lazy so unrelated routes do not depend on the key. */
let billingAdminClient: SupabaseClient | null = null;
function billingAdminDb(): SupabaseClient | null {
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
 * table names). Only bounded diagnostics are logged for operators; the client
 * gets a stable, generic, retryable message. */
const serviceUnavailable = (
  context: string,
  detail?: unknown,
  options: {
    status?: number;
    operation?: BillingFailureDetail["operation"];
    retryAfterSeconds?: number;
  } = {},
): Response => {
  console.error(`[api] ${context}:`, {
    ...failureDetail(detail, options.status),
    ...(options.operation ? { operation: options.operation } : {}),
  });
  const response = json(503, {
    error: {
      message: `${context} is temporarily unavailable. Please try again.`,
    },
  });
  if (options.retryAfterSeconds !== undefined) {
    response.headers.set("Retry-After", String(options.retryAfterSeconds));
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
const logSafeStatus = (status: string): string =>
  /^shot\.write_failed:(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(status)
    ? sanitizeUserText(status, RPC_STATUS_LOG_MAX)
    : "shot.write_failed:unknown";

/** Largest JSON body any route accepts. Shot batches are ~2 KB per shot ×
 * 200; evaluation trials are the biggest legitimate payload and get the
 * same ceiling (their per-trial cap is enforced separately). */
const MAX_JSON_BODY_BYTES = 5_000_000;
const SMALL_JSON_BODY_BYTES = 65_536;
const WEBHOOK_JSON_BODY_BYTES = 524_288;
const BODY_READ_TIMEOUT_MS = 30_000;
const MAX_REFRESH_TOKEN_LENGTH = 4_096;
const MAX_WEBHOOK_SUBJECTS = 16;

/** Thrown while streaming a body that exceeds MAX_JSON_BODY_BYTES; the
 * outermost handler turns it into a 413 so no route buffers past the cap. */
class RequestBodyTooLarge extends Error {
  constructor() {
    super("Request body is too large.");
    this.name = "RequestBodyTooLarge";
  }
}

class RequestBodyInvalid extends Error {
  constructor(message = "Request body must be a JSON object.") {
    super(message);
    this.name = "RequestBodyInvalid";
  }
}

class RequestBodyTimeout extends Error {
  constructor() {
    super("Request body was not received in time.");
    this.name = "RequestBodyTimeout";
  }
}

/** Read the body as text while counting BYTES on the wire, cancelling the
 * stream the moment it passes the cap (Content-Length is advisory only —
 * chunked uploads carry none). */
async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    void request.body?.cancel().catch(() => undefined);
    throw new RequestBodyTooLarge();
  }
  if (!request.body) {
    if (request.signal.aborted) throw new RequestBodyInvalid("Request body could not be read.");
    return "";
  }
  const reader = request.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    cancelReader();
  }, BODY_READ_TIMEOUT_MS);
  request.signal.addEventListener("abort", cancelReader, { once: true });
  try {
    if (request.signal.aborted) {
      cancelReader();
      throw new RequestBodyInvalid("Request body could not be read.");
    }
    let bytes = new Uint8Array(Math.min(maxBytes, 8_192));
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > maxBytes) {
        cancelReader();
        throw new RequestBodyTooLarge();
      }
      if (received + value.byteLength > bytes.byteLength) {
        const grown = new Uint8Array(
          Math.min(maxBytes, Math.max(bytes.byteLength * 2, received + value.byteLength)),
        );
        grown.set(bytes.subarray(0, received));
        bytes = grown;
      }
      bytes.set(value, received);
      received += value.byteLength;
    }
    if (timedOut) throw new RequestBodyTimeout();
    if (request.signal.aborted) throw new RequestBodyInvalid("Request body could not be read.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, received));
  } catch (error) {
    if (error instanceof RequestBodyTooLarge || error instanceof RequestBodyTimeout) throw error;
    if (timedOut) throw new RequestBodyTimeout();
    throw new RequestBodyInvalid("Request body could not be read.");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

async function readBody(
  request: Request,
  maxBytes = SMALL_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const text = await readBoundedText(request, Math.min(maxBytes, MAX_JSON_BODY_BYTES));
  if (text.trim() === "") return {};
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new RequestBodyInvalid("Request body is not valid JSON.");
  }
  if (!isRecord(body)) throw new RequestBodyInvalid();
  return body;
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
  db: SupabaseClient;
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
      console.warn("[api] session fence not shared (Redis unavailable)");
    }
  }
  await cacheDel(await authCacheKey(token));
}

let databaseRequestKey: { value: string; expiresAtMs: number } | null = null;
let databaseRequestKeyPending: Promise<string> | null = null;

async function getDatabaseRequestKey(): Promise<string> {
  if (databaseRequestKey && databaseRequestKey.expiresAtMs > Date.now()) {
    return databaseRequestKey.value;
  }
  if (databaseRequestKeyPending) return databaseRequestKeyPending;
  databaseRequestKey = null;
  databaseRequestKeyPending = (async () => {
    const admin = billingAdminDb();
    if (!admin) throw new Error("Database authorization is unavailable.");
    const { data, error } = await admin
      .rpc("get_api_request_key")
      .abortSignal(AbortSignal.timeout(5_000));
    if (error || typeof data !== "string" || !/^[0-9a-f]{64}$/.test(data)) {
      throw new Error("Database authorization is unavailable.");
    }
    databaseRequestKey = { value: data, expiresAtMs: Date.now() + 60_000 };
    return data;
  })();
  try {
    return await databaseRequestKeyPending;
  } finally {
    databaseRequestKeyPending = null;
  }
}

const DATABASE_READINESS_TIMEOUT_MS = 2_000;
const DATABASE_READINESS_CACHE_MS = 30_000;
let databaseReadinessResult: { ready: boolean; checkedAtMs: number } | null = null;
let databaseReadinessPending: Promise<boolean> | null = null;

async function databaseReady(): Promise<boolean> {
  const age = databaseReadinessResult ? Date.now() - databaseReadinessResult.checkedAtMs : -1;
  if (databaseReadinessResult && age >= 0 && age < DATABASE_READINESS_CACHE_MS) {
    return databaseReadinessResult.ready;
  }
  if (databaseReadinessPending) return databaseReadinessPending;
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
      resolve(false);
    }, DATABASE_READINESS_TIMEOUT_MS);
  });
  const request = (async (): Promise<boolean> => {
    try {
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!SUPABASE_URL || !serviceRoleKey) return false;
      response = await fetch(
        `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/rpc/get_api_request_key`,
        {
          method: "GET",
          headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
          redirect: "error",
          signal: controller.signal,
        },
      );
      if (
        controller.signal.aborted ||
        response.status !== 200 ||
        response.redirected ||
        response.headers.get("content-type")?.split(";")[0].trim() !== "application/json" ||
        Number(response.headers.get("content-length")) > 128
      ) {
        return false;
      }
      reader = response.body?.getReader();
      if (!reader) return false;
      const bytes = new Uint8Array(128);
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (size + chunk.value.byteLength > bytes.byteLength) return false;
        bytes.set(chunk.value, size);
        size += chunk.value.byteLength;
      }
      const data: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
      return !controller.signal.aborted && typeof data === "string" && /^[0-9a-f]{64}$/.test(data);
    } catch {
      return false;
    } finally {
      void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => undefined);
      reader?.releaseLock();
    }
  })();
  const pending = Promise.race([request, deadline])
    .then((ready) => {
      databaseReadinessResult = { ready, checkedAtMs: Date.now() };
      return ready;
    })
    .finally(() => clearTimeout(timer));
  databaseReadinessPending = pending;
  void request
    .then(() => pending)
    .then(() => {
      if (databaseReadinessPending === pending) databaseReadinessPending = null;
    });
  return pending;
}

function userScopedClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
      fetch: async (input, init) => {
        const outbound = new Request(input, init);
        if (!isSupabaseEndpointRequest(outbound.url, SUPABASE_URL, "rest")) {
          await outbound.body?.cancel().catch(() => undefined);
          throw new Error("Unexpected database request target.");
        }
        const key = await getDatabaseRequestKey();
        outbound.headers.set("Authorization", `Bearer ${accessToken}`);
        outbound.headers.set("apikey", SUPABASE_ANON_KEY);
        outbound.headers.set("x-pickle-api-key", key);
        return fetch(outbound, {
          redirect: "error",
          signal: AbortSignal.any([outbound.signal, AbortSignal.timeout(10_000)]),
        });
      },
    },
  });
}

const AUTH_FETCH_TIMEOUT_MS = 10_000;

async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    const outbound = new Request(input, init);
    if (!isSupabaseEndpointRequest(outbound.url, SUPABASE_URL, "auth")) {
      await outbound.body?.cancel().catch(() => undefined);
      return new Response(null, { status: 503 });
    }
    response = await fetch(outbound, {
      redirect: "error",
      signal: AbortSignal.any([outbound.signal, AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS)]),
    });
  } catch {
    return new Response(null, { status: 503 });
  }
  if (!Number.isInteger(response.status) || response.status === 0 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    return new Response(null, {
      status: response.status >= 500 && response.status <= 599 ? response.status : 503,
    });
  }
  return response;
}

function isRetryableAuthError(error: unknown): boolean {
  if (!isRecord(error)) return true;
  const status = error.status;
  return (
    error.name === "AuthRetryableFetchError" ||
    typeof status !== "number" ||
    !Number.isFinite(status) ||
    status === 0 ||
    status === 429 ||
    status >= 500
  );
}

function authErrorDetail(error: unknown): ReturnType<typeof failureDetail> {
  return failureDetail(error);
}

const IPV4_LITERAL =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function forwardableClientIp(request: Request): string | null {
  const ip = clientIp(request);
  if (IPV4_LITERAL.test(ip)) return ip;
  if (!ip.includes(":") || !/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  try {
    new URL(`http://[${ip}]/`);
    return ip;
  } catch {
    return null;
  }
}

function authApiHeaders(request: Request): Record<string, string> {
  if (!SUPABASE_AUTH_SECRET_KEY) return { apikey: SUPABASE_ANON_KEY };
  const headers: Record<string, string> = { apikey: SUPABASE_AUTH_SECRET_KEY };
  const ip = forwardableClientIp(request);
  if (ip) headers["sb-forwarded-for"] = ip;
  return headers;
}

function anonAuthClient(request: Request): SupabaseClient {
  const { apikey, ...forwarded } = authApiHeaders(request);
  return createClient(SUPABASE_URL, apikey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: authFetch, headers: forwarded },
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
  | { kind: "refused"; status: number; detail: ReturnType<typeof failureDetail>; refusal: unknown }
  | { kind: "unavailable"; detail: ReturnType<typeof failureDetail>; retryAfterSeconds: number };

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
  if (!isRecord(payload) || !validSession(payload)) return null;
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
function authResponseErrorDetail(status: number, body: unknown): ReturnType<typeof failureDetail> {
  return failureDetail(
    {
      name: "AuthApiError",
      code: isRecord(body) ? (body.code ?? body.error_code) : undefined,
    },
    status,
  );
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
  if (signal.aborted) return Promise.resolve();
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
  request: Request,
  path: string,
  init: {
    method: "GET" | "POST";
    bearer?: string;
    body?: Record<string, unknown>;
  },
  parse: (payload: unknown) => T | null,
): Promise<AuthVerdict<T>> {
  const headers: Record<string, string> = {
    ...authApiHeaders(request),
    Accept: "application/json",
  };
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  if (init.body) headers["Content-Type"] = "application/json";
  const timeoutMs = authUpstreamTimeoutMs();
  const startedAt = Date.now();
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new DOMException("Aborted", "AbortError"));
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
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
    detail: failureDetail({
      name: detail.startsWith("no answer within") ? "TimeoutError" : "AuthRetryableFetchError",
    }),
    retryAfterSeconds: AUTH_RETRY_AFTER_SECONDS,
  });
  let httpAnswered = false;
  const attemptOnce = async () => {
    const target = `${SUPABASE_URL}/auth/v1${path}`;
    if (!isSupabaseEndpointRequest(target, SUPABASE_URL, "auth")) {
      throw new TypeError("Unexpected Auth request target.");
    }
    const response = await fetch(target, {
      method: init.method,
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: "error",
      signal: controller.signal,
    });
    httpAnswered = true;
    const answer = {
      status: response.status,
      retryAfter: response.headers.get("Retry-After"),
      text: "",
    };
    if (response.status === 0 || response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      return answer;
    }
    answer.text = await readBoundedText(
      new Request(`${SUPABASE_URL}/auth/v1${path}`, {
        method: "POST",
        body: response.body,
        signal: controller.signal,
      }),
      SMALL_JSON_BODY_BYTES,
    );
    return answer;
  };
  let answer: { status: number; retryAfter: string | null; text: string };
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        answer = await Promise.race([attemptOnce(), deadline]);
        break;
      } catch (error) {
        const message = error instanceof AuthDeadlineError ? error.message : "transport failure";
        if (error instanceof AuthDeadlineError || controller.signal.aborted) {
          return unreachable(attempt === 0 ? message : `${message} (${attempt + 1} attempts)`);
        }
        if (
          httpAnswered ||
          !(error instanceof TypeError) ||
          !/\b(?:connection (?:reset|refused)|dns|econnreset|econnrefused|enotfound)\b/i.test(
            error.message,
          )
        ) {
          return unreachable(message);
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
    request.signal.removeEventListener("abort", onAbort);
  }
  let body: unknown = answer.text;
  try {
    body = JSON.parse(answer.text);
  } catch {
    // Non-JSON body: a verdict status still stands; a 2xx is malformed below.
  }
  if (AUTH_REFUSAL_STATUSES.has(answer.status) && (path !== "/user" || isRecord(body))) {
    return {
      kind: "refused",
      status: answer.status,
      detail: authResponseErrorDetail(answer.status, body),
      refusal: body,
    };
  }
  if (answer.status >= 200 && answer.status < 300) {
    const value = parse(body);
    if (value !== null) return { kind: "ok", value };
    return {
      kind: "unavailable",
      detail: failureDetail({ name: "InvalidSessionResponse" }, answer.status),
      retryAfterSeconds: AUTH_RETRY_AFTER_SECONDS,
    };
  }
  return {
    kind: "unavailable",
    detail: authResponseErrorDetail(answer.status, body),
    retryAfterSeconds: retryAfterOf(answer.retryAfter),
  };
}

/** GET /auth/v1/user — the user behind a Supabase access token, which also
 * fails (refused) once the session was logged out or the account deleted. */
const verifyAccessToken = (
  request: Request,
  accessToken: string,
): Promise<AuthVerdict<AuthUserLike>> =>
  authRequest(request, "/user", { method: "GET", bearer: accessToken }, authUserOf);

/** POST /auth/v1/token?grant_type=refresh_token — rotate a refresh token. */
const rotateRefreshToken = (
  request: Request,
  refreshToken: string,
): Promise<AuthVerdict<SupabaseSessionLike & { user: AuthUserLike }>> =>
  authRequest(
    request,
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
  const signIn = await anonAuthClient(request)
    .auth.signInWithIdToken({ provider, token })
    .catch((error: unknown) => ({ data: { user: null, session: null }, error }));
  if (signIn.error || !signIn.data.user?.id || !signIn.data.session) {
    if (isRetryableAuthError(signIn.error)) {
      return serviceUnavailable("Sign-in verification", authErrorDetail(signIn.error));
    }
    return markAuthRefusal(
      errorJson(401, "The identity token could not be verified."),
      token,
      signIn.error,
    );
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
    const signIn = await anonAuthClient(request)
      .auth.signInWithIdToken({ provider, token })
      .catch((error: unknown) => ({ data: { user: null, session: null }, error }));
    if (signIn.error || !signIn.data.user?.id || !signIn.data.session) {
      if (isRetryableAuthError(signIn.error)) {
        return serviceUnavailable("Sign-in verification", authErrorDetail(signIn.error));
      }
      return markAuthRefusal(
        errorJson(401, "The identity token could not be verified."),
        token,
        signIn.error,
      );
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

  const verified = await verifyAccessToken(request, token);
  if (verified.kind === "unavailable") {
    return serviceUnavailable("Session verification", verified.detail, {
      retryAfterSeconds: verified.retryAfterSeconds,
    });
  }
  if (verified.kind === "refused") {
    return markAuthRefusal(
      errorJson(401, "The session is no longer valid. Sign in again."),
      token,
      verified.refusal,
    );
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

function validSession(value: unknown): value is SupabaseSessionLike {
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    !value.access_token ||
    /\s/.test(value.access_token) ||
    typeof value.refresh_token !== "string" ||
    !value.refresh_token ||
    /\s/.test(value.refresh_token) ||
    value.refresh_token.length > MAX_REFRESH_TOKEN_LENGTH
  )
    return false;
  if (
    value.expires_in !== undefined &&
    (typeof value.expires_in !== "number" ||
      !Number.isSafeInteger(value.expires_in) ||
      value.expires_in <= 0)
  )
    return false;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt =
    value.expires_at === undefined
      ? now + (typeof value.expires_in === "number" ? value.expires_in : Number.NaN)
      : value.expires_at;
  return (
    typeof expiresAt === "number" &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt > now &&
    Number.isFinite(new Date(expiresAt * 1000).getTime())
  );
}

/** POST /v1/auth/refresh — rotate { refreshToken } into a fresh Supabase
 * session. 401 means Supabase Auth REFUSED the refresh token (revoked or
 * already rotated away): the app must sign in again. Anything else — Auth
 * down, rate-limiting us, unreachable, answering nonsense — is 503 with a
 * Retry-After, and the app keeps its session and tries again. */
async function refreshSessionRoute(request: Request): Promise<Response> {
  const body = await readBody(request);
  const refreshToken = body.refreshToken;
  if (
    typeof refreshToken !== "string" ||
    !refreshToken.trim() ||
    refreshToken.length > MAX_REFRESH_TOKEN_LENGTH ||
    isAccountDeletionStatusCapability(refreshToken.trim())
  ) {
    return codedError(400, "validation.refresh", "refreshToken is required.");
  }
  const budget = await admitAuthCredential(clientIp(request), refreshToken, AUTH_FAILURE_LIMIT);
  if (!budget.allowed) return rateLimitResponse(budget);
  const rotated = await rotateRefreshToken(request, refreshToken.trim());
  if (rotated.kind === "unavailable") {
    return serviceUnavailable("Session refresh", rotated.detail, {
      retryAfterSeconds: rotated.retryAfterSeconds,
    });
  }
  if (rotated.kind === "refused") {
    return markAuthRefusal(
      errorJson(401, "The session could not be refreshed. Sign in again."),
      refreshToken,
      rotated.refusal,
    );
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
  const response = await authFetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
    method: "POST",
    headers: { ...authApiHeaders(request), Authorization: `Bearer ${token}` },
    signal: request.signal,
  });
  await response.body?.cancel().catch(() => undefined);
  // 401/403/404 here mean the session is already gone — the outcome the
  // caller wanted. Only a server-side failure is worth reporting.
  if (!response.ok && ![401, 403, 404].includes(response.status)) {
    return serviceUnavailable("Sign-out", authErrorDetail({ status: response.status }));
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
    return serviceUnavailable("Your account", profile.error, { status: profile.status });
  }
  return profile.data as unknown as ProfileRow;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis permits + access state
// ─────────────────────────────────────────────────────────────────────────────

/** Advisory permit lifetime, mirroring services/api PERMIT_LIFETIME_HOURS.
 * The window governs RESERVATION accounting only: access counting ignores
 * reserved permits older than it and an hourly pg_cron sweep releases
 * stragglers as expired (migration 20260831000000), so the advertised
 * expiresAt is honest about when the slot is handed back. It does NOT gate
 * sync: a shot captured against a permit this user reserved is accepted by
 * apply_synced_shot at any age — still reserved or already swept — because
 * the free allowance is enforced by the lifetime-count backstop, not by
 * permit age (migration 20260906130000; the device may be offline for days). */
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
    return serviceUnavailable("Access state", stateQ.error, { status: stateQ.status });
  }
  const rows = stateQ.data as Array<{
    premium: boolean;
    scored_count: number;
    reserved_count: number;
  }> | null;
  const state = rows?.[0];
  if (!state) {
    return serviceUnavailable("Access state", { name: "EmptyResult" }, { status: stateQ.status });
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

/** Release-authority admission for the two chargeable paths — reserving a
 * permit and settling a `scored` shot. Read uncached through the service-role
 * client (read_analysis_release_policy() is EXECUTE-granted to service_role
 * only) so a withdrawal is honoured on the very next request. Without the
 * service-role configuration the authority is unknown, which is never
 * authorization. */
async function chargeableReleaseAdmission(): Promise<ChargeableReleaseAdmission> {
  const admin = billingAdminDb();
  if (!admin) return { status: "unavailable", error: { name: "MissingConfiguration" } };
  return readChargeableReleaseAdmission(
    () => admin.rpc("read_analysis_release_policy"),
    Math.floor(Date.now() / 1000),
  );
}

const RELEASE_NOT_AUTHORIZED_CODE = "access.release_not_authorized";
const RECEIPT_MISMATCH_CODE = "shot.receipt_mismatch";

/** Typed, final, non-chargeable verdict: no active release policy authorizes
 * a validated rating right now. 409 (not 5xx) so the client treats it as a
 * settled answer rather than an outage; `release` carries the shared
 * AnalysisReleaseEligibility shape. */
const releaseNotAuthorized = (reasonCode: ReleaseIneligibilityReason): Response =>
  json(409, {
    error: {
      code: RELEASE_NOT_AUTHORIZED_CODE,
      message: "Validated ratings are not available right now. No rating was counted.",
    },
    release: { status: "ineligible", reasonCode },
  });

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

  // A permit is the admission of a chargeable scored run: without an ACTIVE,
  // non-withdrawn release policy nothing is reserved and nothing is counted.
  const release = await chargeableReleaseAdmission();
  if (release.status === "unavailable") {
    return serviceUnavailable("Rating reservation", release.error);
  }
  if (release.status === "ineligible") {
    return releaseNotAuthorized(release.reasonCode);
  }

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
    return serviceUnavailable("Rating reservation", reserved.error, { status: reserved.status });
  }
  const row = (Array.isArray(reserved.data) ? reserved.data[0] : reserved.data) as {
    result: string;
    permit_id: string | null;
    permit_status: string | null;
    permit_outcome: string | null;
    permit_created_at: string | null;
  } | null;
  if (!row) {
    return serviceUnavailable(
      "Rating reservation",
      { name: "EmptyResult" },
      { status: reserved.status },
    );
  }
  if (row.result === "access.paywall_required") {
    return codedError(
      402,
      "access.paywall_required",
      "Both lifetime free ratings have been used or reserved. Membership is required for another rating.",
    );
  }
  if (row.result !== "accepted" || !row.permit_id) {
    return serviceUnavailable(
      "Rating reservation",
      { name: "UnexpectedResult" },
      { status: reserved.status },
    );
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

// analysis_permits_guard_lifecycle (20260906140000) refuses an illegal permit
// transition with check_violation and this hint; PostgREST relays both.
const PERMIT_TRANSITION_REJECTED = "access.permit_transition_rejected";

function isPermitTransitionRejected(error: { code?: string; hint?: string | null }): boolean {
  return error.code === "23514" && error.hint === PERMIT_TRANSITION_REJECTED;
}

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
    return serviceUnavailable("Rating finalize", found.error, { status: found.status });
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
    if (isPermitTransitionRejected(updated.error)) {
      // The table's lifecycle guard refused the move: the permit is settled
      // and this request cannot change it — a client-side conflict, not an
      // outage.
      return codedError(
        409,
        PERMIT_TRANSITION_REJECTED,
        "Analysis permit is already settled and cannot be finalized again.",
      );
    }
    return serviceUnavailable("Rating finalize", updated.error, { status: updated.status });
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
  resultKind: "scored" | "low_confidence" | "partial";
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

/** Device-side settlement claims presented beside a shot: the installation,
 * offline grant, allocation ticket and operation the client settled under.
 * Each is null when the client holds none — recorded as absent, never
 * fabricated — and every claim it does present must be exactly shaped. */
interface SettlementClaims {
  installationKeyId: string | null;
  grant: { grantId: string; grantJwsSha256: string } | null;
  ticket: { allocationId: string; generation: number; ticketId: string } | null;
  operationId: string | null;
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
):
  | { shot: SyncShot; settlement: SettlementClaims }
  | { rejectedCode: string; rejectedMessage: string } {
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
  if (
    value.resultKind !== "scored" &&
    value.resultKind !== "low_confidence" &&
    value.resultKind !== "partial"
  ) {
    return invalid("resultKind must be scored|low_confidence|partial.");
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
    return invalid("overallScore must be null unless resultKind=scored.");
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
  const settlement = parseSettlementClaims(value.settlement);
  if (!settlement) {
    return invalid(
      "settlement must be omitted or { installationKeyId, grant, ticket, operationId } with each claim null or exactly shaped.",
    );
  }
  return {
    settlement,
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

const CLAIM_ID_RE = /^[A-Za-z0-9._:/+=-]{1,128}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const MAX_TICKET_GENERATION = 999_999_999;
const isClaimId = (value: unknown): value is string =>
  typeof value === "string" && CLAIM_ID_RE.test(value);
const isSha256Hex = (value: unknown): value is string =>
  typeof value === "string" && SHA256_HEX_RE.test(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

/** An omitted `settlement` is the honest "no claims" (every field null). A
 * present one must carry all four claims, each null or exactly shaped —
 * anything else is invalid, never coerced. Returns null when invalid. */
function parseSettlementClaims(value: unknown): SettlementClaims | null {
  if (value === undefined) {
    return { installationKeyId: null, grant: null, ticket: null, operationId: null };
  }
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ["installationKeyId", "grant", "ticket", "operationId"])) return null;
  const { installationKeyId, grant, ticket, operationId } = value;
  if (installationKeyId !== null && !isClaimId(installationKeyId)) return null;
  if (operationId !== null && !isClaimId(operationId)) return null;
  let parsedGrant: SettlementClaims["grant"] = null;
  if (grant !== null) {
    if (
      !isRecord(grant) ||
      !hasExactKeys(grant, ["grantId", "grantJwsSha256"]) ||
      !isClaimId(grant.grantId) ||
      !isSha256Hex(grant.grantJwsSha256)
    ) {
      return null;
    }
    parsedGrant = { grantId: grant.grantId, grantJwsSha256: grant.grantJwsSha256 };
  }
  let parsedTicket: SettlementClaims["ticket"] = null;
  if (ticket !== null) {
    if (
      !isRecord(ticket) ||
      !hasExactKeys(ticket, ["allocationId", "generation", "ticketId"]) ||
      !isClaimId(ticket.allocationId) ||
      !isClaimId(ticket.ticketId) ||
      !Number.isInteger(ticket.generation) ||
      (ticket.generation as number) < 1 ||
      (ticket.generation as number) > MAX_TICKET_GENERATION
    ) {
      return null;
    }
    parsedTicket = {
      allocationId: ticket.allocationId,
      generation: ticket.generation as number,
      ticketId: ticket.ticketId,
    };
  }
  return { installationKeyId, grant: parsedGrant, ticket: parsedTicket, operationId };
}

/** The settlement receipt apply_synced_shot persists beside the shot
 * (migration 20260908110000) and the client receives. `binding` names every
 * identity the settlement rests on plus the RFC 8785 digest of exactly the
 * row payload the RPC writes; `policy` is the lineage of the verified release
 * authority a scored charge was admitted under (null for abstentions, which
 * are never admitted). Transported as canonical bytes + their digest so the
 * RPC and a replay compare bytes, not interpretations. */
interface SettlementBinding {
  ownerId: string;
  shotId: string;
  analysisPermitId: string;
  resultKind: SyncShot["resultKind"];
  installationKeyId: string | null;
  grant: SettlementClaims["grant"];
  ticket: SettlementClaims["ticket"];
  operationId: string | null;
  payloadSha256: string;
}
interface SettlementPolicyLineage {
  version: string;
  sha256: string;
  validFrom: number;
  validUntil: number;
  mechanics: VerifiedReleasePolicy["document"]["mechanics"];
  benchmark: { lineage: VerifiedReleasePolicy["document"]["benchmark"]["lineage"] };
  approval: {
    mechanicsApprovedAt: number | null;
    benchmarkApprovedAt: number | null;
    withdrawnAt: number | null;
    denyNewAuthorizations: boolean;
  };
}
interface SettlementReceipt {
  schemaVersion: 1;
  kind: "settlement_receipt";
  binding: SettlementBinding;
  bindingSha256: string;
  policy: SettlementPolicyLineage | null;
}
interface SettlementReceiptTransport {
  canonical: string;
  sha256: string;
}

function settlementPolicyLineage(policy: VerifiedReleasePolicy): SettlementPolicyLineage {
  const { document, approval } = policy;
  return {
    version: document.version,
    sha256: approval.policy.sha256,
    validFrom: document.validFrom,
    validUntil: document.validUntil,
    mechanics: { lineage: document.mechanics.lineage },
    benchmark: { lineage: document.benchmark.lineage },
    approval: {
      mechanicsApprovedAt: approval.mechanicsApprovedAt,
      benchmarkApprovedAt: approval.benchmarkApprovedAt,
      withdrawnAt: approval.withdrawnAt,
      denyNewAuthorizations: approval.denyNewAuthorizations,
    },
  };
}

async function settlementBinding(
  ownerId: string,
  shot: SyncShot,
  settlement: SettlementClaims,
): Promise<SettlementBinding> {
  return {
    ownerId,
    shotId: shot.id,
    analysisPermitId: shot.analysisPermitId,
    resultKind: shot.resultKind,
    installationKeyId: settlement.installationKeyId,
    grant: settlement.grant,
    ticket: settlement.ticket,
    operationId: settlement.operationId,
    payloadSha256: await digestCanonicalOfflineJson(shot),
  };
}

async function settlementReceiptTransport(
  binding: SettlementBinding,
  policy: SettlementPolicyLineage | null,
): Promise<SettlementReceiptTransport> {
  const receipt: SettlementReceipt = {
    schemaVersion: 1,
    kind: "settlement_receipt",
    binding,
    bindingSha256: await digestCanonicalOfflineJson(binding),
    policy,
  };
  const canonical = canonicalizeOfflineJson(receipt);
  return { canonical, sha256: await sha256Hex(canonical) };
}

/** A stored receipt is trusted only when its bytes are canonical and still
 * hash to the stored digest; anything else is corrupt state (null), which is
 * never a replay match and never fabricated into one. */
async function verifiedStoredReceipt(
  row: Record<string, unknown>,
): Promise<{ transport: SettlementReceiptTransport; binding: string } | null> {
  const canonical = row.receipt_canonical;
  const sha256 = row.receipt_sha256;
  if (typeof canonical !== "string" || !isSha256Hex(sha256)) return null;
  if ((await sha256Hex(canonical)) !== sha256) return null;
  let receipt: unknown;
  try {
    receipt = JSON.parse(canonical);
    if (canonicalizeOfflineJson(receipt) !== canonical) return null;
  } catch {
    return null;
  }
  if (
    !isRecord(receipt) ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "settlement_receipt" ||
    !isRecord(receipt.binding)
  ) {
    return null;
  }
  return { transport: { canonical, sha256 }, binding: canonicalizeOfflineJson(receipt.binding) };
}

/** Cache keys for a user's derived read models (rank, progress). Busted on
 * every accepted shot write so cached responses can never go stale. */
const rankCacheKey = (userId: string): string => `rank:${userId}`;
const progressCacheKey = (userId: string): string => `progress:${userId}`;

/** Per-isolate single-flight for cache misses: concurrent requests for the
 * same key share one DB read instead of each re-running it. Every caller
 * gets its own clone because a Response body can be sent only once. A
 * request that arrives after the key was invalidated (an accepted sync ran
 * cacheDel while a build was in flight) must not join that build: it read
 * the database before the write and would answer with the pre-sync payload,
 * so it starts a fresh build under the new generation. */
interface InflightBuild {
  readonly generation: string;
  readonly response: Promise<Response>;
}
const inflightBuilds = new Map<string, InflightBuild>();
function coalesce(key: string, build: () => Promise<Response>): Promise<Response> {
  const generation = cacheLocalGeneration(key);
  let pending = inflightBuilds.get(key);
  if (!pending || pending.generation !== generation) {
    const entry: InflightBuild = {
      generation,
      response: build().finally(() => {
        if (inflightBuilds.get(key) === entry) inflightBuilds.delete(key);
      }),
    };
    inflightBuilds.set(key, entry);
    pending = entry;
  }
  return pending.response.then((response) => response.clone());
}

/** Owner-wide reads page by keyset over `keyColumns` (the caller's DESCENDING
 * order, unique per owner): `page(before, limit)` reads at most `limit` rows,
 * restricted to the PostgREST `or` filter `before` when it is non-null. The
 * read either proves it reached the end (an empty page after the last row) or
 * fails — a truncated history is never returned as the whole, whatever
 * max_rows the server clamps pages to (see readOwnerInventory). */
async function readAllRows(
  keyColumns: readonly string[],
  page: (before: string | null, limit: number) => PromiseLike<InventoryPage<unknown>>,
): Promise<{ rows: Array<Record<string, unknown>> } | { error: ReturnType<typeof failureDetail> }> {
  const result = await readOwnerInventory<Record<string, unknown>, KeysetColumn[]>({
    readPage: async (cursor, limit) => {
      const { data, error, status } = await page(
        cursor === null ? null : postgrestKeysetBefore(cursor),
        limit,
      );
      return { data: data as Array<Record<string, unknown>> | null, error, status };
    },
    cursorAfter: (row) => postgrestKeysetAfter(row, keyColumns),
    cursorKey: (cursor) => JSON.stringify(cursor.map((part) => part.value)),
  });
  if (result.status === "COMPLETE") return { rows: result.rows };
  return {
    error: failureDetail(
      result.reason === "page_error"
        ? result.error
        : { name: "UnexpectedResult", code: INVENTORY_INCOMPLETE_CODES[result.reason] },
      result.httpStatus ?? undefined,
    ),
  };
}

/** Rejection copy per apply_synced_shot status. Statuses map verbatim to the
 * client contract codes; DB detail never reaches the response. */
const SYNC_STATUS_MESSAGES: Record<string, string> = {
  "auth.required": "Sign in again to sync analyses.",
  "access.permit_not_found": "Analysis permit not found.",
  "access.permit_not_reserved": "Analysis permit is no longer reserved.",
  // Retired by migration 20260906130000 (a late permit backs its shot at any
  // age); kept so an edge deployed ahead of that migration still renders the
  // old RPC's verdict instead of collapsing it into shot.write_failed.
  "access.permit_expired": "Analysis permit expired.",
  // Free-limit backstop in apply_synced_shot: the permit was valid but the
  // account is already at its two lifetime scored ratings, so the scored shot
  // is refused rather than recorded as a third free rating.
  "access.paywall_required":
    "Both lifetime free ratings have been used. Membership is required for another rating.",
  "shot.session_not_found": "Session not found or not yours.",
  "shot.id_conflict": "Shot id is already bound to a different user.",
  // Receipt binding (migration 20260908110000): the same shot id was already
  // settled under a different owner/device/grant/ticket/operation/payload/
  // policy binding, or the receipt presented with a fresh shot is malformed.
  // Neither consumes a credit, a permit or a sequence.
  [RECEIPT_MISMATCH_CODE]:
    "This analysis was already settled with different details. It was not counted again.",
  "shot.receipt_invalid": "The settlement receipt could not be validated. It was not counted.",
  [RELEASE_NOT_AUTHORIZED_CODE]:
    "This rating could not be validated for release. It stays on this device and was not counted.",
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
  const body = await readBody(request, MAX_JSON_BODY_BYTES);
  const shotsRaw = body.shots;
  if (!Array.isArray(shotsRaw) || shotsRaw.length < 1 || shotsRaw.length > 200) {
    return codedError(400, "validation.shots_sync", "Body must be { shots: [1..200 entries] }.");
  }

  const acceptedIds: string[] = [];
  const rejected: Array<{ id: string; code: string; message: string }> = [];
  const receipts: Array<{ id: string } & SettlementReceiptTransport> = [];
  const reject = (id: string, code: string, message: string) =>
    rejected.push({ id, code, message });
  // The one operator sink for a settlement that cannot be trusted: the RPC's
  // unexpected status or a stored receipt that failed verification.
  const rejectWriteFailed = (id: string, status: string, detail: unknown, httpStatus?: number) => {
    console.error(
      "[api] shot sync write failed:",
      logSafeStatus(status),
      failureDetail(detail, httpStatus),
    );
    reject(
      id,
      "shot.write_failed",
      "The analysis could not be saved right now. It stays on this device and will retry.",
    );
  };

  // Validate the whole batch first; malformed entries never cost a query.
  const parsedShots: Array<{ shot: SyncShot; binding: SettlementBinding }> = [];
  for (const raw of shotsRaw) {
    const rawId = isRecord(raw) && typeof raw.id === "string" ? raw.id : "unknown";
    const parsed = parseSyncShot(raw);
    if ("rejectedCode" in parsed) {
      reject(rawId, parsed.rejectedCode, parsed.rejectedMessage);
      continue;
    }
    parsedShots.push({
      shot: parsed.shot,
      binding: await settlementBinding(authed.id, parsed.shot, parsed.settlement),
    });
  }

  // Idempotent replay: rows this user already owns (a prior sync committed
  // them) are acknowledged without rewriting — one batched SELECT for all.
  let replayIds = new Set<string>();
  // Receipt-bound replay (migration 20260908110000): the durable receipt of
  // each owned row decides whether this sync IS that settlement (identical
  // binding → the original receipt is returned, nothing is spent) or a
  // different settlement wearing its id (rejected here, before the authority
  // read and the chargeable RPC). A row settled before receipts existed has
  // none and keeps the ownership verdict. One batched owner-scoped read.
  const storedReceipts = new Map<string, Record<string, unknown>>();
  if (parsedShots.length > 0) {
    const existing = await authed.db
      .from("shots")
      .select("id")
      .eq("user_id", authed.id)
      .in(
        "id",
        parsedShots.map(({ shot }) => shot.id),
      );
    if (existing.error) {
      // Retryable for the whole batch: the outbox keeps every row.
      return serviceUnavailable("Shot sync", existing.error, { status: existing.status });
    }
    replayIds = new Set(((existing.data ?? []) as Array<{ id: string }>).map((row) => row.id));
    const stored = await authed.db
      .from("settlement_receipts")
      .select("shot_id, receipt_canonical, receipt_sha256")
      .eq("user_id", authed.id)
      .in(
        "shot_id",
        parsedShots.map(({ shot }) => shot.id),
      );
    if (stored.error) {
      return serviceUnavailable("Shot sync", stored.error, { status: stored.status });
    }
    for (const row of (stored.data ?? []) as Array<Record<string, unknown>>) {
      if (typeof row.shot_id === "string") storedReceipts.set(row.shot_id, row);
    }
  }
  const pending: Array<{ shot: SyncShot; binding: SettlementBinding }> = [];
  for (const entry of parsedShots) {
    const row = storedReceipts.get(entry.shot.id);
    if (!row) {
      if (replayIds.has(entry.shot.id)) acceptedIds.push(entry.shot.id);
      else pending.push(entry);
      continue;
    }
    const verified = await verifiedStoredReceipt(row);
    if (!verified) {
      // The stored receipt is unreadable or its bytes no longer match their
      // digest: unknown state is neither a replay nor a fresh settlement.
      rejectWriteFailed(entry.shot.id, "shot.write_failed", { name: "DataError" });
      continue;
    }
    if (verified.binding === canonicalizeOfflineJson(entry.binding)) {
      acceptedIds.push(entry.shot.id);
      receipts.push({ id: entry.shot.id, ...verified.transport });
      continue;
    }
    reject(entry.shot.id, RECEIPT_MISMATCH_CODE, SYNC_STATUS_MESSAGES[RECEIPT_MISMATCH_CODE]);
  }

  // Scored settlement is the charge (finalized/scored spends a free rating),
  // so it needs the release authority; abstentions and mechanics-only
  // partials are never chargeable and settle regardless. One uncached read
  // per batch, taken only when a non-replayed scored shot is present. An
  // unreadable authority is retryable for the whole batch (the outbox keeps
  // every row), exactly like the replay lookup above; an ineligible one is a
  // typed per-shot verdict.
  let release: ChargeableReleaseAdmission | null = null;
  if (pending.some(({ shot }) => shot.resultKind === "scored")) {
    release = await chargeableReleaseAdmission();
    if (release.status === "unavailable") {
      return serviceUnavailable("Shot sync", release.error);
    }
  }

  let wroteEvidence = false;
  for (const { shot, binding } of pending) {
    // A scored settlement is admitted under exactly one verified policy and
    // its receipt names that lineage; no active policy is never authorization.
    let policy: SettlementPolicyLineage | null = null;
    if (shot.resultKind === "scored") {
      if (release?.status !== "active") {
        reject(
          shot.id,
          RELEASE_NOT_AUTHORIZED_CODE,
          SYNC_STATUS_MESSAGES[RELEASE_NOT_AUTHORIZED_CODE],
        );
        continue;
      }
      policy = settlementPolicyLineage(release.policy);
    }
    const settlementReceipt = await settlementReceiptTransport(binding, policy);
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
        settlementReceipt,
      },
    });
    if (applied.error) {
      console.error("[api] shot sync RPC failed:", failureDetail(applied.error, applied.status));
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
      receipts.push({ id: shot.id, ...settlementReceipt });
      wroteEvidence = true;
      continue;
    }
    if (status in SYNC_STATUS_MESSAGES) {
      reject(shot.id, status, SYNC_STATUS_MESSAGES[status]);
      continue;
    }
    // shot.write_failed:<detail> and anything unexpected: log only the class,
    // reject with the stable code and a generic message.
    // shot.write_failed:<SQLSTATE> and anything unexpected: log the status
    // (sanitized to one capped line), reject with the stable code and a
    // generic message.
    rejectWriteFailed(shot.id, status, { name: "UnexpectedResult" }, applied.status);
  }

  if (wroteEvidence) {
    // New scored evidence changes rank + progress; drop their cached copies.
    await cacheDel(rankCacheKey(authed.id), progressCacheKey(authed.id));
  }

  // Receipts travel only when a settlement carries one (a receipt-backed
  // acceptance); the acknowledgement shape is otherwise unchanged.
  return json(200, {
    acceptedIds,
    rejected,
    ...(receipts.length > 0 ? { receipts } : {}),
  });
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
    return serviceUnavailable("Session sync", upserted.error, { status: upserted.status });
  }
  const owned = await authed.db
    .from("sessions")
    .select("id")
    .eq("id", body.id)
    .eq("user_id", authed.id)
    .maybeSingle();
  if (owned.error) {
    return serviceUnavailable("Session sync", owned.error, { status: owned.status });
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
    return serviceUnavailable("Session finalize", found.error, { status: found.status });
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
      return serviceUnavailable("Session finalize", updated.error, { status: updated.status });
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
    return serviceUnavailable("Consent status", rows.error, { status: rows.status });
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
    return serviceUnavailable("Consent update", inserted.error, { status: inserted.status });
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
    return serviceUnavailable("Consent update", inserted.error, { status: inserted.status });
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
  const body = await readBody(request, MAX_JSON_BODY_BYTES);
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
      console.error(
        "[api] evaluation trial write failed:",
        failureDetail(upserted.error, upserted.status),
      );
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
      console.error(
        "[api] evaluation trial ownership read failed:",
        failureDetail(owned.error, owned.status),
      );
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
    return serviceUnavailable("Feedback", shot.error, { status: shot.status });
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
    return serviceUnavailable("Feedback", inserted.error, { status: inserted.status });
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
    readAllRows(["day", "shot_type", "scoring_model_version"], (before, limit) => {
      const query = authed.db
        .from("progress_daily")
        .select("day, shot_type, scoring_model_version, shot_count, avg_score, best_score")
        .eq("user_id", authed.id);
      return (before === null ? query : query.or(before))
        .order("day", { ascending: false })
        .order("shot_type", { ascending: false })
        .order("scoring_model_version", { ascending: false })
        .limit(limit);
    }),
    readAllRows(["day"], (before, limit) => {
      const query = authed.db.from("practice_days").select("day").eq("user_id", authed.id);
      return (before === null ? query : query.or(before))
        .order("day", { ascending: false })
        .limit(limit);
    }),
  ]);
  if ("error" in seriesQ) {
    return serviceUnavailable("Progress", seriesQ.error);
  }
  if ("error" in daysQ) {
    return serviceUnavailable("Progress", daysQ.error);
  }

  // Read newest-first (see readAllRows); the contract is chronological.
  const series = seriesQ.rows
    .map((row) => ({
      day: String(row.day),
      shot_type: String(row.shot_type),
      scoring_model_version: String(row.scoring_model_version),
      shot_count: Number(row.shot_count),
      // View scores are 0-10; the contract (and services/api) sends 0-100
      // with one decimal, and the client divides by 10.
      avg_score: Math.round(Number(row.avg_score) * 100) / 10,
      best_score: Math.round(Number(row.best_score) * 100) / 10,
    }))
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.shot_type.localeCompare(b.shot_type) ||
        a.scoring_model_version.localeCompare(b.scoring_model_version),
    );
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
    return serviceUnavailable("Player rank", techniquesQ.error, { status: techniquesQ.status });
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
    return serviceUnavailable("Player rank", stateQ.error, { status: stateQ.status });
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
    return serviceUnavailable("Drill catalog", saved.error, { status: saved.status });
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
    return serviceUnavailable("Drill detail", saved.error, { status: saved.status });
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
    return serviceUnavailable("Saved drills", rows.error, { status: rows.status });
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
  if (!(await drillCatalogEntry(slug))) {
    return codedError(404, "drill.not_found", "This drill is not in the catalog.");
  }
  const upserted = await authed.db.from("user_saved_drills").upsert(
    { user_id: authed.id, slug },
    {
      onConflict: "user_id,slug",
      ignoreDuplicates: true,
    },
  );
  if (upserted.error) {
    return serviceUnavailable("Drill save", upserted.error, { status: upserted.status });
  }
  const row = await authed.db
    .from("user_saved_drills")
    .select("slug, saved_at")
    .eq("user_id", authed.id)
    .eq("slug", slug)
    .maybeSingle();
  if (row.error || !row.data) {
    return serviceUnavailable("Drill save", row.error, { status: row.status });
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
    return serviceUnavailable("Drill unsave", deleted.error, { status: deleted.status });
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
  /** When this verdict was true — RevenueCat's `request_date_ms` (one
   * server clock, so verdicts from different isolates order correctly even
   * when their own clocks disagree) or, when RevenueCat omits it or reports
   * a clock implausibly far from ours (REVENUECAT_CLOCK_MAX_AHEAD_MS /
   * REVENUECAT_CLOCK_MAX_BEHIND_MS), this isolate's clock read BEFORE the
   * round trip. Drives the monotonic verified_at guard on
   * billing_entitlements. */
  verifiedAt: string;
  fulfilment?: BillingFulfilmentVerdict;
}

interface BillingFulfilmentRequest {
  pendingId: string;
  attemptId: string;
  transaction: { productId: string; transactionId: string; purchasedAt: string };
}
interface BillingFulfilmentVerdict extends BillingFulfilmentRequest {
  outcome: "pending" | "fulfilled" | "expired" | "refunded";
  verifiedAt: string;
}

function parseBillingFulfilment(value: unknown): BillingFulfilmentRequest | null {
  if (
    !isRecord(value) ||
    !isUuid(value.pendingId) ||
    !isUuid(value.attemptId) ||
    !isRecord(value.transaction)
  )
    return null;
  const { productId, transactionId, purchasedAt } = value.transaction;
  if (
    typeof productId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(productId) ||
    typeof transactionId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(transactionId) ||
    isoTimestamp(purchasedAt) === null
  )
    return null;
  return {
    pendingId: value.pendingId,
    attemptId: value.attemptId,
    transaction: { productId, transactionId, purchasedAt: isoTimestamp(purchasedAt)! },
  };
}

/** A provider transaction identifier in the form the mobile evidence carries
 * (a string). RevenueCat's v1 customer info reports iOS `store_transaction_id`
 * as a JSON number in places, so a non-negative safe integer is its decimal
 * string; anything else (fractions, unsafe magnitudes, booleans, objects,
 * empty strings) identifies nothing. */
function providerTransactionIdentifier(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/** The identity a RevenueCat transaction record proves. A reported store
 * transaction id is the identity whenever present — a conflicting store id is
 * never overridden by another field. A non-subscription (lifetime) record
 * RevenueCat reports without any store transaction id is identified by
 * RevenueCat's own purchase `id`, which the mobile evidence carries when Apple
 * exposed no transaction id; recurring subscriptions never resolve that way.
 * An unidentified record only ever leaves the purchase pending. */
function providerTransactionIdentity(
  row: Record<string, unknown>,
  nonSubscription: boolean,
): string | null {
  if (row.store_transaction_id !== undefined && row.store_transaction_id !== null)
    return providerTransactionIdentifier(row.store_transaction_id);
  return nonSubscription ? providerTransactionIdentifier(row.id) : null;
}

/** Whether ANY transaction record RevenueCat reports for the subscriber — every
 * product's subscription row and every non-subscription purchase, not only the
 * product the device claims — is identified by `transactionId`. Store
 * transaction ids are unique across a subscriber's products, so a journaled id
 * the provider attributes anywhere else contradicts the device's evidence;
 * only an id present NOWHERE can have been replaced by a renewal. */
function subscriberIdentifiesTransaction(
  subscriber: Record<string, unknown>,
  transactionId: string,
): boolean {
  const subscriptions = isRecord(subscriber.subscriptions) ? subscriber.subscriptions : {};
  for (const row of Object.values(subscriptions)) {
    if (isRecord(row) && providerTransactionIdentity(row, false) === transactionId) return true;
  }
  const purchases = isRecord(subscriber.non_subscriptions) ? subscriber.non_subscriptions : {};
  for (const rows of Object.values(purchases)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (isRecord(row) && providerTransactionIdentity(row, true) === transactionId) return true;
    }
  }
  return false;
}

/** The subscription record whose lineage the journaled purchase belongs to
 * once a LATER transaction replaced it. After a renewal RevenueCat's
 * `subscriptions[product]` row reports the renewal as its latest transaction
 * (`store_transaction_id`, `purchase_date`) while `original_purchase_date`
 * keeps the lineage's first purchase — constant across renewals, a lapse
 * followed by a resubscription and an upgrade inside the subscription group —
 * so the journaled id may be present nowhere in the subscriber. The lineage is
 * proved by the journaled purchase lying within
 * [original_purchase_date, purchase_date) and the latest transaction being a
 * differently identified purchase that has already happened by `checkedAt`. A
 * first purchase after the evidence, a latest purchase that is not later than
 * the evidence or lies ahead of the verification instant, or an unidentified
 * latest transaction is not a renewal. Lifetime records have no lineage. */
function subscriptionLineageRow(
  subscription: unknown,
  transactionId: string,
  purchasedAt: string,
  checkedAt: number,
): Record<string, unknown> | null {
  if (!isRecord(subscription)) return null;
  const purchasedAtMs = Date.parse(purchasedAt);
  const firstPurchase = isoTimestamp(subscription.original_purchase_date);
  if (firstPurchase === null || Date.parse(firstPurchase) > purchasedAtMs) return null;
  const latestPurchase = isoTimestamp(subscription.purchase_date);
  if (latestPurchase === null) return null;
  const latestPurchaseMs = Date.parse(latestPurchase);
  if (latestPurchaseMs <= purchasedAtMs || latestPurchaseMs > checkedAt) return null;
  const latestId = providerTransactionIdentity(subscription, false);
  if (latestId === null || latestId === transactionId) return null;
  return subscription;
}

function billingFulfilmentOf(
  request: BillingFulfilmentRequest,
  subscriber: Record<string, unknown>,
  verdict: BillingVerdict,
): BillingFulfilmentVerdict {
  const result: BillingFulfilmentVerdict = {
    ...request,
    outcome: "pending",
    verifiedAt: verdict.verifiedAt,
  };
  const { productId, transactionId, purchasedAt } = request.transaction;
  const checkedAt = Date.parse(verdict.verifiedAt);
  if (checkedAt < Date.parse(purchasedAt)) return result;
  const subscriptions = isRecord(subscriber.subscriptions) ? subscriber.subscriptions : {};
  const purchases =
    isRecord(subscriber.non_subscriptions) && Array.isArray(subscriber.non_subscriptions[productId])
      ? (subscriber.non_subscriptions[productId] as unknown[])
      : [];
  const candidates = [subscriptions[productId], ...purchases];
  const matching = candidates.filter(
    (row): row is Record<string, unknown> =>
      isRecord(row) &&
      providerTransactionIdentity(row, row !== subscriptions[productId]) === transactionId &&
      isoTimestamp(row.purchase_date) === purchasedAt,
  );
  // Ambiguous absence, product-only matches, RC's own non-subscription `id`, or
  // conflicting transaction records never authorize another purchase.
  if (matching.length > 1) return result;
  // The journaled id is present nowhere in the subscriber: only the claimed
  // product's subscription lineage, headed by a later transaction, can still
  // speak for it. An id the provider attributes to ANY record — this product at
  // another date, or another product altogether — is a conflict, not a renewal.
  const lineage =
    matching.length === 0 && !subscriberIdentifiesTransaction(subscriber, transactionId)
      ? subscriptionLineageRow(subscriptions[productId], transactionId, purchasedAt, checkedAt)
      : null;
  const row = matching[0] ?? lineage;
  if (row === undefined || row === null) return result;
  const activeProduct =
    isRecord(subscriber.entitlements) &&
    verdict.activeEntitlements.some((name) => {
      const entitlement = (subscriber.entitlements as Record<string, unknown>)[name];
      return isRecord(entitlement) && entitlement.product_identifier === productId;
    });
  if (row.refunded_at !== undefined && row.refunded_at !== null) {
    const refund = isoTimestamp(row.refunded_at);
    if (
      !refund ||
      Date.parse(refund) > checkedAt ||
      Date.parse(refund) < Date.parse(purchasedAt) ||
      activeProduct
    )
      return result;
    // A refund recorded on a renewal-headed lineage belongs to whichever
    // transaction RevenueCat refunded, never provably to the journaled one; the
    // journaled purchase settles on the lineage's access state alone.
    if (lineage === null) return { ...result, outcome: "refunded" };
  }
  if (activeProduct) return { ...result, outcome: "fulfilled" };
  // Only an explicitly expired recurring transaction is terminal. A missing
  // lifetime entitlement without a provider refund record remains unresolved.
  if (row !== subscriptions[productId]) return result;
  const expiry = isoTimestamp(row.expires_date);
  const grace = row.grace_period_expires_date;
  if (!expiry || (grace !== null && grace !== undefined && isoTimestamp(grace) === null))
    return result;
  const horizon = Math.max(Date.parse(expiry), grace == null ? 0 : Date.parse(String(grace)));
  // A lineage whose access ended no later than the journaled purchase began
  // never covered that purchase: a contradictory record, not its expiry.
  if (lineage !== null && horizon <= Date.parse(purchasedAt)) return result;
  return horizon <= checkedAt ? { ...result, outcome: "expired" } : result;
}

/** Largest millisecond value `Date` can represent (±100 000 000 days). */
const MAX_EPOCH_MS = 8.64e15;

/** How far AHEAD of this isolate's pre-request clock a RevenueCat
 * `request_date_ms` may sit and still be trusted as the verdict's timestamp.
 * RevenueCat evaluates the subscriber after our pre-request read, so a
 * genuine value exceeds that read only by clock skew between two
 * NTP-disciplined servers (seconds); 5 minutes is the customary allowance.
 * Anything further ahead is not a clock this row can be ordered by — and,
 * because billing_entitlements keeps the NEWEST verified_at, trusting it
 * would make every later real verdict (EXPIRATION, a later sync) lose as
 * "stale" for as long as the bogus value lies in the future: a wedge with
 * no self-heal. Tight bound on purpose. */
const REVENUECAT_CLOCK_MAX_AHEAD_MS = 5 * 60_000;

/** How far BEHIND this isolate's pre-request clock a RevenueCat
 * `request_date_ms` may sit and still be trusted. A value older than this
 * cannot describe the evaluation RevenueCat just performed; trusting it would
 * stamp a fresh verdict older than it is, so a row carrying anything newer
 * would drop it and the truth we just fetched would not land until the next
 * verdict. Unlike the ahead case that is self-limiting (the next sane verdict
 * lands), so the bound only needs to reject values no live clock could
 * produce while keeping every plausibly-skewed answer on RevenueCat's single
 * clock (cross-isolate ordering). 24 hours. */
const REVENUECAT_CLOCK_MAX_BEHIND_MS = 24 * 60 * 60_000;

/** RevenueCat's `request_date_ms` as an ISO timestamp, or null when the
 * response carries none, a value no clock could have produced, or a value
 * implausibly far from the local clock read BEFORE the round trip
 * (`startedAtMs`). Callers fall back to that pre-request clock, which can
 * never outrank a verdict evaluated after this request began. */
function revenueCatRequestDate(
  payload: Record<string, unknown>,
  startedAtMs: number,
): string | null {
  const raw = payload.request_date_ms;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > MAX_EPOCH_MS) {
    return null;
  }
  if (raw > startedAtMs + REVENUECAT_CLOCK_MAX_AHEAD_MS) return null;
  if (raw < startedAtMs - REVENUECAT_CLOCK_MAX_BEHIND_MS) return null;
  return new Date(raw).toISOString();
}

/** Fetch + fold the subscriber's entitlements from RevenueCat. Returns null
 * when RevenueCat cannot be reached (callers respond retryably). */
async function verifyRevenueCatSubscriber(
  appUserId: string,
  fulfilment?: BillingFulfilmentRequest,
): Promise<BillingVerdict | null> {
  const rcKey =
    Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? Deno.env.get("REVENUECAT_PUBLIC_SDK_KEY");
  if (!rcKey) return null;

  // Fallback timestamp, read BEFORE the round trip: a slow answer must never
  // look newer than a verification that started after it. Also the reference
  // RevenueCat's own clock is judged against.
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  // The RevenueCat app_user_id IS the canonical account id (the mobile SDK
  // logs in with the same uuid). GET auto-creates unknown subscribers
  // (200/201), so a user who never purchased still resolves to an honest
  // premium:false — never an error.
  let subscriber: Record<string, unknown> | null = null;
  let requestDate: string | null = null;
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
      requestDate = isRecord(parsed) ? revenueCatRequestDate(parsed, startedAtMs) : null;
    } else {
      await rcResponse.text().catch(() => undefined);
    }
  } catch {
    subscriber = null;
  }
  if (!subscriber || !isRecord(subscriber.entitlements)) return null;

  // entitlements is an object map keyed by entitlement identifier. An
  // entitlement is ACTIVE through its paid or verified grace horizon, or
  // indefinitely for a lifetime grant. Malformed provider state is unavailable,
  // never a negative verification that could revoke an existing membership.
  const entitlementMap = subscriber.entitlements;
  if (subscriber.subscriptions !== undefined && !isRecord(subscriber.subscriptions)) return null;
  const subscriptions = isRecord(subscriber.subscriptions) ? subscriber.subscriptions : {};
  const nowMs = Date.now();
  const verdict: BillingVerdict = {
    premium: false,
    productKey: null,
    expiresAt: null,
    activeEntitlements: [],
    verifiedAt: requestDate ?? startedAt,
  };
  for (const name of PREMIUM_ENTITLEMENT_KEYS) {
    if (!Object.hasOwn(entitlementMap, name)) continue;
    const entitlement = entitlementMap[name];
    if (!isRecord(entitlement)) return null;
    const expires = entitlement.expires_date;
    if (
      expires !== null &&
      (typeof expires !== "string" || !Number.isFinite(Date.parse(expires)))
    ) {
      return null;
    }
    const product = entitlement.product_identifier;
    const subscription =
      typeof product === "string" && Object.hasOwn(subscriptions, product)
        ? subscriptions[product]
        : undefined;
    if (subscription !== undefined && !isRecord(subscription)) return null;
    let horizon = typeof expires === "string" ? expires : null;
    for (const grace of [
      entitlement.grace_period_expires_date,
      isRecord(subscription) ? subscription.grace_period_expires_date : undefined,
    ]) {
      if (grace === undefined || grace === null) continue;
      if (typeof grace !== "string" || !Number.isFinite(Date.parse(grace))) return null;
      if (horizon !== null && Date.parse(grace) > Date.parse(horizon)) horizon = grace;
    }
    const active = horizon === null || Date.parse(horizon) > nowMs;
    if (!active) continue;
    verdict.activeEntitlements.push(name);
    if (
      !verdict.premium ||
      (verdict.expiresAt !== null &&
        (horizon === null || Date.parse(horizon) > Date.parse(verdict.expiresAt)))
    ) {
      // Recognized aliases grant a union of access. Keep its longest horizon
      // and the matching product; equal horizons retain the canonical alias.
      verdict.premium = true;
      verdict.productKey = typeof product === "string" ? product : null;
      verdict.expiresAt = horizon;
    }
  }
  if (fulfilment) verdict.fulfilment = billingFulfilmentOf(fulfilment, subscriber, verdict);
  return verdict;
}

interface BillingFailureDetail {
  operation:
    | "verification_begin"
    | "entitlement_upsert"
    | "user_lookup"
    | "event_lookup"
    | "event_claim"
    | "event_release"
    | "event_audit"
    | "webhook_processing";
  code: string;
  status: number | null;
}

function billingFailureDetail(
  operation: BillingFailureDetail["operation"],
  error?: unknown,
  status?: number,
): BillingFailureDetail {
  const code = isRecord(error) ? error.code : null;
  return {
    operation,
    code:
      typeof code === "string" && /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(code) ? code : "unknown",
    status:
      typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
        ? status
        : null,
  };
}

type BillingPersistenceResult =
  | { outcome: "persisted"; billing: BillingVerdict & { verifiedAt: string }; applied: boolean }
  | { outcome: "user_missing" }
  | { outcome: "unconfigured" }
  | { outcome: "retryable"; failure: BillingFailureDetail };

type BillingVerificationTicket =
  | { outcome: "issued"; userId: string; ticketId: string }
  | { outcome: "user_missing"; userId: string };

type BillingVerificationStart =
  | { outcome: "issued"; tickets: BillingVerificationTicket[] }
  | { outcome: "duplicate" }
  | { outcome: "unconfigured" }
  | { outcome: "retryable"; failure: BillingFailureDetail };

async function beginBillingVerification(
  userIds: string[],
  eventId: string | null = null,
  payload: Record<string, unknown> | null = null,
  leaseToken: string | null = null,
): Promise<BillingVerificationStart> {
  try {
    const adminDb = billingAdminDb();
    if (!adminDb) return { outcome: "unconfigured" };
    const issued = await adminDb
      .rpc("begin_billing_verification", {
        p_user_ids: userIds,
        p_event_id: eventId,
        p_payload: payload,
        p_lease_token: leaseToken,
      })
      .abortSignal(AbortSignal.timeout(10_000));
    if (
      !issued.error &&
      eventId !== null &&
      isRecord(issued.data) &&
      issued.data.outcome === "duplicate" &&
      issued.data.event_id === eventId
    ) {
      return { outcome: "duplicate" };
    }
    if (issued.error || !Array.isArray(issued.data) || issued.data.length !== userIds.length) {
      return {
        outcome: "retryable",
        failure: billingFailureDetail("verification_begin", issued.error, issued.status),
      };
    }
    const remaining = new Set(userIds);
    const ticketIds = new Set<string>();
    const tickets: BillingVerificationTicket[] = [];
    for (const row of issued.data) {
      if (!isRecord(row) || !isUuid(row.user_id) || !remaining.delete(row.user_id)) {
        return { outcome: "retryable", failure: billingFailureDetail("verification_begin") };
      }
      if (row.outcome === "issued" && isUuid(row.ticket_id) && !ticketIds.has(row.ticket_id)) {
        ticketIds.add(row.ticket_id);
        tickets.push({ outcome: "issued", userId: row.user_id, ticketId: row.ticket_id });
      } else if (row.outcome === "user_missing") {
        tickets.push({ outcome: "user_missing", userId: row.user_id });
      } else {
        return { outcome: "retryable", failure: billingFailureDetail("verification_begin") };
      }
    }
    return { outcome: "issued", tickets };
  } catch {
    return { outcome: "retryable", failure: billingFailureDetail("verification_begin") };
  }
}

function persistedBillingSnapshot(
  value: unknown,
): (BillingVerdict & { verifiedAt: string }) | null {
  if (
    !isRecord(value) ||
    typeof value.premium !== "boolean" ||
    !(value.productKey === null || typeof value.productKey === "string") ||
    !(value.expiresAt === null || isoTimestamp(value.expiresAt) !== null) ||
    isoTimestamp(value.verifiedAt) === null ||
    !Array.isArray(value.activeEntitlements) ||
    !value.activeEntitlements.every(
      (name) => typeof name === "string" && PREMIUM_ENTITLEMENT_KEYS.some((key) => key === name),
    ) ||
    value.premium !== value.activeEntitlements.length > 0 ||
    (!value.premium && (value.productKey !== null || value.expiresAt !== null))
  ) {
    return null;
  }
  const stored = persistedBillingOf({
    premium: value.premium,
    product_key: value.productKey,
    expires_at: value.expiresAt,
    verified_at: value.verifiedAt,
  });
  if (!stored) return null;
  const premium = effectivePremium(stored);
  return {
    premium,
    productKey: premium ? stored.productKey : null,
    expiresAt: premium ? stored.expiresAt : null,
    verifiedAt: stored.verifiedAt,
    activeEntitlements: premium ? value.activeEntitlements : [],
  };
}

function billingPayloadMatches(left: unknown, right: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[left, right]];
  while (pending.length > 0) {
    const [a, b] = pending.pop()!;
    if (a === b) continue;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) pending.push([a[i], b[i]]);
    } else if (isRecord(a) && isRecord(b)) {
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      for (const key of keys) {
        if (!Object.hasOwn(b, key)) return false;
        pending.push([a[key], b[key]]);
      }
    } else return false;
  }
  return true;
}

/** PostgREST/Postgres SQLSTATE (e.g. "23503"), or null when the write
 * never reached the database (service role unavailable). */
/** Postgres FK violation: the user has no profiles row (never bootstrapped). */
const FK_VIOLATION = "23503";

/** The billing_entitlements state a caller may answer with: the verdict it
 * just landed, or — when that verdict was dropped as stale — the newer row
 * already stored. */
interface PersistedBilling {
  premium: boolean;
  productKey: string | null;
  expiresAt: string | null;
  verifiedAt: string;
}

/** The ONE effective-premium rule, identical to what every database decision
 * point applies to a billing_entitlements row — `access_state()`,
 * `reserve_analysis_permit()`, `apply_synced_shot()`, the scored-shot write
 * gate: `premium AND (expires_at IS NULL OR expires_at > now())`. A stored
 * `premium=true` whose `expires_at` has passed is NOT premium; anything the
 * edge fn answers about a persisted row must go through here so it can never
 * disagree with `GET /v1/me/access`. */
function effectivePremium(row: PersistedBilling, nowMs = Date.now()): boolean {
  if (!row.premium) return false;
  if (row.expiresAt === null) return true;
  const expiresMs = Date.parse(row.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

const isoTimestamp = (value: unknown): string | null => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

function persistedBillingOf(row: unknown): PersistedBilling | null {
  if (!isRecord(row)) return null;
  const verifiedAt = isoTimestamp(row.verified_at);
  if (!verifiedAt) return null;
  return {
    premium: row.premium === true,
    productKey: typeof row.product_key === "string" ? row.product_key : null,
    expiresAt: isoTimestamp(row.expires_at),
    verifiedAt,
  };
}

/** Persist the verified verdict — premium AND not-premium alike, so a lapsed
 * subscription revokes saved access on its next sync. Written with the
 * service-role client: billing_entitlements has no user write policies, so
 * verified paths are the ONLY writers.
 *
 * billing_entitlements keeps the NEWEST verified_at (BEFORE UPDATE trigger,
 * migration 20260906120000): a verdict older than the stored row is dropped
 * rather than overwriting fresher truth, and PostgREST returns no row for
 * it. A dropped write is not an error — but the caller must not answer with
 * the dropped verdict either, so the stored row is re-read and returned as
 * the state to report (`superseded: true`). */
async function persistBillingVerdict(
  userId: string,
  verdict: BillingVerdict,
  ticketId: string,
): Promise<BillingPersistenceResult> {
  try {
    const adminDb = billingAdminDb();
    if (!adminDb) return { outcome: "unconfigured" };
    const upserted = await adminDb
      .rpc("persist_billing_verdict", {
        p_user_id: userId,
        p_ticket_id: ticketId,
        p_verdict: {
          premium: verdict.premium,
          productKey: verdict.productKey,
          expiresAt: verdict.expiresAt,
          activeEntitlements: verdict.activeEntitlements,
          verifiedAt: verdict.verifiedAt,
        },
      })
      .abortSignal(AbortSignal.timeout(10_000));
    if (!upserted.error) {
      const result: unknown = upserted.data;
      if (isRecord(result) && result.user_id === userId) {
        if (result.outcome === "user_missing") return { outcome: "user_missing" };
        const billing = persistedBillingSnapshot(result.billing);
        if (result.outcome === "persisted" && billing && typeof result.applied === "boolean") {
          return { outcome: "persisted", billing, applied: result.applied };
        }
      }
      // The row that outranked us is gone (deleted between the two statements):
      // nothing durable to report — retryable.
      return { outcome: "retryable", failure: billingFailureDetail("entitlement_upsert") };
    }
    const failure = billingFailureDetail("entitlement_upsert", upserted.error, upserted.status);
    if (upserted.error.code !== FK_VIOLATION) return { outcome: "retryable", failure };

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceRoleKey) return { outcome: "unconfigured" };
    try {
      const lookup = await fetch(
        `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            "X-Supabase-Api-Version": "2024-01-01",
          },
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        },
      );
      if (lookup.status === 404) {
        const body: unknown = await readAccountDeletionResponseBody(lookup);
        if (
          isRecord(body) &&
          isIntendedAuthUserNotFound({
            status: lookup.status,
            code: body.code,
            error_code: body.error_code,
          })
        ) {
          return { outcome: "user_missing" };
        }
      } else {
        await lookup.body?.cancel().catch(() => undefined);
      }
      return {
        outcome: "retryable",
        failure: lookup.ok
          ? failure
          : billingFailureDetail("user_lookup", undefined, lookup.status),
      };
    } catch {
      return { outcome: "retryable", failure: billingFailureDetail("user_lookup") };
    }
  } catch {
    return { outcome: "retryable", failure: billingFailureDetail("entitlement_upsert") };
  }
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
//
// Idempotency is INSERT-FIRST: the event id is reserved in webhook_events
// (ON CONFLICT DO NOTHING) before RevenueCat is consulted, so of N concurrent
// deliveries exactly one owns the row. `processed_at` is set only once every
// entitlement write landed; a retryable failure (RevenueCat down, transient
// DB error) DELETEs the reservation and answers 503 so RevenueCat redelivers
// and the event is fully re-processed. Any audit-plane error is itself a 503
// (fail closed) — a 200 is only ever sent for a durably recorded outcome.
//
// A delivery that LOSES the reservation never verifies: it polls the row
// until the owner marks it processed (→ 200 duplicate:true, no RevenueCat
// call, no second audit row) for a bounded wait, and only when the owner has
// not finalized inside that bound (crash, stall) answers 503 + Retry-After so
// RevenueCat redelivers. Bursts therefore complete without 5xx whenever the
// owner does, and no copy is ever acknowledged before the outcome is durable.
// ─────────────────────────────────────────────────────────────────────────────

/** How long an in-flight reservation is honoured before a redelivery may
 * take it over (an isolate that died mid-flight never sets processed_at).
 * Generously above the function's wall-clock budget. */
const WEBHOOK_CLAIM_LEASE_MS = 5 * 60_000;

/** How long a duplicate delivery waits for the owner of its event id to
 * finalize before answering 503 (RevenueCat's own client timeout is far
 * longer). `WEBHOOK_DUPLICATE_WAIT_MS` overrides it (positive integer,
 * milliseconds; tests shorten it to exercise the stall path). */
const WEBHOOK_DUPLICATE_WAIT_MS_DEFAULT = 2_000;
/** Interval between reservation-row polls while waiting.
 * `WEBHOOK_DUPLICATE_POLL_MS` overrides it (positive integer, milliseconds). */
const WEBHOOK_DUPLICATE_POLL_MS_DEFAULT = 75;
/** Retry hint when the owner has not finalized within the wait. */
const WEBHOOK_IN_FLIGHT_RETRY_AFTER_SECONDS = 30;

function positiveIntegerEnv(name: string, fallback: number): number {
  const configured = Number(Deno.env.get(name));
  return Number.isInteger(configured) && configured > 0 ? configured : fallback;
}

interface WebhookEventState {
  provider: string;
  claimed_at: string;
  processed_at: string | null;
  payload: unknown;
}

async function claimWebhookDelivery(
  adminDb: SupabaseClient,
  eventId: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ leaseToken: string } | Response> {
  // Reserve the event id. The row's primary key is the atomic dedupe: with
  // ignoreDuplicates the insert returns the row only when THIS delivery
  // created it, so concurrent deliveries of one id elect exactly one owner.
  const waitMs = positiveIntegerEnv("WEBHOOK_DUPLICATE_WAIT_MS", WEBHOOK_DUPLICATE_WAIT_MS_DEFAULT);
  const pollMs = positiveIntegerEnv("WEBHOOK_DUPLICATE_POLL_MS", WEBHOOK_DUPLICATE_POLL_MS_DEFAULT);
  const deadline = Date.now() + Math.min(waitMs, WEBHOOK_CLAIM_LEASE_MS);
  let waiting = false;
  while (!signal.aborted) {
    const claimed = await adminDb
      .rpc("claim_billing_webhook_delivery", {
        p_event_id: eventId,
        p_payload: payload,
        p_waiting: waiting,
      })
      .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    const result: unknown = claimed.data;
    if (claimed.error || !isRecord(result) || result.event_id !== eventId) {
      return serviceUnavailable("Webhook event reservation", claimed.error, {
        status: claimed.status,
        operation: "event_claim",
      });
    }
    if (result.outcome === "duplicate") return json(200, { received: true, duplicate: true });
    if (result.outcome === "claimed" && isUuid(result.lease_token)) {
      return { leaseToken: result.lease_token };
    }
    if (result.outcome === "released") {
      return serviceUnavailable(
        "Webhook event processing",
        { name: "UnexpectedResult" },
        {
          retryAfterSeconds: WEBHOOK_IN_FLIGHT_RETRY_AFTER_SECONDS,
          operation: "event_claim",
        },
      );
    }
    if (result.outcome !== "in_progress") {
      return serviceUnavailable("Webhook event reservation", { name: "UnexpectedResult" });
    }
    waiting = true;
    // Someone else holds (or held) this id. Poll its row: processed →
    // duplicate ack; in flight → keep waiting up to the bound, then
    // retryable, so an owner that dies mid-flight cannot turn RevenueCat's
    // redelivery into a false "already processed"; lease lapsed → take it
    // over (guarded so only one redelivery wins) and process it here.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return serviceUnavailable(
        "Webhook event processing",
        { name: "UnexpectedResult" },
        {
          retryAfterSeconds: WEBHOOK_IN_FLIGHT_RETRY_AFTER_SECONDS,
          operation: "event_claim",
        },
      );
    }
    // Another redelivery reclaimed it first; wait for that one like any owner.
    await sleepUnlessAborted(Math.min(pollMs, remaining), signal);
  }
  return serviceUnavailable("Webhook event processing", { name: "AbortError" });
}

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

  const body = await readBody(request, WEBHOOK_JSON_BODY_BYTES);
  const event = isRecord(body.event) ? body.event : null;
  if (!event) {
    return errorJson(400, "Missing event payload.");
  }
  const eventId = typeof event.id === "string" ? event.id : crypto.randomUUID();

  // The subscribers to re-verify: app_user_id, falling back to any alias that
  // parses as our canonical uuid. TRANSFER events carry no app_user_id — both
  // sides of the transfer (transferred_from / transferred_to) are re-verified
  // so the source account loses premium as soon as RevenueCat moves it.
  const uuidList = (value: unknown): string[] =>
    Array.isArray(value) ? (value as unknown[]).filter(isUuid).map((id) => id.toLowerCase()) : [];
  const subjectIds = new Set<string>();
  if (isUuid(event.app_user_id)) {
    subjectIds.add(event.app_user_id.toLowerCase());
  } else {
    const alias = uuidList(event.aliases)[0];
    if (alias) subjectIds.add(alias);
  }
  for (const id of uuidList(event.transferred_from)) subjectIds.add(id);
  for (const id of uuidList(event.transferred_to)) subjectIds.add(id);
  if (subjectIds.size > MAX_WEBHOOK_SUBJECTS) {
    return errorJson(400, "Too many subscriber ids in one event.");
  }

  let release: (() => Promise<void>) | null = null;
  let auditAttempted = false;
  try {
    const adminDb = billingAdminDb();
    if (!adminDb) {
      return errorJson(503, "Webhook processing is not configured.");
    }

    // The audit row is written only after every subject is persisted or
    // authoritatively absent. Its presence marks completion: replays skip
    // billing work. Failures before that write leave no marker, so a retry
    // re-verifies and repairs all subjects, including a partial transfer.
    const seen = await adminDb
      .from("webhook_events")
      .select("id,provider,payload,claimed_at,processed_at")
      .eq("id", eventId)
      .abortSignal(AbortSignal.timeout(10_000))
      .maybeSingle();
    if (seen.error) {
      return serviceUnavailable(
        "Webhook event lookup",
        billingFailureDetail("event_lookup", seen.error, seen.status),
        { operation: "event_lookup" },
      );
    }
    if (seen.data) {
      const state = seen.data as WebhookEventState;
      if (state.provider !== "revenuecat" || !billingPayloadMatches(state.payload, body)) {
        return serviceUnavailable(
          "Webhook event lookup",
          { code: "22023" },
          {
            operation: "event_lookup",
          },
        );
      }
      if (state.processed_at !== null) {
        return isoTimestamp(state.processed_at) !== null
          ? json(200, { received: true, duplicate: true })
          : serviceUnavailable("Webhook event lookup", { name: "UnexpectedResult" });
      }
    }
    const claim = await claimWebhookDelivery(adminDb, eventId, body, request.signal);
    if (claim instanceof Response) return claim;
    // Hand the id back so RevenueCat's redelivery is fully re-processed. Best
    // effort: if the delete itself fails the row stays in flight and is
    // reclaimed once its lease lapses.
    release = async () => {
      try {
        const released = await adminDb
          .rpc("release_billing_webhook_delivery", {
            p_event_id: eventId,
            p_payload: body,
            p_lease_token: claim.leaseToken,
          })
          .abortSignal(AbortSignal.timeout(5_000));
        if (released.error) {
          console.error(
            "[api] webhook event release failed:",
            failureDetail(released.error, released.status),
          );
        }
      } catch (error) {
        console.error("[api] webhook event release failed:", failureDetail(error));
      }
    };
    const ticketIds: Record<string, string> = {};
    const logEvent = async (): Promise<Response> => {
      const logged = await adminDb
        .rpc("complete_billing_webhook", {
          p_event_id: eventId,
          p_payload: body,
          p_tickets: ticketIds,
          p_lease_token: claim.leaseToken,
        })
        .abortSignal(AbortSignal.timeout(10_000));
      const result: unknown = logged.data;
      if (!logged.error && isRecord(result) && result.received === true) {
        if (result.duplicate === true) return json(200, { received: true, duplicate: true });
        if (typeof result.verified === "boolean") {
          return json(200, { received: true, verified: result.verified });
        }
      }
      // The verdict IS persisted; keep the reservation so the redelivery
      // waits out the lease instead of re-verifying, then marks it again.
      return serviceUnavailable(
        "Webhook audit",
        billingFailureDetail("event_audit", logged.error, logged.status),
        { operation: "event_audit", retryAfterSeconds: WEBHOOK_IN_FLIGHT_RETRY_AFTER_SECONDS },
      );
    };

    // Bind every event (including anonymous-only events) in the database.
    // Issuance rechecks completion under the same lock used by the audit RPC,
    // so a stale lookup cannot authorize another fetch or a changed scope.
    const started = await beginBillingVerification(
      [...subjectIds],
      eventId,
      body,
      claim.leaseToken,
    );
    if (started.outcome === "duplicate") {
      return json(200, { received: true, duplicate: true });
    }
    if (started.outcome !== "issued") {
      return serviceUnavailable(
        "Webhook verification",
        started.outcome === "retryable" ? started.failure : { name: "ConfigurationError" },
        { operation: "verification_begin" },
      );
    }
    const verdicts: Array<{ userId: string; ticketId: string; verdict: BillingVerdict }> = [];
    let retryableFailure = false;
    for (const ticket of started.tickets) {
      if (ticket.outcome === "user_missing") continue;
      const { userId, ticketId } = ticket;
      ticketIds[userId] = ticketId;
      const verdict = await verifyRevenueCatSubscriber(userId);
      if (!verdict) {
        // RevenueCat unreachable: 503 makes RevenueCat retry with backoff.
        retryableFailure = true;
        continue;
      }
      verdicts.push({ userId, ticketId, verdict });
    }
    for (const { userId, ticketId, verdict } of verdicts) {
      const persisted = await persistBillingVerdict(userId, verdict, ticketId);
      if (persisted.outcome !== "persisted") {
        // A missing profile is terminal only when Auth confirms user absence;
        // every unconfirmed failure stays retryable, without a completion marker.
        if (persisted.outcome !== "user_missing") {
          console.error("[api] webhook verdict persist failed:", persisted);
          retryableFailure = true;
        }
      }
    }
    if (retryableFailure) {
      // Anything else is transient: all-or-nothing across the subjects — the
      // reservation is released and RevenueCat retries the whole event.
      return errorJson(503, "Verification is temporarily unavailable.");
    }
    // Nothing to verify (e.g. an anonymous-only subscriber). Acknowledge so
    // RevenueCat stops retrying; the audit row preserves the event.
    auditAttempted = true;
    return await logEvent();
  } catch {
    return serviceUnavailable("Webhook processing", billingFailureDetail("webhook_processing"), {
      operation: "webhook_processing",
    });
  } finally {
    if (release && !auditAttempted) await release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-step account deletion.
//
//   POST /v1/me/delete-request { survey? }
//     → { challenge, expiresAt, operationId, statusCapability, statusExpiresAt }
//   POST /v1/me/delete-confirm { challenge, operationId? }
//     → { deleted: true, operationId, completionReceipt, appleAuthorizationRevocation }
//        or 202 { operationId, state: "in_progress" }
//   POST /v1/me/delete-status { operationId }, bearer = statusCapability only
//     → minimal operation state; never authenticates a session or resumes work.
//
// The confirm call must present the challenge minted by a SEPARATE prior
// request (min age enforced), so no single call — accidental or scripted —
// can destroy an account. The actual deletion uses the service-role Auth
// admin API; the auth.users → profiles cascade removes every user row
// (shots, sessions, permits, consent, trials, feedback, saved drills,
// billing entitlement, rank state, legacy deletion request itself). Existing
// retained records disclosed in the privacy policy (legal.ts §7/§8) remain:
// the optional exit survey (account_deletion_feedback, FK ON DELETE SET NULL
// → anonymized, kept) and the free-rating identity ledger
// (free_rating_ledger: SHA-256 of the provider sign-in identifier → lifetime
// scored count, no FK by design, migration 20260902150000), which is what
// stops delete-and-recreate from re-earning the two free ratings. The new
// private operation/receipt has a DRAFT 24-hour capability / 7-day retention
// window. That policy is not legally approved and this is not deployment approval.
// ─────────────────────────────────────────────────────────────────────────────

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
      stateQ.error
        ? failureDetail(stateQ.error, stateQ.status)
        : failureDetail(profileQ.error, profileQ.status),
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
    console.error(
      "[api] delete-request: exit survey not recorded:",
      failureDetail(inserted.error, inserted.status),
    );
  }
}

function deletionOperationRpc(adminDb: SupabaseClient): DeletionOperationRpc {
  return (name, parameters) =>
    adminDb.rpc(name, parameters).abortSignal(AbortSignal.timeout(10_000));
}

async function requestAccountDeletion(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request);
  const survey = parseDeletionSurvey(body);
  const adminDb = billingAdminDb();
  if (!adminDb) return serviceUnavailable("Account deletion", { name: "ConfigurationError" });
  const result = await beginAccountDeletionOperation(deletionOperationRpc(adminDb), authed.id);
  if (result.outcome === "confirmation_in_progress") {
    return codedError(
      409,
      "account.deletion_in_progress",
      "Account deletion is already confirmed. Check its status before starting again.",
    );
  }
  if (result.outcome !== "requested") {
    // Even authoritative Auth absence at admission is not a completion receipt.
    return serviceUnavailable("Account deletion", { name: "UnexpectedResult" });
  }
  // Survey failure must not discard the newly minted recovery capability.
  // A retry may supersede an unconfirmed operation, but never confirmed work.
  // Only after the challenge is safely minted: a 503 above makes the app
  // retry this whole request, and the survey must not be double-counted.
  if (survey) {
    try {
      await recordDeletionSurvey(authed, survey);
    } catch (error) {
      console.warn("[api] delete-request: exit survey unavailable:", failureDetail(error));
    }
  }
  return json(200, {
    challenge: result.challenge,
    expiresAt: result.expiresAt,
    operationId: result.operationId,
    statusCapability: result.statusCapability,
    statusExpiresAt: result.statusExpiresAt,
  });
}

/** Reuse the existing Apple crypto/protocol implementation without allowing
 * redirects or unbounded provider bodies into the deletion/bootstrap path. */
async function accountAppleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, redirect: "error" });
  const body = await readAccountDeletionResponseBody(response);
  return new Response([204, 205, 304].includes(response.status) ? null : JSON.stringify(body), {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}

async function deleteAccountRevenueCatCustomer(ownerId: string): Promise<void> {
  let intendedAbsence = true;
  await deleteRevenueCatCustomer(
    ownerId,
    Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? "",
    async (input, init) => {
      const response = await fetch(input, { ...init, redirect: "error" });
      if (response.status === 404) {
        intendedAbsence = isIntendedRevenueCatCustomerNotFound(
          await readAccountDeletionResponseBody(response),
        );
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
      return new Response(null, { status: response.status });
    },
  );
  // The legacy transport accepts HTTP 404. The operation checkpoint requires
  // the precise RevenueCat subscriber-absence code, not a gateway/HTML 404.
  if (!intendedAbsence) {
    throw new ExternalAccountError(
      "invalid_response",
      "revenuecat",
      "Customer absence is unverified.",
      404,
    );
  }
}

/** Inspect both raw Auth codes rather than allowing SDK normalization to hide
 * a conflicting code/error_code. Only the helper's exact user_not_found test
 * may proceed to the separate, authoritative trigger receipt read. */
async function deleteAccountAuthUser(ownerId: string): Promise<{ error?: unknown }> {
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) throw new Error("Auth deletion is unavailable.");
  const response = await authFetch(
    `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(ownerId)}`,
    {
      method: "DELETE",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "X-Supabase-Api-Version": "2024-01-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ should_soft_delete: false }),
    },
  );
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { error: null };
  }
  const body = response.status === 404 ? await readAccountDeletionResponseBody(response) : null;
  if (response.status !== 404) await response.body?.cancel().catch(() => undefined);
  return {
    error: {
      status: response.status,
      code: isRecord(body) ? body.code : undefined,
      error_code: isRecord(body) ? body.error_code : undefined,
    },
  };
}

async function confirmAccountDeletion(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request);
  if (
    !isUuid(body.challenge) ||
    (Object.hasOwn(body, "operationId") && !isUuid(body.operationId))
  ) {
    return codedError(
      400,
      "validation.account_deletion",
      "challenge and any supplied operationId must be the UUIDs returned by delete-request.",
    );
  }
  const adminDb = billingAdminDb();
  if (!adminDb) return serviceUnavailable("Account deletion", { name: "ConfigurationError" });
  const result = await confirmAccountDeletionOperation(
    deletionOperationRpc(adminDb),
    {
      verifyLiveSession: async (ownerId) => {
        if (ownerId !== authed.id.toLowerCase()) return false;
        // Recheck after the bounded body read, immediately before accepting the
        // irreversible confirmation. The earlier router check is not cached proof.
        const live = await authed.db
          .rpc("is_api_session_active")
          .abortSignal(AbortSignal.timeout(10_000));
        if (live.error || typeof live.data !== "boolean")
          throw new Error("Session check unavailable.");
        return live.data;
      },
      revokeAppleCredential: async (encryptedToken, ownerId) => {
        const config = appleServerConfiguration();
        if (!config) throw new Error("Apple cleanup is unavailable.");
        const token = await decryptAppleRefreshToken(
          encryptedToken,
          ownerId,
          config.tokenEncryptionKey,
        );
        await revokeAppleRefreshToken(token, config, accountAppleFetch);
      },
      deleteRevenueCatCustomer: deleteAccountRevenueCatCustomer,
      deleteAuthUser: deleteAccountAuthUser,
      readOwnerNamespacePage: (namespace, ownerId, before, limit) => {
        // Every namespace is read AS the deleting user (RLS `*_select_own`,
        // the only SELECT granted on client-owned tables) — never the service
        // role. `is_api_request()` needs only the JWT subject and the API key,
        // so the sweep still reads after the Auth identity is gone.
        const owned = authed.db
          .from(namespace.table)
          .select(ownerNamespaceSelectColumns(namespace))
          .eq(namespace.ownerColumn, ownerId);
        return namespace.keyColumns
          .reduce(
            (page, column) => page.order(column, { ascending: false }),
            before === null ? owned : owned.or(before),
          )
          .limit(limit)
          .abortSignal(AbortSignal.timeout(10_000))
          .retry(false);
      },
      onFailure: (code, status, detail) =>
        console.error("[api] Account deletion:", { code, status, ...detail }),
    },
    authed.id,
    body,
  );
  if (result.outcome === "unavailable") {
    return errorJson(503, "Account deletion is temporarily unavailable. Please try again.");
  }
  if (result.outcome === "in_progress") {
    const response = json(202, { operationId: result.operationId, state: "in_progress" });
    response.headers.set("Retry-After", "3");
    return response;
  }
  if (result.outcome === "rejected") {
    if (result.code === "session_invalid") {
      await cacheDel(await authCacheKey(bearerOf(request)));
      return errorJson(401, "The session is no longer valid. Sign in again.");
    }
    if (result.code === "too_fast") {
      return codedError(
        429,
        "account.deletion_too_fast",
        "Please review the confirmation before deleting.",
      );
    }
    if (result.code === "expired") {
      return codedError(
        403,
        "account.deletion_challenge_expired",
        "The deletion request expired. Start again from Settings.",
      );
    }
    if (result.code === "blocked") {
      return codedError(
        409,
        "account.deletion_blocked",
        "Account deletion could not be completed. Check its status or contact support.",
      );
    }

    return codedError(
      403,
      "account.deletion_challenge_invalid",
      "This deletion was not requested, or the confirmation does not match. Start again from Settings.",
    );
  }

  // Only a sealed Auth-delete trigger receipt authorizes success. Cache
  // eviction is best-effort; every remaining bearer still faces live-session RLS.
  await cacheDel(
    rankCacheKey(authed.id),
    progressCacheKey(authed.id),
    await authCacheKey(bearerOf(request)),
  ).catch(() => undefined);
  // Drop this user's cached derived state AND fence the session that just
  // deleted the account, so none of its bearers can keep authenticating (a
  // bearer of another device's session ages out within ≤10 min, and every
  // query behind it hits RLS-empty rows).
  await fenceRevokedSession(bearerOf(request)).catch(() => undefined);
  if (result.appleAuthorizationRevocation === "manual_action_required") {
    // Accounts created by an older app build have no stored Apple refresh
    // token. Apple explicitly says deletion must still be fulfilled; the
    // response tells the client to direct that user to Apple's manual
    // Sign in with Apple authorization controls.
    console.warn("[api] account deletion has no Apple revocation token");
  }
  console.warn("[api] account deleted");
  return json(200, {
    deleted: true,
    operationId: result.operationId,
    completionReceipt: result.completionReceipt,
    appleAuthorizationRevocation: result.appleAuthorizationRevocation,
  });
}

const deletionStatusBudget = new AccountDeletionStatusBudget();

async function accountDeletionStatusRoute(request: Request, ip: string): Promise<Response> {
  const limited = deletionStatusBudget.admit(ip);
  if (limited) {
    void request.body?.cancel().catch(() => undefined);
    return limited;
  }
  let response: Response;
  try {
    const authorization = request.headers.get("Authorization") ?? "";
    const url = new URL(request.url);
    let body: unknown = null;
    if (
      request.method === "POST" &&
      !url.search &&
      !url.hash &&
      authorization.slice(0, 7).toLowerCase() === "bearer " &&
      isAccountDeletionStatusCapability(authorization.slice(7))
    ) {
      const bounded = new Request(request, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]),
      });
      body = await readBody(bounded, 1_024);
    } else {
      void request.body?.cancel().catch(() => undefined);
    }
    response = await accountDeletionStatusResponse(
      (name, parameters) => {
        const adminDb = billingAdminDb();
        if (!adminDb) throw new Error("Deletion status is unavailable.");
        return deletionOperationRpc(adminDb)(name, parameters);
      },
      request,
      body,
    );
  } catch (error) {
    response = accountDeletionStatusUnavailableResponse(
      error instanceof RequestBodyTooLarge ? 413 : 404,
    );
  }
  if (response.status === 404 || response.status === 413) deletionStatusBudget.recordFailure(ip);
  return response;
}

// ─────────────────────────────────────────────────────────────────────────────
// Offline execution grants (W04-02): device registration + signed grant issuance
//
// The database RPCs (migration 20260908160000) own every decision — live
// session, device ownership, attestation, identity-lifetime budget, Pro lease
// = min(issued + 7d, verified entitlement expiry). The edge fn adds only what
// SQL cannot: the ES256 signature binding the accepted row to the
// authenticated owner, the installation, the verified release lineage and the
// server-only signing key. Both routes run as the CALLER (never the service
// role), after the per-user route budget and the uncached live-session check.
// ─────────────────────────────────────────────────────────────────────────────

const OFFLINE_INVALID_INPUT_CODE = "offline.invalid_input";
/** Mirrors the `offline_devices_installation_key_bounds` CHECK exactly, so a
 * malformed key is refused here before the RPC would refuse it. */
const OFFLINE_INSTALLATION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const isOfflineInstallationKey = (value: unknown): value is string =>
  typeof value === "string" && OFFLINE_INSTALLATION_KEY_RE.test(value);
const OFFLINE_GRANT_ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const OFFLINE_GRANT_SIGNING_JWK_ENV = "OFFLINE_GRANT_SIGNING_JWK";

/** Categorical audit line for every grant decision: grant id, generation,
 * source, key id and outcome. Never the owner, the installation key, the
 * bearer or the signed grant. */
function emitOfflineGrantAudit(entry: {
  outcome: "issued" | "refused";
  reason?: string;
  grantId?: string;
  generation?: number;
  entitlementSource?: string;
  keyId?: string;
}): void {
  console.warn("[api] offline grant", { evt: "offline_grant_audit", ...entry });
}

/** The configured private signing JWK, imported once per distinct secret
 * value (rotation = new value = fresh import). A missing or unusable secret
 * is `null`: the route answers 503 and spends nothing. */
let offlineSigningKeyCache: { raw: string; key: OfflineGrantKeyRing } | null = null;
async function offlineGrantKeyRing(): Promise<OfflineGrantKeyRing | null> {
  const raw = Deno.env.get(OFFLINE_GRANT_SIGNING_JWK_ENV) ?? "";
  if (raw.trim() === "") return null;
  if (offlineSigningKeyCache?.raw === raw) return offlineSigningKeyCache.key;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    const key = await importOfflineGrantKeyRing(parsed);
    offlineSigningKeyCache = { raw, key };
    return key;
  } catch {
    return null;
  }
}

function offlineReleaseArtifacts(policy: VerifiedReleasePolicy): OfflineReleasedArtifacts {
  return {
    policy: { version: policy.approval.policy.version, sha256: policy.approval.policy.sha256 },
    mechanicsModel: {
      version: policy.document.mechanics.lineage.model.version,
      sha256: policy.document.mechanics.lineage.model.sha256,
    },
    benchmarkModel: {
      version: policy.document.benchmark.lineage.model.version,
      sha256: policy.document.benchmark.lineage.model.sha256,
    },
  };
}

/** The single row a `returns table` RPC yields, or null for anything else. */
function singleRpcRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data;
  return isRecord(row) ? row : null;
}

/** POST /v1/devices/register — body { installationKeyId, attestationEnvironment }.
 * No App Attest verification exists in this function yet, so every
 * registration is recorded UNATTESTED regardless of what the body claims; the
 * RPC never downgrades an already-attested row and refuses an environment
 * change for a known installation. */
async function registerOfflineDevice(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request);
  const installationKeyId = body.installationKeyId;
  const environment = body.attestationEnvironment;
  if (
    !isOfflineInstallationKey(installationKeyId) ||
    (environment !== "production" && environment !== "development")
  ) {
    return codedError(
      400,
      OFFLINE_INVALID_INPUT_CODE,
      "installationKeyId (1-128 of [A-Za-z0-9._:-], starting alphanumeric) and attestationEnvironment (production|development) are required.",
    );
  }
  const registered = await authed.db.rpc("register_offline_device", {
    p_installation_key_id: installationKeyId,
    p_attestation_environment: environment,
    p_attested: false,
  });
  if (registered.error) {
    return serviceUnavailable("Device registration", registered.error, {
      status: registered.status,
    });
  }
  const row = singleRpcRow(registered.data);
  if (!row) return serviceUnavailable("Device registration", { name: "UnexpectedRpcRow" });
  switch (row.result) {
    case "accepted": {
      const state = row.attestation_state;
      if (!isUuid(row.device_id) || (state !== "unattested" && state !== "attested")) {
        return serviceUnavailable("Device registration", { name: "UnexpectedRpcRow" });
      }
      return json(200, {
        device: {
          deviceId: row.device_id,
          installationKeyId,
          attestationEnvironment: environment,
          attestationState: state,
        },
      });
    }
    case OFFLINE_INVALID_INPUT_CODE:
      return codedError(
        400,
        OFFLINE_INVALID_INPUT_CODE,
        "The device registration was not accepted.",
      );
    case "offline.device_environment_mismatch":
      return codedError(
        409,
        "offline.device_environment_mismatch",
        "This installation is already registered for a different attestation environment.",
      );
    default:
      return serviceUnavailable("Device registration", { name: "UnexpectedRpcResult" });
  }
}

const OFFLINE_GRANT_REFUSALS = new Map<string, { status: number; message: string }>([
  [
    "offline.device_not_registered",
    { status: 409, message: "Register this installation before requesting an offline grant." },
  ],
  [
    "offline.device_revoked",
    {
      status: 403,
      message: "This installation has been revoked and cannot receive offline grants.",
    },
  ],
  [
    "access.paywall_required",
    {
      status: 402,
      message:
        "Both lifetime free ratings have been used or reserved. Membership is required for offline ratings.",
    },
  ],
  [
    OFFLINE_INVALID_INPUT_CODE,
    { status: 400, message: "The offline grant request was not accepted." },
  ],
]);

/** POST /v1/offline/grants — body { installationKeyId, requestedTickets? (0-2, default 2) }.
 * Order matters: input, signing key and release authority are checked BEFORE
 * the RPC, so a request that cannot end in a signed grant never spends a
 * grant generation. An accepted row that fails the claim contract (expiry
 * past 7 days or past the verified entitlement, malformed ids) is refused
 * with a generic 503 and audited; no grant leaves the server unsigned. */
async function issueOfflineGrant(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request);
  const installationKeyId = body.installationKeyId;
  const requestedTickets = body.requestedTickets ?? 2;
  if (
    !isOfflineInstallationKey(installationKeyId) ||
    typeof requestedTickets !== "number" ||
    !Number.isInteger(requestedTickets) ||
    requestedTickets < 0 ||
    requestedTickets > 2
  ) {
    return codedError(
      400,
      OFFLINE_INVALID_INPUT_CODE,
      "installationKeyId (1-128 of [A-Za-z0-9._:-], starting alphanumeric) is required; requestedTickets must be an integer 0-2.",
    );
  }

  const keyRing = await offlineGrantKeyRing();
  if (!keyRing) {
    return serviceUnavailable("Offline grant issuance", { name: "SigningKeyUnavailable" });
  }
  const signingKey = keyRing.signingKey;

  const release = await chargeableReleaseAdmission();
  if (release.status === "unavailable") {
    return serviceUnavailable("Offline grant issuance", release.error);
  }
  if (release.status === "ineligible") return releaseNotAuthorized(release.reasonCode);
  const releaseArtifacts = offlineReleaseArtifacts(release.policy);

  const issued = await authed.db.rpc("issue_offline_grant", {
    p_installation_key_id: installationKeyId,
    p_requested_tickets: requestedTickets,
  });
  if (issued.error) {
    return serviceUnavailable("Offline grant issuance", issued.error, { status: issued.status });
  }
  const row = singleRpcRow(issued.data);
  if (!row) {
    emitOfflineGrantAudit({ outcome: "refused", reason: "row_malformed", keyId: signingKey.kid });
    return serviceUnavailable("Offline grant issuance", { name: "UnexpectedRpcRow" });
  }
  const result = row.result;
  if (result !== "accepted") {
    const refusal = typeof result === "string" ? OFFLINE_GRANT_REFUSALS.get(result) : undefined;
    if (typeof result !== "string" || !refusal) {
      emitOfflineGrantAudit({
        outcome: "refused",
        reason: "unexpected_rpc_result",
        keyId: signingKey.kid,
      });
      return serviceUnavailable("Offline grant issuance", { name: "UnexpectedRpcResult" });
    }
    return codedError(refusal.status, result, refusal.message);
  }

  const generation = typeof row.generation === "number" ? row.generation : undefined;
  const audited = {
    grantId: isUuid(row.grant_id) ? row.grant_id : undefined,
    generation,
    entitlementSource:
      typeof row.entitlement_source === "string" ? row.entitlement_source : undefined,
    keyId: signingKey.kid,
  };
  const attestationState = row.attestation_state;
  if (attestationState !== "attested" && attestationState !== "unattested") {
    emitOfflineGrantAudit({ outcome: "refused", reason: "row_malformed", ...audited });
    return serviceUnavailable("Offline grant issuance", { name: "UnexpectedRpcRow" });
  }
  try {
    const claims = offlineGrantClaimsFromIssuance(row, {
      issuer: OFFLINE_GRANT_ISSUER,
      ownerId: authed.id,
      installationKeyId,
      release: releaseArtifacts,
    });
    const grant = await signOfflineExecutionGrant(claims, signingKey, {
      binding: {
        issuer: OFFLINE_GRANT_ISSUER,
        allowedKeyIds: keyRing.allowedKeyIds,
        ownerId: authed.id,
        installationKeyId,
      },
      release: releaseArtifacts,
      nowEpochSeconds: Math.floor(Date.now() / 1000),
    });
    emitOfflineGrantAudit({ outcome: "issued", ...audited });
    return json(200, {
      grantId: claims.jti,
      generation,
      entitlementSource: claims.entitlementSource,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      entitlementExpiresAt:
        claims.entitlementSource === "verified_store"
          ? claims.lease.verifiedEntitlementExpiresAt
          : null,
      ticketIds:
        claims.entitlementSource === "identity_lifetime_free" ? claims.allocation.ticketIds : [],
      attestationState,
      keyId: signingKey.kid,
      grant,
    });
  } catch (error) {
    const reason = error instanceof OfflineGrantIssuanceError ? error.reason : "signing_failed";
    emitOfflineGrantAudit({ outcome: "refused", reason, ...audited });
    return serviceUnavailable("Offline grant issuance", error);
  }
}

// ─── Offline consumption receipts (POST /v1/offline/receipts) ───────────────
//
// A device that rated offline reports the consumption later — possibly days
// later, possibly twice, possibly with batches arriving out of order. Every
// receipt is settled AT MOST ONCE by public.settle_offline_receipt(), which
// binds the durable verdict to (owner, receipt id, receipt digest) and the
// ticket to (grant, operation, result, output digest). The edge function
// verifies what only it can verify — the grant signature and the
// receipt→grant→output bindings — and hands the RPC either "settle" or an
// explicit HOLD reason. A held receipt is recorded with its ticket left
// reserved: it is never refunded here and never re-run under a new operation.

const OFFLINE_RECEIPT_BATCH_MAX = 25;
const OFFLINE_RECEIPT_BATCH_BODY_BYTES = 2_000_000;
const OFFLINE_RECEIPT_CONFLICT_CODE = "offline.receipt_conflict";

type OfflineReceiptHoldReason =
  | "evidence_missing"
  | "evidence_ambiguous"
  | "conflicting_receipt"
  | "owner_mismatch"
  | "account_deleted"
  | "grant_revoked";

type OfflineReceiptDelivery = "settled" | "replayed" | "held" | "pending" | "rejected";

interface OfflineReceiptEntry {
  readonly receipt: OfflineResultReceipt;
  readonly grant: OfflineSignedExecutionGrant;
  readonly output: Record<string, unknown> | null;
}

interface OfflineReceiptResult {
  readonly receiptId: string | null;
  readonly delivery: OfflineReceiptDelivery;
  readonly reconciliation: Record<string, unknown> | null;
  readonly error: { code: string; message: string } | null;
}

function emitOfflineReceiptAudit(entry: {
  batch: number;
  settled: number;
  replayed: number;
  held: number;
  pending: number;
  rejected: number;
  holdReasons: string[];
}): void {
  console.warn("[api] offline receipts", { evt: "offline_receipt_audit", ...entry });
}

const rejectedOfflineReceipt = (
  receiptId: string | null,
  message: string,
): OfflineReceiptResult => ({
  receiptId,
  delivery: "rejected",
  reconciliation: null,
  error: { code: OFFLINE_INVALID_INPUT_CODE, message },
});

/** One batch entry: `{ receipt, grant, output }`. Shape failures are rejected
 * PER ENTRY (one malformed entry never poisons the batch) and never reach the
 * database — there is nothing durable to bind a malformed receipt to. */
function parseOfflineReceiptEntry(value: unknown): OfflineReceiptEntry | OfflineReceiptResult {
  if (!isRecord(value)) return rejectedOfflineReceipt(null, "Each entry must be an object.");
  const receiptId =
    isRecord(value.receipt) && typeof value.receipt.receiptId === "string"
      ? sanitizeUserText(value.receipt.receiptId, 128)
      : null;
  if (!("receipt" in value) || !("grant" in value) || !("output" in value)) {
    return rejectedOfflineReceipt(receiptId, "Each entry needs receipt, grant and output.");
  }
  const receipt = validateOfflineResultReceiptShape(value.receipt);
  if (!receipt.ok) {
    return rejectedOfflineReceipt(receiptId, "receipt must be an offline-result-receipt-v1.");
  }
  const grant = validateOfflineSignedGrantShape(value.grant);
  if (!grant.ok) {
    return rejectedOfflineReceipt(
      receipt.value.receiptId,
      "grant must be the signed offline execution grant the receipt names.",
    );
  }
  if (value.output !== null && !isRecord(value.output)) {
    return rejectedOfflineReceipt(
      receipt.value.receiptId,
      "output must be the delivered analysis outcome object or null.",
    );
  }
  return { receipt: receipt.value, grant: grant.value, output: value.output };
}

/** Delayed receipts routinely arrive after the grant's `exp` (a lease is ≤ 7
 * days; a device can stay offline longer). The signature, issuer, key,
 * owner/installation and release bindings are what prove the server issued
 * this grant, so they are verified as of the last instant the grant was
 * live; `exp` bounds offline EXECUTION, and consumption is settled against
 * the ticket ledger, not the clock. An undecodable payload falls back to
 * "now" and fails inside the verifier as malformed transport. */
function offlineGrantVerificationInstant(
  grant: OfflineSignedExecutionGrant,
  nowEpochSeconds: number,
): number {
  const exp = decodeJwtPayload(grant.compactJws)?.exp;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return nowEpochSeconds;
  return Math.min(nowEpochSeconds, exp - 1);
}

/** The `kid` of a compact JWS header (NOT verification — it selects which
 * configured key the signature is then verified against). */
function decodeJwsHeaderKid(compactJws: string): string | null {
  const segments = compactJws.split(".");
  if (segments.length !== 3) return null;
  try {
    const base64 = segments[0].replace(/-/g, "+").replace(/_/g, "/");
    const header: unknown = JSON.parse(atob(base64));
    return isRecord(header) && typeof header.kid === "string" ? header.kid : null;
  } catch {
    return null;
  }
}

/** The signing keys and instant a delayed receipt's grant is verified
 * against. The ring is read as of the instant the grant was live: a previous
 * key that had not yet retired then WAS the issuer (no retirement window to
 * apply at that instant), while a grant it signed after retiring is verified
 * inside its overlap window under the verifier's own rules (issued no later
 * than retirement plus the propagation grace, before the overlap closed).
 * The ring's plausibility against the TRUSTED clock is kept: a previous key
 * whose retirement lies further ahead of now than the grace is not honoured
 * at all. A key the ring no longer holds verifies nothing. */
function offlineReceiptVerificationView(
  grant: OfflineSignedExecutionGrant,
  keyRing: OfflineGrantKeyRing,
  nowEpochSeconds: number,
): { readonly keys: readonly OfflineGrantKey[]; readonly nowEpochSeconds: number } {
  const instant = offlineGrantVerificationInstant(grant, nowEpochSeconds);
  const previous = keyRing.previousKey;
  if (
    previous === null ||
    previous.retiredAtEpochSeconds >
      nowEpochSeconds + OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS
  ) {
    return { keys: [keyRing.activeKey], nowEpochSeconds: instant };
  }
  if (instant < previous.retiredAtEpochSeconds) {
    return {
      keys: [
        keyRing.activeKey,
        { purpose: previous.purpose, kid: previous.kid, key: previous.key },
      ],
      nowEpochSeconds: instant,
    };
  }
  return {
    keys: [keyRing.activeKey, previous],
    nowEpochSeconds:
      decodeJwsHeaderKid(grant.compactJws) === previous.kid
        ? Math.min(instant, previous.overlapEndsAtEpochSeconds - 1)
        : instant,
  };
}

type OfflineReceiptReleaseLineage =
  | { readonly release: OfflineReleasedArtifacts; readonly hold: null | "grant_revoked" }
  | { readonly release: null; readonly hold: "evidence_ambiguous" };

/** The release a delayed receipt's grant must verify against: the artifacts
 * of the policy the grant was issued under (`release.policy.sha256` in its
 * payload), read by digest as the service role once per distinct release per
 * batch (the batch seeds the active policy so grants under it need no read);
 * with the HOLD the lineage decides for chargeable work under it. A
 * withdrawn release still verifies the grants issued under it — its
 * abstentions are recorded, its chargeable work is a grant_revoked HOLD; an
 * unknown lineage is ambiguous evidence. Whether the release was admissible
 * when the grant was issued is what the grant's signature attests (the
 * issuer judged it then, on its own trusted clock), so it is not re-derived
 * here; only the lineage's standing NOW is. A read that fails
 * (storage) or an authority row that cannot be trusted (integrity) throws
 * and is answered 503: corrupt server state decides nothing durable. The
 * digest is taken from the still-unverified payload: it merely selects
 * which installed authority the signature is then verified against, and a
 * grant that names a release it was not signed over fails that check. */
async function offlineReceiptReleaseLineage(
  grant: OfflineSignedExecutionGrant,
  policies: Map<string, VerifiedReleasePolicy | null>,
  nowEpochSeconds: number,
): Promise<OfflineReceiptReleaseLineage> {
  const payload = decodeJwtPayload(grant.compactJws);
  const release = payload === null ? null : payload.release;
  const named = isRecord(release) && isRecord(release.policy) ? release.policy.sha256 : null;
  if (typeof named !== "string" || !/^[0-9a-f]{64}$/.test(named)) {
    return { release: null, hold: "evidence_ambiguous" };
  }
  let policy = policies.get(named);
  if (policy === undefined) {
    const admin = billingAdminDb();
    if (!admin) throw new ReleasePolicyError("storage", { name: "MissingConfiguration" });
    policy = await readVerifiedReleasePolicy(() =>
      admin.rpc("read_analysis_release_policy_lineage", { p_policy_sha256: named }),
    );
    policies.set(named, policy);
  }
  if (!policy) return { release: null, hold: "evidence_ambiguous" };
  const artifacts = offlineReleaseArtifacts(policy);
  const revoked =
    policy.approval.denyNewAuthorizations ||
    (typeof policy.approval.withdrawnAt === "number" &&
      policy.approval.withdrawnAt <= nowEpochSeconds);
  return { release: artifacts, hold: revoked ? "grant_revoked" : null };
}

/** Why this receipt must be HELD instead of settled, or null when its
 * evidence is complete and bound: the grant verifies for this owner, the
 * receipt names that grant and one of its tickets (or none for a lease),
 * and the delivered output is the one the receipt digests. Only verification
 * outcomes become hold reasons; anything else is thrown and answered 503. */
async function offlineReceiptHoldReason(
  authed: AuthedUser,
  keyRing: OfflineGrantKeyRing,
  lineage: OfflineReceiptReleaseLineage,
  nowEpochSeconds: number,
  entry: OfflineReceiptEntry,
): Promise<OfflineReceiptHoldReason | null> {
  const { receipt, grant, output } = entry;
  if (receipt.ownerId !== authed.id) return "owner_mismatch";
  if ((await digestOfflineGrantTransport(grant)) !== receipt.grantJwsSha256) {
    return "evidence_ambiguous";
  }
  if (lineage.release === null) return lineage.hold;
  const release = lineage.release;
  const view = offlineReceiptVerificationView(grant, keyRing, nowEpochSeconds);
  let verified;
  try {
    verified = await verifyOfflineExecutionGrant(grant, view.keys, {
      binding: {
        issuer: OFFLINE_GRANT_ISSUER,
        allowedKeyIds: keyRing.allowedKeyIds,
        ownerId: receipt.ownerId,
        installationKeyId: receipt.installationKeyId,
      },
      release,
      nowEpochSeconds: view.nowEpochSeconds,
    });
  } catch (error) {
    if (error instanceof OfflineGrantCryptoError) return "evidence_ambiguous";
    throw error;
  }
  const claims = verified.claims;
  if (claims.jti !== receipt.grantId) return "evidence_ambiguous";
  if (claims.entitlementSource === "identity_lifetime_free") {
    const ticket = receipt.ticket;
    if (
      ticket === null ||
      ticket.allocationId !== claims.allocation.allocationId ||
      ticket.generation !== claims.allocation.generation ||
      !claims.allocation.ticketIds.includes(ticket.ticketId)
    ) {
      return "evidence_ambiguous";
    }
  } else if (receipt.ticket !== null) {
    return "evidence_ambiguous";
  }
  // Under a withdrawn release nothing rendered is chargeable; an abstention
  // has nothing to charge and is recorded as such.
  if (lineage.hold !== null && receipt.billingDisposition !== "not_chargeable") {
    return lineage.hold;
  }
  if (output === null) {
    return receipt.billingDisposition === "joint_verification_required" ? "evidence_missing" : null;
  }
  if (output.id !== receipt.resultId) return "evidence_ambiguous";
  try {
    if ((await digestCanonicalOfflineJson(output)) !== receipt.fullOutputSha256) {
      return "evidence_ambiguous";
    }
  } catch (error) {
    if (error instanceof CanonicalDigestError) return "evidence_ambiguous";
    throw error;
  }
  return null;
}

/** The durable verdict row → the versioned reconciliation status the client
 * stores, checked against the ORIGINAL receipt by the shared-types validator
 * (a settled result names the receipt's resultId; anything held keeps its
 * ticket reserved). null when the row does not describe a valid status. */
function offlineReconciliationFromRow(
  receipt: OfflineResultReceipt,
  row: Record<string, unknown>,
): Record<string, unknown> | null {
  const base = {
    schemaVersion: OFFLINE_RECONCILIATION_SCHEMA_VERSION,
    ownerId: receipt.ownerId,
    receiptId: receipt.receiptId,
    status: row.status,
    financialDisposition: row.financial_disposition,
  };
  const candidate =
    row.status === "result_recorded"
      ? { ...base, resultId: row.result_id }
      : row.status === "pending"
        ? base
        : { ...base, reasonCode: row.reason_code };
  const status = validateOfflineReconciliationStatus(candidate, receipt);
  return status.ok ? candidate : null;
}

/** POST /v1/offline/receipts — body { receipts: [{ receipt, grant, output }] }.
 * Answers one result per entry, in order:
 *   settled  — the ticket is consumed (or the no-ticket result recorded) now
 *   replayed — this exact receipt was settled earlier; the same verdict again
 *   held     — recorded as reconciliation_required, ticket still reserved
 *   pending  — nothing recorded: the session the rating names has not synced
 *              yet; the ticket stays reserved and the same receipt is redelivered
 *   rejected — malformed, or a DIFFERENT receipt already holds this id
 * The route is idempotent under redelivery and order-independent because
 * every entry is decided inside settle_offline_receipt() under the owner's
 * access lock. A database failure answers a generic 503 for the batch —
 * entries already decided stay decided and simply replay next time. */
async function reconcileOfflineReceipts(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request, OFFLINE_RECEIPT_BATCH_BODY_BYTES);
  const receipts = body.receipts;
  if (
    !Array.isArray(receipts) ||
    receipts.length === 0 ||
    receipts.length > OFFLINE_RECEIPT_BATCH_MAX
  ) {
    return codedError(
      400,
      OFFLINE_INVALID_INPUT_CODE,
      `receipts must be an array of 1-${OFFLINE_RECEIPT_BATCH_MAX} entries.`,
    );
  }

  const keyRing = await offlineGrantKeyRing();
  if (!keyRing) {
    return serviceUnavailable("Offline receipt settlement", { name: "SigningKeyUnavailable" });
  }
  // The release authority is judged PER RECEIPT against the lineage its grant
  // names — whether the currently active release is chargeable right now
  // decides nothing about work already done under a grant. The active policy
  // is read once per batch (uncached, service role) only to spare grants
  // issued under it a lineage read; withdrawn or not, it is judged like any
  // other lineage. An authority that cannot be read or trusted is a 503.
  const admin = billingAdminDb();
  if (!admin) {
    return serviceUnavailable("Offline receipt settlement", { name: "MissingConfiguration" });
  }
  const policies = new Map<string, VerifiedReleasePolicy | null>();
  try {
    const active = await readVerifiedReleasePolicy(() => admin.rpc("read_analysis_release_policy"));
    if (active) policies.set(active.approval.policy.sha256, active);
  } catch (error) {
    return serviceUnavailable("Offline receipt settlement", error);
  }
  const nowEpochSeconds = Math.floor(Date.now() / 1000);

  const results: OfflineReceiptResult[] = [];
  const tally = { settled: 0, replayed: 0, held: 0, pending: 0, rejected: 0 };
  const holdReasons: string[] = [];
  for (const raw of receipts) {
    const parsed = parseOfflineReceiptEntry(raw);
    if ("delivery" in parsed) {
      tally.rejected += 1;
      results.push(parsed);
      continue;
    }
    const { receipt, output } = parsed;
    let holdReason: OfflineReceiptHoldReason | null;
    let receiptSha256: string;
    try {
      holdReason = await offlineReceiptHoldReason(
        authed,
        keyRing,
        await offlineReceiptReleaseLineage(parsed.grant, policies, nowEpochSeconds),
        nowEpochSeconds,
        parsed,
      );
      receiptSha256 = await digestCanonicalOfflineJson(receipt);
    } catch (error) {
      return serviceUnavailable("Offline receipt settlement", error);
    }

    const settled = await authed.db.rpc("settle_offline_receipt", {
      p_receipt: receipt,
      p_receipt_sha256: receiptSha256,
      p_output: output,
      p_hold_reason: holdReason,
    });
    if (settled.error) {
      return serviceUnavailable("Offline receipt settlement", settled.error, {
        status: settled.status,
      });
    }
    const row = singleRpcRow(settled.data);
    if (!row) {
      return serviceUnavailable("Offline receipt settlement", { name: "UnexpectedRpcRow" });
    }
    if (row.result === OFFLINE_INVALID_INPUT_CODE) {
      tally.rejected += 1;
      results.push(
        rejectedOfflineReceipt(receipt.receiptId, "receipt could not be bound to this account."),
      );
      continue;
    }
    if (row.result === OFFLINE_RECEIPT_CONFLICT_CODE) {
      tally.rejected += 1;
      results.push({
        receiptId: receipt.receiptId,
        delivery: "rejected",
        reconciliation: null,
        error: {
          code: OFFLINE_RECEIPT_CONFLICT_CODE,
          message: "A different receipt with this id was already delivered.",
        },
      });
      continue;
    }
    const delivery = row.delivery;
    if (
      row.result !== "accepted" ||
      (delivery !== "settled" &&
        delivery !== "replayed" &&
        delivery !== "held" &&
        delivery !== "pending")
    ) {
      return serviceUnavailable("Offline receipt settlement", { name: "UnexpectedRpcResult" });
    }
    const reconciliation = offlineReconciliationFromRow(receipt, row);
    if (!reconciliation) {
      return serviceUnavailable("Offline receipt settlement", { name: "UnexpectedRpcRow" });
    }
    tally[delivery] += 1;
    if (delivery === "held" && typeof row.reason_code === "string") {
      holdReasons.push(row.reason_code);
    }
    results.push({ receiptId: receipt.receiptId, delivery, reconciliation, error: null });
  }
  emitOfflineReceiptAudit({ batch: receipts.length, ...tally, holdReasons });
  return json(200, { results });
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
  {
    match: (m, p) => m === "POST" && p === "/v1/devices/register",
    scope: "device_register",
    limit: 10,
    windowSeconds: 60,
  },
  {
    match: (m, p) => m === "POST" && p === "/v1/offline/grants",
    scope: "offline_grants",
    limit: 10,
    windowSeconds: 60,
  },
  {
    match: (m, p) => m === "POST" && p === "/v1/offline/receipts",
    scope: "offline_receipts",
    limit: 25,
    windowSeconds: 60,
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
const AUTH_BOOTSTRAP_LIMIT = { limit: 30, windowSeconds: 60 };
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
  const body = await readBody(request);
  const profile = await readProfile(authed);
  if (profile instanceof Response) return profile;
  if (profile.provider !== authed.provider) {
    await authed.db.from("profiles").update({ provider: authed.provider }).eq("id", authed.id);
  }

  if (authed.provider === "apple") {
    const adminDb = billingAdminDb();
    if (!adminDb) return serviceUnavailable("Apple sign-in", { name: "ConfigurationError" });
    const rpc = deletionOperationRpc(adminDb);
    const confirmationInProgress = () =>
      codedError(
        409,
        "account.deletion_in_progress",
        "Account deletion is already confirmed. Check its status before signing in again.",
      );
    try {
      if (!(await accountDeletionAllowsAppleBootstrap(rpc, authed.id)))
        return confirmationInProgress();
    } catch (error) {
      return serviceUnavailable("Apple sign-in", error);
    }
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
      console.warn("[api] legacy Apple bootstrap has no revocation credential");
    } else {
      const config = appleServerConfiguration();
      if (!config) {
        return serviceUnavailable("Apple sign-in", { name: "ConfigurationError" });
      }
      let uncommittedRefreshToken: string | null = null;
      try {
        const grant = await exchangeAppleAuthorizationCode(
          authorizationCode.trim(),
          config,
          accountAppleFetch,
        );
        if (grant.subject !== providerSubject) {
          return codedError(
            401,
            "auth.apple_authorization_mismatch",
            "Apple returned authorization for a different account. Try again.",
          );
        }
        uncommittedRefreshToken = grant.refreshToken;
        const encrypted = await encryptAppleRefreshToken(
          grant.refreshToken,
          authed.id,
          config.tokenEncryptionKey,
        );
        const stored = await storeAccountAppleCredential(rpc, authed.id, encrypted);
        if (stored !== "stored") {
          // Confirmation may win while Apple is exchanging the code. Never
          // overwrite its fenced credential or checkpoint. Revoke only this
          // newly exchanged, owner-matched grant before reporting rejection.
          uncommittedRefreshToken = null;
          await revokeAppleRefreshToken(grant.refreshToken, config, accountAppleFetch);
          return stored === "confirmation_in_progress"
            ? confirmationInProgress()
            : errorJson(401, "The session is no longer valid. Sign in again.");
        }
        uncommittedRefreshToken = null;
      } catch (error) {
        if (uncommittedRefreshToken) {
          // An ambiguous store acknowledgement is not permission to restore an
          // older row. No credential DML is performed during compensation.
          try {
            await revokeAppleRefreshToken(uncommittedRefreshToken, config, accountAppleFetch);
          } catch (cleanupError) {
            return serviceUnavailable("Apple sign-in", cleanupError);
          }
        }
        if (error instanceof ExternalAccountError && error.kind === "invalid_grant") {
          return codedError(
            401,
            "auth.apple_authorization_invalid",
            "Apple could not validate this sign-in authorization. Try again.",
          );
        }
        return serviceUnavailable("Apple sign-in", error);
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
    } else if (error instanceof RequestBodyInvalid) {
      response = errorJson(400, error.message);
    } else if (error instanceof RequestBodyTimeout) {
      response = errorJson(408, error.message);
    } else {
      console.error(`[api] unhandled error (${requestId}):`, failureDetail(error));
      response = errorJson(500, "Something went wrong. Please try again.");
    }
  }
  const code = await errorCodeOf(response);
  emitAccessLog(accessLogEntry(request, response, requestId, startedAt, code));
  const identified = withBrowserHardening(withRequestId(response, requestId));
  return response.status >= 400
    ? new Response(await identified.arrayBuffer(), identified)
    : identified;
});

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ip = clientIp(request);
  const isPublicRead = request.method === "GET" || request.method === "HEAD";

  // Capability recovery must survive Auth deletion and auth-failure throttles.
  // Match only known gateway mounts; never send the capability to ordinary
  // authentication, shared rate-limit/Redis machinery, or a worker-resume path.
  if (
    [
      "/v1/me/delete-status",
      "/api/v1/me/delete-status",
      "/functions/v1/api/v1/me/delete-status",
    ].includes(url.pathname)
  ) {
    return accountDeletionStatusRoute(request, forwardableClientIp(request) ?? "unknown");
  }

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
    if (url.searchParams.get("readiness") === "1") {
      const ready = await databaseReady();
      return json(ready ? 200 : 503, { ok: ready, readiness: { database: ready } });
    }
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
  const authFailures = await admitAuthCredential(ip, bearerOf(request), AUTH_FAILURE_LIMIT);
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
  const recordAuthFailure = (refusal: Response) =>
    chargeMarkedAuthRefusal(ip, refusal, AUTH_FAILURE_LIMIT);

  if (isAccountDeletionStatusCapability(bearerOf(request))) {
    await chargeAuthFailure(ip, bearerOf(request), "credential", AUTH_FAILURE_LIMIT);
    return errorJson(401, "A deletion status capability cannot authorize this route.");
  }

  // ── Session establishment and rotation run BEFORE general authentication:
  // bootstrap is the one route that spends a provider ID token (and mints
  // the session the app persists), and refresh authenticates by the refresh
  // token in its body. Both count toward the per-IP auth-failure budget so
  // token stuffing is throttled exactly like a bad bearer.
  if (route === "POST /v1/account/bootstrap") {
    const rl = await enforceRateLimit(
      "auth_bootstrap",
      ip,
      AUTH_BOOTSTRAP_LIMIT.limit,
      AUTH_BOOTSTRAP_LIMIT.windowSeconds,
    );
    if (!rl.allowed) return rateLimitResponse(rl);
    const exchanged = await authenticateProviderToken(request);
    if (exchanged instanceof Response) {
      if (exchanged.status === 401) await recordAuthFailure(exchanged);
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
    if (refreshed.status === 401) await recordAuthFailure(refreshed);
    return refreshed;
  }

  const authed = await authenticate(request);
  if (authed instanceof Response) {
    if (authed.status === 401) await recordAuthFailure(authed);
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

  if (route !== "POST /v1/auth/logout") {
    const live = await authed.db.rpc("is_api_session_active");
    if (live.error || typeof live.data !== "boolean") {
      return serviceUnavailable(
        "Session check",
        authErrorDetail({
          name: "SessionCheckError",
          code: live.error?.code,
          status: live.status,
        }),
      );
    }
    if (!live.data) {
      await cacheDel(await authCacheKey(bearerOf(request)));
      return errorJson(401, "The session is no longer valid. Sign in again.");
    }
  }

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
      const focusSlug = Object.hasOwn(GOAL_FOCUS, goal) ? GOAL_FOCUS[goal] : "contact_position";
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
        return serviceUnavailable("Your coaching profile", updated.error, {
          status: updated.status,
        });
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

    case "GET /v1/analysis/release-policy": {
      const admin = billingAdminDb();
      if (!admin)
        return serviceUnavailable("Analysis release authority", { name: "MissingConfiguration" });
      try {
        const policy = await readVerifiedReleasePolicy(() =>
          admin.rpc("read_analysis_release_policy"),
        );
        return json(200, {
          schemaVersion: "analysis-release-authority-v1",
          serverTime: Math.floor(Date.now() / 1000),
          policy,
        });
      } catch (error) {
        return serviceUnavailable("Analysis release authority", error);
      }
    }

    case "GET /v1/me/access": {
      const payload = await accessPayload(authed);
      return payload instanceof Response ? payload : json(200, payload);
    }

    case "POST /v1/billing/sync": {
      const syncBody = await readBody(request);
      const fulfilment = Object.hasOwn(syncBody, "fulfilment")
        ? parseBillingFulfilment(syncBody.fulfilment)
        : undefined;
      if (fulfilment === null)
        return codedError(
          400,
          "invalid_billing_fulfilment",
          "Invalid purchase verification evidence.",
        );
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

      const started = await beginBillingVerification([authed.id]);
      if (started.outcome === "unconfigured") {
        return codedError(
          503,
          "billing_unconfigured",
          "Billing verification is not configured on the server.",
        );
      }
      if (started.outcome !== "issued") {
        return serviceUnavailable(
          "Billing verification",
          started.outcome === "retryable"
            ? started.failure
            : billingFailureDetail("verification_begin"),
          { operation: "verification_begin" },
        );
      }
      const ticket = started.tickets[0];
      if (ticket.outcome === "user_missing") {
        return serviceUnavailable(
          "Billing verification",
          { code: "user_not_found" },
          { operation: "user_lookup" },
        );
      }
      const providerVerdict = await verifyRevenueCatSubscriber(authed.id, fulfilment);
      if (!providerVerdict) {
        return codedError(
          502,
          "billing_unavailable",
          "The billing provider could not be reached to verify membership. Try again shortly.",
        );
      }

      const persisted = await persistBillingVerdict(authed.id, providerVerdict, ticket.ticketId);
      if (persisted.outcome === "unconfigured") {
        return codedError(
          503,
          "billing_unconfigured",
          "Billing verification is not configured on the server.",
        );
      }
      if (persisted.outcome !== "persisted") {
        return serviceUnavailable(
          "Billing verification",
          persisted.outcome === "retryable" ? persisted.failure : { code: "user_not_found" },
          {
            operation:
              persisted.outcome === "retryable"
                ? persisted.failure.operation
                : "entitlement_upsert",
          },
        );
      }

      // Use the canonical snapshot returned by atomic persistence, not this
      // request's potentially superseded provider verdict. Both response
      // objects describe that same snapshot; the DB enforces later access.
      // Build BOTH billing and access from the state that is durably stored
      // (the verdict just landed, or the newer row that outranked it — never
      // a dropped verdict), evaluated with the same effective-premium rule
      // access_state() applies (a stored premium row past its expires_at is
      // not premium), so billing.premium === access.premium holds and the
      // client is never told something the database does not say.
      const { billing } = persisted;
      const premium = effectivePremium(billing);
      const access = await accessPayload(authed, {
        premium,
        // Entitlement identifiers are known only for the verdict just
        // verified; a superseded verdict reports the stored row exactly as
        // GET /v1/me/access does.
        activeEntitlements: premium ? billing.activeEntitlements : [],
      });
      if (access instanceof Response) return access;
      return json(200, {
        billing: {
          premium,
          productKey: billing.productKey,
          expiresAt: billing.expiresAt,
          verifiedAt: billing.verifiedAt,
        },
        access,
        ...(providerVerdict.fulfilment
          ? {
              fulfilment: {
                ...providerVerdict.fulfilment,
                outcome: persisted.applied ? providerVerdict.fulfilment.outcome : "pending",
              },
            }
          : {}),
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

    case "POST /v1/devices/register":
      return registerOfflineDevice(authed, request);

    case "POST /v1/offline/grants":
      return issueOfflineGrant(authed, request);

    case "POST /v1/offline/receipts":
      return reconcileOfflineReceipts(authed, request);

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
