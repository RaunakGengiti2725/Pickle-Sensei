// stress — POST /v1/me/evaluation/trials under CONCURRENCY.
//
// The REAL edge handler (../index.ts) is loaded in-process exactly as
// xc_concurrency_harness.ts does it, over a stateful fake Supabase that here
// additionally models the two tables the route touches:
//
//   consent_records    append-only ledger; DB defaults (id, created_at) and
//                      the fold order the route relies on
//                      (`order created_at asc, id asc`) are modelled
//   evaluation_trials  `id` primary key = client trialId, RLS
//                      (`user_id = auth.uid()` on select + insert),
//                      PostgREST `on_conflict=id` + `resolution=ignore-duplicates`
//                      → INSERT … ON CONFLICT (id) DO NOTHING, UPDATE/DELETE
//                      revoked (20260831160000_defense_in_depth.sql).
//
// Everything random flows from ONE seed per case (`Prng`): the scenario kind,
// its shape (users, trial ids, burst width, overlap), the fake's upstream
// latencies (which is what interleaves the concurrent handler invocations)
// and the moment side actions (logout / refresh / consent withdraw / stream
// abort) fire. A case is therefore replayable with STRESS_REPLAY=<seed>.
//
// What the fake does NOT model (covered by stress_evaluation_trials_pg.test.ts
// on a disposable postgres:16 with every migration applied): the jsonb size
// CHECK `evaluation_trials_payload_size`, real transaction isolation, and
// the RLS interaction with ON CONFLICT DO NOTHING.

import {
  b64url,
  bootstrap,
  edgeRequest,
  envInt,
  FakeSupabase,
  histogram,
  type Invariant,
  isRecord,
  jwtPayload,
  Prng,
  readJson,
  sleep,
  SUPABASE_URL,
} from "./xc_concurrency_harness.ts";

// xc_concurrency_harness.ts keeps these private; FakeSupabase.principal()
// recognises exactly these literals, so the env the edge fn reads must match.
const ANON_KEY = "xc-anon-key";
const SERVICE_ROLE_KEY = "xc-service-role-key";

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_ITER = envInt("STRESS_ITER", 40);
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 8);
export const STRESS_DEADLINE_MS = envInt("STRESS_DEADLINE_MS", 20_000);
/** Replay exactly one case (its seed as printed in the campaign table). */
export const STRESS_REPLAY = Deno.env.get("STRESS_REPLAY") ?? "";
/** Force a scenario kind for every case (see KINDS). */
export const STRESS_KIND = Deno.env.get("STRESS_KIND") ?? "";

export const CONSENT_SCOPE = "evaluation_telemetry";
export const CONSENT_VERSION = "2026-08-29";
export const TRIALS_ROUTE_LIMIT = 12;

// ── Fake Supabase with the trials tables ─────────────────────────────────────

export class TrialsFakeSupabase extends FakeSupabase {
  private seq = 0;

  constructor(seed: number, latencyMaxMs: number) {
    super(seed, latencyMaxMs);
    this.tables.consent_records = [];
    this.tables.evaluation_trials = [];
  }

  /** Monotonic `now()` with a microsecond-like suffix so `order by
   * created_at, id` reproduces INSERTION order even inside one millisecond
   * (Postgres timestamps carry microseconds; JS Dates do not). */
  private tick(): string {
    this.seq += 1;
    const iso = new Date().toISOString(); // …T12:34:56.789Z
    return `${iso.slice(0, -1)}${String(this.seq % 1000).padStart(3, "0")}+00:00`;
  }

  private async pause(): Promise<void> {
    if (this.latencyMaxMs > 0) await sleep(this.prng.int(0, this.latencyMaxMs));
  }

  consentActive(userId: string): boolean {
    const rows = this.tables.consent_records
      .filter((r) => r.user_id === userId && r.scope === CONSENT_SCOPE)
      .sort(byCreatedThenId);
    return rows.at(-1)?.action === "grant";
  }

  trialRows(): Array<Record<string, unknown>> {
    return this.tables.evaluation_trials;
  }

