/**
 * STRESS — POST /v1/analyses/:id/feedback against REAL Postgres.
 *
 * Same in-process edge handler and seeded scenario generator as
 * stress_analyses_feedback_fuzz.test.ts, but PostgREST is replaced by a thin
 * translator that executes each call as SQL on a throwaway postgres:16 with
 * the auth shim + EVERY migration applied, as the `authenticated` role with
 * `request.jwt.claim.sub` = the caller — so RLS, the (analysis_id, user_id)
 * unique constraint (→ 23505 → 409), the append-only grants and the
 * profiles/shots FK graph are the genuine articles.
 *
 * Setup (identical to be-edge-routes-shots-rank.test.ts):
 *   docker run -d --name pickle-stress-pg -p 55433:5432 -e POSTGRES_PASSWORD=pg postgres:16
 *   docker cp supabase/tests pickle-stress-pg:/tests && docker cp supabase/migrations pickle-stress-pg:/migrations
 *   docker exec pickle-stress-pg bash -c 'psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql \
 *     && for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done'
 *   PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_PG_ITER=1000 deno test -A --config deno.json stress_analyses_feedback_pg.test.ts
 *
 * Without PICKLE_AUDIT_PG_URL every test is skipped (ignore: true).
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  buildWorld,
  createStressEnv,
  describeFailures,
  envInt,
  faultResponse,
  parseFilters,
  pathFor,
  pgrstError,
  pgrstJson,
  resetCounters,
  runCampaign,
  UUID_RE,
  writeArtifact,
} from "./stress_feedback_support.ts";
import type {
  BackendCounters,
  FaultStage,
  FeedbackBackend,
  PostgrestCall,
  StressEnv,
  World,
} from "./stress_feedback_support.ts";

const PG_URL = Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const CAMPAIGN_SEED = envInt("STRESS_SEED", 20260904);
const ITERATIONS = envInt("STRESS_PG_ITER", 150);

type Sql = ReturnType<typeof postgres>;

interface PgError {
  code?: string;
  message: string;
  detail?: string;
}

/** PostgREST → SQL translator for exactly the three calls the route makes. */
class PgBackend implements FeedbackBackend {
  readonly name = "postgres";
  counters: BackendCounters = { writeAttempts: 0, mutations: 0, reads: 0 };
  fault: FaultStage | null = null;

  constructor(private readonly sql: Sql) {}

