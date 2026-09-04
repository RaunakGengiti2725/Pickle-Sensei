/**
 * stress — `GET /v1/me/consent/status` under CONCURRENCY (in-process half).
 *
 * Drives the REAL edge handler (../index.ts, Deno.serve captured by
 * xc_concurrency_harness.ts) with Promise.all bursts over a SEEDED, latency-
 * injecting model of Supabase Auth + PostgREST. The consent ledger itself is
 * modelled here (the shared harness does not model `consent_records`, and
 * ignores PostgREST `order=`): rows commit at a modelled monotonic server
 * clock, every SELECT snapshots the committed rows at the instant it executes
 * (after its latency), sorted exactly as PostgREST sorts
 * `order=created_at.asc,id.asc` (uuid order == lowercase-hex string order).
 *
 * One campaign = STRESS_ITER iterations; iteration i uses seed STRESS_SEED+i,
 * and the seed alone decides the scenario, actors, ledger, burst size,
 * latency, jitter, fault points and the interleaving inputs. Scenarios:
 *
 *   dup-burst          N identical GETs (1–2 devices) over a fixed ledger
 *   read-write-race    device A appends (POST grant/withdraw) while device B
 *                      reads — every GET must be a LINEARIZABLE snapshot
 *                      (fold of the rows committed at some instant between the
 *                      request's start and end), no lost/duplicate rows
 *   logout-during-read POST /v1/auth/logout races the GET burst; every GET
 *                      that STARTS after the logout completed must be 401,
 *                      the other device's session must be untouched
 *   refresh-during-read POST /v1/auth/refresh rotates the session mid-burst;
 *                      the pre-rotation access token stays valid until exp
 *   abort-during-read  the client aborts a subset of requests mid-flight
 *   cross-user         2–3 users interleaved + anonymous / forged / expired
 *                      (clock-skewed) bearers — never another user's ledger
 *   upstream-fault     PostgREST fails a seeded subset of SELECTs — 503 with
 *                      the generic body, no detail leak, no cross-effect
 *   clock-skew-ledger  the DB clock steps BACKWARDS between two appends of
 *                      the same scope (and exact created_at ties): the route
 *                      must stay deterministic (every reader agrees with the
 *                      created_at/id fold); whether that fold equals COMMIT
 *                      order is recorded as an observation, not an assertion
 *   rate-limit-exact   240+k concurrent GETs — exactly 240 admitted, k × 429
 *                      (the per-user budget must not over-admit under a burst)
 *
 * Every iteration: all statuses ∈ the scenario's allowed set, never 5xx
 * (except the injected faults, which must be 503 with the generic body),
 * response shape pinned, one PostgREST SELECT per served GET (no fan-out or
 * retry storm), and a wall-time bound (no deadlock / hang).
 *
 *   deno test -A --no-check --config deno.json stress_consent_status_concurrency.test.ts
 *   STRESS_ITER=600 STRESS_OUT_DIR=/tmp/stress deno test -A --no-check --config deno.json stress_consent_status_concurrency.test.ts
 *   STRESS_ONLY_SEED=<seed> deno test -A --no-check --config deno.json stress_consent_status_concurrency.test.ts   # replay one seed
 *
 * Output: <STRESS_OUT_DIR>/consent_status_concurrency.json — a seed → outcome
 * table (HELD | BROKEN, failed invariants, observations, replay command) plus
 * a per-scenario summary. Default STRESS_ITER is small so the file lives in
 * the suite; the campaign scale is opt-in.
 */
import { assert, assertEquals } from "@std/assert";
import {
  b64url,
  bootstrap,
  edgeRequest,
  envInt,
  type FakeSupabase,
  isRecord,
  jwtPayload,
  loadXcHarness,
  Prng,
  readJson,
  sleep,
  SUPABASE_URL,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_ITER = envInt("STRESS_ITER", 12);
/** every Nth iteration runs the 240+k rate-limit burst instead of a seeded scenario */
const STRESS_RATE_EVERY = envInt("STRESS_RATE_EVERY", 6);
const STRESS_ITER_BUDGET_MS = envInt("STRESS_ITER_BUDGET_MS", 8_000);
const ONLY_SEED = Deno.env.get("STRESS_ONLY_SEED");
const ONLY_SCENARIO = Deno.env.get("STRESS_SCENARIO") ?? "";

const CONSENT_SCOPES = [
  "video_analysis",
  "model_training",
  "evaluation_telemetry",
] as const;
type Scope = (typeof CONSENT_SCOPES)[number];

const ROUTE = "/v1/me/consent/status";
const TEST_FILE = "stress_consent_status_concurrency.test.ts";

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-consent-status/latest/",
    import.meta.url,
  ).pathname;
}

// ── Consent ledger model (PostgREST `consent_records`) ───────────────────────

interface LedgerRow {
  id: string;
  user_id: string;
  scope: string;
  action: "grant" | "withdraw";
  consent_version: string | null;
  source: string | null;
  device: unknown;
  capture_mode: string | null;
  /** modelled server clock, microseconds since epoch */
  createdUs: number;
  /** commit index (0-based) and wall-clock commit instant */
  commitIndex: number;
  committedAt: number;
}

function isoMicros(us: number): string {
  const ms = Math.floor(us / 1000);
  const micro = us - ms * 1000;
  const base = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  return `${base.slice(0, -1)}${String(micro).padStart(3, "0")}+00:00`;
}

/** PostgREST order for `order=created_at.asc,id.asc` — timestamptz then uuid
 * (uuid compares bytewise == lowercase hex string order). */
