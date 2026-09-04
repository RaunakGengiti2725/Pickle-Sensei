/**
 * STRESS — POST /v1/billing/sync against a REAL Postgres 16.
 *
 * Same in-process handler + stubbed GoTrue / RevenueCat / Upstash as
 * stress_billing_sync_failure_load.test.ts, but the two PostgREST calls the
 * route performs — the service-role upsert into billing_entitlements and the
 * user-scoped access_state() RPC — are translated to SQL on a disposable
 * postgres:16 with shim_auth.sql + every migration applied (./xc_pg_up.sh).
 * The upsert runs as role service_role (bypassrls, exactly like the deployed
 * function); the RPC runs as role authenticated with the caller's JWT sub.
 * Each PostgREST call takes its own pooled connection, so concurrent handler
 * requests genuinely contend in the database.
 *
 *   ./xc_pg_up.sh                       # prints XC_PG_URL
 *   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_OUT_DIR=/tmp/stress/ deno test -A --no-check --config deno.json stress_billing_sync_pg.test.ts
 *
 * Knobs: STRESS_SEED, STRESS_PG_ROUNDS (rounds per scenario, default 3),
 * STRESS_PG_ITER (users in the seeded campaign, default 30).
 * Without STRESS_PG_URL (alias XC_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass.
 *
 * P0 properties under test: duplicate delivery of the same sync never writes
 * more than one row or a wrong verdict; a billing sync never spends, releases
 * or resets a free rating; a lapsed verdict cannot be double-spent into a
 * third free rating even while syncs and reservations race.
 */
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import {
  accessRequest,
  BackendError,
  type BillingRow,
  billingSyncRequest,
  bootStressHarness,
  call,
  envInt,
  fnv1a,
  heapNow,
  histogram,
  ipFor,
  latencySummary,
  type Outcome,
  Prng,
  type RestBackend,
  type StressHarness,
  writeJson,
} from "./stress_billing_sync_harness.ts";

const PG_URL = Deno.env.get("STRESS_PG_URL") ?? Deno.env.get("XC_PG_URL") ?? "";
const ignore = PG_URL === "";
const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const ROUNDS = envInt("STRESS_PG_ROUNDS", 3);
const CAMPAIGN_USERS = envInt("STRESS_PG_ITER", 30);
const LANES = 10; // == the per-user billing_sync budget (10 / 60 s)

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

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

let executed = 0;
const replay = (scenario: string) =>
  `STRESS_SEED=${STRESS_SEED} STRESS_PG_ROUNDS=${ROUNDS} STRESS_PG_ITER=${CAMPAIGN_USERS} STRESS_PG_URL=<url> deno test -A --no-check --config deno.json stress_billing_sync_pg.test.ts --filter "${scenario}"`;

// ── Postgres-backed PostgREST translation ───────────────────────────────────

class PgBackend implements RestBackend {
  /** Optional per-row hook awaited BEFORE the upsert statement (races). */
  beforeUpsert: ((row: BillingRow) => Promise<void>) | null = null;
  upserts = 0;
  rpcs = 0;
  constructor(readonly sql: Sql) {}

  async upsertBilling(row: BillingRow): Promise<void> {
    this.upserts += 1;
    if (this.beforeUpsert) await this.beforeUpsert(row);
    try {
      await this.sql.begin(async (tx) => {
        await tx.unsafe(`set local role service_role`);
        // PostgREST `resolution=merge-duplicates` puts every payload column
        // into DO UPDATE — mirrored exactly.
        await tx.unsafe(
          `insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
           values ($1::uuid, $2::boolean, $3::text, $4::timestamptz, $5::timestamptz)
           on conflict (user_id) do update set
             premium = excluded.premium,
             product_key = excluded.product_key,
             expires_at = excluded.expires_at,
             verified_at = excluded.verified_at`,
          [
            row.user_id,
            row.premium,
            row.product_key,
            row.expires_at,
            row.verified_at,
          ],
        );
      });
    } catch (error) {
      throw toBackendError(error);
    }
  }

  async accessState(userId: string) {
    this.rpcs += 1;
    try {
      return await this.sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, userId);
        const r = await tx.unsafe(
          `select premium, scored_count::int as scored_count, reserved_count::int as reserved_count
             from public.access_state()`,
        );
        if (!r[0]) {
          return { premium: false, scored_count: 0, reserved_count: 0 };
        }
        return {
          premium: Boolean(r[0].premium),
          scored_count: Number(r[0].scored_count),
          reserved_count: Number(r[0].reserved_count),
        };
      });
    } catch (error) {
      throw toBackendError(error);
    }
  }
}

