/**
 * stress_shots_sync_pg_concurrency — the SAME seeded campaign as
 * stress_shots_sync_concurrency.test.ts (real edge handler, modelled
 * GoTrue/RevenueCat/Upstash), but every database call the route makes —
 * the batched `shots` replay lookup, `apply_synced_shot(jsonb)`,
 * `reserve_analysis_permit(text)`, `access_state()` — is bridged to a REAL
 * postgres:16 with shim_auth.sql + every migration applied (./xc_pg_up.sh),
 * one independent connection/transaction per request as role `authenticated`
 * with the caller's JWT sub, so the per-user advisory xact locks, the unique
 * index, the free_rating_ledger trigger and the write gate genuinely contend.
 *
 *   ./xc_pg_up.sh                                      # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres STRESS_ITER=520 \
 *     deno test --allow-all --no-check stress_shots_sync_pg_concurrency.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) the test is `ignore`d — an
 * ignored run is NOT a pass. Same STRESS_* knobs as the fake-backend file.
 */
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import { isRecord, loadXcHarness, SUPABASE_URL } from "./xc_concurrency_harness.ts";
import {
  runCampaign,
  type Snapshot,
  STRESS_ITER,
  STRESS_SEED,
  type StressBackend,
} from "./stress_shots_sync_common.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const POOL = 48;
const IP_OCTET = 79;

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertUuid = (v: string): string => {
  if (!uuidRe.test(v)) throw new Error(`not a uuid: ${v}`);
  return v;
};

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${assertUuid(userId)}'`);
}

/** PostgREST error envelope for a failed statement (supabase-js surfaces it
 * as `error`, which the route turns into shot.write_failed / 503). */
function pgError(e: unknown): Response {
  const err = e as { code?: string; message?: string; detail?: string; hint?: string };
  return json(400, {
    code: err.code ?? "XX000",
    message: err.message ?? String(e),
    details: err.detail ?? null,
    hint: err.hint ?? null,
  });
}

/** Concurrency actually reached on the database side: how many
 * apply_synced_shot transactions were open at once (proof the advisory lock
 * was contended rather than the calls trickling in one by one). */
const bridgeStats = { applyInflight: 0, applyInflightMax: 0, applyCalls: 0 };

