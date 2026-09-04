// stress-route-post-v1-me-consent-grant (lens: concurrency) — STATEFUL
// in-process harness for POST /v1/me/consent/grant.
//
// The REAL handler (../index.ts, Deno.serve captured, no port opened) runs
// against a modelled Supabase: GoTrue (sessions, getUser, logout) and
// PostgREST over an in-memory `consent_records` / `evaluation_trials` that
// keeps the semantics the migrations actually give those tables:
//
//   * append-only ledger — no UPDATE/DELETE path at all
//     (20260829140000_permits_sync_consent.sql §7,
//      20260831160000_defense_in_depth.sql §2)
//   * owner-only RLS on select AND insert (auth.uid() = user_id)
//   * the CHECK bounds of consent_records_bounds / consent_records_device_size
//     (20260831160000 §4, 20260831000000) — a violation answers like
//     PostgREST does (400 + SQLSTATE 23514), which the route turns into 503
//   * `created_at` is stamped at INSERT ARRIVAL (Postgres `now()` = the
//     inserting transaction's start), while the row only becomes VISIBLE at
//     commit — so a row can commit after a row that sorts before it, exactly
//     as in Postgres, and the `order created_at, id` read-back can observe it
//     late.  `clockMode: "tie"` collapses every stamp onto one instant to
//     model microsecond ties, where the (created_at, id) sort falls through
//     to the random uuid.
//
// Every upstream hop waits a SEEDED pseudo-random delay on a VIRTUAL clock
// (`scheduler`): wakes are released one distinct instant per macrotask, in
// (instant, registration) order, so Promise.all bursts against the handler
// genuinely interleave and the interleaving is a pure function of the seed —
// no real timer jitter decides who commits first.
//
// The real-Postgres half of the unit lives in stress_consent_grant_pg.test.ts.

import { envInt, histogram, Prng } from "./xc_concurrency_harness.ts";

export { envInt, histogram, Prng };

/** Deterministic replacement for setTimeout-based sleeps. `delay(ms)` parks
 * the caller until the virtual clock reaches now+ms. The pump releases the
 * earliest instant's wakes (FIFO within the instant) and yields ONE macrotask
 * before the next instant, so every continuation — and every new delay it
 * registers — settles before a later instant is released. */
export class VirtualScheduler {
  private now = 0;
  private seq = 0;
  private pending: Array<{ at: number; seq: number; resolve: () => void }> = [];
  private pumpQueued = false;
  /** wakes released since reset() — a replay signature */
  released = 0;
  /** real async ops (WebCrypto digests on the thread pool) still in flight;
   * the clock never advances while one is pending, so where their completion
   * lands relative to the next instant is not left to the OS scheduler */
  private inflightOps = 0;

  /** Wrap `crypto.subtle.digest` (the auth cache's token hash — the one
   * thread-pool op on the consent path): the pump waits for it, and calls
   * complete in CALL order (chained), so which of N concurrent bearers is
   * verified first is decided by the seed, not by thread-pool timing. */
  trackDigest(): void {
    const subtle = crypto.subtle;
    const real = subtle.digest.bind(subtle);
    let chain: Promise<unknown> = Promise.resolve();
    subtle.digest = ((algorithm: AlgorithmIdentifier, data: BufferSource) => {
      this.inflightOps += 1;
      const result = chain.then(() => real(algorithm, data));
      chain = result.catch(() => undefined);
      return result.finally(() => {
        this.inflightOps -= 1;
      });
    }) as typeof subtle.digest;
  }

  delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending.push({ at: this.now + Math.max(0, Math.floor(ms)), seq: this.seq++, resolve });
      this.queuePump();
    });
  }

  get virtualNow(): number {
    return this.now;
  }

  reset(): void {
    this.now = 0;
    this.seq = 0;
    this.released = 0;
    for (const wake of this.pending) wake.resolve();
    this.pending = [];
  }

  private queuePump(): void {
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    setTimeout(() => this.pump(), 0);
  }

  private pump(): void {
    this.pumpQueued = false;
    if (this.pending.length === 0) return;
    if (this.inflightOps > 0) {
      this.queuePump();
      return;
    }
    let at = Infinity;
    for (const wake of this.pending) if (wake.at < at) at = wake.at;
    const due = this.pending.filter((wake) => wake.at === at).sort((a, b) => a.seq - b.seq);
    this.pending = this.pending.filter((wake) => wake.at !== at);
    this.now = at;
    for (const wake of due) {
      this.released += 1;
      wake.resolve();
    }
    if (this.pending.length > 0) this.queuePump();
  }
}

