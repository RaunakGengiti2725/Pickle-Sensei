/**
 * STRESS — db-billing-webhook-tables / lens `concurrency`.
 *
 * Drives public.billing_entitlements + public.webhook_events (service-only
 * tables) and the pg_cron sweeps that touch them on a REAL Postgres with N
 * independent connections released from a barrier, exactly the statement
 * shapes PostgREST issues for the edge function's supabase-js calls:
 *
 *   webhook_events        select id … ; insert … on conflict (id) do nothing
 *                         (upsert ignoreDuplicates)  — index.ts handleRevenueCatWebhook
 *   billing_entitlements  insert … on conflict (user_id) do update set …
 *                         (upsert merge-duplicates)   — index.ts persistBillingVerdict
 *   sweeps                the three cron.schedule bodies from
 *                         20260831000000_scale_and_security.sql
 *
 * Every round is one interleaving produced by a seeded scheduler (per-lane
 * delays + per-lane verdicts drawn from a PRNG seeded by
 * fnv1a(`${STRESS_SEED}:${scenario}:${round}`)) and is replayable alone with
 * STRESS_ROUND_SEED=<that seed>. A JSON table seed → outcome is written to
 * STRESS_OUT_DIR (default artifacts/stress/db-billing-webhook-tables/latest/).
 *
 *   ./stress_pg_up.sh                                  # prints STRESS_PG_URL
 *   STRESS_PG_URL=postgres://postgres:x@127.0.0.1:5499/postgres \
 *     STRESS_ITER=80 deno test -A --no-check --config deno.json .
 *
 * Without STRESS_PG_URL every test is `ignore`d (never points at a hosted
 * project). STRESS_ITER = rounds per scenario (default 3: suite-friendly;
 * the campaign runs 80 → 7 × 80 = 560 interleavings). STRESS_STRICT=1
 * additionally fails the run on the KNOWN lost-update gap (see S3) — it is
 * reported in the JSON either way, never hidden.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";

// ── Configuration ────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const PG_URL = Deno.env.get("STRESS_PG_URL") ?? "";
const ignore = PG_URL === "";
const SEED = envInt("STRESS_SEED", 20260904);
const ITER = Math.max(1, envInt("STRESS_ITER", 3));
const LANES = Math.max(4, envInt("STRESS_LANES", 16));
const JITTER_MS = envInt("STRESS_JITTER_MS", 25);
const WALL_MS = Math.max(1000, envInt("STRESS_WALL_MS", 20_000));
const STRICT = Deno.env.get("STRESS_STRICT") === "1";
const ROUND_SEED_RAW = Deno.env.get("STRESS_ROUND_SEED");
const ROUND_SEED =
  ROUND_SEED_RAW && Number.isFinite(Number(ROUND_SEED_RAW)) ? Number(ROUND_SEED_RAW) >>> 0 : null;

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../artifacts/stress/db-billing-webhook-tables/latest/", import.meta.url)
    .pathname;
}

// ── Seeded scheduler ─────────────────────────────────────────────────────────

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, deterministic, good enough to pick delays/verdicts. */
class Prng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)];
  }
  uuid(): string {
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i++) b[i] = this.int(0, 255);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

// ── Postgres plumbing ────────────────────────────────────────────────────────

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

type Actor =
  | { role: "owner" }
  | { role: "service_role" }
  | { role: "anon" }
  | { role: "authenticated"; sub: string };

const CANCELLED = Symbol("cancelled");

/** One PostgREST-shaped request: BEGIN; role + claims; statements; COMMIT.
 * `cancel` rolls the transaction back instead (the client went away / the
 * statement was cancelled mid-flight). */
async function request<T>(
  sql: Sql,
  actor: Actor,
  fn: (tx: Tx) => Promise<T>,
  opts: { cancel?: boolean } = {},
): Promise<T> {
  try {
    return (await sql.begin(async (tx) => {
      const t = tx as unknown as Tx;
      await t.unsafe(`set local statement_timeout = ${WALL_MS}`);
      if (actor.role === "service_role") {
        await t.unsafe(`set local role service_role`);
      } else if (actor.role === "anon") {
        await t.unsafe(`set local role anon`);
      } else if (actor.role === "authenticated") {
        await t.unsafe(`set local role authenticated`);
        await t.unsafe(`set local request.jwt.claim.sub = '${actor.sub}'`);
        await t.unsafe(
          `set local request.jwt.claims = '{"sub":"${actor.sub}","role":"authenticated"}'`,
        );
      }
      const out = await fn(t);
      if (opts.cancel) throw CANCELLED;
      return out;
    })) as T;
  } catch (e) {
    if (e === CANCELLED) return undefined as T;
    throw e;
  }
}

function sqlstate(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : "JS:" + String((e as Error)?.message ?? e);
}

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

async function serverNowMsAuto(sql: Sql): Promise<number> {
  const r = await sql.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

// free_rating_ledger is keyed by the sign-in identity and survives account
// deletion BY DESIGN, so a replayed seed on a reused database would inherit the
// previous run's spent ratings. The identity subject therefore carries a
// per-process nonce; everything else about a round is a pure function of its seed.
const RUN_NONCE = crypto.randomUUID().slice(0, 8);

async function createUser(sql: Sql, userId: string, subBase: string): Promise<void> {
  const sub = `${subBase}-${RUN_NONCE}`;
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', '${sub}', '${userId}', '{"sub":"${sub}"}')`,
  );
}

async function dropUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
}

const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

function shotPayload(id: string, analysisPermitId: string): Record<string, unknown> {
  return {
    id,
    analysisPermitId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
  };
}

/** The exact statement PostgREST runs for
 * `.from("webhook_events").upsert({...}, { onConflict: "id", ignoreDuplicates: true })`. */
async function webhookInsert(
  tx: Tx,
  row: { id: string; eventType: string; appUserId: string | null; payload: unknown },
): Promise<number> {
  const r = await tx.unsafe(
    `insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
     values ($1, 'revenuecat', $2, $3, $4::jsonb)
     on conflict (id) do nothing`,
    [row.id, row.eventType, row.appUserId, JSON.stringify(row.payload)],
  );
  return r.count;
}

interface Verdict {
  premium: boolean;
  productKey: string | null;
  expiresAt: string | null; // ISO or null
  verifiedAt: string; // ISO — the edge isolate's wall clock
}

/** The exact statement PostgREST runs for
 * `.from("billing_entitlements").upsert({...}, { onConflict: "user_id" })`
 * (resolution=merge-duplicates: every payload column lands in DO UPDATE). */
async function entitlementUpsert(tx: Tx, userId: string, v: Verdict): Promise<number> {
  const r = await tx.unsafe(
    `insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
     values ($1, $2, $3, $4::timestamptz, $5::timestamptz)
     on conflict (user_id) do update set
       premium = excluded.premium,
       product_key = excluded.product_key,
       expires_at = excluded.expires_at,
       verified_at = excluded.verified_at`,
    [userId, v.premium, v.productKey, v.expiresAt, v.verifiedAt],
  );
  return r.count;
}

interface EntitlementRow {
  user_id: string;
  premium: boolean;
  product_key: string | null;
  expires_at: string | null;
  verified_at: string;
}

async function readEntitlements(sql: Sql, userIds: string[]): Promise<EntitlementRow[]> {
  const rows = await sql.unsafe(
    `select user_id::text, premium, product_key,
            to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires_at,
            to_char(verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as verified_at
       from public.billing_entitlements where user_id = any($1::uuid[]) order by user_id`,
    [userIds],
  );
  return rows.map((r) => ({
    user_id: String(r.user_id),
    premium: Boolean(r.premium),
    product_key: r.product_key === null ? null : String(r.product_key),
    expires_at: r.expires_at === null ? null : String(r.expires_at),
    verified_at: String(r.verified_at),
  }));
}

const isoMs = (iso: string) => new Date(iso).toISOString();

function sameVerdict(row: EntitlementRow, v: Verdict): boolean {
  return (
    row.premium === v.premium &&
    row.product_key === v.productKey &&
    (row.expires_at === null
      ? v.expiresAt === null
      : v.expiresAt !== null && isoMs(row.expires_at) === isoMs(v.expiresAt)) &&
    isoMs(row.verified_at) === isoMs(v.verifiedAt)
  );
}

// ── Reporting ────────────────────────────────────────────────────────────────

interface LaneRow {
  lane: number;
  actor: string;
  op: string;
  delayMs: number;
  result: string;
  sqlstate?: string;
  serverStartMs?: number;
  serverEndMs?: number;
  clientMs: number;
  detail?: Record<string, unknown>;
}

interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
  /** "hard" fails the Deno test; "known-gap" is reported (and fails only with STRESS_STRICT=1). */
  kind: "hard" | "known-gap";
}

interface RoundReport {
  scenario: string;
  round: number;
  seed: number;
  outcome: "HELD" | "BROKEN" | "BROKEN(known-gap)";
  failed: string[];
  durationMs: number;
  lanes: LaneRow[];
  inputs: Record<string, unknown>;
  observations: Record<string, unknown>;
  invariants: Invariant[];
  replay: string;
}

interface ScenarioReport {
  scenario: string;
  label: string;
  baseSeed: number;
  scale: { rounds: number; lanes: number; jitterMs: number; wallMs: number };
  outcomes: Record<string, number>;
  rounds: RoundReport[];
  seedTable: Array<{ seed: number; round: number; outcome: string; failed: string[] }>;
  durationMs: number;
}

function inv(
  list: Invariant[],
  name: string,
  holds: boolean,
  detail: string,
  kind: Invariant["kind"] = "hard",
) {
  list.push({ name, holds, detail, kind });
}

function replayCommand(scenario: string, seed: number): string {
  return `STRESS_PG_URL=<from ./stress_pg_up.sh> STRESS_ROUND_SEED=${seed} STRESS_LANES=${LANES} STRESS_JITTER_MS=${JITTER_MS} deno test -A --no-check --config deno.json db_billing_webhook_concurrency.test.ts --filter "${scenario}"`;
}

async function writeReport(report: ScenarioReport): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${report.scenario}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

// ── Lane runner ──────────────────────────────────────────────────────────────

interface LaneCtx {
  lane: number;
  prng: Prng;
  gate: Promise<void>;
  rows: LaneRow[];
}

/** Runs one lane: waits at the barrier, sleeps its seeded delay, then runs
 * `body`, which may issue any number of `request`s and pushes LaneRows. */
function lane(
  ctx: LaneCtx,
  actor: string,
  op: string,
  body: (
    record: (r: Omit<LaneRow, "lane" | "actor" | "op" | "delayMs" | "clientMs">) => void,
  ) => Promise<void>,
): Promise<void> {
  const delayMs = ctx.prng.int(0, JITTER_MS);
  return (async () => {
    await ctx.gate;
    await sleep(delayMs);
    const t0 = performance.now();
    const record = (r: Omit<LaneRow, "lane" | "actor" | "op" | "delayMs" | "clientMs">) =>
      ctx.rows.push({
        lane: ctx.lane,
        actor,
        op,
        delayMs,
        clientMs: Math.round((performance.now() - t0) * 100) / 100,
        ...r,
      });
    try {
      await body(record);
    } catch (e) {
      record({ result: "error", sqlstate: sqlstate(e) });
    }
  })();
}

/** Fire `n` lanes together; bounded by WALL_MS (a hang = deadlock/livelock). */
async function burst(
  n: number,
  prng: Prng,
  build: (ctx: LaneCtx) => Promise<void>,
): Promise<{ rows: LaneRow[]; wallMs: number; timedOut: boolean }> {
  const b = barrier();
  const rows: LaneRow[] = [];
  const lanes: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    lanes.push(
      build({ lane: i, prng: new Prng((prng.int(0, 0x7fffffff) ^ i) >>> 0), gate: b.gate, rows }),
    );
  }
  const t0 = performance.now();
  b.open();
  let timedOut = false;
  await Promise.race([
    Promise.all(lanes),
    sleep(WALL_MS + 2_000).then(() => {
      timedOut = true;
    }),
  ]);
  rows.sort((a, b) => a.lane - b.lane || (a.serverStartMs ?? 0) - (b.serverStartMs ?? 0));
  return { rows, wallMs: Math.round(performance.now() - t0), timedOut };
}

// ── Scenario driver ──────────────────────────────────────────────────────────

type RoundFn = (
  sql: Sql,
  prng: Prng,
  round: { seed: number; index: number },
  invariants: Invariant[],
  inputs: Record<string, unknown>,
  observations: Record<string, unknown>,
) => Promise<LaneRow[]>;

