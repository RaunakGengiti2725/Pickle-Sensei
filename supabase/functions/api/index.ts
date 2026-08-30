// Pickle Sensei — Supabase Edge Function implementing the mobile app's
// account + onboarding + access + sync + consent API contracts on top of
// Supabase Auth.
//
//   POST /v1/account/bootstrap takes Authorization: Bearer <Google/Apple ID
//   TOKEN (OIDC)>, exchanges it with Supabase Auth ONCE, and returns a
//   revocable Supabase session { accessToken, refreshToken, expiresAt }.
//   Every other endpoint takes Authorization: Bearer <Supabase ACCESS TOKEN>.
//     → 401/403 { error: { message } }   (app maps to rejected)
//     → 5xx     { error: { message } }   (app maps to retryable unavailable)
//
//   POST /v1/account/bootstrap → { user:{id,email}, onboardingState, session }
//   POST /v1/auth/refresh      → { session } (rotates the refresh token)
//   POST /v1/auth/logout       → 204; revokes ALL of the user's refresh tokens
//   GET  /v1/me                → + profile { skill_level, handedness, … }
//   PUT  /v1/me/onboarding     → { plan:{focusCheckpoint}, recommendedCheckpoint }
//   GET  /v1/me/access         → free-ratings/premium access state (used is
//                                derived from real scored shots, never invented)
//   POST /v1/billing/sync      → { billing, access } (no store purchases here;
//                                receipt validation stays typed-501 by design)
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
//
// The app (apps/mobile/src/account/bootstrap.ts) sends the provider ID token
// to bootstrap only; this function exchanges it with Supabase Auth
// (signInWithIdToken), which verifies it against the Google/Apple provider
// configuration and creates/returns the auth.users row. The profiles trigger
// (see migrations) provisions the canonical account row. From then on the
// app bears the short-lived Supabase access token and refreshes it via
// /v1/auth/refresh; logout revokes the refresh tokens server-side, so a
// stolen bearer dies with the session instead of surviving until the
// provider ID token's natural expiry.
//
// Deploy with JWT verification OFF (bootstrap's bearer is a provider token,
// not a Supabase JWT):   supabase functions deploy api --no-verify-jwt
//
// UNVERIFIED-HERE: written locally without a Supabase project attached; the
// TypeScript is Deno-targeted (not part of the pnpm workspace typecheck).
// Verify with `supabase functions serve api` + a real Google ID token.

import { createClient } from "npm:@supabase/supabase-js@2";
import { drillCatalogEntry, searchDrillCatalog } from "./drills.ts";
import { drillInstructionalMedia } from "./drillMedia.ts";

// Publishable key (sb_publishable_…) set via `supabase secrets set
// SB_PUBLISHABLE_KEY=…`, falling back to the platform-injected legacy anon
// key. No secret/service-role key is used anywhere in this function: after
// signInWithIdToken we hold the USER's own session, and every data access
// runs as that user under row-level security.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SB_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const errorJson = (status: number, message: string): Response =>
  json(status, { error: { message } });

/** Log the real database/auth failure server-side (Edge Function logs only)
 * and return an opaque retryable 503. Internal error strings — SQL details,
 * constraint names, table names, hostnames — never reach clients. */
function unavailable(context: string, error?: { message?: string } | string | null): Response {
  const detail = typeof error === "string" ? error : (error?.message ?? "");
  console.error(`[api] ${context}${detail ? `: ${detail}` : ""}`);
  return errorJson(503, `${context}. Please retry.`);
}

/** Same redaction for per-item rejections inside batch responses. */
function redactedDetail(context: string, detail: string): string {
  console.error(`[api] ${context}: ${detail}`);
  return `${context}.`;
}

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

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => null)) as unknown;
  return isRecord(body) ? body : {};
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

const SUPABASE_ISSUER = `${SUPABASE_URL}/auth/v1`;

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

interface AuthedUser {
  id: string;
  email: string | null;
  provider: "google" | "apple";
  // Supabase client acting AS this user (RLS enforced on every query).
  db: ReturnType<typeof createClient>;
}

function bearerOf(request: Request): string {
  const authorization = request.headers.get("Authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

function anonAuthClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function userScopedDb(accessToken: string): ReturnType<typeof createClient> {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}

interface SupabaseSessionLike {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
}

/** The session shape returned to the app: a short-lived access token (the
 * API bearer from now on) plus the rotating refresh token that keeps it
 * alive and — crucially — can be revoked server-side on logout. */
function sessionView(session: SupabaseSessionLike) {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600),
  };
}

/** Verified-access-token cache: one successful getUser() per bearer per
 * isolate, bounded by the token's own exp (capped at 60 seconds so bans,
 * account deletion, and global sign-out propagate quickly). */