  private async asUser<T>(uid: string | null, fn: (tx: Sql) => Promise<T>): Promise<T> {
    let result: T | undefined;
    let ran = false;
    await this.sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? ""]);
      result = await fn(tx);
      ran = true;
    });
    if (!ran) throw new Error("transaction callback did not run");
    return result as T;
  }

  async handle(call: PostgrestCall): Promise<Response> {
    const { method, table, params, actingUser } = call;
    if (method === "GET") {
      this.counters.reads += 1;
      const filters = parseFilters(params);
      if (table === "shots") {
        if (this.fault === "shots") return faultResponse("shots");
        const id = filters.find((f) => f.column === "id")?.value ?? "";
        const userId = filters.find((f) => f.column === "user_id")?.value ?? "";
        if (!UUID_RE.test(id) || !UUID_RE.test(userId)) {
          return pgrstError(400, "22P02", `invalid input syntax for type uuid: "${id}"`);
        }
        const rows = await this.asUser(actingUser, (tx) =>
          tx.unsafe(`select id from public.shots where id = $1::uuid and user_id = $2::uuid`, [
            id,
            userId,
          ]),
        );
        return pgrstJson(200, rows);
      }
      if (table === "consent_records") {
        if (this.fault === "consent") return faultResponse("consent");
        const userId = filters.find((f) => f.column === "user_id")?.value ?? "";
        if (!UUID_RE.test(userId)) {
          return pgrstError(400, "22P02", `invalid input syntax for type uuid: "${userId}"`);
        }
        const rows = await this.asUser(actingUser, (tx) =>
          tx.unsafe(
            `select scope, action, consent_version, created_at from public.consent_records
              where user_id = $1::uuid order by created_at asc, id asc`,
            [userId],
          ),
        );
        return pgrstJson(200, rows);
      }
      return pgrstError(404, "PGRST205", `Could not find the table 'public.${table}'`);
    }
    if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
      this.counters.writeAttempts += 1;
      if (table !== "analysis_feedback" || method !== "POST") {
        return pgrstError(404, "PGRST205", `Could not find the table 'public.${table}'`);
      }
      if (this.fault === "insert") return faultResponse("insert");
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(call.bodyText) as Record<string, unknown>;
      } catch {
        return pgrstError(400, "PGRST102", "Empty or invalid json request body");
      }
      try {
        const inserted = await this.asUser(actingUser, (tx) =>
          tx.unsafe(
            `insert into public.analysis_feedback (user_id, analysis_id, rating, category)
              values ($1::uuid, $2::uuid, $3, $4) returning id, created_at`,
            [
              String(row.user_id ?? ""),
              String(row.analysis_id ?? ""),
              String(row.rating ?? ""),
              row.category === null || row.category === undefined ? null : String(row.category),
            ],
          ),
        );
        this.counters.mutations += 1;
        const stored = inserted[0];
        const accept = call.headers.get("accept") ?? "";
        return pgrstJson(201, accept.includes("vnd.pgrst.object+json") ? stored : [stored]);
      } catch (error) {
        const pg = error as PgError;
        const status =
          pg.code === "23505"
            ? 409
            : pg.code === "42501"
              ? 403
              : pg.code?.startsWith("22")
                ? 400
                : 500;
        return pgrstError(status, pg.code ?? "XX000", pg.message, pg.detail ?? null);
      }
    }
    return pgrstError(405, "PGRST105", `Method ${method} not allowed`);
  }

  async hasFeedback(analysisId: string, userId: string): Promise<boolean> {
    return (await this.countFeedback(analysisId, userId)) > 0;
  }

  async countFeedback(analysisId: string, userId: string): Promise<number> {
    const rows = await this.sql.unsafe(
      `select count(*)::int as n from public.analysis_feedback where analysis_id = $1::uuid and user_id = $2::uuid`,
      [analysisId, userId],
    );
    return Number(rows[0].n);
  }
}

const SHOT_COLUMNS =
  "id, user_id, shot_type, captured_at, start_ms, end_ms, analysis_confidence, result_kind, " +
  "app_version, model_bundle_version, pose_model_version, paddle_model_version, " +
  "stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version";

/** Seeds the world's users (auth.users → profiles via trigger) and their shots
 * as superuser; half the users hold a model_training grant. */
async function seedWorld(sql: Sql, world: World): Promise<void> {
  for (const [i, user] of world.users.entries()) {
    await sql.unsafe(
      `insert into auth.users (id, email) values ($1::uuid, $2) on conflict (id) do nothing`,
      [user.id, `${user.id}@stress.example`],
    );
    for (const shot of user.shots) {
      await sql.unsafe(
        `insert into public.shots (${SHOT_COLUMNS}) values
          ($1::uuid, $2::uuid, 'dink', now(), 0, 1000, 0.2, 'low_confidence',
           '1', '1', '1', '1', '1', '1', '1', '1') on conflict (id) do nothing`,
        [shot, user.id],
      );
    }
    if (i % 2 === 0) {
      await sql.unsafe(
        `insert into public.consent_records (user_id, scope, consent_version, action)
          values ($1::uuid, 'model_training', '2026-09-01', 'grant')`,
        [user.id],
      );
    }
  }
}

async function teardownWorld(sql: Sql, world: World): Promise<void> {
  const ids = world.users.map((u) => u.id);
  await sql.unsafe(`delete from auth.users where id = any($1::uuid[])`, [ids]);
  await sql.unsafe(`delete from public.shots where user_id = any($1::uuid[])`, [ids]);
}

interface PgEnv {
  sql: Sql;
  env: StressEnv;
  backend: PgBackend;
}