/** Install the Postgres bridge in front of the fake's fetch dispatcher. */
function bridge(h: Awaited<ReturnType<typeof loadXcHarness>>, sql: Sql): void {
  const fake = h.fake;
  const passthrough = fake.handleFetch.bind(fake);
  fake.handleFetch = async (request: Request, rawBody: string): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== SUPABASE_URL || !url.pathname.startsWith("/rest/v1/")) {
      return passthrough(request, rawBody);
    }
    const target = url.pathname.slice("/rest/v1/".length);
    const who = fake.principal(request.headers);
    let body: Record<string, unknown> = {};
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody);
        body = isRecord(parsed) ? parsed : {};
      } catch {
        body = {};
      }
    }

    if (target === "rpc/apply_synced_shot" && request.method === "POST") {
      fake.counters["pg.apply_synced_shot"] = (fake.counters["pg.apply_synced_shot"] ?? 0) + 1;
      if (who.role !== "user" || !who.userId) return json(401, { message: "auth.required" });
      bridgeStats.applyCalls++;
      bridgeStats.applyInflight++;
      bridgeStats.applyInflightMax = Math.max(
        bridgeStats.applyInflightMax,
        bridgeStats.applyInflight,
      );
      try {
        let result = "";
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, who.userId!);
          const r = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as result`, [
            JSON.stringify(body.shot ?? {}),
          ]);
          result = String(r[0].result);
        });
        return json(200, result);
      } catch (e) {
        return pgError(e);
      } finally {
        bridgeStats.applyInflight--;
      }
    }

    if (target === "rpc/reserve_analysis_permit" && request.method === "POST") {
      fake.counters["pg.reserve_analysis_permit"] =
        (fake.counters["pg.reserve_analysis_permit"] ?? 0) + 1;
      if (who.role !== "user" || !who.userId) return json(401, { message: "auth.required" });
      try {
        let rows: Array<Record<string, unknown>> = [];
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, who.userId!);
          const r = await tx.unsafe(
            `select result, permit_id::text as permit_id, permit_status, permit_outcome,
                    to_char(permit_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as permit_created_at
               from public.reserve_analysis_permit($1)`,
            [String(body.p_idempotency_key ?? "")],
          );
          rows = r.map((row) => ({ ...row }));
        });
        return json(200, rows);
      } catch (e) {
        return pgError(e);
      }
    }

    if (target === "rpc/access_state" && request.method === "POST") {
      fake.counters["pg.access_state"] = (fake.counters["pg.access_state"] ?? 0) + 1;
      if (who.role !== "user" || !who.userId) return json(401, { message: "auth.required" });
      try {
        let rows: Array<Record<string, unknown>> = [];
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, who.userId!);
          const r = await tx.unsafe(
            `select premium, scored_count, reserved_count from public.access_state()`,
          );
          rows = r.map((row) => ({
            premium: Boolean(row.premium),
            scored_count: Number(row.scored_count),
            reserved_count: Number(row.reserved_count),
          }));
        });
        return json(200, rows);
      } catch (e) {
        return pgError(e);
      }
    }

    if (target === "shots" && request.method === "GET") {
      // syncShots' batched replay lookup: select=id&user_id=eq.<uid>&id=in.(…)
      const inParam = url.searchParams.get("id") ?? "";
      const eqUser = url.searchParams.get("user_id") ?? "";
      if (!inParam.startsWith("in.(") || !eqUser.startsWith("eq.") || who.role !== "user") {
        throw new Error(`pg bridge: unmodelled shots query ${url.search} as ${who.role}`);
      }
      fake.counters["pg.shots_lookup"] = (fake.counters["pg.shots_lookup"] ?? 0) + 1;
      const ids = inParam
        .slice(4, -1)
        .split(",")
        .map((s) => s.replace(/^"|"$/g, ""))
        .filter((s) => s.length > 0)
        .map(assertUuid);
      try {
        let rows: Array<{ id: string }> = [];
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, who.userId!);
          const r = await tx.unsafe(
            `select id::text as id from public.shots where user_id = $1::uuid and id = any($2::uuid[])`,
            [eqUser.slice(3), ids],
          );
          rows = r.map((row) => ({ id: String(row.id) }));
        });
        return json(200, rows);
      } catch (e) {
        return pgError(e);
      }
    }

    return passthrough(request, rawBody);
  };
}

function pgBackend(h: Awaited<ReturnType<typeof loadXcHarness>>, sql: Sql): StressBackend {
  const fake = h.fake;
  return {
    name: "pg",
    prepareUser: async (sub) => {
      assertUuid(sub);
      // seeded ids repeat across runs on the same disposable DB: clear the
      // user cascade and the identity ledger row (which survives deletion BY
      // DESIGN) so every iteration starts from zero.
      await sql.unsafe(`delete from auth.users where id = '${sub}'`);
      await sql.unsafe(
        `delete from public.free_rating_ledger
          where identity_hash = public.free_rating_identity_hash('google', '${sub}')`,
      );
      await sql.unsafe(
        `insert into auth.users (id, email, raw_app_meta_data)
         values ('${sub}', '${sub}@example.com', '{"provider":"google"}')`,
      );
      await sql.unsafe(
        `insert into auth.identities (provider, provider_id, user_id, identity_data)
         values ('google', '${sub}', '${sub}', '{"sub":"${sub}"}')`,
      );
    },
    forgePermit: async (userId, key, createdAtOffsetMs = 0) => {
      const id = fake.prng.uuid();
      await sql.unsafe(
        `insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at)
         values ($1::uuid, $2::uuid, $3, 'reserved', now() + ($4::text || ' milliseconds')::interval)`,
        [id, assertUuid(userId), key, String(createdAtOffsetMs)],
      );
      return id;
    },
    setPermitCreatedAt: async (permitId, createdAtOffsetMs) => {
      await sql.unsafe(
        `update public.analysis_permits
            set created_at = now() + ($2::text || ' milliseconds')::interval
          where id = $1::uuid`,
        [assertUuid(permitId), String(createdAtOffsetMs)],
      );
    },
    setPremium: async (userId, expiresAt) => {
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
         values ($1::uuid, true, 'pickle_sensei_pro_monthly', $2::timestamptz, now())
         on conflict (user_id) do update
           set premium = excluded.premium, expires_at = excluded.expires_at, verified_at = now()`,
        [assertUuid(userId), expiresAt],
      );
      fake.tables.billing_entitlements = fake.tables.billing_entitlements.filter(
        (b) => b.user_id !== userId,
      );
      fake.tables.billing_entitlements.push({
        user_id: userId,
        premium: true,
        expires_at: expiresAt,
        product_key: "pickle_sensei_pro_monthly",
        verified_at: new Date().toISOString(),
      });
    },
    createSession: async (userId, sessionId) => {
      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ($1::uuid, $2::uuid, now())`,
        [assertUuid(sessionId), assertUuid(userId)],
      );
    },
    snapshot: async (userIds) => {
      const ids = userIds.map(assertUuid);
      const shots = await sql.unsafe(
        `select id::text as id, user_id::text as user_id, result_kind
           from public.shots where user_id = any($1::uuid[]) order by created_at, id`,
        [ids],
      );
      const permits = await sql.unsafe(
        `select id::text as id, user_id::text as user_id, status, coalesce(outcome, '') as outcome
           from public.analysis_permits where user_id = any($1::uuid[]) order by created_at, id`,
        [ids],
      );
      const ledger = await sql.unsafe(
        `select i.user_id::text as user_id, l.scored_count
           from auth.identities i
           join public.free_rating_ledger l
             on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
          where i.user_id = any($1::uuid[])`,
        [ids],
      );
      const snap: Snapshot = {
        shots: shots.map((s) => ({
          id: String(s.id),
          userId: String(s.user_id),
          resultKind: String(s.result_kind),
        })),
        permits: permits.map((p) => ({
          id: String(p.id),
          userId: String(p.user_id),
          status: String(p.status),
          outcome: String(p.outcome),
        })),
        ledger: Object.fromEntries(ids.map((id) => [id, 0])),
      };
      for (const l of ledger) snap.ledger[String(l.user_id)] = Number(l.scored_count);
      return snap;
    },
  };
}

Deno.test({
  name:
    `stress: POST /v1/shots:sync concurrency campaign (REAL postgres RPCs, ${STRESS_ITER} seeded interleavings)`,
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: POOL });
    try {
      const h = await loadXcHarness();
      bridge(h, sql);
      const summary = await runCampaign(
        h,
        pgBackend(h, sql),
        IP_OCTET,
        (index) =>
          `cd supabase/functions/api/__wf__ && XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${STRESS_SEED} ` +
          `STRESS_REPLAY=${index} deno test --allow-all --no-check stress_shots_sync_pg_concurrency.test.ts`,
        "stress_shots_sync_pg",
      );
      console.log(
        `[stress:pg] bridge: apply_synced_shot calls=${bridgeStats.applyCalls} ` +
          `max concurrently open transactions=${bridgeStats.applyInflightMax}`,
      );
      const notHeld = summary.iterations.filter((r) => r.outcome !== "HELD");
      assertEquals(
        notHeld.map((r) => ({
          index: r.index,
          seed: r.seed,
          kind: r.kind,
          outcome: r.outcome,
          notHeld: r.invariants.filter((i) => !i.holds).map((i) => `${i.name}: ${i.detail}`),
          replay: r.replay,
        })),
        [],
        `${notHeld.length}/${summary.iterationsExecuted} iterations did not hold`,
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});