function pgOrder(a: LedgerRow, b: LedgerRow): number {
  if (a.createdUs !== b.createdUs) return a.createdUs - b.createdUs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface FoldedScope {
  scope: string;
  active: boolean;
  consentVersion: string | null;
  lastAction: "granted" | "withdrawn" | null;
  lastActionAt: string | null;
}

/** The route's contract (index.ts foldConsentStatus) computed from the
 * model — the oracle every served response is compared against. */
function oracleFold(
  rows: LedgerRow[],
): { subjectPseudonym: null; scopes: FoldedScope[] } {
  const sorted = [...rows].sort(pgOrder);
  return {
    subjectPseudonym: null,
    scopes: CONSENT_SCOPES.map((scope) => {
      const last = sorted.filter((r) => r.scope === scope).at(-1) ?? null;
      return {
        scope,
        active: last?.action === "grant",
        consentVersion: last?.consent_version ?? null,
        lastAction: last === null
          ? null
          : last.action === "grant"
          ? "granted"
          : "withdrawn",
        lastActionAt: last === null ? null : isoMicros(last.createdUs),
      };
    }),
  };
}

/** "Latest committed action per scope" — commit order, not created_at order.
 * Differs from oracleFold only when the DB clock is non-monotonic. */
function commitOrderFold(rows: LedgerRow[]) {
  const sorted = [...rows].sort((a, b) => a.commitIndex - b.commitIndex);
  return CONSENT_SCOPES.map((scope) => {
    const last = sorted.filter((r) => r.scope === scope).at(-1) ?? null;
    return { scope, active: last?.action === "grant" };
  });
}

interface SelectRecord {
  /** wall-clock instants: request received by the model, snapshot taken */
  receivedAt: number;
  snapshotAt: number;
  /** number of committed rows for that user in the snapshot */
  snapshotCommitCount: number;
  userId: string | null;
  query: string;
  faulted: boolean;
}

class ConsentLedgerModel {
  rows: LedgerRow[] = [];
  selects: SelectRecord[] = [];
  inserts = 0;
  rlsRefusals = 0;
  /** every distinct query string the handler sent for this table */
  queryShapes = new Set<string>();
  prng = new Prng(1);
  latencyMaxMs = 0;
  /** modelled server clock (µs). Monotonic unless a skew step is scheduled. */
  clockUs = Date.UTC(2026, 8, 4, 12, 0, 0) * 1000;
  /** commitIndex → µs delta applied to the clock BEFORE stamping that row */
  clockStepsUs = new Map<number, number>();
  /** commitIndex → reuse the created_at of the previous commit (exact tie) */
  tieWithPrevious = new Set<number>();
  /** SELECT ordinals (0-based, per reset) that fail with a PostgREST 500 */
  faultSelects = new Set<number>();
  private selectOrdinal = 0;
  private commitCount = 0;

  reset(seed: number, latencyMaxMs: number): void {
    this.rows = [];
    this.selects = [];
    this.inserts = 0;
    this.rlsRefusals = 0;
    this.queryShapes = new Set();
    this.prng = new Prng(seed ^ 0x5eed);
    this.latencyMaxMs = latencyMaxMs;
    this.clockUs = Date.UTC(2026, 8, 4, 12, 0, 0) * 1000 + (seed % 1000) * 1000;
    this.clockStepsUs = new Map();
    this.tieWithPrevious = new Set();
    this.faultSelects = new Set();
    this.selectOrdinal = 0;
    this.commitCount = 0;
  }

  private async latency(): Promise<void> {
    if (this.latencyMaxMs > 0) await sleep(this.prng.int(0, this.latencyMaxMs));
  }

  /** Commit a row now (used both for seeding and by the PostgREST POST path). */
  commit(
    row: Omit<LedgerRow, "id" | "createdUs" | "commitIndex" | "committedAt">,
  ): LedgerRow {
    const index = this.commitCount++;
    const step = this.clockStepsUs.get(index);
    if (step !== undefined) this.clockUs += step;
    let createdUs: number;
    if (this.tieWithPrevious.has(index) && this.rows.length > 0) {
      createdUs = this.rows[this.rows.length - 1].createdUs;
    } else {
      this.clockUs += this.prng.int(1, 1_500);
      createdUs = this.clockUs;
    }
    const committed: LedgerRow = {
      ...row,
      id: this.prng.uuid(),
      createdUs,
      commitIndex: index,
      committedAt: performance.now(),
    };
    this.rows.push(committed);
    return committed;
  }

  committedBefore(userId: string, instant: number): number {
    return this.rows.filter((r) =>
      r.user_id === userId && r.committedAt <= instant
    ).length;
  }

  rowsOf(userId: string): LedgerRow[] {
    return this.rows.filter((r) => r.user_id === userId);
  }

  async handle(
    request: Request,
    rawBody: string,
    who: { role: "service" | "user" | "anon"; userId: string | null },
  ): Promise<Response> {
    const url = new URL(request.url);
    const jsonResponse = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (request.method === "GET") {
      const ordinal = this.selectOrdinal++;
      const receivedAt = performance.now();
      const query = url.searchParams.toString();
      this.queryShapes.add(
        query.replace(/user_id=eq\.[^&]*/, "user_id=eq.<uid>"),
      );
      const params = url.searchParams;
      // Filters the handler must send for this route (anything else is a
      // contract change the model refuses to guess about).
      const eqUser = params.get("user_id");
      const order = params.get("order");
      const select = (params.get("select") ?? "*").split(",");
      for (const [col, raw] of params.entries()) {
        if (["select", "order", "user_id"].includes(col)) continue;
        return jsonResponse(400, {
          message: `stress model: unsupported filter ${col}=${raw}`,
        });
      }
      if (order !== "created_at.asc,id.asc") {
        return jsonResponse(400, {
          message: `stress model: unexpected order=${order}`,
        });
      }
      await this.latency();
      const snapshotAt = performance.now();
      if (this.faultSelects.has(ordinal)) {
        this.selects.push({
          receivedAt,
          snapshotAt,
          snapshotCommitCount: -1,
          userId: who.userId,
          query,
          faulted: true,
        });
        return jsonResponse(500, {
          code: "57014",
          message: "canceling statement due to statement timeout",
          details: "stress-injected",
          hint: null,
        });
      }
      let visible = who.role === "service" ? this.rows : [];
      if (who.role === "user" && who.userId) {
        visible = this.rows.filter((r) => r.user_id === who.userId);
      }
      if (eqUser) {
        const wanted = eqUser.startsWith("eq.") ? eqUser.slice(3) : "";
        visible = visible.filter((r) => r.user_id === wanted);
      }
      const snapshot = [...visible].sort(pgOrder);
      this.selects.push({
        receivedAt,
        snapshotAt,
        snapshotCommitCount: snapshot.length,
        userId: who.userId,
        query,
        faulted: false,
      });
      // response bytes in flight
      await this.latency();
      return jsonResponse(
        200,
        snapshot.map((r) => {
          const view: Record<string, unknown> = {
            id: r.id,
            user_id: r.user_id,
            scope: r.scope,
            action: r.action,
            consent_version: r.consent_version,
            source: r.source,
            device: r.device,
            capture_mode: r.capture_mode,
            created_at: isoMicros(r.createdUs),
          };
          if (select.includes("*")) return view;
          return Object.fromEntries(
            select.map((c) => [c.trim(), view[c.trim()]]),
          );
        }),
      );
    }
    if (request.method === "POST") {
      let body: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(rawBody);
        body = isRecord(parsed) ? parsed : {};
      } catch {
        body = {};
      }
      await this.latency();
      if (
        who.role !== "service" && (!who.userId || body.user_id !== who.userId)
      ) {
        this.rlsRefusals += 1;
        return jsonResponse(403, {
          code: "42501",
          message:
            'new row violates row-level security policy for table "consent_records"',
        });
      }
      const action = body.action === "withdraw" ? "withdraw" : "grant";
      this.commit({
        user_id: String(body.user_id),
        scope: String(body.scope),
        action,
        consent_version: typeof body.consent_version === "string"
          ? body.consent_version
          : null,
        source: typeof body.source === "string" ? body.source : null,
        device: body.device ?? null,
        capture_mode: typeof body.capture_mode === "string"
          ? body.capture_mode
          : null,
      });
      this.inserts += 1;
      return new Response(null, { status: 201 });
    }
    return jsonResponse(405, {
      message: `stress model: ${request.method} not allowed`,
    });
  }
}

// ── Loading: real handler + shared fake, consent table routed to the model ──

interface Stress {
  h: XcHarness;
  fake: FakeSupabase;
  ledger: ConsentLedgerModel;
}

let stress: Stress | null = null;

async function loadStress(): Promise<Stress> {
  if (stress) return stress;
  const h = await loadXcHarness();
  const ledger = new ConsentLedgerModel();
  const inner = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin === SUPABASE_URL &&
      url.pathname === "/rest/v1/consent_records"
    ) {
      const rawBody = await request.text().catch(() => "");
      h.fake.count(`rest.${request.method.toLowerCase()}.consent_records`);
      return ledger.handle(
        request,
        rawBody,
        h.fake.principal(request.headers),
      );
    }
    return inner(input, init);
  }) as typeof fetch;
  stress = { h, fake: h.fake, ledger };
  return stress;
}

// ── Per-request records ──────────────────────────────────────────────────────

interface Req {
  i: number;
  op: string;
  actor: string;
  status: number;
  startedAt: number;
  endedAt: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  /** set when the client aborted the request mid-flight */
  aborted?: boolean;
  /** rejection message if the handler promise rejected */
  rejected?: string;
}