async function scenario(name: string, label: string, run: RoundFn): Promise<ScenarioReport> {
  const sql = postgres(PG_URL, { max: LANES + 8, idle_timeout: 20, connect_timeout: 15 });
  const started = performance.now();
  const rounds: RoundReport[] = [];
  try {
    // Warm the pool so the barrier releases against open connections.
    await Promise.all(Array.from({ length: LANES + 2 }, () => sql.unsafe(`select 1`)));
    const seeds =
      ROUND_SEED !== null
        ? [ROUND_SEED]
        : Array.from({ length: ITER }, (_, r) => fnv1a(`${SEED}:${name}:${r}`));
    for (let r = 0; r < seeds.length; r++) {
      const seed = seeds[r];
      const prng = new Prng(seed);
      const invariants: Invariant[] = [];
      const inputs: Record<string, unknown> = {};
      const observations: Record<string, unknown> = {};
      const t0 = performance.now();
      let lanes: LaneRow[] = [];
      try {
        lanes = await run(sql, prng, { seed, index: r }, invariants, inputs, observations);
      } catch (e) {
        inv(invariants, "round_completed", false, `round threw ${sqlstate(e)}`);
      }
      const failedHard = invariants.filter((i) => !i.holds && i.kind === "hard").map((i) => i.name);
      const failedGap = invariants
        .filter((i) => !i.holds && i.kind === "known-gap")
        .map((i) => i.name);
      const outcome: RoundReport["outcome"] = failedHard.length
        ? "BROKEN"
        : failedGap.length
          ? "BROKEN(known-gap)"
          : "HELD";
      rounds.push({
        scenario: name,
        round: r,
        seed,
        outcome,
        failed: [...failedHard, ...failedGap],
        durationMs: Math.round(performance.now() - t0),
        lanes,
        inputs,
        observations,
        invariants,
        replay: replayCommand(name, seed),
      });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  const outcomes: Record<string, number> = {};
  for (const r of rounds) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const report: ScenarioReport = {
    scenario: name,
    label,
    baseSeed: ROUND_SEED ?? SEED,
    scale: { rounds: rounds.length, lanes: LANES, jitterMs: JITTER_MS, wallMs: WALL_MS },
    outcomes,
    rounds,
    seedTable: rounds.map((r) => ({
      seed: r.seed,
      round: r.round,
      outcome: r.outcome,
      failed: r.failed,
    })),
    durationMs: Math.round(performance.now() - started),
  };
  const path = await writeReport(report);
  console.log(`[stress] ${name}: ${JSON.stringify(outcomes)} in ${report.durationMs}ms → ${path}`);
  return report;
}

function assertScenario(report: ScenarioReport) {
  const broken = report.rounds.filter((r) => r.outcome === "BROKEN");
  const gaps = report.rounds.filter((r) => r.outcome === "BROKEN(known-gap)");
  for (const r of gaps) {
    console.warn(
      `[stress] KNOWN GAP ${report.scenario} seed=${r.seed}: ${r.failed.join(",")} — replay: ${r.replay}`,
    );
  }
  assertEquals(
    broken.map((r) => ({
      seed: r.seed,
      failed: r.failed,
      detail: r.invariants.filter((i) => !i.holds).map((i) => i.detail),
    })),
    [],
    `${report.scenario}: ${broken.length} BROKEN round(s)`,
  );
  if (STRICT) {
    assertEquals(
      gaps.map((r) => ({ seed: r.seed, failed: r.failed })),
      [],
      `${report.scenario}: known gaps (STRESS_STRICT=1)`,
    );
  }
}

// ── Common helpers ───────────────────────────────────────────────────────────

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

function laneErrors(rows: LaneRow[], allowed: string[] = []): LaneRow[] {
  return rows.filter((r) => r.result === "error" && !allowed.includes(r.sqlstate ?? ""));
}

function checkWall(invariants: Invariant[], wallMs: number, timedOut: boolean) {
  inv(
    invariants,
    "bounded_wall_time_no_deadlock",
    !timedOut && wallMs < WALL_MS,
    `burst wall ${wallMs}ms (bound ${WALL_MS}ms)${timedOut ? " TIMED OUT" : ""}`,
  );
}

const PRODUCTS = [
  "pickle_sensei_pro_monthly",
  "pickle_sensei_pro_yearly",
  "pickle_sensei_pro_lifetime",
];

/** A seeded verdict as the edge function would persist it. `nowMs` is the
 * server clock; `skewMs` models each isolate's wall clock offset. */
function seededVerdict(prng: Prng, nowMs: number, skewMs: number): Verdict {
  const premium = prng.bool(0.6);
  const kind = prng.int(0, 2);
  const expiresAt = !premium
    ? prng.bool(0.5)
      ? null
      : new Date(nowMs - prng.int(1, 86_400_000)).toISOString()
    : kind === 0
      ? null
      : new Date(nowMs + prng.int(60_000, 31 * 86_400_000)).toISOString();
  return {
    premium,
    productKey: premium ? prng.pick(PRODUCTS) : null,
    expiresAt,
    verifiedAt: new Date(nowMs + skewMs).toISOString(),
  };
}

// ── S1: same webhook event id, N concurrent deliveries ──────────────────────

Deno.test({
  name: "S1 webhook_same_event_id — N deliveries of one event id: exactly one audit row, zero errors",
  ignore,
  async fn() {
    const report = await scenario(
      "S1_webhook_same_event_id",
      "N concurrent deliveries of the same RevenueCat event id (seen-check → process → insert on conflict do nothing); some lanes cancel (rollback) mid-flight",
      async (sql, prng, _round, invariants, inputs, observations) => {
        const eventId = `evt_${prng.uuid()}`;
        const appUserId = prng.uuid();
        const eventType = prng.pick([
          "INITIAL_PURCHASE",
          "RENEWAL",
          "EXPIRATION",
          "TRANSFER",
          "CANCELLATION",
        ]);
        const cancelLanes = new Set<number>();
        const nCancel = prng.int(0, Math.max(1, Math.floor(LANES / 4)));
        while (cancelLanes.size < nCancel) cancelLanes.add(prng.int(0, LANES - 1));
        Object.assign(inputs, {
          eventId,
          appUserId,
          eventType,
          lanes: LANES,
          cancelLanes: [...cancelLanes].sort(),
        });

        const { rows, wallMs, timedOut } = await burst(LANES, prng, (ctx) =>
          lane(ctx, "service_role", "webhook_delivery", async (record) => {
            const cancel = cancelLanes.has(ctx.lane);
            // 1. PostgREST request: seen-check (own transaction, as in index.ts:2713)
            const seen = await request(sql, { role: "service_role" }, async (tx) => {
              const t0 = await serverNowMs(tx);
              const r = await tx.unsafe(`select id from public.webhook_events where id = $1`, [
                eventId,
              ]);
              return { seen: r.length > 0, t0, t1: await serverNowMs(tx) };
            });
            if (seen.seen) {
              record({
                result: "duplicate_acknowledged",
                serverStartMs: seen.t0,
                serverEndMs: seen.t1,
              });
              return;
            }
            // 2. "processing" (RevenueCat round trip) — seeded think time
            await sleep(ctx.prng.int(0, JITTER_MS));
            // 3. PostgREST request: audit insert (index.ts:2720, ignoreDuplicates)
            const ins = await request(
              sql,
              { role: "service_role" },
              async (tx) => {
                const t0 = await serverNowMs(tx);
                const count = await webhookInsert(tx, {
                  id: eventId,
                  eventType,
                  appUserId,
                  payload: { event: { id: eventId, type: eventType, app_user_id: appUserId } },
                });
                return { count, t0, t1: await serverNowMs(tx) };
              },
              { cancel },
            );
            if (cancel) {
              record({ result: "cancelled_rolled_back" });
              return;
            }
            record({
              result: ins.count === 1 ? "inserted" : "conflict_ignored",
              serverStartMs: ins.t0,
              serverEndMs: ins.t1,
            });
          }),
        );

        const rowCount = Number(
          (
            await sql.unsafe(`select count(*)::int as n from public.webhook_events where id = $1`, [
              eventId,
            ])
          )[0].n,
        );
        const hist = countBy(rows, (r) => r.result);
        const committedLanes = rows.filter((r) => !cancelLanes.has(r.lane));
        Object.assign(observations, {
          resultHistogram: hist,
          rowCount,
          lanesThatPassedSeenCheck: rows.filter((r) => r.result !== "duplicate_acknowledged")
            .length,
          wallMs,
        });
        checkWall(invariants, wallMs, timedOut);
        inv(
          invariants,
          "exactly_one_audit_row",
          rowCount === 1,
          `rows for ${eventId}: ${rowCount}`,
        );
        inv(
          invariants,
          "zero_lane_errors",
          laneErrors(rows).length === 0,
          JSON.stringify(laneErrors(rows)),
        );
        inv(
          invariants,
          "exactly_one_committed_insert",
          (hist.inserted ?? 0) === 1,
          `inserted=${hist.inserted ?? 0} conflict_ignored=${hist.conflict_ignored ?? 0} duplicate=${hist.duplicate_acknowledged ?? 0} cancelled=${hist.cancelled_rolled_back ?? 0}`,
        );
        inv(
          invariants,
          "every_committed_lane_settled",
          committedLanes.length === LANES - cancelLanes.size &&
            committedLanes.every((r) =>
              ["inserted", "conflict_ignored", "duplicate_acknowledged"].includes(r.result),
            ),
          `committed lanes=${committedLanes.length}`,
        );
        await sql.unsafe(`delete from public.webhook_events where id = $1`, [eventId]);
        return rows;
      },
    );
    assertScenario(report);
  },
});

// ── S2: mixed ids + the 90-day purge sweep + client denial ───────────────────

Deno.test({
  name: "S2 webhook_mixed_ids_sweep — duplicate/distinct ids under the purge sweep; clients always 42501",
  ignore,
  async fn() {
    const report = await scenario(
      "S2_webhook_mixed_ids_sweep",
      "writer lanes draw ids from a small pool (duplicates), a sweep lane runs the pg_cron purge, authenticated/anon lanes probe the table",
      async (sql, prng, _round, invariants, inputs, observations) => {
        const tag = prng.uuid().slice(0, 8);
        const poolSize = Math.max(2, Math.floor(LANES / 3));
        const pool = Array.from({ length: poolSize }, (_, i) => `evt_${tag}_${i}`);
        const oldIds = Array.from({ length: 4 }, (_, i) => `old_${tag}_${i}`);
        const freshIds = Array.from({ length: 4 }, (_, i) => `fresh_${tag}_${i}`);
        // Backdated audit rows: 4 past the 90-day retention, 4 inside it.
        await request(sql, { role: "service_role" }, async (tx) => {
          for (const [i, id] of oldIds.entries()) {
            await tx.unsafe(
              `insert into public.webhook_events (id, event_type, payload, received_at)
               values ($1, 'RENEWAL', '{}'::jsonb, now() - interval '91 days' - ($2::int * interval '7 days'))`,
              [id, i],
            );
          }
          for (const [i, id] of freshIds.entries()) {
            await tx.unsafe(
              `insert into public.webhook_events (id, event_type, payload, received_at)
               values ($1, 'RENEWAL', '{}'::jsonb, now() - interval '89 days' + ($2::int * interval '1 hour'))`,
              [id, i],
            );
          }
        });
        const nClientLanes = 3; // authenticated A, authenticated B, anon
        const sweepLane = LANES - 1;
        const userA = prng.uuid();
        const userB = prng.uuid();
        const writerIds: Record<number, string> = {};
        for (let i = 0; i < LANES - 1 - nClientLanes; i++) writerIds[i] = prng.pick(pool);
        Object.assign(inputs, { pool, oldIds, freshIds, writerIds, sweepLane, userA, userB });

        const { rows, wallMs, timedOut } = await burst(LANES, prng, (ctx) => {
          if (ctx.lane === sweepLane) {
            return lane(ctx, "cron", "purge_old_webhook_events", async (record) => {
              const out = await request(sql, { role: "owner" }, async (tx) => {
                const t0 = await serverNowMs(tx);
                const r = await tx.unsafe(
                  `delete from public.webhook_events where received_at < now() - interval '90 days'`,
                );
                return { count: r.count, t0, t1: await serverNowMs(tx) };
              });
              record({
                result: `deleted_${out.count}`,
                serverStartMs: out.t0,
                serverEndMs: out.t1,
              });
            });
          }
          if (ctx.lane >= LANES - 1 - nClientLanes) {
            const which = ctx.lane - (LANES - 1 - nClientLanes);
            const actor: Actor =
              which === 2
                ? { role: "anon" }
                : { role: "authenticated", sub: which === 0 ? userA : userB };
            return lane(ctx, actor.role, "client_probe", async (record) => {
              const probes: Array<[string, string]> = [
                ["select", `select count(*) from public.webhook_events`],
                [
                  "insert",
                  `insert into public.webhook_events (id, payload) values ('client_${tag}_${ctx.lane}', '{}'::jsonb)`,
                ],
                [
                  "update",
                  `update public.webhook_events set event_type = 'x' where id = '${pool[0]}'`,
                ],
                ["delete", `delete from public.webhook_events where id = '${pool[0]}'`],
              ];
              for (const [op, stmt] of probes) {
                try {
                  await request(sql, actor, async (tx) => {
                    await tx.unsafe(stmt);
                  });
                  record({ result: `client_${op}_ALLOWED` });
                } catch (e) {
                  record({ result: `client_${op}_denied`, sqlstate: sqlstate(e) });
                }
              }
            });
          }
          const id = writerIds[ctx.lane];
          return lane(ctx, "service_role", "webhook_insert", async (record) => {
            const out = await request(sql, { role: "service_role" }, async (tx) => {
              const t0 = await serverNowMs(tx);
              const count = await webhookInsert(tx, {
                id,
                eventType: "RENEWAL",
                appUserId: userA,
                payload: { event: { id } },
              });
              return { count, t0, t1: await serverNowMs(tx) };
            });
            record({
              result: out.count === 1 ? "inserted" : "conflict_ignored",
              serverStartMs: out.t0,
              serverEndMs: out.t1,
              detail: { id },
            });
          });
        });

        const written = new Set(Object.values(writerIds));
        const perId = await sql.unsafe(
          `select id, count(*)::int as n from public.webhook_events where id like $1 group by id`,
          [`%_${tag}_%`],
        );
        const counts: Record<string, number> = {};
        for (const r of perId) counts[String(r.id)] = Number(r.n);
        const clientRows = rows.filter((r) => r.op === "client_probe");
        const allowed = clientRows.filter((r) => r.result.endsWith("_ALLOWED"));
        const notDenied = clientRows.filter(
          (r) => r.result.endsWith("_denied") && r.sqlstate !== "42501",
        );
        const writerRows = rows.filter((r) => r.op === "webhook_insert");
        Object.assign(observations, {
          resultHistogram: countBy(rows, (r) => r.result),
          countsPerId: counts,
          distinctWrittenIds: written.size,
          wallMs,
        });
        checkWall(invariants, wallMs, timedOut);
        inv(
          invariants,
          "zero_lane_errors",
          laneErrors(rows).length === 0,
          JSON.stringify(laneErrors(rows)),
        );
        inv(
          invariants,
          "one_row_per_written_id",
          [...written].every((id) => counts[id] === 1),
          JSON.stringify([...written].map((id) => [id, counts[id] ?? 0])),
        );
        inv(
          invariants,
          "inserted_lanes_equal_distinct_ids",
          writerRows.filter((r) => r.result === "inserted").length === written.size,
          `inserted=${writerRows.filter((r) => r.result === "inserted").length} distinct=${written.size}`,
        );
        inv(
          invariants,
          "sweep_removed_every_row_past_90d",
          oldIds.every((id) => (counts[id] ?? 0) === 0),
          JSON.stringify(oldIds.map((id) => counts[id] ?? 0)),
        );
        inv(
          invariants,
          "sweep_kept_every_row_within_90d",
          freshIds.every((id) => counts[id] === 1),
          JSON.stringify(freshIds.map((id) => counts[id] ?? 0)),
        );
        inv(
          invariants,
          "sweep_never_touched_fresh_writes",
          [...written].every((id) => counts[id] === 1),
          "fresh audit rows survive the concurrent purge",
        );
        inv(
          invariants,
          "clients_always_42501",
          allowed.length === 0 && notDenied.length === 0 && clientRows.length === nClientLanes * 4,
          `probes=${clientRows.length} allowed=${allowed.length} nonPermissionDenials=${JSON.stringify(notDenied)}`,
        );
        await sql.unsafe(`delete from public.webhook_events where id like $1`, [`%_${tag}_%`]);
        return rows;
      },
    );
    assertScenario(report);
  },
});

// ── S3: same-user entitlement upserts with clock skew + cancellations ────────

Deno.test({
  name: "S3 entitlement_same_user_upsert_skew — N verdicts for one user (two users present): one row, no torn write, last committer wins",
  ignore,
  async fn() {
    const report = await scenario(
      "S3_entitlement_same_user_upsert_skew",
      "service-role upserts of differing verdicts for user A (and a few for B) with per-lane isolate clock skew; some lanes roll back",
      async (sql, prng, _round, invariants, inputs, observations) => {
        const userA = prng.uuid();
        const userB = prng.uuid();
        await createUser(sql, userA, `sub-${userA}`);
        await createUser(sql, userB, `sub-${userB}`);
        const nowMs = await serverNowMsAuto(sql);
        const plan = Array.from({ length: LANES }, (_, i) => {
          const target = i % 5 === 4 ? userB : userA;
          const skewMs = prng.int(-5_000, 5_000);
          return {
            lane: i,
            target,
            cancel: prng.bool(0.15),
            verdict: seededVerdict(prng, nowMs, skewMs),
            skewMs,
          };
        });
        Object.assign(inputs, { userA, userB, plan });

        const { rows, wallMs, timedOut } = await burst(LANES, prng, (ctx) => {
          const p = plan[ctx.lane];
          return lane(
            ctx,
            "service_role",
            p.cancel ? "upsert_cancelled" : "upsert",
            async (record) => {
              const out = await request(
                sql,
                { role: "service_role" },
                async (tx) => {
                  const t0 = await serverNowMs(tx);
                  const count = await entitlementUpsert(tx, p.target, p.verdict);
                  return { count, t0, t1: await serverNowMs(tx) };
                },
                { cancel: p.cancel },
              );
              if (p.cancel) {
                record({ result: "cancelled_rolled_back" });
                return;
              }
              record({
                result: `upserted_${out.count}`,
                serverStartMs: out.t0,
                serverEndMs: out.t1,
                detail: { target: p.target === userA ? "A" : "B" },
              });
            },
          );
        });

        const final = await readEntitlements(sql, [userA, userB]);
        const rowA = final.filter((r) => r.user_id === userA);
        const rowB = final.filter((r) => r.user_id === userB);
        const committedA = plan.filter((p) => p.target === userA && !p.cancel);
        const committedB = plan.filter((p) => p.target === userB && !p.cancel);
        const cancelledA = plan.filter((p) => p.target === userA && p.cancel);
        const matchA =
          rowA.length === 1 ? committedA.filter((p) => sameVerdict(rowA[0], p.verdict)) : [];
        const matchB =
          rowB.length === 1 ? committedB.filter((p) => sameVerdict(rowB[0], p.verdict)) : [];
        const newestA = committedA.reduce<number>(
          (m, p) => Math.max(m, Date.parse(p.verdict.verifiedAt)),
          -Infinity,
        );
        const finalVerifiedA = rowA.length === 1 ? Date.parse(rowA[0].verified_at) : NaN;
        const lastCommitterA = rows
          .filter(
            (r) => r.op === "upsert" && r.detail?.target === "A" && r.serverEndMs !== undefined,
          )
          .sort((a, b) => (b.serverEndMs ?? 0) - (a.serverEndMs ?? 0))[0];
        // access_state() as user A must agree with the committed row.
        const access = await request(sql, { role: "authenticated", sub: userA }, async (tx) => {
          const r = await tx.unsafe(`select premium from public.access_state()`);
          return Boolean(r[0].premium);
        });
        const expectPremium =
          rowA.length === 1 &&
          rowA[0].premium &&
          (rowA[0].expires_at === null || Date.parse(rowA[0].expires_at) > Date.now());

        Object.assign(observations, {
          resultHistogram: countBy(rows, (r) => r.result),
          finalA: rowA[0] ?? null,
          finalB: rowB[0] ?? null,
          matchingLanesA: matchA.map((p) => p.lane),
          lastCommitterLaneA: lastCommitterA?.lane ?? null,
          finalMatchesLastCommitterA:
            lastCommitterA !== undefined && matchA.some((p) => p.lane === lastCommitterA.lane),
          newestVerifiedAtA: Number.isFinite(newestA) ? new Date(newestA).toISOString() : null,
          finalVerifiedAtIsNewestA: finalVerifiedA === newestA,
          wallMs,
        });
        checkWall(invariants, wallMs, timedOut);
        inv(
          invariants,
          "zero_lane_errors",
          laneErrors(rows).length === 0,
          JSON.stringify(laneErrors(rows)),
        );
        inv(
          invariants,
          "exactly_one_row_per_user",
          rowA.length === (committedA.length ? 1 : 0) &&
            rowB.length === (committedB.length ? 1 : 0),
          `A=${rowA.length} B=${rowB.length}`,
        );
        inv(
          invariants,
          "no_torn_row_A",
          committedA.length === 0 || matchA.length >= 1,
          `final A matches lanes ${JSON.stringify(matchA.map((p) => p.lane))}`,
        );
        inv(
          invariants,
          "no_torn_row_B",
          committedB.length === 0 || matchB.length >= 1,
          `final B matches lanes ${JSON.stringify(matchB.map((p) => p.lane))}`,
        );
        inv(
          invariants,
          "cancelled_verdict_never_persisted",
          rowA.length === 0 ||
            !cancelledA.some(
              (p) =>
                sameVerdict(rowA[0], p.verdict) &&
                !committedA.some((q) => sameVerdict(rowA[0], q.verdict)),
            ),
          `cancelled lanes ${JSON.stringify(cancelledA.map((p) => p.lane))}`,
        );
        inv(
          invariants,
          "cross_user_isolation",
          rowB.length === 0 ||
            !committedA.some(
              (p) =>
                sameVerdict(rowB[0], p.verdict) &&
                !committedB.some((q) => sameVerdict(rowB[0], q.verdict)),
            ),
          "B's row never carries an A verdict",
        );
        inv(
          invariants,
          "access_state_agrees_with_row",
          access === expectPremium,
          `access_state.premium=${access} row⇒${expectPremium}`,
        );
        inv(
          invariants,
          "newest_verdict_wins",
          committedA.length === 0 || finalVerifiedA === newestA,
          `final verified_at=${rowA[0]?.verified_at ?? "∅"} newest issued=${Number.isFinite(newestA) ? new Date(newestA).toISOString() : "∅"} (last committer lane ${lastCommitterA?.lane ?? "∅"})`,
          "known-gap",
        );
        await dropUser(sql, userA);
        await dropUser(sql, userB);
        return rows;
      },
    );
    assertScenario(report);
  },
});

// ── S4: entitlement upsert racing the account cascade delete ─────────────────

Deno.test({
  name: "S4 entitlement_upsert_vs_cascade_delete — verdict writes race auth.users delete: never an orphan row",
  ignore,
  async fn() {
    const report = await scenario(
      "S4_entitlement_upsert_vs_cascade_delete",
      "N-1 service-role upserts for user C while one lane deletes auth.users C (the Auth admin deleteUser cascade)",
      async (sql, prng, _round, invariants, inputs, observations) => {
        const userC = prng.uuid();
        const userD = prng.uuid(); // bystander: must keep its row
        await createUser(sql, userC, `sub-${userC}`);
        await createUser(sql, userD, `sub-${userD}`);
        const nowMs = await serverNowMsAuto(sql);
        const bystander = seededVerdict(prng, nowMs, 0);
        await request(sql, { role: "service_role" }, (tx) =>
          entitlementUpsert(tx, userD, { ...bystander, premium: true, expiresAt: null }),
        );
        const deleteLane = prng.int(0, LANES - 1);
        const verdicts = Array.from({ length: LANES }, () =>
          seededVerdict(prng, nowMs, prng.int(-1000, 1000)),
        );
        Object.assign(inputs, { userC, userD, deleteLane });

        const { rows, wallMs, timedOut } = await burst(LANES, prng, (ctx) => {
          if (ctx.lane === deleteLane) {
            return lane(ctx, "owner", "delete_auth_user", async (record) => {
              const out = await request(sql, { role: "owner" }, async (tx) => {
                const t0 = await serverNowMs(tx);
                const r = await tx.unsafe(`delete from auth.users where id = $1`, [userC]);
                return { count: r.count, t0, t1: await serverNowMs(tx) };
              });
              record({
                result: `deleted_${out.count}`,
                serverStartMs: out.t0,
                serverEndMs: out.t1,
              });
            });
          }
          return lane(ctx, "service_role", "upsert", async (record) => {
            try {
              const out = await request(sql, { role: "service_role" }, async (tx) => {
                const t0 = await serverNowMs(tx);
                const count = await entitlementUpsert(tx, userC, verdicts[ctx.lane]);
                return { count, t0, t1: await serverNowMs(tx) };
              });
              record({
                result: `upserted_${out.count}`,
                serverStartMs: out.t0,
                serverEndMs: out.t1,
              });
            } catch (e) {
              record({ result: "error", sqlstate: sqlstate(e) });
            }
          });
        });

        const orphan = Number(
          (
            await sql.unsafe(
              `select count(*)::int as n from public.billing_entitlements b left join public.profiles p on p.id = b.user_id where p.id is null`,
            )
          )[0].n,
        );
        const rowsC = await readEntitlements(sql, [userC]);
        const rowsD = await readEntitlements(sql, [userD]);
        const profileC = Number(
          (
            await sql.unsafe(`select count(*)::int as n from public.profiles where id = $1`, [
              userC,
            ])
          )[0].n,
        );
        const errs = rows.filter((r) => r.result === "error");
        Object.assign(observations, {
          resultHistogram: countBy(rows, (r) => r.result),
          errorStates: countBy(errs, (r) => r.sqlstate ?? "?"),
          rowsCAfter: rowsC.length,
          profileCAfter: profileC,
          wallMs,
        });
        checkWall(invariants, wallMs, timedOut);
        inv(
          invariants,
          "delete_committed",
          rows.some((r) => r.result === "deleted_1"),
          JSON.stringify(rows.filter((r) => r.op === "delete_auth_user").map((r) => r.result)),
        );
        inv(invariants, "no_orphan_entitlement_rows", orphan === 0, `orphans=${orphan}`);
        inv(
          invariants,
          "deleted_user_has_no_row",
          rowsC.length === 0 && profileC === 0,
          `rowsC=${rowsC.length} profileC=${profileC}`,
        );
        inv(
          invariants,
          "upsert_errors_only_fk_violation",
          errs.every((r) => r.sqlstate === "23503"),
          `error SQLSTATEs: ${JSON.stringify(countBy(errs, (r) => r.sqlstate ?? "?"))} (23503 = profile gone, edge logs+acks; never 40P01/40001/23505)`,
        );
        inv(
          invariants,
          "bystander_row_untouched",
          rowsD.length === 1 && rowsD[0].premium === true,
          JSON.stringify(rowsD[0] ?? null),
        );
        await dropUser(sql, userD);
        return rows;
      },
    );
    assertScenario(report);
  },
});

// ── S5: premium flips off while a burst of reserve+apply runs ────────────────

Deno.test({
  name: "S5 premium_flip_during_reserve_apply — entitlement revoked mid-burst: no rating after the flip, no double spend, no lost flip",
  ignore,
  async fn() {
    const report = await scenario(
      "S5_premium_flip_during_reserve_apply",
      "user E (2 free ratings spent, premium) reserves+applies scored shots on N-2 lanes while a service lane persists premium=false and another user F reads access_state",
      async (sql, prng, _round, invariants, inputs, observations) => {
        const userE = prng.uuid();
        const userF = prng.uuid();
        await createUser(sql, userE, `sub-${userE}`);
        await createUser(sql, userF, `sub-${userF}`);
        // Spend both free ratings through the real RPCs.
        for (let i = 0; i < 2; i++) {
          const permit = await request(sql, { role: "authenticated", sub: userE }, async (tx) => {
            const r = await tx.unsafe(
              `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit($1) x`,
              [`setup-${i}-${userE}`],
            );
            return { result: String(r[0].result), permitId: String(r[0].permit_id) };
          });
          assertEquals(permit.result, "accepted");
          const applied = await request(sql, { role: "authenticated", sub: userE }, async (tx) => {
            const r = await tx.unsafe(
              `select public.apply_synced_shot($1::text::jsonb) as result`,
              [JSON.stringify(shotPayload(prng.uuid(), permit.permitId))],
            );
            return String(r[0].result);
          });
          assertEquals(applied, "accepted");
        }
        const nowMs = await serverNowMsAuto(sql);
        await request(sql, { role: "service_role" }, (tx) =>
          entitlementUpsert(tx, userE, {
            premium: true,
            productKey: "pickle_sensei_pro_monthly",
            expiresAt: new Date(nowMs + 30 * 86_400_000).toISOString(),
            verifiedAt: new Date(nowMs).toISOString(),
          }),
        );
        await request(sql, { role: "service_role" }, (tx) =>
          entitlementUpsert(tx, userF, {
            premium: false,
            productKey: null,
            expiresAt: null,
            verifiedAt: new Date(nowMs).toISOString(),
          }),
        );
        const flipLane = prng.int(0, LANES - 3);
        const readerLane = LANES - 1;
        const flipMode = prng.pick(["premium_false", "expires_past"] as const);
        Object.assign(inputs, { userE, userF, flipLane, readerLane, flipMode });
        let flipCommittedMs = NaN;

        const { rows, wallMs, timedOut } = await burst(LANES, prng, (ctx) => {
          if (ctx.lane === flipLane) {
            return lane(ctx, "service_role", "flip_premium_off", async (record) => {
              const out = await request(sql, { role: "service_role" }, async (tx) => {
                const t0 = await serverNowMs(tx);
                const count = await entitlementUpsert(
                  tx,
                  userE,
                  flipMode === "premium_false"
                    ? {
                        premium: false,
                        productKey: null,
                        expiresAt: null,
                        verifiedAt: new Date(nowMs + 1000).toISOString(),
                      }
                    : {
                        premium: true,
                        productKey: "pickle_sensei_pro_monthly",
                        expiresAt: new Date(nowMs - 1000).toISOString(),
                        verifiedAt: new Date(nowMs + 1000).toISOString(),
                      },
                );
                return { count, t0, t1: await serverNowMs(tx) };
              });
              flipCommittedMs = await serverNowMsAuto(sql); // upper bound on the commit instant
              record({
                result: `flipped_${out.count}`,
                serverStartMs: out.t0,
                serverEndMs: out.t1,
                detail: { flipCommittedMs },
              });
            });
          }
          if (ctx.lane === readerLane) {
            return lane(ctx, "authenticated:F", "access_state_F", async (record) => {
              for (let i = 0; i < 3; i++) {
                const out = await request(
                  sql,
                  { role: "authenticated", sub: userF },
                  async (tx) => {
                    const t0 = await serverNowMs(tx);
                    const r = await tx.unsafe(
                      `select premium, scored_count, reserved_count from public.access_state()`,
                    );
                    const own = await tx.unsafe(
                      `select user_id::text from public.billing_entitlements`,
                    );
                    return {
                      premium: Boolean(r[0].premium),
                      scored: Number(r[0].scored_count),
                      visible: own.map((x) => String(x.user_id)),
                      t0,
                      t1: await serverNowMs(tx),
                    };
                  },
                );
                record({
                  result: out.premium ? "F_premium_TRUE" : "F_free",
                  serverStartMs: out.t0,
                  serverEndMs: out.t1,
                  detail: { visible: out.visible, scored: out.scored },
                });
                await sleep(ctx.prng.int(0, JITTER_MS));
              }
            });
          }
          return lane(ctx, "authenticated:E", "reserve_then_apply", async (record) => {
            const key = `k-${ctx.lane}-${userE}`;
            const reserved = await request(
              sql,
              { role: "authenticated", sub: userE },
              async (tx) => {
                const t0 = await serverNowMs(tx);
                const r = await tx.unsafe(
                  `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit($1) x`,
                  [key],
                );
                return {
                  result: String(r[0].result),
                  permitId: r[0].permit_id ? String(r[0].permit_id) : null,
                  t0,
                  t1: await serverNowMs(tx),
                };
              },
            );
            record({
              result: `reserve:${reserved.result}`,
              serverStartMs: reserved.t0,
              serverEndMs: reserved.t1,
            });
            if (reserved.result !== "accepted" || !reserved.permitId) return;
            await sleep(ctx.prng.int(0, JITTER_MS));
            const shotId = ctx.prng.uuid();
            const applied = await request(
              sql,
              { role: "authenticated", sub: userE },
              async (tx) => {
                const t0 = await serverNowMs(tx);
                const r = await tx.unsafe(
                  `select public.apply_synced_shot($1::text::jsonb) as result`,
                  [JSON.stringify(shotPayload(shotId, reserved.permitId!))],
                );
                return { result: String(r[0].result), t0, t1: await serverNowMs(tx) };
              },
            );
            record({
              result: `apply:${applied.result}`,
              serverStartMs: applied.t0,
              serverEndMs: applied.t1,
              detail: { shotId, permitId: reserved.permitId },
            });
          });
        });

        const shots = Number(
          (
            await sql.unsafe(
              `select count(*)::int as n from public.shots where user_id = $1 and result_kind = 'scored'`,
              [userE],
            )
          )[0].n,
        );
        const permits = await sql.unsafe(
          `select status, coalesce(outcome, '') as outcome, count(*)::int as n from public.analysis_permits where user_id = $1 group by 1, 2`,
          [userE],
        );
        const permitHist: Record<string, number> = {};
        for (const p of permits) permitHist[`${p.status}/${p.outcome}`] = Number(p.n);
        const ledger = Number(
          await request(
            sql,
            { role: "authenticated", sub: userE },
            async (tx) => (await tx.unsafe(`select public.lifetime_scored_count() as n`))[0].n,
          ),
        );
        const afterFlip = await request(sql, { role: "authenticated", sub: userE }, async (tx) => {
          const r = await tx.unsafe(`select x.result from public.reserve_analysis_permit($1) x`, [
            `post-${userE}`,
          ]);
          const a = await tx.unsafe(`select premium from public.access_state()`);
          return { reserve: String(r[0].result), premium: Boolean(a[0].premium) };
        });
        const applies = rows.filter((r) => r.result.startsWith("apply:"));
        const accepted = applies.filter((r) => r.result === "apply:accepted");
        const lateAccepted = accepted.filter(
          (r) => Number.isFinite(flipCommittedMs) && (r.serverStartMs ?? 0) > flipCommittedMs,
        );
        // KNOWN GAP: apply_synced_shot() reads premium under the lock, then the
        // shots BEFORE INSERT trigger (enforce_scored_shot_permit) re-reads it in
        // a fresh READ COMMITTED snapshot; a flip committed in between raises
        // insufficient_privilege inside the atomic block → 'shot.write_failed:42501'
        // (transient to the client) with the permit still reserved.
        const toctou = applies.filter((r) => r.result === "apply:shot.write_failed:42501");
        const badResults = rows.filter(
          (r) =>
            r.op === "reserve_then_apply" &&
            ![
              "reserve:accepted",
              "reserve:access.paywall_required",
              "apply:accepted",
              "apply:access.paywall_required",
              "apply:shot.write_failed:42501",
            ].includes(r.result),
        );
        const readerRows = rows.filter((r) => r.op === "access_state_F");
        // The mobile outbox retries shot.write_failed: replay each such sync once.
        const retries: Array<{ lane: number; result: string; permitAfter: string }> = [];
        for (const r of toctou) {
          const retried = await request(sql, { role: "authenticated", sub: userE }, async (tx) => {
            const x = await tx.unsafe(
              `select public.apply_synced_shot($1::text::jsonb) as result`,
              [JSON.stringify(shotPayload(String(r.detail!.shotId), String(r.detail!.permitId)))],
            );
            const p = await tx.unsafe(
              `select status || '/' || coalesce(outcome, '') as s from public.analysis_permits where id = $1`,
              [String(r.detail!.permitId)],
            );
            return { result: String(x[0].result), permitAfter: String(p[0]?.s ?? "missing") };
          });
          retries.push({ lane: r.lane, ...retried });
        }
        const permitsAfterRetry = await sql.unsafe(
          `select count(*)::int as n from public.analysis_permits where user_id = $1 and status = 'reserved'`,
          [userE],
        );
        Object.assign(observations, {
          resultHistogram: countBy(rows, (r) => r.result),
          scoredShotsAfter: shots,
          permitHistogram: permitHist,
          lifetimeScoredCount: ledger,
          flipCommittedMs,
          acceptedApplies: accepted.length,
          acceptedAppliesStartedAfterFlipCommit: lateAccepted.length,
          toctouWriteFailedLanes: toctou.map((r) => ({
            lane: r.lane,
            serverStartMs: r.serverStartMs,
            serverEndMs: r.serverEndMs,
            flipCommittedMs,
          })),
          toctouRetries: retries,
          postBurst: afterFlip,
          wallMs,
        });
        checkWall(invariants, wallMs, timedOut);
        inv(
          invariants,
          "zero_lane_errors",
          laneErrors(rows).length === 0,
          JSON.stringify(laneErrors(rows)),
        );
        inv(
          invariants,
          "only_contract_verdicts_or_toctou_write_failed",
          badResults.length === 0,
          JSON.stringify(badResults.map((r) => r.result)),
        );
        inv(
          invariants,
          "scored_shots_equal_2_plus_accepted",
          shots === 2 + accepted.length,
          `shots=${shots} accepted=${accepted.length}`,
        );
        inv(
          invariants,
          "finalized_permits_equal_scored_shots",
          (permitHist["finalized/scored"] ?? 0) === shots,
          JSON.stringify(permitHist),
        );
        inv(
          invariants,
          "ledger_equals_scored_shots",
          ledger === shots,
          `lifetime_scored_count=${ledger} shots=${shots}`,
        );
        inv(
          invariants,
          "reserved_left_only_by_toctou_lanes",
          (permitHist["reserved/"] ?? 0) === toctou.length,
          `reserved=${permitHist["reserved/"] ?? 0} toctou=${toctou.length}`,
        );
        inv(
          invariants,
          "toctou_retry_yields_paywall_and_releases_permit",
          retries.every(
            (r) =>
              r.result === "access.paywall_required" &&
              r.permitAfter === "released/free_limit_exceeded",
          ) && Number(permitsAfterRetry[0].n) === 0,
          JSON.stringify(retries),
        );
        inv(
          invariants,
          "toctou_only_when_flip_overlaps_apply",
          toctou.every(
            (r) =>
              Number.isFinite(flipCommittedMs) &&
              (r.serverStartMs ?? 0) < flipCommittedMs &&
              (r.serverEndMs ?? 0) >
                (rows.find((f) => f.op === "flip_premium_off")?.serverStartMs ?? Infinity),
          ),
          JSON.stringify(toctou.map((r) => [r.lane, r.serverStartMs, r.serverEndMs])),
        );
        inv(
          invariants,
          "no_transient_write_failed_on_premium_flip",
          toctou.length === 0,
          `${toctou.length} lane(s) got shot.write_failed:42501 instead of access.paywall_required (permit left reserved until retry/sweep)`,
          "known-gap",
        );
        inv(
          invariants,
          "no_rating_after_flip_commit",
          lateAccepted.length === 0,
          `${lateAccepted.length} accepted applies started after the flip committed`,
        );
        inv(
          invariants,
          "flip_not_lost",
          afterFlip.reserve === "access.paywall_required" && afterFlip.premium === false,
          JSON.stringify(afterFlip),
        );
        inv(
          invariants,
          "bystander_F_isolated",
          readerRows.length === 3 &&
            readerRows.every(
              (r) =>
                r.result === "F_free" &&
                Array.isArray(r.detail?.visible) &&
                (r.detail!.visible as string[]).every((v) => v === userF) &&
                r.detail?.scored === 0,
            ),
          JSON.stringify(readerRows.map((r) => [r.result, r.detail])),
        );
        await dropUser(sql, userE);
        await dropUser(sql, userF);
        return rows;
      },
    );
    assertScenario(report);
  },
});

// ── S6: stale-permit sweep vs apply at the 24h boundary (two users) ──────────

Deno.test({
  name: "S6 permit_sweep_vs_apply_boundary — cron expiry sweep races apply_synced_shot on permits straddling 24h",
  ignore,
  async fn() {
    const report = await scenario(
      "S6_permit_sweep_vs_apply_boundary",
      "users G and H hold reserved permits created 24h ± jitter ago; apply lanes consume them while sweep lanes run the pg_cron expiry",
      async (sql, prng, _round, invariants, inputs, observations) => {
        const userG = prng.uuid();
        const userH = prng.uuid();
        await createUser(sql, userG, `sub-${userG}`);
        await createUser(sql, userH, `sub-${userH}`);
        const nSweep = 2;
        const applyLanes = LANES - nSweep;
        const permits: Array<{ lane: number; user: string; permitId: string; ageMs: number }> = [];
        for (let i = 0; i < applyLanes; i++) {
          const user = i % 2 === 0 ? userG : userH;
          const ageMs = 24 * 3_600_000 + prng.int(-1500, 1500);
          const permitId = prng.uuid();
          await sql.unsafe(
            `insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
             values ($1, $2, $3, clock_timestamp() - ($4::int * interval '1 millisecond'))`,
            [permitId, user, `k-${i}-${permitId}`, ageMs],
          );
          permits.push({ lane: i, user, permitId, ageMs });
        }
        Object.assign(inputs, {
          userG,
          userH,
          permits: permits.map((p) => ({
            lane: p.lane,
            user: p.user === userG ? "G" : "H",
            ageMs: p.ageMs,
          })),
        });

        const { rows, wallMs, timedOut } = await burst(LANES, prng, (ctx) => {
          if (ctx.lane >= applyLanes) {
            return lane(ctx, "cron", "expire_stale_permits", async (record) => {
              const out = await request(sql, { role: "owner" }, async (tx) => {
                const t0 = await serverNowMs(tx);
                const r = await tx.unsafe(
                  `update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours'`,
                );
                return { count: r.count, t0, t1: await serverNowMs(tx) };
              });
              record({
                result: `expired_${out.count}`,
                serverStartMs: out.t0,
                serverEndMs: out.t1,
              });
            });
          }
          const p = permits[ctx.lane];
          return lane(
            ctx,
            p.user === userG ? "authenticated:G" : "authenticated:H",
            "apply",
            async (record) => {
              const shotId = ctx.prng.uuid();
              const out = await request(sql, { role: "authenticated", sub: p.user }, async (tx) => {
                const t0 = await serverNowMs(tx);
                const r = await tx.unsafe(
                  `select public.apply_synced_shot($1::text::jsonb) as result`,
                  [JSON.stringify(shotPayload(shotId, p.permitId))],
                );
                return { result: String(r[0].result), t0, t1: await serverNowMs(tx) };
              });
              record({
                result: `apply:${out.result}`,
                serverStartMs: out.t0,
                serverEndMs: out.t1,
                detail: { shotId, permitId: p.permitId },
              });
            },
          );
        });

        const state = await sql.unsafe(
          `select p.id::text as id, p.user_id::text as user_id, p.status, coalesce(p.outcome, '') as outcome
             from public.analysis_permits p where p.user_id = any($1::uuid[])`,
          [[userG, userH]],
        );
        const shotByPermit = new Map<string, number>();
        for (const r of rows) {
          if (r.result === "apply:accepted" && r.detail?.permitId) {
            const n = Number(
              (
                await sql.unsafe(
                  `select count(*)::int as n from public.shots where id = $1 and result_kind = 'scored'`,
                  [String(r.detail.shotId)],
                )
              )[0].n,
            );
            shotByPermit.set(String(r.detail.permitId), n);
          }
        }
        const permitState: Record<string, string> = {};
        for (const s of state) permitState[String(s.id)] = `${s.status}/${s.outcome}`;
        const scoredG = Number(
          (
            await sql.unsafe(
              `select count(*)::int as n from public.shots where user_id = $1 and result_kind = 'scored'`,
              [userG],
            )
          )[0].n,
        );
        const scoredH = Number(
          (
            await sql.unsafe(
              `select count(*)::int as n from public.shots where user_id = $1 and result_kind = 'scored'`,
              [userH],
            )
          )[0].n,
        );
        const applies = rows.filter((r) => r.op === "apply");
        const accepted = applies.filter((r) => r.result === "apply:accepted");
        const badResults = applies.filter(
          (r) =>
            ![
              "apply:accepted",
              "apply:access.permit_expired",
              "apply:access.permit_not_reserved",
              "apply:access.paywall_required",
            ].includes(r.result),
        );
        const finalizedWithoutShot = accepted.filter(
          (r) =>
            shotByPermit.get(String(r.detail!.permitId)) !== 1 ||
            permitState[String(r.detail!.permitId)] !== "finalized/scored",
        );
        const finalizedCount = Object.values(permitState).filter(
          (s) => s === "finalized/scored",
        ).length;
        Object.assign(observations, {
          resultHistogram: countBy(rows, (r) => r.result),
          permitStateHistogram: countBy(Object.values(permitState), (s) => s),
          scoredG,
          scoredH,
          wallMs,
        });
        checkWall(invariants, wallMs, timedOut);
        inv(
          invariants,
          "zero_lane_errors",
          laneErrors(rows).length === 0,
          JSON.stringify(laneErrors(rows)),
        );
        inv(
          invariants,
          "only_contract_verdicts",
          badResults.length === 0,
          JSON.stringify(badResults.map((r) => r.result)),
        );
        inv(
          invariants,
          "no_permit_left_reserved",
          !Object.values(permitState).some((s) => s.startsWith("reserved")),
          JSON.stringify(countBy(Object.values(permitState), (s) => s)),
        );
        inv(
          invariants,
          "accepted_apply_iff_finalized_permit_with_shot",
          finalizedWithoutShot.length === 0 && finalizedCount === accepted.length,
          `accepted=${accepted.length} finalized=${finalizedCount} mismatched=${finalizedWithoutShot.length}`,
        );
        inv(
          invariants,
          "free_limit_never_exceeded",
          scoredG <= 2 && scoredH <= 2,
          `scoredG=${scoredG} scoredH=${scoredH}`,
        );
        inv(
          invariants,
          "scored_shots_equal_accepted",
          scoredG + scoredH === accepted.length,
          `shots=${scoredG + scoredH} accepted=${accepted.length}`,
        );
        await dropUser(sql, userG);
        await dropUser(sql, userH);
        return rows;
      },
    );
    assertScenario(report);
  },
});

// ── S7: RLS reads/writes from clients during service-role writes ─────────────

Deno.test({
  name: "S7 entitlement_rls_under_writes — authenticated/anon probes while service role rewrites both users' rows",
  ignore,
  async fn() {
    const report = await scenario(
      "S7_entitlement_rls_under_writes",
      "service-role upserts for users A and B interleave with authenticated A/B and anon probes (select own / insert / update / delete / webhook_events select)",
      async (sql, prng, _round, invariants, inputs, observations) => {
        const userA = prng.uuid();
        const userB = prng.uuid();
        await createUser(sql, userA, `sub-${userA}`);
        await createUser(sql, userB, `sub-${userB}`);
        const nowMs = await serverNowMsAuto(sql);
        await request(sql, { role: "service_role" }, (tx) =>
          entitlementUpsert(tx, userA, {
            premium: true,
            productKey: "pickle_sensei_pro_yearly",
            expiresAt: null,
            verifiedAt: new Date(nowMs).toISOString(),
          }),
        );
        await request(sql, { role: "service_role" }, (tx) =>
          entitlementUpsert(tx, userB, {
            premium: false,
            productKey: null,
            expiresAt: null,
            verifiedAt: new Date(nowMs).toISOString(),
          }),
        );
        const nProbe = Math.max(3, Math.floor(LANES / 2));
        const writerLanes = LANES - nProbe;
        const plan = Array.from({ length: writerLanes }, () => ({
          target: prng.bool(0.5) ? userA : userB,
          verdict: seededVerdict(prng, nowMs, prng.int(-2000, 2000)),
        }));
        Object.assign(inputs, { userA, userB, writerLanes, nProbe, plan });

        const { rows, wallMs, timedOut } = await burst(LANES, prng, (ctx) => {
          if (ctx.lane < writerLanes) {
            const p = plan[ctx.lane];
            return lane(ctx, "service_role", "upsert", async (record) => {
              const out = await request(sql, { role: "service_role" }, async (tx) => {
                const t0 = await serverNowMs(tx);
                const count = await entitlementUpsert(tx, p.target, p.verdict);
                return { count, t0, t1: await serverNowMs(tx) };
              });
              record({
                result: `upserted_${out.count}`,
                serverStartMs: out.t0,
                serverEndMs: out.t1,
                detail: { target: p.target === userA ? "A" : "B" },
              });
            });
          }
          const which = (ctx.lane - writerLanes) % 3;
          const actor: Actor =
            which === 2
              ? { role: "anon" }
              : { role: "authenticated", sub: which === 0 ? userA : userB };
          const self = which === 0 ? userA : userB;
          const other = which === 0 ? userB : userA;
          return lane(
            ctx,
            actor.role === "anon" ? "anon" : `authenticated:${which === 0 ? "A" : "B"}`,
            "client_probe",
            async (record) => {
              // read: must see only own row (or nothing as anon)
              try {
                const seen = await request(sql, actor, async (tx) => {
                  const t0 = await serverNowMs(tx);
                  const r = await tx.unsafe(
                    `select user_id::text as user_id, premium from public.billing_entitlements`,
                  );
                  return { ids: r.map((x) => String(x.user_id)), t0, t1: await serverNowMs(tx) };
                });
                const ok =
                  actor.role === "anon"
                    ? false
                    : seen.ids.every((id) => id === self) && seen.ids.length <= 1;
                record({
                  result: ok ? "select_own_only" : `select_LEAKED`,
                  serverStartMs: seen.t0,
                  serverEndMs: seen.t1,
                  detail: { ids: seen.ids },
                });
              } catch (e) {
                record({
                  result: actor.role === "anon" ? "select_denied" : "select_ERROR",
                  sqlstate: sqlstate(e),
                });
              }
              const writes: Array<[string, string]> = [
                [
                  "insert_self",
                  `insert into public.billing_entitlements (user_id, premium) values ('${self}', true) on conflict (user_id) do update set premium = true`,
                ],
                [
                  "update_self",
                  `update public.billing_entitlements set premium = true, expires_at = null where user_id = '${self}'`,
                ],
                [
                  "update_other",
                  `update public.billing_entitlements set premium = false where user_id = '${other}'`,
                ],
                [
                  "delete_self",
                  `delete from public.billing_entitlements where user_id = '${self}'`,
                ],
                ["webhook_select", `select count(*) from public.webhook_events`],
              ];
              for (const [op, stmt] of writes) {
                await sleep(ctx.prng.int(0, Math.floor(JITTER_MS / 2)));
                try {
                  await request(sql, actor, async (tx) => {
                    await tx.unsafe(stmt);
                  });
                  record({ result: `${op}_ALLOWED` });
                } catch (e) {
                  record({ result: `${op}_denied`, sqlstate: sqlstate(e) });
                }
              }
            },
          );
        });

        const final = await readEntitlements(sql, [userA, userB]);
        const rowA = final.find((r) => r.user_id === userA);
        const rowB = final.find((r) => r.user_id === userB);
        const probes = rows.filter((r) => r.op === "client_probe");
        const leaks = probes.filter(
          (r) => r.result === "select_LEAKED" || r.result === "select_ERROR",
        );
        const allowed = probes.filter((r) => r.result.endsWith("_ALLOWED"));
        const nonPerm = probes.filter(
          (r) => r.result.endsWith("_denied") && r.sqlstate !== "42501",
        );
        const candidatesA = plan.filter((p) => p.target === userA).map((p) => p.verdict);
        const candidatesB = plan.filter((p) => p.target === userB).map((p) => p.verdict);
        const okA =
          !!rowA &&
          (candidatesA.length === 0
            ? rowA.premium === true
            : candidatesA.some((v) => sameVerdict(rowA, v)));
        const okB =
          !!rowB &&
          (candidatesB.length === 0
            ? rowB.premium === false
            : candidatesB.some((v) => sameVerdict(rowB, v)));
        Object.assign(observations, {
          resultHistogram: countBy(rows, (r) => r.result),
          finalA: rowA ?? null,
          finalB: rowB ?? null,
          wallMs,
        });
        checkWall(invariants, wallMs, timedOut);
        inv(
          invariants,
          "zero_lane_errors",
          laneErrors(rows).length === 0,
          JSON.stringify(laneErrors(rows)),
        );
        inv(
          invariants,
          "authenticated_select_sees_only_own_row",
          leaks.length === 0,
          JSON.stringify(leaks.map((r) => [r.actor, r.result, r.detail, r.sqlstate])),
        );
        inv(
          invariants,
          "client_writes_and_webhook_reads_always_42501",
          allowed.length === 0 && nonPerm.length === 0,
          `allowed=${JSON.stringify(allowed.map((r) => [r.actor, r.result]))} nonPermissionDenials=${JSON.stringify(nonPerm.map((r) => [r.actor, r.result, r.sqlstate]))}`,
        );
        inv(
          invariants,
          "rows_only_carry_service_verdicts",
          okA && okB,
          `A=${JSON.stringify(rowA)} B=${JSON.stringify(rowB)}`,
        );
        inv(invariants, "exactly_one_row_per_user", final.length === 2, `rows=${final.length}`);
        await dropUser(sql, userA);
        await dropUser(sql, userB);
        return rows;
      },
    );
    assertScenario(report);
  },
});

// ── Guard: the harness never runs against a hosted project ───────────────────

Deno.test("guard — STRESS_PG_URL, when set, is a loopback disposable database", () => {
  if (!PG_URL) return;
  const host = new URL(PG_URL).hostname;
  assert(["127.0.0.1", "localhost", "::1"].includes(host), `refusing non-loopback host ${host}`);
  assert(!PG_URL.includes("ucqnaiwqwjtgvlduiuib"), "refusing the production project");
});
