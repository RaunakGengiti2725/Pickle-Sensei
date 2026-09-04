// stress-route-get-v1-me-access / lens failure-load — REAL access_state().
//
// The route's one hot-path round trip is `rpc("access_state")`. Here the
// REAL edge handler runs in-process (stress_access_harness) and its fake
// PostgREST delegates that RPC to the REAL `public.access_state()` on a
// disposable postgres:16 with shim_auth.sql + EVERY migration applied
// (./xc_pg_up.sh), executed as role `authenticated` with the bearer's sub —
// exactly what PostgREST does in production.
//
// A seeded population of users is built THROUGH the real write paths
// (reserve_analysis_permit → apply_synced_shot, billing_entitlements as the
// service, stale/consumed/released permits, expired premium, and account
// deletion + re-sign-in with the same identity — the free-rating ledger's
// reason to exist). For every user the owner-derived truth is compared with
// (a) access_state() called directly and (b) the JSON the route serves.
//
//   ./xc_pg_up.sh                      # prints XC_PG_URL
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     STRESS_PG_USERS=200 deno test -A --no-check --config deno.json stress_v1_me_access_pg.test.ts
//
// Without XC_PG_URL the test is `ignore`d — an ignored run is NOT a pass.
// Report: <STRESS_OUT_DIR|artifacts/stress-route-get-v1-me-access/latest/>pg.json

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  accessInvariantViolations,
  accessRequest,
  caseSeed,
  envInt,
  histogram,
  latencySummary,
  loadStressHarness,
  observe,
  Prng,
  STRESS_SEED,
  writeJson,
} from "./stress_access_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const PG_USERS = envInt("STRESS_PG_USERS", 24);

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

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function asUserTx<T>(sql: Sql, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out!: T;
  await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    out = await fn(tx as unknown as Tx);
  });
  return out;
}

interface Identity {
  provider: "google" | "apple";
  sub: string;
}

async function createUser(sql: Sql, userId: string, identity: Identity, keepLedger: boolean) {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  if (!keepLedger) {
    await sql.unsafe(
      `delete from auth.users u using auth.identities i
        where i.user_id = u.id and i.provider = '${identity.provider}' and i.provider_id = '${identity.sub}'`,
    );
    await sql.unsafe(
      `delete from public.free_rating_ledger
        where identity_hash = public.free_rating_identity_hash('${identity.provider}', '${identity.sub}')`,
    );
  }
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
      values ('${userId}', '${userId}@example.com', '{"provider":"${identity.provider}"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
      values ('${identity.provider}', '${identity.sub}', '${userId}', '{"sub":"${identity.sub}"}')`,
  );
}

async function reserve(sql: Sql, userId: string, key: string) {
  return await asUserTx(sql, userId, async (tx) => {
    const r = await tx.unsafe(
      `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
    );
    return {
      result: String(r[0].result),
      permitId: r[0].permit_id ? String(r[0].permit_id) : null,
    };
  });
}