export const scheduler = new VirtualScheduler();

/** Seeded, virtual-clock sleep — use INSTEAD of a real timer inside bursts. */
export const sleep = (ms: number): Promise<void> => scheduler.delay(ms);

export const SUPABASE_URL = "http://supabase.stress-consent.test";
/** wall-clock origin of the modelled Postgres `now()` (fixed for replays) */
const STAMP_EPOCH_MS = Date.UTC(2026, 8, 4, 12, 0, 0);
const ANON_KEY = "stress-consent-anon-key";
const SERVICE_ROLE_KEY = "stress-consent-service-role-key";

export const CONSENT_SCOPES = ["video_analysis", "model_training", "evaluation_telemetry"] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function b64urlDecode(segment: string): string {
  const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
  return atob(raw + "=".repeat((4 - (raw.length % 4)) % 4));
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  const seg = token.split(".")[1];
  if (!seg) return null;
  try {
    return JSON.parse(b64urlDecode(seg)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── modelled rows ───────────────────────────────────────────────────────────

export interface ConsentRecordRow {
  id: string;
  user_id: string;
  scope: string;
  consent_version: string | null;
  action: "grant" | "withdraw";
  source: string | null;
  device: unknown;
  capture_mode: string | null;
  /** now() of the inserting transaction, in ms with a sub-ms tiebreak field */
  created_at: string;
  /** monotonic sequence of the moment the row became visible (commit order) */
  visibleSeq: number;
}

export interface TrialRow {
  id: string;
  user_id: string;
  payload: unknown;
}

export interface FakeSession {
  sessionId: string;
  userId: string;
  accessToken: string;
  revoked: boolean;
}

export interface TimelineEntry {
  t: number;
  op: string;
  detail: string;
}

export type ClockMode = "distinct" | "tie";

export interface ConsentFaults {
  /** Called for every consent_records INSERT; a string is the SQLSTATE to
   * fail with (PostgREST-shaped), null lets the insert through. */
  insertFault?: (attempt: number) => { code: string; message: string } | null;
  /** Extra ms of latency on the consent_records INSERT round trip. */
  insertDelayMs?: (attempt: number) => number;
  /** Extra ms of latency on the consent_records SELECT round trip. */
  selectDelayMs?: (attempt: number) => number;
  /** Extra ms of latency on GET /auth/v1/user for a bearer. */
  getUserDelayMs?: (bearer: string) => number;
}

/** Fold the ledger the way index.ts foldConsentStatus does, over rows sorted
 * the way PostgREST returns them for `order created_at.asc,id.asc`. */
export function foldStatus(rows: ConsentRecordRow[]): {
  subjectPseudonym: null;
  scopes: Array<{
    scope: string;
    active: boolean;
    consentVersion: string | null;
    lastAction: string | null;
    lastActionAt: string | null;
  }>;
} {
  const sorted = sortLedger(rows);
  return {
    subjectPseudonym: null,
    scopes: CONSENT_SCOPES.map((scope) => {
      const last = sorted.filter((r) => r.scope === scope).at(-1) ?? null;
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

export function sortLedger(rows: ConsentRecordRow[]): ConsentRecordRow[] {
  return [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ── the modelled Supabase ───────────────────────────────────────────────────

export class FakeSupabase {
  prng: Prng;
  latencyMaxMs: number;
  clockMode: ClockMode = "distinct";
  faults: ConsentFaults = {};

  sessions = new Map<string, FakeSession>();
  accessIndex = new Map<string, string>();
  consent: ConsentRecordRow[] = [];
  trials: TrialRow[] = [];
  counters: Record<string, number> = {};
  timeline: TimelineEntry[] = [];
  /** every consent INSERT the handler issued, in arrival order */
  insertLog: Array<{
    seq: number;
    userId: string | null;
    scope: string;
    action: string;
    created_at: string;
    outcome: "committed" | "rls_denied" | "check_violation" | "fault";
  }> = [];

  private mint = 0;
  private epoch = 0;
  private seq = 0;
  private tieStamp = "";
  private t0 = performance.now();

  constructor(seed: number, latencyMaxMs: number) {
    this.prng = new Prng(seed);
    this.latencyMaxMs = latencyMaxMs;
  }

  reset(seed: number, latencyMaxMs = this.latencyMaxMs): void {
    scheduler.reset();
    this.prng = new Prng(seed);
    this.latencyMaxMs = latencyMaxMs;
    this.clockMode = "distinct";
    this.faults = {};
    this.sessions.clear();
    this.accessIndex.clear();
    this.consent = [];
    this.trials = [];
    this.counters = {};
    this.timeline = [];
    this.insertLog = [];
    this.mint = 0;
    this.seq = 0;
    this.epoch += 1;
    this.tieStamp = new Date(STAMP_EPOCH_MS).toISOString();
    this.t0 = performance.now();
  }

  count(key: string): void {
    this.counters[key] = (this.counters[key] ?? 0) + 1;
  }

  log(op: string, detail: string): void {
    this.timeline.push({
      t: Math.round((performance.now() - this.t0) * 100) / 100,
      op,
      detail,
    });
  }

  private async latency(): Promise<void> {
    if (this.latencyMaxMs > 0) await sleep(this.prng.int(0, this.latencyMaxMs));
  }

  /** Postgres now(): the inserting transaction's start time, read off the
   * VIRTUAL clock so a replay stamps identical rows. "distinct" keeps the
   * stamps strictly increasing (real clocks at microsecond resolution); "tie"
   * collapses them onto one instant. */
  private stampNow(): string {
    if (this.clockMode === "tie") return this.tieStamp;
    this.seq += 1;
    const micro = String(this.seq).padStart(6, "0");
    const seconds = new Date(STAMP_EPOCH_MS + scheduler.virtualNow).toISOString().slice(0, 19);
    return `${seconds}.${micro}Z`;
  }

  mintSession(userId: string): FakeSession {
    this.mint += 1;
    const sid = `sess-${this.epoch}.${this.mint}-${this.prng.uuid()}`;
    const accessToken = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
      JSON.stringify({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: sid,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: `${this.epoch}.${this.mint}-${this.prng.uuid()}`,
      }),
    )}.sig`;
    const session: FakeSession = { sessionId: sid, userId, accessToken, revoked: false };
    this.sessions.set(sid, session);
    this.accessIndex.set(accessToken, sid);
    return session;
  }

  userJson(userId: string) {
    return {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: `${userId.slice(0, 8)}@example.com`,
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    };
  }

  /** The acting principal of a PostgREST call, from its bearer. */
  principal(headers: Headers): { role: "service" | "user" | "anon"; userId: string | null } {
    const auth = headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token === SERVICE_ROLE_KEY) return { role: "service", userId: null };
    if (!token || token === ANON_KEY) return { role: "anon", userId: null };
    const payload = jwtPayload(token);
    const sub = typeof payload?.sub === "string" ? payload.sub : null;
    return { role: "user", userId: sub };
  }

  /** consent_records_bounds + consent_records_device_size (both CHECKs). */
  private checkBounds(row: {
    scope: string;
    consent_version: string | null;
    source: string | null;
    capture_mode: string | null;
    device: unknown;
  }): string | null {
    const len = (v: string | null) => (v === null ? 0 : v.length);
    if (row.scope.length > 50) return "scope";
    if (len(row.consent_version) > 50) return "consent_version";
    if (len(row.source) > 100) return "source";
    if (len(row.capture_mode) > 50) return "capture_mode";
    const deviceBytes = row.device === null ? 0 : JSON.stringify(row.device).length;
    if (deviceBytes > 4096) return "device";
    return null;
  }

  // ── fetch dispatcher ──

  async handleFetch(request: Request, rawBody: string): Promise<Response> {
    const url = new URL(request.url);
    const jsonResponse = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    let body: Record<string, unknown> = {};
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody);
        body = isRecord(parsed) ? parsed : { _array: parsed };
      } catch {
        body = {};
      }
    }

    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
      const path = url.pathname.slice("/auth/v1/".length);
      if (path === "user" && request.method === "GET") {
        this.count("gotrue.get_user");
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        await this.latency();
        const sid = this.accessIndex.get(bearer);
        const session = sid ? this.sessions.get(sid) : undefined;
        const extra = this.faults.getUserDelayMs?.(bearer) ?? 0;
        if (extra > 0) await sleep(extra);
        if (!session || session.revoked) {
          this.log("gotrue.get_user", `bearer=…${bearer.slice(-8)} → 403 session_not_found`);
          return jsonResponse(403, {
            code: 403,
            error_code: "session_not_found",
            msg: "Session from session_id claim in JWT does not exist",
          });
        }
        return jsonResponse(200, this.userJson(session.userId));
      }
      if (path === "logout" && request.method === "POST") {
        this.count("gotrue.logout");
        await this.latency();
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const sid = this.accessIndex.get(bearer);
        const session = sid ? this.sessions.get(sid) : undefined;
        if (session) {
          session.revoked = true;
          this.log("gotrue.logout", `session=${session.sessionId} revoked`);
        }
        return new Response(null, { status: 204 });
      }
      return jsonResponse(404, { msg: `stress harness: unmodelled auth path ${path}` });
    }

    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      const table = url.pathname.slice("/rest/v1/".length);
      const who = this.principal(request.headers);
      if (table === "consent_records") {
        return await this.consentRest(request, url, body, who, jsonResponse);
      }
      if (table === "evaluation_trials") {
        return await this.trialsRest(request, url, body, who, jsonResponse);
      }
      return jsonResponse(404, {
        code: "PGRST205",
        message: `table ${table} not modelled by the stress harness`,
      });
    }
    return new Response(`stress harness: unexpected fetch ${request.method} ${request.url}`, {
      status: 599,
    });
  }

  private async consentRest(
    request: Request,
    url: URL,
    body: Record<string, unknown>,
    who: { role: "service" | "user" | "anon"; userId: string | null },
    jsonResponse: (status: number, body: unknown) => Response,
  ): Promise<Response> {
    if (request.method === "GET") {
      this.count("rest.select.consent_records");
      await this.latency();
      const extra = this.faults.selectDelayMs?.(this.counters["rest.select.consent_records"]) ?? 0;
      if (extra > 0) await sleep(extra);
      const userFilter = url.searchParams.get("user_id") ?? "";
      const wanted = userFilter.startsWith("eq.") ? userFilter.slice(3) : null;
      // RLS: owner-only select; PostgREST then applies the eq filter.
      const visible =
        who.role === "service"
          ? this.consent
          : who.userId
            ? this.consent.filter((r) => r.user_id === who.userId)
            : [];
      const rows = sortLedger(wanted ? visible.filter((r) => r.user_id === wanted) : visible).map(
        (r) => ({
          scope: r.scope,
          action: r.action,
          consent_version: r.consent_version,
          created_at: r.created_at,
        }),
      );
      return jsonResponse(200, rows);
    }
    if (request.method === "POST") {
      this.count("rest.insert.consent_records");
      const attempt = this.counters["rest.insert.consent_records"];
      // Transaction start: now() is stamped here, before any wait.
      const created_at = this.stampNow();
      const incoming = Array.isArray(body._array)
        ? (body._array as Array<Record<string, unknown>>)
        : [body];
      await this.latency();
      const extra = this.faults.insertDelayMs?.(attempt) ?? 0;
      if (extra > 0) await sleep(extra);
      const fault = this.faults.insertFault?.(attempt) ?? null;
      if (fault) {
        this.insertLog.push({
          seq: attempt,
          userId: who.userId,
          scope: String(incoming[0]?.scope ?? ""),
          action: String(incoming[0]?.action ?? ""),
          created_at,
          outcome: "fault",
        });
        this.log("rest.insert.consent_records", `attempt=${attempt} → fault ${fault.code}`);
        return jsonResponse(fault.code === "23514" ? 400 : 503, {
          code: fault.code,
          message: fault.message,
          details: null,
          hint: null,
        });
      }
      for (const raw of incoming) {
        const rowUser = raw.user_id === undefined ? null : String(raw.user_id);
        if (who.role === "user" && rowUser !== who.userId) {
          this.insertLog.push({
            seq: attempt,
            userId: who.userId,
            scope: String(raw.scope ?? ""),
            action: String(raw.action ?? ""),
            created_at,
            outcome: "rls_denied",
          });
          return jsonResponse(403, {
            code: "42501",
            message: 'new row violates row-level security policy for table "consent_records"',
            details: null,
            hint: null,
          });
        }
        if (who.role === "anon" || rowUser === null) {
          return jsonResponse(403, {
            code: "42501",
            message: "permission denied for table consent_records",
            details: null,
            hint: null,
          });
        }
        const candidate = {
          scope: String(raw.scope ?? ""),
          consent_version: raw.consent_version === null ? null : String(raw.consent_version ?? ""),
          source: raw.source === null || raw.source === undefined ? null : String(raw.source),
          capture_mode:
            raw.capture_mode === null || raw.capture_mode === undefined
              ? null
              : String(raw.capture_mode),
          device: raw.device ?? null,
        };
        const violated = this.checkBounds(candidate);
        if (violated !== null) {
          this.insertLog.push({
            seq: attempt,
            userId: who.userId,
            scope: candidate.scope,
            action: String(raw.action ?? ""),
            created_at,
            outcome: "check_violation",
          });
          this.log(
            "rest.insert.consent_records",
            `attempt=${attempt} → 23514 on ${violated} (len=${
              String(candidate[violated as "consent_version"] ?? "").length
            })`,
          );
          return jsonResponse(400, {
            code: "23514",
            message:
              'new row for relation "consent_records" violates check constraint "consent_records_bounds"',
            details: null,
            hint: null,
          });
        }
        this.seq += 1;
        const row: ConsentRecordRow = {
          id: this.prng.uuid(),
          user_id: rowUser,
          scope: candidate.scope,
          consent_version: candidate.consent_version,
          action: raw.action === "withdraw" ? "withdraw" : "grant",
          source: candidate.source,
          device: candidate.device,
          capture_mode: candidate.capture_mode,
          created_at,
          visibleSeq: this.seq,
        };
        // COMMIT: the row becomes visible now, which may be after a row that
        // sorts before it (later transaction start, earlier commit).
        this.consent.push(row);
        this.insertLog.push({
          seq: attempt,
          userId: who.userId,
          scope: row.scope,
          action: row.action,
          created_at,
          outcome: "committed",
        });
        this.log(
          "rest.insert.consent_records",
          `attempt=${attempt} user=${row.user_id.slice(0, 8)} ${row.action} ${row.scope} → committed`,
        );
      }
      return new Response(null, { status: 201 });
    }
    // Append-only: no UPDATE/DELETE grant and no RLS policy exists.
    return jsonResponse(403, {
      code: "42501",
      message: `permission denied for table consent_records (${request.method})`,
      details: null,
      hint: null,
    });
  }

  private async trialsRest(
    request: Request,
    url: URL,
    body: Record<string, unknown>,
    who: { role: "service" | "user" | "anon"; userId: string | null },
    jsonResponse: (status: number, body: unknown) => Response,
  ): Promise<Response> {
    await this.latency();
    if (request.method === "GET") {
      this.count("rest.select.evaluation_trials");
      const idFilter = url.searchParams.get("id") ?? "";
      const wantedId = idFilter.startsWith("eq.") ? idFilter.slice(3) : null;
      const visible = who.userId ? this.trials.filter((t) => t.user_id === who.userId) : [];
      const rows = visible.filter((t) => wantedId === null || t.id === wantedId);
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("application/vnd.pgrst.object+json")) {
        if (rows.length === 0) {
          return jsonResponse(406, {
            code: "PGRST116",
            message: "0 rows",
            details: null,
            hint: null,
          });
        }
        return jsonResponse(200, rows[0]);
      }
      return jsonResponse(200, rows);
    }
    if (request.method === "POST") {
      this.count("rest.insert.evaluation_trials");
      const incoming = Array.isArray(body._array)
        ? (body._array as Array<Record<string, unknown>>)
        : [body];
      for (const raw of incoming) {
        const id = String(raw.id ?? "");
        const rowUser = raw.user_id === undefined ? null : String(raw.user_id);
        if (who.role === "user" && rowUser !== who.userId) {
          return jsonResponse(403, { code: "42501", message: "rls", details: null, hint: null });
        }
        if (this.trials.some((t) => t.id === id)) continue; // ignoreDuplicates
        this.trials.push({ id, user_id: String(rowUser), payload: raw.payload });
      }
      return new Response(null, { status: 201 });
    }
    return jsonResponse(405, { message: "not modelled" });
  }
}

// ── loading the real handler ────────────────────────────────────────────────

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  fake: FakeSupabase;
  upstreamCalls: Array<{ t: number; method: string; url: string }>;
}

let loaded: StressHarness | null = null;

export async function loadStressHarness(): Promise<StressHarness> {
  if (loaded) return loaded;
  scheduler.trackDigest();
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-consent-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress_consent");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const fake = new FakeSupabase(1, 0);
  const upstreamCalls: StressHarness["upstreamCalls"] = [];
  const t0 = performance.now();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    upstreamCalls.push({
      t: Math.round((performance.now() - t0) * 100) / 100,
      method: request.method,
      url: request.url,
    });
    return fake.handleFetch(request, rawBody);
  }) as typeof fetch;

  let handler: StressHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      StressHarness["handler"] | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) {
    throw new Error("index.ts did not register a Deno.serve handler");
  }
  loaded = { handler, fake, upstreamCalls };
  return loaded;
}

// ── request builders ────────────────────────────────────────────────────────

export function edgeRequest(
  method: string,
  path: string,
  options: {
    token?: string | null;
    ip?: string;
    body?: unknown;
    /** raw body stream that fails part-way (models a cancelled upload) */
    truncatedBody?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "198.51.100.24",
    ...options.headers,
  });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body !== undefined || options.truncatedBody !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  let body: BodyInit | undefined;
  if (options.truncatedBody !== undefined) {
    const bytes = new TextEncoder().encode(options.truncatedBody);
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        // The client goes away mid-upload: the stream errors, never closes.
        controller.error(new Error("stress: client cancelled the request body"));
      },
    });
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
  }
  return new Request(`http://edge.stress-consent.test/functions/v1/api${path}`, {
    method,
    headers,
    body,
    ...(body instanceof ReadableStream ? ({ duplex: "half" } as RequestInit) : {}),
  });
}

export function grantBody(
  scope: ConsentScope,
  version: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    scope,
    consentVersion: version,
    source: "mobile_settings",
    device: "iPhone15,2 iOS 18.2",
    captureMode: "all_captures",
    ...extra,
  };
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : { _value: parsed };
  } catch {
    return { _raw: text };
  }
}

export interface StatusView {
  scopes: Record<
    string,
    { active: boolean; consentVersion: string | null; lastAction: string | null }
  >;
}

/** Parse the route's response body into a comparable status view. */
export function statusView(body: Record<string, unknown>): StatusView | null {
  const scopes = body.scopes;
  if (!Array.isArray(scopes)) return null;
  const out: StatusView["scopes"] = {};
  for (const entry of scopes) {
    if (!isRecord(entry) || typeof entry.scope !== "string") return null;
    out[entry.scope] = {
      active: entry.active === true,
      consentVersion: typeof entry.consentVersion === "string" ? entry.consentVersion : null,
      lastAction: typeof entry.lastAction === "string" ? entry.lastAction : null,
    };
  }
  return { scopes: out };
}

// ── reporting ───────────────────────────────────────────────────────────────

export interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

export interface IterationRecord {
  scenario: string;
  seed: number;
  requests: number;
  statusHistogram: Record<string, number>;
  rowsCommitted: number;
  /** virtual-clock ms consumed + wakes released — identical on every replay */
  schedule: { virtualMs: number; wakes: number };
  invariants: Invariant[];
  observations: Record<string, unknown>;
  durationMs: number;
  replay: string;
  pass: boolean;
}

export interface CampaignReport {
  unit: string;
  lens: string;
  target: string;
  plane: string;
  startedAt: string;
  finishedAt: string;
  scale: Record<string, number>;
  totals: {
    iterations: number;
    requests: number;
    failedIterations: number;
    statusHistogram: Record<string, number>;
  };
  failedSeeds: Array<{ scenario: string; seed: number; invariants: string[] }>;
  iterations: IterationRecord[];
  heap: { before: Deno.MemoryUsage; after: Deno.MemoryUsage };
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-consent-grant/latest/", import.meta.url).pathname;
}

export async function writeCampaign(name: string, report: CampaignReport): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
/** Iterations (distinct seeds) per scenario. Small by default so the file
 * lives in `deno task test`; the campaign runs with STRESS_ITER=42. */
export const STRESS_ITER = envInt("STRESS_ITER", 3);
export const STRESS_BURST = envInt("STRESS_BURST", 12);
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 6);

export function replayCommand(scenario: string, seed: number): string {
  return (
    `STRESS_SEED=${seed} STRESS_ITER=1 STRESS_BURST=${STRESS_BURST} ` +
    `STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ` +
    `stress_consent_grant_concurrency.test.ts --filter "${scenario}"`
  );
}