async function fire(
  h: XcHarness,
  reqs: Req[],
  i: number,
  op: string,
  actor: string,
  request: Request,
  options: { jitterMs?: number; abortAfterMs?: number } = {},
): Promise<Req> {
  if (options.jitterMs) await sleep(options.jitterMs);
  const startedAt = performance.now();
  let controller: AbortController | null = null;
  let req = request;
  if (options.abortAfterMs !== undefined) {
    controller = new AbortController();
    req = new Request(request, { signal: controller.signal });
    const c = controller;
    sleep(options.abortAfterMs).then(() =>
      c.abort(new DOMException("client gone", "AbortError"))
    );
  }
  const rec: Req = {
    i,
    op,
    actor,
    status: 0,
    startedAt,
    endedAt: 0,
    body: {},
    headers: {},
    ...(controller ? { aborted: true } : {}),
  };
  try {
    const response = await h.handler(req);
    rec.status = response.status;
    rec.headers = Object.fromEntries(
      ["retry-after", "content-type"]
        .map((k) => [k, response.headers.get(k) ?? ""])
        .filter(([, v]) => v !== ""),
    );
    rec.body = await readJson(response);
  } catch (error) {
    rec.status = -1;
    rec.rejected = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  }
  rec.endedAt = performance.now();
  reqs.push(rec);
  return rec;
}

// ── Invariant helpers ────────────────────────────────────────────────────────

interface Check {
  name: string;
  holds: boolean;
  detail: string;
}

class Checks {
  list: Check[] = [];
  observations: Record<string, unknown> = {};
  that(name: string, holds: boolean, detail = ""): void {
    this.list.push({ name, holds, detail });
  }
  note(name: string, value: unknown): void {
    this.observations[name] = value;
  }
  failed(): Check[] {
    return this.list.filter((c) => !c.holds);
  }
}

const SCOPE_KEYS = [
  "scope",
  "active",
  "consentVersion",
  "lastAction",
  "lastActionAt",
];

/** Response body must be exactly the route's shape: subjectPseudonym null,
 * three scopes in canonical order, exactly the five keys each. */