interface CachedAuth {
  expiresAtMs: number;
  user: { id: string; email: string | null; provider: "google" | "apple" };
}
const AUTH_CACHE_MAX_MS = 60_000;
const AUTH_CACHE_MAX_ENTRIES = 2000;
const authCache = new Map<string, CachedAuth>();

function authedUserFrom(token: string, cached: CachedAuth): AuthedUser {
  return {
    id: cached.user.id,
    email: cached.user.email,
    provider: cached.user.provider,
    db: userScopedDb(token),
  };
}

function cacheProvider(value: unknown): "google" | "apple" | null {
  return value === "google" || value === "apple" ? value : null;
}

/** Authenticate a SUPABASE access token (issued by /v1/account/bootstrap or
 * /v1/auth/refresh) and return a client that acts as that user under RLS.
 * Provider ID tokens are deliberately rejected here: they are exchanged
 * exactly once at bootstrap for a revocable Supabase session, so a stolen
 * app bearer can be killed by logout instead of outliving revocation. */
async function authenticate(request: Request): Promise<AuthedUser | Response> {
  const token = bearerOf(request);
  if (!token) return errorJson(401, "Missing bearer token.");

  const payload = decodeJwtPayload(token);
  if (providerForIssuer(payload?.iss)) {
    return errorJson(
      401,
      "Provider ID tokens are only accepted by POST /v1/account/bootstrap. Use the Supabase session it returns.",
    );
  }
  if (payload?.iss !== SUPABASE_ISSUER) {
    return errorJson(401, "Bearer token is not a session token for this API.");
  }

  const cached = authCache.get(token);
  if (cached) {
    if (cached.expiresAtMs > Date.now()) return authedUserFrom(token, cached);
    authCache.delete(token);
  }

  const verified = await anonAuthClient().auth.getUser(token);
  if (verified.error || !verified.data.user) {
    console.error(`[api] access token rejected: ${verified.error?.message ?? "no user"}`);
    return errorJson(401, "The session is no longer valid. Sign in again.");
  }
  const provider = cacheProvider(verified.data.user.app_metadata?.provider);
  if (!provider) {
    return errorJson(401, "The session does not belong to a Google or Apple account.");
  }

  const exp = payload?.exp;
  const tokenExpMs = typeof exp === "number" ? exp * 1000 : 0;
  const entry: CachedAuth = {
    expiresAtMs: Math.min(
      Date.now() + AUTH_CACHE_MAX_MS,
      tokenExpMs > Date.now() ? tokenExpMs : Date.now() + AUTH_CACHE_MAX_MS,
    ),
    user: {
      id: verified.data.user.id,
      email: verified.data.user.email ?? null,
      provider,
    },
  };
  if (authCache.size >= AUTH_CACHE_MAX_ENTRIES) {
    const oldest = authCache.keys().next().value;
    if (oldest !== undefined) authCache.delete(oldest);
  }
  authCache.set(token, entry);
  return authedUserFrom(token, entry);
}

/** Bootstrap-only: verify the provider ID token with Supabase Auth (the one
 * and only signInWithIdToken exchange) and return the user plus the freshly
 * minted revocable Supabase session. */
async function authenticateProviderToken(
  request: Request,
): Promise<{ authed: AuthedUser; session: SupabaseSessionLike } | Response> {
  const token = bearerOf(request);
  if (!token) return errorJson(401, "Missing bearer token.");

  const payload = decodeJwtPayload(token);
  const provider = providerForIssuer(payload?.iss);
  if (!provider) {
    return errorJson(401, "Bearer token is not a Google or Apple ID token.");
  }

  const signIn = await anonAuthClient().auth.signInWithIdToken({ provider, token });
  if (signIn.error || !signIn.data.user || !signIn.data.session) {
    console.error(
      `[api] identity token rejected (${provider}): ${signIn.error?.message ?? "no user"}`,
    );
    return errorJson(401, "The identity token could not be verified.");
  }

  return {
    authed: {
      id: signIn.data.user.id,
      email: signIn.data.user.email ?? null,
      provider,
      db: userScopedDb(signIn.data.session.access_token),
    },
    session: signIn.data.session,
  };
}

/** POST /v1/auth/refresh — rotate { refreshToken } into a fresh Supabase
 * session. 401 means the refresh token was revoked or already rotated: the
 * app must sign in again. */
async function refreshSessionRoute(request: Request): Promise<Response> {
  const body = await readBody(request);
  const refreshToken = body.refreshToken;
  if (typeof refreshToken !== "string" || !refreshToken.trim()) {
    return codedError(400, "validation.refresh", "refreshToken is required.");
  }
  const refreshed = await anonAuthClient().auth.refreshSession({
    refresh_token: refreshToken,
  });
  if (refreshed.error || !refreshed.data.session) {
    console.error(`[api] refresh rejected: ${refreshed.error?.message ?? "no session"}`);
    return errorJson(401, "The session could not be refreshed. Sign in again.");
  }
  return json(200, { session: sessionView(refreshed.data.session) });
}

