/**
 * Adversarial pass 3 (tester #2) for the `db-schema-migrations` subsystem —
 * live attacks against the FULL migration chain on a throwaway Postgres 16
 * (shim + every migration, exactly like supabase/tests/run_rls_tests.sh).
 *
 * Every Deno.test below is ONE assigned attack scenario. Each asserts the
 * INVARIANT the schema promises; a red test IS the reproduction of a break.
 * S6 is expected to be red at 4d812e1a (late-linked identity has no ledger
 * row) — see the finding in the pass report.
 *
 *   docker run -d --name pickle-attack-pg -p 55432:5432 -e POSTGRES_PASSWORD=pg postgres:16
 *   docker cp supabase/tests pickle-attack-pg:/tests && docker cp supabase/migrations pickle-attack-pg:/migrations
 *   docker exec pickle-attack-pg bash -c 'psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql \
 *     && for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done'
 *   PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55432/postgres \
 *   ATTACK_SEED=20260904 ATTACK_ARTIFACT_DIR=/tmp/attack \
 *     deno test -A --config supabase/functions/api/__wf__/deno.json \
 *       supabase/functions/api/__wf__/attack_db_schema_migrations_2.test.ts
 *
 * Without PICKLE_AUDIT_PG_URL every test is skipped (ignore: true), so the
 * default `deno task test` run is unaffected. Each scenario provisions its
 * own users (random UUIDs) and deletes them at the end, so the tests can be
 * re-run against the same database; the concurrency scenario uses real
 * separate connections (no single-transaction serialization tricks).
 */
import postgres from "postgres";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const PG_URL = Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const SEED = Number(Deno.env.get("ATTACK_SEED") ?? "20260904");
const ARTIFACT_DIR = Deno.env.get("ATTACK_ARTIFACT_DIR") ?? "";

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

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

// ─── seeded PRNG (mulberry32) — interleavings are reproducible from ATTACK_SEED
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── result journal → summary.json (artifact) ───────────────────────────────
const journal: Array<
  { scenario: string; verdict: "HELD" | "BROKEN"; detail: Row }
> = [];
async function record(
  scenario: string,
  verdict: "HELD" | "BROKEN",
  detail: Row,
) {
  journal.push({ scenario, verdict, detail });
  if (ARTIFACT_DIR) {
    await Deno.mkdir(ARTIFACT_DIR, { recursive: true });
    await Deno.writeTextFile(
      `${ARTIFACT_DIR}/summary.json`,
      JSON.stringify(
        { seed: SEED, generatedAt: new Date().toISOString(), results: journal },
        null,
        2,
      ),
    );
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID();
/** postgres.js rows are typed `Row & Iterable<Row>`; compare as plain objects. */
const plain = (row: unknown): Row => ({ ...(row as Row) });

function shotPayload(overrides: Row): Row {
  return {
    id: uuid(),
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
    ...overrides,
  };
}

/** Superuser: create auth.users (+ profile via trigger) and identities. */
async function provision(
  sql: Sql,
  userId: string,
  identities: Array<{ provider: string; providerId: string }>,
  email = `${userId}@example.com`,
) {
  await sql.unsafe(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
     values ($1, $2, '{"full_name":"Attack"}'::jsonb, '{"provider":"google"}'::jsonb)`,
    [userId, email],
  );
  for (const ident of identities) {
    await sql.unsafe(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ($1, $2, $3, jsonb_build_object('sub', $2::text, 'email', $4::text))`,
      [ident.provider, ident.providerId, userId, email],
    );
  }
}

async function dropUser(sql: Sql, userId: string) {
  await sql.unsafe(`delete from auth.users where id = $1`, [userId]);
}

/** Session-level (NOT transaction-local) user context on a dedicated
 * connection — needed when a scenario must span COMMITTED statements (S1
 * concurrency, S7 clock). */
async function becomeUser(conn: Sql, userId: string) {
  await conn.unsafe(`set role authenticated`);
  await conn.unsafe(`select set_config('request.jwt.claim.sub', $1, false)`, [
    userId,
  ]);
  await conn.unsafe(
    `select set_config('request.jwt.claim.role', 'authenticated', false)`,
  );
}

/** Transaction-local user context inside an already-open transaction. */
async function becomeUserLocal(tx: Sql, userId: string) {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [
    userId,
  ]);
  await tx.unsafe(
    `select set_config('request.jwt.claim.role', 'authenticated', true)`,
  );
}

async function reserve(
  conn: Sql,
  key: string,
): Promise<{ result: string; permit_id: string | null }> {
  const rows = await conn.unsafe(
    `select result, permit_id::text as permit_id from public.reserve_analysis_permit($1)`,
    [key],
  );
  return {
    result: String(rows[0].result),
    permit_id: rows[0].permit_id ? String(rows[0].permit_id) : null,
  };
}

async function apply(conn: Sql, shot: Row): Promise<string> {
  // text → jsonb: postgres.js would otherwise JSON-encode the string again.
  const rows = await conn.unsafe(
    `select public.apply_synced_shot($1::text::jsonb) as status`,
    [
      JSON.stringify(shot),
    ],
  );
  return String(rows[0].status);
}

async function accessState(conn: Sql) {
  const rows = await conn.unsafe(
    `select premium, scored_count, reserved_count from public.access_state()`,
  );
  return {
    premium: Boolean(rows[0].premium),
    scored: Number(rows[0].scored_count),
    reserved: Number(rows[0].reserved_count),
  };
}

async function lifetimeCount(conn: Sql): Promise<number> {
  const rows = await conn.unsafe(`select public.lifetime_scored_count() as n`);
  return Number(rows[0].n);
}
async function identityCount(conn: Sql): Promise<number> {
  const rows = await conn.unsafe(`select public.identity_scored_count() as n`);
  return Number(rows[0].n);
}

/** Superuser truth (bypasses RLS): scored shots + fresh reserved permits. */
async function truth(sql: Sql, userId: string) {
  const rows = await sql.unsafe(
    `select
       (select count(*)::int from public.shots where user_id = $1 and result_kind = 'scored') as scored,
       (select count(*)::int from public.analysis_permits
         where user_id = $1 and status = 'reserved' and created_at > now() - interval '24 hours') as reserved,
       (select count(*)::int from public.analysis_permits where user_id = $1) as permits_total`,
    [userId],
  );
  return {
    scored: Number(rows[0].scored),
    reserved: Number(rows[0].reserved),
    permitsTotal: Number(rows[0].permits_total),
  };
}

/** Spend one free rating as the user on a dedicated committed connection. */
async function spendScored(conn: Sql, key: string): Promise<string> {
  const r = await reserve(conn, key);
  if (r.result !== "accepted") return `reserve:${r.result}`;
  return await apply(conn, shotPayload({ analysisPermitId: r.permit_id }));
}