  override async handleFetch(request: Request, rawBody: string): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      const table = url.pathname.slice("/rest/v1/".length);
      if (table === "consent_records" || table === "evaluation_trials") {
        return await this.handleLedgerTable(table, request, rawBody, url);
      }
    }
    return await super.handleFetch(request, rawBody);
  }

  private async handleLedgerTable(
    table: "consent_records" | "evaluation_trials",
    request: Request,
    rawBody: string,
    url: URL,
  ): Promise<Response> {
    const who = this.principal(request.headers);
    this.count(`rest.${request.method.toLowerCase()}.${table}`);
    await this.pause();
    const rows = this.tables[table];

    if (request.method === "GET") {
      let out =
        who.role === "service"
          ? rows
          : who.role === "user" && who.userId
            ? rows.filter((r) => r.user_id === who.userId)
            : [];
      for (const [col, raw] of url.searchParams.entries()) {
        if (col === "select" || col === "limit" || col === "offset") continue;
        if (col === "order") {
          const keys = raw.split(",").map((k) => k.split(".")[0]);
          out = [...out].sort((a, b) => {
            for (const k of keys) {
              const c = String(a[k]).localeCompare(String(b[k]));
              if (c !== 0) return c;
            }
            return 0;
          });
          continue;
        }
        if (raw.startsWith("eq.")) {
          const v = raw.slice(3);
          out = out.filter((r) => String(r[col]) === v);
          continue;
        }
        throw new Error(`stress harness: unsupported PostgREST filter ${col}=${raw}`);
      }
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("application/vnd.pgrst.object+json")) {
        if (out.length !== 1) {
          return pgJson(406, {
            code: "PGRST116",
            message: `${out.length} rows`,
            details: null,
          });
        }
        return pgJson(200, out[0]);
      }
      return pgJson(200, out);
    }

    if (request.method === "POST") {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = {};
      }
      const incoming = (Array.isArray(parsed) ? parsed : [parsed]).filter(isRecord);
      const prefer = request.headers.get("prefer") ?? "";
      const conflictCol = url.searchParams.get("on_conflict");
      for (const row of incoming) {
        // RLS insert_own WITH CHECK (user_id = auth.uid()); NOT NULL owner.
        if (who.role !== "user" || !who.userId || row.user_id !== who.userId) {
          this.log(`rest.insert.${table}`, `42501 rls (role=${who.role})`);
          return pgJson(403, {
            code: "42501",
            message: `new row violates row-level security policy for table "${table}"`,
          });
        }
        const id = typeof row.id === "string" ? row.id : this.prng.uuid();
        const existing = rows.find((r) => r.id === id);
        if (existing) {
          if (conflictCol === "id" && prefer.includes("resolution=ignore-duplicates")) {
            const sameOwner = existing.user_id === who.userId;
            this.count(`${table}.conflict.${sameOwner ? "same_owner" : "other_owner"}`);
            this.log(
              `rest.upsert.${table}`,
              `DO NOTHING id=${id.slice(0, 8)} owner=${sameOwner ? "self" : "other"}`,
            );
            continue;
          }
          return pgJson(409, { code: "23505", message: "duplicate key value" });
        }
        const stored: Record<string, unknown> = {
          ...row,
          id,
          created_at: this.tick(),
        };
        if (table === "evaluation_trials") {
          const consent = this.consentActive(who.userId);
          if (!consent) {
            this.count("evaluation_trials.stored_without_active_consent");
          }
          this.log(
            "rest.insert.evaluation_trials",
            `id=${id.slice(0, 8)} user=${who.userId.slice(0, 8)} consent=${
              consent ? "active" : "INACTIVE"
            }`,
          );
        } else {
          this.log(
            "rest.insert.consent_records",
            `${String(row.action)} ${String(row.scope)} user=${who.userId.slice(0, 8)}`,
          );
        }
        rows.push(stored);
      }
      return prefer.includes("return=representation")
        ? pgJson(201, incoming)
        : new Response(null, { status: 201 });
    }

    // update/delete revoked from `authenticated` + append-only triggers
    this.log(`rest.${request.method.toLowerCase()}.${table}`, "42501 revoked");
    return pgJson(403, {
      code: "42501",
      message: `permission denied for table ${table}`,
    });
  }
}

function byCreatedThenId(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const c = String(a.created_at).localeCompare(String(b.created_at));
  return c !== 0 ? c : String(a.id).localeCompare(String(b.id));
}

function pgJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Loading the real handler over the trials fake ────────────────────────────

export interface TrialsHarness {
  handler: (request: Request) => Promise<Response>;
  fake: TrialsFakeSupabase;
  upstreamCalls: Array<{ t: number; method: string; url: string }>;
}

let loaded: TrialsHarness | null = null;

export async function loadTrialsHarness(): Promise<TrialsHarness> {
  if (loaded) return loaded;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const fake = new TrialsFakeSupabase(1, 0);
  const upstreamCalls: TrialsHarness["upstreamCalls"] = [];
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

  let handler: TrialsHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      TrialsHarness["handler"] | undefined;
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

// ── Trial payloads ───────────────────────────────────────────────────────────

/** A trial in the shape apps/mobile/src/evaluation/trialCapture.ts builds
 * (packages/shared-types/src/evaluationTrial.ts EvaluationTrialRecord).
 * `marker` distinguishes payload variants for the same trialId. */
export function trialPayload(
  prng: Prng,
  trialId: string,
  marker: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const outcome = ["scored", "low_confidence", "abstained", "failed"][prng.int(0, 3)];
  return {
    schemaVersion: 1,
    trialId,
    captureId: prng.uuid(),
    analysisId: outcome === "scored" ? prng.uuid() : null,
    capturedAtIso: new Date(
      Date.UTC(2026, 8, 1, 10, prng.int(0, 59), prng.int(0, 59)),
    ).toISOString(),
    recordedAtIso: new Date().toISOString(),
    outcomeKind: outcome,
    outcomeReason: outcome === "scored" ? null : "no_target_lock",
    envelopeOverall: ["SUPPORTED", "DEGRADED", "UNSUPPORTED", null][prng.int(0, 3)],
    latencyMs: prng.int(400, 9000),
    appVersion: "1.0.0",
    engineVersion: "engine-1",
    modelBundleVersion: "bundle-1",
    declaredStroke: ["dink", "drive", null][prng.int(0, 2)],
    claims: {
      targetLock: { status: "not_measured" },
      eventSelection: { status: "abstained", startMs: null, endMs: null },
      strokeLabel: { status: "abstained", label: null, confidence: null },
      contactMarker: {
        status: "not_measured",
        estimatedContactMs: null,
        ballConfirmed: false,
        paddleConfirmed: false,
      },
      phaseRender: {
        status: "abstained",
        contactMs: null,
        followThroughEndMs: null,
      },
      resultScore: {
        status: outcome === "scored" ? "claimed" : "abstained",
        overallScore: outcome === "scored" ? prng.int(1, 10) : null,
        analysisConfidence: outcome === "scored" ? prng.int(50, 99) / 100 : null,
        presentation: null,
      },
    },
    limitingFactors: [],
    userFlags: [],
    dims: { lighting: "unknown", court: "unknown", cameraView: "side" },
    consent: { scope: CONSENT_SCOPE, consentVersion: CONSENT_VERSION },
    marker,
    ...overrides,
  };
}

/** A trial whose JSON is just over the route's 250 000-character per-trial cap. */
export function oversizedTrial(prng: Prng, trialId: string): Record<string, unknown> {
  const base = trialPayload(prng, trialId, "oversized");
  const room = 250_001 - JSON.stringify(base).length;
  return { ...base, limitingFactors: ["x".repeat(room + 24)] };
}

// ── Requests ─────────────────────────────────────────────────────────────────

export interface Row {
  lane: number;
  op: string;
  status: number;
  code?: string;
  accepted?: string[];
  rejected?: Array<{ trialId: string; code: string }>;
  startedAt: number;
  endedAt: number;
}

export async function timed(
  rows: Row[],
  lane: number,
  op: string,
  fn: () => Promise<Response>,
): Promise<{ status: number; body: Record<string, unknown>; row: Row; headers: Headers }> {
  const startedAt = performance.now();
  const response = await fn();
  const body = await readJson(response);
  const err = body.error;
  const nested = isRecord(err) ? err.code : undefined;
  const code =
    typeof nested === "string" ? nested : typeof body.code === "string" ? body.code : undefined;
  const row: Row = {
    lane,
    op,
    status: response.status,
    code,
    startedAt: Math.round(startedAt * 100) / 100,
    endedAt: Math.round(performance.now() * 100) / 100,
  };
  if (Array.isArray(body.acceptedTrialIds)) {
    row.accepted = body.acceptedTrialIds as string[];
  }
  if (Array.isArray(body.rejected)) {
    row.rejected = (body.rejected as Array<Record<string, unknown>>).map((r) => ({
      trialId: String(r.trialId),
      code: String(r.code),
    }));
  }
  rows.push(row);
  return { status: response.status, body, row, headers: response.headers };
}

export function trialsRequest(
  token: string,
  ip: string,
  trials: unknown[],
  extra: { headers?: Record<string, string> } = {},
): Request {
  return edgeRequest("POST", "/v1/me/evaluation/trials", {
    token,
    ip,
    body: { trials },
    headers: extra.headers,
  });
}

/** The same request with a body stream that the "client" aborts part-way
 * through the upload (cancel-during-call at the transport layer). */
export function abortedTrialsRequest(
  token: string,
  ip: string,
  trials: unknown[],
  cut: number,
): Request {
  const text = JSON.stringify({ trials });
  const bytes = new TextEncoder().encode(text);
  const at = Math.max(1, Math.min(bytes.byteLength - 1, Math.floor(bytes.byteLength * cut)));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, at));
      controller.error(new TypeError("stress: client aborted the upload"));
    },
  });
  return new Request(`http://edge.xc.test/functions/v1/api/v1/me/evaluation/trials`, {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: stream,
  });
}