function toBackendError(error: unknown): Error {
  if (error instanceof BackendError) return error;
  const e = error as { code?: string; message?: string };
  const code = typeof e.code === "string" ? e.code : "XX000";
  // PostgREST maps constraint violations to 409 and everything else to 400/500.
  const status = code.startsWith("23") ? 409 : code === "42501" ? 401 : 400;
  return new BackendError(status, code, e.message ?? String(error));
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

/** Seeded ids repeat across runs against the same disposable DB: remove what
 * an earlier run with this seed left behind (user cascade + the identity's
 * ledger row, which survives deletion BY DESIGN). */
async function createUser(
  sql: Sql,
  userId: string,
  identity: { provider: string; sub: string },
) {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `delete from auth.users u using auth.identities i
      where i.user_id = u.id and i.provider = '${identity.provider}' and i.provider_id = '${identity.sub}'`,
  );
  await sql.unsafe(
    `delete from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('${identity.provider}', '${identity.sub}')`,
  );
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"${identity.provider}"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('${identity.provider}', '${identity.sub}', '${userId}', '{"sub":"${identity.sub}"}')`,
  );
}

/** Spend one free rating the real way: reserve a permit, then sync a scored shot. */
async function spendFreeRating(
  sql: Sql,
  userId: string,
  prng: Prng,
  key: string,
): Promise<string> {
  return await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const r = await tx.unsafe(
      `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
    );
    const result = String(r[0].result);
    if (result !== "accepted") return result;
    const shot = {
      id: prng.uuid(),
      analysisPermitId: String(r[0].permit_id),
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
    const a = await tx.unsafe(
      `select public.apply_synced_shot($1::text::jsonb) as result`,
      [
        JSON.stringify(shot),
      ],
    );
    return String(a[0].result);
  });
}

async function reserveAsUser(
  sql: Sql,
  userId: string,
  key: string,
): Promise<string> {
  return await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const r = await tx.unsafe(
      `select x.result from public.reserve_analysis_permit('${key}') x`,
    );
    return String(r[0].result);
  });
}

interface DbRow {
  premium: boolean;
  product_key: string | null;
  expires_at: string | null;
  verified_at: string;
}

async function billingRows(sql: Sql, userId: string): Promise<DbRow[]> {
  const r = await sql.unsafe(
    `select premium, product_key, to_json(expires_at)#>>'{}' as expires_at, to_json(verified_at)#>>'{}' as verified_at
       from public.billing_entitlements where user_id = '${userId}' order by verified_at`,
  );
  return r.map((row) => ({
    premium: Boolean(row.premium),
    product_key: row.product_key === null ? null : String(row.product_key),
    expires_at: row.expires_at === null ? null : String(row.expires_at),
    verified_at: String(row.verified_at),
  }));
}

async function ledger(sql: Sql, userId: string) {
  const r = await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const lifetime = await tx.unsafe(
      `select public.lifetime_scored_count()::int as n`,
    );
    const permits = await tx.unsafe(
      `select count(*)::int as n from public.analysis_permits`,
    );
    const shots = await tx.unsafe(
      `select count(*)::int as n from public.shots where result_kind = 'scored'`,
    );
    return {
      lifetimeScored: Number(lifetime[0].n),
      permits: Number(permits[0].n),
      scoredShots: Number(shots[0].n),
    };
  });
  return r;
}

// ── Shared boot ─────────────────────────────────────────────────────────────

let shared: { sql: Sql; backend: PgBackend; h: StressHarness } | null = null;
async function boot() {
  if (shared) return shared;
  const sql = postgres(PG_URL, { max: LANES + 6 });
  const backend = new PgBackend(sql);
  const h = await bootStressHarness(backend);
  shared = { sql, backend, h };
  return shared;
}

const access = (o: Outcome) =>
  (o.body as { access: Record<string, unknown> }).access;
const billing = (o: Outcome) =>
  (o.body as { billing: Record<string, unknown> }).billing;
/** GET /v1/me/access answers with the access payload itself. */
const readAccess = (o: Outcome) => o.body as Record<string, unknown>;

function summarize(outcomes: Outcome[]) {
  return {
    statuses: histogram(outcomes.map((o) => o.status)),
    classes: histogram(outcomes.map((o) => o.clientClass)),
    latency: latencySummary(outcomes.map((o) => o.latencyMs)),
    contractFailures:
      outcomes.filter((o) => o.status === 200 && o.contractErrors.length)
        .length,
  };
}

// ── PG-A duplicate delivery ─────────────────────────────────────────────────