async function pgEnv(
  seed: number,
  users: number,
  shotsPerUser: number,
  ips: number,
): Promise<PgEnv> {
  const sql = postgres(PG_URL, { max: 16, onnotice: () => undefined });
  const world = buildWorld(seed, users, shotsPerUser, ips);
  await seedWorld(sql, world);
  const backend = new PgBackend(sql);
  const env = await createStressEnv(world, backend);
  env.install();
  return { sql, env, backend };
}

async function pgClose(p: PgEnv): Promise<void> {
  p.env.uninstall();
  await teardownWorld(p.sql, p.env.world);
  await p.sql.end();
}

interface Snapshot {
  shots: number;
  ledger: number;
  feedback: number;
  profiles: number;
}

async function snapshot(sql: Sql): Promise<Snapshot> {
  const [row] = await sql.unsafe(
    `select (select count(*) from public.shots)::int as shots,
            (select count(*) from public.free_rating_ledger)::int as ledger,
            (select count(*) from public.analysis_feedback)::int as feedback,
            (select count(*) from public.profiles)::int as profiles`,
  );
  return row as unknown as Snapshot;
}

Deno.test({
  name: `stress pg: ${ITERATIONS} seeded requests (seed ${CAMPAIGN_SEED}) hold the boundary contract on real Postgres`,
  ignore,
  async fn() {
    const p = await pgEnv(CAMPAIGN_SEED, 16, 4, Math.max(256, Math.ceil(ITERATIONS / 4)));
    try {
      const before = await snapshot(p.sql);
      const summary = await runCampaign(p.env, {
        campaignSeed: CAMPAIGN_SEED,
        iterations: ITERATIONS,
      });
      const after = await snapshot(p.sql);
      const artifact = await writeArtifact(
        `fuzz_postgres_seed${CAMPAIGN_SEED}_iter${ITERATIONS}.json`,
        summary,
      );
      console.log(
        `[stress pg] executed=${summary.executed} failed=${summary.failed} 5xx=${summary.fiveXx.length} ` +
          `${summary.durationMs}ms byStatus=${JSON.stringify(summary.byStatus)}` +
          (artifact ? ` artifact=${artifact}` : ""),
      );
      assert(summary.executed >= ITERATIONS);
      assertEquals(
        summary.failed,
        0,
        `boundary contract violated on Postgres:\n${describeFailures(summary)}`,
      );
      // Only analysis_feedback moves, and by exactly the number of 201s.
      assertEquals(after.shots, before.shots, "shots must not change");
      assertEquals(
        after.ledger,
        before.ledger,
        "free_rating_ledger must not change (feedback ≠ a scored shot)",
      );
      assertEquals(after.profiles, before.profiles);
      assertEquals(
        after.feedback - before.feedback,
        summary.byStatus["201"] ?? 0,
        "one row per 201, none otherwise",
      );
      // Every stored row belongs to a user who owns that analysis (RLS + route check).
      const orphans = await p.sql.unsafe(
        `select count(*)::int as n from public.analysis_feedback f
          where not exists (select 1 from public.shots s where s.id = f.analysis_id and s.user_id = f.user_id)`,
      );
      assertEquals(Number(orphans[0].n), 0, "feedback rows must only exist for owned analyses");
    } finally {
      await pgClose(p);
    }
  },
});

Deno.test({
  name: "stress pg: 24 concurrent identical deliveries → exactly one 201, 23 × 409, one row (unique constraint)",
  ignore,
  async fn() {
    const p = await pgEnv(CAMPAIGN_SEED ^ 0xaaaa, 4, 2, 8);
    try {
      const user = p.env.world.users[1];
      const make = () =>
        new Request(`http://edge.test${pathFor(user.shots[0], 0)}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${user.sessionToken}`,
            "x-forwarded-for": "10.79.0.1",
            "content-type": "application/json",
          },
          body: JSON.stringify({ rating: "not_quite", category: "wrong_player" }),
        });
      resetCounters(p.backend);
      const responses = await Promise.all(
        Array.from({ length: 24 }, () => p.env.harness.handler(make())),
      );
      const statuses = responses.map((r) => r.status);
      const bodies = await Promise.all(responses.map((r) => r.text()));
      assertEquals(statuses.filter((s) => s === 201).length, 1, `statuses=${statuses.join(",")}`);
      assertEquals(statuses.filter((s) => s === 409).length, 23, `statuses=${statuses.join(",")}`);
      for (const [i, body] of bodies.entries()) {
        if (statuses[i] === 409) {
          assertEquals(
            body,
            '{"error":{"code":"analysis.feedback_exists","message":"Feedback was already recorded for this analysis."}}',
          );
          assert(
            !body.includes("23505") && !body.includes("duplicate key"),
            `DB detail leaked: ${body}`,
          );
        }
      }
      assertEquals(p.backend.counters.mutations, 1);
      assertEquals(await p.backend.countFeedback(user.shots[0], user.id), 1);
    } finally {
      await pgClose(p);
    }
  },
});