function shapeOk(body: Record<string, unknown>): string | null {
  if (body.subjectPseudonym !== null) return "subjectPseudonym !== null";
  if (!Array.isArray(body.scopes)) return "scopes not an array";
  if (body.scopes.length !== 3) return `scopes.length=${body.scopes.length}`;
  for (let k = 0; k < 3; k++) {
    const s = body.scopes[k];
    if (!isRecord(s)) return `scopes[${k}] not an object`;
    const keys = Object.keys(s).sort();
    if (keys.join(",") !== [...SCOPE_KEYS].sort().join(",")) {
      return `scopes[${k}] keys ${keys}`;
    }
    if (s.scope !== CONSENT_SCOPES[k]) {
      return `scopes[${k}].scope=${String(s.scope)}`;
    }
    if (typeof s.active !== "boolean") return `scopes[${k}].active not boolean`;
    if (s.active && s.lastAction !== "granted") {
      return `scopes[${k}] active but ${s.lastAction}`;
    }
    if (!s.active && s.lastAction === "granted") {
      return `scopes[${k}] inactive but granted`;
    }
    if ((s.lastAction === null) !== (s.lastActionAt === null)) {
      return `scopes[${k}] lastAction/lastActionAt null mismatch`;
    }
  }
  return null;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Linearizability of a served GET: its body must equal the fold of the rows
 * committed at SOME instant within [startedAt, endedAt] — i.e. a prefix (in
 * commit order) of length k with committedBefore(start) ≤ k ≤
 * committedBefore(end). Returns null when it holds, else a description. */
function linearizable(
  ledger: ConsentLedgerModel,
  userId: string,
  r: Req,
): string | null {
  const all = ledger.rowsOf(userId).sort((a, b) =>
    a.commitIndex - b.commitIndex
  );
  const lo = ledger.committedBefore(userId, r.startedAt);
  const hi = ledger.committedBefore(userId, r.endedAt);
  for (let k = lo; k <= hi; k++) {
    if (same(r.body, oracleFold(all.slice(0, k)))) return null;
  }
  // Was it ANY prefix (stale or future read) — reported separately from "garbage".
  for (let k = 0; k <= all.length; k++) {
    if (same(r.body, oracleFold(all.slice(0, k)))) {
      return `prefix k=${k} outside linearizable window [${lo},${hi}]`;
    }
  }
  return `body matches no prefix of the ledger (window [${lo},${hi}], n=${all.length})`;
}

// ── Scenario plumbing ────────────────────────────────────────────────────────

type ScenarioName =
  | "dup-burst"
  | "read-write-race"
  | "logout-during-read"
  | "refresh-during-read"
  | "abort-during-read"
  | "cross-user"
  | "upstream-fault"
  | "clock-skew-ledger"
  | "rate-limit-exact";

const SCENARIOS: ScenarioName[] = [
  "dup-burst",
  "read-write-race",
  "logout-during-read",
  "refresh-during-read",
  "abort-during-read",
  "cross-user",
  "upstream-fault",
  "clock-skew-ledger",
];

interface Actor {
  sub: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

interface Ctx {
  seed: number;
  prng: Prng;
  ip: string;
  s: Stress;
  reqs: Req[];
  checks: Checks;
  inputs: Record<string, unknown>;
}

/** Fresh user (fresh provider subject) + one device session via the real
 * bootstrap route. A second call with the same sub = a second device. */
async function device(ctx: Ctx, sub: string): Promise<Actor> {
  const out = await bootstrap(ctx.s.h, sub, ctx.ip);
  if (out.status !== 200) throw new Error(`bootstrap ${sub} → ${out.status}`);
  const payload = jwtPayload(out.accessToken)!;
  return {
    sub,
    userId: String(payload.sub),
    accessToken: out.accessToken,
    refreshToken: out.refreshToken,
    sessionId: String(payload.session_id),
  };
}

/** Pre-existing ledger rows, shaped as the POST routes would have written
 * them (a withdraw carries forward the latest row's version, or null). */
function seedLedger(ctx: Ctx, userId: string, n: number): void {
  for (let k = 0; k < n; k++) {
    const scope = CONSENT_SCOPES[ctx.prng.int(0, 2)];
    const action = ctx.prng.next() < 0.6 ? "grant" : "withdraw";
    const latest = [...ctx.s.ledger.rowsOf(userId)].sort(pgOrder).filter((r) =>
      r.scope === scope
    ).at(-1);
    ctx.s.ledger.commit({
      user_id: userId,
      scope,
      action,
      consent_version: action === "grant"
        ? `v${ctx.prng.int(1, 5)}`
        : (latest?.consent_version ?? null),
      source: "stress_seed",
      device: null,
      capture_mode: null,
    });
  }
}

const getStatus = (
  ctx: Ctx,
  actor: Actor,
  extra: Record<string, string> = {},
) =>
  edgeRequest("GET", ROUTE, {
    token: actor.accessToken,
    ip: ctx.ip,
    headers: extra,
  });

function consentPost(
  ctx: Ctx,
  actor: Actor,
  scope: Scope,
  action: "grant" | "withdraw",
  tag: string,
) {
  const body = action === "grant"
    ? { scope, consentVersion: `v${ctx.prng.int(1, 9)}`, source: tag }
    : { scope, source: tag };
  return edgeRequest("POST", `/v1/me/consent/${action}`, {
    token: actor.accessToken,
    ip: ctx.ip,
    body,
  });
}

function commonChecks(ctx: Ctx, gets: Req[], allowed: number[]): void {
  const c = ctx.checks;
  const bad = ctx.reqs.filter((r) => r.status >= 500 || r.status <= 0);
  c.that(
    "no_5xx_or_rejection",
    bad.length === 0,
    bad.map((r) =>
      `${r.op}#${r.i}→${r.status}${r.rejected ? ` ${r.rejected}` : ""}`
    ).join("; "),
  );
  const outside = gets.filter((r) => !allowed.includes(r.status));
  c.that(
    "get_status_in_allowed_set",
    outside.length === 0,
    `allowed=${allowed} got ${
      outside.map((r) => `#${r.i}→${r.status}`).join(",")
    }`,
  );
  const shapes = gets
    .filter((r) => r.status === 200)
    .map((r) => ({ i: r.i, err: shapeOk(r.body) }))
    .filter((x) => x.err);
  c.that(
    "response_shape_pinned",
    shapes.length === 0,
    shapes.map((x) => `#${x.i}: ${x.err}`).join("; "),
  );
  const served =
    gets.filter((r) => r.status === 200 || r.status === 503).length;
  const selects = ctx.s.ledger.selects.length;
  c.note("postgrest_selects", selects);
  c.note("gets_served", served);
  const shapesSeen = [...ctx.s.ledger.queryShapes];
  c.note("query_shapes", shapesSeen);
  c.that(
    "query_contract",
    shapesSeen.every(
      (q) =>
        q.includes("select=scope%2Caction%2Cconsent_version%2Ccreated_at") &&
        q.includes("user_id=eq.<uid>") &&
        q.includes("order=created_at.asc%2Cid.asc"),
    ),
    shapesSeen.join(" | "),
  );
  for (const r of gets.filter((r) => r.status === 429)) {
    if (!r.headers["retry-after"]) {
      c.that("429_has_retry_after", false, `#${r.i}`);
    }
  }
}

// ── Scenarios ────────────────────────────────────────────────────────────────

async function dupBurst(ctx: Ctx): Promise<void> {
  const { prng, s, checks: c } = ctx;
  const a = await device(ctx, `dup-${ctx.seed}`);
  const twoDevices = prng.next() < 0.5;
  const b = twoDevices ? await device(ctx, a.sub) : a;
  const n = prng.int(0, 14);
  seedLedger(ctx, a.userId, n);
  const burst = prng.int(8, 32);
  const jitterMax = prng.int(0, 6);
  Object.assign(ctx.inputs, { ledgerRows: n, burst, twoDevices, jitterMax });
  const oracle = oracleFold(s.ledger.rowsOf(a.userId));
  await Promise.all(
    Array.from(
      { length: burst },
      (_, i) =>
        fire(
          s.h,
          ctx.reqs,
          i,
          "GET status",
          i % 2 === 0 ? "devA" : "devB",
          getStatus(ctx, i % 2 === 0 ? a : b),
          {
            jitterMs: prng.int(0, jitterMax),
          },
        ),
    ),
  );
  const gets = ctx.reqs;
  commonChecks(ctx, gets, [200]);
  const wrong = gets.filter((r) => r.status === 200 && !same(r.body, oracle));
  c.that(
    "every_response_equals_oracle_fold",
    wrong.length === 0,
    wrong.map((r) => `#${r.i}`).join(","),
  );
  const distinct = new Set(gets.map((r) => JSON.stringify(r.body))).size;
  c.that(
    "all_responses_identical",
    distinct === 1,
    `distinct bodies=${distinct}`,
  );
  c.that(
    "one_select_per_get",
    s.ledger.selects.length === gets.filter((r) => r.status === 200).length,
    `selects=${s.ledger.selects.length} gets=${gets.length}`,
  );
  c.note("gotrue_get_user_calls", s.fake.counters["gotrue.get_user"] ?? 0);
  c.that(
    "auth_verification_not_amplified",
    (s.fake.counters["gotrue.get_user"] ?? 0) <= burst,
    `get_user=${s.fake.counters["gotrue.get_user"]}`,
  );
}

async function readWriteRace(ctx: Ctx, skew: boolean): Promise<void> {
  const { prng, s, checks: c } = ctx;
  const writer = await device(ctx, `rw-${ctx.seed}`);
  const reader = await device(ctx, writer.sub);
  const seeded = prng.int(0, 6);
  seedLedger(ctx, writer.userId, seeded);
  const writes = prng.int(2, 8);
  const reads = prng.int(6, 24);
  const jitterMax = prng.int(2, 14);
  const ops = Array.from({ length: writes }, () => ({
    scope: CONSENT_SCOPES[prng.int(0, 2)],
    action: (prng.next() < 0.55 ? "grant" : "withdraw") as "grant" | "withdraw",
    jitter: prng.int(0, jitterMax),
  }));
  if (skew) {
    // Between two of the racing appends the DB clock steps back 1–3 s, and
    // one append is stamped with EXACTLY the previous row's created_at.
    const stepAt = seeded + prng.int(1, Math.max(1, writes - 1));
    s.ledger.clockStepsUs.set(stepAt, -prng.int(1_000_000, 3_000_000));
    const tieAt = seeded + prng.int(1, writes);
    if (tieAt !== stepAt) s.ledger.tieWithPrevious.add(tieAt);
    Object.assign(ctx.inputs, {
      clockStepAtCommit: stepAt,
      tieAtCommit: tieAt,
    });
  }
  Object.assign(ctx.inputs, { seeded, writes, reads, jitterMax, ops });
  const tasks: Promise<Req>[] = [];
  ops.forEach((op, k) =>
    tasks.push(
      fire(
        s.h,
        ctx.reqs,
        1000 + k,
        `POST ${op.action} ${op.scope}`,
        "writer",
        consentPost(ctx, writer, op.scope, op.action, `w${k}`),
        {
          jitterMs: op.jitter,
        },
      ),
    )
  );
  for (let i = 0; i < reads; i++) {
    tasks.push(
      fire(s.h, ctx.reqs, i, "GET status", "reader", getStatus(ctx, reader), {
        jitterMs: prng.int(0, jitterMax),
      }),
    );
  }
  await Promise.all(tasks);
  const gets = ctx.reqs.filter((r) => r.op === "GET status");
  const posts = ctx.reqs.filter((r) => r.op.startsWith("POST"));
  commonChecks(ctx, gets, [200]);
  c.that(
    "every_post_200",
    posts.every((r) => r.status === 200),
    posts.map((r) => `#${r.i}→${r.status}`).join(","),
  );
  const lin = gets
    .filter((r) => r.status === 200)
    .map((r) => ({ i: r.i, err: linearizable(s.ledger, writer.userId, r) }))
    .filter((x) => x.err);
  c.that(
    "every_get_is_linearizable_snapshot",
    lin.length === 0,
    lin.map((x) => `#${x.i}: ${x.err}`).join("; "),
  );
  // POST responses fold too, and each must reflect at least its own row.
  const postLin = posts
    .filter((r) => r.status === 200)
    .map((r) => ({ i: r.i, err: linearizable(s.ledger, writer.userId, r) }))
    .filter((x) => x.err);
  c.that(
    "every_post_response_is_linearizable_snapshot",
    postLin.length === 0,
    postLin.map((x) => `#${x.i}: ${x.err}`).join("; "),
  );
  const rows = s.ledger.rowsOf(writer.userId);
  // Read-your-write: a POST's folded response must include the row it just
  // appended (tagged through `source`), i.e. match a prefix at least that long.
  const byCommit = [...rows].sort((a, b) => a.commitIndex - b.commitIndex);
  const ryw = posts
    .filter((r) => r.status === 200)
    .map((r) => {
      const k = r.i - 1000;
      const ownIdx = byCommit.findIndex((row) => row.source === `w${k}`);
      if (ownIdx < 0) return { i: r.i, err: "own row missing from ledger" };
      for (let p = ownIdx + 1; p <= byCommit.length; p++) {
        if (same(r.body, oracleFold(byCommit.slice(0, p)))) return null;
      }
      return { i: r.i, err: `response predates own row (commit #${ownIdx})` };
    })
    .filter((x): x is { i: number; err: string } => x !== null);
  c.that(
    "post_response_includes_own_row",
    ryw.length === 0,
    ryw.map((x) => `#${x.i}: ${x.err}`).join("; "),
  );
  c.that(
    "no_lost_or_duplicate_rows",
    rows.length === seeded + posts.filter((r) => r.status === 200).length &&
      new Set(rows.map((r) => r.id)).size === rows.length,
    `rows=${rows.length} seeded=${seeded} posts200=${
      posts.filter((r) => r.status === 200).length
    }`,
  );
  const final = await fire(
    s.h,
    ctx.reqs,
    9999,
    "GET status(final)",
    "reader",
    getStatus(ctx, reader),
  );
  c.that(
    "final_get_equals_full_fold",
    final.status === 200 && same(final.body, oracleFold(rows)),
    `status=${final.status}`,
  );
  // Observation (not asserted — it is the POST /withdraw route's race, which
  // the GET fold then reports faithfully): withdrawConsent reads the ledger,
  // THEN inserts a row carrying the version of the latest row it saw. When a
  // grant of the same scope commits between that read and the insert, the
  // withdraw row carries a stale version (the ledger order still puts the
  // withdraw last, so `active` is right; only `consentVersion` disagrees
  // with what a sequential client would have produced).
  const sorted = [...rows].sort(pgOrder);
  const carryMismatch = sorted
    .map((r, idx) => {
      if (r.action !== "withdraw" || r.source === "stress_seed") return null;
      const prev = sorted.slice(0, idx).filter((p) => p.scope === r.scope).at(
        -1,
      );
      const expected = prev?.consent_version ?? null;
      return expected === r.consent_version ? null : {
        row: r.source,
        scope: r.scope,
        carried: r.consent_version,
        latestBefore: expected,
      };
    })
    .filter((x) => x !== null);
  c.note("withdraw_version_carry_mismatches", carryMismatch.length);
  if (carryMismatch.length > 0) {
    c.note("withdraw_version_carry_detail", carryMismatch);
  }
  if (skew) {
    const semantic = same(
      commitOrderFold(rows),
      oracleFold(rows).scopes.map((sc) => ({
        scope: sc.scope,
        active: sc.active,
      })),
    );
    c.note("created_at_fold_equals_commit_order_fold", semantic);
    c.note(
      "ledger_created_at_monotonic",
      sorted.every((r, i) =>
        i === 0 || r.commitIndex > sorted[i - 1].commitIndex
      ),
    );
  }
}

async function logoutDuringRead(ctx: Ctx): Promise<void> {
  const { prng, s, checks: c } = ctx;
  const a = await device(ctx, `lo-${ctx.seed}`);
  const other = await device(ctx, a.sub); // second device; scope=local must not touch it
  seedLedger(ctx, a.userId, prng.int(1, 8));
  const warm = prng.next() < 0.5;
  if (warm) {
    await fire(
      s.h,
      ctx.reqs,
      -1,
      "GET status(warm)",
      "devA",
      getStatus(ctx, a),
    );
  }
  const burst = prng.int(6, 20);
  const jitterMax = prng.int(4, 20);
  const logoutAt = prng.int(0, jitterMax);
  const slowGetUser = prng.next() < 0.5 ? prng.int(5, 25) : 0;
  if (slowGetUser) {
    s.fake.overrides.getUserDelayMs = (
      bearer,
    ) => (bearer === a.accessToken ? slowGetUser : 0);
  }
  Object.assign(ctx.inputs, { burst, jitterMax, logoutAt, warm, slowGetUser });
  const oracle = oracleFold(s.ledger.rowsOf(a.userId));
  const logout = fire(
    s.h,
    ctx.reqs,
    500,
    "POST logout",
    "devA",
    edgeRequest("POST", "/v1/auth/logout", {
      token: a.accessToken,
      ip: ctx.ip,
      body: {},
    }),
    { jitterMs: logoutAt },
  );
  // A second wave is released the instant the logout response lands, while
  // earlier GETs (and their GoTrue verifications) may still be in flight.
  const postWave = prng.int(2, 6);
  const wave = logout.then(() =>
    Promise.all(
      Array.from({ length: postWave }, (_, i) =>
        fire(s.h, ctx.reqs, 200 + i, "GET status", "devA", getStatus(ctx, a), {
          jitterMs: prng.int(0, 3),
        })),
    )
  );
  Object.assign(ctx.inputs, { postWave });
  await Promise.all([
    logout,
    wave,
    ...Array.from(
      { length: burst },
      (_, i) =>
        fire(s.h, ctx.reqs, i, "GET status", "devA", getStatus(ctx, a), {
          jitterMs: prng.int(0, jitterMax),
        }),
    ),
    ...Array.from(
      { length: 4 },
      (_, i) =>
        fire(
          s.h,
          ctx.reqs,
          100 + i,
          "GET status",
          "devB",
          getStatus(ctx, other),
          { jitterMs: prng.int(0, jitterMax) },
        ),
    ),
  ]);
  const lo = await logout;
  const gets = ctx.reqs.filter((r) => r.op === "GET status");
  const getsA = gets.filter((r) => r.actor === "devA");
  const getsB = gets.filter((r) => r.actor === "devB");
  commonChecks(ctx, gets, [200, 401]);
  c.that("logout_204", lo.status === 204, `status=${lo.status}`);
  const late = getsA.filter((r) => r.startedAt >= lo.endedAt);
  const lateOk = late.filter((r) => r.status !== 401);
  c.note("gets_started_after_logout", late.length);
  c.that(
    "gets_after_logout_completed_are_401",
    lateOk.length === 0,
    lateOk.map((r) => `#${r.i}→${r.status}`).join(","),
  );
  const wrong = getsA.filter((r) => r.status === 200 && !same(r.body, oracle));
  c.that(
    "served_gets_equal_oracle",
    wrong.length === 0,
    wrong.map((r) => `#${r.i}`).join(","),
  );
  c.that(
    "other_device_unaffected",
    getsB.every((r) => r.status === 200 && same(r.body, oracle)),
    getsB.map((r) => r.status).join(","),
  );
  const after = await fire(
    s.h,
    ctx.reqs,
    600,
    "GET status(after)",
    "devA",
    getStatus(ctx, a),
  );
  const afterB = await fire(
    s.h,
    ctx.reqs,
    601,
    "GET status(after)",
    "devB",
    getStatus(ctx, other),
  );
  c.that(
    "post_burst_revoked_token_401",
    after.status === 401,
    `status=${after.status}`,
  );
  c.that(
    "post_burst_other_device_200",
    afterB.status === 200,
    `status=${afterB.status}`,
  );
  c.note("gets_200_during_race", getsA.filter((r) => r.status === 200).length);
  c.note("gets_401_during_race", getsA.filter((r) => r.status === 401).length);
}

async function refreshDuringRead(ctx: Ctx): Promise<void> {
  const { prng, s, checks: c } = ctx;
  const a = await device(ctx, `rf-${ctx.seed}`);
  seedLedger(ctx, a.userId, prng.int(1, 8));
  const burst = prng.int(6, 20);
  const jitterMax = prng.int(4, 20);
  const refreshAt = prng.int(0, jitterMax);
  Object.assign(ctx.inputs, { burst, jitterMax, refreshAt });
  const oracle = oracleFold(s.ledger.rowsOf(a.userId));
  const refresh = fire(
    s.h,
    ctx.reqs,
    500,
    "POST refresh",
    "devA",
    edgeRequest("POST", "/v1/auth/refresh", {
      ip: ctx.ip,
      body: { refreshToken: a.refreshToken },
    }),
    { jitterMs: refreshAt },
  );
  await Promise.all([
    refresh,
    ...Array.from(
      { length: burst },
      (_, i) =>
        fire(s.h, ctx.reqs, i, "GET status", "devA", getStatus(ctx, a), {
          jitterMs: prng.int(0, jitterMax),
        }),
    ),
  ]);
  const rf = await refresh;
  c.that("refresh_200", rf.status === 200, `status=${rf.status}`);
  const session = isRecord(rf.body.session) ? rf.body.session : {};
  const rotated: Actor = {
    ...a,
    accessToken: String(session.accessToken ?? ""),
    refreshToken: String(session.refreshToken ?? ""),
  };
  const gets = ctx.reqs.filter((r) => r.op === "GET status");
  commonChecks(ctx, gets, [200]);
  const wrong = gets.filter((r) => !same(r.body, oracle));
  c.that(
    "old_token_valid_through_rotation",
    wrong.length === 0,
    wrong.map((r) => `#${r.i}→${r.status}`).join(","),
  );
  const withNew = await fire(
    s.h,
    ctx.reqs,
    600,
    "GET status(new)",
    "devA",
    getStatus(ctx, rotated),
  );
  const withOld = await fire(
    s.h,
    ctx.reqs,
    601,
    "GET status(old)",
    "devA",
    getStatus(ctx, a),
  );
  c.that(
    "rotated_token_200",
    withNew.status === 200 && same(withNew.body, oracle),
    `status=${withNew.status}`,
  );
  c.that(
    "pre_rotation_token_still_200",
    withOld.status === 200 && same(withOld.body, oracle),
    `status=${withOld.status}`,
  );
  const reuse = await fire(
    s.h,
    ctx.reqs,
    602,
    "POST refresh(reuse)",
    "devA",
    edgeRequest("POST", "/v1/auth/refresh", {
      ip: ctx.ip,
      body: { refreshToken: a.refreshToken },
    }),
  );
  c.that(
    "refresh_token_reuse_refused_401",
    reuse.status === 401,
    `status=${reuse.status}`,
  );
}

async function abortDuringRead(ctx: Ctx): Promise<void> {
  const { prng, s, checks: c } = ctx;
  const a = await device(ctx, `ab-${ctx.seed}`);
  seedLedger(ctx, a.userId, prng.int(0, 8));
  const burst = prng.int(8, 24);
  const abortEvery = prng.int(2, 4);
  const jitterMax = prng.int(0, 8);
  Object.assign(ctx.inputs, { burst, abortEvery, jitterMax });
  const oracle = oracleFold(s.ledger.rowsOf(a.userId));
  await Promise.all(
    Array.from(
      { length: burst },
      (_, i) =>
        fire(s.h, ctx.reqs, i, "GET status", "devA", getStatus(ctx, a), {
          jitterMs: prng.int(0, jitterMax),
          ...(i % abortEvery === 0 ? { abortAfterMs: prng.int(0, 12) } : {}),
        }),
    ),
  );
  const gets = ctx.reqs;
  commonChecks(ctx, gets, [200]);
  const aborted = gets.filter((r) => r.aborted);
  c.note("aborted_requests", aborted.length);
  c.that(
    "handler_settles_for_aborted_requests",
    aborted.every((r) => r.status === 200 && !r.rejected),
    aborted.map((r) => `#${r.i}→${r.status} ${r.rejected ?? ""}`).join(","),
  );
  c.that(
    "every_response_equals_oracle_fold",
    gets.every((r) => same(r.body, oracle)),
    "",
  );
  c.that(
    "one_select_per_get_no_retry_storm",
    s.ledger.selects.length === burst,
    `selects=${s.ledger.selects.length} burst=${burst}`,
  );
  const after = await fire(
    s.h,
    ctx.reqs,
    600,
    "GET status(after)",
    "devA",
    getStatus(ctx, a),
  );
  c.that(
    "subsequent_get_healthy",
    after.status === 200 && same(after.body, oracle),
    `status=${after.status}`,
  );
  await sleep(15); // let any not-yet-fired abort timers settle (op sanitizer)
}

function forgedSessionToken(
  userId: string,
  opts: { expSkewSeconds?: number; sessionId?: string } = {},
): string {
  const exp = Math.floor(Date.now() / 1000) + (opts.expSkewSeconds ?? 3600);
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
    b64url(
      JSON.stringify({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: opts.sessionId ?? "forged-session",
        exp,
      }),
    )
  }.forged`;
}

async function crossUser(ctx: Ctx): Promise<void> {
  const { prng, s, checks: c } = ctx;
  const users = prng.int(2, 3);
  const actors: Actor[] = [];
  for (let u = 0; u < users; u++) {
    const a = await device(ctx, `xu-${ctx.seed}-${u}`);
    seedLedger(ctx, a.userId, prng.int(1, 10));
    actors.push(a);
  }
  const per = prng.int(4, 10);
  const jitterMax = prng.int(0, 10);
  const oracles = actors.map((a) => oracleFold(s.ledger.rowsOf(a.userId)));
  const forged = forgedSessionToken(actors[0].userId);
  // Clock skew: the device's clock runs ahead so it presents a token whose
  // exp is already (1–120 s) in the past by the server's clock.
  const expired = forgedSessionToken(actors[0].userId, {
    expSkewSeconds: -prng.int(1, 120),
    sessionId: actors[0].sessionId,
  });
  Object.assign(ctx.inputs, { users, per, jitterMax });
  const tasks: Promise<Req>[] = [];
  actors.forEach((a, u) => {
    for (let i = 0; i < per; i++) {
      tasks.push(
        fire(
          s.h,
          ctx.reqs,
          u * 100 + i,
          "GET status",
          `user${u}`,
          getStatus(ctx, a),
          { jitterMs: prng.int(0, jitterMax) },
        ),
      );
    }
  });
  tasks.push(
    fire(
      s.h,
      ctx.reqs,
      900,
      "GET status(anon)",
      "anon",
      edgeRequest("GET", ROUTE, { ip: ctx.ip }),
      { jitterMs: prng.int(0, jitterMax) },
    ),
  );
  tasks.push(
    fire(
      s.h,
      ctx.reqs,
      901,
      "GET status(forged)",
      "forged",
      edgeRequest("GET", ROUTE, { token: forged, ip: ctx.ip }),
      { jitterMs: prng.int(0, jitterMax) },
    ),
  );
  tasks.push(
    fire(
      s.h,
      ctx.reqs,
      902,
      "GET status(expired)",
      "expired",
      edgeRequest("GET", ROUTE, { token: expired, ip: ctx.ip }),
      { jitterMs: prng.int(0, jitterMax) },
    ),
  );
  tasks.push(
    fire(
      s.h,
      ctx.reqs,
      903,
      "GET status(valid)",
      "user0",
      getStatus(ctx, actors[0]),
      { jitterMs: prng.int(0, jitterMax) },
    ),
  );
  await Promise.all(tasks);
  const gets = ctx.reqs.filter((r) => r.op === "GET status");
  commonChecks(ctx, ctx.reqs, [200, 401]);
  const leaks: string[] = [];
  actors.forEach((_, u) => {
    for (const r of gets.filter((r) => r.actor === `user${u}`)) {
      if (r.status !== 200) leaks.push(`#${r.i}→${r.status}`);
      else if (!same(r.body, oracles[u])) {
        const other = oracles.findIndex((o) => same(o, r.body));
        leaks.push(
          `#${r.i} user${u} got ${
            other >= 0 ? `user${other}'s ledger` : "garbage"
          }`,
        );
      }
    }
  });
  c.that(
    "each_user_sees_only_own_ledger",
    leaks.length === 0,
    leaks.join("; "),
  );
  const anon = ctx.reqs.find((r) => r.i === 900)!;
  const forgedR = ctx.reqs.find((r) => r.i === 901)!;
  const expiredR = ctx.reqs.find((r) => r.i === 902)!;
  const validR = ctx.reqs.find((r) => r.i === 903)!;
  c.that("anonymous_401", anon.status === 401, `status=${anon.status}`);
  c.that(
    "forged_session_token_401",
    forgedR.status === 401,
    `status=${forgedR.status}`,
  );
  c.that(
    "expired_by_client_clock_skew_401",
    expiredR.status === 401,
    `status=${expiredR.status}`,
  );
  c.that(
    "valid_token_200",
    validR.status === 200 && same(validR.body, oracles[0]),
    `status=${validR.status}`,
  );
  c.that(
    "no_select_for_unauthenticated",
    s.ledger.selects.every((q) =>
      q.userId !== null && actors.some((a) => a.userId === q.userId)
    ),
    "",
  );
}

async function upstreamFault(ctx: Ctx): Promise<void> {
  const { prng, s, checks: c } = ctx;
  const a = await device(ctx, `uf-${ctx.seed}`);
  seedLedger(ctx, a.userId, prng.int(1, 8));
  const burst = prng.int(8, 24);
  const faults = new Set<number>();
  const faultCount = prng.int(1, Math.max(1, Math.floor(burst / 3)));
  while (faults.size < faultCount) faults.add(prng.int(0, burst - 1));
  s.ledger.faultSelects = faults;
  const jitterMax = prng.int(0, 8);
  Object.assign(ctx.inputs, {
    burst,
    faultSelects: [...faults].sort((x, y) => x - y),
    jitterMax,
  });
  const oracle = oracleFold(s.ledger.rowsOf(a.userId));
  await Promise.all(
    Array.from(
      { length: burst },
      (_, i) =>
        fire(s.h, ctx.reqs, i, "GET status", "devA", getStatus(ctx, a), {
          jitterMs: prng.int(0, jitterMax),
        }),
    ),
  );
  const gets = ctx.reqs;
  // Injected faults are the ONLY tolerated 5xx and must be 503.
  const fivexx = gets.filter((r) => r.status >= 500);
  c.that(
    "faults_surface_as_503_only",
    fivexx.every((r) => r.status === 503) && fivexx.length === faultCount,
    `5xx=${fivexx.map((r) => r.status)} expected ${faultCount}×503`,
  );
  c.that(
    "get_status_in_allowed_set",
    gets.every((r) => r.status === 200 || r.status === 503),
    gets.map((r) => r.status).join(","),
  );
  const leak = fivexx.filter((r) =>
    JSON.stringify(r.body).match(
      /statement timeout|57014|stress-injected|consent_records/,
    )
  );
  c.that(
    "503_body_generic_no_detail_leak",
    leak.length === 0,
    leak.map((r) => JSON.stringify(r.body)).join(" | "),
  );
  c.that(
    "503_body_is_route_generic_message",
    fivexx.every((r) =>
      isRecord(r.body.error) &&
      r.body.error.message ===
        "Consent status is temporarily unavailable. Please try again."
    ),
    fivexx.map((r) => JSON.stringify(r.body)).join(" | "),
  );
  const ok = gets.filter((r) => r.status === 200);
  c.that(
    "unfaulted_gets_correct",
    ok.length === burst - faultCount && ok.every((r) => same(r.body, oracle)),
    `ok=${ok.length}`,
  );
  c.that(
    "one_select_per_get_no_retry",
    s.ledger.selects.length === burst,
    `selects=${s.ledger.selects.length}`,
  );
  const shapes = ok.map((r) => shapeOk(r.body)).filter(Boolean);
  c.that("response_shape_pinned", shapes.length === 0, shapes.join("; "));
  const after = await fire(
    s.h,
    ctx.reqs,
    600,
    "GET status(after)",
    "devA",
    getStatus(ctx, a),
  );
  c.that(
    "recovers_after_fault",
    after.status === 200 && same(after.body, oracle),
    `status=${after.status}`,
  );
}

async function rateLimitExact(ctx: Ctx): Promise<void> {
  const { prng, s, checks: c } = ctx;
  const a = await device(ctx, `rl-${ctx.seed}`);
  seedLedger(ctx, a.userId, prng.int(0, 5));
  // The bootstrap that minted the session already spent 1 of the user's
  // general 240/60s budget (index.ts: bootstrap → enforceRateLimit("user")),
  // so exactly 239 of the burst may be admitted.
  const spentByBootstrap = 1;
  const admit = 240 - spentByBootstrap;
  const over = prng.int(1, 12);
  const burst = 240 + over;
  Object.assign(ctx.inputs, {
    burst,
    over,
    limit: 240,
    spentByBootstrap,
    expectedAdmitted: admit,
  });
  const oracle = oracleFold(s.ledger.rowsOf(a.userId));
  await Promise.all(
    Array.from(
      { length: burst },
      (_, i) => fire(s.h, ctx.reqs, i, "GET status", "devA", getStatus(ctx, a)),
    ),
  );
  const gets = ctx.reqs;
  commonChecks(ctx, gets, [200, 429]);
  const ok = gets.filter((r) => r.status === 200).length;
  const limited = gets.filter((r) => r.status === 429);
  c.that(
    "exactly_limit_admitted",
    ok === admit,
    `200s=${ok} expected=${admit}`,
  );
  c.that(
    "excess_all_429",
    limited.length === burst - admit,
    `429s=${limited.length} expected=${burst - admit}`,
  );
  c.that(
    "429_has_retry_after",
    limited.every((r) => r.headers["retry-after"]),
    "",
  );
  c.that(
    "admitted_correct",
    gets.filter((r) => r.status === 200).every((r) => same(r.body, oracle)),
    "",
  );
  c.that(
    "no_select_for_limited",
    s.ledger.selects.length === ok,
    `selects=${s.ledger.selects.length} ok=${ok}`,
  );
}

// ── Campaign ─────────────────────────────────────────────────────────────────

interface IterationResult {
  seed: number;
  scenario: ScenarioName;
  outcome: "HELD" | "BROKEN";
  failed: Array<{ name: string; detail: string }>;
  checks: number;
  requests: number;
  statusHistogram: Record<string, number>;
  observations: Record<string, unknown>;
  inputs: Record<string, unknown>;
  latencyMaxMs: number;
  durationMs: number;
  counters: Record<string, number>;
  replay: string;
  /** only when BROKEN or when STRESS_ONLY_SEED replays: per-request table */
  requestTable?: Req[];
  error?: string;
}

function pickScenario(seed: number, index: number): ScenarioName {
  if (ONLY_SCENARIO) return ONLY_SCENARIO as ScenarioName;
  if (index > 0 && index % STRESS_RATE_EVERY === 0) return "rate-limit-exact";
  return SCENARIOS[new Prng(seed * 7919 + 13).int(0, SCENARIOS.length - 1)];
}

function replayCommand(seed: number): string {
  return `STRESS_SEED=${STRESS_SEED} STRESS_ONLY_SEED=${seed} STRESS_RATE_EVERY=${STRESS_RATE_EVERY} deno test -A --no-check --config deno.json ${TEST_FILE}`;
}

async function runIteration(
  s: Stress,
  seed: number,
  index: number,
): Promise<IterationResult> {
  const scenario = pickScenario(seed, index);
  const prng = new Prng(seed);
  const latencyMaxMs = scenario === "rate-limit-exact"
    ? prng.int(0, 2)
    : prng.int(0, 10);
  s.fake.reset(seed, latencyMaxMs);
  s.ledger.reset(seed, latencyMaxMs);
  const ctx: Ctx = {
    seed,
    prng,
    ip: `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`,
    s,
    reqs: [],
    checks: new Checks(),
    inputs: {},
  };
  const t0 = performance.now();
  let error: string | undefined;
  try {
    switch (scenario) {
      case "dup-burst":
        await dupBurst(ctx);
        break;
      case "read-write-race":
        await readWriteRace(ctx, false);
        break;
      case "clock-skew-ledger":
        await readWriteRace(ctx, true);
        break;
      case "logout-during-read":
        await logoutDuringRead(ctx);
        break;
      case "refresh-during-read":
        await refreshDuringRead(ctx);
        break;
      case "abort-during-read":
        await abortDuringRead(ctx);
        break;
      case "cross-user":
        await crossUser(ctx);
        break;
      case "upstream-fault":
        await upstreamFault(ctx);
        break;
      case "rate-limit-exact":
        await rateLimitExact(ctx);
        break;
    }
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    ctx.checks.that("scenario_completed_without_throw", false, error);
  }
  const durationMs = Math.round((performance.now() - t0) * 100) / 100;
  ctx.checks.that(
    "bounded_wall_time_no_deadlock",
    durationMs < STRESS_ITER_BUDGET_MS,
    `${durationMs}ms ≥ ${STRESS_ITER_BUDGET_MS}ms`,
  );
  const failed = ctx.checks.failed().map((c) => ({
    name: c.name,
    detail: c.detail,
  }));
  const hist: Record<string, number> = {};
  for (const r of ctx.reqs) {
    hist[String(r.status)] = (hist[String(r.status)] ?? 0) + 1;
  }
  const result: IterationResult = {
    seed,
    scenario,
    outcome: failed.length === 0 ? "HELD" : "BROKEN",
    failed,
    checks: ctx.checks.list.length,
    requests: ctx.reqs.length,
    statusHistogram: hist,
    observations: ctx.checks.observations,
    inputs: ctx.inputs,
    latencyMaxMs,
    durationMs,
    counters: { ...s.fake.counters },
    replay: replayCommand(seed),
    ...(error ? { error } : {}),
  };
  if (failed.length > 0 || ONLY_SEED) {
    result.requestTable = ctx.reqs
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((r) => ({
        ...r,
        startedAt: Math.round(r.startedAt * 100) / 100,
        endedAt: Math.round(r.endedAt * 100) / 100,
      }));
  }
  return result;
}

Deno.test(`stress ${ROUTE} concurrency campaign (STRESS_ITER=${STRESS_ITER}, STRESS_SEED=${STRESS_SEED})`, async () => {
  const s = await loadStress();
  const seeds = ONLY_SEED
    ? [Number(ONLY_SEED)]
    : Array.from({ length: STRESS_ITER }, (_, i) => STRESS_SEED + i);
  const results: IterationResult[] = [];
  const heapBefore = Deno.memoryUsage();
  const t0 = performance.now();
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    const index = ONLY_SEED ? seed - STRESS_SEED : i;
    results.push(await runIteration(s, seed, Math.max(0, index)));
  }
  const heapAfter = Deno.memoryUsage();
  const byScenario: Record<
    string,
    { executed: number; held: number; broken: number; requests: number }
  > = {};
  for (const r of results) {
    const b = (byScenario[r.scenario] ??= {
      executed: 0,
      held: 0,
      broken: 0,
      requests: 0,
    });
    b.executed += 1;
    b.requests += r.requests;
    if (r.outcome === "HELD") b.held += 1;
    else b.broken += 1;
  }
  const broken = results.filter((r) => r.outcome === "BROKEN");
  const observations = {
    withdraw_version_carry_mismatch_seeds: results
      .filter((r) =>
        Number(r.observations.withdraw_version_carry_mismatches ?? 0) > 0
      )
      .map((r) => r.seed),
    clock_skew_fold_diverges_from_commit_order_seeds: results
      .filter((r) =>
        r.observations.created_at_fold_equals_commit_order_fold === false
      )
      .map((r) => r.seed),
  };
  const report = {
    route: `GET ${ROUTE}`,
    file: TEST_FILE,
    config: {
      STRESS_SEED,
      STRESS_ITER,
      STRESS_RATE_EVERY,
      STRESS_ITER_BUDGET_MS,
      STRESS_ONLY_SEED: ONLY_SEED ?? null,
      STRESS_SCENARIO: ONLY_SCENARIO || null,
    },
    summary: {
      executed: results.length,
      held: results.length - broken.length,
      broken: broken.length,
      brokenSeeds: broken.map((r) => r.seed),
      requests: results.reduce((n, r) => n + r.requests, 0),
      checks: results.reduce((n, r) => n + r.checks, 0),
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
      maxIterationMs: Math.max(0, ...results.map((r) => r.durationMs)),
      byScenario,
    },
    observations,
    heap: { before: heapBefore, after: heapAfter },
    iterations: results,
  };
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}consent_status_concurrency.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  console.log(
    `stress ${ROUTE}: executed=${report.summary.executed} held=${report.summary.held} broken=${report.summary.broken} requests=${report.summary.requests} → ${path}`,
  );
  assertEquals(
    broken.map((r) => ({
      seed: r.seed,
      scenario: r.scenario,
      failed: r.failed,
    })),
    [],
    `BROKEN seeds — replay each with its \`replay\` command in ${path}`,
  );
  assert(results.length >= 1);
});

