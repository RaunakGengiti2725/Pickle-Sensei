/**
 * stress-route-post-v1-me-delete-confirm / lens CONCURRENCY — REAL Postgres
 * half. `POST /v1/me/delete-confirm` issues no RPC; what it does issue, in
 * this order, is what these scenarios race on a disposable postgres:16 with
 * shim_auth.sql + every migration applied (./xc_pg_up.sh):
 *
 *   authenticated  SELECT account_deletion_requests WHERE user_id = uid
 *   service_role   SELECT / UPDATE / UPSERT account_external_credentials
 *   GoTrue admin   DELETE FROM auth.users WHERE id = uid   (cascade → profiles
 *                  → account_deletion_requests, account_external_credentials,
 *                  shots, analysis_permits … ; auth.identities)
 *
 * The in-process campaign (stress_delete_confirm_concurrency.test.ts) models
 * the FK `account_external_credentials.user_id → profiles(id)` as "an INSERT
 * after the cascade is 23503". PG-A checks that model against the real
 * engine, and PG-B / PG-C cover the two other same-row races the lens asks
 * for: N re-arms of the same account_deletion_requests row (no duplicate
 * rows, no lost update, RLS keeps a second actor out) and a scored shot
 * committing while the account is deleted (the identity ledger — the free
 * ratings — must not be double-spendable by the re-created account).
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_PG_ROUNDS=40 STRESS_OUT_DIR=/tmp/stress/ \
 *     deno test -A --no-check --config deno.json stress_delete_confirm_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 * Seeded by STRESS_SEED; every round derives its ids / lane stagger from
 * (seed, round) and is replayed with STRESS_PG_REPLAY=<round>.
 */
import postgres from "postgres";
import { assert } from "@std/assert";
import { envInt, histogram, Prng } from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const ROUNDS = envInt("STRESS_PG_ROUNDS", 6);
const LANES = envInt("STRESS_PG_LANES", 8);
const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const REPLAY = envInt("STRESS_PG_REPLAY", 0);
const DEADLINE_MS = 15_000;

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

interface Lane {
  round: number;
  lane: number;
  op: string;
  result: string;
  sqlstate: string | null;
  serverStartMs: number;
  serverEndMs: number;
  clientMs: number;
}

interface RoundRow {
  round: number;
  seed: number;
  outcome: "HELD" | "BROKEN";
  inputs: Record<string, unknown>;
  lanes: Lane[];
  overlaps: number;
  failed: string[];
  checks: number;
  durationMs: number;
  replay: string;
}

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-delete-confirm/latest/", import.meta.url).pathname;
}