// ═════════════════════════════════════════════════════════════════════════════
// S1 — reserve('x') in session A vs apply_synced_shot(scored, permit 'y') in
//      session B, same user, scored=1. Invariant: scored + fresh-reserved ≤ 2
//      and scored ≤ 2 for a non-premium account, under every interleaving.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test({
  name:
    "S1 concurrency: reserve(A) ∥ apply_synced_shot(B) at scored=1 never exceeds 2 (both lock orders + seeded stress)",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const a = postgres(PG_URL, { max: 1 });
    const b = postgres(PG_URL, { max: 1 });
    const users: string[] = [];
    const detail: Row = { seed: SEED, orders: [] as Row[] };
    try {
      // ── deterministic interleavings: B holds the advisory lock in an open
      //    transaction while A's reserve blocks on it, and vice-versa.
      for (const order of ["B-first", "A-first"] as const) {
        const u = uuid();
        users.push(u);
        await provision(admin, u, [{
          provider: "google",
          providerId: `s1-${u}`,
        }]);
        await becomeUser(a, u);
        await becomeUser(b, u);
        // scored=1 via the RPC path, permit 'y' reserved and still fresh.
        assertEquals(await spendScored(a, "s1-k0"), "accepted");
        const y = await reserve(b, "s1-y");
        assertEquals(y.result, "accepted");
        assertEquals(await truth(admin, u), {
          scored: 1,
          reserved: 1,
          permitsTotal: 2,
        });

        let resA = "";
        let resB = "";
        if (order === "B-first") {
          // B: open tx, take lock via the sync (holds it until commit).
          await b.unsafe(`begin`);
          resB = await apply(b, shotPayload({ analysisPermitId: y.permit_id }));
          // A: reserve concurrently — must block on the advisory lock.
          const pA = reserve(a, "s1-x").then((r) => (resA = r.result));
          await new Promise((r) => setTimeout(r, 400));
          const blocked = await admin.unsafe(
            `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory'`,
          );
          detail.blockedOnAdvisory_Bfirst = Number(blocked[0].n);
          await b.unsafe(`commit`);
          await pA;
        } else {
          await a.unsafe(`begin`);
          const rA = await reserve(a, "s1-x");
          resA = rA.result;
          const pB = apply(b, shotPayload({ analysisPermitId: y.permit_id }))
            .then((r) => (resB = r));
          await new Promise((r) => setTimeout(r, 400));
          await a.unsafe(`commit`);
          await pB;
        }
        const t = await truth(admin, u);
        const st = await accessState(a);
        (detail.orders as Row[]).push({
          order,
          resA,
          resB,
          truth: t,
          access_state: st,
        });
        assertEquals(
          resB,
          "accepted",
          `${order}: the sync holding a fresh permit must be accepted`,
        );
        assertEquals(
          resA,
          "access.paywall_required",
          `${order}: reserve must be refused`,
        );
        assert(t.scored <= 2, `${order}: scored=${t.scored}`);
        assert(
          t.scored + t.reserved <= 2,
          `${order}: scored+reserved=${t.scored + t.reserved}`,
        );
        assertEquals(st.scored, 2);
        assertEquals(st.reserved, 0);
        // no permit for 'x' may exist at all (refused reserve issues nothing)
        const px = await admin.unsafe(
          `select count(*)::int as n from public.analysis_permits where user_id = $1 and idempotency_key = 's1-x'`,
          [u],
        );
        assertEquals(
          Number(px[0].n),
          0,
          `${order}: refused reserve must not leave a permit row`,
        );
        await a.unsafe(`reset role`);
        await b.unsafe(`reset role`);
      }

      // ── seeded stress: N users, each hammered by 6 parallel sessions doing
      //    random reserve/sync with random keys and payload ids; the DB truth
      //    must never show scored > 2 or scored + fresh reserved > 2.
      const rnd = mulberry32(SEED);
      const N_USERS = 6;
      const SESSIONS = 6;
      const OPS = 8;
      const pool = postgres(PG_URL, { max: SESSIONS });
      const violations: Row[] = [];
      try {
        for (let ui = 0; ui < N_USERS; ui++) {
          const u = uuid();
          users.push(u);
          await provision(admin, u, [{
            provider: "apple",
            providerId: `s1-stress-${u}`,
          }]);
          // seed state scored=1 (one committed rating) like the assignment.
          const seedConn = postgres(PG_URL, { max: 1 });
          await becomeUser(seedConn, u);
          assertEquals(await spendScored(seedConn, "stress-k0"), "accepted");
          await seedConn.end();

          const knownPermits: string[] = [];
          const workers = Array.from({ length: SESSIONS }, async (_, si) => {
            await pool.reserve().then(async (conn) => {
              try {
                await becomeUser(conn as unknown as Sql, u);
                for (let op = 0; op < OPS; op++) {
                  const roll = rnd();
                  const jitter = Math.floor(rnd() * 15);
                  await new Promise((r) => setTimeout(r, jitter));
                  if (roll < 0.5) {
                    const key = `stress-${si}-${Math.floor(rnd() * 4)}`;
                    const r = await reserve(conn as unknown as Sql, key);
                    if (r.result === "accepted" && r.permit_id) {
                      knownPermits.push(r.permit_id);
                    }
                  } else {
                    const pid = knownPermits.length
                      ? knownPermits[Math.floor(rnd() * knownPermits.length)]
                      : uuid();
                    await apply(
                      conn as unknown as Sql,
                      shotPayload({
                        analysisPermitId: pid,
                        resultKind: rnd() < 0.8 ? "scored" : "low_confidence",
                      }),
                    );
                  }
                  const t = await truth(admin, u);
                  if (t.scored > 2 || t.scored + t.reserved > 2) {
                    violations.push({ user: u, session: si, op, ...t });
                  }
                }
              } finally {
                await (conn as unknown as { release: () => void }).release();
              }
            });
          });
          await Promise.all(workers);
          const final = await truth(admin, u);
          if (final.scored > 2 || final.scored + final.reserved > 2) {
            violations.push({ user: u, final: true, ...final });
          }
        }
      } finally {
        await pool.end();
      }
      detail.stress = {
        users: N_USERS,
        sessions: SESSIONS,
        opsPerSession: OPS,
        violations,
      };
      assertEquals(
        violations,
        [],
        `free-limit invariant violated: ${JSON.stringify(violations)}`,
      );
      await record("S1 concurrency reserve∥sync", "HELD", detail);
    } catch (e) {
      await record("S1 concurrency reserve∥sync", "BROKEN", {
        ...detail,
        error: String(e),
      });
      throw e;
    } finally {
      for (const u of users) await dropUser(admin, u).catch(() => undefined);
      await a.end();
      await b.end();
      await admin.end();
    }
  },
});