/** POST /v1/auth/logout — revoke every refresh token of the calling user
 * (scope=global), so the whole application session dies now rather than at
 * the access token's natural expiry. */
async function logoutRoute(request: Request): Promise<Response> {
  const token = bearerOf(request);
  authCache.delete(token);
  const response = await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=global`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    return unavailable("Sign-out could not be completed", `status ${response.status}`);
  }
  return noContent();
}

// ─────────────────────────────────────────────────────────────────────────────
// Abuse limits (per isolate — a best-effort brake, not a billing boundary;
// Supabase Auth's own rate limits and the free-rating permit gate remain the
// authoritative controls).
// ─────────────────────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_AUTHED = 120; // per user per minute
const RATE_MAX_UNAUTHED = 30; // failed/unauthenticated per IP per minute
const rateBuckets = new Map<string, { windowStartMs: number; count: number }>();

function rateLimited(key: string, max: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStartMs >= RATE_WINDOW_MS) {
    if (rateBuckets.size > 10_000) rateBuckets.clear();
    rateBuckets.set(key, { windowStartMs: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

const tooManyRequests = (): Response =>
  json(429, {
    error: {
      code: "rate.limited",
      message: "Too many requests. Please slow down and retry shortly.",
    },
  });

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for") ?? "";
  return fwd.split(",")[0]?.trim() || "unknown";
}

/** Requests with bodies larger than this are rejected before parsing. */
const MAX_BODY_BYTES = 1_048_576;

function bodyTooLarge(request: Request): boolean {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  return Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES;
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
}

async function readProfile(user: AuthedUser): Promise<ProfileRow | Response> {
  const select = () =>
    user.db
      .from("profiles")
      .select(
        "id, email, onboarding_state, provider, skill_level, handedness, primary_goal, biggest_problem, focus_checkpoint",
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
    return unavailable("Canonical account row is unavailable", profile.error);
  }
  return profile.data as unknown as ProfileRow;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis permits + access state
// ─────────────────────────────────────────────────────────────────────────────

/** Advisory permit lifetime, mirroring services/api PERMIT_LIFETIME_HOURS.
 * There is no expires_at column and no background reaper here: expiry is
 * ENFORCED lazily — access counting ignores reserved permits older than this
 * window, and shot sync refuses to consume one (mirroring the reference
 * access.permit_expired behavior) — so the advertised expiresAt is honest. */
const PERMIT_LIFETIME_HOURS = 24;
const PERMIT_COLUMNS = "id, status, outcome, created_at";

interface PermitRow {
  id: string;
  status: string;
  outcome: string | null;
  created_at: string;
}

const permitFreshCutoffIso = (): string =>
  new Date(Date.now() - PERMIT_LIFETIME_HOURS * 3_600_000).toISOString();

const permitIsStale = (row: PermitRow): boolean =>
  Date.parse(row.created_at) + PERMIT_LIFETIME_HOURS * 3_600_000 <= Date.now();

/** ReservedAnalysisPermit shape (apps/mobile/src/data/api.ts:24-29): id,
 * accessSource, status, expiresAt — plus outcome/reservedAt for parity with
 * services/api. accessSource is 'free' because no premium entitlements exist
 * in this deployment (accessPayload reports premium:false for the same
 * reason); expiresAt derives from created_at + the advisory lifetime. */
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

/** Access state (GET /v1/me/access contract; parsed by
 * apps/mobile/src/billing/accessApi.ts parseAccess with strict arithmetic
 * invariants). `used` is derived from real server-side accepted scored shots;
 * `reserved` from still-reserved, unexpired permits — never invented client
 * state. reserved is clamped to `remaining` so the client invariants
 * (reserved <= remaining, availableToReserve = remaining - reserved) hold
 * even if stale holds linger. */
async function accessPayload(user: AuthedUser): Promise<unknown | Response> {
  const scored = await user.db
    .from("shots")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("result_kind", "scored");
  if (scored.error) {
    return unavailable("Access state unavailable", scored.error);
  }
  const reservedQ = await user.db
    .from("analysis_permits")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("status", "reserved")
    .gt("created_at", permitFreshCutoffIso());
  if (reservedQ.error) {
    return unavailable("Access state unavailable", reservedQ.error);
  }
  const used = Math.min(2, scored.count ?? 0);
  const remaining = 2 - used;
  const reserved = Math.min(reservedQ.count ?? 0, remaining);
  const availableToReserve = remaining - reserved;
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used,
      reserved,
      remaining,
      availableToReserve,
    },
    canStartRating: availableToReserve > 0,
    paywallRequired: availableToReserve <= 0,
  };
}

/** POST /v1/analysis-permits — mirrors apps/mobile/src/data/api.ts:121-134
 * (reserve): upsert-by-idempotency-key, respond { permit } (+ access, as
 * services/api does; the client only reads permit). */
async function reserveAnalysisPermit(authed: AuthedUser, request: Request): Promise<Response> {
  const body = await readBody(request);
  const idempotencyKey = body.idempotencyKey;
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    return codedError(400, "validation.analysis_permit", "idempotencyKey is required.");
  }

  const respond = async (row: PermitRow): Promise<Response> => {
    const access = await accessPayload(authed);
    if (access instanceof Response) return access;
    return json(200, { permit: permitView(row), access });
  };

  const existing = await authed.db
    .from("analysis_permits")
    .select(PERMIT_COLUMNS)
    .eq("user_id", authed.id)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existing.error) {
    return unavailable("Permit lookup failed", existing.error);
  }
  if (existing.data) return respond(existing.data as unknown as PermitRow);

  // Lifetime free limit: both ratings used or held → paywall, exactly as
  // services/api reserveAnalysisPermit rejects (402 access.paywall_required).
  const access = await accessPayload(authed);
  if (access instanceof Response) return access;
  if (!(access as { canStartRating: boolean }).canStartRating) {
    return codedError(
      402,
      "access.paywall_required",
      "Both lifetime free ratings have been used or reserved. Membership is required for another rating.",
    );
  }

  const inserted = await authed.db
    .from("analysis_permits")
    .insert({ user_id: authed.id, idempotency_key: idempotencyKey })
    .select(PERMIT_COLUMNS)
    .single();
  if (inserted.error) {
    // Unique(user_id, idempotency_key) race: another request from the same
    // device won — return that permit (idempotent by contract).
    if (inserted.error.code === "23505") {
      const settled = await authed.db
        .from("analysis_permits")
        .select(PERMIT_COLUMNS)
        .eq("user_id", authed.id)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (settled.data) return respond(settled.data as unknown as PermitRow);
    }
    return unavailable("Permit reserve failed", inserted.error);
  }
  return respond(inserted.data as unknown as PermitRow);
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
    return unavailable("Permit lookup failed", found.error);
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
    return unavailable("Permit finalize failed", updated.error);
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
    if (settledRow && settledRow.outcome === outcome) return respond(settledRow);
    return codedError(
      409,
      "access.permit_already_finalized",
      `Analysis permit was already finalized as ${settledRow?.outcome ?? settledRow?.status ?? "unknown"}.`,
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

const isMs = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
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
  if (typeof value.shotType !== "string" || !value.shotType.trim()) {
    return invalid("shotType is required.");
  }
  if (typeof value.cameraView !== "string" || !CAMERA_VIEWS.has(value.cameraView)) {
    return invalid("cameraView must be side|rear_oblique.");
  }
  if (!isIsoDate(value.capturedAt)) return invalid("capturedAt must be ISO.");
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
  for (const p of value.phases) {
    if (
      !isRecord(p) ||
      typeof p.key !== "string" ||
      !p.key.trim() ||
      !isMs(p.startMs) ||
      !isMs(p.representativeMs) ||
      !isMs(p.endMs) ||
      !isUnit(p.confidence)
    ) {
      return invalid("Each phase needs key, startMs, representativeMs, endMs, confidence.");
    }
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
  for (const c of value.checkpoints) {
    if (
      !isRecord(c) ||
      typeof c.key !== "string" ||
      !c.key.trim() ||
      !(c.score === null || (typeof c.score === "number" && c.score >= 0 && c.score <= 100)) ||
      !isUnit(c.confidence) ||
      typeof c.band !== "string" ||
      !CHECKPOINT_BANDS.has(c.band) ||
      typeof c.direction !== "string" ||
      !isUnit(c.severity) ||
      typeof c.applicable !== "boolean"
    ) {
      return invalid(
        "Each checkpoint needs key, score|null, confidence, band, direction, severity, applicable.",
      );
    }
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
    if (typeof v !== "string" || !v.trim()) {
      return invalid(`versionVector.${key} is required.`);
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

/** POST /v1/shots:sync — mirrors apps/mobile/src/data/sync.ts drainOutbox
 * (lines 149-204): responds { acceptedIds, rejected:[{id,code,message}] }.
 * Client-generated UUIDs + upsert-by-id keep re-syncs idempotent. The
 * reserved permit is consumed in the same request (api.ts:107-109) — but note
 * honestly: supabase-js has no multi-statement transaction, so the
 * shot/details/permit writes are sequential with compensating cleanup, not
 * atomic like services/api upsertShots. */
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

  for (const raw of shotsRaw) {
    const rawId = isRecord(raw) && typeof raw.id === "string" ? raw.id : "unknown";
    const parsed = parseSyncShot(raw);
    if ("rejectedCode" in parsed) {
      reject(rawId, parsed.rejectedCode, parsed.rejectedMessage);
      continue;
    }
    const shot = parsed.shot;

    // Idempotent replay: this user already owns the row (a prior sync
    // committed it) — acknowledge without rewriting. Honest limitation vs.
    // services/api: there is no sync_payload_sha256 column here, so replay
    // acceptance is by id + ownership, not proven byte-exactness.
    const existing = await authed.db
      .from("shots")
      .select("id")
      .eq("id", shot.id)
      .eq("user_id", authed.id)
      .maybeSingle();
    if (existing.error) {
      reject(
        shot.id,
        "shot.lookup_failed",
        redactedDetail("Shot lookup failed", existing.error.message),
      );
      continue;
    }
    if (existing.data) {
      acceptedIds.push(shot.id);
      continue;
    }

    // The permit must still be reserved and unexpired at consumption time
    // (mirrors services/api assertUsablePermit + expireReservations).
    const permitQ = await authed.db
      .from("analysis_permits")
      .select(PERMIT_COLUMNS)
      .eq("id", shot.analysisPermitId)
      .eq("user_id", authed.id)
      .maybeSingle();
    if (permitQ.error) {
      reject(
        shot.id,
        "shot.lookup_failed",
        redactedDetail("Permit lookup failed", permitQ.error.message),
      );
      continue;
    }
    const permit = permitQ.data as unknown as PermitRow | null;
    if (!permit) {
      reject(shot.id, "access.permit_not_found", "Analysis permit not found.");
      continue;
    }
    if (permit.status !== "reserved") {
      reject(shot.id, "access.permit_not_reserved", "Analysis permit is no longer reserved.");
      continue;
    }
    if (permitIsStale(permit)) {
      // Lazy expiry: release the hold (outcome 'expired') and refuse the
      // consume, keeping the advertised expiresAt truthful.
      await authed.db
        .from("analysis_permits")
        .update({ status: "released", outcome: "expired" })
        .eq("id", permit.id)
        .eq("user_id", authed.id)
        .eq("status", "reserved");
      reject(shot.id, "access.permit_expired", "Analysis permit expired.");
      continue;
    }

    if (shot.sessionId) {
      const session = await authed.db
        .from("sessions")
        .select("id")
        .eq("id", shot.sessionId)
        .eq("user_id", authed.id)
        .maybeSingle();
      if (session.error) {
        reject(
          shot.id,
          "shot.lookup_failed",
          redactedDetail("Session lookup failed", session.error.message),
        );
        continue;
      }
      if (!session.data) {
        reject(shot.id, "shot.session_not_found", "Session not found or not yours.");
        continue;
      }
    }

    // Column mapping is exact; payload fields with no column (analysisPermitId
    // itself) are used for control flow, never stored. declared_stroke,
    // handedness, guidance, priority_fix_* and favorite are NOT in the sync
    // payload, so they stay at their column defaults — nothing is invented.
    const inserted = await authed.db.from("shots").insert({
      id: shot.id,
      user_id: authed.id,
      session_id: shot.sessionId,
      shot_type: shot.shotType,
      camera_view: shot.cameraView,
      captured_at: shot.capturedAt,
      start_ms: shot.startMs,
      contact_ms: shot.contactMs,
      end_ms: shot.endMs,
      overall_score: shot.overallScore,
      analysis_confidence: shot.confidence,
      result_kind: shot.resultKind,
      app_version: shot.versionVector.appVersion,
      model_bundle_version: shot.versionVector.modelBundleVersion,
      pose_model_version: shot.versionVector.poseModelVersion,
      paddle_model_version: shot.versionVector.paddleModelVersion,
      stroke_detector_version: shot.versionVector.strokeDetectorVersion,
      phase_model_version: shot.versionVector.phaseModelVersion,
      scoring_model_version: shot.versionVector.scoringModelVersion,
      shot_config_version: shot.versionVector.shotConfigVersion,
      source: "real",
    });
    if (inserted.error) {
      if (inserted.error.code === "23505") {
        // The id settled concurrently. Ours (race with our own retry) →
        // accept; someone else's → permanent conflict.
        const settled = await authed.db
          .from("shots")
          .select("id")
          .eq("id", shot.id)
          .eq("user_id", authed.id)
          .maybeSingle();
        if (settled.data) {
          acceptedIds.push(shot.id);
        } else {
          reject(shot.id, "shot.id_conflict", "Shot id is already bound to a different user.");
        }
        continue;
      }
      reject(
        shot.id,
        "shot.write_failed",
        redactedDetail("Shot write failed", inserted.error.message),
      );
      continue;
    }

    // Detail rows carried by the payload: phases + checkpoints. The payload
    // does NOT carry measurements (see toSyncPayload), so shot_measurements
    // is deliberately never written from sync.
    let detailError: string | null = null;
    if (shot.phases.length > 0) {
      const phases = await authed.db.from("shot_phases").upsert(
        shot.phases.map((p) => ({
          shot_id: shot.id,
          user_id: authed.id,
          phase_key: p.key,
          start_ms: p.startMs,
          representative_ms: p.representativeMs,
          end_ms: p.endMs,
          confidence: p.confidence,
        })),
        { onConflict: "shot_id,phase_key", ignoreDuplicates: true },
      );
      if (phases.error) detailError = phases.error.message;
    }
    if (!detailError && shot.checkpoints.length > 0) {
      const checkpoints = await authed.db.from("shot_checkpoints").upsert(
        shot.checkpoints.map((c) => ({
          shot_id: shot.id,
          user_id: authed.id,
          checkpoint_key: c.key,
          score: c.score,
          confidence: c.confidence,
          band: c.band,
          direction: c.direction,
          severity: c.severity,
          applicable: c.applicable,
        })),
        { onConflict: "shot_id,checkpoint_key", ignoreDuplicates: true },
      );
      if (checkpoints.error) detailError = checkpoints.error.message;
    }
    if (detailError) {
      // No transactions here: compensate by deleting the shot (cascades take
      // the partial details) so a retry starts clean instead of a replay
      // acknowledging a shot whose details were silently lost.
      await authed.db.from("shots").delete().eq("id", shot.id).eq("user_id", authed.id);
      reject(shot.id, "shot.write_failed", redactedDetail("Shot detail write failed", detailError));
      continue;
    }

    // "The shot-sync transaction consumes them" (api.ts:107-109): a scored
    // shot finalizes its permit; a synced abstention releases it. If this
    // update fails the shot stays accepted and the hold simply ages out of
    // the access window — never a lost rating.
    await authed.db
      .from("analysis_permits")
      .update({
        status: shot.resultKind === "scored" ? "finalized" : "released",
        outcome: shot.resultKind,
      })
      .eq("id", shot.analysisPermitId)
      .eq("user_id", authed.id)
      .eq("status", "reserved");

    acceptedIds.push(shot.id);
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
    return unavailable("Session create failed", upserted.error);
  }
  const owned = await authed.db
    .from("sessions")
    .select("id")
    .eq("id", body.id)
    .eq("user_id", authed.id)
    .maybeSingle();
  if (owned.error) {
    return unavailable("Session lookup failed", owned.error);
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
    return unavailable("Session lookup failed", found.error);
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
      return unavailable("Session finalize failed", updated.error);
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
    return unavailable("Consent ledger unavailable", rows.error);
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
    consent_version: consentVersion,
    action: "grant",
    source: typeof body.source === "string" ? body.source : null,
    device: typeof body.device === "string" ? body.device : null,
    capture_mode: typeof body.captureMode === "string" ? body.captureMode : null,
  });
  if (inserted.error) {
    return unavailable("Consent grant failed", inserted.error);
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
    source: typeof body.source === "string" ? body.source : null,
    device: typeof body.device === "string" ? body.device : null,
  });
  if (inserted.error) {
    return unavailable("Consent withdraw failed", inserted.error);
  }
  const rows = await loadConsentRows(authed);
  return rows instanceof Response ? rows : json(200, foldConsentStatus(rows));
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation trials
// ─────────────────────────────────────────────────────────────────────────────

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
    // trialId is client-generated and idempotent: a retried upload of the
    // same trial is acknowledged, never duplicated.
    const upserted = await authed.db
      .from("evaluation_trials")
      .upsert(
        { id: trialId, user_id: authed.id, payload: trial },
        { onConflict: "id", ignoreDuplicates: true },
      );
    if (upserted.error) {
      rejected.push({
        trialId,
        code: "evaluation.trial_write_failed",
        message: redactedDetail("Trial write failed", upserted.error.message),
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
      rejected.push({
        trialId,
        code: "evaluation.trial_write_failed",
        message: redactedDetail("Trial lookup failed", owned.error.message),
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
    return unavailable("Feedback lookup failed", shot.error);
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
    return unavailable("Feedback write failed", inserted.error);
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
  const seriesQ = await authed.db
    .from("progress_daily")
    .select("day, shot_type, scoring_model_version, shot_count, avg_score, best_score")
    .eq("user_id", authed.id)
    .order("day", { ascending: true });
  if (seriesQ.error) {
    return unavailable("Progress unavailable", seriesQ.error);
  }
  const daysQ = await authed.db
    .from("practice_days")
    .select("day")
    .eq("user_id", authed.id)
    .order("day", { ascending: true });
  if (daysQ.error) {
    return unavailable("Progress unavailable", daysQ.error);
  }

  const series = ((seriesQ.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
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
    ((daysQ.data ?? []) as Array<Record<string, unknown>>).map((row) => String(row.day)),
    new Date().toISOString().slice(0, 10),
  );
  return json(200, { series, improving: [], needsAttention: [], streak });
}

// ─────────────────────────────────────────────────────────────────────────────
// Player rank (personal, not a leaderboard)
// ─────────────────────────────────────────────────────────────────────────────

/** Tier thresholds — MUST stay identical to PLAYER_RANK_TIERS in
 * packages/shared-types/src/playerRank.ts and public.player_rank_tier() in
 * supabase/migrations/20260829150000_player_rank.sql. */
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
 * persists the saved row again. Scores here are 0-10, matching the shots
 * table verbatim (no ×10 legacy scaling on this newer endpoint). */
async function getPlayerRank(authed: AuthedUser): Promise<Response> {
  const techniquesQ = await authed.db
    .from("player_technique_rating")
    .select("shot_type, score, captured_at")
    .eq("user_id", authed.id)
    .order("shot_type", { ascending: true });
  if (techniquesQ.error) {
    return unavailable("Rank unavailable", techniquesQ.error);
  }
  const techniques = ((techniquesQ.data ?? []) as Array<Record<string, unknown>>)
    .map((row) => ({
      shot_type: String(row.shot_type),
      score: Number(row.score),
      captured_at: String(row.captured_at),
    }))
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score || (a.shot_type < b.shot_type ? -1 : 1));
  if (techniques.length === 0) {
    // No scored evidence → honestly unranked, never a fabricated Bronze.
    return json(200, { rank: null });
  }

  const stateQ = await authed.db
    .from("player_rank_state")
    .select("rating, tier, technique_count, scored_shot_count, updated_at")
    .eq("user_id", authed.id)
    .maybeSingle();
  if (stateQ.error) {
    return unavailable("Rank unavailable", stateQ.error);
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
    // Same formula as the trigger: average in integer hundredths, round
    // half away from zero to 2 decimals (Postgres round(numeric, 2)).
    const sumHundredths = techniques.reduce((sum, t) => sum + Math.round(t.score * 100), 0);
    rating = Math.round(sumHundredths / techniques.length) / 100;
    tier = playerRankTierForRating(rating);
    scoredShotCount = null;
    updatedAt = null;
  }

  return json(200, {
    rank: {
      rating,
      tier,
      techniqueCount: techniques.length,
      scoredShotCount,
      updatedAt,
      techniques,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved drills
// ─────────────────────────────────────────────────────────────────────────────

const DRILL_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;

/** The catalog swap promised by the fallback comment: drills.ts now ships the
 * seven real drill-library-v1 records (Tier-C engineering seeds, all honestly
 * UNVALIDATED). Bookmarks for slugs that ever leave the catalog degrade to a
 * placeholder entry rather than breaking the saved list. */
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
    coach_name: "Pickle Sensei (draft)",
    equipment: [],
    difficulty_min: null,
    difficulty_max: null,
  };
}

/** GET /v1/catalog/drills — mirrors apps/mobile/src/training/api.ts
 * listCatalogDrills: { items: [...], cursor: null } with q/family filters.
 * Every item carries validation_state UNVALIDATED — the client renders the
 * draft status loudly; nothing here is coach-validated. */
async function listCatalogDrills(authed: AuthedUser, url: URL): Promise<Response> {
  const items = await searchDrillCatalog({
    q: url.searchParams.get("q") ?? undefined,
    family: url.searchParams.get("family") ?? undefined,
  });
  const saved = await authed.db.from("user_saved_drills").select("slug").eq("user_id", authed.id);
  if (saved.error) {
    return unavailable("Drill catalog unavailable", saved.error);
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
    return unavailable("Drill detail unavailable", saved.error);
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
    return unavailable("Saved drills unavailable", rows.error);
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
  const upserted = await authed.db
    .from("user_saved_drills")
    .upsert({ user_id: authed.id, slug }, { onConflict: "user_id,slug", ignoreDuplicates: true });
  if (upserted.error) {
    return unavailable("Drill save failed", upserted.error);
  }
  const row = await authed.db
    .from("user_saved_drills")
    .select("slug, saved_at")
    .eq("user_id", authed.id)
    .eq("slug", slug)
    .maybeSingle();
  if (row.error || !row.data) {
    return unavailable("Drill save failed", row.error);
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
    return unavailable("Drill unsave failed", deleted.error);
  }
  return noContent();
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  // The gateway may present the pathname as /functions/v1/api/v1/… or /api/v1/…
  // depending on where it strips the mount prefix — route on everything from
  // the LAST "/v1/" segment onward so both shapes normalize identically (no
  // app route contains an interior "/v1/").
  const v1 = url.pathname.lastIndexOf("/v1/");
  const path = v1 >= 0 ? url.pathname.slice(v1) : url.pathname;
  const route = `${request.method} ${path}`;

  if (bodyTooLarge(request)) {
    return errorJson(413, "Request body is too large.");
  }

  // Session establishment/rotation happens before general authentication:
  // bootstrap is the ONLY route that accepts a provider ID token, and
  // refresh authenticates by refresh token in the body. Both are throttled
  // per IP — they are the expensive/anonymous entry points.
  if (route === "POST /v1/account/bootstrap") {
    if (rateLimited(`ip:${clientIp(request)}`, RATE_MAX_UNAUTHED)) {
      return tooManyRequests();
    }
    const exchanged = await authenticateProviderToken(request);
    if (exchanged instanceof Response) return exchanged;
    const profile = await readProfile(exchanged.authed);
    if (profile instanceof Response) return profile;
    if (profile.provider !== exchanged.authed.provider) {
      await exchanged.authed.db
        .from("profiles")
        .update({ provider: exchanged.authed.provider })
        .eq("id", exchanged.authed.id);
    }
    return json(200, {
      user: { id: profile.id, email: profile.email },
      onboardingState: profile.onboarding_state === "complete" ? "complete" : "pending",
      session: sessionView(exchanged.session),
    });
  }
  if (route === "POST /v1/auth/refresh") {
    if (rateLimited(`ip:${clientIp(request)}`, RATE_MAX_UNAUTHED)) {
      return tooManyRequests();
    }
    return refreshSessionRoute(request);
  }

  const authed = await authenticate(request);
  if (authed instanceof Response) {
    // Failed/unauthenticated requests are limited per IP so token-guessing
    // and credential-stuffing bursts get slowed down.
    if (rateLimited(`ip:${clientIp(request)}`, RATE_MAX_UNAUTHED)) {
      return tooManyRequests();
    }
    return authed;
  }
  if (rateLimited(`user:${authed.id}`, RATE_MAX_AUTHED)) {
    return tooManyRequests();
  }

  // ── Parameterized routes (an id/slug in the path) are regex-matched first;
  // everything static falls through to the exact-route switch below.
  if (request.method === "POST") {
    let m = /^\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(path);
    if (m) {
      return finalizeAnalysisPermitRoute(authed, request, decodeURIComponent(m[1]));
    }
    m = /^\/v1\/sessions\/([^/]+)\/finalize$/.exec(path);
    if (m) return finalizeSession(authed, decodeURIComponent(m[1]));
    m = /^\/v1\/analyses\/([^/]+)\/feedback$/.exec(path);
    if (m) {
      return submitAnalysisFeedback(authed, request, decodeURIComponent(m[1]));
    }
  }
  if (request.method === "PUT" || request.method === "DELETE") {
    const m = /^\/v1\/me\/saved-drills\/([^/]+)$/.exec(path);
    if (m) {
      const slug = decodeURIComponent(m[1]);
      return request.method === "PUT" ? saveDrill(authed, slug) : unsaveDrill(authed, slug);
    }
  }

  if (request.method === "GET") {
    if (path === "/v1/catalog/drills") {
      return listCatalogDrills(authed, url);
    }
    const m = /^\/v1\/catalog\/drills\/([^/]+)$/.exec(path);
    if (m) {
      return getCatalogDrill(authed, decodeURIComponent(m[1]));
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
        },
      });
    }

    case "PUT /v1/me/onboarding": {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const skillLevel = body?.skillLevel;
      const handedness = body?.handedness;
      const goal = body?.goal;
      const biggestProblem = body?.biggestProblem;
      if (
        typeof skillLevel !== "string" ||
        !skillLevel.trim() ||
        (handedness !== "right" && handedness !== "left") ||
        typeof goal !== "string" ||
        !goal.trim() ||
        typeof biggestProblem !== "string" ||
        !biggestProblem.trim()
      ) {
        return errorJson(400, "Invalid onboarding payload.");
      }
      const focusSlug = GOAL_FOCUS[goal] ?? "contact_position";
      const updated = await authed.db
        .from("profiles")
        .update({
          skill_level: skillLevel,
          handedness,
          primary_goal: goal,
          biggest_problem: biggestProblem,
          focus_checkpoint: focusSlug,
          onboarding_state: "complete",
        })
        .eq("id", authed.id)
        .select("id")
        .maybeSingle();
      if (updated.error || !updated.data) {
        return unavailable("Your coaching profile could not be saved", updated.error);
      }
      return json(200, {
        plan: { focusCheckpoint: focusSlug },
        recommendedCheckpoint: focusSlug,
      });
    }

    case "GET /v1/me/access": {
      const payload = await accessPayload(authed);
      return payload instanceof Response ? payload : json(200, payload);
    }

    case "POST /v1/billing/sync": {
      // apps/mobile/src/billing/accessApi.ts syncBilling (lines 187-194)
      // parses { billing, access } and requires billing.premium ===
      // access.premium. No store purchases exist in this deployment (receipt
      // validation stays typed-501 by design), so billing truthfully reports
      // no product and no expiry; verifiedAt is the moment this server
      // checked its own records — the only verification that happened.
      const access = await accessPayload(authed);
      if (access instanceof Response) return access;
      return json(200, {
        billing: {
          premium: false,
          productKey: null,
          expiresAt: null,
          verifiedAt: new Date().toISOString(),
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
});