Deno.test({
  name:
    "STRESS PG-A: same sync delivered ×10 concurrently → 10×200, ONE row, verdict == RevenueCat, 11th is 429",
  ignore,
  async fn() {
    const { sql, h } = await boot();
    const prng = new Prng((STRESS_SEED ^ fnv1a("pg-a")) >>> 0);
    const rounds: unknown[] = [];
    const failures: string[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      const userId = prng.uuid();
      await createUser(sql, userId, {
        provider: "apple",
        sub: `apple-${prng.uuid()}`,
      });
      const state = prng.pick(
        ["active", "lifetime", "lapsed", "none"] as const,
      );
      const expires = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const rc = state === "active"
        ? {
          kind: "active" as const,
          expiresAt: expires,
          product: "pickle_sensei_pro_monthly",
        }
        : state === "lifetime"
        ? { kind: "lifetime" as const, product: "pickle_sensei_pro_lifetime" }
        : state === "lapsed"
        ? {
          kind: "lapsed" as const,
          expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
          product: "pickle_sensei_pro_monthly",
        }
        : { kind: "none" as const };
      h.world.ensureUser(userId, { provider: "apple", rc });
      const token = h.world.mintSession(userId, prng);
      const ip = ipFor(70_000 + r);
      const truth = h.world.expectedPremium(h.world.ensureUser(userId));

      const before = h.world.calls.length;
      const outcomes = await Promise.all(
        Array.from(
          { length: LANES },
          () => call(h, billingSyncRequest(token, ip)),
        ),
      );
      executed += LANES;
      const eleventh = await call(h, billingSyncRequest(token, ip));
      executed += 1;
      const fresh = await call(h, accessRequest(token, ip));
      executed += 1;
      const rows = await billingRows(sql, userId);
      const calls = h.world.calls.slice(before);
      const roundTrips = {
        gotrue: calls.filter((c) => c.upstream === "gotrue").length,
        rc: calls.filter((c) => c.upstream === "rc").length,
        upserts: calls.filter((c) => c.upstream === "rest.upsert").length,
        rpcs: calls.filter((c) => c.upstream === "rest.rpc").length,
      };
      const verifiedAts = outcomes.map((o) => String(billing(o).verifiedAt))
        .sort();
      const problems: string[] = [];
      for (const [i, o] of outcomes.entries()) {
        if (o.status !== 200) {
          problems.push(`lane ${i} status ${o.status} ${o.code}`);
        } else {
          if (o.contractErrors.length) {
            problems.push(`lane ${i} contract ${o.contractErrors.join(";")}`);
          }
          if (billing(o).premium !== truth) {
            problems.push(
              `lane ${i} billing.premium ${billing(o).premium} != ${truth}`,
            );
          }
          if (access(o).premium !== truth) {
            problems.push(`lane ${i} access.premium != truth`);
          }
        }
      }
      if (rows.length !== 1) problems.push(`billing rows ${rows.length} != 1`);
      if (rows[0] && rows[0].premium !== truth) {
        problems.push(`row.premium ${rows[0].premium} != ${truth}`);
      }
      if (
        rows[0] &&
        !verifiedAts.some((v) =>
          Date.parse(v) === Date.parse(rows[0].verified_at)
        )
      ) {
        problems.push(
          `row.verified_at ${rows[0].verified_at} is none of the responses`,
        );
      }
      if (eleventh.status !== 429 || eleventh.code !== "rate_limited") {
        problems.push(
          `11th sync status ${eleventh.status} ${eleventh.code} (expected 429 rate_limited)`,
        );
      }
      if (fresh.status !== 200 || readAccess(fresh).premium !== truth) {
        problems.push(
          `GET /v1/me/access after burst: ${fresh.status} premium=${
            fresh.status === 200 ? readAccess(fresh).premium : "?"
          }`,
        );
      }
      if (roundTrips.upserts !== LANES) {
        problems.push(`upserts ${roundTrips.upserts} != ${LANES}`);
      }
      if (roundTrips.rpcs !== LANES + 1) {
        problems.push(`rpcs ${roundTrips.rpcs} != ${LANES + 1}`);
      }
      if (roundTrips.rc !== LANES) {
        problems.push(`rc calls ${roundTrips.rc} != ${LANES}`);
      }
      rounds.push({
        round: r,
        userId,
        state,
        truth,
        outcomes: summarize(outcomes),
        eleventh: {
          status: eleventh.status,
          code: eleventh.code,
          retryAfter: eleventh.retryAfter,
        },
        rows,
        roundTrips,
        problems,
      });
      if (problems.length) {
        failures.push(`round ${r} (${state}): ${problems.join(" | ")}`);
      }
    }
    const path = await writeJson("pg_a_duplicate_delivery", {
      seed: STRESS_SEED,
      replay: replay("PG-A"),
      lanes: LANES,
      rounds,
      failures,
      heap: heapNow(),
    });
    console.log(
      `[stress-pg-a] rounds=${ROUNDS} lanes=${LANES} failures=${failures.length} → ${path}`,
    );
    assertEquals(failures, []);
  },
});

// ── PG-B divergent verdicts racing ──────────────────────────────────────────