Deno.test("stress model self-check: oracle fold matches the route's static contract", () => {
  const m = new ConsentLedgerModel();
  m.reset(1, 0);
  assertEquals(oracleFold([]).scopes.map((s) => s.active), [
    false,
    false,
    false,
  ]);
  const g = m.commit({
    user_id: "u",
    scope: "model_training",
    action: "grant",
    consent_version: "v3",
    source: null,
    device: null,
    capture_mode: null,
  });
  const w = m.commit({
    user_id: "u",
    scope: "model_training",
    action: "withdraw",
    consent_version: "v3",
    source: null,
    device: null,
    capture_mode: null,
  });
  const f = oracleFold(m.rows).scopes[1];
  assertEquals(f, {
    scope: "model_training",
    active: false,
    consentVersion: "v3",
    lastAction: "withdrawn",
    lastActionAt: isoMicros(w.createdUs),
  });
  // exact created_at tie → uuid order decides, deterministically
  m.tieWithPrevious.add(2);
  const t = m.commit({
    user_id: "u",
    scope: "model_training",
    action: "grant",
    consent_version: "v4",
    source: null,
    device: null,
    capture_mode: null,
  });
  assertEquals(t.createdUs, w.createdUs);
  const tied = oracleFold(m.rows).scopes[1];
  assertEquals(tied.active, t.id > w.id);
  assert(g.createdUs < w.createdUs);
});
