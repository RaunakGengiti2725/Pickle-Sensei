/**
 * stress · GET /v1/me/access — REAL access_state() on a disposable Postgres.
 *
 * The fuzz campaign (stress_route_me_access_fuzz.test.ts) drives the real
 * handler over a modelled PostgREST. This file swaps the model for the REAL
 * RPC: the harness's fake PostgREST forwards rpc/access_state to a
 * postgres:16 with shim_auth.sql + every migration applied (./xc_pg_up.sh),
 * executed as role `authenticated` with the caller's JWT sub — so RLS,
 * lifetime_scored_count(), the identity ledger and the 24 h permit window are
 * the production SQL, and the payload the handler returns is compared with a
 * ground truth computed owner-side from the rows that were seeded.
 *
 *   ./xc_pg_up.sh                      # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_PG_ITER=200 STRESS_OUT_DIR=/tmp/stress-pg/ \
 *     deno test -A --no-check --config deno.json stress_route_me_access_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 * Seeded by STRESS_SEED; every iteration's state is derived from
 * iterSeed(STRESS_SEED, 1_000_000 + i) and is listed in stress_pg_results.json.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { Prng } from "./xc_concurrency_harness.ts";
import {
  accessLogFacts,
  accessPayloadViolations,
  CANONICAL_PATH,
  EDGE_ORIGIN,
  facts,
  iterSeed,
  LEAK_PATTERNS,
  loadStressHarness,
  REQUEST_ID_RE,
  STRESS_PG_ITER,
  STRESS_SEED,
  type StubUser,
  writeJson,
} from "./stress_me_access_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const VERSIONS =
  `'1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1'`;

interface SeededState {
  seed: number;
  userId: string;
  provider: "google" | "apple";
  sub: string;
  billing:
    | "none"
    | "premium-lifetime"
    | "premium-future"
    | "premium-expired"
    | "premium-expires-in-2s"
    | "premium-expired-2s-ago"
    | "not-premium";
  ownScored: number;
  lowConfidence: number;
  ledgerScored: number | null;
  permits: Array<
    { status: "reserved" | "finalized" | "released"; ageSeconds: number }
  >;
  neighborScored: number;
  neighborReserved: number;
}

interface Truth {
  premium: boolean;
  scored: number;
  reserved: number;
}

interface PgRow {
  i: number;
  seed: number;
  state: SeededState;
  truth: Truth;
  rpc:
    | { premium: boolean; scored_count: number; reserved_count: number }
    | null;
  status: number;
  requestId: string | null;
  payload: unknown;
  rpcCalls: number;
  writes: number;
  durationMs: number;
  violations: string[];
}

const DAY = 24 * 3600;

function seededState(seed: number): SeededState {
  const p = new Prng(seed);
  const provider = p.next() < 0.7 ? "google" : "apple";
  const billing = [
    "none",
    "none",
    "premium-lifetime",
    "premium-future",
    "premium-expired",
    "premium-expires-in-2s",
    "premium-expired-2s-ago",
    "not-premium",
  ][p.int(0, 7)] as SeededState["billing"];
  const ownScored = [0, 0, 1, 1, 2, 2, 3, 5, 12][p.int(0, 8)];
  const ledgerRoll = p.next();
  const ledgerScored = ledgerRoll < 0.55
    ? null
    : ledgerRoll < 0.8
    ? ownScored + p.int(1, 3)
    : p.int(0, 2);
  const permits: SeededState["permits"] = [];
  const nPermits = p.int(0, 5);
  for (let k = 0; k < nPermits; k++) {
    const status =
      (["reserved", "reserved", "reserved", "finalized", "released"] as const)[
        p.int(0, 4)
      ];
    // Ages hug the 24 h window edge from both sides plus the interior.
    const age = [
      0,
      1,
      3600,
      DAY / 2,
      DAY - 5,
      DAY - 1,
      DAY + 1,
      DAY + 5,
      3 * DAY,
    ][p.int(0, 8)];
    permits.push({ status, ageSeconds: age });
  }
  return {
    seed,
    userId: p.uuid(),
    provider,
    sub: `${provider}-pg-${seed.toString(16)}`,
    billing,
    ownScored,
    lowConfidence: p.int(0, 2),
    ledgerScored,
    permits,
    neighborScored: p.int(0, 3),
    neighborReserved: p.int(0, 2),
  };
}

function truthOf(s: SeededState): Truth {
  const premium = s.billing === "premium-lifetime" ||
    s.billing === "premium-future" ||
    s.billing === "premium-expires-in-2s";
  const scored = Math.max(s.ownScored, s.ledgerScored ?? 0);
  const reserved =
    s.permits.filter((x) => x.status === "reserved" && x.ageSeconds < DAY)
      .length;
  return { premium, scored, reserved };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function wipeUser(
  sql: Sql,
  s: SeededState,
  userId: string,
  sub: string,
): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `delete from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('${s.provider}', '${sub}')`,
  );
}

function neighborOf(s: SeededState): { userId: string; sub: string } {
  const p = new Prng(s.seed ^ 0x5eed);
  return { userId: p.uuid(), sub: `${s.sub}-neighbor` };
}

async function insertShots(
  sql: Sql,
  userId: string,
  count: number,
  kind: "scored" | "low_confidence",
) {
  for (let k = 0; k < count; k++) {
    const score = kind === "scored" ? "5.5" : "null";
    await sql.unsafe(
      `insert into public.shots (
         id, user_id, shot_type, captured_at, start_ms, end_ms,
         overall_score, analysis_confidence, result_kind,
         app_version, model_bundle_version, pose_model_version,
         paddle_model_version, stroke_detector_version, phase_model_version,
         scoring_model_version, shot_config_version
       ) values (
         gen_random_uuid(), '${userId}', 'drive', now() - interval '${
        k + 1
      } minutes', 0, 1000,
         ${score}, 0.9, '${kind}', ${VERSIONS}
       )`,
    );
  }
}

/** Owner-role seeding of exactly the rows access_state() reads. */
async function seedState(sql: Sql, s: SeededState): Promise<void> {
  const nb = neighborOf(s);
  await wipeUser(sql, s, s.userId, s.sub);
  await wipeUser(sql, s, nb.userId, nb.sub);
  for (const [userId, sub] of [[s.userId, s.sub], [nb.userId, nb.sub]]) {
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data)
         values ('${userId}', '${userId}@example.com', '{"provider":"${s.provider}"}')`,
    );
    await sql.unsafe(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
         values ('${s.provider}', '${sub}', '${userId}', '{"sub":"${sub}"}')`,
    );
  }
  switch (s.billing) {
    case "none":
      break;
    case "premium-lifetime":
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium) values ('${s.userId}', true)`,
      );
      break;
    case "premium-future":
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, expires_at)
           values ('${s.userId}', true, now() + interval '30 days')`,
      );
      break;
    case "premium-expired":
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, expires_at)
           values ('${s.userId}', true, now() - interval '30 days')`,
      );
      break;
    case "premium-expires-in-2s":
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, expires_at)
           values ('${s.userId}', true, now() + interval '2 seconds')`,
      );
      break;
    case "premium-expired-2s-ago":
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, expires_at)
           values ('${s.userId}', true, now() - interval '2 seconds')`,
      );
      break;
    case "not-premium":
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium) values ('${s.userId}', false)`,
      );
      break;
  }
  // Scored shots (the definer trigger writes the identity ledger to own-count).
  await insertShots(sql, s.userId, s.ownScored, "scored");
  await insertShots(sql, s.userId, s.lowConfidence, "low_confidence");
  if (s.ledgerScored !== null) {
    // Identity carried over from a deleted account: ledger may exceed own shots.
    // lifetime_scored_count() = greatest(own, ledger) — a lower ledger is a no-op.
    await sql.unsafe(
      `insert into public.free_rating_ledger (identity_hash, scored_count)
         values (public.free_rating_identity_hash('${s.provider}', '${s.sub}'), ${s.ledgerScored})
         on conflict (identity_hash) do update
           set scored_count = greatest(public.free_rating_ledger.scored_count, excluded.scored_count)`,
    );
  }
  let k = 0;
  for (const permit of s.permits) {
    k += 1;
    await sql.unsafe(
      `insert into public.analysis_permits (user_id, idempotency_key, status, created_at)
         values ('${s.userId}', 'permit-${k}', '${permit.status}', now() - interval '${permit.ageSeconds} seconds')`,
    );
  }
  // Neighbor noise: must be invisible to the caller under RLS.
  await insertShots(sql, nb.userId, s.neighborScored, "scored");
  for (let n = 0; n < s.neighborReserved; n++) {
    await sql.unsafe(
      `insert into public.analysis_permits (user_id, idempotency_key, status)
         values ('${nb.userId}', 'nb-permit-${n}', 'reserved')`,
    );
  }
  await sql.unsafe(
    `insert into public.billing_entitlements (user_id, premium) values ('${nb.userId}', true)`,
  );
}