Deno.test({
  name:
    "STRESS PG-B: two syncs with DIVERGENT RevenueCat verdicts race — the row carries whichever committed last (no monotonic guard)",
  ignore,
  async fn() {
    const { sql, backend, h } = await boot();
    const prng = new Prng((STRESS_SEED ^ fnv1a("pg-b")) >>> 0);
    const rounds: unknown[] = [];
    let staleWins = 0;
    let inconsistentResponses = 0;
    let rowSplit = 0;
    for (let r = 0; r < ROUNDS; r++) {
      const userId = prng.uuid();
      await createUser(sql, userId, {
        provider: "google",
        sub: `google-${prng.uuid()}`,
      });
      h.world.ensureUser(userId, {
        rc: {
          kind: "active",
          expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          product: "pickle_sensei_pro_monthly",
        },
      });
      const token = h.world.mintSession(userId, prng);
      const ip = ipFor(71_000 + r);
      // warm the auth cache so both racing requests skip GoTrue identically
      const warm = await call(h, billingSyncRequest(token, ip));
      executed += 1;
      assertEquals(warm.status, 200);

      // Call 0 (first to reach RevenueCat) is told ACTIVE, call 1 is told
      // LAPSED — the newer truth. The ACTIVE upsert is held back so the
      // LAPSED one commits first, then ACTIVE overwrites it.
      let rcCalls = 0;
      h.world.rcOverride = () => {
        const i = rcCalls++;
        return i === 0
          ? {
            entitlements: {
              pickle_sensei_pro: {
                expires_date: new Date(Date.now() + 86_400_000).toISOString(),
                product_identifier: "pickle_sensei_pro_monthly",
              },
            },
          }
          : {
            entitlements: {
              pickle_sensei_pro: {
                expires_date: new Date(Date.now() - 1_000).toISOString(),
                product_identifier: "pickle_sensei_pro_monthly",
              },
            },
          };
      };
      backend.beforeUpsert = async (row) => {
        if (row.premium) await new Promise((res) => setTimeout(res, 120));
      };
      const [a, b] = await Promise.all([
        call(h, billingSyncRequest(token, ip)),
        (async () => {
          await new Promise((res) => setTimeout(res, 15));
          return await call(h, billingSyncRequest(token, ip));
        })(),
      ]);
      executed += 2;
      backend.beforeUpsert = null;
      h.world.rcOverride = null;
      h.world.ensureUser(userId, {
        rc: {
          kind: "lapsed",
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          product: "pickle_sensei_pro_monthly",
        },
      });
      const rows = await billingRows(sql, userId);
      const read = await call(h, accessRequest(token, ip));
      executed += 1;
      const premiums = [a, b].map((
        o,
      ) => (o.status === 200 ? billing(o).premium : null));
      const newestVerdict = [a, b]
        .filter((o) => o.status === 200)
        .sort((x, y) =>
          Date.parse(String(billing(y).verifiedAt)) -
          Date.parse(String(billing(x).verifiedAt))
        )[0];
      const rowPremium = rows[0]?.premium ?? null;
      const stale = newestVerdict !== undefined &&
        rowPremium !== billing(newestVerdict).premium;
      if (stale) staleWins += 1;
      if (premiums.includes(true) && premiums.includes(false)) rowSplit += 1;
      for (const o of [a, b]) {
        if (o.status === 200 && billing(o).premium !== access(o).premium) {
          inconsistentResponses += 1;
        }
      }
      rounds.push({
        round: r,
        userId,
        responses: [a, b].map((o) => ({
          status: o.status,
          premium: o.status === 200 ? billing(o).premium : null,
          verifiedAt: o.status === 200 ? billing(o).verifiedAt : null,
          accessPremium: o.status === 200 ? access(o).premium : null,
          latencyMs: o.latencyMs,
        })),
        rows,
        readAfter: {
          status: read.status,
          premium: read.status === 200 ? readAccess(read).premium : null,
        },
        newestVerdictPremium: newestVerdict
          ? billing(newestVerdict).premium
          : null,
        rowPremium,
        staleVerdictPersisted: stale,
      });
      // Hard invariants regardless of ordering: exactly one row, both
      // responses 200, and each response is internally consistent.
      assertEquals(rows.length, 1, `round ${r} rows`);
      assertEquals([a.status, b.status], [200, 200], `round ${r} statuses`);
    }
    const path = await writeJson("pg_b_divergent_verdict_race", {
      seed: STRESS_SEED,
      replay: replay("PG-B"),
      rounds,
      staleVerdictPersistedRounds: staleWins,
      rowsSplitAcrossResponses: rowSplit,
      inconsistentResponses,
      heap: heapNow(),
    });
    console.log(
      `[stress-pg-b] rounds=${ROUNDS} staleVerdictPersisted=${staleWins}/${ROUNDS} inconsistentResponses=${inconsistentResponses} → ${path}`,
    );
    assertEquals(inconsistentResponses, 0);
    // The stale-write count is REPORTED (finding evidence), not asserted:
    // the property "newest RevenueCat verdict wins" does not exist in the code.
  },
});

// ── PG-C free ratings vs billing sync ───────────────────────────────────────