// ═════════════════════════════════════════════════════════════════════════════
// S2 — delete + re-create with the SAME auth.users.id (Q12).
// ═════════════════════════════════════════════════════════════════════════════
Deno.test({
  name:
    "S2 same auth.users.id re-created: fresh profile, no player_rank_state, ledger floor via identity",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const user = postgres(PG_URL, { max: 1 });
    const u = uuid();
    const detail: Row = { user: u };
    try {
      await provision(
        admin,
        u,
        [{ provider: "google", providerId: `s2-${u}` }],
        "first@example.com",
      );
      await admin.unsafe(
        `update public.profiles set display_name = 'Old Life ☃ 名前', avatar_url = 'https://old/avatar.png' where id = $1`,
        [u],
      );
      await becomeUser(user, u);
      assertEquals(await spendScored(user, "s2-k1"), "accepted");
      assertEquals(await spendScored(user, "s2-k2"), "accepted");
      assertEquals(await lifetimeCount(user), 2);
      const rankBefore = await admin.unsafe(
        `select count(*)::int as n from public.player_rank_state where user_id = $1`,
        [u],
      );
      detail.rankRowsBeforeDelete = Number(rankBefore[0].n);
      assert(
        Number(rankBefore[0].n) >= 1,
        "precondition: rank state exists after scored shots",
      );
      // extra state that must not leak into the second life
      await admin.unsafe(
        `insert into public.billing_entitlements (user_id, premium) values ($1, true)`,
        [u],
      );
      await admin.unsafe(
        `insert into public.account_deletion_requests (user_id) values ($1)`,
        [u],
      );

      // ── delete (what Auth admin deleteUser does) and re-create SAME id
      await admin.unsafe(`delete from auth.users where id = $1`, [u]);
      const leftovers = await admin.unsafe(
        `select
           (select count(*) from public.profiles where id = $1)::int as profiles,
           (select count(*) from public.shots where user_id = $1)::int as shots,
           (select count(*) from public.analysis_permits where user_id = $1)::int as permits,
           (select count(*) from public.player_rank_state where user_id = $1)::int as rank_state,
           (select count(*) from public.billing_entitlements where user_id = $1)::int as billing,
           (select count(*) from public.account_deletion_requests where user_id = $1)::int as deletion_requests,
           (select count(*) from auth.identities where user_id = $1)::int as identities`,
        [u],
      );
      detail.afterDelete = leftovers[0];
      for (const [k, v] of Object.entries(leftovers[0])) {
        assertEquals(Number(v), 0, `cascade must remove ${k}`);
      }
      // same provider identity, same auth.users.id, different email/metadata
      await admin.unsafe(
        `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
         values ($1, 'second@example.com', '{"full_name":"Second Life"}'::jsonb, '{"provider":"apple"}'::jsonb)`,
        [u],
      );
      await admin.unsafe(
        `insert into auth.identities (provider, provider_id, user_id, identity_data)
         values ('google', $2, $1, jsonb_build_object('sub', $2::text, 'email', 'second@example.com'))`,
        [u, `s2-${u}`],
      );
      const prof = await admin.unsafe(
        `select email, display_name, avatar_url, provider from public.profiles where id = $1`,
        [u],
      );
      detail.profileSecondLife = prof[0];
      assertEquals(
        prof.length,
        1,
        "profile must be provisioned by handle_new_user",
      );
      assertEquals(prof[0].email, "second@example.com");
      assertEquals(prof[0].display_name, "Second Life");
      assertEquals(prof[0].avatar_url, null, "old avatar must not survive");
      assertEquals(prof[0].provider, "apple");
      const rank = await admin.unsafe(
        `select count(*)::int as n from public.player_rank_state where user_id = $1`,
        [u],
      );
      assertEquals(Number(rank[0].n), 0, "player_rank_state must be absent");
      const billing = await admin.unsafe(
        `select count(*)::int as n from public.billing_entitlements where user_id = $1`,
        [u],
      );
      assertEquals(
        Number(billing[0].n),
        0,
        "premium must not survive deletion",
      );

      // ── ledger floor still applies via identity for the same uuid
      await user.unsafe(`reset role`);
      await becomeUser(user, u);
      const st = await accessState(user);
      detail.accessStateSecondLife = st;
      assertEquals(st, { premium: false, scored: 2, reserved: 0 });
      assertEquals(await identityCount(user), 2);
      assertEquals(await lifetimeCount(user), 2);
      const r = await reserve(user, "s2-second-life");
      assertEquals(
        r.result,
        "access.paywall_required",
        "reserve must refuse the re-created account",
      );
      // forged permit → sync backstop
      const forged = uuid();
      await admin.unsafe(
        `insert into public.analysis_permits (id, user_id, idempotency_key) values ($1, $2, 's2-forged')`,
        [forged, u],
      );
      const v = await apply(user, shotPayload({ analysisPermitId: forged }));
      assertEquals(v, "access.paywall_required");
      const forgedRow = await admin.unsafe(
        `select status, outcome from public.analysis_permits where id = $1`,
        [forged],
      );
      assertEquals(plain(forgedRow[0]), {
        status: "released",
        outcome: "free_limit_exceeded",
      });
      const t = await truth(admin, u);
      assertEquals(t.scored, 0, "no scored shot may land in the second life");
      // rank view is empty too (no evidence) — and view is not writable (see S3)
      const rating = await user.unsafe(
        `select count(*)::int as n from public.player_technique_rating`,
      );
      assertEquals(Number(rating[0].n), 0);
      await record("S2 same-id re-create", "HELD", detail);
    } catch (e) {
      await record("S2 same-id re-create", "BROKEN", {
        ...detail,
        error: String(e),
      });
      throw e;
    } finally {
      await user.end();
      await dropUser(admin, u).catch(() => undefined);
      await admin.end();
    }
  },
});

// ═════════════════════════════════════════════════════════════════════════════
// S3 — writes through the security_invoker views as authenticated.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test({
  name:
    "S3 view writes: INSERT progress_daily / UPDATE|DELETE player_technique_rating refused, shots untouched",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const u = uuid();
    const detail: Row = { user: u, attempts: [] as Row[] };
    try {
      await provision(admin, u, [{
        provider: "google",
        providerId: `s3-${u}`,
      }]);
      const conn = postgres(PG_URL, { max: 1 });
      await becomeUser(conn, u);
      assertEquals(await spendScored(conn, "s3-k1"), "accepted");
      await conn.end();
      const before = await admin.unsafe(
        `select md5(string_agg(s::text, ',' order by id)) as h, count(*)::int as n from public.shots s where user_id = $1`,
        [u],
      );

      const attempts: Array<
        { label: string; sql: string; params?: unknown[] }
      > = [
        {
          label: "INSERT progress_daily",
          sql:
            `insert into public.progress_daily (user_id, day, shot_type, scoring_model_version, shot_count, avg_score, best_score)
                values ($1, current_date, 'dink', 'scoring-1', 99, 9.99, 10)`,
          params: [u],
        },
        {
          label: "UPDATE player_technique_rating",
          sql:
            `update public.player_technique_rating set score = 10 where user_id = $1`,
          params: [u],
        },
        {
          label: "DELETE player_technique_rating",
          sql: `delete from public.player_technique_rating where user_id = $1`,
          params: [u],
        },
        {
          label: "UPDATE progress_daily",
          sql:
            `update public.progress_daily set shot_count = 0 where user_id = $1`,
          params: [u],
        },
        {
          label: "INSERT practice_days",
          sql:
            `insert into public.practice_days (user_id, day) values ($1, current_date)`,
          params: [u],
        },
        {
          label: "INSERT player_technique_rating (huge unicode shot_type)",
          sql:
            `insert into public.player_technique_rating (user_id, shot_type, score, captured_at, sampled_count, confidence_weight)
                values ($1, repeat('☃', 20000), 10, now(), 8, 5)`,
          params: [u],
        },
        {
          label: "COPY-style multi-row INSERT progress_daily via select",
          sql:
            `insert into public.progress_daily select user_id, day, shot_type, scoring_model_version, shot_count + 1, avg_score, best_score from public.progress_daily where user_id = $1`,
          params: [u],
        },
        {
          label: "TRUNCATE player_technique_rating",
          sql: `truncate public.player_technique_rating`,
        },
      ];
      for (const at of attempts) {
        const c = postgres(PG_URL, { max: 1 });
        try {
          await c.unsafe(`begin`);
          await becomeUserLocal(c, u);
          let outcome: Row;
          try {
            await c.unsafe(at.sql, (at.params ?? []) as never);
            outcome = { label: at.label, refused: false };
          } catch (e) {
            const err = e as { code?: string; message?: string };
            outcome = {
              label: at.label,
              refused: true,
              sqlstate: err.code,
              message: err.message,
            };
          }
          (detail.attempts as Row[]).push(outcome);
          assert(
            outcome.refused === true,
            `${at.label} must be refused (it succeeded)`,
          );
          const code = String(outcome.sqlstate);
          // 55000 object_not_in_prerequisite_state = "cannot insert/update/delete from view"
          // 42501 insufficient_privilege, 42809 wrong_object_type (TRUNCATE on view)
          assert(
            ["55000", "42501", "42809"].includes(code),
            `${at.label}: unexpected error class ${code}: ${outcome.message}`,
          );
        } finally {
          await c.unsafe(`rollback`).catch(() => undefined);
          await c.end();
        }
      }
      const insertOutcome = (detail.attempts as Row[])[0];
      assertStringIncludes(
        String(insertOutcome.message),
        "cannot insert into view",
      );
      const updateOutcome = (detail.attempts as Row[])[1];
      assertStringIncludes(String(updateOutcome.message), "cannot update view");

      const after = await admin.unsafe(
        `select md5(string_agg(s::text, ',' order by id)) as h, count(*)::int as n from public.shots s where user_id = $1`,
        [u],
      );
      assertEquals(
        after[0],
        before[0],
        "shots must be byte-identical after every refused view write",
      );

      // privilege hygiene: does authenticated even hold INSERT/UPDATE/DELETE on the views?
      const grants = await admin.unsafe(
        `select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
           from information_schema.role_table_grants
          where grantee = 'authenticated' and table_schema = 'public'
            and table_name in ('progress_daily', 'player_technique_rating', 'practice_days')
          group by table_name order by table_name`,
      );
      detail.viewGrantsForAuthenticated = grants;
      await record("S3 view writes", "HELD", detail);
    } catch (e) {
      await record("S3 view writes", "BROKEN", { ...detail, error: String(e) });
      throw e;
    } finally {
      await dropUser(admin, u).catch(() => undefined);
      await admin.end();
    }
  },
});