function roundSeed(scenario: string, round: number): number {
  let h = 0x811c9dc5 ^ STRESS_SEED;
  for (const ch of `${scenario}#${round}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2_147_483_647 || 1;
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function asService(tx: Tx): Promise<void> {
  await tx.unsafe(`set local role service_role`);
}

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

function sqlstateOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return "unknown";
}

/** Seeded ids repeat across runs against the same DB: clear what an earlier
 * run left (the user cascade; the ledger row is removed explicitly because
 * it survives deletion BY DESIGN). */
async function createUser(
  sql: Sql,
  userId: string,
  identity?: { provider: string; sub: string },
  opts: { keepLedger?: boolean } = {},
) {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  if (identity && !opts.keepLedger) {
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
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"${
      identity?.provider ?? "google"
    }"}')`,
  );
  if (identity) {
    await sql.unsafe(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ('${identity.provider}', '${identity.sub}', '${userId}', '{"sub":"${identity.sub}"}')`,
    );
  }
}

async function armDeletion(sql: Sql, userId: string, ageSeconds = 10): Promise<string> {
  const r = await sql.unsafe(
    `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
     values ('${userId}', gen_random_uuid(), now() - interval '${ageSeconds} seconds', now() + interval '15 minutes')
     on conflict (user_id) do update set challenge = excluded.challenge, created_at = excluded.created_at, expires_at = excluded.expires_at
     returning challenge::text as challenge`,
  );
  return String(r[0].challenge);
}

async function rowsFor(sql: Sql, userId: string) {
  const r = await sql.unsafe(
    `select
       (select count(*) from auth.users where id = '${userId}')::int as auth_users,
       (select count(*) from public.profiles where id = '${userId}')::int as profiles,
       (select count(*) from public.account_deletion_requests where user_id = '${userId}')::int as deletion_requests,
       (select count(*) from public.account_external_credentials where user_id = '${userId}')::int as external_credentials,
       (select count(*) from public.shots where user_id = '${userId}')::int as shots,
       (select count(*) from public.analysis_permits where user_id = '${userId}')::int as permits`,
  );
  return {
    auth_users: Number(r[0].auth_users),
    profiles: Number(r[0].profiles),
    deletion_requests: Number(r[0].deletion_requests),
    external_credentials: Number(r[0].external_credentials),
    shots: Number(r[0].shots),
    permits: Number(r[0].permits),
  };
}

type LaneFn = (tx: Tx) => Promise<{ result: string; sqlstate?: string | null }>;

interface LaneSpec {
  op: string;
  /** who the transaction runs as */
  as: { kind: "user"; userId: string } | { kind: "service" } | { kind: "owner" };
  /** seeded stagger after the barrier opens (ms) */
  staggerMs: number;
  fn: LaneFn;
}

/** Every lane: own connection, own transaction, role set, wait at the
 * barrier, stagger, run, COMMIT. A lane that raises records its SQLSTATE
 * (its transaction rolls back). A lane that has not returned by DEADLINE_MS
 * is reported as `harness.deadline` (deadlock / lost wakeup). */
async function burst(sql: Sql, round: number, specs: LaneSpec[]): Promise<Lane[]> {
  const b = barrier();
  let ready = 0;
  const lanes: Lane[] = [];
  const all = Promise.all(
    specs.map((spec, lane) =>
      (async () => {
        const t0 = performance.now();
        let serverStartMs = 0;
        let serverEndMs = 0;
        let result = "";
        let sqlstate: string | null = null;
        try {
          await sql.begin(async (raw) => {
            const tx = raw as unknown as Tx;
            if (spec.as.kind === "user") await asUser(tx, spec.as.userId);
            else if (spec.as.kind === "service") await asService(tx);
            ready += 1;
            await b.gate;
            if (spec.staggerMs > 0) await new Promise((r) => setTimeout(r, spec.staggerMs));
            serverStartMs = await serverNowMs(tx);
            const out = await spec.fn(tx);
            result = out.result;
            sqlstate = out.sqlstate ?? null;
            serverEndMs = await serverNowMs(tx);
          });
        } catch (error) {
          sqlstate = sqlstateOf(error);
          result = `error:${sqlstate}`;
          if (!serverEndMs) serverEndMs = Date.now();
        }
        lanes.push({
          round,
          lane,
          op: spec.op,
          result,
          sqlstate,
          serverStartMs,
          serverEndMs,
          clientMs: Math.round((performance.now() - t0) * 100) / 100,
        });
      })()
    ),
  );
  while (ready < specs.length) await new Promise((r) => setTimeout(r, 1));
  b.open();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), DEADLINE_MS);
  });
  const raced = await Promise.race([all.then(() => "done" as const), deadline]);
  clearTimeout(timer);
  if (raced === "timeout") {
    for (let lane = 0; lane < specs.length; lane++) {
      if (!lanes.some((l) => l.lane === lane)) {
        lanes.push({
          round,
          lane,
          op: specs[lane].op,
          result: "harness.deadline",
          sqlstate: "harness.deadline",
          serverStartMs: 0,
          serverEndMs: 0,
          clientMs: DEADLINE_MS,
        });
      }
    }
  }
  lanes.sort((a, b) => a.lane - b.lane);
  return lanes;
}

function overlapCount(lanes: Lane[]): number {
  let n = 0;
  for (const a of lanes) {
    if (
      a.serverStartMs > 0 &&
      lanes.some(
        (b) =>
          b !== a &&
          b.serverStartMs > 0 &&
          a.serverStartMs < b.serverEndMs &&
          b.serverStartMs < a.serverEndMs,
      )
    ) {
      n++;
    }
  }
  return n;
}

class Round {
  checks: Array<{ name: string; holds: boolean; detail: string }> = [];
  inputs: Record<string, unknown> = {};
  lanes: Lane[] = [];
  constructor(public prng: Prng, public seed: number, public round: number) {}
  check(name: string, holds: boolean, detail: string) {
    this.checks.push({ name, holds, detail });
  }
  laneSummary(): string {
    return this.lanes.map((l) => `${l.op}=${l.result}`).join(" ");
  }
  /** shared: nobody deadlocked, nobody hung, every lane committed or failed
   * with an expected SQLSTATE */
  noDeadlock(expectedStates: string[]) {
    this.check(
      "no deadlock (40P01) and no lane past the deadline",
      this.lanes.every((l) => l.sqlstate !== "40P01" && l.sqlstate !== "harness.deadline"),
      this.laneSummary(),
    );
    this.check(
      `every failing lane failed with an expected SQLSTATE (${expectedStates.join(",")})`,
      this.lanes.every((l) => l.sqlstate === null || expectedStates.includes(l.sqlstate)),
      this.laneSummary(),
    );
  }
}

async function campaign(
  scenario: string,
  filter: string,
  run: (sql: Sql, r: Round) => Promise<void>,
) {
  const sql = postgres(PG_URL, { max: LANES + 4 });
  const rows: RoundRow[] = [];
  const t0 = performance.now();
  const plan = REPLAY > 0 ? [REPLAY - 1] : Array.from({ length: ROUNDS }, (_, i) => i);
  try {
    for (const round of plan) {
      const seed = roundSeed(scenario, round);
      const r = new Round(new Prng(seed), seed, round);
      const rt0 = performance.now();
      try {
        await run(sql, r);
      } catch (error) {
        r.check(
          "round threw",
          false,
          error instanceof Error ? error.stack ?? error.message : String(error),
        );
      }
      const failed = r.checks.filter((c) => !c.holds).map((c) => `${c.name} — ${c.detail}`);
      rows.push({
        round,
        seed,
        outcome: failed.length ? "BROKEN" : "HELD",
        inputs: r.inputs,
        lanes: r.lanes,
        overlaps: overlapCount(r.lanes),
        failed,
        checks: r.checks.length,
        durationMs: Math.round(performance.now() - rt0),
        replay:
          `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${STRESS_SEED} STRESS_PG_LANES=${LANES} STRESS_PG_REPLAY=${
            round + 1
          } deno test -A --no-check --config deno.json stress_delete_confirm_pg.test.ts --filter "${filter}"`,
      });
    }
  } finally {
    await sql.end();
  }
  const broken = rows.filter((r) => r.outcome === "BROKEN");
  const report = {
    unit: "route-post-v1-me-delete-confirm",
    lens: "concurrency",
    plane: "postgres:16 + shim_auth.sql + every migration",
    scenario,
    campaignSeed: STRESS_SEED,
    lanesPerRound: LANES,
    rounds: rows.length,
    lanesRun: rows.reduce((n, r) => n + r.lanes.length, 0),
    lanesOverlapping: rows.reduce((n, r) => n + r.overlaps, 0),
    checks: rows.reduce((n, r) => n + r.checks, 0),
    held: rows.length - broken.length,
    broken: broken.length,
    laneResults: histogram(rows.flatMap((r) => r.lanes.map((l) => `${l.op}=${l.result}`))),
    durationMs: Math.round(performance.now() - t0),
    brokenRounds: broken.map((r) => ({
      round: r.round,
      seed: r.seed,
      failed: r.failed,
      replay: r.replay,
    })),
    rows,
  };
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${scenario}_${STRESS_SEED}${REPLAY ? "_replay" : ""}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  console.log(
    `[stress-pg] ${scenario}: ${rows.length} rounds, ${report.lanesRun} lanes (${report.lanesOverlapping} overlapping), ${report.checks} checks, held=${report.held} broken=${report.broken} in ${report.durationMs}ms → ${path}`,
  );
  for (const r of broken) {
    console.log(`[stress-pg]   BROKEN round=${r.round} seed=${r.seed}`);
    for (const f of r.failed) console.log(`[stress-pg]     ${f}`);
    console.log(`[stress-pg]     replay: ${r.replay}`);
  }
  assert(rows.length > 0, "no rounds ran");
  assert(
    report.lanesOverlapping > 0,
    "lanes never overlapped on the server clock — the campaign did not exercise concurrency",
  );
  assert(broken.length === 0, `${broken.length}/${rows.length} rounds BROKEN — see ${path}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PG-A — deleteUser cascade racing the route's own service-role writes and
//        the owner's pending-row read (the interleaving behind the 503 the
//        in-process campaign reports)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "stress PG-A: auth.users DELETE (cascade) ∥ service-role RC-checkpoint UPSERT ∥ Apple-checkpoint UPDATE ∥ owner SELECT — no orphan, upsert commits-then-cascades or fails 23503, never anything else",
  ignore,
  async fn() {
    await campaign("stress_pg_a_cascade_vs_checkpoint", "stress PG-A", async (sql, r) => {
      const userId = r.prng.uuid();
      await createUser(sql, userId, { provider: "apple", sub: `apple-${userId}` });
      const challenge = await armDeletion(sql, userId);
      const withCredentialRow = r.prng.int(0, 1) === 1;
      if (withCredentialRow) {
        await sql.unsafe(
          `insert into public.account_external_credentials (user_id, apple_refresh_token_encrypted, apple_token_captured_at)
           values ('${userId}', 'v1.${"x".repeat(40)}', now() - interval '1 day')`,
        );
      }
      // Wide stagger so some checkpoint writes land BEFORE the cascade (they
      // must then cascade too) and some AFTER it (they must then fail 23503).
      const stagger = () => r.prng.int(0, 30);
      r.inputs = { userId, challenge, withCredentialRow };
      const before = await rowsFor(sql, userId);
      r.check(
        "precondition: user, profile (trigger) and pending request exist",
        before.auth_users === 1 && before.profiles === 1 && before.deletion_requests === 1,
        JSON.stringify(before),
      );
      const specs: LaneSpec[] = [
        {
          op: "gotrue.deleteUser",
          as: { kind: "owner" },
          staggerMs: r.prng.int(0, 12),
          fn: async (tx) => {
            const out = await tx.unsafe(`delete from auth.users where id = '${userId}'`);
            return { result: `deleted:${out.count}` };
          },
        },
        {
          op: "service.rc_checkpoint_upsert",
          as: { kind: "service" },
          staggerMs: stagger(),
          fn: async (tx) => {
            const out = await tx.unsafe(
              `insert into public.account_external_credentials (user_id, revenuecat_deleted_at, updated_at)
               values ('${userId}', now(), now())
               on conflict (user_id) do update set revenuecat_deleted_at = excluded.revenuecat_deleted_at, updated_at = excluded.updated_at`,
            );
            return { result: `upserted:${out.count}` };
          },
        },
        {
          op: "service.apple_checkpoint_update",
          as: { kind: "service" },
          staggerMs: stagger(),
          fn: async (tx) => {
            const out = await tx.unsafe(
              `update public.account_external_credentials set apple_revoked_at = now(), updated_at = now() where user_id = '${userId}'`,
            );
            return { result: `updated:${out.count}` };
          },
        },
        {
          op: "owner.select_pending",
          as: { kind: "user", userId },
          staggerMs: stagger(),
          fn: async (tx) => {
            const out = await tx.unsafe(
              `select challenge::text as challenge from public.account_deletion_requests where user_id = '${userId}'`,
            );
            return { result: `rows:${out.length}` };
          },
        },
      ];
      // Extra service-role upsert lanes make the FK/lock interplay contend harder.
      for (let i = 4; i < LANES; i++) {
        specs.push({
          op: `service.rc_checkpoint_upsert.${i}`,
          as: { kind: "service" },
          staggerMs: stagger(),
          fn: async (tx) => {
            const out = await tx.unsafe(
              `insert into public.account_external_credentials (user_id, revenuecat_deleted_at, updated_at)
               values ('${userId}', now(), now())
               on conflict (user_id) do update set revenuecat_deleted_at = excluded.revenuecat_deleted_at, updated_at = excluded.updated_at`,
            );
            return { result: `upserted:${out.count}` };
          },
        });
      }
      r.inputs.staggerMs = specs.map((s) => s.staggerMs);
      r.lanes = await burst(sql, r.round, r.prng.shuffle(specs));
      r.noDeadlock(["23503"]);
      const after = await rowsFor(sql, userId);
      r.check(
        "after the burst: auth user, profile, pending request, credential row all gone (no orphan)",
        Object.values(after).every((n) => n === 0),
        JSON.stringify(after),
      );
      const del = r.lanes.find((l) => l.op === "gotrue.deleteUser");
      r.check(
        "deleteUser removed exactly one auth user",
        del?.result === "deleted:1",
        del?.result ?? "missing",
      );
      const upserts = r.lanes.filter((l) => l.op.startsWith("service.rc_checkpoint_upsert"));
      r.check(
        "every RC-checkpoint upsert either committed (then cascaded) or failed 23503 (profile already gone)",
        upserts.every((l) => l.result === "upserted:1" || l.sqlstate === "23503"),
        upserts.map((l) => l.result).join(","),
      );
      const upd = r.lanes.find((l) => l.op === "service.apple_checkpoint_update");
      r.check(
        "Apple-checkpoint UPDATE touched 0 or 1 rows and never failed",
        upd?.sqlstate === null && (upd.result === "updated:0" || upd.result === "updated:1"),
        upd?.result ?? "missing",
      );
      const sel = r.lanes.find((l) => l.op === "owner.select_pending");
      r.check(
        "owner SELECT saw the row (before) or nothing (after) — never an error",
        sel?.sqlstate === null && (sel.result === "rows:1" || sel.result === "rows:0"),
        sel?.result ?? "missing",
      );
      r.inputs.observed = {
        upsertsCommitted: upserts.filter((l) => l.result === "upserted:1").length,
        upserts23503: upserts.filter((l) => l.sqlstate === "23503").length,
        appleUpdate: upd?.result,
        ownerSelect: sel?.result,
      };
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG-B — N concurrent re-arms of the same account_deletion_requests row (the
//        delete-request upsert exactly as PostgREST issues it) plus a second
//        actor trying to plant / read a challenge on the first actor's row
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "stress PG-B: N×authenticated upsert of the same account_deletion_requests row ∥ second actor — one row, challenge is one of the N, no lost update, RLS refuses the other actor",
  ignore,
  async fn() {
    await campaign("stress_pg_b_rearm_same_row", "stress PG-B", async (sql, r) => {
      const a = r.prng.uuid();
      const b = r.prng.uuid();
      await createUser(sql, a);
      await createUser(sql, b);
      const preArmed = r.prng.int(0, 1) === 1;
      const previous = preArmed ? await armDeletion(sql, a, 120) : null;
      const challenges = Array.from({ length: LANES - 2 }, () => r.prng.uuid());
      r.inputs = { a, b, preArmed, previous, challenges };
      const upsert = (userId: string, challenge: string) => async (tx: Tx) => {
        const out = await tx.unsafe(
          `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
           values ('${userId}', '${challenge}', now(), now() + interval '15 minutes')
           on conflict (user_id) do update set challenge = excluded.challenge, created_at = excluded.created_at, expires_at = excluded.expires_at
           returning challenge::text as challenge`,
        );
        return { result: `armed:${String(out[0]?.challenge ?? "")}` };
      };
      const specs: LaneSpec[] = challenges.map((challenge, i) => ({
        op: `A.rearm.${i}`,
        as: { kind: "user", userId: a },
        staggerMs: r.prng.int(0, 3),
        fn: upsert(a, challenge),
      }));
      const bChallenge = r.prng.uuid();
      specs.push({
        op: "B.plant_on_A",
        as: { kind: "user", userId: b },
        staggerMs: r.prng.int(0, 3),
        fn: upsert(a, bChallenge),
      });
      specs.push({
        op: "B.read_A",
        as: { kind: "user", userId: b },
        staggerMs: r.prng.int(0, 3),
        fn: async (tx) => {
          const out = await tx.unsafe(
            `select challenge::text as challenge from public.account_deletion_requests where user_id = '${a}'`,
          );
          return { result: `rows:${out.length}` };
        },
      });
      r.lanes = await burst(sql, r.round, r.prng.shuffle(specs));
      r.noDeadlock(["42501"]);
      const rows = await sql.unsafe(
        `select challenge::text as challenge from public.account_deletion_requests where user_id = '${a}'`,
      );
      r.check(
        "exactly one pending row for A (primary key held under N upserts)",
        rows.length === 1,
        `rows=${rows.length}`,
      );
      const finalChallenge = String(rows[0]?.challenge ?? "");
      r.check(
        "A's final challenge is one of A's N re-arms — never B's, never the stale pre-armed one",
        challenges.includes(finalChallenge),
        `final=${finalChallenge} previous=${previous} bChallenge=${bChallenge}`,
      );
      const rearms = r.lanes.filter((l) => l.op.startsWith("A.rearm"));
      r.check(
        "every re-arm committed and returned its own challenge (no lost update at the statement level)",
        rearms.every((l) => l.result === `armed:${challenges[Number(l.op.split(".")[2])]}`) &&
          rearms.length === challenges.length,
        rearms.map((l) => l.result).join(","),
      );
      // The last committer wins: the row's challenge must equal the re-arm
      // whose server-side end time is the latest.
      const latest = [...rearms].sort((x, y) => y.serverEndMs - x.serverEndMs)[0];
      r.check(
        "row holds the LAST committed re-arm's challenge",
        latest !== undefined && latest.result === `armed:${finalChallenge}`,
        `latest=${latest?.result} final=${finalChallenge}`,
      );
      const plant = r.lanes.find((l) => l.op === "B.plant_on_A");
      r.check(
        "B planting a challenge on A's row is refused by RLS (42501)",
        plant?.sqlstate === "42501",
        plant?.result ?? "missing",
      );
      const read = r.lanes.find((l) => l.op === "B.read_A");
      r.check(
        "B reading A's row sees 0 rows",
        read?.result === "rows:0",
        read?.result ?? "missing",
      );
      await sql.unsafe(`delete from auth.users where id in ('${a}', '${b}')`);
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG-C — a scored shot committing while the account is deleted: the identity
//        ledger (free ratings) must count it, and the re-created account must
//        not be able to spend it again under N concurrent reserves
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "stress PG-C: apply_synced_shot(scored) ∥ auth.users DELETE, then re-create the identity and reserve ×N concurrently — ledger never loses the spend, re-created account gets exactly (2 − ledger) reservations",
  ignore,
  async fn() {
    await campaign("stress_pg_c_ledger_vs_delete", "stress PG-C", async (sql, r) => {
      const sub = `apple-sub-${r.prng.uuid()}`;
      const oldUid = r.prng.uuid();
      await createUser(sql, oldUid, { provider: "apple", sub });
      // Spend the first rating outright; reserve a permit for the second so
      // the race is "the second scored shot commits while the account dies".
      let permitId = "";
      await sql.begin(async (raw) => {
        const tx = raw as unknown as Tx;
        await asUser(tx, oldUid);
        const p1 = await tx.unsafe(
          `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${r.prng.uuid()}') x`,
        );
        assert(String(p1[0].result) === "accepted", `setup reserve 1: ${p1[0].result}`);
        const s1 = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as result`, [
          JSON.stringify(shot(r.prng.uuid(), String(p1[0].permit_id))),
        ]);
        assert(String(s1[0].result) === "accepted", `setup shot 1: ${s1[0].result}`);
        const p2 = await tx.unsafe(
          `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${r.prng.uuid()}') x`,
        );
        assert(String(p2[0].result) === "accepted", `setup reserve 2: ${p2[0].result}`);
        permitId = String(p2[0].permit_id);
      });
      const ledgerBefore = await ledgerOf(sql, "apple", sub);
      r.check(
        "precondition: ledger = 1 after the first scored shot",
        ledgerBefore === 1,
        `ledger=${ledgerBefore}`,
      );
      const shotId = r.prng.uuid();
      r.inputs = { sub, oldUid, permitId, shotId };
      const specs: LaneSpec[] = [
        {
          op: "user.apply_scored_shot",
          as: { kind: "user", userId: oldUid },
          staggerMs: r.prng.int(0, 4),
          fn: async (tx) => {
            const out = await tx.unsafe(
              `select public.apply_synced_shot($1::text::jsonb) as result`,
              [
                JSON.stringify(shot(shotId, permitId)),
              ],
            );
            return { result: String(out[0].result) };
          },
        },
        {
          op: "gotrue.deleteUser",
          as: { kind: "owner" },
          staggerMs: r.prng.int(0, 4),
          fn: async (tx) => {
            const out = await tx.unsafe(`delete from auth.users where id = '${oldUid}'`);
            return { result: `deleted:${out.count}` };
          },
        },
      ];
      r.inputs.staggerMs = specs.map((s) => s.staggerMs);
      r.lanes = await burst(sql, r.round, r.prng.shuffle(specs));
      // apply_synced_shot after the cascade has no profile / permit to write
      // against: a non-accepted result string is fine, and a raised SQLSTATE
      // is fine — EXCEPT a deadlock. The RPC swallows write errors into
      // 'shot.write_failed:<SQLSTATE>', so the result string is inspected too.
      r.check(
        "no deadlock (40P01 raised or swallowed into shot.write_failed) and no lane past the deadline",
        r.lanes.every(
          (l) =>
            l.sqlstate !== "40P01" &&
            !l.result.includes("40P01") &&
            l.sqlstate !== "harness.deadline",
        ),
        r.laneSummary(),
      );
      const apply = r.lanes.find((l) => l.op === "user.apply_scored_shot")!;
      const del = r.lanes.find((l) => l.op === "gotrue.deleteUser")!;
      const after = await rowsFor(sql, oldUid);
      const ledger = await ledgerOf(sql, "apple", sub);
      const applyAccepted = apply.result === "accepted";
      r.check(
        "ledger = 2 if the racing scored shot committed, else 1 — never lost, never double-counted",
        ledger === (applyAccepted ? 2 : 1),
        `apply=${apply.result} ledger=${ledger}`,
      );
      if (del.result !== "deleted:1") {
        // The DELETE was the deadlock victim (GoTrue would answer 500 → route
        // 503, nothing deleted). The account must then be fully intact so the
        // user can simply retry.
        r.check(
          "deleteUser failed → account fully intact (fail-closed: user, profile, shots, permits all still there)",
          after.auth_users === 1 && after.profiles === 1 && after.shots === (applyAccepted ? 2 : 1),
          `delete=${del.result} ${JSON.stringify(after)}`,
        );
        r.inputs.observed = { apply: apply.result, delete: del.result, ledger, after };
        await sql.unsafe(`delete from auth.users where id = '${oldUid}'`);
        return;
      }
      r.check(
        "old account fully cascaded",
        Object.values(after).every((n) => n === 0),
        JSON.stringify(after),
      );
      // Re-create the identity and let N concurrent reserves fight for what is left.
      const newUid = r.prng.uuid();
      await createUser(sql, newUid, { provider: "apple", sub }, { keepLedger: true });
      const reserveSpecs: LaneSpec[] = Array.from({ length: LANES }, (_, i) => ({
        op: `new.reserve.${i}`,
        as: { kind: "user", userId: newUid },
        staggerMs: r.prng.int(0, 2),
        fn: async (tx) => {
          const out = await tx.unsafe(
            `select x.result from public.reserve_analysis_permit('${r.prng.uuid()}') x`,
          );
          return { result: String(out[0].result) };
        },
      }));
      const reserves = await burst(sql, r.round, reserveSpecs);
      r.lanes.push(...reserves.map((l, i) => ({ ...l, lane: specs.length + i })));
      const accepted = reserves.filter((l) => l.result === "accepted").length;
      const paywalled = reserves.filter((l) => l.result === "access.paywall_required").length;
      r.check(
        "re-created account: exactly (2 − ledger) concurrent reserves accepted, the rest paywalled (no double spend)",
        accepted === 2 - ledger && paywalled === LANES - accepted,
        `ledger=${ledger} accepted=${accepted} paywalled=${paywalled} ${
          reserves.map((l) => l.result).join(",")
        }`,
      );
      const access = await sql.begin(async (raw) => {
        const tx = raw as unknown as Tx;
        await asUser(tx, newUid);
        const out = await tx.unsafe(
          `select scored_count, reserved_count from public.access_state()`,
        );
        return { scored: Number(out[0].scored_count), reserved: Number(out[0].reserved_count) };
      });
      r.check(
        "access_state() of the re-created account reports the identity-lifetime scored count and the accepted reservations",
        access.scored === ledger && access.reserved === accepted,
        JSON.stringify(access),
      );
      r.inputs.observed = {
        apply: apply.result,
        delete: del.result,
        ledger,
        accepted,
        paywalled,
        access,
      };
      await sql.unsafe(`delete from auth.users where id = '${newUid}'`);
    });
  },
});

function shot(id: string, analysisPermitId: string): Record<string, unknown> {
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

async function ledgerOf(sql: Sql, provider: string, sub: string): Promise<number> {
  const r = await sql.unsafe(
    `select coalesce((select scored_count from public.free_rating_ledger
       where identity_hash = public.free_rating_identity_hash('${provider}', '${sub}')), 0)::int as n`,
  );
  return Number(r[0].n);
}