export function consentRequest(token: string, ip: string, action: "grant" | "withdraw"): Request {
  return edgeRequest("POST", `/v1/me/consent/${action}`, {
    token,
    ip,
    body:
      action === "grant"
        ? {
            scope: CONSENT_SCOPE,
            consentVersion: CONSENT_VERSION,
            source: "stress",
          }
        : { scope: CONSENT_SCOPE, source: "stress" },
  });
}

/** A session bearer for `userId` whose `exp` is `skewSeconds` in the past —
 * what the edge sees when the CLIENT clock runs ahead (or the token really
 * expired). The fake never minted it, so GoTrue would refuse it too. */
export function skewedBearer(userId: string, skewSeconds: number, prng: Prng): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: userId,
      aud: "authenticated",
      role: "authenticated",
      session_id: `skew-${prng.uuid()}`,
      exp: Math.floor(Date.now() / 1000) - skewSeconds,
    }),
  );
  return `${header}.${payload}.sig`;
}

export { bootstrap, histogram, jwtPayload, Prng, sleep };
export type { Invariant };

// ── Case bookkeeping ─────────────────────────────────────────────────────────

export interface CaseOutcome {
  index: number;
  seed: number;
  kind: string;
  params: Record<string, unknown>;
  requests: number;
  statusHistogram: Record<string, number>;
  counters: Record<string, number>;
  invariants: Invariant[];
  holds: boolean;
  timedOut: boolean;
  durationMs: number;
  observations: Record<string, unknown>;
  replay: string;
}

export function replayCommand(seed: number, file: string, filter: string): string {
  return `STRESS_REPLAY=${seed} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ${file} --filter "${filter}"`;
}

/** Seed of the i-th case of a campaign (splitmix-style mix of base and index). */
export function caseSeed(base: number, index: number): number {
  let z = (base + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

export function outDir(sub: string): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  const base = env
    ? env.endsWith("/")
      ? env
      : `${env}/`
    : new URL("../../../../artifacts/stress-evaluation-trials/latest/", import.meta.url).pathname;
  return `${base}${sub}/`;
}

export async function writeJson(dir: string, name: string, value: unknown): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

/** Run `fn` against a wall-clock deadline; a deadline hit is the harness's
 * "deadlock / unbounded wait" verdict (the promise is left dangling on purpose
 * — Deno's sanitizer then reports what was still pending). */
export async function withDeadline<T>(
  ms: number,
  fn: () => Promise<T>,
): Promise<{ value: T | null; timedOut: boolean }> {
  let timer: number | undefined;
  const timeout = new Promise<{ value: null; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ value: null, timedOut: true }), ms);
  });
  try {
    return await Promise.race([
      fn().then((value) => ({ value, timedOut: false as const })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
