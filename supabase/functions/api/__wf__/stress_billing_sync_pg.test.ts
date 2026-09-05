/**
 * STRESS — POST /v1/billing/sync × concurrency — REAL Postgres half.
 *
 * stress_billing_sync_concurrency.test.ts drives the real edge handler over a
 * MODELLED PostgREST. The route's persistence is `billing_entitlements`
 * upsert(onConflict user_id) as service role, and its downstream consumers
 * are the access RPCs (`access_state()`, `reserve_analysis_permit(text)`)
 * that read `billing_entitlements.premium`. This file issues the exact
 * statement PostgREST generates for that upsert (`Prefer:
 * resolution=merge-duplicates` → INSERT … ON CONFLICT (user_id) DO UPDATE
 * SET every payload column) and the real RPCs on a disposable postgres:16
 * with shim_auth.sql + every migration applied (./xc_pg_up.sh), from N
 * independent connections released from a barrier.
 *
 *   ./xc_pg_up.sh                                  # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_PG_ITER=20 STRESS_OUT_DIR=/tmp/stress-pg/ \
 *     deno test -A --no-check --config deno.json stress_billing_sync_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass;
 * the report records the stage as UNKNOWN.
 *
 * Scenarios (STRESS_PG_ITER seeded iterations each, default 3):
 *   pg_upsert_lww       — K concurrent service-role upserts of the SAME
 *                         user_id with distinct (verified_at, premium):
 *                         exactly one row, no error/deadlock, row == the
 *                         upsert that COMMITTED last (row-lock serialization
 *                         = last-writer-wins), and — deterministically — an
 *                         upsert carrying an OLDER verified_at issued after a
 *                         fresher one overwrites it (the schema has no
 *                         monotonic guard; PostgREST merge-duplicates puts
 *                         every column in DO UPDATE).
 *   pg_revoke_vs_reserve — member (premium row) with the free allowance
 *                         already spent; K concurrent reserve_analysis_permit
 *                         lanes (distinct keys) race a service-role upsert
 *                         that REVOKES premium: every lane ∈ {accepted,
 *                         paywall}, accepted == permit rows inserted (no
 *                         phantom / double permit), and once the revoke is
 *                         committed a fresh reservation is paywalled and
 *                         access_state().premium is false.
 *   pg_dup_key_under_flip — K lanes replaying ONE idempotency key while a
 *                         grant/revoke upsert races them: at most one permit
 *                         row ever exists for the key, every accepted lane
 *                         returns the same permit_id.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { envInt, Prng } from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const ITER = envInt("STRESS_PG_ITER", 3);
const SEED = envInt("STRESS_SEED", 20260905);
const LANES = envInt("STRESS_PG_LANES", 12);
const DEADLINE_MS = envInt("STRESS_DEADLINE_MS", 15_000);
const OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ??
  "artifacts/stress-billing-sync/latest/";
const ONLY = Deno.env.get("STRESS_ONLY");
const REPLAY = Deno.env.get("STRESS_REPLAY");

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

interface Iteration {
  index: number;
  seed: number;
  shape: Record<string, unknown>;
  lanes: Record<string, unknown>[];
  checks: Check[];
  observations: Record<string, unknown>;
  ms: number;
  timedOut: boolean;
  replay: string;
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function iterationSeed(scenario: string, index: number): number {
  return fnv1a(`${SEED}:${scenario}:${index}`);
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

function bounded<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ value?: T; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([
    work.then((value) => ({ value, timedOut: false as const })),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
}

interface Verdict {
  premium: boolean;
  productKey: string | null;
  expiresAt: string | null;
  verifiedAt: string;
}

/** The statement PostgREST emits for
 * `.upsert({...}, { onConflict: "user_id" })` (merge-duplicates): every
 * payload column lands in DO UPDATE. Issued as `service_role` (bypassrls),
 * exactly like billingAdminDb(). Returns the server clock at apply time so
 * the commit order among racing lanes is provable. */