Deno.test({
  name:
    "STRESS PG-C: billing syncs never spend/release/reset free ratings; a lapsed verdict cannot be double-spent under concurrent reservations",
  ignore,
  async fn() {
    const { sql, h } = await boot();
    const prng = new Prng((STRESS_SEED ^ fnv1a("pg-c")) >>> 0);
    const rounds: unknown[] = [];
    const failures: string[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      const userId = prng.uuid();
      const identity = { provider: "apple", sub: `apple-${prng.uuid()}` };
      await createUser(sql, userId, identity);
      const spent = prng.pick([0, 1, 2]);
      for (let i = 0; i < spent; i++) {
        assertEquals(
          await spendFreeRating(sql, userId, prng, `seed-${r}-${i}`),
          "accepted",
        );
      }
      const ledgerBefore = await ledger(sql, userId);
      const lapsed = {
        kind: "lapsed" as const,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        product: "pickle_sensei_pro_monthly",
      };
      const active = {
        kind: "active" as const,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        product: "pickle_sensei_pro_monthly",
      };
      h.world.ensureUser(userId, { provider: "apple", rc: lapsed });
      const token = h.world.mintSession(userId, prng);
      const ip = ipFor(72_000 + r);
      const problems: string[] = [];

      // 1. Lapsed → the sync reports the exact free-rating arithmetic.
      const s1 = await call(h, billingSyncRequest(token, ip));
      executed += 1;
      const remaining = 2 - spent;
      if (s1.status !== 200) problems.push(`lapsed sync ${s1.status}`);
      else {
        const acc = access(s1);
        const fr = acc.freeRatings as Record<string, number>;
        const expect = {
          premium: false,
          used: spent,
          reserved: 0,
          remaining,
          availableToReserve: remaining,
          canStartRating: remaining > 0,
          paywallRequired: remaining === 0,
        };
        const got = {
          premium: acc.premium,
          used: fr.used,
          reserved: fr.reserved,
          remaining: fr.remaining,
          availableToReserve: fr.availableToReserve,
          canStartRating: acc.canStartRating,
          paywallRequired: acc.paywallRequired,
        };
        if (JSON.stringify(got) !== JSON.stringify(expect)) {
          problems.push(
            `lapsed access ${JSON.stringify(got)} != ${JSON.stringify(expect)}`,
          );
        }
      }

      // 2. Race: 5 syncs (lapsed) ‖ 6 reservations with distinct keys.
      //    Exactly `remaining` may be accepted — never more.
      const keys = Array.from(
        { length: 6 },
        (_, i) => `race-${r}-${i}-${prng.uuid()}`,
      );
      const raced = await Promise.all([
        ...Array.from(
          { length: 5 },
          () => call(h, billingSyncRequest(token, ip)),
        ),
        ...keys.map((k) => reserveAsUser(sql, userId, k)),
      ]);
      executed += 11;
      const syncs = raced.slice(0, 5) as Outcome[];
      const reserves = raced.slice(5) as string[];
      const accepted = reserves.filter((x) => x === "accepted").length;
      const refused = reserves.filter((x) =>
        x === "access.paywall_required"
      ).length;
      if (accepted !== remaining) {
        problems.push(
          `accepted ${accepted} reservations, allowed ${remaining}`,
        );
      }
      if (accepted + refused !== 6) {
        problems.push(`unexpected reserve results ${JSON.stringify(reserves)}`);
      }
      for (const [i, o] of syncs.entries()) {
        if (o.status !== 200) {
          problems.push(`raced sync ${i} status ${o.status}`);
        } else if (access(o).premium !== false) {
          problems.push(`raced sync ${i} premium true`);
        } else {
          const fr = access(o).freeRatings as Record<string, number>;
          if (fr.used !== spent) {
            problems.push(`raced sync ${i} used ${fr.used} != ${spent}`);
          }
          if (fr.reserved + fr.availableToReserve !== remaining) {
            problems.push(`raced sync ${i} reserved+available != remaining`);
          }
        }
      }
      const ledgerMid = await ledger(sql, userId);
      if (ledgerMid.lifetimeScored !== ledgerBefore.lifetimeScored) {
        problems.push(
          `syncs changed lifetime count ${ledgerBefore.lifetimeScored}→${ledgerMid.lifetimeScored}`,
        );
      }
      if (ledgerMid.permits !== ledgerBefore.permits + accepted) {
        problems.push(
          `permit rows ${ledgerMid.permits} != ${
            ledgerBefore.permits + accepted
          }`,
        );
      }

      // 3. One more reservation while lapsed: refused iff nothing remains.
      const extra = await reserveAsUser(
        sql,
        userId,
        `extra-${r}-${prng.uuid()}`,
      );
      executed += 1;
      if (extra !== "access.paywall_required") {
        problems.push(
          `post-race reservation ${extra} (should be refused: all free ratings are reserved/spent)`,
        );
      }

      // 4. Purchase → premium bypasses the allowance but does not touch it.
      h.world.ensureUser(userId, { rc: active });
      const s2 = await call(h, billingSyncRequest(token, ip));
      executed += 1;
      if (s2.status === 429) {
        // 7 syncs so far this minute; the budget is 10 — this must not happen
        problems.push("premium sync rate limited unexpectedly");
      } else if (s2.status !== 200) problems.push(`premium sync ${s2.status}`);
      else {
        const acc = access(s2);
        const fr = acc.freeRatings as Record<string, number>;
        if (
          acc.premium !== true || acc.canStartRating !== true ||
          acc.paywallRequired !== false
        ) problems.push(`premium access ${JSON.stringify(acc)}`);
        if (fr.used !== spent) {
          problems.push(`premium sync changed used ${fr.used} != ${spent}`);
        }
      }
      const premiumReserve = await reserveAsUser(
        sql,
        userId,
        `premium-${r}-${prng.uuid()}`,
      );
      executed += 1;
      if (premiumReserve !== "accepted") {
        problems.push(`premium reservation ${premiumReserve}`);
      }

      // 5. Lapse again → back to exactly the pre-purchase arithmetic.
      h.world.ensureUser(userId, { rc: lapsed });
      const s3 = await call(h, billingSyncRequest(token, ip));
      executed += 1;
      const ledgerAfter = await ledger(sql, userId);
      if (s3.status !== 200) problems.push(`re-lapse sync ${s3.status}`);
      else {
        const acc = access(s3);
        const fr = acc.freeRatings as Record<string, number>;
        if (acc.premium !== false) problems.push("re-lapse premium true");
        if (fr.used !== spent) {
          problems.push(`re-lapse used ${fr.used} != ${spent}`);
        }
        // every free rating is now spent or held by a live permit
        if (fr.availableToReserve !== 0 || acc.canStartRating !== false) {
          problems.push(
            `re-lapse availableToReserve ${fr.availableToReserve} canStart ${acc.canStartRating}`,
          );
        }
      }
      if (ledgerAfter.lifetimeScored !== ledgerBefore.lifetimeScored) {
        problems.push("lifetime count drifted");
      }
      const rows = await billingRows(sql, userId);
      if (rows.length !== 1 || rows[0].premium !== false) {
        problems.push(
          `final rows ${JSON.stringify(rows)}`,
        );
      }

      rounds.push({
        round: r,
        userId,
        spent,
        remaining,
        reserves,
        accepted,
        ledgerBefore,
        ledgerMid,
        ledgerAfter,
        syncs: summarize([s1, ...syncs, s2, s3]),
        rows,
        problems,
      });
      if (problems.length) {
        failures.push(
          `round ${r} spent=${spent}: ${problems.join(" | ")}`,
        );
      }
    }
    const path = await writeJson("pg_c_free_ratings_vs_sync", {
      seed: STRESS_SEED,
      replay: replay("PG-C"),
      rounds,
      failures,
      heap: heapNow(),
    });
    console.log(
      `[stress-pg-c] rounds=${ROUNDS} failures=${failures.length} → ${path}`,
    );
    assertEquals(failures, []);
  },
});