// ═════════════════════════════════════════════════════════════════════════════
// S4 — Bob owns shot id X; Alice syncs X with her own permit.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test({
  name:
    "S4 cross-user shot id: Alice's sync of Bob's id → shot.id_conflict, Alice's permit stays reserved, Bob's row untouched",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const alice = uuid();
    const bob = uuid();
    const detail: Row = { alice, bob };
    const cA = postgres(PG_URL, { max: 1 });
    const cB = postgres(PG_URL, { max: 1 });
    try {
      await provision(admin, alice, [{
        provider: "google",
        providerId: `s4-a-${alice}`,
      }]);
      await provision(admin, bob, [{
        provider: "apple",
        providerId: `s4-b-${bob}`,
      }]);
      await becomeUser(cA, alice);
      await becomeUser(cB, bob);
      // Bob: one scored shot with id X through the real RPC path.
      const rB = await reserve(cB, "s4-bob");
      assertEquals(rB.result, "accepted");
      const X = uuid();
      assertEquals(
        await apply(
          cB,
          shotPayload({
            id: X,
            analysisPermitId: rB.permit_id,
            overallScore: 3.3,
          }),
        ),
        "accepted",
      );
      const bobRowBefore = await admin.unsafe(
        `select s::text as r from public.shots s where id = $1`,
        [X],
      );

      // Alice: reserve, then sync the SAME id with her permit.
      const rA = await reserve(cA, "s4-alice");
      assertEquals(rA.result, "accepted");
      const v = await apply(
        cA,
        shotPayload({
          id: X,
          analysisPermitId: rA.permit_id,
          overallScore: 9.9,
        }),
      );
      detail.aliceSyncResult = v;
      assertEquals(v, "shot.id_conflict");
      const permit = await admin.unsafe(
        `select status, outcome from public.analysis_permits where id = $1`,
        [rA.permit_id],
      );
      detail.alicePermit = permit[0];
      assertEquals(
        plain(permit[0]),
        { status: "reserved", outcome: null },
        "Alice's permit must stay reserved",
      );
      const bobRowAfter = await admin.unsafe(
        `select s::text as r from public.shots s where id = $1`,
        [X],
      );
      assertEquals(
        bobRowAfter[0].r,
        bobRowBefore[0].r,
        "Bob's row must be byte-identical",
      );
      const visible = await cA.unsafe(
        `select count(*)::int as n from public.shots where id = $1`,
        [X],
      );
      assertEquals(Number(visible[0].n), 0, "Alice must not see Bob's row");
      // Alice's counters unaffected: she still has both ratings (0 scored, 1 reserved)
      assertEquals(await accessState(cA), {
        premium: false,
        scored: 0,
        reserved: 1,
      });
      // ledger unaffected for Alice; Bob's ledger is 1
      assertEquals(await identityCount(cA), 0);
      assertEquals(await identityCount(cB), 1);

      // Rapid repeats: 20 replays of the conflicting sync never flip anything.
      for (let i = 0; i < 20; i++) {
        assertEquals(
          await apply(
            cA,
            shotPayload({ id: X, analysisPermitId: rA.permit_id }),
          ),
          "shot.id_conflict",
        );
      }
      const permit2 = await admin.unsafe(
        `select status, outcome from public.analysis_permits where id = $1`,
        [rA.permit_id],
      );
      assertEquals(plain(permit2[0]), { status: "reserved", outcome: null });

      // Alice can still spend the permit on her own id afterwards.
      const own = await apply(
        cA,
        shotPayload({ analysisPermitId: rA.permit_id }),
      );
      assertEquals(own, "accepted");
      assertEquals(await accessState(cA), {
        premium: false,
        scored: 1,
        reserved: 0,
      });

      // Variant: Alice uses Bob's permit id → not found (RLS hides it).
      const stolen = await apply(
        cA,
        shotPayload({ analysisPermitId: rB.permit_id }),
      );
      detail.aliceUsesBobsPermit = stolen;
      assertEquals(stolen, "access.permit_not_found");
      // Variant: Alice's sync of Bob's id carrying a session Bob does not own
      // and phases — still a pure conflict, nothing of hers lands on X.
      const withDetails = await apply(
        cA,
        shotPayload({
          id: X,
          analysisPermitId: uuid(),
          phases: [{
            key: "contact",
            startMs: 0,
            representativeMs: 1,
            endMs: 2,
            confidence: 0.9,
          }],
        }),
      );
      assertEquals(withDetails, "access.permit_not_found");
      const xPhases = await admin.unsafe(
        `select count(*)::int as n from public.shot_phases where shot_id = $1`,
        [X],
      );
      assertEquals(Number(xPhases[0].n), 0);
      await record("S4 cross-user id conflict", "HELD", detail);
    } catch (e) {
      await record("S4 cross-user id conflict", "BROKEN", {
        ...detail,
        error: String(e),
      });
      throw e;
    } finally {
      await cA.end();
      await cB.end();
      await dropUser(admin, alice).catch(() => undefined);
      await dropUser(admin, bob).catch(() => undefined);
      await admin.end();
    }
  },
});

