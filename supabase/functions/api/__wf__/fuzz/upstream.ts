// Fuzz-campaign upstream: a stricter, richer fake Supabase (Auth + PostgREST)
// layered over routesHarness so every request reaches route logic instead of
// dying on a stub gap, and every outbound call is classified read/write.
//
// Nothing here touches a network: `globalThis.fetch` is already the
// routesHarness stub when `installFuzzUpstream` runs; unknown URLs delegate
// to it (which answers 599 for anything unexpected).

import { type Harness, SUPABASE_URL, TEST_USER_ID } from "../routesHarness.ts";

export type CallKind =
  | "db_read"
  | "db_write"
  | "rpc_read"
  | "rpc_write"
  | "auth_exchange"
  | "auth_verify"
  | "auth_refresh"
  | "auth_logout"
  | "auth_admin_write"
  | "revenuecat_read"
  | "revenuecat_write"
  | "apple_exchange"
  | "apple_revoke"
  | "unknown";

export const WRITE_KINDS: ReadonlySet<CallKind> = new Set<CallKind>([
  "db_write",
  "rpc_write",
  "auth_admin_write",
  "revenuecat_write",
  "apple_revoke",
]);

export interface ClassifiedCall {
  kind: CallKind;
  method: string;
  /** Table, rpc name, or endpoint (never a full URL with ids). */
  target: string;
  url: string;
  bodyBytes: number;
  /** Present for writes only (capped) so a finding can show what was written. */
  bodyPreview?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READ_RPCS = new Set(["access_state"]);
const FIXED_NOW = "2026-09-01T12:00:00.000Z";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  return decodeSegment(parts[1]);
}

/** A fuzz "verified" identity: the token is syntactically a JWT, `sub` is a
 * UUID and `exp` a future number. (Real GoTrue verifies signatures; the
 * fuzz campaign never has a valid signature, so this stands in for it.) */
function verifiedSubject(token: string): string | null {
  const payload = jwtPayload(token);
  if (!payload) return null;
  const sub = payload.sub;
  const exp = payload.exp;
  if (typeof sub !== "string" || !UUID_RE.test(sub)) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp * 1000 <= Date.now()) return null;
  return sub.toLowerCase();
}