// ── PG-D expiry honoured by the database ────────────────────────────────────

Deno.test({
  name:
    "STRESS PG-D: a persisted premium row stops granting access the moment expires_at passes, without a re-sync",
  ignore,
  async fn() {
    const { sql, h } = await boot();
    const prng = new Prng((STRESS_SEED ^ fnv1a("pg-d")) >>> 0);
    const userId = prng.uuid();
    await createUser(sql, userId, {
      provider: "google",
      sub: `google-${prng.uuid()}`,
    });
    const expiresAt = new Date(Date.now() + 1_500).toISOString();
    h.world.ensureUser(userId, {
      rc: { kind: "active", expiresAt, product: "pickle_sensei_pro_monthly" },
    });
    const token = h.world.mintSession(userId, prng);
    const ip = ipFor(73_000);
    const sync = await call(h, billingSyncRequest(token, ip));
    const readNow = await call(h, accessRequest(token, ip));
    await new Promise((res) => setTimeout(res, 1_700));
    const readLater = await call(h, accessRequest(token, ip));
    executed += 3;
    const rows = await billingRows(sql, userId);
    const path = await writeJson("pg_d_expiry", {
      seed: STRESS_SEED,
      replay: replay("PG-D"),
      expiresAt,
      sync: {
        status: sync.status,
        billing: sync.status === 200 ? billing(sync) : null,
        access: sync.status === 200 ? access(sync) : null,
      },
      readNow: {
        status: readNow.status,
        access: readNow.status === 200 ? readAccess(readNow) : null,
      },
      readLater: {
        status: readLater.status,
        access: readLater.status === 200 ? readAccess(readLater) : null,
      },
      rows,
    });
    console.log(
      `[stress-pg-d] sync=${sync.status} now=${
        readNow.status === 200 ? readAccess(readNow).premium : "?"
      } later=${
        readLater.status === 200 ? readAccess(readLater).premium : "?"
      } → ${path}`,
    );
    assertEquals(sync.status, 200);
    assertEquals(billing(sync).premium, true);
    assertEquals(access(sync).premium, true);
    assertEquals(readNow.status, 200);
    assertEquals(readAccess(readNow).premium, true);
    assertEquals(readLater.status, 200);
    assertEquals(readAccess(readLater).premium, false);
    assertEquals(
      readAccess(readLater).canStartRating,
      true,
      "fresh account still has 2 free ratings",
    );
    assertEquals(rows.length, 1);
    assertEquals(
      rows[0].premium,
      true,
      "row is stale by design; access_state() applies expires_at",
    );
  },
});