// ═════════════════════════════════════════════════════════════════════════════
// S5 (DB half) — expired deletion request rows: owner-readable until the
//      pg_cron purge predicate (expires_at < now() - 1 day) collects them.
//      The edge half (403 account.deletion_challenge_expired) lives in
//      attack_db_schema_migrations_2_edge.test.ts, which reads THIS table
//      under RLS through the fake PostgREST.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test({
  name:
    "S5 deletion requests: expired rows stay owner-readable; cron predicate purges only >1-day-expired rows",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const u = uuid();
    const other = uuid();
    const detail: Row = { user: u };
    try {
      await provision(admin, u, [{
        provider: "google",
        providerId: `s5-${u}`,
      }]);
      await provision(admin, other, [{
        provider: "google",
        providerId: `s5-o-${other}`,
      }]);
      // hosted-shape: pg_cron may be absent locally; the migration guards it.
      const cron = await admin.unsafe(
        `select count(*)::int as n from pg_extension where extname = 'pg_cron'`,
      );
      detail.pgCronInstalled = Number(cron[0].n) === 1;
      const jobs = detail.pgCronInstalled
        ? await admin.unsafe(
          `select jobname, schedule, command from cron.job order by jobname`,
        )
        : [];
      detail.cronJobs = jobs;

      // Row expired 2 days ago (inserted as the owner → RLS insert path).
      const c = postgres(PG_URL, { max: 1 });
      await becomeUser(c, u);
      const challenge = uuid();
      await c.unsafe(
        `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
         values ($1, $2, now() - interval '2 days 15 minutes', now() - interval '2 days')`,
        [u, challenge],
      );
      const mine = await c.unsafe(
        `select challenge, created_at, expires_at from public.account_deletion_requests where user_id = $1`,
        [u],
      );
      assertEquals(
        mine.length,
        1,
        "2-day-old expired row must still be owner-readable before the purge",
      );
      assertEquals(String(mine[0].challenge), challenge);
      // cross-user + anon: invisible
      const cO = postgres(PG_URL, { max: 1 });
      await becomeUser(cO, other);
      const theirs = await cO.unsafe(
        `select count(*)::int as n from public.account_deletion_requests where user_id = $1`,
        [u],
      );
      assertEquals(Number(theirs[0].n), 0);
      await cO.end();
      let anonErr = "";
      try {
        await c.unsafe(`reset role`);
        await c.unsafe(`set role anon`);
        await c.unsafe(`select count(*) from public.account_deletion_requests`);
      } catch (e) {
        anonErr = String((e as { code?: string }).code);
      }
      detail.anonSelectSqlstate = anonErr;
      assertEquals(anonErr, "42501");
      await c.end();

      // Purge predicate exactly as scheduled in 20260831000000_scale_and_security.sql
      const PURGE =
        `delete from public.account_deletion_requests where expires_at < now() - interval '1 day'`;
      if (detail.pgCronInstalled) {
        const j = (jobs as Row[]).find((r) =>
          r.jobname === "purge-expired-deletion-requests"
        );
        assert(j, "purge job must be scheduled");
        assertEquals(String(j!.command).replace(/\s+/g, " ").trim(), PURGE);
      }
      // a row expired 12h ago must SURVIVE the purge (still within the 1-day grace)
      await admin.unsafe(
        `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
         values ($1, $2, now() - interval '12 hours 15 minutes', now() - interval '12 hours')`,
        [other, uuid()],
      );
      const purged = await admin.unsafe(
        `with d as (${PURGE} returning user_id) select count(*)::int as n from d`,
      );
      detail.purgedRows = Number(purged[0].n);
      const remain = await admin.unsafe(
        `select user_id::text as user_id from public.account_deletion_requests where user_id in ($1, $2) order by 1`,
        [u, other],
      );
      detail.remainingAfterPurge = remain.map((r) => r.user_id);
      assertEquals(Number(purged[0].n) >= 1, true);
      assertEquals(
        remain.map((r) => r.user_id),
        [other],
        "12h-expired row must survive, 2-day row must go",
      );
      await record("S5 deletion request retention (DB half)", "HELD", detail);
    } catch (e) {
      await record("S5 deletion request retention (DB half)", "BROKEN", {
        ...detail,
        error: String(e),
      });
      throw e;
    } finally {
      await dropUser(admin, u).catch(() => undefined);
      await dropUser(admin, other).catch(() => undefined);
      await admin.end();
    }
  },
});

// ═════════════════════════════════════════════════════════════════════════════
// S6 — second identity linked AFTER both ratings were spent; delete; re-create
//      with ONLY the new identity. Invariant: identity_scored_count() = 2.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test({
  name:
    "S6 late-linked identity carries the ledger: re-created account with only the new identity reports identity_scored_count()=2",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const u1 = uuid();
    const u2 = uuid();
    const googleSub = `s6-google-${u1}`;
    const appleSub = `s6-apple-${u1}`;
    const detail: Row = { firstLife: u1, secondLife: u2, googleSub, appleSub };
    const c1 = postgres(PG_URL, { max: 1 });
    const c2 = postgres(PG_URL, { max: 1 });
    try {
      await provision(admin, u1, [{
        provider: "google",
        providerId: googleSub,
      }]);
      await becomeUser(c1, u1);
      assertEquals(await spendScored(c1, "s6-k1"), "accepted");
      assertEquals(await spendScored(c1, "s6-k2"), "accepted");
      assertEquals(
        await reserve(c1, "s6-k3").then((r) => r.result),
        "access.paywall_required",
      );
      // link Apple AFTER both ratings (Supabase auto-links same verified email)
      await admin.unsafe(
        `insert into auth.identities (provider, provider_id, user_id, identity_data)
         values ('apple', $1, $2, jsonb_build_object('sub', $1::text, 'email', $3::text))`,
        [appleSub, u1, `${u1}@example.com`],
      );
      const ledger = await admin.unsafe(
        `select (select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', $1)) as google,
                (select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', $2)) as apple`,
        [googleSub, appleSub],
      );
      detail.ledgerAfterLink = ledger[0];
      // still refused while both identities are attached (max over identities)
      assertEquals(await identityCount(c1), 2);
      assertEquals(
        await reserve(c1, "s6-k4").then((r) => r.result),
        "access.paywall_required",
      );

      // delete; re-create with ONLY the apple identity (new auth.users row)
      await admin.unsafe(`delete from auth.users where id = $1`, [u1]);
      await provision(admin, u2, [{ provider: "apple", providerId: appleSub }]);
      await becomeUser(c2, u2);
      const idc = await identityCount(c2);
      const st = await accessState(c2);
      detail.secondLife_identity_scored_count = idc;
      detail.secondLife_access_state = st;
      // Probe how far the attacker gets (recorded regardless of the assertion).
      const r1 = await spendScored(c2, "s6-second-1");
      const r2 = await spendScored(c2, "s6-second-2");
      const r3 = await reserve(c2, "s6-second-3").then((r) => r.result);
      detail.secondLife_spend = [r1, r2, r3];
      detail.secondLife_truth = await truth(admin, u2);
      const ledger2 = await admin.unsafe(
        `select (select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', $1)) as google,
                (select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', $2)) as apple`,
        [googleSub, appleSub],
      );
      detail.ledgerAfterSecondLife = ledger2[0];
      const broken = idc !== 2 || st.scored !== 2 || r1 === "accepted";
      await record(
        "S6 late-linked identity ledger",
        broken ? "BROKEN" : "HELD",
        detail,
      );
      assertEquals(
        idc,
        2,
        "identity_scored_count() must report the spent ratings via the late-linked identity",
      );
      assertEquals(st.scored, 2);
      assertEquals(
        r1,
        "reserve:access.paywall_required",
        "no third free rating via the late-linked identity",
      );
    } finally {
      await c1.end();
      await c2.end();
      await dropUser(admin, u1).catch(() => undefined);
      await dropUser(admin, u2).catch(() => undefined);
      await admin.end();
    }
  },
});