Deno.test({
  name: "stress pg: another user's analysis → 404, no row; RLS hides the shot entirely",
  ignore,
  async fn() {
    const p = await pgEnv(CAMPAIGN_SEED ^ 0xbbbb, 4, 2, 8);
    try {
      const [owner, intruder] = p.env.world.users;
      for (const token of [intruder.sessionToken, intruder.providerToken]) {
        resetCounters(p.backend);
        const res = await p.env.harness.handler(
          new Request(`http://edge.test${pathFor(owner.shots[0], 2)}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "x-forwarded-for": "10.79.0.2",
              "content-type": "application/json",
            },
            body: JSON.stringify({ rating: "accurate" }),
          }),
        );
        assertEquals(res.status, 404, await res.clone().text());
        assertEquals(
          p.backend.counters.writeAttempts,
          0,
          "no insert attempted for a non-owned analysis",
        );
        assertEquals(await p.backend.countFeedback(owner.shots[0], intruder.id), 0);
        assertEquals(await p.backend.countFeedback(owner.shots[0], owner.id), 0);
      }
      // The owner can still submit exactly once afterwards.
      const ok = await p.env.harness.handler(
        new Request(`http://edge.test${pathFor(owner.shots[0], 2)}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.sessionToken}`,
            "x-forwarded-for": "10.79.0.3",
            "content-type": "application/json",
          },
          body: JSON.stringify({ rating: "accurate" }),
        }),
      );
      assertEquals(ok.status, 201, await ok.clone().text());
      const payload = (await ok.json()) as {
        feedback: { analysisId: string; reviewEligible: boolean };
      };
      assertEquals(payload.feedback.analysisId, owner.shots[0]);
      assertEquals(payload.feedback.reviewEligible, true, "users[0] holds a model_training grant");
    } finally {
      await pgClose(p);
    }
  },
});

Deno.test({
  name: "stress pg: authenticated role cannot UPDATE/DELETE feedback (append-only) — direct SQL probe",
  ignore,
  async fn() {
    const p = await pgEnv(CAMPAIGN_SEED ^ 0xcccc, 2, 1, 8);
    try {
      const user = p.env.world.users[0];
      const ok = await p.env.harness.handler(
        new Request(`http://edge.test${pathFor(user.shots[0], 0)}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${user.sessionToken}`,
            "x-forwarded-for": "10.79.0.4",
            "content-type": "application/json",
          },
          body: JSON.stringify({ rating: "not_quite", category: "other" }),
        }),
      );
      assertEquals(ok.status, 201, await ok.clone().text());
      await ok.text();
      for (const stmt of [
        `update public.analysis_feedback set rating = 'accurate' where user_id = '${user.id}'`,
        `delete from public.analysis_feedback where user_id = '${user.id}'`,
      ]) {
        let code = "";
        try {
          await p.sql.begin(async (raw) => {
            const tx = raw as unknown as Sql;
            await tx.unsafe(`set local role authenticated`);
            await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [user.id]);
            await tx.unsafe(stmt);
          });
        } catch (error) {
          code = (error as PgError).code ?? "";
        }
        assertEquals(code, "42501", `${stmt} must be refused (permission denied)`);
      }
      assertEquals(await p.backend.countFeedback(user.shots[0], user.id), 1);
    } finally {
      await pgClose(p);
    }
  },
});