// ── PG-E the user role cannot write what the route writes ──────────────────

Deno.test({
  name:
    "STRESS PG-E: authenticated cannot insert/update billing_entitlements (only the service-role path may); reads are own-row only",
  ignore,
  async fn() {
    const { sql, h } = await boot();
    const prng = new Prng((STRESS_SEED ^ fnv1a("pg-e")) >>> 0);
    const victim = prng.uuid();
    const attacker = prng.uuid();
    await createUser(sql, victim, {
      provider: "google",
      sub: `google-${prng.uuid()}`,
    });
    await createUser(sql, attacker, {
      provider: "google",
      sub: `google-${prng.uuid()}`,
    });
    h.world.ensureUser(victim, {
      rc: { kind: "lifetime", product: "pickle_sensei_pro_lifetime" },
    });
    const sync = await call(
      h,
      billingSyncRequest(h.world.mintSession(victim, prng), ipFor(74_000)),
    );
    executed += 1;
    assertEquals(sync.status, 200);

    const attempt = async (label: string, statement: string) => {
      try {
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, attacker);
          await tx.unsafe(statement);
        });
        return { label, outcome: "ALLOWED" };
      } catch (error) {
        const e = error as { code?: string };
        return { label, outcome: `denied ${e.code}` };
      }
    };
    const results = [
      await attempt(
        "insert own premium",
        `insert into public.billing_entitlements (user_id, premium) values ('${attacker}', true)`,
      ),
      await attempt(
        "update victim row",
        `update public.billing_entitlements set premium = false where user_id = '${victim}'`,
      ),
      await attempt(
        "delete victim row",
        `delete from public.billing_entitlements where user_id = '${victim}'`,
      ),
    ];
    executed += results.length;
    const visible = await sql.begin(async (tx) => {
      await asUser(tx as unknown as Tx, attacker);
      const r = await tx.unsafe(
        `select count(*)::int as n from public.billing_entitlements`,
      );
      return Number(r[0].n);
    });
    const own = await sql.begin(async (tx) => {
      await asUser(tx as unknown as Tx, victim);
      const r = await tx.unsafe(
        `select count(*)::int as n from public.billing_entitlements`,
      );
      return Number(r[0].n);
    });
    const path = await writeJson("pg_e_write_paths", {
      seed: STRESS_SEED,
      results,
      victimRowsVisibleToAttacker: visible,
      victimOwnRows: own,
    });
    console.log(
      `[stress-pg-e] ${
        results.map((r) => `${r.label}: ${r.outcome}`).join("; ")
      } → ${path}`,
    );
    for (const r of results) assertEquals(r.outcome, "denied 42501", r.label);
    assertEquals(visible, 0);
    assertEquals(own, 1);
  },
});

// ── PG-F seeded campaign ────────────────────────────────────────────────────