async function upsertAsService(
  sql: Sql,
  userId: string,
  v: Verdict,
): Promise<{ appliedMs: number; error?: string }> {
  try {
    let appliedMs = 0;
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role service_role`);
      const r = await tx.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
         values ($1::uuid, $2::boolean, $3::text, $4::timestamptz, $5::timestamptz)
         on conflict (user_id) do update set
           premium = excluded.premium,
           product_key = excluded.product_key,
           expires_at = excluded.expires_at,
           verified_at = excluded.verified_at
         returning (extract(epoch from clock_timestamp()) * 1000)::float8 as t`,
        [userId, v.premium, v.productKey, v.expiresAt, v.verifiedAt],
      );
      appliedMs = Number(r[0].t);
    });
    return { appliedMs };
  } catch (error) {
    return {
      appliedMs: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readRow(sql: Sql, userId: string) {
  const rows = await sql.unsafe(
    `select premium, product_key, expires_at, verified_at from public.billing_entitlements where user_id = '${userId}'`,
  );
  return rows.map((r) => ({
    premium: Boolean(r.premium),
    productKey: r.product_key === null ? null : String(r.product_key),
    expiresAt: r.expires_at === null
      ? null
      : new Date(r.expires_at).toISOString(),
    verifiedAt: new Date(r.verified_at).toISOString(),
  }));
}

async function reserveAs(
  sql: Sql,
  userId: string,
  key: string,
  gate?: Promise<void>,
  onReady?: () => void,
): Promise<
  { result: string; permitId?: string; error?: string; appliedMs: number }
> {
  try {
    let out = {
      result: "",
      permitId: undefined as string | undefined,
      appliedMs: 0,
    };
    await sql.begin(async (tx) => {
      await asUser(tx as unknown as Tx, userId);
      onReady?.();
      if (gate) await gate;
      const r = await tx.unsafe(
        `select x.result, x.permit_id::text as permit_id, (extract(epoch from clock_timestamp()) * 1000)::float8 as t
           from public.reserve_analysis_permit('${key}') x`,
      );
      out = {
        result: String(r[0].result),
        permitId: r[0].permit_id ? String(r[0].permit_id) : undefined,
        appliedMs: Number(r[0].t),
      };
    });
    return out;
  } catch (error) {
    return {
      result: "error",
      appliedMs: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function accessState(sql: Sql, userId: string) {
  let out = { premium: false, scored_count: 0, reserved_count: 0 };
  await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const r = await tx.unsafe(
      `select premium, scored_count, reserved_count from public.access_state()`,
    );
    out = {
      premium: Boolean(r[0].premium),
      scored_count: Number(r[0].scored_count),
      reserved_count: Number(r[0].reserved_count),
    };
  });
  return out;
}

async function permitRows(sql: Sql, userId: string) {
  const rows = await sql.unsafe(
    `select id::text as id, idempotency_key, status from public.analysis_permits where user_id = '${userId}' order by created_at`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    key: String(r.idempotency_key),
    status: String(r.status),
  }));
}

function check(
  it: Iteration,
  name: string,
  ok: boolean,
  detail?: string,
): void {
  it.checks.push({ name, ok, detail });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── scenarios ────────────────────────────────────────────────────────────────

async function pgUpsertLww(sql: Sql, it: Iteration, prng: Prng): Promise<void> {
  const user = prng.uuid();
  await createUser(sql, user);
  const k = prng.int(4, LANES);
  const base = Date.now() - 60_000;
  // Distinct verified_at per lane (1ms apart, seeded permutation of issue
  // order) — the "RevenueCat answered these in some order" model.
  const verdicts: Verdict[] = Array.from({ length: k }, (_, i) => ({
    premium: prng.next() < 0.5,
    productKey: "pickle_sensei_pro_monthly",
    expiresAt: prng.next() < 0.3
      ? null
      : new Date(base + 86_400_000).toISOString(),
    verifiedAt: new Date(base + i).toISOString(),
  }));
  const order = prng.shuffle(verdicts.map((_, i) => i));
  const stagger = order.map(() => prng.int(0, 3));
  it.shape = { k, order, stagger };

  const results = await Promise.all(
    order.map(async (vi, lane) => {
      await sleep(stagger[lane]);
      const r = await upsertAsService(sql, user, verdicts[vi]);
      return {
        lane,
        verdictIndex: vi,
        verifiedAt: verdicts[vi].verifiedAt,
        ...r,
      };
    }),
  );
  it.lanes = results;

  const rows = await readRow(sql, user);
  const ok = results.filter((r) => !r.error);
  const lastCommitted = ok.slice().sort((a, b) => a.appliedMs - b.appliedMs).at(
    -1,
  )!;
  const freshest = ok.slice().sort((a, b) =>
    a.verifiedAt.localeCompare(b.verifiedAt)
  ).at(-1)!;

  check(
    it,
    "no lane errored (no deadlock / serialization failure)",
    ok.length === results.length,
    results.filter((r) => r.error).map((r) => r.error).join("; "),
  );
  check(
    it,
    "exactly one billing_entitlements row for the user",
    rows.length === 1,
    `rows=${rows.length}`,
  );
  check(
    it,
    "row == the upsert that committed LAST (row-lock serialization, last-writer-wins)",
    rows[0]?.verifiedAt === lastCommitted.verifiedAt &&
      rows[0]?.premium === verdicts[lastCommitted.verdictIndex].premium,
    `row=${JSON.stringify(rows[0])} lastCommitted=${
      JSON.stringify(lastCommitted)
    }`,
  );
  const raceStale = rows[0]?.verifiedAt !== freshest.verifiedAt;
  it.observations.raceStaleOverwrite = raceStale;
  it.observations.rowAfterRace = rows[0] ?? null;
  it.observations.freshestIssued = freshest.verifiedAt;

  // Deterministic half: the freshest verdict is already committed; now a
  // verdict with an OLDER verified_at (an RC response that was in flight
  // longer) lands. Does the schema/statement reject it?
  const stale: Verdict = {
    premium: !verdicts[freshest.verdictIndex].premium,
    productKey: "pickle_sensei_pro_monthly",
    expiresAt: null,
    verifiedAt: new Date(base - 5_000).toISOString(),
  };
  const fresh: Verdict = {
    ...verdicts[freshest.verdictIndex],
    verifiedAt: new Date(base + k + 10).toISOString(),
  };
  const r1 = await upsertAsService(sql, user, fresh);
  const r2 = await upsertAsService(sql, user, stale);
  const after = await readRow(sql, user);
  it.observations.sequentialStaleAfterFresh = {
    fresh,
    stale,
    r1: r1.error ?? "ok",
    r2: r2.error ?? "ok",
    row: after[0] ?? null,
  };
  check(
    it,
    "no lost update: a stale (older verified_at) upsert issued AFTER a fresher one must not overwrite it",
    after.length === 1 && after[0].verifiedAt === fresh.verifiedAt &&
      after[0].premium === fresh.premium,
    `row=${
      JSON.stringify(after[0])
    } fresh.verifiedAt=${fresh.verifiedAt} stale.verifiedAt=${stale.verifiedAt}`,
  );
}

async function pgRevokeVsReserve(
  sql: Sql,
  it: Iteration,
  prng: Prng,
): Promise<void> {
  const user = prng.uuid();
  await createUser(sql, user);
  // Spend the free allowance with two live reserved permits (no premium yet).
  const s1 = await reserveAs(sql, user, `seed-${prng.int(0, 1e9)}-a`);
  const s2 = await reserveAs(sql, user, `seed-${prng.int(0, 1e9)}-b`);
  const s3 = await reserveAs(sql, user, `seed-${prng.int(0, 1e9)}-c`);
  check(
    it,
    "precondition: 2 free permits accepted then paywall",
    s1.result === "accepted" && s2.result === "accepted" &&
      s3.result === "access.paywall_required",
    `${s1.result},${s2.result},${s3.result}`,
  );

  const grantAt = new Date(Date.now() - 10_000).toISOString();
  const g = await upsertAsService(sql, user, {
    premium: true,
    productKey: "pickle_sensei_pro_monthly",
    expiresAt: null,
    verifiedAt: grantAt,
  });
  check(it, "precondition: premium grant upsert ok", !g.error, g.error);

  const k = prng.int(4, LANES);
  const revokeAtLane = prng.int(0, k);
  const keys = Array.from({ length: k }, (_, i) => `seed-${it.seed}-r${i}`);
  it.shape = { k, revokeAtLane, keys };

  const b = barrier();
  let ready = 0;
  const lanes = Promise.all(
    keys.map((key) => reserveAs(sql, user, key, b.gate, () => (ready += 1))),
  );
  while (ready < k) await sleep(1);
  b.open();
  // Revoke lands somewhere inside the burst.
  await sleep(revokeAtLane);
  const revoke = await upsertAsService(sql, user, {
    premium: false,
    productKey: "pickle_sensei_pro_monthly",
    expiresAt: null,
    verifiedAt: new Date(Date.now()).toISOString(),
  });
  const results = await lanes;
  it.lanes = results.map((r, lane) => ({ lane, ...r }));

  const permits = await permitRows(sql, user);
  const burstRows = permits.filter((p) => keys.includes(p.key));
  const accepted = results.filter((r) => r.result === "accepted");
  const errors = results.filter((r) => r.result === "error");
  check(
    it,
    "no lane errored (no deadlock)",
    errors.length === 0 && !revoke.error,
    errors.map((e) => e.error).concat(revoke.error ?? []).join("; "),
  );
  check(
    it,
    "every lane ∈ {accepted, access.paywall_required}",
    results.every((r) =>
      r.result === "accepted" || r.result === "access.paywall_required"
    ),
    results.map((r) => r.result).join(","),
  );
  check(
    it,
    "accepted lanes == permit rows inserted by the burst (no phantom/double permit)",
    accepted.length === burstRows.length,
    `accepted=${accepted.length} rows=${burstRows.length}`,
  );
  check(
    it,
    "every accepted lane's permit_id is a distinct row",
    new Set(accepted.map((a) => a.permitId)).size === accepted.length,
  );

  const state = await accessState(sql, user);
  const post = await reserveAs(sql, user, `seed-${it.seed}-post`);
  it.observations = { accepted: accepted.length, state, post: post.result };
  check(
    it,
    "after revoke committed: access_state().premium == false",
    state.premium === false,
    JSON.stringify(state),
  );
  check(
    it,
    "after revoke committed: fresh reservation is paywalled (allowance spent, no premium)",
    post.result === "access.paywall_required",
    post.result,
  );
}

async function pgDupKeyUnderFlip(
  sql: Sql,
  it: Iteration,
  prng: Prng,
): Promise<void> {
  const user = prng.uuid();
  await createUser(sql, user);
  const startPremium = prng.next() < 0.5;
  await upsertAsService(sql, user, {
    premium: startPremium,
    productKey: "pickle_sensei_pro_monthly",
    expiresAt: null,
    verifiedAt: new Date(Date.now() - 10_000).toISOString(),
  });
  // Spend the allowance so the outcome hinges purely on premium.
  await reserveAs(sql, user, `seed-${it.seed}-a`);
  await reserveAs(sql, user, `seed-${it.seed}-b`);

  const k = prng.int(4, LANES);
  const key = `seed-${it.seed}-dup`;
  const flipAt = prng.int(0, k);
  it.shape = { k, key, startPremium, flipAt };

  const b = barrier();
  let ready = 0;
  const lanes = Promise.all(
    Array.from(
      { length: k },
      () => reserveAs(sql, user, key, b.gate, () => (ready += 1)),
    ),
  );
  while (ready < k) await sleep(1);
  b.open();
  await sleep(flipAt);
  const flip = await upsertAsService(sql, user, {
    premium: !startPremium,
    productKey: "pickle_sensei_pro_monthly",
    expiresAt: null,
    verifiedAt: new Date().toISOString(),
  });
  const results = await lanes;
  it.lanes = results.map((r, lane) => ({ lane, ...r }));

  const permits = (await permitRows(sql, user)).filter((p) => p.key === key);
  const accepted = results.filter((r) => r.result === "accepted");
  check(
    it,
    "no lane errored (no deadlock)",
    results.every((r) => r.result !== "error") && !flip.error,
    results.filter((r) => r.error).map((r) => r.error).join("; "),
  );
  check(
    it,
    "idempotency: at most ONE permit row for the key",
    permits.length <= 1,
    `rows=${permits.length}`,
  );
  check(
    it,
    "every accepted lane returned the same permit_id",
    new Set(accepted.map((a) => a.permitId)).size <= 1,
    accepted.map((a) => a.permitId).join(","),
  );
  check(
    it,
    "accepted lanes ⇒ exactly one row; none accepted ⇒ no row",
    (accepted.length > 0) === (permits.length === 1),
  );
  it.observations = {
    accepted: accepted.length,
    paywalled: results.length - accepted.length,
    rows: permits.length,
  };
}

// ── runner ───────────────────────────────────────────────────────────────────

const SCENARIOS: Record<
  string,
  (sql: Sql, it: Iteration, prng: Prng) => Promise<void>
> = {
  pg_upsert_lww: pgUpsertLww,
  pg_revoke_vs_reserve: pgRevokeVsReserve,
  pg_dup_key_under_flip: pgDupKeyUnderFlip,
};

async function runScenario(name: string): Promise<void> {
  const sql = postgres(PG_URL, { max: LANES + 6, onnotice: () => {} });
  const iterations: Iteration[] = [];
  try {
    const indices = REPLAY ? [-1] : Array.from({ length: ITER }, (_, i) => i);
    for (const index of indices) {
      const seed = REPLAY ? Number(REPLAY) : iterationSeed(name, index);
      const prng = new Prng(seed);
      const it: Iteration = {
        index,
        seed,
        shape: {},
        lanes: [],
        checks: [],
        observations: {},
        ms: 0,
        timedOut: false,
        replay:
          `cd supabase/functions/api/__wf__ && XC_PG_URL=$XC_PG_URL STRESS_ONLY=${name} STRESS_REPLAY=${seed} STRESS_SEED=${SEED} deno test -A --no-check --config deno.json stress_billing_sync_pg.test.ts`,
      };
      const t0 = performance.now();
      const out = await bounded(SCENARIOS[name](sql, it, prng), DEADLINE_MS);
      it.ms = Math.round((performance.now() - t0) * 100) / 100;
      it.timedOut = out.timedOut;
      if (out.timedOut) {
        check(
          it,
          `bounded wall time (${DEADLINE_MS}ms) — DEADLOCK/HANG`,
          false,
        );
      }
      iterations.push(it);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  const broken = iterations.filter((i) => i.checks.some((c) => !c.ok));
  const report = {
    unit: "route-post-v1-billing-sync",
    lens: "concurrency",
    plane: "postgres:16 (disposable, every migration applied)",
    scenario: name,
    campaignSeed: SEED,
    iterations: iterations.length,
    lanes: iterations.reduce((n, i) => n + i.lanes.length, 0),
    broken: broken.length,
    deadlocks: iterations.filter((i) => i.timedOut).length,
    maxMs: Math.max(...iterations.map((i) => i.ms)),
    failedSeeds: broken.map((i) => i.seed),
    table: iterations,
  };
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const path = `${OUT_DIR}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  console.log(
    `[stress billing_sync/${name}] iterations=${report.iterations} lanes=${report.lanes} broken=${report.broken} deadlocks=${report.deadlocks} max=${report.maxMs}ms → ${path}`,
  );
  const failing = new Map<string, number>();
  for (const it of broken) {
    for (const c of it.checks.filter((c) => !c.ok)) {
      failing.set(c.name, (failing.get(c.name) ?? 0) + 1);
    }
  }
  for (const [n, count] of failing) {
    console.log(`[stress]   BROKEN ×${count}: ${n}`);
  }
  for (const it of broken) {
    for (const c of it.checks.filter((c) => !c.ok)) {
      console.log(`  seed ${it.seed}: ${c.name} — ${c.detail ?? ""}`);
    }
  }
  assertEquals(report.deadlocks, 0, "bounded wall time");
  assert(
    broken.length === 0,
    `${broken.length} broken iteration(s); seeds: ${
      report.failedSeeds.join(", ")
    }`,
  );
}

for (const name of Object.keys(SCENARIOS)) {
  Deno.test({
    name: `stress billing_sync/${name}: ${
      REPLAY ? `replay seed ${REPLAY}` : `${ITER} seeded iterations`
    } on real postgres`,
    ignore: ignore || (ONLY !== undefined && ONLY !== name),
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => runScenario(name),
  });
}