// ═════════════════════════════════════════════════════════════════════════════
// S7 — premium lapses between reserve (t0) and sync (t0+2s); count already 2.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test({
  name:
    "S7 premium lapse: entitlement expires_at=now()+1s → reserve accepted at t0, scored sync at t0+2s refused (free_limit_exceeded)",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const u = uuid();
    const c = postgres(PG_URL, { max: 1 });
    const detail: Row = { user: u };
    try {
      await provision(admin, u, [{
        provider: "google",
        providerId: `s7-${u}`,
      }]);
      await becomeUser(c, u);
      // Spend both free ratings first (lifetime_scored_count() = 2).
      assertEquals(await spendScored(c, "s7-k1"), "accepted");
      assertEquals(await spendScored(c, "s7-k2"), "accepted");
      assertEquals(await lifetimeCount(c), 2);
      assertEquals(
        await reserve(c, "s7-k3-free").then((r) => r.result),
        "access.paywall_required",
      );
      // Premium for ~1s (server-verified row, written by service role).
      await admin.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
         values ($1, true, 'pickle_sensei_pro_monthly', clock_timestamp() + interval '1 second')`,
        [u],
      );
      const t0 = Date.now();
      const st0 = await accessState(c);
      detail.accessStateAtT0 = st0;
      assertEquals(st0.premium, true);
      const r = await reserve(c, "s7-premium-window");
      detail.reserveAtT0 = r.result;
      assertEquals(r.result, "accepted", "premium at t0 must reserve");
      // Let the entitlement lapse (separate transactions → now() advances).
      await new Promise((res) => setTimeout(res, 2100));
      const nowRow = await admin.unsafe(
        `select (expires_at < now()) as lapsed from public.billing_entitlements where user_id = $1`,
        [u],
      );
      assertEquals(
        Boolean(nowRow[0].lapsed),
        true,
        "precondition: entitlement lapsed",
      );
      const st1 = await accessState(c);
      detail.accessStateAtT2 = st1;
      assertEquals(st1.premium, false, "access_state must re-read premium");
      const v = await apply(c, shotPayload({ analysisPermitId: r.permit_id }));
      detail.syncAtT2 = v;
      detail.elapsedMs = Date.now() - t0;
      assertEquals(
        v,
        "access.paywall_required",
        "backstop must refuse: premium re-read at sync time",
      );
      const p = await admin.unsafe(
        `select status, outcome from public.analysis_permits where id = $1`,
        [r.permit_id],
      );
      detail.permitAfterSync = p[0];
      assertEquals(plain(p[0]), {
        status: "released",
        outcome: "free_limit_exceeded",
      });
      assertEquals((await truth(admin, u)).scored, 2, "no third scored shot");

      // Clock-skew flavour: the client's capturedAt claims it was scored inside
      // the premium window → still refused (server clock is authoritative).
      const forged = uuid();
      await admin.unsafe(
        `insert into public.analysis_permits (id, user_id, idempotency_key) values ($1, $2, 's7-forged')`,
        [forged, u],
      );
      const v2 = await apply(
        c,
        shotPayload({
          analysisPermitId: forged,
          capturedAt: new Date(t0).toISOString(),
        }),
      );
      detail.syncWithBackdatedCapturedAt = v2;
      assertEquals(v2, "access.paywall_required");
      // Abstention (unscored) with a lapsed premium is still free and releases the permit.
      const forged2 = uuid();
      await admin.unsafe(
        `insert into public.analysis_permits (id, user_id, idempotency_key) values ($1, $2, 's7-forged-2')`,
        [forged2, u],
      );
      const v3 = await apply(
        c,
        shotPayload({
          analysisPermitId: forged2,
          resultKind: "low_confidence",
          overallScore: null,
        }),
      );
      assertEquals(v3, "accepted");
      const p3 = await admin.unsafe(
        `select status, outcome from public.analysis_permits where id = $1`,
        [forged2],
      );
      assertEquals(plain(p3[0]), {
        status: "released",
        outcome: "low_confidence",
      });
      // Premium renewed (expires_at NULL = lifetime) → sync of a fresh permit passes.
      await admin.unsafe(
        `update public.billing_entitlements set expires_at = null where user_id = $1`,
        [u],
      );
      const r4 = await reserve(c, "s7-lifetime");
      assertEquals(r4.result, "accepted");
      assertEquals(
        await apply(c, shotPayload({ analysisPermitId: r4.permit_id })),
        "accepted",
      );
      assertEquals((await truth(admin, u)).scored, 3);
      await record("S7 premium lapse backstop", "HELD", detail);
    } catch (e) {
      await record("S7 premium lapse backstop", "BROKEN", {
        ...detail,
        error: String(e),
      });
      throw e;
    } finally {
      await c.end();
      await dropUser(admin, u).catch(() => undefined);
      await admin.end();
    }
  },
});

// ═════════════════════════════════════════════════════════════════════════════
// X1 (extra) — the free-limit under a NON-default isolation level. PostgREST
//      runs READ COMMITTED; this probes whether the advisory-lock scheme
//      depends on that (a REPEATABLE READ session keeps its first snapshot,
//      so a count taken after the lock could be stale).
// ═════════════════════════════════════════════════════════════════════════════
Deno.test({
  name:
    "X1 isolation: REPEATABLE READ sessions racing reserve/sync still cannot exceed 2 scored",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const a = postgres(PG_URL, { max: 1 });
    const b = postgres(PG_URL, { max: 1 });
    const u = uuid();
    const detail: Row = { user: u };
    try {
      await provision(admin, u, [{
        provider: "google",
        providerId: `x1-${u}`,
      }]);
      await becomeUser(a, u);
      await becomeUser(b, u);
      // scored=1 and TWO fresh reserved permits (over-issue artifact: forged directly).
      assertEquals(await spendScored(a, "x1-k0"), "accepted");
      const pA = uuid();
      const pB = uuid();
      await admin.unsafe(
        `insert into public.analysis_permits (id, user_id, idempotency_key) values ($1, $3, 'x1-a'), ($2, $3, 'x1-b')`,
        [pA, pB, u],
      );
      // Both sessions start REPEATABLE READ transactions and take a snapshot
      // BEFORE either sync, then race.
      await a.unsafe(`begin isolation level repeatable read`);
      await b.unsafe(`begin isolation level repeatable read`);
      await a.unsafe(`select 1`);
      await b.unsafe(`select 1`);
      const resA = apply(a, shotPayload({ analysisPermitId: pA }));
      await new Promise((r) => setTimeout(r, 200));
      const resB = apply(b, shotPayload({ analysisPermitId: pB }));
      const rA = await resA;
      await a.unsafe(`commit`);
      const rB = await resB;
      await b.unsafe(`commit`).catch(() => undefined);
      const t = await truth(admin, u);
      detail.results = { rA, rB, truth: t };
      const broken = t.scored > 2;
      await record(
        "X1 repeatable-read race",
        broken ? "BROKEN" : "HELD",
        detail,
      );
      assert(
        t.scored <= 2,
        `scored=${t.scored} under REPEATABLE READ race (${rA}, ${rB})`,
      );
    } finally {
      await a.end();
      await b.end();
      await dropUser(admin, u).catch(() => undefined);
      await admin.end();
    }
  },
});

// ═════════════════════════════════════════════════════════════════════════════
// X2 (extra) — corrupt / hostile payloads into apply_synced_shot: huge
//      strings, unicode, wrong types, NULL ids, oversized phases. The RPC must
//      refuse or bounce with a coded result, never leave a half-written shot
//      or a consumed permit.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test({
  name:
    "X2 hostile payloads: apply_synced_shot never half-writes or consumes the permit on a refused payload",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const u = uuid();
    const c = postgres(PG_URL, { max: 1 });
    const detail: Row = { user: u, cases: [] as Row[] };
    try {
      await provision(admin, u, [{
        provider: "google",
        providerId: `x2-${u}`,
      }]);
      await becomeUser(c, u);
      const r = await reserve(c, "x2-permit");
      assertEquals(r.result, "accepted");
      const cases: Array<{ label: string; shot: Row }> = [
        {
          label: "shot_type 100k unicode",
          shot: shotPayload({
            analysisPermitId: r.permit_id,
            shotType: "☃".repeat(100_000),
          }),
        },
        {
          label: "overallScore 1e6 (numeric(4,2) overflow)",
          shot: shotPayload({
            analysisPermitId: r.permit_id,
            overallScore: 1_000_000,
          }),
        },
        {
          label: "confidence as string 'high'",
          shot: shotPayload({
            analysisPermitId: r.permit_id,
            confidence: "high",
          }),
        },
        {
          label: "capturedAt garbage",
          shot: shotPayload({
            analysisPermitId: r.permit_id,
            capturedAt: "yesterday-ish",
          }),
        },
        {
          label: "sessionId of another (non-existent) session",
          shot: shotPayload({
            analysisPermitId: r.permit_id,
            sessionId: uuid(),
          }),
        },
        {
          label: "resultKind 'premium'",
          shot: shotPayload({
            analysisPermitId: r.permit_id,
            resultKind: "premium",
          }),
        },
        {
          label: "version vector missing",
          shot: shotPayload({
            analysisPermitId: r.permit_id,
            versionVector: null,
          }),
        },
        {
          label: "id not a uuid",
          shot: shotPayload({
            id: "not-a-uuid",
            analysisPermitId: r.permit_id,
          }),
        },
        // last: may legitimately be accepted (no per-shot phase cap is promised) — consumes the permit
        {
          label: "phases 5k entries",
          shot: shotPayload({
            analysisPermitId: r.permit_id,
            phases: Array.from(
              { length: 5000 },
              (_, i) => ({
                key: `p${i}`,
                startMs: 0,
                representativeMs: 1,
                endMs: 2,
                confidence: 0.5,
              }),
            ),
          }),
        },
      ];
      for (const cs of cases) {
        let result: string;
        let sqlstate: string | undefined;
        try {
          result = await apply(c, cs.shot);
        } catch (e) {
          result = "EXCEPTION";
          sqlstate = String((e as { code?: string }).code);
        }
        const t = await truth(admin, u);
        const permit = await admin.unsafe(
          `select status, outcome from public.analysis_permits where id = $1`,
          [r.permit_id],
        );
        const shotRow = await admin.unsafe(
          `select count(*)::int as n from public.shots where id::text = $1`,
          [String(cs.shot.id)],
        );
        const phases = await admin.unsafe(
          `select count(*)::int as n from public.shot_phases where shot_id::text = $1`,
          [String(cs.shot.id)],
        );
        const outcome = {
          label: cs.label,
          result,
          sqlstate,
          truth: t,
          permit: permit[0],
          shotRows: Number(shotRow[0].n),
          phaseRows: Number(phases[0].n),
        };
        (detail.cases as Row[]).push(outcome);
        if (result === "accepted") {
          // accepted is fine ONLY when the write is complete and the permit finalized
          assertEquals(
            Number(shotRow[0].n),
            1,
            `${cs.label}: accepted must have written the shot`,
          );
          assertEquals(
            permit[0].status,
            "finalized",
            `${cs.label}: accepted must finalize`,
          );
          break; // permit consumed; remaining cases are moot
        }
        assertEquals(
          Number(shotRow[0].n),
          0,
          `${cs.label}: refused payload must leave no shot row`,
        );
        assertEquals(
          Number(phases[0].n),
          0,
          `${cs.label}: refused payload must leave no phase rows`,
        );
        assertEquals(
          plain(permit[0]),
          { status: "reserved", outcome: null },
          `${cs.label}: permit must stay reserved`,
        );
        assertEquals(t.scored, 0);
      }
      await record("X2 hostile payloads", "HELD", detail);
    } catch (e) {
      await record("X2 hostile payloads", "BROKEN", {
        ...detail,
        error: String(e),
      });
      throw e;
    } finally {
      await c.end();
      await dropUser(admin, u).catch(() => undefined);
      await admin.end();
    }
  },
});

// ═════════════════════════════════════════════════════════════════════════════
// X3 (extra) — direct client INSERT of a 'scored' shot as authenticated (the
//      grant apply_synced_shot needs as SECURITY INVOKER) — characterizes
//      whether the free limit / permit system can be side-stepped by a client
//      that talks PostgREST directly with its access token.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test({
  name:
    "X3 direct INSERT into public.shots as authenticated (permit-less scored shot) — characterization",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const u = uuid();
    const c = postgres(PG_URL, { max: 1 });
    const detail: Row = { user: u };
    try {
      await provision(admin, u, [{
        provider: "google",
        providerId: `x3-${u}`,
      }]);
      await becomeUser(c, u);
      assertEquals(await spendScored(c, "x3-k1"), "accepted");
      assertEquals(await spendScored(c, "x3-k2"), "accepted");
      assertEquals(
        await reserve(c, "x3-k3").then((r) => r.result),
        "access.paywall_required",
      );
      let direct: Row;
      try {
        await c.unsafe(
          `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
             overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
             paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
           values (gen_random_uuid(), $1, 'dink', 'side', now(), 0, 100, 200, 9.5, 0.9, 'scored',
             '1.0.0','b','p','pa','s','ph','sc','c','real')`,
          [u],
        );
        direct = { inserted: true };
      } catch (e) {
        direct = {
          inserted: false,
          sqlstate: String((e as { code?: string }).code),
          message: String((e as Error).message),
        };
      }
      detail.directScoredInsert = direct;
      detail.truthAfter = await truth(admin, u);
      detail.lifetimeAfter = await lifetimeCount(c);
      detail.identityAfter = await identityCount(c);
      // characterization only: recorded, not asserted (design: invoker RPC needs the INSERT grant)
      await record(
        "X3 direct scored insert (characterization)",
        "HELD",
        detail,
      );
    } finally {
      await c.end();
      await dropUser(admin, u).catch(() => undefined);
      await admin.end();
    }
  },
});

// ═════════════════════════════════════════════════════════════════════════════
// X4 (extra) — detail tables reference public.shots by FK; the FK check runs
//      as the table owner and is NOT filtered by the parent's RLS. Invariant
//      claimed at 20260829120000_progress_data.sql:260-263: "a user can only
//      attach details to their own shot (the FK plus shots RLS closes the
//      loop)". Attack: Alice INSERTs shot_phases/measurements/checkpoints
//      rows with shot_id = Bob's shot and user_id = Alice.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test({
  name:
    "X4 detail rows cannot be attached to another user's shot (shot_phases / shot_measurements / shot_checkpoints)",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const alice = uuid();
    const bob = uuid();
    const cA = postgres(PG_URL, { max: 1 });
    const cB = postgres(PG_URL, { max: 1 });
    const detail: Row = { alice, bob, attempts: [] as Row[] };
    try {
      await provision(admin, alice, [{
        provider: "google",
        providerId: `x4-a-${alice}`,
      }]);
      await provision(admin, bob, [{
        provider: "apple",
        providerId: `x4-b-${bob}`,
      }]);
      await becomeUser(cA, alice);
      await becomeUser(cB, bob);
      const rB = await reserve(cB, "x4-bob");
      const X = uuid();
      assertEquals(
        await apply(
          cB,
          shotPayload({
            id: X,
            analysisPermitId: rB.permit_id,
            phases: [{
              key: "contact",
              startMs: 0,
              representativeMs: 1,
              endMs: 2,
              confidence: 0.9,
            }],
          }),
        ),
        "accepted",
      );
      const attempts: Array<{ label: string; sql: string; params: unknown[] }> =
        [
          {
            label: "shot_phases",
            sql:
              `insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
                values ($1, $2, 'planted-by-alice', 0, 1, 2, 0.5)`,
            params: [X, alice],
          },
          {
            label: "shot_measurements",
            sql:
              `insert into public.shot_measurements (shot_id, user_id, metric_key, value, unit, confidence)
                values ($1, $2, 'planted', 1.0, 'ms', 0.5)`,
            params: [X, alice],
          },
          {
            label: "shot_checkpoints",
            sql:
              `insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
                values ($1, $2, 'planted', 1.0, 0.5, 'green', 'up', 0.1, true)`,
            params: [X, alice],
          },
          {
            label:
              "shot_phases (pre-empt Bob's own key 'contact' → unique violation reveals it exists)",
            sql:
              `insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
                values ($1, $2, 'contact', 0, 1, 2, 0.5)`,
            params: [X, alice],
          },
          {
            label:
              "shot_phases (non-existent shot id → FK error = existence oracle)",
            sql:
              `insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
                values ($1, $2, 'oracle', 0, 1, 2, 0.5)`,
            params: [uuid(), alice],
          },
        ];
      for (const at of attempts) {
        let outcome: Row;
        try {
          await cA.unsafe(at.sql, at.params as never);
          outcome = { label: at.label, inserted: true };
        } catch (e) {
          const err = e as { code?: string; message?: string };
          outcome = {
            label: at.label,
            inserted: false,
            sqlstate: err.code,
            message: err.message,
          };
        }
        (detail.attempts as Row[]).push(outcome);
      }
      const planted = await admin.unsafe(
        `select 'phases' as t, count(*)::int as n from public.shot_phases where shot_id = $1 and user_id = $2
         union all select 'measurements', count(*)::int from public.shot_measurements where shot_id = $1 and user_id = $2
         union all select 'checkpoints', count(*)::int from public.shot_checkpoints where shot_id = $1 and user_id = $2`,
        [X, alice],
      );
      detail.rowsPlantedOnBobsShot = planted.map((r) => ({ ...r }));
      // Bob's view of his own shot's details under RLS is unchanged (planted rows are Alice's)
      const bobPhases = await cB.unsafe(
        `select phase_key from public.shot_phases where shot_id = $1 order by 1`,
        [X],
      );
      detail.bobVisiblePhaseKeys = bobPhases.map((r) => r.phase_key);
      // Cascade: deleting Bob deletes Alice's planted rows with the shot.
      const total = planted.reduce((s, r) => s + Number(r.n), 0);
      await record(
        "X4 cross-user detail rows via FK",
        total === 0 ? "HELD" : "BROKEN",
        detail,
      );
      assertEquals(
        total,
        0,
        `Alice attached ${total} detail rows to Bob's shot: ${
          JSON.stringify(detail.attempts)
        }`,
      );
    } finally {
      await cA.end();
      await cB.end();
      await dropUser(admin, alice).catch(() => undefined);
      await dropUser(admin, bob).catch(() => undefined);
      await admin.end();
    }
  },
});

// ═════════════════════════════════════════════════════════════════════════════
// X5 (extra) — TRUNCATE is not governed by RLS. Hosted default privileges
//      grant ALL (incl. TRUNCATE) on new tables to the client roles; the
//      migrations revoke their way down. Does `authenticated` still hold
//      TRUNCATE on any user-data table? (Rolled back — nothing is destroyed.)
// ═════════════════════════════════════════════════════════════════════════════
Deno.test({
  name:
    "X5 authenticated cannot TRUNCATE user-data tables (RLS does not apply to TRUNCATE)",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const u = uuid();
    const detail: Row = { user: u, tables: [] as Row[] };
    try {
      await provision(admin, u, [{
        provider: "google",
        providerId: `x5-${u}`,
      }]);
      const seed = postgres(PG_URL, { max: 1 });
      await becomeUser(seed, u);
      assertEquals(await spendScored(seed, "x5-k1"), "accepted");
      await seed.end();
      const grants = await admin.unsafe(
        `select table_name from information_schema.role_table_grants
          where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'TRUNCATE'
            and table_name in (select tablename from pg_tables where schemaname = 'public')
          order by 1`,
      );
      detail.truncateGrants = grants.map((r) => r.table_name);
      const targets = [
        "shots",
        "analysis_permits",
        "profiles",
        "billing_entitlements",
        "sessions",
        "consent_records",
        "free_rating_ledger",
        "webhook_events",
      ];
      for (const t of targets) {
        const c = postgres(PG_URL, { max: 1 });
        try {
          await c.unsafe(`begin`);
          const before = await c.unsafe(
            `select count(*)::int as n from public.${t}`,
          );
          await becomeUserLocal(c, u);
          let outcome: Row;
          try {
            await c.unsafe(`truncate public.${t}`);
            await c.unsafe(`reset role`);
            const after = await c.unsafe(
              `select count(*)::int as n from public.${t}`,
            );
            outcome = {
              table: t,
              truncated: true,
              rowsBefore: Number(before[0].n),
              rowsAfter: Number(after[0].n),
            };
          } catch (e) {
            const err = e as { code?: string; message?: string };
            outcome = {
              table: t,
              truncated: false,
              sqlstate: err.code,
              message: err.message,
            };
          }
          (detail.tables as Row[]).push(outcome);
        } finally {
          await c.unsafe(`rollback`).catch(() => undefined);
          await c.end();
        }
      }
      // CASCADE reaches every referencing table the client role holds TRUNCATE
      // on (FK-referenced tables are only incidentally protected).
      for (const root of ["profiles", "shots"]) {
        const c = postgres(PG_URL, { max: 1 });
        try {
          await c.unsafe(`begin`);
          const before = await c.unsafe(
            `select (select count(*) from public.profiles)::int as profiles, (select count(*) from public.shots)::int as shots,
                    (select count(*) from public.analysis_permits)::int as permits`,
          );
          await becomeUserLocal(c, u);
          let outcome: Row;
          try {
            await c.unsafe(`truncate public.${root} cascade`);
            await c.unsafe(`reset role`);
            const after = await c.unsafe(
              `select (select count(*) from public.profiles)::int as profiles, (select count(*) from public.shots)::int as shots,
                      (select count(*) from public.analysis_permits)::int as permits`,
            );
            outcome = {
              table: `${root} cascade`,
              truncated: true,
              before: plain(before[0]),
              after: plain(after[0]),
            };
          } catch (e) {
            const err = e as { code?: string; message?: string };
            outcome = {
              table: `${root} cascade`,
              truncated: false,
              sqlstate: err.code,
              message: err.message,
            };
          }
          (detail.tables as Row[]).push(outcome);
        } finally {
          await c.unsafe(`rollback`).catch(() => undefined);
          await c.end();
        }
      }
      const truncatable = (detail.tables as Row[]).filter((r) =>
        r.truncated === true
      ).map((r) => r.table);
      await record(
        "X5 client TRUNCATE",
        truncatable.length === 0 ? "HELD" : "BROKEN",
        detail,
      );
      assertEquals(
        truncatable,
        [],
        `authenticated can TRUNCATE: ${truncatable.join(", ")}`,
      );
    } finally {
      await dropUser(admin, u).catch(() => undefined);
      await admin.end();
    }
  },
});