async function realAccessState(sql: Sql, userId: string) {
  let out:
    | { premium: boolean; scored_count: number; reserved_count: number }
    | undefined;
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
  return out!;
}

Deno.test({
  name:
    "stress · GET /v1/me/access · real access_state() on postgres:16 matches owner-side truth",
  ignore,
  async fn() {
    const harness = await loadStressHarness();
    const { handler, upstream, accessLog } = harness;
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    const rows: PgRow[] = [];
    const t0 = performance.now();
    let lastRpc: PgRow["rpc"] = null;
    upstream.accessStateProvider = async (userId: string) => {
      lastRpc = await realAccessState(sql, userId);
      return [lastRpc];
    };
    try {
      for (let i = 0; i < STRESS_PG_ITER; i++) {
        const seed = iterSeed(STRESS_SEED, 1_000_000 + i);
        const s = seededState(seed);
        await seedState(sql, s);
        const truth = truthOf(s);
        const stub: StubUser = {
          userId: s.userId,
          provider: s.provider,
          sub: s.sub,
          premium: truth.premium,
          scored: truth.scored,
          reserved: truth.reserved,
        };
        upstream.setUser(stub);
        const token = upstream.mintSession(s.userId);
        upstream.reset();
        accessLog.length = 0;
        lastRpc = null;
        const rid = `pg-${seed.toString(16).padStart(8, "0")}`;
        const started = performance.now();
        const response = await handler(
          new Request(`${EDGE_ORIGIN}${CANONICAL_PATH}`, {
            headers: {
              Authorization: `Bearer ${token}`,
              "x-request-id": rid,
              "x-forwarded-for": `198.51.100.${i % 200}`,
            },
          }),
        );
        const f = await facts(response);
        const durationMs = Math.round((performance.now() - started) * 100) /
          100;
        const calls = upstream.calls.slice();
        const log = accessLogFacts(accessLog.slice());
        const violations: string[] = [];
        if (f.status !== 200) violations.push(`status:${f.status}`);
        if (f.requestId !== rid) {
          violations.push(`rid:${String(f.requestId)}!=${rid}`);
        }
        if (!f.requestId || !REQUEST_ID_RE.test(f.requestId)) {
          violations.push("rid:invalid");
        }
        if (log.lines !== 1 || log.requestId !== rid) {
          violations.push(`log:lines=${log.lines}`);
        }
        const writes = calls.filter((c) =>
          c.kind === "write" || c.kind === "unexpected"
        ).length;
        if (writes) violations.push(`write:${writes}`);
        const rpcCalls = calls.filter((c) =>
          c.kind === "rpc.access_state"
        ).length;
        if (rpcCalls !== 1) violations.push(`rpc-calls:${rpcCalls}`);
        for (const [name, re] of LEAK_PATTERNS) {
          if (re.test(f.bodyText)) violations.push(`leak:${name}`);
        }
        violations.push(...accessPayloadViolations(f.bodyJson, stub));
        if (lastRpc) {
          const rpc = lastRpc as {
            premium: boolean;
            scored_count: number;
            reserved_count: number;
          };
          if (rpc.premium !== truth.premium) {
            violations.push(`rpc:premium=${rpc.premium}!=${truth.premium}`);
          }
          if (rpc.scored_count !== truth.scored) {
            violations.push(
              `rpc:scored_count=${rpc.scored_count}!=${truth.scored}`,
            );
          }
          if (rpc.reserved_count !== truth.reserved) {
            violations.push(
              `rpc:reserved_count=${rpc.reserved_count}!=${truth.reserved}`,
            );
          }
        }
        rows.push({
          i,
          seed,
          state: s,
          truth,
          rpc: lastRpc,
          status: f.status,
          requestId: f.requestId,
          payload: f.bodyJson,
          rpcCalls,
          writes,
          durationMs,
          violations,
        });
      }
    } finally {
      upstream.accessStateProvider = null;
      await sql.end({ timeout: 5 });
    }
    const broken = rows.filter((r) => r.violations.length);
    const summary = {
      pgUrlHost: new URL(PG_URL).host,
      seed: STRESS_SEED,
      iterations: rows.length,
      durationMs: Math.round(performance.now() - t0),
      billingHistogram: count(rows.map((r) => r.state.billing)),
      truthHistogram: count(
        rows.map((r) =>
          `p${r.truth.premium ? 1 : 0}/s${r.truth.scored}/r${r.truth.reserved}`
        ),
      ),
      ledgerAboveOwn: rows.filter((r) =>
        (r.state.ledgerScored ?? 0) > r.state.ownScored
      ).length,
      permitsAtWindowEdge: rows.reduce(
        (n, r) =>
          n +
          r.state.permits.filter((p) => Math.abs(p.ageSeconds - DAY) <= 5)
            .length,
        0,
      ),
      broken: broken.map((r) => ({ seed: r.seed, violations: r.violations })),
      replay:
        `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${STRESS_SEED} STRESS_PG_ITER=${STRESS_PG_ITER} deno test -A --no-check --config deno.json stress_route_me_access_pg.test.ts`,
    };
    const path = await writeJson("stress_pg_results.json", { summary, rows });
    console.log(
      `[stress] pg: ${rows.length} iterations against real access_state(), ${broken.length} broken, ${summary.durationMs}ms → ${path}`,
    );
    assert(rows.length >= 1, "no iterations ran");
    assertEquals(
      broken.length,
      0,
      `${broken.length} broken: ${
        broken.slice(0, 10).map((r) => `${r.seed}:${r.violations.join("|")}`)
          .join("; ")
      } — ${path}`,
    );
  },
});

function count(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