Deno.test({
  name:
    "STRESS PG-F: seeded campaign — STRESS_PG_ITER users × 3 verdict transitions, 8 users in flight; row == last verdict, read agrees",
  ignore,
  async fn() {
    const { sql, backend, h } = await boot();
    const prng = new Prng((STRESS_SEED ^ fnv1a("pg-f")) >>> 0);
    const kinds = ["active", "lapsed", "lifetime", "none"] as const;
    const users = Array.from({ length: CAMPAIGN_USERS }, (_, i) => ({
      id: prng.uuid(),
      identity: {
        provider: prng.chance(0.5) ? "apple" : "google",
        sub: `sub-${prng.uuid()}`,
      },
      seq: [prng.pick(kinds), prng.pick(kinds), prng.pick(kinds)],
      ip: ipFor(80_000 + i),
      spend: prng.pick([0, 0, 1, 2]),
      seed: prng.int(0xffffffff),
    }));
    const rows: unknown[] = [];
    const failures: string[] = [];
    const latencies: number[] = [];
    const rtHist: Record<string, number> = {};
    const upsertsBefore = backend.upserts;
    const rpcsBefore = backend.rpcs;
    let inFlight = 0;
    let index = 0;
    const lane = async () => {
      while (index < users.length) {
        const u = users[index++];
        inFlight += 1;
        const uprng = new Prng(u.seed);
        await createUser(sql, u.id, u.identity);
        for (let i = 0; i < u.spend; i++) {
          assertEquals(
            await spendFreeRating(sql, u.id, uprng, `camp-${u.id}-${i}`),
            "accepted",
          );
        }
        const token = h.world.mintSession(u.id, uprng);
        const record: Record<string, unknown> = {
          user: u.id,
          seq: u.seq,
          spend: u.spend,
          steps: [] as unknown[],
        };
        for (const [step, kind] of u.seq.entries()) {
          const rc = kind === "active"
            ? {
              kind,
              expiresAt: new Date(
                Date.now() + 86_400_000 * (1 + uprng.int(365)),
              ).toISOString(),
              product: "pickle_sensei_pro_monthly",
            }
            : kind === "lapsed"
            ? {
              kind,
              expiresAt: new Date(
                Date.now() - 1_000 * (1 + uprng.int(10_000_000)),
              ).toISOString(),
              product: "pickle_sensei_pro_monthly",
            }
            : kind === "lifetime"
            ? { kind, product: "pickle_sensei_pro_lifetime" }
            : { kind };
          h.world.ensureUser(u.id, { rc });
          const truth = h.world.expectedPremium(h.world.ensureUser(u.id));
          const mark = h.world.calls.length;
          const o = await call(h, billingSyncRequest(token, u.ip));
          executed += 1;
          latencies.push(o.latencyMs);
          const supabaseRt = h.world.calls.slice(mark).filter((c) =>
            c.upstream.startsWith("rest.") && c.user === u.id
          ).length;
          rtHist[String(supabaseRt)] = (rtHist[String(supabaseRt)] ?? 0) + 1;
          const stepRecord: Record<string, unknown> = {
            step,
            kind,
            truth,
            status: o.status,
            supabaseRt,
            latencyMs: o.latencyMs,
          };
          if (o.status !== 200) {
            failures.push(
              `${u.id} step ${step} ${kind}: status ${o.status} ${o.code}`,
            );
          } else {
            if (o.contractErrors.length) {
              failures.push(
                `${u.id} step ${step}: ${o.contractErrors.join(";")}`,
              );
            }
            if (billing(o).premium !== truth) {
              failures.push(
                `${u.id} step ${step} ${kind}: premium ${
                  billing(o).premium
                } != ${truth}`,
              );
            }
            const fr = access(o).freeRatings as Record<string, number>;
            if (fr.used !== u.spend) {
              failures.push(
                `${u.id} step ${step}: used ${fr.used} != ${u.spend}`,
              );
            }
            if (supabaseRt > 3) {
              failures.push(
                `${u.id} step ${step}: ${supabaseRt} Supabase round trips`,
              );
            }
            stepRecord.premium = billing(o).premium;
            stepRecord.used = fr.used;
          }
          (record.steps as unknown[]).push(stepRecord);
        }
        const dbRows = await billingRows(sql, u.id);
        const read = await call(h, accessRequest(token, u.ip));
        executed += 1;
        const finalTruth = h.world.expectedPremium(h.world.ensureUser(u.id));
        record.rows = dbRows;
        record.read = read.status === 200
          ? readAccess(read)
          : { status: read.status };
        if (dbRows.length !== 1) {
          failures.push(`${u.id}: ${dbRows.length} rows`);
        } else if (dbRows[0].premium !== finalTruth) {
          failures.push(
            `${u.id}: row premium ${dbRows[0].premium} != ${finalTruth}`,
          );
        }
        if (read.status !== 200 || readAccess(read).premium !== finalTruth) {
          failures.push(`${u.id}: read premium mismatch`);
        }
        rows.push(record);
        inFlight -= 1;
      }
    };
    await Promise.all(Array.from({ length: 8 }, lane));
    assertEquals(inFlight, 0);
    const path = await writeJson("pg_f_campaign", {
      seed: STRESS_SEED,
      replay: replay("PG-F"),
      users: users.length,
      syncs: users.length * 3,
      latency: latencySummary(latencies),
      supabaseRoundTrips: rtHist,
      dbCalls: {
        upserts: backend.upserts - upsertsBefore,
        rpcs: backend.rpcs - rpcsBefore,
      },
      failures,
      rows,
      heap: heapNow(),
    });
    console.log(
      `[stress-pg-f] users=${users.length} syncs=${latencies.length} p50=${
        latencySummary(latencies).p50
      }ms p95=${latencySummary(latencies).p95}ms rt=${
        JSON.stringify(rtHist)
      } failures=${failures.length} → ${path}`,
    );
    assertEquals(failures, []);
  },
});

Deno.test({
  name: "STRESS PG: teardown",
  ignore,
  async fn() {
    if (shared) {
      await writeJson("pg_summary", {
        seed: STRESS_SEED,
        executed,
        counters: shared.h.world.counters,
      });
      await shared.sql.end({ timeout: 5 });
      console.log(`[stress-pg] executed=${executed}`);
    }
  },
});