async function applyShot(sql: Sql, userId: string, shot: Record<string, unknown>) {
  return await asUserTx(sql, userId, async (tx) => {
    const r = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as result`, [
      JSON.stringify(shot),
    ]);
    return String(r[0].result);
  });
}

interface StateRow {
  premium: boolean;
  scored_count: number;
  reserved_count: number;
}

/** The REAL RPC, as the user — what PostgREST would run for the route. */
async function accessState(sql: Sql, userId: string): Promise<StateRow[]> {
  return await asUserTx(sql, userId, async (tx) => {
    const r = await tx.unsafe(
      `select premium, scored_count, reserved_count from public.access_state()`,
    );
    return r.map((row) => ({
      premium: Boolean(row.premium),
      scored_count: Number(row.scored_count),
      reserved_count: Number(row.reserved_count),
    }));
  });
}

/** Owner-role reading of the tables the RPC is specified over. */
async function truthOf(
  sql: Sql,
  userId: string,
  identity: Identity,
): Promise<StateRow & { ownScored: number; ledger: number }> {
  const [b] = await sql.unsafe(
    `select coalesce((select premium and (expires_at is null or expires_at > now())
        from public.billing_entitlements where user_id = '${userId}'), false) as premium`,
  );
  const [s] = await sql.unsafe(
    `select count(*)::int as n from public.shots where user_id = '${userId}' and result_kind = 'scored'`,
  );
  const [l] = await sql.unsafe(
    `select coalesce((select scored_count from public.free_rating_ledger
        where identity_hash = public.free_rating_identity_hash('${identity.provider}', '${identity.sub}')), 0)::int as n`,
  );
  const [p] = await sql.unsafe(
    `select count(*)::int as n from public.analysis_permits
      where user_id = '${userId}' and status = 'reserved' and created_at > now() - interval '24 hours'`,
  );
  const ownScored = Number(s.n);
  const ledger = Number(l.n);
  return {
    premium: Boolean(b.premium),
    scored_count: Math.max(ownScored, ledger),
    reserved_count: Number(p.n),
    ownScored,
    ledger,
  };
}

function expectedPayload(t: StateRow) {
  const used = Math.min(2, t.scored_count);
  const remaining = 2 - used;
  const reserved = Math.min(t.reserved_count, remaining);
  const availableToReserve = remaining - reserved;
  const canStartRating = t.premium || availableToReserve > 0;
  return {
    premium: t.premium,
    entitlements: t.premium ? ["premium"] : [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

interface UserScript {
  i: number;
  identity: Identity;
  premium: "none" | "active" | "lifetime" | "expired";
  scoreAttempts: number;
  reserveAttempts: number;
  stalePermit: boolean;
  finalizedPermit: boolean;
  releasedPermit: boolean;
  reincarnate: boolean;
}

interface UserRecord {
  script: UserScript;
  userId: string;
  previousUserId: string | null;
  writes: Record<string, number>;
  truth: StateRow & { ownScored: number; ledger: number };
  rpc: StateRow[];
  rpcMs: number;
  route: { status: number; roundTrips: number; durationMs: number; body: unknown };
  violations: string[];
}

Deno.test({
  name: `stress pg: real access_state() over ${PG_USERS} seeded users through the real route`,
  ignore,
  async fn() {
    const h = await loadStressHarness({ redis: false });
    h.reset();
    const seed = caseSeed("pg");
    const prng = new Prng(seed);
    const sql = postgres(PG_URL, { max: 4 });
    const t0 = performance.now();
    const records: UserRecord[] = [];
    const rpcLatencies: number[] = [];
    try {
      for (let i = 0; i < PG_USERS; i++) {
        const identity: Identity = {
          provider: prng.next() < 0.5 ? "google" : "apple",
          sub: `stress-${prng.uuid()}`,
        };
        const script: UserScript = {
          i,
          identity,
          premium: (
            [
              "none",
              "none",
              "none",
              "none",
              "none",
              "none",
              "active",
              "lifetime",
              "expired",
              "none",
            ] as const
          )[prng.int(0, 9)],
          scoreAttempts: prng.int(0, 4),
          reserveAttempts: prng.int(0, 3),
          stalePermit: prng.next() < 0.25,
          finalizedPermit: prng.next() < 0.25,
          releasedPermit: prng.next() < 0.25,
          reincarnate: prng.next() < 0.3,
        };
        let userId = prng.uuid();
        await createUser(sql, userId, identity, false);
        const writes: Record<string, number> = {};
        const bump = (k: string) => (writes[k] = (writes[k] ?? 0) + 1);

        if (script.premium !== "none") {
          const expires =
            script.premium === "active"
              ? `now() + interval '30 days'`
              : script.premium === "expired"
                ? `now() - interval '1 day'`
                : `null`;
          await sql.unsafe(
            `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
              values ('${userId}', true, 'pickle_sensei_pro', ${expires})`,
          );
          bump(`billing.${script.premium}`);
        }

        // Real write path: reserve → apply (scored shot). Free accounts are
        // refused by the RPCs past two lifetime ratings; the truth below is
        // read from the tables, not from these results.
        for (let k = 0; k < script.scoreAttempts; k++) {
          const r = await reserve(sql, userId, `score-${i}-${k}-${prng.uuid()}`);
          bump(`reserve.${r.result}`);
          if (r.result !== "accepted" || !r.permitId) continue;
          const a = await applyShot(sql, userId, shotPayload(prng.uuid(), r.permitId));
          bump(`apply.${a}`);
        }
        for (let k = 0; k < script.reserveAttempts; k++) {
          const r = await reserve(sql, userId, `hold-${i}-${k}-${prng.uuid()}`);
          bump(`reserve.${r.result}`);
        }
        if (script.stalePermit) {
          // A reservation older than the RPC's 24h freshness window (owner write).
          const r = await reserve(sql, userId, `stale-${i}-${prng.uuid()}`);
          bump(`reserve.${r.result}`);
          if (r.permitId) {
            await sql.unsafe(
              `update public.analysis_permits set created_at = now() - interval '25 hours' where id = '${r.permitId}'`,
            );
            bump("permit.aged25h");
          }
        }
        if (script.finalizedPermit || script.releasedPermit) {
          const r = await reserve(sql, userId, `done-${i}-${prng.uuid()}`);
          bump(`reserve.${r.result}`);
          if (r.permitId) {
            const status = script.finalizedPermit ? "finalized" : "released";
            await sql.unsafe(
              `update public.analysis_permits set status = '${status}' where id = '${r.permitId}'`,
            );
            bump(`permit.${status}`);
          }
        }

        // Account deletion + sign in again with the same Apple ID / Google
        // account: every counted row cascades away, the identity ledger must
        // carry the lifetime count into the new account (double-spend guard).
        let previousUserId: string | null = null;
        if (script.reincarnate) {
          previousUserId = userId;
          await sql.unsafe(`delete from auth.users where id = '${userId}'`);
          userId = prng.uuid();
          await createUser(sql, userId, identity, true);
          bump("account.reincarnated");
        }

        const truth = await truthOf(sql, userId, identity);
        const rpcT0 = performance.now();
        const rpc = await accessState(sql, userId);
        const rpcMs = Math.round((performance.now() - rpcT0) * 100) / 100;
        rpcLatencies.push(rpcMs);

        // The real route, its PostgREST answering with the real RPC.
        h.registerUser({ id: userId, provider: identity.provider });
        const token = h.mintSession(userId);
        h.accessStateResolver = (uid) => accessState(sql, uid);
        const o = await observe(
          h,
          accessRequest(token, `10.9.${(i >> 8) & 255}.${1 + (i & 200)}`),
          token,
        );

        const violations: string[] = [];
        if (rpc.length !== 1) violations.push(`access_state returned ${rpc.length} rows`);
        const row = rpc[0];
        if (
          row &&
          (row.premium !== truth.premium ||
            row.scored_count !== truth.scored_count ||
            row.reserved_count !== truth.reserved_count)
        ) {
          violations.push(
            `rpc ${JSON.stringify(row)} ≠ table truth ${JSON.stringify({ premium: truth.premium, scored_count: truth.scored_count, reserved_count: truth.reserved_count })}`,
          );
        }
        if (!truth.premium && truth.ownScored > 2)
          violations.push(`free account holds ${truth.ownScored} scored shots (double-spend)`);
        if (!truth.premium && truth.ownScored + truth.reserved_count > 2) {
          violations.push(
            `free account scored ${truth.ownScored} + live reserved ${truth.reserved_count} > 2`,
          );
        }
        if (script.reincarnate && truth.ledger < 1 && (writes["apply.accepted"] ?? 0) > 0) {
          violations.push(
            `ledger lost the ${writes["apply.accepted"]} ratings spent before deletion`,
          );
        }
        if (o.status !== 200) violations.push(`route ${o.status}: ${o.raw.slice(0, 160)}`);
        else {
          violations.push(...accessInvariantViolations(o.body));
          const want = JSON.stringify(expectedPayload(truth));
          const got = JSON.stringify(o.body);
          if (want !== got) violations.push(`route payload ${got} ≠ truth-derived ${want}`);
        }
        if (o.roundTrips > 3) violations.push(`${o.roundTrips} Supabase round trips`);

        records.push({
          script,
          userId,
          previousUserId,
          writes,
          truth,
          rpc,
          rpcMs,
          route: {
            status: o.status,
            roundTrips: o.roundTrips,
            durationMs: o.durationMs,
            body: o.body,
          },
          violations,
        });
      }
    } finally {
      h.accessStateResolver = null;
      h.teardown();
      await sql.end();
    }

    const broken = records.filter((r) => r.violations.length);
    const report = {
      unit: "route-get-v1-me-access",
      lens: "failure-load",
      stage: "real access_state() on postgres:16 + every migration",
      seed,
      stressSeed: STRESS_SEED,
      users: PG_USERS,
      writes: records.reduce<Record<string, number>>((acc, r) => {
        for (const [k, v] of Object.entries(r.writes)) acc[k] = (acc[k] ?? 0) + v;
        return acc;
      }, {}),
      premiumMix: histogram(records.map((r) => r.script.premium)),
      reincarnated: records.filter((r) => r.script.reincarnate).length,
      rpcLatencyMs: latencySummary(rpcLatencies),
      routeLatencyMs: latencySummary(records.map((r) => r.route.durationMs)),
      routeStatuses: histogram(records.map((r) => r.route.status)),
      routeRoundTrips: histogram(records.map((r) => r.route.roundTrips)),
      scoredCountHistogram: histogram(records.map((r) => r.truth.scored_count)),
      reservedCountHistogram: histogram(records.map((r) => r.truth.reserved_count)),
      violations: broken.length,
      records,
      durationMs: Math.round(performance.now() - t0),
      replay: `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${STRESS_SEED} STRESS_PG_USERS=${PG_USERS} deno test -A --no-check --config deno.json stress_v1_me_access_pg.test.ts`,
    };
    const path = await writeJson("pg", report);
    console.log(
      `[stress] pg: ${PG_USERS} users, writes=${JSON.stringify(report.writes)} rpc p50=${report.rpcLatencyMs.p50}ms p95=${report.rpcLatencyMs.p95}ms route rt=${JSON.stringify(report.routeRoundTrips)} violations=${broken.length} → ${path}`,
    );
    for (const r of broken.slice(0, 10)) {
      console.log(`[stress]   BROKEN user#${r.script.i} ${r.userId}: ${r.violations.join(" | ")}`);
    }
    assertEquals(broken.length, 0, `${broken.length} users violated`);
    assert(
      records.some((r) => r.script.reincarnate && r.truth.ledger >= 1),
      "no reincarnated user with a spent rating was exercised",
    );
    assert(
      records.some((r) => r.truth.premium),
      "no premium user was exercised",
    );
    assert(
      records.some((r) => !r.truth.premium && r.truth.scored_count === 2),
      "no exhausted free account was exercised",
    );
  },
});