/** Deterministic pseudo-UUID from a string (for challenges, permit ids). */
export function derivedUuid(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i += 1) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ seed.charCodeAt(i), 0x811c9dc5) >>> 0;
  }
  const hex = (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(2);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Challenge that `POST /v1/me/delete-confirm` will accept for `userId`. */
export const deletionChallengeFor = (userId: string): string => derivedUuid(`challenge:${userId}`);

/** Users whose UUID ends in an even hex digit hold every consent scope. */
export const hasConsent = (userId: string): boolean =>
  /[02468ace]$/i.test(userId.replace(/-/g, ""));

function filterValue(params: URLSearchParams, column: string): string | null {
  const raw = params.get(column);
  if (!raw) return null;
  const m = /^eq\.(.*)$/.exec(raw);
  return m ? m[1] : null;
}

function inList(params: URLSearchParams, column: string): string[] {
  const raw = params.get(column);
  const m = raw ? /^in\.\((.*)\)$/.exec(raw) : null;
  if (!m) return [];
  return m[1]
    .split(",")
    .map((v) => v.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

interface TableContext {
  table: string;
  params: URLSearchParams;
  userId: string | null;
}

/** Rows a GET on `table` returns under the fuzz fixtures. Ownership filters
 * are honoured only as far as the fixture semantics need (every row belongs
 * to the requesting user; ids echo the filter so lookups "find" the row). */
function fixtureRows(ctx: TableContext): unknown[] {
  const { table, params } = ctx;
  const userId = ctx.userId ?? TEST_USER_ID;
  const id = filterValue(params, "id");
  switch (table) {
    case "profiles":
      return [
        {
          id: id ?? userId,
          email: "fuzz@example.com",
          onboarding_state: "complete",
          provider: "google",
          skill_level: "intermediate",
          handedness: "right",
          primary_goal: "consistency",
          biggest_problem: "popping up dinks",
          focus_checkpoint: "contact_position",
          first_name: "Fuzz",
          gender: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ];
    case "analysis_permits":
      return id ? [{ id, status: "reserved", outcome: null, created_at: FIXED_NOW }] : [];
    case "sessions":
      return id ? [{ id, ended_at: null }] : [];
    case "shots": {
      // Feedback looks a single shot up; sync replay detection uses in.(…).
      if (id) return [{ id }];
      return inList(params, "id").length > 0 ? [] : [];
    }
    case "consent_records":
      return hasConsent(userId)
        ? ["video_analysis", "model_training", "evaluation_telemetry"].map((scope) => ({
            scope,
            action: "grant",
            consent_version: "2026-08-01",
            created_at: "2026-08-01T00:00:00.000Z",
          }))
        : [];
    case "evaluation_trials":
      return id ? [{ id }] : [];
    case "user_saved_drills": {
      const slug = filterValue(params, "slug");
      return slug ? [{ slug, saved_at: FIXED_NOW }] : [];
    }
    case "account_deletion_requests":
      return [
        {
          challenge: deletionChallengeFor(userId),
          created_at: new Date(Date.now() - 60_000).toISOString(),
          expires_at: new Date(Date.now() + 14 * 60_000).toISOString(),
        },
      ];
    case "account_external_credentials":
      return [];
    case "billing_entitlements":
    case "webhook_events":
    case "progress_daily":
    case "practice_days":
    case "player_technique_rating":
    case "player_rank_state":
    case "shot_phases":
    case "shot_checkpoints":
    case "analysis_feedback":
    default:
      return [];
  }
}

function rpcResult(fn: string, body: unknown): unknown | null {
  switch (fn) {
    case "access_state":
      return [{ premium: false, scored_count: 0, reserved_count: 0 }];
    case "reserve_analysis_permit": {
      const key =
        isRecord(body) && typeof body.p_idempotency_key === "string" ? body.p_idempotency_key : "";
      return [
        {
          result: "accepted",
          permit_id: derivedUuid(`permit:${key}`),
          permit_status: "reserved",
          permit_outcome: null,
          permit_created_at: FIXED_NOW,
        },
      ];
    }
    case "apply_synced_shot":
      return "accepted";
    default:
      return null;
  }
}

function classify(method: string, url: URL): { kind: CallKind; target: string } {
  const path = url.pathname;
  if (url.origin === SUPABASE_URL) {
    if (path.startsWith("/rest/v1/rpc/")) {
      const fn = path.slice("/rest/v1/rpc/".length);
      return { kind: READ_RPCS.has(fn) ? "rpc_read" : "rpc_write", target: `rpc:${fn}` };
    }
    if (path.startsWith("/rest/v1/")) {
      const table = path.slice("/rest/v1/".length);
      return {
        kind: method === "GET" || method === "HEAD" ? "db_read" : "db_write",
        target: `table:${table}`,
      };
    }
    if (path.startsWith("/auth/v1/token")) {
      const grant = url.searchParams.get("grant_type") ?? "";
      return {
        kind: grant === "refresh_token" ? "auth_refresh" : "auth_exchange",
        target: `auth:token:${grant}`,
      };
    }
    if (path === "/auth/v1/user") return { kind: "auth_verify", target: "auth:user" };
    if (path === "/auth/v1/logout") return { kind: "auth_logout", target: "auth:logout" };
    if (path.startsWith("/auth/v1/admin/")) {
      return { kind: "auth_admin_write", target: `auth:admin:${method}` };
    }
    return { kind: "unknown", target: `supabase:${path}` };
  }
  if (url.hostname === "api.revenuecat.com") {
    return {
      kind: method === "GET" ? "revenuecat_read" : "revenuecat_write",
      target: `revenuecat:${method}`,
    };
  }
  if (url.hostname === "appleid.apple.com") {
    return path.endsWith("/revoke")
      ? { kind: "apple_revoke", target: "apple:revoke" }
      : { kind: "apple_exchange", target: "apple:token" };
  }
  return { kind: "unknown", target: `${url.hostname}${path}` };
}

export interface FuzzUpstream {
  /** Calls made since the last `drain()`. */
  drain(): ClassifiedCall[];
  /** Total calls observed for the whole campaign. */
  readonly total: number;
  uninstall(): void;
}

/** Replace `globalThis.fetch` (currently the routesHarness stub) with the
 * fuzz upstream. Returns a handle for draining classified calls. */
export function installFuzzUpstream(harness: Harness): FuzzUpstream {
  const delegate = globalThis.fetch;
  let pending: ClassifiedCall[] = [];
  let total = 0;

  const fuzzFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const text = await request
      .clone()
      .text()
      .catch(() => "");
    const { kind, target } = classify(method, url);
    const call: ClassifiedCall = {
      kind,
      method,
      target,
      url: request.url,
      bodyBytes: new TextEncoder().encode(text).byteLength,
    };
    if (WRITE_KINDS.has(kind)) call.bodyPreview = text.slice(0, 2_048);
    pending.push(call);
    total += 1;

    // ── Supabase Auth ───────────────────────────────────────────────────
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/token")) {
      let body: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(text) as unknown;
        if (isRecord(parsed)) body = parsed;
      } catch {
        body = {};
      }
      const grant = url.searchParams.get("grant_type");
      if (grant === "id_token") {
        const token = typeof body.id_token === "string" ? body.id_token : "";
        const sub = verifiedSubject(token);
        if (!sub) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Bad ID token",
          });
        }
        return sessionResponse(sub);
      }
      if (grant === "refresh_token") {
        const token = typeof body.refresh_token === "string" ? body.refresh_token : "";
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(token)) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Invalid Refresh Token: Refresh Token Not Found",
          });
        }
        return sessionResponse(TEST_USER_ID);
      }
      return jsonResponse(400, { error: "unsupported_grant_type" });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user") {
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const sessionMatch = /^session-for-(.+)$/.exec(bearer);
      const sub = sessionMatch
        ? UUID_RE.test(sessionMatch[1])
          ? sessionMatch[1].toLowerCase()
          : null
        : verifiedSubject(bearer);
      if (!sub) {
        return jsonResponse(401, {
          code: 401,
          error_code: "bad_jwt",
          msg: "invalid JWT: unable to parse or verify signature",
        });
      }
      return jsonResponse(200, userRecord(sub));
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/logout") {
      return new Response(null, { status: 204 });
    }

    // ── PostgREST ────────────────────────────────────────────────────────
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      const table = url.pathname.slice("/rest/v1/".length);
      const accept = request.headers.get("accept") ?? "";
      const prefer = request.headers.get("prefer") ?? "";
      const wantsObject = accept.includes("application/vnd.pgrst.object+json");
      let body: unknown = null;
      try {
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        body = null;
      }
      if (table.startsWith("rpc/")) {
        const fn = table.slice("rpc/".length);
        const result = rpcResult(fn, body);
        if (result === null) return delegate(request);
        return jsonResponse(200, result);
      }
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const sessionMatch = /^session-for-(.+)$/.exec(bearer);
      const userId =
        filterValue(url.searchParams, "user_id") ??
        (sessionMatch ? sessionMatch[1] : verifiedSubject(bearer)) ??
        filterValue(url.searchParams, "id");
      if (method === "GET" || method === "HEAD") {
        const rows = fixtureRows({ table, params: url.searchParams, userId });
        if (wantsObject) {
          if (rows.length === 0) {
            return jsonResponse(406, {
              code: "PGRST116",
              message: "JSON object requested, multiple (or no) rows returned",
              details: "The result contains 0 rows",
              hint: null,
            });
          }
          return jsonResponse(200, rows[0]);
        }
        return jsonResponse(200, rows, { "Content-Range": `0-${Math.max(0, rows.length - 1)}/*` });
      }
      if (method === "POST" || method === "PATCH" || method === "PUT") {
        const representation = prefer.includes("return=representation") || wantsObject;
        if (!representation) return new Response(null, { status: method === "POST" ? 201 : 204 });
        const payload = Array.isArray(body) ? body[0] : body;
        const row = {
          id: derivedUuid(`row:${table}:${text.length}`),
          created_at: FIXED_NOW,
          ...(isRecord(payload) ? payload : {}),
        };
        return jsonResponse(method === "POST" ? 201 : 200, wantsObject ? row : [row]);
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
    }

    return delegate(request);
  };

  globalThis.fetch = fuzzFetch as typeof fetch;

  return {
    drain() {
      const out = pending;
      pending = [];
      return out;
    },
    get total() {
      return total;
    },
    uninstall() {
      globalThis.fetch = delegate;
      harness.calls = [];
    },
  };
}

function userRecord(sub: string) {
  return {
    id: sub,
    aud: "authenticated",
    role: "authenticated",
    email: "fuzz@example.com",
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: {},
    identities: [{ provider: "google", identity_id: sub, id: sub, user_id: sub }],
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function sessionResponse(sub: string): Response {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return jsonResponse(200, {
    access_token: `session-for-${sub}`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: `refresh-${sub.slice(0, 8)}`,
    user: userRecord(sub),
  });
}
